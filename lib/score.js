/**
 * 评分合成与错误结果（content / background / Node 测试共用）
 */
(function (root) {
  const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
  const MUST_HAVE_PENALTY = 5;
  const MUST_HAVE_PENALTY_CAP = 20;

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

  function levelFromScore(score) {
    if (score >= 75) return '强烈推荐';
    if (score >= 50) return '值得推荐';
    if (score >= 35) return '一般';
    return '不推荐';
  }

  function hardPenalty(count) {
    const n = Number(count) || 0;
    if (n <= 0) return 0;
    return Math.min(MUST_HAVE_PENALTY_CAP, n * MUST_HAVE_PENALTY);
  }

  /**
   * 本地按用户权重把分维度结果合成综合分。
   * 结构化硬性未过 + 未忽略的自增硬性：每条 −5，最多 −20。
   * 忽略只加回自增项的扣分，学历/院校等 structuredMissing 不能忽略。
   * parseError / 缺 dimensions 一律视为错误，不当成 50 分「值得推荐」。
   */
  function composeFinalScore(raw, weights, waivedMustHaves, structuredMissing) {
    if (isScoreFailure(raw)) {
      return {
        score: 0,
        baseScore: 0,
        penalty: 0,
        level: '错误',
        suggestions: ['⚠️ ' + (raw && (raw.error || (raw.concerns && raw.concerns[0])) || '评分失败')],
        highlights: [],
        concerns: [raw && (raw.error || (raw.concerns && raw.concerns[0])) || '评分失败'],
        dims: null,
        unmet: [],
        waivedUnmet: []
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
    const structured = (Array.isArray(structuredMissing) ? structuredMissing : [])
      .map((m) => String(m || '').trim())
      .filter(Boolean);
    const penalty = hardPenalty(structured.length + unmet.length);
    const score = Math.max(0, baseScore - penalty);

    const highlights = (raw.highlights || []).map((h) => String(h || '').trim()).filter(Boolean).slice(0, 3);
    const concerns = (raw.concerns || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 3);
    const suggestions = [];
    highlights.slice(0, 2).forEach((h) => suggestions.push('✓ ' + h));
    concerns.slice(0, 2).forEach((c) => suggestions.push('✕ ' + c));

    return {
      score,
      baseScore,
      penalty,
      level: levelFromScore(score),
      suggestions: suggestions.slice(0, 4),
      highlights,
      concerns,
      dims,
      unmet,
      waivedUnmet
    };
  }

  const PROMPT_VERSION = 'calibrate-feedback-v1';

  function dimensionScoringNotes(jobType) {
    const intern = jobType === 'intern';
    const educationFloor = 'education：学历达标但专业不完全对口（如意大利语对投放岗）给 40–65，不得因专业名不对口打到 20 以下。专业高度对口才给 70+。';
    if (intern) {
      return [
        '实习岗的 experience 只看实习/项目与岗位主责是否同方向，不是「职责里沾过边就算有经验」。',
        'experience 分档：无同方向 0–35；仅相邻职能擦边 36–55（不得超过 55）；有对口实习但较浅 56–70；对口且主责重合 71–90。',
        '例：应聘 HR / 人力 / HRBP 实习，简历是行政实习，仅有招聘协助、入职手续、花名册或绩效数据收集 → 视为擦边，不得打到 60 及以上。行政实习里的招聘支持 ≠ 对口 HR 实习。',
        educationFloor
      ].join('\n');
    }
    return [
      '正式岗的 experience 看过往主责是否与本岗位同方向。相邻职能或辅助性接触（兼岗、行政里顺带做招聘）按擦边 36–55，不要打成对口。',
      '同方向但不完整（年限不够、渠道只覆盖一部分）：experience 45–60，不得低于 45。例：投放岗有 1 年 Meta Ads / Campaign，缺 Google UAC、Apple Search Ads，且年限少于 JD 的 3–5 年 → 仍是同方向，不要打到 25。',
      '对口且年限接近 61–80；对口且充分 81–100。无同方向 0–35。',
      'skill：会一部分核心渠道/工具、缺其余时按覆盖比例给 45–65，已有可验证投放经验（如 Meta Ads）不得低于 40；不要因为缺 Google UAC / Apple Search Ads 就把技能打到 20。',
      educationFloor,
      'potential：有学习力、相关项目或可培养苗头给 50–70。年限不够只压 experience，不要把潜力和教育一起打穿。',
      '综合分约 50 表示「业务值得翻一翻简历」：同方向有证据但不完整，应落在这一档，而不是 20 分档。'
    ].join('\n');
  }

  function mustHaveExtractionGuide() {
    return 'mustHaves 只放简历可验证的硬门槛（对口技能/工具、对口实习或工作、证书、JD 写明的出勤天数或实习时长），按重要性最多 6 条。'
      + '真诚、好奇心、学习态度、快速上手等态度/品格不要放进 mustHaves，放到 niceToHaves。';
  }

  function hardConditionsPromptBlock(hardText) {
    const t = hardText == null ? '' : String(hardText).trim();
    if (!t) return '';
    return '【招聘官设定的硬性条件】\n' + t
      + '\n说明：硬性未过由系统按条扣综合分；此处请据实评价匹配度，不要把所有维度一律打成 0。';
  }

  const api = {
    WEIGHT_KEYS,
    MUST_HAVE_PENALTY,
    MUST_HAVE_PENALTY_CAP,
    scoreErrorResult,
    isScoreFailure,
    levelFromScore,
    composeFinalScore,
    hardConditionsPromptBlock,
    dimensionScoringNotes,
    mustHaveExtractionGuide,
    PROMPT_VERSION
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
