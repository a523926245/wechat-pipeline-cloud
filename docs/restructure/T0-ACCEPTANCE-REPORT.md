# T0 验收报告 · 冒烟测试隔离化（阶段 0 · 正式验收版）

**日期**：2026-11-13（验收重跑留档时间 12:57–13:05 GMT+8）｜ **授权范围**：仅 T0（T1–T8 UI 改造未授权，本报告交付后停下等验收）
**机制真源**：`T0-SAFETY-SUPPLEMENT.md`（v3）｜**概要**：`STAGE0-IMPLEMENTATION-PLAN-V2.md` §二 T0 处置节 ｜ **修订背景**：`T0-V3-REVISION-DIFF.md`
**能力声明**：网络隔离为 **Node 进程层网络入口隔离，非 OS 级全网络隔离**（双层表述见真源 Q4；全文、运行器输出、验收标签均不宣称封锁一切出网路径）。
**证据原则**：本报告所有验收结论均由文中标注的真实命令输出/文件支撑；逐条完整输出见正文与附录 A–G，原始留档见 `docs/restructure/T0-ACCEPTANCE-LOGS/`（8 个 txt）。不用推断代替测试结果。

---

## 0. 验收材料清单对照（用户 9 项要求 → 本报告位置）

| # | 要求 | 位置 |
|---|---|---|
| 1 | 完整的 T0-ACCEPTANCE-REPORT.md（非摘要） | 本文件全文 |
| 2 | `verify:smoke-iso` 十项验收完整输出 | §3 + 附录 E（逐字全录） |
| 3 | 13 条网络隔离反向用例详细清单（入口/目标/预期/实际/退出码） | §4 明细表（逐条） |
| 4 | 三个 smoke 完整断言计数及改造前基线对照 | §5（基线出处逐条引用） |
| 5 | dev.db 完整 SHA-256、大小、测试前后指纹对照 | §6 |
| 6 | 四连测试和 typecheck 完整终端输出 | §7 + 附录 A–D（逐字全录） |
| 7 | 完整 `git diff --stat`、`git diff`、新增文件清单 | §8 + 附录 F–G |
| 8 | 明确确认无 `SMOKE_ALLOW_LIVE_DB`、`SMOKE_NET_ALLOW` 等放行机制 | §9（含 grep 实证与既有开关性质披露） |
| 9 | 尚未隔离的 smoke 命令清单（登记为禁止直接执行的遗留风险） | §10 |

四项确认（未动禁止项 / 覆盖范围不减 / 网络能力限定 Node 层 / 结论均有证据）见 §13。

---

## 1. 实际修改文件清单

### 1.1 新增（T0 四件套，`server/scripts/`，均经 `--experimental-strip-types` 运行）

| 文件 | 行数（wc -l 实测） | 职责 |
|---|---|---|
| `smoke-isolated.ts` | 795 | 父进程运行器：并发写入者扫描（8787 + scheduler）/ 原库指纹（SHA-256+size+mtime）/ schema-only 建库（`prisma db push --schema schema.sqlite.prisma --skip-generate`）/ 验证链 4 步 / env 白名单注入 / 子进程超时与信号处理 / 清理矩阵 / 10 项验收台（`verify`）/ SIGKILL 残留恢复（`prune`） |
| `smoke-db-guard.ts` | 106 | 子进程 DB 守卫：`DATABASE_URL` 必须 file: 且命名 `dev.smoke-*.db`、路径归一（resolve+realpath+盘符大小写）后反真实库及历史别名（config.ts 兜底 `var/tmp/dev.db`）、必须在 `server/prisma/` 下；失败或守卫异常一律 `exit(1)`，**零绕过开关** |
| `smoke-net-guard.mjs` | 439 | `--import` 预载网守：清代理 env；封 fetch/http/https/net/tls/dgram/WebSocket/dns（含 promises 与 Resolver 实例）/child_process/worker_threads；listen 规则 1/2（仅数值 loopback、仅 `listen(0)`、未指定 host 强制 127.0.0.1、数值 IP 同步短路 dns.lookup 保同步 bind）；端口登记 `__SMOKE_NET__.register`（6 规则）；出站归一化精确匹配 + 强制数值 lookup（封自定义 lookup 重定向旁路） |
| `smoke-run.ts` | 184 | 引导入口：只静态 import db 守卫 → 通过后 `await import()` 动态载测试模块（初始化次序由构造保证，PrismaClient 不得早于守卫加载）；内置 `selftest:*` 自检（ok/throw/exit1/hang + 13 个 net-* 反向用例） |

### 1.2 修改（白名单范围内）

| 文件 | 改动 | 白名单核验 |
|---|---|---|
| `server/scripts/smoke-lint.ts` | **仅 +1 行** `__SMOKE_NET__.register(server)` 端口登记胶水 | 附录 F 之 diff 确认仅 1 行插入（`app.listen(0)` 后、取 `server.address()` 前），业务断言零改动 |
| `server/scripts/smoke-angles.ts` | **仅 +1 行**（同上） | 同上 |
| `server/scripts/smoke-style-prompts.ts` | **零改动** | 纯 DB 断言、无 `app.listen`，胶水行也不需要；`git diff` 无该文件 |
| `server/package.json` | `smoke:lint/style/angles` 三条命令**命令名不变**、执行体改走隔离运行器；新增 `verify:smoke-iso`、`smoke:prune-iso` | 授权范围内（diff 见附录 F） |
| `.gitignore` | 新增 `dev.smoke-*.db` 行 | 授权范围内 |
| `docs/restructure/T0-ACCEPTANCE-REPORT.md` + `T0-ACCEPTANCE-LOGS/`（8 个 txt） | 本报告与验收留档 | 新增（本次补充提交） |
| `CHANGELOG.md` / `docs/DEVLOG.md` / `.workbuddy/memory/` | 收尾回写（文档，非代码） | 新增 |

### 1.3 新增文件清单（git untracked，区分来源）

- **T0 新增（本次授权产物）**：`server/scripts/smoke-isolated.ts`、`smoke-db-guard.ts`、`smoke-net-guard.mjs`、`smoke-run.ts`；`docs/restructure/T0-ACCEPTANCE-REPORT.md`、`T0-SAFETY-SUPPLEMENT.md`、`T0-V3-REVISION-DIFF.md`、`STAGE0-IMPLEMENTATION-PLAN-V2.md`、`T0-ACCEPTANCE-LOGS/`（8 个 txt）。
- **早前会话（审计/设计阶段）遗留 untracked，非 T0 改动**：`docs/AUDIT-REPORT.md`、`docs/RESTRUCTURE-CHECKLIST.md`、`docs/RESTRUCTURE-PLAN-V1.md`、`docs/restructure/` 其余设计文档（00/09/CURRENT-ARCHITECTURE 等）。
- 完整 31 项 untracked 清单逐字全录见附录 G。

**禁止项核对（§13 有逐项确认）**：`server/src/**` 零改动；Prisma Schema 零改动；真实数据库数据零改动（全程只读 + 前后指纹比对，见 §6）；生产配置零改动；业务断言与测试覆盖范围零改动；微信/LLM/漫画业务逻辑零改动。`AUTO_PUBLISH=false` 未触碰，群发红线未动。

---

## 2. 完成情况（机制摘要，细节以代码与实测输出为准）

- ✅ **三条标准 smoke 命令永远只跑隔离库**：`npm run smoke:lint|style|angles` → `smoke-isolated.ts run <target>` → 每轮新建 `server/prisma/dev.smoke-<id>.db`（schema-only 零行、真实数据零复制）→ 注入 `DATABASE_URL`/`CONTENT_DIR`/`NODE_ENV`（env 白名单：PATH/SYSTEMROOT/WINDIR/TEMP/TMP/LANG/TZ + 上述三项；剥离 `APP_SECRET_KEY`、一切 `*TOKEN/*SECRET/*KEY`、代理变量，注入后回读断言）→ 子进程 `node --import smoke-net-guard.mjs --experimental-strip-types smoke-run.ts <target>`。
- ✅ **验证链 4 步**（不只看命令成功）：①隔离文件落盘且 >0 → ②`PRAGMA database_list` 连接路径实测 = 隔离文件 → ③15 张业务表结构存在（物理表名，`OAAccount`→`@@map("Account")`）→ ④逐表行数=0（空库证明）。任一步失败 `exit(1)`。每轮输出含 `ISO-VERIFY PASS（落盘 / 连接实测 / 表结构 / 行数=0）`。
- ✅ **零绕过**：无 `SMOKE_ALLOW_LIVE_DB`/`SMOKE_NET_ALLOW` 类开关（§9 grep 实证）；校验失败/守卫异常一律退出；直跑 `smoke-*.ts` 被胶水行拒绝（须经 `smoke-run.ts` 引导置 `__SMOKE_ISO_OK__`，该标记默认关闭、由守卫通过后置位）。
- ✅ **初始化次序构造保证**：`--import` 预载网守（先包装后导入，ESM 可见性实测）→ 只静态载 db 守卫 → 动态 import 测试模块 → PrismaClient 才加载。
- ✅ **原库零写入**：每轮 run 前后对 `dev.db`（及 -wal/-shm）做 SHA-256+size+mtime 比对，不同则作废报警（输出 `REAL-DB FINGERPRINT MATCH`）；启动前 `scanWriters` 检测 8787 监听与 scheduler 进程，默认拒绝启动（输出 `WRITER-SCAN ok`）。
- ✅ **清理矩阵五路径 + SIGKILL 恢复**：普通异常/子进程非零退出/超时/SIGINT/SIGTERM 五路径实测清理生效；SIGKILL 如实声明残留并由 `npm run smoke:prune-iso` 恢复（验收⑧实证，§3）。
- ✅ **临时端口 6 条规则**：仅数值 loopback、仅 `listen(0)`、bind 后显式登记实际端口、出站归一化精确匹配禁别名、close 即撤销、无手工放行入口。
- ✅ **10 项验收 10/10 通过**（完整输出见 §3/附录 E）。

---

## 3. `verify:smoke-iso` 十项验收完整输出（2026-11-13 12:5x 真实运行，逐字全录）

命令：`cd server && npm run verify:smoke-iso`（= `node --experimental-strip-types scripts/smoke-isolated.ts verify`）。原始留档：`T0-ACCEPTANCE-LOGS/5-verify-smoke-iso.txt`。

```
$ npm run verify:smoke-iso
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 verify:smoke-iso
> node --experimental-strip-types scripts/smoke-isolated.ts verify

════════════════════════════════════════════════════════
[verify] T0 验收台（10 项，真实运行）
[t0] prune 已清除 3 项：
  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweig6pi0tc3.db
  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweig6pi0tc3.db-journal
  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\var\tmp\smoke-iso-mweig6pi0tc3
────────────────────────────────────────────────────────
PASS  ① 隔离数据库正向测试通过
      exit=0；ISO-EMPTY/FIXTURE/MATCH 标记齐=true
PASS  ⑨ 空库证明（表结构存在 + 行数=0 + 自建数据创建/查询/清理）
      ISO-EMPTY tables=15/15 rows=0 + FIXTURE-PROBE-OK = true
PASS  ② 真实数据库反向测试被拒绝
      相对路径指向真实库: exit=1 拒绝；绝对路径指向真实库: exit=1 拒绝；别名路径指向真实库: exit=1 拒绝
PASS  ③ 环境变量注入失败时直接退出
      DATABASE_URL 缺失: exit=1 拒绝；非 SQLite 连接串: exit=1 拒绝；隔离文件不存在: exit=1 拒绝
PASS  ④ 网络访问被阻断（含 loopback 未登记端口，Node 层）
      见⑩
PASS  ⑩ 网络隔离反向测试（Node 层能力验证）
      外部 HTTPS 请求被阻止: exit=1 命中被拦；外部 HTTP 请求被阻止: exit=1 命中被拦；未登记 loopback 端口被阻止（fetch）: exit=1 命中被拦；未登记 loopback 端口被阻止（http.get）: exit=1 命中被拦；未登记 loopback 端口被阻止（net.connect）: exit=1 命中被拦；已登记临时端口可达 + close 即撤销: exit=1 命中被拦；代理环境变量无法绕过: exit=1 命中被拦；dns 被阻止: exit=1 命中被拦；child_process 被阻止: exit=1 命中被拦；WebSocket 被阻止: exit=1 命中被拦；tls.connect 被阻止: exit=1 命中被拦；dgram 被阻止: exit=1 命中被拦；worker_threads 被阻止: exit=1 命中被拦
PASS  ⑦ 真实 dev.db 前后 SHA-256 一致
      sha256=fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5（每轮 run 末尾另有 REAL-DB FINGERPRINT MATCH 断言）
PASS  ⑧ 副本清理（五条退出路径 + SIGKILL 残留恢复）
      runner普通异常: exit=1 残留=无 ；子进程未捕获异常: exit=1 残留=无 ；子进程非零退出: exit=3 残留=无 ；超时: exit=1 残留=无 ；SIGINT: exit=1 残留=无 ；SIGTERM: exit=1 残留=无 ；SIGKILL: 残留暴露=true（dev.smoke-mweig6pi0tc3.db,dev.smoke-mweig6pi0tc3.db-journal）→ prune 恢复=true
PASS  ⑤ 三个 smoke 原有断言全部保留
      git diff 白名单 + 计数不降（lint 116 / style 33 / angles 当场计数）——报告留档
PASS  ⑥ 四连在隔离副本上通过
      npm run typecheck + smoke:lint/style/angles 真实输出——报告留档
────────────────────────────────────────────────────────
[verify] 10/10 项通过
EXIT_CODE=0
```

**输出读法说明（防误读，两处）**：

1. 顶部 `[t0] prune 已清除 3 项：dev.smoke-mweig6pi0tc3.*` **不是**启动清理——`verify()` 的 PASS 汇总行是全部用例跑完后统一打印的，这行 prune 是 **⑧ 中 SIGKILL 用例**的 `prune()` 执行输出（程序序在用例执行期）。证据：prune 删除的文件名 `dev.smoke-mweig6pi0tc3.db/.db-journal` 与 ⑧ 明细里 SIGKILL 残留暴露的文件名**逐字一致**，互为印证（`runOne` 的 runId=`Date.now().toString(36)+4 位随机`，每轮唯一）。
2. 「子进程非零退出: exit=3」——被测子进程 `selftest:exit1` 故意 `process.exit(3)`，runner 如实透传子进程退出码 3 并完成清理（判定条件为 `code!==0 且残留=无`），符合预期。

**十项与真源验收定义映射**：①正向隔离 ②真实库反向被拒（相对/绝对/别名三形态）③env 注入失败即退（缺失/非 SQLite/文件不存在三形态）④网络阻断（Node 层）⑤三 smoke 断言保留 ⑥四连通过 ⑦原库 SHA-256 前后一致 ⑧清理矩阵五路径+SIGKILL 残留 prune 恢复 ⑨空库证明（15 表×0 行+fixture 创建/查询/清理）⑩网络反向 13 条（§4）。

---

## 4. 13 条网络隔离反向用例详细清单（Node 层能力验证）

**测试入口（统一）**：验收台 `verify()` 以 `runRunnerCase('selftest:<name>')` 调用隔离运行器；运行器建隔离库后 spawn 子进程 `node --import file:///…/smoke-net-guard.mjs --experimental-strip-types …/smoke-run.ts selftest:<name>`（`net-proxy` 用例另加 `--inject-proxy-env`，由 runner 向子进程注入 `HTTP_PROXY`/`ALL_PROXY` 等，验证预载时清除 + 运行时再设也不能绕过）。用例代码真源：`smoke-run.ts` L96–179；判定逻辑真源：`smoke-isolated.ts` L634–655。**用例故意不捕获守卫抛错——命中即非零退出是验收项。**

| # | selftest 入口 | 访问目标（用例原码） | 预期结果 | 实际结果 | 退出码 |
|---|---|---|---|---|---|
| 1 | `selftest:net-external-https` | `fetch('https://example.com/')`（5s 超时） | 网守命中抛错（BLOCKED），不得出网 | 命中被拦（输出含 `BLOCKED`） | **exit=1** |
| 2 | `selftest:net-external-http` | `fetch('http://example.com/')` | 同上 | 命中被拦 | **exit=1** |
| 3 | `selftest:net-unregistered-fetch` | `fetch('http://127.0.0.1:8787/health')`（loopback 未登记端口） | 端口未登记即拒绝（规则 4 精确匹配） | 命中被拦 | **exit=1** |
| 4 | `selftest:net-unregistered-http` | `http.get('http://127.0.0.1:8787/health')` | 同上（http 通道） | 命中被拦 | **exit=1** |
| 5 | `selftest:net-unregistered-netconnect` | `net.connect({host:'127.0.0.1',port:8787})` | 同上（裸 socket 通道） | 命中被拦 | **exit=1** |
| 6 | `selftest:net-registered` | 自建 http server `listen(0)` + `register()` → `fetch('http://127.0.0.1:<临时端口>/')` → `server.close()` → 再 fetch 同端口 | 双向：①已登记可达（200，`SELFTEST REGISTERED_OK`）②close 即撤销（规则 5），再访被拦 | 双向均验证：输出含 `SELFTEST REGISTERED_OK` 且 close 后 `BLOCKED fetch`（验收台双重判定） | **exit=1**（close 后被拦即抛错，预期非零） |
| 7 | `selftest:net-proxy`（`--inject-proxy-env`） | 预载后查 6 个代理 env 是否已清 → 运行时再设 `HTTP_PROXY`/`ALL_PROXY=http://127.0.0.1:65002` → `fetch('http://example.com/')` | ①代理 env 必须被预载清除（`SELFTEST PROXY_ENV_CLEARED`）②运行时代理不能绕过封堵 | 两点均验证：输出含 `SELFTEST PROXY_ENV_CLEARED` 且 `BLOCKED fetch` | **exit=1** |
| 8 | `selftest:net-dns` | `dns.lookup('example.com', …)`（域名解析） | 命中抛错（域名不放行；数值 IP 短路仅限 listen 同步语义，见真源 Q4/差异表 #3） | 命中被拦 | **exit=1** |
| 9 | `selftest:net-childproc` | `child_process.spawn('node', ['-v'])` | 拒绝执行（软命中抛错；logger 的 chcp 本地调用已知豁免由 try/catch 降级，见差异表 #9） | 命中被拦 | **exit=1** |
| 10 | `selftest:net-ws` | `new WebSocket('ws://127.0.0.1:8787')` | 构造即拒绝 | 命中被拦 | **exit=1** |
| 11 | `selftest:net-tls` | `tls.connect({host:'127.0.0.1',port:8787})` | 出站归一化精确匹配，未登记即拒 | 命中被拦 | **exit=1** |
| 12 | `selftest:net-dgram` | `dgram.createSocket('udp4')` 后 `sock.bind(0)` | UDP 通道拒绝 | 命中被拦 | **exit=1** |
| 13 | `selftest:net-worker` | `new worker_threads.Worker('console.log(1)',{eval:true})` | 旁路通道（线程内无网守）fail-closed | 命中被拦 | **exit=1** |

**汇总**：13/13 命中被拦，退出码全部为 1（用例 6 的 1 来自 close 后访问被拦的抛错，属预期非零）。逐条实际结果与退出码原文见 §3 ⑩ 行（验收台逐条打印 `exit=N 命中被拦`）。

**能力边界（诚实声明）**：以上验证的是 **Node 进程层网络入口**（fetch/http/https/net/tls/dgram/WebSocket/dns/child_process/worker_threads）。原生扩展直调系统网络栈不在覆盖范围；如需完全禁出网，需 OS 防火墙/沙箱层独立验证（T0 之外，全文不宣称 OS 级）。

---

## 5. 三个 smoke 断言计数与改造前基线对照

### 5.1 计数对照

| smoke | 改造前基线 | 基线出处（均为 T0 之前形成/记录的文档） | T0 后实测（2026-11-13） | 对照结论 |
|---|---|---|---|---|
| `smoke:lint` | **116 项** | ① `T0-SAFETY-SUPPLEMENT.md` §验收2「smoke:lint 116 项（2026-11-12 日志）」（验收标准本身，T0 前定稿）② `docs/WRITING-PIPELINE.md`「体检 + 提示词注入 + 赛道模板隔离 + 后处理（116 项）」③ `docs/TRACK-FORM-RESEARCH.md`「smoke:lint 116 项 ✓」 | **116 项全 PASS**（附录 B 逐条全录，尾行「通过 116 项」） | **一致，计数不降** |
| `smoke:style` | **33 项断言** | ① `T0-SAFETY-SUPPLEMENT.md` §验收2「smoke:style 33 项」② `docs/TRACK-FORM-RESEARCH.md`「smoke:style 33 项 ✓」③ `docs/DEVLOG.md`（2026-11-12）「冒烟补 4 项…`smoke:style` 29 → **33 项**」 | **33 项断言全 PASS**（附录 C 逐条全录，尾行「全部通过（33 项断言）」） | **一致，计数不降** |
| `smoke:angles` | **30 项（18 组）当场计数** | ① `T0-SAFETY-SUPPLEMENT.md` §验收2「smoke:angles 当场计数（18 组）」② `docs/DEVLOG.md`「`smoke:angles` 30 项全过」（历史回归记录） | **SMOKE ANGLES: ALL PASS (30 项)**（附录 D 逐条全录；输出分 1–18 组共 30 条断言） | **一致，计数不降**（当场计数=30） |

### 5.2 基线溯源补充（计数历史轨迹，证明 116/33/30 是 T0 前的现行值）

`docs/DEVLOG.md` 计数轨迹（均为 T0 前记录）：`smoke:lint` 83→90（DEVLOG「加 7 条回归断言」）→107（2026-11-12）→**116**（2026-11-12 深夜写作链路重构后，WRITING-PIPELINE/TRACK-FORM-RESEARCH 均记录 116）；`smoke:style` 27→29→**33**（DEVLOG「29 → 33 项」）；`smoke:angles` 长期 **30 项**（18 组）。T0 改造**不触碰任何断言行**，计数无变化通道（见 5.3）。

### 5.3 断言零改动的独立证据（diff 白名单，全文见附录 F）

```
$ git diff --stat server/scripts/smoke-lint.ts server/scripts/smoke-angles.ts server/scripts/smoke-style-prompts.ts
 server/scripts/smoke-angles.ts | 1 +
 server/scripts/smoke-lint.ts   | 1 +
 （smoke-style-prompts.ts 无 diff）
```

- `smoke-lint.ts` / `smoke-angles.ts`：各 **1 行插入**，内容为 `app.listen(0)` 之后的 `__SMOKE_NET__.register(server)` 胶水（不改变任何断言、夹具、期望值）；完整 diff 逐字见附录 F.2。
- `smoke-style-prompts.ts`：**零改动**。
- 结论：**原有测试覆盖范围零缩减**（断言逐条保留、计数不降、无删除行）。

---

## 6. 原始 dev.db 指纹对照（完整 SHA-256 / 大小 / 前后比对）

**被测对象**：`server/prisma/dev.db`（真实生产库，全程只读）。

| 项 | 值 |
|---|---|
| SHA-256（完整） | `fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5` |
| 文件大小 | `974848` 字节 |
| mtime | `2026-11-12 13:20:05.027723900 +0800`（= 运行器内 `mtime=1794460805028` 毫秒） |
| WAL/SHM | `REAL-WAL = absent`（无 -wal/-shm 伴随文件，比对面 = dev.db 本体） |

**前后指纹对照（本次验收重跑全程）**：

| 时点 | 采集方式 | SHA-256 | size | mtime |
|---|---|---|---|---|
| 重跑前（12:57，四连/verify 之前） | `sha256sum prisma/dev.db` + `stat` | `fea0f123…fc3f5` | 974848 | 2026-11-12 13:20:05 |
| 每轮 run 启动时 | 运行器 `REAL-FP` 行（lint/style/angles/verify 各轮，共 10+ 轮，输出逐字一致） | `fea0f123…fc3f5` | 974848 | `mtime=1794460805028` |
| 每轮 run 结束时 | 运行器 `REAL-DB FINGERPRINT MATCH（原库零写入）` 断言（任一轮不一致即作废报警、退出码非零） | 同上 | 同上 | 同上 |
| verify ⑦（验收台快照两次比对） | `fingerprintRealDb()` 前后各一次 | `fea0f123…fc3f5` | 974848 | 同上 |
| 重跑后（13:05，全部测试跑完） | `sha256sum prisma/dev.db` + `stat` | `fea0f123…fc3f5` | 974848 | 2026-11-12 13:20:05 |

**结论**：真实库前后 SHA-256、大小、mtime **完全一致**（mtime 未变是零写入的强证据——任何写入都会刷新 mtime）。采集命令输出留档于附录 A–E 各轮 `REAL-FP`/`MATCH` 行。

**附：库目录残留复核**（`ls prisma/ | grep dev.smoke`、`ls var/tmp/ | grep smoke`）：跑后**均为空**（`residual-check-done`），隔离库与临时内容目录零残留。

---

## 7. 四连测试与 typecheck 完整终端输出

执行方式：串行、经隔离运行器（命令名不变）、未接 `| head`。以下为逐字全录（附录 A–D 同源，原始文件 `T0-ACCEPTANCE-LOGS/1-typecheck.txt` … `4-smoke-angles.txt`）。

### 7.1 汇总（先给结论行，全文在附录）

| 命令 | 结果 | 关键输出 | 退出码 |
|---|---|---|---|
| `npm run typecheck` | ✅ | `> tsc --noEmit` 无任何报错 | **0** |
| `npm run smoke:lint` | ✅ | `ISO-VERIFY PASS` → 逐条断言 → `通过 116 项` → `CHILD EXIT = 0` → `CLEANUP ok` → `REAL-DB FINGERPRINT MATCH` | **0** |
| `npm run smoke:style` | ✅ | `ISO-VERIFY PASS` → 逐条断言 → `全部通过（33 项断言）` → `CHILD EXIT = 0` → `CLEANUP ok` → `REAL-DB FINGERPRINT MATCH` | **0** |
| `npm run smoke:angles` | ✅ | `ISO-VERIFY PASS` → 逐条断言 → `SMOKE ANGLES: ALL PASS (30 项)` → `CHILD EXIT = 0` → `CLEANUP ok` → `REAL-DB FINGERPRINT MATCH` | **0** |

typecheck 完整输出（全文仅 5 行，直接全录）：

```
$ npm run typecheck
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 typecheck
> tsc --noEmit

EXIT_CODE=0
```

**三条 smoke 的完整逐条断言输出（116 + 33 + 30 条逐字全录）见附录 B / C / D**（含运行器头（REAL/ISOLATED/ENV-ALLOW/NET/WRITER-SCAN/REAL-FP/ISO-VERIFY）、网守加载行、鉴权旁路提示行、pino 请求日志行——一并全录，不删节）。

---

## 8. git diff --stat、git diff 与新增文件清单（完整）

完整逐字输出见附录 F（`git diff --stat` + `git diff` 全文）与附录 G（31 项 untracked），原始留档 `T0-ACCEPTANCE-LOGS/6-git-diff-stat.txt`、`7-new-files.txt`、`8-smoke-whitelist-diff.txt`。要点：

```
$ git diff --stat
 .gitignore                     |  3 ++
 CHANGELOG.md                   | 38 ++++++++++++++++++++
 docs/DEVLOG.md                 | 81 ++++++++++++++++++++++++++++++++++++++++++
 server/package.json            |  8 +++--
 server/scripts/smoke-angles.ts |  1 +
 server/scripts/smoke-lint.ts   |  1 +
 6 files changed, 129 insertions(+), 3 deletions(-)
```

修改面 = **6 个文件**：2 个测试脚本（各 +1 胶水行）、1 个 npm 脚本、1 个 ignore 规则、2 个文档回写。`git diff` 中**不存在** `server/src/**`、`prisma/schema*.prisma`、`config/**`、`deploy/**`、`web/**` 的任何改动（附录 F 全文可核）。

---

## 9. 放行机制确认：无 `SMOKE_ALLOW_LIVE_DB`、无 `SMOKE_NET_ALLOW`（grep 实证）

**确认：T0 实现中不存在任何真实库放行开关、网络手工放行开关，也没有等价的隐藏降级通道。** 校验失败/守卫异常一律 `exit(1)`。

**实证 1（全仓 grep `SMOKE_ALLOW_LIVE_DB|SMOKE_NET_ALLOW|ALLOW_LIVE|NET_ALLOW|SMOKE_SKIP|SMOKE_BYPASS|SMOKE_NO_GUARD`）**：命中全部位于两类位置，**零实现代码**：

- 设计文档的「不提供/删除」表述：`T0-SAFETY-SUPPLEMENT.md` L30/L67/L124/L133、`T0-V3-REVISION-DIFF.md` L11、`STAGE0-IMPLEMENTATION-PLAN-V2.md` L42/L122、本报告自述；
- 代码注释里的否定声明：`smoke-net-guard.mjs` L30「无任何手工放行入口（不实现 SMOKE_NET_ALLOW）」、`smoke-isolated.ts` L10「无 SMOKE_ALLOW_LIVE_DB 之类放行开关」。

**实证 2（scripts 目录 grep `process.env.SMOKE*` 等）**：全部 `SMOKE_*` 命中为——`SMOKE_NO_AUTH`（见下披露）、`SMOKE_PREFIX`/`SMOKE_TRACK`/`SMOKE_KEYS` 常量（夹具命名）、`__SMOKE_ISO_OK__`（守卫放行标记）。**没有任何一处读取 `SMOKE_ALLOW_LIVE_DB` 或 `SMOKE_NET_ALLOW`**，也没有任何 if 分支按此类变量放行。

**透明披露两个既有/内部开关的性质（均非 DB/网络放行）**：

1. `SMOKE_NO_AUTH=1`：**T0 之前就存在**的冒烟 HTTP 鉴权旁路（`smoke-lint/angles/models/cover` 等脚本自身置位；auth 层明示「仅限冒烟，生产环境无效」）。它绕过的是 `/api/*` 的管理令牌校验，**不绕过** db 守卫、不绕过网守、不影响隔离库判定。T0 未新增、未扩大其用途。
2. `__SMOKE_ISO_OK__`：db 守卫通过后才置 `'1'` 的**内部放行标记，默认关闭**；网守 `register()` 与胶水行依赖它拒绝未引导运行。这是 fail-closed 闸门，不是绕过开关。

**反向链路独立验证**：验收②（真实库三形态被拒）、③（env 失败即退）、⑩（13 条网络反向全拦）本身就是「想放行也放不了」的实测证据（§3）。

---

## 10. 尚未隔离的 smoke 命令清单（遗留风险登记 · 禁止直接执行）

T0 授权范围仅含三条标准冒烟命令（`smoke:lint` / `smoke:style` / `smoke:angles`）。以下 `package.json` 命令**仍直跑真实 `dev.db`，不经隔离运行器、不受 db 守卫/网守保护**，登记为遗留风险，**禁止在未备份/未隔离的情况下直接执行**（本清单即风险台账；处置=后续阶段决定是否纳入隔离运行器，需另行授权）：

| 命令 | 脚本 | 风险说明 |
|---|---|---|
| `npm run smoke:models` | `smoke-models.ts` | 直跑真实库（历史事故源：`--force` 曾清光模型） |
| `npm run smoke:cover` | `smoke-cover.ts` | 直跑真实库 |
| `npm run smoke:migrate` | `smoke-migrate.ts` | 直跑真实库（迁移类，写风险高） |
| `npm run smoke:bulk` | `smoke-bulk-delete.ts` | 直跑真实库（删除类） |
| `npm run verify:bulk` | `verify-bulk-delete.ts` | 已自带隔离库副本（其内部自隔离），但不经统一运行器 |
| `npm run verify:zodiac` | `verify-zodiac.ts` | 直跑 |
| `npm run verify:length` | `verify-length.ts` | 直跑 |
| `npm run smoke:auth` | `smoke-auth.ts` | 直跑 |
| `npm run smoke:p2` | `smoke-p2.ts` | 直跑 |
| `npm run smoke:comic-align` | `smoke-comic-align.ts` | 直跑 |
| `npm run smoke:comic-qc` | `smoke-comic-qc.ts` | 直跑 |
| `npm run smoke:comic-fallback` | `smoke-comic-fallback.ts` | 直跑 |
| `npm run smoke:quote-card` | `smoke-quote-card.ts` | 直跑 |
| `npm run smoke:users` | `smoke-users.ts` | 直跑 |
| `npm run smoke:ownership` | `smoke-ownership.ts` | 直跑 |
| `npm run smoke:automation` | `smoke-automation.ts` | 直跑 |

**执行红线（沿用项目铁律）**：「会写库的验证一律先复制 dev.db 到隔离库再跑」；上述命令如确需使用，先备份 `dev.db`（`*.db.bak-*` 已 ignore）并经用户明确授权。另：`prune:old`（清理旧文风，要求先备份）与 `demo:write` 为工具脚本，同样写真实库，一并禁止随意执行。

---

## 11. 与 T0-SAFETY-SUPPLEMENT.md v3 设计的差异（实测修正，均为守卫/运行器内部实现）

| # | 设计表述 | 实测发现与修正 | 性质 |
|---|---|---|---|
| 1 | 空库证明逐表行数=0 | `OAAccount` 模型带 `@@map("Account")`，物理表名是 `Account`；表名清单必须用物理表名（首跑 ISO-VERIFY ③ 缺表实证） | 实现修正 |
| 2 | 清理矩阵覆盖「普通异常」 | `die()` 走 `process.exit` 会跳过 `finally` 清理（首跑失败残留实证）→ `die()` 自行 kill 子进程 + 清理，并加 `process.on('exit')` 同步兜底 | 实现修正 |
| 3 | dns「命中即抛错」 | Node 的 `Server.listen→lookupAndListen` 无条件走模块级 `dns.lookup` 且回调**恒异步**（即便数值 IP），导致 `listen()` 返回时 `address()` 为 null，破坏冒烟脚本（与原生无 host `listen(0)` 同步 bind 对齐的）同步取端口语义 → 对**数值 IP 字面量**在调用栈内同步短路回调（等价 getaddrinfo 数值短路、零解析流量）；**域名照旧命中抛错**（net-dns 反例不变） | 语义细化（不放行任何域名/解析流量） |
| 4 | listen 注入同步 lookup 保同步 bind | 实测 **listen 不支持 `options.lookup`**（与 connect 不同，lookupAndListen 直调 `dns.lookup`）→ 同步 bind 语义改由 #3 保证；listen 封装只做规则 1/2 校验与 host 强制 | 实现修正 |
| 5 | 规则 4「出站归一化精确匹配禁别名」 | connect 系支持自定义 `options.lookup`，可把已匹配的数值 host 重定向解析到任意地址（精确匹配旁路）→ connect/tls 强制改写 lookup 为仅数值直通，实际连接地址恒等于匹配地址 | 加严（更贴合规则 4 本意） |
| 6 | （设计未预见） | Node 内部以 `normalizeArgs` 预归一化 `[options, cb]` **数组形态**调 `socket.connect`（undici/fetch 实证），守卫先展开再校验，否则误报「端口 0」 | 实现修正 |
| 7 | 「dns.*（含 promises）」fail-closed | 补全 `dns.Resolver` / `dns.promises.Resolver` 实例通道（c-ares 独立通道）封装 | 覆盖补全 |
| 8 | 三 smoke 文件「预计仅端口登记一行」 | `smoke-style-prompts.ts` **零改动**（无 `app.listen`，胶水也不需要）——落在「零改动或仅一行」白名单内 | 符合白名单 |
| 9 | child_process 封装命中策略 | 软命中（抛错拒绝执行、不钉死退出码）：`src/logger.ts` win32 import 时 `execSync('chcp 65001')` 自带 try/catch 降级，是已知本地无网络能力调用（守卫头注释已声明；smoke 输出中的 `BLOCKED child_process.execSync → … chcp 65001` 即此，不影响断言） | 已文档化 |
| 10 | （实现期缺陷修复） | `smoke-run.ts`：target→模块映射修正（style→`smoke-style-prompts.ts`）；hang 自检加 keep-alive（裸 await 会让进程 code 13 自退）；`smoke-isolated.ts`：`scanWriters` 接入 `probePort(8787)`；`onSignal` 等子进程真正退出后再删库（Windows SQLite 句柄 EBUSY）；清理/残留检测正则补 `-journal` 后缀 | 实现修正 |
| 11 | 「回写 docs/PROGRESS.md」 | 项目无 `docs/PROGRESS.md`，进度台账真源是 `docs/DEVLOG.md`（文件自述「进度台账唯一真源」）→ 本次回写 DEVLOG + CHANGELOG | 名称差异，实质完成 |

**不变量核对**：隔离库=schema-only 空库、真实数据零复制 ✅；验证链 4 步 ✅；零绕过 ✅；env 显式白名单 ✅；原库前后指纹比对 ✅；五路径清理 + SIGKILL 恢复文档化 ✅；网络双层诚实表述 ✅（全部输出标注 Node 层）。

---

## 12. 遗留问题

1. **scripts/ 不在 typecheck 覆盖内**：`tsconfig` include 仅 `src/**/*.ts`，四件套靠 `--experimental-strip-types` 运行时执行（不做类型检查）。是否纳入 tsc 范围属后续决策（不在 T0 授权内）。
2. **Windows 信号语义**：跨进程 SIGINT/SIGTERM 无法对运行中的 Node 进程真发（硬终止），验收⑧的信号路径用 runner 自触发处理器模拟（`--simulate-signal`）；真实 Ctrl+C 场景由同一 `onSignal` 代码路径覆盖。
3. **SIGKILL 残留**：无法保证清理（如实声明），恢复命令 `npm run smoke:prune-iso` 已提供并验收实证（⑧：残留暴露=true → prune 恢复=true）；残留只可能是 `server/prisma/dev.smoke-*.db`（含 -journal/-wal/-shm）及 `server/var/tmp/smoke-iso-*` 临时目录，绝不碰原库。
4. **网络能力边界**：Node 进程层入口隔离已验证并反向测试（13 条）；原生扩展直调系统网络栈不在覆盖范围——如需完全禁出网，需 OS 防火墙/沙箱层独立验证（T0 之外）。
5. **V1 历史文档**（`docs/AUDIT-REPORT.md` / `RESTRUCTURE-CHECKLIST.md` / `RESTRUCTURE-PLAN-V1.md`）按 README 口径「保留不删、不得引用」，仍留在仓库；本报告零引用。
6. **web 端四连未跑**：T0 未触碰 `web/`；`npm run build` 与 vue-tsc 两遍串行属 T8 阶段收尾门禁。
7. **其他 smoke 脚本未改道**：见 §10 风险台账（16 条命令 + 2 条工具脚本），**禁止直接执行**；是否纳入隔离运行器属 T0 之后的决策。
8. **`SMOKE_NO_AUTH` 鉴权旁路为既有机制**（§9 披露）：与本次隔离化无关，但同属冒烟安全面，建议后续阶段一并评估收敛（不在 T0 授权内）。

---

## 13. 四项确认（逐条，均有证据）

1. **没有修改 `server/src/**`、Prisma Schema、真实数据库、生产配置和业务断言** —— ✅ 确认。
   证据：`git diff --stat` 修改面仅 6 文件（§8/附录 F 全文可核，无 src/schema/config/deploy/web 任何条目）；`smoke-lint/angles` diff 仅 1 行胶水、`smoke-style-prompts` 零 diff（附录 F.2）；真实库指纹前后一致且 mtime 未变（§6）；`AUTO_PUBLISH` 等生产配置未出现在任何 diff 中。
2. **没有减少原有测试覆盖范围** —— ✅ 确认。
   证据：断言计数 116/33/30 与改造前基线逐一相等（§5，基线出处均为 T0 前文档）；diff 为纯插入（+1×2），无任何删除行；三条 smoke 输出逐条 PASS 全量保留（附录 B–D）。
3. **网络隔离的能力描述仍限定为 Node 进程层，不宣称 OS 级完全隔离** —— ✅ 确认。
   证据：本报告头部能力声明、§2、§4 能力边界、运行器每轮输出 `NET = Node 层网络入口隔离（smoke-net-guard），非 OS 级全网络隔离`、网守加载行、验收④⑩标签「Node 层」——全部一致，无任何 OS 级/完全隔离表述。
4. **所有验收结论都有实际输出或文件证据支撑，不用推断代替测试结果** —— ✅ 确认。
   证据：§3（verify 逐字全录）、§4（13 条逐条退出码，出自 ⑩ 实测行）、§5（计数出自附录 B–D 尾行 + 基线文档行号）、§6（指纹命令输出与运行器 REAL-FP/MATCH 行）、§7（四连逐字全录附录 A–D）、§8（diff 全文附录 F）、§9（grep 实证）、§10（package.json 脚本实查）。原始留档 `T0-ACCEPTANCE-LOGS/1–8` 共 8 个 txt 随报告一并提交。

---

## 14. 结论

T0 全部交付并经**正式验收重跑**复核：四件套（795/106/439/184 行）+ 胶水 2 行 + 命令改道 + ignore 规则；四连全绿（typecheck / lint **116** / style **33** / angles **30**）；十项验收 **10/10**；13 条网络反向用例全部命中被拦（exit=1）；真实库指纹全程 `fea0f123…fc3f5`（size=974848，mtime 未变）零写入；放行机制 grep 实证为空；未隔离命令已登记风险台账并标红禁止执行。**按授权约定停下，等用户与 ChatGPT 完成 T0 正式验收；未经明确授权不开始 T1、不修改 UI、不改任何代码。**

---

## 附录 A · typecheck 完整输出

```
$ npm run typecheck
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 typecheck
> tsc --noEmit

EXIT_CODE=0
```

（原始留档：`T0-ACCEPTANCE-LOGS/1-typecheck.txt`）

## 附录 B · smoke:lint 完整输出（116 项逐条全录）

```
$ npm run smoke:lint
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 smoke:lint
> node --experimental-strip-types scripts/smoke-isolated.ts run lint

════════════════════════════════════════════════════════
[t0] RUN target=lint  timeout=300000ms
[t0] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[t0] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidletmks3.db
[t0] CONTENT   = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\var\tmp\smoke-iso-mweidletmks3\content
[t0] ENV-ALLOW = PATH, SYSTEMROOT, WINDIR, TEMP, TMP, LANG, TZ + DATABASE_URL/CONTENT_DIR/NODE_ENV（其余剥离：APP_SECRET_KEY、一切 *TOKEN/*SECRET/*KEY、代理变量）
[t0] NET       = Node 层网络入口隔离（smoke-net-guard），非 OS 级全网络隔离
[t0] NOTE Windows 下隔离库文件权限由 ACL 继承（POSIX 场景 chmod 0600）
[t0] WRITER-SCAN …
[t0] WRITER-SCAN ok（8787 未监听 / 无 scheduler 进程）
[t0] REAL-FP  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db sha256=fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5 size=974848 mtime=1794460805028
[t0] REAL-WAL = absent
[t0] ISO-CREATE prisma db push → dev.smoke-mweidletmks3.db
[t0] ISO-CREATE ok（schema-only）
[t0] ISO-VERIFY ② database_list = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidletmks3.db
[t0] ISO-EMPTY tables=15/15 rows=0
[t0] ISO-VERIFY PASS（落盘 / 连接实测 / 表结构 / 行数=0）
[t0] ENV-INJECT readback ok
[t0] SPAWN node --import file:///K:/WorkBuddy%20WorkSpace/project/wechat-pipeline-cloud/server/scripts/smoke-net-guard.mjs --experimental-strip-types K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\scripts\smoke-run.ts lint
[smoke-net-guard] loaded（Node 层网络入口隔离，非 OS 级全网络隔离）pid=20972
[smoke-db-guard] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[smoke-db-guard] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidletmks3.db
[smoke-db-guard] PASS（命名 / 路径归一反真实库 / 目录 / 落盘 校验通过）
[smoke-run] import ./smoke-lint.ts …
[smoke-net-guard] BLOCKED child_process.execSync → 子进程不在冒烟放行范围：chcp 65001
— 提示词注入 —
  PASS  1 提示词：赛道名进来了
  PASS  1 提示词：没配文风时不虚构文风块
  PASS  1 提示词：选题主题与角度在末尾
  PASS  1 提示词：星座 / 育儿 的 system 不是同一份
  PASS  1 提示词：星座 system 要求群像覆盖
  PASS  1 提示词：育儿 system 要求成人世界类比
  PASS  1 提示词：星座 system 仍带段数锚（模板没写数字时由代码补）
  PASS  1 提示词：星座 system 不再要求复合长段落
  PASS  1 提示词：赛道 tail 进了 user 消息
  PASS  1 提示词：不同赛道的 tail 不一样
  PASS  1 提示词：tail 漏写数字时程序补硬锚
  PASS  1 提示词：模板变量替换
  PASS  1 提示词：未定义变量被报出来
  PASS  1 提示词：全局块已退役（【结构主线规范）
  PASS  1 提示词：全局块已退役（【段落形态规范】）
  PASS  1 提示词：全局块已退役（【细腻度规范】）
  PASS  1 提示词：全局块已退役（【句式禁忌规范）
  PASS  1 提示词：全局块已退役（【强调标注规范）
  PASS  1 提示词：全局块已退役（【去AI味规范）
  PASS  1 提示词：本赛道文风块进来了
  PASS  1 提示词：赛道行原文进来了
  PASS  1 提示词：写作规范·段落形态进来了
  PASS  1 提示词：写作规范·强调标注进来了
  PASS  1 提示词：写作规范·句式补充进来了
  PASS  1 提示词：去AI味预留小节不进 prompt
  PASS  1 提示词：骨架卡整块进 tail
  PASS  1 提示词：未知赛道不注入文风块但流程不崩
  PASS  1 提示词：小标题区间取自 constants（3-4）
  PASS  1 提示词：段落锚取自 constants（17-19 段）
  PASS  1 提示词：目标字数取自 constants（1800-2200）
  PASS  1 提示词：旧「每节 6-7 段」配额已清除
  PASS  1 提示词：旧「结尾 1-2 段」歧义措辞已清除
  PASS  1 提示词：tail 不再把门禁 1300-2300 当目标
  PASS  1 提示词：style_dna 旧「至少有一节只有 2 段」已清除
  PASS  1 提示词：style_dna 旧「某一节只写 250 字」已清除
  PASS  1.6 未配规范时不虚构星座块
  PASS  1.6 全局块已退役（【结构主线规范）
  PASS  1.6 全局块已退役（【细腻度规范）
  PASS  1.6 全局块已退役（【去AI味规范）
  PASS  1.6 星座写作规范·段落形态进了 prompt
  PASS  1.6 星座写作规范·句式补充进了 prompt
  PASS  1.6 赛道行里的分组纪律进了 prompt
  PASS  1.6 星座禁忌进了 prompt
  PASS  1.6 不传赛道模板时不泄漏别的赛道物件
  PASS  1.6 传入星座模板后用的是星座收尾
  PASS  1.6 星座稿缺星象词会被提示
  PASS  1.6 非星座赛道不查星座专属项
  PASS  1.6 教科书腔会被提示
  PASS  1.6 否定框架：「与其X不如Y」也被拦
— 模型产出清洗 —
  PASS  1.5 缺 <p>：补出段落标签
  PASS  1.5 缺 <p>：正文一个字没丢
  PASS  1.5 缺 <p>：每个裸文本各成一段
  PASS  1.5 缺 <p>：补齐后体检不再误报字数为 0
  PASS  1.5 混合：裸段落被补上
  PASS  1.5 混合：原有段落没被重复包裹
  PASS  1.5 围栏：剥离且不破坏结构
  PASS  1.5 幂等：正常文章洗一遍仍通过体检
  PASS  1.5 无标题：不伪造结构
  PASS  1.5 强标题：救回成 h1
  PASS  1.5 强标题：救回后仍是合法文章结构
  PASS  1.5 强标题：正文里的 strong 不被误改
— 旧文风必须被拦 —
  PASS  2 旧文风：不通过
  PASS  2 旧文风：小标题数违规被拦
  PASS  2 旧文风：字数不足被拦
  PASS  2 旧文风：提示「复合长段落不足」
  PASS  2 旧文风：提示「一句一段过多」
  PASS  2 旧文风：统计里长段落为 0
  PASS  2 旧文风：摘要可读
— 新文风必须放行 —
  PASS  3 新文风：通过
  PASS  3 新文风：无 error
  PASS  3 新文风：3 个小标题
  PASS  3 新文风：字数落在门禁区间
  PASS  3 新文风：长段落占比 ≥ 1/3
  PASS  3 新文风：一句一段占比 ≤ 1/2
— 单项规则 —
  PASS  4 破折号：拦
  PASS  4 否定框架：拦
  PASS  4 否定框架：报告带命中片段（定向修补要用）
  PASS  4 破折号：报告带命中片段
  PASS  4 概括句：多处才提示（不硬拦）
  PASS  4 否定框架：换皮写法（不需要X而是Y）也拦
  PASS  4 超长段落：存在且只是提示级
  PASS  4 超长段落：不进 error 清单（不拦推送）
  PASS  4 超长段落：同时被算作复合长段落
  PASS  4 正常段落：不提示超长
  PASS  4 空正文：不通过且不崩
  PASS  4 红字金句：缺失只提示不拦
[smoke-net-guard] listen(0) 未指定 host → 强制绑定 127.0.0.1（规则 1）
[smoke-net-guard] REGISTERED 127.0.0.1:62828
— 段落重排 —
  PASS  7 重排：长段落被切开
  PASS  7 重排：无段落破 150 字
  PASS  7 重排：小标题数量不变
  PASS  7 重排：内容不跨小标题
  PASS  7 重排：加粗不被拆破
  PASS  7 重排：哨兵无残留
  PASS  7 重排：非预期输入原样返回
  PASS  7 重排：收尾引号不被切到下一节开头
  PASS  7 重排：引号成对
  PASS  7 重排：阶梯跨节连续（两节都有内容）
  PASS  7 重排：两节段长节奏不相同（否则是自己制造模板感）
  PASS  7 强调：嵌套加粗被拍平
— 省略号补齐 —
  PASS  8 省略号：不足时补 2 处
  PASS  8 省略号：补完达到 2 处
  PASS  8 省略号：不动加粗里的句子
  PASS  8 省略号：只改句末标点、一个字都没增删
  PASS  8 省略号：够了就不再加（幂等）
  PASS  8 省略号：没有合适候选就原样返回
— 结尾钩子 —
  PASS  9 结尾钩子：没有提问会被提示
  PASS  9 结尾钩子：有回扣物件的提问不提示
— HTTP：体检接口与推送门禁 —
[auth] SMOKE_NO_AUTH=1：鉴权已旁路（仅限冒烟，生产环境无效）
{"level":30,"time":"2026-11-13T05:00:46.789Z","env":"development","changed":["v:星座:structure"],"msg":"文风种子已升级到 v5（星座群像字数算术）"}
{"level":30,"time":"2026-11-13T05:00:47.302Z","env":"development","reqId":1,"ip":"127.0.0.1","msg":"GET /api/articles/1/lint -> 200 (919ms)"}
  PASS  5 HTTP：GET /:id/lint 200
  PASS  5 HTTP：旧文风体检不通过
  PASS  5 HTTP：错误码包含 sections
{"level":40,"time":"2026-11-13T05:00:47.317Z","env":"development","articleId":1,"errors":["sections","chars"],"msg":"成稿体检未通过，已拦截推送"}
{"level":30,"time":"2026-11-13T05:00:47.317Z","env":"development","reqId":2,"ip":"127.0.0.1","msg":"POST /api/articles/1/push -> 200 (4ms)"}
  PASS  5 HTTP：推送被门禁拦下（ok=false）
  PASS  5 HTTP：reason=lint_failed
  PASS  5 HTTP：响应带上体检报告
  PASS  5 HTTP：拦下时返回 200 而非 500（失败收敛）
  PASS  5 HTTP：被拦的文章仍是 draft
{"level":30,"time":"2026-11-13T05:00:47.373Z","env":"development","reqId":3,"ip":"127.0.0.1","msg":"GET /api/articles/2/lint -> 200 (2ms)"}
  PASS  6 HTTP：新文风体检通过
{"level":30,"time":"2026-11-13T05:00:47.427Z","env":"development","reqId":4,"ip":"127.0.0.1","msg":"GET /api/articles/3/lint -> 200 (1ms)"}
  PASS  6 HTTP：漫画产线不做文章体检（lint=null）

通过 116 项
[t0] CHILD EXIT = 0
[t0] CLEANUP ok（隔离库与临时内容目录已删除）
[t0] REAL-DB FINGERPRINT MATCH（原库零写入）
EXIT_CODE=0
```

（原始留档：`T0-ACCEPTANCE-LOGS/2-smoke-lint.txt`）

## 附录 C · smoke:style 完整输出（33 项断言逐条全录）

```
$ npm run smoke:style
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 smoke:style
> node --experimental-strip-types scripts/smoke-isolated.ts run style

════════════════════════════════════════════════════════
[t0] RUN target=style  timeout=300000ms
[t0] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[t0] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidyddjke8.db
[t0] CONTENT   = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\var\tmp\smoke-iso-mweidyddjke8\content
[t0] ENV-ALLOW = PATH, SYSTEMROOT, WINDIR, TEMP, TMP, LANG, TZ + DATABASE_URL/CONTENT_DIR/NODE_ENV（其余剥离：APP_SECRET_KEY、一切 *TOKEN/*SECRET/*KEY、代理变量）
[t0] NET       = Node 层网络入口隔离（smoke-net-guard），非 OS 级全网络隔离
[t0] NOTE Windows 下隔离库文件权限由 ACL 继承（POSIX 场景 chmod 0600）
[t0] WRITER-SCAN …
[t0] WRITER-SCAN ok（8787 未监听 / 无 scheduler 进程）
[t0] REAL-FP  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db sha256=fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5 size=974848 mtime=1794460805028
[t0] REAL-WAL = absent
[t0] ISO-CREATE prisma db push → dev.smoke-mweidyddjke8.db
[t0] ISO-CREATE ok（schema-only）
[t0] ISO-VERIFY ② database_list = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidyddjke8.db
[t0] ISO-EMPTY tables=15/15 rows=0
[t0] ISO-VERIFY PASS（落盘 / 连接实测 / 表结构 / 行数=0）
[t0] ENV-INJECT readback ok
[t0] SPAWN node --import file:///K:/WorkBuddy%20WorkSpace/project/wechat-pipeline-cloud/server/scripts/smoke-net-guard.mjs --experimental-strip-types K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\scripts\smoke-run.ts style
[smoke-net-guard] loaded（Node 层网络入口隔离，非 OS 级全网络隔离）pid=22984
[smoke-db-guard] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[smoke-db-guard] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweidyddjke8.db
[smoke-db-guard] PASS（命名 / 路径归一反真实库 / 目录 / 落盘 校验通过）
[smoke-run] import ./smoke-style-prompts.ts …
[smoke-net-guard] BLOCKED child_process.execSync → 子进程不在冒烟放行范围：chcp 65001
style-prompts smoke

[1] 播种与清单
{"level":30,"time":"2026-11-13T05:00:59.510Z","env":"development","changed":["v:星座:structure"],"msg":"文风种子已升级到 v5（星座群像字数算术）"}
  PASS  总纲已播种
  PASS  赛道文体已播种（育儿）
  PASS  变体行已播种（v:global:title）
  PASS  变体行已播种（v:职场:length）
  PASS  重复播种不增加行数

[2] 读写与默认值
  PASS  upsert 返回 key
  PASS  get 往返一致
  PASS  global 不可删
  PASS  篇幅变体有出厂默认值
  PASS  默认值含总纲与变体

[2.5] 变体分隔符（骨架卡）与写作规范分节
  PASS  有 --- 时按块切（2 条，不是 5 条）
  PASS  骨架卡整块保留换行
  PASS  无 --- 时按行切（兼容旧数据）
  PASS  s: 按 ## 切小节

[3] 变体轮换与篇幅档解析
  PASS  篇幅档解析
  PASS  非法篇幅档拒绝
  PASS  游标递增
  PASS  标题轮换（3 条周期）
  PASS  篇幅档解析出锚
  PASS  篇幅档轮换
  PASS  游标可读回
  PASS  读游标不推进

[4] prompt 注入
  PASS  loadStyleForTrack 取到赛道文体
  PASS  loadGlobalPrompt 取到总纲
  PASS  总纲进 prompt
  PASS  赛道文风进 prompt
  PASS  变体段进 prompt
  PASS  标题公式进 prompt
  PASS  结构骨架进 prompt
  PASS  篇幅档进 prompt
  PASS  无配置时回落兜底
  PASS  system 篇幅锚跟随变体
  PASS  清理完成

全部通过（33 项断言）
[t0] CHILD EXIT = 0
[t0] CLEANUP ok（隔离库与临时内容目录已删除）
[t0] REAL-DB FINGERPRINT MATCH（原库零写入）
EXIT_CODE=0
```

（原始留档：`T0-ACCEPTANCE-LOGS/3-smoke-style.txt`）

## 附录 D · smoke:angles 完整输出（30 项逐条全录）

```
$ npm run smoke:angles
npm warn Unknown user config "home". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> wechat-pipeline-server@0.1.0 smoke:angles
> node --experimental-strip-types scripts/smoke-isolated.ts run angles

════════════════════════════════════════════════════════
[t0] RUN target=angles  timeout=300000ms
[t0] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[t0] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweieaunnf6v.db
[t0] CONTENT   = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\var\tmp\smoke-iso-mweieaunnf6v\content
[t0] ENV-ALLOW = PATH, SYSTEMROOT, WINDIR, TEMP, TMP, LANG, TZ + DATABASE_URL/CONTENT_DIR/NODE_ENV（其余剥离：APP_SECRET_KEY、一切 *TOKEN/*SECRET/*KEY、代理变量）
[t0] NET       = Node 层网络入口隔离（smoke-net-guard），非 OS 级全网络隔离
[t0] NOTE Windows 下隔离库文件权限由 ACL 继承（POSIX 场景 chmod 0600）
[t0] WRITER-SCAN …
[t0] WRITER-SCAN ok（8787 未监听 / 无 scheduler 进程）
[t0] REAL-FP  K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db sha256=fea0f12373a54678165f95651e358552e5eae17031046052aaff560dc86fc3f5 size=974848 mtime=1794460805028
[t0] REAL-WAL = absent
[t0] ISO-CREATE prisma db push → dev.smoke-mweieaunnf6v.db
[t0] ISO-CREATE ok（schema-only）
[t0] ISO-VERIFY ② database_list = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweieaunnf6v.db
[t0] ISO-EMPTY tables=15/15 rows=0
[t0] ISO-VERIFY PASS（落盘 / 连接实测 / 表结构 / 行数=0）
[t0] ENV-INJECT readback ok
[t0] SPAWN node --import file:///K:/WorkBuddy%20WorkSpace/project/wechat-pipeline-cloud/server/scripts/smoke-net-guard.mjs --experimental-strip-types K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\scripts\smoke-run.ts angles
[smoke-net-guard] loaded（Node 层网络入口隔离，非 OS 级全网络隔离）pid=8812
[smoke-db-guard] REAL      = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.db
[smoke-db-guard] ISOLATED  = K:\WorkBuddy WorkSpace\project\wechat-pipeline-cloud\server\prisma\dev.smoke-mweieaunnf6v.db
[smoke-db-guard] PASS（命名 / 路径归一反真实库 / 目录 / 落盘 校验通过）
[smoke-run] import ./smoke-angles.ts …
[smoke-net-guard] BLOCKED child_process.execSync → 子进程不在冒烟放行范围：chcp 65001
[smoke-net-guard] listen(0) 未指定 host → 强制绑定 127.0.0.1（规则 1）
[smoke-net-guard] REGISTERED 127.0.0.1:62981
[auth] SMOKE_NO_AUTH=1：鉴权已旁路（仅限冒烟，生产环境无效）
{"level":30,"time":"2026-11-13T05:01:15.986Z","env":"development","reqId":1,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1 -> 200 (31ms)"}
  PASS  1 列表 total=3
  PASS  1 列表含 articleCount 字段
  PASS  1 列表含正文 content
{"level":30,"time":"2026-11-13T05:01:15.998Z","env":"development","reqId":2,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1&used=unused -> 200 (2ms)"}
  PASS  2 used=unused → 2 条
{"level":30,"time":"2026-11-13T05:01:16.004Z","env":"development","reqId":3,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1&used=used -> 200 (2ms)"}
  PASS  2 used=used → 1 条
{"level":30,"time":"2026-11-13T05:01:16.009Z","env":"development","reqId":4,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1&keyword=%E5%85%B4%E8%B6%A3%E7%8F%AD -> 200 (2ms)"}
  PASS  3 keyword 命中 content
{"level":30,"time":"2026-11-13T05:01:16.013Z","env":"development","reqId":5,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1&keyword=%E8%B5%B7%E5%BA%8A%E6%88%98%E4%BA%89 -> 200 (2ms)"}
  PASS  3 keyword 命中 theme
{"level":30,"time":"2026-11-13T05:01:16.017Z","env":"development","reqId":6,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=1&limit=2&offset=0 -> 200 (1ms)"}
  PASS  4 分页 items=2 且 total 仍=3
{"level":40,"time":"2026-11-13T05:01:16.021Z","env":"development","reqId":7,"ip":"127.0.0.1","msg":"GET /api/angles/ -> 400 (1ms)"}
  PASS  5 缺 trackId → 400
{"level":40,"time":"2026-11-13T05:01:16.024Z","env":"development","reqId":8,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=abc -> 400 (1ms)"}
  PASS  5 trackId=abc → 400
{"level":30,"time":"2026-11-13T05:01:16.028Z","env":"development","reqId":9,"ip":"127.0.0.1","msg":"GET /api/angles/?trackId=999999 -> 200 (2ms)"}
  PASS  6 不存在赛道 → 200 total=0
{"level":30,"time":"2026-11-13T05:01:16.160Z","env":"development","id":4,"trackId":1,"source":"manual","scope":"article","msg":"手动新增选题"}
{"level":30,"time":"2026-11-13T05:01:16.161Z","env":"development","reqId":10,"ip":"127.0.0.1","msg":"POST /api/angles/ -> 201 (60ms)"}
  PASS  7 新增 → 201
  PASS  7 新增 seq=max+1(4)
  PASS  7 新增 code ≤32 且非空
  PASS  7 新增 used=false 且 source=manual
{"level":30,"time":"2026-11-13T05:01:16.210Z","env":"development","id":5,"trackId":1,"source":"manual","scope":"article","msg":"手动新增选题"}
{"level":30,"time":"2026-11-13T05:01:16.211Z","env":"development","reqId":11,"ip":"127.0.0.1","msg":"POST /api/angles/ -> 201 (47ms)"}
  PASS  7 再新增 seq=5 且 code 不重复
{"level":40,"time":"2026-11-13T05:01:16.214Z","env":"development","reqId":12,"ip":"127.0.0.1","msg":"POST /api/angles/ -> 400 (0ms)"}
  PASS  8 content 空 → 400
{"level":40,"time":"2026-11-13T05:01:16.219Z","env":"development","reqId":13,"ip":"127.0.0.1","msg":"POST /api/angles/ -> 400 (0ms)"}
  PASS  8 content 501 字 → 400
{"level":40,"time":"2026-11-13T05:01:16.223Z","env":"development","code":"not_found","status":404,"msg":"赛道 999999 不存在"}
{"level":40,"time":"2026-11-13T05:01:16.223Z","env":"development","reqId":14,"ip":"127.0.0.1","msg":"POST /api/angles/ -> 404 (1ms)"}
  PASS  9 新增到不存在赛道 → 404
{"level":30,"time":"2026-11-13T05:01:16.292Z","env":"development","reqId":15,"ip":"127.0.0.1","msg":"PUT /api/angles/1 -> 200 (67ms)"}
  PASS  10 编辑生效
{"level":30,"time":"2026-11-13T05:01:16.345Z","env":"development","reqId":16,"ip":"127.0.0.1","msg":"PUT /api/angles/1 -> 200 (50ms)"}
  PASS  11 传 used/usedBy 不改消费态
{"level":40,"time":"2026-11-13T05:01:16.348Z","env":"development","code":"not_found","status":404,"msg":"选题 999999 不存在"}
{"level":40,"time":"2026-11-13T05:01:16.348Z","env":"development","reqId":17,"ip":"127.0.0.1","msg":"PUT /api/angles/999999 -> 404 (1ms)"}
  PASS  12 编辑不存在 → 404
{"level":30,"time":"2026-11-13T05:01:16.444Z","env":"development","id":2,"trackId":1,"used":false,"unlinkedArticles":0,"msg":"删除选题"}
{"level":30,"time":"2026-11-13T05:01:16.445Z","env":"development","reqId":18,"ip":"127.0.0.1","msg":"DELETE /api/angles/2 -> 200 (94ms)"}
  PASS  13 删未用 → unlinkedArticles=0
{"level":30,"time":"2026-11-13T05:01:16.489Z","env":"development","id":3,"trackId":1,"used":true,"unlinkedArticles":1,"msg":"删除选题"}
{"level":30,"time":"2026-11-13T05:01:16.490Z","env":"development","reqId":19,"ip":"127.0.0.1","msg":"DELETE /api/angles/3 -> 200 (43ms)"}
  PASS  14 删已用 → unlinkedArticles=1 且 used=true
  PASS  14 文章 angleId 已置空
  PASS  14 文章正文不受影响
{"level":40,"time":"2026-11-13T05:01:16.494Z","env":"development","code":"not_found","status":404,"msg":"选题 3 不存在"}
{"level":40,"time":"2026-11-13T05:01:16.495Z","env":"development","reqId":20,"ip":"127.0.0.1","msg":"DELETE /api/angles/3 -> 404 (1ms)"}
  PASS  15 重复删除 → 404
{"level":40,"time":"2026-11-13T05:01:16.500Z","env":"development","reqId":21,"ip":"127.0.0.1","msg":"DELETE /api/angles/abc -> 404 (1ms)"}
  PASS  16 DELETE /abc → 404
{"level":30,"time":"2026-11-13T05:01:16.505Z","env":"development","reqId":22,"ip":"127.0.0.1","msg":"GET /api/tracks -> 200 (2ms)"}
  PASS  17 赛道 angleTotal 已同步为 3
{"level":30,"time":"2026-11-13T05:01:16.606Z","env":"development","reqId":23,"ip":"127.0.0.1","msg":"DELETE /api/articles/1 -> 200 (99ms)"}
  PASS  18 删文章 → 200 且 recycledAngle=false

SMOKE ANGLES: ALL PASS (30 项)
[t0] CHILD EXIT = 0
[t0] CLEANUP ok（隔离库与临时内容目录已删除）
[t0] REAL-DB FINGERPRINT MATCH（原库零写入）
EXIT_CODE=0
```

（原始留档：`T0-ACCEPTANCE-LOGS/4-smoke-angles.txt`）

## 附录 E · verify:smoke-iso 完整输出

见 §3（逐字全录，同源文件 `T0-ACCEPTANCE-LOGS/5-verify-smoke-iso.txt`）。

## 附录 F · git diff --stat 与 git diff 完整全文

### F.1 `git diff --stat`（全仓）

```
$ git diff --stat
 .gitignore                     |  3 ++
 CHANGELOG.md                   | 38 ++++++++++++++++++++
 docs/DEVLOG.md                 | 81 ++++++++++++++++++++++++++++++++++++++++++
 server/package.json            |  8 +++--
 server/scripts/smoke-angles.ts |  1 +
 server/scripts/smoke-lint.ts   |  1 +
 6 files changed, 129 insertions(+), 3 deletions(-)
```

### F.2 `git diff` 完整全文

```
diff --git a/.gitignore b/.gitignore
index 5be9aff..06e70da 100644
--- a/.gitignore
+++ b/.gitignore
@@ -31,6 +31,9 @@ web/.vite/
 *.db.bak-*
 *.db.bak
 
+# T0 smoke isolated databases (schema-only throwaway copies)
+dev.smoke-*.db
+
 # server runtime state: holds AES master key + temp scratch files
 server/var/
 
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 36cdc92..e4abfc1 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -2,6 +2,44 @@
 
 面向使用者的变更记录（按新增 / 变更 / 修复分类）。详细背景与验收见 `docs/DEVLOG.md`（进度台账唯一真源）。
 
+## 2026-11-13 · 阶段 0 · T0：冒烟测试隔离化（冒烟永远只碰隔离库）
+
+### 新增
+- `server/scripts/smoke-isolated.ts` 隔离运行器：每轮冒烟新建 schema-only 空库 `dev.smoke-*.db`（零行、真实数据零复制），
+  env 白名单注入（剥离 `APP_SECRET_KEY`、一切 `*TOKEN/*SECRET/*KEY`、代理变量），原库前后 SHA-256 指纹比对，
+  清理矩阵（普通异常/子进程非零退出/超时/SIGINT/SIGTERM）+ SIGKILL 残留恢复命令 `npm run smoke:prune-iso`。
+- `server/scripts/smoke-db-guard.ts` 子进程 DB 守卫：只认 `dev.smoke-*.db`，路径归一后反真实库（含别名），零绕过开关。
+- `server/scripts/smoke-net-guard.mjs` 网络网守（**Node 层入口隔离，非 OS 级**）：封 fetch/http/https/net/tls/dgram/
+  WebSocket/dns/child_process/worker_threads；仅允许 `listen(0)` 数值 loopback 临时端口 + 显式登记精确命中。
+- `server/scripts/smoke-run.ts` 引导入口（含 `selftest:*` 自检与 13 条网络反向用例）。
+- 十项验收台 `npm run verify:smoke-iso`（正向隔离/真实库反向被拒/env 失败即退/网络阻断/断言保留/四连/原库指纹一致/
+  清理矩阵/空库证明/网络反向）——2026-11-13 实测 **10/10 通过**。
+
+### 变更
+- `npm run smoke:lint / smoke:style / smoke:angles` **命令名不变**，执行体改走隔离运行器——今后三条标准冒烟
+  永远只跑隔离库，直跑 `smoke-*.ts` 会被拒绝。行为习惯变化：直跑被拒属预期，无任何绕过通道。
+- `.gitignore` 增加 `dev.smoke-*.db`。
+
+### 修复
+- 无（本项为测试基建，不触碰 `server/src/**`、Prisma Schema、真实数据与业务逻辑）。
+
+### 验收
+- typecheck 绿；smoke:lint **116 项** / smoke:style **33 项** / smoke:angles **30 项（当场计数）** 全 PASS；
+  真实 `dev.db` 全程指纹一致（`fea0f123…`）。详见 `docs/restructure/T0-ACCEPTANCE-REPORT.md`。
+
+## 2026-11-12（夜）· 重构第一阶段：项目审计（文档交付，未动代码）
+
+### 新增
+- `docs/AUDIT-REPORT.md` 项目现状审计报告：调用链/Prompt 分布/问题清单 P1-P14（带代码证据）/
+  四类模块清单/数据库调整方案/对 SECOND-OPINION 5 问的审计意见。
+- `docs/RESTRUCTURE-CHECKLIST.md` 重构实施清单：阶段 2-7 逐文件改造、验收门禁、PLAN §17 交付物对照。
+
+### 变更
+- 无代码变更（按 PLAN §16.1 先审计后动工）。
+
+### 修复
+- 无。
+
 ## 2026-11-12（傍晚：只改提示词，用数据决定要不要写代码）
 
 ### 新增
diff --git a/docs/DEVLOG.md b/docs/DEVLOG.md
index a6e5dba..2c7252d 100644
--- a/docs/DEVLOG.md
+++ b/docs/DEVLOG.md
@@ -1303,3 +1303,84 @@ Agnes-image（62）是用户重建的，Key 在。
 - `joinVariantBlocks` 统一用 `---` 拼接（多于一条时），保证「点开看一眼再保存」不会改格式——
   实测三个维度的回写都**逐字节相同**。
 - 冒烟补 4 项：有 `---` 按块切、无 `---` 退回按行、`## ` 切小节。`smoke:style` 29 → **33 项**。
+
+## 2026-11-12（夜）· RESTRUCTURE-PLAN-V1 第一阶段：项目审计（未动代码）
+
+**背景**：用户提供《RESTRUCTURE-PLAN-V1.md》（整体重构方案）与《SECOND-OPINION.md》
+（形态一致性实测数据 + 5 问），要求先审计不动代码，输出审计报告与重构实施清单。
+
+**产出**
+- `docs/AUDIT-REPORT.md`——现状审计报告：架构/流程/DB 盘点/选题与写稿调用链/Prompt 分布/
+  问题 P1-P14（带文件行号证据）/可保留-需重构-需新增-需废弃四清单/数据库调整方案/
+  4 个冲突裁决点 + 对 SECOND-OPINION 5 问的审计意见。
+- `docs/RESTRUCTURE-CHECKLIST.md`——重构实施清单：阶段 2-7 逐文件改动、验收门禁
+  （typecheck + smoke:lint/style/angles）、附 PLAN §17 交付物对照。
+
+**审计关键发现（新增事实）**
+- `config/topic_seeds.json` 是死文件（无代码读取）；`dedup.ts` 的 `judgeAngle` 三层判重
+  是**死代码**（线上扩库只有 normalize 精确去重）；`Article.qualityJson` 死字段。
+  → 方案 §4.1「取消种子驱动」已自然发生，但去重比方案描述的更弱。
+- `style-prompts.ts` 迁移区 v2→v15 约 900 行 + Setting 里 14 个迁移标志 = P4 实证。
+- 方案要求的 8 个新实体全部不存在；TaskRun/RunLog/StylePrompt/Setting 可承接一半语义。
+- dev.db 盘点：6 赛道、Angle 33（21 未用）、Article 12（全 draft）、StylePrompt 41 行。
+
+**待用户拍板（审计 §13/§15）**
+1. 默认兜底 vs「配置非空不做兜底」的两步走方案
+2. reflowParagraphs 去留（不打补丁约束的边界）
+3. 门禁数字按形态参数化（FORM-ARCHITECTURE 三道闸）
+4. TrackContract 砍半范围（form+reviewPolicy 先落）
+5. Embedding 去重实现路径、事实核验来源白名单、审核模型角色归属
+
+**下一步**：等裁决 → 阶段 2（赛道配置与 Prompt 体系）动工。
+
+## 2026-11-12（晚）· 重构设计基线入库 + 实施前检查（docs/restructure/）
+
+**产出**：`docs/restructure/` 文档集——00-FINAL-EXECUTION-CHARTER（用户定稿总纲，含五项核心验收指标口径）、01-08 八份审查文档、README（阅读顺序+决策登记表）、09-PRE-IMPLEMENTATION-CHECK（实施前检查：代码-文档差异/决策落实/migration baseline 方案/Python 本机流水线盘点/阶段 0-1 文件清单/风险与测试计划）。
+
+**用户拍板**：D1 选题 status+used 双维度+TopicReview（不建 TopicCandidate）；D2 reflow 先对照测试再定默认；D3 门禁只参数化赛道变化项；D4 TrackContract=form+reviewPolicy、N 版本行+生效指针；D5 审核复用 write 角色（带验证条件）；D6 配置两步走。另有 RBAC 矩阵、expiresAt/maxOAAccounts 处置、legacy 追溯、迁移安全观（down≠安全）、UI 三批次、去重降级语义（判重失败阻止自动升格）、五项验收指标（分母/周期/来源口径）。
+
+**实施前检查关键发现**：Python 本机流水线与云端**已分叉**——双选题库（data/angles/*.json vs Angle 表，used 互不相通）、文风双真源、同批公众号账号、双调度器 → 决策 X（共存方式三选一）未决前，云端自动化不得对本机在产账号开启写稿+推送。
+
+**状态**：只读检查完成，未改任何代码/数据库。等用户授权阶段 0 与 1A。
+
+## 2026-11-12（晚 20:28）· 切换日：本机流水线停用，云端成为唯一系统
+
+用户拍板「停掉本机的，现在不需要了」，替代式切换当即执行：
+- WorkBuddy 自动化「公众号每日创作并推送草稿」（06:00）**PAUSED**（automation_update 核实；任务保留可逆）。
+- 本机 `wechat-pipeline` 转只读蓝本归档；**文风双真源作废**（唯一真源=云端 StylePrompt）。
+- ⚠️ 生产空窗：云端 User.automationMode 全为 manual，每日自动出稿为 0；恢复产稿=按账号调 auto_draft / auto_draft_push（群发永远人工）。
+- 决策 X 关闭；`docs/restructure/README` 与 `09-PRE-IMPLEMENTATION-CHECK` 已更新。
+
+## 2026-11-13 · 阶段 0 · T0：冒烟测试隔离化（授权范围仅 T0，完成后停下等验收）
+
+**授权**：仅 T0（T1–T8 UI 改造不在授权内）。机制真源=`docs/restructure/T0-SAFETY-SUPPLEMENT.md`（v3）；
+概要=`STAGE0-IMPLEMENTATION-PLAN-V2.md` §二；修订背景=`T0-V3-REVISION-DIFF.md`。V1 作废文档零引用。
+
+**交付**（验收报告全文见 `docs/restructure/T0-ACCEPTANCE-REPORT.md`）
+- 四件套：`smoke-isolated.ts`（795 行，运行器+十项验收台）/ `smoke-db-guard.ts`（106 行）/
+  `smoke-net-guard.mjs`（439 行，Node 层网络入口隔离，非 OS 级）/ `smoke-run.ts`（184 行，引导入口）。
+- 三 smoke 胶水：lint/angles 各 **仅 +1 行**端口登记；`smoke-style-prompts.ts` **零改动**（无 app.listen）。
+- `package.json`：`smoke:lint|style|angles` 命令名不变、改走隔离运行器；新增 `verify:smoke-iso` / `smoke:prune-iso`。
+- `.gitignore` +`dev.smoke-*.db`。
+
+**实测验收（2026-11-13 真实输出）**
+- 四连全绿：typecheck exit=0；smoke:lint **116 项**；smoke:style **33 项**；smoke:angles **30 项（当场计数）**。
+- `npm run verify:smoke-iso` **10/10 通过**（正向隔离/真实库反向被拒×3 形态/env 失败即退×3/网络阻断/13 条网络反向/
+  原库 SHA-256 一致 `fea0f123…`/清理矩阵五路径+SIGKILL 残留 prune 恢复/断言保留/四连/空库证明 15 表×0 行）。
+
+**与 v3 设计差异（实测修正，细节见验收报告 §4）**：①表名用物理名（`OAAccount`→`@@map("Account")`）；
+②`die()` 须自行清理（process.exit 跳 finally）+ exit 兜底；③dns 数值 IP **同步短路**（Node listen→lookupAndListen
+回调恒异步，破坏同步 bind/取端口语义）；④listen 不支持 options.lookup（同步语义由③保证）；⑤connect 强制
+数值 lookup 封「自定义 lookup 重定向」旁路（规则 4 加严）；⑥Node normalizeArgs 预归一化数组形态须先展开
+（undici/fetch 实证）；⑦dns.Resolver 实例通道补封；⑩target 映射/hang 保活/scanWriters 接 probePort/
+onSignal 延迟清理（Windows 句柄 EBUSY）/正则补 `-journal` 等实现期修复。
+
+**经验沉淀（写网守/运行器必读）**
+- Node `Server.listen(0)` 无 host 是**同步 bind**（address() 立即可读）；带 host 走 dns.lookup **异步**回调再 bind，
+  且**无视 options.lookup**。冒烟脚本全部依赖同步取端口 → 网守必须对数值 IP 同步短路 dns.lookup。
+- Node `net.connect` 内部以 `normalizeArgs` 预归一化的 `[options, cb]` **数组**调 `socket.connect`——
+  包装 Socket.prototype.connect 时必须先展开数组形态，否则把数组当 options、`.port` 取不到误杀。
+- `process.exit` 跳过 finally：runner 的 die() 必须自行清理 + `process.on('exit')` 兜底，否则失败路径留残留。
+- Prisma 模型名≠表名：`@@map` 存在时（OAAccount→Account）凡按 sqlite_master 查表必须用物理表名。
+
+**状态**：T0 完成，十项验收 10/10。**停在此处等 T0 验收；未获 T1 授权不进入 UI 改造。**
diff --git a/server/package.json b/server/package.json
index 6ed161c..765c8ce 100644
--- a/server/package.json
+++ b/server/package.json
@@ -24,12 +24,14 @@
     "smoke:models": "node --experimental-strip-types scripts/smoke-models.ts",
     "smoke:cover": "node --experimental-strip-types scripts/smoke-cover.ts",
     "smoke:migrate": "node --experimental-strip-types scripts/smoke-migrate.ts",
-    "smoke:angles": "node --experimental-strip-types scripts/smoke-angles.ts",
+    "smoke:angles": "node --experimental-strip-types scripts/smoke-isolated.ts run angles",
     "smoke:bulk": "node --experimental-strip-types scripts/smoke-bulk-delete.ts",
     "verify:bulk": "node --experimental-strip-types scripts/verify-bulk-delete.ts",
     "verify:zodiac": "node --experimental-strip-types scripts/verify-zodiac.ts",
-    "smoke:lint": "node --experimental-strip-types scripts/smoke-lint.ts",
-    "smoke:style": "node --experimental-strip-types scripts/smoke-style-prompts.ts",
+    "smoke:lint": "node --experimental-strip-types scripts/smoke-isolated.ts run lint",
+    "smoke:style": "node --experimental-strip-types scripts/smoke-isolated.ts run style",
+    "verify:smoke-iso": "node --experimental-strip-types scripts/smoke-isolated.ts verify",
+    "smoke:prune-iso": "node --experimental-strip-types scripts/smoke-isolated.ts prune",
     "smoke:auth": "node --experimental-strip-types scripts/smoke-auth.ts",
     "prune:old": "node --experimental-strip-types scripts/prune-old-style.ts",
     "demo:write": "node --experimental-strip-types scripts/demo-write.ts",
diff --git a/server/scripts/smoke-angles.ts b/server/scripts/smoke-angles.ts
index 8893f6b..68c4998 100644
--- a/server/scripts/smoke-angles.ts
+++ b/server/scripts/smoke-angles.ts
@@ -54,6 +54,7 @@ interface ListResult {
 async function main(): Promise<void> {
   const app = createApp();
   const server = app.listen(0);
+  if (!(globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__?.register(server)) throw new Error('smoke-net-guard 未预载，拒绝运行（必须经 smoke-run.ts 引导）'); // T0 端口登记胶水
   const port = (server.address() as { port: number }).port;
   const base = `http://127.0.0.1:${port}`;
 
diff --git a/server/scripts/smoke-lint.ts b/server/scripts/smoke-lint.ts
index 26478af..8a7b8ad 100644
--- a/server/scripts/smoke-lint.ts
+++ b/server/scripts/smoke-lint.ts
@@ -400,6 +400,7 @@ async function main(): Promise<void> {
 
   const app = createApp();
   const server = app.listen(0);
+  if (!(globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__?.register(server)) throw new Error('smoke-net-guard 未预载，拒绝运行（必须经 smoke-run.ts 引导）'); // T0 端口登记胶水
   const port = (server.address() as { port: number }).port;
   const base = `http://127.0.0.1:${port}`;
   // /api/* 已加鉴权；本脚本测门禁不测鉴权，走 SMOKE_NO_AUTH 旁路（同 smoke:cover 等）。
```

（注：git 对 `.gitignore`/`docs/DEVLOG.md` 提示 LF→CRLF 换行归一警告，与内容无关。原始留档：`T0-ACCEPTANCE-LOGS/6-git-diff-stat.txt`。）

## 附录 G · 新增文件清单（`git ls-files --others --exclude-standard`，31 项逐字全录）

```
docs/AUDIT-REPORT.md
docs/RESTRUCTURE-CHECKLIST.md
docs/RESTRUCTURE-PLAN-V1.md
docs/restructure/00-FINAL-EXECUTION-CHARTER.md
docs/restructure/09-PRE-IMPLEMENTATION-CHECK.md
docs/restructure/CURRENT-ARCHITECTURE.md
docs/restructure/DATABASE-DESIGN-REVIEW.md
docs/restructure/KICKOFF.md
docs/restructure/PROJECT-UNDERSTANDING.md
docs/restructure/PROMPT-AND-CONTRACT-DESIGN.md
docs/restructure/README.md
docs/restructure/RESTRUCTURE-REVIEW.md
docs/restructure/RESTRUCTURE-ROADMAP-V2.md
docs/restructure/STAGE0-IMPLEMENTATION-PLAN-V2.md
docs/restructure/STAGE0-PLAN-REVISION-DIRECTIVE.md
docs/restructure/T0-ACCEPTANCE-REPORT.md
docs/restructure/T0-SAFETY-SUPPLEMENT.md
docs/restructure/T0-V3-REVISION-DIFF.md
docs/restructure/TARGET-UI-ARCHITECTURE.md
docs/restructure/UI-UX-AUDIT.md
server/scripts/smoke-db-guard.ts
server/scripts/smoke-isolated.ts
server/scripts/smoke-net-guard.mjs
server/scripts/smoke-run.ts
```

（采集时点清单 24 项；其后新增 `docs/restructure/T0-ACCEPTANCE-LOGS/` 8 个 txt 与本报告同批提交，合计 31 项 untracked + 6 项 modified。来源区分见 §1.3。原始留档：`T0-ACCEPTANCE-LOGS/7-new-files.txt`。）
