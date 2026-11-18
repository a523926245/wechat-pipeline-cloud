# S5-UI-5-P2-2 · 账号凭据状态措辞修正 · 实施报告

**日期**：2026-11-18
**性质**：小范围前端文案修正（S5-UI-5 审计 C1）。**只改状态语义与 UI 提示**，未改后端 API/凭据校验/AES-GCM 存储/AppID-Secret 保存流程、未调微信、未连库、未改 Schema/Migration/`.env`、未改 P1/P2-1 逻辑、未实施 P2-3/P2-4、未 Git 写操作。
**结论**：完成。`credStatus=ok` 由「就绪」改为「格式合规」，配 tooltip 明确"不代表接口验证成功"；全局账号相关展示一致，模型角色/漫画产物的「就绪」未误改。四态 + 桌面/500px + 深浅色浏览器验证全过，Console 0 error。

---

## 1. credStatus 后端真实语义（核查结论）
真源 `server/src/services/accounts.ts:23,66-78`：
- `CredStatusDb = 'ok' | 'placeholder' | 'missing' | 'invalid'`。
- `decideCredStatus(appid, secret)` **只做格式校验**：`missing`=两者皆空；`placeholder`=占位示例值；`invalid`=validateCredentials 判格式错误；`ok`=validateCredentials 判格式合规（`enabled=true`）。
- **数据库 `OAAccount` 无 `verified`/`testedAt`/`lastTest`/`testResult` 等真实验证状态字段**（schema `:187-210` + grep 全后端确认）。连通测试会真实调微信 token，但**不落库任何"已验证"状态**。
- 因此系统**没有可信的"真实接口验证状态"**——`ok` 绝不能表述为「已验证/可用/就绪」，只能表述为「格式合规」。这正是审计 C1 的核心。

## 2. 原有误导性文案与位置
| 位置 | 原文案 | 问题 |
|---|---|---|
| `utils/format.ts:116` CRED_TEXT.ok | 就绪 | 核心误导源，所有 credText 调用处受影响；`invalid:无效`、`missing:缺失` 也不够精确 |
| `AccountsView.vue:334` PageHead desc | 就绪 N 个 | 把格式合规数叫"就绪" |
| `DashboardView.vue:76` metric label | 就绪账号 | `c.accounts.ready = enabled && credStatus==='ok'`，不含真实验证 |
| `EmptyState.vue:12`/`PlanView.vue:226`/`DashboardView.vue:569` 空态 | 需凭据就绪且启用 | "凭据就绪"暗示认证成功 |

## 3. 修改文件与新文案
| 文件 | 变更 |
|---|---|
| `web/src/utils/format.ts` | `CRED_TEXT`: ok→**格式合规**、invalid→格式错误、missing→未填写、placeholder 保持待填写；新增导出 `credHint(status)`：ok→「AppID / AppSecret 格式符合要求；尚未代表微信公众号接口验证成功，请点「测试连通」确认。」，其余三态各有准确说明。加注释说明 credStatus 只做格式校验。 |
| `web/src/views/AccountsView.vue` | 导入 `credHint`；PageHead desc→「凭据格式合规 N 个（不代表接口已验证）」；状态列 el-tag 外包 `el-tooltip :content="credHint(...)"`；内部变量 `readyCount`→`credOkCount`（可读性）。 |
| `web/src/views/DashboardView.vue` | metric label「就绪账号」→「格式合规账号」；空态文案→「需凭据格式合规且启用」。 |
| `web/src/views/PlanView.vue` | 空态文案→「需凭据格式合规且启用」（仅文案，P1/P2-1 逻辑未碰）。 |
| `web/src/components/EmptyState.vue` | 仅注释示例文案更新（无渲染行为改动）。 |

**未改**：后端任何文件、`types.ts`、P1 四态结果处理、P2-1 warnings/backlog 展示、账号加密/保存/测试逻辑。

## 4. 全局搜索核查结果
- 全前端 grep `credStatus === 'ok'` / `就绪账号` / `需凭据就绪` / `ok: '就绪'`：**修改后零残留**。
- **未误改**：`ModelsView.vue:523/547` 的「就绪」是**模型角色解析状态**（S5-UI-4-1-C 后端 resolve 真源）、`ArticleEditView.vue:670` 的「已就绪」是**漫画插图产物状态**——均与账号凭据无关，保持原样（静态契约断言验证仍在）。

## 5. 各状态 Mock 验证（真实浏览器）
走查 `var/tmp/s5ui2c/walk-p22.mjs`、派生 Mock `mock-p22.mjs`（四态账号，不进版本库），结果 `P22-result.json` + 截图 `P22-*.png`。

| 账号 | credStatus | 前端 tag 文案 | 判定 |
|---|---|---|---|
| A格式合规 | ok | **格式合规** | ✅ |
| B未填写 | missing | **未填写** | ✅ |
| C占位值 | placeholder | **待填写** | ✅ |
| D格式错误 | invalid | **格式错误** | ✅ |

- **tooltip（hover 格式合规 tag）**：「AppID / AppSecret 格式符合要求；尚未代表微信公众号接口验证成功，请点「测试连通」确认。」——实测命中。
- **页面无「就绪」**：`bodyHasMisleading.hasOldReady=false`。
- **「已验证」字样来源核查**：`verifiedContext` 只捕获到 PageHead 的「不代表接口已验证」——这是准确表述"（尚）未验证"，非误导。
- **Dashboard**：`hasFormatted=true`、`hasOldReady=false` → 与账号页全局一致。
- **真实验证状态**：后端不存在该字段，故无第五态可覆盖（已在 §1 说明，未凭空新增）。

## 6. 视口与主题
- **桌面 1440**：四态文案、tooltip、PageHead desc 均正确（截图 `P22-accounts-1440.png`）。
- **500px**：四态文案正确（格式合规/未填写/待填写/格式错误）、`docOverflow=false`（截图 `P22-accounts-500.png`）。
- **深色@500**：`html.dark=true`，标签颜色正常（绿/橙/灰），无渲染异常（截图 `P22-accounts-500-dark.png`）。
- 四态走查 Console **0 error**。

## 7. 类型检查、构建与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 7.96s |
| 静态契约断言 | 文案正确性 + P1/P2-1 无回归 + 模型就绪未误改 | ✅ 11/11 通过 |
| 浏览器四态/多视口 | `walk-p22.mjs` | ✅ Console 0 error |
| 账号专属测试 | web 层无账号专属断言脚本；server `smoke:auth` 等需连库/写数据 | 未运行（超本轮边界），改由 Mock 浏览器验证 |

## 8. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 70 项未提交改动全部原样保留；`AccountsView.vue`/`format.ts` 本就 modified，本轮在其上叠加；未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 9. 未连接数据库、未调用微信接口声明
未改后端 API/Schema/Migration/`.env`；未连接或写入任何数据库；未调用真实微信公众号接口；未测试真实凭据；未推送；未安装依赖、未改 package.json。浏览器用本地 Mock（vite 5205 / mock 8793），已停止、端口释放。

## 10. 尚存问题及风险
1. **`ok` 标签仍为绿色 `success` tag**：颜色可能仍让人联想到"成功认证"。本轮按"最小改动"只改文案+tooltip 澄清，未改颜色（改色属视觉调整，可能引入跨页一致性问题）。若验收要求更中性，可另立小改动把 ok 改 info/primary。
2. **连通测试不落库验证状态**：本次修正准确反映了"系统无真实验证状态"这一事实；若未来产品要求"已验证"状态，需后端新增字段与状态机（本轮禁止）。
3. **Dashboard metric hint**：`hint` 仍显示「启用 N · 赛道 M」，与 label「格式合规账号」组合表达为"格式合规 N/总 M，其中启用 N'"，语义准确。

## 11. 结论
S5-UI-5-P2-2 完成，账号凭据状态表达与后端真实语义一致，全局无「就绪」残留且未误改其他域的「就绪」。**本轮到此停止，等待人工验收，不实施 P2-3/P2-4，不提交 Git。**
