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
import { BadRequestError, NotFoundError } from '../errors.ts';
import { logger } from '../logger.ts';
import { assertRoleUsable, chatComplete } from './llm.ts';
import { findOffIpWords, ipCharacterBrief, loadComicTemplates } from './comic/script.ts';
import type { AngleScope } from './pipeline.ts';

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
 * 归一化：去掉所有空白，全角标点转半角，统一小写。
 * 用于判断两条选题是否实质相同——模型很容易换个标点或加个空格就"洗稿"成功。
 */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[“”「」『』]/g, '"')
    .replace(/[，、；]/g, ',')
    .replace(/[。．]/g, '.')
    .toLowerCase();
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max);
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

function buildMessages(
  trackName: string,
  count: number,
  existing: string[],
  seed: string | undefined,
  scope: AngleScope,
): { role: 'system' | 'user'; content: string }[] {
  const avoid =
    existing.length > 0
      ? `\n\n已有选题（必须避开，不得与其中任何一条重复或高度相似）：\n${existing
          .map((c, i) => `${i + 1}. ${c}`)
          .join('\n')}`
      : '\n\n该赛道目前还没有任何选题，请从零开始给出第一批。';

  const seedPart = seed?.trim() ? `\n\n本批希望侧重这些方向（供参考，不必逐条对应）：${seed.trim()}` : '';

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
        avoid +
        seedPart +
        `\n\n用途要求：${scopeBrief(scope)}` +
        `\n\n请为这个赛道创作 ${count} 条全新的选题角度，严格以 JSON 数组输出，格式为：` +
        `[{"theme":"2~6 字主题词","content":"一条 20~60 字的选题，有具体画面感，暗含冲突或反差"}]` +
        `\n\n硬性要求：` +
        `\n1. 每条 content 一句话，20~60 字，要有可感知的具体场景（人物、动作、处境），并暗含冲突、反差或两难，不要写成空泛的道理` +
        `\n2. 各条之间角度必须不同，不得换汤不换药` +
        `\n3. 严禁与上面「已有选题」重复或高度相似` +
        `\n4. 只输出这 ${count} 条，不要多也不要少，不要编号以外的内容`,
    },
  ];
}

/**
 * 为赛道扩充选题角度池。
 *
 * @param trackId 赛道 id
 * @param count   希望新增的条数（1~100）
 * @param seed    可选的维度种子，用来引导本批选题的方向
 * @param scope   产出的角度切片（默认 article）。**给漫画产线扩库必须传 comic 或 shared**，
 *                否则产出的选题只挂在文章切片上，漫画产线一粒都吃不到。
 */
export async function expandAnglesForTrack(
  trackId: number,
  count: number,
  seed?: string,
  scope: AngleScope = 'article',
): Promise<ExpandResult> {
  const want = Math.min(Math.max(Math.floor(count) || 20, 1), MAX_COUNT);

  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) throw new NotFoundError(`赛道 ${trackId} 不存在`);

  // 未绑定 / 停用 / 能力不符 / 缺 Key 都由统一判定给出可读的 400 文案
  const model = await assertRoleUsable('expand_angles');

  const visScopes = visibleScopes(scope);

  // 去重集合取**全赛道**：跨切片也不该出现字面重复的选题。
  const all = await prisma.angle.findMany({
    where: { trackId },
    orderBy: { seq: 'desc' },
    take: 500,
    select: { content: true, seq: true, scope: true },
  });
  const seen = new Set(all.map((a) => normalize(a.content)));
  const maxSeq = all.reduce((m, a) => (a.seq > m ? a.seq : m), 0);

  // 喂给模型的「必须避开」只取本产线看得到的切片，免得被另一种口味的选题带偏。
  const existing = all
    .filter((a) => visScopes.includes(a.scope as AngleScope))
    .slice(0, FEEDBACK_LIMIT)
    .map((a) => a.content);

  const raw = await chatComplete(
    model,
    buildMessages(track.name, want, existing, seed, scope),
    { temperature: 0.9, maxTokens: 4000 },
  );

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
  }[] = [];
  let skippedDuplicate = 0;

  for (const c of candidates) {
    const key = normalize(c.content);
    if (!key || seen.has(key)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(key);
    rows.push({
      trackId,
      code: clip(`llm-${stamp}-${rows.length}`, 32),
      seq: maxSeq + rows.length + 1,
      theme: clip(c.theme || c.content.slice(0, 6), 64),
      content: clip(c.content, 500),
      source: 'llm-expand',
      scope,
    });
  }

  if (rows.length > 0) {
    await prisma.angle.createMany({ data: rows });
  }

  const [poolTotal, poolUnused, scopeUnused] = await Promise.all([
    prisma.angle.count({ where: { trackId } }),
    prisma.angle.count({ where: { trackId, used: false } }),
    prisma.angle.count({ where: { trackId, used: false, scope: { in: [...visScopes] } } }),
  ]);

  logger.info(
    { trackId, track: track.name, model: model.name, scope, requested: want, added: rows.length, skippedDuplicate },
    '选题扩库完成',
  );

  return {
    trackId,
    track: track.name,
    requested: want,
    added: rows.length,
    skippedDuplicate,
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
    data: { used: false, usedBy: '', usedDate: null },
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
  source: string;
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
  /** 按切片过滤；不传 = 全部。 */
  scope?: AngleScope;
  /** 只看含 IP 外角色的选题（漫画产线治理用）。 */
  offIp?: boolean;
  keyword?: string;
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
  used: boolean;
  usedBy: string;
  usedDate: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { articles: number };
};

type AngleWhere = NonNullable<NonNullable<Parameters<typeof prisma.angle.findMany>[0]>['where']>;

function toItem(a: AngleRow): AngleItem {
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
    source: a.source,
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
 */
export async function listAngles(
  p: AngleListParams,
): Promise<{ total: number; limit: number; offset: number; items: AngleItem[] }> {
  const limit = Math.min(Math.max(Math.floor(p.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Math.floor(p.offset ?? 0) || 0, 0);
  const kw = p.keyword?.trim() ?? '';
  const used = p.used ?? 'all';

  const where: AngleWhere = { trackId: p.trackId };
  if (used !== 'all') where.used = used === 'used';
  if (p.scope) where.scope = p.scope;
  if (kw) where.OR = [{ content: { contains: kw } }, { theme: { contains: kw } }];

  // offIp 是「词表命中」判定，没法下推到 SQL（SQLite 无全文索引），
  // 但赛道级数据量是百条量级，内存过滤 + 分页完全够用。
  if (p.offIp) {
    const all = await prisma.angle.findMany({
      where,
      orderBy: [{ seq: 'asc' }],
      include: { _count: { select: { articles: true } } },
    });
    const hit = all.filter((a) => findOffIpWords(`${a.theme ?? ''}${a.content ?? ''}`).length > 0);
    return { total: hit.length, limit, offset, items: hit.slice(offset, offset + limit).map(toItem) };
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
 */
export async function createAngle(input: AngleCreateInput): Promise<AngleItem> {
  const track = await prisma.track.findUnique({ where: { id: input.trackId } });
  if (!track) throw new NotFoundError(`赛道 ${input.trackId} 不存在`);

  const content = clip(input.content, 500);
  if (!content) throw new BadRequestError('选题内容不能为空');
  const theme = clip(input.theme?.trim() || content.slice(0, 6), 64);
  const source = clip(input.source?.trim() || 'manual', 64);
  const scope = input.scope ?? 'article';

  const agg = await prisma.angle.aggregate({
    where: { trackId: input.trackId },
    _max: { seq: true },
  });
  const seq = (agg._max.seq ?? 0) + 1;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = clip(`manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, 32);
    try {
      const created = await prisma.angle.create({
        data: { trackId: input.trackId, code, seq, theme, content, source, scope },
      });
      logger.info({ id: created.id, trackId: input.trackId, source, scope }, '手动新增选题');
      return await getAngle(created.id);
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new BadRequestError('选题编码冲突，请重试');
}

/** 只允许改 theme / content / scope，消费态字段（used/usedBy/usedDate）不接受外部改写。 */
export async function updateAngle(id: number, patch: AngleUpdateInput): Promise<AngleItem> {
  const exists = await prisma.angle.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError(`选题 ${id} 不存在`);

  const data: { theme?: string; content?: string; scope?: string } = {};
  if (patch.theme !== undefined) data.theme = clip(patch.theme, 64);
  if (patch.content !== undefined) {
    const c = clip(patch.content, 500);
    if (!c) throw new BadRequestError('选题内容不能为空');
    data.content = c;
  }
  // 改切片 = 把这条选题划给另一条产线（给漫画线补角度最快的一条路）。
  if (patch.scope !== undefined) data.scope = patch.scope;
  if (Object.keys(data).length === 0) throw new BadRequestError('没有需要保存的改动');

  await prisma.angle.update({ where: { id }, data });
  return await getAngle(id);
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
