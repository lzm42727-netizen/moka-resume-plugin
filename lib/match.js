/**
 * 关键词匹配、芯片解析、结果过滤（popup / content / Node 测试共用）
 */
(function (root) {
  const EN_STOP = new Set(['the', 'and', 'or', 'for', 'with', 'you', 'are', 'our', 'job', 'jd', 'kpi', 'app', 'web', 'ok', 'etc']);

  const CHIP_LIMIT = 6;

  function parseChipList(str) {
    return String(str || '')
      .split(/[,，、;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CHIP_LIMIT);
  }

  function matchKeywords(haystack, keywords) {
    const textLower = String(haystack || '').toLowerCase();
    const hit = [];
    const miss = [];
    (keywords || []).forEach((raw) => {
      const k = String(raw || '').trim();
      if (!k) return;
      if (textLower.indexOf(k.toLowerCase()) !== -1) hit.push(k);
      else miss.push(k);
    });
    return { hit, miss };
  }

  function isRecommendItem(item) {
    return !!(item && item.score && MokaScore.isRecommendLevel(item.score.level));
  }

  function isRecommendView(view) {
    return !!(view && view.score && MokaScore.isRecommendLevel(view.score.level));
  }

  function hasDecisionFeedback(viewOrFeedback) {
    if (viewOrFeedback && typeof viewOrFeedback === 'object' && 'feedback' in viewOrFeedback) {
      return hasDecisionFeedback(viewOrFeedback.feedback);
    }
    const f = viewOrFeedback;
    return f === 'recommend' || f === 'eliminate' || f === 'positive' || f === 'negative';
  }

  /** 待处理列表：本地已决策（含同步中/失败）即移出，方便连续处理下一位 */
  function hasAnyDecisionFeedback(view) {
    return hasDecisionFeedback(view && view.feedback);
  }

  function itemMatchesFilter(item, filter) {
    const tab = (filter && filter.tab) || 'all';
    const q = String((filter && filter.query) || '').trim().toLowerCase();
    const name = String((item && item.app && item.app.name) || '').toLowerCase();
    if (q && name.indexOf(q) === -1) return false;
    if (tab === 'recommend') return isRecommendItem(item);
    if (tab === 'hardfail') return !!(item && item.hard && item.hard.passed === false);
    if (tab === 'error') return !!(item && item.score && item.score.level === '错误');
    return true;
  }

  function extractResumeKeywordsFromText(text) {
    const kws = new Set();
    const tokens = String(text || '').match(/[A-Za-z][A-Za-z0-9+#.]{1,11}/g) || [];
    tokens.forEach((w) => {
      const t = w.replace(/[.]+$/, '').trim();
      if (t.length >= 2 && !EN_STOP.has(t.toLowerCase())) kws.add(t);
    });
    return Array.from(kws).slice(0, CHIP_LIMIT);
  }

  function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addCalendarMonths(d, months) {
    return new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  }

  function parseEducationEndDate(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (/^(至今|现在|present)$/i.test(text)) return null;
    const m = text.match(/^(\d{4})[./-](\d{1,2})(?:[./-](\d{1,2}))?/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!year || month < 1 || month > 12) return null;
    if (m[3]) {
      const day = Number(m[3]);
      if (day < 1 || day > 31) return null;
      return new Date(year, month - 1, day);
    }
    return new Date(year, month, 0);
  }

  function yearMonthLabel(d) {
    return d.getFullYear() + '.' + String(d.getMonth() + 1);
  }

  /**
   * 实习岗：最晚毕业日已到或未满半年则提示。正式岗 / 已毕业 / 满半年 / 无日期 → null。
   */
  function graduationRiskHint(educationList, opts) {
    const options = opts || {};
    if (options.jobType !== 'intern') return null;
    const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
      ? options.now
      : new Date();
    const today = startOfLocalDay(now);
    const horizon = addCalendarMonths(today, 6);
    let latest = null;
    (Array.isArray(educationList) ? educationList : []).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const parsed = parseEducationEndDate(row.endDate || row.endTime || row.end || row.to);
      if (!parsed) return;
      if (!latest || parsed > latest) latest = parsed;
    });
    if (!latest) return null;
    const end = startOfLocalDay(latest);
    if (end < today || end >= horizon) return null;
    const endLabel = yearMonthLabel(end);
    return { endLabel, text: '毕业 ' + endLabel + '，距今不足半年' };
  }

  function toResultView(item) {
    const app = (item && item.app) || {};
    const hard = item && item.hard;
    const hardLocal = (item && item.hardLocal) || hard;
    const score = item && item.score;
    const keywords = item && item.keywords;
    const structuredHardPassed = !(hardLocal && hardLocal.passed === false);
    return {
      id: app.id,
      name: app.name || '(未知)',
      meta: [app.highestDegree, app.highestDegreeSchool, app.specialities].filter(Boolean).join(' · '),
      hardPassed: !(hard && hard.passed === false),
      structuredHardPassed,
      hardMissing: (hard && hard.missing) || [],
      keywords: {
        hit: (keywords && keywords.hit) || [],
        miss: (keywords && keywords.miss) || []
      },
      score: score
        ? {
            score: score.score,
            level: score.level,
            error: score.error || '',
            advanceReason: score.advanceReason,
            dims: score.dims || null,
            suggestions: score.suggestions || [],
            highlights: score.highlights || [],
            concerns: score.concerns || [],
            experienceEvidence: score.experienceEvidence || [],
            unmet: score.unmet || [],
            waivedUnmet: score.waivedUnmet || [],
            unmetNice: score.unmetNice || [],
            metNice: score.metNice || [],
            penalty: score.penalty || 0,
            mustPenalty: typeof score.mustPenalty === 'number' ? score.mustPenalty : 0,
            importantPenalty: typeof score.importantPenalty === 'number' ? score.importantPenalty : 0,
            bonus: typeof score.bonus === 'number' ? score.bonus : 0,
            bonusKeywordResults: score.bonusKeywordResults || [],
            bonusPoints: typeof score.bonusPoints === 'number' ? score.bonusPoints : 0,
            bonusApplied: typeof score.bonusApplied === 'number' ? score.bonusApplied : 0,
            bonusMetCount: typeof score.bonusMetCount === 'number' ? score.bonusMetCount : 0,
            bonusTotalCount: typeof score.bonusTotalCount === 'number' ? score.bonusTotalCount : 0,
            bonusPromoted: !!score.bonusPromoted,
            baseScore: score.baseScore,
            matchScore: score.matchScore != null ? score.matchScore : score.baseScore,
            ...(score.scoreBreakdown ? { scoreBreakdown: score.scoreBreakdown } : {}),
            ...(typeof score.evidenceCoverage === 'number' ? { evidenceCoverage: score.evidenceCoverage } : {}),
            ...(score.confidence && score.confidence !== 'medium' ? { confidence: score.confidence } : {}),
            ...(Array.isArray(score.unknown) && score.unknown.length ? { unknown: score.unknown } : {})
          }
        : null,
      stage: item && item.stage ? item.stage : null,
      rescoring: !!(item && item.__rescoring),
      graduationRisk: (item && item.graduationRisk) || null
    };
  }

  function summarizeResultViews(views) {
    const list = Array.isArray(views) ? views : [];
    let scored = 0;
    let recommend = 0;
    let hardfail = 0;
    let error = 0;
    list.forEach((v) => {
      if (v && v.score) {
        scored++;
        if (isRecommendView(v)) recommend++;
        if (v.score.level === '错误') error++;
      }
      if (v && v.structuredHardPassed === false) hardfail++;
    });
    return { total: list.length, scored, recommend, hardfail, error };
  }

  function sortResultViews(views) {
    return (Array.isArray(views) ? views.slice() : []).sort((a, b) => {
      const sa = a && a.score && typeof a.score.score === 'number' ? a.score.score : -1;
      const sb = b && b.score && typeof b.score.score === 'number' ? b.score.score : -1;
      return sb - sa;
    });
  }

  function viewMatchesFilter(view, filter) {
    const tab = (filter && filter.tab) || 'all';
    const q = String((filter && filter.query) || '').trim().toLowerCase();
    const name = String((view && view.name) || '').toLowerCase();
    if (q && name.indexOf(q) === -1) return false;
    // 推荐 tab = 待推进清单：一旦本地已决策（推荐/淘汰），即移入「已决策」
    if (tab === 'recommend') return isRecommendView(view) && !hasAnyDecisionFeedback(view);
    if (tab === 'hardfail') return !!(view && view.structuredHardPassed === false);
    if (tab === 'error') return !!(view && view.score && view.score.level === '错误');
    if (tab === 'feedback') return hasAnyDecisionFeedback(view);
    if (tab === 'all') return !hasAnyDecisionFeedback(view);
    return true;
  }

  function candidateOpenPath(appId, search) {
    const raw = search == null ? '' : String(search);
    const q = !raw ? '' : (raw.charAt(0) === '?' ? raw : '?' + raw);
    return '/candidates/application/' + appId + q;
  }

  function scoreColor(score) {
    const n = Number(score);
    if (n >= 80) return '#52c41a';
    if (n >= 50) return '#1890ff';
    return '#ff4d4f';
  }

  function customHardLabel(item) {
    return '缺「' + String(item || '').trim() + '」';
  }

  function itemFromCustomHardLabel(label) {
    const m = String(label || '').match(/^缺「(.+)」$/);
    return m ? m[1] : '';
  }

  function mergeHardWithMustHaves(hard, unmetResults) {
    const local = (hard && Array.isArray(hard.missing)) ? hard.missing.slice() : [];
    const custom = [];
    (unmetResults || []).forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (item) custom.push(customHardLabel(item));
    });
    const missing = local.concat(custom);
    return {
      passed: missing.length === 0,
      missing
    };
  }

  function noiseLeft(text, patterns) {
    let t = String(text || '');
    patterns.forEach((p) => { t = t.replace(p, ''); });
    return t.replace(/[\s，。、:：()（）]/g, '').trim();
  }

  function parseLeadingMinYears(text) {
    const t = String(text || '').trim();
    const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    let m = t.match(/^(\d+)\s*年(?:及)?以上/);
    if (m) return Number(m[1]);
    m = t.match(/^([一二两三四五六七八九十])\s*年(?:及)?以上/);
    if (m && CN[m[1]] != null) return CN[m[1]];
    return null;
  }

  /** 芯片开头的工作年限要求是否与结构化「经验要求」重复 */
  function chipExpressesStructuredYearOverlap(text, expBucket) {
    const t = String(text || '').trim();
    if (!t || !expBucket) return false;

    const expPat = {
      fresh: /在校|应届/,
      '1-3': /1\s*[-~～到至]\s*3\s*年|1-3年|一至三年/,
      '3-5': /3\s*[-~～到至]\s*5\s*年|3-5年|三至五年|3到5年/,
      '5+': /5\s*年以[上超]|五年以[上超]/
    };
    if (expPat[expBucket] && expPat[expBucket].test(t) && /年|经验|应届|在校/.test(t) && t.length <= 16) {
      return true;
    }

    const minYears = parseLeadingMinYears(t);
    if (minYears != null) {
      if (expBucket === 'fresh') return minYears <= 1;
      if (expBucket === '1-3') return minYears >= 1 && minYears < 3;
      if (expBucket === '3-5') return minYears >= 3;
      if (expBucket === '5+') return minYears >= 5;
    }

    if (expBucket === '3-5' && /3\s*[-~～到至]\s*5\s*年|3-5年|三至五年/.test(t)) return true;
    return false;
  }

  /** 去掉芯片开头与结构化年限重复的前缀，保留领域/技能要求 */
  function stripLeadingYearsFromMustHave(chip) {
    let t = String(chip || '').trim();
    t = t.replace(/^(\d+|[一二两三四五六七八九十])\s*年(?:及)?以上(?:的|及以上)?\s*/u, '');
    t = t.replace(/^(\d+)\s*[-~～到至]\s*(\d+)\s*年(?:的)?\s*/u, '');
    t = t.replace(/^(至少\s*)?(\d+|[一二两三四五六七八九十])\s*年(?:以上)?(?:的)?\s*/u, '');
    return t.trim();
  }

  function chipOverlapsHard(chip, hc) {
    const t = String(chip || '').trim();
    if (!t || !hc) return false;

    if (hc.degree && t.indexOf(hc.degree) !== -1) {
      if (!noiseLeft(t, [hc.degree, /学历/g, /及以上/g, /以上/g, /全日制/g, /毕业/g, /要求/g, /需/g])) {
        return true;
      }
    }

    if (hc.gender) {
      const g = hc.gender;
      if (t === g || t === '性别' + g || t === '仅限' + g || t === g + '性') return true;
      if (t.indexOf('性别') !== -1 && t.indexOf(g) !== -1 && !noiseLeft(t, [/性别/g, g, /要求/g, /限/g, /仅/g])) {
        return true;
      }
    }

    const expPat = {
      'fresh': /在校|应届/,
      '1-3': /1\s*[-~～到至]\s*3\s*年|1-3年/,
      '3-5': /3\s*[-~～到至]\s*5\s*年|3-5年/,
      '5+': /5\s*年以[上超]|五年以[上超]/
    };
    if (hc.exp && chipExpressesStructuredYearOverlap(t, hc.exp)) {
      return true;
    }
    if (hc.exp && expPat[hc.exp] && expPat[hc.exp].test(t) && /年|经验|应届|在校/.test(t) && t.length <= 12) {
      return true;
    }

    if (Array.isArray(hc.schools) && hc.schools.some((s) => t === s || t === s + '院校' || t === s + '学校')) {
      return true;
    }

    const ranges = Array.isArray(hc.ageRanges) ? hc.ageRanges : [];
    if (ranges.length && /年龄/.test(t)) return true;
    if (ranges.some((r) => r && r.label && t === r.label)) return true;

    return false;
  }

  function isMeaningfulMustHaveDomain(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 4) return false;
    if (/^(经验|工作|从业|相关经验|工作经验|年限)$/.test(t)) return false;
    return true;
  }

  function dedupeMustHavesAgainstHard(chips, hc) {
    const out = [];
    (chips || []).forEach((raw) => {
      const c = String(raw || '').trim();
      if (!c) return;
      if (chipOverlapsHard(c, hc)) {
        const domain = stripLeadingYearsFromMustHave(c);
        if (domain && domain !== c && isMeaningfulMustHaveDomain(domain)
            && !chipOverlapsHard(domain, hc) && out.indexOf(domain) === -1) {
          out.push(domain);
        }
        return;
      }
      if (out.indexOf(c) === -1) out.push(c);
    });
    return out.slice(0, CHIP_LIMIT);
  }

  function stripEvidencePrefix(text) {
    return String(text || '').replace(/^[✓✔✕❌×•·\s]+/, '').trim();
  }

  function evidenceOverlapsItem(text, item) {
    const t = String(text || '');
    const i = String(item || '');
    if (!t || !i) return false;
    return t.indexOf(i) !== -1 || i.indexOf(t) !== -1;
  }

  function buildEvidenceColumns(input) {
    const highlights = (input && input.highlights) || [];
    const concerns = (input && input.concerns) || [];
    const unmet = (input && input.unmet) || [];
    // 「具备」列只放与岗位直接相关的亮点（评分提示词要求 highlights 挂靠 JD 职责/重点看）。
    const left = highlights.map(stripEvidencePrefix).filter(Boolean);
    // 经历证据独立成区，不再混入「具备」列；与亮点重叠的句子跳过，避免重复。
    const evidence = [];
    (((input && input.experienceEvidence) || [])
      .map(stripEvidencePrefix)
      .filter(Boolean))
      .forEach((text) => {
        if (left.some((h) => evidenceOverlapsItem(h, text))) return;
        if (evidence.length >= 6) return;
        evidence.push(text);
      });
    const right = [];
    const unmetNames = [];
    unmet.forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (!item) return;
      unmetNames.push(item);
      const reason = String((r && (r.reason || r.note)) || '').trim();
      right.push({
        kind: 'unmet',
        item,
        action: null,
        // 「差距」列的门槛条目已带「门槛」徽章，正文只留「条目：原因」，
        // 不再重复「未过门槛「」」前缀（顶部标签行已删，档位行统一说明）
        text: reason ? (item + '：' + reason) : item
      });
    });
    concerns.map(stripEvidencePrefix).filter(Boolean).forEach((text) => {
      if (unmetNames.some((n) => evidenceOverlapsItem(text, n))) return;
      right.push({ kind: 'concern', item: null, action: null, text });
    });
    return { left, right, evidence };
  }

  /** 结果卡名字下：加分已具备 / 未体现标签文案 */
  function niceBonusTagsFromScore(score) {
    const s = score || {};
    const met = [];
    const unmet = [];
    if (Array.isArray(s.bonusKeywordResults)) {
      s.bonusKeywordResults.forEach((r) => {
        const item = r && String(r.item || '').trim();
        if (!item) return;
        (r.met === true ? met : unmet).push(item);
      });
      return { met: met.slice(0, 5), unmet: unmet.slice(0, 5) };
    }
    (Array.isArray(s.metNice) ? s.metNice : []).forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (item) met.push(item);
    });
    (Array.isArray(s.unmetNice) ? s.unmetNice : []).forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (item) unmet.push(item);
    });
    return { met: met.slice(0, 3), unmet: unmet.slice(0, 3) };
  }

  function bonusScoreDisplay(score) {
    const s = score || {};
    if (s.level === '错误') return '';
    const total = Math.max(0, Number(s.bonusTotalCount) || 0);
    if (!total) return '';
    const met = Math.max(0, Number(s.bonusMetCount) || 0);
    if (s.advanceReason === 'gate') {
      const match = Number(s.matchScore);
      // 结构化评分（有 scoreBreakdown）时匹配分收进「评分明细」的计算链，卡面只留决策分
      const matchPart = !s.scoreBreakdown && Number.isFinite(match) && match !== Number(s.score)
        ? ('经历匹配 ' + match + ' · ')
        : '';
      return matchPart + '加分看 ' + met + '/' + total + '（未计入）';
    }
    if (s.advanceReason === 'match' || Number(s.matchScore) < 50) {
      return '加分看 ' + met + '/' + total + '（未计入，匹配不足 50）';
    }
    const applied = Math.max(0, Number(s.bonusApplied) || 0);
    if (applied > 0) {
      return (s.scoreBreakdown ? '' : '经历匹配 ' + Number(s.matchScore) + ' · ') + '加分 +' + applied;
    }
    return '加分看 ' + met + '/' + total;
  }

  const CN_YEAR = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function parseYearToken(tok) {
    const s = String(tok || '');
    if (/^\d+$/.test(s)) return Number(s);
    return CN_YEAR[s] != null ? CN_YEAR[s] : null;
  }

  function yearsToExpBucket(min, max) {
    if (max == null) {
      if (min >= 5) return '5+';
      if (min >= 3) return '3-5';
      if (min >= 1) return '1-3';
      return 'fresh';
    }
    const mid = (min + max) / 2;
    if (mid >= 5) return '5+';
    if (mid >= 3) return '3-5';
    if (mid >= 1) return '1-3';
    return 'fresh';
  }

  function degreeRankFromSnippet(s) {
    if (/博士/.test(s)) return '博士';
    if (/硕士|研究生/.test(s)) return '硕士';
    if (/本科|学士/.test(s)) return '本科';
    return '';
  }

  function extractDegreeFromText(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (t.length <= 12) return degreeRankFromSnippet(t);
    const hits = t.match(/(博士|硕士|研究生|本科|学士|大专|专科)\s*(?:及以上|以上|学历|起|毕业)?/g) || [];
    const withSuffix = hits.filter((h) => /及以上|以上|学历|起|毕业/.test(h));
    const pool = withSuffix.length ? withSuffix : hits;
    let best = '';
    pool.forEach((h) => {
      const r = degreeRankFromSnippet(h);
      if (r === '博士') best = '博士';
      else if (r === '硕士' && best !== '博士') best = '硕士';
      else if (r === '本科' && !best) best = '本科';
    });
    return best;
  }

  function extractExperienceFromText(text) {
    const t = String(text || '');
    if (!t.trim()) return '';
    if (/经验\s*不限|年限\s*不限|工作经验\s*不限/.test(t)) return '';
    const token = '(\\d+|[一二两三四五六七八九十])';
    const range = t.match(new RegExp(token + '\\s*[-~～—至到]\\s*' + token + '\\s*年'));
    if (range) {
      const a = parseYearToken(range[1]);
      const b = parseYearToken(range[2]);
      if (a != null && b != null) return yearsToExpBucket(Math.min(a, b), Math.max(a, b));
    }
    const minOnly = t.match(new RegExp(token + '\\s*年(?:及)?以上'));
    if (minOnly) {
      const n = parseYearToken(minOnly[1]);
      if (n != null) return yearsToExpBucket(n, null);
    }
    if (/应届|在校生|在校或应届/.test(t)) return 'fresh';
    return '';
  }

  function extractSchoolsFromText(text) {
    const t = String(text || '');
    if (!t.trim() || /院校\s*不限|学校\s*不限/.test(t)) return [];
    const out = [];
    if (/211/.test(t)) out.push('211');
    if (/985/.test(t)) out.push('985');
    if (/双一流/.test(t)) out.push('双一流');
    if (/留学|海归|海外学历|海外院校|海外教育/.test(t)) out.push('留学生');
    if (/QS\s*(?:前)?\s*100\b|QS100/i.test(t)) out.push('QS100');
    else if (/QS\s*(?:前)?\s*500\b|QS500/i.test(t)) out.push('QS500');
    return out;
  }

  function extractGenderFromText(text) {
    const t = String(text || '');
    if (!t.trim()) return '';
    if (/性别\s*不限|不限性别|男女不限|男女均可|男女都能/.test(t)) return '';
    if (/仅限\s*女|性别[:：]\s*女|要求女性|女性候选人/.test(t)) return '女';
    if (/仅限\s*男|性别[:：]\s*男(?!女)|要求男性|男性候选人/.test(t)) return '男';
    return '';
  }

  const AGE_BUCKETS = [
    { value: '20-25', min: 20, max: 25 },
    { value: '25-30', min: 25, max: 30 },
    { value: '30-35', min: 30, max: 35 },
    { value: '35-40', min: 35, max: 40 },
    { value: '40-50', min: 40, max: 50 },
    { value: '50+', min: 50, max: null }
  ];

  function ageBucketsOverlapping(needMin, needMax) {
    const nMax = needMax == null ? Infinity : needMax;
    const nMin = needMin == null ? 0 : needMin;
    return AGE_BUCKETS.filter((b) => {
      const bMax = b.max == null ? Infinity : b.max;
      return Math.min(nMax, bMax) - Math.max(nMin, b.min) > 0;
    }).map((b) => b.value);
  }

  function extractAgeRangesFromText(text) {
    const t = String(text || '');
    if (!t.trim() || /年龄\s*不限|不限年龄/.test(t)) return [];
    const range = t.match(/(\d{2})\s*[-~～至到]\s*(\d{2})\s*岁/);
    if (range) return ageBucketsOverlapping(Number(range[1]), Number(range[2]));
    const below = t.match(/(\d{2})\s*岁(?:及)?以下|不超过\s*(\d{2})\s*岁/);
    if (below) return ageBucketsOverlapping(20, Number(below[1] || below[2]));
    const above = t.match(/(\d{2})\s*岁(?:及)?以上/);
    if (above) return ageBucketsOverlapping(Number(above[1]), null);
    return [];
  }

  function extractInternshipFromText(text) {
    const t = String(text || '');
    if (!t.trim() || /实习经验\s*不限/.test(t)) return '';
    if (/(?:需(?:要|具备)|必须|要求).{0,12}实习/.test(t)) return 'required';
    return '';
  }

  function extractHandwrittenGatesFromText(text) {
    const clauses = String(text || '').split(/[\n；;。]+/).map((s) => s.trim()).filter(Boolean);
    const languages = [];
    const customGates = [];
    const pushUnique = (target, value) => {
      const clean = String(value || '').trim();
      if (clean && target.length < CHIP_LIMIT && target.indexOf(clean) === -1) target.push(clean);
    };
    clauses.forEach((clause) => {
      const languageMatches = clause.match(/(?:日语\s*(?:N[1-5])?(?:\s*及以上)?|英语\s*(?:CET[-\s]?[46]|六级|四级|流利|熟练)?|法语|德语|韩语|西班牙语|俄语)/gi) || [];
      languageMatches.forEach((value) => pushUnique(languages, value.replace(/\s+/g, '')));

      const major = clause.match(/([\u4e00-\u9fa5A-Za-z]{1,12}(?:类|方向)?(?:相关)?专业)/);
      if (major && !/(本科|硕士|研究生|博士|大专|专科)(?:及以上)?学历?$/.test(major[1])) {
        pushUnique(customGates, major[1]);
      }
      const tool = clause.match(/((?:会|能|熟练|熟悉|掌握)(?:使用)?\s*[A-Za-z][A-Za-z0-9 .+#/-]{1,30})/i);
      if (tool) pushUnique(customGates, tool[1].trim());
    });
    return { languages, customGates };
  }

  function extractHardAutofillFromText(text) {
    const t = String(text || '');
    const handwritten = extractHandwrittenGatesFromText(t);
    return {
      degree: extractDegreeFromText(t),
      exp: extractExperienceFromText(t),
      schools: extractSchoolsFromText(t),
      gender: extractGenderFromText(t),
      ageRangeValues: extractAgeRangesFromText(t),
      internship: extractInternshipFromText(t),
      languages: handwritten.languages,
      customGates: handwritten.customGates,
      resumeKeywords: extractResumeKeywordsFromText(t)
    };
  }

  function splitMustHavesForHard(mustHaves, hard) {
    const languages = [];
    const customGates = [];
    const remaining = dedupeMustHavesAgainstHard(mustHaves || [], hard || {});
    const pushUnique = (target, value) => {
      const text = String(value || '').trim();
      if (text && target.length < CHIP_LIMIT && target.indexOf(text) === -1) target.push(text);
    };
    remaining.forEach((item) => {
      const extracted = extractHandwrittenGatesFromText(item);
      extracted.languages.forEach((value) => pushUnique(languages, value));
      extracted.customGates.forEach((value) => pushUnique(customGates, value));
      if (!extracted.languages.length && !extracted.customGates.length) {
        pushUnique(customGates, item);
      }
    });
    return { languages, customGates };
  }

  function evidenceColumnsFromScore(score) {
    if (!score) return { left: [], right: [] };
    let highlights = Array.isArray(score.highlights) ? score.highlights.slice() : [];
    let concerns = Array.isArray(score.concerns) ? score.concerns.slice() : [];
    if (!highlights.length && !concerns.length && Array.isArray(score.suggestions)) {
      score.suggestions.forEach((line) => {
        const t = String(line || '').trim();
        if (/^[✓✔]/.test(t)) highlights.push(t);
        else if (/^[✕❌×]/.test(t)) concerns.push(t);
      });
    }
    return buildEvidenceColumns({
      highlights,
      concerns,
      experienceEvidence: score.experienceEvidence,
      unmet: score.unmet,
      waivedUnmet: score.waivedUnmet
    });
  }

  const api = {
    CHIP_LIMIT,
    parseChipList,
    matchKeywords,
    itemMatchesFilter,
    extractResumeKeywordsFromText,
    toResultView,
    summarizeResultViews,
    sortResultViews,
    viewMatchesFilter,
    hasAnyDecisionFeedback,
    hasDecisionFeedback,
    candidateOpenPath,
    scoreColor,
    customHardLabel,
    itemFromCustomHardLabel,
    mergeHardWithMustHaves,
    dedupeMustHavesAgainstHard,
    buildEvidenceColumns,
    evidenceColumnsFromScore,
    niceBonusTagsFromScore,
    bonusScoreDisplay,
    extractDegreeFromText,
    extractExperienceFromText,
    extractSchoolsFromText,
    extractGenderFromText,
    extractAgeRangesFromText,
    extractInternshipFromText,
    extractHardAutofillFromText,
    splitMustHavesForHard,
    graduationRiskHint
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
