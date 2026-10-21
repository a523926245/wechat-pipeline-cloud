/**
 * 强调自动补全（后处理器，移植自本机 auto_emphasis.py）。
 *
 * 背景：LLM 对「加粗 N 处」这种格式指令执行不到位，但内容类要求能落实。
 * 所以格式层不指望模型，改由这里确定性补齐：只在现有加粗不足下限时补，
 * 绝不重复加粗已强调的句子；按句式特征打分挑候选（优先口诀、祈使、判断标准句）。
 *
 * 作用在 contentHtml（含 <strong> / <strong class="key"> 的语义 HTML）上，
 * 应用后调用方应重新 parse → render 以保持 contentWechat 与预览一致。
 */

// 口径与 style_dna.json「强调标注规范·密度红线」一致：全篇 8-12 处，红字计入总数。
export const DEFAULT_MIN = 8;
export const DEFAULT_MAX = 12;
const KEY_MIN = 2;
const KEY_MAX = 3;

// 祈使/方法句开头
const IMPERATIVE = /^(先|再|别|要|记住|试着|可以|不妨|不如|与其|下次|这时候|第一步|然后)/;
// 判断标准句特征
const JUDGE = /(关键是|重点在|判断标准|分界线|真正的|核心是|标准只有一个|要看的是)/;
// 对照话术
const CONTRAST = /(别说|改成|换成|说这句|那句)/;

const SENT_SPLIT = /(?<=[。！？；])/;
const P_RE = /<p[^>]*>(.*?)<\/p>/gs;
const TAG_RE = /<[^>]+>/g;

function stripTags(s: string): string {
  return s.replace(TAG_RE, '');
}

/** 给候选句打分，越高越值得强调。 */
function score(sent: string): number {
  let s = 0;
  // 提问句不强调：style_dna 明写着「结尾互动提问保持口语松弛」，
  // 而它偏偏最容易得分（短、带引号），不扣分就会被升级成红字。
  if (/[？?]/.test(sent)) s -= 6;
  if (/[「『“"].{4,24}[」』”"]/.test(sent)) s += 3; // 引号内多为可带走的口诀
  if (IMPERATIVE.test(sent)) s += 2;
  if (JUDGE.test(sent)) s += 3;
  if (CONTRAST.test(sent)) s += 2;
  const n = sent.length;
  if (n >= 10 && n <= 40) s += 2;
  else if (n <= 60) s += 1;
  else s -= 2; // 太长加粗反而糊
  if (/[，、].{0,6}[，、]/.test(sent)) s -= 1; // 逗号堆叠的并列句不宜整句加粗
  return s;
}

interface Cand {
  score: number;
  len: number;
  sent: string;
}

/** 从所有 <p> 中收集未加粗候选句（已强调段落的句子降权）。 */
function collectCandidates(html: string): Cand[] {
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(P_RE)) {
    const para = m[1] ?? '';
    const penalty = para.includes('<strong') ? 1 : 0;
    for (const raw of para.replace(TAG_RE, '').split(SENT_SPLIT)) {
      const sent = raw.trim();
      if (sent.length < 8) continue;
      if (seen.has(sent)) continue;
      seen.add(sent);
      const sc = score(sent) - penalty;
      if (sc > 0) cands.push({ score: sc, len: sent.length, sent });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.len - b.len);
  return cands;
}

function emphasisCount(html: string): number {
  return (html.match(/<strong(?:\s[^>]*)?>/g) ?? []).length;
}

function keyCount(html: string): number {
  return (html.match(/class="key"/g) ?? []).length;
}

/** 所有 <strong> 区间的 [起, 止) 下标，用来判断某个插入点是否落在已有强调内部。 */
function strongSpans(html: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of html.matchAll(/<strong[^>]*>[\s\S]*?<\/strong>/gi)) {
    const s = m.index ?? 0;
    out.push([s, s + m[0].length]);
  }
  return out;
}

/**
 * 把嵌套的 <strong> 拍平，只保留最外层。
 *
 * 2026-10-15 实证：成稿里出现过 `<strong>原来「棒<strong class="key">…</strong>…`
 * 这种嵌套（模型复述整篇时自己造出来的）。嵌套会被渲染成一半红一半不红的怪样式，
 * 而这里全靠标签配对定位，一旦嵌套，长度与计数全乱 —— 所以先拍平再补齐。
 */
function flattenStrong(html: string): string {
  let out = '';
  let last = 0;
  let depth = 0;
  for (const m of html.matchAll(/<strong[^>]*>|<\/strong>/gi)) {
    const pos = m.index ?? 0;
    const open = !m[0].startsWith('</');
    if (open) depth += 1;
    else depth = Math.max(0, depth - 1);
    // 层内标签（depth>1 的开标签、depth>=1 的闭标签）属于内层，直接删
    const inner = open ? depth > 1 : depth >= 1;
    if (inner) {
      out += html.slice(last, pos);
      last = pos + m[0].length;
    }
  }
  return out + html.slice(last);
}

/** 按候选顺序补加粗，返回 (新html, 实际补了几处)。 */
function addBold(html: string, need: number): [string, number] {
  const cands = collectCandidates(html);
  let out = html;
  let added = 0;
  for (const c of cands) {
    if (added >= need) break;
    // 每次插入都会改动下标，所以区间要重新算（否则会把 <strong> 套进另一个 <strong> 里）
    const spans = strongSpans(out);
    let idx = 0;
    let done = false;
    while (!done) {
      const pos = out.indexOf(c.sent, idx);
      if (pos < 0) break;
      const end = pos + c.sent.length;
      const inside = spans.some(([s, e]) => pos < e && end > s);
      if (inside) {
        // 该处已被强调过（或与之重叠），换下一处出现位置
        idx = pos + 1;
        continue;
      }
      out = out.slice(0, pos) + '<strong>' + c.sent + '</strong>' + out.slice(end);
      added += 1;
      done = true;
    }
  }
  return [out, added];
}

/** 所有 <p> 区间的 [起, 止)，用来避免红字扎在同一段里。 */
function paraSpans(html: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of html.matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi)) {
    const s = m.index ?? 0;
    out.push([s, s + m[0].length]);
  }
  return out;
}

/** 把最强的普通加粗升级为红色 key。 */
function promoteKey(html: string, need: number): [string, number] {
  if (need <= 0) return [html, 0];
  const pat = /<strong>(.*?)<\/strong>/gs;
  const spans = paraSpans(html);
  const best: Array<{ score: number; start: number; end: number; inner: string }> = [];
  for (const m of html.matchAll(pat)) {
    // 保留原文（含可能的红字/嵌套）：拍平过的输入到这里不会再有嵌套，
    // 真要剥离标签反而会把已经标好的红字抹掉。
    const inner = m[1] ?? '';
    let sc = score(stripTags(inner));
    if (JUDGE.test(inner)) sc += 4;
    best.push({ score: sc, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, inner });
  }
  best.sort((a, b) => b.score - a.score || a.start - b.start);
  let out = html;
  let picked = 0;
  let offset = 0;
  const usedPara = new Set<number>();
  for (const c of best) {
    if (picked >= need) break;
    // 同一段最多 1 处红字：两处红字挨在一起就成了「整段都在喊」。
    const pi = spans.findIndex(([s, e]) => c.start >= s && c.start < e);
    if (pi >= 0 && usedPara.has(pi)) continue;
    if (pi >= 0) usedPara.add(pi);
    const st = c.start + offset;
    const en = c.end + offset;
    const repl = `<strong class="key">${c.inner}</strong>`;
    out = out.slice(0, st) + repl + out.slice(en);
    offset += repl.length - (c.end - c.start);
    picked += 1;
  }
  return [out, picked];
}

export interface EmphasisStats {
  originBold: number;
  addedBold: number;
  finalBold: number;
  originKey: number;
  addedKey: number;
  finalKey: number;
}

export interface EmphasisResult {
  contentHtml: string;
  stats: EmphasisStats;
  changed: boolean;
}

/** 主入口：不足下限补加粗，红字不足补红字。返回新 HTML 与统计。 */
export function processEmphasis(
  html: string,
  minN = DEFAULT_MIN,
  maxN = DEFAULT_MAX,
  keyMin = KEY_MIN,
  keyMax = KEY_MAX,
): EmphasisResult {
  void keyMax;
  // 先拍平嵌套：模型复述整篇时会造出 <strong>…<strong class="key">…</strong>，
  // 带着嵌套往下走，计数与插入位置都会错位。
  let out = flattenStrong(html);
  const cur = emphasisCount(out);
  let need = 0;
  if (cur < minN) {
    need = Math.min(minN + Math.floor((maxN - minN) / 2), maxN) - cur;
  }
  let added = 0;
  if (need > 0) {
    [out, added] = addBold(out, need);
  }

  const kc = keyCount(out);
  let kneed = 0;
  if (kc < keyMin) kneed = keyMin - kc;
  let kadded = 0;
  if (kneed > 0) {
    [out, kadded] = promoteKey(out, kneed);
  }

  return {
    contentHtml: out,
    changed: added > 0 || kadded > 0,
    stats: {
      originBold: cur,
      addedBold: added,
      finalBold: emphasisCount(out),
      originKey: kc,
      addedKey: kadded,
      finalKey: keyCount(out),
    },
  };
}
