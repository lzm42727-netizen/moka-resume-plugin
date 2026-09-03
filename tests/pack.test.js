const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { listPackFiles } = require('../scripts/pack.js');

describe('extension pack list', () => {
  it('includes the files Chrome actually loads and excludes tests and docs', () => {
    const files = listPackFiles();
    assert.ok(files.includes('manifest.json'));
    assert.ok(files.includes('background.js'));
    assert.ok(files.includes('content.js'));
    assert.ok(files.includes('inject.js'));
    assert.ok(files.includes('popup/popup.html'));
    assert.ok(files.includes('popup/popup.js'));
    assert.ok(files.includes('popup/popup.css'));
    assert.ok(files.includes('lib/score.js'));
    assert.ok(files.includes('lib/contracts.js'));
    assert.ok(!files.some((f) => f.startsWith('tests/')));
    assert.ok(!files.some((f) => f.startsWith('docs/')));
    assert.ok(!files.includes('项目评估报告.html'));
  });
});
