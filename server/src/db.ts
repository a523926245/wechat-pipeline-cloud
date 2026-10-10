/**
 * Prisma 客户端单例。
 *
 * 注意：本地用 SQLite schema 生成过 client 后，切回 MySQL 需要重新
 * `npm run prisma:generate`，因为两者共用同一个生成目录。
 */

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

/** 健康检查用：确认数据库连通。 */
export async function checkDb(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * 命名锁，防止排产等动作并发重入。
 *
 * MySQL 用 GET_LOCK；SQLite 无此能力，退化为直接放行（本地开发单进程够用）。
 */
export async function withLock<T>(
  name: string,
  timeoutSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const isSqlite = (process.env.DATABASE_URL ?? '').startsWith('file:');
  if (isSqlite) return fn();

  const rows = (await prisma.$queryRawUnsafe(
    'SELECT GET_LOCK(?, ?) AS got',
    name,
    timeoutSec,
  )) as Array<{ got: number | null }>;
  const got = rows?.[0]?.got;
  if (got !== 1) return null;
  try {
    return await fn();
  } finally {
    await prisma.$queryRawUnsafe('SELECT RELEASE_LOCK(?)', name);
  }
}
