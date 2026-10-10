/**
 * 仪表盘路由：给前端「一眼看清系统状态」的聚合数据。
 * 各区块内部已容错降级（见 services/dashboard.ts），接口基本不会 500。
 */

import { Router } from 'express';

import { asyncHandler } from '../async-handler.ts';
import { getDashboard } from '../../services/dashboard.ts';

const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await getDashboard();
    res.json(data);
  }),
);

export { dashboardRouter };
