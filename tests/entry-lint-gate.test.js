const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(rel) {
  // v3.4.0 拆分后按「原 popup.js 线性顺序」拼接，保住跨窗口的 \s\S 锚点语义
  const bundles = {
    'popup/popup.js': ['popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js']
  };
  const files = bundles[rel] || [rel];
  return files.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
}

describe('工程门禁：入口文件纳入 lint（P2-1，1.7.0）', () => {
  const ENTRY_FILES = ['content.js', 'background.js', 'inject.js', 'popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js', 'popup/popup-health.js'];

  it('package.json lint 覆盖四个入口文件', () => {
    const pkg = JSON.parse(source('package.json'));
    const lint = pkg.scripts.lint;
    for (const f of ENTRY_FILES) {
      assert.ok(lint.includes(f), `lint 脚本应包含 ${f}`);
    }
    assert.match(lint, /--max-warnings=0/, '保持 0 警告门禁');
  });

  it('eslint.config.js 为四个入口文件配置了 globals 与规则', () => {
    const cfg = source('eslint.config.js');
    for (const f of ENTRY_FILES) {
      assert.match(cfg, new RegExp(`["']${f.replace(/\//g, '\\/')}["']`), `eslint config 应声明 ${f}`);
    }
    // no-undef 即「引用未声明标识符」检查：1.6.17 死调用类事故的直接防线
    assert.match(cfg, /'no-undef': 'error'/);
  });

  it('入口文件不允许出现“调用未定义函数”形态（sample 断言，防回归）', () => {
    const content = source('content.js');
    // 1.6.17 事故形态：调用一个从未定义的函数会在运行时抛 ReferenceError；
    // 语法检查与正则单测都可能漏网，只有 no-undef 能系统性拦截。
    assert.doesNotMatch(content, /setMultiSelectOptions\(/);
    assert.doesNotMatch(content, /readMultiSelectValues\(/);
  });

  it('v3.6.0：健康检查模块真正落入 lint 规则块（并入弹窗后仍是独立文件）', () => {
    const cfg = source('eslint.config.js');
    // 规则块的 files 数组必须含 popup-health.js，否则该文件只报 eslint-env 提示、no-undef 不生效
    assert.match(
      cfg,
      /files: \[[^\]]*'popup\/popup-health\.js'[^\]]*\]/,
      'popup-health.js 必须列在带 globals/rules 的 files 数组里'
    );
    // 依赖页面脚本注入的常量必须登记，否则 no-undef 会误报（LOCAL_DEFAULTS 来自 config.local.js）
    assert.match(cfg, /LOCAL_DEFAULTS: 'writable'/);
    // popup.js 的 switchTab 会调 renderHealthCheck，跨模块符号必须登记
    assert.match(cfg, /renderHealthCheck: 'writable'/);
    // 旧的 /* eslint-env */ 写法在 flat config 下已失效，属历史残留
    const health = source('popup/popup-health.js');
    assert.doesNotMatch(health, /\/\* eslint-env/);
  });

  it('v3.6.0：独立健康检查页已删除，入口只剩弹窗标签（防两处口径漂移）', () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'popup/health.js')), 'popup/health.js 应已删除');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'popup/health.html')), 'popup/health.html 应已删除');
  });
});
