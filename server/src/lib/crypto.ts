/**
 * 凭据加密与脱敏。
 *
 * 原则：
 * - 明文 Secret 只在内存中存在，落库一律密文
 * - 对外（API / 日志）只返回掩码，永不返回明文
 *
 * 用 AES-256-GCM：自带认证标签，密文被篡改会直接解密失败而不是产出乱码。
 * 存储布局：iv(12) | authTag(16) | ciphertext
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { PLACEHOLDER_PATTERNS } from '../constants.ts';
import { requireMasterKey } from '../config.ts';

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptSecret(plain: string): Buffer {
  if (!plain) return Buffer.alloc(0);
  const key = requireMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(buf: Buffer | Uint8Array | null | undefined): string {
  if (!buf || buf.length === 0) return '';
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length <= IV_LEN + TAG_LEN) return '';
  try {
    const key = requireMasterKey();
    const iv = data.subarray(0, IV_LEN);
    const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = data.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // 密钥轮换失败或数据损坏：返回空串，交由调用方按"凭据缺失"处理。
    // 不抛异常，避免把内部细节带到 API 层。
    return '';
  }
}

/** 脱敏成 wx1234******abcd 形式，用于界面展示与日志。 */
export function maskSecret(plain: string | null | undefined, keep = 4): string {
  if (!plain) return '';
  if (plain.length <= keep * 2) return '*'.repeat(plain.length);
  return `${plain.slice(0, keep)}${'*'.repeat(6)}${plain.slice(-keep)}`;
}

export function looksLikePlaceholder(value: string | null | undefined): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

/** 日志脱敏：把出现在文本里的敏感串替换成掩码。 */
export function scrub(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join(maskSecret(s));
  }
  return out;
}

/** 常量时间比较，避免口令比对被时序侧信道利用。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
