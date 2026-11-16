# S4-1-MIGRATION-DEPLOY-REPORT：真实业务库 Migration 部署执行记录

- **日期**：2026-11-14 19:56（晚）
- **授权**：用户正式授权，仅部署 `20261114093000_add_angle_status_topic_review` 至业务库 `wechat_pipeline`。前置核查 `S4-1-PRE-MIGRATION-CHECK-REPORT.md` 结论 PASS。
- **执行结论：✅ SUCCESS —— 迁移按预期应用，全部部署后验证通过，S4-1 数据结构正式启用。**

---

## 1. 执行前数据库身份核验（只读）

| 项 | 实测 | 预期 | 结果 |
|---|---|---|---|
| 连接目标（不含凭据） | `127.0.0.1:3306/wechat_pipeline`，用户 `wpc_app` | 本机 3306 / wechat_pipeline / wpc_app | ✅ |
| `DATABASE()` | `wechat_pipeline` | wechat_pipeline | ✅ |
| `CURRENT_USER()` | `wpc_app@127.0.0.1` | wpc_app@127.0.0.1 | ✅ |
| `@@version` | `8.0.30` | 本机 MySQL 8.0.30 | ✅ |
| `@@port` | `3306` | 3306 | ✅ |

执行前 `npx prisma migrate status`：3 migrations found，**仅** `20261114093000_add_angle_status_topic_review` 待应用；`prisma/migrations/` 仍为 3 个目录（无新增）；Git 工作区无代码/Migration 变更（仅上轮报告文档未跟踪）。凭据全程未输出。

## 2. 执行的准确命令及结果

```bash
cd "K:/WorkBuddy WorkSpace/project/wechat-pipeline-cloud/server"
npx prisma migrate deploy
```

实际输出（关键段）：
```
3 migrations found in prisma/migrations
Applying migration `20261114093000_add_angle_status_topic_review`
The following migration(s) have been applied:
migrations/
  └─ 20261114093000_add_angle_status_topic_review/
    └─ migration.sql
All migrations have been successfully applied.
```

## 3. 实际应用的 Migration

**仅一个**：`20261114093000_add_angle_status_topic_review`（与授权范围完全一致，无其他迁移被应用）。

## 4. migrate status（部署后）

`npx prisma migrate status` → **`Database schema is up to date!`**（Prisma 该版本的「无待应用迁移」表述；无 pending、无失败、无 drift）。

## 5. 新字段、新表及索引核验（information_schema 实测）

**Angle 新列（column_count=3 ✅）**：
| 列 | 类型 | NULL | DEFAULT |
|---|---|---|---|
| `status` | enum('candidate','needs_revision','approved','rejected') | NO | 'candidate' |
| `reviewRound` | int | NO | 0 |
| `metaJson` | json | YES | NULL |

**TopicReview 表（table_count=1 ✅）**，11 列与 schema 一一对应：
`id(int, PK, AUTO_INCREMENT) / angleId(int) / round(int) / scoresJson(json) / riskHits(json) / dupHits(json) / verdict(enum('approved','needs_revision','rejected')) / reason(varchar(500)) / model(varchar(64)) / reviewedBy(varchar(64)) / createdAt(datetime(3))`

**索引**：
- `Angle_trackId_status_seq_idx (trackId,status,seq)` ✅ 新建
- `Angle_trackId_used_seq_idx` **已不存在** ✅（按迁移 DROP）
- `Angle_trackId_scope_used_seq_idx / Angle_trackId_code_key / Angle_theme_idx / PRIMARY` 保持不变 ✅
- `TopicReview_angleId_round_idx (angleId,round)`、`TopicReview_verdict_createdAt_idx (verdict,createdAt)` ✅
- 外键 `TopicReview_angleId_fkey → Angle(id) ON DELETE CASCADE ON UPDATE CASCADE` ✅（随建表语句生效；smoke 库同迁移已验证级联行为）

> 勘误注记：`S4-1-PRE-MIGRATION-CHECK-REPORT.md` §2 曾写「TopicReview 12 列」，实为 **11 列**（字段清单本身逐项无误，为计数笔误）。以本报告为准。

## 6. 业务数据行数核验

| 表 | 行数 | 预期 |
|---|---|---|
| `angle` | **0** | 0 ✅ |
| `TopicReview` | **0** | 0 ✅ |
| `article` | **0** | 0 ✅ |

（空库起步、不迁 dev.db 159 行的 S1 定案保持不变；新增列对零行零影响，未来行落库即 `status='candidate'`。）

## 7. `_prisma_migrations` 记录

`20261114093000_add_angle_status_topic_review`：
- `finished_at` = **2026-11-14 19:56:30**（非空 ✅）
- `rolled_back_at` = **NULL** ✅
- `applied_steps_count` = **1** ✅

（历史记录中 S1-2 的一行 `20261113145706_init` rolled-back 标注保持原样，未受影响。）

## 8. 迁移后的结构指纹（S4-1 正式启用基线）

- 业务库 `wechat_pipeline`@127.0.0.1:3306：16 张业务表 + `_prisma_migrations`（4 行记录：init-rolled-back 历史行 / init / enum 补值 / 本次 deploy）。
- 本次结构增量基线：Angle +3 列（上表）；TopicReview 11 列 + 2 索引 + 1 级联外键；Angle 索引 [trackId,used,seq] → [trackId,status,seq]。
- 业务数据基线：Angle/Article/TopicReview 均 0 行。
- 后续结构性变更一律走新迁移文件，禁止 db push。

## 9. 安全核验

| 项 | 结果 |
|---|---|
| 其他项目数据库 | ✅ 零触碰（wpc_app 权限边界下 crm/wechat_publisher/wx_task_pocket 等 information_schema 不可见） |
| dev.db | ✅ `fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5` 与基线一致 |
| 8 个归档备份 | ✅ 全部 sha256 与此前记录逐一一致（28221e42/10ca76ad/ea917a3e/d76a66f7/8dff036d/3490f7d1/05c11a47/0dcc6846） |
| .env / 账号 / 密码 / 权限 | ✅ 未修改 |
| AUTO_PUBLISH=false | ✅ 保持（constants.ts） |
| 真实 LLM / 微信 / 发布 / 群发 | ✅ 零调用（本次仅 migrate deploy + 只读 SQL + 文件哈希） |
| migrate resolve / db push / reset | ✅ 未执行（迁移一次成功，无需） |

## 10. 最终执行结论

**✅ SUCCESS。** `20261114093000_add_angle_status_topic_review` 已按授权在业务库 `wechat_pipeline` 成功应用；部署后十项验证（状态/结构/行数/迁移记录/指纹/安全）全部符合预期；无异常、无需回滚。S4-1 的选题评分与审核状态机数据结构**正式启用**（六维评分、candidate→approved 状态机、TopicReview 留痕、approved-only 消费自此在业务库生效）。

**备注**：本轮交付报告与 `S4-1-PRE-MIGRATION-CHECK-REPORT.md` 均未提交 Git（遵「不顺手修改/不擅自提交」约束），留工作区待处置。

---

**执行结束。不进入 S4-2，不启动选题去重改造，未修改业务代码/前端/Schema/Migration。等待用户与 ChatGPT 验收。**
