# S4-0 业务流程与内容质量现状核查报告

- **日期**：2026-11-14
- **性质**：只读核查。未修改任何代码、数据库、配置、环境变量或 migration；未执行 LLM / 微信 / 发布调用；未更新 CHANGELOG/DEVLOG。
- **数据源**：① 本机代码（server/src、web/src、prisma/schema.prisma）② MySQL `wechat_pipeline`（只读 COUNT：15 表 **0 行**，空库起步状态未变）③ 归档 `server/prisma/dev.db`（只读查询：15 表 159 行，Angle 33 / Article 12 / TaskRun 11）。
- **结论分级**：`【事实】`=代码/数据实证 ｜ `【样本判断】`=基于小样本（33 选题 / 12 文章 / 6 赛道）的判断 ｜ `【推测】`=未验证推断。
- **基线**：`docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md`（S4 范围=选题质量·六维评分/去重链轻量版 + 创作链路 + 审核流程）；`docs/restructure/00-FINAL-EXECUTION-CHARTER.md`（Angle.status+used+TopicReview 等已拍板决策）；`docs/WRITING-PIPELINE.md`。S1–S3 验收成果未触碰。

---

## 1. 当前实际业务流程图

```
── 选题生成 ──────────────────────────────────────────────
A. LLM 扩库（主路径）
   TrackAnglesView → POST /api/tracks/:id/expand（tracks.ts:270）
   → expandAnglesForTrack（angles.ts:330）
     prompt = 创作总纲(global StylePrompt, 含正能量约束)
            + 选题补充(方法钩子/禁心理标签, angles.ts:215-223)
            + scopeBrief(文章/漫画/两栖, :135) + 星座覆盖规则(:176, 仅 angleMode=zodiac)
            + 已有选题避让清单(赛道内, ≤50 条, :357-360)
     → chatComplete(expand_angles 角色)
     → topicRejectReason 确定性守门(:291) → normalize 精确去重(:397)
     → angle.createMany —— 【入库即正式题库，无候选态/无审核】
B. 手动新增 POST /api/angles → createAngle(angles.ts:729) —— 【零守门、零去重】
C. 历史导入 cli/migrate.ts（一次性工具，唯一使用 dupScore 处）

── 选题消费 ──────────────────────────────────────────────
scheduler.tick(scheduler.ts:243) / 手动触发
→ runPipelineForAccount(planner.ts:318) → reserveAnglesForPipeline(:267, 事务标记 used)
→ 取用顺序 = seq 升序 FIFO（与质量零关联）

── 文章生成 ──────────────────────────────────────────────
generateDraft(writer.ts:522)
  loadStyleForTrack + pickVariants(游标轮换)
  buildSystemPrompt(sys:{赛道} 模板+数字锚) + buildPrompt(总纲/文风/s:规范/tail, 预算 7600)
  → chatComplete → postProcess(sanitize→emphasis→reflow)
  → lintArticle(error 4 项 / warn 12+ 项) → repairOnce ≤2 轮(只修 error)
  → planner 落库 Article(status=draft)  【WriteResult.note 不落库，见 §5】

── 人工审改（无独立审核态，「审核」=人看预览自行决定）──────
ArticlesView 列表 → ArticleEditView
  preview(GET /:id/preview，与推送同函数 render，附 lint 报告)
  手动改稿(PUT /:id/content，返回 lint) ｜ AI 改写(/api/revise preview+apply)
  ｜ 强调补全 ｜ 封面生成
  → 人工确认 → POST /:id/push

── 推送 ──────────────────────────────────────────────────
pushArticleToDraft(publisher.ts:56)：凭据校验 → lint 门禁(error 拦截)
→ 封面上传 → addDraft 【只进微信草稿箱，绝不群发；AUTO_PUBLISH=false】
→ status=pushed + TaskRun(push) 流水

── 自动化三层（scheduler.ts:46）──────────────────────────
manual ｜ auto_draft(到点写稿入库，人工审后手动推) ｜ auto_draft_push(到点写稿+自动推草稿箱)
群发永远人工。当前云端 User.automationMode 全 manual（DEVLOG），自动出稿=0/日。
```

【事实】来源：上述文件行号逐一核对。渲染不变量「预览=推送同函数」成立（articles.ts:394-461 调 build→renderArticle；publisher 用 contentWechat=同函数产物）。

---

## 2. 选题质量控制现状

| 核查项 | 结论 | 证据 |
|---|---|---|
| 选题从哪里产生 | LLM 扩库（expand_angles 角色）为主，另有手动 CRUD 与历史导入 | angles.ts:330；tracks.ts:270 |
| 提示词/规则/数据 | 创作总纲（global，正能量）+ 选题补充硬约束 + scopeBrief + 星座专用规则 + 赛道内已有选题 ≤50 条避让 | angles.ts:195-255 |
| 评分机制 | **不存在**。全仓无选题评分维度/权重/打分函数；Article.qualityJson 字段零引用（死字段） | schema.prisma:310；grep 全仓 |
| 评分影响筛选 | 不适用。消费顺序恒为 seq 升序 FIFO，质量与排序/淘汰零关联 | planner.ts:277-281 |
| 正能量/定位约束 | **有**，三道：①提示词总纲+选题补充 ②topicRejectReason 确定性守门（禁心理病理标签 theme、非星座题尾 24 字须有方法钩子；星座题禁咨询式/禁问句收尾/须星座锚/≥12 字）③成稿 lint 的 fear_selling（warn） | angles.ts:257-319；lint.ts:437-447 |
| 守门覆盖缺口 | 只拦「心理标签/纯困境/星座形态错」；**无**空洞、标题党、过度煽情、赛道定位契合度维度 | angles.ts:291-319（判据穷举核对） |
| 人工审核位置 | **无前置审核**：扩库即入正式池；人工只有事后编辑/删除/归还（TrackAnglesView）。Angle 无 status 字段，TopicReview 表不存在（15 模型逐一核对）——charter 的「candidate→approved」是 S4 待建 | schema.prisma:249-276；00-FINAL-EXECUTION-CHARTER.md §三2 |
| 手动路径守门 | createAngle/updateAngle **不过** topicRejectReason、**不做**去重 | angles.ts:729-779 |

`【事实】` 全部行号实证。「低质量选题是否存在」见 §6（样本）。

---

## 3. 选题重复检测现状

| 层 | 是否存在 | 实现 | 是否影响入库 |
|---|---|---|---|
| 标题完全重复 | ✅ | normalize()（去空白/全半角/小写/标点归一）精确 Set 匹配 | 扩库路径重复直接丢弃（skippedDuplicate 报账） |
| 标题近似 | ❌（live） | dedup.ts 的 judgeAngle 三层判重（bigram Jaccard+containment，simAngle 0.45/simHistory 0.35/themeCap 8）**仅被 cli/migrate.ts:188 引用**，live 链路零调用 | — |
| 主题/角度语义相似 | ❌ | 无任何机制（无向量/无语义比对/无标题比对） | — |

- **检测范围**（扩库路径，angles.ts:347-353）：赛道内全切片、按 seq desc 取 **500 条**（更旧逃逸）；**跨赛道不查**；历史文章标题不查；批次内互查（seen 递增）。
- `【事实】` 手动新增/编辑完全绕过一切查重（§2 证据）。
- **实际案例**（§6f）：字面重复 0 组；**主题级近似 2 组跨赛道放行**（#1174/#1210 孩子锁门拒沟通；#1204/#1212 甩锅）——其 bigram 分仅 0.028/0.000，**现有全部算法（含 judgeAngle）都拦不住**。`【样本判断】` 词面去重治「洗稿」有效，治「同题换皮/跨赛道撞题」无效。

---

## 4. 创作质量检查现状

**职责分工**（“lint/style/angles”易混，实际是两层）：
- 运行时检查：lint.ts（成稿体检）、topicRejectReason（选题守门）、postProcess（确定性后处理）、repairOnce（定向修补）。
- smoke 套件（测试）：smoke:lint 116 项（体检+提示词注入+后处理）、smoke:style 41 项（配置/变体/relax）、smoke:angles 30 项（选题 API CRUD）。`【事实】`

**lint 分级**（lint.ts:336-553，阈值同源于 constants.ts）：
- error 4 项（sections 3-4 / chars 1300-2300 / dash 0 / negation 0）→ 拦推送 + 驱动 repair 循环。
- warn 12+ 项（para_shape/para_short/para_overlong/summary_openers/ending_hook/emphasis/key_emphasis/citation/fear_selling/zodiac_topic/textbook/repeat/dup）→ 只提示。
- `r:{赛道}.checks` 启用专项、`.relax` 豁免 warn（error 不可豁免，S3 已统一四处调用点同源）。

**检查结果的实际影响**：
- error → repairOnce ≤2 轮（distance=error×10000+字数偏离，进步才续）→ 修不动保留最好版本。
- `【事实】` 残留问题只写进 **WriteResult.note**（writer.ts:648-673），而 planner 落库 **不写 Article.note**（planner.ts:390-405 create data 无 note 字段）→ 数据实证 12 篇 Article.note 全空。「修不动的稿子 note 里说清剩什么问题」（WRITING-PIPELINE §6.2）在产稿路径**落空**。
- push 时同一套 lint 作门禁（publisher.ts:116-139）；warn 不拦。
- revise（AI 改写）apply 后**不自动复检**（revise.ts:52-89），复检依赖人再点预览。

**规则重复/标准不一致**（`【事实】`）：
1. **ending_hook 判据与分赛道结尾形态冲突**：lint 要求「结尾第二人称提问」（lint.ts:458-472），但 sys: 分赛道结尾是「育儿=可转发到家庭群的一句话/科技=一句判断+真实体验/教育=家长老师各一件小事」（WRITING-PIPELINE §3.3 表）——非提问式结尾是赛道正常写法，却恒刷 warn（relax 只配了 para_*）。散文尺子量清单体问题在结尾维度重现。
2. **死代码/意图未接线**：NEGATION_SOFT_RE（注释称「只做 warn」实际从未接线）、EMOTION_SETTLE_RE、ORAL_MARK_RE、cv()、splitSentences() 均为 ai_taste 移除残留，零调用（grep 全仓）。
3. **两套去重并存**：dedup.ts（近似判重）与 angles.ts normalize（精确）互不知晓，live 只用后者。
4. **同一语义两种状态**：手动改稿 pushed→draft（articles.ts:515），AI 改写 pushed→updated（revise.ts:76）。
5. 文档-实现漂移：planner 头注释「给出近作供写稿观点层去重」——avoid 实际只在 PlanView 展示，**不进写稿 prompt**（buildPrompt 无此输入）。

---

## 5. 审核与修订流程现状

| 环节 | 现状 | 断点/问题 |
|---|---|---|
| 选题审核 | 不存在（无状态机/无记录） | 低质题直接入池，指标①②无数据源 |
| 草稿生成 | 调度/手动；模型不可用回退骨架草稿 | note 不落库，残留问题不可见 |
| 文章预览 | 与推送同函数渲染 + lint 面板（「可推送/会被拦下」） | ✅ 无断点 |
| 质量检查 | GET /:id/lint 只算不落库；preview/PUT/push 三处同规则 | 结果不持久化，无法追溯 |
| 人工审核 | 无独立步骤/无留痕——人看预览自行决定推送 | 五项指标③⑤（一次通过率/人工修改量）无任何数据来源 |
| 文章修改 | 手动 PUT /content ｜ AI revise ｜ 强调补全 | 状态语义不一致（见 §4.4） |
| 再次检查 | 手动再点预览，或推送时被动拦截 | 改后不强制复检；忘看则推送白跑一次外网调用才被 lint 拦 |
| 微信草稿推送 | pushArticleToDraft 统一入口；只进草稿箱 | ✅ 红线保持（AUTO_PUBLISH=false，无 masssend） |

**角度回收漏洞** `【事实】`：article-delete.ts:52 以 `status !== 'pushed'` 判定归还；pushed 文章经手动改稿变 draft（articles.ts:515）后再删除 → 角度被归还 → 同一选题（已进过微信草稿箱）可再写再推，与「pushed 刻意不归还防同题重写」设计意图（angles.ts:478-481 注释）矛盾。revise 产出的 updated（语义=曾推送后改写）删除同样归还。

**五项验收指标现状**（charter §七）：①选题审核通过率 ②选题重复率 ③一次审核通过率 ⑤人工修改量 = **全部无数据来源**（无 TopicReview/ArticleReview/埋点）；④事实核验覆盖率属 charter 阶段 3（ArticlePlan/Evidence），不在本轮范围。`【事实】`

---

## 6. 真实数据抽样发现（dev.db 归档 33 选题 / 12 文章全量复算）

> MySQL 业务库 0 行，无新数据可查；以下全部来自归档 dev.db 只读查询。守门复算=按现行 topicRejectReason 规则逐条重放。

- **a) 星座题 9/9 全是「问题咨询式」**（#1143-1151：「该如何高情商澄清/该怎么开口/如何平衡…」）——现行守门**全部会拒**；这 9 条正是 angles.ts:170 注释点名的历史问题形态。其中 8 条已用并产出 8 篇星座稿（Article 677/678/743-745/764-766）——「星座稿长成职场沟通文」的直接根因样本。`【事实】`
- **b) 门禁漂移**：33 条存量中 **10 条（30%）**在现行守门下不合格（9 星座咨询式 + 育儿 #1175 结尾无方法钩子）；剩余未用星座题 #1151 也是被禁形态。`【事实·全量复算】`
- **c) 赛道-选题形态脱节**：激励赛道 4 条（#1209-1212）全是职场/亲子/代际「怎么办」冲突题，与激励 sys: 形态（普通时刻+3-4 件小事）不符；除星座外无 angleMode 分化，scopeBrief 通用文案把各赛道推向「困境+如何」。`【样本判断】`
- **d) 标题句式收敛**：12 条标题中 4 条「都说X，其实Y」（677/743/744/764）+ 2 条「N 个…第 3 个最…」标题党式（678/765）；741「…深夜，我在…里听见了回声」正是 WRITING-PIPELINE §12 记录的收敛句式。`【事实】`
- **e) 门禁真实拦截样本**：#765 chars=1106 < MIN_CHARS 1300（error 必拦推送）；其 contentHtml 有强调标签嵌套损伤（`<strong>狮子座通<strong class="key">…`）。`【事实】`
- **f) 重复**：字面重复 0 组（normalize + bigram 0.35 阈值）；主题级跨赛道近似 2 组（#1174/#1210 锁门拒沟通；#1204/#1212 甩锅），词面算法全漏。`【事实·算法复算】`
- **g) note 全空**：12 篇 Article.note 均空，印证 §4 note 不落库。`【事实】`
- **h) 切片失衡**：33 条全部 scope=article，comic/shared=0（漫画产线角度库存 0）。`【事实】`
- **i) 无「过度煽情/标题党选题」直接样本**（守门拦了纯困境与心理标签），但 #1205「如何设计一套隐蔽又可持续的变现路径」（教人瞒着单位做副业）过了全部守门——正能量/定位约束只查句式与标签，不查价值观。`【样本判断】`

---

## 7. 问题清单（按影响程度排序）

| # | 级别 | 问题 | 证据 |
|---|---|---|---|
| P0-1 | 高 | 选题无评分、无审核态、无淘汰机制：扩库即入池，30% 存量按现行守门不合格仍可被消费；seq=FIFO 与质量零关联；五项指标①②无数据源 | §2、§6a/b |
| P0-2 | 高 | 去重只有词面精确匹配：judgeAngle 三层判重成死代码；语义/主题级重复全放行（实测 2 组跨赛道）；手动新增/编辑零校验 | §3、§6f |
| P0-3 | 高 | lint 残留结果不落库（note 丢失）+ 审核无留痕：人工审核无凭据可依，指标③⑤无数据源 | §4、§6g |
| P1-4 | 中高 | 状态机语义不一致（pushed→draft vs pushed→updated）+ 角度回收漏洞（pushed 改稿后删除归还角度=同题可重写重推） | §5 |
| P1-5 | 中 | 选题形态与赛道写作形态脱节（angleMode 仅 default/zodiac 两态，激励/科技等产出错位题） | §6c |
| P1-6 | 中 | ending_hook 等 warn 判据与分赛道 sys: 结尾形态冲突，假警报常态化削弱体检可信度 | §4 标准不一致① |
| P2-7 | 中低 | 标题句式收敛 + 「第 N 个最…」标题党式公式未治理 | §6d |
| P2-8 | 低 | 死代码 5 处 + 文档-实现漂移（planner avoid 注释、WRITING-PIPELINE note 承诺、NEGATION_SOFT_RE 未接线） | §4 |
| P2-9 | 低 | warn 无修订闭环、revise 后不自动复检 | §4、§5 |
| P3-10 | 遗留 | 去 AI 味下线（有意为之）；骨架卡/新 sys: 未经多篇真机检验（WRITING-PIPELINE §12 已登记） | 文档 |

---

## 8. S4 建议实施顺序

> 原则：每批独立可验收、不动 S3 已冻结裁决（不建 TrackContract/PromptVersion/GenerationRun）、不动安全红线（AUTO_PUBLISH=false / 只推草稿箱 / 群发人工）。

**S4-1 选题审核状态机 + 评分（轻量版）**
- 必要性：P0-1，指标①②前置；charter 已拍板 Angle.status+used+TopicReview，直接落地不另设计。
- 涉及：prisma/schema.prisma（Angle.status、TopicReview 表）、services/angles.ts、api/routes/tracks.ts+angles.ts、web/TrackAnglesView.vue、smoke:angles 扩充。
- 内容：扩库/手动新增先进 candidate；六维评分（定位契合/具体画面/冲突反差/方法落点/情绪安全/差异化）出分并影响排序与淘汰；人工审核（approved/rejected/needs_revision）后才可被排产消费；存量 33 条回填策略单独定。
- 验证：smoke:angles 计数不降且新增状态机用例；隔离库跑通「生成→评分→审核→消费」；指标①②出数（分母<10 只出计数，charter 口径纪律）。

**S4-2 去重链轻量版（judgeAngle 接线）**
- 必要性：P0-2；dedup.ts 算法已有且经 Python 蓝本校准，接线成本低。
- 涉及：services/angles.ts（扩库+createAngle+updateAngle 统一入口）、services/dedup.ts（复用，不动阈值真源 constants.ts）。
- 内容：三层判重进 live（现有选题/历史标题/主题堆积）；命中记入 TopicReview.dupHits；跨赛道同题至少给提示。
- 验证：用 #1174/#1210、#1204/#1212 型用例做回归（主题级提示）；扩库 skipped 报账口径扩展；smoke 扩绿。

**S4-3 lint 结果落库与审改闭环**
- 必要性：P0-3、P2-9；先有可见性再谈指标③⑤。
- 涉及：services/planner.ts、writer.ts、api/routes/articles.ts、revise.ts、web/ArticleEditView.vue。
- 内容：WriteResult.note（含残留 error/warn 摘要）落 Article.note（或 qualityJson 启用）；改稿/改写后响应强制带最新 lint；push 被拦时原因可见于文章页；编辑行为最小埋点（保存次数/改动来源）支撑指标⑤。
- 验证：新生成草稿 note 非空；「生成→改→检→推」链路 lint 信息全程可见；smoke:lint 不降。

**S4-4 状态机与角度回收语义修正**
- 必要性：P1-4，数据正确性（同题重写重推风险）。
- 涉及：api/routes/articles.ts、revise.ts、services/article-delete.ts、services/angles.ts。
- 内容：统一「曾送达微信」语义（建议引入 everPushed 或统一 pushed→updated），删除回收规则改按「是否送达过」判定；两处改稿路径状态统一。
- 验证：smoke 新增「push→改稿→删除→角度不归还」用例；单条/批量删除共用语义回归。

**S4-5 选题形态分赛道 + warn 判据分赛道适配**
- 必要性：P1-5、P1-6。
- 涉及：services/track-rules.ts（angleMode/ending 形态扩展）、angles.ts、lint.ts、style-prompts 种子与配置页。
- 内容：r:{赛道} 增加选题形态与结尾形态声明；scopeBrief/守门按形态分化（激励=普通时刻+小事、科技=场景+比喻+信号…）；ending_hook 按赛道口径判或归入 relax 默认。
- 验证：激励/科技扩库样本人工比对「像不像该赛道」；warn 假警报率对比（S6 指标口径）。

**S4-6 标题多样性治理**
- 必要性：P2-7（WRITING-PIPELINE §14 已列）。
- 涉及：services/writer.ts（pickVariants）、style-prompts（v:{赛道}:title 增句式维度）、可选近 N 篇标题比对。
- 验证：连续 10 篇标题句式分布统计；「都说X其实Y」占比下降。

**S4-7 清理与文档校准**
- 必要性：P2-8，防误导后续开发。
- 涉及：lint.ts 死符号（接线或删除二选一）、WRITING-PIPELINE.md（note/avoid/去重现状校准）、planner.ts 注释。
- 验证：typecheck 0 + 三冒烟计数不降（lint 116 / style 41 / angles 30）。

---

## 附：本轮零变更声明

未修改代码 / 数据库 / 配置 / 环境变量 / migration；MySQL 与 dev.db 全程只读（SELECT/COUNT 级）；未执行 LLM、微信与发布调用；未更新 CHANGELOG / DEVLOG；不进入 S4-1。**报告完成，停等确认。**
