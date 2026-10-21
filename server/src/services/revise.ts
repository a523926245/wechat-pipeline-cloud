/**
 * 改写服务：用「改写(revise)」角色绑定的模型润色 / 改写 / 精简文章正文。
 *
 * 与 emphasis（纯正则的确定性补强）不同，这里是真的调 LLM，因此：
 * - 输出必须仍然是本系统的语义化 HTML（h1/h2/p/strong），否则解析与渲染会崩；
 * - 提供「预览(不动库) / 应用(落库+重渲染)」两段式，让用户先看清再决定，
 *   与 emphasis 保持同一致的不变量：contentWechat 永远由 contentHtml 现算。
 */

import { BadRequestError } from '../errors.ts';
import { assertRoleUsable, chatComplete } from './llm.ts';
import { looksLikeArticleHtml, sanitizeModelHtml } from './html-sanitize.ts';

export type ReviseMode = 'polish' | 'rewrite' | 'shorten';

export interface ReviseOptions {
  mode?: ReviseMode;
  /** 用户自由指令，例如「更口语一点」。 */
  instruction?: string;
}

export interface ReviseResult {
  contentHtml: string;
  modelName: string;
  changed: boolean;
}

const MODE_INSTRUCTION: Record<ReviseMode, string> = {
  polish:
    '在保持原意、全文结构与核心观点完全不变的前提下润色文字：让句子更顺、更有画面感，删掉口水话与重复表达。',
  rewrite:
    '在不改变核心观点与事实的前提下换一种叙述方式重写：可以调整段落顺序与例子的表述方式，让文章更抓人。',
  shorten:
    '在不丢失关键信息与金句的前提下精简全文，把总字数压缩 20%～30%，删掉铺陈与重复表述。',
};

const SYSTEM_PROMPT = [
  '你是公众号编辑，负责改写已经成稿的文章。',
  '硬性要求：',
  '1. 只输出 HTML 正文，不要任何解释、前后缀或 markdown 代码块包裹。',
  '2. 必须保留原有的语义化结构标签：<h1> 标题、<h2> 小标题、<p> 段落。',
  '3. 强调标签按原样保留其角色：<strong> 是普通加粗，<strong class="key"> 是核心金句，不要随意增减或互换。',
  '4. 段落形态必须沿用原文节奏：复合长段落（动作、对话、心理活动揉在一起的 3-5 句）要保持，',
  '   不要拆成一句一段；短段落也不要合并成没有留白的大段。禁止把全文改成「短平快」。',
  '5. 不要新增总结性概括句（如「说到底……」「本质上我们要做的是……」）；',
  '   道理要靠细节与对话呈现，不要在小标题下先抛结论再去举例印证。',
  '6. 禁止破折号（——）；禁止「不是X而是Y」的否定框架；禁止杜撰案例或数据。',
  '7. 禁止新增 <img>、<a>、<div>、<span> 等本系统不支持渲染的标签。',
  '8. 不要在文中添加任何说明性的括号批注。',
].join('\n');

function buildUserPrompt(source: string, opts: ReviseOptions): string {
  const mode: ReviseMode = opts.mode ?? 'polish';
  const lines = [`改写要求：${MODE_INSTRUCTION[mode]}`];
  const extra = opts.instruction?.trim();
  if (extra) lines.push(`额外要求（以此为准）：${extra}`);
  lines.push('');
  lines.push('以下是原文 HTML，请按要求改写后输出完整 HTML：');
  lines.push(source);
  return lines.join('\n');
}

/** 归一化后比较，用于判断模型是否真的改动了内容。 */
function normalizeForCompare(html: string): string {
  return html.replace(/\s+/g, '').trim();
}

/** 预览：调用模型改写，不落库。 */
export async function reviseHtml(srcHtml: string, opts: ReviseOptions = {}): Promise<ReviseResult> {
  const source = srcHtml.trim();
  if (!source) throw new BadRequestError('正文为空，无法改写');

  const model = await assertRoleUsable('revise');

  const raw = await chatComplete(
    model,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(source, opts) },
    ],
    { maxTokens: 4000, temperature: 0.7 },
  );

  const cleaned = sanitizeModelHtml(raw);
  if (!looksLikeArticleHtml(cleaned)) {
    throw new BadRequestError(
      `模型「${model.name}」返回的内容缺少必要结构（标题或段落），请重试或换一个模型`,
    );
  }

  return {
    contentHtml: cleaned,
    modelName: model.name,
    changed: normalizeForCompare(cleaned) !== normalizeForCompare(source),
  };
}
