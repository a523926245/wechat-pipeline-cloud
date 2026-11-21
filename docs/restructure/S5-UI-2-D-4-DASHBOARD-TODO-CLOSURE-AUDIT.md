# S5-UI-2-D-4 审查报告 · Dashboard 待办闭环整体收尾

**日期**：2026-11-17
**性质**：只读审查（未修改任何 `server/**`、`web/src/**`、API、Schema、`.env`）
**结论**：**未发现 P0 / P1 问题。建议正式关闭 S5-UI-2-D，进入 S5 下一阶段。**
四类待办（选题 / 文章 / 体检 / 执行异常）均已形成「数量 → 明细 → 目标页面 → 可操作」的闭环；剩余 2 项 P2、3 项 P3 均不阻塞，已逐条记录。

---

## 1. 审查范围与环境

**代码**：`DashboardView.vue`（四类待办 + 抽屉 + 三 Tab）、`TracksView.vue`（pending 承接）、`TrackAnglesView.vue`（status/used 参数）、`ArticlesView.vue`（needs 承接）、`utils/todo-nav.ts`（跳转纯函数）、`api/index.ts`、`types.ts`；服务端 `services/dashboard.ts`（四块口径）、`api/routes/articles.ts`（needs）、`api/routes/plans.ts`、`services/panel*/publisher`（失败写入点）。

**文档**：`RESTRUCTURE-2.0-CONVERGED-PLAN.md`、`00-FINAL-EXECUTION-CHARTER.md`、`TARGET-UI-ARCHITECTURE.md`、`DEVLOG.md`、`S5-UI-2-C-WORKBENCH-FLOW-AUDIT.md`、`S5-UI-2-D-1/D-2/D-3-A/D-3-B` 四份报告。

**浏览器验证**：真实 `web/dist` 构建产物 + 本地 Mock（`var/tmp/s5ui2c/mock.mjs`，手写 JSON、不连库、不调外网），headless Chrome + CDP 真实点击；覆盖浅色 / 深色 / 500px 窄屏 / member 角色 / 四块降级 / 全零。跑完已停服务并清理 profile。

**边界**：未连接数据库、未跑 smoke/迁移/指纹脚本、未调用 LLM/微信、未执行 Git 写操作。

---

## 2. 四类待办链路核查结果

### 2.1 待审核选题（D-1）

| 检查点 | 结果 | 证据 |
|---|---|---|
| 数量与明细对应 | ✅ | 卡片「3 = 候选 2 · 待改 1」，明细 3 条（2 候选 + 1 待改），首行带 `scoreTotal 21/30` |
| 单赛道仅待改 | ✅ | `?used=unused&status=needs_revision`，目标页 1 行（正是该条「待修改」） |
| 单赛道有候选 | ✅ | 明细点击 → `?used=unused&status=candidate`，2 行 |
| 多赛道 | ✅ | `/tracks?pending=3,5`，页面提示「2 个赛道…星座、育儿」+ 2 个行内「待审核」标签 |
| 刷新 | ✅ | `pending` 提示 reload 前后完全一致（同一 URL） |
| 清除 | ✅（D-1 已验证） | 「只看全部赛道」→ `/tracks`，提示与标签消失 |
| member | ✅ | member 视图 3 行待办（无选题行），侧栏仅 5 个菜单项 |

**结论**：D-1 完整解决了 D-3-A/C 审计中的「多赛道落到裸 `/tracks`、无待审线索」问题。

### 2.2 文章待办（D-2）

| 入口 | URL | 列表行数（Mock） | 提示 |
|---|---|---|---|
| 未推送草稿 | `/articles?needs=draft_unpushed` | 1 | 「当前筛选：未推送草稿 / 普通文章·草稿状态·无推送记录」 |
| 待重推 | `/articles?needs=repush` | 3 | 「当前筛选：待重推文章 / …（updated，或有推送痕迹的 draft）」 |
| 推送失败 | `/articles?status=failed` | 1 | 无（沿用旧入口） |
| 漫画草稿 | `/articles?status=draft&pipeline=comic` | 1 | 无（沿用旧入口） |

- 刷新保持（`/articles?needs=repush` reload 后仍 3 行 + 提示）；清除后回 7 行全量；非法 `needs=whatever` → 7 行普通列表、无提示。
- **口径一致性**：前两类由 D-2 的隔离库冒烟钉死（`needs=draft_unpushed` total 2 = 卡片 2；`needs=repush` total 4 = 卡片 4，断言 59/60），本轮浏览器只验证前端链路，未重跑后端。
- `needs` 与 `status`/`pipeline` 互斥（服务端 needs 分支忽略后二者），`accountId`/`angleId`/分页与之正交；member 归属过滤保持（冒烟断言 61）。

### 2.3 文章体检

| 检查点 | 结果 | 证据 |
|---|---|---|
| 数量与明细 | ✅ | 卡片 1 = 明细 1（`3 个 error / 5 warn / 09:10`） |
| stale 排除 | ✅（代码 + D-2 冒烟断言 62/27） | 卡片副标题明写「记录早于当前正文的不计入」 |
| 进入文章页可见体检 | ✅ | 点明细 → `/articles/93`，页面含「体检」面板与「最近存档」 |
| 是否误调写副作用接口 | ❌ **没有误调** | 请求日志只有 `GET /api/articles/93/lint-runs`，**无** `GET /api/articles/93/lint` |

> 关键：`checkArticleLint`（会 `recordLintRun`）只在用户点「重新检查」或保存时触发；进页面走的是只读的 `listArticleLintRuns`。

### 2.4 任务执行异常（D-3-B）

| 检查点 | 结果 |
|---|---|
| 明细就地打开抽屉 | ✅ 点击后 `location.pathname` 仍 `/`，未跳 `/plan` |
| 展示完整 TaskRun 信息 | ✅ 写稿 · 任务 ID 901 · 星座物语 · 2026-11-16 09:15 · `write_failed` · 原因 1005 字 |
| 原文与截断提示 | ✅ 两条提示：长度上限、不含选题标题 |
| 空原因降级 | ✅ `comic_script` → 「该任务没有记录文字失败原因」+ `comic_script_failed`；`comic_panel` → 面板专用文案 |
| 出口正确 | ✅ 有 `articleId` 只有「去文章看分镜」；无则只有「去创作计划」 |
| 关闭回到原位置 | ✅ 底部按钮 / ESC 均关闭，URL 不变，`body` 解锁 |
| 差额提示 | ✅ 「当前仅展示最近 3 条异常，另有 1 条未在此处展开。」 |
| runs 降级 | ✅ 只显示「统计暂不可用」标签，**无**明细、**无**差额脚注、不显示 0 |

**三 Tab**：任务流水 / 最近文章 / 运行日志 均在，切换正常、表格正常渲染。**未**用 RunLog 与 TaskRun 做任何时间/文本关联（代码层面也无此逻辑）。

---

## 3. 关键入口 → 参数 → 目标页面对应表

| 待办 | 入口 | 参数 | 目标页 | 页面承接 |
|---|---|---|---|---|
| 待审核选题（单赛道） | 行头「去审核」 | `?used=unused&status=candidate\|needs_revision`（按该赛道真实分布） | `/tracks/:id/angles` | 读 status/used 并回显筛选控件 |
| 待审核选题（多赛道） | 行头「去审核」 | `?pending=3,5`（升序、去重） | `/tracks` | info 提示条 + 行内「待审核」标签 + 清除入口 |
| 选题明细 | 明细行 | `?used=unused&status=<该条真实状态>` | `/tracks/:id/angles` | 同上 |
| 未推送草稿 | 数字 | `?needs=draft_unpushed` | `/articles` | 提示条 + 禁用状态下拉 + 定向空态 |
| 待重推 | 数字 | `?needs=repush` | `/articles` | 同上 |
| 推送失败 | 数字 | `?status=failed` | `/articles` | 原状态筛选（超集，见 P2-1） |
| 漫画草稿 | 数字 | `?status=draft&pipeline=comic` | `/articles` | 原产线筛选（精确） |
| 文章明细 | 明细行 | — | `/articles/:id` | 改稿页 |
| 体检 | 行头「去文章」 | 无 | `/articles` | 未筛选列表（见 P2-2） |
| 体检明细 | 明细行 | — | `/articles/:id` | 改稿页含体检面板 |
| 执行异常 | 行头「去创作计划」 | 无 | `/plan` | 排产表（不承诺定位该失败） |
| 执行异常明细 | 明细行 | — | **抽屉（不跳页）** | 失败原因 + 出口 |

---

## 4. 权限与降级行为

| 项 | 结果 |
|---|---|
| member 选题 | ✅ `angles=null` → 整行不渲染（不是「统计暂不可用」），侧栏无赛道/文风入口 |
| member 文章/体检/执行异常 | ✅ 按 `ownerUserId` 过滤（D-2 冒烟断言 61 用真实登录验证过归属） |
| member 可否进 `/tracks` | 菜单无入口、路由角色限制未变（本轮未改任何权限代码） |
| 单块降级 | ✅ `runs` 降级实测：只该行显示「统计暂不可用」，其余三行数字照常 |
| 全零 | ✅ 显示「暂无待办」+ 保留卡片，不隐藏 |
| 差额/推测 | ✅ 降级时 `?? 0` 兜底 → 不显示差额脚注；无任何猜测性数字 |

---

## 5. 浏览器验证结果（摘要）

| 场景 | 结果 |
|---|---|
| 四类待办总览（1440 浅色） | ✅ 四行齐全，数字/明细/说明对齐，无重叠 |
| 多赛道选题承接 | ✅ `?pending=3,5` + 2 个标签 + 提示条 |
| 单赛道仅待改 | ✅ 1 行命中 |
| 文章四入口 | ✅ 四条 URL 与行数均符合预期 |
| needs 刷新 / 清除 / 非法值 | ✅ 3→3 / →7 / →7 |
| 浏览器返回 | ✅ 从 `/articles?needs=draft_unpushed` 返回 → `/`，四行待办正常重绘 |
| 体检明细 → 改稿页 | ✅ 面板与最近存档可见 |
| 抽屉（写稿/漫画面板） | ✅ 内容、降级、出口、关闭均正确 |
| 深色（仪表盘 + 赛道页） | ✅ 背景 `rgb(14,16,20)`，文字/标签/提示条可读，无浅色残留 |
| 500px 窄屏 | ✅ 抽屉 460px 不出屏、无横向溢出；仪表盘 `scrollWidth == innerWidth` |
| 控制台 | ✅ 全流程 0 个 error / 0 个未捕获异常 |

截图：`70`~`80-d4-*.png`（`var/tmp/s5ui2c/`，未进版本库）；原始数据 `d4-result.json`。

**未验证项（如实标注）**：①真实业务库数据分布（按约束未连库，口径由 D-2 隔离库 67 项断言背书）；②member 在 `/tracks` 的 403 行为（本轮未构造该请求，权限代码未改）；③1024–1180 中间视口。

---

## 6. 发现的问题及严重程度

> 未发现 P0（断链/数据错误/越权/误导性操作）与 P1（主路径明显受阻）。以下均为 P2/P3。

### P2-1 「推送失败」入口是超集，卡片数字可能小于列表行数

- **证据**：`services/dashboard.ts` 的 `todoArticles` 中 `pushFailed` 只统计 `pipeline='article' ∧ status='failed' ∧ 无推送痕迹`；而入口是 `/articles?status=failed`（`routes/articles.ts` 仅按 status 过滤，不区分 pipeline、不看推送痕迹）。
- **影响**：若存在「failed 但有推送痕迹」的历史脏数据，或漫画文章推送失败（`publisher.ts:322` 置 failed 不看 pipeline），列表行数会多于卡片数字。属于**方向为超集**的信息不一致，不误导操作。
- **为什么不是 P0/P1**：与 D-2 修复前的 `repush` 同类，但量级小、且这类数据在 S5-1 之后不再产生；用户仍能看到真实列表。
- **最小修复建议（未实施）**：仿 D-2 增加 `needs=push_failed`（`status='failed' ∧ pipeline='article' ∧ mediaId='' ∧ pushDate=''`），前端 `goArticles('failed')` 改传 `needs`。约 15 行后端 + 2 行前端 + 断言。

### P2-2 体检行头「去文章」落到未筛选列表，无法判断处理对象

- **证据**：`DashboardView.vue` 体检行头按钮 → `router.push('/articles')`；文章列表没有体检列，也没有体检筛选参数。
- **影响**：从「体检未通过 2 篇」点进去看到的是全部文章，需自己回忆哪两篇。明细行可直达单篇（替代方式存在）。
- **最小修复建议（未实施）**：`needs=lint_failed`（复用最新一条 + 指纹一致的判据）或给列表加「体检」列。两者都需后端/列表结构改动。

### P3-1 执行异常有两处「去创作计划」

行头一个（`v-if unresolved>0`）+ 抽屉底部一个（无 articleId 时）。目标相同、文案相同，功能上不冲突，仅略显重复。

### P3-2 两处「去文章」都落同一未筛选列表

「文章待处理」行头与「文章体检」行头的「去文章」都是 `/articles`，语义相近但入口不同，用户可能分不清该点哪个。

### P3-3 多赛道选题仍需二次点击

`/tracks?pending=` 只做标记，用户还要点「选题池」再选审核态（D-1 报告 §7.3 已说明：TracksView 不知道赛道内 candidate/needsRevision 分布，硬猜 `status` 会重演 P0 空列表）。

### P3-4 抽屉状态恒显示「失败」

当前 `todos.runs.recent` 只含 failed，所以固定 `status="failed"` 是事实直述；若将来该列表引入非失败状态需同步调整（仅备注，无当前影响）。

---

## 7. 是否存在阻塞 S5-UI-2-D 关闭的问题

**没有。** 判定依据：

1. 四类待办全部可点、可跳、可操作，无一断链；
2. 两处曾导致「点进去看不到对象」的问题（单赛道仅待改、多赛道无线索）均已修复并有浏览器证据；
3. 文章两类精确筛选的 total 与卡片数字由隔离库断言钉死；
4. 执行异常不再离开信息源，失败原因可见、可复制、可降级；
5. 权限与降级表现符合预期，无越权、无假数据；
6. 仅存 2 个 P2（一处数字超集、一处弱入口），都有替代路径且不影响正确操作。

---

## 8. 建议

**建议正式关闭 S5-UI-2-D**，并将 §6 的 P2 作为「后续可选优化」登记，不阻塞进入 S5 下一阶段：

- 若要收口 P2-1：与 P2-2 合并成一次「列表筛选补两位」（`needs=push_failed` / `needs=lint_failed`），属**后端 + 前端**小型批次，需单独授权。
- 若暂不收口：建议在 S5 阶段收尾时于 `UI-GUIDE`/决策表登记「推送失败入口为超集」「体检入口为弱入口」两条已知口径，避免后续被当成 bug 反复排查。

---

## 9. 未解决但可以接受的遗留

| 项 | 为什么可接受 |
|---|---|
| 执行异常只列 3 条（`TODO_RECENT`） | 已用差额脚注如实告知；扩展属后端常量改动 |
| 7 天窗口外的失败不进待办 | S5-UI-2-B 已拍板的口径（避免历史失败永久挂台） |
| `comic_panel` 无 errorMessage | 写库侧缺口，抽屉已降级为「去文章看失败格」 |
| `write/comic_script` 原因不含选题标题 | 写入侧 `summarizeFailures` 的限制，抽屉已显式说明 |
| 选题多赛道需二次点击 | 数据不足以精确直达，硬猜会重演 P0 |
| 体检/推送失败入口的筛选精度 | 见 P2-1/P2-2，有替代路径 |

---

## 10. 边界声明

- 未修改 `server/**`、`web/src/**`、API、Schema、Migration、`.env`；未改 `TODO_RECENT` / 7 天窗口 / 500 上限 / 统计口径。
- 未连接或写入数据库；未执行 Migration；未调用 LLM / 微信；未执行 Git 写操作（HEAD 仍 `b2fbad3`，工作区改动保持本轮开始时的状态）。
- 本轮唯一新增文件为本报告；浏览器复测用的 Mock 夹具与脚本位于 `var/tmp/s5ui2c/`（未被版本控制、跑完已停服务）。
