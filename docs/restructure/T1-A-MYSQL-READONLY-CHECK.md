# T1-A-MYSQL-READONLY-CHECK · MySQL 只读检查操作指南
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

> **性质**：T1-A 方案二次审核轮交付物。目标：在建 Baseline 前完成真实 MySQL 数据库检查（授权书 二-2）。
> **安全规则**：全程只读；**禁止在聊天中发送生产数据库密码**；凭据只存在于您本机（环境变量 / 交互输入 / `~/.my.cnf`）；输出报告不含任何凭据。本指南除「建只读账号」的 DCL 语句（一次性、由 DBA 执行）外**不含任何写语句**。
> 当前差异检查状态：**【未执行】**（无只读凭据）——本指南执行后产出。

---

## 1. 已确认事实与信息缺口（本轮只读盘点）

**已确认**：

| 项 | 事实 | 证据 |
|---|---|---|
| 本机 3306 | Windows 服务 `MySQL`（Running / Auto），`D:\Soft\MySql\mysql-8.0.30-winx64\bin\mysqld`，MySQL 8.0.30 手动安装版 | 服务与进程查询（本轮） |
| 生产部署形态 | Linux 服务器：生产推荐 systemd + Nginx（`deploy/README.md`）；另有 `docker-compose.yml` 快速/自托管路线（`db` 服务 `mysql:8.0`，utf8mb4/utf8mb4_unicode_ci） | deploy/README、docker-compose.yml |
| 生产库名 | `wechat_pipeline`（`deploy/app.env.example` 的 `DATABASE_URL` 与 compose `MYSQL_DATABASE` 两处一致） | 两文件原文 |
| 生产凭据存放 | 服务器 `/etc/wechat-pipeline-cloud/app.env`（chmod 600），连接串形如 `mysql://…@127.0.0.1:3306/wechat_pipeline` | deploy/README §二 |
| 结构历史 | 生产从未有正式迁移（靠 `db push` / `ALLOW_DB_PUSH=1`） | deploy/README §四 |

**缺口（= 本指南要补的）**：

1. 本机 3306 那个 MySQL 的**用途定性**（开发自测 / 曾经的本地生产 / 其他）；
2. 云端生产 MySQL 的**实际位置确认**（哪台服务器、systemd 还是 Docker、可达通道）；
3. 生产库**实际结构**与 `prisma/schema.prisma` 的**完整差异**；
4. 生产库版本/字符集/引擎实况、是否有任何迁移标记残留、备份现状。

---

## 2. 执行方式（二选一，凭据都不进聊天）

**方式 A（推荐）：给我只读账号，我来跑。** 由 DBA/您在目标库执行一次：

```sql
-- 一次性 DCL（唯一允许的非只读语句；口令请自行生成，不要发到聊天里）
CREATE USER 'wpc_ro'@'%' IDENTIFIED BY '<强口令>';
GRANT SELECT ON *.* TO 'wpc_ro'@'%';
FLUSH PRIVILEGES;

-- 验证（应只列出 USAGE + SELECT）
SHOW GRANTS FOR 'wpc_ro'@'%';
```

之后把**连接参数**给我时只给：主机、端口、库名、用户名；口令通过本机环境变量传入（例如我跑命令时用 `MYSQL_PWD` 环境变量，不落文档、不进对话记录）。

**方式 B：您自跑脚本，回传输出。** 在有凭据的机器上执行 §3 脚本包，把输出整理成 §6 格式发我（输出里不含密码即可）。

---

## 3. 只读检查脚本包（复制即用；MySQL 8.0 / MariaDB 通用 information_schema 口径）

> 全部为 `SELECT`/`SHOW`。运行前 `USE wechat_pipeline;` 或把 `DATABASE()` 替换为实际库名。

### 3.0 连接与实例身份

```sql
SELECT VERSION() AS version, @@hostname AS host, @@port AS port, @@datadir AS datadir,
       @@character_set_server AS cs_server, @@collation_server AS coll_server,
       CURRENT_USER() AS connected_as, DATABASE() AS current_db;
```

### 3.1 库与默认字符集

```sql
SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'wechat_pipeline';
```

### 3.2 表清单（引擎 / 行数估计 / 字符集 / 创建时间）

```sql
SELECT TABLE_NAME, ENGINE, TABLE_ROWS, TABLE_COLLATION, CREATE_TIME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'wechat_pipeline'
ORDER BY TABLE_NAME;
```

### 3.3 字段全量（类型 / 可空 / 默认值 / Extra / 字符集 / 序号）

```sql
SELECT TABLE_NAME, ORDINAL_POSITION AS pos, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
       COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'wechat_pipeline'
ORDER BY TABLE_NAME, ORDINAL_POSITION;
```

### 3.4 索引与唯一约束

```sql
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'wechat_pipeline'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
-- 唯一约束 = NON_UNIQUE = 0 的索引
```

### 3.5 主键 / 唯一 / 外键约束（含删除更新动作）

```sql
SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
       kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
FROM information_schema.TABLE_CONSTRAINTS tc
LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
  AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  AND tc.TABLE_NAME        = kcu.TABLE_NAME
WHERE tc.TABLE_SCHEMA = 'wechat_pipeline'
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME;

SELECT CONSTRAINT_NAME, UNIQUE_CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = 'wechat_pipeline';
```

### 3.6 期望 DDL 对照件生成（在**开发机**执行，零连接、不碰任何库）

```bash
cd server
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > t1a-expected-mysql-ddl.sql
```

**本轮已实证**（Prisma 5.22）：exit=0、321 行、命令不连库；SHA-256
`312e765c749ef32e5b8c8d83b7d7f82e5986408eb5c9c24ccd7cf823f2f2f6e1`；内容含表级
`DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` 与全部外键
（尾部样例：`ALTER TABLE \`ModelBinding\` ADD CONSTRAINT … FOREIGN KEY (\`modelId\`) REFERENCES \`LlmModel\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`）。
生成产物暂存 `server/var/tmp/t1a-expected-mysql-ddl.sql`（scratch，可随时再生成）。

### 3.7 漂移 diff（只读；连目标库，执行前肉眼确认 URL）

```bash
# 实测库 → schema 期望：非空输出 = 差异清单（喂给 Baseline 步骤②）
npx prisma migrate diff --from-url "mysql://wpc_ro@<host>:3306/wechat_pipeline" \
  --to-schema-datamodel prisma/schema.prisma --script

# 实测库 DDL 导出（0_init 语义源；连库）
npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script
```

⚠️ `--to-schema-datasource` / `--from-url` 都**会连库**（只读）；跑之前确认 URL 指向目标实例（本机 or 生产），防误连。
⚠️ 跨 provider diff 不受支持（Prisma 官方）——本命令只能 MySQL 对 MySQL。

---

## 4. 覆盖要求逐项对照（授权书 9 项 ↔ 脚本节）

| 授权书要求 | 脚本节 |
|---|---|
| 表 | 3.2 |
| 字段 | 3.3 |
| 类型 | 3.3 `COLUMN_TYPE` |
| 默认值 | 3.3 `COLUMN_DEFAULT`（注意 `EXTRA` 里的 `on update`/生成列） |
| 主键 | 3.5（`CONSTRAINT_TYPE='PRIMARY KEY'`） |
| 索引 | 3.4 |
| 唯一约束 | 3.4 `NON_UNIQUE=0` + 3.5 `UNIQUE` |
| 外键 | 3.5 第二条查询（含 UPDATE/DELETE 规则） |
| 字符集 | 3.1 + 3.2 `TABLE_COLLATION` + 3.3 `CHARACTER_SET_NAME/COLLATION_NAME` |

---

## 5. 身份判定决策树（请您确认）

| # | 问题 | 我们已有的线索 | 影响 |
|---|---|---|---|
| Q1 | 本机 3306（Windows 服务 `MySQL`@`D:\Soft\MySql\…`）的用途？开发自测 / 曾经的本地生产 / 其他 | 手动安装、服务自启动；与云端无关 | 决定本机库是否纳入基线范围（大概率不纳入，仅开发用） |
| Q2 | 云端生产 = systemd 裸机（deploy/README 推荐）还是 Docker compose 自托管？服务器/库的可达通道是什么？ | 两条路线文档都有 | 决定只读检查怎么执行（SSH 代跑 / 只读账号远程连） |
| Q3 | 生产库是否曾被手工修过结构（热修）？谁、什么时候跑过 `db push`？ | 无迁移历史可查 | 0_init 从实测反推（BASELINE D1），热修须在差异清单里对上号 |
| Q4 | 生产备份现状？最近一次 mysqldump 时间、是否验证过可恢复？ | deploy 前置项要求「至少每天一次」 | 备份演练 M1-M5 的起点 |
| Q5 | 凭据交付方式：A 建 `wpc_ro` 只读账号 / B 您自跑 §3 回传输出？ | — | 决定差异检查的执行方 |

---

## 6. 输出物与回传格式

产出一份 `t1a-mysql-schema-report.md`（不含任何凭据），结构：

1. §3.0–3.5 全量输出（可贴原文或 TSV 附件）；
2. §3.7 漂移 diff 输出（如有差异，按【缺表/多表/列类型/默认值/索引/唯一/外键/字符集/引擎】分类）；
3. §5 五问的答案；
4. 结论：与 `prisma/schema.prisma` 的差异清单（喂入 `T1-A-BASELINE-REVISED.md` 步骤②③）。

**回传要求**：文件里不含主机密码；`mysql` 系统库不查不传；`SELECT` 输出里若含业务敏感字段（凭据密文等），报告只留表结构、不留数据行。
