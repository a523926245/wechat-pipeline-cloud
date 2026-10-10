/**
 * 文章 HTML 解析器。
 *
 * 移植并云化自本机 `reference/python/push_draft.py` 的 Extractor（HTMLParser 实现）。
 * 设计要点（与蓝本保持一致，便于后续对拍）：
 *   - 只认 h1(标题) / h2(小标题) / p(正文)；其余标签忽略
 *   - 行内强调：<strong>/<b> 普通加粗，class 含 key/hl/highlight 的用品牌红
 *   - <span class="num|seq|order|index"> 序号标识：跳过其内部文本，避免与自动编号重复
 *   - 用控制字符 M_B/M_K/M_C 在文本里标记强调，render 阶段再还原成微信内联样式
 *   - 文本节点做 HTML 实体解码（&amp; &lt; &nbsp; &#123; 等）
 *
 * 输入为本系统自己写手（阶段 4）产出的语义化 HTML，结构受控，无需引入重型解析库。
 */

/** 普通加粗标记 */
export const M_B = '\x01';
/** 品牌红（二级强调）标记 */
export const M_K = '\x02';
/** 闭合标记 */
export const M_C = '\x03';

export type BlockTag = 'h2' | 'p';

export interface Block {
  tag: BlockTag;
  /** 含强调标记（M_B/M_K/M_C）的正文 */
  text: string;
}

export interface ParsedArticle {
  /** 首个 h1 作标题；无 h1 时为 null */
  title: string | null;
  /** 顺序保留的小标题与段落 */
  blocks: Block[];
  h2Count: number;
  pCount: number;
  /** 去除强调标记后的纯文本字数 */
  charCount: number;
  /** 强调处数（一级 + 二级） */
  boldCount: number;
  warnings: string[];
}

/** 匹配 HTML 标签，属性里含引号也不破坏（避免 class="a b" 被切错）。 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

const SKIP_SPAN_CLASS_RE = /(?:^|\s)(num|seq|order|index)(?:\s|$)/i;
const KEY_CLASS_RE = /(?:^|\s)(key|hl|highlight)(?:\s|$)/i;

function attrClass(attrs: string): string {
  const m = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs);
  return m ? (m[1] ?? '') : '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // 最后处理，避免二次解码
}

const STRONG_RE = /[\x01\x02]/g;
const ALL_MARK_RE = /[\x01\x02\x03]/g;

export function parseArticle(html: string): ParsedArticle {
  const blocks: Block[] = [];
  let title: string | null = null;
  let cur: 'h1' | BlockTag | null = null;
  let buf: string[] = [];
  let skip = false;
  const emphStack: Array<'b' | 'k'> = [];
  const warnings: string[] = [];

  const flush = (): void => {
    if (!cur) return;
    const text = buf.join('').trim();
    if (text) {
      if (cur === 'h1') {
        if (title === null) title = text;
        else warnings.push('文章含多个 h1，仅首个作为标题，其余已忽略');
      } else {
        blocks.push({ tag: cur, text });
      }
    }
    cur = null;
    buf = [];
    emphStack.length = 0;
  };

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const text = html.slice(last, m.index);
    if (cur && !skip && text) buf.push(decodeEntities(text));
    last = m.index + m[0].length;

    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';

    if (!closing) {
      if (tag === 'h1' || tag === 'h2' || tag === 'p') {
        flush();
        cur = tag;
        skip = false;
        emphStack.length = 0;
      } else if (tag === 'span') {
        if (SKIP_SPAN_CLASS_RE.test(attrClass(attrs))) skip = true;
      } else if (
        (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i') &&
        cur &&
        !skip
      ) {
        if (KEY_CLASS_RE.test(attrClass(attrs))) {
          emphStack.push('k');
          buf.push(M_K);
        } else {
          emphStack.push('b');
          buf.push(M_B);
        }
      }
    } else {
      if ((tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i') && emphStack.length) {
        emphStack.pop();
        buf.push(M_C);
      } else if (tag === 'span' && skip) {
        skip = false;
      } else if ((tag === 'h1' || tag === 'h2' || tag === 'p') && tag === cur) {
        flush();
      }
    }
  }
  const tail = html.slice(last);
  if (cur && !skip && tail) buf.push(decodeEntities(tail));
  flush();

  if (title === null) warnings.push('未从文章中提取到标题（缺少 h1 标签），可在请求中显式传入 title');
  if (blocks.length === 0) warnings.push('未提取到正文（缺少 h2 / p 标签）');

  let charCount = 0;
  let boldCount = 0;
  let h2Count = 0;
  let pCount = 0;
  for (const b of blocks) {
    charCount += b.text.replace(ALL_MARK_RE, '').length;
    boldCount += (b.text.match(STRONG_RE) ?? []).length;
    if (b.tag === 'h2') h2Count++;
    else pCount++;
  }

  return { title, blocks, h2Count, pCount, charCount, boldCount, warnings };
}
