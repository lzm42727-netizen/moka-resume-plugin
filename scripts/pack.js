#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const REQUIRED = [
  'manifest.json',
  'background.js',
  'content.js',
  'inject.js',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup-results.js',
  'popup/popup-batch.js',
  'popup/popup-health.js',
  'popup/popup.css',
  'icons/icon48.png',
  'icons/icon128.png'
];

function listLibAndContent() {
  const extra = [];
  for (const dir of ['lib', 'content']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) extra.push(path.join(dir, name));
    }
  }
  return extra.sort();
}

function listPackFiles() {
  const set = new Set(REQUIRED.concat(listLibAndContent()));
  return Array.from(set).sort();
}

// 完整包含 feishu-bridge 与安装脚本，供同事一次性拿到「插件 + 本地服务」。
// 一律白名单列举：feishu-bridge/config.json（含明文 App Secret）、bridge.log、
// server.pid、node_modules 绝不能进包，所以不做「排除法」。
const FULL_EXTRA = [
  'README.md',
  '使用说明.html',
  'feishu-bridge/config.example.json',
  'feishu-bridge/package-lock.json',
  'feishu-bridge/package.json',
  'feishu-bridge/server.js',
  '启动飞书机器人.command',
  '停止飞书机器人.command',
  '安装开机自启.command',
  '取消开机自启.command'
];

// 完整包必须自带的安装脚本与凭据模板：少一个同事就装不起来
const FULL_MUST_EXIST = [
  'feishu-bridge/server.js',
  'feishu-bridge/package.json',
  '安装开机自启.command'
];

function listFullPackFiles() {
  return listPackFiles().concat(FULL_EXTRA).sort();
}

// 敏感/本地产物黑名单：出现在完整包里就是事故（App Secret 泄露 / 体积失控）
const FORBIDDEN_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)config\.json$/,
  /\.log$/,
  /\.pid$/
];

function assertNoForbidden(files, label) {
  const bad = files.filter((rel) => FORBIDDEN_PATTERNS.some((re) => re.test(rel)));
  if (bad.length) {
    for (const rel of bad) process.stderr.write('pack: ' + label + ' 含禁止文件 ' + rel + '\n');
    process.exit(1);
  }
}

function buildZip(files, zipName) {
  const outDir = path.join(root, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  // -X 去掉 Mac 扩展属性（含隔离属性位），但不影响 unix 执行位：
  // .command 解压后仍是可执行文件，双击/终端跑都正常
  const result = spawnSync('zip', ['-q', '-X', zipPath, ...files], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'zip failed\n');
    process.exit(result.status || 1);
  }
  return zipPath;
}

function main() {
  const full = process.argv.includes('--full');
  const files = full ? listFullPackFiles() : listPackFiles();
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      process.stderr.write('pack: missing ' + rel + '\n');
      process.exit(1);
    }
  }
  if (full) {
    const missing = FULL_MUST_EXIST.filter((rel) => !files.includes(rel));
    if (missing.length) {
      process.stderr.write('pack: 完整包缺关键文件 ' + missing.join(', ') + '\n');
      process.exit(1);
    }
    assertNoForbidden(files, '完整包');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const zipName =
    'moka-resume-plugin-v' + manifest.version + (full ? '-full' : '') + '.zip';
  const zipPath = buildZip(files, zipName);
  process.stdout.write(
    'packed ' + path.relative(root, zipPath) + ' (' + files.length + ' files' +
      (full ? ', 含 feishu-bridge 与安装脚本' : '') + ')\n'
  );
}

if (require.main === module) main();

module.exports = {
  listPackFiles,
  listFullPackFiles,
  FORBIDDEN_PATTERNS
};
