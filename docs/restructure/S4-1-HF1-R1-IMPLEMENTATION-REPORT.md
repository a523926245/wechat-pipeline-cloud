# S4-1-HF1-R1 实施报告：重评硬门禁 + 编辑/审核并发竞态修复

- **日期**：2026-11-15
- **授权范围**：仅 S4-1-HF1-R1（HF1 补充修复：①退回候选必须重评才能再过审 ②编辑与审核并发竞态）。未实施 S4-2、未碰 `dedup.ts`、未做其他 S4 阶段、**未执行 Git commit**、未覆盖或清理 HF1 未提交修改（工作区完整保留）。
- **基线核实**：HF1 修改（updateAngle 退回/评分失效、路由提示、smoke 29 组）在工作区完好（`git status` 与 HF1 报告一致后才开始本轮）；RESTRUCTURE-2.0-CONVERGED-PLAN / 00-FINAL-EXECUTION-CHARTER / restructure README / DEVLOG / HF1 报告已读。
- **结论分级**：`【事实】`=代码/测试实证 ｜ `【边界】`=实现取舍与未覆盖项。

---

## 1. 两个问题的代码根因

**问题一（无重评硬门禁）** `【事实】`：HF1 修复后 approved 编辑退回 candidate、评分失效，但 reviewAngle 对 approve 没有任何评分前置条件——退回后的候选**不重新评分也能直接再次 approved**（S4-1 语义「评分不替代人工审核、无分可过审」是为普通候选设计的，被退回候选也搭了便车）。且系统中**没有重新评分入口**（评分只发生在扩库入库前），退回候选实际上无路可走。

**问题二（并发竞态）** `【事实】`（HF1 实现逐行分析）：
- 竞态 A：updateAngle 的读（findUnique 查 status）与写（update 无状态条件）之间存在窗口——读到 candidate 时若并发审核刚把它改成 approved，写入只更新正文**不退回状态** → 最终「新正文 + approved」，审核绕过重现。
- 竞态 B：reviewAngle 的 CAS 只带 `status + reviewRound`，不带内容——审核事务读到旧正文（或旧标记状态）后，若并发编辑提交了新正文/标记，CAS 条件仍匹配 → **过期的审核结论盖到新内容上**（把没看过的正文批成 approved）。
- 反向时序（指令 §4.1 两个场景）均落入以上两类。

## 2. 实际修改文件及修改目的

| 文件 | 修改 | 目的 |
|---|---|---|
| `server/src/services/topic-review.ts` | ① `AngleScoreMeta` 增加 `rescoreRequired?: boolean` ② reviewAngle：approve 前重评门禁 + CAS 扩至 `content/theme` + 冲突改 409 | 问题一的拦断点 + 问题二的审核侧原子条件 |
| `server/src/services/angles.ts` | ① updateAngle 重写为**双分支条件原子更新**（approved 回退分支 / 非 approved 分支），CAS 带 content/theme 快照；回退分支写 `rescoreRequired:true` ② 新增 `rescoreAngle`（复用 scoreAngleCandidates）③ AngleItem 增加 `rescoreRequired` | 问题一的标记写入/清除 + 问题二的编辑侧原子条件 + 重评入口 |
| `server/src/api/routes/angles.ts` | ① `POST /api/angles/:id/rescore` ② PUT 提示语含「重新评分」 | 重评 API 入口 + 提示准确 |
| `web/src/types.ts`、`web/src/api/index.ts`、`web/src/views/TrackAnglesView.vue` | `rescoreRequired` 字段 + `rescoreAngle` API + 行操作「重新评分」按钮（仅带标记时出现） | 门禁拒后用户有路可走（最小 UI，无新抽象） |
| `server/scripts/smoke-angles.ts` | 新增 30 组 28 断言（门禁矩阵 + 竞态测试） | 见 §8 |
| `docs/DEVLOG.md` | R1 记录 | 收尾留痕 |

**未修改**：`prisma/schema.prisma`、migrations、`dedup.ts`、planner/writer/publisher、`.env`、任何数据库结构。HF1 的既有实现与测试全部保留（81 项断言原样通过）。

## 3. 待重新评分标记的存储与清除机制

- **存储**：`Angle.metaJson.rescoreRequired: boolean`（复用现有 metaJson JSON 字段；DATABASE-DESIGN-REVIEW §③ 明文该字段承载「评分依据/风险说明/判重结果」，增加一个评分状态键不与既有键 `scores/scoreSource/scoreModel/scoredAt/riskHits/suggestion/rationale/scoreError` 冲突——逐一核对过读写方：`toScoreMeta/readScoreMeta/updateAngle 失效写/rescoreAngle` 均兼容扩展键）`【事实】`
- **置位**：updateAngle 的**回退分支**（内容实质变更且写入时状态为 approved → 退回 candidate）原子写入 `rescoreRequired: true`。普通候选的编辑/新增/扩库**不置位**。
- **保持**：带标记的候选再次编辑（评分失效写）时由 `prev` 展开**原样保留**标记；needs_revision/rejected 流转不动标记。
- **清除**：仅 `rescoreAngle` 评分成功时写 `rescoreRequired: false`（与新评分同一 metaJson 写入、同一 CAS，原子完成）。**评分失败/缺失/不完整一律不清除**（也从不给无标记候选新造标记）。
- **TopicReview 历史**：全程不删不改（HF1 语义延续）；多轮编辑-重评-审核的 round 按现有规则续进。`【事实】`（测试 30-8/30-9）

## 4. 重新评分成功的判定依据

**成功 = `normalizeScores` 校验通过的完整六维**（六维齐全且均为 0-5 整数，`scores` 非 null）——与 S4-1 评分口径同一判定（缺维/越界/解析失败/调用失败/批次缺条目全部算失败）。成功时：
1. 新评分整体替换 metaJson 评分区（`toScoreMeta` 产物）；
2. `rescoreRequired: false`；
3. 二者**同一次 CAS 写入**（条件：content/theme 与评分时读取的快照一致）——等效于「当前有效评分对当前内容成立」。

失败时落 `scores:null + scoreError`（保留原标记）。CAS 失败（评分期间正文被改）→ 409，评分结果作废不落库。`【事实】`

## 5. 普通 candidate 与 HF1 candidate 的区别

| | 普通 candidate（手动新增 / 扩库 / 非 approved 编辑） | HF1 candidate（approved 编辑退回） |
|---|---|---|
| 识别 | `metaJson.rescoreRequired ≠ true`（无键或 false） | `metaJson.rescoreRequired === true` |
| 评分要求 | **不强制**（S4-1 语义保留：未评分可人工拍板） | **必须先重评**取得完整六维，才允许 approve |
| approve 被拒提示 | 无（正常通过） | 400「…处于『待重新评分』状态：请先重新评分…」 |
| needs_revision / rejected | 原语义 | **同样不受门禁影响**（仅 approve 受限） |
| 来源 | createAngle / expandAnglesForTrack / 非 approved 态的内容编辑 | updateAngle 回退分支（唯一置位点） |

`【事实】`（测试 30-1 普通未评分直接过审、30-2/30-3 标记与拒批、30-10/30-11 双向区分）

## 6. 并发竞态的核查结论

按指令 §4.1 两个时序逐一核查（HF1 代码为分析对象）：

| 时序 | HF1 现状 | R1 结论 |
|---|---|---|
| A 读 candidate → B 改 approved → A 提交正文修改 | **存在漏洞**：读值判定「非 approved 不退回」，写入无状态条件 → 新正文 + approved | **已修复**：回退写改为条件更新 `where status='approved'`——写入时只要是 approved 一律命中回退分支（不再依赖读值判定），测试 30-RACE1 实证 |
| A 读 approved → B 改正文退回 → A 提交审核 | **存在漏洞**：门禁不存在 + CAS 不含内容 → 过期 approve 可落到新内容 | **已修复**（双保险）：①重评门禁在事务内对**当前标记**判定（B 的退回已置标记则直接拒）②CAS 扩至 content/theme——读快照与写入间内容被改则 409，测试 30-RACE2 实证 |
| 双请求真并发任意交错 | 同上两类 | 混合并发 ×5 实测不变量成立（30-RACE3）：**新正文绝不带 approved** |

## 7. 事务及更新条件（修复细节）

**updateAngle**（单事务内）：
- 内容实质变更 → `updateMany` **分支一**：`where {id, content@快照, theme@快照, status:'approved'}` → 写 `fields + status:'candidate' + metaJson(失效+rescoreRequired:true)`；未命中 → `updateMany` **分支二**：`where {…, status in (candidate/needs_revision/rejected)}` → 只写 fields+失效 metaJson（标记由 prev 保留）；再未命中 → **409 ConflictError**「该选题刚刚被其他人修改或审核过，请刷新后重试」。
- 非实质变更（scope/同值）→ `updateMany where {id, content@快照, theme@快照}`，未命中同样 409。
- 双分支用**写入时条件**而非读值决定回退，天然覆盖「读时 candidate 写时 approved」的翻转。

**reviewAngle**（单事务内）：findUnique 读快照（status/reviewRound/metaJson/content/theme）→ 流转校验 → **重评门禁**（approved + rescoreRequired → 400）→ `updateMany where {id, status@快照, reviewRound@快照, content@快照, theme@快照}` CAS → 未命中 **409 ConflictError** → 写 TopicReview。

**rescoreAngle**（单事务外的条件写）：评分后 `updateMany where {id, content@快照, theme@快照}` 写 metaJson，未命中 409（评分结果作废）。均为「带状态条件的原子更新 + 事务内状态复核」，**未引入**乐观锁框架/版本号/锁机制/新状态机/新表。`【事实】`

## 8. 新增测试及测试结果

`smoke-angles.ts` 新增 30 组 **28 断言**（81 → 109），全部走隔离测试库：

| 任务测试场景 | 用例 | 结果 |
|---|---|---|
| 普通未评分 candidate 可按原规则人工审核 | 30 普通未评分 candidate 直接过审 | PASS |
| approved 编辑正文后退回 candidate | 30 改正文退回 candidate + 标记 | PASS |
| 退回后未重评 approve 被拒 | 30 未重评 approve → 400 提示重新评分 | PASS |
| 评分失败后 approve 仍被拒 | 30 越界分 / 缺条目 / 无模型调用失败 三路 | PASS ×3 |
| 评分成功后可正常进入人工审核并 approved | 30 重评成功清标记 → 过审 round=2 | PASS |
| 历史 TopicReview 保留 | 30 历史审核记录保留 2 条 | PASS |
| 多轮编辑、重评、再审核 | 30 二轮编辑→重评→过审 round=3 | PASS |
| 其他结论不受门禁影响 | 30 标记期间 needs_revision/rejected 不受限 | PASS |
| 非 approved 编辑不打标记 | 30 非 approved 编辑不打标记且评分失效 | PASS |
| **编辑与审核并发**（真实事务时序） | 30-RACE1：行锁强制窗口内「审核批准」提交，编辑须退回——结果 candidate+新正文+标记（请求实测在锁上等待 273ms） | PASS |
| | 30-RACE2：行锁强制窗口内「编辑」提交，审核 CAS 失配 409、新正文与标记保留（271ms 锁等待） | PASS |
| | 30-RACE3：Promise.all 真并发编辑+审核 ×5 轮，不变量「新正文绝不带 approved」全部成立 | PASS ×5 |

竞态测试手法（满足「尽可能模拟真实事务时序」）：30-RACE1/2 用**交互事务持行锁**制造确定性窗口——请求 A 的条件更新在锁上等待期间，请求 B 的提交在持有锁的事务内完成，A 放锁后按当前行状态重评条件——与真实并发「读-改-写交错」的时序等价且**可复现**；日志实证两次请求真实阻塞在行锁（273ms/271ms），非顺序执行的伪测试。30-RACE3 再以无同步的真并发补充覆盖任意交错。

**运行结果**：`SMOKE ANGLES: ALL PASS (109 项)` + `REAL-DB FINGERPRINT MATCH（真实库零写入）`。

## 9. 原有 S4-1 / HF1 回归结果

| 项 | 结果 |
|---|---|
| `npm run typecheck`（server tsc） | 0 错误 |
| `npm run typecheck`（web vue-tsc） | 0 错误 |
| `npm run smoke:angles` 原 1-29 组（S4-1 64 + HF1 17 = 81 断言） | 全过（109 总数含其 81） |
| `npm run smoke:lint` | 116 项全过 |
| `npm run smoke:style` | 41 项全过 |
| `npm run verify:smoke-iso` | 10/10（含真实库前后指纹一致） |

S4-1 与 HF1 既有行为零破坏：普通候选过审、状态机流转、终态拦截、approved-only 消费、门禁 26-28 组、HF1 退回/失效/scope 不误伤/空编辑、失败零部分更新全部原样通过。`【事实】`

## 10. 数据库安全核查

| 核查项 | 结果 |
|---|---|
| 真实业务库 `wechat_pipeline` | **零写入**。每轮 smoke 结束 `REAL-DB FINGERPRINT MATCH`；verify ⑦ 前后指纹一致（business sha256=438f1d28… / dev.db=fea0f123… 与基线一致） |
| Prisma Schema / Migration | 零变化（git diff 无 schema.prisma / migrations） |
| `.env` / 数据库账号 / 权限 / 其他库 | 未动 |
| 隔离测试库 | smoke-isolated 副本，run 后 0 残留 |
| LLM / 微信 / 发布调用 | 零调用（评分全部 Mock 注入；路由级重评用例走「无模型绑定→评分失败」路径） |
| `dedup.ts` | 未触碰 |

## 11. Git 工作区状态

按令**未 commit**；HF1 未提交修改全部保留（本轮 8 个修改文件中 angles.ts/routes/smoke-angles/DEVLOG 为 HF1+R1 叠加，topic-review/web 三文件为 R1 新增）。累计：

```
 M docs/DEVLOG.md                        （HF1 + R1 记录）
 M server/scripts/smoke-angles.ts        （HF1 29 组 + R1 30 组）
 M server/src/api/routes/angles.ts       （HF1 提示 + R1 rescore 路由）
 M server/src/services/angles.ts         （HF1 退回 + R1 条件更新/rescoreAngle）
 M server/src/services/topic-review.ts   （R1 门禁 + CAS）
 M web/src/api/index.ts                  （R1 rescoreAngle）
 M web/src/types.ts                      （R1 rescoreRequired）
 M web/src/views/TrackAnglesView.vue     （R1 重新评分按钮）
?? docs/restructure/S4-1-HF1-IMPLEMENTATION-REPORT.md   （上一轮）
?? docs/restructure/S4-1-HF1-R1-IMPLEMENTATION-REPORT.md（本报告）
?? docs/restructure/S4-1-MIGRATION-DEPLOY-REPORT.md     （遗留）
?? docs/restructure/S4-1-PRE-MIGRATION-CHECK-REPORT.md  （遗留）
?? docs/restructure/S4-2-0-DEDUP-AUDIT-REPORT.md        （遗留）
```

变更量：`8 files changed, 757 insertions(+), 39 deletions(-)`（含 HF1 累计）。建议提交信息（待处置）：`S4-1-HF1(+R1): content-edit review rollback with rescore gate and race-safe CAS`。

## 12. 尚未解决的问题

1. **「重评后再编辑」的理论绕口** `【边界】`：标记清除后若在过审**前**再次实质编辑，按普通候选语义（不置标记、评分失效）可无分过审——与「手动未评分候选可过审」的 S4-1 语义一致，但严格来说该内容从未取得过有效评分。若要堵死（例如：置过标记的候选每次实质编辑都重置标记），一行可加，需用户拍板（会略微收紧普通语义）。
2. **approved 后再重评** `【边界】`：rescoreAngle 对任意状态开放（含 approved），成功会覆盖其评分显示——不影响状态与消费，仅参考分刷新；如需限制只允许 candidate 重评可另定。
3. **used=true 的退回候选**：已消费选题被编辑同样退回+置标记（与 HF1 一致）；其重评/再过审流程与未消费选题相同，是否需要差异化策略未定。
4. **并发冲突的用户侧体验**：409 需用户刷新重试（指令要求语义）；前端未做自动刷新合并（保持最小改动）。
5. **cli/migrate.ts 遗留**（HF1 报告 §10-5 同）：非正式入口写 content 不经 updateAngle，不带退回/标记逻辑——S4-7 清理时处置。
6. **RACE 测试的时序覆盖**：锁强制窗口覆盖了两类经典交错（读-写窗口内翻转状态/内容）+ 真并发 ×5；未穷举所有交错排列（也不必：条件更新的正确性不依赖交错顺序，测试验证的是条件语义）。

---

## 附：验收对照（任务 §六）

| # | 验收标准 | 结果 |
|---|---|---|
| 1 | 普通 candidate 原有审核流程回归 | ✅ 30-1 + 原 22 组 |
| 2 | HF1 编辑退回后重新评分硬门禁测试 | ✅ 30-2/30-3/30-7 |
| 3 | 评分失败及异常场景测试 | ✅ 30-4/30-5/30-6（越界/缺失/调用失败三路） |
| 4 | 编辑与审核并发测试（真实事务时序） | ✅ 30-RACE1/2（锁强制）+ 30-RACE3（真并发×5） |
| 5 | 旧 S4-1 审核及创作门禁测试 | ✅ 22/26-28 组原样通过 |
| 6 | 原有 smoke:angles 全部测试 | ✅ 109/109（81 旧 + 28 新） |
| 7 | TypeScript 检查 | ✅ tsc 0 / vue-tsc 0 |
| 8 | lint、style 和 smoke 隔离验证 | ✅ 116 / 41 / verify 10/10 |
| 9 | Schema/Migration 无变化 | ✅ git diff 实证 |
| 10 | 真实业务库零写入 | ✅ 指纹 MATCH ×3 轮 + verify ⑦ |
| 11 | 不碰 dedup.ts / 不实施 S4-2 | ✅ |
| 12 | 不 commit、保留已有工作区修改 | ✅ HF1 修改逐一在位 |

**S4-1-HF1-R1 完成。按令停止，等待人工验收。未开始 S4-2。**
