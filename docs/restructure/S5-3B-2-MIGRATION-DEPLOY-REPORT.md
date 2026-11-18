# S5-3B-2 · 真实业务库 Migration 部署与验收报告

- **日期**：2026-11-17 09:58（GMT+8）
- **授权**：部署唯一迁移 `20261116120000_add_article_lint_run` + 只读验收；不授权改 `.env`、不授权其他迁移命令、不授权 smoke/verify/Fingerprint、不授权 Git 写操作。
- **执行结论**：✅ **SUCCESS** —— 迁移按预期应用，结构验收全部通过，业务数据未被修改。

---

## 1. 部署前置

| 前置项 | 实测 | 结果 |
|---|---|---|
| 备份文件存在 | `K:/WorkBuddy WorkSpace/backups/wechat-pipeline-cloud/wechat_pipeline_pre_s5-3b-1_20261117_095219.sql`，84,663 字节 | ✅ |
| 备份 SHA-256 | 实算 `0ddfe00f…4ff8` = 记录值 `0ddfe00f…4ff8` | ✅ MATCH |
| Migration SQL 未被改动 | 仅 2 条语句（`CREATE TABLE` + `ALTER TABLE ... ADD CONSTRAINT`），无 DROP/TRUNCATE/DELETE/UPDATE；文件 SHA-256 `edc6301e…` | ✅ |

## 2. 部署前数据库身份（实测）

| 项目 | 实测结果 |
|---|---|
| `DATABASE()` | `wechat_pipeline` |
| `CURRENT_USER()` | `wpc_app@127.0.0.1` |
| `VERSION()` | `8.0.30` |
| `@@port` | `3306` |

连接方式：**未使用 `.env` 的默认目标**（其指向 `wechat_pipeline_smoke`）。改为读取 `.env` 中的既有凭据，在内存里把库名段替换为 `wechat_pipeline`，以**进程级 `DATABASE_URL`** 仅注入单条命令；连接前断言库名，不符即中止。

> **关于凭据传递的说明（诚实记录）**：本轮**未使用 `MYSQL_PWD`**（本轮也没有调用 `mysqldump`）。Prisma CLI 的 `migrate deploy` **不支持交互式输入密码**，只认数据源 env，因此只能用进程级 `DATABASE_URL`。该变量仅在单条短生命周期命令中存在，**未打印、未落盘、未写入任何配置文件**；Prisma 输出中的 `Datasource "db": MySQL database "wechat_pipeline" at "127.0.0.1:3306"` 不含凭据。

## 3. 部署前状态（与 S5-3A / S5-3B-1 一致）

- 表总数 **17**，`ArticleLintRun` **不存在**。
- `_prisma_migrations` **4 行**：3 条已应用（init / enum 补值 / S4-1）+ 1 条 init 历史 rolled-back。
- 无 `finished_at IS NULL AND rolled_back_at IS NULL` 的失败/未完成记录。
- `prisma migrate status`：`4 migrations found`，**仅** `20261116120000_add_article_lint_run` 待应用。

## 4. 服务状态（部署前）

| 服务 | 执行前状态 | 依据 |
|---|---|---|
| API | **未运行** | 8787、8797 均无 LISTEN；无含 `wechat-pipeline-cloud` 的 node 进程 |
| scheduler | **未运行** | `Get-CimInstance Win32_Process` 全量扫描：仅 WorkBuddy/Codex/MCP 的 node 进程，无 `scheduler.ts` / `src/index.ts` |

因两者均未运行，**本轮未停止任何服务**（按授权「原本未运行的服务不得擅自启动」，部署后也不启动）。

## 5. Migration 执行结果

| 项 | 值 |
|---|---|
| 命令 | `DATABASE_URL=<临时进程级> npx prisma migrate deploy`（在 `server/` 下） |
| 开始 / 结束 | `2026-11-17 09:58:04` → `2026-11-17 09:58:07`（约 3 s） |
| 退出码 | **0** |
| 实际应用数量 | **1**（`Applying migration 20261116120000_add_article_lint_run`，输出 `All migrations have been successfully applied.`） |
| 目标确认 | 输出 `Datasource "db": MySQL database "wechat_pipeline" at "127.0.0.1:3306"` —— **确认打在业务库，不是 `_smoke`** |
| 异常 | 无（无权限错误、无 MDL 等待、无部分变更） |

## 6. 数据库结构验收（`information_schema` 实测）

| 检查项 | 结果 |
|---|---|
| `ArticleLintRun` 表 | ✅ 存在（表总数 17 → **18**） |
| 字段结构 | ✅ **11 列**，与 `schema.prisma` 逐项一致（见下表） |
| 主键 | ✅ `PRIMARY (id)`，`int NOT NULL AUTO_INCREMENT` |
| 复合索引 | ✅ `ArticleLintRun_articleId_createdAt_idx (articleId, createdAt)`，非唯一 |
| 外键 | ✅ `ArticleLintRun_articleId_fkey (articleId) → wechat_pipeline.article(id)` |
| CASCADE 规则 | ✅ `ON DELETE CASCADE` / `ON UPDATE CASCADE` |
| 表属性 | ✅ `InnoDB` / `utf8mb4_unicode_ci`（与迁移声明的排序规则一致） |
| 原有 17 张表 | ✅ 全部存在（18 = 17 + 新表） |
| 新表初始行数 | ✅ **0**（不回填历史） |
| Migration 状态 | ✅ `prisma migrate status` → **`Database schema is up to date!`**；目标迁移记录**有且仅有 1 条**，`finished_at` 非空、`rolled_back_at` 为 NULL、`applied_steps_count=1`；总计 5 行（4 + 1），无失败/未完成 |

**列明细**：

| # | 列 | 类型 | NULL | 默认 | 备注 |
|---|---|---|---|---|---|
| 1 | `id` | int | NO | — | PK, auto_increment |
| 2 | `articleId` | int | NO | — | MUL（复合索引首列） |
| 3 | `trigger` | varchar(16) | NO | — | check/save/push/revise |
| 4 | `ok` | tinyint(1) | NO | — | MySQL 的 BOOLEAN |
| 5 | `errorCount` | int | NO | 0 | |
| 6 | `warnCount` | int | NO | 0 | |
| 7 | `statsJson` | json | YES | NULL | |
| 8 | `issuesJson` | json | YES | NULL | |
| 9 | `ruleJson` | json | YES | NULL | |
| 10 | `contentHash` | varchar(64) | NO | `''` | sha256 hex 定长 |
| 11 | `createdAt` | datetime(3) | NO | `CURRENT_TIMESTAMP(3)` | DEFAULT_GENERATED |

## 7. 业务数据未变更证明（与备份逐表比对）

解析备份 SQL 中每条 `INSERT` 的元组数作为「部署前行数」，与部署后 `COUNT(*)` 逐表对比：

| 表 | 备份 | 现库 | 结果 |
|---|---|---|---|
| `_prisma_migrations` | 4 | **5** | 预期变化（本次迁移新增 1 条记录） |
| `llmmodel` | 4 | 4 | ✅ |
| `setting` | 16 | 16 | ✅ |
| `styleprompt` | 44 | 44 | ✅ |
| `user` / `usersession` | 1 / 1 | 1 / 1 | ✅ |
| `articlelintrun`（新表） | — | 0 | ✅ 预期 |
| 其余 11 表（`account / angle / article / comicpanel / modelbinding / runlog / taskrun / topicreview / track / trackpipeline / wechattoken`） | 0 | 0 | ✅ |

**除 `_prisma_migrations` 新增 1 行、新表 0 行外，17 张原表行数与备份逐表一致 —— 未发生任何业务数据写入或修改。**

## 8. 服务恢复结果

| 服务 | 执行前 | 本轮操作 | 最终状态 |
|---|---|---|---|
| API | 未运行 | 未停止、未启动 | **未运行**（与执行前一致） |
| scheduler | 未运行 | 未停止、未启动 | **未运行**（与执行前一致） |

部署后复测：8787 / 8797 无 LISTEN，无本项目 node 进程 —— 服务状态未因部署改变。

## 9. 操作边界确认

| 约束 | 结果 |
|---|---|
| 写入业务数据 | ✅ 无（仅 `SELECT` + 一次 `CREATE TABLE`/`ADD CONSTRAINT` DDL 及其迁移记账行） |
| 修改 `.env` 或持久化连接配置 | ✅ 未修改（仅单条命令的进程级 env） |
| 执行其他 Migration | ✅ 无（仅 `migrate deploy`，且只应用 1 个；未用 db push / migrate dev / reset / resolve / --force-reset） |
| 修改 Migration SQL / Schema | ✅ 未修改 |
| 停止/重启无关服务 | ✅ 未操作（本轮无需停止任何服务） |
| smoke / verify / Fingerprint | ✅ 未执行 |
| Git 操作 | ✅ 无（未 commit/push/reset/checkout/stash；工作区除本轮两份文档外无变化） |
| 真实 LLM / 微信 API / 发布 | ✅ 零调用 |
| root 账号 | ✅ 未使用（全程 `wpc_app`） |

## 10. 遗留与注意

1. **`server/.env` 仍指向 `wechat_pipeline_smoke`**（本轮禁止修改）。今后任何本地启动、`prisma` 命令都需注意：**默认目标不是业务库**。
2. **代码侧已具备缺表降级**（S5-2-HF1），现在表已存在，存档/历史读取走正常路径；下一次启动服务即开始正常写留痕。
3. **备份可恢复性仍未验证**（未做恢复演练）。当前备份可作为回滚兜底：迁移是纯新增，若需回退，优先「不回滚结构」（空表不影响旧代码）。
4. 表名在 `information_schema` 显示为小写（`lower_case_table_names=1`，Windows 默认），不影响 Prisma 访问（该模式下表名大小写不敏感）。
