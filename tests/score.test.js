const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  composeFinalScore,
  scoreErrorResult,
  isScoreFailure,
  isRetryableScoreFailure,
  SCORE_AUTO_RETRY_MAX,
  hardConditionsPromptBlock,
  dimensionScoringNotes,
  matchScoringPromptBlock,
  normalizeModelScoreResponse,
  ensureHandwrittenGateResults,
  ensureBonusKeywordResults,
  mustHaveExtractionGuide,
  matchScoreDisplayText,
  scoreFailureMessage,
  classifyLlmJsonFailure,
  scoreParseFailureMessage,
  jdParseFailureMessage,
  jobJdLooksEmpty,
  PROMPT_VERSION
} = require('../lib/score.js');

function okRaw(overrides = {}) {
  return {
    dimensions: {
      experience: { score: 80, reason: '对口' },
      skill: { score: 70, reason: '够用' },
      education: { score: 60, reason: '本科' },
      potential: { score: 50, reason: '一般' }
    },
    mustHaveResults: [],
    highlights: ['有相关项目'],
    concerns: ['行业经验短'],
    ...overrides
  };
}

describe('scoreErrorResult', () => {
  it('returns null dimensions so UI will not treat it as a real score', () => {
    const raw = scoreErrorResult('未配置 API Key');
    assert.equal(raw.dimensions, null);
    assert.equal(raw.parseError, true);
    assert.equal(raw.error, '未配置 API Key');
  });
});

describe('isRetryableScoreFailure', () => {
  it('retries parse/API failures but not missing API key', () => {
    assert.equal(isScoreFailure(scoreErrorResult('模型返回解析失败')), true);
    assert.equal(isRetryableScoreFailure(scoreErrorResult('模型返回解析失败')), true);
    assert.equal(isRetryableScoreFailure(scoreErrorResult('未配置 API Key')), false);
    assert.equal(isRetryableScoreFailure(okRaw()), false);
    assert.equal(isRetryableScoreFailure({ dimensions: null, error: '429 Too Many Requests' }), true);
  });

  it('allows up to 2 automatic retries', () => {
    assert.equal(SCORE_AUTO_RETRY_MAX, 2);
  });
});

describe('composeFinalScore', () => {
  it('caps at 49 - 7 per unmet gate and ignores high match', () => {
    const raw = {
      dimensions: {
        experience: { score: 90 },
        skill: { score: 90 },
        education: { score: 90 },
        potential: { score: 90 }
      },
      matchScore: 90,
      highlights: ['社媒'],
      concerns: [],
      handwrittenGateResults: [{ item: '日语', met: false }]
    };
    const out = composeFinalScore(raw, [], ['学历本科']);
    assert.equal(out.score, 35);
    assert.equal(out.matchScore, 90);
    assert.equal(out.level, '不建议推进');
    assert.equal(out.advanceReason, 'gate');
  });

  it('uses match score when all gates pass even if match is 32', () => {
    const raw = {
      dimensions: {
        experience: { score: 32 },
        skill: { score: 32 },
        education: { score: 32 },
        potential: { score: 32 }
      },
      matchScore: 32,
      highlights: [],
      concerns: ['无相关实习'],
      handwrittenGateResults: []
    };
    const out = composeFinalScore(raw, [], []);
    assert.equal(out.score, 32);
    assert.equal(out.level, '不建议推进');
    assert.equal(out.advanceReason, 'match');
  });

  it('labels 可推进 and 优先推进 from composite score', () => {
    const mk = (match) => composeFinalScore({
      matchScore: match,
      dimensions: {
        experience: { score: match },
        skill: { score: match },
        education: { score: match },
        potential: { score: match }
      },
      highlights: [],
      concerns: [],
      handwrittenGateResults: []
    }, [], []);
    assert.equal(mk(65).level, '可推进');
    assert.equal(mk(80).level, '优先推进');
  });

  it('treats parseError as 错误 even if dummy 50-point dimensions are present', () => {
    const raw = {
      parseError: true,
      dimensions: {
        experience: { score: 50, reason: '模型返回解析失败' },
        skill: { score: 50, reason: '模型返回解析失败' },
        education: { score: 50, reason: '模型返回解析失败' },
        potential: { score: 50, reason: '模型返回解析失败' }
      },
      concerns: ['无法解析模型返回'],
      error: '模型返回解析失败'
    };
    const result = composeFinalScore(raw, new Set());
    assert.equal(result.level, '错误');
    assert.equal(result.score, 0);
    assert.equal(result.dims, null);
    assert.match(result.suggestions[0], /解析失败|评分失败|无法解析/);
  });

  it('treats missing API key style result as 错误, not ~50 值得推荐', () => {
    const raw = scoreErrorResult('未配置 API Key');
    const result = composeFinalScore(raw, new Set());
    assert.equal(result.level, '错误');
    assert.equal(result.score, 0);
  });

  it('falls back to an equal-weight average of dimensions when matchScore is absent', () => {
    // 80+70+60+50 / 4 = 65；不得再按旧招聘官权重 40/30/20/10 合成 70
    const result = composeFinalScore(okRaw(), new Set(), []);
    assert.equal(result.score, 65);
    assert.equal(result.baseScore, 65);
    assert.equal(result.level, '可推进');
    assert.deepEqual(result.highlights, ['有相关项目']);
    assert.deepEqual(result.concerns, ['行业经验短']);
  });

  it('maps seven or more unmet gates to zero', () => {
    const raw = okRaw({
      matchScore: 95,
      handwrittenGateResults: Array.from({ length: 7 }, (_, i) => ({
        item: `门槛${i + 1}`,
        met: false
      }))
    });
    const result = composeFinalScore(raw, new Set());
    assert.equal(result.matchScore, 95);
    assert.equal(result.score, 0);
    assert.equal(result.unmet.length, 7);
    assert.equal(result.advanceReason, 'gate');
  });

  it('counts only failed handwritten gates and keeps their reasons', () => {
    const raw = okRaw({
      matchScore: 88,
      handwrittenGateResults: [
        { item: '日语', met: true, reason: 'JLPT N1' },
        { item: '会使用 Photoshop', met: false, reason: '简历无相关证据' }
      ]
    });
    const result = composeFinalScore(raw, new Set());
    assert.equal(result.score, 42);
    assert.deepEqual(result.unmet.map((r) => r.item), ['会使用 Photoshop']);
    assert.equal(result.unmet[0].reason, '简历无相关证据');
  });

  it('does not apply bonus points when a hard gate fails', () => {
    const result = composeFinalScore({
      matchScore: 90,
      handwrittenGateResults: [{ item: '日语 N1', met: false }],
      bonusKeywordResults: [
        { item: '作品集', met: true, reason: '附有作品集' },
        { item: '海外经历', met: true, reason: '海外交换' }
      ]
    }, [], []);
    assert.equal(result.score, 42);
    assert.equal(result.bonusPoints, 6);
    assert.equal(result.bonusApplied, 0);
    assert.equal(result.bonusMetCount, 2);
    assert.equal(result.bonusTotalCount, 2);
  });

  it('does not let bonus points rescue match score below 50', () => {
    const result = composeFinalScore({
      matchScore: 45,
      bonusKeywordResults: Array.from({ length: 5 }, (_, i) => ({
        item: `加分项${i + 1}`,
        met: true
      }))
    }, [], []);
    assert.equal(result.score, 45);
    assert.equal(result.bonusPoints, 15);
    assert.equal(result.bonusApplied, 0);
    assert.equal(result.advanceReason, 'match');
  });

  it('adds three points per met bonus item once match score reaches 50', () => {
    const result = composeFinalScore({
      matchScore: 50,
      bonusKeywordResults: [
        { item: '作品集', met: true },
        { item: '海外经历', met: false }
      ]
    }, [], []);
    assert.equal(result.score, 53);
    assert.equal(result.bonusApplied, 3);
    assert.equal(result.level, '可推进');
  });

  it('allows bonus points to promote a candidate into 优先推进', () => {
    const result = composeFinalScore({
      matchScore: 78,
      bonusKeywordResults: [{ item: '作品集', met: true }]
    }, [], []);
    assert.equal(result.score, 81);
    assert.equal(result.level, '优先推进');
    assert.equal(result.bonusPromoted, true);
    assert.equal(result.advanceReason, 'bonus');
  });

  it('caps the final score at 100 and bonus points at 15', () => {
    const result = composeFinalScore({
      matchScore: 96,
      bonusKeywordResults: Array.from({ length: 7 }, (_, i) => ({
        item: `加分项${i + 1}`,
        met: true
      }))
    }, [], []);
    assert.equal(result.score, 100);
    assert.equal(result.bonusPoints, 15);
    assert.equal(result.bonusMetCount, 5);
    assert.equal(result.bonusTotalCount, 5);
  });
});

describe('hardConditionsPromptBlock', () => {
  it('returns empty string when recruiter set no hard conditions', () => {
    assert.equal(hardConditionsPromptBlock(''), '');
    assert.equal(hardConditionsPromptBlock(null), '');
  });

  it('embeds recruiter hard conditions for the scoring model', () => {
    const block = hardConditionsPromptBlock('学历：本科及以上；院校：211');
    assert.match(block, /招聘官设定的硬性条件/);
    assert.match(block, /学历：本科及以上；院校：211/);
    assert.match(block, /不要把四维一律打成 0/);
  });
});

describe('PROMPT_VERSION', () => {
  it('is a non-empty string so score cache can invalidate on prompt changes', () => {
    assert.equal(typeof PROMPT_VERSION, 'string');
    assert.ok(PROMPT_VERSION.length >= 1);
  });

  it('is not the previous gate-only prompt revision', () => {
    assert.notEqual(PROMPT_VERSION, 'gate-ai-match-v1');
    assert.match(PROMPT_VERSION, /evidence-first/);
    assert.notEqual(PROMPT_VERSION, 'evidence-first-bonus-cal-v3');
  });
});

describe('AI match scoring contract', () => {
  it('prompts for per-item handwritten gates and a standalone match score', () => {
    const prompt = matchScoringPromptBlock(
      'intern',
      ['日语 N1', '会使用 Photoshop'],
      ['品牌实习'],
      ['作品集']
    );
    assert.match(prompt, /无证据.*不过/);
    assert.match(prompt, /PS.*Photoshop|Photoshop.*PS/);
    assert.match(prompt, /matchScore/);
    assert.match(prompt, /重点看.*品牌实习/);
    assert.match(prompt, /加分看.*作品集/);
    assert.match(prompt, /bonusKeywordResults/);
    assert.match(prompt, /加分看.*(?:不得|不要).*matchScore|matchScore.*(?:不得|不要).*加分看/);
    assert.match(prompt, /逐条.*加分|加分.*逐条/);
    assert.match(prompt, /学历.*(?:不要|不得).*加分/);
    assert.match(prompt, /experienceEvidence|经历证据/);
    assert.match(prompt, /相邻/);
    assert.match(prompt, /不得.{0,12}低于\s*50|不得.{0,12}50\s*以下/);
    assert.doesNotMatch(prompt, /education|综合分约\s*50/);
    assert.doesNotMatch(prompt, /重点看缺失会拉低匹配分/);
  });

  it('normalizes model match score and handwritten gate results', () => {
    const raw = normalizeModelScoreResponse({
      matchScore: 108,
      handwrittenGateResults: [
        { item: '日语', met: false, reason: '简历未提及' },
        { item: '', met: true, reason: '忽略空项' }
      ],
      highlights: ['品牌项目'],
      concerns: ['经验较浅']
    });
    assert.equal(raw.matchScore, 100);
    assert.deepEqual(raw.handwrittenGateResults, [
      { item: '日语', met: false, reason: '简历未提及' }
    ]);
    assert.deepEqual(raw.highlights, ['品牌项目']);
    assert.deepEqual(raw.experienceEvidence, []);
  });

  it('normalizes at most five per-item bonus results', () => {
    const raw = normalizeModelScoreResponse({
      matchScore: 70,
      bonusKeywordResults: [
        { item: '作品集', met: true, reason: '附有作品集' },
        { item: '', met: true },
        { item: '海外经历', met: false, note: '未提及' },
        { item: 'A', met: true },
        { item: 'B', met: true },
        { item: 'C', met: true },
        { item: 'D', met: true }
      ]
    });
    assert.deepEqual(raw.bonusKeywordResults, [
      { item: '作品集', met: true, reason: '附有作品集' },
      { item: '海外经历', met: false, reason: '未提及' },
      { item: 'A', met: true, reason: '' },
      { item: 'B', met: true, reason: '' },
      { item: 'C', met: true, reason: '' }
    ]);
  });

  it('keeps experience evidence and still scores when the model omits the field', () => {
    const withEvidence = normalizeModelScoreResponse({
      matchScore: 62,
      experienceEvidence: ['澳启教育：海外用户访谈', '', '小红书内容优化']
    });
    assert.deepEqual(withEvidence.experienceEvidence, ['澳启教育：海外用户访谈', '小红书内容优化']);
    const composed = composeFinalScore(withEvidence, [], []);
    assert.equal(composed.matchScore, 62);
    assert.deepEqual(composed.experienceEvidence, ['澳启教育：海外用户访谈', '小红书内容优化']);
    assert.equal(composed.level, '可推进');
  });

  it('marks a response without matchScore as a parse error instead of a silent zero', () => {
    const raw = normalizeModelScoreResponse({
      handwrittenGateResults: [{ item: '日语', met: true, reason: 'N1' }],
      concerns: ['行业经验短']
    });
    assert.equal(raw.parseError, true);
    assert.match(raw.error, /matchScore/);
    assert.equal(isScoreFailure(raw), true);
    const composed = composeFinalScore(raw, [], []);
    assert.equal(composed.level, '错误');
    assert.match(scoreFailureMessage(composed), /matchScore/);
  });

  it('fails any configured handwritten gate omitted by the model', () => {
    const results = ensureHandwrittenGateResults({
      handwrittenGateResults: [
        { item: '日语 N1', met: true, reason: 'JLPT N1' }
      ]
    }, ['日语 N1', '会使用 Photoshop']);
    assert.deepEqual(results.handwrittenGateResults, [
      { item: '日语 N1', met: true, reason: 'JLPT N1' },
      { item: '会使用 Photoshop', met: false, reason: '简历未提供可核对证据' }
    ]);
  });

  it('treats any configured bonus keyword omitted by the model as not met', () => {
    const result = ensureBonusKeywordResults({
      bonusKeywordResults: [
        { item: '作品集', met: true, reason: '附有作品集' }
      ]
    }, ['作品集', '海外经历']);
    assert.deepEqual(result.bonusKeywordResults, [
      { item: '作品集', met: true, reason: '附有作品集' },
      { item: '海外经历', met: false, reason: '简历未提供可核对证据' }
    ]);
  });
});

describe('dimensionScoringNotes', () => {
  it('caps adjacent internships below 60 for intern jobs', () => {
    const notes = dimensionScoringNotes('intern');
    assert.match(notes, /36\s*[–\-至到]\s*55|不得\s*[≥>=]\s*60|不超过\s*55/);
    assert.match(notes, /行政/);
    assert.match(notes, /对口/);
  });

  it('tells the model that recruitment-support inside an admin intern is adjacent, not core HR', () => {
    const notes = dimensionScoringNotes('intern');
    assert.match(notes, /招聘/);
    assert.match(notes, /HR|人力/);
  });

  it('still uses a core-vs-adjacent rule for full-time jobs', () => {
    const notes = dimensionScoringNotes('full-time');
    assert.match(notes, /主责|对口|相邻|辅助/);
  });

  it('keeps same-direction but incomplete ads experience around mid scores, not 20', () => {
    const notes = dimensionScoringNotes('full-time');
    assert.match(notes, /45\s*[–\-至到]\s*60|不得低于\s*45/);
    assert.match(notes, /Meta|渠道/);
    assert.match(notes, /教育/);
    assert.match(notes, /40/);
  });
});

describe('matchScoreDisplayText', () => {
  it('shows experience match only when a gate lowers the decision score', () => {
    const text = matchScoreDisplayText({
      score: 42,
      matchScore: 90,
      level: '不建议推进',
      advanceReason: 'gate'
    });
    assert.equal(text, '经历匹配 90');
  });

  it('hides duplicate match score when gates pass', () => {
    assert.equal(matchScoreDisplayText({
      score: 72,
      matchScore: 72,
      level: '可推进',
      advanceReason: 'ok'
    }), '');
  });

  it('hides the match score for match-based rejection', () => {
    assert.equal(matchScoreDisplayText({
      score: 32,
      matchScore: 32,
      level: '不建议推进',
      advanceReason: 'match'
    }), '');
  });

  it('hides the match score for failed scoring', () => {
    const failed = composeFinalScore(scoreErrorResult('429 请求过于频繁'), [], []);
    assert.equal(failed.level, '错误');
    assert.equal(matchScoreDisplayText(failed), '');
  });
});

describe('scoreFailureMessage', () => {
  it('surfaces the underlying error text for failed scoring', () => {
    const failed = composeFinalScore(scoreErrorResult('429 请求过于频繁'), [], []);
    assert.equal(scoreFailureMessage(failed), '429 请求过于频繁');
  });

  it('returns empty for a normal score', () => {
    const ok = composeFinalScore({ matchScore: 72 }, [], []);
    assert.equal(scoreFailureMessage(ok), '');
  });
});

describe('mustHaveExtractionGuide', () => {
  it('keeps mustHaves verifiable and sends attitude traits to nice-to-haves', () => {
    const g = mustHaveExtractionGuide();
    assert.match(g, /mustHaves/);
    assert.match(g, /真诚|态度|品格/);
    assert.match(g, /niceToHaves/);
    assert.match(g, /最多 5 条/);
  });
});

describe('classifyLlmJsonFailure', () => {
  it('accepts an object that already has matchScore or dimensions', () => {
    assert.equal(classifyLlmJsonFailure('', { matchScore: 70 }), null);
    assert.equal(classifyLlmJsonFailure('', { dimensions: { experience: { score: 60 } } }), null);
  });

  it('flags a parsed object that has neither matchScore nor dimensions', () => {
    assert.equal(classifyLlmJsonFailure('{"highlights":[]}', { highlights: [] }), 'missing-field');
  });

  it('flags truncated JSON when braces are unclosed', () => {
    assert.equal(classifyLlmJsonFailure('{"matchScore": 70, "highlights": [', null), 'truncated');
  });

  it('flags non-json when the model returned prose', () => {
    assert.equal(classifyLlmJsonFailure('I cannot score this resume.', null), 'non-json');
    assert.equal(classifyLlmJsonFailure('', null), 'non-json');
  });
});

describe('scoreParseFailureMessage', () => {
  it('names the three failure kinds in recruiter-facing Chinese', () => {
    assert.match(scoreParseFailureMessage('truncated'), /截断/);
    assert.match(scoreParseFailureMessage('missing-field'), /matchScore/);
    assert.match(scoreParseFailureMessage('non-json'), /JSON/);
  });
});

describe('jdParseFailureMessage', () => {
  it('tells the recruiter what went wrong with the JD reading, not with scoring', () => {
    assert.match(jdParseFailureMessage('truncated'), /截断/);
    assert.match(jdParseFailureMessage('non-json'), /JSON/);
    assert.doesNotMatch(jdParseFailureMessage('truncated'), /matchScore|重评/);
  });
});

describe('jobJdLooksEmpty', () => {
  // Moka 上有些职位只挂了职位名，没写岗位描述。这种 JD 送给模型只会换回一个空壳，
  // 界面上表现为「模型没解读出岗位信息」，其实是 JD 本身没内容。
  it('treats a title-and-department-only JD as empty', () => {
    assert.equal(jobJdLooksEmpty('职位: 党务经理（外联方向）\n\n部门: 党群工作部'), true);
    assert.equal(jobJdLooksEmpty('职位: 党务经理（外联方向）\n\n岗位描述与要求:\n'), true);
    assert.equal(jobJdLooksEmpty(''), true);
  });

  it('accepts a JD that carries a real description or requirement list', () => {
    assert.equal(jobJdLooksEmpty(
      '职位: 党务经理\n\n部门: 党群工作部\n\n岗位描述与要求:\n'
      + '负责党支部日常事务、组织生活会与党员发展材料整理，配合工会开展外联活动。'
    ), false);
    assert.equal(jobJdLooksEmpty(
      '职位: 党务经理\n\n硬性/加分要求:\n中共党员，本科及以上学历，2 年以上党务工作经验'
    ), false);
  });
});

describe('legacy scoring exports', () => {
  it('does not export weight penalties or the recruiter-weight prompt', () => {
    const score = require('../lib/score.js');
    assert.equal(score.penaltyForUnmet, undefined);
    assert.equal(score.bonusForMetNice, undefined);
    assert.equal(score.weightsPromptBlock, undefined);
    assert.equal(score.TIER_PENALTY, undefined);
    assert.equal(score.NICE_BONUS_PER, undefined);
    assert.equal(score.normalizeWeightPercents, undefined);
    assert.equal(score.normalizeWeightRatios, undefined);
  });
});
