# S5-UI-2-B 实施验收报告：工作台待办队列

- **日期**：2026-11-17
- **依据**：S5-UI-2-A 只读核查报告（已批准）；用户《S5-UI-2-B 工作台待办队列正式实施》
- **结论**：已实施并通过验收。`typecheck` 0 / `smoke:dashboard` **51/51** / web `build` ✓；真实库零写入（指纹 MATCH）。
- **不涉及**：Schema / Migration / `.env` / 新 API 端点 / 新数据模型 / 真实 LLM / 微信接口。

---

## 1. 交付范围

在现有 `GET /api/dashboard` 响应里新增 `todos` 区块（不新建端点、不删改原有字段），并在工作台
Hero 卡与「今日配额 / 最近动态」之间插入一张整宽「待办」卡片。

| 文件 | 改动 | 说明 |
|---|---|---|
| `server/src/services/dashboard.ts` | +约 380 行 | 新增 `TodoBlock` 类型族 + `todoAngles / todoArticles / todoLint / todoRuns / todoBlock`；`getDashboard` 返回值加 `todos` |
| `web/src/types.ts` | +约 100 行 | 镜像上述类型；`DashboardData.todos?` 声明为可选（前端先上/后端未上的过渡期不炸） |
| `web/src/views/DashboardView.vue` | +约 300 行 | 待办卡（4 行 + 明细 + 跳转 + 空态 / 降级 / 权限态）+ 配套样式 |
| `server/scripts/smoke-dashboard.ts` | 新增 | 51 项断言，覆盖验收清单 1–18 |
| `server/scripts/smoke-run.ts` | +3 行 | 注册 `dashboard` target |
| `server/package.json` | +1 行 | `smoke:dashboard` |
| `server/scripts/smoke-isolated.ts` | 2 处文案 | 帮助串补 `dashboard`（逻辑未动） |

---

## 2. 接口契约

```
GET /api/dashboard     →  原字段全保留，新增 todos
权限：data:view（沿用）；admin 全量 / 非 admin 按 account.ownerUserId 过滤（沿用）
```

**所有计数为 `number | null`**：`0` = 查询成功且确实没有；`null` = 该块查询失败（或选题块对 member 不可见）。
这条是本次实施最关键的契约，前端禁止把 null 显示成 0。

```json
"todos": {
  "scope": "all",
  "angles": {
    "total": 12, "candidate": 10, "needsRevision": 2, "oldestWaitingDays": 4,
    "byTrack": [{ "trackId": 3, "track": "星座", "candidate": 7, "needsRevision": 1 }],
    "recent": [{ "id": 128, "trackId": 3, "track": "星座", "status": "candidate",
                 "theme": "关系修复", "content": "…", "scoreTotal": 21, "updatedAt": "2026-11-13T02:00:00.000Z" }]
  },
  "articles": { "draftUnpushed": 3, "repush": 1, "pushFailed": 2, "comicDraft": 1,
                "oldestDraftDays": 9, "recent": [ { "id": 42, "title": "…", "status": "failed",
                "pipeline": "article", "account": "星座号", "reason": "push_failed", "updatedAt": "…" } ] },
  "lint": { "failed": 2, "recent": [ { "articleId": 42, "title": "…", "trigger": "save",
            "errorCount": 3, "warnCount": 5, "checkedAt": "…", "stale": false } ] },
  "runs": { "windowDays": 7, "unresolved": 1, "recent": [ { "id": 901, "jobType": "write",
            "accountId": 2, "account": "星座号", "articleId": null, "errorCode": "write_failed",
            "errorMessage": "…", "createdAt": "…" } ] },
  "degraded": []
}
```

`member` 的 `angles` 恒为 `null`（正常权限结果，**不进 degraded**）。

---

## 3. 五类待办的实现口径

### A. 待审核选题（仅 admin）

```ts
where = { used: false, status: { in: ['candidate','needs_revision'] } }
```

- 与 `planner.ts` 的「有题但没审」诊断同口径（复用同一判据，不另造标准）。
- 排除：`used=true`（含 approved 被占用后编辑退回 candidate 的 CAS 分支——已被消费）、`approved`、`rejected`。
- 分赛道：`groupBy(['trackId','status'])` + 一次 `track.findMany` 取名，按总量降序。
- 最久等待：`updatedAt` 升序取首条算天数（不是 `createdAt`——needs_revision 的起点是「被打回」那一刻）。
- 明细 3 条：`updatedAt asc`（等最久的在前），带 `scoreTotal`（复用 `topicReview.readScoreMeta`）。
- 不按 `scope` 过滤：审核是赛道级动作，与产线池无关（与 planner 的产线诊断分母不同，不可直接对账）。

### B. 文章待处理

**不按 status 判断「是否推送过」**，一律复用 `hasPushTrace()`（`mediaId`/`pushDate` 任一非空，内部 trim）：

| 指标 | 判据 |
|---|---|
| `draftUnpushed` | `status='draft'` 且 `!hasPushTrace` |
| `repush` | `status='updated'` 的计数 + `status='draft'` 且 `hasPushTrace` 的条数 |
| `pushFailed` | `status='failed'` 且 `!hasPushTrace` |
| `comicDraft` | `pipeline='comic'` 且 `status='draft'`（独立，不与前三相加） |

- **为什么读行再分类**：SQL 的 `!= ''` 会把纯空白串误判成「有值」，与 `hasPushTrace()` 的 trim 语义不一致。
  因此取回 `status in (draft, failed)` 的文章行（天然有限），在 JS 里调同一个 `hasPushTrace()` 分类。
- 撞到扫描上限（500）→ 抛错 → 整块降级为 null，**不用截断后的数字冒充真实值**。
- `failed` 但有推送痕迹的属历史脏数据（S5-1 起不会再产生），不计入任何一类。
- 明细 3 条按 `updatedAt desc`，带 `reason`；`oldestDraftDays` = 未推送草稿里最久的 `updatedAt`。

### C. 文章体检

1. `articleLintRun.groupBy({ by:['articleId'], _max:{ id:true } })` → 每篇最新一条（两步查询，无 N+1）。
2. `findMany({ id: { in: latestIds }, ok:false })`。
3. 过滤：`pipeline !== 'comic'` **且** `contentHash === htmlFingerprint(article.contentHtml)`（复用 `lint-store.htmlFingerprint`）。
4. `failed` = 过滤后条数；`recent` 3 条，`stale` 恒为 false（过期的已在过滤阶段排除）。

**只读保证**：全程不调用 `GET /api/articles/:id/lint`（该接口带 `recordLintRun` 写副作用）。已用断言验证
「调用工作台前后 `ArticleLintRun` 行数不变」。

### D. 任务执行异常

```ts
jobType in ('write','comic_script','comic_panel')   // 排除 push（已有 articles.pushFailed 口径）
createdAt >= now - 7d, take 500
```

- 分组键：`write`/`comic_script` → `jobType:accountId`（**批次**）；`comic_panel` → `panel:articleId`。
- 每组只取窗口内**最新一条**，`status='failed'` 才计入 `unresolved`；最新成功 ⇒ 视为已恢复，旧失败自动消失。
- 不虚构进度/重试次数（`TaskRun` 没有这些字段，`parentId`/`attempt>1` 全项目未使用）。
- 明细 3 条；`errorCode` / `errorMessage` 原样透出。
- 撞到 500 条上限 → 抛错降级（拒绝近似）。

---

## 4. admin / member 权限

| 块 | admin | member |
|---|---|---|
| `todos.scope` | `all` | `own` |
| `angles` | 完整数据 | **`null`**（不查库、不进 degraded、前端整行不渲染） |
| `articles` / `lint` | 全量 | 按 `account.ownerUserId` 过滤（与现有 Dashboard 一致） |
| `runs` | 全量 | `accountId ∈ 我的账号` **或**（`accountId=null` 且 `articleId ∈ 我的文章`）——`comic_panel` 行没有 accountId，不兜住会漏 |

member 的选题不可见是**权限结果**，与「查询失败」严格区分：前者 `degraded` 为空，前端不显示「统计暂不可用」。

---

## 5. 降级与空值

- 四块并行、各自 `safe()`：一块抛错只让它自己变 null 并登记到 `todos.degraded`，其余块照常返回。
- 已用断言验证：注入 `angle.groupBy` 抛错后，`angles.total === null` + `degraded=['angles']`，而 `articles.draftUnpushed`、`lint.failed` 仍是真实数字。
- 空库（隔离库清空后）：四块全部为 `0`（不是 null），`degraded` 为空。
- 前端：`0` 显示数字 `0`；`null` 显示 `统计暂不可用` 标签；有任一块降级时**不显示**「暂无待办」（避免把失败伪装成空）。

---

## 6. 前端交互

布局顺序：Hero 出稿进度 → 未排产红条 → **待办卡** → 今日配额 / 最近动态 → 脚注。

| 行 | 展示 | 跳转 |
|---|---|---|
| 待审核选题 | 总数 + 候选/待改 + 赛道分布（前 3）+ 等最久天数 + 3 条明细（正文/赛道/审核态标签/评分） | 单条 → `/tracks/:id/angles?status=<该条状态>&used=unused`；「去审核」在只有 1 个赛道时直达，多赛道落 `/tracks`（跨赛道选题页当前不存在） |
| 文章待处理 | 三个独立数字（未推送草稿 / 待重推 / 推送失败）+ 漫画草稿（>0 才出现）+ 3 条明细 | 草稿 → `?status=draft`（超集，含被换封面回退的草稿）；待重推 → `/articles`（**不假装已筛选**，列表无复合筛选）；失败 → `?status=failed`；漫画 → `?status=draft&pipeline=comic` |
| 文章体检 | 有效失败数 + 3 条（标题 / error / warn / 时间） | 单条 → `/articles/:id`；「去文章」→ `/articles`（列表无体检筛选） |
| 执行异常 | 「N 次」+ 窗口说明 + 3 条（类型 / 账号 / 错误码 / 摘要 / 时间） | 有 `articleId` → 文章；批次任务 → `/plan` |

- 空态：`EmptyState`（"暂无待办" + 去创作计划），**卡片保留**。
- 降级态：对应行显示 `统计暂不可用`（`el-tag`），其余行正常。
- 权限态：member 不渲染选题行，也不显示任何"不可用"字样。
- 全部使用 S5-UI-1 的令牌与 `PageHead / EmptyState / StatusTag`；未新建公共组件。
- UI 文案：批次任务用「次」，不写「篇」；不出现百分比/进度（后端无此数据）。

---

## 7. 测试

**`npm run smoke:dashboard`（隔离库 `wechat_pipeline_smoke`，跑前重建 / 跑后清空，业务库零写入）**

| 组 | 断言 | 覆盖验收项 |
|---|---|---|
| A 选题 | 1–12：scope / total / candidate / needsRevision / 排除 approved+rejected / 排除 used / 分组 / 最久等待 / ≤3 条 / 排序 / 评分 | 1、2、3 |
| B 权限 | 13–16：member scope / angles=null / 不进 degraded / 只统计自己 | 3 |
| C 文章 | 17–23：三类数值 / failed 有痕迹排除 / 漫画单列 / 明细不含漫画 | 4、5、6、7 |
| D 体检 | 24–29：最新一条 / 旧失败被覆盖 / stale 排除 / 漫画排除 / 字段 | 8、9、10 |
| E 副作用 | 36：工作台请求不新增 `ArticleLintRun` | 11 |
| F 任务 | 30–35：窗口 / 恢复 / push 排除 / 批次计次 / ≤3 条 | 12、13、14、15 |
| G 降级 | 37–40：null 非 0 / degraded 登记 / 其他块不受影响 | 16、17 |
| H HTTP | 41–46：`/api/dashboard` 200 + todos + 原 counts/今天/任务流水均在 | 18 |
| I 空库 | 47–51：四块全 0、无降级 | 16 |

输出尾部：`全部通过：51 项断言` / `CHILD EXIT = 0` / `CLEANUP ok` / `REAL-DB FINGERPRINT MATCH（真实库零写入）`。

**静态检查**：`server npm run typecheck` 0；`web npx vue-tsc --noEmit` 0（两遍）；`web npm run build` ✓ 7.5s。

---

## 8. 视觉走查

用构建产物 + **临时 Mock 上游**（`var/tmp/s5ui2/mock.mjs`，手写 JSON，不连库、跑完即删）截了 5 个场景：

| 场景 | 结论 |
|---|---|
| 常规（浅色） | 四行数字/说明/明细对齐正常，无挤压溢出 |
| 常规（深色） | 无浅色残留，文字对比度正常 |
| 全 0 | 显示「暂无待办」+ 去创作计划，卡片保留 |
| 四块降级 | 四行均显示「统计暂不可用」，无 0 |
| member | 选题行整体不渲染，其余三行 `0` 正常显示 |

**走查发现并修复的缺陷 1 个**：选题块降级时后端返回的是「字段全为 null 的对象」，前端最初只判
`anglesBlock` 是否存在，导致降级态只显示半句「候选 待改」而漏掉「统计暂不可用」标签。
已改为判定 `anglesBlock.total !== null`（`anglesUsable`），复测通过。

**说明**：截图用的是 Mock 载荷（只验证"长什么样"），数字口径由隔离库冒烟验证（验证"算得对不对"），两者不混用。

---

## 9. 边界与遗留

**本轮未做**（刻意）：

1. 不给文章列表加复合筛选（`?needs=repush`）——待重推仍跳全列表，不假装已筛选。
2. 不建任务中心、不加「已处理/忽略」标记、不给 TaskRun 加进度。
3. 不改 `ArticlesView` 的筛选逻辑、不改 lint 规则/阈值、不改 planner/scheduler。
4. 不动 Schema/Migration/`.env`，不新增端点。

**已知局限（如实登记）**：

| # | 局限 | 影响 | 备注 |
|---|---|---|---|
| L1 | 执行异常窗口 7 天 | 7 天前仍未恢复的失败不再出现 | 无「已处理」字段时的取舍；窗口写进契约注释 |
| L2 | 扫描上限 500 | 超过则整块降级为 null | 宁可显示「不可用」也不给近似值 |
| L3 | 未推送草稿不限时间 | 长期囤稿数字持续增长 | scheduler 只推当天创建的草稿，旧草稿不会自动补推 |
| L4 | 「未推送草稿 / 待重推」跳转列表是超集 | 列表里会混入另一类 | 页面无复合筛选；已在代码注释与本文说明 |
| L5 | 体检 `stale` 只对明细标注、不参与主计数 | 主数字口径为「最新记录 + 指纹一致」 | 逻辑上 stale 已排除，`stale` 字段恒 false，留作后续 |

---

## 10. Git 状态

HEAD 仍 `b2fbad3`，**未 commit / push / reset / checkout**。
本轮新增：`server/scripts/smoke-dashboard.ts`、`docs/restructure/S5-UI-2-B-IMPLEMENTATION-REPORT.md`；
修改：`server/src/services/dashboard.ts`、`server/scripts/smoke-run.ts`、`server/scripts/smoke-isolated.ts`（仅文案）、
`server/package.json`（+1 脚本）、`web/src/types.ts`、`web/src/views/DashboardView.vue`、`docs/DEVLOG.md`、
`CHANGELOG.md`、`docs/restructure/README.md`（决策登记一行）。
S5-UI-1 及更早的未提交内容**原样保留未覆盖**。
