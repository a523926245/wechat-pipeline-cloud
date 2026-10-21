/**
 * 冒烟脚本共用工具。
 *
 * 核心是「清得干净，但不碰别人的东西」：早前各脚本直接 `deleteMany({})` 全表清空，
 * 结果跑一次冒烟就把浏览器里配好的模型与角色绑定删光了，写稿链路随之下线
 * （2026-10-13 实测）。现在统一按「冒烟-」前缀回收本脚本自己建的行。
 */

import { prisma } from '../src/db.ts';

/**
 * 冒烟脚本建的模型统一叫「冒烟…」。
 * 注意别加连字符：历史上两个脚本一个叫「冒烟-文本模型」、另一个叫「冒烟生图模型」，
 * 写成 '冒烟-' 会让后者的行永远收不回来。
 */
export const SMOKE_PREFIX = '冒烟';

/** 只删本脚本建的模型（角色绑定由 Prisma 级联清理，这里显式删一遍更稳）。 */
export async function deleteSmokeModels(): Promise<void> {
  const rows = await prisma.llmModel.findMany({
    where: { name: { startsWith: SMOKE_PREFIX } },
    select: { id: true },
  });
  const ids = rows.map((m) => m.id);
  await prisma.modelBinding.deleteMany({ where: { modelId: { in: ids } } });
  await prisma.llmModel.deleteMany({ where: { id: { in: ids } } });
}

/** 库里「不属于冒烟」的模型数量。>0 说明这套配置是用户在用的，动不得。 */
export function countForeignModels(): Promise<number> {
  return prisma.llmModel.count({ where: { name: { not: { startsWith: SMOKE_PREFIX } } } });
}
