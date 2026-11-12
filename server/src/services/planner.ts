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
import { dayKeyOf, dayKeyOffset, todayKey } from '../lib/day.ts';
import { getPipelineQuota, isPipelineEnabled, PIPELINES, scopesFor, type AngleScope, type PipelineKind } from './pipeline.ts';
import { tryResolveForRole } from './llm.ts';
import { generateDraft } from './writer.ts';
import { parseArticle } from './parse/index.ts';
import { renderArticle } from './render/index.ts';
import { createComicDraft } from './comic/write.ts';
import { kickComicImages } from './comic/panels.ts';

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
  /** 产线（article / comic）。同一账号同一天可能出现在两个任务里。 */
  pipeline: PipelineKind;
  need: number;
  alreadyToday: number;
  /** 本账号本产线的配额（前端别再用 perDay[trackId] 反查）。 */
  perDay: number;
  angles: PlanAngle[];
  /** 赛道角度池真实余量（未用且未被今日文章占用），与赛道管理页口径一致。 */
  stock: number;
  short: number;
  avoid: { date: string; title: string }[];
}

export interface PlanResult {
  date: string;
  /** key = `${trackId}:${pipeline}`（产线维度后的新口径）。 */
  perDay: Record<string, number>;
  tasks: PlanTask[];
  skipped: { track: string; account: string; reason: string }[];
  warnings: string[];
  backlog: { date: string; account: string; got: number; miss: number }[];
}

function todayStr(): string {
  return todayKey();
}

/** 某账号某产线今日已建数（按 createdAt 落在今天统计，与排产配额对齐）。 */
async function todayPipelineCount(accountId: number, pipeline: PipelineKind): Promise<number> {
  const today = todayStr();
  const rows = await prisma.article.findMany({
    where: { accountId, pipeline },
    select: { createdAt: true },
  });
  return rows.filter((r) => dayKeyOf(r.createdAt) === today).length;
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
    if (r.angleId != null && dayKeyOf(r.createdAt) === today) ids.add(r.angleId);
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
  // P3 归属过滤（高危点：本函数是 dashboard 与 /api/plan 双消费者，两处调用都必须传）
  ownerUserId?: number | null,
): Promise<PlanResult> {
  const accWhere = ownerUserId != null ? { ownerUserId } : {};
  const tracks = await prisma.track.findMany({
    include: {
      accounts: { where: accWhere, orderBy: { name: 'asc' } },
      angles: { where: { used: false }, orderBy: { seq: 'asc' } },
      articles: { orderBy: { createdAt: 'desc' }, take: 8, select: { createdAt: true, title: true } },
      pipelines: true,
    },
  });

  const date = todayStr();
  const tasks: PlanTask[] = [];
  const skipped: PlanResult['skipped'] = [];
  const warnings: string[] = [];
  const perDay: Record<string, number> = {};

  // 近作（供写稿观点层去重）。蓝本只取最近 8 条避免上下文过长。
  const recentByTrack = new Map<number, { date: string; title: string }[]>();
  for (const t of tracks) {
    recentByTrack.set(
      t.id,
      t.articles.map((a) => ({ date: dayKeyOf(a.createdAt), title: a.title })),
    );
  }

  const usedAngleByTrack = new Map<number, Set<number>>();
  for (const t of tracks) usedAngleByTrack.set(t.id, await todayUsedAngleIds(t.id));

  for (const t of tracks) {
    const usableAccs = t.accounts.filter((a) => a.enabled && a.credStatus === 'ok');
    for (const a of t.accounts) {
      if (a.enabled && a.credStatus === 'ok') continue;
      skipped.push({ track: t.name, account: a.name, reason: CRED_STATUS_REASON[a.credStatus] ?? a.credStatus });
    }
    if (targetAccount) {
      for (const a of usableAccs.filter((x) => x.name !== targetAccount)) {
        skipped.push({ track: t.name, account: a.name, reason: '非目标账号（--account 过滤）' });
      }
    }
    if (usableAccs.length === 0) continue;

    // 产线维度：article 先、comic 后（PIPELINES 顺序即执行顺序）。
    for (const kind of PIPELINES) {
      const enabled = await isPipelineEnabled(t.id, kind);
      const quota = await getPipelineQuota(t.id, kind);
      perDay[`${t.id}:${kind}`] = quota;
      if (!enabled || quota <= 0) continue;

      const scopes = scopesFor(kind);
      const poolFree = t.angles.filter(
        (a) => scopes.includes(a.scope as AngleScope) && !(usedAngleByTrack.get(t.id)?.has(a.id) ?? false),
      );

      for (const acc of usableAccs.filter((a) => !targetAccount || a.name === targetAccount)) {
        const already = await todayPipelineCount(acc.id, kind);
        const need = Math.max(0, quota - already);
        const picked: PlanAngle[] = [];
        let short = 0;
        for (let i = 0; i < need; i++) {
          const a = poolFree.shift();
          if (!a) {
            short += 1;
            continue;
          }
          picked.push({ id: a.id, theme: a.theme, angle: a.content });
        }
        if (short > 0) {
          warnings.push(`[${t.name}][${kind === 'comic' ? '漫画' : '文章'}][${acc.name}] 角度不足，缺 ${short} 篇——请补充角度库`);
        }
        const burn = quota * usableAccs.length;
        const days = burn > 0 ? Math.floor(poolFree.length / burn) : 0;
        if (days <= 10) {
          warnings.push(
            `[${t.name}][${kind === 'comic' ? '漫画' : '文章'}] 角度库存告急：剩 ${poolFree.length} 个，按 ${burn} 篇/天仅够约 ${days} 天。请先扩库再创作`,
          );
        }
        tasks.push({
          track: t.name,
          trackId: t.id,
          account: acc.name,
          accountId: acc.id,
          pipeline: kind,
          need,
          alreadyToday: already,
          perDay: quota,
          angles: picked,
          stock: poolFree.length,
          short,
          avoid: recentByTrack.get(t.id) ?? [],
        });
      }
    }
  }

  const backlog = await scanBacklog(tasks, tracks, backlogDays);

  // 各产线所需角色不可用时提前预警：不拦截排产（文章仍可出骨架草稿），让用户在触发前就知道结果。
  const roleChecks: Array<{ role: 'write' | 'comic_script' | 'comic_panel'; label: string }> = [
    { role: 'write', label: '写作' },
    { role: 'comic_script', label: '漫画脚本' },
    { role: 'comic_panel', label: '漫画格' },
  ];
  for (const { role, label } of roleChecks) {
    const res = await tryResolveForRole(role);
    if (!res.usable && res.reason) {
      warnings.push(`「${label}」角色未就绪：${res.reason}——请先到「模型配置」添加模型并绑定该角色`);
    }
  }

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
  // 产线维度的配额表：key = `${trackId}|${pipeline}`
  const quotaByKey = new Map<string, number>(tasks.map((t) => [`${t.trackId}|${t.pipeline}`, t.perDay]));

  // 每个账号首个文章日（用于 floor 下限）
  const firstSeen = new Map<number, string>();
  const done = new Map<string, number>(); // `${date}|${accountId}|${pipeline}` -> count
  const all = await prisma.article.findMany({
    where: { accountId: { in: usableAccs } },
    select: { accountId: true, createdAt: true, pipeline: true },
  });
  for (const r of all) {
    if (r.accountId == null) continue;
    const d = dayKeyOf(r.createdAt);
    const prev = firstSeen.get(r.accountId);
    if (prev === undefined || d < prev) firstSeen.set(r.accountId, d);
    if (d !== todayStr()) {
      const k = `${d}|${r.accountId}|${r.pipeline}`;
      done.set(k, (done.get(k) ?? 0) + 1);
    }
  }

  const out: PlanResult['backlog'] = [];
  for (let i = days; i >= 1; i--) {
    const d = dayKeyOffset(-i);
    for (const t of tasks) {
      const floor = firstSeen.get(t.accountId);
      if (floor && d < floor) continue; // 该账号当时还没上线
      const got = done.get(`${d}|${t.accountId}|${t.pipeline}`) ?? 0;
      const quota = quotaByKey.get(`${t.trackId}|${t.pipeline}`) ?? 0;
      if (got < quota) out.push({ date: d, account: t.account, got, miss: quota - got });
    }
  }
  return out;
}

/**
 * 为指定账号在指定产线的角度切片里预留 need 个未用角度（事务内 CAS：先读未用池，再标记 used）。
 * article 消费 [article, shared]，comic 消费 [comic, shared]；used 全局先到先得。
 */
export async function reserveAnglesForPipeline(
  accountId: number,
  need: number,
  pipeline: PipelineKind,
): Promise<Angle[]> {
  if (need <= 0) return [];
  return prisma.$transaction(async (tx) => {
    const acc = await tx.oAAccount.findUnique({ where: { id: accountId }, include: { track: true } });
    if (!acc) throw new NotFoundError(`账号 ${accountId} 不存在`);
    const today = todayStr();
    const pool = await tx.angle.findMany({
      where: { trackId: acc.trackId, used: false, scope: { in: scopesFor(pipeline) } },
      orderBy: { seq: 'asc' },
      take: need,
    });
    const ids = pool.map((a) => a.id);
    if (ids.length > 0) {
      await tx.angle.updateMany({
        where: { id: { in: ids } },
        // P3：结构化归属（usedBy 保留作展示标签）——跨客户防重复的「谁抢到归谁」标记
        data: {
          used: true,
          usedBy: acc.name,
          usedDate: today,
          usedById: acc.ownerUserId,
          usedByAccountId: acc.id,
        },
      });
    }
    return pool;
  });
}

/** @deprecated 兼容旧调用方：等价于文章产线的角度预留。 */
export async function reserveAnglesForAccount(accountId: number, need: number): Promise<Angle[]> {
  return reserveAnglesForPipeline(accountId, need, 'article');
}

export interface TriggerResult {
  accountId: number;
  account: string;
  need: number;
  created: Array<{ id: number; title: string; angleId: number; modelUsed: string | null; note: string }>;
  reason?: string;
}

/**
 * 手动/调度触发：为账号跑一条产线，生成草稿。
 * article → LLM 写作（可回退骨架）；comic → 漫画脚本 + 待生图格行。
 * count 显式指定则忽略今日配额。
 */
export async function runPipelineForAccount(
  accountId: number,
  pipeline: PipelineKind,
  count?: number,
): Promise<TriggerResult> {
  const acc = await prisma.oAAccount.findUnique({ where: { id: accountId }, include: { track: true } });
  if (!acc) throw new NotFoundError(`账号 ${accountId} 不存在`);

  const already = await todayPipelineCount(accountId, pipeline);
  const quota = await getPipelineQuota(acc.trackId, pipeline);
  let need = count != null ? count : Math.max(0, quota - already);
  if (need <= 0) {
    return { accountId, account: acc.name, need: 0, created: [], reason: '今日配额已满' };
  }

  const reserved = await reserveAnglesForPipeline(accountId, need, pipeline);
  if (reserved.length === 0) {
    // 跨赛道错配诊断：报错只说「扩库」会让人扩错赛道的题（2026-11-11 实测踩过：
    // 题在【育儿】、账号在【星座】，用户以为扩完就能写）。把话说全。
    const others = await prisma.angle.findMany({
      where: { used: false, trackId: { not: acc.trackId } },
      select: { track: { select: { name: true } } },
    });
    const byTrack = new Map<string, number>();
    for (const o of others) byTrack.set(o.track.name, (byTrack.get(o.track.name) ?? 0) + 1);
    const otherText = [...byTrack.entries()].map(([n, c]) => `【${n}】${c} 条`).join('、');
    const kindText = pipeline === 'comic' ? '漫画' : '文章';
    const reason =
      `角度池已空：账号「${acc.name}」属【${acc.track.name}】赛道，该赛道没有可用的${kindText}选题。` +
      (byTrack.size > 0
        ? `注意：未用选题在 ${otherText} ——那是别的赛道的池子，本账号吃不到。请给【${acc.track.name}】扩库（${kindText}切片），或把账号改绑到对应赛道。`
        : '请先到「赛道管理 → 选题库」给该赛道扩库。');
    return { accountId, account: acc.name, need, created: [], reason };
  }

  const created: TriggerResult['created'] = [];

  if (pipeline === 'comic') {
    for (const angle of reserved) {
      try {
        const r = await createComicDraft(acc, angle, acc.track);
        // 建稿即开跑插图（后台逐格推进，不阻塞本次触发）：用户打的是「生成漫画」，
        // 交出去的应该是能预览的成品，而不是一份还要自己再去点一次生图的脚本。
        kickComicImages(r.articleId);
        created.push({ id: r.articleId, title: r.title, angleId: angle.id, modelUsed: null, note: `已建 ${r.unitCount} 格分镜，插图生成中（可在文章页看进度）` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        created.push({ id: 0, title: angle.content, angleId: angle.id, modelUsed: null, note: `漫画脚本失败：${msg.slice(0, 160)}` });
      }
    }
    await prisma.taskRun.create({
      data: {
        jobType: 'comic_script',
        status: 'success',
        trigger: 'manual',
        trackId: acc.trackId,
        accountId: acc.id,
        runDate: todayStr(),
        attempt: 1,
        paramsJson: packJson({ accountId, pipeline, count: count ?? null, need: reserved.length }),
        resultJson: packJson({ createdIds: created.map((c) => c.id).filter(Boolean) }),
      },
    });
    return { accountId, account: acc.name, need: reserved.length, created };
  }

  const titlePrefix = await getTitlePrefix();

  for (const angle of reserved) {
    const draft = await generateDraft(angle, acc.track, acc);
    const parsed = parseArticle(draft.contentHtml);
    const rendered = renderArticle(parsed, { titlePrefix });
    const article = await prisma.article.create({
      data: {
        trackId: acc.trackId,
        accountId: acc.id,
        angleId: angle.id,
        pipeline: 'article',
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
      paramsJson: packJson({ accountId, pipeline, count: count ?? null, need: reserved.length }),
      resultJson: packJson({ createdIds: created.map((c) => c.id), modelUsed: created[0]?.modelUsed ?? null }),
    },
  });

  return { accountId, account: acc.name, need: reserved.length, created };
}

/** @deprecated 兼容旧调用方：等价于文章产线触发。 */
export async function createDraftsForAccount(accountId: number, count?: number): Promise<TriggerResult> {
  return runPipelineForAccount(accountId, 'article', count);
}

async function getTitlePrefix(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { k: 'title_prefix' } });
  const v = s?.v ?? '【话】';
  return typeof v === 'string' ? v : '【话】';
}
