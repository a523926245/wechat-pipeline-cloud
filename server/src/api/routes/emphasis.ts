/**
 * 强调自动补全路由：预览将要补哪些 + 应用到文章。
 *
 * 应用后必须重新 parse → render，保证 contentWechat（推送产物）与预览一致——
 * 这是阶段 3 定下的「preview/push 共用同一渲染函数」不变量。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { asyncHandler } from '../async-handler.ts';
import { NotFoundError } from '../../errors.ts';
import { processEmphasis, DEFAULT_MIN, DEFAULT_MAX } from '../../services/emphasis.ts';
import { parseArticle } from '../../services/parse/index.ts';
import { renderArticle } from '../../services/render/index.ts';

const emphasisRouter = Router();

const previewSchema = z.object({
  contentHtml: z.string().min(1),
  min: z.number().int().min(1).max(40).optional(),
  max: z.number().int().min(1).max(40).optional(),
  keyMin: z.number().int().min(0).max(10).optional(),
});

/** 预览：不动库，只返回补强后的 HTML 与统计。 */
emphasisRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = previewSchema.parse(req.body);
    const result = processEmphasis(
      body.contentHtml,
      body.min ?? DEFAULT_MIN,
      body.max ?? DEFAULT_MAX,
      body.keyMin ?? 2,
    );
    res.json({
      contentHtml: result.contentHtml,
      changed: result.changed,
      stats: result.stats,
    });
  }),
);

/** 应用到指定文章：补强后重新解析渲染，写回 contentHtml + contentWechat。 */
emphasisRouter.post(
  '/articles/:id',
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) throw new NotFoundError(`文章 ${id} 不存在`);

    const body = previewSchema.partial({ contentHtml: true }).parse(req.body);
    const srcHtml = body.contentHtml ?? article.contentHtml;
    const result = processEmphasis(srcHtml, body.min ?? DEFAULT_MIN, body.max ?? DEFAULT_MAX, body.keyMin ?? 2);

    const parsed = parseArticle(result.contentHtml);
    const rendered = renderArticle(parsed);

    const updated = await prisma.article.update({
      where: { id },
      data: {
        contentHtml: result.contentHtml,
        contentWechat: rendered.contentWechat,
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        status: article.status === 'pushed' ? 'updated' : article.status,
        note: result.changed ? '已由强调补全服务自动补加粗/升级红字' : article.note,
      },
    });

    res.json({
      id: updated.id,
      changed: result.changed,
      stats: result.stats,
      title: rendered.title,
      digest: rendered.digest,
      contentWechat: rendered.contentWechat,
    });
  }),
);

export { emphasisRouter };
