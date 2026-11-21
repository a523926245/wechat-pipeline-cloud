# T1-A · 分阶段实施计划（REV4.1）
> **⚠️ 已被取代（2026-11-14）**：本文属 T1-A 历史方案（数据库切换系列），已被 `RESTRUCTURE-2.0-CONVERGED-PLAN.md` 取代归档，仅作历史参考，不作为实施依据。

- **日期**：2026-11-13（REV4.1；计划文档，零实施）
- **总原则**：每阶段单独授权、单独验收、单独停点；红线全程有效（AUTO_PUBLISH=false、群发人工、dev.db 归档不删、同实例其他项目库不碰、不改业务断言）。**不过度设计**：W1/W2 网络隔离延期、marker 表取消、账号按职责五号封顶。
- **REV4.1 修订**：B8 回退两档（P1-A 单独 commit、完整回退含 T0-v1 恢复、仅应用回退须标注）；P1-A selftest URL 反例补 wpc_ro；外部审核结论=P1-A 有条件通过（A1-A3 修订已完成于本轮文档）/ P2-A 暂缓（须 B4-B8 修订+G4 实测，文档已于本轮完成修订，实施仍待授权）。
- **阶段总览**：P0 只读方案（✅）→ P0-R 文档修订（✅ REV2/REV3/REV4/**REV4.1**）→ **P1-A** T0-v2 代码+静态验收 → **P2-A** MySQL 初始化/切换/搬迁 → **P2-B** T0-v2 完整运行验收 → **P3** SQLite 清理与 CI → **P4** 回归与收尾。

---

## P1-A · T0-v2 代码实现及静态验收

- **范围**：仅按 `T1-A-T0-ISOLATION-COMPAT-PLAN.md` §9 改动面实施四件套（wpc_smoke_<runId> 显式字符集建库 / **父进程内存注册表=运行期唯一授权真源**（注册文件仅恢复线索，无 marker 表）/ 三查+**八步清理**（REVOKE 先于 DROP）/ GET_LOCK 同连接互斥 / wpc_runner 转授 / 行级 SHA-256 摘要 / 五账号断言 / 网守 DB 端口放行）；verify 台语义不变、载体适配。**此时 client 仍是 SQLite flavor。**
- **P1-A 改造必须单独成 git commit**（B8：完整回退依赖 revert 该提交恢复 T0-v1）。
- **验收 = 静态验收（不得写「T0-v2 已验收」）**：
  1. `npm run typecheck` 绿；
  2. git diff 白名单核对：仅兼容方案 §9 点位，业务断言零改动；
  3. 不依赖 Prisma 的 selftest 全绿（runId 正则 / URL 解析 / 网守反例含 3307、127.0.0.2、root/migrate/runner/**ro**/app URL 五种身份反例）；
  4. 安全走查逐条对代码（含「REVOKE 失败不得 DROP」「归属不明拒删」「GET_LOCK 同连接」「无 marker 表依赖」「注册文件不作授权依据」）。
- **风险**：放行面开口过宽 / 三查八步实现走样 / 动到冻结面外代码。
- **所需授权**：**(a) 修改 T0 四件套**（仅限 §9 点位）。
- **停点**：静态验收报告提交后停下。

## P2-A · MySQL 初始化、Client 切换与数据搬迁（结构段 → 搬迁段）

- **前置**：P1-A 静态验收通过；用户配合项完成（§配合项）。
- **范围**（按 `T1-A-PRISMA-MIGRATE-INIT-PLAN.md` §2 八步）：
  - **结构段（授权 b1）**：用户建库建号（wechat_pipeline + wpc_shadow 显式字符集 + 五账号）→ .env → 连接/权限/安全检查 → schema.prisma shadowDatabaseUrl 一行 → migrate init → generate + V1/V2 → diff 双向 empty + 四类对象补查。
  - **搬迁段（授权 b2）**：源快照纪律 → dry-run→apply→verify（唯一键 collation 冲突预检、FK 拓扑序、逐行 INSERT、幂等/断点/dry-run 三证明）。
- **验收**（Init §8 全 5 条）：门禁留档 / diff 双向 empty / 四类对象全空 / generate V1 V2 / **15 表 159 行** + 逐表摘要全等 + 三证明 + 唯一键预检报告 / dev.db 前后指纹一致、其他库零触碰。
- **风险**：连错实例 / 非空库误推 / collation 唯一键冲突 / JSON 编码 / 搬迁中断（均有对应拦截）。
- **所需授权**：
  - **(b1) 结构段**：建库、五账号授权（用户以 root 自跑）、schema 一行、.env、migrate init、generate；
  - **(b2) 搬迁段 + P2-B 临时库**：搬迁脚本执行（源只读）；P2-B 期间 wpc_smoke_% 临时库建/写/删与转授回收含在 (b2)。
- **回退（B8 两档）**：**完整回退**=git revert P1-A 单独提交（恢复 T0-v1 四件套）+ `sqlite:generate` + DATABASE_URL 回 file:./dev.db；**仅应用回退**=sqlite:generate + URL 回 dev.db 而四件套不动（冒烟两侧均不可用），报告须明确写「应用回退」而非「整个 T0 系统回退」。dev.db 未动。
- **停点**：验收报告提交后停下。

## P2-B · T0-v2 MySQL 完整运行验收

- **范围**（只有本阶段过了才可宣称 T0-v2 已验收）：
  1. 十项验收台全绿（载体 MySQL、语义不变）；
  2. 三冒烟计数不降：lint **116** / style **33** / angles **30**（当场计数）+ typecheck；
  3. 并发六用例（并发双跑 / prune-vs-active / runId 重入 / 冒名库拒删 / 锁竞争 / 连接中断重查）；
  4. 权限断言（含角色/skip_name_resolve 记录）+ root/migrate/runner/app URL 反例被拒 + 逐 runId 转授链路实测（含 REVOKE 验证步）；
  5. 真库前后逐表摘要全等；残留清零。
- **所需授权**：临时库写入已在 **(b2)** 内；修四件套缺陷回 **(a)** 补授权。
- **停点**：验收报告提交后停下。

## P3 · SQLite 清理、CI 与部署对齐

- **范围**（依赖盘点处置表逐项）：退役 schema.sqlite.prisma / gen 脚本 / sqlite:* 命令；verify-bulk/zodiac 复制式隔离改临时库模式（隔离铁律语义不变）；CI 改 MySQL + migrate deploy；（可选）IS_SQLITE 简化、ALLOW_DB_PUSH 收敛。
- **前置**：P2-B 通过（回退路径不再需要后才删）。
- **验收**：grep 无 SQLite 残留引用（历史文档除外）；CI 全绿；三冒烟+typecheck+build 全绿。
- **所需授权**：**(c)**。
- **停点**：验收报告提交后停下。

## P4 · 回归、收尾与整体验收

**前置**：P3 完成（P3→P4 串行）。

### 回归边界（六条）

1. 开发库回归写入只经正常应用行为；`wpc_smoke_%` 临时库任意写；
2. 测试数据一律隔离，不在开发库堆垃圾；
3. 真实 LLM 外联单独授权、限次留档，默认 mock；
4. 不真连微信（草稿箱 mock）；如需真连单独授权；
5. AUTO_PUBLISH=false 全程有效；
6. 业务断言零改动、计数不降。

### 范围

article/comic 双产线回归（mock）；搜索 collation 双维度回归（utf8mb4_unicode_ci 大小写+重音均不敏感 vs SQLite BINARY 均敏感，用例双维度各测；若业务需敏感，「改 collation 或代码显式 COLLATE」交用户拍板）；CHANGELOG / DEVLOG / 记忆回写；整体验收报告。

- **所需授权**：无新增；边界 3/4 外联逐项单独授权。
- **停点**：整体报告提交后停下，等 T1-A 全阶段验收；不进 T1-B。

---

## 依赖总图

```
P0-R 文档（✅ 含 REV4）
 └─ P1-A（T0-v2 代码+静态验收）        [a]
     └─ P2-A 结构段（初始化+切换）      [b1]（用户建号配合）
         └─ P2-A 搬迁段（数据搬迁）      [b2]
             └─ P2-B（完整运行验收）      [b2；缺陷修复回 a]
                 └─ P3（SQLite 清理+CI）  [c]
                     └─ P4（回归+收尾）    [无新增]
```

关键顺序：不在 SQLite client 下宣称 T0-v2 已验收；P3 不先于 P2-B；P4 不先于 P3；搬迁段不先于结构段。

## 授权汇总（逐项单点，均不含 T1-B）

| 项 | 内容 | 阶段 |
|---|---|---|
| (a) | 修改 T0 四件套实施 T0-v2（兼容方案 §9 点位） | P1-A |
| (b1) | 建库+五账号授权、schema 一行、.env、migrate init、generate | P2-A 结构段 |
| (b2) | 数据搬迁（源只读）+ P2-B 临时库建/写/删与转授回收 | P2-A 搬迁段 / P2-B |
| (c) | SQLite 脚本退役/改造 + CI 改造 | P3 |

**用户配合项（P2-A 前）**：①以 root 建五账号并授权（SQL 见决策报告 §5），连接串写入 server/.env（不进聊天）；②确认库名 wechat_pipeline；③确认 dev.db 数据搬迁（建议搬，159 行含 42 条文风配置）；④确认 shadowDatabaseUrl 一行改动（(b1) 内）。
**延期项（不阻塞切换）**：W1/W2 OS 级网络隔离（后续安全增强，另行排期）。
