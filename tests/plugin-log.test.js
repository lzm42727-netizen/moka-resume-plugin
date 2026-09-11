'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeEntry, trimEntries, LOG_LIMIT, MAX_TEXT, VALID_CATS } = require('../lib/plugin-log.js');

test('normalizeEntry accepts known cats and stamps time', () => {
  const e = normalizeEntry({ cat: 'req', text: 'POST /api/x', at: 123 });
  assert.deepEqual(e, { at: 123, cat: 'req', text: 'POST /api/x' });
  const auto = normalizeEntry({ cat: 'score', text: '王 → 82分' });
  assert.equal(auto.at > 0, true);
});

test('normalizeEntry sanitizes unknown cat to info, rejects empty text and caps length', () => {
  const unknown = normalizeEntry({ cat: 'nope', text: 'x' });
  assert.equal(unknown.cat, 'info'); // 未知分类兜底为 info，绝不静默丢日志
  assert.equal(unknown.at > 0, true);
  assert.equal(normalizeEntry({ cat: 'req', text: '   ' }), null);
  assert.equal(normalizeEntry(null), null);
  const long = normalizeEntry({ cat: 'err', text: '长'.repeat(MAX_TEXT + 50) });
  assert.equal(long.text.length, MAX_TEXT);
});

test('VALID_CATS covers the panel filter set', () => {
  ['req', 'adopt', 'screen', 'score', 'warn', 'err', 'info'].forEach((c) => {
    assert.ok(VALID_CATS.has(c));
  });
});

test('trimEntries keeps only the latest N in order', () => {
  const arr = Array.from({ length: 5 }, (_, i) => ({ at: i, cat: 'info', text: 'x' + i }));
  const out = trimEntries(arr, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'x3');
  assert.equal(out[1].text, 'x4');
  assert.equal(trimEntries([], 2).length, 0);
  assert.equal(trimEntries(null, 2).length, 0);
});

test('default limit matches LOG_LIMIT', () => {
  assert.equal(LOG_LIMIT, 500);
});
