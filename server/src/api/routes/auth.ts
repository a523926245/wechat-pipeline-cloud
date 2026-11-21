/**
 * 鉴权路由（P2 多用户版）：注册 / 登录 / 登出 / 状态。这四个端点公开（guard 放行 /auth/*）。
 *
 * - 注册开放 + 管理员审批：`POST /register` 建 guest/pending 用户，审批走 /api/users（admin）。
 * - 登录成功种 httpOnly cookie `wb_session`（只存 session id，服务端查库可吊销）。
 * - 管理令牌已退场（2026-11-11）：不再有 { token } 登录分支，口令是唯一登录方式；
 *   忘记口令用 `npm run seed:admin -- --reset-pass`。
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  createSession,
  destroySession,
  effectiveRole,
  hashPassword,
  principalFromRequest,
  verifyPassword,
} from '../../services/auth.ts';
import { prisma } from '../../db.ts';
import { BadRequestError, UnauthorizedError } from '../../errors.ts';
import { asyncHandler } from '../async-handler.ts';

export const authRouter: Router = Router();

/** 注册口：用户名严格 ASCII（账号名不允许中文——2026-11-11 勘误，曾错误放宽过）。 */
const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(64)
  .regex(/^[a-zA-Z0-9_\-@.]+$/, '用户名只能含字母/数字/_-@.');

/** 登录口：不做字符集限制（存量中文用户名仍能登录，不锁死旧账号），只校验长度。 */
const loginUsernameSchema = z.string().trim().min(1).max(64);

const passwordSchema = z.string().min(8, '口令至少 8 个字符').max(256);

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

/** 登录口令：不套注册的 min(8)——老账号/短口令要能登录（长度规则只约束新注册）。 */
const loginPasswordSchema = z.string().min(1).max(256);

const loginSchema = z.object({
  username: loginUsernameSchema,
  password: loginPasswordSchema,
});

/** 公开：是否需要登录、当前身份概要。不泄露口令/令牌。 */
authRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const principal = await principalFromRequest(req as never);
    res.json({
      authRequired: true,
      loggedIn: principal !== null,
      user: principal
        ? {
            id: principal.userId,
            username: principal.username,
            // 有效角色：expiresAt 过期已降只读（UI 菜单按此显隐，与后端权限口径一致）
            role: effectiveRole(principal),
            rawRole: principal.role,
            status: principal.status,
            expiresAt: principal.expiresAt,
            via: principal.via,
          }
        : null,
    });
  }),
);

/** 公开：开放注册（默认 guest + pending，等管理员审批）。预留「订阅付费自动开通」口子。 */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, password } = registerSchema.parse(req.body);
    const dup = await prisma.user.findUnique({ where: { username } });
    if (dup) throw new BadRequestError('用户名已被占用');
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        role: 'guest',
        status: 'pending',
      },
      select: { id: true, username: true, role: true, status: true },
    });
    res.status(201).json({ ok: true, user });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedError('用户名或口令不正确');
    }
    if (user.status === 'disabled') {
      throw new UnauthorizedError('账号已被停用');
    }
    // pending 可登录但只有只读（guest 权限），由 permissions 的 effectiveRole 控制；
    // 这里放行登录是为了让用户能看到「等待审批」状态而不是被挡在门外。
    const sid = await createSession(user.id);
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, role: user.role, status: user.status },
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const sid = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    await destroySession(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  }),
);
