/**
 * 本岗决策复盘与可执行校准建议（popup / Node 测试共用）
 */
(function (root) {
  const DIM_KEYS = ['experience', 'skill', 'education', 'potential'];
  const DIM_LABEL = {
    experience: '经验相关性',
    skill: '技能匹配',
    education: '教育背景',
    potential: '潜力成长'
  };
  const MIN_DECISIONS_FOR_SUGGEST = 5;
  const MIN_MISMATCH_FOR_WEIGHT = 3;
  const WEIGHT_STEP = 5;

  function tokenizePhrases(list) {
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

  function inferDimFromText(text) {
    const t = String(text || '');
    if (/经验|实习|岗位|业务|行业|项目|年限|相关/.test(t)) return 'experience';
    if (/技能|工具|栈|能力|操作|投放|设计|代码|Excel|SQL|Python|Java|AIGC|AI/.test(t)) return 'skill';
    if (/学历|学校|专业|教育|本科|硕士|博士|985|211/.test(t)) return 'education';
    if (/潜力|学习|成长|沟通|主动|抗压|表达/.test(t)) return 'potential';
    return null;
  }

  function avgDimScores(entries) {
    const sums = Object.create(null);
    const ns = Object.create(null);
    DIM_KEYS.forEach((k) => { sums[k] = 0; ns[k] = 0; });
    (entries || []).forEach((entry) => {
      const dims = entry && entry.snapshot && entry.snapshot.dims;
      if (!dims || typeof dims !== 'object') return;
      DIM_KEYS.forEach((k) => {
        const n = Number(dims[k]);
        if (!Number.isFinite(n)) return;
        sums[k] += n;
        ns[k] += 1;
      });
    });
    const out = {};
    DIM_KEYS.forEach((k) => {
      out[k] = ns[k] ? sums[k] / ns[k] : null;
    });
    return out;
  }

  function lowestDim(avg) {
    let best = null;
    let bestVal = Infinity;
    DIM_KEYS.forEach((k) => {
      const v = avg && avg[k];
      if (!Number.isFinite(v)) return;
      if (v < bestVal) {
        bestVal = v;
        best = k;
      }
    });
    return best;
  }

  function bumpWeight(weights, key, step) {
    const src = weights && typeof weights === 'object' ? weights : {};
    const next = {};
    DIM_KEYS.forEach((k) => {
      next[k] = Number.isFinite(Number(src[k])) ? Number(src[k]) : 0;
    });
    if (!DIM_KEYS.includes(key)) return next;
    next[key] = Math.min(100, (next[key] || 0) + (step || WEIGHT_STEP));
    return next;
  }

  /**
   * @returns {{
   *   total:number, recommend:number, eliminate:number,
   *   agree:number, overRecommend:number, underRecommend:number,
   *   topConcerns:Array<{text:string,count:number}>,
   *   topHighlights:Array<{text:string,count:number}>,
   *   suggestions:Array<object>,
   *   summary:string
   * }}
   */
  function buildCalibrationReport(record, jobId, opts) {
    const feedback = root.MokaFeedback || (typeof require !== 'undefined' ? require('./feedback.js') : null);
    const bag = feedback
      ? feedback.getFeedbackForJob(record, jobId)
      : {};
    const entries = Object.values(bag || {});
    const options = opts || {};
    const weights = options.weights || null;

    let recommend = 0;
    let eliminate = 0;
    let agree = 0;
    let overRecommend = 0; // AI 推荐但你淘汰
    let underRecommend = 0; // AI 未推但你推荐
    const overEntries = [];
    const underEntries = [];
    const concernBag = [];
    const highlightBag = [];
    const mustHaveHits = Object.create(null);

    entries.forEach((entry) => {
      if (!entry) return;
      const s = entry.snapshot || {};
      if (entry.verdict === 'recommend') {
        recommend++;
        (s.highlights || []).forEach((h) => highlightBag.push(h));
        if (s.pluginRecommend === false) {
          underRecommend++;
          underEntries.push(entry);
        } else if (s.pluginRecommend === true) {
          agree++;
        }
      } else if (entry.verdict === 'eliminate') {
        eliminate++;
        (s.concerns || []).forEach((c) => concernBag.push(c));
        (s.hardMissing || []).forEach((m) => {
          const key = String(m || '').trim();
          if (!key) return;
          mustHaveHits[key] = (mustHaveHits[key] || 0) + 1;
        });
        if (s.pluginRecommend === true) {
          overRecommend++;
          overEntries.push(entry);
        } else if (s.pluginRecommend === false) {
          agree++;
        }
      }
    });

    const total = recommend + eliminate;
    const topConcerns = tokenizePhrases(concernBag).slice(0, 5);
    const topHighlights = tokenizePhrases(highlightBag).slice(0, 5);
    const suggestions = [];

    if (total >= MIN_DECISIONS_FOR_SUGGEST && overRecommend >= MIN_MISMATCH_FOR_WEIGHT) {
      const overAvg = avgDimScores(overEntries);
      let dim = null;
      if (topConcerns.length) {
        for (let i = 0; i < topConcerns.length; i++) {
          dim = inferDimFromText(topConcerns[i].text);
          if (dim) break;
        }
      }
      if (!dim) dim = lowestDim(overAvg) || 'experience';
      const nextWeights = bumpWeight(weights, dim, WEIGHT_STEP);
      suggestions.push({
        id: 'boost-' + dim,
        type: 'weight',
        title: '提高「' + DIM_LABEL[dim] + '」权重',
        detail: 'AI 推你却淘汰 ' + overRecommend + ' 人，差距偏「' + DIM_LABEL[dim]
          + '」。采纳后该维 +' + WEIGHT_STEP + '。',
        editableValue: '',
        apply: { weights: nextWeights, bump: dim, step: WEIGHT_STEP }
      });
    }

    if (total >= MIN_DECISIONS_FOR_SUGGEST && underRecommend >= MIN_MISMATCH_FOR_WEIGHT) {
      const underAvg = avgDimScores(underEntries);
      let dim = lowestDim(underAvg);
      if (!dim && topHighlights.length) dim = inferDimFromText(topHighlights[0].text);
      if (!dim) dim = 'potential';
      if (suggestions.some((s) => s.apply && s.apply.bump === dim)) dim = dim === 'potential' ? 'skill' : 'potential';
      const nextWeights = bumpWeight(
        (suggestions[0] && suggestions[0].apply && suggestions[0].apply.weights) || weights,
        dim,
        WEIGHT_STEP
      );
      suggestions.push({
        id: 'rescue-' + dim,
        type: 'weight',
        title: '补强「' + DIM_LABEL[dim] + '」以免漏推',
        detail: '你推但 AI 未推 ' + underRecommend + ' 人。采纳后「' + DIM_LABEL[dim] + '」+' + WEIGHT_STEP + '。',
        editableValue: '',
        apply: { weights: nextWeights, bump: dim, step: WEIGHT_STEP }
      });
    }

    const mustHaveCandidates = Object.entries(mustHaveHits)
      .map(([raw, count]) => [normalizeMustHaveLabel(raw), count])
      .filter(([item]) => !!item)
      .reduce((acc, [item, count]) => {
        acc[item] = (acc[item] || 0) + count;
        return acc;
      }, Object.create(null));
    Object.entries(mustHaveCandidates)
      .sort((a, b) => b[1] - a[1])
      .filter(([, n]) => n >= 2)
      .slice(0, 2)
      .forEach(([item, count]) => {
        suggestions.push({
          id: 'must-' + item,
          type: 'mustHave',
          title: '加入必备项',
          detail: '淘汰记录中出现 ' + count + ' 次，可改成更短的必备表述后再保存。',
          editableValue: item,
          apply: { mustHave: item }
        });
      });

    if (total > 0 && total < MIN_DECISIONS_FOR_SUGGEST) {
      suggestions.push({
        id: 'need-more',
        type: 'info',
        title: '样本还少',
        detail: '已决策 ' + total + ' 条，满 ' + MIN_DECISIONS_FOR_SUGGEST + ' 条后会给出更稳的权重建议。',
        apply: null
      });
    } else if (total === 0) {
      suggestions.push({
        id: 'empty',
        type: 'info',
        title: '暂无决策可复盘',
        detail: '对本岗点「推荐 / 淘汰」后，这里会统计你与 AI 的异同，并给出可编辑后采纳的规则调整。',
        apply: null
      });
    } else if (!suggestions.length) {
      suggestions.push({
        id: 'aligned',
        type: 'info',
        title: '判断较一致',
        detail: '暂无明显系统性偏差。也可在下方自行新增必备项并保存。',
        apply: null
      });
    }

    return {
      total,
      recommend,
      eliminate,
      agree,
      overRecommend,
      underRecommend,
      topConcerns,
      topHighlights,
      suggestions: suggestions.slice(0, 4),
      summary: total
        ? ('已决策 ' + total + ' · 推荐 ' + recommend + ' · 淘汰 ' + eliminate)
        : '暂无决策'
    };
  }

  /** 去掉「缺」「未满足」等展示前缀，得到可写入必备项的干净文案 */
  function normalizeMustHaveLabel(raw) {
    let t = String(raw || '').trim();
    if (!t) return '';
    let m;
    while ((m = t.match(/[「『"']([^「『」』"']+)[」』"']/))) {
      t = m[1].trim();
    }
    t = t.replace(/^(缺|缺少|未满足)[:：\s]*/g, '').trim();
    t = t.replace(/^缺\s*/, '').trim();
    return t.slice(0, 40);
  }

  const api = {
    DIM_KEYS,
    DIM_LABEL,
    MIN_DECISIONS_FOR_SUGGEST,
    WEIGHT_STEP,
    tokenizePhrases,
    inferDimFromText,
    avgDimScores,
    bumpWeight,
    normalizeMustHaveLabel,
    buildCalibrationReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaCalibrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
