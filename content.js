/**
 * Moka 智能简历筛选 - Content Script
 *
 * 架构：纯接口驱动 + 原样重放。
 *  1. inject.js（MAIN world）捕获 Moka 自己发出的 search-candidate 请求模板
 *  2. content.js 用该模板「原样重放」并做游标分页，拉取全部候选人（可上百/上千）
 *  3. 逐个交给 background 做 AI 评分（外部 API 调用在后台完成，规避 CSP）
 *  4. 把可展示的结果快照推到侧栏，按 AI 得分排序；点卡片由本脚本打开候选人
 */

const SEARCH_API_FALLBACK = '/api/outer/ats-candidate-search-left/candidate/search-candidate/v2';
const CONCURRENCY = 4;
const DEFAULT_LIMIT = 30;
const MAX_PAGES = 300; // 安全上限：300 页 × 30 ≈ 9000 人
const MOKA_TIMEOUT_MS = 25000;

/** fetch + 超时 */
async function fetchWithTimeout(url, options = {}, timeoutMs = MOKA_TIMEOUT_MS) {
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

let isScreening = false;
let screeningEpoch = 0;
let screeningHeartbeat = 0; // 最近一次筛选活动时间；用于识别「卡死的旧任务」

function touchScreeningHeartbeat() {
  screeningHeartbeat = Date.now();
}

/** 真正可信的「筛选进行中」：既要标志位为真，也要近期有活动 */
function screeningLooksActive() {
  return MokaScreeningJob.screeningLooksActive(isScreening, screeningHeartbeat, Date.now());
}
let results = []; // { app, profile, jobJD, rawScore, waivedMustHaves, score, hard, keywords, stage }
let sortTimer = null;
let activeWeights = null; // 本轮归一化权重，供忽略自增硬性后重排
let lastScreenConfig = null; // 供单人重评 / 回看后重评
let lastKnownPipelineId = ''; // 离开列表页后仍用于 storage 键
let lastKnownJobName = ''; // 离开列表页后仍显示左侧职位名
let lastRestoredSavedAt = null;
let activeScreeningJob = null; // 本轮进行中的筛选任务快照
let lastUiStatus = '';
let lastBanner = null; // { type: 'need-click' | 'ready' } | null
let lastListUrl = '';
let mokaActionBusy = false;
/** 从写入 pending 到 clear 之前为 true，防止换岗监听在跳转详情页时打断推荐/淘汰 */
let mokaActionActive = false;

// 捕获到的 Moka 真实请求模板（来自 inject.js）
let capturedRequest = null;        // 列表搜索请求
let capturedDetailRequest = null;  // 「返回含经历」的详情请求模板（含 scene 令牌）
let harvestedScene = '';           // 从任意带 scene= 的页面请求里收割
let lastProbeReason = '';
const detailDataCache = new Map(); // id(string) -> 已含经历的详情响应 JSON（页面已加载过的候选人可直接复用）

// 尽早监听，避免错过 inject.js 的早期推送
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'moka-inject') return;
  if (data.type === 'search-request') {
    capturedRequest = data.payload;
    persistCapture();
    // 开筛分页会触发大量 search-request，避免刷换岗通知打断筛选
    if (!isScreening) maybeNotifyPageJobChanged('search-capture');
  } else if (data.type === 'detail-request') {
    const first = !capturedDetailRequest;
    capturedDetailRequest = data.payload;
    persistCapture();
    if (first) { try { markDetailBannerReady(); } catch (e) {} } // 用户点开候选人后，横幅变为「已就绪」
  } else if (data.type === 'detail-data') {
    cacheDetailData(data.payload);
  } else if (data.type === 'scene-token') {
    const s = data.payload && data.payload.scene;
    if (s) harvestedScene = String(s);
  }
});

function persistCapture() {
  try {
    chrome.storage.local.set({
      [MokaCapture.CAPTURE_STORAGE_KEY]: { search: capturedRequest, detail: capturedDetailRequest }
    });
  } catch (e) { /* ignore */ }
}

function restoreCapture() {
  return new Promise((resolve) => {
    const done = () => resolve();
    try {
      chrome.storage.local.get(MokaCapture.CAPTURE_STORAGE_KEY, (result) => {
        try {
          if (chrome.runtime.lastError) {
            done();
            return;
          }
          const stored = result && result[MokaCapture.CAPTURE_STORAGE_KEY];
          const merged = MokaCapture.mergeCapture(
            { search: capturedRequest, detail: capturedDetailRequest },
            stored
          );
          capturedRequest = merged.search;
          capturedDetailRequest = merged.detail;
        } catch (e) {
          console.warn('[Moka 筛选] restoreCapture:', e);
        }
        done();
      });
    } catch (e) {
      done();
    }
  });
}

const captureReady = restoreCapture();

/** 缓存单个候选人的详情响应，严格按 URL 里的 application id + 顶层 id/candidateId 建索引 */
function cacheDetailData(payload) {
  if (!payload || !payload.text) return;
  try {
    const json = MokaCapture.unwrapDetailJson(JSON.parse(payload.text));
    const keys = new Set();
    // URL 里的 application id 是最可靠主键：/api/applications/{id}
    const m = String(payload.url || '').match(/\/applications\/(\d+)/);
    if (m) keys.add(m[1]);
    // 顶层 id/candidateId（详情根节点直接持有，避免 deepFind 取到嵌套 id 造成串号）
    if (json && json.id != null) keys.add(String(json.id));
    if (json && json.candidateId != null) keys.add(String(json.candidateId));
    keys.forEach((k) => detailDataCache.set(k, json));
    if (detailDataCache.size > 500) {
      const firstKey = detailDataCache.keys().next().value;
      detailDataCache.delete(firstKey);
    }
  } catch (e) { /* ignore */ }
}

/** 校验详情 JSON 确实属于该候选人，防止串号 */
function detailBelongsTo(app, json) {
  return MokaCapture.detailBelongsTo(app, json);
}

function currentScene() {
  return harvestedScene
    || MokaCapture.extractSceneToken(
      location.href,
      location.hash,
      capturedDetailRequest && capturedDetailRequest.url,
      capturedRequest && capturedRequest.url,
      capturedRequest && capturedRequest.body
    )
    || sceneFromWebStorage();
}

function sceneFromWebStorage() {
  try {
    for (const store of [sessionStorage, localStorage]) {
      const n = store.length;
      for (let i = 0; i < n; i++) {
        const k = store.key(i);
        if (!k) continue;
        let v = '';
        try { v = store.getItem(k) || ''; } catch (e) { continue; }
        if (!v || v.length > 40000) continue;
        if (!/scene/i.test(k) && v.indexOf('scene') === -1) continue;
        const s = MokaCapture.extractSceneToken(k, v);
        if (s) return s;
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}
// 主动索要一次（防止 content 晚于首个请求）
try {
  window.postMessage({ source: 'moka-content', type: 'get-search-request' }, '*');
  window.postMessage({ source: 'moka-content', type: 'get-detail-request' }, '*');
} catch (e) { /* ignore */ }

// init() 放在文件末尾调用：这里的 let/const 模块级变量必须全部初始化完成，
// 否则 init 里同步调用的函数会命中 TDZ，整个顶层脚本中断（后半段声明全部失效）
function init() {
  console.log('[Moka 筛选] Content script 已加载');
  const leftover = document.getElementById('moka-panel');
  if (leftover) leftover.remove();
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ ok: true });
    } else if (request.action === 'getJobs') {
      const respond = () => respondGetJobs(sendResponse);
      if (getCurrentJobs().length) respond();
      else {
        restoreResultsSilently().then(respond);
      }
      return true;
    } else if (request.action === 'getJobContext') {
      getJobContext()
        .then((autofill) => sendResponse(autofill
          ? { autofill, ok: true }
          : {
            autofill: null,
            ok: false,
            error: '无法获取 JD：请回到候选人列表页后再点预填（详情页需先在列表加载过）'
          }))
        .catch((err) => sendResponse({
          autofill: null,
          ok: false,
          error: (err && err.message) || '读取 JD 失败'
        }));
      return true; // 异步
    } else if (request.action === 'getJobSpec') {
      getJobSpec(request.jobType)
        .then((spec) => sendResponse(spec
          ? { spec, ok: true }
          : {
            spec: null,
            ok: false,
            error: '无法解读 JD：请回到候选人列表页，确认 API Key，或先跑一轮筛选后再点'
          }))
        .catch((err) => sendResponse({
          spec: null,
          ok: false,
          error: (err && err.message) || '解读 JD 失败'
        }));
      return true; // 异步
    } else if (request.action === 'startScreening') {
      try {
        // 只有「近期仍在活动」的任务才拦截；卡死的旧任务一律允许接管
        if (screeningLooksActive() && !request.force) {
          sendResponse({ ok: false, error: '正在筛选中' });
          return false;
        }
        const epoch = ++screeningEpoch;
        isScreening = true;
        touchScreeningHeartbeat();
        performScreening(request, epoch).catch((err) => {
          console.error('[Moka 筛选] performScreening 异常:', err);
        }).finally(() => {
          if (epoch === screeningEpoch) {
            isScreening = false;
            publishResults(undefined, undefined, { flush: true });
          }
        });
        sendResponse({ ok: true });
      } catch (err) {
        // 绝不能让消息通道无响应关闭，否则侧栏只会看到「无法连接页面」
        isScreening = false;
        console.error('[Moka 筛选] startScreening 失败:', err);
        sendResponse({ ok: false, error: (err && err.message) || '启动筛选失败' });
      }
      return false;
    } else if (request.action === 'resumeScreening') {
      if (isScreening) {
        sendResponse({ ok: false, error: '正在筛选中' });
        return true;
      }
      resumeScreeningFromJob()
        .then((result) => sendResponse(result || { ok: true }))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || '续筛失败' }));
      return true;
    } else if (request.action === 'discardScreeningJob') {
      discardScreeningJob()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    } else if (request.action === 'getScreeningJob') {
      loadScreeningJob().then((job) => sendResponse({ job }))
        .catch(() => sendResponse({ job: null }));
      return true;
    } else if (request.action === 'stopScreening') {
      screeningEpoch += 1;
      isScreening = false;
      screeningHeartbeat = 0;
      finishScreeningJob('stopped');
      sendResponse({ ok: true });
      return false;
    } else if (request.action === 'screeningKeepalivePing') {
      sendResponse({ ok: true, screening: isScreening });
      if (isScreening) checkScreeningJobMismatch();
      return false;
    } else if (request.action === 'hasLastResults') {
      hasLastResults()
        .then((meta) => sendResponse(meta))
        .catch(() => sendResponse({ has: false }));
      return true;
    } else if (request.action === 'showLastResults') {
      restoreLastResults()
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    } else if (request.action === 'getResults') {
      const finish = async () => {
        await alignResultsForPageJob();
        sendResponse(buildResultsSnapshot());
      };
      finish();
      return true;
    } else if (request.action === 'openCandidate') {
      sendResponse({ ok: openCandidate(request.appId) });
    } else if (request.action === 'exportCsv') {
      exportResultsCsv(request.feedbackByAppId);
      sendResponse({ ok: true });
    } else if (request.action === 'rescore') {
      handleRescore(request.appId)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || '重评失败' }));
      return true;
    } else if (request.action === 'waiveMustHave') {
      handleWaiveMustHave(request.appId, request.item, !!request.waived)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || '操作失败' }));
      return true;
    } else if (request.action === 'mokaAction') {
      handleMokaAction(request.appId, request.type)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Moka 操作失败' }));
      return true;
    } else if (request.action === 'resumeMokaAction') {
      resumePendingMokaAction()
        .then((result) => sendResponse(result || { ok: true }))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || '恢复操作失败' }));
      return true;
    }
    return true;
  });
  captureReady.then(() => {
    bootstrapResultsIfEmpty().catch(() => {});
    offerResumeIfNeeded().catch(() => {});
  });
  resumePendingMokaAction().catch((e) => console.warn('[Moka 筛选] resume pending action:', e));
  startPageContextWatch();
  notifyContentReady();
}

function notifyContentReady() {
  try {
    chrome.runtime.sendMessage({
      action: 'mokaContentReady',
      url: location.href
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ---------------- 页面职位变化（SPA 换岗） ---------------- */

let lastPageContextKey = '';
let pageContextWatchTimer = null;
let pageJobNotifyTimer = null;

function pageContextKey() {
  const ctx = parsePageContext();
  const pipelineId = (ctx && ctx.pipelineId) || lastKnownPipelineId || '';
  const jobId = pageJobIdFromContext();
  if (!pipelineId && !jobId) return 'path:' + location.pathname + location.search;
  // 只用 pipeline + jobId；title 变化不应触发整表重置
  return [String(pipelineId), String(jobId)].join('|');
}

function notifyPageJobChanged(reason) {
  const pageJobId = pageJobIdFromContext();
  try {
    chrome.runtime.sendMessage({
      action: 'pageJobChanged',
      pageJobId,
      jobName: resolveJobDisplayName(pageJobId) || lastKnownJobName || '',
      url: location.href,
      reason: reason || 'url'
    }).catch(() => {});
  } catch (e) { /* ignore */ }
  alignResultsForPageJob().catch(() => {});
}

function maybeNotifyPageJobChanged(reason) {
  // 筛选 / 推荐·淘汰自动化进行中：URL 变化是预期跳转，不能当成换岗
  if (isScreening || mokaActionActive || mokaActionBusy) return;
  const key = pageContextKey();
  if (key === lastPageContextKey) return;
  const hadPrev = !!lastPageContextKey;
  lastPageContextKey = key;
  if (!hadPrev) return; // 首次种子，不刷侧栏
  clearTimeout(pageJobNotifyTimer);
  pageJobNotifyTimer = setTimeout(() => {
    pageJobNotifyTimer = null;
    notifyPageJobChanged(reason);
  }, 120);
}

function startPageContextWatch() {
  lastPageContextKey = pageContextKey();
  window.addEventListener('popstate', () => maybeNotifyPageJobChanged('popstate'));
  // 不用 patch history：isolated world 补丁不可靠，且可能干扰页面；靠 poll 即可
  if (pageContextWatchTimer) clearInterval(pageContextWatchTimer);
  pageContextWatchTimer = setInterval(() => maybeNotifyPageJobChanged('poll'), 1500);
}

/* ---------------- 页面上下文 ---------------- */

function parsePageContext() {
  const params = new URLSearchParams(location.search);
  const pipelineId = params.get('pipelineId');
  if (!pipelineId) return null;

  const jobIds = [];
  params.forEach((value, key) => { if (/^jobIds(\[\d+\])?$/.test(key)) jobIds.push(value); });

  return { pipelineId, jobIds, title: params.get('title') || '' };
}

function parseJobTitleFromUrl(url) {
  if (!url) return '';
  try {
    const t = new URL(url, location.origin).searchParams.get('title');
    return t ? safeDecode(t) : '';
  } catch (e) {
    return '';
  }
}

function resolveJobDisplayName(jobId) {
  const ctx = parsePageContext();
  if (ctx && ctx.title) return safeDecode(ctx.title);
  const fromList = parseJobTitleFromUrl(lastListUrl);
  if (fromList) return fromList;
  if (lastScreenConfig && lastScreenConfig.jobName) return lastScreenConfig.jobName;
  if (lastKnownJobName) return lastKnownJobName;
  const id = String(jobId || (lastScreenConfig && lastScreenConfig.jobId) || '');
  if (id && id !== 'current') return `职位 ${id.slice(0, 8)}`;
  return '';
}

function getCurrentJobs() {
  const ctx = parsePageContext();
  const pageJobId = pageJobIdFromContext();
  if (pageJobId) {
    const name = resolveJobDisplayName(pageJobId) || `职位 ${pageJobId.slice(0, 8)}`;
    if (name) lastKnownJobName = name;
    return [{ id: pageJobId, name }];
  }
  if (ctx && ctx.jobIds.length > 0) {
    const name = resolveJobDisplayName(ctx.jobIds[0]) || `职位 ${ctx.jobIds[0].slice(0, 8)}`;
    if (name) lastKnownJobName = name;
    return [{ id: ctx.jobIds[0], name }];
  }
  if (lastScreenConfig && lastScreenConfig.jobId) {
    const name = resolveJobDisplayName(lastScreenConfig.jobId)
      || `职位 ${String(lastScreenConfig.jobId).slice(0, 8)}`;
    return [{ id: lastScreenConfig.jobId, name }];
  }
  if (capturedRequest) {
    let jobId = 'current';
    try {
      const body = JSON.parse(capturedRequest.body || '{}');
      if (body.jobIds && body.jobIds[0]) jobId = String(body.jobIds[0]);
    } catch (e) { /* ignore */ }
    const name = resolveJobDisplayName(jobId);
    if (name) return [{ id: jobId, name }];
    return [{ id: jobId, name: '当前列表候选人' }];
  }
  return [];
}

async function resolveJobNameFromApi() {
  try {
    const app = await fetchOneApplication();
    const title = app && app.job && app.job.title;
    if (!title) return '';
    lastKnownJobName = String(title);
    if (lastScreenConfig) {
      lastScreenConfig = Object.assign({}, lastScreenConfig, { jobName: lastKnownJobName });
    }
    return lastKnownJobName;
  } catch (e) {
    return '';
  }
}

async function respondGetJobs(sendResponse) {
  let jobs = getCurrentJobs();
  if (
    jobs.length === 1
    && jobs[0].id !== 'current'
    && (/^职位\s/.test(jobs[0].name) || jobs[0].name === '当前列表候选人')
  ) {
    const apiName = await resolveJobNameFromApi();
    if (apiName) jobs = [{ id: jobs[0].id, name: apiName }];
  }
  const ctx = parsePageContext();
  const pageJobId = pageJobIdFromContext();
  const jobId = (lastScreenConfig && lastScreenConfig.jobId) || (jobs[0] && jobs[0].id) || '';
  const jobName = (jobs[0] && jobs[0].name) || resolveJobDisplayName(jobId) || '';
  if (jobName) lastKnownJobName = jobName;
  sendResponse({ jobs, jobId, jobName, pageJobId });
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/* ---------------- 接口调用（原样重放 + 游标分页） ---------------- */

async function fetchAllApplications(onProgress, maxCount = 0, epoch) {
  await captureReady;
  if (!capturedRequest) {
    // 再问一次，给 inject 一点时间
    try { window.postMessage({ source: 'moka-content', type: 'get-search-request' }, '*'); } catch (e) {}
    await sleep(400);
  }

  const url = capturedRequest?.url || SEARCH_API_FALLBACK;
  const headers = { 'Content-Type': 'application/json', ...(capturedRequest?.headers || {}) };

  // 基础请求体：优先用捕获到的真实 body，保证 ownManagerIdList 等用户态字段完整
  let baseBody = {};
  if (capturedRequest?.body) {
    try { baseBody = JSON.parse(capturedRequest.body); } catch (e) { baseBody = {}; }
  }
  const searchCtx = resolveSearchContext();
  if (!baseBody.pipelineId && searchCtx.pipelineId) {
    baseBody.pipelineId = Number(searchCtx.pipelineId) || searchCtx.pipelineId;
  }
  // 开筛必须跟当前页职位，避免沿用上一岗捕获 body 里的旧 jobIds
  if (searchCtx.jobIds && searchCtx.jobIds.length) {
    baseBody.jobIds = searchCtx.jobIds.slice();
  } else if (!baseBody.pipelineId) {
    const ctx = parsePageContext();
    if (ctx) {
      baseBody = { ...baseBody, pipelineId: Number(ctx.pipelineId) || ctx.pipelineId, jobIds: ctx.jobIds };
    }
  }

  // 每页尽量多拉（提到 100，单页即可超过默认 30）；有目标人数时不超过它
  let limit = Math.max(baseBody.limit || DEFAULT_LIMIT, 50);
  limit = Math.min(limit, 100);
  if (maxCount > 0) limit = Math.min(limit, Math.max(maxCount, DEFAULT_LIMIT));

  const all = [];
  const seen = new Set();
  let cursor = null;
  const alive = () => isScreening && (epoch == null || epoch === screeningEpoch);

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!alive()) break;

    const body = MokaCapture.buildSearchPageBody(baseBody, limit, cursor);

    const resp = await fetchWithTimeout(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    if (!alive()) break;
    if (!resp.ok) throw new Error(`候选人接口错误: ${resp.status}`);

    const json = await resp.json();
    const data = json.data || {};
    const apps = data.applications || [];

    let added = 0;
    for (const app of apps) {
      if (app && app.id != null && !seen.has(app.id)) {
        seen.add(app.id);
        all.push(app);
        added++;
      }
    }

    if (onProgress) onProgress(all.length);

    // 达到目标人数即停止
    if (maxCount > 0 && all.length >= maxCount) break;

    // 停止条件：没有更多 / 本页无新增 / 拿不到下一页游标
    if (!data.hasMore || added === 0 || !data.lastCursor) break;
    cursor = data.lastCursor;
  }

  return maxCount > 0 ? all.slice(0, maxCount) : all;
}

/** 轻量拉取一条候选人，用其 job 字段做硬条件预填 */
async function getJobContext() {
  const app = await fetchOneApplication();
  if (app && app.job) return autofillFromJob(app.job);
  // 兜底：本轮/上次筛选里已有候选人与 JD
  const cached = results.find((r) => r && r.app && r.app.job) || results[0];
  if (cached && cached.app && cached.app.job) return autofillFromJob(cached.app.job);
  if (lastScreenConfig && lastScreenConfig.jobJD) {
    const parsed = MokaMatch.extractHardAutofillFromText(lastScreenConfig.jobJD);
    parsed.majors = extractMajorsFromText(lastScreenConfig.jobJD);
    return parsed;
  }
  return null;
}

/** 解读当前职位 JD，返回岗位画像 + 建议权重（供 popup 预填滑块） */
async function getJobSpec(jobType) {
  const type = jobType || 'full-time';
  let jobJD = '';
  const app = await fetchOneApplication();
  if (app) jobJD = buildJobJD(app);
  if (!jobJD && lastScreenConfig && lastScreenConfig.jobJD) {
    const pageJob = pageJobIdFromContext();
    if (!pageJob || !lastScreenConfig.jobId || String(pageJob) === String(lastScreenConfig.jobId)) {
      jobJD = lastScreenConfig.jobJD;
    }
  }
  if (!jobJD) {
    const cached = results.find((r) => r && r.app) || null;
    if (cached) jobJD = buildJobJD(cached.app);
  }
  if (!jobJD) return null;
  const spec = await analyzeJobViaBackground(jobJD, type);
  // 解析失败的空壳不能当成功往上传：侧栏会显示空理解，还会把清单整表覆盖成空
  if (!MokaPersist.jobSpecIsUsable(spec)) {
    throw new Error('模型这次没解读出岗位信息（返回为空或无法解析），请稍后重试或换个模型');
  }
  return spec;
}

/** 从 URL / 内存 / 捕获请求拼出列表查询上下文 */
function resolveSearchContext() {
  const ctx = parsePageContext();
  let pipelineId = (ctx && ctx.pipelineId) || lastKnownPipelineId || '';
  let jobIds = (ctx && ctx.jobIds && ctx.jobIds.length) ? ctx.jobIds.slice() : [];
  if (!pipelineId && lastListUrl) {
    try {
      const u = new URL(lastListUrl, location.origin);
      pipelineId = u.searchParams.get('pipelineId') || '';
      if (!jobIds.length) {
        u.searchParams.forEach((value, key) => {
          if (/^jobIds(\[\d+\])?$/.test(key) && value) jobIds.push(value);
        });
      }
    } catch (e) { /* ignore */ }
  }
  if (!jobIds.length && lastScreenConfig && lastScreenConfig.jobId) {
    jobIds = [String(lastScreenConfig.jobId)];
  }
  if (!jobIds.length) {
    const jobs = getCurrentJobs();
    if (jobs[0] && jobs[0].id && jobs[0].id !== 'current') jobIds = [String(jobs[0].id)];
  }
  if (pipelineId) lastKnownPipelineId = String(pipelineId);
  return { pipelineId, jobIds };
}

/** 轻量拉取一条候选人（供 JD 解读 / 预填复用） */
async function fetchOneApplication() {
  await captureReady;
  if (!capturedRequest) {
    try { window.postMessage({ source: 'moka-content', type: 'get-search-request' }, '*'); } catch (e) {}
    await sleep(400);
  }
  const url = capturedRequest?.url || SEARCH_API_FALLBACK;
  const headers = { 'Content-Type': 'application/json', ...(capturedRequest?.headers || {}) };
  let baseBody = {};
  if (capturedRequest?.body) { try { baseBody = JSON.parse(capturedRequest.body); } catch (e) {} }

  const searchCtx = resolveSearchContext();
  if (!baseBody.pipelineId && searchCtx.pipelineId) {
    baseBody.pipelineId = Number(searchCtx.pipelineId) || searchCtx.pipelineId;
  }
  if ((!baseBody.jobIds || !baseBody.jobIds.length) && searchCtx.jobIds.length) {
    baseBody.jobIds = searchCtx.jobIds;
  }
  // 详情页无 pipelineId、也从未在列表捕获过时，无法拉列表
  if (!baseBody.pipelineId) {
    console.warn('[Moka 筛选] fetchOneApplication: 缺少 pipelineId，请回到候选人列表页');
    return null;
  }

  // 必须清掉捕获体里的残留游标，否则取到的是列表中间那个人，JD 预填会用错人
  const body = MokaCapture.buildSearchPageBody(baseBody, 1, null);
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      console.warn('[Moka 筛选] fetchOneApplication HTTP', resp.status);
      return null;
    }
    const json = await resp.json();
    return json.data?.applications?.[0] || null;
  } catch (e) {
    console.warn('[Moka 筛选] fetchOneApplication 失败:', e && e.message);
    return null;
  }
}

/** 从 JD 的结构化要求 / 文本里解析可预填的硬条件 */
function autofillFromJob(job) {
  let schemaLines = '';
  try {
    const schema = job.aiEvalRequirementSchema ? JSON.parse(job.aiEvalRequirementSchema) : [];
    schemaLines = (Array.isArray(schema) ? schema : [])
      .map((s) => (s ? String(s.name || '') + '：' + String(s.value || '') : ''))
      .join('\n');
  } catch (e) { /* ignore */ }
  const text = `${job.aiEvalRequirementInfo || ''}\n${stripHtml(job.description || '')}\n${schemaLines}`;
  const parsed = MokaMatch.extractHardAutofillFromText(text);
  parsed.majors = extractMajorsFromText(text);
  return parsed;
}

/** 从 JD 正文抽取专业关键词，覆盖「xxx、yyy 相关/等/类 专业」「专业：xxx」等写法 */
function extractMajorsFromText(text) {
  const majors = new Set();
  const STOP = new Set(['相关', '专业', '等', '以上', '学历', '背景', '毕业', '不限', '优先', '类', '方向', '及其', '以及', '或', '和', '有']);
  // 过滤学历/能力/动词等非专业词，避免把「本科及以上学历」「熟练」等抓进来
  const REJECT = /(学历|本科|硕士|博士|大专|专科|以上|及以|毕业|优先|熟练|精通|熟悉|具备|掌握|能力|经验|工作|要求|负责|岗位|以下|良好|扎实|以及)/;

  const collect = (str) => {
    str.split(/[、，,/\s]+/).forEach((raw) => {
      const t = raw.trim().replace(/(相关|类|方向|专业|优先|背景|毕业|等)+$/, '').trim();
      if (t && t.length >= 2 && t.length <= 8 && !STOP.has(t) && !REJECT.test(t)) majors.add(t);
    });
  };

  let m;
  // 「专业：视觉传达、数字媒体艺术」——冒号后即为专业列表
  const colon = /专业[:：]\s*([\u4e00-\u9fa5A-Za-z、，,/\s]{2,40})/g;
  while ((m = colon.exec(text))) collect(m[1]);

  // 「xxx、yyy 等/相关/类 专业」——并列项用顿号「、」连接（逗号是分句符，不跨句），或带 等/相关/类 修饰
  const suffix = /([\u4e00-\u9fa5A-Za-z]{2,10}?(?:[、/][\u4e00-\u9fa5A-Za-z]{2,10})*)((?:等)?(?:相关|类)?)专业/g;
  while ((m = suffix.exec(text))) {
    const list = m[1];
    const qual = m[2];
    if (qual || /[、/]/.test(list)) collect(list);
  }

  return [...majors].slice(0, 6);
}

/* ---------------- 硬性条件本地判定 ---------------- */

const DEGREE_RANK = { 大专: 1, 专科: 1, 本科: 2, 学士: 2, 硕士: 3, 研究生: 3, 博士: 4 };

// 院校要求 → Moka 智能标签名（满足任一即符合）
const SCHOOL_TAGS = {
  '211': ['211'],
  '985': ['985'],
  '双一流': ['双一流大学', '双一流学科'],
  '留学生': ['海外教育背景'],
  'QS100': ['QS50', 'QS100'],
  'QS500': ['QS50', 'QS100', 'QS200', 'QS300', 'QS500']
};

function evaluateHardConditions(app, hc, jobType) {
  const missing = [];
  if (!hc) return { passed: true, missing };

  // 学历
  if (hc.degree) {
    const need = DEGREE_RANK[hc.degree] || 0;
    const have = DEGREE_RANK[app.highestDegree] || 0;
    if (!have || have < need) missing.push(`学历需${hc.degree}及以上`);
  }

  // 院校（任一即可）
  if (Array.isArray(hc.schools) && hc.schools.length) {
    const tagNames = new Set((app.intelligentTags || []).map((t) => t.name));
    const ok = hc.schools.some((s) => (SCHOOL_TAGS[s] || [s]).some((t) => tagNames.has(t)));
    if (!ok) missing.push(`院校不符（需 ${hc.schools.join('/')}）`);
  }

  // 经验
  if (hc.exp) {
    const years = Number(app.experience) || 0;
    let ok = true;
    if (hc.exp === 'fresh') ok = years <= 1;
    else if (hc.exp === '1-3') ok = years >= 1 && years < 3;
    else if (hc.exp === '3-5') ok = years >= 3 && years <= 5;
    else if (hc.exp === '5+') ok = years >= 5;
    if (!ok) missing.push(`经验需 ${hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'}`);
  }

  // 性别
  if (hc.gender) {
    if (!app.gender || !String(app.gender).includes(hc.gender)) missing.push(`性别需${hc.gender}`);
  }

  // 实习经验（仅实习生职位生效）：本地判定「是否有实习/工作经历」，相关性交给 AI
  if (hc.internship === 'required' && jobType === 'intern') {
    const hasExp = hasAnyExperience(app) || Number(app.experience) > 0;
    if (!hasExp) missing.push('缺相关实习经验');
  }

  // 年龄（多选区间 OR；仅在候选人有年龄信息时判定）
  const age = Number(app.age);
  const ranges = normalizeAgeRanges(hc);
  if (ranges.length) {
    const ok = Number.isFinite(age) && age > 0 && ranges.some((r) => ageInRange(age, r));
    if (!ok) missing.push(`年龄需 ${ranges.map((r) => r.label).join('/')}`);
  }

  return { passed: missing.length === 0, missing };
}

/** 兼容 ageRanges（多选）与旧版 ageMin/ageMax（单区间） */
function normalizeAgeRanges(hc) {
  if (!hc) return [];
  if (Array.isArray(hc.ageRanges) && hc.ageRanges.length) {
    return hc.ageRanges.filter((r) => r && (r.min != null || r.max != null)).map((r) => ({
      min: r.min != null ? Number(r.min) : null,
      max: r.max != null ? Number(r.max) : null,
      label: r.label || formatAgeRangeLabel(r.min, r.max)
    }));
  }
  if (hc.ageMin != null || hc.ageMax != null) {
    return [{ min: hc.ageMin != null ? Number(hc.ageMin) : null, max: hc.ageMax != null ? Number(hc.ageMax) : null,
      label: formatAgeRangeLabel(hc.ageMin, hc.ageMax) }];
  }
  return [];
}

function formatAgeRangeLabel(min, max) {
  if (min != null && max == null) return `${min}+`;
  if (min != null && max != null) return `${min}-${max}`;
  if (min == null && max != null) return `≤${max}`;
  return '不限';
}

function ageInRange(age, r) {
  if (r.min != null && age < r.min) return false;
  if (r.max != null && age > r.max) return false;
  return true;
}

/** 生成给模型看的硬性条件文本 */
function buildHardText(hc, jobType, extraMustHaves) {
  if (!hc && !(extraMustHaves && extraMustHaves.length)) return '';
  const parts = [];
  if (hc) {
    if (hc.degree) parts.push(`学历：${hc.degree}及以上`);
    if (hc.schools && hc.schools.length) parts.push(`院校：${hc.schools.join('/')}（任一）`);
    if (hc.exp) parts.push(`经验：${hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'}`);
    if (hc.gender) parts.push(`性别：${hc.gender}`);
    if (hc.internship === 'required' && jobType === 'intern') parts.push('需具备相关实习经验');
    const ageRanges = normalizeAgeRanges(hc);
    if (ageRanges.length) {
      parts.push(`年龄：${ageRanges.map((r) => r.label).join('/')}（任一）`);
    }
  }
  if (Array.isArray(extraMustHaves) && extraMustHaves.length) {
    parts.push('其他必备：' + extraMustHaves.join('、') + '（未满足将扣综合分）');
  }
  return parts.join('；');
}

function applyMergedHard(item) {
  const local = item.hardLocal || { passed: true, missing: [] };
  const unmet = ((item.score && item.score.unmet) || [])
    .filter((gate) => gate && gate.source === 'handwritten');
  item.hard = MokaMatch.mergeHardWithMustHaves(local, unmet);
}

function applyScoreResult(item, raw, weights) {
  item.rawScore = raw;
  if (!item.waivedMustHaves) item.waivedMustHaves = new Set();
  item.score = composeFinalScore(raw, weights, item.waivedMustHaves, (item.hardLocal && item.hardLocal.missing) || []);
  applyMergedHard(item);
}

function ensureHardLocal(item) {
  if (item.hardLocal && Array.isArray(item.hardLocal.missing)) return;
  const missing = ((item.hard && item.hard.missing) || []).filter((m) => !MokaMatch.itemFromCustomHardLabel(m));
  item.hardLocal = { passed: missing.length === 0, missing };
}

/* ---------------- 详情补全 ---------------- */

/** 在任意层级深度查找某个 key 的值（返回首个命中） */
function deepFind(obj, key) {
  let found;
  const walk = (o) => {
    if (found !== undefined || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k of Object.keys(o)) {
      if (found !== undefined) break;
      if (k === key) { found = o[k]; return; }
      walk(o[k]);
    }
  };
  walk(obj);
  return found;
}

/** 深度收集某个 key 的所有取值（同名 key 可能出现在多层） */
function deepFindAll(obj, key) {
  const out = [];
  const seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k of Object.keys(o)) {
      if (k === key) out.push(o[k]);
      walk(o[k]);
    }
  };
  walk(obj);
  return out;
}

/**
 * 通用「经历数组」识别：字段名不确定时，扫描出「看起来像工作/实习/项目经历」的对象数组。
 * 判据：数组元素是对象，且键里同时含「机构类」与（「职务/描述类」或「时间类）字段；排除教育类。
 */
function pickExperienceArrays(json) {
  const result = [];
  const seen = new Set();
  const ORG = /(company|organization|orgname|employer|unit|project|institution)/i;
  const ROLE = /(title|position|role|duty|responsib|content|summary|desc|job|work)/i;
  const DATE = /(start|end|date|time|duration|year|period|begin)/i;
  const EDU = /(academicdegree|degree|major|speciality|gpa)/i;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length && o.every((it) => it && typeof it === 'object' && !Array.isArray(it))) {
        const keys = Object.keys(o[0]).join(' ');
        const hasOrg = ORG.test(keys);
        const hasRole = ROLE.test(keys);
        const hasDate = DATE.test(keys);
        const isEdu = EDU.test(keys);
        if (hasOrg && (hasRole || hasDate) && !isEdu) result.push(o);
      }
      o.forEach(walk);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(json);
  return result;
}

// 详情请求里不能/不必手工设置的头（浏览器自动处理或会报错）
const FORBIDDEN_HEADERS = new Set([
  'cookie', 'host', 'content-length', 'connection', 'accept-encoding', 'content-type',
  'if-none-match', 'if-modified-since' // 条件请求头会导致 304 空响应，重放时去掉
]);

/** 用「已验证含经历」的详情模板拼出目标候选人的详情 URL（保留 scene 等查询参数） */
function buildDetailUrl(app) {
  return MokaCapture.buildDetailUrl(app, capturedDetailRequest, location.origin);
}

function detailHeaders() {
  const out = { Accept: 'application/json' };
  const src = (capturedDetailRequest && capturedDetailRequest.headers)
    || (capturedRequest && capturedRequest.headers)
    || {};
  for (const k of Object.keys(src)) {
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) out[k] = src[k];
  }
  return out;
}

// Moka 把不同类型经历拆到不同数组（实习生的正式工作 experienceInfo 常为空，真实经历在 practiceInfo）
const WORK_KEYS = ['experienceInfo', 'workExperiences', 'workExperience', 'workInfo', 'careers'];
const PRACTICE_KEYS = ['practiceInfo', 'internships', 'internshipInfo', 'internExperiences'];
const PROJECT_KEYS = ['projectInfo', 'projectExperiences', 'projects'];
const SELF_EVAL_KEYS = ['personal', 'selfEvaluation', 'selfAssessment', 'selfIntro', 'introduction'];

/** 取首个「非空数组」值（优先根层，deepFind 深度优先返回首个命中） */
function firstNonEmptyArray(json, keys) {
  for (const k of keys) {
    const v = deepFind(json, k);
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

/** 把详情 JSON 里的经历/教育/文本字段合并进 app（按 Moka 真实 schema 分类提取） */
function mergeDetailIntoApp(app, json) {
  const edu = firstNonEmptyArray(json, ['educationInfo', 'educationExperiences', 'educations']);
  if (edu) app.educationInfo = edu;

  const work = firstNonEmptyArray(json, WORK_KEYS);
  const practice = firstNonEmptyArray(json, PRACTICE_KEYS);
  const project = firstNonEmptyArray(json, PROJECT_KEYS);
  if (work) app.experienceInfo = work;
  if (practice) app.practiceInfo = practice;
  if (project) app.projectInfo = project;

  // 三类都没命中，再兜底做字段名无关的通用扫描
  if (!work && !practice && !project) {
    const arrs = pickExperienceArrays(json);
    if (arrs.length) app.experienceInfo = arrs.reduce((a, b) => a.concat(b), []);
  }

  // 奖项：数组或字符串
  const awardArr = firstNonEmptyArray(json, ['awardInfo', 'awards']);
  if (awardArr) app.awardInfo = awardArr;

  // 自我评价 / 文本类
  for (const k of SELF_EVAL_KEYS) {
    if (app.personal && String(app.personal).trim()) break;
    const v = deepFind(json, k);
    if (typeof v === 'string' && v.trim()) { app.personal = v; break; }
  }
  ['skill', 'awards', 'specialities', 'highestDegreeSpeciality'].forEach((k) => {
    if (app[k] && String(app[k]).trim()) return;
    const v = deepFind(json, k);
    if (v != null && String(v).trim()) app[k] = v;
  });
}

/**
 * 列表接口对部分候选人（尤其「主动投递/未授权」）不返回 experienceInfo 等结构化经历，
 * 这里按需从详情接口补全，保证画像里包含完整的工作/实习经历。
 * 详情接口需要 scene 令牌，且经历可能由独立接口加载 —— 均由 inject.js 探测响应内容自动发现并重放。
 */
function hasAnyExperience(app) {
  return ['experienceInfo', 'practiceInfo', 'projectInfo'].some(
    (k) => Array.isArray(app[k]) && app[k].length
  );
}

async function enrichCandidate(app) {
  if (!app || app.id == null) return app;
  if (app.__enriched) return app;

  let json = null;
  // 1) 命中缓存（页面已打开过该候选人）：直接用，并校验归属，杜绝串号
  const cached = detailDataCache.get(String(app.id)) || (app.candidateId != null && detailDataCache.get(String(app.candidateId))) || null;
  if (cached && detailBelongsTo(app, cached)) json = cached;

  // 2) 列表未带经历时：按模板 / 默认路径 / candidateId 依次尝试，失败换下一条 URL
  if (!json && !hasAnyExperience(app)) {
    const method = (capturedDetailRequest && capturedDetailRequest.method) || 'GET';
    const urls = MokaCapture.uniqueDetailUrls(app, capturedDetailRequest, location.origin, currentScene());
    for (const url of urls) {
      try {
        const resp = await fetchWithTimeout(url, {
          method,
          credentials: 'include',
          headers: detailHeaders()
        });
        if (!resp.ok) continue;
        const fetched = MokaCapture.unwrapDetailJson(await resp.json());
        if (detailBelongsTo(app, fetched)) {
          json = fetched;
          break;
        }
      } catch (e) { /* 尝试下一条 URL */ }
    }
  }

  if (json) mergeDetailIntoApp(app, json);

  // 3) 极端兜底：结构化经历仍全缺 + 存在可解析的 HTML 简历原件时，抓正文喂给 AI
  //    （PDF 无法在浏览器内可靠转文本，故只取 .html）
  if (!hasAnyExperience(app) && json) {
    const resumeUrl = findResumeUrl(json);
    if (resumeUrl && /\.html(\?|$)/i.test(resumeUrl)) {
      try {
        const text = await fetchResumeText(resumeUrl);
        if (text && text.trim()) app.__resumeText = text.trim();
      } catch (e) { /* 抓取失败则忽略 */ }
    }
  }

  app.__enriched = true;
  return app;
}

/** 用第一位候选人探测详情接口（不依赖用户先点开），成功则当作本轮模板 */
async function probeDetailRequest(app) {
  if (!app || app.id == null) return null;
  lastProbeReason = '';
  const urls = MokaCapture.uniqueDetailUrls(app, capturedDetailRequest, location.origin, currentScene());
  for (const url of urls) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: (capturedDetailRequest && capturedDetailRequest.method) || 'GET',
        credentials: 'include',
        headers: detailHeaders()
      });
      if (!resp.ok) {
        lastProbeReason = `HTTP ${resp.status}`;
        continue;
      }
      const json = MokaCapture.unwrapDetailJson(await resp.json());
      if (!detailBelongsTo(app, json)) {
        lastProbeReason = '返回无法匹配该候选人';
        continue;
      }
      cacheDetailData({ url, text: JSON.stringify(json) });
      capturedDetailRequest = { url, method: 'GET', headers: detailHeaders() };
      persistCapture();
      return capturedDetailRequest;
    } catch (e) {
      lastProbeReason = (e && e.message) || '请求失败';
    }
  }
  if (!lastProbeReason) lastProbeReason = '未找到可用详情接口';
  return null;
}

/** 深度扫描 JSON，找出候选人简历原件的 OSS 链接（带签名的 html/pdf/doc 文件） */
function findResumeUrl(obj) {
  const urls = [];
  const seen = new Set();
  (function walk(o) {
    if (o == null || typeof o !== 'object') return;
    if (seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (/mokahr\.com\/.+(OSSAccessKeyId|Signature)=/.test(v) || /https?:\/\/[^\s"']+\.(html|pdf|docx?|txt)(\?|$)/i.test(v)) {
          urls.push(v);
        }
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  })(obj);
  if (!urls.length) return null;
  // 优先 html（Moka 解析后的简历视图），其次 pdf/doc
  return urls.find((u) => /\.html(\?|$)/i.test(u))
    || urls.find((u) => /\.pdf(\?|$)/i.test(u))
    || urls[0];
}

/** 通过 background 抓取并解析简历原件正文（绕过 CORS） */
function fetchResumeText(url) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'fetchResume', url }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) return resolve('');
        resolve(resp.text || '');
      });
    } catch (e) { resolve(''); }
  });
}

/* ---------------- 画像 & JD ---------------- */

function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+\n/g, '\n').trim();
}

/** 把一段经历数组格式化为「机构 职务 (起~止): 描述」文本；字段名兼容多种命名 */
function formatExperienceList(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr
    .map((e) => {
      if (!e || typeof e !== 'object') return '';
      const org = e.company || e.organization || e.orgName || e.employer || e.unit || e.projectName || e.school || e.name || '';
      const title = e.title || e.position || e.role || e.jobTitle || e.projectRole || '';
      const dept = e.department ? `[${e.department}]` : '';
      const start = e.startDate || e.startTime || e.start || e.beginDate || e.from || '';
      const end = e.endDate || e.endTime || e.end || e.to || '';
      const period = (start || end) ? ` (${start}~${end})` : '';
      const head = `${org} ${title}${dept}${period}`.replace(/\s+/g, ' ').trim();
      const desc = e.summary || e.content || e.description || e.duty || e.workContent
        || e.responsibility || e.responsibilities || e.detail || e.desc || e.projectDescription || '';
      const line = desc ? `${head}: ${String(desc).trim()}` : head;
      return line.trim();
    })
    .filter((s) => s && s !== ':' && s !== '()')
    .join('\n');
}

function buildCandidateProfile(app) {
  const lines = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      lines.push(`${label}: ${String(value).trim()}`);
    }
  };

  push('姓名', app.name);
  push('性别', app.gender);
  push('年龄', app.age);
  push('最高学历', app.highestDegree);
  if (app.highestDegreeSchool || app.highestDegreeSpeciality) {
    push('最高学历院校/专业', `${app.highestDegreeSchool || ''} ${app.highestDegreeSpeciality || ''}`);
  }

  if (Array.isArray(app.educationInfo) && app.educationInfo.length) {
    const edu = app.educationInfo
      .map((e) => `${e.academicDegree || ''} ${e.school || ''} ${e.speciality || ''} (${e.startDate || ''}~${e.endDate || ''})`.trim())
      .join('；');
    push('教育经历', edu);
  }

  // Moka 把工作/实习/项目经历拆到不同数组，分别渲染并打标签，避免实习生经历被漏读
  const workExp = formatExperienceList(app.experienceInfo);
  const practiceExp = formatExperienceList(app.practiceInfo);
  const projectExp = formatExperienceList(app.projectInfo);
  if (workExp) push('工作经历', '\n' + workExp);
  if (practiceExp) push('实习经历', '\n' + practiceExp);
  if (projectExp) push('项目/校园经历', '\n' + projectExp);
  if (!workExp && !practiceExp && !projectExp && app.experience) {
    push('工作经验(年)', app.experience);
  }

  push('技能', app.skill && app.skill.replace(/\n/g, '，'));
  const awardsText = Array.isArray(app.awardInfo) && app.awardInfo.length
    ? app.awardInfo.map((a) => `${a.name || a.awardName || a.title || ''} ${a.date || a.awardDate || ''}`.trim()).filter(Boolean).join('，')
    : (app.awards && String(app.awards).replace(/\n/g, '，'));
  push('奖项/证书', awardsText);
  push('自我介绍', app.personal);

  if (Array.isArray(app.intelligentTags) && app.intelligentTags.length) {
    push('标签', app.intelligentTags.map((t) => t.name).filter(Boolean).join('、'));
  }

  push('求职类型', app.commitment);
  push('意向城市', app.location);
  if (typeof app.matchingIndex === 'number') {
    push('Moka匹配度', `${Math.round(app.matchingIndex * 100)}%`);
  }

  // 附件简历原件正文（主动投递/结构化经历缺失时的关键信息源）
  if (app.__resumeText && String(app.__resumeText).trim()) {
    push('简历原件（附件解析）', '\n' + String(app.__resumeText).trim());
  }

  return lines.join('\n');
}

function buildJobJD(app) {
  const job = app.job || {};
  const parts = [];
  if (job.title || app.jobTitle) parts.push(`职位: ${job.title || app.jobTitle}`);
  if (job.departmentName) parts.push(`部门: ${job.departmentName}`);
  const desc = stripHtml(job.description || app.jobDescription || '');
  if (desc) parts.push(`岗位描述与要求:\n${desc}`);
  if (job.aiEvalRequirementInfo) parts.push(`硬性/加分要求:\n${job.aiEvalRequirementInfo}`);
  return parts.join('\n\n');
}

/* ---------------- 主流程 ---------------- */

function loadScreeningJob() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MokaScreeningJob.SCREENING_JOB_KEY, (r) => {
        const job = MokaScreeningJob.sanitizeScreeningJob(r && r[MokaScreeningJob.SCREENING_JOB_KEY]);
        activeScreeningJob = job;
        resolve(job);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function saveScreeningJob(job) {
  const clean = MokaScreeningJob.sanitizeScreeningJob(job);
  activeScreeningJob = clean;
  return new Promise((resolve) => {
    try {
      if (!clean) {
        chrome.storage.local.remove(MokaScreeningJob.SCREENING_JOB_KEY, () => resolve(null));
        return;
      }
      chrome.storage.local.set({ [MokaScreeningJob.SCREENING_JOB_KEY]: clean }, () => resolve(clean));
    } catch (e) {
      resolve(clean);
    }
  });
}

function patchScreeningJob(patch) {
  const base = activeScreeningJob || {};
  return saveScreeningJob(Object.assign({}, base, patch || {}, { updatedAt: Date.now() }));
}

async function finishScreeningJob(status, extra) {
  if (activeScreeningJob) {
    await saveScreeningJob(MokaScreeningJob.withStatus(
      activeScreeningJob,
      status,
      extra || {}
    ));
  }
  chrome.runtime.sendMessage({ action: 'screeningKeepaliveStop' }).catch(() => {});
}

function startScreeningKeepalive() {
  chrome.runtime.sendMessage({ action: 'screeningKeepaliveStart' }).catch(() => {});
}

function notifyScreeningComplete(total, message) {
  chrome.runtime.sendMessage({
    action: 'notifyScreeningDone',
    total,
    message
  }).catch(() => {});
}

function countScoredResults() {
  return results.filter((item) => item && item.score && item.score.level !== '错误').length;
}

function hasPendingScore(item) {
  return !item || !item.score || item.score.level === '错误';
}

async function checkScreeningJobMismatch() {
  if (!isScreening || !activeScreeningJob) return false;
  const pageJobId = pageJobIdFromContext();
  if (!pageJobId) return false;
  if (MokaScreeningJob.matchesPageJob(activeScreeningJob, pageJobId)) return false;
  screeningEpoch += 1;
  isScreening = false;
  await finishScreeningJob('paused_mismatch');
  updatePanelStatus('已暂停：Moka 职位与当前筛选任务不一致，请切回原职位后在侧栏确认是否继续');
  chrome.runtime.sendMessage({
    action: 'screeningPausedMismatch',
    job: activeScreeningJob
  }).catch(() => {});
  publishResults(undefined, undefined, { flush: true });
  return true;
}

async function offerResumeIfNeeded() {
  if (isScreening) return;
  const job = await loadScreeningJob();
  if (!MokaScreeningJob.isResumableJob(job)) return;
  const pageJobId = pageJobIdFromContext();
  if (pageJobId && !MokaScreeningJob.matchesPageJob(job, pageJobId)) {
    await saveScreeningJob(MokaScreeningJob.withStatus(job, 'paused_mismatch'));
    chrome.runtime.sendMessage({
      action: 'screeningPausedMismatch',
      job: activeScreeningJob
    }).catch(() => {});
    return;
  }
  await alignResultsForPageJob();
  const pending = results.filter(hasPendingScore).length;
  if (!results.length || pending === 0) {
    await finishScreeningJob('done', { completed: job.total });
    return;
  }
  await saveScreeningJob(MokaScreeningJob.withStatus(job, 'awaiting_resume', {
    completed: Math.max(job.completed, countScoredResults()),
    total: Math.max(job.total, results.length)
  }));
  chrome.runtime.sendMessage({
    action: 'screeningResumeAvailable',
    job: activeScreeningJob,
    pending
  }).catch(() => {});
}

async function discardScreeningJob() {
  chrome.runtime.sendMessage({ action: 'screeningKeepaliveStop' }).catch(() => {});
  activeScreeningJob = null;
  await saveScreeningJob(null);
}

async function scoreResultsBatch(scoreConfig, weights, hc, keywords, opts) {
  const options = opts || {};
  const onlyPending = !!options.onlyPending;
  const epoch = options.epoch;
  const total = results.length;
  let completed = countScoredResults();
  let cursor = 0;
  let enrichedExp = results.filter((it) => it && it.app && (hasAnyExperience(it.app) || it.app.__resumeText)).length;
  // 重新开筛后，上一轮 worker 必须停手，否则会往新一轮的 results 里写脏数据
  const alive = () => isScreening && (epoch == null || epoch === screeningEpoch);

  async function worker() {
    while (alive()) {
      if (await checkScreeningJobMismatch()) break;
      const index = cursor++;
      if (index >= total) break;
      const item = results[index];
      if (onlyPending && !hasPendingScore(item)) continue;

      try {
        setRowStage(item.app.id, 'enrich');
        await enrichCandidate(item.app);
        if (hasAnyExperience(item.app) || item.app.__resumeText) enrichedExp++;
        item.profile = buildCandidateProfile(item.app);
        item.hardLocal = evaluateHardConditions(item.app, hc, scoreConfig.jobType);
        item.hard = item.hardLocal;
        item.graduationRisk = MokaMatch.graduationRiskHint(item.app && item.app.educationInfo, {
          jobType: scoreConfig.jobType,
          now: new Date()
        });
        item.keywords = { hit: [], miss: [] };
        applyHardToRow(item);
        applyKeywordTags(item);

        setRowStage(item.app.id, 'score');
        const raw = await scoreViaBackgroundWithRetry(item.profile, scoreConfig);
        applyScoreResult(item, raw, weights);
      } catch (err) {
        console.error('[Moka 筛选] 候选人处理失败:', item.app && item.app.name, err);
        applyScoreResult(item, {
          dimensions: null,
          error: (err && err.message) ? err.message : '处理失败'
        }, weights);
      } finally {
        clearRowStage(item.app.id);
      }
      completed = countScoredResults();
      updateRow(item);
      applyPanelFilter();
      scheduleSort();
      schedulePersistLastScreening();
      await patchScreeningJob({
        status: 'running',
        completed,
        total
      });
      updatePanelStatus(`评分 ${completed}/${total} · 已补全经历 ${enrichedExp} 位 · Moka 标签请保持打开（可切去其他浏览器标签）`);
      reportProgress(completed, total, Math.round((completed / Math.max(total, 1)) * 100), `已评分 ${completed}/${total}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(total, 1)) }, worker));
  return { completed: countScoredResults(), enrichedExp, total };
}

async function resumeScreeningFromJob() {
  const job = await loadScreeningJob();
  if (!MokaScreeningJob.isResumableJob(job)) {
    return { ok: false, error: '没有可继续的筛选任务' };
  }
  const pageJobId = pageJobIdFromContext();
  if (pageJobId && !MokaScreeningJob.matchesPageJob(job, pageJobId)) {
    await saveScreeningJob(MokaScreeningJob.withStatus(job, 'paused_mismatch'));
    return { ok: false, error: '当前 Moka 职位与未完成任务不一致，请切回原职位后再继续' };
  }

  await alignResultsForPageJob();
  if (!results.length) {
    await restoreResultsSilently(job.pipelineId, job.jobId);
  }
  if (!results.length) {
    return { ok: false, error: '找不到上次筛选进度，请重新开始筛选' };
  }

  if (!lastScreenConfig) {
    lastScreenConfig = {
      jobId: job.jobId,
      jobName: job.jobName,
      jobType: job.jobType,
      jobSpec: job.jobSpec,
      hardText: '',
      hc: job.hardConditions,
      weights: job.weights,
      keywords: job.keywords
    };
  }
  const weights = normalizeWeights(job.weights || (lastScreenConfig && lastScreenConfig.weights));
  activeWeights = weights;
  const hc = job.hardConditions || (lastScreenConfig && lastScreenConfig.hc) || null;
  const keywords = job.keywords || (lastScreenConfig && lastScreenConfig.keywords) || [];
  const scoreConfig = {
    jobType: job.jobType || (lastScreenConfig && lastScreenConfig.jobType) || 'full-time',
    jobSpec: job.jobSpec || (lastScreenConfig && lastScreenConfig.jobSpec),
    jobJD: (lastScreenConfig && lastScreenConfig.jobJD) || '',
    hardText: (lastScreenConfig && lastScreenConfig.hardText) || '',
    weights,
    feedbackContext: (lastScreenConfig && lastScreenConfig.feedbackContext) || '',
    feedbackRev: (lastScreenConfig && lastScreenConfig.feedbackRev) || 'none'
  };

  isScreening = true;
  startScreeningKeepalive();
  await patchScreeningJob({
    status: 'running',
    total: results.length,
    completed: countScoredResults()
  });
  updatePanelStatus('已恢复筛选，继续评分未完成的候选人… · Moka 标签请保持打开');
  publishResults(undefined, undefined, { flush: true });

  try {
    const { completed, enrichedExp, total } = await scoreResultsBatch(
      scoreConfig, weights, hc, keywords, { onlyPending: true }
    );
    sortRows();
    persistLastScreening();
    if (isScreening && completed >= total) {
      await finishScreeningJob('done', { completed, total });
      reportProgress(total, total, 100, '筛选完成！');
      updatePanelStatus(`筛选完成，共 ${total} 位（已补全经历 ${enrichedExp} 位）`);
      notifyScreeningComplete(total, `筛选完成，共 ${total} 位候选人`);
    } else if (!isScreening) {
      const cur = await loadScreeningJob();
      if (!cur || (cur.status !== 'stopped' && cur.status !== 'done')) {
        await finishScreeningJob(
          cur && cur.status === 'paused_mismatch' ? 'paused_mismatch' : 'awaiting_resume',
          { completed, total }
        );
        updatePanelStatus(`已暂停（完成 ${completed}/${total}）`);
      }
    }
    return { ok: true, completed, total };
  } finally {
    isScreening = false;
    publishResults(undefined, undefined, { flush: true });
  }
}

async function performScreening(config, epoch) {
  const mine = () => isScreening && (epoch == null || epoch === screeningEpoch);
  results = [];
  lastScreenConfig = null;
  activeWeights = null;
  resetResultUi();
  updatePanelStatus('正在准备筛选… · Moka 标签请保持打开（可切去其他浏览器标签）');
  reportProgress(0, 0, 0, '正在准备筛选…');
  await captureReady;
  if (!mine()) return;
  if (isOnListPage()) lastListUrl = location.href;

  try {
    const maxCount = Number(config.maxCount) > 0 ? Number(config.maxCount) : 0;
    updatePanelStatus(
      (maxCount ? `正在拉取候选人列表（最多 ${maxCount} 位）...` : '正在拉取候选人列表（全部）...')
      + ' · Moka 标签请保持打开（可切去其他浏览器标签）'
    );
    reportProgress(0, 0, 0, maxCount ? `正在拉取候选人（最多 ${maxCount} 位）…` : '正在拉取候选人列表…');
    const apps = await fetchAllApplications((count) => {
      if (!mine()) return;
      updatePanelStatus(`正在拉取候选人... 已获取 ${count} 位`);
      reportProgress(0, count, 0, `拉取中，已获取 ${count} 位`);
    }, maxCount, epoch);
    if (!mine()) return;

    if (apps.length === 0) {
      updatePanelStatus('未找到候选人（请确认在候选人列表页，并刷新一次）');
      reportProgress(0, 0, 100, '未找到候选人');
      await finishScreeningJob('stopped');
      return;
    }

    const jobJD = buildJobJD(apps[0]);
    const total = apps.length;
    const hc = config.hardConditions || null;
    const weights = normalizeWeights(config.weights);
    activeWeights = weights;
    const keywords = Array.isArray(config.keywords) ? config.keywords : [];

    // 优先自动探测详情接口；失败才提示用户点开一人
    if (!capturedDetailRequest) {
      try { window.postMessage({ source: 'moka-content', type: 'get-detail-request' }, '*'); } catch (e) {}
      await sleep(300);
    }
    if (!capturedDetailRequest && apps[0]) {
      updatePanelStatus('正在自动识别详情接口…');
      await probeDetailRequest(apps[0]);
    }
    if (!capturedDetailRequest) {
      showDetailBanner();
      const why = lastProbeReason ? `（${lastProbeReason}）` : '';
      for (let i = 0; i < 12 && !capturedDetailRequest; i++) {
        if (!mine()) break;
        updatePanelStatus(`自动识别未成功${why}，等待点开候选人…（${12 - i}s，可忽略）`);
        await sleep(1000);
        if (!capturedDetailRequest && apps[0]) await probeDetailRequest(apps[0]);
      }
    }

    if (!mine()) return;
    // 结构化门槛本地判定；语言/专业及其他交给模型逐条判定。
    let jobSpec = config.jobSpec || null;
    const languages = Array.isArray(jobSpec && jobSpec.languages)
      ? jobSpec.languages.slice(0, 6)
      : (Array.isArray(hc && hc.languages) ? hc.languages.slice(0, 6) : []);
    const customGates = Array.isArray(jobSpec && jobSpec.customGates)
      ? jobSpec.customGates.slice(0, 6)
      : (Array.isArray(hc && hc.customGates) ? hc.customGates.slice(0, 6) : []);
    if (!jobSpec) {
      jobSpec = {
        languages,
        customGates,
        focusKeywords: [],
        bonusKeywords: []
      };
    } else {
      jobSpec = Object.assign({}, jobSpec, {
        languages,
        customGates,
        focusKeywords: Array.isArray(jobSpec.focusKeywords)
          ? jobSpec.focusKeywords.slice(0, 6)
          : (Array.isArray(jobSpec.importantHaves) ? jobSpec.importantHaves.slice(0, 6) : []),
        bonusKeywords: Array.isArray(jobSpec.bonusKeywords)
          ? jobSpec.bonusKeywords.slice(0, 5)
          : (Array.isArray(jobSpec.niceToHaves) ? jobSpec.niceToHaves.slice(0, 5) : []),
        mustHaves: []
      });
    }
    const hardText = '';
    const feedbackBundle = await loadFeedbackBundle(config.jobId);
    const ctx = parsePageContext();
    const jobName = String(config.jobName || '').trim()
      || (ctx && ctx.title && safeDecode(ctx.title))
      || parseJobTitleFromUrl(lastListUrl)
      || (apps[0] && apps[0].job && apps[0].job.title)
      || lastKnownJobName
      || '';
    if (jobName) lastKnownJobName = String(jobName);
    lastScreenConfig = {
      jobId: config.jobId || '',
      jobName: lastKnownJobName,
      jobType: config.jobType,
      jobSpec,
      jobJD,
      hardText,
      hc,
      weights,
      keywords,
      feedbackContext: feedbackBundle.context,
      feedbackRev: feedbackBundle.rev
    };

    const pipelineId = (ctx && ctx.pipelineId) || lastKnownPipelineId || '';
    if (pipelineId) lastKnownPipelineId = String(pipelineId);
    await saveScreeningJob({
      status: 'running',
      pipelineId,
      jobId: config.jobId || '',
      jobName: lastKnownJobName,
      listUrl: lastListUrl || (isOnListPage() ? location.href : ''),
      maxCount,
      jobType: config.jobType,
      hardConditions: hc,
      weights: config.weights || weights,
      keywords,
      jobSpec,
      total,
      completed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });
    startScreeningKeepalive();

    // 先建占位行；画像/硬条件在补全详情后于 worker 内生成，保证经历数据完整
    results = apps.map((app) => ({ app, profile: null, jobJD, hard: null, score: null }));
    buildRows();

    const scoreConfig = {
      jobType: config.jobType,
      jobSpec,
      jobJD,
      hardText,
      weights,
      feedbackContext: feedbackBundle.context,
      feedbackRev: feedbackBundle.rev
    };
    const prefHint = feedbackBundle.total > 0
      ? ` · 已对齐 ${feedbackBundle.total} 条历史决策（推荐 ${feedbackBundle.recommend || feedbackBundle.positive || 0} · 淘汰 ${feedbackBundle.eliminate || feedbackBundle.negative || 0}）`
      : '';

    updatePanelStatus(`共 ${total} 位候选人，正在补全简历并 AI 评分${prefHint}... · Moka 标签请保持打开（可切去其他浏览器标签）`);
    reportProgress(0, total, 0, `共 ${total} 位，开始评分...`);

    const { completed, enrichedExp } = await scoreResultsBatch(
      scoreConfig, weights, hc, keywords, { onlyPending: false, epoch }
    );
    if (!mine()) return;
    sortRows();
    persistLastScreening();

    if (mine()) {
      await finishScreeningJob('done', { completed: total, total });
      reportProgress(total, total, 100, '筛选完成！');
      const hint = enrichedExp === 0 && !capturedDetailRequest
        ? '（未捕获到详情接口，经历可能读不全：请在 Moka 点开任一候选人详情后重试）'
        : `（已补全经历 ${enrichedExp} 位）`;
      updatePanelStatus(`筛选完成，共 ${total} 位 ${hint}`);
      notifyScreeningComplete(total, `筛选完成，共 ${total} 位候选人`);
    } else {
      const cur = await loadScreeningJob();
      if (!cur || (cur.status !== 'stopped' && cur.status !== 'done')) {
        const paused = cur && cur.status === 'paused_mismatch';
        await finishScreeningJob(paused ? 'paused_mismatch' : 'awaiting_resume', {
          completed,
          total
        });
        updatePanelStatus(`已停止（完成 ${completed}/${total}）` + (paused ? ' · 职位不一致已暂停' : ' · 可在侧栏选择是否继续'));
      }
    }
  } catch (error) {
    console.error('[Moka 筛选] 错误:', error);
    updatePanelStatus('❌ 出错: ' + error.message);
    await finishScreeningJob('awaiting_resume');
  }
}

function analyzeJobViaBackground(jobJD, jobType) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'analyzeJob', jobJD, jobType }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        resolve(null); // 解读失败则退化为无画像评分
      } else {
        resolve(response.spec);
      }
    });
  });
}

function loadFeedbackBundle(jobId) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MokaFeedback.FEEDBACK_STORAGE_KEY, (res) => {
        const record = (res && res[MokaFeedback.FEEDBACK_STORAGE_KEY]) || {};
        resolve(MokaFeedback.buildFeedbackBundle(record, jobId));
      });
    } catch (e) {
      resolve(MokaFeedback.buildFeedbackBundle({}, jobId));
    }
  });
}

// background 是 MV3 Service Worker，可能在请求途中被回收导致回调永不触发；
// 没有超时会让 worker 永久挂起，进而 isScreening 永远为真、侧栏无法再开筛。
const SCORE_RESPONSE_TIMEOUT_MS = 120 * 1000;

function scoreViaBackground(profile, config) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      done({ dimensions: null, error: '评分超时（后台无响应），请重试' });
    }, SCORE_RESPONSE_TIMEOUT_MS);
    chrome.runtime.sendMessage(
      {
        action: 'scoreCandidate',
        profile,
        config: {
          jobType: config.jobType,
          jobSpec: config.jobSpec,
          jobJD: config.jobJD,
          hardText: config.hardText || '',
          weights: config.weights || null,
          feedbackContext: config.feedbackContext || '',
          feedbackRev: config.feedbackRev || 'none'
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          done({ dimensions: null, error: chrome.runtime.lastError.message });
        } else if (response && response.ok) {
          done(response.score);
        } else {
          done({ dimensions: null, error: (response && response.error) || '评分失败' });
        }
      }
    );
  });
}

const SCORE_RETRY_DELAY_MS = 1000;

async function scoreViaBackgroundWithRetry(profile, config) {
  let raw = await scoreViaBackground(profile, config);
  for (let attempt = 0; attempt < MokaScore.SCORE_AUTO_RETRY_MAX; attempt++) {
    if (!MokaScore.isRetryableScoreFailure(raw)) return raw;
    await sleep(SCORE_RETRY_DELAY_MS * (attempt + 1));
    raw = await scoreViaBackground(profile, config);
  }
  return raw;
}

const WEIGHT_KEYS = MokaScore.WEIGHT_KEYS;
const DEFAULT_WEIGHTS = { experience: 40, skill: 30, education: 20, potential: 10 };

function normalizeWeights(w) {
  let vals = WEIGHT_KEYS.map((k) => {
    const n = Number(w && w[k]);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WEIGHTS[k];
  });
  let sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) { vals = WEIGHT_KEYS.map((k) => DEFAULT_WEIGHTS[k]); sum = 100; }
  const out = {};
  WEIGHT_KEYS.forEach((k, i) => { out[k] = vals[i] / sum; }); // 归一化为 0~1 比例
  return out;
}

const composeFinalScore = MokaScore.composeFinalScore;

function lastScreeningKey() {
  return screeningStorageKey();
}

function persistLastScreening() {
  if (!results.length) return;
  const ctx = parsePageContext();
  if (isOnListPage()) lastListUrl = location.href;
  const pipelineId = (ctx && ctx.pipelineId) || lastKnownPipelineId || '';
  if (pipelineId) lastKnownPipelineId = String(pipelineId);
  const payload = {
    pipelineId: pipelineId || null,
    resultContextKey: MokaPersist.resultContextKey(
      pipelineId,
      lastScreenConfig && lastScreenConfig.jobId
    ),
    listUrl: lastListUrl || (isOnListPage() ? location.href : ''),
    savedAt: Date.now(),
    weights: activeWeights,
    screenConfig: lastScreenConfig,
    items: results.map(MokaPersist.slimScreeningItem)
  };
  try {
    const store = {};
    store[lastScreeningKey()] = payload;
    store[MokaPersist.LAST_ACTIVE_SCREENING_KEY] = payload;
    chrome.storage.local.set(store);
  } catch (e) { /* ignore */ }
}

let saveScreeningTimer = null;
function schedulePersistLastScreening() {
  if (saveScreeningTimer) return;
  saveScreeningTimer = setTimeout(() => {
    saveScreeningTimer = null;
    persistLastScreening();
  }, 800);
}

function hasLastResults() {
  return new Promise((resolve) => {
    try {
      const keys = [lastScreeningKey(), MokaPersist.LAST_ACTIVE_SCREENING_KEY]
        .filter((k, i, arr) => k && arr.indexOf(k) === i);
      chrome.storage.local.get(keys, (r) => {
        const payload = keys.map((k) => r && r[k]).find((p) => p && Array.isArray(p.items) && p.items.length);
        resolve({
          has: !!payload,
          savedAt: payload && payload.savedAt
        });
      });
    } catch (e) {
      resolve({ has: false });
    }
  });
}

function restoreLastResults() {
  return restoreResultsSilently().then((ok) => {
    if (!ok) return false;
    const when = lastRestoredSavedAt ? new Date(lastRestoredSavedAt).toLocaleString() : '';
    publishResults(`上次结果${when ? '（' + when + '）' : ''}，共 ${results.length} 位`, null, { flush: true });
    return true;
  });
}

function exportResultsCsv(feedbackByAppId) {
  if (!results.length) {
    updatePanelStatus('暂无结果可导出');
    return;
  }
  const csv = MokaPersist.screeningToCsv(results, location.origin, feedbackByAppId);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `moka-筛选-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resolveMustHaveItemKey(raw, input) {
  const key = String(input || '').trim();
  if (!key || !raw || !Array.isArray(raw.mustHaveResults)) return key;
  const unmet = raw.mustHaveResults.filter((r) => r && String(r.item || '').trim() && !r.met);
  if (unmet.some((r) => String(r.item).trim() === key)) return key;
  const hit = unmet.find((r) => {
    const item = String(r.item || '').trim();
    return item && (key.includes(item) || item.includes(key));
  });
  return hit ? String(hit.item).trim() : key;
}

/** 单人忽略 / 恢复某条自增硬性：加回或重新扣除该条 −5，再按新分排序 */
function setMustHaveWaived(item, mustHaveItem, waived, weights) {
  const w = weights || activeWeights;
  if (!item || !item.rawScore || !w) return false;
  const key = resolveMustHaveItemKey(item.rawScore, mustHaveItem);
  if (!key) return false;
  if (!item.waivedMustHaves) item.waivedMustHaves = new Set();
  if (waived) item.waivedMustHaves.add(key);
  else item.waivedMustHaves.delete(key);
  ensureHardLocal(item);
  item.score = composeFinalScore(item.rawScore, w, item.waivedMustHaves, (item.hardLocal && item.hardLocal.missing) || []);
  applyMergedHard(item);
  activeWeights = w;
  updateRow(item);
  scheduleSort();
  updateHeaderCount();
  schedulePersistLastScreening();
  return true;
}

function persistLastScreeningNow() {
  if (saveScreeningTimer) {
    clearTimeout(saveScreeningTimer);
    saveScreeningTimer = null;
  }
  persistLastScreening();
}

function savePendingMokaAction(pending) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ action: 'setPendingMokaAction', pending }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (pending && (!resp || !resp.ok)) {
          reject(new Error('保存操作状态失败'));
          return;
        }
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

function loadPendingMokaAction() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getPendingMokaAction' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp && resp.pending ? resp.pending : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function clearPendingMokaAction() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'clearPendingMokaAction' }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function pipelineIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('pipelineId') || '';
  } catch (e) {
    return '';
  }
}

function screeningStorageKey(pipelineId) {
  const pid = pipelineId
    || lastKnownPipelineId
    || (parsePageContext() && parsePageContext().pipelineId);
  return MokaPersist.lastScreeningStorageKey(pid);
}

function restoreResultsFromStorageKey(key, requiredJobId) {
  return new Promise((resolve) => {
    if (!key) {
      resolve(false);
      return;
    }
    try {
      chrome.storage.local.get(key, (r) => {
        const payload = r && r[key];
        if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
          resolve(false);
          return;
        }
        if (requiredJobId && !MokaPersist.screeningPayloadMatchesJob(payload, requiredJobId)) {
          resolve(false);
          return;
        }
        restoreResultsFromPayload(payload);
        resolve(true);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function restoreResultsSilently(pipelineId, requiredJobId) {
  const primary = screeningStorageKey(pipelineId);
  return restoreResultsFromStorageKey(primary, requiredJobId).then((ok) => {
    if (ok) return true;
    if (primary === MokaPersist.LAST_ACTIVE_SCREENING_KEY) {
      return restoreFromLatestScreeningKey(requiredJobId);
    }
    return restoreResultsFromStorageKey(MokaPersist.LAST_ACTIVE_SCREENING_KEY, requiredJobId).then((activeOk) => {
      if (activeOk) return true;
      return restoreFromLatestScreeningKey(requiredJobId);
    });
  });
}

function restoreFromLatestScreeningKey(requiredJobId) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (all) => {
        if (!all) {
          resolve(false);
          return;
        }
        const prefix = MokaPersist.LAST_SCREENING_PREFIX;
        const activeKey = MokaPersist.LAST_ACTIVE_SCREENING_KEY;
        let best = null;
        Object.keys(all).forEach((key) => {
          if (!key.startsWith(prefix) || key === activeKey) return;
          const payload = all[key];
          if (!payload || !Array.isArray(payload.items) || !payload.items.length) return;
          if (requiredJobId && !MokaPersist.screeningPayloadMatchesJob(payload, requiredJobId)) return;
          if (!best || (payload.savedAt || 0) > (best.savedAt || 0)) {
            best = payload;
          }
        });
        if (!best) {
          resolve(false);
          return;
        }
        restoreResultsFromPayload(best);
        resolve(true);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function pageJobIdFromContext() {
  const ctx = parsePageContext();
  // URL 有 jobIds 时以 URL 为准，避免旧搜索捕获把职位 ID 拉回上一岗
  if (ctx && ctx.jobIds[0]) return String(ctx.jobIds[0]);
  if (capturedRequest) {
    try {
      const body = JSON.parse(capturedRequest.body || '{}');
      if (body.jobIds && body.jobIds[0]) return String(body.jobIds[0]);
    } catch (e) { /* ignore */ }
  }
  return '';
}

function resultsBelongToPageJob(pageJobId) {
  if (!results.length) return true;
  if (!pageJobId || pageJobId === 'current') return true;
  const cfgJob = lastScreenConfig && lastScreenConfig.jobId;
  return !!(cfgJob && String(cfgJob) === String(pageJobId));
}

async function alignResultsForPageJob() {
  if (isScreening || mokaActionActive || mokaActionBusy) return;
  const pageJobId = pageJobIdFromContext();
  const pipelineId = (parsePageContext() && parsePageContext().pipelineId) || lastKnownPipelineId || '';
  if (pageJobId && !resultsBelongToPageJob(pageJobId)) {
    results = [];
    if (lastScreenConfig && String(lastScreenConfig.jobId) !== String(pageJobId)) {
      lastScreenConfig = null;
      activeWeights = null;
    }
    lastUiStatus = '';
    lastBanner = null;
  }
  if (!results.length) {
    await restoreResultsSilently(pipelineId, pageJobId || undefined);
  }
}

function loadListUrlFromStorage(pipelineId) {
  return new Promise((resolve) => {
    const key = screeningStorageKey(pipelineId);
    if (!key) {
      resolve(lastListUrl || '');
      return;
    }
    try {
      chrome.storage.local.get(key, (r) => {
        const payload = r && r[key];
        const url = (payload && payload.listUrl) || lastListUrl || '';
        if (url) lastListUrl = url;
        resolve(url);
      });
    } catch (e) {
      resolve(lastListUrl || '');
    }
  });
}

async function resolveListUrl(pipelineId) {
  if (isOnListPage()) {
    lastListUrl = location.href;
    return location.href;
  }
  if (lastListUrl) return lastListUrl;
  return loadListUrlFromStorage(pipelineId);
}

function scheduleMokaNavigation(fn) {
  setTimeout(fn, 150);
}

async function waitForDomReady(timeoutMs) {
  if (document.body && (document.readyState === 'complete' || document.readyState === 'interactive')) {
    return;
  }
  await new Promise((resolve, reject) => {
    const ms = timeoutMs || 20000;
    const timer = setTimeout(() => reject(new Error('页面加载超时')), ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      done();
      return;
    }
    window.addEventListener('DOMContentLoaded', done, { once: true });
    window.addEventListener('load', done, { once: true });
  });
}

function candidateUrlFor(appId, listUrl) {
  const search = listUrl ? (function () {
    try { return new URL(listUrl).search; } catch (e) { return location.search; }
  })() : location.search;
  return location.origin + MokaMatch.candidateOpenPath(appId, search);
}

function isOnCandidatePage(appId) {
  return location.pathname.indexOf('/candidates/application/' + String(appId)) !== -1;
}

function isOnListPage() {
  return location.pathname.indexOf('/candidates/application/') === -1
    && location.href.indexOf('pipelineId=') !== -1;
}

async function ensureResultsLoaded(pipelineId) {
  if (results.length) return true;
  return restoreResultsSilently(pipelineId);
}

function notifyMokaActionComplete(payload) {
  chrome.runtime.sendMessage(Object.assign({ action: 'mokaActionComplete' }, payload)).catch(() => {});
}

async function runMokaActionOnPage(action) {
  if (action === 'recommend') await MokaActions.automateRecommend(document);
  else if (action === 'eliminate') await MokaActions.automateEliminate(document);
  else throw new Error('未知操作类型');
  await MokaActions.sleep(700);
}

function mokaActionStatusText(action) {
  return action === 'recommend' ? '正在 Moka 中推荐给用人部门…' : '正在 Moka 中淘汰…';
}

async function publishWithResults(statusText, banner, pipelineId) {
  await ensureResultsLoaded(pipelineId);
  publishResults(statusText, banner, { flush: true });
}

async function bootstrapResultsIfEmpty() {
  if (results.length) return;
  if (await loadPendingMokaAction()) return;
  const restored = await restoreResultsSilently();
  if (restored) publishResults(undefined, undefined, { flush: true });
}

function clearPendingMokaActionLocal() {
  mokaActionActive = false;
  return clearPendingMokaAction();
}

async function resumePendingMokaAction() {
  const pending = await loadPendingMokaAction();
  if (!pending) return { ok: false, skipped: true, reason: 'no-pending' };

  if (MokaActions.pendingActionState(pending, Date.now()) === 'stale') {
    await clearPendingMokaActionLocal();
    await restoreResultsSilently(pending.pipelineId);
    publishResults('❌ Moka 操作超时，请手动操作或重试', undefined, { flush: true });
    notifyMokaActionComplete({
      ok: false,
      error: 'Moka 操作超时，请手动操作或重试',
      appId: pending.appId,
      type: pending.action
    });
    return { ok: false, error: '操作超时' };
  }

  if (mokaActionBusy) return { ok: false, skipped: true, reason: 'busy' };
  mokaActionBusy = true;
  mokaActionActive = true;

  try {
    if (pending.phase === 'executing') {
      // 页面重载后 phase 可能仍为 executing；同页 busy 才跳过，否则继续点按钮
      if (!isOnCandidatePage(pending.appId)) {
        pending.phase = 'candidate';
        pending.ts = Date.now();
        await savePendingMokaAction(pending);
        scheduleMokaNavigation(() => {
          location.href = candidateUrlFor(pending.appId, pending.listUrl);
        });
        return { ok: true, navigating: 'candidate' };
      }
      await publishWithResults(mokaActionStatusText(pending.action), undefined, pending.pipelineId);
      await waitForDomReady();
      await MokaActions.sleep(2000);
      await runMokaActionOnPage(pending.action);
      pending.phase = 'list';
      pending.ts = Date.now();
      await savePendingMokaAction(pending);
      scheduleMokaNavigation(() => {
        location.href = pending.listUrl;
      });
      return { ok: true, phase: 'list-navigate' };
    }

    if (pending.phase === 'candidate') {
      if (!isOnCandidatePage(pending.appId)) {
        scheduleMokaNavigation(() => {
          location.href = candidateUrlFor(pending.appId, pending.listUrl);
        });
        return { ok: true, navigating: 'candidate' };
      }
      pending.phase = 'executing';
      pending.ts = Date.now();
      await savePendingMokaAction(pending);
      await publishWithResults(mokaActionStatusText(pending.action), undefined, pending.pipelineId);
      await waitForDomReady();
      await MokaActions.sleep(2000);
      await runMokaActionOnPage(pending.action);
      pending.phase = 'list';
      pending.ts = Date.now();
      await savePendingMokaAction(pending);
      scheduleMokaNavigation(() => {
        location.href = pending.listUrl;
      });
      return { ok: true, phase: 'list-navigate' };
    }

    if (pending.phase === 'list') {
      if (!isOnListPage()) {
        if (pending.listUrl) {
          scheduleMokaNavigation(() => { location.href = pending.listUrl; });
        }
        return { ok: true, navigating: 'list' };
      }
      const done = Object.assign({}, pending);
      await clearPendingMokaActionLocal();
      await restoreResultsSilently(done.pipelineId);
      publishResults('Moka 操作完成', undefined, { flush: true });
      notifyMokaActionComplete({
        ok: true,
        appId: done.appId,
        type: done.action
      });
      return { ok: true, complete: true };
    }
  } catch (err) {
    const msg = (err && err.message) || 'Moka 操作失败';
    const failed = Object.assign({}, pending);
    await clearPendingMokaActionLocal();
    if (failed.listUrl && !isOnListPage()) {
      scheduleMokaNavigation(() => { location.href = failed.listUrl; });
    }
    await restoreResultsSilently(failed.pipelineId);
    publishResults('❌ ' + msg, undefined, { flush: true });
    notifyMokaActionComplete({
      ok: false,
      error: msg,
      appId: failed.appId,
      type: failed.action
    });
    return { ok: false, error: msg };
  } finally {
    mokaActionBusy = false;
  }
  return { ok: false, skipped: true, reason: 'unknown-phase' };
}

async function handleMokaAction(appId, type) {
  if (mokaActionBusy) return { ok: false, error: '上一位候选人操作尚未完成，请稍候' };
  if (isScreening) return { ok: false, error: '筛选进行中，请稍后再操作' };
  const existing = await loadPendingMokaAction();
  const existingState = MokaActions.pendingActionState(existing, Date.now());
  if (existingState === 'active') {
    return { ok: false, error: '上一位候选人操作尚未完成，请稍候' };
  }
  if (existingState === 'stale') {
    await clearPendingMokaActionLocal();
  }
  const action = String(type || '').trim();
  if (action !== 'recommend' && action !== 'eliminate') {
    return { ok: false, error: '未知操作类型' };
  }
  const id = String(appId);
  mokaActionBusy = true;
  try {
    persistLastScreeningNow();
    const ctx = parsePageContext();
    const pipelineId = (ctx && ctx.pipelineId) || pipelineIdFromUrl(location.href);
    const listUrl = await resolveListUrl(pipelineId);
    if (!listUrl) {
      return { ok: false, error: '无法定位列表页，请回到 Moka 候选人列表后重试' };
    }
    lastListUrl = listUrl;

    const pending = {
      appId: id,
      action,
      listUrl,
      pipelineId,
      phase: 'candidate',
      ts: Date.now(),
      nonce: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    };
    await savePendingMokaAction(pending);
    mokaActionActive = true;
    await publishWithResults(mokaActionStatusText(action), undefined, pipelineId);

    scheduleMokaNavigation(() => {
      mokaActionBusy = false;
      if (isOnCandidatePage(id)) {
        resumePendingMokaAction().catch((e) => console.warn('[Moka 筛选] resume pending action:', e));
      } else {
        location.href = candidateUrlFor(id, listUrl);
      }
    });

    return { ok: true, pending: true, type: action, appId: id };
  } catch (err) {
    mokaActionBusy = false;
    mokaActionActive = false;
    const msg = (err && err.message) || 'Moka 操作失败';
    await clearPendingMokaActionLocal();
    await restoreResultsSilently();
    publishResults('❌ ' + msg, undefined, { flush: true });
    return { ok: false, error: msg };
  }
}

async function handleWaiveMustHave(appId, mustHaveItem, waived) {
  const item = await findResultOrRestore(appId);
  if (!item) {
    return { ok: false, error: '未找到该候选人，请刷新 Moka 页面或重新筛选' };
  }
  await ensureScreenConfig();
  const weights = activeWeights
    || (lastScreenConfig && lastScreenConfig.weights)
    || normalizeWeights(null);
  if (!item.rawScore) {
    return { ok: false, error: '无法忽略：缺少评分数据，请重评该候选人' };
  }
  const ok = setMustHaveWaived(item, mustHaveItem, waived, weights);
  if (!ok) {
    return { ok: false, error: '无法忽略：缺少权重配置，请重新跑一轮筛选' };
  }
  persistLastScreeningNow();
  publishResults(undefined, undefined, { flush: true });
  return { ok: true };
}

function restoreResultsFromPayload(payload) {
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) return false;
  activeWeights = payload.weights || activeWeights;
  lastScreenConfig = payload.screenConfig || lastScreenConfig;
  if (lastScreenConfig && lastScreenConfig.jobName) lastKnownJobName = String(lastScreenConfig.jobName);
  else if (lastKnownJobName && lastScreenConfig) {
    lastScreenConfig = Object.assign({}, lastScreenConfig, { jobName: lastKnownJobName });
  }
  if (payload.pipelineId) lastKnownPipelineId = String(payload.pipelineId);
  if (payload.listUrl) lastListUrl = payload.listUrl;
  lastRestoredSavedAt = payload.savedAt || null;
  results = payload.items.map(MokaPersist.hydrateScreeningItem);
  results.forEach((item) => {
    ensureHardLocal(item);
    applyMergedHard(item);
  });
  return true;
}

function ensureScreenConfig() {
  return new Promise((resolve) => {
    if (lastScreenConfig) {
      resolve(lastScreenConfig);
      return;
    }
    restoreResultsSilently().then(() => resolve(lastScreenConfig));
  });
}

function findResultOrRestore(appId) {
  const direct = findResult(appId);
  if (direct) return Promise.resolve(direct);
  return ensureScreenConfig().then(() => findResult(appId));
}

async function handleRescore(appId) {
  const item = await findResultOrRestore(appId);
  if (!item) {
    return { ok: false, error: '未找到该候选人，请刷新 Moka 页面或重新筛选' };
  }
  const cfg = await ensureScreenConfig();
  if (!cfg) {
    return { ok: false, error: '无法重评：请重新跑一轮筛选' };
  }
  await rescoreItem(item);
  publishResults(undefined, undefined, { flush: true });
  if (item.score && item.score.level === '错误') {
    const msg = (item.rawScore && (item.rawScore.error || (item.rawScore.concerns && item.rawScore.concerns[0])))
      || '评分仍失败';
    return { ok: false, error: msg };
  }
  return { ok: true };
}

async function rescoreItem(item) {
  if (!item || !item.app || item.__rescoring) return;
  const cfg = lastScreenConfig;
  if (!cfg) return;
  const weights = cfg.weights || activeWeights || normalizeWeights(null);
  item.__rescoring = true;
  publishResults(undefined, undefined, { flush: true });
  if (item.app) item.app.__enriched = false;
  try {
    setRowStage(item.app.id, 'enrich');
    await enrichCandidate(item.app);
    item.profile = buildCandidateProfile(item.app);
    item.hardLocal = evaluateHardConditions(item.app, cfg.hc, cfg.jobType);
    item.hard = item.hardLocal;
    item.graduationRisk = MokaMatch.graduationRiskHint(item.app && item.app.educationInfo, {
      jobType: cfg.jobType,
      now: new Date()
    });
    item.keywords = { hit: [], miss: [] };
    applyHardToRow(item);
    applyKeywordTags(item);
    setRowStage(item.app.id, 'score');
    const fbBundle = await loadFeedbackBundle(cfg.jobId);
    const raw = await scoreViaBackgroundWithRetry(item.profile, {
      jobType: cfg.jobType,
      jobSpec: cfg.jobSpec,
      jobJD: cfg.jobJD,
      hardText: cfg.hardText,
      feedbackContext: fbBundle.context,
      feedbackRev: fbBundle.rev
    });
    applyScoreResult(item, raw, weights);
  } catch (err) {
    applyScoreResult(item, { dimensions: null, error: (err && err.message) || '重评失败' }, weights);
  } finally {
    item.__rescoring = false;
    clearRowStage(item.app.id);
  }
  updateRow(item);
  applyKeywordTags(item);
  applyPanelFilter();
  scheduleSort();
  persistLastScreening();
}

function reportProgress(current, total, percentage, message) {
  if (isScreening) touchScreeningHeartbeat();
  chrome.runtime.sendMessage({ action: 'updateProgress', current, total, percentage, message }).catch(() => {});
}

/* ---------------- 侧栏快照（页面不再注入浮层） ---------------- */

function findResult(appId) {
  const id = String(appId);
  return results.find((r) => r.app && String(r.app.id) === id);
}

function buildResultsSnapshot() {
  const ctx = parsePageContext();
  const pageJobId = ctx && ctx.jobIds[0] ? String(ctx.jobIds[0]) : '';
  const resultJobId = (lastScreenConfig && lastScreenConfig.jobId) || '';
  const pipelineId = (ctx && ctx.pipelineId) || lastKnownPipelineId || '';
  return {
    action: 'resultsUpdated',
    status: lastUiStatus,
    banner: lastBanner,
    // 上报「可信的进行中」：卡死的旧任务不再让侧栏按钮一直禁用
    screening: screeningLooksActive(),
    jobId: resultJobId,
    jobName: resolveJobDisplayName(resultJobId) || lastKnownJobName || '',
    pageJobId,
    resultJobId,
    resultContextKey: MokaPersist.resultContextKey(pipelineId, resultJobId),
    resultMismatch: !!(pageJobId && resultJobId && pageJobId !== resultJobId),
    items: MokaMatch.sortResultViews(results.map((item) => MokaMatch.toResultView(item)))
  };
}

let publishTimer = null;
function publishResults(statusText, banner, opts) {
  if (isScreening) touchScreeningHeartbeat();
  if (statusText !== undefined) lastUiStatus = statusText;
  if (banner !== undefined) lastBanner = banner;
  const send = () => {
    publishTimer = null;
    chrome.runtime.sendMessage(buildResultsSnapshot()).catch(() => {});
  };
  if (opts && opts.flush) {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    send();
    return;
  }
  if (publishTimer) return;
  publishTimer = setTimeout(send, 120);
}

function resetResultUi() {
  lastBanner = null;
  publishResults('准备中...', null, { flush: true });
}

function updatePanelStatus(text) {
  publishResults(text);
}

function buildRows() {
  publishResults(undefined, undefined, { flush: true });
}

function applyHardToRow() {
  publishResults();
}

function applyKeywordTags() {
  publishResults();
}

function applyPanelFilter() {
  publishResults();
}

function updateRow() {
  publishResults();
}

function updateHeaderCount() {
  publishResults();
}

function scheduleSort() {
  if (sortTimer) return;
  sortTimer = setTimeout(() => {
    sortTimer = null;
    publishResults();
  }, 800);
}

function sortRows() {
  publishResults(undefined, undefined, { flush: true });
}

function setRowStage(appId, stageKey) {
  const item = findResult(appId);
  if (!item) return;
  item.stage = stageKey;
  publishResults();
}

function clearRowStage(appId) {
  const item = findResult(appId);
  if (!item) return;
  item.stage = null;
  publishResults();
}

function openCandidate(appId) {
  if (appId == null || appId === '') return false;
  const url = location.origin + MokaMatch.candidateOpenPath(appId, location.search);
  window.open(url, '_blank');
  return true;
}

function showDetailBanner() {
  publishResults(undefined, { type: 'need-click' }, { flush: true });
}

function markDetailBannerReady() {
  if (!lastBanner || lastBanner.type !== 'need-click') return;
  publishResults(undefined, { type: 'ready' }, { flush: true });
  setTimeout(() => {
    if (lastBanner && lastBanner.type === 'ready') publishResults(undefined, null, { flush: true });
  }, 2500);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluateHardConditions };
}

init();

console.log('[Moka 筛选] Content script 初始化完成');
