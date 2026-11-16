/**
 * 选题角度池的扩充服务。
 *
 * 背景：角度池此前只能靠 cli/migrate.ts（从旧流水线数据）与 reference/ 下的
 * Python 脚本离线填充，而 ModelRole 里的 `expand_angles` 角色虽然定义好了、
 * 模型绑定界面也支持，却没有任何服务真正去调用它。
 * 结果就是「新增一个赛道 → 角度池为空 → 排产报『角度池已空，请先扩库』」。
 *
 * 本服务补上这条链路：用绑定到 expand_angles 的对话模型，按赛道（+ 可选维度种子）
 * 生成候选选题，归一化去重后入库，让新赛道能立刻产出不重复的内容。
 *
 * 「不重复」由两层保证：
 *   1. 生成前把现有选题喂给模型，要求避开
 *   2. 生成后做归一化比对（现有池 + 本批次内），重复的直接丢弃
 * 消费侧（planner.reserveAnglesForAccount）还有 used 标记做第三次保证。
 *
 * 角度切片（Angle.scope）：
 *   扩库时可以指定产出的切片——漫画产线只吃 comic/shared，把文章选题灌给它是没用的
 *   （dashboard 里漫画线 angleStock=0 就是这么来的）。不同切片的 prompt 也不同：
 *   漫画选题要求「能一眼画出来的场景」，文章选题要求「有冲突的具体处境」。
 */

import { prisma } from '../db.ts';
import { packJson } from '../db-json.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.ts';
import { logger } from '../logger.ts';
import { Prisma, type AngleStatus } from '@prisma/client';
import { assertRoleUsable, chatComplete } from './llm.ts';
import { findOffIpWords, ipCharacterBrief, loadComicTemplates } from './comic/script.ts';
import { loadGlobalPrompt } from './style-prompts.ts';
import type { AngleScope } from './pipeline.ts';
import { ruleFor } from './track-rules.ts';
import {
  scoreAngleCandidates,
  toScoreMeta,
  readScoreMeta,
  type AngleScoreMeta,
  type AngleScores,
  type CompleteFn,
  type ScoredCandidate,
} from './topic-review.ts';
import {
  checkAngleDup,
  checkDupAgainstSnapshot,
  loadDupSnapshot,
  normalize,
  type AngleDupCheckResult,
  type AngleDupHit,
} from './dedup.ts';

/** 生成 scope=x 的选题时，会被同一产线同时看到的切片（用来决定「喂哪些现有选题给模型避重」）。 */
function visibleScopes(scope: AngleScope): AngleScope[] {
  return scope === 'shared' ? ['article', 'comic', 'shared'] : [scope, 'shared'];
}

export interface ExpandResult {
  trackId: number;
  track: string;
  /** 请求生成的条数 */
  requested: number;
  /** 实际入库条数 */
  added: number;
  /** 因与现有选题或本批次内重复而跳过的条数 */
  skippedDuplicate: number;
  /** 因违反正能量守门（心理标签/纯困境结尾）被确定性过滤的条数 */
  skippedOffensive: number;
  /** 六维评分成功的条数（评分失败/缺失=其余条数，不视为高质量、不自动批准） */
  scored: number;
  /** 模型返回的原始条数（可能少于请求数） */
  generated: number;
  /** 本批入库的角度切片（article / comic / shared）。 */
  scope: AngleScope;
  /** 该切片当前可用（未用）条数，扩完就能在界面上确认够不够 */
  scopeUnused: number;
  poolTotal: number;
  poolUnused: number;
}

const MAX_COUNT = 100;
/** 喂给模型的现有选题上限，避免 prompt 过长撑爆上下文。 */
const FEEDBACK_LIMIT = 50;

/**
 * 归一化去重：S4-2 起统一用 dedup.ts 的 normalize（全仓唯一实现），
 * 与判重入口同语义——同一内容在扩库精确比对与 L0 判定里结果一致。
 */

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * L0/L1 命中 → 400 拒绝（手动新增 / 手动编辑共用）。
 * detail 带结构化命中明细（级别、命中对象、相似度、来源赛道），供前端展示「为什么不能保存」。
 */
function dupBlockError(dup: AngleDupCheckResult): BadRequestError {
  const top = dup.blockHits[0]!;
  const levelText = top.level === 'L0' ? '完全重复（L0）' : '高度相似（L1）';
  const more = dup.blockHits.length > 1 ? `（另有 ${dup.blockHits.length - 1} 处命中）` : '';
  return new BadRequestError(
    `与现有选题${levelText}，不能保存：「${clip(top.targetText, 40)}」相似度 ${(top.score * 100).toFixed(0)}%` +
      `${top.trackName ? `，来源赛道「${top.trackName}」` : ''}${more}`,
    { level: top.level, hits: dup.blockHits, warnings: dup.warnHits },
  );
}

interface RawAngle {
  theme: string;
  content: string;
}

/** 从模型输出里抠出 JSON 数组。兼容 ```json 围栏与前后多余的客套话。 */
function extractJsonArray(raw: string): RawAngle[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) text = fence[1].trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new BadRequestError(`模型未返回 JSON 数组，原始输出前 200 字：${raw.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new BadRequestError(`模型返回的 JSON 无法解析，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestError(`模型返回的不是数组，原始输出前 200 字：${raw.slice(0, 200)}`);
  }

  const out: RawAngle[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      out.push({ theme: '', content: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      // 兼容模型用 angle/text/title 等别名
      const content = o.content ?? o.angle ?? o.text ?? o.title;
      const theme = o.theme ?? o.topic ?? '';
      if (typeof content === 'string' && content.trim()) {
        out.push({ theme: typeof theme === 'string' ? theme : '', content });
      }
    }
  }
  return out;
}

/**
 * 不同切片要不同口味：漫画要「能画出来的场景」，文章要「能讲开的冲突」。
 *
 * 漫画/共享切片额外加一条**人物白名单**：漫画的画面来自固定家庭 IP（四口之家），
 * 选题里一旦出现「奶奶/婆婆/老师」这类 IP 外角色，就只能被硬塞成爸爸/妈妈，
 * 结果就是「标题写奶奶、画面是妈妈、台词对不上」。所以在**选题阶段**就把它掐掉。
 * 角色清单与禁用词表都来自 config/comic_templates.json（= 家庭 IP 资产），不在这里硬编码。
 */
function scopeBrief(scope: AngleScope): string {
  if (scope === 'article') {
    return (
      '这些选题会写成公众号长文。要求：有具体处境与两难，能展开成 9~12 个小节的叙事或说理，' +
      '不要写成空泛的道理，也不要写成需要画面才能成立的瞬间。'
    );
  }

  const tpl = loadComicTemplates();
  const cast = `登场人物只能来自固定的家庭 IP：${ipCharacterBrief(tpl)} 这四个；` +
    `**禁止**出现 ${(tpl.offIpWords ?? []).join('、')} 这类 IP 外的角色；` +
    '冲突必须发生在这四个人之间（需要"长辈"角色时用爸爸/妈妈承担，需要"老师/同学"时用哥哥/弟弟承担，不要写成外人）。';

  if (scope === 'comic') {
    return (
      '这些选题会画成 4~6 格的条漫。要求：必须是一个**能被一眼画出来的具体场景**——' +
      '有明确的人物、具体的动作与地点、一句能放进对话气泡的台词；' +
      '冲突要在一格里看懂（反差、尴尬、反转皆可），不要抽象情绪，不要写成道理或总结。' +
      cast
    );
  }

  return (
    '这些选题既可能写成文章、也可能画成漫画。要求：具体场景 + 明确冲突，两栖可用，' +
    '既有画面感（人物、动作）也能展开讲道理。' +
    cast
  );
}

/**
 * 星座赛道的选题形态：**刻意与其它赛道不同**。
 *
 * 为什么要单独一套：通用规则要求「每条结尾留一个指向方法的钩子（怎么/如何/怎么办）」，
 * 这条规则在育儿/职场/教育是对的（读者来是为了解决问题），在星座赛道是错的——
 * 它会把选题逼成「XX座遇到某个职场困境，该怎么办」的**问题咨询式**题目。
 * 实测星座角度库里的 9 条全是这一形态（老板误判、团队进度、向父母坦白、室友边界…），
 * 于是成稿也全是职场沟通文：星座只是标题里的一个标签，正文在讲 PPT 和微信消息。
 *
 * 星座读者要的是「被说中」与「好玩」，不是「来问怎么办」。所以钩子换成：
 * 反差、误解、具体行为切片、或一个能对号入座的选择题。
 */
const ZODIAC_ANGLE_RULES = [
  '',
  '⚠️ **星座赛道专用规则（覆盖上面的通用选题补充）**：',
  '1. **不写「问题咨询式」题目**。禁止「遇到X该怎么办」「如何向Y解释」「怎么平衡Z」这种句式。',
  '   星座读者不是来解决问题的，是来被说中的、来看热闹的。',
  '2. 题面必须**挂在星座/星象上**：出现星座名（水逆期、土星回归、新月、满月、火象…）或某个具体星座。',
  '3. 题面要有**一个具体的画面或行为切片**，不是性格形容词。',
  '   ✅「水逆第三天，他把已读不回包装成了在忙」　❌「水逆期间容易情绪混乱」',
  '4. 钩子换成以下四种之一（替代通用规则里的「怎么/如何/怎么办」）：',
  '   - 反差型：都说XX座怎样，其实他们……',
  '   - 误解型：被误解最深的那一点是……',
  '   - 行为切片型：XX座在[具体场景]下的反应是……',
  '   - 对号入座型：你是哪一种？',
  '5. 禁止把职场/课业/绩效/升职写成需要「高情商沟通」才能解决的情境。',
  '   星座可以谈工作，但要谈**这个星座在职场里的样子**，不是谈「怎么跟老板沟通」。',
  '6. theme 用星座/天象/关系场景词（水逆、上升、月亮、双鱼、加班、消息、闺蜜），',
  '   不要用职场黑话（汇报、绩效、向上管理）。',
].join('\n');

/**
 * 激励（moment）形态：普通时刻 + 一件小事。
 *
 * 为什么需要它：`sys:激励` 的写稿形态是「一个普通时刻 → 一条发现 → 3-4 件今天能做的小事」，
 * 而选题层的通用规则要求「冲突/反差 + 方法钩子」，两层口径相反，产出就成了
 * 「怎么才能早起」这类方法咨询题——与「普通时刻」差得很远。
 *
 * 这一段是**替换**通用形态补充，不是追加：追加会让模型同时收到两条相反指令。
 */
const MOMENT_ANGLE_RULES = [
  '\n选题补充（**激励赛道专用，覆盖通用形态要求**）：',
  '1. 题面写**一个普通、具体的生活或工作时刻**：几点、在哪、手上正在做什么。',
  '2. 这个时刻里发生**一件小事**，题目落在这件小事上，由它自然带出主题。',
  '3. 允许平静、细微、真实的日常观察（等电梯的三分钟、把闹钟按掉又躺回去）。',
  '4. **不强制**重大事件、戏剧冲突或强烈反差；写不出冲突也没关系。',
  '5. **不要求**「怎么/如何/怎么办/该不该」这类方法钩子，也不要写成方法咨询题。',
  '6. theme 用场景或身体动作词（闹钟/地铁/外卖/凌晨三点），不用方法论名词。',
].join('\n');

/**
 * 科技（scene）形态：真实使用场景 + 可感知的比喻或判断信号。
 *
 * 为什么需要它：`sys:科技` 的形态是「一个场景 + 一个比喻 + 三个信号 + 两件能做的事」，
 * 通用选题规则会把它推向「XX 会不会取代你」这类技术争议题，或者停在抽象名词上。
 */
const SCENE_ANGLE_RULES = [
  '\n选题补充（**科技赛道专用，覆盖通用形态要求**）：',
  '1. 题面写**一个真实、具体的应用场景**：谁、在什么任务上、用了什么。',
  '2. 让普通读者看得懂场景里发生了什么，不要停在抽象技术名词或产品功能上。',
  '3. 至少带一个**普通读者能感知的比喻**、一个**具体结果**或一个**明确判断信号**',
  '   （省了什么 / 拿走了什么 / 还不敢确定什么）。',
  '4. **不强制**争议、冲突或技术对立；不要写「会不会被取代」这类焦虑题。',
  '5. **不要求**「怎么/如何/怎么办」这类方法钩子，也不要写成科普问答。',
  '6. theme 用具体物件或动作（体检单/字幕/导航/错题本），不用行业词（大模型/算法/范式）。',
].join('\n');

/** 通用形态补充（default / zodiac 用；文案与 B 档改造前逐字一致）。 */
const DEFAULT_FORM_NOTE_WITH_GLOBAL =
  '\n选题补充：题面可以有真实冲突或两难，但**必须能落到方法、希望或成长**——' +
  '不选「不这么做孩子就完了」式恐吓题，不选只放大痛苦却没有出路的题。' +
  '每条的结尾必须留一个指向方法的钩子（怎么开口/怎么办/如何化解这类问法），' +
  '不许停在僵局或纯负面情绪上；theme 主题词用具体场景或关系词，' +
  '禁止心理病理标签（焦虑症、分离焦虑、抑郁、创伤等）。';

/** 无自定义总纲时的通用形态补充（同上，逐字保留）。 */
const DEFAULT_FORM_NOTE_PLAIN =
  '正能量——不贩卖焦虑、不放大痛苦；' +
  '题面可以有冲突，但要能落到方法、希望或成长，结尾必须留指向方法的钩子。';

/**
 * 星座（zodiac）形态补充：只把通用那句「结尾必须留指向方法的钩子」换成本赛道钩子，
 * 其余文案与 default 逐字相同。
 *
 * 为什么必须换而不是只追加附录：`sys:星座` 明令「结尾用一句可截图的话 / @那个XX座」，
 * 而通用那句要求「怎么开口 / 怎么办」式问句——两条指令同时下发，模型行为不稳定；
 * 附录里那句「覆盖上面的通用选题补充」也只有在总纲不反着要求时才好使。
 */
const ZODIAC_FORM_NOTE_WITH_GLOBAL =
  '\n选题补充：题面可以有真实冲突或两难，但**必须能落到方法、希望或成长**——' +
  '不选「不这么做孩子就完了」式恐吓题，不选只放大痛苦却没有出路的题。' +
  '每条的结尾用本赛道钩子（反差 / 误解 / 行为切片 / 对号入座），' +
  '不要写成「怎么开口 / 怎么办 / 如何化解」这类提问；' +
  'theme 主题词用具体场景或关系词，禁止心理病理标签（焦虑症、分离焦虑、抑郁、创伤等）。';

/** 星座 + 无自定义总纲时（同上，只换结尾那句）。 */
const ZODIAC_FORM_NOTE_PLAIN =
  '正能量——不贩卖焦虑、不放大痛苦；' +
  '题面可以有冲突，但要能落到方法、希望或成长，结尾用本赛道钩子（反差 / 误解 / 行为切片 / 对号入座）。';

function buildMessages(
  trackName: string,
  count: number,
  existing: string[],
  seed: string | undefined,
  scope: AngleScope,
  globalPrompt: string,
): { role: 'system' | 'user'; content: string }[] {
  const avoid =
    existing.length > 0
      ? `\n\n已有选题（必须避开，不得与其中任何一条重复或高度相似）：\n${existing
          .map((c, i) => `${i + 1}. ${c}`)
          .join('\n')}`
      : '\n\n该赛道目前还没有任何选题，请从零开始给出第一批。';

  const seedPart = seed?.trim() ? `\n\n本批希望侧重这些方向（供参考，不必逐条对应）：${seed.trim()}` : '';

  // 创作总纲（文风配置页可改）：题库素材同样必须正能量——不贩卖焦虑、落点指向方法或成长。
  // 2026-11-11 用户要求「素材库-题库的素材也要是正能量的」，与写稿共用同一份总纲。
  // 同日二次硬化：产出仍出现纯困境结尾与心理标签（「分离焦虑」等），补硬约束 + 确定性过滤。
  const mode = ruleFor(trackName).angleMode;
  const hasGlobal = globalPrompt.trim().length > 0;

  // 总纲头（default 与 zodiac 逐字不变；moment/scene 共用同一个头）
  const charterHead = hasGlobal
    ? `\n\n创作总纲（选题必须满足，与写稿同一份总纲）：\n${globalPrompt.trim()}`
    : '\n\n创作总纲（选题必须满足）：';

  // 形态补充按 mode **替换**（不是追加）：总纲里那句「结尾必须留指向方法的钩子」与
  // moment / scene 的形态要求、以及星座的「禁止咨询式提问」都直接相反，追加只会让模型
  // 同时收到两条互斥指令。
  const charterForm =
    mode === 'moment'
      ? MOMENT_ANGLE_RULES
      : mode === 'scene'
        ? SCENE_ANGLE_RULES
        : mode === 'zodiac'
          ? hasGlobal
            ? ZODIAC_FORM_NOTE_WITH_GLOBAL
            : ZODIAC_FORM_NOTE_PLAIN
          : hasGlobal
            ? DEFAULT_FORM_NOTE_WITH_GLOBAL
            : DEFAULT_FORM_NOTE_PLAIN;

  // 选题形态由 `r:{赛道}.angleMode` 决定，代码里不再有赛道名判断。
  // zodiac：通用 charter 的「方法钩子」要求会把选题逼成问题咨询式，单独换一套。
  const charterFinal = mode === 'zodiac' ? charterHead + charterForm + ZODIAC_ANGLE_RULES : charterHead + charterForm;

  // 形态相关的三条硬性要求（default 逐字不变；moment/scene 换成各自形态）
  const formatHint =
    mode === 'moment'
      ? '一条 20~60 字的选题，写一个普通时刻 + 一件小事，要有具体画面感'
      : mode === 'scene'
        ? '一条 20~60 字的选题，写一个真实使用场景，含一个可感知的比喻或明确的判断信号'
        : '一条 20~60 字的选题，有具体画面感，暗含冲突或反差';
  const reqConflict =
    mode === 'moment'
      ? '每条 content 一句话，20~60 字，写一个普通、具体的生活或工作时刻（几点/在哪/手上在做什么），从这个时刻里的一件小事自然带出主题；不要写成空泛的道理，不强制戏剧冲突或强烈反差'
      : mode === 'scene'
        ? '每条 content 一句话，20~60 字，写一个真实、具体的使用场景（谁/在什么任务上/用了什么），让普通读者看得懂发生了什么；不要停在抽象技术名词或产品功能上'
        : '每条 content 一句话，20~60 字，要有可感知的具体场景（人物、动作、处境），并暗含冲突、反差或两难，不要写成空泛的道理';
  const reqEnding =
    mode === 'moment'
      ? '每条收在一件具体的小事上（一个动作、一个改法），不要写成「怎么/如何/怎么办」式的提问'
      : mode === 'scene'
        ? '每条至少给出一个普通读者能感知的比喻、一个具体结果或一个明确判断信号（省了什么/拿走了什么/还不确定什么），不要写成「怎么/如何」式提问'
        : mode === 'zodiac'
          ? '每条结尾用本赛道钩子（反差 / 误解 / 行为切片 / 对号入座），不要写成「怎么/如何/怎么办」式提问'
          : '每条结尾必须留一个指向方法的钩子（「怎么…」「如何…」「怎么办」「该不该…」这类问法），不许停在僵局或纯情绪上';

  return [
    {
      role: 'system',
      content:
        '你是微信公众号的选题策划。你只输出 JSON，不输出任何解释、前言或结语。' +
        '不要使用 Markdown 代码块以外的任何包装。',
    },
    {
      role: 'user',
      content:
        `赛道主题：${trackName}` +
        charterFinal +
        avoid +
        seedPart +
        `\n\n用途要求：${scopeBrief(scope)}` +
        `\n\n请为这个赛道创作 ${count} 条全新的选题角度，严格以 JSON 数组输出，格式为：` +
        `[{"theme":"2~6 字主题词","content":"${formatHint}"}]` +
        `\n\n硬性要求：` +
        `\n1. ${reqConflict}` +
        `\n2. 各条之间角度必须不同，不得换汤不换药` +
        `\n3. 严禁与上面「已有选题」重复或高度相似` +
        `\n4. ${reqEnding}` +
        `\n5. theme 主题词用具体场景或关系词（如二胎/手机/开家长会），禁止心理病理标签（焦虑症、分离焦虑、抑郁、创伤等）` +
        `\n6. 只输出这 ${count} 条，不要多也不要少，不要编号以外的内容`,
    },
  ];
}

/**
 * 选题正能量守门（确定性过滤，提示词约束之外的第二道闸）。
 * 2026-11-11 用户复核「不贩卖焦虑」发现产出混入纯困境结尾与心理标签，补此闸：
 *   ① theme 含心理病理标签 → 拒收（改用场景/关系词）
 *   ② 结尾（末 24 字）没有方法钩子 → 拒收（停在僵局/纯情绪=只放大痛苦没出路）
 * 返回拒收原因；合规返回 null。
 */
const BANNED_THEME_RE = /(焦虑症|分离焦虑|抑郁|创伤|心理障碍|人格障碍|成瘾|自残|自杀|惊恐|强迫症)/;
const METHOD_HOOK_RE = /(怎么|如何|怎么办|办法|该不该|要不要|怎样|试试|开口|沟通|化解|收场|下一步|出路|和解|挽回|改善|面对|处理|安慰|拒绝|商量)/;

/**
 * 星座赛道的钩子：**不要求**「怎么/如何/怎么办」。
 *
 * 通用规则要求方法钩子，是为了防止选题停在纯困境（育儿/职场读者来是为了解决问题）。
 * 星座赛道的钩子换成反差/误解/行为切片/对号入座——见 ZODIAC_ANGLE_RULES。
 *
 * ⚠️ 这里**不再**用「反差词白名单」做正向判定：实测那个做法很脆
 * （「最先把话说完了」这类好角度被误杀，而「怕被误解为挑剔」这种坏角度漏过）。
 * 确定性守门只拦**形态错误**（问题咨询式 / 疑问句 / 没有星座锚），
 * 「有没有反差与行为切片」交给提示词——那是模型能执行、代码不能判的部分。
 */
/** 问题咨询式：星座赛道里这类题会直接产出「职场沟通文」。 */
const CONSULT_QUESTION_RE =
  /(怎么办|该如何|如何|该怎么|怎么(?:办|做|破|处理|开口|沟通|应对|解决|平衡|收拾|圆场|解释|表达)|该不该|要不要)/;
/** 星座/星象锚：题目必须挂在星座上，否则写出来是别的赛道。 */
const ZODIAC_ANCHOR_RE = /(星座|水逆|逆行|满月|新月|上升|下降|太阳|月亮|金星|火星|水星|木星|土星|天王星|海王星|冥王星|守护星|宫位|相位|落陷|元素|火象|风象|水象|土象|白羊|金牛|双子|巨蟹|狮子|处女|天秤|天蝎|射手|摩羯|水瓶|双鱼)/;
/** 星座题目太短 = 一个干巴巴的标签（没有画面），不是选题。 */
const ZODIAC_MIN_LEN = 12;

/**
 * 选题守门。
 *
 * 准入 = **基础保护（所有模式都过）** + **形态规则（按 mode 分派）**：
 *   - 基础保护：内容非空；theme 不得含心理病理标签（`BANNED_THEME_RE`）。这两条任何赛道都不放宽。
 *   - `default`：基础保护 + 结尾必须有方法钩子（方法论式选题，防止停在僵局/纯情绪）。
 *   - `zodiac` ：基础保护 + 星座专属四条（禁咨询式 / 禁疑问句收尾 / 需星座锚 / 最低长度）。
 *   - `moment` / `scene`：基础保护 + 不做形态判定——形态交给提示词与人工审核（候选 → approved）。
 *
 * @param trackName 赛道名：按代码种子 `r:{赛道}.angleMode`（即 `ruleFor`）选择守门形态。
 *                  ⚠️ 注意是**种子**，不是库里的 `StylePrompt.angleMode`。
 */
export function topicRejectReason(
  c: { theme?: string; content?: string },
  trackName = '',
): string | null {
  const theme = (c.theme ?? '').trim();
  const content = (c.content ?? '').trim();
  if (!content) return '内容为空';
  if (BANNED_THEME_RE.test(theme)) return `theme 含心理病理标签：${theme}`;

  const mode = ruleFor(trackName).angleMode;

  if (mode === 'zodiac') {
    if (CONSULT_QUESTION_RE.test(content)) {
      return '星座选题不许写成问题咨询式（怎么办/如何…）：星座读者要的是被说中，不是来求解';
    }
    if (/[？?]\s*$/.test(content)) {
      return '星座选题不许用疑问句收尾（那是提问，不是选题）';
    }
    if (!ZODIAC_ANCHOR_RE.test(content)) {
      return '星座选题必须挂在星座/星象上（缺星座名或天象词）';
    }
    if (content.length < ZODIAC_MIN_LEN) {
      return `星座选题太短（${content.length} 字 < ${ZODIAC_MIN_LEN}）：要有一个具体画面，不是一个性格标签`;
    }
    return null;
  }

  // moment / scene（S4-5 B 档）：形态交给提示词 + 人工审核（候选 → approved），
  // 确定性守门只保留基础保护（空内容 / 反心理标签，见函数开头）。
  // 这里**必须**去掉「方法钩子」这条：它正是把激励逼成「怎么才能早起」式方法咨询题、
  // 把科技逼成「如何理解大模型」式科普问答的那道门；留着它，形态改造等于没做。
  if (mode === 'moment' || mode === 'scene') return null;

  const tail = content.slice(-24);
  if (!METHOD_HOOK_RE.test(tail)) return '结尾没有方法钩子（停在僵局/纯情绪）';
  return null;
}

/**
 * 为赛道扩充选题角度池。
 *
 * S4-1 起：产出**一律进 candidate（候选）**，不直接入正式题库（D1）；
 * 只有人工审核 approved 后才可被排产消费。入库前做六维评分（D5 复用 write 角色，
 * 批量调用），评分失败按未评分入库——绝不默认高质量、绝不自动批准。
 *
 * @param trackId 赛道 id
 * @param count   希望新增的条数（1~100）
 * @param seed    可选的维度种子，用来引导本批选题的方向
 * @param scope   产出的角度切片（默认 article）。**给漫画产线扩库必须传 comic 或 shared**，
 *                否则产出的选题只挂在文章切片上，漫画产线一粒都吃不到。
 * @param opts    测试注入缝（Mock LLM）：gen=生成调用、score=评分调用；缺省走真实 chatComplete。
 */
export async function expandAnglesForTrack(
  trackId: number,
  count: number,
  seed?: string,
  scope: AngleScope = 'article',
  opts: { gen?: CompleteFn; score?: CompleteFn } = {},
): Promise<ExpandResult> {
  const want = Math.min(Math.max(Math.floor(count) || 20, 1), MAX_COUNT);

  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) throw new NotFoundError(`赛道 ${trackId} 不存在`);

  // 未绑定 / 停用 / 能力不符 / 缺 Key 都由统一判定给出可读的 400 文案。
  // 测试注入 opts.gen 时跳过角色解析（Mock：不触真实模型绑定与外呼）。
  let modelName = 'mock-expand';
  let model: Awaited<ReturnType<typeof assertRoleUsable>> | null = null;
  if (!opts.gen) {
    model = await assertRoleUsable('expand_angles');
    modelName = model.name;
  }

  const visScopes = visibleScopes(scope);

  // 判重快照（S4-2 统一入口）：全赛道现有选题（含 rejected / 已用）+ 历史文章标题。
  // 批次内互查靠把已接受候选推进快照实现（L0/L1 同语义）。
  const dupSnapshot = await loadDupSnapshot();

  // seq / 避让清单仍取本赛道（跨切片不该出现字面重复的选题）。
  const all = await prisma.angle.findMany({
    where: { trackId },
    orderBy: { seq: 'desc' },
    take: 500,
    select: { content: true, seq: true, scope: true },
  });
  const maxSeq = all.reduce((m, a) => (a.seq > m ? a.seq : m), 0);

  // 喂给模型的「必须避开」只取本产线看得到的切片，免得被另一种口味的选题带偏。
  const existing = all
    .filter((a) => visScopes.includes(a.scope as AngleScope))
    .slice(0, FEEDBACK_LIMIT)
    .map((a) => a.content);

  // 创作总纲（文风配置页）：题库扩库与写稿共用同一份正能量约束。
  const globalPrompt = await loadGlobalPrompt();

  const messages = buildMessages(track.name, want, existing, seed, scope, globalPrompt);
  const raw = opts.gen
    ? await opts.gen(messages, { temperature: 0.9, maxTokens: 4000 })
    : await chatComplete(model!, messages, { temperature: 0.9, maxTokens: 4000 });

  const candidates = extractJsonArray(raw);
  if (candidates.length === 0) {
    throw new BadRequestError(`模型没有给出任何可用选题，原始输出前 200 字：${raw.slice(0, 200)}`);
  }

  const stamp = Date.now().toString(36);
  const rows: {
    trackId: number;
    code: string;
    seq: number;
    theme: string;
    content: string;
    source: string;
    scope: string;
    status: AngleStatus;
    /** L2 历史标题命中（只提示不拦截），随行写入 metaJson.dedupHits。 */
    dedupHits: AngleDupHit[];
  }[] = [];
  let skippedDuplicate = 0;
  let skippedOffensive = 0;

  for (const c of candidates) {
    // 正能量守门：拒收纯困境结尾/心理标签题（比提示词更硬，模型不听话时兜底）
    // ⚠️ 评分不绕过硬门禁：被守门拒收的候选根本不进入评分与入库（S4-1 红线）。
    const reject = topicRejectReason(c, track.name);
    if (reject) {
      skippedOffensive += 1;
      logger.warn({ trackId, theme: c.theme, reason: reject }, '选题被正能量守门拒收');
      continue;
    }
    const key = normalize(c.content);
    if (!key) {
      skippedDuplicate += 1;
      continue;
    }
    // S4-2 统一判重：L0 完全重复 / L1 高度相似（含跨赛道、含批次内已接受候选）→ 跳过不入库；
    // L2 历史标题命中 → 保留候选，命中明细随行进 metaJson.dedupHits。
    const dup = checkDupAgainstSnapshot(dupSnapshot, c.content);
    if (dup.blocked) {
      skippedDuplicate += 1;
      logger.warn(
        { trackId, theme: c.theme, level: dup.blockHits[0]?.level, hits: dup.blockHits.slice(0, 3) },
        '扩库候选与现有选题重复（L0/L1），跳过不入库',
      );
      continue;
    }
    // 批次内互查：已接受候选进快照（id=0 标记批次内），后续候选与它同样过 L0/L1。
    dupSnapshot.angles.push({ id: 0, content: c.content, trackId, trackName: track.name });
    rows.push({
      trackId,
      code: clip(`llm-${stamp}-${rows.length}`, 32),
      seq: maxSeq + rows.length + 1,
      theme: clip(c.theme || c.content.slice(0, 6), 64),
      content: clip(c.content, 500),
      source: 'llm-expand',
      scope,
      // D1：生成即候选。任何路径都不允许生成后直接进正式题库。
      status: 'candidate',
      dedupHits: dup.warnHits,
    });
  }

  // 六维评分（S4-1）：批量一次判多条（Q10）；失败只降级为未评分，不阻断候选入库。
  let scored = 0;
  if (rows.length > 0) {
    const scoreMap = await scoreAngleCandidates(
      track.name,
      rows.map((r, i) => ({ id: i + 1, theme: r.theme, content: r.content })),
      opts.score,
    );
    let scoreModel = '';
    const data = rows.map((r, i) => {
      const rec = scoreMap.get(i + 1);
      if (rec?.scores) {
        scored += 1;
        scoreModel = 'write-role';
      }
      const { dedupHits, ...row } = r;
      const meta: AngleScoreMeta = toScoreMeta(rec, opts.score ? 'mock-write' : 'write-role');
      // L2 历史标题命中随行固化到 metaJson.dedupHits（无命中不写，避免造空数据）。
      const metaWithDedup = dedupHits.length > 0 ? { ...meta, dedupHits } : meta;
      return { ...row, metaJson: packJson(metaWithDedup) ?? Prisma.DbNull };
    });
    await prisma.angle.createMany({ data });
    logger.info({ trackId, count: rows.length, scored, scoreModel }, '选题六维评分完成');
  }

  const [poolTotal, poolUnused, scopeUnused] = await Promise.all([
    prisma.angle.count({ where: { trackId } }),
    prisma.angle.count({ where: { trackId, used: false } }),
    prisma.angle.count({ where: { trackId, used: false, scope: { in: [...visScopes] } } }),
  ]);

  logger.info(
    { trackId, track: track.name, model: modelName, scope, requested: want, added: rows.length, skippedDuplicate, skippedOffensive, scored },
    '选题扩库完成（进入候选，待人工审核）',
  );

  return {
    trackId,
    track: track.name,
    requested: want,
    added: rows.length,
    skippedDuplicate,
    skippedOffensive,
    scored,
    generated: candidates.length,
    scope,
    scopeUnused,
    poolTotal,
    poolUnused,
  };
}

/** 赛道角度池概况，供列表页展示「什么时候该扩库了」。 */
export async function anglePoolStats(trackId: number): Promise<{ total: number; unused: number }> {
  const [total, unused] = await Promise.all([
    prisma.angle.count({ where: { trackId } }),
    prisma.angle.count({ where: { trackId, used: false } }),
  ]);
  return { total, unused };
}

/* ────────────────────────────────────────────────────────────
 * 选题库 CRUD
 *
 * 背景：角度池此前只有「扩库」与「计数」两个能力，前端只能看到
 * 「96/105」这种聚合数字，看不到任何一条选题正文，也无法编辑或删除。
 * 这里补上明细的增删改查，让选题池变成可运营的资产。
 *
 * 约定（很重要）：
 *   - 消费态字段（used / usedBy / usedDate）由排产与文章删除逻辑维护，
 *     外部一律不可通过 update 改写，否则会出现「选题显示未用但文章已写」的错乱。
 *   - 删除选题会解除文章关联（Article.angle 是 SetNull），
 *     但正文不受影响；删除前把关联文章数一并返回，供前端做强提示。
 * ──────────────────────────────────────────────────────────── */

export interface AngleReleaseResult {
  ok: true;
  id: number;
  /** 归还后该赛道未用角度数，前端提示用 */
  poolUnused: number;
  message: string;
}

/**
 * 手动归还：把「已用但已无任何文章引用」的孤儿选题重置回未用池。
 *
 * 为什么会有孤儿选题：删文章时只有 draft/updated/failed 会自动归还角度，
 * pushed 的刻意不还（选题已推过草稿箱，自动归还可能导致同一选题被再写一遍）；
 * 删账号同理。于是 pushed 文章被删后会留下 used=true 但关联 0 的孤儿。
 *
 * 归还只开放给 articleCount===0 的选题——还有文章挂着的不能还（文章会变孤儿），
 * 自动归还逻辑（删文章/删账号）保持原样不受影响。
 */
export async function releaseAngle(id: number): Promise<AngleReleaseResult> {
  const a = await prisma.angle.findUnique({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  if (!a) throw new NotFoundError(`选题 ${id} 不存在`);
  if (!a.used) throw new BadRequestError('该选题本来就是未用状态，无需归还');
  if (a._count.articles > 0) {
    throw new BadRequestError(
      `仍有 ${a._count.articles} 篇文章关联该选题，不能归还；删除这些文章时会自动归还`,
    );
  }

  await prisma.angle.update({
    where: { id },
    data: { used: false, usedBy: '', usedDate: null, usedById: null, usedByAccountId: null },
  });

  const poolUnused = await prisma.angle.count({ where: { trackId: a.trackId, used: false } });
  logger.info({ id, trackId: a.trackId, prevUsedBy: a.usedBy }, '手动归还选题');

  return {
    ok: true,
    id,
    poolUnused,
    message: `选题「${a.theme}」已归还选题池，本赛道现有 ${poolUnused} 条未用选题`,
  };
}

/** 对外暴露的选题明细，时间统一 ISO 字符串（与 articles.ts 保持一致）。 */
export interface AngleItem {
  id: number;
  trackId: number;
  code: string;
  seq: number;
  theme: string;
  content: string;
  /** 角度切片：决定哪条产线能消费它（article / comic / shared）。 */
  scope: AngleScope;
  used: boolean;
  usedBy: string;
  usedDate: string | null;
  /** P3 结构化归属：谁（用户/账号）用掉的。 */
  usedById: number | null;
  usedByAccountId: number | null;
  source: string;
  /** 审核态（D1）：candidate / needs_revision / approved / rejected。 */
  status: AngleStatus;
  /** 已完成的审核轮数（0=从未审核）。 */
  reviewRound: number;
  /** 六维评分（未评分为 null——不得视为高质量）。 */
  scores: AngleScores | null;
  /** 总分（0-30，六维等权合计）；未评分为 null。 */
  scoreTotal: number | null;
  /** 评分模型给出的参考建议（不是审核结论，人工审核为准）。 */
  scoreSuggestion: string;
  /** 评分失败/缺失原因；空=已评分或未要求评分。 */
  scoreError: string | null;
  /** 待重新评分标记（R1）：approved 编辑退回后为 true，重新评分成功后清除；带标记不可审核通过。 */
  rescoreRequired: boolean;
  /** S4-2 去重命中明细（metaJson.dedupHits 快照）：L2 历史标题提示为主，列表/审核展示用。 */
  dedupHits: AngleDupHit[];
  /** 引用了该选题的文章数，删除提示要用 */
  articleCount: number;
  /**
   * 选题里出现了 IP 外角色（奶奶/婆婆/老师…）。
   * 文章线无所谓；漫画线会画不出来 → 界面标警示，并支持一键退回文章专用。
   */
  offIp: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AngleUsedFilter = 'unused' | 'used' | 'all';

export interface AngleListParams {
  trackId: number;
  used?: AngleUsedFilter;
  /** 审核态过滤；不传 = 全部。 */
  status?: AngleStatus | 'all';
  /** 按切片过滤；不传 = 全部。 */
  scope?: AngleScope;
  /** 只看含 IP 外角色的选题（漫画产线治理用）。 */
  offIp?: boolean;
  keyword?: string;
  /** 排序：seq=现有序号（默认）；score=总分降序（未评分类排最后）。评分影响排序（S4-1）。 */
  sort?: 'seq' | 'score';
  limit?: number;
  offset?: number;
}

export interface AngleCreateInput {
  trackId: number;
  theme?: string;
  content: string;
  source?: string;
  /** 默认 article。给漫画产线用必须显式传 comic 或 shared。 */
  scope?: AngleScope;
}

export interface AngleUpdateInput {
  theme?: string;
  content?: string;
  /** 改切片＝把这条选题划给另一条产线，不影响消费态。 */
  scope?: AngleScope;
}

export interface AngleDeleteResult {
  ok: true;
  id: number;
  trackId: number;
  theme: string;
  used: boolean;
  /** 因删除本选题而被解除关联的文章数（正文不受影响） */
  unlinkedArticles: number;
  message: string;
}

type AngleRow = {
  id: number;
  trackId: number;
  code: string;
  seq: number;
  theme: string;
  content: string;
  scope: string;
  status: AngleStatus;
  reviewRound: number;
  metaJson: unknown;
  used: boolean;
  usedBy: string;
  usedDate: string | null;
  usedById: number | null;
  usedByAccountId: number | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { articles: number };
};

type AngleWhere = NonNullable<NonNullable<Parameters<typeof prisma.angle.findMany>[0]>['where']>;

function toItem(a: AngleRow): AngleItem {
  const meta = readScoreMeta(a.metaJson);
  return {
    id: a.id,
    trackId: a.trackId,
    code: a.code,
    seq: a.seq,
    theme: a.theme,
    content: a.content,
    scope: (a.scope ?? 'article') as AngleScope,
    used: a.used,
    usedBy: a.usedBy,
    usedDate: a.usedDate,
    // P3 结构化归属：谁（用户/账号）用掉的——管理排查与跨客户查重用
    usedById: a.usedById ?? null,
    usedByAccountId: a.usedByAccountId ?? null,
    source: a.source,
    status: a.status ?? 'candidate',
    reviewRound: a.reviewRound ?? 0,
    scores: meta?.scores ?? null,
    scoreTotal: meta?.scores?.total ?? null,
    scoreSuggestion: meta?.suggestion ?? '',
    scoreError: meta?.scoreError ?? null,
    rescoreRequired: meta?.rescoreRequired === true,
    dedupHits: meta?.dedupHits ?? [],
    articleCount: a._count.articles,
    offIp: findOffIpWords(`${a.theme ?? ''}${a.content ?? ''}`).length > 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Prisma 唯一键冲突（@@unique([trackId, code])）。 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

/**
 * 分页查询某赛道的选题明细。
 * 注意：SQLite 不支持 `mode: 'insensitive'`，contains 只能做大小写敏感匹配。
 * sort=score 时在内存里按总分降序（未评分类排最后）——评分影响排序（S4-1），
 * 赛道内是百条量级，内存排序 + 分页完全够用（与 offIp 过滤同思路）。
 */
export async function listAngles(
  p: AngleListParams,
): Promise<{ total: number; limit: number; offset: number; items: AngleItem[] }> {
  const limit = Math.min(Math.max(Math.floor(p.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Math.floor(p.offset ?? 0) || 0, 0);
  const kw = p.keyword?.trim() ?? '';
  const used = p.used ?? 'all';
  const status = p.status ?? 'all';

  const where: AngleWhere = { trackId: p.trackId };
  if (used !== 'all') where.used = used === 'used';
  if (status !== 'all') where.status = status;
  if (p.scope) where.scope = p.scope;
  if (kw) where.OR = [{ content: { contains: kw } }, { theme: { contains: kw } }];

  // offIp / score 排序都是「词表或分数没法下推到 SQL」的内存路径。
  if (p.offIp || p.sort === 'score') {
    const all = await prisma.angle.findMany({
      where,
      orderBy: [{ seq: 'asc' }],
      include: { _count: { select: { articles: true } } },
    });
    let rows = all;
    if (p.offIp) {
      rows = rows.filter((a) => findOffIpWords(`${a.theme ?? ''}${a.content ?? ''}`).length > 0);
    }
    if (p.sort === 'score') {
      // 总分降序；未评分（null）排最后；同分保持 seq 升序（稳定）。
      rows = [...rows].sort((x, y) => {
        const sx = readScoreMeta(x.metaJson)?.scores?.total ?? null;
        const sy = readScoreMeta(y.metaJson)?.scores?.total ?? null;
        if (sx === null && sy === null) return x.seq - y.seq;
        if (sx === null) return 1;
        if (sy === null) return -1;
        return sy - sx || x.seq - y.seq;
      });
    }
    return { total: rows.length, limit, offset, items: rows.slice(offset, offset + limit).map(toItem) };
  }

  const [total, rows] = await Promise.all([
    prisma.angle.count({ where }),
    prisma.angle.findMany({
      where,
      orderBy: [{ seq: 'asc' }],
      skip: offset,
      take: limit,
      include: { _count: { select: { articles: true } } },
    }),
  ]);

  return { total, limit, offset, items: rows.map(toItem) };
}

export interface OffIpReassignResult {
  trackId: number;
  changed: number;
  ids: number[];
  message: string;
}

/**
 * 把某赛道**漫画切片**里含 IP 外角色的选题退回「文章专用」。
 *
 * 为什么是退回而不是改写：这类选题（隔代喂养、老师告状…）写成文章完全成立，
 * 只是画不出来——退回文章线既保住了选题，又让漫画线只剩四口之家能演的题材。
 * 只动 scope，不碰消费态与正文。
 */
export async function reassignOffIpAngles(trackId: number): Promise<OffIpReassignResult> {
  const track = await prisma.track.findUnique({ where: { id: trackId }, select: { id: true } });
  if (!track) throw new NotFoundError(`赛道 ${trackId} 不存在`);

  const rows = await prisma.angle.findMany({
    where: { trackId, scope: 'comic' },
    select: { id: true, theme: true, content: true },
  });
  const ids = rows
    .filter((r) => findOffIpWords(`${r.theme ?? ''}${r.content ?? ''}`).length > 0)
    .map((r) => r.id);

  if (ids.length === 0) {
    return { trackId, changed: 0, ids: [], message: '漫画切片里没有含 IP 外人物的选题' };
  }

  await prisma.angle.updateMany({ where: { id: { in: ids } }, data: { scope: 'article' } });
  logger.info({ trackId, changed: ids.length }, '含 IP 外人物选题退回文章专用');

  return {
    trackId,
    changed: ids.length,
    ids,
    message: `已把 ${ids.length} 条含 IP 外人物的选题退回文章专用（漫画线不再选到它们）`,
  };
}

export async function getAngle(id: number): Promise<AngleItem> {
  const a = await prisma.angle.findUnique({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  if (!a) throw new NotFoundError(`选题 ${id} 不存在`);
  return toItem(a);
}

/**
 * 手动新增一条选题。
 * seq 取当前赛道最大值 +1（保证排产按序消费），code 需规避 @@unique([trackId, code])。
 * S4-1：手动新增同样进 candidate（评分缺失=未评分，不默认高质量、不自动批准）。
 * S4-2：入库前统一判重（checkAngleDup）——L0/L1 命中返回 400（detail 带命中明细），
 * L2 历史标题命中放行并写 metaJson.dedupHits，随返回体 dedupWarnings 提示前端。
 */
export async function createAngle(
  input: AngleCreateInput,
): Promise<AngleItem & { dedupWarnings?: AngleDupHit[] }> {
  const track = await prisma.track.findUnique({ where: { id: input.trackId } });
  if (!track) throw new NotFoundError(`赛道 ${input.trackId} 不存在`);

  const content = clip(input.content, 500);
  if (!content) throw new BadRequestError('选题内容不能为空');
  const theme = clip(input.theme?.trim() || content.slice(0, 6), 64);
  const source = clip(input.source?.trim() || 'manual', 64);
  const scope = input.scope ?? 'article';

  const dup = await checkAngleDup({ content });
  if (dup.blocked) throw dupBlockError(dup);

  const agg = await prisma.angle.aggregate({
    where: { trackId: input.trackId },
    _max: { seq: true },
  });
  const seq = (agg._max.seq ?? 0) + 1;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = clip(`manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, 32);
    try {
      const created = await prisma.angle.create({
        // D1：手动新增进候选，与扩库同语义；未评分（不造评分数据）。
        // S4-2：有 L2 命中才写 metaJson.dedupHits（无命中保持 metaJson 空，不造数据）。
        data: {
          trackId: input.trackId,
          code,
          seq,
          theme,
          content,
          source,
          scope,
          status: 'candidate',
          ...(dup.warnHits.length > 0 ? { metaJson: packJson({ dedupHits: dup.warnHits }) ?? Prisma.DbNull } : {}),
        },
      });
      logger.info({ id: created.id, trackId: input.trackId, source, scope }, '手动新增选题（进入候选，待人工审核）');
      const item = await getAngle(created.id);
      return dup.warnHits.length > 0 ? { ...item, dedupWarnings: dup.warnHits } : item;
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new BadRequestError('选题编码冲突，请重试');
}

/**
 * 手动编辑选题。只允许改 theme / content / scope；消费态字段（used/usedBy/usedDate）
 * 与审核轮次 reviewRound 不接受外部改写。
 *
 * HF1（审核绕过修复）——**内容实质变更判定**：
 *   - theme（主题词）与 content（正文）承载选题的核心表达/内容实质（六维评分与人工审核
 *     都基于 theme+content），二者任一发生**实际变更**（与现值不同）时：
 *       ① 旧评分失效：metaJson.scores 置空并标注 scoreError，不给过期分数可乘之机；
 *       ② 若当前为 approved → 退回 candidate：修改后的内容必须重新评分并经人工审核
 *          才能再进正式池（TopicReview 审核记录与 reviewRound 原样保留，下一轮审核
 *          round 继续 +1）。
 *   - scope 是产线切片归属（管理元数据），只改 scope 不触发退回、不失效评分。
 *   - 与现值相同的「空编辑」不算变更，不退回、不失效。
 *   - candidate / needs_revision / rejected 的既有行为不变（只做①评分失效）。
 *
 * HF1-R1 增强：
 *   - 退回分支写入 metaJson.rescoreRequired=true（待重新评分标记）——reviewAngle 对
 *     带标记选题拒绝 approve，重新评分成功后才清除（见 rescoreAngle）。
 *   - 并发安全：写入一律走**带前置条件的原子 updateMany（CAS）**，条件含读取快照的
 *     content/theme（+ 回退分支限定 status='approved'、非回退分支限定非 approved）。
 *     审核/其他编辑并发提交后条件失配 → 409 冲突（刷新重试），绝不出现
 *     「正文已改但状态还是 approved」或「旧快照覆盖别人新写入」的中间态/丢更新。
 *
 * HF1-R2 增强（重评流程生命周期）：
 *   - 回退分支同时置 metaJson.rescoreWorkflow=true（HF1 重评流程身份）——该选题在
 *     **重新审核通过之前**受重评规则持续约束：每次实质修改都重新置 rescoreRequired=true，
 *     必须重新评分；评分成功只清当次待评分状态，流程身份保留；approve 成功才清流程身份。
 *   - 普通候选（无流程标记）的编辑永不误入流程。
 *
 * 原子性：正文写入、状态退回、评分失效、重评标记在同一事务内一次条件更新完成。
 *
 * S4-2 去重：正文实质变更时在同一事务内先统一判重（checkAngleDup，排除自身）——
 * L0/L1 命中 400 拒绝保存（detail 带命中明细）；L2 历史标题命中只提示，
 * 判重结果整体写入 metaJson.dedupHits（无命中写空数组清旧值；不碰 rescoreWorkflow /
 * rescoreRequired 等无关元数据）。仅改 theme/scope 不重算（判重对象是正文）。
 */
export async function updateAngle(
  id: number,
  patch: AngleUpdateInput,
): Promise<AngleItem & { reviewReset?: boolean; dedupWarnings?: AngleDupHit[] }> {
  return await prisma.$transaction(async (tx) => {
    const exists = await tx.angle.findUnique({
      where: { id },
      select: { id: true, theme: true, content: true, scope: true, status: true, metaJson: true },
    });
    if (!exists) throw new NotFoundError(`选题 ${id} 不存在`);

    const fields: { theme?: string; content?: string; scope?: string } = {};
    let themeChanged = false;
    let contentChanged = false;

    if (patch.theme !== undefined) {
      const t = clip(patch.theme, 64);
      fields.theme = t;
      themeChanged = t !== exists.theme;
    }
    if (patch.content !== undefined) {
      const c = clip(patch.content, 500);
      if (!c) throw new BadRequestError('选题内容不能为空');
      fields.content = c;
      contentChanged = c !== exists.content;
    }
    // 改切片 = 把这条选题划给另一条产线（给漫画线补角度最快的一条路）。管理元数据，不触发退回。
    if (patch.scope !== undefined) fields.scope = patch.scope;
    if (Object.keys(fields).length === 0) throw new BadRequestError('没有需要保存的改动');

    // S4-2：正文实质变更 → 事务内统一判重（排除自身）。L0/L1 拒；L2 记命中。
    let dedupWarn: AngleDupHit[] | undefined;
    if (contentChanged) {
      const dup = await checkAngleDup({ content: fields.content!, excludeId: id }, tx);
      if (dup.blocked) throw dupBlockError(dup);
      dedupWarn = dup.warnHits;
    }

    // CAS 基线 = 本次事务读到的正文/主题快照：写入时若已被并发修改则条件失配 → 冲突。
    const casBase = { id, content: exists.content, theme: exists.theme };

    let reviewReset = false;
    if (themeChanged || contentChanged) {
      // 内容实质变了旧评分即失效：留空标注「内容已修改，评分失效」，不给过期分数可乘之机。
      const prev = readScoreMeta(exists.metaJson);
      const invalidate = {
        ...(prev ?? {}),
        scores: null,
        scoreSource: 'none' as const,
        scoreModel: '',
        scoredAt: new Date().toISOString(),
        scoreError: '内容已修改，评分已失效（未重新评分）',
        // S4-2：正文变更的判重结果整体替换（含空数组清旧值，防旧命中残留误导）；
        // 仅 theme 变更不动 dedupHits（判重对象是正文，结果仍有效）。
        ...(contentChanged ? { dedupHits: dedupWarn ?? [] } : {}),
      };
      // R2：已进入 HF1 重评流程（rescoreWorkflow）的选题，在重新审核通过前每次实质修改
      // 都重新要求重评——rescoreRequired 重新置 true（评分成功只清当次，流程身份仍在）。
      const inWorkflow = prev?.rescoreWorkflow === true;

      // 分支一：写入时仍是 approved → 退回 candidate + 进入/延续 HF1 重评流程（置双标记）。
      // 用条件更新而非读值判定：并发审核刚把它改成 approved 时同样命中本分支，堵住竞态。
      const rollback = await tx.angle.updateMany({
        where: { ...casBase, status: 'approved' },
        data: {
          ...fields,
          status: 'candidate' as AngleStatus,
          metaJson: packJson({ ...invalidate, rescoreRequired: true, rescoreWorkflow: true }) ?? Prisma.DbNull,
        },
      });
      reviewReset = rollback.count > 0;

      if (!reviewReset) {
        // 分支二：非 approved → 状态不动（candidate/needs_revision/rejected 既有语义）。
        // R2：流程内的实质修改重置 rescoreRequired（必须重评）；普通候选只失效评分不误标。
        const plainMeta = inWorkflow
          ? { ...invalidate, rescoreRequired: true, rescoreWorkflow: true }
          : invalidate;
        const plain = await tx.angle.updateMany({
          where: { ...casBase, status: { in: ['candidate', 'needs_revision', 'rejected'] } },
          data: { ...fields, metaJson: packJson(plainMeta) ?? Prisma.DbNull },
        });
        if (plain.count === 0) {
          throw new ConflictError('该选题刚刚被其他人修改或审核过，请刷新后重试');
        }
      }
    } else {
      // 非实质变更（仅 scope / 同值重存）：仍按读取快照 CAS，防与并发编辑互相覆盖。
      const r = await tx.angle.updateMany({ where: casBase, data: fields });
      if (r.count === 0) {
        throw new ConflictError('该选题刚刚被其他人修改或审核过，请刷新后重试');
      }
    }

    const row = await tx.angle.findUnique({
      where: { id },
      include: { _count: { select: { articles: true } } },
    });
    if (!row) throw new NotFoundError(`选题 ${id} 不存在`);
    return {
      ...toItem(row),
      reviewReset,
      ...(dedupWarn && dedupWarn.length > 0 ? { dedupWarnings: dedupWarn } : {}),
    };
  });
}

export interface RescoreResult extends AngleItem {
  /** 本轮是否取得完整有效六维评分（false=调用失败/缺失/不完整，重评标记保留）。 */
  rescored: boolean;
}

/**
 * 对已有选题重新评分（R1：HF1 退回候选的硬门禁配套入口）。
 *
 * - 复用六维评分链路（scoreAngleCandidates，D5 复用 write 角色；测试可注入 Mock）。
 * - **成功判定**：normalizeScores 校验通过的完整六维（scores 非 null）才算成功——
 *   成功则写入新评分并清除 metaJson.rescoreRequired 标记（同一 metaJson 写入原子完成，
 *   等效于「当前评分对当前内容有效」）。R2：流程身份 rescoreWorkflow 保留（评分只清当次
 *   待评分状态，重新审核通过前流程约束持续）。
 * - **失败语义**：调用失败/评分缺失/任一维越界 → scores=null + scoreError 落库，
 *   rescoreRequired 标记**不清除**（无标记也不新造），仍不可 approve。
 * - CAS：评分期间正文/主题被并发修改 → 评分结果作废（409 冲突，刷新后重评），
 *   绝不把旧内容的分写到新内容上。
 */
export async function rescoreAngle(
  id: number,
  opts: { score?: CompleteFn } = {},
): Promise<RescoreResult> {
  const a = await prisma.angle.findUnique({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  if (!a) throw new NotFoundError(`选题 ${id} 不存在`);
  const track = await prisma.track.findUnique({ where: { id: a.trackId }, select: { id: true, name: true } });
  if (!track) throw new NotFoundError(`赛道 ${a.trackId} 不存在`);

  let rec: ScoredCandidate | undefined;
  let callError = '';
  try {
    const map = await scoreAngleCandidates(
      track.name,
      [{ id: 1, theme: a.theme, content: a.content }],
      opts.score,
    );
    rec = map.get(1);
  } catch (e) {
    // 典型：write 角色未绑定/停用/缺 Key（assertRoleUsable 抛出）——按评分失败处理。
    callError = e instanceof Error ? e.message : String(e);
    logger.warn({ id, err: callError }, '重新评分调用失败');
  }

  const rescored = Boolean(rec?.scores);
  const prev = readScoreMeta(a.metaJson);
  // R2：流程身份（rescoreWorkflow）评分成功/失败都保留——只有人工 approve 才结束流程。
  const keepWorkflow = prev?.rescoreWorkflow === true ? { rescoreWorkflow: true } : {};
  const meta: AngleScoreMeta = rescored
    ? {
        ...toScoreMeta(rec, opts.score ? 'mock-write' : 'write-role'),
        // 成功只清「待重新评分」（当次），不清流程身份
        rescoreRequired: false,
        ...keepWorkflow,
      }
    : {
        scores: null,
        scoreSource: 'none',
        scoreModel: '',
        scoredAt: new Date().toISOString(),
        riskHits: prev?.riskHits ?? [],
        suggestion: prev?.suggestion ?? '',
        rationale: prev?.rationale ?? '',
        scoreError: callError || rec?.scoreError || '重新评分失败（评分缺失或不完整）',
        // 失败不清标记：原样保留（无标记不新造——普通候选不强制重评门禁）
        ...(prev?.rescoreRequired === true ? { rescoreRequired: true } : {}),
        ...keepWorkflow,
      };

  const cas = await prisma.angle.updateMany({
    where: { id, content: a.content, theme: a.theme },
    data: { metaJson: packJson(meta) ?? Prisma.DbNull },
  });
  if (cas.count === 0) {
    throw new ConflictError('该选题内容刚刚被修改，本次评分结果已作废，请刷新后重新评分');
  }

  logger.info({ id, rescored, flag: meta.rescoreRequired === true }, '选题重新评分');
  const row = await prisma.angle.findUnique({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  if (!row) throw new NotFoundError(`选题 ${id} 不存在`);
  return { ...toItem(row), rescored };
}

/**
 * 删除选题。
 * 先统计关联文章数，再在同一事务里显式解绑文章 + 删除选题（不依赖 SetNull 的模拟行为）。
 * 删「已用」选题是允许的：文章正文保留，只解除关联，前端必须先给用户强提示。
 */
export async function deleteAngle(id: number): Promise<AngleDeleteResult> {
  const a = await prisma.angle.findUnique({
    where: { id },
    select: { id: true, trackId: true, theme: true, used: true },
  });
  if (!a) throw new NotFoundError(`选题 ${id} 不存在`);

  const unlinkedArticles = await prisma.article.count({ where: { angleId: id } });

  await prisma.$transaction([
    prisma.article.updateMany({ where: { angleId: id }, data: { angleId: null } }),
    prisma.angle.delete({ where: { id } }),
  ]);

  const message =
    `已删除选题「${a.theme}」` +
    (unlinkedArticles > 0 ? `，已解除 ${unlinkedArticles} 篇文章的选题关联，正文不受影响` : '');

  logger.info({ id, trackId: a.trackId, used: a.used, unlinkedArticles }, '删除选题');

  return {
    ok: true,
    id,
    trackId: a.trackId,
    theme: a.theme,
    used: a.used,
    unlinkedArticles,
    message,
  };
}
