/**
 * 变体库的文本 ↔ 条目互转。**必须与后端 `services/style-prompts.ts` 逐字同源**，
 * 否则会出现「页面显示 3 条、写稿实际按 34 条轮换」这种沉默的错。
 *
 * 存储格式（`StylePrompt.prompt`，纯文本）：
 * - 一条变体可以跨多行（骨架卡：第一节/第二节…）
 * - 多条之间用**单独一行** `---` 分隔
 * - 没有 `---` 时，退回历史口径「一行一条」——旧数据因此完全不受影响
 */

/** 与后端 `splitVariantBlocks()` 同一条正则。 */
const BLOCK_SEP = /\n[ \t]*---[ \t]*\n/;

/** 把库里的纯文本切成条目（骨架卡 / 标题公式 / 篇幅档）。 */
export function splitVariantBlocks(text: string | undefined | null): string[] {
  const raw = text ?? '';
  const blocks = raw
    .split(BLOCK_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把条目拼回库里的纯文本。
 *
 * 多于一条时**统一用 `---` 分隔**——理由是可逆：库里现在存的就是这个形态
 * （骨架卡必须这样，标题/篇幅也用同一种写法），回写时保持逐字节一致，
 * 不会出现「只是点开看了一眼、保存后格式就变了」的意外。
 * 只有一条时直接返回，不加分隔符。
 */
export function joinVariantBlocks(blocks: string[]): string {
  const clean = blocks.map((b) => b.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0] ?? '';
  return clean.join('\n---\n');
}

/** 轮换条目数（= 轮换周期）。空配置返回 0。 */
export function variantBlockCount(text: string | undefined | null): number {
  return splitVariantBlocks(text).length;
}

/** 从骨架卡里取一个可读的名字：首行「骨架｜xxx」取 xxx，否则取首行前 18 字。 */
export function blockTitle(text: string, fallbackIndex = 0): string {
  const first = (text ?? '').split('\n')[0]?.trim() ?? '';
  if (!first) return `第 ${fallbackIndex + 1} 张（空）`;
  const m = /^骨架\s*[｜|]\s*(.+)$/.exec(first);
  if (m?.[1]) return m[1].trim();
  return first.length > 22 ? `${first.slice(0, 22)}…` : first;
}

export interface ParsedLength {
  min: number;
  max: number;
  pMin: number;
  pMax: number;
  note: string;
}

/** 与后端 `parseLengthLine()` 完全同源：`字数区间|段数锚|说明`。 */
export function parseLengthLine(line: string): ParsedLength | null {
  const m = /^(\d+)-(\d+)\|(\d+)-(\d+)\|(.+)$/.exec((line ?? '').trim());
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  const pMin = Number(m[3]);
  const pMax = Number(m[4]);
  if (!(min > 0 && max > min && pMin > 0 && pMax >= pMin)) return null;
  return { min, max, pMin, pMax, note: (m[5] ?? '').trim() };
}
