/**
 * 仪表盘路由：给前端「一眼看清系统状态」的聚合数据。
 * 各区块内部已容错降级（见 services/dashboard.ts），接口基本不会 500。
 */

import { Router } from 'express';

import { asyncHandler } from '../async-handler.ts';
import { getDashboard, getSystemStatus } from '../../services/dashboard.ts';

const dashboardRouter = Router();

/** 轻量状态：模型绑定 + 健康，供全局侧边栏常驻显示（不拉排产/动态等重区块）。 */
dashboardRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await getSystemStatus());
  }),
);

dashboardRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await getDashboard();
    res.json(data);
  }),
);

export { dashboardRouter };
