const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../popup/popup-health.js'), 'utf8');
const POPUP_CSS = fs.readFileSync(path.join(__dirname, '../popup/popup.css'), 'utf8');

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
      toggle: (c, force) => {
        const on = force === undefined ? !el.classList.contains(c) : !!force;
        if (on) el.classList.add(c);
        else el.classList.remove(c);
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
  const dom = {};
  // 与 popup.html 一致：汇总条内含状态点 + 文本两个子节点，其余 id 平铺
  ['health-list', 'health-rerun', 'health-copy', 'health-version', 'health-checked-at', 'health-copy-note']
    .forEach((id) => { dom[id] = makeEl('div', id); });
  dom['health-verdict'] = makeEl('div', 'health-verdict');
  dom['health-verdict'].className = 'health-summary is-pending';
  const summaryDot = makeEl('span');
  summaryDot.className = 'health-summary-dot';
  const summaryText = makeEl('span');
  summaryText.className = 'health-summary-text';
  summaryText.textContent = '尚未检查';
  dom['health-verdict'].append(summaryDot, summaryText);

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
  const rows = () => dom['health-list'].children;
  return {
    ctx,
    dom,
    copied,
    timers,
    rows,
    /** 汇总条文案（在 .health-summary-text 上，不在容器上） */
    summary: () => dom['health-verdict'].querySelector('.health-summary-text').textContent
  };
}

const rowLevels = (rows) => rows.map((r) => r.className.replace('health-row', '').trim());

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
  it('六项体检按固定顺序成行，标题与占位态取自同一份文案表', async () => {
    const { ctx, rows, summary } = buildContext({ settings: ALL_OK_SETTINGS, local: ALL_OK_LOCAL });
    await ctx.renderHealthCheck();
    assert.equal(rows().length, 6);
    assert.deepEqual(
      rows().map((r) => r.querySelector('.health-row-name').textContent),
      CARD_TITLES
    );
    // 全绿：每行都是 is-ok + 标签「正常」，没有残留 is-pending
    assert.deepEqual(rowLevels(rows()), ['is-ok', 'is-ok', 'is-ok', 'is-ok', 'is-ok', 'is-ok']);
    assert.deepEqual(rows().map((r) => r.querySelector('.health-row-tag').textContent),
      ['正常', '正常', '正常', '正常', '正常', '正常']);
    assert.match(summary(), /^✅ 6 项通过｜一切正常/);
  });

  it('红黄绿分级落在状态点与小标签上；汇总条随最严重级别变色', async () => {
    const { ctx, dom, rows, summary } = buildContext({
      settings: { apiKey: '', feishuAppId: 'a', feishuReceiver: 'r' }, // Key 空→红；飞书缺 Secret→红
      bridge: { connected: false }, // Bridge 未连→红
      mokaTabs: [] // 无 Moka 页面→红
    });
    await ctx.renderHealthCheck();
    // 顺序固定：model(红) deploy(黄·无 config.local) bridge(红) feishu(红) mokaTab(红) storage(绿)
    assert.deepEqual(rowLevels(rows()),
      ['is-bad', 'is-warn', 'is-bad', 'is-bad', 'is-bad', 'is-ok']);
    assert.match(summary(), /✅ 1 项通过/);
    assert.match(summary(), /⚠️ 1 项注意/);
    assert.match(summary(), /❌ 4 项异常/);
    assert.match(summary(), /按下面每项结尾的动作清单逐条处理/);
    assert.ok(dom['health-verdict'].classList.contains('is-bad'), '汇总条随最严重级别变色');
    assert.ok(dom['health-verdict'].classList.contains('health-summary'));
    // 分级只体现在状态点与小标签上，行底不铺色（CSS 里不出现整行背景）
    assert.match(POPUP_CSS, /\.health-row\.is-bad \.health-row-dot \{[\s\S]{0,60}background: var\(--error\)/);
    assert.doesNotMatch(POPUP_CSS, /\.health-row\.is-(ok|warn|bad) \{[\s\S]{0,40}background:/);
  });

  it('「怎么办」拆成独立一行：描述行只讲现状，动作单占一行', async () => {
    const { ctx, rows } = buildContext({ settings: { apiKey: '' } });
    await ctx.renderHealthCheck();
    const detail = rows()[0].querySelector('.health-row-body').textContent;
    const fix = rows()[0].querySelector('.health-row-fix');
    assert.match(detail, /API Key 未填写/);
    assert.doesNotMatch(detail, /怎么办/);
    assert.match(fix.textContent, /^怎么办：/);
    assert.ok(!fix.classList.contains('hidden'));
    // 全绿项没有动作行，用 hidden 收起
    assert.ok(rows()[5].querySelector('.health-row-fix').classList.contains('hidden'));
  });

  it('部署态下 Endpoint / 模型名取自 config.local.js，不再误报「为空」', async () => {
    const { ctx, rows, summary } = buildContext({
      settings: { apiKey: 'k', feishuAppId: 'cli_x', feishuAppSecret: 's', feishuReceiver: 'me@x.com' }, // storage 里没有 Endpoint / 模型名
      local: { apiProtocol: 'openai', apiEndpoint: 'https://model-router.meitu.com/v1', modelName: 'GLM-5.3-Flash-MT' }
    });
    await ctx.renderHealthCheck();
    assert.ok(rows()[0].classList.contains('is-ok'), '模型项应为绿（Endpoint / 模型名由部署态提供）');
    assert.match(rows()[0].querySelector('.health-row-body').textContent, /model-router\.meitu\.com/);
    assert.ok(rows()[1].classList.contains('is-ok'), '部署态项应为绿');
    assert.equal(rows()[0].querySelector('.health-row-tag').textContent, '正常');
    assert.match(summary(), /^✅ 6 项通过/);
  });

  it('「检查中」期间汇总条如实说在检查，结论不提前给', async () => {
    const { ctx, dom, summary } = buildContext({});
    // 不 await：探测函数全是 async，复位那一刻汇总条应为 pending
    const pending = ctx.renderHealthCheck();
    assert.match(summary(), /⏳ 6 项检查中｜正在检查…/);
    assert.ok(dom['health-verdict'].classList.contains('is-pending'));
    await pending;
    assert.doesNotMatch(summary(), /检查中/);
  });

  it('连点「重新检查」只重置行内容、不重建行；上一轮迟到的结论不回填', async () => {
    const { ctx, rows, summary, timers } = buildContext({ bridge: ['silent', { connected: true }] });
    const first = ctx.renderHealthCheck(); // 第一轮：Bridge 回调不回，结论悬空
    await flush(); // 等第一轮把探测登记完（它的 3 秒定时器此刻入队）
    await ctx.renderHealthCheck(); // 第二轮：正常返回
    const secondSummary = summary();
    assert.ok(rows()[2].classList.contains('is-ok'), '第二轮 Bridge 应为绿');
    assert.equal(rows().length, 6, '重跑不得重复建行');

    timers[0](); // 触发第一轮那个 3 秒超时回调（真实世界里会晚于第二轮到达）
    await flush();
    assert.equal(rows().length, 6);
    assert.ok(rows()[2].classList.contains('is-ok'), '迟到结论不得覆盖新结论');
    assert.doesNotMatch(rows()[2].querySelector('.health-row-body').textContent, /3 秒未响应/);
    assert.equal(summary(), secondSummary);
    await first;
  });

  it('Bridge 后台 3 秒不回时给「重新检查」指引（超时分支仍可用）', async () => {
    const { ctx, rows, summary, timers } = buildContext({ bridge: ['silent'] });
    const run = ctx.renderHealthCheck();
    await flush(); // 等探测登记完，定时器才在 timers 里
    timers[0](); // 手动触发超时回调
    await run;
    assert.ok(rows()[2].classList.contains('is-bad'));
    assert.match(rows()[2].querySelector('.health-row-body').textContent, /3 秒未响应/);
    assert.match(rows()[2].querySelector('.health-row-fix').textContent, /重新检查/);
    assert.match(summary(), /2 项异常/);
  });

  it('「复制结果」把清单原话（含「怎么办」）拼成纯文本并回显提示', async () => {
    const { ctx, dom, copied } = buildContext({ settings: ALL_OK_SETTINGS, local: ALL_OK_LOCAL });
    await ctx.renderHealthCheck();
    assert.equal(typeof dom['health-copy'].listeners.click, 'function');
    await dom['health-copy'].listeners.click();
    await new Promise((r) => setImmediate(r));
    assert.match(copied.text, /^【Moka 插件健康检查】扩展 3\.6\.0/);
    CARD_TITLES.forEach((t) => assert.ok(copied.text.includes(t), '报告应含 ' + t));
    assert.match(copied.text, /\[正常\] 评分模型配置/);
    assert.match(dom['health-copy-note'].textContent, /已复制体检结果/);
    assert.ok(dom['health-copy-note'].classList.contains('is-ok'), '成功提示走绿色');
    // 「重新检查」按钮同样接了监听
    assert.equal(typeof dom['health-rerun'].listeners.click, 'function');
  });

  it('结论文案一律走 textContent，不拼 innerHTML（Endpoint / 模型名为用户输入）', () => {
    assert.doesNotMatch(SOURCE, /innerHTML\s*=/);
    assert.match(SOURCE, /textContent = /);
  });
});
