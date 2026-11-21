# 微信公众号自动创作系统 2.0 重构方案 · 基于现有成果的精简修订版

- **日期**：2026-11-13（最终收敛轮；18:30 技术校准修订——五项问题落定：账号 Host/连接地址、T0 适配逐项映射、Prisma 术语、wpc_app 权限、内部不一致修正）
- **指令依据**：《项目重构方向调整指令：基于现有成果收敛，不推翻重来》+《最终收敛任务：2.0 重构方案校准》（同日）
- **效力**：本文档取代 `T1-A-REVISED-DECISION-REPORT.md`（REV4.1）系列作为**后续实施的唯一方案依据**。REV4.1 及 T1-A 系列文档保留为历史分析存档，其中与本文冲突处以本文为准；`RESTRUCTURE-ROADMAP-V2.md` 的阶段编排由本文 §七重排。
- **一句话结论**：保留 T0（已验收）与全部有效业务代码；数据库走「**一个业务库、两个辅助库、一个项目账号**；空库起步、不迁数据」简单路线；废弃五账号/动态测试库/GRANT 动态授权/进程注册表/GET_LOCK/数据搬迁平台等一切未实施的复杂机制；后续重心转向业务与 UI。

---

## 一、当前项目真实状态（2026-11-13 只读核对）

以下均以本机代码仓库与实际文件为准核查，不依赖旧方案文档推断：

| 核对项 | 真实状态 | 证据 |
|---|---|---|
| 代码基线 | Node22 + TS(strip-only) + Express + Prisma + Vue3/Vite/EP；阶段 0–5 业务与前端功能完整可用 | 仓库根/server/web |
| **T0 冒烟隔离化** | **已实施并正式验收通过（10/10）**：`smoke:lint|style|angles` 走 `smoke-isolated.ts` 隔离运行器（schema-only 空库 `dev.smoke-*.db` + `smoke-db-guard.ts` 路径白名单 + `smoke-net-guard.mjs` Node 层网守 + `smoke-run.ts` 引导 + `verify:smoke-iso` 十项验收台） | server/scripts/ 四件套；`docs/restructure/T0-ACCEPTANCE-REPORT.md` |
| ⚠️ T0 代码 git 状态 | **四件套与 package.json 改动尚未提交**（untracked/modified） | `git status` |
| Prisma Schema | `prisma/schema.prisma` = **MySQL 真源**（datasource provider=mysql）；`schema.sqlite.prisma` 为 `gen-sqlite-schema.mjs` 自动生成的本地开发替身 | 两 schema 头注释 |
| Prisma Migrate | **`prisma/migrations/` 不存在**——从未建立迁移链（历史全靠 db push） | 目录核查 |
| 当前运行数据库 | `server/.env` `DATABASE_URL="file:./dev.db"` → **SQLite 仍是当前实际运行库** | .env（仅查键与形态） |
| SQLite 数据 | `dev.db` 15 表 **159 行**（只读实测：Account 1 / Angle 33 / Article 12 / ComicPanel 0 / LlmModel 4 / ModelBinding 7 / RunLog 3 / Setting 24 / StylePrompt 42 / TaskRun 11 / Track 6 / TrackPipeline 12 / User 3 / UserSession 1 / WechatToken 0）；另有 8 个历史 bak | node:sqlite 只读 COUNT |
| MySQL 现状 | 本机 MySQL 8.0.30；`wechat_pipeline` 库**尚不存在**（全新起点）；同实例 crm / wechat_publisher / wx_task_pocket 等**他项目库禁止触碰**；root 不进应用配置 | 此前只读核查 |
| REV4.1 方案 | **零实施**：五账号、动态测试库、GRANT/REVOKE、进程注册表、GET_LOCK、指纹平台、数据搬迁脚本等全部停留在文档 | 代码中无对应实现 |
| 设计基线 | `docs/restructure/` 32 份文档（总纲/路线图 V2/数据库设计/Prompt 契约/目标 UI 等）；路线图阶段 0–5 仅完成其中「业务功能可用」部分，重构实施未启动 | 文档目录 |
| 运行红线 | AUTO_PUBLISH=false（只进草稿箱）；`/api/*` 全量鉴权；写库验证隔离铁律 | 现行代码 |

---

## 二、已完成工作及保留清单

| 项目 | 当前状态 | 处理意见 |
|---|---|---|
| T0 冒烟隔离化 | 已完成并验收通过（10/10） | **保留，不重做、不删除、不为新方案重建**。仅在切 MySQL 时做一次「最小必要适配」（见 §四） |
| T0 正式验收材料 | T0-ACCEPTANCE-REPORT.md（996 行）+ 8 份日志留档 | 保留 |
| 业务系统（写作/选题/推送/漫画/前端/鉴权/文风配置） | 功能完整、冒烟绿 | 保留，不重写。后续只做优化不做推翻 |
| 云端唯一生产定位、安全红线、隔离铁律 | 长期有效 | 保留 |
| REV4.1 已实施内容 | **无**（纯文档轮） | 无需「保留实施成果」；文档降级为历史存档 |
| REV4.1 未实施内容 | 五账号、动态库、GRANT/REVOKE、注册表、GET_LOCK、搬迁平台、指纹验收体系等 | **大部分废弃**（见 §三逐项结论） |
| 双库迁移架构（更早的方案 C / SQLite Runner） | 已废弃归档 | 维持废弃 |
| 原 T1-B~T1-E（形态契约 TrackContract / PromptVersion / GenerationRun / Renderer 等设计） | 设计存在、未实施 | **降级重排**进 §七 **S3**，按「先要什么、不做会怎样」逐项裁剪，不整包实施 |
| 后续尚未实施的工作 | 数据库切换、SQLite 退役、业务与 UI 优化 | 重新排序为 §七 S1–S6 |

---

## 三、REV4.1 方案调整对照表

标记口径：**A** 已实施且保留 ｜ **B** 未实施但当前确实需要（简化后保留） ｜ **C** 未实施且没有必要，废弃 ｜ **D** 已实施但可后续简化。

| # | 设计项 | REV4.1 原案 | 分类 | 处理结论 |
|---|---|---|---|---|
| 1 | 五账号体系（migrate/runner/smoke/ro/app） | 五账号+职责分离 | **C** | **废弃**。简化为 **1 个业务账号 `wpc_app`**（root 仅一次性建库建号，绝不进配置）。单用户本机开发，五账号的隔离收益不抵复杂度 |
| 2 | 动态测试库 `wpc_smoke_<runId>` | 每 run 一库 | **C** | **废弃**。改为**固定测试库 `wechat_pipeline_smoke`**，每次 run 前重建 schema、run 后清空 |
| 3 | 动态 GRANT / REVOKE（逐 runId 转授） | 字面 GRANT + 八步清理 | **C** | **废弃**。固定库不存在「临时授权回收」问题 |
| 4 | PID / 进程注册表（内存+文件） | 清理授权真源 | **C** | **废弃**。固定测试库 + run 前重建，不依赖进程归属判定 |
| 5 | 自动 prune / 异常残留清理体系 | `smoke:prune-iso`+三查 | **C**（MySQL 化后） | 设计废弃。**现存 T0 的 prune（清 `dev.smoke-*.db` 残留文件）属已实施，保留**（A）；MySQL 切换后随机制一并简化掉 |
| 6 | GET_LOCK 及 R1–R6 同连接纪律 | 命名锁互斥 | **C** | **废弃**。冒烟**串行执行**约定足够（本项目已是铁律）；单机单用户无并发争用 |
| 7 | 多层回滚 / 搬迁断点 / 幂等恢复 | 进度表+断点续跑 | **C** | **废弃**。回退 = **git revert 切换提交** + dev.db 归档在手，足够 |
| 8 | SQLite→MySQL 数据迁移（159 行） | 逐行 INSERT+PK 映射 | **C** | **废弃，不迁数据**。个人测试数据不值得建迁移流程；**从空 MySQL 库初始化**；dev.db 仅归档 |
| 9 | 行级 SHA-256 指纹验收体系 | 全类型编码规范 | **C** | **废弃**（不迁数据则无对账对象）。保留的精神：迁移类操作前后核对行数级别的简单检查即可 |
| 10 | 唯一键 collation 预检 / UPSERT 禁令 | TEMPORARY TABLE 预检 | **C** | **废弃**（空库起步无存量冲突）。建表即用 `utf8mb4_unicode_ci` |
| 11 | 复杂权限验收（SHOW GRANTS 全维度核验） | 五账号断言矩阵 | **C** | **简化**：建号后**一次目检** `SHOW GRANTS FOR 'wpc_app'` 确认只有三个具名库权限即可 |
| 12 | migrate diff 双向 empty + 四类对象补查 | 双向 --exit-code | **B→简化** | 空库 `migrate init` 后做**一次** `migrate diff` 确认空差异（轻量验收）；四类对象补查**延期**（空库无 VIEW/TRIGGER 等） |
| 13 | 固定 shadow 库 + `shadowDatabaseUrl` | `wpc_shadow` | **B** | **保留**（这是 migrate dev 的真实需要，且是最简形态）：固定库 `wechat_pipeline_shadow`，一行配置 |
| 14 | 迁移包装脚本覆盖 `DATABASE_URL`（B4） | Node 注入 | **B→简化** | 正确性问题仍要修，但**切库后 app 与 migrate 同用 wpc_app 一个 URL，天然无冲突**——不再需要包装覆盖逻辑；仅保留「命令行/日志不打密码」要求 |
| 15 | `SMOKE_DATABASE_URL` / `SMOKE_DB_PORT` | 父进程派生凭据 | **C** | **废弃**（无动态凭据）。测试库连接串 = wpc_app 串换库名，由 runner 拼接 |
| 16 | 网络隔离 W1/W2（防火墙/Sandbox） | 已延期 | **维持延期** | 不做，不阻塞。Node 层网守（已实施）保留并如实标注边界 |
| 17 | 外键拓扑导入 / 孤儿检查 | 搬迁配套 | **C** | **废弃**（不迁数据） |
| 18 | `_wpc_migration_progress` 等管理表 | 已在 REV4.1 取消 | 维持取消 | 不建任何非 Prisma 管理表 |
| 19 | 父进程内存注册表=授权真源（A1） | REV4.1 修正项 | **C** | 随 #4 一并废弃 |
| 20 | T0 现行隔离机制（空库+三守卫+验收台） | — | **A** | **保留**，MySQL 切换时做 §四最小适配 |

**逐项结论汇总**（共 20 项）：**A 保留 2 项**（#5 已实施的 prune 文件清理、#20 T0 机制）；**B 简化保留 3 项**（#12/#13/#14）；**C 废弃 15 项**（#1/2/3/4/6/7/8/9/10/11/15/16/17/18/19；#5 的 MySQL 化 prune 设计并入 C）；**无 D 类**。（校准修正：前版汇总误把 #17 写入 A 类——#17 外键拓扑导入/孤儿检查为 **C 废弃**；前版「C 废弃 14 项」少计 1 项。）

---

## 四、T0 保留及不再重复实施说明

1. **T0 已实施、已验收（10/10），本轮及后续任何阶段都不得重做、重建、删除或覆盖。** 验收真源：`T0-ACCEPTANCE-REPORT.md` + `T0-ACCEPTANCE-LOGS/`。
2. T0 现行机制（SQLite 语境）：schema-only 空隔离库 `dev.smoke-*.db`、db-guard 路径归一白名单（绝不碰真实 dev.db）、net-guard Node 层入口隔离、env 白名单、清理矩阵、`verify:smoke-iso` 十项验收台、直跑被拒零绕过。**这些全部保留**——它们满足「测试不污染真实数据」的目标，正是新原则要保留的防误操作措施。
3. **与 MySQL 切换的关系**：T0 的*语义*（隔离、fail-closed、验收台）保留；*载体*在 S1 阶段做一次最小必要适配——隔离库从「SQLite 文件副本」换成「固定库 `wechat_pipeline_smoke` 前后重建」，db-guard 白名单从「文件路径」换成「库名 ∈ {wechat_pipeline_smoke}」。适配量小、验收台语义不变。
4. REV4.1 中围绕 T0-v2 设计的动态库/五账号/注册表/GET_LOCK/prune 体系**从未实施，正式废弃**，不再作为任何前置条件。
5. **风险提示（需尽快处理，但不在本轮授权内）**：T0 四件套代码目前未提交 git。建议在 S1 开工前先单独提交一次「T0 验收成果」commit，作为回退锚点。
6. 测试隔离铁律不变：**任何写库的验证一律先隔离**，真实库全程只读（2026-11-11 两次删库事故教训）。

### 4.1 T0 机制逐项适配对照（S1「最小必要适配」的完整范围）

判定口径：**✅ 保留**＝代码/语义不动 ｜ **🔄 载体替换**＝只把 SQLite 文件换成 MySQL 固定库，语义不变 ｜ **🗑 退役**＝随载体消失，S1 停用 / S2 清理。

| T0 组件 | 现行实现（SQLite） | S1 适配动作 | 判定 |
|---|---|---|---|
| 运行器框架 `smoke-isolated.ts`（run/verify/prune、超时/信号清理矩阵、子进程管理） | 文件副本 + spawn | 框架**不动**，仅改「隔离库创建/销毁」与「真实库保护证明」两处实现 | ✅ 保留 |
| 隔离库载体 | `dev.smoke-*.db` 文件 + `prisma db push --schema schema.sqlite.prisma --skip-generate` | → 固定库 `wechat_pipeline_smoke`：run 前重建 schema（migrate deploy 到测试库），run 后清空；断言子进程 DATABASE_URL 库名必须 = `wechat_pipeline_smoke` | 🔄 载体替换 |
| `smoke-db-guard.ts` | 路径归一后 ≠ 真实 dev.db（文件白名单） | → 连接目标**库名白名单**：只允许 `wechat_pipeline_smoke`；拒 `file:` 串、拒业务库/shadow 库名、拒错主机 | 🔄 载体替换（fail-closed 语义不变） |
| 真实库保护证明（验收⑦ SHA-256 文件指纹） | dev.db 前后指纹全等 | → 「业务库零接触」证明：子进程连接目标断言 + 业务库只读行数快照前后对比；文件指纹退役 | 🔄 证明方式替换（语义=真实数据不被碰） |
| `smoke-net-guard.mjs` / `smoke-run.ts` / env 白名单（验收⑤） | Node 层网守 + 引导 + env 剥离 | 原样保留（与数据库移植无关）；selftest 反例中 `file:` 串类换成 MySQL 形态反例 | ✅ 保留（仅反例微调） |
| 清理矩阵（验收⑧ 五条退出路径 + SIGKILL 残留） | 删隔离文件 | → 清空/重建 smoke 库表；SIGKILL 残留 = smoke 库遗留表，下次 run 前重建自然清除 | 🔄 清理对象替换 |
| 十项验收台 `verify:smoke-iso` | 十项（名称见 4.2） | 语义逐项保留，仅 ②⑦ 换 MySQL 形态 | ✅ 语义保留（②⑦ 载体换） |
| `smoke:prune-iso` | 清 `dev.smoke-*.db` 残留文件 | **MySQL 下无文件残留，不再是必要机制**：S1 改为「确认 smoke 库无残留表」空壳检查（命令名暂留兼容），**S2 退役删除** | 🗑 S2 退役 |
| 直跑被拒零绕过 / 隔离铁律 | 拒绝直连真实库 | 保留（guard 对业务库名 fail-closed） | ✅ 保留 |
| SQLite 专用依赖（`schema.sqlite.prisma`、sqlite db push、`gen-sqlite-schema.mjs`） | 建隔离库使用 | sqlite db push 路径 S1 随载体替换停用；其余 S2 退役（同 §六） | 🗑 S1 停用部分，S2 清理 |

**范围控制**：以上之外**不许改 T0 任何逻辑**（并发写入者扫描、超时参数、selftest 用例结构等一律不动）。S1 适配验收 = 十项全绿 + lint 116 / style 33 / angles 30 计数不降，交付 `T0-MYSQL-ADAPT` 验收记录。

### 4.2 十项验收台 MySQL 化映射（语义不变，仅 ②⑦ 换载体）

| # | 验收项（现行名称，冻结） | MySQL 后对应 |
|---|---|---|
| ① | 隔离数据库正向测试通过 | 原样（跑在 `wechat_pipeline_smoke`） |
| ② | 真实数据库反向测试被拒绝 | 反例换成：DATABASE_URL 指向 `wechat_pipeline` / `wechat_pipeline_shadow` / `file:` 串 / 未知库名 → 拒启 |
| ③ | 环境变量注入失败时直接退出 | 原样 |
| ④ | 网络访问被阻断（含 loopback 未登记端口，Node 层） | 原样 |
| ⑤ | 三个 smoke 原有断言全部保留 | 原样（lint 116 / style 33 / angles 30 计数不降） |
| ⑥ | 四连在隔离副本上通过 | 「隔离副本」→「隔离 smoke 库」，仍跑 typecheck + 三条冒烟 |
| ⑦ | 真实 dev.db 前后 SHA-256 一致 | → 业务库零接触证明（连接目标断言 + 行数只读快照前后一致；dev.db 侧 = 归档只读不变） |
| ⑧ | 副本清理（五条退出路径 + SIGKILL 残留恢复） | 清理对象 = smoke 库表；恢复 = 下次 run 前重建 |
| ⑨ | 空库证明（表结构存在 + 行数=0 + 自建数据创建/查询/清理） | 原样（对象 = smoke 库） |
| ⑩ | 网络隔离反向测试（Node 层能力验证） | 原样 |

---

## 五、数据库简化后的最终方案

### 5.1 目标形态（最终态，不再演进）——**一个业务库、两个辅助库、一个项目账号**

```
本机 MySQL 8.0.30（实测监听 0.0.0.0:3306；my.ini 仅显式配置 port=3306）
├── wechat_pipeline          ← 业务库（唯一运行库；空库起步，Prisma Migrate 管理结构）
├── wechat_pipeline_shadow   ← 辅助库①：Prisma migrate dev 固定 shadow（可随时丢弃重建）
└── wechat_pipeline_smoke    ← 辅助库②：固定测试库（冒烟隔离用，run 前后重建/清空）
项目账号：wpc_app@'127.0.0.1'（应用 + Prisma 迁移 + 冒烟共用）
root：仅一次性建库建号，永不进 .env、永不跑应用
```

- 字符集统一显式声明：`utf8mb4 / utf8mb4_unicode_ci`（不依赖默认值）。
- 连接地址统一 **`127.0.0.1:3306`**（不用 localhost、不走 IPv6，理由见 §5.2）。
- **不做**：数据搬迁、动态库、动态授权、读写分离、多环境权限矩阵、生产预演。

### 5.2 账号 Host、连接地址与权限（已核对本机事实 + Prisma 5.22 官方文档）

**连接方式核对（不凭经验断言）**：
- 本机实测：my.ini 仅 `port=3306`，**未配置** `skip_name_resolve`（默认 OFF——账号 Host 匹配会做客户端 IP 反向解析）、**未配置** bind-address（实测 `0.0.0.0:3306` LISTENING）；`127.0.0.1:3306` TCP 探测通过。
- Prisma 查询/迁移引擎**只走 TCP**（不支持 Windows 命名管道/共享内存）。URL 写 `localhost` 有两个不确定：①客户端可能解析为 `::1`（IPv6，账号 Host 变成 `'::1'`）；②服务端反解 127.0.0.1 得到什么名字决定 `'…'@'localhost'` 是否匹配——依赖 hosts/DNS 环境。
- **结论**：账号建在 **`'wpc_app'@'127.0.0.1'`**；所有连接串统一 **`127.0.0.1:3306`**（确定性最强，不受反解影响）。如需 `mysql.exe` CLI 走 localhost，可另建 `'wpc_app'@'localhost'` 同名密码（可选项，Prisma 不需要）。

**权限矩阵（Prisma 5.22 + MySQL 8.0.30，零全局权限）**：

| 用途 | 所需权限 | 授予位置 |
|---|---|---|
| migrate dev 业务库（建/改表 + `_prisma_migrations` 记账） | CREATE, ALTER, DROP, INDEX, REFERENCES + 对 `_prisma_migrations` 的 SELECT/INSERT/UPDATE | `wechat_pipeline`.* |
| migrate dev 重置 shadow | CREATE, ALTER, DROP, **INDEX**, REFERENCES（官方文档：固定 `shadowDatabaseUrl` 时**按库名授权即可，不需要 `*.*`**；INDEX 需单列——迁移含独立 CREATE/DROP INDEX） | `wechat_pipeline_shadow`.* |
| 冒烟库重建 + 跑测 | CREATE, ALTER, DROP, INDEX, REFERENCES, SELECT, INSERT, UPDATE, DELETE | `wechat_pipeline_smoke`.* |
| 应用正常运行 | SELECT, INSERT, UPDATE, DELETE | `wechat_pipeline`.* |

简化写法（推荐，同等边界）：三库各 `GRANT ALL`——多出的仅是同库内 VIEW 等创建类权限，**不含任何 `*.*` 全局权限、不含 GRANT OPTION**。要求最小化时按上表逐项 GRANT 亦可。

```sql
CREATE DATABASE wechat_pipeline        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE wechat_pipeline_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE wechat_pipeline_smoke  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wpc_app'@'127.0.0.1' IDENTIFIED BY '<强密码，写入 server/.env，不进聊天>';
GRANT ALL PRIVILEGES ON `wechat_pipeline`.*        TO 'wpc_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `wechat_pipeline_shadow`.* TO 'wpc_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `wechat_pipeline_smoke`.*  TO 'wpc_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

**连接验证（建号后立即做，验证通过才算建号完成）**：
1. `SHOW GRANTS FOR 'wpc_app'@'127.0.0.1'` → 只见上述三库，**无 `*.*`**；
2. 用 wpc_app 串连 `127.0.0.1:3306` → `SELECT CURRENT_USER(), DATABASE(), @@version` → 期望 `'wpc_app'@'127.0.0.1'` / `wechat_pipeline` / 8.0.30；shadow、smoke 两库名各连一次同断言；
3. 任一步不符 → 停下报告，**不许自动加全局权限或改 Host 通配**。

### 5.3 Prisma 使用规则（术语统一：空库初始化 ≠ Baseline）

**术语口径（全文统一，防止把空库初始化误称 baseline）**：
- **空库初始化 + 初始迁移（initial migration）**：目标库为空 → `prisma migrate dev --name init` 生成**第一个迁移文件**并应用。**本项目走这条路径。**
- **Baseline（基线）**：把**已有结构的数据库**纳入迁移管理时才用（`migrate diff` 取差异 + `migrate resolve --applied` 标记已应用）。**本项目不需要 baseline**——不迁 SQLite、不接管任何既有 MySQL 结构。文档与口头汇报一律不再用「baseline」指代本次初始化。

规则：
- `schema.prisma` 保持 MySQL 真源，加一行 `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`（指向固定辅助库，见 §5.2 权限）。
- 首次初始化：空库上 `prisma migrate dev --name init` 生成**初始迁移**入 `prisma/migrations/`（从此结构变更只走迁移，不再 `db push` 真实库）。
- 开发机 `migrate dev` / 将来生产 `migrate deploy`；**禁止 `--force-reset` 自动化、禁止「命令过不去就删库」**；状态不明→中止人工看，不自动修。（`migrate dev` 自带 advisory lock 由 Prisma 管理，无需我们建锁机制。）
- `.env` 形态（全部走 Node/Prisma 标准 env 读取，Windows 兼容，日志不打密码；地址固定 127.0.0.1）：

```
DATABASE_URL="mysql://wpc_app:<密码>@127.0.0.1:3306/wechat_pipeline"
SHADOW_DATABASE_URL="mysql://wpc_app:<密码>@127.0.0.1:3306/wechat_pipeline_shadow"
```

（测试库连接串由 runner 从 DATABASE_URL 换库名派生，不另设全局变量。切库后第一件事：经 Prisma 实测 `SELECT CURRENT_USER(), DATABASE()`，期望 `'wpc_app'@'127.0.0.1'` / `wechat_pipeline`。）

### 5.4 测试隔离（T0 最小适配后）

- `smoke-isolated.ts`：建/清 `wechat_pipeline_smoke`（DROP TABLES→migrate deploy 到测试库或 db push schema-only→跑测→清空）；断言子进程 DATABASE_URL 库名必须是 `wechat_pipeline_smoke`，否则拒启。
- 十项验收台语义不变；`smoke:lint|style|angles` 命令名不变。
- 冒烟**串行**执行（既有铁律），无锁机制。

### 5.5 防误操作底线（保留的「必要措施」）

1. 测试与真实库分离（固定 smoke 库 + guard 白名单 fail-closed）。
2. `wpc_app` 权限止步于三个具名库——**结构性**保证碰不到 crm 等他项目库。
3. dev.db 及 bak 归档只读，切库后不删。
4. 破坏性操作（DROP/RESET）只允许针对 `wechat_pipeline_smoke` / `wechat_pipeline_shadow`，guard 拦截一切其他目标。
5. AUTO_PUBLISH=false、群发人工、隔离铁律等既有红线原样有效。

---

## 六、需要清理的历史包袱（时机见 §七）

| 包袱 | 处置 |
|---|---|
| `schema.sqlite.prisma` + `gen-sqlite-schema.mjs` + `schema:sqlite` / `sqlite:generate` / `sqlite:push` 脚本 | S2 退役删除（切库稳定后） |
| `.env` 的 `file:./dev.db` 与 `.env.example` 里的 root 示例 | S1 切换时改为 wpc_app 形态 |
| `dev.db` + 8 个 `dev.db.bak-*` | 归档保留只读（不删）；标注「历史数据，不参与运行」 |
| T1-A 系列（13 份）中双库/五账号/搬迁类文档 | 不删，头部统一标注「已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代」（S2 顺手标注） |
| T0 四件套中的 SQLite 文件隔离载体逻辑 | S1 随最小适配自然退役（机制语义保留） |
| 「生产上线前 baseline migration」注释等 SQLite 时代注记 | S2 清理 |
| npm scripts 中 `smoke:migrate`、`migrate`（旧 CLI）等一次性脚本 | S2 盘点后归档或删除 |

---

## 七、后续重构阶段及实施顺序（原任务衔接）

### 7.1 阶段总览

| 阶段 | 内容 | 前置 |
|---|---|---|
| **S1** | MySQL 空库初始化与统一数据库（建库建号→.env 切换→migrate init→T0 最小适配→业务冒烟回归） | 本方案审核通过 + 建库授权 |
| **S2** | SQLite 遗留清理与文档收口 | S1 验收通过 |
| **S3** | 架构/抽象精简裁剪（原 T1-B~E 与契约/版本/追溯类设计逐项裁剪） | S2 |
| **S4** | 业务流程与内容质量优化（选题质量、创作链路、审核流程） | S1（可与 S3 并行） |
| **S5** | UI/UX 系统性优化（设计系统、导航、三态、编辑体验） | 可与 S3/S4 并行 |
| **S6** | 回归与收尾（测试固化、指标口径、文档/CHANGELOG/验收） | S4/S5 主体完成 |

### 7.2 原任务衔接关系

| 原任务 | 结论 |
|---|---|
| T0 冒烟隔离化 | **已完成，不进入新计划**（保留；仅 S1 最小适配） |
| T1-A 数据库切换系列（REV1→REV4.1） | **由 S1 取代**；其复杂设计按 §三裁剪，分析文档归档 |
| T1-B~T1-E（TrackContract / PromptVersion / GenerationRun / Renderer） | **合并进 S3 简化裁剪**：不整包实施；逐项按「不做会有什么实际问题」裁决（倾向：Renderer 与门禁参数化保留落地，PromptVersion/GenerationRun 降为轻量日志或延期，TrackContract 先做配置校验最小版）——最终取舍 S3 开工前单独报你确认 |
| 路线图 V2 阶段 0（设计系统/UI 壳层） | 并入 **S5** |
| 路线图 V2 阶段 1（迁移/契约/配置） | 数据库部分由 **S1** 取代；契约/配置部分并入 **S3** |
| 路线图 V2 阶段 2–4（选题状态机/审核/事实核验/生成闭环） | 收敛并入 **S4**（保留已拍板决策 D1/D2/D5/Q 等，砍掉过度的状态机与追溯工程化） |
| 路线图 V2 阶段 5（质量中心/测试/验收） | 并入 **S6** |
| **下一个未完成任务** | **S1 · MySQL 空库初始化与统一数据库** |

---

## 八、各阶段实施范围与验收标准

### S1 · MySQL 空库初始化与统一数据库【下一步】
- **范围**：① 建 3 库 + wpc_app（一次，§5.2 SQL）② `.env` 切 MySQL、`schema.prisma` 加 shadowDatabaseUrl 一行 ③ 空库 `prisma migrate dev --name init` 生成**初始迁移**（非 baseline）④ T0 最小适配（严格按 §4.1 逐项映射：固定 smoke 库 + db-guard 库名白名单）⑤ 业务冒烟回归。
- **验收**：`SELECT CURRENT_USER()` 实测 = `'wpc_app'@'127.0.0.1'`；`SHOW GRANTS` 仅三库无 `*.*`；`npm run typecheck` 绿；十项验收台全绿（②⑦ 按 §4.2 MySQL 形态）且 lint 116 / style 33 / angles 30 计数不降；应用起动、登录、生成一篇草稿走通（不推送）；同实例他项目库零访问；dev.db 指纹不变；**切换动作单独 git commit（回退锚点）**。
- **回退**：revert 该 commit + `.env` 回 `file:./dev.db`（dev.db 未动）。

### S2 · SQLite 遗留清理
- **范围**：退役 `schema.sqlite.prisma`/生成脚本/相关 npm scripts；T1-A 文档挂取代标注；dev.db 归档标注；注释清理。
- **验收**：`grep -r "sqlite"` 仅剩历史文档与归档说明；typecheck + 三条冒烟绿；文档指向一致无矛盾。

### S3 · 架构/抽象精简裁剪
- **范围**：对 TrackContract / PromptVersion / GenerationRun / Renderer / 门禁参数化等**逐项出「保留/最小落地/延期/废弃」裁决表**（先报批再动代码）；只实施被裁决为「当前必须」的最小集。
- **验收**：裁决表经你确认；实施项 typecheck+冒烟绿；不引入新表除非裁决明确要求。

### S4 · 业务流程与内容质量优化
- **范围**：选题质量（六维评分/去重链的**轻量版**）、创作链路（选题→成稿→审核→修订）梳理、审核流程优化；沿用已拍板决策（Angle.status+used、TopicReview、正向价值口径等），砍掉并发抢占测试平台等工程化过度项。
- **验收**：选题→草稿→人工审核→推送草稿箱全链路可用且有改善指标对比；`smoke:angles` 等扩充绿；无真实群发。

### S5 · UI/UX 系统性优化
- **范围**：设计令牌收口（主色 #0a7c47 不改）、导航/页面布局、三态组件、编辑工作区交互、亮暗两态。
- **验收**：`vue-tsc` + `vite build` 绿；真机走查记录；现有功能不丢、无假数据。

### S6 · 回归与收尾
- **范围**：关键流程测试固化（隔离库）、五项指标口径落地（样本不足不出百分比）、CHANGELOG/文档/记忆回写、遗留清单。
- **验收**：关键流程可重复回归；文档一致；红线复查（AUTO_PUBLISH=false/群发人工/隔离铁律）。

---

## 九、明确不做的事项

1. 不重做 T0，不删除 T0 成果。
2. 不建五账号/多账号权限体系（一账号封顶；将来真上生产再议）。
3. 不建动态测试库、动态 GRANT/REVOKE、进程注册表、GET_LOCK、自动 prune 平台。
4. **不做 SQLite→MySQL 数据迁移**（含断点/幂等/指纹/UPSERT 规则整套）。
5. 不做多层回滚与备份恢复演练体系（git revert + dev.db 归档足够）。
6. 不做 W1/W2 防火墙/OS 级网络隔离（不阻塞交付；Node 层网守如实标注）。
7. 不做高可用/集群/多租户/多环境权限矩阵等「为未来大规模部署」的设计。
8. 不把 159 行数据搬迁包装成通用迁移平台，不建非 Prisma 管理表。
9. 不重写已正常工作的业务模块；不重排已验收的 T0 编号。
10. 不无限增加方案版本轮次——本方案即最终收敛，此后只有实施与实施中的小修。

---

## 十、从当前状态开始的下一步任务

**下一步 = S1 · MySQL 空库初始化与统一数据库。开工前最终准备清单（逐项确认后才动工）：**

1. **授权执行 §5.2 建库建号**（你自己在 MySQL 客户端跑 SQL，或授权我方用管理员凭据执行一次；凭据不进聊天明文）。
2. 确认三库命名 `wechat_pipeline` / `_shadow` / `_smoke`，账号 Host **`'wpc_app'@'127.0.0.1'`**、连接统一 `127.0.0.1:3306`。
3. 确认 `wpc_app` 密码生成方式（我方可生成强密码直写 `server/.env`）。
4. 同意「T0 成果先单独 git commit」作回退锚点（只提交现有成果，不动代码）。
5. 建号后当场完成 §5.2 三项连接验证（SHOW GRANTS / CURRENT_USER / 三库各连一次）。

**遗留风险（不阻塞 S1）**：`skip_name_resolve` 未显式配置（默认 OFF）——已用 127.0.0.1 入站规避账号匹配不确定性；若未来改配置，本方案账号 Host 不受影响。

S1 将按分阶段授权惯例执行：开工前提交任务清单与影响面，**拿到明确授权才动代码/数据库**；本轮到此为止，停等你的审核。

---

## 附：本轮零变更声明

本轮仅新增本文档（及收尾的台账/记忆回写），**未修改任何业务代码、Prisma Schema、migrations、环境变量、数据库或权限**；未执行任何 db push / migrate / 写库操作；未重做 T0；dev.db 全程只读。REV4.1 及 T1-A 系列文档原样保留（取代关系以本文为准）。
