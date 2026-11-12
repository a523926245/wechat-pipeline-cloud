# 产品与架构优化方案（PRODUCT-PLAN）

> 目标读者：接手开发的人 + 你自己拍板用。
> 状态：**方案稿（未实施）**。落地前先看第 6 节「待拍板决策」。
> 关联：`README.md`（定位）、`docs/DEVLOG.md`（进度台账真源）、`CHANGELOG.md`（变更）。

---

## TL;DR

> **落地状态（2026-11-11）**：下述 1-3 三大块已全部实施完毕（P1-P5，见 DEVLOG 当日五批记录）。
> 本节保留原方案叙述供追溯；**与落地的偏差以各节 ✅ 标注为准**（例如管理令牌未保留、已退场）。

改造前现状：「**单管理员令牌 + 全局单租户**」的个人工具形态。要变成「**开源级别的公众号 AI 内容生产系统**」，需要补三块，按依赖排序：

1. ✅ **定位与工程化开源底座**（LICENSE / README 重写 / 配置外置 / 命名去个人化 / Docker 部署）
2. ✅ **多用户体系**：注册 + 角色权限（RBAC）+ 有效期（订阅钩子）+ 配额（可绑定公众号数量）
3. ✅ **自动化开关整合**：把「生成草稿 / 推草稿箱 / 群发」三层语义做成一个客户可配的模式开关

外加第 4 节「还需要补充什么」的清单（商业化、安全合规、运维、体验、集成、工程质量）。

**核心架构判断**：`Account`（公众号账号）必须与 `User`（系统登录用户）彻底分开，并给 `Account` 加 owner 归属（多租户-ready）。这是开源 + 未来 SaaS 订阅的地基，越晚改代价越大。

---

## 1. 重新定位：从「个人工具」到「开源项目」

### 1.1 现状问题

- README 首句是「把现有 Windows 本机流水线搬上云服务器」——**迁移动机**，不是**产品定位**。
- 代码/文档里散落个人痕迹：绝对路径 `K:/WorkBuddy WorkSpace/...`、本机蓝本约定、个人公众号语境。
- `Account` 命名歧义（公众号账号 vs 系统账号），开源读者第一眼就懵。
- 无 LICENSE、无部署编排、配置散在库/常量/env 三处，新人上手成本高。

### 1.2 目标定位（建议措辞）

> **WeChat Pipeline Cloud** —— 开源的公众号 AI 内容生产系统。
> 自托管（self-hosted）即可跑通「选题 → 写稿 → 体检 → 封面/漫画 → 进草稿箱」全流程；
> 采用 **open-core** 模型：核心开源，订阅/计费/多租户高级能力可商业闭源。
> 一句话：给公众号运营者 / MCN / 团队用的「AI 内容工厂」，不是个人脚本。

### 1.3 「开源级别」的硬清单

| 项 | 现状 | 要做 |
|---|---|---|
| LICENSE | 无 | 选一个（建议 **Apache-2.0**，对商业友好、带专利授权） |
| README | 迁移叙事 | 产品定位 / 特性 / 架构图 / 快速开始 / 截图 / 贡献入口 |
| 配置外置 | 库+常量+env 混杂 | 统一 `.env`（带 `.env.example`），常量只留安全红线 |
| 命名去个人化 | `Account`=公众号 | **`Account` → `OAAccount`**（或 `WechatAccount`）；系统用户用 `User` |
| 部署 | 仅 deploy/*.service | 补 `docker-compose.yml`（app+MySQL+Nginx）一键起 |
| 数据库迁移 | `schema:sqlite` / `db push` | 规范 baseline migration + 版本化（`deploy/README.md` 已有雏形） |
| API 文档 | 无 | OpenAPI/Swagger（可由 zod schema 生成） |
| 贡献 | 无 | `CONTRIBUTING.md` + Issue/PR 模板 |
| 安全 | 无 | `SECURITY.md`（漏洞上报口径）+ 依赖扫描 |
| 测试/CI | 本地 `smoke:*` | 接 GitHub Actions（lint+build+smoke） |
| 国际化 | 纯中文 | 预留 i18n（面向国际可选，非阻塞） |

> 命名改造是**低风险高回报**的第一步：`Account`→`OAAccount` 影响 schema/API/前端，但趁现在没有第三方集成，改得越早越便宜。

---

## 2. 账号注册 + 角色权限（多用户体系）

### 2.1 先拍板：多租户模型

| 方案 | 含义 | 适用 | 数据模型 |
|---|---|---|---|
| A. 单组织自托管 | 一套系统 = 一个团队，用户是「成员」，共享公众号池 | 内部/小团队 | User 只做登录+角色，资源全局共享 |
| B. 多租户 SaaS | 一套系统 = 多个「客户」，每个客户隔离公众号/文章 | 商业订阅 | 每个资源带 `ownerUserId`，按客户隔离 |

**建议：按 B 设计（多租户-ready），但兼容 A。**
理由：你明确提到「订阅收费」「客户可绑定的账号数量」——这已经是 SaaS 语义。open-core 模式下，开源版默认单组织（A 用法），商业版解锁多租户（B 用法）。数据模型一步到位带 owner，后面不用大迁移。

### 2.2 数据模型（Prisma 增量）

```prisma
/// 系统登录用户（区别于 OAAccount=公众号账号）
model User {
  id            Int      @id @default(autoincrement())
  email         String   @unique @db.VarChar(191)
  username      String   @unique @db.VarChar(64)
  passwordHash  String   @db.VarChar(255)     // argon2id
  role          UserRole @default(guest)      // 见下
  status        UserStatus @default(pending)  // pending/active/suspended/expired
  emailVerified Boolean  @default(false)
  /// 订阅有效期（=「有效期」）。null = 不过期（如管理员）
  expiresAt     DateTime?
  /// 配额上限（订阅钩子）。0/负 = 用 Plan 默认
  maxOAAccounts Int      @default(1)          // 可绑定公众号数量上限
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  accounts OAAccount[]   // 该用户名下绑定的公众号
  // ...
}

enum UserRole {
  admin     // 站点管理员：全权限 + 用户/系统管理
  member    // 正式成员：内容与公众号管理，无用户管理
  guest     // 游客（默认注册角色）：只读/受限，带有效期
}

enum UserStatus {
  pending    // 待验证/待审批
  active     // 正常
  suspended  // 人工封禁
  expired    // 过期（订阅到期自动落到这里）
}
```

**公众号账号表加 owner**（关键改动）：

```prisma
model OAAccount {           // 原 Account 改名
  id          Int    @id @default(autoincrement())
  ownerUserId Int            // 新增：归属用户（多租户隔离）
  owner       User   @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  trackId     Int
  name        String
  appid       String   @unique
  // ...（其余字段不变）
}
```

### 2.3 认证改造（✅ 已落地 2026-11-11，口径以本节为准）

- **现状（落地后）**：口令登录（scrypt 哈希）+ **per-user 会话**（UserSession 表 + httpOnly
  cookie `wb_session`，可吊销）；注册开放 + 管理员审批（guest/pending → member/active）。
- **与原方案的偏差（拍板）**：**管理令牌不留**——原计划「保留作 break-glass」，实际落地后
  当日退场（明文存 Setting 是安全债；忘口令救济走 `npm run seed:admin -- --reset-pass`）。
  传 { token } 登录一律被拒，smoke:auth 有断言钉死。
- 首个管理员：`npm run seed:admin`（幂等）；应急重置：`seed:admin -- --reset-pass`。
- 未做（下期可选）：微信扫码 OAuth、邮箱/手机验证、自助改密界面。

### 2.4 角色权限矩阵（RBAC）

把「登录即可」升级为「按权限点放行」。中间件从 `authGuard` 进化出 `requirePermission('oa_account:manage')`。

| 权限点 | admin | member | guest |
|---|:--:|:--:|:--:|
| 查看仪表盘/文章 | ✅ | ✅ | ✅（只读）|
| 写稿/改稿/排产 | ✅ | ✅ | ❌（或试用配额）|
| **公众号账号管理**（绑定/改密/启用） | ✅ | ✅ | ❌ ← **你要求的这条** |
| 模型/凭据/文风配置 | ✅ | ✅ | ❌ |
| 调度/自动化开关 | ✅ | ✅ | ❌ |
| 用户管理 / 角色分配 | ✅ | ❌ | ❌ |
| 系统设置 / 订阅管理 | ✅ | ❌ | ❌ |

> 「没有这个角色的不能使用账号管理功能」= `oa_account:manage` 权限点，`guest` 不具备。中间件层硬拦，不只靠前端隐藏。

### 2.5 配额与有效期（订阅钩子）

- **可绑定公众号数量**：`User.maxOAAccounts`。绑定 `OAAccount` 前校验 `count < maxOAAccounts`。
- **有效期**：`User.expiresAt`。过期 → `status=expired`，降级为只读/禁写、停自动调度；**不清数据**（续费即恢复）。
- **其它可配额**（预留）：每日产文数、模型 token 用量、封面/漫画生成次数。
- **订阅表**（可选，商业化时再拆）：`Subscription { userId, plan, startsAt, endsAt, status }`；现在先把 `expiresAt`+`maxOAAccounts` 放 `User`，够用且简单。

---

## 3. 自动化开关：一个开关，自动 / 手动

### 3.1 必须先分清三层语义（现在混在一起）

| 层 | 含义 | 现状 | 红线 |
|---|---|---|---|
| **生成草稿** | LLM 写稿入库（status=draft） | `scheduler_enabled` + `write_time` | 无 |
| **推送草稿箱** | 调微信草稿箱接口，运营者进后台能看到草稿 | `scheduler_push_enabled` | 无（可自动） |
| **群发** | 发给所有粉丝（真正「发布」） | `AUTO_PUBLISH=false` 常量 | **永不自动，红线** |

> ⚠️ 你说的「发布草稿」= **推送草稿箱**（第二层），不是群发（第三层）。群发红线必须保留，且与本开关解耦。

### 3.2 一个客户可配的「自动化模式」

把散落的开关收敛为一个枚举（每客户可选）：

```ts
type AutomationMode = 'manual' | 'auto_draft' | 'auto_draft_push';
// manual          手动：完全人工点「生成」「推送」
// auto_draft      半自动：到点自动写稿入库，人工审核后手动推草稿箱   ← 推荐默认
// auto_draft_push 全自动：到点自动写稿 + 自动推草稿箱
```

- 落库：`Setting` 或 `User`（多租户时每客户一个），键如 `automation_mode`。
- 保留 `scheduler_write_time`（到点）；`scheduler_enabled`/`scheduler_push_enabled` 由 `automation_mode` 推导，减少并列开关。
- **群发永远是独立的手动动作**（且建议二次确认），不在这个开关里。
- UI 明确三个词：**生成草稿 / 推送草稿箱 / 群发**，别再用「发布」含糊。

### 3.3 现有代码如何落

- `services/scheduler.ts` 的 `getSchedulerConfig()` 增加 `mode`，`tick()` 依据 `mode` 决定是否 `pushArticleToDraft`。
- `AUTO_PUBLISH` 常量**不动**（群发红线）；`system.ts /health` 继续暴露它供运维核对。
- 前端调度面板：一个三态选择器 + 时间点，替代现在的两个布尔开关。

---

## 4. 还需要补充什么（清单）

按主题分组。**加粗 = 强烈建议先做**，其余按需。

### A. 商业化 / 订阅（你已预告要做）
- **订阅计划（Plan）**：free / pro / team，映射配额与有效期。
- **用量计量（usage metering）**：LLM token、产文数、生图数——计费与配额的依据。
- **试用期（trial）**：注册送 N 天 / N 篇。
- 支付接入（微信支付/支付宝）与发票。
- 套餐升降级、到期提醒、续费流。

### B. 安全与合规（开源 + 多用户后必须）
- **审计日志（audit log）**：谁在何时改了角色/绑了公众号/触发了群发——计费对账与安全追责都要。
- **接口限流（rate limit）** 与防滥用（尤其注册、LLM 调用）。
- **2FA / 登录保护**（可选）。
- **数据隔离**：多租户下查询强制带 `ownerUserId`，防越权（水平越权是 SaaS 头号漏洞）。
- **凭据安全**：已是 AES-256-GCM，补密钥轮换、最小权限、`.env` 不入库。
- **微信合规**：内容审核钩子（可插拔 moderation）、敏感词、原创声明。
- **隐私/数据删除**：用户注销 → 级联删除/导出（GDPR-like）。

### C. 运维 / 可观测
- **备份/恢复**：数据库定时备份 + 一键恢复；按租户导出。
- **监控告警**：任务失败、配额将满、订阅将到期 → 邮件/微信通知。
- **任务可靠性**：失败重试、死信、幂等（部分已有 `withLock` + 配额幂等）。
- **健康检查 / 就绪探针**（`/health` 已有雏形，补依赖检查）。

### D. 用户体验
- **首次运行引导向导**：建管理员 → 配模型 → 绑公众号 → 开自动化。
- **通知中心**：任务完成/失败、审核待办。
- **移动端适配**（响应式已有 Element Plus 基础）。
- **白标/品牌**：标题前缀已有，可扩 logo/域名自定义。

### E. 平台 / 集成
- **OpenAPI + Webhook**：对外集成（内容发到别处、触发外部流程）。
- **模型供应商插件化**：`model-registry` 已四维解耦，补「一键接入市场」。
- **多公众号聚合大盘**：跨账号数据对比。
- **内容审核/查证插件位**（`citation` lint 已 warn，可外接事实核查）。

### F. 工程质量
- **测试**：单测 + 集成（smoke 已有 71+ 项，补 CI 必跑）。
- **CI/CD**：GitHub Actions（typecheck/build/smoke）+ 自动 release。
- **API 版本化**（`/api/v1`）与契约测试。
- **文档**：架构图、数据字典（`schema.prisma` 注释已不错，导出成文）。

---

## 5. 实施路线图（建议顺序）

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P1 开源底座** | LICENSE、README 重写、`.env` 外置、`Account`→`OAAccount` 改名、Docker | 无 | 低（改名要全链路）|
| **P2 用户体系** | `User` 模型、注册/登录/会话、`requirePermission`、默认管理员 | P1 | 中 |
| **P3 权限+配额** | RBAC 矩阵、`ownerUserId` 隔离、`maxOAAccounts`、`expiresAt` | P2 | 中高（水平越权要测）|
| **P4 自动化开关** | `automation_mode` 三态、收敛调度开关、群发解耦 | P1 | 低 |
| **P5 商业化钩子** | Plan/用量计量/审计/限流/通知 | P3 | 中 |
| P6 集成扩展 | Webhook/OpenAPI/插件/审核插件位 | P4 | 低 |

> P4（自动化开关）可与 P2/P3 并行，改动面独立、见效快，建议先做。

---

## 6. 待拍板决策（开始前请确认）

1. **多租户模型**：按方案 B（多租户-ready，开源版默认单组织）—— 是否认可？
2. **注册开放策略**：开放注册 / 邀请码 / 管理员审批？（影响默认角色与有效期）
3. **角色粒度**：`admin / member / guest` 三档够用吗？要不要更细（如 `editor`）？
4. **自动化开关粒度**：全局一个，还是每客户一个？（多租户建议每客户）
5. **默认有效期**：游客注册给多少天？到期是「降只读」还是「封禁」？（建议降只读）
6. **微信扫码登录**：这一期要不要，还是先纯账密？
7. **命名改造**：`Account`→`OAAccount` 这期就改，还是先做用户体系再改？（建议先改）

---

## 附：现状快照（便于对照）

- 鉴权：口令 + per-user 会话（UserSession），RBAC 角色矩阵已挂全路由；管理令牌已退场（2026-11-11）。
- 数据模型：`User`/`UserSession` 已建；`OAAccount` 带 `ownerUserId` 归属（水平越权已收口）。
- 自动化：`scheduler_enabled` / `scheduler_push_enabled` / `scheduler_write_time` 三个 Setting；`AUTO_PUBLISH=false` 是群发红线常量。
- 技术栈：Node22 + TS(strip-only) + Express + Prisma(SQLite 本地 / MySQL 生产) + Vue3 + Vite + Element Plus。
