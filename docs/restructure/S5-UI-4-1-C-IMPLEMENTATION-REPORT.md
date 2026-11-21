# S5-UI-4-1-C · 模型就绪状态准确性修正 · 实施报告

**日期**：2026-11-17
**性质**：局部前端修正（基于 S5-UI-4-0 审计 C-1）。**业务代码只改 `web/src/views/ModelsView.vue` 一个文件**；未改后端/Schema/Migration/`.env`、未连库、未调真实 LLM/微信、未推送、未装依赖、未改 package.json、未 Git 写操作、未回退 A/B 阶段改动。
**结论**：完成。前端就绪状态改为**直接展示后端 `GET /models/resolve/:role`（`tryResolveForRole`）的 `usable`/`reason` 真源**，不再本地复刻判断。七类状态在浏览器逐项验证，前端 tag 文案与后端真源 expected **7/7 完全一致**，tooltip 展示完整 reason。typecheck / build 通过，Console 0 error。

---

## 1. 后端真实解析规则（核查结论，非推测）
真源：`tryResolveForRole`（`server/src/services/llm.ts:953-983`）+ `roleAcceptsModel` / `isProtocolImplemented` / `ROLE_SPEC`（`model-registry.ts`）。**校验顺序**：
1. 已绑定（`modelBinding` 有该 role 行）→ 否则「尚未给「X」角色绑定模型」；
2. 模型存在 → 否则「绑定的模型已不存在」；
3. 已启用 → 否则「模型「X」已被停用」；
4. **能力匹配**：`spec.capabilities.includes(model.capability)` → 否则「需要 text/multimodal/image 能力的模型…」；
5. **协议 kind 匹配**：`protocolKind(model.protocol) === spec.kind`（chat/image）→ 否则「需要对话/生图类协议…」；
6. **协议白名单**：`spec.protocols.length>0 && !includes(model.protocol)` → 否则「只接受 X 协议的模型…」；
7. **协议已实现**：`isProtocolImplemented` → 否则「协议「X」尚未实现」；
8. **有 Key**：`apiKeyEnc` 非空 → 否则「未配置 API Key」；
9. 全部通过 → `usable=true`。
`GET /models/resolve/:role`（`models.ts:287-296`）把上述结果以 `{ role, model, usable, reason }` 返回。**这是实际生成时的同一套解析**，`assertRoleUsable` 也走它。

**角色要求实例**（真源 `ROLE_SPEC`）：写作/改写/扩角度/漫画脚本要 `text|multimodal` + chat 类协议；封面要 `image`；漫画格要 `image` + `modelscope_qwen_image|agnes_image`；漫画格备选通道要 `image` + `modelscope_qwen_image_mcp`。

## 2. 前端原判断缺陷
`bindState` 原实现只判「绑定 → 存在 → 启用 → 有 apiKeyMask」四环，**缺了能力匹配、协议 kind、协议白名单、协议是否实现**。后果：给「写作」角色绑一个已启用、有 Key 的生图模型，前端显示「就绪」，但后端 `tryResolveForRole` 在第 4 步就判不可用 → 实际写作时报错。这正是审计 C-1 的误报。

## 3. 最终采用的判断依据与改动
**依据 = 后端 resolve 真源**，前端不复刻规则：
- 新增 `resolutions = ref<Record<string, RoleResolveResult>>({})`；
- `load()` 用 `Promise.allSettled` 并行拉每个角色的 `resolveRole(role)`（接口 `GET /models/resolve/:role` 已存在、`resolveRole()` 与 `RoleResolveResult` 类型前端已封装——**未新增接口**）；单个角色失败不影响其他角色；
- `bindState(role)` 优先读 `resolutions[role]`：`usable=true` → 就绪；`usable=false` → 按后端 `reason` 关键词映射为短 tag 文案（未绑定/绑定已失效/模型已停用/能力不匹配/协议未实现/协议不匹配/未填 API Key），**是否可用完全由 `usable` 决定**；resolve 缺失（接口失败降级）时才回落原本地基础判断，页面不崩；
- 角色卡片状态 tag 加 `el-tooltip`，展示后端完整 `reason`（用户能看懂下一步怎么处理）。
**未改**：模型绑定/启用/测试/解析/生成任何业务行为；未改页面其他部分；未改 `FALLBACK_ROLES` 等既有逻辑。

## 4. 各类状态测试结果（真源 expected vs 前端展示）
expected 由脚本 `server/var/tmp/model-case-expected.ts` **直接 import 后端 `roleAcceptsModel`/`isProtocolImplemented`/`ROLE_SPEC`**、按 `tryResolveForRole` 同序算出（非手写），保存于 `model-case-expected.json`。Mock 的 resolve 响应直接取这份 expected。浏览器走查脚本 `var/tmp/s5ui2c/walk-4-1c.mjs` + `walk-4-1c-cap.mjs`，结果 `C41C-result.json` / `C41C-cap-result.json`。

| 场景 | 角色 | 后端真源 expected.text | 前端 tag | 一致 | tooltip（后端 reason） |
|---|---|---|---|---|---|
| 就绪 | write | 就绪 | 就绪 | ✅ | 后端解析可用，可用于该角色 |
| 未绑定 | revise | 未绑定 | 未绑定 | ✅ | 尚未给「改写」角色绑定模型 |
| 已停用 | cover | 模型已停用 | 模型已停用 | ✅ | 模型「封面模型」已被停用 |
| 未填 Key | expand_angles | 未填 API Key | 未填 API Key | ✅ | 模型「扩题模型」未配置 API Key |
| 绑定失效 | comic_script* | 绑定已失效 | 绑定已失效 | ✅ | 「漫画格」角色绑定的模型已不存在 |
| 真正就绪（image 角色） | comic_panel | 就绪 | 就绪 | ✅ | 后端解析可用，可用于该角色 |
| 协议不匹配 | comic_panel_fallback | 协议不匹配 | 协议不匹配 | ✅ | 「漫画格（备选通道）」只接受 MCP 生图协议…用的是 Agnes 生图协议 |
| 能力不匹配 | comic_script* | 能力不匹配 | 能力不匹配 | ✅（补充走查） | 「写作」需要文本/多模态能力…能力是图像 |

\* 绑定失效与能力不匹配两次走查分别把 comic_script 的 Mock resolve 设为对应 expected（真源算出），因此分列两行。

**前后端规则一致性证据（任务第 8 条）**：前端 tag 文案来自后端 `usable`/`reason`，expected 由后端真源函数算出，浏览器实测 7/7（主走查）+ 1/1（补充）+ 全部一致；没有任何"前端自己的一套判断被证明正确"——展示值与后端解析同源。

## 5. 浅色 / 深色 / 窄屏
- 浅色（1440）：7 个角色卡片状态文案、配色齐全（success/info/warning/danger）。
- 深色（1440）：`html.dark=true`，7 个卡片文案与配色与浅色一致，无异常（截图 `C41C-02-dark.png`）。
- 窄屏（500px）：7 个角色卡片全部在视口内（`inView=true`，单卡宽 370），状态文案正确，`docOverflow=false`（截图 `C41C-03-narrow.png`）。
- Console：主走查与补充走查均 **0 error**。

## 6. 类型检查、构建与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web 生产构建 | `npm run build` | ✅ built in 14.99s |
| 模型相关测试 | `npm run smoke:models`（server） | **未运行**：脚本含 `prisma.llmModel.deleteMany({})` + 备份恢复，属写库操作，超出本轮"不连库/不改数据"边界；模型状态逻辑改由上述 Mock + 真源 expected 走查覆盖 |
| 浏览器走查 | `walk-4-1c.mjs`、`walk-4-1c-cap.mjs` | ✅ 7/7 + 1/1 一致，Console 0 error |

**连库核查**：`smoke:models` 在执行前已读源码确认会连库并清表（故主动不跑）；走查用本地 Mock。全程未连接或写入任何数据库。

## 7. 修改文件
- `web/src/views/ModelsView.vue`（唯一业务文件：resolve 导入、resolutions 状态、load 并行拉取、bindState 真源化、状态 tag tooltip）
- `docs/restructure/S5-UI-4-1-C-IMPLEMENTATION-REPORT.md`（本报告）
- `docs/DEVLOG.md`（追加一条）

## 8. 遗留问题与已知风险
- **接口失败降级**：某角色 resolve 请求失败时，该角色回落本地基础判断（可能仍无法识别能力/协议不匹配）——这是可用性取舍，接口正常时全部走真源；Console 未报错。
- **Mock 数据**：走查用手写夹具，但 resolve 的 usable/reason 来自后端真源函数算出的 expected，一致性结论可信；真实库端到端未测（本轮禁止连库）。
- **FALLBACK_ROLES 漂移**（审计 C-2，P3）：meta 失败降级时前端兜底角色少一个，不在本轮范围，未处理。

## 9. Git HEAD 和工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 64 项未提交改动全部保持原样；`ModelsView.vue`、`StylePromptsView.vue`（A）、`TrackAnglesView.vue`（B）均为既有 modified，本轮只叠加 ModelsView 改动，未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/stash/checkout。
- **临时产物**：真源脚本、expected JSON、Mock、走查脚本/截图在 `server/var/tmp/` 与 `var/tmp/s5ui2c/`（不进版本库）；服务（8789/5201）、Chrome（9389/9390）已停止、端口全部释放。

## 10. 明确未触碰
未改后端 API/Schema/Migration/`.env`；未连接或写入 MySQL；未调用真实 LLM、微信公众号任何接口；未执行推送；未安装依赖、未改 package.json；未回退 A/B 阶段改动。

## 11. 结论
S5-UI-4-1-C 完成，模型就绪状态改为后端真源驱动，七类状态前后端一致性经浏览器客观数据证明。**本轮到此停止，等待人工验收，不进入 S5 后续阶段，不提交 Git。**
