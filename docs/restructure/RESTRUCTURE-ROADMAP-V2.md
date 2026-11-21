# 重构路线图 V2（修订版分阶段实施计划）

**日期**：2026-11-12 | **效力**：依 `00-FINAL-EXECUTION-CHARTER.md` 执行；取代 V1 清单的阶段编排
**配套**：README 决策登记表（D1-D6/A/B/C/M/P/U/Q/X 已拍板）· DATABASE-DESIGN-REVIEW · PROMPT-AND-CONTRACT-DESIGN · TARGET-UI-ARCHITECTURE · 09-PRE-IMPLEMENTATION-CHECK

> **工作方式（总纲 §六）**：分阶段授权。每阶段开工前须提交（目标/任务清单/受影响文件/DB 变更/API 变更/UI 变更/测试计划/风险与回滚）并获明确同意；结束后提交（修改文件/完成情况/测试结果/DB 变更/与设计差异/遗留/下阶段建议）。实施中发现设计不合理→先报告再动，不得擅自扩大范围。

---

## 决策状态（全部已拍板，D2/D5 带验证条件）

| # | 结论摘要 | 验证条件 |
|---|---|---|
| D1 | Angle.status（审核态四态）+ used（消费态）双维度 + TopicReview 事件表；不建 TopicCandidate；「标重复」=审核事件；存量回填前逐条检查 | 阶段 2 验收含"并发不重复抢占" |
| D2 | reflow 限定保留（排版级，禁加段/改写）；emphasis 保留只动格式 | **先样本对照测试再定默认开关**（阶段 4A 第一项） |
| D3 | 门禁只参数化赛道变化项；安全红线留 L0；规则分硬性/目标/软性三级 | 契约 schema 校验用例 |
| D4 | TrackContract=form+reviewPolicy；N 版本行/Track + 生效指针，旧版不覆盖 | — |
| D5 | 审核复用 write 角色 | **真实样本验证结构化输出**（格式/一致性/失败率/成本），不达标再加 review 角色 |
| D6 | 配置两步走（补齐+告警 → 严格模式） | 步骤①验收=删配置行报错可读 |
| A | RBAC 矩阵（admin 全量/member 自己归属且分能力授权/guest 只读）；后端数据范围实现 | 阶段 2 含越权测试 |
| B | expiresAt/maxOAAccounts：先定需求→要么做强制点要么停 UI 暴露标遗留；本轮不删 | 阶段 1 产出决策 |
| C | 老数据标 legacy，不伪造追溯 | — |
| Q | 去重：精确归一化→文本相似度→批量 LLM 语义判重→人工；Embedding 后置可选（llm.ts 现无 embedding/tools/JSON mode）；**语义判重失败阻止自动升格**（进待补审），不阻塞候选生成 | 阶段 2 验收含"判重失败不放行" |

---

## 阶段 0（可与阶段 1 并行）：设计系统与 UI 壳层

**目标**：UI 的 P0——令牌合并、壳层、导航、三态组件、真机走查。

1. `styles.css`：合并双令牌（基础 + 品牌扩展），定稿 token 清单；**主色 #0a7c47 不改**；深色逐项校对。
2. `App.vue`：标题去重（顶栏留面包屑/状态）；导航按 TARGET-UI IA 重排（选题中心一级入口）。
3. `components/ui/`：AppPageHeader / AppStatusBadge / AppEmptyState / AppErrorState / AppSaveState / AppTaskProgress（骨架）。
4. `UI-GUIDE.md`：增补三态全覆盖 + AI 操作披露规范。
5. 输出选题中心、编辑工作区等**页面原型**（低保真定稿，TARGET-UI §7.4）。
6. **真机浏览器走查**（本阶段验收前置）：Dashboard/选题/文章编辑/配置/模型/暗色/窄屏。

**验收**：现有功能不丢；`vue-tsc --noEmit` + `vite build` 绿；亮暗两态可用；无假数据；走查记录留档。

## 阶段 1：数据库迁移、形态契约、配置迁移、Renderer、PromptVersion

**内部三里程碑**（用户裁定拆分，出问题可定位）：

### 1A · Migration baseline、备份恢复、配置盘点
- 建 `prisma/migrations/` baseline（**先确认与生产 MySQL 实际 schema 一致**）。
- 隔离库验证：SQLite 与 MySQL **分别**验证；备份→恢复流程演练；结构变更与数据变更脚本分离；不能安全 down 的定义向前修复方案（迁移安全观见 02）。
- 配置盘点：六赛道 7 类配置完整性核对；决策 B（expiresAt/maxOAAccounts）落定。
- **产出**：baseline 迁移、恢复演练记录、配置盘点表。

### 1B · TrackContract、配置迁移、Schema 校验
- schema：`TrackContract`（N 版本行/Track + `Track.contractVersion` 生效指针 + [trackId,version] 唯一）、`PromptVersion`、`GenerationRun` 骨架、`qualityJson/contentPath` 标 @deprecated 停写。
- `services/form/`：schema.ts（zod+硬边界+**规则三级标注**）、contract.ts（版本行/发布/回滚）、算术校验**按 rhythm 选式**。
- D6 两步走第①步：六赛道默认配置补齐（种子=完整配置），读取不再静默回落（告警可见）。
- `style-prompts.ts` 迁移区封版抽出；保存接 schema 校验（拦自由文本门禁数字）。
- web：**形态契约配置页重写**（结构化表单+算术校验+版本 diff/发布/回滚）。

### 1C · Renderer、PromptVersion、GenerationRun 骨架
- `form/render.ts` 唯一 Renderer（数字 {{变量}} 同源；输出 meta{contractVersion,promptHash,cursor}）。
- writer/angles 拼装改走 Renderer；删骨架卡"以本条为准"；ZODIAC_ANGLE_RULES 等文案迁配置。
- constants 收缩为宪法边界；lint 加 `form?` 参数（缺省回落 constants，兼容 smoke）。
- PromptVersion 登记（hash 去重）；GenerationRun 表就位（暂只记骨架字段）。
- D6 第②步：校验+运行验证后启用严格模式。

**阶段 1 验收**：坏配置拒存（含算术例）；六赛道契约独立可跑；Prompt 可追溯到版本；迁移与备份恢复经隔离环境验证（MySQL+SQLite 双验证）；`typecheck + smoke:lint + smoke:style` 绿。

## 阶段 2：选题状态机、审核、去重与选题中心

1. schema：`Angle.status` 四态 + `reviewRound` + `metaJson`（存量 33 条**逐条检查**后回填 approved）；`TopicReview` 事件表（scoresJson 六维含评分依据/风险说明、dupHits、verdict、reason、round）。
2. **六维评分**（用户定稿）：赛道匹配 / 读者价值 / 正向导向 / 独特性 / 可写性 / 重复风险——每维有评分依据与风险说明，**高风险一票否决不被总分抵消**。
3. **三层审核机制**（不可相互替代）：①确定性规则（关键词/格式/长度/禁语/赛道硬约束）②语义质量（六维+相似性，批量 LLM 判定）③人工（高风险/边界/需修改）。
4. 去重链（Q 决策）：精确归一化 → 文本相似度（复活 judgeAngle）→ 批量 LLM 语义判重 → 人工处置疑似。**语义判重失败→候选保留但禁止自动升格**（进待补审队列），不阻塞生成。Embedding 后置可选。
5. 分布控制：主题/类型/方向占比，只报警不设死比例。
6. 状态机单点事务（升格=UPDATE WHERE status='candidate' 幂等防重复升格）；正向价值口径：**允许讨论问题/困境/失败/负面情绪，但落点须理性、有建设性**——不是鸡汤化。
7. RBAC（A 矩阵）：member 只管自己归属且分能力授权；后端数据范围实现；越权测试。
8. web：选题中心（五 Tab + 审核工作台 + 批量仅无风险项）。
9. fixtures：选题 10 类样本 + 判定矩阵。

**验收**：AI 生成不能直入正式题库；仅 approved 可被排产消费；重复候选不能绕过治理；**并发不重复抢占**；判重失败不放行；`smoke:angles` 扩充绿。

## 阶段 3：ArticlePlan 与事实核验

1. schema：`ArticlePlan`（1:1 Article；先支持 article 产线，comic 不强制接入）、`ArticleEvidence`（`[articleId,claimHash]` 唯一）。
2. 计划生成（≤600tok 小调用）+ 程序校验（节数∈form.sections、articleType、sliced 主体清单个数/唯一性）。
3. factcheck：needs（十类分类）→ sources（免费来源边界：官网/RSS/用户提供 URL/机构公开资料/用户上传材料/已有历史内容；**网页可访问≠事实已核验**）→ verify（七项核验）→ Evidence 状态 pending/verified/unverified/rejected；**没有来源支持的事实不得由 AI 凭空补充**，标 unverified 而非编造。
4. writer 接口收口（generateDraft(article, plan, evidence)）；lint 增 `plan_sections` 对账。
5. 编辑工作区展示计划摘要与证据列表。

**验收**：结构与契约一致；来源可追踪；无法验证明确标记；不编造证据；无核验需求文章零 Evidence 行。

## 阶段 4：文章生成、审核、修订、GenerationRun 与发布门禁

**内部三小步**：4A 生成与定向修改 / 4B 审核状态机与人工覆盖 / 4C 追溯与发布门禁（不一次性动 writer+lint+review+publisher+编辑器全部逻辑）。

### 4A · 生成与定向修改
- **第一项：reflow 对照测试**（D2）→ 定默认开关；emphasis 限定只动格式。
- 按 structurePlan 生成（各 rhythm 各组织方式）；修补改**段级最小编辑**；否定框架三件套（前置替代表达 + 段级修补 + error 保留 + verify-negation 量化回归）。
- 禁止：自动加主体段、自动补字数、自动修结构（只能走定向修改流程）。

### 4B · 审核状态机与人工覆盖
- `ArticleReview`（issuesJson 带 **blockIndex** 段落定位/类型/级别/片段/建议/round）；**审核状态与 Article 生命周期/发布状态分离**（draft ≠ 可推送）。
- 人工覆盖：允许，但记录操作人/时间/原结论/覆盖原因；**实质修改后相关审核结果必须重查**。
- 文章审核维度照 PLAN §8.1 十二项收敛；D5 验证条件在此步完成（write 角色结构化审核真实样本测试）。

### 4C · 追溯与发布门禁
- GenerationRun 全量接线（计划/生成/修补/审核各记）+ 脱敏 + 保留策略（**先确认合规需求再定 30 天**）。
- `GET /api/articles/:id/trace`（老数据=legacy 不伪造）。
- publisher 门禁 += 审核通过（reason 扩 review_failed）；人工终审不动。
- 文章编辑工作区正式上线（可视化默认+源码高级+质量面板定位跳转+AI 改两段式补撤销）。

**验收**：生成→审核→修改→复审→推送闭环；未过门禁推不出去；群发仍人工；trace 可查；D2/D5 验证记录留档。

## 阶段 5：质量中心、AI 运行中心、测试与系统验收

1. **五项核心验收指标**（总纲 §七）落地：API 按分母/周期/来源口径出数；**分母<10 显示「样本不足」**不出百分比；指标⑤埋点（编辑页保存/改动计数）接入前显示「未接入」。
2. 质量中心 UI（选题质量/文章质量/事实核验）；AI 运行中心 UI（调用记录/失败分析/Prompt 追溯）；**统一任务中心**（排队/执行/成败/取消/结果）。
3. 测试集固化：选题 10 类 + 文章 8 类 + 契约算术边界例 + 迁移演练脚本 + verify-e2e（隔离库，含错误场景）。
4. 文档/CHANGELOG 回写；遗留问题清单；UI 全量走查。

**验收**：指标真实可算且注明口径；追溯链完整；关键流程可重复测试；旧功能/双产线/历史数据无破坏；**五项指标基线入 PROGRESS**（这是项目验收依据，不是文章产量）。

---

## 全程红线（每阶段有效，与总纲 §二一致）

群发永不人工以外的方式触发（AUTO_PUBLISH=false）｜写库/迁移/测试一律隔离库｜禁止真实生产库试验｜破坏性修改先报影响+备份+恢复方案｜不删历史数据｜不接付费搜索 API｜前端不造假数据｜AI 推测不冒充已验证事实｜每阶段收尾 `typecheck + smoke:lint + smoke:style + smoke:angles` 绿 + 文档/CHANGELOG/记忆回写｜comic 产线不重构但 PromptVersion 覆盖 comic_script/cover/revise 任务类型。

## 风险登记（12 项，见 09 §七详表）

生产 MySQL 无 baseline｜status/used 混淆｜PromptVersion 与 StylePrompt 职责重叠｜GenerationRun 与 prompt-dump 生命周期不一致｜语义去重失败放行｜ArticleReview 与 Article 状态混用｜核验简化为 URL 可达｜member 越权｜UI 假状态｜comic 回归｜**Python 本机流水线与云端关系未清**（09 §五）｜出网与密钥暴露。
