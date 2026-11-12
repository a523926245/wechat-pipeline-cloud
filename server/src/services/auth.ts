/**
 * 鉴权（P2 多用户改造，2026-11-11；同日令牌退场）。
 *
 * 两层并存，优先级从高到低：
 *  1. **用户会话**（唯一登录路径）：POST /api/auth/login { username, password } 成功后
 *     建 UserSession 行，httpOnly cookie 只存 session id（查库校验，可随时吊销）。
 *  2. **冒烟旁路**：SMOKE_NO_AUTH=1（仅非 production），解析为 admin 主体。
 *
 * ⚠️ 管理令牌（break-glass）已于 2026-11-11 退场：它明文存 Setting 是安全债，
 *    UI 入口已摘，应急口令重置走 `npm run seed:admin -- --reset-pass`。
 *
 * 口令哈希用 node:crypto 的 scrypt（参数随哈希串存储），不引原生依赖——
 * Windows 下 argon2 需 node-gyp 编译，违背「即开即用」约定；scrypt 同为
 * 密码学 KDF，此处强度足够。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { prisma } from '../db.ts';
import { logger } from '../logger.ts';

/** 用户会话 cookie（主路径）。httpOnly + sameSite=lax：跨站不带，XSS 读不到。 */
export const SESSION_COOKIE = 'wb_session';

/** 会话有效期 30 天（「长期管理台」语义，不做滑动续期）。 */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- 口令哈希（scrypt，参数随串存储便于日后升参） ----------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltB64 = parts[4];
    const hashB64 = parts[5];
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !saltB64 || !hashB64) {
      return false;
    }
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------- 主体（请求身份） ----------

export type PrincipalRole = 'admin' | 'member' | 'guest';

export interface Principal {
  /** 会话主体=用户 id；break-glass/冒烟=null（admin 身份，不受归属过滤约束）。 */
  userId: number | null;
  role: PrincipalRole;
  username: string;
  /** 用户状态；break-glass 视同 active。pending/disabled 不可登录（登录口已拦）。 */
  status: 'pending' | 'active' | 'disabled';
  /** 订阅有效期（null=不过期）。已过期 → 权限按 guest 降只读（角色字段不动，续费即恢复）。 */
  expiresAt: Date | null;
  via: 'session' | 'smoke';
}

/** 有效角色：过期账号降只读（guest），其余取自身角色。 */
export function effectiveRole(principal: Principal): PrincipalRole {
  if (principal.role !== 'guest' && principal.expiresAt && principal.expiresAt.getTime() < Date.now()) {
    return 'guest';
  }
  return principal.role;
}

// ---------- 会话 ----------

function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** 建会话并返回 session id（落库 + 前端 cookie 值）。 */
export async function createSession(userId: number): Promise<string> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await prisma.userSession.create({ data: { id, userId, expiresAt } });
  return id;
}

/** 查会话 → 用户。过期会话顺手清理。返回 null=无效。 */
export async function resolveSession(sessionId: string | undefined | null): Promise<Principal | null> {
  if (!sessionId?.trim()) return null;
  try {
    const session = await prisma.userSession.findUnique({
      where: { id: sessionId.trim() },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() < Date.now()) {
      await prisma.userSession.deleteMany({ where: { id: session.id } });
      return null;
    }
    return {
      userId: session.user.id,
      role: session.user.role as PrincipalRole,
      username: session.user.username,
      status: session.user.status as Principal['status'],
      expiresAt: session.user.expiresAt,
      via: 'session',
    };
  } catch {
    return null;
  }
}

/** 吊销单个会话（登出）。 */
export async function destroySession(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId?.trim()) return;
  try {
    await prisma.userSession.deleteMany({ where: { id: sessionId.trim() } });
  } catch {
    /* 登出失败不阻塞 */
  }
}

/** 吊销某用户全部会话（改密/禁用时用）。 */
export async function destroyUserSessions(userId: number): Promise<void> {
  try {
    await prisma.userSession.deleteMany({ where: { userId } });
  } catch {
    /* noop */
  }
}

// ---------- 请求解析 ----------

/** 解析请求身份：会话 cookie → null（管理令牌已退场，Bearer 不再解析）。 */
export async function principalFromRequest(req: {
  cookies?: Record<string, string>;
}): Promise<Principal | null> {
  return resolveSession(req.cookies?.[SESSION_COOKIE]);
}

/** 冒烟旁路主体。 */
export function smokePrincipal(): Principal {
  return {
    userId: null,
    role: 'admin',
    username: 'smoke',
    status: 'active',
    expiresAt: null,
    via: 'smoke',
  };
}
