#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  return String(manifest.version || '');
}

function changelogHasVersion(version) {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const re = new RegExp('^## ' + version.replace(/\./g, '\\.') + '(?:\\s|$)', 'm');
  return re.test(changelog);
}

// 顶部第一个版本条目必须就是 manifest 版本：历史条目也算数会导致漏 bump 假绿（v3.0.0 实锤）
function changelogTopVersion() {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const m = /^## (\S+)/m.exec(changelog);
  return m ? m[1] : '';
}

// 用户可见的版本徽标必须随 manifest 同更（v1.9.6、v3.1.1 两度滞留）——
// 「版本号新了、页面内容还是旧的」正是用户投诉的形态，从此 npm run check 直接拦下
function htmlBadgesMissing(version) {
  return ['插件介绍.html', '使用说明.html'].filter((f) => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    return !text.includes('v' + version);
  });
}

function main() {
  const version = readManifestVersion();
  if (!version) {
    process.stderr.write('manifest.json 缺少 version\n');
    process.exit(1);
  }
  const top = changelogTopVersion();
  if (top !== version) {
    process.stderr.write('CHANGELOG.md 顶部条目（' + (top || '无') + '）与 manifest 版本（' + version + '）不一致——是否漏了升版或漏写条目？\n');
    process.exit(1);
  }
  if (!changelogHasVersion(version)) {
    process.stderr.write('CHANGELOG.md 没有与 manifest 对应的版本标题：' + version + '\n');
    process.exit(1);
  }
  const missing = htmlBadgesMissing(version);
  if (missing.length) {
    process.stderr.write('以下页面没有 v' + version + ' 版本徽标（徽标须随 manifest 同更）：' + missing.join('、') + '\n');
    process.exit(1);
  }
  process.stdout.write('check:version ok (' + version + ')\n');
}

if (require.main === module) main();

module.exports = { readManifestVersion, changelogHasVersion, changelogTopVersion, htmlBadgesMissing };
