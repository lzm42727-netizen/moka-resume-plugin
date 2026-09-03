# 加分看计入决策分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 加分看最多 5 项，每项有证据时 +3；仅在门槛全过且经历匹配 ≥50 时计入决策分，允许跨入优先推进并显示「加分晋级」。

**架构：** 模型逐条返回 `bonusKeywordResults`；`lib/score.js` 负责归一化、补齐漏项和唯一的计分合成；`lib/match.js` 生成卡片展示文案；popup 只渲染视图字段。持久化上限从 3 改为 5，prompt 版本升级以作废旧缓存。

**技术栈：** Chrome Extension Manifest V3、原生 JavaScript、Node.js `node:test`

---

### 任务 1：加分结果合同与合成公式

**文件：**
- 修改：`tests/score.test.js`
- 修改：`lib/score.js`

- [ ] **步骤 1：编写失败测试**

覆盖 `normalizeModelScoreResponse` 保留最多 5 条 `bonusKeywordResults`，`ensureBonusKeywordResults` 对模型漏项补 `met:false`；覆盖门槛未过、匹配低于 50、50 分起加、78+3 跨档、100 封顶、0/3 具备等独立算例。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/score.test.js`

预期：FAIL，缺少 `ensureBonusKeywordResults`、加分字段或决策分仍等于 `matchScore`。

- [ ] **步骤 3：最少实现**

在 `lib/score.js` 增加 `BONUS_POINTS_PER_ITEM = 3`、`BONUS_MAX_ITEMS = 5`、`BONUS_POINTS_CAP = 15`；归一化并补齐逐条结果；在 `composeFinalScore` 中按规格计算 `bonusPoints`、`bonusApplied`、`bonusMetCount`、`bonusTotalCount` 和 `bonusPromoted`，并回传 `bonusKeywordResults`。升级 `PROMPT_VERSION`。

- [ ] **步骤 4：验证通过**

运行：`node --test tests/score.test.js`

预期：PASS。

### 任务 2：prompt 与配置上限

**文件：**
- 修改：`tests/score.test.js`
- 修改：`tests/persist.test.js`
- 修改：`tests/popup-ui.test.js`
- 修改：`lib/score.js`
- 修改：`lib/persist.js`
- 修改：`background.js`
- 修改：`popup/popup.html`

- [ ] **步骤 1：编写失败测试**

断言 prompt 要求逐条返回 `bonusKeywordResults`、明确加分不进入 `matchScore`；preset 清洗保留 5 条 `bonusKeywords`；UI 文案显示最多 5 项。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/score.test.js tests/persist.test.js tests/popup-ui.test.js`

预期：FAIL，当前 prompt 无逐条合同且 persist/UI 上限仍为 3。

- [ ] **步骤 3：最少实现**

更新 prompt 和模型 JSON 示例；将 `bonusKeywords`、旧 `niceToHaves` 迁移/清洗上限统一为 5；修改输入框提示为最多 5 项；评分调用在归一化后调用 `ensureBonusKeywordResults`。

- [ ] **步骤 4：验证通过**

运行：`node --test tests/score.test.js tests/persist.test.js tests/popup-ui.test.js`

预期：PASS。

### 任务 3：结果卡片提示与「加分晋级」

**文件：**
- 修改：`tests/match.test.js`
- 修改：`lib/match.js`
- 修改：`popup/popup.js`
- 修改：`popup/popup.css`

- [ ] **步骤 1：编写失败测试**

覆盖：

```js
bonusScoreDisplay({ advanceReason: 'gate', matchScore: 90, bonusMetCount: 2, bonusTotalCount: 2 })
// 经历匹配 90 · 加分看 2/2（未计入）

bonusScoreDisplay({ advanceReason: 'match', matchScore: 45, bonusMetCount: 3, bonusTotalCount: 3 })
// 加分看 3/3（未计入，匹配不足 50）

bonusScoreDisplay({ matchScore: 78, bonusApplied: 3, bonusMetCount: 1, bonusTotalCount: 3 })
// 经历匹配 78 · 加分 +3
```

并断言 `bonusPromoted` 只在 `matchScore < 80 && score >= 80` 时为真。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/match.test.js`

预期：FAIL，缺少加分展示函数/视图字段。

- [ ] **步骤 3：最少实现**

在 `lib/match.js` 生成旁注文案并透传 `bonusPromoted`；popup 卡片渲染旁注及 `加分晋级` 徽标；CSS 增加徽标样式。评分失败不显示任何加分信息。

- [ ] **步骤 4：验证通过**

运行：`node --test tests/match.test.js tests/popup-ui.test.js`

预期：PASS。

### 任务 4：持久化、文档与全量验证

**文件：**
- 修改：`tests/persist.test.js`
- 修改：`lib/persist.js`
- 修改：`README.md`
- 修改：`使用说明.html`
- 修改：`插件介绍.html`

- [ ] **步骤 1：编写失败测试**

断言 `slimScreeningItem` 保留逐条加分结果及合成字段，恢复/回看后卡片仍能解释加分来源。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/persist.test.js`

预期：FAIL，精简记录丢失加分字段。

- [ ] **步骤 3：最少实现并同步文档**

持久化 `bonusKeywordResults`、`bonusPoints`、`bonusApplied`、计数和 `bonusPromoted`；README 与两份 HTML 更新为新公式、5 项上限、不能救出 50、允许跨 80、`加分晋级`。

- [ ] **步骤 4：全量验证**

运行：

```bash
node --test tests/*.test.js
node --check lib/score.js
node --check lib/match.js
node --check lib/persist.js
node --check background.js
node --check popup/popup.js
```

预期：所有测试通过，所有语法检查退出码为 0。
