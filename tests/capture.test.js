const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  uniqueDetailUrls,
  mergeCapture,
  unwrapDetailJson,
  extractSceneToken,
  detailBelongsTo
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

describe('mergeCapture', () => {
  it('keeps live capture and only fills gaps from storage', () => {
    const live = { search: { url: 'live-search' }, detail: null };
    const stored = { search: { url: 'old-search' }, detail: { url: 'stored-detail' } };
    const merged = mergeCapture(live, stored);
    assert.equal(merged.search.url, 'live-search');
    assert.equal(merged.detail.url, 'stored-detail');
  });
});
