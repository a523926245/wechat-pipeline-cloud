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

/**
 * 漫画生图（阶段二慢任务）的并发/退避/预算参数。
 *
 * 单独拎出来是因为这几个值必须靠真机跑才能定：生图 30~40s/张、上游会限流，
 * 「一次心跳推进几格、同时跑几格、失败后隔多久重试、单次心跳最多烧多久」
 * 都得能不改动代码就调。全部有默认值，不配也照常工作。
 */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const COMIC_IMAGE = {
  /** 单次推进最多处理多少格（全局扫描模式的格数上限）。 */
  maxPanelsPerRun: intEnv('COMIC_MAX_PANELS_PER_RUN', 3, 1, 20),
  /** 同一篇文章内并行生图的格数（>1 才真的并发）。 */
  concurrency: intEnv('COMIC_PANEL_CONCURRENCY', 2, 1, 6),
  /** 失败退避基数：第 n 次失败等 base * 2^(n-1) 毫秒。 */
  retryBaseDelayMs: intEnv('COMIC_RETRY_BASE_DELAY_MS', 20_000, 0, 600_000),
  /** 退避上限，避免 attempt 很大时等到天荒地老。 */
  retryMaxDelayMs: intEnv('COMIC_RETRY_MAX_DELAY_MS', 300_000, 1_000, 3_600_000),
  /** 单次调度心跳给阶段二（生图）的时间预算；用完下次心跳继续，状态机幂等不会漏格。 */
  tickBudgetMs: intEnv('COMIC_TICK_BUDGET_MS', 240_000, 10_000, 1_800_000),
  /**
   * 自动推进把预算用尽、但仍有格没画完时，隔多久自动续跑一轮。
   * 目的是「一篇漫画一定能自己画完」，不让用户看到 5/6 卡住还要手动点。
   */
  continueDelayMs: intEnv('COMIC_CONTINUE_DELAY_MS', 15_000, 1_000, 600_000),
} as const;

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export function ensureContentDirs(): { articles: string; covers: string; comics: string } {
  const articles = ensureDir(join(CONTENT_DIR, 'articles'));
  const covers = ensureDir(join(CONTENT_DIR, 'covers'));
  // 漫画产线产物：ill-{seq}.png 场景插图 + quote-{articleId}-{seq}.jpg 金句卡（按文章隔离）
  const comics = ensureDir(join(CONTENT_DIR, 'comics'));
  return { articles, covers, comics };
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
