const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stableHash,
  pruneTimedMap,
  putCacheRecord,
  csvEscape,
  screeningToCsv,
  slimScreeningItem,
  hydrateScreeningItem,
  lastScreeningStorageKey,
  LAST_ACTIVE_SCREENING_KEY,
  resultContextKey,
  screeningPayloadMatchesJob,
  jobPresetKey,
  sanitizeJobPreset,
  fillRequirementsFromJobSpec,
  buildRequirementsFromJobSpec,
  formatJobUnderstandingParts,
  formatJobUnderstandingText,
  jobSpecIsUsable,
  jobSpecMatchesJob,
  parseJobUnderstandingText,
  composeJobUnderstandingText,
  requirementsToJobSpecFields,
  putJobPreset,
  getJobPreset,
  needsPresetReload
} = require('../lib/persist.js');

describe('stableHash', () => {
  it('returns the same hex for the same payload', () => {
    const a = stableHash({ profile: '张三', model: 'gpt-4o' });
    const b = stableHash({ profile: '张三', model: 'gpt-4o' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('changes when the payload changes', () => {
    const a = stableHash({ profile: '张三' });
    const b = stableHash({ profile: '李四' });
    assert.notEqual(a, b);
  });
});

describe('pruneTimedMap', () => {
  it('drops expired entries and keeps the newest when over limit', () => {
    const now = 1_000_000;
    const record = {
      old: { value: 1, savedAt: now - 100 },
      mid: { value: 2, savedAt: now - 50 },
      fresh: { value: 3, savedAt: now - 10 },
      expired: { value: 9, savedAt: now - 10_000 }
    };
    const pruned = pruneTimedMap(record, now, 200, 2);
    assert.deepEqual(Object.keys(pruned).sort(), ['fresh', 'mid']);
    assert.equal(pruned.fresh.value, 3);
  });
});

describe('putCacheRecord', () => {
  it('stores a value with savedAt', () => {
    const now = 50;
    const next = putCacheRecord({}, 'abc', { score: 80 }, now, 1000, 500);
    assert.deepEqual(next.abc, { value: { score: 80 }, savedAt: 50 });
  });
});

describe('csv', () => {
  it('escapes commas and quotes for Excel', () => {
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape(78), '78');
  });

  it('builds a screening CSV with a header and one candidate', () => {
    const item = {
      app: { id: 11, name: '张三', highestDegree: '本科', highestDegreeSchool: '清华' },
      hard: { passed: false, missing: ['学历需硕士及以上'] },
      score: {
        score: 70,
        level: '值得推荐',
        penalty: 5,
        dims: {
          experience: { score: 80 },
          skill: { score: 70 },
          education: { score: 60 },
          potential: { score: 50 }
        }
      },
      rawScore: { highlights: ['有项目'], concerns: ['经验短'] }
    };
    const csv = screeningToCsv([item], 'https://app.mokahr.com');
    assert.match(csv, /^姓名,/);
    assert.match(csv, /张三/);
    assert.match(csv, /70/);
    assert.match(csv, /值得推荐/);
    assert.match(csv, /学历需硕士及以上/);
    assert.match(csv, /https:\/\/app\.mokahr\.com\/candidates\/application\/11/);
  });

  it('includes feedback column when map is provided', () => {
    const item = {
      app: { id: 22, name: '李四' },
      score: { score: 60, level: '值得推荐', dims: {} },
      hard: { passed: true },
      rawScore: {}
    };
    const csv = screeningToCsv([item], 'https://app.mokahr.com', { 22: 'recommend' });
    assert.match(csv, /反馈/);
    assert.match(csv, /推荐给用人部门/);
  });

  it('exports match score and unmet gates without legacy dimension arithmetic', () => {
    const csv = screeningToCsv(
      [
        {
          app: { id: 33, name: '赵六' },
          score: { score: 42, matchScore: 91, level: '不建议推进', unmet: [{ item: '日语' }] },
          hard: { passed: false, missing: ['缺「日语」'] },
          rawScore: {}
        }
      ],
      'https://app.mokahr.com'
    );
    assert.match(csv, /^姓名,学历,学校,决策分,经历匹配,档位,未过门槛,/);
    assert.match(csv, /赵六,,,42,91,不建议推进/);
    assert.doesNotMatch(csv, /必备项扣分|经验,技能,教育,潜力/);
  });
});

describe('slim screening', () => {
  it('serializes waived Set and restores it', () => {
    const slim = slimScreeningItem({
      app: { id: 1, name: '李四', experienceInfo: [{ company: 'huge' }] },
      waivedMustHaves: new Set(['Java']),
      score: { score: 88, level: '强烈推荐' },
      rawScore: { highlights: ['稳'], dimensions: { experience: { score: 90 } } }
    });
    assert.deepEqual(slim.waivedMustHaves, ['Java']);
    assert.equal(slim.app.experienceInfo, undefined);
    const hydrated = hydrateScreeningItem(slim);
    assert.ok(hydrated.waivedMustHaves instanceof Set);
    assert.equal(hydrated.waivedMustHaves.has('Java'), true);
  });

  it('keeps match score and handwritten gate results in slim storage', () => {
    const slim = slimScreeningItem({
      app: { id: 2 },
      rawScore: {
        matchScore: 81,
        handwrittenGateResults: [{ item: '日语', met: false, reason: '无证据' }],
        experienceEvidence: ['增长实习：小红书内容优化'],
        highlights: [],
        concerns: []
      }
    });
    assert.equal(slim.rawScore.matchScore, 81);
    assert.deepEqual(slim.rawScore.experienceEvidence, ['增长实习：小红书内容优化']);
    assert.deepEqual(slim.rawScore.handwrittenGateResults, [
      { item: '日语', met: false, reason: '无证据' }
    ]);
  });

  it('keeps per-item bonus evidence in slim storage', () => {
    const slim = slimScreeningItem({
      app: { id: 3 },
      score: {
        score: 81,
        matchScore: 78,
        bonusPoints: 3,
        bonusApplied: 3,
        bonusMetCount: 1,
        bonusTotalCount: 2,
        bonusPromoted: true,
        bonusKeywordResults: [
          { item: '作品集', met: true, reason: '附有作品集' },
          { item: '海外经历', met: false, reason: '未提及' }
        ]
      },
      rawScore: {
        matchScore: 78,
        bonusKeywordResults: [
          { item: '作品集', met: true, reason: '附有作品集' },
          { item: '海外经历', met: false, reason: '未提及' }
        ]
      }
    });
    assert.equal(slim.score.bonusApplied, 3);
    assert.equal(slim.score.bonusPromoted, true);
    assert.deepEqual(slim.rawScore.bonusKeywordResults, [
      { item: '作品集', met: true, reason: '附有作品集' },
      { item: '海外经历', met: false, reason: '未提及' }
    ]);
  });

  it('keeps intern graduation risk on slim and hydrate', () => {
    const risk = { endLabel: '2026.12', text: '毕业 2026.12，距今不足半年' };
    const slim = slimScreeningItem({
      app: { id: 9, educationInfo: [{ endDate: '2026.12' }] },
      graduationRisk: risk
    });
    assert.deepEqual(slim.graduationRisk, risk);
    assert.equal(slim.app.educationInfo, undefined);
    assert.deepEqual(hydrateScreeningItem(slim).graduationRisk, risk);
  });

  it('builds a storage key from pipelineId', () => {
    assert.equal(lastScreeningStorageKey('12345'), 'mokaLastScreening:12345');
    assert.equal(LAST_ACTIVE_SCREENING_KEY, 'mokaLastScreening:active');
  });

  it('builds result context keys and matches screening payloads to jobs', () => {
    assert.equal(resultContextKey('pipe1', 'job9'), 'pipe1:job9');
    const payload = { screenConfig: { jobId: 'job9' }, items: [{}] };
    assert.equal(screeningPayloadMatchesJob(payload, 'job9'), true);
    assert.equal(screeningPayloadMatchesJob(payload, 'job8'), false);
  });
});

describe('job presets', () => {
  it('migrates legacy must chips into hard.customGates and drops duplicate degree', () => {
    const clean = sanitizeJobPreset({
      jobType: 'intern',
      hard: { degree: '本科', schools: [], customGates: [] },
      requirements: {
        must: ['本科及以上', '会使用 Photoshop'],
        important: ['品牌实习'],
        nice: ['作品集']
      }
    });
    assert.equal(clean.hard.degree, '本科');
    assert.ok(clean.hard.customGates.includes('会使用 Photoshop'));
    assert.ok(!clean.hard.customGates.some((x) => /本科/.test(x)));
    assert.deepEqual(clean.focusKeywords, ['品牌实习']);
    assert.deepEqual(clean.bonusKeywords, ['作品集']);
    assert.deepEqual(clean.requirements.must, []);
  });

  it('does not duplicate legacy structured gender, experience or school gates', () => {
    const clean = sanitizeJobPreset({
      hard: { gender: '女', exp: '1-3', schools: ['211'] },
      requirements: {
        must: ['性别女', '1-3年经验', '211院校', '海外社媒经验']
      }
    });
    assert.deepEqual(clean.hard.customGates, ['海外社媒经验']);
    assert.deepEqual(clean.requirements.must, []);
  });

  it('keeps language gates separate and caps handwritten lists at six', () => {
    const clean = sanitizeJobPreset({
      hard: {
        languages: ['日语 N1', '英语 CET6', '法语', '德语', '韩语', '西班牙语', '第七条'],
        customGates: [
          'Photoshop',
          '设计专业',
          '每周五天',
          '到岗三个月',
          '作品集',
          '上海到岗',
          '第七条'
        ]
      }
    });
    assert.equal(clean.hard.languages.length, 6);
    assert.equal(clean.hard.customGates.length, 6);
  });

  it('keeps the new scoring fields inside a persisted jobSpec', () => {
    const clean = sanitizeJobPreset({
      hard: { languages: ['日语'], customGates: ['设计类专业'] },
      focusKeywords: ['品牌实习'],
      bonusKeywords: ['作品集'],
      jobSpec: {
        summary: '品牌设计实习',
        languages: ['日语'],
        customGates: ['设计类专业'],
        focusKeywords: ['品牌实习'],
        bonusKeywords: ['作品集']
      }
    });
    assert.deepEqual(clean.jobSpec.languages, ['日语']);
    assert.deepEqual(clean.jobSpec.customGates, ['设计类专业']);
    assert.deepEqual(clean.jobSpec.focusKeywords, ['品牌实习']);
    assert.deepEqual(clean.jobSpec.bonusKeywords, ['作品集']);
  });

  it('reloads the preset whenever the form does not already hold that job', () => {
    // 新开侧栏时表单还没装任何岗位，必须读存档，哪怕上次活跃岗位就是它
    assert.equal(needsPresetReload('job-9', ''), true);
    assert.equal(needsPresetReload('job-9', 'job-8'), true);
    // 同一会话里重复 loadJobs 不该反复覆盖正在编辑的表单
    assert.equal(needsPresetReload('job-9', 'job-9'), false);
    assert.equal(needsPresetReload(88, '88'), false);
    assert.equal(needsPresetReload(' 88 ', '88'), false);
    // 没有目标岗位时无从填充
    assert.equal(needsPresetReload('', 'job-9'), false);
  });

  it('uses the job id as the map key', () => {
    assert.equal(jobPresetKey(' 88 '), '88');
    assert.equal(jobPresetKey(''), '');
  });

  it('keeps hard requirements, weights and chips and drops unknown fields', () => {
    const clean = sanitizeJobPreset({
      jobType: 'intern',
      hard: {
        degree: '本科',
        schools: ['211', '985'],
        exp: '1-3',
        gender: '',
        internship: 'required',
        ageRanges: [{ min: 20, max: 25, label: '20-25' }]
      },
      weights: { experience: 50, skill: 20, education: 20, potential: 10 },
      mustHaves: ['Java', 'Spring'],
      keywords: ['SEO'],
      jobSpec: { summary: 'HR 实习', mustHaves: ['沟通'], extraHuge: 'x'.repeat(100) },
      secret: 'nope'
    });
    assert.equal(clean.jobType, 'intern');
    assert.deepEqual(clean.hard.schools, ['211', '985']);
    assert.deepEqual(clean.hard.ageRangeValues, ['20-25']);
    assert.equal(clean.weights.experience, 50);
    assert.deepEqual(clean.mustHaves, []);
    assert.deepEqual(clean.requirements.must, []);
    assert.deepEqual(clean.hard.customGates, ['Java', 'Spring']);
    assert.deepEqual(clean.requirements.important, ['SEO']);
    assert.deepEqual(clean.requirements.nice, []);
    assert.deepEqual(clean.keywords, []);
    assert.equal(clean.jobUnderstanding, 'HR 实习');
    assert.equal(clean.jobSpec.summary, 'HR 实习');
    assert.equal(clean.secret, undefined);
    assert.equal(clean.jobSpec.extraHuge, undefined);
  });

  it('migrates legacy mustHaves into handwritten gates', () => {
    const clean = sanitizeJobPreset({
      mustHaves: ['海外社媒'],
      requirements: { important: ['英语'], nice: ['作品集', '多一条', '三', '四应被截断'] }
    });
    assert.deepEqual(clean.requirements.must, []);
    assert.deepEqual(clean.hard.customGates, ['海外社媒']);
    assert.deepEqual(clean.requirements.important, ['英语']);
    assert.deepEqual(clean.requirements.nice, ['作品集', '多一条', '三', '四应被截断']);
    assert.deepEqual(clean.mustHaves, []);
  });

  it('fills empty important/nice from JD jobSpec without wiping must', () => {
    const filled = fillRequirementsFromJobSpec(
      { must: ['手写必须'], important: [], nice: [] },
      { mustHaves: ['JD必须应忽略'], importantHaves: ['JD重要'], niceToHaves: ['JD加分'] }
    );
    assert.deepEqual(filled.must, ['手写必须']);
    assert.deepEqual(filled.important, ['JD重要']);
    assert.deepEqual(filled.nice, ['JD加分']);
  });

  it('merges JD resumeKeywords into empty important', () => {
    const filled = fillRequirementsFromJobSpec(
      { must: [], important: [], nice: [] },
      { importantHaves: ['英语'], resumeKeywords: ['SEO', 'Excel', '英语'] }
    );
    assert.deepEqual(filled.important, ['英语', 'SEO', 'Excel']);
  });

  it('fills empty important with skills+traits and nice with traits', () => {
    const filled = fillRequirementsFromJobSpec(
      { must: [], important: [], nice: [] },
      {
        importantHaves: ['PS'],
        coreSkills: ['Figma'],
        candidateTraits: ['审美好', '抗压', '学习快', '沟通'],
        niceToHaves: ['作品集']
      }
    );
    assert.deepEqual(filled.important, ['PS', 'Figma', '审美好', '抗压', '学习快', '沟通']);
    assert.deepEqual(filled.nice, ['作品集', '审美好', '抗压', '学习快', '沟通']);
  });

  it('buildRequirementsFromJobSpec replaces all tiers from JD', () => {
    const built = buildRequirementsFromJobSpec({
      mustHaves: ['英语流利'],
      importantHaves: ['海外社媒'],
      coreSkills: ['数据分析'],
      niceToHaves: ['作品集'],
      candidateTraits: ['跨文化']
    });
    assert.deepEqual(built.must, ['英语流利']);
    assert.deepEqual(built.important, ['海外社媒', '数据分析', '跨文化']);
    assert.deepEqual(built.nice, ['作品集', '跨文化']);
    // 不得保留传入以外的旧芯片（本函数无旧芯片参数）
    assert.equal(built.must.indexOf('日语N1'), -1);
  });

  it('formats job understanding with duty plus skills from JD fields', () => {
    const parts = formatJobUnderstandingParts({
      summary: '负责海外达人合作与社媒账号日常运营。',
      importantHaves: ['英语沟通', '达人运营经验'],
      resumeKeywords: ['PS', 'AI'],
      mustHaves: ['英语沟通']
    });
    assert.equal(parts.duty, '负责海外达人合作与社媒账号日常运营。');
    assert.match(parts.skills, /需要具备/);
    assert.match(parts.skills, /英语沟通/);
    assert.match(parts.skills, /PS/);
    const text = formatJobUnderstandingText({
      summary: '负责海外达人合作与社媒账号日常运营。',
      importantHaves: ['英语沟通'],
      resumeKeywords: ['PS']
    });
    assert.match(text, /负责海外达人合作/);
    assert.match(text, /需要具备/);
  });

  it('parses plain summary and legacy three-line text', () => {
    assert.deepEqual(parseJobUnderstandingText('岗位理解：品牌视觉落地'), {
      duty: '品牌视觉落地',
      skill: '',
      trait: ''
    });
    assert.equal(
      parseJobUnderstandingText('负责运营。需要具备英语、PS能力。').skill,
      '需要具备英语、PS能力。'
    );
  });

  it('rejects a failed or content-free JD analysis', () => {
    // 解析失败时 background 会回一个「字段全空 + parseError」的壳，
    // 这种壳不能被当成一次成功的 JD 解读，否则会清空表单并覆盖存档。
    assert.equal(jobSpecIsUsable(null), false);
    assert.equal(jobSpecIsUsable({}), false);
    assert.equal(
      jobSpecIsUsable({
        summary: '',
        responsibilities: [],
        coreSkills: [],
        candidateTraits: [],
        mustHaves: [],
        importantHaves: [],
        niceToHaves: [],
        resumeKeywords: [],
        suggestedWeights: { experience: 40, skill: 30, education: 20, potential: 10 },
        parseError: true
      }),
      false
    );
    // 只回权重、没有任何岗位内容，同样不算解读成功
    assert.equal(
      jobSpecIsUsable({
        summary: '',
        suggestedWeights: { experience: 40, skill: 30, education: 20, potential: 10 }
      }),
      false
    );
    // 空白字符不算内容
    assert.equal(jobSpecIsUsable({ summary: '   ', importantHaves: ['  '] }), false);
    // 标了 parseError 一律不可用，哪怕带了半截内容
    assert.equal(jobSpecIsUsable({ summary: '负责品牌视觉。', parseError: true }), false);
  });

  it('accepts a JD analysis that carries a summary or any requirement list', () => {
    assert.equal(jobSpecIsUsable({ summary: '负责海外达人合作。' }), true);
    assert.equal(jobSpecIsUsable({ responsibilities: ['对接达人'] }), true);
    assert.equal(jobSpecIsUsable({ importantHaves: ['英语沟通'] }), true);
    assert.equal(jobSpecIsUsable({ resumeKeywords: ['PS'] }), true);
    assert.equal(jobSpecIsUsable({ mustHaves: ['本科及以上'] }), true);
  });

  it('flags a job understanding that was read from another job', () => {
    // 解读 JD 时会盖上来源职位；来源与当前所选职位不一致 = 串岗，必须能被识别出来
    assert.equal(jobSpecMatchesJob({ summary: '社媒运营', sourceJobId: 'job-a' }, 'job-b'), false);
    assert.equal(jobSpecMatchesJob({ summary: '社媒运营', sourceJobId: 'job-a' }, 'job-a'), true);
    assert.equal(jobSpecMatchesJob({ summary: '社媒运营', sourceJobId: 123 }, '123'), true);
  });

  it('does not call an unstamped legacy understanding a mismatch', () => {
    // 老存档没有来源职位：判不出来就别误清招聘官已经配好的条件
    assert.equal(jobSpecMatchesJob({ summary: '社媒运营' }, 'job-b'), true);
    assert.equal(jobSpecMatchesJob({ summary: '社媒运营', sourceJobId: 'job-a' }, ''), true);
    assert.equal(jobSpecMatchesJob(null, 'job-b'), true);
  });

  it('keeps the source job on the stored jobSpec so the next open can verify it', () => {
    const clean = sanitizeJobPreset({
      jobType: 'full-time',
      jobSpec: { summary: '社媒运营', sourceJobId: 'job-a', sourceJobName: '党务经理（外联方向）' }
    });
    assert.equal(clean.jobSpec.sourceJobId, 'job-a');
    assert.equal(clean.jobSpec.sourceJobName, '党务经理（外联方向）');
  });

  it('composes duty and skills into one stored string', () => {
    assert.equal(
      composeJobUnderstandingText({ duty: '品牌视觉助理', skill: '需要具备PS能力。' }),
      '品牌视觉助理。需要具备PS能力。'
    );
  });

  it('migrates legacy keywords into requirements.important', () => {
    const clean = sanitizeJobPreset({
      mustHaves: ['沟通'],
      keywords: ['SEO', '沟通', 'Excel']
    });
    assert.deepEqual(clean.requirements.must, []);
    assert.deepEqual(clean.hard.customGates, ['沟通']);
    assert.deepEqual(clean.requirements.important, ['SEO', 'Excel']);
    assert.deepEqual(clean.keywords, []);
  });

  it('maps handwritten gates and keywords to jobSpec fields for screening', () => {
    const fields = requirementsToJobSpecFields(
      {
        important: ['B'],
        nice: ['C', 'D', 'E', 'F']
      },
      {
        languages: ['日语 N1'],
        customGates: ['会使用 Photoshop']
      }
    );
    assert.deepEqual(fields.languages, ['日语 N1']);
    assert.deepEqual(fields.customGates, ['会使用 Photoshop']);
    assert.deepEqual(fields.focusKeywords, ['B']);
    assert.deepEqual(fields.bonusKeywords, ['C', 'D', 'E', 'F']);
    assert.deepEqual(fields.mustHaves, []);
    assert.deepEqual(fields.importantHaves, ['B']);
    assert.deepEqual(fields.niceToHaves, ['C', 'D', 'E', 'F']);
  });

  it('keeps at most five bonus keywords in a saved preset', () => {
    const clean = sanitizeJobPreset({
      bonusKeywords: ['A', 'B', 'C', 'D', 'E', 'F'],
      requirements: { nice: ['A', 'B', 'C', 'D', 'E', 'F'] },
      jobSpec: {
        bonusKeywords: ['A', 'B', 'C', 'D', 'E', 'F'],
        niceToHaves: ['A', 'B', 'C', 'D', 'E', 'F']
      }
    });
    assert.deepEqual(clean.bonusKeywords, ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(clean.requirements.nice, ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(clean.jobSpec.bonusKeywords, ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(clean.jobSpec.niceToHaves, ['A', 'B', 'C', 'D', 'E']);
  });

  it('round-trips a preset in the timed map and ignores empty job ids', () => {
    const preset = sanitizeJobPreset({
      jobType: 'full-time',
      hard: {
        degree: '硕士',
        schools: [],
        exp: '3-5',
        gender: '',
        internship: '',
        ageRangeValues: []
      },
      weights: { experience: 40, skill: 30, education: 20, potential: 10 },
      mustHaves: ['Google UAC'],
      keywords: ['Ads']
    });
    const now = 1_000;
    let record = putJobPreset({}, 'job-9', preset, now);
    record = putJobPreset(record, '', preset, now);
    assert.deepEqual(getJobPreset(record, 'job-9').hard.customGates, ['Google UAC']);
    assert.deepEqual(getJobPreset(record, 'job-9').requirements.important, ['Ads']);
    assert.deepEqual(getJobPreset(record, 'job-9').keywords, []);
    assert.equal(getJobPreset(record, ''), null);
    assert.equal(Object.keys(record).includes(''), false);
  });
});
