# Web UI 约定（组件优先）

本项目前端基于 **Vue 3 + Element Plus 2.8.8**。Element Plus 已在 `src/main.ts` 全局注册，
**所有页面都应以 Element Plus 组件为优先**——库有组件就用，库没有才自研。

## 1. 组件优先原则
- 能用 `el-*` 组件实现的，不要手写 `div` + CSS。例如：
  - 表格 → `el-table`；行内操作菜单 → `RowActions`（基于 `el-dropdown`）；
  - 表单 → `el-form` + `el-form-item`，校验用 `:rules` + `prop`（**禁止**手写 `.field-error`）；
  - 筛选条 → `el-form inline` + `el-select` + `el-input` + 搜索/重置按钮；
  - 弹窗 → `el-dialog`；详情展示 → `el-descriptions`；图片 → `el-image`；
  - 空态 → `el-empty`；加载态 → `v-loading`；错误态 → `StateError`；
  - 标签页 → `el-tabs`；步骤/折叠 → `el-collapse`；状态徽标 → `el-tag`。
- **允许自研（库无等价）**：
  - `ArticleEditView` 的 HTML 源码编辑器 `<textarea class="src-editor">`（刻意不用 wangEditor）；
  - `BrandLogo` 品牌 SVG；`StateError` / `RowActions` 作为 EP 的薄封装。

## 2. 设计令牌（只引用变量，禁止硬编码颜色/像素）
定义在 `src/styles.css` 的 `:root`：
- 语义色：`--wb-bg` `--wb-surface` `--wb-text` `--wb-text-secondary` `--wb-text-muted`
  `--wb-border` `--wb-border-strong` `--wb-primary` `--wb-primary-hover` `--wb-primary-soft`
  `--wb-danger` `--wb-warning`
- 尺度：间距 `--wb-space-1..5`（`4/8/12/16/24px`）、`--wb-gap:16px`；
  圆角 `--wb-radius:10px` `--wb-radius-sm:6px` `--wb-radius-lg:14px`
- 阴影：`--wb-shadow-card` `--wb-shadow-pop`

布局工具类（已内置，直接用）：
- `.wb-page` 页面纵向骨架；`.wb-page-head` 标题+操作区
- `.wb-filter-bar` 内联筛选表单容器
- `.wb-pager` 右对齐分页条；`.wb-form-actions` 右对齐表单操作区
- `.wb-chip` 图标芯片；`.wb-muted` `.wb-secondary` `.wb-danger-text` 文本色
- `.col-optional` 表格次要列，窄屏（≤900px）自动隐藏

## 3. 三态模式（全站统一）
| 状态 | 用法 |
|------|------|
| 加载 | 容器加 `v-loading="loading"` + `element-loading-text` |
| 空   | `<el-empty description="..." :image-size="60" />`（文案统一） |
| 错误 | `<StateError :message="err" label="加载失败" @retry="reload" />`（唯一入口） |

错误/空态出现时，列表/卡片应整体让位，不要叠加显示。

## 4. 表单与弹窗规范
- 所有表单用 `el-form`：`ref` + `:model` + `:rules`，提交前 `await formRef.validate()`。
- 字段错误**由 EP 原生渲染**（红色提示 + 输入框红框），删除手写 `.field-error` 与 `errors` 对象。
- 弹窗 `el-dialog` 宽度用响应式：`width="min(560px, 92vw)"`，避免窄屏溢出。
- 弹窗底部操作统一放 `#footer`：`取消`（`@click` 关闭）+ `确定/保存`（`type="primary"` `:loading="saving"`）。
- 表单 `label-width` 统一（列表页 `72px`，配置页 `110px`）。

## 5. 响应式
- 表格次要列加 `class-name="col-optional"`。
- 筛选条/操作区允许 `flex-wrap`。
- 窗口变窄：侧边栏 <1180px 自动收起（`App.vue` 已处理）；<992px 改稿页单栏；<900px 隐藏 `col-optional`；<767px 正文缩小。
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
  显示「有未保存改动」标记 + 保存按钮（无改动时禁用），避免改完忘了保存或刷新丢失。
- 展开状态受控（`expandedKeys`）：点箭头（`expand-change`）与点行菜单走同一份状态。

## 6. 主题
- 主色 `--el-color-primary: #0a7c47`（微信品牌绿），**禁止改动**，否则破坏全站一致性。
- 新增语义色只允许加在 `styles.css` 的 `:root`，禁止在组件 scoped 样式里写死色值。
