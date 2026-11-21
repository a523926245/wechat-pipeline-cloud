/**
 * 漫画脚本服务（comic_script 角色）。
 *
 * 把一个选题角度写成 N 个「插图单元」，每单元包含：
 *   - headline  论点标题（12-24 字观点句，进金句卡）
 *   - elaboration 论点阐释（2-3 句，进金句卡副文）
 *   - scene     画面描述（中文，仅内部用）
 *   - characters 出场角色 key（映射到模板的英文外观锁定短语）
 *   - bubble    气泡台词（≤10 字、无句号——句号渲染不稳定）
 *   - bubblePos 气泡方位（如 右上方）
 *   - spatial   空间关系英文短语（谁左谁右、谁高谁矮、气泡归属）
 *
 * 模型只负责「内容创意」，最终英文提示词由本服务**确定性拼装**：
 * 风格前缀 + 外观锁定 + 场景 + 气泡段（gen_image.py 的 BUBBLE_CLAUSE 同款）
 * + 防复制条款（48 图实测教训）。模型自由写 HTML/提示词都会引入不可控错字。
 *
 * 模板资产：config/comic_templates.json（styles/characters/负面词/叙事链）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Angle, Track } from '@prisma/client';

import { BadRequestError } from '../../errors.ts';
import { CONFIG_DIR } from '../../config.ts';
import { logger } from '../../logger.ts';
import { assertRoleUsable, chatComplete } from '../llm.ts';

// ── 模板加载 ──

export interface ComicTemplates {
  styles: Record<string, string>;
  defaultStyle: string;
  characters: Record<string, string>;
  /** key → 中文称谓（如 father→爸爸）。用于给模型下「人物白名单」，改提示词必须用中文说人话。 */
  characterLabels?: Record<string, string>;
  /** IP 外角色词表（爷爷/奶奶/老师…）：选题与脚本都拿它做约束与体检。 */
  offIpWords?: string[];
  bubbleClause: string;
  excludeClause: string;
  /** 场景旁白禁令：紧跟 Scene 之后。防「旁白被画成第二个大气泡」高频穿帮（可缺省，代码内置兜底）。 */
  sceneClause?: string;
  negativePrompt: string;
  narrativeChains: Record<string, string>;
  defaultChain: string;
  /** 金句卡版式参数（services/imaging/quote-card.ts 消费）。 */
  quoteCard: {
    width: number;
    height: number;
    background: string;
    titleColor: string;
    titleSize: number;
    titleWeight: number;
    descColor: string;
    descSize: number;
    titleDescGap: number;
    fontFamily: string;
  };
}

// 进程级缓存：comic_templates.json 是随仓库发布的只读配置，运行期不改写、无热重载契约
// （`npm run dev` 的 --watch 触发整进程重启，天然清空本缓存）。改配置需重启服务。
let cached: ComicTemplates | null = null;

export function loadComicTemplates(): ComicTemplates {
  if (cached) return cached;
  const p = join(CONFIG_DIR, 'comic_templates.json');
  if (!existsSync(p)) {
    throw new BadRequestError(`缺少漫画模板配置 ${p}（应随仓库提供）`);
  }
  cached = JSON.parse(readFileSync(p, 'utf8')) as ComicTemplates;
  return cached;
}

/**
 * IP 角色白名单的中文说明，喂给模型（选题扩库与脚本生成共用同一份）。
 * 例：「爸爸(father)、妈妈(mother)、12岁哥哥(son12)、9岁弟弟(son9)」。
 */
export function ipCharacterBrief(tpl: ComicTemplates = loadComicTemplates()): string {
  return Object.keys(tpl.characters)
    .map((k) => (tpl.characterLabels?.[k] ? `${tpl.characterLabels[k]}(${k})` : k))
    .join('、');
}

/**
 * 扫出文本里出现的 IP 外角色词（去重，按词表顺序）。
 * 用途：选题库体检（标记「含 IP 外人物」）+ 脚本产出后的自检。
 */
export function findOffIpWords(text: string, tpl: ComicTemplates = loadComicTemplates()): string[] {
  const t = text ?? '';
  return (tpl.offIpWords ?? []).filter((w) => w && t.includes(w));
}

// ── 脚本结构 ──

export interface ComicUnit {
  seq: number;
  /** 论点标题（金句卡主文） */
  headline: string;
  /** 论点阐释（金句卡副文） */
  elaboration: string;
  /** 画面描述（中文，内部用） */
  scene: string;
  /** 出场角色 key 列表（templates.characters 的键） */
  characters: string[];
  /** 气泡台词 */
  bubble: string;
  bubblePos: string;
  /** 空间关系英文短语（谁左谁右、谁高谁矮、气泡归属） */
  spatial: string;
  /** 最终英文提示词（确定性拼装产物，直接传生图模型） */
  prompt: string;
}

export interface ComicScript {
  title: string;
  digest: string;
  styleKey: string;
  units: ComicUnit[];
}

export interface ScriptOptions {
  unitCount?: number;
  /** @deprecated 风格已硬锁为模板 defaultStyle（soft_watercolor），此字段不再影响结果。 */
  styleKey?: string;
  chain?: string;
  /** 附加要求（用户自由指令） */
  extra?: string;
}

interface RawUnit {
  headline?: unknown;
  elaboration?: unknown;
  scene?: unknown;
  characters?: unknown;
  bubble?: unknown;
  bubblePos?: unknown;
  spatial?: unknown;
}

interface RawScript {
  title?: unknown;
  digest?: unknown;
  units?: unknown;
}

/** 创意方向（Step 1 产物）：三组差异化方向，程序自动采纳 recommended 那组。 */
export interface CreativeDirection {
  /** 切入维度（6 维度之一） */
  dimension: string;
  /** 方向标题（简短） */
  title: string;
  /** 核心立意（一句话） */
  thesis: string;
  /** 候选标题（≥2 式） */
  candidateTitles: string[];
  /** 该方向若被选中，末单元升华金句候选 */
  closingLine: string;
  /** 模型标记的推荐组 */
  recommended?: boolean;
  /** 推荐理由 */
  recommendReason?: string;
}

interface RawDirection {
  dimension?: unknown;
  title?: unknown;
  thesis?: unknown;
  candidateTitles?: unknown;
  closingLine?: unknown;
  recommended?: unknown;
  recommendReason?: unknown;
}

interface RawDirections {
  directions?: unknown;
}

// ── 提示词 ──

/**
 * 创意层知识块（压缩自 skill quote-comic-illustrator/templates/creative.md，改技能后需重新同步）。
 * 4 段合计控制在 4000 字以内，超出优先压缩示例。
 */
function buildCreativeKnowledge(): string {
  return [
    '创意层知识（来自「漫话」栏目创意规范，务必遵守）：',
    '',
    '【标题公式库（11 式，产出 headline 时套用，每单元换用不同式）】',
    '因果断言式 {现象}，都是{原因}；否定转折式 决定{结果}的，从来不是{A}，而是{B}；',
    '越A越B式 {行为}越{程度}，{后果}越{严重}；渴望式 孩子最渴望听到的，不是{A}，不是{B}，而是这{数量}句话；',
    '数量清单式 孩子的这{数量}个{节点}，一个都不能错过；俗语反用式 "{俗语}"，这几个行为会把孩子养成"{结果}"；',
    '代价警告式 别等{后果}才后悔，{行为}正在毁掉孩子；身份戳痛式 {某类父母}，正在养出{某类孩子}；',
    '原来式 原来，{观点}是{动词短语}出来的；身份自嘲式 {身份}，我居然{行为}；清单自测式 {范围}的{数量}个{项}，你占了几个？',
    '标题红线：长度 12-24 字；必须有冲突感或信息缺口；禁止平铺直叙（如「如何教育孩子」）；禁止标题党。',
    '',
    '【6 切入维度（方向立意须落在不同维度，禁止同义改写）】',
    '反常识（打破默认认知）/ 后果警示（强调不改变的代价）/ 情感共鸣（戳中内疚心疼）/',
    '方法转向（给出替代做法）/ 身份代入（让父母照镜子）/ 时间窗口（强调关键期）。',
    '',
    '【两行反转句式（签名手法，本质是否定转折式的排版变体）】',
    '模板：`{现象}，不是{A}，而是{B}`（如「看到帅哥，不是迷恋，而是自动切换老母亲视角」）。',
    '契约安全：源文本必须单行书写（逗号/分号分段），禁止在标题行后手工换行。',
    '',
    '【金句 5 型（末单元选型参考，相邻单元避免连续同型）】',
    '断言型 {观点}是{X}出来的；对比型 不是{A}，而是{B}；递进型 句1→句2→句3 逐级升维；',
    '反转型 不是{贬义判断}，而是{正面翻案}；画面型 用可截图的具体画面句承载观点（仍是观点，非场景描写）。',
    '以上句式为结构示范，产出时只化用结构，禁止照抄例句。',
    '',
    '【末单元金句三标准（创作顺序上先写定末句，再倒推标题链）】',
    '可截图转发、可单独做文章标题、可直接做推文摘要。',
    '',
    '【论点阐释规则】2-3 句，解释「为什么这个观点成立」，不是复述画面；可共情可扎心，不过度煽情。',
  ].join('\n');
}

export function buildSystemPrompt(tpl: ComicTemplates, unitCount: number, chain: string): string {
  const keys = Object.keys(tpl.characters).join('","');
  const brief = ipCharacterBrief(tpl);
  const offWords = (tpl.offIpWords ?? []).slice(0, 12).join('/');
  return [
    '你是公众号「漫话」栏目策划。请把给定的选题角度创作成一篇漫画的分镜脚本。',
    '你只输出 JSON，不输出任何解释、前言或 markdown 代码块以外的内容。',
    '',
    `输出格式（严格 JSON 对象）：`,
    `{"title":"主标题（12-24字，有冲突感或信息缺口）","digest":"40字以内的摘要","units":[`,
    `  {"headline":"论点标题","elaboration":"论点阐释","scene":"画面描述","characters":["mother","son9"],"bubble":"台词","bubblePos":"右上方","spatial":"MOTHER stands on the LEFT, SON on the RIGHT, SON is SHORTER than MOTHER; the ONLY speech bubble emerges from near the MOTHER's head (NOT from the SON)"}`,
    `]}`,
    '',
    `共 ${unitCount} 个单元，叙事链要求：${tpl.narrativeChains[chain] ?? tpl.narrativeChains[tpl.defaultChain]}`,
    '',
    buildCreativeKnowledge(),
    '',
    '硬性要求：',
    '1. headline 是观点金句（12-24 字），不是画面描述；各单元 headline 按叙事链递进，末句值得截图转发。',
    '2. elaboration 2-3 句，解释观点为什么成立，可以共情但不过度煽情。',
    '3. bubble 是画中人**说出口**的话（不超过 10 个字，禁止句号，逗号可用）；headline 与画面解耦。',
    '   气泡里禁止写内心独白、旁白、心理描写（如「脑海中闪现…」「他想起…」）——画中人嘴只会说短句；',
    '   气泡里禁止出现任何英文或角色代号（如 FATHER、SON9），必须写成这个角色自然说出的中文。',
    `4. 人物白名单：本 IP 只有 ${brief} 四个人，characters 只能从 ["${keys}"] 里选，按需出场（2-3 人最佳），禁止无关人物。`,
    `5. IP 一致性（最容易翻车，务必做到）：选题里若出现白名单之外的亲属或外人（如 ${offWords} 等），`,
    '   必须把它们**改写成白名单内的角色**，并把场景、headline、bubble 一起改到同一个情境里；',
    '   绝不允许「标题/台词里说的是奶奶，画面里画的却是妈妈」。',
    '6. 每个单元 1 条气泡；spatial 必须写明人物左右、身高关系、气泡从谁头顶出（英文）。',
    '   同一格若同时出现 son12 与 son9，spatial 必须写清两人身高差与年龄差，避免被画成双胞胎或同一人出现两次。',
    '7. bubble 必须与同单元的 scene 是同一情境（不能一句在说吃饭、画面在写作业）。',
    '8. 禁止政治/低俗/侵权内容，禁止真实人物肖像。',
  ].join('\n');
}

export function buildUserPrompt(
  angle: Angle,
  track: Track,
  opts: ScriptOptions,
  tpl: ComicTemplates,
  direction?: CreativeDirection,
): string {
  const lines = [`赛道：${track.name}`, `选题主题：${angle.theme}`, `选题角度：${angle.content}`];
  if (direction) {
    lines.push(
      '',
      '已选定的创意方向（以此为准，标题链与末单元金句须围绕它展开）：',
      `切入维度：${direction.dimension}`,
      `方向标题：${direction.title}`,
      `核心立意：${direction.thesis}`,
      direction.candidateTitles.length ? `候选标题：${direction.candidateTitles.join(' / ')}` : '',
      direction.closingLine ? `末单元升华金句候选：${direction.closingLine}` : '',
    );
  }
  if (opts.extra?.trim()) lines.push(`额外要求（以此为准）：${opts.extra.trim()}`);
  // 把人物约束贴近选题（离模型输出最近的位置再强调一次）：选题里带外人时先改写再创作
  lines.push('', `人物白名单：${ipCharacterBrief(tpl)}（只能出现这四个人）`);
  const hits = findOffIpWords(`${angle.theme ?? ''}${angle.content ?? ''}`, tpl);
  if (hits.length > 0) {
    lines.push(
      `注意：本选题出现了白名单外的角色「${hits.join('、')}」，请把它们改写成白名单内的角色，` +
        '并让标题、画面描述、气泡台词指向同一个改写后的情境。',
    );
  }
  lines.push('', '请输出脚本 JSON。');
  return lines.join('\n');
}

/** 方向阶段 system prompt（skill Step 1：3 组差异化方向 + 推荐 1 组）。 */
export function buildDirectionSystemPrompt(angle: Angle, track: Track, opts: ScriptOptions): string {
  const extra = opts.extra?.trim() ? [`额外要求（以此为准）：${opts.extra.trim()}`] : [];
  return [
    '你是公众号「漫话」栏目的创意策划。请为给定选题产出 3 组差异化创意方向。',
    '你只输出 JSON，不输出任何解释或 markdown 代码块以外的内容。',
    '',
    '输出格式（严格 JSON 对象）：',
    '{"directions":[',
    '  {"dimension":"切入维度","title":"方向标题","thesis":"核心立意一句话","candidateTitles":["候选标题1","候选标题2","候选标题3"],"closingLine":"末单元升华金句候选","recommended":true,"recommendReason":"推荐理由（仅推荐组填）"},',
    ']}',
    '',
    buildCreativeKnowledge(),
    '',
    '硬性要求：',
    `1. 恰好 3 组方向，每组切入维度必须不同（6 维度：反常识/后果警示/情感共鸣/方法转向/身份代入/时间窗口），立意、角度、情绪都要拉开，禁止同义改写。`,
    '2. candidateTitles 每组给 3 个候选标题，命中 ≥2 种不同标题公式，长度 12-24 字，必须有冲突感或信息缺口。',
    '3. 只能在 1 组上标 "recommended": true，并给 recommendReason（推荐维度、与主题贴合度、情绪落点各说一句）。',
    '4. 禁止政治/低俗/侵权内容，禁止真实人物肖像。',
    '',
    `赛道：${track.name}`,
    `选题主题：${angle.theme}`,
    `选题角度：${angle.content}`,
    ...extra,
  ].join('\n');
}

function extractJsonObjectRaw(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new BadRequestError(`创意方向模型未返回 JSON 对象，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new BadRequestError(`创意方向 JSON 解析失败，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
}

/**
 * 3 组创意方向 + 自动采纳推荐组（skill SKILL.md Step 1）。
 * 模型未标记推荐 / 标记无效 → 取第一个并 logger.warn（不报错中断、不暴露选择给 API/UI）。
 */
export async function generateCreativeDirections(
  angle: Angle,
  track: Track,
  opts: ScriptOptions = {},
): Promise<{ directions: CreativeDirection[]; selected: CreativeDirection; selectedIndex: number }> {
  const model = await assertRoleUsable('comic_script');
  const raw = await chatComplete(
    model,
    [{ role: 'user', content: buildDirectionSystemPrompt(angle, track, opts) }],
    { temperature: 0.9, maxTokens: 2000 },
  );

  const obj = extractJsonObjectRaw(raw);
  const rawDirs = Array.isArray(obj.directions) ? (obj.directions as RawDirection[]) : [];
  const directions: CreativeDirection[] = rawDirs.slice(0, 3).map((d) => ({
    dimension: clip(typeof d.dimension === 'string' ? d.dimension : '', 40),
    title: clip(typeof d.title === 'string' ? d.title : '', 60),
    thesis: clip(typeof d.thesis === 'string' ? d.thesis : '', 200),
    candidateTitles: Array.isArray(d.candidateTitles)
      ? (d.candidateTitles as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 3)
      : [],
    closingLine: clip(typeof d.closingLine === 'string' ? d.closingLine : '', 80),
    recommended: d.recommended === true,
    recommendReason: typeof d.recommendReason === 'string' ? clip(d.recommendReason, 200) : undefined,
  }));

  if (directions.length === 0) {
    throw new BadRequestError(`创意方向模型未返回任何方向，原始输出前 200 字：${raw.slice(0, 200)}`);
  }

  const marked = directions.findIndex((d) => d.recommended === true);
  let selectedIndex = marked;
  if (marked < 0) {
    selectedIndex = 0;
    logger.warn({ raw: raw.slice(0, 200) }, '创意方向模型未标记推荐组，回落到第 1 组');
  }

  const selected = directions[selectedIndex] as CreativeDirection;
  return { directions, selected, selectedIndex };
}

/** 从模型输出里抠出 JSON 对象（兼容 ```json 围栏与客套话）。 */
function extractJsonObject(raw: string): RawScript {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new BadRequestError(`漫画脚本模型未返回 JSON 对象，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawScript;
  } catch {
    throw new BadRequestError(`漫画脚本 JSON 解析失败，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
}

function clip(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * 气泡护栏（确定性，不信任模型）：
 *  1) 英文角色代号（FATHER/SON9…）替换成中文称谓——这些词若烧进图里就是明晃晃的穿帮；
 *  2) 去句号（渲染不稳定）；
 *  3) 限长（内心独白式的长旁白即便漏过来也只会留下前 20 字，重画时可手动改词）。
 */
function sanitizeBubble(bubble: unknown): string {
  let b = typeof bubble === 'string' ? bubble.trim() : '';
  const tpl = loadComicTemplates();
  for (const [k, label] of Object.entries(tpl.characterLabels ?? {})) {
    b = b.replaceAll(new RegExp(k, 'gi'), label);
  }
  b = b.replace(/[。.]+$/g, '');
  return clip(b, 20);
}

/** templates 缺 sceneClause 字段时的兜底（旧配置文件兼容）。 */
const FALLBACK_SCENE_CLAUSE =
  'Scene is composition reference only: NEVER write it into the image as text, caption, sign or an extra speech bubble; the only text allowed in the image is the quoted bubble line below.';

/** 确定性拼装单格最终提示词。 */
function buildUnitPrompt(tpl: ComicTemplates, styleKey: string, u: {
  characters: string[];
  scene: string;
  spatial: string;
  bubble: string;
  bubblePos: string;
}): string {
  const style = tpl.styles[styleKey] ?? tpl.styles[tpl.defaultStyle] ?? Object.values(tpl.styles)[0] ?? '';
  const n = Math.max(1, u.characters.length);
  const prefix = style.replaceAll('{n}', String(n));
  const locks = u.characters
    .map((k) => tpl.characters[k])
    .filter((s): s is string => Boolean(s))
    .join('; ');
  const parts = [
    prefix,
    locks ? `Characters: ${locks}.` : '',
    // 人数确定性条款：模型把同一角色画两次（如两个小儿子）是高频穿帮，显式钉死人数与「每人只出现一次」
    `Exactly ${n} character${n > 1 ? 's' : ''} from the list appear in the image, each appearing exactly once; never draw the same character twice, and no extra people beyond the list.`,
    u.spatial ? `Spatial: ${u.spatial}.` : '',
    // Scene 紧挨气泡指令，模型倾向把整段旁白也画成第二个大气泡（错字+违和），必须显式钉死「旁白不入画」
    `Scene: ${clip(u.scene, 400)}. ${tpl.sceneClause ?? FALLBACK_SCENE_CLAUSE}`,
    u.bubble
      ? `画面${u.bubblePos || '右上方'}有一个圆润的白色手绘对话气泡，气泡尾巴指向说话者，气泡内只有一行黑色手写风格中文字：「${u.bubble}」。文字清晰、居中。${tpl.excludeClause}`
      : '',
    u.bubble ? tpl.bubbleClause : '',
  ];
  return parts.filter(Boolean).join(' ');
}

// ── 主入口 ─—

/**
 * 生成漫画脚本。模型不可用时抛 BadRequestError（调用方决定是否回退）。
 */
export async function generateComicScript(
  angle: Angle,
  track: Track,
  opts: ScriptOptions = {},
): Promise<ComicScript> {
  const tpl = loadComicTemplates();
  const unitCount = Math.min(Math.max(Math.floor(opts.unitCount ?? 6), 4), 9);
  const styleKey = tpl.defaultStyle;
  const chain = opts.chain && tpl.narrativeChains[opts.chain] ? opts.chain : tpl.defaultChain;

  const { selected } = await generateCreativeDirections(angle, track, opts);

  const model = await assertRoleUsable('comic_script');
  const raw = await chatComplete(
    model,
    [
      { role: 'system', content: buildSystemPrompt(tpl, unitCount, chain) },
      { role: 'user', content: buildUserPrompt(angle, track, opts, tpl, selected) },
    ],
    { temperature: 0.85, maxTokens: 4000 },
  );

  const obj = extractJsonObject(raw);
  const rawUnits = Array.isArray(obj.units) ? (obj.units as RawUnit[]) : [];
  if (rawUnits.length < 4) {
    throw new BadRequestError(`漫画脚本单元数不足（${rawUnits.length}），原始输出前 200 字：${raw.slice(0, 200)}`);
  }

  const units: ComicUnit[] = rawUnits.slice(0, 9).map((u, i) => {
    const characters = Array.isArray(u.characters)
      ? (u.characters as unknown[]).filter((k): k is string => typeof k === 'string' && k in tpl.characters)
      : [];
    const bubble = sanitizeBubble(u.bubble);
    const unit = {
      seq: i + 1,
      headline: clip(typeof u.headline === 'string' ? u.headline : '', 40),
      elaboration: clip(typeof u.elaboration === 'string' ? u.elaboration : '', 200),
      scene: clip(typeof u.scene === 'string' ? u.scene : '', 400),
      characters,
      bubble,
      bubblePos: clip(typeof u.bubblePos === 'string' ? u.bubblePos : '右上方', 12),
      spatial: clip(typeof u.spatial === 'string' ? u.spatial : '', 500),
    };
    return { ...unit, prompt: buildUnitPrompt(tpl, styleKey, unit) };
  });

  // 内容硬校验：headline 与气泡必须有值（金句卡与生图都依赖它们）
  for (const u of units) {
    if (!u.headline) throw new BadRequestError(`漫画脚本第 ${u.seq} 单元缺少论点标题`);
    if (!u.prompt) throw new BadRequestError(`漫画脚本第 ${u.seq} 单元无法拼装生图提示词`);
  }

  return {
    title: clip(typeof obj.title === 'string' ? obj.title : (units[0]?.headline ?? ''), 64),
    digest: clip(typeof obj.digest === 'string' ? obj.digest : '', 120),
    styleKey,
    units,
  };
}
