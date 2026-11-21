/**
 * Prisma 客户端单例。
 *
 * 注意：改 prisma/schema.prisma 后需重新 `npm run prisma:generate`。
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
 * 命名锁，防止排产等动作并发重入（MySQL GET_LOCK）。
 */
export async function withLock<T>(
  name: string,
  timeoutSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
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
