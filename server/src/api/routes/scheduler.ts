/**
 * 调度路由：查看/修改调度配置，手动心跳，启停进程内定时器。
 *
 * 注意：`POST /tick` 的 force 会绕过「是否启用/是否到点」，属于人工立即补跑入口；
 * 即便如此也不会突破配额限制（到期或已满配额的账号自动跳过），符合幂等设计。
 */

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../async-handler.ts';
import { requirePermission, principalOf } from '../permissions.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { prisma } from '../../db.ts';
import { isAdmin, requirePrincipal } from '../../services/ownership.ts';
import {
  AUTOMATION_MODES,
  AUTOMATION_MODE_LABEL,
  WRITE_TIME_RE,
  getSchedulerConfig,
  getSchedulerStatus,
  setSchedulerConfig,
  startScheduler,
  stopScheduler,
  tick,
} from '../../services/scheduler.ts';

const schedulerRouter = Router();

// P2 RBAC：改自己的自动化=automation:manage；tick/start/stop 是全局动作=admin
schedulerRouter.use((req, res, next) => {
  const p = req.path;
  if (req.method === 'POST' && (p === '/tick' || p === '/start' || p === '/stop')) {
    return requirePermission('system:manage')(req, res, next);
  }
  return requirePermission('automation:manage')(req, res, next);
});

/**
 * P4 配置体：
 *   automationMode/writeTime = **每客户**开关（写 User 行，member 只能改自己的）；
 *   enabled/pushEnabled      = 全局（Setting）——仅 admin 可动（总开关 + 无主账号兜底）。
 */
const configSchema = z
  .object({
    automationMode: z.enum(['manual', 'auto_draft', 'auto_draft_push']).optional(),
    writeTime: z
      .string()
      .regex(WRITE_TIME_RE, '写稿时间非法，应为 00-23:00-59 的 HH:mm')
      .optional(),
    enabled: z.boolean().optional(),
    pushEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个待修改字段' });

/** 当前状态：全局开关 + **我的**每用户自动化配置 + 运行态。 */
schedulerRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const [config, status] = await Promise.all([getSchedulerConfig(), Promise.resolve(getSchedulerStatus())]);
    // 我的自动化配置（admin 令牌/冒烟主体 userId=null → 演示全局兜底值）
    const me =
      principal.userId != null
        ? await prisma.user.findUnique({
            where: { id: principal.userId },
            select: { automationMode: true, writeTime: true },
          })
        : null;
    res.json({
      running: status.running,
      intervalMs: status.intervalMs,
      config,
      my: {
        automationMode: me?.automationMode ?? (config.pushEnabled ? 'auto_draft_push' : 'auto_draft'),
        writeTime: me?.writeTime ?? config.writeTime,
      },
      modeOptions: AUTOMATION_MODES.map((m) => ({ value: m, label: AUTOMATION_MODE_LABEL[m] })),
      lastTick: status.lastTick,
    });
  }),
);

/** 修改配置：automationMode/writeTime 写 User 行（每客户）；enabled/pushEnabled 写全局（仅 admin）。 */
schedulerRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const patch = configSchema.parse(req.body);
    const globalPatch: Record<string, unknown> = {};
    if (patch.enabled !== undefined) globalPatch.enabled = patch.enabled;
    if (patch.pushEnabled !== undefined) globalPatch.pushEnabled = patch.pushEnabled;
    if (Object.keys(globalPatch).length > 0 && !isAdmin(principal)) {
      throw new BadRequestError('全局调度开关仅管理员可改');
    }

    // 每用户配置（member 改自己的；admin 也改自己的 User 行——break-glass 主体无 User 行则跳过）
    if ((patch.automationMode !== undefined || patch.writeTime !== undefined) && principal.userId != null) {
      const data: Record<string, unknown> = {};
      if (patch.automationMode !== undefined) data.automationMode = patch.automationMode;
      if (patch.writeTime !== undefined) data.writeTime = patch.writeTime;
      const me = await prisma.user.findUnique({ where: { id: principal.userId }, select: { id: true } });
      if (!me) throw new NotFoundError('用户不存在');
      await prisma.user.update({ where: { id: principal.userId }, data });
    }

    try {
      if (Object.keys(globalPatch).length > 0) await setSchedulerConfig(globalPatch);
    } catch (e) {
      throw new BadRequestError(e instanceof Error ? e.message : String(e));
    }

    const config = await getSchedulerConfig();
    const me =
      principal.userId != null
        ? await prisma.user.findUnique({
            where: { id: principal.userId },
            select: { automationMode: true, writeTime: true },
          })
        : null;
    res.json({
      ok: true,
      config,
      my: {
        automationMode: me?.automationMode ?? (config.pushEnabled ? 'auto_draft_push' : 'auto_draft'),
        writeTime: me?.writeTime ?? config.writeTime,
      },
    });
  }),
);

/**
 * 手动心跳一次。force=1 时立即补跑（绕过开关与到点判断）。
 * 配额已满 / 无就绪账号时返回 reason，不产生副作用。
 */
schedulerRouter.post(
  '/tick',
  asyncHandler(async (req, res) => {
    const force = req.body?.force === true || req.query.force === '1';
    const result = await tick(force);
    res.json({ ok: true, result });
  }),
);

schedulerRouter.post(
  '/start',
  asyncHandler(async (req, res) => {
    const ms = Number(req.query.intervalMs ?? req.body?.intervalMs ?? 60_000);
    const intervalMs = Number.isFinite(ms) && ms >= 5_000 ? ms : 60_000;
    const started = startScheduler(intervalMs);
    res.json({ ok: true, started, intervalMs, message: started ? '已启动' : '已在运行中' });
  }),
);

schedulerRouter.post(
  '/stop',
  asyncHandler(async (_req, res) => {
    const stopped = stopScheduler();
    res.json({ ok: true, stopped, message: stopped ? '已停止' : '未在运行' });
  }),
);

export { schedulerRouter };
