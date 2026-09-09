/**
 * LLM 缓存持久化、筛选结果瘦身与 CSV 导出（background / content / Node 测试共用）
 */
(function (root) {
  const LLM_CACHE_STORAGE_KEY = 'mokaLlmCache';
  const LLM_CACHE_LIMIT = 500;
  const LLM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const LAST_SCREENING_PREFIX = 'mokaLastScreening:';
  /** 详情页 URL 无 pipelineId 时，仍可从该键恢复最近一次筛选 */
  const LAST_ACTIVE_SCREENING_KEY = 'mokaLastScreening:active';
  const JOB_PRESET_STORAGE_KEY = 'mokaJobPresets';
  const JOB_PRESET_LIMIT = 80;
  const JOB_PRESET_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const PRESET_WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];

  const SCREENING_CSV_HEADERS = [
    '姓名', '学历', '学校', '决策分', '经历匹配', '档位',
    '未过门槛', '亮点', '差距', '反馈', '同步状态', '决策时间', '链接'
  ];

  function feedbackCsvLabel(verdict) {
    if (verdict === 'positive') return '推荐给用人部门';
    if (verdict === 'negative') return '淘汰';
    if (verdict === 'recommend') return '推荐给用人部门';
    if (verdict === 'eliminate') return '淘汰';
    return '';
  }

  function feedbackSyncLabel(state) {
    if (state === 'synced') return '已同步';
    if (state === 'failed') return '同步失败';
    if (state === 'pending') return '待同步';
    // 非已决策导出（普通筛选结果）无同步状态，留空而非「未同步」以免误导
    return '';
  }

  function csvTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function stableHash(input) {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
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

  function pruneTimedMap(record, now, ttlMs, limit) {
    const entries = Object.entries(record || {}).filter(([, v]) => (
      v && typeof v.savedAt === 'number' && (now - v.savedAt) < ttlMs
    ));
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    return Object.fromEntries(entries);
  }

  function putCacheRecord(record, key, value, now, ttlMs, limit) {
    const next = Object.assign({}, record || {});
    next[key] = { value, savedAt: now };
    return pruneTimedMap(next, now, ttlMs, limit);
  }

  function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  }

  function screeningItemToRow(item, origin, feedbackVerdict) {
    const app = (item && item.app) || {};
    const score = (item && item.score) || {};
    const raw = (item && item.rawScore) || {};
    const base = String(origin || '').replace(/\/+$/, '');
    const unmet = Array.isArray(score.unmet)
      ? score.unmet.map((gate) => gate && gate.item).filter(Boolean)
      : [];
    if (!unmet.length) {
      const hard = (item && item.hard) || {};
      (Array.isArray(hard.missing) ? hard.missing : []).forEach((gate) => unmet.push(gate));
    }
    return [
      app.name || '',
      app.highestDegree || '',
      app.highestDegreeSchool || '',
      score.score != null ? score.score : '',
      score.matchScore != null ? score.matchScore : '',
      score.level || '',
      unmet.join('；'),
      Array.isArray(raw.highlights) ? raw.highlights.join('；') : '',
      Array.isArray(raw.concerns) ? raw.concerns.join('；') : '',
      feedbackCsvLabel(feedbackVerdict),
      feedbackSyncLabel(item && item.feedbackSync),
      csvTime(item && item.decidedAt),
      app.id != null ? `${base}/candidates/application/${app.id}` : ''
    ];
  }

  function screeningToCsv(items, origin, feedbackByAppId) {
    const map = feedbackByAppId && typeof feedbackByAppId === 'object' ? feedbackByAppId : {};
    const rows = [SCREENING_CSV_HEADERS];
    (items || []).forEach((item) => {
      const appId = item && item.app && item.app.id != null ? String(item.app.id) : '';
      rows.push(screeningItemToRow(item, origin, map[appId]));
    });
    return toCsv(rows);
  }

  function slimScreeningItem(item) {
    const app = (item && item.app) || {};
    const waived = item && item.waivedMustHaves;
    const waivedArr = waived instanceof Set ? Array.from(waived) : (Array.isArray(waived) ? waived : []);
    const raw = item && item.rawScore;
    return {
      app: {
        id: app.id,
        candidateId: app.candidateId,
        name: app.name,
        highestDegree: app.highestDegree,
        highestDegreeSchool: app.highestDegreeSchool,
        specialities: app.specialities
      },
      hard: (item && item.hard) || null,
      hardLocal: (item && item.hardLocal) || null,
      score: (item && item.score) || null,
      rawScore: raw ? {
        dimensions: raw.dimensions,
        matchScore: raw.matchScore,
        handwrittenGateResults: raw.handwrittenGateResults || [],
        bonusKeywordResults: raw.bonusKeywordResults || [],
        experienceEvidence: raw.experienceEvidence || [],
        highlights: raw.highlights || [],
        concerns: raw.concerns || [],
        mustHaveResults: raw.mustHaveResults || [],
        parseError: raw.parseError,
        error: raw.error
      } : null,
      waivedMustHaves: waivedArr,
      keywords: (item && item.keywords) || null,
      graduationRisk: (item && item.graduationRisk) || null
    };
  }

  function hydrateScreeningItem(slim) {
    const item = slim || {};
    return {
      app: item.app || {},
      hard: item.hard || null,
      hardLocal: item.hardLocal || null,
      score: item.score || null,
      rawScore: item.rawScore || null,
      waivedMustHaves: new Set(item.waivedMustHaves || []),
      keywords: item.keywords || null,
      graduationRisk: item.graduationRisk || null
    };
  }

  function lastScreeningStorageKey(pipelineId) {
    return LAST_SCREENING_PREFIX + String(pipelineId || 'unknown');
  }

  function resultContextKey(pipelineId, jobId) {
    const pid = String(pipelineId == null ? '' : pipelineId).trim() || 'unknown';
    const jid = String(jobId == null ? '' : jobId).trim() || 'unknown';
    return pid + ':' + jid;
  }

  function screeningPayloadJobId(payload) {
    const cfg = payload && payload.screenConfig;
    return cfg && cfg.jobId != null ? String(cfg.jobId).trim() : '';
  }

  function screeningPayloadMatchesJob(payload, jobId) {
    const want = String(jobId == null ? '' : jobId).trim();
    if (!want || want === 'current') return true;
    const got = screeningPayloadJobId(payload);
    return got === want;
  }

  function jobPresetKey(jobId) {
    return String(jobId == null ? '' : jobId).trim();
  }

  function stringList(arr, limit) {
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, limit);
  }

  function isDuplicateDegreeGate(item, degree) {
    const text = String(item || '').replace(/\s+/g, '');
    const selected = String(degree || '').trim();
    if (!text || !selected) return false;
    return text.includes(selected) && /(学历|大专|专科|本科|硕士|研究生|博士)/.test(text);
  }

  function isDuplicateStructuredGate(item, hard, ageRangeValues) {
    const text = String(item || '').replace(/\s+/g, '');
    const hc = hard || {};
    if (!text) return false;
    if (isDuplicateDegreeGate(text, hc.degree)) return true;
    if (hc.gender && (
      text === hc.gender
      || text === '性别' + hc.gender
      || text === '仅限' + hc.gender
      || text === hc.gender + '性'
    )) return true;
    const expPatterns = {
      fresh: /在校|应届/,
      '1-3': /1[-~～到至]3年|一至三年/,
      '3-5': /3[-~～到至]5年|三至五年/,
      '5+': /5年(?:及)?以上|五年(?:及)?以上/
    };
    if (hc.exp && expPatterns[hc.exp] && expPatterns[hc.exp].test(text) && text.length <= 12) return true;
    if (Array.isArray(hc.schools) && hc.schools.some((school) => (
      text === school || text === school + '院校' || text === school + '学校'
    ))) return true;
    if (Array.isArray(ageRangeValues) && ageRangeValues.length && /年龄|岁/.test(text)) return true;
    if (hc.internship === 'required' && /^(?:需|需要|要求)?(?:相关)?实习经验$/.test(text)) return true;
    return false;
  }

  function looksLikeLanguageGate(item) {
    return /(日语|英语|法语|德语|韩语|西班牙语|俄语|葡萄牙语|阿拉伯语|雅思|托福|CET|JLPT|\bN[1-5]\b)/i
      .test(String(item || ''));
  }

  function appendUniqueLimited(target, items, limit) {
    const out = target.slice(0, limit);
    (items || []).forEach((item) => {
      const text = String(item || '').trim();
      if (text && out.length < limit && out.indexOf(text) === -1) out.push(text);
    });
    return out;
  }

  function sanitizeJobPreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const hardIn = raw.hard && typeof raw.hard === 'object' ? raw.hard : (raw.hardConditions || {});
    const ageRangeValues = Array.isArray(hardIn.ageRangeValues)
      ? stringList(hardIn.ageRangeValues, 8)
      : stringList((hardIn.ageRanges || []).map((r) => r && r.label), 8);
    const weightsIn = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
    const weights = {};
    PRESET_WEIGHT_KEYS.forEach((k) => {
      const n = Number(weightsIn[k]);
      weights[k] = Number.isFinite(n) ? n : 0;
    });
    let jobSpec = null;
    if (raw.jobSpec && typeof raw.jobSpec === 'object') {
      jobSpec = {
        summary: String(raw.jobSpec.summary || ''),
        languages: stringList(raw.jobSpec.languages, 6),
        customGates: stringList(raw.jobSpec.customGates, 6),
        focusKeywords: stringList(raw.jobSpec.focusKeywords, 6),
        bonusKeywords: stringList(raw.jobSpec.bonusKeywords, 5),
        mustHaves: stringList(raw.jobSpec.mustHaves, 6),
        importantHaves: stringList(raw.jobSpec.importantHaves, 6),
        resumeKeywords: stringList(raw.jobSpec.resumeKeywords, 6),
        niceToHaves: stringList(raw.jobSpec.niceToHaves, 5),
        responsibilities: stringList(raw.jobSpec.responsibilities, 12),
        coreSkills: stringList(raw.jobSpec.coreSkills, 6),
        candidateTraits: stringList(raw.jobSpec.candidateTraits, 6),
        suggestedWeights: raw.jobSpec.suggestedWeights && typeof raw.jobSpec.suggestedWeights === 'object'
          ? raw.jobSpec.suggestedWeights
          : null,
        // 这份理解是从哪个职位的 JD 读出来的；下次打开要拿它跟所选职位对一遍
        sourceJobId: String(raw.jobSpec.sourceJobId || ''),
        sourceJobName: String(raw.jobSpec.sourceJobName || '')
      };
    }
    const requirements = normalizeRequirements(raw);
    let languages = stringList(hardIn.languages, 6);
    let customGates = stringList(hardIn.customGates, 6);
    requirements.must.forEach((item) => {
      if (isDuplicateStructuredGate(item, hardIn, ageRangeValues)) return;
      if (looksLikeLanguageGate(item)) {
        languages = appendUniqueLimited(languages, [item], 6);
      } else {
        customGates = appendUniqueLimited(customGates, [item], 6);
      }
    });
    const focusKeywords = Array.isArray(raw.focusKeywords)
      ? stringList(raw.focusKeywords, 6)
      : requirements.important.slice();
    const bonusKeywords = Array.isArray(raw.bonusKeywords)
      ? stringList(raw.bonusKeywords, 5)
      : stringList(requirements.nice, 5);
    const migratedRequirements = {
      must: [],
      important: requirements.important.slice(),
      nice: requirements.nice.slice()
    };
    // 职位身份锚点（恢复兜底用）：优先取保存时侧栏盖的顶层锚，
    // 老存档没有顶层锚时回退到 jobSpec 的来源戳；两条都没有就留空。
    // 顶层锚的意义：纯手配门槛/关键词、从未「按 JD 刷新」的存档没有 jobSpec，
    // 但同样需要在页面 jobId 漂移时按职位名找回。
    const anchorId = jobPresetKey(raw.jobIdAnchor || (jobSpec && jobSpec.sourceJobId));
    const anchorName = String(raw.jobNameAnchor || (jobSpec && jobSpec.sourceJobName) || '').trim();
    return {
      jobType: raw.jobType === 'intern' ? 'intern' : 'full-time',
      jobIdAnchor: anchorId,
      jobNameAnchor: anchorName,
      // 本岗分配对象在配置页被确认的时间；0 = 尚未确认（批量推进前置确认用）
      assigneeConfirmedAt: Number(raw.assigneeConfirmedAt) || 0,
      hard: {
        degree: String(hardIn.degree || ''),
        schools: stringList(hardIn.schools, 8),
        exp: String(hardIn.exp || ''),
        gender: String(hardIn.gender || ''),
        internship: String(hardIn.internship || ''),
        ageRangeValues,
        languages,
        customGates
      },
      weights,
      // 兼容旧字段：与 requirements.must 同步
      mustHaves: [],
      requirements: migratedRequirements,
      focusKeywords,
      bonusKeywords,
      jobUnderstanding: String(raw.jobUnderstanding || (jobSpec && jobSpec.summary) || '').slice(0, 2000),
      // keywords 已迁移进 requirements.important，不再单独落盘
      keywords: [],
      jobSpec
    };
  }

  /** 旧 mustHaves → must；旧 keywords → important；important/nice 可空 */
  function normalizeRequirements(raw) {
    const src = raw && raw.requirements && typeof raw.requirements === 'object'
      ? raw.requirements
      : {};
    let must = stringList(src.must, 6);
    if (!must.length) must = stringList(raw && raw.mustHaves, 6);
    let important = stringList(src.important, 6);
    // 简历关键词已并入重要：迁移旧 preset.keywords
    stringList(raw && raw.keywords, 6).forEach((k) => {
      if (important.length >= 6) return;
      if (must.indexOf(k) === -1 && important.indexOf(k) === -1) important.push(k);
    });
    return {
      must,
      important,
      nice: stringList(src.nice, 5)
    };
  }

  function appendUnique(target, items, must, limit) {
    const out = target.slice();
    (items || []).forEach((k) => {
      const t = String(k || '').trim();
      if (!t || out.length >= limit) return;
      if (must.indexOf(t) === -1 && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }

  /**
   * 若 important/nice 为空，用 JD jobSpec 补全（有则填、无则空）。
   * 空 important：importantHaves + coreSkills + resumeKeywords + candidateTraits
   * 空 nice：niceToHaves + candidateTraits（素质进加分，招聘官可再调）
   */
  function fillRequirementsFromJobSpec(requirements, jobSpec) {
    const base = normalizeRequirements({ requirements: requirements || {}, mustHaves: (requirements && requirements.must) || [] });
    const spec = jobSpec && typeof jobSpec === 'object' ? jobSpec : {};
    let important = base.important.slice();
    if (!base.important.length) {
      important = appendUnique([], stringList(spec.importantHaves, 6), base.must, 6);
      important = appendUnique(important, stringList(spec.coreSkills, 6), base.must, 6);
      important = appendUnique(important, stringList(spec.resumeKeywords, 6), base.must, 6);
      important = appendUnique(important, stringList(spec.candidateTraits, 6), base.must, 6);
    }
    let nice = base.nice.slice();
    if (!base.nice.length) {
      nice = appendUnique([], stringList(spec.niceToHaves, 5), base.must, 5);
      nice = appendUnique(nice, stringList(spec.candidateTraits, 6), base.must, 5);
    }
    const must = base.must.length ? base.must : stringList(spec.mustHaves, 6);
    return { must, important, nice };
  }

  /**
   * 按 JD 整表生成三栏（忽略已有芯片）。用于换岗同步 /「按 JD 刷新」，避免上一岗残留。
   */
  function buildRequirementsFromJobSpec(jobSpec) {
    const spec = jobSpec && typeof jobSpec === 'object' ? jobSpec : {};
    const must = stringList(spec.mustHaves, 6);
    let important = appendUnique([], stringList(spec.importantHaves, 6), must, 6);
    important = appendUnique(important, stringList(spec.coreSkills, 6), must, 6);
    important = appendUnique(important, stringList(spec.resumeKeywords, 6), must, 6);
    important = appendUnique(important, stringList(spec.candidateTraits, 6), must, 6);
    let nice = appendUnique([], stringList(spec.niceToHaves, 5), must, 5);
    nice = appendUnique(nice, stringList(spec.candidateTraits, 6), must, 5);
    return { must, important, nice };
  }

  const JOB_SPEC_CONTENT_FIELDS = [
    'responsibilities', 'coreSkills', 'candidateTraits',
    'mustHaves', 'importantHaves', 'niceToHaves', 'resumeKeywords'
  ];

  /**
   * 这次 JD 解读是否真的带回了岗位内容。
   * 模型解析失败时 background 会回一个「字段全空 + parseError」的壳，
   * 若把它当成成功，界面会显示空理解，还会把表单清单整表覆盖成空并落盘。
   */
  function jobSpecIsUsable(spec) {
    if (!spec || typeof spec !== 'object') return false;
    if (spec.parseError) return false;
    if (String(spec.summary || '').trim()) return true;
    return JOB_SPEC_CONTENT_FIELDS.some((k) => stringList(spec[k], 12).length > 0);
  }

  /**
   * 这份岗位理解是不是当前所选职位的。
   * 解读 JD 时会盖上来源职位；老存档没有盖章，判不出来就按「是」处理，
   * 免得把招聘官手配的门槛/关键词误清。
   */
  function jobSpecMatchesJob(spec, jobId) {
    if (!spec || typeof spec !== 'object') return true;
    const source = jobPresetKey(spec.sourceJobId);
    const target = jobPresetKey(jobId);
    if (!source || !target) return true;
    return source === target;
  }

  /**
   * 岗位理解展示：做什么 + 需要具备（能力句由 JD 字段拼出，不单靠模型 summary）
   * 返回 { duty, skills }；skills 为空字符串表示暂无
   */
  function formatJobUnderstandingParts(spec, fallback) {
    const s = spec && typeof spec === 'object' ? spec : {};
    let duty = String(s.summary || '').trim().replace(/^岗位理解[：:]\s*/, '');
    let skillsFromSummary = '';
    // summary 里若已含「需要具备/要求具备」，拆成两段
    const split = duty.match(/^(.*?)([。；;！!？?]?\s*)((?:需要|要求|须)具备.+)$/);
    if (split) {
      duty = (split[1] + (split[2] || '')).trim();
      if (!/[。！？]$/.test(duty) && duty) duty += '。';
      skillsFromSummary = split[3].trim();
    }
    if (!duty) {
      const fb = String(fallback || '').trim();
      if (/要做什么[：:]/.test(fb)) {
        duty = parseJobUnderstandingText(fb).duty;
      } else {
        const fbSplit = fb.replace(/^岗位理解[：:]\s*/, '').match(/^(.*?)([。；;]?\s*)((?:需要|要求|须)具备.+)$/);
        if (fbSplit) {
          duty = (fbSplit[1] + (fbSplit[2] || '')).trim();
          skillsFromSummary = fbSplit[3].trim();
        } else {
          duty = fb.replace(/^岗位理解[：:]\s*/, '').replace(/\n需要具备[：:].*$/s, '').trim();
        }
      }
    }

    const pool = [];
    function pushAll(arr, limit) {
      stringList(arr, limit).forEach((x) => {
        if (pool.indexOf(x) === -1) pool.push(x);
      });
    }
    pushAll(s.importantHaves, 6);
    pushAll(s.coreSkills, 6);
    pushAll(s.resumeKeywords, 6);
    // must 里偏技能的也可补（已有则跳过）
    pushAll(s.mustHaves, 4);

    let skills = skillsFromSummary;
    if (!skills && pool.length) {
      const top = pool.slice(0, 4);
      skills = '需要具备' + top.join('、') + (pool.length > 4 ? '等' : '') + '能力。';
    }
    return { duty: duty || '', skills: skills || '' };
  }

  /** 落盘用完整文案：两句拼在一起 */
  function formatJobUnderstandingText(spec, fallback) {
    const parts = formatJobUnderstandingParts(spec, fallback);
    if (!parts.duty && !parts.skills) return '';
    if (!parts.skills) return parts.duty;
    if (!parts.duty) return parts.skills;
    const duty = /[。！？]$/.test(parts.duty) ? parts.duty : parts.duty + '。';
    return duty + parts.skills;
  }

  function parseJobUnderstandingText(text) {
    const raw = String(text || '').trim();
    const out = { duty: '', skill: '', trait: '' };
    if (!raw) return out;
    const dutyM = raw.match(/要做什么[：:]\s*([^\n]*)/);
    const skillM = raw.match(/核心技能[：:]\s*([^\n]*)/);
    const traitM = raw.match(/候选人素质[：:]\s*([^\n]*)/);
    if (dutyM || skillM || traitM) {
      if (dutyM) out.duty = dutyM[1].trim();
      if (skillM) out.skill = skillM[1].trim();
      if (traitM) out.trait = traitM[1].trim();
      return out;
    }
    const body = raw.replace(/^岗位理解[：:]\s*/, '');
    const need = body.match(/^(.*?)([。！？]?\s*)((?:需要|要求|须)具备.+)$/);
    if (need) {
      out.duty = (need[1] + (need[2] || '')).trim();
      out.skill = need[3].trim();
      return out;
    }
    const lines = body.split(/\n+/);
    if (lines.length >= 2 && /需要具备/.test(lines[1])) {
      out.duty = lines[0].trim();
      out.skill = lines.slice(1).join('').trim();
      return out;
    }
    out.duty = body.trim();
    return out;
  }

  function composeJobUnderstandingText(parts) {
    const p = parts || {};
    const duty = String(p.duty || '').trim();
    const skill = String(p.skill || '').trim();
    if (duty && skill) {
      const d = /[。！？]$/.test(duty) ? duty : duty + '。';
      return d + skill;
    }
    return duty || skill || '';
  }

  function requirementsToJobSpecFields(requirements, hard) {
    const req = normalizeRequirements({ requirements: requirements || {} });
    const gates = hard && typeof hard === 'object' ? hard : {};
    const languages = stringList(gates.languages, 6);
    const customGates = stringList(gates.customGates, 6);
    return {
      languages,
      customGates,
      focusKeywords: req.important.slice(),
      bonusKeywords: req.nice.slice(),
      mustHaves: [],
      importantHaves: req.important.slice(),
      niceToHaves: req.nice.slice()
    };
  }
  function putJobPreset(record, jobId, preset, now) {
    const key = jobPresetKey(jobId);
    const clean = sanitizeJobPreset(preset);
    if (!key || !clean) return record && typeof record === 'object' ? record : {};
    return putCacheRecord(record, key, clean, now == null ? Date.now() : now, JOB_PRESET_TTL_MS, JOB_PRESET_LIMIT);
  }

  /**
   * 是否需要把该岗位的存档重新填进表单。
   * 依据「表单当前装着哪个岗位」，而非「上次活跃岗位是谁」——
   * 否则重开侧栏时目标岗位与上次活跃岗位相同，存档会被整轮跳过。
   */
  function needsPresetReload(targetJobId, formJobId) {
    const target = jobPresetKey(targetJobId);
    if (!target) return false;
    return target !== jobPresetKey(formJobId);
  }

  function getJobPreset(record, jobId) {
    const key = jobPresetKey(jobId);
    const row = record && key ? record[key] : null;
    if (!row || !row.value) return null;
    return sanitizeJobPreset(row.value);
  }

  const api = {
    LLM_CACHE_STORAGE_KEY,
    LLM_CACHE_LIMIT,
    LLM_CACHE_TTL_MS,
    LAST_SCREENING_PREFIX,
    LAST_ACTIVE_SCREENING_KEY,
    JOB_PRESET_STORAGE_KEY,
    JOB_PRESET_LIMIT,
    JOB_PRESET_TTL_MS,
    SCREENING_CSV_HEADERS,
    feedbackCsvLabel,
    stableHash,
    pruneTimedMap,
    putCacheRecord,
    csvEscape,
    toCsv,
    screeningItemToRow,
    screeningToCsv,
    slimScreeningItem,
    hydrateScreeningItem,
    lastScreeningStorageKey,
    resultContextKey,
    screeningPayloadJobId,
    screeningPayloadMatchesJob,
    jobPresetKey,
    sanitizeJobPreset,
    normalizeRequirements,
    fillRequirementsFromJobSpec,
    buildRequirementsFromJobSpec,
    jobSpecIsUsable,
    jobSpecMatchesJob,
    formatJobUnderstandingParts,
    formatJobUnderstandingText,
    parseJobUnderstandingText,
    composeJobUnderstandingText,
    requirementsToJobSpecFields,
    putJobPreset,
    getJobPreset,
    needsPresetReload
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaPersist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
