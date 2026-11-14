# 项目理解报告（重构前置验证）

**日期**：2026-11-12 晚 | **性质**：只读审查 | **版本**：V1.0
**证据标注**：〔已验证〕= 本次读代码/查库实证；〔推断〕= 有部分证据未完全验证；〔待确认〕= 项目内无法确认。

> 本文件回答「你是否真正理解当前系统」。架构细节见 `CURRENT-ARCHITECTURE.md`，本文件只讲业务语义与验证边界。

---

## 1. 系统是什么（一句话）

一套**多账号、多赛道的微信公众号 AI 内容生产系统**：AI 扩选题池 → 排产 → LLM 写稿 → 体检门禁 → 人工审改 → 推送微信**草稿箱**（群发永远人工）。当前定位正从「个人工具」转向「开源/多客户产品」（有 User/RBAC/订阅钩子）。

## 2. 业务语义（已验证的关键约定）

| 约定 | 含义 | 证据 |
|---|---|---|
| 三层自动化语义 | ①生成草稿（LLM 写稿入库）②推送草稿箱（调微信草稿箱接口）③群发（发粉丝）——②≠③，③永不自动 | `constants.ts:8` `AUTO_PUBLISH=false`；`publisher.ts` 无 masssend〔已验证〕 |
| 双产线 | 赛道下可并行 `article` / `comic` 两条产线，配额、角度切片（`Angle.scope`）各自独立 | `TrackPipeline` 表 + `services/pipeline.ts`〔已验证〕 |
| 角度池消费 | 同赛道多账号共享池，取一个少一个，CAS 抢占；pushed 文章删了不还角度 | `planner.ts` 事务 + `angles.ts:485 releaseAngle` 注释〔已验证〕 |
| 三层自动化模式 | User.automationMode ∈ manual / auto_draft / auto_draft_push（每客户）；无主账号回落全局 Setting | `scheduler.ts:45-56, 193-213`〔已验证〕 |
| 多用户 | User(admin/member/guest + pending 审批) 与 OAAccount(公众号) 分离；ownerUserId 轻量归属，非强租户 | schema `User`/`OAAccount`；`api/permissions.ts`〔已验证〕 |
| 预览=推送 | contentHtml（可编辑真源）→ 同一 render 函数 → contentWechat（推送产物） | `render/index.ts` 唯一渲染〔已验证〕 |
| 双副本并行 | 本机 Python 流水线（`K:/WorkBuddy WorkSpace/wechat-pipeline`）每天 06:00 真实生产；云端系统独立运行、文风两边需同步 | 项目记忆 + `docs/WRITING-PIPELINE.md`〔推断：本机侧本次未复查〕 |

## 3. 技术栈与运行拓扑

- 后端 Node22 + TS(strip-only，无构建) + Express + Prisma；本地 SQLite（`server/prisma/dev.db`）/ 生产 MySQL（schema 单源，`gen-sqlite-schema.mjs` 降级生成）。〔已验证〕
- 前端 Vue3 + Vite + Element Plus，`web/dist` 已构建过。〔已验证〕
- 运行拓扑有两个进程：`src/index.ts`（HTTP 服务）**不**内嵌调度器；定时是独立 CLI `src/cli/scheduler.ts`（`npm run scheduler`）。〔已验证：index.ts 全文只有 startServer〕
- 模型：4 个 LlmModel，文本角色（write/revise/expand_angles/comic_script）全绑 Agnes 3.0 Flash；生图走 ModelScope/Agnes-image。`llm.chatComplete` 只有 messages+temperature/maxTokens/topP，**不支持 tools/JSON mode/embedding**（JSON 靠正则抠）。〔已验证：`llm.ts:133-173`〕

## 4. 验证方法与边界

**做了**（全程只读）：
- 通读 `server/src` 服务层/路由/schema（重点：angles/writer/lint/style-prompts/track-rules/dedup/planner/publisher/scheduler/revise/llm/constants）。
- `node:sqlite` **readOnly: true** 查询 dev.db（表结构、数据分布、Setting 迁移标志）。
- 字段读写追踪：对可疑字段全库 grep 读写点。
- 前端：`router/index.ts`、`App.vue`、`styles.css`、`UI-GUIDE.md`、TrackAnglesView/ArticleEditView/ArticlesView 关键段落抽查（UI 论断逐条对证）。

**没做**（并如实说明）：
- **没有在真实浏览器里看页面**：本会话浏览器控制能力未启用（browser-use skill 不可用），且登录只有口令（`auth.ts:6` 注明管理令牌已退场 2026-11-11），我没有口令、也不允许重置口令（会写库）。→ UI 结论=源码静态分析 + 与你提供的 UI-UX-REDESIGN-PLAN 交叉对证，**不冒充看过渲染效果**。
- 没有跑任何写库脚本 / 迁移 / 安装依赖 / 发起微信与外网调用。
- 没有复查本机 Python 流水线侧（超出云端项目范围）。

## 5. 高层结论（详情在各专篇）

1. 系统骨架（模块化单体、鉴权、双产线、模型适配、群发红线）是健康的，重构不需要推倒。〔已验证〕
2. 三条硬伤都在「内容生产语义层」：**形态契约无单一真源**、**选题生成即入库无审核**、**去重/审核大量逻辑未进运行链路**（`dedup.judgeAngle` 死代码、`topic_seeds.json` 死文件、`Article.qualityJson`/`contentPath` 死字段）。〔已验证〕
3. 数据库能支撑目标架构，但**没有 prisma/migrations 目录**（无版本化迁移历史，只有 db push + 代码内数据迁移），上生产前必须补 baseline。〔已验证〕
4. UI 具备设计令牌与组件规范基础（`styles.css` --wb-* 令牌、`UI-GUIDE.md` 5 节规范、BatchBar/StateError 等组件），问题是**信息架构与工作流**（选题藏在赛道下钻、生成即入库的交互、标题重复、编辑器门槛），不是缺颜色圆角。〔已验证〕
5. 原《重构实施清单 V1》方向对、但存在**过度设计（TopicCandidate 独立表）与顺序问题（UI 介入过晚）**，不能直接照跑。详见 `RESTRUCTURE-REVIEW.md`。
