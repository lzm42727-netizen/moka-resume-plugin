/**
 * 健康检查（v3.6.0）：原独立页 popup/health.html + health.js 并入弹窗「健康检查」标签页。
 *
 * 设计约定：
 * - 只读诊断，不改任何设置；红/黄/绿三级卡片（沿用看板的红黄绿分级习惯）；
 * - 每条结论都带「怎么办」，不给裸报错；
 * - 探测函数只返回 { level, body }，渲染统一走 renderHealthCard —— 好测、探测与 DOM 解耦；
 * - chrome API 全部 try/catch，任何单项失败不影响其它项；
 * - 入口是 popup.js 的 switchTab('health') → renderHealthCheck()；缺 DOM 容器时静默跳过
 *   （popup.html 重构漏元素时，其它标签页照常工作，与 safeEl 的容错口径一致）。
 *
 * 加载位置：popup.html 里排在 popup.js 之后（无加载期依赖，且不打断 popup 三文件的线性拼接锚点）。
 */

const HEALTH_CHECKS = ['model', 'deploy', 'bridge', 'feishu', 'mokaTab', 'storage'];

/** 六项体检的固定标题：占位卡与结果卡共用，避免两处文案漂移 */
const HEALTH_CHECK_TITLES = {
  model: '评分模型配置',
  deploy: '部署态（config.local.js）',
  bridge: '本地 Bridge 服务',
  feishu: '飞书自建应用凭据',
  mokaTab: 'Moka 页面连接',
  storage: '本地存储 (chrome.storage.local)'
};

const HEALTH_BADGE = { ok: '正常', warn: '注意', bad: '异常' };

/** 最近一次结果：key → { level, body }，供顶部汇总行与「复制结果」使用 */
const healthResults = {};
/** key → 卡片 DOM（预建后原地更新，保证卡序稳定 = HEALTH_CHECKS 顺序） */
const healthCards = {};
/** 并发令牌：连点「重新检查」时，旧一轮的迟到结果不再回填 */
let healthRunToken = 0;

function healthEl(id) {
  // 优先复用 popup.js 的 safeEl（缺 id 会 console.warn 一次），popup.js 未加载时退回裸查询
  if (typeof safeEl === 'function') return safeEl(id);
  return document.getElementById(id);
}

/** config.local.js 的本地锁定项（popup.js 里以 const 声明，取值失败按空对象处理） */
function localDefaults() {
  try {
    return (typeof LOCAL_DEFAULTS !== 'undefined' && LOCAL_DEFAULTS) || {};
  } catch (e) {
    return {};
  }
}

/**
 * 读 mokaSettings，并与部署态锁定项合并——不然部署环境里 Endpoint / 模型名存在 config.local.js、
 * 不在 storage 里，会被误报成「为空」（v3.4.0 独立页的口径问题，本次一并修掉）。
 */
async function readHealthSettings() {
  const local = localDefaults();
  try {
    const res = await chrome.storage.local.get('mokaSettings');
    return { ...local, ...(res.mokaSettings || {}) };
  } catch (e) {
    return { ...local };
  }
}

// ---- 六项探测：只返回结论，不碰 DOM ----

async function checkModel(settings) {
  const apiKey = String(settings.apiKey || '').trim();
  const endpoint = String(settings.apiEndpoint || '').trim();
  const model = String(settings.modelName || '').trim();
  const protocol = String(settings.apiProtocol || 'openai');
  const provider = String(settings.apiProvider || '').trim();
  if (!apiKey) {
    return {
      level: 'bad',
      body: 'API Key 未填写——点「开始筛选」会直接失败。\n'
        + '怎么办：切到「设置」页 →「连接与模型」→ 填入 API Key → 点「保存并测试连接」。'
    };
  }
  const missing = [];
  if (!endpoint) missing.push('Endpoint');
  if (!model) missing.push('模型名称');
  if (missing.length) {
    return {
      level: 'warn',
      body: 'API Key 已填写；' + missing.join('、') + '为空（会走内置默认值）。\n协议：' + protocol
        + '\n怎么办：能用就忽略；需要指定网关或模型档位时到「设置」页补齐。'
    };
  }
  return {
    level: 'ok',
    body: 'API Key 已配置 · 协议 ' + protocol + (provider ? ' · 提供商 ' + provider : '')
      + '\nEndpoint：' + endpoint + '\n模型：' + model
  };
}

async function checkDeploy() {
  if (Object.keys(localDefaults()).length > 0) {
    return {
      level: 'ok',
      body: '检测到本地私有配置（config.local.js）：协议 / 提供商 / Endpoint / 模型名已锁定，'
        + '设置页只需填 API Key。'
    };
  }
  return {
    level: 'warn',
    body: '未检测到 config.local.js（个人模式，连接信息全部手填）。\n'
      + '怎么办：团队部署请按 README 把 config.local.js 放到扩展根目录后重载扩展。'
  };
}

async function checkBridge() {
  return new Promise((resolve) => {
    let replied = false;
    // 回调与 3 秒超时都可能先到，统一由 done 收敛：只有一个结论落到卡上
    const done = (res) => {
      if (replied) return;
      replied = true;
      resolve(res);
    };
    try {
      chrome.runtime.sendMessage({ action: 'getFeishuBridgeStatus' }, (res) => {
        if (chrome.runtime.lastError) {
          return done({
            level: 'bad',
            body: '后台无响应：' + (chrome.runtime.lastError.message || '未知原因')
              + '\n怎么办：到「设置」页点「🔄 立即连接」；仍不行就重载扩展后重试。'
          });
        }
        if (res && res.connected) {
          return done({
            level: 'ok',
            body: 'ws://127.0.0.1:18888 已连接，飞书卡片按钮可直驱页面执行。'
          });
        }
        if (res && res.manualDisconnected) {
          return done({
            level: 'warn',
            body: '你主动断开了本地 Bridge。\n'
              + '怎么办：「设置」页点「🔄 立即连接」，或双击「启动飞书机器人.command」。'
          });
        }
        return done({
          level: 'bad',
          body: 'ws://127.0.0.1:18888 未连接——飞书卡片按钮会无响应（整轮汇总推送不受影响）。\n'
            + '怎么办：双击「启动飞书机器人.command」；首次部署先 cd feishu-bridge && npm install。'
        });
      });
    } catch (e) {
      return done({ level: 'bad', body: '探测异常：' + ((e && e.message) || e) });
    }
    setTimeout(() => {
      done({
        level: 'bad',
        body: '后台 3 秒未响应（Service Worker 可能刚被唤醒）。\n怎么办：点「重新检查」再试一次。'
      });
    }, 3000);
  });
}

async function checkFeishu(settings) {
  const appId = String(settings.feishuAppId || '').trim();
  const appSecret = String(settings.feishuAppSecret || '').trim();
  const receiver = String(settings.feishuReceiver || '').trim();
  const have = [appId, appSecret, receiver].filter(Boolean).length;
  if (have === 3) {
    return {
      level: 'ok',
      body: 'App ID / App Secret / 接收人 三项齐全，私聊推送与卡片回执可用。'
    };
  }
  if (have === 0) {
    return {
      level: 'warn',
      body: '未配置飞书自建应用——只影响「飞书推送 / 卡片协同」，评分与批量推进不受影响。\n'
        + '怎么办：要飞书协同就按使用说明 7a 在「设置」页配齐三项；不需要可以不管这一条。'
    };
  }
  const missing = [
    !appId && 'App ID',
    !appSecret && 'App Secret',
    !receiver && '接收人'
  ].filter(Boolean);
  return {
    level: 'bad',
    body: '配置不完整：缺 ' + missing.join('、') + '——「配了但发不到」的错觉高发区。\n'
      + '怎么办：补齐缺失项；如不需要飞书协同，把三项全清空。'
  };
}

async function checkMokaTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ url: '*://app.mokahr.com/*' }, (tabs) => {
        const n = (tabs || []).length;
        if (n > 0) {
          resolve({
            level: 'ok',
            body: '检测到 ' + n + ' 个打开的 Moka 标签页，批量推进 / 读取简历推荐对象可用。'
          });
        } else {
          resolve({
            level: 'bad',
            body: '没有打开的 Moka 标签页——批量推进、弹窗人选读取都依赖已打开的页面。\n'
              + '怎么办：打开 Moka 候选人列表页并保持登录。'
          });
        }
      });
    } catch (e) {
      resolve({ level: 'bad', body: '探测异常：' + ((e && e.message) || e) });
    }
  });
}

async function checkStorage() {
  const KEY = 'healthCheckProbe';
  const stamp = String(Date.now());
  try {
    await chrome.storage.local.set({ [KEY]: stamp });
    const res = await chrome.storage.local.get(KEY);
    await chrome.storage.local.remove(KEY);
    if (res[KEY] === stamp) {
      return { level: 'ok', body: '读写探测通过，结果 / 存档 / 设置落盘正常。' };
    }
    return {
      level: 'bad',
      body: '读回值与写入不一致，存储可能被外部清理工具干扰。\n'
        + '怎么办：检查磁盘空间与浏览器「站点数据」设置后重试。'
    };
  } catch (e) {
    return {
      level: 'bad',
      body: '读写失败：' + ((e && e.message) || e)
        + '\n怎么办：检查磁盘空间与浏览器「站点数据」设置。'
    };
  }
}

// ---- 渲染 ----

function renderHealthCard(key, level, body) {
  healthResults[key] = { level: level || '', body: body || '' };
  const box = healthEl('health-results');
  if (!box) return; // 缺容器就只记录结论（复制结果 / 汇总仍可用）
  let card = healthCards[key];
  if (!card) {
    card = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'health-card-head';
    const name = document.createElement('span');
    name.className = 'health-card-name';
    const badge = document.createElement('span');
    badge.className = 'health-card-badge';
    head.append(name, badge);
    const text = document.createElement('div');
    text.className = 'health-card-body';
    card.append(head, text);
    healthCards[key] = card;
    box.appendChild(card);
  }
  card.classList.remove('pending', 'is-ok', 'is-warn', 'is-bad');
  card.classList.add(level ? 'is-' + level : 'pending');
  // 全部走 textContent：体检文案含用户填的 Endpoint / 模型名，不进 innerHTML
  card.querySelector('.health-card-name').textContent = HEALTH_CHECK_TITLES[key] || key;
  card.querySelector('.health-card-badge').textContent = level ? (HEALTH_BADGE[level] || level) : '检查中';
  card.querySelector('.health-card-body').textContent = body || '';
  updateHealthSummary();
}

function updateHealthSummary() {
  const counts = { ok: 0, warn: 0, bad: 0, pending: 0 };
  HEALTH_CHECKS.forEach((k) => {
    const level = healthResults[k] && healthResults[k].level;
    counts[level === 'ok' || level === 'warn' || level === 'bad' ? level : 'pending'] += 1;
  });
  const parts = [];
  if (counts.ok) parts.push('✅ ' + counts.ok + ' 项通过');
  if (counts.warn) parts.push('⚠️ ' + counts.warn + ' 项注意');
  if (counts.bad) parts.push('❌ ' + counts.bad + ' 项异常');
  if (counts.pending) parts.push('⏳ ' + counts.pending + ' 项检查中');

  let level = 'ok';
  let verdict = '一切正常，可以放心开筛。';
  if (counts.pending) {
    level = 'pending';
    verdict = '正在检查…';
  } else if (counts.bad) {
    level = 'bad';
    verdict = '有必须处理的问题，按卡片里的「怎么办」逐条修。';
  } else if (counts.warn) {
    level = 'warn';
    verdict = '功能可用，黄色项建议顺手修掉。';
  }
  const box = healthEl('health-verdict');
  if (!box) return;
  box.className = 'health-verdict is-' + level;
  box.textContent = (parts.join(' · ') || '尚未检查') + '｜' + verdict;
}

function healthVersionText() {
  try {
    return (chrome.runtime.getManifest() || {}).version || '(未知)';
  } catch (e) {
    return '(未知)';
  }
}

/** 体检报告纯文本：卡片上的原话，直接粘给同事 / 开发者即可 */
function healthTextReport() {
  const rows = ['【Moka 插件健康检查】扩展 ' + healthVersionText()
    + ' · ' + new Date().toLocaleString('zh-CN')];
  HEALTH_CHECKS.forEach((k) => {
    const r = healthResults[k] || {};
    rows.push('[' + (HEALTH_BADGE[r.level] || '检查中') + '] '
      + (HEALTH_CHECK_TITLES[k] || k) + '\n' + (r.body || '(尚未出结论)'));
  });
  return rows.join('\n\n');
}

async function renderHealthCheck() {
  const token = ++healthRunToken;
  const at = healthEl('health-checked-at');
  if (at) at.textContent = new Date().toLocaleTimeString('zh-CN');
  const ver = healthEl('health-version');
  if (ver) ver.textContent = healthVersionText();
  const note = healthEl('health-copy-note');
  if (note) note.textContent = '';
  // 先把六张卡复位成「检查中」：顺序即 HEALTH_CHECKS 顺序，逐项返回时卡序不抖动
  HEALTH_CHECKS.forEach((key) => renderHealthCard(key, '', ''));

  const settings = await readHealthSettings();
  if (token !== healthRunToken) return;

  const tasks = [
    ['model', () => checkModel(settings)],
    ['deploy', () => checkDeploy()],
    ['bridge', () => checkBridge()],
    ['feishu', () => checkFeishu(settings)],
    ['mokaTab', () => checkMokaTab()],
    ['storage', () => checkStorage()]
  ];
  await Promise.all(tasks.map(async ([key, run]) => {
    let res;
    try {
      res = await run();
    } catch (e) {
      res = { level: 'bad', body: '探测异常：' + ((e && e.message) || e) };
    }
    if (token !== healthRunToken) return; // 已有更新的一轮在跑，迟到结果不回填
    renderHealthCard(key, res && res.level, res && res.body);
  }));
  if (token !== healthRunToken) return;
  updateHealthSummary();
}

async function copyHealthReport() {
  const note = healthEl('health-copy-note');
  const flash = (message) => {
    if (note) note.textContent = ' · ' + message;
  };
  try {
    await navigator.clipboard.writeText(healthTextReport());
    flash('体检结果已复制');
  } catch (e) {
    flash('复制失败：' + ((e && e.message) || '未知错误'));
  }
}

healthEl('health-rerun')?.addEventListener('click', () => renderHealthCheck());
healthEl('health-copy')?.addEventListener('click', () => copyHealthReport());
