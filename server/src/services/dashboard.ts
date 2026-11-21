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
import { Prisma } from '@prisma/client';
import { prisma, checkDb } from '../db.ts';
import { requireMasterKey } from '../config.ts';
import { logger } from '../logger.ts';
import { dayKeyOf, todayKey } from '../lib/day.ts';
import { PIPELINES } from './pipeline.ts';
import { buildPlan } from './planner.ts';
import { getSchedulerConfig } from './scheduler.ts';
import { modelAvailability } from './llm.ts';
import { ROLES } from './model-registry.ts';
import { hasPushTrace } from './article-delete.ts';
import { htmlFingerprint } from './lint-store.ts';
import { readScoreMeta } from './topic-review.ts';

export interface RoleAvailability {
  bound: boolean;
  modelName?: string;
  ready: boolean;
  reason?: string;
}

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
      /** 产线（article / comic） */
      pipeline: string;
      quota: number;
      produced: number;
      pending: number;
      angleStock: number;
    }>;
    /** 按产线汇总（同一账号可能跑多条产线，分开看才知道哪条线欠账）。 */
    byPipeline: Array<{
      pipeline: string;
      quota: number;
      produced: number;
      pending: number;
      accounts: number;
    }>;
  };
  backlog: Array<{ date: string; account: string; got: number; miss: number }>;
  skipped: Array<{ track: string; account: string; reason: string }>;
  models: {
    total: number;
    enabled: number;
    bindings: Record<string, { modelId: number; modelName: string } | null>;
    writeModelReady: boolean;
    /** 各角色是否真的可用（含启用/能力/协议/Key 校验），用于界面解释「为什么跑不通」 */
    roleAvailability: Record<string, RoleAvailability>;
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
  /** 待办队列（S5-UI-2）：只聚合已有业务事实，四块各自独立容错；member 看不到选题块（angles=null）。 */
  todos: TodoBlock;
}

function todayStr(): string {
  return todayKey();
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

// ── 可复用区块：仪表盘与轻量状态接口（/api/dashboard/status）共用同一实现 ──

type ModelsBlock = DashboardData['models'];
type HealthBlock = DashboardData['health'];

const EMPTY_MODELS: ModelsBlock = {
  total: 0,
  enabled: 0,
  bindings: {},
  writeModelReady: false,
  roleAvailability: {},
};

const EMPTY_HEALTH: HealthBlock = {
  db: false,
  masterKey: false,
  autoPublishConstant: AUTO_PUBLISH,
  autoPublishSetting: null,
  scheduler: { enabled: false, writeTime: '06:00', pushEnabled: false },
};

async function modelsBlock(): Promise<ModelsBlock> {
  const [list, bindings] = await Promise.all([
    prisma.llmModel.findMany({ select: { id: true, name: true, enabled: true, apiKeyEnc: true } }),
    prisma.modelBinding.findMany({ select: { role: true, modelId: true } }),
  ]);
  const nameById = new Map(list.map((m) => [m.id, m.name] as const));
  const out: Record<string, { modelId: number; modelName: string } | null> = {};
  for (const r of ROLES) out[r] = null;
  for (const b of bindings) {
    const name = nameById.get(b.modelId);
    if (name) out[b.role] = { modelId: b.modelId, modelName: name };
  }

  // 可用性统一走 modelAvailability：此前只判「有绑定 + 有 Key」，
  // 导致绑了个已停用或能力不符的模型也会显示"已配置"，实际跑起来却失败。
  const roleAvailability: Record<string, RoleAvailability> = {};
  for (const r of ROLES) roleAvailability[r] = await modelAvailability(r);

  return {
    total: list.length,
    enabled: list.filter((m) => m.enabled).length,
    bindings: out,
    writeModelReady: roleAvailability.write?.ready ?? false,
    roleAvailability,
  };
}

async function healthBlock(): Promise<HealthBlock> {
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
}

export interface SystemStatus {
  generatedAt: string;
  models: ModelsBlock;
  health: HealthBlock;
  degraded: string[];
}

/**
 * 轻量系统状态：只含「模型绑定 + 健康」，不含排产/最近动态等重区块，
 * 供全局侧边栏等常驻 UI 使用，避免为了一个状态点拉整个仪表盘。
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const degraded: string[] = [];
  const models = await safe('models', EMPTY_MODELS, modelsBlock, degraded);
  const health = await safe('health', EMPTY_HEALTH, healthBlock, degraded);
  return { generatedAt: new Date().toISOString(), models, health, degraded };
}

export type PipelineBucket = DashboardData['today']['byPipeline'][number];

/**
 * 按产线汇总今日配额进度。纯函数（不碰库），便于冒烟直接断言。
 * 顺序固定为 PIPELINES（文章在前、漫画在后），与排产执行顺序一致。
 */
export function groupByPipeline(rows: DashboardData['today']['byAccount']): PipelineBucket[] {
  const known = new Set<string>(PIPELINES as readonly string[]);
  const order = new Map<string, number>(PIPELINES.map((k, i) => [k as string, i]));
  const buckets = new Map<string, PipelineBucket>();
  for (const r of rows) {
    const key = r.pipeline ?? 'article';
    const b = buckets.get(key) ?? { pipeline: key, quota: 0, produced: 0, pending: 0, accounts: 0 };
    b.quota += r.quota;
    b.produced += r.produced;
    b.pending += r.pending;
    b.accounts += 1;
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => {
    // 已知产线按固定顺序在前，未知产线（未来新增）按名字排在后，保证输出稳定。
    const ia = order.get(a.pipeline) ?? (known.has(a.pipeline) ? 0 : 99);
    const ib = order.get(b.pipeline) ?? (known.has(b.pipeline) ? 0 : 99);
    return ia - ib || a.pipeline.localeCompare(b.pipeline);
  });
}

// ════════════════════════════════════════════════════════════════════════
// 待办队列（S5-UI-2）
//
// 设计约束（来自 S5-UI-2-A 核查结论）：
//   1. 只聚合**已有业务事实**，不引入新状态、不新建表、不改任何状态机。
//   2. 数字必须区分 0 与「取不到」：成功且没有 = 0；查询失败 = null + 进 degraded。
//      前端据此显示「统计暂不可用」，绝不允许把失败显示成 0。
//   3. 每块独立 try/catch（复用 safe()），一个块挂了不影响其他块，更不影响整个仪表盘。
//   4. 推送事实一律走 hasPushTrace()（S4-4-1 语义），**不用 status 推断**——
//      pushed 会被编辑/改写/换封面/重推失败改成 draft/updated/failed，status 只是当前态。
//   5. 体检只看「每篇最新一条 + 正文指纹一致」，绝不调 GET /:id/lint（那个接口会写库）。
//   6. 执行失败窗口 7 天 + 同键取最新，避免历史失败永久挂在工作台。
// ════════════════════════════════════════════════════════════════════════

/** 每类待办最多给几条明细（明细是入口，完整列表去各自页面）。 */
const TODO_RECENT = 3;
/** 执行失败统计窗口（天）：TaskRun 没有重试链也没有「已处理」标记，只能靠窗口收敛。 */
const TODO_RUN_WINDOW_DAYS = 7;
/**
 * 扫描上限。这三处都必须「要么全量准确、要么明确失败」，不允许截断后当真实数字用。
 * 实测数据量是几十~几百，上限留出余量；真撞上就抛错 → 该块降级为 null。
 */
const TODO_ARTICLE_SCAN_LIMIT = 500;
const TODO_LINT_SCAN_LIMIT = 500;
const TODO_RUN_SCAN_LIMIT = 500;

export interface TodoAngleItem {
  id: number;
  trackId: number;
  track: string;
  status: string;
  theme: string;
  content: string;
  /** 六维总分（未评分为 null——不视为高质量）。 */
  scoreTotal: number | null;
  updatedAt: string;
}

export interface TodoAnglesBlock {
  total: number | null;
  candidate: number | null;
  needsRevision: number | null;
  /** 等最久的那条等了几天（用 updatedAt：被打回的时间点才算等待开始）。 */
  oldestWaitingDays: number | null;
  byTrack: Array<{ trackId: number; track: string; candidate: number; needsRevision: number }>;
  recent: TodoAngleItem[];
}

export type TodoArticleReason = 'draft_unpushed' | 'repush' | 'push_failed';

export interface TodoArticleItem {
  id: number;
  title: string;
  status: string;
  pipeline: string;
  account: string | null;
  reason: TodoArticleReason;
  updatedAt: string;
}

export interface TodoArticlesBlock {
  /** 从未推送过的文章草稿（仅 article 产线）。 */
  draftUnpushed: number | null;
  /** 曾送达但正文/封面改过，需要重推（updated + 推送过又退回 draft 的）。 */
  repush: number | null;
  /** 推送失败且从未送达。 */
  pushFailed: number | null;
  /** 漫画待推草稿：独立计数，不与上面三个相加。 */
  comicDraft: number | null;
  /** 未推送草稿里等最久的天数。 */
  oldestDraftDays: number | null;
  recent: TodoArticleItem[];
}

export interface TodoLintItem {
  articleId: number;
  title: string;
  trigger: string;
  errorCount: number;
  warnCount: number;
  checkedAt: string;
  /** 该条记录是否早于当前正文（true 时不计入 failed，本列表里恒为 false）。 */
  stale: boolean;
}

export interface TodoLintBlock {
  /** 最新一条体检不通过、且记录与当前正文一致的篇数。 */
  failed: number | null;
  recent: TodoLintItem[];
}

export interface TodoRunItem {
  id: number;
  jobType: string;
  accountId: number | null;
  account: string | null;
  articleId: number | null;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
}

export interface TodoRunsBlock {
  windowDays: number;
  /** 窗口内「同键最新一条仍失败」的条数（批次算一次）。 */
  unresolved: number | null;
  recent: TodoRunItem[];
}

export interface TodoBlock {
  /** all=admin 全量；own=member 仅自己账号/文章。 */
  scope: 'all' | 'own';
  /** member 恒为 null——选题不可见属正常权限结果，不进 degraded。 */
  angles: TodoAnglesBlock | null;
  articles: TodoArticlesBlock;
  lint: TodoLintBlock;
  runs: TodoRunsBlock;
  /** 查询失败的块名（angles / articles / lint / runs）。 */
  degraded: string[];
}

const EMPTY_TODO_ANGLES: TodoAnglesBlock = {
  total: null,
  candidate: null,
  needsRevision: null,
  oldestWaitingDays: null,
  byTrack: [],
  recent: [],
};

const EMPTY_TODO_ARTICLES: TodoArticlesBlock = {
  draftUnpushed: null,
  repush: null,
  pushFailed: null,
  comicDraft: null,
  oldestDraftDays: null,
  recent: [],
};

const EMPTY_TODO_LINT: TodoLintBlock = { failed: null, recent: [] };

const EMPTY_TODO_RUNS: TodoRunsBlock = {
  windowDays: TODO_RUN_WINDOW_DAYS,
  unresolved: null,
  recent: [],
};

/** 天数差（本地自然日口径与 updatedAt 的绝对时间差取整，够用且稳定）。 */
function daysSince(d: Date): number {
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

/**
 * A. 待审核选题（仅 admin）。
 * 口径与 planner 的「有题但没审」诊断一致：used=false 且 status ∈ (candidate, needs_revision)。
 * used=true 的排除掉——approved 被占用后若又编辑退回 candidate（angles.ts 的 CAS 分支），
 * 它已经是被消费的题，不该再出现在待审里；rejected 是终态，也不计入。
 */
async function todoAngles(): Promise<TodoAnglesBlock> {
  const where: Prisma.AngleWhereInput = {
    used: false,
    status: { in: ['candidate', 'needs_revision'] },
  };

  const [groups, oldestRows] = await Promise.all([
    prisma.angle.groupBy({ by: ['trackId', 'status'], where, _count: { _all: true } }),
    // 升序取前几条：既是最久未动的明细，第 0 条也就是全局等最久的那一条
    prisma.angle.findMany({
      where,
      orderBy: { updatedAt: 'asc' },
      take: TODO_RECENT,
      include: { track: { select: { name: true } } },
    }),
  ]);

  const trackIds = [...new Set(groups.map((g) => g.trackId))];
  const tracks = trackIds.length
    ? await prisma.track.findMany({ where: { id: { in: trackIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(tracks.map((t) => [t.id, t.name] as const));

  const byTrackMap = new Map<number, { trackId: number; track: string; candidate: number; needsRevision: number }>();
  let candidate = 0;
  let needsRevision = 0;
  for (const g of groups) {
    const n = g._count._all;
    const cur = byTrackMap.get(g.trackId) ?? {
      trackId: g.trackId,
      track: nameById.get(g.trackId) ?? `#${g.trackId}`,
      candidate: 0,
      needsRevision: 0,
    };
    if (g.status === 'candidate') {
      cur.candidate += n;
      candidate += n;
    } else {
      cur.needsRevision += n;
      needsRevision += n;
    }
    byTrackMap.set(g.trackId, cur);
  }

  const byTrack = [...byTrackMap.values()].sort(
    (a, b) => b.candidate + b.needsRevision - (a.candidate + a.needsRevision) || a.trackId - b.trackId,
  );

  const oldest = oldestRows[0];

  return {
    total: candidate + needsRevision,
    candidate,
    needsRevision,
    oldestWaitingDays: oldest ? daysSince(oldest.updatedAt) : 0,
    byTrack,
    recent: oldestRows.map((a) => ({
      id: a.id,
      trackId: a.trackId,
      track: a.track?.name ?? `#${a.trackId}`,
      status: a.status,
      theme: a.theme,
      content: a.content,
      scoreTotal: readScoreMeta(a.metaJson)?.scores?.total ?? null,
      updatedAt: a.updatedAt.toISOString(),
    })),
  };
}

/**
 * B. 文章待处理（三类互斥 + 漫画单列）。
 *
 * 为什么必须读行再分类而不是 `count({ status:'draft', mediaId:'', pushDate:'' })`：
 * hasPushTrace() 用 trim 判空，而 SQL 的 `!= ''` 会把纯空白串当成「有值」。
 * 为了与业务判断**逐字同源**，这里取回 "可能相关" 的行（draft/failed），
 * 在 JS 里直接调 hasPushTrace() 分类。行数天然有限（未推送草稿 + 推送失败），
 * 且撞到扫描上限时抛错降级，绝不用截断后的数字冒充真实值。
 */
async function todoArticles(artWhere: Prisma.ArticleWhereInput): Promise<TodoArticlesBlock> {
  const [candidates, updatedCount, comicDraft] = await Promise.all([
    prisma.article.findMany({
      where: { ...artWhere, pipeline: 'article', status: { in: ['draft', 'failed'] } },
      select: {
        id: true,
        title: true,
        status: true,
        pipeline: true,
        mediaId: true,
        pushDate: true,
        updatedAt: true,
        accountId: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: TODO_ARTICLE_SCAN_LIMIT,
    }),
    prisma.article.count({ where: { ...artWhere, pipeline: 'article', status: 'updated' } }),
    prisma.article.count({ where: { ...artWhere, pipeline: 'comic', status: 'draft' } }),
  ]);

  if (candidates.length >= TODO_ARTICLE_SCAN_LIMIT) {
    throw new Error(`未推送/失败文章超过扫描上限 ${TODO_ARTICLE_SCAN_LIMIT}，拒绝近似统计`);
  }

  let draftUnpushed = 0;
  let repushDraft = 0;
  let pushFailed = 0;
  let oldestDraft: Date | null = null;
  const pending: Array<Omit<TodoArticleItem, 'account'> & { accountId: number | null }> = [];

  for (const a of candidates) {
    const everPushed = hasPushTrace(a);
    if (a.status === 'draft') {
      if (everPushed) {
        repushDraft += 1;
        pending.push({
          id: a.id,
          title: a.title,
          status: a.status,
          pipeline: a.pipeline,
          reason: 'repush',
          updatedAt: a.updatedAt.toISOString(),
          accountId: a.accountId,
        });
      } else {
        draftUnpushed += 1;
        if (!oldestDraft || a.updatedAt < oldestDraft) oldestDraft = a.updatedAt;
        pending.push({
          id: a.id,
          title: a.title,
          status: a.status,
          pipeline: a.pipeline,
          reason: 'draft_unpushed',
          updatedAt: a.updatedAt.toISOString(),
          accountId: a.accountId,
        });
      }
      continue;
    }
    // status === 'failed'：只有「从未送达」才是待处理的推送失败。
    // 有推送痕迹的 failed 属历史脏数据（S5-1 起不会再产生），不冒充待办。
    if (!everPushed) {
      pushFailed += 1;
      pending.push({
        id: a.id,
        title: a.title,
        status: a.status,
        pipeline: a.pipeline,
        reason: 'push_failed',
        updatedAt: a.updatedAt.toISOString(),
        accountId: a.accountId,
      });
    }
  }

  // 明细按最近改动排序（pending 已按 updatedAt desc 入列，repush/updated 另算）
  const recent = pending.slice(0, TODO_RECENT);
  const accIds = [...new Set(recent.map((r) => r.accountId).filter((x): x is number => x != null))];
  const accs = accIds.length
    ? await prisma.oAAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
    : [];
  const accName = new Map(accs.map((a) => [a.id, a.name] as const));

  return {
    draftUnpushed,
    repush: updatedCount + repushDraft,
    pushFailed,
    comicDraft,
    oldestDraftDays: oldestDraft ? daysSince(oldestDraft) : 0,
    recent: recent.map(({ accountId, ...rest }) => ({
      ...rest,
      account: accountId != null ? accName.get(accountId) ?? null : null,
    })),
  };
}

/**
 * C. 文章体检异常。
 *
 * 「每篇最新一条」用 groupBy(_max id) 两步取，不做 N+1；
 * 只统计 ok=false **且 contentHash 与当前正文一致**的最新记录——
 * 改过稿但没重新体检的那条旧结论已经不代表当前稿子，算进「当前失败」就是虚报。
 *
 * ⚠️ 严禁改成调用 GET /api/articles/:id/lint：那个接口会 recordLintRun（写库）。
 * 本函数全部只读，工作台刷新不会产生任何 ArticleLintRun 行。
 */
async function todoLint(ownerUserId: number | null): Promise<TodoLintBlock> {
  const relWhere: Prisma.ArticleLintRunWhereInput =
    ownerUserId != null
      ? { article: { pipeline: { not: 'comic' }, account: { ownerUserId } } }
      : { article: { pipeline: { not: 'comic' } } };

  const groups = await prisma.articleLintRun.groupBy({
    by: ['articleId'],
    where: relWhere,
    _max: { id: true },
  });
  const latestIds = groups.map((g) => g._max.id).filter((x): x is number => x != null);
  if (latestIds.length === 0) return { failed: 0, recent: [] };

  const runs = await prisma.articleLintRun.findMany({
    where: { id: { in: latestIds }, ok: false },
    select: {
      id: true,
      articleId: true,
      trigger: true,
      errorCount: true,
      warnCount: true,
      createdAt: true,
      contentHash: true,
      article: { select: { id: true, title: true, contentHtml: true, pipeline: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: TODO_LINT_SCAN_LIMIT,
  });
  if (runs.length >= TODO_LINT_SCAN_LIMIT) {
    throw new Error(`最新体检失败记录超过扫描上限 ${TODO_LINT_SCAN_LIMIT}，拒绝近似统计`);
  }

  const valid = runs.filter((r) => {
    if (!r.article || r.article.pipeline === 'comic') return false; // 漫画不做文章形态体检
    return r.contentHash === htmlFingerprint(r.article.contentHtml);
  });

  return {
    failed: valid.length,
    recent: valid.slice(0, TODO_RECENT).map((r) => ({
      articleId: r.articleId,
      title: r.article!.title,
      trigger: r.trigger,
      errorCount: r.errorCount,
      warnCount: r.warnCount,
      checkedAt: r.createdAt.toISOString(),
      stale: false,
    })),
  };
}

/**
 * D. 任务执行异常（write / comic_script / comic_panel，排除 push）。
 *
 * 为什么排除 push：推送失败已经在 articles.pushFailed 里有独立口径（文章维度、更准），
 * 两处都算会重复。
 *
 * 「未恢复」判定：同一键取窗口内**最新一条**，仍为 failed 才算。
 * 键的取法必须与任务粒度一致：
 *   - write / comic_script 是批次任务（一次一批），键 = jobType + accountId；
 *   - comic_panel 是文维度（一次推进一篇的若干格），键 = articleId。
 * 这样「重试成功后旧失败自动消失」，不需要新增「已处理」字段。
 */
async function todoRuns(ownerUserId: number | null): Promise<TodoRunsBlock> {
  const since = new Date(Date.now() - TODO_RUN_WINDOW_DAYS * 86_400_000);
  const where: Prisma.TaskRunWhereInput = {
    createdAt: { gte: since },
    jobType: { in: ['write', 'comic_script', 'comic_panel'] },
  };

  if (ownerUserId != null) {
    // comic_panel 行没有 accountId（panels.ts 只写 articleId），必须靠文章归属兜住，
    // 否则 member 会漏掉自己漫画的失败。
    const [accs, arts] = await Promise.all([
      prisma.oAAccount.findMany({ where: { ownerUserId }, select: { id: true } }),
      prisma.article.findMany({ where: { account: { ownerUserId } }, select: { id: true } }),
    ]);
    where.OR = [
      { accountId: { in: accs.map((a) => a.id) } },
      { accountId: null, articleId: { in: arts.map((a) => a.id) } },
    ];
  }

  const rows = await prisma.taskRun.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: TODO_RUN_SCAN_LIMIT,
    select: {
      id: true,
      jobType: true,
      status: true,
      accountId: true,
      articleId: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
    },
  });
  if (rows.length >= TODO_RUN_SCAN_LIMIT) {
    throw new Error(`窗口内任务记录超过扫描上限 ${TODO_RUN_SCAN_LIMIT}，拒绝近似统计`);
  }

  const latestByKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key =
      r.jobType === 'comic_panel'
        ? `panel:${r.articleId ?? 'null'}`
        : `${r.jobType}:${r.accountId ?? 'null'}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }

  const failed = [...latestByKey.values()].filter((r) => r.status === 'failed');
  const recent = failed.slice(0, TODO_RECENT);
  const accIds = [...new Set(recent.map((r) => r.accountId).filter((x): x is number => x != null))];
  const accs = accIds.length
    ? await prisma.oAAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
    : [];
  const accName = new Map(accs.map((a) => [a.id, a.name] as const));

  return {
    windowDays: TODO_RUN_WINDOW_DAYS,
    unresolved: failed.length,
    recent: recent.map((r) => ({
      id: r.id,
      jobType: r.jobType,
      accountId: r.accountId,
      account: r.accountId != null ? accName.get(r.accountId) ?? null : null,
      articleId: r.articleId,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * 待办聚合总入口。
 * 四块并行、各自独立容错：一个块抛错只让它自己变 null（并登记到 degraded），
 * 其余块照常返回，仪表盘不会因此整页空白。
 */
async function todoBlock(ownerUserId: number | null): Promise<TodoBlock> {
  const degraded: string[] = [];
  const isAllScope = ownerUserId == null;
  const artWhere: Prisma.ArticleWhereInput =
    ownerUserId != null ? { account: { ownerUserId } } : {};

  const [angles, articles, lint, runs] = await Promise.all([
    isAllScope ? safe('angles', EMPTY_TODO_ANGLES, todoAngles, degraded) : Promise.resolve(null),
    safe('articles', EMPTY_TODO_ARTICLES, () => todoArticles(artWhere), degraded),
    safe('lint', EMPTY_TODO_LINT, () => todoLint(ownerUserId), degraded),
    safe('runs', EMPTY_TODO_RUNS, () => todoRuns(ownerUserId), degraded),
  ]);

  return { scope: isAllScope ? 'all' : 'own', angles, articles, lint, runs, degraded };
}

export async function getDashboard(ownerUserId?: number | null): Promise<DashboardData> {
  // P3 归属过滤：ownerUserId 传入时只统计该用户自己的账号与名下文章；undefined/null=admin 全量
  const accWhere = ownerUserId != null ? { ownerUserId } : {};
  const artWhere = ownerUserId != null ? { account: { ownerUserId } } : {};
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
          prisma.oAAccount.findMany({ where: accWhere, select: { enabled: true, credStatus: true } }),
          prisma.angle.count(),
          prisma.angle.count({ where: { used: false } }),
          prisma.article.count({ where: artWhere }),
          prisma.article.count({ where: { ...artWhere, status: 'draft' } }),
          prisma.article.count({ where: { ...artWhere, status: 'pushed' } }),
          prisma.article.count({ where: { ...artWhere, status: 'failed' } }),
          prisma.article.findMany({ where: artWhere, select: { createdAt: true } }),
        ]);

      const artToday = todayRows.filter((r) => dayKeyOf(r.createdAt) === today).length;
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
    () => buildPlan(undefined, 3, ownerUserId),
    degraded,
  );

  const todayBlock = (() => {
    if (!plan) {
      return {
        quotaTotal: 0,
        produced: 0,
        pending: 0,
        byAccount: [] as DashboardData['today']['byAccount'],
        byPipeline: [] as DashboardData['today']['byPipeline'],
      };
    }
    const byAccount = plan.tasks.map((t) => ({
      accountId: t.accountId,
      account: t.account,
      track: t.track,
      pipeline: t.pipeline,
      quota: t.perDay ?? 0,
      produced: t.alreadyToday,
      pending: Math.max(0, t.need),
      // 真实池余量（与赛道管理页一致）。此前误用 t.angles.length（今日预选数），
      // 配额已满时 need=0 会显示 0，被误读成「角度用光了」。
      angleStock: t.stock,
    }));
    const quotaTotal = byAccount.reduce((s, x) => s + x.quota, 0);
    const produced = byAccount.reduce((s, x) => s + x.produced, 0);
    const pending = byAccount.reduce((s, x) => s + x.pending, 0);
    return { quotaTotal, produced, pending, byAccount, byPipeline: groupByPipeline(byAccount) };
  })();

  // ── 模型与角色绑定 ──
  const models = await safe('models', EMPTY_MODELS, modelsBlock, degraded);

  // ── 健康与开关 ──
  const health = await safe('health', EMPTY_HEALTH, healthBlock, degraded);

  // ── 最近动态 ──
  // P3：member 的动态只看自己账号的（TaskRun.accountId 无 FK，先取我的账号 id 集）
  const myAccIds =
    ownerUserId != null
      ? (await prisma.oAAccount.findMany({ where: { ownerUserId }, select: { id: true } })).map((a) => a.id)
      : null;

  const recentRuns = await safe('recentRuns', [] as DashboardData['recentRuns'], async () => {
    const rows = await prisma.taskRun.findMany({
      where: myAccIds ? { accountId: { in: myAccIds } } : {},
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
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
    const rows = await prisma.runLog.findMany({
      where: myAccIds ? { taskRun: { accountId: { in: myAccIds } } } : {},
      orderBy: { createdAt: 'desc' },
      take: 15,
    });
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
      where: artWhere,
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
      ? await prisma.oAAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
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
  const writeAvail = models.roleAvailability?.write;
  if (health.scheduler.enabled && !models.writeModelReady) {
    warnings.push(
      `已启用自动调度，但「写作」角色不可用${writeAvail?.reason ? `（${writeAvail.reason}）` : ''}，届时只会产出骨架草稿`,
    );
  }
  if (counts.accounts.ready === 0) {
    warnings.push('暂无凭据就绪（ok 且启用）的账号，无法排产与推送');
  }
  if (counts.angles.unused <= 30) {
    warnings.push(`角度库存偏低：仅剩 ${counts.angles.unused} 个未用角度，建议尽快扩库`);
  }
  if (!health.masterKey) warnings.push('主密钥 APP_SECRET_KEY 未就绪，凭据加解密将失败');
  if (degraded.length > 0) warnings.push(`以下区块降级：${degraded.join('、')}`);

  // ── 待办队列（独立容错，失败只让对应块变 null，不影响上面任何区块）──
  const todos = await todoBlock(ownerUserId ?? null);

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
    todos,
  };
}
