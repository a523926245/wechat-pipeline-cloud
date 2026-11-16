# S4-2 统一选题去重机制 · 实施报告

- **日期**：2026-11-15
- **授权**：S4-2 实施指令（本轮只实施 S4-2，未扩大范围）
- **依据**：`RESTRUCTURE-2.0-CONVERGED-PLAN.md`、`00-FINAL-EXECUTION-CHARTER.md`、`docs/restructure/README.md`、`docs/DEVLOG.md`、`S4-2-0-DEDUP-AUDIT-REPORT.md`（问题事实作实施依据）、S4-1-HF1/R1/R2 实施报告及当前代码
- **状态**：**完成，停等人工验收。未执行 Git commit。**

---

## 1. 实际修改文件与目的

| 文件 | 改动 | 目的 |
|---|---|---|
| `server/src/services/dedup.ts` | 重写扩展（147 → 361 行） | 统一判重入口：`checkAngleDup` / `loadDupSnapshot` + `checkDupAgainstSnapshot`（批量路径）；L0/L1/L2 结构化命中 `AngleDupHit`；normalize 全仓唯一（PUNCT 补 `「」『』`）；`judgeAngle` 阈值改引 constants（消双真源）；历史实质正文判定 `stripHtmlText`/`HISTORY_MIN_BODY_CHARS=50`。算法本体（grams/dupScore/sim/jaccard/containment）**未动** |
| `server/src/services/angles.ts` | 三入口接线 | ① `expandAnglesForTrack`：seen 精确集 → 统一快照（跨赛道 + 历史标题 + 批次内互查），L0/L1 跳过 + 逐条 warn 日志，L2 命中随行进 metaJson；② `createAngle`：判重 L0/L1 → 400（detail 带命中明细）、L2 → 保存 + `metaJson.dedupHits` + 返回 `dedupWarnings`；③ `updateAngle`：正文实质变更时**事务内**判重（`excludeId` 排除自身），L0/L1 → 400，L2 → 保存且判重结果整体替换 `dedupHits`（空数组清旧值），spread 保留全部无关元数据；`toItem` 暴露 `dedupHits` |
| `server/src/services/topic-review.ts` | meta 形状 + 快照 | `AngleScoreMeta` 增 `dedupHits?`；`reviewAngle` 把审核时刻 `metaJson.dedupHits` 固化到 `TopicReview.dupHits`（原恒空注释更新）；历史审核记录只增不改 |
| `server/src/api/routes/angles.ts` | 返回文案 | 新增/编辑返回体透传 `dedupWarnings`，message 附「与 N 篇历史文章标题相似（仅提示）」；L0/L1 由服务层 BadRequestError(detail) 直接返回 400 |
| `web/src/types.ts` | 类型 | 新增 `AngleDupHit`；`AngleItem.dedupHits?`、`TopicReviewRecord.dupHits?`、create/update 响应 `dedupWarnings?` |
| `web/src/api/index.ts` | 类型 | createAngle/updateAngle 响应类型补 `dedupWarnings`/`reviewReset` |
| `web/src/views/TrackAnglesView.vue` | 交互 | §5 |
| `server/scripts/smoke-angles.ts` | 测试 | S4-2 用例 41 项断言（§6）；既有夹具 3 处文案调整（§6.3）；清理矩阵补跨赛道测试数据 |
| `docs/DEVLOG.md` | 记录 | 本轮条目 + 指纹基线注记 |

**未触碰**：`server/prisma/`（Schema/Migration）、`constants.ts`（阈值数值零改动，仅被引用）、planner / writer / publisher / 渲染链 / 审核状态机（REVIEW_TRANSITIONS、R1/R2 门禁语义）、`.env`、安全红线（AUTO_PUBLISH=false）。

## 2. L0 / L1 / L2 最终实现规则

| 层 | 判据 | 处置 | 记录 |
|---|---|---|---|
| **L0 完全重复** | 统一 normalize（删空白/标点含「」『』、小写）后完全相同 | 扩库：跳过不入库（skippedDuplicate 计数 + 逐条 warn 日志含命中对象与来源赛道）；手动新增/编辑：**HTTP 400** | 400 `error.detail`=`{level,hits,warnings}`；扩库日志 |
| **L1 高度相似** | `dupScore ≥ SIM_ANGLE(0.45)`（constants 真源，算法含包含率兜底） | 同 L0；同赛道与跨赛道一视同仁 | 命中明细展示相似选题、相似度、来源赛道（trackId+trackName） |
| **L2 历史标题相似** | 与 Article.title 的 `dupScore ≥ SIM_HISTORY(0.35)` | **只提示不拦截**：手动新增/编辑放行；扩库不因 L2 跳过 | 存 `metaJson.dedupHits` + 响应 `dedupWarnings`；审核时固化 `TopicReview.dupHits` |

细则（按裁决逐条落实）：

- 编辑排除自身（`excludeId`），标点变体自比不误判（S42-4）。
- rejected / candidate / needs_revision / approved 全状态参与 L0/L1；used 与否均参与（S42-10）。
- 跨赛道 L0/L1 同等拦截，命中明确展示来源赛道（S42-11）。
- **不按 theme 判重**：同主题不同角度自然放行（实测 0.13~0.20，S42-7/12）；**不实施 theme_crowded**，无主题数量上限。
- 历史范围=**非空标题 + 实质正文**（剥 HTML 后非空白 ≥50 字）的全部 Article，不限推送态；空壳正文不参与（S42-9/13）。
- 命中明细结构（`AngleDupHit`）：`level / sourceType(angle|article) / targetId / targetText / score / trackId / trackName / reason`，L0 优先、同级相似度降序排序（S42-18）。
- `metaJson.dedupHits` 不覆盖其他键（spread 保留 `rescoreWorkflow`/`rescoreRequired`/自定义键，S42-15/16）；正文变更后无命中 → 写空数组清旧值，防旧命中残留（S42-19）；仅改 theme/scope 不重算不清除。
- `judgeAngle` 保留旧严格语义但阈值改引 constants（`SIM_ANGLE/SIM_HISTORY/THEME_CAP` 单一真源）；业务判重一律走 `checkAngleDup`，两处文档注释互相指向，无双实现。

## 3. 三个正式写入入口接入情况

| 入口 | 接线点 | L0/L1 | L2 | 备注 |
|---|---|---|---|---|
| 自动扩库 `expandAnglesForTrack` | 保存前逐条 `checkDupAgainstSnapshot`（快照=跨赛道全状态选题 + 历史标题，一次加载） | 跳过该条，不影响批次其余（S42-1/5） | 保留候选，命中随行进 `metaJson.dedupHits` | 批次内已接受候选进快照互查（原批次内近似互查缺口一并闭合）；原守门/评分/入 candidate 语义不变 |
| 手动新增 `POST /api/angles` → `createAngle` | 写入前 `checkAngleDup` | 400，detail 带命中明细（S42-2） | 201 + `dedupWarnings` + metaJson 记录（S42-8） | 无命中时保持 metaJson 空（不造评分数据，S4-1 语义保留） |
| 手动编辑 `PUT /api/angles/:id` → `updateAngle` | 正文实质变更时**同一事务内**判重（excludeId），CAS 写入前拦截 | 400（S42-3/6） | 200 + 提示 + 判重结果整体替换（S42-17/19） | 判重与写入同事务，无检查-写入分散；HF1 退回/评分失效/R1/R2 双标记逻辑零改动 |

排查确认（S4-2-0 §4.4 复核仍成立）：`prisma.angle.create/createMany/update` 正式写入点仅上述三处 + cli/migrate（历史一次性导入，非业务入口，未接线按指令不扩权）。

## 4. 前端交互结果

- **手动新增/编辑**（`TrackAnglesView.vue`）：
  - L0/L1：保存被拒 → 弹窗**不关闭**，el-alert 展示拦截级别与命中明细（`[L0/L1] 现有选题：内容 · 相似度 N%（赛道：XX）`），配合错误 toast；用户能直接看懂为什么不能保存。
  - L2：保存成功 → toast「已保存；与 N 篇历史文章标题相似（仅提示，不影响保存）：〈标题〉」；服务端 message 同步附提示；**非阻断式**。
- **选题列表**：审核列增加「去重」标签（有 `dedupHits` 才显示），悬停 popover 列出全部命中（级别/对象/相似度/来源赛道）。
- **审核记录**：每轮记录下方展示 `TopicReview.dupHits` 快照明细（历史记录不随后续重判变化）。
- 未新增筛选系统、未做全局改版；类型与 API 映射同步（`types.ts` / `api/index.ts`）。

## 5. 测试用例与结果

全部跑在隔离测试库（smoke-isolated：固定 `_wechat_pipeline_smoke` 库，run 前重建/后清空；真实库前后指纹断言）。**未向真实业务库写入任何测试数据。**

### 5.1 实施指令第六节 20 项覆盖对照

| # | 要求 | 用例（smoke-angles） | 结果 |
|---|---|---|---|
| 1 | L0 扩库跳过 | S42-1（标点变体归一化同文，skippedDuplicate=1） | PASS |
| 2 | L0 手动新增 400 | S42-2（含命中对象 id/内容/相似度 1/来源赛道断言） | PASS |
| 3 | L0 手动编辑 400 | S42-3 | PASS |
| 4 | 编辑排除自身 | S42-4（标点变体自比不误判） | PASS |
| 5 | L1≥0.45 扩库跳过 | S42-5（0.83） | PASS |
| 6 | L1 手动新增/编辑 400 | S42-6（新增+编辑，断言 score≥0.45 与来源赛道） | PASS |
| 7 | L1 未达阈值允许保存 | S42-12（0.20 放行） | PASS |
| 8 | L2≥0.35 只提示允许保存 | S42-8（201+dedupWarnings+metaJson.dedupHits） | PASS |
| 9 | L2 不达阈值正常保存 | S42-9 | PASS |
| 10 | rejected 参与 L0/L1 | S42-10（审核拒绝后再新增同文 → 400） | PASS |
| 11 | 跨赛道 L0/L1 拦截 | S42-11（L0+L1 双路径，断言来源赛道=trackB） | PASS |
| 12 | 同主题不同角度不误伤 | S42-7/12（同 theme 两条均 201） | PASS |
| 13 | 历史范围正确、非实质正文不参与 | S42-9/13（空壳正文 H2 标题相似 0.85 仍无提示；实质正文 H1 命中） | PASS |
| 14 | 同义改写/扩写/标点归一化边界 | S42-14a（删标点洗稿→L0）/14b（同义 0.71→L1）/14c（扩写 0.75→L1） | PASS |
| 15 | 编辑不覆盖原有 metaJson | S42-15（自定义键/riskHits 保留） | PASS |
| 16 | HF1 双标记不受去重写入影响 | S42-15/16（rescoreWorkflow/rescoreRequired 保留） | PASS |
| 17 | TopicReview.dupHits 审核快照 | S42-17（快照固化 + 后续重判不改写历史记录） | PASS |
| 18 | 多命中明细完整排序合理 | S42-18（双命中含 A0/A1，相似度降序） | PASS |
| 19 | 无命中旧信息不残留 | S42-19（dedupHits 清空为空数组） | PASS |
| 20 | 原有 S4-1/HF1/R1/R2 测试全过 | 既有 134 项断言原样回归（§5.3） | PASS |

### 5.2 执行结果汇总（2026-11-15 真实输出）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（server） | 0 错误 |
| `npx vue-tsc --noEmit` ×2（web，串行两遍） | 0 错误 |
| `npm run smoke:angles` | **ALL PASS（175 项）**＝旧 134 + S4-2 41；`REAL-DB FINGERPRINT MATCH` |
| `npm run smoke:lint` | 通过 116 项；`REAL-DB FINGERPRINT MATCH` |
| `npm run smoke:style` | 全部通过（41 项断言）；`REAL-DB FINGERPRINT MATCH` |
| `npm run verify:smoke-iso` | **10/10**（含 ⑦ 真实库前后指纹一致、⑧ 五条退出路径清理、⑥ 四连） |

### 5.3 原有回归与夹具调整说明

S4-1/HF1/R1/R2 全部断言（列表/CRUD/扩库评分/状态机/终态/approved-only 消费/FIFO/挂稿门禁/RACE1-3 竞态不变量/R2 重评生命周期）**原样通过，断言零删改**。仅 3 处夹具文案调整（语义不变）：

1. 旧用例 7 的 c2「手动新增的第二条选题」与 c1 dupScore=0.64 → 新规则下会被 L1 正确拦掉，与「再新增一条」的用例语义冲突 → 改为内容独立的「整理书包时翻出孩子藏起来的数学试卷」（断言 seq/code/used 不变）。
2. RACE3 五轮夹具模板只差轮次号（跨行 0.82，互相撞 L1），掩盖并发不变量本身 → 改为五组独立场景文案（不变量断言原样）。
3. 新增 S42-11 自身首版用例误把已入库 X2 再 POST（测成 L0），修正为 X3 近似串测跨赛道 L1（属本轮新用例修正）。

## 6. 真实业务库零写入证明

- 每轮隔离运行结束均输出 `REAL-DB FINGERPRINT MATCH（真实库零写入）`：smoke-isolated 在 run 前后对业务库 15 张业务表 + `_prisma_migrations` 做 COUNT+CHECKSUM 指纹比对，本轮 7 次运行（angles×3、lint×2、style×1、verify×1）**全部 MATCH**。
- `verify:smoke-iso` ⑦ 前后指纹一致：**business sha256=`723a80277fd9e65608d190793a241926e33d2e249b1f7c1b21a2f99d19a066f3`**、dev.db=`fea0f123…`（与归档基线一致，文件未触碰）。
- 本轮所有数据库触碰仅两类：① 隔离库（`_wechat_pipeline_smoke`）写入与清空；② 对业务库的**只读**核查（information_schema / SELECT COUNT / 迁移记录读取）。零 db push / migrate / 写 API 外呼；测试与扩库评分全部 Mock 注入，零 LLM/微信调用；AUTO_PUBLISH 未动。
- **指纹基线注记（如实登记）**：当前业务库指纹与 HF1 报告记录的 `438f1d28…` 不同。只读核查显示差异来自**本轮之外的用户正常使用**（setting 15 行、styleprompt 44 行、user 1、usersession 1 行；`_prisma_migrations` 4 行=1 条已回滚 init + 3 条成功迁移，均为 2026-11-13/14 既有部署史），不是本轮所致——本轮每轮运行前后指纹一致即是零写入证明。建议以 `723a8027…` 重立基线。
- 隔离库证据：每次 run `ISO-CREATE 重建（schema-only，零行数据）` + `CLEANUP ok`，SIGKILL 残留路径由 verify ⑧ 验证可恢复。

## 7. Schema / Migration 零变化证明

`git diff --name-only -- server/prisma` → **0 个文件**。`server/prisma/schema.prisma` 与 `server/prisma/migrations/` 与 HEAD 完全一致（本轮无新增字段/表/索引/迁移）。去重载体全部复用既有列：`Angle.metaJson`（DATABASE-DESIGN-REVIEW §③ 预留「判重结果」）、`TopicReview.dupHits`（S4-1 建表注释预留）。

## 8. Git 工作区状态（按令未 commit，既有修改全保留）

`git status --porcelain`：

```
 M docs/DEVLOG.md                       （HF1/R1/R2 记录 + 本轮 S4-2 记录）
 M server/scripts/smoke-angles.ts       （HF1/R1/R2 测试 + 本轮 S4-2 测试与夹具调整）
 M server/src/api/routes/angles.ts      （HF1 退回提示 + 本轮 L2 提示文案）
 M server/src/services/angles.ts        （HF1/R1/R2 修复 + 本轮三入口判重接线）
 M server/src/services/dedup.ts         （本轮：统一判重入口）
 M server/src/services/topic-review.ts  （R1/R2 门禁 + 本轮 dupHits 快照）
 M web/src/api/index.ts                 （本轮类型同步）
 M web/src/types.ts                     （本轮类型同步）
 M web/src/views/TrackAnglesView.vue    （R1 重评按钮 + 本轮去重交互）
?? docs/restructure/S4-1-HF1-IMPLEMENTATION-REPORT.md   （保留）
?? docs/restructure/S4-1-HF1-R1-IMPLEMENTATION-REPORT.md（保留）
?? docs/restructure/S4-1-HF1-R2-IMPLEMENTATION-REPORT.md（保留）
?? docs/restructure/S4-1-MIGRATION-DEPLOY-REPORT.md     （保留）
?? docs/restructure/S4-1-PRE-MIGRATION-CHECK-REPORT.md  （保留）
?? docs/restructure/S4-2-0-DEDUP-AUDIT-REPORT.md        （保留）
?? docs/restructure/S4-2-IMPLEMENTATION-REPORT.md       （本报告）
```

`git diff --stat`（累计含 HF1/R1/R2 三轮未提交修改）：

```
 docs/DEVLOG.md                      |   34 ++
 server/scripts/smoke-angles.ts      |  916 +++++++…
 server/src/api/routes/angles.ts     |   36 +-
 server/src/services/angles.ts       |  355 ++++…
 server/src/services/dedup.ts        |  237 ++++…
 server/src/services/topic-review.ts |   86 ++-
 web/src/api/index.ts                |   15 +-
 web/src/types.ts                    |   24 +
 web/src/views/TrackAnglesView.vue   |  150 ++-…
 9 files changed, 1777 insertions(+), 76 deletions(-)
```

（stat 为写报告时点；DEVLOG/报告追加后行数略有增长。）未执行 reset/checkout/任何覆盖性操作；未 commit。

## 9. 尚存边界与未解决问题

1. **主题级换皮仍是词面盲区**（S4-2-0 §7 M1/M2/M3，实测 0.000~0.438）：跨赛道「孩子锁门 vs 下属锁门」这类换皮题 L1 也可能擦边漏（0.438 vs 0.45）。本轮按裁决收窄而非消灭重复，兜底=人工审核（S4-1）；语义层判重不在本轮范围。
2. **并发双扩库 TOCTOU**：两次扩库并发时快照时差理论上可双双入库（单管理员场景低概率）；如需堵可加同赛道串行锁（constants 已有 LOCK_* 设施），本轮未做。
3. **SIM_HISTORY=0.35 外推风险**：数字型/套话标题（「N 个…第 3 个最…」）可能抬分；L2 已按裁决只提示不拦截，建议真实数据上观察一段时间再决定是否调阈值。
4. **编辑 approved 的审核态绕过已由 HF1/R1/R2 封闭**（本轮验证不受去重写入影响，S42-15/16）；残留边界见 R2 报告 §10（伪造高分+清标记可过门禁，人工终审兜底，不在本轮处置）。
5. **L2 对超长正文的跨文体比较**：判重对象是选题内容（20~60 字）vs 文章标题；不比正文，长文内部复用标题的情况不在 L2 范围。
6. **cli/migrate 历史导入器未接判重**：一次性离线工具，非正式入口（S4-2-0 §4.4 口径），是否接入留 S4-7 遗留入口清理时定。
7. **`judgeAngle` 旧函数保留**（零业务调用，阈值已单源化）：删除/收敛属 S4-7 范围，本轮不扩权。

## 10. 验收清单（供人工核对）

- [ ] L0/L1 拦截文案与命中明细可读（弹窗示例：`[L1] 现有选题：… · 相似度 83%（赛道：…）`）
- [ ] L2 保存后提示历史标题、列表「去重」标签与审核快照显示正常
- [ ] `npm run smoke:angles` / `smoke:lint` / `smoke:style` / `verify:smoke-iso` 复跑可过
- [ ] 真实库指纹以 `723a8027…` 重立基线（见 §6 注记）
- [ ] 确认后决定 Git 提交策略（本轮与 HF1/R1/R2 修改同在工作区，未擅自 commit）

**S4-2 实施完成，按令停止，等待人工验收。未开始 S4-3，未执行任何 Git commit。**
