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
 * 把「标题被写进 `<strong>` 而不是 `<h1>`」的输出救回来。
 *
 * 2026-11-11 真机生成时抓到：模型偶尔把标题写成
 * `<strong>水逆第三天，已读不回不是忙</strong> <h2>…</h2> <p>…</p>`，
 * 于是 `looksLikeArticleHtml` 判「没有 h1」→ 整篇作废回退骨架草稿，白烧一次生成。
 *
 * 这里只救**开头第一个**被 `<strong>` 包住的标题行（后面跟着 h2/p 的那种），
 * 改成 `<h1>`；正文里的 `<strong>` 一律不动（那些是强调，不是标题）。
 */
function fixStrongTitle(html: string): string {
  // 形如：<strong>标题文字</strong> 后面紧跟 <h2> 或 <p>
  const m = /^(\s*)<strong([^>]*)>([\s\S]{1,80}?)<\/strong>(\s*)(?=<h2[\s>]|<p[\s>])/i.exec(html);
  if (!m) return html;
  const lead = m[1] ?? '';
  const attrs = m[2] ?? '';
  const title = m[3] ?? '';
  const gap = m[4] ?? '';
  // 标题里已经有块级标签就放弃（不是标题，是别的结构）
  if (/<[a-z]/i.test(title)) return html;
  return `${lead}<h1${attrs}>${title}</h1>${gap}${html.slice(m[0].length)}`;
}

/**
 * 清洗入口：去掉围栏 → 救回写成 `<strong>` 的标题 → 补齐空缺的段落标签 → 裁掉首尾多余的说明文字。
 *
 * 顺序很关键：
 * - 先救标题再补标签——补标签会把裸文本包成 `<p>`，标题就被包成段落了，再也认不出；
 * - 先补标签再截断——否则模型在末尾忘了包 `<p>` 时，
 *   「以最后一个 </p> 收口」会把那段没标签的正文整段切掉。
 */
/**
 * 清掉 markdown 加粗残留。
 *
 * 实测（2026-11-12，职场稿）：模型在写「自测清单」这种**带序号的短条目**时，
 * 会不自觉回到 markdown——`**1. 领导要求你"把关"而非"沟通"。**` 直接混进 HTML，
 * 落在页面上就是满屏星号，而且星号会把 `<p>` 切得七零八落（一条自测项被拆成三段）。
 * 条目越多越容易触发，所以我方赛道一换成清单体就立刻暴露。
 *
 * 策略：成对的 `**…**` 还原成 `<strong>`（保留模型想强调的意图），
 * 剩下的落单 `**` 一律删掉（它们只是排版噪声）。
 * 嵌套的 `<strong>` 由 processEmphasis 拍平，这里不用管。
 */
function stripMarkdownBold(html: string): string {
  if (!html.includes('**')) return html;
  return html
    .replace(/\*\*([^*<>]{1,80})\*\*/g, '<strong>$1</strong>')
    .replace(/\*\*/g, '');
}

export function sanitizeModelHtml(raw: string): string {
  let s = stripFences(raw);

  // markdown 加粗残留（必须在补 <p> 之前：星号会把段落边界切碎）
  s = stripMarkdownBold(s);

  // 标题写成 <strong> 的救回（必须在补 <p> 之前）
  s = fixStrongTitle(s);

  s = normalizeBareParagraphs(s);

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
