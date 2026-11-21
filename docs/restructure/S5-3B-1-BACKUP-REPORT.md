# S5-3B-1 · 业务库完整备份执行报告

- **日期**：2026-11-17 09:52（GMT+8）
- **授权**：仅备份。**不授权** Migration 部署、不授权改 `.env`、不授权停服务、不授权 Git 写操作。
- **执行结论**：✅ **SUCCESS** —— 一次性完整备份已落盘并校验，业务库零写入。

---

## 1. 数据库身份核验（实测，临时进程级连接）

| 项 | 实测 | 预期 | 结果 |
|---|---|---|---|
| `DATABASE()` | `wechat_pipeline` | `wechat_pipeline` | ✅ |
| `CURRENT_USER()` | `wpc_app@127.0.0.1` | `wpc_app@127.0.0.1` | ✅ |
| `VERSION()` | `8.0.30` | `8.0.30` | ✅ |
| `@@port` | `3306` | `3306` | ✅ |

连接方式：读取 `server/.env` 的 `DATABASE_URL`，**仅在内存中替换库名段**为 `wechat_pipeline`（复用原凭据），未写任何配置文件、未打印连接串或密码。`mysqldump` 的密码通过 `MYSQL_PWD` 环境变量传入，**不在命令行参数、日志或本报告中出现**。

## 2. 数据库盘点（只读，`information_schema`）

| 项 | 实测 |
|---|---|
| 表总数 | **17**（全部 `BASE TABLE`，视图 0） |
| 数据量 | 数据 0.33 MB + 索引 0.61 MB = **约 0.94 MB**；`TABLE_ROWS` 合计约 67 行 |
| 存储引擎 | **17/17 = InnoDB**，非 InnoDB 表 **0** → `--single-transaction` 一致快照安全 |
| 存储过程 / 函数 | **0** |
| 触发器 | **0** |
| 事件（EVENT） | **0** |
| 服务器参数 | `gtid_mode=OFF`、`character_set_server=utf8mb4`、`lower_case_table_names=1` |

## 3. 备份执行

| 项 | 值 |
|---|---|
| 备份目录（**项目目录之外**） | `K:/WorkBuddy WorkSpace/backups/wechat-pipeline-cloud/` |
| 文件完整路径 | `K:/WorkBuddy WorkSpace/backups/wechat-pipeline-cloud/wechat_pipeline_pre_s5-3b-1_20261117_095219.sql` |
| 文件大小 | **84,663 字节**（≈ 82.7 KB） |
| `mysqldump` 退出码 | **0**（stderr 为空） |
| 耗时 | 约 1 秒 |

命令（密码经 `MYSQL_PWD` 传入，此处以 `***` 占位；未使用 `--result-file`，先检查文件不存在再重定向，`set -o noclobber` 兜底防覆盖）：

```bash
MYSQL_PWD=*** mysqldump -h 127.0.0.1 -P 3306 -u wpc_app \
  --single-transaction --quick --routines --triggers --events \
  --hex-blob --no-tablespaces --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 wechat_pipeline > <备份文件>
```

## 4. 备份校验

| 校验项 | 结果 |
|---|---|
| 退出码 0 | ✅ |
| 文件存在且 >0 字节 | ✅ 84,663 字节（与库体量 0.94 MB 量级相符：InnoDB 页有大量空闲空间，逻辑 SQL 远小于物理页） |
| 头部 | `MySQL dump 10.13 Distrib 8.0.30 for Win64`，`Host: 127.0.0.1  Database: wechat_pipeline` |
| 尾部 | `-- Dump completed on 2026-11-17 9:52:20`（完整性标志） |
| `CREATE TABLE` 数 | **17**（与库内表数一致） |
| 表清单 | `_prisma_migrations, account, angle, article, comicpanel, llmmodel, modelbinding, runlog, setting, styleprompt, taskrun, topicreview, track, trackpipeline, user, usersession, wechattoken` |
| 含 `_prisma_migrations` | ✅ 出现 8 次（建表 + 4 行数据） |
| 含 `ArticleLintRun` | **0 次**（与「表尚未创建」一致，符合预期） |
| 含数据的表 | `_prisma_migrations` / `llmmodel` / `setting` / `styleprompt` / `user` / `usersession`（其余 11 表为空，`INSERT` 语句 6 条） |
| **SHA-256** | `0ddfe00f23d17c5b181e7d3a8e76a6bef391aecd39700a89358e1a2ca3ff4ff8` |

**边界说明（不夸大）**：以上是**文件级校验**，**不等于恢复验证**。本轮按授权未做恢复演练（未导入任何隔离库），因此「备份可恢复性」属于**未验证**项。

## 5. 备份后 Migration 状态复核（只读）

| 项 | 实测 | 与 S5-3A 对比 |
|---|---|---|
| `DATABASE()` | `wechat_pipeline` | 一致 |
| 表总数 | 17 | 一致 |
| `ArticleLintRun` 是否存在 | **不存在**（`information_schema` 0 行） | 一致 |
| `_prisma_migrations` 行数 | 4（3 条已应用 + 1 条历史 rolled-back） | 一致 |
| 未完成 / 失败迁移 | **0**（`finished_at IS NULL AND rolled_back_at IS NULL` 无记录） | 一致 |
| `20261116120000_add_article_lint_run` 记录 | 无（未应用） | 一致 |
| `prisma migrate status` | `4 migrations found`，仅 `20261116120000_add_article_lint_run` 待应用；`Datasource "db": MySQL database "wechat_pipeline" at "127.0.0.1:3306"` | 一致 |

## 6. 操作边界确认

| 约束 | 结果 |
|---|---|
| 写入/修改业务库 | ✅ 零写入（仅 `SELECT` 与 `mysqldump` 一致性读） |
| 执行 Migration（deploy/dev/push/resolve/reset） | ✅ 未执行 |
| 修改 `.env` 或其他连接配置 | ✅ 未修改（仅在进程内替换库名） |
| 停止/重启 API、scheduler | ✅ 未操作 |
| smoke / verify / Fingerprint 脚本 | ✅ 未执行 |
| Git add/commit/push/reset/checkout/stash | ✅ 未执行 |
| 覆盖已有备份 | ✅ 未覆盖（目录内仅新增 1 个文件，执行前已确认目标名不存在） |
| 上传外部服务 | ✅ 未上传 |
| 密码出现在参数/日志/报告 | ✅ 未出现（`MYSQL_PWD` 传入，报告以 `***` 占位） |

## 7. 遗留与下一步

1. **备份可恢复性未验证**（未做恢复演练）。若 S5-3B-2 要求更高保障，可另行授权在一次性库 `wpc_restore_drill_YYYYMMDD` 做一次导入验证——**本轮不做**。
2. **`server/.env` 仍指向 `wechat_pipeline_smoke`**（本轮禁止修改）。部署轮必须显式覆盖 `DATABASE_URL` 或先改 `.env`，否则 `migrate deploy` 会打到测试库。
3. **`ArticleLintRun` 迁移仍未部署**，业务库结构与 S5-3A 完全一致。
4. 本备份的 SHA-256 已记录在案，可作为部署前基线；部署后若需回滚判断，以「表是否存在」为主、以该备份为辅（迁移是纯新增，回滚优先「不回滚结构」）。
