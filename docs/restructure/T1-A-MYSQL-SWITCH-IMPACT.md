# T1-A 补充决策 · MySQL 切换影响分析（REV4 同步）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（分析文档，零实施；REV4 同步：P0-1 行数勘误 159、五账号口径、W1/W2 延期、临时库显式字符集、collation 冲突预检）
- **范围**：本地开发库 SQLite（dev.db）→ 本机 MySQL 8.0.30 的影响面。「双库迁移架构」已整体作废，本文只分析「单库统一」切换本身。

---

## 1. 【最关键】Prisma client 单 provider —— T0 隔离兼容是切换的关键路径

**事实**（`src/db.ts` 头注原文）：本地用 SQLite schema 生成过 client 后，切回 MySQL 需要重新 `npm run prisma:generate`，两者共用同一个生成目录。

**推论**：切 MySQL 后 T0 隔离冒烟（SQLite 文件库）当场失效——**不存在「应用用 MySQL、测试继续用 SQLite」的长期共存形态**。T0-v2 是切换前置/同批必做项。执行顺序：**P1-A（T0-v2 代码+静态验收）→ P2-A（初始化与切换）→ P2-B（完整运行验收）**；P2-B 失败回退 = sqlite:generate + URL 回 file:./dev.db。

## 2. 同实例多库共存（隔离性影响）

本机实例已有 crm / wechat_publisher / wx_task_pocket 等其他项目库（只读列目录实测）。

- 只 CREATE `wechat_pipeline`（+ wpc_shadow）并只访问自己的库；
- 临时库 `wpc_smoke_<runId>`（22 字符全名正则）与这些库不可能混淆；DROP 只对逐个精确库名三查执行；
- 防护 = 库名守卫 + 显式库名 + 账号权限面（wpc_smoke 零常驻、wpc_runner 无业务库权限）。

## 3. 行为变化清单

| # | 点 | SQLite 现状 | MySQL 切换后 | 影响定性 |
|---|---|---|---|---|
| 1 | 命名锁 withLock | 直接放行 | GET_LOCK 真锁 | 改善 |
| 2 | 选题搜索 contains | 大小写/重音均**敏感**（BINARY） | utf8mb4_unicode_ci 大小写/重音均**不敏感** | **行为变化（双维度）**：'ABC' 命中 'abc'、'café' 命中 'cafe'；P4 双维度回归 |
| 3 | Json 字段 | 降级 String（packJson/unpackJson） | 原生 Json | 需回归写入/读回形态（§4） |
| 4 | 枚举 | 降级 String workaround | 真枚举 | workaround 兼容保留，无需为切换改 |
| 5 | 事务 DDL | SQLite 特殊行为 | MySQL DDL 隐式提交 | migrate 流程覆盖 |
| 6 | 字符集 | UTF-8 文件级 | 库级 utf8mb4 + utf8mb4_unicode_ci **显式指定**（含临时库，P0-8） | 不依赖实例默认值 |
| 7 | sql_mode | 无 | ONLY_FULL_GROUP_BY 等默认开 | 冒烟/回归兜出差异 SQL |
| 8 | 名字大小写 | 文件级 | lower_case_table_names=**1**（Windows 默认，G2 实测确认） | 守卫正则大小写不敏感 |
| 9 | 单写者限制 | 有 | 无 | 改善 |
| 10 | **唯一键语义** | BINARY 比较，互异值共存 | utf8mb4_unicode_ci 下可能**撞唯一键** | **迁移前置预检**（Init §5.2-1：目标 collation 下 GROUP BY HAVING>1 预检，冲突硬停人工裁决）；禁止通用 UPSERT |

## 4. Json 垫片专项

SQLite 下 packJson 存 String，MySQL 下字段是真 Json——直接 packJson 写入可能双重编码。验收要求：切换后跑「写 Setting/configJson/StylePrompt → 读回 → 对比」专项回归；有偏差则垫片在 IS_SQLITE=false 时旁路（P3 可选简化项）。

## 5. T0 保护机制语义迁移

| T0 机制 | SQLite 载体 | MySQL 化对应物 |
|---|---|---|
| 真实库指纹 | dev.db/-wal/-shm 文件 SHA-256 | 规范化行级 SHA-256 摘要（算法真源=兼容方案 §6） |
| 隔离验证链 | PRAGMA + 行数=0 | information_schema + COUNT(*)=0（15 张业务表） |
| 清理授权 | 删文件 | **父进程注册表 + 三查 + 八步清理**（REVOKE→验证→DROP→验证；兼容方案 §2/§3；无 marker 表） |
| 网络入口 | 无需放行 | Node 层网守仅放行 loopback DB 端口；**Prisma 引擎原生 socket 不经网守**（实测）→ db-guard URL 校验+账号权限兜底；**W1/W2 OS 级隔离延期**（P1-5，非前置） |
| 账号边界 | 文件权限 | 五账号（root + wpc_migrate 迁移 / wpc_runner 临时库 / wpc_smoke 测试 / wpc_ro 只读 / wpc_app 应用；兼容方案 §5.1） |

## 6. CI / 部署影响

- `ci.yml`：切换后改 GitHub Actions mysql service + `prisma migrate deploy` + 串行冒烟（P3）。
- `Dockerfile`：已是 MySQL 路线，不受影响。
- `deploy/install.sh`：migrations 就位后自动走 migrate deploy，ALLOW_DB_PUSH 逃生口收敛（部署阶段）。

## 7. 数据搬迁影响（dev.db → MySQL）

- 源：**15 表 / 159 行**（P0-1 只读实测定案；REV3 总计「158」为笔误，明细各表无误）。量小，一次性脚本完成。
- 纪律：源只读 + 前后指纹；dry-run→apply→verify；逐行 INSERT（禁通用 UPSERT）、PK 原值搬运；唯一键 collation 冲突预检；FK 拓扑序（循环才关 FK 检查且同连接、恢复后孤儿检查）；完成后 dev.db 归档保留。
- 风险低（量小）；Setting/StylePrompt 的 Json 字段是回归重点。

## 8. 待用户确认项

1. **库名**：建议 `wechat_pipeline`（deploy 口径一致）。
2. **凭据**：按决策报告 §5 建五账号（wpc_migrate/wpc_runner/wpc_smoke/wpc_ro/wpc_app），连接串写 server/.env。
3. **dev.db 数据搬迁**：建议搬（159 行含 42 条文风配置等真实资产）。

## 9. 风险汇总

| 风险 | 等级 | 缓解 |
|---|---|---|
| 切 client 后 T0 冒烟失效被忽略 | 高 | T0-v2 前置强制；切换验收含三冒烟全绿 |
| 唯一键 collation 冲突 | 中 | 目标 collation 预检，冲突硬停（§3-10） |
| Json 双重编码 | 中 | §4 专项回归 |
| 误碰其他项目库 | 中 | 库名守卫+五账号权限面 |
| 搜索行为变宽 | 低 | P4 双维度回归；改 collation 交用户拍板 |
| CI 未同步 / sql_mode 差异 | 低 | P3 清单；全量冒烟兜底 |
