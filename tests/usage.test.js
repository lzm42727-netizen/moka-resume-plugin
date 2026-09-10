'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  lookupPrice,
  parseCustomPrice,
  resolvePrice,
  emptyUsage,
  normalizeUsage,
  addUsage,
  addCacheHit,
  mergeUsage,
  sumCost,
  formatCost,
  summaryText
} = require('../lib/usage.js');

test('lookupPrice matches MiniMax prefix variants including -MT', () => {
  assert.deepEqual(lookupPrice('MiniMax-M2.7-MT'), { inputPerM: 2.1, outputPerM: 8.4 });
  assert.deepEqual(lookupPrice('MiniMax-M2.7'), { inputPerM: 2.1, outputPerM: 8.4 });
  assert.deepEqual(lookupPrice('MiniMax-M2.7-highspeed'), { inputPerM: 4.2, outputPerM: 16.8 });
  assert.deepEqual(lookupPrice('MiniMax-M2.5'), { inputPerM: 2.1, outputPerM: 8.4 });
});

test('lookupPrice is case-insensitive and prefers more specific prefixes', () => {
  const mini = lookupPrice('gpt-4o-mini');
  const full = lookupPrice('gpt-4o');
  assert.ok(mini && mini.inputPerM < full.inputPerM, 'gpt-4o-mini must not be swallowed by gpt-4o');
  assert.deepEqual(lookupPrice('Claude-3-5-Sonnet-20241022'), lookupPrice('claude-3-5-sonnet'));
});

test('lookupPrice returns null for unknown models', () => {
  assert.equal(lookupPrice(''), null);
  assert.equal(lookupPrice('my-internal-model'), null);
});

test('parseCustomPrice accepts only positive numbers', () => {
  assert.equal(parseCustomPrice(''), null);
  assert.equal(parseCustomPrice('  '), null);
  assert.equal(parseCustomPrice('abc'), null);
  assert.equal(parseCustomPrice('-1'), null);
  assert.equal(parseCustomPrice('2.5'), 2.5);
  assert.equal(parseCustomPrice(8.4), 8.4);
});

test('resolvePrice prefers custom over builtin and falls back per field', () => {
  // 未填自定义 → 内置
  assert.deepEqual(resolvePrice('MiniMax-M2.7-MT', '', ''), { inputPerM: 2.1, outputPerM: 8.4 });
  // 自定义输入 + 内置输出兜底
  assert.deepEqual(resolvePrice('MiniMax-M2.7-MT', '5', ''), { inputPerM: 5, outputPerM: 8.4 });
  // 未知模型 + 自定义 → 未填的一侧为 0（不参与计价，但 priced 语义由调用方处理）
  assert.deepEqual(resolvePrice('internal-x', '3', '9'), { inputPerM: 3, outputPerM: 9 });
  // 未知模型 + 未填自定义 → null
  assert.equal(resolvePrice('internal-x', '', ''), null);
});

test('normalizeUsage clamps negative / non-numeric to zero and keeps price shape', () => {
  const u = normalizeUsage({ calls: -2, inTok: 'abc', outTok: 12.4, cacheHits: 3, model: 'm', price: { inputPerM: 2.1, outputPerM: 0, priced: true } });
  assert.deepEqual(u, { calls: 0, inTok: 0, outTok: 12, cacheHits: 3, model: 'm', price: { inputPerM: 2.1, outputPerM: null, priced: true } });
  const empty = normalizeUsage(null);
  assert.equal(empty.calls, 0);
  assert.equal(empty.price, null);
});

test('addUsage increments a real call and tracks tokens', () => {
  const u = addUsage(emptyUsage(), { inTok: 1000, outTok: 500, model: 'MiniMax-M2.7-MT' });
  assert.equal(u.calls, 1);
  assert.equal(u.inTok, 1000);
  assert.equal(u.outTok, 500);
  assert.equal(u.model, 'MiniMax-M2.7-MT');
  const twice = addUsage(u, { inTok: 2000, outTok: 0, model: 'MiniMax-M2.7-MT' });
  assert.equal(twice.calls, 2);
  assert.equal(twice.inTok, 3000);
});

test('addCacheHit counts separately without tokens', () => {
  const u = addCacheHit(emptyUsage());
  assert.equal(u.cacheHits, 1);
  assert.equal(u.calls, 0);
  assert.equal(u.inTok, 0);
});

test('mergeUsage sums counters across calls and cache hits', () => {
  const price = { inputPerM: 2.1, outputPerM: 8.4, priced: true };
  let run = emptyUsage();
  run.price = price;
  const candA = addUsage(emptyUsage(), { inTok: 1000, outTok: 400, model: 'MiniMax-M2.7-MT' });
  const candA2 = addUsage(emptyUsage(), { inTok: 500, outTok: 100, model: 'MiniMax-M2.7-MT' }); // 一次重试
  run = mergeUsage(run, candA);
  run = mergeUsage(run, candA2);
  run = mergeUsage(run, addCacheHit(emptyUsage()));
  assert.equal(run.calls, 2);
  assert.equal(run.inTok, 1500);
  assert.equal(run.outTok, 500);
  assert.equal(run.cacheHits, 1);
  assert.equal(run.price.inputPerM, 2.1);
});

test('sumCost estimates RMB from resolved price and marks priced=false when unknown', () => {
  const u = emptyUsage();
  u.price = { inputPerM: 2.1, outputPerM: 8.4, priced: true };
  u.inTok = 1_000_000;
  u.outTok = 1_000_000;
  assert.deepEqual(sumCost(u), { cost: 10.5, priced: true });

  const unknown = emptyUsage();
  unknown.inTok = 5000;
  assert.deepEqual(sumCost(unknown), { cost: null, priced: false });
});

test('formatCost renders 元 with three decimals and handles tiny amounts', () => {
  assert.equal(formatCost(0.084), '¥0.084');
  assert.equal(formatCost(0), '¥0.000');
  assert.equal(formatCost(null), '');
  assert.equal(formatCost(0.0004), '¥<0.001');
});

test('summaryText returns empty until any usage, then renders calls/tokens/cost/hits', () => {
  assert.equal(summaryText(emptyUsage()), '');
  const base = emptyUsage();
  base.price = { inputPerM: 2.1, outputPerM: 8.4, priced: true };
  const a = addUsage(base, { inTok: 3000, outTok: 1000, model: 'MiniMax-M2.7-MT' });
  assert.match(summaryText(a), /LLM 调用 1 次/);
  assert.match(summaryText(a), /输入 3,000 \/ 输出 1,000 tokens/);
  assert.match(summaryText(a), /约 ¥0\.015/);
  const b = addCacheHit(a);
  assert.match(summaryText(b), /缓存命中 1 人/);
});

test('summaryText warns when model price is unknown but calls happened', () => {
  const u = emptyUsage();
  const a = addUsage(u, { inTok: 100, outTok: 20, model: 'internal-x' });
  assert.match(summaryText(a), /模型未收录单价，未估费/);
});

test('addUsage counts meta.calls when one score took several model calls（v1.8.5）', () => {
  // 截断后 maxTokens 加倍重试：一次得分内部发生两次真实调用，费用与次数都要算实数
  const one = addUsage(emptyUsage(), { inTok: 1000, outTok: 500 });
  assert.equal(one.calls, 1, '未带 calls 时按 1 次计');

  const two = addUsage(emptyUsage(), { calls: 2, inTok: 3000, outTok: 1500 });
  assert.equal(two.calls, 2);
  assert.equal(two.inTok, 3000);

  // 0 / 非法值回退为 1，避免出现「0 次调用却有 token」的脏账
  assert.equal(addUsage(emptyUsage(), { calls: 0 }).calls, 1);
  assert.equal(addUsage(emptyUsage(), { calls: -3 }).calls, 1);
  assert.equal(addUsage(emptyUsage(), {}).calls, 1);
});
