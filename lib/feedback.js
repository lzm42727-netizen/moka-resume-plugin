/**
 * 筛选反馈本地存储（popup / Node 测试共用）
 */
(function (root) {
  const FEEDBACK_STORAGE_KEY = 'mokaFeedback';
  const FEEDBACK_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const FEEDBACK_LIMIT_PER_JOB = 200;
  const VALID_VERDICTS = new Set(['positive', 'negative']);
  const DIM_KEYS = ['experience', 'skill', 'education', 'potential'];

  function jobKey(jobId) {
    return String(jobId == null ? '' : jobId).trim();
  }

  function appKey(appId) {
    return String(appId == null ? '' : appId).trim();
  }

  function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const dims = {};
    if (raw.dims && typeof raw.dims === 'object') {
      DIM_KEYS.forEach((k) => {
        const d = raw.dims[k];
        if (d && typeof d.score === 'number') dims[k] = d.score;
        else if (typeof d === 'number') dims[k] = d;
      });
    }
    return {
      score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : null,
      baseScore: Number.isFinite(Number(raw.baseScore)) ? Number(raw.baseScore) : null,
      penalty: Number.isFinite(Number(raw.penalty)) ? Number(raw.penalty) : 0,
      level: String(raw.level || ''),
      dims,
      hardMissing: Array.isArray(raw.hardMissing)
        ? raw.hardMissing.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
        : [],
      waivedMustHaves: Array.isArray(raw.waivedMustHaves)
        ? raw.waivedMustHaves.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
        : [],
      highlights: Array.isArray(raw.highlights)
        ? raw.highlights.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
        : [],
      concerns: Array.isArray(raw.concerns)
        ? raw.concerns.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
        : [],
      pluginRecommend: !!raw.pluginRecommend
    };
  }

  function sanitizeFeedbackEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const verdict = VALID_VERDICTS.has(raw.verdict) ? raw.verdict : null;
    if (!verdict) return null;
    const savedAt = typeof raw.savedAt === 'number' ? raw.savedAt : Date.now();
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : savedAt;
    return {
      verdict,
      savedAt,
      updatedAt,
      snapshot: sanitizeSnapshot(raw.snapshot)
    };
  }

  function pruneJobFeedback(jobBag, now, ttlMs, limit) {
    const entries = Object.entries(jobBag || {})
      .map(([id, raw]) => [id, sanitizeFeedbackEntry(raw)])
      .filter(([, entry]) => entry && (now - entry.updatedAt) < ttlMs);
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    return Object.fromEntries(entries.map(([id, entry]) => [id, entry]));
  }

  function getFeedbackForJob(record, jobId) {
    const key = jobKey(jobId);
    if (!key || !record || typeof record !== 'object') return {};
    const bag = record[key];
    if (!bag || typeof bag !== 'object') return {};
    const out = {};
    Object.entries(bag).forEach(([appId, raw]) => {
      const entry = sanitizeFeedbackEntry(raw);
      if (entry) out[appKey(appId)] = entry;
    });
    return out;
  }

  function getFeedbackVerdict(record, jobId, appId) {
    const bag = getFeedbackForJob(record, jobId);
    const entry = bag[appKey(appId)];
    return entry ? entry.verdict : null;
  }

  function putFeedback(record, jobId, appId, verdict, snapshot, now) {
    const jk = jobKey(jobId);
    const ak = appKey(appId);
    if (!jk || !ak) return record && typeof record === 'object' ? record : {};
    const next = Object.assign({}, record || {});
    const jobBag = Object.assign({}, next[jk] || {});
    const ts = now == null ? Date.now() : now;

    if (!verdict || !VALID_VERDICTS.has(verdict)) {
      delete jobBag[ak];
    } else {
      const prev = sanitizeFeedbackEntry(jobBag[ak]);
      jobBag[ak] = {
        verdict,
        savedAt: prev ? prev.savedAt : ts,
        updatedAt: ts,
        snapshot: sanitizeSnapshot(snapshot)
      };
    }

    if (Object.keys(jobBag).length === 0) delete next[jk];
    else next[jk] = pruneJobFeedback(jobBag, ts, FEEDBACK_TTL_MS, FEEDBACK_LIMIT_PER_JOB);
    return next;
  }

  function summarizeFeedback(record, jobId) {
    const bag = getFeedbackForJob(record, jobId);
    let positive = 0;
    let negative = 0;
    Object.values(bag).forEach((entry) => {
      if (entry.verdict === 'positive') positive++;
      else if (entry.verdict === 'negative') negative++;
    });
    return { total: positive + negative, positive, negative };
  }

  function feedbackUiLabel(verdict) {
    if (verdict === 'positive') return '要沟通';
    if (verdict === 'negative') return '不考虑';
    return '';
  }

  function feedbackCsvLabel(verdict) {
    return feedbackUiLabel(verdict);
  }

  function listFeedbackExamples(record, jobId, verdict, limit) {
    if (!VALID_VERDICTS.has(verdict)) return [];
    const bag = getFeedbackForJob(record, jobId);
    const cap = typeof limit === 'number' && limit > 0 ? limit : 3;
    return Object.values(bag)
      .filter((entry) => entry.verdict === verdict)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, cap);
  }

  /** Phase 2：从反馈记录生成 prompt 片段 */
  function buildFeedbackContext(record, jobId, opts) {
    const options = opts || {};
    const posLimit = options.positiveLimit != null ? options.positiveLimit : 3;
    const negLimit = options.negativeLimit != null ? options.negativeLimit : 3;
    const positives = listFeedbackExamples(record, jobId, 'positive', posLimit);
    const negatives = listFeedbackExamples(record, jobId, 'negative', negLimit);
    if (!positives.length && !negatives.length) return '';

    const lines = [];
    if (positives.length) {
      lines.push('该岗位招聘官曾标记为「要沟通」的候选人特征：');
      positives.forEach((entry, i) => {
        const s = entry.snapshot || {};
        const mismatch = s.pluginRecommend === false ? '（当时 AI 未推荐）' : '';
        const bits = [
          s.level ? '等级 ' + s.level : '',
          Number.isFinite(s.score) ? '综合分 ' + s.score : '',
          (s.highlights || []).slice(0, 2).join('；')
        ].filter(Boolean);
        lines.push((i + 1) + '. ' + (bits.join(' · ') || '（无摘要）') + mismatch);
      });
    }
    if (negatives.length) {
      lines.push('该岗位招聘官曾标记为「不考虑」的常见原因：');
      negatives.forEach((entry, i) => {
        const s = entry.snapshot || {};
        const mismatch = s.pluginRecommend === true ? '（当时 AI 曾推荐）' : '';
        const bits = [
          s.level ? '等级 ' + s.level : '',
          Number.isFinite(s.score) ? '综合分 ' + s.score : '',
          (s.concerns || []).slice(0, 2).join('；')
        ].filter(Boolean);
        lines.push((i + 1) + '. ' + (bits.join(' · ') || '（无摘要）') + mismatch);
      });
    }
    return lines.join('\n');
  }

  function hashRevision(input) {
    const s = String(input || '');
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

  /** 反馈变更时用于评分缓存失效 */
  function feedbackRevision(record, jobId) {
    const bag = getFeedbackForJob(record, jobId);
    const keys = Object.keys(bag).sort();
    if (!keys.length) return 'none';
    const payload = keys.map((k) => {
      const e = bag[k];
      return k + '\t' + e.verdict + '\t' + e.updatedAt;
    }).join('\n');
    return hashRevision(payload);
  }

  function buildFeedbackBundle(record, jobId, opts) {
    const summary = summarizeFeedback(record, jobId);
    const context = buildFeedbackContext(record, jobId, opts);
    return {
      context,
      rev: feedbackRevision(record, jobId),
      total: summary.total,
      positive: summary.positive,
      negative: summary.negative
    };
  }

  function feedbackPromptBlock(context) {
    const t = context == null ? '' : String(context).trim();
    if (!t) return '';
    return '【招聘官历史偏好（来自此前「要沟通 / 不考虑」标注，请对齐）】\n' + t
      + '\n说明：上述偏好优先于通用打分习惯。若候选人特征与「要沟通」样本相近，可适当上调相关维度；'
      + '与「不考虑」原因重合的，应下调并在 concerns 中说明。不要机械复制历史分数。';
  }

  const api = {
    FEEDBACK_STORAGE_KEY,
    FEEDBACK_TTL_MS,
    FEEDBACK_LIMIT_PER_JOB,
    jobKey,
    appKey,
    sanitizeSnapshot,
    sanitizeFeedbackEntry,
    getFeedbackForJob,
    getFeedbackVerdict,
    putFeedback,
    summarizeFeedback,
    feedbackCsvLabel,
    feedbackUiLabel,
    listFeedbackExamples,
    buildFeedbackContext,
    feedbackRevision,
    buildFeedbackBundle,
    feedbackPromptBlock
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
