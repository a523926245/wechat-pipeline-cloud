/**
 * JSON 字段跨库统一读写助手。
 *
 * 背景：schema 真源用 MySQL 的 Json 类型，但本地 SQLite（由 gen-sqlite-schema.mjs
 * 生成）把 Json 翻译成 String?，Prisma SQLite 要求显式字符串。
 * 为让同一份代码在两端都能跑，约定：这些列**永远以 JSON 字符串形式存取**——
 * 写时 stringify，读时 parse。MySQL 的 Json 列存字符串标量也能正确往返。
 */

const DB_URL = process.env.DATABASE_URL ?? '';

/** 序列化：对象/数组 → JSON 字符串；null/undefined → null。 */
export function packJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value; // 已是字符串则原样（便于透传）
  return JSON.stringify(value);
}

/** 反序列化：字符串 → 解析；非字符串（如已解析对象）原样返回；null → null。 */
export function unpackJson<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/** 当前是否本地 SQLite（用于诊断/日志，不影响存取约定）。 */
export const isSqlite = DB_URL.startsWith('file:') || DB_URL.startsWith('sqlite:');
