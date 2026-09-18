const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotes, changelogSection, repoWebUrl } = require('../scripts/release-notes.js');

describe('Release 说明生成（v3.6.3 起，让同事有个固定下载入口）', () => {
  const notes = buildNotes('3.6.3', 'https://example.com/org/repo');

  it('给出两条版本无关的固定链接（latest/download 下固定附件名）', () => {
    assert.match(
      notes,
      /https:\/\/example\.com\/org\/repo\/releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/
    );
    assert.match(
      notes,
      /https:\/\/example\.com\/org\/repo\/releases\/latest\/download\/moka-resume-plugin-latest\.zip/
    );
    // 固定链接里不能出现版本号，否则下次发版就失效（这是本节的全部意义）
    const latestLinks = notes.match(/releases\/latest\/download\/[^\s)]+/g) || [];
    assert.equal(latestLinks.length, 2);
    for (const link of latestLinks) {
      assert.doesNotMatch(link, /v?\d+\.\d+\.\d+/, `固定链接不得含版本号：${link}`);
    }
  });

  it('同时列出本版本的两个带版本号附件与用途', () => {
    assert.match(notes, /\| `moka-resume-plugin-v3\.6\.3-full\.zip` \|/);
    assert.match(notes, /\| `moka-resume-plugin-v3\.6\.3\.zip` \|/);
    assert.match(notes, /推荐/);
  });

  it('安装提示走终端命令，不教双击（macOS 会拦）', () => {
    assert.match(notes, /bash 安装开机自启\.command/);
    assert.match(notes, /不要双击/);
    assert.doesNotMatch(notes, /双击.*安装开机自启/, '不得把双击当主路径');
  });

  it('正文取自 CHANGELOG 该版本小节，且不混入相邻版本', () => {
    assert.match(notes, /补齐「本地 Bridge 怎么装」这条路/);
    assert.doesNotMatch(notes, /^## 3\.6\.2/m, '不应把上一版小节也带进来');
    assert.equal(changelogSection('3.6.3').includes('## 3.6.2'), false);
  });

  it('版本不存在时不抛异常，仍产出可用的下载段', () => {
    const empty = buildNotes('9.9.9', 'https://example.com/org/repo');
    assert.match(empty, /## 下载/);
    assert.match(empty, /releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/);
    assert.doesNotMatch(empty, /## 9\.9\.9/);
    assert.equal(changelogSection('9.9.9'), '');
  });

  it('未显式传仓库地址时回退到 origin 远端推导', () => {
    const url = repoWebUrl();
    assert.match(url, /^https:\/\/[^/]+\/.+/, 'origin 应能推导出 https 网页地址：' + url);
    assert.doesNotMatch(url, /\.git$/);
    assert.doesNotMatch(url, /^git@/);
  });
});
