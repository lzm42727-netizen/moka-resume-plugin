/**
 * Moka 智能简历筛选 - Content Script
 *
 * 架构：纯接口驱动 + 原样重放。
 *  1. inject.js（MAIN world）捕获 Moka 自己发出的 search-candidate 请求模板
 *  2. content.js 用该模板「原样重放」并做游标分页，拉取全部候选人（可上百/上千）
 *  3. 逐个交给 background 做 AI 评分（外部 API 调用在后台完成，规避 CSP）
 *  4. 注入浮层面板，按 AI 得分排序、增量渲染，可点开候选人
 */

const SEARCH_API_FALLBACK = '/api/outer/ats-candidate-search-left/candidate/search-candidate/v2';
const CONCURRENCY = 4;
const DEFAULT_LIMIT = 30;
const MAX_PAGES = 300; // 安全上限：300 页 × 30 ≈ 9000 人

let isScreening = false;
let results = []; // { app, profile, jobJD, rawScore, waivedMustHaves, score, hard }
let rowMap = new Map(); // app.id -> { row, scoreEl, infoEl }
let sortTimer = null;
let activeWeights = null; // 本轮归一化权重，供撤销必备项扣分后重算

// 捕获到的 Moka 真实请求模板（来自 inject.js）
let capturedRequest = null;        // 列表搜索请求
let capturedDetailRequest = null;  // 「返回含经历」的详情请求模板（含 scene 令牌）
const detailDataCache = new Map(); // id(string) -> 已含经历的详情响应 JSON（页面已加载过的候选人可直接复用）

// 尽早监听，避免错过 inject.js 的早期推送
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'moka-inject') return;
  if (data.type === 'search-request') {
    capturedRequest = data.payload;
  } else if (data.type === 'detail-request') {
    const first = !capturedDetailRequest;
    capturedDetailRequest = data.payload;
    if (first) { try { markDetailBannerReady(); } catch (e) {} } // 用户点开候选人后，横幅变为「已就绪」
  } else if (data.type === 'detail-data') {
    cacheDetailData(data.payload);
  }
});

/** 缓存单个候选人的详情响应，严格按 URL 里的 application id + 顶层 id/candidateId 建索引 */
function cacheDetailData(payload) {
  if (!payload || !payload.text) return;
  try {
    const json = JSON.parse(payload.text);
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
  if (!json || typeof json !== 'object') return false;
  const idOk = json.id != null && String(json.id) === String(app.id);
  const candOk = json.candidateId != null && app.candidateId != null
    && String(json.candidateId) === String(app.candidateId);
  // 若 JSON 未携带可比对的标识，则无法校验 —— 从严处理，视为不匹配
  if (json.id == null && json.candidateId == null) return false;
  return idOk || candOk;
}
// 主动索要一次（防止 content 晚于首个请求）
try {
  window.postMessage({ source: 'moka-content', type: 'get-search-request' }, '*');
  window.postMessage({ source: 'moka-content', type: 'get-detail-request' }, '*');
} catch (e) { /* ignore */ }

init();

function init() {
  console.log('[Moka 筛选] Content script 已加载');
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ ok: true });
    } else if (request.action === 'getJobs') {
      sendResponse({ jobs: getCurrentJobs() });
    } else if (request.action === 'getJobContext') {
      getJobContext()
        .then((autofill) => sendResponse({ autofill }))
        .catch(() => sendResponse({ autofill: null }));
      return true; // 异步
    } else if (request.action === 'getJobSpec') {
      getJobSpec(request.jobType)
        .then((spec) => sendResponse({ spec }))
        .catch(() => sendResponse({ spec: null }));
      return true; // 异步
    } else if (request.action === 'startScreening') {
      if (isScreening) {
        sendResponse({ ok: false, error: '正在筛选中' });
        return true;
      }
      isScreening = true;
      performScreening(request).finally(() => { isScreening = false; });
      sendResponse({ ok: true });
    } else if (request.action === 'stopScreening') {
      isScreening = false;
      sendResponse({ ok: true });
    }
    return true;
  });
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

function getCurrentJobs() {
  const ctx = parsePageContext();
  if (!ctx || ctx.jobIds.length === 0) {
    // 即便无法从 URL 拿到 jobId，只要捕获到了请求也允许筛选
    if (capturedRequest) return [{ id: 'current', name: '当前列表候选人' }];
    return [];
  }
  const name = ctx.title ? safeDecode(ctx.title) : `职位 ${ctx.jobIds[0].slice(0, 8)}`;
  return [{ id: ctx.jobIds[0], name }];
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/* ---------------- 接口调用（原样重放 + 游标分页） ---------------- */

function utf8FromBase64(b64) {
  const bin = atob(b64);
  try {
    return decodeURIComponent(bin.split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
  } catch {
    return bin;
  }
}

/** 把返回的 lastCursor 解码成下一页的 offsetInfo */
function offsetInfoFromCursor(lastCursor) {
  if (!lastCursor) return null;
  try {
    const decoded = JSON.parse(utf8FromBase64(lastCursor));
    // 复用服务端给的精确定位字段，避免自行格式化 movedAt 造成时区/格式错误
    return {
      applicationId: decoded.applicationId,
      matchingIndex: decoded.matchingIndex,
      movedAt: decoded.movedAt,
      isAlreadyNull: decoded.isAlreadyNull,
      includeThis: false
    };
  } catch (e) {
    console.warn('[Moka 筛选] 解析游标失败:', e);
    return null;
  }
}

async function fetchAllApplications(onProgress, maxCount = 0) {
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
  if (!baseBody.pipelineId) {
    // 兜底：从 URL 粗略重建（可能缺用户态字段，结果范围以捕获为准）
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
  let offsetInfo = { includeThis: false };

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!isScreening) break;

    const body = { ...baseBody, limit, offsetInfo };

    const resp = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
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

    const next = offsetInfoFromCursor(data.lastCursor);
    // 停止条件：没有更多 / 本页无新增 / 拿不到下一页游标
    if (!data.hasMore || added === 0 || !next) break;
    offsetInfo = next;
  }

  return maxCount > 0 ? all.slice(0, maxCount) : all;
}

/** 轻量拉取一条候选人，用其 job 字段做硬条件预填 */
async function getJobContext() {
  const app = await fetchOneApplication();
  if (!app || !app.job) return null;
  return autofillFromJob(app.job);
}

/** 解读当前职位 JD，返回岗位画像 + 建议权重（供 popup 预填滑块） */
async function getJobSpec(jobType) {
  const app = await fetchOneApplication();
  if (!app) return null;
  const jobJD = buildJobJD(app);
  if (!jobJD) return null;
  return analyzeJobViaBackground(jobJD, jobType || 'full-time');
}

/** 轻量拉取一条候选人（供 JD 解读 / 预填复用） */
async function fetchOneApplication() {
  if (!capturedRequest) {
    try { window.postMessage({ source: 'moka-content', type: 'get-search-request' }, '*'); } catch (e) {}
    await sleep(400);
  }
  const url = capturedRequest?.url || SEARCH_API_FALLBACK;
  const headers = { 'Content-Type': 'application/json', ...(capturedRequest?.headers || {}) };
  let baseBody = {};
  if (capturedRequest?.body) { try { baseBody = JSON.parse(capturedRequest.body); } catch (e) {} }
  if (!baseBody.pipelineId) {
    const ctx = parsePageContext();
    if (!ctx) return null;
    baseBody = { ...baseBody, pipelineId: Number(ctx.pipelineId) || ctx.pipelineId, jobIds: ctx.jobIds };
  }
  const body = { ...baseBody, limit: 1, offsetInfo: { includeThis: false } };
  const resp = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.data?.applications?.[0] || null;
}

/** 从 JD 的结构化要求 / 文本里解析可预填的硬条件 */
function autofillFromJob(job) {
  const result = { degree: '', majors: [], schools: [] };
  const text = `${job.aiEvalRequirementInfo || ''}\n${stripHtml(job.description || '')}`;

  // 学历：优先用结构化 schema，其次从正文抽取
  try {
    const schema = job.aiEvalRequirementSchema ? JSON.parse(job.aiEvalRequirementSchema) : [];
    const deg = schema.find((s) => s && s.name === '学历');
    if (deg && deg.value) {
      if (/博士/.test(deg.value)) result.degree = '博士';
      else if (/硕士|研究生/.test(deg.value)) result.degree = '硕士';
      else if (/本科|学士/.test(deg.value)) result.degree = '本科';
    }
  } catch (e) { /* ignore */ }
  if (!result.degree) result.degree = extractDegreeFromText(text);

  // 专业关键词：从正文里抽取
  result.majors = extractMajorsFromText(text);
  // 简历关键词：抽取 JD 中的技能/工具类关键词（英文词、缩写等）
  result.resumeKeywords = extractResumeKeywordsFromText(text);

  return result;
}

/** 从 JD 抽取简历关键词（技能/工具/缩写，如 SEO、Google、C4D、Excel） */
function extractResumeKeywordsFromText(text) {
  const kws = new Set();
  const EN_STOP = new Set(['the', 'and', 'or', 'for', 'with', 'you', 'are', 'our', 'job', 'jd', 'kpi', 'app', 'web', 'ok', 'etc']);
  const tokens = text.match(/[A-Za-z][A-Za-z0-9+#.]{1,11}/g) || [];
  tokens.forEach((w) => {
    const t = w.replace(/[.]+$/, '').trim();
    if (t.length >= 2 && !EN_STOP.has(t.toLowerCase())) kws.add(t);
  });
  return [...kws].slice(0, 8);
}

/** 从 JD 正文抽取学历要求（如「本科及以上学历」） */
function extractDegreeFromText(text) {
  const m = text.match(/(博士|硕士|研究生|本科|学士|大专|专科)\s*(?:及以上|以上|学历|起|毕业)/);
  if (!m) return '';
  const d = m[1];
  if (/博士/.test(d)) return '博士';
  if (/硕士|研究生/.test(d)) return '硕士';
  if (/本科|学士/.test(d)) return '本科';
  return ''; // 大专/专科 低于最低可选项，不预填
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

  return [...majors].slice(0, 8);
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
    if (have && have < need) missing.push(`学历需${hc.degree}及以上`);
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
    else if (hc.exp === '3-5') ok = years >= 3 && years < 5;
    else if (hc.exp === '5+') ok = years >= 5;
    if (!ok) missing.push(`经验需 ${hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'}`);
  }

  // 性别
  if (hc.gender && app.gender) {
    if (!String(app.gender).includes(hc.gender)) missing.push(`性别需${hc.gender}`);
  }

  // 实习经验（仅实习生职位生效）：本地判定「是否有实习/工作经历」，相关性交给 AI
  if (hc.internship === 'required' && jobType === 'intern') {
    const hasExp = hasAnyExperience(app) || Number(app.experience) > 0;
    if (!hasExp) missing.push('缺相关实习经验');
  }

  // 年龄（多选区间 OR；仅在候选人有年龄信息时判定）
  const age = Number(app.age);
  if (Number.isFinite(age) && age > 0) {
    const ranges = normalizeAgeRanges(hc);
    if (ranges.length) {
      const ok = ranges.some((r) => ageInRange(age, r));
      if (!ok) missing.push(`年龄需 ${ranges.map((r) => r.label).join('/')}`);
    }
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
function buildHardText(hc, jobType) {
  if (!hc) return '';
  const parts = [];
  if (hc.degree) parts.push(`学历：${hc.degree}及以上`);
  if (hc.schools && hc.schools.length) parts.push(`院校：${hc.schools.join('/')}（任一）`);
  if (hc.exp) parts.push(`经验：${hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'}`);
  if (hc.gender) parts.push(`性别：${hc.gender}`);
  if (hc.internship === 'required' && jobType === 'intern') parts.push('需具备相关实习经验');
  const ageRanges = normalizeAgeRanges(hc);
  if (ageRanges.length) {
    parts.push(`年龄：${ageRanges.map((r) => r.label).join('/')}（任一）`);
  }
  return parts.join('；');
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
  const tmpl = capturedDetailRequest && capturedDetailRequest.url;
  if (tmpl) {
    try {
      const u = new URL(tmpl, location.origin);
      // 模板路径若走候选人维度就用 candidateId，否则用 applicationId
      const useCandidate = /candidate/i.test(u.pathname) && app.candidateId != null;
      const val = useCandidate ? app.candidateId : app.id;
      u.pathname = u.pathname.replace(/(\d{5,})(?=\/|$)/, String(val)); // 替换路径里首个长数字 id
      return u.toString();
    } catch (e) { /* ignore */ }
  }
  return `${location.origin}/api/applications/${app.id}`;
}

function detailHeaders() {
  const out = { Accept: 'application/json' };
  const src = (capturedDetailRequest && capturedDetailRequest.headers) || {};
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
  app.__enriched = true;

  let json = null;
  // 1) 命中缓存（页面已加载过该候选人）：直接用，并校验归属，杜绝串号
  const cached = detailDataCache.get(String(app.id)) || (app.candidateId != null && detailDataCache.get(String(app.candidateId))) || null;
  if (cached && detailBelongsTo(app, cached)) json = cached;

  // 2) 缓存没有、且列表未带任何经历时，用探测到的详情模板重放
  if (!json && !hasAnyExperience(app) && capturedDetailRequest) {
    try {
      const resp = await fetch(buildDetailUrl(app), {
        method: (capturedDetailRequest.method || 'GET'),
        credentials: 'include',
        headers: detailHeaders()
      });
      if (resp.ok) {
        const fetched = await resp.json();
        if (detailBelongsTo(app, fetched)) json = fetched; // 只接受确属该候选人的数据
      }
    } catch (e) { /* 忽略，退回列表数据 */ }
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
  return app;
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

async function performScreening(config) {
  results = [];
  rowMap = new Map();
  renderPanelSkeleton();

  try {
    const maxCount = Number(config.maxCount) > 0 ? Number(config.maxCount) : 0;
    updatePanelStatus(maxCount ? `正在拉取候选人列表（最多 ${maxCount} 位）...` : '正在拉取候选人列表（全部）...');
    const apps = await fetchAllApplications((count) => {
      updatePanelStatus(`正在拉取候选人... 已获取 ${count} 位`);
      reportProgress(0, count, 0, `拉取中，已获取 ${count} 位`);
    }, maxCount);

    if (apps.length === 0) {
      updatePanelStatus('未找到候选人（请确认在候选人列表页，并刷新一次）');
      reportProgress(0, 0, 100, '未找到候选人');
      return;
    }

    const jobJD = buildJobJD(apps[0]);
    const total = apps.length;
    const hc = config.hardConditions || null;
    const weights = normalizeWeights(config.weights);
    activeWeights = weights;

    // 若没捕获到详情接口模板，「主动投递/未授权」候选人的结构化经历可能补不全
    if (!capturedDetailRequest) {
      try { window.postMessage({ source: 'moka-content', type: 'get-detail-request' }, '*'); } catch (e) {}
      await sleep(300);
    }
    if (!capturedDetailRequest) {
      // 常驻醒目横幅（点开候选人后自动消失），并给一段宽限时间等待用户操作
      showDetailBanner();
      for (let i = 0; i < 12 && !capturedDetailRequest; i++) {
        if (!isScreening) break;
        updatePanelStatus(`等待点开候选人以识别完整经历…（${12 - i}s，可直接等待或忽略）`);
        await sleep(1000);
      }
    }

    // 先解读 JD（缓存）：拿到统一的岗位画像，作为所有候选人的评分尺子
    updatePanelStatus('正在解读 JD...');
    let jobSpec = config.jobSpec || null;
    if (!jobSpec) {
      jobSpec = await analyzeJobViaBackground(jobJD, config.jobType);
    }

    // 先建占位行；画像/硬条件在补全详情后于 worker 内生成，保证经历数据完整
    results = apps.map((app) => ({ app, profile: null, jobJD, hard: null, score: null }));
    buildRows();

    updatePanelStatus(`共 ${total} 位候选人，正在补全简历并 AI 评分...`);
    reportProgress(0, total, 0, `共 ${total} 位，开始评分...`);

    let completed = 0;
    let cursor = 0;
    let enrichedExp = 0; // 成功补全到经历的人数（可见反馈）

    async function worker() {
      while (isScreening) {
        const index = cursor++;
        if (index >= total) break;
        const item = results[index];

        try {
          // 列表接口的经历字段可能缺失，按需调用详情接口补全，避免 AI「看不到经历」而误判
          setRowStage(item.app.id, 'enrich');
          await enrichCandidate(item.app);
          if (hasAnyExperience(item.app) || item.app.__resumeText) enrichedExp++;
          item.profile = buildCandidateProfile(item.app);
          item.hard = evaluateHardConditions(item.app, hc, config.jobType);
          applyHardToRow(item);

          setRowStage(item.app.id, 'score');
          const raw = await scoreViaBackground(item.profile, { jobType: config.jobType, jobSpec, jobJD });
          item.rawScore = raw;
          item.waivedMustHaves = new Set();
          item.score = composeFinalScore(raw, weights, item.waivedMustHaves);
        } finally {
          clearRowStage(item.app.id);
        }
        completed++;
        updateRow(item);
        scheduleSort();
        updatePanelStatus(`评分 ${completed}/${total} · 已补全经历 ${enrichedExp} 位`);
        reportProgress(completed, total, Math.round((completed / total) * 100), `已评分 ${completed}/${total}`);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    sortRows();

    if (isScreening) {
      reportProgress(total, total, 100, '筛选完成！');
      const hint = enrichedExp === 0 && !capturedDetailRequest
        ? '（未捕获到详情接口，经历可能读不全：请在 Moka 点开任一候选人详情后重试）'
        : `（已补全经历 ${enrichedExp} 位）`;
      updatePanelStatus(`筛选完成，共 ${total} 位 ${hint}`);
    } else {
      updatePanelStatus(`已停止（完成 ${completed}/${total}）`);
    }
  } catch (error) {
    console.error('[Moka 筛选] 错误:', error);
    updatePanelStatus('❌ 出错: ' + error.message);
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

function scoreViaBackground(profile, config) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'scoreCandidate', profile, config: { jobType: config.jobType, jobSpec: config.jobSpec, jobJD: config.jobJD } },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ dimensions: null, error: chrome.runtime.lastError.message });
        } else if (response && response.ok) {
          resolve(response.score);
        } else {
          resolve({ dimensions: null, error: (response && response.error) || '评分失败' });
        }
      }
    );
  });
}

const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
const DEFAULT_WEIGHTS = { experience: 40, skill: 30, education: 20, potential: 10 };
const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
const MUST_HAVE_PENALTY = 5;
const MUST_HAVE_PENALTY_CAP = 20;

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

function levelFromScore(score) {
  if (score >= 75) return '强烈推荐';
  if (score >= 50) return '值得推荐';
  if (score >= 35) return '一般';
  return '不推荐';
}

/**
 * 本地按用户权重把分维度结果合成综合分。
 * 必备项未满足 → 柔性扣分（每项 -5，最多 -20）；waived 集合内的项不扣。
 */
function composeFinalScore(raw, weights, waivedMustHaves) {
  if (!raw || !raw.dimensions) {
    return {
      score: 0, baseScore: 0, penalty: 0, level: '错误',
      suggestions: ['⚠️ ' + (raw?.error || '评分失败')],
      dims: null, unmet: [], waivedUnmet: []
    };
  }
  const dims = raw.dimensions;
  let base = 0;
  for (const k of WEIGHT_KEYS) {
    const s = dims[k] && typeof dims[k].score === 'number' ? dims[k].score : 50;
    base += s * (weights[k] || 0);
  }
  const baseScore = Math.round(Math.max(0, Math.min(100, base)));

  const waived = waivedMustHaves instanceof Set ? waivedMustHaves : new Set(waivedMustHaves || []);
  const unmetAll = (raw.mustHaveResults || []).filter((r) => r && r.item && !r.met);
  const unmet = unmetAll.filter((r) => !waived.has(r.item));
  const waivedUnmet = unmetAll.filter((r) => waived.has(r.item));
  const penalty = Math.min(unmet.length * MUST_HAVE_PENALTY, MUST_HAVE_PENALTY_CAP);
  const score = Math.round(Math.max(0, Math.min(100, baseScore - penalty)));

  // 建议：亮点 + 差距（必备项扣分改由专用 UI 展示，避免重复）
  const suggestions = [];
  (raw.highlights || []).slice(0, 2).forEach((h) => suggestions.push('✓ ' + h));
  (raw.concerns || []).slice(0, 2).forEach((c) => suggestions.push('✕ ' + c));

  return {
    score,
    baseScore,
    penalty,
    level: levelFromScore(score),
    suggestions: suggestions.slice(0, 4),
    dims,
    unmet,
    waivedUnmet
  };
}

/** 单人撤销 / 恢复某条必备项扣分后重算 */
function setMustHaveWaived(item, mustHaveItem, waived) {
  if (!item || !item.rawScore || !activeWeights) return;
  if (!item.waivedMustHaves) item.waivedMustHaves = new Set();
  if (waived) item.waivedMustHaves.add(mustHaveItem);
  else item.waivedMustHaves.delete(mustHaveItem);
  item.score = composeFinalScore(item.rawScore, activeWeights, item.waivedMustHaves);
  updateRow(item);
  scheduleSort();
  updateHeaderCount();
}

function reportProgress(current, total, percentage, message) {
  chrome.runtime.sendMessage({ action: 'updateProgress', current, total, percentage, message }).catch(() => {});
}

/* ---------------- 浮层面板（增量渲染） ---------------- */

function colorFromScore(score) {
  if (score >= 75) return '#52c41a';
  if (score >= 50) return '#1890ff';
  if (score >= 35) return '#fa8c16';
  return '#ff4d4f';
}

function ensurePanelStyles() {
  const css = `
    #moka-panel { position: fixed; top: 70px; right: 20px; width: 380px; max-height: 80vh;
      background: #fff; border: 1px solid #e0e0e0; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18); z-index: 999999;
      display: flex; flex-direction: column; font-size: 13px; color: #333;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #moka-panel .mp-header { display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid #eee; cursor: move; }
    #moka-panel .mp-title { font-weight: 600; font-size: 14px; }
    #moka-panel .mp-close { cursor: pointer; border: none; background: none; font-size: 16px; color: #999; }
    #moka-panel .mp-status { padding: 8px 14px; font-size: 12px; color: #666; border-bottom: 1px solid #f0f0f0; }
    #moka-panel .mp-banner { display: none; padding: 12px 14px; background: #fff7e6; border-bottom: 1px solid #ffe0a3;
      color: #ad6800; font-size: 13px; line-height: 1.6; }
    #moka-panel .mp-banner.show { display: block; }
    #moka-panel .mp-banner .mp-banner-title { font-weight: 600; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    #moka-panel .mp-banner b { color: #d46b08; }
    #moka-panel .mp-banner .mp-banner-ok { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;
      color: #52c41a; font-weight: 600; }
    #moka-panel .mp-list { overflow-y: auto; padding: 6px; }
    #moka-panel .mp-row { display: flex; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer;
      border: 1px solid #f0f0f0; margin-bottom: 6px; align-items: flex-start; position: relative; }
    #moka-panel .mp-row:hover { background: #f6faff; border-color: #cfe6ff; }
    #moka-panel .mp-row.scoring { border-color: #91d5ff; background: #f6fbff; padding-bottom: 14px; }
    #moka-panel .mp-score { flex: none; width: 46px; height: 46px; border-radius: 8px; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
    #moka-panel .mp-score.pending { background: #d9d9d9; font-size: 12px; }
    #moka-panel .mp-info { flex: 1; min-width: 0; }
    #moka-panel .mp-name { font-weight: 600; }
    #moka-panel .mp-meta { color: #888; font-size: 11px; margin: 2px 0 4px; }
    #moka-panel .mp-stage { font-size: 11px; font-weight: 500; color: #1890ff; margin: 2px 0 0; }
    #moka-panel .mp-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
      background: #e8e8e8; border-radius: 0 0 7px 7px; overflow: hidden; }
    #moka-panel .mp-bar-fill { display: block; height: 100%; width: 0;
      background: linear-gradient(90deg, #1890ff, #69c0ff);
      border-radius: 0 2px 2px 0; transition: width 0.35s ease; }
    #moka-panel .mp-level { font-size: 11px; font-weight: 600; }
    #moka-panel .mp-dims { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
    #moka-panel .mp-dim { background: #f0f5ff; color: #2f54eb; border: 1px solid #d6e4ff;
      border-radius: 4px; padding: 0 6px; font-size: 10px; line-height: 1.7; cursor: help; }
    #moka-panel .mp-sugg { color: #666; font-size: 11px; line-height: 1.5; margin-top: 2px; }
    #moka-panel .mp-penalty { margin-top: 6px; padding: 6px 8px; background: #fff7e6;
      border: 1px solid #ffe58f; border-radius: 6px; font-size: 11px; line-height: 1.5; }
    #moka-panel .mp-penalty-sum { color: #ad6800; font-weight: 500; margin-bottom: 4px; }
    #moka-panel .mp-penalty-sum b { color: #d46b08; }
    #moka-panel .mp-penalty-list { display: flex; flex-direction: column; gap: 4px; }
    #moka-panel .mp-penalty-row { display: flex; align-items: flex-start; justify-content: space-between;
      gap: 8px; color: #8c8c8c; }
    #moka-panel .mp-penalty-row.active { color: #d46b08; }
    #moka-panel .mp-penalty-row.waived { color: #8c8c8c; text-decoration: line-through; }
    #moka-panel .mp-penalty-row .mp-penalty-text { flex: 1; min-width: 0; word-break: break-word; }
    #moka-panel .mp-penalty-btn { flex: none; border: 1px solid #ffd591; background: #fff;
      color: #d46b08; border-radius: 4px; padding: 0 6px; height: 20px; font-size: 11px;
      cursor: pointer; line-height: 18px; }
    #moka-panel .mp-penalty-btn:hover { background: #fff7e6; border-color: #ffa940; }
    #moka-panel .mp-penalty-btn.restore { border-color: #d9d9d9; color: #595959; }
    #moka-panel .mp-penalty-btn.restore:hover { border-color: #1890ff; color: #1890ff; background: #e6f7ff; }
    #moka-panel .mp-row.failed { background: #fff7f6; border-color: #ffd6d3; }
    #moka-panel .mp-row.failed:hover { background: #fff1ef; }
    #moka-panel .mp-row.failed.scoring { background: #fff7f6; border-color: #ffa39e; }
    #moka-panel .mp-tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
    #moka-panel .mp-tag-fail { background: #fff1f0; color: #ff4d4f; border: 1px solid #ffccc7;
      border-radius: 4px; padding: 1px 6px; font-size: 10px; line-height: 1.6; }
  `;
  let style = document.getElementById('moka-panel-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'moka-panel-styles';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function renderPanelSkeleton() {
  ensurePanelStyles();
  let panel = document.getElementById('moka-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'moka-panel';
    panel.innerHTML = `
      <div class="mp-header">
        <span class="mp-title">🧑‍💼 AI 筛选结果</span>
        <button class="mp-close" title="关闭">×</button>
      </div>
      <div class="mp-banner"></div>
      <div class="mp-status"></div>
      <div class="mp-list"></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.mp-close').addEventListener('click', () => panel.remove());
    makeDraggable(panel, panel.querySelector('.mp-header'));
  } else {
    panel.querySelector('.mp-list').innerHTML = '';
    const banner = panel.querySelector('.mp-banner');
    if (banner) { banner.classList.remove('show'); banner.innerHTML = ''; }
  }
}

/** 单人识别阶段：补全经历 → AI 评分（阶段跳变，非假精确百分比） */
const ROW_STAGES = {
  enrich: { text: '① 补全经历…', pct: 45 },
  score: { text: '② AI 评分中…', pct: 80 }
};

function setRowStage(appId, stageKey) {
  const refs = rowMap.get(appId);
  const stage = ROW_STAGES[stageKey];
  if (!refs || !stage) return;

  refs.row.classList.add('scoring');

  let stageEl = refs.infoEl.querySelector('.mp-stage');
  if (!stageEl) {
    stageEl = document.createElement('div');
    stageEl.className = 'mp-stage';
    const meta = refs.infoEl.querySelector('.mp-meta');
    if (meta && meta.nextSibling) refs.infoEl.insertBefore(stageEl, meta.nextSibling);
    else if (meta) meta.after(stageEl);
    else refs.infoEl.appendChild(stageEl);
  }
  stageEl.textContent = stage.text;

  let bar = refs.row.querySelector('.mp-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mp-bar';
    const fill = document.createElement('i');
    fill.className = 'mp-bar-fill';
    bar.appendChild(fill);
    refs.row.appendChild(bar);
  }
  // 先置 0 再下一帧跳到目标，让 transition 可见
  const fill = bar.querySelector('.mp-bar-fill');
  if (fill.style.width === '0%' || !fill.style.width) {
    fill.style.width = '0%';
    requestAnimationFrame(() => { fill.style.width = stage.pct + '%'; });
  } else {
    fill.style.width = stage.pct + '%';
  }
}

function clearRowStage(appId) {
  const refs = rowMap.get(appId);
  if (!refs) return;
  refs.row.classList.remove('scoring');
  refs.infoEl.querySelectorAll('.mp-stage').forEach((el) => el.remove());
  refs.row.querySelectorAll('.mp-bar').forEach((el) => el.remove());
}

function buildRows() {
  const panel = document.getElementById('moka-panel');
  if (!panel) return;
  const list = panel.querySelector('.mp-list');
  list.innerHTML = '';
  rowMap = new Map();

  for (const item of results) {
    const app = item.app;
    const row = document.createElement('div');
    row.className = 'mp-row' + (item.hard && !item.hard.passed ? ' failed' : '');

    const scoreEl = document.createElement('div');
    scoreEl.className = 'mp-score pending';
    scoreEl.textContent = '…';

    const info = document.createElement('div');
    info.className = 'mp-info';
    const meta = [app.highestDegree, app.highestDegreeSchool, app.specialities].filter(Boolean).join(' · ');
    info.innerHTML = '<div class="mp-name"></div><div class="mp-meta"></div>';
    info.querySelector('.mp-name').textContent = app.name || '(未知)';
    info.querySelector('.mp-meta').textContent = meta;

    if (item.hard && !item.hard.passed) {
      const tags = document.createElement('div');
      tags.className = 'mp-tags';
      for (const miss of item.hard.missing) {
        const tag = document.createElement('span');
        tag.className = 'mp-tag-fail';
        tag.textContent = miss;
        tags.appendChild(tag);
      }
      info.appendChild(tags);
    }

    row.appendChild(scoreEl);
    row.appendChild(info);
    row.addEventListener('click', () => {
      const url = `${location.origin}/candidates/application/${app.id}${location.search}`;
      window.open(url, '_blank');
    });
    list.appendChild(row);
    rowMap.set(app.id, { row, scoreEl, infoEl: info });
  }
  updateHeaderCount();
}

/** 硬条件判定完成后，给行加失败样式与缺项标签 */
function applyHardToRow(item) {
  const refs = rowMap.get(item.app.id);
  if (!refs || !item.hard) return;

  refs.row.classList.toggle('failed', !item.hard.passed);
  refs.infoEl.querySelectorAll('.mp-tags').forEach((el) => el.remove());

  if (!item.hard.passed && item.hard.missing.length) {
    const tags = document.createElement('div');
    tags.className = 'mp-tags';
    for (const miss of item.hard.missing) {
      const tag = document.createElement('span');
      tag.className = 'mp-tag-fail';
      tag.textContent = miss;
      tags.appendChild(tag);
    }
    // 放在 meta 之后、level/sugg 之前
    const meta = refs.infoEl.querySelector('.mp-meta');
    if (meta && meta.nextSibling) refs.infoEl.insertBefore(tags, meta.nextSibling);
    else refs.infoEl.appendChild(tags);
  }
  updateHeaderCount();
}

function updateRow(item) {
  const refs = rowMap.get(item.app.id);
  if (!refs) return;
  const s = item.score;
  if (!s) return;

  clearRowStage(item.app.id);

  refs.scoreEl.className = 'mp-score';
  refs.scoreEl.style.background = colorFromScore(s.score);
  refs.scoreEl.textContent = s.score;

  // 移除旧的 level / dims / sugg / penalty，重建
  refs.infoEl.querySelectorAll('.mp-level, .mp-dims, .mp-sugg, .mp-penalty').forEach((el) => el.remove());

  const level = document.createElement('div');
  level.className = 'mp-level';
  level.style.color = colorFromScore(s.score);
  level.textContent = s.level || '';
  refs.infoEl.appendChild(level);

  // 分维度得分一行，点开可看理由（title 悬浮）
  if (s.dims) {
    const dimsEl = document.createElement('div');
    dimsEl.className = 'mp-dims';
    WEIGHT_KEYS.forEach((k) => {
      const d = s.dims[k];
      if (!d) return;
      const span = document.createElement('span');
      span.className = 'mp-dim';
      span.textContent = `${DIM_LABEL[k]}${d.score}`;
      if (d.reason) span.title = `${DIM_LABEL[k]}：${d.reason}`;
      dimsEl.appendChild(span);
    });
    refs.infoEl.appendChild(dimsEl);
  }

  if (s.suggestions && s.suggestions.length) {
    const sugg = document.createElement('div');
    sugg.className = 'mp-sugg';
    sugg.textContent = s.suggestions.slice(0, 3).map((x) => '• ' + x).join('  ');
    refs.infoEl.appendChild(sugg);
  }

  // 必备项扣分摊开：公式 + 单条「不扣 / 恢复」
  const unmet = s.unmet || [];
  const waivedUnmet = s.waivedUnmet || [];
  if (unmet.length || waivedUnmet.length || (s.penalty > 0)) {
    const box = document.createElement('div');
    box.className = 'mp-penalty';

    const sum = document.createElement('div');
    sum.className = 'mp-penalty-sum';
    if (s.penalty > 0) {
      sum.innerHTML = `四维加权 <b>${s.baseScore}</b> − 必备项扣 <b>${s.penalty}</b> = <b>${s.score}</b>`;
    } else if (waivedUnmet.length) {
      sum.innerHTML = `四维加权 <b>${s.baseScore}</b>＝综合分 <b>${s.score}</b>（已撤销必备项扣分）`;
    } else {
      sum.innerHTML = `四维加权 <b>${s.baseScore}</b>＝综合分 <b>${s.score}</b>`;
    }
    box.appendChild(sum);

    const list = document.createElement('div');
    list.className = 'mp-penalty-list';

    unmet.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'mp-penalty-row active';
      const text = document.createElement('span');
      text.className = 'mp-penalty-text';
      const note = r.note ? `（${r.note}）` : '';
      text.textContent = `缺「${r.item}」−${MUST_HAVE_PENALTY}${note}`;
      if (r.note) text.title = r.note;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-penalty-btn';
      btn.textContent = '不扣';
      btn.title = '撤销此项扣分（仅影响此人）';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMustHaveWaived(item, r.item, true);
      });
      row.appendChild(text);
      row.appendChild(btn);
      list.appendChild(row);
    });

    waivedUnmet.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'mp-penalty-row waived';
      const text = document.createElement('span');
      text.className = 'mp-penalty-text';
      text.textContent = `缺「${r.item}」（已不扣）`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-penalty-btn restore';
      btn.textContent = '恢复';
      btn.title = '恢复此项扣分';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMustHaveWaived(item, r.item, false);
      });
      row.appendChild(text);
      row.appendChild(btn);
      list.appendChild(row);
    });

    if (list.childNodes.length) box.appendChild(list);
    if (unmet.length * MUST_HAVE_PENALTY > MUST_HAVE_PENALTY_CAP) {
      const tip = document.createElement('div');
      tip.style.cssText = 'margin-top:4px;color:#8c8c8c;font-size:10px;';
      tip.textContent = `缺 ${unmet.length} 项，扣分封顶 −${MUST_HAVE_PENALTY_CAP}`;
      box.appendChild(tip);
    }
    refs.infoEl.appendChild(box);
  }

  updateHeaderCount();
}

function updateHeaderCount() {
  const panel = document.getElementById('moka-panel');
  if (!panel) return;
  const scored = results.filter((r) => r.score).length;
  // 「符合」= 达到推荐线（综合分 ≥ 50，即「值得推荐」及以上）
  const passed = results.filter((r) => r.score && r.score.score >= 50).length;
  panel.querySelector('.mp-title').textContent = `🧑‍💼 AI 筛选 (评分${scored}/${results.length}·推荐${passed})`;
}

function scheduleSort() {
  if (sortTimer) return;
  sortTimer = setTimeout(() => { sortTimer = null; sortRows(); }, 800);
}

function sortRows() {
  const panel = document.getElementById('moka-panel');
  if (!panel) return;
  const list = panel.querySelector('.mp-list');
  // 满足硬性条件的排前面；同组内按 AI 得分降序；未满足的整体置底
  const sorted = [...results].sort((a, b) => {
    const pa = a.hard && a.hard.passed ? 1 : 0;
    const pb = b.hard && b.hard.passed ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.score?.score ?? -1) - (a.score?.score ?? -1);
  });
  for (const item of sorted) {
    const refs = rowMap.get(item.app.id);
    if (refs) list.appendChild(refs.row); // appendChild 会把已存在节点移动到末尾，从而完成排序
  }
}

function updatePanelStatus(text) {
  const panel = document.getElementById('moka-panel');
  if (panel) panel.querySelector('.mp-status').textContent = text;
}

/** 常驻横幅：提醒用户先点开一位候选人详情，以捕获详情接口（含 scene），显著提升经历识别 */
function showDetailBanner() {
  const panel = document.getElementById('moka-panel');
  if (!panel) return;
  const el = panel.querySelector('.mp-banner');
  if (!el) return;
  el.innerHTML = `
    <div class="mp-banner-title">⚠️ 建议先点开一位候选人</div>
    为准确识别<b>实习/项目经历</b>，请在 Moka 列表里<b>点击任意一位候选人的姓名</b>打开详情页一次
    （无需操作，打开即可），然后回到这里。之后本轮所有候选人都会自动补全完整经历。
  `;
  el.classList.add('show');
}

function markDetailBannerReady() {
  const panel = document.getElementById('moka-panel');
  if (!panel) return;
  const el = panel.querySelector('.mp-banner');
  if (!el || !el.classList.contains('show')) return;
  el.innerHTML = '<div class="mp-banner-ok">✓ 已捕获详情接口，正在自动补全完整经历…</div>';
  setTimeout(() => { el.classList.remove('show'); el.innerHTML = ''; }, 2500);
}

function makeDraggable(el, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('mp-close')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const rect = el.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = ox + (e.clientX - sx) + 'px';
    el.style.top = oy + (e.clientY - sy) + 'px';
    el.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

console.log('[Moka 筛选] Content script 初始化完成');
