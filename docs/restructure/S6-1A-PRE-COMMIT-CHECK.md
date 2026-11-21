# S6-1A · 交付物入库前最终核对

> **性质**：**只读核对**。本轮未执行 `git add/commit/push/checkout/reset/restore/clean/stash`，未修改、删除、移动、格式化任何既有文件，未运行构建 / 测试 / 数据库脚本，未连接数据库，未调用 LLM / 微信接口。**唯一新增文件即本报告**。
>
> **核对时间**：2026-11-18 15:37（GMT+8）
> **依据**：S6-0 审计结论（`docs/restructure/S6-0-PRE-DELIVERY-AUDIT.md`）+ 本轮对工作区 82 个待提交文件的全量清点。

---

## 1. 当前 Git 基线

| 项 | 值 |
|---|---|
| 分支 | `feature/open-source-readiness` |
| HEAD | `b2fbad3f53c5b8dd28f22bccd1b51a62756122cf` |
| HEAD 标题 | `S4-5: per-track angle forms and review rule alignment` |
| 最近 5 次提交 | `b2fbad3` S4-5 → `f214c57` S4-1-HF1/R1/R2+S4-2 → `c6d884d` S4-3+S4-4-1 → `0fb2ffd` S4-1 → `3365ca3` S4-1 |
| 暂存区 | **空**（无 `git add` 过的文件） |
| 未提交文件 | **82 个**（37 `M` + 45 `??`） |
| `git status --porcelain` 行数 | **81 行** |
| 本轮前工作区 | 81 行（S6-0 报告已在内） |

### ⚠️ 计数口径差异（必读，避免 `git add` 时误判）

两个数字都对，但含义不同，**不要混用**：

| 口径 | 值 | 说明 |
|---|---|---|
| `git status --porcelain \| wc -l` | **81 行** | Git 把 `web/scripts/` 整个未跟踪目录**折叠成 1 行** |
| 实际文件数 | **82 个** | 把 `web/scripts/` 展开为 `assert-article-push.mjs` + `assert-todo-nav.mjs` 2 个文件 |

即：**81 行 = 37 `M` 行 + 43 个 `??` 文件行 + 1 个目录折叠行**；`??` 真实文件数是 **45**（43 + 2）。

> S6-0 报告中"43 项 `??`"用的是"行数"口径，本轮"45 个 `??`"用的是"展开文件数"口径，**不是新增了文件，也不是 S6-0 数错**。

### 环境现状（与本轮无关，未干预）

| 端口 | PID | 进程 | 判断 |
|---|---|---|---|
| 8787 | 23300 | `node.exe` | 后端 dev 服务（用户自行启动），**本轮未停止** |
| 5173 | 24736 | `node.exe` | Vite dev server（用户自行启动），**本轮未停止** |

---

## 2. 完整文件清单及数量

### 2.1 总量

| 分类 | 数量 |
|---|---|
| 已修改（`M`） | 37 |
| 未跟踪（`??`） | 45 |
| **合计** | **82** |

### 2.2 按扩展名

| 扩展名 | 数量 | 说明 |
|---|---|---|
| `.md` | 37 | 文档与验收报告 |
| `.ts` | 22 | 后端源码/脚本 + 前端工具与类型 |
| `.vue` | 18 | 前端视图与组件 |
| `.mjs` | 2 | 前端断言脚本 |
| `.json` | 2 | 两端 `package.json` |
| `.css` | 1 | `web/src/styles.css` |

### 2.3 按目录

| 目录 | 数量 |
|---|---|
| `docs/restructure/` | 34 |
| `web/src/` | 24 |
| `server/src/` | 10 |
| `server/scripts/` | 7 |
| `web/scripts/` | 2 |
| `web/`（根文件：`UI-GUIDE.md`、`package.json`） | 2 |
| `docs/`（根文件：`DEVLOG.md`） | 1 |
| `server/`（根文件：`package.json`） | 1 |
| 仓库根（`CHANGELOG.md`） | 1 |

### 2.4 已修改文件全量（37）

**后端源码（10）**
```
server/src/api/routes/articles.ts          +41 -?   S5-UI-2-D-2 / S5-UI-3-3
server/src/api/routes/plans.ts             +24 -?   S5-UI-5-P1
server/src/api/routes/revise.ts            +44 -?   S5-1
server/src/api/routes/scheduler.ts         +21 -?   S5-UI-6-2
server/src/services/angles.ts              +15 -?   S3 收尾（科技 SCENE 反模板）
server/src/services/dashboard.ts          +510 -?   S5-UI-2-B
server/src/services/lint-store.ts          +75 -?   S5-2-HF1
server/src/services/planner.ts             +41 -?   S5-UI-5-P1
server/src/services/publisher.ts          +103 -?   S5-1
server/src/services/scheduler.ts           +42 -?   S5-UI-6-2
```

**后端脚本（3）**
```
server/scripts/smoke-angles.ts             +65 -?   S4-5 / S5-4
server/scripts/smoke-isolated.ts            +4 -?   S4-4-1（push/dashboard 登记）
server/scripts/smoke-run.ts                 +8 -?   S4-4-1 / S5-UI-2-B
```

**前端源码（17）**
```
web/src/App.vue                           +374 -?   S5-UI-1（壳层/面包屑）
web/src/api/index.ts                        +2 -?   S5-UI-2-B
web/src/components/VariantLinesEditor.vue    +3 -?   S5-UI-1（el-empty → EmptyState）
web/src/styles.css                         +92 -?   S5-UI-1（设计令牌）
web/src/types.ts                          +139 -?   S5-UI-5-P1/P2-3 / S5-UI-6-2
web/src/utils/format.ts                   +146 -?   S5-UI-1 / S5-UI-5-P2-2
web/src/views/AccountsView.vue             +34 -?   S5-UI-5-P2-2
web/src/views/ArticleEditView.vue         +280 -?   S5-UI-3-1 / P2-3 / P2-4
web/src/views/ArticlesView.vue            +298 -?   S5-UI-2-D-3 / S5-UI-3-1/3-3
web/src/views/DashboardView.vue           +811 -?   S5-UI-2-B/C/D
web/src/views/ModelsView.vue              +100 -?   S5-UI-4-1-C
web/src/views/PlanView.vue                +204 -?   S5-UI-5-P1/P2-1/P2-4
web/src/views/PrefixSettingsView.vue       +13 -?   S5-UI-1（PageHead）
web/src/views/SchedulerView.vue            +81 -?   S5-UI-6-1 / 6-2
web/src/views/StylePromptsView.vue        +169 -?   S5-UI-4-1-A
web/src/views/TrackAnglesView.vue         +105 -?   S5-UI-4-1-B
web/src/views/TracksView.vue              +154 -?   S5-UI-4-1-B / S5-UI-3-3
```

**配置（2）**
```
server/package.json                         +6 -?   S5-4 / S5-2-HF1（verify:s5-4、test:lint-store）
web/package.json                            +2 -?   test:todo-nav、test:article-push
```

**文档（5）**
```
CHANGELOG.md                               +82      4 条新条目
docs/DEVLOG.md                            +355      33 条新条目
docs/restructure/README.md                  +3 -1   决策表补 T 行 + 状态行
docs/restructure/S4-3-IMPLEMENTATION-REPORT.md +18  S5-2 勘误
web/UI-GUIDE.md                           +115 -?   S5-UI-1 组件规范
```

### 2.5 未跟踪文件全量（45）

**前端公共组件（5，均为 S5-UI-1）**
```
web/src/components/PageHead.vue             40 行
web/src/components/StatusTag.vue            32 行
web/src/components/EmptyState.vue           44 行
web/src/components/SaveBar.vue             140 行
web/src/components/TaskProgress.vue        144 行
```

**前端工具函数（2）**
```
web/src/utils/article-push.ts              188 行   S5-UI-5-P2-4 / S5-UI-3-1
web/src/utils/todo-nav.ts                  134 行   S5-UI-2-B / D-1
```

**前端断言脚本（2）**
```
web/scripts/assert-article-push.mjs        175 行   S5-UI-3-1 / P2-4
web/scripts/assert-todo-nav.mjs            196 行   S5-UI-2-B / D-1
```

**后端验证脚本（4）**
```
server/scripts/s5-4-integration.ts         921 行   S5-4
server/scripts/smoke-dashboard.ts          483 行   S5-UI-2-B
server/scripts/smoke-push.ts               376 行   S5-1
server/scripts/test-lint-store-degrade.ts  311 行   S5-2-HF1
```

**验收报告（32）**
```
S4-5-S3-REAL-SAMPLE-VALIDATION-REPORT.md
S5-3B-1-BACKUP-REPORT.md
S5-3B-2-MIGRATION-DEPLOY-REPORT.md
S5-4-INTEGRATION-VALIDATION-REPORT.md
S5-UI-2-B-IMPLEMENTATION-REPORT.md
S5-UI-2-C-P0-FIX-REPORT.md
S5-UI-2-C-WORKBENCH-FLOW-AUDIT.md
S5-UI-2-D-1-IMPLEMENTATION-REPORT.md
S5-UI-2-D-2-IMPLEMENTATION-REPORT.md
S5-UI-2-D-3-A-FAILURE-TRACE-AUDIT.md
S5-UI-2-D-3-B-IMPLEMENTATION-REPORT.md
S5-UI-2-D-4-DASHBOARD-TODO-CLOSURE-AUDIT.md
S5-UI-3-0-ARTICLE-WORKBENCH-AUDIT.md
S5-UI-3-1-IMPLEMENTATION-REPORT.md
S5-UI-3-2-REMAINING-UX-ASSESSMENT.md
S5-UI-3-3-IMPLEMENTATION-REPORT.md
S5-UI-4-0-CORE-PAGES-AUDIT.md
S5-UI-4-1-A-IMPLEMENTATION-REPORT.md
S5-UI-4-1-B-IMPLEMENTATION-REPORT.md
S5-UI-4-1-C-IMPLEMENTATION-REPORT.md
S5-UI-5-CORE-FLOW-AUDIT.md
S5-UI-5-FINAL-CLOSURE-AUDIT.md
S5-UI-5-P1-IMPLEMENTATION-REPORT.md
S5-UI-5-P2-1-IMPLEMENTATION-REPORT.md
S5-UI-5-P2-2-IMPLEMENTATION-REPORT.md
S5-UI-5-P2-3-IMPLEMENTATION-REPORT.md
S5-UI-5-P2-4-IMPLEMENTATION-REPORT.md
S5-UI-6-0-REMAINING-UI-AUDIT.md
S5-UI-6-1-IMPLEMENTATION-REPORT.md
S5-UI-6-2-IMPLEMENTATION-REPORT.md
S5-UI-6-FINAL-CLOSURE-AUDIT.md
S6-0-PRE-DELIVERY-AUDIT.md
```
> 均位于 `docs/restructure/`。

---

## 3. 按类别的变更摘要

### 3.1 后端（10 源码 + 7 脚本 + 1 配置）

| 阶段 | 文件 | 变更内容 |
|---|---|---|
| **S3 收尾** | `services/angles.ts` | 科技赛道 `SCENE_ANGLE_RULES` 补第 7–10 条反模板要求（源自 10 条真实样本实测：比喻结构 10/10、"像 X…不再 Y" 8/10） |
| **S5-1** | `services/publisher.ts`、`routes/revise.ts` | 推送事实不被失败覆盖、并发防重；AI 改写后自动复检 |
| **S5-2-HF1** | `services/lint-store.ts` | `latestLintRun()` 失败返 `null`、`listLintRuns()` 失败返 `[]`，降级不静默（P2021 表缺失） |
| **S5-3A/3B** | （无源码改动） | 仅新增备份与迁移部署报告 |
| **S5-4** | （无源码改动） | 新增 `verify:s5-4` 集成验证脚本 |
| **S5-UI-2-B** | `services/dashboard.ts` | 新增 `todos` 区块（选题/文章/体检/执行异常四类，计数 `number\|null`） |
| **S5-UI-2-D-2** | `routes/articles.ts` | `needs` 专项筛选（`draft_unpushed`/`repush`） |
| **S5-UI-3-3** | `routes/articles.ts` | 列表 select 补产线标识 |
| **S5-UI-5-P1** | `routes/plans.ts`、`services/planner.ts` | `created` 只含真实 id>0，新增 `failed`/`skipped`，`ok` 不再把失败算成功 |
| **S5-UI-6-2** | `routes/scheduler.ts`、`services/scheduler.ts` | `READY_ACCOUNT_WHERE` 口径唯一化 + `classifyPushIntent` + `GET /scheduler` 返回 `pushIntent` |

**无 Schema / Migration 改动**：`server/prisma/` 在工作区**零改动**（`git status` 无该路径）——已交叉确认。

### 3.2 前端（17 改动 + 7 新增）

| 阶段 | 文件 | 变更内容 |
|---|---|---|
| **S5-UI-1** | `App.vue`、`styles.css`、`utils/format.ts`、`UI-GUIDE.md`、5 个新组件、`PrefixSettingsView.vue`、`VariantLinesEditor.vue` | 设计令牌收口（字号五档/圆角两档/`--wb-success`）、顶栏改面包屑、五套状态文案收口、公共组件落地 |
| **S5-UI-2-B/C/D** | `DashboardView.vue`、`utils/todo-nav.ts`、`assert-todo-nav.mjs`、`api/index.ts` | 工作台待办卡 + 跳转承接（单赛道/多赛道/精确筛选/执行异常抽屉） |
| **S5-UI-3-1/3-3** | `ArticleEditView.vue`、`ArticlesView.vue`、`utils/article-push.ts`、`assert-article-push.mjs` | 文章工作台信息层、产线标识、窄屏推送事实 |
| **S5-UI-4-1-A/B/C** | `StylePromptsView.vue`、`TrackAnglesView.vue`、`ModelsView.vue` | 文风配置与写作规范修复、选题库窄屏、模型就绪状态准确性 |
| **S5-UI-5-P1/P2-1..4** | `PlanView.vue`、`ArticleEditView.vue`、`AccountsView.vue`、`types.ts`、`utils/format.ts` | 出稿四态反馈、warnings/backlog、凭据措辞、体检命中片段、无账号引导 |
| **S5-UI-6-1/6-2** | `SchedulerView.vue`、`types.ts` | 按角色构造 payload、全局开关禁用；四态推送意图横幅 |

### 3.3 测试（7 后端脚本 + 2 前端脚本）

| 脚本 | 归属 | 规模 | 是否被 `package.json` 引用 |
|---|---|---|---|
| `server/scripts/s5-4-integration.ts` | S5-4 | 921 行 / 152 断言 | ✅ `verify:s5-4` |
| `server/scripts/smoke-dashboard.ts` | S5-UI-2-B | 483 行 / 51 断言 | ✅ `smoke:dashboard` |
| `server/scripts/smoke-push.ts` | S5-1 | 376 行 | ✅ `smoke:push` |
| `server/scripts/test-lint-store-degrade.ts` | S5-2-HF1 | 311 行 / 41 项 | ✅ `test:lint-store` |
| `server/scripts/smoke-angles.ts`（M） | S4-5/S5-4 | +65 | ✅ `smoke:angles` |
| `server/scripts/smoke-isolated.ts`（M） | S4-4-1 | +4 | ✅ 多个 `smoke:*` |
| `server/scripts/smoke-run.ts`（M） | S4-4-1/S5-UI-2-B | +8 | ✅（冒烟运行器内部） |
| `web/scripts/assert-article-push.mjs` | S5-UI-3-1 | 175 行 / 26 断言 | ✅ `test:article-push` |
| `web/scripts/assert-todo-nav.mjs` | S5-UI-2-B | 196 行 | ✅ `test:todo-nav` |

### 3.4 文档（37 `.md`）

| 类型 | 数量 | 内容 |
|---|---|---|
| 验收/审计报告 | 32 新增 + 2 修改 | S4-5-S3、S5-3B-1/2、S5-4、S5-UI-2~6 全系列、S6-0、S4-3 勘误 |
| 变更日志 | 1 | `CHANGELOG.md` +82 行（4 条） |
| 开发日志 | 1 | `docs/DEVLOG.md` +355 行（33 条） |
| 文档索引 | 1 | `docs/restructure/README.md` +3 −1 |
| 工程规范 | 1 | `web/UI-GUIDE.md` +115 |

---

## 4. 新增文件与引用关系核对

### 4.1 需求点名的 8 个前端文件 — 全部在位

| 文件 | 存在 | 被引用处 |
|---|---|---|
| `PageHead.vue` | ✅ 40 行 | **11 个视图**：Accounts / ArticleEdit / Articles / Dashboard / Models / Plan / PrefixSettings / Scheduler / StylePrompts / TrackAngles / Tracks |
| `StatusTag.vue` | ✅ 32 行 | **5 个视图**：Articles / Dashboard / Plan / TrackAngles / Tracks |
| `EmptyState.vue` | ✅ 44 行 | **9 处**：VariantLinesEditor + Accounts / Articles / Dashboard / Models / Plan / StylePrompts / TrackAngles / Tracks |
| `SaveBar.vue` | ✅ 140 行 | **3 个视图**：ArticleEdit / StylePrompts / Tracks |
| `TaskProgress.vue` | ✅ 144 行 | **1 个视图**：Dashboard |
| `article-push.ts` | ✅ 188 行 | `ArticleEditView.vue:36`、`ArticlesView.vue:34` |
| `todo-nav.ts` | ✅ 134 行 | `ArticlesView.vue:40`、`DashboardView.vue:16`、`TracksView.vue:28` |
| `web/scripts/*.mjs` | ✅ 2 个 | `package.json` 的 `test:todo-nav` / `test:article-push` |

> **结论**：5 个组件 + 2 个工具函数 + 2 个断言脚本，**全部被已跟踪的 `.vue` / `.ts` / `package.json` 引用**。这 9 个文件若未与引用方同批入库，`vue-tsc` / `build` **必然失败**（模块解析错误）。这是 S6-0 已识别的 P1 风险，本轮再次确认。

### 4.2 全量相对 import 解析（本轮新增校验）

对 82 个待提交文件中的相对 import 做了一次性解析（`from './x'` / `from '../y.ts'` / 动态 `import()`）：

```
检查相对 import 数：258
缺失 0 条 ✅
```

> 方法：对每条相对路径尝试 `原路径 / +.ts / +.vue / +.mjs / +.js / /index.ts` 六种候选，任一命中文件即通过。**未执行 tsc / vite**，属静态路径解析，不替代类型检查。

### 4.3 `package.json` 脚本 ↔ 文件 一一对应

| 脚本名 | 指向 | 存在 |
|---|---|---|
| `verify:s5-4` | `scripts/s5-4-integration.ts` | ✅ |
| `test:lint-store` | `scripts/test-lint-store-degrade.ts` | ✅ |
| `smoke:push` | `smoke-isolated.ts run push` → `smoke-run.ts` → `./smoke-push.ts` | ✅ |
| `smoke:dashboard` | `smoke-isolated.ts run dashboard` → `./smoke-dashboard.ts` | ✅ |
| `test:todo-nav` | `web/scripts/assert-todo-nav.mjs` | ✅ |
| `test:article-push` | `web/scripts/assert-article-push.mjs` | ✅ |

**冒烟运行器映射表全量校验**（`smoke-run.ts:43-52`）：

```
lint      → ./smoke-lint.ts            ✅
style     → ./smoke-style-prompts.ts   ✅
angles    → ./smoke-angles.ts          ✅
bulk      → ./smoke-bulk-delete.ts     ✅
push      → ./smoke-push.ts            ✅
dashboard → ./smoke-dashboard.ts       ✅
```
> 6/6 目标文件均存在。**注意**：`smoke:bulk` 指向 `smoke-bulk-delete.ts`，**不是** `smoke-bulk.ts`——后者不存在，非缺陷。

### 4.4 新增脚本的内部依赖

| 脚本 | 依赖的 `src` 模块 | 存在 |
|---|---|---|
| `test-lint-store-degrade.ts` | `../src/db.ts`、`../src/logger.ts`、`../src/services/lint-store.ts` | ✅ 3/3 |
| `smoke-dashboard.ts` | `../src/db.ts`、`../src/services/auth.ts`、`../src/services/dashboard.ts`、`../src/services/lint-store.ts` | ✅ 4/4 |
| `smoke-push.ts` | `../src/db.ts`、`../src/lib/crypto.ts` | ✅ 2/2 |
| `s5-4-integration.ts` | 内部自拼 `DATABASE_URL` + 真实 Express 路由 | ✅（无相对 import，走服务入口） |

### 4.5 文档交叉引用

对 `docs/DEVLOG.md` 新增 33 条中引用的所有 `.md` 文件名逐一验证：

```
26 个报告引用 → 26/26 存在 ✅
（另 CHANGELOG.md / DEVLOG.md 为根目录文件，存在）
```

---

## 5. 敏感信息检查结果

### 5.1 待提交的 82 个文件 — 零命中

扫描模式：`sk-[A-Za-z0-9]{16,}`、`AKID[A-Za-z0-9]{10,}`、`wx[0-9a-f]{16}`、`AppSecret[:=]` + 20 位以上值、`Bearer <20+ 字符>`。

```
结果：0 命中
```

### 5.2 全仓已跟踪文件（含 HEAD 已有内容）— 零命中

```
sk-* / AKID* / wx<16hex>：0 命中
```

**唯一近似命中**（均为占位符，非真实凭据）：

| 位置 | 内容 | 判定 |
|---|---|---|
| `docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md:186-187` | `mysql://wpc_app:<密码>@127.0.0.1:3306/wechat_pipeline` | ✅ 字面占位符 `<密码>`，模板示例 |
| `server/.env.example:14/17/22` | `ADMIN_PASSWORD=改成强口令`、`JWT_SECRET=随机长字符串`、`APP_SECRET_KEY=`（空） | ✅ 设计上就是占位 |
| `deploy/app.env.example:19` | `APP_SECRET_KEY=CHANGE_ME_GENERATE_WITH_openssl_rand_-base64_32` | ✅ 显式 `CHANGE_ME` |
| `deploy/install.sh:129` | `sed -e "s#^APP_SECRET_KEY=.*#APP_SECRET_KEY=$SECRET#"` | ✅ 安装期动态注入，非硬编码 |

### 5.3 测试用假凭据 — 明确标注虚构

| 位置 | 值 | 判定 |
|---|---|---|
| `s5-4-integration.ts:283` | `encryptSecret('s54-fake-secret')` | ✅ 带 `fake` 前缀 |
| `s5-4-integration.ts:301` | `encryptSecret('s54-fake-key')` | ✅ 带 `fake` 前缀 |
| `s5-4-integration.ts:764` | `encryptSecret('s54-fake-secret-2')` | ✅ 带 `fake` 前缀 |
| `s5-4-integration.ts:300` | `modelId: 's54-mock'` | ✅ 带 `mock` 标识 |
| `s5-4-integration.ts:129` | `{ error: { message: 's54 mock upstream failure' } }` | ✅ 本地假上游 |

### 5.4 敏感文件入库状态

| 文件 | Git 状态 | 保护 |
|---|---|---|
| `server/.env` | **UNTRACKED** | `.gitignore:8` `*.env` |
| `server/.env.example` | TRACKED（占位内容） | `!.env.example` 反忽略，正常 |
| `deploy/app.env.example` | TRACKED（占位内容） | 正常 |
| `web/dist/` | 忽略 | `.gitignore:22` |
| `var/tmp/**`（全部浏览器证据） | 忽略 | `.gitignore:13` |
| `server/var/`（AES 主密钥 + 临时） | 忽略 | `.gitignore:38` |
| `.workbuddy/`（会话记忆） | 忽略 | `.gitignore:48` |
| `*.db` / `*.db.bak-*` / `*.sqlite*` | 忽略 | `.gitignore:25-33` |
| `*.log` | 忽略 | `.gitignore:52` |

> **`.gitignore` 保护完整**，无遗漏。全仓已跟踪文件中**不存在** `.env`、`.db`、`.sqlite`（`git ls-files` 核实：只有 2 个 `.example` 文件）。

### 5.5 大文件

| 文件 | 大小 | 判定 |
|---|---|---|
| `docs/DEVLOG.md` | 251 KB | ✅ 纯文本日志，历史正常累积，非二进制/依赖产物 |

其余 81 个文件均 < 200 KB。**无二进制、无压缩包、无 node_modules、无数据库文件**。

---

## 6. 无关文件与潜在风险

### 6.1 与本项目无关的改动 — 0 个

82 个文件**全部**可归属到 S3 收尾、S4-5、S5-1、S5-2、S5-3A/3B、S5-4、S5-UI-1~6、S6-0。核对依据：每个 `.ts`/`.vue` 的 diff 内注释带阶段编号（如 `// 结果语义（S5-UI-5-P1）`, `// ── 推送事实防重复（S5-1）──`），或可从 `docs/DEVLOG.md` 33 条逐条回溯到文件。

### 6.2 调试代码 / 临时逻辑 — 0 处

| 检查项 | 结果 |
|---|---|
| `debugger` 语句 | 0 |
| 新增行中的 `console.log` | **0** |
| 走查端口残留（`127.0.0.1:87xx` / `:51xx` / `:94xx` / `localhost:8798`） | **0** |
| `TODO` / `FIXME` / `XXX` / `HACK` 新增行 | 0（命中的 `TODO_RECENT`、`TODO_RUN_WINDOW_DAYS` 等是 **变量名含 TODO 字样**，属误报） |

### 6.3 已在 S6-0 登记、本轮再次确认的风险

| # | 风险 | 状态 |
|---|---|---|
| 1 | **9 个 `??` 前端文件必须与引用方同批入库**，否则 build 失败 | 本轮 §4.1 已再次确认，**提交时必须 `git add -A`** |
| 2 | `server/.env` 的 `DATABASE_URL` 指向 `wechat_pipeline_smoke` | 属 S6-2 范围，本轮**仅核查未修改** |
| 3 | `ArticleLintRun` 迁移在业务库的部署状态 | 由 S5-3B-2 报告记录已部署；本轮未连库复核 |

### 6.4 本轮新发现的文档缺口（3 项，非代码问题）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **D-1** | **`CHANGELOG.md` 缺 10 个阶段的条目**：S5-1、S5-3A、S5-3B-1、S5-3B-2、S5-UI-2-C、S5-UI-2-D、S5-UI-3、S5-UI-4、S5-UI-5、S5-UI-6、S6-0 全部 **0 处提及**；CHANGELOG 最新条目停在 `S5-UI-2-B`（2026-11-17） | `grep -c` 逐项返回 0 | 面向使用者的变更记录与实际交付**严重不对等**（DEVLOG 有 33 条，CHANGELOG 只有 4 条） |
| **D-2** | **`docs/restructure/README.md:5` 状态行过时**：仍写"S5（UI/UX）进行中：S5-UI-1 与 S5-UI-2 已实施"，而实际 S5-UI-6-FINAL 已判定**可关闭**、S6-0 已出报告 | 文件第 5 行 vs `S5-UI-6-FINAL-CLOSURE-AUDIT.md` | 接手者会误判项目阶段 |
| **D-3** | **9 个新报告未被 DEVLOG / README 按文件名索引**：`S5-UI-2-B-IMPLEMENTATION-REPORT`、`S5-UI-2-C-WORKBENCH-FLOW-AUDIT`、`S5-UI-2-D-3-A-FAILURE-TRACE-AUDIT`、`S5-UI-2-D-3-B-IMPLEMENTATION-REPORT`、`S5-UI-2-D-4-DASHBOARD-TODO-CLOSURE-AUDIT`、`S5-UI-3-0-ARTICLE-WORKBENCH-AUDIT`、`S5-UI-3-2-REMAINING-UX-ASSESSMENT`、`S5-UI-4-0-CORE-PAGES-AUDIT`、`S6-0-PRE-DELIVERY-AUDIT` | 逐文件 `grep` 计数为 0 | 报告本身存在（内容完整），只是**入口不可达**——不影响提交，影响可追溯性 |

> **这 3 项均不阻塞入库**：D-1/D-3 是文档补写（建议 S6-4 处理），D-2 是一行状态更新（建议 S6-4 一并改）。**不建议在本轮或提交前顺手改**——按用户规范，收尾文档应与阶段结论同步，而不是塞进提交批次。

### 6.5 已核查并排除的疑似问题

| 疑似问题 | 核查结果 |
|---|---|
| `smoke:bulk` 指向的 `smoke-bulk.ts` 不存在 | ❌ 误判。实际映射到 `smoke-bulk-delete.ts`，**存在** |
| `s5-4-integration.ts` 无相对 import 是否孤立 | ❌ 正常。它自己拼 `DATABASE_URL` 并起真实 Express，依赖 `src/index.ts` 路由层 |
| `web/scripts/` 目录是否被忽略 | ❌ 未被忽略（`git check-ignore` 无输出），2 个 `.mjs` 都会入库 |
| `server/prisma/` 是否有未提交的 Schema/Migration 改动 | ❌ **零改动**（`git status` 中无该路径） |

---

## 7. 推荐提交分组及每组文件清单

### 7.1 先说结论：**推荐单次整体提交**

**理由（技术必然性，非偏好）**：

1. **跨层契约同时变更**：`web/src/types.ts` 的 `pushIntent?` 依赖 `server/src/api/routes/scheduler.ts` 的返回；`TriggerResult.failed/skipped` 依赖 `planner.ts`。若分两次提交（先后端后前端），中间态不破坏 build；但若**反过来**（先前端后后端）则 `vue-tsc` 通过、运行时字段缺失——**顺序错了不易发现**。
2. **9 个 `??` 前端文件被 17 个 `M` 视图引用**，拆开必然 build 失败。
3. **11 个 `views/*.vue` 各自叠加了 2–4 个阶段的改动**（例：`ArticleEditView.vue` 同时含 S5-UI-3-1 + P2-3 + P2-4），按文件无法按阶段切分；要切只能 `git add -p`，属交互式高风险操作，且会产出无法独立验收的中间态。
4. **`CHANGELOG` / `DEVLOG` 是累积文档**，无法按阶段拆分而不产生冲突。

### 7.2 若必须分批：推荐 3 段（严格按依赖顺序）

| 批次 | 内容 | 文件数 | 提交后应通过 |
|---|---|---|---|
| **① 后端** | `server/src/**`（10）+ `server/scripts/**`（7）+ `server/package.json` | 18 | `cd server && npm run typecheck` = 0 |
| **② 前端** | `web/src/**`（24）+ `web/scripts/**`（2）+ `web/package.json` | 27 | `cd web && npm run build` ✓ |
| **③ 文档** | `docs/**`（35）+ `CHANGELOG.md`（1）+ `web/UI-GUIDE.md`（1） | 37 | 无（纯文档） |

> ⚠️ **① 必须在前**。② 的 `types.ts` 引用 ① 的 API 契约；③ 的 `DEVLOG.md` 引用 ①②的代码位置。
>
> ⚠️ **`web/UI-GUIDE.md` 放在 ③ 而非 ②**：它是规范文档，但它在 `web/` 目录下——若按目录切分会被误纳入 ②。**必须显式指定路径**。

### 7.3 单提交的完整命令（供人工执行，本轮未执行）

```bash
cd "K:/WorkBuddy WorkSpace/project/wechat-pipeline-cloud"
git add -A            # 必须 -A：44 个 ?? 目录/文件全部纳入
git status --short    # 期望：A 82 个文件（37 M 显示为 M，45 新增显示为 A）
```

**`git add -A` 前的强制自检（3 条）**：

```bash
# 1) 确认无敏感文件被带入
git status --porcelain | grep -E "\.env$|\.db$|\.sqlite|\.log$"     # 期望：空
# 2) 确认 ?? 文件数 = 45（展开目录后）
git status --porcelain | grep "^??" | sed 's/^?? //' | while read p; do [ -d "$p" ] && ls "$p" || echo "$p"; done | wc -l
# 3) 确认 web/scripts 的 2 个 mjs 在列
git status --porcelain | grep -E "assert-(todo-nav|article-push)"
```

**建议的 commit message（单提交版）**：

```
S3-S5: delivery baseline — writing quality, push safety, dashboard todos, full UI overhaul

- S3 收尾：科技赛道 SCENE 反模板（真实样本 10/10 驱动）
- S5-1：推送事实不被失败覆盖 + 并发防重 + 改写后自动复检
- S5-2-HF1：体检存档读路径缺表降级（不伪造通过）
- S5-3A/3B：业务库只读核查 + 完整备份 + Migration 部署（0_init 基线）
- S5-4：正式库应用层集成验证 152 项（唯一允许写正式库的脚本）
- S5-UI-1：设计令牌收口 + 面包屑壳层 + 5 个公共组件
- S5-UI-2：工作台待办队列（4 类待办 + 跳转承接 + 51 项口径断言）
- S5-UI-3/4：文章工作台、选题库窄屏、文风配置、模型就绪准确性
- S5-UI-5：出稿四态反馈、warnings/backlog、凭据措辞、体检命中片段、无账号引导
- S5-UI-6：member 自动化模式保存修复 + pushIntent 四态真源
- 文档：32 份验收/审计报告、DEVLOG 33 条、CHANGELOG 4 条、UI-GUIDE 组件规范

未提交前状态：HEAD b2fbad3 / 82 文件（37 M + 45 ??）
```

---

## 8. 是否具备整体提交条件

### ✅ 具备

| 判定项 | 结论 | 依据 |
|---|---|---|
| 全部改动可归属已验收阶段 | ✅ | 82/82 文件可回溯到 DEVLOG 33 条或 diff 内阶段注释 |
| 无 P0（数据安全/错误发布） | ✅ | `AUTO_PUBLISH = false as const`；全仓 `masssend` 仅 4 处禁止性注释 |
| 无敏感信息 | ✅ | 待提交 82 文件 + 全仓已跟踪文件零命中；`.env`/`.db`/`.log` 均未跟踪 |
| 无调试残留 | ✅ | `debugger` 0、新增 `console.log` 0、走查端口 0 |
| 无无关文件 | ✅ | 0 个 |
| 依赖闭环 | ✅ | 258 条相对 import 全解析；6 个 `package.json` 脚本全有对应文件；6 个冒烟目标全存在 |
| `.gitignore` 保护完整 | ✅ | 9 类敏感/临时对象全部覆盖 |
| 无 Schema/Migration 未提交改动 | ✅ | `server/prisma/` 零改动 |

### ⚠️ 提交前必须由人工完成（不属本轮授权）

| # | 事项 | 原因 |
|---|---|---|
| 1 | **用 `git add -A`，不得只 add 已跟踪文件** | 45 个 `??` 中含 9 个被引用的前端文件 |
| 2 | **执行 §7.3 的 3 条自检** | 防止敏感文件或目录折叠误判 |
| 3 | **决定单提交 / 3 段提交** | 见 §7.1–7.2，技术上都可行，单提交更稳 |
| 4 | **提交后立即跑一次 `server typecheck` + `web build`** | 验证入库内容与工作区一致（本轮未运行，见 §10） |

### ❌ 不构成阻塞的已知缺口

- 文档缺口 D-1/D-2/D-3（§6.4）：**不影响代码入库**，建议 S6-4 处理。
- S6-0 的 P1-①（`.env` 指向 smoke 库）：属 S6-2，与入库无关。
- 历史 P3（B-1 披露确认、T1 刷新拦截、500px 溢出、S5-UI-5 的 B1/D-1/E-3）：按 S6-0 分级，**不阻塞**。

---

## 9. 尚需人工确认的事项

| # | 事项 | 需要决定什么 | 建议 |
|---|---|---|---|
| **Q1** | 提交粒度 | 单提交（推荐）还是 3 段（后端→前端→文档） | 选单提交；3 段仅在需要独立回溯时使用 |
| **Q2** | `CHANGELOG` 是否补 10 个阶段 | 补写（工作量大，需从 DEVLOG 提炼）还是接受"CHANGELOG 只记用户可见变更、内部阶段仅进 DEVLOG" | 按后者解释也成立——但 `S5-UI-1/3/4/5/6` 都有用户可见变化，**建议至少补 S5-UI-1、S5-UI-5、S5-UI-6 三条**，放入 S6-4 |
| **Q3** | `docs/restructure/README.md:5` 状态行 | 是否改为"S5 全部完成并关闭，S6 进行中" | 建议改，一行改动，放 S6-4 |
| **Q4** | 9 个未被索引的报告 | 是否补入 README 索引表 | 建议补，放 S6-4 |
| **Q5** | **浏览器证据是否入库** | `var/tmp/s5ui2c/` 全部被 `.gitignore` 忽略（P61/P62 的 JSON + 13 张 PNG）。入库则报告可复现，不入库则报告结论不可复核 | **建议保持忽略**（仓库不装截图），但在报告内已写明证据文件名与本地路径，属可接受折衷。若要求可复核，需单独授权把关键 JSON（非 PNG）放入 `docs/restructure/evidence/` 并加反忽略规则 |
| **Q6** | 当前 8787 / 5173 开发服务 | 提交前是否停止 | 与提交无关；但**不建议在服务运行中做 `git add -A`**（`var/` 与 `web/dist` 虽被忽略，避免节外生枝） |
| **Q7** | 提交后是否立即验证 | 是否跑 `server typecheck` + `web build` + 至少 `test:article-push` / `test:todo-nav` | **强烈建议**：本轮为只读核对，未运行任何构建；入库后必须验证一次 |

---

## 10. 本轮未执行的验证（明确声明）

| 未执行项 | 原因 |
|---|---|
| `git add` / `commit` / `push` / `checkout` / `reset` / `restore` / `clean` / `stash` | 任务边界明确禁止 |
| `npm run typecheck`（server / web） | 边界禁止运行构建与测试 |
| `npm run build` | 同上 |
| 任何 `smoke:*` / `verify:*` / `test:*` 脚本 | 边界禁止；且会连接数据库 |
| 连接 MySQL（含只读） | 边界禁止 |
| 调用 LLM / 微信公众号接口 | 边界禁止 |
| 启动或停止 8787 / 5173 服务 | 边界禁止干预；两服务为用户自启，本轮原样保留 |
| **真实数据库 `GET /scheduler` E2E** | 继承 S6-0 / S5-UI-6-2 的未验证状态，**仍未执行** |

### 本轮实际执行的检查（全部只读、无副作用）

```
git rev-parse / branch / log / status / ls-files / check-ignore / grep / diff
文件系统：ls / wc -l / stat（仅读取）
Node 内联脚本（node -e）：统计文件数、解析相对 import、读取 .env 键名（脱敏）
netstat / tasklist：确认端口占用（仅查看）
```

> 上述检查**均不修改工作区**，不产生 `.git` 写入，不触发构建缓存。

---

## 附录 A：提交清单速查（可直接复制到 `git add` 前的核对表）

```
后端源码 10：server/src/api/routes/{articles,plans,revise,scheduler}.ts
             server/src/services/{angles,dashboard,lint-store,planner,publisher,scheduler}.ts
后端脚本  7：server/scripts/{smoke-angles,smoke-isolated,smoke-run}.ts (M)
             server/scripts/{s5-4-integration,smoke-dashboard,smoke-push,test-lint-store-degrade}.ts (??)
后端配置  1：server/package.json
前端视图 11：AccountsView/ArticleEditView/ArticlesView/DashboardView/ModelsView/PlanView/
             PrefixSettingsView/SchedulerView/StylePromptsView/TrackAnglesView/TracksView
前端组件  6：PageHead/StatusTag/EmptyState/SaveBar/TaskProgress (??) + VariantLinesEditor (M)
前端工具  3：utils/format.ts (M) + utils/{article-push,todo-nav}.ts (??)
前端其他  4：App.vue / styles.css / types.ts / api/index.ts
前端脚本  2：web/scripts/assert-{todo-nav,article-push}.mjs (??)
前端配置  1：web/package.json
文档     37：CHANGELOG.md / docs/DEVLOG.md / web/UI-GUIDE.md /
             docs/restructure/README.md + S4-3-REPORT (M) + 32 份新报告 (??)
─────────────────────────────────────────────
合计     82
```

## 附录 B：与本报告的交叉引用

| 文档 | 关系 |
|---|---|
| `S6-0-PRE-DELIVERY-AUDIT.md` | 上游审计，本报告是其 §6（Git 风险）的展开落地 |
| `S5-UI-6-FINAL-CLOSURE-AUDIT.md` | S5-UI-6 关闭结论，本报告的验收前提 |
| `docs/DEVLOG.md` | 33 条阶段记录，本报告的文件归属依据 |
| `docs/restructure/README.md` | 决策表 + 文档索引（本轮发现状态行过时，见 D-2） |
