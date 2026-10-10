/**
 * 自动调度服务（阶段 5）。
 *
 * 职责：按配置在每天的写稿时间点触发「排产 → 生成草稿」，可选级联推送草稿箱。
 *
 * 与本机 06:00 定时的差异（也是迁移动机之一）：
 *   - 本机依赖 WorkBuddy 客户端常驻，关机即跳过且不补跑；
 *     云端由 Node 进程内的定时器驱动，服务在就一定会跑，并有 lock 防重入。
 *
 * 幂等设计（重要）：
 *   - 不靠「今天跑过没」这种易错的标记，而是复用 **当日配额**：
 *     某账号当日已产文章数 >= 赛道 quotaPerDay 时，createDraftsForAccount 会直接返回
 *     「今日配额已满」且不产生任何副作用。所以反复 tick 天然安全、可重复执行。
 *
 * 安全红线：
 *   - 并行期默认 **dry-run 不真推**：`scheduler_push_enabled` 默认 false；
 *   - 推送只到草稿箱（复用 publisher.pushArticleToDraft），不存在任何群发路径。
 */

import { prisma } from '../db.ts';
import { withLock } from '../db.ts';
import { LOCK_PLAN, LOCK_TIMEOUT_SEC } from '../constants.ts';
import { logger } from '../logger.ts';
import { packJson } from '../db-json.ts';
import { createDraftsForAccount } from './planner.ts';
import { pushArticleToDraft } from './publisher.ts';

/** 调度相关设置键。值以字符串存 Setting.v（与现有约定一致）。 */
const K_ENABLED = 'scheduler_enabled';
const K_WRITE_TIME = 'scheduler_write_time';
const K_PUSH_ENABLED = 'scheduler_push_enabled';

const DEFAULT_WRITE_TIME = '06:00';

/** 合法的 HH:mm（小时 00-23、分钟 00-59）。仅校验 `\d{2}:\d{2}` 会把 25:99 这类值放行，导致永不触发。 */
export const WRITE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SchedulerConfig {
  enabled: boolean;
  /** 每日写稿时间点，HH:mm（服务器本地时区）。 */
  writeTime: string;
  /** 是否级联推送草稿箱。并行期默认 false（dry-run）。 */
  pushEnabled: boolean;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 读取设置，缺失时返回内置默认值（不自动落库，避免读操作产生副作用）。 */
async function readSetting(k: string): Promise<string | null> {
  const s = await prisma.setting.findUnique({ where: { k } });
  return s?.v ?? null;
}

export async function getSchedulerConfig(): Promise<SchedulerConfig> {
  const [enabled, writeTime, pushEnabled] = await Promise.all([
    readSetting(K_ENABLED),
    readSetting(K_WRITE_TIME),
    readSetting(K_PUSH_ENABLED),
  ]);
  return {
    enabled: enabled === '1',
    writeTime: WRITE_TIME_RE.test(writeTime ?? '') ? (writeTime as string) : DEFAULT_WRITE_TIME,
    pushEnabled: pushEnabled === '1',
  };
}

export async function setSchedulerConfig(patch: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
  const writes: Array<[string, string]> = [];
  if (patch.enabled !== undefined) writes.push([K_ENABLED, patch.enabled ? '1' : '0']);
  if (patch.pushEnabled !== undefined) writes.push([K_PUSH_ENABLED, patch.pushEnabled ? '1' : '0']);
  if (patch.writeTime !== undefined) {
    if (!WRITE_TIME_RE.test(patch.writeTime)) {
      throw new Error(`写稿时间非法（应为 00-23:00-59 的 HH:mm）：${patch.writeTime}`);
    }
    writes.push([K_WRITE_TIME, patch.writeTime]);
  }

  for (const [k, v] of writes) {
    await prisma.setting.upsert({
      where: { k },
      create: { k, v, kind: 'string', desc: SCHEDULER_SETTING_DESC[k] ?? '' },
      update: { v },
    });
  }
  return getSchedulerConfig();
}

const SCHEDULER_SETTING_DESC: Record<string, string> = {
  [K_ENABLED]: '自动调度总开关（1=启用）',
  [K_WRITE_TIME]: '每日写稿触发时间 HH:mm',
  [K_PUSH_ENABLED]: '是否在写稿后级联推送草稿箱（并行期建议 0）',
};

/** 把 HH:mm 解析成当日分钟数。 */
function parseHm(hm: string): number {
  const [h, m] = hm.split(':');
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return Number.NaN;
  return hh * 60 + mm;
}

export interface TickWritten {
  accountId: number;
  account: string;
  need: number;
  created: number;
  reason?: string;
}

export interface TickPushed {
  articleId: number;
  ok: boolean;
  message: string;
}

export interface TickResult {
  date: string;
  at: string;
  due: boolean;
  enabled: boolean;
  reason?: string;
  wrote: TickWritten[];
  pushed: TickPushed[];
}

/** 查询当前可排产账号（已启用且凭据就绪）。 */
async function listReadyAccounts() {
  return prisma.account.findMany({
    where: { enabled: true, credStatus: 'ok' },
    include: { track: true },
    orderBy: { id: 'asc' },
  });
}

/** 各账号今日已产文章数（用于配额幂等判断，避免无意义调用写稿）。 */
async function todayCounts(accountIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (accountIds.length === 0) return map;
  const today = todayStr();
  const rows = await prisma.article.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, createdAt: true },
  });
  for (const r of rows) {
    if (r.accountId == null) continue;
    if (r.createdAt.toISOString().slice(0, 10) !== today) continue;
    map.set(r.accountId, (map.get(r.accountId) ?? 0) + 1);
  }
  return map;
}

/** 写一条运行日志到库，便于仪表盘查看最近动态。 */
async function logRun(level: 'info' | 'warn' | 'error', stage: string, message: string, ctx?: unknown): Promise<void> {
  try {
    await prisma.runLog.create({
      data: {
        level,
        stage,
        message: message.slice(0, 2000),
        contextJson: ctx === undefined ? null : packJson(ctx),
      },
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, '运行日志落库失败（忽略）');
  }
}

/**
 * 单次调度心跳：判断是否到点并执行。可重复调用（幂等）。
 * force=true 时**同时绕过「是否启用」与「是否到点」**（用于立即补跑/测试），
 * 但仍受配额限制，且只会作用于已启用且凭据 ok 的账号。
 */
export async function tick(force = false): Promise<TickResult> {
  const cfg = await getSchedulerConfig();
  const now = new Date();
  const base: TickResult = {
    date: todayStr(),
    at: now.toISOString(),
    due: false,
    enabled: cfg.enabled,
    wrote: [],
    pushed: [],
  };

  if (!cfg.enabled && !force) {
    return { ...base, reason: '调度未启用（scheduler_enabled=0）' };
  }

  const dueMinutes = parseHm(cfg.writeTime);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const due = force || nowMinutes >= dueMinutes;
  if (!due) {
    return { ...base, reason: `未到写稿时间（${cfg.writeTime}）` };
  }

  const accounts = await listReadyAccounts();
  if (accounts.length === 0) {
    await logRun('warn', 'scheduler', '无可排产账号（需已启用且凭据状态 ok）');
    return { ...base, due: true, reason: '无可排产账号（请先在凭据配置完成并连通测试）' };
  }

  const counts = await todayCounts(accounts.map((a) => a.id));
  const targets = accounts.filter((a) => (counts.get(a.id) ?? 0) < a.track.quotaPerDay);
  if (targets.length === 0) {
    return { ...base, due: true, reason: '今日配额已满（所有账号均已产出当日篇数）' };
  }

  const run = await withLock(LOCK_PLAN, LOCK_TIMEOUT_SEC, async () => {
    const wrote: TickWritten[] = [];
    const pushed: TickPushed[] = [];

    logger.info({ count: targets.length }, '开始写稿');
    await logRun('info', 'scheduler', `开始写稿，目标账号 ${targets.length} 个`, {
      accounts: targets.map((a) => a.name),
    });

    for (const a of targets) {
      try {
        const res = await createDraftsForAccount(a.id);
        wrote.push({
          accountId: a.id,
          account: a.name,
          need: res.need,
          created: res.created.length,
          reason: res.reason,
        });
        logger.info({ account: a.name, created: res.created.length, reason: res.reason }, '写稿完成');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        wrote.push({ accountId: a.id, account: a.name, need: 0, created: 0, reason: `写稿失败：${msg}` });
        await logRun('error', 'scheduler', `账号「${a.name}」写稿失败：${msg}`);
      }
    }

    if (cfg.pushEnabled) {
      const today = todayStr();
      const pending = await prisma.article.findMany({
        where: { status: 'draft', accountId: { in: targets.map((a) => a.id) } },
        orderBy: { id: 'asc' },
      });
      const todays = pending.filter((x) => x.createdAt.toISOString().slice(0, 10) === today);
      for (const art of todays) {
        // 推送失败不中断后续文章（publisher 内部已收敛为 ok:false）
        const r = await pushArticleToDraft(art.id);
        pushed.push({ articleId: art.id, ok: r.ok, message: r.message });
      }
      if (todays.length > 0) {
        await logRun('info', 'scheduler', `推送草稿箱 ${todays.length} 篇`, { pushed });
      }
    }

    return { wrote, pushed };
  });

  if (run === null) {
    return { ...base, due: true, reason: '已有调度任务在执行（未获得锁，本次跳过）' };
  }

  return { ...base, due: true, wrote: run.wrote, pushed: run.pushed };
}

// ── 进程内定时器 ────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let lastTick: TickResult | null = null;
let intervalMs = 60_000;

/** 启动定时器。重复调用不会叠加多个定时器。 */
export function startScheduler(ms = 60_000): boolean {
  if (timer) return false;
  intervalMs = ms;
  timer = setInterval(() => {
    tick()
      .then((r) => {
        lastTick = r;
        if (r.reason && (r.wrote.length > 0 || r.pushed.length > 0)) {
          logger.info({ reason: r.reason }, '调度心跳');
        }
      })
      .catch((e) => logger.error({ err: e }, '调度心跳异常'));
  }, intervalMs);
  // 避免定时器阻止进程退出
  timer.unref?.();
  logger.info({ intervalMs }, '自动调度已启动');
  return true;
}

export function stopScheduler(): boolean {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  logger.info('自动调度已停止');
  return true;
}

export function getSchedulerStatus(): {
  running: boolean;
  intervalMs: number;
  lastTick: TickResult | null;
} {
  return { running: timer !== null, intervalMs, lastTick };
}

/** 立即执行一次（绕过开关与到点判断），返回本次结果。 */
export async function runNow(): Promise<TickResult> {
  const r = await tick(true);
  lastTick = r;
  return r;
}
