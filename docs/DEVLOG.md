# 开发日志

> 每次会话结束时追加。换空间/换会话后，新对话凭本文件 + 根目录 `README.md` 接上上下文。
> 格式：`## YYYY-MM-DD · 做了什么` → 产出 / 决策 / 下一步 / 待办。

## 2026-10-10 · 项目立项、后端骨架、数据迁移

**背景**：用户要把本机 Windows 流水线搬到云服务器，做 Web 管理界面。
明确四点要求：① 独立新建项目不动现有目录；② 项目放 `project/` 下作为未来工作空间规范；
③ 本机流水线继续运行，云端功能验收后再切换；④ 密钥数据库化并必须有配置界面。

**技术栈变更**：初版定为 Python(FastAPI)，用户中途改为 **Node + TypeScript**（学习诉求）。
选型确认：Express + TypeScript + Prisma，前端 Vue3 + TS + Element Plus，数据库 MySQL 8.0。

**产出**
- 项目骨架 `K:/WorkBuddy WorkSpace/project/wechat-pipeline-cloud/`
- 后端跑通：`GET /api/health` → `{"ok":true,"db":"up","driver":"sqlite","autoPublish":false}`
- Prisma schema（MySQL 真源 + SQLite 自动降级，单源维护）
- `services/dedup.ts` 移植完成（观点层去重）
- `cli/migrate.ts` 迁移完成：赛道 5 / 账号 6 / 角度 349 / 文章 5 / 设置 3，**断链断言 = 0**
- `cli/inspect.ts` 检视工具，可验证加密凭据能否还原

**关键决策**
- Node 22 原生跑 TS（`--experimental-strip-types`），**无构建步骤**；
  代价：相对 import 必须写 `.ts` 后缀（Node 不会把 `./a.js` 解析成 `a.ts`，已实测）
- 去掉 tsx（esbuild postinstall 校验 node.exe 报 EBUSY），少一层依赖
- 本地无 MySQL → 用脚本从 MySQL 真源降级生成 SQLite schema，避免维护两份
- 断链消歧：`育儿-019/039` 同日期同账号无法靠「日期+账号」区分，改用**标题与角度文本的语义相关度**匹配

**踩坑**
- `rm -rf node_modules` 撞批量删除守卫导致命令链中断 → 改为直接 `npm install` 不手工删

**下一步（阶段 2）**
1. 微信通道：token 缓存、素材上传、草稿增删、重试幂等
2. 凭据配置 CRUD + 连通测试
3. HTML 解析与渲染移植（**预览与推送必须共用同一渲染函数**）+ 对拍测试

**阻塞项**
- 云服务器信息未提供（系统版本 / Python / MySQL / **固定公网 IP**）。
  拿到 IP 后要加到「戏精漫话」的 IP 白名单，否则 40164。

## 2026-10-10（续）· 阶段 2：凭据配置与微信通道

**背景**：阶段 1 已完成骨架与数据迁移，继续推进阶段 2。

**产出**
- `services/accounts.ts`：移植 `check_accounts.py` 的 `creds_valid`，输出校验 + 凭据状态决策
  （ok/placeholder/invalid/missing，对应自动启用逻辑）
- `services/wechat.ts`：微信通道服务，移植 `push_draft.py` 微信接口
  - token 库内缓存（`WechatToken`）+ 临期刷新
  - 素材上传 / 草稿增删查（原生 fetch+FormData，去除 curl 硬编码）
  - 按错误码分级重试：40164 不重试、40001/42001 刷 token 重试一次、网络类指数退避≤4 次
  - 红线：只写草稿箱，无 masssend
- `api/routes/credentials.ts`：凭据配置 CRUD + 连通测试
  - 列表/详情只返回掩码；PUT 加密落库并按校验结果置状态；`/test` 真实调 token 接口验证并自动启用
  - 占位/缺失账号 `/test` 短路，不浪费外网调用

**踩坑（重要）**
- Node `--experimental-strip-types` **不支持参数属性**（`private readonly x: T` 写在构造函数参数上会
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。构造函数里只能写普通参数，再在方法体里 `this.x = x`。
- 跨命令的后台服务进程会被沙箱回收，`curl localhost` 第二次就 `EADDRINUSE`/连接失败。验证改用
  **单进程内 `app.listen(0)` + 全局 fetch** 的内联冒烟脚本，一次命令跑完所有断言。
- 代理会拦截 `localhost`：`curl http://localhost` 偶发 `upstream connect failed`，需 `--noproxy '*'`
  （内联脚本用 `127.0.0.1` 规避）。
- 冒烟测试副作用：`/test` 打真实微信接口拿到 40013 后 catch 会把账号写成 `invalid` 并落库，污染下次断言。
  脚本开头/结尾用 `updateMany` 把 2-6 复位为占位，保证确定性。

**验证**
- `npm run typecheck` 通过
- 13 项内联冒烟断言全过：脱敏、非法凭据 400、占位短路、密文落库、真实通道优雅报错（40013）

**下一步（阶段 3）**
1. HTML 解析（`push_draft.py` Extractor → `services/parse/`）
2. 渲染函数（预览与推送**必须共用同一函数**，`services/render/`），并做对拍测试
3. 封面上传接入 `wechat.uploadImage` + `publisher.updateCover()`

**阻塞项（延续）**
- 云服务器固定公网 IP 仍需提供；`戏精漫话` 真实凭据待用户确认（当前库里是迁移时带入的占位/旧值）。
- 前端未启动；阶段 3 建议与 Vue3 前端并行推进配置界面。

---

## 2026-10-10 · 补记：并行期快照验证

**事件**：上一轮为验证 health 起的 dev 服务跑了 41 分钟后被系统 `Killed`（SIGKILL，无异常堆栈）。
排查结论：**非代码问题**，是后台进程被回收。数据完好（无 journal/WAL 残留，孤儿角度断言 = 0）。
服务不必常驻，需要时 `npm run dev` 即可。

**重要发现：并行期确实在生效**
本机流水线 06:00 定时今早已自动跑完，产出两篇并推入草稿箱：

| 文件 | 标题 | 字数 |
|---|---|---|
| `育儿001-哭声免疫法与父母直觉.html` | 【话】半夜他哭到第三分钟，我删掉了计时器 | 1804 |
| `育儿002-追着喂饭与自主进食.html` | 【话】追着喂大的孩子，丢的不是胃口 | 1671 |

因为迁移是在这两篇产出**之后**执行的，云端库已包含它们（含正文）。当前库内 5 篇文章正文全部入库
（3650/3603/3604/**3678**/**3592** 字符，后两条是今早新产出）。**阶段 3 在线改稿的数据基础已具备。**

**由此暴露一个必须解决的问题（待办）**
云端库是**一次性快照**，不是实时同步。本机每天仍在产出，明天再出 2 篇，云端不会自动知道。
正式切换前必须二选一：
- 给 migrate.ts 加**增量同步**能力（按 media_id / angle id 去重，只补新增）
- 或切换时再跑一次全量迁移（切换窗口需停掉本机定时）

倾向前者：切换当天能无缝衔接，且可先在并行期反复演练。

**已知小瑕疵**
`育儿-010`（预制娃那篇）入库后 `account` 为空，界面显示为「未关联」。
源自本机历史库该条本就没记账号字段，非迁移错误。阶段 2 可在界面提供补关联入口。

**环境备注**
SQLite 库实际落在 `server/prisma/dev.db`（Prisma 默认行为，非 README 所写的 `var/`）。
写内联脚本 `--input-type=module -e` 查库时**须先 `import 'dotenv/config'`**，否则报
`Environment variable not found: DATABASE_URL`（CLI 因 import 了 config.ts 而不受影响）。

---

## 2026-10-10（再续）· 阶段 3：渲染与在线改稿

**背景**：阶段 2 已打通凭据与微信通道，继续推进阶段 3（解析 + 渲染 + 在线改稿）。

**产出**
- `services/parse/index.ts`：HTML 解析器，移植 `push_draft.py` 的 `Extractor`
  - 轻量分词器（正则切标签 + 文本节点），未引入重型 HTML 解析库（输入为本系统自产语义化 HTML，结构受控）
  - 提取 h1/h2/p；`<strong>` 普通加粗、`<strong class="key">` 品牌红；`<span class="num/seq/order/index">` 跳过；实体解码
  - 用控制字符 `\x01/\x02/\x03` 标记强调，渲染阶段还原（与蓝本一致，便于对拍）
- `services/render/index.ts`：渲染器，**预览与推送共用唯一函数 `renderArticle`**
  - 小标题自动编号（01/02…，蓝色斜体）+ 剥离手写序号防「11 11」；标题加 `【话】` 前缀（幂等）；摘要取首段前 54 字
  - 内联样式：一级 `#111`、二级品牌红 `rgb(255,76,65)`、容器 17px
- `api/routes/articles.ts`：文章路由
  - `POST /api/articles` 创建；`GET /:id` 读取；`GET /:id/preview` 实时重渲染；
    `PUT /:id/content` 在线改稿（重算渲染+统计，改动后推送态回退草稿）；
    `POST /:id/push` 推送草稿（仅 `credStatus==='ok'` 才执行，只写草稿箱，封面按需上传）
  - 封面上传已接入 `wechat.uploadImage`（文件存在才传）

**无新增依赖**：HTML 解析用自写分词器，未装 node-html-parser/cheerio，保持依赖面小。

**验证**
- `npm run typecheck` 通过
- 23 项内联冒烟断言全过（解析计数 / 实体解码 / 序号 span 跳过 / 强调内联 / 手写序号剥离 / 摘要截断 /
  **预览与存储渲染产物字节级一致** / 在线改稿同步 / 未绑账号 + 占位账号推送均优雅拒绝）

**下一步（阶段 4）**
1. 模型配置（LLM 可配置 CRUD，绑定 write/revise/cover/expand_roles）
2. 选题（`daily_plan.py` → `services/planner.ts`）+ 手动触发创作
3. 强调标注自动建议（`auto_emphasis.py` → `services/emphasis.ts`）
4. 前端 Vue3 配置界面（凭据 CRUD、文章在线改稿、预览）至今未启动，建议阶段 4 起并行

**阻塞项（延续）**
- 云服务器固定公网 IP 仍需提供；`戏精漫话` 真实凭据待确认。
- 增量同步：云端库是一次性快照，本机仍在产出，正式切换前需 migrate.ts 支持增量（按 media_id/angle id 去重）。

---

## 2026-10-10（三续）· 阶段 4：模型配置 + 选题 + 手动触发 + 强调补全

**背景**：阶段 3 已完成渲染与在线改稿，本阶段把「配置模型 → 选题 → 触发建稿 → 强调补全」串成闭环节点。

**产出（新增 6 个文件 + 改 3 个）**
- `services/llm.ts`：OpenAI 兼容 chat 抽象（Key 解密、超时、错误归一、testModel 连通、resolveModelForRole 角色解析）
- `services/writer.ts`：写作服务，用「write」绑定模型生成；缺 Key/失败回退骨架草稿
- `services/planner.ts`：选题规划（buildPlan 排产、reserveAnglesForAccount 事务 CAS 预留、createDraftsForAccount 触发建稿 + 记 TaskRun）
- `services/emphasis.ts`：强调自动补全（移植 auto_emphasis.py 的确定性打分逻辑）
- `api/routes/models.ts`：模型 CRUD + /test 连通 + 角色绑定（write/revise/cover/expand_angles）
- `api/routes/plans.ts`：`GET /api/plan` 排产 + `POST /api/plan/trigger` 建稿
- `api/routes/emphasis.ts`：`POST /api/emphasize` 预览 + `POST /api/emphasize/articles/:id` 应用并重渲染
- `app.ts` 挂载上述三路由；`src/db-json.ts` 新增 JSON 字段跨库统一读写助手

**关键环境坑（已写进 README）**
1. **裸 `npx prisma generate` 会读 mysql 的 `schema.prisma` 覆盖本地 sqlite 客户端**，导致：
   - Json 字段（paramsJson/resultJson/qualityJson）写对象报 "Expected String"
   - 枚举类型（ModelRole/JobRole 等）在 sqlite 客户端里找不到导出
   正确做法：本地只跑 `npm run schema:sqlite` 后其生成的 `schema.sqlite.prisma` 去 `prisma generate`。
2. **sqlite schema 把 Json→String?、所有枚举→String**：所以代码里不能用 Prisma 枚举类型，改用本地联合类型
   （如 `ModelRole = 'write'|'revise'|'cover'|'expand_angles'`，定义在 llm.ts），JSON 列统一用 `packJson/unpackJson` 字符串存取，
   以保证本地 SQLite 与生产 MySQL 行为一致且能通过 typecheck。

**验证**
- `npm run typecheck` 通过
- 19 项内联冒烟断言全过（模型 CRUD 掩码、绑定/解析、连通测试优雅失败、计划产出、触发建稿并消耗角度一条、
  无 Key 回退骨架、强调预览补加粗+红字、应用到文章后 contentWechat 重渲染）

**下一步（阶段 5 + 前端）**
1. 自动调度（cron/systemd 触发 buildPlan+createDraftsForAccount；本机用 WorkBuddy 调度）
2. 仪表盘（TaskRun/RunLog 可视化、健康度、欠账扫描前端）
3. **前端 Vue3 + TS 至今未启动**（配置界面、在线改稿、预览、计划面板全缺），建议与阶段 5 并行
4. updateCover 并入发布流程（push 后回填封面 media_id）

**阻塞项（延续）**
- 云服务器固定公网 IP 仍需提供；`戏精漫话` 真实凭据待确认。
- 增量同步：云端库是一次性快照，本机仍在产出，正式切换前需 migrate.ts 支持增量。
- 阶段 4 的「模型生成」依赖真实 LLM Key 才能产出正文；当前本地无 Key 时走骨架回退，端到端联调需用户提供 Key 与绑定。

---

## 2026-10-10（四续）· 阶段 5：自动调度 + 仪表盘

**背景**：本机流水线依赖 WorkBuddy 客户端常驻做 06:00 定时，关机即跳过且不补跑。阶段 5 把这条链路搬到云端进程内定时器。

**产出（新增 5 个文件 + 改 3 个）**
- `services/publisher.ts`（**关键抽取**）：把原 `articles.ts` 的推送逻辑抽成 `pushArticleToDraft`，
  手动 `/push` 与调度器共用同一实现，避免「手动一套、自动另一套」的行为分叉。补充记 TaskRun(jobType=push)。
- `services/scheduler.ts`：调度服务 + `cli/scheduler.ts` 守护进程（新增 npm scripts `scheduler` / `scheduler:once`）
- `services/dashboard.ts` + `api/routes/dashboard.ts`：`GET /api/dashboard` 聚合（区块级容错降级）
- `api/routes/scheduler.ts`：`GET 状态 / PUT config / POST tick(force) / POST start|stop`
- `app.ts`：挂载上述两路由；**修复全路由通病**——统一错误处理原先只识别 `AppError`，
  导致 zod 校验失败被返回成 500，现单独识别 `ZodError` 返回 400 + `validation_error` + 字段级 issues。

**设计要点：调度幂等**
不采用「今天跑过没」这种易被中断污染的标志位，而是**复用当日配额**：
账号当日已产 ≥ 赛道 `quotaPerDay` 时，`createDraftsForAccount` 直接返回「今日配额已满」且零副作用。
因此反复心跳天然安全，进程崩溃重启也不会重复出稿。已用冒烟断言验证（二次补跑 `created=0`）。

**安全红线保持**
`scheduler_push_enabled` 默认 0 —— 并行期 dry-run 不真推；推送只到草稿箱（addDraft），无 masssend 路径。

**验证**
- `npm run typecheck` 通过
- 21 项内联冒烟断言全过，其中关键三项：默认关闭+dry-run 不推送、**二次补跑零产出且报「今日配额已满」**、
  仪表盘 `degraded` 为空且 `AUTO_PUBLISH` 暴露为 false。

**过程中发现的两个真 bug（已修）**
1. 原 `HH:mm` 校验正则 `/^\d{2}:\d{2}$/` 会把 `25:99` 判为合法 —— 配成这种值会**永不触发**且毫无提示。
   已改为 `/^([01]\d|2[0-3]):([0-5]\d)$/` 并在 scheduler 与 route 两处共用导出常量 `WRITE_TIME_RE`。
2. zod 校验失败返回 500（见上）。

**测试踩到的「假失败」**
默认就绪账号 `戏精漫话` 当日已有 5 篇（迁移带入），配额 2 已满，所以 force 补跑自然产出 0 ——
这不是 bug，而是幂等按预期工作。改为临时把有余量的账号置为就绪来验证写稿路径，结束后还原。

---

## 2026-10-10（五）前端交付：Vue3 + TS + Vite + Element Plus

**做了什么**
在 `web/` 从零搭起前端并完成五个页面，后端至此**全部完成**（阶段 0–5 + 前端）。

- 骨架：`package.json` / `vite.config.ts`（`/api` 代理到 8787）/ `tsconfig`（`allowImportingTsExtensions`
  以沿用后端 `.ts` 后缀导入约定）/ `index.html` / `main.ts`（Pinia + Element Plus 中文）/ `router` / `styles.css`
- `src/api/http.ts`：极简 fetch 封装，把后端 `{ error: { code, message, detail } }` 还原成 `ApiError`
- `src/api/index.ts`：全部接口映射（health/credentials/models/plan/scheduler/dashboard/articles/emphasize）
- `src/types.ts`：与后端响应一一对应的类型
- 页面：仪表盘 `/`、创作计划 `/plan`、文章 `/articles`、在线改稿 `/articles/:id`、
  账号管理 `/accounts`（原名「凭据配置」`/credentials`）、模型配置 `/models`

**顺带补的后端接口**
前端列表页需要 `GET /api/articles`（此前只有 `/:id`）。已加，支持 `status` / `accountId` 过滤与
`limit` / `offset` 分页，返回精简字段（不带正文，避免列表响应过大）。`npm run typecheck` 通过。

**一个刻意的偏离：不用 wangEditor**
README 原计划写的是 wangEditor 5，实际实现改为**语义化 HTML 源码编辑 + 实时预览 + 一键插标签**。
理由：解析器 `services/parse/index.ts` 只认 `<h1>/<h2>/<p>` 与 `<strong>` / `<strong class="key">`，
富文本编辑器产出 `<div>` + 内联样式，会破坏契约、导致「预览与推送产物不一致」——而那条不变量是阶段 3 的核心。
源码编辑反而更贴合流水线语义，已同步写入 README 说明。

**验证**
- `npx vue-tsc --noEmit` 通过；`npx vite build` 通过（1632 modules）
- 同进程启动后端 + Vite dev 实测：首页 HTTP 200；经 `/api` 代理取到真实数据
  （health / dashboard / articles / credentials），确认前后端契约打通

---

## 2026-10-10（六）UI/UX 优化：建立设计规范并逐页改造

**用了什么**
安装并使用 UI 技能「剑十一·网页 UI/UX 工程助手」（`workbuddy-frontend-ui-engineering`）。
安装前做了安全审计：`SKILL.md` + `references/accessibility-checklist.md` + LICENSE/NOTICE，
**纯 Markdown，无脚本、无网络调用、无可执行文件**（P2 安全），可放心使用。

**改了什么**
1. `web/src/styles.css` —— 建立设计令牌层：语义变量 `--wb-*`（颜色/间距/圆角/字号）、
   主色定为品牌绿 `#0a7c47`（微信绿压深，白字对比度 5.2:1）并覆盖 Element Plus 的 `--el-color-primary` 系列；
   新增 `:focus-visible` 统一描边、`.wb-skip-link` 跳转链接、`.wb-visually-hidden`、
   `prefers-reduced-motion` 支持、`col-optional` 窄屏隐藏次要列。
2. `web/src/components/StateError.vue`（新增）—— 错误态 + 重试入口，五个页面复用，
   不再只弹一条消息就让用户卡住。
3. `web/src/router/index.ts` —— 每页补 `meta.title/desc`，`afterEach` 同步 `document.title`，
   新增 404 兜底重定向。
4. `web/src/App.vue` —— 修掉**顶部标题恒为「控制台」**的真 bug（此前 `meta.title` 从未定义）；
   侧边栏可折叠且 `<1180px` 自动收起；`nav[aria-label="主导航"]`；折叠按钮带可访问名称。
5. `web/src/views/DashboardView.vue` —— 重构视觉层级：**唯一主入口**改为今日出稿进度环
   （含「还差 N 篇」与「去出稿」直达按钮），告警置顶，次要指标降为三张小卡，全量响应式栅格。
6. `web/src/views/PlanView.vue` —— 调度配置改带标签的表单（含说明文案）、独立错误态与重试、
   欠账/未排产双栏响应式。
7. `web/src/views/ArticlesView.vue` —— **筛选与页码放进 URL query**（可分享/可返回/刷新不丢），
   换用 `el-pagination`、空态给出「去创作计划」入口、错误态可重试。
8. `web/src/views/ArticleEditView.vue` —— 窄屏切「编辑/预览」单栏避免互相挤压；
   `Ctrl/⌘ + S` 保存；未保存时**离开路由二次确认 + 关闭标签页拦截**；编辑器加隐藏 label；
   源码区高度改为视口比例。
9. `web/src/views/CredentialsView.vue`（后更名 `AccountsView.vue`，路由 `/accounts`）/ `ModelsView.vue` —— 统一页头（标题+说明+统计）、
   错误态重试、表单**字段级错误**（名称/Base URL/模型 ID 分别提示）、响应式列与次要列隐藏。

**踩到的环境坑**
本机默认堆内存下 `vite build` 会 OOM（`FATAL ERROR: NewSpace::EnsureCurrentCapacity`）。
已在 `package.json` 的 `build` 里固化 `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build`
（不用 cross-env，跨端可用）。

**验证**
- `vue-tsc --noEmit` 通过；`npm run build` 通过
- 同进程起后端 + Vite dev 实测：`/`、`/plan`、`/articles`、`/articles/10`、`/credentials`、`/models`
  六条路由均 200；经代理取到 health / articles / scheduler / models 真实数据；vite 日志无编译错误

**尚未验证（如实说明）**
未做浏览器实机视觉走查：焦点顺序、真实窄屏（320/768/1024/1440）下有无遮挡、Tab 键能否完成关键操作
这几项只在静态层面保证，需要真实浏览器回归。

**下一步**
1. `deploy/`：systemd unit + Nginx 反代（前端 `dist` 静态托管 + `/api` 转发）
2. updateCover 并入发布流程（push 后回填封面 media_id）
3. 端到端联调需真实 LLM Key + 微信凭据
4. migrate.ts 支持增量同步（正式切云端前必做）

**阻塞项（延续）**
- 云服务器固定公网 IP 仍需提供；`戏精漫话` 真实凭据待确认。
- 增量同步：云端库是一次性快照，本机仍在产出，正式切换前需 migrate.ts 支持增量。

---

## 2026-10-10（七）界面更名：「凭据配置」→「账号管理」

**改动**
- `web/src/views/CredentialsView.vue` → **`AccountsView.vue`**（页面标题「账号管理」，
  统计文案改为「共 N 个公众号账号 · 就绪 X 个」，弹窗标题「编辑账号凭据 · 名称」，错误态文案同步）。
- `web/src/router/index.ts`：路由 `path: '/accounts'`、`name: 'accounts'`、
  `meta.title/desc` 改为「账号管理 / 公众号账号的 AppID / Secret 维护与连通测试」；
  **保留 `/credentials` 重定向到 `/accounts`**，避免历史书签与外链失效。
- `web/src/App.vue`：侧边栏菜单项改为「账号管理」，图标 `Key` → `User`（更贴合"账号"语义）。
- 后端 `/api/credentials` 与前端 api 层函数名**保持不变**（技术语义仍是 credential，只改用户可见文案）。
- README（目录说明 + 前端路由表）与 DEVLOG 历史记录同步更名。

**验证**
- `vue-tsc --noEmit` 通过
- Vite dev 同进程冒烟：`/`、`/accounts`、`/credentials`、`/plan`、`/models` 均 200；
  `AccountsView.vue` / `App.vue` / `router/index.ts` / `api/index.ts` 四个模块均编译成功无报错
- 本次未跑 `vite build`：本机内存紧张，esbuild 在 rendering chunks 阶段 OOM
  （`VirtualAlloc failed with errno=1455`），与本次改动无关；类型检查 + dev 编译已覆盖改动面

---

## 2026-10-15 · 查清「字数达不到」的真因并修复（段落数锚）

**背景**：用户要求「不要读现有结论，自己去分析为什么字数达不到要求」。
前几轮我已经在提示词里反复加字数要求（1800-2200）、又打过三次补丁，字数仍上不去。
本轮重做归因，**先做排除法拿一手证据，再动手**。

### 排除掉的四个嫌疑（都有实测，不是推断）

| 嫌疑 | 实测证据 | 结论 |
|---|---|---|
| `max_tokens` 截断 | 48 次调用 `finish_reason` **全是 `stop`**，一次 `length` 都没有 | 排除 |
| token 预算不够 | 实测 **0.737 token/字** → 4096 token 可容 **5557 字**（代码注释假设 1.3，差一倍多） | 排除 |
| 后处理压字数 | 原始 1749 → sanitize 1749 → reflow 1748；reflow 把 19 段重切成 28 段但**一个字没删** | 排除 |
| 提示词被截断 | 实际 6700 / 上限 6800，未触发截断标记 | 排除 |
| 单条款（减法原则 / 2 段节 / 字数锚） | A/B 组间差异 **小于组内方差** | 不成立 |

### 真因：目标高于模型自然产出的分布中心，而方差极大

同一选题、同一采样参数的真机实测（**走完整生产链路**，含定向修补）：

| | 修复前 | 修复后（合并 n=20） |
|---|---|---|
| 字数均值 | ~1670 | **1918** |
| σ | — | **355** |
| 区间 | 1380-2111 | **1349-2755** |
| 低于门禁 1300 | 有（330 骨架稿、多次 1236/1293） | **0 次** |
| 过字数门禁 1300-2300 | ~5/6 | **18/20（90%）** |
| 落在目标区 1800-2200 | 1/6 | **9/20（45%）** |

⚠️ **如实说明**：修复后的第一批（n=10）曾报出「均值 1896、σ 148、目标区 7/10」，
我用它下过「σ 从 399 降到 148」的结论。**合并第二批后 σ 其实是 355**，
目标区命中率是 **45% 而非 70%**——单批 n=10 的估计不稳，那个乐观数字不成立，已按合并值更正。
**能站住的结论只有两条**：① 均值从 ~1670 抬到 ~1918；② **低于 1300 的失败（原始问题）归零**。
目标区命中率 45% 是模型固有方差（σ≈355）决定的，不是提示词还能再拧的旋钮。

关键机制：**字数 = 段数 × 段均**。模型段均稳定在 ~100 字、**段数只有 16.6**（提示词自己写的是 18-22 段），
乘出来就是 1690。而模型对**可数**指标（段落数）服从度高，对**不可数**指标（总字数）只能先验估、
边写边无法核——实测同一提示词出过 971 字也出过 3883 字。

### 修复方式：把「字数」翻译成「段落数」

- `constants.ts` 新增 `TARGET_CHARS_MIN/MAX`（1800/2200）与 **`PARA_TARGET_MIN/MAX`（17-19）**，
  并写明推导：段均实测 116 字 → 1800-2200 ÷ 116 ≈ 17-19 段（不是拍脑袋的数）。
  此前 1800-2200 硬编码在三处，改一处就与另两处打架。
- `writer.ts` 第 2/7 条：删掉「每节 6-7 段」分档表与「另加开头 1 段与结尾 1-2 段」，
  改为**只给全文总段数** + 「交稿前自己数 `<p>` 个数」。
- `writer.ts` `buildPrompt` 的 tail 与 `repairOnce` 收尾：目标区间统一走常量。
  （此前主提示词要 1800-2200、**修补提示词要 1300-2300**，模型取下限，修补反而把字数改少：
  实测 2111→2065、1418→1394。）
- `config/style_dna.json`：清掉两条与段数账**算术无解**的旧条：
  ①「每节 6-7 段」vs「至少有一节只有 2 段」（3×6=18 段 vs 2+7+7=16 段，模型只能取下限）；
  ②「允许某一节只写 250 字就收住」。
- 新增 `npm run verify:length`（`scripts/verify-length.ts`）：真机跑 N 次走完整链路，
  报均值/σ/落在目标区比例，并在偏低/偏高时直接给出「该往哪个方向调锚」。
- `smoke:lint` 加 7 条回归断言（83 → **90 项**），把「旧配额必须清干净」钉死。
  ⚠️ 断言会先剥掉「已作废/旧版」这类**变更说明**再比对——否则注释里写踩坑经过就会被误判为违规。

### ⚠️ 标定过程中的一个教训：锚不是越大越好

先入为主地以为「锚大 = 字多」，实测**反了**（同为完整链路、n=10）：

| 锚 | 均值 | σ | 目标区 | 过门禁 |
|---|---|---|---|---|
| **17-19** | **1896** | **148** | **7/10** | **10/10** |
| 20-22 | 1710 | 566 | 2/10 | 8/10 |

锚定得过高会诱发模型「凑」——补出来的段落又短又乱，方差反而炸开。**已回退到 17-19。**

### 另一条独立发现：两套副本的字数口径不同

- 云端 `parse/index.ts:152` 把 **h2 小标题的字也算进「正文字数」**；
- 本机 `var/quality_check.py:59-61` **只数 `<p>`**；
- 移植蓝本 `reference/python/push_draft.py:222` 数的是**全部 blocks（含 h2）**——即云端与蓝本一致，
  **本机自己那份不自洽**（报告含 h2、门禁只算 p）。

同一篇稿子两边差 56-83 字（实测 ab-final 1435 vs 1364）。两处门禁数字相同（1300-2300），
但尺子不同 → 云端门禁实际比本机宽松约 60-80 字。
**量化了改口径的影响：现有 10 篇里 0 篇会翻面**，所以暂不改（改动面大、收益小），仅记录在案。

### 方法论踩坑（值得复用）

**429 被当成「模型产出 0 字」**：温度实验一度测出「T=0.3→1.0 字数单调上升」，
加密 n 后 T=1.0 六次**全部 0 字**。抓原始响应才发现是 `HTTP 429 免费额度限流`
——第一版探针没检查 `resp.ok`，把限流当成了空产出，差点得出「调温度能加字数」的假结论。
**教训：探针必须显式判 `resp.ok` 并对 429 退避重试，否则限流会被静默记成「模型没写」。**

### 同步本机四处（文风改动必须两边一起改）

本机 `quality_check.py` 的脚本名叫**同步**，但它是每天 06:00 真正生产的那条链路，
四处已全部对齐同一套口径：

1. **自动化 `c879a541-…`**（WorkBuddy `workbuddy.db` 的 `automations.prompt`，最硬）：
   篇幅段改写为段落数锚 + 「交稿前自己数 `<p>` 个数」；清掉「至少一节只有 2 段」；
   自检项补「字数不达标先看段落数，段数是因字数是果」。
   写法：断言式替换（命中数不符即抛错），写库后**独立回读校验**（5361 字符、新内容在、旧条已清）。
   写库前备份 `workbuddy.db.bak-20261015-1641`，确认宿主进程未运行；调度 ACTIVE / 06:00 / cwds 均未动。
2. `docs/PIPELINE.md`：同上口径，并注明「本机没有确定性段落重排后处理器」。
3. `config/style_dna.json`：备份 `style_dna.bak-20261015-1633.json` 后同步两条。
4. `var/quality_check.py`：新增 `PARA_TARGET=(17,19)` 与段数提示，
   ⚠️ 该提示是**诊断而非配额**：只在「字数未达标 **且** 段数偏少」时才报，
   且只在长段落占比达标的「新文风」语境下生效。
   （实测：本机新文风自然段数是 18-24 段，若把 17-19 当配额，每篇好稿都会被误念。）

### 验证

- 后端 `tsc --noEmit` 通过
- `smoke:lint` **90 项全过**（新增 7 条）· `smoke:p2` 63 项全过 · `smoke:angles` 30 项全过
- 本机 `quality_check.py` 回归：旧文风 `育儿001` exit 1、新文风 `育儿009` exit 0（与既有约定一致）；
  13 篇全量跑过，**无一篇被段数提示误伤**
- 库未被污染：文章仍 15 篇，孤儿角度仍是既有的 3

### ⚠️⚠️ 事后复核：我这次改动的效果**没有被证明**（务必读完再引用本文上面的数字）

用户追问「你是怎么在没有数据的情况下说数据很低的」，逼出三轮复核，结论**推翻了本文前半部分的因果叙述**：

**1. 分时对比不可用——模型会随时间漂移。**
同一套**改动前**的提示词，06:20 实测均值 1668，10:30 实测 1908（**差 240 字，提示词一字未改**）。
所以我此前报的「修复前 1668 → 修复后 2009」里，**大部分是漂移，不是改动**。

**2. 交错对照（唯一可归因的比法）显示差异不显著。**
把改动前的提示词逐条逆向复现，与新版**交错**跑（共享时间窗），三条独立实验：

| 实验 | 条件 A | 条件 B | 结果 |
|---|---|---|---|
| 精简要求 | 完整 6720 字要求 → 2086 | slim 2658 字 → 1968 | −118，不显著 |
| 极限精简 | 完整 8975 字要求 → 2072 | 极简 **148** 字 → **2311** | **+239**（要求砍掉 98%，反而更长） |
| OLD vs NEW（n=20/臂） | 改动前 → **1981** (σ304) | 改动后 → **1954** (σ391) | **−28，SE ±111，不显著**（95%CI −245~190） |

**「要求太多太长把文章带长」这个假设被否定了**：把要求砍到只剩 148 字（1.6%），文章没有变短。

**3. 锚的服从率很低，且改要求没能移动它。**
模型原始段数实测 12-19（中位 13、均值 14.4），**落在 17-19 锚内的只有 2/10**。
改动前要求 18-21 段、改动后要求 17-19 段，模型实际给的段数 **15.1 → 13.2**（没往要求方向走）。

**4. 原始问题可能本来就被高估。** 全量日志 69 次定向修补里，修补前 <1300 字的只有 **8 次**（约 12%），
且都靠修补救回（911→1354、965→1120、1236→1314…）。**低于 1300 在交错实验中两臂都是 0/20。**

**那到底什么成立？**
- ✅ **明确成立**：清掉了提示词里**算术上无解**的自相矛盾（「每节 6-7 段」vs「至少一节 2 段」；
  主提示词 1800-2200 vs 修补提示词 1300-2300）。这是**正确性问题**，不依赖统计显著性。
- ✅ **明确成立**：新增 `verify:length` 与 7 条冒烟断言，把「旧配额不许回流」钉死。
- ❌ **未被证明**：我改的措辞让字数上升。交错对照说不显著。
- ⚠️ **教训**：**单批 n≈10 的均值/σ 不足以支撑因果结论**，尤其在上游会漂移时。
  唯一可信的比法是**交错 + 足够 n + 报告置信区间**。我前两轮报的「σ 从 399 降到 148」就是这种过度解读。

### 下一步 / 待办

- σ 大（304-391）才是主要问题，而它不是提示词能拧的旋钮（交错实验已证）。
  若真要压 σ，方向是 **`frequency_penalty`/`presence_penalty` 透传**（`llm.ts:151` 目前只传 `top_p`，
  这是 MEMORY 里列了很久的「尚未做」项），或**接受门禁区间**。
- 概率类陈述一律用**实测比例**，不要用正态近似推导值。
  （我曾写「约 3 成落在 1800 以下」，那是 `Φ((1800−均值)/σ)` 算的，实测是 21%。）
- 本机 `quality_check.py` 与本机**报告口径**仍不一致（报告含 h2、门禁只算 p），未改。
- `2-1 studio 生图 event: error`、`/api/*` 裸奔待加鉴权——均未动。

## 2026-10-21 漫画产线对齐本地 skill（知识密度 + 韧性）

把漫画线的创作知识、金句卡与质检判据对齐本机实测的 `quote-comic-illustrator` skill，方案A：TS 原生移植知识，不引入 Python 运行时。

### 已落地（t1–t5、t10）

- **叙事链 6 条**（t1）：`narrativeChains` 从 5 条一句话链升级为 6 链详表，5 个原 key 字节不变、新增 `示范链`；内容压缩自 skill `templates/creative.md`，未凭空创作。
- **金句卡版式**（t2）：`quoteCard` 52/30/系统字体 → **68/46/50/CheeseFont**。
- **创意层注入**（t3）：`buildSystemPrompt` 注入 6 维度 / 11 标题公式 / 金句 5 型 / 两行反转句式 / 末单元三标准（prompt 总长 2513 字，控在 4000 预算内）。
- **两阶段方向 + 风格硬锁**（t4）：`generateCreativeDirections()` 先出 3 方向、自动采纳 `recommended` 组（缺失回落第 1 且 `logger.warn`），再拆脚本；`styleKey` 恒 = `defaultStyle`，`opts.styleKey` 标 `@deprecated`。
- **QC 逐字核对**（t5）：`qcPanelByModel` 注入期望台词逐字比对 + 判定类别；重跑/降级语义不变。
- **奶酪体 + 版本化**（t10）：字体入库 `imaging/assets/cheese-font.ttf`，`@font-face` 走 **data URI**（`file://` 会被 `setContent` 页面拒绝，实测踩过）；`QUOTE_CARD_VERSION=2` → `quote-{seq}-v2.jpg`，旧文件/旧上传态自动失配重生成。

### 验证与两个真实缺陷

- 新增冒烟：`smoke:comic-align`（12/12）、`smoke:comic-qc`（12/12）、`smoke:quote-card`（8/8），均带 fail-capability 反证；既有 9 个冒烟 + `typecheck` 全绿。
- **缺陷1（测试）**：`smoke:comic-qc` 初版断言 `includes('逐字')` 被期望台词自身满足 → 假阳性；改为 QC 指令独有短语 `逐字比对` 后在 fail-cap 下才真正翻转。
- **缺陷2（产品）**：`quote-card.ts` 初版用 `pathToFileURL` 的 `file://` 字体 src，被 `setContent` 页面以 `Not allowed to load local resource` 拒绝、字体静默 fallback（Linux 同理）；改为 base64 data URI 后 `fonts.check('68px CheeseFont')` 方为 true。**这是真机也会坏的 bug，非测试假象。**

### 生图双通道（t6–t9，已完成）

- **判决 = PATH=MCP**：有效 `MODELSCOPE_API_TOKEN` 下，`/gradio_api/mcp/` 的 `initialize` 与 `tools/list` 均实测 HTTP 200（带 `Authorization: Bearer` + `Accept: application/json, text/event-stream`；早前 401/406 结论系缺 token / 缺 Accept 头的测量误差）。详见 `.omo/evidence/task-6-comic-skill-align.md`。
- **t7**：`llm.ts` 新增 `modelscope_qwen_image_mcp` 协议——原生 fetch 的 MCP Streamable HTTP 客户端（`initialize` 多 protocolVersion 回退 → `tools/call`，SSE 解析 `image`/`data URI` 内容，错误归一 `BadRequestError`），零新依赖。
- **t8**：`model-registry.ts` 新增 `comic_panel_fallback` 角色（协议 `modelscope_qwen_image_mcp`）；`setup-local-model.ts` 幂等 seed（连跑两次 models 3→3、bindings 3→3 零新增；env 缺 token 打印 skip 退出 0；`MODELSCOPE_BASE_URL` 可覆盖以便离线验证）。`comic_panel` 主角色白名单刻意不含 MCP 协议（实测 400 拒绝，系预期约束）。
- **t9**：`panels.ts` `generatePanelImage`——主通道失败同一心跳切备选重试一次；双通道失败沿用既有失败语义（`attempt` 仅 +1，无跨心跳新重试环）；未绑定备选时行为与基线逐字节一致。
- **验证**：新增 `smoke:comic-fallback`（12 断言全 PASS，真表驱动 `processComicImages`；fail-cap 禁降级 → 断言翻红 exit 1）；`typecheck` exit 0。
- 隔离 DB 运行冒烟的方式：`DATABASE_URL=file:./var/smoke-comic-*.db` + `prisma db push --schema prisma/schema.sqlite.prisma`（避免碰 dev.db 里真实模型）。


