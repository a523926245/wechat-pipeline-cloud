# T1-A-BACKUP-RESTORE-REVISED · 备份恢复与隔离演练方案
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

> **性质**：T1-A 方案二次审核轮，纯方案文档。本轮未执行任何备份/恢复/迁移操作。
> **铁则（回应授权书「不得将纸面方案标记为实际通过」）**：每项验收必须有**真实输出/文件留档**才算通过；本文所有条目当前状态 = **【未执行】**；「未执行」不得在任何报告中写成通过（授权书六）。
> 演练位置约定：SQLite 恢复目标 = `server/var/tmp/restore-drill/`（隔离路径）；MySQL 恢复目标 = 一次性库 `wpc_restore_drill_YYYYMMDD`。**任何演练都绝不覆盖 `dev.db` 或生产库。**

---

## 1. 通用原则

1. **演练隔离**：恢复只落在隔离路径/一次性库；恢复完成后校验，校验过的副本才可作为「可恢复性」证据。
2. **逐步留档**：每步记录命令原文、完整输出、时间戳、涉及文件的 SHA-256/size/mtime。留档目录（实施后）：`docs/restructure/T1-A-DRILL-LOGS/`。
3. **失败即门禁失败**：S/M 任一项未通过 → `T1-A-BASELINE-REVISED.md` 的步骤④不成立 → 禁止 Baseline 登记。
4. **纸面不算**：命令没跑 = 未执行；跑了但输出没留档 = 未执行；只有「命令 + 输出 + 判据比对全等」三件齐才写通过。

---

## 2. SQLite 验收标准（S1–S6）

| # | 验收项 | 操作（命令以实施期实测为准） | 通过判据 | 留档物 | 状态 |
|---|---|---|---|---|---|
| S1 | **备份** | `sqlite3 prisma/dev.db ".backup 'var/tmp/restore-drill/dev-backup.db'"`（`.backup` API / `VACUUM INTO` 一致性快照，避免文件复制时撞写入撕裂；`journal_mode=delete` 现状同样适用） | 备份件生成且 >0 字节；记录 SHA-256/size/mtime | 指纹表 | 【未执行】 |
| S2 | **完整性验证** | 对备份件：`PRAGMA integrity_check;` `PRAGMA foreign_key_check;` | `integrity_check` 输出恰为 `ok`；`foreign_key_check` 结果集为空 | 两条查询输出原文 | 【未执行】 |
| S3 | **行数核对** | 15 张业务表逐表 `SELECT COUNT(*)`：备份件 vs 原库 | 逐表**完全相等**（15/15） | 对照表 | 【未执行】 |
| S4 | **索引和结构核对** | `SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name;` 全量 dump 两边比对（或 `prisma migrate diff --from-url <备份件> --to-url <原库副本> --script` 双向 empty） | dump 逐行一致 / diff 为空 | dump 或 diff 输出 | 【未执行】 |
| S5 | **实际恢复** | 将备份件复制为 `var/tmp/restore-drill/dev-restored.db`（**绝不**写回 `dev.db`），对恢复件重跑 S2+S3+S4 | 恢复件全部通过 S2-S4 判据 | 恢复件指纹 + 复跑输出 | 【未执行】 |
| S6 | **恢复后验证** | (a) 三 smoke 全量经 T0 隔离运行器执行（`npm run smoke:lint` / `smoke:style` / `smoke:angles`）；(b) 对**恢复件**跑代表性只读查询（最新文章×3、StylePrompt 计数、Track↔TrackPipeline 关联×1、LlmModel×1）与 S3 快照比对 | (a) 全绿且计数不降（lint 116 / style 33 / angles 当场计数）；(b) 查询结果与快照一致 | smoke 输出 + 查询输出 | 【未执行】 |

**S6 口径如实说明**：T0 隔离运行器自建 `dev.smoke-*.db` 并强制隔离校验（T0 四件套冻结），smoke **不直接打在恢复件上**。因此「恢复后运行 Smoke Test」按 (a)+(b) 组合验收：(a) 证明代码层健康，(b) 证明恢复件数据保真。若未来要求 smoke 直接指向恢复件，需单独授权改造 T0（本次不做）——此界定如实写入报告，不做夸大表述。

---

## 3. MySQL 验收标准（M1–M5）

| # | 验收项 | 操作 | 通过判据 | 留档物 | 状态 |
|---|---|---|---|---|---|
| M1 | **一致性备份** | `mysqldump --single-transaction --quick --routines --triggers --set-gtid-purged=OFF --result-file=backup.sql wechat_pipeline`（InnoDB 一致性读；**不** dump `mysql` 系统库） | dump 生成；记录 SHA-256/大小/dump 头部（服务器版本、字符集变量）；dump 末尾含 `Dump completed` | 指纹表 + dump 头尾摘录 | 【未执行】 |
| M2 | **独立隔离数据库恢复** | `CREATE DATABASE wpc_restore_drill_YYYYMMDD;`（**仅**一次性库；严禁导回生产库）→ `mysql wpc_restore_drill_YYYYMMDD < backup.sql` | 导入无 ERROR 结束 | 完整导入输出 | 【未执行】 |
| M3 | **表结构、索引、行数核对** | 对隔离库跑 `T1-A-MYSQL-READONLY-CHECK.md` §3 全套只读查询，与备份前快照（M1 同轮取）逐项比对；行数逐表 `COUNT(*)` | 表清单/列/类型/默认值/主键/索引/唯一/外键/字符集全等；行数逐表相等 | 比对报告 | 【未执行】 |
| M4 | **恢复后的业务验证** | 只读代表性查询（用户表计数、凭据记录掩码读、文章最新 N 行、赛道管道关联）；**可选**：应用指向隔离库跑只读 API 冒烟（`AUTO_PUBLISH=false` 恒成立；需单独授权，本轮不预设） | 查询结果与备份前快照一致 | 查询输出 | 【未执行】 |
| M5 | **失败恢复策略** | 预检：先在第三个一次性库 `wpc_dryrun_*` 试导入（可解析性）；恢复中断 → `DROP DATABASE` 隔离库重来；核对失败 → 演练**失败**记录 + 重取备份 + 复盘。**生产恢复**另行定义（维护窗口 + 人工授权 + 逐表核对），与演练分离 | 预检/重试/失败记录三类路径各有实测或书面预案；演练失败绝不写成通过 | 路径记录 | 【未执行】 |

**Docker 路线备注**：`docker-compose.yml` 的 `db-data` 卷快照可作备份补充手段（快速自托管场景），与 `mysqldump` 的取舍在实施报告中说明；生产（systemd 路线）以 mysqldump 为准（deploy/README 上线前置项第 8 条：至少每天一次 mysqldump，`APP_SECRET_KEY` 与备份分开存放）。

---

## 4. 状态总表（本轮结论）

| 项 | 状态 | 项 | 状态 |
|---|---|---|---|
| S1 备份 | 【未执行】 | M1 一致性备份 | 【未执行】 |
| S2 完整性 | 【未执行】 | M2 隔离恢复 | 【未执行】 |
| S3 行数核对 | 【未执行】 | M3 结构/索引/行数 | 【未执行】 |
| S4 索引/结构 | 【未执行】 | M4 业务验证 | 【未执行】 |
| S5 实际恢复 | 【未执行】 | M5 失败恢复策略 | 【未执行】 |
| S6 恢复后验证 | 【未执行】 | | |

**本轮没有任何一项被标记为通过**；全部待 T1-A 实施授权后执行并留档到 `docs/restructure/T1-A-DRILL-LOGS/`。

---

## 5. 实施阶段执行顺序（不可倒置）

1. S1–S4（SQLite 备份与核对）→ S5 恢复 → S6 验证；
2. M1–M3（MySQL 备份与核对）→ M4 → M5 路径实测；
3. 全部通过后，`T1-A-BASELINE-REVISED.md` 步骤④才成立，允许进入 ⑤–⑧；
4. 任一失败：停在原地，出失败报告（现象/输出/处置建议），等用户决策——不绕过、不降级判据。
