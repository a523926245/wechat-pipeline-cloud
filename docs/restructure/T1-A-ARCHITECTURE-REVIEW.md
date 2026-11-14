# T1-A-ARCHITECTURE-REVIEW · 双数据库迁移架构重新评估
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

> **⚠️ 已被取代（2026-11-13 晚）**：用户决策统一 MySQL（本机开发 / 测试 / 未来生产同一套），
> 双库迁移架构问题域消失。本文件 A/B/C 对比归档备查，现行方案见 `T1-A-ROLLOUT-PLAN.md` 等六份新文档。

> **性质**：T1-A 方案二次审核轮，纯分析文档。本轮**未执行任何数据库变更**——未跑 `db push` / `migrate dev` / `migrate deploy` / `migrate resolve`，未改任何真实库、Schema、业务代码与 T0 四件套。
> 本轮使用的只读工具：`prisma migrate diff`（官方帮助原文："read-only command that does not write to your datasource(s)"）、`prisma migrate status`（仅作用于 `var/tmp` 探针文件）、`prisma --help` 系列、sqlite3 `mode=ro`、Windows 服务查询。
> 回应对象：T1 授权书「二、必须重新评估的四个问题」第 1 题。原方案见 `T1-A-READONLY-REPORT.md` §7（已被本文及 `T1-A-BASELINE-REVISED.md` / `T1-A-BACKUP-RESTORE-REVISED.md` 修订取代）。

---

## 1. 原方案回顾（被评审对象）

T1-A 只读检查报告 §7 提出：

1. **MySQL** 使用 Prisma Migrate（建 `prisma/migrations/0_init` 基线 + `migrate resolve` 登记）；
2. **SQLite** 继续使用 `prisma db push`，加「备份→副本演练→指纹比对」门禁（"安全同步"）；
3. 两套 Schema（`prisma/schema.prisma` 与 `prisma/schema.sqlite.prisma`）通过**结构指纹**做等价性验证。

本次要求：重点分析 **SQLite 是否应建立独立迁移链**；比较 A / B / C 三类架构；给出推荐架构与选择依据；不得为追求统一而强共用不同 provider 的迁移文件；**SQLite 含真实业务数据，不可视为随时可删重建的纯测试库**。

---

## 2. 本轮新增实测事实（全部只读，逐条附证据）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **T0 冻结面绑定 schema 路径**：`smoke-isolated.ts:258` 为 `[prismaCli, 'db', 'push', '--schema', join('prisma', 'schema.sqlite.prisma'), '--skip-generate']`（文件头注释 ⑥ 同）。`prisma/schema.sqlite.prisma` 必须留在原路径，否则 T0 四件套失效；而四件套**禁改** | 本轮 grep 原文；T0 验收报告 |
| F2 | Prisma **5.22.0**（`package.json` `^5.22.0`）CLI 实测：`migrate resolve --applied` = "Record a specific migration as applied / **baseline** databases when starting to use Prisma Migrate on existing databases"——**仅登记状态**；`db push` 破坏性旗标 `--accept-data-loss`（忽略数据丢失警告）与 `--force-reset`（重置整个库）；migrate 系列唯一路径参数是 `--schema`，**无 `--migrations-dir`**（可配置迁移目录是 Prisma 6.6+/7 `prisma.config.ts` 的能力，5.22 没有） | `npx prisma migrate --help` / `migrate resolve --help` / `db push --help` 实测输出 |
| F3 | **migrations 目录按 schema 文件所在目录解析，不可配置**：探针（`var/tmp/probe-mig/schema.prisma` + `var/tmp/probe-mig/migrations/9999_probe`）跑 `prisma migrate status --schema var/tmp/probe-mig/schema.prisma`，输出「1 migration found … 9999_probe」——它找到了只存在于探针目录 `migrations/` 下的迁移（输出里的 "prisma/migrations" 只是字面标签）。⇒ `schema.prisma` 与 `schema.sqlite.prisma` 同在 `server/prisma/`，若各建 Prisma 迁移链将**争用同一 `server/prisma/migrations/`** | 探针输出原文见 §8 |
| F4 | `migrate diff` 5.22 语义（实测 `--help`）：`--to-schema-datamodel` = 读 schema 文件 datamodel（**不连库**）；`--to-schema-datasource` = "uses the **datasource url** for the diff"（**连库**读实测结构）；官方明示**跨 provider diff 不支持**（"e.g. a diff using 2 different providers like PostgreSQL and SQLite is not supported"） | `npx prisma migrate diff --help` 实测输出 |
| F5 | **Schema 单向派生**：`scripts/gen-sqlite-schema.mjs` 从 `schema.prisma`（MySQL 真源）生成 `schema.sqlite.prisma`（文件头「自动生成，请勿手工编辑」）。等价性是**构造性**的，不是「两份手维护 schema 互相比对」 | 生成器脚本全文；T1-A 只读报告已实测 `gen === cur` 逐字节为 true |
| F6 | **部署拓扑**：生产=Linux 服务器（`deploy/README.md` systemd 路线为生产推荐；`docker-compose.yml` 为开发/自托管快速路线，`db` 服务 `mysql:8.0`）；库名 `wechat_pipeline`（`deploy/app.env.example` 与 compose `MYSQL_DATABASE` 两处一致）；生产当前结构同步**靠 `prisma db push`**（deploy §四配方 + `install.sh` 的 `ALLOW_DB_PUSH=1` 逃生口），从未有迁移历史 | deploy/README.md §二/§四；docker-compose.yml |
| F7 | **本机 MySQL 身份**：Windows 服务 `MySQL`（Running / Auto），`PathName=D:\Soft\MySql\mysql-8.0.30-winx64\bin\mysqld`——手动安装版实例，非 Docker；与生产（Linux）无关。定性待用户确认（DECISION-REPORT Q3） | `Get-CimInstance Win32_Service` + 端口 3306 进程路径查询 |
| F8 | **SQLite 真实业务数据**：`dev.db` 含退役本机流水线历史（Track 6 / Article 12 / Angle 33 / StylePrompt 42 …，本轮只读点验 Track=6、Article=12），业务上不可再生 | sqlite3 `mode=ro` 计数 |

---

## 3. 三方案定义

### 方案 A（原方案）——MySQL 正式迁移链 + SQLite `db push`「安全同步」

- MySQL：`prisma/migrations/` 正式链，`0_init` 基线 + `migrate resolve` 登记。
- SQLite：结构变更继续 `prisma db push`（现成 `npm run sqlite:push`），外加门禁（备份→副本演练→指纹比对）。
- 无 SQLite 侧迁移历史。

### 方案 B——双 Prisma 迁移链（MySQL、SQLite 各一条独立 `migrate` 链）

技术前提是两 schema 文件必须位于**不同目录**（F3：migrations 目录= schema 同级 `migrations/`，同目录必争用）。两个落地形态：

- **B1 目录搬迁**：`schema.sqlite.prisma` 迁至如 `prisma/sqlite/`（链在 `prisma/sqlite/migrations/`）。**触碰 T0 冻结面**（F1：`smoke-isolated.ts:258` 硬编码原路径，须改一行适配）——本次授权边界内不可行，需用户单独解冻。
- **B2 字节副本锚点**：`prisma/schema.sqlite.prisma` 原地不动（T0 继续用），另建 `prisma/sqlite-migrate/schema.prisma` 作为 SQLite 链锚点，生成器**同时写两份、逐字节一致** + 新鲜度门禁。零解冻，但引入永久「双 schema 文件」并存：误用面真实存在（有人对 `prisma/` 下 schema 跑 `migrate dev` 会把 MySQL 链的 `prisma/migrations/` 写混）。

### 方案 C（推荐）——MySQL=Prisma Migrate 链；SQLite=独立轻量迁移链（自研 runner）

- MySQL：`prisma/migrations/` 正式链（与 A 相同）。
- SQLite：独立链，**不占 Prisma 目录**：
  - 迁移文件 `server/prisma/sqlite-migrations/NNNN_描述.sql`（4 位序号；可选同名 `.down.sql`）；
  - journal 表 `_wpc_sqlite_migrations(id, name, applied_at, checksum)`（命名刻意避开 `_prisma_migrations`，防工具混淆）；
  - runner `server/scripts/sqlite-migrate.ts`：`status | up | baseline` 子命令；`up` 在**单事务**内按序执行未应用文件并写 journal（SQLite 支持事务性 DDL，中途失败整体回滚）；checksum 校验防已应用文件被篡改；
  - 迁移 SQL 来源：`prisma migrate diff`（只读）生成草稿 → **人工审核**（rename 类必须改写为数据保全式：建新列→回填→删旧列）→ 入库。
- `db push` 仅限**一次性/隔离库**（T0 的 `dev.smoke-*.db`、备份恢复演练副本）；真实 `dev.db` 与生产库**禁止** `db push`（含 `sqlite:push` 脚本加防呆）。
- T0 零改动：smoke 隔离库继续由 `smoke-isolated.ts` 用 `db push` 创建（一次性库，合法用法）。

**三方案共同点（不可违反）**：都不共用跨 provider 迁移文件——F4 官方语义也不允许同一 diff/迁移链横跨 MySQL 与 SQLite。

---

## 4. 六维对比

| 维度 | A：MySQL 链 + SQLite db push | B：双 Prisma 链（B1 搬迁 / B2 副本锚点） | C：MySQL Prisma 链 + SQLite 轻量链 |
|---|---|---|---|
| 数据安全 | SQLite 侧 rename/类型变更走 db push：要么被拒（上线卡死）要么过 `--accept-data-loss`（数据丢失面，F2）；无数据保全式改写通道 | 两链迁移 SQL 均人审，可写数据保全式；安全上限最高 | 同 B：SQLite 迁移 SQL 人审、可数据保全式；db push 破坏面（`--force-reset`）从真实库彻底移除 |
| 迁移可追踪性 | MySQL 全历史；**SQLite 无逐次记录**（只有事后状态快照，无法回答「上周二谁改了什么」） | 两库全历史（`_prisma_migrations`，含 applied_at/checksum） | MySQL `_prisma_migrations`；SQLite journal 表全历史（等价信息量） |
| 回滚与恢复 | 回滚=备份恢复（Prisma 三方案一致：**无 down migration**）；SQLite 侧连「当前结构版本号」都没有，恢复后对位靠猜 | 同为备份恢复；两库均有版本号，恢复后可 `migrate status` 对位 | 同 B：journal 即版本号；`.down.sql` 可选提供，不承诺 |
| 双 Schema 一致性 | 与迁移架构无关，靠等价性验证（原方案「结构指纹」口径模糊，见 §5） | 同左；**B2 额外引入双 schema 文件漂移风险**（须新鲜度门禁兜底） | 同左；无额外漂移面（schema 文件仍是一份） |
| 日常维护成本 | 最低（一条链） | 最高：B1 需解冻 T0 + 目录搬迁联动；B2 永久双文件纪律 | 中：一条 Prisma 链 + 一条轻量链；迁移 SQL 由 diff 自动生成后，日常≈每次变更多一道人审 |
| Prisma 5.22 兼容性 | 完全兼容 | 技术可行（`--schema` 分目录）但受 F1/F3 布局约束，当前授权内 B1 不可行 | 兼容：MySQL 链与 SQL 生成均用 Prisma；runner 不依赖 Prisma 迁移体系（仅 `db execute` 或 better-sqlite3 级执行，实现期定） |

### 逐维展开

1. **数据安全**（权重最高，SQLite 有真实数据）：A 的软肋不在「备份做不做」，而在**变更通道**——`db push` 对 rename/类型收窄/删列只有两档：拒绝，或（加 `--accept-data-loss`）接受丢失。真实业务库上这是结构性缺陷。B/C 把变更通道换成人审 SQL，「建新列→回填→删旧列」这类保全式改写成为常规操作。
2. **迁移可追踪性**：审计文化是本次重构的底色（GenerationRun 同向）。A 在 SQLite 侧留审计缺口；B/C 补齐。
3. **回滚与恢复**：三方案打平（Prisma 无 down migration，回滚共同=备份恢复）——所以**备份恢复演练（另一份文档）是共同底座，与选型无关**，不能拿「回滚能力」替 A 加分。
4. **一致性**：跨 provider 不可 diff（F4），任何方案都不能靠「迁移链」保证 MySQL↔SQLite 一致；一致性只能靠 §5 三级验证。B2 的双文件是新的不一致源，需要额外门禁。
5. **维护成本**：A 最低；C 在「迁移 SQL 自动生成 + 人审」模式下日常增量≈一次 review；B 的两个形态都伴随永久性布局复杂度。
6. **兼容性**：A/C 无风险；B 受制于 5.22 的目录规则与 T0 冻结面。

---

## 5. 「结构指纹等价性验证」原表述的修订

原方案措辞「两套 Schema 通过结构指纹进行等价性验证」有歧义（跨 provider DDL 不可直接 diff，F4）。修订为**三级等价性验证**（A/B/C 通用）：

| 级 | 手段 | 判据 | 时点 |
|---|---|---|---|
| L1 构造性一致 | `schema.sqlite.prisma` 由生成器从 `schema.prisma` 单向派生，**禁止手改** | 生成器即真源 | 每次 schema 变更 |
| L2 新鲜度门禁 | 重新跑生成器，输出与在库文件**逐字节比对** | `gen === cur`（T1-A 只读轮已实测 true） | 每次提交/CI |
| L3 各库↔各 schema drift 实测 | SQLite：`migrate diff --from-url file:dev.db(副本) --to-schema-datamodel schema.sqlite.prisma`（只读）；MySQL：`migrate diff --from-url <生产只读> --to-schema-datamodel schema.prisma`（只读） | diff 输出为 "empty migration"（零漂移）或差异全部有批准的解释 | 每轮结构变更前后 + 基线登记前 |

「等价」的准确含义：**在生成器降级映射规则下的语义等价**（enum→String、Json→String?、`@db.*` 注解剥离），不是 DDL 相同。映射规则固化在 `gen-sqlite-schema.mjs` 并在 Baseline 文档中列明。

---

## 6. SQLite 真实业务数据的特殊性（授权书特别注意项）

- `dev.db` 是退役本机流水线的**历史载体**（文章/角度/文风/模型绑定…），业务上不可再生；
- 推论一：任何「出问题就删库重建」的流程设计都不可接受——A 方案若把 db push 失败的处理写成「force-reset 重来」，直接违反本约束；
- 推论二：结构变更必须**数据保全式**（rename=建新+拷+删；扩值域=回填），这要求变更 SQL 可被人工改写——B/C 的人审通道正是为此设的审核点，A 没有；
- 推论三：备份恢复演练（S1-S6）是 SQLite 侧一切变更的前置条件。

---

## 7. 推荐结论与选择依据

**推荐：方案 C（首选）**，并保留两条明确的替代路线供用户拍板：

| 路线 | 条件 | 评价 |
|---|---|---|
| **C（推荐）** | 维持 T0 冻结 | SQLite 变更可审计、可数据保全、真实库零 db push 破坏面；成本=一次性 runner（~百行 + 失败注入演练） |
| B1（远期最优） | 用户愿意解冻 T0 一行（`smoke-isolated.ts:258` 路径适配） | 双链全用 Prisma Migrate，最标准、零自研；代价=触碰已验收文件 |
| A-加固（可接受下限） | 用户拒绝任何自研迁移代码 | 成本最低；**必须书面接受** SQLite 侧无逐次审计历史的缺口，且 `sqlite:push` 加防呆（禁 `--accept-data-loss`/`--force-reset`） |

选择依据：

1. **真实数据的变更审计与保全 > 工具惯例**：SQLite 不是测试库（F8、§6），逐次可审、可保全式改写的变更通道是「地基正确」的底线要求；
2. **单源派生下双链成本可控**：schema 只有人工改一份（F5），SQLite 迁移 SQL 由 `migrate diff` 只读生成，人审增量有限；
3. **T0 冻结合规**：C 不触碰四件套；B1 在本授权内不合法；
4. **db push 破坏面收敛**：`--force-reset`/`--accept-data-loss`（F2）从真实库的日常路径移除，只保留一次性库用法；
5. **回滚能力无差别**：三方案都靠备份恢复（无 down migration），故不构成选 A 的理由；
6. **不共用跨 provider 迁移文件**：C 的两条链物理隔离（`prisma/migrations/` vs `prisma/sqlite-migrations/`），零共享——直接落实授权书要求。

---

## 8. 附：本轮关键探针输出原文

**F3 migrations 目录解析探针**（`prisma migrate status --schema var/tmp/probe-mig/schema.prisma`，探针库 `file:probe.db`）：

```
Prisma schema loaded from var\tmp\probe-mig\schema.prisma
Datasource "db": SQLite database "probe.db" at "file:probe.db"

1 migration found in prisma/migrations
Following migration have not yet been applied:
9999_probe
```

（`9999_probe` 只存在于 `var/tmp/probe-mig/migrations/` → 查找路径=schema 同级 `migrations/`；"prisma/migrations" 为输出字面标签。探针目录已删除。）

**F4 `migrate diff` 帮助关键句**：

```
prisma migrate diff is a read-only command that does not write to your datasource(s).
The source and destination must use the same provider,
e.g. a diff using 2 different providers like PostgreSQL and SQLite is not supported.
  --from-schema-datamodel  Path to a Prisma schema file, uses the datamodel for the diff
  --from-schema-datasource Path to a Prisma schema file, uses the datasource url for the diff
```

**期望 MySQL DDL 生成实证**（`--from-empty --to-schema-datamodel`，零连接）：exit=0，321 行，SHA-256 `312e765c749ef32e5b8c8d83b7d7f82e5986408eb5c9c24ccd7cf823f2f2f6e1`，产物暂存 `server/var/tmp/t1a-expected-mysql-ddl.sql`（scratch，可按 `T1-A-MYSQL-READONLY-CHECK.md` §3.6 命令随时再生成）。
