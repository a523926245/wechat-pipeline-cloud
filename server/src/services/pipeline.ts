/**
 * 产线（Pipeline）单一真源。
 *
 * 产线 = 赛道下的一条内容生产线（article / comic），各自拥有独立的配额、开关与
 * 角度切片（Angle.scope）。同一账号同一赛道可同时跑多条产线。
 *
 * 读口径约定（务必遵守）：
 * - TrackPipeline 缺行时回落旧语义：article → Track.quotaPerDay / 视为启用；
 *   comic → 配额 0 / 视为停用。这样未播种的存量赛道行为与产线改造前 bit-for-bit 一致。
 * - 写入 article 配额时双写 Track.quotaPerDay，保证旧入口（tracks PUT）读到同一份值。
 * - configJson 在 SQLite 下降级为 String，读写统一走 packJson/unpackJson。
 */

import { prisma } from '../db.ts';
import { packJson, unpackJson } from '../db-json.ts';

/** 产线类型。顺序即排产执行顺序：文章先、漫画后。 */
export type PipelineKind = 'article' | 'comic';
/** 角度池切片。shared 的行两条产线都可消费（used 全局先到先得）。 */
export type AngleScope = 'article' | 'comic' | 'shared';

export const PIPELINES: readonly PipelineKind[] = ['article', 'comic'];

export interface PipelineSpec {
  kind: PipelineKind;
  label: string;
  desc: string;
  /** 该产线消费的角度切片。 */
  angleScopes: AngleScope[];
}

export const PIPELINE_SPEC: Readonly<Record<PipelineKind, PipelineSpec>> = {
  article: {
    kind: 'article',
    label: '文章',
    desc: '选题 → 写作 → 在线改稿 → 封面 → 推送公众号草稿箱',
    angleScopes: ['article', 'shared'],
  },
  comic: {
    kind: 'comic',
    label: '漫画',
    desc: '选题 → 漫画脚本 → 逐格生图 → 金句卡 → 推送公众号草稿箱',
    angleScopes: ['comic', 'shared'],
  },
};

const ANGLE_SCOPES: readonly AngleScope[] = ['article', 'comic', 'shared'];

export const ANGLE_SCOPE_META: Readonly<Record<AngleScope, { label: string; desc: string }>> = {
  article: { label: '文章专用', desc: '只有文章产线消费' },
  comic: { label: '漫画专用', desc: '只有漫画产线消费' },
  shared: { label: '共享', desc: '两条产线都可消费，先到先得' },
};

export function isPipelineKind(v: string): v is PipelineKind {
  return (PIPELINES as readonly string[]).includes(v);
}

export function isAngleScope(v: string): v is AngleScope {
  return (ANGLE_SCOPES as readonly string[]).includes(v);
}

/** 某产线可消费的角度切片。 */
export function scopesFor(kind: PipelineKind): AngleScope[] {
  return PIPELINE_SPEC[kind].angleScopes;
}

export interface TrackPipelineView {
  kind: PipelineKind;
  quotaPerDay: number;
  enabled: boolean;
  /** 产线配置（缺行时为 null，回落语义见模块头注释）。 */
  config: Record<string, unknown> | null;
  seeded: boolean;
  /**
   * 该产线**真正吃得到**的未用角度数（按 Angle.scope 切片统计）。
   * 界面据此提示「开了产线但没有可用选题」——现有选题几乎全是 article 切片，
   * 漫画线开着也是 0，不给这个数用户只会看到排产报「角度不足」而找不到原因。
   */
  angleUnused: number;
}

/** 按切片统计某赛道的未用角度数。 */
async function unusedByScope(trackId: number): Promise<Map<string, number>> {
  const rows = await prisma.angle.groupBy({
    by: ['scope'],
    where: { trackId, used: false },
    _count: { _all: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.scope), r._count._all);
  return m;
}

function sumScopes(m: Map<string, number>, scopes: AngleScope[]): number {
  return scopes.reduce((s, sc) => s + (m.get(sc) ?? 0), 0);
}

/** 某赛道某产线的原始行（可为 null，调用方决定是否回落）。 */
export async function getPipelineRow(trackId: number, kind: PipelineKind) {
  return prisma.trackPipeline.findUnique({ where: { trackId_kind: { trackId, kind } } });
}

/**
 * 读某赛道某产线的每日配额。缺行回落旧语义（article → Track.quotaPerDay，comic → 0）。
 */
export async function getPipelineQuota(trackId: number, kind: PipelineKind): Promise<number> {
  const row = await getPipelineRow(trackId, kind);
  if (row) return row.quotaPerDay;
  if (kind === 'article') {
    const t = await prisma.track.findUnique({ where: { id: trackId }, select: { quotaPerDay: true } });
    return t?.quotaPerDay ?? 0;
  }
  return 0;
}

/**
 * 读某赛道某产线的启用状态。缺行回落旧语义（article → true，comic → false）。
 */
export async function isPipelineEnabled(trackId: number, kind: PipelineKind): Promise<boolean> {
  const row = await getPipelineRow(trackId, kind);
  if (row) return row.enabled;
  return kind === 'article';
}

/**
 * 某赛道产线的完整视图（缺行也给出回落值，seeded 标记是否已有物理行）。
 */
export async function listPipelines(trackId: number): Promise<TrackPipelineView[]> {
  const rows = await prisma.trackPipeline.findMany({ where: { trackId } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  let fallbackQuota = 0;
  if (!byKind.has('article')) {
    const t = await prisma.track.findUnique({ where: { id: trackId }, select: { quotaPerDay: true } });
    fallbackQuota = t?.quotaPerDay ?? 0;
  }
  const unused = await unusedByScope(trackId);
  return PIPELINES.map((kind) => {
    const row = byKind.get(kind);
    if (row) {
      return {
        kind,
        quotaPerDay: row.quotaPerDay,
        enabled: row.enabled,
        config: unpackJson<Record<string, unknown> | null>(row.configJson),
        seeded: true,
        angleUnused: sumScopes(unused, scopesFor(kind)),
      };
    }
    return {
      kind,
      quotaPerDay: kind === 'article' ? fallbackQuota : 0,
      enabled: kind === 'article',
      config: null,
      seeded: false,
      angleUnused: sumScopes(unused, scopesFor(kind)),
    };
  });
}

/**
 * 写某赛道某产线的配额/开关。kind=article 时双写 Track.quotaPerDay（旧入口兼容）。
 */
export async function setPipelineQuota(
  trackId: number,
  kind: PipelineKind,
  patch: { quotaPerDay?: number; enabled?: boolean; config?: Record<string, unknown> | null },
): Promise<TrackPipelineView> {
  const data: { quotaPerDay?: number; enabled?: boolean; configJson?: string } = {};
  if (patch.quotaPerDay !== undefined) data.quotaPerDay = patch.quotaPerDay;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.config !== undefined) {
    const cfg = packJson(patch.config);
    if (cfg) data.configJson = cfg;
  }

  const row = await prisma.trackPipeline.upsert({
    where: { trackId_kind: { trackId, kind } },
    create: { trackId, kind, quotaPerDay: patch.quotaPerDay ?? 0, enabled: patch.enabled ?? false, ...(data.configJson ? { configJson: data.configJson } : {}) },
    update: data,
  });

  if (kind === 'article' && patch.quotaPerDay !== undefined) {
    await prisma.track.update({ where: { id: trackId }, data: { quotaPerDay: patch.quotaPerDay } });
  }

  return {
    kind,
    quotaPerDay: row.quotaPerDay,
    enabled: row.enabled,
    config: unpackJson<Record<string, unknown> | null>(row.configJson),
    seeded: true,
    angleUnused: sumScopes(await unusedByScope(trackId), scopesFor(kind)),
  };
}

/**
 * 懒播种：首次访问某赛道时补齐两行产线（article 沿用 Track.quotaPerDay/启用，
 * comic 配额 0/停用）。幂等，可在任意读写路径安全调用。
 */
export async function ensureSeeded(trackId: number): Promise<void> {
  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) return;
  const rows = await prisma.trackPipeline.findMany({ where: { trackId }, select: { kind: true } });
  const have = new Set(rows.map((r) => r.kind));
  const creates: { trackId: number; kind: string; quotaPerDay: number; enabled: boolean }[] = [];
  if (!have.has('article')) {
    creates.push({ trackId, kind: 'article', quotaPerDay: track.quotaPerDay, enabled: true });
  }
  if (!have.has('comic')) {
    creates.push({ trackId, kind: 'comic', quotaPerDay: 0, enabled: false });
  }
  if (creates.length > 0) {
    await prisma.trackPipeline.createMany({ data: creates });
  }
}
