#!/usr/bin/env node
'use strict';

// 由 CHANGELOG 生成 Release 说明：下载入口（含版本无关的固定链接）+ 该版本要点。
//
// 固定入口两侧各一套，机制不同但都指着「最新版」：
//   GitHub   releases/latest/download/<固定文件名>            ← 靠 create-release.sh 传固定名附件
//   GitLab   releases/permalink/latest/downloads/<asset 名>   ← 靠 gitlab-release.js 挂 direct_asset_path
// 同事在内网，所以 GitLab 那段排前面。
//
// 用法: node scripts/release-notes.js 3.6.3 [仓库网页地址] [内网仓库网页地址]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const FIXED_FULL = 'moka-resume-plugin-latest-full.zip';
const FIXED_SLIM = 'moka-resume-plugin-latest.zip';

/** 从远端地址推网页基址：git@host:group/proj.git → https://host/group/proj */
function remoteWebUrl(remoteName) {
  const r = spawnSync('git', ['remote', 'get-url', remoteName], { cwd: root, encoding: 'utf8' });
  const raw = (r.stdout || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

/** 外网（GitHub）仓库网页地址 —— 历史名，保留以免调用点全改。 */
function repoWebUrl() {
  return remoteWebUrl('origin');
}

/** 内网（GitLab）仓库网页地址。 */
function gitlabWebUrl() {
  return remoteWebUrl('gitlab');
}

/** GitHub 的版本无关固定下载链接。 */
function githubFixedLinks(base) {
  if (!base) return [];
  return [
    { label: '完整包（**推荐**，含本地 Bridge 与安装脚本）', url: base + '/releases/latest/download/' + FIXED_FULL },
    { label: '精简包（只要插件本体）', url: base + '/releases/latest/download/' + FIXED_SLIM }
  ];
}

/** GitLab 的版本无关固定下载链接（permalink/latest 会指向最新的、挂了同名 asset 的 Release）。 */
function gitlabFixedLinks(base) {
  if (!base) return [];
  return [
    { label: '完整包（**推荐**，含本地 Bridge 与安装脚本）', url: base + '/-/releases/permalink/latest/downloads/' + FIXED_FULL },
    { label: '精简包（只要插件本体）', url: base + '/-/releases/permalink/latest/downloads/' + FIXED_SLIM }
  ];
}

function changelogSection(version) {
  const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ' + version + ' '));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function buildNotes(version, opts) {
  // 兼容老调用：第二个参数传字符串即视为 GitHub 基址
  const o = typeof opts === 'string' || opts === undefined ? { github: opts } : opts;
  const github = o.github !== undefined ? o.github : repoWebUrl();
  const gitlab = o.gitlab !== undefined ? o.gitlab : gitlabWebUrl();
  const B = '`';
  const parts = ['## 下载', ''];

  const gl = gitlabFixedLinks(gitlab);
  if (gl.length) {
    parts.push(
      '**内网（美图 GitLab，同事用这条）** —— 固定入口，永远指向最新版，存一次链接即可：',
      '',
      ...gl.map((l) => `- ${l.label}：\n  ${l.url}`),
      '',
      '> 需要先登录内网 GitLab（浏览器里能打开本页面就说明已登录）。本版本的两个附件见本页下方 Assets。',
      ''
    );
  }

  const gh = githubFixedLinks(github);
  if (gh.length) {
    parts.push(
      '**外网（GitHub）** —— 同样是固定入口：',
      '',
      ...gh.map((l) => `- ${l.label}：${l.url}`),
      ''
    );
  }

  parts.push(
    `本版本（v${version}）附件：`,
    '',
    '| 文件 | 用途 |',
    '|---|---|',
    `| ${B}moka-resume-plugin-v${version}-full.zip${B} | 插件 + 本地 Bridge（含 feishu-bridge 与 4 个安装脚本），一个文件夹齐活 |`,
    `| ${B}moka-resume-plugin-v${version}.zip${B} | 精简包：只有 Chrome 要加载的运行时文件 |`,
    '',
    `解压后到 ${B}chrome://extensions/${B} 打开「开发者模式」→「加载已解压的扩展程序」→ 选中该文件夹（需 Chrome 116+）。`,
    '',
    '想用「在飞书点卡片一键批量推进」的，装一下本地 Bridge：**在该文件夹的终端里**执行 ' +
      B + 'bash 安装开机自启.command' + B + '。',
    '**不要双击**——macOS 会拦「从网上下载的未签名脚本」，走终端跑同一份文件就不会被拦。完整步骤见仓内 使用说明.html 的 §9c。',
    '',
    '---',
    ''
  );
  const body = changelogSection(version);
  if (body) parts.push('', body);
  return parts.join('\n') + '\n';
}

if (require.main === module) {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('用法: node scripts/release-notes.js <版本号> [仓库网页地址] [内网仓库网页地址]\n');
    process.exit(1);
  }
  const notes = buildNotes(version, { github: process.argv[3], gitlab: process.argv[4] });
  process.stdout.write(notes);
}

module.exports = {
  buildNotes,
  changelogSection,
  repoWebUrl,
  gitlabWebUrl,
  githubFixedLinks,
  gitlabFixedLinks,
  FIXED_FULL,
  FIXED_SLIM
};
