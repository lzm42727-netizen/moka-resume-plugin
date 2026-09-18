const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listPackFiles, listFullPackFiles, FORBIDDEN_PATTERNS } = require('../scripts/pack.js');

describe('extension pack list', () => {
  it('includes the files Chrome actually loads and excludes tests and docs', () => {
    const files = listPackFiles();
    assert.ok(files.includes('manifest.json'));
    assert.ok(files.includes('background.js'));
    assert.ok(files.includes('content.js'));
    assert.ok(files.includes('inject.js'));
    assert.ok(files.includes('popup/popup.html'));
    assert.ok(files.includes('popup/popup.js'));
    assert.ok(files.includes('popup/popup.css'));
    assert.ok(files.includes('lib/score.js'));
    assert.ok(files.includes('lib/contracts.js'));
    assert.ok(!files.some((f) => f.startsWith('tests/')));
    assert.ok(!files.some((f) => f.startsWith('docs/')));
    assert.ok(!files.includes('项目评估报告.html'));
  });

  it('精简包不放 Bridge 与安装脚本（Chrome 只需运行时文件）', () => {
    const files = listPackFiles();
    assert.ok(!files.some((f) => f.startsWith('feishu-bridge/')));
    assert.ok(!files.some((f) => f.endsWith('.command')));
    assert.ok(!files.includes('README.md'));
  });
});

describe('完整包（v3.6.3 起，给同事一次性拿到插件 + 本地 Bridge）', () => {
  it('含 Bridge 运行时与凭据模板，以及四个安装脚本', () => {
    const files = listFullPackFiles();
    for (const need of [
      'feishu-bridge/server.js',
      'feishu-bridge/package.json',
      'feishu-bridge/package-lock.json',
      'feishu-bridge/config.example.json',
      '启动飞书机器人.command',
      '停止飞书机器人.command',
      '安装开机自启.command',
      '取消开机自启.command',
      'README.md',
      '使用说明.html'
    ]) {
      assert.ok(files.includes(need), `完整包应含 ${need}`);
    }
    // 插件本体一个不少（完整包是超集，同事只需下载一个）
    for (const rel of listPackFiles()) {
      assert.ok(files.includes(rel), `完整包应含插件文件 ${rel}`);
    }
  });

  it('四个 .command 都真实存在（打包脚本会因缺失直接失败，这里提前拦住）', () => {
    const root = path.join(__dirname, '..');
    for (const name of ['启动飞书机器人', '停止飞书机器人', '安装开机自启', '取消开机自启']) {
      const abs = path.join(root, name + '.command');
      assert.ok(fs.existsSync(abs), `${name}.command 应存在`);
      // zip 不带 unix 执行位时，解压后双击/终端都跑不起来
      const mode = fs.statSync(abs).mode;
      assert.ok(mode & 0o111, `${name}.command 应保留可执行位`);
    }
  });

  it('绝不把 App Secret / 日志 / 依赖目录打进包（防泄密与体积失控）', () => {
    const files = listFullPackFiles();
    const bad = files.filter((rel) => FORBIDDEN_PATTERNS.some((re) => re.test(rel)));
    assert.deepEqual(bad, [], '完整包不得含 config.json / *.log / *.pid / node_modules');
    // 反向确认黑名单真的能识别（避免正则写错导致门禁空转）
    for (const sample of [
      'feishu-bridge/config.json',
      'feishu-bridge/bridge.log',
      'feishu-bridge/server.pid',
      'feishu-bridge/node_modules/@larksuiteoapi/node-sdk/index.js'
    ]) {
      assert.ok(
        FORBIDDEN_PATTERNS.some((re) => re.test(sample)),
        `${sample} 应被黑名单命中`
      );
    }
  });
});
