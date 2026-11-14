/**
 * JSON 字段统一读写助手。
 *
 * 约定：Json 列**永远以 JSON 字符串形式存取**——写时 stringify，读时 parse。
 * MySQL 的 Json 列存字符串标量能正确往返；读写两端保持同一约定（null/undefined = 未赋值，
 * 落库时由调用方映射为 Prisma.DbNull）。
 */

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
