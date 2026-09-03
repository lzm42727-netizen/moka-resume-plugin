# 硬性门槛 + AI 匹配打分 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按 `docs/superpowers/specs/2026-09-01-gate-ai-match-scoring-design.md` 替换综合分规则：硬性门槛只封顶、匹配分不再托 50，档位为不建议推进 / 可推进 / 优先推进。

**架构：** 下拉门槛仍由 `content.js` 本地 `evaluateHardConditions` 判定。语言与「专业及其他」手写门槛由模型逐条过/不过，不计入匹配分。`composeFinalScore` 只做合成：有未过则 `max(0, 49−7n)`，否则综合分 = 匹配分。匹配分由模型对 JD + 重点看/加分看给出 0–100。取消必须栏与四维加权作为综合分来源。

**技术栈：** 现有 Chrome 扩展（content / popup / background）、`lib/score.js`、`lib/persist.js`、`lib/match.js`、Node `node --test`。

**规格：** `docs/superpowers/specs/2026-09-01-gate-ai-match-scoring-design.md`

未获用户要求前不要 `git commit`。每任务以 `node --test tests/*.test.js` 变绿为准。

---

## 将创建或修改的文件

| 文件 | 职责 |
|------|------|
| `lib/score.js` | `composeFinalScore`、档位、匹配分 prompt / 解析手写门槛 |
| `tests/score.test.js` | 公式与档位、失败态 |
| `lib/persist.js` | preset：`hard.languages`、`hard.customGates`；关键词 `focusKeywords` / `bonusKeywords`；迁移旧 `must` |
| `tests/persist.test.js` | 规范化与迁移 |
| `lib/match.js` | 推荐 tab 认新档位；JD 抽语言/专业进预填 |
| `tests/match.test.js` | 档位过滤、抽取 |
| `popup/popup.html` `popup/popup.css` `popup/popup.js` | 硬性门槛 UI；去掉必须栏与权重滑块区（或隐藏权重，开筛不再用） |
| `content.js` | 开筛 jobSpec 新字段；合并本地未过 + 模型手写未过后再 `composeFinalScore` |
| `background.js` | 解析模型 JSON 中的手写门槛结果与 `matchScore` |
| `使用说明.html` / `README.md` | 文案与档位（任务末尾） |

---

### 任务 1：综合分公式与档位（纯函数）

**文件：**
- 修改：`lib/score.js`（`composeFinalScore`、`levelFromScore`、`isRecommendLevel`）
- 测试：`tests/score.test.js`

- [ ] **步骤 1：写失败测试（独立推导期望值）**

在 `tests/score.test.js` 增加（期望值手算，不要抄当前实现）：

```js
it('caps at 49 - 7 per unmet gate and ignores high match', () => {
  const raw = {
    dimensions: { experience: { score: 90 }, skill: { score: 90 }, education: { score: 90 }, potential: { score: 90 } },
    matchScore: 90,
    highlights: ['社媒'],
    concerns: [],
    handwrittenGateResults: [{ item: '日语', met: false }]
  };
  const out = composeFinalScore(raw, null, [], ['学历本科']);
  // 未过 2 条：49 - 14 = 35
  assert.equal(out.score, 35);
  assert.equal(out.matchScore, 90);
  assert.equal(out.level, '不建议推进');
  assert.equal(out.advanceReason, 'gate');
});

it('uses match score when all gates pass even if match is 32', () => {
  const raw = {
    dimensions: { experience: { score: 32 }, skill: { score: 32 }, education: { score: 32 }, potential: { score: 32 } },
    matchScore: 32,
    highlights: [],
    concerns: ['无相关实习'],
    handwrittenGateResults: []
  };
  const out = composeFinalScore(raw, null, [], []);
  assert.equal(out.score, 32);
  assert.equal(out.level, '不建议推进');
  assert.equal(out.advanceReason, 'match');
});

it('labels 可推进 and 优先推进 from composite score', () => {
  const mk = (match) => composeFinalScore({
    matchScore: match,
    dimensions: { experience: { score: match }, skill: { score: match }, education: { score: match }, potential: { score: match } },
    highlights: [],
    concerns: [],
    handwrittenGateResults: []
  }, null, [], []);
  assert.equal(mk(65).level, '可推进');
  assert.equal(mk(80).level, '优先推进');
});
```

过渡期：`composeFinalScore` 优先读 `raw.matchScore`（整数）；没有则暂用旧四维加权当作匹配分，避免半截发布全挂。手写未过来自 `raw.handwrittenGateResults`（`met:false`），本地未过来自参数 `structuredMissing`（string 数组）。未过条数 = 二者条数之和（去空）。

- [ ] **步骤 2：** `node --test tests/score.test.js` 确认新用例失败

- [ ] **步骤 3：实现**

`levelFromScore(score)` 只看综合分：

- `>= 80` → `优先推进`
- `>= 50` → `可推进`
- 否则 → `不建议推进`
- 失败态仍为 `错误`

`isRecommendLevel`：`可推进` 或 `优先推进`（结果 Tab「推荐」筛这两档）。

`composeFinalScore`：

```
unmetN = structuredMissing.length + handwritten unmet count
if unmetN >= 1: score = max(0, 49 - 7 * unmetN)
else: score = clamp(matchScore, 0, 100)
advanceReason = unmetN >= 1 ? 'gate' : (score < 50 ? 'match' : 'ok')
```

不再减必须/重要、不再加加分。保留 `matchScore` 字段给 UI。`PROMPT_VERSION` 改为新字符串（如 `gate-ai-match-v1`）以作废旧缓存。

- [ ] **步骤 4：** `node --test tests/score.test.js` 通过；按新档位改掉同文件里旧的「值得推荐 / −5」断言，使其符合规格而不是固化旧输出

---

### 任务 2：Preset 数据形状与迁移

**文件：** `lib/persist.js`、`tests/persist.test.js`

- [ ] **步骤 1：测试**

```js
it('migrates legacy must chips into hard.customGates and drops duplicate degree', () => {
  const clean = sanitizeJobPreset({
    jobType: 'intern',
    hard: { degree: '本科', schools: [], customGates: [] },
    requirements: { must: ['本科及以上', '会使用 Photoshop'], important: ['品牌实习'], nice: ['作品集'] }
  });
  assert.equal(clean.hard.degree, '本科');
  assert.ok(clean.hard.customGates.includes('会使用 Photoshop'));
  assert.ok(!clean.hard.customGates.some((x) => /本科/.test(x)));
  assert.deepEqual(clean.focusKeywords, ['品牌实习']);
  assert.deepEqual(clean.bonusKeywords, ['作品集']);
});
```

- [ ] **步骤 2：** 跑测试应失败

- [ ] **步骤 3：** `sanitizeJobPreset` 增加 `hard.languages: string[]`、`hard.customGates: string[]`（条数上限各 6）。`focusKeywords` / `bonusKeywords` 由旧 `requirements.important` / `nice` 迁入。不再把 must 当扣分清单。`requirementsToJobSpecFields` 改为把 languages + customGates 交给评分，important/nice 只作关键词。

- [ ] **步骤 4：** `node --test tests/persist.test.js` 通过

---

### 任务 3：侧栏配置 UI

**文件：** `popup/popup.html`、`popup/popup.css`、`popup/popup.js`

- [ ] **步骤 1：** 将「硬性要求」标题改为「硬性门槛」；在固定项下增加语言芯片（`#lang-chips` / `#lang-input`）与专业及其他芯片（`#gate-chips` / `#gate-input`）。删除「必须」那一行。将「重要/加分」改为「筛选关键词」：重点看、加分看（仍用现有 important/nice 编辑器，改文案与 placeholder）。删除或折叠「评分权重」整段（开筛不再读四维滑块；若怕吓到用户可先 `hidden`）。

- [ ] **步骤 2：** `readHardConditions` / `writeHardConditions` / `collectJobPreset` 读写 `languages`、`customGates`。`autofill-hard` 与 JD 刷新：下拉能填的不写进 customGates；语言/专业进对应芯片。去掉必须栏编辑器与跨栏移动。

- [ ] **步骤 3：** 打开侧栏目测：无必须栏；语言可手写；关键词不算分的提示写在标题下。无法用浏览器自动化扩展时，用 HTML 是否含 `硬性门槛`、`重点看`、不含「未满足 −5」做一次 grep 自检。

---

### 任务 4：JD 预填语言与专业

**文件：** `lib/match.js`（`extractHardAutofillFromText` 或并列函数）、`tests/match.test.js`

- [ ] **步骤 1：** 用例：JD 含「日语 N1 及以上」「设计类相关专业」→ `languages: ['日语N1及以上']`、`customGates` 含专业句；「本科及以上」只进 `degree: '本科'`，不进 customGates。

- [ ] **步骤 2：** 实现抽取（规则 + 现有学历/年限抽取），宁缺毋重复。

- [ ] **步骤 3：** `node --test tests/match.test.js` 通过；popup 预填接上新字段。

---

### 任务 5：评分 prompt 与 JSON

**文件：** `lib/score.js`、`background.js`（解析）

模型输出增加：

```json
{
  "matchScore": 0,
  "handwrittenGateResults": [{ "item": "日语", "met": false, "reason": "简历未提及日语" }],
  "highlights": [],
  "concerns": []
}
```

`dimensions` 可停止作为综合分输入；解析时若无 `matchScore` 再回退四维平均，避免旧缓存炸掉。

Prompt 要点（写入 `dimensionScoringNotes` 的替代块）：

- 手写门槛逐条过/不过，无证据 = 不过；认同义（PS / Photoshop）。
- `matchScore` 只打经历/技能与 JD、重点看的对口；不要因学历已过再加分或再扣分。
- 门槛已由系统处理；匹配差应低于 50，对口强给 80+。
- 加分看：有则写入 highlights，缺不把匹配分打穿。

bump `PROMPT_VERSION`。

---

### 任务 6：开筛合成（content）

**文件：** `content.js`

- [ ] 本地 `evaluateHardConditions` 的 `missing` 作为 `structuredMissing`。
- [ ] 模型返回的 `handwrittenGateResults` 未过项并入未过条数（不要把下拉学历再让模型判一次；prompt 已禁止）。
- [ ] 调用新 `composeFinalScore`。
- [ ] `jobSpec` 带上 `languages`、`customGates`、`focusKeywords`、`bonusKeywords`；不再把 must/important/nice 当扣分。
- [ ] 权重滑块可停止送入合成（匹配分已是 0–100）。

---

### 任务 7：结果卡片

**文件：** `popup/popup.js`、`popup/popup.css`、`lib/match.js`（`toResultView`）

- [ ] 展示档位文案：不建议推进 / 可推进 / 优先推进。
- [ ] 展示匹配分与综合分。
- [ ] `advanceReason === 'gate'` 列出未过门槛；`match` 显示「经历/技能匹配不足」。
- [ ] 过滤 Tab：推荐 = 可推进 + 优先推进。可按需要把「优先推进」做成筛选，非必须。
- [ ] 无已配门槛时不渲染未过门槛列。

---

### 任务 8：文档与全量测试

- [ ] 改 `README.md`、`使用说明.html` 中必须/重要加减分与旧等级名称。
- [ ] `node --test tests/*.test.js` 全绿。
- [ ] 对照规格逐条：无门槛、只本科、日语未过、本科过匹配 32、匹配 80。缺哪条补哪条测试。

---

## 规格覆盖对照

| 规格章节 | 任务 |
|----------|------|
| 硬性门槛 UI + 语言/专业 | 3、4 |
| 关键词不算分 | 2、3、5 |
| 计分封顶不托底 | 1、6 |
| 档位 50 / 80 | 1、7 |
| 判定分工 | 5、6 |
| 三类岗位 | 8 手测说明 |
| 旧 must 迁移 | 2 |

## 执行

计划已保存到 `docs/superpowers/plans/2026-09-01-gate-ai-match-scoring.md`。

两种执行方式：

1. **子代理驱动（推荐）** — 每任务新开子代理，任务间审查  
2. **本会话内联执行** — 按任务推进，设检查点  

选哪种？选定后再改代码。
