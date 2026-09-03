# 先证据后匹配分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 单次评分请求先抽经历证据再打匹配分；相邻经历不得因重点看字面缺失压穿 50。

**架构：** 只改 prompt、JSON 归一化、结果「具备」列合并证据。`composeFinalScore` 门槛公式不变。`PROMPT_VERSION` 升级以作废旧缓存。

**技术栈：** Chrome Extension MV3、原生 JavaScript、Node.js `node:test`

---

### 任务 1：提示词与解析

**文件：** `tests/score.test.js`、`lib/score.js`

- [ ] 测试：`matchScoringPromptBlock` 含先证据后打分、`experienceEvidence`、相邻不得因重点看字面缺失低于 50；不再写「重点看缺失会拉低匹配分」那种打穿语义。
- [ ] 测试：有 `matchScore` 无证据 → 成功且 `experienceEvidence` 为 `[]`；无 `matchScore` 仍失败。
- [ ] 测试：`PROMPT_VERSION` 不是 `gate-ai-match-v1`。
- [ ] 实现：升级 `PROMPT_VERSION` 为 `evidence-first-match-v1`；改 `matchScoringPromptBlock`；`normalizeModelScoreResponse` 增加 `arrOf(..., 6)` 的证据；`composeFinalScore` 把 `experienceEvidence` 带到结果对象。

### 任务 2：具备列合并证据 + 模型 JSON 示例

**文件：** `tests/match.test.js`、`lib/match.js`、`background.js`

- [ ] 测试：highlights 为空时左侧用证据；highlights 已有时证据追加且不挤掉原亮点。
- [ ] `buildEvidenceColumns` 读取 `experienceEvidence`。
- [ ] `toResultView` 带上该字段。
- [ ] `buildDimensionPrompt` 的 JSON 示例增加 `experienceEvidence`，并写明先证据后 `matchScore`。

### 任务 3：验证

- [ ] `node --test tests/*.test.js` 全绿；`node --check` 相关 js。
- [ ] 不提交，由用户决定何时整合分支。
