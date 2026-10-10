/**
 * 微信草稿渲染器。
 *
 * 这是「预览」与「推送」共用的**唯一**渲染函数（README 硬性要求：
 * 预览与推送必须共用同一函数，否则会出现「后台看的和发出去的不一样」）。
 *
 * 移植自本机 `reference/python/push_draft.py` 的样式拼装逻辑：
 *   - 把 parse 阶段留下的强调标记 M_B/M_K/M_C 还原成微信可保留的内联样式
 *   - 小标题自动编号（01/02…），并剔除手写序号避免「11 11」重复
 *   - 包裹 section 容器，套全局字体/字号/行高
 *   - 摘要取首段前 54 字（去除强调标记）
 *   - 标题统一加全局前缀 title_prefix（如「【话】」），幂等：已有则不重复添加
 */

import { M_B, M_K, M_C, parseArticle, type ParsedArticle } from '../parse/index.ts';

const EM_OPEN = '<strong style="font-weight:700;color:#111;">';
const KEY_OPEN = '<strong style="font-weight:700;color:rgb(255,76,65);">';
const EM_CLOSE = '</strong>';

const P_STYLE =
  'margin:0 0 16px;line-height:1.85;color:#333;';
const H2_STYLE =
  "text-align:center;font-size:22px;font-weight:700;color:rgb(255,76,65);" +
  "margin:30px 0 14px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";
const SECTION_STYLE =
  "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
  'font-size:17px;color:#333;padding:4px 2px;';

/** 把强调标记还原成微信内联样式，并修复未闭合的 <strong>。 */
export function renderInline(text: string): string {
  let out = text
    .replace(new RegExp(M_K, 'g'), KEY_OPEN)
    .replace(new RegExp(M_B, 'g'), EM_OPEN)
    .replace(new RegExp(M_C, 'g'), EM_CLOSE);
  const open = (out.match(/<strong/g) ?? []).length;
  const close = (out.match(/<\/strong>/g) ?? []).length;
  if (open > close) out += EM_CLOSE.repeat(open - close);
  return out;
}

/** 兜底：若小标题已手写序号且恰好等于自动编号，剥掉它，避免「11 11…」。 */
function stripDupSeq(text: string, idx: number): string {
  const re = new RegExp(`^\\s*0?${idx}\\s*[.、]?\\s*(?=[一-龥A-Za-z])`);
  const m = re.exec(text);
  return m ? text.slice(m[0].length) : text;
}

export interface RenderOptions {
  /** 标题前缀，默认「【话】」。空串表示不加前缀。 */
  titlePrefix?: string;
  /** 显式覆盖摘要；不传则取首段前 54 字。 */
  digestOverride?: string;
  /** 作者署名，仅用于推送 payload，不影响 contentWechat。 */
  author?: string;
  /** 封面 media_id，仅用于推送 payload。 */
  thumbMediaId?: string;
}

export interface RenderResult {
  title: string;
  digest: string;
  /** 可直接塞进微信 draft.add 的 content 字段 */
  contentWechat: string;
  h2Count: number;
  pCount: number;
  charCount: number;
  boldCount: number;
}

export function renderArticle(parsed: ParsedArticle, opts: RenderOptions = {}): RenderResult {
  const prefix = opts.titlePrefix ?? '【话】';
  let title = parsed.title ?? '';
  if (prefix && !title.startsWith(prefix)) title = prefix + title;

  const parts: string[] = [];
  let h2Index = 0;
  for (const b of parsed.blocks) {
    if (b.tag === 'h2') {
      h2Index += 1;
      const seq = String(h2Index).padStart(2, '0');
      const t = stripDupSeq(b.text, h2Index);
      const inner = `<span style="color:rgb(0,82,255);font-style:italic;font-weight:700;">${seq}</span>&nbsp;${t}`;
      parts.push(`<h2 ${H2_STYLE}>${renderInline(inner)}</h2>`);
    } else {
      parts.push(`<p ${P_STYLE}>${renderInline(b.text)}</p>`);
    }
  }

  const contentWechat = `<section style="${SECTION_STYLE}">${parts.join('')}</section>`;

  const firstPText =
    parsed.blocks.find((b) => b.tag === 'p')?.text.replace(/[\x01\x02\x03]/g, '') ?? '';
  const digest =
    opts.digestOverride ||
    (firstPText.slice(0, 54) + (firstPText.length > 54 ? '…' : ''));

  return {
    title,
    digest,
    contentWechat,
    h2Count: parsed.h2Count,
    pCount: parsed.pCount,
    charCount: parsed.charCount,
    boldCount: parsed.boldCount,
  };
}

/**
 * 把解析 + 渲染串成一步：预览、在线改稿、推送都用它保证产物一致。
 * 返回解析结果（含原始 blocks、warnings）与渲染结果。
 */
export function composeArticle(
  html: string,
  opts: RenderOptions = {},
): { parsed: ParsedArticle; rendered: RenderResult; warnings: string[] } {
  const parsed = parseArticle(html);
  const rendered = renderArticle(parsed, opts);
  return { parsed, rendered, warnings: parsed.warnings };
}
