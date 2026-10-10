/**
 * 极简 fetch 封装。
 *
 * 约定：后端统一以 `{ error: { code, message, detail } }` 返回错误（见 server/src/app.ts），
 * 这里把它还原成带 code/detail 的 ApiError，页面直接用 e.message 提示即可。
 */

const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly detail?: unknown;

  constructor(message: string, status: number, code: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; detail?: unknown };
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = (data ?? {}) as ErrorBody;
    const payload = err.error ?? {};
    throw new ApiError(
      payload.message ?? `请求失败（HTTP ${res.status}）`,
      res.status,
      payload.code ?? 'http_error',
      payload.detail,
    );
  }

  return data as T;
}

export const http = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>('POST', path, body, query),
  put: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>('PUT', path, body, query),
  del: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>('DELETE', path, body, query),
};

/** 取错误文案（ApiError / Error 通用），用于 ElMessage 提示。 */
export function errMsg(e: unknown, fallback = '操作失败'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
