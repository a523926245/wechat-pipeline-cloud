# T1-A-BASELINE-REVISED · Baseline 修订方案
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

> **性质**：T1-A 方案二次审核轮，纯方案文档。本轮未创建任何 migrations 文件、未执行 `db push` / `migrate dev` / `migrate deploy` / `migrate resolve`、未改任何真实库。本文所有步骤状态 = **【未执行】**，待实施授权后逐项实测。
> 修订对象：`T1-A-READONLY-REPORT.md` §7（原基线方案）与 `deploy/README.md` §四（既有配方）。**与本文冲突处以本文为准**。

---

## 1. 修订动因（三条硬事实）

1. **`migrate resolve` 只登记状态，不改结构、不代表验证通过。**
   Prisma 5.22 CLI 帮助原文（本轮实测）："Resolve issues with database migrations … **baseline** databases when starting to use Prisma Migrate on existing databases"、`--applied` = "**Record** a specific migration as applied"。它只是往 `_prisma_migrations` 插一行记录。**「登记了」≠「结构对了」**——结构合法性只能由独立的实测比对证明。
2. **两个库都没有迁移历史。** SQLite `dev.db` 无 `_prisma_migrations` 表（T1-A 只读报告实测）；生产 MySQL 历史结构同步靠 `db push`（deploy §四 / `ALLOW_DB_PUSH=1`），同样无历史。Baseline 是「从现实反推起点」，起点错了全链皆错。
3. **既有配方缺门禁。** `deploy/README.md` §四的 `--from-empty --to-schema-datasource` 配方语义是「读实测库结构」（正确方向），但没有配套的「实测 ↔ 期望」差异清零步骤，且 `--to-schema-datasource` 是**连库**命令（F4 语义，见 ARCHITECTURE-REVIEW §2）——执行前必须确认 `DATABASE_URL` 指向目标库，否则会连错库取结构。

---

## 2. Baseline 定义与三原则

**定义**：Baseline = 在**不执行任何 DDL** 的前提下，把「数据库当前真实结构」登记为迁移链的历史起点（MySQL：`prisma/migrations/0_init` + `migrate resolve --applied`；SQLite（方案 C）：`prisma/sqlite-migrations/0000_baseline.sql` + journal 登记）。

| 原则 | 内容 |
|---|---|
| **P1 登记型** | Baseline 迁移文件只描述现状、从不执行；结构合法性由实测比对（§3 步骤⑥）证明，不由 resolve/baseline 登记动作保证 |
| **P2 双向比对先行** | 0_init（实测结构）与 schema 期望 DDL 必须双向 diff，**未解释差异清零**才允许登记 |
| **P3 写操作逐个授权** | `migrate resolve`、`migrate deploy`、任何 DDL、journal 表写入，全部是「真实库写操作」，**每个动作单独获得用户授权**后才执行（授权书安全边界 8/9） |

---

## 3. MySQL 侧基线流程（八步门禁，每步产物 + 判据 + 状态）

| 步 | 动作 | 产物 | 通过判据 | 状态 |
|---|---|---|---|---|
| ① | **只读结构实测**（脚本包见 `T1-A-MYSQL-READONLY-CHECK.md` §3） | 结构快照报告（表/列/类型/默认值/主键/索引/唯一/外键/字符集/引擎 9 项全覆盖） | 报告完整、无凭据泄漏 | 【未执行】 |
| ② | **差异清单**：实测 vs 期望。`prisma migrate diff --from-url "mysql://wpc_ro@…/wechat_pipeline" --to-schema-datamodel prisma/schema.prisma --script`（只读） | 差异分类表【缺表/多表/列类型/默认值/索引/唯一/外键/字符集/引擎】 | 每条差异有归属分类，无「未识别」项 | 【未执行】 |
| ③ | **差异消化**：向前修复（fix-forward SQL，人审）或判定实测即合法（改 schema 走正常变更流）。无法安全回滚的变更一律向前修复并留档原因（授权书 三-1） | 批准记录（差异编号→处置→批准人） | 差异清单全部关闭 | 【未执行】 |
| ④ | **备份 + 恢复演练实测通过**（`T1-A-BACKUP-RESTORE-REVISED.md` M1-M5） | 演练留档 | M1-M5 全部真实通过（纸面不算） | 【未执行】 |
| ⑤ | **生成 0_init**：`prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`（连库读实测结构——**执行前肉眼确认 DATABASE_URL**）；同轮并行生成期望 DDL 对照件（`--from-empty --to-schema-datamodel`，零连接） | `0_init/migration.sql` + 期望 DDL 对照件 | 两件齐备；0_init 内容=实测结构 | 【未执行】 |
| ⑥ | **结构一致性验证（resolve 的硬前置门禁）**：0_init 与期望 DDL 双向比对（`--from-migrations prisma/migrations --to-schema-dataschema …` 或逐项人工复核清单 §5 D5） | 零未解释差异证明 | **任何未解释差异存在 → 禁止进入⑦** | 【未执行】 |
| ⑦ | **【单独授权点】登记**：`npx prisma migrate resolve --applied 0_init`（仅写 `_prisma_migrations` 一行；执行前后原库 SHA-256/size/mtime 指纹必须不变） | `_prisma_migrations` 截图/查询输出 + 前后指纹 | 指纹一致；status 显示 0 pending | 【未执行】 |
| ⑧ | **收尾验证**：`prisma migrate status`（期望 "Database schema is up to date"）→ `prisma migrate deploy` 空跑（期望 **0 条 SQL 执行**；此步是写命令，需在⑦授权中一并说明）→ 行数快照 + 只读业务验证 | 留档 | 全部符合期望 | 【未执行】 |

> **关键澄清（回应授权书「Baseline 安全性」）**：⑦ 的 `resolve` 只是记账。即使 ⑦ 执行成功，若 ⑥ 的比对被事后发现有误，正确动作是修正 0_init 文件后按 §7 路径重新登记，**而不是**认为「结构已被修复」。

---

## 4. SQLite 侧基线（按推荐方案 C 的 journal 链；若改选 B1/B2 则同门禁、载体换 `prisma migrate resolve`）

| 步 | 动作 | 判据 | 状态 |
|---|---|---|---|
| ① | 只读结构实测（T1-A 只读轮已做，复核即可）：15 表 / 36 索引 / sqlite_master dump | 与在库现状一致 | 【未执行（复核）】 |
| ② | 差异清单：`prisma migrate diff --from-url file:dev.db(副本) --to-schema-datamodel schema.sqlite.prisma --script`（只读） | 输出 "empty migration"（T1-A 已实测零漂移；实施期重测） | 【未执行】 |
| ③ | 差异消化（如有） | 清零 | 【未执行】 |
| ④ | 备份 + 恢复演练 S1-S6 通过 | 真实输出全过 | 【未执行】 |
| ⑤ | **生成 `0000_baseline.sql`**：内容为 `sqlite_master` 全量 DDL 快照（纯文档性，供考古）；journal 表 `_wpc_sqlite_migrations` 建表语句随 runner 首次 `baseline` 自动执行 | 文件入 `prisma/sqlite-migrations/` | 【未执行】 |
| ⑥ | 零漂移证明 + checksum 归档（`schema.sqlite.prisma` SHA-256 记入 baseline 记录） | diff 为空 | 【未执行】 |
| ⑦ | **【单独授权点】** `sqlite-migrate baseline`：仅向 journal 插入 `0000_baseline` 记录，**不执行 DDL** | 前后 `dev.db` 指纹（SHA-256/size/mtime）不变 | 【未执行】 |
| ⑧ | 三 smoke 全量（经 T0 隔离运行器）+ 行数快照 | 全绿、计数不降 | 【未执行】 |

**铁律**：真实 `dev.db` **永不** `db push`（含 `npm run sqlite:push`）；T0 的 `dev.smoke-*.db` 隔离库为一次性库，继续用 `db push` 创建属合法用法（`smoke-isolated.ts` 冻结不动）。

---

## 5. 防误判历史结构的五道防线（D1–D5）

| # | 防线 | 拦住什么 |
|---|---|---|
| D1 | 0_init **取自实测库**（`--to-schema-datasource`），不是从 schema 想象生成 | 「Baseline 描述了一个不存在的库」 |
| D2 | 0_init 与期望 DDL（`--to-schema-datamodel`）**双向 diff**，未解释差异清零 | 「实测与 Schema 不一致却被登记为合法」 |
| D3 | resolve/baseline = **登记-only** 语义在流程里前置声明；不给任何人「resolve 会修结构」的错觉 | 「登记成功=结构验证通过」的误读 |
| D4 | 登记动作前后原库**指纹三元组**（SHA-256/size/mtime）必须不变 | 「登记过程顺手改了库」 |
| D5 | **二次独立人工复核**：按 `T1-A-MYSQL-READONLY-CHECK.md` §3 的 information_schema 报告与 `0_init/migration.sql` 逐项对照（9 项覆盖清单） | 工具盲区（工具 diff 只覆盖 Prisma 可表达的特性；字符集/引擎/触发器等按报告核） |

---

## 6. 0_init 生成口径对照（修正 deploy/README §四的注记点）

| 命令 | 语义 | 连库? | 用途 |
|---|---|---|---|
| `migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script` | **实测库结构** | 是（只读） | 0_init 真源（baseline 的正确语义） |
| `migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` | schema 期望结构 | 否 | 期望 DDL 对照件（本轮已实证：321 行，零连接） |
| `migrate diff --from-url <目标库> --to-schema-datamodel prisma/schema.prisma --script` | 实测 → 期望漂移 | 是（只读） | 差异清单（步骤②） |

⚠️ 三条注记：

1. **`--to-schema-datasource` 连库**：跑之前必须确认 schema 的 `DATABASE_URL`（env）指向目标实例——这是 deploy §四原配方的隐含前提，本文显式化。
2. **跨 provider diff 不支持**（Prisma 官方原文）：不存在「MySQL schema 和 SQLite schema 一把 diff」的命令；等价性走三级验证（ARCHITECTURE-REVIEW §5）。
3. deploy/README §四原文保留可执行性，但 T1-A 实施时应在其前后补「⑥ 差异清零」与「④ 备份演练」引用（文档修订见决策报告 Q6-f）。

---

## 7. 失败场景与修正路径（全部需单独授权）

| 场景 | 处置 |
|---|---|
| ⑥ 发现未解释差异 | **停**。回 ②③ 差异消化；禁止带差异登记 |
| 0_init 文件内容写错（⑦ 已登记） | 修正文件后重新登记：Prisma 允许对记录做 `--applied`/`--rolled-back` 调整（`migrate resolve` 帮助原文 "reconcile hotfixes … with your migration history"）；全程留档；原库指纹仍须不变 |
| ⑧ `migrate deploy` 意外执行了 SQL | 事故：说明 ⑥ 有漏。立即按备份恢复预案处置（M5），复盘后重走门禁 |
| 登记后发现库里还有手工热修 | 视同差异：新增一个「热修对齐」迁移或向前修复 SQL，补登记，留档 |

---

## 8. 待实测清单（汇总，全部【未执行】）

- MySQL：步骤①–⑧ 全部未执行（缺只读凭据与实施授权）。
- SQLite：步骤①–⑧ 全部未执行（复核项①可先行，其余待授权）。
- 备份演练 S1-S6 / M1-M5：全部未执行（见 BACKUP-RESTORE-REVISED §4 状态表）。
- **本文不含任何「已通过」结论**——按授权书第六节，未实际执行的测试一律标记未执行。
