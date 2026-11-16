/**
 * 文章删除的服务层。
 *
 * 为什么要抽出来：单条删除（DELETE /api/articles/:id）与批量删除
 * （POST /api/articles/bulk-delete）必须共用同一套语义，否则两边会漂移——
 * 尤其是「未送达微信的文章归还选题角度、已送达的不归还」这条业务规则，
 * 写两遍早晚改漏一边。批量删除只是把这条规则跑了 N 遍。
 *
 * ── S4-4-1 R1：判据从「当前状态」改为「推送事实」 ──
 * 原来用 `status !== 'pushed'` 判定「没送达过」，而 status 是**当前态**：
 * 编辑（articles.ts 的 PUT /content）把 pushed 改成 draft，AI 改写/强调补全改成
 * updated，换封面改回 draft，重推失败改成 failed。任一路径之后状态都不再是 pushed，
 * 但微信端明明有草稿——于是删除时把选题错误归还，同一选题被再写一遍、再推一次。
 * 现在改为看本地推送痕迹（mediaId / pushDate 任一非空），它与状态解耦、不会被上述
 * 四条路径抹掉。（「pushed 文章重复推送会新建第二份草稿」是独立问题，本轮不处理。）
 *
 * ── S4-4-1 R3：归还前必须确认「没有其他文章还引用这个选题」 ──
 * Article.angleId 没有唯一约束，一个选题可以被多篇文章引用（手动挂稿 + 排产、
 * 或多账号挂同一题）。原来的归还逻辑只看被删的那一篇，会把仍在被别的文章使用的
 * 选题放回池子里。现在改为**先删文章、再查剩余引用**，为 0 才归还，且只归还
 * 确实处于 used 状态的选题（与 angles.releaseAngle 的既有保护对齐）。
 */

import { prisma } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import { ANGLE_RELEASE_DATA } from './angle-claim.ts';
import type { Principal } from './auth.ts';
import { assertArticleAccess } from './ownership.ts';

export interface DeleteArticleResult {
  id: number;
  title: string;
  /** 该文章占用的选题角度是否已归还池中。 */
  recycledAngle: boolean;
}

/** 判断「是否曾经成功送达微信草稿箱」所需的字段（Article 上是两个非空字符串列）。 */
export interface PushTraceFields {
  mediaId: string | null;
  pushDate: string | null;
}

/**
 * 是否曾经成功推送到微信草稿箱（S4-4-1 R1）。
 *
 * 判据：`mediaId` 或 `pushDate` 任一非空即视为曾推送。
 * - Schema 里两列都是 `String @default("")`（NOT NULL），不会出现 null；
 *   这里仍按 null 安全处理，是为了将来若改成可空列时不会静默误判。
 * - 空字符串与纯空白一律视为「没有」，避免脏数据把未推送稿判成已推送。
 *
 * ⚠️ 这两个字段目前**没有任何清空路径**（只有建稿时写 ''）。若将来新增「重置推送痕迹」
 * 的操作，必须同步检查本函数的语义，否则会重新出现「已推送被当成未推送 → 误归还」。
 */
export function hasPushTrace(a: PushTraceFields): boolean {
  const media = typeof a.mediaId === 'string' ? a.mediaId.trim() : '';
  const date = typeof a.pushDate === 'string' ? a.pushDate.trim() : '';
  return media !== '' || date !== '';
}

/**
 * 删除一篇文章（连同角度回收）。
 *
 * 语义（S4-4-1 之后）：
 *  - **曾经送达微信**（mediaId 或 pushDate 非空）的文章，其选题一律不归还——
 *    无论此刻 status 是 pushed / updated / draft / failed；
 *  - 未送达的：先删文章，再确认该选题没有任何其他文章引用，才归还；
 *  - 只归还确实处于 used=true 的选题（否则「归还一个没占用过的题」是假信号）。
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
        angleId: true,
        accountId: true,
        account: { select: { ownerUserId: true } },
        // 推送事实（R1）。刻意不取 status：判据不该再依赖当前态。
        mediaId: true,
        pushDate: true,
      },
    });
    assertArticleAccess(principal, a, id);
    if (!a) throw new NotFoundError(`文章 ${id} 不存在`);

    const everPushed = hasPushTrace(a);

    // 先删文章（R3）：之后的引用计数才是「其他文章」的真实数量，不被本篇自己干扰；
    // 同时让「delete 失败 → 整笔回滚、选题不被误归还」成为唯一失败面。
    await tx.article.delete({ where: { id } });

    let recycledAngle = false;
    if (!everPushed && a.angleId != null) {
      const stillUsed = await tx.article.count({ where: { angleId: a.angleId } });
      if (stillUsed === 0) {
        // 用 updateMany 而非 update：选题可能已被手动删除（那时 angleId 会先被置空，
        // 但并发读到旧值时 update 会抛 P2025 变成 500）。updateMany 找不到就影响 0 行。
        // 条件 used:true 保证「没占用过就不算归还」，recycledAngle 的语义才可信。
        const back = await tx.angle.updateMany({
          where: { id: a.angleId, used: true },
          data: ANGLE_RELEASE_DATA,
        });
        recycledAngle = back.count > 0;
      }
    }

    return { id: a.id, title: a.title, recycledAngle };
  });
}
