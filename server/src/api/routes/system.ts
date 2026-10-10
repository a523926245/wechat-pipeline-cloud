/**
 * 系统级路由：健康检查、版本信息。
 */

import { Router } from 'express';

import { AUTO_PUBLISH } from '../../constants.ts';
import { IS_SQLITE, NODE_ENV } from '../../config.ts';
import { checkDb } from '../../db.ts';
import { asyncHandler } from '../async-handler.ts';

export const systemRouter: Router = Router();

systemRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const db = await checkDb();
    res.json({
      ok: db,
      env: NODE_ENV,
      db: db ? 'up' : 'down',
      driver: IS_SQLITE ? 'sqlite' : 'mysql',
      // 暴露出来是为了让运维一眼确认红线没被打开
      autoPublish: AUTO_PUBLISH,
      time: new Date().toISOString(),
    });
  }),
);

systemRouter.get('/version', (_req, res) => {
  res.json({ name: 'wechat-pipeline-cloud', node: process.version });
});
