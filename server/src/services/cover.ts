/**
 * 封面生成服务：用「封面(cover)」角色绑定的生图模型为文章生成封面配图。
 *
 * 此前「封面」角色只有枚举没有实现——publisher 只会上传本地已存在的 coverPath，
 * 全系统没有任何地方会「生成」封面。这里把它补上。
 *
 * 落盘到 CONTENT_DIR/covers（config.ts 的 ensureContentDirs 已保证目录存在），
 * 并把绝对路径写回 Article.coverPath —— publisher.pushArticleToDraft 已有
 * 「coverPath 存在就 uploadImage」的逻辑，因此无需改动推送链路。
 *
 * 失败一律抛 BadRequestError（400 + 可读文案），绝不落到 500。
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ensureContentDirs } from '../config.ts';
import { prisma } from '../db.ts';
import { BadRequestError, NotFoundError } from '../errors.ts';
import { logger } from '../logger.ts';
import { assertRoleUsable, generateImage } from './llm.ts';
import { toRelativeCoverPath } from './content-path.ts';

export interface CoverOptions {
  prompt?: string;
  size?: string;
  ratio?: string;
}

export interface CoverResult {
  ok: true;
  id: number;
  /** 相对 CONTENT_DIR 的 POSIX 相对路径（形如 covers/xxx.png），已写入 Article.coverPath。
   *  刻意不存绝对路径：绝对路径换机器就失效，会让 publisher 静默推无封面草稿。 */
  coverPath: string;
  /** 前端可直接用的相对 URL（经 /api/content 静态托管） */
  coverUrl: string;
  prompt: string;
  modelName: string;
  size: string;
  ratio: string;
  bytes: number;
  message: string;
}

/** 生图模型渲染中文极易出错，所以「画面里不许出现文字」是系统侧硬约束，不交给用户决定。 */
const HARD_CONSTRAINTS = [
  '画面中严格禁止出现任何文字、字母、数字、符号或水印',
  '不要出现品牌 Logo，不要出现人物正脸特写',
];

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 依据文章内容自动构造封面提示词。 */
function buildAutoPrompt(title: string, digest: string, bodyText: string, trackName: string): string {
  const gist = bodyText.slice(0, 300);
  return [
    `为一篇${trackName}主题的公众号文章绘制封面配图。`,
    `标题：${title}`,
    digest ? `摘要：${digest}` : '',
    gist ? `内容要点：${gist}` : '',
    '',
    '画面要求：',
    '1. 横向宽幅构图，主体偏右，左侧留出放置标题的留白',
    '2. 风格：扁平编辑插画或写实摄影，色彩克制，情绪与主题一致',
    '3. 有明确的场景与氛围，能让人一眼感受到文章的情绪',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 为文章生成封面。返回落盘路径与可预览 URL。
 */
export async function generateCoverForArticle(
  articleId: number,
  opts: CoverOptions = {},
): Promise<CoverResult> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) throw new NotFoundError(`文章 ${articleId} 不存在`);

  const title = stripTags(article.title ?? '') || '';
  const bodyText = stripTags(article.contentHtml ?? '');
  if (!title && !bodyText) {
    throw new BadRequestError('文章标题与正文都为空，无法生成封面');
  }

  let trackName = '综合';
  if (article.trackId != null) {
    const track = await prisma.track.findUnique({
      where: { id: article.trackId },
      select: { name: true },
    });
    if (track) trackName = track.name;
  }

  const basePrompt =
    opts.prompt?.trim() || buildAutoPrompt(title, stripTags(article.digest ?? ''), bodyText, trackName);
  const prompt = `${basePrompt}\n\n${HARD_CONSTRAINTS.join('；')}。`;

  // 未绑定 / 停用 / 能力不符都会在这里给出可读的 400
  const model = await assertRoleUsable('cover');

  const img = await generateImage(model, prompt, {
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.ratio ? { ratio: opts.ratio } : {}),
  });

  const filename = `cover-a${articleId}-${timestamp()}-${randomBytes(3).toString('hex')}.${img.ext}`;
  const { covers } = ensureContentDirs();
  const coverPath = join(covers, filename);

  try {
    writeFileSync(coverPath, img.bytes);
  } catch (e) {
    throw new BadRequestError(`封面写入失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!existsSync(coverPath) || statSync(coverPath).size === 0) {
    throw new BadRequestError('封面写入失败：文件未生成或为空');
  }

  // 只有写库用相对路径；落盘与校验全程用绝对路径。
  const coverRel = toRelativeCoverPath(coverPath);

  // 已推送的文章换了封面，要回退成草稿让调度/人工重新推一次；
  // 否则 status 仍是 pushed，scheduler 只取 draft，永远推不出去，界面上也看不出来。
  const wasPushed = article.status === 'pushed';

  await prisma.article.update({
    where: { id: articleId },
    data: {
      coverPath: coverRel,
      // 新封面 ≠ 已上传过的封面 → 让 publisher 重新上传并刷新 media_id
      coverMediaId: '',
      coverUploaded: '',
      ...(wasPushed ? { status: 'draft' as const } : {}),
      note: `封面由模型「${model.name}」生成${wasPushed ? '（封面已更新，需重新推送）' : ''}`,
    },
  });

  logger.info(
    { articleId, model: model.name, coverPath: coverRel, bytes: img.bytes.length, wasPushed },
    '封面生成完成',
  );

  return {
    ok: true,
    id: articleId,
    coverPath: coverRel,
    coverUrl: `/api/content/covers/${filename}`,
    prompt,
    modelName: model.name,
    size: img.size,
    ratio: img.ratio,
    bytes: img.bytes.length,
    message: `封面已生成（${model.name}，${(img.bytes.length / 1024).toFixed(0)} KB）`,
  };
}
