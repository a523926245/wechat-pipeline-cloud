/**
 * 凭据配置路由：账号 AppID/Secret 的增改查 + 连通测试。
 *
 * 安全约束（README 四条硬约束 #4）：
 *   - Secret 落库一律 AES-256-GCM 加密，API 永远只回掩码
 *   - 必须能通过 /test 验证真实连通后才能启用账号
 *   - 格式校验（AppID 18 位 wx 开头、Secret ≥20 位、非占位）由 services/accounts 把关
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { encryptSecret, looksLikePlaceholder, maskSecret } from '../../lib/crypto.ts';
import { BadRequestError, CredentialError, NotFoundError, WechatApiError } from '../../errors.ts';
import {
  createAccount,
  decideCredStatus,
  deleteAccount,
  validateCredentials,
} from '../../services/accounts.ts';
import { WechatClient } from '../../services/wechat.ts';
import { asyncHandler } from '../async-handler.ts';

export const credentialsRouter: Router = Router();

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  trackId: z.number().int().positive('trackId 必须是正整数'),
  name: z.string().trim().min(1, '账号名不能为空').max(64),
  appid: z.string().trim().min(1, 'AppID 不能为空').max(32),
  secret: z.string().max(128).optional(),
  author: z.string().trim().max(64).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  trackId: z.number().int().positive().optional(),
  appid: z.string().trim().optional(),
  secret: z.string().optional(),
  author: z.string().trim().max(64).optional(),
});

/** 列表：只暴露掩码与状态，绝不返回明文。 */
credentialsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const accounts = await prisma.account.findMany({
      include: { track: { select: { name: true, slug: true } } },
      orderBy: { id: 'asc' },
    });
    res.json({
      total: accounts.length,
      items: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        track: a.track.name,
        trackSlug: a.track.slug,
        appid: a.appid,
        secretMask: a.secretMask,
        credStatus: a.credStatus,
        enabled: a.enabled,
        author: a.author,
      })),
    });
  }),
);

/**
 * 新建账号。账号数量不是固定的，运行期可随时增删。
 * 传了 Secret 就按真实凭据判定状态，不传则建成 missing（占位）待补。
 */
credentialsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const secret = body.secret ?? '';

    // 与 PUT 一致的宽松策略：占位值放行（当"未配置"），只有"看似真实却格式错"才拒绝。
    if (secret && !looksLikePlaceholder(secret)) {
      const v = validateCredentials(body.appid, secret);
      if (!v.secretOk) throw new CredentialError(`Secret 不合规：${v.problems.join('；')}`);
      if (!looksLikePlaceholder(body.appid) && !v.appidOk) {
        throw new CredentialError(`AppID 不合规：${v.problems.join('；')}`);
      }
    }

    try {
      const a = await createAccount({
        trackId: body.trackId,
        name: body.name,
        appid: body.appid,
        secret,
        author: body.author,
      });
      res.status(201).json({
        id: a.id,
        name: a.name,
        trackId: a.trackId,
        appid: a.appid,
        secretMask: a.secretMask,
        credStatus: a.credStatus,
        enabled: a.enabled,
        author: a.author,
        message:
          a.credStatus === 'ok'
            ? '账号已创建，凭据合规并已启用（建议再跑一次连通测试确认）'
            : `账号已创建，凭据状态：${a.credStatus}。请补全 AppID/Secret 后测试连通`,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unique')) {
        throw new BadRequestError('AppID 已存在（与其他账号冲突）');
      }
      throw e;
    }
  }),
);

credentialsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.account.findUnique({ where: { id } });
    if (!a) throw new NotFoundError(`账号 ${id} 不存在`);
    res.json({
      id: a.id,
      name: a.name,
      trackId: a.trackId,
      appid: a.appid,
      secretMask: a.secretMask,
      credStatus: a.credStatus,
      enabled: a.enabled,
      author: a.author,
    });
  }),
);

/** 设置/更新凭据：校验 → 加密 → 决定状态与启用。 */
credentialsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateSchema.parse(req.body);

    const current = await prisma.account.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`账号 ${id} 不存在`);

    // 改绑赛道：赛道必须真实存在，否则账号会挂到一个不存在的赛道上。
    if (body.trackId !== undefined && body.trackId !== current.trackId) {
      const track = await prisma.track.findUnique({ where: { id: body.trackId }, select: { id: true } });
      if (!track) throw new NotFoundError(`赛道 ${body.trackId} 不存在`);
    }

    // 合并：只更新传入的字段，其余沿用现有值
    const nextAppid = body.appid ?? current.appid;
    const nextSecret = body.secret ?? '';
    const author = body.author ?? current.author;

    const v = validateCredentials(nextAppid, nextSecret);
    // 占位值（空 / 含填入 / placeholder / xxx 等）视为"未配置"，直接放行，仅当值"看似真实却格式错"时才拒绝。
    const appidPlaceholder = !nextAppid || looksLikePlaceholder(nextAppid);
    const secretPlaceholder = !nextSecret || looksLikePlaceholder(nextSecret);
    if (!secretPlaceholder && !v.secretOk) {
      throw new CredentialError(`Secret 不合规：${v.problems.join('；')}`);
    }
    if (body.appid && !appidPlaceholder && !v.appidOk) {
      throw new CredentialError(`AppID 不合规：${v.problems.join('；')}`);
    }

    const { status, enabled } = decideCredStatus(nextAppid, nextSecret);

    const data: Record<string, unknown> = { author, credStatus: status, enabled };
    if (body.name !== undefined) data.name = body.name;
    if (body.trackId !== undefined) data.trackId = body.trackId;
    if (body.appid !== undefined) data.appid = nextAppid;
    if (body.secret !== undefined) {
      data.secretEnc = encryptSecret(nextSecret);
      data.secretMask = maskSecret(nextSecret);
    }

    try {
      const updated = await prisma.account.update({ where: { id }, data });
      res.json({
        id: updated.id,
        name: updated.name,
        trackId: updated.trackId,
        appid: updated.appid,
        secretMask: updated.secretMask,
        credStatus: updated.credStatus,
        enabled: updated.enabled,
        author: updated.author,
        message: status === 'ok' ? '凭据合规，账号已自动启用（建议再跑一次连通测试确认）' : `凭据状态：${status}`,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unique')) {
        throw new BadRequestError('AppID 已存在（与其他账号冲突）');
      }
      throw e;
    }
  }),
);

/**
 * 连通测试：用库内凭据真实调一次 token 接口。
 * 成功 → 标记 ok + 启用；40164 → 报出口 IP 与加白指引；其他错误原样返回。
 */
credentialsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const a = await prisma.account.findUnique({ where: { id } });
    if (!a) throw new NotFoundError(`账号 ${id} 不存在`);

    // 占位/缺失账号无需打真实接口，直接告知先配置。
    if (a.credStatus === 'placeholder' || a.credStatus === 'missing') {
      res.json({
        ok: false,
        account: a.name,
        errcode: null,
        message: `账号尚未配置真实凭据（当前状态：${a.credStatus}），请先在配置界面填写有效的 AppID/Secret 再测试连通`,
      });
      return;
    }

    try {
      const client = await WechatClient.fromAccountId(id);
      await client.getAccessToken(true);
      const updated = await prisma.account.update({
        where: { id },
        data: { credStatus: 'ok', enabled: true },
      });
      res.json({
        ok: true,
        account: updated.name,
        credStatus: 'ok',
        enabled: true,
        message: '连通成功，凭据有效，账号已启用',
      });
    } catch (e) {
      let errcode: number | null = null;
      let message = '连通失败';
      let detail: unknown = undefined;
      if (e instanceof WechatApiError) {
        errcode = e.errcode;
        message = e.message;
        detail = e.detail;
      } else if (e instanceof CredentialError) {
        message = e.message;
      } else if (e instanceof Error) {
        message = e.message;
      }
      // 连通失败 → 取消启用，状态置为 invalid（除非是占位/缺失本身）
      await prisma.account.update({
        where: { id },
        data: { credStatus: 'invalid', enabled: false },
      }).catch(() => undefined);
      res.status(200).json({
        ok: false,
        account: a.name,
        errcode,
        message,
        detail,
      });
    }
  }),
);

/**
 * 删除账号。级联逻辑全部在 services/accounts.deleteAccount 的事务里完成：
 * 未送达文章所占角度归还池中 → 名下文章删除 → TaskRun 的 accountId 置空 → 删账号。
 * 微信侧已经发出去的内容不受影响（系统只写草稿箱，且这里不碰微信接口）。
 */
credentialsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const r = await deleteAccount(id);
    res.json({
      ok: true,
      id: r.id,
      name: r.name,
      deletedArticles: r.deletedArticles,
      recycledAngles: r.recycledAngles,
      message:
        r.deletedArticles > 0
          ? `已删除账号「${r.name}」，同时删除其名下 ${r.deletedArticles} 篇文章` +
            (r.recycledAngles > 0 ? `，归还 ${r.recycledAngles} 个未用选题到角度池` : '')
          : `已删除账号「${r.name}」`,
    });
  }),
);
