# T1-A-REVISED-DECISION-REPORT · REV4.1 方案收口（按外部审核「必须修订」8 项 + 文档建议）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（REV4.1）
- **性质**：纯文档修订轮收口报告。**本轮零实施**——声明见 §9。**文档修订与审核通过均不构成任何实施授权。**
- **审核结论（本轮依据）**：REV4 总体方案**有条件通过**，架构成立、不推翻重做——不重做双库讨论、不加 marker 表、不加账号、不重做网络隔离、不把 159 行搬迁包装成迁移平台。**P1-A 可在 A1-A3 修订完成后启动；P2-A 暂缓，须 B4-B8 修订 + G4 实测后再授权**；P2-B/P3/P4 保持原计划。
- **方案定稿（不变）**：本机 MySQL 8.0.30 = 唯一开发数据库；测试与生产统一 MySQL；schema.prisma + Prisma Migrate 唯一迁移机制；T0-v2 前置；SQLite dev.db 历史归档。

---

## 1. REV4 → REV4.1 修改清单

| 文档 | REV4.1 动作 | 修改点 |
|---|---|---|
| `T1-A-T0-ISOLATION-COMPAT-PLAN.md` | 修订 | **A1** §2.1 重写：内存注册表=运行期唯一授权真源；注册文件**如实降级**为恢复线索（Windows 同用户 ACL，不宣称不可篡改）；prune 删除前必须 OS 进程实测复核；无法证明归属一律拒删；不引入额外服务/OS 隔离。**A2** §8/§9：SMOKE_DB_PORT 显式来源；子进程只收临时库 DATABASE_URL 一份凭据（由父进程凭 SMOKE_DATABASE_URL 派生）；selftest URL 反例补 **wpc_ro**。**A3** §6.1：F 类 DOUBLE 8 字节 / FLOAT 4 字节分宽；J 类 JCS 前数字过 IEEE754 双精度安全检查；T 类以只读实测为准（INTEGER Unix 毫秒，断言 typeof，不猜时区；业务日期字符串走 S 类）；新增类型前提断言（当前 15 表无 Float/Decimal）。 |
| `T1-A-PRISMA-MIGRATE-INIT-PLAN.md` | 修订 | **A2** §2②：.env 增 SMOKE_DATABASE_URL/SMOKE_DB_PORT + 凭据注入边界。**B4** §3.2：包装脚本**必须覆盖 `childEnv.DATABASE_URL = MIGRATE_DATABASE_URL`**（Prisma 不自动用后者），执行后实测 CURRENT_USER()=wpc_migrate。**B5** §6：diff 参数改 `--from-schema-datasource`/`--to-schema-datasource`（命令行零密码，只留这一套）；`--exit-code` 语义 0/2/1（官方，实施期首跑复核）；migrate status 定位修正（非 drift 检测）。**B6** §5.2-1/§5.3：**取消 `_wpc_migration_progress`**（正式库只留 Prisma 15 表，diff empty 不受影响；中断=重跑+PK 存在性检查）。**B7** §5.1/§5.2-1：dry-run 定义=无持久化写入（允许会话级 TEMPORARY TABLE）；NULL 语义对齐 MySQL UNIQUE（多 NULL 不算冲突）；前缀索引按 Sub_part；组合全列。**B8** §3.3：回退两档（完整=T0-v1 git revert+sqlite:generate；仅应用回退须标注）。 |
| `T1-A-ROLLOUT-PLAN.md` | 修订 | **B8**：P1-A 单独 git commit + 回退两档入 P2-A；P1-A selftest 反例补 wpc_ro（五种身份）；头部记分阶段审核结论。 |
| `T1-A-REVISED-DECISION-REPORT.md` | 重写（本文件） | REV4.1 收口：修改清单 / 逐项处理结论 / 审核通过项 / 分阶段结论 / 授权与决策不变 / 零变更声明。 |
| `T1-A-MYSQL-SWITCH-IMPACT.md` | 无改动 | REV4 版内容不涉及本轮 8 项（唯一键预检等已在 REV4 落）。 |
| `T1-A-SQLITE-DEPENDENCY-INVENTORY.md` | 无改动 | 同上。 |

## 2. 逐项处理结论（8 项必修全部「修复」+ 1 项文档建议）

| # | 审核问题 | 处理结论 | 落点 |
|---|---|---|---|
| A1 | 注册文件被称「子进程无法篡改」不实 | **修复**：内存注册表=运行期唯一真源；文件仅恢复线索+发现残留；prune 以 OS 进程启动时间实测为准；不完整/不确定→拒删报告；不加服务/OS 隔离 | 兼容方案 §2.1/§3.1/§3.3 |
| A2 | 缺 wpc_smoke 凭据配置；反例缺 wpc_ro | **修复**：.env 增 SMOKE_DATABASE_URL（父进程专用）+ SMOKE_DB_PORT；子进程只收临时库一份凭据、不继承其他连接串；selftest 反例补 wpc_ro | Init §2②；兼容方案 §8/§9 |
| A3 | FLOAT 一刀切 8 字节；JCS 数字安全；时区猜测 | **修复**：DOUBLE 8B/FLOAT 4B 分宽+当前无 Float 断言；JCS 前数字 IEEE754 双精度 round-trip 检查不安全即停；T 类以只读实测为准（源=INTEGER Unix 毫秒、断言 typeof、异常即停不猜时区）；业务日期字符串走 S 类 | 兼容方案 §6.1；Init §5.2-5 |
| B4 | MIGRATE_DATABASE_URL 不会自动被 Prisma 使用 | **修复**：包装脚本必须 `childEnv.DATABASE_URL = MIGRATE_DATABASE_URL`；保留 SHADOW；执行后实测 CURRENT_USER()/DATABASE() | Init §3.2 |
| B5 | diff 命令行暴露密码 | **修复**：改 `--from-schema-datasource`/`--to-schema-datasource`（5.22 支持、7 移除），命令行零 URL/密码，不保留两套；`--exit-code`=0/2/1（官方，首跑复核） | Init §6 |
| B6 | `_wpc_migration_progress` 破坏 diff empty | **修复（简化采纳）**：取消该表；159 行规模用 PK 存在性+行摘要足够；进度只写本地 JSON（如需）；中断重跑 | Init §5.2-1/§5.3 |
| B7 | 预检与 dry-run 矛盾；NULL/前缀索引语义 | **修复**：dry-run=无持久化写入，允许会话级 TEMPORARY TABLE 做 collation 预检；多 NULL 不算冲突（对齐 MySQL UNIQUE）；前缀索引按 Sub_part；组合全列；真实冲突硬停 | Init §5.1/§5.2-1 |
| B8 | 回退只写 sqlite:generate 不完整 | **修复**：P1-A 单独 git commit；完整回退=revert 该提交恢复 T0-v1 + sqlite:generate + URL；仅应用回退明确标注「应用回退」非「整个 T0 系统回退」 | Init §3.3；Rollout P1-A/P2-A |
| 建议 | migrate status 不是 drift 检测工具 | **修复（表述）**：只核对迁移账目；drift= shadow 推演 + migrate diff；四类对象补查保留 | Init §1/§6 |

## 3. 审核通过项（不再折腾，六文档不再改）

MySQL 单库统一 / 五账号职责分离（不加第六号）/ 固定 wpc_shadow（无 marker）/ 临时库命名正则 / 父子进程分权 / GET_LOCK 同连接 / REVOKE→验证→DROP / 显式字符集 collation / W1/W2 延期 / 15 表 159 行基准 / P2-B 后 P3 / P4 业务搜索确认。
审核方另核实成立：MySQL 8.0.30 库级通配符授权可用（8.0.35 才弃用，不影响本次）；wpc_runner 模式授权方案有实现基础（G4 实测保留，若需扩权必须停下请示）；固定 shadow 在 migrate dev 开始时被 reset（故不建 marker 正确）；GET_LOCK 会话级；DROP 不自动回收授权（REVOKE 前置正确）。

## 4. 尚未解决的问题（不变，仅 2 项）

| # | 问题 | 处置 |
|---|---|---|
| U1 | `wpc\_smoke\_%` 模式授权/建库能力实际语义 | G4 探针 P2-A 实测定案；**若需扩大权限必须停下请示，不自动加全局权限** |
| U2 | `--exit-code` 退出码实测复核（语义已按官方 0/2/1 修订） | 实施期首跑记入验收报告 |

## 5. 数据库账号和权限（定稿不变）

root 用户自持（不进配置/脚本/日志）。五业务账号：

```sql
-- ① 迁移账号（仅 Prisma 迁移）
CREATE USER 'wpc_migrate'@'localhost' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON wechat_pipeline.* TO 'wpc_migrate'@'localhost';
GRANT ALL PRIVILEGES ON wpc_shadow.*       TO 'wpc_migrate'@'localhost';

-- ② 测试库管理账号（建/管/清临时库 + 逐 runId 转授；无业务库权限）
CREATE USER 'wpc_runner'@'localhost' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON `wpc\_smoke\_%`.* TO 'wpc_runner'@'localhost' WITH GRANT OPTION;

-- ③ 测试运行账号（零常驻；运行期由 wpc_runner 逐 runId 字面转授）
CREATE USER 'wpc_smoke'@'localhost' IDENTIFIED BY '<强密码>';

-- ④ 只读校验账号（必需）
CREATE USER 'wpc_ro'@'localhost' IDENTIFIED BY '<强密码>';
GRANT SELECT ON wechat_pipeline.* TO 'wpc_ro'@'localhost';

-- ⑤ 应用运行账号（DML-only，无 DDL）
CREATE USER 'wpc_app'@'localhost' IDENTIFIED BY '<强密码>';
GRANT SELECT, INSERT, UPDATE, DELETE ON wechat_pipeline.* TO 'wpc_app'@'localhost';

FLUSH PRIVILEGES;
-- 建库（显式字符集）：
CREATE DATABASE wechat_pipeline CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE wpc_shadow      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

运行期转授/回收（wpc_runner，字面库名）：GRANT ALL ON `wpc_smoke_<runId>`.* → 测试 → **REVOKE → 验证 → DROP**（八步清理）。凭据写 `server/.env`（含 SMOKE_DATABASE_URL/SMOKE_DB_PORT），不进聊天。

## 6. 授权边界 (a)/(b1)/(b2)/(c)（维持，审核通过不等于授权）

| 授权 | 覆盖 | 不覆盖 |
|---|---|---|
| **(a) P1-A** | 修改 T0 四件套（仅兼容方案 §9 点位，单独 git commit） | 任何数据库操作；verify 十项语义变更 |
| **(b1) P2-A 结构段** | 建库+五账号授权（用户 root 自跑）；schema shadowDatabaseUrl 一行；.env 六项写入；migrate init；generate；Init §2 检查（含 B4 身份实测） | 数据搬迁；生产库；migrate 之外 DDL |
| **(b2) P2-A 搬迁段 + P2-B** | 数据搬迁（源只读、无进度表、TEMPORARY 预检）；P2-B 临时库建/写/删与转授回收；验收运行 | 真实开发库破坏性写入；生产库；真实 LLM/微信外联 |
| **(c) P3** | SQLite 脚本退役/CI/文档口径 | 业务代码行为变更 |

## 7. 分阶段审核结论与实施条件（本轮审核方判定，如实转录）

| 阶段 | 结论 | 进入条件 |
|---|---|---|
| P1-A | **有条件通过** | A1-A3 修订（✅ 本轮文档已完成）→ 拿到授权 (a) 即可启动 |
| P2-A | **暂缓** | B4-B8 修订（✅ 本轮文档已完成）+ **G4 实测通过**（实施期）+ 授权 (b1)/(b2) |
| P2-B | 保持原计划 | MySQL 切换与搬迁完成后进行，不得以 P1-A 静态验收代替 |
| P3 | 保持原计划 | P2-B 通过后执行，不提前退役 SQLite 回退能力 |
| P4 | 保持原计划 | 保留大小写/重音敏感性的业务确认 |

## 8. 仍需用户确认的决策（不变，仅 3 项）

D1 库名 `wechat_pipeline`（建议用）；D2 dev.db 159 行搬迁（建议搬）；D3 shadowDatabaseUrl 一行改动（建议同意）。

## 9. 本轮零变更声明（强制）

**本轮（REV4.1 文档修订）**：
- **零代码修改**（server/src、scripts、web、T0 四件套全部未动）；
- **零数据库写入**（未 CREATE/DROP/GRANT/REVOKE/db push/migrate dev/deploy/resolve；对 dev.db 仅 node:sqlite **只读** PRAGMA/采样/COUNT，指纹全程 `fea0f123…` / 974848 / 2026-11-12 13:20:05 不变）；
- **零环境变量修改**（server/.env 未动）；
- **零真实数据修改**；未创建/修改 migration 文件、Prisma Schema、CI、部署脚本；未进入 T1-B。

本轮唯一产出 = docs/restructure/ 下文档修订（§1 清单）。

---

**停点声明**：REV4.1 提交后立即停止。**外部审核通过 ≠ 实施授权**——P1-A 需明确授权 (a) 才动工（完成后 A1-A3 条件已具备）；P2-A 须 B4-B8（文档已备）+ G4 实测 + (b1)/(b2)；(c) 逐项单点。D1-D3 仍待用户确认。
