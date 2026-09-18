const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNotes,
  changelogSection,
  repoWebUrl,
  gitlabWebUrl,
  githubFixedLinks,
  gitlabFixedLinks
} = require('../scripts/release-notes.js');

const GH = 'https://example.com/org/repo';
const GL = 'https://git.example.com/group/proj';

describe('Release 说明生成（v3.6.3 起，让同事有个固定下载入口）', () => {
  const notes = buildNotes('3.6.3', { github: GH, gitlab: GL });

  it('GitHub 侧给出两条版本无关的固定链接（latest/download 下固定附件名）', () => {
    assert.match(notes, /https:\/\/example\.com\/org\/repo\/releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/);
    assert.match(notes, /https:\/\/example\.com\/org\/repo\/releases\/latest\/download\/moka-resume-plugin-latest\.zip/);
    // 固定链接里不能出现版本号，否则下次发版就失效（这是本节的全部意义）
    const latestLinks = notes.match(/releases\/latest\/download\/[^\s)]+/g) || [];
    assert.equal(latestLinks.length, 2);
    for (const link of latestLinks) {
      assert.doesNotMatch(link, /v?\d+\.\d+\.\d+/, `固定链接不得含版本号：${link}`);
    }
  });

  it('内网 GitLab 侧给出 permalink 固定链接，且排在外网之前（同事在内网）', () => {
    const glFull = GL + '/-/releases/permalink/latest/downloads/moka-resume-plugin-latest-full.zip';
    const glSlim = GL + '/-/releases/permalink/latest/downloads/moka-resume-plugin-latest.zip';
    assert.ok(notes.includes(glFull), '缺内网完整包固定链接');
    assert.ok(notes.includes(glSlim), '缺内网精简包固定链接');
    assert.ok(notes.indexOf('内网') < notes.indexOf('GitHub'), '内网入口应排在外网之前');
    // permalink 自身不得含版本号
    const permalinks = notes.match(/permalink\/latest\/downloads\/[^\s)]+/g) || [];
    assert.equal(permalinks.length, 2);
    for (const p of permalinks) assert.doesNotMatch(p, /v?\d+\.\d+\.\d+/, `permalink 不得含版本号：${p}`);
  });

  it('没有 GitLab 基址时只输出 GitHub 段，且不留下空标题', () => {
    const onlyGh = buildNotes('3.6.3', { github: GH, gitlab: '' });
    assert.match(onlyGh, /releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/);
    assert.doesNotMatch(onlyGh, /permalink/, '无基址时不该凭空造内网链接');
    assert.doesNotMatch(onlyGh, /内网/);
  });

  it('固定链接构造函数：无基址返回空数组，不拼出畸形 URL', () => {
    assert.deepEqual(githubFixedLinks(''), []);
    assert.deepEqual(gitlabFixedLinks(''), []);
    assert.equal(githubFixedLinks(GH).length, 2);
    assert.equal(gitlabFixedLinks(GL).length, 2);
    assert.match(gitlabFixedLinks(GL)[0].url, /\/-\/releases\/permalink\/latest\/downloads\//);
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
    const empty = buildNotes('9.9.9', { github: GH, gitlab: GL });
    assert.match(empty, /## 下载/);
    assert.match(empty, /releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/);
    assert.doesNotMatch(empty, /## 9\.9\.9/);
    assert.equal(changelogSection('9.9.9'), '');
  });

  it('兼容旧调用：第二个参数直接传字符串 = GitHub 基址', () => {
    const legacy = buildNotes('3.6.3', GH);
    assert.match(legacy, /https:\/\/example\.com\/org\/repo\/releases\/latest\/download\/moka-resume-plugin-latest-full\.zip/);
  });

  it('未显式传仓库地址时回退到远端推导', () => {
    const url = repoWebUrl();
    assert.match(url, /^https:\/\/[^/]+\/.+/, 'origin 应能推导出 https 网页地址：' + url);
    assert.doesNotMatch(url, /\.git$/);
    assert.doesNotMatch(url, /^git@/);
    const gl = gitlabWebUrl();
    assert.match(gl, /^https:\/\/[^/]+\/.+/, 'gitlab 应能推导出 https 网页地址：' + gl);
    assert.doesNotMatch(gl, /\.git$/);
  });
});
