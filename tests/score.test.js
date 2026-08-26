const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  composeFinalScore,
  scoreErrorResult,
  hardConditionsPromptBlock,
  dimensionScoringNotes,
  mustHaveExtractionGuide,
  PROMPT_VERSION
} = require('../lib/score.js');

const WEIGHTS = { experience: 0.4, skill: 0.3, education: 0.2, potential: 0.1 };

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

describe('composeFinalScore', () => {
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
    const result = composeFinalScore(raw, WEIGHTS, new Set());
    assert.equal(result.level, '错误');
    assert.equal(result.score, 0);
    assert.equal(result.dims, null);
    assert.match(result.suggestions[0], /解析失败|评分失败|无法解析/);
  });

  it('treats missing API key style result as 错误, not ~50 值得推荐', () => {
    const raw = scoreErrorResult('未配置 API Key');
    const result = composeFinalScore(raw, WEIGHTS, new Set());
    assert.equal(result.level, '错误');
    assert.equal(result.score, 0);
  });

  it('still computes weighted score for a valid dimension result', () => {
    // 80*0.4 + 70*0.3 + 60*0.2 + 50*0.1 = 32+21+12+5 = 70
    const result = composeFinalScore(okRaw(), WEIGHTS, new Set());
    assert.equal(result.score, 70);
    assert.equal(result.baseScore, 70);
    assert.equal(result.level, '值得推荐');
    assert.equal(result.penalty, 0);
    assert.deepEqual(result.highlights, ['有相关项目']);
    assert.deepEqual(result.concerns, ['行业经验短']);
  });

  it('subtracts 5 per unmet must-have and caps at 20', () => {
    const raw = okRaw({
      mustHaveResults: [
        { item: 'Java', met: false },
        { item: 'Spring', met: false },
        { item: 'MySQL', met: false },
        { item: 'Redis', met: false },
        { item: 'K8s', met: false }
      ]
    });
    const result = composeFinalScore(raw, WEIGHTS, new Set());
    assert.equal(result.baseScore, 70);
    assert.equal(result.penalty, 20);
    assert.equal(result.score, 50);
    assert.equal(result.level, '值得推荐');
    assert.equal(result.unmet.length, 5);
  });

  it('adds waived must-have points back without touching structured misses', () => {
    const raw = okRaw({
      mustHaveResults: [
        { item: 'Java', met: false },
        { item: 'SEO', met: false }
      ]
    });
    const waived = composeFinalScore(raw, WEIGHTS, new Set(['Java']));
    assert.equal(waived.penalty, 5);
    assert.equal(waived.score, 65);
    assert.deepEqual(waived.unmet.map((r) => r.item), ['SEO']);
    assert.deepEqual(waived.waivedUnmet.map((r) => r.item), ['Java']);

    const withDegree = composeFinalScore(raw, WEIGHTS, new Set(['Java', 'SEO']), ['学历需本科及以上']);
    assert.equal(withDegree.penalty, 5);
    assert.equal(withDegree.score, 65);
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
    assert.match(block, /不要把所有维度一律打成 0/);
  });
});

describe('PROMPT_VERSION', () => {
  it('is a non-empty string so score cache can invalidate on prompt changes', () => {
    assert.equal(typeof PROMPT_VERSION, 'string');
    assert.ok(PROMPT_VERSION.length >= 1);
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

describe('mustHaveExtractionGuide', () => {
  it('keeps mustHaves verifiable and sends attitude traits to nice-to-haves', () => {
    const g = mustHaveExtractionGuide();
    assert.match(g, /mustHaves/);
    assert.match(g, /真诚|态度|品格/);
    assert.match(g, /niceToHaves/);
    assert.match(g, /最多\s*6|不超过\s*6/);
  });
});
