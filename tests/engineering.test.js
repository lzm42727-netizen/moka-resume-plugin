const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('engineering baseline', () => {
  it('exposes a single check entry that covers test, syntax, version and lint', () => {
    assert.equal(typeof pkg.scripts.check, 'string');
    assert.match(pkg.scripts.check, /syntax:check/);
    assert.match(pkg.scripts.check, /check:version/);
    assert.match(pkg.scripts.check, /lint/);
    assert.match(pkg.scripts.check, /\btest\b/);
  });

  it('pins Node 22 for local and CI', () => {
    assert.equal(pkg.engines && pkg.engines.node, '>=22');
    const ci = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(ci, /npm ci/);
    assert.match(ci, /npm run check/);
    assert.match(ci, /node-version:\s*'22'/);
  });

  it('keeps LICENSE and CHANGELOG aligned with the shipped version', () => {
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    assert.match(license, /MIT License/);
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, new RegExp('^## ' + manifest.version.replace(/\./g, '\\.'), 'm'));
  });
});
