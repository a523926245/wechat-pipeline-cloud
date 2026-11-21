# T0 安全补充说明（最终授权前检查材料）· v3 修订版

**日期**：2026-11-12 21:45（v3，按用户 21:43 审查意见修订）| **状态**：3 项必须修正 + 4 项工程要求 + 2 条验收增补已落实；**仍未授权、未动任何代码**
**归属**：阶段 0 · T0（冒烟测试隔离化，范围受限的测试安全前置改造）｜ 上位文档：`STAGE0-IMPLEMENTATION-PLAN-V2.md` §二
**修订记录**：v1（21:20）→ v2（21:30）：①删除真实库放行通道 ②网络默认全禁（含 loopback）③守卫先于 DB 模块初始化 ④全 Schema 敏感盘点+数据最小化 → **v3（21:45）**：⑤§九「复制真实库」表述清除（统一 schema-only）⑥删除 `SMOKE_NET_ALLOW` ⑦网络隔离双层诚实表述（Node 层 ≠ OS 层）⑧临时端口登记/匹配/撤销规则收紧 ⑨验收 8→10 项（空库证明+网络反向测试）+ schema-only 验证/连接路径实测/env 显式白名单/清理矩阵。v2→v3 差异见文末 §五；v1→v2 历史差异见 §四。

---

## 〇、实查事实（回答依据，非猜测）

| 事实 | 实查结果 | 对方案的影响 |
|---|---|---|
| dev.db journal 模式 | **rollback**（header write_ver/read_ver=1），当前无 `-wal`/`-shm` | 机制不依赖该事实（Q1） |
| 出网通道 | `wechat.ts` / `llm.ts` / `comic/panels.ts` **全部经 `globalThis.fetch`**；另有 net/tls/dgram 等原生入口 | 网守分入口各自封装（fetch 与 http.request 底层实现不同，不互相覆盖），并封 dns/child_process/worker_threads（Q4） |
| **全 Schema 敏感盘点** | `OAAccount.secretEnc/secretMask`（AppSecret）；`User.passwordHash`（scrypt）；**`UserSession.id`（会话 ID=登录凭证，cookie wb_session）**；`WechatToken.tokenEnc`（微信 access_token）；**`LlmModel.apiKeyEnc/apiKeyMask`（模型供应商密钥）**；`Setting`（含自动化/迁移标志等运营配置，无加密件）；`TaskRun/RunLog`（paramsJson/resultJson/contextJson 可能嵌提示词片段）；`Article/ComicPanel/Angle`（真实业务内容）。管理令牌已不在库（现为 UserSession 会话制，`via:'session'\|'smoke'`） | 数据最小化清单（Q7） |
| 主密钥 | `APP_SECRET_KEY` 来自 env；开发缺省回落 `server/var/tmp/.dev_master_key`（已 gitignore） | 子进程 env **显式白名单**不下发 APP_SECRET_KEY 等一切密钥（Q7） |
| 三冒烟断言依赖 | smoke:lint 自建无密钥账号；smoke:style 只碰 StylePrompt/Setting 自建键；smoke:angles 自建 track/angle/article；**均不依赖任何既有业务数据行** | 空库 schema-only 可行（Q7/Q9） |
| `.gitignore` / Node | 已有 `*.db`、`server/var/`；Node v22.22.2、Prisma 5.22 | 零新依赖 |

---

## 一、逐项回答最终检查清单（8 问，v3 修订后）

### ☑ Q1 SQLite 隔离快照如何保证一致性？（通过，机制保留）
**不复制文件。数据型快照用 SQLite 官方在线备份 `VACUUM INTO`（经现有 Prisma 通道）**，对源库一致性读、原子写出完整快照，与 WAL/rollback 无关；生成后 `PRAGMA quick_check`，失败废弃重试一次、再失败终止。**标准路径不搬任何真实数据**（见 Q7 数据最小化——schema-only 空库，一致性快照问题从根上不存在）；`VACUUM INTO`+快照校验保留为将来「确实需要数据型快照」（如其他 verify 脚本）时的唯一合法机制，禁止裸文件复制。**（v3 重申）真实数据型快照不属于标准 smoke 流程。**

### ☑ Q2 如何证明测试绝不会回退到真实数据库？（通过，v2 已零绕过）
**失败关闭 + 零绕过**：
1. **三条标准 smoke 命令永远只跑隔离库**。runner 负责建隔离库、注入 `DATABASE_URL`、回读断言生效（注入失败→立即终止，不起子进程）。
2. **代码中不存在 live 分支**：`SMOKE_ALLOW_LIVE_DB` 之类绕过开关**不提供、不实现**。守卫校验失败（路径不对 / 指向真实 dev.db / 文件不存在 / 守卫自身异常）一律 `exit(1)`，无警告放行、无条件降级、无隐藏开关。
3. PrismaClient 无回落分支（只读 env，env 已锁死为隔离路径）；dotenv 不覆盖已注入值（已实测），且守卫在动态加载测试模块前做最终路径断言（见 Q3'）。
4. 如确需针对真实数据库做特殊诊断：**另行设计、单独授权，不属于 T0**，与标准 smoke 入口物理隔离（不同脚本、不同命令、不同文档登记），本方案不预留任何钩子。

### ☑ Q3 如何验证隔离库与原始开发库路径不同？（通过，v3 补连接实测）
1. **字符串层**：runner 与子进程守卫各做一次 `path.resolve` + Windows 归一（盘符大小写、分隔符、短路径展开）后断言 `isoPath ≠ realPath` 且不落在真实 dev.db 的任何别名上；横幅同打 REAL/ISOLATED 绝对路径。
2. **连接层（v3 新增，不只检查环境变量字符串）**：守卫/runner 打开实际数据库连接后执行 **`PRAGMA database_list`**，比对 SQLite **实际连接的文件路径**与 runner 预期隔离路径一致（归一后精确相等），不一致即 `exit(1)`。
3. `verify:smoke-iso` 正反例验证（指向 dev.db → 拒绝；指向隔离库 → 放行；env 注入被破坏 → 中止；env 字符串正确但 `database_list` 指向他处 → 拒绝）。

### ☑ Q3' 守卫如何先于数据库模块初始化？（通过，v2 构造次序）
ESM 静态 import 会在测试主体执行前加载依赖——「先 import db 再调守卫」是假防护。**强制初始化顺序**：
1. runner 注入隔离 DATABASE_URL 并回读断言；
2. spawn 子进程：`node --import ./scripts/smoke-net-guard.mjs --experimental-strip-types scripts/smoke-run.ts <target>`（`--import` 预载网守，先于一切模块）；
3. `smoke-run.ts`（引导入口）**只静态 import** `smoke-db-guard.ts`（守卫仅用 node:fs/path/process，**不 import db.ts/config.ts**）；
4. 守卫执行路径断言，**通过后才 `await import('./smoke-<target>.ts')` 动态加载测试模块**；
5. 测试模块的静态依赖（含 `src/db.ts` → PrismaClient 实例化）此时才加载——**守卫在先、DB 模块在后**，次序由构造保证，不靠阅读顺序。
> 三个测试文件因此**几乎不用改**（保持纯断言模块）；唯一例外见 Q4 的端口登记胶水。

### ☑ Q4 如何阻止微信外呼及其他真实外部副作用？（v3 修订：**双层能力表述，不宣称 OS 级隔离；删除 SMOKE_NET_ALLOW**）
**能力边界先声明（诚实标注，v3）**：本方案的网络隔离是**「已覆盖并验证的 Node 网络入口隔离」**，**不宣称具备操作系统级全网络隔离能力**。纯 JavaScript 包装无法证明封锁了所有出网路径（原生扩展、未识别内部路径可能绕过被包装 API）。因此明确分为两层：

**第 1 层：Node 进程内网守（必做，失败关闭）** —— `smoke-net-guard.mjs` 预载封堵已识别入口：
1. **HTTP 家族**：`globalThis.fetch` 与 `http.request/get`、`https.request/get` **各自独立封装**（fetch 底层走 undici，与传统 http.request 实现不同，不互相覆盖——两者都直接封入口本身并各自反向验证）。
2. **低层套接字**：`net.connect/createConnection/Socket.prototype.connect`、`tls.connect`、`dgram.Socket.prototype.send/bind`、`globalThis.WebSocket`（存在即封）。
3. **旁路通道（v3 新增，fail-closed）**：`dns.lookup/resolve/resolve4/resolve6/promises.*`（防 DNS 隧道）；`child_process.spawn/exec/execFile/fork`（防经外部程序自行联网——三条冒烟不需要子进程，直接封）；`worker_threads.Worker` 构造（防独立执行上下文绕过封装）。
4. **代理绕过封死**：预载时清除 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NOPROXY` 等代理环境变量；封装层不读代理配置（只按目标地址判定）。
5. **命中任一封堵点 → 抛错使测试以非零退出码失败**（不是打印警告）。
6. **未识别入口不作已封锁宣称**：网守封不到的路径（如原生扩展直调系统网络栈）不在「已覆盖」范围内——由第 2 层或上方能力声明兜底，报告与验收一律如实标注。

**第 2 层：运行环境隔离（可选增强，T0 不假设其存在）** —— 若执行环境支持 OS 防火墙 / 网络沙箱 / 受限进程环境，可在进程外禁止一切外部网络。**当前若无第 2 层，全部文档、报告、验收标注「Node 层网络入口隔离，非 OS 级全网络隔离」**；要宣称完全禁止出网，需独立的操作系统层验证，不属于 T0 既有能力。

**自建临时端口白名单规则（v3 收紧：绑定与请求目标一致性）** —— 仅允许「测试进程自己绑定的临时端口」（smoke:lint/smoke:angles 各自 `app.listen(0)`），且：
1. **只允许绑定数值 loopback**：`127.0.0.1` 或 `::1`；拒绝 `0.0.0.0`、外网网卡、`'localhost'` 主机名绑定。
2. **只允许系统分配临时端口**：必须 `listen(0)`；显式指定端口直接拒绝。
3. **bind 成功后才登记**：经 `listening` 事件/`server.address()` 取**实际端口**，登记 `127.0.0.1:<port>` / `[::1]:<port>`。
4. **出站请求精确匹配**：请求目标规范化（数值地址+端口）后必须**精确命中已登记项**；`localhost`、`::ffff:127.0.0.1` 等 IPv4/IPv6 映射别名一律先归一化再比对，归一后不等于登记项即拒绝——杜绝 8787 后端、本地代理等经别名混入白名单。
5. **服务 close 后立即撤销**该端口登记。
6. **不提供 `SMOKE_NET_ALLOW` 之类手工放行（v3 删除）**：标准 smoke 不设任何人为追加网络白名单的入口；确有其他测试需求，另行设计独立测试方案，不属于 T0。
> 白名单可证明无外部操作：①服务是测试自己在本进程内创建的项目 API；②所有 handler 的出网仍被同一网守封死；③被调用的仅 lint（纯计算）与 push（门禁先拦，断言 `reason=lint_failed`）。「假账号没有真实密钥」降为第三道次要防线，不作为网络安全措施。

### ☑ Q5 如何确保失败、异常退出后不污染原始数据库？（通过，v3 补清理矩阵）
1. **构造上写不到原库**：写连接被锁死在隔离库（Q2 零绕过），任何阶段失败都改变不了连接目标。
2. **进程异常退出**（未捕获异常/信号）：残留只可能出现在隔离库与其临时文件，原库零接触；runner 侧无论子进程如何退出都在自身 `finally` 里清理隔离库，清理失败**显式报告**残留路径。
3. **清理验证矩阵（v3 新增）**：普通异常 / 子进程非零退出 / 超时 / SIGINT / SIGTERM **五种退出路径分别验证 runner 清理生效**（verify 脚本各跑一遍）；**SIGKILL 无法保证清理**——如实声明：最坏残留=隔离文件 `server/prisma/dev.smoke-*.db`（绝不碰原库），**恢复方法=按命名模式删除残留**（提供 `smoke:prune-iso` 清理命令或文档化步骤），残留由 Q6 前后指纹与清理报告共同暴露。
4. 子进程 env 为**显式白名单**（Q7），异常泄漏面收敛。
5. 原库零写入由 Q6 前后 SHA-256 判定兜底闭环。

### ☑ Q6 如何验证原始 dev.db 在测试前后没有变化？（通过）
runner 测试前后采集原库指纹：**SHA-256**（dev.db + 存在的 -wal/-shm）+ 字节大小 + mtime，全比对；**任一不同 → 本轮测试作废**、报警「原库被写入/存在并发写入者」、退出码非 0。启动前扫描活动写入者（8787 监听 / scheduler 进程），发现则**默认拒绝启动**（无绕过开关；确需带服务运行的诊断另行授权）；沿用「SQLite 单写者、冒烟串行」；必要时只读 `PRAGMA quick_check` 辅证。指纹留档可复核。

### ☑ Q7 如何处理临时副本中的密钥及敏感数据？（v3 补：schema-only 验证 / 连接实测 / env 显式白名单）
**标准路径 = schema-only 空库，真实数据零复制**：
1. **不搬数据**：runner 用 **`prisma db push --schema schema.sqlite.prisma --skip-generate`（显式 SQLite 专用 Schema）** 对全新文件建 schema，得到**表结构一致、零行**的隔离库。真实文章/用户/账号/会话/密钥**从一开始就不进副本**。**（v3 补）不只检查命令执行成功**：见第 6 条验证链。
2. **测试数据测试自己造**：三条冒烟本就自建夹具（已实查断言不依赖既有业务行）；StylePrompt 播种走代码默认值（空表即播种，恰是断言覆盖的路径）。若执行中发现某断言意外依赖既有数据行，**在测试内生成专用夹具**（业务断言不变），绝不把真实数据放进副本。
3. **敏感全清单**（全 Schema 盘点结果，供「将来数据型快照」脱敏参照，标准路径用不到）：`OAAccount.secretEnc/secretMask`、`User.passwordHash`、**`UserSession.id`（整表清空——会话即登录凭证）**、`WechatToken.tokenEnc`、**`LlmModel.apiKeyEnc/apiKeyMask`**、`Setting` 中任何含密值（现无）、`TaskRun.paramsJson/resultJson`/`RunLog.contextJson` 脱敏提示词片段。**数据型快照仅经 `VACUUM INTO`+上述脱敏+业务表按需保留**，另行登记使用场景，不属于标准 smoke。
4. **env 显式白名单（v3 收紧：允许清单而非排除清单）**：子进程**只传白名单内变量**（运行必需项：`PATH`、`SYSTEMROOT`、`TEMP`/`TMP`、`LANG`、注入的 `DATABASE_URL`、`CONTENT_DIR`、`NODE_ENV` 等，清单在 runner 代码中写死并留档），**其余一律剥离**——含 `APP_SECRET_KEY`、一切 `*TOKEN/*SECRET/*KEY`、代理变量、云凭据、继承自生产环境的任何敏感变量。dotenv 不覆盖已注入值已实测。
5. **防泄漏与清理**：隔离文件放 `server/prisma/dev.smoke-<ts>.db`（`*.db` 已 ignore，另加显式 `dev.smoke-*.db` 行防后缀陷阱）；POSIX `chmod 0600`（Windows 继承 ACL，如实标注差异）；不上传不 commit（收尾 `git status --ignored` 复核）；finally 清理，**清理失败显式报告**残留路径（矩阵见 Q5-3）。
6. **schema-only 验证链（v3 新增）**：`db push` 后逐项断言，任一失败即 `exit(1)`：
   ①隔离路径下文件**确实新建**（存在 + 大小 > 0）；
   ②`PRAGMA database_list` 实测连接路径 = runner 预期隔离路径（Q3-2）；
   ③**关键业务表结构存在**（Track/Angle/Article/StylePrompt/Setting/LlmModel/OAAccount/User/UserSession 等）；
   ④**全部业务表初始行数 = 0**（空库证明）；
   ⑤smoke 自建夹具可正常创建、查询、清理（Q9 验收项）。

### ☑ Q8 如何证明三个冒烟测试原有断言没有被削弱？（通过）
1. **diff 白名单**：三测试文件预期**零改动或仅端口登记一行**（Q4：`app.listen(0)` 后登记临时端口，属入口胶水）；`git diff` 核对 `expect()`/断言条件/数据构造/清理逻辑零改动；业务断言与测试覆盖范围是 T0 禁改区。
2. **运行证据**：隔离运行断言计数对齐改造前记录：smoke:lint **116 项**（2026-11-12 日志）、smoke:style **33 项**、smoke:angles 当场计数（18 组）；全部 PASS、计数不降；前后输出留档。
3. **守卫/网守失败=整脚本失败退出**，无跳过、无降级、无警告放行。

---

## 二、T0 范围边界（不变）
**允许修改**：新增 `smoke-isolated.ts` / `smoke-db-guard.ts` / `smoke-net-guard.mjs` / `smoke-run.ts`（引导入口）；修改三个 smoke 测试入口（预计仅端口登记一行）；`server/package.json` 测试命令；必要 `.gitignore` 修改。
**禁止修改**：`server/src/**`、Prisma Schema、数据库真实数据、生产配置、业务断言与测试覆盖范围、微信/LLM/漫画业务逻辑。

## 三、验收必须全部满足（**10 项**，v3 = 原 8 项 + 空库证明 + 网络反向测试）
1. 隔离数据库正向测试通过；
2. 真实数据库反向测试被拒绝；
3. 环境变量注入失败时直接退出；
4. 网络访问被阻断（含 loopback 未登记端口）——**Node 层验证**；
5. 三个 smoke 原有断言全部保留；
6. 四连在隔离副本上通过；
7. 真实 dev.db 前后 SHA-256 一致；
8. 测试副本清理成功，或明确报告残留——**覆盖普通异常/子进程非零退出/超时/SIGINT/SIGTERM 五条退出路径；SIGKILL 残留恢复方法已文档化**；
9. **空库证明（v3 新增）**：新建隔离库 → 关键业务表结构存在 → 全部业务表初始记录数为 0 → smoke 自建数据可正常创建、查询、清理；
10. **网络隔离反向测试（v3 新增，Node 层能力验证）**：外部 HTTPS 请求被阻止 / 外部 HTTP 请求被阻止 / 未登记的本地端口被阻止 / 已登记的测试临时端口可以正常访问 / 代理环境变量无法绕过限制 / 网络拦截命中时测试以非零退出码结束。**以上为 Node 层验证；如要宣称完全禁止出网，还需独立的操作系统层验证。**

**原则重申（用户要求，写死）**：不为尽快进入 UI 改造而降低 T0 安全标准——第一步测试隔离不留下任何可能再次造成数据事故的绕过路径。

---

## 四、v1 → v2 差异摘要（历史）
| # | 问题 | v1 | v2 |
|---|---|---|---|
| 1 | 真实库应急放行 | `SMOKE_ALLOW_LIVE_DB=1` 放行分支 | **删除**。标准 smoke 永远隔离库；校验失败即退出；无隐藏开关；真库诊断另行设计单独授权 |
| 2 | 网络隔离 | 放行全部 loopback | 默认禁一切网络（含 loopback）；仅登记「本进程自绑临时端口」；封 fetch/http/https/net/tls/dgram/WebSocket；清代理 env；命中即测试失败（v3 进一步修订能力表述与端口规则） |
| 3 | 守卫时序 | 三脚本顶部 import 后调用（受 ESM 加载序限制） | **引导入口 `smoke-run.ts` 构造次序**：网守预载→守卫验证→动态 import 测试模块→PrismaClient 才加载 |
| 4 | 副本脱敏 | 脱敏 3 表 4 列 | **数据最小化：schema-only 空库，真实数据零复制**；敏感全清单补 `UserSession.id`、`LlmModel.apiKeyEnc/Mask` 等；env 白名单不传主密钥；CONTENT_DIR 指隔离临时目录 |

## 五、v2 → v3 差异摘要（本次）
| # | 问题 | v2 | v3 |
|---|---|---|---|
| 1 | 文档内部矛盾：§九残留「每次从最新 dev.db 复制」 | 与 schema-only 设计冲突 | **清除一切「复制真实库」表述**；统一为 schema-only 空库；「同源」改为「**Schema 与当前代码版本同源**」（计划 §九已同步） |
| 2 | `SMOKE_NET_ALLOW` 手工放行 | 留有 `SMOKE_NET_ALLOW=host:port` 入口 | **删除，零人工网络白名单入口**；其他测试需求另行设计独立方案 |
| 3 | 网络隔离能力描述过于绝对 | 「默认完全禁止网络」 | **双层诚实表述**：第 1 层=已覆盖并验证的 Node 网络入口隔离（fetch/http/https/net/tls/dgram/WebSocket/dns/child_process/worker_threads 分别封装+反向测试）；第 2 层=OS 防火墙/沙箱（可选，T0 不假设存在）；**不宣称 OS 级全网络隔离**，报告如实标注 |
| 4 | 临时端口白名单粒度 | 只说「bind 成功时登记」 | **6 条规则**：仅数值 loopback 绑定 / 仅 `listen(0)` / bind 成功后登记实际端口 / 出站精确匹配（归一化后，禁 localhost 与 v4-mapped 别名）/ close 即撤销 / 无手工放行 |
| 5 | 验收 8 项不足 | 8 项 | **10 项**：+⑨空库证明 +⑩网络隔离反向测试；⑧扩为五条退出路径清理验证+SIGKILL 残留恢复文档化 |
| 6 | 工程细节待明确 | — | +schema-only 验证链（db push 用 `schema.sqlite.prisma` 且验证实际落盘隔离路径）+ `PRAGMA database_list` 连接实测 + env 显式允许清单 + 清理矩阵 |
