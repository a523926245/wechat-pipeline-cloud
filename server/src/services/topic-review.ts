/**
 * 选题评分与审核服务（S4-1）。
 *
 * 设计依据（不另起炉灶）：
 * - D1（README 决策登记表）：Angle.status（审核态）+ used（消费态）双维度 + TopicReview 事件表；
 *   不建 TopicCandidate；「标重复」= TopicReview 事件（verdict=rejected, reason=dup_*），不新增主状态。
 * - 状态图（DATABASE-DESIGN-REVIEW §③）：
 *     candidate ─┬─ approved ─(used=true 由排产置)─▶ 已消费
 *                ├─ needs_revision ─┬─ approved
 *                │                  └─ rejected
 *                └─ rejected
 *   approved / rejected 为终态；needs_revision 可多轮复审（每轮一条 TopicReview）。
 * - D5：审核（评分）第一版复用 write 角色（不达标再加 review 角色）。
 * - Q10（PROMPT-AND-CONTRACT-DESIGN）：选题审核（六维）1 次/对象，批量允许一次调用判多条。
 *
 * 六维评分口径（2026-11-14 用户确认，改前先读）：
 * - 维度：定位契合 fit / 具体画面 scene / 冲突反差 conflict / 方法落点 method /
 *   情绪安全 safety / 差异化 novelty。
 * - 每维 0-5 整数：0 完全不符合或存在明显问题 / 1 很差 / 2 较弱需明显改进 / 3 基本合格 / 4 良好 / 5 优秀。
 * - 总分 = 六维直接相加（0-30），**无权重、无阈值、无低分提示线**。
 * - 评分只影响排序与人工参考：**不替代人工审核、不自动批准、不自动拒绝、不淘汰**。
 * - 评分异常/缺失/失败 → 视为未评分（scores=null + scoreError），**绝不默认视为高质量**。
 * - 情绪安全维度不抵消硬性内容规范：topicRejectReason 等硬门禁仍在本服务之前执行，
 *   高分不得绕过守门（本服务不接收被守门拒收的候选）。
 *
 * 注意：本文件的评分提示词是「审核任务」的提示词，不是写作提示词——
 * 写作提示词仍只存在于 StylePrompt 表（WRITING-PIPELINE §11.7）。
 */

import { prisma } from '../db.ts';
import { BadRequestError, NotFoundError } from '../errors.ts';
import { logger } from '../logger.ts';
import { packJson, unpackJson } from '../db-json.ts';
import { Prisma, type AngleStatus, type TopicVerdict } from '@prisma/client';
import { assertRoleUsable, chatComplete } from './llm.ts';

// ────────────────────────────────────────────────────────────
// 六维评分：结构与纯函数（可单测，不碰网络与库）
// ────────────────────────────────────────────────────────────

export const SCORE_DIMENSIONS = ['fit', 'scene', 'conflict', 'method', 'safety', 'novelty'] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export const SCORE_DIMENSION_LABELS: Record<ScoreDimension, string> = {
  fit: '定位契合',
  scene: '具体画面',
  conflict: '冲突反差',
  method: '方法落点',
  safety: '情绪安全',
  novelty: '差异化',
};

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;
/** 总分 = 六维等权合计（0-30）。无权重、无阈值（用户 2026-11-14 确认）。 */
export const SCORE_TOTAL_MAX = SCORE_DIMENSIONS.length * SCORE_MAX;

export interface AngleScores {
  fit: number;
  scene: number;
  conflict: number;
  method: number;
  safety: number;
  novelty: number;
  total: number;
}

/** Angle.metaJson 的形状（S4-1 约定；判重结果 dupHits 留给 S4-2）。 */
export interface AngleScoreMeta {
  scores: AngleScores | null;
  scoreSource: 'llm' | 'none';
  scoreModel: string;
  scoredAt: string;
  riskHits: string[];
  suggestion: string;
  rationale: string;
  scoreError?: string;
}

/** 单条候选的评分结果（LLM 输出解析后）。 */
export interface ScoredCandidate {
  id: number;
  scores: AngleScores | null;
  riskHits: string[];
  suggestion: string;
  rationale: string;
  scoreError?: string;
}

function toInt05(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= SCORE_MIN && i <= SCORE_MAX ? i : null;
}

/**
 * 归一化六维评分：六维必须全部为 0-5 的整数（可由数字/数字字符串转换），
 * 任何一维缺失或越界 → 整体判为评分失败（返回 null）——缺胳膊少腿的分数
 * 会被当成「高分」误读，宁可标未评分。总分=直接相加。
 */
export function normalizeScores(raw: unknown): AngleScores | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const d of SCORE_DIMENSIONS) {
    const v = toInt05(o[d]);
    if (v === null) return null;
    out[d] = v;
  }
  const total = SCORE_DIMENSIONS.reduce((s, d) => s + out[d]!, 0);
  return { ...(out as unknown as AngleScores), total };
}

/** 从模型输出里抠出 JSON 数组（兼容 ```json 围栏与前后客套话，与 angles.extractJsonArray 同思路）。 */
function extractJsonArray(raw: string): unknown[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new BadRequestError(`评分模型未返回 JSON 数组，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new BadRequestError(`评分模型返回的不是数组，原始输出前 200 字：${raw.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * 解析批量评分输出 → 按 id 对齐的候选结果。
 * 某条解析不出合法六维 → 该条 scores=null + scoreError（不影响同批其他条）。
 */
export function parseScoreBatch(raw: string, wantedIds: number[]): Map<number, ScoredCandidate> {
  const out = new Map<number, ScoredCandidate>();
  let items: unknown[] = [];
  try {
    items = extractJsonArray(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of wantedIds) {
      out.set(id, { id, scores: null, riskHits: [], suggestion: '', rationale: '', scoreError: msg });
    }
    return out;
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'number' ? o.id : Number(o.id);
    if (!wantedIds.includes(id)) continue;
    const scores = normalizeScores(o.scores ?? o);
    const riskHits = Array.isArray(o.risk) ? (o.risk as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
    out.set(id, {
      id,
      scores,
      riskHits,
      suggestion: typeof o.suggestion === 'string' ? o.suggestion.slice(0, 32) : '',
      rationale: typeof o.why === 'string' ? o.why.slice(0, 300) : typeof o.rationale === 'string' ? o.rationale.slice(0, 300) : '',
      ...(scores ? {} : { scoreError: '六维评分缺失或越界（需每维 0-5 整数）' }),
    });
  }
  for (const id of wantedIds) {
    if (!out.has(id)) {
      out.set(id, { id, scores: null, riskHits: [], suggestion: '', rationale: '', scoreError: '评分输出缺该条目' });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// 评分调用（D5：复用 write 角色；批量一次判多条）
// ────────────────────────────────────────────────────────────

export interface ScorePromptItem {
  id: number;
  theme: string;
  content: string;
}

export type CompleteFn = (
  messages: { role: 'system' | 'user'; content: string }[],
  opts?: { temperature?: number; maxTokens?: number },
) => Promise<string>;

/** 单次批量评分的最大条数（输出含 6 数字/条，控制在一次调用可完成的规模）。 */
const SCORE_BATCH_SIZE = 25;

const SCORE_SYSTEM = [
  '你是微信公众号的选题质量评审员。你只输出 JSON 数组，不输出任何解释、前言或结语。',
  '你的评分只做人工审核的参考，**不是最终决定**，不要试图代替人工批准或拒绝。',
].join('\n');

/** 六维评分标准（用户 2026-11-14 确认口径；数字必须走这里，不写死在别处）。 */
const SCORE_RUBRIC = [
  '六维评分标准（每维独立打 0-5 的整数，不要互相抵消）：',
  '- 0 分：完全不符合或存在明显问题',
  '- 1 分：很差，基本不具备要求',
  '- 2 分：较弱，需要明显改进',
  '- 3 分：基本合格',
  '- 4 分：表现良好',
  '- 5 分：表现优秀',
  '维度定义：',
  '- fit 定位契合：符合该赛道与公众号正向、有价值、不贩卖焦虑的定位。',
  '- scene 具体画面：有可感知的具体场景（人物、动作、处境），不是空泛道理。',
  '- conflict 冲突反差：暗含冲突、反差或两难，能展开成文。',
  '- method 方法落点：能落到方法、希望或成长，不停在僵局或纯情绪。',
  '- safety 情绪安全：不恐吓、不放大痛苦、无心理病理标签。注意：本维不抵消硬性内容规范，',
  '  触发系统硬性守门的选题不会送到你这里；即便 safety 得分高，也不能弥补其他维度的缺陷。',
  '- novelty 差异化：与给出的同批/已有选题角度不同，不是换汤不换药。',
].join('\n');

export function buildScoreMessages(trackName: string, items: ScorePromptItem[]): { role: 'system' | 'user'; content: string }[] {
  const list = items.map((i) => `${i.id}. [${i.theme}] ${i.content}`).join('\n');
  return [
    { role: 'system', content: SCORE_SYSTEM },
    {
      role: 'user',
      content:
        `赛道主题：${trackName}\n\n${SCORE_RUBRIC}\n\n` +
        `待评候选（id. [theme] content）：\n${list}\n\n` +
        '请逐条评分并严格以 JSON 数组输出，每条格式：\n' +
        '{"id":编号,"fit":0-5,"scene":0-5,"conflict":0-5,"method":0-5,"safety":0-5,"novelty":0-5,' +
        '"risk":["风险项（可空）"],"suggestion":"approved|needs_revision|rejected（仅供参考）","why":"一句话依据"}\n' +
        `只输出这 ${items.length} 条，不要多也不要少。`,
    },
  ];
}

/**
 * 给一批候选打六维分（1~N 次批量调用）。
 *
 * 失败语义（重要）：任何调用/解析失败只影响对应批次的候选——
 * 返回 scores=null + scoreError，**绝不默认高分、绝不自动批准**（调用方也不允许据此批准）。
 */
export async function scoreAngleCandidates(
  trackName: string,
  items: ScorePromptItem[],
  complete?: CompleteFn,
): Promise<Map<number, ScoredCandidate>> {
  const out = new Map<number, ScoredCandidate>();
  if (items.length === 0) return out;

  let fn: CompleteFn;
  if (complete) {
    fn = complete;
  } else {
    // D5：第一版复用 write 角色；未绑定/停用/缺 Key 时整体判评分失败（不阻断候选入库）。
    const model = await assertRoleUsable('write');
    fn = (messages, opts) => chatComplete(model, messages, opts ?? {});
  }

  for (let i = 0; i < items.length; i += SCORE_BATCH_SIZE) {
    const batch = items.slice(i, i + SCORE_BATCH_SIZE);
    const ids = batch.map((b) => b.id);
    try {
      const raw = await fn(buildScoreMessages(trackName, batch), { temperature: 0.2, maxTokens: 4000 });
      const parsed = parseScoreBatch(raw, ids);
      for (const [id, rec] of parsed) out.set(id, rec);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ trackName, count: batch.length, err: msg }, '六维评分失败，该批候选按未评分入库');
      for (const id of ids) {
        out.set(id, { id, scores: null, riskHits: [], suggestion: '', rationale: '', scoreError: msg });
      }
    }
  }
  return out;
}

/** 评分结果 → Angle.metaJson 存储形态。 */
export function toScoreMeta(rec: ScoredCandidate | undefined, modelName: string): AngleScoreMeta {
  if (!rec) {
    return { scores: null, scoreSource: 'none', scoreModel: '', scoredAt: new Date().toISOString(), riskHits: [], suggestion: '', rationale: '', scoreError: '未评分' };
  }
  return {
    scores: rec.scores,
    scoreSource: rec.scores ? 'llm' : 'none',
    scoreModel: rec.scores ? modelName : '',
    scoredAt: new Date().toISOString(),
    riskHits: rec.riskHits,
    suggestion: rec.suggestion,
    rationale: rec.rationale,
    ...(rec.scoreError ? { scoreError: rec.scoreError } : {}),
  };
}

/** 读取 Angle.metaJson → 评分元信息（损坏/缺失按未评分处理）。 */
export function readScoreMeta(value: unknown): AngleScoreMeta | null {
  const meta = unpackJson<AngleScoreMeta | null>(value);
  if (!meta || typeof meta !== 'object') return null;
  return meta;
}

// ────────────────────────────────────────────────────────────
// 审核状态机（D1 状态图；评分不替代人工审核）
// ────────────────────────────────────────────────────────────

/**
 * 允许的状态流转（终态 approved/rejected 不可再动）。
 * needs_revision→needs_revision = 修改后再审仍要改：状态不变，round+1，留一条新记录。
 */
export const REVIEW_TRANSITIONS: Record<AngleStatus, AngleStatus[]> = {
  candidate: ['approved', 'needs_revision', 'rejected'],
  needs_revision: ['approved', 'needs_revision', 'rejected'],
  approved: [],
  rejected: [],
};

export interface ReviewInput {
  verdict: TopicVerdict;
  reason?: string;
  /** 审核操作者（登录名）。空=未记录。 */
  reviewedBy?: string;
}

export interface TopicReviewRecord {
  id: number;
  angleId: number;
  round: number;
  scores: AngleScores | null;
  riskHits: string[];
  dupHits: unknown[];
  verdict: TopicVerdict;
  reason: string;
  model: string;
  reviewedBy: string;
  createdAt: string;
}

function reviewToRecord(r: {
  id: number;
  angleId: number;
  round: number;
  scoresJson: unknown;
  riskHits: unknown;
  dupHits: unknown;
  verdict: TopicVerdict;
  reason: string;
  model: string;
  reviewedBy: string;
  createdAt: Date;
}): TopicReviewRecord {
  return {
    id: r.id,
    angleId: r.angleId,
    round: r.round,
    scores: unpackJson<AngleScores | null>(r.scoresJson),
    riskHits: unpackJson<string[]>(r.riskHits) ?? [],
    dupHits: unpackJson<unknown[]>(r.dupHits) ?? [],
    verdict: r.verdict,
    reason: r.reason,
    model: r.model,
    reviewedBy: r.reviewedBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * 人工审核一条选题：校验状态流转 → CAS 更新 Angle.status/reviewRound → 写 TopicReview 事件。
 *
 * - verdict 只允许 approved / needs_revision / rejected（评分/LLM suggestion 不走这里）。
 * - 并发防重入：updateMany 带 status 前置条件，抢不到即报冲突。
 * - 评分缺失不影响人工审核（人可以无评分拍板），但记录里如实留空。
 */
export async function reviewAngle(id: number, input: ReviewInput): Promise<TopicReviewRecord> {
  const verdict = input.verdict;
  if (verdict !== 'approved' && verdict !== 'needs_revision' && verdict !== 'rejected') {
    throw new BadRequestError(`非法审核结论：${String(verdict)}（只允许 approved / needs_revision / rejected）`);
  }
  const reason = (input.reason ?? '').trim().slice(0, 500);
  const reviewedBy = (input.reviewedBy ?? '').trim().slice(0, 64);

  return prisma.$transaction(async (tx) => {
    const a = await tx.angle.findUnique({ where: { id }, select: { id: true, status: true, reviewRound: true, metaJson: true } });
    if (!a) throw new NotFoundError(`选题 ${id} 不存在`);

    const allowed = REVIEW_TRANSITIONS[a.status as AngleStatus] ?? [];
    if (!allowed.includes(verdict)) {
      throw new BadRequestError(
        `状态不可流转：${a.status} → ${verdict}（${a.status} 为终态或不允许该操作；可流转目标：${allowed.join('/') || '无'}）`,
      );
    }

    const nextRound = a.reviewRound + 1;
    const cas = await tx.angle.updateMany({
      where: { id, status: a.status as AngleStatus, reviewRound: a.reviewRound },
      data: { status: verdict as AngleStatus, reviewRound: nextRound },
    });
    if (cas.count === 0) {
      throw new BadRequestError('该选题状态刚被其他操作修改，请刷新后重试');
    }

    const meta = readScoreMeta(a.metaJson);
    const row = await tx.topicReview.create({
      data: {
        angleId: id,
        round: nextRound,
        scoresJson: packJson(meta?.scores ?? null) ?? Prisma.DbNull,
        riskHits: packJson(meta?.riskHits ?? null) ?? Prisma.DbNull,
        // dupHits 留空：判重链接入是 S4-2，本阶段不伪造命中数据。
        dupHits: Prisma.DbNull,
        verdict: verdict as TopicVerdict,
        reason,
        model: meta?.scoreModel ?? '',
        reviewedBy,
      },
    });
    logger.info({ id, from: a.status, to: verdict, round: nextRound, reviewedBy }, '选题审核');
    return reviewToRecord(row);
  });
}

/** 某选题的全部审核事件（按轮次倒序：新轮在前）。 */
export async function listTopicReviews(angleId: number): Promise<TopicReviewRecord[]> {
  const a = await prisma.angle.findUnique({ where: { id: angleId }, select: { id: true } });
  if (!a) throw new NotFoundError(`选题 ${angleId} 不存在`);
  const rows = await prisma.topicReview.findMany({
    where: { angleId },
    orderBy: { round: 'desc' },
    take: 50,
  });
  return rows.map(reviewToRecord);
}
