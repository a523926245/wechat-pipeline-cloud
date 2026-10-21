/**
 * 漫画渲染：contentWechat = f(contentHtml 的 h1/h2/p, ComicPanel.wechatUrl, 金句卡文件)。
 *
 * 「预览 = 推送产物」不变量的漫画版：正文是「金句卡 + 插图」交替的纯图片序列，
 * 不含台词文字（台词在图片气泡里，与用户现有发布形态一致）。
 *
 * 图片必须先上传微信拿 mmbiz URL 才能嵌正文：
 *   - 插图 ComicPanel.wechatUrl 由 ensureComicAssetsReady 上传并回填（uploadedKey 复用判据同封面）
 *   - 金句卡在渲染时确定性生成/复用（comics/quote-{seq}.jpg），随插图一起上传
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '../../db.ts';
import { unpackJson } from '../../db-json.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { CONTENT_DIR, ensureContentDirs } from '../../config.ts';
import { parseArticle, ALL_MARK_RE } from '../parse/index.ts';
import { renderQuoteCard, QUOTE_CARD_VERSION } from '../imaging/quote-card.ts';
import { WechatClient } from '../wechat.ts';
import type { Article, ComicPanel } from '@prisma/client';

export interface ComicComicMeta {
  styleAnchor?: string;
  unitCount?: number;
  genWidth?: number;
  genHeight?: number;
}

export function readComicMeta(article: Article): ComicComicMeta {
  return unpackJson<ComicComicMeta>(article.comicJson) ?? {};
}

/** 金句卡相对路径名（comics/quote-{seq}-v{VER}.jpg）；版本号变化即令旧文件/旧上传态失配。 */
export function quoteCardRelName(seq: number): string {
  return `quote-${seq}-v${QUOTE_CARD_VERSION}.jpg`;
}

/** 金句卡文件绝对路径。 */
function quoteCardAbsPath(seq: number): string {
  return join(ensureContentDirs().comics, quoteCardRelName(seq));
}

/**
 * 生成（或复用）第 seq 格的金句卡并返回绝对路径。
 * headline/elaboration 从 contentHtml 的语义化结构取：
 * blocks 顺序为 h2,p,h2,p,...（write.ts 的固定结构），第 seq 单元 = 第 seq 个 h2 与第 seq 个 p。
 */
export async function ensureQuoteCard(article: Article, seq: number): Promise<string> {
  const parsed = parseArticle(article.contentHtml);
  const h2s = parsed.blocks.filter((b) => b.tag === 'h2');
  const ps = parsed.blocks.filter((b) => b.tag === 'p');
  const headline = (h2s[seq - 1]?.text ?? '').replace(ALL_MARK_RE, '').trim();
  const elaboration = (ps[seq - 1]?.text ?? '').replace(ALL_MARK_RE, '').trim();
  if (!headline) {
    throw new BadRequestError(`漫画 ${article.id} 第 ${seq} 格缺少论点标题，无法渲染金句卡`);
  }
  const out = quoteCardAbsPath(seq);
  if (!existsSync(out)) {
    await renderQuoteCard({ headline, elaboration, outPath: out });
  }
  return out;
}

/**
 * 确保所有格图与金句卡都已上传到当前账号，回填 wechatUrl，并返回渲染好的正文 HTML。
 * 复用判据 uploadedKey = "<accountId>:<相对路径>"（与封面 coverUploaded 同款）。
 */
export async function ensureComicAssetsReady(
  articleId: number,
): Promise<{ ok: true; contentWechat: string } | { ok: false; message: string }> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) throw new NotFoundError(`文章 ${articleId} 不存在`);
  if (article.pipeline !== 'comic') throw new BadRequestError(`文章 ${articleId} 不是漫画产线`);
  if (!article.accountId) return { ok: false, message: '未绑定账号' };

  const panels = await prisma.comicPanel.findMany({
    where: { articleId },
    orderBy: { seq: 'asc' },
  });
  if (panels.length === 0) return { ok: false, message: '漫画还没有任何分镜格' };
  const notReady = panels.filter((p) => p.status !== 'success' || !p.filePath);
  if (notReady.length > 0) {
    return {
      ok: false,
      message: `尚有 ${notReady.length}/${panels.length} 格未生成（第 ${notReady.map((p) => p.seq).join(',')} 格）`,
    };
  }

  const client = await WechatClient.fromAccountId(article.accountId);
  const key = (rel: string) => `${article.accountId}:${rel}`;
  const imgTags: string[] = [];

  for (const panel of panels) {
    // 插图：已上传且文件没变 → 复用；否则重传
    let url = panel.wechatUrl;
    if (!url || panel.uploadedKey !== key(panel.filePath)) {
      const abs = join(CONTENT_DIR, panel.filePath);
      if (!existsSync(abs)) return { ok: false, message: `第 ${panel.seq} 格图片文件缺失：${panel.filePath}` };
      url = await client.uploadContentImage(abs);
      await prisma.comicPanel.update({
        where: { id: panel.id },
        data: { wechatUrl: url, uploadedKey: key(panel.filePath) },
      });
    }
    imgTags.push(imgHtml(url));
    // 金句卡：先确保渲染，再上传（金句卡状态不进库，以文件存在 + uploadedKey 推导）
    // 文件名带版号：改版后旧 quote-{seq}.jpg 与旧上传态 key 自然失配 → 重渲重传。
    const quoteRel = `comics/${quoteCardRelName(panel.seq)}`;
    const quoteAbs = quoteCardAbsPath(panel.seq);
    if (!existsSync(quoteAbs)) {
      await ensureQuoteCard(article, panel.seq);
    }
    const quoteMeta = readUploadKey(article, quoteRel);
    if (!quoteMeta || quoteMeta.key !== key(quoteRel)) {
      const quoteUrl = await client.uploadContentImage(quoteAbs);
      imgTags.push(imgHtml(quoteUrl));
      saveUploadKey(article, quoteRel, key(quoteRel), quoteUrl);
    } else {
      imgTags.push(imgHtml(quoteMeta.url));
    }
  }

  const contentWechat = `<section>${imgTags.join('')}</section>`;
  await prisma.article.update({ where: { id: articleId }, data: { contentWechat } });
  return { ok: true, contentWechat };
}

function imgHtml(url: string): string {
  return `<p style="text-align:center;margin:0 0 4px;"><img src="${url}" style="width:100%;display:block;height:auto;" /></p>`;
}

// 金句卡上传态不建表（plan §2.4），用轻量 JSON 文件落盘在 comics/ 下
// （quote-upload-state.json），换账号自动失效。若未来需要多账号频繁互推，再升级为库表。

interface QuoteUploadState {
  // quoteKey -> { key, url }
  [quoteKey: string]: { key: string; url: string };
}

function uploadStatePath(): string {
  return join(ensureContentDirs().comics, 'quote-upload-state.json');
}

function readUploadKey(_article: Article, quoteKey: string): { key: string; url: string } | null {
  const p = uploadStatePath();
  if (!existsSync(p)) return null;
  try {
    const state = JSON.parse(readFileSync(p, 'utf8')) as QuoteUploadState;
    return state[quoteKey] ?? null;
  } catch {
    return null;
  }
}

function saveUploadKey(_article: Article, quoteKey: string, key: string, url: string): void {
  const p = uploadStatePath();
  let state: QuoteUploadState = {};
  if (existsSync(p)) {
    try {
      state = JSON.parse(readFileSync(p, 'utf8')) as QuoteUploadState;
    } catch {
      state = {};
    }
  }
  state[quoteKey] = { key, url };
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export type { ComicPanel };
