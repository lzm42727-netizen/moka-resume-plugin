/**
 * LLM 缓存持久化、筛选结果瘦身与 CSV 导出（background / content / Node 测试共用）
 */
(function (root) {
  const LLM_CACHE_STORAGE_KEY = 'mokaLlmCache';
  const LLM_CACHE_LIMIT = 500;
  const LLM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const LAST_SCREENING_PREFIX = 'mokaLastScreening:';
  const JOB_PRESET_STORAGE_KEY = 'mokaJobPresets';
  const JOB_PRESET_LIMIT = 80;
  const JOB_PRESET_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const PRESET_WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];

  const SCREENING_CSV_HEADERS = [
    '姓名', '学历', '学校', '综合分', '等级',
    '经验', '技能', '教育', '潜力',
    '硬筛', '硬筛缺项', '必备项扣分', '亮点', '差距', '反馈', '链接'
  ];

  function feedbackCsvLabel(verdict) {
    if (verdict === 'positive') return '要沟通';
    if (verdict === 'negative') return '不考虑';
    return '';
  }

  function stableHash(input) {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  function pruneTimedMap(record, now, ttlMs, limit) {
    const entries = Object.entries(record || {}).filter(([, v]) => (
      v && typeof v.savedAt === 'number' && (now - v.savedAt) < ttlMs
    ));
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    return Object.fromEntries(entries);
  }

  function putCacheRecord(record, key, value, now, ttlMs, limit) {
    const next = Object.assign({}, record || {});
    next[key] = { value, savedAt: now };
    return pruneTimedMap(next, now, ttlMs, limit);
  }

  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  }

  function dimScore(dims, key) {
    return dims && dims[key] && dims[key].score != null ? dims[key].score : '';
  }

  function screeningItemToRow(item, origin, feedbackVerdict) {
    const app = (item && item.app) || {};
    const score = (item && item.score) || {};
    const dims = score.dims || {};
    const hard = (item && item.hard) || {};
    const raw = (item && item.rawScore) || {};
    const base = String(origin || '').replace(/\/+$/, '');
    const hardLabel = hard.passed === false ? '未过' : (hard.passed ? '通过' : '');
    return [
      app.name || '',
      app.highestDegree || '',
      app.highestDegreeSchool || '',
      score.score != null ? score.score : '',
      score.level || '',
      dimScore(dims, 'experience'),
      dimScore(dims, 'skill'),
      dimScore(dims, 'education'),
      dimScore(dims, 'potential'),
      hardLabel,
      Array.isArray(hard.missing) ? hard.missing.join('；') : '',
      score.penalty != null ? score.penalty : '',
      Array.isArray(raw.highlights) ? raw.highlights.join('；') : '',
      Array.isArray(raw.concerns) ? raw.concerns.join('；') : '',
      feedbackCsvLabel(feedbackVerdict),
      app.id != null ? `${base}/candidates/application/${app.id}` : ''
    ];
  }

  function screeningToCsv(items, origin, feedbackByAppId) {
    const map = feedbackByAppId && typeof feedbackByAppId === 'object' ? feedbackByAppId : {};
    const rows = [SCREENING_CSV_HEADERS];
    (items || []).forEach((item) => {
      const appId = item && item.app && item.app.id != null ? String(item.app.id) : '';
      rows.push(screeningItemToRow(item, origin, map[appId]));
    });
    return toCsv(rows);
  }

  function slimScreeningItem(item) {
    const app = (item && item.app) || {};
    const waived = item && item.waivedMustHaves;
    const waivedArr = waived instanceof Set ? Array.from(waived) : (Array.isArray(waived) ? waived : []);
    const raw = item && item.rawScore;
    return {
      app: {
        id: app.id,
        candidateId: app.candidateId,
        name: app.name,
        highestDegree: app.highestDegree,
        highestDegreeSchool: app.highestDegreeSchool,
        specialities: app.specialities
      },
      hard: (item && item.hard) || null,
      hardLocal: (item && item.hardLocal) || null,
      score: (item && item.score) || null,
      rawScore: raw ? {
        dimensions: raw.dimensions,
        highlights: raw.highlights || [],
        concerns: raw.concerns || [],
        mustHaveResults: raw.mustHaveResults || [],
        parseError: raw.parseError,
        error: raw.error
      } : null,
      waivedMustHaves: waivedArr,
      keywords: (item && item.keywords) || null
    };
  }

  function hydrateScreeningItem(slim) {
    const item = slim || {};
    return {
      app: item.app || {},
      hard: item.hard || null,
      hardLocal: item.hardLocal || null,
      score: item.score || null,
      rawScore: item.rawScore || null,
      waivedMustHaves: new Set(item.waivedMustHaves || []),
      keywords: item.keywords || null
    };
  }

  function lastScreeningStorageKey(pipelineId) {
    return LAST_SCREENING_PREFIX + String(pipelineId || 'unknown');
  }

  function jobPresetKey(jobId) {
    return String(jobId == null ? '' : jobId).trim();
  }

  function stringList(arr, limit) {
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, limit);
  }

  function sanitizeJobPreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const hardIn = raw.hard && typeof raw.hard === 'object' ? raw.hard : (raw.hardConditions || {});
    const ageRangeValues = Array.isArray(hardIn.ageRangeValues)
      ? stringList(hardIn.ageRangeValues, 8)
      : stringList((hardIn.ageRanges || []).map((r) => r && r.label), 8);
    const weightsIn = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
    const weights = {};
    PRESET_WEIGHT_KEYS.forEach((k) => {
      const n = Number(weightsIn[k]);
      weights[k] = Number.isFinite(n) ? n : 0;
    });
    let jobSpec = null;
    if (raw.jobSpec && typeof raw.jobSpec === 'object') {
      jobSpec = {
        summary: String(raw.jobSpec.summary || ''),
        mustHaves: stringList(raw.jobSpec.mustHaves, 6),
        resumeKeywords: stringList(raw.jobSpec.resumeKeywords, 6),
        niceToHaves: stringList(raw.jobSpec.niceToHaves, 12),
        responsibilities: stringList(raw.jobSpec.responsibilities, 12),
        suggestedWeights: raw.jobSpec.suggestedWeights && typeof raw.jobSpec.suggestedWeights === 'object'
          ? raw.jobSpec.suggestedWeights
          : null
      };
    }
    return {
      jobType: raw.jobType === 'intern' ? 'intern' : 'full-time',
      hard: {
        degree: String(hardIn.degree || ''),
        schools: stringList(hardIn.schools, 8),
        exp: String(hardIn.exp || ''),
        gender: String(hardIn.gender || ''),
        internship: String(hardIn.internship || ''),
        ageRangeValues
      },
      weights,
      mustHaves: stringList(raw.mustHaves, 6),
      keywords: stringList(raw.keywords, 6),
      jobSpec
    };
  }

  function putJobPreset(record, jobId, preset, now) {
    const key = jobPresetKey(jobId);
    const clean = sanitizeJobPreset(preset);
    if (!key || !clean) return record && typeof record === 'object' ? record : {};
    return putCacheRecord(record, key, clean, now == null ? Date.now() : now, JOB_PRESET_TTL_MS, JOB_PRESET_LIMIT);
  }

  function getJobPreset(record, jobId) {
    const key = jobPresetKey(jobId);
    const row = record && key ? record[key] : null;
    if (!row || !row.value) return null;
    return sanitizeJobPreset(row.value);
  }

  const api = {
    LLM_CACHE_STORAGE_KEY,
    LLM_CACHE_LIMIT,
    LLM_CACHE_TTL_MS,
    LAST_SCREENING_PREFIX,
    JOB_PRESET_STORAGE_KEY,
    JOB_PRESET_LIMIT,
    JOB_PRESET_TTL_MS,
    SCREENING_CSV_HEADERS,
    feedbackCsvLabel,
    stableHash,
    pruneTimedMap,
    putCacheRecord,
    csvEscape,
    toCsv,
    screeningItemToRow,
    screeningToCsv,
    slimScreeningItem,
    hydrateScreeningItem,
    lastScreeningStorageKey,
    jobPresetKey,
    sanitizeJobPreset,
    putJobPreset,
    getJobPreset
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaPersist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
