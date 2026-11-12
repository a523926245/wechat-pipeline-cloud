# 贡献指南（CONTRIBUTING）

感谢关注 wechat-pipeline-cloud。本项目是**公众号 AI 内容生产系统**（open-core），欢迎 issue 与 PR。

## 开发环境

- Node.js 22+（TypeScript 直跑 `--experimental-strip-types`，无构建步骤）
- 本地数据库用 SQLite（无需 MySQL）；生产用 MySQL 8

```bash
cd server && npm install
npm run schema:sqlite && npm run sqlite:generate && npm run sqlite:push
npm run seed:admin
npm run dev        # 后端 :8787

cd web && npm install && npm run dev   # 前端 :5173
```

## 提 PR 前的检查清单

1. `cd server && npm run typecheck` 全绿
2. `cd web && npm run typecheck && npm run build` 全绿（两遍 vue-tsc 必须**串行**，并行会因 .tsbuildinfo 冲突报假错）
3. 相关 `npm run smoke:*` 全过（共享同一个 SQLite，**必须串行**；输出不要接 `| head`，会让清理不执行留脏数据）
4. 改了 `prisma/schema.prisma` → 必须重跑 `npm run schema:sqlite`（SQLite 版是自动生成的产物，勿手改）
5. 改了文风相关 → 只改三处真源（文风配置页 / `config/style_dna.json` / `writer.ts` SYSTEM_PROMPT），不硬编码文案
6. 更新 `docs/DEVLOG.md`（做了什么）与 `CHANGELOG.md`（使用者可感知的变更）

## 代码约定

- **相对 import 必须带 `.ts` 后缀**（Node 不会把 `./a.js` 解析成 `a.ts`）
- strip-types 不支持参数属性（constructor 里的 `private x` 写法）
- 不引入编译步骤；类型检查靠 `npm run typecheck`
- 前端不用 wangEditor；主色 `#0a7c47` 与 `--wb-*` 令牌体系保持稳定
- 错误统一走 `errors.ts` 的 `AppError` 体系，async 路由必须 `asyncHandler` 包裹

## 不可破坏的红线

1. **`AUTO_PUBLISH = false` 永远为 false**——系统只写草稿箱，绝不出现 masssend/群发调用。任何“自动发给粉丝”的 PR 不会被合并
2. **凭据加密**：AppSecret / API Key 只能 AES-256-GCM 加密落库，API 只回掩码
3. **鉴权默认全拦**：`/api/*` 公开项只有 `/health` 与 `/auth/*`
4. **归属隔离**：新增路由/查询凡涉及公众号账号或文章，必须过 `services/ownership.ts` 的归属判定（admin 全量 / member 对己 / 未归属仅 admin），防水平越权

## 报告 bug / 安全问题

- 一般 bug：开 issue，附复现步骤、期望与实际行为、环境（Node 版本、数据库）
- 安全问题：**不要开公开 issue**，见 [`SECURITY.md`](SECURITY.md)

## 关键文档

| 文档 | 内容 |
| --- | --- |
| `README.md` | 定位、硬约束、命令、业务规则 |
| `docs/DEVLOG.md` | 进度台账（唯一真源） |
| `docs/PRODUCT-PLAN.md` | 产品与架构方案 |
| `docs/WRITING-GUIDE.md` | 写作方法论 |
| `SECURITY.md` | 安全红线与检查清单 |
