#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function walkJs(dir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function main() {
  const files = walkJs(root, []);
  let failed = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failed += 1;
      process.stderr.write(rel + '\n' + (result.stderr || result.stdout || '') + '\n');
    }
  }
  if (failed) {
    process.stderr.write('syntax:check failed for ' + failed + ' file(s)\n');
    process.exit(1);
  }
  process.stdout.write('syntax:check ok (' + files.length + ' files)\n');
}

if (require.main === module) main();

module.exports = { walkJs };
