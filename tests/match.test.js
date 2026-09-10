const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
require('../lib/score.js');
const {
  parseChipList,
  matchKeywords,
  itemMatchesFilter,
  extractResumeKeywordsFromText,
  toResultView,
  summarizeResultViews,
  sortResultViews,
  viewMatchesFilter,
  candidateOpenPath,
  scoreColor,
  customHardLabel,
  itemFromCustomHardLabel,
  mergeHardWithMustHaves,
  dedupeMustHavesAgainstHard,
  evidenceColumnsFromScore,
  buildEvidenceColumns,
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
} = require('../lib/match.js');

describe('parseChipList', () => {
  it('splits Chinese and English delimiters and trims', () => {
    assert.deepEqual(parseChipList('SEO, Excel，Google、C4D'), ['SEO', 'Excel', 'Google', 'C4D']);
  });

  it('drops empties and caps at 6', () => {
    const many = Array.from({ length: 25 }, (_, i) => 'k' + i).join(',');
    assert.equal(parseChipList(many).length, 6);
    assert.deepEqual(parseChipList('  ,  ,foo'), ['foo']);
  });
});

describe('matchKeywords', () => {
  it('matches case-insensitively and reports misses', () => {
    const r = matchKeywords('做过 SEO 和 excel 投放', ['SEO', 'Python', 'Excel']);
    assert.deepEqual(r.hit, ['SEO', 'Excel']);
    assert.deepEqual(r.miss, ['Python']);
  });

  it('returns empty lists when no keywords', () => {
    assert.deepEqual(matchKeywords('任意文本', []), { hit: [], miss: [] });
  });
});

describe('itemMatchesFilter', () => {
  const item = {
    app: { name: '张三' },
    hard: { passed: false, missing: ['学历'] },
    score: { score: 70, level: '可推进' }
  };

  it('filters by name query', () => {
    assert.equal(itemMatchesFilter(item, { tab: 'all', query: '张' }), true);
    assert.equal(itemMatchesFilter(item, { tab: 'all', query: '李四' }), false);
  });

  it('filters recommend / hardfail / error tabs', () => {
    assert.equal(itemMatchesFilter(item, { tab: 'recommend' }), true);
    assert.equal(itemMatchesFilter(item, { tab: 'hardfail' }), true);
    assert.equal(itemMatchesFilter(item, { tab: 'error' }), false);
    const ok = {
      app: { name: '王五' },
      score: { score: 70, level: '可推进' },
      hard: { passed: true }
    };
    assert.equal(itemMatchesFilter(ok, { tab: 'recommend' }), true);
    const bad = {
      app: { name: '李四' },
      score: { score: 0, level: '错误' },
      hard: { passed: true }
    };
    assert.equal(itemMatchesFilter(bad, { tab: 'error' }), true);
    assert.equal(itemMatchesFilter(bad, { tab: 'recommend' }), false);
  });
});

describe('extractResumeKeywordsFromText', () => {
  it('picks skill-like English tokens and drops stopwords', () => {
    const kws = extractResumeKeywordsFromText('熟悉 SEO 与 Excel，the job uses Google');
    assert.ok(kws.includes('SEO'));
    assert.ok(kws.includes('Excel'));
    assert.ok(kws.includes('Google'));
    assert.ok(!kws.includes('the'));
    assert.ok(!kws.includes('job'));
  });

  it('keeps at most 6 keywords', () => {
    const text = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel';
    assert.equal(extractResumeKeywordsFromText(text).length, 6);
  });
});

describe('toResultView', () => {
  it('keeps display fields and drops bulky resume text', () => {
    const view = toResultView({
      app: {
        id: 42,
        name: '王敏',
        highestDegree: '本科',
        highestDegreeSchool: '复旦',
        specialities: '新闻',
        __resumeText: '很长的简历正文不应出现在侧栏快照里'
      },
      profile: '完整画像……',
      jobJD: '完整 JD……',
      hard: { passed: false, missing: ['学历'] },
      keywords: { hit: ['SEO'], miss: ['Excel'] },
      score: {
        score: 88,
        level: '优先推进',
        advanceReason: 'ok',
        dims: { skill: { score: 90, reason: '熟 SEO' } },
        suggestions: ['约面'],
        unmet: [],
        waivedUnmet: [],
        penalty: 0,
        baseScore: 88
      },
      stage: 'score',
      __rescoring: true,
      rawScore: { dimensions: {} }
    });
    assert.deepEqual(view, {
      id: 42,
      name: '王敏',
      meta: '本科 · 复旦 · 新闻',
      hardPassed: false,
      structuredHardPassed: false,
      hardMissing: ['学历'],
      keywords: { hit: ['SEO'], miss: ['Excel'] },
      score: {
        score: 88,
        level: '优先推进',
        error: '',
        advanceReason: 'ok',
        dims: { skill: { score: 90, reason: '熟 SEO' } },
        suggestions: ['约面'],
        highlights: [],
        concerns: [],
        experienceEvidence: [],
        unmet: [],
        waivedUnmet: [],
        unmetNice: [],
        metNice: [],
        penalty: 0,
        mustPenalty: 0,
        importantPenalty: 0,
        bonus: 0,
        bonusKeywordResults: [],
        bonusPoints: 0,
        bonusApplied: 0,
        bonusMetCount: 0,
        bonusTotalCount: 0,
        bonusPromoted: false,
        baseScore: 88,
        matchScore: 88
      },
      stage: 'score',
      rescoring: true,
      graduationRisk: null
    });
    assert.equal('profile' in view, false);
    assert.equal('jobJD' in view, false);
    assert.equal('rawScore' in view, false);
  });

  it('uses placeholders when the candidate is still pending', () => {
    const view = toResultView({ app: { id: 'a1' } });
    assert.equal(view.name, '(未知)');
    assert.equal(view.meta, '');
    assert.equal(view.score, null);
    assert.equal(view.hardPassed, true);
    assert.equal(view.stage, null);
    assert.equal(view.rescoring, false);
  });

  it('keeps bonus scoring fields needed to explain the decision score', () => {
    const view = toResultView({
      app: { id: 'a1' },
      score: {
        score: 81,
        matchScore: 78,
        level: '优先推进',
        bonusKeywordResults: [{ item: '作品集', met: true, reason: '附有作品集' }],
        bonusPoints: 3,
        bonusApplied: 3,
        bonusMetCount: 1,
        bonusTotalCount: 1,
        bonusPromoted: true
      }
    });
    assert.equal(view.score.bonusApplied, 3);
    assert.equal(view.score.bonusPromoted, true);
    assert.deepEqual(view.score.bonusKeywordResults, [
      { item: '作品集', met: true, reason: '附有作品集' }
    ]);
  });
});

describe('bonusScoreDisplay', () => {
  it('shows met count but not points when a gate blocks the candidate', () => {
    assert.equal(
      bonusScoreDisplay({
        level: '不建议推进',
        score: 42,
        matchScore: 90,
        advanceReason: 'gate',
        bonusMetCount: 2,
        bonusTotalCount: 2,
        bonusApplied: 0
      }),
      '经历匹配 90 · 加分看 2/2（未计入）'
    );
  });

  it('shows met count but does not rescue match score below 50', () => {
    assert.equal(
      bonusScoreDisplay({
        level: '不建议推进',
        score: 45,
        matchScore: 45,
        advanceReason: 'match',
        bonusMetCount: 3,
        bonusTotalCount: 3,
        bonusApplied: 0
      }),
      '加分看 3/3（未计入，匹配不足 50）'
    );
  });

  it('explains points applied to an eligible candidate', () => {
    assert.equal(
      bonusScoreDisplay({
        level: '优先推进',
        score: 81,
        matchScore: 78,
        bonusMetCount: 1,
        bonusTotalCount: 3,
        bonusApplied: 3
      }),
      '经历匹配 78 · 加分 +3'
    );
  });

  it('shows zero met items when bonus keywords were configured', () => {
    assert.equal(
      bonusScoreDisplay({
        level: '可推进',
        score: 78,
        matchScore: 78,
        bonusMetCount: 0,
        bonusTotalCount: 3,
        bonusApplied: 0
      }),
      '加分看 0/3'
    );
  });

  it('drops the match-score prefix from the card face once a structured breakdown exists', () => {
    // 匹配分改由「评分明细」的计算链解释，卡面不再出现第二个分数
    assert.equal(
      bonusScoreDisplay({
        level: '不建议推进',
        score: 42,
        matchScore: 90,
        advanceReason: 'gate',
        bonusMetCount: 2,
        bonusTotalCount: 2,
        bonusApplied: 0,
        scoreBreakdown: { coreDuty: { score: 90 } }
      }),
      '加分看 2/2（未计入）'
    );
    assert.equal(
      bonusScoreDisplay({
        level: '优先推进',
        score: 81,
        matchScore: 78,
        bonusMetCount: 1,
        bonusTotalCount: 3,
        bonusApplied: 3,
        scoreBreakdown: { coreDuty: { score: 90 } }
      }),
      '加分 +3'
    );
  });

  it('hides bonus details for errors or no configured bonus keywords', () => {
    assert.equal(bonusScoreDisplay({ level: '错误', bonusTotalCount: 3 }), '');
    assert.equal(bonusScoreDisplay({ level: '可推进', bonusTotalCount: 0 }), '');
  });
});

describe('summarizeResultViews', () => {
  it('counts scored / recommend / hardfail / error independently of order', () => {
    const views = [
      { score: { score: 88, level: '优先推进' }, structuredHardPassed: true },
      { score: { score: 90, level: '优先推进' }, structuredHardPassed: false },
      { score: { score: 40, level: '不建议推进' }, structuredHardPassed: false },
      { score: { score: 0, level: '错误' }, structuredHardPassed: true },
      { score: null, structuredHardPassed: true }
    ];
    assert.deepEqual(summarizeResultViews(views), {
      total: 5,
      scored: 4,
      recommend: 2,
      hardfail: 2,
      error: 1
    });
  });
});

describe('sortResultViews', () => {
  it('sorts by score descending and does not sink hard-fail', () => {
    const views = [
      { id: 'low', hardPassed: true, score: { score: 40 } },
      { id: 'fail', hardPassed: false, score: { score: 90 } },
      { id: 'high', hardPassed: true, score: { score: 80 } },
      { id: 'pending', hardPassed: true, score: null }
    ];
    assert.deepEqual(
      sortResultViews(views).map((v) => v.id),
      ['fail', 'high', 'low', 'pending']
    );
  });
});

describe('viewMatchesFilter', () => {
  const view = {
    name: '张三',
    hardPassed: false,
    structuredHardPassed: false,
    score: { score: 70, level: '可推进' }
  };

  it('filters by name, recommend, hardfail and error', () => {
    assert.equal(viewMatchesFilter(view, { tab: 'all', query: '张' }), true);
    assert.equal(viewMatchesFilter(view, { tab: 'all', query: '李四' }), false);
    assert.equal(viewMatchesFilter(view, { tab: 'recommend' }), true);
    assert.equal(viewMatchesFilter(view, { tab: 'hardfail' }), true);
    assert.equal(viewMatchesFilter(view, { tab: 'error' }), false);
    const passed = { name: '王五', hardPassed: true, score: { score: 70, level: '可推进' } };
    assert.equal(viewMatchesFilter(passed, { tab: 'recommend' }), true);
  });

  it('hides decided candidates from the default pending tab', () => {
    const pending = { name: '待处理', feedback: null, score: { score: 60, level: '可推进' } };
    const eliminated = {
      name: '已淘汰',
      feedback: 'eliminate',
      feedbackSync: 'synced',
      score: { score: 40, level: '一般' }
    };
    assert.equal(viewMatchesFilter(pending, { tab: 'all' }), true);
    assert.equal(viewMatchesFilter(eliminated, { tab: 'all' }), false);
    assert.equal(viewMatchesFilter(eliminated, { tab: 'feedback' }), true);
  });

  it('moves decided recommend-level candidates out of the recommend tab too', () => {
    const pending = { name: '待推进', feedback: null, score: { score: 80, level: '优先推进' } };
    const advanced = {
      name: '批量推进过',
      feedback: 'recommend',
      feedbackSync: 'synced',
      score: { score: 80, level: '优先推进' }
    };
    assert.equal(viewMatchesFilter(pending, { tab: 'recommend' }), true);
    assert.equal(viewMatchesFilter(advanced, { tab: 'recommend' }), false);
    assert.equal(viewMatchesFilter(advanced, { tab: 'feedback' }), true);
  });

  it('also hides pending or failed Moka sync from the default tab', () => {
    const syncing = {
      name: '同步中',
      feedback: 'eliminate',
      feedbackSync: 'pending',
      score: { score: 70, level: '可推进' }
    };
    const failed = {
      name: '失败',
      feedback: 'recommend',
      feedbackSync: 'failed',
      score: { score: 70, level: '可推进' }
    };
    assert.equal(viewMatchesFilter(syncing, { tab: 'all' }), false);
    assert.equal(viewMatchesFilter(syncing, { tab: 'feedback' }), true);
    assert.equal(viewMatchesFilter(failed, { tab: 'all' }), false);
    assert.equal(viewMatchesFilter(failed, { tab: 'feedback' }), true);
  });

  it('filters by feedback tab', () => {
    const tagged = {
      name: '李四',
      feedback: 'recommend',
      score: { score: 40, level: '不建议推进' }
    };
    const legacy = { name: '张三', feedback: 'positive', score: { score: 50, level: '可推进' } };
    const untagged = { name: '王五', feedback: null, score: { score: 80, level: '优先推进' } };
    assert.equal(viewMatchesFilter(tagged, { tab: 'feedback' }), true);
    assert.equal(viewMatchesFilter(legacy, { tab: 'feedback' }), true);
    assert.equal(viewMatchesFilter(untagged, { tab: 'feedback' }), false);
  });
});

describe('candidateOpenPath', () => {
  it('builds the Moka application path with the list query string', () => {
    assert.equal(
      candidateOpenPath(99, '?pipelineId=abc&jobIds=1'),
      '/candidates/application/99?pipelineId=abc&jobIds=1'
    );
    assert.equal(candidateOpenPath('ab', ''), '/candidates/application/ab');
    assert.equal(candidateOpenPath(1, 'pipelineId=x'), '/candidates/application/1?pipelineId=x');
  });
});

describe('scoreColor', () => {
  it('uses the three advancement tier bands', () => {
    assert.equal(scoreColor(80), '#52c41a');
    assert.equal(scoreColor(79), '#1890ff');
    assert.equal(scoreColor(50), '#1890ff');
    assert.equal(scoreColor(49), '#ff4d4f');
  });
});

describe('customHardLabel', () => {
  it('round-trips the display label for a custom must-have', () => {
    assert.equal(customHardLabel('内容运营经验'), '缺「内容运营经验」');
    assert.equal(itemFromCustomHardLabel('缺「内容运营经验」'), '内容运营经验');
    assert.equal(itemFromCustomHardLabel('学历需本科及以上'), '');
  });
});

describe('mergeHardWithMustHaves', () => {
  it('keeps local misses and appends unmet custom items', () => {
    const merged = mergeHardWithMustHaves({ passed: false, missing: ['学历需本科及以上'] }, [
      { item: 'Java', note: '未见' },
      { item: 'SEO' }
    ]);
    assert.equal(merged.passed, false);
    assert.deepEqual(merged.missing, ['学历需本科及以上', '缺「Java」', '缺「SEO」']);
  });

  it('passes when local hard is clear and nothing is unmet', () => {
    const merged = mergeHardWithMustHaves({ passed: true, missing: [] }, []);
    assert.equal(merged.passed, true);
    assert.deepEqual(merged.missing, []);
  });

  it('fails only due to custom items when local hard passed', () => {
    const merged = mergeHardWithMustHaves({ passed: true, missing: [] }, [
      { item: '内容运营经验' }
    ]);
    assert.equal(merged.passed, false);
    assert.deepEqual(merged.missing, ['缺「内容运营经验」']);
  });
});

describe('dedupeMustHavesAgainstHard', () => {
  it('drops chips already covered by structured degree / years / gender', () => {
    const kept = dedupeMustHavesAgainstHard(
      ['本科及以上', 'Java', '3-5年经验', '内容运营经验', '性别男'],
      { degree: '本科', exp: '3-5', gender: '男', schools: [] }
    );
    assert.deepEqual(kept, ['Java', '内容运营经验']);
  });

  it('keeps a degree chip that also names a major', () => {
    const kept = dedupeMustHavesAgainstHard(['本科广告学'], { degree: '本科' });
    assert.deepEqual(kept, ['本科广告学']);
  });

  it('drops a school chip that matches a checked school tag', () => {
    const kept = dedupeMustHavesAgainstHard(['211院校', 'SEO'], { schools: ['211'] });
    assert.deepEqual(kept, ['SEO']);
  });

  it('rewrites long year chips into domain-only when structured exp is set', () => {
    const kept = dedupeMustHavesAgainstHard(['3年以上广告设计或海外素材设计经验', 'Midjourney'], {
      exp: '3-5',
      degree: '',
      schools: []
    });
    assert.deepEqual(kept, ['广告设计或海外素材设计经验', 'Midjourney']);
  });
});

describe('buildEvidenceColumns', () => {
  it('puts highlights on the left without check prefixes', () => {
    const cols = buildEvidenceColumns({
      highlights: ['✓ 有党务运营经验', '政府对接能力'],
      concerns: [],
      unmet: [],
      waivedUnmet: []
    });
    assert.deepEqual(cols.left, ['有党务运营经验', '政府对接能力']);
    assert.deepEqual(cols.right, []);
  });

  it('lists unmet gates with their evidence and no score override action', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: ['党员身份未明确，无法满足硬性门槛'],
      unmet: [{ item: '党员', reason: '简历未写明', source: 'handwritten' }],
      waivedUnmet: []
    });
    assert.equal(cols.right.length, 1);
    assert.equal(cols.right[0].kind, 'unmet');
    assert.equal(cols.right[0].item, '党员');
    assert.equal(cols.right[0].action, null);
    // 卡面已带「门槛」徽章，正文不再重复「未过门槛「」」前缀
    assert.equal(cols.right[0].text, '党员：简历未写明');
  });

  it('falls back to the bare gate name when no reason is given', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: [],
      unmet: [{ item: '党员' }],
      waivedUnmet: []
    });
    assert.equal(cols.right[0].text, '党员');
  });

  it('keeps a concern that does not overlap an unmet item', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: ['行业经验短'],
      unmet: [{ item: 'Java' }],
      waivedUnmet: []
    });
    assert.deepEqual(
      cols.right.map((r) => r.kind),
      ['unmet', 'concern']
    );
    assert.equal(cols.right[1].text, '行业经验短');
    assert.equal(cols.right[1].action, null);
  });

  it('does not revive legacy waived gate rows', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: [],
      unmet: [],
      waivedUnmet: [{ item: '党员' }]
    });
    assert.deepEqual(cols.right, []);
  });

  it('keeps experience evidence in its own list instead of filling the left column', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      experienceEvidence: ['澳启教育：海外用户访谈'],
      concerns: [],
      unmet: []
    });
    assert.deepEqual(cols.left, []);
    assert.deepEqual(cols.evidence, ['澳启教育：海外用户访谈']);
  });

  it('keeps the left column highlights-only and moves evidence aside', () => {
    const cols = buildEvidenceColumns({
      highlights: ['有增长实习'],
      experienceEvidence: ['澳启教育：小红书内容优化', '有增长实习'],
      concerns: [],
      unmet: []
    });
    assert.deepEqual(cols.left, ['有增长实习']);
    assert.deepEqual(cols.evidence, ['澳启教育：小红书内容优化']);
  });

  it('returns empty evidence list when nothing overlaps and no evidence given', () => {
    const cols = buildEvidenceColumns({
      highlights: ['内容运营实习'],
      concerns: [],
      unmet: []
    });
    assert.deepEqual(cols.left, ['内容运营实习']);
    assert.deepEqual(cols.evidence, []);
  });

  it('reports empty left when highlights and evidence are both absent', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: ['行业经验短'],
      unmet: []
    });
    assert.deepEqual(cols.left, []);
    assert.deepEqual(cols.evidence, []);
    assert.equal(cols.right.length, 1);
    assert.equal(cols.right[0].kind, 'concern');
  });

  it('does not put unmet nice into the未体现 column', () => {
    const cols = buildEvidenceColumns({
      highlights: [],
      concerns: [],
      unmet: [],
      waivedUnmet: [],
      unmetNice: [{ item: '作品集', note: '未展示' }]
    });
    assert.deepEqual(cols.right, []);
  });

  it('splits legacy suggestion prefixes when highlights are absent', () => {
    const cols = evidenceColumnsFromScore({
      suggestions: ['✓ 有项目', '✕ 经验短'],
      unmet: [],
      waivedUnmet: []
    });
    assert.deepEqual(cols.left, ['有项目']);
    assert.equal(cols.right[0].kind, 'concern');
    assert.equal(cols.right[0].text, '经验短');
  });
});

describe('niceBonusTagsFromScore', () => {
  it('lists met and unmet nice labels for name-row tags', () => {
    const tags = niceBonusTagsFromScore({
      metNice: [{ item: '作品集' }],
      unmetNice: [{ item: '英语六级' }, { item: '  ' }]
    });
    assert.deepEqual(tags, { met: ['作品集'], unmet: ['英语六级'] });
  });
});

describe('extractDegreeFromText', () => {
  it('maps 本科及以上学历 to 本科', () => {
    assert.equal(extractDegreeFromText('学历要求：本科及以上学历'), '本科');
  });

  it('maps 硕士 / 研究生 above 本科 when both appear as requirements', () => {
    assert.equal(extractDegreeFromText('硕士及以上学历，本科也可投递'), '硕士');
  });

  it('maps a short schema value 本科', () => {
    assert.equal(extractDegreeFromText('本科'), '本科');
  });

  it('does not prefill 大专 because the dropdown starts at 本科', () => {
    assert.equal(extractDegreeFromText('大专及以上学历'), '');
  });

  it('returns empty when no degree is stated', () => {
    assert.equal(extractDegreeFromText('负责内容运营与活动策划'), '');
  });
});

describe('extractExperienceFromText', () => {
  it('maps 3-5年工作经验 to the 3-5 bucket', () => {
    assert.equal(extractExperienceFromText('工作经验：3-5年'), '3-5');
  });

  it('maps 三年以上 to the 3-5 bucket', () => {
    assert.equal(extractExperienceFromText('三年以上相关工作经验'), '3-5');
  });

  it('maps 5年以上 to 5+', () => {
    assert.equal(extractExperienceFromText('5年以上互联网从业经验'), '5+');
  });

  it('maps 1-3年 and 一至三年 to 1-3', () => {
    assert.equal(extractExperienceFromText('1-3年人力资源经验'), '1-3');
    assert.equal(extractExperienceFromText('一至三年相关经验'), '1-3');
  });

  it('maps 应届 / 在校 to fresh', () => {
    assert.equal(extractExperienceFromText('欢迎应届毕业生投递'), 'fresh');
  });

  it('returns empty when experience is 不限', () => {
    assert.equal(extractExperienceFromText('工作经验不限，有相关实习优先'), '');
  });
});

describe('extractSchoolsFromText', () => {
  it('picks 211 and 985 when both are named', () => {
    assert.deepEqual(extractSchoolsFromText('院校要求：211、985'), ['211', '985']);
  });

  it('picks 双一流 and 留学生', () => {
    assert.deepEqual(extractSchoolsFromText('双一流院校或海外学历优先'), ['双一流', '留学生']);
  });

  it('maps QS前100 to QS100', () => {
    assert.deepEqual(extractSchoolsFromText('QS前100或同等水平'), ['QS100']);
  });

  it('returns empty when schools are 不限', () => {
    assert.deepEqual(extractSchoolsFromText('院校不限'), []);
  });
});

describe('extractGenderFromText', () => {
  it('reads 性别：男 as a hard requirement', () => {
    assert.equal(extractGenderFromText('性别：男'), '男');
  });

  it('reads 仅限女生', () => {
    assert.equal(extractGenderFromText('仅限女生'), '女');
  });

  it('returns empty when gender is unlimited or both mentioned', () => {
    assert.equal(extractGenderFromText('性别不限'), '');
    assert.equal(extractGenderFromText('男女均可'), '');
  });
});

describe('extractAgeRangesFromText', () => {
  it('maps 25-35岁 onto overlapping buckets', () => {
    assert.deepEqual(extractAgeRangesFromText('年龄25-35岁'), ['25-30', '30-35']);
  });

  it('maps 35岁以下 to buckets up to 35', () => {
    assert.deepEqual(extractAgeRangesFromText('35岁以下'), ['20-25', '25-30', '30-35']);
  });

  it('maps 30岁以上 to buckets from 30', () => {
    assert.deepEqual(extractAgeRangesFromText('30岁以上'), ['30-35', '35-40', '40-50', '50+']);
  });

  it('returns empty when age is 不限', () => {
    assert.deepEqual(extractAgeRangesFromText('年龄不限'), []);
  });
});

describe('extractInternshipFromText', () => {
  it('requires internship when JD demands related intern experience', () => {
    assert.equal(extractInternshipFromText('需具备相关实习经验'), 'required');
  });

  it('does not treat 优先 as a hard internship gate', () => {
    assert.equal(extractInternshipFromText('有相关实习优先'), '');
  });
});

describe('extractHardAutofillFromText', () => {
  it('extracts language and professional gates without duplicating degree', () => {
    const af = extractHardAutofillFromText(
      '本科及以上学历；日语 N1 及以上；设计类相关专业；会使用 Photoshop'
    );
    assert.equal(af.degree, '本科');
    assert.deepEqual(af.languages, ['日语N1及以上']);
    assert.ok(af.customGates.includes('设计类相关专业'));
    assert.ok(af.customGates.includes('会使用 Photoshop'));
    assert.ok(!af.customGates.some((x) => /本科/.test(x)));
  });

  it('fills every hard-requirement slot from a full JD snippet', () => {
    const af = extractHardAutofillFromText(
      '学历本科及以上；211院校；3-5年经验；性别：女；年龄25-30岁；需具备实习经验；熟悉 SEO 与 Excel'
    );
    assert.equal(af.degree, '本科');
    assert.equal(af.exp, '3-5');
    assert.deepEqual(af.schools, ['211']);
    assert.equal(af.gender, '女');
    assert.deepEqual(af.ageRangeValues, ['25-30']);
    assert.equal(af.internship, 'required');
    assert.ok(af.resumeKeywords.includes('SEO'));
    assert.ok(af.resumeKeywords.includes('Excel'));
  });
});

describe('splitMustHavesForHard', () => {
  it('keeps non-structured JD must-haves as handwritten gates', () => {
    const split = splitMustHavesForHard(
      ['本科及以上', '日语 N1', '设计类相关专业', '一周到岗 5 天'],
      { degree: '本科' }
    );
    assert.deepEqual(split.languages, ['日语N1']);
    assert.deepEqual(split.customGates, ['设计类相关专业', '一周到岗 5 天']);
  });
});

describe('graduationRiskHint', () => {
  const NOW = new Date(2026, 8, 3);

  it('flags intern graduation within six months', () => {
    const hint = graduationRiskHint([{ school: 'Edinburgh', endDate: '2026.12' }], {
      jobType: 'intern',
      now: NOW
    });
    assert.deepEqual(hint, {
      endLabel: '2026.12',
      text: '毕业 2026.12，距今不足半年'
    });
  });

  it('does not flag exactly six months out', () => {
    assert.equal(
      graduationRiskHint([{ endDate: '2027-03-03' }], { jobType: 'intern', now: NOW }),
      null
    );
  });

  it('does not flag already graduated', () => {
    assert.equal(
      graduationRiskHint([{ endDate: '2026-08-01' }], { jobType: 'intern', now: NOW }),
      null
    );
  });

  it('does not flag full-time jobs', () => {
    assert.equal(
      graduationRiskHint([{ endDate: '2026.12' }], { jobType: 'full-time', now: NOW }),
      null
    );
  });

  it('skips missing or ongoing end dates', () => {
    assert.equal(
      graduationRiskHint([{ endDate: '' }, { end: '至今' }], { jobType: 'intern', now: NOW }),
      null
    );
  });

  it('uses the latest education end date', () => {
    const hint = graduationRiskHint([{ endDate: '2025.7' }, { endDate: '2026-12' }], {
      jobType: 'intern',
      now: NOW
    });
    assert.equal(hint.endLabel, '2026.12');
  });

  it('passes graduationRisk through toResultView without changing score', () => {
    const risk = { endLabel: '2026.12', text: '毕业 2026.12，距今不足半年' };
    const view = toResultView({
      app: { id: 1, name: '黄芯怡' },
      graduationRisk: risk,
      score: { score: 73, level: '可推进', matchScore: 73 }
    });
    assert.deepEqual(view.graduationRisk, risk);
    assert.equal(view.score.score, 73);
    assert.equal(view.score.level, '可推进');
  });
});
