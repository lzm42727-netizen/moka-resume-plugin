/**
 * 健康检查页（v3.4.0）：配置 / Bridge / 飞书凭据 / Moka 页面 / 本地存储 一站式体检。
 *
 * 设计约定：
 * - 只读诊断，不改任何设置；红/黄/绿三级卡片（与用户看板分级习惯一致）；
 * - 全部结论附「怎么办」，不给裸报错；
 * - chrome API 全部 try/catch，任何单项失败不影响其它项。
 */

/* eslint-env browser, chrome */

const CHECKS = ['model', 'deploy', 'bridge', 'feishu', 'mokaTab', 'storage'];

const cards = {};

function el(id) {
  return document.getElementById(id);
}

function renderCard(key, title, level, badgeText, body) {
  let card = cards[key];
  if (!card) {
    card = document.createElement('div');
    card.className = 'check-card pending';
    card.innerHTML = '<div class="check-title"></div><div class="check-body"></div>';
    el('results').appendChild(card);
    cards[key] = card;
  }
  card.classList.remove('pending', 'is-ok', 'is-warn', 'is-bad');
  if (level) card.classList.add('is-' + level);
  card.querySelector('.check-title').textContent = title;
  const badge = level ? ' <span class="badge">' + badgeText + '</span>' : ' <span class="badge">检查中</span>';
  card.querySelector('.check-title').innerHTML = escapeHtml(title) + badge;
  card.querySelector('.check-body').textContent = body || '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 读 mokaSettings（与 popup.js loadSettings 同键名） */
function readSettings() {
  return chrome.storage.local.get('mokaSettings').then((res) => res.mokaSettings || {});
}

// ---- 各检查项 ----

async function checkModel(settings) {
  const apiKey = String(settings.apiKey || '').trim();
  const endpoint = String(settings.apiEndpoint || '').trim();
  const model = String(settings.modelName || '').trim();
  const protocol = String(settings.apiProtocol || 'openai');
  if (!apiKey) {
    return renderCard('model', '评分模型配置', 'bad', '红',
      'API Key 未填写——筛选会直接失败。\n怎么办：设置页「连接与模型」→ 填入 API Key。');
  }
  const missing = [];
  if (!endpoint) missing.push('Endpoint');
  if (!model) missing.push('模型名称');
  if (missing.length) {
    return renderCard('model', '评分模型配置', 'warn', '黄',
      'API Key 已填写；' + missing.join('、') + '为空（会走默认值）。\n协议：' + protocol
      + '\n怎么办：如无特殊需求可忽略；需要指定模型/网关时到设置页补齐。');
  }
  return renderCard('model', '评分模型配置', 'ok', '绿',
    'API Key 已配置 · 协议 ' + protocol + '\nEndpoint：' + endpoint + '\n模型：' + model);
}

async function checkDeploy() {
  const deployed = typeof LOCAL_DEFAULTS !== 'undefined' && LOCAL_DEFAULTS
    && Object.keys(LOCAL_DEFAULTS).length > 0;
  if (deployed) {
    return renderCard('deploy', '部署态（config.local.js）', 'ok', '绿',
      '检测到本地私有配置：协议 / 提供商 / Endpoint / 模型名已锁定，设置页只需填 API Key。');
  }
  return renderCard('deploy', '部署态（config.local.js）', 'warn', '黄',
    '未检测到 config.local.js（个人模式，连接信息全部手填）。\n'
    + '怎么办：团队部署请按 README 放置 feishu-bridge 同级的 config.local.js 后重载扩展。');
}

async function checkBridge() {
  return new Promise((resolve) => {
    let replied = false;
    try {
      chrome.runtime.sendMessage({ action: 'getFeishuBridgeStatus' }, (res) => {
        replied = true;
        if (chrome.runtime.lastError) {
          renderCard('bridge', '本地 Bridge 服务', 'bad', '红',
            '后台无响应：' + (chrome.runtime.lastError.message || '未知原因')
            + '\n怎么办：重载扩展后重试。');
          return resolve();
        }
        if (res && res.connected) {
          renderCard('bridge', '本地 Bridge 服务', 'ok', '绿',
            'ws://127.0.0.1:18888 已连接，飞书卡片按钮可直驱页面执行。');
        } else if (res && res.manualDisconnected) {
          renderCard('bridge', '本地 Bridge 服务', 'warn', '黄',
            '你主动断开了本地 Bridge。\n怎么办：设置页点「立即连接」，或双击「启动飞书机器人.command」。');
        } else {
          renderCard('bridge', '本地 Bridge 服务', 'bad', '红',
            'ws://127.0.0.1:18888 未连接——飞书卡片按钮将无响应（汇总推送不受影响）。\n'
            + '怎么办：双击项目里的「启动飞书机器人.command」；首次部署先 cd feishu-bridge && npm install。');
        }
        resolve();
      });
    } catch (e) {
      renderCard('bridge', '本地 Bridge 服务', 'bad', '红', '探测异常：' + (e && e.message));
      resolve();
    }
    setTimeout(() => {
      if (!replied) {
        renderCard('bridge', '本地 Bridge 服务', 'bad', '红',
          '后台 3 秒未响应（Service Worker 可能刚被唤醒）。\n怎么办：点「重新检查」再试一次。');
        resolve();
      }
    }, 3000);
  });
}

async function checkFeishu(settings) {
  const appId = String(settings.feishuAppId || '').trim();
  const appSecret = String(settings.feishuAppSecret || '').trim();
  const receiver = String(settings.feishuReceiver || '').trim();
  const have = [appId, appSecret, receiver].filter(Boolean).length;
  if (have === 3) {
    return renderCard('feishu', '飞书自建应用凭据', 'ok', '绿',
      'App ID / App Secret / 接收人 三项齐全，私聊推送与卡片回执可用。');
  }
  if (have === 0) {
    return renderCard('feishu', '飞书自建应用凭据', 'warn', '黄',
      '未配置飞书自建应用——仅影响「飞书推送/卡片协同」，评分与批量推进不受影响。\n'
      + '怎么办：设置页「飞书机器人协同」按使用说明 7a 配置。');
  }
  const missing = [
    !appId && 'App ID', !appSecret && 'App Secret', !receiver && '接收人'
  ].filter(Boolean);
  return renderCard('feishu', '飞书自建应用凭据', 'bad', '红',
    '配置不完整：缺 ' + missing.join('、') + '——「配了但发不到」的错觉高发区。\n'
    + '怎么办：补齐缺失项；不需要飞书协同可清空全部三项。');
}

async function checkMokaTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ url: '*://app.mokahr.com/*' }, (tabs) => {
        const n = (tabs || []).length;
        if (n > 0) {
          renderCard('mokaTab', 'Moka 页面连接', 'ok', '绿',
            '检测到 ' + n + ' 个打开的 Moka 标签页，批量推进 / 推荐对象读取可用。');
        } else {
          renderCard('mokaTab', 'Moka 页面连接', 'bad', '红',
            '没有打开的 Moka 标签页——批量推进、弹窗人选读取都依赖已打开的页面。\n'
            + '怎么办：打开 Moka 候选人列表页并保持登录。');
        }
        resolve();
      });
    } catch (e) {
      renderCard('mokaTab', 'Moka 页面连接', 'bad', '红', '探测异常：' + (e && e.message));
      resolve();
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
      return renderCard('storage', '本地存储 (chrome.storage.local)', 'ok', '绿', '读写探测通过，结果/存档/设置落盘正常。');
    }
    return renderCard('storage', '本地存储 (chrome.storage.local)', 'bad', '红', '读回值与写入不一致，存储可能被外部清理工具干扰。');
  } catch (e) {
    return renderCard('storage', '本地存储 (chrome.storage.local)', 'bad', '红',
      '读写失败：' + ((e && e.message) || e) + '\n怎么办：检查磁盘空间 / 浏览器站点数据设置。');
  }
}

async function runAll() {
  el('checked-at').textContent = new Date().toLocaleTimeString('zh-CN');
  el('ext-version').textContent = (chrome.runtime.getManifest() || {}).version || '(未知)';
  CHECKS.forEach((k) => renderCard(k, '…', null, '', ''));
  let settings = {};
  try { settings = await readSettings(); } catch (e) { /* 保持空对象 */ }
  await Promise.all([
    checkModel(settings),
    checkDeploy(),
    checkBridge(),
    checkFeishu(settings),
    checkMokaTab(),
    checkStorage()
  ]);
}

el('ext-version').textContent = (chrome.runtime.getManifest() || {}).version || '(未知)';
el('rerun').addEventListener('click', runAll);
runAll();
