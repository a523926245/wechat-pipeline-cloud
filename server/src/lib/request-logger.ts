/**
 * 接口访问日志中间件。
 *
 * 基于 pino-http，复用 src/logger.ts 的 logger（已经双写控制台 + 文件），
 * 这样每条 HTTP 请求都会以结构化形式落到控制台，便于本地开发时直观看到接口调用。
 *
 * 记录内容：方法、路径、状态码、耗时(ms)、客户端 IP、出错时的错误信息。
 * 安全：请求头里的鉴权类字段（authorization / cookie / 等）一律脱敏，避免凭据落日志。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import pinoHttp from 'pino-http';

import { logger } from '../logger.ts';

/** pino-http 会在响应对象上挂 responseTime（毫秒），标准类型里没有，这里补一个窄类型。 */
type ResWithTime = ServerResponse & { responseTime?: number };

function ms(res: ServerResponse): number {
  return Math.round((res as ResWithTime).responseTime ?? 0);
}

/** 取客户端 IP（用于精简后的日志，不再把整段 req/res 头打到控制台）。 */
function clientIp(req: IncomingMessage): string {
  return (req.socket?.remoteAddress as string | undefined) ?? '-';
}

/**
 * Express 在交给子路由时会改写 req.url（剥掉挂载前缀），但 originalUrl 始终保留
 * 客户端发来的原始完整路径。pino-http 的回调类型只声明了 IncomingMessage（无 originalUrl），
 * 这里做个窄断言取出来。
 */
function originalUrl(req: IncomingMessage): string {
  return (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
}

/** 日志里需要脱敏的请求头（不区分大小写）。 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
  'x-access-token',
]);

/** 请求头脱敏：把鉴权类字段值替换成占位符，其余原样保留。 */
function redactHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out as IncomingHttpHeaders;
}

export const requestLogger = pinoHttp({
  logger,
  // wrapSerializers=true：自定义的 req 序列化器会拿到「默认已序列化」的请求对象，
  // 我们只需在它的基础上把敏感请求头抹掉即可，方法/路径/query/params/IP 等自动保留。
  wrapSerializers: true,
  serializers: {
    req(req: { headers?: IncomingHttpHeaders } & Record<string, unknown>) {
      if (req && req.headers) {
        return { ...req, headers: redactHeaders(req.headers) };
      }
      return req;
    },
  },
  // 只在响应结束（finish）时记录一次，避免请求中途被打断时重复输出
  autoLogging: {
    // 仅记录 /api 业务接口；/api/content 是静态文件服务，较吵且意义不大，忽略
    // 注意：用 originalUrl 而非 url，url 会被 Express 路由挂载剥掉 /api 前缀，导致日志里路径不完整
    ignore(req: IncomingMessage) {
      const url = originalUrl(req);
      return !url.startsWith('/api') || url.startsWith('/api/content');
    },
  },
  // 关键：关闭「把整段 req/res 作为子绑定带进日志」的默认行为，
  // 否则控制台会被 headers 之类的大对象撑爆。我们只用 customSuccessObject 补 ip。
  quietReqLogger: true,
  quietResLogger: true,
  // 状态码决定日志级别：2xx/3xx → info，4xx → warn，5xx/异常 → error
  customLogLevel(req: IncomingMessage, res: ServerResponse, err?: Error) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // 用 originalUrl：保留 /api 前缀与完整 query，避免被 Express 路由挂载改写后路径不可读
  // （例：真实 /api/dashboard?backlogDays=3 在 req.url 里会变成 /?backlogDays=3）
  customSuccessMessage(req: IncomingMessage, _res: ServerResponse, responseTime: number) {
    return `${req.method} ${originalUrl(req)} -> ${_res.statusCode} (${Math.round(responseTime)}ms)`;
  },
  customErrorMessage(req: IncomingMessage, res: ServerResponse, err: Error) {
    return `${req.method} ${originalUrl(req)} -> ${res.statusCode} ${err.message} (${ms(res)}ms)`;
  },
  // 精简落库对象：只保留客户端 IP，不再把整段 req/res（含 headers）塞进日志，
  // 控制台（pino-pretty 单行）因此保持干净，关键信息都在 msg 里。
  customSuccessObject(req: IncomingMessage) {
    return { ip: clientIp(req) };
  },
  customErrorObject(req: IncomingMessage, _res: ServerResponse, err: Error) {
    return { ip: clientIp(req), err: err.message };
  },
});
