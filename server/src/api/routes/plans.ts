/**
 * 创作计划路由：产出今日排产计划 + 手动触发建稿。
 *
 * 与蓝本一致的规则：
 * - 只有 credStatus==='ok' 且启用的账号才会排进计划；
 * - 手动触发时由 planner 在事务内预留角度（CAS），避免同日重复选题；
 * - 写作用「write」角色绑定的模型，无密钥回退骨架草稿，流水线不断。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { assertAccountAccess, isAdmin, requirePrincipal } from '../../services/ownership.ts';
import { asyncHandler } from '../async-handler.ts';
import { requirePermission } from '../permissions.ts';
import { NotFoundError } from '../../errors.ts';
import { buildPlan, runPipelineForAccount } from '../../services/planner.ts';

const plansRouter = Router();

// P2 RBAC：看计划=data:view，手动触发排产=content:generate
plansRouter.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'data:view' : 'content:generate';
  return requirePermission(perm)(req, res, next);
});

const triggerSchema = z.object({
  accountId: z.number().int().positive(),
  count: z.number().int().min(1).max(20).optional(),
  /** 产线（缺省 article，兼容旧前端）。 */
  pipeline: z.enum(['article', 'comic']).optional(),
});

/** 今日创作计划（只排产，不建稿）。 */
plansRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const target = typeof req.query.account === 'string' ? req.query.account : undefined;
    const backlogDays = req.query.backlogDays ? Number(req.query.backlogDays) : 3;
    const principal = requirePrincipal(req);
    const plan = await buildPlan(
      target,
      Number.isFinite(backlogDays) ? backlogDays : 3,
      isAdmin(principal) ? null : principal.userId,
    );
    res.json(plan);
  }),
);

/** 手动触发：为某账号生成草稿文章（预留角度 + 写作 + 落库）。 */
plansRouter.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    const body = triggerSchema.parse(req.body);
    const acc = await prisma.oAAccount.findUnique({ where: { id: body.accountId } });
    assertAccountAccess(requirePrincipal(req), acc, body.accountId);
    if (!acc) throw new NotFoundError(`账号 ${body.accountId} 不存在`);

    const result = await runPipelineForAccount(body.accountId, body.pipeline ?? 'article', body.count);

    res.status(200).json({
      ok: result.created.length > 0,
      accountId: result.accountId,
      account: result.account,
      need: result.need,
      created: result.created,
      reason: result.reason ?? null,
      message:
        result.created.length > 0
          ? `已为「${result.account}」生成 ${result.created.length} 篇草稿`
          : result.reason ?? '未生成',
    });
  }),
);

export { plansRouter };
