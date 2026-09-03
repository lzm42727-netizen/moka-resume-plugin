/**
 * 评分合成与错误结果（content / background / Node 测试共用）
 */
(function (root) {
  const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
  const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
  const BONUS_POINTS_PER_ITEM = 3;
  const BONUS_POINTS_CAP = 15;
  const BONUS_MAX_ITEMS = 5;
  const STRUCTURED_HARD_MODE = 'tag';
  const SCORE_MIN = 0;
  const SCORE_MAX = 100;
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

  function hasFiniteScore(value) {
    return value !== null && value !== '' && Number.isFinite(Number(value));
  }

  /**
   * 区分模型 JSON 失败原因，便于卡片展示与重试，而不是一律「解析失败」。
   * 返回 null 表示 payload 已可进入 normalize；否则 truncated / missing-field / non-json。
   */
  function classifyLlmJsonFailure(text, parsed) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (hasFiniteScore(parsed.matchScore) || parsed.dimensions) return null;
      return 'missing-field';
    }
    const raw = String(text || '');
    const opens = (raw.match(/\{/g) || []).length;
    const closes = (raw.match(/\}/g) || []).length;
    if (opens > closes) return 'truncated';
    return 'non-json';
  }

  function scoreParseFailureMessage(kind) {
    if (kind === 'truncated') return '模型返回被截断，请重评或换指令跟随更稳的模型';
    if (kind === 'missing-field') return '模型返回缺少 matchScore';
    return '模型返回不是可解析的 JSON';
  }

  function jdParseFailureMessage(kind) {
    if (kind === 'truncated') return '模型返回被截断（JD 太长或输出上限太小），请重试或换个模型';
    if (kind === 'missing-field') return '模型返回里没有岗位信息字段，请重试或换个模型';
    return '模型没有按 JSON 返回岗位信息，请重试或换个指令跟随更稳的模型';
  }

  // buildJobJD 拼出来的抬头行本身不算 JD 内容
  const JD_HEADING_LINE = /^(职位|部门|岗位描述与要求|硬性\/加分要求)[:：]?.*$/gm;

  /**
   * JD 是否只剩抬头、没有可解读的内容。
   * Moka 上有些职位只挂了职位名，这种 JD 送给模型只会换回一个空壳，
   * 与其显示「模型没解读出岗位信息」，不如直说 JD 本身是空的。
   */
  function jobJdLooksEmpty(jobJD) {
    const body = String(jobJD || '').replace(JD_HEADING_LINE, '');
    return body.replace(/\s+/g, '').length < 12;
  }

  function isScoreFailure(raw) {
    return !raw || raw.parseError === true
      || (!raw.dimensions && !hasFiniteScore(raw.matchScore));
  }

  /** 评分失败是否值得自动重试（配置类错误不重试） */
  function isRetryableScoreFailure(raw) {
    if (!isScoreFailure(raw)) return false;
    const msg = String((raw && (raw.error || (raw.concerns && raw.concerns[0]))) || '');
    if (/未配置\s*API\s*Key/i.test(msg)) return false;
    return true;
  }

  const SCORE_AUTO_RETRY_MAX = 2;

  function normalizeMustHaveItem(item) {
    return String(item || '').trim();
  }

  function clampScore(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return SCORE_MIN;
    return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(x)));
  }

  /** 综合档位只由最终综合分决定。 */
  function levelFromScore(score) {
    const s = Number(score);
    if (s >= 80) return '优先推进';
    if (s >= 50) return '可推进';
    return '不建议推进';
  }

  function isRecommendLevel(level) {
    return level === '可推进' || level === '优先推进';
  }

  /**
   * 硬性门槛只封顶，不托底：有未过门槛按条数降至 49 以下，
   * 全部通过（或未配置）时综合分等于模型匹配分。
   */
  function composeFinalScore(raw, waivedMustHaves, structuredMissing) {
    if (isScoreFailure(raw)) {
      const failMsg = (raw && (raw.error || (raw.concerns && raw.concerns[0]))) || '评分失败';
      return {
        error: failMsg,
        score: 0,
        baseScore: 0,
        matchScore: 0,
        penalty: 0,
        mustPenalty: 0,
        importantPenalty: 0,
        bonus: 0,
        level: '错误',
        suggestions: ['⚠️ ' + failMsg],
        highlights: [],
        concerns: [failMsg],
        dims: null,
        unmet: [],
        waivedUnmet: [],
        unmetNice: [],
        metNice: [],
        experienceEvidence: [],
        bonusKeywordResults: [],
        bonusPoints: 0,
        bonusApplied: 0,
        bonusMetCount: 0,
        bonusTotalCount: 0,
        bonusPromoted: false
      };
    }
    const dims = raw.dimensions;
    let fallbackMatch = 0;
    if (dims) {
      let sum = 0;
      let n = 0;
      WEIGHT_KEYS.forEach((k) => {
        const s = dims[k] && typeof dims[k].score === 'number' ? dims[k].score : null;
        if (s == null) return;
        sum += s;
        n += 1;
      });
      fallbackMatch = n ? sum / n : 0;
    }
    const matchScore = clampScore(hasFiniteScore(raw.matchScore) ? raw.matchScore : fallbackMatch);
    const structured = (Array.isArray(structuredMissing) ? structuredMissing : [])
      .map((m) => String(m || '').trim())
      .filter(Boolean);
    const handwrittenResults = (raw.handwrittenGateResults || [])
      .filter((r) => r && normalizeMustHaveItem(r.item))
      .map((r) => ({
        item: normalizeMustHaveItem(r.item),
        met: r.met === true,
        reason: String(r.reason || '').trim(),
        source: 'handwritten'
      }));
    const handwrittenUnmet = handwrittenResults.filter((r) => !r.met);
    const structuredUnmet = structured.map((item) => ({
      item,
      met: false,
      reason: item,
      source: 'structured'
    }));
    const unmet = structuredUnmet.concat(handwrittenUnmet);
    const unmetCount = unmet.length;
    const bonusKeywordResults = (raw.bonusKeywordResults || [])
      .filter((r) => r && normalizeMustHaveItem(r.item))
      .slice(0, BONUS_MAX_ITEMS)
      .map((r) => ({
        item: normalizeMustHaveItem(r.item),
        met: r.met === true,
        reason: String(r.reason || '').trim()
      }));
    const bonusMetCount = bonusKeywordResults.filter((r) => r.met).length;
    const bonusTotalCount = bonusKeywordResults.length;
    const bonusPoints = Math.min(BONUS_POINTS_CAP, bonusMetCount * BONUS_POINTS_PER_ITEM);
    const bonusApplied = !unmetCount && matchScore >= 50 ? bonusPoints : 0;
    const score = unmetCount
      ? Math.max(0, 49 - 7 * unmetCount)
      : clampScore(matchScore + bonusApplied);
    const bonusPromoted = bonusApplied > 0 && matchScore < 80 && score >= 80;
    const advanceReason = unmetCount
      ? 'gate'
      : (score < 50 ? 'match' : (bonusPromoted ? 'bonus' : 'ok'));

    const highlights = (raw.highlights || []).map((h) => String(h || '').trim()).filter(Boolean).slice(0, 3);
    const concerns = (raw.concerns || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 3);
    const experienceEvidence = (raw.experienceEvidence || []).map((e) => String(e || '').trim()).filter(Boolean).slice(0, 6);
    const suggestions = [];
    highlights.slice(0, 2).forEach((h) => suggestions.push('✓ ' + h));
    concerns.slice(0, 2).forEach((c) => suggestions.push('✕ ' + c));

    return {
      score,
      baseScore: matchScore,
      matchScore,
      penalty: 0,
      mustPenalty: 0,
      importantPenalty: 0,
      bonus: 0,
      level: levelFromScore(score),
      advanceReason,
      suggestions: suggestions.slice(0, 4),
      highlights,
      concerns,
      experienceEvidence,
      bonusKeywordResults,
      bonusPoints,
      bonusApplied,
      bonusMetCount,
      bonusTotalCount,
      bonusPromoted,
      dims,
      unmet,
      structuredMissing: structured,
      handwrittenGateResults: handwrittenResults,
      waivedUnmet: [],
      unmetNice: [],
      metNice: []
    };
  }

  const PROMPT_VERSION = 'evidence-first-bonus-cal-v4';

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

  function matchScoringPromptBlock(jobType, handwrittenGates, focusKeywords, bonusKeywords) {
    const gates = arrOf(handwrittenGates, 12);
    const focus = arrOf(focusKeywords, 6);
    const bonus = arrOf(bonusKeywords, BONUS_MAX_ITEMS);
    return [
      '禁止跳步：先根据简历写出 experienceEvidence（每段有实质描述的实习/项目一句证据），再对照岗位与重点看写亮点/差距，再核对手写门槛，最后才给 matchScore。',
      '【手写硬性门槛】' + (gates.length ? '\n- ' + gates.join('\n- ') : '无'),
      '逐条输出 handwrittenGateResults：按招聘官填写的完整条件核对，简历无证据就判不过；接受同义表达，例如 PS 等同 Photoshop。',
      '【重点看】' + (focus.length ? focus.join('、') : '无'),
      '【加分看】' + (bonus.length ? bonus.join('、') : '无'),
      '逐条核对加分看并输出 bonusKeywordResults：每条包含 item、met、reason；只有简历提供可核对证据才判 met=true，无证据判 false。',
      '给出 0–100 整数 matchScore，只评价候选人的经历/技能与 JD、重点看的对口程度。',
      '重点看用于对照和写理由；字面缺失可以拉低，但简历有相邻经历时匹配分不得低于 50。',
      '相邻指同一职能大方向、职责有重叠，例如增长实习里的内容优化/用户访谈相对于内容与创作者运营。',
      '只有经历与 JD 主责完全无关才可低于 50。加分看不得计入或影响 matchScore；系统会在门槛通过且 matchScore 不低于 50 时另行加分。',
      '学历、院校、年龄、性别、年限等由系统本地判定，不要因这些项目通过而加分，也不要在 matchScore 中重复扣分。',
      '对口一般为 50–79，明显强为 80 以上。'
    ].join('\n');
  }

  function normalizeModelScoreResponse(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const gates = Array.isArray(src.handwrittenGateResults)
      ? src.handwrittenGateResults
          .map((r) => ({
            item: String((r && r.item) || '').trim(),
            met: !!(r && r.met),
            reason: String((r && (r.reason || r.note)) || '').trim()
          }))
          .filter((r) => r.item)
          .slice(0, 12)
      : [];
    const bonusResults = Array.isArray(src.bonusKeywordResults)
      ? src.bonusKeywordResults
          .map((r) => ({
            item: String((r && r.item) || '').trim(),
            met: !!(r && r.met),
            reason: String((r && (r.reason || r.note)) || '').trim()
          }))
          .filter((r) => r.item)
          .slice(0, BONUS_MAX_ITEMS)
      : [];
    if (!src.dimensions && !hasFiniteScore(src.matchScore)) {
      const fail = scoreErrorResult(scoreParseFailureMessage('missing-field'));
      fail.parseFailureKind = 'missing-field';
      return fail;
    }
    return {
      dimensions: src.dimensions || null,
      matchScore: hasFiniteScore(src.matchScore) ? clampScore(src.matchScore) : undefined,
      handwrittenGateResults: gates,
      bonusKeywordResults: bonusResults,
      experienceEvidence: arrOf(src.experienceEvidence, 6),
      highlights: arrOf(src.highlights, 6),
      concerns: arrOf(src.concerns, 6)
    };
  }

  function ensureHandwrittenGateResults(raw, expectedGates) {
    const out = Object.assign({}, raw || {});
    const returned = Array.isArray(out.handwrittenGateResults) ? out.handwrittenGateResults : [];
    const byItem = new Map();
    returned.forEach((result) => {
      const key = String((result && result.item) || '').replace(/\s+/g, '').toLowerCase();
      if (key && !byItem.has(key)) byItem.set(key, result);
    });
    out.handwrittenGateResults = arrOf(expectedGates, 12).map((item) => {
      const found = byItem.get(item.replace(/\s+/g, '').toLowerCase());
      return found
        ? {
            item,
            met: found.met === true,
            reason: String(found.reason || found.note || '').trim()
          }
        : {
            item,
            met: false,
            reason: '简历未提供可核对证据'
          };
    });
    return out;
  }

  function ensureBonusKeywordResults(raw, expectedKeywords) {
    const out = Object.assign({}, raw || {});
    const returned = Array.isArray(out.bonusKeywordResults) ? out.bonusKeywordResults : [];
    const byItem = new Map();
    returned.forEach((result) => {
      const key = String((result && result.item) || '').replace(/\s+/g, '').toLowerCase();
      if (key && !byItem.has(key)) byItem.set(key, result);
    });
    out.bonusKeywordResults = arrOf(expectedKeywords, BONUS_MAX_ITEMS).map((item) => {
      const found = byItem.get(item.replace(/\s+/g, '').toLowerCase());
      return found
        ? {
            item,
            met: found.met === true,
            reason: String(found.reason || found.note || '').trim()
          }
        : {
            item,
            met: false,
            reason: '简历未提供可核对证据'
          };
    });
    return out;
  }

  function mustHaveExtractionGuide() {
    return '按 JD 语义分三级（不同岗位比例可不同，不要机械全放进 must）：'
      + 'mustHaves=真正硬门槛（JD 写必须/需/要求），最多 6 条；'
      + 'importantHaves=重要但可培养（熟悉/优先/有相关更好），最多 6 条；'
      + 'niceToHaves=加分项（具备可加分），最多 5 条。'
      + '若 JD 已写工作年限区间，mustHaves 不要再写「N年以上」等总年限，只写领域/技能（如「海外素材设计经验」）。'
      + '态度/品格类放 niceToHaves。勿重复学历/院校/性别/年龄/总工作年限。';
  }

  function hardConditionsPromptBlock(hardText) {
    const t = hardText == null ? '' : String(hardText).trim();
    if (!t) return '';
    return '【招聘官设定的硬性条件】\n' + t
      + '\n说明：未过项在界面红标提示（默认不额外扣综合分）；请在各维度分中如实体现差距，不要把四维一律打成 0。';
  }

  function arrOf(x, max) {
    if (typeof x === 'string') x = [x];
    if (!Array.isArray(x)) return [];
    return x.map((s) => String(s || '').trim()).filter(Boolean).slice(0, max || 6);
  }

  /** 评分失败的原因文案；正常评分返回空串。 */
  function scoreFailureMessage(scoreObj) {
    const s = scoreObj || {};
    if (s.level !== '错误') return '';
    const raw = s.error || (Array.isArray(s.concerns) && s.concerns[0]) || '';
    const text = String(raw).replace(/^[⚠✕✓]\s*/, '').trim();
    return text || '评分失败';
  }

  /** 仅在硬性门槛压低决策分时，补充展示经历匹配分。 */
  function matchScoreDisplayText(scoreObj) {
    const s = scoreObj || {};
    if (s.level === '错误' || s.advanceReason !== 'gate') return '';
    if (!hasFiniteScore(s.matchScore) || Number(s.matchScore) === Number(s.score)) return '';
    return '经历匹配 ' + clampScore(s.matchScore);
  }

  const api = {
    WEIGHT_KEYS,
    DIM_LABEL,
    BONUS_POINTS_PER_ITEM,
    BONUS_POINTS_CAP,
    BONUS_MAX_ITEMS,
    STRUCTURED_HARD_MODE,
    scoreErrorResult,
    isScoreFailure,
    isRetryableScoreFailure,
    isRecommendLevel,
    SCORE_AUTO_RETRY_MAX,
    clampScore,
    levelFromScore,
    composeFinalScore,
    hardConditionsPromptBlock,
    dimensionScoringNotes,
    matchScoringPromptBlock,
    normalizeModelScoreResponse,
    ensureHandwrittenGateResults,
    ensureBonusKeywordResults,
    classifyLlmJsonFailure,
    scoreParseFailureMessage,
    jdParseFailureMessage,
    jobJdLooksEmpty,
    mustHaveExtractionGuide,
    matchScoreDisplayText,
    scoreFailureMessage,
    PROMPT_VERSION
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
