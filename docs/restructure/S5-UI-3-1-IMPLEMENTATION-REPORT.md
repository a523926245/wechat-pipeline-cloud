# S5-UI-3-1 · 文章工作台信息层与反馈一致性优化 · 实施报告

**日期**：2026-11-17
**性质**：小范围 UI 实施（基于已验收的 S5-UI-3-0 审计报告 §10 A 档）。
**结论**：6 项改动全部完成；类型检查、生产构建、两组断言（26 + 34 项）、浏览器走查（列表 6 类数据 + 深色 + 窄屏 + 改稿页组件迁移 + 保存三态）全部通过。**无 P0/P1 问题，无业务逻辑 / API / Schema / 数据库 / 配置变更。**

---

## 1. 修改文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `web/src/utils/article-push.ts` | 新增 | 推送事实 / 批量删除 impact / 推送失败分类的纯函数唯一口径（无 Vue / API 依赖） |
| `web/src/views/ArticlesView.vue` | 修改 | 列表加「推送事实」列；批量删除 impact 换用推送痕迹判据；推送失败反馈改用共用映射 |
| `web/src/views/ArticleEditView.vue` | 修改 | 标题/摘要派生说明；强调补全与 AI 改写分区；页头迁 PageHead、保存条迁 SaveBar；推送失败反馈改用共用映射 |
| `web/scripts/assert-article-push.mjs` | 新增 | 本轮轻量断言测试（26 项） |
| `web/package.json` | 修改 | 新增 `test:article-push` 脚本 |
| `docs/restructure/S5-UI-3-1-IMPLEMENTATION-REPORT.md` | 新增 | 本报告 |

> 走查夹具 `var/tmp/s5ui2c/`（mock.mjs 加 failsave 分支、walk-3-1.mjs / walk-3-1b.mjs、截图、mode.txt）位于临时目录、不进版本库，用于验证，非交付物。

**未修改**：`server/**`、任何 API、Schema、Migration、`.env`。**未新增**：独立标题/摘要输入框、`needs=push_failed` 筛选、产线回传字段、体检段落定位（均在任务书 §4 明确延期）。

---

## 2. 每项修改对应的问题与实现方式

### A. 文章列表

**A1 增加推送事实展示（S5-UI-3-0 · P2-1）**
- 问题：列表接口已返回 `mediaId` / `pushDate`，但表格不展示；`status` 会被保存/换封面覆盖为 `draft`，用户无法区分「从未推送」与「推送后退回草稿」。
- 实现：在「状态」列后加「推送事实」列（132px），调用 `pushFact(row)` 派生 tag 文案 + 配色 + 可选日期；el-tooltip 展示 `hint` 解释「为什么这样显示」。判据沿用 `hasPushTrace()`，事实与状态分开，不修改后端、不加状态/字段。

**A2 修复批量删除 impact 文案（P2-4）**
- 问题：原 `impact` 用 `r.status === 'pushed'` 判「已推送」，与后端删除事务 `hasPushTrace()` 不一致——「推送后退回草稿」的文章会被 UI 误说成「角度会归还」，实际不归还。
- 实现：把内联 impact 计算替换为 `batchDeleteImpact`（共用纯函数），判据改为 `mediaId`/`pushDate` 推送痕迹，措辞与原文案逐字一致。删除接口、事务、选题回收规则、实际删除行为一律未动。

**A3 统一列表推送失败反馈（P2-5）**
- 问题：列表页失败弹窗标题恒为 `推送未成功（${errcode ?? "无 errcode"}）`，把 `already_pushed` / `pushing` / `lint_failed` 等业务规则拦截显示成「无 errcode」，易被误认为微信报错。
- 实现：抽取 `pushFailView(res)` 纯函数，列表页与改稿页**共同调用**（改稿页原内联分类已删除，改为调用同一函数），杜绝日后两页逻辑分叉。保留 `res.message` 作正文，`res.detail` 等信息不丢失。

### B. 文章编辑页

**B4 增加标题/摘要派生规则说明（P2-3 低成本缓解）**
- 问题：标题/摘要无独立输入框，由正文派生，非技术用户不知去哪改。
- 实现：在右侧预览区 meta 的「标题」「摘要」行下各加一行弱化说明（`.derive-note`）：
  - 标题：取自正文首个 h1，自动带「【话】」前缀；改标题请改正文 h1
  - 摘要：取自正文首段前 54 字；改摘要请改正文首段
  - 文案与 `server/src/services/render/index.ts`（prefix `【话】`、`firstPText.slice(0,54)`）一致。**未加输入框、未改渲染逻辑/接口**。

**B5 区分强调补全与 AI 改写工具区域（P3-2）**
- 问题：两条工具条紧邻、按钮结构同构（预览+应用），初见易混。
- 实现：各自包一层 `.tool-region`（轻边框 + 小标题 + 一句话说明）：「强调补全 —— 按加粗数量规则补足 strong / 品牌红字，不调用 LLM」「AI 改写 —— 调用改写模型润色/重写/精简，按补充要求调整」。**保留原有预览/应用两步、按钮行为、AI 请求参数/提示词/模型调用/写库逻辑**，不引入卡片墙。

### C. 公共组件迁移

**C6 页头迁 PageHead、保存状态迁 SaveBar（P3-1）**
- 先核对组件 props/调用范式：`PageHead` 接 `title` / `desc` + `#actions` slot；`SaveBar` 接 `state`（clean/dirty/saving/saved/error）/ `errorText` / `saveLabel` + `save` 事件 + 默认 slot。
- 页头：自定义 `<header class="wb-page-head">` → `<PageHead title="在线改稿" :desc="rendered?.title ?? '加载中…'">`，原状态标签/返回/重新加载按钮移入 `#actions`；标题省略视觉用 `:deep` 保留。
- 保存条：自定义 `<div class="save-bar">` → `<SaveBar :state="saveState" :error-text="saveError" save-label="保存并重渲染" @save="save">`，推送按钮与快捷键提示放默认 slot。新增 `saveError` ref + `saveState` 计算属性（saving > error > dirty > saved）。
- **保留**：dirty 判断（onInput）、保存成功/失败反馈、Ctrl/Cmd+S（onKeydown）、`onBeforeRouteLeave` + `beforeunload` 离开保护、保存 API、正文数据、自动体检落痕。失败时 `saveError` 置位 → error 态，绝不显示「已保存」。

---

## 3. 推送事实展示规则及边界数据验证结果

判据：`hasPushTrace(row)` = `mediaId` 或 `pushDate` trim 后任一非空（逐字对齐后端 `article-delete.ts:54-58`），**不看 status**。

| 数据情况 | 推送事实列文案 | 配色 | 日期 |
|---|---|---|---|
| 无推送痕迹（含首次失败 failed） | 未推送 | info | — |
| 有痕迹 + status=pushed | 已推送 | success | 有 pushDate 才显示 |
| 有痕迹 + status=draft / updated | 推送后已改 | warning | 同上 |
| 有痕迹 + status=failed（历史脏数据） | 有历史推送记录 | info | 同上 |
| 有痕迹 + 未知 status | 有推送记录 | info | 同上 |

**浏览器实测（真实 dist + Mock，7 行夹具）**：
- id96 draft 无痕迹 → 未推送 ✓
- id88 draft + mediaId → 推送后已改 + 2026-11-15 ✓
- id93 failed 无痕迹（首次失败）→ 未推送 ✓（未误判成历史推送）
- id42 comic draft 无痕迹 → 未推送 ✓
- id87 draft 仅 pushDate → 推送后已改 + 2026-11-10 ✓
- id85 updated + 痕迹 → 推送后已改 + 2026-11-09 ✓
- id84 pushed → 已推送 + 2026-11-08 ✓

**边界**（断言覆盖）：纯空白字段算无痕迹；mediaId 带空格算有痕迹；有痕迹但无日期时 `dateRaw=''` 不虚构日期（hint 注明「无日期记录」）；`failed + 有痕迹` 显示「有历史推送记录」而非「推送后已改」。

> 说明：Mock 夹具未单列「failed + 有痕迹」的历史脏数据行，该项由断言测试（pushFact §2）覆盖，非浏览器实测。

---

## 4. 批量删除 impact 与后端 hasPushTrace() 口径一致性

- 后端权威：`article-delete.ts` `deleteArticleById` / `deleteAccount` 用 `hasPushTrace(a)` 决定选题是否归还（有痕迹不回收）。
- 前端改造：`batchDeleteImpact(rows)` 用 `rows.filter(hasPushTrace)` 统计「已推送」篇数，其余才算「角度会归还」。判据与后端同源等价（trim 后非空）。
- 断言验证（4 项）：全未推送 → 全部归还；全已推送 → 无归还文案；**status=draft 但有痕迹 → 算已推送、不说归还角度**（旧实现会判错的关键回归）；failed 有痕迹算已推送 / 无痕迹算未推送。
- 删除接口、事务、回收规则、实际删除行为均未在前端改动。

---

## 5. 推送失败分类映射及验证结果

`pushFailView(res)` 分类顺序（不可调换，与改稿页已验收逻辑一致）：

| 输入 | 标题 | 类型 |
|---|---|---|
| `reason=lint_failed` | 成稿体检未通过 | error |
| `reason=already_pushed` | 该文章已推送过，不能重复建草稿 | warning |
| `reason=pushing` | 该文章正在推送中 | warning |
| `everPushed=true` | 推送未成功（本次失败未清除此前的推送记录） | error |
| 有 `errcode` | 推送未成功（{errcode}） | error |
| 无 errcode | 推送未成功（无 errcode） | error |

**断言验证（7 项）**：6 类各自正确；`already_pushed` / `pushing` 标题不含 errcode、类型为 warning；`lint_failed` 优先级高于 `everPushed`。列表页与改稿页现共用该函数，浏览器确认两页不再出现「已推送被显示成无 errcode」。

---

## 6. SaveBar / PageHead 迁移情况

| 项 | 状态 | 说明 |
|---|---|---|
| 页头 → PageHead | 已迁移 | 自定义 header 替换为组件，`#actions` 保留状态标签/返回/重新加载，`:deep` 保留标题省略 |
| 保存条 → SaveBar | 已迁移 | 组件承载状态文案 + 保存按钮；推送按钮/快捷键放 slot；新增 `saveState` / `saveError` |
| dirty 判断 | 保留 | onInput 置 dirty 并清旧 saveError |
| 保存成功/失败反馈 | 保留并增强 | 成功 ElMessage + saved 态；失败 ElMessage + error 态（含原因） |
| Ctrl/Cmd+S | 保留 | onKeydown 未动 |
| 离开保护 | 保留 | onBeforeRouteLeave + beforeunload 未动 |
| 保存 API / 自动体检落痕 | 未动 | updateArticleContent + lint save 逻辑不变 |

**无「无法承载而保留原实现」的项**——两个组件均完整承载了原有行为。

---

## 7. 类型检查、构建、断言测试结果

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 通过（vue-tsc --noEmit，无输出） |
| 生产构建 | `npm run build` | ✅ built in 19.54s（1688 modules，产物含 article-push / SaveBar chunk） |
| 本轮断言 | `npm run test:article-push` | ✅ 26/26 通过 |
| todo-nav 回归 | `npm run test:todo-nav` | ✅ 34/34 通过 |

---

## 8. 浏览器验证结果

真实 dist（vite dev server 5199 代理本地 Mock 8787）+ headless Chrome，不连库、不调外网、不推送。控制台 **0 error**。

- **列表推送事实列**：6 类数据文案/配色/日期全部正确（见 §3）。
- **改稿页组件迁移**：PageHead 标题「在线改稿」✓；两个工具分区标题「强调补全」「AI 改写」✓；两条派生说明✓；预览按钮 2 个、应用按钮 2 个（两步操作未丢）✓；推送按钮✓。
- **保存三态**（补充走查）：初始 saved（已保存）→ 输入后 dirty（有未保存改动 + 保存按钮出现）→ 保存失败 error（保存失败 + 原因 + 可重试按钮），失败态绝不显示「已保存」✓。
- **未实测项如实标注**：
  - Ctrl/Cmd+S 与「未保存离开保护」的实际浏览器交互未逐项点击验证（代码核查确认逻辑完整保留，且本轮未改这两段）；
  - AI 改写 / 强调补全的真实 LLM 调用与写库未触发（Mock 无对应能力，且任务书禁止真实 LLM）——「预览/应用按钮存在且行为代码未改」已验证，真实模型链路未在浏览器实测。

---

## 9. 深色、窄屏验证

- **深色模式**：推送事实列 tag 配色在深色背景下清晰可读（未推送灰 / 推送后已改橙 / 已推送绿），文字对比度正常，截图 `81-31-articles-dark.png`。
- **窄屏 500px**：`docOverflow:false`（无横向溢出），筛选表单与表格布局正常；Element Plus 表格在窄屏自动收起次要列（含推送事实/状态等，操作列固定），与既有响应式行为一致（状态列窄屏下同样收起），本轮未改变该行为。截图 `82-31-articles-narrow.png`。

---

## 10. 是否有业务逻辑 / API / 数据库 / 配置变更

**全部为否**。本轮仅改展示层的文案、配色、组件与纯函数：
- 无业务状态机 / 状态枚举变更；
- 无 API 增删改（列表接口字段、推送接口、保存接口均未动）；
- 无 Schema / Migration / 数据库读写（未连 MySQL，未执行任何迁移）；
- 无 `.env` / 后端配置变更（`web/package.json` 仅加测试脚本，属前端开发脚本，非运行时配置）。

---

## 11. Git HEAD 与工作区保护情况

- HEAD：`b2fbad3`（与本轮开始前一致，未 commit / push / reset / checkout）。
- 本轮开始前工作区已有 **57 项**未提交改动，全部保持原样、未覆盖 / 回滚 / 清理。`server/**` 下显示的改动均为**本轮开始前既有**，本轮全程未触碰 server。
- 本轮新增/修改仅 §1 清单内文件（5 个 web 文件 + 本报告），另按用户长期约定与任务书 §6 在收尾时追加 `docs/DEVLOG.md` 一条（16:49 实施记录）——均属授权范围，未越界。

---

## 12. 遗留问题及风险

- **产线标识（P2-2）**：列表仍无漫画视觉标识，因后端列表 items 未回传 `pipeline`（虽 select 了），属任务书 §4 明确延期项，需后端小配合，本轮未做。
- **体检问题段落定位（P3-3）**：lint issue 无 `blockIndex`，仍需后端配合，延期。
- **「已更新」状态说明（P3-4）**：未在本轮解释「本系统不支持原地更新公众号草稿」，但推送事实列的 hint 已就「推送后已改」给出同义提示，部分缓解。
- **Mock 夹具差异**：走查用 Mock 数据不代表真实统计；「failed + 有痕迹」历史脏数据仅断言覆盖、未浏览器实测。
- **窄屏推送事实列**：随 Element Plus 表格响应式收起，窄屏用户看不到推送事实列——既有表格行为，若后续要求窄屏必显，需单独评估（如改列显示策略），不属本轮范围。

**本轮到此停止，等待人工验收，不自动进入下一阶段。**
