const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatExperienceList,
  evaluateHardConditions,
  buildJobJD,
  stripHtml
} = require('../lib/candidate-profile.js');

describe('formatExperienceList', () => {
  it('renders org, title and dates without dropping internships', () => {
    const text = formatExperienceList([
      {
        company: '某某党委',
        title: '党务助理',
        startDate: '2024-01',
        endDate: '2024-07',
        summary: '组织生活会材料'
      }
    ]);
    assert.match(text, /某某党委/);
    assert.match(text, /党务助理/);
    assert.match(text, /组织生活会材料/);
  });
});

describe('evaluateHardConditions', () => {
  it('fails configured structured gates when the resume has empty fields', () => {
    const result = evaluateHardConditions(
      { highestDegree: '', intelligentTags: [], gender: '', age: null, experience: 0 },
      {
        degree: '本科',
        gender: '女',
        ageRanges: [{ min: 20, max: 25, label: '20-25' }]
      },
      'full-time'
    );
    assert.deepEqual(result.missing, ['学历需本科及以上', '性别需女', '年龄需 20-25']);
  });
});

describe('buildJobJD', () => {
  it('puts the job title first so later parsing can check emptiness', () => {
    const jd = buildJobJD({
      job: { title: '党务经理', departmentName: '党群', description: '<p>负责党员发展</p>' }
    });
    assert.match(jd, /^职位: 党务经理/);
    assert.match(jd, /负责党员发展/);
  });
});

describe('stripHtml', () => {
  it('drops tags without requiring a DOM', () => {
    assert.equal(stripHtml('<p>hello <b>world</b></p>'), 'hello world');
  });
});
