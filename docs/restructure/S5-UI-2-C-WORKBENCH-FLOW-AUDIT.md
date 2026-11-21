# S5-UI-2-C 工作台待办闭环走查报告

- **日期**：2026-11-17
- **性质**：只读审计 + 真实浏览器走查（未改任何代码/配置/数据库）
- **结论**：**主干链路基本闭环，但存在 1 个 P0 断链**——单赛道且「候选=0、待改>0」时，点「去审核」会落到**空列表**（用户看到「待改 1」，点进去却是「共 0 条」）。另有 3 项 P1：多赛道入口丢上下文、批次失败原因不可达、「未推送草稿」数字与列表不一致（1 vs 3）。
- **本轮未修复**，问题清单见 §6。

---

## 1. 审计范围与执行环境

### 1.1 覆盖范围

| # | 待办 | 入口 | 目标页 |
|---|---|---|---|
| A | 待审核选题（明细） | 待办卡第 1 行明细 | `/tracks/:id/angles` |
| B | 待审核选题（一键） | 第 1 行「去审核」 | `/tracks/:id/angles` 或 `/tracks` |
| C | 未推送草稿 / 待重推 / 推送失败 / 漫画草稿 | 第 2 行四个数字 | `/articles` |
| D | 文章体检 | 第 3 行数字与明细 | `/articles`、`/articles/:id` |
| E | 执行异常 | 第 4 行明细 | `/articles/:id` 或 `/plan` |

### 1.2 执行环境（重要：数据来源必须看清）

| 项 | 实际情况 |
|---|---|
| 前端 | `web/dist`（S5-UI-2-B 构建产物，此后**代码零改动**），通过 `vite preview --port 5199` 提供 |
| `/api` | **本地 Mock 上游**（`var/tmp/s5ui2c/mock.mjs`，手写夹具），按后端既有语义模拟 `status`/`pipeline` 过滤 |
| 后端 API | **未启动**（`.env` 仍指向 smoke 库，为避免任何写库，本轮不启服务） |
| 数据库 | **未连接** |
| 浏览器 | Windows 本机 Chrome，headless + CDP 驱动（`walk.mjs` / `walk2.mjs`） |
| 登录 | **未登录真实账号**（Mock 直返 admin / member 身份） |

**由此产生的边界（必须按此读结论）**：

- 「跳转 URL 是否正确」「目标页是否读取并转成请求参数」「刷新/返回是否恢复筛选」「页面渲染与首屏位置」= **真实浏览器验证，可信**。
- 「后端过滤结果是否与该集合一致」= **代码核对 + Mock 按同一语义模拟**，不等于在真实库上验证。
- 因此本报告不声称「真实数据下闭环已通过」，只声称「前端侧闭环成立，后端契约按代码核对支持」。

### 1.3 证据文件

`var/tmp/s5ui2c/`：`result.json`、`result2.json`（结构化结果）、`requests.log`（Mock 收到的每个请求）、`01`–`14` 共 14 张截图。均为一次性产物，未进版本库。

---

## 2. 每类待办的跳转路径、参数与目标页处理

### A. 选题明细

| 项 | 值 |
|---|---|
| 触发 | 待办卡第 1 行明细行（整行按钮） |
| 生成代码 | `DashboardView.vue:174` `goAngles(trackId, status)` → `query: { status: status ?? 'candidate', used: 'unused' }` |
| 实际 URL | `/tracks/3/angles?status=candidate&used=unused` |
| 目标页读取 | `TrackAnglesView.vue:90` `used` / `:107` `status`（均从 `route.query` 解析，白名单校验） |
| 实际请求 | `GET /api/angles?trackId=3&used=unused&status=candidate&sort=seq&limit=20&offset=0` |
| 控件回显 | 状态=未用、审核=候选待审（`usedInput/statusInput` 从 URL 初始化，`:126-137`） |
| 候选 / 待改 | 分别映射到 `status=candidate` / `status=needs_revision`，**都能正确筛选** |

明细点击时传的是**该条自己的状态**，所以点「待修改」那条得到
`/tracks/5/angles?status=needs_revision&used=unused` → 列表恰好 1 行，正是被点的那条（截图 `12`）。

**结论：成立。**

### B. 选题一键入口（`goAnglesTop`，`DashboardView.vue:186`）

```ts
const tracks = anglesBlock.value?.byTrack ?? [];
if (tracks.length === 1) goAngles(tracks[0]?.trackId);   // ← status 走默认值 'candidate'
else void router.push('/tracks');
```

| 场景 | 行为 | 结果 |
|---|---|---|
| 多赛道 | `/tracks`（赛道列表） | **不成立（P1）**：赛道列表不显示任何待审数量，用户不知道点哪个 |
| 单赛道，候选>0 | `/tracks/5/angles?status=candidate&used=unused` | 成立 |
| 单赛道，候选=0 且待改>0 | 同上，**筛选到 `candidate`** | **不成立（P0）**：列表 0 行 |

P0 复现证据（Mock 单赛道夹具：`candidate=0 / needsRevision=1`）：

```
卡片文案：待审核选题 1 候选 0 · 待改 1 育儿 1 等最久 4 天 去审核
点击后 URL：/tracks/5/angles?status=candidate&used=unused
筛选控件：状态=未用  审核=候选待审
表格行数：0
空态文案：当前筛选没有匹配的选题（赛道「育儿」· 共 0 条选题）
```

截图 `11-single-track-empty.png`。**用户按待办进来什么都看不到，会以为题被删了/系统错了。**

### C. 文章四类

| 待办 | 生成代码 | 实际 URL | 目标页请求 | 控件回显 | 结论 |
|---|---|---|---|---|---|
| 未推送草稿 | `goArticles('draft')` | `/articles?status=draft` | `GET /api/articles?status=draft&limit=20&offset=0` | 状态=草稿 | URL 正确，但**数字与列表不一致（P1）**：卡片显示 1，列表 3 行（含 1 条待重推、1 条漫画草稿） |
| 待重推 | `goArticles('repush')` → 无 query | `/articles` | `GET /api/articles?limit=20&offset=0` | 全部状态 | **不成立（P1）**：不假装筛选是对的，但用户无法定位是哪几篇 |
| 推送失败 | `goArticles('failed')` | `/articles?status=failed` | `GET ...&status=failed...` | 状态=失败 | 成立 |
| 漫画草稿 | `goArticles('comic')` | `/articles?status=draft&pipeline=comic` | `GET ...&status=draft&pipeline=comic...` | 状态=草稿、产线=漫画 | 成立 |

目标页读取点：`ArticlesView.vue:58` `status`、`:67` `pipeline`，请求在 `:81-83`；下拉 `:model-value` 直接绑 URL 值（`:286`、`:312`），所以刷新/返回都能恢复。

**能力边界（不要误读）**：列表 API 只支持**单 status + 单 pipeline**。`repush = updated ∪ (draft ∧ hasPushTrace)` 是复合条件，现有列表**无法表达**；`draftUnpushed` 也被列表当成「全部 draft」（列表不认识 `mediaId/pushDate`）。这两点都不是前端 bug，而是列表筛选能力缺口。

### D. 体检失败

| 项 | 值 |
|---|---|
| 触发 | 第 3 行明细（或数字 → `/articles`） |
| URL | `/articles/93` |
| 目标页请求 | `GET /api/articles/93` → `GET /api/articles/93/preview` → `GET /api/articles/93/lint-runs?limit=20` |
| 面板位置 | 右侧预览列顶部 `.lint`（`ArticleEditView.vue:911`），实测距视口顶部 **437px**，**首屏可见** |
| 面板内容 | 「体检未通过，推送会被拦下」+「最近存档：保存正文 · 2026-11-16 09:10:00 · 3 项不合规」+ 逐条 issues（error/warn 分色）+ 「重新检查」+「历史 N 次」 |
| stale 区分 | `lintRunStale` 为真时显示 `存档已过期（正文已改）` 标签（同面板内） |

**结论：成立**，且「从待办进来」时该记录必然非 stale（待办本身要求 `contentHash === 当前正文指纹`），两侧口径一致。
唯一缺口：issue 只有 `level/code/message`，**无法点击定位到正文段落**（S5-UI-0 已登记，需扩 lint 契约）。

### E. 执行异常

| 项 | 值 |
|---|---|
| 有 `articleId` | `/articles/42`（`goRun`，`DashboardView.vue:213`）→ 成立 |
| 无 `articleId`（write / comic_script 批次） | `/plan` → 页面标题「创作计划」正常渲染，**但页面里没有任何任务失败信息** |

`PlanView` 只渲染「今日排产」（账号/赛道/产线/已出/待补/可用角度/近作避让），**不读任何 TaskRun**，也不读 URL 参数。截图 `09-run-batch-plan.png` 可证：整页看不到「哪次失败、为什么失败」。

**结论：不成立（P1）**——失败原因不可达，用户只能回工作台「最近动态 → 任务流水」Tab 才看得到（那是另一个入口，不在闭环路径上）。

---

## 3. 闭环判定汇总

| 待办 | 跳转 | 目标页识别参数 | 能定位到记录 | 能完成动作 | 判定 |
|---|---|---|---|---|---|
| 选题明细（候选） | ✅ | ✅ | ✅ | ✅（行内审核） | **成立** |
| 选题明细（待改） | ✅ | ✅ | ✅ | ✅ | **成立** |
| 选题一键·多赛道 | ⚠️ `/tracks` | — | ❌ 无待审线索 | ⚠️ 需两步 | **部分** |
| 选题一键·单赛道（有候选） | ✅ | ✅ | ✅ | ✅ | **成立** |
| 选题一键·单赛道（仅待改） | ✅ | ✅（但筛错状态） | ❌ 0 行 | ❌ | **不成立（P0）** |
| 未推送草稿 | ✅ | ✅ | ⚠️ 超集（1→3） | ✅ | **部分** |
| 待重推 | ⚠️ 无筛选 | — | ❌ | ❌ | **不成立**（已知取舍） |
| 推送失败 | ✅ | ✅ | ✅ | ✅ | **成立** |
| 漫画草稿 | ✅ | ✅ | ✅ | ✅ | **成立** |
| 体检失败 | ✅ | ✅ | ✅ 首屏可见 | ✅（改稿/重检） | **成立** |
| 执行异常·有文章 | ✅ | ✅ | ✅ | ⚠️ 失败原因不在页内 | **部分** |
| 执行异常·批次 | ✅ | — | ❌ | ❌ 原因不可达 | **不成立（P1）** |

---

## 4. admin / member 差异

| 项 | admin | member | 一致性 |
|---|---|---|---|
| 待办卡「待审核选题」行 | 显示 | **不渲染**（`showAnglesRow = scope === 'all'`，`DashboardView.vue:108`） | ✅ 与入口一致 |
| 直接输 URL `/tracks/:id/angles` | 正常 | 页面渲染 + 接口 403 → `StateError`「选题列表加载失败 请求失败（HTTP 403）」 | ⚠️ 前端无 `meta.roles`，只靠后端 403 兜底（不构成越权，但文案没说权限） |
| 选题/赛道接口 | `system:manage` | **无** → 403（`routes/angles.ts:40`、`tracks.ts:27`） | ✅ 与隐藏一致 |
| 文章待办（草稿/失败/体检） | 全量 | 仅自己账号（`ownerUserId` 过滤，B 轮已验证） | ✅ |
| 打开改稿页 | 可改可推 | 可**看**，保存 `PUT` 需要 `content:revise` → **member 没有**（`routes/articles.ts:50`、`permissions.ts:42-48`） | ❌ **权限与待办不匹配（P2）** |
| 「重新检查」按钮 | 成功 | 也能成功——`GET /:id/lint` 只要 `data:view`，**且该接口会写一条 `ArticleLintRun`** | ⚠️ 同一页里「不能改正文、却能新增体检存档」 |

member 视角实测：待办卡 3 行（无选题行、无「统计暂不可用」字样），截图 `13-member-dashboard.png`。

---

## 5. 可复核证据

### 5.1 关键请求（`var/tmp/s5ui2c/requests.log` 摘录）

```
GET /api/angles?trackId=3&used=unused&status=candidate&sort=seq&limit=20&offset=0
GET /api/angles?trackId=5&used=unused&status=needs_revision&sort=seq&limit=20&offset=0
GET /api/articles?status=draft&limit=20&offset=0
GET /api/articles?limit=20&offset=0
GET /api/articles?status=failed&limit=20&offset=0
GET /api/articles?status=draft&pipeline=comic&limit=20&offset=0
GET /api/articles/93
GET /api/articles/93/preview
GET /api/articles/93/lint-runs?limit=20
```

### 5.2 截图清单

| 文件 | 说明 |
|---|---|
| `01-angle-detail-target.png` | 选题明细 → 选题库（筛选=未用/候选待审） |
| `02-angle-top-target.png` | 多赛道「去审核」→ 赛道列表 |
| `03-articles-draft.png` | 未推送草稿 → 列表 3 行（**数字 1 与列表不一致的证据**） |
| `04-articles-repush.png` | 待重推 → 全列表（无筛选） |
| `05-articles-failed.png` | 推送失败 → 筛选=失败 |
| `06-articles-comic.png` | 漫画草稿 → 筛选=草稿/漫画 |
| `07-article-lint-panel.png` | 体检面板首屏可见 |
| `08-run-with-article.png` | 执行异常（有 articleId）→ 文章 |
| `09-run-batch-plan.png` | 执行异常（批次）→ 创作计划，**页内无失败信息** |
| `10-narrow-500.png` | 500px 窄屏：待办卡 4 行、无横向溢出 |
| `11-single-track-empty.png` | **P0**：单赛道仅待改 → 0 条 |
| `12-needs-revision-detail.png` | 待改明细 → 1 行且正是该条 |
| `13-member-dashboard.png` | member 无选题行 |
| `14-member-direct-angles.png` | member 直连 URL → 403 错误块 |

### 5.3 交互/状态检查

| 检查项 | 结果 |
|---|---|
| 刷新 `?status=draft` | 下拉仍「草稿」（筛选随 URL 恢复）✅ |
| `history.back()` 从 `?status=failed` 返回 | 回到 `/articles`，下拉回「全部状态」✅ |
| 窄屏 500px | 待办卡 4 行高度 168/153/104/125，`scrollWidth == innerWidth`，无横向滚动 ✅ |
| 重复标题 | 无（顶栏面包屑 + 页内 h1）✅ |
| 返回入口 | 选题库「返回赛道」、改稿页「返回列表」均在 ✅；`/plan` 为顶级页无返回（正常） |
| 空态/降级态误导 | 空态「暂无待办」不隐藏卡片、降级显示「统计暂不可用」→ 不会导致错误操作 ✅ |

---

## 6. 问题清单

### P0（闭环断裂，建议本轮后立即修）

---

**P0-1 单赛道「仅待改」时，一键入口落到空列表**

- **位置**：`web/src/views/DashboardView.vue:186-193`（`goAnglesTop`）；根因是 `:174` `goAngles` 的 `status ?? 'candidate'` 默认值。
- **复现**：赛道仅 1 个且 `candidate=0 / needsRevision>0`（Mock `mode=single`）→ 待办卡显示「待审核选题 1 · 候选 0 · 待改 1」→ 点「去审核」。
- **实际**：`/tracks/5/angles?status=candidate&used=unused` → 表格 0 行、空态「当前筛选没有匹配的选题」。
- **影响**：用户认为无事可做或数据丢失；这是待办卡最主要的行动入口，一旦失效会直接影响使用信任。
- **证据**：截图 `11`、`result2.json` 的 `singleTrackResult`。

### P1（闭环可用但需绕路或误导）

---

**P1-1 多赛道「去审核」落赛道列表，无待审线索**

- **位置**：`DashboardView.vue:191` `router.push('/tracks')`；`TracksView` 无待审列。
- **复现**：≥2 个赛道有待审 → 点「去审核」→ 落在赛道管理，页面只有「选题池 X/Y」（已用/总数）。
- **影响**：用户需自己猜哪个赛道有待审，再点一次进入；多赛道场景下入口价值大幅降低。
- **证据**：截图 `02`、`result.json.angleTop`。

---

**P1-2 批次任务失败跳 `/plan`，失败原因不可达**

- **位置**：`DashboardView.vue:213-216`；`web/src/views/PlanView.vue`（整页不读 `TaskRun`、不读 URL 参数）。
- **复现**：执行异常明细中 `jobType=write`（`articleId=null`）→ 点击 → `/plan`。
- **影响**：用户知道"有一次写稿失败"，但页面上找不到哪次、为什么；必须回工作台「最近动态 → 任务流水」。
- **说明**：本轮按令**不建任务中心**，仅登记缺口。
- **证据**：截图 `09`、`result.json.runBatch`。

---

**P1-3 「未推送草稿」数字与列表不一致（1 vs 3），且「待重推」无筛选**

- **位置**：`DashboardView.vue:197-206`（跳转只带 `status`）；`ArticlesView` 的 status 下拉只有 `draft/pushed/updated/failed`（`:288-303`），列表 API 只认单 status。
- **复现**：卡片「未推送草稿 1」→ `/articles?status=draft` → 列表 3 行（未推送 1 + 待重推 1 + 漫画草稿 1）。
- **影响**：数字与列表对不上，用户无法判断"待处理的到底是哪一篇"；「待重推」则完全没有筛选，只能人工翻。
- **性质**：列表筛选能力缺口，不是前端参数 bug。B 轮已声明「不假装精确筛选」，但界面未把这个差异告知用户。
- **证据**：截图 `03`、`result.json.articleCases[0]`。

### P2（体验/权限一致性）

---

**P2-1 member 的体检待办指向「只能看、不能改」的页面**

- **位置**：`server/src/api/routes/articles.ts:50`（PUT 需 `content:revise`）；`server/src/api/permissions.ts:42-48`（member 无此权限）；`ArticleEditView.vue` 未按权限隐藏/禁用编辑与保存。
- **影响**：member 顺着待办点进去，能看到「体检未通过 3 项」，但点保存会 403；问题可见不可修。
- **附带矛盾**：同页「重新检查」走 `GET /:id/lint`（只需 `data:view`）却会写一条存档，导致「不能改正文、却能新增体检记录」。
- **验证程度**：**代码核实，未在浏览器复现**（Mock 无鉴权，本轮不启真实后端）。

---

**P2-2 member 直连选题库只看到「HTTP 403」，文案未表达权限**

- **位置**：`web/src/router/index.ts`（`/tracks/:id/angles` 无 `meta.roles`）；`StateError` 统一展示 `errMsg`。
- **复现**：role=member 直接访问 `/tracks/3/angles` → 页面渲染 + 「选题列表加载失败 请求失败（HTTP 403）」。
- **影响**：与工作台「隐藏该行」的处理不一致；用户会以为系统故障而不是没有权限。
- **证据**：截图 `14`、`result2.json.memberDirectUrl`。

---

**P2-3 数字/按钮没有「会跳到哪种筛选」的提示**

- **位置**：`DashboardView.vue` 待办卡（`.todo-metric`、`.todo-detail__btn` 均无 `title`）。
- **影响**：「未推送草稿」「待重推」「去文章」在界面上看起来同类，实际落点差异很大（有的精确筛、有的不筛）。用户点之前无法预期。

### P3（文案与细节）

---

**P3-1 403/404 统一显示为「请求失败（HTTP xxx）」**
- `web/src/api/http.ts` 的 `errMsg` 未区分权限/不存在；全站一致，但语义不友好。

**P3-2 `/plan` 不带账号上下文**
- 批次失败明细里其实有 `accountId`（B 轮契约已返回），但跳转只到页首，不高亮对应账号行。

---

## 7. 修复建议与工作量

| 问题 | 建议方案 | 改动范围 | 工作量 |
|---|---|---|---|
| **P0-1** | `goAnglesTop` 按该赛道分布选初筛：`candidate>0 ? 'candidate' : 'needs_revision'`；两者都为 0 时退化到不带 `status`（仅 `used=unused`） | `DashboardView.vue` 3–5 行 + 1 条断言 | **XS（≤30 分钟）** |
| P1-1 | 方案 a（推荐）：Dashboard 跳 `/tracks?pending=<trackId,...>`，赛道表读取后高亮并顶部提示「这些赛道有待审选题」；方案 b：新建跨赛道选题页（重，不建议本轮） | `DashboardView` + `TracksView` 约 40 行，无后端改动 | **M（2–3h）** |
| P1-2 | 短期：按钮加 `title`/副文案「失败原因见工作台任务流水」；中期：`/plan?accountId=` 支持定位并展示该账号近 7 天失败摘要（数据来自 `todos.runs`，不新建中心） | `DashboardView` 文案（XS）；`PlanView` 读 query + 摘要（M） | **XS + M** |
| P1-3 | 方案 a（推荐）：文章列表新增 `?needs=draft_unpushed\|repush` 复合筛选（后端 20 行 + 前端 15 行 + 冒烟）；方案 b：短期只在卡片上加说明「点开为全部草稿（含待重推/漫画）」并去掉「精确」暗示 | 后端 `routes/articles.ts` + `ArticlesView` + `smoke:dashboard` | **M（3–4h）** |
| P2-1 | 前端按 `can(role,'content:revise')` 禁用「保存/AI 改写」并提示「客户账号不改稿」；「重新检查」是否放开给 member 需产品拍板 | `ArticleEditView` + `useAuth` 暴露 role | **S（1h）** |
| P2-2 | 给 `/tracks/:id/angles` 补 `meta.roles: ['admin']`（路由守卫已有该能力），或在 `errMsg` 里把 403 映射为「无权限访问」 | `router/index.ts` 1 行 / `http.ts` 3 行 | **XS** |
| P2-3 | 给四个数字与按钮加 `title` 说明落点与筛选 | `DashboardView` 5 行 | **XS** |
| P3-1 | `errMsg` 增加 403/404 语义文案 | `web/src/api/http.ts` | **XS** |
| P3-2 | `/plan?accountId=` 高亮行 | `PlanView` + `DashboardView` | **S** |

**依赖关系**：P0-1 独立可立即修；P1-1/P1-2/P1-3 都涉及「目标页承接能力」，建议合并成一个「待办承接」小批次（P1 三项同一轮做，避免三次改同一批文件）；P2/P3 可并入 S5-UI-3（文章工作台/编辑工作区）一起处理。

---

## 8. 本轮未验证事项

| # | 未验证 | 原因 | 影响 |
|---|---|---|---|
| 1 | 真实后端下各筛选返回的**实际集合**（数量、排序、分页） | 未启动 API、未连库（避免写库） | 只验证了「参数送达 + 页面按参数发请求」；过滤语义以代码为准 |
| 2 | member 保存 403、`GET /:id/lint` 写副作用 | 同上（Mock 无鉴权） | P2-1 为**代码核实**，非运行复现 |
| 3 | 真实数据量下的分页交互（待审 >20 条、文章 >20 条翻页与筛选保持） | 夹具规模小 | 代码上 `setQuery` 会清 page 且保留其他参数，未见问题，但未实测 |
| 4 | 1024–1180px 区间侧栏展开/收起的布局 | 只测了 1440 与 500 | 已知在 <1180 自动收起，未逐档走查 |
| 5 | 深色模式下的待办卡与目标页 | B 轮已验待办卡深色；本轮未重截目标页深色 | 目标页深色沿用既有令牌，风险低但未复验 |
| 6 | 点击「去文章」「去创作计划」按钮（非数字/明细） | 与数字走同一 `goArticles('all')` / `/plan` 分支，代码等价 | 未单独点击验证 |

---

## 9. 边界声明

本轮**未修改任何业务代码、UI、样式、路由、API、Schema、Migration、配置或 `.env`**；**未连接数据库**；**未启动后端服务**；**未调用真实 LLM 或微信接口**；**未执行 Git 写操作**。新增文件仅本报告（`docs/restructure/S5-UI-2-C-WORKBENCH-FLOW-AUDIT.md`）与 `var/tmp/s5ui2c/` 下的一次性走查产物（临时服务已停止、端口已释放、浏览器 profile 已删除）。

等待验收，不进入 S5-UI-2-D。
