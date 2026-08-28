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

  function hasSyncedDecisionFeedback(view) {
    if (!view || !hasDecisionFeedback(view.feedback)) return false;
    if (view.feedbackSync === 'pending' || view.feedbackSync === 'failed') return false;
    return true;
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
            dims: score.dims || null,
            suggestions: score.suggestions || [],
            highlights: score.highlights || [],
            concerns: score.concerns || [],
            unmet: score.unmet || [],
            waivedUnmet: score.waivedUnmet || [],
            unmetNice: score.unmetNice || [],
            penalty: score.penalty || 0,
            baseScore: score.baseScore,
            matchScore: score.matchScore != null ? score.matchScore : score.baseScore
          }
        : null,
      stage: item && item.stage ? item.stage : null,
      rescoring: !!(item && item.__rescoring)
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
    if (tab === 'recommend') return isRecommendView(view);
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
    if (n >= 75) return '#52c41a';
    if (n >= 50) return '#1890ff';
    if (n >= 45) return '#13c2c2';
    if (n >= 35) return '#fa8c16';
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
    const waivedUnmet = (input && input.waivedUnmet) || [];
    const unmetNice = (input && input.unmetNice) || [];
    const left = highlights.map(stripEvidencePrefix).filter(Boolean);
    const right = [];
    const unmetNames = [];
    const tierLabel = { must: '必须', important: '重要', nice: '加分' };
    unmet.forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (!item) return;
      unmetNames.push(item);
      const tier = (r && r.tier) || 'must';
      const note = r.note ? String(r.note).trim() : '';
      const tag = tierLabel[tier] || '必须';
      right.push({
        kind: 'unmet',
        item,
        tier,
        action: 'ignore',
        text: note
          ? ('缺「' + item + '」（' + tag + '，' + note + '）')
          : ('缺「' + item + '」（' + tag + '）')
      });
    });
    concerns.map(stripEvidencePrefix).filter(Boolean).forEach((text) => {
      if (unmetNames.some((n) => evidenceOverlapsItem(text, n))) return;
      right.push({ kind: 'concern', item: null, action: null, text });
    });
    unmetNice.forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (!item) return;
      const note = r.note ? String(r.note).trim() : '';
      right.push({
        kind: 'nice',
        item: null,
        action: null,
        text: note ? ('加分未体现「' + item + '」（' + note + '）') : ('加分未体现「' + item + '」')
      });
    });
    waivedUnmet.forEach((r) => {
      const item = r && String(r.item || '').trim();
      if (!item) return;
      right.push({
        kind: 'waived',
        item,
        action: 'restore',
        text: '已忽略「' + item + '」'
      });
    });
    return { left, right };
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

  function extractHardAutofillFromText(text) {
    const t = String(text || '');
    return {
      degree: extractDegreeFromText(t),
      exp: extractExperienceFromText(t),
      schools: extractSchoolsFromText(t),
      gender: extractGenderFromText(t),
      ageRangeValues: extractAgeRangesFromText(t),
      internship: extractInternshipFromText(t),
      resumeKeywords: extractResumeKeywordsFromText(t)
    };
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
      unmet: score.unmet,
      waivedUnmet: score.waivedUnmet,
      unmetNice: score.unmetNice
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
    extractDegreeFromText,
    extractExperienceFromText,
    extractSchoolsFromText,
    extractGenderFromText,
    extractAgeRangesFromText,
    extractInternshipFromText,
    extractHardAutofillFromText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
