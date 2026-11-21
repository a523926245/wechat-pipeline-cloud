/**
 * 赛道删除的服务层。
 *
 * 为什么要抽出来：单条删除（DELETE /api/tracks/:id）与批量删除
 * （POST /api/tracks/bulk-delete）必须共用同一条业务规则——
 * **赛道下还有账号时拒绝删除**（否则账号会跟着一起消失、连带其名下文章）。
 * 批量时这条规则不能放宽：某个赛道有账号就只跳过那一条，其余照删。
 */

import { prisma } from '../db.ts';
import { ConflictError, NotFoundError } from '../errors.ts';

export interface DeleteTrackResult {
  id: number;
  name: string;
}

/**
 * 删除一条赛道。
 *
 * @throws ConflictError 赛道下还有账号（需先删账号或改绑到别处）
 */
export async function deleteTrackById(id: number): Promise<DeleteTrackResult> {
  const t = await prisma.track.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!t) throw new NotFoundError(`赛道 ${id} 不存在`);

  const accountCount = await prisma.oAAccount.count({ where: { trackId: id } });
  if (accountCount > 0) {
    throw new ConflictError(
      `赛道「${t.name}」下还有 ${accountCount} 个账号，请先删除或改绑到其他赛道，再删除本赛道`,
      { accountCount },
    );
  }

  // Angle 由 onDelete:Cascade 自动清理；Article.trackId 置空变"未归属"（内容不删）
  await prisma.track.delete({ where: { id } });
  return { id: t.id, name: t.name };
}
