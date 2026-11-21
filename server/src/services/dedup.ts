/**
 * 观点层去重（S4-2 统一判重入口）。
 *
 * 从 Python 版 add_angles.py 移植的相似度算法经过实测校准，改动前先看这段背景：
 * 最初只用 bigram Jaccard，阈值 0.50，结果「一不如意就躺在地上」和
 * 「一不如意就往地上一躺」这类明显同义改写算出来只有 0.41，整组漏网。
 * 原因是对话双方各自独有的部分稀释了比例。所以补了包含率做兜底。
 *
 * 移植约定：切片按 Unicode 码点而非 UTF-16 码元，保证与 Python 的字符语义一致。
 *
 * S4-2 统一判重规则（三个正式写入入口共用本文件，禁止在别处另起判重逻辑）：
 * - L0 完全重复：归一化后完全相同 → 拦截（扩库跳过 / 手动 400）。
 * - L1 高度相似：dupScore ≥ SIM_ANGLE(0.45)，同赛道与跨赛道一视同仁 → 拦截。
 * - L2 历史文章标题相似：dupScore ≥ SIM_HISTORY(0.35) → **只提示，不拦截**。
 * - rejected 等全部状态的现有选题都参与 L0/L1；不按 theme 判重（同主题不同角度放行）；
 *   不实施 theme_crowded（S4-2 明确裁决）。
 * - 编辑场景必须传 excludeId 排除自身，否则自比 1.0 误杀。
 *
 * 归一化：全仓唯一实现（live 扩库去重也用它），避免同一内容在不同入口判重结果不一致。
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import {
  CONTAINMENT_PENALTY,
  MIN_GRAMS_FOR_CONTAINMENT,
  SIM_ANGLE,
  SIM_HISTORY,
  THEME_CAP,
} from '../constants.ts';

/**
 * 删除全部空白与标点后小写。PUNCT 补入「」『』（S4-2 修复：此前中文书名号/引号残留，
 * 造成「“洗稿”」与「「洗稿」」判不相等的缺口）。
 */
const PUNCT = /[\s，。、？！；："'“”‘’「」『』（）()《》〈〉,.!?;:\[\]\-—…]+/g;

export function normalize(s: string): string {
  return (s ?? '').replace(PUNCT, '').toLowerCase();
}

/** 中文 bigram 集合：比单字更能反映短语层面的重合。 */
export function grams(s: string, n = 2): Set<string> {
  const t = normalize(s);
  if (t.length < 2) return t ? new Set([t]) : new Set();
  const chars = Array.from(t);
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i += 1) {
    out.add(chars.slice(i, i + n).join(''));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function containment(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : inter / denom;
}

/**
 * 判重综合分：0~1，越大越像。
 *
 * 单看 Jaccard 会漏两类改写：
 *  - 替换了个别词：整体重合比例不够高，但核心几乎全覆盖
 *  - 一方是另一方的扩写：多出来的内容稀释了比例
 * 所以再补包含率（交集 / 较短一方），并对短句停用以避免误伤。
 */
export function dupScore(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  const j = jaccard(ga, gb);
  if (Math.min(ga.size, gb.size) < MIN_GRAMS_FOR_CONTAINMENT) return j;
  const c = containment(ga, gb);
  return Math.max(j, c - CONTAINMENT_PENALTY);
}

/** 纯 Jaccard 相似度，保留给需要原始指标的场合。 */
export function sim(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  return jaccard(ga, gb);
}

// ────────────────────────────────────────────────────────────
// S4-2 统一判重入口（三个正式写入入口共用）
// ────────────────────────────────────────────────────────────

export type AngleDupLevel = 'L0' | 'L1' | 'L2';

/** 结构化命中明细（写入 metaJson.dedupHits / TopicReview.dupHits / 400 detail 共用同一形状）。 */
export interface AngleDupHit {
  /** 命中级别：L0 完全重复（拦截）/ L1 高度相似（拦截）/ L2 历史标题相似（仅提示）。 */
  level: AngleDupLevel;
  /** 命中对象类型：angle=现有选题（L0/L1）；article=历史文章标题（L2）。 */
  sourceType: 'angle' | 'article';
  /** 命中对象 ID（选题 id / 文章 id；本批次内候选为 0）。 */
  targetId: number;
  /** 命中对象的选题内容或文章标题。 */
  targetText: string;
  /** 相似度 0~1（L0 固定为 1）。 */
  score: number;
  /** 命中对象来源赛道（同赛道也带上，跨赛道命中必展示）。 */
  trackId: number | null;
  trackName: string;
  /** 可读的命中原因。 */
  reason: string;
}

export interface AngleDupCheckResult {
  /** 是否命中 L0/L1（拦截：手动入口 400，扩库跳过不入库）。 */
  blocked: boolean;
  /** L0/L1 命中明细（L0 在前，其余按相似度降序）。 */
  blockHits: AngleDupHit[];
  /** L2 历史标题命中明细（仅提示，不拦截；按相似度降序）。 */
  warnHits: AngleDupHit[];
}

interface DupAngleRow {
  id: number;
  content: string;
  trackId: number | null;
  trackName: string;
}

interface DupArticleRow {
  id: number;
  title: string;
  trackId: number | null;
  trackName: string;
}

export interface DupSnapshot {
  angles: DupAngleRow[];
  articles: DupArticleRow[];
}

/**
 * 历史文章「实质正文」判定：剥掉 HTML 标签后非空白字符不少于该值。
 * 只有非空标题 + 实质正文的 Article 才进 L2 历史范围（草稿空壳/占位正文不参与）。
 */
export const HISTORY_MIN_BODY_CHARS = 50;

/** 剥 HTML 标签与实体，取纯文本（判定历史文章正文实质用）。 */
export function stripHtmlText(html: string): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-zA-Z#0-9]+;/g, ' ');
}

function isSubstantialBody(html: string): boolean {
  return stripHtmlText(html).replace(/\s+/g, '').length >= HISTORY_MIN_BODY_CHARS;
}

type DupDb = Pick<Prisma.TransactionClient, 'angle' | 'article'>;

/**
 * 加载判重快照：全赛道现有选题（含 rejected，含已用）+ 历史文章标题（非空标题 + 实质正文）。
 * 扩库一次加载后逐条比对；手动入口走 checkAngleDup（内部同样加载）。
 */
export async function loadDupSnapshot(db: DupDb = prisma): Promise<DupSnapshot> {
  const [angles, articles] = await Promise.all([
    db.angle.findMany({
      select: {
        id: true,
        content: true,
        trackId: true,
        track: { select: { name: true } },
      },
    }),
    db.article.findMany({
      where: { NOT: { title: '' } },
      select: {
        id: true,
        title: true,
        contentHtml: true,
        trackId: true,
        track: { select: { name: true } },
      },
    }),
  ]);
  return {
    angles: angles.map((a) => ({
      id: a.id,
      content: a.content,
      trackId: a.trackId,
      trackName: a.track?.name ?? '',
    })),
    articles: articles
      .filter((a) => a.title.trim() !== '' && isSubstantialBody(a.contentHtml))
      .map((a) => ({
        id: a.id,
        title: a.title,
        trackId: a.trackId,
        trackName: a.track?.name ?? '',
      })),
  };
}

function hitSort(a: AngleDupHit, b: AngleDupHit): number {
  // L0（完全重复）永远排最前；同级按相似度降序；再按对象 id 稳定排序。
  if (a.level !== b.level) return a.level === 'L0' ? -1 : b.level === 'L0' ? 1 : a.level < b.level ? -1 : 1;
  return b.score - a.score || a.targetId - b.targetId;
}

/**
 * 纯比对（不查库）：候选内容 vs 判重快照，产出 L0/L1/L2 命中明细。
 * 扩库把已接受的批次内候选推进 snapshot.angles 即可实现批次内互查。
 */
export function checkDupAgainstSnapshot(
  snapshot: DupSnapshot,
  content: string,
  opts: { excludeId?: number } = {},
): AngleDupCheckResult {
  const key = normalize(content);
  const blockHits: AngleDupHit[] = [];
  const warnHits: AngleDupHit[] = [];

  if (key !== '') {
    for (const a of snapshot.angles) {
      if (opts.excludeId !== undefined && a.id === opts.excludeId) continue;
      const hitBase = {
        sourceType: 'angle' as const,
        targetId: a.id,
        targetText: a.content,
        trackId: a.trackId,
        trackName: a.trackName,
      };
      if (normalize(a.content) === key) {
        blockHits.push({
          ...hitBase,
          level: 'L0',
          score: 1,
          reason: a.id === 0 ? '与本批次内候选完全重复' : '与现有选题归一化后完全相同',
        });
        continue;
      }
      const s = dupScore(content, a.content);
      if (s >= SIM_ANGLE) {
        blockHits.push({
          ...hitBase,
          level: 'L1',
          score: s,
          reason: a.id === 0 ? '与本批次内候选高度相似' : '与现有选题高度相似',
        });
      }
    }
  }

  for (const t of snapshot.articles) {
    const s = dupScore(content, t.title);
    if (s >= SIM_HISTORY) {
      warnHits.push({
        level: 'L2',
        sourceType: 'article',
        targetId: t.id,
        targetText: t.title,
        score: s,
        trackId: t.trackId,
        trackName: t.trackName,
        reason: '与历史文章标题相似（只提示，不拦截）',
      });
    }
  }

  blockHits.sort(hitSort);
  warnHits.sort(hitSort);
  return { blocked: blockHits.length > 0, blockHits, warnHits };
}

/**
 * 统一判重入口：查现有选题（全赛道、全状态）+ 历史文章标题，算 L0/L1/L2。
 * 手动新增 / 手动编辑（传 excludeId 排除自身）使用；扩库用 loadDupSnapshot + checkDupAgainstSnapshot。
 */
export async function checkAngleDup(
  input: { content: string; excludeId?: number },
  db: DupDb = prisma,
): Promise<AngleDupCheckResult> {
  const snapshot = await loadDupSnapshot(db);
  return checkDupAgainstSnapshot(snapshot, input.content, { excludeId: input.excludeId });
}

// ────────────────────────────────────────────────────────────
// 旧版三层裁决（judgeAngle）：零业务调用，仅供离线分析对照。
// 阈值统一取 constants 真源（S4-2 消除双真源）。业务判重一律走 checkAngleDup——
// 与本函数的差异：L2 历史层在业务里只提示不拦截、不实施 theme_crowded、命中可多条。
// ────────────────────────────────────────────────────────────

export interface DedupVerdict {
  ok: boolean;
  reason?: 'dup_angle' | 'dup_history' | 'theme_crowded';
  /** 命中的已有选题（用于界面展示拒绝明细） */
  hit?: string;
  score?: number;
}

export interface DedupOptions {
  simAngle?: number;
  simHistory?: number;
  themeCap?: number;
}

/**
 * 三层判重：与现有选题比、与历史标题比、同主题堆积上限（旧语义：三层都拦截）。
 */
export function judgeAngle(
  angle: string,
  theme: string,
  existing: Array<{ content: string; theme: string; used: boolean }>,
  historyTitles: string[],
  opts: DedupOptions = {},
): DedupVerdict {
  const simAngle = opts.simAngle ?? SIM_ANGLE;
  const simHistory = opts.simHistory ?? SIM_HISTORY;
  const themeCap = opts.themeCap ?? THEME_CAP;

  let bestScore = 0;
  let hit = '';
  for (const e of existing) {
    const s = dupScore(angle, e.content);
    if (s > bestScore) {
      bestScore = s;
      hit = e.content;
    }
  }
  if (bestScore >= simAngle) {
    return { ok: false, reason: 'dup_angle', hit, score: bestScore };
  }

  let hScore = 0;
  let hHit = '';
  for (const t of historyTitles) {
    const s = dupScore(angle, t);
    if (s > hScore) {
      hScore = s;
      hHit = t;
    }
  }
  if (hScore >= simHistory) {
    return { ok: false, reason: 'dup_history', hit: hHit, score: hScore };
  }

  const unusedInTheme = existing.filter(
    (e) => e.theme === theme && !e.used,
  ).length;
  if (unusedInTheme >= themeCap) {
    return { ok: false, reason: 'theme_crowded', hit: theme, score: unusedInTheme };
  }

  return { ok: true, score: bestScore };
}

/** 生成下一个角度编码：取现有最大编号 +1，避免覆盖。 */
export function nextCode(existingCodes: string[], track: string): string {
  let max = 0;
  for (const code of existingCodes) {
    const m = /(\d+)\s*$/.exec(code);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `${track}-${String(max + 1).padStart(3, '0')}`;
}
