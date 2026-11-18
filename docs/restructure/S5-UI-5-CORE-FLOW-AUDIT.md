# S5-UI-5 · 剩余核心页面体验审计（只读）

**日期**：2026-11-17
**性质**：**只读审计**。未修改任何业务代码/CSS/模板/组件/配置；未改后端 API/Schema/Migration/`.env`；未连库、未调 LLM/微信、未推送、未装依赖、未改 package.json；未 Git 写操作；未删除/覆盖/清理任何文件。**本轮唯一新增文件为本报告 + DEVLOG 一条审计进度记录。**
**结论**：**存在 1 个 P1、4 个 P2、2 个 P3。** P1 是创作计划「出稿全部失败仍报成功并跳 `/articles/0`（404）」，已用真实浏览器 + 专用 Mock **完整复现**（证据链闭环，需后端配合修）。其余 P2/P3 均为体验问题，无数据丢失、无错误推送、无群发风险。**建议进入下一实施轮优先修 P1，暂缓需产品拍板项。**

---

## 1. 审计范围与环境
### 1.1 必读文档（5 份，全部存在；前序轮次已完整读过，本轮核对边界）
`RESTRUCTURE-2.0-CONVERGED-PLAN.md`(312)、`00-FINAL-EXECUTION-CHARTER.md`(144)、`TARGET-UI-ARCHITECTURE.md`(156)、`UI-UX-AUDIT.md`(42，11-12 旧静态分析仅作背景)、`DEVLOG.md`(1999)。

### 1.2 代码核查范围（以当前工作区实际代码为准）
| 链路 | 前端 | 后端 / 支撑 |
|---|---|---|
| A 创作计划 | `PlanView.vue`、`api/index.ts`(getPlan/triggerPlan) | `routes/plans.ts`、`services/planner.ts`、`types.ts`(PlanResult/PlanTask) |
| B 选题审核 | `TrackAnglesView.vue`、`utils/todo-nav.ts`、`DashboardView.vue`、`TracksView.vue` | `routes/angles.ts`、`services/topic-review.ts`、`services/angles.ts` |
| C 账号管理 | `AccountsView.vue`、`utils/format.ts` | `routes/accounts.ts`、`services/credentials.ts`、`lib/crypto.ts` |
| D 文风+模型 | `StylePromptsView.vue`、`ModelsView.vue` | `routes/models.ts`、`routes/style-prompts.ts`、`services/writer.ts` |
| E 文章到草稿箱 | `PlanView.vue`、`ArticlesView.vue`、`ArticleEditView.vue`、`utils/article-push.ts`、`utils/todo-nav.ts` | `services/writer.ts`、`lint.ts`、`publisher.ts`、`routes/articles.ts` |

### 1.3 浏览器走查环境
复用现有 vite(5199)+Mock(`var/tmp/s5ui2c/mock.mjs`)+headless Chrome CDP；不连库、不调真实 LLM/微信、不推送。派生专用 Mock `mock-5p1.mjs`（加 `POST /api/plan/trigger` 全失败响应）用于 P1 复现。脚本/结果/截图在 `var/tmp/s5ui2c/`（临时目录、不进版本库）。

### 1.4 证据分级口径（本报告严格区分）
- **【代码确认】**：逐行读源码可直接判定的事实。
- **【浏览器验证】**：本轮真实 Chrome + DOM/几何/toast 实测。
- **【仅推断】**：代码推断、未实测。
- **【无法验证】**：当前只读环境/业务数据限制，未验证。

---

## 2. 已完成页面和链路清单（本轮不重复审计/返工）
S5-UI-0 初始审计、S5-UI-1 设计令牌与壳层、S5-UI-2 Dashboard 待办闭环、S5-UI-3 文章工作台、S5-UI-4-0 核心页审计、S5-UI-4-1-A 文风写作规范、S5-UI-4-1-B 选题库窄屏列、S5-UI-4-1-C 模型就绪状态——均已在 DEVLOG 标记关闭。本轮对 A/B/C 只做**跨页面链路和剩余问题**检查，不重复其已修事项。

---

## 3. 五条业务链路审计结果

### 链路 A · 创作计划与排产
**现状能力【代码确认】**：`PlanView` 表格展示账号/赛道/产线/已出/待补/可用角度(stock)/近作避让，URL 筛选持久化，产线级防重入锁；`planner.ts` 仅消费 `enabled && credStatus=ok` 账号的 `approved` 选题，返回 `warnings`（角色未就绪/库存告急）、`backlog`（欠账）、`skipped`（未排产）；触发走真实 Express 路由 + service。

**发现 1 个 P1（A1）+ 1 个 P2（A2）**，见 §4/§5。

### 链路 B · 选题审核与人工处理
**现状能力【代码确认】**：筛选（状态/审核/用途/排序/关键词）、六维评分展示、人工审核（通过/拒绝/要求修改）、审核记录、R1 重评分、去重提示；审核走后端状态机（CAS 防并发、approved/rejected 终态、重评分硬门禁），只有 approved 可被排产；Dashboard→选题库→赛道页跳转参数一致（`needs`/`pending=`/`angle`→`angleId` 无错配）。**未发现跨页参数错配**。
**发现 1 个 P3（B1，与 C 同类）**。窄屏审核态/评分可见性由 S5-UI-4-1-B 已修，本轮不重复。

### 链路 C · 账号管理与微信公众号配置
**现状能力【代码确认】**：账号 CRUD、AppID 明文/Secret 掩码（AES-256-GCM 落库、接口只回掩码）、连通测试（成功置 ok+启用、失败置 invalid+停用、40164 给加白指引）、删除级联事务（删文章→归还未推送角度→删账号）。
**三项点名专项核对【代码确认，均无问题】**：
1. **密钥处理**：Secret 列表只回掩码（保留首尾各 4 位、中间 6 星，`crypto.ts:50-54`），AppID 为公开标识符明文展示——符合预期。
2. **默认账号**：全库无 `isDefault/defaultAccount` 字段或入口，排产按全量 enabled+ok 账号逐个进行，无默认账号概念——非问题。
3. **只推草稿箱不群发**：App/Scheduler/Articles/ArticleEdit/publisher/wechat 全链路文案一致（"只进草稿箱、不会群发"），后端只调 `client.addDraft`，无 masssend——**未发现任何让用户误以为已群发的表达**。
**发现 1 个 P2（C1，状态语义观察项）+ P3（B1 同类）**。

### 链路 D · 文风配置与模型管理完整流程
**现状能力【代码确认】**：新增模型（供应商/协议/能力联动校验）→连通测试（真实请求+脱敏反馈）→角色绑定（不匹配项禁用并注明原因）→看就绪（S5-UI-4-1-C 已修的 resolve 真源）→配写作规范（S5-UI-4-1-A 已修的赛道 Tab + s:{赛道}）→保存/恢复默认（单项+全部+部分失败逐项+dirty 守护）。**配置顺序自然、后端错误均带可读下一步**，无 P0/P1，仅 1 个 P3（D-1 引导）。

### 链路 E · 文章生产到微信公众号草稿箱
**现状能力【代码确认】**：选题→排产出稿→AI 生成（体检定向修补、失败回退骨架并在 note 说明）→人工编辑（HTML 源码/标签/强调/改写/封面，dirty 守护）→实时体检（error 拦推送、warn 放行）→保存（即重渲染+留痕）→推送（dirty 拦截+二次确认+后端 7 重门禁）→结果（分类失败提示、media_id、推送事实列）。跨页跳转连贯、保存与推送区分清晰、失败分类完整、"只推草稿箱不群发"表达准确。
**发现 2 个 P2（E-1 体检命中片段未展示、E-2 无账号出口）+ 1 个 P3（E-3 已推送文章按钮无前置提示）**。


---

## 4. 问题清单（按 P0/P1/P2/P3 排序）
| # | 级别 | 链路 | 问题 | 需后端 |
|---|---|---|---|---|
| A1 | **P1** | A 创作计划 | 出稿全部失败仍弹绿色"已生成 N 篇草稿"，并跳 `/articles/0`（404） | **是** |
| A2 | P2 | A 创作计划 | 后端 warnings/backlog 在计划页完全未渲染，触发前预警落空 | 否 |
| C1 | P2 | C 账号管理 | `credStatus=ok` 只代表格式合规，列表显示"就绪/启用=是"但可能从未连通验证（观察项） | 否（改语义才需） |
| E-1 | P2 | E 文章链路 | 后端已返回的 lint 命中片段(hits)前端类型丢弃、模板不渲染，长文定位困难 | 否 |
| E-2 | P2 | E 文章链路 | 无账号文章的 `no_account` 错误指向 UI 做不到的动作（改稿页无选账号入口），用户被卡住 | 短期否 |
| B1 | P3 | B/C | 确认弹窗文案含 markdown `**`，字面显示星号 | 否 |
| D-1 | P3 | D 文风模型 | 新增模型成功后无"测试/绑定"引导，测试入口藏在二级菜单 | 否 |
| E-3 | P3 | E 文章链路 | 已推送文章推送按钮无"已推送/去后台"前置提示，只能点了才被拦 | 否 |

**P0：无。** 未发现核心流程不可用、严重数据错误、错误推送或数据丢失。

---

## 5. 每项问题的复现步骤、代码位置与证据

### A1【P1】出稿全部失败仍报成功并跳 `/articles/0` — **浏览器实测复现**
- **链路/位置**：A；`PlanView.vue:60-90`（res.ok 分支、first=created[0]、success toast、router.push）；`plans.ts:63-72`（`ok: created.length>0`、message 用 length 计数）；`planner.ts:405-417,490-502`（失败项 `id:0` 仍 push 进 created）。
- **复现**：创作计划点某行"立即出稿"→ 本批全部建稿/脚本失败（专用 Mock 返回 2 个 `id:0` 失败项 + `ok:true`）。
- **当前表现【浏览器验证，证据 `W5P1-result.json`】**：
  - 绿色 toast：「已为「星座物语」生成 2 篇草稿」（`toasts` 实测）；
  - 确认框标题：「已生成骨架草稿（模型未参与写作）」，与 message 内两条"建稿失败：模拟生成异常"自相矛盾（`confirm.title`/`confirm.message` 实测）；
  - 按钮"去改稿"→ `location.pathname = /articles/0`（`after.path` 实测）；
  - 落地页 StateError「数据加载失败 / 请求失败（HTTP 404）」（`after.stateErr` 实测）。
  - Console 0 error（错误被 StateError 正常承接，非崩溃）。
- **根因【代码确认】**：失败项 `id:0` 计入 `created` → `ok=length>0=true`；`first=created[0]` 是 `id:0`；文章线 `!modelUsed(null)` 把失败误判成骨架草稿。
- **预期**：只有 `id>0` 的真实草稿计入成功数与 ok；失败单列为"建稿/脚本失败，未生成草稿"，不给跳转；全部失败时无 success toast。
- **影响**：核心出稿流程反馈与真实状态相反，用户以为成功、到列表找不到或被送进 404 页，损害信任。
- **最小修复**：后端 `plans.ts:63` 改 `ok: created.some(c=>c.id>0)`、message 用成功数；或 planner 把失败项分离到独立字段。前端用 `created.find(c=>c.id>0)` 作 first，无成功项时按钮改"知道了"不跳转、标题区分"建稿失败"与"骨架草稿"。
- **需后端**：是（ok/message 计数在后端）。

### A2【P2】计划页未渲染 warnings/backlog
- **位置**：`PlanView.vue` 全文（模板只用 `plan.date/tasks/skipped`）；`planner.ts:205-216`（注释明确"让用户在触发前就知道结果"，构造 `「写作」角色未就绪：…请先到模型配置绑定`）；`types.ts:471-472` 已声明字段。
- **复现**：写作角色未绑定/角度库存告急 → 打开创作计划页。
- **当前表现【代码确认】**：页面看不到任何角色未就绪/库存告急/欠账提示；【浏览器验证】Mock 的 warnings/backlog 为空，`planFeedback.hasWarningWord=false`（无法在本次夹具下实测有值时的渲染，但模板确实无引用）。
- **预期**：触发前展示这些预警，避免出稿后才发现是骨架草稿。
- **影响**：反馈滞后、增加往返。非受阻（Dashboard 浮窗 `dashboard.ts:897-898` 会收拢同一份 warnings，有替代路径）。
- **最小修复**：PlanView 模板增加 `plan.warnings` 渲染（el-alert 或复用浮窗）；backlog 视需要展示。**需后端：否**（字段已返回）。
- **边界**：与 S5-UI-4-1-C 已修的"模型就绪状态"（App.vue 角色卡片）位置不同——此处是**计划页触发前**预警，非重复。

### C1【P2，观察项】credStatus=ok 状态语义
- **位置**：`AccountsView.vue:355-368`、`format.ts:115-120`（ok→"就绪"）；`accounts.ts:66-78`（`decideCredStatus` 仅格式判定即 enabled=true）；`credentials.ts:71-92` 创建 message 已提示"建议再跑一次连通测试确认"。
- **复现**：新增账号填格式合规但真实无效（如 IP 未加白）的 AppID/Secret，保存后看列表。
- **当前表现【代码确认】**：列表"就绪/启用=是"，可能从未通过连通测试；计划页会排入该账号。
- **预期**：区分"格式合规"与"连通已验证"。
- **影响**：依赖该状态判断可用性会被误导。已有顶部 alert 与保存 message 提示测试，属设计权衡。
- **最小修复**：未测试连通时显示"格式合规·待验证"，测试通过后才置"就绪"；或明确 ok 文案含义。**需后端：否**（改状态机语义才需）。

### E-1【P2】体检命中片段(hits)未展示
- **位置**：`ArticleEditView.vue:988-996`（只渲染 `it.message`）；`types.ts:899-904`（`ArticleLintIssue` 无 hits 字段）；后端 `lint.ts:68/246/399-445`（`LintIssue.hits?: string[]`，dash/negation/citation/fear_selling/zodiac_* 均带命中上下文）。
- **复现**：生成含破折号/否定框架的文章 → 体检面板显示"出现 N 处破折号，需改写"，但不知是哪几句。
- **当前表现【代码确认】**：message 只给数量；后端随接口返回的 hits 在前端类型层被丢弃、模板不渲染。
- **预期**：每条问题下展示命中片段（折叠），便于定位。
- **影响**：长文人工改稿定位成本明显增加；有替代路径（预览肉眼找），非受阻。
- **最小修复**：`ArticleLintIssue` 加 `hits?: string[]`，列表项折叠渲染 `it.hits`。**需后端：否**（数据已随 lintArticle 返回）。
- **边界**：与 S5-UI-3-0 延期的"点击问题一键跳转段落(blockIndex)"不同——这是**已有文本片段**未展示，成本极低。

### E-2【P2，边缘场景】无账号文章无出口
- **位置**：`publisher.ts:141-142`（"文章未绑定账号，无法推送。请先指定 accountId"）；`ArticleEditView.vue`/`ArticlesView.vue` 全文无账号设置交互；`api/index.ts` 的 `createArticle(accountId)` 无前端调用。
- **复现**：一篇 `accountId` 为空的文章（历史/脏数据）→ 改稿页点推送 → 提示"请先指定 accountId" → 全系统找不到指定账号入口。
- **当前表现【代码确认】**：账号实为创作计划按账号排产时确定，改稿/推送阶段只读；正常流程不产生无账号文章。
- **预期**：要么提供账号选择/切换入口，要么错误文案改为可执行指引。
- **影响**：边缘场景一旦发生用户被卡住。**需后端：短期否**（改文案）；真正支持改绑账号则是。
- **无法验证**：无账号文章的实际来源/频率（正常出稿均带 accountId）。

### B1【P3】确认弹窗 markdown 星号字面显示
- **位置**：`TrackAnglesView.vue:619`（`审核为**通过**`）；`AccountsView.vue:292`（批量删除 impact `**一并删除…**`）。
- **表现【代码确认，浏览器未逐字截图】**：`ElMessageBox.confirm` 不解析 markdown，星号按普通字符显示。
- **修复**：去掉 `**`；或统一富文本渲染。**需后端：否**。

### D-1【P3】模型配置引导偏弱
- **位置**：`ModelsView.vue:593-597`（连通测试在 modelActions 下拉）、角色绑定卡片与模型列表分离。
- **表现【代码确认】**：新增模型保存后仅提示"已创建"，测试入口藏二级菜单，测试/绑定分处上下两区。
- **影响**：首次配置需额外探索，有页面说明兜底，非受阻。**需后端：否**。

### E-3【P3】已推送文章推送按钮无前置提示
- **位置**：`ArticleEditView.vue:889`（按钮固定"推送草稿箱"）、`:1014`（media_id 在预览区末尾）；`publisher.ts:126-133`（already_pushed 拦截）。
- **表现【代码确认，浏览器未实测】**：已推送文章顶部状态 tag 显示"已推送"，但推送按钮仍可点"推送草稿箱"，点后才弹"已推送过…去公众号后台"。
- **影响**：一次无效点击 + 说明弹窗，无数据风险（拦截有效）。**需后端：否**。


---

## 6. 浏览器走查及不同视口结果
脚本 `var/tmp/s5ui2c/walk-5.mjs`（结果 `W5-result.json`）+ P1 专用 `walk-5p1.mjs`（`W5P1-result.json`）；截图 `W5-*.png`。vite(5199)+Mock(8787/8790)+headless Chrome CDP。

### 6.1 多视口渲染【浏览器验证】
| 视口 | 覆盖页面 | 结果 |
|---|---|---|
| 1440 桌面 | plan/angles/accounts/models/style/articles/dash | 7 页标题与容器正常，`docOverflow=false`；articles 7 行数据；其余页行数为 0 系 Mock 对应端点数据空或加载时序（非崩溃） |
| 1024 | plan/angles/accounts/articles | 标题正常、`docOverflow=false` |
| 500 | plan/angles/accounts/articles | 标题正常、`docOverflow=false`；articles 7 行正常 |
| 500 深色 | articles | `html.dark=true`、`docOverflow=false`，渲染正常 |

> 说明：多页"行数 0"是走查脚本等待条件（等标题出现）早于数据请求返回所致，不能据此判定功能不可用；本轮关键问题（P1）用独立脚本充分等待数据后完成复现。

### 6.2 关键 UI 表达【浏览器验证】
- **草稿箱边界**：articles 页实测 `hasDraftOnly=true / hasNoMass=true / hasMassSent=false` → 页面写明"只进草稿箱、不会群发"，且无任何"已群发"字样。**安全边界表达准确**。
- **计划页反馈**：Mock 的 skipped/warnings/backlog 为空，`planFeedback` 三项均 false；A2 的"有值时是否渲染"因夹具为空未能实测，但代码层确认模板无引用（见 §5 A2）。

### 6.3 P1 完整复现【浏览器验证，本轮最强证据】
见 §5 A1：`W5P1-result.json` 记录了误导 toast、自相矛盾的确认框、`/articles/0` 跳转与 404 StateError 的完整链路，Console 0 error。

### 6.4 Console
基础走查有 4 条 `Uncaught (in promise)`，定位于 Mock 未实现的 `/api/credentials` 等端点（见 requests.log），**属夹具局限，非产品缺陷**；P1 专用走查（Mock 补齐 trigger）Console 0 error。

---

## 7. Mock 覆盖范围与未验证事项
### 7.1 Mock 覆盖
现有 `mock.mjs` 覆盖 `/api/articles`(7 行含多状态多评分)、`/api/plan`(tasks/skipped/warnings 空)、`/api/angles`(4 行多状态)、`/api/tracks`、`/api/dashboard`、`/api/pipelines` 等；派生 `mock-5p1.mjs` 补 `POST /api/plan/trigger` 全失败响应。

### 7.2 未验证事项（严禁写成已验证）
1. **A1 真实发生频率**：失败项 `id:0` 逻辑代码确认，但真实建稿失败频率未知（需真实 LLM，本轮禁止）。
2. **A2 有值时渲染**：Mock warnings/backlog 为空，未实测有预警时页面表现（代码确认模板无引用）。
3. **C1 角色视野**：admin/member 下账号状态表现、编辑保存后即时刷新未实测。
4. **E-1 浏览器观感**：hits 未展示代码确认，未生成含命中片段的真实文章实测（需真实 LLM）。
5. **E-2 无账号文章来源**：正常出稿均带 accountId，`no_account` 实际触发频率未知。
6. **B1/E-3 逐字视觉**：markdown 星号、已推送按钮提示仅代码确认，未逐字截图。
7. **深色全页面**：仅 articles@500 实测深色，其余页深色未逐一走查。
8. **40164 客户端层是否重试**：`publisher.ts` 层无重试（代码确认），`wechat.ts` 客户端层未在范围。

---

## 8. 已关闭模块与本轮发现问题的边界
- **不与 S5-UI-4-1-B 重复**：选题库窄屏列可见性已修，本轮 B 链路不提该问题。
- **不与 S5-UI-4-1-C 重复**：模型就绪状态（角色卡片）已修；A2 是**计划页触发前**的 warnings 未渲染，位置不同，非重复。
- **不与 S5-UI-4-1-A 重复**：写作规范 Tab/key 已修；D 链路只走端到端体验。
- **不与 S5-UI-3 重复**：文章工作台已关闭；E-1（hits 片段展示）是新发现，与已延期的"blockIndex 一键跳转"不同；E-2/E-3 是跨页面/剩余问题。
- **S5-UI-2 已关闭**：Dashboard 待办闭环不重复审计。
- 本轮**未把任何已修问题重新列为待修**；对观察项（C1）如实标注设计权衡，未为凑数升级级别。

---

## 9. 推荐的后续实施顺序
1. **P1 · A1（优先）**：出稿失败反馈修正——后端 `ok`/message 按成功项（`id>0`）计数 + 前端跳转/文案区分失败。**这是唯一会误导用户并送进 404 的问题，且需后端配合，建议单独授权一个小版本**。
2. **P2 · E-1**：体检 hits 片段展示（纯前端、零后端、成本极低，直接降低日常改稿定位成本）。
3. **P2 · A2**：计划页渲染 warnings/backlog（纯前端，字段已返回）。
4. **P2 · E-2 短期**：改 `no_account` 文案为可执行指引（纯前端）；真正支持改绑账号另立。
5. **暂缓/需产品拍板**：C1（改 credStatus 语义涉及状态机认知）、D-1/B1/E-3（P3 体验细节）、E-2 改绑账号能力、任何"补默认账号/任务中心/群发"类扩大范围改造。

---

## 10. 是否存在阻塞 S5 收尾的 P0/P1
- **P0：无。**
- **P1：有 1 个（A1）**——但它不阻塞已关闭模块的成果，也不涉及数据/推送安全，只影响"出稿失败时的反馈正确性"。**是否阻塞 S5 收尾取决于验收口径**：若要求"所有核心流程反馈准确"再收尾，应先修 A1；若接受"失败反馈滞后/误导可通过替代路径（去文章列表确认）弥补"，可作为已知问题登记后在后续版本修。本审计**不擅自决定**，交由人工验收裁定。

---

## 11. Git HEAD 与工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 65 项未提交改动全部保持原样，未覆盖/回滚/清理/删除；本轮只新增本报告与 DEVLOG 一条（工作区 65→67）。
- **Git 写操作**：无 commit/push/reset/stash/checkout。
- **临时产物**：走查脚本/截图/JSON 与派生 Mock 在 `var/tmp/s5ui2c/`（不进版本库）；查看用系统临时截图副本已清理；所有服务（5199/8787/8790/5202）与 Chrome（9395/9396）已停止、端口全部释放。

---

## 12. 副作用声明
**本轮严格只读。** 未修改任何业务代码、CSS、模板、组件或配置；未修改后端 API、数据库 Schema、Migration、`.env`；未连接或写入任何数据库；未调用真实 LLM 或微信公众号接口；未推送文章；未安装依赖或修改 package.json；未执行任何 Git 写操作；未删除、覆盖或清理任何既有文件；未修复审计中发现的任何问题；未新增设计方案类文档。唯一新增文件为本报告，另按项目约定追加 DEVLOG 一条审计进度记录。

---

**本轮到此停止。** 不自动实施任何修复，不进入 S5-UI-6，等待人工审查报告后确定修复范围。
