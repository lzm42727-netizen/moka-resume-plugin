#!/usr/bin/env node
'use strict';

// 把某个已发布版本做成内网 GitLab（git.meitu.com）上的 Release。
//
// 为什么不用纯 bash + curl（v3.6.3 首次发版时的写法）：
//   GitLab 的 Release 挂不了二进制附件，必须「先 POST /uploads 拿 URL → 再挂 asset link」；
//   而想要一个**跨版本稳定**的下载入口，还得给每个固定链接加 direct_asset_path，
//   让它落成 /releases/permalink/latest/downloads/<name> —— 这是 GitLab 的永久链接机制。
//   这套「查旧链接 → 清 → 建 4 条 → 校验」用 bash 拼 JSON 太脆，改成 Node。
//
// 每个版本会挂 4 条 link（各对应一次独立的 upload —— 同一条 url 不能被两个 link 复用，会 409/400）：
//   ├─ 完整包（推荐，含本地 Bridge）   ← 带版本号，存档用
//   ├─ 精简包（只要插件）             ← 带版本号，存档用
//   ├─ 固定入口：完整包（latest）      ← direct_asset_path 永久链接
//   └─ 固定入口：精简包（latest）      ← direct_asset_path 永久链接
//
// 用法: node scripts/gitlab-release.js <版本号> [--notes <文件>] [--dry-run]
// Token: 环境变量 GITLAB_TOKEN，或仓库根目录 .env.local（已在 .gitignore）里的 GITLAB_TOKEN=
//        无 token → 打印「跳过」并以 0 退出（本地开发不该因为没内网权限就跑失败）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const FIXED_FULL = 'moka-resume-plugin-latest-full.zip';
const FIXED_SLIM = 'moka-resume-plugin-latest.zip';

/** 本脚本管的 link 名；重跑时只清这些，不动别人挂的。 */
const MANAGED_LINK_NAMES = Object.freeze([
  '完整包（推荐，含本地 Bridge）',
  '精简包（只要插件）',
  '固定入口：完整包（latest）',
  '固定入口：精简包（latest）'
]);

/** 从 `git@host:group/project.git` / `https://host/group/project.git` 取 group/project。 */
function projectPathFromRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const m = raw.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** namespace/project → URL 编码的 project id 占位（GitLab API 允许用 %2F 形式）。 */
function encodeProject(projectPath) {
  return String(projectPath || '').replace(/\//g, '%2F');
}

/** 仓库网页基址：git@git.meitu.com:meituhr/moka-resume-plugin.git → https://git.meitu.com/meituhr/moka-resume-plugin */
function webBaseFromRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const host = raw.includes('@') ? raw.replace(/^[^@]*@/, '').split(':')[0] : raw.replace(/^\w+:\/\//, '').split('/')[0];
  const project = projectPathFromRemote(raw);
  if (!host || !project) return '';
  return `https://${host}/${project}`;
}

/** 从 .env.local 文本中取 GITLAB_TOKEN（容忍引号与空格）。 */
function parseToken(envText) {
  const line = String(envText || '')
    .split('\n')
    .find((l) => l.trim().startsWith('GITLAB_TOKEN='));
  if (!line) return '';
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** 四条 link 的声明。URL 由调用方在 upload 之后回填（四条 URL 互不相同，GitLab 不允许复用）。 */
function linkSpecs(urls) {
  const u = urls || {};
  return [
    {
      key: 'full',
      name: MANAGED_LINK_NAMES[0],
      url: u.full,
      link_type: 'package'
    },
    {
      key: 'slim',
      name: MANAGED_LINK_NAMES[1],
      url: u.slim,
      link_type: 'package'
    },
    {
      key: 'fixedFull',
      name: MANAGED_LINK_NAMES[2],
      url: u.fixedFull,
      // 固定链接必须用 other：package 类型会把 direct_asset_path 当包内 filepath 校验，直接 400
      link_type: 'other',
      direct_asset_path: '/' + FIXED_FULL
    },
    {
      key: 'fixedSlim',
      name: MANAGED_LINK_NAMES[3],
      url: u.fixedSlim,
      link_type: 'other',
      direct_asset_path: '/' + FIXED_SLIM
    }
  ];
}

function gitlabRemoteUrl() {
  const r = spawnSync('git', ['remote', 'get-url', 'gitlab'], { cwd: root, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function readToken() {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN.trim();
  const p = path.join(root, '.env.local');
  if (fs.existsSync(p)) return parseToken(fs.readFileSync(p, 'utf8'));
  return '';
}

// ---------------------------------------------------------------- HTTP

function makeClient(token, apiBase) {
  async function req(method, apiPath, { json, form } = {}) {
    const headers = { 'PRIVATE-TOKEN': token };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await fetch(apiBase + apiPath, { method, headers, body });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, json) => req('POST', p, { json }),
    put: (p, json) => req('PUT', p, { json }),
    del: (p) => req('DELETE', p),
    async upload(apiPath, filePath) {
      const buf = fs.readFileSync(filePath);
      const form = new FormData();
      form.append('file', new Blob([buf]), path.basename(filePath));
      return req('POST', apiPath, { form });
    }
  };
}

function fail(msg, detail) {
  process.stderr.write('❌ ' + msg + '\n');
  if (detail !== undefined) process.stderr.write(String(typeof detail === 'string' ? detail : JSON.stringify(detail)) + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------- main

/**
 * 解析命令行。版本号是唯一的位置参数；--notes 的值不能被当成版本号。
 * 返回 { version, notesFile, dryRun }。
 */
function parseArgs(argv) {
  let version = '';
  let notesFile = '';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--notes') notesFile = argv[++i] || '';
    else if (!a.startsWith('-') && !version) version = a;
  }
  return { version, notesFile, dryRun };
}

async function main() {
  const { version, notesFile, dryRun } = parseArgs(process.argv.slice(2));
  if (!version) fail('用法: node scripts/gitlab-release.js <版本号> [--notes <文件>] [--dry-run]');

  const remote = gitlabRemoteUrl();
  const base = webBaseFromRemote(remote);
  if (!base) fail('读不到 gitlab 远端地址，无法定位内网仓库（git remote get-url gitlab）');
  const project = encodeProject(projectPathFromRemote(remote));

  const token = readToken();
  if (!token) {
    process.stdout.write('⏭  跳过 GitLab（未设置 GITLAB_TOKEN）\n');
    process.stdout.write('   内网发布所需：GitLab → 头像 → 偏好设置 → 访问令牌 → 勾选 api 权限 → 生成，\n');
    process.stdout.write('   写进仓库根目录 .env.local 的 GITLAB_TOKEN=xxx 再跑一次本脚本（幂等，不会重复建）。\n');
    return;
  }

  const tag = 'v' + version;
  const dist = path.join(root, 'dist');
  const files = {
    full: path.join(dist, `moka-resume-plugin-${tag}-full.zip`),
    slim: path.join(dist, `moka-resume-plugin-${tag}.zip`)
  };
  for (const [k, f] of Object.entries(files)) {
    if (!fs.existsSync(f)) fail(`缺 ${k} 包：${f} —— 先跑 npm run pack && npm run pack:full`);
  }

  const host = new URL(base).origin;
  const client = makeClient(token, host + '/api/v4');
  const proj = `/projects/${project}`;

  // 先确认 token 有 api 权限，别等上传完才发现
  const who = await client.get('/user');
  if (who.status !== 200) fail(`Token 无效（HTTP ${who.status}）`, who.body);
  process.stdout.write(`🔑 内网身份：${who.body.username}（${who.body.name || '-'}）\n`);

  if (dryRun) {
    process.stdout.write(`🧪 dry-run：将发布 ${tag} 到 ${base}/-/releases/${tag}\n`);
    for (const s of linkSpecs({ full: 'up1', slim: 'up2', fixedFull: 'up3', fixedSlim: 'up4' })) {
      process.stdout.write(`   - [${s.link_type}] ${s.name}${s.direct_asset_path ? '  → ' + base + '/-/releases/permalink/latest/downloads' + s.direct_asset_path : ''}\n`);
    }
    return;
  }

  // 1) 上传 4 份（同一条 url 不能被两个 link 复用）
  const uploadOne = async (file) => {
    const r = await client.upload(`${proj}/uploads`, file);
    if (r.status !== 201 || !r.body || !r.body.full_path) fail(`上传失败 ${path.basename(file)}（HTTP ${r.status}）`, r.body);
    return host + r.body.full_path;
  };
  process.stdout.write('⬆️  上传附件到 GitLab（4 份）…\n');
  const urls = {};
  urls.full = await uploadOne(files.full);
  urls.slim = await uploadOne(files.slim);
  urls.fixedFull = await uploadOne(files.full);
  urls.fixedSlim = await uploadOne(files.slim);

  // 2) Release 本体：有则改说明，无则创建
  const desc = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').slice(0, 100000) : '';
  const created = await client.post(`${proj}/releases`, { name: tag, tag_name: tag, description: desc });
  if (created.status === 201) {
    process.stdout.write(`✅ GitLab Release 已创建：${base}/-/releases/${tag}\n`);
  } else if ([400, 409].includes(created.status)) {
    const upd = await client.put(`${proj}/releases/${tag}`, { name: tag, description: desc });
    if (upd.status !== 200) fail(`更新 Release 失败（HTTP ${upd.status}）`, upd.body);
    process.stdout.write(`ℹ️  Release 已存在，已更新说明：${base}/-/releases/${tag}\n`);
  } else {
    fail(`创建 Release 失败（HTTP ${created.status}）`, created.body);
  }

  // 3) 重建 link（幂等：只清本脚本管的那些名字）
  const existing = await client.get(`${proj}/releases/${tag}/assets/links`);
  if (existing.status !== 200) fail(`读不到现有 link（HTTP ${existing.status}）`, existing.body);
  const stale = (existing.body || []).filter((l) => MANAGED_LINK_NAMES.includes(l.name));
  for (const l of stale) {
    const d = await client.del(`${proj}/releases/${tag}/assets/links/${l.id}`);
    if (d.status !== 200 && d.status !== 204) fail(`清理旧 link 失败（HTTP ${d.status}）`, d.body);
  }
  if (stale.length) process.stdout.write(`🧹 清掉 ${stale.length} 条旧 link，重建…\n`);

  for (const s of linkSpecs(urls)) {
    const payload = { name: s.name, url: s.url, link_type: s.link_type };
    if (s.direct_asset_path) payload.direct_asset_path = s.direct_asset_path;
    const r = await client.post(`${proj}/releases/${tag}/assets/links`, payload);
    if (r.status !== 201) fail(`挂 link 失败「${s.name}」（HTTP ${r.status}）`, r.body);
    process.stdout.write(`   ✔ ${s.name}\n`);
  }

  // 4) 自证：固定链接确实落成了 permalink 形态
  const after = await client.get(`${proj}/releases/${tag}/assets/links`);
  const fixed = (after.body || []).filter((l) => l.direct_asset_url && l.direct_asset_url.includes('/downloads/'));
  if (fixed.length !== 2) fail(`固定链接数不对（期望 2，实到 ${fixed.length}）`, after.body);
  for (const l of fixed) {
    process.stdout.write(`   🔗 ${l.direct_asset_url.replace(`/releases/${tag}/downloads/`, '/releases/permalink/latest/downloads/')}\n`);
  }
  process.stdout.write(`   共 ${(after.body || []).length} 条附件 → ${base}/-/releases/${tag}\n`);
}

if (require.main === module) {
  main().catch((e) => fail(e && e.message ? e.message : String(e)));
}

module.exports = {
  projectPathFromRemote,
  encodeProject,
  webBaseFromRemote,
  parseToken,
  parseArgs,
  linkSpecs,
  MANAGED_LINK_NAMES,
  FIXED_FULL,
  FIXED_SLIM
};
