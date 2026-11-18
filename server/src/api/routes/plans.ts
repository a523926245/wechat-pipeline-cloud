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

    // 结果语义（S5-UI-5-P1）：ok 只看真实创建的文章，不把失败/跳过算成功。
    const succeeded = result.created.length;
    const failed = result.failed.length;
    const skipped = result.skipped;
    let message: string;
    if (succeeded > 0 && failed === 0) {
      message = `已为「${result.account}」生成 ${succeeded} 篇草稿`;
    } else if (succeeded > 0 && failed > 0) {
      message = `已为「${result.account}」生成 ${succeeded} 篇草稿，${failed} 篇失败`;
    } else if (failed > 0) {
      message = `本批 ${failed} 篇建稿失败，未生成草稿：${result.failed.map((f) => f.note).join('；').slice(0, 200)}`;
    } else {
      // 无成功、无失败：全部跳过（配额满 / 无可消费选题），用后端给出的真实原因。
      message = result.reason ?? '本批未生成草稿（无可排产选题）';
    }
    res.status(200).json({
      ok: succeeded > 0,
      accountId: result.accountId,
      account: result.account,
      need: result.need,
      created: result.created,
      failed: result.failed,
      skipped,
      reason: result.reason ?? null,
      message,
    });
  }),
);

export { plansRouter };
