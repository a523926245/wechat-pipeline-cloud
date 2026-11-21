/**
 * 漫画建稿服务：脚本 → Article(pipeline='comic') + N×ComicPanel(pending)。
 *
 * contentHtml 存语义化结构（h1 标题 / h2 论点标题 / p 论点阐释），
 * 与文章产线共用 parse 链路；**台词不进正文**（成品正文是纯图片序列）。
 * contentWechat 此时刻意留空——半成品不该能被推送，publisher 的
 * empty_content 校验会拦住；全部格图就绪后由 render/comic.ts 现算填充。
 */

import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import type { OAAccount, Angle, Track } from '@prisma/client';

import { prisma } from '../../db.ts';
import { packJson } from '../../db-json.ts';
import { todayKey } from '../../lib/day.ts';
import { claimAngleInTx } from '../angle-claim.ts';
import { generateComicScript, type ComicScript, type ScriptOptions } from './script.ts';

const DEFAULT_GEN_SIZE = { width: 2624, height: 1472 };

export interface ComicDraftResult {
  articleId: number;
  title: string;
  unitCount: number;
  modelUsed: string;
}

/** 建稿附加开关（与脚本生成参数分开：这些是写库语义，不是提示词参数）。 */
export interface ComicDraftFlags {
  /**
   * 建稿成功时占用选题（S4-4-1 R4）。
   * - 手动建稿（POST /articles/comic/create）传 true：用户点一次建一篇，选题当场被消耗；
   * - 排产（planner）**不传**：路由前已用 reserveAnglesForPipeline 占用，重复占用会抛 409。
   */
  claimAngle?: boolean;
}

async function getComicTitlePrefix(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { k: 'comic_title_prefix' } });
  const v = s?.v ?? '【漫】';
  return typeof v === 'string' ? v : '【漫】';
}

/**
 * 为账号生成一篇漫画草稿（只建稿件与格行，不生图）。
 *
 * 事务边界（S4-4-1 R4）：脚本生成是一次外部 LLM 调用（几十秒），**不进事务**；
 * 「占用选题 + 建 Article + 建格行 + 记 TaskRun」四步在同一事务里一次完成——
 * 任一步失败全部回滚，不会留下「占了题没文章」或「有文章没格行」的半成品。
 */
export async function createComicDraft(
  account: OAAccount,
  angle: Angle,
  track: Track,
  opts: ScriptOptions = {},
  flags: ComicDraftFlags = {},
): Promise<ComicDraftResult> {
  const script: ComicScript = await generateComicScript(angle, track, opts);
  const prefix = await getComicTitlePrefix();

  // 论点标题进 h2、阐释进 p —— 与文章产线共用语义化约定
  const body = script.units
    .map((u) => `<h2>${escapeHtml(u.headline)}</h2>\n<p>${escapeHtml(u.elaboration)}</p>`)
    .join('\n');
  const contentHtml = `<h1>${escapeHtml(script.title)}</h1>\n${body}`;

  const blocks = script.units.length * 2;
  const chars = script.units.reduce((n, u) => n + u.headline.length + u.elaboration.length, 0);

  const article = await prisma.$transaction(async (tx) => {
    if (flags.claimAngle) {
      await claimAngleInTx(tx, angle.id, {
        id: account.id,
        name: account.name,
        ownerUserId: account.ownerUserId ?? null,
      });
    }

    const created = await tx.article.create({
      data: {
        trackId: track.id,
        accountId: account.id,
        angleId: angle.id,
        pipeline: 'comic',
        title: `${prefix}${script.title}`,
        digest: script.digest,
        contentHtml,
        contentWechat: '',
        blocks,
        chars,
        pushDate: '',
        status: 'draft',
        idempotencyKey: randomUUID(),
        note: `漫画脚本已就绪，待生成 ${script.units.length} 格插图`,
        comicJson: packJson({
          styleAnchor: script.styleKey,
          unitCount: script.units.length,
          genWidth: DEFAULT_GEN_SIZE.width,
          genHeight: DEFAULT_GEN_SIZE.height,
          createdAt: todayKey(),
        }) ?? Prisma.DbNull,
      },
    });

    await tx.comicPanel.createMany({
      data: script.units.map((u) => ({
        articleId: created.id,
        seq: u.seq,
        prompt: u.prompt,
        lines: u.bubble,
        status: 'pending',
      })),
    });

    await tx.taskRun.create({
      data: {
        jobType: 'comic_script',
        status: 'success',
        trigger: 'manual',
        trackId: track.id,
        accountId: account.id,
        articleId: created.id,
        angleId: angle.id,
        runDate: todayKey(),
        attempt: 1,
        paramsJson: packJson({ unitCount: script.units.length, style: script.styleKey }) ?? Prisma.DbNull,
        resultJson: packJson({ articleId: created.id, title: script.title }) ?? Prisma.DbNull,
      },
    });

    return created;
  });

  return { articleId: article.id, title: article.title, unitCount: script.units.length, modelUsed: '' };
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
