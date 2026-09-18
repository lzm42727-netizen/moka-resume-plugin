const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../popup/popup-health.js'), 'utf8');

const CARD_TITLES = [
  '评分模型配置',
  '部署态（config.local.js）',
  '本地 Bridge 服务',
  '飞书自建应用凭据',
  'Moka 页面连接',
  '本地存储 (chrome.storage.local)'
];

// ---- 迷你 DOM：只实现 popup-health.js 用到的那几项能力（无第三方依赖） ----
function makeEl(tag, id) {
  const el = {
    tagName: tag,
    id: id || '',
    className: '',
    textContent: '',
    children: [],
    listeners: {},
    classList: {
      add: (...cs) => {
        cs.forEach((c) => {
          if (c && !el.classList.contains(c)) el.className = (el.className + ' ' + c).trim();
        });
      },
      remove: (...cs) => {
        el.className = el.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(' ');
      },
      contains: (c) => el.className.split(/\s+/).includes(c)
    },
    appendChild: (child) => {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    append: (...nodes) => nodes.forEach((n) => el.appendChild(n)),
    addEventListener: (type, fn) => {
      el.listeners[type] = fn;
    },
    querySelector: (sel) => findIn(el, sel),
    querySelectorAll: (sel) => findAllIn(el, sel, [])
  };
  return el;
}

function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName === sel;
}

function findAllIn(root, sel, acc) {
  root.children.forEach((c) => {
    if (matches(c, sel)) acc.push(c);
    findAllIn(c, sel, acc);
  });
  return acc;
}

function findIn(root, sel) {
  return findAllIn(root, sel, [])[0] || null;
}

/**
 * 起一个装了 popup-health.js 的沙箱。
 * opts.settings      → chrome.storage 里的 mokaSettings
 * opts.local         → LOCAL_DEFAULTS（部署态锁定项）
 * opts.bridge        → getFeishuBridgeStatus 的返回；数组表示逐轮取值，元素 'silent' = 该轮回调不回来
 * opts.mokaTabs      → chrome.tabs.query 结果
 */
function buildContext(opts) {
  const ids = ['health-results', 'health-verdict', 'health-rerun', 'health-copy',
    'health-version', 'health-checked-at', 'health-copy-note'];
  const dom = {};
  ids.forEach((id) => { dom[id] = makeEl('div', id); });

  const store = { mokaSettings: opts.settings || {} };
  const copied = { text: null };
  const timers = [];
  const bridgeQueue = Array.isArray(opts.bridge) ? opts.bridge.slice() : null;

  const ctx = {
    console,
    navigator: { clipboard: { writeText: async (t) => { copied.text = t; } } },
    // 只登记回调，不真排队（避免给测试套件加 3 秒空等）
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    document: {
      getElementById: (id) => dom[id] || null,
      createElement: (tag) => makeEl(tag)
    },
    chrome: {
      storage: {
        local: {
          get: async (k) => {
            const keys = Array.isArray(k) ? k : [k];
            const out = {};
            keys.forEach((x) => { out[x] = store[x]; });
            return out;
          },
          set: async (obj) => { Object.assign(store, obj); },
          remove: async (k) => { delete store[k]; }
        }
      },
      runtime: {
        lastError: null,
        getManifest: () => ({ version: '3.6.0' }),
        sendMessage: (msg, cb) => {
          let res = opts.bridge;
          if (bridgeQueue) res = bridgeQueue.length > 1 ? bridgeQueue.shift() : bridgeQueue[0];
          if (res === 'silent') return; // 本轮不回：走 3 秒超时分支
          cb(res === undefined ? { connected: true } : res);
        }
      },
      tabs: { query: (q, cb) => cb((opts.mokaTabs || [{ id: 1 }])) }
    },
    LOCAL_DEFAULTS: opts.local || {},
    safeEl: (id) => dom[id] || null
  };

  vm.createContext(ctx);
  new vm.Script(SOURCE).runInContext(ctx);
  return { ctx, dom, copied, timers, cards: () => dom['health-results'].children };
}

const cardLevels = (cards) => cards.map((c) => c.className.replace('health-card', '').trim());

/** 让沙箱里的微任务跑完（探测函数登记完才谈得上触发它的定时器） */
const flush = () => new Promise((r) => setImmediate(r));

/** 全绿基线：连接信息在 storage、部署锁定项在 config.local.js、飞书三项齐全 */
const ALL_OK_SETTINGS = {
  apiKey: 'k',
  apiEndpoint: 'https://gw/v1/chat/completions',
  modelName: 'm',
  feishuAppId: 'cli_x',
  feishuAppSecret: 's',
  feishuReceiver: 'me@x.com'
};
const ALL_OK_LOCAL = { apiProtocol: 'openai', apiProvider: '自建 / 中转网关', apiEndpoint: 'https://gw/v1', modelName: 'm' };

describe('健康检查模块行为（v3.6.0，迷你 DOM 沙箱）', () => {
  it('六项体检按固定顺序建卡，标题与占位态取自同一份文案表', async () => {
    const { ctx, dom, cards } = buildContext({ settings: ALL_OK_SETTINGS, local: ALL_OK_LOCAL });
    await ctx.renderHealthCheck();
    assert.equal(cards().length, 6);
    assert.deepEqual(
      cards().map((c) => c.querySelector('.health-card-name').textContent),
      CARD_TITLES
    );
    // 全绿：每张卡都是 is-ok + 徽标「正常」，没有残留 pending
    assert.deepEqual(cardLevels(cards()), ['is-ok', 'is-ok', 'is-ok', 'is-ok', 'is-ok', 'is-ok']);
    assert.deepEqual(cards().map((c) => c.querySelector('.health-card-badge').textContent),
      ['正常', '正常', '正常', '正常', '正常', '正常']);
    assert.match(dom['health-verdict'].textContent, /^✅ 6 项通过｜一切正常/);
  });

  it('红黄绿分级落到卡片与顶部汇总条', async () => {
    const { ctx, dom, cards } = buildContext({
      settings: { apiKey: '', feishuAppId: 'a', feishuReceiver: 'r' }, // Key 空→红；飞书缺 Secret→红
      bridge: { connected: false }, // Bridge 未连→红
      mokaTabs: [] // 无 Moka 页面→红
    });
    await ctx.renderHealthCheck();
    // 顺序固定：model(红) deploy(黄·无 config.local) bridge(红) feishu(红) mokaTab(红) storage(绿)
    assert.deepEqual(cardLevels(cards()),
      ['is-bad', 'is-warn', 'is-bad', 'is-bad', 'is-bad', 'is-ok']);
    assert.match(dom['health-verdict'].textContent, /✅ 1 项通过/);
    assert.match(dom['health-verdict'].textContent, /⚠️ 1 项注意/);
    assert.match(dom['health-verdict'].textContent, /❌ 4 项异常/);
    assert.match(dom['health-verdict'].textContent, /按卡片里的「怎么办」逐条修/);
    assert.ok(dom['health-verdict'].classList.contains('is-bad'), '汇总条随最严重级别变色');
    assert.match(cards()[0].querySelector('.health-card-body').textContent, /API Key 未填写[\s\S]*怎么办：/);
  });

  it('部署态下 Endpoint / 模型名取自 config.local.js，不再误报「为空」', async () => {
    const { ctx, dom, cards } = buildContext({
      settings: { apiKey: 'k', feishuAppId: 'cli_x', feishuAppSecret: 's', feishuReceiver: 'me@x.com' }, // storage 里没有 Endpoint / 模型名
      local: { apiProtocol: 'openai', apiEndpoint: 'https://model-router.meitu.com/v1', modelName: 'GLM-5.3-Flash-MT' }
    });
    await ctx.renderHealthCheck();
    assert.ok(cards()[0].classList.contains('is-ok'), '模型项应为绿（Endpoint / 模型名由部署态提供）');
    assert.match(cards()[0].querySelector('.health-card-body').textContent, /model-router\.meitu\.com/);
    assert.ok(cards()[1].classList.contains('is-ok'), '部署态项应为绿');
    assert.equal(cards()[0].querySelector('.health-card-badge').textContent, '正常');
    assert.match(dom['health-verdict'].textContent, /^✅ 6 项通过/);
  });

  it('「检查中」期间汇总条如实说在检查，结论不提前给', async () => {
    const { ctx, dom } = buildContext({});
    // 不 await：探测函数全是 async，复位那一刻汇总条应为 pending
    const pending = ctx.renderHealthCheck();
    assert.match(dom['health-verdict'].textContent, /⏳ 6 项检查中｜正在检查…/);
    assert.ok(dom['health-verdict'].classList.contains('is-pending'));
    await pending;
    assert.doesNotMatch(dom['health-verdict'].textContent, /检查中/);
  });

  it('连点「重新检查」只重置卡面、不重建卡片；上一轮迟到的结论不回填', async () => {
    const { ctx, dom, cards, timers } = buildContext({ bridge: ['silent', { connected: true }] });
    const first = ctx.renderHealthCheck(); // 第一轮：Bridge 回调不回，结论悬空
    await flush(); // 等第一轮把探测登记完（它的 3 秒定时器此刻入队）
    await ctx.renderHealthCheck(); // 第二轮：正常返回
    const secondVerdict = dom['health-verdict'].textContent;
    assert.ok(cards()[2].classList.contains('is-ok'), '第二轮 Bridge 应为绿');
    assert.equal(cards().length, 6, '重跑不得重复建卡');

    timers[0](); // 触发第一轮那个 3 秒超时回调（真实世界里会晚于第二轮到达）
    await flush();
    assert.equal(cards().length, 6);
    assert.ok(cards()[2].classList.contains('is-ok'), '迟到结论不得覆盖新结论');
    assert.doesNotMatch(cards()[2].querySelector('.health-card-body').textContent, /3 秒未响应/);
    assert.equal(dom['health-verdict'].textContent, secondVerdict);
    await first;
  });

  it('Bridge 后台 3 秒不回时给「重新检查」指引（超时分支仍可用）', async () => {
    const { ctx, dom, cards, timers } = buildContext({ bridge: ['silent'] });
    const run = ctx.renderHealthCheck();
    await flush(); // 等探测登记完，定时器才在 timers 里
    timers[0](); // 手动触发超时回调
    await run;
    assert.ok(cards()[2].classList.contains('is-bad'));
    assert.match(cards()[2].querySelector('.health-card-body').textContent, /3 秒未响应[\s\S]*重新检查/);
    assert.match(dom['health-verdict'].textContent, /2 项异常/);
  });

  it('「复制结果」把卡片原话拼成纯文本并回显提示', async () => {
    const { ctx, dom, copied } = buildContext({ settings: ALL_OK_SETTINGS, local: ALL_OK_LOCAL });
    await ctx.renderHealthCheck();
    assert.equal(typeof dom['health-copy'].listeners.click, 'function');
    await dom['health-copy'].listeners.click();
    await new Promise((r) => setImmediate(r));
    assert.match(copied.text, /^【Moka 插件健康检查】扩展 3\.6\.0/);
    CARD_TITLES.forEach((t) => assert.ok(copied.text.includes(t), '报告应含 ' + t));
    assert.match(copied.text, /\[正常\] 评分模型配置/);
    assert.match(dom['health-copy-note'].textContent, /体检结果已复制/);
    // 「重新检查」按钮同样接了监听
    assert.equal(typeof dom['health-rerun'].listeners.click, 'function');
  });

  it('结论文案一律走 textContent，不拼 innerHTML（Endpoint / 模型名为用户输入）', () => {
    assert.doesNotMatch(SOURCE, /innerHTML\s*=/);
    assert.match(SOURCE, /textContent = /);
  });
});
