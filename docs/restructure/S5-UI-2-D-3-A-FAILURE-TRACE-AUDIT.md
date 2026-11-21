# S5-UI-2-D-3-A 核查报告 · 批次执行异常失败原因定位

**日期**：2026-11-17
**性质**：只读核查，**未修改任何代码 / 接口 / Schema**，未连接数据库
**结论一句话**：Dashboard 的异常待办**本身就是一条具体的失败 TaskRun（id 可直接定位）**，失败原因（`errorMessage`）**已经在响应里、也已显示在卡片上**（只是被单行省略号截断）。真正的断点是「点击行为」——点下去反而跳离了信息源。因此最小改法是**就地展开详情**，无需新增接口、无需 Schema、甚至无需改 `/plan`。

---

## 1. Dashboard 异常待办的数据结构与实际业务含义

### 1.1 生成逻辑（`server/src/services/dashboard.ts:644` 的 `todoRuns`）

```
窗口      createdAt >= now - 7 天（TODO_RUN_WINDOW_DAYS = 7，:254）
类型      jobType ∈ { write, comic_script, comic_panel }（push 已排除，避免与 articles.pushFailed 重复）
扫描上限  500 条（TODO_RUN_SCAN_LIMIT，:261）；达到上限直接抛错 → 该块 null + 进 degraded，拒绝近似统计
分组键    comic_panel → `panel:<articleId>`
          write / comic_script → `<jobType>:<accountId>`
取数      每组按 createdAt desc 取**第一条**（= 该键最新一次执行）
计入      「最新一条 status === 'failed'」才算 unresolved
明细      failed 里取前 3 条（TODO_RECENT = 3，:252）
```

### 1.2 一条待办到底代表什么

| 问题 | 结论 | 依据 |
|---|---|---|
| 一个失败 TaskRun？ | **是** | `recent[i].id` 直接取自 `taskRun.id`（`todoRuns` 的 `select: { id: true … }`） |
| 一个失败文章？ | 部分是 | 只有 `comic_panel` 带 `articleId`；write/comic_script 是批次级，`articleId` 为 null |
| 一个失败批次？ | **等于同一条 TaskRun** | `write` / `comic_script` 一次执行只写**一条** TaskRun（`planner.ts:421` / `:507`），没有独立「批次表」、没有 batchId |
| 一个聚合异常组？ | **计数是、明细不是** | `unresolved` 是「同键最新仍失败」的组数；但 `recent` 展示的是**每组最新那条具体 TaskRun**，不是聚合体 |

因此：**明细行 ↔ TaskRun 是 1:1，可精确到行**。而 `unresolved` 可能大于 `recent.length`（例如 5 个键都失败，卡片数字 5，明细只列 3 条）。

### 1.3 明细携带的字段（足够定位）

`TodoRunItem`（服务端 `dashboard.ts:328`，前端 `web/src/types.ts` 同名同形，**无需改类型**）：

| 字段 | 用途 |
|---|---|
| `id` | **TaskRun 主键** → 精确身份 |
| `jobType` | write（写稿批次）/ comic_script（漫画脚本批次）/ comic_panel（单篇文章的格图批次） |
| `accountId` / `account` | 哪个账号（`account` 已 join 出名字） |
| `articleId` | 仅 comic_panel 有 |
| `errorCode` | `write_failed` / `comic_script_failed` / comic_panel 为空 |
| `errorMessage` | **失败原因正文**（详见 §3） |
| `createdAt` | 该次执行时间（不是「失败发现时间」） |

### 1.4 数量与明细是否会不一致

会，且是**设计如此**：

- `unresolved` 可以 > `recent.length`（上限 3）。
- 窗口外的失败（>7 天）既不计入数字也不出现在明细——这是 S5-UI-2-B 为避免「历史失败永久挂在工作台」而定的口径（`README.md` 决策表 T 行），本轮不改。
- 扫描超 500 条时整块降级为 `null`（不显示 0）。

---

## 2. TaskRun 与 RunLog 的真实关联关系

| 项 | 现状 |
|---|---|
| 外键 | `RunLog.taskRunId Int?` + `taskRun TaskRun? @relation(..., onDelete: Cascade)`（`schema.prisma` 的 RunLog 模型） |
| **是否被写入** | **从未写入**。全仓只有一个 RunLog 写入点 `scheduler.ts:225` 的 `logRun()`，其 `data` 里**没有 `taskRunId`** |
| 1:N？ | 结构上允许（`TaskRun.logs RunLog[]`），实际上**恒为 0 条** |
| RunLog 能否没有 TaskRun？ | **全部都没有**（`taskRunId` 恒为 null） |
| 是否有可用查询接口 | **无**。`/api/**` 里没有任何 task/run 路由（`api/routes/` 12 个文件全无 `taskRun`/`runLog` 引用），任务数据只通过 `/api/dashboard` 露出 |

**结论**：TaskRun ↔ RunLog **当前不存在可靠关联**。任何「按时间接近、按账号+阶段文本匹配」的做法都属于猜测，明确**不采用**。
`recentLogs`（Dashboard「运行日志」Tab，最近 15 条，`stage` + `message`）只能当作全局运维日志看，不能用来给某条 TaskRun 定位原因。

---

## 3. 失败原因实际存储位置

**唯一可靠来源 = `TaskRun.errorCode` + `TaskRun.errorMessage`。**

| jobType | errorCode | errorMessage 内容 | 可用性 |
|---|---|---|---|
| `write` | `write_failed` | `失败 N 条：建稿失败：<错误摘要 160 字>（已归还该选题）…`（`planner.ts:586` `summarizeFailures`，**截断 900 字**） | ✅ 有内容 |
| `comic_script` | `comic_script_failed` | 同上结构（脚本生成失败原因） | ✅ 有内容 |
| `comic_panel` | `''`（空） | **不写入**（`panels.ts:293` 的 create 只给 status/ articleId，没有 errorCode/errorMessage） | ❌ 空 |

**质量限制（如实记录）**：

1. `write`/`comic_script` 的 `errorMessage` **不含选题标题/文章标题**——`note` 只有 `建稿失败：<msg>`，失败项本身没有文章（`id: 0`）。用户看到「失败 1 条：建稿失败：…」但不知道是哪条选题。
2. 长度上限 900（`errorMessage` 列本身 VarChar(1000)），再多会被截。
3. `comic_panel` 的失败原因**根本没有落库**，只能靠 `articleId` 去文章页看「哪一格 failed」。
4. `errorCode` 是给程序看的短码（`write_failed` 等），不是用户文案。

---

## 4. `/plan` 页面当前定位能力

| 检查项 | 结论 |
|---|---|
| 是否读 URL 参数 | **完全不读**。`PlanView.vue` 没有 `useRoute`，只有一个 `useRouter` 用于跳转 |
| 是否有任务/运行数据 | **没有**。`/api/plans`（`plans.ts:36`）只返回 `PlanResult`：`date / perDay / tasks / skipped / warnings / backlog`，**一行 TaskRun 都没有** |
| 是否显示失败状态 | 只显示「未排产原因」（`skipped/warnings`：角度不足、角色未就绪、凭据未就绪），与执行失败是两回事 |
| 是否有任务流水/错误入口 | 没有 |
| Dashboard 跳过去带什么参数 | **什么都不带**（`DashboardView.vue:219` `goRun`：`router.push('/plan')`） |

**能否只加一个轻量查询参数让 `/plan` 定位？** —— **不能**。
参数可以传（前端 3 行），但 `/plan` 拿不到任何任务数据，页面上没有地方能「定位」或「展示失败原因」。要让 `/plan` 显示失败，**必须先让后端把 TaskRun 数据送过来**（新接口或给 `/api/plans` 加字段）。

唯一可零后端利用的既有能力：`GET /api/plans?account=<账号名>`（`buildPlan` 的 `targetAccount` 按 **name** 过滤，`planner.ts:143`），但 PlanView 没读它，且它只缩窄排产表，**仍然看不到失败原因**。

---

## 5. Dashboard 当前跳转链路（问题定位）

```
执行异常明细行 ──点击──▶ goRun(row)
                          ├─ row.articleId != null → /articles/:id      （comic_panel）
                          └─ 否则                 → /plan（无参数）    （write / comic_script）
```

| 类型 | 落点 | 用户能看到什么 | 是否闭环 |
|---|---|---|---|
| `comic_panel` | `/articles/:id` | 改稿页的漫画面板：`failedCount` + 每格状态 + 「重画」按钮（`ArticleEditView.vue:205`） | **半闭环**：能看到哪格挂、能重画，但看不到 TaskRun 的错误（本来就空） |
| `write` / `comic_script` | `/plan` | 今日排产表、未排产原因；**与那次失败毫无关系** | **断链**（审计 P1-2 的根因） |

**关键事实（决定了最小改法）**：卡片明细行**已经把 `errorMessage` 渲染出来了**（`DashboardView.vue:474` 的 `todo-detail__msg`），只是 CSS `white-space: nowrap; text-overflow: ellipsis`（`:1017-1022`）把它压成一行。所以「看不到原因」的真实原因不是数据缺失，而是：

1. 原因被截断成一行；
2. 点击行为的语义是「跳走」，而不是「展开」。

---

## 6. 现有任务动态 / 任务流水可复用能力

**Dashboard「任务动态 → 任务流水」Tab**（`DashboardView.vue:522-534`）

- 数据：`data.recentRuns`（最近 12 条，`dashboard.ts:834`），字段 `id / jobType / status / trigger / runDate / articleId / errorMessage`。
- 展示：`el-table` + `TaskProgress`（状态徽标）+ `errorMessage` 列（`show-overflow-tooltip`，**悬停可见全文**）。
- 复用价值：**`TaskProgress` 与「错误列」的展示方式可以直接搬到详情视图**，不必造新组件。
- 局限：
  - 只有 12 条，且是**全类型**（含 success）；待办里的某条失败**不一定**在这 12 条内（两个查询口径不同：`todoRuns` 7 天窗口+分组，`recentRuns` 最近 12 条不分状态）。
  - **没有账号列**，无法区分同名批次来自哪个账号。
  - 没有行点击、没有详情，`TaskRun.id` 只是显示出来的一个数字。

**结论**：它的「展示样式」可复用（`TaskProgress` + 错误文本），但**不能作为定位落点**（数据窗口不覆盖、无账号、无详情）。

---

## 7. 当前无法定位失败原因的具体根因

| # | 根因 | 影响 |
|---|---|---|
| R1 | **点击语义错误**：明细行点击 = 跳走，而原因就在行内 | 用户点一下反而离开了唯一能看到原因的地方 |
| R2 | **文本被截断**：`errorMessage` 单行省略号，最长 900 字的内容看不全 | 只能看到开头十几个字 |
| R3 | **`/plan` 无任务数据**：`/api/plans` 不含 TaskRun，页面也不读参数 | 批次失败没有落点 |
| R4 | **`comic_panel` 不记原因**：`panels.ts:293` 不写 errorCode/errorMessage | 该类型只能靠文章页的面板状态间接判断 |
| R5 | **RunLog 无关联**（`taskRunId` 从未写入） | 「运行日志」Tab 无法解释某条任务 |
| R6 | **write/comic_script 原因不含选题标题** | 知道「失败 1 条」但不知道是哪条 |
| R7 | **明细上限 3 条**（`TODO_RECENT`） | `unresolved` 5 时，卡片只列 3 条，剩余 2 条无处查看 |

---

## 8. 两个最小改造方案与推荐

### 方案 A（推荐）：**就地展开「执行异常」详情抽屉** —— 零后端、零 Schema

**做法**
- `执行异常` 明细行的点击从「跳转」改为「打开详情」；详情用 `el-drawer`（或 `el-popover`）承载。
- 内容全部来自**已在响应里的字段**：任务 ID、类型（`jobType` 文案）、账号、时间、`errorCode`、**完整 `errorMessage`（可换行、可选中复制）**。
- 底部两个出口按钮（保留现有语义）：
  - `articleId` 有值 → 「去文章看分镜」（`/articles/:id`）
  - 无 `articleId` → 「去创作计划」（`/plan`，可选带 `?account=<名字>`，见下）
- 空原因降级：`comic_panel` 时显示「漫画面板任务未记录错误详情 —— 去文章页看哪一格失败」；`errorMessage === ''` 时同理，**不显示空白块**。

**成本**：`web/src/views/DashboardView.vue` 单文件（约 +60 行：状态 + 抽屉模板 + 样式）；`types.ts` 不用改；后端、接口、Schema **全不动**。

**优点**：原因本来就在手上，点击→展开是零信息损耗；不受 7 天窗口/12 条流水的限制（用的是待办自己的数据）；风险最低。

**缺点**：`unresolved > 3` 时看不到其余条目（R7），需要配套一个「看全部失败任务」的出口（可用方案 B 或现有任务流水 Tab）。

### 方案 B（备选）：**`/plan?run=<TaskRunId>` 深链定位** —— 需要后端小改

**做法**
1. 后端新增 `GET /api/tasks/:id`（返回 TaskRun 全字段 + 账号名），或在 `/api/plans` 响应里加 `?run=` 时附带该任务对象。**必须新增**，因为现有接口不含任务数据。
2. `/plan` 读 `?run=`，在页面顶部渲染一块「本次执行」卡片（复用 `TaskProgress` + 错误文本样式），并高亮该账号行。
3. 降级：id 不存在 / 超出可见窗口 → 显示「该任务记录不可用（可能已过期或被清理）」，其余计划内容照常。

**成本**：后端 +1 接口（约 40 行）+ 前端 `PlanView.vue` +`api/index.ts`（约 +80 行）。**不需要 Schema/Migration**。

**优点**：把「批次」的语境做出来（用户从「计划」角度看失败）。
**缺点**：多一个接口和一条权限路径要维护；信息与方案 A 完全重合；`plan` 是「今日排产」，而失败可能是 6 天前的，语义上并不吻合。

### 推荐：**A 为主，B 不做**
理由：失败原因已在 dashboard 响应里，跳到另一个页面再取一次属于重复建设；B 的唯一增量是「计划语境」，而计划页本质是「今天该产什么」，与「N 天前那次失败」语义错配。若确实需要「看全部失败任务」，更合适的是给待办明细加一个「展开全部」而非新页面。

---

## 9. 推荐方案涉及的文件、接口与改动范围

| 文件 | 改动 | 规模 |
|---|---|---|
| `web/src/views/DashboardView.vue` | 执行异常行点击 → 打开详情抽屉；新增 `runDetail` 状态与模板；空原因降级文案；保留原「去文章 / 去计划」按钮 | +60~80 行 |
| `web/src/types.ts` | **不改**（`TodoRunItem` 字段已齐全） | 0 |
| `web/src/utils/format.ts` | 可选：`jobTypeText` 已在 Dashboard 内定义，无需外移 | 0 |
| 后端 `server/**` | **不改** | 0 |
| Schema / Migration | **不改** | 0 |

**若要顺带解决 R7（明细上限 3）**：给 `runs` 单独一个 recent 上限（现在共用 `TODO_RECENT = 3`，改它会影响选题/文章/体检三块），例如 `TODO_RUN_RECENT = 10`，属**后端 2 行**、可选、可另开授权。本轮不包含。

---

## 10. 是否需要新增 URL 参数或 API 字段

| 方案 | URL 参数 | API 字段 | 是否必要 |
|---|---|---|---|
| **A（推荐）** | 不需要 | 不需要 | — |
| B | `/plan?run=<id>` | 新增 `GET /api/tasks/:id`（或 `/api/plans?run=` 附带对象） | 仅在选 B 时需要 |

补充：若采用 A 且想给 `/plan` 一个「缩小到该账号」的落点，可利用**已存在**的 `?account=<账号名>`（`plans.ts:36` + `planner.ts:143`，按 name 匹配，`TodoRunItem.account` 正好是名字）——**前端 3 行**，不需要后端改动。这只是「缩小范围」，不是定位失败，文案上不能宣称已定位。

---

## 11. 需要覆盖的测试场景（供 D-3-B 使用）

**纯函数 / 前端断言**
1. `write` 失败行点击 → 打开抽屉，显示 `errorCode=write_failed`、`errorMessage` 全文（不截断）。
2. `comic_panel` 失败行点击 → 抽屉显示降级文案，且「去文章」按钮指向 `/articles/<articleId>`。
3. `errorMessage === ''`（非 comic_panel）→ 同样走降级文案，不出现空白区域。
4. `articleId === null` → 只显示「去创作计划」，不显示「去文章」。
5. 关闭抽屉 → 焦点回到触发按钮（可访问性）。
6. 降级块（`runsUnavailable`）时，行点击不打开残缺抽屉（或打开后明确说明统计不可用）。

**浏览器（dist + Mock）**
7. 卡片数字 1 与明细 1 条一致时可点开；详情里的 `TaskRun.id` 与明细行显示一致。
8. 抽屉内 `errorMessage` 换行展示、可选中复制；长文本不撑破抽屉（`max-height` + 滚动）。
9. 深色主题下抽屉可读。
10. 刷新页面后抽屉关闭（不残留半开状态）。

**不需覆盖**（口径不变）：`unresolved` 计数、7 天窗口、同键取最新、`push` 排除——这些属 S5-UI-2-B 既有断言，本轮零改动。

---

## 12. 数据关联缺失与降级策略

| 情况 | 会发生什么 | 降级策略（方案 A） |
|---|---|---|
| `comic_panel` 无 errorCode/errorMessage（R4，现状 100%） | 抽屉只有 id/时间/账号 | 文案：「这类任务未记录错误详情，请到文章页查看失败格并重画」+ 去文章按钮 |
| `errorMessage` 为空但非 comic_panel（历史/异常写入） | 同上 | 显示「该任务没有文字原因（错误码：`<code>`）」 |
| `errorMessage` 被截断到 900 | 结尾可能不完整 | 抽屉内原样展示 + 提示「原因过长已截断」，不做二次请求 |
| `unresolved > recent.length`（R7） | 有失败无法在明细里看到 | 卡片脚注「仅显示最近 3 条」+ 「去创作计划」（后续可选：单独扩大 runs 明细上限） |
| TaskRun 已被级联删除（文章删除 → `comic_panel` 行随 articleId 级联？见注） | id 失效 | 方案 A 不依赖二次请求，**无此风险**；这也是 A 优于 B 的一点 |
| 失败发生在 7 天窗口外 | 不在待办里 | 明确属既有口径（不自动挂待办），不在本轮扩展 |
| RunLog 想用来看原因（R5） | 无关联 | **不做**：不按时间/文本猜关联，坚持用 TaskRun.errorMessage |

> 注：`TaskRun.articleId` 在 schema 里是普通可空列（没有声明 relation / onDelete），所以文章删除后该 id 会变成悬空引用。方案 A 只用它做跳转，落到「文章不存在」时页面本就有错误态，可接受。

---

## 13. 本轮执行边界确认

- **未修改任何文件**（`server/**`、`web/**`、docs 的既有文档均未写入），仅新增本报告。
- **未连接数据库**（全部结论来自源码、Schema、类型定义与既有报告；`RunLog.taskRunId` 从未写入这一结论由「全仓只有一个写入点且其 data 不含该字段」静态证明，未做数据抽查）。
- **未执行**任何测试、构建、冒烟、迁移、指纹脚本。
- **未修改** `DEVLOG` / `CHANGELOG` / 历史报告（本轮为纯只读核查，按任务书不登记）。
- **未执行** Git 写操作（无 commit/push/reset/checkout），HEAD 仍 `b2fbad3`。
- 未调用 LLM / 微信接口；未启动或停止任何服务。

---

## 附：四个验收问题的直接回答

1. **能否可靠定位到具体失败任务？** 能。`todos.runs.recent[i].id` 就是 `TaskRun.id`，明细与行 1:1。
2. **能否可靠定位到对应批次？** 能，但「批次」不是独立实体——`write`/`comic_script` 的一次执行 = 一条 TaskRun，它既是任务也是批次，没有 batchId。
3. **失败原因能否直接从现有数据读取？** `write`/`comic_script` 能（`errorMessage`，≤900 字，不含标题）；`comic_panel` 不能（字段为空，只能去文章页看哪格失败）。
4. **能否复用现有页面和接口闭环？** 接口能（无需改动）；页面**不能靠 `/plan`**（无任务数据、不读参数），最省事的是在 Dashboard 就地展开，复用现有 `TaskProgress` 与错误文本样式。

**最小改造 = 只改 `web/src/views/DashboardView.vue` 一个文件；完全不需要 Schema / Migration / 新接口。**
