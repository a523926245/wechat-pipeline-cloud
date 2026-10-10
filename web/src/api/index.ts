/**
 * 所有后端接口的前端映射。路径与 server/src/app.ts 挂载点严格一致。
 */

import { http } from './http.ts';
import type {
  ArticleDetail,
  ArticleListItem,
  ArticleRenderResult,
  BindingMap,
  CredentialDetail,
  CredentialItem,
  CredentialUpdatePayload,
  CredTestResult,
  DashboardData,
  EmphasisApplyResult,
  EmphasisPreview,
  EmphasisStats,
  Health,
  LlmModelPayload,
  LlmModelView,
  ModelTestResult,
  PlanResult,
  PushResult,
  SchedulerConfig,
  SchedulerStatus,
  TickResult,
  TriggerResult,
} from '../types.ts';

// ── 系统 ──
export const getHealth = () => http.get<Health>('/health');

// ── 凭据 ──
export const listCredentials = () =>
  http.get<{ total: number; items: CredentialItem[] }>('/credentials');

export const getCredential = (id: number) => http.get<CredentialDetail>(`/credentials/${id}`);

export const updateCredential = (id: number, payload: CredentialUpdatePayload) =>
  http.put<CredentialDetail & { message?: string }>(`/credentials/${id}`, payload);

export const testCredential = (id: number) => http.post<CredTestResult>(`/credentials/${id}/test`);

// ── 模型 ──
export const listModels = () => http.get<{ total: number; items: LlmModelView[] }>('/models');

export const createModel = (payload: LlmModelPayload) => http.post<LlmModelView>('/models', payload);

export const updateModel = (id: number, payload: Partial<LlmModelPayload>) =>
  http.put<LlmModelView>(`/models/${id}`, payload);

export const deleteModel = (id: number) => http.del<{ ok: boolean; id: number }>(`/models/${id}`);

export const testModel = (id: number) => http.post<ModelTestResult>(`/models/${id}/test`);

export const getBindings = () => http.get<{ bindings: BindingMap }>('/models/bindings');

export const bindRole = (role: string, modelId: number) =>
  http.put<{ ok: boolean; role: string; modelId: number; modelName: string }>(
    `/models/bindings/${role}`,
    { modelId },
  );

// ── 创作计划 ──
export const getPlan = (params?: { account?: string; backlogDays?: number }) =>
  http.get<PlanResult>('/plan', params as Record<string, unknown> | undefined);

export const triggerPlan = (accountId: number, count?: number) =>
  http.post<TriggerResult>('/plan/trigger', { accountId, count });

// ── 调度 ──
export const getSchedulerStatus = () => http.get<SchedulerStatus>('/scheduler');

export const setSchedulerConfig = (patch: Partial<SchedulerConfig>) =>
  http.put<{ ok: boolean; config: SchedulerConfig }>('/scheduler/config', patch);

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

// ── 文章 ──
export const listArticles = (params?: { status?: string; accountId?: number; limit?: number; offset?: number }) =>
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

export const previewArticle = (id: number) => http.get<ArticleRenderResult>(`/articles/${id}/preview`);

export const updateArticleContent = (id: number, contentHtml: string) =>
  http.put<ArticleRenderResult & { status: string }>(`/articles/${id}/content`, { contentHtml });

export const pushArticle = (id: number) => http.post<PushResult>(`/articles/${id}/push`);

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
