const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFeedbackEntry,
  sanitizeSnapshot,
  getFeedbackVerdict,
  getFeedbackEntry,
  feedbackSyncState,
  mokaActionIntent,
  isSyncedFeedback,
  getFeedbackForJob,
  putFeedback,
  summarizeFeedback,
  feedbackCsvLabel,
  normalizeVerdict,
  buildFeedbackContext,
  feedbackRevision,
  buildFeedbackBundle,
  feedbackPromptBlock,
  feedbackEntryToResultView,
  listDecidedResultViews,
  resultViewToCsvItem,
  FEEDBACK_TTL_MS,
  FEEDBACK_LIMIT_PER_JOB
} = require('../lib/feedback.js');

describe('normalizeVerdict', () => {
  it('accepts recommend and eliminate', () => {
    assert.equal(normalizeVerdict('recommend'), 'recommend');
    assert.equal(normalizeVerdict('eliminate'), 'eliminate');
  });

  it('maps legacy positive/negative', () => {
    assert.equal(normalizeVerdict('positive'), 'recommend');
    assert.equal(normalizeVerdict('negative'), 'eliminate');
  });
});

describe('sanitizeFeedbackEntry', () => {
  it('accepts valid recommend entries', () => {
    const entry = sanitizeFeedbackEntry({
      verdict: 'recommend',
      savedAt: 100,
      updatedAt: 200,
      snapshot: { score: 72, level: '值得推荐' }
    });
    assert.equal(entry.verdict, 'recommend');
    assert.equal(entry.savedAt, 100);
    assert.equal(entry.updatedAt, 200);
    assert.equal(entry.snapshot.score, 72);
  });

  it('normalizes legacy positive to recommend', () => {
    const entry = sanitizeFeedbackEntry({
      verdict: 'positive',
      savedAt: 100,
      updatedAt: 200,
      snapshot: {}
    });
    assert.equal(entry.verdict, 'recommend');
  });

  it('rejects invalid verdicts', () => {
    assert.equal(sanitizeFeedbackEntry({ verdict: 'maybe' }), null);
    assert.equal(sanitizeFeedbackEntry(null), null);
  });
});

describe('putFeedback', () => {
  it('upserts and toggles off with null verdict', () => {
    const now = 1_000_000;
    let record = {};
    record = putFeedback(record, 'job-1', 'app-1', 'recommend', { score: 80 }, now);
    assert.equal(getFeedbackVerdict(record, 'job-1', 'app-1'), 'recommend');

    record = putFeedback(record, 'job-1', 'app-1', null, null, now + 1);
    assert.equal(getFeedbackVerdict(record, 'job-1', 'app-1'), null);
    assert.equal(record['job-1'], undefined);
  });

  it('keeps savedAt on update and refreshes updatedAt', () => {
    const t0 = 1_000_000;
    const t1 = t0 + 5000;
    let record = putFeedback({}, 'job-1', 'app-1', 'eliminate', { score: 40 }, t0);
    record = putFeedback(record, 'job-1', 'app-1', 'eliminate', { score: 38 }, t1);
    const entry = getFeedbackForJob(record, 'job-1')['app-1'];
    assert.equal(entry.savedAt, t0);
    assert.equal(entry.updatedAt, t1);
    assert.equal(entry.snapshot.score, 38);
  });

  it('prunes expired entries per job', () => {
    const now = 10_000_000;
    const record = {
      'job-1': {
        stale: sanitizeFeedbackEntry({
          verdict: 'recommend',
          savedAt: now - FEEDBACK_TTL_MS - 1,
          updatedAt: now - FEEDBACK_TTL_MS - 1,
          snapshot: {}
        }),
        fresh: sanitizeFeedbackEntry({
          verdict: 'eliminate',
          savedAt: now - 1000,
          updatedAt: now - 1000,
          snapshot: {}
        })
      }
    };
    const next = putFeedback(record, 'job-1', 'app-new', 'recommend', {}, now);
    const bag = getFeedbackForJob(next, 'job-1');
    assert.equal(bag.stale, undefined);
    assert.ok(bag.fresh);
    assert.ok(bag['app-new']);
  });

  it('caps entries per job by updatedAt', () => {
    const now = 20_000_000;
    let record = {};
    for (let i = 0; i < FEEDBACK_LIMIT_PER_JOB + 5; i++) {
      record = putFeedback(record, 'job-cap', 'app-' + i, 'recommend', {}, now + i);
    }
    const bag = getFeedbackForJob(record, 'job-cap');
    assert.equal(Object.keys(bag).length, FEEDBACK_LIMIT_PER_JOB);
    assert.ok(bag['app-' + (FEEDBACK_LIMIT_PER_JOB + 4)]);
    assert.equal(bag['app-0'], undefined);
  });
});

describe('summarizeFeedback', () => {
  it('counts recommend and eliminate labels', () => {
    let record = {};
    record = putFeedback(record, 'j1', 'a1', 'recommend', {}, 1);
    record = putFeedback(record, 'j1', 'a2', 'recommend', {}, 2);
    record = putFeedback(record, 'j1', 'a3', 'eliminate', {}, 3);
    assert.deepEqual(summarizeFeedback(record, 'j1'), {
      total: 3,
      recommend: 2,
      eliminate: 1,
      positive: 2,
      negative: 1
    });
  });
});

describe('feedbackCsvLabel', () => {
  it('maps verdicts to export labels', () => {
    assert.equal(feedbackCsvLabel('recommend'), '推荐给用人部门');
    assert.equal(feedbackCsvLabel('eliminate'), '淘汰');
    assert.equal(feedbackCsvLabel('positive'), '推荐给用人部门');
    assert.equal(feedbackCsvLabel('negative'), '淘汰');
    assert.equal(feedbackCsvLabel(null), '');
  });
});

describe('buildFeedbackContext', () => {
  it('returns empty string when no feedback exists', () => {
    assert.equal(buildFeedbackContext({}, 'job-x'), '');
  });

  it('summarizes recommend and eliminate examples with decision and match scores', () => {
    let record = putFeedback(
      {},
      'job-1',
      'a1',
      'recommend',
      {
        score: 68,
        matchScore: 68,
        level: '可推进',
        highlights: ['有 Meta 投放经验']
      },
      1
    );
    record = putFeedback(
      record,
      'job-1',
      'a2',
      'eliminate',
      {
        score: 45,
        matchScore: 45,
        level: '不建议推进',
        concerns: ['无对口实习']
      },
      2
    );
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /推荐给用人部门/);
    assert.match(ctx, /决策分 68/);
    assert.match(ctx, /经历匹配 68/);
    assert.match(ctx, /Meta 投放/);
    assert.match(ctx, /淘汰/);
    assert.match(ctx, /无对口实习/);
    assert.doesNotMatch(ctx, /综合分/);
  });

  it('prefers mismatch samples over newer agreeing ones', () => {
    let record = putFeedback(
      {},
      'job-1',
      'agree-new',
      'recommend',
      {
        score: 80,
        matchScore: 80,
        pluginRecommend: true,
        highlights: ['新的一致推荐']
      },
      90
    );
    record = putFeedback(
      record,
      'job-1',
      'agree-2',
      'recommend',
      {
        score: 79,
        matchScore: 79,
        pluginRecommend: true,
        highlights: ['也是一致']
      },
      80
    );
    record = putFeedback(
      record,
      'job-1',
      'agree-3',
      'recommend',
      {
        score: 78,
        matchScore: 78,
        pluginRecommend: true,
        highlights: ['还是一致']
      },
      70
    );
    record = putFeedback(
      record,
      'job-1',
      'under-old',
      'recommend',
      {
        score: 42,
        matchScore: 42,
        pluginRecommend: false,
        highlights: ['当时插件未推的人']
      },
      10
    );
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /当时插件未推的人/);
    assert.match(ctx, /当时插件未推/);
  });

  it('mentions bonus keywords when they were configured', () => {
    const record = putFeedback(
      {},
      'job-1',
      'a1',
      'eliminate',
      {
        score: 81,
        matchScore: 78,
        level: '优先推进',
        bonusMetCount: 1,
        bonusTotalCount: 2,
        bonusPromoted: true,
        pluginRecommend: true,
        concerns: ['稳定性一般']
      },
      1
    );
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /加分看 1\/2/);
    assert.match(ctx, /加分晋级/);
  });

  it('prefixes full-job aggregate stats while still listing at most 3 examples per side', () => {
    let record = {};
    for (let i = 0; i < 5; i++) {
      record = putFeedback(
        record,
        'job-1',
        'e' + i,
        'eliminate',
        {
          score: 72,
          matchScore: 72,
          pluginRecommend: true,
          hardMissing: ['缺「日语 N1」'],
          concerns: ['无达人合作']
        },
        100 + i
      );
    }
    for (let i = 0; i < 4; i++) {
      record = putFeedback(
        record,
        'job-1',
        'r' + i,
        'recommend',
        {
          score: 80,
          matchScore: 80,
          pluginRecommend: true,
          highlights: ['业务对口' + i]
        },
        200 + i
      );
    }
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /本岗已决策 9（推荐 4 · 淘汰 5）/);
    assert.match(ctx, /插件推你却淘汰 5/);
    assert.match(ctx, /反复信号：/);
    assert.match(ctx, /未过门槛「日语 N1」×5/);
    assert.match(ctx, /淘汰原因「无达人合作」×5/);
    const numbered = ctx.split('\n').filter((line) => /^\d+\. /.test(line));
    assert.equal(numbered.length, 6);
    assert.match(ctx, /业务对口3/);
    assert.doesNotMatch(ctx, /业务对口0/);
  });
});

describe('feedbackRevision', () => {
  it('returns none when job has no feedback', () => {
    assert.equal(feedbackRevision({}, 'job-1'), 'none');
  });

  it('changes when feedback is added', () => {
    const a = feedbackRevision(putFeedback({}, 'job-1', 'a1', 'recommend', {}, 1), 'job-1');
    const b = feedbackRevision(putFeedback({}, 'job-1', 'a1', 'eliminate', {}, 2), 'job-1');
    assert.notEqual(a, b);
    assert.notEqual(a, 'none');
  });
});

describe('buildFeedbackBundle', () => {
  it('combines context, revision and counts', () => {
    let record = putFeedback({}, 'job-9', 'a1', 'recommend', { score: 70 }, 1);
    const bundle = buildFeedbackBundle(record, 'job-9');
    assert.ok(bundle.context);
    assert.notEqual(bundle.rev, 'none');
    assert.equal(bundle.total, 1);
    assert.equal(bundle.recommend, 1);
    assert.equal(bundle.positive, 1);
  });
});

describe('feedbackPromptBlock', () => {
  it('returns empty for blank context', () => {
    assert.equal(feedbackPromptBlock(''), '');
    assert.equal(feedbackPromptBlock('   '), '');
  });

  it('wraps context with scoring instructions', () => {
    const block = feedbackPromptBlock('示例偏好');
    assert.match(block, /招聘官历史偏好/);
    assert.match(block, /示例偏好/);
    assert.match(block, /开头是全岗统计/);
    assert.match(block, /不要机械复制历史分数/);
    assert.match(block, /不要把加分项写入 matchScore/);
    assert.doesNotMatch(block, /上调相关维度/);
    assert.doesNotMatch(block, /综合分/);
  });
});

describe('feedback sync state', () => {
  it('tracks pending and failed Moka sync separately from synced decisions', () => {
    let record = {};
    record = putFeedback(record, 'job1', 'a1', 'recommend', { score: 70 }, 100, {
      mokaSynced: false
    });
    let entry = getFeedbackEntry(record, 'job1', 'a1');
    assert.equal(feedbackSyncState(entry), 'pending');
    assert.equal(isSyncedFeedback(entry), false);

    record = putFeedback(record, 'job1', 'a1', 'recommend', { score: 70 }, 200, {
      mokaSynced: true
    });
    entry = getFeedbackEntry(record, 'job1', 'a1');
    assert.equal(feedbackSyncState(entry), 'synced');
    assert.equal(isSyncedFeedback(entry), true);

    record = putFeedback(record, 'job1', 'a2', 'eliminate', { score: 40 }, 300, {
      mokaSynced: false,
      syncFailed: true
    });
    entry = getFeedbackEntry(record, 'job1', 'a2');
    assert.equal(feedbackSyncState(entry), 'failed');
  });
});

describe('bonus scoring feedback snapshot', () => {
  it('keeps bonus explanation fields when a decided candidate is restored from history', () => {
    const record = putFeedback(
      {},
      'job1',
      'a1',
      'recommend',
      {
        score: 81,
        baseScore: 78,
        level: '优先推进',
        bonusApplied: 3,
        bonusMetCount: 1,
        bonusTotalCount: 2,
        bonusPromoted: true,
        bonusKeywordResults: [
          { item: '作品集', met: true, reason: '附有作品集' },
          { item: '海外经历', met: false, reason: '未提及' }
        ]
      },
      100
    );
    const view = feedbackEntryToResultView('a1', getFeedbackEntry(record, 'job1', 'a1'));
    assert.equal(view.score.matchScore, 78);
    assert.equal(view.score.bonusApplied, 3);
    assert.equal(view.score.bonusPromoted, true);
    assert.deepEqual(view.score.bonusKeywordResults, [
      { item: '作品集', met: true, reason: '附有作品集' },
      { item: '海外经历', met: false, reason: '未提及' }
    ]);
  });
});

describe('mokaActionIntent', () => {
  it('未做过决定时是首次提交', () => {
    assert.equal(mokaActionIntent(null, 'recommend'), 'submit');
  });

  it('改判成另一个结论时也是提交', () => {
    const record = putFeedback({}, 'job1', 'a1', 'eliminate', { score: 40 }, 100);
    assert.equal(mokaActionIntent(getFeedbackEntry(record, 'job1', 'a1'), 'recommend'), 'submit');
  });

  it('已同步成功后再点同一个按钮才是撤销', () => {
    const record = putFeedback({}, 'job1', 'a1', 'recommend', { score: 70 }, 100);
    assert.equal(mokaActionIntent(getFeedbackEntry(record, 'job1', 'a1'), 'recommend'), 'cancel');
  });

  it('同步失败后再点同一个按钮是重试，而不是把本地记录清掉', () => {
    const record = putFeedback({}, 'job1', 'a1', 'recommend', { score: 70 }, 100, {
      mokaSynced: false,
      syncFailed: true
    });
    assert.equal(mokaActionIntent(getFeedbackEntry(record, 'job1', 'a1'), 'recommend'), 'retry');
  });

  it('仍在同步中（未收到结果）时再点也是重试', () => {
    const record = putFeedback({}, 'job1', 'a1', 'recommend', { score: 70 }, 100, {
      mokaSynced: false
    });
    assert.equal(mokaActionIntent(getFeedbackEntry(record, 'job1', 'a1'), 'recommend'), 'retry');
  });
});

describe('buildFeedbackContext mismatch hints', () => {
  it('notes when recommend feedback disagreed with plugin recommend flag', () => {
    let record = putFeedback(
      {},
      'job-1',
      'a1',
      'recommend',
      {
        score: 42,
        level: '一般',
        pluginRecommend: false,
        highlights: ['有潜力']
      },
      1
    );
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /当时插件未推/);
  });

  it('notes when eliminate feedback disagreed with plugin recommend flag', () => {
    let record = putFeedback(
      {},
      'job-1',
      'a2',
      'eliminate',
      {
        score: 72,
        level: '可推进',
        pluginRecommend: true,
        concerns: ['行业不对口']
      },
      1
    );
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /当时插件曾推/);
  });
});

describe('sanitizeSnapshot', () => {
  it('extracts dimension scores from nested dims', () => {
    const snap = sanitizeSnapshot({
      dims: {
        experience: { score: 70 },
        skill: { score: 80 }
      },
      pluginRecommend: true
    });
    assert.deepEqual(snap.dims, { experience: 70, skill: 80 });
    assert.equal(snap.pluginRecommend, true);
  });

  it('keeps candidate name and education fields for history display', () => {
    const snap = sanitizeSnapshot({
      name: '郝月',
      meta: '本科 · 北大 · 设计',
      highestDegree: '本科',
      highestDegreeSchool: '北大',
      score: 66
    });
    assert.equal(snap.name, '郝月');
    assert.equal(snap.meta, '本科 · 北大 · 设计');
    assert.equal(snap.highestDegree, '本科');
    assert.equal(snap.highestDegreeSchool, '北大');
  });
});

describe('listDecidedResultViews', () => {
  it('merges live views with history-only feedback entries', () => {
    let record = putFeedback(
      {},
      'job-1',
      'live-1',
      'recommend',
      {
        name: '在场',
        score: 80,
        level: '值得推荐'
      },
      100
    );
    record = putFeedback(
      record,
      'job-1',
      'old-2',
      'eliminate',
      {
        name: '历史同学',
        score: 40,
        level: '不太匹配',
        meta: '硕士 · 复旦'
      },
      200
    );

    const live = [
      {
        id: 'live-1',
        name: '在场更新名',
        meta: '本科',
        hardPassed: true,
        structuredHardPassed: true,
        hardMissing: [],
        keywords: { hit: [], miss: [] },
        score: { score: 82, level: '值得推荐' },
        feedback: 'recommend',
        feedbackSync: 'synced'
      }
    ];

    const views = listDecidedResultViews(live, record, 'job-1');
    assert.equal(views.length, 2);
    assert.equal(views[0].id, 'old-2');
    assert.equal(views[0].name, '历史同学');
    assert.equal(views[0].fromHistory, true);
    assert.equal(views[0].feedback, 'eliminate');
    assert.equal(views[1].id, 'live-1');
    assert.equal(views[1].name, '在场更新名');
    assert.equal(views[1].fromHistory, false);
  });

  it('builds csv items from decided views', () => {
    const view = feedbackEntryToResultView(
      '9',
      sanitizeFeedbackEntry({
        verdict: 'recommend',
        savedAt: 1,
        updatedAt: 1,
        snapshot: {
          name: '李四',
          highestDegree: '硕士',
          highestDegreeSchool: '交大',
          score: 70,
          level: '值得推荐',
          dims: { skill: 75 },
          highlights: ['稳'],
          concerns: ['跳槽']
        }
      })
    );
    const item = resultViewToCsvItem(view);
    assert.equal(item.app.name, '李四');
    assert.equal(item.app.highestDegree, '硕士');
    assert.equal(item.score.score, 70);
    assert.equal(item.rawScore.highlights[0], '稳');
  });
});
