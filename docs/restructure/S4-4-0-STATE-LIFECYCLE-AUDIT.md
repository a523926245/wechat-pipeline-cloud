# S4-4-0 文章状态与选题回收机制 · 只读审计报告

- **日期**：2026-11-16
- **性质**：**只读审计**。未修改任何代码 / Schema / Migration / 配置 / 文档（本报告除外），未执行任何 INSERT/UPDATE/DELETE，未跑 prisma 迁移命令，未调用 LLM/微信/发布接口，未 commit。
- **基线**：`00-FINAL-EXECUTION-CHARTER.md`、`RESTRUCTURE-2.0-CONVERGED-PLAN.md`、`docs/DEVLOG.md`、`docs/WRITING-PIPELINE.md`、`S4-0-AUDIT-REPORT.md`、`S4-1/R1/R2`、`S4-2`、`S4-3` 实施报告。
- **方法**：从 API 路由 → service → `prisma.*.update/delete` 逐层追踪；所有结论均给出文件与行号（以当前工作区实际代码为准，S4-1-HF1/R1/R2、S4-2、S4-3 的未提交改动已在位）。

---

## 1. 核查范围与实际检查文件

| 类别 | 文件（逐个实读） |
|---|---|
| Schema / 迁移 | `server/prisma/schema.prisma`（Article / Angle / TaskRun / ComicPanel 四模型）、`migrations/20261113145706_init`、`20261114093000_add_angle_status_topic_review` |
| 状态写入点 | `api/routes/articles.ts`、`api/routes/emphasis.ts`、`api/routes/revise.ts`、`services/cover.ts`、`services/publisher.ts`、`services/planner.ts`、`services/comic/write.ts`、`services/comic/panels.ts`、`cli/migrate.ts` |
| 删除/回收 | `services/article-delete.ts`、`services/accounts.ts`、`services/track-delete.ts`、`services/angles.ts`（releaseAngle / deleteAngle）、`api/bulk-delete.ts` |
| 消费/调度 | `services/planner.ts`（reserveAnglesForPipeline）、`services/scheduler.ts`（自动推送选取）、`services/dashboard.ts`（统计口径） |
| 前端 | `web/src/views/ArticlesView.vue`（操作列 / 状态筛选）、`web/src/views/ArticleEditView.vue`（保存、推送）、`web/src/utils/format.ts`（状态文案） |
| 测试覆盖 | `scripts/smoke-bulk-delete.ts`、`scripts/smoke-lint.ts`、`scripts/smoke-angles.ts`（检索相关断言） |
| 数据 | 业务库 `wechat_pipeline`（SELECT only，先核验身份）、`prisma/dev.db` **副本**（只读） |

未检查（与本题无关或非业务入口）：漫画生图通道、模型配置、凭据、选题扩库评分细节、UI 主题。

---

## 2. Article 状态定义与完整流转表

### 2.1 定义（`schema.prisma:25-30`）

```prisma
enum ArticleStatus { draft  pushed  updated  failed }
```

| 状态 | 代码实际语义 | 谁写入 |
|---|---|---|
| `draft` | 尚未送达微信（或被视为未送达） | 建稿（`articles.ts:239`、`planner.ts:416`、`comic/write.ts:69`）、**编辑降级**（`articles.ts:584`）、**换封面降级**（`cover.ts:153`）、漫画重画恢复（`panels.ts:496`） |
| `pushed` | 本次推送成功，`mediaId` 为微信草稿 id | `publisher.ts:206` |
| `updated` | **「曾推送 + 本地内容已改」**（README 无定义，语义由两处写入点决定） | `revise.ts:76`、`emphasis.ts:72` |
| `failed` | 推送失败，或漫画有格生成失败达上限 | `publisher.ts:247`、`panels.ts:283-291` |

> 关键事实：**没有任何字段记录「是否曾经送达微信」**。`pushed` 是唯一载体，而它是个**会被后续写入覆盖的当前态**。这是本报告 P0 的根因。

### 2.2 状态流转表（代码允许的全部边）

| 起点 | 终点 | 触发点（文件:行） | 条件 | 备注 |
|---|---|---|---|---|
| — | draft | `articles.ts:239` | POST /articles 手动挂稿 | 无状态参数，恒 draft |
| — | draft | `planner.ts:416` / `comic/write.ts:69` | 排产建稿 | 恒 draft |
| draft | pushed | `publisher.ts:206` | 微信 `draft/add` 成功 | 同时写 `mediaId`/`pushDate` |
| **pushed** | **draft** | `articles.ts:584` | PUT /:id/content（人工保存正文） | **抹掉推送事实**；不清 `mediaId`/`pushDate` |
| **pushed** | **draft** | `cover.ts:153` | 生成新封面（`wasPushed`） | **抹掉推送事实** |
| **pushed** | **updated** | `revise.ts:76` | AI 改写应用成功 | 保留「曾推送」语义 |
| **pushed** | **updated** | `emphasis.ts:72` | 强调补全应用成功 | 同上 |
| **pushed** | **failed** | `publisher.ts:247` | **重推**且微信调用抛错（40164/40001/网络等） | **抹掉推送事实**，最隐蔽 |
| 任意 | failed | `publisher.ts:247` | 首次推送失败 | 正常 |
| draft/updated/failed | pushed | `publisher.ts:206` | 任意状态都可推送（**无状态前置校验**） | `pushArticleToDraft` 全文无 `status` 判断 |
| 任意(漫画) | failed | `panels.ts:283-291` | 某格连续失败达上限 | 已推送漫画也会被打成 failed |
| failed | draft | `panels.ts:496` | 单格重画后 | 仅 `status='failed'` 命中 |
| — | pushed | `cli/migrate.ts:541` | 历史导入 CLI | **非业务入口**，排除 |

补充：`updated` **不会被自动推送**——`scheduler.ts:339` 只取 `status: 'draft'`，且仅当日创建（`scheduler.ts:342`）。人工在列表/改稿页推送则不受限。

---

## 3. Article.status 写入点清单（全量，按可达性排序）

| # | 文件:行 | 函数 / 接口 | 写入值 | 是否业务入口 |
|---|---|---|---|---|
| 1 | `services/publisher.ts:206` | `pushArticleToDraft` 成功分支 | `pushed` | ✅ 手动推送 + 调度自动推送 |
| 2 | `services/publisher.ts:247` | `pushArticleToDraft` catch 分支（`.catch(() => undefined)` 吞错） | `failed` | ✅ 同上 |
| 3 | `api/routes/articles.ts:584` | `PUT /api/articles/:id/content` | `pushed → draft`，其余保持 | ✅ 改稿页保存 |
| 4 | `api/routes/emphasis.ts:72` | `POST /api/emphasis/articles/:id` | `pushed → updated` | ✅ 强调补全「应用」 |
| 5 | `api/routes/revise.ts:76` | `POST /api/revise/articles/:id` | `pushed → updated` | ✅ AI 改写「应用」 |
| 6 | `services/cover.ts:153` | `generateCoverForArticle` | `pushed → draft`（仅 `wasPushed`） | ✅ 改稿页生成封面 |
| 7 | `api/routes/articles.ts:239` | `POST /api/articles` | `draft` | ✅ 手动挂稿 |
| 8 | `services/planner.ts:416` | `runPipelineForAccount`（article） | `draft` | ✅ 排产 |
| 9 | `services/comic/write.ts:69` | `createComicDraft` | `draft` | ✅ 漫画建稿（手动 + 排产共用） |
| 10 | `services/comic/panels.ts:283-291` | `processComicImages` | `failed`（有格超上限） | ✅ 后台生图 |
| 11 | `services/comic/panels.ts:496` | `regeneratePanel` | `failed → draft` | ✅ 单格重画 |
| 12 | `cli/migrate.ts:541` | 历史导入 | `pushed` | ❌ CLI 一次性工具 |

**不写 status 的更新点**（易误判，逐一排除）：`services/render/comic.ts:131`（只写 `contentWechat`）、`panels.ts:264-270`（只写 `note`）、`angles.ts:1158`（只解绑 `angleId`）。

---

## 4. Angle.used 写入点清单（全量）

| # | 文件:行 | 函数 | 写入 | 前置校验 |
|---|---|---|---|---|
| 1 | `services/planner.ts:292-298` | `reserveAnglesForPipeline`（`$transaction` 内 CAS：先查 `used=false, status='approved'`，再批量 `updateMany`） | `used: true` + `usedBy/usedDate/usedById/usedByAccountId` | 事务内读，非行锁；并发靠 `updateMany` 覆盖 |
| 2 | `services/article-delete.ts:54-57` | `deleteArticleById`（事务内） | `used: false` + 四个归属字段清空 | **仅 `a.status !== 'pushed'`**，无「其他文章仍引用」校验 |
| 3 | `services/accounts.ts:193-197` | `deleteAccount`（事务内） | 同上 | **同上**（`accounts.ts:185-192` 聚合过滤，`:188` 判定） |
| 4 | `services/angles.ts:582-584` | `releaseAngle`（手动归还） | 同上 | ✅ 校验 `used=true` 且 `articleCount===0` |
| 5 | `cli/migrate.ts:463` | 历史导入 | 按源数据 | ❌ CLI |

只读引用（不写）：`angles.ts:501/530/585`、`tracks.ts:96`、`dashboard.ts`、`inspect.ts:28/55`、`angles.ts:1151`。

> 注意：**`angles.ts:544-547` 的注释明确写「消费态字段由排产与文章删除逻辑维护」**，`updateAngle` 也确实不接受 `used`（`angles.ts:914-916` + 字段白名单只含 theme/content/scope）。这条约定目前是守住。

---

## 5. Article 删除入口及其行为

| 入口 | 路由 → 服务 | 角度处理 | 事务 | 其他副作用 |
|---|---|---|---|---|
| 单条删除 | `DELETE /api/articles/:id`（`articles.ts:374-381`）→ `deleteArticleById` | `status !== 'pushed'` → 归还 | ✅ `$transaction`（`article-delete.ts:35-63`） | 级联删 `ComicPanel`、`ArticleLintRun`；`TaskRun.articleId` **不受影响**（无外键） |
| 批量删除 | `POST /api/articles/bulk-delete`（`articles.ts:393-407`）→ `runBulkDelete` → 逐条 `deleteArticleById` | 同单条（共用服务） | 逐条各自事务，非整体事务 | 一条失败不影响其余（设计如此） |
| 删账号 | `DELETE /api/accounts/:id` → `deleteAccount`（`accounts.ts:164-215`） | 先聚合 `status !== 'pushed'` 的 angleIds → 批量归还 → 删文章 | ✅ 单事务 | 文章级联删；`TaskRun.accountId` 置空 |
| 删赛道 | `deleteTrackById`（`track-delete.ts`） | 有账号则拒删；`Angle` 级联删、`Article.trackId` SetNull，**不删文章** | 单条 delete（依赖外键） | 文章变「未归属」 |
| 删选题 | `deleteAngle`（`angles.ts:1148-1170`） | 显式 `updateMany` 解绑 `angleId=null` 再删题目 | ✅ `$transaction([...])` | 正文保留；`used` 随行消失 |

**边界确认**：`TaskRun` 无指向 `Article` 的外键（`schema.prisma:458-487`，仅 `articleId Int?` 普通列），因此删除文章后 push 流水仍在，但 `articleId` 成为悬空值、UI 不展示 → 追溯只能查库（见 P2-6）。

---

## 6. 四条调用链（逐层）

### 6.1 人工编辑

```
ArticleEditView.save()                       web/src/views/ArticleEditView.vue:388
  → PUT /api/articles/:id/content            server/src/api/routes/articles.ts:552
    → build()（parse + render，共用推送渲染）  articles.ts:76
    → prisma.article.update                  articles.ts:573-587
        status: a.status === 'pushed' ? 'draft' : a.status      ← 584
        （不清 mediaId / pushDate）
    → lintArticle + recordLintRun('save')    articles.ts:590-606（S4-3）
```
标题/摘要不可单独编辑（从 `h1`/正文派生）；封面走 `POST /:id/cover` → `cover.ts:146-156`，`wasPushed` 时同样降 `draft`。

### 6.2 AI 改写 / 强调补全

```
ArticleEditView.runRevise(true)              ArticleEditView.vue:486
  → POST /api/revise/articles/:id            api/routes/revise.ts:53
    → reviseHtml()（真实 LLM 调用）           services/revise.ts
    → prisma.article.update                  revise.ts:68-79
        status: article.status === 'pushed' ? 'updated' : article.status   ← 76
```
强调补全 `emphasis.ts:65-75` 完全同构（`← 72`）。
生成链路（`planner` → `writer`）**不修改已有 Article**，只 create 新行（`planner.ts:403-421`），因此「AI 写作」不会碰历史推送事实；**只有「改写已存在文章」才会**。

### 6.3 推送

```
ArticleEditView.push() / ArticlesView.push(row)   （两处均无状态限制）
  → POST /api/articles/:id/push                articles.ts:631
    → pushArticleToDraft(articleId)            services/publisher.ts:56
        1 时间：findUnique（含 track.name）         :59-62
        2 账号校验 accountId / credStatus==='ok'    :65-86
        3 漫画产物就绪 ensureComicAssetsReady       :90-102
        4 空正文校验                                :104-112
        5 成稿体检门禁 + S4-3 留痕                  :114-146
        6 WechatClient.fromAccountId               :167
        7 封面上传（必要时）                        :147-176
        8 client.addDraft(...)  ← 微信端新建草稿     :193
        9 prisma.article.update {mediaId, status:'pushed', pushDate}  :202-211
       10 recordPushRun（TaskRun 流水）             :213-221
       catch → prisma.article.update {status:'failed'}（吞错）  :244-248
```

### 6.4 删除

见 §5。核心两行：`article-delete.ts:51`（判定）、`:54-57`（归还）。

---

## 7. 已确认的问题与代码证据

> 分级口径：**P0** 可能造成已推送事实丢失或错误发布；**P1** 可能导致文章状态或选题使用状态错误；**P2** 边界不一致/可维护性；**INFO** 当前合理。

### P0-1 · 「是否送达过微信」只由当前 `status` 表达，任何后续状态写入都会抹掉该事实；删除回收又以它作唯一判据

**证据（写入侧）**

| 文件:行 | 代码 | 覆盖后状态 |
|---|---|---|
| `api/routes/articles.ts:584` | `status: a.status === 'pushed' ? 'draft' : a.status` | pushed → **draft** |
| `services/cover.ts:153` | `...(wasPushed ? { status: 'draft' as const } : {})` | pushed → **draft** |
| `api/routes/revise.ts:76` | `status: article.status === 'pushed' ? 'updated' : article.status` | pushed → **updated** |
| `api/routes/emphasis.ts:72` | 同上 | pushed → **updated** |
| `services/publisher.ts:247` | `.update({ where: { id: articleId }, data: { status: 'failed' } })` | pushed → **failed** |

**证据（判据侧）**
```ts
// services/article-delete.ts:51
if (a.status !== 'pushed' && a.angleId != null) { …归还… }
// services/accounts.ts:188
.filter((a) => a.status !== 'pushed' && a.angleId != null)
```

**实际执行路径**：`pushed` → 改稿/改写/换封面/重推失败 → `draft|updated|failed` → 删除文章 → `status !== 'pushed'` 成立 → `Angle.used=false` → 该选题回到未用池 → `reserveAnglesForPipeline`（只要求 `used=false && status='approved'`）再次发放 → **同一选题被写第二篇、再推一次草稿**。

**业务后果**：①「已送达微信」这一事实从本地数据里不可恢复地消失（`mediaId`/`pushDate` 虽仍在，但没有任何代码把它当判据）；②同题重写重推，正是 S4-0 指出的「与 pushed 刻意不归还的设计意图矛盾」；③`updated` 与 `draft` 两条路径都能触发，覆盖面比 S4-0 描述的更宽。

**测试覆盖**：`smoke-bulk-delete.ts:120-137` 只覆盖「**直接** 删除 pushed 文章 → 不归还」；**没有任何用例覆盖「pushed → 改稿/改写 → 删除」**（全文件 grep 无第二次状态变更）。也就是说这条路径从来没被测试拦过。

**S4-0 对照**：S4-0 §P1-4 已指出「pushed→draft vs pushed→updated 双语义 + 角度回收漏洞」，**当前代码中完全未修**；本轮新增的是「重推失败 → failed」这条第三条覆盖路径（见 P0-2）。

### P0-2 · 已推送文章「重新推送失败」会把状态改成 `failed`，静默抹掉推送事实（S4-0 未点名）

**证据**：`publisher.ts:56-248` 全文**没有任何 `status` 前置校验**（`grep -n "a.status\|article.status" publisher.ts` 零命中）；失败分支无条件写 `status: 'failed'`（`:247`）。
**触发条件**：对 `pushed` 文章再次点「推送草稿箱」（`ArticlesView.vue:242-261` 的操作列对所有状态都提供该命令；`ArticleEditView` 的推送按钮同样无状态判断），且微信返回错误（40164 白名单、40001/42001 token、网络失败等）。
**后果**：微信端明明有草稿、本地变成「失败」，随后按 P0-1 的判据归还角度；`failed` 还会让仪表盘把它计入失败数（`dashboard.ts:258`）。
**测试覆盖**：无。`smoke-lint.ts` 的推送用例只覆盖「lint 门禁拦截」（此分支在微信调用之前 return，**不写 status**）。

### P1-1 · 自动归还角度时没有校验「是否还有其他文章引用同一选题」

**证据**：`article-delete.ts:54-57` 直接 `updateMany({ where: { id: a.angleId }, data: { used: false … } })`；`accounts.ts:193-197` 同理（且是先聚合再批量归还）。
**结构前提**：`Article.angleId` **无唯一约束**（`schema.prisma:342-397`，只有 `@@index([angleId])` 在 `:389`），一个选题可以被多篇文章引用；手动归还 `releaseAngle`（`angles.ts:573-577`）恰恰校验了 `articleCount===0` —— **自动路径缺了手动路径有的这道保护**。
**后果**：删掉其中一篇未推送的（如草稿）→ 选题被归还 → 另一篇已推送文章仍在引用它，但选题已回池可再被发放 → 又回到 P0-1 的同题重复。
**测试覆盖**：无（`smoke-bulk-delete` 里每个 angle 只挂一篇文章）。

### P1-2 · 手动挂稿 / 手动漫画建稿不占用选题（`used` 保持 false）

**证据**：
- `POST /api/articles`（`articles.ts:191-257`）：只 `assertAngleApproved`（`:215`），随后 `prisma.article.create`（`:223`），**无 `angle.update`**。
- `POST /api/articles/comic/create`（`articles.ts:99-121`）→ `createComicDraft`（`comic/write.ts:38-88`）：只 create Article + ComicPanel + TaskRun，**无 used 写入**。
- 对照：排产路径是 `reserveAnglesForPipeline`（置 `used=true`）**之后**才建稿（`planner.ts:337` → `:369`（漫画）/`:399`（文章））。

**后果**：① 该选题仍 `used=false`，可被 reserve 再次发放给别的账号 → 同题重复生产；② 删除这篇手动稿时会去「归还」一个从未占用的选题（`updateMany` 命中 1 行、`recycledAngle=true` 的假信号）；③ 选题列表显示「未用」，与事实（已有文章）不符。
**触发条件**：带 `angleId` 的 `POST /api/articles`，或漫画建稿页直接选一道题建稿。属真实业务入口（非 CLI）。
**测试覆盖**：`smoke-angles` 覆盖的是 `assertAngleApproved` 门禁（S4-1-HF1 补充核查），**未断言 used 变化**。

### P1-3 · 预留与建稿不在同一事务，失败会留下「已占用但无文章」的孤儿选题

**证据**：
- `reserveAnglesForPipeline` 在自己的 `$transaction` 内提交 `used=true`（`planner.ts:271-303`，定义 `:271`、`used: true` `:292`）；随后建稿在事务外（`:369` 起）。
- 漫画分支显式 catch 并**吞掉失败**：`planner.ts:376-379`（`created.push({ id: 0, … note: '漫画脚本失败：…' })`），此时 `used` 仍为 true。
- 文章分支**无 try/catch**（`planner.ts:399-421`）：`renderArticle` / `article.create`（`:403`）抛错会中断整个 for 循环，已预留但未产出的角度全部 `used=true` 且无文章。

**后果**：选题「虚耗」（`used=true, 无文章`）。`angles.ts:562-565` 的注释正是描述这种孤儿，但只能**人工** `releaseAngle` 回收（`articleCount===0` 成立），不会自动补偿。
**触发条件**：LLM 超时/进程重启（自动写稿每天都会遇到偶发）、DB 瞬时错误、漫画脚本生成失败。
**测试覆盖**：无。

### P2-1 · 仪表盘文章分桶漏 `updated`

`dashboard.ts:256-258` 只统计 `draft/pushed/failed`，`updated` 既不在前也不在后 → 有 updated 文章时 `total ≠ draft+pushed+failed`，且「已更新待重推」这一最需要提醒的集合在首页不可见。

### P2-2 · 编辑降级时不清 `mediaId` / `pushDate`，产生混合态

`articles.ts:573-587` 的 `data` 只含 contentHtml/contentWechat/title/digest/blocks/chars/status。于是一篇「已推送→改稿」的文章是 `status=draft` + `mediaId=xxx` + `pushDate=2026-11-10`。这本身恰好为 P0-1 的修复方案 R1 提供了可用判据，但当前代码没有任何地方使用它，语义上属「状态与字段自相矛盾」。
（业务库当前无数据，无法展示实例；见 §9。）

### P2-3 · 重推 = 新建草稿，微信端会重复

`publisher.ts:193` 调 `client.addDraft` → `wechat.ts:257-268` 走 `/draft/add`（新建）。`updateDraft`（`wechat.ts:271-274`）全仓零调用方（`publisher.ts:13-16` 的 TODO 已说明原因：内部 `normalizeArticle` 会整篇覆盖，可能冲掉人工在公众号后台的编辑）。后果：同一篇文章被推两次 → 微信草稿箱两份 → 本地 `mediaId` 只留最新，旧的成为无法追踪的孤儿草稿。

### P2-4 · 已推送漫画改图后的状态与微信端不一致

- 单格重画**成功**：`panels.ts:264-266` 只更新 `note`；`panels.ts:496` 只把 `failed → draft`。`pushed` 漫画重画后仍是 `pushed`，但 `contentWechat`（图床 URL 序列）已变 → 本地「已推送」与微信端旧图不符。
- 某格**失败达上限**：`panels.ts:283-291` 把文章打成 `failed`，即使是已推送的漫画。

### P2-5 · 并发覆盖（理论，未实证）

`articles.ts:574` 读 status → `:584` 写状态，是典型 read-modify-write，无 CAS（对比 `updateAngle` 的 CAS 写法）。若「推送进行中」与「保存正文」并发，后写者覆盖前者：推送成功后可能被保存写成 draft（事实丢），或保存后推送写成 pushed（新正文未推）。个人单用户场景概率低，故不列为必修。

### P2-6 · 删除已推送文章后，本地只剩悬空的 TaskRun 流水

`TaskRun.articleId` 无外键（`schema.prisma:458-487`），删文章不级联；但 `recordPushRun` 写入的流水在 UI 无入口（`dashboard.ts` 的「最近任务」只看若干字段）。「微信端有草稿、本地查不到任何文章」时只能查库，追溯成本高。

### INFO

| 编号 | 内容 |
|---|---|
| INFO-1 | 四个状态本身够用，**不建议**新增状态值或重建状态机；缺的是「曾推送」这一**事实位**，不是新状态。 |
| INFO-2 | `updated` = 「曾推送 + 本地内容已改」的语义本身正确（`revise`/`emphasis` 用它是对的）；错的是 `PUT /content` 用 `draft` 表达同一件事——两套写法不一致（S4-0 已指出，仍在）。 |
| INFO-3 | `scheduler.ts:339`（筛选）/`:342`（当天过滤） 只推「当天创建且 status=draft」的文章：隔夜草稿不会自动补推。这是既定业务规则（避免补推陈稿），但文档未写明，属可维护性缺口。 |
| INFO-4 | 删除类操作的事务边界完整（单篇/账号均单事务；批量按条独立）。推送是「外部调用 + 单条 update」，无法事务化，属必要妥协——缺的是**补偿/判定口径**，不是事务。 |
| INFO-5 | `releaseAngle` 的前置校验（`used=true` 且 `articleCount===0`）是正确的，可作为 R3 的范式。 |

---

## 8. 潜在风险与无法验证的事项

| 项 | 说明 |
|---|---|
| 未实证：并发覆盖 | P2-5 属代码结构可推、真实未发生（单用户）。不给锁方案。 |
| 未实证：微信端草稿重复 | P2-3 需真实推送才能观察，本轮禁止外呼。 |
| 无法验证：多文章共享 angle 的实际占比 | 业务库 0 文章、归档 dev.db 无重复引用（§9），故 P1-1 目前是「结构允许 + 无保护」而非「已发生」。 |
| 无法验证：孤儿选题历史 | 归档 dev.db 中 `used=1 且无文章 = 0`（§9），说明 2026-10 那批数据没留下孤儿；不排除生产使用后产生。 |
| 未覆盖：`cli/migrate.ts` | 历史导入工具含 status/used 直写，非业务入口，本轮不审计其正确性，但**部署/重跑前需注意**它会绕过所有业务规则。 |

---

## 9. 真实数据层面证据

### 9.1 业务库（只读，先核验身份）

```
DATABASE()=wechat_pipeline   CURRENT_USER()=wpc_app@127.0.0.1   @@version=8.0.30
① 文章按状态分布            → []（0 行）
② 选题 used 分布            → []（0 行）
③ 文章有选题但选题未占用     → 0
④ 选题已占用但无文章         → 0
⑤ 一个选题被多篇文章引用     → []（无）
⑥ pushed 缺 mediaId/pushDate → 0
⑦ 非 pushed 却带 mediaId     → 0
⑧ 产线×状态分布             → []（0 行）
⑨ TaskRun push 流水          → []（0 行）
```
**结论**：业务库为空库（S1「空库起步不迁数据」的既定状态），**没有真实数据可证伪**。上述 0 值只能证明「当前无数据层面的异常实例」，不能证明「机制没问题」。

### 9.2 dev.db 归档（复制副本只读，原文件未打开）

```
原文件 SHA-256 前 = fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5
原文件 SHA-256 后 = fea0f123…（完全一致，文件未被触碰）
状态分布          → draft: 12
used 分布         → used=0: 21, used=1: 12
文章有角度但角度未占用 → 0
角度已占用但无文章     → 0
一个角度多文章        → 无
pushed 缺 mediaId     → 0
非 pushed 却带 mediaId → 无
```
**结论**：该归档快照（2026-10 本机流水线导出）里的 12 篇全为 draft、从未推送，6 项一致性检查全部为 0 → **归档时点不存在状态/占用不一致**；但也因此**无法**用它对 P0/P1 做正例验证（没有任何 pushed 样本）。

---

## 10. 当前测试覆盖情况

| 关注点 | 覆盖情况 | 文件:行 |
|---|---|---|
| 直接删 pushed 文章 → 不归还 | ✅ 有 | `smoke-bulk-delete.ts:120-137`（构造 `status:'pushed'` 行）、`:192-196` |
| 删 draft 文章 → 归还 | ✅ 有 | `smoke-bulk-delete.ts:174-192` |
| 删账号归还未推送 / 不归还已推送 | ✅ 有 | `smoke-bulk-delete.ts:198-228` |
| **pushed → 改稿 → 删除 → 是否归还** | ❌ **无** | — |
| **pushed → AI 改写/强调 → 删除** | ❌ **无** | — |
| **pushed 重推失败 → status 变 failed** | ❌ **无** | — |
| PUT /content 对 pushed 的状态影响 | ❌ 无断言 | `smoke-lint.ts` 的 PUT 用例只验证 lint 留痕（10.5），不校验 status |
| 手动挂稿是否占用选题 | ❌ 无 | `smoke-angles` 只覆盖 approved 门禁 |
| 多文章共享同一 angle 的回收 | ❌ 无 | — |
| reserve 后建稿失败留孤儿 | ❌ 无 | — |
| 选题占用/归还主流程 | ✅ 有 | `smoke-angles`（S4-1/R2 用例）、`smoke-bulk-delete` |

**结论**：现有测试把「状态」当作**构造输入**（直接 `create` 出 `status:'pushed'` 的行），从未把「状态转换」本身当作被测对象。P0/P1 全部落在测试盲区。

---

## 11. 最小必要修复建议（**不实施**）

### 必修（P0）

**R1 — 把「是否曾送达微信」的判定与 `status` 解耦（零 Schema，推荐先做）**

判定口径改为「本地推送痕迹」：
```ts
// 现在（article-delete.ts:51 / accounts.ts:188）
a.status !== 'pushed'
// 建议
!(a.mediaId !== '' || a.pushDate !== '')
```
- 覆盖面：P0-1 的 4 条覆盖路径 + P0-2 全部失效（重推失败后 `mediaId`/`pushDate` 仍在）。
- 影响文件：`services/article-delete.ts`（1 处）、`services/accounts.ts`（1 处；需把 `select` 补上 `mediaId/pushDate`）。
- 约束：`mediaId`/`pushDate` 当前**无任何清空路径**（全仓 grep 确认），故可靠；将来若新增「清空推送痕迹」，必须同步该判据（在字段注释里写明）。
- 不新增表、不新增列、不改状态枚举。

**R2 — （可选，更干净）新增 `Article.everPushedAt DateTime?`**

`publisher.ts:202-211` 成功时写入（`everPushedAt: article.everPushedAt ?? new Date()`），回收判据用 `everPushedAt == null`。
- 优点：语义显式，不依赖字段组合；一次回填即可（`status IN ('pushed','updated') OR mediaId<>''`）。
- 代价：1 列 + 迁移（业务库部署需单独授权）。**若接受 1 列，R2 优于 R1。**

### 必修（P1）

**R3 — 自动归还加「无其他文章引用」保护**
在事务内先 `count({ where: { angleId, id: { not: a.id } } })`，为 0 才归还；或 `updateMany` 后不影响他人（Prisma relation filter 写法可用 `articles: { none: {} }`，需在实现时验证版本支持）。与 `releaseAngle`（`angles.ts:573-577`）的既有校验对齐即可。

**R4 — 手动挂稿/手动漫画建稿占用选题（需业务确认）**
`POST /articles` 与 `POST /articles/comic/create` 在创建成功的同时（同事务）置 `used=true` + 归属字段。**这是行为变更**（手动建稿从此消耗选题），需你确认；若「手动挂稿」在外部分流里本就不该消耗题库，则应改为**禁止**携带 `angleId`，二者择一。不建议维持现状（既不占用、又会在删除时假归还）。

**R5 — 预留后建稿失败的补偿**
`planner.ts` 文章分支补 `try/catch`；失败时把该 angle 归还（此时 `articleCount===0`，用 `releaseAngle` 同一套条件），并把失败写进 `TaskRun.errorMessage` 而不是静默跳过。漫画分支（`:376-379`）同样在 catch 内归还。**不做**分布式锁/队列重试。

### 可选（P2，按需）

| 编号 | 建议 | 是否本轮必须 |
|---|---|---|
| R6 | `dashboard.ts:256-258` 补 `updated` 分桶（或显式给出 `updated` 计数），使 total 可加总 | 否 |
| R7 | 已推送文章重推前给一次确认（「将新建第二份草稿」），或 `addDraft` 前判断 `mediaId` 走 `updateDraft`（需先解决覆盖风险，`publisher.ts:13-16` 的 TODO） | 否 |
| R8 | 已推送漫画重画成功后置 `updated`（而非保持 `pushed`），让「需重推」在状态上可见 | 否 |
| R9 | 中文文案：`updated` 现在显示「已更新」，建议改为「已推送·待重推」以准确表达 | 否 |

### 明确不建议

1. 不新建事件表/状态历史平台（`ArticleLintRun` 那种「一次执行一行」的留痕只适用于检查，状态机不需要另起一套）。
2. 不引入新状态值（如 `ever_pushed`）——那会把「事实」和「当前态」继续混在枚举里。
3. 不为 P2-5 的并发加锁或版本号。
4. 不改 `updateDraft` 的复用策略（会波及公众号后台人工编辑，属独立决策）。

### 修复范围预估

| 方案 | 涉及文件 | Schema/Migration |
|---|---|---|
| R1 + R3 + R5 | `services/article-delete.ts`、`services/accounts.ts`、`services/planner.ts`（+ `smoke-bulk-delete.ts` 新增用例） | **不需要** |
| R2 + R3 + R5 | 上述 + `prisma/schema.prisma` + 1 个迁移 | **需要（1 列，待授权）** |
| R4 | `api/routes/articles.ts`、`services/comic/write.ts`（或改为禁止带 angleId） | 不需要 |

---

## 12. 本轮只读证明与 Git 前后对比

### 12.1 只读证明

| 项 | 证据 |
|---|---|
| 代码 / Schema / Migration / 配置 | **零修改**：`git status --short` 开工前 25 行、收尾 26 行，差异**只有本报告这一个新增文件**（逐行比对：15 个 M + 10 个既有 ?? 完全一致） |
| Prisma 命令 | 未执行 `db push` / `migrate dev` / `migrate deploy` / `migrate resolve`（本会话只跑过 `node` 只读脚本） |
| 数据库写入 | 业务库仅 `SELECT`；身份先核验 `DATABASE()=wechat_pipeline`、`CURRENT_USER()=wpc_app@127.0.0.1` |
| dev.db | 未直接打开原文件；复制到 `server/var/tmp/s440/dev-copy.db` 后以 `readOnly` 打开，**审计结束已删除该副本**；原文件 SHA-256 前后一致（`fea0f123…`） |
| 外呼 | 未调用 LLM / 微信 / 发布接口（本轮无任何 HTTP 外呼代码） |
| 他项目库 | 未触碰（仅 `wechat_pipeline` 与 dev.db 副本） |
| 未提交改动保护 | S4-1-HF1/R1/R2、S4-2、S4-3 的修改与未跟踪文件**全部原样在列**，未回退、未清理 |

### 12.2 Git 工作区（开工前 = 收尾，逐行一致）

```
 M docs/DEVLOG.md                      ← S4-2/S4-3
 M server/prisma/schema.prisma         ← S4-3
 M server/scripts/smoke-angles.ts      ← S4-1-HF1/R1/R2/S4-2
 M server/scripts/smoke-isolated.ts    ← S4-3
 M server/scripts/smoke-lint.ts        ← S4-3
 M server/src/api/routes/angles.ts     ← S4-1-HF1/R1/S4-2
 M server/src/api/routes/articles.ts   ← S4-3
 M server/src/services/angles.ts       ← S4-1-HF1/R1/R2/S4-2
 M server/src/services/dedup.ts        ← S4-2
 M server/src/services/publisher.ts    ← S4-3
 M server/src/services/topic-review.ts ← S4-1/R2/S4-2
 M web/src/api/index.ts                ← S4-2 + S4-3
 M web/src/types.ts                    ← S4-2 + S4-3
 M web/src/views/ArticleEditView.vue   ← S4-3
 M web/src/views/TrackAnglesView.vue   ← S4-2
?? docs/restructure/S4-1-HF1-IMPLEMENTATION-REPORT.md
?? docs/restructure/S4-1-HF1-R1-IMPLEMENTATION-REPORT.md
?? docs/restructure/S4-1-HF1-R2-IMPLEMENTATION-REPORT.md
?? docs/restructure/S4-1-MIGRATION-DEPLOY-REPORT.md
?? docs/restructure/S4-1-PRE-MIGRATION-CHECK-REPORT.md
?? docs/restructure/S4-2-0-DEDUP-AUDIT-REPORT.md
?? docs/restructure/S4-2-IMPLEMENTATION-REPORT.md
?? docs/restructure/S4-3-IMPLEMENTATION-REPORT.md
?? server/prisma/migrations/20261116120000_add_article_lint_run/   ← S4-3
?? server/src/services/lint-store.ts                              ← S4-3
```
`git diff --stat` = 15 files changed, 2324 insertions(+), 85 deletions(-)（与 S4-3 收尾时一致；本轮零增量）。
新增（本轮唯一）：`docs/restructure/S4-4-0-STATE-LIFECYCLE-AUDIT.md`（本报告）。

---

## 13. 结论速览（回答开工指令的六个问题）

1. **S4-0 指出的三个问题是否找到**：找到两处——①`lint` 残留不落库（**已由 S4-3 修复**，本文不再列为问题）；②`pushed→draft` / `pushed→updated` 双语义 + 删除误归还角度（**代码中完全未修，见 P0-1**）；③planner 落库无 note（S4-3 未涉及，本轮亦未列入状态问题，属内容质量问题）。
2. **是否仍存在**：P0-1 **是**（且覆盖面比 S4-0 描述更宽：编辑、封面、AI 改写、强调补全、重推失败五条路径都能抹掉推送事实）。
3. **新发现的高优先级问题**：P0-2（重推失败 → failed，静默抹事实）、P1-1（多文章共享 angle 时自动归还无保护）、P1-2（手动挂稿/漫画建稿不占题）、P1-3（reserve 后失败留孤儿）。
4. **建议修 / 不修**：必修 R1（或 R2）+ R3 + R5；R4 需业务决策；R6-R9 按需。不修：状态机重建、事件表、并发锁、`updateDraft` 复用。
5. **最小修复涉及文件**：`services/article-delete.ts`、`services/accounts.ts`、`services/planner.ts`（+ 测试 `scripts/smoke-bulk-delete.ts`）；若采用 R4 再加 `api/routes/articles.ts`、`services/comic/write.ts`。
6. **是否需要 Schema/Migration**：**R1 路线不需要**；R2 路线需要 1 列 + 1 个迁移（业务库部署需单独授权）。
7. **真实数据异常证据**：**无**。业务库为空库（0 文章/0 选题/0 推送流水），dev.db 归档 6 项一致性检查全 0 且 12 篇从未推送 → 无法用真实数据证伪，也无法证实；P0/P1 全部由代码路径证明。

**停在本报告，等待人工审核与下一步授权。未改代码、未迁移、未部署、未 commit。**
