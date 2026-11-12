# 安全策略（SECURITY）

## 红线（代码层硬保证，改动前请先读）

1. **永不群发**：`server/src/constants.ts` 的 `AUTO_PUBLISH = false` 是硬常量。
   系统只写草稿、最多推到公众号**草稿箱**（`addDraft`），代码里不存在任何
   `masssend`/群发调用路径。任何让文章自动发给粉丝的改动都属于破坏性变更，
   必须显式讨论，不允许顺手打开。
2. **凭据加密**：微信 AppSecret、LLM API Key 一律 AES-256-GCM 加密入库
   （`secretEnc`/`apiKeyEnc`），API 只回掩码。主密钥来自 `APP_SECRET_KEY`，
   **一旦有数据写入就不能更换**（换钥前必须先解密迁移）。
3. **鉴权默认全拦**：`/api/*` 默认 401，公开项只有 `/api/health` 与 `/api/auth/*`。
   登录=口令+服务端会话（httpOnly cookie）；**无令牌后门**（管理令牌机制已于 2026-11-11 移除）。
   冒烟旁路 `SMOKE_NO_AUTH=1` 仅非 production 生效。

## 多用户与数据隔离（2026-11 起）

- 角色：`admin`（全权+用户管理）/ `member`（客户：只管自己的公众号账号、自动化、数据）/
  `guest`（只读）。
- 归属隔离：`OAAccount.ownerUserId`；文章/运营数据经账号归属过滤。
  水平越权防护见 `server/src/services/ownership.ts`（入口层过滤 + 服务层兜底双层）。
- 未归属账号（`ownerUserId = NULL`）仅 admin 可管。
- 注册开放 + 管理员审批（pending→active）；`expiresAt` 到期降只读。

## 汇报安全问题

请**不要**开公开 issue，直接联系维护者（见 README 联系方式）或提私密安全通告。
请附：影响范围、复现步骤、建议修复。确认后会在修复发布时致谢（如你愿意署名）。

## 部署安全检查清单

- [ ] `app.env` 权限 600，含数据库口令与 `APP_SECRET_KEY`
- [ ] 生产走 HTTPS（nginx TLS），cookie 为 httpOnly + sameSite=lax
- [ ] 生产机**不跑** `schema:sqlite`/`sqlite:generate`（会覆盖 MySQL client）
- [ ] 数据库账号仅本机/内网可连，禁用 root 远程
- [ ] 管理员口令强且唯一；忘口令救济只走服务器 CLI（`npm run seed:admin -- --reset-pass`）
- [ ] 定期备份 `dev.db`/MySQL（删账号会级联删文章，备份是唯一后悔药）
