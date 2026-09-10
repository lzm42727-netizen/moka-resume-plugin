/**
 * 死代码门禁：lib/*.js 导出的每个符号，必须在本文件之外至少被引用一次。
 *
 * 背景：eslint 的 no-unused-vars 管不到「导出但无人消费」这类死代码——函数活着、导出在，
 * 但整个工程没人调用（如曾经的 dimensionScoringNotes / tokenizePhrases / buildHardText）。
 * 本测试把「导出必须有消费者」钉死，防止清理后回潮。
 *
 * 若确有需要对外暴露、只是暂时没有消费者的符号，请加入 ALLOWED_UNUSED_EXPORTS 并写明理由。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'docs']);
const SCAN_EXT = /\.(js|html)$/;

// 允许「暂无消费者」的导出（新增务必写明原因与预期消费方）
const ALLOWED_UNUSED_EXPORTS = new Set([]);

function collectScanFiles(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (SKIP_DIRS.has(entry.name)) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectScanFiles(full, out);
    else if (SCAN_EXT.test(entry.name)) out.push(full);
  });
  return out;
}

/** 解析 lib 文件里 `const api = { ... }` 的导出符号名 */
function exportedNames(source) {
  const names = new Set();
  const lines = source.split('\n');
  let inBlock = false;
  lines.forEach((line) => {
    if (/const api = \{/.test(line)) {
      inBlock = true;
      return;
    }
    if (!inBlock) return;
    if (/^\s*\};/.test(line)) {
      inBlock = false;
      return;
    }
    const name = line.trim().replace(/,$/, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  });
  return names;
}

describe('死代码门禁：lib 导出必须有消费者', () => {
  it('没有任何 lib 导出处于「无人引用」状态', () => {
    const files = collectScanFiles(ROOT, []);
    const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const libDir = path.join(ROOT, 'lib');
    const libFiles = fs
      .readdirSync(libDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(libDir, f));

    const offenders = [];
    libFiles.forEach((libFile) => {
      const names = exportedNames(sources.get(libFile) || '');
      names.forEach((name) => {
        if (ALLOWED_UNUSED_EXPORTS.has(name)) return;
        const re = new RegExp('\\b' + name + '\\b');
        const consumed = files.some((f) => f !== libFile && re.test(sources.get(f)));
        if (!consumed) offenders.push(path.relative(ROOT, libFile) + ' -> ' + name);
      });
    });

    assert.deepEqual(
      offenders,
      [],
      '以下导出在本文件之外没有任何消费者，属死代码：请删除，或加入 ALLOWED_UNUSED_EXPORTS 并写明理由\n'
        + offenders.join('\n')
    );
  });
});
