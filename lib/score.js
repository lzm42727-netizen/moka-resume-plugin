/**
 * 评分合成与错误结果（content / background / Node 测试共用）
 */
(function (root) {
  const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
  const FIT_WEIGHT_KEYS = ['coreDuty', 'business', 'skill', 'scope'];
  const FIT_WEIGHTS = { coreDuty: 40, business: 25, skill: 20, scope: 15 };
  const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
  const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
  const BONUS_POINTS_PER_ITEM = 3;
  const BONUS_POINTS_CAP = 15;
  const BONUS_MAX_ITEMS = 5;
  const STRUCTURED_HARD_MODE = 'tag';
  const SCORE_MIN = 0;
  const SCORE_MAX = 100;
  function scoreErrorResult(message, failureKind) {
    const msg = message || '评分失败';
    const out = {
      dimensions: null,
      mustHaveResults: [],
      highlights: [],
      concerns: [msg],
      parseError: true,
      error: msg
    };
    // failureKind：timeout / overload / network / config / other —— 供内容侧决定要不要在卡内重试
    if (failureKind) out.failureKind = String(failureKind);
    return out;
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
      if (hasFiniteScore(parsed.matchScore) || parsed.dimensions || parsed.scoreBreakdown) return null;
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

  /**
   * 四项结构化评分是否完整可用。
   * 残缺（只返回一两项）不能当作有效结果——否则会静默合成 0 分，
   * 卡片显示 0 分而不是「评分失败」，用户会误以为是真实评价。
   */
  function hasCompleteBreakdown(raw) {
    return !!normalizeFitBreakdown(raw);
  }

  function isScoreFailure(raw) {
    return !raw || raw.parseError === true
      || (!raw.dimensions && !hasFiniteScore(raw.matchScore) && !hasCompleteBreakdown(raw));
  }

  /** 不值得在单卡内连打的重试类型：网关过载/超时/网络/配置，交给筛选末尾统一补评 */
  const NON_RETRYABLE_FAILURE_KINDS = ['timeout', 'overload', 'network', 'config'];

  /** 评分失败是否值得自动重试（配置类错误与网关过载类不重试） */
  function isRetryableScoreFailure(raw) {
    if (!isScoreFailure(raw)) return false;
    const kind = String((raw && raw.failureKind) || '');
    if (NON_RETRYABLE_FAILURE_KINDS.indexOf(kind) !== -1) return false;
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
  function normalizeFitBreakdown(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const b = src.scoreBreakdown && typeof src.scoreBreakdown === 'object'
      ? src.scoreBreakdown
      : null;
    if (!b) return null;
    const out = {};
    let valid = true;
    FIT_WEIGHT_KEYS.forEach((k) => {
      const n = Number(b[k] && typeof b[k] === 'object' ? b[k].score : b[k]);
      if (!Number.isFinite(n)) valid = false;
      out[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
    });
    return valid ? out : null;
  }

  function calculateFitScore(raw) {
    const breakdown = normalizeFitBreakdown(raw);
    if (!breakdown) {
      // 兼容旧缓存：已有 matchScore 时优先使用它；只有历史结果没有总分时才回退四维平均。
      if (hasFiniteScore(raw && raw.matchScore)) {
        return { score: clampScore(raw.matchScore), breakdown: null, source: 'model' };
      }
      const dims = raw && raw.dimensions;
      if (dims) {
        let sum = 0;
        let n = 0;
        WEIGHT_KEYS.forEach((k) => {
          const s = dims[k] && typeof dims[k].score === 'number' ? dims[k].score : null;
          if (s == null) return;
          sum += s;
          n += 1;
        });
        if (n) return { score: clampScore(sum / n), breakdown: null, source: 'legacy' };
      }
      return null;
    }
    const weighted = FIT_WEIGHT_KEYS.reduce((sum, k) => sum + breakdown[k] * FIT_WEIGHTS[k], 0) / 100;
    return { score: clampScore(weighted), breakdown, source: 'structured' };
  }

  function gateStatus(result) {
    if (!result || typeof result !== 'object') return 'unknown';
    if (result.status === 'pass' || result.status === 'fail' || result.status === 'unknown') return result.status;
    // Legacy payload compatibility: explicit met=false used to mean failure.
    if (result.met === true) return 'pass';
    if (result.met === false) return 'fail';
    return 'unknown';
  }

  /**
   * 综合分：匹配度与硬门槛分离。
   * - 明确失败的硬门槛才影响最终决策分；信息不足（unknown）不扣分。
   * - 有结构化四项评分时，本地按固定权重合成，避免模型直接拍一个总分。
   * - 加分项不改变匹配度，仅在匹配度 >= 50 且没有明确 gate fail 时作为次级加分。
   */
  function composeFinalScore(raw, waivedMustHaves, structuredMissing) {
    if (isScoreFailure(raw)) {
      const failMsg = (raw && (raw.error || (raw.concerns && raw.concerns[0]))) || '评分失败';
      return {
        error: failMsg, score: 0, baseScore: 0, matchScore: 0, penalty: 0,
        mustPenalty: 0, importantPenalty: 0, bonus: 0, level: '错误',
        suggestions: ['⚠️ ' + failMsg], highlights: [], concerns: [failMsg], dims: null,
        unmet: [], waivedUnmet: [], unmetNice: [], metNice: [], experienceEvidence: [],
        bonusKeywordResults: [], bonusPoints: 0, bonusApplied: 0, bonusMetCount: 0,
        bonusTotalCount: 0, bonusPromoted: false, scoreBreakdown: null,
        evidenceCoverage: 0, confidence: 'low'
      };
    }

    const fit = calculateFitScore(raw);
    const matchScore = fit ? fit.score : 0;
    let protectedMatchScore = matchScore;
    if (fit && fit.breakdown) {
      const core = fit.breakdown.coreDuty;
      if (core < 40) protectedMatchScore = Math.min(matchScore, 49);
      else if (core < 60) protectedMatchScore = Math.min(matchScore, 69);
      else if (core < 80) protectedMatchScore = Math.min(matchScore, 84);
    }
    const structured = (Array.isArray(structuredMissing) ? structuredMissing : [])
      .map((m) => typeof m === 'string' ? { item: m, status: 'fail', reason: m } : m)
      .map((m) => ({
        item: String((m && m.item) || '').trim(),
        status: (m && (m.status === 'fail' || m.status === 'pass' || m.status === 'unknown')) ? m.status : 'fail',
        reason: String((m && m.reason) || (m && m.item) || '').trim(),
        source: 'structured'
      }))
      .filter((m) => m.item);

    const handwrittenResults = (raw.handwrittenGateResults || [])
      .filter((r) => r && normalizeMustHaveItem(r.item))
      .map((r) => ({
        item: normalizeMustHaveItem(r.item),
        status: gateStatus(r),
        met: gateStatus(r) === 'pass',
        reason: String(r.reason || r.note || '').trim(),
        source: 'handwritten'
      }));
    const handwrittenUnmet = handwrittenResults.filter((r) => r.status === 'fail');
    const structuredUnmet = structured.filter((r) => r.status === 'fail');
    const unmet = structuredUnmet.concat(handwrittenUnmet);
    const unknown = structured.filter((r) => r.status === 'unknown')
      .concat(handwrittenResults.filter((r) => r.status === 'unknown'));
    const unmetCount = unmet.length;

    const bonusKeywordResults = (raw.bonusKeywordResults || [])
      .filter((r) => r && normalizeMustHaveItem(r.item))
      .slice(0, BONUS_MAX_ITEMS)
      .map((r) => ({
        item: normalizeMustHaveItem(r.item), met: r.met === true,
        reason: String(r.reason || '').trim()
      }));
    const bonusMetCount = bonusKeywordResults.filter((r) => r.met).length;
    const bonusTotalCount = bonusKeywordResults.length;
    const bonusPoints = Math.min(BONUS_POINTS_CAP, bonusMetCount * BONUS_POINTS_PER_ITEM);
    const bonusApplied = !unmetCount && protectedMatchScore >= 50 ? bonusPoints : 0;
    const score = unmetCount
      ? Math.max(0, 49 - 7 * unmetCount)
      : clampScore(protectedMatchScore + bonusApplied);
    const bonusPromoted = bonusApplied > 0 && protectedMatchScore < 80 && score >= 80;
    const advanceReason = unmetCount ? 'gate' : (score < 50 ? 'match' : (bonusPromoted ? 'bonus' : 'ok'));

    const highlights = (raw.highlights || []).map((h) => String(h || '').trim()).filter(Boolean).slice(0, 3);
    const concerns = (raw.concerns || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 3);
    const experienceEvidence = (raw.experienceEvidence || []).map((e) => String(e || '').trim()).filter(Boolean).slice(0, 6);
    const suggestions = [];
    highlights.slice(0, 2).forEach((h) => suggestions.push('✓ ' + h));
    concerns.slice(0, 2).forEach((c) => suggestions.push('✕ ' + c));

    const coverage = Number(raw.evidenceCoverage);
    const evidenceCoverage = Number.isFinite(coverage) ? Math.max(0, Math.min(100, Math.round(coverage))) : null;
    const confidence = CONFIDENCE_LEVELS.has(raw.confidence) ? raw.confidence : 'medium';
    // 展示形状统一为 { score, reason }：计算用的 fit.breakdown 是扁平数字，
    // 直接透出会让卡片渲染 d.score 取到 undefined，理由也一起丢
    const scoreBreakdown = fit && fit.breakdown
      ? FIT_WEIGHT_KEYS.reduce((acc, k) => {
          const src = raw.scoreBreakdown && raw.scoreBreakdown[k];
          acc[k] = {
            score: fit.breakdown[k],
            reason: String((src && typeof src === 'object' && src.reason) || '').trim()
          };
          return acc;
        }, {})
      : null;

    return {
      score, baseScore: matchScore, matchScore, penalty: 0, mustPenalty: 0, importantPenalty: 0,
      bonus: 0, level: levelFromScore(score), advanceReason, suggestions: suggestions.slice(0, 4),
      highlights, concerns, experienceEvidence, bonusKeywordResults, bonusPoints, bonusApplied,
      bonusMetCount, bonusTotalCount, bonusPromoted, dims: raw.dimensions || null,
      scoreBreakdown, evidenceCoverage, confidence, unmet, unknown,
      structuredMissing: structured.map((m) => m.item), handwrittenGateResults: handwrittenResults,
      waivedUnmet: [], unmetNice: [], metNice: []
    };
  }

  const PROMPT_VERSION = 'evidence-first-balanced-v3';

  function dimensionScoringNotes(jobType) {
    const intern = jobType === 'intern';
    return [
      '当前评分采用四项基础匹配：coreDuty 40%、business 25%、skill 20%、scope 15%。',
      '核心职责是最高权重：判断过去实际承担的工作与 JD 主责的重合程度；职位名称、公司名称、学历、年限和关键词都不能替代职责证据。',
      '业务/场景匹配看用户、行业、业务模式、产品类型和工作场景是否相同或高度可迁移；仅同属产品/运营不能视为强匹配。',
      'skill 只依据实际使用证据评分；只写“熟悉/掌握”属于弱证据，具体产出或职责属于强证据。',
      'scope 看参与、协助、负责、独立负责及结果证据。量化结果可以增强可信度，但没有量化结果不等于没有能力。',
      '简历没有提及某项时标记 unknown：不脑补，也不因信息缺失直接判定为不具备；只有明确反向证据才判 fail。',
      intern
        ? '实习岗尤其不要用正式岗年限标准惩罚：相关实习、项目、课程实践中的真实职责可以形成有效证据；经历短、描述简略、没有结果数据只能降低证据覆盖度/置信度，不应自动归零。'
        : '正式岗也不要把“简历没写”当成“明确不会”；年限不足是经验层面的缺口，但不能把技能、场景等其他已证实能力一起打穿；没有证据不得自动归零。',
      '基础匹配分保护：coreDuty < 40 时最高 49；40–59 最高 69；60–79 最高 84；coreDuty ≥ 80 才允许 85+。这只是防止核心职责不足被其他优势抵消，不是相邻经历保底。',
      '不要因为实习生/优秀候选人的简历写得不完整而机械降分；用 evidenceCoverage 和 confidence 表示“信息完整程度”和“判断把握”，不要把二者直接乘到 matchScore 上。'
    ].join('\n');
  }

  function matchScoringPromptBlock(jobType, handwrittenGates, focusKeywords, bonusKeywords) {
    const gates = arrOf(handwrittenGates, 12);
    const focus = arrOf(focusKeywords, 6);
    const bonus = arrOf(bonusKeywords, BONUS_MAX_ITEMS);
    return [
      '【评分核心原则】评价的是候选人与本岗位实际工作的匹配度，不是综合人才质量。过去实际承担的职责优先于职位名称、公司名、学历和关键词。',
      '先阅读每段工作/实习/项目经历，再找证据，再逐项判断。关键词只能用于定位证据；关键词出现本身不能证明能力。参与/协助不能等同于负责/独立负责。',
      '【信息缺失原则】简历没有写某项时，不得脑补，也不得直接认定候选人不会；将该项标记为 unknown。只有简历中有明确反向证据时才判 fail。',
      '【岗位相似原则】优先判断实际职责和业务场景，而不是职位名称。相邻产品/运营职能只能获得部分匹配，不能因为同属产品或运营自动给高分。',
      '【实习生/简历不完整】没有量化结果、没有完整描述或经历较短，不等于能力不存在；已有相关职责证据即可获得相应匹配分，结果数据只用于增强证据强度，不作为能力成立的必要条件。',
      '【手写硬性门槛】' + (gates.length ? '\n- ' + gates.join('\n- ') : '无'),
      '逐条输出 handwrittenGateResults。status 只能为 pass / fail / unknown：明确满足=pass；明确不满足=fail；简历没有足够信息=unknown。不要把 unknown 当 fail。接受同义表达，例如 PS 等同 Photoshop。',
      '语言类门槛优先看实际使用证据；英文翻译、英文文档/邮件产出、英语环境实习/沟通等可以支持 pass。仅未写证书编号不应自动 fail。',
      '语言类硬性门槛要单独核对；加分看里的语言类条件也同样优先接受可核对的实际使用证据。',
      '【重点看】' + (focus.length ? focus.join('、') : '无'),
      '【加分看】' + (bonus.length ? bonus.join('、') : '无'),
      '逐条核对加分看并输出 bonusKeywordResults；只有简历存在可核对证据才 met=true。加分看不得计入基础 matchScore。',
      '学历、院校、年龄、性别、年限等不是 matchScore 的加分项；它们由硬性门槛独立核对，不因这些项目通过而额外提高匹配度。',
      '【四项基础评分】请分别给 0–100 整数，并给出简短理由：coreDuty（核心职责匹配）40%，business（业务/场景匹配）25%，skill（专业能力/技能）20%，scope（责任范围/经验深度）15%。',
      'coreDuty：判断过去实际做的事情与 JD 核心职责的重合程度。business：判断业务/用户/行业/场景是否相同或高度可迁移。skill：判断关键技能是否有实际使用证据。scope：判断参与/协助/负责/独立负责以及结果证据，但没有量化结果不能直接判为没有能力。',
      '【给分锚点】按「证据格局」给分，不要把四项都挤在 50–60：',
      '- coreDuty：主责直接对口且有具体职责证据 → 70+；约一半职责重合 → 55–70；仅相邻/可迁移职责、缺主责直接证据 → 40–50；只有通用执行力（接待/销售/行政等，与主责无方向性重合）→ 35 以下。',
      '- business：用户/行业/业务模式相同或高度可迁移 → 65+；同大类但场景不同 → 50–65；行业/客户/业务模式差异大、只有通用 B 端或通用职场经验可迁移 → 45 以下。',
      '- skill：关键技能有产出/职责级使用证据 → 65+；仅「熟悉/掌握」类弱证据 → 45–60；关键技能无任何使用证据 → 40 以下（无关技能的证据不加分）。',
      '- scope：独立负责且有结果证据 → 70+；独立负责无结果 → 55–70；参与/协助/执行层 → 40–55；纯接待/销售执行且无独立负责模块 → 40 以下。',
      '【理由与分数同向】某项理由写的是「缺少直接经验 / 差异较大 / 无可核对证据 / 仅相邻」这类缺口表述时，该项不得超过 50；分数必须能被自己的理由解释，禁止「理由说缺口、分数给中性」。',
      '【分数保护】如果核心职责明显不足，不能被学历、公司背景、年限、通用技能或加分项抵消。建议：coreDuty < 40 时基础匹配不得超过 49；40–59 时不得超过 69；60–79 时不得超过 84；80+ 才允许基础匹配达到 85+。',
      '注意：上述是基础匹配分的上限保护，不是“相邻经历保底”。相邻经历完全可以低于 50。',
      '【总分】系统会根据四项分数按 40/25/20/15 在本地计算 matchScore；不要自行把加分项加入 matchScore。',
      '【证据指标】evidenceCoverage 为 0–100，表示 JD 关键要求中有多少能从简历找到可核对信息；信息不足只降低 coverage/置信度，不直接把 matchScore 清零。confidence 只能为 high / medium / low。',
      'experienceEvidence 只写与岗位职责/重点看直接相关的经历证据；highlights 只能写与岗位职责/重点看直接对应的亮点，格式为“能力点＋简历证据”；concerns 优先写明确缺口或反向证据。',
      '只返回 JSON，不要输出解释文字。'
    ].join('\n');
  }

  function normalizeModelScoreResponse(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const gates = Array.isArray(src.handwrittenGateResults)
      ? src.handwrittenGateResults.map((r) => {
          const status = r && ['pass', 'fail', 'unknown'].includes(r.status)
            ? r.status
            : (r && r.met === true ? 'pass' : (r && r.met === false ? 'fail' : 'unknown'));
          return {
            item: String((r && r.item) || '').trim(),
            status,
            met: status === 'pass',
            reason: String((r && (r.reason || r.note)) || '').trim()
          };
        }).filter((r) => r.item).slice(0, 12)
      : [];
    const bonusResults = Array.isArray(src.bonusKeywordResults)
      ? src.bonusKeywordResults.map((r) => ({
          item: String((r && r.item) || '').trim(),
          met: !!(r && r.met),
          reason: String((r && (r.reason || r.note)) || '').trim()
        })).filter((r) => r.item).slice(0, BONUS_MAX_ITEMS)
      : [];
    const scoreBreakdown = src.scoreBreakdown && typeof src.scoreBreakdown === 'object'
      ? Object.fromEntries(FIT_WEIGHT_KEYS.map((k) => {
          const x = src.scoreBreakdown[k];
          const score = Number(x && typeof x === 'object' ? x.score : x);
          return [k, { score: Number.isFinite(score) ? clampScore(score) : null, reason: String((x && x.reason) || '').trim() }];
        }))
      : null;
    const hasBreakdown = scoreBreakdown && FIT_WEIGHT_KEYS.every((k) => scoreBreakdown[k].score != null);
    if (!src.dimensions && !hasFiniteScore(src.matchScore) && !hasBreakdown) {
      const fail = scoreErrorResult(scoreParseFailureMessage('missing-field'));
      fail.parseFailureKind = 'missing-field';
      return fail;
    }
    return {
      dimensions: src.dimensions || null,
      matchScore: hasFiniteScore(src.matchScore) ? clampScore(src.matchScore) : undefined,
      scoreBreakdown: hasBreakdown ? scoreBreakdown : null,
      evidenceCoverage: Number.isFinite(Number(src.evidenceCoverage))
        ? Math.max(0, Math.min(100, Math.round(Number(src.evidenceCoverage)))) : null,
      confidence: CONFIDENCE_LEVELS.has(src.confidence) ? src.confidence : 'medium',
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
            status: 'unknown',
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
    // 结构化评分把匹配分收进「评分明细」的计算链，卡面只留决策分一个数；
    // 旧缓存结果（无 scoreBreakdown）没有明细区，继续在档位行展示匹配分
    if (s.scoreBreakdown) return '';
    if (!hasFiniteScore(s.matchScore) || Number(s.matchScore) === Number(s.score)) return '';
    return '经历匹配 ' + clampScore(s.matchScore);
  }

  const api = {
    WEIGHT_KEYS,
    FIT_WEIGHT_KEYS,
    FIT_WEIGHTS,
    DIM_LABEL,
    BONUS_POINTS_PER_ITEM,
    BONUS_POINTS_CAP,
    BONUS_MAX_ITEMS,
    STRUCTURED_HARD_MODE,
    scoreErrorResult,
    isScoreFailure,
    isRetryableScoreFailure,
    NON_RETRYABLE_FAILURE_KINDS,
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
