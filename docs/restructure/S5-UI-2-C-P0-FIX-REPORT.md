# S5-UI-2-C-P0-FIX · 单赛道待审核选题跳转修复

**日期**：2026-11-17
**来源问题**：`docs/restructure/S5-UI-2-C-WORKBENCH-FLOW-AUDIT.md` 问题清单 **P0-1**
**授权范围**：仅修该跳转 + 必要测试；不碰后端、Schema、API 契约、文章筛选与审核状态机

---

## 1. 问题与根因

**现象**（审计已用真实构建产物复现）：某赛道只有 `needs_revision` 选题时，工作台「去审核」落到
`/tracks/5/angles?status=candidate&used=unused`，页面显示「共 0 条选题」。

**根因**：`DashboardView.vue` 的 `goAngles(trackId, status?)` 把 status 写死默认成 `'candidate'`：

```ts
// 修复前（author 简化）
query: { status: status ?? 'candidate', used: 'unused' }
```

而一键入口 `goAnglesTop()` 只传了 `trackId`，没传 status：

```ts
if (tracks.length === 1) goAngles(tracks[0]?.trackId);
```

于是单赛道入口**永远**按 candidate 筛，与该赛道真实分布无关。明细行因为传了自己的真实
`status`，所以不受影响——这也解释了为什么审计里「明细能定位、一键入口断链」。

**数据前提已核实**：`TodoAnglesBlock.byTrack` 每项确实带 `candidate` 与 `needsRevision`
（`web/src/types.ts` 的 `byTrack: Array<{ trackId, track, candidate, needsRevision }>`，
后端由 `angle.groupBy({ by: ['trackId','status'] })` 汇总），不需要新增字段。

---

## 2. 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `web/src/utils/todo-nav.ts` | **新增** | 跳转参数纯函数（`initialAngleStatus` / `anglesQuery` / `anglesTopTarget`），无 Vue 依赖，可被脚本直接断言 |
| `web/src/views/DashboardView.vue` | 修改 | `goAngles` 不再写死默认 status；`goAnglesTop` 改为按赛道真实分布取落点 |
| `web/package.json` | 修改 | 加一行脚本 `test:todo-nav`（`node --experimental-strip-types`，与 server 冒烟同一手法，不引框架） |
| `web/scripts/assert-todo-nav.mjs` | **新增** | 15 项断言 |
| `docs/DEVLOG.md` | 修改 | 追加本轮进度 |
| 本文件 | 新增 | 验收报告 |

**未修改**：`server/**`（含 `dashboard.ts` 的 `todo*` 聚合）、Prisma Schema、Migration、
API 契约、`.env`、`ArticlesView` 筛选逻辑、`TrackAnglesView`、选题审核状态机、公共组件与设计令牌。

**为什么抽一个 util**：这段判定是「数据 → URL 参数」的纯映射，留在组件里只能靠点按钮验；
抽出来后可被 Node 脚本直接断言，成本 60 行、零新依赖，也避免以后有人再次把默认值写死。

---

## 3. 修复前后行为对照

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 单赛道 `candidate=0, needsRevision=1` | `status=candidate` → **0 条**（P0） | `status=needs_revision` → 1 条，正是该条待改选题 |
| 单赛道 `candidate=2, needsRevision=1` | `status=candidate` → 2 条 | `status=candidate`（不变，仍优先候选） |
| 单赛道 `candidate=0, needsRevision=0` | `status=candidate` → 0 条（造出必然为空的筛选） | **不带 status**，选题库按「全部」展示 |
| 多赛道（≥2） | `/tracks` | `/tracks`（不变） |
| 无赛道 | `/tracks` | `/tracks`（不变） |
| 明细行点击 | 该条自己的 `status` | 该条自己的 `status`（不变） |
| `used` 条件 | `used=unused` | `used=unused`（不变） |
| admin / member | member 无选题行 | 未变（member 的 `angles=null`，整行不渲染，进不到该入口） |

修复后的核心逻辑（`web/src/utils/todo-nav.ts`）：

```ts
export function initialAngleStatus(track) {
  if (!track) return undefined;
  if (track.candidate > 0) return 'candidate';        // 有候选优先候选（审核主流程）
  if (track.needsRevision > 0) return 'needs_revision'; // 只有待改 → 必须进待改
  return undefined;                                    // 两者都 0 → 不构造筛选
}

export function anglesQuery(status) {
  const query = { used: 'unused' };   // 审核只看未被占用的题，恒带
  if (status) query.status = status;  // 空值不写键，避免被当成某个具体状态
  return query;
}
```

---

## 4. 新增断言与实际结果

`cd web && npm run test:todo-nav`（Node 22 类型剥离直跑，无新依赖、无浏览器）：

```
[1] 单赛道：只有待改选题（本轮 P0 场景）
  ✓ 初始审核态 = needs_revision
  ✓ 落点 = 该赛道选题库
  ✓ URL 带 status=needs_revision 且保留 used=unused
  ✓ 修复前行为不应再出现（status 不得为 candidate）
[2] 单赛道：候选与待改都有 → 仍优先候选
  ✓ 初始审核态 = candidate
  ✓ URL = candidate + used=unused
[3] 单赛道：边界分布
  ✓ 只有候选（candidate=2, needsRevision=0）→ candidate
  ✓ 两者都为 0 → 不构造 status（避免必然为空的筛选）
  ✓ 分布缺失（null）→ 不构造 status
[4] 多赛道 / 空列表：行为不变
  ✓ 两个赛道 → 赛道列表，且不带 query
  ✓ 没有赛道 → 赛道列表
[5] 明细行：用该条记录自己的真实 status
  ✓ 明细 status=candidate → URL 原样透传
  ✓ 明细 status=needs_revision → URL 原样透传
  ✓ 明细 status 为空时不留空值键
  ✓ used 条件恒为 unused（审核只看未占用的题）

通过 15 项断言
全部通过
```

**断言覆盖任务要求**：P0 场景（candidate=0/needsRevision=1 → `status=needs_revision` + `used=unused`）✓；
candidate=1/needsRevision=1 仍优先 candidate ✓；多赛道不受影响 ✓；明细跳转不受影响 ✓。

---

## 5. 浏览器复测（真实构建产物）

方式沿用 S5-UI-2-C 审计：`web/dist` 构建产物 + 本地 Mock `/api`（`var/tmp/s5ui2c/`，
手写夹具、不连数据库、跑完已停服务与清理 profile），headless Chrome + CDP 真实点击。

| 场景 | 点「去审核」后的实际 URL | 目标页 | 结果 |
|---|---|---|---|
| A 单赛道，候选 0 · 待改 1 | `/tracks/5/angles?used=unused&status=needs_revision` | 选题库 | **1 行**，正是「孩子写作业磨蹭…」待修改 R1；筛选控件显示「未用 / 待修改」 |
| B 单赛道，候选 2 · 待改 1 | `/tracks/3/angles?used=unused&status=candidate` | 选题库 | 2 行候选 |
| C 两赛道 | `/tracks` | 赛道管理 | 2 行赛道（行为不变） |
| D 点「待修改」明细行 | `/tracks/5/angles?used=unused&status=needs_revision` | 选题库 | 1 行，与 A 一致（明细未受影响） |

截图：`var/tmp/s5ui2c/20-fix-single-revision.png`（A 场景：标题「赛道「育儿」· 共 1 条选题」，
列表一条，筛选「未用 / 待修改」）、`21-fix-multi-track.png`、`22-fix-detail-row.png`。
原始结果 JSON：`var/tmp/s5ui2c/fix-result.json`。

---

## 6. 静态验收

- `npx vue-tsc --noEmit` → **exit 0**
- `npm run build` → **✓ built in 10.89s**
- `npm run test:todo-nav` → **15/15 通过**

---

## 7. 未验证事项

1. **真实后端数据**：复测走 Mock 夹具，验证的是「URL 参数 + 目标页读取 + 过滤语义」，
   未连真实业务库（本轮按授权不做数据库验证）。
2. **其他生产入口**：赛道列表行内的「选题池」按钮（`TracksView`）不经 `goAnglesTop`，
   未受影响，但未在浏览器回归（改动未触及该路径）。
3. **窄屏**：待办卡片在窄屏下的按钮位置未重新截图（本轮只改查询参数，不改布局）。
4. **审计报告 P1 三项**（多赛道落赛道列表无待审提示 / 批次失败跳 `/plan` 看不到原因 /
   「未推送草稿」数字与列表行数不符）：按授权**未处理**，仍在 `S5-UI-2-C` 报告问题清单里。

---

## 8. Git 工作区

- HEAD 仍 `b2fbad3`，**未 commit / push / reset / checkout**。
- 本轮新增 `??`：`web/src/utils/todo-nav.ts`、`web/scripts/assert-todo-nav.mjs`、本报告。
- 本轮修改 `M`：`web/src/views/DashboardView.vue`（+8 行净增，含 S5-UI-2-B 的既有未提交改动）、
  `web/package.json`（+1 行脚本）、`docs/DEVLOG.md`。
- 其余未提交内容（`server/**`、`types.ts`、其余 views、S5-UI-1/2-B 产出与各报告）**原样保留未覆盖**。
