/**
 * 评分合成与错误结果（content / background / Node 测试共用）
 */
(function (root) {
  const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
  const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
  const MUST_HAVE_TIERS = ['must', 'important', 'nice'];
  const TIER_PENALTY = { must: 5, important: 3, nice: 0 };
  const MUST_HAVE_PENALTY_CAP = 20;
  /** @deprecated use TIER_PENALTY.must */
  const MUST_HAVE_PENALTY = TIER_PENALTY.must;
  const STRUCTURED_HARD_MODE = 'tag';

  function scoreErrorResult(message) {
    const msg = message || '评分失败';
    return {
      dimensions: null,
      mustHaveResults: [],
      highlights: [],
      concerns: [msg],
      parseError: true,
      error: msg
    };
  }

  function isScoreFailure(raw) {
    return !raw || raw.parseError === true || !raw.dimensions;
  }

  /** 评分失败是否值得自动重试（配置类错误不重试） */
  function isRetryableScoreFailure(raw) {
    if (!isScoreFailure(raw)) return false;
    const msg = String((raw && (raw.error || (raw.concerns && raw.concerns[0]))) || '');
    if (/未配置\s*API\s*Key/i.test(msg)) return false;
    return true;
  }

  const SCORE_AUTO_RETRY_MAX = 2;

  function normalizeTier(tier) {
    const t = String(tier || '').trim().toLowerCase();
    if (t === 'important' || t === 'nice') return t;
    return 'must';
  }

  function normalizeMustHaveItem(item) {
    return String(item || '').trim();
  }

  function normalizeWeightPercents(weights) {
    const def = { experience: 40, skill: 30, education: 20, potential: 10 };
    let vals = WEIGHT_KEYS.map((k) => {
      const n = Number(weights && weights[k]);
      return Number.isFinite(n) && n >= 0 ? n : def[k];
    });
    let sum = vals.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      vals = WEIGHT_KEYS.map((k) => def[k]);
      sum = 100;
    }
    const scaled = vals.map((v) => Math.round((v / sum) * 100));
    const diff = 100 - scaled.reduce((a, b) => a + b, 0);
    scaled[0] += diff;
    const out = {};
    WEIGHT_KEYS.forEach((k, i) => { out[k] = Math.max(0, scaled[i]); });
    return out;
  }

  /** 归一化为 0~1 比例，供 composeFinalScore 加权 */
  function normalizeWeightRatios(weights) {
    const pct = normalizeWeightPercents(weights);
    const sum = WEIGHT_KEYS.reduce((a, k) => a + pct[k], 0) || 100;
    const out = {};
    WEIGHT_KEYS.forEach((k) => { out[k] = pct[k] / sum; });
    return out;
  }

  function penaltyForUnmet(unmet) {
    let total = 0;
    (unmet || []).forEach((r) => {
      total += TIER_PENALTY[normalizeTier(r && r.tier)] || 0;
    });
    return Math.min(MUST_HAVE_PENALTY_CAP, total);
  }

  function countUnmetByTier(unmet, tier) {
    return (unmet || []).filter((r) => normalizeTier(r && r.tier) === tier).length;
  }

  /**
   * 综合等级：允许 1 条「必须」未过且匹配度 ≥50 时为「有条件推荐」
   */
  function levelFromScore(score, matchScore, unmet) {
    const s = Number(score);
    const m = Number(matchScore);
    const mustUnmet = countUnmetByTier(unmet, 'must');
    if (s >= 75) return '强烈推荐';
    if (s >= 50) return '值得推荐';
    if (Number.isFinite(m) && m >= 50 && mustUnmet <= 1 && s >= 45) return '有条件推荐';
    if (s >= 35) return '一般';
    return '不推荐';
  }

  function isRecommendLevel(level) {
    return level === '强烈推荐' || level === '值得推荐' || level === '有条件推荐';
  }

  /**
   * 本地按用户权重把分维度结果合成综合分。
   * 默认 tag 模式：结构化硬筛（学历/年限等）只红标，不额外扣分。
   * 必备扣分按 tier：必须 −5、重要 −3、加分 0。
   */
  function composeFinalScore(raw, weights, waivedMustHaves, structuredMissing, opts) {
    if (isScoreFailure(raw)) {
      return {
        score: 0,
        baseScore: 0,
        matchScore: 0,
        penalty: 0,
        level: '错误',
        suggestions: ['⚠️ ' + (raw && (raw.error || (raw.concerns && raw.concerns[0])) || '评分失败')],
        highlights: [],
        concerns: [raw && (raw.error || (raw.concerns && raw.concerns[0])) || '评分失败'],
        dims: null,
        unmet: [],
        waivedUnmet: [],
        unmetNice: []
      };
    }
    const options = opts || {};
    const structuredMode = options.structuredHardMode || STRUCTURED_HARD_MODE;
    const ratios = normalizeWeightRatios(weights);
    const dims = raw.dimensions;
    let base = 0;
    for (const k of WEIGHT_KEYS) {
      const s = dims[k] && typeof dims[k].score === 'number' ? dims[k].score : 50;
      base += s * (ratios[k] || 0);
    }
    const matchScore = Math.round(Math.max(0, Math.min(100, base)));

    const waivedRaw = waivedMustHaves instanceof Set ? waivedMustHaves : new Set(waivedMustHaves || []);
    const waived = new Set(Array.from(waivedRaw).map(normalizeMustHaveItem).filter(Boolean));
    const unmetAll = (raw.mustHaveResults || [])
      .filter((r) => r && normalizeMustHaveItem(r.item) && !r.met)
      .map((r) => Object.assign({}, r, { tier: normalizeTier(r.tier) }));
    const unmetScored = unmetAll.filter((r) => normalizeTier(r.tier) !== 'nice');
    const unmet = unmetScored.filter((r) => !waived.has(normalizeMustHaveItem(r.item)));
    const waivedUnmet = unmetScored.filter((r) => waived.has(normalizeMustHaveItem(r.item)));
    const unmetNice = unmetAll.filter((r) => normalizeTier(r.tier) === 'nice');

    let penalty = penaltyForUnmet(unmet);
    if (structuredMode === 'gate') {
      const structured = (Array.isArray(structuredMissing) ? structuredMissing : [])
        .map((m) => String(m || '').trim())
        .filter(Boolean);
      penalty = Math.min(MUST_HAVE_PENALTY_CAP, penalty + structured.length * TIER_PENALTY.must);
    }
    const score = Math.max(0, matchScore - penalty);

    const highlights = (raw.highlights || []).map((h) => String(h || '').trim()).filter(Boolean).slice(0, 3);
    const concerns = (raw.concerns || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 3);
    const suggestions = [];
    highlights.slice(0, 2).forEach((h) => suggestions.push('✓ ' + h));
    concerns.slice(0, 2).forEach((c) => suggestions.push('✕ ' + c));

    return {
      score,
      baseScore: matchScore,
      matchScore,
      penalty,
      level: levelFromScore(score, matchScore, unmet),
      suggestions: suggestions.slice(0, 4),
      highlights,
      concerns,
      dims,
      unmet,
      waivedUnmet,
      unmetNice
    };
  }

  const PROMPT_VERSION = 'calibrate-tier-v1';

  function weightsPromptBlock(weights) {
    const pct = normalizeWeightPercents(weights);
    const parts = WEIGHT_KEYS.map((k) => DIM_LABEL[k] + ' ' + pct[k] + '%');
    return '【招聘官权重】' + parts.join('、')
      + '。打四维分时：权重高的维度要更细地区分强弱；权重低的维度达标即可，勿因次要短板拉低整体。';
  }

  function dimensionScoringNotes(jobType) {
    const intern = jobType === 'intern';
    const transfer = '可迁移能力：若候选人产出与岗位核心成果等价（如 AI 视频全链路+投放数据、爆款素材、买量素材），即使未写具体平台名，experience/skill 不得低于 45，不得仅因缺 TikTok/Meta 等字面词打到 35 以下。';
    const educationFloor = 'education：学历达标但专业不完全对口（如数字媒体对投放岗）给 40–65，不得因专业名不对口打到 20 以下。专业高度对口才给 70+。';
    if (intern) {
      return [
        '实习岗的 experience 只看实习/项目与岗位主责是否同方向，不是「职责里沾过边就算有经验」。',
        'experience 分档：无同方向 0–35；仅相邻职能擦边 36–55（不得超过 55）；有对口实习但较浅 56–70；对口且主责重合 71–90。',
        '例：应聘 HR / 人力 / HRBP 实习，简历是行政实习，仅有招聘协助、入职手续、花名册或绩效数据收集 → 视为擦边，不得打到 60 及以上。行政实习里的招聘支持 ≠ 对口 HR 实习。',
        transfer,
        educationFloor
      ].join('\n');
    }
    return [
      '正式岗的 experience 看过往主责是否与本岗位同方向。相邻职能或辅助性接触按擦边 36–55，不要打成对口。',
      '同方向但不完整（年限不够、渠道只覆盖一部分）：experience 45–60，不得低于 45。',
      '对口且年限接近 61–80；对口且充分 81–100。无同方向 0–35。',
      'skill：会一部分核心工具/渠道、缺其余时按覆盖比例给 45–65，不要因为缺个别工具名就把技能打到 20。',
      transfer,
      educationFloor,
      'potential：有学习力、相关项目或可培养苗头给 50–70。年限不够只压 experience，不要把潜力和教育一起打穿。',
      '综合分约 50 表示「业务值得翻一翻简历」：同方向有证据但不完整，应落在这一档。'
    ].join('\n');
  }

  function mustHaveExtractionGuide() {
    return '按 JD 语义分三级（不同岗位比例可不同，不要机械全放进 must）：'
      + 'mustHaves=真正硬门槛（JD 写必须/需/要求）；'
      + 'importantHaves=重要但可培养（熟悉/优先/有相关更好）；'
      + 'niceToHaves=加分项。'
      + '若 JD 已写工作年限区间，mustHaves 不要再写「N年以上」等总年限，只写领域/技能（如「海外素材设计经验」）。'
      + '态度/品格类放 niceToHaves。每级最多 6 条，勿重复学历/院校/性别/年龄/总工作年限。';
  }

  function hardConditionsPromptBlock(hardText) {
    const t = hardText == null ? '' : String(hardText).trim();
    if (!t) return '';
    return '【招聘官设定的硬性条件】\n' + t
      + '\n说明：未过项在界面红标提示（默认不额外扣综合分）；请在各维度分中如实体现差距，不要把四维一律打成 0。';
  }

  function renderRequirementChecklist(spec) {
    const s = spec || {};
    const must = arrOf(s.mustHaves, 8);
    const important = arrOf(s.importantHaves, 8);
    const nice = arrOf(s.niceToHaves, 10);
    const lines = [];
    if (must.length) lines.push('【必须，未满足每条 −5】\n- ' + must.join('\n- '));
    if (important.length) lines.push('【重要，未满足每条 −3】\n- ' + important.join('\n- '));
    if (nice.length) lines.push('【加分，未满足不扣分】\n- ' + nice.join('\n- '));
    return lines.join('\n\n');
  }

  function arrOf(x, max) {
    if (typeof x === 'string') x = [x];
    if (!Array.isArray(x)) return [];
    return x.map((s) => String(s || '').trim()).filter(Boolean).slice(0, max || 6);
  }

  /** 侧栏展示：匹配度 + 按 tier 拆开的扣分说明 */
  function formatPenaltyHint(scoreObj) {
    const s = scoreObj || {};
    const matchScore = s.matchScore != null ? s.matchScore : s.baseScore;
    if (matchScore == null) return '';
    let mustPen = 0;
    let impPen = 0;
    (s.unmet || []).forEach((r) => {
      const t = normalizeTier(r && r.tier);
      if (t === 'must') mustPen += TIER_PENALTY.must;
      else if (t === 'important') impPen += TIER_PENALTY.important;
    });
    if (!mustPen && !impPen) return '（匹配度 ' + matchScore + '）';
    const cuts = [];
    if (mustPen) cuts.push('必须 ' + mustPen);
    if (impPen) cuts.push('重要 ' + impPen);
    return '（匹配度 ' + matchScore + ' − ' + cuts.join(' · ') + '）';
  }

  const api = {
    WEIGHT_KEYS,
    DIM_LABEL,
    MUST_HAVE_TIERS,
    TIER_PENALTY,
    MUST_HAVE_PENALTY,
    MUST_HAVE_PENALTY_CAP,
    STRUCTURED_HARD_MODE,
    scoreErrorResult,
    isScoreFailure,
    isRetryableScoreFailure,
    isRecommendLevel,
    SCORE_AUTO_RETRY_MAX,
    normalizeTier,
    normalizeWeightPercents,
    normalizeWeightRatios,
    levelFromScore,
    composeFinalScore,
    weightsPromptBlock,
    hardConditionsPromptBlock,
    dimensionScoringNotes,
    mustHaveExtractionGuide,
    renderRequirementChecklist,
    formatPenaltyHint,
    PROMPT_VERSION
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
