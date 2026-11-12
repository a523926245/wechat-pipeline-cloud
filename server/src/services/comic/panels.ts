/**
 * 漫画逐格生图服务（comic_panel 角色）。
 *
 * 行级状态机（ComicPanel.status + updatedAt）构成轮询队列，不引入任务队列框架：
 *   pending/failed 的格 → 生图 → 落盘 → multimodal QC → 不合格且未超重跑上限 → 重跑
 *   → 全部 success → ensureComicAssetsReady（上传 + 渲染 contentWechat）
 *
 * QC 策略（用户决策：全自动、不设人工关口）：
 *   - 用「改写」角色绑定的模型做读图 QC（要求 capability 含 multimodal）；
 *     若该模型不支持读图，跳过 QC 仅按生图成败处理（降级不阻塞）。
 *   - QC 四项：文字零错字 / 恰好一个气泡 / 无多余文字水印 / 构图符合场景。
 *     不合格自动重跑，attempt ≥ maxAttemptsPerPanel（默认 3）置 failed 停住，不推草稿箱。
 *
 * 并发与退避（P2）：
 *   - 同一篇文章的格**并行**生图，并发度 COMIC_IMAGE.concurrency（默认 2）。
 *     生图是纯 IO 等待，串行等于把 N×40s 堆在一次心跳里。
 *   - 失败后**指数退避**：第 n 次失败至少等 base*2^(n-1) ms 才重试，上限 retryMaxDelayMs。
 *     避免上游限流时「刚失败立刻重烧一次」，把 attempt 一口气耗光。
 *     退避窗口内的格本轮直接跳过（计入 skipped），下次心跳/手动触发再处理。
 *   - 单格重画（regeneratePanel）把 attempt 归零，因此不受退避影响，点了就立刻跑。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma, withLock } from '../../db.ts';
import { unpackJson } from '../../db-json.ts';
import { BadRequestError } from '../../errors.ts';
import { COMIC_IMAGE, CONTENT_DIR, ensureContentDirs } from '../../config.ts';
import { LOCK_COMIC_IMAGE, LOCK_TIMEOUT_SEC } from '../../constants.ts';
import { logger } from '../../logger.ts';
import { todayKey } from '../../lib/day.ts';
import { decryptSecret } from '../../lib/crypto.ts';
import { assertRoleUsable, generateImage, tryResolveForRole } from '../llm.ts';
import { ensureComicAssetsReady } from '../render/comic.ts';
import { loadComicTemplates } from './script.ts';
import type { LlmModel } from '@prisma/client';

interface ComicMeta {
  genWidth?: number;
  genHeight?: number;
  maxAttemptsPerPanel?: number;
}

function metaOf(article: { comicJson: unknown }): ComicMeta {
  return unpackJson<ComicMeta>(article.comicJson) ?? {};
}

/** 单格最大重跑次数缺省值。 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 第 n 次失败后的退避等待（毫秒）。指数退避 + 上限，attempt=0（未失败过）为 0。
 * 单独导出便于冒烟脚本直接断言，不必真发生图。
 */
export function panelBackoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  const raw = COMIC_IMAGE.retryBaseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, COMIC_IMAGE.retryMaxDelayMs);
}

/** 该格现在是否到期可重试（退避窗口内返回 false）。 */
export function isPanelDue(panel: { attempt: number; updatedAt: Date }, nowMs = Date.now()): boolean {
  const wait = panelBackoffMs(panel.attempt);
  if (wait <= 0) return true;
  return nowMs - panel.updatedAt.getTime() >= wait;
}

/**
 * 同心跳内的通道降级：先走主通道（comic_panel），失败立即切备选通道（comic_panel_fallback）。
 * 备选未绑定/不可用时直接抛主通道的错误——不引入新的重试环，退避与 attempt 语义仍由外层状态机管。
 */
async function generatePanelImage(
  primary: LlmModel,
  prompt: string,
  opts: { genWidth?: number; genHeight?: number; negativePrompt?: string },
): Promise<{ img: Awaited<ReturnType<typeof generateImage>>; via: 'primary' | 'fallback' }> {
  try {
    return { img: await generateImage(primary, prompt, opts), via: 'primary' };
  } catch (primaryErr) {
    const fb = await tryResolveForRole('comic_panel_fallback');
    if (!fb.usable || !fb.model) throw primaryErr;
    logger.warn(
      { primary: primary.name, fallback: fb.model.name, err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr) },
      '漫画格主通道失败，同心跳切换备选通道',
    );
    return { img: await generateImage(fb.model, prompt, opts), via: 'fallback' };
  }
}

/** 有序并发：限制同时进行的任务数，结果按输入顺序返回（失败由调用方处理）。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      // noUncheckedIndexedAccess 下索引结果是 T|undefined，这里 i 已确认在界内。
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return out;
}

/** 捞「还有格待生图」的漫画文章，按最旧更新优先。 */
async function pickPendingArticles(limit: number): Promise<number[]> {
  const rows = await prisma.article.findMany({
    where: { pipeline: 'comic', status: { in: ['draft', 'failed'] } },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    take: limit * 4,
  });
  const out: number[] = [];
  for (const r of rows) {
    // 只数 pending：failed 是终态（等人工重画），不能让终态格反复占推进名额。
    const pending = await prisma.comicPanel.count({
      where: { articleId: r.id, status: 'pending' },
    });
    if (pending > 0) out.push(r.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** multimodal 读图 QC 由 qcPanelByModel 实现（OpenAI 兼容 vision）；不支持时返回 null 降级放行。 */

/**
 * 推进漫画格生成。传 articleId 只处理该篇；否则全局捞（上限 maxPanelsPerRun 格）。
 * 返回推进摘要，供路由与调度展示。
 *
 * opts.limit 限制**本轮**最多处理几格：生图 30~40s/格，不限的话一次 HTTP 请求
 * 会挂好几分钟（代理超时、前端转圈）。「触发后自动生成」走 limit=1 的分批推进。
 */
export async function processComicImages(
  articleId?: number,
  opts: { limit?: number } = {},
): Promise<{
  processed: number;
  done: number;
  failed: number;
  /** 退避窗口内被跳过、等待下次重试的格数（既不算成功也不算失败）。 */
  skipped: number;
  articleReady: number[];
  details: { articleId: number; seq: number; ok: boolean; message: string }[];
}> {
  const limit = Math.max(1, Math.floor(opts.limit ?? (articleId ? 100 : COMIC_IMAGE.maxPanelsPerRun)));
  const articleIds = articleId ? [articleId] : await pickPendingArticles(limit);
  const details: { articleId: number; seq: number; ok: boolean; message: string }[] = [];
  let done = 0;
  let failed = 0;
  let skipped = 0;
  const articleReady: number[] = [];

  if (articleIds.length === 0) {
    return { processed: 0, done: 0, failed: 0, skipped: 0, articleReady, details };
  }

  const model = await assertRoleUsable('comic_panel');
  const tpl = loadComicTemplates();

  for (const aid of articleIds) {
    const article = await prisma.article.findUnique({ where: { id: aid } });
    if (!article) continue;
    const meta = metaOf(article);
    const maxAttempts = meta.maxAttemptsPerPanel ?? DEFAULT_MAX_ATTEMPTS;
    const panels = await prisma.comicPanel.findMany({
      // 只取 pending：failed 是终态（需人工单格重画），不占推进名额也不会被反复刷。
      where: { articleId: aid, status: 'pending' },
      orderBy: { seq: 'asc' },
      take: limit,
    });

    // 先分流出「退避中」的格，再并发处理剩下的。
    const nowMs = Date.now();
    const due: typeof panels = [];
    for (const panel of panels) {
      if (panel.attempt > 0 && !isPanelDue(panel, nowMs)) {
        const waitSec = Math.ceil((panelBackoffMs(panel.attempt) - (nowMs - panel.updatedAt.getTime())) / 1000);
        details.push({ articleId: aid, seq: panel.seq, ok: false, message: `退避中：第 ${panel.attempt} 次失败，约 ${waitSec}s 后重试` });
        skipped += 1;
        continue;
      }
      if (panel.attempt >= maxAttempts) {
        await prisma.comicPanel.update({
          where: { id: panel.id },
          data: { status: 'failed', errorMsg: `已达重跑上限 ${maxAttempts}`.slice(0, 500) },
        });
        details.push({ articleId: aid, seq: panel.seq, ok: false, message: `已达重跑上限 ${maxAttempts}` });
        failed += 1;
        continue;
      }
      due.push(panel);
    }

    await mapLimit(due, COMIC_IMAGE.concurrency, async (panel) => {
      try {
        const { img, via } = await generatePanelImage(model, panel.prompt, {
          genWidth: meta.genWidth,
          genHeight: meta.genHeight,
          negativePrompt: tpl.negativePrompt,
        });
        if (via === 'fallback') {
          details.push({ articleId: aid, seq: panel.seq, ok: true, message: '主通道失败，已由备选通道生成' });
        }
        const rel = `comics/ill-${panel.seq}-${Date.now().toString(36)}-${panel.id}.${img.ext}`;
        const abs = join(CONTENT_DIR, rel);
        mkdirSync(ensureContentDirs().comics, { recursive: true });
        writeFileSync(abs, img.bytes);
        if (!existsSync(abs) || statSync(abs).size === 0) {
          throw new BadRequestError(`第 ${panel.seq} 格写入失败`);
        }

        // QC（全自动）：multimodal 模型读图；不支持则降级放行
        const qcModel = await qcModelOrNull();
        if (qcModel) {
          const verdict = await qcPanelByModel(qcModel, abs, panel);
          if (verdict && !verdict.ok) {
            const attempt = panel.attempt + 1;
            await prisma.comicPanel.update({
              where: { id: panel.id },
              data: { attempt, status: attempt >= maxAttempts ? 'failed' : 'pending', errorMsg: verdict.reason ?? 'QC 不合格' },
            });
            details.push({ articleId: aid, seq: panel.seq, ok: false, message: `QC 不合格：${verdict.reason ?? ''}（第 ${attempt} 次）` });
            failed += 1;
            return;
          }
        }

        await prisma.comicPanel.update({
          where: { id: panel.id },
          data: { status: 'success', filePath: rel, bytes: img.bytes.length, errorMsg: '', attempt: panel.attempt + 1 },
        });
        done += 1;
        details.push({ articleId: aid, seq: panel.seq, ok: true, message: `已生成 ${(img.bytes.length / 1024).toFixed(0)}KB` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const attempt = panel.attempt + 1;
        await prisma.comicPanel.update({
          where: { id: panel.id },
          data: { attempt, status: attempt >= maxAttempts ? 'failed' : 'pending', errorMsg: msg.slice(0, 500) },
        });
        details.push({ articleId: aid, seq: panel.seq, ok: false, message: msg.slice(0, 200) });
        failed += 1;
      }
    });

    // 该篇是否全部就绪 → 上传 + 渲染正文
    const remain = await prisma.comicPanel.count({ where: { articleId: aid, status: { not: 'success' } } });
    if (remain === 0) {
      try {
        const r = await ensureComicAssetsReady(aid);
        if (r.ok) {
          articleReady.push(aid);
          await prisma.article.update({ where: { id: aid }, data: { note: '漫画已就绪，可推送草稿箱' } });
        } else {
          await prisma.article.update({ where: { id: aid }, data: { note: `漫画未就绪：${r.message}`.slice(0, 500) } });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await prisma.article.update({ where: { id: aid }, data: { note: `漫画渲染失败：${msg}`.slice(0, 500) } });
        details.push({ articleId: aid, seq: 0, ok: false, message: `渲染失败：${msg.slice(0, 150)}` });
      }
    } else {
      // 有格未就绪：其中只要存在终态 failed，整篇就标 failed（界面上才能看出卡在哪一格）。
      // 注意：此前该分支写在 remain===0 里，是死代码 —— 有失败格时文章状态永远不更新。
      const failedSeqs = await prisma.comicPanel.findMany({
        where: { articleId: aid, status: 'failed' },
        select: { seq: true },
        orderBy: { seq: 'asc' },
      });
      if (failedSeqs.length > 0) {
        const seqs = failedSeqs.map((p) => p.seq).join(',');
        await prisma.article.update({
          where: { id: aid },
          data: {
            status: 'failed',
            note: `第 ${seqs} 格生成失败（已达重跑上限），可在漫画编辑页单格重画`.slice(0, 500),
          },
        });
      }
    }

    await prisma.taskRun.create({
      data: {
        jobType: 'comic_panel',
        status: failed > 0 ? 'failed' : 'success',
        trigger: 'manual',
        articleId: aid,
        runDate: todayKey(),
        attempt: 1,
        paramsJson: null,
        resultJson: null,
      },
    }).catch(() => undefined);
  }

  return { processed: articleIds.length, done, failed, skipped, articleReady, details };
}

/* ────────────────────────────────────────────────────────────
 * 后台自动推进（kick）
 *
 * 用户预期是「点了生成就等图」，不是「先拿脚本、再去文章页手动点生成」。
 * 但一篇 6 格串行生图要 3~4 分钟，塞进触发那次 HTTP 请求必然被超时切断
 * （Nginx/代理 300s、前端轮询都受不了）。所以触发时只建脚本，随后由这里
 * **fire-and-forget** 地逐格推进：每次只做 1 格（limit=1，单格几十秒即回），
 * 循环直到没有可推进的格或超出时间预算。
 *
 * 并发安全：
 *   - 进程内 Set 防同一篇被重复 kick；
 *   - 跨进程/跨请求由 LOCK_COMIC_IMAGE 兜底（MySQL 下的命名锁）；
 *   - 抢不到锁就直接放弃——调度心跳的阶段二还会再推进，不会永久卡住。
 * ──────────────────────────────────────────────────────────── */

const kicking = new Set<number>();

/** 该篇是否正在后台生图（面板接口据此禁用按钮、前端显示「生成中」）。 */
export function isComicGenerating(articleId: number): boolean {
  return kicking.has(articleId);
}

/**
 * 让某篇漫画的插图在后台跑起来。已在跑则直接返回 false（幂等）。
 * 不 await、不抛错——调用方（触发建稿、手动点按钮）不该被生图拖住。
 */
export function kickComicImages(articleId: number): boolean {
  if (kicking.has(articleId)) return false;
  kicking.add(articleId);

  void (async () => {
    const startedAt = Date.now();
    try {
      const ran = await withLock(LOCK_COMIC_IMAGE, LOCK_TIMEOUT_SEC, async () => {
        let rounds = 0;
        for (;;) {
          const r = await processComicImages(articleId, { limit: 1 });
          rounds += 1;
          // 没有可推进的格（全部就绪，或都在退避窗口里）→ 停，等下次触发/调度。
          if (r.done + r.failed === 0) break;
          if (Date.now() - startedAt >= COMIC_IMAGE.tickBudgetMs) {
            logger.info({ articleId, rounds }, '漫画自动生图达到时间预算，剩余格留给下次');
            break;
          }
        }
        return rounds;
      });
      if (ran === null) {
        logger.info({ articleId }, '漫画自动生图未抢到锁（已有任务在跑），交给调度阶段二推进');
      } else {
        logger.info({ articleId, rounds: ran, ms: Date.now() - startedAt }, '漫画自动生图结束');
      }
    } catch (e) {
      logger.error(
        { articleId, err: e instanceof Error ? e.message : String(e) },
        '漫画自动生图异常（可手动重试或由调度兜底）',
      );
    } finally {
      kicking.delete(articleId);
    }

    // 续跑：单轮的时间预算用尽（6 格 ≈ 4 分钟，预算默认 4 分钟）时，
    // 剩下的格不该让用户自己发现「5/6 卡住了」。只要还有 pending 就隔一会儿再来一轮，
    // 直到全部成功或全部变成终态 failed（那时 pending 归零，自然停）。
    try {
      const leftover = await prisma.comicPanel.count({ where: { articleId, status: 'pending' } });
      if (leftover > 0) {
        const timer = setTimeout(() => {
          kickComicImages(articleId);
        }, COMIC_IMAGE.continueDelayMs);
        timer.unref?.();
        logger.info({ articleId, leftover }, '漫画仍有待生成格，已安排自动续跑');
      }
    } catch {
      /* 续跑安排失败无所谓：用户打开文章页会自动 kick，调度阶段二也会兜底 */
    }
  })();

  return true;
}

/** QC 用 multimodal 模型：复用「改写」角色绑定，capability 必须是 multimodal；不可用返回 null。 */
async function qcModelOrNull(): Promise<LlmModel | null> {
  try {
    const r = await tryResolveForRole('revise');
    if (r.usable && r.model && r.model.capability === 'multimodal') return r.model;
    return null;
  } catch {
    return null;
  }
}

/**
 * multimodal 读图 QC 实现：OpenAI 兼容 vision 格式（image_url 为 data URI）。
 * 仅当 QC 模型协议为 openai_chat 时执行；否则返回 null（降级放行）。
 */
async function qcPanelByModel(
  model: LlmModel,
  imagePath: string,
  panel: { seq: number; lines: string },
): Promise<{ ok: boolean; reason?: string } | null> {
  if (model.protocol !== 'openai_chat') return null;
  const apiKey = decryptSecret(model.apiKeyEnc);
  if (!apiKey) return null;

  const b64 = readFileSync(imagePath).toString('base64');
  const dataUri = `data:image/${imagePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${b64}`;

  const expected = panel.lines || '（本格无台词）';
  const qcPrompt = [
    '你是公众号漫画质检员。只输出 JSON：{"ok":true} 或 {"ok":false,"reason":"原因","category":"类别"}。',
    `期望气泡台词：「${expected}」`,
    '逐字核对：把画面气泡里的中文与「期望气泡台词」逐字比对，出现错字、多字、漏字、串字、顺序颠倒，任一处不符即判不合格。',
    '同时检查：1) 恰好一个对话气泡，且气泡内容只有期望台词本身——若出现第二个气泡，或气泡里是场景旁白/动作描写这类长段叙述文字，直接不合格（category=气泡异常）；2) 除这唯一气泡外画面无任何其他文字/水印/签名；3) 无多余人物、肢体正常；4) 构图与场景描述一致。',
    '判定类别（category 取其一）：错字 | 多字 | 漏字 | 气泡异常 | 多余文字 | 人物异常 | 构图不符。',
    '只有当气泡台词与期望逐字完全一致、且其余检查项全部通过时，才输出 {"ok":true}。',
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const resp = await fetch(joinUrlChat(model.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 200,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: qcPrompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const verdict = JSON.parse(m[0]) as { ok?: boolean; reason?: string; category?: string };
    const reason = verdict.reason
      ? verdict.category && !verdict.reason.includes(verdict.category)
        ? `[${verdict.category}] ${verdict.reason}`
        : verdict.reason
      : undefined;
    return { ok: verdict.ok === true, reason };
  } catch {
    return null; // QC 通道异常不阻塞产线（降级放行）
  } finally {
    clearTimeout(timer);
  }
}

function joinUrlChat(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/**
 * 单格重画：清空该格状态后立即推进一次。
 * opts.prompt / opts.lines 传入时先更新该格提示词与台词（改词重画），
 * prompt 截断到 schema VarChar(2000)、lines 截到 1000。
 */
export async function regeneratePanel(
  articleId: number,
  seq: number,
  opts: { prompt?: string; lines?: string } = {},
): Promise<void> {
  const panel = await prisma.comicPanel.findUnique({ where: { articleId_seq: { articleId, seq } } });
  if (!panel) throw new BadRequestError(`漫画 ${articleId} 不存在第 ${seq} 格`);
  const data: { status: string; attempt: number; errorMsg: string; filePath: string; wechatUrl: string; uploadedKey: string; prompt?: string; lines?: string } = {
    status: 'pending',
    attempt: 0,
    errorMsg: '',
    filePath: '',
    wechatUrl: '',
    uploadedKey: '',
  };
  if (typeof opts.prompt === 'string' && opts.prompt.trim()) data.prompt = opts.prompt.trim().slice(0, 2000);
  if (typeof opts.lines === 'string') data.lines = opts.lines.trim().slice(0, 1000);
  await prisma.comicPanel.update({ where: { id: panel.id }, data });
  await prisma.article.updateMany({ where: { id: articleId, status: 'failed' }, data: { status: 'draft' } });
  await processComicImages(articleId);
}
