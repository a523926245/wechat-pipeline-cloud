/**
 * AI 改写路由：预览将要改成什么样 + 应用到文章。
 *
 * 应用后必须重新 parse → render，保证 contentWechat（推送产物）与预览一致——
 * 这是阶段 3 定下的「preview/push 共用同一渲染函数」不变量，与 emphasis 一致。
 *
 * 未绑定 revise 角色 / 模型停用 / 能力不匹配时，llm.assertRoleUsable 会抛
 * BadRequestError（400 + 可读文案），不会 500。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { asyncHandler } from '../async-handler.ts';
import { NotFoundError } from '../../errors.ts';
import { reviseHtml } from '../../services/revise.ts';
import { parseArticle } from '../../services/parse/index.ts';
import { renderArticle } from '../../services/render/index.ts';

const reviseRouter = Router();

const idParam = z.coerce.number().int().positive();

const schema = z.object({
  contentHtml: z.string().min(1, '正文不能为空'),
  mode: z.enum(['polish', 'rewrite', 'shorten']).optional().default('polish'),
  instruction: z.string().trim().max(500).optional(),
});

/** 预览：不动库，只返回改写后的 HTML。 */
reviseRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const body = schema.parse(req.body);
    const result = await reviseHtml(body.contentHtml, {
      mode: body.mode,
      instruction: body.instruction,
    });
    res.json({
      contentHtml: result.contentHtml,
      modelName: result.modelName,
      changed: result.changed,
    });
  }),
);

/** 应用到指定文章：改写后重新解析渲染，写回 contentHtml + contentWechat。 */
reviseRouter.post(
  '/articles/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const article = await prisma.article.findUnique({ where: { id } });
    if (!article) throw new NotFoundError(`文章 ${id} 不存在`);

    const body = schema.partial({ contentHtml: true }).parse(req.body ?? {});
    const srcHtml = body.contentHtml ?? article.contentHtml;

    const result = await reviseHtml(srcHtml, { mode: body.mode, instruction: body.instruction });

    const parsed = parseArticle(result.contentHtml);
    const rendered = renderArticle(parsed);

    const updated = await prisma.article.update({
      where: { id },
      data: {
        contentHtml: result.contentHtml,
        contentWechat: rendered.contentWechat,
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        // 已推送的文章改稿后需重新推送
        status: article.status === 'pushed' ? 'updated' : article.status,
        note: result.changed ? `已由模型「${result.modelName}」改写` : article.note,
      },
    });

    res.json({
      id: updated.id,
      changed: result.changed,
      modelName: result.modelName,
      title: rendered.title,
      digest: rendered.digest,
      contentWechat: rendered.contentWechat,
    });
  }),
);

export { reviseRouter };
