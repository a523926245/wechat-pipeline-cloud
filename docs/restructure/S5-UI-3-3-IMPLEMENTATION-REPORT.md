# S5-UI-3-3 · 文章工作台产线标识与窄屏推送事实优化 · 实施报告

**日期**：2026-11-17
**性质**：小范围 UI 实施（基于已验收的 S5-UI-3-2 评估报告，已获人工实施授权）。
**结论**：A、B 两项均完成。后端列表回传 `pipeline`（1 行）；前端标题列仅漫画显示轻量标签；500px 下推送事实**真实进入可视区且不被固定操作列遮挡**（`getBoundingClientRect` 交集实测：单元格全宽 52/76px 全部落在视口与表格容器内，与操作列重叠 = 0）。server/web typecheck、web build、两组断言全绿，浏览器走查控制台 0 error。**无业务逻辑 / API 语义 / Schema / Migration / 数据库 / 配置变更，未连库、未调 LLM / 微信、未推送。**

---

## 1. 实际修改文件和改动说明
| 文件 | 类型 | 改动 |
|---|---|---|
| `server/src/api/routes/articles.ts` | 修改（本轮仅 +1 行+注释） | 列表 items 映射增 `pipeline: r.pipeline` |
| `web/src/views/ArticlesView.vue` | 修改 | ① 标题列仅 comic 显示 `StatusTag kind="pipeline"`；② 新增 `narrow` 窄屏状态 + `pushFactTip` 展示函数；③ ID/字数列加 `col-optional`；④ selection 与推送事实列窄屏 `fixed="left"`、推送事实紧凑化（日期进 tooltip）；⑤ 标题单元格局部样式 |
| `docs/restructure/S5-UI-3-3-IMPLEMENTATION-REPORT.md` | 新增 | 本报告 |
| `docs/DEVLOG.md` | 追加一条 | 本轮实际完成进度 |

**未修改**：`web/src/utils/article-push.ts`（`hasPushTrace`/`pushFact` 原样）、`web/src/types.ts`、`web/src/utils/format.ts`、`web/src/api/index.ts`、`web/src/styles.css`（全局 CSS 未动）、任何 Schema/Migration/`.env`。
**实测说明**：目标文件本就处于 modified 状态（本轮前工作区已有 59 项未提交改动，含 `needs` 筛选等 S5-UI-2 系列成果），本轮在这些既有改动之上叠加上述最小改动，未覆盖、未回滚任何既有工作。任务书所写后端路径 `server/src/routes/articles.ts` 与实际不符，实际路径为 `server/src/api/routes/articles.ts`，以实际代码为准。

---

## 2. A：pipeline 响应与漫画标签实现
### 后端
- `GET /api/articles` 的 `select` 本就含 `pipeline: true`（未改）；本轮在 `items: rows.map(...)` 中补 `pipeline: r.pipeline`（`articles.ts` 列表 handler，约 `:395`）。
- 未改变查询条件、分页（`limit`/`offset`/`take`/`skip`）、排序（`createdAt desc`）、member 归属过滤（`where.account = {ownerUserId}`）、`needs` 分支、其他响应字段与接口语义；未新增 DB 字段/Schema/Migration；未改漫画业务逻辑。
- `pipeline` 为 `String @default("article")` 非空字段，旧数据自动落 article，返回 undefined 的新旧 Mock 均由前端按普通文章兜底。

### 前端
- 标题列（`ArticlesView.vue` 标题单元格）加 `<StatusTag v-if="row.pipeline === 'comic'" kind="pipeline" value="comic" class="pipeline-tag" />`；普通文章（含 pipeline 缺失的历史响应）不渲染任何标签。
- 文案沿用 `GET /api/pipelines` 下发的词表（`StatusTag` 内部走 `statusMeta('pipeline')` → `pipelineText`），未新增任何 pipeline 文案映射；组件沿用公共 `StatusTag`，未自研标签。
- 局部 scoped 样式 `.article-title-cell` 令标签与标题并排、`flex:none` 标签 + 标题省略号，不换行撑高行高。
- 标题点击预览、状态、推送事实、操作列功能均未改变。

**契约断言（源码级）**：服务端 select/items 均含 pipeline；前端仅 comic 显示 `kind="pipeline"`；Mock `/api/articles` items 含 pipeline；`hasPushTrace`/`pushFact` 未被改动——全部通过。

---

## 3. B：窄屏推送事实布局修复
### 现状与成因（复核 S5-UI-3-2 结论）
- 推送事实列原本**无** `col-optional`，不是 CSS 主动隐藏；900px 隐藏三列后剩余宽约 614px 仍超 500px 容器 → 表格内部横向滚动 + `fixed="right"` 操作列遮挡，推送事实落在可视区外。
- S5-UI-3-1 的 `pushCellVisible:true` 只查 DOM 存在、`docOverflow:false` 只查页面无横向溢出，均不能证明列可见——本轮已改用 `getBoundingClientRect` 可视区相交判据。

### 本轮改动（全部在 ArticlesView.vue 局部）
1. **固定推送事实到左侧**：`selection` 与「推送事实」列在 `narrow`（`matchMedia('(max-width:900px)')`）为 true 时设 `fixed="left"`；桌面端 `false`，布局不变。固定左侧使推送事实成为表格最左的可见数据列，从根源上避免被右侧固定操作列覆盖——**不是靠 z-index 掩盖**。
2. **紧凑显示**：推送事实列宽 `narrow ? 108 : 132`；窄屏隐藏行内日期（`v-if="!narrow && ...dateRaw"`），日期改由 tooltip 展示（`pushFactTip(row)` 拼 `hint + ' · 推送日期 ' + date`）。`pushFact`/`hasPushTrace` 判定逻辑一字未改，仅新增纯展示拼接函数。
3. **隐藏低优先级列**：ID、字数列加 `class-name="col-optional"`，沿用既有全局 `@media(max-width:900px)` 隐藏；未改全局 CSS。
4. **响应式状态**：`narrow` ref + `resize` 监听 + `onUnmounted` 清理；与 col-optional 的 900px 断点一致。
5. **不追求全列可见**：窄屏保留 选择/推送事实/标题/状态/操作 五列；ID/账号/字数/段落/创建 隐藏。

---

## 4. 500px 可视区域相交和遮挡验证的具体数值
走查脚本：`var/tmp/s5ui2c/walk-3-3.mjs`（临时目录，不进版本库）；数据留档：`var/tmp/s5ui2c/93-result.json`；截图：`var/tmp/s5ui2c/91-33-articles-narrow.png`。真实 vite(5199) + Mock(8787) + headless Chrome CDP，不连库、不推送。

**容器几何（viewport=500）**：
- `docOverflow = false`（页面无非预期横向溢出）
- 表格 body/header wrapper：`left=97, right=467, width=370`
- 固定操作列 cell：`left=357, right=467, width=110`

**逐行推送事实单元格相交实测**（`intersect*` = 与目标的交集面积折算宽度，单位 px）：
| 行数据 | 单元格 [left,right] / 宽 | 与视口交集 | 与表格容器交集 | 与操作列重叠 | 文字与操作列重叠 |
|---|---|---|---|---|---|
| 未推送（draft 无痕迹） | [155,207] / 52 | **52** | **52** | **0** | **0** |
| 推送后已改（有痕迹+日期） | [155,231] / 76 | **76** | **76** | **0** | **0** |
| 未推送（failed 首次失败） | [155,207] / 52 | **52** | **52** | **0** | **0** |
| 未推送（漫画 comic） | [155,207] / 52 | **52** | **52** | **0** | **0** |
| 推送后已改（仅 pushDate） | [155,231] / 76 | **76** | **76** | **0** | **0** |
| 推送后已改（updated） | [155,231] / 76 | **76** | **76** | **0** | **0** |
| 已推送（pushed） | [155,207] / 52 | **52** | **52** | **0** | **0** |

**判读**：每行「与视口交集」「与表格容器交集」均**等于单元格自身完整宽度**（52 或 76），证明推送事实完整可见；「与操作列重叠」与「文字与操作列重叠」均为 **0**，证明未被固定列覆盖。7 行覆盖：有推送痕迹（推送后已改 / 已推送）、无推送痕迹（未推送，含首次失败）、漫画与普通文章。

**tooltip**：窄屏行内日期实测为 `null`（已收起）；hover「换了封面要重推的那篇」(x≈193,y≈434) 后弹出 `曾推送到草稿箱，当前内容或状态已变化；本系统不支持原地更新公众号草稿 · 推送日期 2026-11-15`，日期完整信息可查。

---

## 5. 桌面端和深色模式验证
**桌面（1424px）**：表头 10 列齐全（选择/ID/标题/账号/状态/推送事实/字数/段落/创建/操作）；`docOverflow=false`；漫画行显示「漫画」标签、普通行 `comicTag=null`；推送事实完整（含行内日期，如「推送后已改 2026-11-15」）；操作列与交互未变；控制台 **0 error**。截图 `var/tmp/s5ui2c/90-33-articles-desktop.png`。
**深色（500px，`html.dark`）**：漫画标签 `color=rgb(230,162,60)` / `bg=rgb(41,34,24)`（橙字深底），推送事实标签 `color=rgb(144,147,153)` / `bg=rgb(32,33,33)`（灰字深底），对比度正常、可读；tooltip 弹出正常。截图 `var/tmp/s5ui2c/93-33-articles-narrow-dark.png` / `92-33-tooltip-narrow.png`。

---

## 6. 自动化测试、类型检查和构建结果
| 验证 | 命令 | 结果 |
|---|---|---|
| server 类型检查 | `npm run typecheck`（server/） | ✅ exit 0 |
| web 类型检查 | `npm run typecheck`（web/） | ✅ exit 0 |
| web 生产构建 | `npm run build`（web/） | ✅ built in 12.77s |
| 推送纯函数断言 | `npm run test:article-push` | ✅ 26/26 |
| 待办跳转断言 | `npm run test:todo-nav` | ✅ 34/34 |
| 浏览器走查 | `node --experimental-strip-types var/tmp/s5ui2c/walk-3-3.mjs` | ✅ 控制台 0 error，交集数值见 §4 |
| pipeline/漫画标签契约断言 | 源码级校验（报告 §2 末） | ✅ 全部通过 |

**连库检查**：执行前已确认 `assert-article-push.mjs` / `assert-todo-nav.mjs` 无 `prisma`/`DATABASE_URL`/`fetch`/socket 等连接痕迹；typecheck/build 为纯本地编译；走查用本地 Mock。全程未连接或写入任何数据库。未安装依赖、未改 `package.json`。

---

## 7. 浏览器截图或测试证据位置
| 证据 | 路径（均在 `var/tmp/s5ui2c/`，临时目录、不进版本库） |
|---|---|
| 桌面回归 | `90-33-articles-desktop.png` |
| 500px 窄屏 | `91-33-articles-narrow.png` |
| 窄屏 tooltip | `92-33-tooltip-narrow.png` |
| 窄屏深色 | `93-33-articles-narrow-dark.png` |
| 走查原始数值 | `93-result.json` |
| 走查脚本 | `walk-3-3.mjs` |

> 夹具为手写 Mock 数据，不代表真实统计；但列布局、DOM 结构、响应式与 CSS 均为真实产物行为，可视区相交结论与实际渲染一致。

---

## 8. 未完成项及已知风险
- **未完成（本轮范围外，明确不做）**：标题/摘要独立编辑、体检问题段落定位（`blockIndex`）、`push_failed` 专项筛选——均为 S5-UI-3-0/3-2 已列出的需后端配合的延期项，本轮未触碰。
- **窄屏可见列取舍**：500px 下按计划隐藏 ID/账号/字数/段落/创建，仅保留 选择/推送事实/标题/状态/操作。标题在窄屏会被截断（保留 tooltip 看全文），属预期取舍，不追求全列可见。
- **响应式监听**：`narrow` 依赖 `resize` 事件 + `matchMedia`(900px)，与全局 col-optional 同断点；极端场景（如缩放后未触发 resize）理论上可能不同步，实际浏览器缩放/旋转均会触发 resize，风险极低。
- **Mock 数据**：浏览器证据基于 Mock；真实数据仅字段来源不同（真实后端本轮已补 `pipeline` 回传），渲染逻辑一致。
- **行尾告警**：`articles.ts` 在 Git 中显示 LF→CRLF 告警，属 Windows 行尾规范化，不影响内容。

---

## 9. Git HEAD 和工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮开始前 59 项未提交改动全部保持原样，未覆盖 / 回滚 / 清理；本轮改动叠加在 `articles.ts`、`ArticlesView.vue` 既有 modified 之上。
- **Git 写操作**：无 commit / push / reset / checkout / clean；未连库、未改 `.env`、未改 Schema/Migration、未调 LLM/微信、未推送、未安装依赖。
- **临时产物**：走查脚本/截图/JSON 位于 `var/tmp/s5ui2c/`（既有临时目录，不进版本库）；查看截图用的系统临时副本已清理；Mock(8787)/vite(5199)/Chrome(9371) 进程已停止、端口已释放。

---

## 10. 是否建议关闭 S5-UI-3-3
**建议关闭。** 判定依据：
1. A、B 两项均完成且经真实浏览器验证；B 的可视区相交用客观数值证明（交集=单元格全宽、遮挡=0），纠正了上轮「DOM 存在即判可见」的误判。
2. 类型检查、构建、两组断言、走查全绿，控制台 0 error；桌面/窄屏/深色/tooltip 均验证。
3. 无业务逻辑 / API 语义 / Schema / DB / 配置变更，无 P0/P1，风险可控。
4. 遗留项均为需后端配合的独立事项，不属于本轮范围，不阻塞本轮关闭。

**下一步**：等待人工验收；不自动进入 S5-UI-4，不提交 Git。本轮到此停止。
