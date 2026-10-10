/**
 * 统一错误类型。
 *
 * Express 4 不会自动捕获 async 路由里抛出的异常，必须显式用 asyncHandler 包裹，
 * 否则会导致请求挂起而不是返回错误。
 */

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly detail?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; detail?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = opts.status ?? 500;
    this.code = opts.code ?? 'internal_error';
    this.detail = opts.detail;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(message, { status: 400, code: 'bad_request', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, { status: 404, code: 'not_found' });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未登录或登录已过期') {
    super(message, { status: 401, code: 'unauthorized' });
  }
}

/** 微信接口错误。errcode 决定是否重试，见 constants.ts。 */
export class WechatApiError extends AppError {
  public readonly errcode: number;
  public readonly errmsg: string;

  constructor(errcode: number, errmsg: string, detail?: unknown) {
    super(`微信接口错误 ${errcode}: ${errmsg}`, {
      status: 502,
      code: 'wechat_api_error',
      detail,
    });
    this.name = 'WechatApiError';
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

/** 资源冲突：删除被引用对象、唯一键重复等。客户端需先解决冲突再重试。 */
export class ConflictError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(message, { status: 409, code: 'conflict', detail });
    this.name = 'ConflictError';
  }
}

/** 凭据不合规（占位值 / 格式不对 / 缺失）。不重试，属于配置问题。 */
export class CredentialError extends AppError {
  constructor(message: string) {
    super(message, { status: 400, code: 'credential_invalid' });
    this.name = 'CredentialError';
  }
}
