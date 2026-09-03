const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { putFeedback } = require('../lib/feedback.js');
const {
  buildCalibrationReport,
  normalizeMustHaveLabel
} = require('../lib/calibrate.js');

function fill(n, fn) {
  let record = {};
  for (let i = 0; i < n; i++) record = fn(record, i);
  return record;
}

describe('buildCalibrationReport', () => {
  it('returns empty guidance when no decisions', () => {
    const report = buildCalibrationReport({}, 'job-1');
    assert.equal(report.total, 0);
    assert.equal(report.suggestions[0].id, 'empty');
    assert.equal(report.suggestions.some((s) => s.type === 'weight'), false);
  });

  it('asks for more samples when decisions are fewer than 5', () => {
    const record = fill(4, (rec, i) => putFeedback(rec, 'job-1', 'a' + i, 'eliminate', {
      score: 70,
      pluginRecommend: true,
      concerns: ['行业经验不足']
    }, 1000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.total, 4);
    assert.equal(report.overRecommend, 4);
    assert.equal(report.suggestions[0].id, 'need-more');
    assert.match(report.suggestions[0].detail, /满 5 条后/);
    assert.equal(report.suggestions.some((s) => s.type === 'addFocus' || s.type === 'weight'), false);
  });

  it('suggests adding a focus keyword when over-recommend concerns repeat', () => {
    const record = fill(6, (rec, i) => putFeedback(rec, 'job-1', 'e' + i, i === 5 ? 'recommend' : 'eliminate', i === 5
      ? { score: 80, pluginRecommend: true, highlights: ['匹配'] }
      : {
          score: 75,
          level: '可推进',
          pluginRecommend: true,
          advanceReason: 'ok',
          hardMissing: [],
          concerns: ['无达人合作']
        }, 2000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.overRecommend, 5);
    const sug = report.suggestions.find((s) => s.type === 'addFocus');
    assert.ok(sug);
    assert.equal(sug.editableValue, '无达人合作');
    assert.equal(sug.apply.focusKeyword, '无达人合作');
    assert.equal(report.suggestions.some((s) => s.type === 'weight'), false);
  });

  it('suggests addGate from repeated hardMissing on eliminate', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 'h' + i, 'eliminate', {
      score: 42,
      pluginRecommend: false,
      hardMissing: ['缺「日语 N1」'],
      concerns: ['语言不够']
    }, 4000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    const gate = report.suggestions.find((s) => s.type === 'addGate');
    assert.ok(gate);
    assert.equal(gate.editableValue, '日语 N1');
    assert.equal(gate.apply.customGate, '日语 N1');
    assert.match(gate.title, /门槛/);
  });

  it('does not auto-change dropdown gates; explains education blocks as info', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 'u' + i, 'recommend', {
      score: 42,
      matchScore: 70,
      pluginRecommend: false,
      advanceReason: 'gate',
      hardMissing: ['学历本科'],
      highlights: ['业务对口']
    }, 5000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.underRecommend, 5);
    assert.equal(report.suggestions.some((s) => s.type === 'relaxGate'), false);
    const info = report.suggestions.find((s) => s.type === 'info' && /学历/.test(s.detail + s.title));
    assert.ok(info);
    assert.equal(info.apply, null);
  });

  it('suggests dropping a bonus keyword that promoted people you then eliminated', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 'b' + i, 'eliminate', {
      score: 81,
      matchScore: 78,
      pluginRecommend: true,
      advanceReason: 'bonus',
      bonusPromoted: true,
      bonusMetCount: 1,
      bonusTotalCount: 1,
      bonusKeywordResults: [{ item: '作品集', met: true, reason: '有作品集' }],
      concerns: ['稳定性一般']
    }, 6000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    const drop = report.suggestions.find((s) => s.type === 'dropBonus');
    assert.ok(drop);
    assert.equal(drop.apply.removeBonus, '作品集');
  });

  it('suggests adding a bonus keyword from under-recommend highlights when match was already enough', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 'n' + i, 'recommend', {
      score: 42,
      matchScore: 62,
      pluginRecommend: false,
      advanceReason: 'match',
      hardMissing: [],
      bonusMetCount: 0,
      bonusTotalCount: 0,
      highlights: ['有完整作品集']
    }, 7000 + i));
    const report = buildCalibrationReport(record, 'job-1', { bonusKeywords: ['海外经历'] });
    const add = report.suggestions.find((s) => s.type === 'addBonus');
    assert.ok(add);
    assert.equal(add.apply.bonusKeyword, '有完整作品集');
  });

  it('does not suggest bonus rescue when under-recommend match was below 50', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 'm' + i, 'recommend', {
      score: 40,
      matchScore: 40,
      pluginRecommend: false,
      advanceReason: 'match',
      hardMissing: [],
      bonusMetCount: 0,
      highlights: ['有完整作品集']
    }, 8000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.suggestions.some((s) => s.type === 'addBonus'), false);
  });

  it('ranks repeated unmet gates above concerns in topSignals', () => {
    const record = fill(5, (rec, i) => putFeedback(rec, 'job-1', 's' + i, 'eliminate', {
      score: 42,
      pluginRecommend: false,
      hardMissing: ['缺「日语」'],
      concerns: ['表达一般']
    }, 9000 + i));
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.topSignals[0].text, '日语');
    assert.ok(report.topSignals[0].count >= 2);
  });
});

describe('normalizeMustHaveLabel', () => {
  it('strips 缺 and nested quotes', () => {
    assert.equal(normalizeMustHaveLabel('缺「熟悉海外」'), '熟悉海外');
    assert.equal(normalizeMustHaveLabel('缺「缺「跨文化」」'), '跨文化');
    assert.equal(normalizeMustHaveLabel('Google UAC'), 'Google UAC');
  });
});
