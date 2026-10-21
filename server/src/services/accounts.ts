/**
 * 账号凭据校验与状态决策。
 *
 * 移植自本机参考脚本 `reference/python/check_accounts.py` 的 creds_valid 规则：
 *   - AppID 必须 18 位、以 wx 开头
 *   - Secret 至少 20 位
 *   - 两者都不能是占位值（填入 / placeholder / todo / xxx / your_）
 * 填好真实凭据后无需改配置，按结果自动置为 ok / placeholder / invalid / missing。
 */

import {
  APPID_LEN,
  APPID_PREFIX,
  PLACEHOLDER_PATTERNS,
  SECRET_MIN_LEN,
} from '../constants.ts';
import { prisma } from '../db.ts';
import { ConflictError, NotFoundError } from '../errors.ts';
import { encryptSecret, looksLikePlaceholder, maskSecret } from '../lib/crypto.ts';

export type CredStatusDb = 'ok' | 'placeholder' | 'missing' | 'invalid';

export interface CredValidation {
  appidOk: boolean;
  secretOk: boolean;
  valid: boolean;
  problems: string[];
}

export function validateAppid(appid: string): { ok: boolean; reason?: string } {
  if (!appid) return { ok: false, reason: 'AppID 为空' };
  if (appid.length !== APPID_LEN) {
    return { ok: false, reason: `AppID 应为 ${APPID_LEN} 位，当前 ${appid.length} 位` };
  }
  if (!appid.startsWith(APPID_PREFIX)) {
    return { ok: false, reason: `AppID 必须以 ${APPID_PREFIX} 开头` };
  }
  if (looksLikePlaceholder(appid)) return { ok: false, reason: 'AppID 含有占位词' };
  return { ok: true };
}

export function validateSecret(secret: string): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: 'Secret 为空' };
  if (secret.length < SECRET_MIN_LEN) {
    return { ok: false, reason: `Secret 至少 ${SECRET_MIN_LEN} 位，当前 ${secret.length} 位` };
  }
  if (looksLikePlaceholder(secret)) return { ok: false, reason: 'Secret 含有占位词' };
  return { ok: true };
}

export function validateCredentials(appid: string, secret: string): CredValidation {
  const a = validateAppid(appid);
  const s = validateSecret(secret);
  const problems: string[] = [];
  if (!a.ok && a.reason) problems.push(a.reason);
  if (!s.ok && s.reason) problems.push(s.reason);
  return { appidOk: a.ok, secretOk: s.ok, valid: a.ok && s.ok, problems };
}

/**
 * 根据填入的 AppID / Secret 决定账号凭据状态与是否启用。
 * 规则：都空 → missing；含占位词 → placeholder；格式不对 → invalid；全部合规 → ok（自动启用）。
 */
export function decideCredStatus(
  appid: string,
  secret: string,
): { status: CredStatusDb; enabled: boolean } {
  if (!appid && !secret) return { status: 'missing', enabled: false };
  const v = validateCredentials(appid, secret);
  if (v.valid) return { status: 'ok', enabled: true };

  const appidPh = looksLikePlaceholder(appid || null);
  const secretPh = looksLikePlaceholder(secret || null);
  if (appidPh || secretPh) return { status: 'placeholder', enabled: false };
  return { status: 'invalid', enabled: false };
}

/** 仅当明文非空时返回掩码，否则返回空串。 */
export function maskOf(plain: string | null | undefined): string {
  return maskSecret(plain);
}

/* ────────────────────────────────────────────────────────────
 * 账号的新增与删除（账号数量不是固定的，运行期可自由增删）
 * ──────────────────────────────────────────────────────────── */

export interface CreateAccountInput {
  trackId: number;
  name: string;
  appid: string;
  secret: string;
  author?: string;
}

/**
 * 新建账号。凭据落库前一律加密，状态与启用由 decideCredStatus 自动判定。
 * 赛道不存在 → 404；AppID 已被占用 → 409。
 */
export async function createAccount(input: CreateAccountInput) {
  const track = await prisma.track.findUnique({
    where: { id: input.trackId },
    select: { id: true, name: true },
  });
  if (!track) throw new NotFoundError(`赛道 ${input.trackId} 不存在`);

  const dup = await prisma.account.findUnique({ where: { appid: input.appid } });
  if (dup) throw new ConflictError(`AppID ${input.appid} 已被账号「${dup.name}」占用`);

  const { status, enabled } = decideCredStatus(input.appid, input.secret);

  return prisma.account.create({
    data: {
      trackId: input.trackId,
      name: input.name,
      appid: input.appid,
      secretEnc: encryptSecret(input.secret),
      secretMask: maskSecret(input.secret),
      author: input.author ?? '',
      credStatus: status,
      enabled,
    },
  });
}

export interface DeleteAccountResult {
  id: number;
  name: string;
  /** 被级联删除的文章数 */
  deletedArticles: number;
  /** 归还到角度池的角度数（仅未推送的文章才归还） */
  recycledAngles: number;
}

/**
 * 删除账号，并在同一事务里理顺所有关联：
 *  1. 未送达微信的文章所占角度归还池中（已推送的不归还，避免重复选题）
 *  2. 该账号名下文章全部删除（应用层显式级联，与 schema 的 onDelete:Cascade 双保险）
 *  3. TaskRun 的 accountId 置空，避免留下指向不存在账号的孤儿字段
 * 微信侧已发内容不受影响（只写草稿箱，且这里不动微信接口）。
 */
export async function deleteAccount(id: number): Promise<DeleteAccountResult> {
  return prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!acc) throw new NotFoundError(`账号 ${id} 不存在`);

    const articles = await tx.article.findMany({
      where: { accountId: id },
      select: { id: true, angleId: true, status: true },
    });

    // 只回收「还没安全送到微信」的角度：draft / updated / failed。
    // pushed 的保持 used=true，否则同一选题会被再写一遍。
    const angleIds = [
      ...new Set(
        articles
          .filter((a) => a.status !== 'pushed' && a.angleId != null)
          .map((a) => a.angleId as number),
      ),
    ];
    let recycledAngles = 0;
    if (angleIds.length > 0) {
      const r = await tx.angle.updateMany({
        where: { id: { in: angleIds } },
        data: { used: false, usedBy: '', usedDate: null },
      });
      recycledAngles = r.count;
    }

    let deletedArticles = 0;
    if (articles.length > 0) {
      const r = await tx.article.deleteMany({
        where: { id: { in: articles.map((a) => a.id) } },
      });
      deletedArticles = r.count;
    }

    await tx.taskRun.updateMany({ where: { accountId: id }, data: { accountId: null } });

    await tx.account.delete({ where: { id } });

    return { id: acc.id, name: acc.name, deletedArticles, recycledAngles };
  });
}

export { PLACEHOLDER_PATTERNS };
