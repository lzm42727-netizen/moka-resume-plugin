# 技术债与优化待办（2026-09-02 记录）

来源：外部 AI 出的一份「插件评估报告」，逐条对照 v1.6.3 仓库核对后的结论 + 我方建议。
本文件只做记录与排期，不代表已开工。

## 一、核对结论

### 属实

| 项 | 现状证据 |
|---|---|
| 三大文件过肥 | `content.js` 2623 行 / `popup/popup.js` 2862 行 / `background.js` 1085 行，UI 与编排混在一起。`lib/` 已拆出一层，「完全没分层」说重了 |
| `lib/score.js` 旧债 | 3 处 `@deprecated`；`TIER_PENALTY` / `NICE_*` 与 `BONUS_*` 并存；`penaltyForUnmet` / `bonusForMetNice` / `weightsPromptBlock` 仍在导出，但已不决定决策分 |
| 无类型约束 / 无 JSON schema | 模型返回靠 `normalizeModelScoreResponse` 字符串清洗兜底 |
| 跨世界通信靠字符串 | `inject.js`（MAIN world）→ `postMessage` → content；background 靠 `request.action` 分发 |
| prompt 与字段定义分散 | prompt 主体在 `lib/score.js`，调用在 `background.js`，偏好块在 `lib/feedback.js`，展示在 `lib/match.js` / `popup.js` |
| 无 token 预算与成本可见性 | 批量筛 200 人时看不到调用次数与预估花费 |
| `optional_host_permissions` 为 `https://*/*` + `http://*/*` | 自定义 Endpoint 首次使用会弹全站权限 |
| 侧栏「关于」页隐私文案与 README 打架 | 关于页写「所有数据只在本地」「不会上传个人信息」；实际画像会发到用户配置的 LLM |
| 无 CI / lint / 格式化 | 无 `package.json`、无 `.github`，测试靠手跑 `node --test` |
| 文案硬编码中文 | 无 `_locales`；对内部中文工具风险很低 |
| 不支持批量导入岗位 | 已有本岗 preset 自动恢复，缺一次性导入多个 JD 模板 |

### 报告写错的

- **「缓存只按 prompt 版本号」——错。** 评分缓存 key 含完整 `profile` 文本、`jobSpec`、`hardText`、模型名、`PROMPT_VERSION`、`feedbackRev`（`background.js` `handleScoreCandidate`）。真正的风险是本轮没重拉详情时 `profile` 本身是旧的。
- **`window.__mokaPlugin`——仓库里不存在。** 共享状态是 `inject.js` 内的 `lastSearch` / `detailTemplate`。
- **「进度只有一条小条、不能停」——过时。** 底栏已有 `current/total`、百分比、状态文案与「停止筛选」。缺的是「正在评谁 / 还要多久 / 花多少钱」。
- **「新旧计分双轨都在跑」——过重。** 权重滑块已下线，活路径只有门槛 + 经历匹配 + 加分看；旧公式是死代码。

## 二、待办（按性价比排序）

- [ ] **P0 关于页隐私文案对齐**（0.5 天）
      侧栏「关于」改成与 README 一致：Key 只存本地；候选人画像会发送到用户配置的模型服务；自定义域名会申请全站 host 权限。删掉「不会上传个人信息」。
- [ ] **P0 清理 `lib/score.js` 死路径**（1–2 天，先补测试再删）
      删除或隔离 `TIER_PENALTY` / `penaltyForUnmet` / `bonusForMetNice` / `NICE_*` / `weightsPromptBlock`；`composeFinalScore` 不再接收 `weights`；评分缓存 key 去掉权重项。目标：改分只有一套公式可改。
- [ ] **P1 模型 JSON 契约化**（2 天）
      为 `matchScore` / `handwrittenGateResults` / `bonusKeywordResults` / `experienceEvidence` 写一份显式 schema 校验（手写 `assertShape` 即可），解析失败区分「缺字段 / 被截断 / 非 JSON」。比上 TypeScript 更能命中真实故障。
- [ ] **P1 进度可读性**（0.5 天）
      显示「正在评 XXX（37/200）· 已用约 N 分钟」；开筛前提示本轮大约会打多少次模型。
- [ ] **P2 大文件竖切**
      先切 `content.js`（抓包重放 / 筛选循环 / 结果发布），再切 `popup.js`（配置表单 / 结果列表 / 校准）。目标是「改校准不用翻 2800 行」，不追求目录好看。
- [ ] **P2 最小 CI**
      一个 workflow 跑 `node --test tests/*.test.js`，不引入 ESLint 全家桶。

### 明确不做 / 后置

- 全量 TypeScript：三世界（MAIN / ISOLATED / SW）迁移成本高，收益不如 schema 校验。
- i18n 抽取 `_locales`：内部中文工具，现在做是加债。
- 简历内容单独 hash：`profile` 已在缓存 key 内；更有用的是开筛前确保详情已补全。
- 批量导入岗位：除非确有一次配置十几个 JD 的场景。
