/* 工作台待办 → 业务页面的跳转参数（纯函数，无 Vue 依赖，便于断言）。
   ══════════════════════════════════════════════════════════════════════
   为什么单独放一层：S5-UI-2-C 审计的 P0 是「单赛道只有待改选题时，
   一键入口仍按 candidate 跳 → 落到共 0 条」。这套判定是纯数据映射，
   放在组件里只能靠浏览器点按钮才能验，抽出来后可被脚本直接断言。 */

/** 赛道待审分布（对应 `TodoAnglesBlock.byTrack` 的元素）。 */
export interface AngleTrackDistribution {
  candidate: number;
  needsRevision: number;
}

/**
 * 「去审核」入口的初始审核态。按该赛道**真实分布**选，不做固定默认：
 * - 有候选 → `candidate`（审核主流程，且候选通常更多）
 * - 只有待改 → `needs_revision`
 * - 两者都为 0（理论上入口不会出现）→ `undefined`，即不构造筛选条件，
 *   交给选题库按「全部」展示，避免造出一个必然为空的 status。
 */
export function initialAngleStatus(
  track: AngleTrackDistribution | null | undefined,
): 'candidate' | 'needs_revision' | undefined {
  if (!track) return undefined;
  if (track.candidate > 0) return 'candidate';
  if (track.needsRevision > 0) return 'needs_revision';
  return undefined;
}

/**
 * 选题库 URL 查询参数：`used=unused` 恒带（审核只看未被占用的题）。
 * `status` 只有拿到真实审核态时才写——`undefined` 表示「不筛选」，
 * 不能让空值被当成某个具体状态。
 */
export function anglesQuery(status?: string | null): Record<string, string> {
  const query: Record<string, string> = { used: 'unused' };
  if (status) query.status = status;
  return query;
}

/** 带赛道 id 的待审分布（`byTrack` 的元素多一个 `track` 名字，结构兼容）。 */
export interface AngleTrackPending extends AngleTrackDistribution {
  trackId: number;
}

export interface AnglesNavTarget {
  path: string;
  query?: Record<string, string>;
}

/** `pending` 参数允许的最大赛道数：防止手工拼一个超长 URL 把页面拖慢。 */
const PENDING_MAX = 50;

/**
 * 把待审赛道压成 URL 参数值（`3,5`）。
 * 只保留「candidate + needsRevision > 0」且 id 合法的赛道，去重后按 id 升序，
 * 保证同一个工作台状态生成同一个 URL（可分享、可缓存、断言稳定）。
 */
export function pendingTrackParam(tracks: AngleTrackPending[]): string {
  const ids = [
    ...new Set(
      tracks
        .filter((t) => Number.isInteger(t.trackId) && t.trackId > 0)
        .filter((t) => t.candidate + t.needsRevision > 0)
        .map((t) => t.trackId),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, PENDING_MAX);
  return ids.join(',');
}

/**
 * 解析 `?pending=3,5`。url 参数可能是 string / string[] / null，
 * 也可能被手工改成任意内容——非法值一律丢弃（不是报错，只是不标记），
 * 这样「参数写错」的后果只是少一个提示，不会把页面搞坏。
 */
export function parsePendingTrackIds(raw: unknown): number[] {
  const parts: string[] = [];
  if (typeof raw === 'string') parts.push(...raw.split(','));
  else if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') parts.push(...v.split(','));
  }
  const ids = new Set<number>();
  for (const part of parts) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0) ids.add(id);
    if (ids.size >= PENDING_MAX) break;
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * 「去审核」一键入口的落点：
 * - 多赛道 → 赛道列表，并把**有待审选题的赛道 id** 一起带过去（`?pending=3,5`），
 *   否则用户落到赛道管理页还得自己逐个点进去找。
 * - 单赛道 → 该赛道选题库，初始审核态由 `initialAngleStatus` 按真实分布决定。
 * - 0 个赛道 → 赛道列表，不带任何参数。
 */
export function anglesTopTarget(tracks: AngleTrackPending[]): AnglesNavTarget {
  if (tracks.length !== 1) {
    const pending = pendingTrackParam(tracks);
    return pending ? { path: '/tracks', query: { pending } } : { path: '/tracks' };
  }
  const only = tracks[0];
  if (!only) return { path: '/tracks' };
  return {
    path: `/tracks/${only.trackId}/angles`,
    query: anglesQuery(initialAngleStatus(only)),
  };
}

/* ── 文章待办（S5-UI-2-D-2）──────────────────────────────────────────── */

/** 工作台「文章待处理」里能精确筛的两类。推送失败/漫画仍走原有 status / pipeline 参数。 */
export type ArticleNeeds = 'draft_unpushed' | 'repush';

/**
 * 文章列表 URL 参数：
 * - `draft_unpushed` / `repush` → 带 `needs`（服务端已支持下推筛选，total 与集合一致）。
 * - `failed` / `comic` / `all` → 维持原有 status / pipeline 参数，不改成 needs。
 *
 * 未来若后端再加 needs 值，只需扩 `ArticleNeeds` 与这里的分支，Dashboard 无需改。
 */
export function articlesNeedsQuery(kind: 'all' | 'failed' | 'comic' | ArticleNeeds): Record<string, string> {
  if (kind === 'draft_unpushed' || kind === 'repush') return { needs: kind };
  if (kind === 'failed') return { status: 'failed' };
  if (kind === 'comic') return { status: 'draft', pipeline: 'comic' };
  return {};
}

/** 只认服务端支持的两个字面值；其它（含空、数组、拼错）一律视为未筛选。 */
export function parseArticleNeeds(raw: unknown): ArticleNeeds | undefined {
  return raw === 'draft_unpushed' || raw === 'repush' ? raw : undefined;
}
