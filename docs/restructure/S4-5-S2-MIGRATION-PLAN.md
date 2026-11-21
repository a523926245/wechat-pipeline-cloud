# S4-5 S2 执行预案（v4）：V16 在真实业务库生效

- **性质**：执行预案 / runbook（不是设计文档）
- **版本**：**v4**（2026-11-16）—— 当前生效版本；v1/v2/v3 的历史变更见 §12
- **前提**：S1 已验收（`docs/restructure/S4-5-A-IMPLEMENTATION-REPORT.md`）
- **一句话**：接线已完成且隔离验证通过；真实库尚未执行。S2 的动作是「备份 → 部署 → 触发一次配置读取 → 按 §5 验收 → 记新基线」。

---

## 0. 执行状态（重要，先看这里）

| 项 | 状态 |
|---|---|
| 代码接线 | **已完成**：`style-prompts.ts` 迁移链尾已加 `await migrateStyleSeedsV16();` |
| 对真实库执行 | **已执行（2026-11-16 14:00 前后）**：`r:星座` / `r:育儿` 已补 `ending_hook`，`style_seed_v16=16` 已写入；详见 **§13 执行记录** |
| 新业务库基线 | 18 表指纹 `5d449bb72e1cf352e5790aa5e07278ca6cf8531aa2085d3da982886500781308`（旧 `4becc576…` 作废） |
| 回滚 | 仍按 §6：`--pin-flag` 先钉标记 → 恢复 prompt → 回读校验；备份见 §13 |

---

## 1. 核对结论

| 项 | 实际位置 / 事实 |
|---|---|
| V16 定义 | `server/src/services/style-prompts.ts:1839` `export async function migrateStyleSeedsV16()` |
| 标记常量 | `LEGACY_SEED_KEY_V16 = 'style_seed_v16'`（同文件，函数上方） |
| 迁移链 | `doEnsureStylePromptsSeeded` 内，现在**止于** `await migrateStyleSeedsV16();`（`style-prompts.ts:1231-1234`） |
| 函数声明提升 | `export async function` 是声明，可被上方调用，不存在"先用后定义" |
| 启动是否调用 | **不会**。`server/src/index.ts` 只有 `ensureContentDirs()` + `startServer()` |
| 实际触发点 | `listStylePrompts()`、`getStylePrompt()`、`pickVariants()`（`ensureStylePromptsSeeded` 的三个调用点，行号随改动漂移，以函数名定位） |
| 并发闸门 | `seedReady` 模块级 Promise 记忆化：同一进程内整条链只执行一次（`resetStyleSeedGate()` 可重开，仅测试用） |

---

## 2. 代码改动（已应用）

`server/src/services/style-prompts.ts`，`doEnsureStylePromptsSeeded` 末尾：

```diff
   await migrateStyleSeedsV15();
+  // S4-5 A 档（V16）：给星座/育儿补 ending_hook 豁免。
+  // 只追加一个 relax 项，checks/angleMode 与其余豁免原样保留（见函数内注释）。
+  await migrateStyleSeedsV16();
 }
```

---

## 3. 触发方式与时机

**自动时机**：进程内首次调用 `getStylePrompt` / `listStylePrompts` / `pickVariants`。业务上等价于：打开「文风配置」页、写稿、推送体检、题库扩库、任何读样式配置的 API。

**不会发生**：`npm start` 本身不触发；重启后到第一次配置读取之间，库里仍是旧值。

**S2 推荐触发**：部署/重启 → 打开一次配置页（或 `GET /api/style-prompts`，带管理令牌）→ 立刻跑 §5。
**不要**用"写稿 / 扩库"触发（会走真实 LLM，越界）。

---

## 4. 执行前只读 SQL

连接：`mysql -h 127.0.0.1 -u wpc_app -p wechat_pipeline`（口令见 `server/.env`，不写进任何文件）

**4.1 身份**

```sql
SELECT DATABASE() AS db, CURRENT_USER() AS who, VERSION() AS ver;
-- 期望：wechat_pipeline / wpc_app@127.0.0.1 / 8.0.30
```

**4.2 两行原始 JSON（回滚要用，必须落盘备份）**

用 `scripts/restore-style-prompt.ts --dump`：走 Prisma 读 `prompt` **原样落盘**（不转义、不做换行转换、不补行尾换行），落盘后立刻回读比对，打印两侧 SHA-256，不一致直接 `exit 1`。

```bash
cd server
mkdir -p var/tmp/s45          # var/ 已在 .gitignore 内；⚠️ 不要用 /tmp（Windows 上会解析成 K:\tmp，实测 ENOENT）

node --experimental-strip-types scripts/restore-style-prompt.ts \
  --key "r:星座" --dump var/tmp/s45/zodiac.before.json
node --experimental-strip-types scripts/restore-style-prompt.ts \
  --key "r:育儿" --dump var/tmp/s45/parenting.before.json
```

每次输出必须是这样（两个 sha 必须相同、逐字节一致为「是」、JSON.parse 通过）：

```
已备份 r:星座 → var/tmp/s45/zodiac.before.json
  库内 sha256 : <A>
  文件 sha256 : <A>
  逐字节一致  : 是
  文件字节数  : <n>
  relax       : ["para_shape","para_short"]
  JSON.parse  : 通过
```

> **为什么不用 mysql CLI 备份（2026-11-16 实测，Windows MySQL 8.0.30 客户端，同一台服务器）**
>
> | 命令 | DB 内字节 | 导出字节（`od -c`） | 结论 |
> |---|---|---|---|
> | `-N -B` | `61 0A 62`（`a␊b`） | `a \ n b \r \n` | 换行/制表/反斜杠被**转义**成字面 `\n` `\t` `\\`，JSON 解析直接失败 |
> | `-N -B --raw` | `61 0A 62` | `a \r \n b \r \n` | 不转义了，但客户端文本模式把**所有 LF 改写成 CRLF**，仍非逐字节，且多一个行尾换行 |
>
> 即 `--raw` 只解决前一半问题：**Windows 客户端做不到字节保真**，所以本预案不用 CLI 备份。
> 交叉验证（同一台服务器，用 Prisma 参数化往返，不写任何表）：客户端 sha256 = 服务端 `SHA2()` = 回读 sha256，逐字节一致、无 CRLF、`JSON.parse` 通过 —— 说明 Prisma 取值这一段本身不转换字节。

**4.3 标记不存在**

```sql
SELECT COUNT(*) AS v16_flag FROM Setting WHERE k='style_seed_v16';   -- 期望 0
```

**4.4 基线（行数 + 逐行哈希 + 18 表指纹）**

```sql
SELECT (SELECT COUNT(*) FROM StylePrompt) AS style_rows,
       (SELECT COUNT(*) FROM Setting)     AS setting_rows;          -- 44 / 15

SELECT `key`, SHA2(prompt, 256) AS h FROM StylePrompt ORDER BY `key`;
```

**18 表指纹（唯一真源：直接跑脚本，不再在手写数组）**

```bash
cd server
node --experimental-strip-types scripts/smoke-isolated.ts fp
```

输出：

```
[fp] database=wechat_pipeline
[fp] tables=18
Track:0#0|TrackPipeline:0#0|…|StylePrompt:44#3097952989|…|_prisma_migrations:4#396515796
[fp] business sha256=4becc576366c47d73ad5410aacad7973f05055cc07333bdce2ae80319d7e2aad
```

- `fp` 复用 `verify` 用的同一个 `fingerprintBusinessDb()`：**同一份 `FINGERPRINT_TABLES`、同一段算法**，输出里的 `tables=18` 就是防止再出现"文档 16 表 / 脚本 18 项"这种分叉。
- 若误把 `DATABASE_URL` 指到隔离库，会打印 `WARN 目标是隔离库…`，别把那个值当业务库基线。

**当前实测（执行前基线）**：`4becc576366c47d73ad5410aacad7973f05055cc07333bdce2ae80319d7e2aad`

---

## 5. 执行后只读验证 SQL

> `prompt` 是 `TEXT`（不是 JSON 列）→ 必须 `CAST(prompt AS JSON)`；用**下标**判断顺序，不依赖 JSON 排版。

**5.1 relax 含 ending_hook，原有项仍在、顺序不变**

```sql
SELECT
  `key`,
  JSON_UNQUOTE(JSON_EXTRACT(CAST(prompt AS JSON), '$.relax[0]')) AS relax_0,
  JSON_UNQUOTE(JSON_EXTRACT(CAST(prompt AS JSON), '$.relax[1]')) AS relax_1,
  JSON_UNQUOTE(JSON_EXTRACT(CAST(prompt AS JSON), '$.relax[2]')) AS relax_2,
  JSON_LENGTH(JSON_EXTRACT(CAST(prompt AS JSON), '$.relax'))     AS relax_len,
  JSON_CONTAINS(CAST(prompt AS JSON), '"ending_hook"', '$.relax') AS has_hook
FROM StylePrompt WHERE `key` IN ('r:星座','r:育儿') ORDER BY `key`;
```

| key | relax_0 | relax_1 | relax_2 | len | has_hook |
|---|---|---|---|---|---|
| `r:星座` | `para_shape` | `para_short` | `ending_hook` | 3 | 1 |
| `r:育儿` | `para_short` | `ending_hook` | NULL | 2 | 1 |

**5.2 checks / angleMode / 顶层字段集合未变**

```sql
SELECT `key`,
  JSON_EXTRACT(CAST(prompt AS JSON), '$.checks')    AS checks,
  JSON_EXTRACT(CAST(prompt AS JSON), '$.angleMode') AS angle_mode,
  JSON_KEYS(CAST(prompt AS JSON))                   AS top_keys
FROM StylePrompt WHERE `key` IN ('r:星座','r:育儿') ORDER BY `key`;
```

- `r:星座`：`["zodiac_topic","zodiac_textbook","zodiac_repeat","zodiac_dup"]` / `"zodiac"`
- `r:育儿`：`[]` / `"default"`
- `top_keys` **含且仅含**三项（**不比顺序**——`JSON_KEYS` 顺序不保证，实测为 `["relax","checks","angleMode"]`）

**5.3 其他 StylePrompt 行未被修改**

```sql
SELECT `key`, SHA2(prompt, 256) AS h FROM StylePrompt ORDER BY `key`;
```

与 §4.4 快照 diff：**只允许 `r:星座` / `r:育儿` 变化**，其余 42 行哈希必须一致。

**5.4 标记已写入**

```sql
SELECT k, v, kind, `desc`, updatedAt FROM Setting WHERE k='style_seed_v16';   -- v='16'
```

**5.5 指纹重算**：跑 §4.4 的 `fp`。预期 `StylePrompt:44#…`、`Setting:16#…` 变化，其余行（含 `ArticleLintRun:absent`）不变，总哈希不再等于 `4becc576…`——**这是正确结果**。

---

## 6. 回滚（参数化脚本，禁止手工拼 SQL）

**工具**：`server/scripts/restore-style-prompt.ts`（本轮扩展：`--dump` 备份 / `--from` 恢复 / `--dry-run` 校验）

- **读取即备份**：`--dump` 把库内 `prompt` 原样写文件，写完回读比对 + 打印两侧 SHA-256；**fail-closed** —— 文件与库内不逐字节一致 → `exit 1`，库内 `JSON.parse` 失败 → `exit 1`，两者都通过才 `exit 0`；
- 恢复：读 `.before.json` → `JSON.parse` 校验（必须是对象、`checks` 是数组、`angleMode` 是字符串）→ Prisma `update({ where, data })` **参数化写入**，全程不拼 SQL 字符串；
- 只接受 `--key r:*`（防止误伤 `global` / `sys:` / `s:` / `v:`）；
- `--dry-run` 只比对不写；
- `--pin-flag` 的执行顺序由脚本强制：**① 先 upsert `style_seed_v16=16` → ② 再恢复 prompt → ③ 回读校验 SHA-256**（回读与备份不一致 → `exit 1`）。日志会按 `① / ② / ③` 打印，便于事后核对。

**执行顺序（必须照此：先钉标记、再改数据）**

```bash
cd server

# ① 先钉死标记：此后任何配置读取都不会再触发 V16
node --experimental-strip-types scripts/restore-style-prompt.ts \
  --key "r:星座" --from var/tmp/s45/zodiac.before.json --pin-flag

# ② 第二行（同样带 --pin-flag，幂等）
node --experimental-strip-types scripts/restore-style-prompt.ts \
  --key "r:育儿" --from var/tmp/s45/parenting.before.json --pin-flag
```

```sql
-- ③ 复验：has_hook 应为 0，哈希应与 §4.2 备份一致
SELECT `key`, SHA2(prompt,256) AS h,
       JSON_CONTAINS(CAST(prompt AS JSON),'"ending_hook"','$.relax') AS has_hook
FROM StylePrompt WHERE `key` IN ('r:星座','r:育儿');
```

**为什么顺序不能反**：代码还在链上、标记缺失时，任何一次配置读取都会立刻把 `ending_hook` 补回去——先恢复数据等于白做。
**并发兜底**：若某进程已读到"标记缺失"并在恢复后落库，会再加回来；此时标记已在、不会再有新调用，**重跑 ②** 一次即可。
**彻底回滚**：先撤 §2 那 3 行并重启（链不再调用 V16），再执行 ②；标记留着无害（要重跑得 `DELETE FROM Setting WHERE k='style_seed_v16'`）。

**脚本自检结果（隔离库 `wechat_pipeline_smoke` 内建最小 `StylePrompt` / `Setting` 表实测；测完已 `DROP`，库回到 0 表）**

| 检查 | 结果 |
|---|---|
| `-N -B` 是否转义特殊字符 | **会**：`61 0A 62` → `61 5C 6E 62`（`a\nb`），JSON 解析失败 |
| `-N -B --raw` 是否字节保真 | **否**：LF 被改写成 CRLF（`61 0D 0A 62`），且多一个行尾换行 |
| Prisma 取值是否改字节（参数化往返，不写表） | **不改**：客户端 sha256 = 服务端 `SHA2()` = 回读 sha256，无 CRLF，`JSON.parse` 通过 |
| 正常 `--dump` | exit 0：库内/文件 sha256 均为 `a249ec6…`、逐字节一致、`JSON.parse` 通过 |
| 库内是坏 JSON 时 `--dump` | **exit 1**：打印 `备份失败：库内 prompt 不是合法 JSON` |
| `--pin-flag` 顺序（脚本日志） | `① 已钉死迁移标记` → `② 已恢复` → `③ 回读 sha256`，exit 0 |
| `--pin-flag` 顺序（DB 侧证据） | `Setting.updatedAt=…10.547Z` **早于** `StylePrompt.updatedAt=…10.567Z` |
| 回滚后回读 | 回读 sha256 = 备份 sha256（`a249ec6…`），`restore` 与 `relax` 均回到旧值 |
| 内容已一致时再回滚 | 跳过 `update`，仍走 ③ 校验并 exit 0 |
| `--key global` | 拒绝执行：`--key 必须形如 "r:赛道"`（exit 1） |
| 坏 JSON 备份 `--from` | 拒绝写入：`备份不是合法 JSON`（exit 1） |

> **未做**：`--dump` 对**真实业务库**的端到端执行——本轮禁止连接真实库。S2 第 1 步会由脚本自身完成"库内 sha256 == 文件 sha256 + JSON 合法"的双重判定，任一不满足直接 `exit 1`，不会静默产出坏备份。

---

## 7. 指纹表集合统一（本次修订核心）

| 口径 | 表数 | 组成 | 哈希 | 状态 |
|---|---|---|---|---|
| 历史口径（S4-3 / S4-4-1 报告里的"16 表"） | **17** | 16 业务表（**不含** `ArticleLintRun`）+ `_prisma_migrations` | `723a8027…` | 仅历史记录，**不再使用** |
| 脚本口径（`verify:smoke-iso` 的 `FINGERPRINT_TABLES`） | **18** | 17 业务表（**含** `ArticleLintRun`）+ `_prisma_migrations` | `4becc576…` | **今后唯一口径** |

- 差异只有 `ArticleLintRun` 一项：它在业务库 `absent`，17 项口径里没有这一条，18 项口径记作 `ArticleLintRun:absent`。**哈希不同全部来自这个字符串，不是数据变了**（已实测：18 项口径算出 `4becc576…`，与 `verify` ⑦ 打印值逐字节一致）。
- `verify` 的 `ISO-EMPTY tables=17/17` 指的是**业务表** 17 张（清表矩阵），与指纹 18 项（多一个 `_prisma_migrations`）不冲突。
- **唯一真源（本条为修订重点）**：`smoke-isolated.ts fp`（或 `verify:smoke-iso` ⑦）——两者调用的是**同一个 `fingerprintBusinessDb()`**，共用一份 `FINGERPRINT_TABLES`。**本 Runbook 不再保存任何表数组、不再内联计算逻辑**；`fp` 输出里的 `tables=18` 就是口径自证，若哪天脚本改了表清单，`fp` 会直接反映，文档不需要跟着改。
- 隔离验证：`fp` 在 `DATABASE_URL` 指向 `wechat_pipeline_smoke` 时能正常输出（`[fp] tables=18`，各表 `absent`），并额外打印 `WARN 目标是隔离库…`，避免误当业务库基线。
- **跨轮基线**：S2 之后 `4becc576…` 永久失效，须把当轮新哈希写进验收记录。

---

## 8. 避免重复触发

| 层 | 机制 |
|---|---|
| ① 标记 | `Setting.style_seed_v16='16'`，函数首行 `if (flag?.v === '16') return;` |
| ② 进程闸门 | `seedReady` 记忆化 Promise：每进程整条链只跑一次；并发请求共享同一 Promise |
| ③ 函数幂等 | 逐行 `relax.includes('ending_hook')` 才写；`checks`/`angleMode` 不参与计算 |

三层全失效（标记被删 + 重启）时最坏也只是"判断后跳过"，**不会重复追加**。
**失败语义**：任一行 `update` 抛错 → 跳 `catch`（只 warn）→ **标记不写** → 下次读取重试；已成功的行因第③层被跳过。

---

## 9. 隔离验证：链上真的调用了 V16

**位置**：`server/scripts/smoke-style-prompts.ts` 第 [6] 节（全新 smoke 进程 + `wechat_pipeline_smoke`）

**做法**：进程启动时链已跑过（库里是新种子，V16 空转）→ 手动把两条 `r:` 写回旧值、删掉标记 → `resetStyleSeedGate()` 重开闸门 → **只调公开入口 `ensureStylePromptsSeeded()`**（不直接调 V16）→ 断言；再重开一次闸门跑整条链验幂等。

**实际输出**：

```
PASS  6.1 前置：两条 r: 已还原为旧值、标记已删
PASS  6.1 链上调用生效：星座/育儿 relax 均被追加 ending_hook
PASS  6.1 链上迁移不碰规则本体：checks / angleMode 保持原样
PASS  6.1 迁移标记已写入（v=16）
PASS  6.2 幂等：重复跑整条迁移链不重复追加
全部通过（46 项断言）
```

> 价值在于**只调用公开入口**：哪天有人把 V16 从链上摘掉，`smoke:style` 会立刻变红——这是"接线段断没断"的哨兵。

---

## 10. S2 授权后的执行清单

| # | 动作 | 验收点 |
|---|---|---|
| 1 | §4.1/4.3/4.4 只读 SQL + §4.2 两条 `--dump` + `fp` 取基线 | 身份 `wechat_pipeline`、`v16_flag=0`、44/15 行、两文件「逐字节一致 是」、`fp` 输出 `tables=18` 与 `business sha256=4becc576…` |
| 2 | 确认接线就位：`grep -n "migrateStyleSeedsV16" src/services/style-prompts.ts` | 两处命中（链 + 定义） |
| 3 | 部署 / 重启进程 | 启动日志无异常；**此时尚未执行** |
| 4 | 打开配置页或 `GET /api/style-prompts` 一次 | 触发 V16 |
| 5 | 跑 §5.1–5.4 | 全部符合期望 |
| 6 | 跑 §5.3 diff + §5.5 指纹 | 只 2 行变；仅两表 checksum 变 |
| 7 | 回归：`smoke:lint` / `smoke:style` / `smoke:angles` / `smoke:bulk` / `verify:smoke-iso` | 计数不降（150/46/176/73）、`ISO-EMPTY 17/17`、`REAL-DB FINGERPRINT MATCH`（同轮前后） |
| 8 | 记录新基线哈希 + 验收报告 | 下一阶段引用新哈希 |

---

## 11. 风险与判定标准

1. **指纹必然变化**：判定标准是"差异仅限 `StylePrompt` 两行 + `Setting` 一行"，不是"指纹不变"。
2. **`updatedAt` 会刷新**：两条 `r:` 行的 `updatedAt` 变化属预期。
3. **执行窗口**：执行时不要有人在配置页/接口改 `r:`，否则干扰 diff 判定。
4. **豁免是静音**：生效后星座/育儿即使真漏写结尾也不再提示；`error` 级不受影响。
5. **接线带来的新风险**：代码已接线 → 任何连真实库的服务启动 + 一次配置读取都会执行 V16。授权前不要启动服务（§0）。

---

## 12. 修订记录

### v4（2026-11-16，本轮：脚本两处安全修复）

| # | 问题 | 修复 |
|---|---|---|
| 1 | `--pin-flag` 先恢复 prompt、后写标记 —— 与"先断开重跑入口再改数据"的要求相反，中间存在被迁移链补回的窗口 | 改为 **① upsert 标记 → ② 恢复 prompt → ③ 回读校验 SHA-256**（不一致 `exit 1`）；日志按 ①②③ 打印 |
| 2 | `--dump` 的 `JSON.parse` 失败只打印日志、仍 `exit 0`，会产出"看起来成功"的坏备份 | 改为 fail-closed：文件与库内不逐字节一致 → `exit 1`；`JSON.parse` 失败 → `exit 1`；两者都过才 `exit 0` |

### v3（2026-11-16，备份保真 + 指纹真源）

| # | 修订项 | 具体做法 | 验证 |
|---|---|---|---|
| 1 | **备份改走 Node，不用 mysql CLI** | `restore-style-prompt.ts` 增 `--dump`：Prisma 读 `prompt` 原样落盘（不转义/不换行转换/不补行尾），写完回读比对 + 双 sha256，不一致 `exit 1` | 实测 `-N -B` 把 LF 转义成字面 `\n`；`--raw` 关掉转义但把 LF 改写为 CRLF、且多一个行尾换行 → CLI 在 Windows 上无法字节保真；Prisma 参数化往返三方 sha256 一致且无 CRLF |
| 2 | **指纹只留一个真源** | 新增 `smoke-isolated.ts fp` 子命令，直接复用 `fingerprintBusinessDb()`；Runbook 删掉手写表数组与内联计算，改为调用 `fp` | `fp` 在隔离库跑通（`tables=18`、各表 `absent`、`--` 告警）；与 `verify` ⑦ 同函数同表集合 |

### v2（同日早先：主体修订）

| # | 修订项 | 具体做法 |
|---|---|---|
| 1 | **统一指纹表集合** | 核对出历史"16 表"实为 **17 项**（16 业务表 + `_prisma_migrations`，缺 `ArticleLintRun`），脚本是 **18 项**（17 业务表 + `_prisma_migrations`）；今后唯一口径 = 18 项，基线 `4becc576…`；§7 写明差异来源与换算依据 |
| 2 | **回滚参数化** | 新增 `server/scripts/restore-style-prompt.ts`：读 `.before.json` → JSON 校验 → Prisma 参数化 `update`；`--dry-run` / `--pin-flag`；只接受 `r:*`；三道守卫已实测（§6） |
| 3 | **链上调用验证** | `smoke-style` 新增 [6] 节 5 项断言：用 `resetStyleSeedGate()` + 公开入口验证"链确实调用 V16"、标记/两行/幂等均正确（§9） |
| 附 | 接线落地 | 迁移链尾已加 `await migrateStyleSeedsV16();`；**未对真实库执行**（§0 写明风险与撤销方式） |

**本轮验证汇总（真实输出）**：`typecheck` 0 · `smoke:style` **46**（41+5）· `smoke:lint` **150** · `smoke:angles` **176** · `smoke:bulk` **73** · `verify:smoke-iso` **10/10**（`business sha256=4becc576…`）；真实库仍为 `4becc576…`、`v16` 标记不存在、两条 `r:` 仍为旧值。

v3 追加：`fp` 子命令在隔离库跑通（`tables=18`、全部 `absent`、隔离库告警正常）；备份命令改为 `--dump`（CLI 转义/CRLF 问题已实测并记录）；本 Runbook 已无任何内联表数组或指纹计算代码。

---

## 13. S2 执行记录（2026-11-16，真实业务库，已执行）

### 13.1 执行前现场

| 项 | 实际值 |
|---|---|
| 分支 / HEAD | `feature/open-source-readiness` / `f214c57` |
| 工作区 | 9 项未提交（6 M + 3 ??），全部属 S4-5；`git diff --check` 无输出 |
| 数据库身份 | `DATABASE()=wechat_pipeline`、`CURRENT_USER()=wpc_app@127.0.0.1`、`VERSION()=8.0.30` |
| `style_seed_v16` | 计数 0（不存在） |
| 行数 | `StylePrompt=44`、`Setting=15` |
| 目标行（执行前） | `r:星座` `relax=["para_shape","para_short"]` sha `b9136b9b…`；`r:育儿` `relax=["para_short"]` sha `b067cd6e…` |
| 18 表指纹 | `4becc576366c47d73ad5410aacad7973f05055cc07333bdce2ae80319d7e2aad` |

### 13.2 备份（保留至验收结束）

| 文件 | SHA-256 | 校验 |
|---|---|---|
| `server/var/tmp/s45/zodiac.before.json` | `b9136b9bd752ad59de29d31b756f13b28ab8c16b127dd2d36760529084564019` | 库内=文件、逐字节一致、JSON 通过 |
| `server/var/tmp/s45/parenting.before.json` | `b067cd6eaf47d6b45dd1679dd75a4d6f17e8816e04ae13dfa1b0d228c9e21b7f` | 同上 |

另存：`rows.before.txt` / `rows.after.txt`（44 行逐行 SHA-256）、`fp.before.txt` / `fp.after.txt`。

### 13.3 触发

- 服务：`npm start`（`node --experimental-strip-types src/index.ts`），启动日志 `服务已启动 http://localhost:8787 (pid 8196)`，无异常。
- 触发：**单次** `GET /api/style-prompts`（带现有会话 cookie，未创建新会话）→ `HTTP 200`、返回 44 条。
- 服务日志实证：
  ```
  {"level":30,"changed":["r:星座","r:育儿"],"msg":"已为星座/育儿补上 ending_hook 豁免"}
  {"level":30,"reqId":1,"msg":"GET /api/style-prompts -> 200 (150ms)"}
  ```
- 触发后立即停止服务（`taskkill //F //PID 8196`），8787 已释放。

### 13.4 执行后验收

| 检查 | 实际结果 |
|---|---|
| `r:星座` | `relax_0..2 = para_shape / para_short / ending_hook`，`len=3`，`has_hook=1` |
| `r:育儿` | `relax_0..1 = para_short / ending_hook`，`len=2`，`has_hook=1` |
| `checks` | 星座 4 项原值不变；育儿 `[]` 不变 |
| `angleMode` | `zodiac` / `default` 不变 |
| 顶层字段 | 两行均为 `["relax","checks","angleMode"]` 三项（不比顺序） |
| 44 行 diff | 变化仅 `["r:星座","r:育儿"]`，其余 **42 行 SHA-256 完全一致**，无行丢失 |
| `style_seed_v16` | 存在，`v=16`，`kind=json`，`updatedAt=2026-11-16 06:00:37.589` |
| 18 表指纹 | `5d449bb72e1cf352e5790aa5e07278ca6cf8531aa2085d3da982886500781308` |
| 逐表差异 | 仅 `Setting 15#2066245777 → 16#3445107854`、`StylePrompt 44#3097952989 → 44#2958987911`；其余 **16 张表指纹不变** |

### 13.5 回归（真实输出）

| 命令 | 结果 |
|---|---|
| `typecheck` | 0 errors |
| `smoke:style` | 全部通过（46 项） |
| `smoke:lint` | 通过 150 项 |
| `smoke:angles` | ALL PASS（176 项） |
| `smoke:bulk` | 全部通过：73 项断言 |
| `verify:smoke-iso` | 10/10（`business sha256=5d449bb7…`，`dev.db=fea0f123…`） |

每轮均 `ISO-EMPTY tables=17/17 rows=0` + `CLEANUP ok` + `REAL-DB FINGERPRINT MATCH`。

### 13.6 新基线

- 业务库 18 表指纹：`5d449bb72e1cf352e5790aa5e07278ca6cf8531aa2085d3da982886500781308`（**S4-5 S2 后基线**，`4becc576…` 作废）
- `StylePrompt` 44 行 / `Setting` 16 行

### 13.7 异常

无。未发生身份不匹配、备份失败、迁移报错、非目标行变更、标记缺失或回归失败；未执行回滚。
