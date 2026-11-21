# S5-UI-4-1-A · 文风配置与写作规范修复 · 实施报告

**日期**：2026-11-17
**性质**：小范围前端修复（基于已验收的 S5-UI-4-0 审计 S1/S2/P1）。**本轮唯一业务代码改动集中在 `web/src/views/StylePromptsView.vue` 一个文件**，未改后端/Schema/Migration/`.env`、未连库、未调 LLM/微信、未推送、未装依赖、未改 package.json、未 Git 写操作。
**结论**：A/B/C 全部完成并经真实浏览器走查验证——写作规范 Tab 已回到赛道面板、`s:{赛道}` key 保存链正确（实测 `PUT /api/style-prompts/s%3A%E6%98%9F%E5%BA%A7`）、恢复默认准确定位当前赛道、赛道间不混用、全局库不再承载写作规范。typecheck 通过，走查控制台 0 error。

> **任务书边界说明**：任务书在「不修改提示词内容或」处截断；A/B/C/D 要求完整，本轮严格按 A/B/C 实施并保持 D 边界（不新增 DB 模型/Migration、不改内容生成算法、不改提示词内容）。截断处未擅自扩展范围。

---

## 1. 链路追踪结论（实施前，以实际后端为准）
| 检查项 | 结论（代码证据） |
|---|---|
| 页面路由/Tab 结构 | `/style-prompts` → `StylePromptsView.vue`；左导航 `创作总纲` + 各赛道；赛道面板 `el-tabs v-model="trackTab"` 六个 Tab（sys/prompt/spec/title/structure/length） |
| 全局库 vs 赛道配置 | 全局变体库面板 `current==='gv'`（`:648`）；赛道面板 `currentTrack`（`:708+`）。两者独立，`currentEditorKey` 按 current 分派 |
| 写作规范存储 key | **`s:{赛道}` 合法**：后端 `SPEC_PREFIX='s:'`、`specKey(track)`、`defaultFor('s:星座')` 返回 `DEFAULT_TRACK_SPECS['星座']`（`style-prompts.ts:33/54/2277`）；WRITING-PIPELINE §2/§9 明确写稿注入 `s:{赛道}` |
| `v:global:spec` 合法性 | **不合法**：`parseVariantKey` 要求 dim ∈ title/structure/length（`:857-868`），spec 解析失败 → `defaultFor` 返回 null；`v:global:{dim}` 仅作赛道变体兜底种子 |
| 后端读/写/恢复默认 key | 读 `GET /style-prompts` list + `GET /:key`；写 `PUT /:key`；恢复默认 `GET /:key/default`（路由 `:104-110`） |
| `currentEditorKey` 全分支 | `global`→`global`；`gv`→`v:global:{gvTab}`；赛道 `prompt`→赛道名、`sys`→`sys:`、**`spec`→`s:`（原为死代码）**、其余→`v:{赛道}:{dim}` |
| 默认数据来源 | 后端 `allDefaults()`：`systems/variants/rules` 的 key **带前缀**，`specs` 的 key 是**裸赛道名**（`style-prompts.ts:2323`） |
| 缓存/状态 | 前端 `buf`/`saved` 两个 reactive 对象 + `savedAt` 派生；无 Pinia、无 localStorage 持久化；`onMounted load()` 拉后端列表覆盖 |

**根因确认**：写作规范 Tab 曾错挂在全局库面板（`current='gv'` → `currentTrack=''` → 绑定无效 `s:`），且保存走 `v:global:spec`（后端不认）；赛道面板无 spec Tab，`currentEditorKey` 的 spec 分支不可达。与 S5-UI-4-0 审计 S1 完全一致。

---

## 2. 实际修改文件和改动说明
| 文件 | 类型 | 改动 |
|---|---|---|
| `web/src/views/StylePromptsView.vue` | 修改（唯一业务文件） | ① 全局库面板删除错挂的「写作规范」Tab；② 赛道面板新增「写作规范」Tab（`name="spec"`，绑定 `buf[skey(currentTrack)]`）；③ 新增前端 `SPEC_PREFIX='s:'` 并让 `skey()` 复用；④ `currentEditorKey` 的 spec 分支由死代码变为可达（逻辑无需改）；⑤ `restoreKey` 对 `s:` 前缀按裸赛道名查 `d.specs`；⑥ `trackDirty` 纳入 `skey(name)`；⑦ 删除赛道确认文案补「写作规范」；⑧ key 约定注释补全 |
| `docs/restructure/S5-UI-4-1-A-IMPLEMENTATION-REPORT.md` | 新增 | 本报告 |
| `docs/DEVLOG.md` | 追加一条 | 本轮进度 |

**未改**：后端任何文件、Schema/Migration/`.env`、`web/src/utils/*`、其他 `.vue`、`package.json`。目标文件在改动前已是 modified 状态（S5-UI-1 遗留的 PageHead/SaveBar 迁移等），本轮在其上叠加最小改动，未覆盖既有工作。

### A · 写作规范 Tab 挂载位置
- 全局库面板（`current==='gv'`）只保留 DIMS 三个变体 Tab（title/structure/length）。
- 赛道面板在「赛道文体」之后插入 `name="spec"` 的「写作规范」Tab，绑定 `buf[skey(currentTrack)]` = `s:{当前赛道}`；dirty 圆点用 `isDirty(skey(currentTrack))`。
- 赛道切换时 `currentTrack` 变化 → 编辑器自动对应新赛道的 `s:` key，不混用（走查证实）。

### B · key 与保存链路
- `SPEC_PREFIX = 's:'`（与后端同源注释），`skey = (track) => SPEC_PREFIX + track`。
- `currentEditorKey` 中 `if (trackTab === 'spec') return skey(n)` 现在是可达真实分支；底部 SaveBar 保存 `currentEditorKey` → `PUT /style-prompts/s:{赛道}`；保存成功 `applySaved` 回灌 saved 快照，失败 `ElMessage.error('保存失败')` 保持 dirty（不显示假成功）。
- 其他 key 规则（global / 赛道文体 / sys / v）一字未改。

### C · 恢复默认
- `restoreKey` 先用 `key.startsWith(SPEC_PREFIX) ? d.specs[key.slice(2)] : undefined` 取裸 key 默认值，再参与原来的 `??` 链；找不到时仍走原「没有出厂默认值」warning，不静默成功。
- 沿用原有 `ElMessageBox.confirm`「用出厂默认值替换当前编辑内容？替换后仍需点保存才写库」确认；恢复只改 buf，不直接写库。
- `trackDirty` 纳入 `skey`，写作规范改动现在正确进 dirty 汇总与导航圆点。

---

## 3. 自动化与构建验证
| 验证 | 命令 | 结果 |
|---|---|---|
| web 类型检查 | `npm run typecheck`（web/，vue-tsc --noEmit） | ✅ exit 0 |
| 浏览器走查 | `node --experimental-strip-types var/tmp/s5ui2c/walk-4-1e.mjs`（自包含，唯一 profile） | ✅ 控制台 0 error |

**未跑 server typecheck / build / 冒烟**：本轮未改任何 server 代码，按「最小必要验证」原则不重复；不连库、不跑 smoke（smoke 涉及隔离库，本轮无后端改动，无必要）。

---

## 4. 浏览器 Mock 实测证据（关键）
复用本地 vite(5200) + 派生 Mock(`mock-41a.mjs`，8788，内存夹具不落库) + headless Chrome CDP。走查脚本与结果位于 `var/tmp/s5ui2c/`（临时目录，不进版本库）。

| 验证点 | 实测结果 | 判定 |
|---|---|---|
| 赛道面板 Tab | 选中「星座」后 Tab = 系统提示词 / 赛道文体 / **写作规范** / 标题变体 / 结构变体 / 篇幅变体 | ✅ A |
| 写作规范内容 | 「星座」显示 `## 段落形态 - 群像切片，一星座一段…`（= `s:星座`），非 `s:` 空 key、非系统提示词 | ✅ A/B |
| dirty 汇总 | 改写作规范后显示 `1 处改动未保存 / s:星座` | ✅ B（key 正确） |
| **保存 key** | `PUT /api/style-prompts/s%3A%E6%98%9F%E5%BA%A7`（URL 解码 = `s:星座`），toast「已保存」 | ✅ **B 核心** |
| 恢复默认 | 改乱后点恢复默认 → 确认框「替换后仍需点保存才写库」→ 内容恢复为出厂规范原文，toast「已填入出厂默认值，记得保存」，**无「没有出厂默认值」误报** | ✅ C |
| 赛道隔离 | 切「育儿」→ 写作规范显示 `## 段落形态 - 允许一句一段…`（育儿自己的），不与星座混用 | ✅ A |
| 全局库 | 全局库面板只剩 3 个变体 Tab（代码确认 spec 已删；该面板无左导航入口，用户实际不可达） | ✅ A |
| 深色 | `html.dark` 下背景/文字/标签/Tab/SaveBar 全部清晰可读，无异常（截图已实看） | ✅ |
| 500px 窄屏 | `docOverflow=false`，6 个 Tab 齐全 | ✅ |
| 控制台 | `errs=[]` | ✅ |

**证据文件**：`var/tmp/s5ui2c/B41E-result.json`（数值结果）、`B41E-01-spec-before.png` / `B41E-02-after-save.png` / `B41E-03-after-restore.png` / `B41E-04-yuer.png` / `B41E-06-dark.png` / `B41E-07-narrow.png`、`walk-4-1e.mjs`；派生夹具 `mock-41a.mjs`。
**Mock 局限如实说明**：走查用内存夹具（含 `s:星座`/`s:育儿` 的默认规范），非真实库数据；但组件状态、key 生成、请求 URL、Tab 归属、响应式与 CSS 均为真实产物行为。真实库写入由后端 `PUT /:key` 既有逻辑承担，本轮未改、未实测真实库。

---

## 5. 未完成项及已知风险
- **未验证（如实）**：真实 MySQL 库下写入 `s:{赛道}` 的端到端（本轮禁止连库）；Mock 内存夹具只验证前端发出的 key 与链路。
- **任务书截断**：「不修改提示词内容或」后文缺失，本轮按 D 边界保守处理（未改提示词文本/生成算法/DB）；若截断部分另有约束，请人工复核。
- **删除赛道确认文案**：顺带补了「写作规范」字样（删除键本就包含 `skey(name)`），属同函数域最小一致性改动，不改变删除行为。
- **S3（P3）未纳入**：删除赛道配置时不检查该赛道是否有未保存改动（审计报告 E-3），本轮未实施——但 `trackDirty` 纳入 `skey` 后，写作规范改动已正确显示在导航 dirty 圆点与顶部汇总，用户可见。
- **Mock 多轮调试**：期间派生了多个走查脚本（walk-4-1a~e）与 profile；最终以 `walk-4-1e.mjs` 结果为准，前序脚本为定位选择器问题，非交付物。

---

## 6. Git HEAD 和工作区保护情况
- **HEAD**：`b2fbad3f53c5b8dd28f22bccd1b51a62756122cf`，分支 `feature/open-source-readiness`（与本轮开始前一致）。
- **工作区**：本轮前 62 项未提交改动全部保持原样；本轮在 `StylePromptsView.vue` 既有 modified 上叠加最小改动，未覆盖/回滚/清理。
- **Git 写操作**：无 commit/push/reset/checkout/clean。
- **临时产物**：走查脚本/截图/JSON 与派生 Mock 在 `var/tmp/s5ui2c/`（不进版本库）；查看用的系统临时截图副本已清理；vite(5200)/mock(8788)/Chrome(9381 等) 已停止、端口全部释放；未改 `role.txt`/`mode.txt`。

---

## 7. 是否建议关闭 S5-UI-4-1-A
**建议关闭。** 依据：① S1（P1）、S2（P2）均已修复；② A/B/C 三项要求逐条经真实浏览器证据验证（含保存 key 的 URL 实测与恢复默认前后值对比）；③ typecheck 通过、控制台 0 error；④ 改动集中在单文件、不动后端/DB/生成算法；⑤ 边界清晰、可回滚。
**遗留**：审计报告 E-3（删除赛道未保存提示，P3）与多篇 P3 不在本轮范围；下一阶段若要处理，单独授权。**本轮到此停止，等待人工验收，不自动进入 S5-UI-4-1-B，不提交 Git。**

---

# 附：真实持久化补充验收（2026-11-17 20:12）

> 性质：**只读业务代码 + 正式业务库单条记录写验证**，验证 S5-UI-4-1-A 修复能否通过真实后端/真实库完成读写与恢复。**未修改任何业务代码**，未改 Schema/Migration/`.env`，未调 LLM/微信，未推送，未 Git 写操作。本节为追加章节，前文结论不变。

## A0. 执行前核对
| 项 | 实测 |
|---|---|
| Git HEAD / 分支 | `b2fbad3f53c5b8dd28f22bccd1b51a62756122cf` / `feature/open-source-readiness`，与实施轮一致 |
| 工作区 | 63 项未提交改动保持原样，未覆盖/回滚/清理 |
| `.env` 默认目标 | `DATABASE_URL` 指向 `wechat_pipeline_smoke`（隔离库）；**不依赖默认值** |
| 本次验证目标 | 正式业务库 `wechat_pipeline`（拼串替换库名 + 硬身份核验，参照既有 `s5-4-integration.ts` 纪律） |
| 库身份（实测） | `DATABASE()=wechat_pipeline`、`CURRENT_USER()=wpc_app@127.0.0.1`、`VERSION()=8.0.30`、`@@port=3306` |
| 目标记录（实测） | `s:星座` 700 字 / SHA `14179e7d…e7e3`；`s:育儿` 631 字 / SHA `8bd1a6a6…5ed06` |
| 可隔离测试 key | 无现成测试 key（探测 `s:__persist_probe__` 等均不存在）；现有 6 个 `s:` key 均为真实赛道 |
| 隔离与恢复方案 | ① 精确备份到 `server/var/tmp/style-persist-backup.json`（不进版本库）；② 恢复源=备份文件 prompt 原文；③ `try/finally` 强制恢复；④ 恢复用 `update where key` 精确主键，无模糊条件；⑤ 预检不一致即中止写操作 |

**安全结论**：满足任务书「先精确读取并备份、记录原始 key/内容/元数据、验证前确认可精确恢复」的前提，方才执行写验证。

## A1. 验证过程与结果（七项要求逐条对应）
脚本：`server/var/tmp/verify-style-persist.ts`（一次性验收脚本，不进版本库，不属业务代码）。

| 步骤 | 要求 | 实测证据 | 结果 |
|---|---|---|---|
| STEP0 | 身份核验 | `wechat_pipeline` / `wpc_app@127.0.0.1` / 8.0.30 / 3306 | ✅ |
| STEP1 | 真实读取 `s:星座` | SHA `14179e7d…e7e3`、700 字，`matchBackup=true` | ✅ |
| 预检 | 当前内容与备份一致 | 一致，方继续写（避免覆盖他人改动） | ✅ |
| STEP2 | 保存唯一临时内容 | marker=`PERSIST-PROBE-20261117121038`，64 字 | ✅ |
| STEP3 | 重新请求确认持久化 | `persisted=true`，重读 SHA `f6d7b627…28e`、64 字 = 临时内容 | ✅ |
| STEP4 | 另一赛道未被波及（写后） | `s:育儿` SHA `8bd1a6a6…5ed06`，`unchanged=true` | ✅ |
| STEP5 | 恢复原始内容 | `recovered=true`，SHA `14179e7d…e7e3`、700 字，与备份逐字一致 | ✅ |
| STEP6 | 再次读取确认 + 另一赛道不变 | `s:星座` SHA 与备份全等；`s:育儿` SHA 仍 `8bd1a6a6…5ed06` | ✅ |
| STEP7 | 恢复默认接口返回正确赛道规范 | `defaultFor('s:星座')` → `kind=spec`、700 字、含「一个星座一个自然段」，`correctTrack=true` | ✅ |
| RESULT | 综合 | `allPass=true` | ✅ |

## A2. 原始数据恢复证据
- **备份文件**：`server/var/tmp/style-persist-backup.json`（SHA-256 `6b509253…569bc9`），含 `s:星座`/`s:育儿` 的 key、kind、prompt 原文、prompt SHA-256、长度、原始 updatedAt。
- **恢复源**：验收脚本从上述备份文件读取 prompt 原文写回，非硬编码。
- **独立最终复核**（验收进程退出后重新连库只读）：
  - `s:星座` SHA `14179e7d486bdbcfe89e2a944af4cb3d84a78423c62d32002c875bee7ca3e7e3`、700 字、无 `PERSIST-PROBE` 残留；
  - `s:育儿` SHA `8bd1a6a6af11e8db6b3e05d3c425bc56244ae4c5d8578d4f71ba35df8155ed06`、631 字；
  - 全库 StylePrompt 仍 44 条、`s:` key 仍 6 个，无增删。
- **诚实声明（唯一副作用）**：`s:星座` 的 `updatedAt` 由 `2026-11-15T13:39:16.145Z` 变为 `2026-11-17T12:10:38.313Z`（真实 `update` 的必然结果）；**prompt 内容逐字完全未变**（SHA 证明）。`s:育儿` 的 updatedAt 未变。

## A3. 结论
**通过。** 写入→重读→恢复→复核的完整闭环在正式业务库 `wechat_pipeline` 上验证成功，`s:星座` 内容已精确恢复且无残留，另一赛道未受影响，恢复默认接口返回正确赛道规范。S5-UI-4-1-A 的写作规范修复在真实持久化层得到确认。
**未做**：未改任何业务代码/Schema/Migration/`.env`；未调用 LLM/微信；未推送；未 Git 写操作。临时脚本与备份位于 `server/var/tmp/`（不进版本库）。
