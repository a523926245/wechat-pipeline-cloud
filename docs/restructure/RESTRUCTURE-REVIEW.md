# 对原重构方案（审计报告 V1 + 实施清单 V1）的审查与修订

**日期**：2026-11-12 | 对照对象：`docs/AUDIT-REPORT.md`、`docs/RESTRUCTURE-CHECKLIST.md`（均为本人今日上午产出，本节按"项目真实情况优先于文档设计"原则自我开刀）

---

## 8.1 正确且应保留

| 项 | 为什么对 |
|---|---|
| 审计结论 P1-P14（形态无真源/分工错/修补补丁/迁移反模式/算术矛盾/去重死代码/生成即入库…） | 本次复核逐条对上代码（CURRENT-ARCHITECTURE §6 核对表），无虚构 |
| 「先审计后动工」「分阶段+每阶段验收门禁」的执行纪律 | 与 PLAN §16 一致，且 smoke 回归资产真实存在 |
| 形态契约作为单一真源、数字走 `{{变量}}` 同源注入、三道闸（schema+宪法边界+渲染同源） | 直击 P1/P5；FORM-ARCHITECTURE 设计稿方向正确 |
| 计划先行（D）解决全局唯一性约束；subjectDup 升 error 作底线 | 提示词实证无效（SECOND-OPINION 实测表），程序校验是唯一出路 |
| 修补协议改「段级最小编辑」+ 否定框架前置替代表达 | 直击 P12「三道失灵」 |
| 群发红线、隔离库铁律、路由顺序坑、双产线不动、不建素材库 | 安全与范围约束，全部保留 |
| UI 方向：信息架构先行、不换框架、假数据禁令、AI 操作披露 | 与 UI-UX-REDESIGN-PLAN 及本次诊断一致 |

## 8.2 存在问题的设计（含自我修正）

| # | 问题 | 类型 | 建议调整 |
|---|---|---|---|
| 1 | **TopicCandidate 独立表=过度设计**（与 Angle 同构，防重复升格反而更难） | 数据模型 | 改为 **Angle.status 状态机**（candidate/needs_revision/approved/rejected）+ TopicReview 详情表。理由详见 DATABASE-DESIGN §3.3-③。存量 33 行回填 approved |
| 2 | **清单未把「补 migration 体系」列为独立任务**——现在 prisma/migrations 是空的，这是上线阻断项，不是附带事项 | 遗漏→顺序 | 阶段 1 第一项：建 baseline migration + 迁移演练（隔离库） |
| 3 | **UI 介入过晚**：清单把 web 改造拆散在阶段 2-6 每阶段末尾，导致设计系统反复改、页面风格漂移 | 实施顺序 | 拆出**阶段 0（并行）**：设计系统 P0+壳层+导航重排（纯前端，用现有 API）；业务页面改造随各阶段 API 就绪滚动 |
| 4 | **lint 阈值注入的实施描述含糊**（"阈值改从 form 注入"未说明兼容策略） | 技术风险 | 明确：lint 签名加 `form?` 参数，缺省回落 constants（向后兼容 smoke 断言）；渐进迁移各调用点 |
| 5 | **审核流缺 RBAC 语义**：member/guest 无选题入口，而产品定位是多客户 | 缺业务规则 | 阶段 2 明确：member 可审自己 ownerUserId 名下候选；admin 全量；guest 只读。后端 requirePermission 扩点 |
| 6 | **GenerationRun 无保留策略/脱敏细则**（DB 膨胀+密钥泄漏风险） | 技术风险 | 阶段 4 前置：retention 30 天 + 摘要脱敏正则 + 全量文本不进库（DATABASE-DESIGN §3.3-⑧） |
| 7 | **审核模型角色未定**（新增 review 角色还是复用 revise）会卡阶段 3/4 | 依赖缺口 | 拍板建议：**复用 write 角色模型做批量审核**（省一个绑定位），输出 JSON；将来量大再拆 review 角色（ModelRole 枚举可加值，无迁移痛） |
| 8 | **Embedding 去重未给兜底时序**（"可降级"三字带过） | 技术风险 | 明确三层降级：①embedding（若模型/接口可用）②LLM 批量判重（一次判 20 对，成本可控）③文本 judgeAngle（复活死代码）。**去重服务不可用时只降级不停产**：跳过语义层、文本层照跑、事后补审（记 pending_dedup 标记） |
| 9 | 清单阶段 5 说"reflow 裁决后执行"，但裁决影响 smoke-lint 与段长 CV，未写回滚预案 | 风险 | ROADMAP 阶段 1 就裁决落定（不再悬到阶段 5）；若删 reflow 需同步上段长 CV 监控 |
| 10 | UI 改造清单（清单附 A）把 StylePromptsView 等页面改动写得像"顺手改"，低估 1193 行单页改造量 | 工作量 | 形态契约配置页=**重写**而非修改；并入阶段 1（与契约后端同批） |
| 11 | 测试集（§14 fixtures）只列了选题/文章，缺**契约算术校验用例**与**迁移回滚演练** | 缺测试 | 补：非法 form 3 例（已列）+ 算术边界例 + 迁移 up/down 演练脚本 |
| 12 | 审计 §13 冲突①「两步走默认兜底」没有量化第一步的验收 | 缺规则 | 明确：第一步=六赛道种子即完整配置、load* 不再静默回落（warn+error 可见），验收=删掉任一配置行后写稿报错可读 |

## 8.3 遗漏项（按维度）

| 维度 | 遗漏 | 补法 |
|---|---|---|
| 数据库 | ①无 baseline migration ②`expiresAt` 到期降只读无执行点 ③`maxOAAccounts` 无强制 ④qualityJson/contentPath 死字段处置只写"废弃"未写清理时点 | ①阶段 1 ②③产品决策（本期做 enforcement 或显式标记"未实现"）④停写+DEVLOG 标记，v3 大版本再删 |
| 业务流 | ①选题「归还/孤儿」语义在新状态机下的映射未定义 ②漫画产线与新契约的边界只说"不动"，但 comic 也读 StylePrompt | ①used + status 矩阵写进阶段 2 验收 ②comic 短期只读旧配置路径，契约分阶段覆盖 |
| AI 调用 | ①批量审核降本（一次判多条）未提 ②功能调用（Agnes 支持 tools）未评估用于结构化输出 | ①并入审核设计 ②阶段 1 renderer 输出 JSON 可试 tools，失败回落正则抠 |
| Prompt | revi​se.ts / cover.ts / comic 的 prompt 未纳入 PromptVersion 覆盖面 | PromptVersion.taskType 枚举含 revise/cover/comic_script |
| 前端 | RBAC 语义、可视化编辑器可行性（1201 行页重写成本）、双令牌分裂 | 见 UI-UX-AUDIT §0 与 TARGET-UI §7.5 |
| 部署 | 出网白名单（factcheck 服务的 RSS/官方页）在生产环境的网络策略未列 | 部署文档补网络前置项 |
| 安全 | GenerationRun 脱敏、prompt-dump 文件权限、trace 接口的 RBAC | 已并入 DATABASE-DESIGN §3.3-⑧ / 阶段 4 验收 |
| 数据迁移 | 存量 12 篇 Article 无 planId 的追溯链断点如何呈现 | trace 接口对老数据返回"legacy（无策划记录）"，不伪造 |
| 测试 | 契约算术用例、迁移演练、UI 三态回归清单 | 阶段 1/5 fixtures 补齐 |

## 8.4 依赖关系审查

**结论图**（→ = 必须先后；|| = 可并行）：

```text
阶段 0 设计系统P0+壳层+导航(纯前端)          ║  阶段 1 数据层+形态契约+Renderer
        │                                          │
        │  (契约 API 就绪后)                        ├─→ 阶段 2 选题链路(Angle.status+TopicReview+去重)
        ├──────────────────────────────────→        │        │
        │                                          │        ├─→ 选题中心 UI
        │                                          ├─→ 阶段 3 ArticlePlan+factcheck
        │                                          │        │
        │                                          └─→ 阶段 4 生成+ArticleReview+GenerationRun
        │                                                   │
        └──→ 编辑工作区 UI ←────────────────────────────────┘
                                                     │
                                              阶段 5 质量中心+运行中心 UI+测试集+指标
```

**逐问**：
1. **阶段 2（契约/配置）是 3/4/5 的必要前置吗**？——数据层+Renderer 是（3/4/5 的 prompt 都走它、契约版本都要记）；但**选题链路（旧清单阶段 3）不严格依赖完整 form**——它的 prompt 配置化只需 Renderer 骨架。可把"Renderer 骨架+PromptVersion"从契约阶段解耦为先行小步（ROADMAP 已拆）。
2. **选题审核和 ArticlePlan 有依赖吗**？——弱依赖：Plan 消费 approved 的 Angle；Plan 不等选题审核也能开发（用现有 Angle 测）。但 Plan 的"结构计划校验"依赖 form（节数区间）→ 阶段 3 依赖阶段 1 的契约，不依赖阶段 2 的审核 UI。
3. **ArticlePlan → Evidence → Writer → ArticleReview 顺序合理吗**？——合理（Plan 定事实需求 → Evidence 先行 → Writer 带证据写 → Review 终检），且 Evidence 可以**部分并行**于 Writer（不需要核验的文章直接跳过）。原清单 4→5 顺序保留。
4. **UI 何时介入**？——**阶段 0 就介入**（设计系统/壳层/导航/三态组件，无后端依赖）；业务页面改造严格跟随对应 API（选题中心↔阶段 2、编辑审核↔阶段 4）；**禁止前端先行造状态**。
5. **是否先定设计规范与原型再开发**？——是。P0 产出：令牌合并稿+组件清单+5 张关键页低保真（TARGET-UI §7.4 已给结构稿）→ 每页面改造后出截图/预览人工确认（UI 方案 §12-6 采纳）。
6. **后端未稳前端抢跑的风险**？——真实存在（原清单每阶段"顺手改 web"就是抢跑诱因）。控制线：前端只消费**带版本号的 API 契约文档**（阶段 1 起随 PR 提供 openapi 式简表）；状态机字段由后端定稿前端才落组件。
