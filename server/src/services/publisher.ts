/**
 * 发布服务：把文章推送到微信公众号**草稿箱**。
 *
 * 抽取目的：阶段 5 的自动调度需要与手动 `/push` 走**同一套**推送逻辑，
 * 避免出现两套实现导致行为分叉。API 路由与调度器都只调用 `pushArticleToDraft`。
 *
 * 安全红线（不可动摇，沿用阶段 2/3 的约定）：
 *   - 只写草稿箱：`WechatClient.addDraft`，**绝不调用 masssend / 群发接口**
 *   - 账号必须 `credStatus === 'ok'`，否则不发起任何外网调用
 *   - 封面仅在文件真实存在时上传；文件缺失时**显式返回 coverMissing**，绝不静默
 *   - 失败时把文章置 `failed` 并优雅返回，不抛到调用方导致崩溃
 *
 * TODO（本轮不接）：`WechatClient.updateDraft` 目前零调用方。换封面后若要「原地更新旧草稿」
 * 而非「再建一篇新草稿」，必须先 `getDraft` 比对再写——`updateDraft` 内部走 normalizeArticle
 * 会整篇覆盖，草稿若被人工在公众号后台编辑过会被静默冲掉。仅当调用方显式传入
 * `{ updateDraft: true }` 时才启用。
 */

import { existsSync } from 'node:fs';

import { prisma } from '../db.ts';
import { NotFoundError, WechatApiError } from '../errors.ts';
import { WechatClient } from './wechat.ts';
import { resolveCoverPath, toRelativeCoverPath } from './content-path.ts';
import { packJson } from '../db-json.ts';
import { todayKey } from '../lib/day.ts';
import { logger } from '../logger.ts';
import { lintArticle, lintSummary, type LintReport } from './lint.ts';
import { loadTrackRule } from './style-prompts.ts';
import { ensureComicAssetsReady } from './render/comic.ts';

export type PushReason = 'no_account' | 'cred_not_ok' | 'empty_content' | 'lint_failed';

export interface PushResult {
  ok: boolean;
  id: number;
  account?: string;
  credStatus?: string;
  mediaId?: string;
  pushDate?: string;
  message: string;
  errcode?: number | null;
  detail?: unknown;
  reason?: PushReason;
  /** 配了封面但磁盘上找不到文件：已推无封面草稿。显式暴露，避免静默失败。 */
  coverMissing?: boolean;
  /** 成稿体检报告（仅文章产线）。未通过时 reason='lint_failed'。 */
  lint?: LintReport;
}

/**
 * 推送单篇文章到草稿箱。
 * 网络/微信错误不会抛出，全部收敛为 `ok:false` 的结果对象，便于调度器批量处理。
 */
export async function pushArticleToDraft(articleId: number): Promise<PushResult> {
  // 带出 track.name：星座赛道要跑星座专属体检（像不像星座文章、教科书腔、跨星座复读）。
  // 赛道名进体检而不是进代码分支，是为了让「星座规则」只存在于 style_dna.json 一处。
  const a = await prisma.article.findUnique({
    where: { id: articleId },
    include: { track: { select: { name: true } } },
  });
  if (!a) throw new NotFoundError(`文章 ${articleId} 不存在`);

  if (!a.accountId) {
    return {
      ok: false,
      id: a.id,
      reason: 'no_account',
      message: '文章未绑定账号，无法推送。请先指定 accountId',
    };
  }

  const account = await prisma.oAAccount.findUnique({ where: { id: a.accountId } });
  if (!account) throw new NotFoundError(`账号 ${a.accountId} 不存在`);

  if (account.credStatus !== 'ok') {
    return {
      ok: false,
      id: a.id,
      account: account.name,
      credStatus: account.credStatus,
      reason: 'cred_not_ok',
      message: `账号「${account.name}」凭据状态为 ${account.credStatus}，请先配置并连通测试后再推送`,
    };
  }

  // 漫画产线：推送前确保全部格图/金句卡已上传微信并渲染正文（幂等，uploadedKey 复用判据）。
  // 必须在 empty_content 校验之前执行——漫画平时 contentWechat 为空，就绪后才被现算填充。
  if (a.pipeline === 'comic') {
    const ready = await ensureComicAssetsReady(a.id);
    if (!ready.ok) {
      return {
        ok: false,
        id: a.id,
        account: account.name,
        reason: 'empty_content',
        message: `漫画尚未就绪，无法推送：${ready.message}`,
      };
    }
    a.contentWechat = ready.contentWechat;
  }

  if (!a.title || !a.contentWechat) {
    return {
      ok: false,
      id: a.id,
      account: account.name,
      reason: 'empty_content',
      message: '标题或渲染产物为空，无法推送。请先确保文章已渲染（contentWechat 非空）',
    };
  }

  // ── 成稿体检门禁（仅文章产线；漫画正文是图片序列，结构规则不同）──
  // 放在凭据校验之后：先确认「能推」，再判断「值不值得推」，免得白跑一次体检。
  if (a.pipeline !== 'comic' && a.contentHtml.trim()) {
    // 赛道专项检查按 `r:{赛道}` 配置走（不再是代码里的赛道名分支）。
    const trackName = a.track?.name ?? '';
    const lint = lintArticle(a.contentHtml, undefined, trackName, (await loadTrackRule(trackName)).checks);
    if (!lint.ok) {
      logger.warn(
        { articleId: a.id, errors: lint.errors.map((e) => e.code) },
        '成稿体检未通过，已拦截推送',
      );
      return {
        ok: false,
        id: a.id,
        account: account.name,
        reason: 'lint_failed',
        lint,
        message: `未通过成稿体检（${lintSummary(lint)}）：${lint.errors.map((e) => e.message).join('；')}`,
      };
    }
    if (lint.warnings.length > 0) {
      logger.info({ articleId: a.id, warnings: lint.warnings.map((w) => w.code) }, '成稿体检有改进项，已放行推送');
    }
  }

  const runDate = todayKey();

  try {
    const client = await WechatClient.fromAccountId(account.id);

    // 封面：库里存的是相对路径，这里解析成绝对路径再判断是否存在。
    const coverAbs = a.coverPath ? resolveCoverPath(a.coverPath) : '';
    const coverRel = coverAbs ? toRelativeCoverPath(coverAbs) : '';
    const coverExists = Boolean(coverAbs) && existsSync(coverAbs);
    const coverMissing = Boolean(a.coverPath) && !coverExists;

    // 复用判据 = 「已上传过的封面标识」。coverUploaded 形如 "<accountId>:covers/xxx.png"：
    //  - 带 accountId：永久素材 media_id 是账号维度的，换账号复用会报素材无效；
    //  - 用相对路径而非 mtime：cover 命名含时间戳+随机，路径变 ⇔ 封面变，零额外 IO；
    //    mtime 在 rsync / 跨机迁移后不可靠（可能变新误判重传，也可能被保留漏传）。
    const wantKey = coverRel ? `${a.accountId}:${coverRel}` : '';
    let thumbMediaId = a.coverMediaId || '';
    let uploadedKey = a.coverUploaded || '';

    if (coverMissing) {
      logger.warn(
        { articleId: a.id, coverPath: a.coverPath, resolved: coverAbs },
        '封面文件缺失，将推送无封面草稿',
      );
    } else if (coverRel && !(thumbMediaId && wantKey && wantKey === uploadedKey)) {
      thumbMediaId = await client.uploadImage(coverAbs);
      uploadedKey = wantKey; // 只有上传成功才记
    }

    const mediaId = await client.addDraft({
      title: a.title,
      author: account.author || undefined,
      digest: a.digest || undefined,
      content: a.contentWechat,
      thumb_media_id: thumbMediaId || undefined,
    });

    const pushDate = todayKey();
    const updated = await prisma.article.update({
      where: { id: articleId },
      data: {
        mediaId,
        status: 'pushed',
        pushDate,
        ...(thumbMediaId ? { coverMediaId: thumbMediaId, coverUploaded: uploadedKey } : {}),
      },
    });

    await recordPushRun({
      runDate,
      trackId: updated.trackId,
      accountId: updated.accountId,
      articleId: updated.id,
      ok: true,
      mediaId,
    });

    return {
      ok: true,
      id: updated.id,
      mediaId,
      pushDate,
      ...(coverMissing ? { coverMissing: true } : {}),
      message: coverMissing
        ? '已推送到草稿箱（未群发），但封面文件缺失，推的是无封面草稿'
        : '已推送到草稿箱（未群发）。可在公众号后台草稿箱查看',
    };
  } catch (e) {
    let errcode: number | null = null;
    let message = '推送失败';
    let detail: unknown = undefined;

    if (e instanceof WechatApiError) {
      errcode = e.errcode;
      message = e.message;
      detail = e.detail;
    } else if (e instanceof Error) {
      message = e.message;
    }

    await prisma.article
      .update({ where: { id: articleId }, data: { status: 'failed' } })
      .catch(() => undefined);

    await recordPushRun({
      runDate,
      trackId: a.trackId,
      accountId: a.accountId,
      articleId: a.id,
      ok: false,
      errcode: errcode ?? undefined,
      errMessage: message,
    });

    return { ok: false, id: a.id, account: account.name, errcode, message, detail };
  }
}

interface PushRunInfo {
  runDate: string;
  trackId: number | null;
  accountId: number | null;
  articleId: number | null;
  ok: boolean;
  mediaId?: string;
  errcode?: number;
  errMessage?: string;
}

/**
 * 记一条 push 任务流水，供仪表盘的「最近任务」展示。
 * 失败也不影响主流程（日志落库不是关键路径）。
 */
async function recordPushRun(info: PushRunInfo): Promise<void> {
  try {
    await prisma.taskRun.create({
      data: {
        jobType: 'push',
        status: info.ok ? 'success' : 'failed',
        trigger: 'manual',
        trackId: info.trackId,
        accountId: info.accountId,
        articleId: info.articleId,
        runDate: info.runDate,
        attempt: 1,
        paramsJson: packJson({ articleId: info.articleId }),
        resultJson: info.ok ? packJson({ mediaId: info.mediaId }) : null,
        errorCode: info.errcode != null ? String(info.errcode) : '',
        errorMessage: info.errMessage ?? '',
        finishedAt: new Date(),
      },
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'push 流水记录失败（忽略）');
  }
}
