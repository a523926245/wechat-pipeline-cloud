/**
 * RBAC 权限点（P2）。角色 → 权限集合的唯一真源。
 *
 * 角色口径（已拍板）：
 *   admin  = 全权 + 用户管理 + 题库/赛道/文风/模型（系统内部）
 *   member = 客户：管自己的公众号账号（配额内）/ 自己的自动化 / 自己的数据 /
 *            手动生成草稿 + 推送草稿箱（**不改稿**）
 *   guest  = 只读（默认注册角色；expiresAt 过期也降为 guest，见 auth.ts effectiveRole）
 */
import type { NextFunction, Request, Response } from 'express';

import { ForbiddenError } from '../errors.ts';
import { effectiveRole, type Principal } from '../services/auth.ts';

export type Permission =
  // 账号管理（公众号）——guest 无
  | 'oa_account:manage'
  // 手动生成草稿 / 推送草稿箱——member 有（对己）
  | 'content:generate'
  | 'content:push'
  // 改稿/润色/强调——member 不改稿，admin only
  | 'content:revise'
  // 运营数据查看——member 对己
  | 'data:view'
  // 自动化开关（自己的）
  | 'automation:manage'
  // 系统内部：题库/赛道/文风/模型/全局调度/用户管理
  | 'system:manage'
  | 'users:manage';

const ROLE_PERMISSIONS: Record<string, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    'oa_account:manage',
    'content:generate',
    'content:push',
    'content:revise',
    'data:view',
    'automation:manage',
    'system:manage',
    'users:manage',
  ]),
  member: new Set<Permission>([
    'oa_account:manage',
    'content:generate',
    'content:push',
    'data:view',
    'automation:manage',
  ]),
  guest: new Set<Permission>(['data:view']),
};

export function can(role: string, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

/** Express.Request 身份挂载点（authGuard 解析后写入）。 */
export function principalOf(req: Request): Principal | null {
  return (req as { principal?: Principal }).principal ?? null;
}

/** 权限点硬拦。未登录 401（authGuard 已拦一层，这里是兜底），越权 403。 */
export function requirePermission(...perms: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = principalOf(req);
    if (!principal) {
      next(new ForbiddenError('未登录'));
      return;
    }
    const role = effectiveRole(principal);
    const missing = perms.filter((p) => !can(role, p));
    if (missing.length > 0) {
      next(new ForbiddenError(`当前角色（${role}）无权执行此操作：${missing.join(', ')}`));
      return;
    }
    next();
    void res;
  };
}
