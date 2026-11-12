/**
 * 批量删除的公共骨架。
 *
 * 为什么要单独一层：单条删除（DELETE /x/:id）与批量删除（POST /x/bulk-delete）
 * 必须共用同一套资源语义——「删选题要解除文章关联」「删账号要级联删文并归还角度」
 * 「删赛道有账号时拒绝」——两处各写一份迟早漂移，所以只在这里跑循环，
 * 业务语义仍由各资源自己的 service 负责。
 *
 * 三条设计约定：
 *   1. **逐条独立**：一条失败不阻断其余（赛道里有账号只能跳过那一条）。
 *   2. **失败必带原因**：failed[] 里写清「为什么没删掉」，前端原样展示，
 *      不能只报一个总数让用户猜。
 *   3. **不静默去重**：ids 重复时只删一次（否则计数会虚高）。
 */

import { z } from 'zod';

import { AppError } from '../errors.ts';

/** 单次批量删除的条数上限：再多就分批，防一次请求把库锁死。 */
const MAX_BULK = 200;

export const bulkDeleteSchema = z.object({
  ids: z
    .array(z.coerce.number().int().positive())
    .min(1, '至少选择一条')
    .max(MAX_BULK, `一次最多删除 ${MAX_BULK} 条`),
});

export interface BulkDeleteFailure {
  /** 删除失败的资源 id */
  id: number;
  /** 失败原因（直接展示给用户） */
  reason: string;
}

export interface BulkDeleteResult {
  ok: boolean;
  /** 去重后的请求条数 */
  total: number;
  /** 成功删除的条数 */
  deleted: number;
  /** 失败明细（逐条带原因） */
  failed: BulkDeleteFailure[];
  /** 附加统计：如级联删了几篇文章、归还了几个选题 */
  details: Record<string, number>;
  /** 面向用户的一句话总结 */
  message: string;
}

/** 单条删除要返回的附加计数（各资源自己定义，键名在 details 里体现）。 */
export type BulkDeleteDetails = Record<string, number>;

/**
 * 逐条执行删除，汇总成功/失败。
 *
 * @param ids    前端勾选的 id 列表（内部去重）
 * @param one    单条删除动作；抛错即视为该条失败，错误信息会被采集
 * @param label  资源中文名，用于拼提示文案（如「选题」）
 */
export async function runBulkDelete(
  ids: number[],
  one: (id: number) => Promise<BulkDeleteDetails | void>,
  label: string,
): Promise<BulkDeleteResult> {
  const unique = [...new Set(ids)];
  const failed: BulkDeleteFailure[] = [];
  const details: BulkDeleteDetails = {};
  let deleted = 0;

  for (const id of unique) {
    try {
      const d = await one(id);
      deleted += 1;
      for (const [k, v] of Object.entries(d ?? {})) {
        details[k] = (details[k] ?? 0) + v;
      }
    } catch (e) {
      failed.push({ id, reason: e instanceof AppError || e instanceof Error ? e.message : '删除失败' });
    }
  }

  const message =
    failed.length === 0
      ? `已删除 ${deleted} 条${label}`
      : `已删除 ${deleted} 条${label}，${failed.length} 条未删除（见下方原因）`;

  return { ok: failed.length === 0, total: unique.length, deleted, failed, details, message };
}
