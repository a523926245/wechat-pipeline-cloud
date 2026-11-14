# docs 全目录文档盘点报告（历史文档治理 · 权威性梳理）

- **日期**：2026-11-13 | **性质**：只读盘点（除本报告与 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 校准外，未改动任何文档）
- **范围**：`docs/` 全目录递归 51 个文件（41 md + 8 txt + 1 html + 1 png），逐份核对正文定性，不凭文件名推断
- **配套**：本报告与《2.0 重构方案·基于现有成果的精简修订版》同轮交付；效力=文档治理依据，不产生新实施指令

---

## 1. 文档总量与权威性分布

| 权威性 | 数量 | 含义 |
|---|---|---|
| CURRENT 当前有效 | 6 | 后续相关任务必须遵循 |
| ACCEPTED 已验收 | 13 | 历史事实与成果依据（T0 全家） |
| REFERENCE 参考 | 15 | 按需取用（含产品/写作业务资料） |
| ARCHIVED 历史归档 | 5 | 可追溯，不作实施指令 |
| SUPERSEDED 已取代 | 9 | 被后续方案取代，不再作为实施依据 |
| OBSOLETE 已废弃 | 3 | 机制被明确废弃，禁止据以实施 |
| **合计** | **51** | |

## 2. 全目录清单（用途 · 内容类别 · 权威性）

内容类别：A=决策/架构 ｜ B=产品业务资料 ｜ C=实施记录/验收 ｜ D=历史方案/过程分析 ｜ E=被取代/废弃方案 ｜ F=素材

### 2.1 docs 根目录（13）

| 文件 | 用途 | 类别 | 权威性 | 说明 |
|---|---|---|---|---|
| DEVLOG.md | 进度台账（唯一进度真源） | C | **CURRENT** | 每任务收尾必须回写 |
| WRITING-PIPELINE.md | 当前实际生效的写作链路 | B | **CURRENT** | 改文风/写作逻辑前必读 |
| PRODUCT-PLAN.md | 产品与架构优化方案稿（未实施，含待拍板项） | B | REFERENCE | 产品规划，永不废弃 |
| WRITING-GUIDE.md | 写作方法论（调研沉淀、审稿清单） | B | REFERENCE | 业务运行依据，永不废弃 |
| TRACK-FORM-RESEARCH.md | 赛道形态调研基线 | B | REFERENCE | S4 选题/文风优化输入 |
| FORM-ARCHITECTURE.md | 形态架构设计稿（后处理/判据/查证，未实施） | D | REFERENCE | S3/S4 输入材料 |
| SECOND-OPINION.md | 第三方评审请求自述 | D | ARCHIVED | 过程材料 |
| AUDIT-REPORT.md | V1 审计报告 | D | SUPERSEDED | 被 RESTRUCTURE-REVIEW 修订 |
| RESTRUCTURE-CHECKLIST.md | V1 实施清单 | E | SUPERSEDED | 同上 |
| RESTRUCTURE-PLAN-V1.md | 原始重构方案（V1） | E | SUPERSEDED | 三代方案之第一代 |
| sample-article.html | 示例文章素材 | F | REFERENCE | — |
| sample-qwen-panel.png | 参考截图 | F | REFERENCE | — |
| （目录内无子目录） | | | | |

### 2.2 docs/restructure/（32 md + 8 txt）

**当前有效（CURRENT）**

| 文件 | 用途 |
|---|---|
| RESTRUCTURE-2.0-CONVERGED-PLAN.md | **2.0 收敛方案（唯一实施依据，最高）** |
| README.md | 文档入口 + 决策登记表（D1-D6/A/B/C/M/P/U/Q） |
| 00-FINAL-EXECUTION-CHARTER.md | 执行总纲：红线 + 五项核心验收指标 |
| TARGET-UI-ARCHITECTURE.md | 目标 UI 导航/交互规范（S5 依据） |

**已验收（ACCEPTED）——T0 成果全家，不得改写历史**

| 文件 | 用途 |
|---|---|
| T0-ACCEPTANCE-REPORT.md | T0 正式验收依据（10/10，996 行） |
| T0-ACCEPTANCE-LOGS/*.txt（8） | 验收日志留档 |
| T0-SAFETY-SUPPLEMENT.md | T0 安全补充 v3（安全设计真源） |
| STAGE0-IMPLEMENTATION-PLAN-V2.md | T0 实施计划（已按此实施） |
| STAGE0-PLAN-REVISION-DIRECTIVE.md | T0 计划修订指令（过程） |
| T0-V3-REVISION-DIFF.md | 安全材料 v2→v3 差异（过程） |

**参考资料（REFERENCE）**

| 文件 | 用途 | 按需场景 |
|---|---|---|
| CURRENT-ARCHITECTURE.md | 当前架构与业务流程（实读验证） | S4 流程梳理 |
| PROJECT-UNDERSTANDING.md | 项目理解与验证边界 | 业务梳理 |
| DATABASE-DESIGN-REVIEW.md | ER 审查 + 目标数据模型 | S3/S4 数据模型 |
| PROMPT-AND-CONTRACT-DESIGN.md | 契约/配置/Prompt 分层关系 | S3 |
| UI-UX-AUDIT.md | 现状 UI 静态诊断 | S5 |
| KICKOFF.md | 新会话开工话术模板 | 开工时 |
| 09-PRE-IMPLEMENTATION-CHECK.md | 实施前检查 + 12 项风险登记 | 风险对照 |
| T1-A-SQLITE-DEPENDENCY-INVENTORY.md | SQLite 依赖全景（6 类） | **S2 清理直接依据** |
| T1-A-MYSQL-SWITCH-IMPACT.md | 切换影响面分析 | S1/S2 影响对照 |

**历史归档（ARCHIVED）**

| 文件 | 用途 |
|---|---|
| RESTRUCTURE-REVIEW.md | 对 V1 的自我审查修订（沿革关键节点） |
| T1-A-READONLY-REPORT.md | T1-A 首轮只读检查报告 |
| T1-A-MYSQL-LOCAL-READONLY-REPORT.md | 本机 MySQL 只读检查（8.0.30 事实） |
| T1-A-MYSQL-READONLY-CHECK.md | MySQL 只读检查操作指南 |

**已被取代（SUPERSEDED）**

| 文件 | 被谁取代 |
|---|---|
| RESTRUCTURE-ROADMAP-V2.md | 阶段编排被 2.0 §七取代；**其决策条款仍有效**（README 决策表） |
| T1-A-REVISED-DECISION-REPORT.md（REV4.1 收口） | 2.0 方案 |
| T1-A-PRISMA-MIGRATE-INIT-PLAN.md | 2.0 §五（Prisma 命令细节可参考） |
| T1-A-ROLLOUT-PLAN.md（P1-P4） | 2.0 §七（S1-S6） |
| T1-A-ARCHITECTURE-REVIEW.md（双库评估） | 用户决策统一 MySQL（文件已自带取代标注） |
| T1-A-DECISION-REPORT.md（双库推荐） | 同上（文件已自带取代标注） |

**已废弃（OBSOLETE）——禁止再作为实施依据**

| 文件 | 废弃原因 |
|---|---|
| T1-A-T0-ISOLATION-COMPAT-PLAN.md | T0-v2 五账号/动态库/注册表/GET_LOCK 整体废弃（2.0 §三 C 类） |
| T1-A-BACKUP-RESTORE-REVISED.md | 备份恢复演练体系 2.0 明确不做 |
| T1-A-BASELINE-REVISED.md | baseline 路线废弃（本项目=空库初始迁移，不需要 baseline） |

## 3. 重复与冲突文档

| 冲突对 | 内容 | 裁决 |
|---|---|---|
| RESTRUCTURE-PLAN-V1 → ROADMAP-V2 → 2.0-CONVERGED | 三代总体方案并存 | **以 2.0-CONVERGED 为准**；前两代只读追溯 |
| AUDIT-REPORT / RESTRUCTURE-CHECKLIST vs RESTRUCTURE-REVIEW | V1 审计/清单被自审修订 | 以 REVIEW 的修订结论为准（其后再被 V2/2.0 取代） |
| ROADMAP-V2 阶段 0-5 vs 2.0 §七 S1-S6 | 阶段编排不一致 | **以 2.0 为准**（ROADMAP 决策条款除外，见下） |
| T1-A 系列内部（REV1→REV4.1） | 多轮互相修订（shadow 命名勘误、158→159、双库→单库） | 系列整体 SUPERSEDED/OBSOLETE，细节一律以 2.0 为准 |
| FORM-ARCHITECTURE vs PROMPT-AND-CONTRACT-DESIGN | 后处理/判据主题部分重叠 | 均为设计稿；S3 裁剪时按 2.0 流程取舍，不并档 |
| schema.prisma 注释「上线前 baseline migration」vs 2.0 术语 | 旧注记 | S2 清理（已列 2.0 §六包袱） |
| WRITING-GUIDE vs WRITING-PIPELINE | **非重复**（方法论 vs 工程链路，分工明确） | 都保留 |

## 4. 重构决策沿革（T0 · T1-A · REV4.1 → 2.0）

```
2026-11-12  V1 时代：AUDIT-REPORT + RESTRUCTURE-PLAN-V1 + CHECKLIST
                ↓ 自审修订（RESTRUCTURE-REVIEW）
            设计基线定稿：00-CHARTER（红线）+ ROADMAP-V2（阶段0-5）+ README 决策表（D1-D6/A/B/C/M/P/U/Q）
            + 01-08 设计文档（架构/ER/Prompt/UI）
                ↓ STAGE0 计划 v1 → 修订指令 → v2；T0-SAFETY v1→v3
2026-11-12/13 T0 冒烟隔离化实施 → 正式验收 10/10（T0-ACCEPTANCE-REPORT + 8 日志）【冻结】
2026-11-13  T1-A 数据库方案（全部纸面，零实施）：
            只读检查 → REV1 双库架构 A/B/C 对比 → 用户转向「统一 MySQL」
            → 本机 MySQL 只读核查 → REV2 → REV3（外部 8 组意见）→ REV4（收敛）→ REV4.1（有条件通过）
                ↓ 用户《项目重构方向调整》：砍过度设计、保留成果
            RESTRUCTURE-2.0-CONVERGED-PLAN（最终收敛）
                ↓ 本轮五项技术校准（账号 Host/T0 映射/术语/权限/不一致）
            ★ 当前唯一实施基线 ★
```

要点：**T0 是唯一实做并验收的重构成果**；T1-A/REV 系列零实施，其复杂机制（五账号/动态库/搬迁/指纹/GET_LOCK）在 2.0 中全部废弃；2.0 取代一切旧方案成为实施依据。

## 5. 当前真正有效的决策清单

1. **红线**（00-CHARTER + MEMORY）：AUTO_PUBLISH=false（只进草稿箱）、群发永不自动、`/api/*` 全量鉴权、写库验证隔离铁律、主色 #0a7c47 不改、本机蓝本只读。
2. **数据库**（2.0 §五）：一个业务库、两个辅助库、一个项目账号（wpc_app@127.0.0.1）；空库起步**不迁数据**；Prisma Migrate 初始迁移（非 baseline）；utf8mb4_unicode_ci；零全局权限。
3. **T0**：已验收不重做；S1 仅做 §4.1/§4.2 最小适配。
4. **产品/业务决策**（README 决策表，仍有效）：D1 Angle.status+used+TopicReview；D2 reflow 限定保留；D3 门禁参数化范围；D4 TrackContract=form+reviewPolicy；D5 审核复用 write 角色（有条件）；D6 配置两步走；A RBAC；B expiresAt 先定需求；C 老数据标 legacy；Q 去重链；M 五项核心验收指标。
5. **写作链路**（WRITING-PIPELINE）：StylePrompt 运行时真源、同质化四层、渲染唯一 services/render 等现行口径。
6. **目录规范**（用户级）：业务项目放 `project/` 下；跨会话上下文写进项目文档。

## 6. 任务状态清单

| 状态 | 任务 |
|---|---|
| ✅ 已完成 | 阶段 0-5 业务系统建设；架构/业务分析；T0 冒烟隔离化（验收 10/10）；T1-A 全系方案分析（结论=被 2.0 取代）；2.0 收敛方案 + 本轮校准 |
| ⏸ 待授权 | **S1 · MySQL 空库初始化与统一数据库**（2.0 §十准备清单） |
| ⏳ 未开始 | S2 SQLite 遗留清理；S3 抽象裁剪（原 T1-B~E）；S4 业务质量优化；S5 UI/UX；S6 回归收尾 |
| ❌ 正式废弃 | 双库迁移、SQLite Runner、五账号、动态测试库、数据搬迁平台、W1/W2 网络隔离前置、baseline 路线 |

## 7. AI 后续阅读规则

### 每次任务必读（全局入口，仅 2-3 份）
1. `docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md`——实施唯一依据（S1-S6、红线、数据库终案）。
2. `docs/DEVLOG.md`——进度台账（确认做到哪了）。
3. 动代码/动库前加读 `docs/restructure/00-FINAL-EXECUTION-CHARTER.md`（红线与验收指标）。

### 按需阅读（触发条件）
| 触发场景 | 阅读 |
|---|---|
| 改写作链路/文风/提示词 | `docs/WRITING-PIPELINE.md`（必读）+ `docs/WRITING-GUIDE.md` |
| 选题/赛道形态优化（S4） | `docs/TRACK-FORM-RESEARCH.md`、README 决策表 D1/Q |
| 契约/配置/Renderer（S3） | `docs/PROMPT-AND-CONTRACT-DESIGN.md`、`docs/FORM-ARCHITECTURE.md`、README 决策表 D3/D4/D6 |
| 数据模型变更（S3/S4） | `docs/DATABASE-DESIGN-REVIEW.md` |
| UI/交互（S5） | `docs/restructure/TARGET-UI-ARCHITECTURE.md` + `UI-UX-AUDIT.md` |
| 数据库切换/清理（S1/S2） | 2.0 §五 + `T1-A-SQLITE-DEPENDENCY-INVENTORY.md`、`T1-A-MYSQL-SWITCH-IMPACT.md` |
| 追溯 T0 事实 | `T0-ACCEPTANCE-REPORT.md` + `T0-ACCEPTANCE-LOGS/`、`T0-SAFETY-SUPPLEMENT.md` |
| 业务流程梳理 | `CURRENT-ARCHITECTURE.md`、`PROJECT-UNDERSTANDING.md` |
| 新会话开工 | `KICKOFF.md`（话术模板） |

### 不得再作为实施依据（只读追溯）
`RESTRUCTURE-PLAN-V1.md`、`AUDIT-REPORT.md`、`RESTRUCTURE-CHECKLIST.md`、`T1-A-*` 全系 13 份、`RESTRUCTURE-ROADMAP-V2.md` 的**阶段编排部分**。
其中**仍然有效的业务知识不得丢弃**：ROADMAP-V2 的 D1-D6/A/B/C/Q/M 决策条款（已在 README 决策表登记，以 README 为准）；PRISMA-MIGRATE-INIT 里的 Prisma 命令用法（可参考）；CURRENT-ARCHITECTURE 的业务流程事实；T1-A-SQLITE-DEPENDENCY-INVENTORY 的依赖清单（S2 依据）。

## 8. 过期文档与已废弃方案清单

- **OBSOLETE（禁止实施依据）**：T1-A-T0-ISOLATION-COMPAT-PLAN、T1-A-BACKUP-RESTORE-REVISED、T1-A-BASELINE-REVISED。
- **SUPERSEDED（被取代）**：RESTRUCTURE-PLAN-V1、AUDIT-REPORT、RESTRUCTURE-CHECKLIST、RESTRUCTURE-ROADMAP-V2（编排）、T1-A-REVISED-DECISION-REPORT、T1-A-PRISMA-MIGRATE-INIT-PLAN、T1-A-ROLLOUT-PLAN、T1-A-ARCHITECTURE-REVIEW、T1-A-DECISION-REPORT。
- **废弃方案（机制级）**：双库迁移架构（方案 C）、SQLite Runner、五账号权限体系、动态测试库/GRANT/REVOKE、进程注册表、GET_LOCK 互斥、数据搬迁/指纹/断点平台、多层回滚、W1/W2 前置、baseline 路线。

## 9. 是否需要 PROJECT_GUIDE.md——**不需要**

- `docs/restructure/README.md` 已承担入口职责（阅读顺序 + 效力顺序 + 决策登记表）；`DEVLOG.md` 是进度真源；2.0 方案是实施依据——三者够用。
- 新增 PROJECT_GUIDE.md 会制造第四个入口、加剧「多文档矛盾」问题，与本次治理目标相反。
- **替代建议**（本轮不执行）：在 README 顶部加一节「AI 阅读规则」（即本报告 §7 的浓缩版）。

## 10. 后续文档整理建议（仅建议，不执行）

1. **S2 顺手做**：给 T1-A 系列 13 份头部统一挂「已被 2.0-CONVERGED-PLAN 取代」标注（已列入 2.0 §六）；清理 schema 注释里的 baseline 旧术语。
2. README 增「AI 阅读规则」小节（必读/按需/禁用三张短清单）。
3. 不合并、不删除、不移动任何历史文档（T0 ACCEPTED 与产品业务资料尤其不动）；不新建目录体系。
4. `sample-article.html` / `sample-qwen-panel.png` 保持原位即可（素材类）。
5. 写作类文档（WRITING-PIPELINE / WRITING-GUIDE / TRACK-FORM-RESEARCH）长期有效，任何技术重构不得将其标为废弃。
6. 之后**停止产出方案文档**：除阶段验收记录外，不再新增设计/方案/评审类文档。
