/**
 * 与后端接口一一对应的类型定义。
 * 字段命名沿用后端（驼峰），不做重命名，避免前后端语义漂移。
 */

// ── 通用 ──

export interface OkResult {
  ok: boolean;
  message?: string;
}

// ── 系统 ──

export interface Health {
  ok: boolean;
  env: string;
  db: string;
  driver: string;
  autoPublish: boolean;
  time: string;
}

// ── 凭据 / 账号 ──

export type CredStatus = 'ok' | 'placeholder' | 'invalid' | 'missing';

export interface CredentialItem {
  id: number;
  name: string;
  track: string;
  trackSlug: string;
  appid: string;
  /** 永远只回掩码，后端不返回明文 */
  secretMask: string;
  credStatus: CredStatus | string;
  enabled: boolean;
  author: string;
}

export interface CredentialDetail extends Omit<CredentialItem, 'track' | 'trackSlug'> {
  trackId: number;
}

export interface CredentialUpdatePayload {
  appid?: string;
  secret?: string;
  author?: string;
}

export interface CredTestResult {
  ok: boolean;
  account: string;
  errcode?: number | null;
  message: string;
  detail?: unknown;
  credStatus?: string;
  enabled?: boolean;
}

// ── 模型 ──

export type ModelRole = 'write' | 'revise' | 'cover' | 'expand_angles';

export interface LlmModelView {
  id: number;
  name: string;
  provider: string;
  capability: string;
  baseUrl: string;
  modelId: string;
  apiKeyMask: string;
  paramsJson: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  boundRole: ModelRole | string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmModelPayload {
  name: string;
  provider: string;
  capability: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  paramsJson?: Record<string, unknown>;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
  sample?: string | null;
}

export type BindingMap = Record<string, { modelId: number; modelName: string } | null>;

// ── 创作计划 ──

export interface PlanAngle {
  id: number;
  text: string;
  [k: string]: unknown;
}

export interface PlanTask {
  track: string;
  trackId: number;
  account: string;
  accountId: number;
  need: number;
  alreadyToday: number;
  angles: PlanAngle[];
  short: number;
  avoid: { date: string; title: string }[];
}

export interface PlanResult {
  date: string;
  perDay: Record<number, number>;
  tasks: PlanTask[];
  skipped: { track: string; account: string; reason: string }[];
  warnings: string[];
  backlog: { date: string; account: string; got: number; miss: number }[];
}

export interface TriggerResult {
  ok: boolean;
  accountId: number;
  account: string;
  need: number;
  created: { id: number; title?: string; angleId?: number | null; modelUsed?: string | null }[];
  reason?: string | null;
  message: string;
}

// ── 调度 ──

export interface SchedulerConfig {
  enabled: boolean;
  writeTime: string;
  pushEnabled: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  intervalMs: number;
  config: SchedulerConfig;
  lastTick: TickResult | null;
}

export interface TickWritten {
  accountId: number;
  account: string;
  created: number;
  reason?: string;
}

export interface TickPushed {
  articleId: number;
  ok: boolean;
  message?: string;
}

export interface TickResult {
  date: string;
  at: string;
  due: boolean;
  enabled: boolean;
  reason?: string;
  wrote: TickWritten[];
  pushed: TickPushed[];
}

// ── 仪表盘 ──

export interface DashboardData {
  generatedAt: string;
  date: string;
  counts: {
    tracks: number;
    accounts: { total: number; enabled: number; ready: number };
    angles: { total: number; unused: number; used: number; usageRate: number };
    articles: { total: number; today: number; draft: number; pushed: number; failed: number };
  };
  today: {
    quotaTotal: number;
    produced: number;
    pending: number;
    byAccount: Array<{
      accountId: number;
      account: string;
      track: string;
      quota: number;
      produced: number;
      pending: number;
      angleStock: number;
    }>;
  };
  backlog: Array<{ date: string; account: string; got: number; miss: number }>;
  skipped: Array<{ track: string; account: string; reason: string }>;
  models: {
    total: number;
    enabled: number;
    bindings: BindingMap;
    writeModelReady: boolean;
  };
  health: {
    db: boolean;
    masterKey: boolean;
    autoPublishConstant: boolean;
    autoPublishSetting: string | null;
    scheduler: SchedulerConfig;
  };
  recentRuns: Array<{
    id: number;
    jobType: string;
    status: string;
    trigger: string;
    runDate: string;
    articleId: number | null;
    errorMessage: string;
    createdAt: string;
  }>;
  recentLogs: Array<{ id: number; level: string; stage: string; message: string; createdAt: string }>;
  recentArticles: Array<{
    id: number;
    title: string;
    status: string;
    account: string | null;
    chars: number;
    createdAt: string;
  }>;
  warnings: string[];
  degraded: string[];
}

// ── 文章 ──

export interface ArticleListItem {
  id: number;
  title: string;
  status: string;
  account: string | null;
  accountId: number | null;
  chars: number;
  blocks: number;
  mediaId: string;
  pushDate: string;
  createdAt: string;
}

export interface ArticleDetail {
  id: number;
  title: string;
  digest: string;
  trackId: number | null;
  accountId: number | null;
  angleId: number | null;
  contentHtml: string;
  contentWechat: string;
  coverPath: string;
  mediaId: string;
  status: string;
  pushDate: string;
  blocks: number;
  chars: number;
}

export interface ArticleRenderResult {
  id: number;
  title: string;
  digest: string;
  contentWechat: string;
  h2Count: number;
  pCount: number;
  charCount: number;
  boldCount: number;
  warnings: string[];
}

export interface PushResult {
  ok: boolean;
  id?: number;
  mediaId?: string;
  pushDate?: string;
  message?: string;
  errcode?: number | null;
  detail?: unknown;
}

// ── 强调补全 ──

export interface EmphasisStats {
  [k: string]: number | string | boolean;
}

export interface EmphasisPreview {
  contentHtml: string;
  changed: boolean;
  stats: EmphasisStats;
}

export interface EmphasisApplyResult {
  id: number;
  changed: boolean;
  stats: EmphasisStats;
  title: string;
  digest: string;
  contentWechat: string;
}
