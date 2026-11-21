# 阶段 0 实施计划 v2（修订版）

**日期**：2026-11-12 | **状态**：已按《阶段 0 实施计划修订指令》修订，并按用户三轮审查落实安全修订（4 项 v2 + 3 必修/4 补充/2 验收 v3，见 `T0-SAFETY-SUPPLEMENT.md` **v3**），**等待最终开工授权**（授权前不动代码）
**依据效力**：00-FINAL-EXECUTION-CHARTER（最高）→ README 决策表 → STAGE0-PLAN-REVISION-DIRECTIVE（本次修订）→ 本文 → 06/07/08/09
**设计主线**：AI Editorial Studio（AI 内容编辑部工作台）——阶段 0 完成后，系统应明显呈现成熟内容生产后台的产品形态，而非拼装式管理后台。

---

## 一、v1 → v2 修订摘要

| 项 | v1 | v2（本版） |
|---|---|---|
| 安全 | 「smoke 按既有惯例运行」 | **T0 前置**：冒烟数据库安全审计（已执行，见§二）+ 隔离运行器 + 环境标识 + 非隔离写阻断 |
| T1 令牌 | 合并双令牌 | 建立**完整视觉语义体系**（8 类语义）；暗色查实际渲染不只查变量 |
| T2/T3 导航 | IA 重排 | 导航定稿 4 组；/angles **兼容层 5 项验证清单**（不许简单复制路由） |
| T4 三态 | 全站机械替换 | **分批接入**：6 组件全建 → 第一批 Dashboard+选题 → 第二批 文章/文风/模型 → 第三批 其余；不为覆盖率强换 |
| T5 披露 | AI 五项披露 | 五项披露 + **AI 生成/AI 修改/AI 审核/人工确认视觉区分体系** |
| T6 原型 | 低保真 | 静态 HTML + **完整操作流程**（选题中心 8 要素）+ 原型数据标注 |
| T7 走查 | 7 场景 | + **视觉验收 7 维度** + 截图矩阵（改造前/后 × 亮/暗 × 1180/768） |
| 视觉基准 | 无 | **T5 并入**：10 项后台视觉语言规范；EP 作组件库、自有设计系统控视觉 |

## 二、执行前检查结果：冒烟测试数据库安全审计（只读，2026-11-12）

**结论先行：三个冒烟脚本默认写入真实开发库 `server/prisma/dev.db`，不满足隔离要求——按修订指令，未经 T0 隔离化改造前不得直接执行。**

| 检查项 | smoke:lint | smoke:style | smoke:angles |
|---|---|---|---|
| 实际脚本 | `scripts/smoke-lint.ts`（633 行） | `scripts/smoke-style-prompts.ts`（198 行） | `scripts/smoke-angles.ts`（264 行） |
| DB 连接 | `src/db.ts` PrismaClient ← `src/config.ts` dotenv ← `server/.env` | 同左 | 同左 |
| 连接地址 | `DATABASE_URL="file:./dev.db"` → 解析到 **`server/prisma/dev.db`（真实开发库）** | 同左 | 同左 |
| create/update/delete | 建 Track `__smoke_lint_*`、OAAccount、3 篇「冒烟-」文章；GET lint + POST push | 幂等播种 StylePrompt（改过不覆盖）；upsert 自建「冒烟赛道」4 key；**Setting 行 VARIANT_CURSOR_KEY 手术式 update（只删自己的 map 键）** | 建 Track `__smoke_angles_*`、3 Angle、1 Article；HTTP CRUD+DELETE（全自建数据） |
| 回收逻辑误删风险 | 低。`finally` 里 track.delete 级联，范围限自建 trackId；smoke-utils 前缀纪律（2026-10-13 事故后）有效 | 低。cleanup 只删自建 key；唯一共享行写入是游标 JSON 删自己的键 | 低。`finally` 按自建 trackId deleteMany |
| 失败残留 | 正常失败走 `finally` 清理；**SIGKILL / `\| head` 截断会残留**自建赛道+文章（脚本头已警告） | 同左，残留=冒烟 key+游标条目 | 同左 |
| 外部副作用 | 无。POST push 被 lint 门禁拦下（断言 reason=lint_failed），在微信调用**之前** | 无 | 无 |

**逐条回答修订指令 §二 七问**：①②③ 见表「实际脚本」；④ = 真实 dev.db（非隔离）；⑤ = 存在 CUD，但均限自建前缀数据（`冒烟`/`__smoke_`），唯共享行写入为 Setting 游标手术式删键；⑥ 误删正式数据风险低（前缀/trackId 范围回收，2026-10-13 全表清空事故已修复）；⑦ 正常失败无残留，SIGKILL/管道截断有自建数据残留。
**补充事实**：dotenv 默认 `config()` 不覆盖已有环境变量（已验证）→ 外层 shell 预设 `DATABASE_URL` 即可把脚本指到隔离副本，无需改业务代码；`server/prisma/dev.db` 现存 8 个手工备份，974KB，含真实模型/账号/文章数据。

### T0 处置（安全前置，本次修订新增的唯一后端改动）
> **机制细节真源 = `T0-SAFETY-SUPPLEMENT.md` v3（2026-11-12 21:45，含 8 问逐项回答 + v1→v2 / v2→v3 差异摘要 + 10 项验收）**；本节只留概要。**T0 铁律：不为尽快进入 UI 而降低安全标准，不留任何绕过路径。**
1. **隔离库 = schema-only 空库（数据最小化）**：`smoke-isolated.ts` 经 `prisma db push --schema schema.sqlite.prisma --skip-generate`（显式 SQLite 专用 Schema）对全新文件建结构、**零行数据**（真实数据零复制）；**schema-only 验证链**：隔离文件确实落盘于隔离路径（`PRAGMA database_list` 连接实测）→ 关键业务表结构存在 → 全部业务表行数=0，任一失败即 exit(1)。`VACUUM INTO`+quick_check 保留为将来数据型快照的唯一合法机制（标准冒烟不用）。启动前打印环境标识（REAL/ISOLATED 路径、原库 SHA-256·大小·mtime、WAL 状态），结束删隔离文件（失败保留并**显式报告**残留）。
2. **失败关闭守卫（零绕过）**：`smoke-db-guard.ts`（仅 node:fs/path/process，不 import db.ts）断言 ①隔离命名 `dev.smoke-*.db` ②≠真实 dev.db（路径归一）③文件存在，任一失败或守卫异常即 `exit(1)`。**不提供 SMOKE_ALLOW_LIVE_DB 之类放行开关**；真库诊断另行设计、单独授权，不属于 T0。
3. **初始化顺序由构造保证**：`package.json` → `node --import scripts/smoke-net-guard.mjs --experimental-strip-types scripts/smoke-run.ts <target>`；网守预载 → 引导入口只载守卫 → 守卫通过后**动态 import** 测试模块 → PrismaClient 此时才加载。子进程 env 白名单（不含 APP_SECRET_KEY，CONTENT_DIR 指隔离临时目录）。
4. **网络隔离（v3：双层诚实表述）**：第 1 层=**已覆盖并验证的 Node 网络入口隔离**——网守分别封装 fetch（undici 底层，与 http.request 互不覆盖）/http/https/net/tls/dgram/WebSocket/dns/child_process/worker_threads，命中即测试失败；仅登记本进程自绑临时端口，**6 条端口规则**（仅数值 loopback 绑定、仅 listen(0)、bind 成功后登记实际端口、出站归一化后精确匹配、close 即撤销、无手工放行——**`SMOKE_NET_ALLOW` 已删除**）；清代理 env。第 2 层=OS 防火墙/沙箱（可选，不假设存在）；**不宣称 OS 级全网络隔离**，报告如实标注；不把假凭据当网络安全措施。
5. 验收 **10 项**（补充说明 §三）：正向隔离通过 / 真实库反向被拒 / env 注入失败即退出 / 网络阻断（Node 层）/ 断言全保留 / 四连隔离通过 / 原库前后 SHA-256 一致 / 副本清理成功或显式报告（含五条退出路径矩阵+SIGKILL 残留恢复文档化）/ **空库证明** / **网络隔离反向测试**。
6. **env 显式白名单**（v3）：子进程只传运行必需变量（PATH、SYSTEMROOT、TEMP/TMP、LANG、注入的 DATABASE_URL、CONTENT_DIR、NODE_ENV 等写死清单），其余一律剥离（APP_SECRET_KEY、*TOKEN/*SECRET/*KEY、代理变量、云凭据）。

## 三、目标
1. 纯前端完成 UI P0（令牌/壳层/导航/组件/原型/走查），以 AI Editorial Studio 为设计主线建立可持续复用的后台视觉语言（T0 安全前置除外）。
2. 零业务 DB/零 API 变更；P1/P2 交互只出原型不上线；不造虚构任务/假数据。
3. 主色 #0a7c47 不改；AUTO_PUBLISH=false 不动；现有功能与历史数据零破坏。

## 四、任务清单（执行顺序按修订指令 §五；每步收尾四连经**隔离库**全绿）

| # | 任务 | 要点（v2） |
|---|---|---|
| T0 | 冒烟隔离化（安全前置） | 见 §二 T0 处置；先做，完成后四连才有资格跑 |
| T1 | 设计令牌盘点与合并 | 先 grep 全组件 token 使用清单 → 按 8 类语义（品牌/背景/文字/边框/状态/交互/布局）建立视觉语义体系并合并双令牌段；**状态色语义化**（成功/警告/错误/信息，不用品牌绿充当一切状态）；主色 #0a7c47 不改；暗色按**实际渲染**逐项过：表格、弹窗、表单禁用态、编辑器、EP 覆盖样式、错误/警告/成功提示 |
| T2 | 壳层与标题去重 | 顶栏=面包屑+全局状态+主题+用户；页内 wb-page-head 管标题；逐页核查补最小 h2；系统状态收抽屉（侧栏留健康点）；角色显隐不动（RBAC 归阶段 2） |
| T3 | 导航重排 + 选题中心入口 | 导航定稿：工作台 ｜ 内容生产（选题中心/创作计划/文章工作台）｜ 内容策略（赛道管理/文风配置/标题前缀）｜ 运营与系统（调度管理/公众号账号/模型配置/用户管理）；`/angles` 挂 TrackAnglesView + 页内赛道切换（现有 API）；**兼容层 5 项验证**：①无 trackId 可展示 ②赛道切换正常 ③数据随赛道走 ④刷新保留状态（URL 参数）⑤旧深链 `/tracks/:id/angles` 不断（TrackAnglesView 强依赖路由参数则先做兼容层）；无后端的入口（质量中心/AI 运行中心/形态契约）不上线 |
| T4 | 六组件建立 + 分批接入 | 组件全建并定义统一 Props/状态语义/使用规范/视觉规范：AppPageHeader / AppStatusBadge / AppEmptyState / AppErrorState（包装 StateError 不推倒）/ AppSaveState（保存四态）/ AppTaskProgress（仅结构与状态展示规范，**禁止虚构任务**）；**第一批接入 Dashboard+选题页**验证设计；第二批文章/文风/模型按需；第三批其余查后统一；不为覆盖率强换 |
| T5 | UI-GUIDE + AI 披露 + 视觉语言规范 | ①AI 操作披露五项（输入/产出/数据影响/可撤销性/资源消耗）；②**AI 生成/AI 修改/AI 审核/人工确认四类视觉区分体系**（徽标+图例规范）；③10 项视觉语言规范：页面布局、标题与说明、卡片与内容容器、表格与列表、按钮层级、弹窗与抽屉、表单布局、状态反馈、亮暗主题、间距与信息密度；④原则：EP 是组件库，**视觉呈现由自有设计系统控制**，避免 EP 默认风格铺满系统 |
| T6 | 三个静态 HTML 原型 | `docs/restructure/prototypes/`：①选题审核中心（**流程完整性 8 要素**：候选状态/赛道筛选/重复风险/质量评分/审核原因/通过·修改·拒绝/批量审核/审核历史）②文章编辑与审核工作区 ③形态契约配置页；独立静态 HTML，不进 web/src、不挂路由、不进生产构建；模拟数据**标注「原型数据」** |
| T7 | 真机走查与截图 | 7 场景 × **视觉验收 7 维度**（页面层级/视觉统一/信息密度/操作效率/状态反馈/暗色对比度/响应式 1180·768）；**截图矩阵**：改造前·改造后 × 亮色·暗色 × 1180px·768px 全留档 `docs/restructure/walkthrough/`；P0 范围内问题当场修，范围外登记 |
| T8 | 测试、文档、阶段报告、回滚检查 | 四连（隔离库）+ typecheck + vite build 真实输出留档；假数据核查（build 产物不含 prototypes、无虚构任务）；CHANGELOG / docs/PROGRESS / 项目记忆回写；阶段报告（修改文件/完成情况/测试结果/与设计差异/遗留问题）；回滚演练检查（分支可整体 revert） |

## 五、受影响文件
| 文件 | 动作 |
|---|---|
| `server/scripts/smoke-isolated.ts` / `smoke-db-guard.ts` / `smoke-net-guard.mjs` / `smoke-run.ts` | **新增**（T0：runner / 守卫 / 网守 / 引导入口） |
| `server/scripts/smoke-lint.ts` / `smoke-style-prompts.ts` / `smoke-angles.ts` | 微改（预计仅 `app.listen(0)` 后端口登记一行；**业务断言零改动**，T0 禁改区） |
| `server/package.json` | 小改：smoke 三命令改走隔离运行器（T0） |
| `.gitignore` | 小改：加 `dev.smoke-*.db` 显式行（防后缀陷阱，T0） |
| `web/src/styles.css` | 修改（T1 视觉语义体系+暗色校对） |
| `web/src/App.vue` | 修改（T2/T3 壳层/导航/抽屉） |
| `web/src/router/index.ts` | 小改（/angles 兼容层+旧路径保留） |
| `web/src/views/TrackAnglesView.vue` | 小改（可选 trackId+页内赛道切换，兼容层） |
| `web/src/components/ui/App{PageHeader,StatusBadge,EmptyState,ErrorState,SaveState,TaskProgress}.vue` | 新增 6 件（T4） |
| `web/src/components/StateError.vue` | 保留，被 AppErrorState 包装 |
| `web/src/views/DashboardView.vue`、`TrackAnglesView.vue` | 第一批组件接入（T4） |
| `web/src/views/*.vue` 其余 | 第二/三批按需浅改（T4，不强换） |
| `web/UI-GUIDE.md` | 修改（T5） |
| `docs/restructure/prototypes/*.html` | 新增 3 件（T6） |
| `docs/restructure/walkthrough/` | 新增走查记录+截图（T7） |
| `CHANGELOG.md`、`docs/PROGRESS.md` | 回写（T8） |
| **不动（T0 禁改区）** | `server/src/**`、`prisma/schema*`、数据库真实数据、生产配置、业务断言与测试覆盖范围、`config/**`、AUTO_PUBLISH、微信/LLM/漫画业务逻辑 |

## 六、数据库变更 / API 变更
- **业务 DB：无。schema：无。** T0 只新增隔离库文件（schema-only 空库，**不含真实数据**，跑完删除；失败保留并显式报告）。
- **API：无。** 全部挂现有接口；前端显隐不作安全边界。

## 七、UI 变更（汇总）
壳层（面包屑/状态徽标/系统状态抽屉）、导航 4 组定稿、选题中心一级入口、视觉语义体系 8 类、统一三态+保存四态+状态徽标（分批接入）、AI 操作披露五项+AI/人工视觉区分、暗色实际渲染达标、响应式 1180/768、**无假数据**。

## 八、测试计划
1. **四连+构建**（T0 后全部走隔离副本）：`npm run typecheck`（两遍 vue-tsc 串行）+ `smoke:lint` + `smoke:style` + `smoke:angles`（串行不接 head）+ `npm run build`；smoke:style 现场计数为准（文档 27/33 为陈旧数）。
2. **T0 验收**：**10 项**全过（补充说明 §三）——正向隔离通过 / 真实库反向被拒（无任何放行开关）/ env 注入失败即退出 / 网络阻断（Node 层）/ 断言全保留 / 四连隔离通过 / 原库前后 SHA-256 一致 / 副本清理成功或显式报告（普通异常·非零退出·超时·SIGINT·SIGTERM 五路径验证；SIGKILL 残留恢复方法文档化）/ **空库证明**（业务表行数=0 + smoke 自建数据创建/查询/清理正常）/ **网络隔离反向测试**（外部 HTTP(S) 阻断、未登记端口阻断、已登记临时端口可达、代理 env 不可绕过、命中即非零退出；Node 层验证，OS 层另行声明）。
3. **/angles 兼容层 5 项**（§四 T3）逐项过。
4. **手工回归**：菜单逐项、旧深链、登录/登出、暗色切换、侧栏折叠、窄屏、文章编辑/推送/漫画分镜原样。
5. **走查**：7 场景 × 7 维度 + 截图矩阵（验收前置）。
6. **假数据核查**：build 产物无 prototypes；AppTaskProgress 无虚构任务；页面无「假状态」。
7. **回滚检查**：分支整体 revert 演练（git 层面）。

## 九、风险与回滚
| 风险 | 处理 |
|---|---|
| 隔离库与真实库结构漂移 | runner 每次使用当前受版本控制的 SQLite Schema（`schema.sqlite.prisma`）创建全新 **schema-only 空库**，不复制真实业务数据；通过 schema 版本、迁移状态与隔离库结构检查（含业务表行数=0）确认测试环境与当前代码结构一致；测试数据由 smoke 自行创建。**Schema 与当前代码版本同源**；真实数据型快照不属于标准 smoke 流程 |
| smoke 守卫改变既有习惯（直跑被拒） | CHANGELOG 登记；**零绕过**（无 override 通道），真库诊断另行设计单独授权；命令名不变 |
| 令牌合并改坏视觉/暗色 | 先盘点后合并；暗色查实际渲染；每任务独立 commit |
| /angles 兼容层破坏旧深链 | 5 项验证清单强制；旧路由保留 |
| 组件接入退化现有交互 | 分批接入+不强换；每批回归对比 |
| 走查依赖浏览器控制能力 | 不可用则请用户按截图矩阵配合回传，记录如实标注 |
| 范围蔓延 | P1/P2 只出原型；发现设计问题先报告再动 |

**回滚**：git 分支 `feature/stage0-ui`，每任务一 commit（T0 单独一簇）；整体 revert 即回滚；零业务数据风险；隔离副本天然丢弃。

## 十、验收标准
现有功能与历史数据不丢 ｜ typecheck+build+四连（隔离库）绿 ｜ 亮暗两态实际渲染达标 ｜ /angles 兼容 5 项过 ｜ 无假数据/虚构任务 ｜ 走查截图矩阵留档 ｜ AI 披露与视觉区分落地 ｜ 阶段报告齐全。
**主观验收线（修订指令 §〇）**：完成后系统应明显更像成熟的 AI 内容编辑部，而非拼装式管理后台。

---
**当前状态：3 项必须修正（§九复制表述清除 / SMOKE_NET_ALLOW 删除 / 网络隔离双层表述）+ 4 项工程要求（schema-only 验证 / 连接路径实测 / env 显式白名单 / 清理矩阵）+ 2 条验收增补（空库证明 / 网络反向测试）已写入本文件与 `T0-SAFETY-SUPPLEMENT.md` v3，最终版本+差异清单已提交，等待你的最终检查与开工授权。授权前不动任何代码。**
