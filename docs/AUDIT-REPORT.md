# 项目现状审计报告

**文档版本**：V1.0（RESTRUCTURE-PLAN-V1 第一阶段交付物①）
**审计日期**：2026-11-12
**审计对象**：`wechat-pipeline-cloud`（Node22 + TS(strip-only) + Express + Prisma + Vue3）
**审计方法**：通读服务层/路由/配置/脚本源码 + 只读查询 `server/prisma/dev.db` 盘点真实数据。**本次未修改任何代码**。

> 配套交付物：《重构实施清单》（`docs/RESTRUCTURE-CHECKLIST.md`，含逐文件改造清单 + 分阶段执行计划）。
> 上游文档：`docs/RESTRUCTURE-PLAN-V1.md`（总体方案）、`docs/SECOND-OPINION.md`（实测数据与 5 问）、
> `docs/FORM-ARCHITECTURE.md`（形态档案设计稿，未实施）、`docs/TRACK-FORM-RESEARCH.md`（形态诊断基线）。

---

## 0. 审计结论（先看这段）

1. **系统骨架是健康的**：模块化单体、鉴权收口、群发红线、模型适配层、双产线（article/comic）、配置页化文风，这些都可以保留。重构不需要推倒重来。
2. **方案里点名的旧模块，现状比方案描述的还要"空"**：
   - `config/topic_seeds.json` 是**死文件**（无代码读取），"固定种子驱动选题"在云端链路已不存在；
   - `services/dedup.ts` 的三层判重 `judgeAngle()` 是**死代码**，运行链路从未调用——线上选题去重实际只有"归一化后精确相等"，同义改写完全防不住；
   - `Article.qualityJson` 是**死字段**（全库无读写）。
3. **形态一致性问题（SECOND-OPINION 的核心症状）的根因在架构，不在提示词**：形态契约散落 4 处且骨架卡优先级最高、模型兼管结构归属、门禁与形态算术不匹配。提示词迭代（v2→v15 一天 14 次迁移）已实证"调提示词"这条路走到底了。
4. **RESTRUCTURE-PLAN 要求的 8 个新实体（TrackContract / TopicCandidate / TopicReview / ArticlePlan / ArticleEvidence / ArticleReview / GenerationRun / PromptVersion）目前一个都不存在**。但 `TaskRun`/`RunLog`/`StylePrompt`/`Setting` 四张表可以承接其中约一半的语义，迁移成本比方案预估的低。
5. **方案与 SECOND-OPINION 硬约束之间有 3 处冲突**（默认兜底 vs 配置非空、reflow 事后切段 vs 不打补丁、数字进不进配置），必须先裁决再动工——裁决建议见 §12。

---

## 1. 当前架构

```text
┌─ web/ (Vue3 + Vite + Element Plus) ──────────────────────────────┐
│ Dashboard / Plan / Articles / ArticleEdit / TrackAngles /        │
│ Tracks / Accounts / Models / StylePrompts / Scheduler / Users    │
└──────────────┬──────────────────────────────────────────────────┘
               │ /api/* (httpOnly cookie + Bearer，authGuard 全量拦截)
┌──────────────▼──────────────────────────────────────────────────┐
│ server/src  Express 模块化单体                                    │
│  api/routes: system auth users credentials tracks angles         │
│    articles models revise plans emphasis scheduler dashboard     │
│    style-prompts（+ api/bulk-delete.ts 批量删除）                 │
│  services:                                                        │
│   写稿链 writer → style-prompts(配置) + lint + emphasis +         │
│     paragraph-reflow + parse/render + prompt-dump                │
│   选题链 angles(扩库+CRUD) ← dedup(仅migrate在用)                │
│   排产链 planner → pipeline(CAS抢占角度)                         │
│   调度链 scheduler(tick) → planner + publisher                   │
│   推送链 publisher → wechat(草稿箱，AUTO_PUBLISH=false 永不群发)  │
│   模型链 llm(chatComplete/generateImage) + model-registry        │
│   漫画链 comic/{script,panels,write}（独立产线，本次重构不动）    │
│  infra: db(Prisma) crypto auth logger request-logger             │
└──────────────┬──────────────────────────────────────────────────┘
               │
     Prisma（本地 SQLite dev.db / 生产 MySQL，schema 单源生成）
```

**技术栈与方案 §12.1 完全一致，无需更换**。改稿页是语义化 HTML 源码编辑（不用富文本），渲染唯一入口 `services/render/index.ts`。

---

## 2. 当前业务流程

```text
【选题】POST /api/angles/expand（手动/运营触发，无定时扩库）
   → assertRoleUsable('expand_angles')
   → buildMessages(赛道 + 总纲 + 已有选题≤50条 + seed自由文本 + scopeBrief)
   → chatComplete(temp .9) → extractJsonArray(正则抠JSON)
   → topicRejectReason 确定性守门（正则：心理标签/方法钩子/星座形态）
   → normalize() 精确去重（仅字面归一化相等才拒）
   → prisma.angle.createMany  ← 候选与正式题库无区分，直接入库

【排产】GET/POST /api/plan 或 scheduler.tick()
   → buildPlan（按账号×产线配额）
   → reserveAnglesForAccount（事务 CAS 抢占 Angle.used）
   → generateDraft（文章）/ createComicDraft（漫画）

【写稿】writer.generateDraft
   → loadStyleForTrack + pickVariants（cursor 轮换三维变体）
   → buildSystemPrompt(sys:{赛道} 模板 + {{变量}}数字锚)
   → buildPrompt(总纲→赛道文风→s:规范三节→选题→变体→sys tail)
   → chatComplete(maxTokens 4096)
   → postProcess(sanitize → emphasis 补加粗 → reflow 段落重排)
   → lintArticle（error 拦 / warn 提示 / r:{赛道} 专项 + relax 豁免）
   → 定向修补 repairOnce ≤2 轮（只修 error，distance 判进步）
   → 落库 Article(draft) + render → contentWechat

【人工审】改稿页（revise/emphasis/预览）→ 人工确认
【推送】publisher.pushArticleToDraft → 再跑一次 lint，error 则 reason='lint_failed' 拦下
【群发】永远人工（AUTO_PUBLISH=false 是常量，publisher 无 masssend）
```

---

## 3. 现有数据库模型（真实表，dev.db 盘点）

| 表 | 职责 | 与 RESTRUCTURE-PLAN 目标实体的关系 |
|---|---|---|
| `Track` | 赛道（6 条：育儿/职场/星座/科技/教育/激励） | 对应目标 `Track`，**保留** |
| `TrackPipeline` | 产线（article/comic）配额与开关 | 保留（方案未覆盖的现有资产） |
| `OAAccount` | 公众号账号（secretEnc 加密） | 保留 |
| `User` / `UserSession` | 系统用户 + 会话（admin/member/guest） | 保留 |
| `WechatToken` | token 缓存 | 保留 |
| `Angle` | 选题角度池（theme/content/scope/used + 归属） | 对应目标 `TopicAngle`，**候选态缺位** |
| `Article` | 文章（contentHtml 真源 / contentWechat 渲染产物） | 对应目标 `Article`；`qualityJson` **死字段** |
| `ComicPanel` | 漫画逐格资产 | 保留（本次不动） |
| `TaskRun` / `RunLog` | 任务执行记录 + 日志 | 部分覆盖目标 `GenerationRun`，**可扩展复用** |
| `LlmModel` / `ModelBinding` | 模型域（vendor/protocol/capability/role） | 保留 |
| `Setting` | 系统设置（含 style_seed_v2…v15 迁移标志 ×14） | 保留；迁移标志是反模式证据 |
| `StylePrompt` | 文风配置单表（7 类 key 约定） | 目标 `TrackContract`/`PromptVersion` 的前身 |

**数据量**（2026-11-12 只读查询）：Angle 33 条（21 未用）、Article 12 篇（全 draft）、StylePrompt 41 行、TaskRun 11 条（全 write/success）、模型 4 个（文本角色全绑 Agnes 3.0 Flash）。

**方案要求的实体全部缺失**：TrackContract / TopicCandidate / TopicReview / TopicCluster / ArticlePlan / ArticleEvidence / ArticleReview / GenerationRun / PromptVersion / TopicHistory——`grep` 全库零命中。

---

## 4. 选题生成调用链（含代码证据）

```text
POST /api/angles/expand (api/routes/angles.ts)
  └─ services/angles.ts:330 expandAnglesForTrack(trackId, count, seed?, scope)
       ├─ :342  assertRoleUsable('expand_angles')            ← 模型角色绑定
       ├─ :347-360 现有选题取 500 条，seen=normalize(content)  ← 去重集合
       ├─ :363  loadGlobalPrompt()                            ← 与写稿共用总纲
       ├─ :365  chatComplete(buildMessages(...), {temp:.9})
       │         buildMessages(:195-255)：
       │           system=「只输出 JSON」
       │           user=赛道 + 总纲charter + 已有选题 + seed + scopeBrief + 硬性要求 6 条
       │           ⚠️ :227 angleMode==='zodiac' 时追加 ZODIAC_ANGLE_RULES(:176-193)
       │              —— 这段"星座选题形态"文案硬编码在代码里，配置页改不到
       ├─ :371  extractJsonArray(正则抠 [ ]，兼容围栏)        ← 无结构化输出协议
       ├─ :389-396 topicRejectReason 确定性守门 (:291-319)    ← 正则：心理标签/方法钩子/星座锚
       ├─ :397-399 normalize 精确去重（相等才拒）             ← ⚠️ 相似度判重缺位
       └─ :414-415 prisma.angle.createMany 直接入库           ← ⚠️ 无候选态、无审核记录
```

**关键事实**：
- `services/dedup.ts` 里有实测校准过的三层判重 `judgeAngle()`（simAngle 0.45 / simHistory 0.35 / themeCap 8，含 Jaccard+包含率兜底），但**全库只有定义、没有调用**（`nextCode()` 同为死代码；`dupScore` 仅被 `cli/migrate.ts` 离线使用）。→ **线上扩库的去重 = 归一化字符串相等**，「一不如意就躺在地上」vs「一不如意就往地上一躺」这种实测过的同义改写会双双入库。
- 选题形态守门两套并存：通用「结尾方法钩子」（`charter` :215-223 + 硬性要求第 4 条）与 `ZODIAC_ANGLE_RULES` 的「禁止问题咨询式」**互相冲突**，靠 `angleMode` 查表切换（`track-rules.ts`），但两套文案都写死在 `angles.ts`。
- `config/topic_seeds.json`（6.8KB，场景×冲突×视角种子表）**无任何代码读取**（仅 `config.ts:38` 注释提及），属死文件；`Angle.source` 值域实际是 `llm-expand | manual | import2:*`。
- 无六维评分、无内容方向分布统计、无 TopicReview 记录。

---

## 5. 文章生成调用链（含代码证据）

```text
planner.buildPlan → reserveAnglesForAccount(CAS) → writer.generateDraft(angle, track, account)
  ├─ :527 assertRoleUsable('write')，失败回退 scaffoldHtml 骨架
  ├─ :539-540 loadStyleForTrack(track) + pickVariants(track)   ← 7 类配置在此读入
  ├─ :552 buildSystemPrompt({template: sys:{赛道}, target: 篇幅档})
  │        renderTemplate 注入 {{minSections..pMax}}（数字来自 constants+篇幅档）
  │        模板没写数字变量时 anchorLine(:127) 补硬锚
  ├─ :556 buildPrompt(angle, track, {style, variants, spec, system})
  │        拼装顺序（:240-338）：赛道名 → 【创作总纲】global → 【本赛道文风】{赛道}
  │        → 【写作规范·段落形态/强调标注/句式补充】s:{赛道}（预算 7600，整块丢弃 <60%）
  │        → 本次选题 → 【本次变体】v:{赛道}:*（title/structure/length）
  │        → sys tail（永不截断）
  │        ⚠️ :282 骨架卡带「与上文结构规范冲突时以本条为准」——变体优先级最高
  ├─ :558 dumpPrompt 落盘 var/prompts/（KEEP=30，排障旁路）
  ├─ :559 chatComplete(4096 tokens)
  ├─ :569 postProcess：sanitize → emphasis 补加粗(8-12) → reflow 段落重排(LADDER 切段)
  ├─ :593 lintArticle(html, …, style.rule.checks, style.rule.relax)
  │        error（拦）：sections 3-4 / chars 1300-2300 / dash / negation
  │        warn（提示）：para_shape/short/overlong / ending_hook / emphasis / citation /
  │                      fear_selling / summary_openers / zodiac_* 专项
  │        relax 豁免只作用 warn（:530-531）
  ├─ :608-646 定向修补 ≤2 轮：repairInstructionList(只列 error) → repairOnce(复述整篇)
  │        distance = errors×10000 + 字数偏离（:427-431）；无进步即停
  └─ 落库 Article(draft) → render/index.ts 产 contentWechat
推送前：publisher 再跑 lint，error → PushResult.reason='lint_failed'（publisher.ts:32,128）
```

**门禁数字真源**（`constants.ts:35-67`，页面改不到）：
`MIN/MAX_SECTIONS=3/4`、`MIN/MAX_CHARS=1300/2300`、`TARGET_CHARS=1800-2200`、`PARA_TARGET=17-19`、强调 8-12/红字 2-3、`MAX_PARA_CHARS=150`。

---

## 6. Prompt 分布情况（方案 §3.1「规则散落」的完整清单）

| # | 位置 | 内容 | 可配置？ |
|---|---|---|---|
| 1 | DB `StylePrompt`（41 行） | `global` 总纲 / `{赛道}` 文风 / `s:{赛道}` 写作规范 / `sys:{赛道}` 系统提示词+tail / `v:{赛道}:{title,structure,length}` 变体 / `r:{赛道}` 机器规则(JSON) / `sys:default` / `v:global:*` | 是（配置页，**无 schema 校验**） |
| 2 | `style-prompts.ts` 种子区（约 560 行） | DEFAULT_GLOBAL_PROMPT / DEFAULT_TRACK_PROMPTS(6) / DEFAULT_TRACK_SPECS(6) / SYS_TEMPLATE_×7 / DEFAULT_VARIANT_LINES | 否（出厂种子） |
| 3 | `style-prompts.ts` 迁移区（**约 900 行，v2→v15**） | 哨兵文本匹配 + Setting 标志位，一天 14 次迁移 | 否 |
| 4 | `writer.ts` | `REPAIR_SYSTEM`、`repairInstruction` 每类 error 的改法、`anchorLine`、`scaffoldHtml` 骨架 | 否 |
| 5 | `revise.ts` | 改写 SYSTEM_PROMPT + 3 种 MODE_INSTRUCTION | 否 |
| 6 | `angles.ts` | buildMessages 全文（system+user 模板）、`ZODIAC_ANGLE_RULES`、`charter`、`scopeBrief`、6 条硬性要求 | 否（仅 seed 是入参） |
| 7 | `comic/*`、`cover.ts` | 漫画脚本/格 prompt、封面 prompt | 否（本次范围外） |
| 8 | `lint.ts` | 各 warn/error 的 message 文案（会流入修补 prompt） | 否 |

**结论**：7 类配置已经收敛到 DB，但**只有 `sys:`/`s:`/`v:`/`{赛道}` 四类真正页面可改**；选题 prompt（第 6 项）与修补 prompt（第 4 项）仍是代码内硬编码。方案 §3.4「Prompt 由配置动态生成」只完成了一半。

**7 类 key 的职责重叠**（SECOND-OPINION 问题 4 的实证）：
- 段落形态同时出现在 `s:{赛道}·段落形态`、`sys:` 的结构条款、`v:structure` 骨架卡、`s:` 句式补充——四处各写各的；
- 数字出现在 `constants`（门禁）、`v:length` 篇幅档（目标）、`v:structure`/`s:` 自由文本（如"9~12 个小节"还散在 `angles.ts:138` 的 scopeBrief）——**只有 sys: 模板的数字走 `{{变量}}` 同源，其余三处不受校验**。

---

## 7. 当前问题清单（与代码证据）

> 编号规则：P=问题，后接来源（PLAN=RESTRUCTURE-PLAN §1.1，SO=SECOND-OPINION §4/5）。

| # | 问题 | 代码证据 |
|---|---|---|
| P1（PLAN1,SO5.1） | **形态契约无单一真源**，骨架卡优先级最高可覆盖其它 | 四处规则见 §6；`writer.ts:282`「与上文结构规范冲突时以本条为准」 |
| P2（SO5.2） | **分工错误**：模型兼管内容+结构归属；局部计数（写几个星座）服从、全局归属（每座只一段）失控 | 写稿 prompt 让模型自己分段；`zodiac_dup` 只是 warn（`lint.ts:272-288`），且不在修补范围（修补只修 error，`writer.ts:611`） |
| P3（SO5.3） | 约束靠"遵守"不靠"设计"：提示词软约束 + lint 事后抓 + 修补事后改，全是补丁 | `writer.ts` repair 循环 ≤2 轮；实测 20 篇唯一性仅 2 篇干净（SO §4 表格） |
| P4（SO5.4） | **改配置要配迁移**：种子在代码、库是旧的，靠哨兵文本+标志位迁移，一天 14 迁且出过"改了不生效" | `style-prompts.ts:922-1820`（style_seed_v2…v15）；dev.db Setting 表 14 个迁移标志 |
| P5（SO5.5） | **形态与门禁算术不匹配**：12 座×74 字+5 场景×74=1258 < 1300 门禁，模型被逼加段→重复 | `constants.ts:41` MIN_CHARS=1300 全局唯一；星座稿段均 74 字实测恒定（SO §4.2） |
| P6（PLAN4） | 选题去重只有字面精确匹配，语义/同义改写防不住 | `angles.ts:397-399`；`dedup.ts:92 judgeAngle` 死代码 |
| P7（PLAN4） | 生成与审核不分离：模型输出直接入正式题库，无候选态/审核记录/评分 | `angles.ts:414-415 createMany`；schema 无 TopicCandidate/TopicReview |
| P8（PLAN1.1-2,SO4.6） | 选题与形态打架：选题层产单星座角度，写稿要群像；选题 prompt 通用"方法钩子"与星座规则互斥 | `angles.ts:215-250` vs `:176-193`；Angle 无形态字段（只有 theme/content/scope） |
| P9（PLAN7） | 无事实核验：无 ArticleEvidence、无来源适配器；citation 仅 warn | `lint.ts:127-128` UNSOURCED_CITATION_RE（warn）；schema 无证据表；Agnes 不支持联网（SO 附注） |
| P10（PLAN8） | 无独立文章审核：lint 是确定性合规检查，不覆盖"符合选题/读者价值/标题党/版权/逻辑"等 12 维 | `lint.ts` 只有合规轴；`Article.qualityJson` 死字段 |
| P11（PLAN9） | 无 AI 运行记录/版本管理：prompt 无版本、生成无快照关联 | `prompt-dump.ts` 只留 30 份文件；TaskRun 无 promptVersion/inputSnapshot |
| P12（SO4.3） | **否定框架 error 三道全失灵**：提示词禁→模型稳定产出→lint 拦→修补 2 轮修不动→带 error 落库→推送卡死 | `lint.ts:109-110` NEGATION_RE（error）；`writer.ts:371-377` 修补指令；实测 11 篇拦 4 篇修不动 |
| P13（PLAN6/1.1-4） | 内容方向分布无统计（单一套路集中度、话题簇、负面/方法型占比） | 全库无相关查询/接口 |
| P14 | **死资产**：topic_seeds.json 无引用、judgeAngle/nextCode 无调用、qualityJson 无读写 | 见 §4/§3 |

---

## 8. 可保留模块（不动或小改）

| 模块 | 理由 |
|---|---|
| `api/auth-guard.ts` + `services/auth.ts` + User/UserSession | 鉴权收口已完成（/api/* 全拦），多用户骨架齐 |
| `services/wechat.ts` + `publisher.ts` | 草稿箱推送 + 群发红线（AUTO_PUBLISH=false 常量）+ 重试语义（40164/40001/退避） |
| `services/llm.ts` + `model-registry.ts` + LlmModel/ModelBinding | 模型域四维（vendor/protocol/capability/role）设计良好，chatComplete 只需扩展（tools/JSON mode/embedding 接口） |
| `services/pipeline.ts` + `planner.ts` 的 CAS 抢占 | 双产线 + 角度池占用语义正确（含 usedById 归属） |
| `services/parse/index.ts` + `render/index.ts` | 「预览=推送」不变量的单一渲染入口 |
| `services/emphasis.ts` | 确定性补加粗（标注密度），实测必要 |
| `api/bulk-delete.ts` + `useBatchDelete` + smoke:bulk/verify:bulk | 批量删除语义单源 + 隔离库验证样板 |
| `services/comic/*` | 独立产线，本次重构不触碰 |
| 冒烟体系（smoke:lint 71 项 / smoke:style 27 项 / smoke:angles / verify:zodiac / verify:length / measure:form） | 是重构的回归安全网，先扩再改 |
| `TaskRun`/`RunLog` | 可扩展为 GenerationRun 的任务级容器 |

---

## 9. 需要重构的模块

| 模块 | 改什么 |
|---|---|
| `services/style-prompts.ts`（2236 行） | ①迁移区（v2-v15）剥离为独立 migration 模块并封版；②7 类 key 收敛为 4 层（见 §12 裁决）；③增加保存时 schema 校验（`r:`/form JSON、变体行格式、`{{变量}}` 白名单） |
| `services/writer.ts` | ①Prompt 统一 Renderer（复用 `renderTemplate`，但装配走契约）；②骨架卡"最高优先级"条款取消；③修补协议从"复述整篇"改为段级最小编辑（P12 的根治点之一）；④按 ArticlePlan 的结构计划写作（阶段 5） |
| `services/angles.ts`（815 行） | 拆三块：候选生成 / 守门审核 / CRUD。生成-审核-入库分离（TopicCandidate→TopicReview→Angle）；prompt 移出代码 |
| `services/dedup.ts` | `judgeAngle` 复活并接入扩库链路；补语义层（Embedding 接口，可降级）；删除或标记 `nextCode` |
| `services/lint.ts` | ①阈值改从形态档案注入（gate 可按 rhythm 参数化）；②`zodiac_dup` 类"形态唯一性"升为可配置 error；③negation 检测与修补指令协同重做 |
| `services/track-rules.ts` | 并入形态档案（`rhythm`/`subjects`/`checks`/`relax`），`relax` 降级为例外逃生门 |
| `constants.ts` | 收缩为"宪法边界"（字数 1000-4000、节数 2-6 等硬边界），赛道级数字迁入档案（§12 裁决 B） |
| `api/routes/style-prompts.ts` | 保存校验 + 配置版本号 + 校验失败即拒（硬约束"配置非空"） |
| `web/src/views/StylePromptsView.vue` | 形态档案结构化编辑（数字输入框+校验），替代纯文本 |
| `web/src/views/TrackAnglesView.vue` | 候选审核中心（评分/重复明细/通过-改后通过-拒绝） |

## 10. 需要新增的模块

| 新模块 | 对应方案 | 职责 |
|---|---|---|
| `services/form/`（schema + render + arithmetic-check） | §3/FORM-ARCHITECTURE | 形态档案单一真源；保存时算术校验（座数×段均+场景段 vs 字数门禁）；Prompt 渲染同源注入 |
| `services/topic/`（candidate / review / distribution） | §4 | 候选生成、六维评分、硬性风险、三层去重接线、内容方向分布 |
| `services/article-plan/` | §5 | 选题→策划（读者问题/核心观点/结构计划/事实需求） |
| `services/factcheck/`（needs / sources / verify / evidence） | §6 | 事实需求分类、RSS/官方页/URL 免费来源适配器（可替换接口）、ArticleEvidence 状态机 |
| `services/article-review/` | §8 | 12 维审核、评分+问题定位+修改建议、状态机 pending→approved/needs_revision/rejected |
| `services/generation-run/` | §9 | 模型调用快照（input/output/promptVersion/contractVersion） |
| `services/prompt-version/` | §9 | Prompt 正式版本留档 |
| web：选题审核中心 / 策划与证据中心 / 文章审核中心 / 质量分析 / AI 运行记录 | §11 | 管理后台五块 |
| `scripts/fixtures/`（选题测试集 10 类 + 文章测试集） | §14 | 固定样本回归，替代"凭感觉" |

## 11. 需要删除或废弃的旧逻辑

| 对象 | 处置 | 理由 |
|---|---|---|
| `config/topic_seeds.json` | 移入 `var/_archive/`（不删） | 死文件；方案 §4.1 的"取消种子驱动"事实上已完成，留档即可 |
| `dedup.nextCode()` | 删除或标注 @deprecated | 死代码 |
| `Article.qualityJson` | 标注 @deprecated，schema 暂留字段 | 死字段；审核结果将来走 ArticleReview |
| `style-prompts.ts` 迁移区 v2-v15 | 封版归档（一次性跑完后不再增长），新变更走版本化配置 | P4 根治 |
| 骨架卡"与上文冲突以本条为准"条款 | 删除 | P1 根治点 |
| `ZODIAC_ANGLE_RULES` 等代码内赛道文案 | 迁入配置（`r:{赛道}.anglePrompt` 或赛道档案） | 方案 §3.4 |
| `var/probe_*.py` 旧阈值脚本 | 保持在链路外（记忆已注明会带偏 agent），归档 | 防误用 |
| **不可删**：任何现有数据、`smoke-utils.ts` 清理白名单语义、群发红线常量 | — | 硬约束 |

---

## 12. 数据库调整方案

### 12.1 目标实体映射

| 方案实体 | 处置 | 落点 |
|---|---|---|
| `Track` | 保留 | 加 `contractVersion`（可空） |
| `TrackContract` | **新增**（或扩展 StylePrompt） | 建议新表 `TrackContract(trackId, version, formJson, reviewPolicyJson, status)`；自由文本仍留 StylePrompt。理由：形态是结构化对象需要 schema 校验与算术校验，塞进 Text 列会重蹈"自由文本数字"覆辙 |
| `TopicCandidate` | **新增** | 候选态独立于 Angle（Angle=正式题库）。字段对齐方案 §4.3 + `reviewStatus` 五态 |
| `TopicAngle` | = `Angle` 保留 | 补 `contractVersion`（选题生成时的契约版本） |
| `TopicReview` | **新增** | 六维评分 JSON + 风险项 + 重复命中 + 理由 + 模型/prompt 版本 |
| `TopicCluster` | **后置**（方案标"建议"） | 先用文本聚类离线脚本产出，不进第一轮 schema |
| `ArticlePlan` | **新增** | 方案 §5.2 字段可用；`factRequirements` JSON |
| `Article` | 保留 | 加 `planId`、`reviewStatus`；`qualityJson` 废弃 |
| `ArticleEvidence` | **新增** | 方案 §6.4 字段照搬 |
| `ArticleReview` | **新增** | 12 维结果 + 问题位置 + 建议 + 状态机 |
| `GenerationRun` | **新增轻量表**（TaskRun 并存） | TaskRun 管"任务"，GenerationRun 管"每次模型调用快照"；RunLog 已有可挂 |
| `PromptVersion` | **新增** | version / taskType / prompt / note |
| `TopicHistory` | **视图替代** | 已用 Angle + Article.title 即历史，先做查询视图/接口，不建表（方案允许"不要重复建职责相同的表"） |

### 12.2 迁移原则（执行时强制）

1. 全部增量迁移，**不删列不删表不清库**；`qualityJson` 只停用不删。
2. SQLite/MySQL 双兼容：改 `schema.prisma` 后必跑 `npm run schema:sqlite` + `prisma generate`（项目铁律）。
3. 迁移脚本可回滚（down 语句或反向脚本）；**会写库的验证一律跑隔离库**（复制 dev.db 后再跑，2026-11-11 两次数据事故的教训）。
4. 存量 12 篇 Article / 33 条 Angle 全部保留原语义：Angle 不带 reviewStatus 的旧数据视为 `approved`（正式题库），不回溯成候选。
5. 项目未上线（PLAN §16.7），允许适度简化兼容，但生产 MySQL 上线前要出 baseline migration（deploy/README 已有此约定）。

---

## 13. 与既有文档的冲突裁决（动工前必须拍板）

| 冲突 | 甲方口径 | 乙方现状 | **审计建议** |
|---|---|---|---|
| ① 默认兜底 | SO 硬约束 2：配置非空、**不做默认兜底**，缺项不能写稿 | writer/style-prompts/track-rules 全链路兜底（"写稿不能被配置拖死"） | **分两步**：先把"出厂种子=合法配置"显式化（新建赛道即播种成完整配置，读取不再静默回落）；再上严格模式（缺项 400 拒写）。一步到位会让新赛道断流 |
| ② 事后修补 | SO 硬约束 3/4：前置驱动、不做事后合并/切分段落 | `reflowParagraphs` 确定性切段（LADDER）+ `emphasis` 补加粗都在事后 | **reflow 保留但降级为排版级**（只切 >150 字超长段，不做归属重组；或挂 `form.postprocess` 开关，FORM-ARCHITECTURE 已设计）；emphasis 是标注密度不是结构，保留。**归属类修补（合并/拆分主体段）禁止**——那是 P2 的病灶 |
| ③ 数字放哪 | SO 硬约束 5：数字可校验；constants 注释：数字不进可编辑文本；FORM-ARCHITECTURE：form 配置 + 三道闸 | constants 单源（页面改不到，但每赛道同门禁=算术矛盾 P5） | **采纳 FORM-ARCHITECTURE 三道闸**：schema 校验 + 宪法硬边界（constants 收缩为边界）+ 渲染同源（`{{变量}}` 只能来自档案）。门禁必须能按形态参数化，否则 P5 无解 |
| ④ TrackContract 范围 | PLAN §3.2 全字段（audience/topicPolicy/articleShape/writingStyle/reviewPolicy） | — | **砍半落第一轮**：form（形态）+ reviewPolicy 先落；audience/topicPolicy 并入现有 `{赛道}` 文风文本，不急结构化 |

### 对 SECOND-OPINION 5 问的审计意见（供拍板）

**Q1（B+D 是否过度设计）**：B 不过度——P4（14 次迁移）与 P5（算术矛盾）都是"数字无真源"的直接后果，必须结构化；但 B 的第一轮只做**形态档案**（FORM-ARCHITECTURE 的 `form` 对象），不要照搬完整 TrackContract。D（计划先行）必要且轻量：只需要"结构计划"一步（主体清单+分组+切片方向，程序校验个数/不重复），不需要完整 ArticlePlan 才开始。**根本问题确实还有一半在别处**：门禁算术（Q2）不解决，B+D 做完也还是会挤出重复段。

**Q2（算术矛盾怎么解）**：换形态不可取（十二座群像是星座赛道的卖点）；单纯放宽场景段数是补丁。正解是**门禁按形态参数化 + 保存时算术校验**：群像形态 `chars=[1100,1800]`、`段数 = 主体数×每座段数 + 场景段数`，保存档案时校验 `主体数×段均下限 + 场景段 ≤ chars 上限`，并在篇幅档里给群像专用档（如"12 座×1 段×80-110 字 + 开场 1 段 + 收尾 1 段 ≈ 1250-1500"）。段均 74 字是模型恒定输出，**当它给定值用**，别再当变量去抗。

**Q3（全局约束）**：主推计划先行（D）——清单阶段"12 个座名、每座恰好一次"是程序可验的；写正文前先过"计划校验器"（个数、重复、锚点缺失即打回重出计划，成本只有正文的 1/10）。补充一道**底线**：`subjectDup`（同座多段）升为 error 拦推送（不是事后合并——拦截不违反"不打补丁"）。F（标记切分）可作为 D 的轻量替代，但对"每个主体只写一段"的保障弱于 D。**提示词已实证无效，不再往提示词堆唯一性条款**。

**Q4（7 类是否太多）**：收敛为 4 层：①`global` 总纲（底线）②赛道文风（怎么说话：语气/语汇/禁忌，现 `{赛道}`）③**形态契约**（长什么样：`sys:` 的结构条款 + `r:.form` + `v:structure` 骨架卡三合一，结构化 JSON + 少量写法指导）④`r:` 机器规则（体检项/守门模式）。`s:` 拆解：段落形态→③（rhythm）、强调密度→③（数字）、句式禁忌→②。`v:` 三维变体保留（反模板化有效，星座 cursor 已到 36），但**取消骨架卡最高优先级**——冲突时以形态契约为准。职责一句话：②管嘴、③管骨架、④管机器怎么查。

**Q5（否定框架）**：三道失灵各有原因——禁令式提示词对句式约束服从率低（模型要表达对比时必然绕）；修补"复述整篇"改坏别处+2 轮上限；正则有漏（换皮变体只 warn）。可靠执行=**三件套**：①前置替代表达（system 给"对比写成两个具体画面"的范式，而不是只给禁令——现在改法藏在 repair 指令里，首次生成根本看不到）；②修补协议改段级最小编辑（只回传命中段让模型重写该段，降低改坏面）；③error 保留 + 把"命中句替换成安全句式"做成确定性兜底**仅当**用户接受轻量文本替换（与"不打补丁"的边界：句子级替换 ≠ 段落级重组，可谈）。若三条都不做，就应把 negation 降 warn 人工终审——不能既当 error 又修不动，产出卡死在草稿箱是系统性故障（P12）。

---

## 14. 风险与红线（实施时全程有效）

1. **群发红线**：`AUTO_PUBLISH=false` 常量不动，publisher 不得出现 masssend；重构后"审核通过→待发布→人工确认"链路里"人工确认"不可自动化。
2. **会写库的验证一律隔离库**（复制 dev.db 到临时库；`verify:bulk` 是样板）。
3. **Express 路由顺序坑**：`/meta`、`/defaults`、`/:id(\\d+)` 等约定照旧（记忆已存）。
4. Node strip-types 不支持参数属性、import 必须带 `.ts`；typecheck/build 串行。
5. 密钥不入日志/运行记录（PLAN §9.3）；GenerationRun 的 inputSnapshot 要脱敏（AppSecret、apiKey）。
6. 破坏性修改（删表/删列/语义变更）先报影响再动手（PLAN §16.7）。

---

## 15. 遗留待确认（留给用户拍板）

1. §13 的四个裁决点（尤其 ②reflow 去留、③门禁参数化的深度）。
2. Embedding 去重的实现路径：Agnes 无 embedding 时，是接第三方 embedding API（免费额度）还是先用 LLM 判重（成本高）/ 词向量兜底（PLAN §4.5 允许"先可用文本相似度，不阻断"）。
3. 事实核验的来源清单初版（RSS/政府/教育/科研/产品公告各列哪几个白名单域名）。
4. 六维评分用哪个模型角色（新增 `review` 角色还是复用 `revise`）。
