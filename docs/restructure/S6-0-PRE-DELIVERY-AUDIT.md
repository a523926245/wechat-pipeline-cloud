# S6-0 · 交付前整体只读审计

- **审计日期**：2026-11-18 15:25
- **审计性质**：**只读**。未修改任何业务代码 / Schema / Migration / 配置 / 环境变量；未连接任何数据库；未启动前后端服务；未调用真实 LLM 或微信公众号接口；未执行任何写库脚本；无任何 Git 写操作。本轮**只新增本报告**（不改 DEVLOG、不改 CHANGELOG、不改其它文档）。
- **Git 基线**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`（`b2fbad3 S4-5: per-track angle forms and review rule alignment`）｜分支 `feature/open-source-readiness`
- **工作区**：80 项未提交（37 项 `M` + 43 项 `??`），**本轮未做任何改动**
- **权威依据**：`docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md`（唯一实施依据）→ `docs/restructure/00-FINAL-EXECUTION-CHARTER.md`（最高约束）→ `docs/restructure/README.md`（决策登记）→ `docs/DEVLOG.md`（进度台账）→ 各阶段验收报告 → 实际代码
- **证据分级口径**（全文统一）：
  - **[代码确认]** 本轮读到源码，可直接指出文件与行号
  - **[静态验证]** 本轮执行了无副作用的静态检查（grep / `git grep` / 文件时间戳比对 / 结构枚举）
  - **[已有证据]** 引用此前阶段的真实执行输出（报告或 DEVLOG，含时间与断言数）
  - **[未验证]** 只读条件下无法确认，不外推
  - **[推断]** 基于已有事实的合理推断，已标注

---

## 0. 审计结论

### 0.1 总体判断

| 判断 | 结论 |
|---|---|
| **S1–S5 是否完成** | **是**（S1/S2/S3/S4 有完整验收；S5 各子系列含 6 个 UI 阶段与 4 个后端子任务均验收关闭） |
| **第一期开箱核心链路是否完整** | **是，代码层完整、前后端接通、DB 结构齐备**；但**业务数据为空 + 多项配置需人工补**，属「可用的系统」而非「已配置好的内容库」 |
| **是否具备进入 S6 的条件** | **是**，但**必须先处理 2 个 P1**（见 §6），且 S6 第一步应是「把工作区入库」 |
| **是否发现 P0** | **未发现**（无活跃的错误发布路径；`AUTO_PUBLISH=false` 与「无 masssend」均经代码确认） |
| **是否发现 P1** | **2 项**：① 本地 `server/.env` 的 `DATABASE_URL` 指向 `wechat_pipeline_smoke`；② 全部 S3–S5 成果（37 M + 43 ??）未入库 |
| **是否发现 P2** | **5 项**：部署文档迁移基线错误、Docker 一键起不完整、CTO 五项指标未落地、6-2 后端改动后未重跑全量冒烟、CI 无库校验 |

### 0.2 一句话结论

> **代码与结构够交付，文档与配置不够交付。** 系统本身（选题→写作→体检→改稿→草稿箱→人工发布）已具备完整实现与真实验证；真正挡住「开箱可用」的不是功能缺失，而是**当前 `.env` 连的是冒烟库**、**S3–S5 全部成果还躺在工作区没进版本库**、**部署手册里还写着一条会把库建坏的迁移基线步骤**。

---

## 1. S1–S5 阶段完成度表

> 依据 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` §七/§八 定义的阶段范围逐条对照实际实施与证据。

### S1 · MySQL 空库初始化与统一数据库 —— **完成**

| 项 | 事实 | 证据级别 |
|---|---|---|
| 原定目标 | 建 3 库 + `wpc_app`、`.env` 切 MySQL、`migrate init`、T0 最小适配、业务冒烟回归 | — |
| 实际实施 | S1-1 建库建号（三库 utf8mb4/utf8mb4_unicode_ci + `wpc_app@127.0.0.1` + 三库 GRANT ALL、零全局权限）；S1-2 切库（`Commit B 80a6e1a`，含 MySQL 1101「TEXT 不能有字面默认值」故障修复 → `@default(dbgenerated("('')"))`）；S1-3 T0 冒烟适配 MySQL + R1/R2 类型与 enum 收敛 | [已有证据] `docs/DEVLOG.md:1479-1512`、`docs/restructure/T0-MYSQL-ADAPT-REPORT.md` |
| 验收证据 | `verify:smoke-iso` **10/10**（含指业务库/shadow/file: 三类反例全拒）；三冒烟 116/33/30 不降；`typecheck` 0；`SELECT CURRENT_USER()=wpc_app@127.0.0.1`；`SHOW GRANTS` 仅三库 | [已有证据] 同上 |
| 未完成必要事项 | 无 | [代码确认] |
| 是否可认定完成 | **是**。唯一注意：S1-2 报告里的 typecheck✓ 曾是旧 SQLite 产物，已由 S1-3-R2 以真实 0 错误覆盖 | [已有证据] |

### S2 · SQLite 遗留清理与文档收口 —— **完成（有残留文档瑕疵）**

| 项 | 事实 | 证据级别 |
|---|---|---|
| 原定目标 | 退役 SQLite 运行链、文档收口 | — |
| 实际实施 | 删 `prisma/schema.sqlite.prisma`、`scripts/gen-sqlite-schema.mjs`、7 个 npm 脚本；`config.ts` 改 `DATABASE_URL` 必填 fail-fast；`db.ts` 锁恒走 `GET_LOCK`；CI 裁剪为 generate+typecheck+build | [代码确认] `server/src/config.ts:31-36`、`.github/workflows/ci.yml` |
| 验收证据 | 10/10（含 dev.db 9 文件 SHA256 全 MATCH、废弃 SQLite 配置零残留） | [已有证据] `docs/DEVLOG.md:1514-1523` |
| 未完成必要事项 | **文档残留**：`deploy/README.md` §四 仍称「仓库里没有 `prisma/migrations`」并给出 `0_init` 基线步骤；§六#10 仍称「`DATABASE_URL` 不设就静默连 SQLite」（实际已 fail-fast）；`deploy/install.sh:156` 注释同。见 P2-1/P4-1 | [代码确认] `deploy/README.md:114-140,168`；`deploy/install.sh:156` |
| 是否可认定完成 | **是**（清理目标达成）；文档瑕疵另计 | |

### S3 · 架构/抽象精简裁剪 —— **完成（裁决冻结）**

| 项 | 事实 | 证据级别 |
|---|---|---|
| 原定目标 | 五对象逐项裁决，只实施「当前必须」最小集 | — |
| 裁决结论 | TrackContract / PromptVersion / GenerationRun / Prompt Renderer（`form/render.ts`）**不实施**；微信草稿 Renderer（`services/render/`）与门禁参数化**保留**；无需新表 | [已有证据] `docs/DEVLOG.md:1525-1550` |
| 实际实施 | Commit `ee17c18`：3 处死代码清理（`hasCheck` / style-prompts 再导出 / `renderInline` 去 export）+ relax 4 调用点统一（改稿页/lint 端点/推送门禁与写稿同源）+ `smoke:style` 33→41（8 条新断言） | [代码确认] `server/src/api/routes/articles.ts` relax 传参 |
| 未完成必要事项 | 文档侧：CHANGELOG 的 S3 条目与 T1-B~E 设计文档的取代标注归 S6（DEVLOG 自述） | [已有证据] `docs/DEVLOG.md:1546` |
| 是否可认定完成 | **是** | |

### S4 · 业务流程与内容质量优化 —— **完成（含真实库 + 真实 LLM 样本）**

| 子任务 | 内容 | 验收证据 |
|---|---|---|
| S4-1 | 六维评分 + `Angle.status` 四态 + `TopicReview` + 消费链 approved 过滤 + 审核界面；三轮硬化（HF1 / R1 重评硬门禁与并发 / R2 重评生命周期） | 迁移 `20261114093000` 已部署；`smoke:angles` 多次全绿 [已有证据] |
| S4-2 | 统一选题去重（L0 归一化 / L1 LLM 判重 / L2 历史相似提示） | `dedup.ts`；`smoke:angles` [代码确认+已有证据] |
| S4-3 | 成稿体检结果闭环（`ArticleLintRun` 一次检查一行，trigger=check/save/push/revise） | 迁移 `20261116120000`（S5-3B-2 部署）；`verify:s5-4` 19 项 [已有证据] |
| S4-4-1 | 状态与回收（`hasPushTrace` 推送事实、`claimAngleInTx` 手动建稿即占题、`releaseReservedAngles` 三重闸门） | `smoke:bulk` 73；S5-4 真实库 [已有证据] |
| S4-5 A 档 | 星座/育儿 `ending_hook` 豁免，V16 已写真实库（`style_seed_v16=16`） | 基线指纹 `5d449bb7…` [已有证据] |
| S4-5 B 档 | 激励 `moment` / 科技 `scene` 分形态提示词与守门；`angleMode` 白名单 | `smoke:angles` 205→226 [已有证据] |
| S4-5 S3 | 真实 LLM 样本验证：激励/科技各 10 条，形态硬线 **20/20**，六项评估全过线，实调 4 次 | `docs/restructure/S4-5-S3-REAL-SAMPLE-VALIDATION-REPORT.md` [已有证据] |

| 遗留（已登记，非本阶段缺陷） | 影响 |
|---|---|
| C 档「配置页可编辑 `r:` 规则」暂缓归 S5 | `r:` 行**可以**在配置页按 JSON 文本编辑（`track-rules.ts:10`），但 `angleMode` 字段**改了不生效**（只读代码种子，`track-rules.ts:23-26`、`angles.ts:443` 明确注释）。见 P3-1 |
| 六维 `conflict` 计入 `total` 与「不强制冲突」的形态规则冲突 | `total` 不可跨赛道比较、不能判形态达标；口径未决。见 P3-2 |
| 科技句式模板化「像 X…不再 Y」8/10 | 已追加 4 条反模板要求 + 21 条断言，未重跑真实样本。见 P3-3 |

**是否可认定完成：是**（含真实库与真实 LLM 两条硬证据，超出纯 Mock 层级）。

### S5 · UI/UX + 推送安全 + 集成验证 —— **完成（6 个子系列全部关闭）**

| 子任务 | 内容 | 关闭依据 |
|---|---|---|
| S5-1 | 推送安全（`hasPushTrace` 前置拒重、失败不覆盖推送事实、改写后自动体检） | `smoke:push` 33 项 [已有证据] |
| S5-2 | 体检存档读路径缺表降级（`latestLintRun→null`、`listLintRuns→[]`，写路径保持透出） | `test:lint-store` 41 项 [已有证据] |
| S5-3A/3B | 部署前只读核查 → mysqldump 备份（SHA-256 `0ddfe00f…`）→ `migrate deploy` 成功（17→18 表，逐表行数一致） | `S5-3B-1-BACKUP-REPORT.md`、`S5-3B-2-MIGRATION-DEPLOY-REPORT.md` [已有证据] |
| S5-4 | **真实业务库**应用层集成验证 152 项断言全过（体检/门禁/CRUD/排产/漫画/清理） | `S5-4-INTEGRATION-VALIDATION-REPORT.md` [已有证据] |
| S5-UI-1…6 | 12 个页面系统性改造 + 工作台待办 + 窄屏/深色 + 6 轮修复 | `S5-UI-5-FINAL-CLOSURE-AUDIT.md`（建议关闭）、`S5-UI-6-FINAL-CLOSURE-AUDIT.md`（**可关闭 S5-UI-6**，范围内 P0/P1/P2 = 0） [已有证据] |

**缺口（不影响 S5 功能成立，影响 S6 回归可信度）**：

- **没有一份「S5 总验收」文档**，只有子系列各自的 FINAL。S5 的完成是「全部子项关闭」的合成结论，未单独立卷。
- **S5-UI-6-2 改动了后端真源（`services/scheduler.ts` + `routes/scheduler.ts`）后，只跑了 typecheck / build / 静态契约 / 纯函数单测，未重跑 `verify:smoke-iso` 与 `smoke:*`**。这是本轮唯一「代码改过但无隔离库回归」的位置。见 P2-4。

### S6 · 回归与收尾 —— **未开始**

本轮 S6-0 是 S6 的前置审计，S6 本体（测试固化、五项指标口径、CHANGELOG/文档/记忆回写、遗留清单）**尚未实施**。

---

## 2. 第一期开箱可用核心链路审计表

> 判定口径：**代码存在**＝读到真实实现；**前后端接通**＝前端 API 封装 → 路由 → 服务三层都有；**DB 结构**＝schema + 迁移都有；**已有验证**＝引用真实执行记录（Mock 与真实库分开标注）；**未验证边界**＝本轮只读无法确认，如实标注；**影响交付**＝是否挡住「开箱能用」。

| # | 链路 | 代码存在 | 前后端接通 | DB 结构 | 已有验证 | 未验证边界 | 影响交付 |
|---|---|---|---|---|---|---|---|
| 1 | **模型配置 / 接入 / 测试 / 角色绑定** | ✅ `routes/models.ts` 12 个端点（含 `/models/:id/test` 真实发一次请求、`/models/bindings/:role`、`/models/resolve/:role`）、`services/llm.ts`、`model-registry.ts` 四维真源 | ✅ `ModelsView.vue` + `api/index.ts` | ✅ `LlmModel` / `ModelBinding`（`schema.prisma:505,535`） | [已有证据] S5-UI-4-1-C 修正「就绪」状态准确性 + 浏览器走查；S4-5-S3 用页面手工配 1 模型绑 3 角色后成功扩库 | **真实 API Key 调用未验证**（本轮禁止外呼）。业务库当前 `ModelBinding = 0 行` → 开箱即用必须先绑定 | **是（配置项）**：不配 = 出稿/扩库 400 |
| 2 | **公众号账号与凭据状态** | ✅ `routes/credentials.ts` 7 端点（`/:id/test` 真调微信、`decideCredStatus`、AES-256-GCM 加密入库、掩码返回） | ✅ `AccountsView.vue` | ✅ `OAAccount`（含 `credStatus`/`ownerUserId`）/ `WechatToken` | [已有证据] S5-UI-5-P2-2 措辞修正（`ok`→「格式合规」）；S5-4 真实库账号夹具；`smoke:auth`/`smoke:ownership` | **真实微信连通未验证**（本轮禁止外呼）；业务库 `OAAccount = 0 行` | **是（配置项）**：AppID/Secret + 公众号后台 IP 白名单 |
| 3 | **选题生成 / 六维评分 / 去重 / 人工审核** | ✅ `POST /tracks/:id/expand` → `expandAnglesForTrack`（LLM 生成 + 硬门禁 + L0/L1 去重 + 六维评分）；`POST /angles/:id/rescore`、`/review`、`GET /:id/reviews`；`dedup.ts` | ✅ `TrackAnglesView.vue` | ✅ `Angle`（status/used/scope/六维字段）/ `TopicReview` | [已有证据] **真实 LLM** 20 条样本（`S4-5-S3`）；`smoke:angles` 226 项（Mock） | 本轮不外呼；真实扩库质量只验证过 2 个赛道 | 否（可用） |
| 4 | **选题进入创作与排产** | ✅ `GET /plan`、`POST /plan/trigger`；`planner.ts`：**只消费 `status='approved'`**（`:284`）、`claimAngleInTx` 占题、`releaseReservedAngles` 补偿、产线开关 + 当日配额 | ✅ `PlanView.vue`（四态 trigger 反馈 + warnings + backlog） | ✅ `Track` / `TrackPipeline` / `TaskRun` | [已有证据] S5-4 真实库 `/plan/trigger count=2` + 空池 `created=0` + 零 used 泄漏；S5-UI-5-P1 四态 | 真实定时到点触发未验证（需 scheduler 常驻 + 到点） | 否（可用） |
| 5 | **AI 文章生成 / 分赛道策略 / 文章编辑** | ✅ `writer.ts`（StylePrompt 运行时读取 + 三段保命 + repairOnce）/ `services/render` 唯一渲染 / `PUT /articles/:id/content` | ✅ `ArticleEditView.vue` | ✅ `Article`（contentHtml/contentWechat/status/mediaId/pushDate） | [已有证据] S5-4 真实库保存/改写/渲染；`smoke:lint` 152；S4-5 分赛道形态真实样本 | 真实长文质量未做批量评估（仅 20 条选题样本 + 12 篇历史归档） | 否（可用） |
| 6 | **Lint 体检 / 历史 / 过期判断 / 改后自动体检** | ✅ `lint.ts`（error 拦推送 / warn 提示）；`lint-store.ts`（存档 + 读降级）；`GET /:id/lint`、`GET /:id/lint-runs`、`PUT /:id/content` 内部体检、`revise` 后体检 | ✅ `ArticleEditView.vue`（`lintHits` 展开、八场景安全展示） | ✅ `ArticleLintRun`（**已在真实库**，S5-3B-2） | [已有证据] S5-4 19+23+24 项断言（真实库写入/CASCADE/降级）；`test:lint-store` 41 项（零数据库） | 无 | 否（可用） |
| 7 | **保存 / 草稿推送 / 防重复推送** | ✅ `publisher.ts`：`hasPushTrace` 最前置拒重（不看 status）、进程内 in-flight 串行、体检门禁、`addDraft` 唯一出口 | ✅ `ArticleEditView` / `ArticlesView`（`pushFailView` 六类 reason + `noAccountGuide`） | ✅ `Article.mediaId/pushDate`、`TaskRun` | [已有证据] `smoke:push` 33 项（Mock 微信 + Mock LLM）；S5-4 真实库推送门禁 39 项 | **真实微信推送未执行**（本轮明令禁止，历史各轮亦未做过真实推送） | 否（可用）；首次真实推送需人工在验收环境做一次 |
| 8 | **自动化模式 / 定时任务 / 状态反馈** | ✅ `scheduler.ts`：`tick()` 按账号 owner `User.automationMode` 分流（`:329 push = mode==='auto_draft_push'`）、`resolveAutomationForAccounts`、`classifyPushIntent`；`cli/scheduler.ts` 常驻或 `--once`；`GET/PUT /scheduler`、`/tick`、`/start`、`/stop` | ✅ `SchedulerView.vue`（四态推送意图横幅 + 角色化 payload + 非 admin 开关禁用） | ✅ `User.automationMode/writeTime`、`Setting`（scheduler_enabled/write_time/push_enabled） | [已有证据] S5-UI-6-1（payload 角色分支）+ S5-UI-6-2（11 场景浏览器 + 纯函数单测 8/8） | **真实库 `GET /scheduler` E2E 未执行**（6-2 明确保留）；**真实到点触发未验证** | **部分**：功能可用，但「是否会自动推」只能靠配置意图判断，不含到点/配额（设计如此） |
| 9 | **Dashboard 待办 → 具体业务页跳转** | ✅ `GET /api/dashboard` 的 `todos`（四类，`number\|null`，`degraded`）；`/status` | ✅ `DashboardView.vue` + `utils/todo-nav.ts`（`parseArticleNeeds`） | ✅ 由既有表聚合，无新表 | [已有证据] `smoke:dashboard` **51** 项 + `test:todo-nav` **41** 项；S5-UI-2-D-4 关闭审计 | 未在真实数据量下验证（业务库 0 篇文章） | 否（可用） |
| 10 | **人工控制发布边界** | ✅ `constants.ts:8 AUTO_PUBLISH = false as const`；`publisher.ts` 只调 `/draft/add`；全仓 `masssend` 仅 4 处禁止性注释；`/api/health` 暴露 `autoPublish:false` | ✅ 前端文案明示「只进草稿箱，不群发」 | ✅ 无群发字段 | [代码确认] `git grep masssend` → 4 处全为注释；[已有证据] 各轮静态契约断言 | 无 | 否（这是交付前提，已成立） |

### 2.1 核心链路小结

- **10 条链路全部「代码存在 + 前后端接通 + DB 结构齐备」**，无一条是「只有页面没有后端」或「只有后端没有入口」。
- **验证层级不均**：链路 3/4/6/7 有**真实业务库**证据（S5-4 152 项）；链路 1/2/8 只到「Mock + 浏览器」；链路 7/8 的**真实外呼（微信推送 / 到点触发）从未做过**——这是设计使然（安全红线 + 本轮禁止），不是缺陷，但**首次上线必须人工做一次**。
- **业务库是空壳**：据 `S5-3B-2` 报告的逐表行数（2026-11-17 09:58），17 张业务表里只有 `llmmodel 4 / setting 16 / styleprompt 44 / user 1 / usersession 1` 有数据，**`track / trackpipeline / account / angle / article / modelbinding / taskrun` 全部为 0 行**。→ **交付物是「能跑的系统」，不是「能马上发文的库」**。

---

## 3. 当前运行与部署条件

### 3.1 运行时要求

| 项 | 实际 | 风险 |
|---|---|---|
| Node | 本机 `v22.22.2`；`server/package.json engines: ">=20"` | ⚠️ **engines 写错**：`--experimental-strip-types` 需 **Node ≥ 22.6**。Node 20 用户按 engines 通过安装、启动即 `bad option`。[代码确认] `server/package.json` |
| npm | 本机可用 | — |
| MySQL | 8.0.30，`127.0.0.1:3306`，`wpc_app@127.0.0.1`，三库 `wechat_pipeline` / `_shadow` / `_smoke` | — |
| 前端构建 | `web/build` = `vue-tsc --noEmit && vite build`（需 `--max-old-space-size=8192`，已内置） | — |

### 3.2 启动方式（实际脚本）

```
后端开发：cd server && npm run dev        → node --experimental-strip-types --watch src/index.ts  (PORT 8787)
后端生产：cd server && npm start
调度常驻：cd server && npm run scheduler  （独立进程，60s 心跳；--once 供 systemd Timer）
前端开发：cd web    && npm run dev        → vite :5173，代理 /api → 127.0.0.1:8787
```

**关键事实**：调度器**不在 API 进程里自动启动**（`app.ts` 无 `startScheduler` 调用），由 `cli/scheduler.ts` 单独运行，或由管理员在前端点 `/scheduler/start`（进程内启动）。→ **交付时必须说清「不跑 scheduler 进程，自动化模式完全不生效」**。[代码确认] `server/src/app.ts`、`server/src/cli/scheduler.ts:50`

### 3.3 环境变量清单（`server/.env` 实际键，值已脱敏）

| 键 | 当前值形态 | 是否必填 | 备注 |
|---|---|---|---|
| `DATABASE_URL` | `mysql://wpc_app:***@127.0.0.1:3306/**wechat_pipeline_smoke**` | **必填**（缺则 fail-fast） | 🔴 **指向冒烟库**，见 P1-1 |
| `SHADOW_DATABASE_URL` | `.../wechat_pipeline_shadow` | `migrate dev` 需要 | 正确 |
| `PORT` | `8787` | 可选（默认 8787） | — |
| `LOG_LEVEL` | `debug` | 可选 | 生产建议 `info` |
| `ADMIN_PASSWORD` | 5 字符 | 可选（默认 `admin`） | ⚠️ 仅本地弱口令，且**实际登录走 `User` 表会话**，此键只影响 `seed:admin` 语义外的历史兼容 |
| `NODE_ENV` | `development` | 可选 | 生产必须 `production`（决定 `SMOKE_NO_AUTH` 旁路是否可用） |
| `APP_SECRET_KEY` | 44 字符 base64（=32 字节） | **必填且不可换** | ✅ 格式合规；`config.ts:105-113` fail-fast 校验 |
| `JWT_SECRET` | **未设置** | 声明但**无实际消费点** | `config.ts:46` 导出后全仓无引用（会话走 DB `UserSession`）→ 死配置，见 P4-2 |
| `CONTENT_DIR` / `CONFIG_DIR` | 未设（走默认 `var/content`、`config`） | 可选 | — |
| `HTTP_TIMEOUT_MS` / `LLM_TIMEOUT_MS` | 未设（30s / 300s） | 可选 | — |

### 3.4 Prisma 与数据库结构

| 项 | 事实 | 证据级别 |
|---|---|---|
| schema 数据源 | `provider = "mysql"`，`url = env("DATABASE_URL")`，`shadowDatabaseUrl = env("SHADOW_DATABASE_URL")` | [代码确认] `schema.prisma:12-17` |
| 迁移链 | **存在 4 个**：`20261113145706_init`（15 表）、`20261114035440_add_missing_enum_values`（2 条 MODIFY）、`20261114093000_add_angle_status_topic_review`（1 表）、`20261116120000_add_article_lint_run`（1 表） | [静态验证] 目录枚举 + `grep -c "CREATE TABLE"` |
| 模型数 | 17 个 `model` + 13 个 `enum` | [静态验证] |
| 业务库表数 | **18 = 17 业务表 + `_prisma_migrations`**（S5-3B-2 实测 17→18） | [已有证据] |
| 迁移状态 | `Database schema is up to date!`（S5-3B-2，2026-11-17 09:58） | [已有证据] |
| 本轮是否连库 | **否**（明令禁止） | — |

### 3.5 部署路径三条，只有一条完整

| 路径 | 完整性 | 问题 |
|---|---|---|
| **systemd + Nginx**（`deploy/`） | ✅ 结构完整（`install.sh` / systemd unit + timer / nginx conf / logrotate） | ⚠️ `deploy/README.md` §四 迁移基线说明**已过期且有破坏性**，见 P2-1 |
| **Docker Compose**（`docker-compose.yml`） | ❌ 不完整 | ① `CMD` 直接 `src/index.ts`，**不执行 `prisma migrate deploy`** → 起来但没表；② 容器内**不托管 `web/dist`**（`app.ts` 只 static `/api/content`），compose 里也没有 Nginx → 起来只有 API、没有界面。见 P2-2 |
| **本机开发**（README 快速开始） | ✅ 可用 | 但 `npm run prisma:deploy` 会按当前 `.env` **打到 smoke 库** |

### 3.6 启动前必须执行的初始化步骤（按依赖顺序）

1. `npx prisma migrate deploy`（对**正确库**）→ 建 17 表
2. `npm run seed:admin` → 建管理员（口令随机打印一次；`-- --pass` 指定）
3. 配模型：新建 `LlmModel`（供应商/协议/能力/Key，Key 加密入库）→ `POST /models/bindings/:role` 绑 `write`（写作必需）、`revise`、`expand_angles`、`cover`（封面）、`comic_script`/`comic_panel`（漫画）
4. 建赛道 `Track` + 产线 `TrackPipeline`（配额 + 启用）——**空库没有任何赛道，不能出稿**
5. 建公众号账号 `OAAccount`（挂赛道）→ 填 AppID/Secret → `POST /credentials/:id/test` 验证 → `credStatus=ok`
6. 公众号后台把服务器出口 IP 加入白名单（否则全接口 40164）
7. 需要自动化才启动 `npm run scheduler`（或前端 `/scheduler/start`）

---

## 4. 测试与验证证据矩阵

> **不重复运行任何已有测试**（本轮禁令）。下表全部来自既有报告/DEVLOG 的**真实输出**，并按「验证层级」分类。

| 验证手段 | 规模 | 最近一次真实结果 | 层级 | 是否覆盖全部链路 |
|---|---|---|---|---|
| `server typecheck`（`tsc --noEmit`） | 全量 | **0 错误**（S5-UI-6-2，11-18 14:2x） | 静态 | 覆盖编译面，不覆盖行为 |
| `web typecheck`（`vue-tsc --noEmit`） | 全量 | **0 错误**（同上） | 静态 | 同上 |
| `web build`（含 vue-tsc + vite） | 全量 | **✓ 14.00s**（12:4x）/ ✓ 28.20s（S5-4） | 静态+构建 | 覆盖可构建性 |
| `verify:smoke-iso`（十项验收台） | 10 项 | **10/10**（最近一次 11-16，S4-5 B 档收尾） | **隔离库真实 MySQL** | 覆盖隔离机制本身，非业务 |
| `smoke:lint` | **152** | 全过（11-16） | 隔离库 | 体检规则 |
| `smoke:style` | **46** | 全过（11-16） | 隔离库 | 文风/变体/relax |
| `smoke:angles` | **226** | 全过（11-16） | 隔离库（Mock LLM） | 选题形态/守门/提示词拼装 |
| `smoke:bulk` | **73** | 全过（11-16） | 隔离库 | 批量删除语义 |
| `smoke:push` | **33** | 全过（11-16） | 隔离库 + **Mock 微信/LLM** | 防重推/失败保事实/改写体检 |
| `smoke:dashboard` | **51** | 全过（11-17） | 隔离库 | 待办口径 |
| `verify:s5-4` | **152** | **152/152**（11-17 10:20） | 🟢 **真实业务库 + Mock 外呼** | 体检/门禁/CRUD/排产/漫画/清理 |
| `test:lint-store` | **41** | `ALL PASS`（11-17 09:30） | **零数据库**（Mock 委托） | 读降级 |
| `test:todo-nav` | **41** | 通过（S5-UI-2） | 纯函数 | 待办跳转参数 |
| `test:article-push` | **26** | **26/26**（11-18 14:2x） | 纯函数 | 推送失败分诊 |
| 静态契约（6-2 自建） | **26** | 26/26（11-18 14:2x） | 静态断言 + 构建产物 grep | 6-2 改动边界 |
| 浏览器走查（headless Chrome CDP） | S5-UI 各轮 | 6-2：**11 场景 + 13 图**，Console 0 error | Mock 后端 + 真实前端 | UI 行为与响应式 |
| Migration 部署验证 | 3 次（init/angle/lint） | 成功 + `migrate status` up to date | **真实业务库** | 结构 |

### 4.1 按层级汇总

| 层级 | 覆盖内容 | 备注 |
|---|---|---|
| **已真实验证（真实业务库）** | 迁移部署（3 次）、表结构、级联删除、体检存档读写、推送门禁、文章 CRUD、排产建稿、选题占题/归还、漫画跳过体检 | `verify:s5-4` 152 项 + `S5-3B-2` |
| **已真实验证（真实 LLM）** | 选题扩库形态（激励 moment / 科技 scene 各 10 条） | `S4-5-S3`，实调 4 次 |
| **仅 Mock 验证** | 微信草稿推送全流程（`smoke:push` 33）、LLM 写作/改写/评分（`smoke:lint/angles`）、调度 tick 分流 | Mock 用的是真实客户端代码 + 假上游 |
| **仅静态检查** | typecheck、build、静态契约 26、`test:todo-nav` 41、`test:article-push` 26 | 无运行时 |
| **零数据库单测** | `test:lint-store` 41 | 故意断连证明无 SQL |
| **浏览器验证** | 12 个页面的布局/四态/窄屏/深色/Console | 后端为 Mock（这是刻意的，避免污染库） |
| **明确不验证（安全边界）** | 真实群发（永不做）、真实推送（本轮禁止）、真实微信账号连通（本轮禁止）、写业务库 smoke（本轮禁止） | — |
| **尚未验证** | ① 真实库 `GET /scheduler` 的 `pushIntent` E2E；② 真实到点自动出稿/自动推送；③ 首次真实推送（`addDraft` 打到真微信）；④ 空库→配置→出稿的**完整首次开箱流程**；⑤ 五项核心指标；⑥ Node 20/22.6 边界；⑦ Docker 路径 | 见 §9 |

---

## 5. Git 工作区与未提交改动风险

### 5.1 基线

```
branch : feature/open-source-readiness
HEAD   : b2fbad3f53c5b8dd28f22bccd1b51a62756122cf  (b2fbad3 S4-5: per-track angle forms and review rule alignment)
工作区 : 80 项未提交 = 37 M + 43 ??
删除   : 0
```

### 5.2 分布

| 类别 | 数量 | 明细要点 |
|---|---|---|
| **代码 M（后端）** | 12 | `api/routes/{articles,plans,revise,scheduler}.ts`、`services/{angles,dashboard,lint-store,planner,publisher,scheduler}.ts`、`server/package.json`、`server/scripts/{smoke-angles,smoke-isolated,smoke-run}.ts` |
| **代码 M（前端）** | 19 | `web/src/views/` **10 个页面**、`App.vue`、`styles.css`、`types.ts`、`api/index.ts`、`utils/format.ts`、`components/VariantLinesEditor.vue`、`web/package.json`、`web/UI-GUIDE.md` |
| **代码 ??（后端脚本）** | 4 | `s5-4-integration.ts`、`smoke-dashboard.ts`、`smoke-push.ts`、`test-lint-store-degrade.ts` |
| **代码 ??（前端）** | 8 | `web/scripts/`、`components/{EmptyState,PageHead,SaveBar,StatusTag,TaskProgress}.vue`、`utils/{article-push,todo-nav}.ts` |
| **文档 ??** | 31 | `docs/restructure/S5-*` 全系列 + `S4-5-S3` + `S5-3B-*` + `S5-4`（均为验收报告） |
| **文档 M** | 3 | `CHANGELOG.md`、`docs/DEVLOG.md`、`docs/restructure/README.md`、`docs/restructure/S4-3-IMPLEMENTATION-REPORT.md` |

### 5.3 风险判定

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| R1 | **S3–S5 全部成果未入库** | 🔴 **P1** | HEAD 停在 S4-5。此后所有 UI 改造、推送安全、体检存档、待办队列**只存在于工作区**。一次误 `checkout` / 磁盘故障 = 全部归零。 |
| R2 | **部分提交会直接构建失败** | 🔴 **P1 同源** | `AccountsView` / `ArticleEditView` / `ArticlesView` / `DashboardView` 等 10 个页面 `import` 了 **未跟踪** 的 `components/PageHead.vue`、`SaveBar.vue`、`utils/article-push.ts`。若只 `git add -u`（只提交已跟踪文件），clone 后 `vue-tsc`/`vite build` **必挂**。→ **必须 `git add -A` 或按目录整体提交**。 |
| R3 | **无敏感文件混入** | ✅ 安全 | `git grep` 无真实凭据（`wpc_app:<密码>` 只是文档占位；`sk-SMOKE-PLAINTEXT-KEY-DO-NOT-LEAK` 是刻意的假 Key）；`.env`、`server/var/`、`var/`、`dev.db*`、`web/dist` 全部被 `.gitignore` 覆盖。 |
| R4 | **无临时文件混入跟踪区** | ✅ 安全 | 验证产物在 `var/tmp/`（被忽略）；`config/*.bak*.json` 被忽略。 |
| R5 | **改动与已验收功能的对应关系** | ✅ 清晰 | 每个 `M` 文件都能对上 DEVLOG 的某一轮（S5-1 的 publisher/revise、S5-2 的 lint-store、S5-UI-6-1/6-2 的 SchedulerView 等）。**无孤立改动、无"顺手改"迹象**（S5-UI-6-FINAL 已用 mtime 窗口法核实）。 |

### 5.4 结论

**工作区不是垃圾，是未入库的交付物本体。** 处理方式只有一种：**整体提交**（分几个语义 commit 亦可，但 `web/src/components`、`web/src/utils`、`web/scripts` 必须与其消费方同批），**绝不能只提交已跟踪文件**。

---

## 6. 遗留问题清单（P0–P4）

> 分级标准按任务书：P0 数据安全/错误发布/核心数据丢失；P1 核心链路无法完成；P2 明显缺陷或较高风险；P3 体验/边界/低频；P4 文档注释。
> **不把历史 P3/P4 升级为交付阻塞项。**

### P0（0 项）

**未发现活跃的 P0。** 核对项：

- 错误发布路径：`AUTO_PUBLISH = false as const`（`constants.ts:8`）；`publisher.ts` 只调 `/draft/add`；全仓 `masssend` 命中 4 处**全为禁止性注释**；`/api/health` 暴露 `autoPublish:false`。→ **无群发代码路径**。
- 核心数据丢失路径：唯一候选是 P1-1（`.env` 指向 smoke 库 + 冒烟会 DROP 该库全部表）。因其**需要「先在该库录入内容」才成立**，且正确库存在、风险已在 3 份报告登记，故计 P1；**若忽略此提示直接录内容，此风险应升级为 P0**。

### P1（2 项）

| # | 问题 | 证据 | 实际影响 | 第一期是否必须修 | 建议阶段 |
|---|---|---|---|---|---|
| **P1-1** | `server/.env` 的 `DATABASE_URL` 指向 **`wechat_pipeline_smoke`**（不是 `wechat_pipeline`） | [代码确认] `server/.env`；`smoke-isolated.ts:252` 每次 run 前 `DROP TABLE IF EXISTS` 该库全部表、`smoke-db-guard.ts:18-19` 把 `wechat_pipeline_smoke` 定义为冒烟库、`wechat_pipeline` 为真实库；[已有证据] `S5-3A` 明确「`.env` 当前仍指 `_smoke`，直接 `migrate deploy` 会打错库」 | ① 按 README 跑 `npm run dev` → 连的是冒烟库；② 在里面录的任何内容，**下一次 `npm run smoke:*` 会被整库清空（不可逆）**；③ 所有 `prisma:*` 命令默认打错库 | **是** | **S6 第 1 步**（改 `.env` 指向 `wechat_pipeline`，并用 `/api/health` 的 `driver` + `SELECT DATABASE()` 验收） |
| **P1-2** | **S3–S5 全部成果未提交 Git**（37 M + 43 ??，含 10 个页面依赖的 5 个未跟踪组件） | [静态验证] `git status --porcelain`；[代码确认] `AccountsView.vue:19-20` 等 `import` 未跟踪文件 | 交付物即仓库状态；未入库 = 未交付；**部分提交会导致构建失败**（R2） | **是** | **S6 第 0 步**（先整体入库，再动任何代码） |

### P2（5 项）

| # | 问题 | 证据 | 实际影响 | 必须第一期修 | 建议阶段 |
|---|---|---|---|---|---|
| **P2-1** | `deploy/README.md` §四 称「仓库里**没有** `prisma/migrations`，`npm run prisma:deploy` 第一次必失败」，并给出 `mkdir 0_init` + `migrate diff --from-empty` + `migrate deploy` 的**手工建基线**步骤 | [代码确认] `deploy/README.md:114-140`（对比：`server/prisma/migrations/` 实际有 4 个迁移）；`deploy/install.sh:156` 同款过期注释（但 `:158-160` 的逻辑已正确检测迁移目录） | 操作者按文档手工建 `0_init` 并 deploy → `0_init` 先建全部表 → 真正的 `20261113145706_init` 再建同名表 → **迁移失败、`_prisma_migrations` 出现 failed 记录、需手工 resolve** | **是** | S6（文档修正，改 1 段 + 1 条注释） |
| **P2-2** | Docker Compose 路径不完整：容器 `CMD` 只起 API，**不跑 `migrate deploy`**；容器内**不托管 `web/dist`**，compose 也没有 Nginx | [代码确认] `Dockerfile:35` `CMD ["node", ..., "src/index.ts"]`；`app.ts` 仅 `express.static(CONTENT_DIR)` 挂 `/api/content`；`docker-compose.yml` 只有 db + app | `docker compose up -d` 后：API 起来了但**没有表**（需手工 `exec ... npx prisma migrate deploy`）、**没有界面**（只有 8787 的 JSON 接口） | 否（systemd 路径可用），但**宣称「一键」就要修** | S6（二选一：补 entrypoint 迁移 + 内置静态托管，或把 README 的 Docker 段落降级为「仅 API」） |
| **P2-3** | **五项核心验收指标未落地**（宪章 §七 与 2.0 计划 §八 S6 均要求） | [静态验证] 全仓 `grep "审核通过率\|重复率\|一次审核\|事实核验覆盖率\|人工修改工作量"` → 仅命中 `DashboardView` 的 CSS 类名 `hero-metrics`，**无任何指标计算代码** | 无法按宪章验收「内容生产体系」；样本不足/百分比口径纪律无从体现 | 否（不影响开箱使用），但**影响 S6 收口定义** | S6（按计划「S6 = 指标口径落地」，可先做只读统计，不建新表） |
| **P2-4** | **S5-UI-6-2 改了后端真源后未重跑隔离库冒烟** | [已有证据] `docs/DEVLOG.md` 14:25 条列出的验证只有 typecheck/build/契约 26/单测 8/article-push 26；无 `verify:smoke-iso`、无 `smoke:*` | `services/scheduler.ts`（新增 `listReadyAccountRefs` + 抽 `READY_ACCOUNT_WHERE`）与 `routes/scheduler.ts`（GET 增 `pushIntent`）**没有任何隔离库回归覆盖** | 否（改动为只读 + 纯函数），但**S6 回归必须包含它** | S6 第 3 步（全量冒烟一次） |
| **P2-5** | **CI 无数据库校验** | [代码确认] `.github/workflows/ci.yml` 自述「CI 恢复冒烟留 S6」；只有 generate + typecheck + build | 任何人 push 都不会跑冒烟/隔离验收 → 回归全靠人肉 | 否（自托管单机），但属 S6「测试固化」核心 | S6（可用 service container 起 MySQL 跑 `verify:smoke-iso`） |

### P3（7 项，不阻塞）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P3-1 | 配置页可编辑 `r:{赛道}` 的 `angleMode`，但**该字段改了不生效**（选题只读代码种子） | `track-rules.ts:23-26`、`angles.ts:443` 注释；配置页按 JSON 文本编辑 | 用户以为改库能改选题形态 → 无效且无界面提示。**接近 P2**，但 S4-5 已明示接受该代价 |
| P3-2 | 六维 `conflict` 计入 `total`，与「moment/scene 不强制冲突」的形态规则冲突 | `S4-5-S3` 报告；激励 conflict 均分 2.90 | `total` 不可跨赛道比较、不能判形态达标；排序口径未决 |
| P3-3 | 科技选题句式模板化「像 X…不再 Y」（8/10） | `S4-5-S3` + 11-16 已加 4 条反模板要求与 21 条断言，**未重跑真实样本** | 内容同质化风险，需真实样本复验 |
| P3-4 | `GET /api/articles/:id/lint` **有写副作用**（每次调用都 `recordLintRun`） | `articles.ts:565-597`；README 决策 T 已把「禁止调它算待办」写死 | REST 语义反直觉；误调用会污染体检历史 |
| P3-5 | 500px 窄屏下调度页 `.el-card__body` 横向溢出（424 > 410） | `S5-UI-6-2` 报告；横幅缺席时溢出量相同 → **既有问题** | 窄屏轻微横向滚动，不影响操作 |
| P3-6 | 四态横幅文案「**本次**」易被读成「立即发生」，实为**配置意图**（不含到点/配额） | `S5-UI-6-FINAL` 新增 P3 | 用户可能误判「现在就会推」 |
| P3-7 | 并发防重仅**进程内** `inFlightPushes` Map | `publisher.ts:74-104` | 多进程/多实例部署时并发重复点击可能建两份草稿；当前单进程部署不受影响 |
| P3-8 | 无自助改密界面，只能 `seed:admin -- --reset-pass` | `deploy/README.md:110-112`；`CHANGELOG` | 运维不便，非阻塞 |

### P4（6 项，文档/注释）

| # | 问题 | 证据 |
|---|---|---|
| P4-1 | `deploy/README.md:168` 称「`DATABASE_URL` 不设就静默连 SQLite」——实际已 fail-fast（S2 改） | `config.ts:31-36` |
| P4-2 | `JWT_SECRET` 在 `.env.example` 与 `config.ts:46` 存在，但**全仓无消费点**（会话走 DB `UserSession`），且 `.env` 未设 → 死配置 | `grep -rn JWT_SECRET server/src` → 仅 1 处导出 |
| P4-3 | `services/style-prompts.ts:1832` 注释称 V16「**尚未接入** `doEnsureStylePromptsSeeded` 的迁移链」——实际 `:1234` **已接入并在跑** | 同文件两处自相矛盾 |
| P4-4 | `services/scheduler.ts:16` 与 `cli/scheduler.ts` 头注释仍称「默认 `scheduler_push_enabled=0` 即 dry-run 不真推」——P4 之后该键已降级为「无主账号兜底」 | `scheduler.ts:35,66`；`S5-UI-6-FINAL` P3-2 已登记 |
| P4-5 | `docs/restructure/README.md:5` 状态仍写「**S5（UI/UX）进行中**」，而 UI-5/UI-6 均已 FINAL 关闭 | 文件首段 |
| P4-6 | `server/package.json engines.node = ">=20"` 与实际要求 `>=22.6` 不符（`deploy/README` §六#6 已自认） | `package.json`；`deploy/README.md:161` |

### 6.1 历史遗留（非 S6 范围，**本轮不动**）

| 编号 | 问题 | 登记出处 | 状态 |
|---|---|---|---|
| B-1 | 出稿前 impact / AI 披露确认 | `S5-UI-4-0-CORE-PAGES-AUDIT.md` | 未实施（P3，需单独授权） |
| T1 | 赛道修改后刷新拦截 | `S5-UI-4-0-CORE-PAGES-AUDIT.md` | 未实施（P3） |
| 500px 卡内溢出 | 见 P3-5 | `S5-UI-6-2` / `S5-UI-6-FINAL` | 已登记，未修 |
| S5-UI-5 的 B1 / D-1 / E-3 | 弹窗 markdown 星号 / 模型引导 / 已推送按钮无前置提示 | `S5-UI-5-CORE-FLOW-AUDIT.md` | P3 暂缓（FINAL 已明确不阻塞） |

---

## 7. 第一期开箱使用前必须人工补充的配置

> 业务库现状（`S5-3B-2`，2026-11-17 09:58 实测）：`llmmodel 4 / setting 16 / styleprompt 44 / user 1 / usersession 1`，**其余 11 表 0 行**。→ 下面 1–6 全部要人工做，系统不会自动造。

| # | 配置项 | 为什么必须 | 怎么配 | 验收方法 |
|---|---|---|---|---|
| 1 | **`DATABASE_URL` 指向 `wechat_pipeline`** | 当前指 `_smoke`，冒烟会清库 | 改 `server/.env` | `GET /api/health` → `driver:"mysql"`；`SELECT DATABASE()` = `wechat_pipeline` |
| 2 | **管理员账号** | 无账号无法登录 | `npm run seed:admin`（或 `-- --pass`） | `/login` 能进 |
| 3 | **文本模型 + `write` 角色绑定** | 无 `write` → 出稿 400 | 模型页新增 `LlmModel`（OpenAI 兼容，填 baseUrl/apiKey/模型名）→ 绑定 `write` | 模型页「测试」通过；`resolve:write` 返回可用 |
| 4 | **其余角色绑定**（按需） | `revise`（改写）/ `expand_angles`（扩库）/ `cover`（封面）/ `comic_script`+`comic_panel`（漫画） | 同上 | 各自「测试」通过 |
| 5 | **赛道 + 产线** | 空库无赛道 → 无法排产/出稿 | 赛道管理新增 `Track`，再配 `TrackPipeline`（文章/漫画各自配额 + 启用） | 创作计划页出现该赛道配额 |
| 6 | **公众号账号 + 凭据** | 无账号 → 不能推送 | 账号页新增（挂赛道）→ 填 AppID(18位 wx…)/AppSecret → 「测试连通」 | `credStatus` 显示「格式合规」且测试返回成功 |
| 7 | **公众号后台 IP 白名单** | 否则所有微信接口 40164 | 公众号后台 → 开发 → IP 白名单，加服务器出口 IP | 账号「测试连通」不再报 40164 |
| 8 | **`APP_SECRET_KEY` 正式值** | 加密所有 AppSecret；**写库后不可换** | `openssl rand -base64 32` → 写入 app.env（权限 600） | 起服务后 `/api/dashboard/status` 无「主密钥未就绪」告警 |
| 9 | **`NODE_ENV=production`** | 决定 `SMOKE_NO_AUTH` 旁路是否可用（仅非生产） | 生产 app.env 设置 | `GET /api/health` → `env:"production"` |
| 10 | **调度进程** | 不跑 → 自动化模式完全不生效 | `npm run scheduler`（常驻）或 systemd Timer `--once` | `systemctl list-timers` / 前端调度页 `running:true` |
| 11 | **数据库定时备份** | 无备份 = 一次误操作归零 | `mysqldump --single-transaction` 每日 cron（参考 `S5-3B-1` 参数） | 备份文件存在 + 可 `CREATE TABLE` 计数校验 |
| 12 | **首次真实推送验收** | 全流程从未打过真微信 | 配置好账号后，手动推 1 篇到草稿箱 | 公众号后台草稿箱出现该文；`mediaId` 落库 |

---

## 8. S6 建议实施顺序

> 原则：**先把交付物固定下来（入库），再修会把人带沟里的文档/配置，最后才跑回归与补指标。** 每步都应是可独立验收、可回滚的小批次。

| 步 | 内容 | 为什么放这个位置 | 验收 |
|---|---|---|---|
| **S6-1** | **整体入库**（分 2–3 个语义 commit：① 后端 S5-1/2 + 脚本；② 前端 S5-UI-1..6 + 组件；③ 文档 CHANGELOG/DEVLOG/报告）。**必须 `git add -A`**，确认 5 个未跟踪组件随消费方同批 | P1-2；不先做，后面每一步都可能丢失 | `git status` 干净；clone 到临时目录能 `typecheck` + `build` |
| **S6-2** | **修 `server/.env` → `wechat_pipeline`** + 用 `/api/health` 与 `SELECT DATABASE()` 验收；同批在 README/deploy 文档里写清「`.env` 必须指业务库」 | P1-1；这是唯一带不可逆后果的配置 | 两个断言都指向 `wechat_pipeline` |
| **S6-3** | **全量回归一次**（含 6-2 改动的 `scheduler.ts`）：`verify:smoke-iso` + `smoke:lint/style/angles/bulk/push/dashboard` + `test:lint-store` + `test:todo-nav` + `test:article-push` + web build | P2-4；6-2 后端改动至今无隔离库回归 | 计数不低于 lint 152 / style 46 / angles 226 / bulk 73 / push 33 / dashboard 51；verify 10/10 |
| **S6-4** | **文档纠偏**（4 处 P2-1/P4-1/P4-3/P4-5 + `deploy` 迁移基线段）：删掉「没有 migrations / 建 0_init」的错误指引，改为「仓库已有 4 个迁移，直接 `prisma migrate deploy`」；同步 `install.sh:156` 注释；`engines.node` 改 `>=22.6` | P2-1 会直接把生产库建坏 | 文档与 `install.sh` 逻辑一致；`grep 0_init` 只剩历史说明或零命中 |
| **S6-5** | **首次开箱演练**（在隔离/新库上）：空库 → `migrate deploy` → `seed:admin` → 配模型/绑定 → 建赛道/产线 → 建账号 → 生成 1 篇 → 体检 → 预览 → （可选）推草稿箱 | 这是「第一期开箱可用」的**唯一硬验收**，现有证据里没有完整走过一遍 | 全流程无人工改代码；每步失败信息可读 |
| **S6-6** | **五项指标口径落地**（P2-3）：先做只读统计（① 审核通过率 ② 重复率 ③ 一次通过率 ④ 事实核验覆盖率 ⑤ 人工工作量=「未接入」），严守「分母<10 不出百分比」 | 宪章 §七 要求；纯读不建新表风险低 | 指标页/接口能返回带分母与周期的数值或「样本不足」 |
| **S6-7** | **CI 恢复库校验**（P2-5）：service container 起 MySQL → `migrate deploy` → `verify:smoke-iso` | 防止以后回归靠人肉 | CI 绿且含隔离验收 |
| **S6-8** | **收尾**：CHANGELOG 补 S3/S4 条目、DEVLOG 收口、README/restructure 状态更新、记忆回写、遗留清单定稿 | 用户收尾规范（状态/进度/CHANGELOG/验收记录/文档/记忆六项） | 文档间无矛盾，进度台账为唯一真源 |

**不建议在 S6 做的**：P3 措辞调整（P3-6）、500px 溢出（P3-5）、`angleMode` 界面提示（P3-1）、配置页 C 档完整实现 —— 都需单独授权，且不阻塞第一期。

---

## 9. 本轮未执行的验证及原因

| # | 未执行 | 原因 |
|---|---|---|
| 1 | 连接 `wechat_pipeline` / `_smoke` 做任何查询 | 任务书 §四.2 明令「不连接任何数据库」 |
| 2 | `GET /api/scheduler` 真实库 E2E（`pushIntent` 真实取值） | 同上；且 6-2 已明确保留该未验证项 |
| 3 | 启动前后端服务 / 浏览器走查 | 任务书 §四.3 明令「不启动前后端服务」 |
| 4 | 重跑 typecheck / build / 冒烟 / 契约 | 任务书 §四「不重复运行已有测试」 |
| 5 | 真实 LLM 调用（出稿质量、扩库质量） | 任务书 §四.4 明令不外呼 |
| 6 | 真实微信公众号接口（连通测试、`addDraft`） | 同上 |
| 7 | 写库 smoke / `verify:s5-4` | 任务书 §四.5 明令不执行有 DB 副作用的脚本 |
| 8 | Node 20 启动失败复现 | 需安装第二套 Node，超出只读范围；结论来自 `--experimental-strip-types` 的版本要求（[推断]） |
| 9 | Docker 路径实跑 | 需构建镜像并起容器，属启动服务 |
| 10 | 业务库当前真实行数（是否仍为 11-17 的状态） | 不连库 → 只能引用 `S5-3B-2` 的 11-17 实测；**当前是否变化未知** |
| 11 | 未跟踪组件是否完备（能否 build） | 不构建 → 仅从 `import` 关系判定「部分提交会失败」（[代码确认] + [推断]） |
| 12 | 五项指标在真实数据下的表现 | 无数据（业务库 0 篇文章）+ 无实现 |

### 9.1 需特别保留的事实

> **S5-UI-6-2 未执行真实数据库 `GET /scheduler` E2E。** `pushIntent` 的计算只经过「纯函数单测 8/8 + 源码核对 + Mock 浏览器夹具」，member/admin 在真实多账号下的取值差异、真实会话权限链均未验证。
>
> 本轮同样**未**补充该验证（不连库）。因此「调度页横幅在真实库上是否正确」在整个 S5-S6 链条上仍是**未验证项**，建议并入 S6-5 首次开箱演练顺带验收。

---

## 10. 附：权威文档路径核对

| 任务书列出的路径 | 实际位置 | 状态 |
|---|---|---|
| `docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md` | 同 | ✅ 存在（312 行） |
| `docs/restructure/00-FINAL-EXECUTION-CHARTER.md` | 同 | ✅ 存在（144 行） |
| `docs/DEVLOG.md` | 同 | ✅ 存在（2105 行） |
| `docs/restructure/README.md` | 同 | ✅ 存在（59 行） |
| `docs/WRITING-PIPELINE.md` | 同 | ✅ 存在（402 行） |
| `TARGET-UI-ARCHITECTURE.md` | **`docs/restructure/TARGET-UI-ARCHITECTURE.md`** | ✅ 存在（根目录无此文件） |
| `UI-UX-AUDIT.md` | **`docs/restructure/UI-UX-AUDIT.md`** | ✅ 存在（根目录无此文件） |
| S1 验收报告 | `docs/restructure/T0-MYSQL-ADAPT-REPORT.md`（S1-3） | ✅ 存在 |
| S2 验收报告 | **无独立文件**，验收记录在 `docs/DEVLOG.md:1514-1523` | ⚠️ 仅台账记录 |
| S3 验收报告 | **无独立文件**，裁决与验收在 `docs/DEVLOG.md:1525-1550` | ⚠️ 仅台账记录 |
| S4 系列 | `S4-0-AUDIT-REPORT` / `S4-1-*`(6 份) / `S4-2-*`(2 份) / `S4-3` / `S4-4-0` / `S4-4-1` / `S4-5-A` / `S4-5-S2-MIGRATION-PLAN` / `S4-5-S3-REAL-SAMPLE-VALIDATION` | ✅ 存在 |
| S5 系列 | `S5-3B-1` / `S5-3B-2` / `S5-4-INTEGRATION-VALIDATION` / `S5-UI-2..6`（19 份） | ✅ 存在 |
| **S5 总验收 / 关闭报告** | **不存在** | ⚠️ 只有各子系列 FINAL，无 S5 立卷 |

> 结论：除「S2/S3 无独立验收文件」「S5 无总验收」外，任务书要求的资料全部在仓库内且可读。**本轮未创建任何替代文件。**

---

## 11. 本轮零变更声明

- 未修改任何业务代码、`prisma/schema.prisma`、`prisma/migrations/**`、`.env`、`.env.example`、`package.json`、`Dockerfile`、`docker-compose.yml`、`deploy/**`。
- 未执行 `git add/commit/push/reset/checkout/restore/clean/stash`；仅使用 `git log` / `git status` / `git rev-parse` / `git grep` / `git diff`（只读）。
- 未连接任何数据库、未执行任何 SQL / Prisma 命令、未运行任何 `npm run` 脚本、未启动服务、未开浏览器、未调用外部接口。
- 未删除、覆盖、移动或格式化任何既有文件。
- 唯一产出：**本文件** `docs/restructure/S6-0-PRE-DELIVERY-AUDIT.md`。
- HEAD 保持 `b2fbad3`，工作区未提交项由 80 项变为 **81 项**（仅多本报告），其它 80 项原样保留。
