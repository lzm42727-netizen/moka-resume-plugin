const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeScreeningJob,
  isResumableJob,
  matchesPageJob,
  screeningLooksActive,
  withStatus,
  SCREENING_JOB_KEY,
  formatScreeningProgress
} = require('../lib/screening-job.js');

describe('sanitizeScreeningJob', () => {
  it('keeps a valid running job and drops empty job ids', () => {
    const job = sanitizeScreeningJob({
      status: 'running',
      jobId: 'job-1',
      jobName: '运营实习',
      total: 20,
      completed: 5,
      jobType: 'intern'
    });
    assert.equal(job.status, 'running');
    assert.equal(job.jobId, 'job-1');
    assert.equal(job.jobType, 'intern');
    assert.equal(job.completed, 5);
    assert.equal(sanitizeScreeningJob({ status: 'running', jobId: '' }), null);
    assert.equal(sanitizeScreeningJob({ status: 'weird', jobId: 'x' }), null);
  });
});

describe('isResumableJob', () => {
  it('allows incomplete running / awaiting / paused jobs', () => {
    assert.equal(isResumableJob({
      status: 'running', jobId: 'j', total: 10, completed: 3
    }), true);
    assert.equal(isResumableJob({
      status: 'awaiting_resume', jobId: 'j', total: 10, completed: 3
    }), true);
    assert.equal(isResumableJob({
      status: 'done', jobId: 'j', total: 10, completed: 10
    }), false);
    assert.equal(isResumableJob({
      status: 'running', jobId: 'j', total: 10, completed: 10
    }), false);
  });
});

describe('screeningLooksActive', () => {
  it('treats a flag-on run with no heartbeat for 90s+ as dead', () => {
    const now = 1_000_000;
    // 心跳 91 秒前 → 已超过 90s 阈值 → 判死，侧栏才能重新开筛
    assert.equal(screeningLooksActive(true, now - 91_000, now), false);
    // 心跳 5 秒前 → 仍在跑
    assert.equal(screeningLooksActive(true, now - 5_000, now), true);
  });

  it('treats a just-started run without heartbeat as active', () => {
    assert.equal(screeningLooksActive(true, 0, 1_000_000), true);
  });

  it('is always false when not screening', () => {
    assert.equal(screeningLooksActive(false, Date.now(), Date.now()), false);
    assert.equal(screeningLooksActive(false, 0, 1_000_000), false);
  });

  it('honours a custom stale window', () => {
    const now = 500_000;
    assert.equal(screeningLooksActive(true, now - 20_000, now, 10_000), false);
    assert.equal(screeningLooksActive(true, now - 5_000, now, 10_000), true);
  });
});

describe('matchesPageJob / withStatus', () => {
  it('matches page job and updates status', () => {
    const job = sanitizeScreeningJob({
      status: 'running', jobId: '88', total: 5, completed: 1
    });
    assert.equal(matchesPageJob(job, '88'), true);
    assert.equal(matchesPageJob(job, '99'), false);
    const next = withStatus(job, 'awaiting_resume');
    assert.equal(next.status, 'awaiting_resume');
    assert.equal(SCREENING_JOB_KEY, 'mokaScreeningJob');
  });
});

describe('formatScreeningProgress', () => {
  const t0 = Date.parse('2026-09-03T11:00:00+08:00');

  it('names the current candidate and elapsed minutes', () => {
    const text = formatScreeningProgress({
      name: '黄芯怡',
      current: 37,
      total: 200,
      startedAt: t0,
      now: t0 + 4 * 60 * 1000
    });
    assert.equal(text, '正在评 黄芯怡（37/200）· 已用约 4 分钟');
  });

  it('says 刚开始 when less than a minute has passed', () => {
    const text = formatScreeningProgress({
      name: '李四',
      current: 1,
      total: 10,
      startedAt: t0,
      now: t0 + 20 * 1000
    });
    assert.match(text, /刚开始/);
    assert.match(text, /李四（1\/10）/);
  });

  it('omits the name when it is empty', () => {
    const text = formatScreeningProgress({
      name: '',
      current: 5,
      total: 10,
      startedAt: t0,
      now: t0 + 60 * 1000
    });
    assert.equal(text, '已评分 5/10 · 已用约 1 分钟');
  });
});
