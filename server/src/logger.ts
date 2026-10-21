/**
 * 结构化日志。
 *
 * 本机流水线完全没有日志落盘（var/logs 是空目录），出问题只能靠人主动问。
 * 这里补上：控制台 + 文件双写，文件按天归档。
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import pino from 'pino';

import { BASE_DIR, IS_PROD, NODE_ENV } from './config.ts';
import { todayKey } from './lib/day.ts';

/**
 * Windows 控制台默认代码页是 GBK(936)。pino-pretty 经 worker 线程以 UTF-8 字节写管道到控制台，
 * 会被按 GBK 解读导致中文乱码（如「服务已启动」变成乱码）。启动时切到 UTF-8 代码页(65001)即可修复。
 * 仅 Windows 生效；Linux/macOS 用 UTF-8 无此问题，直接跳过。失败（非交互/无 chcp）则忽略，降级为原样输出。
 */
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
}

function logDir(): string {
  const d = join(BASE_DIR, 'var', 'logs');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function dayStamp(): string {
  return todayKey();
}

const fileDest = pino.destination({
  dest: join(logDir(), `app-${dayStamp()}.log`),
  sync: false,
  append: true,
});

/**
 * 控制台目的地：
 * - 真终端（isTTY）下用 pino-pretty 美化——本地时间 + 颜色 + 级别标签 + 单行，方便肉眼阅读；
 * - 管道 / 生产（非 TTY）下回落为裸 JSON，避免 ANSI 转义污染日志采集（journald / 文件重定向）。
 * 文件目的地始终保持 JSON，便于后续按字段检索与聚合。
 */
const consoleDest = process.stdout.isTTY
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        colorize: true,
        singleLine: true,
      },
    })
  : process.stdout;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (IS_PROD ? 'info' : 'debug'),
    base: { env: NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: consoleDest, level: 'debug' },
    { stream: fileDest, level: 'debug' },
  ]),
);

/** 任务级日志：把 stage / context 固化进每条记录，便于事后按任务追踪。 */
export function taskLogger(taskRunId: number | null) {
  return logger.child({ taskRunId });
}
