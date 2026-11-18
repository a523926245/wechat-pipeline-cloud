# S5-UI-6-FINAL · 收尾审计报告（只读）

**日期**：2026-11-18 14:43–15:0x
**审计对象**：S5-UI-6-0（剩余页面审计）/ S5-UI-6-1（member 保存修复）/ S5-UI-6-2（dry-run 横幅真源修复）
**HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`（分支 `feature/open-source-readiness`，本轮未变）
**工作区**：37 项 `M` + 42 项 `??` = 79 项未提交改动，全部原样保留；**本轮零代码改动、零 Git 写操作**

---

## 0. 结论

**可以正式关闭 S5-UI-6。**

- S5-UI-6-2 的 11 项核验 **11/11 通过**（详见 §2）。
- S5-UI-6-1 未被 6-2 覆盖：4 项回归 **4/4 通过**（§3.2）。
- S5-UI-6-0 的 P1 / P2 两个问题 **均已闭环**（§3.1）。
- S5-UI-6 范围内**新增 P0 / P1 / P2：0 个**（§4）。
- 新增 **2 个 P3**（措辞 / 注释口径），均不阻塞关闭（§4.3）。
- 历史遗留问题仍为 **S5-UI-4-0 / S5-UI-5 既有登记项**，本轮未授权、未实施（§5）。

---

## 1. 审计性质与边界

**性质**：只读审计。仅执行了以下**无副作用**操作：源码阅读、`grep`、文件 mtime 比对、`tsc --noEmit` / `vue-tsc --noEmit`、既有静态契约脚本、纯函数单测（不建连、不发 SQL）、读取既有证据文件。

**未做**（明确声明）：
- 未修改任何业务代码 / 后端 / API / Schema / Migration / `.env`；本轮唯一新增物是本文档 + DEVLOG 一条。
- 未连接任何数据库（含正式业务库与测试库）；**未执行真实数据库 `GET /scheduler` E2E**。
- 未执行任何写库 smoke；未调用真实 LLM；未调用微信公众号接口；未触发推送/群发。
- 未做 Git commit / push / reset / stash / checkout / clean。
- 未处理 P3；未扩大审计到 S5-UI-5 已关闭模块（只做"是否被破坏"的定向核验）。
- 未启动任何服务，未启动浏览器；本轮结束时端口无监听（§8）。

---

## 2. S5-UI-6-2 逐条核验（11/11 通过）

| # | 核验项 | 结论 | 证据位置 | 证据级别 |
|---|---|---|---|---|
| 1 | `READY_ACCOUNT_WHERE` 是否成为就绪账号唯一口径 | ✅ 是。常量定义于 `services/scheduler.ts:167`；`grep "credStatus: 'ok'"` 在 `server/src` 命中 3 处，另 2 处是 `routes/credentials.ts:256/261` 的**写操作**（连通性测试结果落库），不是读筛选，因此读口径确实唯一 | `scheduler.ts:167`；grep 结果 | 代码确认 + 静态验证 |
| 2 | `listReadyAccounts()` 与 `listReadyAccountRefs()` 是否共用该口径 | ✅ 两处都是 `where: { ...READY_ACCOUNT_WHERE, ... }`（`:172`、`:181`），后者额外叠归属过滤 | 同上 | 代码确认 |
| 3 | `pushIntent` 是否通过 `resolveAutomationForAccounts()` 得到，而非重判 mode | ✅ 路由 `:70` 取账号 → `:72` 调 `resolveAutomationForAccounts(accounts)` → `:74` 仅做 `automation.get(a.id)?.mode` 投影后交给 `classifyPushIntent`。路由内无任何自行读 `User.automationMode` 的代码（`:81`/`:133` 的 select 属于既有的 `my` 字段，与 pushIntent 无关） | `routes/scheduler.ts:70-76` | 代码确认 |
| 4 | `accountOwnerWhere(principal)` 是否仍生效 | ✅ 路由 `:70` 直接传入。`ownership.ts:37-40`：admin → `{}`（全部可见账号）；member → `{ ownerUserId: principal.userId ?? -1 }`（仅自己；未归属账号不可见）。`isAdmin` 走 `effectiveRole`，过期 admin 自动降为 guest → 权限中间件已先挡 | `routes/scheduler.ts:70`；`ownership.ts:28-40` | 代码确认（**未在真实库验证 member/admin 取值差异**，见 §7） |
| 5 | `classifyPushIntent()` 四态语义与报告一致 | ✅ `:205-210`：空数组→`unknown`；`pushable===0`→`none`（含全 manual）；`pushable===len`→`all`；否则→`partial`。与 6-2 报告 §2.1 表格逐条一致 | `scheduler.ts:205-210` | 代码确认 + 静态验证（单测 8/8） |
| 6 | 是否误把运行时条件塞进 pushIntent（到点/产线/配额） | ✅ 未塞。`classifyPushIntent` 入参只有 `AutomationMode[]`；路由未 import `isPipelineEnabled` / `getPipelineQuota` / `parseHm` / `todayPipelineCounts`（grep 零命中），也没有时间判断。函数注释显式声明"不掺" | `routes/scheduler.ts` import 块；`scheduler.ts:196-203` | 代码确认 + 静态验证 |
| 7 | 旧 `cfg.pushEnabled` dry-run 判断是否完全移除 | ✅ 已移除。`grep pushEnabled` 在 `web/src` 仅 4 处：`:40` reactive 初始化、`:95` 赋值（供 admin payload 用）、`:55/:57` 注释。**无任何 `v-if` / 条件判断使用它**；横幅条件已是 `pushBanner` | `SchedulerView.vue:40/95` vs `:269` | 代码确认 + 静态验证 |
| 8 | 旧 dry-run 文案是否残留（UI） | ✅ UI 零残留。`grep "dry-run"` 在 `web/src` 零命中；`server/src` 命中的 4 处均为 CLI 迁移工具与调度服务**注释**（非 UI，见 §4.3 P3-2） | grep 结果 | 静态验证 |
| 9 | `SchedulerStatus.pushIntent` 是否 optional，缺字段时前端不猜 | ✅ `types.ts:528` 为 `pushIntent?: PushIntent`；`SchedulerView.vue:62-63` `if (!s) return null` → 不渲染横幅。浏览器 `missing` 用例（响应无该字段）实测无横幅、页面正常 | `types.ts:528`；`SchedulerView.vue:61-63` | 代码确认 + 已有浏览器证据 |
| 10 | 全局 `cfg.enabled=false` 时是否不显示横幅 | ✅ 渲染条件 `v-if="cfg.enabled && pushBanner"`（`:269`）。浏览器 `disabled` 用例（enabled=false 且 pushIntent=all）实测无横幅 | `SchedulerView.vue:269` | 代码确认 + 已有浏览器证据 |
| 11 | 四态文案是否仍明确"只推草稿箱，不群发" | ✅ `partial`（`:72`）与 `all`（`:78`）文案内联"仅进草稿箱/只是草稿箱，不会群发"。`none` 态文案不重复"不群发"——因为该态宣称"本次不会推送"，不存在群发风险；且页面常驻安全边界提示"系统只会写草稿…不会自动群发（AUTO_PUBLISH 恒为 false）"始终渲染（`:203`，浏览器证据 `allAlerts` 每场景都可见） | `SchedulerView.vue:61-87`、`:203` | 代码确认 + 已有浏览器证据 |

**补充确认（口径真实性）**：`pushIntent` 与 tick 的推送判定共用同一个解析器 `resolveAutomationForAccounts`，且最终推送条件 `push = auto.mode === 'auto_draft_push'` 与 `targets.filter(t => t.push)` 在 6-2 中**一行未动**（diff 仅新增，无删除的判定逻辑）。

---

## 3. 跨 S5-UI-6 回归

### 3.1 S5-UI-6-0 两项问题的闭环状态

| 编号 | 原问题 | 闭环依据 | 结论 |
|---|---|---|---|
| **P1** | member 无法保存自己的自动化模式（payload 带全局字段被后端拒） | `SchedulerView.vue:119-125` 按 `isAdmin` 构造 payload；浏览器证据 `P61-result.json`（12:48）+ `P62-result.json`（14:24）：member payload = `{"automationMode":"auto_draft_push","writeTime":"06:00"}`，无全局字段；admin payload 含 `enabled/pushEnabled` | ✅ 已闭环 |
| **P2** | dry-run 横幅用全局 `pushEnabled` 判断，与真实按账号 mode 的推送行为相反 | 旧判断已删（§2-7）；后端 `pushIntent` 真源在位（§2-1~6）；浏览器证据 11 场景中 `none/pushEnabled=true` 与 `all/partial/pushEnabled=false` 两组**反相关夹具**均渲染正确结论 | ✅ 已闭环 |

### 3.2 S5-UI-6-1 是否被 6-2 覆盖（4/4）

| # | 回归项 | 结论 | 依据 |
|---|---|---|---|
| 1 | admin payload 仍含 `enabled / writeTime / pushEnabled / automationMode` | ✅ 实测 `{"enabled":true,"writeTime":"06:00","pushEnabled":false,"automationMode":"auto_draft_push"}` | 本轮读 `:119-121` 代码 + 6-2 浏览器证据（14:24） |
| 2 | member/guest payload 仍只有 `automationMode / writeTime` | ✅ 实测 member `{"automationMode":"auto_draft_push","writeTime":"06:00"}`；分支写法对 member 与 guest 一致（同一 else 分支） | 同上 |
| 3 | 非 admin 全局开关仍不可编辑 | ✅ `:226` `:disabled="!isAdmin"`，hint 追加"当前账号无权限修改"；浏览器证据 `switchDisabled=true`（member / guest） | 代码 + 浏览器 |
| 4 | PUT 失败仍不能伪装成保存成功 | ✅ `:132` catch → `ElMessage.error(errMsg(e,'保存失败'))`，无乐观成功；浏览器证据 `failToast = ["请求失败（HTTP 500）"]`（error 型） | 代码 + 浏览器 |

**6-2 未触碰 6-1 代码**：mtime 比对（§6.2）显示 `SchedulerView.vue` 在 6-2 窗口只被改过一次（14:18），且 diff 中 `saveCfg` 的 payload 分支、`:disabled="!isAdmin"` 均原样保留。

---

## 4. 新问题扫描（S5-UI-6 范围）

### 4.1 定向检查清单（全部"无"）

| 检查项 | 结论 | 依据 |
|---|---|---|
| 是否出现新的权限绕过 | ❌ 无。`GET /scheduler` 仍走 `requirePermission('automation:manage')`；`/tick`/`/start`/`/stop` 仍走 `system:manage`；新增代码只做读查询，未新增路由、未放开中间件 | 代码确认（`routes/scheduler.ts:32-38`） |
| 是否出现 admin/member 数据范围错误 | ❌ 无。`pushIntent` 统计集 = 就绪账号 ∩ `accountOwnerWhere(principal)`，与既有归属口径一致；返回值只有粗粒度 status，**不返回账号 id/名称/数量**，无信息泄露 | 代码确认 |
| 是否出现推送行为被 UI 错误表达 | ❌ 无（P2 级）。横幅唯一输入是服务端真源；四态与语义一致；旧的反向表达已删除。存在 P3 级措辞余量（§4.3 P3-1） | 代码 + 静态 + 浏览器 |
| 是否出现"会推送"与实际安全边界冲突 | ❌ 无。`all/partial` 文案同时声明"仅草稿箱、不会群发"；`AUTO_PUBLISH = false as const` 未变；页面常驻安全边界 alert 仍在 | 代码 + 浏览器证据 `allAlerts` |
| 是否出现 masssend / 群发路径 | ❌ 无。`grep masssend` 在 `server/src` 仅命中 4 处**禁止性注释**（`articles.ts:7`、`constants.ts:7`、`publisher.ts:8`、`wechat.ts:12`），无调用 | 静态验证 |
| 是否破坏 S5-UI-5 已关闭的文章推送安全语义 | ❌ 未破坏。`publisher.ts` mtime 11-16 21:35、`routes/articles.ts` mtime 11-17 17:25、`utils/article-push.ts` mtime 11-18 11:11——**均早于 6-2 窗口（14:10-14:30）**，6-2 未触碰；`pushArticleToDraft` 在调度服务内仍只有 1 处调用 | mtime + 静态验证 |
| 是否破坏 P1 的 `/articles/0` 修复 | ❌ 未破坏。`PlanView.vue` mtime 11-18 10:41（未触碰）；源码仍为四态处理（`if (!res.ok && failed.length===0)`、全失败分支不跳转），`/articles/0` 仅出现在注释"绝不跳"中 | 代码确认 + mtime |

### 4.2 P0 / P1 / P2 结论

**S5-UI-6 范围内新增 P0：0；P1：0；P2：0。**

### 4.3 新增 P3（不阻塞关闭，本轮不实施）

| 编号 | 问题 | 事实 | 影响 | 建议（待授权） |
|---|---|---|---|---|
| **P3-1** | 横幅措辞「本次」可被读成"立即发生" | 文案为"本次所有就绪账号都会推草稿箱"，而 `pushIntent` 只表达**配置意图**，不含到点/配额。若尚未到写稿时间、或当日配额已满，实际不会推 | 轻微：口径已在 6-2 报告 §5.2 显式声明；但首屏读者可能误解时间性 | 若要收紧，改"到点后会推"一类措辞即可（**1 行文案**，需单独授权） |
| **P3-2** | `services/scheduler.ts:16` 头部注释仍是"并行期默认 dry-run 不真推：`scheduler_push_enabled` 默认 false" | P4 之后该键已降级为**无主账号兜底**，此句会让人误以为推送仍由全局键控制 | 文档口径漂移，不影响运行；与 6-2 修复的"真源"叙事相反，长期易误导后来者 | 改注释一行（**本轮只读，未动**） |

> 另记 1 条非缺陷观察：`pushIntent` 的聚合范围随调用者身份不同（admin 全部 / member 自己），同一时刻两人可能看到不同 status。这是刻意的（横幅对谁说话就按谁的可见范围算），6-2 报告 §5.5 已声明，不列为问题。

---

## 5. 历史遗留问题状态（本轮未授权，仅记录）

| 编号 | 问题 | 归属 | 当前状态 | 来源 |
|---|---|---|---|---|
| B-1 | 出稿前无 impact / AI 披露确认 | **S5-UI-4-0 已登记 P2**（非 S5-UI-6 新问题） | 未实施，`PlanView.vue` `trigger()` 仍直连 `triggerPlan` | `S5-UI-4-0-CORE-PAGES-AUDIT.md:73/144` |
| T1 | 赛道产线配额改脏后刷新静默丢弃 | **S5-UI-4-0 已登记 P2** | 未实施，`TracksView.load()` 仍无 dirty 拦截 | 同上 `:92/146` |
| — | 500px `.el-card__body` 424>410 横向溢出 | **既有布局问题**（单选组 + 96px 标签宽） | 未实施。6-2 做过对照实验：**横幅缺席时溢出量完全相同** → 与 6-2 无关 | 6-2 报告 §5.4 |
| B1 | 确认弹窗 markdown 星号未被解析 | **S5-UI-5 已登记 P3** | 暂缓 | `S5-UI-5-FINAL-CLOSURE-AUDIT.md` |
| D-1 | 模型配置引导偏弱 | **S5-UI-5 已登记 P3** | 暂缓 | 同上 |
| E-3 | 已推送按钮无前置提示 | **S5-UI-5 已登记 P3** | 暂缓 | 同上 |

**结论**：以上均**不是 S5-UI-6 回归或新发现**，按任务要求不阻塞 S5-UI-6 关闭。

---

## 6. 证据及其分级

### 6.1 证据分级汇总

| 级别 | 内容 |
|---|---|
| **代码确认** | §2 的第 1/2/3/4/5/6/7/9/10/11 项；§3.1 闭环判定；§4.1 全部检查项（归属过滤、权限中间件、`AUTO_PUBLISH`、masssend 无调用） |
| **静态验证（本轮执行）** | server `tsc --noEmit` 0 错误；web `vue-tsc --noEmit` 0 错误；`p62-contract.mjs` **26/26**；`classifyPushIntent` 单测 **8/8**（真实 import 服务模块、只调纯函数、**未建连未发 SQL**）；`grep` 系列（pushEnabled / dry-run / masssend / 调用点）；文件 mtime 比对 |
| **已有浏览器证据（6-2 于 14:24 产出，本轮未重跑）** | 11 场景：`none` / `partial` / `all` / `unknown` / `missing` / `disabled` / `member@all` / `guest(403)` / `partial@500` / `partial@500-dark` / `unknown@1440-dark`；payload 回归（admin/member）；PUT 500 真实错误；Console 0 error；13 张截图 `P62-*.png` |
| **本轮新增浏览器证据** | **无**（只读审计，未启动服务与浏览器） |
| **未验证** | ① 真实数据库 `GET /scheduler` E2E（`pushIntent` 由真实账号 mode 分布算出的取值）；② member/admin 在真实多账号数据下 `pushIntent` 的差异；③ 真实 session 的 admin/member 权限链路（6-1/6-2 全部为 Mock 角色） |
| **推断（不可作为结论依据）** | 真实库中 Member 账号 mode 分布对横幅的影响方向（只能从代码推，未实测）；`unknown` 在真实环境中的触发频率 |

### 6.2 浏览器证据与当前代码的一致性（时间链）

| 环节 | 时间戳 |
|---|---|
| `web/src/views/SchedulerView.vue`（源码最后一改） | 11-18 **14:18:58** |
| `web/dist/assets/SchedulerView-*.js`（构建产物） | 11-18 **14:20:04** |
| `P62-unit.json` | 11-18 14:21:10 |
| `P62-result.json` + 截图（浏览器走查） | 11-18 **14:24:09** |
| 本轮复跑静态契约 / 单测 / typecheck | 11-18 14:4x（源码 mtime 未变） |

→ 浏览器证据晚于构建产物、构建产物晚于源码最后一改，**证据与当前代码一致**，不存在"测的是旧包"的风险。

### 6.3 必须保留的事实（禁止美化）

> **S5-UI-6-2 未执行真实数据库 `GET /scheduler` 端到端验证。**
> 四态横幅的**渲染**由 Mock 夹具（`pushIntent` 直接喂给前端）验证；
> `pushIntent` 的**计算**只经纯函数单测（8/8）+ 源码核对确认，未在真实账号数据上跑过一次真实请求。
> 因此"真实环境下三种账号 mode 混合 → 界面显示 partial"这一链路属于**未验证**，不是已验证。

---

## 7. 未验证项与风险

1. **真实库 E2E 缺失**（最重要）：`resolveAutomationForAccounts` 对真实 `User.automationMode` 的读取、无主账号 legacy 兜底分支，均未用真实数据跑过。潜在偏差点：无主账号（`ownerUserId=null`）在 member 视角被 `accountOwnerWhere` 排除，在 admin 视角按 `pushEnabled` 兜底推导——两侧可能给出不同 status，**未实测**。
2. **权限链真实性**：两次浏览器走查都用 Mock 角色（写文件切换 role），未经真实登录会话。真实链路中 `requirePermission('automation:manage')`、`effectiveRole` 过期降级等未在本轮验证（属既有机制，非本轮引入）。
3. **单元测试的边界**：`classifyPushIntent` 单测覆盖 8 组模式组合，未覆盖非预期输入（如非法 mode 字符串——上游 `normalizeAutomationMode` 已归一为 `manual`，`automation.get()?.mode ?? 'manual'` 也兜底，但这两条链未做联合测试）。
4. **6-1 的 guest 场景证据有 Mock 局限**：`P61-result.json` 中 guest 保存返回了成功（Mock 未对 guest PUT 返回 403）。真实后端 guest 无 `automation:manage`，PUT 会 403 → 前端走 catch 显示真实错误（该错误路径已由 500 用例验证）。属**证据局限**，非代码缺陷，但不可宣称"guest 保存已被真实拒一次"。

---

## 8. HEAD、工作区与服务释放

| 项 | 状态 |
|---|---|
| HEAD | `b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`（与 6-1/6-2 完全一致，未变） |
| 分支 | `feature/open-source-readiness`（未切） |
| 工作区 | 79 项未提交（37 `M` + 42 `??`），与 6-2 交付时一致；本轮新增仅本文档 + DEVLOG |
| Git 写操作 | 无（无 commit / push / reset / stash / checkout / clean） |
| 服务与端口 | 本轮未启动任何服务；审计结束时 `:8798 / :9421 / :9422 / :5208 / :8787` 均无监听；无残留走查用 Chrome（`--remote-debugging-port=94xx` 零命中） |
| 数据库 | 未连接（含正式库与测试库） |
| 外部接口 | 未调用 LLM / 微信；未推送 |

---

## 9. 结论与建议

**可关闭 S5-UI-6。**

- 6-0 的 P1（member 保存）与 P2（横幅真源）均已闭环，且闭环本身可追溯到代码 + 证据两级。
- 6-2 的真源设计站得住：**一个就绪账号常量、一个 mode 解析器、一个纯分类函数**，路由只做编排，前端只做展示——没有第二套判断逻辑。
- 未发现新的权限绕过、数据范围错误、推送语义误表达、群发路径，也未破坏 S5-UI-5 与 P1 的既有修复。
- 遗留的 2 个 P3 + 6 个历史登记项（B-1 / T1 / 500px 溢出 / B1 / D-1 / E-3）**不构成关闭阻塞**。

**建议的下一步（均需单独授权，本轮不做）**：
1. 若要彻底闭环"推送意图"，补一次真实库只读 E2E（起服务 + 真实会话 GET `/scheduler`，只读、不写库），验证三账号 mode 混合下的 `partial`。
2. P3-1 措辞（"本次"→"到点后"）与 P3-2 注释口径，属 1 行改动级，可合并成一个小批次。
3. 历史 P2（B-1 / T1）按 S5-UI-4-0 登记原样排期，不与 S5-UI-6 混谈。

---

**审计人声明**：本报告所有"通过"均基于可复现的代码位置或证据文件；凡未验证项已单列（§6.3、§7），未把 Mock 验证表述为真实后端/真实数据库验证。
