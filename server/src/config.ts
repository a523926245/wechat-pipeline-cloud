/**
 * 全局配置。
 *
 * 约定：
 * - 所有路径由 BASE_DIR 推导，禁止硬编码绝对路径（本机流水线踩过的坑）
 * - 敏感值只从环境变量读取，绝不写进代码库
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
/** server/src → server → 项目根 */
export const SERVER_DIR = resolve(here, '..');
export const BASE_DIR = resolve(SERVER_DIR, '..');

export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const IS_PROD = NODE_ENV === 'production';

export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

/**
 * 数据库连接串。
 * 本地开发用 SQLite（file:./var/tmp/dev.db），生产用 MySQL。
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? `file:${join(SERVER_DIR, 'var', 'tmp', 'dev.db')}`;

/** 是否 SQLite（影响锁机制与部分能力降级） */
export const IS_SQLITE = DATABASE_URL.startsWith('file:');

/** 内容落盘目录（文章 HTML、封面 PNG） */
export const CONTENT_DIR = process.env.CONTENT_DIR ?? join(BASE_DIR, 'var', 'content');

/** style_dna.json / topic_seeds.json 所在目录 */
export const CONFIG_DIR = process.env.CONFIG_DIR ?? join(BASE_DIR, 'config');

/** 管理界面登录口令 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';

/** 登录态签名密钥 */
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-change-me';

/** 微信接口超时（毫秒） */
export const HTTP_TIMEOUT_MS = Number.parseInt(process.env.HTTP_TIMEOUT_MS ?? '30000', 10);

/** LLM 调用超时（毫秒），比微信接口宽松得多 */
export const LLM_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS ?? '300000', 10);

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export function ensureContentDirs(): { articles: string; covers: string } {
  const articles = ensureDir(join(CONTENT_DIR, 'articles'));
  const covers = ensureDir(join(CONTENT_DIR, 'covers'));
  return { articles, covers };
}

/**
 * Fernet 风格主密钥。生产环境必须从环境变量取，否则重启后已加密的 AppSecret 无法解密。
 * 这里用 32 字节 base64（AES-256-GCM）。
 */
export function requireMasterKey(): Buffer {
  const raw = process.env.APP_SECRET_KEY ?? '';
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('APP_SECRET_KEY 必须是 32 字节的 base64 字符串（AES-256-GCM）');
    }
    return key;
  }
  if (IS_PROD || !IS_SQLITE) {
    throw new Error(
      'APP_SECRET_KEY 未配置。生产环境必须设置，否则重启后已加密的 AppSecret 将无法解密。',
    );
  }
  return devMasterKey();
}

let _devKey: Buffer | null = null;

/** 开发用临时密钥：持久化到 var/tmp，避免每次重启变化导致本地数据失效。 */
function devMasterKey(): Buffer {
  if (_devKey) return _devKey;
  const marker = join(SERVER_DIR, 'var', 'tmp', '.dev_master_key');
  ensureDir(dirname(marker));
  if (existsSync(marker)) {
    _devKey = Buffer.from(readFileSync(marker, 'utf8').trim(), 'base64');
  } else {
    _devKey = randomBytes(32);
    writeFileSync(marker, _devKey.toString('base64'), 'utf8');
  }
  return _devKey;
}
