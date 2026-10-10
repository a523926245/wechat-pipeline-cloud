/**
 * 观点层去重。
 *
 * 从 Python 版 add_angles.py 移植。算法经过实测校准，改动前先看这段背景：
 * 最初只用 bigram Jaccard，阈值 0.50，结果「一不如意就躺在地上」和
 * 「一不如意就往地上一躺」这类明显同义改写算出来只有 0.41，整组漏网。
 * 原因是对话双方各自独有的部分稀释了比例。所以补了包含率做兜底。
 *
 * 移植约定：切片按 Unicode 码点而非 UTF-16 码元，保证与 Python 的字符语义一致。
 */

import {
  CONTAINMENT_PENALTY,
  MIN_GRAMS_FOR_CONTAINMENT,
} from '../constants.ts';

const PUNCT = /[\s，。、？！；："'“”‘’（）()《》,.!?;:\[\]\-—…]+/g;

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
 * 三层判重：与现有选题比、与历史标题比、同主题堆积上限。
 */
export function judgeAngle(
  angle: string,
  theme: string,
  existing: Array<{ content: string; theme: string; used: boolean }>,
  historyTitles: string[],
  opts: DedupOptions = {},
): DedupVerdict {
  const simAngle = opts.simAngle ?? 0.45;
  const simHistory = opts.simHistory ?? 0.35;
  const themeCap = opts.themeCap ?? 8;

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
