/**
 * 写作服务：把选题角度写成一篇公众号草稿 HTML。
 *
 * 策略（与本机流水线一致）：
 * - 优先用「写作」角色绑定的 LLM 真实生成；
 * - 没绑模型 / 没 Key / 调用失败时，回退到**骨架草稿**，保证流水线不断、且明确标注待人工补全。
 *
 * 输出 HTML 遵循本系统的语义化约定（<h1> 标题 / <h2> 小标题 / <p> 正文 /
 * <strong> 普通加粗 / <strong class="key"> 品牌红），交给 parse → render 后续处理。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Account, Angle, Track } from '@prisma/client';

import { CONFIG_DIR } from '../config.ts';
import { chatComplete, resolveModelForRole } from './llm.ts';

export interface WriteResult {
  contentHtml: string;
  modelUsed: string | null;
  note: string;
}

const SYSTEM_PROMPT = [
  '你是公众号内容写手。请严格按以下约束产出一篇可直接渲染的 HTML 文章：',
  '1. 只输出 HTML，不要任何解释或 markdown 代码块包裹。',
  '2. 结构：<h1> 一个标题</h1>，随后 9-12 个 <h2> 小标题（带画面感或情绪钩子，不用干标签词），',
  '   每个 <h2> 下 1-3 个 <p> 短段落（每段≤3 句）。',
  '3. 强调：方法动作/判断标准/反面话术用 <strong>；每篇严格 2-3 处核心金句用 <strong class="key">。',
  '4. 合规：段落≤3 句；禁止破折号（——）；禁止「不是X而是Y」否定框架；禁止杜撰伪案例；正文 1500-2000 字。',
  '5. 风格：温暖真诚、朋友聊天感、有具体场景与细节、结尾回扣开头并给一个互动提问。',
].join('\n');

interface StyleTrack {
  desc?: string;
  tone?: string;
  targetReader?: string;
  styleNote?: string;
  goldenStyle?: string;
  forbidden?: string[];
}

function loadStyleDna(): { default?: Record<string, unknown>; tracks?: Record<string, StyleTrack> } {
  try {
    const p = join(CONFIG_DIR, 'style_dna.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) as {
      default?: Record<string, unknown>;
      tracks?: Record<string, StyleTrack>;
    };
  } catch {
    return {};
  }
}

function buildPrompt(angle: Angle, track: Track): string {
  const dna = loadStyleDna();
  const tconf = dna.tracks?.[track.name] ?? dna.tracks?.[track.slug];
  const lines: string[] = [];
  lines.push(`赛道：${track.name}（slug=${track.slug}）`);
  if (tconf) {
    if (tconf.tone) lines.push(`调性：${tconf.tone}`);
    if (tconf.targetReader) lines.push(`目标读者：${tconf.targetReader}`);
    if (tconf.styleNote) lines.push(`语气补充：${tconf.styleNote}`);
    if (tconf.goldenStyle) lines.push(`金句风格：${tconf.goldenStyle}`);
    if (tconf.forbidden?.length) lines.push(`禁忌：${tconf.forbidden.join('；')}`);
  }
  lines.push('');
  lines.push(`选题主题：${angle.theme}`);
  lines.push(`选题角度：${angle.content}`);
  lines.push('');
  lines.push('请基于上述主题与角度写一篇结构紧凑、有具体场景和细节的公众号文章。');
  return lines.join('\n');
}

/** 回退骨架：结构完整、内容待补全，保证 parse/render 不报错且便于人工改稿。 */
function scaffoldHtml(angle: Angle, track: Track): string {
  const theme = angle.theme || track.name;
  return [
    `<h1>${theme}：${angle.content}</h1>`,
    `<p>${angle.content}</p>`,
    `<h2>一个具体的开场场景</h2>`,
    `<p>（待补全：单一具体时刻，带感官细节与一句对话，不要开场直接抛观点）</p>`,
    `<h2>核心区分：一句话讲清主线</h2>`,
    `<p>（待补全：全文只靠一个核心区分支撑，第 3 节前亮明，后文都回扣它）</p>`,
    `<h2>现象扫描</h2>`,
    `<p>（待补全：用 1 个最具象的案例或数据做证据，不要堆砌研究）</p>`,
    `<h2>深层拆解</h2>`,
    `<p>（待补全：拆到底层逻辑，给读者可判断的框架）</p>`,
    `<h2>代价</h2>`,
    `<p>（待补全：不改变的代价，制造真实紧迫感而非恐吓）</p>`,
    `<h2>可执行的方法</h2>`,
    `<p>（待补全：可复述的<strong>短句口诀</strong>或<strong class="key">对照话术</strong>，让读者能带走）</p>`,
    `<h2>回到开头的场景</h2>`,
    `<p>（待补全：回扣开场画面，一句升华 + 一个互动提问）</p>`,
  ].join('\n');
}

/**
 * 生成一篇草稿。返回 HTML；modelUsed 为实际使用的模型名（回退时为 null）。
 */
export async function generateDraft(angle: Angle, track: Track, _account: Account | null): Promise<WriteResult> {
  let model = null as Awaited<ReturnType<typeof resolveModelForRole>>;
  try {
    model = await resolveModelForRole('write');
  } catch {
    model = null;
  }

  if (!model || !model.apiKeyEnc) {
    return {
      contentHtml: scaffoldHtml(angle, track),
      modelUsed: null,
      note: '未绑定写作模型或缺少 API Key，已生成骨架草稿，请在在线改稿中补全内容',
    };
  }

  try {
    const html = await chatComplete(model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(angle, track) },
    ], { maxTokens: 2600 });

    const cleaned = sanitizeHtml(html);
    if (!cleaned.includes('<h1') || !cleaned.includes('<p')) {
      return {
        contentHtml: scaffoldHtml(angle, track),
        modelUsed: null,
        note: `模型「${model.name}」返回内容不可用，已回退骨架草稿`,
      };
    }
    return {
      contentHtml: cleaned,
      modelUsed: model.name,
      note: `已由模型「${model.name}」生成`,
    };
  } catch (e) {
    return {
      contentHtml: scaffoldHtml(angle, track),
      modelUsed: null,
      note: `模型「${model.name}」调用失败（${e instanceof Error ? e.message : String(e)}），已回退骨架草稿`,
    };
  }
}

/** 去掉模型偶尔包在 ```html 代码块里的包裹，并裁剪首尾部多余文本。 */
function sanitizeHtml(raw: string): string {
  let s = raw.trim();
  // 去掉 ```html ... ``` 或 ``` ... ``` 包裹
  const fence = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence && fence[1]) s = fence[1].trim();
  // 若混有前后说明文字，截取到第一个 <h1 与最后一个 </p> 之间
  const start = s.indexOf('<h1');
  const end = s.lastIndexOf('</p>');
  if (start > 0 && end > start) {
    s = s.slice(start, end + 4);
  }
  return s;
}
