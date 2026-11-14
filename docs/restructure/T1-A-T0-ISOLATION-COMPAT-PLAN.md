# T1-A · T0 测试隔离兼容方案（T0-v2 设计稿 · REV4.1）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（REV4.1；设计稿，**零实施**）
- **REV4.1 修订依据（外部审核「必须修订」A 组）**：A1 注册文件可信性如实降级（内存注册表=运行期唯一真源，文件仅恢复线索，prune 以 OS 进程实测复核）；A2 补 SMOKE_DATABASE_URL/SMOKE_DB_PORT 凭据边界（子进程只收一份临时库连接串）+ selftest 反例补 wpc_ro；A3 指纹 FLOAT/DOUBLE 分宽（4/8 字节）、JCS 数字双精度安全检查、时间以只读实测语义为准（INTEGER Unix 毫秒，不猜时区）+ 类型前提断言。
- **REV4 修订依据（保留）**：P0-2 归属识别不依赖库内标记；P0-3 清理授权改父进程控制信息；P0-4 五账号职责分离；P0-7 八步清理顺序；P0-8 临时库显式字符集；P0-6 指纹规范；P1-4 权限核验实项；P1-5 网络隔离（W1/W2）延期。
- **收敛原则**：不过度设计——无库内 marker 表、无 OS 级防火墙前置、无标记服务；保留 fail-closed 三查、GET_LOCK 互斥、逐 runId 字面转授、行级摘要。
- **约束**：T0 四件套为已验收冻结面，本方案只设计、不修改；落地须授权 (a)（P1-A），完整运行验收在 P2-B。
- **不变的安全语义（T0-v1 继承）**：fail-closed 零绕过、隔离空库、业务表零行、env 白名单、超时/信号清理矩阵、十项验收台语义。

---

## 1. 临时库命名与 runId 规则（强制，不变）

```
库名全名 = wpc_smoke_<runId>
全名正则 = ^wpc_smoke_[0-9a-f]{12}$        （22 字符）
```

- 项目专属前缀 `wpc_smoke_`：同实例其他项目库（crm / wechat_publisher / wx_task_pocket 等）永不进入枚举/删除范围。
- 禁止批量匹配删除（不存在 `DROP ... LIKE`）；清理只对逐个精确库名执行。
- 名称比较不区分大小写（本机 `lower_case_table_names=1`）。
- runId 仅内部生成（`crypto.randomBytes(6).toString('hex')`），不接受任何外部指定；同名库已存在 → 拒绝启动。
- **临时库显式字符集（P0-8）**：`CREATE DATABASE wpc_smoke_<runId> CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`——与正式开发库一致，**不依赖 MySQL 默认值**。建库语句中显式书写，代码里不做「猜默认值」的分支。

## 2. 归属识别与控制信息（P0-2 / P0-3 重设计）

**原则：归属判断的依据必须来自测试子进程无法篡改的控制信息；库内标记表不可作为授权依据。**

### 2.1 授权真源 = 父进程内存注册表；注册文件仅为恢复线索（REV4.1 · A1 审核修正）

runner 父进程（wpc_runner 身份）在**自身内存**登记本次运行的注册项，同时落一份注册文件（`server/var/smoke-registry/<runId>.json`，.gitignore 覆盖）备查：

```json
{ "runId": "a1b2c3d4e5f6", "dbName": "wpc_smoke_a1b2c3d4e5f6",
  "childPid": 1234, "childT0": 1731480000000, "status": "active" }
```

**可信边界（如实声明，不夸大）**：

- **父进程运行期间，内存注册表是清理授权的唯一真源**；注册文件只是副本/诊断输出，不参与授权判定。
- **注册文件不是「子进程无法篡改」的安全边界**：Windows 上父子进程同用户身份、继承相同文件 ACL，子进程理论上可写该文件。文档与代码注释均不得宣称其不可篡改。
- **父进程异常退出后的 prune**：注册文件只用于**发现**候选残留库（线索），**不单独构成删除授权**。prune 删除前必须独立复核：
  1. 库名正则 + runId 后缀一致；
  2. 文件记录的 childPid/childT0 与 **OS 实际进程启动时间**比对（以操作系统查询结果为准——文件被篡改则必然对不上）；
  3. 连接目标 `SELECT DATABASE()` 实测一致。
- 子进程存活期间改写文件中的 PID/启动时间/状态 → 与 OS 实测不符 → 按「归属不明」拒删。**注册信息不完整、进程状态无法确定、无法证明归属 → 一律拒绝自动删除、报告残留**（fail-closed）。
- 不为此引入额外服务、守护进程或 OS 级隔离（威胁模型=防误操作，不为理论对抗扩大设计）。

### 2.2 库内 marker 表：取消（简化，P0-2/P0-3）

- REV3 设计的 `wpc_smoke_marker` 表**不再创建**：测试子进程对其临时库有较高权限（含 DROP/ALTER），库内标记可被改写或随表删除——**不可作为删除授权依据**；保留它只会造成「看似有校验、实际可绕过」的假安全感。
- 归属判断全部走 §2.1 控制信息 + §3 清理门禁。空库证明更简单：15 张业务表行数=0 即可（无需排除 marker 表）。

### 2.3 wpc_shadow 归属识别（P0-2，同原则）

固定 shadow 库 `wpc_shadow` 的识别与保护**不依赖库内任何标记**（Prisma `migrate dev` 的 best_effort_reset 会清空库内对象，库内标记必然丢失）：

1. **固定字面库名** `wpc_shadow`（代码常量 + 清理排除名单）；
2. **固定连接配置**：schema.prisma 的 `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`（唯一 Schema 改动）；
3. **权限约束**：仅 wpc_migrate 持有 `ALL ON wpc_shadow.*`；
4. **清理白名单**：DROP 代码路径只允许 `wpc_smoke_<runId>` 形态；`wpc_shadow`、`wechat_pipeline`、`mysql`、`sys`、`information_schema`、`performance_schema` 及一切非 `wpc_smoke_` 前缀库进入硬编码禁止名单。

不需要任何标记服务/标记表/标记守护进程。

## 3. 清理授权与八步清理顺序（P0-3 + P0-7，强制）

### 3.1 删除前门禁（三查，逐库执行，任一失败拒删）

| 查 | 内容 | 失败处理 |
|---|---|---|
| ① 名字查 | 全名正则 `^wpc_smoke_[0-9a-f]{12}$`（大小写不敏感） | 拒删，报「名称不符」 |
| ② 归属查 | 运行期核**内存注册表**（runId/库名/状态）；prune 场景核注册文件线索 + **OS 进程实测复核**（§2.1）+ 连接目标实测 | 无法确认归属 → 拒删，报「归属不明」 |
| ③ 状态查 | 子进程已退出（PID+启动时间双查）→ 可删；存活 → 拒删（运行中）；进程查询失败 → 状态不明，拒删 | 按状态处理 |

补充硬规则：prune 枚举固定 `SHOW DATABASES LIKE 'wpc\_smoke\_%'`（转义精确匹配）逐库三查；未知库/校验失败/查询异常一律拒删并计残留报告；DROP 拼接前代码断言库名以 `wpc_smoke_` 开头。

### 3.2 八步清理顺序（P0-7 强制序号，不可调换、不可合并）

| 步 | 动作 | 失败即停规则 |
|---|---|---|
| 1 | 确认测试子进程已退出（PID+启动时间双查） | 查询失败=状态不明 → 停止并报告 |
| 2 | 获取清理锁（GET_LOCK `wpc_smoke_mutex`，专用单连接） | 返回 0=被占用→本轮放弃不删；NULL=出错→拒删并报告 |
| 3 | **再次**核对数据库归属（§3.1 三查全部重跑，锁内执行） | 任一不过 → 停止并报告 |
| 4 | 撤销临时库授权：`REVOKE ALL ON \`wpc_smoke_<runId>\`.* FROM 'wpc_smoke'@'localhost'` | **REVOKE 失败 → 停止并报告，不得继续 DROP**（权限清理失败 ≠ 可以删库） |
| 5 | 验证授权已撤销（`SHOW GRANTS FOR 'wpc_smoke'@'localhost'` 无该库行） | 验证不过 → 停止并报告 |
| 6 | `DROP DATABASE \`wpc_smoke_<runId>\``（重试 ≤2 次，间隔 500ms） | 仍失败 → 保留 + 报告残留库名 |
| 7 | 验证数据库已不存在（information_schema 查无此库） | 验证不过 → 报告残留 |
| 8 | 释放锁（RELEASE_LOCK）并更新注册表状态 | — |

**核心不变量**：DROP 成功 ≠ 清理成功；**REVOKE 成功是 DROP 的前置**，二者各自验证、各自报告。任何清理失败不得静默吞掉。

### 3.3 清理矩阵（继承 v1 五路径）

正常结束 / 子进程非零退出 / 超时 / SIGINT·SIGTERM → 均走 §3.2 八步；SIGKILL / 掉电 → 留下注册文件 → `smoke:prune-iso` 以文件**发现**候选，按 §2.1 独立复核（OS 进程实测）后才走八步；无法证明归属即拒删并报告。

## 4. GET_LOCK 互斥铁律（保留，正确性所需）

| 规则 | 内容 |
|---|---|
| R1 同连接 | 拿锁与 DROP/REVOKE/状态改写必须在**同一物理连接**（专用单连接，禁连接池） |
| R2 覆盖面 | 一切删除路径（cleanup/prune/verify 用例）先进同一互斥段再走 §3 |
| R3 拿锁失败 | 0=占用→放弃本轮删除（报告）；NULL=出错→拒删（fail-closed） |
| R4 连接断开 | 锁自动释放→状态不明→后续删除方必须从头重跑三查 |
| R5 PID 重用 | 存活判定 = PID + 进程启动时间双匹配；进程查询失败=拒删 |
| R6 重试上限 | DROP 重试 2 次后仍失败 → 保留 + 报告 |

并发六用例（P2-B）：并发双跑 / prune-vs-active / runId 重入 / 冒名库拒删 / 锁竞争 / 连接中断重查。

## 5. 账号与权限边界（P0-4 五账号职责分离）

### 5.1 账号表（root 之外五号，职责单一）

| 账号 | 职责 | 权限（最小化） | 不许用在哪 |
|---|---|---|---|
| root/DBA | 建号/授权/救火 | ALL | 不进 .env、脚本、日志、任何进程 |
| **`wpc_migrate`** | **仅 Prisma 数据库迁移** | `ALL ON wechat_pipeline.*` + `ALL ON wpc_shadow.*` | 不做临时库管理、不进应用、不进测试子进程 |
| **`wpc_runner`** | **建/管/清临时测试库**（父进程） | ``ALL ON `wpc\_smoke\_%`.* WITH GRANT OPTION``（仅用于逐 runId 转授/回收） | **无 wechat_pipeline 任何权限（含 SELECT）**；不进应用、不进测试子进程 |
| **`wpc_smoke`** | 运行隔离测试 | **零常驻**；仅运行期持有逐 runId **字面**授权 `ALL ON \`wpc_smoke_<runId>\`.*` | 不碰开发库/shadow/其他项目库 |
| **`wpc_ro`** | 只读检查 | `SELECT ON wechat_pipeline.*` | 不写、不注入子进程 |
| **`wpc_app`** | 应用业务读写 | `SELECT, INSERT, UPDATE, DELETE ON wechat_pipeline.*`（无 DDL） | 不做迁移、不进 runner |

- **职责分离要点（P0-4）**：REV3 的「wpc_migrate 兼 runner」取消——迁移账号不承担临时库生命周期，runner 账号不接触真实业务库。wpc_runner 即使凭据泄漏，攻击面也只有 `wpc_smoke_%` 临时库。
- **不合并说明**：曾评估「wpc_runner 并入 wpc_migrate」「wpc_ro 并入 wpc_app」均降低边界清晰度且省不了配置成本（.env 各一行），按任务书采用表中五号，不为凑数加号、不为省号混责。
- **应用与迁移分离**：`DATABASE_URL`=wpc_app；migrate 经包装脚本以 wpc_migrate 执行。生产环境同此规则（P1-8）。

### 5.2 逐 runId 字面转授（不变，执行者改为 wpc_runner）

```
wpc_runner 建库后：GRANT ALL ON `wpc_smoke_<runId>`.* TO 'wpc_smoke'@'localhost';
清理第 4-5 步：REVOKE ALL ON `wpc_smoke_<runId>`.* FROM 'wpc_smoke'@'localhost';（DROP 之前）
```

- 字面库名、零通配符——不受通配符废弃/partial_revokes 影响。
- wpc_smoke 零常驻：不跑测试时对实例任何库无权限。
- 转授能力仅 wpc_runner 持有（`wpc\_smoke\_%` 模式 WITH GRANT OPTION）；模式语义不稳定因素收敛在可信父进程侧，实际触碰面由名字正则+三查钉死。
- G4 探针（P2-A 一次性）实测：建库→转授→连入→REVOKE→DROP 全链路；同时实测**库级/模式级 CREATE 是否足以建临时库**（若不足，所需最小追加权限交用户拍板后再动，不默认扩大）。

### 5.3 权限核验（P1-4，运行前断言，以 MySQL 8.0.30 实际生效为准）

1. `SELECT CURRENT_USER(), USER(), DATABASE()` 双查留档（权限判定主体 vs 客户端自称）；
2. `SHOW GRANTS FOR CURRENT_USER()` 逐行解析：全局行出现任何非 USAGE 权限即拒跑；
3. **角色及继承**：查 `information_schema.APPLICABLE_ROLES`，`SET ROLE ALL` 后复核有效权限面；
4. **`@@partial_revokes`**：ON 时通配符按字面解释（行为反转）→ 记录并停下报告；
5. **`@@skip_name_resolve`**：影响 `'user'@'localhost'` 与 TCP 来源的匹配（ON 时 TCP 连接可能匹配不上 @'localhost' 账号）→ 记录实测值；若 ON 导致连不上，建号口径（@'localhost' vs @'127.0.0.1'）交用户确认，不擅自改号。
6. 实际匹配账号以 CURRENT_USER() 输出为准，不以连接串自称为准。

## 6. 行级 SHA-256 摘要（P0-6 规范定稿）

真库保护用规范化行级摘要（MySQL 无独立文件可指纹）。算法要点（实现只需覆盖当前 15 表实际类型）：

### 6.1 单元格编码（自定界）

**类型前提（2026-11-13 只读盘点，实现须断言）**：当前 15 表列类型仅 String / Int / Boolean / DateTime / Json（SQLite 侧实测 INTEGER 45 / TEXT 74 / BLOB 3 / BOOLEAN 6 / DATETIME 31）——**无 Float、无 Decimal 列**；若未来新增 Float/Decimal 列，按下表规则编码且实现对「当前无 FLOAT」前提做断言（遇到未预期类型 → 报错停止，不猜）。

```
NULL 单元格   →  字节 'N'                          （与空串严格区分）
非 NULL 单元格 →  <tag>L<byteLen>:<payload>        （tag+长度前缀，字节级无歧义）
行 = 各单元格按列序直接拼接
```

| 类型 | payload 规则 | 无法安全转换时 |
|---|---|---|
| I 整数 | 十进制 ASCII，BigInt 精确（SQLite INTEGER ↔ MySQL BIGINT，64 位内原样） | 超出 64 位/解析失败 → **报错停止** |
| D DECIMAL | 按列定义 scale 的**定标十进制串**（DECIMAL(10,2)→`3.50`，不剥尾零；SQLite 侧按 Prisma 列定义定标） | 定标不明确/精度丢失 → **报错停止** |
| F 浮点 | **按列类型定宽，DOUBLE 与 FLOAT 不混用**：DOUBLE（及 Prisma Float，双精度）→ IEEE-754 **8 字节**大端；MySQL FLOAT（单精度 4 字节）→ IEEE-754 **4 字节**大端。两侧经同一 TS 实现读值编码 | 列精度不明 → **报错停止** |
| S 字符串 | UTF-8 原样字节：**不做 Unicode 归一化**（NFC/NFD 一律不动）、不剥尾随空格；两侧读出什么比什么 | 非法代理对读出失败 → **报错停止** |
| B BLOB | 原样字节 | — |
| J JSON | **RFC 8785 (JCS) canonical JSON** 的 UTF-8 字节（键排序/无空白/JCS 数字规范化）。**JCS 前每个数字必须先过 IEEE-754 双精度安全表示检查**（round-trip 往返一致才可转 JS Number）——超大整数/高精度小数不安全 → **报错停止，不静默转 Number** | 解析失败/数字不安全 → **报错停止** |
| T 时间 | **源端语义（只读实测）**：Prisma 在 SQLite 侧把 DateTime 存为 **INTEGER Unix 毫秒**（绝对瞬时量，无时区歧义）。编码 = 毫秒数 → UTC `YYYY-MM-DDTHH:mm:ss.SSS`。**断言 typeof=integer 且为合理毫秒值**；DateTime 列出现 TEXT 或异常数值 → **报错停止，不猜测时区**（不把无时区字符串自行当作 UTC 或本地）。业务日期/时间字符串列（usedDate/runDate/writeTime/pushDate 等，Schema 声明为 String）按 **S 类**原样处理，不进 T | 断言失败 → **报错停止** |
| Y BOOL | 单字节 `0`/`1` | — |

- **NULL 与空串**：`N` vs `SL0:`，永不混淆。
- **日期/时间/日期时间**：一律归一到 UTC 毫秒形态再编码；源列 datetime_precision 记入报告。
- **大整数/高精度小数**：I 用 BigInt 全精度、D 按列 scale 定标——任何会丢失精度的转换（浮点化大整数、四舍五入小数）**禁止**，遇到即报错停，不静默。

### 6.2 行/表/库摘要

1. **行序**：按主键列升序、复合主键按 **PK 声明序全列参与**（每列按其类型规范化字节序比较，NULL 最小；两行全 PK 相等视为重复并计入）；15 表均有主键。
2. 行摘要 = SHA-256(行编码字节)；表摘要 = SHA-256(各行摘要按行序拼接)；库摘要 = 各表 `表名=行数:表摘要hex` 按表名升序（大小写不敏感）`\n` 连接再 SHA-256。
3. 保存行数+表摘要+库摘要，前后两份比对，任一不等 = 作废本轮并报警。

### 6.3 源端 SQLite 指纹范围（不变）

`dev.db` + `-wal` + `-shm` + `-journal`（存在者全计入）逐文件 SHA-256+size+mtime；前后不一致 = 源被写，作废本轮。

## 7. 网络安全边界（P1-5 简化：W1/W2 延期）

### 7.1 网守真实覆盖范围（实测结论，保留）

Prisma Query Engine 走 Rust 原生 socket（tokio/TcpStream，二进制实测），**Node 层网守不覆盖其 DB 连接**；schema-engine 为独立进程同样不覆盖。表述统一为「**Node 进程 JS API 层隔离**」，不宣称 OS 级。

DB 连接目标的控制 = 两层（无防火墙也成立）：
1. **db-guard 配置层**（§8）：URL 强制数值 loopback + 用户名 wpc_smoke + 库名正则 + 反白名单；
2. **MySQL 账号层**：wpc_smoke 零常驻权限 + 逐 runId 字面授权，越权即连不上/查不到。

### 7.2 OS 级隔离（延期，非前置）

W1（Windows 防火墙出站白名单）/ W2（Sandbox）**延期为后续安全增强项**，不作为本次数据库切换的必要前置、不阻塞任何阶段（P1-5）。理由：防火墙规则对 Prisma 引擎子进程的实际约束需另行验证，验证成本高而当前威胁模型（单机开发、少量用户、防误操作为主）下 §7.1 两层已覆盖「误连/误删」。若后续启用，报告才可写「OS 级」；默认报告如实写「Node 层」。

## 8. db-guard 断言（fail-closed 七条）

1. `DATABASE_URL` 已注入且为 `mysql://` 连接串；
2. host 必须是数值 loopback（127.0.0.1/::1）；端口 = `SMOKE_DB_PORT`（显式 env，来源见 Init §2②，不依赖未说明的变量）；
3. **用户名必须是 `wpc_smoke`**（拒绝 root/wpc_migrate/wpc_runner/wpc_app/wpc_ro）；
4. 库名匹配 §1 全名正则，runId 与本次运行注册值一致；
5. 反白名单：拒绝 `wechat_pipeline`/`wpc_shadow`/`mysql`/`sys`/`performance_schema`/`information_schema` 及一切非 `wpc_smoke_` 前缀库；
6. 连接后 `SELECT DATABASE(), CURRENT_USER()` 实测与 URL 一致；
7. 通过后置 `__SMOKE_ISO_OK__='1'`。

## 9. 四件套改动面汇总（P1-A 实施清单，授权 (a)）

| 文件 | 改动 | 不许动 |
|---|---|---|
| smoke-isolated.ts | 建库链（显式字符集 §1）/ 父进程注册表（§2.1）/ 三查+八步清理（§3）/ GET_LOCK（§4）/ wpc_runner 转授（§5.2）/ 摘要指纹（§6）/ env 注入（**子进程只收临时库 DATABASE_URL 一份凭据**，由父进程凭 SMOKE_DATABASE_URL 派生；不注入 RUNNER/MIGRATE/SMOKE 其他连接串）/ 权限断言（§5.3） | scanWriters、env 白名单机制、超时/信号框架、verify 十项**语义** |
| smoke-db-guard.ts | §8 七条断言 | fail-closed 结构、`__SMOKE_ISO_OK__` 协议 |
| smoke-net-guard.mjs | §7.3 等价的 DB 端口放行 + 反例；头部注释「Node 层」表述 | v1 全部实测修正 |
| smoke-run.ts | selftest 用例表微调（URL 反例补 **wpc_ro**，与 root/migrate/runner/app 同列） | TARGET_MODULE、动态 import 次序 |

**删除面（相对 REV3 的简化）**：不建 `wpc_smoke_marker`/`wpc_shadow_marker` 任何标记表；不实现 W1/W2；不实现标记服务。

## 10. 验收标准（两段式，禁止提前宣称）

- **P1-A（静态验收）**：typecheck 绿；diff 白名单（仅 §9 点位）；不依赖 Prisma 的 selftest 全绿；安全走查 §1–§8 逐条对代码。
- **P2-B（完整运行验收）**：十项验收台全绿 + 三冒烟计数不降（lint 116 / style 33 / angles 30）+ 并发六用例 + §5.3 权限断言与反例 + 转授链路实测 + 真库前后摘要全等 + 残留清零。
- P2-B 未过之前只可写「静态验收通过」；临时库建/写/删含在授权 (b2)。
