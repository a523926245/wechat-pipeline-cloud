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
 * ── 文风规则的真源（改文风前先读这里）────────────────────────
 * 全部在**文风配置页**（`StylePrompt` 表），按赛道各一份：
 *   1. `{赛道}`            赛道文体：身份 / 读者 / 语气 / 赛道语汇 / 禁忌
 *   2. `s:{赛道}`          写作规范：`## 段落形态` / `## 强调标注` / `## 句式补充`
 *   3. `v:{赛道}:{dim}`    三维变体（title / structure / length），按游标轮换
 *   4. `r:{赛道}`          机器规则（体检项 / 选题形态），不直接进 prompt
 * 本文件只负责**拼装顺序与预算**，不硬编码任何赛道名、也不读 `style_dna.json`
 * （那个文件已降级为「新建赛道时的种子」）。
 *
 * 本文件顶部的 `SYSTEM_PROMPT` 只放「结构 + 硬性禁令」这类程序也要校验的骨架规则，
 * 与 `services/lint.ts` 的推送门禁共用 `constants.ts` 的同一套阈值。
 */

import type { OAAccount, Angle, LlmModel, Track } from '@prisma/client';

import {
  MAX_CHARS,
  MAX_SECTIONS,
  MIN_CHARS,
  MIN_SECTIONS,
  PARA_TARGET_MAX,
  PARA_TARGET_MIN,
  TARGET_CHARS_MAX,
  TARGET_CHARS_MIN,
} from '../constants.ts';
import { logger } from '../logger.ts';
import { dumpPrompt } from './prompt-dump.ts';
import { processEmphasis } from './emphasis.ts';
import { reflowParagraphs } from './paragraph-reflow.ts';
import { loadStyleForTrack, pickVariants, parseSystemTemplate, DEFAULT_SYSTEM_PROMPTS, SYS_DEFAULT_TRACK, type PickedVariants, type TrackSpec, type TrackSystemPrompt } from './style-prompts.ts';
import { sanitizeModelHtml, looksLikeArticleHtml } from './html-sanitize.ts';
import { assertRoleUsable, chatComplete } from './llm.ts';
import { lintArticle, type LintIssue, type LintReport } from './lint.ts';
import { AI_TASTE_ENABLED, analyzeAiTaste } from './ai-taste/index.ts';
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

/** 篇幅锚：正文目标字数 + 全文段落数。默认取 constants，变体轮换时被替换。 */
export interface LengthTarget {
  min: number;
  max: number;
  pMin: number;
  pMax: number;
}

/**
 * 把模板里的 `{{变量}}` 换成实际值。
 *
 * 为什么要有模板而不是直接把整段提示词塞进库：节数 / 字数 / 段数是**门禁**，
 * 必须与 `constants.ts` 和篇幅档同源。如果允许在页面上写死「5 小节、2000 字」，
 * 就会出现「提示词要 5 节、体检按 3-4 拦」的自己打自己（历史上踩过）。
 * 所以可编辑的是「怎么写」，数字一律走变量。
 *
 * 未定义的变量**原样保留**（而不是替换成空），这样配置页写错变量名时
 * 能在 prompt 里一眼看见 `{{pmin}}` 这种漏网的，而不是静默变成空白。
 */
export function renderTemplate(tpl: string, vars: Record<string, string | number>): {
  text: string;
  unknown: string[];
} {
  const unknown = new Set<string>();
  const text = tpl.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    unknown.add(name);
    return whole;
  });
  return { text, unknown: [...unknown] };
}

/**
 * 数字锚是否已被模板覆盖。
 *
 * 模板里一个都不写 `{{pMin}}` / `{{targetMin}}` 时，字数与段数就完全传不到模型，
 * 篇幅必然跑偏。这种情况下由代码在末尾补一行硬锚——宁可重复一次，
 * 也不能让「可配置」变成「可配置到门禁失效」。
 */
const ANCHOR_VARS = ['pMin', 'pMax', 'targetMin', 'targetMax'] as const;

function needsAnchor(tpl: string): boolean {
  return !ANCHOR_VARS.some((v) => tpl.includes(`{{${v}}}`));
}

/** 默认模板（新赛道 / 赛道没配 sys 时的兜底）。 */
function defaultTemplate(): { system: string; tail: string } {
  return parseSystemTemplate(DEFAULT_SYSTEM_PROMPTS[SYS_DEFAULT_TRACK] ?? '');
}

/** 模板变量表。数字全部来自 constants + 本次篇幅档，页面改不掉。 */
function anchorVars(T: LengthTarget): Record<string, string | number> {
  return {
    minSections: MIN_SECTIONS,
    maxSections: MAX_SECTIONS,
    targetMin: T.min,
    targetMax: T.max,
    minChars: MIN_CHARS,
    maxChars: MAX_CHARS,
    pMin: T.pMin,
    pMax: T.pMax,
  };
}

/** 模板没写数字时的兜底锚：由程序生成，保证门禁指标一定传达到模型。 */
function anchorLine(T: LengthTarget): string {
  return (
    `篇幅锚（程序校验，必须满足）：全文 ${T.pMin}-${T.pMax} 个 <p> 段落，` +
    `正文目标 ${T.min}-${T.max} 字（门禁 ${MIN_CHARS}-${MAX_CHARS} 字），` +
    `小标题 ${MIN_SECTIONS}-${MAX_SECTIONS} 个。`
  );
}

/**
 * 写作提示词（system 消息）。导出是为了便于排障与回归测试：结构不好时要能原样复现当时的 prompt。
 *
 * 2026-11-12 起**内容不再写在本文件里**：整份 system 提示词按赛道存在
 * `StylePrompt` 表的 `sys:{赛道}`，配置页可改。本文件只做两件事——
 *   1. 把 `{{pMin}}` / `{{targetMax}}` 这类数字变量填进去（数字来自 constants + 篇幅档，页面改不到）；
 *   2. 模板漏写数字时补一行硬锚，防止「可配置」变成「门禁失效」。
 *
 * 为什么必须搬出去：此前六条赛道共用一份写死的 12 条，而那份内容本身就是一个完整文体
 * （复合长段落 + 结尾回扣物件 + 第二人称提问），于是星座稿与育儿稿长成了同一种
 * 「深夜独白体」。换赛道只是换形容词，骨架换不掉——要真的每条赛道像它自己，
 * 提示词必须按赛道分开，而且必须能改。
 *
 * `SYSTEM_PROMPT` 保留为通用模板 + 默认锚的渲染结果，兼容既有测试与排障。
 */
export function buildSystemPrompt(opts: {
  /** 本次抽中的篇幅档；缺省用 constants 的默认锚。 */
  target?: LengthTarget;
  /** `sys:{赛道}` 模板原文（未渲染）；缺省用通用模板。 */
  template?: string;
} = {}): string {
  const T = opts.target ?? {
    min: TARGET_CHARS_MIN,
    max: TARGET_CHARS_MAX,
    pMin: PARA_TARGET_MIN,
    pMax: PARA_TARGET_MAX,
  };
  const tpl = opts.template?.trim() || defaultTemplate().system;
  const { text, unknown } = renderTemplate(tpl, anchorVars(T));
  if (unknown.length > 0) {
    logger.warn({ unknown }, '系统提示词模板里有未定义变量，已原样保留');
  }
  return needsAnchor(tpl) ? `${text}\n${anchorLine(T)}` : text;
}

/** 默认锚版本（TARGET/ PAR A 常量），兼容既有测试与排障引用。 */
export const SYSTEM_PROMPT = buildSystemPrompt();


/**
 * 规范区（不含 tail）的字符预算。
 *
 * 3400 → 4400 → 6800 → 7600 的每次上调都有实证：
 * - 4400 是为塞进去AI味规范（约 1300 字）；
 * - 6800 是 2026-10-14 发现的：4400 下只剩 80 字余量，「强调标注规范」整块被截断，
 *   模型从来没收到「全篇 8-12 处加粗」这条指令，实测产出加粗恒为 0 处；
 * - 7600 是 2026-11-11 实测：6800 下 prompt 已到 6771，强调标注只剩 510 / 原文 900+，
 *   「直接在 HTML 里标 `<strong class="key">`」这条**最可执行**的指令整条丢失。
 *
 * ⚠️ 现在的取舍与过去不同：过去是「超了就切后面几行的尾巴」，产出的是**半截指令**
 * （有标题没内容，或者条件写了一半）——半截指令比没有更糟，模型会当它不存在。
 * 现在改为「整块规则」：单块完整度不足 `MIN_BLOCK_COMPLETENESS` 就整块丢弃并记日志，
 * 让预算问题变成**可见的缺失**，而不是静默的残缺。
 */
const MAX_BRIEF_CHARS = 7600;

/**
 * 单块规范的最低完整度（能放下原文的比例）。低于它就整块不要。
 *
 * 0.6 是经验值：低于六成时通常只剩标题和一两条条目，而那往往正好丢掉「怎么做」的部分
 * （例如强调标注里「直接标 <strong class="key">」排在最后一条）——保留反而误导。
 */
const MIN_BLOCK_COMPLETENESS = 0.6;

/**
 * 往 prompt 里塞一个规范块，带完整性门槛。
 *
 * 为什么不直接截断：半截指令比没有更糟——只剩标题和一两条时模型会当整块不存在，
 * 而缺掉的往往正是「怎么做」那部分（例如强调标注里「直接标 `<strong class="key">`」
 * 排在最后一条，6800 预算下就是它整条丢失）。
 * 宁可整块不要，并在日志里留下痕迹，让「某条规则没生效」变成可查的事。
 *
 * @param room 剩余可用字符数（调用方已扣除 tail）
 */
function pushBlock(lines: string[], title: string, body: string, room: number): void {
  const text = body.trim();
  if (!text) return;
  const need = text.length + title.length + 6;
  if (need <= room) {
    lines.push('', `【${title}】`, text);
    return;
  }
  if (room > 0 && room / need >= MIN_BLOCK_COMPLETENESS) {
    const cut = text.slice(0, Math.max(0, room - title.length - 12)).trimEnd();
    lines.push('', `【${title}】`, `${cut}…`);
    return;
  }
  logger.warn({ title, need, room }, '规范块完整度不足，整块跳过（避免半截指令）');
}


/** buildPrompt 的可选注入：文风配置页的文案、本次抽中的变体、本赛道写作规范、本赛道系统提示词。 */
export interface BuildPromptOpts {
  style?: { globalPrompt?: string; trackPrompt?: string };
  variants?: PickedVariants;
  /** `s:{赛道}` 解析结果（段落形态 / 强调标注 / 句式补充）。 */
  spec?: TrackSpec;
  /** `sys:{赛道}` 解析结果（system / tail 两节模板原文）。缺省用通用模板。 */
  system?: TrackSystemPrompt;
}

/**
 * 拼装用户侧 prompt。导出是为了让 `scripts/smoke-lint.ts` 能直接断言「赛道调性真的进来了」——
 * 中文键/英文键不匹配这个坑已经踩过一次，必须有回归测试顶住。
 */
export function buildPrompt(angle: Angle, track: Track, opts: BuildPromptOpts = {}): string {
  const lines: string[] = [];
  lines.push(`赛道：${track.name}（slug=${track.slug}）`);

  // 创作总纲（文风配置页可改）：正能量 / 素材查证 / 逻辑自洽。
  // 这是**唯一**跨赛道共享的规范；其余全部按赛道读 `s:{赛道}`。
  const globalPrompt = opts.style?.globalPrompt?.trim();
  if (globalPrompt) {
    lines.push('');
    lines.push('【创作总纲（硬性）】');
    lines.push(globalPrompt);
  }

  // 本赛道文体：身份 / 读者 / 语气 / 赛道语汇 / 分组纪律 / 禁忌。
  //
  // ⚠️ 2026-11-11：不再有 style_dna 兜底。没配就是没配——缺了会在产稿和体检里
  // 暴露出来，比悄悄塞一份别的赛道的调性更诚实（旧行为让星座稿继承了育儿调性）。
  const dbTrack = opts.style?.trackPrompt?.trim();
  if (dbTrack) {
    lines.push('');
    lines.push('【本赛道文风（硬性）】');
    lines.push(dbTrack);
  }

  // 选题与结尾指令必须完整保留：截断只能裁「规范区」，不能把最后的写作要求切掉。
  //
  // 篇幅锚与变体：文风配置的篇幅变体优先（反模板化轮换），无变体回落 constants。
  // ⚠️ 这里的数字必须与 buildSystemPrompt、repairOnce **同源**（都取下面的 tMin/tMax/pMin/pMax）。
  const lt = opts.variants?.lengthTarget ?? null;
  const tMin = lt?.min ?? TARGET_CHARS_MIN;
  const tMax = lt?.max ?? TARGET_CHARS_MAX;
  const pMin = lt?.pMin ?? PARA_TARGET_MIN;
  const pMax = lt?.pMax ?? PARA_TARGET_MAX;

  // 本次变体：写在 tail 里保证永不被规范区预算截断。三条都要落进成稿。
  const variantLines: string[] = [];
  const v = opts.variants;
  if (v) {
    variantLines.push(
      '',
      '【本次变体（反模板化硬性要求：与往期错开，禁止写成固定模板）】',
      `- 标题按这条公式起：${v.title}`,
      `- 结构骨架按这条展开（与上文结构规范冲突时以本条为准）：${v.structure}`,
      lt
        ? `- 篇幅档「${lt.note}」：目标 ${tMin}-${tMax} 字、全文 ${pMin}-${pMax} 个 <p> 段落。`
        : `- 篇幅档：${v.length}`,
    );
  }

  // 收尾指令：来自 `sys:{赛道}` 的 `## tail` 节，按赛道各一份、配置页可改。
  //
  // ⚠️ 这里原来写死了三行通用要求（小标题 3-4、每段 3-5 句、结尾回扣物件 + 提问）。
  // 那三行是「星座稿写成育儿稿」的第二现场：赛道 system 提示词再怎么改，
  // user 消息末尾这三行都会把稿子拉回同一种写法。现在整段可配置，
  // 数字仍由 anchorVars 注入，模板漏写时 anchorLine 兜底。
  // 它必须留在 tail（而非规范区）里——tail 永不被预算截断。
  const lengthTarget: LengthTarget = { min: tMin, max: tMax, pMin, pMax };
  const sysTail = opts.system?.tail?.trim() || defaultTemplate().tail;
  const { text: tailBody, unknown } = renderTemplate(sysTail, anchorVars(lengthTarget));
  if (unknown.length > 0) {
    logger.warn({ unknown, track: track.name }, '收尾模板里有未定义变量，已原样保留');
  }
  const tailRendered = needsAnchor(sysTail) ? `${tailBody}\n${anchorLine(lengthTarget)}` : tailBody;

  const tail = [
    '',
    `本次选题主题：${angle.theme}`,
    `本次选题角度：${angle.content}`,
    ...variantLines,
    '',
    tailRendered,
  ].join('\n');

  // ── 本赛道写作规范（s:{赛道}）──────────────────────────────────────
  // 按 `##` 切好的小节逐个注入，顺序固定：段落形态 → 强调标注 → 句式补充。
  //
  // 「去 AI 味（预留）」小节**注入条件**是能力已启用（AI_TASTE_ENABLED），
  // 否则整节跳过——一个空占位进 prompt 只会稀释重点。
  //
  // ⚠️ 「引用必须带可检索出处」不在这里：它在 SYSTEM_PROMPT 第 11 条，
  // system 消息不受预算限制，比在这里再写一遍更可靠。
  const spec = opts.spec;
  if (spec) {
    const room = (): number => Math.max(0, MAX_BRIEF_CHARS - tail.length - lines.join('\n').length);
    for (const name of ['段落形态', '强调标注', '句式补充'] as const) {
      pushBlock(lines, `写作规范 · ${name}`, spec.sections[name] ?? '', room());
    }
    if (spec.loose) pushBlock(lines, '写作规范', spec.loose, room());
    if (AI_TASTE_ENABLED) {
      pushBlock(lines, '写作规范 · 去AI味', spec.sections['去AI味（预留）'] ?? '', room());
    }
  }

  // 兜底：极端情况下（赛道文体写得极长）仍可能超，优先保住 tail。
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
function repairInstruction(code: LintIssue['code'], issue: LintIssue, p: ParsedArticle, target?: LengthTarget): string {  const hits = issue.hits ?? [];
  const quoted = hits.map((h, i) => `    ${i + 1}. 「${h}」`).join('\n');
  const tMin = target?.min ?? TARGET_CHARS_MIN;
  const tMax = target?.max ?? TARGET_CHARS_MAX;
  const pMin = target?.pMin ?? PARA_TARGET_MIN;
  const pMax = target?.pMax ?? PARA_TARGET_MAX;
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
          `而目标区间是 ${tMin}-${tMax} 字。`,
        p.charCount < MIN_CHARS
          ? `  需要增补约 ${tMin - p.charCount} 字。做法：**新增完整段落**` +
            `（目标全文 ${pMin}-${pMax} 个 <p>，当前 ${p.pCount} 个），` +
            '每段一个具体场景（一个时刻 + 感官细节 + 一句对话），不要注水、不要重复已有内容，' +
            '也不要把现有段落拉长。'
          : `  需要删掉约 ${p.charCount - MAX_CHARS} 字：砍掉最抒情、最不推进主线的段落，保留所有具体场景与方法。`,
      ].join('\n');
    default:
      return `- ${issue.message}`;
  }
}

/** 把一组 error 合成一份「要修什么」的清单（空数组 → 空串）。 */
function repairInstructionList(
  errors: LintIssue[],
  p: ParsedArticle,
  target?: LengthTarget,
): string | null {
  if (errors.length === 0) return null;
  return errors.map((e) => repairInstruction(e.code, e, p, target)).join('\n');
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
 *
 * ⚠️ 2026-11-11：AI 味那一轴已整体移除（去 AI 味改成独立能力，接口见
 * `services/ai-taste/index.ts`）。这里回到**单一轴**：只判合规。
 */
function distance(r: LintReport): number {
  const chars = r.stats.charCount;
  const off = chars < MIN_CHARS ? MIN_CHARS - chars : Math.max(0, chars - MAX_CHARS);
  return r.errors.length * 10000 + off;
}

/**
 * 定向修补最多几轮。修不动就停，不重试到底。
 */
const MAX_REPAIR_ROUNDS = 2;

/**
 * 一次定向修补。
 *
 * 为什么需要它：一次成稿让模型同时满足「3-4 小节 / 长短段落 / 无否定框架 / 字数区间 / 无破折号」
 * 这些硬约束并不现实——实测首篇样稿命中 6 处否定框架。与其无限重试（烧 token 且不确定），
 * 不如把体检结果转换成精确的修改指令再改一遍，命中率远高于重新生成。
 *
 * 只修 `error`（合规轴）。AI 味那一轴 2026-11-11 已整体移除——它属于独立能力，
 * 混在这里会让「改这一轮到底修好了什么」说不清。
 */
async function repairOnce(
  model: LlmModel,
  html: string,
  errorTodo: string | null,
  parsed: ParsedArticle,
  target?: LengthTarget,
): Promise<string | null> {
  const tMin = target?.min ?? TARGET_CHARS_MIN;
  const tMax = target?.max ?? TARGET_CHARS_MAX;
  const pMin = target?.pMin ?? PARA_TARGET_MIN;
  const pMax = target?.pMax ?? PARA_TARGET_MAX;
  // ⚠️ 这里的区间必须与主提示词、tail 的篇幅变体一致（都取 target 或同一组常量）。
  // 曾写成 MIN_CHARS-MAX_CHARS（1300-2300），于是同一篇稿子被主提示词要 1800-2200、
  // 被修补提示词要 1300-2300 —— 模型自然取下限，修补反而把字数改少了（实测 2111→2065）。
  const prompt = [
    '【待修补的草稿】',
    html,
    '',
    errorTodo ? '【必须修掉的问题】\n' + errorTodo : '',
    '',
    `修完后必须同时满足：小标题 ${MIN_SECTIONS}-${MAX_SECTIONS} 个、正文 ${tMin}-${tMax} 字、` +
      '无破折号、无「不是X而是Y」这类否定框架。请输出修补后的完整 HTML。',
    // 修补是「只改问题部分」，但字数不足必须靠加段落补，否则它会靠拉长句子硬凑。
    `若字数不足 ${tMin}，用**新增完整段落**补（目标全文 ${pMin}-${pMax} 个 <p>），` +
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
  // ⚠️ 2026-11-11：省略号补齐（`ensureEllipsis`）已从链路摘除——它只为
  // 「省略号 ≥2 处」这条**去 AI 味**条款服务，该条款已整体移除。
  // 文件保留，等去 AI 味能力回归时一起接回来（见 services/ai-taste/index.ts）。
  //
  // 预留接线点：去 AI 味能力就绪后在这里分析并（可选）改写一次。
  // 现在 `AI_TASTE_ENABLED` 恒 false，下面这段是死代码，不影响任何产出。
  return rf.contentHtml;
}

/**
 * 生成一篇草稿。返回 HTML；modelUsed 为实际使用的模型名（回退时为 null）。
 */
export async function generateDraft(angle: Angle, track: Track, _account: OAAccount | null): Promise<WriteResult> {
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
    // 文风配置（创作总纲 + 赛道文体）与三维变体（标题/结构/篇幅轮换）都来自配置页真源。
    // 任一读取失败都有兜底，不让配置问题拖垮写稿。
    const style = await loadStyleForTrack(track.name);
    const variants = await pickVariants(track.name);
    logger.info(
      {
        track: track.name,
        variantCursor: variants.cursor,
        variantTitle: variants.title.slice(0, 40),
        variantStructure: variants.structure.slice(0, 40),
        variantLength: variants.length.slice(0, 40),
        sysPromptSource: style.system.sourceKey,
      },
      '变体轮换',
    );
    const sysMsg = buildSystemPrompt({
      target: variants.lengthTarget ?? undefined,
      template: style.system.system,
    });
    const userMsg = buildPrompt(angle, track, { style, variants, spec: style.spec, system: style.system });
    // 落一份拼好的提示词：七拼八凑的 prompt 只看单项看不出冲突，必须看成品。
    dumpPrompt(track.name, sysMsg, userMsg);
    const html = await chatComplete(
      model,
      [
        { role: 'system', content: sysMsg },
        { role: 'user', content: userMsg },
      ],
      { maxTokens: WRITE_MAX_TOKENS },
    );
    // 强调、段长一律不靠模型（提示词里写了也没用，实测都做不到位），
    // 全交给 postProcess 确定性补齐。放在体检之前，所以 repair 循环也是在规整后的结构上跑。
    const cleaned = postProcess(html);

    // 预留接线点（去 AI 味）：能力就绪后在这里分析并（可选）改写一次。
    // `AI_TASTE_ENABLED` 恒 false，所以这段现在不会执行，也不影响任何产出。
    if (AI_TASTE_ENABLED) {
      const report = await analyzeAiTaste({ html: cleaned, track: track.name });
      logger.info(
        { track: track.name, score: report?.score, issues: report?.issues.length ?? 0 },
        '去 AI 味分析（预留）',
      );
    }
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
    const first = lintArticle(cleaned, undefined, track.name, style.rule.checks, style.rule.relax);

    let bestHtml = cleaned;
    let bestReport = first;
    let rounds = 0;

    // ── 修补循环：只修「硬错误」──
    //
    // ⚠️ 2026-11-11：AI 味那一轴整体移除（去 AI 味改成独立能力，接口见
    // `services/ai-taste/index.ts`）。回到单轴后判据简单了：
    // 只比 `distance()`（error 数 + 字数偏离量），变差就停，不重试到底。
    //
    // 为什么保留循环而不是一次修补：模型方差大，一次改不干净的常见情况是
    // 「字数差一点」——distance 里带了偏离量，所以这种"error 数没变但更接近合格线"
    // 的一轮也算进步，值得再给一次机会。
    while (rounds < MAX_REPAIR_ROUNDS) {
      rounds += 1;
      const parsedBest = parseArticle(bestHtml);
      const errorPart = repairInstructionList(bestReport.errors, parsedBest, variants.lengthTarget ?? undefined);
      if (!errorPart) break;

      const beforeErr = bestReport.errors.length;
      const beforeDist = distance(bestReport);
      let improved = false;
      try {
        const fixed = await repairOnce(model, bestHtml, errorPart, parsedBest, variants.lengthTarget ?? undefined);
        if (fixed) {
          const r = lintArticle(fixed, undefined, track.name, style.rule.checks, style.rule.relax);
          improved = distance(r) < beforeDist;
          logger.info(
            {
              model: model.name,
              round: rounds,
              fromErrors: beforeErr,
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
