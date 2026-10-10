/**
 * 结构化日志。
 *
 * 本机流水线完全没有日志落盘（var/logs 是空目录），出问题只能靠人主动问。
 * 这里补上：控制台 + 文件双写，文件按天归档。
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino from 'pino';

import { BASE_DIR, IS_PROD, NODE_ENV } from './config.ts';

function logDir(): string {
  const d = join(BASE_DIR, 'var', 'logs');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const fileDest = pino.destination({
  dest: join(logDir(), `app-${dayStamp()}.log`),
  sync: false,
  append: true,
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (IS_PROD ? 'info' : 'debug'),
    base: { env: NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stdout, level: 'debug' },
    { stream: fileDest, level: 'debug' },
  ]),
);

/** 任务级日志：把 stage / context 固化进每条记录，便于事后按任务追踪。 */
export function taskLogger(taskRunId: number | null) {
  return logger.child({ taskRunId });
}
