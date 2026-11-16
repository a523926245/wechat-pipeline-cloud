# S4-2-0 选题去重机制现状核查报告

- **日期**：2026-11-14
- **性质**：只读核查（S4-2 实施前现状调查）。未修改任何业务代码 / Schema / Migration / 配置 / `.env`；未写真实业务库；未执行 db push / migrate / LLM / 微信调用；未进入 S4-2 实施。
- **数据源**：① 本机代码（server/src、web/src、server/prisma/schema.prisma、server/scripts）② 归档 `server/prisma/dev.db` 的**临时副本**（只读查询：Angle 33 / Article 12 / Track 6，原文件未触碰）③ 纯内存构造用例（导入真实 `dedup.ts` 运行，未复制算法实现）④ 既有文档（S4-0-AUDIT-REPORT、S4-1-IMPLEMENTATION-REPORT、00-FINAL-EXECUTION-CHARTER、DATABASE-DESIGN-REVIEW、DEVLOG）。
- **结论分级**：`【事实】`=代码/数据实证 ｜ `【样本】`=基于 33 选题 / 12 文章小样本或构造用例的验证结果 ｜ `【推断】`=未验证推断 ｜ `【待决策】`=需用户裁决。
- **基线**：RESTRUCTURE-2.0-CONVERGED-PLAN（S4=选题质量·六维评分/去重链轻量版 + 创作链路 + 审核流程）；00-FINAL-EXECUTION-CHARTER（「语义去重失败时，候选可以保留，但不得自动升格」；指标② 选题重复率的数据源=TopicReview.dupHits + 守门日志）；S4-1 已验收（Angle.status + TopicReview + 六维评分已上线，dupHits 列预留恒空）。

---

## 1. 现有去重代码结构

### 1.1 涉及文件总览

| 文件 | 角色 | 是否接入正式链路 |
|---|---|---|
| `server/src/services/dedup.ts`（147 行） | 近似判重算法库（Python add_angles.py 移植） | **部分**：仅 `dupScore` 被 cli/migrate.ts 引用；`judgeAngle`/`sim`/`nextCode` 零调用 |
| `server/src/services/angles.ts:78-86`（局部 `normalize`） | 扩库入库前的**归一化精确**去重 | **是**（扩库唯一生效判重） |
| `server/src/cli/migrate.ts:26,188` | 历史数据迁移 CLI，`dupScore` 用于「文章缺 angle_ref 时的多候选消歧」 | 离线一次性工具，非业务链路 |
| `server/src/constants.ts:129-136` | 阈值真源 `SIM_ANGLE=0.45 / SIM_HISTORY=0.35 / THEME_CAP=8 / MIN_GRAMS_FOR_CONTAINMENT=8 / CONTAINMENT_PENALTY=0.15`（注释：与本机 add_angles.py 保持一致，改动需同步） | 是（部分被 dedup.ts 引用） |

### 1.2 dedup.ts 函数清单（逐个）

| 函数 | 职责 | 输入 → 输出 | 判重规则 | 实际调用处 |
|---|---|---|---|---|
| `normalize(s)` | 文本归一化 | string → string | 删全部空白与标点（PUNCT 正则）、小写 | 仅 dedup.ts 内部（导出无外部调用方） |
| `grams(s, n=2)` | 中文 bigram 集合 | string → Set\<string\> | Unicode 码点切片（与 Python 字符语义一致） | dedup.ts 内部 |
| `dupScore(a,b)` | 综合相似分 | 两串 → 0~1 | `max(Jaccard, containment−0.15)`；较短一方 bigram 数 <8 时只用 Jaccard | **migrate.ts:188**（消歧）、judgeAngle 内部 |
| `sim(a,b)` | 纯 Jaccard | 两串 → 0~1 | 原始指标 | **零调用**（注释：留给需要原始指标的场合） |
| `judgeAngle(...)` | 三层判重裁决 | 见 §2 | L1 与现有选题比 `dupScore≥simAngle(0.45)` → `dup_angle`；L2 与历史标题比 `≥simHistory(0.35)` → `dup_history`；L3 同 theme 未用数 `≥themeCap(8)` → `theme_crowded`；返回 `DedupVerdict{ok,reason,hit,score}` | **零调用** |
| `nextCode(existing, track)` | 生成角度编码 | string[] → string | 现有最大数字编号 +1 | **零调用** |

### 1.3 两套 normalize 并存（重复实现，语义不同）`【事实】`

| 归一化行为 | `angles.ts` normalize（**live**，扩库精确去重用） | `dedup.ts` normalize（judgeAngle/dupScore 用） |
|---|---|---|
| 删空白 | ✅ | ✅ |
| 全角→半角 | ✅（`！-～` 区间） | —（标点直接删除） |
| 引号 `“”「」『』` | 统一为 `"` | `“”‘’` 删除；**`「」『』` 不在 PUNCT 类**（残留） |
| `，、；` | 统一为 `,` | 删除 |
| `。．` | 统一为 `.` | 删除 |
| `？！：` 等其余标点 | 全角转半角后**保留** | 删除 |
| 小写 | ✅ | ✅ |
| 判定语义 | 归一化后**精确相等**才判重 | 归一化后精确相等（更粗），供 bigram 计算 |

**影响**：live 精确去重拦得住「全半角/引号样式/空白洗稿」，拦不住「删标点洗稿」（实测见 §6）；dedup.ts normalize 反之能覆盖删标点，但 `「」` 边界有小缺口。两者互不知晓（S4-0 已指出「两套去重并存」，此处补充语义差异表）。

### 1.4 阈值双真源（小瑕疵）`【事实】`

`constants.ts` 定义了 `SIM_ANGLE/SIM_HISTORY/THEME_CAP`（注释明示是与 Python 蓝本同步的真源），但 `judgeAngle` 的默认值是**硬编码** `0.45/0.35/8`（dedup.ts:99-101），只从 constants 引了 `CONTAINMENT_PENALTY/MIN_GRAMS_FOR_CONTAINMENT`。数值当前恰好一致，但改 constants 不会影响 judgeAngle 默认行为。

---

## 2. judgeAngle 完整调用链和未接入原因

### 2.1 调用链

```
judgeAngle  →  （全仓 grep：零调用方）
  ├─ 无 API 路由调用
  ├─ 无服务调用（expandAnglesForTrack / createAngle / updateAngle 均不经过）
  ├─ 无脚本/测试调用（smoke-angles.ts 无判重用例）
  └─ 仅文档引用（AUDIT-REPORT / S4-0 / RESTRUCTURE-CHECKLIST 等把它列为「待复活」）
```

`dupScore` 的唯一业务调用是 `cli/migrate.ts:188`：迁移历史数据时，某文章缺 `angle_ref` 且同天同账号有多条候选角度，用 `dupScore(文章标题+摘要, 角度文本+theme)` 取最高分消歧——这是**相似度检索**用法，不是判重拒绝用法。`【事实】`

### 2.2 未接入原因分析

`【推断】`（依据 DEVLOG 时间线与代码注释）：dedup.ts 是早期从 Python `add_angles.py` 移植的「观点层去重」库（DEVLOG:19），面向离线批量导题场景（migrate/脚本）。后来补建 `expandAnglesForTrack` 在线扩库链路时，只内联了一个轻量 `normalize` 精确比对（注释仅承诺「生成后做归一化比对，重复的直接丢弃」），judgeAngle 从未被接到任何写入口。docs/AUDIT-REPORT 与 RESTRUCTURE-CHECKLIST 早已把它登记为「S4-2 复活」对象——即**有意保留、待接线**，而非无用抽象。

### 2.3 保留价值评估

不因「没被调用」而删除。样本实测（§6）：judgeAngle 的三层对它的设计目标有效——同义改写（0.537 拦）、语序微调+扩写（0.745 拦）、复用/换皮历史标题（0.85/0.60 拦）、同 theme 堆积上限（正确触发），且 33 条样本回放**零误伤**。三层输入结构（existing 列表 / historyTitles / theme+used）与现行 Angle 模型 + Article.title 可直接映射。**结论：可直接复用（文本层），不必重写。**`【样本】`

但必须明确其能力边界：对「同题换皮 / 跨赛道主题撞车 / 主题级近似」**原理性无效**（§6/§7 实测 0.000~0.438），这不是调参能解决的（阈值降到 0.30 依旧零命中）。

---

## 3. 自动扩库去重链路（S4-1 后现行版本）

### 3.1 完整链路（行号为现状）

```
TrackAnglesView「AI 扩库」→ POST /api/tracks/:id/expand（tracks.ts:270）
→ expandAnglesForTrack(trackId, count, seed, scope)（angles.ts:347）
  ① track 校验 + assertRoleUsable('expand_angles')（:356-366）
  ② 判重快照：angle.findMany({where:{trackId}, orderBy:{seq:'desc'}, take:500})（:371-377）
     seen = Set(normalize(content))          ← 去重集合（angles.ts 本地 normalize）
     全切片互查（注释 :370「跨切片也不该出现字面重复」）
  ③ 避让清单：visibleScopes 过滤 + ≤FEEDBACK_LIMIT(50) 条喂给模型（:380-384）
  ④ buildMessages（创作总纲+选题补充+scopeBrief+星座规则+避让清单）→ chatComplete（:389-392）
  ⑤ extractJsonArray 解析候选（:394）
  ⑥ 逐条过滤（:413-439）：
     a. topicRejectReason 硬门禁 → skippedOffensive++（**有**逐条 warn 日志）
     b. normalize(content) 与 seen 精确比对 → skippedDuplicate++（**无**逐条日志，静默丢弃）
     c. seen.add(key)（批次内精确互查）
     d. 进 rows，status='candidate'
  ⑦ 六维评分 scoreAngleCandidates（:444-458，在去重之后、保存之前）
  ⑧ prisma.angle.createMany({data})（:459）—— 保存在判重**之后**
```

### 3.2 针对任务问题的直接回答

| 问题 | 回答 | 依据 |
|---|---|---|
| 去重发生在哪个环节 | 保存前、守门后、评分前（⑥b） | `【事实】` :413-439 |
| 是否在保存 Angle 之前判重 | 是。先判重攒 rows，最后一次 createMany | `【事实】` :459 |
| 是否可能先保存再判重 | 不可能（当前实现）；createMany 失败则整批不入 | `【事实】` |
| 重复选题进入候选池的路径 | ① 近似改写/换皮（精确比对拦不住）② 跨赛道同题（快照只查本赛道）③ 赛道内 >500 条时更旧条目逃逸快照 ④ 并发两次扩库 TOCTOU（两次快照一致→双双入库） | ①②`【事实】` ③`【事实】`（take:500） ④`【推断】`（单管理员场景低概率） |
| 去重失败（命中）如何处理 | 静默丢弃 + `skippedDuplicate` 计数返回 + 汇总日志；被丢弃的原文不留痕 | `【事实】` :423-426、:469-472 |
| 扩库批次内部是否会出现重复 | 精确归一化重复：会拦（seen 递增）。近似重复：**会**进入候选池（批次内无近似互查） | `【事实】`+`【样本】` |

---

## 4. 手动新增、编辑去重链路

### 4.1 API 与服务

| 入口 | 路由 | 服务 | 判重 | 守门 | 写入 |
|---|---|---|---|---|---|
| 手动新增 | `POST /api/angles`（angles.ts 路由 :102） | `createAngle`（services/angles.ts:819） | **无** | **无**（不过 topicRejectReason） | status='candidate'，seq=max+1，code 随机重试 3 次 |
| 手动编辑 | `PUT /api/angles/:id`（:163） | `updateAngle`（:853） | **无** | **无** | 只改 theme/content/scope；改 content 时旧评分置空标「评分已失效」 |
| 范围调整 | `updateAngle`（scope 字段） | 同上 | 不适用（不动正文） | — | 仅改切片 |

### 4.2 前端调用链

`web/src/views/TrackAnglesView.vue`：`submitForm()`（:311-345）→ `createAngle/updateAngle`（web/src/api/index.ts:151-154）。表单只做非空校验，**无任何客户端查重**。`【事实】`

### 4.3 针对任务问题的直接回答

| 问题 | 回答 |
|---|---|
| 手动新增是否重复检测 | **否**。可任意创建与现有完全相同的选题（含与已 approved/已用选题重复）`【事实】` |
| 手动编辑是否可能改成重复主题 | **是**。content 可任意改成与他条相同/近似，无校验 `【事实】` |
| 新增与编辑是否同一判重逻辑 | 都没有判重；扩库用的 normalize 也不经过它们 |
| 编辑是否可能破坏已有选题质量 | **是，且有独立风险点**：① 内容可改成任意质量（不过守门）② **改 content 不重置 status**——approved 选题（终态）被编辑后仍保持 approved、仍可被排产消费，新内容**绕过审核**（状态机 approved→[] 无法回退）③ 编辑 needs_revision/candidate 的内容后仍停留原状态，审核轮数不因内容变化递增。①②③ 均为 `【事实】`（updateAngle :853-880 只写 theme/content/scope/metaJson 评分失效；REVIEW_TRANSITIONS approved 为终态） |

### 4.4 其他写入入口排查

`【事实】` 全仓 `prisma.angle.create/createMany/update` 写入点仅：
1. `services/angles.ts`（expand/create/update/release/reassign/delete——正式链路）
2. `cli/migrate.ts:470-473`（历史一次性导入，按 `code` upsert 幂等，不做内容判重）
3. `server/scripts/`（smoke-angles、smoke-bulk-delete、demo-write、prune-old-style）——测试/维护脚本，非正式入口。

**不存在绕过 API 的正式写入入口。**

---

## 5. 当前重复判断的数据范围

### 5.1 现状（live 扩库）`【事实】`

- **赛道**：仅同 `trackId`（`where:{trackId}`）；**跨赛道不查**。
- **状态**：不过滤 status——candidate / needs_revision / approved / rejected 全部参与 seen 集合（即被拒选题也会挡住新重复）。
- **消费态**：不过滤 used——已用（已产文）选题照拦（合理：防止同题重写）。
- **容量**：`take:500` 按 seq desc（更旧的 >500 条逃逸）。
- **切片**：全 scope 互查（注释明确为有意设计）。
- **历史标题**：不查。
- **judgeAngle 三层语义**（若接入）：L1/L2 不区分 used/status；L3 theme_crowded 只数 `theme===theme && !used`。

### 5.2 消费侧现状（对照）

排产取用 = `used=false AND status='approved'` + scope 切片（planner.ts:282）；创作入口有 `assertAngleApproved` 守卫（topic-review.ts:327）。**candidate/needs_revision/rejected 一概不可消费**（S4-1 上线）。因此「重复候选」即便漏入候选池，也不会自动成为稿件——人工审核（S4-1）是最后一道闸。

### 5.3 候选规则与影响分析（供裁决，不代决策）

| # | 规则候选 | 若纳入判重范围 | 若排除 | 建议倾向 |
|---|---|---|---|---|
| R1 | approved 选题 | 必须拦（正式资产） | 会造成同题双候选 | 纳入（无争议） |
| R2 | used=true（已产文） | 拦住「同题重写」（含 pushed 后删除的孤儿角度） | 已发过的内容可能重现 | 纳入（无争议） |
| R3 | candidate | 拦住候选池内部重复堆积 | 重复候选浪费审核时间 | 纳入 |
| R4 | needs_revision | 同上；且它可能被编辑改写，语义会漂移 | 改写后判重基线失真 | 纳入（改写后重算即可）`【待决策】` |
| R5 | rejected | 同题/换皮题重现可被拦（rejected≠题不存在） | rejected 若因「本主题不要」而拒，会挡住合法再生成；或因质量差被拒，主题仍可用 | **`【待决策】`**（两可：可折中「L0/L1 照拦，L2 不因 rejected 提示」） |
| R6 | 历史文章标题（history 层） | 拦「写过的主题再来一遍」；样本验证有效（含标题 0.85/换皮 0.60） | 无 | 纳入（范围取全部标题还是仅已推/已产，`【待决策】`） |
| R7 | 跨赛道 | 精确洗稿可拦（L0/L1）；提示可减少撞题 | 词面算法对换皮无效，拦截收益有限但精确层无成本 | L0/L1 同等拦 + 跨赛道命中**标注来源赛道**；主题级换皮交人工审核 `【待决策】`（拦 vs 仅提示） |
| R8 | 本条自身（编辑场景） | 必须排除自身 id，否则自比 1.0 误杀 | — | 无争议 |

**结论**：不要自行决定「哪些状态可以忽略」——上表为影响面清单；R5/R6 范围/R7 处置需用户拍板。

---

## 6. 历史样本验证结果

**方法**：`dev.db` 复制到临时目录后 `readOnly` 打开（原归档文件未触碰）；算法为**动态导入真实 `dedup.ts`**（非复刻）；33 选题 / 12 文章标题 / 6 赛道全量回放 + 纯内存构造用例。脚本位于系统临时目录（`%TEMP%/s420-dedup-audit/`），不属业务代码。

### 6.1 33 条样本全量两两比对 `【样本】`

- 528 个对的 `dupScore` **全部 < 0.12**（含 S4-0 已知的 2 组主题近似对）。
- **live 精确去重 0 命中；judgeAngle 全层 0 命中**（同赛道池 / 全赛道池两个回放口径均如此）；阈值扫描 0.30~0.50 全部 0 命中。
- 无任何误判（0.35 的 history 层在 33×12 全交叉上无 ≥0.25 的对）。
- theme 分布：33 条 theme 互不相同 → theme_crowded 层在样本上无感。

### 6.2 已知主题近似对（S4-0 §6f 提及）精确分 `【样本】`

| 对 | 内容摘要 | dupScore | live 判重 | judgeAngle(0.45) |
|---|---|---|---|---|
| #1174↔#1210（育儿↔激励） | 孩子锁门拒沟通/破冰话术 | **0.028** | 漏 | 漏 |
| #1204↔#1212（职场↔激励） | 领导甩锅/同事甩锅 | **0.000** | 漏 | 漏 |
| #1202↔#1210（教育↔激励） | 孩子躲房间哭/锁门拒交流 | 0.014 | 漏 | 漏 |

词面 bigram 对「换了主语与措辞的同主题」原理性失明——**接线 judgeAngle 也救不了这两组**。

### 6.3 构造用例（纯内存）`【样本】`

| 用例 | dupScore | live 精确 | judgeAngle(0.45) | 评价 |
|---|---|---|---|---|
| 同义改写（代码注释经典对：「一不如意就躺在地上」vs「往地上一躺」） | 0.537 | 漏 | **拦 ✓** | 校准有效（注释所称 0.41→含包含率兜底后 0.537） |
| 语序微调+扩写 | 0.745 | 漏 | **拦 ✓** | 有效 |
| 纯标点样式洗稿（？↔?） | 1.000 | **拦 ✓** | 拦 | live 有效 |
| **删标点洗稿**（删逗号/删全部标点） | 1.000 | **漏** | 拦 | live 精确去重的真实缺口 |
| 引号样式互换（“”↔「」） | 0.650 | **拦 ✓** | 拦 | live 有效；注意 dedup.ts normalize 因 PUNCT 不含「」反而判不相等（靠分数兜住） |
| **跨赛道同题换皮**（孩子锁门 vs 下属锁门，模拟 S4-0 漏判模式） | **0.438** | 漏 | **漏（差 0.012）** | 阈值边界；调到 0.40 才拦 |
| 同主题不同切入（考试失利安慰 vs 满分骄傲引导） | 0.108 | 漏 | 放行 ✓ | 不误伤 |
| 同主题不同切入（睡前故事边界 vs 分床过渡） | 0.071 | 漏 | 放行 ✓ | 不误伤 |

### 6.4 其他层行为验证 `【样本】`

- **theme_crowded**：同 theme 未用 8 条 → 拦（`theme_crowded`）；7 条 → 放；8 条但全 used → 放。行为与注释一致。
- **history 层**：新角度**包含**历史标题（#764「都说狮子死要面子…」）→ `dup_history` 0.85 拦；**换皮**历史标题（「都说狮子座死要面子…把汤都喝完了」）→ 0.60 拦。防「把发过的题换个说法再写」有效。

### 6.5 样本验证总结论

1. judgeAngle 三层对**洗稿/改写/复用历史标题/主题堆积**有效，对**同主题不同角度**不误伤（0.07~0.11，远低于阈值）。`【样本】`
2. **主题级/跨赛道换皮**是词面算法的能力盲区（0.000~0.438），S4-2 轻量版接线 judgeAngle **解决不了**这部分——只能靠人工审核（S4-1 已有）把关或未来的语义层（不在本轮范围）。`【样本】`
3. 33 条样本上零误判，但样本量小；simHistory=0.35 是「角度(20~60字) vs 标题(~20字)」跨文体比较，外推到长标题/数字标题形态需保留观察。`【样本】`

---

## 7. 漏判和误判案例

### 7.1 漏判（现状 live 全漏；judgeAngle 接线后仍漏的标注 ✓/✗）

| # | 案例 | 分数 | live | judgeAngle 接线后 | 性质 |
|---|---|---|---|---|---|
| M1 | #1174/#1210 孩子锁门拒沟通（跨赛道） | 0.028 | 漏 | **仍漏 ✗** | 主题级换皮，词面盲区 |
| M2 | #1204/#1212 甩锅（跨赛道） | 0.000 | 漏 | **仍漏 ✗** | 同上 |
| M3 | 构造：跨赛道换皮（孩子↔下属锁门） | 0.438 | 漏 | **仍漏 ✗**（0.45 阈值差 0.012） | 阈值边界 |
| M4 | 构造：删标点洗稿 | 1.000 | 漏 | 可拦 ✓ | live normalize 缺口 |
| M5 | 构造：同义改写/语序扩写 | 0.54~0.75 | 漏 | 可拦 ✓ | judgeAngle 目标场景 |
| M6 | 手动新增/编辑任意重复 | — | 漏 | 需接线到 create/update ✓ | 链路缺口 |
| M7 | 编辑 approved 选题改内容（含改成重复/劣质） | — | 漏 | 判重接线只挡重复；**审核态绕过是独立缺口** | 见 §4.3 |

### 7.2 误判

实测**未发现误判**：同主题不同角度用例 0.071/0.108 放行；33×12 history 全交叉零命中。`【样本】`
潜在风险（未证实）`【推断】`：simHistory 0.35 若作用于含大量数字/套话的标题（如「N 个…第 3 个最…」），短文本偶然重合可能上抬；建议接线后初期以「提示」形态观察。

---

## 8. 建议的去重规则（分析，不实施、不定阈值）

### 8.1 三层两级处置（推荐框架）

| 层 | 判据 | 处置：明确重复 | 处置：高度相似 | 处置：角度不同 |
|---|---|---|---|---|
| L0 归一化精确 | 归一化后相等（建议以 dedup.ts normalize 为基线，补 `「」『』`，或两套合一） | **阻止**（扩库=丢弃+计数；手动=400 拒绝，附命中明细） | — | — |
| L1 词面近似 | `dupScore ≥ SIM_ANGLE(0.45)` | **阻止**（同上） | — | — |
| L2 高相似 | `SIM_HISTORY(0.35) ≤ dupScore < 0.45`，或 history 层命中 | — | **放行进候选 + 提示人工**（记 `metaJson.dedupHits`，审核界面展示；符合 charter「不得自动升格」） | — |
| L3 堆积 | 同 theme 未用 ≥ THEME_CAP(8) | — | 提示（不建议硬拦，除非用户拍板） | — |

- **主题相近但角度不同**：分数实测 0.07~0.11，各层都不触发，**自然放行**——不需要额外「保角度」机制。
- **主题级换皮（M1/M2/M3）**：词面层无解。最小方案的兜底=**人工审核**（S4-1 已有）+ 可选「同 theme 新候选聚合展示」辅助人眼比对；语义层（embedding/LLM 判重）**不建议本轮引入**（为理论规模加复杂度，违反最小改造原则；charter 允许语义去重失败时候选保留）。

### 8.2 处置方式评估（任务 §三.6）

- 明确重复 → 阻止进入候选池：扩库已如此（保持）；手动路径建议 400+命中明细（是否允许 force 覆盖：`【待决策】`）。
- 高度相似 → 提示人工判断：不新增表、不拦保存，`metaJson.dedupHits`（DATABASE-DESIGN-REVIEW §③ 明文预留「判重结果」）+ 审核时快照 `TopicReview.dupHits`（列已存在恒空，设计注释即为 S4-2 预留）。
- 主题相近角度不同 → 放行：阈值行为已验证。
- **不必**引入相似度模型 / 向量库 / 新表。指标②（选题重复率）可由 `ExpandResult.skippedDuplicate` 计数 + `TopicReview` 中 `reason` 含 dup_* 的拒绝数 / 候选总数 出数（charter 口径）。

---

## 9. 最小改造方案（建议，待批准后实施）

### 9.1 S4-2 九问直答

| # | 问题 | 答案 |
|---|---|---|
| 1 | 可否直接复用 judgeAngle | **可以**（文本层直接调用）。需调用方组装 existing/historyTitles；能力边界见 §2.3（主题级换皮不在能力内） |
| 2 | 是否需要修改 dedup.ts | **小改**：① 默认阈值改引 constants（消双真源）② PUNCT 补 `「」『』` ③ 可加一个 `checkAngleDup` 统一入口（组装数据+调 judgeAngle+返回 hits）。不动算法与阈值数值。`nextCode` 删除或移交 S4-7 清理 |
| 3 | 扩库与手动如何统一判重 | 同一 `checkAngleDup` 服务函数接三个写入口（expandAnglesForTrack / createAngle / updateAngle），处置策略分「生成侧=丢弃」与「手动侧=拒绝/提示」 |
| 4 | 编辑如何避免误判自身 | 查询/比对时 `excludeId = 自身 id`（updateAngle 传入） |
| 5 | 跨赛道重复 | 判重集合扩展为全赛道（L0/L1 建议同等拦、hit 里标注赛道名）；主题级换皮交人工审核兜底；是否只提示不拦：`【待决策】` |
| 6 | 保留不同角度 | 不需要专门机制：阈值实测不误伤（0.07~0.11）；theme 相等不判重（仅 L3 堆积上限） |
| 7 | 是否记录重复原因 | **是**，复用现有载体：① 扩库被丢弃的条目补逐条 warn 日志（现在只有计数）② 保留的高相似候选写 `metaJson.dedupHits` ③ 审核事件快照 `TopicReview.dupHits`（已预留） |
| 8 | 是否用 metaJson | **是**。DATABASE-DESIGN-REVIEW §③ 明文：`metaJson`（六维评分依据/风险说明/**判重结果**）——按设计用途使用，不属滥用 |
| 9 | 是否需要 Schema/Migration | **不需要**。metaJson + TopicReview.dupHits 均已存在（S4-1 建表时预留） |

### 9.2 实施要点（范围最小化）

1. `dedup.ts`：`checkAngleDup(input)` 封装（含 excludeId、跨赛道策略参数、返回 `{verdict, hits[]}`）。
2. `angles.ts` 三处接线：
   - 扩库：L0（现有 normalize 层合并）+ L1 丢弃；L2 命中记 metaJson（候选保留）；
   - createAngle：L0/L1 → 400（带 hit）；L2 → 允许 + metaJson 记录；
   - updateAngle：同上 + excludeId。
3. 前端 `TrackAnglesView.vue`：新增/编辑对话框展示「与第 N 条高度相似」提示；审核界面展示 dupHits（若有）。
4. `smoke-angles.ts` 补回归：同义改写拦 / 同主题不同角度放 / 编辑自身不误判 / 跨赛道命中带来源 / 手动新增重复 400。
5. 阈值不动（constants 真源）；不动 planner/writer/publisher/schema/审核状态机。

---

## 10. 预计修改文件和影响范围

| 文件 | 改动 | 风险 |
|---|---|---|
| `server/src/services/dedup.ts` | 小改（阈值引 constants、PUNCT 补缺、checkAngleDup 入口） | 低：算法不动，migrate.ts 的 dupScore 用法不受影响 |
| `server/src/services/angles.ts` | 三写入口接线 + 判重结果记 metaJson + skipped 明细日志 | 中：主链路；需保持 S4-1 评分/状态机语义不破坏 |
| `server/src/api/routes/angles.ts` | 手动路径错误语义（400 带 hit 明细）| 低 |
| `web/src/views/TrackAnglesView.vue` | 重复提示展示 | 低 |
| `web/src/types.ts`、`web/src/api/index.ts` | 类型/响应字段同步 | 低 |
| `server/scripts/smoke-angles.ts` | 回归用例扩充 | 低 |
| `server/src/constants.ts` | **不改数值**（仅被引用） | 无 |
| docs（CHANGELOG / WRITING-PIPELINE 去重现状段） | 随实施更新 | 无 |

**不受影响**：prisma/schema.prisma、migrations、planner、writer、publisher、topic-review 状态机、安全红线。**S4-3/S4-4/S4-5 不在本轮顺带范围。**

---

## 11. 是否需要 Schema / Migration

**不需要。**`【事实】`
- `Angle.metaJson`：设计文档明文预留「判重结果」载体（DATABASE-DESIGN-REVIEW §③）。
- `TopicReview.dupHits`：列已建，注释明文「S4-2 去重链接入前恒空」（schema.prisma:325），结构约定=「命中的相似 Angle id+分数」。
- 无新表、无新列、无索引新增需求（现有 `[trackId,status,seq]`、`[theme]` 索引足够支撑查询）。

---

## 12. 风险与待确认决策

### 12.1 待用户决策（实施前需拍板）

| # | 决策点 | 选项 | 影响 |
|---|---|---|---|
| D-a | 手动新增/编辑命中「明确重复」（L0/L1） | A. 硬拒 400；B. 警告+可强制保存（`force` 参数） | B 需多一个请求字段；A 更简单但人工补录合法同题会被堵 |
| D-b | 编辑已 approved 选题的内容后审核态 | A. 维持现状（仍 approved）；B. 内容变更自动回退 candidate 待重审；C. 标记 dirty 仅提示 | B 最安全但动状态机语义（属编辑质量缺口，不止去重；可单列小项或并入 S4-2） |
| D-c | rejected 选题是否参与判重 | A. 参与（同题重现照拦）；B. 不参与；C. 折中（L0/L1 拦、L2 不提示） | 影响「拒掉的主题能否换人重做」 |
| D-d | history 层范围 | A. 全部 Article.title；B. 仅已推/已产文的标题 | 影响「草稿标题」是否算已占题 |
| D-e | 跨赛道命中处置 | A. L0/L1 同赛道语义同等拦；B. 跨赛道只提示不拦 | B 放宽跨赛道精确洗稿 |
| D-f | theme_crowded（L3）是否接线 | A. 接为提示；B. 接为拦截；C. 不接 | 现状扩库无此层；cap=8 是否合宜待观察 |
| D-g | 命中记录粒度 | 仅计数+日志 / +metaJson.dedupHits / +dupHits 快照（建议全做，工作量小） | 指标② 数据完整度 |

### 12.2 风险登记

1. **主题级换皮仍在**（M1/M2/M3）：S4-2 轻量版预期**收窄**而非消灭重复；验收口径应写「词面层命中率+人工拒重留痕」，不应承诺「跨赛道同题全拦」。`【样本】`
2. **样本量 33 条**：阈值行为结论外推有限；接线后建议先以 L2 提示形态跑一段真实数据再收紧。`【样本】`
3. **并发 TOCTOU**：两次扩库并发可绕过判重（快照时差）。当前单管理员操作模式风险低；如需堵，可加同赛道串行锁（constants 已有 LOCK_* 设施）——非必须。`【推断】`
4. **simHistory 跨文体比较**：角度 vs 标题的 0.35 阈值在样本上干净，但数字型/套话标题可能抬分；建议 D-d/D-g 采用「提示不拦」过渡。`【推断】`
5. **编辑 approved 绕过审核**（D-b 现状）：这是比去重更直接的质量漏洞，若不在 S4-2 处理需明确归属（S4-4 或独立小项），避免默默遗留。`【事实】`
6. **judgeAngle 误伤担忧**：33 条全交叉 + 构造用例未见误伤（同主题不同角度 0.07~0.11）；「保留不同角度」有实测支撑。`【样本】`

---

## 附：本轮零变更声明

未修改业务代码 / Schema / Migration / 配置 / `.env` / 数据库账号权限；`dev.db` 仅复制副本只读查询，归档原文件未触碰；未执行 db push / migrate / LLM / 微信调用；未实施 S4-2，未触碰 S4-3/S4-4。验证脚本位于系统临时目录（`%TEMP%/s420-dedup-audit/analyze.mts`、`analyze2.mts`），可复跑复核。**报告完成，停等 ChatGPT 审核，再定 S4-2 实施范围与授权。**
