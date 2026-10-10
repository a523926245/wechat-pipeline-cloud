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
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { parseArticle } from '../../services/parse/index.ts';
import { renderArticle } from '../../services/render/index.ts';
import { pushArticleToDraft } from '../../services/publisher.ts';
import { asyncHandler } from '../async-handler.ts';

export const articlesRouter: Router = Router();

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

articlesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
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
        coverPath: body.coverPath ?? '',
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
 * 列表：供前端文章页使用。支持 status / accountId 过滤与分页。
 * 默认按创建时间倒序，返回精简字段（不含正文，避免列表响应过大）。
 */
articlesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const limitRaw = req.query.limit ? Number(req.query.limit) : 20;
    const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (accountId && Number.isFinite(accountId)) where.accountId = accountId;

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
          createdAt: true,
        },
      }),
      prisma.article.count({ where }),
    ]);

    const accIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is number => x != null))];
    const accs = accIds.length
      ? await prisma.account.findMany({ where: { id: { in: accIds } }, select: { id: true, name: true } })
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
    const a = await prisma.article.findUnique({ where: { id } });
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
      mediaId: a.mediaId,
      status: a.status,
      pushDate: a.pushDate,
      blocks: a.blocks,
      chars: a.chars,
    });
  }),
);

/** 实时预览：用同一渲染函数重渲染最新 contentHtml（与推送产物完全一致）。 */
articlesRouter.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.article.findUnique({ where: { id } });
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);
    const { parsed, rendered } = await build(a.contentHtml, {});
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
    });
  }),
);

/** 在线改稿：保存新 contentHtml 并重算 contentWechat / 统计。 */
articlesRouter.put(
  '/:id/content',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateContentSchema.parse(req.body);
    const a = await prisma.article.findUnique({ where: { id } });
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);

    const { parsed, rendered } = await build(body.contentHtml, {});
    const updated = await prisma.article.update({
      where: { id },
      data: {
        contentHtml: body.contentHtml,
        contentWechat: rendered.contentWechat,
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
    const result = await pushArticleToDraft(id);
    res.status(200).json(result);
  }),
);
