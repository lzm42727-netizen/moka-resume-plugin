const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { putFeedback } = require('../lib/feedback.js');
const {
  buildCalibrationReport,
  normalizeMustHaveLabel,
  normalizeSignalDisplay,
  normalizeCalibrationSignal,
  groupCalibrationSignals
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
    assert.equal(
      report.suggestions.some((s) => s.type === 'weight'),
      false
    );
  });

  it('asks for more samples when decisions are fewer than 5', () => {
    const record = fill(4, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'a' + i,
        'eliminate',
        {
          score: 70,
          pluginRecommend: true,
          concerns: ['行业经验不足']
        },
        1000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.total, 4);
    assert.equal(report.overRecommend, 4);
    assert.equal(report.suggestions[0].id, 'need-more');
    assert.match(report.suggestions[0].detail, /满 5 条后/);
    assert.equal(
      report.suggestions.some((s) => s.type === 'addFocus' || s.type === 'weight'),
      false
    );
  });

  it('suggests adding a focus keyword when over-recommend concerns repeat', () => {
    const record = fill(6, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'e' + i,
        i === 5 ? 'recommend' : 'eliminate',
        i === 5
          ? { score: 80, pluginRecommend: true, highlights: ['匹配'] }
          : {
              score: 75,
              level: '可推进',
              pluginRecommend: true,
              advanceReason: 'ok',
              hardMissing: [],
              concerns: ['无达人合作']
            },
        2000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.overRecommend, 5);
    const sug = report.suggestions.find((s) => s.type === 'addFocus');
    assert.ok(sug);
    // 归一化后写入的是肯定式文案，不再是「无达人合作」这种否定式
    assert.equal(sug.editableValue, '达人合作');
    assert.equal(sug.apply.focusKeyword, '达人合作');
    assert.equal(
      report.suggestions.some((s) => s.type === 'weight'),
      false
    );
  });

  it('suggests addGate from repeated hardMissing on eliminate', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'h' + i,
        'eliminate',
        {
          score: 42,
          pluginRecommend: false,
          hardMissing: ['缺「日语 N1」'],
          concerns: ['语言不够']
        },
        4000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    const gate = report.suggestions.find((s) => s.type === 'addGate');
    assert.ok(gate);
    assert.equal(gate.editableValue, '日语N1');
    assert.equal(gate.apply.customGate, '日语N1');
    assert.match(gate.title, /门槛/);
    // 文案强化：只提示风险，不阻止采纳
    assert.match(gate.detail, /一票否决/);
  });

  it('does not auto-change dropdown gates; explains education blocks as info', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'u' + i,
        'recommend',
        {
          score: 42,
          matchScore: 70,
          pluginRecommend: false,
          advanceReason: 'gate',
          hardMissing: ['学历本科'],
          highlights: ['业务对口']
        },
        5000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.underRecommend, 5);
    assert.equal(
      report.suggestions.some((s) => s.type === 'relaxGate'),
      false
    );
    const info = report.suggestions.find(
      (s) => s.type === 'info' && /学历/.test(s.detail + s.title)
    );
    assert.ok(info);
    assert.equal(info.apply, null);
  });

  it('suggests dropping a bonus keyword that promoted people you then eliminated', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'b' + i,
        'eliminate',
        {
          score: 81,
          matchScore: 78,
          pluginRecommend: true,
          advanceReason: 'bonus',
          bonusPromoted: true,
          bonusMetCount: 1,
          bonusTotalCount: 1,
          bonusKeywordResults: [{ item: '作品集', met: true, reason: '有作品集' }],
          concerns: ['稳定性一般']
        },
        6000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    const drop = report.suggestions.find((s) => s.type === 'dropBonus');
    assert.ok(drop);
    assert.equal(drop.apply.removeBonus, '作品集');
  });

  it('suggests adding a bonus keyword from under-recommend highlights when match was already enough', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'n' + i,
        'recommend',
        {
          score: 42,
          matchScore: 62,
          pluginRecommend: false,
          advanceReason: 'match',
          hardMissing: [],
          bonusMetCount: 0,
          bonusTotalCount: 0,
          highlights: ['有完整作品集']
        },
        7000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1', { bonusKeywords: ['海外经历'] });
    const add = report.suggestions.find((s) => s.type === 'addBonus');
    assert.ok(add);
    assert.equal(add.apply.bonusKeyword, '有完整作品集');
  });

  it('does not suggest bonus rescue when under-recommend match was below 50', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'm' + i,
        'recommend',
        {
          score: 40,
          matchScore: 40,
          pluginRecommend: false,
          advanceReason: 'match',
          hardMissing: [],
          bonusMetCount: 0,
          highlights: ['有完整作品集']
        },
        8000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(
      report.suggestions.some((s) => s.type === 'addBonus'),
      false
    );
  });

  it('ranks repeated unmet gates above concerns in topSignals', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        's' + i,
        'eliminate',
        {
          score: 42,
          pluginRecommend: false,
          hardMissing: ['缺「日语」'],
          concerns: ['表达一般']
        },
        9000 + i
      )
    );
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

  it('折叠书写形态：中英文之间的空格、全角字符', () => {
    assert.equal(normalizeMustHaveLabel('日语 N1'), '日语N1');
    assert.equal(normalizeMustHaveLabel('缺 日语N1'), '日语N1');
    assert.equal(normalizeMustHaveLabel('未满足：日语 N1'), '日语N1');
    assert.equal(normalizeMustHaveLabel('日语\u3000N1'), '日语N1');
    assert.equal(normalizeMustHaveLabel('ＣＥＴ6'), 'CET6');
    // 纯英文词组保留原有空格，不压成一个词
    assert.equal(normalizeMustHaveLabel('Google Ads'), 'Google Ads');
  });

  it('「缺乏」不被当成「缺」前缀剥掉', () => {
    assert.equal(normalizeMustHaveLabel('缺乏沟通能力'), '缺乏沟通能力');
    assert.equal(normalizeMustHaveLabel('缺少沟通能力'), '沟通能力');
  });
});

describe('normalizeSignalDisplay', () => {
  it('只折叠形态，绝不剥语义前缀', () => {
    assert.equal(normalizeSignalDisplay('有 3 年达人合作经验'), '有3年达人合作经验');
    assert.equal(normalizeSignalDisplay('缺少甲方品牌经验'), '缺少甲方品牌经验');
    // 中文与纯英文词之间的空格保留，压成「有Meta投放经验」反而难读
    assert.equal(normalizeSignalDisplay('有 Meta 投放经验'), '有 Meta 投放经验');
    assert.equal(normalizeSignalDisplay(''), '');
  });
});

describe('normalizeCalibrationSignal / groupCalibrationSignals', () => {
  it('聚合同一含义的不同措辞，并保留原始措辞', () => {
    const grouped = groupCalibrationSignals([
      '没有达人资源',
      '缺少达人合作经验',
      '无KOL合作经验'
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].text, '达人合作');
    assert.equal(grouped[0].count, 3);
    assert.equal(grouped[0].variants.length, 3);
    assert.equal(grouped[0].polarity, 'lack');
  });

  it('完全相同文本按次数累加', () => {
    const grouped = groupCalibrationSignals(['达人合作', '达人合作', '达人合作']);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].count, 3);
  });

  it('书写形态差异不再拆散同一信号（空格 / 全角）', () => {
    const neutral = groupCalibrationSignals(['日语 N1', '日语N1', '日语\u3000Ｎ1']);
    assert.equal(neutral.length, 1);
    assert.equal(neutral[0].text, '日语N1');
    assert.equal(neutral[0].count, 3);
    assert.equal(neutral[0].polarity, 'neutral');

    const lack = groupCalibrationSignals(['缺 日语N1', '缺少 日语 N1', '未满足：日语Ｎ1']);
    assert.equal(lack.length, 1);
    assert.equal(lack[0].text, '日语N1');
    assert.equal(lack[0].count, 3);
    assert.equal(lack[0].polarity, 'lack');
  });

  it('方向保护：肯定式与否定式不归并', () => {
    const grouped = groupCalibrationSignals(['有达人合作经验', '无达人合作经验']);
    assert.equal(grouped.length, 2);
    const have = normalizeCalibrationSignal('有达人合作经验');
    const lack = normalizeCalibrationSignal('无达人合作经验');
    assert.equal(have.polarity, 'neutral');
    assert.equal(have.direction, 'have');
    assert.equal(lack.polarity, 'lack');
    assert.equal(lack.core, '达人合作');
  });

  it('不把正向修饰当噪音剥掉', () => {
    const rich = normalizeCalibrationSignal('项目经验丰富');
    const weak = normalizeCalibrationSignal('项目经验不足');
    assert.equal(rich.core, '项目经验丰富');
    assert.equal(rich.polarity, 'neutral');
    assert.equal(weak.core, '项目经验');
    assert.equal(weak.polarity, 'lack');
  });

  it('验收例 1：5 条不同措辞聚成 addFocus「达人合作」，variants 保留 5 条原文', () => {
    const concerns = [
      '没有达人资源',
      '缺少达人合作经验',
      '无KOL合作经验',
      '无达人合作',
      '达人合作不足'
    ];
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'nv' + i,
        'eliminate',
        {
          score: 75,
          level: '可推进',
          pluginRecommend: true,
          advanceReason: 'ok',
          hardMissing: [],
          concerns: [concerns[i]]
        },
        11000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    const sug = report.suggestions.find((s) => s.type === 'addFocus');
    assert.ok(sug);
    assert.equal(sug.editableValue, '达人合作');
    assert.equal(sug.evidence.count, 5);
    assert.equal(sug.evidence.variants.length, 5);
    assert.match(sug.detail, /不要求简历出现完全相同的关键词/);
  });

  it('近期优先：同一信号的 variants 按更新时间倒序保留原文（不做时间衰减权重）', () => {
    let record = {};
    record = putFeedback(
      record,
      'job-1',
      'o1',
      'eliminate',
      { pluginRecommend: false, hardMissing: [], concerns: ['无达人合作'] },
      1
    );
    record = putFeedback(
      record,
      'job-1',
      'o2',
      'eliminate',
      { pluginRecommend: false, hardMissing: [], concerns: ['缺少达人资源'] },
      2
    );
    record = putFeedback(
      record,
      'job-1',
      'o3',
      'eliminate',
      { pluginRecommend: false, hardMissing: [], concerns: ['没有KOL合作经验'] },
      3
    );
    const report = buildCalibrationReport(record, 'job-1');
    const sig = report.topConcerns.find((x) => x.text === '达人合作');
    assert.ok(sig);
    assert.equal(sig.count, 3);
    assert.equal(sig.variants[0], '没有KOL合作经验');
  });
});

describe('score-drift 诊断', () => {
  it('插件偏严：连续推荐匹配偏低且无门槛阻断的候选人', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'st' + i,
        'recommend',
        {
          score: 40,
          matchScore: 38,
          pluginRecommend: false,
          advanceReason: 'match',
          hardMissing: [],
          highlights: ['业务对口']
        },
        12000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.diagnostics.scoreDrift.direction, 'strict');
    assert.ok(report.suggestions.some((s) => s.id === 'drift-strict'));
    assert.equal(
      report.suggestions.some((s) => s.type === 'weight'),
      false
    );
  });

  it('插件偏宽：连续淘汰无门槛问题的候选人，且不再报「判断较一致」', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'ln' + i,
        i < 3 ? 'eliminate' : 'recommend',
        i < 3
          ? {
              score: 80,
              matchScore: 79,
              pluginRecommend: true,
              advanceReason: 'match',
              hardMissing: [],
              concerns: ['方向不符' + i]
            }
          : {
              score: 80,
              matchScore: 79,
              pluginRecommend: true,
              advanceReason: 'match',
              hardMissing: [],
              highlights: ['业务对口']
            },
        13000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.diagnostics.scoreDrift.direction, 'lenient');
    assert.ok(report.suggestions.some((s) => s.id === 'drift-lenient'));
    assert.equal(
      report.suggestions.some((s) => s.title === '判断较一致'),
      false
    );
    assert.equal(
      report.suggestions.some((s) => s.type === 'weight'),
      false
    );
  });

  it('无系统性偏差时不输出 drift 诊断', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'no' + i,
        i % 2 === 0 ? 'recommend' : 'eliminate',
        {
          score: 70,
          matchScore: 70,
          pluginRecommend: true,
          advanceReason: 'match',
          hardMissing: [],
          concerns: ['轻微顾虑'],
          highlights: ['业务对口']
        },
        14000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(report.diagnostics.scoreDrift.direction, 'none');
    assert.ok(report.suggestions.some((s) => s.title === '判断较一致'));
  });
});

describe('dropBonus 收紧', () => {
  it('不同加分项各 1 人晋级时不建议移除', () => {
    const items = ['作品集', '公众号', '短视频', '长视频', '播客'];
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'db' + i,
        'eliminate',
        {
          score: 81,
          matchScore: 78,
          pluginRecommend: true,
          advanceReason: 'bonus',
          bonusPromoted: true,
          bonusMetCount: 1,
          bonusTotalCount: 1,
          bonusKeywordResults: [{ item: items[i], met: true, reason: '有' + items[i] }],
          concerns: ['稳定性一般']
        },
        15000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    assert.equal(
      report.suggestions.some((s) => s.type === 'dropBonus'),
      false
    );
  });
});

describe('建议置信度 confidence', () => {
  it('高样本高集中且因果明确 → high', () => {
    const record = fill(12, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'cf' + i,
        'eliminate',
        {
          score: 42,
          pluginRecommend: false,
          hardMissing: ['缺「日语 N1」'],
          concerns: ['语言不够']
        },
        16000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    const gate = report.suggestions.find((s) => s.type === 'addGate');
    assert.ok(gate);
    assert.equal(gate.confidence, 'high');
    assert.ok(gate.evidence.count >= 5);
  });

  it('擦边样本只给 medium / low，不臆造 high', () => {
    const record = fill(5, (rec, i) =>
      putFeedback(
        rec,
        'job-1',
        'cw' + i,
        'eliminate',
        {
          score: 75,
          level: '可推进',
          pluginRecommend: true,
          advanceReason: 'ok',
          hardMissing: [],
          concerns: i < 2 ? ['无达人合作'] : ['顾虑' + i]
        },
        17000 + i
      )
    );
    const report = buildCalibrationReport(record, 'job-1');
    const sug = report.suggestions.find((s) => s.type === 'addFocus');
    assert.ok(sug);
    assert.ok(sug.confidence === 'medium' || sug.confidence === 'low');
    assert.notEqual(sug.confidence, 'high');
  });
});
