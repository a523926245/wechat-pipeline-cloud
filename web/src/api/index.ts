/**
 * 所有后端接口的前端映射。路径与 server/src/app.ts 挂载点严格一致。
 */

import { http } from './http.ts';
import type {
  AngleDeleteResult,
  AngleItem,
  AngleListQuery,
  AngleListResult,
  AnglePayload,
  AngleScopeFilter,
  AngleUpdatePayload,
  ArticleDetail,
  ArticleListItem,
  ArticleRenderResult,
  BindingMap,
  BulkDeleteResult,
  ComicGenerateResult,
  ComicPanelsResult,
  CoverGenerateResult,
  CoverPayload,
  CredentialDetail,
  CredentialItem,
  CredentialUpdatePayload,
  CredTestResult,
  ContentPrefixItem,
  DashboardData,
  EmphasisApplyResult,
  EmphasisPreview,
  EmphasisStats,
  Health,
  LlmModelPayload,
  LlmModelView,
  ModelMeta,
  ModelTestResult,
  OkResult,
  AccountCreatePayload,
  AccountDeleteResult,
  PlanResult,
  PushResult,
  ReviseApplyResult,
  ReviseMode,
  RevisePreviewResult,
  RoleResolveResult,
  SchedulerConfig,
  SchedulerStatus,
  AutomationMode,
  MyAutomation,
  AuthStatus,
  AuthUser,
  UserAdminItem,
  StylePromptDefaults,
  StylePromptItem,
  SystemStatus,
  TickResult,
  TrackExpandResult,
  TrackItem,
  TrackPayload,
  TrackPipelineItem,
  TrackUpdatePayload,
  TriggerResult,
} from '../types.ts';

// ── 系统 ──
export const getHealth = () => http.get<Health>('/health');

/** 内容标题前缀（文章 / 漫画）。 */
export const getContentPrefixes = () =>
  http.get<{ items: ContentPrefixItem[] }>('/content-prefixes');

export const updateContentPrefixes = (
  payload: Partial<Record<'title_prefix' | 'comic_title_prefix', string>>,
) => http.put<{ items: ContentPrefixItem[]; message?: string }>('/content-prefixes', payload);

// ── 凭据 ──
export const listCredentials = () =>
  http.get<{ total: number; items: CredentialItem[] }>('/credentials');

export const getCredential = (id: number) => http.get<CredentialDetail>(`/credentials/${id}`);

export const updateCredential = (id: number, payload: CredentialUpdatePayload) =>
  http.put<CredentialDetail & { message?: string }>(`/credentials/${id}`, payload);

export const createCredential = (payload: AccountCreatePayload) =>
  http.post<CredentialDetail & { message?: string }>('/credentials', payload);

export const deleteCredential = (id: number) => http.del<AccountDeleteResult>(`/credentials/${id}`);

/**
 * 批量删除账号：逐条独立执行，失败项带原因返回。
 * 与单条删除共用同一套级联语义（删名下文章 → 归还角度 → 删账号）。
 */
export const bulkDeleteCredentials = (ids: number[]) =>
  http.post<BulkDeleteResult>('/credentials/bulk-delete', { ids });

export const testCredential = (id: number) => http.post<CredTestResult>(`/credentials/${id}/test`);

// ── 赛道 ──
export const listTracks = () => http.get<{ total: number; items: TrackItem[] }>('/tracks');

export const createTrack = (payload: TrackPayload) =>
  http.post<TrackItem & { message?: string }>('/tracks', payload);

export const updateTrack = (id: number, payload: TrackUpdatePayload) =>
  http.put<Partial<TrackItem> & { message?: string }>(`/tracks/${id}`, payload);

export const deleteTrack = (id: number) => http.del<OkResult & { id: number; name: string }>(`/tracks/${id}`);

/**
 * 批量删除赛道：逐条独立执行，失败项带原因返回。
 * 赛道下有账号的那条会被跳过（与单条删除同一规则，不在批量里放宽）。
 */
export const bulkDeleteTracks = (ids: number[]) =>
  http.post<BulkDeleteResult>('/tracks/bulk-delete', { ids });

/** 扩库。scope 决定这批选题归哪条产线（漫画产线只吃 comic / shared）。 */
export const expandTrackAngles = (
  id: number,
  count?: number,
  seed?: string,
  scope?: AngleScopeFilter,
) => http.post<TrackExpandResult>(`/tracks/${id}/expand`, { count, seed, scope });

/** 读某赛道的产线（文章/漫画）配额与开关。 */
export const getPipelines = (trackId: number) =>
  http.get<{ trackId: number; items: TrackPipelineItem[] }>(`/tracks/${trackId}/pipelines`);

/** 改某赛道某产线的配额/开关。 */
export const updatePipeline = (
  trackId: number,
  kind: string,
  patch: { quotaPerDay?: number; enabled?: boolean },
) => http.put<TrackPipelineItem & { message: string }>(`/tracks/${trackId}/pipelines/${kind}`, patch);

// ── 选题库 ──
export const listAngles = (params: AngleListQuery) =>
  http.get<AngleListResult>('/angles', params as unknown as Record<string, unknown>);

/** 把漫画切片里含 IP 外角色的选题批量退回「文章专用」。 */
export const reassignOffIpAngles = (trackId: number) =>
  http.post<{ trackId: number; changed: number; ids: number[]; message: string }>(
    '/angles/off-ip-to-article',
    { trackId },
  );

export const getAngle = (id: number) => http.get<AngleItem>(`/angles/${id}`);

export const createAngle = (payload: AnglePayload) =>
  http.post<AngleItem & { message?: string }>('/angles', payload);

export const updateAngle = (id: number, payload: AngleUpdatePayload) =>
  http.put<AngleItem & { message?: string }>(`/angles/${id}`, payload);

export const deleteAngle = (id: number) => http.del<AngleDeleteResult>(`/angles/${id}`);

/**
 * 批量删除选题：逐条独立执行，失败项带原因返回。
 * 与单条删除共用同一套「解除文章关联后删选题」语义。
 */
export const bulkDeleteAngles = (ids: number[]) =>
  http.post<BulkDeleteResult>('/angles/bulk-delete', { ids });

/** 归还孤儿选题（已用但 0 关联文章）回未用池。 */
export const releaseAngle = (id: number) =>
  http.post<{ ok: boolean; id: number; poolUnused: number; message: string }>(
    `/angles/${id}/release`,
  );

// ── 模型 ──
export const listModels = () => http.get<{ total: number; items: LlmModelView[] }>('/models');

/** 候选项与中文标签的单一真源，页面不要自己再写一份枚举文案。 */
export const getModelMeta = () => http.get<ModelMeta>('/models/meta');

export const createModel = (payload: LlmModelPayload) => http.post<LlmModelView>('/models', payload);

export const updateModel = (id: number, payload: Partial<LlmModelPayload>) =>
  http.put<LlmModelView>(`/models/${id}`, payload);

export const deleteModel = (id: number) => http.del<{ ok: boolean; id: number }>(`/models/${id}`);

/** 批量删除模型：逐条独立执行，失败项带原因返回（会先解绑角色再删）。 */
export const bulkDeleteModels = (ids: number[]) =>
  http.post<BulkDeleteResult>('/models/bulk-delete', { ids });

export const testModel = (id: number) => http.post<ModelTestResult>(`/models/${id}/test`);

export const getBindings = () => http.get<{ bindings: BindingMap }>('/models/bindings');

/** modelId 传 null 即解绑；后端会校验能力/协议是否匹配该角色。 */
export const bindRole = (role: string, modelId: number | null) =>
  http.put<{ ok: boolean; role: string; modelId: number | null; modelName: string | null }>(
    `/models/bindings/${role}`,
    { modelId },
  );

export const unbindRole = (role: string) => http.del<{ ok: boolean; role: string }>(`/models/bindings/${role}`);

export const resolveRole = (role: string) => http.get<RoleResolveResult>(`/models/resolve/${role}`);

// ── 创作计划 ──
export const getPlan = (params?: { account?: string; backlogDays?: number }) =>
  http.get<PlanResult>('/plan', params as Record<string, unknown> | undefined);

export const triggerPlan = (accountId: number, count?: number, pipeline?: 'article' | 'comic') =>
  http.post<TriggerResult>('/plan/trigger', { accountId, count, pipeline });

// ── 调度 ──
export const getSchedulerStatus = () => http.get<SchedulerStatus>('/scheduler');

/** P4：automationMode/writeTime=每客户（写 User）；enabled/pushEnabled=全局（仅 admin）。 */
export const setSchedulerConfig = (
  patch: Partial<SchedulerConfig> & { automationMode?: AutomationMode; writeTime?: string },
) => http.put<{ ok: boolean; config: SchedulerConfig; my: MyAutomation }>('/scheduler/config', patch);

export const schedulerTick = (force = false) =>
  http.post<{ ok: boolean; result: TickResult }>('/scheduler/tick', { force }, force ? { force: '1' } : undefined);

export const schedulerStart = (intervalMs?: number) =>
  http.post<{ ok: boolean; started: boolean; intervalMs: number; message: string }>(
    '/scheduler/start',
    { intervalMs },
  );

export const schedulerStop = () =>
  http.post<{ ok: boolean; stopped: boolean; message: string }>('/scheduler/stop');

// ── 仪表盘 ──
export const getDashboard = () => http.get<DashboardData>('/dashboard');
export const getSystemStatus = () => http.get<SystemStatus>('/dashboard/status');

// ── 文章 ──
export const listArticles = (params?: {
  status?: string;
  accountId?: number;
  angleId?: number;
  /** 产线过滤（article / comic）。 */
  pipeline?: string;
  limit?: number;
  offset?: number;
}) =>
  http.get<{ total: number; limit: number; offset: number; items: ArticleListItem[] }>(
    '/articles',
    params as Record<string, unknown> | undefined,
  );

export const createArticle = (payload: {
  contentHtml: string;
  accountId?: number;
  trackId?: number;
  angleId?: number;
  title?: string;
  digest?: string;
  coverPath?: string;
}) => http.post<ArticleRenderResult & { status: string }>('/articles', payload);

export const getArticle = (id: number) => http.get<ArticleDetail>(`/articles/${id}`);

/** 删除文章。recycledAngle=true 表示该文章占用的选题角度已归还角度池。 */
export const deleteArticle = (id: number) =>
  http.del<{ ok: boolean; id: number; title: string; recycledAngle: boolean }>(`/articles/${id}`);

/**
 * 批量删除文章：逐条独立执行，失败项带原因返回。
 * 与单条删除共用同一套角度回收语义（未推送的归还、已推送的不归还）。
 */
export const bulkDeleteArticles = (ids: number[]) =>
  http.post<BulkDeleteResult>('/articles/bulk-delete', { ids });

export const previewArticle = (id: number) => http.get<ArticleRenderResult>(`/articles/${id}/preview`);

export const updateArticleContent = (id: number, contentHtml: string) =>
  http.put<ArticleRenderResult & { status: string }>(`/articles/${id}/content`, { contentHtml });

export const pushArticle = (id: number) => http.post<PushResult>(`/articles/${id}/push`);

// ── 漫画产线 ──

export const getPipelineMeta = () =>
  http.get<{ pipelines: { kind: string; label: string; desc: string; angleScopes: string[] }[]; angleScopes: { value: string; label: string; desc: string }[] }>(
    '/pipelines',
  );

export const createComicDraft = (payload: {
  accountId: number;
  angleId: number;
  unitCount?: number;
  chain?: string;
  extra?: string;
}) => http.post<{ ok: boolean; articleId: number; title: string; unitCount: number }>('/articles/comic/create', payload);

export const listComicPanels = (id: number) =>
  http.get<ComicPanelsResult>(`/articles/${id}/comic/panels`);

export const generateComicImages = (id: number) =>
  http.post<ComicGenerateResult>(`/articles/${id}/comic/generate`);

export const regenerateComicPanel = (
  id: number,
  seq: number,
  payload: { prompt?: string; lines?: string } = {},
) => http.post<{ ok: boolean }>(`/articles/${id}/comic/panels/${seq}/regenerate`, payload);

export const generateCover = (id: number, payload: CoverPayload = {}) =>
  http.post<CoverGenerateResult>(`/articles/${id}/cover`, payload);

// ── AI 改写 ──
export const previewRevise = (payload: {
  contentHtml: string;
  mode?: ReviseMode;
  instruction?: string;
}) => http.post<RevisePreviewResult>('/revise/preview', payload);

export const applyRevise = (
  id: number,
  payload: { contentHtml?: string; mode?: ReviseMode; instruction?: string } = {},
) => http.post<ReviseApplyResult>(`/revise/articles/${id}`, payload);

// ── 强调补全 ──
export const previewEmphasis = (payload: {
  contentHtml: string;
  min?: number;
  max?: number;
  keyMin?: number;
}) => http.post<{ contentHtml: string; changed: boolean; stats: EmphasisStats }>('/emphasize', payload);

export const applyEmphasis = (
  id: number,
  payload: { min?: number; max?: number; keyMin?: number } = {},
) => http.post<EmphasisApplyResult>(`/emphasize/articles/${id}`, payload);

export type { EmphasisPreview };

// ── 文风配置（创作总纲 + 赛道文体 + 三维变体库）──
export const listStylePrompts = () =>
  http.get<{ total: number; items: StylePromptItem[] }>('/style-prompts');

export const getStylePromptDefaults = () => http.get<StylePromptDefaults>('/style-prompts/defaults');

/** 各赛道变体轮换游标（只读，不推进）。配置页用来显示「下一篇取第几条」。 */
export const getStylePromptCursors = () =>
  http.get<{ cursors: Record<string, number> }>('/style-prompts/cursor');

export const upsertStylePrompt = (key: string, prompt: string) =>
  http.put<StylePromptItem>(`/style-prompts/${encodeURIComponent(key)}`, { prompt });

export const deleteStylePrompt = (key: string) =>
  http.del<OkResult & { key: string }>(`/style-prompts/${encodeURIComponent(key)}`);

// ── 鉴权 ──
export const getAuthStatus = () => http.get<AuthStatus>('/auth/status');
/** 口令登录（唯一登录方式；管理令牌已退场）。 */
export const login = (payload: { username: string; password: string }) =>
  http.post<OkResult & { user?: AuthUser }>('/auth/login', payload);
export const register = (payload: { username: string; password: string }) =>
  http.post<OkResult & { user?: AuthUser }>('/auth/register', payload);
export const logout = () => http.post<OkResult>('/auth/logout');

// ---------- 用户管理（admin，P2） ----------
export const listUsers = () => http.get<{ users: UserAdminItem[] }>('/users');
export const approveUser = (id: number) => http.post<OkResult>(`/users/${id}/approve`);
export const patchUser = (
  id: number,
  patch: {
    role?: 'admin' | 'member' | 'guest';
    status?: 'pending' | 'active' | 'disabled';
    expiresAt?: string | null;
    maxOAAccounts?: number;
  },
) => http.patch<OkResult>(`/users/${id}`, patch);
