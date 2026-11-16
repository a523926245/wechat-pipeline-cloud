# S4-1-HF1-R2 实施报告：封闭重复编辑后的重新评分绕过

- **日期**：2026-11-15
- **授权范围**：仅 S4-1-HF1-R2（封闭「重评成功后再次编辑可不重评过审」的边界漏洞）。未实施 S4-2、未碰 `dedup.ts`、未做其他 S4 阶段、**未执行 Git commit**、HF1/R1 未提交修改完整保留。
- **基线核实**：动手前 `git status` 与 HF1/R1 报告逐一对照（8 修改文件 + 5 未跟踪报告全在位）；`metaJson.rescoreRequired` 的置位（updateAngle 回退分支）/清除（rescoreAngle 成功）/保留（失败、非 approved 编辑 spread）现状已逐行确认后才开始本轮。RESTRUCTURE-2.0-CONVERGED-PLAN / 00-FINAL-EXECUTION-CHARTER / restructure README / DEVLOG / HF1 与 R1 报告已读。
- **结论分级**：`【事实】`=代码/测试实证 ｜ `【边界】`=实现取舍与未覆盖项。

---

## 1. 问题根因

`【事实】`（R1 实现逐行分析 + R1 报告 §12-1 自登记边界）：
- R1 的 `rescoreRequired` 是「**当前是否待重评**」单标记：updateAngle 回退分支置 true，rescoreAngle 成功置 false。
- 但**非 approved 态的实质编辑**（updateAngle 分支二）只失效评分，**不重置标记**——于是在「重评成功（标记=false）→ 再次修改正文（评分失效但标记仍 false）→ approve」这条路径上，reviewAngle 的门禁（只拦 `rescoreRequired === true`）放行，**未经重评的新正文被批准**。
- 根因：系统只记录「当前是否欠一次评分」，不记录「该选题是否处于 HF1 重评约束期」——评分成功把约束期一并忘掉了。

## 2. 重评流程身份标记设计

复用 `Angle.metaJson`（不新增 Schema/Migration/字段），新增一个内部键（指令 §3.3 允许的 `rescoreWorkflow`），与 R1 标记分工：

| 键 | 含义 | 谁看 |
|---|---|---|
| `rescoreWorkflow: boolean` | **流程身份**：该选题已进入 HF1 重评约束期（因 approved 实质修改退回），在重新审核通过前一直成立 | reviewAngle 门禁、updateAngle 分支二、rescoreAngle 保留 |
| `rescoreRequired: boolean` | **当次待评分状态**：当前正文是否还欠一次有效评分 | reviewAngle 门禁、前端「重新评分」按钮（`AngleItem.rescoreRequired`） |

读写方逐一核对（无覆盖冲突）`【事实】`：`AngleScoreMeta` 接口扩展两个可选键；`toScoreMeta`（扩库评分产物，两键均不写=普通候选）；`readScoreMeta`（透明扩展键）；updateAngle 失效写（spread 保留）；rescoreAngle（显式控制）；reviewAngle（读+清）。既有键 `scores/scoreSource/scoreModel/scoredAt/riskHits/suggestion/rationale/scoreError` 均未改动语义。

## 3. 标记置位、保留、清除的完整生命周期

```
approved ──实质编辑(theme/content)──▶ candidate
  置位：rescoreRequired=true + rescoreWorkflow=true     （updateAngle 回退分支，R1 CAS 原子）
     │
     ├─ 反复编辑（实质）→ 重新置位 rescoreRequired=true   （R2 新增：分支二识别 rescoreWorkflow）
     ├─ 改 scope / 同值重存 → 不触发（非实质，不动标记）   （R1 语义保持）
     ├─ 重评失败/缺失/不完整 → 双标记原样保留             （rescoreAngle 失败路径）
     ├─ 重评成功 → rescoreRequired=false，rescoreWorkflow 保留（只清当次）
     ├─ needs_revision / rejected → 不动标记（仅 approve 受门禁）
     └─ approve 成功（门禁：rescoreRequired=false 且 scores 有效）
           → 清除 rescoreWorkflow=false + rescoreRequired=false（本轮约束结束）
                │
                └─ 之后再实质编辑 → 重新进入新一轮（回退分支再置双标记）
```

- **置位**：① 回退分支（approved+实质编辑）双置；② R2 新增——流程内非 approved 实质编辑重置 `rescoreRequired=true`（`rescoreWorkflow` 维持）。
- **保留**：rescore 成功/失败都保留 `rescoreWorkflow`；spread 失效写从不洗掉它。
- **清除**：唯一出口 = reviewAngle 的 **approve 成功**（与 status/reviewRound 同一 CAS 原子写入清双标记）。普通 candidate 永不获得 `rescoreWorkflow`（不误标）。

`【事实】`（测试 31-1~31-11 全链路覆盖生命周期）

## 4. 普通 candidate 与 HF1 candidate 的行为对比

| | 普通 candidate | HF1 重评流程内 candidate |
|---|---|---|
| 识别 | `rescoreWorkflow` ≠ true | `rescoreWorkflow === true` |
| 实质编辑 | 只失效评分（S4-1） | 失效评分 + **重新置 rescoreRequired** |
| scope/同值修改 | 不触发 | 不触发 |
| 评分要求 | 不强制（可未评分过审） | approve 前必须「rescoreRequired=false 且当前评分有效」 |
| 评分成功 | — | 只清当次待评分，流程身份保留 |
| approve 成功 | 正常（不动 metaJson） | 清双标记，**本轮流程结束** |
| 多轮循环 | 不适用 | 支持（每轮编辑→重评→过审，round 续进） |

`【事实】`（31-11 普通候选多轮编辑未评分过审；31-1~31-10 流程循环）

## 5. 修改文件清单

| 文件 | 本轮修改 | 目的 |
|---|---|---|
| `server/src/services/topic-review.ts` | ① `AngleScoreMeta` 增加 `rescoreWorkflow?: boolean` ② reviewAngle 门禁升级：流程内要求 `rescoreRequired===false` **且** `scores` 有效（双重校验）③ approve 成功同 CAS 清双标记 | 门禁闭环 + 流程结束点 |
| `server/src/services/angles.ts` | ① updateAngle 回退分支置双标记；分支二识别 `rescoreWorkflow`、流程内实质编辑重置 `rescoreRequired` ② rescoreAngle 成功/失败均保留 `rescoreWorkflow` ③ 注释同步 | 标记生命周期 |
| `server/scripts/smoke-angles.ts` | 新增 31 组 25 断言 | §7 |
| `docs/DEVLOG.md` | R2 记录 | 收尾 |

**本轮零前端改动**：「重新评分」按钮仍按 `rescoreRequired` 显隐（=「当前正文待重评」语义正确）；`rescoreWorkflow` 是内部标记，无需 UI 暴露。**R1 的 CAS/条件原子更新/事务语义未动**（diff 仅 metaJson 内容构造与门禁条件）。`【事实】`（git diff 核对）

## 6. 新增测试及测试结果

`smoke-angles.ts` 新增 31 组 **25 断言**（109 → 134），隔离库运行。对照任务测试要求：

| # | 任务测试要求 | 用例 | 结果 |
|---|---|---|---|
| 1 | 普通 candidate 多次编辑仍可未评分过审 | 31 普通候选多次编辑不置标记 / 无流程身份 / 未评分过审 | PASS ×3 |
| 2 | approved 第一次编辑进入重评流程 | 31 首次编辑退回 + rescoreRequired / rescoreWorkflow=true | PASS ×2 |
| 3 | 未重评直接 approve 拒绝 | 31 未重评 approve → 400 | PASS |
| 4 | 重评成功后 approve 可以通过 | 31 首次重评成功清标记 → （31-8）二轮过审 | PASS |
| 5 | 重评成功后再次编辑必须重新置位 | 31 重评后再编辑 → rescoreRequired 重新置位且评分失效 / 流程身份仍在 | PASS ×2 |
| 6 | 再次编辑后不重评 approve 必须拒绝 | 31 二次编辑后未重评 approve → 400（**漏洞封闭点**） | PASS |
| 7 | 第二次重评成功后可再过审 | 31 二轮重评成功 / 二轮过审 round=2 / approve 后流程身份清除 | PASS ×3 |
| 8 | 多轮编辑、重评、审核完整循环 | 31 approve 后再编辑新一轮 / 三轮重评 / 三轮过审 round=3 / TopicReview 3 条保留 | PASS ×4 |
| 9 | 修改 scope 不触发重评 | 31 scope 修改不触发重评 | PASS |
| 10 | 同值正文不触发重评 | 31 同值重存不触发重评 / 标记未被误置 | PASS ×2 |
| 11 | 评分失败时标记不清除 | 31 二轮重评失败标记保留 / 失败后 approve 仍拒 | PASS ×2 |
| 12 | TopicReview 历史完整保留 | 31 历史 3 条 | PASS |
| 13 | R1 的 RACE1/2/3 全部继续通过 | 同批运行中原样通过（见 §8） | PASS |
| 14 | 正式创作 approved 门禁继续有效 | 原 29-5 / 26-28 组原样通过 | PASS |

附加：**31-12 评分有效性兜底**——流程内 `rescoreRequired=false` 但评分被清的脏状态（模拟并发/外部改写）→ approve 仍拒（不单凭 false 标记放行），双重校验生效。`【事实】`

**运行结果**：`SMOKE ANGLES: ALL PASS (134 项)` + `REAL-DB FINGERPRINT MATCH（真实库零写入）`。

## 7. 原有回归结果（S4-1 / HF1 / R1）

| 项 | 结果 |
|---|---|
| `npm run typecheck`（server tsc） | 0 错误 |
| smoke:angles 原 1-30 组（S4-1 64 + HF1 17 + R1 28 = **109 断言**） | 全过（134 总数含其 109） |
| **R1 并发测试回归**：30-RACE1（行锁强制：批准与编辑交错→编辑退回+标记） | PASS |
| 30-RACE2（行锁强制：审核 CAS 失配 409，新正文与标记保留） | PASS |
| 30-RACE3（真并发 ×5 不变量「新正文绝不带 approved」） | PASS ×5 |
| `npm run smoke:lint` | 116 项全过 |
| `npm run smoke:style` | 41 项全过 |
| `npm run verify:smoke-iso` | 10/10（含真实库前后指纹一致） |

R1 的 CAS 条件（status/reviewRound/content/theme）、双分支条件原子更新、409 冲突语义**零退化**（本轮 diff 未触碰 where 条件）。`【事实】`

## 8. 数据库安全核查

| 核查项 | 结果 |
|---|---|
| 真实业务库 `wechat_pipeline` | **零写入**（每轮 run 结束指纹 MATCH + verify ⑦ 前后一致，business sha256=438f1d28… / dev.db=fea0f123… 与基线一致） |
| Prisma Schema / Migration | 零变化 |
| `.env` / 数据库账号 / 权限 / 其他库 | 未动 |
| 隔离测试库 | smoke-isolated 副本，run 后 0 残留 |
| LLM / 微信 / 发布调用 | 零调用（评分全 Mock；无模型路径走评分失败语义） |
| `dedup.ts` / S4-2 | 未触碰 |

## 9. Git 工作区状态

按令**未 commit**、未清理/覆盖任何已有修改。HF1/R1 的 8 个修改文件原样在位；本轮只叠加了 `topic-review.ts`、`angles.ts`、`smoke-angles.ts`、`DEVLOG.md` 的增量（累计 `8 files changed, 971 insertions(+), 40 deletions(-)`，含 HF1+R1+R2 三轮）。未跟踪报告 5 份（HF1 / HF1-R1 / MIGRATION-DEPLOY / PRE-MIGRATION-CHECK / S4-2-0）原样保留，R2 报告为第 6 份。建议提交信息（待处置）：`S4-1-HF1(+R1+R2): rescore workflow lifecycle closing the re-edit bypass`。

## 10. 未解决边界

1. **rejected 终态残留流程标记** `【边界】`：流程内选题被 rejected 后 `rescoreWorkflow` 仍在 metaJson——状态已终态、无消费影响，纯数据残留；若在意可在 rejected 时一并清理（一行），本轮未做（指令未要求，避免动终态语义）。
2. **脏 metaJson 的兜底范围** `【边界】`：31-12 的「评分有效性兜底」拦住了 flag=false+无分的 approve；但若有人手工写入「flag=false + 伪造高分」则门禁放行（评分本来就是参考数据，人工审核是终审）——不视为可修复漏洞。
3. **rescoreAngle 对 approved 开放**（R1 边界延续）：approved 选题可重评刷新参考分，不触碰状态与标记。
4. **409 冲突需人工刷新重试**（R1 边界延续）。
5. **cli/migrate.ts 遗留入口**（HF1 边界延续）：不经 updateAngle，无退回/标记逻辑，S4-7 处置。
6. **前端无流程身份展示**：按钮按「当前待重评」显隐已够用；如需在列表标注「重评流程中（已重评待审）」可后续加（纯展示）。

---

## 附：验收对照（任务 §七）

| # | 验收标准 | 结果 |
|---|---|---|
| 1 | 普通 candidate 原有行为完全保留 | ✅ 31-11 + 30-1 + 全量回归 |
| 2 | HF1 流程中每次正文修改都要求重新评分 | ✅ 31-5/31-6（漏洞封闭点） |
| 3 | 重评成功不提前结束整个流程 | ✅ 31-3/31-5（身份保留、再编辑重置位） |
| 4 | 只有人工 approve 成功才结束流程 | ✅ 31-8（清双标记）/ 31-9（再编辑重开新一轮） |
| 5 | R1 并发保护全部保留 | ✅ RACE1/2/3 原样通过，CAS 零退化 |
| 6 | 原有 S4-1/HF1/R1 测试全部通过 | ✅ 109/109 |
| 7 | 新增 R2 测试全部通过 | ✅ 25/25（总 134） |
| 8 | Schema/Migration 零变化 | ✅ git diff 实证 |
| 9 | 真实业务库零写入 | ✅ 指纹 MATCH ×3 轮 + verify ⑦ |
| 10 | 不扩大授权范围 | ✅ 未碰 dedup.ts/S4-2/其他阶段，未 commit |

**S4-1-HF1-R2 完成。按令停止，等待人工验收。**
