/**
 * 用户管理（admin 专属，P2）。开放注册 + 管理员审批的后台面。
 *
 * - GET /             用户列表（含账号占用数）
 * - POST /:id/approve 审批通过（pending → active，默认升 member）
 * - PATCH /:id        改 role / status / expiresAt / maxOAAccounts
 * - POST /:id/logout-all 吊销该用户全部会话（改密/封禁后用）
 *
 * 预留「订阅付费自动开通」口子：届时由支付回调调 approve/改 expiresAt，不走本路由。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { destroyUserSessions } from '../../services/auth.ts';
import { asyncHandler } from '../async-handler.ts';
import { requirePermission } from '../permissions.ts';

export const usersRouter: Router = Router();

usersRouter.use(requirePermission('users:manage'));

const idSchema = z.coerce.number().int().positive();

const patchSchema = z
  .object({
    role: z.enum(['admin', 'member', 'guest']).optional(),
    status: z.enum(['pending', 'active', 'disabled']).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    maxOAAccounts: z.number().int().min(0).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有要修改的字段' });

/** 用户列表。附带每人已绑公众号数，便于审批时看配额。 */
usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        expiresAt: true,
        maxOAAccounts: true,
        createdAt: true,
        _count: { select: { oaAccounts: true } },
      },
    });
    res.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        status: u.status,
        expiresAt: u.expiresAt,
        maxOAAccounts: u.maxOAAccounts,
        createdAt: u.createdAt,
        oaAccountCount: u._count.oaAccounts,
      })),
    });
  }),
);

/** 审批：pending → active，角色默认升 member（客户）。已 active 则幂等返回。 */
usersRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('用户不存在');
    if (user.status === 'disabled') throw new BadRequestError('已停用账号请先改状态再审批');
    const updated = await prisma.user.update({
      where: { id },
      data: {
        status: 'active',
        role: user.role === 'guest' ? 'member' : user.role,
      },
      select: { id: true, username: true, role: true, status: true },
    });
    res.json({ ok: true, user: updated });
  }),
);

/** 改用户属性。降级/封禁时顺手吊销会话，避免改了角色还挂着旧会话。 */
usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const patch = patchSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('用户不存在');
    const data: Record<string, unknown> = {};
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.expiresAt !== undefined) {
      data.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt);
    }
    if (patch.maxOAAccounts !== undefined) data.maxOAAccounts = patch.maxOAAccounts;
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, username: true, role: true, status: true, expiresAt: true, maxOAAccounts: true },
    });
    if (patch.status === 'disabled' || patch.role !== undefined) {
      await destroyUserSessions(id);
    }
    res.json({ ok: true, user: updated });
  }),
);

/** 吊销该用户全部会话。 */
usersRouter.post(
  '/:id/logout-all',
  asyncHandler(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('用户不存在');
    await destroyUserSessions(id);
    res.json({ ok: true });
  }),
);
