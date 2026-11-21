/**
 * /api/* 的鉴权中间件（P2 多用户版）。公开路径只有 /health 与 /auth/*，其余一律 401。
 *
 * 挂载顺序（见 app.ts）：guard 必须在静态内容与业务路由之前，
 * 否则 /api/content（文章 HTML、封面图）会绕过鉴权。
 *
 * 解析出的身份（Principal）挂 `req.principal`，供 permissions.ts 与
 * 各路由做角色/归属判断。解析顺序：会话 cookie → 冒烟旁路（管理令牌已退场）。
 */

import type { NextFunction, Request, Response } from 'express';

import { UnauthorizedError } from '../errors.ts';
import {
  effectiveRole,
  principalFromRequest,
  smokePrincipal,
  type Principal,
} from '../services/auth.ts';
import { principalOf } from './permissions.ts';

/** 公开前缀（相对 /api 的路径）。 */
const PUBLIC_PREFIXES = ['/auth/'];
const PUBLIC_EXACT = new Set(['/health', '/auth']);

/**
 * 冒烟专用旁路：`SMOKE_NO_AUTH=1` 时放行（且非 production）。
 * 给 scripts/smoke-*.ts 用——它们带一堆裸 fetch/静态请求，逐处塞令牌头容易漏。
 * 生产环境（NODE_ENV=production）下此旁路**无效**，防止误带上线。
 */
let warnedBypass = false;

function smokeBypass(): boolean {
  if (process.env.SMOKE_NO_AUTH === '1' && process.env.NODE_ENV !== 'production') {
    if (!warnedBypass) {
      warnedBypass = true;
      // eslint-disable-next-line no-console
      console.warn('[auth] SMOKE_NO_AUTH=1：鉴权已旁路（仅限冒烟，生产环境无效）');
    }
    return true;
  }
  return false;
}

/** 把主体挂到 req（permissions.ts 的 principalOf 读它）。 */
export function attachPrincipal(req: Request, principal: Principal): void {
  (req as { principal?: Principal }).principal = principal;
}

export async function authGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const p = req.path;
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((pre) => p.startsWith(pre))) {
    next();
    return;
  }
  if (smokeBypass()) {
    attachPrincipal(req, smokePrincipal());
    next();
    return;
  }
  const principal = await principalFromRequest(req as never);
  if (!principal) {
    next(new UnauthorizedError('未登录或登录已过期'));
    return;
  }
  // disabled 用户不许用业务接口；pending 可进来但只有 guest 只读权限
  // （注册默认 guest/pending——「guest=只读」是拍板口径，审批后才升 member）。
  if (principal.status === 'disabled') {
    next(new UnauthorizedError('账号已被停用'));
    return;
  }
  attachPrincipal(req, principal);
  // effectiveRole 提前算好挂在 res.locals 供日志/调试（路由里再算也行，幂等）
  res.locals.role = effectiveRole(principal);
  next();
}

export { principalOf };
