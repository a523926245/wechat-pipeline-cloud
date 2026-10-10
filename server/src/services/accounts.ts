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
import { looksLikePlaceholder, maskSecret } from '../lib/crypto.ts';

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

export { PLACEHOLDER_PATTERNS };
