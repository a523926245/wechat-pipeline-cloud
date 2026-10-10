import { startServer } from './app.ts';
import { ensureContentDirs } from './config.ts';
import { logger } from './logger.ts';

ensureContentDirs();
startServer();

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '未处理的 Promise 拒绝');
});
