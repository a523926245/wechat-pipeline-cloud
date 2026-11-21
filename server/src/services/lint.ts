/**
 * 成稿体检（推送门禁）。
 *
 * 设计取舍：
 * - **分级**。`error` 拦推送，`warn` 只提示。段落形态这种「靠模型自觉」的指标若也硬拦，
 *   会把大量只差一点的稿子卡死在草稿箱；字数/节数/破折号这类客观指标则必须硬拦。
 * - **阈值单一真源**。数值全部来自 `constants.ts`，这里不做第二份硬编码。
 * - **只管文章产线**。漫画正文是图片序列 + 台词，结构规则完全不同，直接跳过。
 *
 * ⚠️ 2026-11-11：AI 味相关检查（`ai_taste`：句长 CV / 短句率 / 等长窗口 / 段长 CV /
 * 各节段数齐步走 / 格言收尾 / 情绪结算句 / 口语毛边 / 省略号）**整体移除**。
 * 去 AI 味是独立能力，接口预留在 `services/ai-taste/index.ts`。
 * 移除原因是它混在写稿链路里让调试信号变浑：改一句提示词，说不清是写作变好了
 * 还是机器感变少了。**段落形态、结尾钩子、引用出处、贩卖焦虑、强调密度这些
 * 「写作要求」不属于去 AI 味，全部保留。**
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
  ZODIAC_MAX_DUPLICATE_PAIRS,
  ZODIAC_MIN_DISTINCT_TERMS,
  ZODIAC_SIGNS,
  ZODIAC_TERMS,
  ZODIAC_TEXTBOOK_PATTERNS,
} from '../constants.ts';
import { ALL_MARK_RE, parseArticle, type ParsedArticle } from './parse/index.ts';
import { ruleFor } from './track-rules.ts';

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
    | 'citation'
    | 'fear_selling'
    | 'zodiac_topic'
    | 'zodiac_textbook'
    | 'zodiac_repeat'
    | 'zodiac_dup';
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
/** 破折号：全学科一律禁止（提示词与门禁同源，见 writer.ts 的 SYSTEM_PROMPT 第 6 条）。 */
const DASH_RE = /——/g;
/**
 * 否定框架：「不是X而是Y」「少X多Y」「与其X不如Y」。
 *
 * 变体为什么要列这么全：实测模型会改头换面用同一个套路——
 * 「这并不是复杂的技巧，而是简单的确认」被抓了，「不需要消除竞争，而是需要确认重要性」却能溜过。
 * 限制跨度（每种句式最多 24 字）是为了避免跨句误伤。
 *
 * ⚠️ 2026-11-11 补「与其X不如Y」：style_dna 的句式禁忌规范早就禁了它，
 * 但这里一直没纳入正则——实测生成稿里出现了「与其猜他在忙什么，不如把解释权还给他」，
 * 提示词禁了、体检却抓不到，等于那半个禁令是空的。
 */
const NEGATION_RE =
  /(?:不是|并非|不需要|不在于)[^。！？；]{1,24}而是|[^，。！？；]{1,12}而非[^。！？；]{1,24}|少[^。！？；]{1,8}多[^。！？；]{1,8}|与其[^。！？；]{1,16}不如[^。！？；]{1,16}/g;
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
 * 恐吓 / 焦虑贩卖句式（提示级）。
 * 2026-11-11 正能量总纲确立后加：这类句子是「制造焦虑」的显性特征，
 * 落点必须指向方法/希望/成长。命中片段会带给改稿页与定向修补。
 */
const FEAR_SELLING_RE =
  /再?不[^。！？]{0,15}(?:就毁了|就完了|就被淘汰|就晚了|来不及了|就全完了)|(?:毁了|毁掉)(?:孩子|一生|他的一生)|输在起跑线|再不努力就[^。！？]{0,8}(?:淘汰|出局)|你已被?时代抛弃|代价你承受不起/g;
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

/** 变异系数（标准差÷均值）。AI 检测器判「机器感」最吃的统计量之一。 */
function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return 0;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v) / m;
}

/** 切出全文所有句子（按段落顺序），返回每句的纯文本。 */
function splitSentences(text: string): string[] {
  return text
    .split(SENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 赛道专属体检：像不像这条赛道的内容。
 *
 * 为什么通用规则管不了这事：通用规范管的是「怎么写」（段落形态、句长、强调），
 * 管不了「写的是什么」。实测两篇星座成稿通用体检全过，但通篇讲的是老板与 PPT、
 * 伴侣沟通，星座只出现在标题里——这就是「不像星座类文章」的机器可判据。
 *
 * 全部只提示不拦：赛道内容特征没有客观红线，硬拦会误杀正常的稿子。
 *
 * @param checks 启用的检查项（来自 `r:{赛道}` 配置）。传空数组 = 一项都不跑。
 */
function lintTrackChecks(flat: string, p: ParsedArticle, checks: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const on = (code: string): boolean => checks.includes(code);

  // ① 像不像星座文章：星象/星座词够不够
  if (on('zodiac_topic')) {
    const distinct = ZODIAC_TERMS.filter((t) => flat.includes(t));
    if (distinct.length < ZODIAC_MIN_DISTINCT_TERMS) {
      issues.push({
        level: 'warn',
        code: 'zodiac_topic',
        message:
          `全文只出现 ${distinct.length} 个星象/星座相关词（需 ≥${ZODIAC_MIN_DISTINCT_TERMS}）` +
          `（命中：${distinct.join('、') || '无'}）：这不像一篇星座文章，` +
          '星座只是标题里的标签，正文写成了别的赛道',
      });
    }
  }

  // ② 教科书腔：星座稿最忌讳的「心理学概念 + 学术引用」插入式写法
  if (on('zodiac_textbook')) {
    const textbookHits: string[] = [];
    for (const re of ZODIAC_TEXTBOOK_PATTERNS) {
      for (const h of hitSnippets(flat, re, 2)) {
        if (!textbookHits.includes(h)) textbookHits.push(h);
      }
    }
    if (textbookHits.length > 0) {
      issues.push({
        level: 'warn',
        code: 'zodiac_textbook',
        message:
          `有 ${textbookHits.length} 处教科书腔（心理学概念 / 研究引用 / 期刊名）：` +
          '星座稿里插学术引用会瞬间变回心理科普，改成用生活画面说这件事',
        hits: textbookHits.slice(0, MAX_HITS),
      });
    }
  }

  // ③ 跨星座复读：不同星座的描述不该近乎相同
  if (on('zodiac_repeat')) {
    const dupPairs = findDuplicateSignDescriptions(p);
    if (dupPairs.length > ZODIAC_MAX_DUPLICATE_PAIRS) {
      issues.push({
        level: 'warn',
        code: 'zodiac_repeat',
        message:
          `有 ${dupPairs.length} 对星座的描述高度雷同（${dupPairs.slice(0, 3).join('、')}）：` +
          '每个星座必须写自己的具体行为切片，换个说法也算雷同',
        hits: dupPairs.slice(0, MAX_HITS),
      });
    }
  }

  // ④ 同一个星座被写进多段：群像是一星座一段，写两段就退化成小故事
  //
  // 为什么必须机器查：这条规则写在提示词里（「禁止给同一个星座写两段」），但实测
  // 模型会先老实列完 10 个星座，紧接着又给其中 5 个补了 3-5 段的小故事——
  // 段落数从 13 涨到 18，形态从群像退化成散文，而所有既有检查（星象词够不够、
  // 有没有复读、门禁过不过）全都是绿的。**没被检查的规则，模型就当它不存在。**
  if (on('zodiac_dup')) {
    const dupHits: string[] = [];
    for (const sign of ZODIAC_SIGNS) {
      const n = p.blocks.filter((b) => b.tag === 'p' && plainText(b.text).includes(sign)).length;
      if (n > 1) dupHits.push(`${sign}×${n}`);
    }
    if (dupHits.length > 0) {
      issues.push({
        level: 'warn',
        code: 'zodiac_dup',
        message:
          `有 ${dupHits.length} 个星座被写进了多段（${dupHits.slice(0, 5).join('、')}）：` +
          '群像是一星座一段，给同一个星座补第二个场景就变回小故事了',
        hits: dupHits.slice(0, MAX_HITS),
      });
    }
  }

  return issues;
}

/** 星座专有名词（用于复读检测里定位「这一段在说哪个星座」）。 */
const SIGN_NAMES = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];

/**
 * 找「不同星座说了几乎同样的话」的段落对。
 *
 * 判据：两个段落各以某个星座名开头，且去掉星座名之后的正文，
 * 3 字 gram 重合度 ≥0.6（近似复读的阈值）。
 */
function findDuplicateSignDescriptions(p: ParsedArticle): string[] {
  const paras = p.blocks
    .filter((b) => b.tag === 'p')
    .map((b) => plainText(b.text))
    .filter((t) => t.length >= 30);
  const bySign = new Map<string, string>();
  for (const t of paras) {
    const sign = SIGN_NAMES.find((s) => t.startsWith(s));
    if (sign && !bySign.has(sign)) bySign.set(sign, t);
  }
  const entries = [...bySign.entries()];
  const pairs: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]?.[1] ?? '';
      const b = entries[j]?.[1] ?? '';
      const ga = new Set(a.slice(0, -1).split('').map((c, k, arr) => arr.slice(k, k + 3).join('')));
      const gb = new Set(b.slice(0, -1).split('').map((c, k, arr) => arr.slice(k, k + 3).join('')));
      if (ga.size === 0 || gb.size === 0) continue;
      let inter = 0;
      for (const g of ga) if (gb.has(g)) inter += 1;
      const jaccard = inter / (ga.size + gb.size - inter);
      if (jaccard >= 0.6) pairs.push(`${entries[i]?.[0]}≈${entries[j]?.[0]}`);
    }
  }
  return pairs;
}

/**
 * 对一篇语义化 HTML 做体检。
 * 传入已解析结果可避免重复解析（改稿页已经 parse 过一次）。
 *
 * @param trackName 赛道名：星座赛道会追加星座专属检查项（像不像星座文章、教科书腔、跨星座复读）。
 */
export function lintArticle(
  html: string,
  parsed?: ParsedArticle,
  trackName = '',
  /** 该赛道启用的专项检查（来自 `r:{赛道}` 配置）。缺省取出厂默认。 */
  checks?: string[],
  /**
   * 该赛道豁免的 **warn** 项（来自 `r:{赛道}.relax`）。
   *
   * 为什么需要：段落形态这套判据是给「叙事散文」定的（复合长段落 ≥1/3、一句一段 ≤1/2）。
   * 星座群像是一星座一段、育儿口语体是一句一段——它们不是写坏了，是**形式不同**。
   * 用散文标准去量清单体，每篇都会刷出两条假警报，久了就没人看体检了。
   * 只允许豁免 warn：error 是合规门禁，任何赛道都不能关。
   */
  relax?: string[],
): LintReport {
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

  // ── 星座赛道专属（提示级）──
  // 只有星座赛道才查：通用规则管「怎么写」，这条管「写的是什么」。
  // ── 赛道专属（提示级）──
  // 跑哪些检查由 `r:{赛道}` 决定，代码里不再有赛道名判断。
  // 没配置就是一项都不跑（新赛道默认无专项检查，不继承别的赛道的规则）。
  const activeChecks = checks ?? ruleFor(trackName).checks;
  if (activeChecks.length > 0) {
    issues.push(...lintTrackChecks(flat, p, activeChecks));
  }

  // ── 正能量：恐吓 / 焦虑贩卖（提示级）──
  // 创作总纲要求「不制造焦虑、落点指向方法/希望/成长」。只提示不拦：
  // 有些赛道（教育警示型）确实要写后果，硬拦会误杀，交给人判断改写方式。
  const fearHit = flat.match(FEAR_SELLING_RE)?.length ?? 0;
  if (fearHit > 0) {
    issues.push({
      level: 'warn',
      code: 'fear_selling',
      message:
        `有 ${fearHit} 处恐吓/焦虑贩卖句式（再不…就毁了 / 被淘汰 / 输在起跑线…）。` +
        '改成共鸣 → 希望 → 赋能：先接情绪，再给方法，落点指向出路',
      hits: hitSnippets(flat, FEAR_SELLING_RE),
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

  // 赛道豁免只对 warn 生效：error 是推送门禁，任何赛道都不能关。
  // 放在最后统一过滤，避免每处 push 都写一遍判断（也避免漏掉）。
  // 未显式传入时按赛道取出厂默认——这样 publisher / 文章页这些只加载了 checks 的
  // 调用点也能拿到同一套豁免，不会出现「写稿时不报、推送时又报」的两套标准。
  const relaxed = new Set(relax ?? ruleFor(trackName).relax ?? []);
  const kept = relaxed.size === 0 ? issues : issues.filter((i) => !(i.level === 'warn' && relaxed.has(i.code)));

  const errors = kept.filter((i) => i.level === 'error');
  const warnings = kept.filter((i) => i.level === 'warn');

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
    issues: kept,
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
