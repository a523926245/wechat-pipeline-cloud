/**
 * 迁移幂等键。抽成纯函数，是为了让「迁移脚本」与「一次性改键脚本」
 * 用的是同一套算法——两边一旦漂移，改完键再跑迁移就会整表重复插入。
 *
 * ## 为什么不能沿用旧算法
 *
 * 旧键：`import:${date}:${account}:${i}`，其中 `i` 是**源数组下标**。
 * 源 history 只要在中间插入一条，后面所有下标平移 → 幂等键全变 →
 * 重跑一次迁移就整表重复插入。而本机流水线仍在持续产出，这是必现风险。
 *
 * 新键：`import2:<date>:<sha1(content)前12位>`，content 只取源里的
 * **不可变事实**（日期/赛道/账号/标题/摘要/角度号），不含任何数组下标。
 *
 * ## 为什么不含 media_id
 *
 * media_id 是推送后才回填的，源里可能先空后填。若纳入哈希，回填那一刻
 * 键就变了，同样会重复插入。宁可让真重复项走 dedupeKeys 加后缀。
 */

import { createHash } from 'node:crypto';

/** 键前缀。`import:` 留给旧键，新键一律 `import2:`，两者可共存、便于核对。 */
export const IDEM_PREFIX = 'import2';
export const LEGACY_IDEM_PREFIX = 'import';

export interface IdemArticle {
  date?: string;
  track?: string;
  account?: string;
  title?: string;
  digest?: string;
  angle_ref?: string;
}

/** 归一化：去首尾空白、压平内部空白，避免换行/全角空格造成哈希漂移。 */
function norm(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 内容派生幂等键。
 *
 * @param groupSeq 同一批里「内容完全相同」的第几份（从 0 起），由 dedupeKeys 计算；
 *                 仅用于所有字段都为空的极端退化场景兜底。
 */
export function articleIdemKey(art: IdemArticle, groupSeq = 0): string {
  const date = norm(art.date);
  const parts = [
    date,
    norm(art.track),
    norm(art.account),
    norm(art.title),
    norm(art.digest),
    norm(art.angle_ref),
  ];
  const content = parts.filter(Boolean).join('');

  // 极端退化：标题摘要角度全空，哈希无从派生，退回日期+组内序号
  if (!content) return `${IDEM_PREFIX}:empty:${date || 'nodate'}:${groupSeq}`;

  const h = createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 12);
  return `${IDEM_PREFIX}:${date || 'nodate'}:${h}`;
}

/** 旧算法，仅 `scripts/fix-article-idem.ts` 改键时使用，业务代码不要用。 */
export function oldArticleIdemKey(art: IdemArticle, index: number): string {
  return `${LEGACY_IDEM_PREFIX}:${norm(art.date)}:${norm(art.account)}:${index}`;
}

/**
 * 同键消歧：第 2 份起追加 `-g2` / `-g3`。
 *
 * 内容完全相同的两条（同日同账号同标题）必须拿到不同的键，否则第二条会被
 * 第一条覆盖掉。至于谁拿 -g1 谁拿 -g2——两者内容相同，互换不影响结果集，
 * 因此按数组顺序分配是稳定且无害的。
 */
export function dedupeKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}-g${n}`;
  });
}

/** 一批文章 → 一批稳定幂等键（含消歧）。源数组顺序变化不影响结果集。 */
export function buildArticleIdemKeys(arts: IdemArticle[]): string[] {
  return dedupeKeys(arts.map((a) => articleIdemKey(a)));
}

/** 判断某个键是不是旧算法产物，用于迁移期核对「还有多少旧键未升级」。 */
export function isLegacyIdemKey(key: string): boolean {
  return key.startsWith(`${LEGACY_IDEM_PREFIX}:`) && !key.startsWith(`${IDEM_PREFIX}:`);
}
