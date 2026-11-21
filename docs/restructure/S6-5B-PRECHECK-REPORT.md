# S6-5B-PRECHECK · 正式赛道初始化只读准备审计

- **日期**：2026-11-19
- **性质**：**纯只读准备审计**。未创建赛道、未执行任何写库/DDL/Migration、未调用创建 API、未修改代码/Schema/提示词/配置、未改「啊啊」及现有 45 条 StylePrompt、未执行外部调用、未做 Git 写操作。
- **Git 基线**：分支 `feature/open-source-readiness`，HEAD `3b966d1544e1fb9337f85e4472dcce4563e0fbf6`（审计前后未变）。
- **权威依据**：`RESTRUCTURE-2.0-CONVERGED-PLAN.md` §五/§八、`00-FINAL-EXECUTION-CHARTER.md` §二（写库须隔离、禁止未经批准对真实库操作）、`docs/DEVLOG.md`（进度真源）、`server/prisma/schema.prisma`、实际代码。
- **目标**：为正式库 `wechat_pipeline` 补建 6 个正式赛道（教育 / 星座 / 激励 / 科技 / 职场 / 育儿）做可执行方案准备；本轮不创建。

---

## 1. 赛道创建入口及完整调用链

| 层 | 位置 | 关键事实 |
|---|---|---|
| 前端页面 | `web/src/views/TracksView.vue` | `openCreate()`（:91）打开弹窗，默认 `quotaPerDay=2`；提交调 `createTrack({name, slug?, quotaPerDay})`（:107）。弹窗文案提示"新建赛道角度池为空，需先扩充选题"。 |
| 前端 API | `web/src/api/index.ts:107` | `createTrack(payload: TrackPayload) → POST /api/tracks`。`TrackPayload`（types.ts:248）`{name, slug?, quotaPerDay?, enabled?}`。 |
| 后端路由 | `server/src/api/routes/tracks.ts:118-157` | `POST /`，`requirePermission('system:manage')`。Zod `createSchema`；`slugify()` + `uniqueSlug()`；`prisma.track.create()`；随后 `await ensureSeeded(t.id)`；201 返回含 message。 |
| 后端副作用 | `server/src/services/pipeline.ts:201-216` | `ensureSeeded` 建两条 `TrackPipeline`：`article`（quota 沿用赛道、enabled=true）+ `comic`（quota 0、enabled=false）。 |

**其它 Track 创建入口**：`server/cli/migrate.ts:396`（本机数据迁移 CLI，非运行时）、多个 `scripts/smoke-*.ts`（隔离冒烟，各自带 STAMP/冒烟前缀）。**生产运行时唯一创建入口 = POST /api/tracks**。无定时/后台自动创建 Track 的逻辑。

## 2. Track 模型字段与约束（`schema.prisma:140-163`）

| 字段 | 类型 | 约束 | 创建时取值 |
|---|---|---|---|
| `id` | Int | `@id @default(autoincrement())` | 自动生成 |
| `name` | varchar(32) | **无 @unique** | 请求 name（Zod: trim, min1, max32） |
| `slug` | varchar(64) | **`@unique`** | 请求 slug 或 `slugify(name)`，经 `uniqueSlug()` 保唯一 |
| `quotaPerDay` | Int | `@default(2)` | 请求值或 2（Zod: int 0..20） |
| `enabled` | Boolean | `@default(true)` | 请求值或 true |
| `createdAt`/`updatedAt` | DateTime | `now()` / `@updatedAt` | 自动 |

关系：`accounts` / `angles` / `articles` / `pipelines`（后两者当前均 0 行，见 §7）。`quotaPerDay` 为兼容字段，配额真源是 `TrackPipeline.quotaPerDay`（`ensureSeeded` 会同步播种）。

## 3. 六个赛道建议字段（据代码推算，非编造）

| name | slug（slugify 结果） | enabled | quotaPerDay | 说明 |
|---|---|---|---|---|
| 教育 | 教育 | true（默认） | 2（默认） | 中文名被 slugify 保留，见下 |
| 星座 | 星座 | true | 2 | 同上 |
| 激励 | 激励 | true | 2 | 同上 |
| 科技 | 科技 | true | 2 | 同上 |
| 职场 | 职场 | true | 2 | 同上 |
| 育儿 | 育儿 | true | 2 | 同上 |

`slugify()` 实现：`.toLowerCase().replace(/[^a-z0-9一-龥]+/g,'-').replace(/^-+|-+$/g,'')`，中文在 `一-龥` 区间被保留，故六个纯中文名的 slug 就是其本身（已用 Node 静态复刻验证）。不显式传 slug 即可自动生成；如显式传入也建议用同名中文 slug 以匹配命名惯例。**quotaPerDay=2 / enabled=true 是代码默认值，可根据业务需要调整，但审计建议先用默认以与原 SQLite 历史行为一致。**

## 4. slug 唯一性核验结果

- 数据库约束：`slug @unique`；`uniqueSlug()` 冲突时附加 `-2/-3…`（root 截断 60 字符，最多试 200 次）。
- 正式库只读核验（§7）：六候选 slug 在 Track 中**均不存在、零冲突**（Track 本身 0 行）。
- `name` 不唯一：六个中文名当前也不存在，无重复创建保护——但本轮为一次性初始化，创建前应先查重（见 §9）。
- 长度限制：name ≤32 字符、slug ≤64 字符，六个名称都远低于上限。

## 5. 创建后的 StylePrompt 关联行为（原则：只建 Track，不改 StylePrompt）

- **数量口径（精确，勿再用含糊的"44 条"）**：StylePrompt 总数 **45 条**，其中：
  - 六个正式赛道相关配置 **39 条** = 裸名 6 + `sys:` 6 + `s:` 6 + `r:` 3 + `v:` 18；
  - 全局 / 兜底 / 「啊啊」相关配置 **6 条** = `global` 1 + `sys:default` 1 + `v:global:{dim}` 3 + `啊啊` 1。
  - **`啊啊` 记录必须保留，不修改、不删除**（空 prompt 的孤儿 track 配置，无业务引用）。
- **自动匹配**：`writer.loadStyleForTrack(track.name)`（writer.ts:539）→ `style-prompts.ts:1981` 的 `getStylePrompt(trackName)` / `loadTrackSpec` / `loadTrackRule` / `loadSystemPrompt`，全部按 **Track.name 字符串**软关联，**不查 Track 表存在性**。创建同名 Track 后，六个赛道的 39 条配置立即按名字命中，写稿读取路径无需任何改动。
- **孤儿识别自动消解**：前端 `alignOf(name)`（StylePromptsView.vue:218）从 `tracks`（`listTracks` 结果）判定 `missing`；创建同名 Track 后自动从 `!` 变为正常，历史配置不需迁移。
- **S6-5A 已验收（S6-5B 前置条件）**：S6-5A 最终判定 **PASS WITH NOTES**。后端新建赛道级 StylePrompt 时校验 Track 是否存在（不存在拒绝），前端新建文风配置只能选择真实 Track；历史孤儿 StylePrompt 仍可查看和编辑，不要求重新录入历史提示词；未引入 Schema / Migration 变更。两项非阻塞 NOTE 如实保留：① `requireTrack` 边界当前无调用方使用，隔离靠库名识别；② 无连库端到端测试覆盖 upsert 真实新增/更新行为。**S6-5A 验收通过是 S6-5B 正式演练的前置条件，现已满足。**
- **无自动覆盖/删除**：创建 Track 的逻辑（tracks.ts + ensureSeeded）**完全不触碰 StylePrompt**；种子/迁移逻辑只在 `ensureStylePromptsSeeded` 首次读取时按 key 补齐缺失项，不会覆盖已存在 prompt。
- **结论**：**不需要修改 StylePrompt 数据、不需要改 writer 或提示词加载逻辑**。「啊啊」及 45 条配置原样保留。

## 6. 对写作、选题、排产、Dashboard 的影响

| 面 | 代码层影响 | 当前数据实际影响 |
|---|---|---|
| 选题池 / Angle | 新赛道提供 `trackId` 归属；`ensureSeeded` 只建产线不建选题 | Angle=0，创建后仍为空；需手动「扩充选题」才有题 |
| 文章 / 写作 | `writer` 按 Track.name 读 StylePrompt，现可命中 6 套历史配置；`Article.trackId` 可关联 | Article=0，无存量文章需回填 |
| Pipeline / 排产 | `ensureSeeded` 为每赛道建 article(quota2,on)+comic(0,off) 两行；排产读 `TrackPipeline` | TrackPipeline=0，创建后新增 12 行（6×2） |
| Dashboard 待办 | `byTrack` 等按 `trackId` groupBy + join Track.name 展示；新建赛道进入筛选维度 | 相关表 0 行，待办空态不变；仅"赛道"下拉多出 6 项 |
| 启用状态/配额 | `enabled=true`、`quotaPerDay=2`（article 产线同步 2） | 无账号绑定，不实际出稿 |
| 外键关联 | Track 被 Account/Angle/Article/TrackPipeline 引用；Schema 确定：删 Track 时 TrackPipeline `Cascade` 删、Angle `Cascade` 删、Article.trackId `SetNull`；DELETE API 在 Account 有账号时拒绝 | 四表当前 0 行，**实际影响为零，但级联规则客观存在**，回滚时仍须按 §9.4 复查关联数据 |

## 7. 数据库只读核验结果（正式库，仅 SELECT/SHOW/information_schema）

连接身份（实测）：`SELECT DATABASE()=wechat_pipeline`、`CURRENT_USER()=wpc_app@127.0.0.1`。未连接 Shadow / Smoke，未打印密码或完整 URL。

| 核验项 | 结果 |
|---|---|
| Track 当前记录 | 0 行 |
| 六名称是否已存在 | 均无（空结果） |
| 六候选 slug 是否冲突 | 均无（空结果） |
| TrackPipeline / Angle / Article / Account 行数 | 全部 0 |
| StylePrompt 分类 | global 1 / system 7 / track 7 / variant 21 / spec 6 / rule 3 = **45** |
| StylePrompt 45 条 | 与 S6-5-PRECHECK 基线一致，未变；含 `key='啊啊'`（prompt 空）未动 |

## 8. 创建时副作用与失败风险

- **附加写入**：每次创建除 Track 行外，`ensureSeeded` 写 2 行 TrackPipeline；6 赛道共预期新增 **6 Track + 12 TrackPipeline**。
- **部分数据风险**：`prisma.track.create()` 与 `ensureSeeded()` **不在同一事务**；若后者失败，会留下"有 Track 无产线"的不完整赛道（代码层回落 `Track.quotaPerDay` 仍可用，界面显示未播种）。当前库为空，失败可安全单条补种。
- **并发/重复**：`name` 无唯一约束；重复调用会建出同名不同 slug 的赛道。创建前须逐一查重（§7 已确认当前无重复）。
- **Response message**：创建成功返回提示"角度池还是空的，请先扩充选题"——属正常提示，非错误。
- **无回滚型自动逻辑**：创建不触发 LLM / 微信 / 推送；无自动扩库、无自动改提示词。

## 9. 推荐实际创建步骤及回滚方案（待授权，本轮未执行）

### 9.1 执行前只读门禁（写库前必须逐项核验，任一不符立即停止）

1. `SELECT DATABASE()` = `wechat_pipeline`（不得是 Shadow / Smoke）。
2. `SELECT CURRENT_USER()` = 预期应用账号 `wpc_app@127.0.0.1`。
3. Track 当前数量及现有 ID：预期 0 行、无 ID（如有残留，逐项查明来源）。
4. 六个赛道名称（教育/星座/激励/科技/职场/育儿）与六个候选 slug 均无冲突。
5. StylePrompt **全部 45 条逐条快照比对**：写入前、写入后均查询全部记录，至少记录 `id` / `key` / `kind` / `prompt` 四字段；**以 `id` 为稳定标识逐条比较**，不得只比总数和分类计数。任何记录缺失、新增或任一字段（尤其 `prompt`）变化，立即停止并报告。
6. `key='啊啊'` **单独核验**：`id` 不变、`key` 不变、`kind` 不变、`prompt` 仍为空串；任一不符立即停止并报告。
7. admin 账号可用（当前 `User` 表 role='admin' 有 1 个）。
8. S6-5A 三文件仍是预期修改内容（HEAD `2458d11` 工作区状态，未被覆盖或提交）。

### 9.2 备份 / 写前快照（授权边界）

演练前**建议**做一次轻量备份（如 `mysqldump`），或至少形成可核验的写前只读快照。**备份 / 快照落盘不是本报告自动授权的操作**，须用户单独授权；本报告不执行、不假设已备份。

写前 / 写后快照必须包含（至少）：
- **StylePrompt 全部 45 条**：逐条记录 `id` / `key` / `kind` / `prompt`（完整 prompt 内容，非仅长度或计数），以 `id` 为稳定标识逐条比对；执行时可将快照保存为本轮审计产物（如只读查询结果文件），但不得修改任何 StylePrompt 记录。
- **`key='啊啊'`**：单独记录 `id`/`key`/`kind`/`prompt`（应为空），写后逐字段比对。
- **Track ID 集合**：本轮写入前预期为空、写入后为新建的 6 个 ID（供回滚精确识别）。

本轮（报告修订）只改文档，**不实际连接数据库、不生成快照**；快照在正式演练授权后由执行步骤产生。

### 9.3 非幂等接口保护（强制门禁）

`POST /api/tracks` **不具备幂等性**：无 name 查重，`name` 无唯一约束，重复请求会建出同名不同 slug 的赛道。因此必须执行以下强制步骤：

1. **写入前**只读检查六个名称和 slug（见 9.1 第 3/4 项），确认均不存在。
2. **每次只创建一个 Track**，禁止批量并发/循环无脑提交。
3. 记录接口返回的 Track **ID、名称、slug**（201 响应含这些字段）。
4. 每创建一个，**立即**用 `GET /api/tracks` 或响应体核对创建结果（名称/slug/quota 符合预期）。
5. 发现重复、异常或返回不完整（如缺 id/slug），**立即停止**后续创建，转入回滚评估。
6. **禁止通过重复请求盲目重试**——重试前必须先只读核对该赛道是否已创建成功。

**推荐路径（用既有 API，不写 SQL、不改代码）**：
- admin 登录取得会话（POST /api/auth/login，凭据由用户提供，不进报告/聊天）。
- 逐个 `POST /api/tracks`，请求体 `{"name":"教育","quotaPerDay":2,"enabled":true}`（slug 省略自动生成；六个名称依 §3）。顺序：教育 → 星座 → 激励 → 科技 → 职场 → 育儿。
- 每次按 9.3 核对并记录 id；全部完成后核对 Track=6、TrackPipeline=12（每赛道 article+comic 各 1）。
- 写后再做一次 StylePrompt **全部 45 条逐条快照**（id/key/kind/prompt），与写前快照按 id 逐条比对，确认无任何字段变化、「啊啊」prompt 仍为空（见 §9.1 第 5/6 项）。

**不建议**：直接用 SQL INSERT（会绕过 `ensureSeeded` 与 Zod 校验，产生未播种赛道）。

### 9.4 回滚方案（精确、只针对本轮创建数据）

**本轮可能创建的数据**：6 个 Track + 每赛道 2 个 TrackPipeline（`ensureSeeded` 自动生成，共 12 个）。不创建 Angle / Article / Account，不改任何 StylePrompt。

**精确识别**：仅以 9.3 记录的 **6 个新建 Track ID** 为回滚依据；写前 Track=0，故这 6 个 ID 即为本轮全部产物。TrackPipeline 由其 trackId 外键关联，随 Track 删除而处理，不单独按名称识别。

**回滚前关联数据复查（强制门禁，逐个 Track ID 只读执行）**：不得因为 Track ID 属于本轮创建，就假设删除不会影响其他数据。删除前对 9.3 记录的**每个** Track ID 只读检查：
1. 该 Track 确实属于本轮创建（ID 在记录清单内、name 为六个目标赛道之一、创建时间符合本轮）；
2. 其 `TrackPipeline` 恰好是预期的两条（`article` + `comic`），无多余产线；
3. `Account` 无关联（预期 0；若有则 DELETE API 会拒绝，且说明数据异常）；
4. `Angle` 无关联（预期 0；若有，删除会被 Cascade 连带清除）；
5. `Article` 无关联（预期 0；若有，其 trackId 会被置空）。

只有五项全部符合预期，才允许进入该 ID 的回滚删除；出现任何非预期关联数据（多余产线、账号、选题或文章），**立即停止回滚，等待用户决定**，不得继续执行。

**删除 Track 的影响（确定性，依 Schema 外键与 `services/track-delete.ts:23-37`）**：
- `TrackPipeline`：Schema `onDelete: Cascade`（schema.prisma:178）——删除 Track 时**级联删除**其全部产线；
- `Angle`：Schema `onDelete: Cascade`（:298）——删除 Track 时**级联删除**其关联选题；
- `Article.trackId`：Schema `onDelete: SetNull`（:377）——删除 Track 时**置空为未归属**（文章内容不删）；
- `Account`：`DELETE /api/tracks/:id` 依 `track-delete.ts` 规则，账号数 >0 时**拒绝删除**（当前 Account=0，满足）；
- `StylePrompt`：**无外键关系**，删除 Track **不影响**任何 StylePrompt（45 条与「啊啊」不受级联）。

当前 Angle / Article / Account / TrackPipeline 均为 0 行，故实际级联损失为零——**但级联规则客观存在，不能因当前空表就认为无风险**；回滚前必须按下方门禁逐项复查关联数据。

**回滚步骤**：仅对上述记录的 ID 逐个 `DELETE /api/tracks/:id`（admin / system:manage 权限），每删一个核对；全部删除后核对 Track 回到 0、TrackPipeline 回到 0，并将 StylePrompt **全部 45 条逐条快照**与写前基线按 id 比对（含「啊啊」四字段不变、prompt 仍为空）。若部分成功，优先删除已建 ID 回到基线，或向前补建缺失项。

**严格禁止**：按名称批量删除、全表清理、重置数据库、模糊条件删除、重置 StylePrompt。回滚本身也须用户另行授权。

## 10. 是否需要修改代码

**不需要。** 现有创建 API 完整支持六个赛道的创建（name/slug/quota/enabled 均可满足），`slugify` 对中文名生成合法唯一 slug，StylePrompt 软关联自动生效，无需改 Schema、API、writer、StylePrompt 或任何提示词。若业务希望六个赛道使用非默认 quota（非 2），仅需在创建请求里传 `quotaPerDay`，仍不需改代码。

---

## 11. 授权边界（本轮均未执行，须用户另行授权）

以下操作**均不在本报告或此前授权范围内，必须等待用户明确授权**方可执行：
- 连接正式业务库 `wechat_pipeline` 进行演练登录；
- 创建 6 个 Track；
- 创建接口自动生成的 12 个 TrackPipeline（随 Track 创建附带）；
- 进行写后验证（含 API 调用与只读查询）；
- 执行任何回滚（删除本轮创建的 Track / TrackPipeline）；
- 创建数据库备份或写前快照落盘。

本报告为只读准备审计，以上操作一件未做。

---

## 最终判定：**READY WITH CONDITIONS（可进入实际创建授权）**

六个赛道创建路径清晰、字段可用默认值、slug 无冲突、正式库为空壳无数据风险、StylePrompt 无需改动、无需修改代码。**S6-5A 已验收（PASS WITH NOTES），前置条件满足。** 执行前必须严格通过 §9.1 只读门禁，遵守 §9.3 非幂等保护与 §9.4 精确回滚；创建及回滚属对真实业务库的写操作，按章程 §二.7/8 与收敛计划隔离铁律，**必须在用户明确授权后**方可执行；本轮仅完成只读准备与报告修订。
