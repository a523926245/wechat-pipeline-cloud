# S4-3 成稿体检（Lint）结果闭环 · 实施报告

- **日期**：2026-11-16
- **授权**：S4-3 开工授权（Lint 检查结果闭环）。授权范围：代码实施 + 隔离测试 + 交付报告；**不授权**业务库 Migration 部署、不授权 Git commit。
- **依据**：`00-FINAL-EXECUTION-CHARTER.md`、`RESTRUCTURE-2.0-CONVERGED-PLAN.md`（§八 S4 范围）、`docs/DEVLOG.md`、`docs/WRITING-PIPELINE.md`、`S4-0-AUDIT-REPORT.md`、`S4-2-IMPLEMENTATION-REPORT.md` 及当前工作区代码。
- **状态**：代码与隔离验证完成，**停等人工验收。未 commit、未对业务库部署 Migration。**

---

## 1. 改造前问题与代码证据

### 1.1 体检结论只活一次，关掉页面就没了

改造前所有执行点都是「算完即弃」——`lintArticle()` 是纯函数，返回值只进当前响应/日志：

| 执行入口 | 改造前代码（位置） | 后果 |
|---|---|---|
| 改稿页手动检查 | `server/src/api/routes/articles.ts:483-495`，注释原文「**只算不落库**，返回与推送门禁完全一致的判定」 | 用户点一次检查，结论只在浏览器内存里 |
| 保存正文 | `articles.ts:534-547`（PUT /:id/content）把报告塞进响应体 | 改稿历史里没有任何「当时过没过」的记录 |
| 推送门禁 | `server/src/services/publisher.ts:116-139`，只有 `logger.warn/info` 一行日志 | 日志滚动后无法回答「这篇当时为什么被拦」 |
| 生成链路（writer） | `server/src/services/writer.ts:593/620` 的 repair 循环报告 | 属内部诊断，且 writer 返回体（`{contentHtml, modelUsed, note}`）不带报告 |

### 1.2 唯一「像记录」的两处都不可用

- `Article.note`：只存一句给人看的中文摘要（`writer.ts` 拼接 leftover errors），**不是结构化数据**，无法筛/比/统计。
- `Article.qualityJson`：**死字段**（全仓零读写，`docs/AUDIT-REPORT.md:20`、`DATABASE-DESIGN-REVIEW.md:64` 均有登记）。
  按 `DATABASE-DESIGN-REVIEW.md:148` 的既有裁决，把 lintReport 每次塞进 `qualityJson` 正是「存了没人读」的死字段模式——单列 Json 只能留最后一次，**与「区分不同次检查、保留历史」直接冲突**，因此本阶段未复用它。

### 1.3 由此产生的业务缺口

1. 同一篇稿子改三次、体检三次，前两次的结论与明细不可追溯（只剩最后一次若有若无的响应体）。
2. 推送被拦时「拦的是哪几条、什么错误码」只存在日志里，文章页无从复看。
3. 无法回答「这篇文章从不成形到可推送，中间体检收敛了几轮」——而这正是质量指标的基础数据。

---

## 2. 实际修改文件与目的

| 文件 | 改动 | 目的 |
|---|---|---|
| `server/prisma/schema.prisma` | +31 行：新增 `ArticleLintRun` 模型；`Article` 增 `lintRuns` 关系 | 一次检查一行的持久化结构（详见 §3） |
| `server/prisma/migrations/20261116120000_add_article_lint_run/migration.sql` | **新增**：建表 + 索引 + 级联外键 | 迁移**只在隔离库执行**，业务库未部署（§7/§9） |
| `server/src/services/lint-store.ts` | **新增**（162 行）：`recordLintRun` / `latestLintRun` / `listLintRuns` / `htmlFingerprint` | 落库与读取的唯一入口；失败不静默（§4.3） |
| `server/src/api/routes/articles.ts` | +83/−9：`GET /:id/lint` 落库（trigger=check）；`PUT /:id/content` 落库（trigger=save）；`GET /:id/preview` 返回最近存档+过期判定；**新增** `GET /:id/lint-runs` | 三个「人操作」入口全部留痕；预览保持只读 |
| `server/src/services/publisher.ts` | +25：门禁结论（通过/拦截都记）落库（trigger=push），`PushResult` 增 `lintRun`/`lintPersistError` | 推送时刻的判定成为书面证据 |
| `server/scripts/smoke-lint.ts` | +185：新增「10 体检结果落库」22 条断言 | §6 |
| `server/scripts/smoke-isolated.ts` | +6/−6：`BUSINESS_TABLES` / `SMOKE_DROP_ORDER` 补 `ArticleLintRun`（子表在 `Article` 前） | 新表的空库证明与清库顺序 |
| `web/src/types.ts` | +53：`ArticleLintRun`；`ArticleRenderResult`/`PushResult` 增存档字段 | 类型与后端一致 |
| `web/src/api/index.ts` | +34：`checkArticleLint` / `listArticleLintRuns` | 前端入口 |
| `web/src/views/ArticleEditView.vue` | +151/−13：体检面板增「存档行 / 重新检查 / 历史 N 次 / 存档过期 / 未存档告警」 | §5 |
| `docs/DEVLOG.md` | 追加本阶段条目 | 台账 |

**未触碰**：`lint.ts`（规则本体零改动：阈值、严重级别、正则、豁免逻辑全未动）、`constants.ts`、`writer.ts`、`planner.ts`、渲染链、审核/去重/排产状态机、`.env`、`AUTO_PUBLISH=false`。

**既有未提交改动全部保留**（S4-1-HF1 / R1 / R2 / S4-2）：`services/angles.ts`、`services/dedup.ts`、`services/topic-review.ts`、`api/routes/angles.ts`、`scripts/smoke-angles.ts`、`web/views/TrackAnglesView.vue`、以及 `web/src/types.ts` / `web/src/api/index.ts` 中属于 S4-2 的部分——本轮只在其后追加，未回退、未清理。

---

## 3. 数据保存结构与关联关系

```
Article 1 ──── N ArticleLintRun        （onDelete: Cascade）
                  id            Int  PK
                  articleId     Int  FK → Article.id   （INDEX [articleId, createdAt]）
                  trigger       VarChar(16)   check | save | push
                  ok            Boolean       无 error 即通过（≡ LintReport.ok）
                  errorCount    Int
                  warnCount     Int
                  statsJson     Json?         LintStats 快照
                  issuesJson    Json?         LintIssue[] 快照（level/code/message/hits）
                  ruleJson      Json?         {checks, relax} 快照
                  contentHash   VarChar(64)   被检正文 SHA-256
                  createdAt     DateTime
```

四条口径，逐条对应授权要求：

1. **可靠保存**：三个执行点显式 `await recordLintRun(...)`，失败路径见 §4.3。
2. **关联正确**：单一外键 `articleId`（外键约束 + 级联删除），无多态、无自由文本关联；测试用库层 `count({articleId})` 交叉核对（10.7、10.10）。
3. **区分不同次**：一次执行一行，按 `id` 倒序取「最近一次」，**旧行永不被更新或删除**。`trigger` 记录入口，`contentHash` 记录「这条结论对应哪一版正文」。
4. **可解释**：`statsJson`/`issuesJson`/`ruleJson` 三元快照——能回答「这次比上次少报一条，是稿子改了还是 `r:{赛道}` 配置改了」。

复用与不新增的判断：
- **复用**：`parseArticle`/`LintReport` 结构原样落库（不重新发明字段）；`db-json.ts` 的 `packJson/unpackJson` 约定；`logger`；既有的 Prisma 迁移体系。
- **不复用**：`Article.qualityJson`（单列历史不可追溯，且已被既有裁决标记为死字段教训）、`Article.note`（面向人的一句摘要）、`TaskRun`（任务级，非检查级；且 lint 可由人工在任意时刻触发，没有父任务）。
- **不新增**：通用事件总线/任务框架/版本平台/清理调度器。

---

## 4. 关键行为设计（含失败语义）

### 4.1 哪些执行会留痕，哪些不会

| 入口 | 留痕 | 理由 |
|---|---|---|
| `GET /api/articles/:id/lint`（改稿页「重新检查」） | ✅ `check` | 明确的用户动作 |
| `PUT /api/articles/:id/content`（保存正文） | ✅ `save` | 改稿节点，天然时间线锚点 |
| `pushArticleToDraft` 门禁（手动推送 + 调度器自动推送） | ✅ `push`（通过与被拦都记） | 业务判定时刻，最需要证据 |
| `GET /api/articles/:id/preview`（打开页面看一眼） | ❌ 只读，返回最近存档 | 否则历史会被 page_view 噪音淹没 |
| `writer.ts` repair 循环内部 | ❌ | 内部诊断信号，不是业务结论（见 §9-1） |
| 漫画产线 | ❌ | 正文是图片序列，不跑文章体检（维持原语义） |

### 4.2 结论本身零变化

`lintArticle()` 一行未改；落库的是它**原样返回**的报告。门禁仍以现算报告为准（`publisher.ts` 的 `if (!lint.ok)` 判断位置、条件、顺序均未变）——**本表是留痕，不是判定真源**，不存在「库里说通过就放行」的路径。

### 4.3 失败语义（不允许静默）

`recordLintRun` **不抛异常**（避免留痕失败把保存/推送搞挂），但一定返回 `saved:false + error` + `logger.error`；三个调用点都必须把它透出：

- 保存正文：正文已保存成功 → 不回滚、不改 500，响应带 `lintPersistError`，前端 `ElMessage.warning`「已保存并重新渲染，但体检结果未能存档：…」+ 面板常驻告警条。
- 手动检查：结论照常返回，前端提示「已重新检查，但结果未能存档（见面板提示）；刷新后不可追溯」。
- 推送门禁：不改变业务判定（该推还推、该拦还拦），日志 warn + 响应带 `lintPersistError`，前端提示。

口径刻意分成两句：**「体检做完了但没存档」≠「体检失败」**，不合并成一句「检查失败」，否则会让人怀疑结论本身。

### 4.4 过期判定（不把旧结论当现行结论）

预览返回 `lintRunStale = (存档.contentHash !== 当前正文 SHA-256)`。改过稿但没保存、或正文被其他路径（强调补全/AI 改写/接口）改动后，面板显示「存档已过期（正文已改）」，避免把历史结论当作此刻的判定。

---

## 5. 前端展示变化（仅改稿页，未新增页面/未改导航）

体检面板在原「结论标签 + 数字 + 问题列表」之上新增一行：

1. **存档行**：`最近存档：保存正文 · 2026-11-16 10:31:07 · 3 项不合规`（触发入口 + 时间 + 结论）；无记录时显示 `尚无存档记录`。
2. **存档已过期** 标签（`contentHash` 不一致时出现）。
3. **「重新检查」按钮**：调 `GET /:id/lint`，刷新结论并新增一条历史；**有未保存改动时先拦一下**（检查对象是已保存正文，避免「检查的和你看到的不是同一份」）。
4. **「历史 N 次」popover**：按时间倒序列出最近 20 条（时间 / 触发入口 / 通过或「N 错 M 提示」）。
5. **未存档告警条**：`体检结果未能存档：<原因>（结论仅本页可见，刷新后不可追溯）`。
6. 保存/推送后自动刷新历史，页面立即反映最新结果。

未做：文章列表页加体检列（需要聚合查询，与「最少代码」冲突，见 §9-4）、独立体检历史页、筛选/统计。

---

## 6. 测试命令与实际结果

全部经 T0 隔离运行器执行（固定 `wechat_pipeline_smoke` 库，run 前 `prisma migrate deploy` 重建、run 后清空；真实库前后指纹断言）。

| 命令 | 实际结果 |
|---|---|
| `npm run typecheck`（server） | **0 errors** |
| `npx vue-tsc --noEmit`（web，连跑两遍） | **0 errors** ×2 |
| `npm run build`（web） | **✓ built in 19.33s** |
| `npm run smoke:lint` | **通过 138 项**（原 116 + 新增 22）；`REAL-DB FINGERPRINT MATCH`；`CLEANUP ok` |
| `npm run smoke:style` | **全部通过（41 项断言）**（不降） |
| `npm run smoke:angles` | **ALL PASS（175 项）**（不降） |
| `npm run verify:smoke-iso` | **10/10 项通过**；`ISO-EMPTY tables=17/17 rows=0`（新表已计入空库证明） |

新增 22 条断言与授权 §五 9 项验证的对应关系：

| 授权要求 | 对应用例 | 结果 |
|---|---|---|
| 1 通过时能存能读 | 10.1（存档 ok/trigger）、10.2（读回含明细、指纹 64 位） | PASS |
| 2 有问题时结果与明细能存能读 | 10.3（ok=false、errorCount>0、issues 含 `sections`） | PASS |
| 3 多次检查历史与最新符合预期 | 10.4（条数 +1、首位=本次、旧记录 id 不变） | PASS |
| 4 保存失败有明确错误反馈 | 10.9（外键不存在 → `saved:false` + error，且不抛异常） | PASS |
| 5 关联正确不串数据 | 10.7（库层 A=基线+3 / B=基线+1）、10.10（删文章级联 1→0） | PASS |
| 6 规则结果与改造前一致 | 10.1（落库报告 ≡ `lintArticle` 直算）；116 条既有断言原样通过 | PASS |
| 7 不影响既有测试 | style 41 / angles 175 全绿（未改其断言，仅 smoke-isolated 表清单 +2 行） | PASS |
| 8 TS/Vue 类型与 Smoke | §6 表前四行 | PASS |
| 9 真实库前后指纹一致、零写入 | 每轮 `REAL-DB FINGERPRINT MATCH` + §7 独立复核 | PASS |
| 10 无真实 LLM/微信/发布调用 | §8 | PASS |

---

## 7. 真实业务库零写入证明

**改造前基线**（本阶段开工第一件事，只读复核）：
```
DB=wechat_pipeline  USER=wpc_app@127.0.0.1
OLD-SET SHA256 = 723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3
（16 业务表 + _prisma_migrations 的 COUNT+CHECKSUM TABLE 拼接哈希）
```
该值与 S4-2 报告登记的基线 `723a8027…` **完全一致** → 期间无人写入。

**改造后复核**（同一口径、同一脚本重算）：
```
OLD-SET SHA256 = 723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3   ← 逐字节相同
ArticleLintRun in business DB: ABSENT（迁移未部署，符合本阶段边界）
```
用户/会话/设置等非空表行数与校验和均未变（User 1、UserSession 1、Setting 15、StylePrompt 44、_prisma_migrations 4）。

**隔离库侧**：每轮 run 末尾打印 `[t0] REAL-DB FINGERPRINT MATCH（真实库零写入）`（`verify:smoke-iso` 共 10 项含 ⑨ 空库证明 + ⑦ 前后指纹一致）。

**说明（口径变化，不是漂移）**：`verify` 输出的业务库指纹为 `4becc576…`，与本报告基线不同——因为本阶段把 `ArticleLintRun` 加入了 `BUSINESS_TABLES`/`FINGERPRINT_TABLES` 清单，指纹串里新增了 `ArticleLintRun:absent` 一项。**在业务库侧该表不存在，故前后都记 `absent`，一致即 MATCH**（与 S4-1 部署前 TopicReview 的处理同款）。比对零写入必须用**同一表清单**，故此处以改造前 16 表口径的 `723a8027…` 为准。

**未执行**：`prisma migrate deploy`（业务库）、`prisma db push`、`migrate reset`、任何 DELETE/UPDATE。`prisma migrate dev` 也未运行（S1-2 已记录该命令在非交互环境一律被拒）。

---

## 8. 外部调用零发生证明

1. 子进程预载 `smoke-net-guard.mjs`：所有非登记端口的 axios/fetch/http/tls/net/dns/WebSocket/dgram/child_process 在 Node 层被拦（`verify:smoke-iso` ⑩ 13 个反向用例全 PASS）。
2. 推送用例只走到「体检门禁拦截」就返回（日志实证 `成稿体检未通过，已拦截推送`，`POST /api/articles/1/push -> 200 (32ms)`），**未进入 `WechatClient`**（真实推送需网络，网络已被封）。
3. 全程未配置/未调用任何 LLM：本阶段用例均为确定性纯函数 + 本地 HTTP，无 `chatComplete` 调用；`smoke:angles` 的扩库评分仍是既有 Mock 注入。
4. 未触碰其他项目数据库：仅在 `wechat_pipeline_smoke` 建表/清表，业务库只读，`wechat_pipeline_shadow` 未被本阶段使用。

---

## 9. 已知边界与未解决问题

1. **生成时刻（writer/planner）不留痕**：writer 的 repair 循环报告不进库，自动产出的草稿在「首次人工检查/保存/推送」之前没有体检记录。
   - 原因：writer 返回体不带报告，若在 planner 侧重算会出现「两处计算两个真源」的风险（规则来源/轨道名任一不一致就会记录到与实际修补不一致的结论）。
   - 正确做法（若需要）：`generateDraft` 增返回 `lint` 字段 + planner 落库（`trigger='write'`）——属扩 `write` 入口，需单独授权。
   - 现状不伪造：无记录即显示「尚无存档记录」，不回填、不拿 note 冒充。
2. **历史不自动清理**：按个人使用规模不做修剪（每篇每天几条，行级成本低）。若将来量级上升，建议按 `articleId` 保留最近 N 条（`id` 倒序 `skip` 后 `deleteMany`），无需新表。
3. **规则版本不落库**：只存 `checks/relax` 参数快照；`lint.ts` 的阈值/正则变更后，旧行仍是旧结论（这正是快照语义，但无法从行内分辨「哪些阈值变了」）。S3 已裁决 PromptVersion 不实施，故不在此硬造版本号。
4. **列表页未展示最近体检**：文章列表要显示「最近一次结论」需对每行做关联子查询/聚合；与「最少代码」相悖，且改稿页已覆盖主要场景（见 §5）。如需要可加 `Article` 侧冗余列，但会引入双写一致性问题，不建议。
5. **`GET /:id/lint` 是「读接口带写副作用」**：为兼容既有调用与冒烟断言（该端点语义已稳定），保留 GET；权限沿用 `data:view`（member 也会留下记录）。副作用仅为追加一行审计数据，不改变文章状态。若坚持 REST 纯度可改 POST，但会波及既有冒烟断言。
6. **`contentHash` 不认识「语义等价改动」**：改一个空格也算过期（偏保守，不会误报「未过期」）。
7. **Migration 已写好但未部署业务库**：业务库当前无 `ArticleLintRun` 表，**新代码在业务库运行时会因缺表而落库失败**（`recordLintRun` 会 `saved:false` + 明确错误，不会崩；但体检面板会一直显示「未能存档」）。**部署前不宜把本分支用于真实库日常使用**——部署需单独授权（§10）。

---

## 10. 是否需要业务库部署 / 部署说明（停等授权）

需要，但**本阶段未执行**。授权后按 S4-1 同款流程：

```bash
cd server
# 1) 身份核验（应输出 DATABASE()=wechat_pipeline / CURRENT_USER()=wpc_app@127.0.0.1）
#    用只读查询确认库名与账号后再动手
# 2) 部署（仅新增表，纯增量）
npx prisma migrate deploy
# 3) 部署后核验
npx prisma migrate status          # 期望：up to date
# 表结构：ArticleLintRun 11 列 + 1 索引 + 级联外键
# 数据：SELECT COUNT(*) FROM ArticleLintRun;  → 0（新表，不回填历史）
```

回滚：`DROP TABLE ArticleLintRun`（纯新增表，无其他表依赖它，业务代码在缺表时会降级为「未能存档」而非崩溃）。**不建议**用 `migrate resolve` 伪造状态。

---

## 11. Git 工作区状态与未提交文件清单

未 commit（遵授权）。`git status --short`：

```
 M docs/DEVLOG.md                      ← 本阶段追加（文件本身还带 S4-2 未提交条目）
 M server/prisma/schema.prisma          ← 本阶段
 M server/scripts/smoke-isolated.ts     ← 本阶段
 M server/scripts/smoke-lint.ts         ← 本阶段
 M server/src/api/routes/articles.ts    ← 本阶段
 M server/src/services/publisher.ts     ← 本阶段
 M web/src/api/index.ts                 ← 本阶段 + S4-2（混合文件）
 M web/src/types.ts                     ← 本阶段 + S4-2（混合文件）
 M web/src/views/ArticleEditView.vue    ← 本阶段
 M server/scripts/smoke-angles.ts       ← S4-1-HF1/R1/R2/S4-2 既有，未动
 M server/src/api/routes/angles.ts      ← S4-1-HF1/R1/S4-2 既有，未动
 M server/src/services/angles.ts        ← S4-1-HF1/R1/R2/S4-2 既有，未动
 M server/src/services/dedup.ts         ← S4-2 既有，未动
 M server/src/services/topic-review.ts  ← S4-1/R2/S4-2 既有，未动
 M web/src/views/TrackAnglesView.vue    ← S4-2 既有，未动
?? server/src/services/lint-store.ts                                    ← 本阶段新增
?? server/prisma/migrations/20261116120000_add_article_lint_run/        ← 本阶段新增
?? docs/restructure/S4-3-IMPLEMENTATION-REPORT.md                       ← 本报告（未跟踪）
?? docs/restructure/S4-1-HF1-IMPLEMENTATION-REPORT.md      ┐
?? docs/restructure/S4-1-HF1-R1-IMPLEMENTATION-REPORT.md    │
?? docs/restructure/S4-1-HF1-R2-IMPLEMENTATION-REPORT.md    │ S4-1/S4-2 阶段既有
?? docs/restructure/S4-1-MIGRATION-DEPLOY-REPORT.md         │ 未跟踪报告（未动）
?? docs/restructure/S4-1-PRE-MIGRATION-CHECK-REPORT.md      │
?? docs/restructure/S4-2-0-DEDUP-AUDIT-REPORT.md            │
?? docs/restructure/S4-2-IMPLEMENTATION-REPORT.md           ┘
```

`git diff --stat` 合计 15 文件 +2308/−85（含 S4-1-HF1/R1/R2/S4-2 的累计存量）。本阶段净改动：新建 2 处（lint-store.ts、迁移目录）+ 修改 9 文件。

---

## 12. 一句话结论

体检结论从「响应里的瞬时判定」变成「一次执行一行、可按篇追溯的事件」：**算得出来、存得下来、读得回来、失败说得清**；规则本体、门禁判定、创作/审核/排产/推送链路零改动，业务库零写入，Migration 写好待授权。
