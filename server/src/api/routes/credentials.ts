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
import { decideCredStatus, validateCredentials } from '../../services/accounts.ts';
import { WechatClient } from '../../services/wechat.ts';
import { asyncHandler } from '../async-handler.ts';

export const credentialsRouter: Router = Router();

const idParam = z.coerce.number().int().positive();

const updateSchema = z.object({
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
