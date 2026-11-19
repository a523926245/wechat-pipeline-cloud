# S6-2B-1 · 数据库连接配置修改后只读核验

> **性质**：**只读核验**。未修改 `.env`；未创建/删除数据库、表；未执行任何 Prisma 命令（含 `migrate dev` / `migrate deploy` / `db push`）；未运行任何测试或写库脚本；未启停服务；未执行 Git 操作。
>
> **核验时间**：2026-11-18 18:16 → 19:45（GMT+8）
> **Git 基线**：HEAD `e46941e`，工作区仅有 S6-2A 报告未跟踪，其余干净
> **`.env` 状态**：mtime **2026-11-18 18:15:47**，696 字节（上次核验为 689 字节/15:34:28 → **已被修改**）

---

## 1. 结论速览

| # | 核验项 | 结果 |
|---|---|---|
| 1 | 两个 URL 是否配置正确 | ✅ **正确**。`DATABASE_URL`→`wechat_pipeline`，`SHADOW_DATABASE_URL`→`wechat_pipeline_shadow`，**库名不同** |
| 2 | 两个数据库是否实际连接成功 | ✅ **均成功**（均返回 `CURRENT_USER()=wpc_app@127.0.0.1`、`VERSION()=8.0.30`） |
| 3 | `wpc_app` 是否具备 Shadow 所需权限 | ✅ **完全具备**。shadow 库 18 项库级权限全齐（含 `CREATE`/`DROP`/`ALTER`/`INDEX`/`REFERENCES`/`LOCK TABLES`） |
| 4 | 现有 Shadow 库是否适合继续使用 | ⚠️ **配置可用，但数据可丢弃性待确认**。15 张表行数查询结果**均显示为 0**，其中 6 张 `COUNT(*)` **精确核验为 0 行**、9 张仅 `TABLE_ROWS` **估算值为 0**；`TABLE_ROWS` 是估算值，不能证明这 9 张表确实为空。无迁移表。连接、权限满足 shadow 要求；但**在确认 15 张表均可丢弃前，不应执行会重置 Shadow 库的操作** |
| 5 | 正式库核验结果 | ✅ **结构及 Migration 记录符合预期**。已核验的 12 张关键表行数与 S6-2A 基线**逐项一致**；未进行 18 张表全部数据内容的逐行比对 |
| 6 | 是否需人工处理的问题 | ⚠️ **2 项**：① shadow 库缺 3 张表（P4，非阻塞，Prisma 会自建）；② `package.json` 的 `prisma:migrate` = `migrate dev` **仍未解除**（P1，非本次阻塞，须 S6-4 加命令级护栏） |

**S6-2A 的 2 个 P0 中，仅第 1 个（shadow 与业务库同指）已解除；第 2 个（`migrate dev` 脚本）仍在，见 §9 特别说明。**

---

## 2. `.env` 当前配置（脱敏）

文件：`server/.env`，696 字节，mtime `2026-11-18 18:15:47`

| 键 | host | port | database | username | 密码 | URL 长度 |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | `127.0.0.1` | `3306` | **`wechat_pipeline`** | `wpc_app` | 已配置 | 78 |
| `SHADOW_DATABASE_URL` | `127.0.0.1` | `3306` | **`wechat_pipeline_shadow`** | `wpc_app` | 已配置 | **85** |

### 2.1 与 S6-2A 对比（修复确认）

| 项 | S6-2A（15:34:28，689 字节） | 本机现在（18:15:47，696 字节） | 变化 |
|---|---|---|---|
| `DATABASE_URL` 库名 | `wechat_pipeline` | `wechat_pipeline` | 无变化（本就正确） |
| `SHADOW_DATABASE_URL` 库名 | **`wechat_pipeline`** ⚠️ | **`wechat_pipeline_shadow`** ✅ | **已修复** |
| 两 URL 是否相同 | 是（均 len=78） | **否**（78 vs 85） | **已分离** |

**判定：`DATABASE_URL` 与 `SHADOW_DATABASE_URL` 已指向不同数据库，S6-2A 报告的 P0「shadow 指向业务库」已消除。**

---

## 3. 两个数据库连接与身份核验

### 3.1 正式库 `wechat_pipeline`

```sql
SELECT DATABASE(), CURRENT_USER(), VERSION();
```

| db_name | db_user | version |
|---|---|---|
| `wechat_pipeline` | `wpc_app@127.0.0.1` | **8.0.30** |

| 检查项 | 结果 |
|---|---|
| 连接状态 | ✅ **成功** |
| 表数量 | **18** ✅（符合预期） |
| `_prisma_migrations` 存在 | ✅ **是**（`COUNT(*)` 查询返回 1） |

### 3.2 Shadow 库 `wechat_pipeline_shadow`

```sql
SELECT DATABASE(), CURRENT_USER(), VERSION();
```

| db_name | db_user | version |
|---|---|---|
| `wechat_pipeline_shadow` | `wpc_app@127.0.0.1` | **8.0.30** |

| 检查项 | 结果 |
|---|---|
| 连接状态 | ✅ **成功** |
| 表数量 | **15** ✅（符合预期） |
| `_prisma_migrations` 存在 | ❌ **否**（`COUNT(*)` 返回 0） |

> **说明**：Shadow 库没有 `_prisma_migrations` 表，**与其作为 Prisma Shadow Database 的用途相符，也说明本次核验时未发现该库保留 Prisma Migration 历史记录**。但**仅凭迁移历史表缺失，不能推断该库过去从未承载过业务数据，也不能证明其历史用途**。Shadow Database 是 `migrate dev` 的**辅助工作区**——Prisma 会在此重放已有迁移历史以检测开发库 Schema Drift、生成新迁移并评估数据丢失风险；配置了 `shadowDatabaseUrl` 时，Prisma 会在 `migrate dev` 开始时重置 Shadow 数据库，因此它**不需要也不应**保留迁移历史表。（Shadow 不是 `migrate dev` 的主要操作目标，后者是 `DATABASE_URL` 指向的库。）

---

## 4. Migration 记录核验（正式库）

| migration_name | finished_at | rolled_back_at | applied_steps_count |
|---|---|---|---|
| `20261113145706_init` | `NULL` | `2026-11-14 01:59:48.202` | 0 |
| `20261113145706_init` | `2026-11-14 02:57:35.572` | `NULL` | 1 |
| `20261114035440_add_missing_enum_values` | `2026-11-14 03:55:05.780` | `NULL` | 1 |
| `20261114093000_add_angle_status_topic_review` | `2026-11-14 11:56:30.778` | `NULL` | 1 |
| `20261116120000_add_article_lint_run` | `2026-11-17 01:58:07.204` | `NULL` | 1 |

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| `applied` 条数（`rolled_back_at IS NULL`） | 4 | **4** | ✅ |
| 表内总记录数 | 5（4 成功 + 1 历史回滚） | **5** | ✅ 与 S6-2A 完全一致 |
| `20261116120000_add_article_lint_run` | 已应用 | ✅ `finished_at=2026-11-17 01:58:07` | ✅ |

> 第 1 行是 `20261113145706_init` 于 2026-11-14 01:59:48 的**历史失败回滚记录**（`applied_steps_count=0`），随后 02:57:35 成功重放。属初始化期正常波折，**与 S6-2A 记录完全一致，未发生变化**。

---

## 5. `wpc_app` 权限核验

### 5.1 全局授权

```sql
SHOW GRANTS FOR CURRENT_USER();
```

```
GRANT USAGE ON *.* TO `wpc_app`@`127.0.0.1`
GRANT ALL PRIVILEGES ON `wechat_pipeline`.*        TO `wpc_app`@`127.0.0.1`
GRANT ALL PRIVILEGES ON `wechat_pipeline_shadow`.* TO `wpc_app`@`127.0.0.1`
GRANT ALL PRIVILEGES ON `wechat_pipeline_smoke`.*  TO `wpc_app`@`127.0.0.1`
```

✅ **三个库均为 `ALL PRIVILEGES`**，无跨库全局权限（`*.*` 仅 `USAGE`，即只能登录）。符合最小权限原则。

### 5.2 Shadow 库库级权限明细（18 项，全齐）

| 权限 | 状态 | Prisma shadow 库是否需要 |
|---|---|---|
| `CREATE` | ✅ | **必需**（创建临时表） |
| `DROP` | ✅ | **必需**（清空重建） |
| `ALTER` | ✅ | **必需**（迁移差异模拟） |
| `INDEX` | ✅ | **必需**（建索引） |
| `REFERENCES` | ✅ | **必需**（外键） |
| `LOCK TABLES` | ✅ | **必需**（迁移期间锁表） |
| `SELECT` / `INSERT` / `UPDATE` / `DELETE` | ✅ | 需要 |
| `CREATE TEMPORARY TABLES` | ✅ | 需要 |
| `CREATE VIEW` / `SHOW VIEW` | ✅ | 视 schema 而定 |
| `CREATE ROUTINE` / `ALTER ROUTINE` / `EXECUTE` | ✅ | 本项目未用存储过程，冗余但不影响 |
| `TRIGGER` / `EVENT` | ✅ | 本项目未用，冗余但不影响 |

**结论：`wpc_app` 对 shadow 库的权限完全满足 Prisma shadow database 的全部技术要求。**

---

## 6. 正式库数据变化核验（行数口径）

对照 S6-2A（2026-11-18 17:35）的基线，逐表 `COUNT(*)` 实测：

| 表 | S6-2A 基线 | 本次实测 | 一致 |
|---|---|---|---|
| `llmmodel` | 4 | **4** | ✅ |
| `styleprompt` | 44 | **44** | ✅ |
| `setting` | 16 | **16** | ✅ |
| `user` | 1 | **1** | ✅ |
| `modelbinding` | 7 | **7** | ✅ |
| `usersession` | 2 | **2** | ✅ |
| `account` | 0 | **0** | ✅ |
| `angle` | 0 | **0** | ✅ |
| `article` | 0 | **0** | ✅ |
| `articlelintrun` | 0 | **0** | ✅ |
| `track` | 0 | **0** | ✅ |
| `trackpipeline` | 0 | **0** | ✅ |

**结论：本次核验涉及的 12 张表，其行数与 S6-2A 基线一致；Migration 记录数量及状态也保持一致。未发现本次核验范围内的异常变化。**

> 说明：本次只核对了行数、Session 数量和 Migration 记录，未读取业务正文或逐行比较数据内容。因此，本次核验只能说明上述检查项与基线一致，**不能据此证明数据库完全没有发生过写入或数据内容变化**。

---

## 7. Shadow 库 15 张历史表清单

| # | 表名 | 行数 | 取值口径 |
|---|---|---|---|
| 1 | `account` | 0 | `TABLE_ROWS` 估算 |
| 2 | `angle` | 0 | **`COUNT(*)` 精确** |
| 3 | `article` | 0 | **`COUNT(*)` 精确** |
| 4 | `comicpanel` | 0 | `TABLE_ROWS` 估算 |
| 5 | `llmmodel` | 0 | **`COUNT(*)` 精确** |
| 6 | `modelbinding` | 0 | `TABLE_ROWS` 估算 |
| 7 | `runlog` | 0 | `TABLE_ROWS` 估算 |
| 8 | `setting` | 0 | **`COUNT(*)` 精确** |
| 9 | `styleprompt` | 0 | **`COUNT(*)` 精确** |
| 10 | `taskrun` | 0 | `TABLE_ROWS` 估算 |
| 11 | `track` | 0 | `TABLE_ROWS` 估算 |
| 12 | `trackpipeline` | 0 | `TABLE_ROWS` 估算 |
| 13 | `user` | 0 | **`COUNT(*)` 精确** |
| 14 | `usersession` | 0 | `TABLE_ROWS` 估算 |
| 15 | `wechattoken` | 0 | `TABLE_ROWS` 估算 |

**Shadow 库 15 张表的行数查询结果均显示为 0，其中 6 张（`user` / `llmmodel` / `styleprompt` / `setting` / `article` / `angle`）通过 `COUNT(*)` 精确核验为 0 行，另外 9 张仅通过 `information_schema.TABLE_ROWS` 获取估算值 0**（InnoDB 的 `TABLE_ROWS` 是估算值，对空表通常准确，但严格说不是 `COUNT(*)`）。**当前没有证据证明这 9 张表一定为空，因此不能据此断言整个 Shadow 库不存在数据损失风险。**

> **口径声明**：本表初版表头写作"行数（精确 `COUNT(*)`）"，会让读者误以为 15 张全部精确计数。实际上只有 6 张是 `COUNT(*)` 精确值，已按上表逐行标注口径；另外 9 张是 `TABLE_ROWS` 估算值，**估算值为 0 不等于已确认 0 行**。在确认这 9 张表均可丢弃之前，不应执行会重置 Shadow 库的操作；如需使用现有 Shadow 库，应先对这 9 张表做 `COUNT(*)` 精确计数，或由用户明确确认其数据可以丢弃。

### 7.1 与正式库的表结构差异

正式库有、shadow 库**没有**的表（3 个）：

| 表名 | 说明 |
|---|---|
| `_prisma_migrations` | 迁移历史表——shadow 库**不需要**，正常缺失 |
| `articlelintrun` | S5-4-3 新增的体检留痕表——shadow 库建于其之前，故缺失 |
| `topicreview` | S4-1 新增的选题审核表——同上 |

**这 3 张表缺失不影响 shadow 库的配置可用性**：Prisma 在 `migrate dev` 时会从空状态重放全部迁移，缺失的表会被自动创建。**但注意**：shadow 库现有 15 张遗留表若被 Prisma 首次使用，会先被 DROP 再重建；由于其中 9 张表的行数仅为 `TABLE_ROWS` 估算值（未精确核验为空），**在确认这些表的数据可以丢弃之前，不应触发会重置 Shadow 库的操作**（含配置好 `shadowDatabaseUrl` 后首次执行 `migrate dev`）。

---

## 8. 现有 Shadow 库是否适合继续使用

### ⚠️ 配置可用，但数据可丢弃性待确认

配置层面（连接、权限、命名、未被其他配置引用）满足作为 Prisma Shadow Database 使用的条件；**数据层面不能直接认定为可丢弃**——见下表与 §8.1。

| 评估维度 | 结论 |
|---|---|
| 数据安全性 | **配置层面可用，数据层面待确认**。15 张表中 6 张 `COUNT(*)` 精确核验为 0 行、9 张仅 `TABLE_ROWS` 估算值为 0；**估算值不能证明表为空，当前不能断言整个 Shadow 库不存在数据损失风险**。在确认 15 张表均可丢弃前，不应执行会重置 Shadow 库的操作（如需使用，先对 9 张表 `COUNT(*)` 精确计数，或由用户明确确认可丢弃） |
| 权限完备性 | **完全满足**——18 项库级权限含全部 shadow 必需项 |
| 连接可达性 | **成功**（8.0.30，与正式库同实例同版本） |
| 是否被其他配置引用 | **否**——仅 `.env` 的 `SHADOW_DATABASE_URL` 指向它 |
| 遗留表影响 | **需先确认可丢弃**。Prisma 首次使用会 DROP 全部表再重建；其中 9 张表行数仅为估算值，未精确核验为空，**确认前不应触发重置** |
| 命名一致性 | ✅ 符合 `RESTRUCTURE-2.0-CONVERGED-PLAN` 约定的 `wechat_pipeline_shadow` |

### 8.1 唯一需要知晓的点（数据可丢弃性待确认）

**shadow 库现有 15 张遗留表**（来源不明，可能来自早期手工建库或 SQLite→MySQL 阶段的探索）。这些表的行数查询结果均显示为 0：**6 张经 `COUNT(*)` 精确核验为 0 行，另外 9 张仅为 `TABLE_ROWS` 估算值 0**。由于 `TABLE_ROWS` 是估算值，**当前没有证据证明这 9 张表一定为空，因此不能断言整个 Shadow 库不存在数据损失风险**。

**在确认这 15 张表均可丢弃之前，不应执行会重置 Shadow 库的操作**（包括配置好 `shadowDatabaseUrl` 后首次执行 `migrate dev` 触发的 Shadow 重置）。如果后续确实需要使用现有 Shadow 库，应**先对尚未精确核验的 9 张表执行 `COUNT(*)` 精确计数**，或**由用户明确确认这些数据可以丢弃**。本轮为只读核验，未执行此类重置或精确计数。

---

## 9. 是否存在需要人工处理的问题

| # | 问题 | 级别 | 是否阻塞 | 建议 |
|---|---|---|---|---|
| 1 | 原 P0（shadow 指向业务库） | ~~P0~~ | ✅ **已解除** | 无需处理 |
| 2 | shadow 库 15 张遗留表 | P4 | ❌ 不阻塞本次只读核验 | **数据可丢弃性待确认**：6 张 `COUNT(*)` 精确为 0 行、9 张仅 `TABLE_ROWS` 估算为 0，不能断言表为空。确认 15 张表均可丢弃前，不应执行会重置 Shadow 库的操作；如需使用，先对 9 张表 `COUNT(*)` 精确计数，或由用户明确确认可丢弃 |
| 3 | shadow 库缺 `articlelintrun` / `topicreview` 表 | P4 | ❌ 不阻塞 | 无需处理。`migrate dev` 时会自动创建 |
| 4 | `package.json` 中的 `prisma:migrate` 仍指向 `prisma migrate dev` | **P1** | ❌ 不阻塞本次只读核验，但**属尚未消除的高危风险** | **必须在 S6-4 增加命令级安全护栏**，禁止在 `DATABASE_URL` 指向正式业务库时执行 `migrate dev`，不能仅靠文档提醒。`migrate dev` 的**主要操作目标是 `DATABASE_URL` 指向的数据库**；Shadow Database 是**辅助工作区**（重放迁移历史检测 Drift、生成新迁移、评估数据丢失风险），不是主要操作目标。即使两 URL 已分离，只要 `DATABASE_URL` 仍指向正式业务库，执行 `migrate dev` 仍可能因 Drift 或迁移历史冲突而**要求重置正式库**。详见下方说明 |

**结论：本次只读核验本身无阻塞项；但 `prisma:migrate` 仍指向 `migrate dev`，属于尚未解除的高危风险，必须在 S6-4 完成命令级护栏后，才能关闭该问题。**

> **特别说明 S6-2A 第 2 个 P0（`prisma:migrate` = `migrate dev` 仍在 `package.json`）——本条 P0 并未因 shadow 分离而解除：**
>
> **`SHADOW_DATABASE_URL` 与 `DATABASE_URL` 分离，只解决了"Shadow URL 指向正式业务库"这一个问题，不等于 `migrate dev` 已安全。**
>
> **`prisma migrate dev` 的主要操作目标是 `DATABASE_URL` 指向的数据库。** Shadow Database 是**辅助工作区**，不是 `migrate dev` 的主要操作目标。其完整职责如下：
>
> 1. **重放已有迁移历史**：Prisma 在 Shadow Database 中重放 `DATABASE_URL` 库已有的全部迁移，用于**检测开发数据库的 Schema Drift**；
> 2. **生成新迁移并评估数据丢失风险**：Shadow Database 还用于生成新迁移，并评估其**潜在数据丢失风险**；
> 3. **应用未应用的迁移**：`migrate dev` 会将尚未应用的迁移**应用到 `DATABASE_URL` 指向的数据库**；
> 4. 若发现 **Schema Drift 或 Migration History Conflict（迁移历史冲突）**，Prisma **可能要求重置 `DATABASE_URL` 指向的数据库**（`reset`，即 DROP 后重放迁移）——这是**条件触发**，不是必然结果。
>
> 因此，**Shadow Database 与正式业务库分离，并不意味着在正式业务库上执行 `migrate dev` 就安全**：`migrate dev` 的全部写操作仍以 `DATABASE_URL` 指向的库为目标。
>
> **当前 `DATABASE_URL` 指向的是有真实数据的正式业务库 `wechat_pipeline`。** 因此：
>
> - ⛔ **禁止在当前正式业务库配置下执行 `prisma migrate dev`**；
> - 准确的风险表述是：它**可能**因 Drift 或 Migration 历史不一致而**要求重置正式库**，**不是在正式库上执行就必然重置**，但一旦触发即为全量数据丢失，风险不可接受；
> - `SHADOW_DATABASE_URL` 与 `DATABASE_URL` 分离，**只解决了"两个连接目标相同"这一配置问题**，不改变 `migrate dev` 的主要操作目标，**不能使 `migrate dev` 在正式业务库上变得安全**；
> - **正式业务库的 Migration 部署仍只允许使用 `prisma migrate deploy`**，且必须遵守既定授权边界（`prisma migrate deploy` 只应用已有迁移文件，不检查漂移、不重置库）。
>
> **结论：S6-4 必须加命令级护栏，禁止在 `DATABASE_URL` 指向正式业务库时执行 `migrate dev`，文档提醒不足。**

---

## 10. 核验项逐条对照

| 用户要求 | 完成情况 |
|---|---|
| 读取并解析两个 URL | ✅ 已解析，输出 host/port/database/username + 密码是否配置 |
| 只输出非敏感信息 | ✅ 全程未输出密码、完整 URL |
| 两 URL 是否指向不同库 | ✅ **不同**（`wechat_pipeline` vs `wechat_pipeline_shadow`） |
| 确认预期结果 | ✅ 完全符合预期 |
| 分别连接两库执行只读查询 | ✅ `SELECT DATABASE()` / `VERSION()` / 表数 / `_prisma_migrations` / 权限 |
| 正式库核对 18 张表 | ✅ **18 张** |
| 正式库核对 4 条 Migration | ✅ **4 条 applied**（另有 1 条历史回滚，共 5 行记录，与 S6-2A 一致） |
| 正式库数据变化核验 | ✅ 12 张关键表的行数与 S6-2A 基线逐项一致；未进行 18 张表全部数据内容的逐行比对 |
| Shadow 列出 15 张表名 | ✅ 已列全；行数查询结果均为 0（6 张 `COUNT(*)` 精确、9 张 `TABLE_ROWS` 估算） |
| 不读敏感业务数据 | ✅ 仅行数，未读任何正文/凭据 |
| 不修改清理任何表 | ✅ 未执行任何 DDL/DML |

---

## 11. 本轮未执行的操作（明确声明）

| 未执行项 | 说明 |
|---|---|
| 修改 `.env` | ✅ 未改（mtime 仍为 18:15:47，是用户自己改的） |
| 创建/删除数据库 | ✅ 未执行 |
| 创建/删除/修改表 | ✅ 未执行任何 DDL |
| 任何 Prisma 命令 | ✅ 未执行（含 `migrate dev` / `deploy` / `db push` / `generate`） |
| 任何测试或写库脚本 | ✅ 未执行 |
| 启停 8787 / 5173 | ✅ 未执行（当前均未运行） |
| Git 操作 | ✅ 无任何 Git 写操作 |
| 输出密码/完整 URL | ✅ 未输出 |

### 本轮实际执行的全部操作（均为只读）

```
读取：server/.env（解析后仅输出脱敏字段）
数据库：SELECT / SHOW GRANTS / information_schema 查询
        —— 无 INSERT / UPDATE / DELETE / CREATE / DROP / ALTER
文件：写入 var/tmp/s62b/{main,shadow}.cnf 临时凭据（已被 .gitignore:13 覆盖）→ 核验后已删除
git：仅 status / check-ignore（只读）
```

**临时凭据文件已删除，工作区无新增未跟踪文件（`var/tmp/s62b/` 已清空）。**

---

## 12. 一句话总结

**配置已修好：`DATABASE_URL`→`wechat_pipeline`、`SHADOW_DATABASE_URL`→`wechat_pipeline_shadow`，两者分离；两库均连接成功（8.0.30）；`wpc_app` 对 shadow 库 18 项权限全齐；shadow 库 15 张表行数查询结果均显示为 0（6 张 `COUNT(*)` 精确核验为 0 行、9 张仅 `TABLE_ROWS` 估算值为 0，估算不等于确认，不能断言无数据损失风险），配置可用但使用前提是对 9 张表精确计数或由用户确认可丢弃，确认前不应执行会重置 Shadow 库的操作；正式库共 18 张表、4 条已应用迁移；已核验的 12 张关键表行数与 S6-2A 基线逐项一致，Migration 记录数量及状态保持一致。本次未进行 18 张表全部数据内容的逐行比对，不能据此证明数据库完全没有发生过写入或数据内容变化。**
>
> **S6-2A 的 2 个 P0 中，只有第 1 个（`SHADOW_DATABASE_URL` 与 `DATABASE_URL` 同指业务库）已解除；第 2 个（`package.json` 的 `prisma:migrate` = `migrate dev`）仍未解除——`migrate dev` 会作用于 `DATABASE_URL` 并可能因漂移要求重置正式库，故在当前配置下禁止执行，须由 S6-4 补命令级护栏。正式库迁移只允许 `prisma migrate deploy`。**