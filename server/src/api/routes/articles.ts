/**
 * 文章路由：解析 + 渲染 + 在线改稿 + 推送草稿。
 *
 * 阶段 3 核心：preview 与 push 调用**同一个** renderArticle，保证「后台看到的就是发出去的」。
 *
 * 安全红线（与 credentials / wechat 一致）：
 *   - 推送只写草稿箱（WechatClient.addDraft），绝不调用 masssend / 群发接口
 *   - 推送前强制校验账号 credStatus === 'ok'，未配置/未连通直接拒绝，不浪费外网调用
 *   - 封面仅在文件真实存在时才上传，否则推无封面草稿
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { unpackJson } from '../../db-json.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { parseArticle } from '../../services/parse/index.ts';
import { renderArticle } from '../../services/render/index.ts';
import { buildLocalComicPreview } from '../../services/render/comic.ts';
import { pushArticleToDraft } from '../../services/publisher.ts';
import { lintArticle } from '../../services/lint.ts';
import { generateCoverForArticle } from '../../services/cover.ts';
import { toRelativeCoverPath } from '../../services/content-path.ts';
import { assertAccountAccess, assertArticleAccess, isAdmin, requirePrincipal } from '../../services/ownership.ts';
import { deleteArticleById } from '../../services/article-delete.ts';
import { loadTrackRule } from '../../services/style-prompts.ts';
import { asyncHandler } from '../async-handler.ts';
import { bulkDeleteSchema, runBulkDelete } from '../bulk-delete.ts';
import { requirePermission } from '../permissions.ts';
import { createComicDraft } from '../../services/comic/write.ts';
import {
  isComicGenerating,
  kickComicImages,
  processComicImages,
  regeneratePanel,
} from '../../services/comic/panels.ts';

export const articlesRouter: Router = Router();

// P2 RBAC：按 method+path 分发权限点（member 不改稿 → PUT 走 content:revise 仅 admin）
articlesRouter.use((req, res, next) => {
  const p = req.path;
  if (req.method === 'GET') return requirePermission('data:view')(req, res, next);
  if (/^\/\d+\/push$/.test(p)) return requirePermission('content:push')(req, res, next);
  if (req.method === 'PUT') return requirePermission('content:revise')(req, res, next);
  return requirePermission('content:generate')(req, res, next);
});

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  contentHtml: z.string().min(1, 'contentHtml 不能为空'),
  accountId: z.number().int().positive().optional(),
  trackId: z.number().int().positive().optional(),
  angleId: z.number().int().positive().optional(),
  title: z.string().trim().max(255).optional(),
  digest: z.string().trim().max(255).optional(),
  coverPath: z.string().trim().max(255).optional(),
});

const updateContentSchema = z.object({
  contentHtml: z.string().min(1, 'contentHtml 不能为空'),
});

async function getTitlePrefix(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { k: 'title_prefix' } });
  const v = s?.v ?? '【话】';
  return typeof v === 'string' ? v : '【话】';
}

/** 解析 + 渲染一步到位；title/digest 覆盖项可选。 */
async function build(html: string, overrides: { title?: string; digest?: string }) {
  const parsed = parseArticle(html);
  if (overrides.title) parsed.title = overrides.title;
  const prefix = await getTitlePrefix();
  const rendered = renderArticle(parsed, {
    titlePrefix: prefix,
    digestOverride: overrides.digest,
  });
  return { parsed, rendered };
}

// ── 漫画产线路由 ──
// 注意：/comic 前缀路由必须注册在通配 /:id(\d+) 之前（models.ts 的历史坑）。

const comicCreateSchema = z.object({
  accountId: z.number().int().positive(),
  angleId: z.number().int().positive(),
  unitCount: z.number().int().min(4).max(9).optional(),
  chain: z.string().trim().max(32).optional(),
  extra: z.string().trim().max(500).optional(),
});

/** 从选题角度生成漫画草稿（脚本 + N 个待生图格行）。 */
articlesRouter.post(
  '/comic/create',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = comicCreateSchema.parse(req.body);
    const account = await prisma.oAAccount.findUnique({ where: { id: body.accountId } });
    assertAccountAccess(principal, account, body.accountId);
    if (!account) throw new NotFoundError(`账号 ${body.accountId} 不存在`);
    const angle = await prisma.angle.findUnique({ where: { id: body.angleId } });
    if (!angle) throw new NotFoundError(`选题 ${body.angleId} 不存在`);
    const track = await prisma.track.findUnique({ where: { id: account.trackId } });
    if (!track) throw new NotFoundError(`账号所在赛道不存在`);
    const result = await createComicDraft(account, angle, track, {
      unitCount: body.unitCount,
      chain: body.chain,
      extra: body.extra,
    });
    // 建稿即开跑插图：用户预期是「点了就等图」，不是再去文章页手动点一次。
    kickComicImages(result.articleId);
    res.status(201).json({ ok: true, ...result, generating: true });
  }),
);

/**
 * 推进逐格生图。
 *
 * 语义 = 「确保这篇的插图在生成中」：先把后台自动推进（kick）点着（幂等），
 * 再同步推进 1 格（单格几十秒，请求不会挂太久）。前端只管轮询
 * GET /:id/comic/panels 看进度与 generating，不需要自己循环打这个接口。
 */
articlesRouter.post(
  '/:id(\\d+)/comic/generate',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const kicked = kickComicImages(id);
    const result = await processComicImages(id, { limit: 1 });
    res.json({ ok: true, ...result, generating: isComicGenerating(id), kicked });
  }),
);

/** 列出分镜格与生成状态。 */
articlesRouter.get(
  '/:id(\\d+)/comic/panels',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const panels = await prisma.comicPanel.findMany({ where: { articleId: id }, orderBy: { seq: 'asc' } });
    res.json({
      total: panels.length,
      success: panels.filter((p) => p.status === 'success').length,
      failed: panels.filter((p) => p.status === 'failed').length,
      /** 后台是否正在生图（前端据此显示「生成中」并禁用手动按钮）。 */
      generating: isComicGenerating(id),
      items: panels.map((p) => ({
        id: p.id,
        seq: p.seq,
        lines: p.lines,
        status: p.status,
        attempt: p.attempt,
        errorMsg: p.errorMsg,
        bytes: p.bytes,
        // 预览走 /api/content 静态托管
        previewUrl: p.filePath ? `/api/content/${p.filePath}` : null,
        prompt: p.prompt,
      })),
    });
  }),
);

/**
 * 单格重画（清状态后立即推进该篇）。
 * body 可选携带 prompt / lines：先改词再重画（提示词可编辑的入口）。
 */
const panelRegenerateSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000).optional(),
    lines: z.string().trim().max(1000).optional(),
  })
  .optional();

articlesRouter.post(
  '/:id(\\d+)/comic/panels/:seq(\\d+)/regenerate',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const seq = z.coerce.number().int().positive().parse(req.params.seq);
    const body = panelRegenerateSchema.parse(req.body ?? {});
    await regeneratePanel(id, seq, body ?? {});
    res.json({ ok: true });
  }),
);

articlesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    // 账号必须真实存在且归属当前用户（P3），否则文章会挂到他人账号上。
    if (body.accountId != null) {
      const acc = await prisma.oAAccount.findUnique({
        where: { id: body.accountId },
        select: { id: true, ownerUserId: true },
      });
      assertAccountAccess(requirePrincipal(req), acc, body.accountId);
      if (!acc) throw new NotFoundError(`账号 ${body.accountId} 不存在`);
    }

    const { parsed, rendered } = await build(body.contentHtml, {
      title: body.title,
      digest: body.digest,
    });

    const article = await prisma.article.create({
      data: {
        trackId: body.trackId ?? null,
        accountId: body.accountId ?? null,
        angleId: body.angleId ?? null,
        title: rendered.title,
        digest: rendered.digest,
        contentHtml: body.contentHtml,
        contentWechat: rendered.contentWechat,
        // 这是外部唯一能直接写 coverPath 的入口，必须归一化成相对路径，
        // 否则一台机器的绝对路径被固化进库，换机器后静默无封面。
        coverPath: body.coverPath ? toRelativeCoverPath(body.coverPath.trim()) : '',
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        idempotencyKey: randomUUID(),
        pushDate: '',
        status: 'draft',
      },
    });

    res.status(201).json({
      id: article.id,
      title: rendered.title,
      digest: rendered.digest,
      h2Count: parsed.h2Count,
      pCount: parsed.pCount,
      charCount: parsed.charCount,
      boldCount: parsed.boldCount,
      status: article.status,
      warnings: parsed.warnings,
    });
  }),
);

/**
 * 列表：供前端文章页使用。支持 status / accountId / angleId / pipeline 过滤与分页。
 * 默认按创建时间倒序，返回精简字段（不含正文，避免列表响应过大）。
 */
articlesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const angleId = req.query.angleId ? Number(req.query.angleId) : undefined;
    // 产线过滤：'article' | 'comic'；不传则不过滤（兼容旧前端）
    const pipeline =
      typeof req.query.pipeline === 'string' && ['article', 'comic'].includes(req.query.pipeline)
        ? req.query.pipeline
        : undefined;
    const limitRaw = req.query.limit ? Number(req.query.limit) : 20;
    const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const principal = requirePrincipal(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (accountId && Number.isFinite(accountId)) where.accountId = accountId;
    if (angleId && Number.isFinite(angleId)) where.angleId = angleId;
    if (pipeline) where.pipeline = pipeline;
    // P3 归属过滤：member 只见自己账号名下的文章
    if (!isAdmin(principal)) where.account = { ownerUserId: principal.userId ?? -1 };

    const [rows, total] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          title: true,
          status: true,
          accountId: true,
          chars: true,
          blocks: true,
          mediaId: true,
          pushDate: true,
          pipeline: true,
          createdAt: true,
        },
      }),
      prisma.article.count({ where }),
    ]);

    const accIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is number => x != null))];
    const accs = accIds.length
      ? await prisma.oAAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(accs.map((a) => [a.id, a.name] as const));

    res.json({
      total,
      limit,
      offset,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        account: r.accountId != null ? nameById.get(r.accountId) ?? null : null,
        accountId: r.accountId,
        chars: r.chars,
        blocks: r.blocks,
        mediaId: r.mediaId,
        pushDate: r.pushDate,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }),
);

articlesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.article.findUnique({ where: { id }, include: { account: { select: { ownerUserId: true } }, track: { select: { name: true } } } });
    assertArticleAccess(requirePrincipal(req), a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);
    res.json({
      id: a.id,
      title: a.title,
      digest: a.digest,
      trackId: a.trackId,
      accountId: a.accountId,
      angleId: a.angleId,
      contentHtml: a.contentHtml,
      contentWechat: a.contentWechat,
      coverPath: a.coverPath,
      coverMediaId: a.coverMediaId,
      coverUploaded: a.coverUploaded,
      mediaId: a.mediaId,
      status: a.status,
      pushDate: a.pushDate,
      blocks: a.blocks,
      chars: a.chars,
      createdAt: a.createdAt.toISOString(),
      // 产线与漫画元数据：前端靠 pipeline 判断是否走「漫画模式」（格图面板）。
      // 之前漏了这两个字段 → 漫画文章在改稿页被当成普通文章渲染，根本看不到生图入口。
      pipeline: a.pipeline,
      comicJson: unpackJson<Record<string, unknown> | null>(a.comicJson),
    });
  }),
);

/**
 * 删除单篇文章。角度回收语义与 deleteAccount 一致：
 *  - 未送达微信（draft/updated/failed）的文章，其占用的角度归还池中，可再次选题；
 *  - 已推送（pushed）的不归还，否则同一选题会被再写一遍。
 *
 * 语义实现放在 services/article-delete.ts：批量删除复用同一份规则，避免两边漂移。
 */
articlesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const principal = requirePrincipal(req);
    const result = await deleteArticleById(id, principal);
    res.json({ ok: true, ...result });
  }),
);

/**
 * 批量删除文章。
 *
 * 与单条删除共用 services/article-delete.ts 的角度回收规则。
 * 逐条独立执行：一条失败不影响其余，失败原因原样返回给前端展示。
 *
 * 路由顺序：'/bulk-delete' 是字母路径，必须排在 '/:id(\\d+)' 之前
 * （虽然数字约束本身也能挡住，但按项目约定固定路径一律前置）。
 */
articlesRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const { ids } = bulkDeleteSchema.parse(req.body ?? {});
    const principal = requirePrincipal(req);
    const result = await runBulkDelete(
      ids,
      async (id) => {
        const r = await deleteArticleById(id, principal);
        return { recycledAngles: r.recycledAngle ? 1 : 0 };
      },
      '文章',
    );
    res.json(result);
  }),
);

/** 实时预览：用同一渲染函数重渲染最新 contentHtml（与推送产物完全一致）。 */
articlesRouter.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.article.findUnique({ where: { id }, include: { account: { select: { ownerUserId: true } }, track: { select: { name: true } } } });
    assertArticleAccess(requirePrincipal(req), a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);
    const { parsed, rendered } = await build(a.contentHtml, {});

    // 漫画的推送产物是「插图序列 + 金句卡」，由 ensureComicAssetsReady 现算并落库。
    // 预览必须给落库产物，否则「预览 ≠ 推送产物」（改稿页会看到文字脚本，与实际推送不符）。
    // 尚未就绪时退回脚本文字，并如实标注还差几格。
    if (a.pipeline === 'comic') {
      const pending = await prisma.comicPanel.count({
        where: { articleId: id, status: { not: 'success' } },
      });
      // 已落库的推送产物（微信图床 URL）优先，维持「预览 = 推送产物」
      let contentWechat: string | null = pending === 0 && a.contentWechat ? a.contentWechat : null;
      const comicReady = contentWechat !== null;
      let message = '';
      if (pending === 0 && contentWechat === null) {
        // 全格成功但尚未上传（本地开发常见：出口 IP 不在微信白名单，上传撞 40164）→
        // 用本地文件组同序「金句卡 + 插图」序列：预览立即可见，推送时仍替换为图床 URL
        const local = await buildLocalComicPreview(a);
        if (local.ok) {
          contentWechat = local.html;
          message = '本地预览：图片为本地文件（未上传微信），推送时自动替换为图床链接';
        } else {
          message = local.message;
        }
      } else if (!comicReady) {
        message = `插图未就绪（还差 ${pending} 格），当前显示的是台词脚本`;
      }
      res.json({
        id: a.id,
        title: a.title,
        digest: a.digest,
        contentWechat: contentWechat ?? rendered.contentWechat,
        h2Count: parsed.h2Count,
        pCount: parsed.pCount,
        charCount: parsed.charCount,
        boldCount: parsed.boldCount,
        warnings: parsed.warnings,
        // comicReady 语义不变：是否为落库的推送产物（本地预览=false，推送门禁不受影响）
        comicReady,
        comicPending: pending,
        message,
      });
      return;
    }

    res.json({
      id: a.id,
      title: rendered.title,
      digest: rendered.digest,
      contentWechat: rendered.contentWechat,
      h2Count: parsed.h2Count,
      pCount: parsed.pCount,
      charCount: parsed.charCount,
      boldCount: parsed.boldCount,
      warnings: parsed.warnings,
      // 成稿体检：与推送门禁同一套规则，改稿页据此提示「现在能不能推、还差什么」。
      lint: a.pipeline === 'comic' ? null : lintArticle(a.contentHtml, parsed, a.track?.name ?? '', (await loadTrackRule(a.track?.name ?? '')).checks),
    });
  }),
);

/**
 * 成稿体检：只算不落库，返回与推送门禁完全一致的判定。
 * 漫画产线不适用（正文是图片序列），返回 lint:null。
 */
articlesRouter.get(
  '/:id/lint',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.article.findUnique({ where: { id }, include: { account: { select: { ownerUserId: true } }, track: { select: { name: true } } } });
    assertArticleAccess(requirePrincipal(req), a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);
    const trackName = a.track?.name ?? '';
    const lint =
      a.pipeline === 'comic' ? null : lintArticle(a.contentHtml, undefined, trackName, (await loadTrackRule(trackName)).checks);
    res.json({ id: a.id, pipeline: a.pipeline, lint });
  }),
);

/** 在线改稿：保存新 contentHtml 并重算 contentWechat / 统计。 */
articlesRouter.put(
  '/:id/content',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateContentSchema.parse(req.body);
    const a = await prisma.article.findUnique({ where: { id }, include: { account: { select: { ownerUserId: true } }, track: { select: { name: true } } } });
    assertArticleAccess(requirePrincipal(req), a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);

    const { parsed, rendered } = await build(body.contentHtml, {});

    // 漫画：格数即分镜数，改稿时不允许增减（否则与 ComicPanel.seq 错位，图对不上台词）。
    if (a.pipeline === 'comic') {
      const panelCount = await prisma.comicPanel.count({ where: { articleId: id } });
      if (parsed.h2Count !== panelCount) {
        throw new BadRequestError(
          `漫画正文中不可增减格数：当前 ${panelCount} 格，提交的是 ${parsed.h2Count} 格。请只修改台词文字，增删分镜请到漫画编辑页操作`,
        );
      }
    }

    const updated = await prisma.article.update({
      where: { id },
      data: {
        contentHtml: body.contentHtml,
        // 漫画正文由图片序列构成，改台词不改写推送产物（contentWechat 由格图与金句卡现算）
        contentWechat: a.pipeline === 'comic' ? a.contentWechat : rendered.contentWechat,
        title: rendered.title,
        digest: rendered.digest,
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        // 改稿后内容已变，推送态回退为草稿，需重新推送
        status: a.status === 'pushed' ? 'draft' : a.status,
      },
    });

    res.json({
      id: updated.id,
      title: rendered.title,
      digest: rendered.digest,
      contentWechat: rendered.contentWechat,
      h2Count: parsed.h2Count,
      pCount: parsed.pCount,
      charCount: parsed.charCount,
      boldCount: parsed.boldCount,
      status: updated.status,
      warnings: parsed.warnings,
      lint: a.pipeline === 'comic' ? null : lintArticle(body.contentHtml, parsed, a.track?.name ?? '', (await loadTrackRule(a.track?.name ?? '')).checks),
    });
  }),
);

/**
 * 推送草稿：与自动调度共用 `pushArticleToDraft`（services/publisher.ts），
 * 保证手动与自动走同一套逻辑：仅当账号 credStatus==='ok' 才执行，且只写草稿箱（绝不群发）。
 * 失败（含 40164 白名单、40013 凭据错）一律以 HTTP 200 + ok:false 返回，不崩溃。
 */
articlesRouter.post(
  '/:id/push',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    // P3 入口层归属校验（pushArticleToDraft 服务层另有兜底）
    const pa = await prisma.article.findUnique({ where: { id }, select: { accountId: true, account: { select: { ownerUserId: true } } } });
    assertArticleAccess(requirePrincipal(req), { accountId: pa?.accountId ?? null, account: pa?.account ?? null }, id);
    const result = await pushArticleToDraft(id);
    res.status(200).json(result);
  }),
);

const coverSchema = z.object({
  prompt: z.string().trim().max(1000).optional(),
  size: z.enum(['1K', '2K', '3K', '4K']).optional(),
  ratio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/, '宽高比格式形如 21:9')
    .optional(),
});

/**
 * 生成封面：用「封面」角色绑定的生图模型产出配图，写入 Article.coverPath。
 * 推送时 publisher 会自动把该文件作为封面素材上传（不群发，只进草稿箱）。
 */
articlesRouter.post(
  '/:id/cover',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = coverSchema.parse(req.body ?? {});
    const pa = await prisma.article.findUnique({ where: { id }, select: { accountId: true, account: { select: { ownerUserId: true } } } });
    assertArticleAccess(requirePrincipal(req), { accountId: pa?.accountId ?? null, account: pa?.account ?? null }, id);
    const result = await generateCoverForArticle(id, body);
    res.status(200).json(result);
  }),
);
