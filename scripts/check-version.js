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

function main() {
  const version = readManifestVersion();
  if (!version) {
    process.stderr.write('manifest.json 缺少 version\n');
    process.exit(1);
  }
  if (!changelogHasVersion(version)) {
    process.stderr.write('CHANGELOG.md 没有与 manifest 对应的版本标题：' + version + '\n');
    process.exit(1);
  }
  process.stdout.write('check:version ok (' + version + ')\n');
}

if (require.main === module) main();

module.exports = { readManifestVersion, changelogHasVersion };
