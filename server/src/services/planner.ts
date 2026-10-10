/**
 * 选题规划器（移植自本机 daily_plan.py）。
 *
 * 职责：回答「今天该给哪个号写哪几篇、要避开什么」，本身不写稿。
 * 写稿交给 writer.ts，推送交给 articles 路由。
 *
 * 与蓝本一致的关键规则：
 * - 只有 credStatus==='ok' 且启用的账号才排产
 * - 同赛道多账号共享赛道级角度池，取一个少一个（预留用事务保证 CAS）
 * - 每账号每天 quotaPerDay 篇，当天已写的不再重复排
 * - 给出该赛道近作供写稿时做观点层去重
 */

import type { Angle } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { prisma } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import { packJson } from '../db-json.ts';
import { generateDraft } from './writer.ts';
import { parseArticle } from './parse/index.ts';
import { renderArticle } from './render/index.ts';

export interface PlanAngle {
  id: number;
  theme: string;
  angle: string;
}

export interface PlanTask {
  track: string;
  trackId: number;
  account: string;
  accountId: number;
  need: number;
  alreadyToday: number;
  angles: PlanAngle[];
  short: number;
  avoid: { date: string; title: string }[];
}

export interface PlanResult {
  date: string;
  perDay: Record<number, number>;
  tasks: PlanTask[];
  skipped: { track: string; account: string; reason: string }[];
  warnings: string[];
  backlog: { date: string; account: string; got: number; miss: number }[];
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 某账号今日已建文章数（按 createdAt 落在今天统计，与排产配额对齐）。 */
async function todayArticleCount(accountId: number): Promise<number> {
  const today = todayStr();
  const rows = await prisma.article.findMany({
    where: { accountId },
    select: { createdAt: true },
  });
  return rows.filter((r) => r.createdAt.toISOString().slice(0, 10) === today).length;
}

/** 某赛道今天已被占用的角度 id 集合（避免同日重复选题）。 */
async function todayUsedAngleIds(trackId: number): Promise<Set<number>> {
  const today = todayStr();
  const rows = await prisma.article.findMany({
    where: { trackId, angleId: { not: null } },
    select: { angleId: true, createdAt: true },
  });
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.angleId != null && r.createdAt.toISOString().slice(0, 10) === today) ids.add(r.angleId);
  }
  return ids;
}

const CRED_STATUS_REASON: Record<string, string> = {
  ok: '已就绪',
  placeholder: '仍是占位凭据',
  invalid: '凭据格式不合规',
  missing: '凭据未配置',
};

export async function buildPlan(
  targetAccount?: string,
  backlogDays = 3,
): Promise<PlanResult> {
  const tracks = await prisma.track.findMany({
    include: {
      accounts: { orderBy: { name: 'asc' } },
      angles: { where: { used: false }, orderBy: { seq: 'asc' } },
      articles: { orderBy: { createdAt: 'desc' }, take: 8, select: { createdAt: true, title: true } },
    },
  });

  const date = todayStr();
  const tasks: PlanTask[] = [];
  const skipped: PlanResult['skipped'] = [];
  const warnings: string[] = [];
  const perDay: Record<number, number> = {};

  // 近作（供写稿观点层去重）。蓝本只取最近 8 条避免上下文过长。
  const recentByTrack = new Map<number, { date: string; title: string }[]>();
  for (const t of tracks) {
    recentByTrack.set(
      t.id,
      t.articles.map((a) => ({ date: a.createdAt.toISOString().slice(0, 10), title: a.title })),
    );
  }

  const usedAngleByTrack = new Map<number, Set<number>>();
  for (const t of tracks) usedAngleByTrack.set(t.id, await todayUsedAngleIds(t.id));

  for (const t of tracks) {
    perDay[t.id] = t.quotaPerDay;
    const poolFree = t.angles.filter((a) => !(usedAngleByTrack.get(t.id)?.has(a.id) ?? false));

    const usableAccs = t.accounts.filter((a) => a.enabled && a.credStatus === 'ok');
    for (const a of t.accounts) {
      if (a.enabled && a.credStatus === 'ok') continue;
      skipped.push({ track: t.name, account: a.name, reason: CRED_STATUS_REASON[a.credStatus] ?? a.credStatus });
    }
    if (targetAccount) {
      // 只看指定账号：从可用里筛，其余转入 skipped
      for (const a of usableAccs.filter((x) => x.name !== targetAccount)) {
        skipped.push({ track: t.name, account: a.name, reason: '非目标账号（--account 过滤）' });
      }
    }

    const pool = poolFree.slice(); // 共享池，跨账号取一个少一个
    const accs = targetAccount ? usableAccs.filter((a) => a.name === targetAccount) : usableAccs;

    for (const acc of accs) {
      const already = await todayArticleCount(acc.id);
      const need = Math.max(0, t.quotaPerDay - already);
      const picked: PlanAngle[] = [];
      let short = 0;
      for (let i = 0; i < need; i++) {
        const a = pool.shift();
        if (!a) {
          short += 1;
          continue;
        }
        picked.push({ id: a.id, theme: a.theme, angle: a.content });
      }
      if (short > 0) {
        warnings.push(`[${t.name}][${acc.name}] 角度不足，缺 ${short} 篇——请补充角度库`);
      }
      if (usableAccs.length > 0) {
        const burn = t.quotaPerDay * usableAccs.length;
        const days = burn > 0 ? Math.floor(poolFree.length / burn) : 0;
        if (days <= 10) {
          warnings.push(
            `[${t.name}] 角度库存告急：剩 ${poolFree.length} 个，按 ${burn} 篇/天仅够约 ${days} 天。请先扩库再创作`,
          );
        }
      }
      tasks.push({
        track: t.name,
        trackId: t.id,
        account: acc.name,
        accountId: acc.id,
        need,
        alreadyToday: already,
        angles: picked,
        short,
        avoid: recentByTrack.get(t.id) ?? [],
      });
    }
  }

  const backlog = await scanBacklog(tasks, tracks, backlogDays);

  return { date, perDay, tasks, skipped, warnings, backlog };
}

/**
 * 回扫最近 days 天（不含今天），找出当天没写满配额的账号日期组合。
 * 仅统计账号「首个文章日」之后的日期，避免把流水线启用前的日子误报成漏跑。
 */
async function scanBacklog(
  tasks: PlanTask[],
  tracks: { id: number; quotaPerDay: number }[],
  days: number,
): Promise<PlanResult['backlog']> {
  if (days <= 0 || tasks.length === 0) return [];
  const usableAccs = tasks.map((t) => t.accountId);
  const quotaByTrack = new Map(tracks.map((t) => [t.id, t.quotaPerDay]));

  // 每个账号首个文章日（用于 floor 下限）
  const firstSeen = new Map<number, string>();
  const done = new Map<string, number>(); // `${date}|${accountId}` -> count
  const all = await prisma.article.findMany({
    where: { accountId: { in: usableAccs } },
    select: { accountId: true, createdAt: true },
  });
  for (const r of all) {
    if (r.accountId == null) continue;
    const d = r.createdAt.toISOString().slice(0, 10);
    const prev = firstSeen.get(r.accountId);
    if (prev === undefined || d < prev) firstSeen.set(r.accountId, d);
    if (d !== todayStr()) {
      const k = `${d}|${r.accountId}`;
      done.set(k, (done.get(k) ?? 0) + 1);
    }
  }

  const out: PlanResult['backlog'] = [];
  const today = new Date();
  for (let i = days; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    for (const t of tasks) {
      const floor = firstSeen.get(t.accountId);
      if (floor && d < floor) continue; // 该账号当时还没上线
      const got = done.get(`${d}|${t.accountId}`) ?? 0;
      const quota = quotaByTrack.get(t.trackId) ?? 2;
      if (got < quota) out.push({ date: d, account: t.account, got, miss: quota - got });
    }
  }
  return out;
}

/**
 * 为指定账号预留 need 个未用角度（事务内 CAS：先读未用池，再标记 used）。
 * 返回被预留的角度列表。
 */
export async function reserveAnglesForAccount(accountId: number, need: number): Promise<Angle[]> {
  if (need <= 0) return [];
  return prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUnique({ where: { id: accountId }, include: { track: true } });
    if (!acc) throw new NotFoundError(`账号 ${accountId} 不存在`);
    const today = todayStr();
    const pool = await tx.angle.findMany({
      where: { trackId: acc.trackId, used: false },
      orderBy: { seq: 'asc' },
      take: need,
    });
    const ids = pool.map((a) => a.id);
    if (ids.length > 0) {
      await tx.angle.updateMany({
        where: { id: { in: ids } },
        data: { used: true, usedBy: acc.name, usedDate: today },
      });
    }
    return pool;
  });
}

export interface TriggerResult {
  accountId: number;
  account: string;
  need: number;
  created: Array<{ id: number; title: string; angleId: number; modelUsed: string | null; note: string }>;
  reason?: string;
}

/** 手动触发：为账号生成草稿文章。count 显式指定则忽略今日配额。 */
export async function createDraftsForAccount(accountId: number, count?: number): Promise<TriggerResult> {
  const acc = await prisma.account.findUnique({ where: { id: accountId }, include: { track: true } });
  if (!acc) throw new NotFoundError(`账号 ${accountId} 不存在`);

  const already = await todayArticleCount(accountId);
  const quota = acc.track.quotaPerDay;
  let need = count != null ? count : Math.max(0, quota - already);
  if (need <= 0) {
    return { accountId, account: acc.name, need: 0, created: [], reason: '今日配额已满' };
  }

  const reserved = await reserveAnglesForAccount(accountId, need);
  if (reserved.length === 0) {
    return { accountId, account: acc.name, need, created: [], reason: '角度池已空，请先扩库' };
  }

  const titlePrefix = await getTitlePrefix();
  const created: TriggerResult['created'] = [];

  for (const angle of reserved) {
    const draft = await generateDraft(angle, acc.track, acc);
    const parsed = parseArticle(draft.contentHtml);
    const rendered = renderArticle(parsed, { titlePrefix });
    const article = await prisma.article.create({
      data: {
        trackId: acc.trackId,
        accountId: acc.id,
        angleId: angle.id,
        title: rendered.title,
        digest: rendered.digest,
        contentHtml: draft.contentHtml,
        contentWechat: rendered.contentWechat,
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        pushDate: '',
        status: 'draft',
        idempotencyKey: randomUUID(),
      },
    });
    created.push({
      id: article.id,
      title: article.title,
      angleId: angle.id,
      modelUsed: draft.modelUsed,
      note: draft.note,
    });
  }

  await prisma.taskRun.create({
    data: {
      jobType: 'write',
      status: 'success',
      trigger: 'manual',
      trackId: acc.trackId,
      accountId: acc.id,
      runDate: todayStr(),
      attempt: 1,
      paramsJson: packJson({ accountId, count: count ?? null, need: reserved.length }),
      resultJson: packJson({ createdIds: created.map((c) => c.id), modelUsed: created[0]?.modelUsed ?? null }),
    },
  });

  return { accountId, account: acc.name, need: reserved.length, created };
}

async function getTitlePrefix(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { k: 'title_prefix' } });
  const v = s?.v ?? '【话】';
  return typeof v === 'string' ? v : '【话】';
}
