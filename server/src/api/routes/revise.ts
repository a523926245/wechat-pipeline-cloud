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
import { requirePermission } from '../permissions.ts';
import { NotFoundError } from '../../errors.ts';
import { reviseHtml } from '../../services/revise.ts';
import { parseArticle } from '../../services/parse/index.ts';
import { renderArticle } from '../../services/render/index.ts';
import { lintArticle, type LintReport } from '../../services/lint.ts';
import { recordLintRun, type LintRunBrief } from '../../services/lint-store.ts';
import { loadTrackRule } from '../../services/style-prompts.ts';

const reviseRouter = Router();

// P2 RBAC：本路由统一权限点
reviseRouter.use(requirePermission('content:revise'));

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

/** 应用到指定文章：改写后重新解析渲染，写回 contentHtml + contentWechat，并对**最终正文**复检。 */
reviseRouter.post(
  '/articles/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const article = await prisma.article.findUnique({
      where: { id },
      include: { track: { select: { name: true } } },
    });
    if (!article) throw new NotFoundError(`文章 ${id} 不存在`);

    const body = schema.partial({ contentHtml: true }).parse(req.body ?? {});
    const srcHtml = body.contentHtml ?? article.contentHtml;

    const result = await reviseHtml(srcHtml, { mode: body.mode, instruction: body.instruction });

    const parsed = parseArticle(result.contentHtml);
    const rendered = renderArticle(parsed);

    // 先落库：改写正文已经生成，绝不能因为后面体检出问题就把它丢掉。
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

    // ── 改写后自动复检（S5-1）──
    // 检查对象必须是**刚存进去的最终正文**（result.contentHtml），不是改写前的 srcHtml。
    // 体检失败不影响已保存的改写结果；它只是把「现在这篇还差什么」如实报出来。
    // 注意：这里不构成推送门禁——推送时仍会再跑一次最新体检，两次结论可以不同。
    let lintReport: LintReport | null = null;
    let lintRun: LintRunBrief | null = null;
    let lintPersistError: string | undefined;
    try {
      const trackName = article.track?.name ?? '';
      const rule = await loadTrackRule(trackName);
      lintReport = lintArticle(updated.contentHtml, undefined, trackName, rule.checks, rule.relax);
      const rec = await recordLintRun({
        articleId: updated.id,
        trigger: 'revise',
        report: lintReport,
        contentHtml: updated.contentHtml,
        rule: { checks: rule.checks, relax: rule.relax },
      });
      lintRun = rec.run ?? null;
      lintPersistError = rec.error;
    } catch (e) {
      // 体检本身出错同样不能连累已保存的改写正文；如实告诉使用者「这次没检查成」。
      lintPersistError = e instanceof Error ? e.message : String(e);
    }

    res.json({
      id: updated.id,
      changed: result.changed,
      modelName: result.modelName,
      title: rendered.title,
      digest: rendered.digest,
      contentWechat: rendered.contentWechat,
      lint: lintReport,
      lintRun,
      lintPersistError,
      message: lintReport
        ? lintReport.ok
          ? `改写已保存并通过成稿体检${lintPersistError ? '（体检结果未能存档）' : ''}`
          : `改写已保存，但成稿体检发现 ${lintReport.errors.length} 个问题，推送时会被门禁拦下`
        : `改写已保存，但本次未能完成成稿体检${lintPersistError ? `（${lintPersistError}）` : ''}`,
    });
  }),
);

export { reviseRouter };
