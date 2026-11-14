# 重构实施清单

**文档版本**：V1.0（RESTRUCTURE-PLAN-V1 第一阶段交付物②）
**日期**：2026-11-12
**上游**：《项目现状审计报告》（`docs/AUDIT-REPORT.md`）——问题编号 P1-P14、裁决点 §13 均指该文档。
**状态**：清单就绪，**代码未动**。每阶段开工前先读对应审计条目；每阶段收尾必须过"验收门禁"才算完成（PLAN §16.4）。

---

## 0. 使用说明

1. **阶段顺序即依赖顺序**，未完成上一阶段验收不得进入下一阶段大规模改造（PLAN §16.4）。
2. 每个文件条目格式：`文件 — 动作 — 具体改动（关联问题编号）`。动作 ∈ 新增 / 修改 / 重构 / 封版 / 废弃。
3. **验收门禁（每阶段收尾必跑，全绿才算完）**：
   ```bash
   cd server
   npm run typecheck
   npm run smoke:lint        # 71 项，写作链路回归
   npm run smoke:style       # 27 项，配置体系回归
   npm run smoke:angles      # 选题 CRUD 回归
   # 会写库的新验证脚本一律先复制 dev.db 到隔离库再跑（铁律）
   ```
4. 每阶段完成后按 `docs/PROGRESS.md`（如无则建）登记状态，并在 `CHANGELOG.md` 追加条目。
5. **全局不做清单**：不建传统素材库、不接付费搜索 API、不换技术栈、不动群发红线、不删现有数据、不动漫画产线（除共享配置层外）、不做微服务拆分。

---

## 阶段 2：赛道配置与 Prompt 体系重构

**目标**（对应 PLAN §13 第二阶段 / 审计 P1 P4 P5-P13 配置侧）：
形态契约（TrackContract/form）成为单一真源；Prompt 统一渲染；配置保存有 schema+算术校验；迁移区封版；每次生成可记录契约版本。

**前置裁决**：审计 §13 ①③④ 必须先拍板（默认兜底策略、数字进档案的三道闸、TrackContract 砍半范围）。

### 2.1 数据层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/prisma/schema.prisma` | 修改 | 新增 `TrackContract`（trackId、version、formJson、reviewPolicyJson、status、createdAt）；新增 `PromptVersion`（taskType、version、prompt、note、createdAt）；`Track` 加 `contractVersion?`。**不删任何现有字段**（qualityJson 标 @deprecated 注释） |
| `server/prisma/schema.sqlite.prisma` | 生成 | `npm run schema:sqlite` 重新生成（铁律：不手写第二份） |
| `server/src/services/form/schema.ts` | 新增 | 形态档案 zod schema：`rhythm ∈ {essay,mixed,list,sliced}`、`sections:[2..6]`、`chars:[1000..4000]`、`paraMax:[80..300]`、`subjects?[]`、`postprocess?[]`；**算术校验** `validateForm()`（sliced：`subjects×每座段均下限+场景段 ≤ chars 上限`）；错误信息可读（P5） |
| `server/src/services/form/render.ts` | 新增 | 统一 Prompt Renderer：输入（global/track/form/variants/plan?）→ 输出 system+user 消息；数字只经 `{{变量}}` 注入（复用 `writer.renderTemplate`，迁到此处单源）；输出附 `contractVersion`（P1/P4） |
| `server/src/services/form/contract.ts` | 新增 | TrackContract 读写：`loadContract(track)`（缺 → 按种子生成 + 标记 needs_review，不静默兜底）、`saveContract`（先过 schema+算术校验）、版本递增 |

### 2.2 配置与提示词

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/services/style-prompts.ts` | 重构 | ①迁移区（:922-1820，style_seed_v2…v15）抽到 `services/form/legacy-migrations.ts` **封版**（只保留可执行入口，不再新增版本）；②种子区保留为"出厂配置"；③`loadStyleForTrack` 返回值并入 contract 读取链；④保存/读取路径接 `validateForm`（P4） |
| `server/src/services/track-rules.ts` | 重构 | `TrackRule` 升级为 form 的查表视图（`rhythm`→段落判据派生、`subjects`→专项检查），`relax` 降级为例外（审计 §13②）；删除 `DEFAULT_TRACK_RULES` 的赛道名键（改为通用默认 + 档案覆盖），**代码里不出现赛道名**（PLAN §3.5 对照表只是文档） |
| `server/src/services/writer.ts` | 修改 | ①`buildSystemPrompt`/`buildPrompt` 改调 `form/render.ts`；②删除骨架卡"与上文冲突以本条为准"（:282，P1）；③`ZODIAC_ANGLE_RULES` 类文案不在本文件（迁往档案/配置）；④保留 `pushBlock` 预算与 `anchorLine` 兜底（迁入 render.ts） |
| `server/src/services/angles.ts` | 修改 | `buildMessages`/`charter`/`scopeBrief`/`ZODIAC_ANGLE_RULES` 文案迁出到配置（`r:{赛道}.anglePrompt` 或档案），代码只做拼装（P8 根治第一步） |
| `server/src/constants.ts` | 修改 | 收缩为宪法边界：`HARD_BOUNDS = { chars:[1000,4000], sections:[2,6], paraMax:[80,300] }` + 安全常量（AUTO_PUBLISH/重试/锁）；赛道级数字（1300-2300 等）改为"默认档"由 form 覆盖（P5 前置） |
| `server/src/services/lint.ts` | 修改 | 阈值改从 form 注入（`lintArticle(html, parsed, form)`），保留常量为缺省值；`relax` 逻辑改由 rhythm 派生（审计 §13②） |
| `server/src/services/prompt-dump.ts` | 小改 | 落盘文件名带 `contractVersion`（为阶段 5 的 GenerationRun 铺垫） |

### 2.3 API 与前端

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/api/routes/style-prompts.ts` | 修改 | `PUT /:key` 对 form/rule JSON 做 schema+算术校验，失败 400 且**不落库**；新增 `GET /contract/:trackId`、`PUT /contract/:trackId`（版本递增）；`/defaults`、`/:key` 顺序坑保持 |
| `web/src/views/StylePromptsView.vue` | 修改 | 形态档案结构化编辑（数字输入+下拉 rhythm+subjects 列表编辑）；保存前展示算术校验结果；沿用 buf/saved 双份判 dirty 范式（UI-GUIDE 5.4） |
| `web/src/api/*`、`web/src/types.ts` | 修改 | 契约类型与端点 |

### 2.4 测试

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/scripts/smoke-style-prompts.ts` | 扩充 | 新增：schema 校验拒坏配置、算术校验（12×74+5 档案拒存 vs 修正后过）、版本递增、renderer 数字同源断言 |
| `server/scripts/fixtures/forms/*.json` | 新增 | 六赛道合法档案 + 3 个非法档案（数字越界/算术不成立/rhythm 非法） |
| `server/scripts/verify-contract.ts` | 新增 | 真机抽 1 篇/赛道，断言渲染出的 prompt 中数字=档案数字（回归 P1"多处数字打架"） |

**阶段 2 验收**（PLAN §13 第二阶段原文对照）：
- [ ] 六赛道档案可读写，坏配置保存被拒（有可读错误）
- [ ] 不同赛道渲染出的 system/user prompt 结构性不同（截图/落盘对比）
- [ ] 配置缺失时报错可读（不静默回落别的赛道调性）
- [ ] 每次生成可查到 contractVersion
- [ ] 迁移区封版：新增配置变更不再需要写 style_seed_vN
- [ ] 验收门禁全绿

**遗留问题记录**：旧 33 条 Angle / 12 篇 Article 不回填 contractVersion（可空，历史即历史）。

---

## 阶段 3：选题引擎重构

**目标**（PLAN §13 第三阶段 / 审计 P6 P7 P8 P13）：
生成与审核分离（候选→审核→正式题库）；六维评分+硬性风险；三层去重接线；内容方向分布；TopicReview 可追溯。

### 3.1 数据层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/prisma/schema.prisma` | 修改 | 新增 `TopicCandidate`（方案 §4.3 字段 + trackId/contractVersion/source/scope，与 Angle 字段对齐便于升格）；新增 `TopicReview`（candidateId、scores Json、risks Json、dupHits Json、verdict ∈ approved/needs_revision/rejected、reason、model、promptVersion、createdAt）；`Angle` 加 `candidateId?`（溯源） |
| 迁移脚本 | 新增 | 存量 Angle 不回溯（视为已审核正式题库，审计 §12.2-4） |

### 3.2 服务层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/services/topic/generate.ts` | 新增（自 angles.ts 拆出） | 候选生成：prompt 走 `form/render.ts`（选题 prompt 配置化，P8）；产出写 `TopicCandidate`（reviewStatus='candidate'），**不再 createMany 进 Angle** |
| `server/src/services/topic/review.ts` | 新增 | 六维评分（正向价值/赛道匹配/读者价值/具体程度/创意差异/可创作性，0-5）+ 硬性风险闸（虚构事实/伪科学/刻板偏见/恐吓/无依据因果/偏离定位/无阅读价值——命中即 rejected，**不被总分抵消**，PLAN §4.4）+ 理由必填 |
| `server/src/services/dedup.ts` | 重构 | ①`judgeAngle` 接入审核链（文本层）；②新增 `similarity.ts`：Embedding 接口 `embed(texts): number[][]`（可替换实现：模型支持→向量余弦；不支持→降级 LLM 判重/词面，PLAN §4.5"不阻断"）；③语义层 + 内容方向层（模型判"核心问题/观点/读者价值是否相同"）；④删除/弃用 `nextCode` |
| `server/src/services/topic/distribution.ts` | 新增 | 赛道选题组合统计：主题/类型/创意方向分布、负面冲突型/方法型/关系型/知识型占比、历史重复问题簇（P13）；**不设统一固定比例**，只识别单一路线过度集中 |
| `server/src/services/angles.ts` | 重构 | 只留 CRUD + 升格逻辑（`approveCandidate`→写 Angle、`needs_revision` 回炉、`rejected` 归档）+ 扩库编排（generate→review→dedup→distribution 报警） |

### 3.3 API 与前端

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/api/routes/angles.ts` | 修改 | 新增 `GET /candidates`、`GET /candidates/:id`（含评分/相似历史）、`POST /candidates/:id/approve|revise|reject`、`POST /candidates/batch-approve`；扩库端点改为产候选 |
| `web/src/views/TrackAnglesView.vue` | 修改 | 候选审核中心：六维评分展示、相似选题及重复原因、通过/改后通过/拒绝/批量；沿用 BatchBar 范式 |
| `web/src/views/DashboardView.vue` | 小改 | 角度池口径加入"候选/正式"两级计数 |

### 3.4 测试

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/scripts/fixtures/topics/*.json` | 新增 | PLAN §14.1 的 10 类样本（高质量/低价值/情绪冲突/伪科学/刻板印象/文本重复/语义重复/核心问题重复/赛道错配/有事实需求），每条带预期判断 |
| `server/scripts/smoke-topic-review.ts` | 新增 | 守门正确率断言（10 类样本的判定矩阵） |
| `server/scripts/smoke-angles.ts` | 扩充 | 候选不可绕审核直接成正式题（断言 API 层）；同义改写对（如"躺在地上/往地上一躺"）必须被文本层拦下（P6 回归） |

**阶段 3 验收**：
- [ ] 候选选题无法未经审核进入 Angle
- [ ] 语义重复/同义改写可被识别（fixtures 断言）
- [ ] 星座赛道产题不再出现"问题咨询式"（守门从代码文案迁到配置后仍生效）
- [ ] 审核失败必有具体理由
- [ ] 分布报表能算出真实占比（分母口径注明）
- [ ] 验收门禁全绿

**遗留**：TopicCluster 表后置（离线脚本先用）；Embedding 供应商待定（审计 §15-2）。

---

## 阶段 4：文章策划与事实核验

**目标**（PLAN §13 第四阶段 / 审计 P9）：
ArticlePlan 独立环节；事实需求分类；免费公开来源适配器；ArticleEvidence 状态机；无来源事实不得标"已核验"。

### 4.1 数据层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/prisma/schema.prisma` | 修改 | 新增 `ArticlePlan`（方案 §5.2：readerProblem/coreInsight/articleType/writingAngle/structurePlan Json/factRequirements Json/estimatedLength/contractVersion/topicId）；新增 `ArticleEvidence`（方案 §6.4 全字段）；`Article` 加 `planId?` |

### 4.2 服务层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/services/article-plan/index.ts` | 新增 | 正式选题→策划：读者问题/核心观点/文章类型/创作角度/结构计划（分节+每节目的+要点）/事实需求清单/预计篇幅；输出过结构校验（PLAN §5.1） |
| `server/src/services/factcheck/needs.ts` | 新增 | 事实需求分类表（PLAN §6.1 十一类→required 真假）；从 ArticlePlan.factRequirements 判"哪些必须核验" |
| `server/src/services/factcheck/sources.ts` | 新增 | 来源适配器接口 `SourceAdapter { name, fetch(url|query): Promise<SourceDoc> }`；第一阶段实现：RSS/Atom、用户提供 URL、用户上传文件、白名单官方页直读（遵守 robots/频率/版权，PLAN §6.2）；**不可用时明确标 unverified，不伪装已核验** |
| `server/src/services/factcheck/verify.ts` | 新增 | 核验检查项（来源存在/可访问/支持主张/不移花接木/时间范围/不把相关当因果/不把观点包装成研究）→ ArticleEvidence 状态机 verified/pending/unverified/rejected；无来源→删主张/改写为观点/阻断发布 三选一 |
| `server/src/services/writer.ts` | 修改 | 生成输入接 ArticlePlan + 已核验 Evidence（PLAN §7.1）；禁止绕过策划直写（函数签名收口） |
| `server/src/services/llm.ts` | 小改 | chatComplete 增加可选 `responseFormat: 'json'` 透传（结构化输出，PLAN §12.3）；**不支持则降级**现有正则抠 JSON |

### 4.3 API 与前端

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/api/routes/plans.ts` | 修改 | 策划生成/查看/编辑端点 |
| `web/src/views/ArticleEditView.vue` 或新 `ArticlePlanView.vue` | 修改/新增 | 策划面板：结构计划、事实需求、证据列表与核验状态 |
| `web/src/views/`（证据中心组件） | 新增 | 证据增删改（来源 URL/摘录/状态） |

### 4.4 测试

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/scripts/fixtures/plans/*.json` | 新增 | 有/无事实需求两类策划样本 |
| `server/scripts/smoke-factcheck.ts` | 新增 | 无来源主张不得 verified；来源不可访问→unverified；虚构 URL 被拒；白名单域名外不抓 |
| `server/scripts/smoke-plan.ts` | 新增 | 策划结构校验 + 写稿收口（不带 plan 的生成入口 400） |

**阶段 4 验收**（PLAN §13 第四阶段对照）：
- [ ] 无外部事实的文章不被强制检索
- [ ] 需核验文章进入核验流程且证据可追溯
- [ ] 无来源事实无法标 verified
- [ ] 来源不可用 → 明确降级/阻断
- [ ] 验收门禁全绿

**遗留**：白名单来源清单初版待用户给（审计 §15-3）；联网能力依赖运行环境出网（部署文档注明）。

---

## 阶段 5：文章生成与质量审核

**目标**（PLAN §13 第五阶段 / 审计 P2 P3 P5 P10 P12）：
按 ArticlePlan 生成、结构差异化；12 维文章审核；段级最小编辑修补；不合格不进待发布；修改可追溯。

### 5.1 服务层

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/services/writer.ts` | 重构 | ①生成按 `ArticlePlan.structurePlan` 展开（不同 articleType 不同组织方式，PLAN §5.3）；②**修补协议改段级最小编辑**：只回传命中段+改法（含替代表达范式），不再复述整篇（P12）；③`repairInstruction` 的 negation 指令携带"对比写成两个画面"替代表达；④修补轮次保持 ≤2，distance 判据不变 |
| `server/src/services/article-review/index.ts` | 新增 | 12 维审核（PLAN §8.1：符合选题/赛道定位/读者价值/空洞鸡汤/机械化表达/内容重复/形态契约/无来源事实/虚构案例/夸大标题党/版权/逻辑）→ 评分+问题位置+修改建议+状态机；复用 lint 作确定性子集，LLM 审核补语义维 |
| `server/src/services/lint.ts` | 修改 | `subjectDup`（同主体多段）等形态唯一性检查升为**可配置 error**（档案 `gate` 控制，P2 底线）；negation 检测补换皮变体进 error 评估（与修补协同） |
| `server/src/services/revise.ts` | 修改 | 定向修改并入审核流（needs_revision → revise 带问题清单）；保留预览/应用两段式 |
| `server/src/services/publisher.ts` | 修改 | 推送门禁增加 `reviewStatus==='approved'`（或 lint+review 双过）；reason 枚举扩 `review_failed` |
| `server/src/services/paragraph-reflow.ts` | 裁决后执行 | 按审计 §13②：保留则限定"只切 >paraMax 超长段、不动归属"并挂 `form.postprocess`；若裁决删除则连带 smoke-lint 断言更新 |
| `server/src/services/generation-run/index.ts` | 新增 | 每次 chatComplete 落 GenerationRun（taskType/businessId/model/promptVersion/contractVersion/inputSnapshot/outputSnapshot/status/耗时/tokens）；快照脱敏（密钥不入）；`llm.chatComplete` 加可选 onRecord 回调或包装器 |
| `server/src/services/prompt-version/index.ts` | 新增 | Prompt 正式修改留版（version/taskType/prompt/note）；配置页保存正式文案时自动存版 |

### 5.2 API 与前端

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/api/routes/articles.ts` | 修改 | `GET /:id/review`、`POST /:id/review`、`POST /:id/review/approve|reject`、`POST /:id/revise-targeted`；`GET /:id/lint` 保留 |
| `web/src/views/ArticleEditView.vue` | 修改 | 审核面板：12 维结果、问题定位（跳转命中段）、修改建议、审核历史、定向修改入口 |
| `web/src/views/ArticlesView.vue` | 小改 | 列表显示审核状态徽标 |

### 5.3 测试

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/scripts/fixtures/articles/*.html` | 新增 | PLAN §14.2 八类样本（多赛道/多类型/有无核验/风险文/违反契约文） |
| `server/scripts/smoke-review.ts` | 新增 | 12 维判定矩阵 + 状态机流转 + 不合格不得推 |
| `server/scripts/verify-negation.ts` | 新增（真机） | 否定框架专测：N 篇生成→统计 negation 命中率与修补成功率（P12 量化回归，替代"修不动"无数据） |
| `smoke-lint.ts` | 扩充 | subjectDup error 门禁、reflow 裁决后的新行为 |

**阶段 5 验收**（PLAN §13 第五阶段对照）：
- [ ] 不同赛道/类型文章结构明显不同（measure:form 指标对比）
- [ ] 文章遵循各自契约（含算术成立的篇幅档）
- [ ] 事实与证据关联可查
- [ ] 不合格文章进不了待发布
- [ ] 修改历史可追踪
- [ ] verify-negation：命中→修补成功率显著提升（目标：修补成功率 ≥70% 或降级决策留档）
- [ ] 验收门禁全绿

**遗留**：审核 LLM 角色归属（审计 §15-4）；一次通过率指标留到阶段 7 基线。

---

## 阶段 6：后台管理与质量分析

**目标**（PLAN §13 第六阶段 / 审计 P11 P13）：
五块后台能力 + 真实数据统计（禁假数据）+ AI 运行记录可查。

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/src/api/routes/reviews.ts` | 新增 | 选题/文章审核中心聚合端点（列表/详情/批量） |
| `server/src/api/routes/analytics.ts` | 新增 | 质量指标（PLAN §11.5 全清单）：每个指标带**分母口径**；样本不足返回 `insufficient_sample` 不出数 |
| `server/src/api/routes/runs.ts` | 新增 | GenerationRun 查询（按任务类型/业务 ID/时间过滤，脱敏展示） |
| `server/src/services/dashboard.ts` | 修改 | 汇总面板接真实指标 |
| `web/src/views/TopicReviewView.vue` | 新增 | 选题审核中心（与阶段 3 的 TrackAngles 审核 tab 整合亦可，避免两页重复——**推荐整合进 TrackAnglesView 的 tab**，少建一页） |
| `web/src/views/QualityView.vue` | 新增 | 质量分析（选题通过率/重复率/赛道匹配率/文章一次通过率/事实可追溯率/历史趋势） |
| `web/src/views/RunsView.vue` | 新增 | AI 运行记录（输入/输出/模型/prompt 版本/耗时/错误） |
| `web/src/router/*`、`UI-GUIDE.md` | 修改 | 路由与规范补录（配置页范式 5.4 之外补"审核中心范式"） |

**阶段 6 验收**：
- [ ] 完整选题审核流程可在界面走通
- [ ] 文章生成过程可追踪（文章→策划→契约版本→prompt 版本→证据→审核）
- [ ] 重复选题及相似原因可查看
- [ ] 所有指标真实计算且注明分母；无假数据页
- [ ] 验收门禁全绿

---

## 阶段 7：整体联调与质量验收

**目标**（PLAN §13 第七阶段 + §14 测试集）：
完整链路/回归/错误场景/迁移/Prompt 质量/多赛道/事实核验全测；建立固定测试集与基线。

| 文件 | 动作 | 改动 |
|---|---|---|
| `server/scripts/fixtures/` | 汇总 | 选题 10 类 + 文章 8 类 + 形态档案非法 3 类全部固化 |
| `server/scripts/verify-e2e.ts` | 新增（**隔离库**） | 全链路：扩库→审核→排产→写稿→体检→审核→（mock 推送）；错误场景（模型超时/格式错/来源失败/重复任务/写库失败） |
| `server/scripts/verify-migrate.ts` | 新增（隔离库） | 迁移可执行+可回滚演练 |
| `docs/PROGRESS.md` | 新增/更新 | 指标基线表（选题赛道匹配率/高相似重复率/事实可追溯率/形态符合率/一次通过率——口径照 PLAN §15） |
| `docs/DEPLOY.md`（或 deploy/README 增补） | 更新 | 新模块环境变量、来源适配器网络要求、GenerationRun 保留策略 |

**阶段 7 验收**（PLAN §15 指标，初期目标）：
- [ ] 选题赛道匹配率 ≥95%
- [ ] 高相似重复率 <5%（注明阈值与抽样验证）
- [ ] 需核验事实可追溯率 100%
- [ ] 文章形态符合率 ≥95%
- [ ] 全链路 e2e 绿、迁移演练可回滚
- [ ] 遗留问题清单 + 已知问题写入 `docs/PROGRESS.md`

---

## 附 A：逐文件改造总表（按文件归并）

| 文件 | 涉及阶段 | 动作 |
|---|---|---|
| `server/prisma/schema.prisma` + `schema.sqlite.prisma` | 2,3,4 | 修改×3（TrackContract/PromptVersion → TopicCandidate/TopicReview → ArticlePlan/ArticleEvidence） |
| `server/src/services/form/{schema,render,contract}.ts` | 2 | 新增 |
| `server/src/services/form/legacy-migrations.ts` | 2 | 新增（自 style-prompts.ts 封版迁出） |
| `server/src/services/style-prompts.ts` | 2 | 重构（瘦身：迁移区出、校验入） |
| `server/src/services/track-rules.ts` | 2 | 重构（并入 form） |
| `server/src/services/constants.ts` | 2 | 修改（收缩为宪法边界） |
| `server/src/services/lint.ts` | 2,5 | 修改×2（阈值注入 → subjectDup error/形态门禁） |
| `server/src/services/writer.ts` | 2,4,5 | 重构（renderer 接入 → plan+evidence 输入 → 段级修补） |
| `server/src/services/angles.ts` | 2,3 | 重构（prompt 迁出 → 拆 generate/review/CRUD） |
| `server/src/services/dedup.ts` | 3 | 重构（judgeAngle 复活 + similarity） |
| `server/src/services/topic/{generate,review,distribution}.ts` | 3 | 新增 |
| `server/src/services/article-plan/index.ts` | 4 | 新增 |
| `server/src/services/factcheck/{needs,sources,verify}.ts` | 4 | 新增 |
| `server/src/services/llm.ts` | 4 | 小改（json mode/记录回调） |
| `server/src/services/revise.ts` | 5 | 修改 |
| `server/src/services/publisher.ts` | 5 | 修改（review 门禁） |
| `server/src/services/paragraph-reflow.ts` | 5 | 裁决后修改/封版 |
| `server/src/services/article-review/index.ts` | 5 | 新增 |
| `server/src/services/generation-run/index.ts` + `prompt-version/index.ts` | 5 | 新增 |
| `server/src/api/routes/{style-prompts,angles,plans,articles}.ts` | 2,3,4,5 | 修改 |
| `server/src/api/routes/{reviews,analytics,runs}.ts` | 6 | 新增 |
| `server/src/services/dashboard.ts` | 6 | 修改 |
| `web/src/views/{StylePromptsView,TrackAnglesView,ArticleEditView,ArticlesView,DashboardView}.vue` | 2-6 | 修改 |
| `web/src/views/{QualityView,RunsView}.vue` | 6 | 新增 |
| `server/scripts/*`（smoke/verify/fixtures） | 2-7 | 新增/扩充（见各阶段） |
| `config/topic_seeds.json` | 2 | 归档 `var/_archive/` |
| `config/style_dna.json` | — | 不动（只作新建赛道种子，运行时不读） |
| `docs/*`（WRITING-PIPELINE 等） | 每阶段 | 回头更新（收尾铁律） |

## 附 B：与 PLAN「最终交付物」（§17）对照

| PLAN 交付物 | 产出阶段 | 落点 |
|---|---|---|
| 1 项目现状审计报告 | 已完成 | `docs/AUDIT-REPORT.md` |
| 2 最终系统架构设计 | 2 | 本清单 §阶段2 + AUDIT §12 |
| 3 数据库 ER 图 | 2-4 | 随 schema 生成（mermaid 存 docs/ER.md） |
| 4 数据模型和迁移文件 | 2,3,4 | prisma/migrations |
| 5 TrackContract 配置体系 | 2 | form/* |
| 6 统一 Prompt Renderer | 2 | form/render.ts |
| 7 新选题生成与审核引擎 | 3 | topic/* |
| 8 三层去重机制 | 3 | dedup.ts + similarity.ts |
| 9 ArticlePlan | 4 | article-plan/ |
| 10 按需事实核验 | 4 | factcheck/ |
| 11 ArticleEvidence | 4 | schema + factcheck/verify |
| 12 新文章生成引擎 | 5 | writer.ts 重构 |
| 13 文章质量审核 | 5 | article-review/ |
| 14 GenerationRun/PromptVersion | 5 | generation-run/ prompt-version/ |
| 15 后台管理功能 | 6 | web + api/routes/{reviews,analytics,runs} |
| 16 自动化质量测试集 | 7 | scripts/fixtures + verify-* |
| 17 部署及配置说明 | 7 | deploy/README 增补 |
| 18 完整测试报告 | 7 | docs/PROGRESS.md 验收记录 |
| 19 未完成事项清单 | 7 | docs/PROGRESS.md 遗留问题 |
