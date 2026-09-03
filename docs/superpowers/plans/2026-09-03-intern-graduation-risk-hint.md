# 实习岗毕业临近风险提示 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。未经用户明确要求不要 git commit。

**目标：** 实习岗结果卡在毕业不足半年时显示「毕业 YYYY.MM，距今不足半年」，不改决策分。

**架构：** 纯函数 `graduationRiskHint` 放在 `lib/match.js`（可单测、content/popup 共用）。content 在本地门槛判定后写入 `item.graduationRisk`；slim/hydrate 与 `toResultView` 原样传递；popup 在姓名/学历附近渲染独立风险行。

**技术栈：** 现有 Chrome 扩展 JS + `node:test`。规格：`docs/superpowers/specs/2026-09-03-intern-graduation-risk-hint-design.md`。

**文件：**
- 修改：`lib/match.js` — `graduationRiskHint`、`toResultView`
- 修改：`lib/persist.js` — slim/hydrate 带上 `graduationRisk`
- 修改：`content.js` — 筛人/重评时写入字段
- 修改：`popup/popup.js`、`popup/popup.css` — 卡片展示
- 测试：`tests/match.test.js`、`tests/persist.test.js`、`tests/popup-ui.test.js`

---

### 任务 1：毕业风险纯函数

**测试：** `tests/match.test.js`  
**实现：** `lib/match.js`

- [x] **步骤 1：写失败测试**（`now` 固定为 `2026-09-03`）

```js
const NOW = new Date(2026, 8, 3); // 本地 9 月 3 日

describe('graduationRiskHint', () => {
  it('flags intern graduation within six months', () => {
    const hint = graduationRiskHint(
      [{ school: 'Edinburgh', endDate: '2026.12' }],
      { jobType: 'intern', now: NOW }
    );
    assert.deepEqual(hint, {
      endLabel: '2026.12',
      text: '毕业 2026.12，距今不足半年'
    });
  });

  it('does not flag exactly six months out', () => {
    assert.equal(graduationRiskHint(
      [{ endDate: '2027-03-03' }],
      { jobType: 'intern', now: NOW }
    ), null);
  });

  it('does not flag already graduated', () => {
    assert.equal(graduationRiskHint(
      [{ endDate: '2026-08-01' }],
      { jobType: 'intern', now: NOW }
    ), null);
  });

  it('does not flag full-time jobs', () => {
    assert.equal(graduationRiskHint(
      [{ endDate: '2026.12' }],
      { jobType: 'full-time', now: NOW }
    ), null);
  });

  it('skips missing or ongoing end dates', () => {
    assert.equal(graduationRiskHint(
      [{ endDate: '' }, { end: '至今' }],
      { jobType: 'intern', now: NOW }
    ), null);
  });

  it('uses the latest education end date', () => {
    const hint = graduationRiskHint(
      [{ endDate: '2025.7' }, { endDate: '2026-12' }],
      { jobType: 'intern', now: NOW }
    );
    assert.equal(hint.endLabel, '2026.12');
  });
});
```

并从 `../lib/match.js` 解构 `graduationRiskHint`。

- [x] **步骤 2：跑测试确认失败**

```bash
node --test tests/match.test.js
```

预期：`graduationRiskHint is not defined` 或导出缺失。

- [x] **步骤 3：最少实现**

`graduationRiskHint(educationList, { jobType, now })`：

- `jobType !== 'intern'` → `null`
- 每条取 `endDate || endTime || end || to`
- 跳过空、「至今」「现在」「present」（大小写不敏感）
- 解析 `YYYY.MM` / `YYYY-MM` / `YYYY/MM` / `YYYY-MM-DD`：仅年月时用该月最后一天
- 取最晚有效结束日 `end`
- 若 `end < startOfDay(now)` 或 `end >= addCalendarMonths(startOfDay(now), 6)` → `null`
- 否则 `{ endLabel: 'YYYY.MM', text: '毕业 YYYY.MM，距今不足半年' }`

导出并加入 `toResultView`：`graduationRisk: item.graduationRisk || null`。

加测：`toResultView` 原样带上该对象。

- [x] **步骤 4：跑测试通过**

```bash
node --test tests/match.test.js
```

---

### 任务 2：slim 持久化

**测试：** `tests/persist.test.js`  
**实现：** `lib/persist.js`

- [x] **步骤 1：失败测试**

```js
it('keeps intern graduation risk on slim and hydrate', () => {
  const risk = { endLabel: '2026.12', text: '毕业 2026.12，距今不足半年' };
  const slim = slimScreeningItem({
    app: { id: 9, educationInfo: [{ endDate: '2026.12' }] },
    graduationRisk: risk
  });
  assert.deepEqual(slim.graduationRisk, risk);
  assert.equal(slim.app.educationInfo, undefined);
  assert.deepEqual(hydrateScreeningItem(slim).graduationRisk, risk);
});
```

- [x] **步骤 2：跑测失败**
- [x] **步骤 3：** `slimScreeningItem` / `hydrateScreeningItem` 复制 `graduationRisk`（无则 `null`）
- [x] **步骤 4：** `node --test tests/persist.test.js` 通过

---

### 任务 3：content 写入 + popup 展示

**文件：** `content.js`、`popup/popup.js`、`popup/popup.css`、`tests/popup-ui.test.js`

- [x] **步骤 1：popup 失败测试**

```js
it('renders intern graduation risk away from evidence columns', () => {
  assert.match(js, /graduationRisk/);
  assert.match(js, /mp-grad-risk/);
  assert.match(html, /mp-grad-risk/);
});
```

html 里不一定有 class（动态生成），改为只断言 `popup.js` + `popup.css`。

- [x] **步骤 2：跑测失败**
- [x] **步骤 3：实现**

content：在 `evaluateHardConditions` 之后（筛选 worker 与 `rescoreItem`）写入：

```js
item.graduationRisk = MokaMatch.graduationRiskHint(item.app && item.app.educationInfo, {
  jobType: scoreConfig.jobType, // rescore 用 cfg.jobType
  now: new Date()
});
```

popup：`meta` 行之后，若 `view.graduationRisk && view.graduationRisk.text`：

```js
const risk = document.createElement('div');
risk.className = 'mp-grad-risk';
risk.textContent = view.graduationRisk.text;
risk.title = '实习岗档期风险，不影响分数';
info.appendChild(risk);
```

css：琥珀底，与门槛红标区分。不要放进 `buildEvidenceSplit`。

- [x] **步骤 4：** `node --test tests/*.test.js` 全部通过

---

### 规格覆盖

| 规格 | 任务 |
|---|---|
| 只实习岗 / 不足半年 / 满半年 / 已毕业 / 缺失 / 最晚结束日 | 1 |
| 不改分 | 1 不碰 `composeFinalScore` |
| slim 不依赖 educationInfo | 2 |
| 卡片位置与文案 | 3 |
| 手写 8 个月门槛不动 | 不改 score prompt |
