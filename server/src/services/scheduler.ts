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
import { COMIC_IMAGE } from '../config.ts';
import { LOCK_COMIC_IMAGE, LOCK_PLAN, LOCK_TIMEOUT_SEC } from '../constants.ts';
import { logger } from '../logger.ts';
import { packJson } from '../db-json.ts';
import { dayKeyOf, todayKey } from '../lib/day.ts';
import { getPipelineQuota, isPipelineEnabled, PIPELINES } from './pipeline.ts';
import { runPipelineForAccount } from './planner.ts';
import { processComicImages } from './comic/panels.ts';
import { pushArticleToDraft } from './publisher.ts';

/** 调度相关设置键。值以字符串存 Setting.v（与现有约定一致）。
 *  P4 后：scheduler_enabled 仍是**全局总开关**；scheduler_write_time/scheduler_push_enabled
 *  降级为「无主账号（ownerUserId=null）」的兜底值 + 旧配置兼容，每用户看 User.automationMode/writeTime。 */
const K_ENABLED = 'scheduler_enabled';
const K_WRITE_TIME = 'scheduler_write_time';
const K_PUSH_ENABLED = 'scheduler_push_enabled';

const DEFAULT_WRITE_TIME = '06:00';

/** 合法的 HH:mm（小时 00-23、分钟 00-59）。仅校验 `\d{2}:\d{2}` 会把 25:99 这类值放行，导致永不触发。 */
export const WRITE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 每客户自动化模式（P4）。群发红线 AUTO_PUBLISH 与本开关解耦，永不动。 */
export type AutomationMode = 'manual' | 'auto_draft' | 'auto_draft_push';

export const AUTOMATION_MODES: AutomationMode[] = ['manual', 'auto_draft', 'auto_draft_push'];

export const AUTOMATION_MODE_LABEL: Record<AutomationMode, string> = {
  manual: '纯手动（只手动出稿/推送）',
  auto_draft: '自动写稿（到点入库，人工审后手动推）',
  auto_draft_push: '自动写稿 + 自动推草稿箱（全自动）',
};

/** 校验并归一化 automation_mode。非法值一律回落 manual（最安全）。 */
export function normalizeAutomationMode(v: string | null | undefined): AutomationMode {
  return (AUTOMATION_MODES as string[]).includes(v ?? '') ? (v as AutomationMode) : 'manual';
}

export interface SchedulerConfig {
  /** 全局总开关（Setting.scheduler_enabled）。关了谁的 mode 都不动。 */
  enabled: boolean;
  /** 无主账号（ownerUserId=null）的兜底写稿时间点。每用户看 User.writeTime。 */
  writeTime: string;
  /** 无主账号的兜底是否级联推送。每用户看 User.automationMode。 */
  pushEnabled: boolean;
}

function todayStr(): string {
  return todayKey();
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
  pipeline: 'article' | 'comic';
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
  /** 阶段二（漫画生图）推进摘要；本轮没跑漫画时为 null。 */
  comic: {
    done: number;
    failed: number;
    /** 退避窗口内跳过、留给后续心跳的格数。 */
    skipped: number;
    /** 本次心跳内实际推进的轮数（受 COMIC_TICK_BUDGET_MS 预算约束）。 */
    rounds: number;
  } | null;
}

/** 查询当前可排产账号（已启用且凭据就绪）。 */
async function listReadyAccounts() {
  return prisma.oAAccount.findMany({
    where: { enabled: true, credStatus: 'ok' },
    include: { track: true },
    orderBy: { id: 'asc' },
  });
}

/** 各账号各产线今日已产数（配额幂等判断），key = `${accountId}:${pipeline}`。 */
async function todayPipelineCounts(accountIds: number[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (accountIds.length === 0) return map;
  const today = todayStr();
  const rows = await prisma.article.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, pipeline: true, createdAt: true },
  });
  for (const r of rows) {
    if (r.accountId == null) continue;
    if (dayKeyOf(r.createdAt) !== today) continue;
    const k = `${r.accountId}:${r.pipeline}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

/**
 * 每账号的自动化口径（P4 核心）：按账号 owner 查 User.automationMode/writeTime；
 * 无主账号（ownerUserId=null，历史/冒烟）回落旧 Setting 三键（enabled+push_enabled 推导 mode）。
 */
export async function resolveAutomationForAccounts(
  accounts: Array<{ id: number; ownerUserId: number | null }>,
): Promise<Map<number, { mode: AutomationMode; writeTime: string }>> {
  const out = new Map<number, { mode: AutomationMode; writeTime: string }>();
  const ownerIds = [...new Set(accounts.map((a) => a.ownerUserId).filter((x): x is number => x != null))];
  const users = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, automationMode: true, writeTime: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u] as const));
  const legacy = await getSchedulerConfig();
  for (const a of accounts) {
    const u = a.ownerUserId != null ? byId.get(a.ownerUserId) : undefined;
    if (u) {
      out.set(a.id, {
        mode: normalizeAutomationMode(u.automationMode),
        writeTime: WRITE_TIME_RE.test(u.writeTime ?? '') ? u.writeTime : DEFAULT_WRITE_TIME,
      });
    } else {
      // 无主账号：旧语义兜底（enabled 已在外层总开关判过，这里推导 push 与否）
      out.set(a.id, {
        mode: legacy.pushEnabled ? 'auto_draft_push' : 'auto_draft',
        writeTime: legacy.writeTime,
      });
    }
  }
  return out;
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
    comic: null,
  };

  if (!cfg.enabled && !force) {
    return { ...base, reason: '调度未启用（scheduler_enabled=0）' };
  }

  const accounts = await listReadyAccounts();
  if (accounts.length === 0) {
    await logRun('warn', 'scheduler', '无可排产账号（需已启用且凭据状态 ok）');
    return { ...base, due: true, reason: '无可排产账号（请先在凭据配置完成并连通测试）' };
  }

  // P4：每账号按 owner 的 automation_mode/writeTime 分流（单进程 tick 服务全部用户）。
  const automation = await resolveAutomationForAccounts(accounts);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // 产线维度 targets：外层账号、内层产线（PIPELINES 顺序）→ 同一账号先文章后漫画。
  // manual 的账号不进 targets（纯手动）；auto_draft/auto_draft_push 都自动写稿。
  const counts = await todayPipelineCounts(accounts.map((a) => a.id));
  const targets: { accountId: number; account: string; pipeline: 'article' | 'comic'; push: boolean }[] = [];
  let anyDue = false;
  for (const a of accounts) {
    const auto = automation.get(a.id) ?? { mode: 'manual' as AutomationMode, writeTime: DEFAULT_WRITE_TIME };
    if (auto.mode === 'manual') continue;
    const due = force || nowMinutes >= parseHm(auto.writeTime);
    if (!due) continue;
    anyDue = true;
    for (const kind of PIPELINES) {
      if (!(await isPipelineEnabled(a.trackId, kind))) continue;
      const quota = await getPipelineQuota(a.trackId, kind);
      if ((counts.get(`${a.id}:${kind}`) ?? 0) < quota) {
        targets.push({
          accountId: a.id,
          account: a.name,
          pipeline: kind,
          push: auto.mode === 'auto_draft_push',
        });
      }
    }
  }
  if (targets.length === 0) {
    return {
      ...base,
      due: anyDue,
      reason: anyDue
        ? '今日配额已满（所有到点账号均已产出当日篇数）'
        : '无到点的自动化账号（manual 不参与，或各账号未到自己的写稿时间）',
    };
  }

  const run = await withLock(LOCK_PLAN, LOCK_TIMEOUT_SEC, async () => {
    const wrote: TickWritten[] = [];
    const pushed: TickPushed[] = [];

    logger.info({ count: targets.length }, '开始排产（含产线）');
    await logRun('info', 'scheduler', `开始排产，目标 ${targets.length} 项`, {
      targets: targets.map((t) => `${t.account}:${t.pipeline}`),
    });

    // 阶段一（锁内）：只产稿件 —— article 全流程；comic 只写脚本（生图慢，放阶段二）。
    for (const t of targets) {
      try {
        const res = await runPipelineForAccount(t.accountId, t.pipeline);
        wrote.push({
          accountId: t.accountId,
          account: t.account,
          pipeline: t.pipeline,
          need: res.need,
          created: res.created.length,
          reason: res.reason,
        });
        logger.info({ account: t.account, pipeline: t.pipeline, created: res.created.length, reason: res.reason }, '产稿完成');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        wrote.push({ accountId: t.accountId, account: t.account, pipeline: t.pipeline, need: 0, created: 0, reason: `产稿失败：${msg}` });
        await logRun('error', 'scheduler', `账号「${t.account}」产稿失败（${t.pipeline}）：${msg}`);
      }
    }

    // 推送（P4）：只对 mode=auto_draft_push 的账号推（per-account 分流，替代旧全局 pushEnabled）。
    // 只推 contentWechat 非空的（漫画半成品自动跳过，不刷错误）。
    const pushAccIds = [...new Set(targets.filter((t) => t.push).map((t) => t.accountId))];
    if (pushAccIds.length > 0) {
      const today = todayStr();
      const pending = await prisma.article.findMany({
        where: { status: 'draft', accountId: { in: pushAccIds } },
        orderBy: { id: 'asc' },
      });
      const todays = pending.filter((x) => dayKeyOf(x.createdAt) === today && !!x.contentWechat);
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

  // 阶段二（锁外）：推进漫画格生图（慢任务，独立锁；幂等，无待处理格时为 no-op）。
  //
  // 时间预算：单次心跳最多烧 COMIC_TICK_BUDGET_MS（默认 4 分钟）。生图 30~40s/格，
  // 一篇 6 格靠一轮推进不完，靠「多轮 + 行级状态机」续跑，而不是把心跳拖成几分钟的长事务；
  // 预算用完就交还控制权，剩下的格下次心跳接着做（ComicPanel.status 本身就是队列）。
  let comic: TickResult['comic'] = null;
  if (targets.some((t) => t.pipeline === 'comic')) {
    const startedAt = Date.now();
    comic = await withLock(LOCK_COMIC_IMAGE, LOCK_TIMEOUT_SEC, async () => {
      const acc = { done: 0, failed: 0, skipped: 0, rounds: 0 };
      for (;;) {
        const r = await processComicImages();
        acc.rounds += 1;
        acc.done += r.done;
        acc.failed += r.failed;
        acc.skipped += r.skipped;
        // 本轮一格都没推进（没有待处理格，或全部处于退避窗口）即停，避免空转。
        if (r.done + r.failed === 0) break;
        if (Date.now() - startedAt >= COMIC_IMAGE.tickBudgetMs) {
          logger.info({ ...acc }, '漫画生图达到本次心跳时间预算，剩余格留给下次心跳');
          break;
        }
      }
      return acc;
    });
    if (comic === null) {
      logger.info('漫画生图推进未获得锁（已有任务在跑）');
    } else {
      logger.info({ ...comic }, '漫画生图推进完成');
    }
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
