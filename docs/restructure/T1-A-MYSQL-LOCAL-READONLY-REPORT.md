# T1-A 补充决策 · 本机 MySQL 只读检查报告
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13
- **授权范围**：只读检查。未创建/删除/修改任何数据库，未执行 db push / migrate dev / migrate deploy / migrate resolve，未修改 Schema、代码、环境变量、npm scripts，未创建 migration 文件，未删除 dev.db 及任何 SQLite 文件。
- **检查对象**：本机 MySQL 8.0.30（已确认为唯一正式开发数据库）。
- **结论速览**：**`wechat_pipeline` 库在本机 MySQL 中不存在**——本机 MySQL 尚未被本项目使用过，是全新起点，**无历史结构、无 Baseline 误判风险**。用户权限检查因无凭据**未验证**（详见 §5）。

---

## 1. 服务、版本与连接状态

| 项 | 实测值 | 证据方式 |
|---|---|---|
| Windows 服务名 | `MySQL` | `Get-CimInstance Win32_Service` |
| 服务状态 | **Running**，启动类型 **Auto** | 同上 |
| 服务二进制 | `D:\Soft\MySql\mysql-8.0.30-winx64\bin\mysqld MySQL` | 服务 PathName |
| 版本 | **mysql.exe Ver 8.0.30 for Win64 on x86_64 (MySQL Community Server - GPL)** | `mysql.exe --version` |
| 端口 | 3306 | `my.ini`：`port=3306` |
| datadir | `D:\Soft\MySql\mysql-8.0.30-winx64\data` | `my.ini`：`datadir=` |
| 客户端 | `D:\Soft\MySql\mysql-8.0.30-winx64\bin\mysql.exe`（PATH 可用） | `which mysql` |

连接状态：**TCP 3306 在监听**（T0 轮已实测 netstat）；客户端可达服务端（认证层拒绝见 §5）。

## 2. 数据库身份与「开发 / 生产」区分

| 实例 | 身份 | 与本项目关系 |
|---|---|---|
| **本机 MySQL 8.0.30（127.0.0.1:3306）** | 个人 Windows 开发机，手动安装版（非托管服务） | **唯一正式开发数据库**（本轮决策确认） |
| 云端生产 MySQL | 项目**尚未上生产**（用户确认）；`deploy/` 文档所述 Linux 部署路线为**未来部署形态**，届时生产亦用 MySQL | 未来生产环境，与本机实例无关，本轮未接触 |

同实例还存在其他项目数据库（见 §3），**不属于本项目，全程未触碰**。

## 3. 现有数据库清单（datadir 目录级证据，只读）

MySQL 8 InnoDB 每库对应 datadir 下一个目录。只读列目录：

```
crm
mysql
performance_schema
sys
test_db
wechat_publisher
wx_task_pocket
wx_task_pocket_shadow_diff
```

（另有 `#innodb_redo` / `#innodb_temp` 等引擎内部目录，非用户库。）

- **`wechat_pipeline` 不存在**（`ls data/wechat_pipeline/` → No such file or directory）。
- 同实例其他库（`crm` / `wechat_publisher` / `wx_task_pocket` / `wx_task_pocket_shadow_diff` / `test_db`）属其他项目/工具，**本项目切换后只建只动自己的库，与它们隔离**。
- **注意**：`binlog.0001xx` 文件序列显示实例开了 binlog——将来建库/建表都会进 binlog，属于实例级正常行为；本项目不做任何主从/复制配置。

## 4. 目标库结构与数据量检查（表/字段/索引/约束/数据量）

**N/A —— 目标库不存在，无对象可查。**

本授权要求的「表、字段、类型、默认值、NULL、主键、索引、唯一约束、外键、字符集、排序规则、存储引擎」检查，在 `wechat_pipeline` 不存在的前提下无检查对象。这正是最干净的初始化情形：

- 无既有结构 → **无「生产历史结构 vs schema.prisma」差异可言**（上一轮 T1-A1 担心的 Baseline 误判问题在本机开发库上不存在）；
- 初始化时结构将直接由 `prisma/schema.prisma` 产生（见 `T1-A-PRISMA-MIGRATE-INIT-PLAN.md`）。

视图/触发器/存储过程/事件检查：同为 N/A（库不存在）。初始化后这些对象由本项目从零管理（Prisma 不建触发器/存储过程，预期为空）。

## 5. MySQL 用户权限 —— 【未验证】

**实测**：

```
$ mysql --user=root --host=127.0.0.1 --port=3306 -e "SELECT VERSION(); SHOW DATABASES;"
ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)
```

- root 设置了密码；空密码被拒（此前对 `wechat` / `root` + 样例密码的尝试同为 Access denied）。
- `server/.env` 当前只有 `DATABASE_URL="file:./dev.db"`，无 MySQL 凭据；本轮禁止修改环境变量，故本轮**不可能**完成凭据接入。
- 无 `~/.my.cnf` / `~/.mylogin.cnf`；`my.ini` 无凭据信息。

**待用户配合（二选一，凭据不进聊天）**：

- **A（推荐）**：在本机 MySQL 建一个开发专用账号，把连接串写进 `server/.env`（该文件已被 `.gitignore` 覆盖，不会入库）。建议给本项目用的最小权限：

```sql
-- 以 root 在本机 MySQL 执行（用户自跑）
CREATE USER 'wpc_dev'@'localhost' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON wechat_pipeline.* TO 'wpc_dev'@'localhost';
GRANT CREATE, DROP ON wechat_pipeline.* TO 'wpc_dev'@'localhost';
-- 若希望 runner 能建/删冒烟临时库（T0-v2 用）：
GRANT CREATE, DROP ON `smoke\_%`.* TO 'wpc_dev'@'localhost';
FLUSH PRIVILEGES;
```

- **B**：直接把 root 密码写进 `server/.env` 的 `DATABASE_URL`（简单但权限过大，不推荐）。

凭据就位后的只读权限检查命令（供补查）：

```sql
SELECT USER(), CURRENT_USER(), VERSION();
SHOW GRANTS;
SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
  FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'wechat_pipeline';
```

## 6. 本轮检查命令与输出留档

| # | 命令（只读） | 关键输出 |
|---|---|---|
| 1 | `Get-CimInstance Win32_Service`（Name like *SQL*） | 服务 `MySQL`，Running/Auto，PathName=`…\mysqld MySQL` |
| 2 | `mysql.exe --version` | Ver 8.0.30 for Win64 on x86_64 (MySQL Community Server - GPL) |
| 3 | `grep port/datadir my.ini` | port=3306；datadir=`D:\Soft\MySql\mysql-8.0.30-winx64\data` |
| 4 | `ls -d data/*/`（目录清单） | 8 个用户库，**无 wechat_pipeline**（§3） |
| 5 | `ls data/wechat_pipeline/` | No such file or directory |
| 6 | `mysql -uroot -e "SELECT VERSION(); SHOW DATABASES;"` | ERROR 1045 Access denied（§5） |
| 7 | `grep DATABASE_URL server/.env` | `DATABASE_URL="file:./dev.db"`（无 MySQL 凭据） |
| 8 | `ls ~/.my.cnf ~/.mylogin.cnf` | 均不存在 |

## 7. 未解决问题

1. **MySQL 账号凭据未接入**（§5）——阻塞「用户权限」检查与后续建库；请用户按 §5-A/B 之一提供（不进聊天）。
2. `wechat_publisher` / `wx_task_pocket` 等库与本机历史项目的关系未查（**不属本轮范围**，仅记录存在，切换后互不影响）。
3. 实例级参数（字符集默认值、binlog 格式、sql_mode）未连库查看——初始化方案中会显式指定 `utf8mb4`，不依赖实例默认值；`sql_mode` 差异列入切换回归注意项。
