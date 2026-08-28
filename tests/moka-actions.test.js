const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normText,
  matchesTexts,
  ownText,
  scoreActionMatch,
  TEXT
} = require('../lib/moka-actions.js');

describe('moka-actions text helpers', () => {
  it('normalizes whitespace in labels', () => {
    assert.equal(normText('  推荐给用人部门  '), '推荐给用人部门');
  });

  it('matches partial button labels', () => {
    assert.equal(matchesTexts('推荐给用人部门', TEXT.recommendTrigger, true), true);
    assert.equal(matchesTexts('推荐并进入用人部门筛选', TEXT.recommendConfirm, true), true);
    assert.equal(matchesTexts('淘汰', TEXT.eliminate, true), true);
  });
});

describe('scoreActionMatch', () => {
  function mockEl(label, opts) {
    const o = opts || {};
    return {
      tagName: o.tagName || 'DIV',
      classList: { contains: (c) => c === (o.className || '') },
      getAttribute: (k) => (k === 'role' ? o.role : null),
      childNodes: [{ nodeType: 3, textContent: label }],
      textContent: label,
      getBoundingClientRect: () => ({
        left: o.left == null ? 900 : o.left,
        top: o.top == null ? 200 : o.top,
        width: 80,
        height: 32
      }),
      ownerDocument: { defaultView: { innerWidth: 1440 } }
    };
  }

  it('prefers exact 淘汰 on the right-side button over resume text hit', () => {
    const resumeHit = mockEl('曾参与末位淘汰考核', { left: 120, tagName: 'SPAN' });
    const actionBtn = mockEl('淘汰', { tagName: 'BUTTON', left: 980 });
    const resumeScore = scoreActionMatch(resumeHit, TEXT.eliminate, { partial: true, actionPanel: true });
    const btnScore = scoreActionMatch(actionBtn, TEXT.eliminate, { partial: false, actionPanel: true });
    assert.ok(resumeScore >= 0);
    assert.ok(btnScore > resumeScore);
  });

  it('reads direct text nodes via ownText', () => {
    const el = mockEl('淘汰', { tagName: 'BUTTON' });
    assert.equal(ownText(el), '淘汰');
  });
});
