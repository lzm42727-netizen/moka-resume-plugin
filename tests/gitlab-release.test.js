const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  projectPathFromRemote,
  encodeProject,
  webBaseFromRemote,
  parseToken,
  parseArgs,
  linkSpecs,
  MANAGED_LINK_NAMES,
  FIXED_FULL,
  FIXED_SLIM
} = require('../scripts/gitlab-release.js');

describe('内网 GitLab Release（v3.6.3 起，脚本化上传 + 固定链接）', () => {
  it('从两种远端写法都能取出 group/project', () => {
    assert.equal(projectPathFromRemote('git@git.meitu.com:meituhr/moka-resume-plugin.git'), 'meituhr/moka-resume-plugin');
    assert.equal(projectPathFromRemote('https://git.meitu.com/meituhr/moka-resume-plugin.git'), 'meituhr/moka-resume-plugin');
    assert.equal(projectPathFromRemote('https://git.meitu.com/meituhr/moka-resume-plugin'), 'meituhr/moka-resume-plugin');
    assert.equal(projectPathFromRemote(''), '');
  });

  it('project 路径要 URL 编码（GitLab API 用 %2F 形式定位）', () => {
    assert.equal(encodeProject('meituhr/moka-resume-plugin'), 'meituhr%2Fmoka-resume-plugin');
  });

  it('推导网页基址：去 .git、ssh 转 https', () => {
    assert.equal(
      webBaseFromRemote('git@git.meitu.com:meituhr/moka-resume-plugin.git'),
      'https://git.meitu.com/meituhr/moka-resume-plugin'
    );
    assert.equal(webBaseFromRemote('https://git.meitu.com/meituhr/moka-resume-plugin.git'), 'https://git.meitu.com/meituhr/moka-resume-plugin');
    assert.equal(webBaseFromRemote(''), '');
  });

  it('.env.local 解析要容忍引号/空格/其他行，且不误取别的变量', () => {
    assert.equal(parseToken('GITLAB_TOKEN=abc123\n'), 'abc123');
    assert.equal(parseToken('FOO=1\nGITLAB_TOKEN="abc 123"\nBAR=2\n'), 'abc 123');
    assert.equal(parseToken('  GITLAB_TOKEN=  abc  \n'), 'abc');
    assert.equal(parseToken('GITLAB_TOKEN_OTHER=x\n'), '');
    assert.equal(parseToken(''), '');
    // 不能把前缀相似的变量当成 token
    assert.equal(parseToken('MY_GITLAB_TOKEN=x\n'), '');
  });

  it('四条 link：两条带版本号存档、两条走 direct_asset_path 固定链接', () => {
    const urls = { full: 'u1', slim: 'u2', fixedFull: 'u3', fixedSlim: 'u4' };
    const specs = linkSpecs(urls);
    assert.equal(specs.length, 4);
    assert.deepEqual(
      specs.map((s) => s.name),
      [...MANAGED_LINK_NAMES]
    );
    assert.equal(specs.filter((s) => s.direct_asset_path).length, 2);
    const fixed = specs.filter((s) => s.direct_asset_path);
    assert.deepEqual(
      fixed.map((s) => s.direct_asset_path),
      ['/' + FIXED_FULL, '/' + FIXED_SLIM]
    );
    // 固定链接不能用 package 类型：GitLab 会把 direct_asset_path 当包内 filepath 校验，直接 400
    for (const f of fixed) assert.equal(f.link_type, 'other');
    // 每条 link 指向各自的 upload，不能复用同一条 url（GitLab 会报 Url has already been taken）
    assert.equal(new Set(specs.map((s) => s.url)).size, 4);
    // 固定链接的文件名里不能有版本号
    for (const f of fixed) assert.doesNotMatch(f.direct_asset_path, /v?\d+\.\d+\.\d+/);
  });

  it('参数解析：--notes 的值不能被当成版本号', () => {
    assert.deepEqual(parseArgs(['3.6.3']), { version: '3.6.3', notesFile: '', dryRun: false });
    assert.deepEqual(parseArgs(['3.6.3', '--notes', '/tmp/n.md']), {
      version: '3.6.3',
      notesFile: '/tmp/n.md',
      dryRun: false
    });
    assert.deepEqual(parseArgs(['--notes', '/tmp/n.md', '3.6.3', '--dry-run']), {
      version: '3.6.3',
      notesFile: '/tmp/n.md',
      dryRun: true
    });
    assert.deepEqual(parseArgs([]), { version: '', notesFile: '', dryRun: false });
  });

  it('每条 link 只声明自己的 url，不在这里偷偷兜底（缺了就由调用方早失败）', () => {
    const partial = linkSpecs({ full: 'u1' });
    assert.equal(partial.find((s) => s.key === 'full').url, 'u1');
    assert.equal(partial.find((s) => s.key === 'slim').url, undefined);
    assert.equal(partial.length, 4, '四条 link 的声明必须始终齐整，缺 url 由上传阶段拦');
  });
});
