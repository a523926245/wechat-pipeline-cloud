/**
 * Express 应用装配。
 */

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';

import { PORT } from './config.ts';
import { AppError } from './errors.ts';
import { logger } from './logger.ts';
import { systemRouter } from './api/routes/system.ts';
import { credentialsRouter } from './api/routes/credentials.ts';
import { articlesRouter } from './api/routes/articles.ts';
import { modelsRouter } from './api/routes/models.ts';
import { plansRouter } from './api/routes/plans.ts';
import { emphasisRouter } from './api/routes/emphasis.ts';
import { schedulerRouter } from './api/routes/scheduler.ts';
import { dashboardRouter } from './api/routes/dashboard.ts';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.use('/api', systemRouter);
  app.use('/api/credentials', credentialsRouter);
  app.use('/api/articles', articlesRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/plan', plansRouter);
  app.use('/api/emphasize', emphasisRouter);
  app.use('/api/scheduler', schedulerRouter);
  app.use('/api/dashboard', dashboardRouter);

  // 未知路由
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
  });

  // 统一错误处理：最后一环，必须放在所有路由之后
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // 参数校验失败应给 400（客户端问题），不能落到 500 内部错误里
    if (err instanceof ZodError) {
      const first = err.issues[0];
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: first ? `${first.path.join('.') || '请求参数'}：${first.message}` : '请求参数校验失败',
          detail: err.issues,
        },
      });
      return;
    }
    if (err instanceof AppError) {
      logger.warn({ code: err.code, status: err.status }, err.message);
      res.status(err.status).json({
        error: { code: err.code, message: err.message, detail: err.detail },
      });
      return;
    }
    logger.error({ err }, '未处理异常');
    res.status(500).json({
      error: { code: 'internal_error', message: err instanceof Error ? err.message : '服务器内部错误' },
    });
  });

  return app;
}

export function startServer() {
  const app = createApp();
  const server = app.listen(PORT, () => {
    logger.info(`服务已启动 http://localhost:${PORT}  (pid ${process.pid})`);
  });

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，正在关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}
