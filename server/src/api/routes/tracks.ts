/**
 * 赛道路由：赛道的新增 / 编辑 / 删除，以及选题角度池的 LLM 扩库。
 *
 * 赛道是账号的父级，同赛道多账号共享该赛道的角度池。赛道此前只能由
 * cli/migrate.ts 从旧流水线一次性导入，现在运行期可自由增删；
 * 新增赛道后角度池是空的，需要走 POST /:id/expand 扩库才能开始创作。
 *
 * 删除约束：赛道下还有账号时拒绝删除（409），必须先删掉或改绑这些账号，
 * 否则账号会跟着一起消失、连带其名下文章——这个代价不想让用户误触发。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors.ts';
import { anglePoolStats, expandAnglesForTrack } from '../../services/angles.ts';
import { ensureSeeded, isPipelineKind, listPipelines, setPipelineQuota } from '../../services/pipeline.ts';
import { asyncHandler } from '../async-handler.ts';

export const tracksRouter: Router = Router();

const idParam = z.coerce.number().int().positive();

/**
 * quotaPerDay 在本路由里是 **兼容字段**（@deprecated）。
 * 产线改造后配额真源是 TrackPipeline（kind='article'）：建/改赛道统一经
 * services/pipeline.ts 播种/双写，这里只作镜像返回，保证老前端不破。
 * 新代码一律走 GET/PUT /api/tracks/:id/pipelines/:kind。
 */
const createSchema = z.object({
  name: z.string().trim().min(1, '赛道名不能为空').max(32),
  slug: z.string().trim().max(64).optional(),
  quotaPerDay: z.number().int().min(0).max(20).optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  quotaPerDay: z.number().int().min(0).max(20).optional(),
  enabled: z.boolean().optional(),
});

const expandSchema = z.object({
  count: z.number().int().min(1).max(100).optional(),
  seed: z.string().trim().max(500).optional(),
  /**
   * 产出的角度切片，默认 article。
   * **给漫画产线扩库必须传 comic（或 shared）**——漫画线只吃 comic/shared，
   * 扩出来的文章选题它一粒都吃不到（仪表盘里漫画线「可用角度 0」就是这个原因）。
   */
  scope: z.enum(['article', 'comic', 'shared']).optional(),
});

/**
 * 把赛道名整理成 slug：保留小写字母、数字、连字符与中文（中文在 URL 与库里都可用，
 * 比退化成 track-xxxx 可读得多），其余符号（空格、标点）统一折成连字符。
 */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `track-${Date.now().toString(36)}`;
}

/** 保证 slug 唯一：冲突就加 -2 / -3 … */
async function uniqueSlug(base: string): Promise<string> {
  const root = base.slice(0, 60);
  let candidate = root;
  for (let i = 2; i < 200; i++) {
    const dup = await prisma.track.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!dup) return candidate;
    candidate = `${root}-${i}`;
  }
  throw new BadRequestError('slug 冲突过多，请手动指定一个 slug');
}

/** 列表：带账号数、文章数、角度池概况，界面据此判断「该扩库了」。 */
tracksRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const tracks = await prisma.track.findMany({
      include: { _count: { select: { accounts: true, articles: true } } },
      orderBy: { id: 'asc' },
    });

    const [totals, unused] = await Promise.all([
      prisma.angle.groupBy({ by: ['trackId'], _count: { _all: true } }),
      prisma.angle.groupBy({ by: ['trackId'], where: { used: false }, _count: { _all: true } }),
    ]);
    const totalBy = new Map(totals.map((r) => [r.trackId, r._count._all]));
    const unusedBy = new Map(unused.map((r) => [r.trackId, r._count._all]));

    res.json({
      total: tracks.length,
      items: tracks.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        quotaPerDay: t.quotaPerDay,
        enabled: t.enabled,
        accountCount: t._count.accounts,
        articleCount: t._count.articles,
        angleTotal: totalBy.get(t.id) ?? 0,
        angleUnused: unusedBy.get(t.id) ?? 0,
      })),
    });
  }),
);

/** 新建赛道。slug 可省略，自动生成并保证唯一。 */
tracksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const slug = await uniqueSlug(slugify(body.slug?.trim() || body.name));

    try {
      const t = await prisma.track.create({
        data: {
          name: body.name,
          slug,
          quotaPerDay: body.quotaPerDay ?? 2,
          enabled: body.enabled ?? true,
        },
      });
      // 立刻播种两行产线（article 沿用上面的配额，comic 默认 0/停用），
      // 否则新赛道在「产线配额」弹窗里会是「未播种」的回落值，界面与库不一致。
      await ensureSeeded(t.id);
      res.status(201).json({
        id: t.id,
        name: t.name,
        slug: t.slug,
        quotaPerDay: t.quotaPerDay,
        enabled: t.enabled,
        accountCount: 0,
        articleCount: 0,
        angleTotal: 0,
        angleUnused: 0,
        message: '赛道已创建。它的角度池还是空的，请先「扩充选题」再开始创作',
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unique')) {
        throw new BadRequestError('赛道 slug 已存在，请换一个 slug');
      }
      throw e;
    }
  }),
);

/** 编辑赛道：改名 / 改每日配额 / 启停。slug 作为稳定标识不开放修改。 */
tracksRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateSchema.parse(req.body);
    const current = await prisma.track.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`赛道 ${id} 不存在`);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.quotaPerDay !== undefined) data.quotaPerDay = body.quotaPerDay;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (Object.keys(data).length === 0) throw new BadRequestError('没有需要保存的改动');

    const t = await prisma.track.update({ where: { id }, data });
    // 配额真源是 TrackPipeline：这里同步写一次（setPipelineQuota 内部会双写回 Track.quotaPerDay），
    // 保证老入口与新产线口径始终一致，不会出现「赛道页改了配额、产线页没变」。
    if (body.quotaPerDay !== undefined) {
      await ensureSeeded(id);
      await setPipelineQuota(id, 'article', { quotaPerDay: body.quotaPerDay });
    }
    const pool = await anglePoolStats(id);
    res.json({
      id: t.id,
      name: t.name,
      slug: t.slug,
      quotaPerDay: t.quotaPerDay,
      enabled: t.enabled,
      angleTotal: pool.total,
      angleUnused: pool.unused,
      message: '已保存',
    });
  }),
);

// ── 产线（article / comic）配额与开关 ──

/** 读某赛道的产线现状（含未播种时的回落值）。 */
tracksRouter.get(
  '/:id/pipelines',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const t = await prisma.track.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundError(`赛道 ${id} 不存在`);
    res.json({ trackId: id, items: await listPipelines(id) });
  }),
);

const pipelinePatchSchema = z.object({
  quotaPerDay: z.number().int().min(0).max(20).optional(),
  enabled: z.boolean().optional(),
});

/** 改某赛道某产线的配额/开关（article 会双写旧 Track.quotaPerDay 保持兼容）。 */
tracksRouter.put(
  '/:id/pipelines/:kind',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const kind = String(req.params.kind ?? '');
    if (!isPipelineKind(kind)) {
      throw new BadRequestError(`未知产线 ${kind}（当前仅支持 article / comic）`);
    }
    const t = await prisma.track.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundError(`赛道 ${id} 不存在`);
    const body = pipelinePatchSchema.parse(req.body);
    const item = await setPipelineQuota(id, kind, body);
    res.json({ ...item, message: '已保存' });
  }),
);

tracksRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const t = await prisma.track.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!t) throw new NotFoundError(`赛道 ${id} 不存在`);

    const accountCount = await prisma.account.count({ where: { trackId: id } });
    if (accountCount > 0) {
      throw new ConflictError(
        `赛道「${t.name}」下还有 ${accountCount} 个账号，请先删除或改绑到其他赛道，再删除本赛道`,
        { accountCount },
      );
    }

    // Angle 由 onDelete:Cascade 自动清理；Article.trackId 置空变"未归属"（内容不删）
    await prisma.track.delete({ where: { id } });
    res.json({ ok: true, id, name: t.name, message: `已删除赛道「${t.name}」` });
  }),
);

/** 扩库返回文案里要说明「扩给了哪条产线」，避免用户以为扩完漫画线就能用。 */
const SCOPE_LABEL: Record<string, string> = {
  article: '文章',
  comic: '漫画',
  shared: '共享',
};

/**
 * 为赛道扩充选题角度池（LLM）。
 * 需要「模型配置」里已给 expand_angles 角色绑定一个文本模型，否则返回 400 并提示去绑定。
 */
tracksRouter.post(
  '/:id/expand',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = expandSchema.parse(req.body ?? {});
    const result = await expandAnglesForTrack(id, body.count ?? 20, body.seed, body.scope ?? 'article');
    res.json({
      ok: true,
      ...result,
      message:
        result.added > 0
          ? `新增 ${result.added} 条${SCOPE_LABEL[result.scope]}选题` +
            (result.skippedDuplicate > 0 ? `，跳过重复 ${result.skippedDuplicate} 条` : '') +
            `，该用途当前可用 ${result.scopeUnused} 条`
          : `没有新增：模型给的 ${result.generated} 条全部与现有选题重复，请换个种子或减少条数再试`,
    });
  }),
);
