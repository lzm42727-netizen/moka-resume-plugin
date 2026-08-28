const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { putFeedback } = require('../lib/feedback.js');
const {
  buildCalibrationReport,
  inferDimFromText,
  bumpWeight,
  normalizeMustHaveLabel,
  WEIGHT_STEP
} = require('../lib/calibrate.js');

describe('inferDimFromText', () => {
  it('maps common phrases to dimensions', () => {
    assert.equal(inferDimFromText('实习经验偏少'), 'experience');
    assert.equal(inferDimFromText('不会用 Excel'), 'skill');
    assert.equal(inferDimFromText('非 211 本科学历'), 'education');
    assert.equal(inferDimFromText('学习潜力一般'), 'potential');
  });
});

describe('bumpWeight', () => {
  it('increases one dimension without dropping others', () => {
    const next = bumpWeight({ experience: 40, skill: 30, education: 20, potential: 10 }, 'experience', 5);
    assert.equal(next.experience, 45);
    assert.equal(next.skill, 30);
  });
});

describe('buildCalibrationReport', () => {
  it('returns empty guidance when no decisions', () => {
    const report = buildCalibrationReport({}, 'job-1', {
      weights: { experience: 40, skill: 30, education: 20, potential: 10 }
    });
    assert.equal(report.total, 0);
    assert.equal(report.suggestions[0].id, 'empty');
  });

  it('asks for more samples when decisions are few', () => {
    let record = {};
    for (let i = 0; i < 3; i++) {
      record = putFeedback(record, 'job-1', 'a' + i, 'eliminate', {
        score: 70,
        pluginRecommend: true,
        concerns: ['行业经验不足']
      }, 1000 + i);
    }
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.total, 3);
    assert.equal(report.overRecommend, 3);
    assert.equal(report.suggestions[0].id, 'need-more');
  });

  it('suggests boosting experience when AI-over-recommend is common', () => {
    let record = {};
    for (let i = 0; i < 5; i++) {
      record = putFeedback(record, 'job-1', 'e' + i, 'eliminate', {
        score: 75,
        level: '值得推荐',
        pluginRecommend: true,
        concerns: ['相关实习经验不足'],
        dims: { experience: 40, skill: 70, education: 70, potential: 70 }
      }, 2000 + i);
    }
    record = putFeedback(record, 'job-1', 'r1', 'recommend', {
      score: 80,
      pluginRecommend: true,
      highlights: ['匹配']
    }, 3000);

    const report = buildCalibrationReport(record, 'job-1', {
      weights: { experience: 40, skill: 30, education: 20, potential: 10 }
    });
    assert.equal(report.total, 6);
    assert.equal(report.overRecommend, 5);
    const boost = report.suggestions.find((s) => s.type === 'weight' && s.apply && s.apply.bump === 'experience');
    assert.ok(boost);
    assert.equal(boost.apply.weights.experience, 40 + WEIGHT_STEP);
    assert.match(boost.title, /经验/);
  });

  it('suggests mustHave from repeated hardMissing', () => {
    let record = {};
    for (let i = 0; i < 5; i++) {
      record = putFeedback(record, 'job-1', 'h' + i, 'eliminate', {
        score: 50,
        pluginRecommend: false,
        hardMissing: ['缺「Google UAC」'],
        concerns: ['投放工具不会']
      }, 4000 + i);
    }
    const report = buildCalibrationReport(record, 'job-1');
    const must = report.suggestions.find((s) => s.type === 'mustHave');
    assert.ok(must);
    assert.equal(must.editableValue, 'Google UAC');
    assert.equal(must.apply.mustHave, 'Google UAC');
    assert.equal(must.title, '加入必备项');
  });
});

describe('normalizeMustHaveLabel', () => {
  it('strips 缺 and nested quotes', () => {
    assert.equal(normalizeMustHaveLabel('缺「熟悉海外」'), '熟悉海外');
    assert.equal(normalizeMustHaveLabel('缺「缺「跨文化」」'), '跨文化');
    assert.equal(normalizeMustHaveLabel('Google UAC'), 'Google UAC');
  });
});
