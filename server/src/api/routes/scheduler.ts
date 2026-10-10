/**
 * 调度路由：查看/修改调度配置，手动心跳，启停进程内定时器。
 *
 * 注意：`POST /tick` 的 force 会绕过「是否启用/是否到点」，属于人工立即补跑入口；
 * 即便如此也不会突破配额限制（到期或已满配额的账号自动跳过），符合幂等设计。
 */

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../async-handler.ts';
import { BadRequestError } from '../../errors.ts';
import {
  WRITE_TIME_RE,
  getSchedulerConfig,
  getSchedulerStatus,
  setSchedulerConfig,
  startScheduler,
  stopScheduler,
  tick,
} from '../../services/scheduler.ts';

const schedulerRouter = Router();

const configSchema = z
  .object({
    enabled: z.boolean().optional(),
    writeTime: z
      .string()
      .regex(WRITE_TIME_RE, '写稿时间非法，应为 00-23:00-59 的 HH:mm')
      .optional(),
    pushEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个待修改字段' });

/** 当前状态：是否运行 + 配置 + 上次心跳结果。 */
schedulerRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [config, status] = await Promise.all([getSchedulerConfig(), Promise.resolve(getSchedulerStatus())]);
    res.json({
      running: status.running,
      intervalMs: status.intervalMs,
      config,
      lastTick: status.lastTick,
    });
  }),
);

/** 修改配置（写回 Setting 表）。 */
schedulerRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    const patch = configSchema.parse(req.body);
    try {
      const config = await setSchedulerConfig(patch);
      res.json({ ok: true, config });
    } catch (e) {
      throw new BadRequestError(e instanceof Error ? e.message : String(e));
    }
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
