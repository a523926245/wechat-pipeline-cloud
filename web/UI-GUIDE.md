# Web UI 约定（组件优先）

本项目前端基于 **Vue 3 + Element Plus 2.8.8**。Element Plus 已在 `src/main.ts` 全局注册，
**所有页面都应以 Element Plus 组件为优先**——库有组件就用，库没有才自研。

> S5-UI-1 变更摘要：令牌两段合并为一处、新增字号五档、顶栏改面包屑（不再重复页面标题）、
> 系统状态移入右上角浮层、新增 5 个公共组件（PageHead / StatusTag / EmptyState / SaveBar / TaskProgress）、
> 状态词表统一到 `utils/format.ts`。本文与代码不符处以代码为准，并应尽快回来改本文。

## 1. 组件优先原则
- 能用 `el-*` 组件实现的，不要手写 `div` + CSS。例如：
  - 表格 → `el-table`；行内操作菜单 → `RowActions`（基于 `el-dropdown`）；
  - 表单 → `el-form` + `el-form-item`，校验用 `:rules` + `prop`（**禁止**手写 `.field-error`）；
  - 筛选条 → `el-form inline` + `el-select` + `el-input` + 搜索/重置按钮；
  - 弹窗 → `el-dialog`；详情展示 → `el-descriptions`；图片 → `el-image`；
  - 加载态 → `v-loading`；标签页 → `el-tabs`；步骤/折叠 → `el-collapse`。
- **允许自研（库无等价）**：
  - `ArticleEditView` 的 HTML 源码编辑器 `<textarea class="src-editor">`（刻意不用 wangEditor）；
  - `BrandLogo` 品牌 SVG；`RowActions` 作为 EP 的薄封装。

### 1.1 公共组件（S5-UI-1，页面必须优先使用）

| 组件 | 用途 | 关键约束 |
|---|---|---|
| `PageHead` | 页面标题区：`title` + `desc` + `#actions` 插槽 | 每个页面**只在这里**写主标题（h1）；标题字号/行高由 `.wb-page-head h1` 统一给 |
| `StatusTag` | 统一状态徽标：`kind` + `value` | 词表在 `utils/format.ts`，**禁止**页面自建映射；未知值原样显示 |
| `EmptyState` | 空状态：`description` + `hint` + 默认插槽（下一步动作） | 只表达「查询成功但没有数据」，**不得**用于错误态 |
| `SaveBar` | 保存状态条：`clean/dirty/saving/saved/error` + `@save` | 只管展示与转发保存意图，不实现保存逻辑 |
| `TaskProgress` | 任务状态：`status` + 可选 `stage/message/progress` | **只展示后端已记录的事实**；没有真实百分比就不画进度条 |
| `StateError` | 错误态 + 重试 | 唯一的错误入口，异步数据必须有可恢复路径 |
| `BatchBar` | 勾选后的批量操作条 | 与 `useBatchDelete` 配套，目前只承载删除 |

`StatusTag` 的 `kind` 取值与语义：

| kind | 取值 | 说明 |
|---|---|---|
| `article` | draft / updated / pushed / failed | 文章状态（与推送状态同源） |
| `angle` | candidate / needs_revision / approved / rejected | 选题**审核态** |
| `verdict` | approved / needs_revision / rejected | 审核**动作**（历史记录里的「通过/要求修改/拒绝」），文字与审核态不同，不可合并 |
| `task` | pending / running / success / failed / canceled（兼容 ok/error/skipped） | TaskRun 状态 |
| `pipeline` | article / comic | 产线，文案由 `GET /api/pipelines` 下发 |
| `usage` | used / unused | 选题**消费态**（与审核态是两个维度） |

### 1.2 页面骨架与标题职责

- **顶栏只回答「我在哪」**：面包屑 `首页 / 分组 / 父级（下钻页）/ 当前页`，
  分组名来自 `App.vue` 的完整菜单定义（`MENU_GROUPS`），与角色过滤无关。
- **页面内只回答「这是什么页」**：`PageHead` 的 `title`（h1）+ `desc`（一句话用途）。
- **两者不得重复显示同一个标题**。`document.title` 仍由路由 `meta.title` 维护。
- 下钻页（`/articles/:id`、`/tracks/:id/angles`）的面包屑会多一级父栏目并可点击返回。
- 新增页面时：在 `router/index.ts` 写 `meta.title`（面包屑与文档标题），
  在 `App.vue` 的 `MENU_GROUPS` 里登记分组与角色，页面内用 `PageHead` 写标题。

## 2. 设计令牌（只引用变量，禁止硬编码颜色/像素）

定义在 `src/styles.css` 的 `:root`（**唯一真源，浅色/深色同尺度**）。深色只在 `html.dark` 翻颜色类令牌。

**颜色**
- 表面与文字：`--wb-bg` `--wb-surface` `--wb-surface-muted` `--wb-border` `--wb-border-strong`
  `--wb-text` `--wb-text-secondary` `--wb-text-muted` `--wb-text-strong`
- 品牌（主色 `#0a7c47` 不可改）：`--wb-primary` `--wb-primary-soft` `--wb-primary-soft-2`
  `--wb-primary-grad` `--wb-nav-active-bg` `--wb-chip-bg` `--wb-ring`
- 状态：`--wb-success` `--wb-danger` `--wb-danger-soft` `--wb-danger-border` `--wb-warning` `--wb-warning-soft`

**字号五档**（不要再写 11.5 / 12.5 / 13.5 这类半档）
- `--wb-fs-page` 20px 页面标题（PageHead h1）
- `--wb-fs-module` 15px 模块标题（卡片内小标题）
- `--wb-fs-body` 14px 正文（body 默认）
- `--wb-fs-aux` 12px 辅助文字（说明、标注、表内次要信息）
- `--wb-fs-num` 22px 数字指标（环形进度中心、指标卡数值）

**间距**：`--wb-space-1..6`（4/8/12/16/24/32px）、`--wb-gap:16px`

**圆角两档**：`--wb-radius-sm` 6px（控件、标签、内嵌块）、`--wb-radius` 10px（卡片、面板）

**阴影两档**：`--wb-shadow-card`（静态卡片）、`--wb-shadow-pop`（对话框/下拉/抽屉）

布局工具类（已内置，直接用）：
- `.wb-page` 页面纵向骨架；`.wb-page-head` 标题+操作区（配合 `PageHead`）
- `.wb-filter-bar` 内联筛选表单容器
- `.wb-pager` 右对齐分页条；`.wb-form-actions` 右对齐表单操作区
- `.wb-chip` 图标芯片；`.wb-muted` `.wb-secondary` `.wb-danger-text` 文本色
- `.col-optional` 表格次要列，窄屏（≤900px）自动隐藏

> 自查：改完样式后跑一遍「未定义令牌」检查（`var(--wb-*)` 必须在 `:root` 里有定义），
> 悬空令牌会静默失效（圆角变 0、颜色继承），肉眼很难发现。

## 3. 三态模式（全站统一）
| 状态 | 用法 |
|------|------|
| 加载 | 容器加 `v-loading="loading"` + `element-loading-text` |
| 空   | `<EmptyState description="..." hint="..." :image-size="60">下一步按钮</EmptyState>` |
| 错误 | `<StateError :message="err" label="加载失败" @retry="reload" />`（唯一入口） |

错误/空态出现时，列表/卡片应整体让位，不要叠加显示。

### 3.1 空状态 vs 错误状态（不要混用）

| | 空状态 `EmptyState` | 错误状态 `StateError` |
|---|---|---|
| 含义 | 请求成功，但确实没有数据 | 请求失败，数据未知 |
| 文案 | 说清「为什么空」+「怎么才会有」 | 说清失败原因 + 重试 |
| 出口 | 新增 / 重置筛选 / 去配置 | 重试 |
| 禁止 | 用空态掩盖失败（用户会以为业务本来就没有数据） | 把错误写成「暂无数据」 |

三种空态语义靠文案区分，不新增状态值：**无数据**（"还没有赛道，新增一个开始创作"）、
**搜索无结果**（"没有匹配的账号" + 清空搜索）、**无可用数据**（"暂无可排产账号（需凭据就绪且启用）"）。

### 3.2 保存状态（`SaveBar` 五态）

| 状态 | 含义 | 界面 |
|---|---|---|
| `clean` | 没有改动 | 灰点 +「无未保存改动」，保存按钮隐藏 |
| `dirty` | 有未保存改动 | 黄点 +「有未保存改动」+ 可点保存 |
| `saving` | 请求进行中 | 「保存中…」按钮 loading（防重复提交） |
| `saved` | 已保存 | 绿点 +「已保存」+ 上次保存时间（走 `hint`） |
| `error` | 保存失败 | 红点 +「保存失败」+ 失败原因 + 可重试 |

页面侧只负责算出状态、提供 `@save` 回调；**不要**在页面里再写一套「未保存」小标签。

## 4. 表单与弹窗规范
- 所有表单用 `el-form`：`ref` + `:model` + `:rules`，提交前 `await formRef.validate()`。
- 字段错误**由 EP 原生渲染**（红色提示 + 输入框红框），删除手写 `.field-error` 与 `errors` 对象。
- 弹窗 `el-dialog` 宽度用响应式：`width="min(560px, 92vw)"`，避免窄屏溢出。
- 弹窗底部操作统一放 `#footer`：`取消`（`@click` 关闭）+ `确定/保存`（`type="primary"` `:loading="saving"`）。
- 表单 `label-width` 统一（列表页 `72px`，配置页 `110px`）。

## 5. 响应式
- 表格次要列加 `class-name="col-optional"`。
- 筛选条/操作区允许 `flex-wrap`。
- 窗口变窄：侧边栏 <1180px 自动收起（`App.vue` 已处理）；<992px 改稿页单栏；<900px 隐藏 `col-optional` 与顶栏后端状态标签（状态仍可在右上角浮层看）；<767px 正文缩小、面包屑只留末两级。
- 弹窗宽度用 `min()` 表达式适配窄屏。

## 5.1 表格列宽与超长文本
- **数字/状态列给固定 `width`**（ID/配额/启用/各类计数/操作），**文本列给 `min-width` 并加 `show-overflow-tooltip`**。
- `min-width` 列会按比例分摊表格剩余宽度——宽屏自动撑满不留白，窄屏压到下限时出省略号；
  tooltip 只在真的溢出时才弹（已验证 EP 源码：`scrollWidth > 宽度` 才 createTablePopper），
  且自定义插槽一样有效，可放心配合 `#default` 插槽使用。
- **不要把文本列写成固定 `width`**：内容区比列宽总和大时，剩余宽度全部堆在表格右侧形成大片留白；
  也不要整张表都用 `min-width`：数字/状态列会被等比拉得过宽。
- 超长文本统一「单行省略 + 悬停 tooltip 看全文」，**禁止换行撑高行高**。
- 次要列一律带 `class-name="col-optional"`。

## 5.2 层级数据（父子资源）
- 父子两层都要「看得见 + 能操作」时，用 **`el-table` 展开行**（`row-key` + `:expand-row-keys` + `<el-table-column type="expand">`），
  **不要用弹窗**——弹窗会把子层信息藏起来，主表上看不到「子层缺料」这类关键信号。
- 展开区背景用 `--wb-surface-muted`（比主表深一档，表达"下一层"），内嵌子表用 `size="small"`。
- 子层数据随列表一起拉（父级数量级很小）；单条拉取失败只降级该行，不整页报错。
- 展开区就地编辑要**显式保存**：用打开时的快照做 dirty 检测（`JSON.stringify` 对比），
  保存条用 `SaveBar`（dirty/saving/clean），不要自己拼「有未保存改动」标签 + 按钮。
- 展开状态受控（`expandedKeys`）：点箭头（`expand-change`）与点行菜单走同一份状态。

## 5.3 批量操作（勾选 + 批量删除）

有删除动作的列表页**都要支持批量删除**（选题库 / 文章 / 账号 / 赛道 / 模型）。
统一用 `composables/useBatchDelete.ts` + `components/BatchBar.vue`，不要每页各写一套。

- **表格三件套**（缺一不可）：
  1. `<el-table row-key="id">` —— `row-key` 是跨页勾选的前提；
  2. `<el-table-column type="selection" width="46" reserve-selection />` —— `reserve-selection`
     让勾选在翻页后保留；
  3. `@selection-change="batch.onSelectionChange"` —— 把选中行交给 composable。
- **表格上方放 `<BatchBar>`**（有勾选时才出现）：显示「已选 N 项」+ 批量删除 + 取消选择。
- **换筛选条件要清空勾选**：EP 的 `reserve-selection` 换筛选后**不会**自动清，
  旧勾选指向另一个结果集，留着会删到用户看不见的行。
  页面里 `watch(筛选条件, () => batch.clearSelection())`。
- **`clearSelection()` 要同时清 EP 内部状态**：只清 composable 里的数组不够，
  EP 内部还留着那些行，下次 render 勾选框仍显示"已勾"。composable 已处理
  （需把表格实例通过 `tableRef` 传进去）。
- **确认弹窗必须讲清影响面**：用 composable 的 `impact(rows)` 回调，按资源写具体数字
  （删账号要说"会连带删掉名下文章"，删选题要说"多少条正在被文章用着"）。
- **部分失败要逐条告知**：后端逐条独立执行，可能一部分成功一部分失败。
  不能只弹"操作成功"——composable 已统一处理（失败项 id + 原因）。
- **删除按钮用 `type="danger"`**，且**删除期间禁用**（`deleting` 状态）防重复提交。
- 表格有展开行（`type="expand"`）时，selection 列放在展开列**之后**。

## 5.4 配置页（左导航 + 单面板 + 未保存保护）
配置项会随赛道/模型增长，**不要把所有表单竖排铺开**——超过三四项就变成一屏文本框，找东西全靠滚。
文风配置页（`StylePromptsView`）是样板：

- **两栏骨架**：左侧 `236px` 固定导航（`position: sticky`，带筛选框），右侧单面板；
  某一项内部字段多时再分 `el-tabs`，不做长页滚动。窄屏 `<992px` 回退单列。
- **缓冲区 + 快照双份**：`buf` 可随意改，`saved` 存服务端值，`isDirty = buf[k] !== saved[k]`。
  ⚠️ `saved[k]` 对没落库的 key 是 `undefined`，必须先补成 `''`，否则空配置会被误判成有改动。
- **dirty 信号要三处齐备**：顶部汇总条（N 处未保存 + 全部保存 + 放弃改动）、
  导航项/Tab 上的小圆点、面板底部的 `SaveBar`。只给一处，用户换个面板就看不见了。
- **离开保护**：`onBeforeRouteLeave` + `beforeunload` 拦一次，文案写清有几处没保存；
  另外支持 `Ctrl/Cmd + S` 保存当前面板（配 `preventDefault`）。
- **底部操作条 `position: sticky; bottom: 0`**：列表/条目很长时保存按钮不用往上翻。
- **「一行一条」的库不要用整块 textarea**：抽成行编辑器（`components/VariantLinesEditor.vue`），
  行序即语义顺序，支持增删/上移/下移，对外仍拼回纯文本。
  前端校验正则必须与后端解析函数**逐字同源**，否则前端说合规、后端解析失败。
- **「恢复默认」只填缓冲区**，不直接写库，且要二次确认——直接覆盖用户的编辑内容是不可逆操作。

## 6. 主题
- 主色 `--el-color-primary: #0a7c47`（微信品牌绿），**禁止改动**，否则破坏全站一致性。
- 深色由 `html.dark` 激活（`useTheme`），**只翻颜色类令牌**；字号/间距/圆角/阴影不随主题变化。
- 新增语义色只允许加在 `styles.css` 的 `:root`（并在 `html.dark` 给出深色值），
  禁止在组件 scoped 样式里写死色值。
- 顶栏右上角「系统状态」浮层（`Odometer` 图标）是健康信号的唯一常驻入口：
  数据库/密钥/调度/模型计数/角色绑定；有硬健康异常时按钮带红点。数据来自 `GET /api/dashboard/status`，不新增接口。
