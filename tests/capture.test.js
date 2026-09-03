const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  uniqueDetailUrls,
  mergeCapture,
  unwrapDetailJson,
  extractSceneToken,
  detailBelongsTo,
  buildSearchPageBody,
  alignSearchBodyToJob
} = require('../lib/capture.js');

const ORIGIN = 'https://app.mokahr.com';

describe('uniqueDetailUrls', () => {
  it('falls back to /api/applications/{id} when no detail template was captured', () => {
    const urls = uniqueDetailUrls({ id: 814701185 }, null, ORIGIN);
    assert.deepEqual(urls, [`${ORIGIN}/api/applications/814701185`]);
  });

  it('replaces the captured template id and keeps scene query', () => {
    const captured = {
      url: `${ORIGIN}/api/applications/11111?scene=abc`,
      method: 'GET'
    };
    const urls = uniqueDetailUrls({ id: 22222 }, captured, ORIGIN);
    assert.equal(urls[0], `${ORIGIN}/api/applications/22222?scene=abc`);
    assert.ok(urls.includes(`${ORIGIN}/api/applications/22222`));
  });

  it('also tries candidateId path when application id fetch may fail', () => {
    const captured = { url: `${ORIGIN}/api/applications/11111?scene=tok` };
    const urls = uniqueDetailUrls({ id: 22222, candidateId: 99999 }, captured, ORIGIN);
    assert.ok(urls.includes(`${ORIGIN}/api/applications/22222?scene=tok`));
    assert.ok(urls.includes(`${ORIGIN}/api/applications/99999?scene=tok`));
    assert.equal(urls.length, new Set(urls).size);
  });

  it('puts harvested scene on URLs when no detail template exists', () => {
    const urls = uniqueDetailUrls({ id: 22222 }, null, ORIGIN, 'harvested');
    assert.equal(urls[0], `${ORIGIN}/api/applications/22222?scene=harvested`);
    assert.ok(urls.includes(`${ORIGIN}/api/applications/22222`));
  });
});

describe('extractSceneToken', () => {
  it('reads scene from a query string', () => {
    assert.equal(
      extractSceneToken('https://app.mokahr.com/candidates?pipelineId=1&scene=abc123'),
      'abc123'
    );
  });

  it('reads scene from a JSON body', () => {
    assert.equal(extractSceneToken('{"pipelineId":2,"scene":"tok-1"}'), 'tok-1');
  });

  it('returns empty string when scene is absent', () => {
    assert.equal(extractSceneToken('https://app.mokahr.com/candidates'), '');
  });
});

describe('unwrapDetailJson', () => {
  it('uses the application object inside a { data } envelope', () => {
    const inner = { id: 814701185, candidateId: 99, practiceInfo: [{ company: 'X' }] };
    assert.equal(unwrapDetailJson({ code: 0, data: inner }), inner);
  });

  it('returns the object as-is when id is already at the top level', () => {
    const inner = { id: 1, candidateId: 2 };
    assert.equal(unwrapDetailJson(inner), inner);
  });

  it('unwraps data.application envelopes', () => {
    const inner = { id: 3, candidateId: 4 };
    assert.equal(unwrapDetailJson({ data: { application: inner } }), inner);
  });
});

describe('detailBelongsTo', () => {
  it('matches applicationId when top-level id is the candidate id', () => {
    const app = { id: 22222, candidateId: 99 };
    const json = { id: 99, applicationId: 22222, candidateId: 99 };
    assert.equal(detailBelongsTo(app, json), true);
  });

  it('rejects a payload with no comparable ids', () => {
    assert.equal(detailBelongsTo({ id: 1 }, { name: 'x' }), false);
  });
});

describe('buildSearchPageBody', () => {
  // Moka 列表接口靠 base64 的 lastCursor 翻页。捕获到的请求体里可能残留
  // 页面上次翻页的游标，若原样重放，第一页就会从中间开始。
  const CAPTURED = {
    pipelineId: 123,
    stageId: '17',
    jobIds: [456],
    sortKey: 'movedAt',
    limit: '30',
    lastCursor: 'STALE_CURSOR_FROM_PAGE'
  };

  it('drops the stale cursor so the first page starts from the top', () => {
    const body = buildSearchPageBody(CAPTURED, 50, null);
    assert.equal('lastCursor' in body, false);
    assert.equal('offsetInfo' in body, false);
    assert.equal(body.limit, 50);
    assert.equal(body.pipelineId, 123);
    assert.deepEqual(body.jobIds, [456]);
    assert.equal(body.sortKey, 'movedAt');
  });

  it('sends the server cursor verbatim for the next page', () => {
    const body = buildSearchPageBody(CAPTURED, 50, 'eyJhcHBsaWNhdGlvbklkIjo4MzUwODc3MjZ9');
    assert.equal(body.lastCursor, 'eyJhcHBsaWNhdGlvbklkIjo4MzUwODc3MjZ9');
    assert.equal(body.limit, 50);
  });

  it('drops legacy offsetInfo and firstCursor paging fields', () => {
    const body = buildSearchPageBody(
      { pipelineId: 1, offsetInfo: { includeThis: false }, firstCursor: 'abc', cursor: 'def' },
      50,
      null
    );
    assert.equal('offsetInfo' in body, false);
    assert.equal('firstCursor' in body, false);
    assert.equal('cursor' in body, false);
    assert.equal(body.pipelineId, 1);
  });

  it('does not mutate the captured body', () => {
    const original = { pipelineId: 9, lastCursor: 'STALE' };
    buildSearchPageBody(original, 50, 'NEW');
    assert.equal(original.lastCursor, 'STALE');
    assert.equal(original.limit, undefined);
  });
});

describe('alignSearchBodyToJob', () => {
  // SPA 里换职位时页面未必再发一次搜索，捕获体里的 jobIds 还是上一岗的。
  // 原样重放会拉回上一岗的候选人，JD 解读出来的自然也是上一岗的岗位理解。
  it('overwrites the stale captured jobIds with the job the page is on', () => {
    const body = alignSearchBodyToJob(
      { pipelineId: 123, jobIds: ['job-old'], sortKey: 'movedAt' },
      { pipelineId: '123', jobIds: ['job-new'] }
    );
    assert.deepEqual(body.jobIds, ['job-new']);
    assert.equal(body.sortKey, 'movedAt');
  });

  it('keeps the captured jobIds when the page context knows no job', () => {
    const body = alignSearchBodyToJob(
      { pipelineId: 123, jobIds: ['job-old'] },
      { pipelineId: '', jobIds: [] }
    );
    assert.deepEqual(body.jobIds, ['job-old']);
  });

  it('only fills pipelineId when the captured body has none', () => {
    assert.equal(alignSearchBodyToJob({ pipelineId: 9 }, { pipelineId: '5' }).pipelineId, 9);
    assert.equal(alignSearchBodyToJob({}, { pipelineId: '5' }).pipelineId, 5);
  });

  it('does not mutate the captured body', () => {
    const original = { pipelineId: 1, jobIds: ['job-old'] };
    alignSearchBodyToJob(original, { jobIds: ['job-new'] });
    assert.deepEqual(original.jobIds, ['job-old']);
  });
});

describe('mergeCapture', () => {
  it('keeps live capture and only fills gaps from storage', () => {
    const live = { search: { url: 'live-search' }, detail: null };
    const stored = { search: { url: 'old-search' }, detail: { url: 'stored-detail' } };
    const merged = mergeCapture(live, stored);
    assert.equal(merged.search.url, 'live-search');
    assert.equal(merged.detail.url, 'stored-detail');
  });
});
