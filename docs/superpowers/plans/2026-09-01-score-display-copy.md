# 结果卡片分数展示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 侧栏只突出决策分，仅在门槛压分时显示经历匹配，并同步 CSV 与用户文档术语。

**架构：** 保持 `score` / `matchScore` 数据结构及计分逻辑不变。由 `lib/score.js` 提供门槛压分时的展示文案，`popup/popup.js` 仅负责渲染；`lib/persist.js` 只调整 CSV 表头。

**技术栈：** Chrome Extension MV3、原生 JavaScript、Node.js `node:test`

---

### 任务 1：卡片分数文案

**文件：**
- 修改：`tests/score.test.js`
- 修改：`lib/score.js`
- 修改：`tests/popup-ui.test.js`
- 修改：`popup/popup.js`

- [ ] **步骤 1：编写失败测试**

在 `tests/score.test.js` 断言：普通分和匹配不足不返回副分文案；门槛压分 `42/90` 返回 `经历匹配 90`；错误返回空串。在 `tests/popup-ui.test.js` 断言结果卡片不再调用 `formatPenaltyHint`，改用新文案函数。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test tests/score.test.js tests/popup-ui.test.js`

预期：新函数不存在或卡片仍引用旧 hint，测试失败。

- [ ] **步骤 3：最小实现**

在 `lib/score.js` 增加并导出：

```js
function matchScoreDisplayText(scoreObj) {
  const s = scoreObj || {};
  if (s.level === '错误' || s.advanceReason !== 'gate') return '';
  if (!hasFiniteScore(s.matchScore) || Number(s.matchScore) === Number(s.score)) return '';
  return '经历匹配 ' + clampScore(s.matchScore);
}
```

在 `popup/popup.js` 删除 `formatPenaltyHint` 渲染，在档位文字后按需渲染新文案。保留现有错误原因、匹配不足和门槛标签。

- [ ] **步骤 4：运行定向测试**

运行：`node --test tests/score.test.js tests/popup-ui.test.js`

预期：全部通过。

### 任务 2：CSV 术语

**文件：**
- 修改：`tests/persist.test.js`
- 修改：`lib/persist.js`

- [ ] **步骤 1：先改测试并确认失败**

将 CSV 表头期望改为：

```text
姓名,学历,学校,决策分,经历匹配,档位,未过门槛
```

运行：`node --test tests/persist.test.js`

预期：实际表头仍为「综合分,匹配分」，测试失败。

- [ ] **步骤 2：修改表头并验证**

只把 `SCREENING_CSV_HEADERS` 中两列改为「决策分」「经历匹配」，不改数据列顺序。

运行：`node --test tests/persist.test.js`

预期：全部通过。

### 任务 3：同步文档并全量验证

**文件：**
- 修改：`README.md`
- 修改：`使用说明.html`

- [ ] **步骤 1：更新当前功能文案**

说明侧栏左侧大数字为决策分；经历匹配只在硬门槛导致压分时显示。计分公式保留，但对外术语改为「决策分 / 经历匹配」。

- [ ] **步骤 2：运行全量测试与语法检查**

运行：

```bash
node --test tests/*.test.js
node --check lib/score.js
node --check lib/persist.js
node --check popup/popup.js
```

预期：全部测试通过，语法检查退出码为 0。

- [ ] **步骤 3：检查变更范围**

运行：`git diff --check`

预期：无空白错误；不提交，由用户决定何时整合当前分支的全部改动。
