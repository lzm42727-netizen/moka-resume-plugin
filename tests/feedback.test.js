const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFeedbackEntry,
  sanitizeSnapshot,
  getFeedbackVerdict,
  getFeedbackForJob,
  putFeedback,
  summarizeFeedback,
  feedbackCsvLabel,
  buildFeedbackContext,
  feedbackRevision,
  buildFeedbackBundle,
  feedbackPromptBlock,
  FEEDBACK_TTL_MS,
  FEEDBACK_LIMIT_PER_JOB
} = require('../lib/feedback.js');

describe('sanitizeFeedbackEntry', () => {
  it('accepts valid positive entries', () => {
    const entry = sanitizeFeedbackEntry({
      verdict: 'positive',
      savedAt: 100,
      updatedAt: 200,
      snapshot: { score: 72, level: '值得推荐' }
    });
    assert.equal(entry.verdict, 'positive');
    assert.equal(entry.savedAt, 100);
    assert.equal(entry.updatedAt, 200);
    assert.equal(entry.snapshot.score, 72);
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
    record = putFeedback(record, 'job-1', 'app-1', 'positive', { score: 80 }, now);
    assert.equal(getFeedbackVerdict(record, 'job-1', 'app-1'), 'positive');

    record = putFeedback(record, 'job-1', 'app-1', null, null, now + 1);
    assert.equal(getFeedbackVerdict(record, 'job-1', 'app-1'), null);
    assert.equal(record['job-1'], undefined);
  });

  it('keeps savedAt on update and refreshes updatedAt', () => {
    const t0 = 1_000_000;
    const t1 = t0 + 5000;
    let record = putFeedback({}, 'job-1', 'app-1', 'negative', { score: 40 }, t0);
    record = putFeedback(record, 'job-1', 'app-1', 'negative', { score: 38 }, t1);
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
          verdict: 'positive',
          savedAt: now - FEEDBACK_TTL_MS - 1,
          updatedAt: now - FEEDBACK_TTL_MS - 1,
          snapshot: {}
        }),
        fresh: sanitizeFeedbackEntry({
          verdict: 'negative',
          savedAt: now - 1000,
          updatedAt: now - 1000,
          snapshot: {}
        })
      }
    };
    const next = putFeedback(record, 'job-1', 'app-new', 'positive', {}, now);
    const bag = getFeedbackForJob(next, 'job-1');
    assert.equal(bag.stale, undefined);
    assert.ok(bag.fresh);
    assert.ok(bag['app-new']);
  });

  it('caps entries per job by updatedAt', () => {
    const now = 20_000_000;
    let record = {};
    for (let i = 0; i < FEEDBACK_LIMIT_PER_JOB + 5; i++) {
      record = putFeedback(record, 'job-cap', 'app-' + i, 'positive', {}, now + i);
    }
    const bag = getFeedbackForJob(record, 'job-cap');
    assert.equal(Object.keys(bag).length, FEEDBACK_LIMIT_PER_JOB);
    assert.ok(bag['app-' + (FEEDBACK_LIMIT_PER_JOB + 4)]);
    assert.equal(bag['app-0'], undefined);
  });
});

describe('summarizeFeedback', () => {
  it('counts positive and negative labels', () => {
    let record = {};
    record = putFeedback(record, 'j1', 'a1', 'positive', {}, 1);
    record = putFeedback(record, 'j1', 'a2', 'positive', {}, 2);
    record = putFeedback(record, 'j1', 'a3', 'negative', {}, 3);
    assert.deepEqual(summarizeFeedback(record, 'j1'), { total: 3, positive: 2, negative: 1 });
  });
});

describe('feedbackCsvLabel', () => {
  it('maps verdicts to export labels', () => {
    assert.equal(feedbackCsvLabel('positive'), '要沟通');
    assert.equal(feedbackCsvLabel('negative'), '不考虑');
    assert.equal(feedbackCsvLabel(null), '');
  });
});

describe('buildFeedbackContext', () => {
  it('returns empty string when no feedback exists', () => {
    assert.equal(buildFeedbackContext({}, 'job-x'), '');
  });

  it('summarizes positive and negative examples', () => {
    let record = putFeedback({}, 'job-1', 'a1', 'positive', {
      score: 68,
      level: '值得推荐',
      highlights: ['有 Meta 投放经验']
    }, 1);
    record = putFeedback(record, 'job-1', 'a2', 'negative', {
      score: 45,
      level: '一般',
      concerns: ['无对口实习']
    }, 2);
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /要沟通/);
    assert.match(ctx, /Meta 投放/);
    assert.match(ctx, /不考虑/);
    assert.match(ctx, /无对口实习/);
  });
});

describe('feedbackRevision', () => {
  it('returns none when job has no feedback', () => {
    assert.equal(feedbackRevision({}, 'job-1'), 'none');
  });

  it('changes when feedback is added', () => {
    const a = feedbackRevision(putFeedback({}, 'job-1', 'a1', 'positive', {}, 1), 'job-1');
    const b = feedbackRevision(putFeedback({}, 'job-1', 'a1', 'negative', {}, 2), 'job-1');
    assert.notEqual(a, b);
    assert.notEqual(a, 'none');
  });
});

describe('buildFeedbackBundle', () => {
  it('combines context, revision and counts', () => {
    let record = putFeedback({}, 'job-9', 'a1', 'positive', { score: 70 }, 1);
    const bundle = buildFeedbackBundle(record, 'job-9');
    assert.ok(bundle.context);
    assert.notEqual(bundle.rev, 'none');
    assert.equal(bundle.total, 1);
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
    assert.match(block, /不要机械复制历史分数/);
  });
});

describe('buildFeedbackContext mismatch hints', () => {
  it('notes when positive feedback disagreed with plugin recommend flag', () => {
    let record = putFeedback({}, 'job-1', 'a1', 'positive', {
      score: 42,
      level: '一般',
      pluginRecommend: false,
      highlights: ['有潜力']
    }, 1);
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /当时 AI 未推荐/);
  });

  it('notes when negative feedback disagreed with plugin recommend flag', () => {
    let record = putFeedback({}, 'job-1', 'a2', 'negative', {
      score: 72,
      level: '值得推荐',
      pluginRecommend: true,
      concerns: ['行业不对口']
    }, 1);
    const ctx = buildFeedbackContext(record, 'job-1');
    assert.match(ctx, /当时 AI 曾推荐/);
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
});
