/**
 * 仪表盘聚合服务（阶段 5）。
 *
 * 目标：一个接口给前端提供「系统现在健康吗、今天出够了吗、最近干了什么」。
 *
 * 设计原则：
 *   - **局部容错**：每个区块单独 try/catch，任一数据源出问题只降级该区块，
 *     不会让整个 /api/dashboard 变成 500（仪表盘应该永远打得开）。
 *   - 排产口径与 planner.buildPlan 完全一致，避免「界面显示」与「实际调度」算法分叉。
 */

import { AUTO_PUBLISH } from '../constants.ts';
import { prisma, checkDb } from '../db.ts';
import { requireMasterKey } from '../config.ts';
import { logger } from '../logger.ts';
import { buildPlan } from './planner.ts';
import { getSchedulerConfig } from './scheduler.ts';

export interface DashboardData {
  generatedAt: string;
  date: string;
  counts: {
    tracks: number;
    accounts: { total: number; enabled: number; ready: number };
    angles: { total: number; unused: number; used: number; usageRate: number };
    articles: { total: number; today: number; draft: number; pushed: number; failed: number };
  };
  today: {
    quotaTotal: number;
    produced: number;
    pending: number;
    byAccount: Array<{
      accountId: number;
      account: string;
      track: string;
      quota: number;
      produced: number;
      pending: number;
      angleStock: number;
    }>;
  };
  backlog: Array<{ date: string; account: string; got: number; miss: number }>;
  skipped: Array<{ track: string; account: string; reason: string }>;
  models: {
    total: number;
    enabled: number;
    bindings: Record<string, { modelId: number; modelName: string } | null>;
    writeModelReady: boolean;
  };
  health: {
    db: boolean;
    masterKey: boolean;
    /** 硬常量，永远为 false；同时把库里的 setting 值一并暴露便于核对 */
    autoPublishConstant: boolean;
    autoPublishSetting: string | null;
    scheduler: { enabled: boolean; writeTime: string; pushEnabled: boolean };
  };
  recentRuns: Array<{
    id: number;
    jobType: string;
    status: string;
    trigger: string;
    runDate: string;
    articleId: number | null;
    errorMessage: string;
    createdAt: string;
  }>;
  recentLogs: Array<{ id: number; level: string; stage: string; message: string; createdAt: string }>;
  recentArticles: Array<{
    id: number;
    title: string;
    status: string;
    account: string | null;
    chars: number;
    createdAt: string;
  }>;
  warnings: string[];
  degraded: string[];
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 包一层：区块失败时降级并在 degraded 里登记，不让整个仪表盘挂掉。 */
async function safe<T>(name: string, fallback: T, fn: () => Promise<T>, degraded: string[]): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ block: name, err: msg }, '仪表盘区块降级');
    degraded.push(name);
    return fallback;
  }
}

export async function getDashboard(): Promise<DashboardData> {
  const degraded: string[] = [];
  const today = todayStr();
  const dateObj = new Date();

  // ── 基础计数 ──
  const counts = await safe(
    'counts',
    {
      tracks: 0,
      accounts: { total: 0, enabled: 0, ready: 0 },
      angles: { total: 0, unused: 0, used: 0, usageRate: 0 },
      articles: { total: 0, today: 0, draft: 0, pushed: 0, failed: 0 },
    },
    async () => {
      const [tracks, accounts, angleTotal, angleUnused, artTotal, artDraft, artPushed, artFailed, todayRows] =
        await Promise.all([
          prisma.track.count(),
          prisma.account.findMany({ select: { enabled: true, credStatus: true } }),
          prisma.angle.count(),
          prisma.angle.count({ where: { used: false } }),
          prisma.article.count(),
          prisma.article.count({ where: { status: 'draft' } }),
          prisma.article.count({ where: { status: 'pushed' } }),
          prisma.article.count({ where: { status: 'failed' } }),
          prisma.article.findMany({ select: { createdAt: true } }),
        ]);

      const artToday = todayRows.filter((r) => r.createdAt.toISOString().slice(0, 10) === today).length;
      const usageRate = angleTotal > 0 ? Number(((angleTotal - angleUnused) / angleTotal).toFixed(3)) : 0;

      return {
        tracks,
        accounts: {
          total: accounts.length,
          enabled: accounts.filter((a) => a.enabled).length,
          ready: accounts.filter((a) => a.enabled && a.credStatus === 'ok').length,
        },
        angles: { total: angleTotal, unused: angleUnused, used: angleTotal - angleUnused, usageRate },
        articles: { total: artTotal, today: artToday, draft: artDraft, pushed: artPushed, failed: artFailed },
      };
    },
    degraded,
  );

  // ── 今日排产口径（与调度器完全一致）──
  const plan = await safe(
    'plan',
    null as Awaited<ReturnType<typeof buildPlan>> | null,
    () => buildPlan(),
    degraded,
  );

  const todayBlock = (() => {
    if (!plan) {
      return { quotaTotal: 0, produced: 0, pending: 0, byAccount: [] as DashboardData['today']['byAccount'] };
    }
    const byAccount = plan.tasks.map((t) => ({
      accountId: t.accountId,
      account: t.account,
      track: t.track,
      quota: plan.perDay[t.trackId] ?? 2,
      produced: t.alreadyToday,
      pending: Math.max(0, t.need),
      angleStock: t.angles.length,
    }));
    const quotaTotal = byAccount.reduce((s, x) => s + x.quota, 0);
    const produced = byAccount.reduce((s, x) => s + x.produced, 0);
    const pending = byAccount.reduce((s, x) => s + x.pending, 0);
    return { quotaTotal, produced, pending, byAccount };
  })();

  // ── 模型与角色绑定 ──
  const models = await safe(
    'models',
    {
      total: 0,
      enabled: 0,
      bindings: {} as Record<string, { modelId: number; modelName: string } | null>,
      writeModelReady: false,
    },
    async () => {
      const roles = ['write', 'revise', 'cover', 'expand_angles'] as const;
      const [list, bindings] = await Promise.all([
        prisma.llmModel.findMany({ select: { id: true, name: true, enabled: true, apiKeyEnc: true } }),
        prisma.modelBinding.findMany({ select: { role: true, modelId: true } }),
      ]);
      const nameById = new Map(list.map((m) => [m.id, m.name] as const));
      const out: Record<string, { modelId: number; modelName: string } | null> = {};
      for (const r of roles) out[r] = null;
      for (const b of bindings) {
        const name = nameById.get(b.modelId);
        if (name) out[b.role] = { modelId: b.modelId, modelName: name };
      }
      const writeModel = bindings.find((b) => b.role === 'write');
      const writeRow = writeModel ? list.find((m) => m.id === writeModel.modelId) : undefined;
      return {
        total: list.length,
        enabled: list.filter((m) => m.enabled).length,
        bindings: out,
        writeModelReady: !!writeRow && !!writeRow.apiKeyEnc && writeRow.apiKeyEnc.length > 0,
      };
    },
    degraded,
  );

  // ── 健康与开关 ──
  const health = await safe(
    'health',
    {
      db: false,
      masterKey: false,
      autoPublishConstant: AUTO_PUBLISH,
      autoPublishSetting: null as string | null,
      scheduler: { enabled: false, writeTime: '06:00', pushEnabled: false },
    },
    async () => {
      let masterKey = false;
      try {
        const k = requireMasterKey();
        masterKey = k.length === 32;
      } catch {
        masterKey = false;
      }
      const ap = await prisma.setting.findUnique({ where: { k: 'auto_publish' } });
      return {
        db: await checkDb(),
        masterKey,
        autoPublishConstant: AUTO_PUBLISH,
        autoPublishSetting: ap?.v ?? null,
        scheduler: await getSchedulerConfig(),
      };
    },
    degraded,
  );

  // ── 最近动态 ──
  const recentRuns = await safe('recentRuns', [] as DashboardData['recentRuns'], async () => {
    const rows = await prisma.taskRun.findMany({ orderBy: { createdAt: 'desc' }, take: 12 });
    return rows.map((r) => ({
      id: r.id,
      jobType: r.jobType,
      status: r.status,
      trigger: r.trigger,
      runDate: r.runDate,
      articleId: r.articleId,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
    }));
  }, degraded);

  const recentLogs = await safe('recentLogs', [] as DashboardData['recentLogs'], async () => {
    const rows = await prisma.runLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      stage: r.stage,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
    }));
  }, degraded);

  const recentArticles = await safe('recentArticles', [] as DashboardData['recentArticles'], async () => {
    const rows = await prisma.article.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        status: true,
        chars: true,
        createdAt: true,
        accountId: true,
      },
    });
    const accIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is number => x != null))];
    const accs = accIds.length
      ? await prisma.account.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(accs.map((a) => [a.id, a.name] as const));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      account: r.accountId != null ? nameById.get(r.accountId) ?? null : null,
      chars: r.chars,
      createdAt: r.createdAt.toISOString(),
    }));
  }, degraded);

  // ── 告警汇总（排产告警 + 本服务自身发现的问题）──
  const warnings: string[] = [];
  if (plan?.warnings?.length) warnings.push(...plan.warnings);
  if (health.scheduler.enabled && !models.writeModelReady) {
    warnings.push('已启用自动调度，但「写作」角色未绑定有效模型（含 API Key），届时只会产出骨架草稿');
  }
  if (counts.accounts.ready === 0) {
    warnings.push('暂无凭据就绪（ok 且启用）的账号，无法排产与推送');
  }
  if (counts.angles.unused <= 30) {
    warnings.push(`角度库存偏低：仅剩 ${counts.angles.unused} 个未用角度，建议尽快扩库`);
  }
  if (!health.masterKey) warnings.push('主密钥 APP_SECRET_KEY 未就绪，凭据加解密将失败');
  if (degraded.length > 0) warnings.push(`以下区块降级：${degraded.join('、')}`);

  return {
    generatedAt: dateObj.toISOString(),
    date: today,
    counts,
    today: todayBlock,
    backlog: plan?.backlog ?? [],
    skipped: plan?.skipped ?? [],
    models,
    health,
    recentRuns,
    recentLogs,
    recentArticles,
    warnings,
    degraded,
  };
}
