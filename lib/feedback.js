/**
 * 筛选反馈本地存储（popup / Node 测试共用）
 */
(function (root) {
  const FEEDBACK_STORAGE_KEY = 'mokaFeedback';
  const FEEDBACK_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const FEEDBACK_LIMIT_PER_JOB = 200;
  const VALID_VERDICTS = new Set(['recommend', 'eliminate']);
  const LEGACY_VERDICT_MAP = { positive: 'recommend', negative: 'eliminate' };
  const DIM_KEYS = ['experience', 'skill', 'education', 'potential'];

  function normalizeVerdict(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (VALID_VERDICTS.has(v)) return v;
    if (LEGACY_VERDICT_MAP[v]) return LEGACY_VERDICT_MAP[v];
    return null;
  }

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
      matchScore: Number.isFinite(Number(raw.matchScore))
        ? Number(raw.matchScore)
        : (Number.isFinite(Number(raw.baseScore)) ? Number(raw.baseScore) : null),
      penalty: Number.isFinite(Number(raw.penalty)) ? Number(raw.penalty) : 0,
      level: String(raw.level || ''),
      advanceReason: String(raw.advanceReason || ''),
      bonusApplied: Number.isFinite(Number(raw.bonusApplied)) ? Number(raw.bonusApplied) : 0,
      bonusMetCount: Number.isFinite(Number(raw.bonusMetCount)) ? Number(raw.bonusMetCount) : 0,
      bonusTotalCount: Number.isFinite(Number(raw.bonusTotalCount)) ? Number(raw.bonusTotalCount) : 0,
      bonusPromoted: !!raw.bonusPromoted,
      bonusKeywordResults: Array.isArray(raw.bonusKeywordResults)
        ? raw.bonusKeywordResults
            .map((r) => ({
              item: String((r && r.item) || '').trim(),
              met: !!(r && r.met),
              reason: String((r && (r.reason || r.note)) || '').trim()
            }))
            .filter((r) => r.item)
            .slice(0, 5)
        : [],
      dims,
      name: String(raw.name || '').trim().slice(0, 64),
      meta: String(raw.meta || '').trim().slice(0, 160),
      highestDegree: String(raw.highestDegree || '').trim().slice(0, 32),
      highestDegreeSchool: String(raw.highestDegreeSchool || '').trim().slice(0, 80),
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
    const verdict = normalizeVerdict(raw.verdict);
    if (!verdict) return null;
    const savedAt = typeof raw.savedAt === 'number' ? raw.savedAt : Date.now();
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : savedAt;
    return {
      verdict,
      savedAt,
      updatedAt,
      snapshot: sanitizeSnapshot(raw.snapshot),
      mokaSynced: raw.mokaSynced !== false,
      syncFailed: !!raw.syncFailed
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
    const entry = getFeedbackEntry(record, jobId, appId);
    return entry ? entry.verdict : null;
  }

  function getFeedbackEntry(record, jobId, appId) {
    const bag = getFeedbackForJob(record, jobId);
    return bag[appKey(appId)] || null;
  }

  function isSyncedFeedback(entry) {
    if (!entry) return false;
    if (entry.syncFailed) return false;
    return entry.mokaSynced !== false;
  }

  function feedbackSyncState(entry) {
    if (!entry) return 'none';
    if (entry.syncFailed) return 'failed';
    if (entry.mokaSynced === false) return 'pending';
    return 'synced';
  }

  // 同一个按钮的第二次点击：只有已同步成功的决定才是撤销，否则一律当作重试同步
  function mokaActionIntent(entry, verdict) {
    if (!entry || entry.verdict !== verdict) return 'submit';
    return feedbackSyncState(entry) === 'synced' ? 'cancel' : 'retry';
  }

  function putFeedback(record, jobId, appId, verdict, snapshot, now, opts) {
    const jk = jobKey(jobId);
    const ak = appKey(appId);
    if (!jk || !ak) return record && typeof record === 'object' ? record : {};
    const next = Object.assign({}, record || {});
    const jobBag = Object.assign({}, next[jk] || {});
    const ts = now == null ? Date.now() : now;
    const normalized = normalizeVerdict(verdict);

    if (!normalized) {
      delete jobBag[ak];
    } else {
      const prev = sanitizeFeedbackEntry(jobBag[ak]);
      const options = opts && typeof opts === 'object' ? opts : {};
      let mokaSynced = true;
      let syncFailed = false;
      if (options.mokaSynced === false) mokaSynced = false;
      else if (prev && prev.mokaSynced === false && options.mokaSynced !== true) mokaSynced = false;
      if (options.syncFailed) syncFailed = true;
      else if (options.mokaSynced === true) syncFailed = false;
      else if (prev) syncFailed = !!prev.syncFailed;
      jobBag[ak] = {
        verdict: normalized,
        savedAt: prev ? prev.savedAt : ts,
        updatedAt: ts,
        snapshot: sanitizeSnapshot(snapshot),
        mokaSynced,
        syncFailed
      };
    }

    if (Object.keys(jobBag).length === 0) delete next[jk];
    else next[jk] = pruneJobFeedback(jobBag, ts, FEEDBACK_TTL_MS, FEEDBACK_LIMIT_PER_JOB);
    return next;
  }

  function summarizeFeedback(record, jobId) {
    const bag = getFeedbackForJob(record, jobId);
    let recommend = 0;
    let eliminate = 0;
    Object.values(bag).forEach((entry) => {
      if (entry.verdict === 'recommend') recommend++;
      else if (entry.verdict === 'eliminate') eliminate++;
    });
    return {
      total: recommend + eliminate,
      recommend,
      eliminate,
      positive: recommend,
      negative: eliminate
    };
  }

  function feedbackUiLabel(verdict) {
    const v = normalizeVerdict(verdict);
    if (v === 'recommend') return '推荐给用人部门';
    if (v === 'eliminate') return '淘汰';
    return '';
  }

  function feedbackCsvLabel(verdict) {
    return feedbackUiLabel(verdict);
  }

  function isPreferenceMismatch(entry, verdict) {
    const s = (entry && entry.snapshot) || {};
    if (verdict === 'recommend') return s.pluginRecommend === false;
    if (verdict === 'eliminate') return s.pluginRecommend === true;
    return false;
  }

  function formatPreferenceLine(entry, kind) {
    const s = (entry && entry.snapshot) || {};
    const bits = [];
    if (s.level) bits.push(s.level);
    if (Number.isFinite(s.score)) bits.push('决策分 ' + s.score);
    if (Number.isFinite(s.matchScore)) bits.push('经历匹配 ' + s.matchScore);
    if ((s.bonusTotalCount || 0) > 0) {
      bits.push('加分看 ' + (s.bonusMetCount || 0) + '/' + s.bonusTotalCount);
    }
    if (s.bonusPromoted) bits.push('加分晋级');
    const missing = (s.hardMissing || []).slice(0, 2).join('、');
    if (missing) bits.push('未过门槛 ' + missing);
    const note = kind === 'recommend' ? (s.highlights || [])[0] : (s.concerns || [])[0];
    if (note) bits.push(note);
    let mismatch = '';
    if (kind === 'recommend' && s.pluginRecommend === false) mismatch = '（当时插件未推）';
    if (kind === 'eliminate' && s.pluginRecommend === true) mismatch = '（当时插件曾推）';
    return (bits.join(' · ') || '（无摘要）') + mismatch;
  }

  function countPhrases(list) {
    const counts = Object.create(null);
    (list || []).forEach((raw) => {
      const t = String(raw || '').trim();
      if (!t || t.length < 2) return;
      counts[t] = (counts[t] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([text, count]) => ({ text, count }));
  }

  function calLib() {
    return root.MokaCalibrate || (typeof require !== 'undefined' ? require('./calibrate.js') : null);
  }

  function normalizePrefLabel(raw) {
    const cal = calLib();
    if (cal && typeof cal.normalizeMustHaveLabel === 'function') {
      return cal.normalizeMustHaveLabel(raw);
    }
    return String(raw || '').trim();
  }

  /** 反复信号按「归一化后聚合」计数（与 lib/calibrate.js 同一套口径，避免同义措辞被拆散） */
  function countSignals(list) {
    const cal = calLib();
    if (cal && typeof cal.groupCalibrationSignals === 'function') {
      return cal.groupCalibrationSignals(list);
    }
    return countPhrases(list);
  }

  function buildPreferenceAggregate(record, jobId) {
    const bag = getFeedbackForJob(record, jobId);
    let recommend = 0;
    let eliminate = 0;
    let over = 0;
    let under = 0;
    const missing = [];
    const concerns = [];
    Object.values(bag).forEach((entry) => {
      if (!entry) return;
      const s = entry.snapshot || {};
      if (entry.verdict === 'recommend') {
        recommend++;
        if (s.pluginRecommend === false) under++;
      } else if (entry.verdict === 'eliminate') {
        eliminate++;
        (s.hardMissing || []).forEach((m) => {
          const item = normalizePrefLabel(m);
          if (item) missing.push(item);
        });
        (s.concerns || []).forEach((c) => {
          const t = String(c || '').trim();
          if (t) concerns.push(t);
        });
        if (s.pluginRecommend === true) over++;
      }
    });
    const total = recommend + eliminate;
    if (!total) return '';
    const bits = ['本岗已决策 ' + total + '（推荐 ' + recommend + ' · 淘汰 ' + eliminate + '）'];
    if (over) bits.push('插件推你却淘汰 ' + over);
    if (under) bits.push('你推插件未推 ' + under);
    const signals = [];
    countSignals(missing).filter((x) => x.count >= 2).slice(0, 2).forEach((x) => {
      signals.push('未过门槛「' + x.text + '」×' + x.count);
    });
    countSignals(concerns).filter((x) => x.count >= 2).slice(0, 2).forEach((x) => {
      if (signals.some((s) => s.indexOf('「' + x.text + '」') >= 0)) return;
      signals.push('淘汰原因「' + x.text + '」×' + x.count);
    });
    let out = bits.join('；') + '。';
    if (signals.length) out += '\n反复信号：' + signals.join('；') + '。';
    return out;
  }

  function listFeedbackExamples(record, jobId, verdict, limit) {
    const v = normalizeVerdict(verdict);
    if (!v) return [];
    const bag = getFeedbackForJob(record, jobId);
    const cap = typeof limit === 'number' && limit > 0 ? limit : 3;
    return Object.values(bag)
      .filter((entry) => entry.verdict === v)
      .sort((a, b) => {
        const am = isPreferenceMismatch(a, v) ? 1 : 0;
        const bm = isPreferenceMismatch(b, v) ? 1 : 0;
        if (bm !== am) return bm - am;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, cap);
  }

  /** Phase 2：从反馈记录生成 prompt 片段 */
  function buildFeedbackContext(record, jobId, opts) {
    const options = opts || {};
    const recLimit = options.recommendLimit != null ? options.recommendLimit : (options.positiveLimit || 3);
    const elimLimit = options.eliminateLimit != null ? options.eliminateLimit : (options.negativeLimit || 3);
    const recommends = listFeedbackExamples(record, jobId, 'recommend', recLimit);
    const eliminates = listFeedbackExamples(record, jobId, 'eliminate', elimLimit);
    if (!recommends.length && !eliminates.length) return '';

    const lines = [];
    const aggregate = buildPreferenceAggregate(record, jobId);
    if (aggregate) lines.push(aggregate);
    if (recommends.length) {
      lines.push('该岗位招聘官曾「推荐给用人部门」的候选人特征：');
      recommends.forEach((entry, i) => {
        lines.push((i + 1) + '. ' + formatPreferenceLine(entry, 'recommend'));
      });
    }
    if (eliminates.length) {
      lines.push('该岗位招聘官曾「淘汰」的常见原因：');
      eliminates.forEach((entry, i) => {
        lines.push((i + 1) + '. ' + formatPreferenceLine(entry, 'eliminate'));
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
      recommend: summary.recommend,
      eliminate: summary.eliminate,
      positive: summary.recommend,
      negative: summary.eliminate
    };
  }

  function feedbackPromptBlock(context) {
    const t = context == null ? '' : String(context).trim();
    if (!t) return '';
    return '【招聘官历史偏好（来自此前「推荐给用人部门 / 淘汰」决策，请对齐）】\n' + t
      + '\n说明：开头是全岗统计，后面是样例。上述偏好优先于通用打分习惯。与「推荐」样本经历相近时，不要仅因重点看字面缺失把匹配分打穿 50；'
      + '与「淘汰」常见差距重合时应在 concerns 写明。加分看是否具备由证据判定，不要把加分项写入 matchScore。'
      + '历史反馈只用于校准本岗偏好，不得据此创建新的硬性一票否决条件；只有岗位配置里已明确存在的硬性门槛才算硬性门槛。'
      + '简历未提及某项，不等于候选人不具备该项。不要机械复制历史分数。';
  }

  function feedbackEntryToResultView(appId, entry) {
    const e = sanitizeFeedbackEntry(entry);
    if (!e) return null;
    const s = e.snapshot || {};
    const dims = {};
    if (s.dims && typeof s.dims === 'object') {
      Object.keys(s.dims).forEach((k) => {
        const n = s.dims[k];
        if (typeof n === 'number') dims[k] = { score: n };
      });
    }
    const hasScore = Number.isFinite(s.score) || !!s.level;
    const hardMissing = Array.isArray(s.hardMissing) ? s.hardMissing.slice() : [];
    const name = s.name || ('候选人 ' + appId);
    const meta = s.meta
      || [s.highestDegree, s.highestDegreeSchool].filter(Boolean).join(' · ');
    return {
      id: appId,
      name,
      meta,
      highestDegree: s.highestDegree || '',
      highestDegreeSchool: s.highestDegreeSchool || '',
      hardPassed: hardMissing.length === 0,
      structuredHardPassed: hardMissing.length === 0,
      hardMissing,
      keywords: { hit: [], miss: [] },
      score: hasScore
        ? {
            score: s.score,
            level: s.level || '',
            advanceReason: s.advanceReason || '',
            dims: Object.keys(dims).length ? dims : null,
            suggestions: [],
            highlights: s.highlights || [],
            concerns: s.concerns || [],
            unmet: [],
            waivedUnmet: (s.waivedMustHaves || []).map((item) => ({ item, met: false })),
            unmetNice: [],
            penalty: s.penalty || 0,
            bonusKeywordResults: s.bonusKeywordResults || [],
            bonusPoints: Math.min(15, (s.bonusMetCount || 0) * 3),
            bonusApplied: s.bonusApplied || 0,
            bonusMetCount: s.bonusMetCount || 0,
            bonusTotalCount: s.bonusTotalCount || 0,
            bonusPromoted: !!s.bonusPromoted,
            baseScore: s.baseScore,
            matchScore: s.matchScore
          }
        : null,
      stage: null,
      rescoring: false,
      feedback: e.verdict,
      feedbackSync: feedbackSyncState(e),
      fromHistory: true,
      decidedAt: e.updatedAt
    };
  }

  /** 本岗全部已决策视图：当前批次优先，其余用反馈快照补齐 */
  function listDecidedResultViews(liveViews, record, jobId) {
    const bag = getFeedbackForJob(record, jobId);
    const liveById = new Map();
    (liveViews || []).forEach((v) => {
      if (v && v.id != null) liveById.set(String(v.id), v);
    });
    const out = [];
    Object.entries(bag).forEach(([appId, entry]) => {
      const live = liveById.get(appId);
      if (live) {
        out.push(Object.assign({}, live, {
          feedback: entry.verdict,
          feedbackSync: feedbackSyncState(entry),
          fromHistory: false,
          decidedAt: entry.updatedAt
        }));
      } else {
        const view = feedbackEntryToResultView(appId, entry);
        if (view) out.push(view);
      }
    });
    out.sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
    return out;
  }

  function resultViewToCsvItem(view) {
    if (!view) return null;
    const metaParts = String(view.meta || '').split(/\s*·\s*/).map((x) => x.trim()).filter(Boolean);
    const degree = view.highestDegree || metaParts[0] || '';
    const school = view.highestDegreeSchool || metaParts[1] || '';
    const dims = {};
    if (view.score && view.score.dims && typeof view.score.dims === 'object') {
      Object.keys(view.score.dims).forEach((k) => {
        const d = view.score.dims[k];
        if (d && typeof d === 'object') dims[k] = d;
        else if (typeof d === 'number') dims[k] = { score: d };
      });
    }
    return {
      app: {
        id: view.id,
        name: view.name || '',
        highestDegree: degree,
        highestDegreeSchool: school
      },
      score: view.score
        ? {
            score: view.score.score,
            level: view.score.level || '',
            dims,
            penalty: view.score.penalty
          }
        : {},
      hard: {
        passed: view.structuredHardPassed !== false && view.hardPassed !== false,
        missing: Array.isArray(view.hardMissing) ? view.hardMissing : []
      },
      rawScore: {
        highlights: (view.score && view.score.highlights) || [],
        concerns: (view.score && view.score.concerns) || []
      },
      decidedAt: view.decidedAt || null,
      feedbackSync: view.feedbackSync || ''
    };
  }

  const api = {
    FEEDBACK_STORAGE_KEY,
    FEEDBACK_TTL_MS,
    FEEDBACK_LIMIT_PER_JOB,
    normalizeVerdict,
    jobKey,
    appKey,
    sanitizeSnapshot,
    sanitizeFeedbackEntry,
    getFeedbackForJob,
    getFeedbackVerdict,
    getFeedbackEntry,
    isSyncedFeedback,
    feedbackSyncState,
    mokaActionIntent,
    putFeedback,
    summarizeFeedback,
    feedbackCsvLabel,
    buildFeedbackContext,
    feedbackRevision,
    buildFeedbackBundle,
    feedbackPromptBlock,
    feedbackEntryToResultView,
    listDecidedResultViews,
    resultViewToCsvItem
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
