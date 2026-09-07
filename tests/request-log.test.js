const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIONS } = require('../lib/contracts.js');

function source(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('request log observation', () => {
  it('exposes getRequestLog as a shared cross-world action', () => {
    assert.ok(Object.values(ACTIONS).includes('getRequestLog'));
  });

  it('inject.js records every POST request, not only the two known URLs', () => {
    const inject = source('inject.js');
    assert.match(inject, /request-log/);
    assert.match(inject, /logPostRequest/);
    assert.match(inject, /POST/);
  });

  it('content.js keeps a bounded in-memory log and answers getRequestLog', () => {
    const content = source('content.js');
    assert.match(content, /REQUEST_LOG_LIMIT/);
    assert.match(content, /logCapturedRequest/);
    assert.match(content, /getRequestLog/);
  });

  it('popup exposes a copy button wired to the request log', () => {
    const html = source('popup/popup.html');
    const js = source('popup/popup.js');
    assert.match(html, /id="copy-request-log"/);
    assert.match(js, /getRequestLog/);
  });
});
