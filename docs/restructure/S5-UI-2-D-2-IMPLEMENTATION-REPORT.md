# S5-UI-2-D-2 实施报告 · 文章待办精确筛选闭环

**日期**：2026-11-17
**决策依据**：D1 `repush` 含 `status='updated'`；D2 用 Prisma `equals: ''`、不引 Raw SQL；D3 授权改 `routes/articles.ts`；D4 列表响应不加 `pipeline`；D5 `needs` 优先于 `status`
**结论**：后端参数 + 前端承接全部实现，隔离库冒烟 **67/67**、前端断言 **34/34**、`vue-tsc` 0、`build` ✓；浏览器 8 场景通过。

> 本文件首版是「核查后停止」的只读报告（未实施）；本轮按 D1–D5 决策正式实施，内容已整体重写为实施报告。

---

## 1. 后端参数实现

`GET /api/articles?needs=draft_unpushed|repush`（`server/src/api/routes/articles.ts:289-345`）

| 规则 | 实现 |
|---|---|
| 只认两个字面值 | `needsRaw === 'draft_unpushed' \|\| needsRaw === 'repush'`，其余**按未传处理**（不 400） |
| `needs` 优先 | `needs` 存在时走独立分支：`status` / `pipeline` 均不参与（已在路由注释写明） |
| 隐含 `pipeline='article'` | 两个分支都先 `where.pipeline='article'`，漫画天然排除 |
| 可叠加 | `accountId` / `angleId` / `limit` / `offset` 照常拼装；member 归属过滤（`where.account.ownerUserId`）位置不变 |
| items 与 total 同源 | 两者都读同一个 `where` 对象，**没有第二套条件**；`limit` 上限 100、`offset` 语义未改 |

---

## 2. Prisma where 条件

```ts
// needs=draft_unpushed
{
  pipeline: 'article',
  status: 'draft',
  mediaId: '',      // D2：精确空串，不 TRIM、不 Raw SQL
  pushDate: '',
}

// needs=repush
{
  pipeline: 'article',
  OR: [
    { status: 'updated' },                                            // 已改写等推送
    { status: 'draft',
      OR: [{ mediaId: { not: '' } }, { pushDate: { not: '' } }] },     // 草稿但有推送痕迹（换封面退回）
  ],
}
```

要点：
- 内层 `OR` 是「两个字段任一非空」，外层 `OR` 的两支各自带 `status`，所以 **`status` 与推送痕迹是 AND、两个字段之间是 OR**；没有写成 `status='draft' OR mediaId!=''` 那种会把 pushed 全捞进来的错误结合。
- 顶层 `pipeline='article'` 与 `account` 过滤对所有分支 AND 生效。

---

## 3. 前端筛选与跳转

**纯函数**（`web/src/utils/todo-nav.ts`，新增 2 个导出）

| 函数 | 作用 |
|---|---|
| `articlesNeedsQuery(kind)` | `draft_unpushed`/`repush` → `{needs}`；`failed` → `{status:'failed'}`；`comic` → `{status:'draft',pipeline:'comic'}`；`all` → `{}` |
| `parseArticleNeeds(raw)` | 只认两个字面值，其它一律 `undefined`（空串、数组、大小写不符、带空格） |

**Dashboard**（`DashboardView.vue` 的 `goArticles`）：改调 `articlesNeedsQuery`，
`未推送草稿 → /articles?needs=draft_unpushed`、`待重推 → /articles?needs=repush`；
推送失败 / 漫画 / 「去文章」/ 明细行跳转**一字未改**。

**列表页**（`ArticlesView.vue`）

- `needs = computed(() => parseArticleNeeds(route.query.needs))`；请求时传 `needs`，且**不再发** `status` / `pipeline`（页面显示与请求保持一致）。
- `watch` 数组加入 `needs`（刷新/返回/改参数都会重新加载，并清空跨页勾选）。
- 顶部提示条：`当前筛选：未推送草稿` / `当前筛选：待重推文章` + 条件说明 + 「清除筛选」。
- 状态下拉与产线下拉在 `needs` 生效时 `disabled`，占位文案「待办筛选中」，提示条写明「专项筛选期间状态下拉暂不可用」（D5 取「禁用」而非「改状态即清 needs」，行为更可预期）。
- 空态：`没有未推送草稿` / `没有待重推文章`，各带一句 hint 与「看全部文章」出口；通用「暂无文章」不用于这两种情况。
- `listArticles()` 参数类型加 `needs?: 'draft_unpushed' | 'repush'`。

---

## 4. 测试样本与断言结果

### 4.1 隔离库冒烟（真实 Prisma）`npm run smoke:dashboard`

`[t0] CHILD EXIT = 0`、`CLEANUP ok`、`REAL-DB FINGERPRINT MATCH`

| # | 断言 | 结果 |
|---|---|---|
| 47–49 | `needs=draft_unpushed`：200、`total=2`、集合 `{a1,a8}` | PASS |
| 50–53 | `needs=repush`：200、`total=4`、集合 `{a2,a3,a4,a9}`、不含 pushed/failed/漫画 | PASS |
| 54 | `needs=draft_unpushed&status=pushed` → 仍 `total=2`（needs 优先） | PASS |
| 55 | `needs=whatever` → 200 且 `total` = 全表条数（退化为普通列表） | PASS |
| 56 | `needs=draft_unpushed&accountId=` → `total=1` 且正是该账号文章 | PASS |
| 57 | `needs=repush&limit=2` 翻两页 → 4 条、无重复 | PASS |
| 58 | `total` 与 items 实际集合长度一致 | PASS |
| 59 | `needs=draft_unpushed` 的 total = Dashboard `draftUnpushed` | PASS |
| 60 | `needs=repush` 的 total = Dashboard `repush` | PASS |
| 61 | member 会话（真实登录）→ 只看到自己账号的文章 | PASS |
| 62 | 隔离库无「非空但 trim 为空」的 `mediaId`/`pushDate` | PASS |
| 63–67 | 清空后四项待办为 0、无降级 | PASS |

夹具覆盖（`scripts/smoke-dashboard.ts`，本轮新增 `a9`）：

| 样本 | 状态 | mediaId | pushDate | draft_unpushed | repush |
|---|---|---|---|---|---|
| a1 草稿未推 | draft | '' | '' | ✅ | — |
| a2 换封面回退 | draft | `m-a2` | '' | — | ✅ |
| a3 只有 pushDate | draft | '' | `2026-11-10` | — | ✅ |
| **a9 两字段都有** | draft | `m-a9` | `2026-11-12` | — | ✅ |
| a4 已改写 | updated | `m-a4` | '' | — | ✅ |
| a6 失败但有痕迹 | failed | `m-a6` | '' | — | — |
| a5 推送失败 | failed | '' | '' | — | — |
| a7 漫画草稿 | draft | '' | '' | — | — |
| a8 客户草稿（member） | draft | '' | '' | ✅（仅本人可见） | — |

> 加分点：`a9` 是任务书要求的「两个字段都有值」样本；加入后 Dashboard `repush` 由 3 变 4，断言 18 同步更新（只改期望值，不改口径）。

### 4.2 前端纯函数 `npm run test:todo-nav` → **34/34**

新增 7 项：两类 needs 参数、failed/comic 不受影响、`all` 不带参、非法值视为未筛、合法值原样识别。

---

## 5. 两种筛选 total 与 Dashboard 数字对照

| 项 | Dashboard 卡片 | 接口 total | 是否一致 |
|---|---|---|---|
| 未推送草稿 | `todos.articles.draftUnpushed` = **2** | `needs=draft_unpushed` = **2** | ✅ |
| 待重推 | `todos.articles.repush` = **4** | `needs=repush` = **4** | ✅ |

同一批夹具、同一次运行对比（断言 59/60 直接把两个数字相等钉死），不再是「卡片 1、列表 3」。

浏览器侧同样可见（Mock 数据）：卡片「1 未推送草稿 / 3 待重推」→ 列表分别 1 行、3 行。

---

## 6. 纯空白监测

在隔离库对全部 article 执行（JS 侧，不引入 Raw SQL）：

```ts
const blank = rows.filter(r =>
  (r.mediaId !== '' && r.mediaId.trim() === '') || (r.pushDate !== '' && r.pushDate.trim() === ''));
```

**结果：0 条**（断言 62 PASS）。即当前数据不存在「非空但 trim 后为空」的推送字段，D2 的 `equals:''` 与 `hasPushTrace` 的 trim 语义在本库等价。
未来若出现这类数据：监测会失败并打印样本 id，届时按约定停下报告，不擅自改 Raw SQL。

---

## 7. 浏览器复测（真实 dist + Mock）

**范围声明**：这里只验证「URL 参数 → 请求参数 → 筛选展示 → 清除/空态」这条**前端链路**；
后端筛选能力由 §4.1 的隔离库冒烟证明，**不用 Mock 结果冒充**。

| 场景 | 结果 |
|---|---|
| A 点「未推送草稿」 | `/articles?needs=draft_unpushed`；提示条「当前筛选：未推送草稿 / 普通文章·草稿状态·无推送记录」；状态下拉禁用（placeholder「待办筛选中」）；1 行（id 96），与卡片 1 一致 |
| B 刷新 | URL 与提示、行数全部保持 |
| C 点「清除筛选」 | 回到 `/articles`，提示条消失、下拉恢复可用、7 行全量 |
| D 点「待重推」 | `/articles?needs=repush`；提示条「待重推文章」；3 行（88 草稿 / 87 草稿 / 85 已更新），与卡片 3 一致 |
| E `?needs=repush&angle=5` | 提示条在、「选题 #5」标签保留（其他查询参数不被破坏） |
| F `?needs=whatever` | 无提示条、7 行普通列表（安全忽略） |
| H `needs=draft_unpushed` 且库中无此类 | EmptyState「没有未推送草稿」+ hint + 「看全部文章」，不是错误态 |
| G 推送失败 / 漫画入口 | `?status=failed`、`?status=draft&pipeline=comic` 与改造前一致 |

截图（`var/tmp/s5ui2c/`，未进版本库）：`40-d2-draft-unpushed.png`、`41-d2-cleared.png`、`42-d2-repush.png`、`43-d2-invalid.png`、`44-d2-empty.png`、`45-d2-dark.png`（深色）。原始结果：`d2-result.json`。

**深色**：提示条与禁用下拉在 `html.dark` 下正常，无浅色残留。

---

## 8. 类型检查与构建

- `server npm run typecheck` → **0 错误**
- `web npx vue-tsc --noEmit` → **0 错误**
- `web npm run build` → **✓ built in 8.63s**

### 走查中修掉的一个真实缺陷

把提示条插在 `<StateError v-if="error">` 与 `<el-card v-else>` 之间，**打断了 `v-if/v-else` 链**——Vue 丢弃了「找不到相邻 v-if」的 `el-card`，页面只剩标题和提示条，表格整块消失（首轮复测表现为 `rowCount=0`、无空态）。改为 `<el-card v-if="!error">` 并加注释说明原因。**这类问题 `vue-tsc` 与构建都发现不了，只有真渲染才暴露。**

---

## 9. 数据库使用情况

| 项 | 说明 |
|---|---|
| 目标库 | `wechat_pipeline_smoke`（运行器从 `server/.env` 的 DATABASE_URL 换库名后强制校验，目标≠smoke 直接拒绝） |
| 写入 | 仅本轮夹具：1 赛道 / 2 账号 / 1 member + 9 篇文章 + 体检与任务样本；`finally` 里按 id 清理 |
| 清理 | 跑完 `CLEANUP ok`（smoke 库表清空、临时内容目录删除） |
| 正式业务库 | **零写入**。运行器内置的只读指纹守卫（`COUNT+CHECKSUM`）照常比对，结果 `REAL-DB FINGERPRINT MATCH`；未单独运行 `verify:smoke-iso` 或任何额外指纹脚本 |
| 其他 | 未用 Raw SQL、未连生产库、未调用 LLM / 微信 |

> 说明：`npm run smoke:dashboard` 走的是项目既有隔离运行器，其「跑前/跑后业务库指纹比对」是 T0 验收过的只读守卫，无法关闭（直跑会被 runner 拒绝）。

---

## 10. Git 工作区

- HEAD 仍 `b2fbad3`，**未 commit / push / reset / checkout**。
- 本轮修改：
  - `server/src/api/routes/articles.ts`（+`needs` 参数与 where 分支）
  - `server/scripts/smoke-dashboard.ts`（a9 夹具、a4/a8 捕获变量、member 真实口令、断言 47–62、编号顺延）
  - `web/src/utils/todo-nav.ts`（`articlesNeedsQuery` / `parseArticleNeeds`）
  - `web/src/views/DashboardView.vue`（`goArticles` 改走纯函数）
  - `web/src/views/ArticlesView.vue`（读 needs、提示条、禁用下拉、定向空态、`v-if` 修正）
  - `web/src/api/index.ts`（`needs` 参数类型）
  - `web/scripts/assert-todo-nav.mjs`（+7 项）
  - `docs/DEVLOG.md`、本报告
- 未触碰：Schema、Migration、`.env`、`hasPushTrace`、推送状态机、lint 规则、选题/排产、其他页面与公共设计系统；此前各轮未提交内容原样保留。

---

## 11. 未解决问题

1. **`failed` 且有推送痕迹的历史脏数据**既不在 `pushFailed` 也不在 `repush`（S5-UI-2-B 既有口径：不冒充待办）。本轮未改，也未见新数据产生。
2. **列表响应仍不返回 `pipeline`**（D4）：`needs` 生效时不受影响（隐含 article），但「全部文章」视图无法在行内标注产线。要做得后端加 1 行 + 前端加列，另行授权。
3. **`needs` 与状态下拉是「禁用」而非「联动清除」**：想改成交互联动需再调一次，差异见 §3。
4. **未验证真实业务库的数据分布**：本轮按约束只跑隔离库；正式库上两类待办的实际条数以工作台数字为准（同一口径，已被断言 59/60 钉死一致性）。
5. 未做（按任务书 §8）：批次失败原因定位、member 体检权限。
