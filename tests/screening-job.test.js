const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeScreeningJob,
  isResumableJob,
  matchesPageJob,
  withStatus,
  SCREENING_JOB_KEY
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
