# S6-2A · 正式业务库配置与运行时连接身份只读核验

> **性质**：**只读审计**。未修改 `.env` 或任何文件；未重启/停止/启动 8787、5173；未执行 Prisma Migration / `db push` / `migrate dev` / `migrate reset` / `migrate resolve`；未运行 `verify:smoke-iso` / `smoke-isolated` / Fingerprint 脚本；未运行任何写库 Smoke；未调用 LLM / 微信；未执行任何 Git 写操作；未修改业务数据。
>
> **审计时间**：2026-11-18 17:19 → 17:35（GMT+8）
> **Git 基线**：HEAD `e46941e33f5dc941658daf56ad7215999d647986`，分支 `feature/open-source-readiness`，工作区**审计前干净**

---

## 1. 审计环境

| 项 | 值 |
|---|---|
| 平台 | Windows / Git Bash |
| Node | 运行中进程为 v22.22.2（WorkBuddy 内置） |
| MySQL 客户端 | `D:\Soft\MySql\mysql-8.0.30-winx64\bin\mysql.exe`，Ver **8.0.30** |
| MySQL 服务端 | **8.0.30**（`SELECT VERSION()` 实测） |
| Prisma Client | 5.22.0（日志中 `clientVersion`） |
| 凭据使用方式 | 从 `server/.env` 解析后写入 `var/tmp/s62a/my.cnf`（**已被 `.gitignore:13` 覆盖**），审计结束**已删除** |

> 审计全程**未打印、未回显**任何密码、完整连接串或 API Key。报告仅给 host / port / database / username / 密码是否已配置。

---

## 2. `.env` 当前配置摘要（脱敏）

文件：`server/.env`（689 字节，mtime **2026-11-18 15:34:28**）

| 键 | 值 |
|---|---|
| `DATABASE_URL` | scheme=`mysql`，host=`127.0.0.1`，port=`3306`，database=**`wechat_pipeline`**，user=`wpc_app`，password=**已配置**，无额外参数 |
| `SHADOW_DATABASE_URL` | scheme=`mysql`，host=`127.0.0.1`，port=`3306`，database=**`wechat_pipeline`** ⚠️，user=`wpc_app`，password=**已配置** |
| `PORT` | `8787` |
| `LOG_LEVEL` | `debug` |
| `NODE_ENV` | `development` |
| `ADMIN_PASSWORD` | **已配置**（长度 5） |
| `APP_SECRET_KEY` | **已配置**（长度 44，base64 32 字节） |

### 2.1 ✅ A-1：`DATABASE_URL` 确实指向正式业务库

**确认结果：指向 `wechat_pipeline`**，不再是 `wechat_pipeline_smoke`。S6-0 §P1-① 所指的问题**已由用户手工修复**。

### 2.2 ⚠️ A-2：`SHADOW_DATABASE_URL` 与 `DATABASE_URL` 完全相同（新发现问题）

两个键的 `rawLen` 均为 **78**，且库名段都是 `wechat_pipeline`——**指向同一个库**。

**这是严重安全隐患**，理由：

| 场景 | 后果 |
|---|---|
| `npm run prisma:migrate`（= `prisma migrate dev`） | **`prisma migrate dev` 的主要操作目标是 `DATABASE_URL` 指向的数据库**：它会把尚未应用的迁移应用到该库，并检查其 Schema 与 Migration 历史。**Shadow Database 是辅助工作区**（不是主要操作目标）：Prisma 在其中重放已有迁移历史以检测开发库的 Schema Drift、生成新迁移并评估潜在数据丢失风险；若发现 Drift 或 Migration History Conflict，命令**可能要求重置 `DATABASE_URL` 指向的数据库**。S6-2A 审计时两个 URL 恰好指向同一数据库，属严重的连接配置错误，但**不能将其描述为"清空 Shadow 就必然清空业务库"**。Shadow 与正式库分离，也**不意味着**在正式库上执行 `migrate dev` 就安全 |
| `prisma migrate reset` | 即使不用 shadow 也会清库，叠加此配置风险倍增 |
| 当前状态 | 尚未造成损害——因为**从未在本机跑过 `migrate dev`**（见 §5 迁移记录，全部为 `migrate deploy` 或历史初始化） |

**正确做法**（未实施，仅建议）：`SHADOW_DATABASE_URL` 应指向独立的 `wechat_pipeline_shadow`（该库**已存在**，见 §5.3）。

> **⚠️ 时点与机制说明（后续核对补充）**：上表描述的是 **S6-2A 审计时两个 URL 指向同一库（`wechat_pipeline`）的历史配置**，该状态已在 S6-2B-1 修复。
>
> 另需澄清 `migrate dev` 的机制：它的**主要操作目标是 `DATABASE_URL` 指向的数据库**，会把尚未应用的迁移应用到该库；**Shadow Database 只是辅助工作区，不是主要操作目标**——Prisma 在其中重放已有迁移历史以检测开发库 Schema Drift、生成新迁移并评估潜在数据丢失风险。若发现 Drift 或 Migration History Conflict，命令**可能要求重置 `DATABASE_URL` 指向的库**。因此**即使两个 URL 已分离**，只要 `DATABASE_URL` 仍指向有真实数据的正式业务库，执行 `prisma migrate dev` 就仍存在**不可接受的风险**（可能要求重置正式库），必须禁止——**Shadow 分离不等于在正式库上执行 migrate dev 就安全**。

### 2.3 ✅ A-3：Prisma datasource 正确引用环境变量

`server/prisma/schema.prisma:14-18`：

```prisma
datasource db {
  provider          = "mysql"
  url               = env("DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}
```

✅ 无硬编码连接串，全部走 `env()`。

### 2.4 ✅ A-4：`.env` 受 Git 忽略保护

```
.gitignore:8:*.env    server/.env
```

`git ls-files --error-unmatch server/.env` → **UNTRACKED（安全）**。`server/` 下仅有 `.env` 与 `.env.example`，**无 `.env.local` / `.env.production` 等覆盖文件**，项目根也无 env 文件。

---

## 3. 服务状态

### 3.1 ⚠️ B-1：8787 与 5173 **当前均已停止**

```
netstat -ano | grep LISTENING | grep -E ":8787|:5173"   → （空）
```

| 服务 | 状态 |
|---|---|
| 8787 后端 | **未运行**（无监听） |
| 5173 前端 | **未运行**（无监听） |

`tasklist` 中 3 个 `node.exe` 经 PowerShell `Win32_Process` 核验，**均为 WorkBuddy 自身工具进程**（sheetagent MCP、weixinpay 插件、内置 node 运行时），**无一为项目服务**：

| PID | 启动时间 | 命令特征 | 判定 |
|---|---|---|---|
| 9384 | 15:20:38 | `.workbuddy\binaries\node\...` | WorkBuddy 运行时 |
| 22556 | 16:47:17 | `.workbuddy\plugins\cache\...weixinpa...` | 微信支付插件 |
| 27184 | 16:47:21 | `...workbuddy-sheetagent...mcp\start.mjs` | 表格 MCP |

> 因此**无法**对"运行中进程持有的环境变量"做实时读取（进程已不存在）。但**历史日志提供了同等强度的证据**，见 §4。

---

## 4. 8787 进程实际数据库身份核验

虽然进程已退出，但 `var/logs/app-2026-11-18.log`（39,017 字节，最后写入 17:18）完整记录了今日运行轨迹。

### 4.1 今日两次启动（**关键**）

```
07:32:13.774Z  服务已启动 http://localhost:8787  (pid 5172)
07:34:39.598Z  收到 SIGINT，正在关闭
07:34:47.982Z  服务已启动 http://localhost:8787  (pid 23300)
09:18:19.676Z  收到 SIGINT，正在关闭
```

换算为本地时间（UTC+8）：

| 本地时间 | 事件 |
|---|---|
| **15:32:13** | pid **5172** 启动 |
| **15:34:28** | **`.env` 被修改**（mtime） |
| **15:34:39** | pid 5172 收到 SIGINT 关闭 |
| **15:34:47** | pid **23300** 启动（**晚于 `.env` 修改 19 秒**） |
| **17:18:19** | pid 23300 收到 SIGINT 关闭 |

### 4.2 ✅ B-2：pid 5172 连的是**空库**（实证，非推断）

pid 5172 启动后的 5–32 秒内，日志连续 3 次报同一错误：

```json
{"level":50,"time":"2026-11-18T07:32:18.385Z",
 "err":{"code":"P2021",
        "message":"Invalid `prisma.user.findUnique()` invocation:
                   The table `user` does not exist in the current database.",
        "meta":{"modelName":"User","table":"user"}},
 "msg":"未处理异常"}
```

- 首次：`07:32:18.385Z`，末次：`07:32:45.804Z`，共 **3 次**
- 报错内容：**`user` 表不存在**

**这直接证明 pid 5172 连的库没有 `user` 表**。而实测：

| 库 | `user` 表 | 表总数 |
|---|---|---|
| `wechat_pipeline` | ✅ 存在 | 18 |
| `wechat_pipeline_smoke` | ❌ **不存在**（0 张表） | **0** |

→ **pid 5172 连接的是 `wechat_pipeline_smoke`（空库）**，即修改前的配置。

### 4.3 ✅ B-3：pid 23300 连的是**正式库**（双证据闭环）

**证据一：P2021 消失**

按日志顺序切片 `07:34:47.982Z` 之后的全部内容，`P2021` 出现 **0 次**——`user` 表可访问了。

**证据二：正式库 `usersession` 行与日志登录成功精确对应**

| 来源 | 时间 | 事件 |
|---|---|---|
| 日志 | `2026-11-18T07:34:51.013Z` | `POST /api/auth/login -> 200 (438ms)` |
| 正式库 `usersession` | `2026-11-18 07:34:50.834` | 新建 session `CfyrT9TlvtmiB94...`，`userId=1` |

两者相差 **0.179 秒**，完全符合"登录时先 `prisma.userSession.create()` 落库（`auth.ts:95`），再返回 200"的代码路径。

→ **该 session 行只存在于 `wechat_pipeline` 正式库**（Smoke 库 0 张表，不可能写入）。
→ **pid 23300 确实连接 `wechat_pipeline`。**

### 4.4 时间线结论

| pid | 启动（本地） | 相对 `.env` 修改（15:34:28） | 连接库 | 判定依据 |
|---|---|---|---|---|
| 5172 | 15:32:13 | **早 2 分 15 秒** | `wechat_pipeline_smoke`（空库） | P2021 `user` 表不存在 ×3 |
| 23300 | 15:34:47 | **晚 19 秒** | `wechat_pipeline`（正式库） | P2021 消失 + session 行时间精确对应 |

> **你的原始疑问已得到实证回答**："当前 8787 服务是否仍使用修改前的 Smoke 库连接？" ——
> **曾用过（pid 5172，15:32:13–15:34:39），但那之后已重启，pid 23300 用的是正式库**。现在两个进程都已退出。

---

## 5. 数据库身份与 Migration 状态

### 5.1 ✅ C-1：正式库 `wechat_pipeline`

```sql
SELECT DATABASE(), CURRENT_USER(), VERSION();
```

| db_name | db_user | mysql_version |
|---|---|---|
| `wechat_pipeline` | `wpc_app@127.0.0.1` | **8.0.30** |

### 5.2 ✅ C-2：正式库 Migration —— **4/4 完整，与本地文件逐一对应**

| 本地 `server/prisma/migrations/` | 正式库 `_prisma_migrations` | 状态 | 完成时间 |
|---|---|---|---|
| `20261113145706_init` | 同名 | applied（`rolled_back_at=NULL`, `steps=1`） | 2026-11-14 02:57:35 |
| `20261114035440_add_missing_enum_values` | 同名 | applied（steps=1） | 2026-11-14 03:55:05 |
| `20261114093000_add_angle_status_topic_review` | 同名 | applied（steps=1） | 2026-11-14 11:56:30 |
| `20261116120000_add_article_lint_run` | 同名 | applied（steps=1） | 2026-11-17 01:58:07 |

> 另有 1 条历史失败记录：`20261113145706_init` 于 `2026-11-14 01:59:48` 被 `rolled_back`（`steps=0`），随后成功重放。属初始化期正常波折，**不影响当前状态**。

**关键确认：`20261116120000_add_article_lint_run` 已应用。**

### 5.3 ✅ C-3：`ArticleLintRun` 表存在

```sql
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
WHERE TABLE_SCHEMA='wechat_pipeline' AND TABLE_NAME='ArticleLintRun';
```

| TABLE_NAME | TABLE_ROWS |
|---|---|
| `articlelintrun` | 0 |

表**已创建**（0 行，符合"留痕表尚无记录"的预期）。**S6-0 曾记录该表 absent，现已部署到位。**

### 5.4 ✅ C-4：Smoke 库 `wechat_pipeline_smoke` —— **空库，无迁移表**

| 检查项 | 结果 |
|---|---|
| 身份 | `wechat_pipeline_smoke` / `wpc_app@127.0.0.1` / 8.0.30（可连接） |
| 表总数 | **0** |
| `_prisma_migrations` | **不存在**（`ERROR 1146 Table '..._prisma_migrations' doesn't exist`） |

**这符合 T0 隔离设计**：Smoke 库是"每次跑前重建、跑后清空"的一次性库，当前处于**已清空**状态。

### 5.5 shadow 库 `wechat_pipeline_shadow`

| 检查项 | 结果 |
|---|---|
| 身份 | `wechat_pipeline_shadow` / `wpc_app@127.0.0.1`（可连接） |
| 表总数 | **15** |
| 表清单 | account, angle, article, comicpanel, llmmodel, modelbinding, runlog, setting, styleprompt, taskrun, track, trackpipeline, user, usersession, wechattoken |
| `_prisma_migrations` | **不存在** |

> 15 张表但无迁移表 → 该库是**历史遗留的影子库**（可能由早期 SQLite→MySQL 阶段或某次手工建库产生），**本审计时尚未被任何配置引用**（当时 `.env` 的 shadow 指向了正式库，见 §2.2）。**此后已在 S6-2B-1 修复并被引用**（见 §5.6 时序说明）。
>
> 若按 §2.2 建议修复，可将 `SHADOW_DATABASE_URL` 指向此库——但它已有 15 张表，Prisma 会自行清空重建，**需人工确认后**再改。
>
> *（后续核对补充：上述为 S6-2A 当时的建议语。该修复已于 **S6-2B-1** 实际执行，`SHADOW_DATABASE_URL` 现已指向本库。该库 15 张表的行数查询结果均显示为 0，其中 6 张通过 `COUNT(*)` 精确核验，另外 9 张仅通过 `information_schema.TABLE_ROWS` 获取估算值；未发现存量数据，但不能据此表述为 15 张表均已精确核验。）*

### 5.6 三个库对照总表

| 库 | 表数 | `_prisma_migrations` | 迁移版本 | `ArticleLintRun` | 用途 |
|---|---|---|---|---|---|
| `wechat_pipeline` | **18** | ✅ 存在（4 条 applied） | **4/4 完整** | ✅ 存在（0 行） | **正式业务库** |
| `wechat_pipeline_smoke` | **0** | ❌ 不存在 | — | ❌ 不存在 | 冒烟隔离库（已清空） |
| `wechat_pipeline_shadow` | **15** | ❌ 不存在 | — | ❌ 不存在 | 历史遗留影子库（**本审计时未被引用；S6-2B-1 后已成为 Prisma Shadow 库**，见时序说明） |

> **时序说明（后续核对补充）**：上表"未被引用"指**本审计时刻**——当时 `SHADOW_DATABASE_URL` 与 `DATABASE_URL` 同指 `wechat_pipeline`（§2.2 的 P0）。该 P0 已在 **S6-2B-1** 由用户修复为 `SHADOW_DATABASE_URL → wechat_pipeline_shadow`，此后该库**已成为 Prisma shadow 库并被引用**。本行描述的库名称与表数仍然准确，仅"未被引用"的时态已变，故在此注明而不改写原始记录。
>
> 另：表中"4 条 applied"指 `_prisma_migrations` 中 `rolled_back_at IS NULL` 的记录数；表内实际共 **5 行**（含 1 条 2026-11-14 的历史回滚记录）。

### 5.7 正式库各表行数（`COUNT(*)` 精确值）

| 表 | 行数 | 备注 |
|---|---|---|
| `llmmodel` | **4** | 有数据 |
| `styleprompt` | **44** | 有数据 |
| `setting` | **16** | 有数据 |
| `user` | **1** | 管理员 |
| `modelbinding` | **7** | 有数据 |
| `usersession` | **2** | 含 §4.3 的新会话 |
| `account` / `angle` / `article` / `articlelintrun` / `comicpanel` / `runlog` / `taskrun` / `topicreview` / `track` / `trackpipeline` / `wechattoken` | **0** | 空 |

> 与 S5-3B-2（2026-11-17 09:58）基线一致，唯一增量是 `usersession` 1→2。**佐证：迁移后业务库未被污染。**
> ⚠️ `information_schema.TABLE_ROWS` 是估算值（如 `usersession` 估 1、实 2），本表已用 `COUNT(*)` 复核。

---

## 6. 代码与配置一致性

| 检查点 | 结果 |
|---|---|
| `schema.prisma` datasource | ✅ `provider="mysql"`，`url=env("DATABASE_URL")`，`shadowDatabaseUrl=env("SHADOW_DATABASE_URL")` |
| `.env` 与 datasource 键名 | ✅ 完全匹配 |
| 环境变量加载 | ✅ `server/src/config.ts:13` 顶层 `import 'dotenv/config'` |
| 加载时序 | ✅ `index.ts` → `app.ts:10` → `config.ts`（dotenv 执行）→ 之后各路由 `import db.ts` → `new PrismaClient()`。**dotenv 先于 PrismaClient 构造** |
| Shell 环境干扰 | ✅ 当前 shell **无** `DATABASE_URL`，故 dotenv 会从 `.env` 加载（若 shell 已有，dotenv 不覆盖——这是标准行为） |
| `db.ts` 是否覆盖连接串 | ✅ 否。`new PrismaClient({ log: ['warn','error'] })`，**无 `datasources` 覆盖**，全走 schema 的 `env()` |
| 其他 env 覆盖文件 | ✅ 无（仅 `.env` + `.env.example`） |

**结论：应用运行时确实加载 `server/.env`；环境变量在进程启动时读取并缓存于 `process.env`，进程生命周期内**不会**因文件变更而刷新。**

> 这正是 §4.4 时间线成立的机制基础：改 `.env` 后**必须重启**才生效。pid 5172（改前启动）连空库、pid 23300（改后启动）连正式库，完全符合这一机制。

---

## 7. 已确认事实 / 无法确认事项

### 7.1 ✅ 已确认（有直接证据）

| # | 事实 | 证据强度 |
|---|---|---|
| 1 | `.env` 的 `DATABASE_URL` 指向 `wechat_pipeline` | 直接读取文件 + URL 解析 |
| 2 | `SHADOW_DATABASE_URL` 也指向 `wechat_pipeline`（**误配**） | 同上，两键 rawLen 均 78 |
| 3 | `.env` 未被 Git 跟踪、受 `*.env` 忽略 | `git check-ignore` + `git ls-files` |
| 4 | 8787 / 5173 当前**均未运行** | `netstat` 无监听 + PowerShell 进程核验 |
| 5 | pid 5172（15:32:13 启动）连**空库** | 日志 P2021 `user` 表不存在 ×3 |
| 6 | pid 23300（15:34:47 启动）连**正式库** | P2021 消失 + session 行时间差 0.179s 精确对应 |
| 7 | 服务启动（15:34:47）**晚于** `.env` 修改（15:34:28） | 日志时间戳 + 文件 mtime |
| 8 | 两个进程均已于 17:18:19 前退出 | 日志 SIGINT + 无监听 |
| 9 | 正式库 Migration **4/4 完整**，与本地文件逐一对应 | `_prisma_migrations` 查询 |
| 10 | `ArticleLintRun` 表**已存在** | `information_schema` 查询 |
| 11 | Smoke 库**0 张表**、无迁移表 | `information_schema` 计数 = 0 |
| 12 | **S6-2A 审计时**，shadow 库 15 张表、无迁移表，**尚未被任何配置引用**；后经 S6-2B-1 修复，`SHADOW_DATABASE_URL` 已指向 `wechat_pipeline_shadow`，**现已作为 Prisma Shadow 库使用** | `information_schema` + `.env` 解析（S6-2A 时点）<br>时序变更见 S6-2B-1 |
| 13 | 正式库数据量与 S5-3B-2 基线一致（仅 usersession +1） | `COUNT(*)` 实测 |
| 14 | `dotenv` 在 `PrismaClient` 构造前执行 | 源码 import 链核对 |

### 7.2 ⚠️ 无法确认（明确标注，不推断）

| # | 事项 | 原因 |
|---|---|---|
| 1 | **进程运行时 `process.env` 的实际值** | 进程已退出，无法 attach 或读取 `/proc`；仅能由日志行为反推 |
| 2 | **pid 23300 是否在 17:18 之前发生过再次切换** | 日志中仅 2 次"服务已启动"，**无第三次**，故判定未切换；但日志若被外部截断则无法排除 |
| 3 | `.env` 修改前的原始值 | 未保留历史副本；仅能推断为 `wechat_pipeline_smoke`（由 P2021 反推） |
| 4 | `wechat_pipeline_shadow` 15 张表的创建来源 | 无迁移表、无文档记录，无法确定何时/由谁创建 |
| 5 | `/api/scheduler` 的 `pushIntent` 真实取值 | **未调用任何 API**（8787 已停，且需登录会话）。继承 S6-0 / S5-UI-6-2 的未验证状态 |
| 6 | `ADMIN_PASSWORD` 长度仅 5 | 仅知长度，无法判断是否为弱口令（不读取明文） |

---

## 8. 风险分级

| 级别 | 问题 | 证据 | 影响 | 建议阶段 |
|---|---|---|---|---|
| **P0** | **`SHADOW_DATABASE_URL` 与 `DATABASE_URL` 指向同一业务库** | `.env` 两键 rawLen 均 78、库名均 `wechat_pipeline` | 连接配置错误：Shadow 辅助库被误配成了正式库。**机制上**，`migrate dev` 的主要目标是 `DATABASE_URL` 指向的库（将未应用迁移应用到该库，并在发现 Drift / Migration History Conflict 时可能要求重置它）；Shadow Database 只是辅助工作区——重放迁移历史检测 Drift、生成新迁移、评估数据丢失风险，**不是主要操作目标**。两个 URL 同指的后果是**正式库同时承担了"开发库"与"Shadow 辅助库"双重角色**，一旦执行 `migrate dev` 即把正式库直接暴露给重置风险 | **S6-2B 立即修** |
| **P0** | `prisma:migrate` 脚本本身指向 `migrate dev` | `server/package.json`：`"prisma:migrate": "prisma migrate dev"` | 与上一条叠加：任何人（含未来的 agent）按 README 跑此脚本都会撞上 | S6-2B |
| **P2** | `wechat_pipeline_shadow` 15 张遗留表来源不明 | 有表无迁移记录 | 若被误用作 shadow，Prisma 会 DROP 重建（但那是它的正常用途）；若被误认为正式库则危险 | 待人工确认后清理 |
| **P2** | `ADMIN_PASSWORD` 仅 5 字符 | `.env` 长度检查 | 弱口令风险（本机开发环境，风险有限） | 上线前 |
| **P3** | `LOG_LEVEL=debug` | `.env` | 生产环境日志量大、可能含敏感上下文 | 上线前改 `info` |
| **P4** | shadow 库命名与 `_shadow` 约定不一致 | 实际为 `wechat_pipeline_shadow`，与计划文档 `wechat_pipeline_shadow` 一致，无问题 | — | — |

> **本轮最重要发现是 2 个 P0**，都与"shadow 指向业务库 + `migrate dev` 脚本在 package.json 里"叠加有关。**它没有在本轮造成损害**（迁移记录显示全部为成功 applied，无重建痕迹），但**下一次误操作就是灾难**。
>
> **⚠️ 时点说明（后续核对补充）**：上表第 1 个 P0 描述的是 **S6-2A 审计时两个 URL 指向同一个库（`wechat_pipeline`）的历史配置状态**。该状态已在 **S6-2B-1** 修复——`SHADOW_DATABASE_URL` 现指向独立的 `wechat_pipeline_shadow`，**当前配置下两个 URL 已不相同**。
>
> 但**第 2 个 P0（`prisma:migrate` = `migrate dev`）并未因此解除**：`migrate dev` 的主要目标是 **`DATABASE_URL` 指向的数据库**——将未应用迁移应用到该库，并在发现 Schema Drift 或 Migration History Conflict 时**可能要求重置该库**；Shadow Database 只是辅助工作区（重放迁移历史检测 Drift、生成新迁移、评估数据丢失风险），不是主要目标。当前 `DATABASE_URL` 仍指向有真实数据的正式业务库 `wechat_pipeline`，**Shadow 与正式库分离并不意味着在正式库上执行 `migrate dev` 就安全**，因此**在当前配置下仍禁止执行 `prisma migrate dev`**，正式库迁移只允许 `prisma migrate deploy`，且须由 S6-4 补命令级护栏。

---

## 9. 是否建议重启 8787

### 建议：**需要重启，但不必现在立刻做**

| 判断维度 | 结论 |
|---|---|
| 技术上是否需要重启 | **需要**。`.env` 改动只对新进程生效；旧 pid 23300 已退出，下次启动会自动读取新配置 |
| 是否"已确认连正式库" | **旧进程（pid 23300）已被日志+数据双重证明连正式库**。所以**不是"当前服务连错库"的状态** |
| 当前是否有服务在跑 | **没有**。8787/5173 均已停止，不存在"服务仍在用旧配置"的情况 |
| 是否必须由本轮重启 | **否**。本轮禁止启停服务；且现在没有服务需要"改正" |

**结论**：不存在"正在跑的服务连错库"这一问题——因为它已在 15:34:47 重启过一次并连对了库，然后于 17:18 正常退出。下次启动时**天然**会使用当前 `.env`（指向 `wechat_pipeline`）。

**但强烈建议：在修复 `SHADOW_DATABASE_URL` 之后再启动**（见 §10）。**注意：修复 Shadow URL 只消除"shadow 指向业务库"这一项，并不使 `migrate dev` 变安全**——`migrate dev` 仍会作用于 `DATABASE_URL` 指向的正式库并可能要求重置它，因此在正式库配置下始终禁止执行。

---

## 10. 下一步建议

### 优先级 1（阻塞级，建议 S6-2B）

1. **修 `SHADOW_DATABASE_URL`**：改为独立库（如 `wechat_pipeline_shadow`），**不要**等于 `DATABASE_URL`。
   - ⚠️ 注意：`wechat_pipeline_shadow` 现有 15 张遗留表，Prisma 使用时会**清空重建**它——这是 shadow 库的正常用途，但需人工确认这 15 张表可丢弃。
   - 若不能确认，**另建** `wechat_pipeline_shadow2` 之类专用库更安全。
2. **给 `prisma:migrate` 加护栏**：该脚本 = `migrate dev`，是最危险命令。**文档提醒不足，必须做命令级护栏**（如：重命名脚本、加前置校验脚本，在 `DATABASE_URL` 指向业务库时直接拒绝执行）。仅修 Shadow URL **不能**解除此项——`migrate dev` 仍会作用于 `DATABASE_URL` 并可能要求重置正式库。

### 优先级 2（S6-3 前置）

3. **启动 8787 并用真实会话确认连接身份**：这是唯一能把 §7.2 第 1 项（进程实际 env）从"无法确认"变为"已确认"的方法。可配合 `GET /api/health`（返回 `autoPublish` 等）+ 一个只读接口。
4. **补 `/api/scheduler` 的 `pushIntent` 真实 E2E**：S6-0 与 S5-UI-6-2 都遗留此项。

### 优先级 3（S6-4 文档）

5. 更新 `deploy/README.md` 的迁移基线说明（S6-0 已登记 P2）。
6. 明确 `wechat_pipeline_shadow` 的归属与用途，或清理后写进文档。

---

## 11. 本轮未执行的验证（明确声明）

| 未执行项 | 原因 |
|---|---|
| 启动 / 停止 / 重启 8787、5173 | 任务边界明确禁止 |
| Prisma Migration 任何子命令 | 明确禁止 |
| `migrate dev` / `db push` / `migrate reset` / `migrate resolve` | 明确禁止 |
| `verify:smoke-iso` / `smoke-isolated` / Fingerprint 脚本 | 明确禁止 |
| 任何 `smoke:*` / `verify:*` | 明确禁止（会写库） |
| 调用任何 API（含 GET） | 8787 已停；本轮**未启动服务**，故无 API 可调 |
| `/api/scheduler` 的 `pushIntent` E2E | 同上，**仍未验证**（继承 S6-0 / S5-UI-6-2 状态） |
| LLM / 微信接口 | 明确禁止 |
| Git 写操作 | 明确禁止 |
| 修改 `.env` 或任何文件 | 明确禁止 |

### 本轮实际执行的只读操作

```
文件读取：server/.env（解析后仅输出脱敏摘要）、schema.prisma、config.ts、db.ts、app.ts、index.ts
git 只读：rev-parse / log / status / check-ignore / ls-files
进程：netstat（只读）、PowerShell Win32_Process（只读）
数据库（只读）：SELECT / SHOW / information_schema 查询，无任何 INSERT/UPDATE/DELETE/DDL
日志：读取 var/logs/app-2026-11-18.log
```

> **临时凭据文件 `var/tmp/s62a/my.cnf` 已在审计结束时删除**，工作区恢复干净（`git status --short` 空）。
> 全程**未输出任何密码、完整连接串或 API Key**。

---

## 12. 一句话总结

**配置已正确指向 `wechat_pipeline`，运行服务也已被日志与数据双重证明连接正式库，正式库迁移 4/4 完整、`ArticleLintRun` 已就位；但发现两个独立但相关的高危问题：① S6-2A 审计时 `SHADOW_DATABASE_URL` 与 `DATABASE_URL` 指向同一个正式业务库，该连接配置错误已在 S6-2B-1 修复；② `package.json` 中的 `prisma:migrate` 仍指向 `prisma migrate dev`。该命令的主要目标是 `DATABASE_URL` 指向的数据库（将未应用迁移应用到该库，发现 Schema Drift 或 Migration History Conflict 时可能要求重置它），Shadow Database 仅为辅助工作区（重放迁移历史检测 Drift、生成新迁移、评估数据丢失风险），并非主要操作目标；当前 `DATABASE_URL` 仍指向有真实数据的正式业务库，因此 Shadow 与正式库分离并不意味着执行该命令就安全，仍可能因 Drift 或迁移历史冲突而要求重置正式库。第二项风险并未因 Shadow URL 分离而解除，必须在 S6-4 增加命令级护栏。正式业务库 Migration 部署只允许使用 `prisma migrate deploy`。**