# T1-A · Prisma Migrate 初始化方案（REV4.1）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（REV4.1；方案文档，**零实施**——本轮禁止 CREATE DATABASE / db push / migrate dev/deploy/resolve / 建 migration 文件 / 改 .env / GRANT）
- **前提**：本机 MySQL 8.0.30 = 唯一开发库；`wechat_pipeline` 不存在；仓库无 `prisma/migrations`；Prisma **5.22.0**。
- **REV4.1 修订依据（外部审核 B 组 + 文档建议）**：B4 包装脚本必须覆盖 `DATABASE_URL=MIGRATE_DATABASE_URL`（Prisma 不会自动用后者）；B5 migrate diff 改 `--from-schema-datasource`/`--to-schema-datasource`（命令行零密码）+ `--exit-code` 语义 0/2/1；B6 **取消 `_wpc_migration_progress`**（不给正式库加非 Prisma 表）；B7 唯一键预检改 TEMPORARY TABLE 口径（dry-run=无持久化写入）+ NULL/前缀索引语义；B8 回退两档（完整回退含 T0-v1 git revert；仅应用回退须明确标注）；migrate status 定位修正；A2 补 SMOKE_DATABASE_URL/SMOKE_DB_PORT。
- **REV4 修订依据（保留）**：P1-1 八步顺序；P1-2 Prisma 规则；P1-3 Windows；P0-5 唯一键；P1-6 快照；P1-7 FK；P0-2 shadow 定稿。
- **收敛原则**：删除过度设计，改为线性八步 + 简明检查项。

---

## 1. 总原则（P1-2，Prisma 5.22 口径）

| 场景 | 命令 | 说明 |
|---|---|---|
| 开发环境生成+应用迁移 | `prisma migrate dev`（经 `npm run db:migrate` 包装） | 唯一开发入口 |
| 生产环境应用已提交迁移 | `prisma migrate deploy` | 唯一生产入口（install.sh 已内置） |
| 状态检查 | `prisma migrate status` | 只读；**只核对迁移目录与 _prisma_migrations 账目，不是完整 drift 检测**（drift= migrate dev shadow 推演 + migrate diff） |
| **禁止** | `migrate dev --force-reset`；为让命令通过而删真实库；真实库 `db push`；手工改 `_prisma_migrations`；非空库跑 `migrate dev` | 一经发现即中止 |

**状态不明即中止（强制）**：发现需要 reset、历史不一致（`migrate status` 报 drift/pending 不可解释）、或无法确认数据库状态 → **中止并人工处理**，不允许任何自动化路径自动 reset 或自动删库。

## 2. 初始化顺序（P1-1 统一，八步线性，消除矛盾）

**核心修复：数据库与账号由 DBA/用户预先创建，一切连库检查都在库存在之后执行**——不再出现「库没建却要求 DATABASE() 必须等于目标库」的逻辑矛盾。

```
① DBA/用户以管理账号（root）预先创建数据库及账号（SQL 见决策报告 §5）：
     CREATE DATABASE wechat_pipeline  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
     CREATE DATABASE wpc_shadow       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
     （显式字符集/排序规则——P0-8，不依赖实例默认值；临时库建库语句同样显式）
   五个业务账号 wpc_migrate / wpc_runner / wpc_smoke / wpc_ro / wpc_app 建号并授权。
② 配置 server/.env（.gitignore 覆盖，不进聊天/不进 git）：
     DATABASE_URL=wpc_app 串；MIGRATE_DATABASE_URL=wpc_migrate 串；
     SHADOW_DATABASE_URL=wpc_shadow 串；RUNNER_DATABASE_URL=wpc_runner 串（P2-B 用）；
     SMOKE_DATABASE_URL=wpc_smoke 串（**只供 runner 父进程读取**，用于派生当前 runId 的临时库连接串）；
     SMOKE_DB_PORT=3306（网守/连接目标端口的显式来源，不依赖未说明的环境变量）。
   凭据注入边界（REV4.1·A2）：测试子进程只收到临时库对应的 DATABASE_URL 一份凭据，
   不继承 RUNNER/MIGRATE/SMOKE 任何其他连接串；日志统一脱敏。
③ 检查连接目标与账号权限（全部经 Prisma 连接配置实测、输出留档）：
     SELECT USER(), CURRENT_USER(), DATABASE(), VERSION(),
            @@hostname, @@port, @@lower_case_table_names,
            @@partial_revokes, @@skip_name_resolve;
   → DATABASE()=wechat_pipeline；CURRENT_USER() 按脚本用途核对（迁移=wpc_migrate，非 root）；
   → @@hostname/@@port 确认本机 127.0.0.1:3306；@@lower_case_table_names 预期 1；
   → @@partial_revokes=OFF（ON 则停下报告）；@@skip_name_resolve 记录（见 §2.1）；
   → SHOW GRANTS FOR CURRENT_USER() 逐行解析 + 角色核验（兼容方案 §5.3 口径）。
④ 必要的安全检查：
     空库检查（information_schema.TABLES 计数=0，否则禁止初始化迁移）；
     反白名单确认（目标库不是 crm/wechat_publisher/wx_task_pocket 等）；
     源 dev.db 快照纪律就位（§7）。
⑤ 初始化 Prisma Migration（见 §3）。
⑥ 执行数据迁移（见 §5）。
⑦ 验证迁移结果（§5 verify + §6 diff + §7 指纹）。
⑧ 启动应用（wpc_app 连接串生效）。
```

### 2.1 skip_name_resolve 说明（P1-4）

`@@skip_name_resolve=ON` 时 `'user'@'localhost'` 账号无法匹配 TCP 来源连接（host 匹配按 IP 字面）。本机默认 OFF；若实测 ON 且连接失败，建号口径（`@'localhost'` vs `@'127.0.0.1'`）**交用户确认后调整**，文档不预设。

## 3. 初始化步骤（授权 (b1)，Windows 兼容）

### 3.1 Schema 唯一改动（一行，diff 留档）

```prisma
datasource db {
  provider          = "mysql"
  url               = env("DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}
```

### 3.2 命令执行方式（P1-3 + REV4.1·B4，强制）

- **所有 Prisma 命令经 Node 包装脚本执行**（如 `scripts/db-migrate.ts`：读 `server/.env` → 设置子进程 env → spawn `prisma`）。不在 shell 里写 `VAR=x npx ...` 的 POSIX 赋值前缀（Windows cmd/PowerShell 不兼容）。
- **B4（关键）：包装脚本必须覆盖 `childEnv.DATABASE_URL = MIGRATE_DATABASE_URL`**——Prisma 只认 Schema 里的 `env("DATABASE_URL")`，`.env` 里存在 `MIGRATE_DATABASE_URL` **不会**被自动使用；不覆盖就会拿 wpc_app（无 DDL）跑 migrate dev。同时保留正确的 `SHADOW_DATABASE_URL`。
- **执行后必须实测** `SELECT CURRENT_USER(), DATABASE()` = `wpc_migrate` @ `wechat_pipeline` 才算迁移身份正确，输出留档。
- **密码零输出**：脚本与日志对 URL 统一脱敏（仅打印 `user@host:port/db` 形态）；命令行参数不拼密码；报错输出先过脱敏再落盘。
- 首个迁移：

```
npm run db:migrate -- --name init        （内部以 MIGRATE_DATABASE_URL 执行 migrate dev）
```

  迁移目录名以 Prisma 实际生成为准（时间戳前缀），产出目录原样入 git。不假设目录叫 `0_init`。

### 3.3 client 生成与验证

```
npm run prisma:generate        （读 schema.prisma = MySQL 真源）
V1 产物：生成配置 provider = "mysql"
V2 连通（只读）：经 PrismaClient $queryRaw 输出 SELECT DATABASE()/CURRENT_USER()/VERSION()
V3 行为：P2-B 三冒烟全绿（最终证明）
```

回退（REV4.1·B8，两档，P2-B 失败时按需选）：
- **完整回退**（恢复切换前全部能力，含 T0-v1 测试）：git revert **P1-A 单独提交**（恢复 T0-v1 四件套与配置）→ `npm run sqlite:generate` → DATABASE_URL 回 `file:./dev.db`。**P1-A 改造必须单独成 commit**，切换前 T0-v1 代码版本在 git 历史中保留；不设复杂回滚工具，Git 提交记录即回滚依据。
- **仅应用回退**（暂时停用冒烟）：sqlite:generate + DATABASE_URL 回 `file:./dev.db`，四件套保持 T0-v2 不动——此时 MySQL/SQLite 两套测试载体不兼容，冒烟两侧均不可用；报告中必须明确写「**应用回退**」，不得称「整个 T0 系统回退」。

## 4. Shadow Database（P0-2 简化定稿）

- **主方案（定稿）**：固定字面库 `wpc_shadow` + `shadowDatabaseUrl` 一行（§3.1）。识别与保护 = **固定库名 + 固定连接配置 + 权限约束（仅 wpc_migrate）+ 清理白名单**（兼容方案 §2.3），**不依赖库内任何标记**（Prisma reset 会清空库内对象，标记不可靠、不建设）。
- 自动模式（`prisma_migrate_shadow_db_<后缀>` 自建自删）**不采用**——需建删任意库权限，面过宽；此结论关闭 REV3 的「A/B 两模式」讨论。
- 使用边界：wpc_shadow 仅 migrate dev 推演期间被连接，**禁止写业务数据**（随时被 reset）；wpc_smoke/wpc_app 对其零权限。
- shadow 连不上/reset 失败 → migrate dev 报错即停，不绕过、不改用 db push。

## 5. 数据迁移（dev.db → MySQL，授权 (b2)）

**源纪律（P1-6，强制）**：迁移前停止应用与定时任务、确认无其他 SQLite 写入进程（scanWriters 语义）→ 一致性读取（只读连接）→ 记录迁移前指纹（dev.db + -wal/-shm/-journal，SHA-256+size+mtime）→ 迁移后复核指纹一致；**全程不修改、不清理原始 dev.db**。

### 5.1 三模式

| 模式 | 行为 | 写入 |
|---|---|---|
| `dry-run`（默认） | 只读源+目标，输出：逐表行数计划、FK 顺序、异常清单（JSON 非法值/精度风险/唯一键冲突样本）、摘要预演 | **不产生任何持久化写入**（REV4.1·B7 口径：允许会话级 TEMPORARY TABLE 做 collation 预检，会话断开即消失，不落正式库；前后目标库摘要全等证明） |
| `apply` | 按 FK 顺序逐行 INSERT 导入（无进度表，§5.3）；完成后自动 verify | 写目标库 |
| `verify` | 只读对账：逐表行数 + 行级 SHA-256 摘要（算法真源=兼容方案 §6） | 零写入 |

### 5.2 导入前检查（dry-run 必查，异常逐条报告）

1. **主键/唯一键（P0-5，含组合唯一索引）**：
   - 源端 `PRAGMA index_list/index_info` 固化每表 PK 与**全部** UNIQUE 索引 → 目标 SHOW INDEX 对比，缺一即停；
   - **目标 Collation 冲突预检（REV4.1·B7 口径）**：dry-run 不向正式业务表写入；用**会话级 TEMPORARY TABLE**（按目标字段类型与 collation 建表）装载源数据后，在其上按 utf8mb4_unicode_ci 查冲突：
     - **NULL 语义对齐 MySQL UNIQUE**：唯一索引允许多行 NULL——只对「键列**全部非 NULL**」的行做重复判定（`WHERE 键列 IS NOT NULL … GROUP BY 键列 HAVING COUNT(*)>1`），多 NULL 不算冲突；
     - **前缀唯一索引**按 `SHOW INDEX.Sub_part` 的实际前缀长度比较（`LEFT(col, n)`），不比整列；
     - **组合唯一索引**全列参与；
     - utf8mb4_unicode_ci 大小写/重音不敏感，SQLite 下互异的值可能撞键；**真实冲突即停，人工裁决，不自动合并、不自动改值**。
   - **禁止通用 UPSERT**：`INSERT … ON DUPLICATE KEY UPDATE` 可能误更新其他记录（尤其无 PK 仅 UNIQUE 的表）——导入一律**逐行 INSERT**（按 PK/UNIQUE 预检后），主键对应关系 = **原值原样搬运（identity mapping）**，不做自增重编号；**不建 `_wpc_migration_progress` 进度表**（§5.3），重复行由 PK 存在性检查跳过（`SELECT … WHERE pk=?`：不存在→INSERT；已存在且摘要一致→跳过；已存在但不一致→报错停）。
2. **外键处理（P1-7，强制规则）**：
   - **优先按外键依赖顺序导入**（从 Prisma Schema 运行时推导拓扑序，手写清单仅作对照）；
   - 仅当存在循环依赖时才允许 `SET FOREIGN_KEY_CHECKS=0`，且**必须在同一数据库连接内**完成「关闭 → 导入 → 恢复=1」；
   - 恢复后执行**孤儿记录检查**（逐 FK 反连接验证孤儿数=0）——重新开启外键检查**不会**自动校验历史数据，此步不可省。
3. **JSON**：SQLite 侧 JSON 文本列逐值 `JSON_VALID`；合法 → RFC 8785 canonical 后存 MySQL Json 列；**非法 → 硬停报告**（表/行/列/原文片段），不静默、不猜测修复；读回比对防双重编码。
4. **NULL 与空串**：严格区分（兼容方案 §6.1：`N` vs `SL0:`），源端 '' 与 NULL 不得互转；两侧分别核对 NULL 计数。
5. **精度与时间**：DECIMAL 按列 scale 定标字符串往返；时间按兼容方案 §6.1 T 类规则（源=INTEGER Unix 毫秒，断言不猜时区）；浮点按列类型定宽比对（DOUBLE 8 字节 / FLOAT 4 字节，当前 Schema 无 Float 列——见兼容方案 §6.1 类型前提）；**任何会静默丢精度的转换 → 报错停止**。
6. **特殊字符**：emoji/引号/换行/控制符抽样 + 行摘要兜底。

### 5.3 中断恢复与幂等（实测证明，不口头保证）

- **无进度表（REV4.1·B6）**：不在正式库建 `_wpc_migration_progress`（159 行规模下 PK 存在性检查+行摘要已足够；进度记录如需只写本地 JSON 文件，不落库）——正式库只保留 Prisma Schema 的 15 张表，双向 diff empty 不受影响。中断后**重跑整个 apply**，逐行 PK 存在性检查跳过已导入行（成本可忽略）。
- 验收两个实测证明：①同源连续 apply 两次 → verify 摘要与一次 apply 后全等（幂等）；②人为中断后重跑 → verify 与一次性成功样本全等（断点恢复）。

### 5.4 搬迁验收基准（P0-1 定案）

- **15 表 / 合计 159 行**（2026-11-13 只读实测：Account 1 / Angle 33 / Article 12 / ComicPanel 0 / LlmModel 4 / ModelBinding 7 / RunLog 3 / Setting 24 / StylePrompt 42 / TaskRun 11 / Track 6 / TrackPipeline 12 / User 3 / UserSession 1 / WechatToken 0；REV3 的「158」为总计笔误，各表明细无误）；
- verify = 逐表行数与上述基准一致 + 逐表行级摘要两边全等 + 源指纹前后一致。

## 6. migrate diff 验收（库 ↔ schema 一致）

**参数用 Schema datasource 形态（REV4.1·B5，只保留这一套）**：`--from-schema-datasource` / `--to-schema-datasource`（Prisma 5.22 支持；Prisma 7 才移除）——连接 URL 由 Schema 的 `env("DATABASE_URL")` 解析，经包装脚本覆盖为 MIGRATE_DATABASE_URL，**命令行不含 URL/密码**（不再使用 `--from-url`/`--to-url`，避免密码暴露在进程参数）：

```
方向 A：--from-schema-datasource --to-schema-datamodel prisma/schema.prisma --script --exit-code
方向 B：--from-schema-datamodel prisma/schema.prisma --to-schema-datasource --script --exit-code
```

- 验收输出：`This is an empty migration`。退出码语义（Prisma 5.22 官方）：**无差异=0、有差异=2、执行错误=1**——实施期首跑仍做一次实测确认并记入报告。
- 任一方向非 empty → 差异 SQL 全文留档 → 停下分析，禁止直接 apply。
- **migrate status 定位修正**：只核对迁移目录与 `_prisma_migrations` 账目状态，**不是**完整 Schema drift 检测工具；drift 依靠 migrate dev 的 shadow 推演与本节 diff。
- 命令经 Node 包装注入 env（§3.2）。
- **四类对象补查**（Prisma 不管 VIEW/TRIGGER/PROCEDURE/EVENT，diff 亦不覆盖）：初始化验收四项全空；恢复/备份验证逐对象比对；未来生产出现手工对象须单独登记入迁移。

## 7. 之后的日常迁移机制

改 Schema → `npm run db:migrate -- --name <变更名>`；生产 → `migrate deploy`。迁移文件入 git 评审；无 down migration，回滚=备份恢复；破坏性变更走多步。备份：迁移前 mysqldump 留档，恢复验证=dump→一次性库→行数/摘要比对（纸面不算，输出留档才算过）。

## 8. 验收标准（P2-A 完成时）

1. 八步顺序逐项留档（③的九项查询输出 + ④安全检查）；迁移目录为实际生成名；`migrate status` up to date；
2. migrate diff 双向 empty + 退出码留档；四类对象全空；shadow 状态符合 §4 预期；
3. generate V1/V2 通过（V3 归 P2-B）；
4. 搬迁：15 表 159 行 + 逐表摘要全等 + 幂等/断点/ dry-run 三个实测证明 + 唯一键冲突预检报告；
5. dev.db 前后指纹（含 wal/shm/journal）一致；同实例其他库零触碰（结构性证明）。

## 9. 风险与缓解（压缩）

| 风险 | 缓解 |
|---|---|
| 连错实例/库 | ③九项查询留档 + 反白名单 |
| 非空库误推 | ④空库检查 + §1 状态不明即中止 |
| 唯一键 collation 冲突 | §5.2-1 目标 collation 预检，冲突硬停 |
| 通用 UPSERT 误更新 | 逐行 INSERT + PK identity mapping（§5.2-1） |
| JSON/精度静默丢失 | 硬停报错（§5.2-3/5） |
| 搬迁中断/源被写 | 断点+幂等实测证明；只读+指纹（§5.3/5.4） |
| Windows env/密码泄漏 | Node 包装 + 脱敏（§3.2） |
