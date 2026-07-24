/**
 * Moka 智能简历筛选 - Background Service Worker
 *
 * 统一的 LLM API 调用层。所有对外部 API 的请求都在这里发起，
 * content script 只负责识别页面和展示结果，通过消息与本文件通信。
 * 这样可以避开 Moka 页面 CSP（connect-src）对 content script fetch 的拦截。
 */

console.log('[Moka 筛选] Background service worker 已启动');

// 本地私有配置（config.local.js，已 gitignore）：如存在则强制覆盖对应设置
try { importScripts('config.local.js'); } catch (e) { /* 无本地配置时忽略 */ }
function localForcedSettings() {
  return (typeof self !== 'undefined' && self.MOKA_LOCAL_SETTINGS) ? self.MOKA_LOCAL_SETTINGS : {};
}

const DEFAULT_SETTINGS = {
  apiProvider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelName: 'gpt-4o'
};

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

// 评分缓存：同一候选人 + JD画像 + 配置只调用一次 API，避免重复扣费
const scoreCache = new Map();
// JD 解读缓存：同一 JD 只解读一次
const jdCache = new Map();

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
        .then((score) => sendResponse({ ok: true, score }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true; // 异步响应

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
      // 转发进度更新到 popup（popup 可能未打开，忽略错误）
      chrome.runtime.sendMessage({ ...request }).catch(() => {});
      sendResponse({ received: true });
      return false;

    default:
      sendResponse({ received: true });
      return false;
  }
});

/**
 * 抓取候选人「附件简历」原件（Moka 托管在 OSS 上的 HTML/文本），提取正文供 AI 阅读。
 * 主动投递 + 附件简历的候选人，其完整实习/工作经历只存在于这份原件中，结构化 JSON 往往缺失。
 * 需要 service worker 具备 *.mokahr.com 的 host 权限以绕过 CORS。
 */
const resumeTextCache = new Map();
async function handleFetchResume(url) {
  if (!url) throw new Error('缺少简历链接');
  if (resumeTextCache.has(url)) return resumeTextCache.get(url);

  const resp = await fetch(url, { method: 'GET', credentials: 'omit' });
  if (!resp.ok) throw new Error(`简历抓取失败 HTTP ${resp.status}`);
  const raw = await resp.text();
  const text = htmlToText(raw);
  const clipped = text.length > 12000 ? text.slice(0, 12000) : text;

  resumeTextCache.set(url, clipped);
  if (resumeTextCache.size > 500) resumeTextCache.delete(resumeTextCache.keys().next().value);
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
 * 解读 JD，产出岗位画像 + 四维度建议权重（带缓存）
 */
async function handleAnalyzeJob({ jobJD, jobType }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('未配置 API Key');

  const cacheKey = JSON.stringify({ jobJD, jobType, model: settings.modelName });
  if (jdCache.has(cacheKey)) return jdCache.get(cacheKey);

  const systemPrompt =
    '你是资深招聘专家，擅长解读职位 JD 并提炼岗位画像。直接输出 JSON 结果，不要输出思考过程或多余文字。';
  const userPrompt = buildJDAnalysisPrompt(jobJD, jobType);
  const content = await callLLM(settings, systemPrompt, userPrompt, { maxTokens: 2000, temperature: 0 });
  const spec = parseJDAnalysis(content);

  jdCache.set(cacheKey, spec);
  return spec;
}

/**
 * 对单个候选人做「分维度」评估（带缓存）。
 * 返回原始分维度结果，最终综合分由 content 侧按用户权重本地计算。
 * profile: content 侧拼好的候选人完整画像文本
 * config.jobSpec: 上一步 JD 解读结果
 */
async function handleScoreCandidate({ profile, config }) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    return { dimensions: neutralDimensions('未配置 API Key'), mustHaveResults: [], highlights: [], concerns: ['❌ 未配置 API Key'], parseError: true };
  }

  const jobSpec = config.jobSpec || {};
  const cacheKey = JSON.stringify({ profile, spec: jobSpec, jobJD: config.jobJD || '', jobType: config.jobType, model: settings.modelName });
  if (scoreCache.has(cacheKey)) return scoreCache.get(cacheKey);

  const systemPrompt =
    '你是资深招聘专家，擅长客观评估候选人与岗位的匹配度。'
    + '严格只输出一个 JSON 对象，禁止输出任何思考过程、前言、分析说明或 markdown。'
    + '每个维度的 reason 控制在 40 字以内，highlights/concerns 每条不超过 30 字。';
  const userPrompt = buildDimensionPrompt(profile, jobSpec, config.jobType, config.jobJD);

  // 推理型模型会先输出思考，需给足 token，避免 JSON 被截断
  const content = await callLLM(settings, systemPrompt, userPrompt, { maxTokens: 4000, temperature: 0 });
  const raw = parseDimensionResponse(content);

  // 解析失败不写缓存，避免把错误结果固化，下一轮可重试
  if (!raw.parseError) scoreCache.set(cacheKey, raw);
  return raw;
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
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const data = await response.json();
        return extractContent(provider, data);
      }

      // 429 / 5xx 可重试
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers.get('retry-after'), 10);
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`[Moka 筛选] API ${response.status}，${Math.round(waitMs)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
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

const JOB_TYPE_TEXT = {
  'full-time': '正式员工（看重完整工作经验与稳定性）',
  intern: '实习生（看重学习能力、专业相关性与可实习时长）'
};

const DIM_DESC = [
  '- experience 经验相关性：候选人过往经历/项目与该岗位核心职责的匹配程度',
  '- skill 技能匹配：候选人是否具备该岗位所需的关键技能/工具',
  '- education 专业与教育背景：专业方向、学历与岗位的契合度',
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
1. summary：一句话概括该岗位主要在做什么。
2. responsibilities：列出 3-6 条核心职责。
3. mustHaves：列出该岗位的必备技能/经验/资质（硬门槛）。
4. niceToHaves：列出加分项。
5. suggestedWeights：给出四个维度的建议权重（整数、合计恰好 100），要体现该岗位最看重什么（例如强执行/经验型岗位 experience 权重更高；校招/实习岗 potential 与 education 权重更高）。
只返回以下 JSON，不要输出多余文字：
{
  "summary": "...",
  "responsibilities": ["..."],
  "mustHaves": ["..."],
  "niceToHaves": ["..."],
  "suggestedWeights": {"experience": 40, "skill": 30, "education": 20, "potential": 10}
}`;
}

/**
 * 把 JD 画像渲染成给评分用的文本
 */
function renderSpec(spec) {
  const lines = [];
  if (spec.summary) lines.push('岗位概述：' + spec.summary);
  if (Array.isArray(spec.responsibilities) && spec.responsibilities.length) lines.push('核心职责：\n- ' + spec.responsibilities.join('\n- '));
  if (Array.isArray(spec.mustHaves) && spec.mustHaves.length) lines.push('必备项：\n- ' + spec.mustHaves.join('\n- '));
  if (Array.isArray(spec.niceToHaves) && spec.niceToHaves.length) lines.push('加分项：\n- ' + spec.niceToHaves.join('\n- '));
  return lines.join('\n\n') || '（无岗位画像，请依据 JD 常识判断）';
}

/**
 * 候选人「分维度」评分提示词
 */
function buildDimensionPrompt(profile, spec, jobType, jobJD) {
  const hasSpec = spec && (spec.summary || (spec.responsibilities && spec.responsibilities.length) || (spec.mustHaves && spec.mustHaves.length));
  const jobBlock = hasSpec ? renderSpec(spec) : (jobJD || '（无岗位信息）');

  return `请基于岗位信息，对候选人做「分维度」评估。

【候选人完整信息】
${profile || '（无候选人信息）'}

【岗位信息】
${jobBlock}

【职位类型】
${JOB_TYPE_TEXT[jobType] || JOB_TYPE_TEXT['full-time']}

请对以下四个维度分别打分（0-100 整数），并给出简短理由，尽量引用候选人简历中的具体经历/项目作为证据：
${DIM_DESC}

同时对每条「必备项」判断候选人是否满足（met: true/false）：只在简历中有明确证据时才判 true；也不要在已有相关经历时臆断为 false。

评分注意：
1. 仅依据上方候选人信息判断，逐条阅读每段经历（含实习、项目）的具体描述，据实认定其相关性，切勿在已列出经历时臆断"缺乏相关经验"。
2. 经历与岗位职责高度相关但专业名称不完全对口时，不要仅因专业不符就一票否决。
只返回以下 JSON，不要输出多余文字：
{
  "dimensions": {
    "experience": {"score": 0, "reason": "..."},
    "skill": {"score": 0, "reason": "..."},
    "education": {"score": 0, "reason": "..."},
    "potential": {"score": 0, "reason": "..."}
  },
  "mustHaveResults": [{"item": "必备项", "met": true, "note": "证据/说明"}],
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

function neutralDimensions(reason) {
  const r = reason || '';
  return {
    experience: { score: 50, reason: r },
    skill: { score: 50, reason: r },
    education: { score: 50, reason: r },
    potential: { score: 50, reason: r }
  };
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
  let best = null;
  for (const c of objs) {
    const p = tryParseJson(c);
    if (p && (p.suggestedWeights || p.summary || p.responsibilities || p.mustHaves)) {
      best = p;
      if (p.suggestedWeights) break;
    }
  }
  if (!best) {
    return { summary: '', responsibilities: [], mustHaves: [], niceToHaves: [], suggestedWeights: { ...DEFAULT_WEIGHTS }, parseError: true };
  }
  return {
    summary: best.summary ? String(best.summary) : '',
    responsibilities: arrOf(best.responsibilities, 8),
    mustHaves: arrOf(best.mustHaves, 10),
    niceToHaves: arrOf(best.niceToHaves, 10),
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
    if (p && p.dimensions) { best = p; break; }
  }
  // 兜底 1：JSON 被截断（花括号未闭合）→ 尝试修复后再解析
  if (!best) {
    const repaired = tryParseJson(repairTruncatedJson(text));
    if (repaired && repaired.dimensions) best = repaired;
  }
  // 兜底 2：仍失败 → 用正则宽松抽取各维度分数/理由（能救多少救多少）
  if (!best) {
    const loose = looseExtractDimensions(text);
    if (loose) {
      best = { dimensions: loose, mustHaveResults: [], highlights: [], concerns: looseExtractArray(text, 'concerns') };
    }
  }
  if (!best) {
    return {
      dimensions: neutralDimensions('模型返回解析失败'),
      mustHaveResults: [],
      highlights: [],
      concerns: ['无法解析模型返回，原文片段: ' + text.slice(0, 80)],
      parseError: true
    };
  }
  const dim = (k) => {
    const o = (best.dimensions && best.dimensions[k]) || {};
    return { score: clampScore(o.score), reason: o.reason ? String(o.reason) : '' };
  };
  const mustHaveResults = Array.isArray(best.mustHaveResults)
    ? best.mustHaveResults
        .map((r) => ({ item: String((r && r.item) || ''), met: !!(r && r.met), note: r && r.note ? String(r.note) : '' }))
        .filter((r) => r.item)
        .slice(0, 12)
    : [];
  return {
    dimensions: {
      experience: dim('experience'),
      skill: dim('skill'),
      education: dim('education'),
      potential: dim('potential')
    },
    mustHaveResults,
    highlights: arrOf(best.highlights),
    concerns: arrOf(best.concerns)
  };
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

function levelFromScore(score) {
  if (score >= 75) return '强烈推荐';
  if (score >= 50) return '值得推荐';
  if (score >= 35) return '一般';
  return '不推荐';
}

function isRetriableNetworkError(error) {
  return error instanceof TypeError; // fetch 网络失败通常是 TypeError
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
    chrome.storage.local.set({ mokaSettings: DEFAULT_SETTINGS });
    console.log('[Moka 筛选] 已初始化默认设置');
  }
});

console.log('[Moka 筛选] Background service worker 初始化完成');
