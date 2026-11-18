# S5-UI-5-P2-1 · 创作计划页 warnings / backlog 展示 · 实施报告

**日期**：2026-11-18
**性质**：小范围前端展示补齐（S5-UI-5 审计 A2）。**只补齐后端已返回数据的 UI 展示**，未改后端 API/业务逻辑/排产策略/失败补偿、未碰 P1 四态结果处理。**唯一业务代码改动为 `web/src/views/PlanView.vue`**；未改 Schema/Migration/`.env`、未连库、未调 LLM/微信、未推送、未 Git 写操作、未实施 P2-2/2-3/2-4。
**结论**：完成。warnings 逐条展示后端原文（默认 2 条、可展开）、backlog 明确标注「近 3 天欠账（非本次排产）」并展示日期/账号/已出/缺；空数组与 null 均不渲染。六态 + 1440/1024/500 + 深浅色浏览器验证全过，Console 0 error，P1 四态逻辑无回归。

---

## 1. 后端 warnings / backlog 的真实结构与含义（核查结论）
真源 `server/src/services/planner.ts` 的 `PlanResult`（`:56-64`）：
- `warnings: string[]`：三类，每条**自带具体原因**——① 角度不足：`[赛道][产线][账号] 角度不足，缺 N 篇——请补充角度库`（`:176`）；② 库存告急：`[赛道][产线] 角度库存告急：剩 N 个，按 M 篇/天仅够约 D 天…`（`:181`）；③ 角色未就绪：`「写作」角色未就绪：reason——请先到「模型配置」添加模型并绑定该角色`（`:214`）。
- `backlog: { date: string; account: string; got: number; miss: number }[]`：`scanBacklog()`（`:229-253`）回扫近 N 天（**不含今天**）未写满配额的账号-日期组合，`got`=当日实际出稿、`miss`=当日缺口。**是历史欠账，不是当前批次失败**，且只统计账号首个文章日之后的日期（避免启用前误报）。
- 后端保证两者为数组（初始化 `[]`；`scanBacklog` 在 `days<=0||tasks.length===0` 返回 `[]`）。前端仍对 null/非数组做防御（Mock 覆盖 null 场景）。

## 2. 修改文件与展示方式
| 文件 | 变更 |
|---|---|
| `web/src/views/PlanView.vue` | ① script 加 `planWarnings`/`planBacklog` computed（`Array.isArray()` 守卫，null/非数组→空，不伪装 0）、`warningsExpanded` ref、`shownWarnings`（默认前 2 条）；② 模板在排产表格下、skipped 提示前插入：warnings 区（`el-alert type="warning"` 逐条展示后端原文，`v-if="planWarnings.length"`；>2 条显示「展开全部 N 条提醒/收起」切换）、backlog 区（`el-alert type="info"`，`v-if="planBacklog.length"`，文案「近 3 天欠账（非本次排产）」+ 每条 `日期·账号 已出 X、缺 Y`）；③ scoped 样式（flex 布局、`white-space:pre-wrap`、`word-break`、窄屏换行）。复用 Element Plus `el-alert` 与 `--wb-*` 令牌，**未新增公共组件**。 |

**未改**：`web/src/types.ts`（PlanResult 字段已齐全，无需改）、后端任何文件、P1 的 trigger 四态函数（逐字未碰，静态契约断言验证）。

## 3. 各种数据状态验证（真实浏览器）
走查脚本 `var/tmp/s5ui2c/walk-p21.mjs`、派生 Mock `mock-p21.mjs`（用临时夹具文件 `p21-mode.txt` 切换场景，不进版本库），结果 `P21-result.json` + 截图 `P21-*.png`。

| 场景 | warnings 区 | backlog 区 | 判定 |
|---|---|---|---|
| 空（后端默认 []） | 不渲染 | 不渲染 | ✅ 无多余区域 |
| zero 空数组 | 不渲染 | 不渲染 | ✅ |
| 有 warnings（3 条） | 默认 2 条原文 +「展开全部 3 条提醒」→ 点击后 3 条 +「收起提醒」 | 不渲染 | ✅ 空数组不误显 |
| 有 backlog（2 条） | 不渲染 | 显示「近 3 天欠账（非本次排产）：11-15 星座物语 已出2缺2；11-16 育儿手记 已出1缺3」 | ✅ |
| backlog = null | 不渲染 | **不渲染**（未伪装成 0） | ✅ |
| 两者共存 | 2 条原文（含「写作角色未就绪」） | 1 条欠账 | ✅ |

- **内容准确性**：warnings 文案逐字等于后端返回（未推断/未生成）；backlog 明确标注"非本次排产"，未解释成批次失败。
- **展开交互**：3 条时默认 2 条、点击展开全部、按钮变"收起提醒"，均实测通过。

## 4. 浏览器视口与主题
| 视口/主题 | 结果 |
|---|---|
| 1440 桌面 | warnings/backlog 正常显示，`docOverflow=false` |
| 1024 | 正常显示，`docOverflow=false` |
| 500 | 正常显示、文字换行完整无裁切（截图已实看），`docOverflow=false` |
| 500 深色 | `html.dark=true`，warnings（warning 橙）与 backlog（info 灰）配色清晰、无异常 |
- 六态 + 多视口走查 Console **0 error**。

## 5. P1 回归验证
静态契约断言（源码级，全部通过）：P1 三态文案「建稿失败」「部分草稿生成成功」「未生成草稿」仍在；`const first = succeeded[0]` 仍在；`/articles/0` 仅出现在注释"绝不跳"中（无实际跳转）。本轮只新增 computed 与展示模板，未触碰 P1 的 trigger 函数与结果组装逻辑。**浏览器 P1 四态未在本轮重跑**（P1 报告 `P1FIX-*.json` 已完整验证；本轮 Mock 无 trigger 处理，重跑需另配夹具，按最小验证原则未重复）。

## 6. 类型检查、构建与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 32.16s |
| 契约断言（P1 回归 + P2-1） | 源码级 | ✅ 全部通过 |
| 浏览器六态/多视口 | `walk-p21.mjs` | ✅ Console 0 error |
| 现有回归断言 | `test:article-push`/`test:todo-nav` | 未重复运行（本轮未改其依赖逻辑；P1 轮已全绿） |
| 写库 smoke 脚本 | — | 未运行（检查确认有写库/清表副作用，超本轮边界） |

## 7. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 69 项未提交改动全部原样保留；`PlanView.vue` 本就 modified（含 P1 改动），本轮在其上叠加展示代码，未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 8. 数据库及外部接口副作用
未修改 Schema/Migration/`.env`；未连接或写入任何数据库；未调用真实 LLM、微信公众号接口；未推送；未安装依赖、未改 package.json。浏览器用本地 Mock（vite 5204 / mock 8792），已停止、端口释放。

## 9. 尚存问题及风险
1. **告警默认折叠**：warnings >2 条时默认只显示前 2 条，用户需点"展开全部"才看全；这是为不占首屏的取舍，提醒条数在按钮上明示（"展开全部 N 条"），不会漏感知。
2. **backlog 的"近 3 天"文案硬编码**：前端文案写"近 3 天欠账"，与 `getPlan({backlogDays:3})` 的调用值一致；若未来后端改天数需同步文案（当前一致，非缺陷）。
3. **P1 浏览器回归未本轮重跑**：见 §5，靠静态契约 + P1 已有证据保障，属验证边界，非功能风险。
4. **Mock 数据**：走查用夹具，但展示逻辑、响应式与配色均为真实产物行为。

## 10. 结论
S5-UI-5-P2-1 完成，后端 warnings/backlog 数据得到准确、克制（不占首屏、空则不显）的展示，P1 成果未受影响。**本轮到此停止，等待人工验收，不实施 P2-2/P2-3/P2-4，不提交 Git。**
