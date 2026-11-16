# S4-1-HF1 实施报告：approved 选题编辑后的审核绕过修复

- **日期**：2026-11-15
- **授权范围**：仅 S4-1-HF1（修复 approved 选题编辑后审核绕过）。未实施 S4-2（去重）、未碰 `dedup.ts`、未做 S4-3 及其他阶段工作。
- **交付**：本报告 + 代码修改 3 文件 + smoke 测试扩充 + DEVLOG 记录。**未执行 Git commit**（遵令）。
- **结论分级**：`【事实】`=代码/测试实证 ｜ `【边界】`=实现取舍与未覆盖项如实登记。

---

## 1. 实际问题及根因

**问题**：已经审核通过（approved）的选题，正文内容被编辑后仍保留 approved 状态，修改后的新内容未经重新审核即可进入正式创作与排产流程。

**根因** `【事实】`：`server/src/services/angles.ts` 的 `updateAngle`（HF1 前）在 content 变更时只做「评分失效」（metaJson.scores 置空 + scoreError 标注），**从不修改 `status`**；而 S4-1 状态机把 approved 设为终态（`REVIEW_TRANSITIONS.approved = []`，审核端口无法回退），于是被编辑过的 approved 选题：
1. 仍通过 `assertAngleApproved` 创作门禁（挂稿/漫画建稿）；
2. 仍被 `planner.reserveAnglesForPipeline`（`used=false AND status='approved'`）取用排产；
3. 六维评分已失效（scores=null），等于「无有效评分且未经复审」的内容混在正式池。

S4-2-0 核查已将其登记为 D-b 待决策项，本次按 HF1 指令修复。`【事实】`（S4-2-0 报告 §4.3、§12.1-D-b 与代码行号一致）

## 2. 修改文件清单和每处修改目的

| 文件 | 修改 | 目的 |
|---|---|---|
| `server/src/services/angles.ts` | 重写 `updateAngle`（+事务、内容实质变更判定、approved→candidate 退回、评分失效，返回体加 `reviewReset` 标记） | 核心修复：内容实质变更时原子完成「正文写入+状态退回+评分失效」 |
| `server/src/api/routes/angles.ts` | PUT /:id 响应 message 按 `reviewReset` 区分文案 | 编辑后明确告知用户「已退回候选待审、旧评分已失效」；前端本就展示 `res.message`，**前端零改动** |
| `server/scripts/smoke-angles.ts` | 新增 29 组 17 断言 + `packJson`/`Prisma` 导入 | 自动化回归（见 §6） |
| `docs/DEVLOG.md` | 追加 HF1 完成记录 | 收尾留痕 |

**未修改**：`prisma/schema.prisma`、migrations、`topic-review.ts`（状态机/评分逻辑不动）、planner、writer、publisher、web 前端、`.env`、任何数据库结构。`【事实】`（git diff 仅 3 代码文件 + DEVLOG）

**其他正文写入入口排查** `【事实】`：
- 正式业务入口中，修改选题正文只有 `PUT /api/angles/:id` → `updateAngle` 一条路（全仓 `prisma.angle.*` 写入点逐一核对）。
- `reassignOffIpAngles` / `releaseAngle` / planner / article-delete 只动 scope 或消费态字段，不改正文。
- `cli/migrate.ts` 会写 content，但它是历史一次性导入 CLI（S2 已删其 npm 脚本 `migrate`/`migrate:dry`，仅剩源文件），非正式业务入口；scripts/ 下 demo-write、prune-old-style 为开发工具，同样非正式入口。无绕过路径。

## 3. 正文变更的判断规则

`updateAngle` 只接受 theme / content / scope 三个可写字段。按任务书「字段实际承载选题正文、核心表达或内容实质的，纳入正文变更判断」划分：

| 字段 | 判定 | 理由 |
|---|---|---|
| `content` | **内容实质** | 选题正文本身 |
| `theme` | **内容实质** | 主题词（2~6 字）承载选题的核心表达；六维评分输入与人工审核对象都是 theme+content——theme 变了评分依据与审核对象都变了。只改 theme 同样触发退回（测试 29-7 固化此规则） |
| `scope` | **管理元数据** | 产线切片归属（article/comic/shared），只决定哪条产线消费，不影响选题内容实质——不触发退回、不失效评分（测试 29-1） |

变更判定为**实际变更**（与库中现值比较，clip 后比较）：
- content/theme 提交但与现值相同 =「空编辑」→ 不退回、不失效（测试 29-2）；
- 只提交 scope 或其他元数据 → 不触发（测试 29-1）；
- 非 approved 状态（candidate/needs_revision/rejected）编辑 → 状态保持原样（既有行为不变），仅按 S4-1 原有规则在内容实质变更时失效评分（测试 29-8）。

`【事实】`（实现 `angles.ts` updateAngle；测试 29-1/29-2/29-3/29-7/29-8 验证）

## 4. 评分失效和历史审核记录保留方式

- **评分失效**：内容实质变更时 `metaJson.scores=null`、`scoreSource='none'`、`scoreModel=''`、`scoredAt=now`、`scoreError='内容已修改，评分已失效（未重新评分）'`，保留 prev 其余键（沿用 S4-1 原失效语义）。旧分数不可能再被当作新内容的审核依据——列表 `scoreTotal` 即变 null，排序自动落到未评分档。`【事实】`
- **TopicReview 历史**：**完全不动**。不删、不改、不覆盖——退回只改 Angle.status 一行。测试 29-4 断言编辑后 `GET /:id/reviews` 仍返回完整历史（1 条 approved 记录，round=1）。`【事实】`
- **审核轮次**：`reviewRound` 原样保留（测试 29-3 断言退回后仍=1）。下一轮人工审核按现有规则 `round = reviewRound + 1` 续进（测试 29-6 断言再审 round=2），与 needs_revision 多轮留痕语义一致。`【事实】`
- **重新进入 approved**：退回后该选题回到 candidate，走现有审核端口 `candidate → approved`（合法流转）即可再进正式池；测试 29-6 验证「重评（写入新评分）+人工审核 → approved（round=2）」全链路，且门禁/排产恢复可用。`【事实】`

## 5. 事务一致性处理

`updateAngle` 改为 `prisma.$transaction(async (tx) => …)`（复用 `reviewAngle` 同款事务方式）：
1. `tx` 内读现值（theme/content/scope/status/metaJson）；
2. 单次 `tx.angle.update({ data })` 同时写入正文/主题/`status: 'candidate'`/新 metaJson——**一条 UPDATE 原子落库**，不存在「正文已改但状态仍 approved」「状态退了旧评分仍有效」「正文成功状态失败」的中间状态；
3. `tx` 内回读完整行组装返回体。

校验失败（空补丁、空正文、id 不存在）在写入前抛错回滚。测试 29-9 验证失败请求零部分更新（状态/评分与失败前逐字段一致）。`【事实】`

## 6. 新增测试场景及测试结果

`server/scripts/smoke-angles.ts` 新增 29 组 **17 断言**（64 → 81），与任务测试表逐行对应：

| 任务测试场景 | 对应用例 | 结果 |
|---|---|---|
| approved 选题修改正文 → 状态退回 candidate | 29 改正文 → 退回 candidate | PASS |
| approved 选题修改正文 → 当前评分失效 | 29 改正文 → 评分失效（scores=null + scoreError） | PASS |
| approved 选题修改正文 → 历史 TopicReview 保留 | 29 TopicReview 历史保留（1 条 approved 记录） | PASS |
| approved 只修改非正文元数据 → 仍为 approved | 29 只改 scope（元数据）→ 仍 approved 且评分保留 | PASS |
| candidate 选题修改正文 → 仍为 candidate | 29 candidate 改正文 → 仍 candidate（评分照常失效） | PASS |
| needs_revision 选题修改正文 → 不改变既有规则 | 29 needs_revision 改正文 → 仍 needs_revision（round=1 保留） | PASS |
| rejected 选题修改正文 → 不改变既有规则 | 29 rejected 改正文 → 仍 rejected（round=1 保留） | PASS |
| 正文更新失败 → 状态和评分不发生部分更新 | 29 空补丁 → 400 / 空正文 → 400 / 失败请求零部分更新（+§5 事务结构保证） | PASS |
| 正式创作使用退回后的选题 → approved 门禁拒绝 | 29 退回后挂稿被 approved 门禁拒绝（400「只有审核通过」） | PASS |
| 重新评分和人工审核 → 可以重新进入 approved | 29 重评+人工审核 → 重新 approved（round=2 续轮，新分 24） | PASS |

附加固化用例（判定规则防回归）：29 夹具基线（round=1、评分 25）、29 相同内容重存（空编辑不失效）、29 改 theme（内容实质）→ 退回、29 reviewRound 保留、29 返回体带退回提示。

**运行结果**（隔离测试库，`npm run smoke:angles` = smoke-isolated 载体）：

```
SMOKE ANGLES: ALL PASS (81 项)
[t0] CHILD EXIT = 0
[t0] CLEANUP ok（smoke 库表已清空与临时内容目录已删除）
[t0] REAL-DB FINGERPRINT MATCH（真实库零写入）
```

## 7. 原有 S4-1 回归测试结果

| 项 | 结果 |
|---|---|
| `npm run typecheck`（server tsc） | **0 错误** |
| `npm run typecheck`（web vue-tsc ×2 串行） | **0 错误 ×2** |
| `npm run smoke:angles` 原 1-28 组（S4-1 评分/状态机/消费/排序/失效/门禁 64 断言） | **全过**（81 总数含其 64） |
| `npm run smoke:lint` | **116 项全过** |
| `npm run smoke:style` | **41 项全过** |
| `npm run verify:smoke-iso` | **10/10**（含「真实库前后指纹一致」） |

S4-1 既有行为零破坏：manual 新增进 candidate、扩库评分语义、状态机流转、终态拦截、approved-only 消费、FIFO、sort=score、评分失效原语义（改内容即失效）全部原样通过。`【事实】`

## 8. 数据库和环境安全核查结果

| 核查项 | 结果 |
|---|---|
| 真实业务库 `wechat_pipeline` 写入 | **零写入**。每次 smoke run 结束 `REAL-DB FINGERPRINT MATCH`；`verify:smoke-iso` ⑦ 前后指纹一致（business sha256=438f1d28…、dev.db=fea0f123… 与 S4-1 部署后基线一致） |
| Prisma Schema / Migration | **零变化**（git diff 无 schema.prisma / migrations） |
| `.env` / 数据库账号 / 权限 | 未动 |
| 隔离测试库 | smoke-isolated 副本运行，run 后 CLEANUP ok、0 残留 |
| LLM / 微信 / 发布调用 | **零调用**（评分/扩库均为 Mock 注入缝；本次仅 updateAngle 路径，无任何模型外呼） |
| AUTO_PUBLISH 红线 | 未动（false） |
| dev.db 归档 + 8 备份 | 未动（哈希核验一致） |

## 9. Git 工作区状态及未提交变更说明

按令**未执行任何 Git commit**。当前工作区（`git status --short`）：

```
 M docs/DEVLOG.md                       （本次 HF1 记录 + 上一轮 S4-1 部署记录，均未提交）
 M server/scripts/smoke-angles.ts       （HF1 测试 29 组）
 M server/src/api/routes/angles.ts      （HF1 退回提示 message）
 M server/src/services/angles.ts        （HF1 核心修复）
?? docs/restructure/S4-1-MIGRATION-DEPLOY-REPORT.md        （上一轮遗留未提交）
?? docs/restructure/S4-1-PRE-MIGRATION-CHECK-REPORT.md     （上一轮遗留未提交）
?? docs/restructure/S4-2-0-DEDUP-AUDIT-REPORT.md           （上一轮遗留未提交）
?? docs/restructure/S4-1-HF1-IMPLEMENTATION-REPORT.md      （本报告）
```

代码变更量：`4 files changed, 269 insertions(+), 30 deletions(-)`（含 DEVLOG）。其中 HF1 必需改动 = 3 个代码文件；DEVLOG 为收尾记录。建议提交信息（待用户处置，不擅自提交）：`S4-1-HF1: roll approved angles back to candidate on content edit`。

## 10. 尚存问题或未覆盖的边界情况

1. **无独立「重新评分」API** `【边界】`：S4-1 遗留（手动新增/编辑不自动评分，「手动补评」入口留待真实使用反馈）。任务书「必须重新评分并经过人工审核才能重新变为 approved」中的**重新评分**目前无独立触发口——本次实现保证「旧评分必然失效、必须重新取得评分才有效」，但**未**把「有新评分」做成再过审的硬门禁：现状 review 端不要求有分即可 approved（与 S4-1「手动未评分选题可人工过审」一致，若改为硬门禁会破坏既有语义）。如需「退回后必须先重评才能再过审」的硬约束，属状态机语义变更，建议单独小项裁决。
2. **theme 归入内容实质是实现判定** `【边界】`：任务书要求自行区分（§3 已给规则与理由）。若用户裁定 theme 只是展示字段、不应触发退回，只需改 `updateAngle` 中 `themeChanged` 的参与条件一行 + 调整 29-7 用例。
3. **失败注入只覆盖校验层** `【边界】`：「正文更新失败零部分更新」测试覆盖 400（空补丁/空正文）路径；真实 DB 级写入失败（如连接中断）未注入演练，靠 §5 单事务单 UPDATE 结构保证原子性。
4. **并发编辑** `【边界】`：两个并发 PUT 同一选题时，各自事务内读现值→写，后者覆盖前者（last-write-wins，与修复前一致）；退回逻辑对每个事务各自判定，最终状态一致（终态是 candidate 或 approved+原值）。未引入锁/版本号（遵令不加复杂机制）。
5. **cli/migrate.ts 遗留** `【边界】`：该文件仍可直接 `node` 执行且写 content 不走 updateAngle（无退回逻辑）。它非正式业务入口（S2 已删 npm 脚本），本轮未动；若未来复活增量同步，需把同一规则带入或统一走 updateAngle。S4-7 清理时可一并处置。
6. **used=true 的 approved 选题被编辑**：同样退回 candidate（新内容未经审核的语义一致）。已被文章消费的历史正文不受影响（Article 独立存储）；如需「已用选题禁止改正文」属另一策略，本次未做（任务书未要求）。

---

## 附：验收对照（任务书 §六）

| # | 验收标准 | 结果 |
|---|---|---|
| 1 | approved 选题正文修改后自动退回 candidate | ✅ 29-3 |
| 2 | 旧评分不能继续作为新正文的有效评分 | ✅ 29-3（scores=null + scoreError） |
| 3 | TopicReview 历史记录完整保留 | ✅ 29-4 |
| 4 | 非正文修改不会造成不必要的审核退回 | ✅ 29-1（scope）、29-2（空编辑） |
| 5 | candidate、needs_revision、rejected 原有行为没有被破坏 | ✅ 29-8 + 全量回归 |
| 6 | 正式创作和排产门禁仍然有效 | ✅ 29-5 + 原 23/26/27 组 |
| 7 | 新增测试全部通过 | ✅ 81/81 |
| 8 | Prisma Schema 和 Migration 无变化 | ✅ git diff 实证 |
| 9 | 真实业务库没有任何写入 | ✅ 指纹 MATCH ×4 轮 |
| 10 | 原有 S4-1 测试和相关回归测试通过 | ✅ angles 64 旧断言 + lint 116 + style 41 + verify 10/10 |

**HF1 完成。按令停止，等待人工验收。未开始 S4-2，未修改 dedup.ts。**
