/**
 * 微信通道：access_token 缓存、素材上传、草稿增删改。
 *
 * 移植并云化自本机 `reference/python/push_draft.py` 的微信接口调用，改造点：
 *   - curl.exe 硬编码 → 原生 fetch + FormData（迁移断点 #1）
 *   - 每次运行重新取 token → 库内缓存 token（微信有调用频率限制，见 schema WechatToken）
 *   - 重试策略按微信错误码分级（见 constants.ts）：
 *       40164 不重试（IP 白名单，需人工加白）
 *       40001/42001 强制刷 token 后重试一次
 *       网络/45009/45015/45016 指数退避最多 MAX_RETRY 次
 *
 * 安全红线：本服务只向草稿箱写入，**绝不调用 masssend / 群发接口**。
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { prisma } from '../db.ts';
import {
  ERR_NO_RETRY,
  ERR_REFRESH_TOKEN,
  ERR_RETRYABLE,
  MAX_RETRY,
  RETRY_BASE_DELAY,
} from '../constants.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { CredentialError, WechatApiError } from '../errors.ts';
import { HTTP_TIMEOUT_MS } from '../config.ts';
import { logger } from '../logger.ts';

/** 仅在冒烟脚本里注入假上游；不设时行为与原先完全一致。 */
const API_BASE = process.env.WECHAT_API_BASE ?? 'https://api.weixin.qq.com/cgi-bin';
/** token 过期前的安全缓冲：提前 5 分钟就视为失效去刷新，避免用到临期 token。 */
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export interface DraftArticle {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  thumb_media_id?: string;
  need_open_comment?: number;
  only_fans_can_comment?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 指数退避基础延迟（毫秒）：1.5s, 3s, 6s, 12s ... */
function backoffMs(attempt: number): number {
  return RETRY_BASE_DELAY * 1000 * Math.pow(2, attempt);
}

function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

export class WechatClient {
  private readonly accountId: number;
  private readonly appid: string;
  private readonly getSecret: () => Promise<string>;

  private constructor(
    accountId: number,
    appid: string,
    getSecret: () => Promise<string>,
  ) {
    this.accountId = accountId;
    this.appid = appid;
    this.getSecret = getSecret;
  }

  /** 由账号 ID 构造客户端；凭据从库里解密取出，缺失则直接报错。 */
  static async fromAccountId(accountId: number): Promise<WechatClient> {
    const a = await prisma.account.findUnique({ where: { id: accountId } });
    if (!a) throw new CredentialError(`账号 ${accountId} 不存在`);
    const secret = decryptSecret(a.secretEnc);
    if (!secret) throw new CredentialError(`账号 ${a.name} 缺少可用凭据，无法创建微信客户端`);
    return new WechatClient(a.id, a.appid, () => Promise.resolve(secret));
  }

  /** 取 access_token：优先用库内缓存，临期或强制刷新则重新拉取并加密回写。 */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await prisma.wechatToken.findUnique({ where: { accountId: this.accountId } });
      if (cached && cached.expiresAt.getTime() > Date.now() + TOKEN_SAFETY_MS) {
        const tok = decryptSecret(cached.tokenEnc);
        if (tok) return tok;
      }
    }
    const secret = await this.getSecret();
    const url =
      `${API_BASE}/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(this.appid)}&secret=${encodeURIComponent(secret)}`;
    const data = await this.fetchToken(url);
    const token = typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!token) {
      throw new WechatApiError(
        typeof data.errcode === 'number' ? data.errcode : -1,
        typeof data.errmsg === 'string' ? data.errmsg : 'access_token 缺失',
      );
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
    const expiresAt = new Date(Date.now() + expiresIn * 1000 - TOKEN_SAFETY_MS);
    await prisma.wechatToken.upsert({
      where: { accountId: this.accountId },
      create: { accountId: this.accountId, tokenEnc: encryptSecret(token), expiresAt },
      update: { tokenEnc: encryptSecret(token), expiresAt },
    });
    return token;
  }

  /** token 端点自身调用：命中错误码直接抛出（含 40164 IP 白名单特殊提示）。 */
  private async fetchToken(url: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
      res = (await fetch(url, { signal: ctrl.signal })) as Response;
      clearTimeout(t);
    } catch (e) {
      throw new WechatApiError(-1, `获取 access_token 网络错误: ${String(e)}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errcode = typeof data.errcode === 'number' ? data.errcode : undefined;
    if (errcode !== undefined && errcode !== 0) {
      throw this.classifyError(errcode, String(data.errmsg ?? ''));
    }
    return data;
  }

  /**
   * 带鉴权与分级重试的请求。path 形如 /draft/add；body 为 JSON 或 multipart FormData。
   * token 失效(40001/42001) 会强制刷新 token 后整请求重试一次；网络/可重试错误指数退避。
   */
  private async call(path: string, body: unknown, multipart: boolean): Promise<Record<string, unknown>> {
    let token = await this.getAccessToken();
    let attempt = 0;
    let refreshed = false;
    while (attempt <= MAX_RETRY) {
      const sep = path.includes('?') ? '&' : '?';
      const url = `${API_BASE}${path}${sep}access_token=${encodeURIComponent(token)}`;
      let res: Response;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
        res = (await fetch(url, {
          method: 'POST',
          signal: ctrl.signal,
          ...(multipart
            ? { body: body as FormData }
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        })) as Response;
        clearTimeout(timer);
      } catch (e) {
        if (attempt < MAX_RETRY) {
          logger.warn({ attempt, err: String(e) }, '微信接口网络错误，退避重试');
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new WechatApiError(-1, `微信接口网络错误: ${String(e)}`);
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errcode = typeof data.errcode === 'number' ? data.errcode : undefined;
      if (errcode === undefined || errcode === 0) return data;

      if (ERR_NO_RETRY.has(errcode)) throw this.classifyError(errcode, String(data.errmsg ?? ''));
      if (ERR_REFRESH_TOKEN.has(errcode) && !refreshed) {
        refreshed = true;
        await this.getAccessToken(true);
        token = await this.getAccessToken();
        continue;
      }
      if (ERR_RETRYABLE.has(errcode)) {
        if (attempt < MAX_RETRY) {
          logger.warn({ errcode, attempt }, '微信接口可重试错误，退避重试');
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new WechatApiError(errcode, String(data.errmsg ?? ''));
      }
      throw new WechatApiError(errcode, String(data.errmsg ?? ''));
    }
    throw new WechatApiError(-1, '微信接口重试耗尽仍未成功');
  }

  private classifyError(errcode: number, errmsg: string): WechatApiError {
    if (errcode === 40164) {
      const m = /invalid ip ([\d.]+)/i.exec(errmsg);
      const exitIp = m ? m[1] : '未知';
      return new WechatApiError(
        40164,
        `当前出口 IP ${exitIp} 不在公众号 IP 白名单，请到「设置与开发 → 基本配置 → IP白名单」添加该 IP 后重试`,
        { exitIp, guidance: '登录公众号后台，把出口 IP 加入白名单' },
      );
    }
    return new WechatApiError(errcode, errmsg);
  }

  /** 上传永久图片素材，返回 media_id。 */
  async uploadImage(imagePath: string): Promise<string> {
    const buf = await readFile(imagePath);
    const blob = new Blob([buf], { type: mimeOf(imagePath) });
    const fd = new FormData();
    fd.append('media', blob, basename(imagePath));
    const data = await this.call('/material/add_material?type=image', fd, true);
    const mediaId = typeof data.media_id === 'string' ? data.media_id : undefined;
    if (!mediaId) {
      throw new WechatApiError(
        typeof data.errcode === 'number' ? data.errcode : -1,
        `封面上传未返回 media_id: ${JSON.stringify(data)}`,
      );
    }
    return mediaId;
  }

  /**
   * 上传图文正文插图（/media/uploadimg），返回可直接嵌入正文的 mmbiz URL。
   *
   * 与 uploadImage（永久素材）的区别：**不占用永久素材配额**（公众号素材库有上限，
   * 漫画一次 6-12 张图，走永久素材一年就吃满）；官方专为正文插图设计。
   * 返回的 url 供 ComicPanel.wechatUrl 使用；复用判据由调用方 uploadedKey 维护。
   */
  async uploadContentImage(imagePath: string): Promise<string> {
    const buf = await readFile(imagePath);
    const blob = new Blob([buf], { type: mimeOf(imagePath) });
    const fd = new FormData();
    fd.append('media', blob, basename(imagePath));
    const data = await this.call('/media/uploadimg', fd, true);
    const url = typeof data.url === 'string' ? data.url : undefined;
    if (!url) {
      throw new WechatApiError(
        typeof data.errcode === 'number' ? data.errcode : -1,
        `正文插图上传未返回 url: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    return url;
  }

  /** 新建草稿到草稿箱，返回 media_id。 */
  async addDraft(article: DraftArticle): Promise<string> {
    const payload = { articles: [normalizeArticle(article)] };
    const data = await this.call('/draft/add', payload, false);
    const mediaId = typeof data.media_id === 'string' ? data.media_id : undefined;
    if (!mediaId) {
      throw new WechatApiError(
        typeof data.errcode === 'number' ? data.errcode : -1,
        '草稿创建未返回 media_id',
      );
    }
    return mediaId;
  }

  /** 更新已有草稿（保留未覆盖字段由调用方负责传入）。 */
  async updateDraft(mediaId: string, article: DraftArticle): Promise<void> {
    const payload = { media_id: mediaId, index: 0, articles: normalizeArticle(article) };
    await this.call('/draft/update', payload, false);
  }

  /** 读取草稿原文（用于更新前取旧值）。 */
  async getDraft(mediaId: string): Promise<Record<string, unknown>> {
    return this.call('/draft/get', { media_id: mediaId }, false);
  }
}

function normalizeArticle(a: DraftArticle): Record<string, unknown> {
  return {
    title: a.title,
    author: a.author ?? '',
    digest: a.digest ?? '',
    content: a.content,
    thumb_media_id: a.thumb_media_id ?? '',
    need_open_comment: a.need_open_comment ?? 1,
    only_fans_can_comment: a.only_fans_can_comment ?? 0,
  };
}
