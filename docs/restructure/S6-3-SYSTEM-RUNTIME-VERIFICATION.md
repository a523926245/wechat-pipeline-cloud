# S6-3 · 系统真实运行验证与交付回归

> **性质**：**真实运行验证**。本轮实际启动了后端（8787）与前端（5173），用真实 admin 会话请求真实接口，用 headless Chrome 访问真实前端并读取真实正式库数据。**全程无 Mock、无夹具、无伪造数据。**
>
> **验证时间**：2026-11-18 19:55 → 20:30（GMT+8）
> **结果**：**核心真实运行链路 PASS，可关闭 S6-3**。但不代表所有角色、业务数据状态及推送意图分支均完成真实 E2E——未验证项目见 §C.5 与 §F，继续保留为后续事项（建议并入 S6-5）。

---

## A. 环境与 Git 基线

| 项 | 值 |
|---|---|
| 分支 | `feature/open-source-readiness` |
| HEAD | `e46941e33f5dc941658daf56ad7215999d647986` |
| 工作区（验证前） | 仅 2 个未跟踪报告（S6-2A、S6-2B-1），**无用户未提交代码改动** |
| Node | **v22.22.2** |
| npm | 11.19.1 |
| MySQL 客户端 / 服务端 | 8.0.30 / **8.0.30** |
| Prisma Client | 5.22.0 |
| 验证前端口 8787 / 5173 | **均无监听**（无用户服务占用） |

### A.1 服务启动与停止

| 服务 | 启动命令 | PID | 端口 | 状态 |
|---|---|---|---|---|
| 后端 | `npm run dev`（`node --experimental-strip-types --watch src/index.ts`） | 26732 → 18228（watch 重启） | 8787 | **已停止** |
| 前端 | `npm run dev`（`vite`） | 26716 / 13924 | 5173 | **已停止** |

启动日志：

```
后端: {"level":30,"time":"2026-11-18T11:57:57.839Z","msg":"服务已启动 http://localhost:8787  (pid 26732)"}
前端: VITE v5.4.21  ready in 7699 ms   ➜  Local: http://127.0.0.1:5173/
```

**停止后核验**：`netstat` 确认 8787 / 5173 / 9451 **全部无监听**；残留 node 进程经 `Win32_Process` 逐个核验，**均非本项目**（3 个 WorkBuddy 工具进程 + 3 个 `K:\deepseek-harness\wx-task-pocket` 用户其他项目进程，未干预）。

---

## B. 数据库连接

### B.1 两个 URL 的脱敏目标库

| 键 | host | port | database | user | 密码 |
|---|---|---|---|---|---|
| `DATABASE_URL` | 127.0.0.1 | 3306 | **`wechat_pipeline`** | `wpc_app` | 已配置 |
| `SHADOW_DATABASE_URL` | 127.0.0.1 | 3306 | **`wechat_pipeline_shadow`** | `wpc_app` | 已配置 |

Prisma Schema：`provider="mysql"`，`url=env("DATABASE_URL")`，`shadowDatabaseUrl=env("SHADOW_DATABASE_URL")`。**未修改 `.env`。**

### B.2 ✅ 运行时数据库身份（**PASS**）

这是本轮最关键的一项。**不是从 `.env` 推断**，而是两个方向同时实证：

**方向一：后端自证（HTTP 响应）**

```json
GET /api/health -> 200
{"ok":true,"env":"development","db":"up","driver":"mysql","autoPublish":false}
```

**方向二：从 MySQL 侧观测后端进程持有的连接（决定性证据）**

```sql
SELECT ID, DB, COMMAND FROM information_schema.PROCESSLIST WHERE USER='wpc_app' AND DB IS NOT NULL;
```

| ID | DB | COMMAND |
|---|---|---|
| 110–118（共 9 个连接池连接） | **`wechat_pipeline`** | Sleep |

→ **后端进程的连接池实际落在 `wechat_pipeline`，运行时身份确认。**

（`CURRENT_USER()=wpc_app@127.0.0.1`、`VERSION()=8.0.30` 由独立只读连接核验，与运行时使用同一凭据。）

### B.3 正式库基线（验证前后对照）

| 项 | 验证前 | 验证后 | 一致 |
|---|---|---|---|
| 库名 | `wechat_pipeline` | `wechat_pipeline` | ✅ |
| 表数量 | **18** | **18** | ✅ |
| `_prisma_migrations` 总记录 | **5** | **5** | ✅ |
| 其中 applied（`rolled_back_at IS NULL`） | **4** | **4** | ✅ |
| 历史回滚 | 1 | 1 | ✅ |

逐表行数对照（17 张业务表）：

| 表 | 前 | 后 | 变化 |
|---|---|---|---|
| `llmmodel` | 4 | 4 | — |
| `styleprompt` | 44 | 44 | — |
| `setting` | 16 | 16 | — |
| `user` | 1 | 1 | — |
| `modelbinding` | 7 | 7 | — |
| **`usersession`** | **2** | **3** | **+1（见下）** |
| `account` / `angle` / `article` / `articlelintrun` / `track` / `trackpipeline` / `taskrun` / `runlog` / `topicreview` / `comicpanel` / `wechattoken` | 0 | 0 | — |

> **`usersession` +1 说明**：本轮登录创建的会话（任务书 §六 明确"如登录会自动创建 Session，应单独识别并记录这一正常副作用"）。**除此之外零变化**，未产生任何测试用户、文章、选题、账号或任务记录。

---

## C. 后端验证

### C.1 接口状态码

**未登录（guest 越权验证）**

| 接口 | 状态码 | 判定 |
|---|---|---|
| `GET /api/health` | **200** | ✅ 公开端点，正常 |
| `GET /api/dashboard` | **401** | ✅ 正确拦截 |
| `GET /api/scheduler` | **401** | ✅ |
| `GET /api/articles` | **401** | ✅ |
| `GET /api/angles` | **401** | ✅ |
| `GET /api/tracks` | **401** | ✅ |
| `GET /api/accounts` | **401** | ✅ |
| `GET /api/models` | **401** | ✅ |
| `GET /api/style-prompts` | **401** | ✅ |
| `GET /api/users` | **401** | ✅ |

→ **10 个接口中仅 health 放行，其余全部 401，无任何越权。**

**admin 会话下**

| 接口 | 状态码 | 说明 |
|---|---|---|
| `POST /api/auth/login` | **200** | 返回 `{ok, user:{id:1, role:"admin", status:"active"}}`，下发 `wb_session` |
| `GET /api/dashboard` | **200** | 返回完整数据 |
| `GET /api/scheduler` | **200** | 含 `pushIntent` |
| `GET /api/articles` | **200** | — |
| `GET /api/tracks` | **200** | — |
| `GET /api/models` | **200** | — |
| `GET /api/style-prompts` | **200** | — |
| `GET /api/users` | **200** | 1 个用户 |
| `GET /api/credentials` | **200** | 账号管理真实端点 |
| `GET /api/angles` | **400** | 缺 `trackId` 必填参数（`validation_error`），**参数校验正确**，非缺陷 |
| `GET /api/accounts` | **404** | **端点不存在**——账号管理在 `/api/credentials`，非缺陷 |

### C.2 ✅ 登录与会话（PASS）

- 登录前 `.env` 的 `ADMIN_PASSWORD` 与库中口令不匹配（返回"用户名或口令不正确"），本轮由用户提供真实口令后登录成功
- 登录成功下发 `wb_session` cookie（httpOnly），`role=admin`
- 会话持久化在 `usersession` 表，`expiresAt` 为 30 天后

> **未重置密码、未创建用户、未修改角色。** 口令仅在本轮内存中使用，**未写入任何文件、报告或日志**（已 `grep` 验证日志与脚本中 0 命中）。

### C.3 ✅ Scheduler pushIntent（**PASS —— S6-0 / S5-UI-6-2 遗留项首次真实验证**）

```http
GET /api/scheduler   (admin 会话)
HTTP 200
```

```json
{
  "running": false,
  "intervalMs": 60000,
  "config": { "enabled": false, "writeTime": "06:00", "pushEnabled": false },
  "my": { "automationMode": "manual", "writeTime": "06:00" },
  "modeOptions": [3 项],
  "lastTick": null,
  "pushIntent": { "status": "unknown" }
}
```

**`pushIntent` 字段存在 ✅，`status = "unknown"` 是合法四态之一。**

**语义核验（与源码对照，确认为正确结果而非缺陷）**：

`server/src/services/scheduler.ts:205-210`：

```ts
export function classifyPushIntent(modes: readonly AutomationMode[]): PushIntentStatus {
  if (modes.length === 0) return 'unknown';
  ...
}
```

正式库实测：`SELECT COUNT(*) FROM account` → **0**；`WHERE enabled=1 AND credStatus='ok'` → **0**。

→ 无任何就绪账号 → `modes.length === 0` → `'unknown'` ✅ **与源码注释"一个就绪账号都没有（未启用或凭据不合规），既不能说会推也不能说不会推"完全一致。**

**未伪造状态**：任务书禁止为制造 `partial`/`all` 而修改账号配置。本轮**未创建账号、未改 `automationMode`/`enabled`/`pushEnabled`**。因此 `none`/`partial`/`all` 三态在本环境**无法通过真实数据观测**，如实标记见 §C.5。

### C.4 权限边界

| 角色 | 验证结果 |
|---|---|
| **admin** | ✅ **有效业务接口均正常返回 200**（`dashboard` / `scheduler` / `articles` / `tracks` / `models` / `style-prompts` / `users` / `credentials`），可读全局信息。**并非"全部接口 200"**：`GET /api/angles` 返回 **400**（缺必填 `trackId`，参数校验正确）、`GET /api/accounts` 返回 **404**（该路由不存在，账号管理实际端点为 `/api/credentials`）。二者**均非权限问题，也不是缺陷**。|
| **guest（未登录）** | ✅ 9 个受保护接口全部 401，**未发现任何权限绕过**。|
| **member** | ⚠️ **NOT VERIFIED** —— 见 §C.5 |

> **更正说明**：本报告初版在此处写作"全部接口 200"，与实际观测不符，已改为上述准确表述。400/404 分别源于参数缺失与路由不存在，**不得表述为权限缺陷**；同时也不得笼统写成"所有接口均返回 200"。

### C.5 ⚠️ 未覆盖的角色与状态

| 项 | 状态 | 原因 |
|---|---|---|
| **member 角色权限** | **NOT VERIFIED** | 正式库 `user` 表**只有 1 个 admin**，无 member 账号。任务书禁止创建用户或修改角色来补测试 → **不伪造** |
| `pushIntent` 的 `none` / `partial` / `all` 三态 | **NOT VERIFIED** | `account` 表 0 行，无法产生就绪账号；禁止为测试而创建账号或改配置 → 只报告实际观测到的 `unknown` |
| admin 与 member 的 `ownership` 数据范围差异 | **NOT VERIFIED** | 同上，无 member 账号可对比 |
| Dashboard 待办有真实数据时的展示 | **PARTIAL** | 库为空（0 选题 / 0 文章 / 0 待办），只验证到"空态正确"，未验证"有数据时的数字与跳转" |

> **这是本轮最重要的诚实边界**：正式库是"能跑的空壳"，所有需要业务数据的路径只能验证到空态。**不把空态验证写成完整 E2E。**

---

## D. 前端真实走查（PASS）

真实 headless Chrome（CDP 直连）访问 `http://127.0.0.1:5173`，注入真实 admin session，无任何 Mock。

### D.1 页面清单与结果

| # | 页面 | 路径 | 白屏 | Console Error | API 失败 | 空态 | 横向溢出 |
|---|---|---|---|---|---|---|---|
| 1 | 登录页 | `/login` | ❌ 正常 | **0** | 3（清 cookie 后的预期 401） | — | 无 |
| 2 | 工作台 | `/dashboard` | ❌ 正常 | **0** | **0** | ✅ 空态 | 无 |
| 3 | 选题库 | `/tracks` | ❌ 正常 | **0** | **0** | ✅ 空态 | 无 |
| 4 | 文章工作台 | `/articles` | ❌ 正常 | **0** | **0** | ✅ 空态 | 无 |
| 5 | 写作规范 | `/style-prompts` | ❌ 正常 | **0** | **0** | 有真实数据 | 无 |
| 6 | 创作计划 | `/plan` | ❌ 正常 | **0** | **0** | ✅ 空态 | 无 |
| 7 | 调度 | `/scheduler` | ❌ 正常 | **0** | **0** | — | 无 |
| 8 | 账号管理 | `/accounts` | ❌ 正常 | **0** | **0** | ✅ 空态 | 无 |
| 9 | 用户管理 | `/users` | ❌ 正常 | **0** | **0** | — | 无 |
| 10 | 调度 @500px | `/scheduler` | ❌ 正常 | **0** | **0** | — | **无** |

**9 个页面 + 1 个窄屏抽查：全部无白屏、无 console error、无 500、无横向溢出。**

### D.2 真实数据加载证据

**写作规范页**读取到真实库数据（`styleprompt` 表 44 行）：

> 创作总纲 · 400 字 · 9 行；上次保存 2026/11/15 21:39:16

这是正式库 `StylePrompt` 表的真实内容，**非 Mock**。

**工作台**真实反映空库状态：

- 待办卡显示「暂无待办」+「去创作计划」按钮
- 今日配额区显示「暂无可排产账号」
- 系统状态浮窗显示 2 项硬告警（无公众号账号、角度库存偏低）

→ 与库中 `account=0`、`angle=0`、`article=0` **完全对应**，未编造数据。

### D.3 Scheduler 的 pushIntent 横幅

**实拍结论：横幅未显示，页面只有常驻的"安全边界"提示条。**

```
alert(info): 安全边界：系统只会写草稿，最多推到公众号草稿箱，不会自动群发（AUTO_PUBLISH 恒为 false）。
```

**这是正确行为**，与源码一致（`SchedulerView.vue:269`）：

```vue
v-if="cfg.enabled && pushBanner"
```

接口返回 `config.enabled = false` → 横幅**不该显示** ✅。

> 因此「横幅文案与接口返回一致」这一项，本轮只能验证到**"enabled=false 时不显示"这一分支**。`enabled=true` 下的四态横幅渲染，S5-UI-6-2 曾用 Mock 验证（`var/tmp/s5ui2c/P62-*`），**本轮因无法启用调度而未做真实验证** → 标记 PARTIAL。

### D.4 截图证据

`var/tmp/s63/` 下 10 张 PNG（该目录已被 `.gitignore` 覆盖）：

```
S63-login-1440.png      S63-dashboard-1440.png   S63-angles-1440.png
S63-articles-1440.png   S63-style-1440.png       S63-plan-1440.png
S63-scheduler-1440.png  S63-accounts-1440.png    S63-users-1440.png
S63-scheduler-500.png
```

结构化结果：`var/tmp/s63/S63-result.json`；数据库前后对照：`db-before.txt` / `db-after.txt`。

---

## E. 安全边界

| 检查项 | 结果 |
|---|---|
| 是否发生非预期写库 | ✅ **无**。17 张业务表中 16 张行数完全不变；唯一变化 `usersession 2→3` 为登录正常副作用 |
| 是否产生测试用户/文章/选题/账号/任务 | ✅ **无**（全部 0 行，与验证前一致） |
| 是否调用真实 LLM | ✅ **未调用** |
| 是否调用微信公众号真实 API | ✅ **未调用** |
| 是否触发推送/群发/发布 | ✅ **未触发**。`AUTO_PUBLISH=false` 未变；`config.enabled=false`；`running=false` |
| 是否执行 Migration | ✅ **未执行任何 Prisma 命令** |
| 是否修改 `.env` | ✅ **未修改**（mtime 仍为 18:15:47） |
| 是否修改业务代码 / Schema / Migration | ✅ **未修改**（`git status` 仅 2 个未跟踪报告） |
| 是否创建/删除数据库或表 | ✅ **无任何 DDL** |
| 是否执行 Git 写操作 | ✅ **无**（HEAD 仍 `e46941e`） |
| 是否修改账号权限或业务配置 | ✅ **无** |
| 敏感信息是否外泄 | ✅ 口令/session **未写入任何文件**（`grep` 验证 0 命中）；临时凭据与 cookie 文件**已删除**；Chrome profile 目录**已删除** |

---

## F. 最终结论

| # | 验证项 | 结论 |
|---|---|---|
| 1 | 后端正常启动、无 Prisma/DB 错误 | **PASS** |
| 2 | 前端正常启动 | **PASS** |
| 3 | **应用运行时实际连接 `wechat_pipeline`** | **PASS**（MySQL `PROCESSLIST` 直接观测到 9 个连接池连接） |
| 4 | 数据库身份 `wpc_app@127.0.0.1` / `8.0.30` | **PASS** |
| 5 | 健康检查 `/api/health` | **PASS**（200，`db:"up"`、`driver:"mysql"`） |
| 6 | 登录与会话 | **PASS** |
| 7 | **`GET /api/scheduler` 的 `pushIntent` 真实返回** | **PASS**（`{"status":"unknown"}`，语义与源码一致） |
| 8 | guest 越权拦截 | **PASS**（9 个接口全 401） |
| 9 | admin 有效业务接口可读 | **PASS**（8 个有效接口 200；`/api/angles` 400 为参数校验、`/api/accounts` 404 为路由不存在，均非权限问题） |
| 10 | 前端 9 页面 + 窄屏抽查 | **PASS**（0 白屏 / 0 console error / 0 500 / 0 溢出） |
| 11 | 前端真实数据加载 | **PASS**（写作规范页读到真实 44 行库数据） |
| 12 | 正式库数据与结构安全核对 | **PASS**（表数 18、迁移 5 条前后一致；仅 usersession +1，登录正常副作用） |
| 13 | `AUTO_PUBLISH=false`，未触发真实微信发布 | **PASS**（常量恒为 `false`；`config.enabled=false`；未调微信接口、未推送） |
| 14 | **member 角色真实会话** | **NOT VERIFIED**（正式库无 member 账号，禁止造账号补测） |
| 15 | **`pushIntent` 的 none/partial/all 其他状态分支** | **NOT VERIFIED**（`account` 表 0 行，禁止造数据） |
| 16 | **有真实业务数据时的待办展示及完整跳转** | **NOT VERIFIED**（空库，仅观察到空态） |
| 17 | **有账号 / 有选题 / 有文章时的完整业务状态** | **NOT VERIFIED**（对应表均为 0 行） |
| 18 | `enabled=true` 时的四态横幅真实渲染 | **PARTIAL**（仅验证到 `enabled=false` 不显示；四态渲染此前仅 Mock 验证） |

### 总结

**S6-3 核心真实运行链路 PASS，可以关闭 S6-3。**

**已验证通过：**

- ✅ 后端真实运行与数据库连接（`PROCESSLIST` 运行时证据，非配置推断）
- ✅ admin 登录及会话
- ✅ 有效业务接口：`health` / `dashboard` / `scheduler` / `articles` / `tracks` / `models` / `style-prompts` / `users` / `credentials` 均正常
- ✅ guest 权限拦截（9 个受保护接口全 401，无绕过）
- ✅ 前端真实浏览器页面运行（9 页 + 窄屏，0 白屏 / 0 console error / 0 500 / 0 溢出）
- ✅ 正式库数据和结构安全性核对（前后一致，仅登录 session +1）
- ✅ `AUTO_PUBLISH=false`，未触发真实微信发布

**尚未验证或仅部分验证：**

- ⚠️ member 角色真实会话（库中无此角色账号）
- ⚠️ `pushIntent` 的 `none` / `partial` / `all` 等其他状态分支（无就绪账号）
- ⚠️ 有真实业务数据时的待办展示及完整跳转（空库）
- ⚠️ 有账号、有选题、有文章时的完整业务状态（对应表 0 行）

> **结论范围声明**：**关闭 S6-3 仅代表"核心真实运行链路"已验证通过，不代表所有角色、所有业务数据状态及所有推送意图分支均已完成真实 E2E 验证。** 上述未验证项继续保留为明确的后续事项（建议并入 S6-5 开箱演练），**不得表述为全部验证通过**。
>
> 未验证部分的成因是"正式库为空壳"这一客观条件，而非验证方法缺陷；本轮按任务书要求**拒绝伪造数据**。

---

## G. 新发现风险

| 级别 | 问题 | 说明 |
|---|---|---|
| **无 P0** | — | 未发现数据安全或错误发布风险 |
| **无 P1** | — | 核心链路全部可用 |
| **P3** | `.env` 的 `ADMIN_PASSWORD` 与库中实际口令不一致 | 该键看起来是历史遗留，不参与鉴权（真实口令在 `user.passwordHash`）。建议 S6-4 在 `.env.example` 中说明该键用途，或直接移除以免误导 |
| **P4** | `/api/accounts` 端点不存在 | 前端路由为 `/accounts`，后端端点为 `/api/credentials`。命名不一致但工作正常，无需处理 |

> S6-2A 发现的 P0（shadow 指向业务库）已在 S6-2B-1 确认修复，本轮再次间接验证：`SHADOW_DATABASE_URL → wechat_pipeline_shadow`，且全程未跑任何 Prisma 命令。

---

## H. 本轮未执行的验证（明确声明）

| 未执行 | 原因 |
|---|---|
| member / guest 登录后的权限对比 | 正式库无 member 账号；禁制造账号 |
| `pushIntent` 的 `none`/`partial`/`all` | `account` 表 0 行；禁造数据或改配置 |
| 启用调度后四态横幅的真实渲染 | 需 `PUT /api/config` 开启 `enabled`，属修改业务配置，本轮禁止 |
| 出稿 → 体检 → 推送草稿箱全链路 | 需创建账号/模型绑定/真实推送；本轮禁止 |
| 真实 LLM 生成、真实微信接口 | 明确禁止 |
| 待办有数据时的数字与跳转 | 库为空 |
| S5 已验收页面的像素级 UI 复验 | 任务书明确"不返工已验收的 S5 页面" |

> **严禁把本轮 Mock 或静态检查写成真实 E2E**：本报告所有 PASS 项均来自真实服务、真实接口、真实数据库、真实浏览器。唯一涉及 Mock 的历史证据（S5-UI-6-2 四态横幅）已明确标注为 PARTIAL。

---

## I. 补充说明：验证方法学

### I.1 为什么 `PROCESSLIST` 比读 `.env` 可靠

任务书要求"不允许仅凭 `.env` 推断实际连接身份"。本轮采用的最强证据是：**从 MySQL 服务端反向观测客户端连接**。

```
SELECT ID, DB FROM information_schema.PROCESSLIST WHERE USER='wpc_app' AND DB IS NOT NULL;
→ 110~118 共 9 个连接，DB 全部为 wechat_pipeline
```

这证明的是"**后端进程真的把连接建立到了哪个库**"，绕过了"配置文件写了什么"和"进程读到了什么"两层不确定性。

### I.2 口令处理方式

- 用户通过对话提供口令，仅在本轮命令的进程参数中使用
- **未写入 `.env`、未写入任何报告/脚本/日志**
- 验证结束已 `grep` 全目录（报告、脚本、日志）确认真实口令字符串 **0 命中**
- 临时 `my.cnf`、`cookie.txt`、Chrome `profile-s63` 目录**全部删除**

---

## J. 交付物

| 文件 | 说明 |
|---|---|
| `docs/restructure/S6-3-SYSTEM-RUNTIME-VERIFICATION.md` | 本报告（新增） |
| `docs/DEVLOG.md` | 追加 S6-3 完成记录 |
| `var/tmp/s63/S63-result.json` | 结构化走查结果（ignored） |
| `var/tmp/s63/S63-*.png`（10 张） | 各页面截图（ignored） |
| `var/tmp/s63/db-before.txt` / `db-after.txt` | 数据库前后对照（ignored） |
| `var/tmp/s63/walk-s63.mjs` | 走查脚本（ignored） |
