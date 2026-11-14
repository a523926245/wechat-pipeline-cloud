# T1-A-DECISION-REPORT · 最终推荐方案、风险与待确认事项
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

> **⚠️ 已被取代（2026-11-13 晚）**：用户决策「本机 MySQL 8.0.30 为唯一开发数据库，未来测试与生产统一 MySQL」——
> 双库迁移架构（含本报告推荐的方案 C、SQLite 独立迁移链、自研 Runner）**整体作废归档**。
> 现行方案见 `T1-A-MYSQL-LOCAL-READONLY-REPORT.md` / `T1-A-SQLITE-DEPENDENCY-INVENTORY.md` /
> `T1-A-MYSQL-SWITCH-IMPACT.md` / `T1-A-T0-ISOLATION-COMPAT-PLAN.md` / `T1-A-PRISMA-MIGRATE-INIT-PLAN.md` /
> `T1-A-ROLLOUT-PLAN.md`。本文件仅作历史记录保留，其中「migrate resolve 仅登记」「db push 破坏性旗标」
> 「备份纸面不算」等语义结论仍被新方案引用。

> **性质**：T1-A 方案二次审核轮的收口文档（授权书 四）。本轮为纯分析与文档工作：
> **未执行任何数据库变更**（未跑 `db push` / `migrate dev` / `migrate deploy` / `migrate resolve`）、未改业务代码 / Prisma Schema / T0 四件套、未创建正式 migrations 文件、未进入 T1-B。
> 本轮新增文档五份：`T1-A-ARCHITECTURE-REVIEW.md`、`T1-A-BASELINE-REVISED.md`、`T1-A-BACKUP-RESTORE-REVISED.md`、`T1-A-MYSQL-READONLY-CHECK.md`、本文件。

---

## 1. 执行摘要

原方案（MySQL=Prisma Migrate + SQLite=db push +「结构指纹」等价验证）经重新评估后**修订**：推荐**方案 C「单一变更源 · 双独立迁移链 · 门禁执行」**——MySQL 用 Prisma Migrate 正式链；SQLite（含真实业务数据）建**独立轻量迁移链**（人审 SQL + journal 表），真实库全面禁用 `db push`；「结构指纹」口径升级为三级等价性验证。Baseline 修订为**登记型 + 双向比对硬门禁**（`migrate resolve` 只记账、不代表结构验证）；备份恢复给出 11 项实操验收标准（纸面不算通过）。MySQL 侧因无只读凭据，结构差异检查**未执行**，已备好可执行脚本包与账号方案。

---

## 2. 七问七答（授权书「四、最终汇报必须明确回答」）

### Q1 推荐采用哪一种双数据库迁移架构？

**推荐方案 C——「单一变更源 · 双独立迁移链 · 门禁执行」**：

| 组件 | 承载 |
|---|---|
| 唯一人工变更源 | `prisma/schema.prisma`（MySQL 真源）→ 生成器派生 `prisma/schema.sqlite.prisma`（禁手改） |
| MySQL 迁移链 | Prisma Migrate：`prisma/migrations/`（`0_init` 基线 → 正常 `migrate dev/deploy`） |
| SQLite 迁移链 | 独立轻量链：`prisma/sqlite-migrations/NNNN_*.sql` + journal 表 `_wpc_sqlite_migrations` + `scripts/sqlite-migrate.ts` runner（status/up/baseline）；迁移 SQL 由 `prisma migrate diff` 只读生成、**人工审核**（rename 类强制改写为数据保全式）后入库 |
| `db push` 适用面 | **仅一次性/隔离库**（T0 `dev.smoke-*.db`、演练副本）；真实 `dev.db` 与生产库禁止 |
| 跨库一致性 | 三级等价性验证：L1 构造性派生 / L2 新鲜度逐字节比对 / L3 各库↔各 schema 只读 drift diff |

备选路线（按用户决策切换）：**B1**（解冻 T0 一行后双 Prisma 链，远期最标准）；**A-加固**（拒绝自研代码时的最低线，须书面接受 SQLite 无审计历史缺口）。

### Q2 为什么比原方案更安全？

原方案（A）四个结构性缺口 vs C 的四堵墙：

| # | 原方案缺口 | C 的对策 |
|---|---|---|
| 1 | SQLite 真实数据上 rename/类型变更走 `db push`：要么被拒（上线卡死）要么过 `--accept-data-loss`（数据丢失面） | 变更通道=人审 SQL，可写「建新列→回填→删旧列」保全式；`db push` 从真实库路径整体移除 |
| 2 | SQLite 侧无逐次变更历史，误操作不可追溯 | journal 表全历史（applied_at + checksum），与 MySQL 链同级审计 |
| 3 | `db push --force-reset`（实测帮助："Resets the database"）等破坏面只有人防 | 破坏性入口收敛到一次性库；runner 无任何「重置」能力 |
| 4 | 「结构指纹」口径模糊，且跨 provider diff 官方不支持，原表述落不了地 | 三级等价性验证（构造性/新鲜度/实测 drift），每级有明确判据 |

共同底座不变：三方案回滚都靠备份恢复（Prisma 无 down migration）——故备份演练（11 项标准）是所有路线的前置条件，不构成选 A 的理由。

### Q3 MySQL 生产库还缺少哪些信息？

1. **本机 3306 身份定性**：Windows 服务 `MySQL`@`D:\Soft\MySql\mysql-8.0.30-winx64`（已查明），用途待您确认（开发自测？）；
2. **云端生产实例确认**：systemd 裸机还是 Docker 自托管？服务器与只读检查可达通道；
3. **实际结构 vs `schema.prisma` 完整差异**：**未执行**（无只读凭据）——`T1-A-MYSQL-READONLY-CHECK.md` §3 脚本包就绪，等 §2 二选一执行方式；
4. 生产库是否有手工热修、谁跑过 `db push`（无迁移历史可查，只能问询 + 实测反推）；
5. 备份现状（最近 mysqldump、是否验证过可恢复）；
6. 版本/字符集/引擎实况（期望 utf8mb4_unicode_ci，需实测确认）。

### Q4 Baseline 如何保证不会误判历史结构？

五道防线（`T1-A-BASELINE-REVISED.md` §5），任何一道不过即禁止登记：

- **D1** 0_init 取自**实测库**（`--to-schema-datasource`）而非 schema 想象；
- **D2** 0_init 与期望 DDL（`--to-schema-datamodel`）**双向 diff，未解释差异清零**（硬门禁）；
- **D3** `migrate resolve` = **登记-only**（CLI 原文 "Record … as applied"）——语义前置声明，登记动作永远不被当作结构修复；
- **D4** 登记前后原库**指纹三元组**（SHA-256/size/mtime）必须不变；
- **D5** 二次独立人工复核：information_schema 报告 vs 0_init 逐项对照（表/字段/类型/默认值/主键/索引/唯一/外键/字符集 9 项）。

### Q5 如何证明备份真正可以恢复？

不接受纸面（授权书原话）。`T1-A-BACKUP-RESTORE-REVISED.md` 定义 11 项实操验收：SQLite S1-S6（备份→完整性→行数→索引/结构→**实际恢复到隔离路径**→恢复件复验+三 smoke）、MySQL M1-M5（一致性 dump→隔离库恢复→结构/索引/行数比对→业务只读验证→失败恢复策略实测）。判据：每项「命令+完整输出+比对全等」三件齐才算通过；任一失败 → Baseline 步骤④不成立 → 禁止登记。恢复目标永远是隔离路径/一次性库，绝不覆盖 `dev.db`/生产库。当前 11 项**全部【未执行】**。

### Q6 T1-A 实施需要哪些用户授权？

| # | 授权项 | 说明 |
|---|---|---|
| a | 隔离库/副本上的**迁移演练** | 写 `var/tmp` 副本与一次性库（含 runner 失败注入演练） |
| b | **备份/恢复演练** | 读真实库 + 写隔离路径（S1-S6 / M1-M5） |
| c | 迁移承载物落地 | 方案 C：新增 `scripts/sqlite-migrate.ts` 与 `prisma/sqlite-migrations/`（非业务代码）；若选 B1：解冻 T0 一行（`smoke-isolated.ts:258`）+ `schema.sqlite.prisma` 迁目录 |
| d | **MySQL 只读检查执行** | 方式 A（DBA 建 `wpc_ro`）或方式 B（您自跑回传）；凭据不进聊天 |
| e | **Baseline 登记**（生产/真实库写操作） | `migrate resolve --applied 0_init` / journal `baseline`——**单独一次授权**，登记前五道防线全过 |
| f | 文档收敛 | `deploy/README.md` §四补门禁引用、`install.sh` 的 `ALLOW_DB_PUSH=1` 逃生口改为默认拒绝+警告（改文档，不改代码） |

以上每项**单点授权**；均不含 T1-B（TrackContract）及后续。

### Q7 当前还有哪些未解决风险？

| # | 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|---|
| R1 | MySQL 实际结构差异未知（可能有意外漂移/热修） | Baseline ②③ 返工，甚至触发改 schema | 只读检查先行（Q6-d）；差异清零门禁 D2 | 开放 |
| R2 | 生产历史全靠 `db push`，无历史可查 | 0_init 只能从实测反推，热修归属靠问询 | D1+D5；Q5-③ 问询清单 | 开放 |
| R3 | 自研 SQLite runner 质量风险 | 迁移执行错误→数据风险 | 最小实现+checksum+单事务+失败注入演练；备份演练前置 | 开放（选 B1 可消除） |
| R4 | `dev.db` 退役数据的业务处置（哪些保留/归档） | 不阻塞迁移机制；属业务决策 | 留待用户定；迁移机制按「全部保留」设计 | 挂起 |
| R5 | Prisma 5.22 老旧（v7 已改 CLI 语义：`--to-schema`更名、`--skip-generate` 移除） | 将来升级时命令口径漂移 | 锁定 5.22 口径写入文档；升级另立任务 | 可控 |
| R6 | `scripts/` 不在 tsc 覆盖（T0 遗留） | runner 类新代码无类型检查兜底 | runner 实现时自配 `tsc --noEmit` 检查片段或单测 | 可控 |
| R7 | T1-B/C/D 的 schema 增量未知，双链人审成本按「每变更一次」计 | 预期成本偏差 | 迁移 SQL 自动生成，人审只做增量 | 可控 |
| R8 | `ALLOW_DB_PUSH=1` 逃生口在文档收敛前仍可用 | 人防缺口 | Q6-f 收敛；在此之前真实库 db push 禁令写入所有相关文档 | 开放 |
| R9 | 本机 MySQL 与生产身份未定性前的误连风险 | 误把开发库当生产（或反之） | 连库命令执行前肉眼确认 URL（已写入两份文档）；Q1/Q2 确认 | 开放 |

---

## 3. 本轮执行边界自查（授权书 三、安全边界 12 条）

| # | 边界 | 遵守情况 |
|---|---|---|
| 1-2 | 不改业务代码 / Prisma Schema | 未改（仅新增 5 份方案文档） |
| 3 | 不创建正式 migrations 文件 | 未创建（0_init/`prisma/migrations` 均未动；期望 DDL 是对照参考件，暂存 `var/tmp` scratch） |
| 4-7 | 不执行 db push / migrate dev / migrate deploy / migrate resolve | 全部未执行（本轮只用 `migrate diff`/`migrate status`/`--help` 只读工具与探针） |
| 8-9 | 不修改/不删除/不重建任何真实数据库 | 未动；`dev.db` 指纹与 T1-A 只读轮一致（Track=6 / Article=12 只读点验） |
| 10 | 不改 T0 四件套及断言 | 未动 |
| 11 | 不进入 T1-B | 未进入 |
| 12 | 不擅自扩大范围 | 本轮产物=5 份授权书指定文档 |

## 4. 文档索引

| 文档 | 内容 |
|---|---|
| `T1-A-ARCHITECTURE-REVIEW.md` | A/B/C 六维对比、8 条实测事实（F1-F8）、三级等价性验证、推荐依据 |
| `T1-A-BASELINE-REVISED.md` | 登记型基线、八步门禁、D1-D5 防误判、0_init 口径对照 |
| `T1-A-BACKUP-RESTORE-REVISED.md` | S1-S6 / M1-M5 实操验收标准（全部【未执行】） |
| `T1-A-MYSQL-READONLY-CHECK.md` | 只读脚本包（9 项全覆盖）、两种凭据交付方式、身份决策树 |
| `T1-A-READONLY-REPORT.md`（前轮） | 事实盘点仍有效；其 §7-§9 方案以本轮四份文档为准 |

---

## 5. 停点声明

**本轮到此停止。** 等待您（及 ChatGPT）审核上述方案。未获实施授权前：不建 Baseline、不建迁移文件、不做任何数据库写操作；MySQL 只读检查亦等您选定凭据交付方式（Q6-d）后才执行。T1-B 未授权，不启动。
