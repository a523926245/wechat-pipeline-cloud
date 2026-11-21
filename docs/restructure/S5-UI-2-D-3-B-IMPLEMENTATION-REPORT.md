# S5-UI-2-D-3-B 实施报告 · 执行异常详情抽屉

**日期**：2026-11-17
**依据**：`S5-UI-2-D-3-A-FAILURE-TRACE-AUDIT.md` 方案 A
**结论**：只改 `DashboardView.vue` 一个业务文件；点击异常明细不再跳走，改为就地打开详情抽屉。`vue-tsc` 0、`build` ✓、浏览器 13 项场景 + 回归全过。零后端、零 Schema、零数据库访问。

---

## 1. 修改文件清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `web/src/views/DashboardView.vue` | ①`goRun()` 删除，改为 `openRun()` 打开抽屉 ②新增抽屉状态/计算/复制/跳转 ③明细行加 `title` ④`runs` 明细差额脚注 ⑤抽屉模板与样式 | +约 230 行（模板+样式为主） |
| `docs/DEVLOG.md` | 追加本轮完成情况 | 1 条 |
| 本报告 | 新增 | — |

**未修改**：`server/**`、任何 API、`types.ts`（`TodoRunItem` 字段已齐全）、`TaskProgress`/`PageHead` 等公共组件、`/plan`、其他待办卡片、`.env`、Schema/Migration。

---

## 2. 抽屉交互实现方式

- 组件：Element Plus `el-drawer`（`size="min(520px, 92vw)"`、`append-to-body`），沿用现有设计令牌，无新视觉体系。
- 状态：`runDrawer: boolean` + `currentRun: TodoRunItem | null`。`openRun(row)` 把**当前行对象**存进去，**不发任何请求**。
- 关闭：抽屉 X、底部「关闭」、ESC 三条路径均已实测（`el-overlay` 变 `display:none`、`body` 解除 `overflow:hidden`、URL 不变）。
- 关闭后停留在 Dashboard 原位置（不 `router.push`，无滚动跳转）。

---

## 3. 展示字段及来源

| 顺序 | 字段 | 来源 | 缺失时 |
|---|---|---|---|
| 1 | 任务类型 | `jobTypeText(jobType)`（写稿 / 漫画脚本 / 漫画面板） | — |
| 2 | 执行状态 | `<TaskProgress status="failed" />` | — |
| 3 | 任务 ID | `id`（`wb-mono`） | — |
| 4 | 账号 | `account` | 「未关联账号」 |
| 5 | 执行时间 | `friendlyTime(createdAt)` | — |
| 6 | 错误代码 | `errorCode`（`wb-mono`） | 「未记录」 |
| 7 | 失败原因 | `errorMessage` **原文** | 见 §4 降级 |

**为什么状态恒为「失败」**：该列表的数据集本身就是 failed 集合（`unresolved` 只统计「同键最新一条仍失败」的键，`recent` 只从其中取），传 `failed` 是对事实的直述，不是补造状态。

**原因区域样式**（`.run-detail__text`）：`white-space: pre-wrap` 保留换行、`overflow-wrap: anywhere` 防长串撑破、`max-height: 44vh` + `overflow: auto` 内部滚动、`user-select: text` 可选中。**没有单行省略号**。

---

## 4. 三种降级

| 情况 | 处理 | 实测 |
|---|---|---|
| `comic_panel` 且无原因 | 「漫画面板任务未记录文字错误详情。请前往文章页面查看失败分镜，并根据失败格进行重画。」+「去文章看分镜」 | ✅ 见截图 53 |
| 其他类型 `errorMessage` 为空 | 「该任务没有记录文字失败原因。」；`errorCode` 有值则在字段区展示 | ✅ 见截图 52（`comic_script_failed`） |
| `errorMessage.length >= 900` | 文本下方加「失败原因可能已达到存储长度上限，当前内容可能不完整。」，**不改写内容、不二次请求** | ✅ 1005 字样本触发 |
| `write`/`comic_script` 有原因时 | 追加「当前记录包含执行失败摘要，不包含失败选题标题。」 | ✅ |

降级文案都在 `.run-detail__empty`（虚线框）里，不会出现空白块。

---

## 5. 复制能力

- 项目内无既有剪贴板工具 → 使用 `navigator.clipboard.writeText`，**未引入任何依赖**。
- 复制内容 = `currentRun.errorMessage` 原文（未 trim、未改写）。
- 成功：`ElMessage.success('失败原因已复制')`。
- 失败（无 API / 无权限 / 拒绝）：`ElMessage.error('复制失败（浏览器未授予剪贴板权限），请手动选中文本复制')`——**不假装成功**。
- `errorMessage` 为空或纯空白时不渲染复制按钮。

**实测**：CDP 授予 `clipboardReadWrite` 后，读回剪贴板 1005 字符，与原文 `equal: true`，同时出现成功提示。

---

## 6. 去文章 / 去创作计划

| 条件 | 按钮 | 行为 | 实测 |
|---|---|---|---|
| `articleId != null` | 「去文章看分镜」 | 先关抽屉，再 `router.push('/articles/:id')` | ✅ `/articles/42`，且**不显示**「去创作计划」 |
| `articleId == null` | 「去创作计划」 | 先关抽屉，再 `router.push('/plan')` | ✅ `/plan`，且**不显示**「去文章看分镜」 |

- 未新增 `run` / `account` 参数，按钮文案只说「去创作计划」，不暗示能定位这条失败。

---

## 7. 明细上限提示

`unresolved` 可能大于 `recent.length`（后端 `TODO_RECENT = 3`，本轮未改）。实现：

```ts
const runsHiddenCount = computed(() => Math.max(0, (runsBlock.value?.unresolved ?? 0) - runsBlock.value.recent.length));
```

- 仅在 `runsHiddenCount > 0` 时显示脚注：**「当前仅展示最近 3 条异常，另有 1 条未在此处展开。」**（N/M 均动态计算）。
- 实测：夹具 `unresolved=4 / recent=3` → 文案与数字一致。
- 若 `runs` 块降级（`unresolved` 为 null）→ `?? 0` 兜底，不显示脚注，**不推测**。

---

## 8. 浏览器测试场景与结果（真实 dist + Mock）

| # | 场景 | 结果 |
|---|---|---|
| 1 | `write` 失败：类型/ID/账号/时间/错误码/完整原因 | ✅ 写稿 · 901 · 星座物语 · 2026-11-16 09:15:00 · `write_failed` · 1005 字全文 |
| 2 | `comic_script` 失败且原因为空 | ✅ 通用降级文案 + `comic_script_failed` |
| 3 | `comic_panel` 无原因 | ✅ 面板专用降级 + 「去文章看分镜」→ `/articles/42` |
| 4 | 原因为空 | ✅ 不出现空白区域（虚线框文案） |
| 5 | 长文本（1005 字） | ✅ 可换行、内部滚动（`scrollHeight > clientHeight`）、无横向溢出（`scrollWidth == clientWidth`） |
| 6 | 复制 | ✅ 剪贴板内容与原文完全一致（1005=1005），成功提示出现 |
| 7 | `articleId` 有值 | ✅ 只有「去文章看分镜」 |
| 8 | `articleId` 为空 | ✅ 只有「去创作计划」 |
| 9 | 关闭（底部按钮 / ESC） | ✅ 抽屉隐藏、`body` 解锁、URL 仍 `/`，无意外跳转 |
| 10 | 深色主题 | ✅ 文本/字段区/按钮/滚动区均清晰（截图 61） |
| 11 | 窄屏（500px，headless 下限） | ✅ 抽屉 460px（92vw）不出屏、无横向滚动、文本仍可滚动 |
| 12 | `runs` 降级/为空 | ✅ 明细不渲染 → 无行可点 → 不会出现残缺详情 |
| 13 | `unresolved > recent.length` | ✅ 脚注文案准确（4 − 3 = 1） |

**重点项**：点击异常明细后 `location.pathname` 仍为 `/`（`urlAfterOpen: "/"`），确认**不再调用 `router.push('/plan')`**。

截图：`50-d3b-write-long.png`、`51-d3b-copied.png`、`52-d3b-script-empty.png`、`53-d3b-panel-empty.png`、`60-d3b-narrow.png`、`61-d3b-narrow-dark.png`（均在 `var/tmp/s5ui2c/`，未进版本库）。原始结果：`d3b-result.json`。

---

## 9. TypeScript 检查与构建

- `npx vue-tsc --noEmit` → **0 错误**
- `npm run build` → **✓ built in 14.11s**
- `npm run test:todo-nav` → **34/34**（既有断言，未受本轮影响）

---

## 10. 其他待办与任务流水回归

| 入口 | 结果 |
|---|---|
| 待审核选题「去审核」 | ✅ `/tracks?pending=3,5`（S5-UI-2-D-1 行为不变） |
| 未推送草稿 | ✅ `/articles?needs=draft_unpushed`（S5-UI-2-D-2 行为不变） |
| 文章体检「去文章」 | ✅ `/articles` |
| 漫画草稿 / 推送失败 | 未改动（`goArticles('comic'|'failed')` 原样） |
| 任务流水 / 最近文章 / 运行日志 Tab | ✅ 三个 Tab 仍在，任务流水表格正常渲染 |
| Dashboard 请求参数 | ✅ 未变（仍只有 `GET /api/dashboard`） |
| 其他页面 | 未触碰 |

---

## 11. 数据库访问

**零。** 本轮纯前端改动，未连接任何数据库、未跑 smoke / 迁移 / 指纹脚本，未调用 LLM / 微信。
浏览器复测用的是本地 Mock（手写 JSON、读 `var/tmp/s5ui2c/mock.mjs`，跑完已停）。

---

## 12. Git HEAD 与工作区

- HEAD 仍 **`b2fbad3`**，未 commit / push / reset / checkout。
- 本轮修改：`web/src/views/DashboardView.vue`、`docs/DEVLOG.md`；新增本报告。
- 此前各轮未提交内容（`server/**` 若干、`types.ts`、其他 views、各报告与脚本）原样保留，未覆盖。

---

## 13. 未解决问题

1. **`comic_panel` 仍不记录原因**（后端 `panels.ts:293` 不写 errorCode/errorMessage）：抽屉只能给「去文章看失败格」。补这段属于写入侧改动，需单独授权。
2. **`write`/`comic_script` 的 `errorMessage` 不含选题标题**：抽屉里已显式说明，但用户仍无法从这条记录知道是哪条选题；根因在 `summarizeFailures` 只拼 `note`，同属写入侧。
3. **明细仍只有 3 条**（`TODO_RECENT` 未改）：脚注告知差额，但看不到其余条目的原因。要补齐需给 `runs` 单独放宽上限（后端小改）。
4. **仍无「历史失败」视图**：7 天窗口外的失败不进待办（既有口径），本轮未扩展。
5. **复制在非安全上下文会失败**（如 http + 非 localhost）：已给出明确提示，未做 `document.execCommand` 回退（避免引入过时 API）。
