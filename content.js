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
/**
 * 评分并发数：默认 6，可由「连接与模型 → 评分并发数」设置（1–8）覆盖；
 * 开筛时经 modelPriceInfo 拉到生效值写入 scoreConcurrency。
 */
const DEFAULT_SCORE_CONCURRENCY = 6;
const MIN_SCORE_CONCURRENCY = 1;
const MAX_SCORE_CONCURRENCY = 8;
let scoreConcurrency = DEFAULT_SCORE_CONCURRENCY;

function normalizeScoreConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCORE_CONCURRENCY;
  return Math.min(MAX_SCORE_CONCURRENCY, Math.max(MIN_SCORE_CONCURRENCY, Math.round(n)));
}
const DEFAULT_LIMIT = 30;
const MAX_PAGES = 300; // 安全上限：300 页 × 30 ≈ 9000 人
const MOKA_TIMEOUT_MS = 25000;
const FETCH_RETRIES = 3; // 单页抓取失败最多重试次数
const FETCH_BASE_DELAY_MS = 600; // 指数退避基数
const FETCH_MAX_DELAY_MS = 6000; // 单次退避上限（防止长时间占用筛选窗口）

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

/**
 * 单页抓取 + 重试：对超时/断网/429/5xx 做指数退避重试，
 * 其余 4xx（如 401/403 会话失效）立即失败，避免无意义重试。
 * 筛选被停止（isAlive 为 false）时返回 null，由分页循环优雅收尾。
 */
async function fetchPageWithRetry(url, options, isAlive) {
  let lastErr = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (isAlive && !isAlive()) return null; // 用户已停止：不再重试
    let resp = null;
    try {
      resp = await fetchWithTimeout(url, options);
    } catch (e) {
      lastErr = e;
      resp = null;
    }
    if (resp && resp.ok) return resp;
    lastStatus = resp ? resp.status : 0;
    // 非限流类 4xx：会话失效/参数错误重试无意义
    if (resp && lastStatus !== 429 && lastStatus < 500) {
      throw new Error(`候选人接口错误: ${lastStatus}`);
    }
    if (attempt >= FETCH_RETRIES) break;
    const base = FETCH_BASE_DELAY_MS * Math.pow(2, attempt);
    const delay = Math.min(base, FETCH_MAX_DELAY_MS) + Math.round(base * 0.25 * Math.random());
    await sleep(delay);
  }
  if (lastErr) {
    throw new Error(`候选人接口多次请求失败（已重试 ${FETCH_RETRIES} 次，最后错误：${lastErr.message}）`);
  }
  throw new Error(`候选人接口错误: ${lastStatus || '无响应'}（已重试 ${FETCH_RETRIES} 次）`);
}

let isScreening = false;
let screeningStartedAt = 0;
let screeningEpoch = 0;
let screeningHeartbeat = 0; // 最近一次筛选活动时间；用于识别「卡死的旧任务」
let runUsage = MokaUsage.emptyUsage(); // 本轮筛选的 LLM 用量/费用（续筛时从任务快照恢复）

function resetRunUsage() {
  runUsage = MokaUsage.emptyUsage();
}

function seedRunUsageFromJob(job) {
  runUsage = MokaUsage.normalizeUsage(job && job.usage);
}

/** 向后台取当前生效模型单价与评分运行时参数（并发数），写入 runUsage 供本地估算 */
function refreshRunPriceInfo() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'modelPriceInfo' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          resolve(null);
          return;
        }
        runUsage.price = response.price
          ? { inputPerM: response.price.inputPerM, outputPerM: response.price.outputPerM, priced: true }
          : null;
        if (response.model) runUsage.model = String(response.model);
        if (response.concurrency != null) scoreConcurrency = normalizeScoreConcurrency(response.concurrency);
        resolve(response);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

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

// 接口观测流水：inject.js 推过来的 POST 请求记录（只记不拦），用于发现批量操作等
// 未识别接口。仅存内存，页面刷新即清空；上限截断防止筛选分页时无限膨胀。
const REQUEST_LOG_LIMIT = 80;
const requestLog = [];

// 插件运行日志（会话级，background 统一沉淀最近 100 条，设置页「运行日志」面板可看）：
// 高频请求流水先入队按批发送，避免每条都开一次消息通道；低频事件顺带搭同一趟车。
const PLUGIN_LOG_FLUSH_MS = 500;
const PLUGIN_LOG_BATCH_MAX = 12;
const pluginLogQueue = [];
let pluginLogFlushTimer = null;

function flushPluginLog() {
  pluginLogFlushTimer = null;
  if (!pluginLogQueue.length) return;
  const batch = pluginLogQueue.splice(0, pluginLogQueue.length);
  try {
    chrome.runtime.sendMessage({ action: 'pluginLog', entry: batch }).catch(() => {});
  } catch (e) { /* 日志通道失败不影响主流程 */ }
}

function pushPluginLog(raw) {
  if (!raw || !raw.cat || raw.text == null) return;
  pluginLogQueue.push(raw);
  if (pluginLogQueue.length >= PLUGIN_LOG_BATCH_MAX) {
    if (pluginLogFlushTimer) { clearTimeout(pluginLogFlushTimer); pluginLogFlushTimer = null; }
    flushPluginLog();
    return;
  }
  if (!pluginLogFlushTimer) pluginLogFlushTimer = setTimeout(flushPluginLog, PLUGIN_LOG_FLUSH_MS);
}

// 批量分配（本 org 的推进动作）捕获：模板 + 分配对象，按职位分桶持久化，
// 跨页面刷新恢复；换职位必须用该职位自己的分配对象，防止跨职位串用
const ASSIGNMENT_CAPTURE_KEY = 'mokaCapturedAssignment';
const ASSIGNMENT_CAPTURE_LIMIT = 10; // 最多记住最近 10 个职位各自的分配对象
const JOB_PIPELINE_MAP_KEY = 'mokaPipelineNameMapV3'; // pipelineId → 职位名（分配对象按「职位名」锚定）
let capturedAssignment = null;      // 当前职位的 { url, headers, body }
let capturedAssignmentPipelineId = ''; // capturedAssignment 所属的职位
let capturedAssignmentSavedAt = 0; // 该条分配记录的捕获时间（配置页展示用）
let lastAssigneeIds = [];           // 当前职位最近一次手动批量分配的对象 id 列表

// 成员姓名映射：从「非候选人」接口的 JSON 响应里收割 {数字 id → 姓名}，
// 供配置页/批量推进确认时把分配对象显示成名字。持久化，跨页面刷新可用。
const MEMBER_NAMES_KEY = 'mokaMemberNames';
const MEMBER_NAMES_LIMIT = 600;
const MEMBER_NAME_SKIP_RE = /search-candidate|\/api\/applications\/\d+/;
const memberNames = new Map();

/** 从一段 JSON 响应里收割 id→姓名；返回新增条数。限制遍历规模防大响应卡顿 */
function harvestMemberNames(url, text) {
  const u = String(url || '');
  if (!u || MEMBER_NAME_SKIP_RE.test(u)) return 0;
  let json;
  try { json = JSON.parse(text); } catch (e) { return 0; }
  let added = 0;
  const queue = [json];
  let seen = 0;
  while (queue.length && seen < 4000) {
    seen++;
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      queue.push.apply(queue, cur.slice(0, 200));
      continue;
    }
    const id = cur.id != null ? Number(cur.id) : (cur.userId != null ? Number(cur.userId) : NaN);
    const name = String(cur.name || cur.userName || cur.realName || cur.nickname
      || cur.chineseName || cur.displayName || cur.employeeName || cur.trueName || '').trim();
    if (Number.isInteger(id) && id >= 10000 && name && name.length <= 20
      && !memberNames.has(String(id))) {
      memberNames.set(String(id), name);
      added++;
      if (memberNames.size > MEMBER_NAMES_LIMIT) {
        memberNames.delete(memberNames.keys().next().value);
      }
    }
    Object.keys(cur).forEach((k) => {
      const v = cur[k];
      if (v && typeof v === 'object') queue.push(v);
    });
  }
  if (added) {
    persistMemberNames();
    // 收割结果进流水（设置页可复制），失败/成功都有迹可循
    logCapturedRequest({
      url: '[member-harvest] ' + u,
      body: '+' + added + ' 个 id→姓名（映射总数 ' + memberNames.size + '）',
      at: Date.now()
    });
  }
  return added;
}

let memberNamesSaveTimer = null;
function persistMemberNames() {
  clearTimeout(memberNamesSaveTimer);
  memberNamesSaveTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({ [MEMBER_NAMES_KEY]: Object.fromEntries(memberNames) });
    } catch (e) { /* ignore */ }
  }, 500);
}

function restoreMemberNames() {
  try {
    chrome.storage.local.get(MEMBER_NAMES_KEY, (res) => {
      try {
        if (chrome.runtime.lastError) return;
        const stored = res && res[MEMBER_NAMES_KEY];
        if (stored && typeof stored === 'object') {
          Object.keys(stored).forEach((k) => {
            if (!memberNames.has(k) && typeof stored[k] === 'string') memberNames.set(k, stored[k]);
          });
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

/** 当前职位的分配对象 id 对应的姓名（查不到的返回空串，保持与 id 顺序对齐） */
function assigneeIdNames() {
  return lastAssigneeIds.map((id) => memberNames.get(String(id)) || '');
}

// 弹窗芯片刮到的人名集合（顺序与 id 无对应关系，仅作整组展示）
let lastAssigneeNames = [];

/** 弹窗刮到的名字 → 可采信的姓名集合：去重清洗后数量必须与分配 id 数一致 */
function validAssigneeNames(scraped, count) {
  if (!Array.isArray(scraped) || !count) return [];
  const clean = [];
  (scraped || []).forEach((n) => {
    const t = String(n || '').trim();
    if (t && t.length <= 12 && clean.indexOf(t) === -1) clean.push(t);
  });
  return clean.length === count ? clean : [];
}

/** 展示用姓名：id→姓名 能凑齐优先（逐人精确）；凑不齐但弹窗刮到了整组名字则用整组 */
function resolveAssigneeNamesForDisplay() {
  const resolved = assigneeIdNames();
  if (lastAssigneeIds.length && resolved.every(Boolean)) return resolved;
  if (lastAssigneeNames.length === lastAssigneeIds.length && lastAssigneeNames.length) {
    return lastAssigneeNames;
  }
  return resolved;
}

/** 单点推荐走其它接口时：弹窗人名与本岗已记录的分配 id 完全对上才落库展示 */
function storeRecommendNames(payload) {
  if (!payload || typeof payload.body !== 'string') return;
  const ids = MokaBatch.extractAssigneeIds(payload.body);
  const names = pickValidAssigneeNames(payload.scrapedNames, payload.pageWideNames, ids.length);
  if (!ids.length || !names.length) return;
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  if (capturedAssignmentPipelineId === String(pipelineId)
    && lastAssigneeIds.join(',') === ids.join(',')) {
    lastAssigneeNames = names;
  }
  bindSingleAssigneeName(ids, names);
  seedMemberNamesFromPairs(payload.pairs);
  readAssignmentStore((captures) => {
    const entry = captures[pipelineId];
    if (entry && Array.isArray(entry.assigneeIds)
      && entry.assigneeIds.join(',') === ids.join(',')) {
      entry.assigneeNames = names;
      try {
        chrome.storage.local.set({ [ASSIGNMENT_CAPTURE_KEY]: { captures } });
      } catch (e) { /* ignore */ }
    }
  });
}

/** 单元素是否像「人名芯片」：名字纯文本形态（× 是图标）时，需芯片本身/
 *  紧邻兄弟带关闭图标类名，或芯片类名像 tag/chip 组件。防止把「确定」误当姓名。 */
function chipLikeNameElement(el) {
  try {
    const CLOSE_HINT_RE = /close|cross|del|remove|clear|closable/i;
    const CHIP_HINT_RE = /tag|chip|closable|selected[-_]?item|member[-_]?item|assign/i;
    const classOf = (node) => {
      try { return String((node && node.getAttribute && node.getAttribute('class')) || ''); }
      catch (e) { return ''; }
    };
    const sib = el && el.nextElementSibling;
    if (CLOSE_HINT_RE.test(classOf(el)) || CLOSE_HINT_RE.test(classOf(sib))) return true;
    if (el.querySelector('[class*="close"],[class*="cross"],[class*="del"],[class*="remove"],[class*="clear"]')) return true;
    return CHIP_HINT_RE.test(classOf(el));
  } catch (e) {
    return false;
  }
}

/** 从元素收集芯片姓名（文本 × 形态 + 纯名字+图标佐证形态），返回去重数组 */
function collectChipNamesFrom(el, out, seen) {
  try {
    const t = String(el.textContent || '').trim();
    let m = t.match(/^([\u4e00-\u9fa5A-Za-z0-9·]{1,12})\s*[×✕⨯✖xX]$/); // 形态一：文本 ×
    if (!m) {
      m = t.match(/^([\u4e00-\u9fa5A-Za-z0-9·]{1,12})$/);               // 形态二：× 是图标
      if (m && !chipLikeNameElement(el)) m = null;
    }
    if (m && !seen[m[1]]) {
      seen[m[1]] = 1;
      out.push(m[1]);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

const CHIP_LABEL_SET = ['推荐到', '分配给', '分配对象'];

/** 找「推荐到/分配给/分配对象」标签元素（最多 4 个） */
function findChipLabels() {
  const labels = [];
  try {
    document.querySelectorAll('span,div,label,p,dt').forEach((el) => {
      if (labels.length >= 4) return;
      const t = String(el.textContent || '').trim().replace(/^\*/, '').replace(/[:：]\s*$/, '');
      if (CHIP_LABEL_SET.indexOf(t) !== -1) labels.push(el);
    });
  } catch (e) { /* ignore */ }
  return labels;
}

/** 第一遍：从标签向上 6 层找芯片层（推荐弹窗内）。返回 { labels, names } */
function chipNamesByLabelWalk() {
  const labels = findChipLabels();
  const out = [];
  const seen = {};
  labels.forEach((lb) => {
    let node = lb;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      node = node.parentElement;
      if (!node) break;
      node.querySelectorAll('span,div,li,em,p').forEach((el) => {
        if (labels.indexOf(el) !== -1 || el.children.length > 3) return;
        collectChipNamesFrom(el, out, seen);
      });
      if (out.length) break; // 找到芯片层就停，防止收进弹窗外别的 × 芯片
    }
  });
  return { labels: labels.length, names: out };
}

/** 第二遍：全页兜底扫「文本 ×」与「名字+关闭图标」芯片（标签结构不同时用），
 *  数量由 merge 侧按本岗分配 id 数校验，多收无害（会整组拒掉）。上限 30 防误伤。 */
function chipNamesPageWide() {
  const out = [];
  const seen = {};
  try {
    const all = document.querySelectorAll('span,div,li,em,p');
    for (let i = 0; i < all.length && out.length < 30; i++) {
      const el = all[i];
      if (!el.children || el.children.length > 3) continue;
      collectChipNamesFrom(el, out, seen);
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 实时刮取当前打开的「推荐给用人部门」弹窗芯片姓名。content 与页面共享 DOM，
 *  弹窗开着时配置页点「重新读取」即可直接带出名字，不必等点确认发请求那一刻。
 *  逻辑与 inject.js 的 scrapeRecommendChipNames 保持一致思路（两处需同步维护）。
 *  返回 { labels, anchored, pageWide } —— anchored 第一遍标签邻域，pageWide 全页兜底。 */
function scrapeRecommendChipNamesFromDom() {
  const anchored = chipNamesByLabelWalk();
  const pageWide = chipNamesPageWide();
  return {
    labels: anchored.labels,
    anchored: anchored.names,
    pageWide
  };
}

/** 两路刮取结果的采信顺序：先标签邻域（anchored），凑不齐再用全页兜底（pageWide），
 *  数量必须与分配 id 数一致才采信 */
function pickValidAssigneeNames(anchored, pageWide, count) {
  const first = validAssigneeNames(anchored, count);
  if (first.length) return first;
  return validAssigneeNames(pageWide, count);
}

/** 单人分配时姓名↔id 可唯一对应，把绑定种进成员映射，供后续「采纳姓名」反查 */
function bindSingleAssigneeName(ids, names) {
  if (Array.isArray(ids) && ids.length === 1
    && Array.isArray(names) && names.length === 1 && names[0]) {
    if (!memberNames.has(String(ids[0]))) {
      memberNames.set(String(ids[0]), names[0]);
      persistMemberNames();
    }
  }
}

/** 成员姓名 → id 反查（同名多人视为歧义，不可采纳） */
function resolveIdsForNames(names) {
  const byName = {};
  memberNames.forEach((name, id) => {
    (byName[name] = byName[name] || []).push(Number(id));
  });
  const ids = [];
  const missing = [];
  const ambiguous = [];
  (Array.isArray(names) ? names : []).forEach((n) => {
    const cand = byName[n] || [];
    if (!cand.length) missing.push(n);
    else if (cand.length > 1) ambiguous.push(n);
    else ids.push(cand[0]);
  });
  return { ok: !missing.length && !ambiguous.length, ids, missing, ambiguous };
}

/** 向 MAIN world 按需索要弹窗人选：姓名 + React fiber 里的 id（采纳用） */
let assigneePairsReqSeq = 0;
function requestAssigneePairs() {
  return new Promise((resolve) => {
    const reqId = `ap-${Date.now()}-${++assigneePairsReqSeq}`;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'moka-inject' || data.type !== 'assignee-pairs') return;
      if (!bridgeMessageAccepted(data)) return;
      if (!data.payload || data.payload.reqId !== reqId) return;
      done(data.payload);
    };
    setTimeout(() => done({ names: [], pairs: [] }), 6000);
    window.addEventListener('message', onMessage);
    try {
      window.postMessage({
        source: 'moka-content',
        type: 'scrape-assignee-pairs',
        payload: { reqId }
      }, '*');
    } catch (e) {
      done({ names: [], pairs: [] });
    }
  });
}

/** 把 fiber 抓到的 id→姓名对种进成员映射（最可靠的映射来源） */
function seedMemberNamesFromPairs(pairs) {
  (Array.isArray(pairs) ? pairs : []).forEach((p) => {
    if (p && Number.isInteger(p.id) && p.id > 0 && p.name && p.name.length <= 20) {
      memberNames.set(String(p.id), p.name);
    }
  });
  if (pairs && pairs.length) persistMemberNames();
}

/** 采纳结果写入请求流水（诊断用）：点「确认本岗分配对象」后在流水里必有一行 */
function logAdoptTrace(outcome, detail) {
  requestLog.push({ url: '[adopt] ' + outcome, body: String(detail || ''), at: Date.now() });
  while (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift();
  pushPluginLog({
    cat: 'adopt',
    text: '[adopt] ' + outcome + (detail ? ' ｜ ' + String(detail) : '')
  });
}

/** 配置页「确认本岗分配对象」时采纳弹窗当前人选。采信顺序（系统性）：
 *  ① React fiber 成对姓名（姓名+id 一次拿到，伪姓名混不进来）优先；
 *  ② 标签邻域 + MAIN world 刮到的姓名并集，走成员映射反查兜底。
 *  改写本岗记录的分配对象（模板 url/headers/resumeType 沿用）。改写后批量
 *  推进重放与确认的姓名严格一致。
 *  返回 { ok, adopted, reason?, names, ids?, missing?, ambiguous? } */
function adoptScrapedAssignees() {
  return Promise.all([
    loadAssignmentForCurrentPipeline(),
    requestAssigneePairs()
  ]).then((results) => {
    const template = results[0];
    const live = results[1] || {};
    // 先种 fiber 对，再解析：fiber 命中的姓名直接用 fiber id（最可靠）；
    // 其余走成员映射反查（同名多人视为歧义）
    seedMemberNamesFromPairs(live.pairs);
    const byName = {};
    (Array.isArray(live.pairs) ? live.pairs : []).forEach((p) => {
      if (p && Number.isInteger(p.id) && p.name) {
        (byName[p.name] = byName[p.name] || []).push(p.id);
      }
    });
    const pairNames = Object.keys(byName).filter((n) => byName[n].length === 1);
    let capped = [];
    if (pairNames.length) {
      // ① fiber 成对姓名：每个都自带唯一 id，直接采信
      capped = pairNames.slice(0, 5);
    } else {
      // ② 姓名并集：content 本地刮的 + MAIN world 刮的（去重，保序）
      capped = [];
      const seenName = {};
      const local = chipNamesByLabelWalk();
      (Array.isArray(local.names) ? local.names : []).forEach((n) => {
        if (!seenName[n]) { seenName[n] = 1; capped.push(n); }
      });
      (Array.isArray(live.names) ? live.names : []).forEach((n) => {
        if (!seenName[n]) { seenName[n] = 1; capped.push(n); }
      });
      capped = capped.slice(0, 5);
    }
    if (!capped.length) {
      logAdoptTrace('未采纳', '原因=no-names（弹窗姓名一个都没读到；fiber 对='
        + (Array.isArray(live.pairs) ? live.pairs.length : 0) + '）');
      return { ok: true, adopted: false, reason: 'no-names', names: [] };
    }
    const ids = [];
    const missing = [];
    const ambiguous = [];
    capped.forEach((n) => {
      const fromFiber = byName[n] || [];
      if (fromFiber.length === 1) {
        ids.push(fromFiber[0]);
        return;
      }
      const mappedIds = [];
      memberNames.forEach((name, mid) => {
        if (name === n) mappedIds.push(Number(mid));
      });
      if (fromFiber.length > 1 || mappedIds.length > 1) {
        ambiguous.push(n);
        return;
      }
      if (mappedIds.length === 1) {
        ids.push(mappedIds[0]);
        return;
      }
      missing.push(n);
    });
    if (missing.length || ambiguous.length || !ids.length) {
      logAdoptTrace('未采纳', '原因=' + (missing.length ? 'unknown-names' : 'ambiguous-names')
        + '；names=' + capped.join('/') + '；missing=' + missing.join('/')
        + '；ambiguous=' + ambiguous.join('/') + '；fiber对='
        + (Array.isArray(live.pairs) ? live.pairs.length : 0)
        + '；成员映射=' + memberNames.size);
      return {
        ok: true,
        adopted: false,
        reason: missing.length ? 'unknown-names' : 'ambiguous-names',
        names: capped,
        missing,
        ambiguous
      };
    }
    const pipelineId = currentPipelineId();
    if (!pipelineId || !template) {
      logAdoptTrace('未采纳', '原因=no-record；pipelineId=' + (pipelineId || '空')
        + '；template=' + (template ? '有' : '无') + '；names=' + capped.join('/'));
      return { ok: true, adopted: false, reason: 'no-record', names: capped };
    }
    const entry = {
      template,
      assigneeIds: ids,
      assigneeNames: capped.slice(),
      pipelineId: String(pipelineId),
      jobName: normalizeJobName(pageJobName()),
      savedAt: Date.now()
    };
    if (entry.jobName) rememberJobPipeline(entry.pipelineId, entry.jobName);
    capturedAssignment = template;
    capturedAssignmentPipelineId = String(pipelineId);
    capturedAssignmentSavedAt = entry.savedAt;
    lastAssigneeIds = ids;
    lastAssigneeNames = capped.slice();
    persistAssignmentEntry(entry);
    logAdoptTrace('已采纳', 'names=' + capped.join('/') + '；ids=' + ids.join('/')
      + '；pipelineId=' + pipelineId + '；来源=' + (pairNames.length ? 'fiber对' : '姓名反查'));
    return { ok: true, adopted: true, names: capped, ids };
  }).catch((err) => {
    // 采纳过程本身抛错也要留痕：流水 + 明确错误信息（弹窗侧绝不静默）
    logAdoptTrace('异常', (err && err.stack) ? String(err.stack).split('\n').slice(0, 2).join(' | ')
      : String(err));
    throw err;
  });
}

/** 配置页「重新读取」实时刮到的姓名：先信标签邻域（anchored），凑不齐再用全页兜底
 *  （pageWide），数量与本岗分配 id 对上才采信并落库。返回最终展示姓名。 */
function mergeLiveScrapedAssigneeNames(scraped) {
  return loadAssignmentForCurrentPipeline().then(() => {
    const raw = scraped && typeof scraped === 'object' ? scraped : {};
    const names = pickValidAssigneeNames(
      Array.isArray(raw.anchored) ? raw.anchored : [],
      Array.isArray(raw.pageWide) ? raw.pageWide : [],
      lastAssigneeIds.length
    );
    if (!names.length) return resolveAssigneeNamesForDisplay();
    lastAssigneeNames = names;
    const pipelineId = currentPipelineId();
    if (pipelineId) {
      readAssignmentStore((captures) => {
        const entry = captures[String(pipelineId)];
        if (entry) {
          entry.assigneeNames = names;
          try {
            chrome.storage.local.set({ [ASSIGNMENT_CAPTURE_KEY]: { captures } });
          } catch (e) { /* ignore */ }
        }
      });
    }
    return resolveAssigneeNamesForDisplay();
  });
}

// 尽早监听，避免错过 inject.js 的早期推送

/* ---------------- 桥接握手（nonce，P1-9） ----------------
 * content 生成一次性 nonce 下发给 inject；inject 之后每次上行 push 都回带。
 * 握手确认后 content 只采信带正确 nonce 的消息，页面内其它脚本伪造
 * moka-inject 来源的写操作（篡改经历/分配映射/重放模板）会被丢弃。
 * 确认前（旧 inject / 时序窗口）不校验，保证兼容与功能不断链。 */
let bridgeNonce = '';
let bridgeNonceConfirmed = false;
function bridgeNonceValue() {
  if (!bridgeNonce) bridgeNonce = 'moka-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return bridgeNonce;
}
function sendBridgeInit() {
  try {
    window.postMessage({ source: 'moka-content', type: 'bridge-init', payload: { nonce: bridgeNonceValue() } }, '*');
  } catch (e) { /* ignore */ }
}
function bridgeMessageAccepted(data) {
  return !bridgeNonceConfirmed || (data && data.nonce === bridgeNonce);
}
function startBridgeHandshake() {
  let tries = 0;
  sendBridgeInit();
  const timer = setInterval(() => {
    if (bridgeNonceConfirmed || ++tries > 10) { clearInterval(timer); return; }
    sendBridgeInit();
  }, 500);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'moka-inject') return;
  // 握手回执：inject 收到 nonce 后回 bridge-ready，确认后启用严格校验
  if (data.type === 'bridge-ready') {
    if (data.payload && data.payload.nonce === bridgeNonce) bridgeNonceConfirmed = true;
    return;
  }
  // nonce 校验：确认后丢弃不带/带错 nonce 的伪造消息
  if (!bridgeMessageAccepted(data)) return;
  if (data.type === 'search-request') {
    capturedRequest = data.payload;
    persistCapture();
    // 搜索请求发生在当前页面：pipelineId 来自请求体，职位名来自当前 URL ——
    // 同一页面上下文，可安全建立 pipelineId↔职位名 对应（分配对象锚点）
    try {
      const sbody = JSON.parse(data.payload && data.payload.body ? data.payload.body : '{}');
      if (sbody && sbody.pipelineId) {
        rememberJobPipeline(String(sbody.pipelineId), pageJobName());
      }
    } catch (e) { /* ignore */ }
    // 开筛分页会触发大量 search-request，避免刷换岗通知打断筛选
    if (!isScreening) maybeNotifyPageJobChanged('search-capture');
  } else if (data.type === 'detail-request') {
    const first = !capturedDetailRequest;
    capturedDetailRequest = data.payload;
    markDetailAppSeen(data.payload && data.payload.url);
    persistCapture();
    if (first) { try { markDetailBannerReady(); } catch (e) {} } // 用户点开候选人后，横幅变为「已就绪」
  } else if (data.type === 'detail-data') {
    cacheDetailData(data.payload);
    markDetailAppSeen(data.payload && data.payload.url, data.payload && data.payload.text);
  } else if (data.type === 'scene-token') {
    const s = data.payload && data.payload.scene;
    if (s) harvestedScene = String(s);
  } else if (data.type === 'request-log') {
    logCapturedRequest(data.payload);
  } else if (data.type === 'assignment-request') {
    captureAssignmentRequest(data.payload);
  } else if (data.type === 'member-data') {
    // 选人/组织类接口的响应：收割 id→姓名，供分配对象展示名字
    harvestMemberNames(data.payload && data.payload.url, data.payload && data.payload.text);
  } else if (data.type === 'assignee-names') {
    // 单点推荐等走其它接口的分配：只采信弹窗刮到的人名，不动重放模板
    storeRecommendNames(data.payload);
  }
});

/** 记录一条 POST 流水；超限丢弃最旧的。names = 分配请求时弹窗刮到的姓名（诊断用） */
function logCapturedRequest(entry) {
  if (!entry || !entry.url) return;
  const item = {
    url: String(entry.url),
    body: String(entry.body || ''),
    at: Number(entry.at) || Date.now()
  };
  if (Array.isArray(entry.names)) item.names = entry.names;
  requestLog.push(item);
  while (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift();
  // 同步进插件运行日志：只记接口地址与分配对象名，不记请求体（避免刷屏/夹带大段数据）
  let text = String(entry.url);
  if (Array.isArray(entry.names) && entry.names.length) {
    text += ' · 分配对象=' + entry.names.slice(0, 10).join('/');
  }
  pushPluginLog({ cat: 'req', text, at: item.at });
}

/** 记住批量分配请求模板与分配对象，供「批量推进」直接重放。
 *  分配对象按职位（pipelineId）隔离：每个职位各自记录，换职位必须重新捕获，
 *  避免 A 职位的简历被推进到 B 职位的用人部门。 */
function captureAssignmentRequest(payload) {
  if (!payload || !payload.url || typeof payload.body !== 'string') return;
  const assigneeIds = MokaBatch.extractAssigneeIds(payload.body);
  if (!assigneeIds.length) return; // 无分配对象的请求不具备重放价值
  const pipelineId = currentPipelineId();
  if (!pipelineId) return; // 无法定位职位时不捕获，避免跨职位串用
  const assigneeNames = pickValidAssigneeNames(
    payload.scrapedNames, payload.pageWideNames, assigneeIds.length
  );
  const entry = {
    template: {
      url: String(payload.url),
      headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
      body: payload.body
    },
    assigneeIds,
    assigneeNames,
    pipelineId: String(pipelineId),
    jobName: normalizeJobName(pageJobName()),
    savedAt: Date.now()
  };
  if (entry.jobName) rememberJobPipeline(entry.pipelineId, entry.jobName);
  persistAssignmentEntry(entry);
  capturedAssignment = entry.template;
  capturedAssignmentPipelineId = entry.pipelineId;
  capturedAssignmentSavedAt = entry.savedAt;
  lastAssigneeIds = assigneeIds;
  lastAssigneeNames = assigneeNames;
  bindSingleAssigneeName(assigneeIds, assigneeNames);
  seedMemberNamesFromPairs(payload.pairs);
}

/** 把分配存档写入 storage（按职位分桶 + 超限清理） */
function persistAssignmentEntry(entry) {
  readAssignmentStore((captures) => {
    captures[entry.pipelineId] = entry;
    // 每个职位一份；总数超限时丢弃最旧的职位记录
    const keys = Object.keys(captures)
      .sort((a, b) => (captures[b] && captures[b].savedAt || 0) - (captures[a] && captures[a].savedAt || 0));
    keys.slice(ASSIGNMENT_CAPTURE_LIMIT).forEach((k) => { delete captures[k]; });
    try {
      chrome.storage.local.set({ [ASSIGNMENT_CAPTURE_KEY]: { captures } });
    } catch (e) { /* ignore */ }
  });
}

function currentPipelineId() {
  const ctx = parsePageContext();
  return String((ctx && ctx.pipelineId) || pipelineIdFromUrl(location.href) || lastKnownPipelineId || '');
}

/** 读取按职位分桶的分配模板存储（storage 异步，统一回调出口） */
function readAssignmentStore(cb) {
  try {
    chrome.storage.local.get(ASSIGNMENT_CAPTURE_KEY, (result) => {
      try {
        if (chrome.runtime.lastError) { cb({}); return; }
        const stored = result && result[ASSIGNMENT_CAPTURE_KEY];
        cb(stored && typeof stored === 'object' && stored.captures && typeof stored.captures === 'object'
          ? stored.captures
          : {});
      } catch (e) { cb({}); }
    });
  } catch (e) {
    cb({});
  }
}

/** 职位名归一化：去空白后比较（URL title 与下拉框文案同源，只可能差空白/编码） */
function normalizeJobName(name) {
  return String(name || '').replace(/\s+/g, '');
}

function jobNameMatches(a, b) {
  const x = normalizeJobName(a);
  const y = normalizeJobName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // URL title 可能被截断：一方完整包含另一方且较短者足够长才认
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  return shorter.length >= 4 && longer.indexOf(shorter) !== -1;
}

/** 读取 pipelineId → 职位名 映射（分配对象按「职位名」锚定的辅助索引） */
function readJobPipelineMap(cb) {
  try {
    chrome.storage.local.get(JOB_PIPELINE_MAP_KEY, (result) => {
      try {
        if (chrome.runtime.lastError) { cb({}); return; }
        const stored = result && result[JOB_PIPELINE_MAP_KEY];
        cb(stored && typeof stored === 'object' ? stored : {});
      } catch (e) { cb({}); }
    });
  } catch (e) {
    cb({});
  }
}

/** 记住 pipelineId ↔ 职位名（两者必须来自同一页面 URL，同源才可信；
 *  jobId/jobIds 参数来自筛选状态、可能过期，绝不参与职位身份判定） */
function rememberJobPipeline(pipelineId, jobName) {
  const pid = String(pipelineId || '');
  const name = normalizeJobName(jobName);
  if (!pid || !name) return;
  readJobPipelineMap((map) => {
    if (map[pid] === name) return;
    map[pid] = name;
    try {
      chrome.storage.local.set({ [JOB_PIPELINE_MAP_KEY]: map });
    } catch (e) { /* ignore */ }
  });
}

/** 当前页面的职位名：URL title（与 pipelineId 同源，最可信）→ 页面展示名兜底 */
function pageJobName() {
  const ctx = parsePageContext();
  if (ctx && ctx.title) return safeDecode(ctx.title);
  return resolveJobDisplayName();
}

/** 按职位（jobLabel=下拉框选中的职位名）查分配对象记录——分配对象跟职位走的
 *  关键。以「职位名」为锚点（URL title 与下拉框文案同源），彻底绕开
 *  jobId/pipelineId 两套 id 空间的桥接错配（jobIds 参数是筛选状态，会过期）。
 *  查找顺序：① 存档里盖了职位名章且匹配的记录（同名的取最新）；
 *  ② pipelineId→职位名映射反查；③ 选中职位就是页面当前职位时用页面 pipeline。
 *  返回 { ok, ready, assigneeCount, assigneeNames, savedAt, pipelineId, isPageJob } */
function getAssigneeForJob(jobId, jobLabel) {
  return new Promise((resolve) => {
    const label = String(jobLabel || '').trim();
    const pagePipelineId = currentPipelineId();
    const pageName = pageJobName();
    if (pagePipelineId && pageName) rememberJobPipeline(pagePipelineId, pageName);
    if (!label) {
      resolve({ ok: true, ready: false, isPageJob: false });
      return;
    }
    const isPageJob = jobNameMatches(label, pageName);
    readJobPipelineMap((map) => {
      // 映射反查：职位名 → pipelineId
      let mappedPid = '';
      if (isPageJob && pagePipelineId) mappedPid = String(pagePipelineId);
      if (!mappedPid) {
        Object.keys(map).some((pid) => {
          if (jobNameMatches(label, map[pid])) { mappedPid = String(pid); return true; }
          return false;
        });
      }
      readAssignmentStore((captures) => {
        // ① 职位名章精确匹配（同名取最新）
        let entry = null;
        Object.keys(captures).forEach((k) => {
          const e = captures[k];
          if (e && jobNameMatches(label, e.jobName)
            && (!entry || (Number(e.savedAt) || 0) > (Number(entry.savedAt) || 0))) {
            entry = e;
          }
        });
        // ② 映射/页面 pipeline 兜底
        if (!entry && mappedPid) entry = captures[String(mappedPid)];
        const pid = entry ? String(entry.pipelineId || mappedPid || '') : String(mappedPid || '');
        // 自愈：命中页面自身 pipeline 下缺职位名章的旧记录（round15 之前的存档），
        // 当场补章——同源（页面 pipeline + 页面名）才写，绝不猜
        if (entry && !normalizeJobName(entry.jobName) && pagePipelineId && pageName
          && String(entry.pipelineId || '') === String(pagePipelineId)) {
          entry.jobName = normalizeJobName(pageName);
          persistAssignmentEntry(entry);
        }
        if (entry || mappedPid || isPageJob) {
          logAdoptTrace('查询', 'label=' + label + '；pagePid=' + (pagePipelineId || '空')
            + '；pageName=' + (pageName || '空') + '；resolvedPid=' + (pid || '空')
            + '；entryName=' + (entry && entry.jobName ? entry.jobName : '无'));
        }
        resolve({
          ok: true,
          ready: !!(entry && Array.isArray(entry.assigneeIds) && entry.assigneeIds.length),
          assigneeCount: entry && Array.isArray(entry.assigneeIds) ? entry.assigneeIds.length : 0,
          assigneeNames: entry && Array.isArray(entry.assigneeNames) ? entry.assigneeNames : [],
          savedAt: entry ? Number(entry.savedAt) || 0 : 0,
          pipelineId: pid,
          isPageJob: isPageJob || (!!pid && !!pagePipelineId && pid === String(pagePipelineId))
        });
      });
    });
  });
}

/** 分配对象排查快照：页面上下文 + 职位名映射 + 分配存档摘要 + [adopt] 流水，
 *  一键导出便于定位「串岗/查不到」类问题（设置页「复制排查快照」按钮调用） */
function getAssigneeDiagnostics() {
  return new Promise((resolve) => {
    const ctx = parsePageContext();
    const page = {
      url: String(location.href || '').slice(0, 400),
      pipelineId: currentPipelineId(),
      jobName: pageJobName(),
      urlJobIds: ctx && Array.isArray(ctx.jobIds) ? ctx.jobIds : []
    };
    readJobPipelineMap((map) => {
      readAssignmentStore((captures) => {
        const list = Object.keys(captures).map((pid) => {
          const e = captures[pid] || {};
          return {
            pipelineId: pid,
            jobName: e.jobName || '',
            assigneeCount: Array.isArray(e.assigneeIds) ? e.assigneeIds.length : 0,
            assigneeNames: Array.isArray(e.assigneeNames) ? e.assigneeNames : [],
            savedAt: Number(e.savedAt) || 0
          };
        }).sort((a, b) => b.savedAt - a.savedAt);
        resolve({
          ok: true,
          page,
          map,
          captures: list,
          log: requestLog.slice()
        });
      });
    });
  });
}

/** 确保内存中的模板属于当前职位；不是（或缺失）则从存储里取当前职位那份 */
function loadAssignmentForCurrentPipeline() {
  return new Promise((resolve) => {
    const pipelineId = currentPipelineId();
    if (!pipelineId) { resolve(null); return; }
    if (capturedAssignmentPipelineId === pipelineId && capturedAssignment && lastAssigneeIds.length) {
      resolve(capturedAssignment);
      return;
    }
    readAssignmentStore((captures) => {
      const entry = captures[pipelineId];
      if (entry && entry.template && typeof entry.template === 'object') {
        capturedAssignment = entry.template;
        capturedAssignmentPipelineId = String(entry.pipelineId || pipelineId);
        capturedAssignmentSavedAt = Number(entry.savedAt) || 0;
        lastAssigneeIds = MokaBatch.sanitizeIdList(entry.assigneeIds, 5);
        lastAssigneeNames = Array.isArray(entry.assigneeNames)
          ? validAssigneeNames(entry.assigneeNames, lastAssigneeIds.length)
          : [];
        resolve(capturedAssignment);
      } else {
        resolve(null);
      }
    });
  });
}

function restoreAssignmentCapture() {
  return loadAssignmentForCurrentPipeline();
}

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

/* ---------------- 详情页身份追踪（防串人误推） ----------------
 * 记录页面最近加载过的「application id -> 候选人姓名」信号，
 * 单点推荐/淘汰点击前据此校验详情页渲染的确实是目标候选人。 */
const DETAIL_SEEN_LIMIT = 50;
const detailSeenApps = new Map(); // appId(string) -> { name }

function extractDetailName(json) {
  if (!json || typeof json !== 'object') return '';
  const raw = json.name
    || (json.candidate && json.candidate.name)
    || json.candidateName
    || (json.data && json.data.name);
  return String(raw || '').trim().slice(0, 64);
}

function markDetailAppSeen(url, text) {
  const m = String(url || '').match(/\/applications\/(\d+)/);
  if (!m) return;
  let name = '';
  if (text) {
    try {
      name = extractDetailName(MokaCapture.unwrapDetailJson(JSON.parse(text)));
    } catch (e) { /* ignore */ }
  }
  const prev = detailSeenApps.get(m[1]);
  detailSeenApps.set(m[1], { name: name || (prev && prev.name) || '' });
  while (detailSeenApps.size > DETAIL_SEEN_LIMIT) {
    detailSeenApps.delete(detailSeenApps.keys().next().value);
  }
}

/** 目标候选人姓名（优先取当前筛选结果，取不到再翻反馈存档） */
async function candidateNameFor(appId) {
  try {
    const item = await findResultOrRestore(appId);
    const nm = item && item.app && item.app.name;
    return nm ? String(nm).trim() : '';
  } catch (e) {
    return '';
  }
}

/** 点击推荐/淘汰前的身份校验：页面渲染的必须是目标候选人，否则中止 */
async function waitForCandidateVerified(appId, timeoutMs) {
  const target = String(appId);
  const expected = await candidateNameFor(target);
  const deadline = Date.now() + (timeoutMs || 15000);
  let sawDetail = false;
  while (Date.now() < deadline) {
    // 详情页已渲染出目标姓名 → 就是本人
    if (expected && document.body && String(document.body.innerText || '').indexOf(expected) !== -1) {
      return { ok: true };
    }
    const info = detailSeenApps.get(target);
    if (info) {
      sawDetail = true;
      // 详情接口返回的姓名与目标不一致 → 页面/数据串人，宁可不点
      if (expected && info.name && info.name !== expected) {
        return {
          ok: false,
          error: `身份校验失败：页面加载的是「${info.name}」，不是目标「${expected}」，已取消自动操作以防误推`
        };
      }
      if (info.name || !expected) return { ok: true };
    }
    await MokaActions.sleep(250);
  }
  // 等不到任何身份信号：宁可中止也不盲点（误推比失败更糟）
  if (!expected && !sawDetail) return { ok: true, unverified: true };
  return sawDetail
    ? { ok: true }
    : { ok: false, error: `未能在详情页确认候选人「${expected || target}」，已取消自动操作，请刷新页面后重试` };
}

/** 等页面就绪 → 身份校验 → 执行按钮自动化（推荐/淘汰共用） */
async function runPendingActionOnVerifiedPage(pending) {
  await waitForDomReady();
  await MokaActions.sleep(2000);
  const check = await waitForCandidateVerified(pending.appId, 15000);
  if (!check.ok) throw new Error(check.error);
  await runMokaActionOnPage(pending.action);
}

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
let contentBooted = false; // 幂等守卫：同页面上下文重复执行只做一次初始化
function init() {
  if (contentBooted) return;
  contentBooted = true;
  console.log('[Moka 筛选] Content script 已加载');
  startBridgeHandshake();
  const leftover = document.getElementById('moka-panel');
  if (leftover) leftover.remove();
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    } else if (request.action === 'getJobs') {
      const respond = () => respondGetJobs(sendResponse);
      if (getCurrentJobs().length) respond();
      else {
        restoreResultsSilently().then(respond);
      }
      return true;
    } else if (request.action === 'getJobContext') {
      getJobContext(request.jobId)
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
      getJobSpec(request.jobType, request.jobId)
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
          pushPluginLog({
            cat: 'err',
            text: 'performScreening 异常：' + ((err && err.message) || '未知错误')
          });
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
        pushPluginLog({
          cat: 'err',
          text: '启动筛选失败：' + ((err && err.message) || '未知错误')
        });
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
      return false;
    } else if (request.action === 'exportCsv') {
      exportResultsCsv(request.feedbackByAppId);
      sendResponse({ ok: true });
      return false;
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
    } else if (request.action === 'getRequestLog') {
      sendResponse({ ok: true, log: requestLog.slice() });
      return false;
    } else if (request.action === 'flushPluginLog') {
      // 设置页「清空/查看」前先把本地队列冲给 background，避免清完又有旧日志冒出来
      flushPluginLog();
      sendResponse({ ok: true });
      return false;
    } else if (request.action === 'getBatchAssignContext') {
      loadAssignmentForCurrentPipeline().then((tpl) => {
        sendResponse({
          ok: true,
          ready: !!(tpl && lastAssigneeIds.length),
          assigneeCount: lastAssigneeIds.length,
          assigneeNames: resolveAssigneeNamesForDisplay(),
          savedAt: capturedAssignmentSavedAt
        });
      });
      return true;
    } else if (request.action === 'getAssigneeForJob') {
      // 配置页「分配对象」跟职位走：按下拉框选中的 jobId 查该职位自己的记录，
      // 而不是 Moka 页面当前职位的（两者可能不同步）
      getAssigneeForJob(request.jobId, request.jobLabel).then((r) => sendResponse(r));
      return true;
    } else if (request.action === 'getAssigneeDiagnostics') {
      // 分配对象排查快照（设置页「复制排查快照」）
      getAssigneeDiagnostics().then((r) => sendResponse(r));
      return true;
    } else if (request.action === 'scrapeAssigneeNames') {
      // 配置页「重新读取」：弹窗开着时直接从页面 DOM 实时刮「推荐到」姓名；
      // readOnly=true 时只读不落库（供「已记录 vs 弹窗当前」比对，防显示与 id 脱钩）
      const scraped = scrapeRecommendChipNamesFromDom();
      if (request.readOnly) {
        sendResponse({
          ok: true,
          names: (Array.isArray(scraped.anchored) ? scraped.anchored : []).slice(0, 5),
          debug: { labels: scraped.labels, anchored: scraped.anchored, pageWide: scraped.pageWide }
        });
        return false;
      }
      mergeLiveScrapedAssigneeNames(scraped)
        .then((names) => sendResponse({
          ok: true,
          names,
          debug: {
            labels: scraped.labels,
            anchored: scraped.anchored,
            pageWide: scraped.pageWide
          }
        }))
        .catch(() => sendResponse({ ok: true, names: [], debug: null }));
      return true;
    } else if (request.action === 'adoptScrapedAssignees') {
      // 配置页「确认本岗分配对象」：把弹窗当前人选（姓名→id 反查）写进本岗记录，
      // 之后关掉弹窗、换页面都不会丢，批量推进重放即按这组人
      adoptScrapedAssignees()
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({
          ok: true,
          adopted: false,
          reason: 'error',
          error: (err && err.message) ? String(err.message) : String(err || '未知异常')
        }));
      return true;
    } else if (request.action === 'batchAssign') {
      handleBatchAssign(request.appIds)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || '批量推进失败' }));
      return true;
    }
    sendResponse(MokaContracts.unknownActionResponse(request && request.action));
    return false;
  });
  restoreAssignmentCapture();
  restoreMemberNames();
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
let pageContextPopstateBound = false;
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
  // popstate 只绑一次：重复执行/重复调用时不叠加监听
  if (!pageContextPopstateBound) {
    pageContextPopstateBound = true;
    window.addEventListener('popstate', () => maybeNotifyPageJobChanged('popstate'));
  }
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
  // 顺带记住 pipelineId ↔ 职位名（同一 URL 的两个参数，同源可信）
  if (ctx && ctx.pipelineId) {
    rememberJobPipeline(String(ctx.pipelineId), ctx.title ? safeDecode(ctx.title) : pageJobName());
  }
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
  // 开筛必须跟当前页职位，避免沿用上一岗捕获 body 里的旧 jobIds
  const searchCtx = resolveSearchContext();
  baseBody = MokaCapture.alignSearchBodyToJob(baseBody, searchCtx);
  if (!(searchCtx.jobIds && searchCtx.jobIds.length) && !baseBody.pipelineId) {
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

    // 单页抓取带重试退避：超时/断网/429/5xx 自动重试，停止时返回 null 收尾
    const resp = await fetchPageWithRetry(
      url,
      { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) },
      alive
    );
    if (!alive() || !resp) break;

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

/**
 * 侧栏点名的职位与页面当前列表是否是同一个。
 * 页面停在别的职位时，这里抓到的 JD 属于上一个岗，绝不能拿去当本岗的理解。
 */
function assertPageMatchesJob(expectedJobId) {
  const wanted = String(expectedJobId || '');
  const pageJobId = pageJobIdFromContext();
  if (wanted && pageJobId && String(pageJobId) !== wanted) {
    throw new Error('页面当前停在另一个职位的候选人列表，请先在 Moka 打开所选职位的列表页再读 JD');
  }
  return pageJobId;
}

/** 上一轮筛选留下的 JD 缓存是否属于要解读的这个岗位 */
function cachedJdBelongsTo(expectedJobId, pageJobId) {
  const target = String(expectedJobId || pageJobId || '');
  if (!target) return true; // 判不出岗位时保持旧行为，别把兜底路径堵死
  const cfgJob = lastScreenConfig && lastScreenConfig.jobId ? String(lastScreenConfig.jobId) : '';
  if (!cfgJob) return !expectedJobId; // 缓存不知道自己属于谁：侧栏点了名就不敢用
  return cfgJob === target;
}

/** 轻量拉取一条候选人，用其 job 字段做硬条件预填 */
async function getJobContext(expectedJobId) {
  const pageJobId = assertPageMatchesJob(expectedJobId);
  const app = await fetchOneApplication();
  if (app && app.job) return autofillFromJob(app.job);
  // 兜底：本轮/上次筛选里已有候选人与 JD（仅限同一岗位）
  if (!cachedJdBelongsTo(expectedJobId, pageJobId)) return null;
  const cached = results.find((r) => r && r.app && r.app.job) || results[0];
  if (cached && cached.app && cached.app.job) return autofillFromJob(cached.app.job);
  if (lastScreenConfig && lastScreenConfig.jobJD) {
    const parsed = MokaMatch.extractHardAutofillFromText(lastScreenConfig.jobJD);
    parsed.majors = extractMajorsFromText(lastScreenConfig.jobJD);
    return parsed;
  }
  return null;
}

/** 解读当前职位 JD，返回岗位画像（expectedJobId 为侧栏点名的职位） */
async function getJobSpec(jobType, expectedJobId) {
  const type = jobType || 'full-time';
  const pageJobId = assertPageMatchesJob(expectedJobId);
  let jobJD = '';
  const app = await fetchOneApplication();
  if (app) jobJD = buildJobJD(app);
  if (!jobJD && cachedJdBelongsTo(expectedJobId, pageJobId)) {
    if (lastScreenConfig && lastScreenConfig.jobJD) {
      jobJD = lastScreenConfig.jobJD;
    }
    if (!jobJD) {
      const cached = results.find((r) => r && r.app) || null;
      if (cached) jobJD = buildJobJD(cached.app);
    }
  }
  if (!jobJD) return null;
  // JD 本身只有职位名时别去打模型：回来的必然是空壳，还会被当成模型不给力
  if (MokaScore.jobJdLooksEmpty(jobJD)) {
    throw new Error('这个职位在 Moka 里没写岗位描述（只有职位名），没东西可解读；请在 Moka 补全 JD，或直接手填门槛与关键词');
  }
  const spec = await analyzeJobViaBackground(jobJD, type);
  // 解析失败的空壳不能当成功往上传：侧栏会显示空理解，还会把清单整表覆盖成空
  if (!MokaPersist.jobSpecIsUsable(spec)) {
    throw new Error(
      (spec && spec.parseErrorMessage)
        || '模型这次没解读出岗位信息（返回为空或无法解析），请稍后重试或换个模型'
    );
  }
  // 盖上来源职位：侧栏据此判断存档里的理解是不是本岗的
  const sourceJobId = String(expectedJobId || pageJobId || '');
  if (sourceJobId) {
    spec.sourceJobId = sourceJobId;
    spec.sourceJobName = resolveJobDisplayName(sourceJobId) || '';
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

  // 读 JD 也必须跟当前页职位：捕获体里的旧 jobIds 会把上一岗的候选人和 JD 拉回来
  const searchCtx = resolveSearchContext();
  baseBody = MokaCapture.alignSearchBodyToJob(baseBody, searchCtx);
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
  const text = `${job.aiEvalRequirementInfo || ''}\n${MokaCandidateProfile.stripHtml(job.description || '')}\n${schemaLines}`;
  const parsed = MokaMatch.extractHardAutofillFromText(text);
  parsed.majors = MokaCandidateProfile.extractMajorsFromText(text);
  return parsed;
}

function extractMajorsFromText(text) {
  return MokaCandidateProfile.extractMajorsFromText(text);
}

function evaluateHardConditions(app, hc, jobType) {
  return MokaCandidateProfile.evaluateHardConditions(app, hc, jobType);
}

function applyMergedHard(item) {
  const local = item.hardLocal || { passed: true, missing: [] };
  const unmet = ((item.score && item.score.unmet) || [])
    .filter((gate) => gate && gate.source === 'handwritten');
  item.hard = MokaMatch.mergeHardWithMustHaves(local, unmet);
}

function applyScoreResult(item, raw) {
  item.rawScore = raw;
  if (!item.waivedMustHaves) item.waivedMustHaves = new Set();
  item.score = composeFinalScore(raw, item.waivedMustHaves, (item.hardLocal && item.hardLocal.missing) || []);
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
  return MokaCandidateProfile.hasAnyExperience(app);
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
      // 详情抓取带 1 次重试：断网/超时/429/5xx 短暂退避后再试，4xx（会话失效）立即放弃换下一条
      let resp = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          resp = await fetchWithTimeout(url, {
            method,
            credentials: 'include',
            headers: detailHeaders()
          });
          if (resp.ok) break;
          if (resp.status === 429 || resp.status >= 500) {
            resp = null;
            await sleep(300);
            continue;
          }
          resp = null;
          break;
        } catch (e) {
          resp = null;
          if (attempt === 0) await sleep(300);
        }
      }
      if (!resp || !resp.ok) continue;
      const fetched = MokaCapture.unwrapDetailJson(await resp.json());
      if (detailBelongsTo(app, fetched)) {
        json = fetched;
        break;
      }
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

function buildCandidateProfile(app) {
  return MokaCandidateProfile.buildCandidateProfile(app);
}

function buildJobJD(app) {
  return MokaCandidateProfile.buildJobJD(app);
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
  const merged = Object.assign({}, base, patch || {}, { updatedAt: Date.now() });
  // 停止/暂停守卫：会话已结束（isScreening=false）后，在途 worker 的进度心跳
  // 不得把任务状态从 stopped/paused_mismatch/awaiting_resume 改回 running。
  // 触发场景：用户点「停止」或页面切岗触发暂停的瞬间，仍有 worker 卡在
  // scoreViaBackgroundWithRetry（最长 120s），返回后会带着 status:'running'
  // 走到这里，把刚冻结的终态覆盖回 running，导致侧栏/后台误判任务还在跑、
  // 断点续筛错误恢复。
  // 处理：此时只允许更新 completed/usage 等进度字段；状态保持内存态已有的
  // 终态。若停止方的 finish 落盘尚未完成（内存态仍是 running），先给一个
  // 安全的非 running 兜底，随后必到的 finishScreeningJob('stopped'/'paused_mismatch')
  // 会覆盖成正确终态，最终落盘状态不受影响。
  if (patch && patch.status === 'running' && !isScreening) {
    delete merged.status;
    if (!merged.status || merged.status === 'running') merged.status = 'awaiting_resume';
  }
  return saveScreeningJob(merged);
}

/** finishScreeningJob 是筛选状态流转的收口：所有终止/暂停都从这过，运行日志记一屏 */
const SCREEN_STATUS_LABEL = {
  done: '筛选完成',
  stopped: '筛选已停止',
  awaiting_resume: '已暂停（可在侧栏选择是否继续）',
  paused_mismatch: '已暂停：Moka 职位与当前任务不一致'
};

async function finishScreeningJob(status, extra) {
  if (activeScreeningJob) {
    await saveScreeningJob(MokaScreeningJob.withStatus(
      activeScreeningJob,
      status,
      extra || {}
    ));
  }
  chrome.runtime.sendMessage({ action: 'screeningKeepaliveStop' }).catch(() => {});
  const c = extra ? Number(extra.completed) : NaN;
  const t = extra ? Number(extra.total) : NaN;
  const counts = Number.isFinite(c) && Number.isFinite(t) && t > 0 ? `：${c}/${t} 位` : '';
  const label = SCREEN_STATUS_LABEL[status] || ('筛选状态：' + status);
  pushPluginLog({
    cat: 'screen',
    text: label + counts + (lastKnownJobName ? ' · ' + lastKnownJobName : '')
  });
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

// 进度口径：只要出了结果就算已处理（含评分失败），与结果页顶部摘要一致
function countProcessedResults() {
  return results.filter((item) => item && item.score).length;
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
    completed: Math.max(job.completed, countProcessedResults()),
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
  pushPluginLog({ cat: 'screen', text: '已丢弃未完成筛选任务' + (lastKnownJobName ? ' · ' + lastKnownJobName : '') });
  activeScreeningJob = null;
  resetRunUsage();
  await saveScreeningJob(null);
}

const TRUNCATED_FINISH_REASONS = ['length', 'max_tokens', 'max_output_tokens'];

function isTruncatedFinishReason(reason) {
  return TRUNCATED_FINISH_REASONS.indexOf(String(reason || '').toLowerCase()) !== -1;
}

/** 输出长度显示：1234 → 1.2k */
function formatCharCount(n) {
  const num = Number(n) || 0;
  return num >= 1000 ? (num / 1000).toFixed(1) + 'k 字' : num + ' 字';
}

/**
 * 评分诊断尾部：输出长度 / 截断标记 / 是否含思考 / 多次调用 / 解析失败类型。
 * 正常完成（finish=stop、无思考）时只留输出长度，避免日志行过长。
 */
function scoreDiagnosticsText(meta, score) {
  const m = meta || {};
  const bits = [];
  if (m.outLen) bits.push('输出 ' + formatCharCount(m.outLen));
  if (isTruncatedFinishReason(m.finishReason)) bits.push('截断(' + m.finishReason + ')');
  else if (m.finishReason && String(m.finishReason).toLowerCase() !== 'stop') bits.push('finish=' + m.finishReason);
  if (m.hasThink) bits.push('含思考');
  if (Number(m.calls) > 1) bits.push(m.calls + ' 次调用');
  const kind = (score && score.parseFailureKind) || m.parseFailureKind;
  if (score && score.level === '错误' && kind) bits.push('解析失败：' + kind);
  return bits.length ? ' · ' + bits.join(' · ') : '';
}

async function scoreResultsBatch(scoreConfig, weights, hc, keywords, opts) {
  const options = opts || {};
  const onlyPending = !!options.onlyPending;
  const epoch = options.epoch;
  const total = results.length;
  if (!screeningStartedAt) screeningStartedAt = Date.now();
  let completed = countProcessedResults();
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
        const scoredRes = await scoreViaBackgroundWithRetry(item.profile, scoreConfig);
        applyScoreResult(item, scoredRes.score);
        if (scoredRes.usage && (scoredRes.usage.calls || scoredRes.usage.cacheHits)) {
          runUsage = MokaUsage.mergeUsage(runUsage, scoredRes.usage);
        }
        const sc = item.score;
        const uBit = scoredRes.usage
          ? (scoredRes.usage.cacheHits ? ' · 缓存命中'
            : scoredRes.usage.calls ? ` · LLM ${scoredRes.usage.inTok}/${scoredRes.usage.outTok} tokens` : '')
          : '';
        pushPluginLog({
          cat: 'score',
          text: `评分 ${(item.app && item.app.name) || '#' + (index + 1)}：${(sc && sc.level) || '无结果'}（${Number(sc && sc.score) || 0} 分）` + uBit
            + scoreDiagnosticsText(scoredRes.meta, sc)
        });
      } catch (err) {
        console.error('[Moka 筛选] 候选人处理失败:', item.app && item.app.name, err);
        pushPluginLog({
          cat: 'err',
          text: `候选人处理失败：${(item.app && item.app.name) || '#' + (index + 1)} · ${(err && err.message) || '未知错误'}`
        });
        applyScoreResult(item, {
          dimensions: null,
          error: (err && err.message) ? err.message : '处理失败'
        });
      } finally {
        clearRowStage(item.app.id);
      }
      completed = countProcessedResults();
      updateRow(item);
      applyPanelFilter();
      scheduleSort();
      schedulePersistLastScreening();
      await patchScreeningJob({
        status: 'running',
        completed,
        total,
        usage: runUsage
      });
      updatePanelStatus(`评分 ${completed}/${total} · 已补全经历 ${enrichedExp} 位 · Moka 标签请保持打开（可切去其他浏览器标签）`);
      const progressMsg = MokaScreeningJob.formatScreeningProgress({
        name: item.app && item.app.name,
        current: completed,
        total,
        startedAt: screeningStartedAt,
        now: Date.now()
      });
      const usageMsg = MokaUsage.summaryText(runUsage);
      reportProgress(
        completed,
        total,
        Math.round((completed / Math.max(total, 1)) * 100),
        usageMsg ? (progressMsg + ' · ' + usageMsg) : progressMsg
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(scoreConcurrency, Math.max(total, 1)) }, worker));

  // 自动补评：主轮结束仍有评分失败的（多为模型偶发输出异常），自动整体再补一轮；
  // 只补一轮不递归，补评仍失败的落卡等手动「重评」。断点续筛（onlyPending）不再嵌套补评。
  if (!onlyPending && alive()) {
    const failedCount = results.filter(hasPendingScore).length;
    if (failedCount > 0) {
      pushPluginLog({ cat: 'screen', text: `自动补评：${failedCount} 位评分失败，再试一轮` });
      publishResults(`有 ${failedCount} 位评分失败，自动补评一轮…`, undefined, { flush: true });
      await scoreResultsBatch(scoreConfig, weights, hc, keywords, { onlyPending: true, epoch });
    }
  }

  return { completed: countProcessedResults(), enrichedExp, total };
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
  // 续筛接上之前的用量与单价口径，不因刷新断账
  seedRunUsageFromJob(job);
  await refreshRunPriceInfo();
  await patchScreeningJob({
    status: 'running',
    total: results.length,
    completed: countProcessedResults(),
    usage: runUsage
  });
  pushPluginLog({
    cat: 'screen',
    text: `恢复筛选：继续评分（已完成 ${countProcessedResults()}/${results.length}）` + (job.jobName ? ' · ' + job.jobName : '')
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
  screeningStartedAt = 0;
  resetRunUsage();
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
    // 提前取一次单价，写入任务快照；续筛/暂停恢复后可直接沿用估算口径
    await refreshRunPriceInfo();
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
      updatedAt: Date.now(),
      usage: runUsage
    });
    startScreeningKeepalive();
    pushPluginLog({
      cat: 'screen',
      text: `开始筛选：共 ${total} 位候选人` + (lastKnownJobName ? ' · ' + lastKnownJobName : '')
    });

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
    pushPluginLog({
      cat: 'err',
      text: '筛选异常：' + ((error && error.message) || '未知错误')
    });
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
      done({ score: { dimensions: null, error: '评分超时（后台无响应），请重试' }, meta: null });
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
          feedbackContext: config.feedbackContext || '',
          feedbackRev: config.feedbackRev || 'none',
          retryAfterParseError: !!config.retryAfterParseError
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          done({ score: { dimensions: null, error: chrome.runtime.lastError.message }, meta: null });
        } else if (response && response.ok) {
          done({ score: response.score, meta: response.meta || null });
        } else {
          done({ score: { dimensions: null, error: (response && response.error) || '评分失败' }, meta: null });
        }
      }
    );
  });
}

const SCORE_RETRY_DELAY_MS = 1000;

/**
 * 带自动重试的评分。命中缓存不调模型，按 cacheHits 计；
 * 真实调用（含解析失败触发的重试）逐次累计 token，避免漏算成本。
 * @returns {Promise<{score: object, usage: object}>} usage 为 MokaUsage 计数（calls/cacheHits 等）
 */
async function scoreViaBackgroundWithRetry(profile, config) {
  let last = null;
  let lastMeta = null;
  let usage = MokaUsage.emptyUsage();
  for (let attempt = 0; attempt < 1 + MokaScore.SCORE_AUTO_RETRY_MAX; attempt++) {
    // 解析类失败的重试附加纠偏指令，要求模型严格只输出 JSON（不影响缓存 key）
    const attemptConfig = (attempt > 0 && last && last.parseError)
      ? Object.assign({}, config, { retryAfterParseError: true })
      : config;
    const res = await scoreViaBackground(profile, attemptConfig);
    last = res.score;
    if (res.meta) {
      lastMeta = res.meta;
      usage = res.meta.cacheHit
        ? MokaUsage.addCacheHit(usage)
        : MokaUsage.addUsage(usage, res.meta);
    }
    if (!MokaScore.isRetryableScoreFailure(last)) return { score: last, usage, meta: lastMeta };
    if (attempt < MokaScore.SCORE_AUTO_RETRY_MAX) {
      await sleep(SCORE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return { score: last, usage, meta: lastMeta };
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
  item.score = composeFinalScore(item.rawScore, item.waivedMustHaves, (item.hardLocal && item.hardLocal.missing) || []);
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
  // 精确匹配 application id 段，防止前缀撞车（/application/185 是 /application/1850 的子串）
  const re = new RegExp('/candidates/application/' + String(appId) + '(?![0-9])');
  return re.test(location.pathname);
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
      await runPendingActionOnVerifiedPage(pending);
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
      await runPendingActionOnVerifiedPage(pending);
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

/**
 * 让 MAIN world（inject.js）用页面原生 fetch 代发批量分配请求。
 * ISOLATED world 的 fetch 写接口可能被页面 CSP/CORS/Origin 校验拦截，
 * 而 MAIN world 代发与用户在页面上点按钮发出的请求完全同源同权。
 * 通过 reqId 匹配响应，超时与 MOKA_TIMEOUT_MS 对齐。
 */
let assignmentReqSeq = 0;
function requestMainWorldAssignment(payload) {
  return new Promise((resolve) => {
    const reqId = `ba-${Date.now()}-${++assignmentReqSeq}`;
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'moka-inject' || data.type !== 'assignment-response') return;
      if (!bridgeMessageAccepted(data)) return;
      if (!data.payload || data.payload.reqId !== reqId) return;
      done(data.payload);
    };
    timer = setTimeout(
      () => done({ status: 0, text: '', error: `请求超时（${Math.round(MOKA_TIMEOUT_MS / 1000)}s）` }),
      MOKA_TIMEOUT_MS
    );
    window.addEventListener('message', onMessage);
    try {
      window.postMessage({
        source: 'moka-content',
        type: 'do-assignment',
        payload: Object.assign({ reqId }, payload)
      }, '*');
    } catch (e) {
      done({ status: 0, text: '', error: (e && e.message) || '无法与页面脚本通信' });
    }
  });
}

/**
 * 批量推进（批量分配）：用捕获的 assignment/update/v2 模板，
 * 把插件选中的候选人 id 塞进 applicationIds 后重放。
 * 与单点自动化不同，这里不碰 Moka 页面 UI，顺序与列表页无关。
 * 实际 HTTP 请求由 MAIN world 代发（见 requestMainWorldAssignment）。
 */
async function handleBatchAssign(appIds) {
  if (isScreening) return { ok: false, error: '筛选进行中，请先停止筛选再批量推进' };
  if (mokaActionBusy) return { ok: false, error: '有单点 Moka 操作进行中，请稍候' };
  const pipelineId = currentPipelineId();
  if (!pipelineId) {
    return { ok: false, error: '无法识别当前职位，请回到该职位的简历列表页再批量推进' };
  }
  // 只用当前职位自己捕获的分配对象；其他职位的记录一律不混用
  const template = await loadAssignmentForCurrentPipeline();
  if (!template || template.url == null || !lastAssigneeIds.length) {
    return {
      ok: false,
      error: '本职位尚未记录简历推荐对象：请先在本职位手动批量分配一次（每个职位的简历推荐对象各自记录，不会串用）'
    };
  }
  const built = MokaBatch.buildBatchAssignmentBody(
    template.body, appIds, lastAssigneeIds
  );
  if (!built.ok) return built;

  const sent = await requestMainWorldAssignment({
    url: template.url,
    headers: MokaBatch.sanitizeCapturedHeaders(template.headers),
    body: JSON.stringify(built.body)
  });
  if (sent.error) {
    return { ok: false, error: sent.error || '批量推进请求失败，请检查 Moka 页面是否可访问' };
  }
  const evaluated = MokaBatch.evaluateAssignmentResponse(sent.status, sent.text);
  if (!evaluated.ok) return evaluated;
  return {
    ok: true,
    count: built.body.applicationIds.length,
    assigneeCount: built.body.assigneeIds.length
  };
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
    const scoredRes = await scoreViaBackgroundWithRetry(item.profile, {
      jobType: cfg.jobType,
      jobSpec: cfg.jobSpec,
      jobJD: cfg.jobJD,
      hardText: cfg.hardText,
      feedbackContext: fbBundle.context,
      feedbackRev: fbBundle.rev
    });
    // 取 .score：scoreViaBackgroundWithRetry 返回 {score, usage, meta} 包装（整包传下去会被判成评分失败）
    applyScoreResult(item, scoredRes.score);
    if (scoredRes.usage && (scoredRes.usage.calls || scoredRes.usage.cacheHits)) {
      runUsage = MokaUsage.mergeUsage(runUsage, scoredRes.usage);
    }
  } catch (err) {
    applyScoreResult(item, { dimensions: null, error: (err && err.message) || '重评失败' });
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
    usageText: MokaUsage.summaryText(runUsage),
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
  // 固定命名窗口复用同一个「简历详情」标签：首次点开新标签，之后都在这一个标签里刷新，
  // 避免逐个看人时堆一排标签页；用户手动关掉后再点会重新开一个（行为合理）
  window.open(url, 'moka-candidate-detail');
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
  module.exports = {
    evaluateHardConditions,
    isOnCandidatePage,
    markDetailAppSeen,
    harvestMemberNames,
    assigneeIdNames,
    validAssigneeNames,
    resolveAssigneeNamesForDisplay,
    scrapeRecommendChipNamesFromDom,
    resolveIdsForNames,
    adoptScrapedAssignees,
    rememberJobPipeline,
    getAssigneeForJob,
    getAssigneeDiagnostics,
    normalizeScoreConcurrency,
    scoreDiagnosticsText,
    scoreConcurrencyForTest: () => scoreConcurrency,
    setScoreConcurrencyForTest: (v) => { scoreConcurrency = normalizeScoreConcurrency(v); },
    detailSeenAppsForTest: () => Object.fromEntries(detailSeenApps),
    memberNamesForTest: () => Object.fromEntries(memberNames)
  };
}

init();

console.log('[Moka 筛选] Content script 初始化完成');
