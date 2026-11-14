# 实施前检查报告（第二步产出）

**日期**：2026-11-12 20:30 | **性质**：只读检查（未修改任何代码/配置/数据库）| **检查者说明**：本报告是执行者的自述检查结果；文档交叉审查见 README 决策表。

---

## 一、当前代码与八份文档的差异

**结论：文档的「现状描述」与代码一致，未发现虚构；差异集中在三处（均已处置）。**

| # | 差异 | 处置 |
|---|---|---|
| 1 | 文档大量内容描述的是**目标态**（七表/状态机/Renderer 等），代码中尚不存在——这是设计文档的本义，不是差异错误 | 实施时按 ROADMAP-V2 逐阶段落地，禁止把文档目标当已存在能力 |
| 2 | 用户审查修订导致的**文档间旧表述冲突**（TrackContract 1:1 vs N:1、reflow 默认开、去重降级语义） | 本轮已按拍板修正 02/04/06/07 四处；冲突以 00 总纲+README 决策表为准 |
| 3 | 陈旧数字：`smoke:style` 实为 33 项（DEVLOG 2026-11-12 深夜），部分文档写 27 项；`smoke:lint` 71 项属实 | 实施各阶段以**当场运行结果**为准，不引用文档旧计数 |
| 4 | V1 文档（`docs/AUDIT-REPORT.md`、`docs/RESTRUCTURE-CHECKLIST.md`）含已被推翻的设计（TopicCandidate 表、阶段编排） | README 已标「历史文档，保留不删，被 restructure/ 取代」；**实施禁止引用 V1 清单的表设计** |

本轮复核过的事实（与文档一致）：字段读写（qualityJson/contentPath 零读写、mediaId/paramsJson/resultJson 活）｜路由与鉴权面｜调度不内嵌于 index.ts｜auth 仅口令｜StylePrompt 七类 key 与迁移标志 v2-v15｜选题生成即入库链路｜前端标题重复/选题下钻/扩充即入库。〔全部已验证〕

## 二、D1-D6 决策落实情况（落到具体改动）

| # | 落实位置 | 具体改动 | 状态 |
|---|---|---|---|
| D1 | `prisma/schema.prisma`（Angle 加 status/reviewRound/metaJson）+ 新表 TopicReview；`services/planner.ts`（reserveAngles 加 status='approved' 过滤）；`services/angles.ts`（升格事务）；`api/routes/angles.ts`（candidates 端点）；web TrackAnglesView→选题中心 | 存量 33 条逐条检查脚本（隔离库先跑） | 待实施（阶段 2） |
| D2 | `services/paragraph-reflow.ts`（限制只切超长段）；4A 第一项=对照测试脚本（`scripts/verify-reflow.ts`，样本切分前后段落数/CV/结构）；`form.postprocess` 开关 | emphasis 只动格式（现行为已符合，补断言） | 待验证后定默认（阶段 4A） |
| D3 | `services/form/schema.ts`（规则三级标注 hard/target/soft）；`constants.ts` 收缩；lint 注入 form? | 算术校验按 rhythm 选式 | 待实施（阶段 1B） |
| D4 | `TrackContract` 表（N 版本行 + Track.contractVersion 指针）；`services/form/contract.ts` 发布/回滚 | 02 已修正版本关系表述 | 待实施（阶段 1B） |
| D5 | 复用 `ModelRole.write`；阶段 4B 加验证脚本（结构化审核输出稳定性：格式/一致性/失败率/成本） | 不达标→再加 review 角色（枚举加值） | 待验证（阶段 4B） |
| D6 | 阶段 1B 第①步：六赛道种子补齐+告警；1C 第②步：严格模式开关（Setting `strict_config`） | 验收=删配置行写稿报错可读 | 待实施（阶段 1B/1C） |
| A/B/C | A→`api/permissions.ts` 扩点+阶段 2 越权测试；B→阶段 1A 产出决策（做/不做二选一）；C→trace 接口 legacy 分支（阶段 4C） | — | 已登记 |

## 三、生产数据库 migration baseline 方案

> 红线：**禁止拿真实生产库试验**；一切先隔离库。生产库现状盘点只允许只读查询。

1. **盘点（只读）**：连生产 MySQL 执行 `information_schema` 只读导出（表/列/索引/字符集/排序规则），与 `schema.prisma` 逐列 diff，产出《生产 schema 差异表》。
2. **建 baseline**：`prisma migrate diff --from-empty --to-schema-datamodel` 生成 `0_baseline`（**内容以差异表校正后的实际生产结构为准**，不盲目用本地 dev 推断）。
3. **隔离库验证（双库）**：MySQL 隔离实例（与生产同版本/同字符集 utf8mb4）+ SQLite 分别 `migrate deploy` 从空库跑 baseline → `prisma db pull` 比对一致性。**SQLite 过 ≠ MySQL 过**（枚举降级/严格模式差异要显式测）。
4. **备份与恢复演练**：`mysqldump` 全量备份 → 在隔离库恢复 → 行数/关键表校验（对齐「数据没了先查三件事」纪律）→ 记录恢复耗时。
5. **脚本纪律**：DDL（结构）与 DML（数据）分文件；每个 DDL 附「不能安全 down 时的向前修复说明」；`migrate deploy` 前跑 schema 差异检查（防止生产被手工改动过）。
6. **上生产**：维护窗口 → 备份 → deploy → 冒烟（只读接口）→ 出问题走向前修复或恢复备份（决策树写进 deploy/README）。
7. **配套**：`dev.db` 现有 9 个手工备份保留；新规矩=迁移前一律备份且验证恢复。

## 四、Python 本机流水线与云端关系（只读盘点结论）

**盘点对象**：`K:/WorkBuddy WorkSpace/wechat-pipeline`（README/PIPELINE.md/config/data/scripts 实读）。

| 维度 | 本机 Python 流水线 | 云端系统 | 关系判断 |
|---|---|---|---|
| 运行形态 | WorkBuddy 本地自动化 06:00（宿主库 automations.prompt）+ 手动脚本 | HTTP 服务 + 独立调度 CLI（23:59，push 默认关） | **两个独立调度器**〔自动化存在由项目记忆证实，本次未打开宿主库复查〕 |
| 选题库 | `data/angles/angles_<赛道>.json`（used 标记在 JSON） | `Angle` 表（used 在 DB） | **已分叉**：`cli/migrate.ts` 一次性导入后各自新增互不可见；**两边 used 互不相通→同一选题可能被两边各写一篇** |
| 文风配置 | `config/style_dna.json` + quality_check.py 硬编码四处 | StylePrompt 表（七类 key） | **双真源**（项目记忆明确要求改文风两边同步）；改文风成本×2 |
| 选题种子 | `config/topic_seeds.json` **活着**（add_angles.py 在用） | 同名文件是死文件 | 语义不同名同物，易混淆 |
| 公众号账号 | 戏精漫话/育儿号B/职场号/星座号/科技号/教育号（~/.wechat_accounts/*.env） | OAAccount 表（同批账号迁移而来） | **同批公众号**→两边都推=同一号草稿箱重复草稿 |
| 发布权限 | auto_publish=false，只到草稿箱 | AUTO_PUBLISH=false 常量 | ✅ 一致，红线同守 |
| 每日篇数 | posts_per_account_per_day=2（config.json） | TrackPipeline.quotaPerDay（1-2） | 口径不同，叠加后可能超预期产量 |

**风险**：双写冲突（重复草稿）、双写配置漂移（文风改一边漏一边）、角度抢占冲突（used 不同步）。
**决策 X ✅ 已关闭（2026-11-12 20:28 切换执行）**：用户拍板「停掉本机的，现在不需要了」，替代式切换**当即生效**，无过渡期了——
1. **执行结果**：WorkBuddy 自动化「公众号每日创作并推送草稿」（id `c879a541-bdd5-4bf2-ab45-11297564ebe9`，06:00）经自动化管理接口确认 **status=PAUSED**；本机 `wechat-pipeline` 目录转**只读蓝本归档**（数据不动、脚本不再被调度）。
2. **新单系统态**：云端=唯一系统；文风真源只剩 StylePrompt 表（"两边同步"义务作废）；本机未用选题如需带走可选用 `import` 幂等键一次性导入（可选）。
3. **⚠️ 生产空窗**：云端全部 User.automationMode=manual、无自动任务 → **目前每日自动出稿为 0**。恢复产稿=云端按账号调 `auto_draft`（或 `auto_draft_push`）；群发永远人工。
4. 遗留清理（不急）：自动化任务本体保留 PAUSED（可逆）；要彻底删除随时可用 automation_update delete。

## 五、阶段 0 与阶段 1 具体文件清单

### 阶段 0（纯前端）

| 文件 | 动作 | 内容 |
|---|---|---|
| `web/src/styles.css` | 修改 | 双令牌合并（:8-63 与 :61 起品牌段）；token 清单定稿 |
| `web/src/App.vue` | 修改 | 标题去重；导航重排（选题中心一级入口→现 TrackAngles 汇总）；系统状态收抽屉 |
| `web/src/components/ui/AppPageHeader.vue` 等 6 件 | 新增 | PageHeader/StatusBadge/EmptyState/ErrorState/SaveState/TaskProgress 骨架 |
| `web/UI-GUIDE.md` | 修改 | 三态全覆盖 + AI 操作披露规范 |
| `web/src/router/index.ts` | 小改 | 新导航路由（挂旧页面组件，不造新页） |
| 原型稿（docs/restructure/prototypes/） | 新增 | 选题中心/编辑工作区/契约配置低保真定稿 |
| 走查记录 | 新增 | 真机走查 7 场景截图记录（验收前置） |

### 阶段 1（1A/1B/1C）

| 文件 | 里程碑 | 动作 |
|---|---|---|
| `server/prisma/migrations/0_baseline/` | 1A | 新增（按 §三流程生成） |
| `server/scripts/verify-migrate.ts` | 1A | 新增（隔离库 up/down/向前修复演练） |
| `server/scripts/inventory-config.ts` | 1A | 新增（六赛道配置完整性盘点，只读） |
| `server/prisma/schema.prisma` + `schema.sqlite.prisma` | 1B | TrackContract/PromptVersion/GenerationRun + Track.contractVersion + qualityJson/contentPath @deprecated |
| `server/src/services/form/{schema,contract,arithmetic}.ts` | 1B | 新增（校验/版本/按 rhythm 算术） |
| `server/src/services/style-prompts.ts` | 1B | 迁移区封版抽 `services/form/legacy-migrations.ts`；保存接校验 |
| `web/src/views/StylePromptsView.vue` | 1B | 形态契约配置页重写（或新 TrackContractView） |
| `server/src/services/form/render.ts` | 1C | 新增（唯一 Renderer） |
| `server/src/services/writer.ts` / `angles.ts` | 1C | 拼装改走 Renderer；删骨架卡最高优先级；文案迁配置 |
| `server/src/constants.ts` / `services/lint.ts` | 1C | 宪法边界收缩；lint(form?) 参数 |
| `server/src/services/prompt-version/index.ts` | 1C | 新增（hash 去重登记） |
| `server/src/api/routes/style-prompts.ts` | 1B/1C | 保存校验 400；contract/versions 端点 |
| `server/scripts/smoke-style-prompts.ts` / `verify-contract.ts` / fixtures | 1B/1C | 扩充/新增 |

## 六、实施风险与测试计划

### 风险登记（12 项）

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| 1 | 生产 MySQL 无 baseline | 数据事故 | §三流程，1A 前置 |
| 2 | status/used 语义混淆 | 选题状态错乱 | 双维度铁律（02 §3.3-③）+ 状态机测试 |
| 3 | PromptVersion 与 StylePrompt 职责重叠 | 配置/版本难维护 | 前者=模板档案（hash），后者=当前业务配置 |
| 4 | GenerationRun 与 prompt-dump 生命周期不一致 | 追溯失效 | 稳定引用+hash+脱敏摘要，不依赖"最近 30 份文件" |
| 5 | 语义去重失败放行 | 重复入题库 | 阻止自动升格→待补审（Q 决策） |
| 6 | ArticleReview 与 Article 状态混用 | 误推送 | 两套状态分离（06 阶段 4B） |
| 7 | 核验简化为 URL 可达 | 错误事实被认定 | 证据质量独立判断（06 阶段 3） |
| 8 | member 权限不清 | 数据越权 | A 矩阵+后端数据范围+越权测试 |
| 9 | UI 提前展示不存在的状态 | 产品误导 | API 契约先于页面；假数据禁令 |
| 10 | comic 被文章重构波及 | 功能回归 | 边界声明+comic 回归测试（smoke:comic-*） |
| 11 | Python 本机流水线关系未清 | 重复生成/配置漂移 | §四决策 X；云端自动化对重叠账号保持关闭直至决策 |
| 12 | 出网与密钥暴露 | 安全 | 来源白名单、脱敏、权限控制（4C/5） |

### 测试计划（每阶段强制，非阶段 5 统一补）

| 层 | 内容 | 工具/命令 |
|---|---|---|
| 单元 | form schema/算术、状态机迁移、Renderer 变量注入、judgeAngle、lint 阈值 | `node --test` 或 smoke 断言脚本 |
| 集成 | 扩库→审核→升格→排产→写稿链路；计划→证据→生成→审核链路 | 隔离库脚本（verify-*） |
| 回归 | typecheck / vite build / smoke:lint(71) / smoke:style(33) / smoke:angles / smoke:comic-* | 每阶段收尾全绿 |
| 迁移 | up/down/向前修复、备份恢复、双库（MySQL+SQLite） | `verify-migrate` |
| 质量样本 | 选题 10 类判定矩阵、文章 8 类、契约算术边界、verify-negation、reflow 对照 | fixtures + 真机（计费，按需限量） |
| E2E | 全链路+错误场景（模型超时/格式错/判重失败/写库失败） | `verify-e2e`（隔离库，阶段 5） |
| UI | 真机走查 7 场景 + 三态 + 暗色 + 窄屏 + 无假数据 | 阶段 0 前置、阶段 5 全量 |
| 指标 | 五项核心指标快照随每阶段验收报告（分母/周期/来源，样本不足不出百分比） | 阶段 5 起，每阶段附快照 |

---

**检查结论**：设计基线齐备（00-08）、决策已登记（D1-D6/A/B/C/M/P/U/Q/X）、阶段 0/1 文件清单与测试计划已具化；**剩余阻塞项 2 个**——①决策 X（双系统关系）需用户拍板；②D2/D5 的验证脚本随阶段执行。**建议：确认后即可授权阶段 0 与阶段 1A 开工。**
