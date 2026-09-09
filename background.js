/**
 * Moka 智能简历筛选 - Background Service Worker
 *
 * 统一的 LLM API 调用层。所有对外部 API 的请求都在这里发起，
 * content script 只负责识别页面和展示结果，通过消息与本文件通信。
 * 这样可以避开 Moka 页面 CSP（connect-src）对 content script fetch 的拦截。
 */

console.log('[Moka 筛选] Background service worker 已启动');

function enableSidePanelOnActionClick() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch (e) { /* Chrome < 116 无此 API */ }
}
enableSidePanelOnActionClick();
chrome.runtime.onInstalled.addListener(enableSidePanelOnActionClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnActionClick);

// 本地私有配置（config.local.js，已 gitignore）：如存在则强制覆盖对应设置
try { importScripts('config.local.js'); } catch (e) { /* 无本地配置时忽略 */ }
// lib 逐个容错加载：单个文件加载失败不会中断后续脚本，SW 仍能启动；
// 失败会被 console.error 定位到具体文件，方便排查。
function safeImportScripts(scriptPath) {
  try { importScripts(scriptPath); }
  catch (e) { console.error(`[Moka 筛选] 加载 ${scriptPath} 失败，依赖它的功能将不可用`, e); }
}
safeImportScripts('lib/contracts.js');
safeImportScripts('lib/score.js');
safeImportScripts('lib/persist.js');
safeImportScripts('lib/feedback.js');
safeImportScripts('lib/screening-job.js');
safeImportScripts('lib/usage.js');
safeImportScripts('lib/plugin-log.js');
function localForcedSettings() {
  return (typeof self !== 'undefined' && self.MOKA_LOCAL_SETTINGS) ? self.MOKA_LOCAL_SETTINGS : {};
}

/** 存储写入统一封装（P1-10）：失败读 lastError / 捕获异常并 console.error，不再静默丢数据。
 *  返回 Promise<boolean> 表示是否写入成功；调用方据此决定是否提示「已保存」。 */
function storeSet(items, context) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          console.error('[Moka 筛选] 存储写入失败(' + (context || 'unknown') + '):', chrome.runtime.lastError.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      console.error('[Moka 筛选] 存储写入异常(' + (context || 'unknown') + '):', e);
      resolve(false);
    }
  });
}

const DEFAULT_SETTINGS = {
  apiProvider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4o',
  // 可选：自定义单价（元/百万 tokens），留空走内置价目表；用于费用估算
  modelInputPrice: '',
  modelOutputPrice: ''
};

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const LLM_TIMEOUT_MS = 90000;
const RESUME_TIMEOUT_MS = 20000;
const CACHE_LIMIT = 500;

// 评分 / JD 缓存：内存 Map + chrome.storage.local，避免 SW 重启后重复扣费
const scoreCache = new Map();
const jdCache = new Map();
const scoreInflight = new Map(); // cacheKey → Promise：并发同 key 评分共享一次 LLM 调用
let scoreRecord = {};
let jdRecord = {};

function hydrateCacheMap(record, map) {
  map.clear();
  Object.keys(record || {}).forEach((k) => {
    const entry = record[k];
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'value')) map.set(k, entry.value);
  });
}

const llmCacheReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get(MokaPersist.LLM_CACHE_STORAGE_KEY, (res) => {
      const bag = (res && res[MokaPersist.LLM_CACHE_STORAGE_KEY]) || {};
      const now = Date.now();
      scoreRecord = MokaPersist.pruneTimedMap(bag.scores || {}, now, MokaPersist.LLM_CACHE_TTL_MS, MokaPersist.LLM_CACHE_LIMIT);
      jdRecord = MokaPersist.pruneTimedMap(bag.jds || {}, now, MokaPersist.LLM_CACHE_TTL_MS, MokaPersist.LLM_CACHE_LIMIT);
      hydrateCacheMap(scoreRecord, scoreCache);
      hydrateCacheMap(jdRecord, jdCache);
      resolve();
    });
  } catch (e) { resolve(); }
});

/* ---------------- 插件运行日志（会话级，storage.session 最近 100 条） ---------------- */

let pluginLog = [];
// MV3 SW 可能随时重启：启动时先把会话日志捞回内存，getPluginLog 等待它完成
const pluginLogReady = new Promise((resolve) => {
  try {
    chrome.storage.session.get(MokaPluginLog.LOG_KEY, (result) => {
      const saved = result && result[MokaPluginLog.LOG_KEY];
      pluginLog = MokaPluginLog.trimEntries(saved, MokaPluginLog.LOG_LIMIT);
      resolve();
    });
  } catch (e) {
    resolve();
  }
});

function persistPluginLog() {
  try {
    chrome.storage.session.set({ [MokaPluginLog.LOG_KEY]: pluginLog.slice() })
      .catch((e) => console.warn('[Moka 筛选] 运行日志落盘失败', e));
  } catch (e) { /* storage.session 不可用时仅保留内存 */ }
}

/** 记一条（或一批）运行日志：规范化后入环、落 storage.session、实时转发给侧栏 */
function addPluginLog(raw) {
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) addPluginLog(raw[i]);
    return null;
  }
  const entry = MokaPluginLog.normalizeEntry(raw);
  if (!entry) return null;
  pluginLog = MokaPluginLog.trimEntries(pluginLog.concat([entry]), MokaPluginLog.LOG_LIMIT);
  persistPluginLog();
  try {
    chrome.runtime.sendMessage({ action: 'pluginLogEntry', entry })
      .catch((e) => console.warn('[Moka 筛选] 运行日志实时广播失败', e));
  } catch (e) { /* 忽略 */ }
  return entry;
}

function clearPluginLog() {
  pluginLog = [];
  persistPluginLog();
}

let persistCacheTimer = null;
function schedulePersistLlmCache() {
  if (persistCacheTimer) return;
  persistCacheTimer = setTimeout(() => {
    persistCacheTimer = null;
    // LLM 缓存丢失 → SW 重启后重复扣费，写入失败必须可见
    storeSet({ [MokaPersist.LLM_CACHE_STORAGE_KEY]: { scores: scoreRecord, jds: jdRecord } }, 'llm-cache');
  }, 400);
}

function rememberScore(key, value) {
  scoreRecord = MokaPersist.putCacheRecord(
    scoreRecord, key, value, Date.now(),
    MokaPersist.LLM_CACHE_TTL_MS, MokaPersist.LLM_CACHE_LIMIT
  );
  hydrateCacheMap(scoreRecord, scoreCache);
  schedulePersistLlmCache();
}

function rememberJd(key, value) {
  jdRecord = MokaPersist.putCacheRecord(
    jdRecord, key, value, Date.now(),
    MokaPersist.LLM_CACHE_TTL_MS, MokaPersist.LLM_CACHE_LIMIT
  );
  hydrateCacheMap(jdRecord, jdCache);
  schedulePersistLlmCache();
}

/** 丢掉一条 JD 缓存（内存 + 落盘），下次重新解读 */
function forgetJd(key) {
  jdCache.delete(key);
  if (jdRecord && Object.prototype.hasOwnProperty.call(jdRecord, key)) {
    delete jdRecord[key];
    schedulePersistLlmCache();
  }
}

function setBoundedCache(map, key, value, limit = CACHE_LIMIT) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

/** fetch + 超时；超时抛出带中文说明的 Error */
async function fetchWithTimeout(url, options = {}, timeoutMs = LLM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && (error.name === 'AbortError' || controller.signal.aborted)) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const pendingMokaByTab = new Map();
const PENDING_MOKA_STORAGE_KEY = 'mokaPendingMokaByTab';

function tabIdFromSender(sender) {
  return sender && sender.tab && sender.tab.id;
}

function hydratePendingMokaFromDisk() {
  try {
    chrome.storage.local.get(PENDING_MOKA_STORAGE_KEY, (res) => {
      if (chrome.runtime.lastError) return;
      const bag = (res && res[PENDING_MOKA_STORAGE_KEY]) || {};
      Object.entries(bag).forEach(([k, v]) => {
        const id = Number(k);
        if (Number.isFinite(id) && v) pendingMokaByTab.set(id, v);
      });
    });
  } catch (e) { /* ignore */ }
}
hydratePendingMokaFromDisk();

function loadPendingMokaForTab(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(null);
      return;
    }
    const mem = pendingMokaByTab.get(tabId);
    if (mem) {
      resolve(mem);
      return;
    }
    try {
      chrome.storage.local.get(PENDING_MOKA_STORAGE_KEY, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const bag = (res && res[PENDING_MOKA_STORAGE_KEY]) || {};
        const pending = bag[String(tabId)] || null;
        if (pending) pendingMokaByTab.set(tabId, pending);
        resolve(pending);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setPendingMokaForTabAsync(tabId, pending) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(false);
      return;
    }
    if (pending) pendingMokaByTab.set(tabId, pending);
    else pendingMokaByTab.delete(tabId);
    try {
      const bag = {};
      pendingMokaByTab.forEach((v, k) => { bag[String(k)] = v; });
      chrome.storage.local.set({ [PENDING_MOKA_STORAGE_KEY]: bag }, () => {
        if (chrome.runtime.lastError) {
          resolve(!!(!pending || pendingMokaByTab.get(tabId)));
          return;
        }
        if (!pending) {
          resolve(!pendingMokaByTab.get(tabId));
          return;
        }
        const saved = pendingMokaByTab.get(tabId);
        resolve(!!(saved && saved.nonce === pending.nonce));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

const mokaResumeTimers = new Map();

function scheduleContentResume(tabId, delayMs) {
  if (tabId == null) return;
  const prev = mokaResumeTimers.get(tabId);
  if (prev) clearTimeout(prev);
  mokaResumeTimers.set(tabId, setTimeout(() => {
    mokaResumeTimers.delete(tabId);
    chrome.tabs.sendMessage(tabId, { action: 'resumeMokaAction' }, () => void chrome.runtime.lastError);
  }, delayMs == null ? 600 : delayMs));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || tab.url.indexOf('app.mokahr.com') === -1) return;
  loadPendingMokaForTab(tabId).then((pending) => {
    if (pending) scheduleContentResume(tabId, 800);
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Moka 筛选] 后台收到消息:', request.action);

  switch (request.action) {
    case 'analyzeJob':
      handleAnalyzeJob(request)
        .then((spec) => sendResponse({ ok: true, spec }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // 异步响应

    case 'scoreCandidate':
      handleScoreCandidate(request)
        .then((out) => sendResponse({ ok: true, score: out.score, meta: out.meta || null }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // 异步响应

    case 'modelPriceInfo':
      getModelPriceInfo()
        .then((info) => sendResponse({ ok: true, model: info.model, price: info.price }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // 异步响应

    case 'pluginLog':
      if (request && request.entry) addPluginLog(request.entry);
      sendResponse({ ok: true });
      return false;

    case 'getPluginLog':
      pluginLogReady.then(() => sendResponse({ ok: true, entries: pluginLog.slice() }));
      return true;

    case 'clearPluginLog':
      clearPluginLog();
      sendResponse({ ok: true });
      return false;

    case 'fetchResume':
      handleFetchResume(request.url)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // 异步响应

    case 'testApi':
      handleTestApi(request.settings)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'updateProgress':
    case 'resultsUpdated':
    case 'mokaActionComplete':
    case 'mokaContentReady':
    case 'pageJobChanged':
      // 转发到侧栏（侧栏未打开时忽略错误）
      chrome.runtime.sendMessage({ ...request }).catch(() => {});
      sendResponse({ received: true });
      return false;

    case 'setPendingMokaAction':
      setPendingMokaForTabAsync(tabIdFromSender(sender), request.pending || null)
        .then((ok) => sendResponse({ ok: !!ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'getPendingMokaAction':
      loadPendingMokaForTab(tabIdFromSender(sender))
        .then((pending) => sendResponse({ pending: pending || null }))
        .catch(() => sendResponse({ pending: null }));
      return true;

    case 'clearPendingMokaAction':
      setPendingMokaForTabAsync(tabIdFromSender(sender), null)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'notifyScreeningDone':
      notifyScreeningDone(request)
        .then((result) => sendResponse(result || { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: (error && error.message) || '通知失败' }));
      return true;

    case 'screeningKeepaliveStart':
      startScreeningKeepalive(tabIdFromSender(sender))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'screeningKeepaliveStop':
      stopScreeningKeepalive()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'screeningResumeAvailable':
    case 'screeningPausedMismatch':
      chrome.runtime.sendMessage({ ...request }).catch(() => {});
      sendResponse({ received: true });
      return false;

    default:
      sendResponse(MokaContracts.unknownActionResponse(request && request.action));
      return false;
  }
});

// 筛选完成：只在插件内提示（结果页横幅/Toast）。桌面系统通知已整体移除，
// 避免重复打扰且不再占用 notifications 权限。
async function notifyScreeningDone(payload) {
  const message = (payload && payload.message)
    || ('共 ' + ((payload && payload.total) || 0) + ' 位候选人已评分');
  chrome.runtime.sendMessage({
    action: 'screeningCompleteToast',
    message,
    total: payload && payload.total
  }).catch(() => {});
  return { ok: true };
}

let keepaliveTabId = null;

async function startScreeningKeepalive(tabId) {
  keepaliveTabId = tabId || null;
  try {
    await chrome.alarms.create(MokaScreeningJob.KEEP_ALIVE_ALARM, { periodInMinutes: 1 });
  } catch (e) { /* ignore */ }
}

async function stopScreeningKeepalive() {
  keepaliveTabId = null;
  try {
    await chrome.alarms.clear(MokaScreeningJob.KEEP_ALIVE_ALARM);
  } catch (e) { /* ignore */ }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== MokaScreeningJob.KEEP_ALIVE_ALARM) return;
    // 空闲自清（P2-4）：SW 重启后 keepaliveTabId 归 null 但周期 alarm 仍在，
    // 若不清理会每分钟空唤醒一次。清掉即止。
    if (keepaliveTabId == null) {
      try { chrome.alarms.clear(MokaScreeningJob.KEEP_ALIVE_ALARM); } catch (e) { /* ignore */ }
      return;
    }
    chrome.tabs.sendMessage(keepaliveTabId, { action: 'screeningKeepalivePing' }, () => {
      void chrome.runtime.lastError;
    });
  });
}

/**
 * 抓取候选人「附件简历」原件（Moka 托管在 OSS 上的 HTML/文本），提取正文供 AI 阅读。
 * 主动投递 + 附件简历的候选人，其完整实习/工作经历只存在于这份原件中，结构化 JSON 往往缺失。
 * 需要 service worker 具备 *.mokahr.com 的 host 权限以绕过 CORS。
 */
const resumeTextCache = new Map();
async function handleFetchResume(url) {
  if (!url) throw new Error('缺少简历链接');
  if (resumeTextCache.has(url)) return resumeTextCache.get(url);

  const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit' }, RESUME_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`简历抓取失败 HTTP ${resp.status}`);
  const raw = await resp.text();
  const text = htmlToText(raw);
  const clipped = text.length > 12000 ? text.slice(0, 12000) : text;

  setBoundedCache(resumeTextCache, url, clipped);
  return clipped;
}

/** 极简 HTML→纯文本：去脚本/样式、标签转空白、压缩空白、解码常见实体 */
function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/gm, '');
  return t.trim();
}

/**
 * 解读 JD，产出岗位画像（带缓存）
 */
async function handleAnalyzeJob({ jobJD, jobType }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('未配置 API Key');
  await llmCacheReady;

  const cacheKey = MokaPersist.stableHash({ jobJD, jobType, model: settings.modelName, promptRev: MokaScore.PROMPT_VERSION });
  if (jdCache.has(cacheKey)) {
    const cached = jdCache.get(cacheKey);
    if (MokaPersist.jobSpecIsUsable(cached)) return cached;
    // 旧版本会把「只有权重、没有岗位内容」的空壳也存进来，命中后每次刷新都秒失败
    forgetJd(cacheKey);
  }

  const systemPrompt =
    '你是资深招聘专家，擅长解读职位 JD 并提炼岗位画像。直接输出 JSON 结果，不要输出思考过程或多余文字。';
  const userPrompt = buildJDAnalysisPrompt(jobJD, jobType);
  const analyzeRes = await callLLM(settings, systemPrompt, userPrompt, { maxTokens: 2000, temperature: 0 });
  const content = analyzeRes.content;
  let spec = parseJDAnalysis(content);

  // 空返回/截断多半是偶发，自己重试一次（放宽输出上限、再强调一遍只要 JSON），
  // 比让用户看见报错再手点一遍「按 JD 刷新」强
  if (spec.parseError) {
    const retryPrompt = userPrompt + '\n\n只输出 JSON 对象本身，不要代码块围栏，不要任何解释。';
    const retryRes = await callLLM(settings, systemPrompt, retryPrompt, { maxTokens: 3000, temperature: 0 });
    const retried = parseJDAnalysis(retryRes.content);
    if (!retried.parseError) spec = retried;
  }

  if (!spec.parseError) rememberJd(cacheKey, spec);
  return spec;
}

/**
 * 对单个候选人做门槛核对与岗位匹配评估（带缓存）。
 * 返回匹配分与手写门槛结果，最终综合分由 content 侧合成。
 * profile: content 侧拼好的候选人完整画像文本
 * config.jobSpec: 上一步 JD 解读结果
 */
async function handleScoreCandidate({ profile, config }) {
  const settings = await getSettings();
  config = config || {};

  if (!settings.apiKey) {
    const errScore = MokaScore.scoreErrorResult('未配置 API Key');
    return { score: errScore, meta: null };
  }

  const jobSpec = config.jobSpec || {};
  const hardText = (config && config.hardText) || '';
  const feedbackContext = (config && config.feedbackContext) || '';
  const feedbackRev = (config && config.feedbackRev) || 'none';
  await llmCacheReady;
  const cacheKey = MokaPersist.stableHash({
    profile, spec: jobSpec, jobJD: config.jobJD || '', jobType: config.jobType, hardText,
    model: settings.modelName,
    promptRev: MokaScore.PROMPT_VERSION, feedbackRev
  });
  // 命中缓存：没有真实模型调用，meta 标记 cacheHit 供 content 累计「缓存命中」
  if (scoreCache.has(cacheKey)) {
    return { score: scoreCache.get(cacheKey), meta: { cacheHit: true } };
  }

  // 并发 in-flight 去重：同 cacheKey 的评分已在进行中（重启/续筛竞态），
  // 直接共享同一次 LLM 调用——结果一致，且不产生第二次扣费。
  if (scoreInflight.has(cacheKey)) {
    const shared = await scoreInflight.get(cacheKey);
    return { score: shared.score, meta: { cacheHit: true, inFlightShared: true } };
  }

  const task = (async () => {
    const systemPrompt =
      '你是资深招聘专家，擅长客观评估候选人与岗位的匹配度。'
      + '严格只输出一个 JSON 对象，禁止输出任何思考过程、前言、分析说明或 markdown。'
      + '门槛 reason 控制在 40 字以内，highlights/concerns 每条不超过 30 字。';
    const userPrompt = buildDimensionPrompt(
      profile, jobSpec, config.jobType, config.jobJD, hardText, feedbackContext
    );

    // 推理型模型会先输出思考，需给足 token，避免 JSON 被截断
    const llmRes = await callLLM(settings, systemPrompt, userPrompt, { maxTokens: 4000, temperature: 0 });
    const parsed = parseDimensionResponse(llmRes.content);
    const expectedGates = []
      .concat(jobSpec.languages || [])
      .concat(jobSpec.customGates || []);
    const raw = parsed.parseError
      ? parsed
      : MokaScore.ensureBonusKeywordResults(
          MokaScore.ensureHandwrittenGateResults(parsed, expectedGates),
          jobSpec.bonusKeywords || jobSpec.niceToHaves || []
        );

    // 解析失败不写缓存，避免把错误结果固化，下一轮可重试
    if (!raw.parseError) rememberScore(cacheKey, raw);
    const llmUsage = llmRes.usage || {};
    const meta = {
      cacheHit: false,
      model: settings.modelName,
      inTok: Number(llmUsage.inTok) > 0 ? Number(llmUsage.inTok) : 0,
      outTok: Number(llmUsage.outTok) > 0 ? Number(llmUsage.outTok) : 0
    };
    return { score: raw, meta };
  })();
  scoreInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    // 无论成功失败都移除占位，保证后续（重试/换参）能重新发起
    if (scoreInflight.get(cacheKey) === task) scoreInflight.delete(cacheKey);
  }
}

/** 当前生效模型与单价（自定义价优先于内置表），供 content 端本地估算费用 */
async function getModelPriceInfo() {
  const settings = await getSettings();
  const price = MokaUsage.resolvePrice(settings.modelName, settings.modelInputPrice, settings.modelOutputPrice);
  return {
    model: settings.modelName,
    price: price
      ? { inputPerM: price.inputPerM, outputPerM: price.outputPerM, priced: true }
      : null
  };
}

/**
 * 测试 API 连接
 */
async function handleTestApi(inputSettings) {
  const settings = { ...DEFAULT_SETTINGS, ...(inputSettings || {}), ...localForcedSettings() };
  if (!settings.apiKey) {
    return { ok: false, error: '请输入 API Key' };
  }

  try {
    await callLLM(settings, '你是一个测试助手。', '回复“ok”即可。', { maxTokens: 10, forceJson: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 调用 LLM（自动按 provider 适配、带指数退避重试）
 */
async function callLLM(settings, systemPrompt, userPrompt, opts = {}) {
  const provider = settings.apiProvider || 'openai';
  const { url, headers, body } = buildRequest(provider, settings, systemPrompt, userPrompt, opts);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, LLM_TIMEOUT_MS);

      if (response.ok) {
        const data = await response.json();
        return { content: extractContent(provider, data), usage: readUsage(provider, data) };
      }

      // 429 / 5xx 可重试
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers.get('retry-after'), 10);
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`[Moka 筛选] API ${response.status}，${Math.round(waitMs)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
        addPluginLog({ cat: 'warn', text: `API HTTP ${response.status}，${Math.round(waitMs)}ms 后重试（${attempt + 1}/${MAX_RETRIES}）` });
        await sleep(waitMs);
        continue;
      }

      const errText = await safeText(response);
      throw new Error(`API 错误 ${response.status}: ${errText || response.statusText}`);
    } catch (error) {
      lastError = error;
      // 网络类错误也重试
      if (attempt < MAX_RETRIES && isRetriableNetworkError(error)) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 300);
        continue;
      }
      addPluginLog({ cat: 'err', text: 'LLM 请求失败：' + ((error && error.message) || '未知错误') });
      throw error;
    }
  }

  throw lastError || new Error('API 调用失败');
}

/**
 * 按 provider 构造请求
 */
function buildRequest(provider, settings, systemPrompt, userPrompt, opts) {
  const maxTokens = opts.maxTokens || 500;
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.7;
  const forceJson = opts.forceJson !== false; // 默认要求返回 JSON

  if (provider === 'claude') {
    return {
      url: settings.apiEndpoint || 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        // 允许在浏览器扩展中直接调用 Anthropic API
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: {
        model: settings.modelName || 'claude-3-5-sonnet-latest',
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      }
    };
  }

  // openai 与 custom（默认按 OpenAI 兼容协议处理，适配 Ollama 等本地服务）
  const body = {
    model: settings.modelName || 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens: maxTokens
  };
  // 仅官方 OpenAI 强制 JSON 输出；custom 端点未必支持，交给健壮解析兜底
  if (forceJson && provider === 'openai') {
    body.response_format = { type: 'json_object' };
  }

  return {
    url: normalizeChatEndpoint(settings.apiEndpoint),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body
  };
}

/**
 * 规范化 OpenAI 兼容的聊天补全地址。
 * 兼容用户只填基础地址（如 https://xxx/v1）的情况，自动补 /chat/completions。
 */
function normalizeChatEndpoint(endpoint) {
  if (!endpoint) return 'https://api.openai.com/v1/chat/completions';
  const url = endpoint.trim().replace(/\/+$/, '');
  // 已经是完整的补全/消息路径，原样使用
  if (/\/(chat\/completions|completions|responses|messages)$/i.test(url)) {
    return url;
  }
  // 以 /v1、/v2 等版本号结尾 → 补全 /chat/completions
  if (/\/v\d+$/i.test(url)) {
    return url + '/chat/completions';
  }
  // 其余情况原样使用（尊重用户自定义的完整路径）
  return url;
}

/**
 * 从不同 provider 的响应中取出文本内容
 */
function extractContent(provider, data) {
  if (provider === 'claude') {
    if (Array.isArray(data.content)) {
      return data.content.map((c) => c.text || '').join('');
    }
    return '';
  }
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * 从响应里读 token 用量（OpenAI 兼容: prompt_tokens/completion_tokens；Claude: input_tokens/output_tokens）。
 * 自定义/本地端点常不带 usage，返回 null（调用方仍计入「真实调用一次」，token 计 0）。
 */
function readUsage(provider, data) {
  if (!data || typeof data !== 'object') return null;
  const u = data.usage;
  if (!u || typeof u !== 'object') return null;
  if (provider === 'claude') {
    const inTok = Number(u.input_tokens) > 0 ? Number(u.input_tokens) : 0;
    const outTok = Number(u.output_tokens) > 0 ? Number(u.output_tokens) : 0;
    return (inTok || outTok) ? { inTok, outTok } : null;
  }
  const inTok = Number(u.prompt_tokens) > 0 ? Number(u.prompt_tokens) : 0;
  const outTok = Number(u.completion_tokens) > 0 ? Number(u.completion_tokens) : 0;
  return (inTok || outTok) ? { inTok, outTok } : null;
}

const JOB_TYPE_TEXT = {
  'full-time': '正式员工（看重完整工作经验与稳定性）',
  intern: '实习生（看重学习能力、专业相关性与可实习时长）'
};

const DIM_DESC = [
  '- experience 经验相关性：过往主责/对口实习与该岗位核心职责是否同方向；相邻职能擦边不能打成对口',
  '- skill 技能匹配：候选人是否具备该岗位所需的关键技能/工具',
  '- education 专业与教育背景：学历是否达标为主；专业不完全对口时不要打到低分档',
  '- potential 潜力/稳定性/加分项：成长性、稳定性、JD 中的加分项'
].join('\n');

/**
 * JD 解读提示词
 */
function buildJDAnalysisPrompt(jobJD, jobType) {
  return `请解读以下职位 JD，提炼岗位画像，并对四个「固定评分维度」给出建议权重。

【职位类型】
${JOB_TYPE_TEXT[jobType] || JOB_TYPE_TEXT['full-time']}

【职位 JD】
${jobJD || '（未提供 JD）'}

四个固定评分维度：
${DIM_DESC}

要求：
1. summary：恰好两句话，连贯可读。
   - 第一句：概括该岗位主要在做什么（场景与产出）。
   - 第二句：概括做好这份工作需要具备的关键能力（如英语沟通、PS/AI 等工具、业务经验方向）；用「需要具备…」或「要求…」起句均可，举 2–4 个要点收成一句，不要另起清单。
2. responsibilities：列出 3-6 条核心职责。
3. mustHaves：按 JD 写「必须/需/要求」的硬门槛，最多 6 条。
4. importantHaves：JD 写「优先/熟悉/有相关更好」的重要项，最多 6 条。
${MokaScore.mustHaveExtractionGuide()}
5. niceToHaves：加分项，最多 5 条。
6. resumeKeywords：按重要性列出最多 6 个可在简历中检索的关键词（技能/工具/岗位缩写，如 HRBP、Excel）。
7. suggestedWeights：给出四个维度的建议权重（整数、合计恰好 100），要体现该岗位最看重什么（例如强执行/经验型岗位 experience 权重更高；校招/实习岗 potential 与 education 权重更高）。
只返回以下 JSON，不要输出多余文字：
{
  "summary": "第一句做什么。第二句需要具备的能力。",
  "responsibilities": ["..."],
  "mustHaves": ["..."],
  "importantHaves": ["..."],
  "niceToHaves": ["..."],
  "resumeKeywords": ["..."],
  "suggestedWeights": {"experience": 40, "skill": 30, "education": 20, "potential": 10}
}`;
}

/**
 * 把 JD 画像渲染成给评分用的文本
 */
function renderSpec(spec) {
  const lines = [];
  if (spec.summary) lines.push('岗位概述：' + spec.summary);
  if (Array.isArray(spec.responsibilities) && spec.responsibilities.length) {
    lines.push('核心职责（要做什么）：\n- ' + spec.responsibilities.join('\n- '));
  }
  if (Array.isArray(spec.coreSkills) && spec.coreSkills.length) {
    lines.push('核心技能：\n- ' + spec.coreSkills.join('\n- '));
  }
  if (Array.isArray(spec.candidateTraits) && spec.candidateTraits.length) {
    lines.push('候选人素质：\n- ' + spec.candidateTraits.join('\n- '));
  }
  const focus = Array.isArray(spec.focusKeywords) ? spec.focusKeywords : spec.importantHaves;
  const bonus = Array.isArray(spec.bonusKeywords) ? spec.bonusKeywords : spec.niceToHaves;
  if (Array.isArray(focus) && focus.length) lines.push('重点看：\n- ' + focus.join('\n- '));
  if (Array.isArray(bonus) && bonus.length) lines.push('加分看：\n- ' + bonus.join('\n- '));
  return lines.join('\n\n') || '（无岗位画像，请依据 JD 常识判断）';
}

/**
 * 候选人「分维度」评分提示词
 */
function buildDimensionPrompt(profile, spec, jobType, jobJD, hardText, feedbackContext) {
  const hasSpec = spec && (spec.summary || (spec.responsibilities && spec.responsibilities.length)
    || (spec.mustHaves && spec.mustHaves.length) || (spec.importantHaves && spec.importantHaves.length));
  const jobBlock = hasSpec ? renderSpec(spec) : (jobJD || '（无岗位信息）');
  const feedbackBlock = MokaFeedback.feedbackPromptBlock(feedbackContext);
  const feedbackSection = feedbackBlock ? `\n${feedbackBlock}\n` : '';
  const handwrittenGates = []
    .concat((spec && spec.languages) || [])
    .concat((spec && spec.customGates) || []);
  const focusKeywords = (spec && (spec.focusKeywords || spec.importantHaves)) || [];
  const bonusKeywords = (spec && (spec.bonusKeywords || spec.niceToHaves)) || [];
  const scoringRules = MokaScore.matchScoringPromptBlock(
    jobType,
    handwrittenGates,
    focusKeywords,
    bonusKeywords
  );

  return `请先根据简历归纳经历证据，再对照岗位与重点看评估匹配，并逐条核对手写硬性门槛。禁止跳过经历阅读直接打分。

【候选人完整信息】
${profile || '（无候选人信息）'}

【岗位信息】
${jobBlock}
${feedbackSection}【职位类型】
${JOB_TYPE_TEXT[jobType] || JOB_TYPE_TEXT['full-time']}

${scoringRules}

  仅依据候选人信息判断，逐条阅读每段经历（含实习、项目）的具体描述；尽量在理由中引用具体证据。
  experienceEvidence 只写与岗位职责/重点看直接相关的经历证据，与岗位无关的经历不要写入；
  highlights 只写与 JD 职责/重点看对应的亮点，格式「能力点＋简历对应证据」，不要罗列与岗位无关的泛泛优点。
  只返回以下 JSON，不要输出多余文字：
{
  "experienceEvidence": ["与岗位职责直接相关的经历证据"],
  "matchScore": 0,
  "handwrittenGateResults": [{"item": "日语 N1", "met": false, "reason": "简历未提及日语能力"}],
  "bonusKeywordResults": [{"item": "作品集", "met": true, "reason": "简历附有可核对作品集"}],
  "highlights": ["亮点1", "亮点2"],
  "concerns": ["主要差距1", "主要差距2"]
}`;
}

/** 去掉推理块与代码围栏 */
function stripThink(content) {
  if (!content || typeof content !== 'string') return '';
  let text = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1];
  return text;
}

function arrOf(x, max = 6) {
  if (typeof x === 'string') x = [x];
  if (!Array.isArray(x)) return [];
  return x.map((s) => String(s)).filter(Boolean).slice(0, max);
}

const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
const DEFAULT_WEIGHTS = { experience: 40, skill: 30, education: 20, potential: 10 };

/** 归一化权重为整数、合计 100 */
function normalizeWeights(w, def = DEFAULT_WEIGHTS) {
  let vals = WEIGHT_KEYS.map((k) => {
    const n = Number(w && w[k]);
    return Number.isFinite(n) && n >= 0 ? n : def[k];
  });
  let sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) { vals = WEIGHT_KEYS.map((k) => def[k]); sum = 100; }
  const scaled = vals.map((v) => Math.round((v / sum) * 100));
  const diff = 100 - scaled.reduce((a, b) => a + b, 0);
  scaled[0] += diff; // 把舍入误差并到第一个维度
  const out = {};
  WEIGHT_KEYS.forEach((k, i) => { out[k] = Math.max(0, scaled[i]); });
  return out;
}

/**
 * 解析 JD 解读结果
 */
function parseJDAnalysis(content) {
  const text = stripThink(content);
  const objs = findAllJsonObjects(text);
  // 与侧栏同一把尺子：只回了权重、没有任何岗位内容的 JSON 不算解读成功
  const usable = (p) => MokaPersist.jobSpecIsUsable(p);
  let best = null;
  let parsedAnyJson = false;
  for (const c of objs) {
    const p = tryParseJson(c);
    if (p) parsedAnyJson = true;
    if (usable(p)) {
      best = p;
      break;
    }
  }
  // JD 输出比评分长，更容易撞上输出上限；截断的 JSON 先补齐再解析
  if (!best) {
    const repaired = tryParseJson(repairTruncatedJson(text));
    if (usable(repaired)) best = repaired;
  }
  if (!best) {
    // JSON 本身是好的、只是没有岗位字段，别报成「不是 JSON」误导用户
    const kind = parsedAnyJson ? 'missing-field' : MokaScore.classifyLlmJsonFailure(text, null);
    return {
      summary: '', responsibilities: [], coreSkills: [], candidateTraits: [],
      mustHaves: [], importantHaves: [], niceToHaves: [],
      resumeKeywords: [], suggestedWeights: { ...DEFAULT_WEIGHTS },
      parseError: true,
      parseFailureKind: kind,
      parseErrorMessage: MokaScore.jdParseFailureMessage(kind)
    };
  }
  return {
    summary: best.summary ? String(best.summary) : '',
    responsibilities: arrOf(best.responsibilities, 8),
    coreSkills: arrOf(best.coreSkills, 6),
    candidateTraits: arrOf(best.candidateTraits, 6),
    mustHaves: arrOf(best.mustHaves, 6),
    importantHaves: arrOf(best.importantHaves, 6),
    niceToHaves: arrOf(best.niceToHaves, 5),
    resumeKeywords: arrOf(best.resumeKeywords, 6),
    suggestedWeights: normalizeWeights(best.suggestedWeights)
  };
}

/**
 * 解析候选人分维度评分结果
 */
function parseDimensionResponse(content) {
  const text = stripThink(content);
  const objs = findAllJsonObjects(text);
  let best = null;
  for (const c of objs) {
    const p = tryParseJson(c);
    if (p && (p.matchScore != null || p.dimensions)) { best = p; break; }
  }
  // 兜底 1：JSON 被截断（花括号未闭合）→ 尝试修复后再解析
  if (!best) {
    const repaired = tryParseJson(repairTruncatedJson(text));
    if (repaired && (repaired.matchScore != null || repaired.dimensions)) best = repaired;
  }
  // 兜底 2：仍失败 → 用正则宽松抽取各维度分数/理由（能救多少救多少）
  if (!best) {
    const loose = looseExtractDimensions(text);
    if (loose) {
      best = { dimensions: loose, mustHaveResults: [], highlights: [], concerns: looseExtractArray(text, 'concerns') };
    }
  }
  if (!best) {
    const kind = MokaScore.classifyLlmJsonFailure(text, null);
    const fail = MokaScore.scoreErrorResult(MokaScore.scoreParseFailureMessage(kind));
    fail.parseFailureKind = kind;
    fail.concerns = [fail.error, '原文片段: ' + text.slice(0, 80)];
    return fail;
  }
  if (best.dimensions) {
    const dim = (k) => {
      const o = (best.dimensions && best.dimensions[k]) || {};
      return { score: clampScore(o.score), reason: o.reason ? String(o.reason) : '' };
    };
    best.dimensions = {
      experience: dim('experience'),
      skill: dim('skill'),
      education: dim('education'),
      potential: dim('potential')
    };
  }
  return MokaScore.normalizeModelScoreResponse(best);
}

function tryParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * 修复被截断的 JSON：从首个 '{' 起，回退到「最后一个完整键值对」的位置，
 * 再补齐未闭合的字符串与括号，尽量得到可解析的对象。
 */
function repairTruncatedJson(text) {
  if (!text) return '';
  const start = text.indexOf('{');
  if (start === -1) return '';
  const s = text.slice(start);

  let inString = false;
  let escape = false;
  const stack = [];
  let lastPairEnd = -1; // 顶层/各层「刚结束一个值」的安全切点（位于逗号或闭合括号处）

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { if (stack.length) stack.pop(); lastPairEnd = i; }
    else if (ch === ',') lastPairEnd = i - 1; // 逗号前是一个完整值的结尾
  }

  // 情况 A：正好在字符串中被截断 —— 回退到最后一个完整键值对
  let body;
  if (inString) {
    if (lastPairEnd >= 0) body = s.slice(0, lastPairEnd + 1);
    else return '';
  } else {
    // 情况 B：结构中截断 —— 若末尾是不完整片段（如 "key": ），回退到安全切点
    body = s;
    const tail = body.replace(/\s+$/, '');
    if (/[:,]\s*$/.test(tail) || /"[^"]*$/.test(tail)) {
      if (lastPairEnd >= 0) body = s.slice(0, lastPairEnd + 1);
    }
  }

  // 重新计算需要补齐的闭合括号
  const stack2 = [];
  let inStr2 = false;
  let esc2 = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr2) {
      if (esc2) esc2 = false;
      else if (ch === '\\') esc2 = true;
      else if (ch === '"') inStr2 = false;
      continue;
    }
    if (ch === '"') { inStr2 = true; continue; }
    if (ch === '{' || ch === '[') stack2.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { if (stack2.length) stack2.pop(); }
  }
  let repaired = body.replace(/[,\s]+$/, '');
  while (stack2.length) repaired += stack2.pop();
  return repaired;
}

/** 正则宽松抽取四个维度的 score/reason（容忍 JSON 截断/前置文字） */
function looseExtractDimensions(text) {
  if (!text) return null;
  const out = {};
  let hit = false;
  ['experience', 'skill', 'education', 'potential'].forEach((k) => {
    const re = new RegExp('"' + k + '"\\s*:\\s*\\{[\\s\\S]*?"score"\\s*:\\s*(\\d+)(?:[\\s\\S]*?"reason"\\s*:\\s*"([^"]*)")?', 'i');
    const m = text.match(re);
    if (m) {
      out[k] = { score: clampScore(m[1]), reason: m[2] ? String(m[2]) : '' };
      hit = true;
    } else {
      out[k] = { score: 50, reason: '' };
    }
  });
  return hit ? out : null;
}

/** 宽松抽取字符串数组字段（如 concerns/highlights），失败返回空数组 */
function looseExtractArray(text, key) {
  if (!text) return [];
  const m = text.match(new RegExp('"' + key + '"\\s*:\\s*\\[([\\s\\S]*?)\\]', 'i'));
  if (!m) return [];
  const items = m[1].match(/"([^"]*)"/g) || [];
  return items.map((s) => s.replace(/^"|"$/g, '')).filter(Boolean).slice(0, 6);
}

/**
 * 扫描出文本中所有「平衡」的 JSON 对象子串（正确处理字符串内的花括号）。
 */
function findAllJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function isRetriableNetworkError(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true; // fetch 网络失败通常是 TypeError
  const msg = String(error.message || '');
  // 超时后允许有限次重试（瞬时卡顿）
  if (error.name === 'AbortError' || /请求超时/.test(msg)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('mokaSettings', (result) => {
      // 本地私有配置优先级最高，强制覆盖 provider/endpoint/model
      resolve({ ...DEFAULT_SETTINGS, ...(result.mokaSettings || {}), ...localForcedSettings() });
    });
  });
}

// 初始化默认设置
chrome.storage.local.get('mokaSettings', (result) => {
  if (!result.mokaSettings) {
    storeSet({ mokaSettings: DEFAULT_SETTINGS }, 'default-settings').then(() => {
      console.log('[Moka 筛选] 已初始化默认设置');
    });
  }
});

console.log('[Moka 筛选] Background service worker 初始化完成');
