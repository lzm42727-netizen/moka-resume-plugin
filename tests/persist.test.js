const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stableHash,
  pruneTimedMap,
  putCacheRecord,
  csvEscape,
  toCsv,
  screeningItemToRow,
  screeningToCsv,
  slimScreeningItem,
  hydrateScreeningItem,
  lastScreeningStorageKey,
  jobPresetKey,
  sanitizeJobPreset,
  putJobPreset,
  getJobPreset
} = require('../lib/persist.js');

describe('stableHash', () => {
  it('returns the same hex for the same payload', () => {
    const a = stableHash({ profile: '张三', model: 'gpt-4o' });
    const b = stableHash({ profile: '张三', model: 'gpt-4o' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('changes when the payload changes', () => {
    const a = stableHash({ profile: '张三' });
    const b = stableHash({ profile: '李四' });
    assert.notEqual(a, b);
  });
});

describe('pruneTimedMap', () => {
  it('drops expired entries and keeps the newest when over limit', () => {
    const now = 1_000_000;
    const record = {
      old: { value: 1, savedAt: now - 100 },
      mid: { value: 2, savedAt: now - 50 },
      fresh: { value: 3, savedAt: now - 10 },
      expired: { value: 9, savedAt: now - 10_000 }
    };
    const pruned = pruneTimedMap(record, now, 200, 2);
    assert.deepEqual(Object.keys(pruned).sort(), ['fresh', 'mid']);
    assert.equal(pruned.fresh.value, 3);
  });
});

describe('putCacheRecord', () => {
  it('stores a value with savedAt', () => {
    const now = 50;
    const next = putCacheRecord({}, 'abc', { score: 80 }, now, 1000, 500);
    assert.deepEqual(next.abc, { value: { score: 80 }, savedAt: 50 });
  });
});

describe('csv', () => {
  it('escapes commas and quotes for Excel', () => {
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape(78), '78');
  });

  it('builds a screening CSV with a header and one candidate', () => {
    const item = {
      app: { id: 11, name: '张三', highestDegree: '本科', highestDegreeSchool: '清华' },
      hard: { passed: false, missing: ['学历需硕士及以上'] },
      score: {
        score: 70, level: '值得推荐', penalty: 5,
        dims: {
          experience: { score: 80 }, skill: { score: 70 },
          education: { score: 60 }, potential: { score: 50 }
        }
      },
      rawScore: { highlights: ['有项目'], concerns: ['经验短'] }
    };
    const csv = screeningToCsv([item], 'https://app.mokahr.com');
    assert.match(csv, /^姓名,/);
    assert.match(csv, /张三/);
    assert.match(csv, /70/);
    assert.match(csv, /值得推荐/);
    assert.match(csv, /学历需硕士及以上/);
    assert.match(csv, /https:\/\/app\.mokahr\.com\/candidates\/application\/11/);
  });
});

describe('slim screening', () => {
  it('serializes waived Set and restores it', () => {
    const slim = slimScreeningItem({
      app: { id: 1, name: '李四', experienceInfo: [{ company: 'huge' }] },
      waivedMustHaves: new Set(['Java']),
      score: { score: 88, level: '强烈推荐' },
      rawScore: { highlights: ['稳'], dimensions: { experience: { score: 90 } } }
    });
    assert.deepEqual(slim.waivedMustHaves, ['Java']);
    assert.equal(slim.app.experienceInfo, undefined);
    const hydrated = hydrateScreeningItem(slim);
    assert.ok(hydrated.waivedMustHaves instanceof Set);
    assert.equal(hydrated.waivedMustHaves.has('Java'), true);
  });

  it('builds a storage key from pipelineId', () => {
    assert.equal(lastScreeningStorageKey('12345'), 'mokaLastScreening:12345');
  });
});

describe('job presets', () => {
  it('uses the job id as the map key', () => {
    assert.equal(jobPresetKey(' 88 '), '88');
    assert.equal(jobPresetKey(''), '');
  });

  it('keeps hard requirements, weights and chips and drops unknown fields', () => {
    const clean = sanitizeJobPreset({
      jobType: 'intern',
      hard: {
        degree: '本科',
        schools: ['211', '985'],
        exp: '1-3',
        gender: '',
        internship: 'required',
        ageRanges: [{ min: 20, max: 25, label: '20-25' }]
      },
      weights: { experience: 50, skill: 20, education: 20, potential: 10 },
      mustHaves: ['Java', 'Spring'],
      keywords: ['SEO'],
      jobSpec: { summary: 'HR 实习', mustHaves: ['沟通'], extraHuge: 'x'.repeat(100) },
      secret: 'nope'
    });
    assert.equal(clean.jobType, 'intern');
    assert.deepEqual(clean.hard.schools, ['211', '985']);
    assert.deepEqual(clean.hard.ageRangeValues, ['20-25']);
    assert.equal(clean.weights.experience, 50);
    assert.deepEqual(clean.mustHaves, ['Java', 'Spring']);
    assert.equal(clean.jobSpec.summary, 'HR 实习');
    assert.equal(clean.secret, undefined);
    assert.equal(clean.jobSpec.extraHuge, undefined);
  });

  it('round-trips a preset in the timed map and ignores empty job ids', () => {
    const preset = sanitizeJobPreset({
      jobType: 'full-time',
      hard: { degree: '硕士', schools: [], exp: '3-5', gender: '', internship: '', ageRangeValues: [] },
      weights: { experience: 40, skill: 30, education: 20, potential: 10 },
      mustHaves: ['Google UAC'],
      keywords: ['Ads']
    });
    const now = 1_000;
    let record = putJobPreset({}, 'job-9', preset, now);
    record = putJobPreset(record, '', preset, now);
    assert.equal(getJobPreset(record, 'job-9').mustHaves[0], 'Google UAC');
    assert.equal(getJobPreset(record, ''), null);
    assert.equal(Object.keys(record).includes(''), false);
  });
});
