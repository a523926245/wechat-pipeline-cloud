# S5-UI-5-P1 · 创作计划出稿失败反馈闭环修复 · 实施报告

**日期**：2026-11-17
**性质**：P1 单链路修复（基于 S5-UI-5 审计 P1，已获授权）。只修正结果语义与反馈链路，不重构排产系统。**本轮未改 Schema/Migration/`.env`、未连库、未调真实 LLM/微信、未推送、未 Git 写操作、未实施 P2/P3。**
**结论**：完成。后端 `created` 只含真实成功文章、`failed`/`skipped` 分离；前端四态反馈（全成功/部分成功/全失败/全跳过）经真实浏览器逐项验证，**全部失败时无绿色 Toast、无 `/articles/0` 跳转**。失败补偿与 Angle claim 逻辑未改（契约断言 4 处 release 调用保留）。typecheck/build/契约断言全绿，Console 0 error。

---

## 1. 根因与原始错误链路
**根因【代码确认，审计报告已复现】**：
- `planner.ts` 把建稿/脚本/兜底补偿失败项以 `id:0` push 进 `created`（原 `:405/:490/:554`），失败项与真实成功项混在同一数组。
- `plans.ts` 用 `created.length > 0` 判 `ok=true`，message 用 length 计数——失败项被当成"已生成草稿"。
- `PlanView.vue` 取 `first=created[0]`（`id:0`）→ 文章线 `!modelUsed(null)` 把失败误认成骨架草稿 → 确认框标题「已生成骨架草稿」但正文全是"建稿失败" → 点「去改稿」跳 `/articles/0` → 404 StateError。
**修复前后对比**：原审计 `W5P1-result.json` 记录了误导 toast、矛盾确认框、`/articles/0` 404；本轮 `P1FIX-*.json` 记录四态正确反馈。

## 2. 修改文件与具体变更
| 文件 | 变更 |
|---|---|
| `server/src/services/planner.ts` | ① `TriggerResult`：`created` 只含真实 id>0 成功项（注释明确）；新增 `failed`（失败项，无虚假 id）、`skipped`（跳过数）。② 2 处提前 return（配额满/无可消费选题）补 `failed:[]`/`skipped`。③ 5 处 push 分离：2 处真实成功仍进 `created`（漫画 `r.articleId`、文章 `article.id`），3 处失败改 `failed.push`（去掉 `id:0`）。④ TaskRun 的 failures/status/errorCode/errorMessage 全改用 `failed`，格式不变（Dashboard 执行异常读 errorMessage 兼容）。⑤ 4 处 return 均带 `failed`/`skipped`。**失败补偿 releaseReservedAngles 逻辑一字未改**。 |
| `server/src/api/routes/plans.ts` | trigger 结果组装：`ok: succeeded>0`（succeeded=created.length）；返回 `failed`/`skipped`；message 四态区分（全成功/部分成功带失败数/全失败带真实原因/全跳过用 reason）。 |
| `web/src/types.ts` | `TriggerResult` 加可选 `failed?`/`skipped?`（兼容旧响应缺省）。 |
| `web/src/views/PlanView.vue` | trigger 反馈四态：全成功（green toast+去改稿跳真实 id）、部分成功（无 green、显示成功数+失败明细、只跳真实成功）、全失败（无 toast、标题「建稿失败」、真实原因+下一步、只有「知道了」不跳转）、全跳过（「未生成草稿」+跳过数+reason、不跳转）。骨架草稿/漫画插图既有提示在"全成功"分支保留。 |
| `docs/restructure/S5-UI-5-P1-IMPLEMENTATION-REPORT.md` / `docs/DEVLOG.md` | 本报告 / 追加记录 |

## 3. 后端返回结构变化及兼容性
- `TriggerResult.created` 语义收窄为"真实成功"：所有消费方自动受益——`scheduler.ts:316` 的 `res.created.length` 调度日志不再把失败算产量（更准）；`planner.ts:668` deprecated 别名直接透传，无消费逻辑。
- 新增 `failed`/`skipped`：前端类型设为可选，旧响应（无这些字段）按 `[]`/`0` 降级，不崩。
- TaskRun 记录内容不变：`status`（failed/success）、`errorCode`（write_failed/comic_script_failed）、`errorMessage`（`summarizeFailures(failed)` 格式与旧 `summarizeFailures(failures)` 完全一致）、`resultJson.createdIds`（现在 created 只有真实 id，更准确）。Dashboard 执行异常抽屉读 errorMessage 不受影响。
- **无新接口、无 Schema 改动**。

## 4. 四态测试结果（真实浏览器，非仅单测）
走查脚本 `var/tmp/s5ui2c/walk-p1fix-one.mjs`（独立 Chrome 会话，参数化场景），派生 Mock `mock-p1fix.mjs`（四账号 901-904 对应四态，Mock 记录请求体证明 accountId 正确）。结果 `var/tmp/s5ui2c/P1FIX-全成功.json` 等 + 截图 `P1FIX-*.png`。

| 场景 | 后端响应 | Toast | 弹窗标题 | 正文要点 | 按钮 | 跳转 | 判定 |
|---|---|---|---|---|---|---|---|
| 全成功(2/0) | ok=true created=2 | green「已生成 2 篇草稿」 | 已生成草稿 | 是否打开第一篇 | 稍后/去改稿 | `/articles/9001`（真实 id） | ✅ |
| 部分成功(1/1) | ok=true created=1 failed=1 | **无** | 部分草稿生成成功 | 成功1+失败1+「建稿失败：模拟上游超时」 | 稍后/去改稿 | `/articles/9003`（真实成功 id） | ✅ |
| 全失败(0/2) | ok=false created=0 failed=2 | **无** | 建稿失败 | 2 条真实原因+模型就绪/选题归还下一步 | 仅「知道了」 | **停 `/plan`，无 /articles/0** | ✅ |
| 全跳过(0/0/跳过2) | ok=false skipped=2 reason | **无** | 未生成草稿 | 跳过 2 条+角度池已空原因 | 仅「知道了」 | 停 `/plan` | ✅ |

- 请求体日志 `trigger-body.log` 证明四态分别以 accountId 901/902/903/904 触发，非错位。
- 四态 Console 均 **0 error**。
- **成功文章 ID 真实性**：Mock 返回的 9001/9003 是夹具值（Mock 的 /api/articles 无这两条，改稿页会 404）——这是夹具限制；真实后端 `created[].id` 直接来自 `prisma.article.create` 的返回值，必为真实落库 id（代码确认）。

## 5. 失败补偿与 Angle claim 保护证据
- **契约断言（源码级，全部通过）**：`planner.ts` 无 `id:0` 残留；`created.push` 仅 2 处（均为真实 id：`r.articleId`/`article.id`）；`failed.push` 3 处；4 处 return 均带 failed/skipped；**`releaseReservedAngles(` 调用保留 4 处**（含 catch 内两处、finally 兜底一处、定义一处）。
- **未改**：选题预留 `reserveAnglesForPipeline`、commit/claim 逻辑、`pending` Set 的出队时机（"先补偿再出队" HF1 修复）、finally 兜底归还、事务边界——本轮只动结果数组的用途与字段，补偿代码逐字未碰。
- **本次未连库**，故补偿的运行时行为未实测（既有 S4-4-1 冒烟已覆盖，本轮无回归改动）。

## 6. 类型检查、构建与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| server typecheck | `npm run typecheck` | ✅ exit 0 |
| web typecheck | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 24.05s |
| 结果语义契约断言 | 源码级（planner/plans/PlanView/types） | ✅ 全部通过（见 §5） |
| 浏览器四态验证 | `walk-p1fix-one.mjs` ×4 | ✅ 四态正确，Console 0 error |
| 写库 smoke 脚本 | `smoke:*` 系列 | **未运行**：检查源码确认会写隔离库/清表，超本轮"无授权数据库写操作"边界。无 plan 专属测试脚本。 |

## 7. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 66 项未提交改动全部原样保留，未覆盖/回滚/清理；`PlanView.vue` 本就 modified，本轮在其上叠加。`planner.ts`/`plans.ts`/`types.ts` 的改动是新增的（基于干净文件）。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 8. 数据库及外部接口副作用
未修改 Schema/Migration/`.env`；未连接或写入任何数据库（含业务库与 smoke 库）；未调用真实 LLM、微信公众号接口；未推送；未安装依赖、未改 package.json。浏览器用本地 Mock，LLM/微信边界由 Mock 承担。

## 9. 尚存问题及风险
1. **TaskRun 的 finally 兜底补偿失败**：仍沿用旧时序——return 先求值、finally 后 push，finally 里追加的 `failed`（补偿未完成）不会进已写好的 TaskRun.errorMessage（旧代码同样如此，非本轮引入）。前端仍能看到（failed 是引用，return 对象会反映），但 Dashboard 执行异常抽屉不会显示这条。属既有行为，未在 P1 范围。
2. **Mock 成功 id 非真实**：浏览器验证的成功 id 是夹具值；真实落库 id 由代码确认保证（见 §4）。
3. **深色模式**：本轮浏览器验证聚焦四态反馈，未单独逐态测深色（S5-UI-5 审计已覆盖 articles 深色）；弹窗用 el-message-box 令牌，无自定义颜色，风险低。
4. **前端 `failed`/`skipped` 可选**：兼容旧响应，但若后端返回 `ok:true` 却缺 `created`（异常响应），前端 `first` 为 undefined 不跳转——防御性可接受。

## 10. 结论
S5-UI-5-P1 完成，四态反馈与后端结果语义一致，全部失败误报成功与 `/articles/0` 跳转已消除，失败补偿与 claim 逻辑未受影响。**本轮到此停止，等待人工验收，不实施 P2/P3，不提交 Git。**
