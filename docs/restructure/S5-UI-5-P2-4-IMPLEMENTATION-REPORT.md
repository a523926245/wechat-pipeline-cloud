# S5-UI-5-P2-4 · 无账号文章错误提示修正 · 实施报告

**日期**：2026-11-18
**性质**：小范围前端提示修正（S5-UI-5 审计 E-2）。**只修无账号这一类错误的引导**，未改后端 API/错误码/认证/推送逻辑、lint 门禁/防重复推送/推送事实、账号配置功能；未改 Schema/Migration/`.env`；未连库、未调 LLM/微信、未真实推送、未 Git 写操作、未实施 P3。
**结论**：完成。无账号错误（后端明确 `reason:'no_account'`）在列表页与编辑页都改为准确可执行的引导：有权限（admin/member）显示「去账号管理」跳真实路由 `/accounts`，guest 只提示联系管理员不跳转。六类错误（无账号/凭据缺失/格式错误/停用/微信失败/未知）浏览器实测互不误判；成功路径与"只推草稿箱不群发"不变；Console 0 error。

---

## 1. 后端无账号错误的真实返回结构（核查结论，非编造）
真源 `server/src/services/publisher.ts` `pushOnce`（`:106-157`）+ `PushReason` 联合类型（`:36-47`）：
- 无账号：`a.accountId` 为空 → 返回 `{ ok:false, id, reason:'no_account', message:'文章未绑定账号，无法推送。请先指定 accountId' }`（`:137-143`）。
- **推送路由 `POST /articles/:id/push` 以 HTTP 200 返回整个 `PushResult`**（`articles.ts:705-706`），业务失败靠 `ok:false` + `reason`，不是 HTTP 错误码。
- **错误码后端已明确区分**：`no_account`（未绑定账号）、`cred_not_ok`（凭据状态非 ok，带 credStatus）、`empty_content`、`lint_failed`、`already_pushed`、`pushing`。微信接口失败带 `errcode`。→ **无账号与其他账号错误在后端可靠区分**，前端按 `reason` 判断即可，不需改后端。
- 原 message「请先指定 accountId」正是审计 E-2 的问题：UI 无"指定 accountId"操作。

## 2. 前端原错误处理位置和问题原因
- `web/src/utils/article-push.ts` 的 `pushFailView()` 只分类 `lint_failed`/`already_pushed`/`pushing`，**无 `no_account` 分支** → 落入兜底标题「推送未成功（无 errcode）」。
- 两处消费：`ArticlesView.vue`（列表推送，原 :257-273）、`ArticleEditView.vue`（改稿页推送，原 :624-650），共用 `pushFailView` + `ElMessageBox.alert(res.message, view.title)`。
- 结果：用户看到"推送未成功（无 errcode）"+ 正文"请先指定 accountId"，既误解成微信报错，又不知去哪配置——与真实原因和可执行操作都不符。

## 3. 账号管理页面真实路由与权限（核查结论）
- **路由**：`web/src/router/index.ts:48-51` → `/accounts`，name `accounts`，`meta:{title:'账号管理'}`；并有 `/credentials → /accounts` 重定向。**无 `meta.roles` 限制**（普通登录用户可打开页面）。
- **权限**：后端 `credentials.ts:36` 全路由 `requirePermission('oa_account:manage')`；`permissions.ts:31-49` 中 `admin`/`member` 有该权限，`guest` 只有 `data:view`。
- **前端角色**：`useAuth()`（`composables/useAuth.ts`）暴露 `userRole`（默认 `'guest'`）；`App.vue:90` 菜单 `/accounts` 对 admin/member 可见、guest 不可见。
- **文案边界**：沿用 P2-2 口径——不写"账号已就绪/已验证"，提示中明确"格式合规 ≠ 接口验证成功"，并引导点"测试连通"。

## 4. 修改文件及具体变更
| 文件 | 变更 |
|---|---|
| `web/src/utils/article-push.ts` | `pushFailView` 加 `no_account` 分支（标题「尚未配置可用于推送的公众号账号」，type=warning，明确不是微信报错）；新增**纯函数** `noAccountGuide(role)` 返回 `{message, canManage}`：admin/member→提示去账号管理新增/填 AppID/Secret/测试连通 + "不会群发"，canManage=true；guest→提示联系管理员，canManage=false。保持该模块"无 Vue/API 依赖、可被断言脚本加载"的属性。 |
| `web/src/views/ArticlesView.vue` | 导入 `useAuth`/`noAccountGuide`，取 `userRole`；推送失败分支加 `res.reason === 'no_account'` 特判：有权限用 `ElMessageBox.confirm`（稍后/去账号管理）并 `router.push('/accounts')`，guest 用 `ElMessageBox.alert`（仅"知道了"，不跳转）；其它错误走原 `pushFailView`+alert。 |
| `web/src/views/ArticleEditView.vue` | 同上（导入/角色/no_account 特判），与列表页含义一致；其它错误、lint 报告回刷、推送后 load 等逻辑未动。 |

**未改**：后端任何文件、账号管理页、路由、推送/门禁/防重/存档、P1/P2-1/P2-2/P2-3 成果。

## 5. 无账号与其他错误类型的区分方式
**按后端 `reason` 精确匹配，不靠中文 message**：
- 仅 `res.reason === 'no_account'` 走新引导；`cred_not_ok`（含 cred_missing/cred_invalid/停用）、`wechat_error`（errcode）、其它未知 reason 一律走原处理。
- 浏览器实测六类互不串：cred_* 仍显示「推送未成功（无 errcode）」+原 message；微信失败显示「推送未成功（40164）」；unknown 兜底；**无一被误判为无账号**（见 §6）。

## 6. 列表页/编辑页浏览器验证
走查 `var/tmp/s5ui2c/walk-p24.mjs`、派生 Mock `mock-p24.mjs`（夹具切换 6 类错误 + admin/guest 角色，不进版本库），结果 `P24-result.json` + 截图 `P24-*.png`。

| 场景 | 实测 | 判定 |
|---|---|---|
| 列表页 no_account（admin） | 标题「尚未配置可用于推送的公众号账号」；正文"没有绑定账号+去账号管理新增/填AppID/Secret/测试连通（不会群发）"；按钮「稍后/去账号管理」 | ✅ |
| 编辑页 no_account（admin） | 同上 | ✅ |
| 点击"去账号管理" | `location.pathname === '/accounts'`（真实路由） | ✅ |
| 列表页 no_account（guest） | 正文改"联系管理员或有管理权限的成员"；按钮**仅「知道了」**；无跳转尝试 | ✅ |
| cred_missing / cred_invalid / cred_disabled | 「推送未成功（无 errcode）」+后端原 message，无账号引导未出现 | ✅ |
| wechat_fail | 「推送未成功（40164）」+原 message | ✅ |
| unknown | 「推送未成功（无 errcode）」+兜底 message | ✅ |
| 推送成功 | green toast「已推送到草稿箱（未群发）」，无失败弹窗 | ✅ |

- 推送前原有的二次确认框「推送确认…（不会群发）」保持原样（脚本先确认才看到结果框）。

## 7. 配置入口跳转及权限验证
- admin/member：弹窗含「去账号管理」→ 点击跳 `/accounts`（`router/index.ts` 的真实路由，非虚构）；未自动创建账号、未自动填凭据、未自动测试。
- guest：`noAccountGuide('guest').canManage=false` → 只 alert「知道了」，**不出现跳转按钮、不执行无权限跳转**；正文提示由管理员处理。
- 文案未引入"已就绪/已验证"，明确"测试连通只验证接口、不会群发"。

## 8. 桌面 / 500px、浅色 / 深色
- 桌面 1440：列表页/编辑页引导正确（截图 `P24-list/edit-noaccount-1440.png`）。
- 500px：引导正确、`docOverflow=false`（截图 `P24-list-noaccount-500.png`）。
- 深色@500：`html.dark=true`、弹窗可见、无渲染异常（截图 `P24-list-noaccount-500-dark.png`）。
- 全部场景 **Console 0 error**；未破坏文章编辑、保存和离页保护（本轮只在 push 失败分支加提示）。

## 9. typecheck、build 和测试结果
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 7.62s |
| 回归断言 | `npm run test:article-push` | ✅ 26/26（含"无 errcode 如实显示""lint_failed 优先级"） |
| 静态契约 | no_account 分类/权限口径/真实路由/两页特判/guest 单按钮 | ✅ 9/9 |
| 浏览器六错误场景 | `walk-p24.mjs` | ✅ Console 0 error |
| 写库/真实服务测试 | — | 未运行（禁止连库/LLM/微信），用 Mock 覆盖 |
- diff 审查：本轮仅改 `article-push.ts`/`ArticlesView.vue`/`ArticleEditView.vue` 三个前端文件；`server/src/services/publisher.ts` 等 server 改动是**本轮前既有未提交改动**（mtime 为前一日 21:35，非本轮引入），未触碰。

## 10. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 72 项未提交改动全部原样保留；未覆盖/回滚/清理；本轮只在上述 3 个前端文件叠加。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 11. 未连接数据库、未调用 LLM、未调用微信接口、未执行真实推送声明
未改后端 API/错误码/认证/推送逻辑；未连接或写入任何数据库；未调用真实 LLM、微信公众号接口；未执行真实推送或群发；未安装依赖、未改 package.json。浏览器用本地 Mock（vite 5207 / mock 8795），已停止、端口释放。

## 12. 尚存问题及风险
1. **`userRole` 默认 guest**：`useAuth()` 在 auth 未加载完成时为 guest；若极端时序下推送失败发生在加载前，会显示"联系管理员"而非跳转。正常流程 App 启动时已 loadAuth，风险低。
2. **cred_not_ok 文案未顺带优化**：凭据问题仍显示后端 message「凭据状态为 X，请先配置并连通测试」+「无 errcode」标题——本轮授权仅无账号一类，未动（任务书明确不顺带重构）。
3. **路由 role 与权限口径**：`/accounts` 前端无 roles 限制、后端 API 需 `oa_account:manage`；guest 即使手动输入 URL 也打不开账号数据。本轮按权限口径给出引导，未改路由守卫。

## 13. 结论
S5-UI-5-P2-4 完成，无账号错误在两页都给出与后端真实状态一致、且在当前权限下可执行的引导，其他错误类型与推送成功路径无回归。**本轮到此停止，等待人工验收，不实施 P3，不提交 Git。**
