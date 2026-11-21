# S5-UI-6-1 · 修复 member 自动化模式保存问题 · 实施报告

**日期**：2026-11-18
**性质**：单 P1 修复（S5-UI-6-0 审计发现）。**唯一业务代码改动为 `web/src/views/SchedulerView.vue`**，按角色构造 payload；未改后端权限/执行逻辑、未改 dry-run 横幅、未改推送/微信、未改 Schema/Migration/`.env`、未连库、未调 LLM/微信、未真实推送、未 Git 写操作、未处理历史 B-1/T1/P3。
**结论**：完成。member 保存自己的自动化模式不再携带被后端拒绝的全局字段，P4「每客户自动化模式」对 member 恢复可用；admin 全局能力不变；全局开关对非 admin 禁用并提示权限；成功/失败反馈真实。三角色 + 失败 + 多视口主题浏览器验证全过，Console 0 error。

---

## 1. 后端真实字段权限（核查结论）
真源 `server/src/api/routes/scheduler.ts`：
- `configSchema`（:44-54）接受 `automationMode`/`writeTime`（个人）、`enabled`/`pushEnabled`（全局）。
- PUT `/config`（:89-125）：
  - **全局字段**：`enabled`/`pushEnabled` 只要出现在 body（`!==undefined`），非 admin 即抛 `BadRequestError('全局调度开关仅管理员可改')`（:90-94）——**与值是否变化无关，携带即拒绝**。
  - **个人字段**：`automationMode`/`writeTime` 写入 `principal.userId` 对应的 `User` 行（:96-105），member 有合法权限与更新逻辑。
  - **响应**：回传 `config`（全局）+ `my`（当前用户个人配置，:110-125）。
- **结论**：后端已完整支持 member 保存自己的自动化模式，无需改后端——问题纯在前端 payload 构造。

## 2. 原问题具体原因
`SchedulerView.vue` 原 `saveCfg`：`setSchedulerConfig({ ...cfg, automationMode, writeTime })`——展开 `cfg`（含 `enabled`/`pushEnabled`，:35 初始化）导致 member 请求必带全局字段 → 后端 :90-94 一律拒绝 → member 报「全局调度开关仅管理员可改」（用户根本没操作全局开关），P4 每客户模式对 member 不可用。

## 3. admin / member payload 差异
| 角色 | 提交 payload | 全局开关 | 依据 |
|---|---|---|---|
| admin | `{...cfg, automationMode, writeTime}`（含 enabled/pushEnabled） | 可编辑 | 后端 admin 有全局权限 |
| member / guest | `{automationMode, writeTime}`（**仅个人字段**） | **禁用** | 后端非 admin 携带全局字段即拒绝 |

通过 `useAuth().userRole` 派生 `isAdmin = userRole==='admin'` 决定 payload 与禁用态。**不是隐藏/删除功能**——模板仍展示全局开关，只是禁用并标注"当前账号无权限修改"，准确反映权限。

## 4. 修改文件与实现细节
**仅 `web/src/views/SchedulerView.vue`**：
1. 引入 `useAuth`，取 `userRole`；`import computed`。
2. 加 `isAdmin = computed(() => userRole.value === 'admin')`。
3. `saveCfg` 按 `isAdmin` 构造 payload：admin 展开 cfg；member/guest 只发 `{automationMode, writeTime}`。
4. 全局总开关 `el-switch` 加 `:disabled="!isAdmin"`，hint 追加"当前账号无权限修改"。
5. **保留**原有成功 toast「调度配置已保存」、失败 `ElMessage.error(errMsg(e,'保存失败'))`（显示真实错误，不吞错、不伪装成功）、成功后 `loadStatus()` 刷新读取。
未改：后端、scheduler 执行、dry-run 横幅（`:221` 条件保持）、推送/微信、其它页面。

## 5. 浏览器验证结果及 Mock 边界
走查 `var/tmp/s5ui2c/walk-p61.mjs`、派生 Mock `mock-p61.mjs`（auth 角色由夹具控制，PUT 记录 payload 并按角色模拟成功/拒绝，**不连库**），结果 `P61-result.json` + 截图 `P61-*.png`。

| 场景 | 实测 | 判定 |
|---|---|---|
| admin 全局开关 | `disabled=false`（可编辑） | ✅ |
| admin 保存成功 | payload 含 `enabled/writeTime/pushEnabled/automationMode`；绿 toast「调度配置已保存」 | ✅ 行为不变 |
| member 全局开关 | `disabled=true`（禁用） | ✅ 不误改全局 |
| member 保存成功 | payload **仅** `{"automationMode":"auto_draft","writeTime":"06:00"}`（无全局字段）；绿 toast | ✅ **P1 修复核心证据** |
| member 保存失败（Mock 500） | error toast「请求失败（HTTP 500）」，未显示成功 | ✅ 错误真实 |
| guest | 全局开关禁用；payload 仅个人字段（Mock 接受；真实环境 guest 无 requirePermission 会被后端拒，前端不提权） | ✅ 无额外权限 |
| 500px / 深色@500 | 开关禁用正确、`docOverflow=false` | ✅ |

**Mock 边界（如实声明）**：
- 全程 Mock 角色会话 + Mock scheduler API，**未建立真实 member 登录会话、未连库**，不宣称真实 member 端到端通过。
- "member 保存成功后 modeAfter 仍显示纯手动"是 Mock 的 GET /scheduler 固定返回 `my.automationMode='manual'` 未持久化所致（saveCfg 成功后 loadStatus 重拉）；真实后端 PUT 落库后 GET 应返回新值——属夹具限制，非产品缺陷，**未在真实环境验证**。

## 6. typecheck、build 与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 41.65s |
| 静态契约 | 角色 payload/禁用态/错误提示保留/dry-run 未改 | ✅ 8/8 |
| 浏览器三角色+失败+多视口 | `walk-p61.mjs` | ✅ Console 0 error |
| 后端 scheduler.ts | mtime 2026-11-11（本轮前） | 未改动 |
- diff 审查：仅 `SchedulerView.vue` 为业务代码改动；无后端/Schema/.env/dry-run 横幅改动。

## 7. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 75 项未提交改动全部原样保留；`SchedulerView.vue` 本就 modified，本轮在其上叠加；未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 8. 未连接数据库、未调用 LLM、未调用微信接口声明
未连接或写入任何数据库；未调用真实 LLM、微信公众号接口；未执行真实推送或群发；未修改 Schema/Migration/`.env`；未改后端权限；未装依赖、未改 package.json。浏览器用本地 Mock（vite 5208 / mock 8796），已停止、端口释放。

## 9. 尚存问题及风险
1. **userRole 默认 guest**：`useAuth()` 未加载时默认 guest → payload 走"仅个人字段"分支；对 admin 而言若极端时序下 auth 未加载就保存，会漏提交全局字段（不会报错，只是没改全局）。正常流程 App 启动已 loadAuth，风险低。
2. **全局开关禁用但可见**：member 能看到但无法操作全局开关，hint 已注明"仅管理员可改/当前账号无权限"——符合任务"不隐藏功能、不允许修改"的要求。
3. **真实 member 端到端未测**：见 §5 Mock 边界，需人工在测试环境用真实 member 会话确认落库与回显。

## 10. 结论
S5-UI-6-1 完成，member 自动化模式保存的 P1 已修复，admin 行为不变，错误提示真实。**本轮到此停止，等待人工验收，不进入 S5-UI-6-2，不改 dry-run 横幅，不提交 Git。**
