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

  it('snapshot button carries the request log; the standalone 流水 button is gone', () => {
    // 去重（1.6.9）：接口流水 ⊂ 排查快照，删掉独立的「复制接口流水」按钮，
    // content 端 getRequestLog action 仍保留作数据源（日志 req 条目同源）
    const html = source('popup/popup.html');
    const js = source('popup/popup.js');
    assert.doesNotMatch(html, /id="copy-request-log"/);
    assert.match(html, /id="copy-assignee-snapshot"/);
    assert.doesNotMatch(js, /action: 'getRequestLog'/);
    assert.match(js, /action: 'getAssigneeDiagnostics'/);
    assert.match(js, /log: Array\.isArray\(response\.log\)[\s\S]{0,80}response\.log : \[\]/);
  });
});
