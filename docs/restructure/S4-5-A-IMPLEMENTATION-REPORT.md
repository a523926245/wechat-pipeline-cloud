# S4-5 A 档实施报告：结尾判据分赛道（ending_hook 豁免）

- **日期**：2026-11-16
- **范围**：S4-5 的 A 档（S4 阶段内部子任务，归属权威计划 S4「业务流程与内容质量优化」；权威计划的 S4/S5/S6 划分未改动）
- **决策前提**：A-1 路线——保留「DB 优先」的 relax 配置语义，用 V16 存量迁移让规则生效；B 档（选题形态）本轮不动，预选 B-1。
- **结论**：A 档代码与隔离验证完成，**未接入启动迁移链、未写真实业务库**。可进入 S2（需单独授权）。

---

## 1. 改造前的问题（代码证据）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `ending_hook` 判据只认「结尾有问号 + 有第二人称」。 | `server/src/services/lint.ts:449-472` |
| 2 | `sys:星座` 明文要求结尾是「一句可截图的话，或一句『你是第几个 / @ 那个 XX 座』」，并**禁止**抒情提问 → 判据与本赛道口径结构性冲突。 | 库内 `StylePrompt.sys:星座` 第 12 条 |
| 3 | `sys:育儿` 全文**没有**「结尾要提问」的写法要求 → 判据给这条赛道加了一项它没被要求过的任务。 | 库内 `StylePrompt.sys:育儿` |
| 4 | `relax` 机制本身早已支持按赛道豁免 warn（`relax` 只过滤 `level==='warn'`，error 永不免）。 | `lint.ts:530-531` |
| 5 | **但只改种子对存量库无效**：`loadTrackRule` 的合并语义是「DB 里有 `relax` 键就整条用 DB」，而库内 `r:星座` / `r:育儿` 早已写死 relax 数组。 | `server/src/services/style-prompts.ts:2055-2057` |

**改造前实测基线（重要，避免夸大）**：归档库 12 篇成稿（星座 8 / 育儿 4）跑 `lintArticle`，`ending_hook` 命中数 **0 次**。即本项属「按提示词口径对齐判据」的结构性修复，**不是**修一个已观测到的数据事故。因此验收口径改为「目标形态样本前后对比 + 归档样本零变化」，而不是「假警报减少 N 条」。

---

## 2. 修改文件与具体内容

| 文件 | 改动 | 目的 |
|---|---|---|
| `server/src/services/track-rules.ts` | `星座.relax` 追加 `'ending_hook'`；`育儿.relax` 追加 `'ending_hook'`（各带一行理由注释） | 新装库 / 无 `r:` 行时直接拿到豁免；这是唯一「种子侧」改动 |
| `server/src/services/style-prompts.ts` | 新增 `migrateStyleSeedsV16()`（约 73 行，含注释）；常量 `LEGACY_SEED_KEY_V16='style_seed_v16'`、`V16_RELAX_TRACKS`、`V16_RELAX_CODE` | 存量库补丁。**未**加入 `doEnsureStylePromptsSeeded` 的迁移链（见 §3） |
| `server/scripts/smoke-lint.ts` | 新增 9.1–9.9 共 12 项断言 + 引入 `loadTrackRule` / `migrateStyleSeedsV16` | 判据分赛道行为 + V16 行为/幂等/保守规则 |
| `server/scripts/smoke-style-prompts.ts` | 5.2 期望值随种子更新为 `['para_short','ending_hook']`（断言语义仍是「回落种子」） | 种子变了，期望值必须同步；**不是放宽断言** |
| `server/src/services/lint.ts` | **零改动** | 指令要求；`relax` 已具备豁免能力 |

---

## 3. V16 迁移函数的行为与触发位置

**行为**（`migrateStyleSeedsV16`）：

1. 读 `Setting.k='style_seed_v16'`，`v==='16'` 直接返回（只跑一次）。
2. 遍历 `['星座','育儿']`，读 `r:{赛道}` 行：
   - 行不存在 → 跳过（走种子，种子里已带豁免）；
   - JSON 坏 / 不是对象 → `logger.warn` 后跳过（绝不猜着改）；
   - **行内没有 `relax` 键 → 跳过**。原因：那种情况下 `loadTrackRule` 会继承种子（已含 `ending_hook`），此时写一个只含 `ending_hook` 的数组会把种子里的 `para_shape` / `para_short` 顶掉；
   - `relax` 已含 `ending_hook` → 跳过；
   - 否则 `{ ...原对象, relax: [...原relax, 'ending_hook'] }` 写回（`checks` / `angleMode` / 用户自定义项原样保留，`JSON.stringify(..., null, 2)` 与种子格式一致）。
3. `Setting` upsert 标记 `v='16'`；有改动时 `logger.info`。
4. 整体 `try/catch`，失败只 warn 不抛（照 V13/V14/V15 的写法）。

**触发位置（本轮刻意未接线）**：
`doEnsureStylePromptsSeeded` 的迁移链当前止于 `await migrateStyleSeedsV15();`（`style-prompts.ts:1231`）。V16 定义在 `style-prompts.ts:1839`，**不在链上**，函数内已写清原因：

> ⚠️ 本函数尚未接入 `doEnsureStylePromptsSeeded` 的迁移链（S4-5 S1 只做实现与隔离验证）。接线意味着服务首次启动会自动 UPDATE 真实业务库这 2 行，必须等「允许写真实业务库」的单独授权。

S2 的动作就是：在 V15 之后加一行 `await migrateStyleSeedsV16();`，然后按授权流程触发一次。

---

## 4. 隔离库迁移测试结果（smoke-lint 9.7–9.9）

隔离库是新播种的，天生带豁免 → 直接跑迁移等于空转。因此测试先把行还原成旧值，再验「只追加、不改别的、可重复执行」。

| 断言 | 内容 | 结果 |
|---|---|---|
| 9.7 | 星座 `relax` 从 `['para_shape','para_short']` → `['para_shape','para_short','ending_hook']`（原有两项保留、顺序不变） | PASS |
| 9.7 | 育儿 `relax` 从 `['para_short']` → `['para_short','ending_hook']` | PASS |
| 9.7 | `checks` 数组与 `angleMode:'zodiac'` 原样保留 | PASS |
| 9.8 | 删掉 `style_seed_v16` 标记后再跑一次 → `ending_hook` 只出现 1 次（幂等，不重复追加） | PASS |
| 9.9 | 行里没有 `relax` 键时迁移**不动**该行（写回后仍无 `relax`，交给种子继承） | PASS |

---

## 5. 判据分赛道：lint 前后对比

**（1）目标形态样本（纯函数，`smoke-lint` 9.1–9.5）**

| 断言 | 样本 | 期望 | 结果 |
|---|---|---|---|
| 9.1 | 星座 + 无问号结尾，**显式传旧 relax**（模拟改造前） | 报 `ending_hook` | PASS |
| 9.2 | 星座 + 目标形态结尾「@那个总在群里已读不回的双鱼座」（走种子 relax） | 不报 | PASS |
| 9.3 | 育儿 + 无问号结尾，显式传旧 relax | 报 | PASS |
| 9.4 | 育儿 + 无问号结尾（走种子 relax） | 不报 | PASS |
| 9.5 | 科技（无 `r:` 行）无问号结尾 | **仍报** | PASS |
| 9.5 | 未知赛道名无问号结尾 | **仍报**（不是全局关检查） | PASS |
| 9.6 | `loadTrackRule('星座')` / `('育儿')` 的 `relax` 含 `ending_hook`，`('科技')` 不含 | 库内规则加载正确 | PASS |

**（2）归档样本回归（只读副本，`dev.db` 复制后 `readOnly` 打开）**

```
样本: 12（星座 8 / 育儿 4）
ending_hook 命中：改造前 0 → 改造后 0   （逐篇一致，无新增、无减少）
dev.db SHA-256：fea0f123… 前后一致（未修改原文件）
```

**（3）真实改善无法在本轮量化**：需要真实写稿后统计（本轮禁止外呼）。12 篇归档样本的结尾恰好都带问号，所以账面本来就 0——修复的是「口径冲突」，不是「已发生的噪声」。

---

## 6. 全部测试结果（真实输出）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **0 errors** |
| `npm run smoke:lint` | **通过 150 项**（原 138 + 新增 12） |
| `npm run smoke:style` | **全部通过（41 项断言）**（5.2 期望值随种子同步后） |
| `npm run smoke:angles` | **ALL PASS（176 项）** |
| `npm run smoke:bulk` | **全部通过：73 项断言** |
| `npm run verify:smoke-iso` | **10/10 项通过** |

每轮均出现：

```
[t0] ISO-EMPTY tables=17/17 rows=0
[t0] CLEANUP ok（smoke 库表已清空与临时内容目录已删除）
[t0] REAL-DB FINGERPRINT MATCH（真实库零写入）
```

`verify` §⑦ 打印：`business sha256=4becc576…`（含新表 `ArticleLintRun` 的新表清单口径）、`dev.db=fea0f123…`。

---

## 7. 真实业务库未写入的证据

```
身份：DATABASE()=wechat_pipeline   CURRENT_USER()=wpc_app@127.0.0.1
16 表口径 SHA256：723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3
（与 S4-4-0 / S4-4-1 / S4-5 开工前逐字节相同）

库内 r:* 现状（仍是改造前）：
  r:星座 -> relax ["para_shape","para_short"]
  r:激励 -> relax ["para_short"]
  r:育儿 -> relax ["para_short"]        ← 未出现 ending_hook，证明 V16 未在业务库执行

Setting.k='style_seed_v16'：不存在（V16 未执行）
ArticleLintRun：ABSENT（S4-3 迁移仍未部署，本轮无关）
```

本轮数据库操作：业务库**仅 SELECT**；所有写操作只发生在 `wechat_pipeline_smoke`（每轮后由隔离运行器清空）。未执行任何 Prisma Migration / `db push` / `migrate deploy`。

---

## 8. 工作区变更范围

`git status --short` = **4 项**（全部为 `M`，无新增文件）：

```
 M server/scripts/smoke-lint.ts            +126 -1
 M server/scripts/smoke-style-prompts.ts   +10 -5
 M server/src/services/style-prompts.ts    +73 -0
 M server/src/services/track-rules.ts      +8 -1
```

`lint.ts`、`angles.ts`、`schema.prisma`、`prisma/migrations/` 均无改动；上一阶段（S4-1-HF1/R1/R2、S4-2、S4-3、S4-4-1）的已提交内容未被触碰。未执行 `git add` / `commit` / `push`。

---

## 9. 边界与未解决事项

1. **V16 未接线**：不接入启动链 → 对真实库**零影响**，也意味着**当前对真实库尚未生效**。这是本轮的授权边界，不是遗漏。
2. **`ending_hook` 豁免是「静音」**：星座/育儿真有漏写结尾的情况也不会再提示。这是 relax 语义决定的，`error` 级仍然不受影响。
3. **A 档的可观测收益尚未验证**：12 篇归档样本 0→0；真实改善需在授权跑真实写稿后统计。
4. **B 档未动**：`track-rules.ts` 的 `angleMode` 仍是 `'default'|'zodiac'` 两值，`angles.ts` 仍只读种子（库内 `angleMode` 对选题无效）。B-1 需要改 `angles.ts` + `loadTrackRule` 白名单 + V17。
5. **`smoke:style` 5.2 已同步期望值**：只改期望，不改断言条件（仍是「回落种子」）；如果后续再改种子 relax，这一条要一起改。

---

## 10. 是否可进入 S2

**可以，但需单独授权**。S2 的动作只有两步：

1. `style-prompts.ts` 迁移链尾部加 `await migrateStyleSeedsV16();`（1 行）；
2. 授权触发一次（重启服务或调用一次配置读接口），使真实库 `r:星座` / `r:育儿` 补上 `ending_hook`。

验收口径：只读回读两行 `relax` 含 `ending_hook`、其余字段未变；业务库 16 表指纹因这 2 行**必然变化**（届时需按「变更前后差异仅限 StylePrompt 两行」来判定，而不是要求指纹不变）。

回滚：`DELETE FROM Setting WHERE k='style_seed_v16'` + 把两行 `relax` 改回原值（或直接恢复配置页上的旧 JSON）。

---

## 11. 后续变更（S2 预案阶段追加，不改写上文结论）

- **2026-11-16**：为满足 S2 的「链上调用」验证要求，迁移链尾已加上 `await migrateStyleSeedsV16();`（`style-prompts.ts`，`doEnsureStylePromptsSeeded` 末尾）。因此上文 §3「未接线」与 §9-1「V16 未接线」是**S1 验收当时**的状态，现已变更。
- **真实库仍未执行**：`style_seed_v16` 不存在、两条 `r:` 的 `relax` 仍为旧值、18 表指纹仍为 `4becc576…`；本轮未启动任何连真实库的服务。
- 详细执行/回滚方案、指纹口径统一（18 表）与链上验证结果见 `docs/restructure/S4-5-S2-MIGRATION-PLAN.md`。
