/**
 * 发布服务：把文章推送到微信公众号**草稿箱**。
 *
 * 抽取目的：阶段 5 的自动调度需要与手动 `/push` 走**同一套**推送逻辑，
 * 避免出现两套实现导致行为分叉。API 路由与调度器都只调用 `pushArticleToDraft`。
 *
 * 安全红线（不可动摇，沿用阶段 2/3 的约定）：
 *   - 只写草稿箱：`WechatClient.addDraft`，**绝不调用 masssend / 群发接口**
 *   - 账号必须 `credStatus === 'ok'`，否则不发起任何外网调用
 *   - 封面仅在文件真实存在时上传，否则推无封面草稿
 *   - 失败时把文章置 `failed` 并优雅返回，不抛到调用方导致崩溃
 */

import { existsSync } from 'node:fs';

import { prisma } from '../db.ts';
import { NotFoundError, WechatApiError } from '../errors.ts';
import { WechatClient } from './wechat.ts';
import { packJson } from '../db-json.ts';
import { logger } from '../logger.ts';

export type PushReason = 'no_account' | 'cred_not_ok' | 'empty_content';

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
}

/**
 * 推送单篇文章到草稿箱。
 * 网络/微信错误不会抛出，全部收敛为 `ok:false` 的结果对象，便于调度器批量处理。
 */
export async function pushArticleToDraft(articleId: number): Promise<PushResult> {
  const a = await prisma.article.findUnique({ where: { id: articleId } });
  if (!a) throw new NotFoundError(`文章 ${articleId} 不存在`);

  if (!a.accountId) {
    return {
      ok: false,
      id: a.id,
      reason: 'no_account',
      message: '文章未绑定账号，无法推送。请先指定 accountId',
    };
  }

  const account = await prisma.account.findUnique({ where: { id: a.accountId } });
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

  if (!a.title || !a.contentWechat) {
    return {
      ok: false,
      id: a.id,
      account: account.name,
      reason: 'empty_content',
      message: '标题或渲染产物为空，无法推送。请先确保文章已渲染（contentWechat 非空）',
    };
  }

  const runDate = new Date().toISOString().slice(0, 10);

  try {
    const client = await WechatClient.fromAccountId(account.id);

    let thumbMediaId = '';
    if (a.coverPath && existsSync(a.coverPath)) {
      thumbMediaId = await client.uploadImage(a.coverPath);
    }

    const mediaId = await client.addDraft({
      title: a.title,
      author: account.author || undefined,
      digest: a.digest || undefined,
      content: a.contentWechat,
      thumb_media_id: thumbMediaId || undefined,
    });

    const pushDate = new Date().toISOString().slice(0, 10);
    const updated = await prisma.article.update({
      where: { id: articleId },
      data: { mediaId, status: 'pushed', pushDate },
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
      message: '已推送到草稿箱（未群发）。可在公众号后台草稿箱查看',
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
