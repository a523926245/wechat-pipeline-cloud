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
 *   - 失败时优雅返回，不抛到调用方导致崩溃：**从未送达过**的文章才置 `failed`，
 *     曾送达过（mediaId/pushDate 非空）的保持原 status，推送事实不被失败抹掉（S5-1）
 *
 * TODO（本轮不接）：`WechatClient.updateDraft` 目前零调用方。换封面后若要「原地更新旧草稿」
 * 而非「再建一篇新草稿」，必须先 `getDraft` 比对再写——`updateDraft` 内部走 normalizeArticle
 * 会整篇覆盖，草稿若被人工在公众号后台编辑过会被静默冲掉。仅当调用方显式传入
 * `{ updateDraft: true }` 时才启用。
 */

import { existsSync } from 'node:fs';

import { Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { NotFoundError, WechatApiError } from '../errors.ts';
import { WechatClient } from './wechat.ts';
import { resolveCoverPath, toRelativeCoverPath } from './content-path.ts';
import { packJson } from '../db-json.ts';
import { todayKey } from '../lib/day.ts';
import { logger } from '../logger.ts';
import { lintArticle, lintSummary, type LintReport } from './lint.ts';
import { recordLintRun, type LintRunBrief } from './lint-store.ts';
import { hasPushTrace } from './article-delete.ts';
import { loadTrackRule } from './style-prompts.ts';
import { ensureComicAssetsReady } from './render/comic.ts';

export type PushReason =
  | 'no_account'
  | 'cred_not_ok'
  | 'empty_content'
  | 'lint_failed'
  /** 已有推送痕迹（mediaId 或 pushDate 非空），按业务规则禁止再建一份微信草稿。 */
  | 'already_pushed'
  /** 同一篇文章的推送正在进行中（并发重复点击），本次不调用微信接口。 */
  | 'pushing';

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
  /**
   * 本次操作前是否已有推送痕迹（mediaId / pushDate 任一非空）。
   * 前端据此区分「从未送达、本次推送失败」与「曾经送达、后续操作失败」。
   */
  everPushed?: boolean;
  /** 配了封面但磁盘上找不到文件：已推无封面草稿。显式暴露，避免静默失败。 */
  coverMissing?: boolean;
  /** 成稿体检报告（仅文章产线）。未通过时 reason='lint_failed'。 */
  lint?: LintReport;
  /** 本次推送门禁体检的落库记录（S4-3）；落库失败时为 null 且带 lintPersistError。 */
  lintRun?: LintRunBrief | null;
  /** 体检结果未能存档的原因（显式暴露，不允许「检查成功但没留痕」看起来像一切正常）。 */
  lintPersistError?: string;
}

/**
 * 同一篇文章的推送去重（S5-1）：只靠前端按钮禁用挡不住并发重复点击，
 * 这里在进程内把同一 articleId 的推送串行化——第二次调用直接拒绝，绝不重复调微信 addDraft。
 *
 * 作用域是**单进程**（本项目为单机单服务，够用）；多进程部署下需另加数据库级占位，本轮不做。
 */
const inFlightPushes = new Map<number, Promise<PushResult>>();

/**
 * 推送单篇文章到草稿箱。
 * 网络/微信错误不会抛出，全部收敛为 `ok:false` 的结果对象，便于调度器批量处理。
 */
export async function pushArticleToDraft(articleId: number): Promise<PushResult> {
  const running = inFlightPushes.get(articleId);
  if (running) {
    // 不 await：让调用方立刻拿到「正在推送中」，避免排队产生第二份草稿。
    return {
      ok: false,
      id: articleId,
      reason: 'pushing',
      message: '该文章的推送正在进行中，请稍候再试；本次未调用微信接口',
    };
  }
  const task = (async () => {
    try {
      return await pushOnce(articleId);
    } finally {
      inFlightPushes.delete(articleId);
    }
  })();
  inFlightPushes.set(articleId, task);
  return task;
}

async function pushOnce(articleId: number): Promise<PushResult> {
  // 带出 track.name：星座赛道要跑星座专属体检（像不像星座文章、教科书腔、跨星座复读）。
  // 赛道名进体检而不是进代码分支，是为了让「星座规则」只存在于 style_dna.json 一处。
  const a = await prisma.article.findUnique({
    where: { id: articleId },
    include: { track: { select: { name: true } } },
  });
  if (!a) throw new NotFoundError(`文章 ${articleId} 不存在`);

  // ── 推送事实防重复（S5-1）──
  // 判据是 mediaId / pushDate 任一非空（hasPushTrace），**不是 status**：
  // status 会被改稿/改写/换封面/重推失败改写（draft / updated / failed），
  // 但「这篇曾经送到过微信」是抹不掉的事实，绝不能再建第二份草稿。
  // 放在最前面：与账号、凭据、体检都无关，是纯粹的业务事实判断。
  const everPushed = hasPushTrace(a);
  if (everPushed) {
    logger.warn({ articleId, mediaId: a.mediaId, pushDate: a.pushDate }, '拒绝重复推送：该文章已有推送痕迹');
    return {
      ok: false,
      id: a.id,
      reason: 'already_pushed',
      everPushed: true,
      mediaId: a.mediaId,
      pushDate: a.pushDate,
      message:
        `文章「${a.title}」已在 ${a.pushDate || '此前'} 推送到微信草稿箱` +
        `（mediaId ${a.mediaId || '无'}），不能重复创建草稿。` +
        '如需更新公众号里的那一篇，请到公众号后台编辑；本系统暂不支持原地更新草稿',
    };
  }

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
  let gateLintRun: LintRunBrief | null = null;
  let gateLintPersistError: string | undefined;
  if (a.pipeline !== 'comic' && a.contentHtml.trim()) {
    // 赛道专项检查按 `r:{赛道}` 配置走（不再是代码里的赛道名分支）。
    // checks 与 relax 取自同一条规则：漏传 relax 会让配置页配的 warn 豁免在推送门禁失效。
    const trackName = a.track?.name ?? '';
    const rule = await loadTrackRule(trackName);
    const lint = lintArticle(a.contentHtml, undefined, trackName, rule.checks, rule.relax);
    // 门禁结论一律留痕（通过与否都记）：这是「这篇到底在什么状态下被推/被拦」的唯一书面证据。
    const rec = await recordLintRun({
      articleId: a.id,
      trigger: 'push',
      report: lint,
      contentHtml: a.contentHtml,
      rule: { checks: rule.checks, relax: rule.relax },
    });
    gateLintRun = rec.run ?? null;
    gateLintPersistError = rec.error;
    if (!rec.saved) {
      // 体检本身已完成、结论有效；只是没存下来。既不拦推送（不改变业务门禁），也不装作存成功。
      logger.warn({ articleId: a.id, err: rec.error }, '体检结果落库失败：本次门禁结论未能留痕');
    }
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
        lintRun: gateLintRun,
        ...(gateLintPersistError ? { lintPersistError: gateLintPersistError } : {}),
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
      everPushed: false,
      ...(coverMissing ? { coverMissing: true } : {}),
      ...(gateLintRun ? { lintRun: gateLintRun } : {}),
      ...(gateLintPersistError ? { lintPersistError: gateLintPersistError } : {}),
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

    // ── 推送事实不得被失败覆盖（S5-1）──
    // mediaId / pushDate 本方法在任何路径下都不清空，这里是第二道保险：
    // 只有「从未送达过微信」的文章才降级成 failed；曾经送达过的保持原 status
    // （pushed / updated），否则一次重推失败就把「已送达」这件事从界面上抹掉了。
    // 失败本身不丢：TaskRun 记 errcode + errMessage，前端也能拿到 everPushed 区分两种失败。
    const everPushedNow = hasPushTrace(a);
    if (!everPushedNow) {
      await prisma.article
        .update({ where: { id: articleId }, data: { status: 'failed' } })
        .catch(() => undefined);
    } else {
      logger.warn(
        { articleId, status: a.status, mediaId: a.mediaId, pushDate: a.pushDate, errcode },
        '推送失败但保留推送事实（status 不降级为 failed）',
      );
    }

    await recordPushRun({
      runDate,
      trackId: a.trackId,
      accountId: a.accountId,
      articleId: a.id,
      ok: false,
      errcode: errcode ?? undefined,
      errMessage: message,
    });

    return {
      ok: false,
      id: a.id,
      account: account.name,
      errcode,
      message: everPushedNow
        ? `${message}（该文章此前已成功推送过，本次失败未清除原有推送记录，status 保持「${a.status}」）`
        : message,
      detail,
      everPushed: everPushedNow,
    };
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
        paramsJson: packJson({ articleId: info.articleId }) ?? Prisma.DbNull,
        resultJson: info.ok ? packJson({ mediaId: info.mediaId }) ?? Prisma.DbNull : Prisma.DbNull,
        errorCode: info.errcode != null ? String(info.errcode) : '',
        errorMessage: info.errMessage ?? '',
        finishedAt: new Date(),
      },
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'push 流水记录失败（忽略）');
  }
}
