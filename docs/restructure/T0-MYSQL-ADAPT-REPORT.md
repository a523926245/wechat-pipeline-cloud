# T0-MYSQL-ADAPT 验收记录（S1-3）

日期：2026-11-14 ｜ 真源：RESTRUCTURE-2.0-CONVERGED-PLAN.md §四 4.1「最小必要适配」对照表 ｜ 命令名与测试覆盖不变

## 一、适配范围（载体替换，语义保留）

| 组件 | 动作 | 文件 |
|---|---|---|
| `smoke-db-guard.ts` | 🔄 文件路径白名单 → **库名白名单**：只允许 `wechat_pipeline_smoke`；拒 `file:` 串、拒业务库/shadow 库名、拒错主机/错端口（fail-closed 零绕过不变） | 重写 |
| `smoke-isolated.ts` | 🔄 隔离载体 `dev.smoke-*.db` 文件 → **固定库 wechat_pipeline_smoke**：run 前重建（清空 + `prisma migrate deploy` 到测试库）、run 后清空；真实库保护证明 = 业务库 16 表 COUNT+CHECKSUM 状态指纹 + dev.db 文件指纹（双保险）；框架/信号/清理矩阵/并发写入者扫描/env 白名单/netCases/timeout **一律未动** | 改造 |
| `smoke-run.ts` / `smoke-net-guard.mjs` / smoke-lint/style/angles | ✅ 零改动 | — |
| `smoke:prune-iso` | 🗑 改「smoke 库无残留表」空壳检查（命令名暂留，S2 退役删除） | 随 runner |
| schema.sqlite.prisma / sqlite db push 路径 | 🗑 S1 停用（未删除，S2 清理） | — |

无 `db push` / `migrate reset` / `force-reset`；业务库/shadow/他库零写入。

## 二、十项验收台（verify:smoke-iso，2026-11-14 实跑）

```
PASS  ① 隔离数据库正向测试通过
PASS  ⑨ 空库证明（表结构存在 + 行数=0 + 自建数据创建/查询/清理）
PASS  ② 真实数据库反向测试被拒绝   ← MySQL 形态指业务库 / 指 shadow 库 / file: 旧串，三反例全部 FAIL 拦截
PASS  ③ 环境变量注入失败时直接退出   ← 缺失 / 非 mysql 串 / 错主机 / 错端口 / 缺库名，五反例全部拒绝
PASS  ④ 网络访问被阻断（Node 层）
PASS  ⑩ 网络隔离反向测试（13 反例）
PASS  ⑦ 真实库（业务库状态 + dev.db 文件）前后指纹一致
PASS  ⑧ 副本清理（五条退出路径 + SIGKILL 残留暴露 → 重建清空恢复）
PASS  ⑤ 三个 smoke 原有断言全部保留
PASS  ⑥ 四连在隔离副本上通过（注：typecheck 单项见 §四）
[verify] 10/10 项通过
```

## 三、三条冒烟计数（不降级）

| 命令 | 计数 | 结果 | CLEANUP | REAL-DB FINGERPRINT |
|---|---|---|---|---|
| `npm run smoke:lint` | **116 项** | 全过 | ok | MATCH |
| `npm run smoke:style` | **33 项** | 全过 | ok | MATCH |
| `npm run smoke:angles` | **30 项** | 全过 | ok | MATCH |

## 四、验收标准对照（任务书 §五）

1. ✅ 冒烟在 MySQL 环境完整运行（三冒烟 + 验收台 10/10）
2. ✅ 计数不降（116 / 33 / 30）
3. ✅ smoke 与业务库严格分离（库名白名单 + 库名硬断言 + smoke 库 run 后 0 表）
4. ✅ 负向测试：错误连接业务库/shadow/file: 串被守卫拒绝（② 三反例 + ③ 五反例）
5. ✅ 业务库 15 表与数据不变（16 表总行数 2 = 迁移记账记录，业务表全 0 行；每轮指纹 MATCH；dev.db sha256 `fea0f123…`/974848 不变）
6. ⚠️ **部分**：`prisma validate` ✅；**`tsc --noEmit` 21 处既有类型错误被阻塞**（见 §五，非 S1-3 引入，按 §六 纪律未自行扩面修复）
7. ✅ 应用正常启动（`/api/health` = ok:true, db:up, driver:mysql, autoPublish:false）
8. ✅ 原 T0 验收成果保留（5ad4f46 内容零改动，T0-ACCEPTANCE-* 文件未触碰）

## 五、被阻塞项：TypeScript 检查（既有缺陷，待授权修复）

S1-2 重生成 MySQL 版 `@prisma/client` 后暴露（此前 typecheck 是对 SQLite 变体 client 类型产物通过的）：

- **A 类 15 处**：JSON 列传 `null`/`string | null`，MySQL client 要求 `Prisma.JsonNull`（部分路径运行时也会抛，如 scheduler.ts runLog 被 try/catch 吞掉）——机械修复，不动数据语义。
- **B 类 6 处**：`schema.prisma` 的 `ModelRole`/`ModelProtocol` enum **缺代码在用的值**（`comic_panel_fallback`、`modelscope_qwen_image_mcp`）——修复需要 **改 schema enum + 迁移（数据库架构变更）**，触碰 §六「必须改变数据库架构→先停止并报告」红线，故停。

涉及文件：models.ts / llm.ts / planner.ts / publisher.ts / scheduler.ts / comic/panels.ts / comic/write.ts。

## 六、修改文件与 Git 状态

- 修改（未提交）：`server/scripts/smoke-db-guard.ts`、`server/scripts/smoke-isolated.ts`
- Commit B `80a6e1a`（S1-2 完成节点，本轮 §二 授权提交）：schema.prisma + migration.sql + migration_lock.toml
- CHANGELOG.md / docs/DEVLOG.md（历史遗留未动）；untracked 文档未动；T0 证据未动
- 本记录文件为新增留档，未提交

## 七、数据库前后状态

| 库 | 前 | 后 |
|---|---|---|
| wechat_pipeline | 16 表（15 业务全 0 行 + _prisma_migrations 2 行） | 同（指纹 MATCH ×3 轮） |
| wechat_pipeline_smoke | 0 表 | 0 表（每 run 前重建 / 后清空） |
| wechat_pipeline_shadow | 15 空表（S1-2 期 Prisma shadow 重放残留） | 同，未触碰 |
| 其他项目库 | 不可见 | 零操作 |
| dev.db（归档） | fea0f123…/974848 | 同 |
