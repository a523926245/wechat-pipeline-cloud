# wechat-pipeline-cloud · 公众号自动产销系统（云端版）

把现有 Windows 本机流水线搬上云服务器，做成 Web 管理系统：数据入 MySQL、LLM 模型可配置、
公众号账号可配置、支持在线改稿与手动触发创作推送。

## 新会话接手（先看这里）

本项目的对话应在 **WorkBuddy 空间**下进行：新建任务 → 选择工作空间 → 指向本目录。
换会话后旧对话记忆读不到，上下文靠以下两个文件承载，**开工前先读它们**：

1. `README.md`（本文件）—— 定位、硬约束、技术栈、目录、命令、进度
2. `docs/DEVLOG.md` —— 开发日志，按日期倒序记录了做过什么、下一步、阻塞项

新对话建议开场白：
> 读一下 `README.md` 和 `docs/DEVLOG.md`，然后从当前进度继续（阶段 0–5 与前端骨架均已完成）。

会话结束时**必须追加一条 DEVLOG 记录**，否则下次换会话会失忆。

## 项目定位与边界

| 项 | 说明 |
|---|---|
| 本机流水线 | `K:/WorkBuddy WorkSpace/wechat-pipeline`（**只读参考，禁止修改**） |
| 本项目 | 独立新建，复制其能力并云化 |
| 当前状态 | 并行期：本机 06:00 自动化**继续运行**，云端另行开发，功能验收后再切换 |
| 部署目标 | 云服务器 `/opt/wechat-pipeline/` |

## 四条硬约束（不可违反）

1. **不动现有目录** —— `wechat-pipeline/` 一行不改、一个文件不删，只作为算法与业务逻辑的参考蓝本
2. **工作空间规范** —— 本项目位于 `K:/WorkBuddy WorkSpace/project/<项目名>/`；今后新项目一律放 `project/` 下
3. **并行期不停机** —— 本机流水线继续跑；云端开发期**默认 dry-run 不真推**，避免两边同时写同一草稿箱
4. **密钥数据库化** —— 微信 AppID/Secret、LLM API Key 全部加密入库，**必须有配置界面**增删改查并测试连通

## 技术栈

**后端** Node 22 + TypeScript + Express 4 + Prisma
**数据库** MySQL 8.0（utf8mb4）；本地开发降级为 SQLite
**前端** Vue3 + TypeScript + Element Plus + Vite + Pinia · wangEditor 5

### 两个选型说明

**为什么不用构建工具**：Node 22 原生支持运行 TypeScript（`--experimental-strip-types`），
源码即运行产物，没有 tsc 编译步骤。代价是**相对 import 必须写 `.ts` 后缀**（Node 不会把
`./a.js` 解析成 `a.ts`，实测会 ERR_MODULE_NOT_FOUND）。类型检查仍由 `npm run typecheck` 把关。

**为什么本地用 SQLite**：本机没有 MySQL，而 Prisma 的 `provider` 不支持环境变量切换。
解法是 `npm run schema:sqlite` 从 `prisma/schema.prisma`（MySQL 真源）自动降级生成
`prisma/schema.sqlite.prisma`，只需维护一份 schema。
注意两者共用同一个 client 生成目录，**切回 MySQL 时必须重新 `npm run prisma:generate`**。

> ⚠️ **本地开发必读（踩坑记录）**：`prisma/schema.prisma` 是 MySQL 真源，`gen-sqlite-schema.mjs`
> 会把 `Json` 字段降级成 `String?`、**所有枚举降级成 `String`**（如 `ModelRole`/`JobType`/`CredStatus`
> 在本地客户端里不再是枚举类型）。因此本地**只能用 `npm run schema:sqlite` 生成的 sqlite schema
> 去 `prisma generate`**；若误跑裸 `npx prisma generate`（默认读 mysql schema），客户端会变成 mysql 版，
> 导致 `Json` 字段写对象报 "Expected String"、枚举类型找不到等一连串错误。本地统一约定：
> **JSON 列永远以字符串存取**（本项目用 `src/db-json.ts` 的 `packJson`/`unpackJson` 统一处理）。

## 安全红线

- **群发永不自动**：`AUTO_PUBLISH = false` 是代码层硬常量，publisher 中不存在 masssend 调用；
  DB 里 `setting.auto_publish` 标记 `readonly=1`，界面只读置灰。`/api/health` 会把它暴露出来便于核对。
- **凭据永不外泄**：AES-256-GCM 加密（iv+authTag+ciphertext），API 只返回掩码，日志脱敏；
  主密钥 `APP_SECRET_KEY` 必须是 32 字节 base64，生产放 `/etc/wechat-pipeline/app.env`，`chmod 600`。

## 目录结构

```
server/
  src/
    index.ts        入口
    app.ts          Express 装配（helmet/cors/json/统一错误处理）
    config.ts       环境变量与路径（禁止硬编码绝对路径）
    constants.ts    安全红线与业务硬指标
    logger.ts       pino，控制台+文件双写
    db.ts           Prisma 单例 + 命名锁（MySQL GET_LOCK，SQLite 降级）
    errors.ts       AppError / WechatApiError / CredentialError
    lib/crypto.ts   加密、掩码、占位符识别、脱敏
    services/       业务逻辑（从本机脚本移植）
      dedup.ts      ← add_angles.py 的观点层去重（已移植）
      parse/        ← push_draft.py 的 Extractor（HTML→结构化 blocks + 强调标记）
      render/       ← push_draft.py 的样式拼装（预览与推送共用的唯一渲染函数）
      planner.ts    ← daily_plan.py 的排产（buildPlan + 角度预留 CAS + 触发建稿）
      model-registry.ts  模型域单一真源：供应商/协议/能力/角色规格（前端 meta 由它下发）
      writer.ts       写作（用「write」角色模型；缺 Key 回退骨架草稿）
      llm.ts          LLM 抽象（按协议分派 chat / 生图 / 真连通测试 / 角色可用性统一判定）
      revise.ts       AI 改写（润色·重写·精简），改写后重解析渲染
      cover.ts        封面生图（自动构造提示词 + 禁止文字硬约束）
      html-sanitize.ts  模型产出 HTML 的清洗与结构校验
      emphasis.ts   ← auto_emphasis.py 的强调自动补全（确定性后处理）
      wechat.ts       微信通道（token 缓存 / 素材 / 草稿增删 / 分级重试）
      accounts.ts   ← check_accounts.py 的凭据校验规则
      publisher.ts    推送：手动与自动调度**共用**的同一套草稿箱推送逻辑
      scheduler.ts    自动调度（每日写稿心跳 + 配额幂等 + 可选推送）
      dashboard.ts    仪表盘聚合（区块级容错降级）
    api/routes/     路由
    cli/            migrate.ts（迁移）· inspect.ts（检视）· scheduler.ts（调度守护）
  prisma/schema.prisma           MySQL 真源（数据字典）
  prisma/schema.sqlite.prisma    自动生成，勿手工编辑
  scripts/gen-sqlite-schema.mjs  schema 降级生成器
reference/python/   本机脚本副本，作为移植与对拍基准（只读）
config/             style_dna.json · topic_seeds.json（保留为文件，不入库）
web/                前端（Vue3 + TS + Vite + Element Plus）
  src/api/          http 封装 + 全部接口映射
  src/views/        仪表盘 · 创作计划 · 文章/改稿 · 账号管理 · 模型配置
  src/utils/        展示层格式化（状态/角色/时间）
deploy/             systemd / Nginx / logrotate + 一键部署脚本（见 deploy/README.md）
var/                日志与本地数据库（不入库）
```

## 常用命令

```bash
cd server
npm run typecheck                 # 类型检查
npm run dev                       # 开发启动（热重载）
npm run schema:sqlite             # 生成 SQLite 版 schema
npm run sqlite:push               # 建/同步本地 SQLite 表
npm run migrate:dry                            # 迁移预检（默认就不写库）
npm run migrate -- --apply                     # 执行迁移
npm run migrate -- --apply --since 2026-10-01  # 只同步该日期之后的文章
npm run migrate -- --apply --reset-checkpoint  # 丢弃断点从头重跑
node --experimental-strip-types src/cli/inspect.ts             # 检视数据库

npm run fix:cover-paths                        # 封面路径修数（默认 dry-run，--apply 写库）
npm run fix:article-idem                       # 文章幂等键改键（默认 dry-run，--apply 写库）

npm run scheduler                              # 调度守护（常驻，默认 60s 心跳）
npm run scheduler:once                         # 只跑一次（配合 cron/systemd Timer）
npm run scheduler:once -- --force              # 忽略开关与到点，立即补跑一次

npm run smoke:models                           # 模型域端到端冒烟（起假上游，跑完自清理）
npm run smoke:cover                            # 封面链路冒烟（假生图 + 假微信上游）
npm run smoke:migrate                          # 迁移链路冒烟（造假源目录 + 假 HOME）
npm run smoke:angles                           # 选题库 CRUD 冒烟
npm run smoke:lint                             # 文风提示词注入 + 成稿体检门禁冒烟（含段落数锚自洽断言）
npm run smoke:p2                               # 产线/并发退避/仪表盘分组冒烟（不真发生图）
npm run seed:pipelines                         # 给存量赛道补播种产线行
npm run demo:write                             # 现场写一篇样稿验文风（落库成草稿）
npm run verify:length -- --n=10                # 真机跑 N 次验篇幅落点（含修补；改锚值后必跑）
npm run model:local                            # 把本地 Key 配成「写作」模型（幂等，见下方警告）
```

> 冒烟脚本 **输出不要接 `| head -N`**（管道截断会让 node 提前退出、清理不执行、留脏数据），
> 且它们共享同一个 SQLite 库，**必须串行跑**。

> ⚠️ **跑 `smoke:models` 之前先看这里**：该脚本要求模型表为空（列表断言会被别的行干扰），
> 所以它历史上直接 `deleteMany({})` 清全表，结果一次冒烟就把浏览器里配好的模型和角色绑定删光了，
> 写稿链路随之下线退回骨架草稿。现在改为两道防线：
> ① 清理只回收「冒烟…」前缀的行（`server/scripts/smoke-utils.ts`）；
> ② 开局发现非冒烟模型就**拒绝跑**，必须显式 `--force` 才清空。
> 真被清了也没关系：`npm run model:local` 会读 `~/.imagegen.env` 里的
> `AGNES_API_KEY` / `MODELSCOPE_API_TOKEN` **一键恢复两个模型及其角色绑定**（写作 + 漫画格），并顺带做连通测试。
>
> `smoke:cover` 不清库，但它要占用 `cover` 角色跑用例——现在是「临时借用、结束还原」，
> 跑完你的封面模型绑定会原样回来。（早前它直接 `create` 绑定，你自己在页面绑了封面模型就会撞唯一约束。）

## 生图通道（ModelScope Qwen Image）

- **主通道走 gradio REST**：`POST /gradio_api/call/{apiName}` 拿 `event_id` → `GET …/{event_id}` 挂 SSE 到 `complete` → 下载 `data[0]`。
- **备选通道走 MCP Streamable HTTP**（`POST {base}/gradio_api/mcp/`，先 `initialize` 再 `tools/call`）。
  早前「不走 MCP、不认 Bearer（实测 401）」的结论是**测量误差**（缺 token 得 401、缺 `Accept` 头得 406）：
  正确形态必须同时带 `Authorization: Bearer …` 和 `Accept: application/json, text/event-stream`，实测 200。
- **降级语义**：漫画格主通道失败时，同一心跳内自动切备选重试一次（`panels.ts` `generatePanelImage`）；
  备选未绑定/不可用则沿用原错误与 attempt 退避，不引入跨心跳重试环。
  备选模型由 `npm run model:local` 幂等 seed（协议 `modelscope_qwen_image_mcp`，绑 `comic_panel_fallback` 角色）。
  契约由 `npm run smoke:comic-fallback` 守护（假上游 12 断言 + fail-cap 反证）。
- **参数按名字映射，不按下标硬塞**。gradio 的 `data` 数组顺序 = 组件顺序，各版本并不一致：

  | studio | apiName | 差异 |
  |---|---|---|
  | 2-1 | `generate_with_enhance` | 有 `log_dir`、`enable_extend`、`custom_size` |
  | 2-0-pro | `generate_image` | 无 `log_dir`，改名 `prompt_extend` / `edit_custom_size` |

  实现（`llm.ts` 的 `fetchGradioParams` + `buildGradioData`）先 `GET /gradio_api/info` 取真实参数名与顺序再填值，
  **接口名按模型配置**（`paramsJson.gradioApiName`），认不出的参数用接口声明的默认值兜底并打 warn。
  探测失败才退回旧的下标布局（保老配置不炸）。
  ⚠️ 换 studio 版本时先探 `/gradio_api/info`，别照抄别处的参数顺序。
- **`prompt_extend` 必须 false**：提示词扩写会改写内容，导致画面内中文气泡错字。
- **只有「漫画格」角色接受这个协议**。`cover` 的协议白名单里没有它，是有意的：
  该通道忽略 `size`/`ratio`，只认模型级 `genWidth`/`genHeight`，封面比例会失控。
  要用它出封面，得先给通道补「按 ratio 推算像素」，再放开白名单。
- 已知问题：**2-1 studio 当前返回 `event: error`**（连续两次复现，参数与改造前逐项一致，非本次改动所致）；
  2-0-pro 正常。排查前先别把 2-1 配进模型表。

前端（另一个终端，需后端已在 8787 运行；`/api` 由 Vite 代理转发）：

```bash
cd web
npm install
npm run dev          # http://127.0.0.1:5173
npm run typecheck    # vue-tsc 类型检查
npm run build        # 类型检查 + 打包到 web/dist
```

## 关键业务规则（改造时必须保持）

- 每天每账号 2 篇，配额幂等
- 同赛道多账号**共享赛道级角度池**，取一个少一个（角度抢占用 CAS）
- 观点层去重：与现有选题比 + 与历史标题比 + 同主题堆积上限 8
- 标题自动加 `【话】` 前缀（幂等）
- 凭据门禁：APPID 必须 18 位且 `wx` 开头、SECRET ≥20 位、不含"填入/placeholder/todo/xxx/your_"
- 微信错误码：40164（IP 白名单）**不重试**，直接报出口 IP 与操作指引；
  40001/42001 强制刷 token 重试 1 次；网络类指数退避最多 4 次

## 文风规则与成稿体检（改内容前必读）

2026-10-13 改版：小标题从 9-12 收到 **3-4 个**，消灭「总分总」概括句，段落改为**长短混排**。

**规则真源只有两处，改文风改这两处即可，不要在代码里硬编码文案：**

1. `config/style_dna.json` — 赛道调性、`结构主线规范`、`段落形态规范`、`细腻度规范`、`强调标注规范`。
   `server/src/services/writer.ts` 会把它**读出来注入 prompt**。
   ⚠️ 键名以**中文为准**（`调性`/`目标读者`/`禁忌`…），读取侧 `pick()` 同时兼容英文键。
   历史上这里中文键配英文读取，导致赛道调性一行都没进 prompt，已由 `npm run smoke:lint` 顶住。
2. `server/src/services/writer.ts` 的 `SYSTEM_PROMPT` — 只放结构与硬性禁令，
   阈值与 `server/src/services/lint.ts` 共用 `server/src/constants.ts` 的同一份数。

**三条新文风规则：**
- 小标题 3-4 个；每个小标题下 3-5 段。
- 每个小标题下**不要先写一句总结性判断**（「我卡住的地方是个分类问题」这类），
  直接写动作、场景与对话；全篇最多 1 处总结性点题，且只能放在结尾。
- 主体是**复合长段落**（3-5 句、60-140 字，硬性上限 150 字），把动作、语言、心理揉在同一段；
  短段落只留给对话、转折、留白。

**成稿体检（推送门禁）`server/src/services/lint.ts`：**
- `error` 级拦推送：小标题数 3-4、字数 1300-2300、无破折号、无否定框架。
- `warn` 级只提示：复合长段落占比 ≥1/3、一句一段占比 ≤1/2、单段 >150 字、概括句 ≤1 处、强调 8-12 处、红字 2-3 处。
  （比例类只提示不硬拦——靠模型自觉的指标硬拦会把大量只差一点的稿卡死。）
- 只作用于**文章产线**，漫画正文是图片序列，`lint` 返回 null。
- 改稿页预览区展示同一份报告；`GET /api/articles/:id/lint` 可单独取。
- error 项会带 `hits`（命中片段），既给改稿页将来做定位，也给下面的自动修补当证据。
- ⚠️ 存量旧文风草稿（9-12 个小标题）现在**推不出去**，需要先改稿或重新生成。

**写稿链路的两个保命设计（2026-10-13，都是首篇真机样稿翻车后的产物）：**

1. **产出清洗要「能救回来就不判废」** `server/src/services/html-sanitize.ts`。
   模型漏写 `<p>` 标签是常事（首篇样稿就是 `<h2>…</h2>` 后面直接跟裸文本），
   老逻辑整篇判"内容不可用"回退骨架。`normalizeBareParagraphs()` 会把它补成合法结构，
   已没什么标签尽量原样保留。
   ⚠️ 顺序不能反：**先补标签再按末尾 `</p>` 收口**，否则末尾没标签的正文会被整段切掉。
2. **定向修补** `writer.ts` 的 `repairOnce()`：成稿体检不过时，把 error 连同命中片段丢回模型改一遍，
   最多 2 轮，**没有进步立刻停**（用 `distance()` 比 error 数与字数偏离量，别只看 error 数，
   2858 字改到 2789 字 error 数没变但确实在靠近）。实测能把 911 字/2 项不合规救成 1354 字/0 项。
   修不动就留草稿箱给人工，不无限重试。

**模型写中文的两个经验值（改 prompt 前先看这里）：**
- **输出预算要给足**。`WRITE_MAX_TOKENS = 4096`：按新文风算，4 节 ×5 段 ×140 字 ≈ 3600 token，
  2600 会把正文拦腰截断。不知道是被截断还是模型自己停的？看日志里的 `LLM 输出被 max_tokens 截断`
  （`llm.ts` 会记 `finish_reason`）。
  ⚠️ 2026-10-15 更正口径：实测是 **0.737 token/字**（不是 1.3），4096 可容约 5557 字，
  所以**截断从来不是字数上不去的原因**——48 次真机调用 `finish_reason` 全是 `stop`。
- **篇幅目标靠「段落数」，不是靠「字数」**（2026-10-15 改）。模型逐 token 生成，对
  「1800-2200 字」这种**全局**约束只能先验估、边写边无法核；对「写满 17-19 个 `<p>`」这种
  **可数**约束却能自己数。实测同一提示词出过 971 字也出过 3883 字（σ≈400），段数却稳定在 16-20。
  所以提示词里只钉 `PARA_TARGET_MIN/MAX`（`constants.ts`），字数作为结果出现。
  ⚠️ **锚不是越大越好**：锚 17-19 → 均值 1896/σ148；锚 20-22 → 均值 1710/σ566（会诱发模型「凑」）。
  ⚠️ 主提示词与 `repairOnce` 的目标区间必须同源，否则模型取下限、修补反把字数改少。

改完规则后的验稿入口有两个：
- `npm run demo:write`：真调一次模型，打印统计与体检，并落库成草稿（`--dry` 不落库，`--angle=N` 指定选题）。
- `npm run verify:length -- --n=10`：真机跑 N 次走**完整链路**（含定向修补），
  报均值/σ/落在目标区的比例，并在偏低或偏高时直接提示该往哪个方向调锚。**改锚值后必跑它。**

## 移植纪律：对拍测试

现有 Python 脚本里的算法是**已跑通并验证过的资产**（去重算法曾踩过坑：初版 bigram Jaccard
漏掉了所有同义改写）。移植到 TS 后必须用同一份输入跑两边比对输出，不一致就说明移植有偏差。
Python 参考实现在 `reference/python/`，用 managed Python 3.13 运行。

## 参考蓝本映射

| 本机脚本 | 本项目去向 | 状态 |
|---|---|---|
| `add_angles.py` | `services/dedup.ts` | ✅ 已移植 |
| `push_draft.py` 的微信接口（token/素材/草稿） | `services/wechat.ts` | ✅ 已移植（curl→fetch+FormData，token 库内缓存，分级重试） |
| `check_accounts.py` 校验规则 | `services/accounts.ts` | ✅ 已移植 |
| 凭据配置 CRUD + 连通测试 | `api/routes/credentials.ts` | ✅ 新增（密文落库 / 掩码返回 / 连通测试自动启用） |
| `push_draft.py` 的 Extractor | `services/parse/` | ✅ 已移植（轻量分词器，忠实复刻 HTMLParser 行为） |
| `push_draft.py` 的样式拼装 | `services/render/` | ✅ 已移植（预览与推送**共用同一函数** renderArticle） |
| `daily_plan.py` | `services/planner.ts` | ✅ 已移植（buildPlan 排产 + reserveAnglesForAccount 预留 CAS + createDraftsForAccount 触发建稿） |
| `auto_emphasis.py` | `services/emphasis.ts` | ✅ 已移植（确定性后处理，不足下限补加粗、红字不足补红字） |
| LLM 调用（chat/completions） | `services/llm.ts` | ✅ 新增（OpenAI 兼容、Key 解密、超时、错误归一、连通测试、角色解析） |
| 模型配置 CRUD + 连通测试 | `api/routes/models.ts` | ✅ 新增（apiKey 加密落库 / 掩码返回 / /test 连通 / 角色绑定 write·revise·cover·expand_angles） |
| 计划产出 + 手动触发 | `api/routes/plans.ts` | ✅ 新增（GET /api/plan 排产、POST /api/plan/trigger 建稿） |
| 强调补全预览 / 应用 | `api/routes/emphasis.ts` | ✅ 新增（POST /api/emphasize 预览、POST /api/emphasize/articles/:id 应用并重渲染） |
| `set_cover.py` 封面上传 | `wechat.uploadImage` 已接入推送 | ✅ 封面上传已接入；`updateCover` 并入发布流程（阶段 6 完善） |
| `pathutil.py` | 废弃 → `config.ts` | ✅ |

## 迁移期必改的硬断点

1. `push_draft.py:47` / `set_cover.py:88` 硬编码 `C:\WINDOWS\system32\curl.exe` → 改原生 fetch + FormData
2. 凭据从 `~/.wechat_accounts/*.env` 文件读取 → 数据库加密存储（**已完成**）
3. 定时从 WorkBuddy 本地客户端调度 → cron/systemd（阶段 5）
4. 云服务器**固定公网 IP 必须加入每个公众号白名单**（40164）
5. 生图从本机 skill 目录 → 直接调 Agnes HTTP API，Key 入库
6. systemd 显式设 `LANG=C.UTF-8 PYTHONUTF8=1`；落盘文件名全部 ASCII

## 迁移结果（2026-10-10）

赛道 5 · 账号 6 · 角度 349（已用 5）· 文章 5 · 设置 3。
三条断链已修复：`育儿-010` 回写已用、`育儿-019/039` 回填 angle_ref（按标题语义消歧）。
**断言「孤儿已用角度」= 0**。账号凭据只有「戏精漫话」为 ok 且启用，其余 5 个为 placeholder 未启用，
待用户在配置界面填写真实值后自动启用。

## 阶段 2 成果（2026-10-10）

完成「凭据配置与微信通道」，可直接通过 API 管理账号凭据并打通微信草稿箱：

- **凭据配置 CRUD + 连通测试** `api/routes/credentials.ts`
  - `GET /api/credentials` 列表（只返回 `secretMask` 掩码，永不泄露明文）
  - `GET /api/credentials/:id` 单账号详情
  - `PUT /api/credentials/:id` 设置 AppID/Secret：格式校验（18 位 wx 开头、≥20 位、非占位）→
    AES-256-GCM 加密落库 `secretEnc` → 按结果自动置 `ok/placeholder/invalid` 与启用状态
  - `POST /api/credentials/:id/test` 连通测试：真实调一次 token 接口；成功→`ok`+启用，
    40164→报出口 IP 与加白指引，其他错误原样返回；占位/缺失账号短路返回，不浪费外网调用
- **微信通道服务** `services/wechat.ts`（移植 `push_draft.py` 微信接口）
  - `getAccessToken`：优先用 `WechatToken` 库内缓存，临期/强制刷新才重拉并加密回写
  - `uploadImage` / `addDraft` / `updateDraft` / `getDraft`：原生 fetch + FormData（去除 curl 硬编码）
  - 按错误码分级重试：`40164` 不重试；`40001/42001` 强制刷 token 后重试一次；网络/`45009` 等指数退避最多 4 次
  - **安全红线**：只写草稿箱，**不含任何群发/masssend 调用**
- **凭据校验** `services/accounts.ts`（移植 `check_accounts.py` 的 `creds_valid`）

验收：13 项内联冒烟断言全部通过（脱敏、校验拒绝、占位短路、密文落库、真实通道优雅报错）。

## 阶段 3 成果（2026-10-10）

完成「渲染与在线改稿」，文章可从 HTML 解析、套微信内联样式、预览、在线改稿、一键推草稿：

- **HTML 解析** `services/parse/index.ts`（移植 `push_draft.py` 的 Extractor）
  - 提取 h1(标题) / h2(小标题) / p(正文)；行内强调 `<strong>` 普通加粗、`<strong class="key">` 品牌红
  - `<span class="num/seq/order/index">` 序号 span **自动跳过**，避免与自动编号重复
  - HTML 实体解码（`&amp;` `&nbsp;` `&#123;` 等）；用控制字符标记强调，渲染阶段再还原
- **渲染（预览=推送唯一函数）** `services/render/index.ts`
  - `renderArticle` 既供 `/preview` 也供 `/push` 调用，**保证后台看到的就是发出去的**
  - 小标题自动编号（01/02…，蓝色斜体），并剥离手写序号防「11 11」
  - 标题统一加 `【话】` 前缀（幂等）；摘要取首段前 54 字（去强调标记）
  - 内联样式：一级 `#111` 加粗、二级品牌红 `rgb(255,76,65)`、容器 17px 字体
- **文章路由** `api/routes/articles.ts`
  - `POST /api/articles` 创建（解析+渲染+落库，返回统计与警告）
  - `GET /api/articles/:id` 读取原始 `contentHtml` 与渲染产物 `contentWechat`
  - `GET /api/articles/:id/preview` 实时重渲染（与存储产物字节级一致，已断言）
  - `PUT /api/articles/:id/content` 在线改稿（保存并重算渲染与统计，改动后推送态回退为草稿）
  - `POST /api/articles/:id/push` 推送草稿：仅当账号 `credStatus==='ok'` 才执行，且**只写草稿箱**；
    封面仅在文件真实存在时上传；失败（40164 白名单 / 40013 凭据错）优雅返回不崩溃

验收：23 项内联冒烟断言全部通过（解析计数、实体解码、序号跳过、强调内联、手写序号剥离、
摘要截断、**预览=存储字节级一致**、在线改稿同步、未绑账号/占位账号推送均被优雅拒绝）。

## 阶段 4 成果（2026-10-10）

完成「模型配置 + 选题规划 + 手动触发 + 强调补全」，创作链路从「配置模型」到「产出草稿」已闭合成环：

- **LLM 抽象层** `services/llm.ts`
  - `chatComplete`：OpenAI 兼容 chat/completions，超时控制；API Key 从库内 `apiKeyEnc` 解密，明文只留内存、不落盘不进日志
  - `testModel`：连通测试（非对话模型给说明；缺 Key 直接失败；否则发极简请求验证可达性）
  - `resolveModelForRole`：按 `ModelBinding` 解析 write/revise/cover/expand_angles 当前绑定模型
- **模型配置路由** `api/routes/models.ts`
  - `GET/POST/GET /:id/PUT /:id/DELETE /api/models`：apiKey 加密落库 `apiKeyEnc`、列表/详情只返 `apiKeyMask` 掩码
  - `POST /api/models/:id/test`：连通测试；`GET /api/models/bindings` + `PUT /api/models/bindings/:role`：角色绑定
  - `GET /api/models/resolve/:role`：供其它路由复用当前角色模型
- **选题规划** `services/planner.ts`（移植 `daily_plan.py` 的 `buildPlan`）
  - `buildPlan`：只排产 `credStatus==='ok'` 且启用的账号；同赛道共享角度池，按日配额排；输出近作供去重、库存告急/欠账扫描
  - `reserveAnglesForAccount`：事务内 CAS 预留角度（先读未用池再标记 used），避免同日重复选题
  - `createDraftsForAccount`：预留→写作→解析→渲染→落库一条龙；记 `TaskRun`；无写作 Key 回退骨架草稿
- **写作服务** `services/writer.ts`：用「write」绑定模型生成；失败/缺 Key 回退骨架（结构完整、待人工补全），流水线不断
- **计划路由** `api/routes/plans.ts`：`GET /api/plan` 产出今日计划；`POST /api/plan/trigger` 选定账号手动建稿
- **强调自动补全** `services/emphasis.ts`（移植 `auto_emphasis.py`）+ 路由 `api/routes/emphasis.ts`
  - 确定性后处理：仅在加粗不足下限（8-12）时补，按句式特征打分挑候选（优先口诀/祈使/判断标准句），绝不重复加粗已强调句
  - `POST /api/emphasize` 预览；`POST /api/emphasize/articles/:id` 应用后**重新解析渲染**，保证 `contentWechat` 与预览一致

验收：19 项内联冒烟断言全部通过（模型 CRUD 掩码、绑定/解析、连通测试优雅失败、计划产出、触发建稿并消耗角度、
无 Key 回退骨架、强调预览补加粗+红字、应用到文章后 contentWechat 重渲染）。

## 阶段 5 成果（2026-10-10）

完成「自动调度 + 仪表盘」，实现了本机 06:00 定时的云化替代方案：

- **发布服务** `services/publisher.ts`（新增，关键抽取）
  - `pushArticleToDraft(articleId)`：手动 `/api/articles/:id/push` 与自动调度**共用同一套**推送逻辑，杜绝两条分支行为分叉
  - 严守红线：只到草稿箱（`addDraft`）、无 masssend；账号非 `ok` 不发外网调用；失败把文章置 `failed` 并优雅返回
  - 每次推送记一条 `TaskRun`（jobType=push），供仪表盘展示流水
- **自动调度** `services/scheduler.ts`
  - 配置落在 `Setting`：`scheduler_enabled` / `scheduler_write_time`(HH:mm) / `scheduler_push_enabled`
  - **并行期默认 dry-run 不真推**（`scheduler_push_enabled` 默认 0），符合项目硬约束第 3 条
  - **幂等靠当日配额而非「跑过没」标记**：某账号当日产出 ≥ 赛道 `quotaPerDay` 时直接返回「今日配额已满」且零副作用，
    所以反复心跳天然安全，进程崩溃重启也不会重复出稿
  - `withLock(LOCK_PLAN)` 防并发重入；心跳结果写 `RunLog`，可观测
  - `npm run scheduler` 常驻；`npm run scheduler:once` 供 cron/systemd Timer 单次触发（`--force` 可忽略开关立即补跑）
- **调度路由** `api/routes/scheduler.ts`：`GET /api/scheduler` 状态+配置+上次心跳 · `PUT /config` ·
  `POST /tick[?force=1]` 手动心跳 · `POST /start|/stop`
- **仪表盘** `services/dashboard.ts` + `api/routes/dashboard.ts`
  - 一个 `GET /api/dashboard` 给出：计数（赛道/账号/角度库存率/文章分状态）、今日配额与逐账号余量、
    欠账、跳过原因、模型与四角色绑定覆盖率、健康（DB/主密钥/**AUTO_PUBLISH 恒 false**/调度开关）、
    最近任务流水与运行日志、最近文章、告警汇总
  - **区块级容错**：任一数据源异常只降级该区块并记入 `degraded`，仪表盘永远打得开（不会变 500）

顺带修掉一个全路由通病：`app.ts` 统一错误处理原先只识别 `AppError`，导致 **zod 参数校验失败被当成 500 内部错误**；
现已单独识别 `ZodError` 并返回 400 + `validation_error` + 字段级 issues，所有接口的错误提示都更准确。

验收：21 项内联冒烟断言全部通过（默认关闭+dry-run、非法时间 400、未启用不干活、force 补跑产出草稿、
**二次补跑零产出且报「今日配额已满」**、默认不推送、新文章已渲染、仪表盘字段完整且 `degraded` 为空、
`AUTO_PUBLISH` 暴露为 false）。

## 模型配置重构（2026-10-10）

原设计把「供应商」「协议」「能力」「角色」混在一处：`provider` 字段既当供应商又当调用协议，
能力只有 text/image 两项，角色绑定也不校验匹配性。重构后四个维度各自独立，且**单一真源在后端**：

| 维度 | 含义 | 取值 | 谁在用 |
|---|---|---|---|
| `vendor` 供应商 | 谁提供 | openai / deepseek / qwen / zhipu / moonshot / agnes / custom（可自填） | 仅展示 + 带出默认 Base URL |
| `protocol` 协议 | 怎么调 | openai_chat · openai_images · agnes_image · anthropic_messages(规划中) · openai_video(规划中) | `llm.ts` 按它拼路径并分派 |
| `capability` 能力 | 产出什么 | text / image / video / multimodal（**单选**） | 角色绑定时做匹配校验 |
| `role` 角色 | 哪个环节用 | write / revise / cover / expand_angles | 声明所需能力，反查可用模型 |

- **单一真源** `services/model-registry.ts`：供应商预设、协议规格、能力规格、角色规格（含"谁在调用它"的 `consumer`）。
  新增 `GET /api/models/meta` 把这些下发给前端，**前端不再硬编码任何枚举文案**；
  加供应商/协议/角色只改这一个文件。
- **协议 ↔ 能力交叉校验**：对话协议配图片能力、未实现协议、非法生图尺寸，保存时就 400，不让矛盾组合进库。
- **`services/llm.ts`**：`chatComplete` 按协议拼路径分派；新增 `generateImage`（agnes_image / openai_images，
  支持 `b64_json` 与 `url`，按魔数嗅探真实图片类型）；`testModel` **真发请求**（此前非 openai_compat 直接返回 ok，属假阳性）。
- **统一可用性判定** `tryResolveForRole` / `assertRoleUsable` / `modelAvailability`：
  绑定 → 存在 → 启用 → 能力/协议匹配 → 协议已实现 → Key 可解密，任一环不过都给**可读原因**，
  `writer.ts` / `angles.ts` / `revise.ts` / `cover.ts` 全部走这一条路径，不再各写一套 if。
- **删除了 `isDefault` 字段**（0 处读取的死字段）。

### 顺手补完两个角色的实现（此前只有枚举没有代码）

- **revise 改写**：`services/revise.ts` + `api/routes/revise.ts`。`POST /api/revise/preview` 只返回改写结果不落库，
  `POST /api/revise/articles/:id` 应用后重新 parse → render，保持「预览=推送产物」不变量。
  三种模式：polish 润色 / rewrite 重写 / shorten 精简。
- **cover 封面**：`services/cover.ts`。依据标题/摘要/正文自动构造提示词，并附加**硬约束**
  「画面禁止出现任何文字、字母、数字、符号或水印」（生图模型渲染中文必崩，不能交给用户决定）。
  落盘 `var/content/covers`，写回 `Article.coverPath`，publisher 已有的「有封面就上传」逻辑自动生效。
  新增 `POST /api/articles/:id/cover`，并把 `CONTENT_DIR` 挂到 `/api/content` 静态路由（复用 Vite 的 `/api` 代理）。

### 修掉的 bug

1. **进入模型配置页报错 `请求参数：Expected number, received nan`**——根因不在前端：
   `GET /api/models/:id` 注册在 `GET /api/models/bindings` 之前，`"bindings"` 被当成 id 走
   `z.coerce.number()` 转成 NaN。已把 `/meta`、`/bindings*`、`/resolve/:role` 全部前移，
   并给通配段加 `(\d+)` 约束做第二道保险。
2. **一个模型绑多个角色会丢显示**：`toView` 用 `Map<number, string>` 只存一个角色，
   已改为 `boundRoles: string[]`。
3. **无法真正解绑**：`PUT /bindings/:role` 只接受数字 modelId，现在传 `null` 或
   `DELETE /bindings/:role` 都能解绑。

### 前端对应改动

- 新增 `web/src/utils/format.ts` 的标签表：`setModelLabels(meta)` 由 `App.vue` 启动时注入，
  `roleText/vendorText/protocolText/capabilityText/imageSizes()` 统一读取；拿不到 meta 时用兜底文案，不阻塞渲染。
- 模型配置页：供应商（可筛选+自填，切换自动带出 Base URL 与协议）、协议（未实现的置灰标注"规划中"）、
  能力单选、高级参数折叠（生图=尺寸/宽高比，对话=温度/最大 Token）。
  角色绑定下拉里**不匹配的模型照样列出但禁用，并在标签里注明原因**（"本角色需图像"），
  避免"看起来没这个模型"；绑定状态显示 未绑定/就绪/模型已停用/未填 Key。
- 改稿页：新增「AI 改写」条（润色·重写·精简 + 可选补充要求，预览只改编辑框、应用直接落库重渲染）
  与「生成封面」弹窗（提示词留空则自动构造，可选尺寸/宽高比，生成后显示缩略图）。
- 仪表盘：角色清单改由后端 `roleAvailability` 驱动，不可用时把**原因**直接显示在标签下。

验收：后端 `tsc --noEmit` 通过；前端 `vue-tsc --noEmit` + `vite build` 通过；
`npm run smoke:models`（`scripts/smoke-models.ts`，单进程起 app + 假上游对话/生图接口，跑完自清理）
**37 项断言全部通过**，含 `/bindings` 200 回归、能力不符 400、真发请求的连通测试、封面 200 与解绑后 400、
改写 200 与解绑后 400、明文 Key 零泄漏。

### 前端成果（Vue3 + TS + Vite + Element Plus）

五个页面，全部对接现有后端接口：

| 页面 | 路由 | 能力 |
|---|---|---|
| 仪表盘 | `/` | 统计卡片（今日出稿/就绪账号/角度库存/文章存量）、今日各账号配额进度、系统健康、模型角色绑定、欠账与未排产、任务流水/文章/日志三 Tab |
| 创作计划 | `/plan` | 调度开关+写稿时间+级联推送（保存到 `Setting`）、立即心跳补跑、启停进程内定时器、今日排产表与「立即出稿」、候选角度折叠查看、欠账与告警 |
| 文章 | `/articles` | 列表（状态筛选+分页）、推送草稿箱（二次确认） |
| 在线改稿 | `/articles/:id` | 语义化 HTML 源码编辑 + 快捷工具栏（H2/段落/加粗/品牌红字）、强调补全（预览/应用）、**AI 改写（润色/重写/精简）**、**生成封面**、保存即重渲染、右侧微信预览（即推送产物）、推送草稿箱 |
| 账号管理 | `/accounts` | 列表（只显示掩码）、编辑 AppID/Secret/作者、连通测试（占位账号前端短路提示，不打无效外网调用）；旧路径 `/credentials` 保留 301 式跳转 |
| 模型配置 | `/models` | 供应商+协议+能力三维配置（候选项全部由 `/models/meta` 下发）、高级参数、连通测试（真发请求）、四角色绑定（不匹配项禁用并注明原因，支持解绑） |

**关键设计**：改稿页的「微信预览」直接渲染后端的 `contentWechat`，与 `/push` 走同一个渲染函数，
所以界面所见即真正推送的产物——延续阶段 3 的不变量。

**编辑器选型说明**：正文采用**语义化 HTML 源码编辑**而非富文本编辑器。原因是解析器
（`services/parse/index.ts`）只认 `<h1>/<h2>/<p>` 与 `<strong>` / `<strong class="key">`，
而 wangEditor 等富文本产出的是 `<div>` + 内联样式，会破坏这条契约、导致预览与推送产物不一致。
源码编辑 + 实时预览 + 一键插入标签，是更贴合本流水线语义的方案。

验收：`vue-tsc --noEmit` 与 `vite build` 均通过；同进程启动后端 + Vite dev 实测：
首页 200、经 `/api` 代理可正确取到 health / dashboard / articles / credentials 真实数据。

### UI/UX 规范（改动界面时请遵守）

| 维度 | 约定 |
|---|---|
| 设计令牌 | 颜色/间距/圆角/字号集中在 `web/src/styles.css` 的 `:root` 语义变量里（`--wb-*`），组件内不散落色值 |
| 主色 | 品牌绿 `#0a7c47`（由微信绿压深而来），保证白字对比度 ≥ 4.5:1；同步覆盖 Element Plus 的 `--el-color-primary` 系列 |
| 视觉层级 | 页面只设**一个**主入口（仪表盘＝今日出稿进度环），其余为次要指标；卡片默认扁平，不做悬浮滥用 |
| 响应式 | 断点由内容何时需要重排决定：`<992px` 改稿页切「编辑/预览」单栏；`<900px` 表格隐藏 `col-optional` 次要列；`<1180px` 侧边栏自动收起 |
| 异步状态 | 每个列表必须覆盖 加载 / 空 / 错误+重试 / 成功；错误态统一走 `components/StateError.vue` |
| 表单 | 必填项与字段级错误在输入框下方给出（模型配置页），不只弹全局消息 |
| 键盘与无障碍 | 跳转链接「跳到主要内容」、`nav[aria-label]`、仅图标控件带可访问名称、`:focus-visible` 统一描边、尊重 `prefers-reduced-motion` |
| 防丢失 | 改稿页未保存时：离开路由二次确认 + 关闭标签页拦截；`Ctrl/⌘ + S` 保存 |
| URL 状态 | 文章列表的状态筛选与页码放在 query 里，可分享、可返回、刷新不丢失 |

**构建注意**：本机默认堆内存下 `vite build` 会 OOM，`npm run build` 已内置
`node --max-old-space-size=8192`，不要改回裸 `vite build`。

## 收尾轮成果（2026-10-10）

补齐三块上线前的缺口：封面 media_id 回填、迁移增量同步、部署资产。详细文档见 `deploy/README.md`。

### A. 封面链路（`coverMediaId` 回填 + 相对路径）

| 问题 | 处理 |
|---|---|
| 每次推送都往**永久素材库**传一张新图，撑爆配额 | schema 新增 `Article.coverMediaId` / `coverUploaded`，推送后回填；再推时按 `<accountId>:<相对路径>` 判定不变就复用 |
| `coverPath` 存的是本机**绝对路径**，换机器后 `existsSync` 必 false → **静默**推无封面草稿 | 改存相对路径（`covers/xxx.png`），读取统一走 `services/content-path.ts` 的 `resolveCoverPath`；历史绝对路径按 basename 兜底并打 warn；`npm run fix:cover-paths` 一键洗数据 |
| 封面缺失时看不出来 | `PushResult` 增加 `coverMissing`，推送仍成功但消息里明说「推的是无封面草稿」 |
| 已推送文章换封面后 media_id 失效 | 换封面时清空 `coverMediaId`，`status` 由 `pushed` 回退 `draft` |

顺带：`services/wechat.ts` 的 `API_BASE` 支持 `WECHAT_API_BASE` 注入（冒烟要造假上游）；
删掉 `RenderOptions.thumbMediaId` 死字段（声明了但 `renderArticle` 从不读）。

### B. 迁移增量同步

| 问题 | 处理 |
|---|---|
| **文章幂等键含源数组下标**（`import:date:account:i`），源 history 中间插一条 → 下标全平移 → 重跑**整表重复插入** | `src/cli/migrate-key.ts`：改内容派生 `import2:<date>:<sha1 前 12 位>`，只取不可变事实（日期/赛道/账号/标题/摘要/角度号），同内容多条用 `-g2` 消歧。改键脚本 `npm run fix:article-idem` |
| 没有增量 | `--since YYYY-MM-DD` 只过滤文章；赛道/账号/角度/设置无日期字段且是外键依赖，仍全量 upsert（本身幂等） |
| 中途失败要重头 | 断点存 `Setting(k=migrate_checkpoint)`，按日期分组推进，**该组有失败就不推进**；跑完自动清除；`--reset-checkpoint` 丢弃 |
| 逐条 await，SQLite 下慢且易半途 | 事务外预取建 Map（把 N 次查询压成常数次），事务内只做写入，批量 50（`--batch`）；失败默认跳过汇总并 exit 1，`--fail-fast` 才中断 |
| 用户填了真实 AppID 后重跑会新建一行占位，留孤儿 | Account 先按 `(trackId, name)` 兜底查；**占位→真实可升级，真实值绝不回退** |
| `DEFAULT_SOURCE` 写死 Windows 路径 | 支持 `MIGRATE_SOURCE_DIR` 覆盖 |

### C. 部署资产 `deploy/`

```
deploy/
  README.md              手工部署 11 步 + 上线前置项 + 验收清单 + 排障速查 + RHEL 差异
  install.sh             一键部署（每步打印等价手工命令；支持 --skip-build/--skip-nginx/--skip-systemd）
  app.env.example        环境变量样板（⚠️ systemd 不剥引号，一律不加引号）
  systemd/               wechat-pipeline.service · scheduler.service · scheduler.timer
  nginx/                 wechat-pipeline.conf（含 basic auth 注释样板）
  logrotate/             wechat-pipeline（必须 copytruncate）
```

几个容易踩的点已写进注释：

- **Nginx `proxy_pass` 不能带 URI 尾缀**，否则 `/api/content/covers/xxx.png` 被 rewrite 掉 → 前端能看到缩略图但推送出去没封面
- **`proxy_read_timeout` 必须 > `LLM_TIMEOUT_MS`**（300s），否则生图/写作会被 Nginx 掐成 504
- **systemd 里必须写 node 绝对路径**（systemd 不读 login shell 的 PATH，nvm 装的 node 一定找不到）
- **logrotate 必须 `copytruncate`**：pino 持有 fd 且不响应 SIGHUP，默认的 create 方案会让日志继续写进已改名文件
- **`ProtectSystem=strict`** 下必须 `ReadWritePaths` 放行写日志与内容的目录

验收：后端 `tsc --noEmit` 通过；前端 `vue-tsc --noEmit` + `npm run build` 通过；
三个冒烟全绿——`smoke:models` 37 项、`smoke:cover` 13 项、
`smoke:migrate` 14 项（含「history 头部插入一条后重跑只 +1」这条核心回归）。

## 漫画产线（article / comic 双产线）

赛道下可并行跑多条产线，**配额与开关的最小单位是「赛道 × 产线」**：

| 产线 | 链路 | 角度切片 | 默认 |
| --- | --- | --- | --- |
| `article` | 选题 → 写作 → 改稿 → 封面 → 草稿箱 | `article` + `shared` | 沿用赛道原配额，启用 |
| `comic` | 选题 → 漫画脚本 → 逐格生图 → 金句卡 → 草稿箱 | `comic` + `shared` | 配额 0、停用 |

入口：赛道管理 → 行操作「产线配额」（`GET/PUT /api/tracks/:id/pipelines/:kind`）；
界面上改漫画线配额/开关后立即生效，调度总开关仍是 `scheduler_enabled`，默认 off。

**配额真源是 `TrackPipeline.quotaPerDay`。** `Track.quotaPerDay` 已标 `@deprecated`，
只作为 article 产线的镜像保留（写入一律走 `services/pipeline.ts` 的 `setPipelineQuota` 双写），
业务代码不要再直接读它——读请用 `getPipelineQuota` / `listPipelines`，缺行时 article 才会回落旧字段。

### 生图是慢任务，靠行级状态机而非任务队列

`ComicPanel.status`（pending / success / failed）+ `attempt` 本身就是队列；调度心跳分两阶段：

- **阶段一（排产锁内）**：只写漫画脚本，快；
- **阶段二（独立锁 `LOCK_COMIC_IMAGE`）**：多轮推进生图，用完时间预算就把剩下的格留给下次心跳（幂等，不会漏格）。

并发与退避参数（都有默认值，不配也照常工作）：

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `COMIC_MAX_PANELS_PER_RUN` | 3 | 全局扫描时单轮最多处理几格 |
| `COMIC_PANEL_CONCURRENCY` | 2 | 同一篇内并行生图的格数 |
| `COMIC_RETRY_BASE_DELAY_MS` | 20000 | 退避基数：第 n 次失败等 `base × 2^(n-1)` |
| `COMIC_RETRY_MAX_DELAY_MS` | 300000 | 退避上限 |
| `COMIC_TICK_BUDGET_MS` | 240000 | 单次心跳给阶段二的时间预算 |

单格重画会把 `attempt` 归零，因此**不受退避影响**，点了立刻跑。

### 创作质量对齐本地 skill `quote-comic-illustrator`

漫画线的创作知识、金句卡与质检判据与本地实测 skill 对齐（方案A：TS 原生移植，不引 Python 运行时）：

- **叙事链 6 条**：`config/comic_templates.json` 的 `narrativeChains` 含 `progressive / checklist / contrast / scene / timeline / 示范链`，每条携带链级硬约束（原 5 键字节不变，web 端 `chain` 字段仍按 key 传，≤32 字符）。
- **创意层注入 + 两阶段生成**：脚本 system prompt 注入 6 切入维度 / 11 标题公式 / 金句 5 型 / 两行反转句式 / 末单元三标准；`generateCreativeDirections()` 先出 3 组差异化方向并**自动采纳模型标记的推荐组**（未标记则回落第 1 组并 `logger.warn`），再拆 N 单元。web 端零交互，不暴露「3 选 1」。
- **风格硬锁**：脚本 `styleKey` 恒为模板 `defaultStyle`（`soft_watercolor`），`ScriptOptions.styleKey` 已标 `@deprecated` 且不再影响结果。
- **金句卡奶酪体**：`quoteCard` 版式 68/46/50，字体族 `CheeseFont`——由仓库内打包的 `server/src/services/imaging/assets/cheese-font.ttf` 经 `@font-face` **data URI 内联**提供（不依赖系统安装字体，保 Linux 可部署；`file://` 子资源会被 `setContent` 页面拒绝，故用 data URI）。
- **金句卡版本化**：`QUOTE_CARD_VERSION=2`，产物名 `comics/quote-{seq}-v2.jpg`；改版后旧文件与旧上传态 key 自动失配 → 重渲重传。改字体/版式请同步 +1 该常量。
- **QC 逐字核对**：`qcPanelByModel` 注入该格期望台词，要求逐字比对（错字/多字/漏字/串字/顺序颠倒=不合格）并输出判定类别；不合格仍走既有 attempt 退避重跑，异常时降级放行不阻塞产线。

验证：`npm run typecheck` + 冒烟 `smoke:comic-align`（两阶段/风格锁）、`smoke:comic-qc`（QC 逐字与重跑）、`smoke:quote-card`（奶酪体渲染与版本化）。

## 开发进度

- [x] 阶段 0 骨架：目录结构 + 项目约定
- [x] 阶段 1 后端骨架 + 数据迁移（349 角度 / 5 文章 / 断言为 0）
- [x] 阶段 2 凭据配置与微信通道
- [x] 阶段 3 渲染与在线改稿
- [x] 阶段 4 模型配置 + 选题与手动触发
- [x] 阶段 5 自动调度与仪表盘
- [x] 前端 Vue3 + TS（配置界面 / 在线改稿 / 预览 / 计划面板 / 仪表盘页）
