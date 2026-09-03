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

function main() {
  const files = listPackFiles();
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      process.stderr.write('pack: missing ' + rel + '\n');
      process.exit(1);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const outDir = path.join(root, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const zipName = 'moka-resume-plugin-v' + manifest.version + '.zip';
  const zipPath = path.join(outDir, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const result = spawnSync('zip', ['-q', '-X', zipPath, ...files], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'zip failed\n');
    process.exit(result.status || 1);
  }
  process.stdout.write(
    'packed ' + path.relative(root, zipPath) + ' (' + files.length + ' files)\n'
  );
}

if (require.main === module) main();

module.exports = { listPackFiles };
