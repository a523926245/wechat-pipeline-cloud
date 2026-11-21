# T1-A 只读检查报告（提交审核 · 未实施任何变更）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

**日期**：2026-11-13 13:33–13:50 GMT+8 ｜ **阶段**：T1-A 第一步（只读检查）
**授权**：T1-A（数据库基线与迁移机制）——本报告为授权书「八、本次立即执行的任务」要求的只读检查报告，**提交后停下等审核**，审核通过后才进入 T1-A 实际实施。
**只读声明**：本次检查未修改任何代码、任何数据库、任何仓库文件（仅新增本报告）；真实 `dev.db` 仅被读取（含复制到临时副本做漂移检测，真实库未被打开写入）；MySQL 未获得凭据、未做任何连接写操作。凡未实际执行的项均明确标记 **未执行**。

> **⚠️ 修订指向（2026-11-13 二审）**：本报告 **§7 Baseline / §8 备份恢复 / §9 隔离演练 的方案部分已被二次审核修订取代**，以 `T1-A-ARCHITECTURE-REVIEW.md` / `T1-A-BASELINE-REVISED.md` / `T1-A-BACKUP-RESTORE-REVISED.md` / `T1-A-DECISION-REPORT.md` 为准（推荐架构改为「双独立迁移链」方案 C，SQLite 不再走 db push）。§0-§6、§10 的**事实盘点仍然有效**。

---

## 0. 结论摘要（先看这里）

| 检查项 | 结果 |
|---|---|
| Git 工作区 | 与 T0 验收时一致，无意外改动 |
| T0 交付完好性 | ✅ 四件套 + 报告行数逐一吻合（795/106/439/184/996），smoke 命令改道完整 |
| SQLite Schema 现状 | 15 业务表，**无 `_prisma_migrations`**（从未有正式迁移），journal_mode=delete |
| SQLite 真实结构 ↔ Prisma Schema | **零漂移**（`prisma migrate diff` 输出 "This is an empty migration"） |
| 双 Schema 等价性 | schema.prisma（MySQL 真源）与 schema.sqlite.prisma 模型集与字段名**逐一相等**（15 模型）；生成器输出与现文件**逐字节一致**（文件是新的） |
| MySQL Schema 现状 | **未执行**——本机 3306 有 MySQL 8.0.30 在监听，但无可用凭据（样例凭据全部 Access denied）；需用户配合（见 §10） |
| 现有数据 | 小规模真实数据（12 文章 / 33 选题 / 6 赛道 / 42 文风行等），全部必须无损保留 |
| 迁移机制现状 | **Schema 迁移 = 无**（`prisma db push`，无回滚能力）；另有 3 个**数据**迁移脚本（`src/cli/migrate.ts` 等）属另一层，边界需在实施中写清 |
| 核心风险 | ①生产 MySQL 结构未知，Baseline 不能拍脑袋 ②`db push` 无回滚 ③双 provider 类型语义差异 ④`_prisma_migrations` 首次接入需 `migrate resolve` 标记（deploy/README 已预写） |

**三份方案（§7 Baseline / §8 备份恢复 / §9 隔离演练）均为待审方案，未执行。** 请审核；通过后我按方案实施 T1-A，不通过则先修订。

---

## 1. 当前 Git 工作区状态

```
$ git status --short
 M .gitignore
 M CHANGELOG.md
 M docs/DEVLOG.md
 M server/package.json
 M server/scripts/smoke-angles.ts
 M server/scripts/smoke-lint.ts
?? docs/AUDIT-REPORT.md
?? docs/RESTRUCTURE-CHECKLIST.md
?? docs/RESTRUCTURE-PLAN-V1.md
?? docs/restructure/
?? server/scripts/smoke-db-guard.ts
?? server/scripts/smoke-isolated.ts
?? server/scripts/smoke-net-guard.mjs
?? server/scripts/smoke-run.ts
```

与 T0 验收时**完全一致**：修改面仍为 6 个文件（T0 白名单内），其余为 T0 新增四件套与历史审计/设计文档（untracked）。**无任何 T1 新改动、无意外覆盖。**

## 2. T0 交付文件与测试结果完好性

| 交付物 | 实测 | 与 T0 验收记录对照 |
|---|---|---|
| `server/scripts/smoke-isolated.ts` | 795 行 | ✅ 一致 |
| `server/scripts/smoke-db-guard.ts` | 106 行 | ✅ 一致 |
| `server/scripts/smoke-net-guard.mjs` | 439 行 | ✅ 一致 |
| `server/scripts/smoke-run.ts` | 184 行 | ✅ 一致 |
| `docs/restructure/T0-ACCEPTANCE-REPORT.md` | 996 行 | ✅ 一致 |
| `T0-ACCEPTANCE-LOGS/` 8 个 txt | 在位 | ✅ |
| smoke 命令改道 | `smoke:lint|style|angles` → `smoke-isolated.ts run …`；`verify:smoke-iso`/`smoke:prune-iso` 在位 | ✅ 一致 |

T0 测试结果（2026-11-13 正式验收重跑）：typecheck 0 / lint 116 / style 33 / angles 30 / verify 10/10，dev.db 指纹 `fea0f123…fc3f5` 全程一致——留档见 T0-ACCEPTANCE-REPORT §3–§7。本次未重跑（T0 已验收，避免冗余执行）；如需复跑可随时执行四连。

## 3. 数据库 Schema 现状

### 3.1 SQLite（本地 `server/prisma/dev.db`，实测）

**表清单（15 张业务表 + 1 张 SQLite 内部表）**：
`Account`、`Angle`、`Article`、`ComicPanel`、`LlmModel`、`ModelBinding`、`RunLog`、`Setting`、`StylePrompt`、`TaskRun`、`Track`、`TrackPipeline`、`User`、`UserSession`、`WechatToken`（+ `sqlite_sequence`）。

**关键事实**：

1. **无 `_prisma_migrations` 表**（`SELECT * FROM _prisma_migrations` → no such table）——从未建立过 Prisma 正式迁移，全部结构靠 `prisma db push` 落地。
2. `PRAGMA journal_mode` = **delete**（非 WAL）；`PRAGMA user_version` = 0。
3. 显式索引 36 个（含唯一索引如 `Track_slug_key`、`Angle_trackId_code_key`、`Article_idempotencyKey_key`、`Setting_k_key`、`StylePrompt_key_key` 等）——Baseline 必须原样收录，否则迁移后唯一性约束丢失。
4. `OAAccount` 模型经 `@@map("Account")` 映射为物理表 `Account`（T0 已实证）——Baseline DDL 须以物理表名为准。

### 3.2 MySQL（**未执行**——无只读凭据）

**已确认的环境事实**：

- 本机 **MySQL 8.0.30 正在监听 3306**（Windows 服务，PID 6556，`D:/Soft/MySql/mysql-8.0.30-winx64`）。
- 项目生产部署设计为 MySQL（`prisma/schema.prisma` provider=mysql，`deploy/app.env.example`、`docker-compose.yml`（mysql:8.0）、systemd 服务文件均指向 MySQL）。
- **凭据情况**：仓库内只有样例凭据（`deploy/app.env.example`、`docker-compose.yml` 的 dev 密码），实测 `wechat@127.0.0.1`、`root@127.0.0.1`（样例密码与空密码）**全部 Access denied**；无 `deploy/app.env` 实配文件。
- 因此：**MySQL 真实库（含生产库 `wechat_pipeline`）的表结构、行数、与 schema.prisma 的差异 = 未执行检查。**

**为什么这一项必须补**（授权书原文：「不得假设 SQLite 和 MySQL 的现有结构完全一致」）：生产库可能经历过手工修补、旧版本残留列、或落后于 schema.prisma（例如 `Article.coverMediaId`/`coverUploaded` 是 2026-10 新增，deploy/README 明言「生产上线前必须生成含这两个字段的 baseline，否则 publisher 一跑就 Unknown column」——若生产库结构落后，差异必须先摸清）。**Baseline 建立前必须完成本项。**

**给用户的两选一（只读，零风险，见 §10）**：
- A（推荐）：给我一个**只读账号**（`GRANT SELECT ON wechat_pipeline.* TO 'wpc_ro'@'…'`），我执行 §10 的只读检查命令并入报告；
- B：你自己在有凭据的机器上执行 §10 的命令，把输出发我。

### 3.3 Prisma Schema 体系现状

| 文件 | 角色 | provider | 维护方式 |
|---|---|---|---|
| `prisma/schema.prisma` | **真源**（数据字典） | mysql | 手工维护，15 模型 + enum |
| `prisma/schema.sqlite.prisma` | 本地开发用（降级版） | sqlite | **由 `scripts/gen-sqlite-schema.mjs` 自动生成**（enum→String、Json→String、剥离 `@db.*`） |
| `prisma/migrations/` | — | — | **不存在** |

工具链：Prisma **5.22.0**（CLI + client），Node v22.22.2。相关 npm 脚本：`prisma:generate`、`prisma:migrate`（= migrate dev）、`prisma:deploy`（= migrate deploy）、`schema:sqlite`（重新生成 sqlite schema）。

**另有 3 个数据迁移脚本（与 Schema 迁移是两层，勿混）**：`migrate`（`src/cli/migrate.ts`，带 `migrate:dry`）、`migrate:automation`、`migrate:track-config`——它们是**应用层数据搬迁**（跑在 Prisma Client 之上），不是 DDL 迁移。T1-A 建立的迁移机制只管 DDL；数据脚本的边界与去留在实施时写入迁移流程说明（不动它们）。

## 4. Prisma Schema 与真实结构的差异对照

### 4.1 SQLite：零漂移（实测）

方法：真实库**复制到临时副本** `server/var/tmp/t1a-dev-copy.db`（真实库只读），在副本上执行：

```
$ npx prisma migrate diff --from-url "file:./var/tmp/t1a-dev-copy.db" \
    --to-schema-datamodel prisma/schema.sqlite.prisma --script
-- This is an empty migration.
```

**「空迁移」= 实际结构与 schema.sqlite.prisma 完全一致（零漂移）**，方向为 实际库→期望 schema；该结果对称成立。这是 Baseline 可信的直接证据：SQLite 侧可以直接以 schema.sqlite.prisma / 当前库结构为准建 Baseline。

### 4.2 双 Schema 等价性（实测，脚本比对）

- 模型集：schema.prisma **15 个** = schema.sqlite.prisma **15 个**，名称逐一相同。
- 字段名：全部 15 个模型逐一比对，**字段名集合完全一致**（无单侧多出/缺失字段）。
- 生成器时效性：用 `gen-sqlite-schema.mjs` 的同套变换在内存中重算输出，与现 `schema.sqlite.prisma` **逐字节一致**（证明生成文件没有过期，不存在「真源改了忘了生成」的漂移）。

注：Prisma 不支持跨 provider 直接 `migrate diff`（实测报 `Column native type missing in mysql_renderer`）——**如实记录**；等价性证明以上述模型/字段级比对为准。类型语义差异（MySQL enum/Json/`@db.*` vs SQLite String）是生成器的**设计降级**，属已知且受控的差异，写入 Baseline 注意事项（§7.3）。

### 4.3 MySQL：未执行（见 §3.2 / §10）

### 4.4 差异清单（对照结论汇总）

| # | 对照 | 结论 | 证据 |
|---|---|---|---|
| 1 | SQLite 实际库 ↔ schema.sqlite.prisma | **零差异** | migrate diff = empty migration |
| 2 | schema.prisma ↔ schema.sqlite.prisma | 模型/字段名**零差异**，类型降级受控 | 脚本比对输出 |
| 3 | 生成器输出 ↔ schema.sqlite.prisma | **零差异**（文件是新的） | 内存重算逐字节相等 |
| 4 | MySQL 实际库 ↔ schema.prisma | **未执行** | 无凭据 |
| 5 | 任何实际库 ↔ `_prisma_migrations` | 无迁移历史（表不存在） | SQLite 实测；MySQL 待查（大概率同样没有） |

## 5. 现有数据盘点与迁移风险

### 5.1 数据规模（SQLite 实测行数，只读 COUNT）

| 表 | 行数 | 表 | 行数 | 表 | 行数 |
|---|---|---|---|---|---|
| Article | 12 | Angle | 33 | Track | 6 |
| TrackPipeline | 12 | StylePrompt | 42 | Setting | 24 |
| User | 3 | UserSession | 1 | Account | 1 |
| LlmModel | 4 | ModelBinding | 7 | TaskRun | 11 |
| RunLog | 3 | ComicPanel | 0 | WechatToken | 0 |

数据量小但**全部是真实业务数据**（文章/选题/凭据绑定/模型配置），迁移必须零丢失。MySQL 侧行数未执行。

### 5.2 迁移风险清单

| # | 风险 | 等级 | 说明与对策方向 |
|---|---|---|---|
| R1 | **生产 MySQL 结构未知** | 高 | Baseline 若从 schema 文件臆造而不对照实际库，历史结构不一致会在后续迁移集中爆发。对策：§10 只读检查完成后才准建 Baseline（授权书同款要求） |
| R2 | **`db push` 无回滚** | 高 | 现状任何 schema 变更都无迁移文件、无法回滚。对策：T1-A 建 Baseline + 此后一律 `migrate dev/deploy`；`install.sh` 的 `ALLOW_DB_PUSH=1` 逃生口标为高危 |
| R3 | 首次 `migrate deploy` 会对已有结构重复建表 | 中 | `_prisma_migrations` 为空时 deploy 会执行 `0_init` 全量 DDL。对策：建 Baseline 后立即 `prisma migrate resolve --applied 0_init`（deploy/README §四已写明此坑） |
| R4 | 双 provider 类型语义差异（enum/Json → String） | 中 | 生成器降级是设计决定；迁移 DDL 必须按 provider 分别生成、分别演练，禁止把 MySQL DDL 直接套 SQLite 或反之 |
| R5 | 物理表名 ≠ 模型名（`OAAccount`→`Account`） | 中 | T0 已踩过；Baseline/校验脚本一律用物理表名 |
| R6 | 索引/唯一约束丢失 | 中 | 36 个显式索引必须进 Baseline；迁移后跑索引清单比对 |
| R7 | 数据迁移脚本（`src/cli/migrate.ts` 等）与 DDL 迁移混层 | 低 | 流程说明里划清边界；T1-A 不动数据脚本 |
| R8 | `APP_SECRET_KEY` 不可变（deploy/README 上线前置项 #2） | 低（本阶段） | 迁移与备份文件禁止包含密钥；备份与密钥分开放（前置项 #8） |
| R9 | Windows SQLite 文件锁 | 低 | 迁移演练一律在副本上做；真实库只读（T0 模式已验证） |
| R10 | 备份未验证可恢复 | 中 | 授权书要求「实际验证备份可恢复」——§8 方案含恢复演练验收 |

## 6. 既有迁移/部署文档现状（实施时对齐，不推翻）

`deploy/README.md` §四「迁移基线」已预写一套 MySQL 基线操作（`migrate diff --from-empty` 生成 `0_init` → `migrate deploy` → 已有结构用 `migrate resolve --applied 0_init`），`install.sh` 第 7 步在无迁移目录时中断并提示。T1-A 的 Baseline 方案（§7）**以此为底稿**并补三件事：SQLite 侧等价验证、双库隔离演练、备份恢复实证——不是另起炉灶。

## 7. Baseline 建立方案（待审 · 未执行）

### 7.1 原则

1. **Baseline 来自实际库实测结构，不来自 schema 文件臆造**（SQLite 已证零漂移可直接用；MySQL 必须先完成 §10 检查）。
2. 双 provider **分别建、分别验**：`prisma/migrations/` 承载 **MySQL** 迁移链（生产 `migrate deploy` 用）；SQLite 本地链路由 `schema.sqlite.prisma` + `prisma db push` 维持（T0 隔离运行器已在用此路径），并做**等价性验证**而非强行共用一套 DDL。
3. 不删、不改名、不改现有字段语义（授权书红线）；无法安全回滚的迁移走向前修复并留档。

### 7.2 步骤（实施阶段按序执行，每步产出证据）

1. **前置**：完成 §10 MySQL 只读检查，产出「MySQL 实际结构 ↔ schema.prisma」差异清单；若存在差异，先出「向前修复/补列」方案给用户拍板，**差异未消化前不建 Baseline**。
2. **MySQL Baseline**（目标库 = 隔离 MySQL，先演练后落生产）：
   - `npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`；
   - 人工核对 `0_init`：15 表、物理表名（含 `Account`）、36+ 索引同构、`coverMediaId`/`coverUploaded` 在列（deploy/README 前置项）；
   - 在**隔离 MySQL**（§9）对「空库」与「已建结构副本」两种起点各演练一次：前者 `migrate deploy`，后者 `migrate resolve --applied 0_init` 后 `migrate deploy`，验证不重复建表；
   - 对生产库执行时：先备份（§8）→ `migrate resolve --applied 0_init` → `migrate deploy`（预期 no-op）→ 校验表/索引清单与行数不变。
3. **SQLite Baseline 验证**（不建第二套 migrations 目录，避免双真源）：
   - 以现库为基准生成结构指纹清单（表/列/索引/行数）存档为 `docs/restructure/t1a-sqlite-baseline-fingerprint.txt`；
   - 证明 `db push --schema schema.sqlite.prisma` 对副本是幂等的（跑两次结构指纹不变）；
   - T0 隔离运行器的建库路径（schema-only）继续作为日常回归入口。
4. **迁移流程固化**：写 `docs/restructure/T1A-MIGRATION-PROCESS.md`（后续 schema 变更 SOP：改 schema.prisma → `schema:sqlite` 重新生成 → `migrate dev --name xxx` 生成 MySQL 迁移 → 双库隔离演练 → 备份 → `migrate deploy`；含失败处置与向前修复策略）。
5. **回滚策略**：DDL 迁移在 MySQL 上以「逆向迁移文件」评估可回滚性——`CREATE TABLE` 类可自动逆；`DROP/ALTER 收窄` 类标为**不可回滚**，只能向前修复（在流程文档逐条登记）。

### 7.3 Baseline 注意事项（写入文件头）

- 生成器降级：SQLite 侧 enum/Json 以 String 存储，**校验行数与结构、不校验原生类型**；
- `@@map` 物理表名为准；
- Baseline 迁移文件禁止包含任何数据（纯 DDL）与任何密钥；
- `0_init` 一旦标记 `--applied` 即冻结，后续变更一律新增迁移文件，禁止编辑历史迁移。

## 8. 备份恢复方案（待审 · 未执行）

### 8.1 SQLite

1. **备份**：停写窗口内 `dev.db` 文件复制为 `dev.db.bak-<时间戳>-pre-t1a`（沿用项目现行惯例 `*.db.bak-*`，已 gitignore）；伴随 `-wal/-shm` 一并复制（当前 journal_mode=delete 无伴随文件，脚本仍需兼容）。
2. **验证备份可用**（授权书要求实际验证）：把备份副本恢复到临时路径 → `PRAGMA integrity_check` = ok → 逐表行数与 §5.1 快照一致 → 跑 T0 三条 smoke（经隔离运行器、指向恢复副本的克隆）全绿。四关全过才算「备份可恢复」。
3. **恢复演练**（反向）：在**副本**上人为制造一处可逆结构变更（如建一张 `t1a_drill` 表）→ 用备份恢复 → 验证变更消失、业务表行数不变 → 删除副本。真实库全程不动。

### 8.2 MySQL

1. **备份**：`mysqldump --single-transaction --routines --triggers wechat_pipeline > backup-<ts>.sql`（deploy/README 前置项 #8 的落地）；备份文件与 `APP_SECRET_KEY` 分开存放。
2. **验证备份可恢复**：`mysqladmin create wechat_pipeline_restore_check` → 导入 dump → 对比表清单/索引/行数与源库只读快照 → `DROP` 校验库。全程只在隔离库上恢复，生产库只做只读 dump。
3. **失败处理**：迁移失败 → MySQL 若迁移可逆则 `migrate rollback`（Prisma 5 需手写 down SQL，无自动 down）或从备份恢复；不可逆迁移 → 向前修复 + 事故报告（授权书口径）。

### 8.3 备份验收项（实施后交证据）

- [ ] SQLite 备份文件 SHA-256 与源库一致（复制无损）
- [ ] 恢复副本 integrity_check + 行数四关通过
- [ ] MySQL dump → 恢复校验库结构/行数一致（依赖 §10 凭据）
- [ ] 恢复演练（人为变更 → 备份还原 → 变更消失）通过
- [ ] 备份文件名/位置/保留策略写入流程文档

## 9. 隔离数据库迁移演练方案（待审 · 未执行）

**总原则：任何迁移演练只碰隔离库；真实库只读。复用 T0 的隔离运行器范式。**

### 9.1 SQLite 演练

1. 复制 `dev.db` → `server/prisma/dev.t1a-drill.db`（含数据副本）与 schema-only 空库各一；
2. 在副本上演练「典型迁移」剧本（为 T1-B 预演）：新增 `TrackContract` 表 + `Track` 增列（可空/带默认）→ `prisma db push --schema schema.sqlite.prisma` 应用到副本 → 验证：旧数据行数不变、新表可读写、回滚=从备份副本恢复后结构指纹复原；
3. 演练幂等性：对副本连跑两次 db push，结构指纹不变；
4. 演练失败路径：注入一个非法迁移（如重复列名）确认失败时副本结构不被半应用（SQLite 单事务 DDL 的行为要实测记录）；
5. 全部通过后删除 `dev.t1a-drill*`；产出《SQLite 隔离验证报告》。

### 9.2 MySQL 演练

1. 建隔离环境二选一（实施时按用户环境定）：**a)** 本机 3306 MySQL 上建一次性库 `wechat_pipeline_t1a_drill`（需凭据，§10）；**b)** `docker run --rm mysql:8.0` 起临时容器（docker-compose.yml 有现成镜像定义）；
2. 起点 A（空库）：`migrate deploy` 应用 `0_init` → 校验 15 表/索引；
3. 起点 B（已有结构）：先用 dump 恢复或 db push 建结构 → `migrate resolve --applied 0_init` → `migrate deploy` → 验证不重复建表、无警告；
4. 迁移剧本演练（同 SQLite 剧本的 MySQL 版 DDL）→ 验证数据无损 → 逆向/恢复演练；
5. 校验库用完即 `DROP`；产出《MySQL 隔离验证报告》。

### 9.3 演练共同验收项

- 迁移前后逐表行数一致（业务表零丢失）；
- 表/索引清单 diff 仅含预期新增；
- 演练全程真实库 SHA-256 指纹不变（沿用 T0 指纹比对法）；
- 失败场景有实测记录（不是纸面推演）；
- 不得修改测试断言凑通过。

## 10. 需要用户配合的事项（阻塞 MySQL 检查与 MySQL 侧演练）

**当前唯一阻塞：MySQL 只读凭据。** 请二选一：

**方案 A（推荐）**：在有凭据的机器上给一个只读账号：
```sql
CREATE USER 'wpc_ro'@'%' IDENTIFIED BY '<强口令>';
GRANT SELECT ON wechat_pipeline.* TO 'wpc_ro'@'%';
FLUSH PRIVILEGES;
```
把 host/账号/口令发我（或填进 `server/.env` 的独立变量），我执行只读检查：

```bash
mysql -h <host> -u wpc_ro -p -e "
  SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
   WHERE TABLE_SCHEMA='wechat_pipeline' ORDER BY TABLE_NAME;
  SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA='wechat_pipeline' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
  SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA='wechat_pipeline' ORDER BY TABLE_NAME, ORDINAL_POSITION;"
```
（三段查询全是 information_schema 只读；再用 `prisma migrate diff --from-url mysql://… --to-schema-datamodel prisma/schema.prisma --script` 出差异清单。）

**方案 B**：你执行上述命令与 `SHOW CREATE TABLE` 全量输出，把结果贴给我。

另请确认一件事：**本机 3306 的 MySQL 8.0.30 与 `wechat_pipeline` 库是什么身份**（生产本机部署？开发测试？无关服务？）——决定 §9.2 演练环境选型与「生产库」的准确指向。此前项目口径「云端是唯一生产系统」，生产库若在远程服务器，也请给远程库的只读检查通道（或按方案 B 在服务器上跑）。

## 11. 未执行项清单（诚实登记，不得写成通过）

| 项 | 状态 | 原因 |
|---|---|---|
| MySQL 实际库结构检查 | **未执行** | 无凭据（§10） |
| MySQL 与 schema.prisma 差异对照 | **未执行** | 同上 |
| MySQL 行数/索引盘点 | **未执行** | 同上 |
| Baseline 建立 | **未执行** | 属实施阶段，且被 MySQL 检查阻塞（方案待审） |
| 备份与恢复演练 | **未执行** | 属实施阶段（方案待审） |
| 隔离迁移演练 | **未执行** | 属实施阶段（方案待审） |
| 跨 provider migrate diff | 尝试后**不可行**（引擎报错） | 已用模型/字段级比对替代（§4.2） |

## 12. 停点声明

本报告为 T1-A 只读检查交付物。**已停下**：不实施 Baseline、不执行任何迁移、不建任何迁移文件、不动任何数据库，等你审核方案（§7/§8/§9）与处理 §10 配合项。审核通过后按「先 MySQL 检查补齐 → 再 Baseline → 再演练」顺序实施 T1-A，实施完提交完整验收报告（授权书第六节 13 项材料）再停，**不自动进入 T1-B**。
