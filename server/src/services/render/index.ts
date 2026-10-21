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

/**
 * 排版基调（2026-10-14 参考一篇成品排版稿重定）。
 *
 * 三条原则，改样式前先读：
 * 1. **全部 inline style**。微信编辑器会剥掉 `<style>` 标签与 class，
 *    任何放在 `<style>` 里或靠 class 驱动的样式在推送后都会失效 —— 预览好看、发出去变裸文。
 * 2. **单一主色贯穿**。旧版序号用蓝、标题用品牌红、正文用灰，三套颜色互相打架；
 *    现在标题/序号/分隔线/强调统一走 ACCENT，只靠深浅分两级。
 * 3. **677px 是微信正文容器宽度**。超过这个宽度在手机端会被压缩，排版节奏失效。
 */
const ACCENT = '#B35D3E';
const ACCENT_DEEP = '#8A4B2A'; // 一级强调：出现次数多，压低亮度避免满屏刺眼
const INK = '#33302C'; // 正文：暖灰，比纯灰更贴纸感

const EM_OPEN = `<strong style="font-weight:700;color:${ACCENT_DEEP};">`;
const KEY_OPEN = `<strong style="font-weight:700;color:${ACCENT};">`;
const EM_CLOSE = '</strong>';

/** 章节之间的分隔线：36×2px 主色块，比 hr 更可控（hr 在微信里样式不定）。 */
const DIVIDER =
  '<p style="text-align:center;margin:30px 0;">' +
  `<span style="display:inline-block;width:36px;height:2px;background:${ACCENT};"></span></p>`;

const P_STYLE =
  `margin:0 0 20px;line-height:1.9;color:${INK};letter-spacing:.5px;text-align:justify;`;
const H2_STYLE =
  `text-align:center;font-size:19px;font-weight:700;color:${ACCENT};` +
  "margin:34px 0 16px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";
const SECTION_STYLE =
  "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
  `font-size:16px;color:${INK};padding:4px 2px;max-width:677px;margin:0 auto;`;

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
      const inner = `<span style="color:${ACCENT};font-style:italic;font-weight:700;">${seq}</span>&nbsp;${t}`;
      // 章节之间插分隔线，第一节之前不插（正文直接从标题下开始）。
      if (h2Index > 1) parts.push(DIVIDER);
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
