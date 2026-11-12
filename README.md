# wechat-pipeline-cloud

**开源公众号 AI 内容生产系统**（open-core）：选题库 → LLM 写作/漫画 → 成稿体检 → 在线改稿 → 微信草稿箱的全链路 Web 管理系统。支持多用户、角色权限、每客户自动化开关，可自托管。

> 安全承诺：**系统永不自动群发**。`AUTO_PUBLISH = false` 是代码层硬常量，推送只写公众号**草稿箱**，发布永远由人在公众号后台完成。

## 功能

- **双产线**：文章产线（选题→写作→体检→改稿→封面→草稿箱）与漫画产线（脚本→逐格生图→金句卡→草稿箱），按「赛道 × 产线」独立配额
- **共享题库**：同赛道多账号共享角度池，CAS 先到先得（取一少一），占用标记到用户/账号级，跨客户防重复生成同一篇
- **文风系统**：创作总纲 + 赛道文体 + 标题/结构/篇幅三维变体库（逐篇轮换反模板化），改配置即改文风
- **成稿体检门禁**：字数/小标题/破折号等 error 级拦推送，warn 级提示；体检不过自动定向修补（最多 2 轮）
- **多用户**：开放注册 + 管理员审批；角色 `admin / member / guest`；公众号账号按用户归属隔离；订阅有效期/可绑公众号数配额（预留付费开通口子）
- **每客户自动化**：`manual`（纯手动）/ `auto_draft`（自动写稿，人工审后推）/ `auto_draft_push`（写稿+自动推草稿箱），各客户独立时间点
- **模型域**：供应商/协议/能力/角色四维解耦，OpenAI 兼容对话 + 多生图通道（Agnes / ModelScope Qwen Image），Key 加密入库

## 快速开始（本地开发）

```bash
# 后端（Node 22+；本地用 SQLite，无需 MySQL）
cd server
npm install
npm run schema:sqlite && npm run sqlite:generate && npm run sqlite:push   # 建本地库
npm run seed:admin        # 建管理员（口令随机打印一次）
npm run dev               # http://127.0.0.1:8787

# 前端（另开终端）
cd web
npm install
npm run dev               # http://127.0.0.1:5173（代理 /api → 8787）
```

生产部署（systemd / Nginx / MySQL 与一键安装脚本）见 [`deploy/README.md`](deploy/README.md)。Docker Compose 快速起：

```bash
docker compose up -d          # 见根目录 docker-compose.yml（app + MySQL）
docker compose exec app node --experimental-strip-types scripts/seed-admin.ts
```

## 多用户与权限

| 角色 | 能力 |
| --- | --- |
| `admin` | 全权：用户管理、题库/赛道/文风/模型（系统内部）、全局调度总开关 |
| `member`（客户） | 管自己的公众号账号（≤配额）、自己的自动化开关、自己的数据；手动生成草稿+推送草稿箱（不改稿） |
| `guest` | 只读（默认注册角色；订阅过期也降为此档） |

- 注册开放 + 管理员审批（pending→active）；`expiresAt` 为订阅有效期钩子（到期降只读）；`maxOAAccounts` 为可绑公众号数上限
- 归属隔离：`OAAccount.ownerUserId`，文章/运营数据经账号归属过滤（水平越权防护，找不到与无权统一 404）
- 首个管理员由 `npm run seed:admin` 产生；忘记口令用 `npm run seed:admin -- --reset-pass`（管理令牌机制已移除）

## 自动化语义（三个开关别混）

| 层 | 含义 | 谁控制 |
| --- | --- | --- |
| ① 生成草稿 | LLM 写稿入库 | `automation_mode`（每客户） |
| ② 推草稿箱 | 调微信草稿箱接口，运营可见 | `automation_mode`（每客户） |
| ③ 群发 | 发给粉丝 = 真发布 | **红线永不动**（独立手动动作） |

`automation_mode` 三态只覆盖 ①+②：`manual` / `auto_draft` / `auto_draft_push`。`scheduler_enabled` 是全局总开关（关了谁都不跑）。

## 安全红线

- **群发永不自动**：`AUTO_PUBLISH = false` 硬常量，publisher 中不存在 masssend 调用；`/api/health` 暴露该值便于核对
- **凭据永不外泄**：微信 AppSecret / LLM API Key 一律 AES-256-GCM 加密入库，API 只回掩码；主密钥 `APP_SECRET_KEY`（32 字节 base64）**一旦写入数据就不能更换**
- **鉴权默认全拦**：`/api/*` 全量鉴权，公开项仅 `/api/health` 与 `/api/auth/*`；会话 httpOnly cookie；口令 scrypt 哈希；冒烟旁路 `SMOKE_NO_AUTH=1` 仅非 production 生效

详见 [`SECURITY.md`](SECURITY.md)。

## 技术栈

**后端** Node 22 + TypeScript（`--experimental-strip-types`，源码即运行产物，**相对 import 必须带 `.ts` 后缀**）+ Express 4 + Prisma
**数据库** MySQL 8（utf8mb4，生产）/ SQLite（本地开发，由 `scripts/gen-sqlite-schema.mjs` 从 MySQL 真源自动降级生成，只维护一份 schema）
**前端** Vue3 + TypeScript + Element Plus + Vite（不用 wangEditor，改稿页语义化 HTML 源码编辑 + 实时预览）

⚠️ 切回 MySQL 前必须 `npm run prisma:generate`；生产机绝不能跑 `schema:sqlite`/`sqlite:generate`（会覆盖生成的 client）。

## 目录结构

```
server/
  src/
    app.ts          Express 装配（鉴权中间件挂 /api，公开项仅 /health 与 /auth/*）
    constants.ts    安全红线与业务硬指标（AUTO_PUBLISH=false、门禁阈值）
    services/
      auth.ts         用户会话 + 口令哈希（管理令牌已退场）
      ownership.ts    归属隔离（水平越权收口：入口层+服务层双层）
      permissions.ts  RBAC 权限点与角色矩阵
      accounts.ts     公众号账号增删（含级联删文/归还角度事务）
      planner.ts      排产（buildPlan + 角度预留 CAS + 触发建稿）
      scheduler.ts    自动调度（单进程 tick 按账号 owner 的 automation_mode 分流）
      writer.ts       写作（文风注入 + 三段保命 + 定向修补）
      lint.ts         成稿体检门禁（error 拦推送 / warn 提示）
      publisher.ts    推草稿箱（手动与自动共用同一函数）
      wechat.ts       微信通道（token 缓存 / 素材 / 草稿，绝不群发）
      model-registry.ts  模型域单一真源（供应商/协议/能力/角色）
      …parse/ render/ emphasis/ paragraph-reflow/ ellipsis/ comic/
    api/routes/     路由（auth/users/credentials/articles/plan/scheduler/…）
    cli/            migrate · inspect · scheduler
  prisma/schema.prisma           MySQL 真源（数据字典）
  prisma/schema.sqlite.prisma    自动生成勿手改
  scripts/        smoke:* 冒烟 · seed-admin · migrate-automation · gen-sqlite-schema
web/              前端（Vue3 + Vite + Element Plus）
config/           style_dna.json · topic_seeds.json · comic_templates.json
deploy/           systemd / Nginx / logrotate / 一键安装（见 deploy/README.md）
docs/             DEVLOG（进度台账）· PRODUCT-PLAN · WRITING-PIPELINE（写作链路）· WRITING-GUIDE（方法论）
reference/python/ 本机脚本副本（移植对拍基准，只读）
```

## 常用命令

```bash
cd server
npm run typecheck                  # 类型检查
npm run dev                        # 开发启动（热重载）
npm run seed:admin                 # 幂等建管理员（首启必跑；-- --reset-pass 重置口令）
npm run schema:sqlite && npm run sqlite:push   # 本地 SQLite 建/同步表
npm run scheduler                  # 调度守护（常驻 60s 心跳）
npm run scheduler:once -- --force  # 立即补跑一次

# 迁移（本机 JSON → 云库）
npm run migrate:dry                # 预检
npm run migrate -- --apply
npm run migrate:automation -- --dry   # 旧调度三键 → 每用户 automation_mode（预览）

# 冒烟（共享同一个 SQLite，必须串行；输出不要接 | head）
npm run smoke:auth          # 鉴权（公开路径/口令登录/会话/登出/令牌已退场）
npm run smoke:users         # 多用户（注册/审批/权限矩阵/过期降只读）
npm run smoke:ownership     # 水平越权（他人账号/文章全 404、配额、级联删文）
npm run smoke:automation    # 每客户三态分流（manual 不产 / auto_draft 不推 / 全自动）
npm run smoke:lint          # 成稿体检门禁（90 项）
npm run smoke:style         # 文风配置与三维变体（29 项）
npm run smoke:angles        # 选题库 CRUD 与消费态
npm run smoke:cover         # 封面链路（换号重传/相对路径）
npm run smoke:migrate       # 迁移幂等（14 项）
npm run smoke:models        # 模型域（需空表或 --force；跑完 npm run model:local 恢复）
npm run smoke:p2            # 产线/并发退避/仪表盘分组
npm run smoke:comic-align / smoke:comic-qc / smoke:quote-card   # 漫画产线

npm run demo:write          # 真写一篇验文风（--dry 不落库）
npm run verify:length -- --n=10   # 真机跑 N 次验篇幅落点（改锚值后必跑）
npm run model:local         # 本地 Key 配成写作模型（幂等）
```

> 冒烟脚本共享同一个 SQLite，**必须串行**；输出**不要接 `| head`**（管道截断会让 node 提前退出、清理不执行）。`smoke:models` 要求模型表为空（否则 `--force`），跑完用 `npm run model:local` 恢复本地模型。

## 关键业务规则（改造时必须保持）

- 每天每账号按「赛道 × 产线」配额（`TrackPipeline.quotaPerDay` 是真源），配额幂等
- 同赛道多账号**共享赛道级角度池**，取一少一个（CAS 抢占）；`used/usedById/usedByAccountId` 标记消费态，删文/删号归还（pushed 不归还）
- 观点层去重：与现有选题比 + 与历史标题比 + 同主题堆积上限 8
- 凭据门禁：AppID 必须 18 位 `wx` 开头、Secret ≥20 位、非占位；连通测试通过才启用
- 微信错误码：40164（IP 白名单）**不重试**直接报出口 IP 指引；40001/42001 刷 token 重试 1 次；网络退避 ≤4 次
- `Article` 必填 `pushDate` + `idempotencyKey`；封面/漫画上传 key 形如 `<accountId>:<path>`（换账号必须重传）
- 删账号级联删其文章；删赛道只置空 `trackId`（有账号 409）；角度只归还 draft/updated/failed，pushed 不归还

## 文风与写作（改内容前必读）

文风真源三处，**改文风改这三处，不要在代码里硬编码文案**：

1. **「文风配置」页**（`StylePrompt` 表，优先级最高）：创作总纲 + 赛道文体 + 三维变体库（`min-max|pMin-pMax|说明` 格式，游标逐篇轮换反模板化）
2. `config/style_dna.json`：赛道调性/结构主线/段落形态/细腻度/强调标注（键名**中文为准**，`pick()` 兼容英文键）
3. `writer.ts` 的 `SYSTEM_PROMPT`：只放结构与硬性禁令，阈值与 `lint.ts` 共用 `constants.ts`

硬门禁（`lint.ts` error 级拦推送）：小标题 3-4、字数 1300-2300、无破折号、无否定框架。写稿提示词**篇幅写成段落数不写字数**（`PARA_TARGET` 17-19 段，字数作为结果出现），主提示与修补提示目标区间必须同源（否则模型取下限）。三条保命设计：`normalizeBareParagraphs()` 先补标签再按末尾 `</p>` 收口；`repairOnce()` 最多 2 轮用 `distance()` 判进步、没进步立刻停；`WRITE_MAX_TOKENS=4096`。

**写作链路（改文风/改结构/改体检之前必读）见 [`docs/WRITING-PIPELINE.md`](docs/WRITING-PIPELINE.md)**：
配置真源 `StylePrompt` 的 5 类 key、prompt 拼装顺序与预算规则、变体轮换与 `---` 分隔、
后处理链、体检与修补、以及「改东西之前必须知道的 6 条」。

写作方法论（调研纪要/变体用法/查证自检清单）见 [`docs/WRITING-GUIDE.md`](docs/WRITING-GUIDE.md)。验稿入口：`npm run demo:write` 与 `npm run verify:length`。

## 双产线（article / comic）

| 产线 | 链路 | 角度切片 | 默认 |
| --- | --- | --- | --- |
| article | 选题→写作→改稿→封面→草稿箱 | `article`+`shared` | 启用 |
| comic | 选题→脚本→逐格生图→金句卡→草稿箱 | `comic`+`shared` | 停用，配额 0 |

漫画生图是慢任务：`ComicPanel.status` 行级状态机即队列，调度心跳分两阶段（锁内写脚本 / 独立锁多轮生图），时间预算 `COMIC_TICK_BUDGET_MS` 用完即还、下次心跳续跑（幂等不漏格）。并发/退避参数（`COMIC_MAX_PANELS_PER_RUN` 等）均有默认值。配额真源 `TrackPipeline.quotaPerDay`（`Track.quotaPerDay` 已废弃，读写走 `services/pipeline.ts`）。

## 开发与贡献

- 贡献指南见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；安全问题见 [`SECURITY.md`](SECURITY.md)
- **进度台账唯一真源是 [`docs/DEVLOG.md`](docs/DEVLOG.md)**（按日期记录做了什么/下一步/阻塞项）；本 README 只放定位、约束与操作手册，不复述历史。新会话接手先读 README + DEVLOG
- 开发纪律：改 schema 必跑 `npm run schema:sqlite`；Node strip-types 不支持参数属性、import 必须带 `.ts`；冒烟必须串行；两遍 vue-tsc 必须串行；`typecheck`+`build` 全绿才算完；每完成任务单元要更新 DEVLOG/CHANGELOG
- 移植对拍：`reference/python/` 是已验证的算法蓝本，TS 移植后必须同输入比对输出
- 本机双副本约束：本项目与 `K:/WorkBuddy WorkSpace/wechat-pipeline`（本机流水线，只读）共享文风口径与门禁阈值，改动需两边同步，勿单边「顺手统一」

## License

[MIT](LICENSE)
