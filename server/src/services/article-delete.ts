/**
 * 文章删除的服务层。
 *
 * 为什么要抽出来：单条删除（DELETE /api/articles/:id）与批量删除
 * （POST /api/articles/bulk-delete）必须共用同一套语义，否则两边会漂移——
 * 尤其是「未推送的文章归还选题角度、已推送的不归还」这条业务规则，
 * 写两遍早晚改漏一边。批量删除只是把这条规则跑了 N 遍。
 */

import { prisma } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type { Principal } from './auth.ts';
import { assertArticleAccess } from './ownership.ts';

export interface DeleteArticleResult {
  id: number;
  title: string;
  /** 该文章占用的选题角度是否已归还池中。 */
  recycledAngle: boolean;
}

/**
 * 删除一篇文章（连同角度回收）。
 *
 * 角度回收语义与 deleteAccount 一致：
 *  - 未送达微信（draft/updated/failed）的文章，其占用的角度归还池中，可再次选题；
 *  - 已推送（pushed）的不归还，否则同一选题会被再写一遍。
 *
 * @param principal 当前登录主体：非 admin 只能删自己名下账号产出的文章。
 */
export async function deleteArticleById(
  id: number,
  principal: Principal,
): Promise<DeleteArticleResult> {
  return prisma.$transaction(async (tx) => {
    const a = await tx.article.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        angleId: true,
        accountId: true,
        account: { select: { ownerUserId: true } },
      },
    });
    assertArticleAccess(principal, a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);

    let recycledAngle = false;
    if (a.status !== 'pushed' && a.angleId != null) {
      // 用 updateMany 而非 update：选题可能已被手动删除（那时 angleId 会先被置空，
      // 但并发读到旧值时 update 会抛 P2025 变成 500）。updateMany 找不到就影响 0 行。
      const back = await tx.angle.updateMany({
        where: { id: a.angleId },
        data: { used: false, usedBy: '', usedDate: null, usedById: null, usedByAccountId: null },
      });
      recycledAngle = back.count > 0;
    }

    await tx.article.delete({ where: { id } });
    return { id: a.id, title: a.title, recycledAngle };
  });
}
