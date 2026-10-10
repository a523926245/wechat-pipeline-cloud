/**
 * 调度守护进程 CLI。
 *
 * 用法：
 *   node --experimental-strip-types src/cli/scheduler.ts            # 常驻轮询（默认 60s 心跳）
 *   node --experimental-strip-types src/cli/scheduler.ts --once     # 执行一次后退出（配合 cron/systemd Timer）
 *   node --experimental-strip-types src/cli/scheduler.ts --interval 30
 *   node --experimental-strip-types src/cli/scheduler.ts --once --force   # 忽略开关与到点，立即补跑
 *
 * 说明：调度是否真的干活，由 Setting 里的 scheduler_enabled / scheduler_write_time /
 * scheduler_push_enabled 决定（见 services/scheduler.ts）。本进程只负责「按时叫醒并检查」。
 * 并行期默认 scheduler_push_enabled=0，即 dry-run 不真推，符合项目硬约束。
 */

import { startScheduler, tick, getSchedulerConfig, getSchedulerStatus } from '../services/scheduler.ts';
import { logger } from '../logger.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const force = args.includes('--force');
  const intervalArg = (() => {
    const i = args.indexOf('--interval');
    if (i < 0) return null;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v >= 5 ? v : null;
  })();

  const cfg = await getSchedulerConfig();
  logger.info({ cfg }, '调度配置已载入');
  console.log('调度配置：', { enabled: cfg.enabled, writeTime: cfg.writeTime, pushEnabled: cfg.pushEnabled });

  if (once) {
    const result = await tick(force);
    console.log('单次心跳结果：', {
      date: result.date,
      due: result.due,
      reason: result.reason ?? null,
      wrote: result.wrote.map((w) => ({ 账号: w.account, 需求: w.need, 产出: w.created, 原因: w.reason ?? null })),
      pushed: result.pushed,
    });
    await new Promise<void>((r) => setTimeout(r, 100)); // 让日志刷出
    process.exit(0);
  }

  if (!cfg.enabled) {
    console.log('注意：scheduler_enabled=0，定时器已启动但不会执行任何动作，直到你在配置里启用。');
  }

  startScheduler((intervalArg ?? 60) * 1000);
  const st = getSchedulerStatus();
  console.log(`调度常驻已启动：每 ${st.intervalMs / 1000}s 心跳一次，Ctrl+C 退出。`);

  const shutdown = (sig: string) => {
    logger.info(`收到 ${sig}，调度退出`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error({ err: e }, '调度进程异常');
  console.error(e);
  process.exit(1);
});
