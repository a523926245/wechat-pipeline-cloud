/**
 * 归属隔离（P3）：ownerUserId 的统一收口。
 *
 * 口径（拍板）：
 *   - admin（含 break-glass/冒烟主体 userId=null）：可见可管全部。
 *   - member：只能看/管**自己**的公众号账号及其产出（文章/任务/数据）。
 *   - ownerUserId=NULL = 未归属（历史/冒烟数据）——**仅 admin 可管**，member 不可见。
 *
 * ⚠️ 用法纪律：入口层（路由）必须过滤/校验，服务层（deleteAccount/push 等）拿到
 * account 后必须再 `assertAccountAccess` 兜底——两层都要，这是全改造最高危路径。
 */
import type { Request } from 'express';

import { ForbiddenError, NotFoundError } from '../errors.ts';
import type { Principal } from '../services/auth.ts';
import { effectiveRole } from '../services/auth.ts';
import { principalOf } from '../api/permissions.ts';

/** 当前请求主体（未登录抛 401——authGuard 已拦一层，这里兜底）。 */
export function requirePrincipal(req: Request): Principal {
  const p = principalOf(req);
  if (!p) throw new ForbiddenError('未登录');
  return p;
}

/** admin 判断：角色是 admin（含过期降级前的判断——admin 无 expiresAt 语义）。 */
export function isAdmin(principal: Principal): boolean {
  return effectiveRole(principal) === 'admin';
}

/**
 * 账号归属 where 片段（findMany 用）。
 *   admin → {}（全量）
 *   member → { ownerUserId: principal.userId }（未归属账号不可见）
 */
export function accountOwnerWhere(principal: Principal): { ownerUserId?: number } {
  if (isAdmin(principal)) return {};
  return { ownerUserId: principal.userId ?? -1 };
}

/** 文章归属 where 片段：member 只见自己账号名下的文章。 */
export function articleOwnerWhere(principal: Principal): { accountId?: number | null } | { account: { ownerUserId: number } } {
  if (isAdmin(principal)) return {};
  // member：文章经账号归属过滤（accountId 为 null 的历史文章仅 admin 可见）
  return { account: { ownerUserId: principal.userId ?? -1 } };
}

/**
 * 账号访问断言（服务层兜底）：account.ownerUserId 必须匹配，admin 放行。
 * 找不到与无权都回 404（防枚举他人账号 id）——统一 NotFoundError。
 */
export function assertAccountAccess(
  principal: Principal,
  account: { ownerUserId: number | null } | null,
  accountId: number,
): void {
  if (!account) throw new NotFoundError(`账号 ${accountId} 不存在`);
  if (isAdmin(principal)) return;
  if (account.ownerUserId !== principal.userId) {
    throw new NotFoundError(`账号 ${accountId} 不存在`);
  }
}

/**
 * 文章访问断言：文章经 accountId → 账号归属判断。
 * accountId=null 的文章（历史/手工稿）仅 admin 可管。
 */
export function assertArticleAccess(
  principal: Principal,
  article: { accountId: number | null; account?: { ownerUserId: number | null } | null } | null,
  articleId: number,
): void {
  if (!article) throw new NotFoundError(`文章 ${articleId} 不存在`);
  if (isAdmin(principal)) return;
  if (article.accountId == null || article.account?.ownerUserId !== principal.userId) {
    throw new NotFoundError(`文章 ${articleId} 不存在`);
  }
}
