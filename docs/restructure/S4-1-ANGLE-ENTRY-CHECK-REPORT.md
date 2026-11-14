# S4-1 验收前补充核查：手动指定 angleId 的创作入口

- **日期**：2026-11-14（晚）
- **范围**：S4-1 报告 §5/§9 遗留——不经过 `reserveAnglesForPipeline` 的 angleId 入口是否绕过 approved 门禁。只处理该遗留，不进入 S4-2。
- **判定判据**（任务书 §二）：入口是否将 Angle 用作创作输入（读取选题正文进入生成），或是否构成「选题→生产」归属；不属于选题消费的入口只记录、不修改。

---

## 1. 入口清单与逐条判定（穷举 server/src + web/src 全部 angleId 引用）

| # | 入口 | 真实调用链 | 读选题正文作创作输入？ | 判定与处置 |
|---|---|---|---|---|
| 1 | **漫画建稿** `POST /api/articles/comic/create` | `articles.ts` 路由（findUnique angle，原 404）→ `createComicDraft` → `generateComicScript(angle…)` / `generateCreativeDirections(angle…)`，angle.theme/content 进 LLM 提示词 | **是** | **加 approved 校验**（路由内、404 判定之后） |
| 2 | **手动挂稿** `POST /api/articles`（angleId 可选） | `articles.ts` 路由 → `build(contentHtml)` → `article.create({angleId})`。服务端**不读**选题正文（contentHtml 全部来自调用方）；不置 used | 否（正文由调用方提供） | **仍加 approved 校验**：angleId 是文章的**选题归属**，绑定即意味着该选题进入生产——若放行候选/已拒绝选题，审核门可被挂稿绕过（文章可推送）。依据：charter §三2「只有审核通过的选题才能进入生产计划」。只校验状态，不碰 used/消费语义 |
| 3 | 自动调度 / 手动触发排产 | `scheduler.tick` / `POST /api/plan/trigger` → `runPipelineForAccount` → `reserveAnglesForPipeline` | 是 | **已由 S4-1 门禁**（approved 过滤），本次不动 |
| 4 | 删文 / 删账号的选题归还 | `article-delete.ts` / `accounts.ts`：重置 used | 否（回收语义，非创作） | **不修改** |
| 5 | 选题列表/详情/审核记录、文章按 angleId 过滤 | `angles.ts` / `articles.ts` GET | 否（只读） | **不修改** |
| 6 | `scripts/demo-write.ts`、`scripts/ab-gen.ts` | 开发者本地 CLI（`--angle` 显式指定，产样稿/AB 稿），非 API、非调度、非业务流程 | 是 | **不修改**：属开发工具不属于业务入口（任务书「不扩大到其他业务流程」）。如需统一门禁，一行 `assertAngleApproved` 即可补上，待确认 |
| 7 | `cli/migrate.ts`（历史导入器） | 一次性迁移工具，直写 Angle/Article | — | **不修改**（非运行时入口） |

**不存在的 angleId**：保持原有行为——漫画建稿仍 404（原有显式判定）；挂稿不新增 404，落库时按原外键失败路径处理（测试断言「非审核门拒绝」）。

## 2. 实际修改文件

| 文件 | 变更 |
|---|---|
| `server/src/services/topic-review.ts` | 新增 `assertAngleApproved(angle)` 共用守卫（错误文案含选题名/状态中文/引导路径） |
| `server/src/api/routes/articles.ts` | 入口 1（comic/create）：404 判定后加守卫；入口 2（挂稿）：body.angleId 存在且选题存在时加守卫 |
| `server/scripts/smoke-angles.ts` | 新增 26-28 三组共 10 断言（四状态×两入口 + 不存在 angleId 原行为） |
| `docs/restructure/S4-1-ANGLE-ENTRY-CHECK-REPORT.md` | 本报告 |
| `docs/restructure/S4-1-IMPLEMENTATION-REPORT.md` | §5/§9 遗留项回标（已处理 + 指向本报告） |
| `docs/DEVLOG.md` / `CHANGELOG.md` | 进度与变更记录 |

**未动**：used/FIFO/排产语义、reserve 路径、删除/归还、只读接口、前端（无 UI 改动）、S4-2 范围。

## 3. 状态流转与错误语义

- 校验只认 `Angle.status === 'approved'`；candidate / needs_revision / rejected 一律 **400**，文案：
  `选题「<主题>」当前为「候选待审|待修改|已拒绝」状态，只有审核通过（approved）的选题才能用于创作；请先到「赛道管理 → 选题库」完成人工审核`。
- approved 选题流程零变化：挂稿 201 落库；漫画建稿照常进入脚本生成（无模型时按原模型错误路径报错，与审核门无关）。

## 4. 测试结果（真实输出，全部隔离 smoke 库）

| 项 | 结果 |
|---|---|
| server `tsc --noEmit` | 0 errors |
| web `vue-tsc --noEmit` ×2 | 0 errors |
| `smoke:lint` | **116**（不降） |
| `smoke:style` | **41**（不降） |
| `smoke:angles` | **64** = 54 + 新增 10 |
| `verify:smoke-iso` | **10/10** |

新增断言（smoke-angles 26-28 组）：
- 挂稿：candidate / needs_revision / rejected → 400 + 含「只有审核通过」文案；approved → **201**（原功能不变）。
- 漫画建稿：三态 → 400 + 审核门文案；approved → 过门禁（后续为模型/角色错误而非审核门错误）。
- 不存在 angleId：漫画建稿 404（原行为）；挂稿走原失败路径且非审核门拒绝。

## 5. 数据库安全核查

- 业务库 `wechat_pipeline` 零写入：表清单 15 业务表 + `_prisma_migrations`（3 条记录），**无 TopicReview**（迁移 `20261114093000` 仍未部署，符合「不执行业务库 Migration」）。
- smoke 库 run 后 0 表残留；dev.db `fea0f123…` 不变；8 个归档备份只读未动。
- 他项目库零触碰（wpc_app 权限边界下 information_schema 不可见）。
- 未执行任何 LLM/微信外呼（漫画建稿 approved 用例止步于模型未绑定的原错误路径）。

## 6. 遗留与待确认

1. **业务库迁移部署仍待授权**（同 S4-1 报告 §9-1）。
2. `scripts/demo-write.ts` / `ab-gen.ts` 未加门禁（判定：开发工具非业务入口）。如你认为也应拦截，一行守卫即可补上。
3. 其余遗留（dupHits、评分提示词位置、dev.db 存量处置等）见 S4-1 报告 §9，均不在本任务范围。

---

**完成，停等 S4-1 最终验收及业务库 Migration 授权。未进入 S4-2。**
