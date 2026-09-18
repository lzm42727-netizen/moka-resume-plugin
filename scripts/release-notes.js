#!/usr/bin/env node
'use strict';

// 由 CHANGELOG 生成 Release 说明：下载入口（含版本无关的固定链接）+ 该版本要点。
// 固定链接依赖「最新 release 下带 latest 固定名的附件」，由 create-release.sh 一并上传。
// 用法: node scripts/release-notes.js 3.6.3 [仓库网页地址]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function repoWebUrl() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const raw = (r.stdout || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

function changelogSection(version) {
  const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ' + version + ' '));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function buildNotes(version, repoUrl) {
  const base = repoUrl || repoWebUrl();
  const B = '`';
  const latest = base ? base + '/releases/latest/download/' : '';
  const parts = [
    '## 下载',
    '',
    '**固定入口**（永远指向最新版，同事存一次链接即可，不用每次问版本号）：',
    '',
    '- 完整包（**推荐**，含本地 Bridge 与安装脚本）：' + latest + 'moka-resume-plugin-latest-full.zip',
    '- 精简包（只要插件本体）：' + latest + 'moka-resume-plugin-latest.zip',
    '',
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
  ];
  const body = changelogSection(version);
  if (body) parts.push('', body);
  return parts.join('\n') + '\n';
}

if (require.main === module) {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('用法: node scripts/release-notes.js <版本号> [仓库网页地址]\n');
    process.exit(1);
  }
  process.stdout.write(buildNotes(version, process.argv[3]));
}

module.exports = { buildNotes, changelogSection, repoWebUrl };
