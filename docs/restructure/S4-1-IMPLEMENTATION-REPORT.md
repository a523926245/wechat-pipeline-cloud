# S4-1 执行报告：选题评分与审核状态机

- **日期**：2026-11-14
- **授权**：S4-1 正式实施任务书（六维评分 / 审核状态 / TopicReview / 消费链路 / 前端审核操作）。
- **实施依据**：`docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md` §八 S4、`docs/restructure/00-FINAL-EXECUTION-CHARTER.md` §三2（D1）与 §七指标、`docs/restructure/DATABASE-DESIGN-REVIEW.md` §③④、README 决策登记表 D1/D5/Q10。S3 冻结裁决（TrackContract/PromptVersion/GenerationRun 不实施）未触碰。
- **评分口径（2026-11-14 用户确认）**：每维 0-5 整数（0 完全不符合/明显问题、1 很差、2 较弱需明显改进、3 基本合格、4 良好、5 优秀）；总分=六维**等权合计 0-30**；无权重、无阈值、无低分提示线；评分不替代人工审核、不自动批准；硬性守门优先（被拒收选题不进评分）。

---

## 1. 实际修改文件

| 文件 | 变更 |
|---|---|
| `server/prisma/schema.prisma` | Angle + status/reviewRound/metaJson；enum AngleStatus/TopicVerdict；新表 TopicReview；索引演进 |
| `server/prisma/migrations/20261114093000_add_angle_status_topic_review/migration.sql` | **新增**（人工审查版，见 §2） |
| `server/src/services/topic-review.ts` | **新增**：六维评分（纯函数+批量 LLM 调用）+ 审核状态机 + TopicReview 留痕 |
| `server/src/services/angles.ts` | 扩库进 candidate+评分入库；手动新增进 candidate；改正文评分失效；列表 status 过滤 + sort=score；AngleItem 扩展 |
| `server/src/services/planner.ts` | buildPlan/reserveAnglesForPipeline 只消费 approved（FIFO 不变）；空池提示区分「没题/有题未审」 |
| `server/src/api/routes/angles.ts` | POST /:id/review、GET /:id/reviews；列表 status/sort 参数 |
| `server/src/api/routes/tracks.ts` | 扩库结果文案（进候选+已评条数） |
| `server/scripts/smoke-angles.ts` | 新增 24 断言（19-25 组：评分/状态机/消费/排序/失效） |
| `server/scripts/smoke-isolated.ts` | T0 载体最小适配（详见 §7） |
| `web/src/types.ts` / `web/src/api/index.ts` | AngleStatus/评分/TopicReviewRecord 类型与审核 API |
| `web/src/views/TrackAnglesView.vue` | 审核筛选、评分列（六维弹层）、审核操作、审核记录弹窗、评分排序 |
| `docs/DEVLOG.md` / `CHANGELOG.md` | 进度台账与变更记录（DEVLOG 同批带上前次遗留的 S3 验收条目） |
| `docs/restructure/S4-0-AUDIT-REPORT.md` | S4-0 核查报告（上一阶段唯一产出，本次一并入库） |

## 2. Schema 和 Migration 变化

Migration `20261114093000_add_angle_status_topic_review`（prisma migrate diff 生成后人工整理，剔除与本阶段无关的 `article.contentWechat` 表示法漂移行）：

- `Angle` 加列：`status ENUM('candidate','needs_revision','approved','rejected') NOT NULL DEFAULT 'candidate'`（一切选题进候选，不伪装已审核）、`reviewRound INT NOT NULL DEFAULT 0`、`metaJson JSON NULL`（六维评分依据/风险说明）。
- 索引演进（DATABASE-DESIGN-REVIEW §③ 明示）：`[trackId,used,seq]` → `[trackId,status,seq]`。
- 新表 `TopicReview`（N:1 → Angle，ON DELETE CASCADE）：`id / angleId / round / scoresJson / riskHits / dupHits / verdict ENUM(approved,needs_revision,rejected) / reason VARCHAR(500) / model / reviewedBy / createdAt`；索引 `[angleId,round]`、`[verdict,createdAt]`。
- **与设计文档的差异（如实声明）**：
  - `promptVersionHash / contractVersion` **暂缺**——S3 裁决 PromptVersion/TrackContract 不实施，写入即伪造追溯（决策 C）；相关能力落地后再补列。
  - `reviewedBy`（操作者登录名）为**新增**字段：任务书要求「审核操作可追溯」的最低实现，非审批流/角色机制。
  - `dupHits` 列保留但**恒空**：判重链接入属 S4-2，本阶段不伪造命中数据。

## 3. 六维评分具体实现

- **维度与总分**：fit 定位契合 / scene 具体画面 / conflict 冲突反差 / method 方法落点 / safety 情绪安全 / novelty 差异化；每维 0-5 整数；`total = 六维直接相加`（0-30）。`server/src/services/topic-review.ts` 的 `SCORE_DIMENSIONS/normalizeScores` 是唯一口径。
- **评分时机与调用**：扩库（expandAnglesForTrack）通过硬门禁后、入库前，**批量一次调用判多条**（Q10，≤25 条/批），模型角色=**write**（D5「第一版复用 write 角色」）；temperature 0.2。手动新增不调用模型，如实记「未评分」。
- **结果归属**：`Angle.metaJson` = `{ scores{fit…novelty,total}, scoreSource, scoreModel, scoredAt, riskHits, suggestion, rationale | scoreError }`；人工审核时快照进 `TopicReview.scoresJson`。
- **失败语义**（任务书红线）：模型调用失败/解析失败/任一维缺失或越界 → 该条 `scores=null + scoreError`，**不视为高质量、不自动批准**（所有新选题本就进 candidate，评分从不改变状态）；同批其他条不受影响。
- **不影响硬门禁**：topicRejectReason（正能量守门）在评分之前执行，被拒收的选题不进评分也不入库——评分无法绕过守门。
- **影响排序与参考**：列表 `sort=score` 总分降序、未评分排最后；审核界面展示总分+分维+模型建议（标注「仅供参考，以人工审核为准」）。
- **失效规则**：编辑正文后旧评分清空并标「内容已修改，评分已失效」。

## 4. 状态流转规则

```
status（审核态）：candidate ─┬─ approved ──(used=true 由排产置)──▶ 已消费
                             ├─ needs_revision ─┬─ approved（修改后复审通过）
                             │                  └─ rejected
                             └─ rejected
used（消费态）：独立维度，仅在 approved 后由排产置位
```

- 合法流转：`candidate → approved/needs_revision/rejected`；`needs_revision → approved/needs_revision/rejected`（needs_revision→needs_revision = 修改后复审仍要求改，状态不变、round+1 留新记录）。
- **终态**：approved / rejected 不可再流转（后端 400）。
- 入口唯一：`POST /api/angles/:id/review`（`reviewAngle` 服务，CAS updateMany 防并发双写）；前端不能直接改 status；LLM 的 suggestion 不走此端口。
- 每次审核写一条 TopicReview（round 与 Angle.reviewRound 同步 +1），含 verdict/reason/评分快照/操作人/时间。

## 5. 排产消费限制

- `planner.reserveAnglesForPipeline` 与 `buildPlan` 的取用条件均为 `used=false AND status='approved'`（scope 切片条件不变）；**candidate / needs_revision / rejected 一概不可消费**。
- approved 集合内 `ORDER BY seq ASC`——FIFO 与原排产业务语义不变。
- 消费入口核查：自动调度（scheduler.tick → runPipelineForAccount）与手动触发（POST /api/plan/trigger）都收敛到 reserveAnglesForPipeline，一处过滤全覆盖。
- 角度池为空时提示区分「没有选题」与「有 N 条候选/待修改未审核」。
- 未处理（超出任务书枚举范围，如实声明）：手动指定 angleId 的挂稿/漫画建稿路径不走 reserve、不置 used，未加 approved 校验；如需覆盖请在后续批次确认。

## 6. 测试结果（真实输出）

| 项 | 结果 |
|---|---|
| prisma validate / generate | ✓ / ✓ |
| server `tsc --noEmit` | 0 errors |
| web `vue-tsc --noEmit` ×2 | 0 errors（两遍串行） |
| `smoke:lint` | **116** 通过（不降） |
| `smoke:style` | **41** 通过（不降） |
| `smoke:angles` | **54** 通过 = 原 30 + 新增 24 |
| `verify:smoke-iso` | **10/10** |

新增 24 断言覆盖（smoke-angles 19-25 组，全部跑在隔离 smoke 库，LLM 全 Mock）：
手动新增=candidate/未评分/round0；Mock 扩库 2 条均 candidate、六维合计 22 正确入库、评分越界判失败不自动批准；normalizeScores/parseScoreBatch 纯函数（合法/缺维/越界/批次缺条目）；candidate→approved（round1+操作人）、approved 终态 400、candidate→needs_revision→needs_revision(round2)→rejected(round3)、rejected 终态 400、非法 verdict 400、审核记录 3 条新轮在前含 reason；reserve 只取 approved 且 FIFO（seq 4→11→12）、candidate/needs_revision/rejected 保持 used=false、approved 用尽再取为空；sort=score 有分在前（22 分最前）未评分在后；改正文后评分失效。

对照任务书验收清单：candidate/rejected/needs_revision 不可消费 ✓；approved 可消费 ✓；FIFO 不变 ✓；扩库与手动新增均 candidate ✓；审核记录保存与查询 ✓；评分失败不自动批准 ✓；隔离测试后清理（smoke 库 0 表残留）✓。

## 7. 数据库安全核查结果

- **Migration 只应用到隔离 smoke 库**（`wechat_pipeline_smoke`，run 前重建）；**业务库 `wechat_pipeline` 未执行 migrate deploy / db push / 任何写库**（任务书 §五红线）。
- 业务库实测（只读）：`_prisma_migrations`=3（未登记新迁移）、Angle/Article=0 行、TopicReview 表 absent——**真实业务库指纹不变**（符合验收项）。
- dev.db `fea0f123…`（size 974848）与基线一致；8 个归档备份只读未动（sha256 已记录于会话日志）。
- smoke 库测试数据随 run 清理矩阵清空（run 后 0 表）；smoke:angles 自清理含 TopicReview 级联。
- 他项目库（crm/wechat_publisher/wx_task_pocket 等）零触碰：wpc_app 权限止步三具名库，information_schema 下不可见他库。
- AUTO_PUBLISH=false 未动；无真实微信/LLM 外呼（评分/扩库均 Mock）；`.env` 与账号权限未改。
- **T0 机制改动（smoke-isolated.ts 3 处，如实声明）**：①SMOKE_DROP_ORDER/BUSINESS_TABLES 补 TopicReview（FK 子表在前；表清单是 schema 演进量）②业务库指纹对「表不存在」记 `absent`（业务库迁移未部署期间前后一致即 MATCH，不误报）③verify ①⑨ 空库标记串随 BUSINESS_TABLES 动态（验收语义不变=全部业务表行数 0）。T0 隔离/fail-closed/验收台语义未动。

## 8. Git commit

- 单一独立提交（便于整段回退）：标题 `S4-1: topic scoring and review state machine (Angle.status + TopicReview)`。
- 提交集 = §1 全部文件（含 S4-0 报告、DEVLOG 含前次遗留 S3 验收条目）；提交前已核对 git diff 与工作区，无无关文件混入。
- **SHA**：见 `git log` 首条（会话收尾消息中亦给出）。

## 9. 尚未解决的问题

1. **⚠️ 业务库迁移待授权部署**：`prisma migrate deploy`（`20261114093000_add_angle_status_topic_review`）尚未在 `wechat_pipeline` 执行（任务书规定另行授权）。**部署前**新代码对业务库不可用（Angle 新列/TopicReview 不存在）；部署后即启用。部署即改变业务库指纹，届时按惯例单独记录。
2. promptVersionHash / contractVersion 缺列（S3 裁决所致，非缺陷）；S6 文档收口时在 DATABASE-DESIGN-REVIEW 标注。
3. dupHits 恒空，语义判重/S4-2 接线后才有数据；「标重复」事件（verdict=rejected, reason=dup_*）当前由人工在拒绝原因里填写。
4. 手动指定 angleId 的建稿/挂稿路径未加 approved 校验（§5 声明），是否覆盖待后续批次确认。
5. 评分提示词在 `topic-review.ts` 代码内（审核任务提示词，非写作提示词）；若后续要做提示词版本化，归 S6/PromptVersion 类议题。
6. 手动新增选题不自动评分（无模型调用）；如需「手动补评」入口，待真实使用反馈后定。
7. 业务库部署迁移后，建议把 `dev.db` 存量 33 条的处置（D1「逐条检查后回填」或保持不迁）单独决策——本阶段按任务书不回填、不伪装。

---

**完成 S4-1，停等验收。未进入 S4-2（judgeAngle 去重接线）。**
