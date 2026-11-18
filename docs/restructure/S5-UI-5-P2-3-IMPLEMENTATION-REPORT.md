# S5-UI-5-P2-3 · 文章体检命中片段展示 · 实施报告

**日期**：2026-11-18
**性质**：小范围前端展示补齐（S5-UI-5 审计 E-1）。**只把后端真实返回的 `hits` 展示出来**，未改 lint 规则/阈值/命中算法、存档/历史/推送门禁、文章保存/改写/推送逻辑；未改后端任何文件、Schema/Migration、`.env`；未连库、未调 LLM/微信、未推送、未 Git 写操作、未实施 P2-4。
**结论**：完成。八类数据场景 + 桌面/500px + 深浅色浏览器验证全过；空/null/缺失/字段不全安全降级，超长截断+展开全文，多条逐项展示可展开收起；Console 0 error，无横向溢出。

---

## 1. 后端 hits 的真实结构与语义（核查结论，非猜测）
真源 `server/src/services/lint.ts`：
- **`LintIssue.hits?: string[]`**（`:42-69`）——可选字符串数组。注释明确两个用途：给 writer 定向修补当证据、**将来给改稿页做一键定位**（即本轮）。
- **数据来源**：`hitSnippets(flat, RE)`（`:163-174`）取命中点**前后各 24 字**的上下文片段；星座专属 `zodiac_textbook/repeat/dup`（`:246/261/285`）直接给 `string[]`（如 `["双子×2"]`）。
- **数量**：最多 `MAX_HITS = 3`（`:146`），`hitSnippets` 默认 max=3，专属检查 `.slice(0,3)`。
- **一对多**：一条 issue 可带 1–3 条命中；很多规则（sections/chars/ending_hook）**没有 hits 字段**。
- **到达前端的路径已核实**：`GET /articles/:id/lint` 路由 `res.json({ lint })` 直接序列化 `lintArticle()` 完整结果（含 hits）；前端 `checkArticleLint()`（api/index.ts:312-319）与 save/revise/push 响应把 `res.lint` 原样赋给 `rendered.value.lint`（ArticleEditView:189-192/619-620）。JSON 不剥离可选字段 → **hits 确实在前端响应里**。

## 2. 原前端丢弃 hits 的位置与原因
- **类型层**：`web/src/types.ts` 的 `ArticleLintIssue`（原 904-909）只有 level/code/message，**未声明 hits** → 类型层丢失。
- **展示层**：`ArticleEditView.vue` 体检问题列表模板（原 988-996）只渲染 `{{ it.message }}`，没有 hits 区域。
- **原因**：S5-UI-5 审计 E-1 指出后端的 hits 一路返回到前端却被这两层丢弃；与已延期的"blockIndex 一键跳转"不同——这是**已有文本片段**未展示，成本极低。

## 3. 修改文件与具体改动
| 文件 | 变更 |
|---|---|
| `web/src/types.ts` | `ArticleLintIssue` 加 `hits?: string[]`（注释说明可选、最多 3 条、带上下文）。 |
| `web/src/views/ArticleEditView.vue` | ① script 加 `lintHits(it)`：`Array.isArray(it.hits)` + 过滤非字符串/空白项 + `slice(0,3)`（与后端 MAX_HITS 对齐），异常字段安全降级为 `[]`；② `HIT_TRUNCATE_AT=48` + `hitShort()` 超长截断；③ `expandedHits = ref<Set<number>>` + `toggleHits(i)` 按问题下标展开/收起（用新 Set 保证响应）；④ 模板每个 `li` 内：问题说明放 `.lint-item-msg`，有有效 hits 时渲染 `.lint-hits`（逐条 `.lint-hit`，`:title="h"` 保留全文；多条或超长显示"展开全部/收起"）；⑤ 局部 scoped 样式（左边框+底色与说明区分、`word-break/overflow-wrap` 防溢出、轻量 toggle 按钮）。 |

**未改**：后端 lint.ts/lint-store.ts、types.ts 其他部分、P1 四态/P2-1/P2-2 逻辑、文章保存/改写/推送、存档历史、门禁。静态契约断言确认 diff 未触碰禁止范围（`lint.ts`/schema/`.env` 零改动）。

## 4. 命中信息与问题项的关联方式
按 `rendered.lint.issues` 的数组顺序，每个 issue 的 `v-for` 下标 `i` 即关联键：命中区渲染在该 issue 的 `<li>` 内部（问题说明正下方），展开状态用 `expandedHits.has(i)` 记录。**不跨问题串命中**（manyissues 场景实测三条问题各显示自己的命中）。

## 5. 空值、异常、长文本处理
- `hits=[]` / `hits=null` / 字段缺失：`lintHits()` 返回 `[]` → `v-if="lintHits(it).length"` 不渲染命中区，**保持问题展示、不报错、不伪造**（三场景实测 hitsShown=false）。
- 命中项字段不完整（Mock `[null, '', 123, '有效命中片段']`）：过滤后**只显示合法字符串**"有效命中片段"，无 `undefined`/`null`/`123`（`bodyHasUndefined=false`）。
- 超长片段：默认显示前 48 字 + `…`，`title` 属性保留全文；点"展开全部"显示完整文本（展开后正文与 title 逐字一致，实测 True）。
- 多条命中：逐项列出，最多 3 条（与后端一致）；点"展开全部/收起"切换。

## 6. Mock 场景与真实浏览器验证
走查 `var/tmp/s5ui2c/walk-p23.mjs`、派生 Mock `mock-p23.mjs`（夹具文件切换 8 场景，不进版本库），结果 `P23-result.json` + 截图 `P23-*.png`。**命中内容来自 Mock 后端 returns 的真实 `hits` 字段，前端未拼接/生成**。

| 场景 | 实测结果 | 判定 |
|---|---|---|
| 一条问题一条命中 | 显示「她终于说出——那句憋了很久的话」，title 同文 | ✅ |
| 一条问题三条命中 | 逐项显示甲乙丙，按钮"展开全部"→"收起" | ✅ |
| 多条问题各自命中 | 3 条问题各显示自己的命中，不串 | ✅ |
| hits=[] | 不渲染命中区 | ✅ |
| hits=null | 不渲染命中区，不报错 | ✅ |
| hits 字段缺失 | 不渲染命中区 | ✅ |
| 字段不完整 | 仅显示合法字符串，无 undefined/null | ✅ |
| 超长片段 | 截断显示 + 展开后全文（与 title 一致） | ✅ |

## 7. 桌面 / 500px、浅色 / 深色
- 1440 桌面：8 场景命中区正常（截图 `P23-one/multi/long-1440.png`）。
- 500px：命中区正常、文字 `word-break` 生效、`docOverflow=false`（截图 `P23-one-500.png`）。
- 深色@500：`html.dark=true`、命中可见、无渲染异常（截图 `P23-one-500-dark.png`）。
- 全部场景 `docOverflow=false`、`bodyHasUndefined=false`、**Console 0 error**。
- 未破坏现有体检结果/文章编辑/保存操作（本轮只在问题项内追加展示，未改任何交互逻辑）。

## 8. typecheck、build 与测试
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck` | ✅ exit 0 |
| web build | `npm run build` | ✅ built in 7.58s（ArticleEditView chunk 24.19 kB） |
| 静态契约断言 | hits 类型/过滤/截断/折叠/模板/禁止范围 | ✅ 9/9 通过，禁止范围零改动 |
| 浏览器八场景 | `walk-p23.mjs` | ✅ Console 0 error |
| 写库/真实服务测试 | — | 未运行（本轮禁止连库/LLM/微信），用 Mock 覆盖 |

## 9. Git HEAD 与工作区保护
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 71 项未提交改动全部原样保留；`ArticleEditView.vue`/`types.ts` 本就 modified，本轮在其上叠加；`lint-store.ts` 等既有改动未触碰；未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/stash/checkout。

## 10. 未连接数据库、未调用 LLM、未调用微信接口、未执行真实推送声明
未改后端 API/Schema/Migration/数据；未连接或写入任何数据库；未调用真实 LLM、微信公众号接口；未执行推送；未安装依赖、未改 package.json。浏览器用本地 Mock（vite 5206 / mock 8794），已停止、端口释放。命中片段仅来自当前体检响应，未额外请求正文、未发外部服务、未在日志/报告中暴露完整文章内容（报告只引用 Mock 的测试短句）。

## 11. 尚存问题及风险
1. **未做段落一键定位**：本轮只展示文本片段（E-1 原问题），未实现"点击命中跳到正文对应位置"——那需要 blockIndex/Range 定位，属已延期的独立事项，任务书未要求。
2. **截断长度 48 字是前端常量**：与实际命中片段（前后各 24 字，通常 ~50 字）接近，多数命中会走"展开全部"或 title 看全文；若产品觉得频繁展开烦，调大常量即可（局部、低风险）。
3. **`hits` 最多 3 条的前端 slice(0,3)**：与后端 MAX_HITS 对齐；若未来后端调大上限，前端需同步——当前一致，非缺陷。

## 12. 结论
S5-UI-5-P2-3 完成，后端 `hits` 在文章编辑页得到准确、克制的展示，异常与长文本场景均有安全降级与查看全文途径。**本轮到此停止，等待人工验收，不实施 P2-4，不提交 Git。**
