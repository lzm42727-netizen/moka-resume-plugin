/**
 * 本岗决策复盘与可执行校准建议（popup / Node 测试共用）
 *
 * 第一批（1.9.2）：信号归一化聚合 + score-drift 诊断 + confidence + 文案强化 + dropBonus 收紧。
 * 设计见 docs/superpowers/specs/2026-09-10-calibration-signal-quality-design.md
 */
(function (root) {
  const MIN_DECISIONS_FOR_SUGGEST = 5;
  const MIN_MISMATCH_FOR_RULE = 3;
  const STRUCTURED_GATE_RE = /学历|学校|院校|年龄|性别|工作年限|经验年限/;

  // ---- 信号归一化（规则保守，只做三类） ----

  /** 展示前缀「缺 / 缺少 / 未满足」：同样是缺失标记（负向先行，别吞掉「缺乏」） */
  const GAP_PREFIX_RE = /^(缺少|未满足|缺(?!乏))[:：\s]*/;
  /** A 否定前缀：判定「缺失」极性并剥离（长词在前） */
  const NEG_PREFIX_RE = /^(未具备|未满足|未达到|不具备|没有|缺少|缺乏|欠缺|不足|无)/;
  /** B 结果后缀：结尾的否定式结果动词（长词在前）。不含「经验」等名词，故 `项目经验不足` → `项目经验` */
  const NEG_SUFFIX_RE = /(匮乏|欠缺|缺失|不足|不够|较少|偏少|较弱|较差)$/;
  /** 正向开头：只用于区分 direction（不参与归并） */
  const POSITIVE_PREFIX_RE = /^(有|具备|拥有|熟悉|精通|擅长|丰富|较强)/;
  /** 剥离否定前缀后才清理的量词/虚词尾巴（仅前缀型；后缀型保留，如 `项目经验不足` → `项目经验`） */
  const TRAILING_NOUN_RE = /(经验|经历|背景|能力)$/;
  /** 归一后只剩虚词 → 视为无效信号 */
  const GENERIC_ONLY_RE = /^(经验|经历|能力|资源|背景|技能|知识|学历|证书)$/;
  /** C 极小同义词表：只写死确定几组，不做自由语义推断、不做 embedding */
  const SIGNAL_SYNONYMS = [
    [/KOL/g, '达人'],
    [/达人营销/g, '达人合作'],
    [/达人资源/g, '达人合作'],
    [/海外市场/g, '海外'],
    [/主播资源/g, '主播']
  ];

  /** 只剥「」『』""'' 类引号，不碰语义前缀 */
  function stripSignalQuotes(raw) {
    let t = String(raw || '').trim();
    if (!t) return '';
    let m;
    while ((m = t.match(/[「『"']([^「『」』"']+)[」』"']/))) t = m[1].trim();
    return t;
  }

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

  /** 去掉「缺」「未满足」等展示前缀与嵌套引号，得到干净文案 */
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

  function applySignalSynonyms(text) {
    let t = String(text || '');
    SIGNAL_SYNONYMS.forEach((rule) => {
      t = t.replace(rule[0], rule[1]);
    });
    return t;
  }

  /**
   * 把一条自由文本归一成可比对的信号。
   *
   * 方向保护：先判否定极性再剥前缀；`有达人合作经验`(neutral) 与 `无达人合作经验`(lack)
   * 的 core / polarity 都不同，绝不归并。`项目经验丰富`(neutral) 不会被当成 `项目经验`(lack)。
   *
   * @param {string} raw
   * @returns {{core:string, polarity:'lack'|'neutral', direction:'lack'|'have'|'neutral'}|null}
   */
  function normalizeCalibrationSignal(raw) {
    let t = String(raw || '').trim();
    if (!t) return null;

    let polarity = 'neutral';
    let direction = 'neutral';
    let markKind = null;

    // 展示前缀（缺 / 缺少 / 未满足）必须在剥引号之前判定，否则会丢掉极性
    const gap = t.match(GAP_PREFIX_RE);
    if (gap) {
      t = t.slice(gap[0].length).trim();
      polarity = 'lack';
      direction = 'lack';
      markKind = 'prefix';
    }

    t = stripSignalQuotes(t);
    if (!t || t.length < 2) return null;

    if (!markKind) {
      const pre = t.match(NEG_PREFIX_RE);
      if (pre) {
        t = t.slice(pre[0].length).trim();
        polarity = 'lack';
        direction = 'lack';
        markKind = 'prefix';
      }
    }
    if (!markKind) {
      const suf = t.match(NEG_SUFFIX_RE);
      if (suf) {
        t = t.slice(0, t.length - suf[0].length).trim();
        polarity = 'lack';
        direction = 'lack';
        markKind = 'suffix';
      }
    }
    if (!markKind && POSITIVE_PREFIX_RE.test(t)) direction = 'have';

    t = applySignalSynonyms(t);
    // 仅前缀型清尾巴：`缺少达人合作经验` → `达人合作`；后缀型保留：`项目经验不足` → `项目经验`
    if (markKind === 'prefix') {
      t = t.replace(TRAILING_NOUN_RE, '').trim();
      t = applySignalSynonyms(t).trim();
    }
    if (!t || t.length < 2 || GENERIC_ONLY_RE.test(t)) return null;
    return { core: t.slice(0, 40), polarity, direction };
  }

  /**
   * 按「极性 + 归一文案」聚合同类信号，解决同一含义多种措辞各自 count=1 被淹没的问题。
   *
   * @param {string[]} list
   * @param {number} [minCount] 只返回出现次数 ≥ 该值的信号
   * @returns {Array<{text:string,count:number,variants:string[],polarity:string}>}
   */
  function groupCalibrationSignals(list, minCount) {
    const buckets = new Map();
    (list || []).forEach((raw) => {
      const sig = normalizeCalibrationSignal(raw);
      if (!sig) return;
      const key = sig.polarity + '\u0000' + sig.core;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { text: sig.core, count: 0, variants: [], polarity: sig.polarity };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const origin = String(raw || '').trim();
      if (origin && bucket.variants.indexOf(origin) === -1) bucket.variants.push(origin);
    });
    const out = Array.from(buckets.values()).sort(
      (a, b) => b.count - a.count || a.text.localeCompare(b.text, 'zh')
    );
    const min = Number(minCount) || 0;
    return min > 0 ? out.filter((x) => x.count >= min) : out;
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
    const bag = [];
    (entries || []).forEach((entry) => {
      const missing = (entry && entry.snapshot && entry.snapshot.hardMissing) || [];
      missing.forEach((raw) => bag.push(raw));
    });
    return groupCalibrationSignals(bag);
  }

  function repeatedPhrases(entries, field, minCount) {
    const bag = [];
    (entries || []).forEach((entry) => {
      const s = entry && entry.snapshot;
      if (!s) return;
      (s[field] || []).forEach((x) => bag.push(x));
    });
    return groupCalibrationSignals(bag, minCount || 2);
  }

  function chipList(opts, key) {
    const raw = opts && opts[key];
    return Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : [];
  }

  /**
   * 建议置信度：样本量 × 信号集中度 × 因果是否明确。
   * @param {number} count 同一信号出现次数
   * @param {number} total 本岗已决策数
   * @param {boolean} causal 是否有明确因果（hardMissing / gate 阻断 / bonusPromoted）
   */
  function scoreConfidence(count, total, causal) {
    const c = Number(count) || 0;
    const t = Number(total) || 0;
    if (t >= 10 && c >= 5 && causal) return 'high';
    if (t >= 5 && c >= 2) return 'medium';
    if (causal && t >= 5 && t < 10) return 'medium';
    return 'low';
  }

  /** score-drift：插件系统性偏严 / 偏宽（只诊断，永不 apply） */
  function computeScoreDrift(underEntries, overEntries) {
    const strictCount = (underEntries || []).filter((entry) => {
      const s = (entry && entry.snapshot) || {};
      if (!gatesPassed(s)) return false;
      const match = Number(s.matchScore);
      return Number.isFinite(match) && match < 50;
    }).length;
    const lenientCount = (overEntries || []).filter((entry) =>
      gatesPassed((entry && entry.snapshot) || {})
    ).length;

    if (strictCount >= MIN_MISMATCH_FOR_RULE && strictCount >= lenientCount) {
      return { direction: 'strict', count: strictCount };
    }
    if (lenientCount >= MIN_MISMATCH_FOR_RULE) {
      return { direction: 'lenient', count: lenientCount };
    }
    return { direction: 'none', count: 0 };
  }

  function buildScoreDriftInfo(drift) {
    const confidence = drift.count >= 5 ? 'medium' : 'low';
    if (drift.direction === 'strict') {
      return {
        id: 'drift-strict',
        type: 'info',
        title: '插件判定可能偏严',
        detail:
          '你连续推荐了 ' +
          drift.count +
          ' 位匹配度偏低、但没被硬性门槛拦住的候选人。可能是「岗位理解」把职责收得太窄，' +
          '或「重点看」漏了这类经历。建议到上方核对岗位理解与重点看文案。',
        apply: null,
        confidence,
        evidence: { count: drift.count, variants: [] }
      };
    }
    return {
      id: 'drift-lenient',
      type: 'info',
      title: '插件判定可能偏宽',
      detail:
        '你连续淘汰了 ' +
        drift.count +
        ' 位插件认为匹配度不低、也没有门槛问题的候选人。可能是岗位职责理解过宽，' +
        '或缺少真正在意的一票否决项。建议在下方新增「重点看」并写明真正在意的点。',
      apply: null,
      confidence,
      evidence: { count: drift.count, variants: [] }
    };
  }

  /**
   * @returns {{
   *   total:number, recommend:number, eliminate:number,
   *   agree:number, overRecommend:number, underRecommend:number,
   *   topConcerns:Array<{text:string,count:number,variants:string[],polarity:string}>,
   *   topHighlights:Array<{text:string,count:number,variants:string[],polarity:string}>,
   *   topSignals:Array<{text:string,count:number,variants:string[]}>,
   *   suggestions:Array<object>,
   *   diagnostics:{scoreDrift:{direction:'strict'|'lenient'|'none',count:number}},
   *   summary:string
   * }}
   */
  function buildCalibrationReport(record, jobId, opts) {
    const feedback = root.MokaFeedback || (typeof require !== 'undefined' ? require('./feedback.js') : null);
    const bag = feedback
      ? feedback.getFeedbackForJob(record, jobId)
      : {};
    // 近期优先：只影响并列时的先后（不做时间衰减权重，不改阈值语义）
    const entries = Object.values(bag || {}).sort(
      (a, b) => (Number(b && b.updatedAt) || 0) - (Number(a && a.updatedAt) || 0)
    );
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
    const topConcerns = groupCalibrationSignals(concernBag).slice(0, 5);
    const topHighlights = groupCalibrationSignals(highlightBag).slice(0, 5);
    const unmetGates = countNormalizedMissing(eliminateEntries);
    const unmetBonus = groupCalibrationSignals(
      overEntries.concat(eliminateEntries).flatMap((entry) => {
        const rows = (entry.snapshot && entry.snapshot.bonusKeywordResults) || [];
        return rows.filter((r) => r && r.item && !r.met).map((r) => r.item);
      })
    );
    const scoreDrift = computeScoreDrift(underEntries, overEntries);

    const topSignals = [];
    function pushSignals(list) {
      (list || []).forEach((item) => {
        if (topSignals.length >= 3) return;
        if (topSignals.some((s) => s.text === item.text)) return;
        if (!item.text || item.count < 1) return;
        topSignals.push({ text: item.text, count: item.count, variants: item.variants || [] });
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
          detail:
            '淘汰记录中出现 ' +
            g.count +
            ' 次，可改成更短的门槛表述后再保存。注意：写成硬性门槛后，会直接拦截没有该项证据的候选人；' +
            '请确认它是真正的一票否决条件，而不只是偏好。',
          editableValue: g.text,
          apply: { customGate: g.text },
          confidence: scoreConfidence(g.count, total, true),
          evidence: { count: g.count, variants: g.variants || [] }
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
              detail:
                '插件推你却淘汰 ' +
                overRecommend +
                ' 人，反复提到「' +
                item +
                '」。加入重点看后按相邻经历与语义相关证据判断，' +
                '不要求简历出现完全相同的关键词。',
              editableValue: item,
              apply: { focusKeyword: item },
              confidence: scoreConfidence(focusHits[0].count, total, false),
              evidence: { count: focusHits[0].count, variants: focusHits[0].variants || [] }
            });
          }
        }

        const promoted = overEntries.filter((e) => e.snapshot && e.snapshot.bonusPromoted);
        if (promoted.length >= 2) {
          const metBonus = groupCalibrationSignals(
            promoted.flatMap((e) => {
              const rows = (e.snapshot && e.snapshot.bonusKeywordResults) || [];
              return rows.filter((r) => r && r.met && r.item).map((r) => r.item);
            })
          );
          const topBonus = metBonus[0];
          if (topBonus && topBonus.count >= 2) {
            actionable.push({
              id: 'drop-bonus-' + topBonus.text,
              type: 'dropBonus',
              title: '从加分看去掉「' + topBonus.text + '」',
              detail:
                '该加分项曾把 ' +
                topBonus.count +
                ' 人送进推进档，但你把他们淘汰了。加分看不能改变不建议推进，却可能把可推进送进优先。',
              editableValue: topBonus.text,
              apply: { removeBonus: topBonus.text },
              confidence: scoreConfidence(topBonus.count, total, true),
              evidence: { count: topBonus.count, variants: topBonus.variants || [] }
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
              apply: { removeGate: g.text },
              confidence: scoreConfidence(g.count, total, true),
              evidence: { count: g.count, variants: g.variants || [] }
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
              apply: { bonusKeyword: item },
              confidence: scoreConfidence(bonusHits[0].count, total, false),
              evidence: { count: bonusHits[0].count, variants: bonusHits[0].variants || [] }
            });
          }
        }
      }

      // score-drift 诊断：只在有方向时输出，永不 apply；用于替代误导性的「判断较一致」
      if (scoreDrift.direction !== 'none') {
        infos.push(buildScoreDriftInfo(scoreDrift));
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
      diagnostics: { scoreDrift },
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
    normalizeCalibrationSignal,
    groupCalibrationSignals,
    isStructuredGateLabel,
    buildCalibrationReport
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaCalibrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
