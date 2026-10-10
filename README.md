# wechat-pipeline-cloud · 公众号自动产销系统（云端版）

把现有 Windows 本机流水线搬上云服务器，做成 Web 管理系统：数据入 MySQL、LLM 模型可配置、
公众号账号可配置、支持在线改稿与手动触发创作推送。

## 新会话接手（先看这里）

本项目的对话应在 **WorkBuddy 空间**下进行：新建任务 → 选择工作空间 → 指向本目录。
换会话后旧对话记忆读不到，上下文靠以下两个文件承载，**开工前先读它们**：

1. `README.md`（本文件）—— 定位、硬约束、技术栈、目录、命令、进度
2. `docs/DEVLOG.md` —— 开发日志，按日期倒序记录了做过什么、下一步、阻塞项

新对话建议开场白：
> 读一下 `README.md` 和 `docs/DEVLOG.md`，然后从当前进度继续（阶段 0–5 与前端骨架均已完成）。

会话结束时**必须追加一条 DEVLOG 记录**，否则下次换会话会失忆。

## 项目定位与边界

| 项 | 说明 |
|---|---|
| 本机流水线 | `K:/WorkBuddy WorkSpace/wechat-pipeline`（**只读参考，禁止修改**） |
| 本项目 | 独立新建，复制其能力并云化 |
| 当前状态 | 并行期：本机 06:00 自动化**继续运行**，云端另行开发，功能验收后再切换 |
| 部署目标 | 云服务器 `/opt/wechat-pipeline/` |

## 四条硬约束（不可违反）

1. **不动现有目录** —— `wechat-pipeline/` 一行不改、一个文件不删，只作为算法与业务逻辑的参考蓝本
2. **工作空间规范** —— 本项目位于 `K:/WorkBuddy WorkSpace/project/<项目名>/`；今后新项目一律放 `project/` 下
3. **并行期不停机** —— 本机流水线继续跑；云端开发期**默认 dry-run 不真推**，避免两边同时写同一草稿箱
4. **密钥数据库化** —— 微信 AppID/Secret、LLM API Key 全部加密入库，**必须有配置界面**增删改查并测试连通

## 技术栈

**后端** Node 22 + TypeScript + Express 4 + Prisma
**数据库** MySQL 8.0（utf8mb4）；本地开发降级为 SQLite
**前端** Vue3 + TypeScript + Element Plus + Vite + Pinia · wangEditor 5

### 两个选型说明

**为什么不用构建工具**：Node 22 原生支持运行 TypeScript（`--experimental-strip-types`），
源码即运行产物，没有 tsc 编译步骤。代价是**相对 import 必须写 `.ts` 后缀**（Node 不会把
`./a.js` 解析成 `a.ts`，实测会 ERR_MODULE_NOT_FOUND）。类型检查仍由 `npm run typecheck` 把关。

**为什么本地用 SQLite**：本机没有 MySQL，而 Prisma 的 `provider` 不支持环境变量切换。
解法是 `npm run schema:sqlite` 从 `prisma/schema.prisma`（MySQL 真源）自动降级生成
`prisma/schema.sqlite.prisma`，只需维护一份 schema。
注意两者共用同一个 client 生成目录，**切回 MySQL 时必须重新 `npm run prisma:generate`**。

> ⚠️ **本地开发必读（踩坑记录）**：`prisma/schema.prisma` 是 MySQL 真源，`gen-sqlite-schema.mjs`
> 会把 `Json` 字段降级成 `String?`、**所有枚举降级成 `String`**（如 `ModelRole`/`JobType`/`CredStatus`
> 在本地客户端里不再是枚举类型）。因此本地**只能用 `npm run schema:sqlite` 生成的 sqlite schema
> 去 `prisma generate`**；若误跑裸 `npx prisma generate`（默认读 mysql schema），客户端会变成 mysql 版，
> 导致 `Json` 字段写对象报 "Expected String"、枚举类型找不到等一连串错误。本地统一约定：
> **JSON 列永远以字符串存取**（本项目用 `src/db-json.ts` 的 `packJson`/`unpackJson` 统一处理）。

## 安全红线

- **群发永不自动**：`AUTO_PUBLISH = false` 是代码层硬常量，publisher 中不存在 masssend 调用；
  DB 里 `setting.auto_publish` 标记 `readonly=1`，界面只读置灰。`/api/health` 会把它暴露出来便于核对。
- **凭据永不外泄**：AES-256-GCM 加密（iv+authTag+ciphertext），API 只返回掩码，日志脱敏；
  主密钥 `APP_SECRET_KEY` 必须是 32 字节 base64，生产放 `/etc/wechat-pipeline/app.env`，`chmod 600`。

## 目录结构

```
server/
  src/
    index.ts        入口
    app.ts          Express 装配（helmet/cors/json/统一错误处理）
    config.ts       环境变量与路径（禁止硬编码绝对路径）
    constants.ts    安全红线与业务硬指标
    logger.ts       pino，控制台+文件双写
    db.ts           Prisma 单例 + 命名锁（MySQL GET_LOCK，SQLite 降级）
    errors.ts       AppError / WechatApiError / CredentialError
    lib/crypto.ts   加密、掩码、占位符识别、脱敏
    services/       业务逻辑（从本机脚本移植）
      dedup.ts      ← add_angles.py 的观点层去重（已移植）
      parse/        ← push_draft.py 的 Extractor（HTML→结构化 blocks + 强调标记）
      render/       ← push_draft.py 的样式拼装（预览与推送共用的唯一渲染函数）
      planner.ts    ← daily_plan.py 的排产（buildPlan + 角度预留 CAS + 触发建稿）
      writer.ts       写作（用「write」角色模型；缺 Key 回退骨架草稿）
      llm.ts          LLM 抽象（chat / 连通测试 / 角色解析）
      emphasis.ts   ← auto_emphasis.py 的强调自动补全（确定性后处理）
      wechat.ts       微信通道（token 缓存 / 素材 / 草稿增删 / 分级重试）
      accounts.ts   ← check_accounts.py 的凭据校验规则
      publisher.ts    推送：手动与自动调度**共用**的同一套草稿箱推送逻辑
      scheduler.ts    自动调度（每日写稿心跳 + 配额幂等 + 可选推送）
      dashboard.ts    仪表盘聚合（区块级容错降级）
    api/routes/     路由
    cli/            migrate.ts（迁移）· inspect.ts（检视）· scheduler.ts（调度守护）
  prisma/schema.prisma           MySQL 真源（数据字典）
  prisma/schema.sqlite.prisma    自动生成，勿手工编辑
  scripts/gen-sqlite-schema.mjs  schema 降级生成器
reference/python/   本机脚本副本，作为移植与对拍基准（只读）
config/             style_dna.json · topic_seeds.json（保留为文件，不入库）
web/                前端（Vue3 + TS + Vite + Element Plus）
  src/api/          http 封装 + 全部接口映射
  src/views/        仪表盘 · 创作计划 · 文章/改稿 · 账号管理 · 模型配置
  src/utils/        展示层格式化（状态/角色/时间）
deploy/             systemd / Nginx（待建）
var/                日志与本地数据库（不入库）
```

## 常用命令

```bash
cd server
npm run typecheck                 # 类型检查
npm run dev                       # 开发启动（热重载）
npm run schema:sqlite             # 生成 SQLite 版 schema
npm run sqlite:push               # 建/同步本地 SQLite 表
node --experimental-strip-types src/cli/migrate.ts --dry-run   # 迁移预检
node --experimental-strip-types src/cli/migrate.ts --apply     # 执行迁移
node --experimental-strip-types src/cli/inspect.ts             # 检视数据库
npm run scheduler                              # 调度守护（常驻，默认 60s 心跳）
npm run scheduler:once                         # 只跑一次（配合 cron/systemd Timer）
npm run scheduler:once -- --force              # 忽略开关与到点，立即补跑一次
```

前端（另一个终端，需后端已在 8787 运行；`/api` 由 Vite 代理转发）：

```bash
cd web
npm install
npm run dev          # http://127.0.0.1:5173
npm run typecheck    # vue-tsc 类型检查
npm run build        # 类型检查 + 打包到 web/dist
```

## 关键业务规则（改造时必须保持）

- 每天每账号 2 篇，配额幂等
- 同赛道多账号**共享赛道级角度池**，取一个少一个（角度抢占用 CAS）
- 观点层去重：与现有选题比 + 与历史标题比 + 同主题堆积上限 8
- 标题自动加 `【话】` 前缀（幂等）
- 凭据门禁：APPID 必须 18 位且 `wx` 开头、SECRET ≥20 位、不含"填入/placeholder/todo/xxx/your_"
- 微信错误码：40164（IP 白名单）**不重试**，直接报出口 IP 与操作指引；
  40001/42001 强制刷 token 重试 1 次；网络类指数退避最多 4 次

## 移植纪律：对拍测试

现有 Python 脚本里的算法是**已跑通并验证过的资产**（去重算法曾踩过坑：初版 bigram Jaccard
漏掉了所有同义改写）。移植到 TS 后必须用同一份输入跑两边比对输出，不一致就说明移植有偏差。
Python 参考实现在 `reference/python/`，用 managed Python 3.13 运行。

## 参考蓝本映射

| 本机脚本 | 本项目去向 | 状态 |
|---|---|---|
| `add_angles.py` | `services/dedup.ts` | ✅ 已移植 |
| `push_draft.py` 的微信接口（token/素材/草稿） | `services/wechat.ts` | ✅ 已移植（curl→fetch+FormData，token 库内缓存，分级重试） |
| `check_accounts.py` 校验规则 | `services/accounts.ts` | ✅ 已移植 |
| 凭据配置 CRUD + 连通测试 | `api/routes/credentials.ts` | ✅ 新增（密文落库 / 掩码返回 / 连通测试自动启用） |
| `push_draft.py` 的 Extractor | `services/parse/` | ✅ 已移植（轻量分词器，忠实复刻 HTMLParser 行为） |
| `push_draft.py` 的样式拼装 | `services/render/` | ✅ 已移植（预览与推送**共用同一函数** renderArticle） |
| `daily_plan.py` | `services/planner.ts` | ✅ 已移植（buildPlan 排产 + reserveAnglesForAccount 预留 CAS + createDraftsForAccount 触发建稿） |
| `auto_emphasis.py` | `services/emphasis.ts` | ✅ 已移植（确定性后处理，不足下限补加粗、红字不足补红字） |
| LLM 调用（chat/completions） | `services/llm.ts` | ✅ 新增（OpenAI 兼容、Key 解密、超时、错误归一、连通测试、角色解析） |
| 模型配置 CRUD + 连通测试 | `api/routes/models.ts` | ✅ 新增（apiKey 加密落库 / 掩码返回 / /test 连通 / 角色绑定 write·revise·cover·expand_angles） |
| 计划产出 + 手动触发 | `api/routes/plans.ts` | ✅ 新增（GET /api/plan 排产、POST /api/plan/trigger 建稿） |
| 强调补全预览 / 应用 | `api/routes/emphasis.ts` | ✅ 新增（POST /api/emphasize 预览、POST /api/emphasize/articles/:id 应用并重渲染） |
| `set_cover.py` 封面上传 | `wechat.uploadImage` 已接入推送 | ✅ 封面上传已接入；`updateCover` 并入发布流程（阶段 6 完善） |
| `pathutil.py` | 废弃 → `config.ts` | ✅ |

## 迁移期必改的硬断点

1. `push_draft.py:47` / `set_cover.py:88` 硬编码 `C:\WINDOWS\system32\curl.exe` → 改原生 fetch + FormData
2. 凭据从 `~/.wechat_accounts/*.env` 文件读取 → 数据库加密存储（**已完成**）
3. 定时从 WorkBuddy 本地客户端调度 → cron/systemd（阶段 5）
4. 云服务器**固定公网 IP 必须加入每个公众号白名单**（40164）
5. 生图从本机 skill 目录 → 直接调 Agnes HTTP API，Key 入库
6. systemd 显式设 `LANG=C.UTF-8 PYTHONUTF8=1`；落盘文件名全部 ASCII

## 迁移结果（2026-10-10）

赛道 5 · 账号 6 · 角度 349（已用 5）· 文章 5 · 设置 3。
三条断链已修复：`育儿-010` 回写已用、`育儿-019/039` 回填 angle_ref（按标题语义消歧）。
**断言「孤儿已用角度」= 0**。账号凭据只有「戏精漫话」为 ok 且启用，其余 5 个为 placeholder 未启用，
待用户在配置界面填写真实值后自动启用。

## 阶段 2 成果（2026-10-10）

完成「凭据配置与微信通道」，可直接通过 API 管理账号凭据并打通微信草稿箱：

- **凭据配置 CRUD + 连通测试** `api/routes/credentials.ts`
  - `GET /api/credentials` 列表（只返回 `secretMask` 掩码，永不泄露明文）
  - `GET /api/credentials/:id` 单账号详情
  - `PUT /api/credentials/:id` 设置 AppID/Secret：格式校验（18 位 wx 开头、≥20 位、非占位）→
    AES-256-GCM 加密落库 `secretEnc` → 按结果自动置 `ok/placeholder/invalid` 与启用状态
  - `POST /api/credentials/:id/test` 连通测试：真实调一次 token 接口；成功→`ok`+启用，
    40164→报出口 IP 与加白指引，其他错误原样返回；占位/缺失账号短路返回，不浪费外网调用
- **微信通道服务** `services/wechat.ts`（移植 `push_draft.py` 微信接口）
  - `getAccessToken`：优先用 `WechatToken` 库内缓存，临期/强制刷新才重拉并加密回写
  - `uploadImage` / `addDraft` / `updateDraft` / `getDraft`：原生 fetch + FormData（去除 curl 硬编码）
  - 按错误码分级重试：`40164` 不重试；`40001/42001` 强制刷 token 后重试一次；网络/`45009` 等指数退避最多 4 次
  - **安全红线**：只写草稿箱，**不含任何群发/masssend 调用**
- **凭据校验** `services/accounts.ts`（移植 `check_accounts.py` 的 `creds_valid`）

验收：13 项内联冒烟断言全部通过（脱敏、校验拒绝、占位短路、密文落库、真实通道优雅报错）。

## 阶段 3 成果（2026-10-10）

完成「渲染与在线改稿」，文章可从 HTML 解析、套微信内联样式、预览、在线改稿、一键推草稿：

- **HTML 解析** `services/parse/index.ts`（移植 `push_draft.py` 的 Extractor）
  - 提取 h1(标题) / h2(小标题) / p(正文)；行内强调 `<strong>` 普通加粗、`<strong class="key">` 品牌红
  - `<span class="num/seq/order/index">` 序号 span **自动跳过**，避免与自动编号重复
  - HTML 实体解码（`&amp;` `&nbsp;` `&#123;` 等）；用控制字符标记强调，渲染阶段再还原
- **渲染（预览=推送唯一函数）** `services/render/index.ts`
  - `renderArticle` 既供 `/preview` 也供 `/push` 调用，**保证后台看到的就是发出去的**
  - 小标题自动编号（01/02…，蓝色斜体），并剥离手写序号防「11 11」
  - 标题统一加 `【话】` 前缀（幂等）；摘要取首段前 54 字（去强调标记）
  - 内联样式：一级 `#111` 加粗、二级品牌红 `rgb(255,76,65)`、容器 17px 字体
- **文章路由** `api/routes/articles.ts`
  - `POST /api/articles` 创建（解析+渲染+落库，返回统计与警告）
  - `GET /api/articles/:id` 读取原始 `contentHtml` 与渲染产物 `contentWechat`
  - `GET /api/articles/:id/preview` 实时重渲染（与存储产物字节级一致，已断言）
  - `PUT /api/articles/:id/content` 在线改稿（保存并重算渲染与统计，改动后推送态回退为草稿）
  - `POST /api/articles/:id/push` 推送草稿：仅当账号 `credStatus==='ok'` 才执行，且**只写草稿箱**；
    封面仅在文件真实存在时上传；失败（40164 白名单 / 40013 凭据错）优雅返回不崩溃

验收：23 项内联冒烟断言全部通过（解析计数、实体解码、序号跳过、强调内联、手写序号剥离、
摘要截断、**预览=存储字节级一致**、在线改稿同步、未绑账号/占位账号推送均被优雅拒绝）。

## 阶段 4 成果（2026-10-10）

完成「模型配置 + 选题规划 + 手动触发 + 强调补全」，创作链路从「配置模型」到「产出草稿」已闭合成环：

- **LLM 抽象层** `services/llm.ts`
  - `chatComplete`：OpenAI 兼容 chat/completions，超时控制；API Key 从库内 `apiKeyEnc` 解密，明文只留内存、不落盘不进日志
  - `testModel`：连通测试（非对话模型给说明；缺 Key 直接失败；否则发极简请求验证可达性）
  - `resolveModelForRole`：按 `ModelBinding` 解析 write/revise/cover/expand_angles 当前绑定模型
- **模型配置路由** `api/routes/models.ts`
  - `GET/POST/GET /:id/PUT /:id/DELETE /api/models`：apiKey 加密落库 `apiKeyEnc`、列表/详情只返 `apiKeyMask` 掩码
  - `POST /api/models/:id/test`：连通测试；`GET /api/models/bindings` + `PUT /api/models/bindings/:role`：角色绑定
  - `GET /api/models/resolve/:role`：供其它路由复用当前角色模型
- **选题规划** `services/planner.ts`（移植 `daily_plan.py` 的 `buildPlan`）
  - `buildPlan`：只排产 `credStatus==='ok'` 且启用的账号；同赛道共享角度池，按日配额排；输出近作供去重、库存告急/欠账扫描
  - `reserveAnglesForAccount`：事务内 CAS 预留角度（先读未用池再标记 used），避免同日重复选题
  - `createDraftsForAccount`：预留→写作→解析→渲染→落库一条龙；记 `TaskRun`；无写作 Key 回退骨架草稿
- **写作服务** `services/writer.ts`：用「write」绑定模型生成；失败/缺 Key 回退骨架（结构完整、待人工补全），流水线不断
- **计划路由** `api/routes/plans.ts`：`GET /api/plan` 产出今日计划；`POST /api/plan/trigger` 选定账号手动建稿
- **强调自动补全** `services/emphasis.ts`（移植 `auto_emphasis.py`）+ 路由 `api/routes/emphasis.ts`
  - 确定性后处理：仅在加粗不足下限（8-12）时补，按句式特征打分挑候选（优先口诀/祈使/判断标准句），绝不重复加粗已强调句
  - `POST /api/emphasize` 预览；`POST /api/emphasize/articles/:id` 应用后**重新解析渲染**，保证 `contentWechat` 与预览一致

验收：19 项内联冒烟断言全部通过（模型 CRUD 掩码、绑定/解析、连通测试优雅失败、计划产出、触发建稿并消耗角度、
无 Key 回退骨架、强调预览补加粗+红字、应用到文章后 contentWechat 重渲染）。

## 阶段 5 成果（2026-10-10）

完成「自动调度 + 仪表盘」，实现了本机 06:00 定时的云化替代方案：

- **发布服务** `services/publisher.ts`（新增，关键抽取）
  - `pushArticleToDraft(articleId)`：手动 `/api/articles/:id/push` 与自动调度**共用同一套**推送逻辑，杜绝两条分支行为分叉
  - 严守红线：只到草稿箱（`addDraft`）、无 masssend；账号非 `ok` 不发外网调用；失败把文章置 `failed` 并优雅返回
  - 每次推送记一条 `TaskRun`（jobType=push），供仪表盘展示流水
- **自动调度** `services/scheduler.ts`
  - 配置落在 `Setting`：`scheduler_enabled` / `scheduler_write_time`(HH:mm) / `scheduler_push_enabled`
  - **并行期默认 dry-run 不真推**（`scheduler_push_enabled` 默认 0），符合项目硬约束第 3 条
  - **幂等靠当日配额而非「跑过没」标记**：某账号当日产出 ≥ 赛道 `quotaPerDay` 时直接返回「今日配额已满」且零副作用，
    所以反复心跳天然安全，进程崩溃重启也不会重复出稿
  - `withLock(LOCK_PLAN)` 防并发重入；心跳结果写 `RunLog`，可观测
  - `npm run scheduler` 常驻；`npm run scheduler:once` 供 cron/systemd Timer 单次触发（`--force` 可忽略开关立即补跑）
- **调度路由** `api/routes/scheduler.ts`：`GET /api/scheduler` 状态+配置+上次心跳 · `PUT /config` ·
  `POST /tick[?force=1]` 手动心跳 · `POST /start|/stop`
- **仪表盘** `services/dashboard.ts` + `api/routes/dashboard.ts`
  - 一个 `GET /api/dashboard` 给出：计数（赛道/账号/角度库存率/文章分状态）、今日配额与逐账号余量、
    欠账、跳过原因、模型与四角色绑定覆盖率、健康（DB/主密钥/**AUTO_PUBLISH 恒 false**/调度开关）、
    最近任务流水与运行日志、最近文章、告警汇总
  - **区块级容错**：任一数据源异常只降级该区块并记入 `degraded`，仪表盘永远打得开（不会变 500）

顺带修掉一个全路由通病：`app.ts` 统一错误处理原先只识别 `AppError`，导致 **zod 参数校验失败被当成 500 内部错误**；
现已单独识别 `ZodError` 并返回 400 + `validation_error` + 字段级 issues，所有接口的错误提示都更准确。

验收：21 项内联冒烟断言全部通过（默认关闭+dry-run、非法时间 400、未启用不干活、force 补跑产出草稿、
**二次补跑零产出且报「今日配额已满」**、默认不推送、新文章已渲染、仪表盘字段完整且 `degraded` 为空、
`AUTO_PUBLISH` 暴露为 false）。

### 前端成果（Vue3 + TS + Vite + Element Plus）

五个页面，全部对接现有后端接口：

| 页面 | 路由 | 能力 |
|---|---|---|
| 仪表盘 | `/` | 统计卡片（今日出稿/就绪账号/角度库存/文章存量）、今日各账号配额进度、系统健康、模型角色绑定、欠账与未排产、任务流水/文章/日志三 Tab |
| 创作计划 | `/plan` | 调度开关+写稿时间+级联推送（保存到 `Setting`）、立即心跳补跑、启停进程内定时器、今日排产表与「立即出稿」、候选角度折叠查看、欠账与告警 |
| 文章 | `/articles` | 列表（状态筛选+分页）、推送草稿箱（二次确认） |
| 在线改稿 | `/articles/:id` | 语义化 HTML 源码编辑 + 快捷工具栏（H2/段落/加粗/品牌红字）、强调补全（预览/应用）、保存即重渲染、右侧微信预览（即推送产物）、推送草稿箱 |
| 账号管理 | `/accounts` | 列表（只显示掩码）、编辑 AppID/Secret/作者、连通测试（占位账号前端短路提示，不打无效外网调用）；旧路径 `/credentials` 保留 301 式跳转 |
| 模型配置 | `/models` | 模型 CRUD（Key 掩码、编辑留空不改）、连通测试、四个角色绑定下拉 |

**关键设计**：改稿页的「微信预览」直接渲染后端的 `contentWechat`，与 `/push` 走同一个渲染函数，
所以界面所见即真正推送的产物——延续阶段 3 的不变量。

**编辑器选型说明**：正文采用**语义化 HTML 源码编辑**而非富文本编辑器。原因是解析器
（`services/parse/index.ts`）只认 `<h1>/<h2>/<p>` 与 `<strong>` / `<strong class="key">`，
而 wangEditor 等富文本产出的是 `<div>` + 内联样式，会破坏这条契约、导致预览与推送产物不一致。
源码编辑 + 实时预览 + 一键插入标签，是更贴合本流水线语义的方案。

验收：`vue-tsc --noEmit` 与 `vite build` 均通过；同进程启动后端 + Vite dev 实测：
首页 200、经 `/api` 代理可正确取到 health / dashboard / articles / credentials 真实数据。

### UI/UX 规范（改动界面时请遵守）

| 维度 | 约定 |
|---|---|
| 设计令牌 | 颜色/间距/圆角/字号集中在 `web/src/styles.css` 的 `:root` 语义变量里（`--wb-*`），组件内不散落色值 |
| 主色 | 品牌绿 `#0a7c47`（由微信绿压深而来），保证白字对比度 ≥ 4.5:1；同步覆盖 Element Plus 的 `--el-color-primary` 系列 |
| 视觉层级 | 页面只设**一个**主入口（仪表盘＝今日出稿进度环），其余为次要指标；卡片默认扁平，不做悬浮滥用 |
| 响应式 | 断点由内容何时需要重排决定：`<992px` 改稿页切「编辑/预览」单栏；`<900px` 表格隐藏 `col-optional` 次要列；`<1180px` 侧边栏自动收起 |
| 异步状态 | 每个列表必须覆盖 加载 / 空 / 错误+重试 / 成功；错误态统一走 `components/StateError.vue` |
| 表单 | 必填项与字段级错误在输入框下方给出（模型配置页），不只弹全局消息 |
| 键盘与无障碍 | 跳转链接「跳到主要内容」、`nav[aria-label]`、仅图标控件带可访问名称、`:focus-visible` 统一描边、尊重 `prefers-reduced-motion` |
| 防丢失 | 改稿页未保存时：离开路由二次确认 + 关闭标签页拦截；`Ctrl/⌘ + S` 保存 |
| URL 状态 | 文章列表的状态筛选与页码放在 query 里，可分享、可返回、刷新不丢失 |

**构建注意**：本机默认堆内存下 `vite build` 会 OOM，`npm run build` 已内置
`node --max-old-space-size=8192`，不要改回裸 `vite build`。

## 开发进度

- [x] 阶段 0 骨架：目录结构 + 项目约定
- [x] 阶段 1 后端骨架 + 数据迁移（349 角度 / 5 文章 / 断言为 0）
- [x] 阶段 2 凭据配置与微信通道
- [x] 阶段 3 渲染与在线改稿
- [x] 阶段 4 模型配置 + 选题与手动触发
- [x] 阶段 5 自动调度与仪表盘
- [x] 前端 Vue3 + TS（配置界面 / 在线改稿 / 预览 / 计划面板 / 仪表盘页）
