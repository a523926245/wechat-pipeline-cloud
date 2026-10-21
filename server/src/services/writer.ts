/**
 * 写作服务：把选题角度写成一篇公众号草稿 HTML。
 *
 * 策略（与本机流水线一致）：
 * - 优先用「写作」角色绑定的 LLM 真实生成；
 * - 没绑模型 / 没 Key / 调用失败时，回退到**骨架草稿**，保证流水线不断、且明确标注待人工补全。
 *
 * 输出 HTML 遵循本系统的语义化约定（<h1> 标题 / <h2> 小标题 / <p> 正文 /
 * <strong> 普通加粗 / <strong class="key"> 品牌红），交给 parse → render 后续处理。
 *
 * ── 文风规则的两个真源（改文风前先读这里）────────────────────────
 * 1. `config/style_dna.json`：赛道调性、结构主线、段落形态、细腻度、强调标注。
 *    本文件**从 JSON 读取后注入 prompt**，不在这里硬编码文风文案——改 JSON 即改文风。
 * 2. 本文件顶部的 `SYSTEM_PROMPT`：只放「结构 + 硬性禁令」这类程序也要校验的骨架规则，
 *    与 `services/lint.ts` 的推送门禁共用 `constants.ts` 的同一套阈值。
 *
 * ⚠️ 历史坑：`StyleTrack` 曾按英文键（tone/targetReader/...）取值，而 JSON 用的是中文键
 * （调性/目标读者/...），结果赛道调性一行都没进 prompt。现在统一走 `pick()` 兼容两种键名，
 * 新增赛道时中文键与英文键都能被读到。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { Account, Angle, LlmModel, Track } from '@prisma/client';

import { CONFIG_DIR } from '../config.ts';
import { MAX_CHARS, MAX_SECTIONS, MIN_CHARS, MIN_SECTIONS, PARA_TARGET_MAX, PARA_TARGET_MIN, TARGET_CHARS_MAX, TARGET_CHARS_MIN } from '../constants.ts';
import { logger } from '../logger.ts';
import { processEmphasis } from './emphasis.ts';
import { ensureEllipsis } from './ellipsis.ts';
import { reflowParagraphs } from './paragraph-reflow.ts';
import { sanitizeModelHtml, looksLikeArticleHtml } from './html-sanitize.ts';
import { assertRoleUsable, chatComplete } from './llm.ts';
import { lintArticle, type LintIssue, type LintReport } from './lint.ts';
import { parseArticle, type ParsedArticle } from './parse/index.ts';

export interface WriteResult {
  contentHtml: string;
  modelUsed: string | null;
  note: string;
}

/**
 * 一次生成的输出预算。
 *
 * 别觉得 4096 太大：中文约 1.3 token/字，按新文风算——
 * 每个小标题下 3-5 个复合长段落、每段 60-140 字，满打满算 4×5×140 = 2800 字 ≈ 3600 token，
 * 再加上模型爱先复述一遍要求，2600 会把正文拦腰截断。
 */
const WRITE_MAX_TOKENS = 4096;

/**
 * 写作提示词。导出是为了便于排障与回归测试：结构不好时要能原样复现当时的 prompt。
 */
export const SYSTEM_PROMPT = [
  '你是公众号内容写手。请严格按以下约束产出一篇可直接渲染的 HTML 文章：',
  '1. 只输出 HTML，不要任何解释或 markdown 代码块包裹。',
  `2. 结构：<h1> 一个标题</h1>，随后恰好 ${MIN_SECTIONS}-${MAX_SECTIONS} 个 <h2> 小标题`,
  '   （带画面感或情绪钩子，不用干巴巴的标签词）。',
  // ⚠️ 段落账的写法改过三次，前两次都是我算错账（见第 7 条上方的记录）。
  // 现在的写法：只给**全文总段数**这一个可数的数，按节数均分，不再列「每节几段」的分档表，
  // 也不再写「另加开头 1 段与结尾 1-2 段」——后者被模型读成「最后一节只写 1-2 段」，
  // 实测 5 篇样本的最后一节全是 3-4 段，比前面每节少 2-3 段。
  `   全文一共 ${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p> 段落，按小节大致均分：` +
    `3 节就每节 5-6 段，4 节就每节 4-5 段。`,
  '   各节允许 1 段上下浮动，但**不要每节都一样多**，也**不要某一节特别短**（最后一节尤其）。',
  '   每个正文段落都必须用 <p>…</p> 包裹，禁止输出没包标签的纯文本段落。',
  '3. 段落形态（最重要，违反即作废）：禁止通篇一句一段的「短平快」。',
  '   - 主体是复合长段落：3-5 句、约 60-140 字（手机屏 3-4 行），',
  '     把动作、语言、心理活动揉进同一个自然段，一段之内至少完成一次推进',
  '     （发生了什么 → 我怎么想 → 我说了或做了什么）。',
  '     单段 150 字封顶（约移动端满屏），超过就按层次切开——一整屏的墙比一句一段还难读。',
  '   - 短段落（1-2 句）只用于对话、转折、留白与撞击句，全篇占比不超过一半。',
  '   - 每个 <h2> 下至少有一个复合长段落。',
  '4. 禁止「总分总」概括句：每个小标题下不要先写一句总结性判断',
  '   （例如「我卡住的地方是个分类问题」「说到底就是三个字」「本质上我们要做的是」），',
  '   直接写动作、场景与对话，让道理从细节里自己长出来。',
  '   全篇最多 1 处总结性点题，且只能放在结尾。',
  '5. 强调：方法动作/判断标准/反面话术用 <strong>；每篇严格 2-3 处核心金句用 <strong class="key">。',
  '6. 禁用句式（违反即作废，推送门禁会拦下）：',
  '   - 禁止破折号（——）。',
  '   - 禁止一切否定框架：「不是X，而是Y」「并非X，而是Y」「不需要X，而是Y」',
  '     「X，而非Y」「少一点X，多一点Y」「与其X，不如Y」。',
  '     想表达取舍或对照时，**写一个具体的动作或画面**让对比自己浮出来——',
  '     不写「重要的不是他哭不哭」，写「我把手抽出来，站在走廊里数到十」。',
  '   - 禁止杜撰伪案例（如「我认识一位妈妈…」）。',
  // ⚠️ 这条改过两次，两次都是因为**我自己**在提示词里算错了账，别再犯第三次。
  //
  // ── 第一次（2026-10-14）─────────────────────────────────────────
  // 旧版在这里写「每节 4 段 × 每段 100-120 字」，但第 2 条只让每节写 3-5 段、第 3 条又压 150 字上限：
  // 3×4×150 顶格也只有 1800 的九成，模型只能二选一。它保字数（error 会拦）牺牲段长（warn 不拦），
  // 于是每篇都成了「10 段 × 190 字」的一整屏墙。实测两份风格完全不同的 style_dna 都犯同一个病，
  // 因为病灶在这条算式里，不在 JSON。
  //
  // ── 第三次（2026-10-15，本轮）───────────────────────────────────
  // 上两版都还在拿「字数」当要求，而字数恰恰是模型**估不准**的那个量：
  // 它逐 token 生成，对「1800-2200 字」这种全局约束只能先验估，写完也没法回头核。
  // 实测同一提示词出过 971 字也出过 3883 字（σ≈400），段数却稳定在 16-20 —— 差别在可数性。
  // 现在把篇幅**完全翻译成段落数**（唯一模型数得清的指标），字数只作为结果出现。
  // 段均 116 字是实测值（n=8，均值 116.2），17-19 段 × 116 ≈ 1970-2200 字，落在目标区内。
  `7. 篇幅：正文目标 ${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字（门禁 ${MIN_CHARS}-${MAX_CHARS}）。`,
  `   ⚠️ 字数不是写出来的，是**段落数堆出来的**：写满 ${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p> 段落，`,
  // ⚠️ 这里必须**内联真实规范区间**（60-140 字，原文见 style_dna 段落形态规范.长段落），
  // 不能只写「按第 3 条」：交错 A/B 实测（同时间窗、各 n=8）——
  //   只引用第 3 条 → 均值 2312；内联 60-140 → 均值 2089（低 223 字）。
  // 只引用条号时模型对段长没有上界感，段落被写长、总量随之越顶。
  // ⚠️ 别用自制区间（如「90-130」）——那是拿目标字数反推的，不是规范。
  '   每段写成 3-5 句、60-140 字的复合长段落，篇幅自然落在目标区间。不要靠拉长单段凑字数。',
  `   ⚠️ 交稿前自己数一遍 <p> 标签的个数：不足 ${PARA_TARGET_MIN} 个就继续补一个完整的具体场景`,
  '   （一个时刻 + 感官细节 + 一句对话），直到数够；超过上限就合并相邻的短段。',
  // ⚠️ 2026-10-15 补：旧版只写「结尾回扣开头并给一个互动提问」，太软——
  // 实测成稿结尾收在一句抒情的比喻上（「它吃完还会抬头望一望窗户，像在看谁」），
  // 提问整个没了。公众号的留言就靠这一句，必须写成硬性要求并给出可模仿的例子。
  '8. 风格：温暖真诚、朋友聊天感、有具体场景与细节。',
  '9. 结尾钩子（硬性，缺了等于没写结尾）：最后一节必须做这两件事——',
  '   （1）把正文里出现过的**一个具体物件或细节**拎回来（那颗玻璃珠 / 那扇反锁的门 / 那句没说完的话）；',
  '   （2）用第二人称「你」把它变成一个**问读者的具体问题**，让人一句话就能回答。',
  '   示范：「你现在家里的旧语法还剩几件没收回来的？雨靴里的那颗玻璃珠，你替他收了吗？」',
  '   ⚠️ 禁止泛泛而问（「你家孩子也这样吗」「你有什么看法」），禁止号召式（「欢迎留言分享」）。',
  // 金句是提味的，不是主菜：连着两句升华正是「情感色彩」那条判定的反面教材。
  '10. 金句克制：全篇红字金句 2-3 处（见第 5 条），结尾最多 1 句。',
  '    不要连着两三句都在升华——金句一多就成鸡汤，读起来反而没有人味。',
  // 以下三条对应 AI 检测器 2026-10-14 给出的判定理由。放在 SYSTEM_PROMPT 而不仅 JSON，
  // 是因为 JSON 有 MAX_BRIEF_CHARS 预算限制，可能被截掉；而这几条是写完之后无法事后补救的。
  '11. 去 AI 味（检测器判定「语言模式化 / 结构高度规整 / 情感色彩较弱」，逐条反制）：',
  '   - 句长必须有起伏：每写 3-4 个长句（25 字以上）要接一个 12 字以内的短句；',
  '     全文至少 3 个 5 字以内、带句号的极端短句（「我不知道。」「后来没有。」）。',
  // ⚠️ 这里与第 2 条的段落锚有耦合：「拉开差距」只能靠 ±1 段浮动实现，
  // 不能靠砍掉一整节。旧版写的「最长的比最短的多 40%」单独看没问题，
  // 但配上 style_dna 里「允许某一节只写 250 字就收住」就会被执行成「砍出一节 2 段」，
  // 总段数随之掉出锚区、字数撞 1300 门禁。现在两条一起收紧。
  '   - 结构不许齐步走：各节段数允许差 1-2 段（如 4/6/7），但**任何一节都不得少于 4 段**，',
  '     更不许把某节砍到 2 段；最多 2 节以「那天 / 清晨 / 深夜」这类时间场景词开头，最多 2 节以格言收尾。',
  '   - 情感要被经历不要被报告：删掉「那一刻我明白了」「心里那块石头终于落地」这类结算句，',
  '     改成当时身体在做什么。并至少留 1 处承认自己做得糟——吼了他 / 骗了他 / 偏心了 / 嫌他烦。',
  '   - 细节必须不可替换：至少 3 个专有细节（具体的绘本名、动画名、地名、物品品牌、',
  '     孩子说错的原话、精确到分钟的时间）。换成别的东西句子照样成立的，是套话，删。',
  '   - 口语毛边：≥6 处（其实 / 反正 / 后来 / 搞不懂 / 不知怎么着），省略号 ≥2 处。',
  '   - 引用必须带可检索出处（作者 + 书名或期刊 + 年份）。',
  '     禁止「美国心理学家XX的研究指出」「专家发现」——查不到出处就不要署名。',
  '   - 省略号 ≥2 处：只用在犹豫、拖音、话没说完的地方（「我不知道……」「他说他不想……」），',
  '     不要为了凑数在句尾乱加。',
  '12. 交稿前自检：全文否定框架 0 处、破折号 0 处；结尾有回扣物件的提问；',
  '    凡是能改成画面的判断句都改掉。',
].join('\n');

/** style_dna.json 的形状。块内部是「条目名 → 说明」的自由字典，键名以中文为准。 */
interface StyleDna {
  default?: Record<string, unknown>;
  结构主线规范?: Record<string, unknown>;
  句式禁忌规范?: Record<string, unknown>;
  去AI味规范?: Record<string, unknown>;
  段落形态规范?: Record<string, unknown>;
  细腻度规范?: Record<string, unknown>;
  强调标注规范?: Record<string, unknown>;
  // 2026-10-14 融合自 parenting-wechat-article 技能
  结构类型库?: Record<string, unknown>;
  标题公式库?: Record<string, unknown>;
  tracks?: Record<string, Record<string, unknown>>;
}

/** 注入 prompt 的规范条目（顺序即优先级）。不含「说明」「自检补充」这类元信息。 */
const MAINLINE_KEYS = ['总公式', '开头', '主线', '证据节制', '方法可带走', '收尾', '节数与篇幅', '减法原则'];
const BANNED_KEYS = ['禁用', '为什么禁', '替代表达', '自检'];
// 去 AI 味：三节分别对应朱雀检测器给出的三条判定理由（语言模式化 / 结构高度规整 / 情感色彩较弱）。
const DEAI_KEYS = ['背景', '一 语言去模式化', '二 结构去规整', '三 情感写实', '引用禁区', '取舍', '自检'];
const PARA_KEYS = ['总原则', '长段落', '短段落', '比例红线', '禁止概括句'];
const EMPHASIS_KEYS = ['密度红线', '两级用法', '该加', '不该加', '执行方式'];
const DETAIL_KEYS = ['开场', '小标题', '段落层次', '过渡', '细节', '第一人称', '结尾'];

/**
 * 2026-10-14 融合自 `parenting-wechat-article` 技能。
 *
 * 与上面几块的关键区别：这两块是**选择型**规则（动笔前先选型），
 * 不是堆叠型禁令 —— 所以刻意不设计数配额，避免把「约束密度」又推上去。
 */
const STRUCT_KEYS = [
  '说明',
  'A 信号警示型',
  'B 实用清单型',
  'C 原则框架型',
  'D 颠覆认知型',
  'E 对比结局型',
  'F 情感深挖型',
  '以点看面',
];
const TITLE_KEYS = ['说明', '公式', '原则'];

/**
 * 注入 prompt 的规范文案总预算。
 *
 * 3400 → 4400 → 6800 的每次上调都有实证：
 * 4400 是为了塞进「去AI味规范」（约 1300 字）。
 * 6800 是 2026-10-14 发现的：4400 下总长已到 4320，只剩 80 字余量，
 *   而「强调标注规范」要占约 1100 字 —— 它被整块截断，模型从来没收到
 *   「全篇 8-12 处加粗」这条指令，实测两版产出加粗恒为 0 处。
 * 那块绕不开：
 * 2026-10-14 实证旧预算下模型产出的稿子在朱雀 AI 检测上是 100% AI 特征，
 * 三条判定理由（语言模式化 / 结构高度规整 / 情感色彩较弱）必须逐条给反制写法，
 * 而「只给禁令不给替代表达 = 没说」这条教训在这里同样成立。
 * 被挤掉优先级最低的总是细腻度，不会伤到主线和句式禁忌。
 */
const MAX_BRIEF_CHARS = 6800;

/**
 * 读取文风 DNA。
 *
 * `STYLE_DNA_FILE` 是「减法实验」（2026-10-14）的 A/B 切换开关：
 * 不设就读 `style_dna.json`，**默认行为与改造前完全一致**；
 * 设为 `style_dna_slim.json` 则读精简版，用来验证「约束密度是不是问题所在」。
 * 值可以是文件名（相对 CONFIG_DIR）或绝对路径。
 */
function loadStyleDna(): StyleDna {
  try {
    const file = process.env.STYLE_DNA_FILE?.trim() || 'style_dna.json';
    const p = isAbsolute(file) ? file : join(CONFIG_DIR, file);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) as StyleDna;
  } catch {
    return {};
  }
}

/** 取第一个非空值（兼容中文键与英文键，也兼容字符串与字符串数组两种写法）。 */
function pick(obj: Record<string, unknown> | undefined, keys: string[]): string {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const s = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).join('；');
      if (s) return s;
    }
  }
  return '';
}

/**
 * 把一个规范块渲染成「- 条目：说明」的若干行；超过预算就停止追加。
 * 条目值支持三种写法：字符串、字符串数组、以及「子条目标题 → 说明」的字典
 * （句式禁忌规范的「替代表达」就是字典，渲染成「条目：写法一；写法二」）。
 */
function blockBrief(block: Record<string, unknown> | undefined, keys: string[], budget: number): string {
  if (!block || budget <= 0) return '';
  const lines: string[] = [];
  for (const k of keys) {
    const v = block[k];
    if (typeof v === 'string' && v.trim()) lines.push(`- ${k}：${v.trim()}`);
    else if (Array.isArray(v)) {
      const s = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).join('；');
      if (s) lines.push(`- ${k}：${s}`);
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => typeof x === 'string' && x.trim())
        .map(([k2, x]) => `${k2}：（${(x as string).trim()}）`);
      if (entries.length > 0) lines.push(`- ${k}：${entries.join('；')}`);
    }
    if (lines.join('\n').length > budget) {
      lines.pop();
      break;
    }
  }
  return lines.join('\n');
}

/**
 * 拼装用户侧 prompt。导出是为了让 `scripts/smoke-lint.ts` 能直接断言「赛道调性真的进来了」——
 * 中文键/英文键不匹配这个坑已经踩过一次，必须有回归测试顶住。
 */
export function buildPrompt(angle: Angle, track: Track): string {
  const dna = loadStyleDna();
  const tconf = dna.tracks?.[track.name] ?? dna.tracks?.[track.slug];

  const lines: string[] = [];
  lines.push(`赛道：${track.name}（slug=${track.slug}）`);

  // 赛道调性：中文键优先，英文键兜底（两种写法都能读到）。
  const trackBits: string[] = [];
  const tone = pick(tconf, ['调性', 'tone']);
  const reader = pick(tconf, ['目标读者', 'targetReader']);
  const styleNote = pick(tconf, ['语气补充', 'styleNote']);
  const structure = pick(tconf, ['结构偏好', 'structure']);
  const golden = pick(tconf, ['金句风格', 'goldenStyle']);
  const forbidden = pick(tconf, ['禁忌', 'forbidden']);
  if (tone) trackBits.push(`调性：${tone}`);
  if (reader) trackBits.push(`目标读者：${reader}`);
  if (styleNote) trackBits.push(`语气补充：${styleNote}`);
  if (structure) trackBits.push(`结构偏好：${structure}`);
  if (golden) trackBits.push(`金句风格：${golden}`);
  if (forbidden) trackBits.push(`禁忌：${forbidden}`);
  if (trackBits.length > 0) {
    lines.push('');
    lines.push('【本赛道文风】');
    lines.push(...trackBits);
  }

  // 选题与结尾指令必须完整保留：截断只能裁「规范区」，不能把最后的写作要求切掉。
  const tail = [
    '',
    `本次选题主题：${angle.theme}`,
    `本次选题角度：${angle.content}`,
    '',
    `请按上述全部规范写一篇公众号文章：只用 ${MIN_SECTIONS}-${MAX_SECTIONS} 个小标题，` +
      '段落长短交替，不写概括句，让道理从场景与对话里自己长出来。',
    // 以下两条写在 tail 里，是因为 tail 永远不会被预算截断：
    // 实测它们放在规范区里被挤掉过，成稿就静默丢掉整条要求。
    //
    // ⚠️ 这两条必须与 SYSTEM_PROMPT 第 7 条**同一个数**（走 constants.ts 的常量），
    // 不要再各写一份字面量——主提示词与 tail 打架时模型只会挑软的那条执行。
    `正文目标 ${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字。达标路径只有一条：` +
      `全文写满 ${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p> 段落（3 节就每节 5-6 段，4 节就每节 4-5 段），` +
      '每段 3-5 句。写完自己数一遍 <p> 标签个数，不足就继续补完整场景，数够再交稿。',
    '结尾必须回扣正文里的一个具体物件，并用第二人称「你」问读者一个具体的问题' +
      '（例：你现在家里的旧语法还剩几件没收回来的？雨靴里的那颗玻璃珠，你替他收了吗？），不要泛问。',
  ].join('\n');

  // 规范块按优先级依次入座，每块的预算是「扣掉已用部分后的剩余量」，
  // 所以 JSON 越写越长时被牺牲的永远是优先级最低的细腻度，而不是最要紧的主线与句式禁忌。
  const used = (): number => lines.join('\n').length;
  const room = (): number => Math.max(0, MAX_BRIEF_CHARS - tail.length - used());

  const blocks: Array<[Record<string, unknown> | undefined, string, string[]]> = [
    [dna.结构主线规范, '结构主线规范（优先级最高）', MAINLINE_KEYS],
    [dna.结构类型库, '结构类型库（动笔前先选型，六型之一）', STRUCT_KEYS],
    [dna.句式禁忌规范, '句式禁忌规范（违反即作废）', BANNED_KEYS],
    [dna.去AI味规范, '去AI味规范（AI 检测器的判定依据，逐条反制）', DEAI_KEYS],
    [dna.段落形态规范, '段落形态规范', PARA_KEYS],
    [dna.细腻度规范, '细腻度规范', DETAIL_KEYS],
    // ⚠️ 2026-10-14 补：这一块此前**从未被注入过**（blocks 数组里漏了），
    // 加上 4400 预算只剩 80 字余量，等于整块被截断 —— 模型从来没收到
    // 「全篇 8-12 处加粗 / 红字 2-3 处」的指令，实测两版产出加粗恒为 0 处。
    [dna.强调标注规范, '强调标注规范', EMPHASIS_KEYS],
    [dna.标题公式库, '标题公式库', TITLE_KEYS],
  ];
  for (const [block, title, keys] of blocks) {
    const brief = blockBrief(block, keys, room());
    if (!brief) continue;
    lines.push('');
    lines.push(`【${title}】`);
    lines.push(brief);
  }

  // 兜底：极端情况下（赛道调性写得极长）仍可能超，优先保住 tail。
  const body = lines.join('\n');
  if (body.length + tail.length <= MAX_BRIEF_CHARS) return body + tail;
  const keep = Math.max(200, MAX_BRIEF_CHARS - tail.length);
  return body.slice(0, keep) + '\n…（规范过长已截断）' + tail;
}

/** 回退骨架：结构完整、内容待补全，保证 parse/render 不报错且便于人工改稿。 */
function scaffoldHtml(angle: Angle, track: Track): string {
  const theme = angle.theme || track.name;
  return [
    `<h1>${theme}：${angle.content}</h1>`,
    '<p>（待补全：开场长段落。一个具体时刻，带光线或声音的感官细节、一个动作、一句对话，不要开场就抛观点）</p>',
    '<h2>（待补全：带画面感或情绪钩子的小标题）</h2>',
    '<p>（待补全：复合长段落 3-5 句。把动作、对话、心理揉在同一段里，一段完成一次推进；不要先写一句概括）</p>',
    '<p>（待补全：可继续推进的复合长段落，或一句撞击式的短段落）</p>',
    '<p>（待补全：短段落，留给对话、转折或留白）</p>',
    '<h2>（待补全：推进主线的第二个小标题）</h2>',
    '<p>（待补全：复合长段落。先写发生了什么，再写我怎么想，最后写我说了或做了什么）</p>',
    '<p>（待补全：证据或数据段落。全篇研究只用 1 个，最多 2 个）</p>',
    '<h2>（待补全：收尾的小标题）</h2>',
    '<p>（待补全：可带走的方法，写成能复述的短句口诀或「别说这句，说那句」的对照）</p>',
    '<p>（待补全：回扣开场那个画面，一句升华 + 一个互动提问）</p>',
  ].join('\n');
}

/**
 * 把体检的 error 翻成一句「改什么」的操作指令。
 *
 * 关键是**带上命中片段**：只说「有 1 处否定框架」模型找不到是哪句，
 * 把原句摘出来，它改得又准又不伤其他地方。
 */
function repairInstruction(code: LintIssue['code'], issue: LintIssue, p: ParsedArticle): string {
  const hits = issue.hits ?? [];
  const quoted = hits.map((h, i) => `    ${i + 1}. 「${h}」`).join('\n');
  switch (code) {
    case 'negation':
      return [
        `- 否定框架 ${quoted ? '命中以下片段' : ''}：必须删掉「不是X，而是Y」的写法。`,
        quoted,
        '  改法：把要表达的那层意思写成具体的动作或画面，让对比自己浮出来，不要替读者下判断。',
      ].join('\n');
    case 'dash':
      return [`- 破折号：以下片段里的「——」全部改成逗号、句号或直接断句。`, quoted].join('\n');
    case 'sections':
      return [
        `- 小标题数量：当前 ${p.h2Count} 个，必须是 ${MIN_SECTIONS}-${MAX_SECTIONS} 个。`,
        p.h2Count > MAX_SECTIONS ? '  做法：合并相邻且主题接近的小节，删掉的小标题下的内容并入邻节。' : '  做法：把现有内容拆成更多小节，每节各有自己的推进。',
      ].join('\n');
    case 'chars':
      return [
        `- 正文字数：当前 ${p.charCount} 字，门禁是 ${MIN_CHARS}-${MAX_CHARS} 字，` +
          `而目标区间是 ${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字。`,
        p.charCount < MIN_CHARS
          ? `  需要增补约 ${TARGET_CHARS_MIN - p.charCount} 字。做法：**新增完整段落**` +
            `（目标全文 ${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>，当前 ${p.pCount} 个），` +
            '每段一个具体场景（一个时刻 + 感官细节 + 一句对话），不要注水、不要重复已有内容，' +
            '也不要把现有段落拉长。'
          : `  需要删掉约 ${p.charCount - MAX_CHARS} 字：砍掉最抒情、最不推进主线的段落，保留所有具体场景与方法。`,
      ].join('\n');
    default:
      return `- ${issue.message}`;
  }
}

const REPAIR_SYSTEM = [
  '你是公众号文章的编辑。给你一篇已写好的草稿 HTML 与自动体检发现的问题清单。',
  '只修改问题涉及的部分，其余内容（句子、对话、场景、顺序）尽量一字不动地保留。',
  '不要重写整篇：这是修补，不是重写。',
  '输出格式：与输入完全相同的 HTML 结构（<h1> / <h2> / <p> / <strong>），不加任何解释、不加 markdown 围栏。',
].join('\n');

/**
 * 「离合格还有多远」的标量：error 数是主项，字数偏离量是次项。
 *
 * 用它是因为只看 error 数量会卡住：2858 字改到 2789 字，error 数没变（仍是「超字数」1 项），
 * 但确实在往合格线靠近——这一轮该算有进步，值得再给一次机会。
 */
function distance(r: LintReport): number {
  const chars = r.stats.charCount;
  const off = chars < MIN_CHARS ? MIN_CHARS - chars : Math.max(0, chars - MAX_CHARS);
  return r.errors.length * 10000 + off;
}

/** 定向修补最多几轮。修不动就停，不重试到底。 */
const MAX_REPAIR_ROUNDS = 2;

/**
 * 一次定向修补。
 *
 * 为什么需要它：一次成稿让模型同时满足「3-4 小节 / 长短段落 / 无否定框架 / 字数区间 / 无破折号」
 * 这些硬约束并不现实——实测首篇样稿命中 6 处否定框架。与其无限重试（烧 token 且不确定），
 * 不如把体检结果转换成精确的修改指令再改一遍，命中率远高于重新生成。
 *
 * 只跑 1 次：修完仍不过就让稿子留在草稿箱由人工处理，并在 note 里说清剩下什么问题。
 */
async function repairOnce(
  model: LlmModel,
  html: string,
  errors: LintIssue[],
  parsed: ParsedArticle,
): Promise<string | null> {
  const todo = errors.map((e) => repairInstruction(e.code, e, parsed)).join('\n');
  // ⚠️ 这里的区间必须与主提示词一致（都是 TARGET_CHARS_*）。
  // 曾写成 MIN_CHARS-MAX_CHARS（1300-2300），于是同一篇稿子被主提示词要 1800-2200、
  // 被修补提示词要 1300-2300 —— 模型自然取下限，修补反而把字数改少了（实测 2111→2065）。
  const prompt = [
    '【待修补的草稿】',
    html,
    '',
    '【必须修掉的问题】',
    todo,
    '',
    `修完后必须同时满足：小标题 ${MIN_SECTIONS}-${MAX_SECTIONS} 个、正文 ${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字、` +
      '无破折号、无「不是X而是Y」这类否定框架。请输出修补后的完整 HTML。',
    // 修补是「只改问题部分」，但字数不足必须靠加段落补，否则它会靠拉长句子硬凑。
    `若字数不足 ${TARGET_CHARS_MIN}，用**新增完整段落**补（目标全文 ${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>），` +
      '不要靠把现有段落写长，也不要重复已有内容。',
  ].join('\n');

  const fixed = sanitizeModelHtml(
    await chatComplete(model, [
      { role: 'system', content: REPAIR_SYSTEM },
      { role: 'user', content: prompt },
    ], { maxTokens: WRITE_MAX_TOKENS }),
  );
  if (!looksLikeArticleHtml(fixed)) return null;
  // 修补是让模型复述整篇，它会顺手改坏红字与段落划分，所以必须重跑一遍后处理链。
  return postProcess(fixed);
}

/**
 * 成稿后处理链：强调 → 段落重排 → 语气标点（省略号）。
 *
 * 顺序不能变：
 * - 强调在前，因为重排要按「<strong> 是原子单元」来切句；
 * - 省略号在最后，因为它把句末的「。」换成「……」，先改会吞掉重排的一个句边界，
 *   两句会并成一句、段落随之变长。
 *
 * ⚠️ 2026-10-15 修过的坑：`repairOnce` 的产出原先直接返回，跳过了整条链。
 * 定向修补是让模型复述整篇，它会顺手把红字（实测 2 处掉回 1 处）和段落划分改坏，
 * 而修补后的稿子才是真正落库的那一份。现在新稿与修补稿都走这里。
 */
function postProcess(html: string): string {
  const em = processEmphasis(sanitizeModelHtml(html));
  if (em.changed) {
    logger.info(
      { origin: em.stats.originBold, added: em.stats.addedBold, final: em.stats.finalBold },
      '强调补齐',
    );
  }
  const rf = reflowParagraphs(em.contentHtml);
  if (rf.changed) {
    logger.info({ before: rf.before, after: rf.after }, '段落重排');
  }
  const el = ensureEllipsis(rf.contentHtml);
  if (el.changed) {
    logger.info({ origin: el.origin, added: el.added }, '省略号补齐');
  }
  return el.contentHtml;
}

/**
 * 生成一篇草稿。返回 HTML；modelUsed 为实际使用的模型名（回退时为 null）。
 */
export async function generateDraft(angle: Angle, track: Track, _account: Account | null): Promise<WriteResult> {
  // 统一走 assertRoleUsable：未绑定 / 停用 / 能力不符 / 缺 Key 都会给出可读原因，
  // 这里仍然回退骨架草稿，保证流水线不断，但 note 能说清到底是哪一种问题。
  let model: LlmModel;
  try {
    model = await assertRoleUsable('write');
  } catch (e) {
    return {
      contentHtml: scaffoldHtml(angle, track),
      modelUsed: null,
      note: `${e instanceof Error ? e.message : String(e)}，已生成骨架草稿，请在在线改稿中补全内容`,
    };
  }

  try {
    const html = await chatComplete(model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(angle, track) },
    ], { maxTokens: WRITE_MAX_TOKENS });

    // 强调、段长、省略号一律不靠模型（提示词里写了也没用，实测三项都做不到位），
    // 全交给 postProcess 确定性补齐。放在体检之前，所以 repair 循环也是在规整后的结构上跑。
    const cleaned = postProcess(html);
    if (!looksLikeArticleHtml(cleaned)) {
      // 带上原始输出片段：后台只看到「返回内容不可用」是没法排障的，
      // 到底是模型拒答、输出了 markdown，还是 max_tokens 截断，看一眼开头就知道。
      const snippet = html.trim().slice(0, 120).replace(/\s+/g, ' ') || '（空）';
      logger.warn({ model: model.name, snippet, rawLen: html.length }, '模型产出不合结构，回退骨架');
      return {
        contentHtml: scaffoldHtml(angle, track),
        modelUsed: null,
        note: `模型「${model.name}」返回内容不可用（开头：${snippet}），已回退骨架草稿`,
      };
    }

    // 一次成稿很难同时满足全部硬约束，这里跑体检并按需定向修补。
    const first = lintArticle(cleaned);
    if (first.ok) {
      return { contentHtml: cleaned, modelUsed: model.name, note: `已由模型「${model.name}」生成` };
    }

    // 模型的篇幅方差极大（实测同一提示词出过 911 字也出过 2858 字），所以给到 2 轮：
    // 一轮常常差一口气，但**没有进步就立刻停**，不再往下烧 token——
    // 修不动的稿子留在草稿箱让人工处理，比无限重试更划算。
    let bestHtml = cleaned;
    let bestReport = first;
    let rounds = 0;
    while (rounds < MAX_REPAIR_ROUNDS) {
      rounds += 1;
      let improved = false;
      try {
        const fixed = await repairOnce(model, bestHtml, bestReport.errors, parseArticle(bestHtml));
        if (fixed) {
          const r = lintArticle(fixed);
          improved = distance(r) < distance(bestReport);
          logger.info(
            {
              model: model.name,
              round: rounds,
              fromErrors: bestReport.errors.length,
              toErrors: r.errors.length,
              fromChars: bestReport.stats.charCount,
              toChars: r.stats.charCount,
              improved,
            },
            '定向修补完成',
          );
          if (improved) {
            bestHtml = fixed;
            bestReport = r;
          }
        } else {
          logger.warn({ model: model.name, round: rounds }, '定向修补产出不合结构');
        }
      } catch (e) {
        // 修补失败不能连累已经写好的正文，记一笔继续用现有最好的版本。
        logger.warn({ model: model.name, round: rounds, err: String(e) }, '定向修补失败');
      }
      if (!improved) break;
    }

    if (bestReport.ok) {
      return {
        contentHtml: bestHtml,
        modelUsed: model.name,
        note:
          `已由模型「${model.name}」生成，并按成稿体检自动修补 ${rounds} 次后通过` +
          `（${first.stats.charCount} 字 → ${bestReport.stats.charCount} 字）`,
      };
    }
    if (bestHtml !== cleaned) {
      return {
        contentHtml: bestHtml,
        modelUsed: model.name,
        note:
          `已由模型「${model.name}」生成，自动修补 ${rounds} 次后仍有 ` +
          `${bestReport.errors.map((e) => e.message).join('；')}，请在改稿页处理后再推送`,
      };
    }

    return {
      contentHtml: cleaned,
      modelUsed: model.name,
      note:
        `已由模型「${model.name}」生成，但成稿体检未通过（${first.errors.map((e) => e.message).join('；')}），` +
        '请在改稿页处理后再推送',
    };
  } catch (e) {
    return {
      contentHtml: scaffoldHtml(angle, track),
      modelUsed: null,
      note: `模型「${model.name}」调用失败（${e instanceof Error ? e.message : String(e)}），已回退骨架草稿`,
    };
  }
}
