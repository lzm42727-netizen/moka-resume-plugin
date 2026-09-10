# 本岗校准信号质量优化（规格）

日期：2026-09-10
状态：待评审（未实现）
来源：外部模型提交的本岗校准改进建议 + 对现有实现的逐项审查

本规格不改评分体系。四维权重、门槛三态、`scoreBreakdown`、bonus 语义、`matchScore` 公式全部保持现状（见 `2026-09-02-bonus-keyword-scoring-design.md`、`2026-09-02-job-calibration-align-design.md`）。

## 目标

让本岗校准更准地发现「这个岗位的筛选规则与招聘官实际判断之间的**系统性**偏差」，同时避免因少量样本、措辞差异或偶然决策，把普通偏好错误升级成硬性门槛。

一句话：**校准不是让插件越来越严格，而是越来越接近这个岗位实际招聘者的判断方式。**

## 现状审查结论

外部建议里有 8 项已经实现，不需要重做；另有 2 处前提与代码不符，照做会白干。

| 外部建议 | 现状 | 结论 |
|---|---|---|
| 样本 ≥5 才给建议 | `MIN_DECISIONS_FOR_SUGGEST = 5` | 已有 |
| addGate 只认淘汰样本的明确 hardMissing、≥2 次 | `countNormalizedMissing(eliminateEntries)` + `count >= 2` | 已有 |
| relaxGate 只能因门槛阻断 | 已要求 `advanceReason === 'gate'` 或 `hardMissing` 非空；`matchScore < 50` 与 unknown 都不会触发 | 已有 |
| 结构化门槛（学历/学校/院校/年龄/性别/工作年限/经验年限）不自动改 | `STRUCTURED_GATE_RE` 命中只出 `info`、`apply: null` | 已有 |
| addBonus 需 gatesPassed + matchScore ≥ 50 | 已有，且额外要求 `bonusMetCount === 0` | 已有 |
| bonus 不改 matchScore、不救 50 分以下 | 架构如此 | 已有 |
| 禁止 weight 类建议 | 已删除并有测试锁定 | 已有 |
| 200 条/岗、180 天 TTL | `FEEDBACK_LIMIT_PER_JOB` / `FEEDBACK_TTL_MS` | 已有 |
| 采纳必须人工确认 | `applyCalibrationSuggestion` 由按钮触发 | 已有 |
| 「四维权重是 coreDuty/skill/scope/evidence 40/25/20/15」 | 实际是 coreDuty 40 / business 25 / skill 20 / scope 15 | **外部前提有误，不按其命名改动任何代码** |
| 「需要新增语义归一化层」 | 问题是 `tokenizePhrases` 按文本完全一致计数，不是缺 topSignals | **修正为：只改计数口径，不引入 NLP** |

### 真正的缺口（本规格要解决的）

1. `concerns`、`highlights` 是模型自由文本，**同一含义的多种措辞被算成多个信号**，各自 count=1 被阈值滤掉 → 反复偏好被淹没。
2. 归一化缺失导致 `editableValue` 会把否定式写进重点看（「无达人合作」），语义相反。
3. `overRecommend ≥ 3` 但 concerns 不重复时，会落到「判断较一致」——**存在系统性分歧却报一致**，这是当前最误导的输出。
4. 反馈上下文没有明确「历史偏好不得自建硬性一票否决」。
5. 建议没有可信度分层，弱的和强的长得一样。
6. 只有「加关注项」，没有「移除错误关注项」的能力。
7. `dropBonus` 的口径比「同一个 bonus 项多次改变结果」略松。

## 非目标

- 不改四维权重、不改评分公式、不恢复 `weight / avgDimScores / lowestDim / bumpWeight`。
- 不新增联网服务、不新增 AI 调用、不引入 NLP 依赖。
- 不自动修改学历 / 学校 / 院校 / 年龄 / 性别 / 工作年限等结构化下拉条件。
- 不把历史反馈自动升级成硬性门槛；不把 `unknown` 当负面证据。
- 不重写 popup 整体 UI、不改 feedback 存储结构（新增字段必须向后兼容）。
- 不做数学时间衰减权重（第一版只做「近期优先排序」）。

---

## 设计

### 1. 信号归一化聚合（核心）

新增两个纯函数（`lib/calibrate.js`）：

```js
normalizeCalibrationSignal(text) -> { core, polarity, direction } | null
groupCalibrationSignals(list, minCount) -> [{ text, count, variants, polarity }]
```

- `text`：归一后的短文案，用于展示与写入配置（如 `达人合作`）
- `count`：聚合后的出现次数
- `variants`：原始措辞数组，用于追溯（UI 不展示，仅落进返回值与日志）
- `polarity`：`'lack'`（缺失类）或 `'neutral'`，供诊断区分使用

归一规则（保守，只做三类）：

| 步骤 | 规则 | 例 |
|---|---|---|
| A 否定前缀剥离 | `无 / 没有 / 缺少 / 缺乏 / 未具备 / 不足 / 欠缺` 开头 | 无达人合作 → 达人合作 |
| B 结果后缀剥离 | 结尾的 `经验不足 / 经验较少 / 能力不足 / 经验缺失 / 资源不足` | 缺少达人合作经验 → 达人合作 |
| C 同义词替换（极小表） | `KOL→达人`、`达人营销/达人资源→达人合作`、`海外市场→海外`、`主播资源→主播` | 没有KOL合作经验 → 达人合作 |

**方向保护（必须）**：

- 先判断**否定极性**再剥离前缀，`polarity` 随信号保留。
- `有达人合作经验`（polarity: neutral）与 `无达人合作经验`（polarity: lack）**不得归并**，`groupCalibrationSignals` 的 key 必须含 polarity。
- 剥离前缀时只剥离**否定词**，不得把 `丰富/较强` 之类的正向修饰当噪音剥掉——`项目经验不足` 与 `项目经验丰富` 的 core 分别为 `项目经验`(lack) 与 `项目经验丰富`(neutral)，因 polarity 不同而分属两组。
- 同义词表只写死上述几组；不做自由语义推断，不做 embedding。

接入点（替换现有按字面计数处）：

| 位置 | 现在 | 改为 |
|---|---|---|
| `countNormalizedMissing`（addGate 来源） | 逐个归一化文案计数 | 复用 `normalizeCalibrationSignal`，保留 `polarity` |
| `topConcerns` | `tokenizePhrases(concernBag)` | `groupCalibrationSignals(concernBag)` |
| `topHighlights` | `tokenizePhrases(highlightBag)` | `groupCalibrationSignals(highlightBag)` |
| `repeatedPhrases(entries, field, min)` | 字面计数 | 按信号分组后按 count 过滤 |
| `unmetBonus` | 字面计数 | 同上 |
| `topSignals` | 拼三条来源 | 保持来源优先级不变，元素升级为归一化信号（含 `variants`） |

**行为变化（有意为之）**：`editableValue` 改为归一后文案。现有实现会建议把「无达人合作」写进重点看，归一后写「达人合作」——这是修正，同步更新 `2026-09-02-job-calibration-align-design.md` 的验收例 3 与 `tests/calibrate.test.js` 中 `editableValue === '无达人合作'` 的断言。

### 2. score-drift 诊断（不可 apply）

新增 `diagnostics.scoreDrift = { direction: 'strict' | 'lenient' | 'none', count }`，并在 `suggestions` 里以 `type: 'info'` 输出一条说明。

| 方向 | 触发条件 | 文案要点 |
|---|---|---|
| `strict`（插件偏严） | `underRecommend >= 3` 且这些人的快照 `gatesPassed`（无门槛阻断）且 `matchScore` 偏低（< 50） | 「你连续推荐了 N 位插件匹配度偏低、但没有被硬性门槛拦截的候选人，可能存在岗位职责理解偏严。建议检查『岗位理解』与『重点看』」 |
| `lenient`（插件偏宽） | `overRecommend >= 3` 且这些人无 `hardMissing`、非 gate 阻断 | 「你连续淘汰了 N 位插件认为匹配度较高的候选人，可能存在岗位职责理解偏宽或重点关注项缺失」 |
| `none` | 不满足上述任一 | 不输出诊断 |

约束：

- 该建议**永远 `apply: null`**，UI 不渲染采纳按钮。
- **不修改** `coreDuty / business / skill / scope` 权重，不出任何 weight 类建议。
- 兜底行为修正：当存在 `overRecommend >= 3` 或 `underRecommend >= 3` 但无规则建议时，**不再**输出「判断较一致」，改为输出对应方向的 score-drift 诊断（无方向的极端情况才回落到「判断较一致」）。

### 3. 建议置信度 `confidence`

每条可采纳建议增加 `confidence: 'high' | 'medium' | 'low'`：

| 条件 | confidence |
|---|---|
| 样本 ≥ 10 且同一信号 count ≥ 5 且因果明确（hardMissing / bonusPromoted / gate 阻断） | high |
| 样本 ≥ 5 且同一信号 count ≥ 2，或因果明确但样本较少 | medium |
| 其余（分歧分散、count 集中在低值） | low |

第一版只作为字段返回（并附在 `evidence: { count, variants }` 旁），UI 可只加一个轻量标记；`low` 不阻断展示。

### 4. 文案强化

- `addFocus` 的 detail 增补：「加入重点看后按相邻经历与语义相关证据判断，**不要求简历出现完全相同的关键词**」。
- `addGate`（专业及其他 / 语言）的 detail 增补风险提示：「这项一旦加入硬性门槛，将可能直接拦截没有该项证据的候选人；请确认它是真正的一票否决条件，而不仅是偏好。」——**只提示，不阻止采纳**。

### 5. dropBonus 收紧

现在：`overEntries` 中 `bonusPromoted` 人数 ≥ 2，取其中出现最多的已具备加分项。
改为：**同一个 bonus 项 ≥ 2 人因它晋级**（即按归一化后的 item 分组计数 ≥ 2）才建议移除，并写清「该加分项曾把 N 人送进推进档」。仅「有该经历但被淘汰」不构成证据。

### 6.（可选，第二批）removeFocus 轻量版

条件（全部满足才建议，且默认只建议不改）：

- 当前 `focusKeywords` 已包含该词；
- ≥3 条 over 的 `concerns` 归一后命中该 focus；
- 这些 over **全部**是招聘官淘汰；
- 这些 over 无 `hardMissing`（排除门槛原因）。

限制：当前快照不记录「focus 是否命中」，因此**严格版暂不实现**；如需严格证据，后续按兼容方式新增 `focusKeywordResults` 快照字段（老数据缺字段则不产生该建议）。

### 7.（可选）近期优先排序

`buildCalibrationReport` 与 `listFeedbackExamples` 的样本按 `updatedAt` 降序参与排序与并列打破；**不做时间衰减权重**，避免改变现有阈值语义。

### 8.（第二批）反馈上下文加固

`feedbackPromptBlock` 说明段追加：

> 历史反馈只用于校准本岗偏好，**不得据此创建新的硬性一票否决条件**；只有岗位配置里已明确存在的硬性门槛才算硬性门槛。简历未提及某项，不等于候选人不具备该项。

同时 `buildPreferenceAggregate` 的「反复信号」行改用归一化分组（与第 1 项同一套函数），措辞保持「×N」。

注意事项：说明段变化会改变评分 prompt 语义 → 按项目约定 **bump `PROMPT_VERSION`**，旧评分缓存一次性失效（代价明确，需在 CHANGELOG 注明）。

---

## 数据结构（向后兼容）

`buildCalibrationReport` 返回值在现有字段上**只增不改**：

```js
{
  total, recommend, eliminate, agree, overRecommend, underRecommend,
  topConcerns, topHighlights, topSignals,   // 元素升级为 { text, count, variants }
  suggestions,                             // 内部新增 confidence / evidence
  diagnostics: { scoreDrift: { direction, count } },  // 新增
  summary
}
```

单条 suggestion 新增：`confidence`、`evidence: { count, variants }`。老调用方（popup）读取新增字段为 undefined 时必须不报错；`lib/popup` 侧仅做「有则展示」。

## 测试清单

`tests/calibrate.test.js` 为主，逐条对应外部建议的验收项：

| # | 用例 | 期望 |
|---|---|---|
| 1 | 完全相同文本 ×3（`达人合作`） | count = 3 |
| 2 | `没有达人资源` / `缺少达人合作经验` / `无KOL合作经验` | 聚合为同一信号，count = 3，variants 保留 3 条原文 |
| 3 | `有达人合作经验` vs `无达人合作经验` | **不聚合**（polarity 不同） |
| 4 | 重复明确 `hardMissing` ≥ 2 | 产出 addGate |
| 5 | 仅 `concerns: ['行业经验不足']` 单条 | 不产生 addGate |
| 6 | `学历本科` 门槛 | 只出 info，无 relaxGate，`apply === null` |
| 7 | `pluginRecommend === false` + `advanceReason === 'gate'` | 允许 relaxGate；`matchScore < 50` 或 unknown 时不允许 |
| 8 | under ≥ 3 + 无 gate 阻断 + 匹配偏低 | 产出 score-drift（strict），且**无 weight 类建议** |
| 9 | over ≥ 3 + 无门槛问题 | 产出 score-drift（lenient），且不再出现「判断较一致」 |
| 10 | 重复 concerns ≥ 2 | 产出 addFocus |
| 11 | focus 已存在 + 3 条 over 且全淘汰 | （第二批）产出 removeFocus；单次淘汰不产出 |
| 12 | addBonus | 仅 `gatesPassed` 且 `matchScore ≥ 50` 才产出 |
| 13 | dropBonus | 仅 `bonusPromoted === true` 且同一 bonus ≥ 2 才产出 |
| 14 | unknown（无 hardMissing、无 advanceReason） | 不产出 addGate / relaxGate / dropBonus |
| 15 | confidence | 低样本低重复 → low/medium；高样本高集中 → high |
| 16 | 历史偏好定位 | `feedbackPromptBlock` 文本含「不得据此创建新的硬性一票否决条件」，且不含「权重/上调维度」 |

## 验收例子（独立推导）

1. 5 条淘汰，concerns 分别为「没有达人资源 / 缺少达人合作经验 / 无KOL合作经验 / 无达人合作 / 达人合作不足」→ 一条 addFocus，`editableValue === '达人合作'`，`variants.length === 5`。
2. 5 条淘汰全部 `hardMissing: ['缺「日语 N1」']` → addGate「日语 N1」，detail 含风险提示。
3. 4 条 over、concerns 各异 → 出现 score-drift（lenient），**不出现**「判断较一致」，且无 weight 建议。
4. 3 条 under 全因「学历本科」被拦 → 只出 info「核对下拉门槛」，`apply === null`。
5. 3 条 over 无 concerns 重复、`bonusPromoted` 各 1 项且互不相同 → **不**产出 dropBonus（收紧后需同一项 ≥2）。
6. 全岗无任何分歧且已决策 ≥5 → 仍输出「判断较一致」。

## 分批

| 批次 | 内容 | 触及文件 |
|---|---|---|
| 第一批 | 1 信号归一化、2 score-drift、3 confidence 字段、4 文案强化、5 dropBonus 收紧 | `lib/calibrate.js`、`tests/calibrate.test.js`；popup 仅「有则展示」的极小改动 |
| 第二批 | 8 反馈上下文加固（含 `PROMPT_VERSION` bump）、confidence 上卡片 | `lib/feedback.js`、`lib/score.js`、`popup/popup.js` |
| 第三批（可选） | 6 removeFocus 轻量版、7 近期优先排序、UI 分组「规则调整 / 诊断」 | `lib/calibrate.js`、`popup/*` |

## 验证

```bash
npm run check   # syntax:check + check:version + lint + node:test
```

另需人工确认：旧 feedback 可读、旧岗位配置可恢复、评分流程无变化、建议仍可「采纳并保存」、结构化门槛不被自动修改、无 weight 类建议回归。

## 外部建议中明确不采纳的部分

| 建议 | 不采纳理由 |
|---|---|
| 按其维度名（skill/scope/evidence）核对权重 | 与实际 `FIT_WEIGHTS`（business/skill/scope）不一致，按其命名改会引入错误 |
| 把 addGate 收紧为「必须 pluginRecommend === false」 | 数据流等价（有 hardMissing ⇒ gatesPassed=false ⇒ 插件未推），是冗余条件 |
| 数学时间衰减（1.0 / 0.8 / 0.5） | 改变现有阈值语义，收益不确定；第一版只做近期优先排序 |
| 引入语义归一化之外的大 NLP / 新模型调用 | 与「最小安全修改、不新增联网与 AI 调用」冲突 |
| `diagnostics` 参与自动调整权重 | 违反本规格非目标 |
