# S5-4 · 正式库应用层集成验证与功能收尾报告

- **日期**：2026-11-17 10:20（GMT+8）
- **执行库**：本机 MySQL `wechat_pipeline`（唯一业务库，非 smoke 库）
- **验证载体**：`server/scripts/s5-4-integration.ts`（新增，`npm run verify:s5-4`）
- **结论**：**A —— S5-4 核心集成验证通过，可以进入下一阶段。**
- **最终断言**：**152 项全通过（0 失败）**，测试数据清理后逐表行数与测试前基线**完全一致**。

---

## 1 环境信息

### 1.1 数据库身份（连接后立即断言，不符即中止）

| 项目 | 实测值 | 期望 | 结果 |
|---|---|---|---|
| `DATABASE()` | `wechat_pipeline` | `wechat_pipeline` | ✅ |
| `CURRENT_USER()` | `wpc_app@127.0.0.1` | `wpc_app@127.0.0.1` | ✅ |
| `VERSION()` | `8.0.30` | `8.0.30` | ✅ |
| `@@port` | `3306` | — | ✅ |

连接方式：**不依赖 `.env` 默认目标**（其仍指向 `wechat_pipeline_smoke`）。脚本读 `.env` 取既有凭据，
在内存里把库名段替换为 `wechat_pipeline`，拼好后**再次校验库名**，再以**进程级 `DATABASE_URL`** 注入本进程。
`.env` 未被修改；连接串未打印、未落盘。

### 1.2 Migration 状态

```
$ DATABASE_URL=<临时进程级> npx prisma migrate status
Datasource "db": MySQL database "wechat_pipeline" at "127.0.0.1:3306"
4 migrations found in prisma/migrations
Database schema is up to date!
```

- `_prisma_migrations` **5 行**，含 `20261116120000_add_article_lint_run`（`finished_at` 非空、未回滚、steps=1）。
- 无 `finished_at IS NULL AND rolled_back_at IS NULL` 的失败/未完成记录（脚本内断言）。
- `ArticleLintRun` 表存在于业务库（`information_schema` 断言，非推断）。
- 本轮**未执行任何迁移命令**（`migrate status` 为只读）。

### 1.3 API / scheduler 状态

| 服务 | 执行前 | 本轮操作 | 执行后 |
|---|---|---|---|
| API（8787） | 未运行（无 LISTEN） | 未启动常驻服务 | 仍未运行 |
| scheduler | 未运行（无本项目 node 进程） | 未启动 | 仍未运行 |

验证需要真实 HTTP 路由，因此脚本**在自身进程内**用 `createApp().listen(0, '127.0.0.1')` 起了一个随机端口
（日志实测 `127.0.0.1:5xxxx`），结束即关闭。**没有占用 8787/8797，没有影响任何既有进程。**

### 1.4 外部调用边界

- 微信：`WECHAT_API_BASE` 指向本地假上游（token / draft/add / 素材 三个端点），**零真实微信调用**。
- LLM：测试用 `LlmModel.baseUrl` 指向同一个假上游的 `chat/completions`，**零真实模型调用**。
- 假上游命中计数（最终轮）：`token=1, addDraft=5, upload=0, chat=6` —— 全部发生在 `127.0.0.1` 本地端口。

---

## 2 ArticleLintRun 真实数据库验证

### 2.1 写入（真实 `recordLintRun`，真实 MySQL）

| 检查项 | 结果 |
|---|---|
| `recordLintRun` 返回 `saved:true` + `run` | ✅ |
| 数据库确实新增 1 行（按主键回查命中） | ✅ |
| `articleId` / `trigger` 映射 | ✅ |
| `ok` / `errorCount` / `warnCount` 与报告一致 | ✅ |
| `contentHash` = `sha256(被检查正文)`（64 位 hex） | ✅ |
| `stats/rule/issues` 三列均写入 | ✅ |
| `statsJson` 快照数值与报告一致（h2Count=4, charCount=1736） | ✅ |

> 实测发现：JSON 列按项目约定存**字符串**（`db-json.ts`：写 stringify / 读 parse），
> 直接 `findUnique` 拿到的是字符串而非对象——读路径必须经 `unpackJson`。本轮据此修正了断言写法，
> 也顺带证明 `latestLintRun` 的反序列化是对的（见 2.2）。

### 2.2 读取

| 检查项 | 结果 |
|---|---|
| `latestLintRun` 取到刚写入那一条 | ✅ |
| 返回完整形态（`stats` / `issues[]` / `rule` 已反序列化） | ✅ |
| `createdAt` 为 ISO 字符串 | ✅ |
| `listLintRuns` 含该记录且排第一（新的在前） | ✅ |

### 2.3 多次记录（不覆盖 / 排序 / 数量 / 分页夹取）

同一篇文章连续写入 4 条（`check` / `save` / `check` / `push`）：

| 检查项 | 结果 |
|---|---|
| 历史共 4 条（**新记录不覆盖旧记录**） | ✅ |
| 按 `id` 严格倒序 | ✅ |
| 最新记录 = 最后一次写入（`trigger=push`） | ✅ |
| 最初那条仍在历史里（未被挤出） | ✅ |
| `latestLintRun` 随新写入前移 | ✅ |
| `limit=2` 生效且顺序正确 | ✅ |
| `limit=0` 被夹到 1（不返回空表） | ✅ |

### 2.4 文章删除与级联

- 测试文章写入 2 条体检记录 → 调用**真实删除接口** `DELETE /api/articles/:id` → 返回 200。
- 删除后该 `articleId` 的体检记录 **2 → 0**（外键 `ON DELETE CASCADE` 实际生效）。
- 文章本身不可再查（`findUnique` → null）。

> 只对本轮创建的测试文章做了删除，未触碰任何原有文章（业务库原有文章数本轮前后均为 **0**）。

---

## 3 文章业务流程验证

### 3.1 预览

| 场景 | 结果 |
|---|---|
| 预览 200，返回现算体检结论 | ✅ |
| 无历史时 `lintRun=null` / `lintRunStale=false` | ✅ |
| 有存档且正文未变 → 带回最近存档、`stale=false` | ✅ |
| 预览 `contentHash` = 存档 `contentHash` = `sha256(当前正文)` | ✅ |
| 正文被改（存档与正文不一致）→ `stale=true`，且**仍返回旧存档本身**（界面可显示「最近一次」） | ✅ |
| 重新检查后 → `stale` 复位 `false` | ✅ |
| 历史接口无记录 → `items: []` | ✅ |
| 空壳正文（`<p>还没写。</p>`）→ 预览 200、体检如实 `ok=false`、检查接口 200 且留痕 | ✅ |

### 3.2 读取失败降级（S5-2-HF1 复核，真实路由 + 真实降级代码）

把 `prisma.articleLintRun` 委托替换成抛 `P2021`（表不存在）的假实现，再走真实 HTTP 路由：

| 检查项 | 结果 |
|---|---|
| 存档读取失败时预览仍 **200**（不把主流程拖成 500） | ✅ |
| 降级后 `lintRun=null`（不伪造记录） | ✅ |
| 降级后 `lintRunStale=false`（没有存档就谈不上过期） | ✅ |
| 降级不影响现算体检（`lint` 仍在） | ✅ |
| 历史读取失败 → 接口 200 + `items: []` | ✅ |
| 恢复委托后存档读取恢复正常（证明降级只发生在故障期） | ✅ |

### 3.3 保存即体检

| 检查项 | 结果 |
|---|---|
| `PUT /api/articles/:id/content` 200，`lintRun.trigger=save` | ✅ |
| 正文落库且与留痕 `contentHash` 对应 | ✅ |
| 保存**不合规**正文：接口仍 200、正文确实已落库 | ✅ |
| 同次体检如实报 error（`ok=false`、`errorCount>0`） | ✅ |

### 3.4 改写后自动体检（LLM 全 Mock）

| 检查项 | 结果 |
|---|---|
| `POST /api/revise/preview` 200 且**不落库**（正文仍为原文） | ✅ |
| `POST /api/revise/articles/:id` 200，改写结果已保存 | ✅ |
| 自动体检留痕 `trigger=revise`，无 `lintPersistError` | ✅ |
| 体检对象是**改写后最终正文**（`contentHash` 与落库正文一致） | ✅ |
| 同时返回体检结论 + 提示语；`contentWechat` 由改写后正文现算 | ✅ |
| 改写出**不合规**正文：200、正文保存、体检如实报错、提示「推送时会被门禁拦下」 | ✅ |
| **存档失败 ≠ 体检失败**：`create` 抛错时仍 200、仍返回 `lint`、`lintRun=null` + `lintPersistError` 非空、正文已保存 | ✅ |

### 3.5 Lint 历史展示（接口 ↔ 前端静态对照）

未启动浏览器，本轮做的是**接口字段 ↔ 前端类型/模板逐项对照** + 真实接口响应核验：

| UI 元素（`ArticleEditView.vue`） | 依赖字段 | 接口实测 | 结论 |
|---|---|---|---|
| 「最近存档：{trigger} · {时间} · 通过/N 项不合规」 | `preview.lintRun.{trigger,createdAt,ok,errorCount}` | 均返回且类型正确 | ✅ 一致 |
| 「存档已过期（正文已改）」 | `preview.lintRunStale` | 改正文后 `true`，重检后 `false` | ✅ 一致 |
| 「历史 N 次」列表 + trigger 文案映射 | `GET /:id/lint-runs` → `items[]`（含 4 种 trigger） | 返回 `check/save/push/revise` 全部命中映射 | ✅ 一致 |
| 「这篇还没有体检记录」 | `items.length === 0` | 无记录时 `[]` | ✅ 一致（见 §8 观察项①） |
| 「体检结果未能存档」红色提示 | `lintPersistError` | 存档失败用例确实非空 | ✅ 一致 |

---

## 4 推送门禁验证（全 Mock，零真实微信调用）

| # | 验证项 | 实测 | 结果 |
|---|---|---|---|
| 1 | 没有 Lint 记录时的处理 | 正文合格 → 门禁**现算**后放行，并新增 `trigger=push, ok=true` 留痕 | ✅ |
| 2 | 最新 Lint 不通过 → 阻止推送 | `ok=false, reason=lint_failed`，`addDraft` 零调用，`status` 仍 `draft`，`mediaId/pushDate` 仍空 | ✅ |
| 3 | 最新 Lint 通过 → 进入后续推送 | `ok=true`，写入 `mediaId/pushDate`，`status=pushed` | ✅ |
| 4 | 新正文产生后旧 Lint 不被当最新 | 先存一条 `check:ok=true`，再改正文为不合规 → 推送被 `lint_failed` 拦下；历史里同时存在「通过(check)」与「拦下(push)」两条 | ✅ |
| 5 | 已有 `mediaId`/`pushDate` 拒绝重推 | 两字段都有 → `already_pushed`；**只有 `pushDate`** → 同样 `already_pushed`；两种情形 `addDraft` 零调用、字段一字未改、不产生 `TaskRun` 流水 | ✅ |
| 6 | 同一 `articleId` 并发推送 | 两次并发 → 恰好一次成功、一次 `reason=pushing`，`addDraft` 只 +1 | ✅ |
| 7 | 推送失败不覆盖已有推送事实 | 见下方说明 | ✅（口径见下） |

**关于第 7 项的口径（诚实记录）**：`hasPushTrace()` 守卫在 `pushOnce` **最前面**，因此「已有推送痕迹 + 本次推送失败」
这条路径在正常调用下**不可达**——系统根本不会为已送达的文章再发起一次外呼。本轮在真实库验证的是这个**守卫优先级**本身：

- 有推送痕迹 + 账号凭据被改成 `invalid` → 仍返回 `already_pushed`（事实判断优先于凭据校验），字段未改。
- 代码层的第二道保险（`!hasPushTrace` 才降级 `failed`）由 S5-1 `smoke:push` 的 B2 用例直接覆盖（已通过），
  本轮**未在真实库强行制造该竞态**（需要并发改库打断推送中的文章，产生的价值低于风险）。
- 同时验证了可达的失败路径：首次推送失败（40164）→ `status=failed`、`mediaId/pushDate` 仍空、
  `TaskRun` 记 `errorCode=40164`；修好后**重试成功**（失败不产生伪推送事实，因此不会被误判为「已推送过」）。

**附带验证**：封面配了但文件不存在 → 仍推成草稿并**显式**返回 `coverMissing=true`，素材上传零调用（不静默）。

---

## 5 回归测试

### 5.1 业务回归（真实库 + 真实路由，24 项断言）

| 流程 | 实测 | 结果 |
|---|---|---|
| 文章新增 / 列表 / 详情 / 编辑 / 删除 | `POST/GET/PUT/DELETE` 全部按预期（201/200） | ✅ |
| 选题审核门 | 候选选题直接建稿 → **400**（审核门生效） | ✅ |
| 审核状态机 | `candidate → approved` 成功；`approved → approved` → **400**（终态） | ✅ |
| 建稿即占题 | 建稿后 `used=true`、`usedByAccountId=本账号`；同题重复建稿 → **409** | ✅ |
| Angle 回收（三重闸门） | 未推送文章删除后选题 `used=false` 归还；已推送文章可删（不归还，防同题重写） | ✅ |
| 选题去重 | 同内容再新增 → **400**（L0 判重命中 100%） | ✅ |
| 排产创建 | `POST /plan/trigger count=2` → 生成 2 篇草稿、2 条选题被占用、`TaskRun(write)=success`、文章 `angleId` 非空 | ✅ |
| 排产无题 | 新赛道无 approved 选题 → `created=0` + 文案含「角度池已空」+ **零 used 泄漏** | ✅ |
| Lint ↔ 推送门禁衔接 | 见 §4 第 4 项 | ✅ |
| 漫画产线不受影响 | 漫画文章 `GET /:id/lint` → `lint=null, lintRun=null`；历史 → `[]`（不套文章规则） | ✅ |

> 说明：`docs/` 里「排产失败补偿」的**补偿分支**（`releaseReservedAngles`）在 Mock 下难以自然触发——
> `generateDraft` 对「未绑定/停用/结构不合」都回退骨架草稿而不抛错。本轮覆盖的是**可达路径**：
> 无题时不预留、不泄漏（`used` 计数为 0）；补偿逻辑本身由 S4-4-1 的实现与 `smoke:bulk` 覆盖，本轮不重复造竞态。

### 5.2 静态与针对性测试（真实输出）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（server） | **0 错误** |
| `npm run build`（web，含 `vue-tsc --noEmit`） | **✓ built in 28.20s** |
| `npm run test:lint-store` | **ALL PASS（41 项）** |
| `npm run verify:s5-4` | **ALL PASS（152 项）** |

### 5.3 本轮**未执行**的旧脚本（按令）

`smoke:lint` / `smoke:style` / `smoke:angles` / `smoke:bulk` / `smoke:push` / `verify:smoke-iso` 全部未跑。
原因：它们经隔离 runner 运行，会在每轮前后对**真实业务库**做 COUNT/CHECKSUM 指纹读取，
本轮明确要求「不再反复执行 Smoke / Shadow / Fingerprint 验证」，故不重复。它们的既有结论（S5-1 各 target 全绿）未被本轮改动破坏——
本轮**没有修改任何业务代码**（见 §7 变更清单）。

---

## 6 测试数据清理

### 6.1 创建与清理数量（最终轮）

| 实体 | 创建 | 清理 | 结果 |
|---|---|---|---|
| `Track` | 2 | 2 | ✅ |
| `TrackPipeline` | 1 | 1 | ✅ |
| `OAAccount` | 2 | 2 | ✅ |
| `LlmModel` | 1 | 1 | ✅ |
| `ModelBinding`（revise / write） | 2 | 2 | ✅ |
| `Angle` | 3 | 3 | ✅ |
| `TopicReview` | 3 | 3 | ✅ |
| `Article` | 17 | 17 | ✅ |
| `ArticleLintRun` | 18 | 18 | ✅ |
| `TaskRun`（按文章 / 按账号） | 4 / 2 | 4 / 2 | ✅ |
| `WechatToken` | 1 | 1 | ✅ |
| `Setting` 的 `style_variant_cursor` 行 | 1 | 1 | ✅（见 6.3） |

清理方式：**全部按主键精确删除**（`{ id: { in: [...] } }` / `articleId in [...]`），顺序遵守外键依赖（先子后父），
未使用任何模糊条件批量删除，未触碰原有账号 / 文章 / 选题 / 配置 / 用户。

### 6.2 逐表行数比对（测试前基线 vs 清理后）

```
article 0→0   articlelintrun 0→0   taskrun 0→0   angle 0→0   topicreview 0→0
account 0→0   track 0→0            trackpipeline 0→0        llmmodel 4→4
modelbinding 0→0   wechattoken 0→0   comicpanel 0→0          setting 16→16
styleprompt 44→44  user 1→1         usersession 1→1          _prisma_migrations 5→5
```

**17 张表逐表一致，零遗留**（脚本内断言，不一致即失败）。另按 `s54` 标识二次复查：
`track / account / article / model / binding` 命中数均为 0。

### 6.3 本轮真实发现与修正：排产会写系统配置行（`Setting.style_variant_cursor`）

这是本轮唯一「严格来说越界」的写入，**已发现、已定位、已恢复**，如实记录：

- **现象**：第一次跑通排产后，`Setting` 行数 **16 → 17**（与 S5-3B-2 记录的 16 不一致）。
- **定位**：新增的那一行是 `style_variant_cursor`，内容为 `{"S5-4验证赛道-xxx":2}` ——
  `writer.ts → pickVariants → nextVariantCursor()` 每写一篇就 `upsert` 一次（**产品既定行为**，用于标题/结构/篇幅变体轮换）。
  键是**赛道名**，因此只影响本轮测试赛道的游标，未触碰任何真实赛道的轮换位置。
- **风险**：「逐表行数比对」在**首次**能发现它（16→17），但后续轮次只是 **UPDATE 不改行数**，
  所以仅靠行数比对会漏——这正是它第一次被漏掉的原因。
- **处置**：
  1. 先严格校验「该行内所有键都是本轮测试赛道」，确认无他人数据后删除（`setting` 回到 16）；
  2. 脚本增加**快照 + 恢复**：跑前记录该行原值，跑后在清理阶段写回；原本不存在就删除；
  3. 新增断言「变体游标行已恢复/清除（不留下测试赛道键）」。
  最终轮实测：`variantCursor` 删除 1 行，`setting` **16→16**，断言通过。

---

## 7 Git 状态

| 项目 | 值 |
|---|---|
| 分支 | `feature/open-source-readiness` |
| HEAD | `b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`（`S4-5: per-track angle forms and review rule alignment`） |
| 本轮新增 | `server/scripts/s5-4-integration.ts`、本报告 `docs/restructure/S5-4-INTEGRATION-VALIDATION-REPORT.md` |
| 本轮修改 | `server/package.json`（+1 行 `verify:s5-4`）、`docs/DEVLOG.md`、`CHANGELOG.md` |
| 本轮未改 | **任何 `server/src/**` 业务代码、Schema、Migration 文件、`.env`、web 源码** |
| Git 写操作 | **无**（未 add / commit / push / reset / checkout / stash） |

工作区仍含此前几轮未提交的改动（`lint-store.ts`、`publisher.ts`、`revise.ts`、`angles.ts`、`web/src/types.ts`、
`ArticleEditView.vue`、四个 smoke 脚本、S4-5-S3 / S5-3B-1 / S5-3B-2 报告等），本轮**原样保留**，未做任何提交或丢弃。

---

## 8 未修复的观察项（P3，均非阻塞）

### ① 读降级与「本来就没有记录」在界面上不可区分

- **事实**：S5-2-HF1 让 `latestLintRun` 失败返回 `null`、`listLintRuns` 失败返回 `[]`（降级但不静默）。
  但降级后接口字段与「从未检查过」**完全一样**，前端因此显示「这篇还没有体检记录 / 无存档」。
- **影响**：数据库抖动或表缺失时，运维看到的是「没有记录」而不是「读取失败」，日志里有 warn 但界面无提示。
- **为什么本轮不改**：最小修复需要改 `latestLintRun/listLintRuns` 的返回契约（例如返回 `{ run, readFailed }`）
  或新增 `lintRunReadFailed` 字段，属**接口契约变更**，牵动 3 个调用方 + 41 项既有单测。
  按「不增加不必要抽象 / 不改已确认规则」的边界，本轮只登记，建议后续作为独立小任务处理。
  风险等级：**低**（仅影响提示文案准确性，不影响门禁与留痕）。

### ② `.env` 默认目标仍是 smoke 库（历史遗留，非本轮引入）

- 任何本地 `npm run dev` / `npx prisma ...` 不加进程级 `DATABASE_URL` 时，**默认连的是 `wechat_pipeline_smoke`**。
- 本轮全部数据库操作都显式指定了 `wechat_pipeline`；`.env` 按授权未修改。
- 建议：日常开发脚本或 `.env.example` 里加显著提示，或把默认目标改成业务库（需单独授权）。

### ③ 进程内防重的多进程边界（已知设计边界）

- 并发防重靠 `publisher.ts` 的进程内 `Map`，**单进程够用**；多进程/多实例部署需加数据库级占位。这是 S5-1 已登记的边界，本轮未改。

---

## 9 最终结论

**A：S5-4 核心集成验证通过，可以进入下一阶段。**

依据（全部为真实库 + 真实代码路径的实测结果）：

1. `ArticleLintRun` 在正式库**写、读、历史、级联删除**全部正确，字段映射与 JSON 快照口径一致（19 项断言）。
2. 文章预览 / 保存 / 改写后的体检与留痕闭环成立；存档失败、体检失败、读取失败三种故障**互不冒充**（47 项断言）。
3. 推送门禁七项全部成立：现算为准、stale 不被采信、重复与并发被拦、失败不伪造事实、封面缺失显式暴露（39 项断言）。
4. 原有流程（文章 CRUD、选题审核门、占题与回收、去重、排产、漫画产线隔离）无回归（24 项断言）。
5. 测试数据**零遗留**：17 张表行数与基线逐一相等，变体游标行已恢复。
6. 未改任何业务代码 / Schema / Migration / `.env`，未执行 Git 写操作，未调用真实 LLM / 微信 / 发布。

**遗留**：§8 三项观察项（均 P3，不阻塞投入使用）。
下一阶段建议：把 §8① 作为独立小任务（读失败可见化），并按 S5-4 的脚本形态把「真实库集成验证」固化为发布前检查项。
