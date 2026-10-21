/**
 * 模型产出 HTML 的清洗。writer 与 revise 共用，避免两份实现各自漂移。
 *
 * 设计原则：**能救回来就不判废**。模型是抽样器，偶尔会漏 `<p>` 标签、偶尔会在代码块里加围栏，
 * 只要 `<h1>/<h2>` 与正文还在，就应当修复而不是丢掉整篇回退骨架——
 * 2026-10-13 首篇样稿就是因为差一层 `<p>` 被判「内容不可用」，白白烧了一次生成。
 */

/** 块级标签的起止（行粒度，已正则限定属性写法）。 */
const BLOCK_OPEN_RE = /^<(h1|h2|p)(\s[^>]*)?>$/i;
const BLOCK_CLOSE_RE = /^<\/(h1|h2|p)>$/i;

/** 去掉 ```html ... ``` 这类包裹。 */
function stripFences(raw: string): string {
  const s = raw.trim();
  const fence = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(s);
  return fence && fence[1] ? fence[1].trim() : s;
}

/**
 * 把「有标题、却少了 `<p>`」的输出补成合法结构。
 *
 * 两种常见抖动都能修：
 * 1. `<h2>…</h2>` 后面直接跟裸文本（整篇一个 `<p>` 都没有）；
 * 2. 部分段落有 `<p>`、另一部分是裸文本。
 *
 * 已经在标签内的连续行会合并成同一段落；标签外的裸文本按「一行一段」处理。
 * 没有 `<h1>/<h2>` 时不介入——那是真的没写出文章，交给上层判废。
 */
export function normalizeBareParagraphs(html: string): string {
  if (!/<h[12][\s>]/.test(html)) return html;

  // 块级标签各自独占一行（开标签前后、闭标签前后都断行）：
  // 模型有时把 <h1>…</h1> <h2>…</h2> 正文 全挤在一行里，不断行就没法按行判断。
  const lines = html
    .replace(/\s*<(h1|h2|p)(\s[^>]*)?>\s*/gi, '\n<$1$2>\n')
    .replace(/\s*<\/(h1|h2|p)>\s*/gi, '\n</$1>\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  let tag: 'h1' | 'h2' | 'p' | null = null;
  let buf = '';

  /** 收口已攒下的内容：在标签内就还成该标签，否则补一个 <p> 救回来。 */
  const flush = (): void => {
    const t = buf.trim();
    buf = '';
    if (tag) {
      out.push(`<${tag}>${t}</${tag}>`);
      tag = null;
      return;
    }
    if (t) out.push(`<p>${t}</p>`);
  };

  for (const line of lines) {
    const open = BLOCK_OPEN_RE.exec(line);
    if (open) {
      flush();
      tag = (open[1] ?? 'p').toLowerCase() as 'h1' | 'h2' | 'p';
      continue;
    }
    if (BLOCK_CLOSE_RE.test(line)) {
      flush();
      continue;
    }
    if (tag) {
      // 标签内：连续行属于同一个段落，直接拼接（保留原有 <strong> 等行内标签）。
      buf += line;
    } else {
      // 标签外：一行一段，逐行补 <p>，避免把整篇文章糊成一个巨型段落。
      buf = line;
      flush();
    }
  }
  flush();

  return out.join('\n');
}

/**
 * 清洗入口：去掉围栏 → 补齐空缺的段落标签 → 裁掉首尾多余的说明文字。
 *
 * 顺序很关键：先补标签再截断，否则模型在末尾忘了包 `<p>` 时，
 * 「以最后一个 </p> 收口」会把那段没标签的正文整段切掉。
 */
export function sanitizeModelHtml(raw: string): string {
  let s = normalizeBareParagraphs(stripFences(raw));

  // 若混有前后说明文字，截取到第一个 <h1> 与最后一个 </p> 之间
  const start = s.indexOf('<h1');
  if (start > 0) s = s.slice(start);
  const end = s.lastIndexOf('</p>');
  if (end >= 0) s = s.slice(0, end + 4);

  return s.trim();
}

/** 是否具备可渲染的基本结构（至少要有一个标题与一个段落）。 */
export function looksLikeArticleHtml(html: string): boolean {
  return html.includes('<h1') && html.includes('<p');
}
