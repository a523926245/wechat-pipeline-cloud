# S4-1-PRE-MIGRATION-CHECK-REPORT：业务库 Migration 上线前核查

- **日期**：2026-11-14 19:35（晚）
- **对象**：`server/prisma/migrations/20261114093000_add_angle_status_topic_review/migration.sql` → 目标库 `wechat_pipeline`（127.0.0.1:3306，wpc_app）
- **性质**：**纯只读核查**。本轮未执行 migrate deploy / db push / 任何写库；未修改 Schema、Migration、业务代码；未触碰 dev.db、备份、他库、.env、账号与权限。
- **结论：PASS —— 具备部署条件，等待用户授权后执行。**

---

## 1. Git 状态和提交核对

| 项 | 结果 |
|---|---|
| 当前分支 | `feature/open-source-readiness` |
| HEAD | `0fb2ffd812617df37b090c12a50d8756aea8f8f1`（0fb2ffd） |
| `3365ca3`（S4-1 主体）在当前提交链 | ✅（HEAD~1，`git merge-base --is-ancestor` 验证） |
| `0fb2ffd`（创作入口门禁）在当前提交链 | ✅（HEAD 本体） |
| 工作区状态 | ✅ **干净**（`git status --short` 空输出） |
| 未提交的 S4-1 相关代码 | ✅ 无 |
| 其他未提交改动 | ✅ 无 |

提交链（近 6 条）：`0fb2ffd` → `3365ca3` → `ee17c18`(S3) → `71b13af` → `1a0f406`(S2) → `2325fa6`(S1-3)。

## 2. Migration SQL 审查结果

**逐项核对（migration.sql 44 行全文 vs schema.prisma vs 业务库实测结构）**：

| 检查项 | 结果 |
|---|---|
| 与当前 `schema.prisma` 一致 | ✅ `prisma migrate diff --from-schema-datasource --to-schema-datamodel`（业务库→schema 实时差异）与本迁移**逐句吻合**，仅差：①表名大小写（`angle`/`Angle`，本机 lower_case_table_names=1 等价，迁移用例与 init 迁移一致）②一行 `article.contentWechat MODIFY` 表示法漂移（见下） |
| Angle 新字段 | ✅ `metaJson JSON NULL`、`reviewRound INT NOT NULL DEFAULT 0`、`status ENUM('candidate','needs_revision','approved','rejected') NOT NULL DEFAULT 'candidate'`——与 schema 完全一致 |
| 枚举 | ✅ 四值顺序与 schema `AngleStatus` 一致；`TopicReview.verdict` ENUM(approved/needs_revision,rejected) 与 `TopicVerdict` 一致 |
| 索引 | ✅ `DROP INDEX Angle_trackId_used_seq_idx`（业务库实测该索引存在，DROP 有效）+ `CREATE INDEX Angle_trackId_status_seq_idx(trackId,status,seq)`，即设计文档 §③ 的索引演进；`Angle_trackId_scope_used_seq_idx` 等其余索引不动 |
| TopicReview 表结构 | ✅ 12 列与 schema 一一对应（id/angleId/round/scoresJson/riskHits/dupHits/verdict/reason VARCHAR(500)/model VARCHAR(64)/reviewedBy VARCHAR(64)/createdAt DATETIME(3)） |
| 外键与级联 | ✅ `TopicReview_angleId_fkey` → `Angle(id)` **ON DELETE CASCADE ON UPDATE CASCADE**，与 schema `onDelete: Cascade` 一致 |
| TopicReview 索引 | ✅ `[angleId, round]`、`[verdict, createdAt]`，与 schema 一致 |
| 无关字段变化 | ✅ 无。diff 中的 `article.contentWechat MODIFY LONGTEXT NOT NULL DEFAULT ('')` 已在迁移头注释声明剔除；业务库实测该列已是 `longtext NOT NULL DEFAULT ''`（init 迁移产物），此行为**空操作表示法漂移**，剔除安全 |
| 破坏性操作 | ✅ 无 DROP TABLE / DROP COLUMN / TRUNCATE / DELETE / UPDATE。唯一 DROP 是索引演进；ADD COLUMN 全部带默认值（存量行零改写、零丢失） |
| 尚未发现的依赖迁移 | ✅ 无。`prisma/migrations/` 仅 3 个目录：`20261113145706_init`（已应用）、`20261114035440_add_missing_enum_values`（已应用）、本迁移（待应用）；migration_lock.toml provider=mysql 正常 |

## 3. 真实业务库当前结构和迁移状态

**`npx prisma migrate status`（只读）**：3 migrations found；**仅 `20261114093000_add_angle_status_topic_review` 未应用**；无 drift / failure 告警。

**`_prisma_migrations` 记录（3 行）**：

| migration_name | finished_at | rolled_back_at | steps | 说明 |
|---|---|---|---|---|
| 20261113145706_init | NULL | 2026-11-14 09:59:48 | 0 | S1-2 R1 故障（MySQL 1101）时的失败尝试，已 `--rolled-back` 正确登记，属**已标注历史**，不影响 deploy |
| 20261113145706_init | 2026-11-14 10:57:35 | NULL | 1 | 修复后成功应用（现行有效记录） |
| 20261114035440_add_missing_enum_values | 2026-11-14 11:55:05 | NULL | 1 | S1-3 enum 补值 |

- **Migration 历史异常排查**：无「failed 且未 rolled-back」记录；同名两行中一行已标记 rolled-back、一行 finished，Prisma `migrate status` 判定一致（无待处理失败）。**不构成部署阻塞**。
- **业务表结构**：`angle` 现有 15 列（无 status/reviewRound/metaJson，即迁移对象状态正确）；索引 `Angle_theme_idx / Angle_trackId_code_key / Angle_trackId_scope_used_seq_idx / Angle_trackId_used_seq_idx / PRIMARY`（DROP 目标存在，CREATE 目标不冲突）；`TopicReview` 表**不存在**（迁移未应用，预期）。
- **业务数据行数**：Angle **0**、Article **0**（空库起步，S1 定案不迁 dev.db 159 行）——ADD COLUMN DEFAULT 对零行零风险，未来任何行落库即得 `status='candidate'`（不伪装已审核）。

## 4. 新旧代码兼容性分析

**当前 HEAD 代码对新结构的依赖面**（迁移部署前会失败的路径）：

| 依赖 | 位置 | 部署前行为 |
|---|---|---|
| `Angle.status` | `services/angles.ts`（listAngles 过滤/toItem/createAngle/expand）、`services/planner.ts`（approved 消费过滤/待审核计数）、`api/routes/articles.ts`（assertAngleApproved）、`services/topic-review.ts`（状态机） | Prisma 对 Angle 的普通 findMany/create 默认 SELECT/INSERT 全列 → **Unknown column 报错** |
| `Angle.reviewRound` | angles.ts toItem、topic-review.ts reviewAngle | 同上 |
| `Angle.metaJson` | angles.ts（扩库评分写入/编辑失效/列表评分）、topic-review.ts | 同上 |
| `TopicReview` 表 | topic-review.ts（reviewAngle/listTopicReviews）、api/routes/angles.ts（/:id/review、/:id/reviews） | **Table doesn't exist 报错** |

**兼容边界结论**：
- **迁移未执行时（当前状态）**：登录/鉴权、账号凭据、文风配置、模型配置、文章 CRUD/预览/推送/封面、微信草稿推送、调度 tick 的非选题部分**仍可用**（不触碰 Angle 新列）；但**选题库一切读写、排产计划、写稿/漫画建稿（reserve 与手动入口）、审核操作全部报错**——即 S4-1 新功能与选题相关旧功能在本代码版本下均不可用。仪表盘纯 count 类查询语法上可跑但数据语义已属旧口径。
- **迁移执行后**：全功能可用。本次迁移为**纯增量**（新列带默认 + 新表 + 索引演进），对 Article/微信推送/文风等旧功能零影响。
- **部署顺序**：先 `migrate deploy` 再使用当前代码（当前代码依赖新列；旧列无任何破坏性变更，故无反向兼容风险）。
- **回滚口径**（P 迁移安全观：down 演练≠回滚安全，向前修复为主）：如需回退，revert `3365ca3`+`0fb2ffd` 并手工执行等价逆操作（DROP TABLE TopicReview；DROP COLUMN status/reviewRound/metaJson；重建 [trackId,used,seq] 索引）——因库内 0 行业务数据，无数据搬迁风险。

## 5. 数据安全核查

| 项 | 结果 |
|---|---|
| 不导入 dev.db 159 行 | ✅ 业务库 0 行；本迁移纯 DDL，无任何数据搬运语句 |
| dev.db 与 8 备份 | ✅ dev.db sha256=`fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5`（与 S1 基线一致）；8 个备份在位、只读未动 |
| 其他项目数据库 | ✅ 零触碰（wpc_app 权限止步三具名库，他库 information_schema 不可见） |
| .env / 账号 / 密码 / 权限 | ✅ 未修改（工作区干净亦证明零配置改动） |
| 真实 LLM / 微信接口 | ✅ 本轮零调用（纯 git/文件/只读 SQL/migrate status） |
| AUTO_PUBLISH=false | ✅ `constants.ts:8 export const AUTO_PUBLISH = false as const`；masssend 零调用（仅注释提及） |
| 业务库写操作 | ✅ 零（本轮全部为 SELECT / information_schema / migrate status 只读） |

## 6. 是否具备正式部署条件

**具备。** 依据：
1. Migration 内容 = 业务库→schema 的精确增量（仅剔除一行已证实空操作的漂移语句），无破坏性 DDL；
2. 业务库 0 行数据 + 迁移历史干净（唯一 rolled-back 行已正确标注且被 migrate status 认可）；
3. 同一迁移文件已在隔离 smoke 库**完整应用并全量验证**（smoke:angles 64 / lint 116 / style 41 / verify:smoke-iso 10/10，含新结构全部行为用例）；
4. Git 工作区干净、两提交在链上，代码与迁移同版本可对齐部署。

## 7. 阻塞问题

**无。** 无阻塞项。以下为**非阻塞备注**：
- `_prisma_migrations` 存在一行 `20261113145706_init` 的 rolled-back 历史记录（S1-2 故障恢复产物，已正确标注）——不影响 deploy，保留为审计痕迹。
- 迁移文件表名大小写（`Angle`）与本机 information_schema 小写呈现（`angle`）差异为 Windows lower_case_table_names=1 的预期现象，smoke 库实测同一 MySQL 实例应用成功。

## 8. 正式部署命令与预期结果

```bash
cd K:/WorkBuddy WorkSpace/project/wechat-pipeline-cloud/server
npx prisma migrate deploy
```

**预期输出**：
```
The following migration(s) have been applied:
migrations/
  └─ 20261114093000_add_angle_status_topic_review/
    └─ migration.sql
All migrations have been successfully applied.
```

**部署后即时验证（建议，只读）**：
```bash
npx prisma migrate status    # 预期：No pending migrations（全部已应用）
```
```sql
-- 预期：status/reviewRound/metaJson 三列存在；TopicReview 表存在；angle 仍 0 行
SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema='wechat_pipeline' AND table_name='angle'
   AND column_name IN ('status','reviewRound','metaJson');   -- 预期 3
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema='wechat_pipeline' AND table_name='TopicReview';  -- 预期 1
```

**注意**：`migrate deploy` 即改变业务库指纹（结构性变更，无数据变更）——部署完成后按惯例留一次指纹/结构记录，作为 S4-1 上线收尾的一部分。

---

**最终结论：PASS —— 具备部署条件，等待用户明确授权后方可执行上述 migrate deploy。本轮到此停止；未授权不迁移，不进入 S4-2。**
