/**
 * 选题占用（S4-4-1 R4）。
 *
 * 为什么单独抽出来：手动建稿有两条入口（文章 `POST /api/articles`、漫画
 * `POST /api/articles/comic/create` → createComicDraft），两条都必须「建稿成功 = 选题被占用」，
 * 且都必须在**同一个事务**里完成，否则会出现「文章建好了但选题还能被别人领走」的窗口。
 * 两处各写一份条件更新，早晚有一处漏改（和 article-delete 抽离同一个理由）。
 *
 * 与排产的差别：排产是 `reserveAnglesForPipeline` 先批量占用再建稿（建稿失败由 planner 补偿）；
 * 手动建稿是用户点一次、建一篇，所以占用就放在建稿的同一事务里，失败自动回滚。
 *
 * 并发保护：一律用 `updateMany({ where: { id, used: false } })` 条件更新——
 * 两个请求同时抢占同一选题时只有一个 count=1，另一个拿到 0 并抛 409，
 * 不做「先读再写」的乐观判断。
 */

import type { Prisma } from '@prisma/client';

import { ConflictError } from '../errors.ts';
import { todayKey } from '../lib/day.ts';

/** 占用归属：有账号就写账号信息，没有账号（纯手动挂稿）就留空。 */
export interface ClaimOwner {
  id: number | null;
  name: string;
  ownerUserId: number | null;
}

/**
 * 归还选题时统一清空的消费态字段。
 * 单一真源：占用（本文件）/ 归还（article-delete、accounts、planner）都用这一份，
 * 免得多处各写一遍导致「有的地方清了 usedById、有的没清」。
 */
export const ANGLE_RELEASE_DATA = {
  used: false,
  usedBy: '',
  usedDate: null,
  usedById: null,
  usedByAccountId: null,
} as const;

/**
 * 在调用方的事务内把选题标记为已占用。
 *
 * @throws ConflictError 选题已被占用（含并发抢占成功者为他人时）
 * @returns 选题不存在时**静默返回**：保持「不存在的 angleId 由 article.create 的外键约束
 *          按原有行为失败」这一既有语义，不在这里改写成 404。
 */
export async function claimAngleInTx(
  tx: Prisma.TransactionClient,
  angleId: number,
  owner: ClaimOwner | null,
): Promise<void> {
  const claimed = await tx.angle.updateMany({
    where: { id: angleId, used: false },
    data: {
      used: true,
      usedBy: owner?.name ?? '',
      usedDate: todayKey(),
      usedById: owner?.ownerUserId ?? null,
      usedByAccountId: owner?.id ?? null,
    },
  });
  if (claimed.count > 0) return;

  // count=0 有两种可能：选题不存在，或已被别人占用。二者要给不同结论，
  // 不能一律报「已被占用」——那会让「填错 id」看起来像「手慢了」。
  const cur = await tx.angle.findUnique({ where: { id: angleId }, select: { id: true, theme: true } });
  if (!cur) return;
  throw new ConflictError(
    `选题「${cur.theme}」已被占用（已用于其他文章），不能重复用于新建文章；如需再用请先归还该选题`,
  );
}
