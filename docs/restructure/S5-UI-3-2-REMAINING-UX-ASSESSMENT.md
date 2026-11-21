# S5-UI-3-2 · 文章工作台剩余体验问题最小化评估报告

**日期**：2026-11-17
**性质**：**只读评估**。未修改 `web/src/**`、`server/**`、API / Schema / Migration / `.env`；未连库（MySQL/SQLite 均未访问）；未调用 LLM / 微信公众号；未真实推送；未安装依赖 / 改 `package.json`；未执行 Git 写操作；未改历史实施报告。**本轮唯一新增文件为本报告。**
**结论（先给判断）**：问题 A 与问题 B 均为 **P2**（信息完整性 / 窄屏可读性），无 P0/P1，不涉及数据安全、推送门禁或流程断裂。A 的最小解 = 后端 `GET /api/articles` items 增 `pipeline: r.pipeline` **一行** + 前端标题列加漫画轻量标识；B 的真相不是「Element Plus 自动收起列」，而是**窄屏剩余列宽总和超出容器、横向滚动 + 固定操作列遮挡**所致，最小解 = 局部隐藏非核心列 + 推送事实列紧凑化。**明确推荐方案二：合并成一个小版本（S5-UI-3-2 实施轮）**，具备进入下一轮的条件，但须人工授权后实施。

---

## 1. 审计范围与实际读取文件

### 1.1 必读基线（7 份，全部实读）
`docs/restructure/RESTRUCTURE-2.0-CONVERGED-PLAN.md`、`docs/restructure/00-FINAL-EXECUTION-CHARTER.md`、`docs/restructure/TARGET-UI-ARCHITECTURE.md`、`docs/DEVLOG.md`、`web/UI-GUIDE.md`、`docs/restructure/S5-UI-3-0-ARTICLE-WORKBENCH-AUDIT.md`、`docs/restructure/S5-UI-3-1-IMPLEMENTATION-REPORT.md`。

### 1.2 实际代码核查文件（以现有代码为准，不依赖历史报告推断）
| 层 | 文件 | 核查点 |
|---|---|---|
| Schema | `server/prisma/schema.prisma` | `Article.pipeline`（367-369）、枚举 `ArticleStatus`（25-30）、索引（390-391） |
| 后端路由 | `server/src/api/routes/articles.ts` | 列表 handler（290-396）：select / items 映射 / where / member 过滤；详情 pipeline 返回（426） |
| 后端元数据 | `server/src/api/routes/system.ts` | `GET /pipelines` 下发产线文案（57-65） |
| 前端类型 | `web/src/types.ts` | `ArticleListItem.pipeline?`（766）、`ArticleDetail.pipeline?`（786）、`TodoArticleItem.pipeline`（664） |
| 前端 API | `web/src/api/index.ts` | `listArticles`（263-277）、`getPipelineMeta`（329-331） |
| 前端页面 | `web/src/views/ArticlesView.vue` | 产线筛选（346-358）、表格列定义（380-439）、scoped 样式 |
| 前端组件 | `web/src/components/StatusTag.vue` | kind="pipeline" 渲染（27） |
| 前端工具 | `web/src/utils/format.ts` | `statusMeta` pipeline 分支（76）、产线词表与兜底（232-281） |
| 前端工具 | `web/src/utils/article-push.ts` / `todo-nav.ts` | `pushFact`/`hasPushTrace`（35-108）、Dashboard 跳转参数（114-127） |
| 前端视图 | `web/src/views/DashboardView.vue` | 产线 chip（308/550）、`goArticles`（210） |
| 全局样式 | `web/src/styles.css` | 表格令牌（329-340）、响应式断点（362-378） |
| 测试脚本 | `web/scripts/assert-article-push.mjs` / `assert-todo-nav.mjs` | 现有断言覆盖 |
| Mock / 走查 | `var/tmp/s5ui2c/mock.mjs` / `walk-3-1.mjs` / `31-result.json` / `82-31-articles-narrow.png` | items 已含 pipeline（359）；窄屏断言与截图 |

### 1.3 验证方式分级（如实标注）
- **主方式：代码逐行只读核查**，精确到文件与行号。
- **窄屏视觉：复用 S5-UI-3-1 已留存的真实 dist + Mock 走查产物**——读取 `31-result.json` 的客观数据，并查看窄屏截图 `82-31-articles-narrow.png`。本轮未新起服务、未新建测试框架、未改 Mock。
- **未实测项**：未在当前时刻重新跑浏览器走查（任务书禁止为此新建复杂测试、且要求复用已有产物）；截图为 2026-11-17 S5-UI-3-1 走查留存，与当前源码一致（S5-UI-3-1 后未再改表格列）。

---

## 2. 问题 A · 文章列表缺少漫画产线标识

### 2.1 pipeline 完整传递链路（DB → 查询 → 响应类型 → 前端）
| 环节 | 现状（精确位置） | 是否就绪 |
|---|---|---|
| 数据库 | `Article.pipeline String @default("article") @db.VarChar(16)`，`schema.prisma:367-369`；**非枚举**，存量行默认 `article`，零迁移副作用；索引 `[pipeline,status]`、`[accountId,pipeline]`（390-391） | ✅ |
| 查询 where | `GET /api/articles` 支持 `?pipeline=article\|comic`（`articles.ts:310-313, 344`）；`needs` 分支隐含 `pipeline='article'`（323） | ✅ |
| 查询 select | `select` 含 `pipeline: true`（`articles.ts:366`） | ✅（已 select） |
| items 映射 | `items: rows.map(...)`（`articles.ts:383-394`）**不含 pipeline** | ❌ **断点在此** |
| 详情接口 | `GET /:id` 返回 `pipeline: a.pipeline`（426） | ✅ |
| 前端响应类型 | `ArticleListItem.pipeline?: string`（`types.ts:766`，可选）；`ArticleDetail.pipeline?`（786）；`listArticles` 返回 `ArticleListItem[]`（`index.ts:274-276`） | ✅（已声明） |
| 前端状态徽标 | `StatusTag kind="pipeline"`（`format.ts:76`）；文案由 `GET /api/pipelines` 下发（`system.ts:57-65`），App 启动注入（`App.vue:160`），兜底「文章/漫画」（`format.ts:242`），配色 comic=warning（276-278） | ✅ |
| 前端列表使用 | 产线**筛选下拉**已用 `pipelineText('article'/'comic')`（`ArticlesView.vue:357-358`）；**表格无产线列**；已 import `pipelineText`（36） | ❌ 展示缺失 |
| Dashboard | 产线 chip 已用 `pipelineText`/`pipelineTagType`（`DashboardView.vue:308,550`）；`TodoArticleItem.pipeline` 已有（`types.ts:664`） | ✅ |
| Mock | `mock.mjs` 的 `/api/articles` items **已含 pipeline**（359）——Mock 比真实后端更「先进」 | ✅（可复用走查） |

**链路结论**：全链路只有两处缺口——后端 `items` 未回传、前端列表未展示。其余（DB 字段、筛选、类型、文案、徽标、Mock、Dashboard）全部就绪。

### 2.2 任务书七问直答
1. **完整链路**：见 2.1 表。断点唯一：后端 items 映射。
2. **是否只需 `pipeline: r.pipeline`**：**是**。后端一行即可打通数据；前端类型已可选、徽标已就绪、文案走 `/api/pipelines`，无需新增类型或字段。
3. **权限/旧数据/类型/Mock/分页影响**：
   - **member 权限**：归属过滤在 `where.account = {ownerUserId}`（`articles.ts:349`），发生在 select 前；增一个返回字段不扩大可见范围（该文章本就对当前用户可见）。无影响。
   - **旧数据**：`pipeline` 有 DB 默认值 `article` 且非空，存量行不会返回 null；`StatusTag` 对空值不渲染，前端可安全按 `article` 兜底。JSON 增字段对旧调用方是向后兼容。
   - **类型**：`ArticleListItem.pipeline?` 已存在且可选，无需改。
   - **Mock**：已含 pipeline，无需改（真实后端反而需追平 Mock）。
   - **分页**：items 与 total 共用同一 `where`，加字段不触碰 `take/skip/where`，无影响。
4. **前端标识位置**：推荐**放标题列内**（`ArticlesView.vue:382-391`）而非新增独立列。标题列 `min-width=260` 有空间容纳一个小 tag；独立列至少占 60-72px 固定宽，会让本已 `750px>500px` 的表格更挤，且与问题 B 抢空间。
5. **普通文章 vs 漫画展示**：**仅漫画显示**轻量标识——标题文字后跟一个 `<StatusTag kind="pipeline" value="comic">`（warning 色「漫画」）；普通文章**不显示**（留白即默认文章），避免绝大多数行挂满「文章」标签造成噪音。不新增图标/颜色体系，复用现有词表。
   - 注意：Mock 中 id42 标题自带「（漫画）」是夹具人造文案，**真实文章 title 不带产线后缀**，不能靠标题文字判断，必须靠字段。
6. **可否保持现有筛选/Dashboard/分页/批量不变**：**可以，全部不变**。产线筛选本就存在（`?pipeline=`）；Dashboard 四类跳转走 `needs/status/pipeline` query（`todo-nav.ts:127`），与响应字段无关；分页与 `useBatchDelete`（row-key=id）与 pipeline 无关。
7. **最小改动文件 / 工作量 / 回归范围**：见 §7、§8。工作量极小（后端 1 行 + 前端约 5-10 行模板/CSS）。

### 2.3 A 评估维度表
| 评估维度 | 结论 |
|---|---|
| 当前实现 | 后端 select 含 pipeline 但 items 未回传（`articles.ts:366 vs 383-394`）；前端表格无产线列（`ArticlesView.vue:380-439`）；类型/徽标/文案/Mock 均就绪 |
| 用户影响 | 列表无法一眼区分普通文章与漫画，只能靠产线筛选下拉或进改稿页；漫画草稿混在列表中。不阻塞任何操作，无推送风险 |
| 最小解决方案 | 后端 items 加 `pipeline: r.pipeline` 一行；前端标题列内加漫画轻量 tag（仅 comic 显示） |
| 涉及文件 | 前端 `ArticlesView.vue`；后端 `articles.ts`；测试可选扩 `assert-*`；文档报告/DEVLOG。**类型、format、api、Mock 均无需改** |
| 兼容性 | 接口增字段向后兼容；member 权限不变；旧数据默认 article 不为空；类型已可选；分页/批量/Dashboard 不受影响 |
| 测试范围 | 列表宽屏/窄屏/深色、产线筛选、needs 筛选、分页、批量删除、Dashboard 四类跳转 |
| 风险 | **P2** |
| 建议 | **实施**（成本低、零风险、闭环信息链） |

---

## 3. 问题 B · 窄屏下推送事实列「被收起」

### 3.1 表格列宽、固定列、折叠规则与实际断点
`ArticlesView.vue:380-439` 的列定义（含宽）：
```
selection 46 | ID 60 | 标题 min-width 260 | 账号 110(optional) | 状态 84
| 推送事实 132 | 字数 76 | 段落 70(optional) | 创建 150(optional) | 操作 92(fixed right)
```
- **固定列**：仅「操作」`fixed="right"`（432）。
- **折叠规则**：**全项目唯一**机制是 `class-name="col-optional"` 配合 `styles.css:364-368` 的 `@media (max-width:900px){ .col-optional{display:none !important} }`。本表带 optional 的只有**账号 / 段落 / 创建**三列；**推送事实、状态列均无此类**。
- **实际断点**：900px（隐藏 optional 列）、767px（字号/面包屑）、500px（S5-UI-3-1 验证点）。
- **关键事实**：`el-table` **没有**「按断点自动收起列」的能力，也没有列宽优先级/响应式配置。900px 隐藏三列后剩余约 **750px**（46+60+260+84+132+76+92），在 500px 容器里放不下，于是 `el-table` 内部生成横向滚动，`fixed="right"` 操作列悬浮遮挡其左侧列。

### 3.2 推送事实列「看不到」的真正原因
- **不是** Element Plus 自动布局收起：EP 无此功能。
- **不是**项目 CSS 主动隐藏：推送事实列无 `col-optional`，`styles.css` 无任何针对它的隐藏规则。
- **真相**：列宽总和超出容器 → 横向滚动 + 固定操作列遮挡。**截图 `82-31-articles-narrow.png` 实证**：500px 视口内只看到 selection / ID / 标题（右侧被操作列截断）/ 操作列；**状态列与推送事实列整体落在可视区右侧之外**。
- **口径澄清**：S5-UI-3-1 报告写「窄屏 `pushCellVisible:true`」与其实施报告 §9「自动收起次要列（含推送事实/状态）」看似矛盾。实际 `walk-3-1.mjs:102` 的 `pushCellVisible` 只是 `!!document.querySelector('.push-fact-cell')`（**DOM 存在性**），不判断是否在可视区；`docOverflow:false` 只说明页面级无横向溢出（表格在自身内部滚动）。**二者都不能证明列可见**——这是「脚本判绿、用户却看不到」的根源，下一轮验收应补「可视区相交」判据（见 §8）。

### 3.3 任务书七问直答
1. 列宽/固定列/断点见 3.1。
2. 原因见 3.2（空间溢出 + 固定列遮挡，非自动收起、非 CSS 隐藏）。
3. **能否只调优先级**：可以，但单靠优先级难以让推送事实在 500px 真正可见——因为它本来就非 optional，问题是**绝对空间不够**。可行方向是把非核心列（ID 60 / 字数 76 / 状态 84）改为 optional 隐藏腾空间，并把推送事实列紧凑化。
4. **500px 下标题+推送事实+操作是否够**：**不够**。硬算最小集 `selection 46 + 标题 260 + 推送事实 132 + 操作 92 = 530px > 500px`（尚未含 ID/状态/字数）。即便隐藏 ID/字数/状态，仅这四项仍差 30px；若压标题到 180、推送事实到 100，则 418px 可放下，但标题省略更重、tag+日期易换行。结论：**物理空间紧张，无两全，须取舍**。
5. **紧凑标签 / 标题副信息 / 行展开**：
   - **行展开**（`type="expand"`）：改动最大；UI-GUIDE 5.2 的展开行语义是「父子层级」，塞推送事实属误用，且需点一下才见，违背「直接判断」初衷——**不推荐**。
   - **标题副信息**：把推送事实做成标题下方一行极简标记，省一整列宽，可读性好，但增加行高，与 UI-GUIDE 5.1「禁止换行撑高行高」有张力——**备选**。
   - **紧凑标签**：推送事实列去日期进 tooltip、宽度 132→约 96，配合隐藏 ID/字数列——**推荐**。
6. **最小/可读/维护最低的方案**：**紧凑标签 + 隐藏非核心列**。全部落在 `ArticlesView.vue` 一个文件：给 ID、字数列加 `class-name="col-optional"`（各 1 处声明），推送事实列去掉常驻日期（日期进已有 tooltip）并缩窄。复用现有 `col-optional` 机制与 `pushFact()` 纯函数，零新增组件、零全局 CSS 改动。标题副信息作为可读优先时的备选。
7. **影响面**：
   - **深色**：只改 class/列宽、沿用现有 el-tag 配色 → 不影响（S5-UI-3-1 已验证深色可读）。
   - **表格滚动**：会改变横向滚动程度（此即目的），须重测 500px 无 docOverflow、操作列不错位。
   - **操作列固定**：不删 `fixed="right"` 则机制不变。
   - **其它页面表格**：**只要不动 `styles.css` 的全局 `@media`/`col-optional` 规则，其它页面零影响**。改全局规则会波及 `AccountsView`/`ModelsView`/`PlanView`/`TracksView`/`TrackAnglesView`/`DashboardView` 等所有用 col-optional 的页面——**明确不推荐**。

### 3.4 关键区分（任务书要求）
| | 本轮目标（采纳） | 本轮明确不做 |
|---|---|---|
| 含义 | **让「推送事实」这一信息在窄屏可见**（可借紧凑 tag / 隐藏非核心列 / 副信息实现） | **让所有表格列在窄屏全部可见**（把整张桌面表格塞进手机屏） |
| 取舍 | 核心信息优先，牺牲 ID/字数等次要列 | 不追求零横向滚动前提下的全列展示 |
| 方案 | 紧凑标签 + 隐藏非核心列（或标题副信息） | 不做全列响应式重排、不做卡片墙式替代 |

### 3.5 B 评估维度表
| 评估维度 | 结论 |
|---|---|
| 当前实现 | 唯一折叠机制是 `col-optional` + 900px 媒体查询（`styles.css:364-368`）；推送事实/状态列无此类；窄屏横向溢出 + 固定操作列遮挡（`ArticlesView.vue:380-439`） |
| 用户影响 | 窄屏用户无法在列表直接判断文章是否有推送痕迹；需横向滚动或进改稿页。桌面不受影响，不阻塞主流程，无推送风险 |
| 最小解决方案 | 局部（仅 ArticlesView.vue）隐藏 ID/字数列 + 推送事实列紧凑化（日期进 tooltip、缩窄）；不动全局 CSS |
| 涉及文件 | 前端 `ArticlesView.vue`；测试走查夹具可选扩可视区判据；文档报告/DEVLOG。后端/类型/API 无涉 |
| 兼容性 | 不动全局 col-optional 规则 → 其它页面零影响；深色/固定操作列/分页/批量不变；须重测横向滚动 |
| 测试范围 | 500px 窄屏「可视区相交」判据、无 docOverflow、操作列固定、深色、横向滚动、其它页面表格抽样 |
| 风险 | **P2** |
| 建议 | **实施**（限最小方案；行展开/全局 CSS 改动不做） |

---

## 4. 两个问题的用户影响及优先级
| 问题 | 真实使用场景 | 影响 | 优先级 | 是否阻塞主流程 |
|---|---|---|---|---|
| A · 产线标识 | 用户在列表找某篇漫画草稿改分镜，漫画与普通文章混排 | 需靠产线筛选或进改稿页判断；信息不完整 | **P2** | 否（后端守卫兜底，无推送风险） |
| B · 窄屏推送事实 | 手机/窄窗口浏览文章列表，想快速看哪些推过 | 列表窄屏看不到推送事实，需横向滚动或进详情 | **P2** | 否（桌面正常；改稿页/详情可见事实） |

两者均**无 P0/P1**：不涉及数据安全、推送门禁、状态机或流程断裂。A 偏向「信息完整性」，B 偏向「窄屏可读性」，都是体验层补强。

---

## 5. 三种处理策略比较
| 策略 | 做法 | 成本 | 风险 | 优点 | 缺点 |
|---|---|---|---|---|---|
| **方案一**：独立处理 | A、B 分两轮授权、两次实施与回归 | 中 | 低 | 灵活，可按痛点先后排期 | 两次授权/回归/报告；A、B 同在 ArticlesView.vue，分开反而重复成本 |
| **方案二**：合并成小版本 ✅ | 一轮做 A 全量 + B 最小方案，共用一次回归 | **最低** | **低（可控）** | 单一文件聚集（ArticlesView.vue）+ 后端 1 行；一次 typecheck/build/走查/报告；回归面重叠 | 范围略大，需一次说清 A/B 边界 |
| **方案三**：暂不处理 | 保持现状 | 零 | 零 | 不引入任何改动 | A 后端仅 1 行、前端降噪成本极低，不做性价比低；窄屏痛点仍在；信息链继续断裂 |

**明确推荐：方案二（合并成一个小版本实施轮 S5-UI-3-2-impl）。** 理由：A、B 的代码落点高度重叠（都在文章列表 `ArticlesView.vue`，A 另有后端 1 行），合并可共用一次类型检查、构建、浏览器走查与回归；两者都是 P2、都已收敛出最小解；分两次做只会重复成本。方案三对 A 不划算（1 行后端即可闭环信息链）。

---

## 6. 推荐的下一阶段范围
**下一轮 = S5-UI-3-2 实施轮（须人工授权后启动）：**
- **A 全量**：后端 `GET /api/articles` items 增 `pipeline`；前端标题列仅对 comic 显示轻量「漫画」tag；保持筛选/跳转/分页/批量不变。
- **B 最小方案**：仅 ArticlesView.vue 内——ID/字数列加 `col-optional`；推送事实列去常驻日期（进 tooltip）并缩窄；**不动全局 CSS**。
- **明确排除**：B 的行展开方案、标题副信息方案（备选，不在本轮）、全列窄屏重排、任何全局 `col-optional`/断点改动。
- 实施后按 §8 做最低必要回归，产出实施报告并追加 DEVLOG。

---

## 7. 最小修改文件清单（下一轮范围预测，非本轮改动）
| 类别 | 文件 | 改动 |
|---|---|---|
| 后端 | `server/src/api/routes/articles.ts` | items 映射增 `pipeline: r.pipeline`（1 行） |
| 前端 | `web/src/views/ArticlesView.vue` | ① 标题列 comic 轻量 tag；② ID/字数列加 `col-optional`；③ 推送事实列紧凑化（去日期进 tooltip、缩窄） |
| 类型 | `web/src/types.ts` | **无需改**（`pipeline?` 已存在且可选） |
| 工具 | `web/src/utils/format.ts` / `article-push.ts` | **无需改**（pipeline kind、`pushFact` 均就绪） |
| 测试 | `web/scripts/assert-article-push.mjs`（可选扩展） | 可选补「窄屏无日期分支」断言；走查夹具 `mock.mjs` 已含 pipeline，无需改 |
| 文档 | 本报告 + 下一轮实施报告 + `docs/DEVLOG.md` | 实施后追加；历史报告不改 |

---

## 8. 最低必要测试清单
1. **类型/构建**：`npm run typecheck`、`npm run build`（沿用既有命令）。
2. **现有断言**：`npm run test:article-push`（26 项）、`npm run test:todo-nav`（34 项）——A/B 不应破坏这两组纯函数口径。
3. **产线标识（A）**：列表宽屏/深色下，comic 行显示「漫画」tag、article 行不显示；产线筛选 article/comic 结果与 tag 一致。
4. **推送事实窄屏（B）**：500px 下新增**可视区相交判据**（如 `getBoundingClientRect()` 与视口相交），替代仅查 DOM 存在——确认推送事实 tag 真正进入可视区；确认 `docOverflow:false`、操作列仍 `fixed` 且不错位。
5. **回归面**：needs 专项筛选（draft_unpushed/repush）、状态筛选、分页、批量删除勾选、Dashboard 四类跳转（all/draft/repush/failed/comic）。
6. **其它页面抽样**：AccountsView / ModelsView 表格深色与窄屏抽查（验证全局 CSS 未被波及）。
> 浏览器验证仅复用已有本地 Mock 与 `web/dist` / 走查脚本模式，不新建复杂测试框架、不连库、不推送。

---

## 9. 是否需要后端配合
**需要，且仅需一处**：`server/src/api/routes/articles.ts` 的 `GET /api/articles` items 映射增 `pipeline: r.pipeline`（`select` 已含该字段，无需改查询）。这是 A 的前置；B 为纯前端，无后端依赖。该改动属 `server/**`，**本轮禁止触碰**，须在下一轮单独授权后实施。

---

## 10. 风险与明确不做事项
**风险**：A/B 均为 P2，整体实施风险低。唯一需警惕的坑：
- 若 B 改动误触 `styles.css` 全局 `@media`/`col-optional`，会波及多个页面表格——**禁止改全局规则**，只在 ArticlesView.vue 局部处理。
- 窄屏验收不能只看 `pushCellVisible`（DOM 存在），必须补可视区判据，避免重演「脚本判绿、用户看不到」。
- 标题列加 tag 需注意与 `show-overflow-tooltip` 的 flex 布局，避免 tooltip 把 tag 算进标题全文。

**明确不做（本轮及下一轮范围外）**：
- 不新增 pipeline 类型或数据库字段；不改漫画业务逻辑；不把漫画状态与普通文章状态混为一谈。
- 不改状态机 / 体检规则 / 推送门禁 / 防重复推送；不部署或变更 Migration；不连库。
- 不做 B 的行展开方案、全列窄屏重排、全局响应式规则改动。
- 不做独立标题/摘要编辑、体检问题段落定位（S5-UI-3-0 已列为需后端配合的延期项，本轮不纳入）。
- 本轮不实施任何代码修改，唯一交付为本报告。

---

## 11. Git HEAD 与工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮开始前已有 **59 项**未提交改动（33 modified + 26 untracked），全部保持原样、未覆盖/回滚/清理；其中 `web/src/**`、`server/**` 的改动均为本轮开始前既有，本轮全程未触碰。
- **本轮写操作**：仅新增本报告 `docs/restructure/S5-UI-3-2-REMAINING-UX-ASSESSMENT.md` 一个文件；未执行任何 commit / push / reset / checkout。阅读截图时曾将一张已有走查截图复制到系统临时目录仅供查看，属临时副本，不在项目内，现已清理，不影响工作区。

---

## 12. 是否具备进入下一轮实施的条件
**具备。** 判定依据：
1. 问题 A 的链路断点已精确定位（后端 items 一行），其余环节（DB/类型/文案/徽标/Mock/Dashboard）全部就绪，最小解无歧义。
2. 问题 B 的成因已被截图与客观数据证伪「自动收起」的旧表述，锁定为「列宽溢出 + 固定列遮挡」，并收敛出不动全局 CSS 的局部最小方案。
3. 两问题均为 P2，无数据/推送/流程风险，符合「只做体验层补强、不碰后端业务」的分阶段授权边界。
4. 推荐范围（方案二）已收敛为「后端 1 行 + 前端单文件改动 + 一次共用回归」，影响面可控、可回滚。
5. 回归清单与窄屏验收口径已明确（补可视区判据）。

**下一步**：等待人工验收本报告并授权 S5-UI-3-2 实施轮；授权前不动任何代码。本轮到此停止。
