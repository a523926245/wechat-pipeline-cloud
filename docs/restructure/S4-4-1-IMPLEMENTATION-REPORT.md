# S4-4-1 文章状态与选题回收机制修复 · 实施报告

- **日期**：2026-11-16
- **授权**：S4-4-1 实施指令（R1 / R3 / R4 / R5 最小范围）。**未**改 Prisma Schema、**未**新增 Migration、**未**部署/写入真实业务库、**未**调用真实 LLM/微信/发布、**未** commit。
- **依据**：`S4-4-0-STATE-LIFECYCLE-AUDIT.md`（问题事实）、`00-FINAL-EXECUTION-CHARTER.md`、`RESTRUCTURE-2.0-CONVERGED-PLAN.md`、`docs/DEVLOG.md`。
- **状态**：代码 + 隔离验证完成，**停等人工验收**。

---

## 1. 实际修改文件清单

| 文件 | 改动量 | 内容 |
|---|---|---|
| `server/src/services/article-delete.ts` | +52/−27 → 全文重写注释与判据 | R1：新增 `hasPushTrace()` 判据；R3：先删文章再判引用、只归还 `used=true` 的选题 |
| `server/src/services/accounts.ts` | +38/−25 | R1/R3：删账号路径同款语义（先删文章 → 逐题查剩余引用 → 仅 `used=true` 归还） |
| `server/src/services/angle-claim.ts` | 新增 74 行 | R4：`claimAngleInTx()`（事务内条件占用）+ `ANGLE_RELEASE_DATA`（归还字段单一真源） |
| `server/src/api/routes/articles.ts` | +112/−13 | R4：`POST /articles` 带 angleId 时事务内占题（预检 used + 409）；漫画建稿路由加 used 预检并传 `claimAngle:true` |
| `server/src/services/comic/write.ts` | +66/−29 | R4：`createComicDraft` 把「占题 + Article + ComicPanel + TaskRun」收进一个事务（LLM 调用留在事务外）+ `ComicDraftFlags.claimAngle` |
| `server/src/services/planner.ts` | +190/−33 | R5：`releaseReservedAngles()` 三重闸门；两个分支逐条 try/catch；批次 finally 兜底；TaskRun 如实记 failed + errorMessage |
| `server/scripts/smoke-bulk-delete.ts` | +364/−20 | **接入隔离运行器**（原来直连业务库）+ 新增 9-12 节 33 项断言 + 旧夹具适配 |
| `server/scripts/smoke-angles.ts` | +13/−4 | 26/27 组改用未被占用的新选题（x2/x3 已被排产消费占用）+ 新增 1 项 R4 断言 |
| `server/scripts/smoke-run.ts` | +4/−4 | 目标白名单加 `bulk` |
| `server/scripts/smoke-isolated.ts` | +5/−5 | 用法串与注释声明 `bulk` 走隔离 |
| `server/package.json` | 1 行 | `smoke:bulk` 改为 `smoke-isolated.ts run bulk` |
| `docs/DEVLOG.md` | 追加条目 | 本阶段记录 |

**未触碰**：`server/prisma/`（Schema/Migration 零改动）、`.env`、`publisher.ts`、`lint*`、`dedup.ts`、`topic-review.ts`、`web/`（前端本轮零改动）、S4-1-HF1/R1/R2 与 S4-2/S4-3 的既有未提交改动（全部原样保留）。

---

## 2. R1：推送事实与当前状态解耦

### 2.1 判据

```ts
// services/article-delete.ts
export function hasPushTrace(a: { mediaId: string | null; pushDate: string | null }): boolean {
  const media = typeof a.mediaId === 'string' ? a.mediaId.trim() : '';
  const date  = typeof a.pushDate === 'string' ? a.pushDate.trim() : '';
  return media !== '' || date !== '';
}
```

- Schema 实况：`mediaId String @default("") @db.VarChar(128)`、`pushDate String @db.VarChar(10)`，**两列都 NOT NULL**，不存在 `null`；函数仍按 null 安全处理（将来改可空列不会静默误判），并把空串/纯空白一律视为「没有」。
- 两处调用点：`article-delete.ts`（单篇+批量共用）、`accounts.ts`（删账号）。**不再读 `status`**（`article-delete.ts` 的 select 里已移除 status，避免后人又拿它当判据）。
- 与 `status` 的关系变清晰：`pushed` / `updated` / `draft` / `failed` 只表达「当前处于什么阶段」，**「是否曾送达微信」由推送痕迹表达**。

### 2.2 覆盖的六条路径

| 路径 | 产生方式 | 判据结果 |
|---|---|---|
| pushed → 直接删除 | status=pushed + mediaId | 不归还 |
| pushed → draft → 删除 | **真实 PUT /content**（测试 9.2 走真接口） | 不归还 |
| pushed → updated → 删除 | revise/emphasis 写 updated | 不归还 |
| pushed → failed → 删除 | 重推失败写 failed | 不归还 |
| pushed → 改封面 → 删除 | cover.ts 写 draft + mediaId 保留 | 不归还 |
| pushed → 强调补全 → 删除 | emphasis 写 updated | 不归还 |

补充两条边界：`mediaId` 非空但 `pushDate` 为空、`pushDate` 非空但 `mediaId` 为空，**任一成立即视为曾推送**（9.5 / 9.6 有断言）。

### 2.3 明确的「不声称」

R1 **没有**解决「pushed 文章重复点推送会在微信端新建第二份草稿」。`publisher.ts` 仍是无状态前置校验 + `addDraft` 新建 + `mediaId` 覆盖。该问题在 §9-1 单独登记，等独立决策。

---

## 3. R3：归还前检查文章引用

### 3.1 单篇删除（`deleteArticleById`，单事务）

```
BEGIN
  1 读文章（id/title/angleId/accountId/account 归属/mediaId/pushDate）
  2 assertArticleAccess（越权 404）
  3 DELETE Article            ← 先删，后面 count 才是「其他文章」
  4 if (!everPushed && angleId != null):
      count(Article where angleId) == 0 ?
        updateMany(Angle where id=angleId AND used=true) → 归还，recycledAngle = count>0
COMMIT
```

- 与旧实现的差别：旧代码**先归还再删文章**，且不看其他引用、不看 `used`。
- 只归还 `used=true` 的选题：避免「归还一个从未被占用的题」制造假信号（`recycledAngle` 因此可信）。
- 保留原有 `updateMany`（不用 `update`）的容错意图：选题被并发删除时不会抛 P2025。

### 3.2 删账号（`deleteAccount`，单事务）

```
BEGIN
  1 读账号（含归属兜底）
  2 读该账号全部文章（id/angleId/mediaId/pushDate）
  3 DELETE 这些文章（deleteMany）         ← 先删
  4 候选 = 未送达 且 挂过选题 的 angleId 去重
  5 对每个候选：count(Article where angleId) == 0 → 进 freeIds
  6 updateMany(Angle where id in freeIds AND used=true) → 归还
  7 TaskRun.accountId 置空 → 删账号
COMMIT
```

- 关键点（指令点名要求）：**不允许在删除目标文章之前，用尚未删除的同批文章干扰引用判断** → 已改为「先删后查」。
- 跨账号引用的情形：账号 A 的文章被删后，若账号 B 仍有一篇引用同一选题，`count>0` → 不归还（测试 10.4）。

---

## 4. R4：手动建稿占用选题

### 4.1 文章入口（`POST /api/articles`）

```ts
// 事务外：账号归属校验（顺带取 name/ownerUserId）；角度预检
if (angle.used) throw ConflictError(409)      // 清晰文案，先挡住常见情况
assertAngleApproved(angle)                     // S4-1 门禁，顺序与原来一致
// 事务内：条件占用 + 建稿
await prisma.$transaction(async (tx) => {
  await claimAngleInTx(tx, angleId, owner);    // updateMany where { id, used: false }
  return tx.article.create({ ... });
});
```

- 条件更新 → 并发下只有一个请求 `count=1`，另一个 409。
- `claimAngleInTx` 在 `count=0` 时会再查一次：**选题不存在 → 静默返回**（保持「不存在的 angleId 由外键按原行为失败」的既有语义，不新增 404）；存在 → 409「已被占用」。
- 不带 `angleId` 的建稿：完全不碰选题表（测试 11.3）。

### 4.2 漫画入口（`POST /api/articles/comic/create` → `createComicDraft`）

- 新增 `ComicDraftFlags.claimAngle`（默认 `false`）：
  - 路由传 `true`（手动建稿 = 消耗选题）；
  - `planner` **不传**（排产已在 `reserveAnglesForPipeline` 占用，重复占会 409）。
- 事务边界调整：`generateComicScript`（一次外部 LLM 调用）**移出事务**；「占题 + Article + ComicPanel + TaskRun」进同一事务。任一步失败全部回滚。
- 路由层保留 `assertAngleApproved`（S4-1 门禁），并新增 `used` 预检 → 409（在 LLM 之前短路，不浪费一次模型调用）。

### 4.3 边界（明确不做）

- 无 `angleId` 的建稿不受影响，**不**去"猜"该用哪道题。
- 不把占题扩展到排产（那边有自己的 reserved 事务）。
- 不改 `Angle.status`：占用只动 `used` 与归属字段，审核态仍由 S4-1 的状态机管。

---

## 5. R5：planner 预留失败补偿

> **本节已按 S4-4-1-R5-HF1 的最终实现更新**（2026-11-16）。HF1 之前的历史实现（失败分支「先 `pending.delete` 再归还」+ `releaseReservedAngles` 只返回 `number`）与修复过程见 **§14**；§14 还记录了该实现的缺陷证据与故障注入测试结果。**当前代码以本节为准。**

### 5.1 结构（最终实现）

```ts
const pending = new Set<number>(reserved.map(a => a.id));   // 本次实际预留（只含 reserved）
try {
  for (const angle of reserved) {
    try {
      ... 建稿成功 → pending.delete(angle.id)
    } catch (e) {
      // ⚠️ HF1：先补偿、再决定是否出队
      const rel = await releaseReservedAngles([angle.id], acc.id, '…-failed', pipeline);
      if (rel.retryable.length === 0) pending.delete(angle.id);   // 只有确定不需要/不能补偿才出队
      logger.error({ accountId, angleId, err, released: rel.released, retryable: rel.retryable, releaseErr: rel.error }, ...);
      created.push({ id: 0, note: `…失败：${msg}` + (rel.released > 0 ? '（已归还该选题）'
                    : rel.retryable.length > 0 ? '（该选题归还失败，将在本批次结束时再试一次）' : '') });
    }
  }
  await prisma.taskRun.create({ status: failures.length ? 'failed' : 'success', errorCode, errorMessage });
  return ...;
} finally {
  if (pending.size > 0) {
    const left = [...pending]; pending.clear();          // 快照后清空（只再试一次，不循环）
    try {
      const rel = await releaseReservedAngles(left, acc.id, 'batch-aborted', pipeline);
      if (rel.released > 0) logger.warn(...);
      if (rel.retryable.length > 0) {                    // 兜底也失败 → 不假装成功
        logger.error({ accountId, angleIds: rel.retryable, reason: 'batch-aborted', err: rel.error }, '兜底补偿失败：…需人工归还');
        created.push({ id: 0, note: `兜底补偿失败：…（angleId …）：原因；请到选题库手动归还` });
      }
    } catch (e) {
      logger.error({ accountId, angleIds: left, reason: 'batch-aborted', err }, '兜底补偿过程抛出异常（原始业务异常仍会继续上抛）');
    }
  }
}
```

### 5.2 三重闸门（`releaseReservedAngles`）

| 闸门 | 作用 |
|---|---|
| `id ∈ 调用方传入的本次预留集合` | 不碰别的任务 |
| `usedByAccountId === 该账号` | 即使 id 传错/被复用，也不放掉别人或人工的占用 |
| `articles: { none: {} }` | 已有文章引用的绝不释放（含本次刚建好的） |

- 另显式要求 `used: true`：已是未用状态的题不重复处理。
- 返回值是结构化结果（HF1 起）：`{ released, retryable, skipped, error? }` —— 成功归还 / 全部受保护 / 数据库异常 三种结局可区分；异常时事务回滚、全部入参进 `retryable`（交给 finally 再试一次），受保护与非本账号占用进 `skipped`（不重试）。调整前只有 `number`，三种结局都可能是 0，调用方无法判断。
- 补偿本身不抛（内部 catch 后返回结构），所以不会把已成功的建稿连坐成异常；归还条数与跳过原因都写日志，避免「静默归还/静默没归还」。

### 5.3 失败信息不吞

- 每个失败选题进 `created[]`（`id: 0` + 失败原因 + 归还三态：`已归还` / `将在本批次结束时再试一次` / 无后缀表示受保护或本来未占用），前端/CLI 可见。
- `TaskRun.status` 由「恒 success」改为「有失败项即 failed」，并写 `errorCode` / `errorMessage`（VarChar(1000)，截断 900）。
- 单个选题失败不再中断同批其余选题（旧的文章分支无 try/catch，一次异常会中断整批）。

---

## 6. 关键事务边界汇总

| 操作 | 事务范围 | 备注 |
|---|---|---|
| 删单篇文章 + 归还 | 读 → 删 → 查引用 → 归还，**一个事务** | 任一失败整笔回滚，不出现「文章删了题没还/题还了文章还在」 |
| 删账号 + 级联删文 + 归还 | 一个事务 | 顺序：删文章 → 查引用 → 归还 → TaskRun 置空 → 删账号 |
| 手动文章建稿 + 占题 | 一个事务 | `claimAngleInTx` 与 `article.create` 同事务 |
| 手动漫画建稿 + 占题+格行+流水 | 一个事务 | LLM 调用在事务外 |
| 排产预留 | 独立事务（既有 `reserveAnglesForPipeline`） | 无法与后续建稿合并（LLM 调用几十秒，事务里持锁不可接受）→ 用 R5 补偿兜底 |
| 排产补偿归还 | 一个事务（select + updateMany） | 失败不抛 |
| 推送（既有） | 微信外部调用 + 单条 update，**无事务** | 本轮未改（外部调用不可回滚） |

---

## 7. 新增测试清单与结果

`npm run smoke:bulk` → **65 项断言全部通过**（隔离库 `wechat_pipeline_smoke`；R5-HF1 又追加 8 项，最终 **73 项**，见 §14.4）。

### 7.1 推送事实保护（R1）

| 用例 | 断言 | 结果 |
|---|---|---|
| 9.1 | 直接删 pushed（mediaId+pushDate）→ 不归还 | PASS |
| 9.2 | **真实 PUT /content** 把 pushed 降为 draft（先断言状态确实变了）→ 删除 → 不归还 | PASS |
| 9.3 | updated → 删除 → 不归还 | PASS |
| 9.4 | failed → 删除 → 不归还 | PASS |
| 9.5 | mediaId 非空、status=draft、pushDate 空 → 不归还 | PASS |
| 9.6 | pushDate 非空、mediaId 空 → 不归还 | PASS |
| 9.7 | 对照：无任何推送痕迹的草稿 → 照常归还 | PASS |

> 「真实状态转换」的落实：9.2 走真实 HTTP 接口产生 `pushed→draft`，不是直接改字段。updated/failed 两条路径在禁止外呼（rewrite 需 LLM、重推需微信）的前提下无法真实产生，故以「状态被覆盖后的真实数据形态」构造——这正是判据要防的输入。

### 7.2 多文章引用保护（R3）

| 用例 | 断言 | 结果 |
|---|---|---|
| 10.1 | 两篇草稿引用同一选题，删第一篇 → 不归还 | PASS |
| 10.2 | 删掉最后一篇 → 归还且 `recycledAngle=true` | PASS |
| 10.3 | 已推送那篇仍引用 → 删掉未推送那篇 → 不归还 | PASS |
| 10.4 | 删账号：另一账号仍引用 → 不归还 | PASS |
| 10.5 | 删账号：只被该账号引用 → 归还 | PASS |

### 7.3 手动建稿占用（R4）

| 用例 | 断言 | 结果 |
|---|---|---|
| 11.1 | 带 angleId → 201 + `used=true` + 归属（usedByAccountId/usedById）正确 | PASS |
| 11.2 | 重复使用已占用选题 → **409** | PASS |
| 11.3 | 不带 angleId → 201 且 `angleId=null`（不占题） | PASS |
| 11.4 | 未审核选题仍被拒（**S4-1 门禁未被绕过**）且不占用 | PASS |
| 11.5 | 建稿失败（不存在的 trackId → 外键失败）→ 占用回滚 | PASS |
| 11.6 | 漫画入口：已占用选题在门禁处 409（不触发模型调用） | PASS |
| 11.7 | 漫画建稿失败（无 comic_script 绑定）→ 不留占用 | PASS |
| angles 26 | 挂稿 approved → 201 **且选题被占用** | PASS |

### 7.4 排产补偿（R5）

| 用例 | 断言 | 结果 |
|---|---|---|
| 12.1 | 已有文章引用 → 不释放 | PASS |
| 12.2 | 无引用且本次预留 → 释放 1 个 | PASS |
| 12.3 | 归属其他账号 → 不误放 | PASS |
| 12.4 | 批次剩余 3 个（2 个无文章 + 1 个已产文章）→ 只释放 2 个 | PASS |
| 12.5 | **漫画脚本失败的真实端到端**（reserve → 失败 → 归还）：结果里如实记录失败项 + 选题已归还 | PASS |

### 7.5 旧夹具适配（断言语义未变，仅数据形态/取值修正）

| 处 | 原样 | 现在 | 为什么 |
|---|---|---|---|
| bulk art1/art3/art4 | `pushDate: '2026-11-11'` + `status: 'draft'` | `pushDate: ''` | 旧夹具给「未推送草稿」填了推送日期。R1 之后 pushDate 是判据，这批数据会被判成「曾推送」→ 归还断言必然失败。真实建稿写的就是 `''`，改成 `''` 才符合真实形态 |
| bulk art2（已推送） | 只有 `pushDate` | 补 `mediaId` | 让「已推送」两个判据都在，更接近真实推送后的数据 |
| bulk 第 8 节 | `protocol:'openai'`、`role:'smoke_bulk_role_xxx'` | `protocol:'openai_chat'`、`role:'write' / 'revise'` | 原值不是合法枚举（`ModelProtocol` 无 `openai`、`ModelBinding.role` 是 `ModelRole`），该节在 MySQL enum 下从未真正跑通过；隔离空库下用两个真实角色各绑一个模型 |
| bulk 第 8 节「用户原有绑定未受影响」 | 断言「库里存在非冒烟绑定」 | 断言「另一条自建绑定仍在」 | 隔离库是空库，不可能有用户绑定；改为自建对照绑定，语义等价（删 A 不影响 B） |
| angles 26/27 组 | 用 `x2` / `x3` 挂稿 | 新建 `x26` / `x27` | x2/x3 已在排产消费测试里被 reserve 占用（used=true），按 R4 新语义再挂稿必然 409。新建未被占用的 approved 选题，保持「approved 可挂稿/过门禁」的原意 |

---

## 8. 全部回归测试结果

| 命令 | 实际输出 |
|---|---|
| `npm run typecheck`（server） | **0 errors** |
| `npx vue-tsc --noEmit`（web，连跑两遍） | **0 errors** ×2 |
| `npm run build`（web） | **✓ built in 7.26s** |
| `npm run smoke:lint` | **通过 138 项**（与 S4-3 后一致，未降） |
| `npm run smoke:style` | **全部通过（41 项断言）** |
| `npm run smoke:angles` | **ALL PASS（176 项）**（S4-3 后 175 + 新增 1 项 R4 断言） |
| `npm run smoke:bulk` | **全部通过：73 项断言**（原脚本 33 处 expect → S4-4-1 新增 33 → R5-HF1 再新增 8；S4-4-1 首次交付时为 65 项） |
| `npm run verify:smoke-iso` | **10/10 项通过**（每轮 `REAL-DB FINGERPRINT MATCH`） |

`verify:smoke-iso` 第 ⑨ 项 `ISO-EMPTY tables=17/17 rows=0`（含 S4-3 的 `ArticleLintRun`）。

---

## 9. 真实业务库零写入证明

```
身份核验（只读）：DATABASE()=wechat_pipeline   CURRENT_USER()=wpc_app@127.0.0.1
改造前基线（S4-4-0 报告记录，16 表 COUNT+CHECKSUM 拼接）：
  SHA256 = 723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3
本轮收尾同口径重算：
  SHA256 = 723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3   ← 逐字节相同
ArticleLintRun in business DB: ABSENT（S4-3 迁移仍未部署，符合边界）
```

- 本轮执行过的数据库操作：业务库 **仅 SELECT**（身份核验 + 上述指纹）；其余全部写操作发生在 `wechat_pipeline_smoke`（每轮 run 前重建、run 后清空）。
- 未执行：`db push` / `migrate dev` / `migrate deploy` / `migrate reset` / `migrate resolve`（本轮零 Schema 变更，也不需要）。
- `dev.db` 归档未打开（SHA-256 `fea0f123…` 全程未变）。
- 每轮隔离运行的末尾都有 `[t0] REAL-DB FINGERPRINT MATCH（真实库零写入）`。

---

## 10. 隔离 Smoke 数据库验证

- `smoke:bulk` 原本是**直跑**脚本：它静态 import `src/db.ts`，`DATABASE_URL` 来自 `server/.env` → **指向业务库 `wechat_pipeline`**。也就是说在改造前，`npm run smoke:bulk` 会真的往业务库写测试数据（历史事故教训见 `verify-bulk-delete.ts` 的注释）。
- 本轮把它接入隔离运行器（指令 §五「所有测试必须使用隔离 Smoke 数据库」的硬要求）：
  - `smoke-run.ts` 目标白名单加 `bulk`；
  - `smoke-bulk-delete.ts` 补 `__SMOKE_NET__` 端口登记胶水（否则隔离环境的网守会拦掉自己的 fetch）；
  - `package.json` 的 `smoke:bulk` 改为 `smoke-isolated.ts run bulk`（**命令名不变**）。
- 效果（实测输出）：`DATABASE() = wechat_pipeline_smoke`、`ISO-EMPTY tables=17/17 rows=0`、run 后 `CLEANUP ok`、`REAL-DB FINGERPRINT MATCH`。
- `verify:bulk`（`scripts/verify-bulk-delete.ts`）仍是旧的 dev.db 副本方案，在 S2 退役 SQLite 后已不可用；本轮**未修**（超出范围），也未运行。

---

## 11. 未解决问题

1. **pushed 文章重复推送会新建第二份草稿**（S4-4-0 P2-3 残留）：`publisher.ts` 仍是 `addDraft` 新建 + 覆盖 `mediaId`，旧的微信草稿变成无法追踪的孤儿。
   - R1 **不解决**此问题（它只保证「曾推送」的事实不再丢失）。
   - 修法需在 `updateDraft` 复用（可能覆盖公众号后台的人工编辑，`publisher.ts:13-16` 的 TODO 有说明）与「推前提示将新建第二份」之间做业务决策 → 待独立授权。
2. **漫画建稿成功占题未做端到端验证**：
   - 隔离运行器剥离了 `APP_SECRET_KEY`，而 `chatComplete` 通过 `requireApiKey` 强制要求模型有可解密 key → 无法在隔离库内起 mock 模型服务；本轮又不允许真实 LLM 调用。
   - 现有覆盖：① 占题用的是与文章入口**同一个** `claimAngleInTx`（文章入口已端到端验证 11.1/11.2/11.5）；② 漫画失败路径已验证「不误占」（11.7）；③ 漫画路由的 `used` 预检已验证（11.6）。
   - 建议验收时在本地环境用真实模型点一次漫画建稿，确认 `Angle.used` 变 true。
3. **排产「批次中途异常退出」未做端到端构造**：`finally` 分支由 12.4（函数级，多个残留 id）覆盖；真实构造需要让 `renderArticle`/`article.create` 在中途抛错，改动生产代码或注入故障点，超出最小必要范围，故未做。
   - **HF1 后的更新**：失败分支「补偿失败 → finally 兜底」已用故障注入做成端到端（§14.4 的 12.8/12.9，走真实 `runPipelineForAccount` 链路）；仍**未**构造的是「for 循环中途抛出未捕获异常、且后续选题还没处理」这一条（`finally` 处理剩余 `pending` 的路径，目前只有函数级 12.4 覆盖）。
4. **并发覆盖（S4-4-0 P2-5）未处理**：`PUT /content` 与推送的 read-modify-write 仍无 CAS。按指令「不为理论极端并发引入复杂锁」，本轮不动。
5. **仪表盘 `updated` 分桶缺失（P2-1）** 等轻量修复未做（指令明确不顺手做 P2）。
6. **`GET /:id/lint` 之外的既有小问题**（S4-3 遗留）与本轮无关，未动。

---

## 12. Git 工作区变化与未提交文件保护

本轮**新增**（相对 S4-4-0 收尾状态）：

```
 M server/package.json                 ← smoke:bulk 走隔离
 M server/scripts/smoke-angles.ts      ← 26/27 组夹具 + 1 项 R4 断言
 M server/scripts/smoke-bulk-delete.ts ← 隔离化 + 33 项新断言
 M server/scripts/smoke-isolated.ts    ← 用法串
 M server/scripts/smoke-run.ts         ← target 白名单
 M server/src/api/routes/articles.ts   ← R4
 M server/src/services/accounts.ts     ← R1/R3
 M server/src/services/article-delete.ts ← R1/R3
 M server/src/services/comic/write.ts  ← R4
 M server/src/services/planner.ts      ← R5
?? server/src/services/angle-claim.ts  ← 新增（R4 占题 + 归还字段真源）
?? docs/restructure/S4-4-1-IMPLEMENTATION-REPORT.md ← 本报告
```

**存量未提交改动保持原样**（未被本轮覆盖/回退/清理）：

```
 M docs/DEVLOG.md                      ← S4-2/S4-3 + 本轮追加
 M server/prisma/schema.prisma         ← S4-3
 M server/scripts/smoke-lint.ts        ← S4-3
 M server/src/api/routes/angles.ts     ← S4-1-HF1/R1/S4-2
 M server/src/services/angles.ts       ← S4-1-HF1/R1/R2/S4-2
 M server/src/services/dedup.ts        ← S4-2
 M server/src/services/publisher.ts    ← S4-3
 M server/src/services/topic-review.ts ← S4-1/R2/S4-2
 M web/src/api/index.ts                ← S4-2 + S4-3
 M web/src/types.ts                    ← S4-2 + S4-3
 M web/src/views/ArticleEditView.vue   ← S4-3
 M web/src/views/TrackAnglesView.vue   ← S4-2
?? server/src/services/lint-store.ts + migrations/20261116120000_add_article_lint_run/ ← S4-3
?? docs/restructure/S4-1-*、S4-2-*、S4-3-* 共 8 份报告
```

`git diff --stat`（含历轮累计）：16 文件 +2627/−274。本阶段净改动：新建 1 文件（angle-claim.ts）+ 修改 11 文件。

---

## 13. 一句话结论

「是否送达过微信」不再取决于会被覆盖的 `status`，而取决于不会消失的推送痕迹；归还选题前必须确认没有其他文章引用；手动建稿当场消耗选题、失败回滚；排产失败有补偿且如实记账。**零 Schema 变更、业务库零写入；本轮新增 34 项断言（bulk 33 + angles 1）全绿。**（R5-HF1 验收后另加 8 项补偿故障用例，合计 42 项，见 §14.4）

---

## 14. S4-4-1-R5-HF1 补充修复：pending 生命周期与 finally 兜底

- **日期**：2026-11-16（S4-4-1 验收后追加）
- **触发**：S4-4-1 报告中 R5 的潜在缺陷——失败分支可能「先把选题移出 pending、再归还」，归还失败（只记日志返回 0）后 finally 不再处理，导致本次预留的选题遗留 `used=true`。

### 14.1 只读核查结论（对着实际代码，逐项）

| # | 检查项 | 修复前实际代码 | 结论 |
|---|---|---|---|
| 1 | `pending` 初始化范围 | `planner.ts:373` `new Set(reserved.map(a => a.id))` | ✅ 只含本次实际预留 |
| 2 | 成功建稿时移除时机 | `:383`（漫画）/ `:448`（文章），`article.create` 之后 | ✅ 正确 |
| 3 | **失败分支执行顺序** | `:389` / `:459` **先** `pending.delete()` → `:390` / `:460` 才 `releaseReservedAngles()` | ❌ **缺陷确认** |
| 4 | 返回值能否区分四种结局 | `Promise<number>`：成功归还 N 条 / 受文章引用保护 / 非本账号占用 / DB 异常 —— **四种都可能是 0** | ❌ 无法区分 |
| 5 | finally 覆盖范围 | `:496` `if (pending.size > 0)`；已提前 `delete` 的选题不在集合内 | ❌ 对该选题兜底失效 |
| 6 | finally 是否掩盖原始异常 | `releaseReservedAngles` 内部 catch 后返回 0，不抛 | ⚠️ 不掩盖，但**补偿失败时无任何记录**（旧 `if (released > 0)` 才打日志） |
| 7 | TaskRun 失败记录是否会被补偿异常冲掉 | `:405` / `:476` 在 try 内、finally 之前写入 | ✅ 不会丢 |

**实际后果链（旧实现）**：建稿失败 → `pending.delete` → release 撞 DB 异常 → 返回 0（仅一条 error 日志）→ `if (released > 0)` 不成立，失败提示也不写进 note → finally 里集合已空 → 该选题永久 `used=true`，且调用方看到的 note 是「建稿失败」而不知道「题也没还上」。

### 14.2 修复内容

**（1）返回值改为结构化（`ReservedReleaseResult`）**

```ts
export interface ReservedReleaseResult {
  released: number;    // 实际归还条数
  retryable: number[]; // 仍可能需要补偿（只在数据库异常时非空）
  skipped: number[];   // 经闸门确认不需要/不能释放（已有文章引用、非本账号占用、本来未占用）→ 不重试
  error?: string;      // 数据库异常信息
}
```

| 结局 | released | retryable | skipped |
|---|---|---|---|
| 成功归还 | >0 | `[]` | 受保护的那些 |
| 全部受保护 | 0 | `[]` | 全部入参 |
| 数据库异常（事务回滚，无法判断谁受保护） | 0 | **全部入参**（保守，交给 finally 再试一次） | `[]` |

**（2）pending 生命周期：先补偿、后出队**

```ts
// 漫画分支 / 文章分支（两处同构）
const rel = await releaseReservedAngles([angle.id], acc.id, '…-failed', pipeline);
if (rel.retryable.length === 0) pending.delete(angle.id);   // 只有「确定不需要/不能补偿」才出队
```

note 文案也据此分三态：`（已归还该选题）` / `（该选题归还失败，将在本批次结束时再试一次）` / 无后缀（受保护或本来就没占用）。

**（3）finally 兜底：失败必须可追踪，且不掩盖原始异常**

```ts
if (pending.size > 0) {
  const left = [...pending]; pending.clear();
  try {
    const rel = await releaseReservedAngles(left, acc.id, 'batch-aborted', pipeline);
    if (rel.released > 0) logger.warn(...);
    if (rel.retryable.length > 0) {
      logger.error({ accountId, angleIds: rel.retryable, reason: 'batch-aborted', err: rel.error }, '兜底补偿失败：…需人工归还');
      created.push({ id: 0, note: `兜底补偿失败：N 个选题未能归还（angleId …）：… 请到选题库手动归还` });
    }
  } catch (e) {
    // 吞掉的只是补偿异常；try 里的原始业务异常会在 finally 结束后照常上抛
    logger.error({ … }, '兜底补偿过程抛出异常（原始业务异常仍会继续上抛）');
  }
}
```

- 只再试**一次**（不循环重试），符合「兜底 ≠ 无限重试」。
- 单个 id 失败不阻断其余：`releaseReservedAngles` 内部是一次事务，全成功或全回滚；失败时所有入参进入 `retryable` 并逐条记录在日志里（含 accountId / angleIds / reason / error）。
- 兜底失败会把一条 `id:0` 的「（补偿未完成）」记录追加进本批 `created[]`，前端与 CLI 都能看到。

### 14.3 修复前后 pending 生命周期对比

| 阶段 | 修复前 | 修复后 |
|---|---|---|
| 初始化 | reserved 全量 | 同 |
| 建稿成功 | 移除 | 移除（不变） |
| 建稿失败 | **先移除 → 再补偿** | **先补偿 → 补偿确认无需重试才移除** |
| 补偿遇 DB 异常 | 已移除，再无机会 | 保留在 pending（retryable） |
| finally | 只处理没进过失败分支的 | 处理「中途异常剩余的」+「失败分支补偿没成功的」 |
| finally 补偿失败 | 只有 `released>0` 才打日志 → 静默 | `logger.error`（账号/选题/原因/异常）+ 写进 `created[]` + TaskRun 已是 failed |
| 已有文章引用 | 不释放（闸门） | 不释放且归入 `skipped`，**不重试** |
| 其他账号/其他任务占用 | 不释放（闸门） | 同（`skipped`） |

### 14.4 新增测试（`smoke:bulk` 第 12.6-12.9 节，8 项断言）

故障注入方式：在测试进程内注册 Prisma 中间件，只让**归还用的** `Angle.updateMany({ data: { used: false } })` 抛错（`reserve` 的 `used: true` 不受影响）；生产代码里没有任何测试钩子，run 结束进程退出即消失。

| 用例 | 验证点 | 实际输出 |
|---|---|---|
| 12.6 | 首次归还 DB 失败：`released=0` + `retryable` 含该 id + 有 `error`（不伪装成功） | PASS |
| 12.6 | 失败后选题仍 `used=true` | PASS |
| 12.7 | 再次补偿成功（等价于 finally 的兜底动作） | PASS |
| 12.8 | **planner 端到端**：漫画建稿失败 + 首轮补偿注入故障 → 结果标注「将在本批次结束时再试一次」 | PASS |
| 12.8 | **finally 兜底生效**：该选题最终 `used=false` | PASS |
| 12.9 | **planner 端到端**：两轮补偿都失败 → 兜底失败被写入批次结果（含 angleId 与原因） | PASS |
| 12.9 | 两轮都失败时选题仍 `used=true`（如实反映，不伪装成功） | PASS |
| 12.9 | 故障计数器已耗尽（不污染后续用例） | PASS |

> 12.8 的第二条断言是本次修复的判别式：修复前该选题会停在 `used=true`（因为已被移出 pending），断言必然失败。
> 同时修正了 12.5 的一个**假通过**：原断言写死 `g127`，而 `reserve` 按 seq 升序实际会取到别的未用选题（12.5 里 `g127` 从头到尾没被占用，`used===false` 天然成立）。现改为按 `created[0].angleId`（实际被预留的那条）断言。

### 14.5 回归结果（真实输出）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm run smoke:bulk` | **全部通过：73 项断言**（S4-4-1 的 65 + HF1 新增 8） |
| `npm run verify:smoke-iso` | **10/10 项通过**（含 `ISO-EMPTY tables=17/17 rows=0`） |
| `npm run smoke:angles` | ALL PASS（176 项） |
| `npm run smoke:lint` | 通过 138 项 |
| `npm run smoke:style` | 全部通过（41 项断言） |

每轮 `[t0] CLEANUP ok` + `[t0] REAL-DB FINGERPRINT MATCH（真实库零写入）`。

### 14.6 零写入证明

```
身份：DATABASE()=wechat_pipeline  CURRENT_USER()=wpc_app@127.0.0.1
16 表口径 SHA256 = 723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3
（与本轮开工前、与 S4-4-0 基线逐字节相同）
ArticleLintRun: ABSENT（S4-3 迁移仍未部署）
```
本轮数据库操作：业务库仅 SELECT；所有写操作在 `wechat_pipeline_smoke`。未执行任何 Migration / Schema 操作。

### 14.7 本轮修改文件

| 文件 | 改动 |
|---|---|
| `server/src/services/planner.ts` | `ReservedReleaseResult` + `releaseReservedAngles` 结构化返回；两处失败分支改为「先补偿后出队」；finally 增加失败记录与 try/catch；`created[]` 追加兜底失败项；四处日志补 accountId/pipeline/reason/retryable |
| `server/scripts/smoke-bulk-delete.ts` | 适配新返回结构（12.1-12.4）+ 新增 12.6-12.9（8 项）+ 修正 12.5 假通过 + Prisma 中间件故障注入 |
| `docs/restructure/S4-4-1-IMPLEMENTATION-REPORT.md` | 本节 |
| `docs/DEVLOG.md` | 追加 HF1 条目 |

### 14.8 仍未解决（如实登记）

1. **两轮补偿都失败时，选题仍会停在 `used=true`** —— 这是设计上的「兜底只再试一次」，不是本次修的不彻底：修的是「不该丢补偿对象」，不是「保证一定归还成功」。此时有 error 级日志 + 批次结果里的显式记录 + TaskRun failed，人工到选题库归还即可（`releaseAngle` 要求无文章引用，这里天然满足）。
2. **未做「补偿失败自动重试 N 次/退避」**：指令明确不要无限重试，也未要求重试队列。
3. 本条修复不含任何并发/锁改动；`releaseReservedAngles` 仍是「事务内 select + updateMany」，并发下最坏是同一条被两次判定为可归还（第二次 updateMany 命中 0 行，无副作用）。

### 14.9 最终验收只读核对（2026-11-16，未改任何业务代码）

对着**当前实际代码**逐项核对 §14 的声明，结论全部成立：

| 核对项 | 代码位置 | 实际行为 |
|---|---|---|
| 失败分支先补偿、后决定是否出队 | `planner.ts:391-392`（漫画）、`:476-477`（文章） | `releaseReservedAngles(...)` 先执行；仅 `rel.retryable.length === 0` 时 `pending.delete` |
| 数据库异常时 `retryable` 含待补偿选题 | `releaseReservedAngles` 的 `catch` 分支 | 事务已回滚、无法判断谁受保护 → `retryable = ids`（全部入参），`released=0`，`error` 为异常信息 |
| finally 只执行一次兜底 | `planner.ts:529-580` | `if (pending.size > 0)` 一次调用，无 while/重试循环；`pending.clear()` 在调用前 |
| 兜底失败有 error 日志 + 调用方可见记录 | `:543-563` | `logger.error`（account / accountId / pipeline / angleIds / reason / err）+ `created.push` 一条 `id:0`「（补偿未完成）」记录，note 内含全部 angleId 与原因 |
| 补偿异常不覆盖原始业务异常 | `:565-579` | finally 内 try/catch 只吞补偿异常；try 中若已有异常，finally 结束后继续上抛 |

**特别核对：finally 中 `pending.clear()` 之后、`releaseReservedAngles()` 意外抛出未被其内部捕获的异常时**

1. **是否有完整 error 日志** → **有**。外层 `catch (e)`（`:565`）记录 `account`、`accountId`、`pipeline`、`angleIds: left`（`clear()` 前已快照，不丢）、`reason: 'batch-aborted'`、`err`。
2. **是否丢失调用方可见的补偿失败信息** → **会丢失**。`created.push`（`:554`）在 `try` 内、位于 `releaseReservedAngles` 之后；异常直接跳到 `catch`，不会 push。因此这种情况下前端/CLI 拿到的 `created[]` **不含**「兜底补偿失败」条目，只能从 error 日志看到。若 `try` 是正常 `return`，函数仍正常返回（补偿异常被吞），返回结果同样不含该条目。
   - 触发前提：`releaseReservedAngles` 内部 `catch` 已覆盖其全部抛错（含非 `Error`），实际能逃逸的只有「`catch` 块内部再次抛出」（如 logger 自身崩溃、进程级错误）。属于理论边界，本轮**不为它扩大实现**。
3. **是否影响原始业务异常继续上抛** → **不影响**。被吞掉的只有补偿异常，原始异常在 `finally` 结束后照常向外传播。

**TaskRun 与批次返回结果核对**

| 场景 | TaskRun | 调用方可见信息 |
|---|---|---|
| 正常建稿失败 + 补偿成功 | `status='failed'`、`errorCode='write_failed'`、`errorMessage` 含「…（已归还该选题）」 | `created[]` 的 `id:0` 项：原因 + 「已归还」 |
| 正常建稿失败 + 补偿失败（留给 finally） | `status='failed'`、`errorMessage` 含「（该选题归还失败，将在本批次结束时再试一次）」 | 同上；最终归还结果由 finally 决定 |
| finally 兜底成功 | `status='failed'`（建稿失败事实仍在） | `created[]` 含原失败项；无补记（已归还，无需补记） |
| finally 兜底失败 | `status='failed'`、`errorMessage` **仅含建稿失败原因**（TaskRun 在 finally 之前写入） | `created[]` **额外**一条「兜底补偿失败：N 个选题未能归还（angleId …）：原因；请到选题库手动归还」 |

即：**兜底失败时，调用方（HTTP 响应 / CLI 输出）能看到具体 angleId 与失败原因；TaskRun 里不含这条兜底信息**（未为此新增字段或改写 TaskRun，符合「不额外增加字段/重试机制」的要求）。`created` 与 `return` 共用同一数组引用，finally 中的 `push` 在返回值上可见。

**本节核对结论：未发现需要修改代码的新问题。** 文档侧仅做了 3 处一致性修正（§5.1 伪代码、§5.2 返回语义、§8 断言计数），见下方「15」。

---

## 15. 文档一致性修正记录（本轮，仅文档）

本轮**未修改任何业务代码、测试代码、Schema、Migration**，只修正报告中会误导后续阅读的地方：

| 位置 | 修正前 | 修正后 | 原因 |
|---|---|---|---|
| §5 抬头 | 无状态说明 | 增加「本节已按 R5-HF1 最终实现更新，历史实现见 §14」 | 报告里同时存在旧/新两份描述，读者可能把 §5.1 当成当前代码 |
| §5.1 伪代码 | `pending.delete()` 在 `releaseReservedAngles()` **之前**、返回 `number` | 换成最终实现（先补偿 → `retryable.length===0` 才出队；finally 带 try/catch 与失败记录） | 同上，且旧伪代码与新实现语义相反 |
| §5.2 末条 | 「归还失败只 `logger.error` 并返回 0」 | 结构化返回 `{released, retryable, skipped, error?}` 与三种结局 | 旧描述在 HF1 后已不成立 |
| §5.3 第一条 | 「原因 + 是否已归还」 | 「原因 + 归还三态（已归还 / 待批次结束重试 / 无后缀）」 | 与实现的 note 文案对齐 |
| §7 引导句、§8 表格 | `smoke:bulk` 65 项 | 73 项（注明 65 + HF1 的 8） | HF1 已加 8 项，65 是过时数字 |
| §11-3 | 「批次中途异常未做端到端」 | 补充：失败分支→finally 已由 12.8/12.9 端到端覆盖；仍未构造的是「for 循环中途抛未捕获异常」这条 | 避免把已覆盖的当成未覆盖 |
| §13 结论脚注 | 「新增 34 项」 | 补「R5-HF1 另加 8 项，合计 42」 | 数字完整性 |
| §14.9 / §15 | 新增 | 本轮核对结论与文档修正记录 | 交付可追溯 |

**未改动**：S4-1-HF1/R1/R2、S4-2、S4-3 的任何报告与代码；`planner.ts`、`smoke-bulk-delete.ts` 的本轮版本与 HF1 交付时逐字一致（`git diff` 无新增改动）。

**本轮验证**：仅执行一次 `npm run smoke:bulk` 确认文档所述「73 项」与当前代码一致 → `全部通过：73 项断言`、`ISO-EMPTY tables=17/17 rows=0`、`CLEANUP ok`、`REAL-DB FINGERPRINT MATCH`。
