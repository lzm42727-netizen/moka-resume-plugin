/**
 * 本岗决策复盘与可执行校准建议（popup / Node 测试共用）
 */
(function (root) {
  const MIN_DECISIONS_FOR_SUGGEST = 5;
  const MIN_MISMATCH_FOR_RULE = 3;
  const STRUCTURED_GATE_RE = /学历|学校|院校|年龄|性别|工作年限|经验年限/;

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

  /** 去掉「缺」「未满足」等展示前缀，得到可写入门槛的干净文案 */
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

  function isStructuredGateLabel(text) {
    return STRUCTURED_GATE_RE.test(String(text || ''));
  }

  function gatesPassed(snapshot) {
    const s = snapshot || {};
    if (s.advanceReason === 'gate') return false;
    const missing = Array.isArray(s.hardMissing) ? s.hardMissing.filter(Boolean) : [];
    return missing.length === 0;
  }

  function countNormalizedMissing(entries) {
    const hits = Object.create(null);
    (entries || []).forEach((entry) => {
      const missing = (entry && entry.snapshot && entry.snapshot.hardMissing) || [];
      missing.forEach((raw) => {
        const item = normalizeMustHaveLabel(raw);
        if (!item) return;
        hits[item] = (hits[item] || 0) + 1;
      });
    });
    return Object.entries(hits)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([text, count]) => ({ text, count }));
  }

  function repeatedPhrases(entries, field, minCount) {
    const bag = [];
    (entries || []).forEach((entry) => {
      const s = entry && entry.snapshot;
      if (!s) return;
      (s[field] || []).forEach((x) => bag.push(x));
    });
    return tokenizePhrases(bag).filter((x) => x.count >= (minCount || 2));
  }

  function chipList(opts, key) {
    const raw = opts && opts[key];
    return Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : [];
  }

  /**
   * @returns {{
   *   total:number, recommend:number, eliminate:number,
   *   agree:number, overRecommend:number, underRecommend:number,
   *   topConcerns:Array<{text:string,count:number}>,
   *   topHighlights:Array<{text:string,count:number}>,
   *   topSignals:Array<{text:string,count:number}>,
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
    const focusKeywords = chipList(options, 'focusKeywords');
    const bonusKeywords = chipList(options, 'bonusKeywords');

    let recommend = 0;
    let eliminate = 0;
    let agree = 0;
    let overRecommend = 0;
    let underRecommend = 0;
    const overEntries = [];
    const underEntries = [];
    const concernBag = [];
    const highlightBag = [];
    const eliminateEntries = [];

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
        eliminateEntries.push(entry);
        (s.concerns || []).forEach((c) => concernBag.push(c));
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
    const unmetGates = countNormalizedMissing(eliminateEntries);
    const unmetBonus = tokenizePhrases(
      overEntries.concat(eliminateEntries).flatMap((entry) => {
        const rows = (entry.snapshot && entry.snapshot.bonusKeywordResults) || [];
        return rows.filter((r) => r && r.item && !r.met).map((r) => r.item);
      })
    );
    const topSignals = [];
    function pushSignals(list) {
      (list || []).forEach((item) => {
        if (topSignals.length >= 3) return;
        if (topSignals.some((s) => s.text === item.text)) return;
        if (!item.text || item.count < 1) return;
        topSignals.push({ text: item.text, count: item.count });
      });
    }
    pushSignals(unmetGates);
    pushSignals(topConcerns);
    pushSignals(unmetBonus);

    const actionable = [];
    const infos = [];

    if (total > 0 && total < MIN_DECISIONS_FOR_SUGGEST) {
      infos.push({
        id: 'need-more',
        type: 'info',
        title: '样本还少',
        detail: '已决策 ' + total + ' 条，满 ' + MIN_DECISIONS_FOR_SUGGEST + ' 条后给出规则建议。',
        apply: null
      });
    } else if (total === 0) {
      infos.push({
        id: 'empty',
        type: 'info',
        title: '暂无决策可复盘',
        detail: '对本岗点「推荐 / 淘汰」后，这里会统计你与插件的异同，并给出可编辑后采纳的规则调整。',
        apply: null
      });
    } else {
      unmetGates.filter((g) => g.count >= 2).slice(0, 2).forEach((g) => {
        actionable.push({
          id: 'gate-' + g.text,
          type: 'addGate',
          title: '加入专业及其他门槛',
          detail: '淘汰记录中出现 ' + g.count + ' 次，可改成更短的门槛表述后再保存。',
          editableValue: g.text,
          apply: { customGate: g.text }
        });
      });

      if (overRecommend >= MIN_MISMATCH_FOR_RULE) {
        const overPassed = overEntries.filter((e) => gatesPassed(e.snapshot));
        const focusHits = repeatedPhrases(overPassed, 'concerns', 2);
        if (focusHits.length) {
          const item = focusHits[0].text;
          if (focusKeywords.length >= 6) {
            infos.push({
              id: 'focus-full',
              type: 'info',
              title: '重点看已满',
              detail: '分歧里反复出现「' + item + '」，请先删一条重点看再采纳。',
              apply: null
            });
          } else if (!focusKeywords.includes(item)) {
            actionable.push({
              id: 'focus-' + item,
              type: 'addFocus',
              title: '加入重点看',
              detail: '插件推你却淘汰 ' + overRecommend + ' 人，反复提到「' + item
                + '」。写入重点看后，相邻经历也不应只因字面缺失打穿 50。',
              editableValue: item,
              apply: { focusKeyword: item }
            });
          }
        }

        const promoted = overEntries.filter((e) => e.snapshot && e.snapshot.bonusPromoted);
        if (promoted.length >= 2) {
          const metBonus = tokenizePhrases(
            promoted.flatMap((e) => {
              const rows = (e.snapshot && e.snapshot.bonusKeywordResults) || [];
              return rows.filter((r) => r && r.met && r.item).map((r) => r.item);
            })
          );
          if (metBonus.length) {
            const item = metBonus[0].text;
            actionable.push({
              id: 'drop-bonus-' + item,
              type: 'dropBonus',
              title: '从加分看去掉「' + item + '」',
              detail: '有 ' + promoted.length + ' 人因加分晋级被插件推进，但你淘汰了。加分看不能改变不建议推进，却可能把可推进送进优先。',
              editableValue: item,
              apply: { removeBonus: item }
            });
          }
        }
      }

      if (underRecommend >= MIN_MISMATCH_FOR_RULE) {
        const underBlocked = underEntries.filter((e) => !gatesPassed(e.snapshot));
        const underGates = countNormalizedMissing(underBlocked).filter((g) => g.count >= 2);
        if (underGates.length) {
          const g = underGates[0];
          if (isStructuredGateLabel(g.text)) {
            infos.push({
              id: 'structured-gate',
              type: 'info',
              title: '核对下拉门槛',
              detail: '你推的人里有 ' + g.count + ' 人卡在「' + g.text
                + '」，请到硬性门槛里核对。插件不会自动改学历 / 学校 / 年龄等下拉条件。',
              apply: null
            });
          } else {
            actionable.push({
              id: 'relax-' + g.text,
              type: 'relaxGate',
              title: '放宽门槛「' + g.text + '」',
              detail: '你推但插件因门槛卡住 ' + underRecommend + ' 人，其中「' + g.text
                + '」反复出现。采纳后从语言或专业及其他中删除该项。',
              editableValue: g.text,
              apply: { removeGate: g.text }
            });
          }
        }

        const underMatchOk = underEntries.filter((e) => {
          const s = e.snapshot || {};
          if (!gatesPassed(s)) return false;
          const match = Number(s.matchScore);
          if (Number.isFinite(match) && match < 50) return false;
          return (s.bonusMetCount || 0) === 0;
        });
        const bonusHits = repeatedPhrases(underMatchOk, 'highlights', 2);
        if (bonusHits.length && bonusKeywords.length < 5) {
          const item = bonusHits[0].text;
          if (!bonusKeywords.includes(item)) {
            actionable.push({
              id: 'add-bonus-' + item,
              type: 'addBonus',
              title: '加入加分看',
              detail: '你推但插件未推的人里反复出现「' + item
                + '」。只作为加分，不能把经历匹配低于 50 的人救出。',
              editableValue: item,
              apply: { bonusKeyword: item }
            });
          }
        }
      }

      if (!actionable.length && !infos.length) {
        infos.push({
          id: 'aligned',
          type: 'info',
          title: '判断较一致',
          detail: '暂无明显系统性偏差。也可在下方自行新增门槛或重点看并保存。',
          apply: null
        });
      }
    }

    const suggestions = actionable.slice(0, 4).concat(infos.slice(0, 2));

    return {
      total,
      recommend,
      eliminate,
      agree,
      overRecommend,
      underRecommend,
      topConcerns,
      topHighlights,
      topSignals,
      suggestions,
      summary: total
        ? ('已决策 ' + total + ' · 推荐 ' + recommend + ' · 淘汰 ' + eliminate)
        : '暂无决策'
    };
  }

  const api = {
    MIN_DECISIONS_FOR_SUGGEST,
    MIN_MISMATCH_FOR_RULE,
    tokenizePhrases,
    normalizeMustHaveLabel,
    isStructuredGateLabel,
    buildCalibrationReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaCalibrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
