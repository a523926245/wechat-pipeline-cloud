/**
 * 成稿体检（推送门禁）。
 *
 * 背景：`config/style_dna.json` 一直写着「五项质检，全过方可推送」，而 `constants.ts` 里
 * 那几个阈值（字数 / 节数 / 强调密度）此前**全项目零引用**——规则是死的，写手怎么写都放行。
 * 本服务把它们变成真的门禁：推送前跑一遍，不过就不推。
 *
 * 设计取舍：
 * - **分级**。`error` 拦推送，`warn` 只提示。段落形态这种「靠模型自觉」的指标若也硬拦，
 *   会把大量只差一点的稿子卡死在草稿箱；字数/节数/破折号这类客观指标则必须硬拦。
 * - **阈值单一真源**。`constants.ts` 与 `style_dna.json` 是同一套数，改一处即可，
 *   这里不做第二份硬编码。
 * - **只管文章产线**。漫画正文是图片序列 + 台词，结构规则完全不同，直接跳过。
 *
 * 2026-10-13 版规则（用户反馈「小标题太多 / 每个小标题下先写概括句 / 通篇一句一段太碎」）：
 *   小标题 3-4 个、禁止通篇一句一段、复合长段落不少于 1/3、禁止破折号与否定框架。
 */

import {
  MAX_CHARS,
  MAX_EMPHASIS,
  MAX_KEY_EMPHASIS,
  MAX_PARA_CHARS,
  MAX_SECTIONS,
  MAX_SHORT_PARA_RATIO,
  MIN_CHARS,
  MIN_EMPHASIS,
  MIN_KEY_EMPHASIS,
  MIN_LONG_PARA_RATIO,
  MIN_SECTIONS,
  PARA_LONG_MIN_SENT,
} from '../constants.ts';
import { ALL_MARK_RE, parseArticle, type ParsedArticle } from './parse/index.ts';

export type LintLevel = 'error' | 'warn';

export interface LintIssue {
  level: LintLevel;
  /** 稳定编码，前端可据此做文案映射，不要用中文做判断依据。 */
  code:
    | 'sections'
    | 'chars'
    | 'dash'
    | 'negation'
    | 'para_shape'
    | 'para_short'
    | 'para_overlong'
  | 'emphasis'
  | 'key_emphasis'
  | 'summary_openers'
  | 'ending_hook'
  | 'ai_taste'
  | 'citation';
  message: string;
  /**
   * 命中片段（能精确定位时给出）。
   * 用途有两个：给 writer 的定向修补当证据（告诉模型该改哪一句），以及将来给改稿页做一键定位。
   */
  hits?: string[];
}

export interface LintStats {
  h2Count: number;
  pCount: number;
  charCount: number;
  boldCount: number;
  keyCount: number;
  /** 复合长段落数（≥ PARA_LONG_MIN_SENT 句）。 */
  longPara: number;
  /** 一句一段的段落数。 */
  shortPara: number;
  longRatio: number;
  shortRatio: number;
}

export interface LintReport {
  /** 无 error 级问题即为通过。 */
  ok: boolean;
  stats: LintStats;
  issues: LintIssue[];
  errors: LintIssue[];
  warnings: LintIssue[];
}

/** 句末切分：中文句读 + 半角问叹号。省略号不切（那是语气延续，不是句断）。 */
const SENT_SPLIT = /[。！？；!?]+/;
/** 破折号：style_dna 明令禁止。 */
const DASH_RE = /——/g;
/**
 * 否定框架：「不是X而是Y」「少X多Y」。
 *
 * 变体为什么要列这么全：实测模型会改头换面用同一个套路——
 * 「这并不是复杂的技巧，而是简单的确认」被抓了，「不需要消除竞争，而是需要确认重要性」却能溜过。
 * 限制跨度（每种句式最多 24 字）是为了避免跨句误伤。
 */
const NEGATION_RE =
  /(?:不是|并非|不需要|不在于)[^。！？；]{1,24}而是|[^，。！？；]{1,12}而非[^。！？；]{1,24}|少[^。！？；]{1,8}多[^。！？；]{1,8}/g;
/**
 * 否定框架的**换皮变体**（2026-10-14 实证）：「这不是他们不乖，这是他们在用本能求救」。
 * 连接词从「而是」换成「这是 / 那是 / 是」，上面的硬规则直接放行。
 *
 * 为什么只做 warn 不做 error：「不是……是……」在中文里也有正当用法（「他不是老师，是医生」），
 * 硬拦会误杀太多次并把 writer 的 repair 循环拖死。这里先提示，让人判断。
 */
const NEGATION_SOFT_RE = /(?:不是|并非|不需要|不在于)[^。！？；]{1,24}[，,]\s*(?:这|那)?是/g;
/**
 * 情绪结算句（对应 AI 检测器判定理由「情感色彩相对较弱」）。
 * 反直觉的是：稿子里从来不缺情绪词，缺的是**被经历**的情绪——这些句子把感受一句话总结掉，
 * 读者拿到的是标签。检测到就把它翻成一个具体动作。
 */
const EMOTION_SETTLE_RE =
  /(那一刻我(突然)?明白|那一刻我懂了|心里那块石头|让我释然|久久不能平静|所有的委屈都值了|我终于知道该怎么做|突然意识到自己一直被爱着)/g;
/** 无出处的权威引用。「查不到就不写」是 2026-10-14 定的硬规则（实证过一次杜撰人名）。 */
  const UNSOURCED_CITATION_RE =
    /(?:研究表明|研究指出|专家发现|专家指出|心理学家[^，。]{0,8}(?:发现|指出|的研究))/g;
/** 口语/停顿标记。人类非虚构写作一定有，AI 中文稿常年低于 6 处。 */
const ORAL_MARK_RE = /(其实|反正|后来|搞不懂|也说不清|就这么着|愣是|偏不|不知怎么着|不对|话说回来)/g;
/**
 * 段落开头的概括句特征。只做**提示级**判定——中文里判断「这是不是一句总结」没有可靠办法，
 * 硬拦必然误伤，所以这里只数个数，超过 1 处才提示。
 */
const SUMMARY_OPENER_RE =
  /^(说到底|归根到底|归根结底|总结(一下|起来|来说)?|总之|一句话(讲|说)(完|清)|说白了|本质上|其实说到底|我卡住的地方|核心(就|是))/;

/** 报告里最多带几条命中片段。 */
const MAX_HITS = 3;

function plainText(text: string): string {
  return text.replace(ALL_MARK_RE, '').trim();
}

function sentenceCount(text: string): number {
  return plainText(text)
    .split(SENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * 抓出命中处的上下文片段，便于定向修补。
 * 只取前 MAX_HITS 条：修不好时用这些证据够定位了，拉一长串反而把修补 prompt 撑爆。
 */
function hitSnippets(text: string, re: RegExp, max = MAX_HITS): string[] {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while (out.length < max && (m = scan.exec(text)) !== null) {
    if (m[0].length === 0) break;
    const from = Math.max(0, m.index - 24);
    const to = Math.min(text.length, m.index + m[0].length + 24);
    out.push(text.slice(from, to).trim());
  }
  return out;
}

function ratio(n: number, d: number): number {
  return d <= 0 ? 0 : n / d;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * 对一篇语义化 HTML 做体检。
 * 传入已解析结果可避免重复解析（改稿页已经 parse 过一次）。
 */
export function lintArticle(html: string, parsed?: ParsedArticle): LintReport {
  const p = parsed ?? parseArticle(html);
  const issues: LintIssue[] = [];

  // ── 段落形态 ──
  let longPara = 0;
  let shortPara = 0;
  let summaryOpeners = 0;
  let overlongPara = 0;
  for (const b of p.blocks) {
    if (b.tag !== 'p') continue;
    const text = plainText(b.text);
    const n = sentenceCount(b.text);
    if (n >= PARA_LONG_MIN_SENT) longPara += 1;
    if (n <= 1) shortPara += 1;
    // 防止「长段落」矫枉过正变成一堵墙：150 字就已经是手机上的满屏了。
    if (text.length > MAX_PARA_CHARS) overlongPara += 1;
    if (SUMMARY_OPENER_RE.test(text)) summaryOpeners += 1;
  }
  const longRatio = ratio(longPara, p.pCount);
  const shortRatio = ratio(shortPara, p.pCount);

  // ── 节数 ──
  if (p.h2Count < MIN_SECTIONS || p.h2Count > MAX_SECTIONS) {
    issues.push({
      level: 'error',
      code: 'sections',
      message: `小标题 ${p.h2Count} 个，需在 ${MIN_SECTIONS}-${MAX_SECTIONS} 个之间`,
    });
  }

  // ── 字数 ──
  if (p.charCount < MIN_CHARS || p.charCount > MAX_CHARS) {
    issues.push({
      level: 'error',
      code: 'chars',
      message: `正文 ${p.charCount} 字，需在 ${MIN_CHARS}-${MAX_CHARS} 字之间`,
    });
  }

  // ── 破折号 / 否定框架（全文扫描，标题与正文都算）──
  const flat = p.blocks.map((b) => plainText(b.text)).join('\n');
  const dashHit = flat.match(DASH_RE)?.length ?? 0;
  if (dashHit > 0) {
    issues.push({
      level: 'error',
      code: 'dash',
      message: `出现 ${dashHit} 处破折号（——），需改写`,
      hits: hitSnippets(flat, DASH_RE),
    });
  }
  const negHit = flat.match(NEGATION_RE)?.length ?? 0;
  if (negHit > 0) {
    issues.push({
      level: 'error',
      code: 'negation',
      message: `出现 ${negHit} 处「不是X而是Y / 少X多Y」否定框架，需改写`,
      hits: hitSnippets(flat, NEGATION_RE),
    });
  }

  const negSoftHit = flat.match(NEGATION_SOFT_RE)?.length ?? 0;
  if (negSoftHit > 0) {
    issues.push({
      level: 'warn',
      code: 'ai_taste',
      message:
        `有 ${negSoftHit} 处否定框架的换皮写法（「不是X，这是Y」），语法上不是错，但仍是作者替读者下判断` +
        '：改成具体的动作或画面',
      hits: hitSnippets(flat, NEGATION_SOFT_RE),
    });
  }

  // ── 去 AI 味（提示级）──
  // 为什么是 warn：这些没有客观红线（同一句话不同人读感受不同），硬拦会大量误杀；
  // 它的作用是**把最像机器的几篇挑出来先改**，不是"不合格就废稿"。
  // 2026-10-14 由朱雀检测的判定理由（语言模式化 / 结构高度规整 / 情感色彩较弱）反推而来。
  const aiTaste: string[] = [];
  const settleHit = flat.match(EMOTION_SETTLE_RE)?.length ?? 0;
  if (settleHit > 0) {
    aiTaste.push(
      `${settleHit} 处情绪结算句（那一刻我明白了 / 心里那块石头…）。这是「情感色彩较弱」的主因：` +
        '情绪被报告了没被经历，改写成当时身体在做什么',
    );
  }
  const oralHit = flat.match(ORAL_MARK_RE)?.length ?? 0;
  if (oralHit < 6) {
    aiTaste.push(`口语毛边只有 ${oralHit} 处，建议 ≥6 处（其实/反正/后来/搞不懂…）。真人叙述一定带着这些`);
  }
  const ellipsisHit = (flat.match(/…/g) ?? []).length;
  if (ellipsisHit < 2) {
    aiTaste.push(`省略号只有 ${ellipsisHit} 处，建议 ≥2 处（写犹豫、拖音、话没说完）`);
  }
  const tinySent = p.blocks
    .filter((b) => b.tag === 'p')
    .flatMap((b) => plainText(b.text).split(SENT_SPLIT).map((s) => s.trim()))
    .filter((s) => s.length > 0 && s.length <= 5).length;
  if (tinySent < 3) {
    aiTaste.push(`≤5 字的短句只有 ${tinySent} 处，建议 ≥3 处。缺少碎句，句长起伏不够（burstiness 低）`);
  }
  if (aiTaste.length > 0) {
    issues.push({
      level: 'warn',
      code: 'ai_taste',
      message: `AI 味：${aiTaste.join('；')}`,
    });
  }

  const citationHit = flat.match(UNSOURCED_CITATION_RE)?.length ?? 0;
  if (citationHit > 0) {
    issues.push({
      level: 'warn',
      code: 'citation',
      message:
        `有 ${citationHit} 处无出处的权威引用（研究表明 / 专家发现 / 心理学家XX指出）。` +
        '必须带可检索出处（作者 + 书名或期刊 + 年份），查不到就不署名',
      hits: hitSnippets(flat, UNSOURCED_CITATION_RE),
    });
  }

  // ── 结尾钩子（提示级）──
  // 公众号的留言几乎全靠结尾那一个提问。2026-10-15 实证：规则里只写「回扣开头 + 互动提问」时，
  // 模型会把提问整个省掉，收在一句抒情比喻上；而 style_dna 里「三件套最多执行两项」
  // 又给了它省掉的正当理由。这里是体检侧的最后一道提醒，让人在改稿页一眼看见。
  const tailText = p.blocks
    .filter((b) => b.tag === 'p')
    .slice(-2)
    .map((b) => plainText(b.text))
    .join('');
  if (tailText.length > 0 && !/[？?]/.test(tailText)) {
    issues.push({
      level: 'warn',
      code: 'ending_hook',
      message:
        '结尾没有互动提问：最后一节要用第二人称「你」问一个具体到物件的问题' +
        '（例：你现在家里的旧语法还剩几件没收回来的？雨靴里的那颗玻璃珠，你替他收了吗？）',
    });
  } else if (tailText.length > 0 && !/你/.test(tailText)) {
    issues.push({
      level: 'warn',
      code: 'ending_hook',
      message: '结尾的提问没有第二人称「你」：把正文里的一个具体物件拎回来问读者，不要泛泛而问',
    });
  }

  // ── 段落形态（提示级，不硬拦）──
  if (p.pCount > 0 && longRatio < MIN_LONG_PARA_RATIO) {    issues.push({
      level: 'warn',
      code: 'para_shape',
      message:
        `复合长段落（≥${PARA_LONG_MIN_SENT} 句）只有 ${longPara}/${p.pCount} 段（${pct(longRatio)}），` +
        `建议提到 ${pct(MIN_LONG_PARA_RATIO)} 以上：把动作、对话、心理揉进同一段`,
    });
  }
  if (overlongPara > 0) {
    issues.push({
      level: 'warn',
      code: 'para_overlong',
      message:
        `有 ${overlongPara}/${p.pCount} 段超过 ${MAX_PARA_CHARS} 字，手机上是一整屏的墙；` +
        '这种段落该按内容层次切成 2-3 段（例如：动作一处、心里想的一处、说出口的一处）',
    });
  }
  if (p.pCount > 0 && shortRatio > MAX_SHORT_PARA_RATIO) {
    issues.push({
      level: 'warn',
      code: 'para_short',
      message:
        `一句一段的段落有 ${shortPara}/${p.pCount} 段（${pct(shortRatio)}），超过 ${pct(MAX_SHORT_PARA_RATIO)}：` +
        '短段落应只留给对话、转折与留白',
    });
  }
  if (summaryOpeners > 1) {
    issues.push({
      level: 'warn',
      code: 'summary_openers',
      message: `有 ${summaryOpeners} 个段落以「说到底 / 总之 / 本质上」这类概括句开头，建议删到最多 1 处（且只在结尾）`,
    });
  }

  // ── 强调密度（提示级：emphasis.ts 可以自动补，不必拦推送）──
  if (p.boldCount < MIN_EMPHASIS || p.boldCount > MAX_EMPHASIS) {
    issues.push({
      level: 'warn',
      code: 'emphasis',
      message: `加粗 ${p.boldCount} 处，建议 ${MIN_EMPHASIS}-${MAX_EMPHASIS} 处（可用「强调补全」一键补）`,
    });
  }
  const keyCount = (html.match(/class="key"/g) ?? []).length;
  if (keyCount < MIN_KEY_EMPHASIS || keyCount > MAX_KEY_EMPHASIS) {
    issues.push({
      level: 'warn',
      code: 'key_emphasis',
      message: `红字金句 ${keyCount} 处，建议 ${MIN_KEY_EMPHASIS}-${MAX_KEY_EMPHASIS} 处`,
    });
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');

  return {
    ok: errors.length === 0,
    stats: {
      h2Count: p.h2Count,
      pCount: p.pCount,
      charCount: p.charCount,
      boldCount: p.boldCount,
      keyCount,
      longPara,
      shortPara,
      longRatio,
      shortRatio,
    },
    issues,
    errors,
    warnings,
  };
}

/** 一句话摘要，供列表/日志使用。 */
export function lintSummary(r: LintReport): string {
  if (r.ok && r.warnings.length === 0) return '体检通过';
  const parts: string[] = [];
  if (r.errors.length > 0) parts.push(`${r.errors.length} 项不合规`);
  if (r.warnings.length > 0) parts.push(`${r.warnings.length} 项待改进`);
  return parts.join('，');
}
