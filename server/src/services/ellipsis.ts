/**
 * 省略号补齐（确定性后处理器）。
 *
 * ── 为什么不能只写在提示词里 ──────────────────────────────────────
 * 「省略号 ≥2 处」这条从 2026-10-14 就写进了 SYSTEM_PROMPT 与 style_dna，
 * 但实测本机 14 篇成稿**省略号恒为 0 处**，云端的样本也一样。
 * 原因和加粗一模一样：模型对「数量少、颗粒细、不影响语义」的格式/语气指令服从度极低。
 * 省略号代表犹豫、拖音、话没说完，是「语言模式化」这条机器指纹里最廉价也最像人的补丁，
 * 所以和加粗一样交给确定性后处理，不靠模型。
 *
 * ── 三条硬约束 ────────────────────────────────────────────────────
 * 1. **只改句末标点**：把选中的那个「。」换成「……」，不增删任何文字。
 *    ↳ 必须放在 `reflowParagraphs` **之后**：重排按「。」切句，先改会吞掉一个句边界。
 * 2. **不动加粗**：候选句的字符类里排除了 `<>`，落在 `<strong>` 里的句子天然选不中。
 * 3. **宁缺勿滥**：只在真正像「话没说完」的句子上下手，凑不够 min 就不硬凑。
 */

/**
 * 全篇省略号下限（处）。
 *
 * ⚠️ 2026-11-11：本处理器已从 `postProcess()` 摘除——它只服务于「省略号 ≥2 处」
 * 这条**去 AI 味**条款，而该能力已整体下线（接口见 `services/ai-taste/index.ts`）。
 * 文件保留，等去 AI 味重启时一起接回来。
 */
export const ELLIPSIS_MIN = 2;
/** 上限：再多就成「每句话都在犹豫」，反而变成另一种套路。 */
export const ELLIPSIS_MAX = 3;

const P_RE = /<p[^>]*>([\s\S]*?)<\/p>/g;
/**
 * 候选句：一段不含尖括号、以「。」收尾的连续文字。
 * 排除尖括号是关键——落在 <strong> 里的句子（金句/口诀）因此永远选不中。
 */
const SENT_RE = /[^<>。！？；]{8,}。(?![」』”"）】》])/g;

/** 犹豫 / 没说完 / 想不起来：省略号的正当用法。 */
const HESITATE = /(不知道|说不清|记不清|记不得|也许|好像|可能|大概|犹豫|想了想|算了|还是|到底|其实|不敢|怕|愣|没说完|半句|说不下)/;
/** 拖音与商量的口气。 */
const TAIL_MOOD = /(吧|呢|吗|啊|嘛)\s*。$/;
/** 引号内多半是原话，话说到一半最自然。 */
const QUOTED = /[「『“"][^」』”"]{4,}[」』”"]/;

const ELLIPSIS = '……';

/** 所有 <strong> 区间的 [起, 止)：落在里面的句子一律不动。 */
function strongSpans(html: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of html.matchAll(/<strong[^>]*>[\s\S]*?<\/strong>/gi)) {
    const s = m.index ?? 0;
    out.push([s, s + m[0].length]);
  }
  return out;
}

export interface EllipsisResult {
  contentHtml: string;
  /** 全文原有几处 */
  origin: number;
  /** 本次补了几处 */
  added: number;
  changed: boolean;
}

interface Cand {
  /** 第几个 <p>：用来把省略号摊开，别挤在一起 */
  pIdx: number;
  /** 在整串 html 中的绝对下标（替换用） */
  start: number;
  end: number;
  score: number;
}

function scoreSent(s: string): number {
  let sc = 0;
  if (HESITATE.test(s)) sc += 3;
  if (TAIL_MOOD.test(s)) sc += 2;
  if (QUOTED.test(s)) sc += 3;
  const n = s.length;
  if (n >= 12 && n <= 40) sc += 1;
  else if (n > 60) sc -= 2; // 太长的一句话硬加省略号会显得矫情
  if (/[，、].{0,6}[，、]/.test(s)) sc -= 1;
  return sc;
}

/** 已有几「处」省略号（连续的 …… 算一处）。 */
function countPlaces(plain: string): number {
  return (plain.match(/…+/g) ?? []).length;
}

/**
 * 主入口：省略号不足下限时，挑最像「话没说完」的几句把句末句号换成省略号。
 *
 * 保守策略：找不到合适候选就原样返回（宁可让体检继续提示，也不制造别扭的标点）。
 */
export function ensureEllipsis(html: string, min = ELLIPSIS_MIN, max = ELLIPSIS_MAX): EllipsisResult {
  const plain = html.replace(/<[^>]+>/g, '');
  const origin = countPlaces(plain);
  if (origin >= min) return { contentHtml: html, origin, added: 0, changed: false };

  // ⚠️ 光靠 SENT_RE 的字符类挡不住「整句都在 <strong> 里」的情况：
  // 标签在匹配区间**外面**（<strong>句子。</strong>），字符类照样全中，
  // 结果就是把模型写好的金句改了。所以再用区间重叠判一次。
  const spans = strongSpans(html);
  const cands: Cand[] = [];
  let pIdx = 0;
  for (const m of html.matchAll(P_RE)) {
    const base = (m.index ?? 0) + m[0].indexOf(m[1] ?? '');
    for (const s of (m[1] ?? '').matchAll(SENT_RE)) {
      const text = s[0];
      if (text.includes('…')) continue;
      const sc = scoreSent(text);
      if (sc <= 0) continue;
      const start = base + (s.index ?? 0);
      const end = start + text.length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      cands.push({ pIdx, start, end, score: sc });
    }
    pIdx += 1;
  }
  if (cands.length === 0) return { contentHtml: html, origin, added: 0, changed: false };

  // 分数优先；同分时按出现顺序，保证从前半篇开始铺
  cands.sort((a, b) => b.score - a.score || a.start - b.start);

  const need = Math.min(max, min) - origin;
  const picked: Cand[] = [];
  const usedP = new Set<number>();
  for (const c of cands) {
    if (picked.length >= need) break;
    if (usedP.has(c.pIdx)) continue; // 一段最多一处
    picked.push(c);
    usedP.add(c.pIdx);
  }
  if (picked.length === 0) return { contentHtml: html, origin, added: 0, changed: false };

  // 从后往前替换，前面的下标才不会被改动带偏。
  let out = html;
  for (const c of picked.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, c.end - 1) + ELLIPSIS + out.slice(c.end);
  }
  return { contentHtml: out, origin, added: picked.length, changed: true };
}
