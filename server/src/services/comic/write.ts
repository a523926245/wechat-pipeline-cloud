/**
 * 漫画建稿服务：脚本 → Article(pipeline='comic') + N×ComicPanel(pending)。
 *
 * contentHtml 存语义化结构（h1 标题 / h2 论点标题 / p 论点阐释），
 * 与文章产线共用 parse 链路；**台词不进正文**（成品正文是纯图片序列）。
 * contentWechat 此时刻意留空——半成品不该能被推送，publisher 的
 * empty_content 校验会拦住；全部格图就绪后由 render/comic.ts 现算填充。
 */

import { randomUUID } from 'node:crypto';

import type { OAAccount, Angle, Track } from '@prisma/client';

import { prisma } from '../../db.ts';
import { packJson } from '../../db-json.ts';
import { todayKey } from '../../lib/day.ts';
import { generateComicScript, type ComicScript, type ScriptOptions } from './script.ts';

const DEFAULT_GEN_SIZE = { width: 2624, height: 1472 };

export interface ComicDraftResult {
  articleId: number;
  title: string;
  unitCount: number;
  modelUsed: string;
}

async function getComicTitlePrefix(): Promise<string> {
  const s = await prisma.setting.findUnique({ where: { k: 'comic_title_prefix' } });
  const v = s?.v ?? '【漫】';
  return typeof v === 'string' ? v : '【漫】';
}

/**
 * 为账号生成一篇漫画草稿（只建稿件与格行，不生图）。
 */
export async function createComicDraft(
  account: OAAccount,
  angle: Angle,
  track: Track,
  opts: ScriptOptions = {},
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

  const article = await prisma.article.create({
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
      }),
    },
  });

  await prisma.comicPanel.createMany({
    data: script.units.map((u) => ({
      articleId: article.id,
      seq: u.seq,
      prompt: u.prompt,
      lines: u.bubble,
      status: 'pending',
    })),
  });

  await prisma.taskRun.create({
    data: {
      jobType: 'comic_script',
      status: 'success',
      trigger: 'manual',
      trackId: track.id,
      accountId: account.id,
      articleId: article.id,
      angleId: angle.id,
      runDate: todayKey(),
      attempt: 1,
      paramsJson: packJson({ unitCount: script.units.length, style: script.styleKey }),
      resultJson: packJson({ articleId: article.id, title: script.title }),
    },
  });

  return { articleId: article.id, title: article.title, unitCount: script.units.length, modelUsed: '' };
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
