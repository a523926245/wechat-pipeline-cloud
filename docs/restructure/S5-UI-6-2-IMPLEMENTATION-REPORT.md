# S5-UI-6-2 · dry-run 横幅真源修复 · 核查 + 实施报告

**日期**：2026-11-18（第一次核查 13:26 / 本轮实施 14:16）
**状态**：**已完成实施，等待人工验收。**
**一句话**：横幅原来用全局 `pushEnabled` 反推"不会推"，而真实推送决策是**按每账号 owner 的 `automationMode`**——所以页面经常说反。本轮在后端 `GET /scheduler` 补了唯一真源 `pushIntent`（复用 tick 的口径），前端只消费它，渲染四态横幅。

---

## 0. 两次任务的关系

| | 第一次（13:26） | 本轮（14:16） |
|---|---|---|
| 授权 | 修横幅，**禁止改后端** | 授权最小后端改动：`GET /scheduler` 增 `pushIntent` |
| 结果 | 核查后**停止**，零代码改动（缺账号级 mode 聚合，前端无法准确判断） | 按授权实施，后端 + 前端改动 |
| 记录 | 见本文附录 A | 见 §1–§8 |

第一次停止的判断依然成立：**不改后端就拿不到准确真源**，用 `my`（只代表当前用户）或 `lastTick`（上次结果）硬凑四态，等于制造第二个错误信号。

## 1. 真源与前因（一句话版）

`tick()` 的推送决策链：`cfg.enabled`（全局）∧ 就绪账号（`enabled=true ∧ credStatus='ok'`）∧ **每账号 owner 的 `User.automationMode`** ∧ 到点 ∧ 产线启用 ∧ 当日未满配额；最终 `push = auto.mode === 'auto_draft_push'`（`services/scheduler.ts` targets 构建处），推送执行只对 `targets.filter(t => t.push)`。

全局 `pushEnabled` 只是**无主账号（`ownerUserId=null`）的兜底值**，从来不是"本次推不推"的信号。旧横幅 `v-if="cfg.enabled && !cfg.pushEnabled"` 因此会把「其实会推」说成「不会推」。

## 2. 后端改动（3 处，全部在 scheduler 域内）

### 2.1 `server/src/services/scheduler.ts`
1. **口径收口**：把「就绪账号」条件抽成唯一常量，`listReadyAccounts()`（tick 用）与新增的 `listReadyAccountRefs()`（预测用）共用，避免两处各写一份而漂移：
   ```ts
   const READY_ACCOUNT_WHERE = { enabled: true, credStatus: 'ok' } as const;
   ```
2. **新增只读查询** `listReadyAccountRefs(ownerWhere)`：只取 `id/ownerUserId`，**带归属过滤**（member 只算自己账号，与 `ownership.ts` 一致）。
3. **新增纯函数** `classifyPushIntent(modes)` + 类型 `PushIntentStatus` / `PushIntent`：
   ```ts
   none    — 没有任何账号是 auto_draft_push（含全 manual）→ 本次不会推
   all     — 全部就绪账号都是 auto_draft_push → 本次都会推
   partial — 只有一部分会推，其余只写草稿
   unknown — 一个就绪账号都没有 → 既不能说会推也不能说不会推
   ```
   注释里明确写了**不掺**「到点 / 产线开关 / 当日配额」：那些是运行时条件，掺进去横幅就会天天变；横幅要回答的是"配好之后会不会推"。

### 2.2 `server/src/api/routes/scheduler.ts`
`GET /scheduler` 响应新增 `pushIntent`，计算路径与 tick 同源，没有第二套逻辑：
```ts
const [config, status, accounts] = await Promise.all([
  getSchedulerConfig(),
  Promise.resolve(getSchedulerStatus()),
  listReadyAccountRefs(accountOwnerWhere(principal)),   // 就绪账号 + 归属
]);
const automation = await resolveAutomationForAccounts(accounts); // tick 用的同一个解析器
const pushIntent = { status: classifyPushIntent(accounts.map((a) => automation.get(a.id)?.mode ?? 'manual')) };
```
- 只读：**不改任何状态、不触发排产、不推送**。
- `PUT /config`、`/tick`、`/start`、`/stop` 一行未动。

## 3. 前端改动（2 个文件）

### 3.1 `web/src/types.ts`
`PushIntentStatus`（四态）+ `PushIntent`，`SchedulerStatus` 增 `pushIntent?: PushIntent`。**故意用可选**：字段缺失时前端宁可不显示，也不猜一个结论。

### 3.2 `web/src/views/SchedulerView.vue`
- 删除旧判断 `cfg.enabled && !cfg.pushEnabled` 与旧文案「当前为 dry-run：调度会写草稿，但不会推送到公众号」。
- 新增 `pushBanner` computed，**只读 `status.pushIntent.status`**，四态文案：

| 状态 | 样式 | 文案 |
|---|---|---|
| `none` | info | 本次不会推送：没有账号处于「自动写稿 + 自动推草稿箱」模式（到点只写草稿，推送需人工操作）。 |
| `partial` | warning | 本次会有部分账号推草稿箱：全自动模式的账号会推，其余账号只写草稿，人工审后可手动推。仅进草稿箱，不会群发。 |
| `all` | warning | 本次所有就绪账号都会推草稿箱：仍然只是草稿箱，不会群发（AUTO_PUBLISH 恒为 false）。 |
| `unknown` | info | 无法判断本次是否会推送：当前没有就绪账号（需已启用且凭据格式合规），请先检查账号配置。 |

- 渲染条件 `v-if="cfg.enabled && pushBanner"`：全局总开关关闭时调度根本不跑，不展示"会推/不会推"的结论。
- 样式类 `dry-run` → `push-intent`（横幅已不是"dry-run 开关"，名字要对得上）。
- 三态文案都显式保留"仅草稿箱、不会群发"的安全边界。

## 4. 验证

### 4.1 工程
| 项 | 结果 |
|---|---|
| `server npm run typecheck` | 0 错误 |
| `web npm run typecheck`（vue-tsc） | 0 错误 |
| `web npm run build`（含 vue-tsc 二次校验） | ✓ built in 14.00s |
| `classifyPushIntent` 单测（**真实 import** `services/scheduler.ts`，只调纯函数、不发 SQL） | 8/8 |
| 静态契约 `p62-contract.mjs` | 26/26 |
| `test:article-push`（回归） | 26/26 |

静态契约覆盖：真源函数存在与签名、就绪账号口径只有一个常量、`GET` 复用 `resolveAutomationForAccounts`、归属过滤在位、**禁止范围零改动**（`targets.filter(t=>t.push)` 仍在、`pushArticleToDraft` 仍唯一一处、无 masssend 路径）、旧 `!cfg.pushEnabled`/旧文案零残留、四态文案齐全、跨轮回归标记（6-1 payload 分支、P1 不跳 `/articles/0`、P2-4 `no_account`、P2-3 `lintHits`）、**构建产物 chunk 内真实含新文案且不含旧文案**。

### 4.2 浏览器（真实 headless Chrome + 派生 Mock，`var/tmp/s5ui2c/`）
Mock 关键设计：`none` 用例把全局 `pushEnabled` 设成 **true**，`partial/all/unknown` 设成 **false**——即"全局信号与真实意图完全相反"，专门用来证明横幅不再依赖 `pushEnabled`。

| 场景 | 视口/主题 | 期望 | 实测 |
|---|---|---|---|
| `pushIntent=none`（pushEnabled=true） | 1440 浅 | info「本次不会推送」 | ✓（旧逻辑此时什么都不显示） |
| `pushIntent=partial`（pushEnabled=false） | 1440 浅 | warning「部分账号推」 | ✓（旧逻辑会错报"不会推"） |
| `pushIntent=all`（pushEnabled=false） | 1440 浅 | warning「都会推 + 不群发」 | ✓（旧逻辑会错报"不会推"） |
| `pushIntent=unknown` | 1440 浅 | info「无法判断…请检查账号配置」 | ✓ |
| 响应无 `pushIntent`（旧后端） | 1440 浅 | 不显示横幅、页面正常 | ✓ |
| `config.enabled=false` | 1440 浅 | 不显示横幅 | ✓ |
| member + `all` | 1440 浅 | 横幅可见 + 全局开关禁用 | ✓ |
| guest | 1440 浅 | 403 → 错误态、无横幅、不崩 | ✓（与后端 `automation:manage` 一致） |
| `partial` | 500 浅 / 500 深 / 1440 深 | 文字换行可读、无页面横向滚动 | ✓（`docOverflow=false`，深色 `body` = `rgb(14,16,20)`） |

Console：以上 11 个场景 **0 error / 0 exception**。

回归实测（同一轮浏览器）：
- admin 保存 payload = `{"enabled":true,"writeTime":"06:00","pushEnabled":false,"automationMode":"auto_draft_push"}`（含全局字段，符合 6-1 设计）；
- member 保存 payload = `{"automationMode":"auto_draft_push","writeTime":"06:00"}`（**只含个人字段**，6-1 未回退）；
- PUT 返回 500 时 toast 为「请求失败（HTTP 500）」，**不伪成功**。

证据：`var/tmp/s5ui2c/p62-unit.mjs`、`p62-contract.mjs`、`mock-p62.mjs`、`walk-p62.mjs`、`P62-unit.json`、`P62-result.json`、截图 `P62-*.png`。

## 5. 未验证项与已发现但未处理的问题

1. **未连真实数据库**：`pushIntent` 的端到端取值（真实账号 mode 分布 → 四态）只做了纯函数单测 + 源码核对，没有跑真实库的 `GET /scheduler`。要跑需起真实服务+账号会话，本轮按"能不动库就不动库"的原则回避。
2. **口径取舍**：`pushIntent` 只反映配置意图，不含"到点/产线关闭/今日配额已满"。极端情况下（例如全部账号今日配额已满）横幅仍显示"会推"，实际本次没东西可推——这是有意的简化，已写进函数注释。
3. **`unknown` 的边界**：`unknown` 表示"没有就绪账号"，包含"有账号但全部未启用/凭据不合规"与"member 自己一个账号都没有"两种情况，文案统一为"请先检查账号配置"，未细分。
4. **既有 500px 卡内横向溢出（非本轮引入）**：`.el-card__body` 424 vs 410、`.cfg-form` 404 vs 370，来自单选组 + 96px 标签宽度。已做对照实验——**横幅缺席（`pushIntent` 缺失）时溢出量完全相同**，与本轮改动无关；登记为 P3，本轮不动（授权范围外）。
5. **member 看到的聚合范围**：`pushIntent` 按 `accountOwnerWhere` 过滤，member 只统计自己的账号（admin 统计全部）。因此同一时刻 admin 与 member 可能看到不同状态，这是刻意的——横幅对谁说话，就按谁的可见范围算。

## 6. 实际修改文件

| 文件 | 改动 | 改前 md5 → 改后 md5 |
|---|---|---|
| `server/src/services/scheduler.ts` | + `READY_ACCOUNT_WHERE`、`listReadyAccountRefs`、`classifyPushIntent`、`PushIntentStatus/PushIntent` | `cd7d5d1e…` → `5e97485f…` |
| `server/src/api/routes/scheduler.ts` | `GET /` 增 `pushIntent`（复用同源解析） | `800a552d…` → `33065ed4…` |
| `web/src/types.ts` | + `PushIntentStatus/PushIntent`、`SchedulerStatus.pushIntent?` | `a6d1a2d3…` → `add23fc9…` |
| `web/src/views/SchedulerView.vue` | 删旧判断/旧文案，加四态 `pushBanner`，类名 `dry-run`→`push-intent` | `806fce10…` → `2094dc83…` |
| `docs/restructure/S5-UI-6-2-IMPLEMENTATION-REPORT.md` | 本报告（核查+实施合并） | — |
| `docs/DEVLOG.md` | 追加一条 | — |

## 7. 边界声明

- **无** Schema / Migration / `.env` / `package.json` 改动；未安装依赖。
- **未连接数据库**（单测 import 只触发 `.env` 读取以满足 `config.ts` 启动校验，未发任何 SQL）；未调用真实 LLM / 微信公众号接口；未执行推送或群发。
- 未改动 `publisher.ts` / `planner.ts` / `permissions.ts` / `ownership.ts` / 前端其他页面；未处理 S5-UI-5 遗留 P3（B1 / D-1 / E-3）与 S5-UI-6-0 的 B-1 / T1。
- **Git**：HEAD 仍为 `b2fbad3`（`feature/open-source-readiness`），无 commit / push / reset / stash / checkout / clean；工作区此前未提交改动全部原样保留（本轮前 76 项 → 现 79 项，新增的 3 项即上表 3 个既有文件的本轮修改）。

## 8. 结论

S5-UI-6-2 的"UI 用错误信号表达实际行为"问题已闭环：横幅判断的输入从**全局兜底值**换成**后端按每账号 mode 聚合的真源**，且四态都可解释、都不夸大推送范围（永远带"仅草稿箱、不会群发"）。

---

## 附录 A · 第一次核查记录（2026-11-18 13:26，未实施）

- **结论**：按当时任务指令停止，零代码改动。核查确认推送决策是"全局开关 ∧ ready 账号集 ∧ 每账号 owner 的 mode ∧ 到点 ∧ 产线开关 ∧ 当日配额"的复合运行时结果，该 `Map` 只在 `tick()` 内部计算，无任何 API 暴露。
- **当时 API 均不足**：`GET /scheduler` 只有 `config`（全局）/ `my`（当前用户自己的 mode）/ `modeOptions` / `lastTick`；`GET /credentials` 不含 `ownerUserId`/`automationMode`（mode 在 owner 的 `User` 行）；dashboard 无聚合；`lastTick` 是上次结果、非本次预测。
- **明确否掉的方案**：用 `my` 近似（admin 跨 owner 时必错，正是"部分账号会推"这种状态识别不出来）；用 `lastTick.pushed` 冒充"本次"（偷换语义）。
- **当时提的最小建议**：后端在 `GET /scheduler` 增推送意图聚合（`none/partial/all/unknown`，口径同 targets），或账号列表暴露 `automationMode`。**本轮即采用第 1 个方案。**
- 原报告中的 API 对照表与真源行号（services/scheduler.ts:194-216、:271-289、:333-335）仍可作为追溯依据；实施后行号已因新增代码下移，以代码注释的自述口径为准。
