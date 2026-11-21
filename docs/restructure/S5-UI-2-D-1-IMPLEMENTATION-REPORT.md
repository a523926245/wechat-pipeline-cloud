# S5-UI-2-D-1 实施报告 · 多赛道待审核选题跳转承接

**日期**：2026-11-17
**来源**：`S5-UI-2-C-WORKBENCH-FLOW-AUDIT.md` 问题清单 **P1-1**（多赛道「去审核」落 `/tracks`，赛道页没有任何待审线索）
**边界**：只改前端跳转与赛道页承接；后端、Schema、API 契约、权限、审核状态机一律未动

---

## 1. 问题根因

修复前（S5-UI-2-C-P0-FIX 之后）：

```ts
// web/src/utils/todo-nav.ts
export function anglesTopTarget(tracks) {
  if (tracks.length !== 1) return { path: '/tracks' };   // ← 信息在这里断掉
  ...
}
```

工作台**本来就拿到了**每个赛道的待审分布（`byTrack: [{trackId, track, candidate, needsRevision}]`，
由后端 `angle.groupBy({by:['trackId','status']})` 汇总），但多赛道分支把这个信息丢掉了，
只 push 一个裸 `/tracks`。赛道管理页也不读任何路由参数，于是用户落到一张普通赛道表，
还得自己逐个点「选题池」去找哪条赛道有题要审——待办入口只完成了一半。

---

## 2. 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `web/src/utils/todo-nav.ts` | 修改 | 新增 `pendingTrackParam` / `parsePendingTrackIds`；`anglesTopTarget` 多赛道分支带 `?pending=` |
| `web/src/views/TracksView.vue` | 修改 | 读取 `pending`、页面级提示条、行内「待审核」标签、「只看全部赛道」清除动作、相关样式 |
| `web/scripts/assert-todo-nav.mjs` | 修改 | 断言 15 → **27** 项（新增参数生成 + 参数解析两组） |
| `docs/DEVLOG.md` | 修改 | 追加本轮进度 |
| 本文件 | 新增 | 验收报告 |

**`DashboardView.vue` 无需改动**：`goAnglesTop()` 已经是 `router.push(anglesTopTarget(byTrack))`，
落点参数由纯函数决定——这正是上一轮把判定抽出组件的好处。
**未修改**：`server/**`、Prisma Schema、Migration、`.env`、`localStorage`、权限与路由守卫、
`StatusTag` / `PageHead` 等 S5-UI-1 公共设计系统、文章相关页面。

---

## 3. 跳转参数设计

```
/tracks?pending=3,5
```

| 规则 | 实现 |
|---|---|
| 只在**多赛道**时携带 | 单赛道仍走 `/tracks/:id/angles?used=unused&status=…`，行为与 P0 修复后完全一致 |
| ID 来自真实数据 | 取 `byTrack` 的 `trackId`，且要求 `candidate + needsRevision > 0`（0/0 的赛道不写） |
| 稳定可分享 | 去重 → 按 id 升序 → `join(',')`；同一状态永远生成同一个 URL（断言钉住「逆序输入同结果」） |
| 非法值丢弃 | `parsePendingTrackIds` 只接受正整数（`Number.isInteger(id) && id > 0`），数组形式（`?pending=3&pending=5`）也支持 |
| 有上限 | 最多 50 个 id，防止手工拼超长 URL |
| 无待审赛道 | `pendingTrackParam` 返回空串 → 落点退化为裸 `/tracks`（不产生 `?pending=`） |

**为什么不带数量**：赛道列表接口 `/api/tracks` 不返回待审计数，只有 `angleUnused/angleTotal`。
按任务要求「只有在数量有可靠数据来源时才能显示」，页面**不显示数量**，只显示「有待审核选题」这个事实。
要显示数量需要给 `/api/tracks` 加字段（本任务禁止）——已列入 §7 未解决事项。

---

## 4. 赛道页承接方式

1. **页面级提示条**（`el-alert type="info"`，不可关闭，复用既有 alert 风格，不用警告色）：

   > 从工作台待办进入：2 个赛道有选题等待审核
   > 星座、育儿 —— 点该行「选题池」进入后，用「审核」下拉筛选候选 / 待修改。   **只看全部赛道**

   文案明确说明「这是待办入口」，不会被误读成赛道异常或运行失败；「只看全部赛道」= 去掉 URL 参数。

2. **行内标记**：赛道名右侧一个小 `el-tag type="warning" effect="plain" size="small"`，文字「待审核」，
   hover 提示「该赛道有候选 / 待修改选题等待人工审核（来自工作台待办）」。仅参数命中的行才出现。

3. **只标记真实存在的赛道**：`pendingTracks = items.filter(id ∈ pending)`。
   URL 里的过期/无效 id 不会凭空造出标记。

4. **无参数 = 零变化**：`parsePendingTrackIds(undefined)` → `[]` → 不渲染提示条、不加标签、不加任何 class。

5. **窄屏取舍**：≤1024px 时隐藏行内标签（表格列宽合计本就超过视口，半个标签比没有更糟），
   此时以顶部提示条为准——它同样列出赛道名。赛道列宽度保持原 `min-width: 180`，未因加标签而抢宽度。

---

## 5. 验证场景与结果

### 5.1 纯函数断言：`cd web && npm run test:todo-nav` → **27/27 通过**

```
[4] 多赛道：落赛道列表并带上待审赛道 id（S5-UI-2-D-1）
  ✓ 两个赛道 → /tracks
  ✓ URL 带 pending=3,5（升序，来自真实 byTrack）
  ✓ 顺序稳定：输入逆序也得到同一个 URL
  ✓ 同一赛道重复出现 → 去重
  ✓ 分布为 0/0 的赛道不写入参数（不误标）
  ✓ 非法 id（0 / 负数 / 小数 / NaN）被丢弃
  ✓ 没有赛道 → 赛道列表，且不带 query
[5] pending 参数解析（赛道页承接）
  ✓ "3,5" → [3,5]        ✓ 容忍空格 / 空段     ✓ 去重并排序
  ✓ 无效 id 安全忽略      ✓ 数组形式            ✓ 缺省 / null / 对象 → 空数组
  ✓ 解析与生成互逆：pendingTrackParam → parsePendingTrackIds
```

原有 15 项（单赛道 P0 场景、优先候选、两者为 0、明细透传、`used=unused` 恒定）全部保持通过。

### 5.2 浏览器复测（真实 `web/dist` + 本地 Mock，headless Chrome 点击）

| # | 场景 | 预期 | 实际 |
|---|---|---|---|
| A | 多赛道点「去审核」 | `/tracks?pending=3,5` + 提示条 + 两行标签 | ✅ `url=/tracks?pending=3,5`，提示条「2 个赛道…」，两行均 `待审核` |
| B | 刷新（URL 保留） | 提示仍在 | ✅ 同上，`Page.reload` 后完全一致 |
| C | 仅一个赛道待审（`?pending=5`） | 只有该赛道标记 | ✅ 提示条「1 个赛道…」，只有「育儿」行有标签 |
| D | 无效 id（`?pending=999,abc,-1`） | 安全忽略 | ✅ 无提示条、无标签，页面即普通列表 |
| E | 点「只看全部赛道」 | 恢复普通列表 | ✅ URL → `/tracks`，提示条与标签全部消失 |
| F | 直接进 `/tracks`（无参数） | 与改造前一致 | ✅ 仅原有说明条，无新增元素 |
| G | 单赛道工作台跳转 | 原逻辑不变 | ✅ `/tracks/5/angles?used=unused&status=needs_revision` |
| H | 选题明细跳转 | 原逻辑不变 | ✅ 同上（明细带自身真实 status） |

截图（`var/tmp/s5ui2c/`，未进版本库）：
`30-d1-multi-pending.png`（1440 主场景）、`31-d1-after-reload.png`、`32-d1-single-marked.png`、
`33-d1-cleared.png`、`34-d1-dark.png`（深色，无浅色残留）、`35-d1-narrow.png`（900，改前标签残缺）、
`36-d1-w900/1200/1440.png`（改后用三个宽度复核）。原始结果 JSON：`d1-result.json`。

**深色**：提示条与标签在 `html.dark` 下正常（信息色底 + 浅色文字，无过亮块）。
**窄屏**：900px 下无残缺色块；表格本身在 ≤1200px 会被挤压（选题池列被裁）——这是**既有**布局问题
（列宽合计约 1238px > 视口），本轮未改变其性质，也没有新增横向滚动。

---

## 6. 浏览器复测结论

多赛道待办从「落到赛道表、自己找」变成「落到赛道表 + 直接点名哪几个赛道要审 + 给出口（只看全部）」，
刷新保持、参数可手工移除、非法参数安全降级；单赛道与明细两条既有链路一字未改。

---

## 7. 未解决问题

1. **不显示待审计数**：`/api/tracks` 无该字段；要显示需后端加 `candidate/needsRevision` 聚合（属后端改动，本轮禁止）。
   影响：用户知道「哪几个赛道」，但不知道「有几条」。当前可从工作台卡片读到总数。
2. **行内标签在 ≤1024px 隐藏**：以顶部提示条为准（已列赛道名）。若要在窄屏也保留行内标记，
   需先解决表格列宽合计超出视口的老问题（表头会被压成竖排），属独立任务。
3. **未做「点标签直接进待审筛选」**：TracksView 不知道赛道内候选/待改的分布（URL 只带 ID），
   若猜 `status=candidate` 就会重演 P0 的空列表问题；当前保持「进选题池后自己选审核态」，
   与既有「选题池」入口一致。要做精确直达，需把每赛道的状态分布也带进 URL（格式会变复杂），另行评估。
4. **未连真实后端**：复测走 Mock 夹具，验证的是「参数生成 → URL → 页面承接」这条链路；
   真实数据下的分布由 S5-UI-2-B 的后端冒烟（51 项）保证。
5. 审计报告里其余 P1（文章待重推无法精确筛选、批次失败跳 `/plan` 无原因）与 member 体检权限问题**按授权未处理**。

---

## 8. Git 工作区

- HEAD 仍 `b2fbad3`，**未 commit / push / reset / checkout**。
- 本轮修改 `M`：`web/src/utils/todo-nav.ts`、`web/src/views/TracksView.vue`、`web/scripts/assert-todo-nav.mjs`、`docs/DEVLOG.md`
- 本轮新增 `??`：本报告
- `DashboardView.vue`、`web/package.json`、`server/**`、Schema、API 及其他所有未提交内容（S5-UI-1/2-B/2-C、P0 修复产出）**原样保留，未覆盖**。
