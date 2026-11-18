# S5-UI-4-0 · 核心业务页面现状审计报告

**日期**：2026-11-17
**性质**：**只读审计**。未修改 `web/src/**`、`server/**`、API、Schema、Migration、`.env`；未连库、未调 LLM/微信、未推送、未装依赖、未改 package.json；未执行 Git 写操作；未改历史报告、未新增设计方案类文档。**本轮唯一新增文件为本报告。**
**结论（先给判断）**：**存在 1 个 P1、4 个 P2、5 个 P3。** 唯一 P1 是文风配置「写作规范」Tab 错挂全局变体库、保存 key 错位（改了存不到正确位置）。真正影响日常使用的问题是：① 文风配置写作规范无法正确编辑保存（P1）；② 选题库 500px 下审核态/评分等核心列全部落在可视区外（P2，有浏览器实证）；③ 模型就绪状态可能误报导致产出失败（P2）。**建议进入 S5-UI-4-1**，优先修 P1 + 两个高频 P2，暂缓低频/需产品拍板项。

---

## 1. 审计范围、方法和实际读取文件

### 1.1 审计依据（9 份，7 存在 / 2 不存在如实记录）
| 文件 | 状态 |
|---|---|
| `docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md` | ✅ 实读（312 行） |
| `docs/restructure/00-FINAL-EXECUTION-CHARTER.md` | ✅ 实读（144 行） |
| `docs/DEVLOG.md` | ✅ 实读（1974 行，含 S5-UI-3-3 实施记录） |
| `docs/restructure/TARGET-UI-ARCHITECTURE.md` | ✅ 实读（156 行） |
| `docs/restructure/UI-UX-AUDIT.md` | ✅ 实读（42 行，11-12 静态分析，多数结论已被 S5-UI-1/2/3 解决，仅作背景） |
| `docs/restructure/S5-UI-1-IMPLEMENTATION-REPORT.md` | ❌ **不存在**（未自行创建替代） |
| `docs/restructure/S5-UI-2-DASHBOARD-TODO-CLOSURE-AUDIT.md` | ❌ **不存在**；实际近似文件为 `S5-UI-2-D-4-DASHBOARD-TODO-CLOSURE-AUDIT.md`（14050 字节，作参考，未改） |
| `docs/restructure/S5-UI-3-0-ARTICLE-WORKBENCH-AUDIT.md` | ✅ 实读（302 行） |
| `docs/restructure/S5-UI-3-3-IMPLEMENTATION-REPORT.md` | ✅ 实读（136 行） |

### 1.2 代码核查范围（以当前工作区实际代码为准）
| 层 | 文件 |
|---|---|
| 路由/壳层 | `web/src/router/index.ts`、`web/src/App.vue`（菜单分组与角色） |
| 页面 | `TrackAnglesView.vue`(1432)、`PlanView.vue`(208)、`ModelsView.vue`(995)、`AccountsView.vue`(538)、`StylePromptsView.vue`(1175)、`TracksView.vue`(872)、`PrefixSettingsView.vue`(113)、`UsersView.vue`(150)、`SchedulerView.vue`(269)、`DashboardView.vue`（已关闭项，仅核对跳转） |
| 前端支撑 | `web/src/api/index.ts`、`web/src/types.ts`、`web/src/utils/format.ts`、`web/src/components/StatusTag.vue`、`web/src/composables/useBatchDelete.ts` |
| 服务端 | `server/src/api/routes/angles.ts`、`plans.ts`、`models.ts`、`accounts.ts`、`credentials.ts`、`style-prompts.ts`、`system.ts`、`scheduler.ts`、`server/src/services/angles.ts`、`llm.ts`（`tryResolveForRole`）、`model-registry.ts` |
| 测试夹具 | `var/tmp/s5ui2c/mock.mjs`、`walk-4-0.mjs`、`walk-4-0b.mjs`、`A40-result.json`、`A40-narrow-cols.json` |

### 1.3 方法
1. 先梳理 router 与 App.vue 菜单确定页面范围；2. 逐页读组件/API/类型/服务端实现；3. 复用现有 Mock + vite + headless Chrome 做**只读浏览器走查**（7 个页面桌面 + 选题库深色/500px 量化）；4. 区分「代码确认」与「浏览器观察」；5. 不能验证的明确标记未验证。
**浏览器走查限制（必须知悉）**：现有 Mock `var/tmp/s5ui2c/mock.mjs` 未实现 `/api/style-prompts` 与 `/api/models` 本体，`/api/models/meta` 返回空数组——故文风配置页走查只得到 `StateError: list.items is not iterable`（Mock 返回 404 结构所致，**非真实代码缺陷**），模型页只看到空态。文风 P1 的**保存行为无法在 Mock 下实测**，标为「代码确认、浏览器未验证」。

---

## 2. 当前核心页面和路由清单
| 路由 | 页面 | 业务职责 | 菜单可见角色 | 本轮审计 |
|---|---|---|---|---|
| `/` | DashboardView | 产出/库存/健康 + 四类待办 | 全角色 | 已关闭，仅核对跳转 |
| `/login` | LoginView | 登录/注册 | public | 低频，跳过 |
| `/plan` | PlanView | 今日排产、手动出稿 | admin/member | ✅ B |
| `/scheduler` | SchedulerView | 自动调度开关/时间/心跳 | admin/member | ✅ 附带 |
| `/articles` `/articles/:id` | 文章列表/改稿 | 文章工作台 | 全角色/创作角色 | S5-UI-3 已关闭，仅核对无新问题 |
| `/accounts` | AccountsView | 公众号账号凭据与测试 | admin/member | ✅ D |
| `/tracks` | TracksView | 赛道 CRUD/配额/产线/扩库入口 | admin | ✅ E |
| `/tracks/:id/angles` | TrackAnglesView | 选题库：审核/编辑/扩库/去重 | **菜单无入口**（后端 system:manage） | ✅ A（重点） |
| `/models` | ModelsView | LLM 模型接入/测试/角色绑定 | admin | ✅ C |
| `/style-prompts` | StylePromptsView | 文风配置（总纲/系统词/变体/写作规范） | admin | ✅ E（重点） |
| `/users` | UsersView | 注册审批/角色/配额 | admin | ✅ E |
| `/prefixes` | PrefixSettingsView | 标题前缀 | admin | ✅ E |

**关键结构事实**：选题库不在侧栏菜单，只能从赛道管理下钻（UI-UX-AUDIT 旧结论仍成立，属既定设计）；member 无选题能力（后端 `anglesRouter.use(requirePermission('system:manage'))`），属产品 RBAC 决策，本轮不提"补菜单"类建议。

---

## 3. A-E 各模块审计结论

### A · 选题管理与人工审核 —— 规则呈现准确，窄屏体验缺失
**现状能力（均代码确认）**：赛道切换（URL query）、审核态筛选（candidate/needs_revision/approved/rejected 四态）、消费态筛选（used/unused，与审核态两维度）、用途筛选（article/comic/shared）、按评分排序、六维评分展示、审核操作（通过/拒绝/要求修改）、审核记录（多轮）、重新评分（rescoreRequired）、去重命中提示、AI 扩充、手动新增、批量删除、关联文章跳转、空/错/加载三态。**规则呈现核对**：六维评分 0–5/维、总分 0–30 等权合计（`TrackAnglesView.vue:1031-1048`、`types.ts:156`），明确"仅供参考、以人工审核为准"；审核通过确认框写明"通过后它才会被排产消费（used 由排产置）"（`:638`）；candidate/needs_revision 才可审核、approved/rejected 终态无审核入口（`:709-727`）；去重 tag 明确"仅提示，不影响保存 / L2 仅提示不拦截"（`:999-1029`）——**完全符合任务要求，无误导**。Dashboard 选题待办跳转已在 S5-UI-2-D 关闭，`/tracks?pending=` 标记后可二次下钻（已知 P3-3，非新问题）。

**A 模块问题**：
- **A-1（P2）**：500px 下审核态、评分、用途、状态列全部在可视区外。浏览器实证见 §4。
- **A-2（P3）**：审核通过确认框文案含 `**通过**`（`:638`），`ElMessageBox` 不渲染 Markdown → 字面显示星号。
- **A-3（P3）**：选题库前端路由无 `meta.roles`（`router/index.ts`），member 直接输 URL 会落到页面后由后端 403 → StateError，而非明确"无权限"提示（低频）。

### B · 创作计划与任务执行 —— 反馈闭环完整，前置披露不足
**现状能力（均代码确认）**：排产表格（账号/赛道/产线/已出/待补/可用角度/近作避让）、防重入锁（`triggeringKey`）、出稿成功后分类反馈（骨架草稿 `modelUsed` 为空 / 漫画脚本失败 note / 正常）、明确引导（去模型配置绑定角色 / 去改稿页）、生成成功跳 `/articles/:id`、空态/错态/skipped 未排产原因。**未虚构**：无任务中心、无 TaskRun 进度条/重试链、未强关联 RunLog、未重复 Dashboard 异常摘要（Dashboard 已有完整的 TaskRun 异常抽屉，已关闭审计）——符合任务约束。

**B 模块问题**：
- **B-1（P2）**：`trigger()`（`PlanView.vue:50-60`）点「立即出稿/生成漫画」直接调 `triggerPlan`，**无前置确认、无 AI 操作披露**（消耗模型额度、产出写正式文章、能否撤销均未说明），违反 UI-GUIDE「AI 操作披露」规范；且这是数十秒级重操作，误触成本高。最小方案：加前置 `ElMessageBox.confirm` 说明影响（账号/产线/预计篇数/消耗额度/落草稿可改）。

### C · 模型配置与模型测试 —— 链路完整，就绪状态判定有缺口
**现状能力（均代码确认）**：四维真源 `model-registry.ts` 经 `GET /models/meta` 下发（注意：任务书提到的 `system.ts GET /model-meta` 实际不存在，真实端点为 `GET /models/meta`，前端 `getModelMeta()` 指向它——**非缺功能**）、增删改/批量删、协议联动能力、协议↔能力交叉校验、按协议真实连通测试 + `scrub` 脱敏、7 角色绑定 + 后端 `roleAcceptsModel` 双校验、API Key 加密落库只回掩码、留空不改 Key。cover/comic_panel 不收 multimodal，与既有结论一致。

**C 模块问题**：
- **C-1（P2）**：`bindState`（`ModelsView.vue:498-507`）只判 绑定/存在/启用/Key 即显示"就绪"，未校验能力/协议匹配与协议是否实现；后端 `tryResolveForRole`（`llm.ts:953-983`）还会因 `roleAcceptsModel` 不匹配 / 协议未实现判不可用。用户看到"就绪"但实际写作/生图产出失败。交叉验证完成，代码证据充分。
- **C-2（P3）**：前端降级兜底 `FALLBACK_ROLES`（`:63-108`）只 6 角色，缺 `comic_panel_fallback`，cover 协议白名单与真源漂移；仅 meta 加载失败时表现。
- **C-3（P3）**：生图连通测试无前置额度消耗提示，仅事后 message 说明（`runTest` `:428-448`）。

### D · 公众号账号管理 —— 安全处理到位，仅文案瑕疵
**现状能力（均代码确认）**：列表/状态（credStatus 四态中文+配色）、AppID 明文展示（非 Secret，合理）/Secret 仅掩码+AES-256-GCM 加密落库+API 永不返回明文、编辑留空不改、连通测试成功/失败反馈（40164 返回出口 IP+加白指引）、占位凭据双重拦截、删除级联（删文章→归还角度→TaskRun 置空）+ 影响说明、赛道决定选题池。**本次未读取/输出任何真实密钥值。**凭据异常引导完整，无问题。

**D 模块问题**：
- **D-1（P3）**：批量删除确认 impact 文案含 `**一并删除...**`（`:292`），`useBatchDelete` 确认框无 HTML 渲染 → 字面显示星号（单条删除无此问题）。
- **D-2（P3）**：无手动启用/停用开关（enabled 全自动由凭据状态机决定），需产品确认是否刻意；若刻意应在列表头注明。
- **D-3（P3）**：编辑态 AppID 无校验、清空静默不改（`editRules` 只有 name/trackId，`save` 中 `if(dialog.appid)` 才下发）。

### E · 系统设置与其他核心页面 —— 存在唯一 P1
**TracksView**：赛道 CRUD/配额（标 deprecated，真源在产线）/产线配额开关/扩库入口/三处下钻选题库，信息组织清晰。问题 T1（P2）：产线配额改脏后点刷新或任一触发 `load()` 的操作会静默重载丢弃未保存改动（`:58-70` + `:433`，对比文风页有 dirty 拦截）。
**StylePromptsView**：左导航+单面板、未保存保护完整（汇总条/逐项点/SaveBar/Ctrl+S/beforeunload/路由离开/刷新确认）、变体逐条编辑、恢复默认只填缓冲区、保存反馈齐备——整体质量高。问题见下。
**PrefixSettingsView / UsersView / SchedulerView**：低频/附带审计，**未发现需修 UI 缺陷**（详见 §各模块未验证项）。内容策略不存在独立页但能力已合并到文风配置创作总纲+赛道文体，不算缺失；系统设置入口分散在 admin 菜单，非缺失。

**E 模块问题**：
- **E-1 / S1（P1，唯一 P1）**：写作规范 Tab 错挂全局变体库、保存 key 错位。证据链：① 全局库面板 `current==='gv'` 含 `name="spec"` 的「写作规范」Tab（`StylePromptsView.vue:665`），绑定 `buf[skey(currentTrack)]`，但此时 `currentTrack=''`（`current` 为 `'gv'` 非 `'track:'` 前缀，`:120-122`）→ 编辑的是无效 key `s:`；② 底部 SaveBar 保存 `vkey(K_GLOBAL, gvTab)` = `v:global:spec`（`:698`），而 DIMS 只有 title/structure/length，后端无此 key；③ 赛道面板 Tabs 只有 sys/prompt/DIMS（`:742-816`），**没有写作规范入口**；④ `currentEditorKey` 的 `spec` 分支（`:132`）是死代码，无任何 Tab 令 `trackTab='spec'`。用户想编辑某赛道写作规范（`s:{赛道}`）在赛道面板找不到入口；在全局库改了点保存存到无效 key，等于白改且写入无意义库记录。
- **E-2 / S2（P2）**：恢复默认对 `s:` 前缀查找失败——`restoreKey`（`:371-386`）用 `d.specs[key]` 查内存 defaults，但 `d.specs` 的 key 是裸赛道名（"星座"），查 `s:星座` 落空 → 误报"没有出厂默认值"；后端 `GET /style-prompts/:key/default` 实际能返回（`style-prompts.ts:2277-2280`）。
- **E-3 / S3（P3）**：删除赛道文风配置（`removeTrack` `:446-473`）不检查该赛道是否有未保存改动，确认框不提示，删除直接丢缓冲区。


---

## 4. 每个发现的问题及证据（含浏览器实证）

### 4.1 浏览器走查结果（真实 vite + Mock + headless Chrome，只读）
脚本 `var/tmp/s5ui2c/walk-4-0.mjs` + `walk-4-0b.mjs`，数据 `A40-result.json` + `A40-narrow-cols.json`，截图 `A40-*.png`（临时目录、不进版本库）。admin 视角，桌面 1440px：

| 页面 | 标题 | 表格行数 | 关键列 | 空态/错态 | docOverflow |
|---|---|---|---|---|---|
| 选题库 | 选题库 | 3 | ID/主题/选题内容/用途/审核/评分/状态/关联文章/来源/操作 | 无 | false |
| 创作计划 | 创作计划 | 2 | 账号/赛道/产线/已出/待补/可用角度/近作避让/操作 | 无 | false |
| 模型配置 | 模型配置 | 0 | 名称/供应商/协议/能力/Base URL/模型ID/Key/绑定角色/状态/操作 | 空态「还没有模型…」 | false |
| 账号管理 | 账号管理 | 0 | ID/账号/赛道/AppID/Secret/作者/状态/启用/操作 | 空态「还没有账号…」 | false |
| 文风配置 | 文风配置 | — | — | **StateError「list.items is not iterable」= Mock 未实现端点所致** | false |
| 赛道管理 | 赛道管理 | 2 | ID/赛道/标识/每日配额/启用/账号/文章/选题池/产线/操作 | 无 | false |
| 仪表盘 | 仪表盘 | 2 | 账号/赛道/配额/已出/待补/可用角度/进度 | 空态「暂无任务流水」 | false |

**A-1 的 500px 可视区量化（`walk-4-0b.mjs`，视口 500px）**——列真实位置（表格 body 容器 left=97/right≈467）：
| 列 | left→right (px) | 视口内? |
|---|---|---|
| 选择 | 97→135 | ✅ |
| ID | 143→205 | ✅ |
| 主题 | 205→315 | ✅ |
| 选题内容 | 315→615 | 部分（被截断） |
| 用途 | 615→815 | ❌ |
| **审核** | **815→965** | ❌ **候选待审不可见** |
| **评分** | **965→1061** | ❌ **21/30 不可见** |
| **状态** | **1061→1241** | ❌ |
| 关联文章 | 1241→1329 | ❌ |
| 来源 | 0→0 | ❌（col-optional 已隐藏） |
| 操作 | 357→467 | ✅（fixed right） |

`docOverflow:false` 仅说明页面无横向溢出（表格内部滚动），与 S5-UI-3-2 上轮误判同类——**必须用可视区相交判断**。截图 `A40-angles-narrow-cols.png` 视觉确认：窄屏只见 ID/主题/选题内容（截断）+ 操作，审核态与评分完全看不到。**这是本轮新发现的真实问题**（文章工作台已修，选题库未修）。

**深色/浅色**：选题库深色截图 `A40-angles-dark.png` 已实看——深色背景与文字对比正常，状态标签（候选待审/已通过）与评分（21/30/未评分）清晰可辨，桌面端审核/评分列完整可见（印证 A-1 仅窄屏发生）。**控制台**：走查捕获 3 条 `Uncaught (in promise)`，定位于 Mock 未实现端点（文风页等）的未捕获拒绝，**属夹具局限，非产品缺陷**。

### 4.2 问题证据汇总表（每个问题：位置/行为/影响/代码证据/浏览器证据/最小方案/文件/是否涉 API-DB-逻辑/优先级）
| # | 页面位置 | 当前行为 | 用户影响 | 代码证据 | 浏览器证据 | 最小方案 | 涉及文件 | API/DB/逻辑 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| S1/E-1 | StylePromptsView 全局库 spec Tab `:665` + SaveBar `:698` + 死代码 `:132` | 写作规范错挂全局库、绑定 `s:`、保存 `v:global:spec`；赛道面板无入口 | 改了存不到正确 key，等于白改+写无效记录 | ✅ 强 | ❌ 未验证（Mock 无端点） | Tab 移到赛道面板，复用 `:132` spec 分支，全局库删该 Tab | StylePromptsView.vue | 是：改变写入 key（`s:{赛道}`），不改 API/后端逻辑 | **P1** |
| A-1 | TrackAnglesView 表格 `:948+` | 500px 审核/评分/用途/状态全在可视区外 | 窄屏无法判断审核态与评分 | ✅（仅 1 处 col-optional） | ✅ 实测 left 815–1241 | 窄屏固定审核+评分列到左侧或加 col-optional 优先级（同文章工作台修法） | TrackAnglesView.vue | 否 | **P2** |
| C-1 | ModelsView `bindState :498-507` | 就绪状态不校验能力/协议匹配 | "就绪"但产出失败 | ✅ 强（`llm.ts:953-983` 交叉验证） | ❌ 需场景验证 | load 拉 `GET /models/resolve/:role`，以 `usable`/`reason` 为准 | ModelsView.vue（api 已有 resolveRole） | 是：业务可用性判定 | **P2** |
| B-1 | PlanView `trigger :50-60` | 立即出稿无前置确认/AI 披露 | 误触消耗额度、不知影响 | ✅ | 部分（页面可见按钮） | 加前置 confirm 说明账号/产线/篇数/额度/落草稿可改 | PlanView.vue | 否 | **P2** |
| S2/E-2 | StylePromptsView `restoreKey :371-386` | `s:` 恢复默认查不到（裸 key） | 误报"没有出厂默认值" | ✅ 静态可定 | ❌ 未验证 | `s:` 前缀取 `d.specs[key.slice(2)]` 或走后端 default 接口 | StylePromptsView.vue | 否（API 已具备） | **P2** |
| T1 | TracksView `load :58-70` + 刷新 `:433` | 产线配额改脏后刷新静默丢弃 | 改动无声消失 | ✅ | ❌ 需场景验证 | load 入口加 dirty 确认（仿文风页 `refresh()`） | TracksView.vue | 否 | **P2** |
| D-1 | AccountsView `:292` | 批量删除文案含字面 `**` | 确认框不专业/困惑 | ✅ | 部分 | 删除 `**` | AccountsView.vue | 否 | P3 |
| D-2 | AccountsView `accountActions :373-390` | 无手动启停开关 | 无法临时停用账号 | ✅ | 部分 | 产品确认：加端点或注明自动化 | AccountsView.vue / credentials.ts | 是（状态机） | P3（待产品） |
| D-3 | AccountsView `editRules/save :96-141` | 编辑态 AppID 无校验、清空静默 | 误清空无反馈 | ✅ | ❌ | 加校验或提示"留空不改" | AccountsView.vue | 否 | P3 |
| C-2 | ModelsView `FALLBACK_ROLES :63-108` | 降级兜底少 1 角色、白名单漂移 | 仅 meta 失败时少卡片 | ✅ | ❌ | 补齐第 7 角色或 meta 失败禁用绑定区 | ModelsView.vue | 否 | P3 |
| C-3 | ModelsView `runTest :428-448` | 生图测试无前置额度提示 | 不知情消耗额度 | ✅ | ❌ | 对 image 加前置 confirm | ModelsView.vue | 否 | P3 |
| S3/E-3 | StylePromptsView `removeTrack :446-473` | 删除配置不检查未保存改动 | 改动丢失无提示 | ✅ | ❌ | 确认框追加"有 N 处未保存将被丢弃" | StylePromptsView.vue | 否 | P3 |
| A-2 | TrackAnglesView `:638` | 审核确认框含字面 `**通过**` | 文案瑕疵 | ✅ | 部分 | 删除 `**` | TrackAnglesView.vue | 否 | P3 |
| A-3 | router/index.ts 选题库路由 | 无 meta.roles | member 直输 URL 见 StateError 而非权限提示 | ✅ | ❌ 低频 | 加 meta.roles 或明确权限文案 | router/index.ts | 否（后端已有 403） | P3 |

---

## 5. 未验证事项和审计盲区
1. **文风配置 P1 / S2 的实际保存与恢复默认行为**：Mock 无 `/api/style-prompts` 端点（页面报 `list.items is not iterable`），任务禁止新建复杂框架/连库/改 Mock → 标「代码确认、浏览器未验证」。S1 的证据链为静态强证据（死代码+key 错位+面板缺 Tab），但写库表现（`v:global:spec` 是否真被写入）未实测。
2. **模型页就绪状态（C-1）浏览器场景**：Mock 无 models 本体数据，`/models/meta` 空数组 → 无法构造"已绑定但能力不匹配"场景实测。
3. **编辑/删除/保存类交互**：本轮只读，未点击任何写操作（含审核、扩库、出稿、连通测试、账号测试），相关行为仅代码确认。
4. **member / guest 角色视角**：未切换 role.txt（保持 admin，避免改夹具状态）；member 菜单过滤与后端 403 为代码确认，未实测。
5. **窄屏模型/账号/文风/计划页**：仅走查了选题库 500px 量化，其余页未做逐列可视区量化；正常/深色/桌面已覆盖。
6. **RunLog 与 TaskRun 关联**：按任务约束未强行关联，未审计。

---

## 6. P0-P3 问题汇总
| 级别 | 数量 | 问题 |
|---|---|---|
| P0 | **0** | 无核心业务不可用、严重数据错误或安全风险 |
| P1 | **1** | S1/E-1 文风配置写作规范 Tab 错挂+保存 key 错位 |
| P2 | **5** | A-1 选题库窄屏核心列不可见；C-1 模型就绪误报；B-1 出稿无前置披露；S2/E-2 恢复默认失败；T1 赛道未保存丢弃 |
| P3 | **8** | D-1/D-2/D-3、C-2/C-3、S3/E-3、A-2、A-3 |

**与已关闭事项的边界**：Dashboard 四类待办（S5-UI-2-D）与文章工作台（S5-UI-3）已关闭，本轮未重复审计；A-1 是选题库自身的窄屏问题（不同于文章列表 P2-2，已修），属新问题。

---

## 7. 最值得优先实施的 3-5 项优化
1. **【P1】修文风配置写作规范入口与保存 key（S1，顺带 S2）**——把 spec Tab 移到赛道面板、删全局库错挂 Tab、修 `s:` 恢复默认查找。影响日常文风调整的正确性，唯一 P1，同文件同函数域可一次修完。
2. **【P2】选题库窄屏核心列可见（A-1）**——复用 S5-UI-3-3 文章工作台的成熟做法（窄屏固定审核/评分列或列优先级），让 500px 下能看到审核态与评分。
3. **【P2】模型就绪状态改用 resolve 真源（C-1）**——避免"就绪"误报导致写作/生图产出失败，直接关系产出可靠性。
4. **【P2】创作计划出稿前置确认与 AI 披露（B-1）**——低成本补 UI-GUIDE 合规，减少误触。
5. **【P2】赛道产线未保存保护（T1）**——仿文风页 dirty 拦截，避免配额改动丢失。
> P3（字面 `**`、低频字段校验、无启停开关等）建议批量顺手修或直接登记暂缓，不单独立项。

---

## 8. 每项优化的最小修改范围和回归范围
| 优化 | 最小修改文件 | 是否需后端 | 回归范围 |
|---|---|---|---|
| S1+S2 | `web/src/views/StylePromptsView.vue`（Tab 位置 + `currentEditorKey` 复用 + restoreKey 前缀） | 否（写入 key 变为 `s:{赛道}`，API 已支持；会改变库记录 key，需注意存量） | 文风配置：全局库/赛道面板各 Tab 编辑-保存-恢复默认、dirty 汇总、SaveBar、刷新确认、深色/窄屏 |
| A-1 | `web/src/views/TrackAnglesView.vue`（表格列 fixed/优先级 + 局部响应式） | 否 | 选题库：桌面列布局、500px 可视区相交（审核/评分真实可见）、四态筛选、关联文章跳转、深色 |
| C-1 | `web/src/views/ModelsView.vue`（load 拉 resolveRole + bindState 用 usable/reason） | 否（api/index.ts 已有 resolveRole） | 模型配置：角色绑定卡片各状态、编辑已绑定模型协议/能力后的状态、连通测试、深色/窄屏 |
| B-1 | `web/src/views/PlanView.vue`（trigger 前置 confirm） | 否 | 创作计划：出稿确认/取消、防重入、骨架草稿与漫画失败反馈、跳改稿、skipped 提示 |
| T1 | `web/src/views/TracksView.vue`（load 入口 dirty 确认） | 否 | 赛道管理：产线配额脏后刷新/切换、保存、扩库入口、批量删除 |

---

## 9. 是否涉及后端/API/数据库
- **S1**：前端 Tab 归属与 key 绑定修正；**会改变写入的 key**（从无效的 `v:global:spec` 到正确的 `s:{赛道}`），API/后端逻辑无需改，但实施时应确认存量无效记录的处理（本轮不改库）。
- **A-1 / B-1 / T1**：纯前端展示与交互，不涉及 API/DB/业务逻辑。
- **C-1**：前端改用已有的 `GET /models/resolve/:role` 真源，不改后端。
- **D-2（P3）**若实施需后端加手动启停端点（状态机），属产品决策，建议暂缓。
- 本轮审计**未连库、未读密钥、未改任何后端**。

---

## 10. Git HEAD 和工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 61 项未提交改动全部保持原样，未覆盖/回滚/清理；本轮唯一新增为本报告（工作区 61→62）。
- **Git 写操作**：无 commit/push/reset/checkout/clean。
- **临时产物**：走查脚本/截图/JSON 在 `var/tmp/s5ui2c/`（不进版本库）；查看截图的系统临时副本已清理；Mock(8787)/vite(5199)/Chrome(9373/9374) 进程已停止、端口已释放。未改 `role.txt`/`mode.txt` 夹具状态。

---

## 11. 是否建议进入 S5-UI-4-1
**建议进入。** 依据：① 核心页面功能链路完整，问题集中在信息表达/交互，无 P0；② 唯一 P1 已定位到具体代码行且最小方案明确（同文件可修）；③ A-1 有 S5-UI-3-3 已验证的成熟修法可复用；④ 5 项 P2 均可小范围前端改动，不涉及状态机/DB 迁移；⑤ 审计未改历史报告、未扩大范围。
**建议 S5-UI-4-1 范围**：S1+S2（P1+P2 文风）+ A-1（选题库窄屏）+ C-1（模型就绪）+ B-1（出稿确认）+ T1（赛道未保存保护）；P3 批量顺手修或登记暂缓；需产品拍板的 D-2 不纳入。

---

## 最后四问（明确回答）
1. **当前系统是否还存在 P0/P1 UI 问题？** —— 无 P0；**有 1 个 P1**（文风配置写作规范 Tab 错挂、保存 key 错位，S1）。该问题不改变数据安全/推送，但会让用户"改了等于白改"，应优先修。
2. **哪些问题真正影响日常使用？** —— ① 文风配置写作规范无法正确编辑保存（P1，文风调整是常规运营动作）；② 选题库 500px 下审核态/评分看不到（P2，有实证，窄屏审核受阻）；③ 模型"就绪"误报可能导致写作/生图产出失败（P2，影响产出可靠性）；④ 赛道配额改动静默丢失、创作计划误触出稿（P2，操作成本/反馈缺失）。
3. **下一轮最应该先做什么？** —— **先修 S1+S2（文风 P1，同文件一次做完）**，再修 A-1（选题库窄屏，复用文章工作台已验证做法）与 C-1（模型就绪真源）；这三项覆盖正确性与高频使用。
4. **哪些问题应该暂缓，避免扩大重构范围？** —— D-2（账号手动启停，需产品拍板+后端端点）、C-2（meta 降级兜底，仅异常路径）、所有 P3 文案/低频校验（字面 `**`、AppID 校验、删除未保存提示、生图前置提示、路由 meta.roles）、以及任何"补选题菜单给 member""新增任务中心""内容策略中心"类需产品决策或扩大范围的改造——本轮均不建议纳入下一轮。

**本轮到此停止。只交付审计报告，不实施代码修改，不进入 S5-UI-4-1，不执行 Git 提交，等待人工验收。**
