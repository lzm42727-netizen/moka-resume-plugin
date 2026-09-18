const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIONS, ok, fail, isKnownAction, unknownActionResponse } = require('../lib/contracts.js');

function source(rel) {
  // v3.4.0 拆分后按「原 popup.js 线性顺序」拼接，保住跨窗口的 \s\S 锚点语义
  const bundles = {
    'popup/popup.js': ['popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js']
  };
  const files = bundles[rel] || [rel];
  return files.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
}

describe('message contracts', () => {
  it('names every live chrome.runtime / tabs action once', () => {
    const names = Object.values(ACTIONS);
    assert.ok(names.includes('getJobSpec'));
    assert.ok(names.includes('startScreening'));
    assert.ok(names.includes('analyzeJob'));
    assert.ok(names.includes('pageJobChanged'));
    assert.equal(new Set(names).size, names.length);
  });

  it('treats unknown actions as an explicit failure, not a silent ack', () => {
    assert.equal(isKnownAction('not-a-real-action'), false);
    assert.deepEqual(unknownActionResponse('xyz'), fail('未知消息：xyz'));
    assert.equal(ok({ spec: 1 }).ok, true);
    assert.equal(fail('boom').ok, false);
  });

  it('is loaded by background, content and popup so action names stay shared', () => {
    const bg = source('background.js');
    const content = source('content.js');
    const popupHtml = source('popup/popup.html');
    const manifest = source('manifest.json');
    assert.match(bg, /(?:importScripts|safeImportScripts)\('lib\/contracts\.js'\)/);
    assert.match(manifest, /lib\/contracts\.js/);
    assert.match(popupHtml, /lib\/contracts\.js/);
    assert.match(content, /MokaContracts/);
  });

  it('does not silently ack unknown background actions', () => {
    const bg = source('background.js');
    assert.match(bg, /unknownActionResponse|未知消息/);
    assert.doesNotMatch(bg, /default:\s*\n\s*sendResponse\(\{\s*received:\s*true\s*\}\)/);
  });
});
