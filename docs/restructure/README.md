# 重构设计基线 · 文档入口

> **⚡ 最新（2026-11-13）：后续实施以 [`RESTRUCTURE-2.0-CONVERGED-PLAN.md`](./RESTRUCTURE-2.0-CONVERGED-PLAN.md)（2.0 重构方案·基于现有成果的精简修订版）为唯一依据**——T1-A REV 系列（含 REV4.1）已被其取代归档；T0 已验收保留不重做。

**建立日期**：2026-11-12 | **状态**：**提交前整理**——S1（MySQL 切换 + T0 最小适配）、S2（SQLite 遗留清理）、S3（抽象裁剪，裁决冻结）、S4（业务与内容质量，S4-1～S4-5）、S5（UI/UX，S5-UI-1～6）、**S6（回归与收尾，S6-0～S6-4 + S6-5A + S6-5B 全部完成）均已完成**；S6-4 已提交推送（`2458d11`），S6-5A+B 待提交，详见下方「实施期关键报告索引」（分阶段授权，见总纲 §六）
**效力顺序**：`RESTRUCTURE-2.0-CONVERGED-PLAN.md`（当前最高）→ `00-FINAL-EXECUTION-CHARTER.md` → 本文决策表 → 其余文档。文档间若有冲突，以最新总纲为准并在本文登记。

## AI 阅读规则（接手 agent 必读）

1. **实施唯一依据** = `RESTRUCTURE-2.0-CONVERGED-PLAN.md`；其余文档与之冲突时以 2.0 为准。
2. **T1-A 系列（13 份）已全部带「已被取代」标记**——只作历史参考，不得按其双库 / 五账号 / 搬迁设计实施。
3. **T0 验收证据为冻结历史记录**（`T0-ACCEPTANCE-REPORT.md` / `T0-SAFETY-SUPPLEMENT.md` / `T0-V3-REVISION-DIFF.md` / `T0-MYSQL-ADAPT-REPORT.md`）：只读引用，不得改写。
4. **数据现状**：运行库 = MySQL `wechat_pipeline`（辅助库 `_shadow` / `_smoke`，账号 wpc_app）；`server/prisma/dev.db` 与 `dev.db.bak-*` = **历史数据，不参与运行**（归档只读，禁止删除）。
5. **SQLite 运行链已退役（S2）**：`schema.sqlite.prisma`、`gen-sqlite-schema.mjs`、npm 脚本 `schema:sqlite` / `sqlite:generate` / `sqlite:push` / `migrate` / `migrate:dry` / `smoke:migrate` / `smoke:prune-iso` 均已删除；任何文档再出现这些命令即为历史表述，以根 README / CONTRIBUTING 现行说明为准。

---

## 阅读顺序

| 序 | 文件 | 内容 | 对应原编号（用户审查稿） |
|---|---|---|---|
| 00 | `00-FINAL-EXECUTION-CHARTER.md` | **最终执行总纲**（最高级约束 + 五项核心验收指标） | 总纲 |
| 01 | `CURRENT-ARCHITECTURE.md` | 当前架构与真实业务流程（含校验缺口标注） | 01 |
| 02 | `DATABASE-DESIGN-REVIEW.md` | 当前 ER、字段读写审计、目标 ER 与七表审查 | 02 |
| 03 | `PROJECT-UNDERSTANDING.md` | 项目理解与验证边界（已验证/推断/待确认） | 03 |
| 04 | `PROMPT-AND-CONTRACT-DESIGN.md` | 形态契约/配置/Prompt 分层与仲裁、Prompt 体系 | 04 |
| 05 | `RESTRUCTURE-REVIEW.md` | 对 V1 审计报告与 V1 实施清单的审查与修订 | 05 |
| 06 | `RESTRUCTURE-ROADMAP-V2.md` | 分阶段实施路线（阶段 0-5，含子里程碑） | 06 |
| 07 | `TARGET-UI-ARCHITECTURE.md` | 目标导航、交互规范、视觉方向、低保真 | 07（TARGET-UI-UX） |
| 08 | `UI-UX-AUDIT.md` | 现有后台 UI/UX 诊断（静态分析） | 08（CURRENT-UI-DIAGNOSIS） |
| 09 | `09-PRE-IMPLEMENTATION-CHECK.md` | **实施前检查报告**（第二步产出，只读检查） | — |

## 实施期关键报告索引（S6 收尾）

| 报告 | 内容 | 结论 |
|---|---|---|
| `S6-0-PRE-DELIVERY-AUDIT.md` | 交付前整体只读审计（分级口径 + 遗留清单 + S6 建议顺序） | 只读，列出交付缺口 |
| `S6-1A-PRE-COMMIT-CHECK.md` / `S6-1B-COMMIT-EXECUTION-REPORT.md` | 整体入库前检查 / 提交执行 | 已完成整体入库并提交 |
| `S6-2A-RUNTIME-DB-IDENTITY-AUDIT.md` | 正式业务库配置与运行时连接身份只读审计 | 发现两 URL 同指正式库（后修）与 migrate dev 命令级风险 |
| `S6-2B-1-DB-CONFIG-VERIFY.md` | 数据库连接配置修正后只读核验 | 两 URL 同指问题已解除；migrate dev 护栏转 S6-4 |
| `S6-3-SYSTEM-RUNTIME-VERIFICATION.md` | 系统真实运行验证与交付回归（真实 admin 会话 + 正式库只读） | 核心链路 PASS，可关闭 S6-3 |
| `S6-4-FINAL-PRE-COMMIT` 系列 / 护栏脚本 `server/scripts/migrate-guard.ts` | Migration 命令级护栏（主目标+Shadow 双重身份校验）+ 交付文档纠偏 | S6-4 已提交推送 `2458d11`，自检 32/32 |
| `S6-5B-PRECHECK-REPORT.md` | 六赛道初始化只读准备（创建链/字段/门禁/非幂等保护/回滚） | READY WITH CONDITIONS，前置条件已满足 |
| `S6-5B-3-POST-CREATION-ACCEPTANCE-REPORT.md` | 六赛道创建后最终验收（Track/Pipeline/StylePrompt DIFF/前端匹配） | PASS，数据库写入 0，DIFF=0 |

> 历史文档（保留不删，已被上表取代）：`docs/AUDIT-REPORT.md`、`docs/RESTRUCTURE-CHECKLIST.md`（V1）、`docs/RESTRUCTURE-PLAN-V1.md`（原始方案）、`docs/SECOND-OPINION.md`（实测数据）、`docs/FORM-ARCHITECTURE.md` / `TRACK-FORM-RESEARCH.md`（形态设计稿与调研）。

---

## 决策登记表（2026-11-12 用户拍板）

| # | 决策 | 结论 | 落点 |
|---|---|---|---|
| D1 | 选题数据模型 | **Angle.status + used 双维度 + TopicReview 事件表**；不建 TopicCandidate。status=审核态（candidate/needs_revision/approved/rejected），used=消费态（独立维度）。「标重复」= 审核事件+拒绝原因，不新增主状态。存量 33 条回填 approved **前逐条检查实际状态，不无条件批量改** | 02 §3.3-③、06 阶段 2 |
| D2 | reflow | **限定保留**：排版级切分，禁止加段/改写掩盖结构错误；先用现有样本做切分前后对照测试（段落数/长度 CV/结构完整性/阅读效果）再决定默认开关。emphasis 保留但只动格式不动语义 | 04 §6、06 阶段 4 |
| D3 | 门禁参数化深度 | 第一版只参数化按赛道变化项：字数区间/小标题数/主体数量与清单/节奏类型/段落限制/强调数量/对应质量规则；**不把每条 lint 都做成配置**；安全红线留 L0 constants | 04 §5.2、06 阶段 1 |
| D4 | TrackContract 范围 | form + reviewPolicy 两部分；文风/变体/来源/模型配置不进契约 | 02 §3.3-①、04 §5.2 |
| D5 | 审核模型角色 | **有条件确定**：第一版复用 write 角色；须真实样本验证结构化输出稳定性（格式/一致性/失败率/成本），不达标再加 review 角色 | 06 阶段 2/4 |
| D6 | 旧配置迁移 | 两步走：①补齐六赛道默认配置+兼容性检查+异常告警；②数据校验与运行验证后启用严格模式（缺项不再静默回落）。不允许删旧配置后才发现赛道写不出文章 | 06 阶段 1、04 §5.2 |
| A | RBAC | 权限矩阵见审查稿 §七-A（admin 全量 / member 自己归属且分能力授权 / guest 只读文章）；「自己归属」由后端数据范围实现；轻量归属≠完整多租户 | 06 阶段 2 |
| B | expiresAt / maxOAAccounts | 先定产品需求：要做→定义服务端强制点；不做→停 UI 暴露+标待移除遗留字段；**本轮不删字段** | 09 §D1-D6、06 阶段 1 |
| C | 旧文章追溯 | 不伪造历史 Prompt/契约/GenerationRun；老数据标 `legacy`，只展示真实存在的信息 | 02 §3.3-⑧、06 阶段 4 |
| M | 五项核心验收指标 | 见总纲 §七（分母/周期/来源口径，样本不足<10 不出百分比） | 00 §七、06 阶段 5 |
| P | 迁移安全观 | down 演练成功≠数据回滚安全；结构变更与数据变更分开脚本；不能安全 down 的用向前修复；SQLite/MySQL 分别验证；**禁止拿真实生产库试验** | 02 §迁移、06 阶段 1A |
| U | UI 顺序 | 阶段 0（设计系统/壳层/导航）可提前；P1 只做原型；审核/质量/运行中心随 API；**真机浏览器走查=阶段 0 验收前置** | 07 §7.5、06 阶段 0 |
| Q | 去重能力边界 | Embedding **不是现有能力**（llm.ts 无 embedding/tools/JSON mode）；第一版=精确归一化→文本相似度→批量 LLM 语义判重→人工；语义判重失败**阻止自动升格**（进待补审），不阻塞候选生成 | 06 阶段 2 |
| X | 双系统关系 | **✅ 已关闭（2026-11-12 20:28 切换执行）**：用户拍板「停掉本机的，现在不需要了」——**替代式切换当即生效**。本机 WorkBuddy 自动化「公众号每日创作并推送草稿」（id c879a541…，06:00）**status=PAUSED**（自动化接口核实）；本机目录转只读蓝本归档；**云端为唯一系统**，文风真源只剩 StylePrompt（双真源同步义务解除）。注意：云端 User.automationMode 均为 manual → **当前每日自动出稿为 0（生产空窗）**，恢复产稿时按账号调 auto_draft（群发永远人工）。09 §四 |
| T | 工作台待办口径 | **已定（2026-11-17）**：待办 = 已有业务事实的聚合，不引入新状态/新表。①选题待审 = `used=false ∧ status∈(candidate,needs_revision)`，仅 admin 可见；②文章三类必须走 `hasPushTrace()`（`status` 只代表当前态，不能推断是否推送过）；③体检只认「每篇最新一条 ∧ contentHash 与当前正文一致」，**禁止**调 `GET /:id/lint`（有写副作用）；④执行失败取近 7 天且同键最新仍 failed（批次按「次」），排除 push 以避免与推送失败重复；⑤计数一律 `number\|null`，`null`≠`0`，失败块进 `todos.degraded` | S5-UI-2-B 报告 §3–§5、`server/src/services/dashboard.ts` 的 `todo*` 函数 |

## 工程强制标准（每阶段，与总纲 §五同效）

修改前说明影响→备份/隔离库→单元+集成测试→TS 检查+构建+smoke→API 语义明确→旧功能/双产线不丢→迁移有回滚或向前修复→CHANGELOG/文档回写→真实测试结果→**前端不展示假数据**。
