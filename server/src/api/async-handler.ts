/**
 * Express 4 的 async 路由包装器。
 *
 * Express 4 不认识返回 Promise 的 handler：里面抛出的异常不会进错误中间件，
 * 请求会一直挂起。用 next(err) 转发是标准解法。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
