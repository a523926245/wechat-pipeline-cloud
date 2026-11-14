# T1-A 补充决策 · SQLite 依赖完整清单
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（只读盘点，零删除零修改；REV4 同步：P0-1 行数勘误 **159**、五账号口径 wpc_runner 分离）
- **目的**：SQLite 退出正式开发数据库前的依赖全景。**先盘点、后处置**——本清单每项都带「切 MySQL 后处置」列，处置动作待实施阶段逐项授权执行。
- **结论速览**：依赖面集中在 **6 类**（Schema 生成链 / 真实数据 / T0 隔离 / 运行时适配层 / 复制式隔离脚本 / CI）；web 前端零依赖；Docker 生产路径已经只认 MySQL。
- **账号口径（六文档统一）**：root（用户自持）+ 五业务账号 **wpc_migrate（迁移）/ wpc_runner（临时库）/ wpc_smoke（测试）/ wpc_ro（只读，必需）/ wpc_app（应用）**；详见兼容方案 §5.1。

---

## A. Schema 与生成链（核心，切换后退役）

| 文件/入口 | 位置 | 作用 | 切 MySQL 后处置 |
|---|---|---|---|
| `schema.sqlite.prisma` | `server/prisma/` | SQLite 派生 Schema（gen 脚本产物） | **退役**（Phase 3 删/归档）；T0-v2 完成前保留 |
| `gen-sqlite-schema.mjs` | `server/scripts/` | 从 schema.prisma 派生 SQLite Schema | **退役**（同上） |
| `npm run schema:sqlite` | package.json:16 | 跑派生脚本 | **退役**；CI/文档引用同步清 |
| `npm run sqlite:generate` | package.json:17 | `prisma generate --schema schema.sqlite.prisma` | **退役** |
| `npm run sqlite:push` | package.json:18 | `prisma db push --schema schema.sqlite.prisma`（推 dev.db） | **退役**（真实库禁 db push 口径延续） |

## B. 真有数据载体

| 项 | 实测 | 切 MySQL 后处置 |
|---|---|---|
| `server/prisma/dev.db` | 974,848 字节；15 表；合计 **159 行**（2026-11-13 只读实测：Account 1 / Angle 33 / Article 12 / ComicPanel 0 / LlmModel 4 / ModelBinding 7 / RunLog 3 / Setting 24 / StylePrompt 42 / TaskRun 11 / Track 6 / TrackPipeline 12 / User 3 / UserSession 1 / WechatToken 0；REV3 总计「158」为笔误） | **数据搬迁到 MySQL 后原文件保留归档**（不删）；搬迁脚本幂等、先 dry-run；迁移验收基准=15 表 159 行 |
| `config.ts` 兜底路径 `var/tmp/dev.db` | DATABASE_URL 缺省时的 file: 兜底 | MySQL 化后**移除兜底或改为必填 env**（改动在 src，属 Phase 3） |
| `*.db.bak-*` 备份（.gitignore 已挡） | 历史备份文件 | 保留，不动 |

## C. T0 测试隔离机制（已验收冻结面，改前必须单独授权）

| 文件 | SQLite 依赖点 | 处置 |
|---|---|---|
| `scripts/smoke-isolated.ts`（795 行） | L258 `prisma db push --schema prisma/schema.sqlite.prisma`；L53 REAL_DB=prisma/dev.db 文件指纹（SHA-256+size+mtime）；verifyIsoChain 用 `PRAGMA database_list` | **T0-v2 兼容改造**（见 `T1-A-T0-ISOLATION-COMPAT-PLAN.md`），改前须授权 + 重跑十项验收 |
| `scripts/smoke-db-guard.ts`（106 行） | 断言 `DATABASE_URL` 必须是 `file:` 且命名 `dev.smoke-*.db`、位于 server/prisma/、反真实 dev.db 路径 | 同上（断言改为 MySQL 库名模式） |
| `scripts/smoke-net-guard.mjs`（439 行） | 无 SQLite 特有依赖（文件 I/O 不触网）；但 MySQL 版会撞其出站 TCP 拦截 | 同上（加 loopback DB 端口精确放行） |
| `scripts/smoke-run.ts`（184 行） | 基本无 SQLite 特有依赖 | 微调或不动 |
| `npm run verify:smoke-iso` / `smoke:prune-iso` | 验收台/残留清理（按 dev.smoke-*.db 文件名） | 随 T0-v2 适配（改临时库名模式） |

## D. 运行时适配层（src/**，IS_SQLITE 分支；Phase 3 可选简化）

| 文件 | 依赖点 | 切 MySQL 后影响 |
|---|---|---|
| `src/config.ts` | `IS_SQLITE = DATABASE_URL.startsWith('file:')`；dev.db 兜底路径 | IS_SQLITE 恒 false，分支休眠；**不必紧急改**，Phase 3 可简化 |
| `src/db.ts` | 注释：SQLite/MySQL client **共用同一生成目录**，切换须重新 `prisma generate`；`withLock` SQLite 直放、MySQL 走 `GET_LOCK` | **关键影响**（见影响分析 §1）；GET_LOCK 在 MySQL 生效=改善 |
| `src/db-json.ts` | Json→String 垫片（SQLite 把 Json 降级 String） | MySQL 原生 Json；垫片需回归验证写入形态（影响分析 §4） |
| `src/api/routes/system.ts` | `driver: IS_SQLITE ? 'sqlite' : 'mysql'` 展示 | 自动显示 mysql，无需改 |
| `src/services/angles.ts` | 注：SQLite 无 `mode:'insensitive'`、无全文索引 | MySQL 默认 collation 不敏感——**搜索行为会变**（列入回归） |
| `src/services/model-registry.ts` | 枚举降级 workaround（本地联合类型、不 import Prisma 枚举） | MySQL 枚举回归后 workaround 仍兼容，无需紧急改 |
| `src/services/pipeline.ts` | configJson 在 SQLite 下降级 String，走 packJson/unpackJson | 同 db-json，回归项 |
| `src/cli/migrate.ts` | 注：SQLite 单写者 | 数据搬迁工具本身（JSON→DB），目标库切换即适配 |

## E. 数据迁移 / 维护脚本（写真实库入口清单）

| 入口 | 性质 | 切 MySQL 后处置 |
|---|---|---|
| `npm run migrate` / `migrate:dry`（`src/cli/migrate.ts`） | 本机 JSON→DB 导入（dry-run 默认） | 改目标库为 MySQL 即可（Prisma 层，天然兼容） |
| `npm run migrate:automation`（scripts/migrate-automation.ts） | 一次性数据修补 | 同上 |
| `npm run migrate:track-config`（scripts/migrate-track-config.ts） | 一次性数据修补（注释叮嘱先备份 dev.db） | 同上；注释改「备份库」口径 |
| `npm run prisma:migrate`（`prisma migrate dev`） | **破坏性入口**（开发库） | Phase 2 起成为正式迁移机制（之前禁用） |
| `npm run prisma:deploy`（`prisma migrate deploy`） | 生产部署入口 | 与 deploy/install.sh 对齐 |
| `npm run schema:sqlite` / `sqlite:push` | 见 A | 退役 |

## F. 「复制 dev.db 隔离」模式脚本（切 MySQL 后该模式失效，需改临时库模式）

| 脚本 | 模式 | 处置 |
|---|---|---|
| `scripts/verify-bulk-delete.ts` | 复制 dev.db→临时库再跑 | 改「CREATE DATABASE 临时库 + dump/restore 或重建」模式 |
| `scripts/verify-zodiac.ts` | 同上（2026-11-11 事故后铁律载体） | 同上；铁律语义（写库验证必须隔离）**保留不变** |

## G. 直跑真实库的 smoke/verify（既有遗留，T0 报告 §10 已登记「禁止直接执行」）

`smoke:models / smoke:cover / smoke:migrate / smoke:bulk / smoke:auth / smoke:p2 / smoke:comic-align / smoke:comic-qc / smoke:comic-fallback / smoke:quote-card / smoke:users / smoke:ownership / smoke:automation / verify:bulk / verify:zodiac / verify:length`（16 条）+ 工具脚本 2 条。切 MySQL 后它们的「复制文件隔离」副产品失效（见 F），但**隔离铁律照旧**：未改造前一律不许直跑。

## H. CI 与部署

| 位置 | SQLite 依赖 | 处置 |
|---|---|---|
| `.github/workflows/ci.yml` | `schema:sqlite → sqlite:generate → sqlite:push → 冒烟串行`；注释「共享同一个 SQLite」 | Phase 3 改 MySQL service 容器 + migrate deploy；冒烟仍串行 |
| `Dockerfile` | **无 SQLite**（`COPY schema.prisma` + `prisma generate`，MySQL 路线） | 不动 |
| `deploy/install.sh` | **负向依赖**：明令禁跑 schema:sqlite；无 migrations 时走 ALLOW_DB_PUSH=1 逃生口 | Phase 2 后 migrations 就位→自动走 `migrate deploy`，逃生口收敛（部署阶段） |
| `deploy/app.env.example` | 注释「SQLite 仅供本地开发，生产用 SQLite 会炸」 | 改口径「开发/生产统一 MySQL」 |

## I. 文档引用（只改口径不删历史）

`docs/AUDIT-REPORT.md`、`docs/DEVLOG.md`（多处）、`docs/PRODUCT-PLAN.md`、`docs/restructure/` 系列（T0/STAGE0/SUPPLEMENT 等）提及 schema:sqlite / dev.db。**历史条目不改动**（如实记录当时事实）；新文档统一新口径。T0 系列文档里 schema.sqlite.prisma 的表述在 T0-v2 落地后补「兼容改造记录」。

## J. 零依赖确认

- `web/` 前端：grep `sqlite|dev.db` **零命中**。
- `server/src/` 无任何 SQLite 驱动直连（全部经 Prisma）。

---

## 处置汇总（供实施阶段逐项打勾）

| 优先级 | 动作 | 阶段/授权 |
|---|---|---|
| P0 | T0-v2 隔离改造（C 类，`wpc_smoke_<runId>` 口径见兼容方案）：P1-A 静态验收 → P2-B 运行验收 | P1-A【a】/ P2-B【b2】 |
| P0 | MySQL 初始化 + client 重生成（结构） | P2-A 结构段【b1】 |
| P0 | dev.db 数据搬迁 | P2-A 搬迁段【b2】 |
| P1 | A 类退役（schema.sqlite.prisma / gen 脚本 / sqlite:* 命令） | P3【c】 |
| P1 | F 类复制式隔离脚本改 wpc_smoke 临时库模式 | P3【c】 |
| P1 | CI 改 MySQL（H 类） | P3【c】 |
| P2 | D 类适配层简化（config/db-json 等分支清理，可选） | P3+ |
| — | G 类直跑脚本：维持「禁止直接执行」，逐个隔离化另行排期 | 遗留台账 |
