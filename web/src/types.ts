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
  trackId: number;
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

/** 新建账号：Secret 可留空，建成 missing/placeholder 待补。 */
export interface AccountCreatePayload {
  trackId: number;
  name: string;
  appid: string;
  secret?: string;
  author?: string;
}

/** 删除账号的级联结果。 */
export interface AccountDeleteResult {
  ok: boolean;
  id: number;
  name: string;
  deletedArticles: number;
  recycledAngles: number;
  message: string;
}

// ── 赛道 ──

export interface TrackItem {
  id: number;
  name: string;
  slug: string;
  quotaPerDay: number;
  enabled: boolean;
  accountCount: number;
  articleCount: number;
  angleTotal: number;
  angleUnused: number;
}

/** 选题明细。消费态（used/usedBy/usedDate）由系统维护，前端只展示。 */
export interface AngleItem {
  id: number;
  trackId: number;
  code: string;
  seq: number;
  theme: string;
  content: string;
  /** 角度池切片（article / comic / shared）。 */
  scope?: 'article' | 'comic' | 'shared';
  used: boolean;
  usedBy: string;
  usedDate: string | null;
  source: string;
  /** 引用了该选题的文章数，删除前据此给用户强提示 */
  articleCount: number;
  /** 含 IP 外角色（奶奶/婆婆/老师…）：漫画线画不出来，需要退回文章专用。 */
  offIp?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AngleUsedFilter = 'unused' | 'used' | 'all';
/** 角度切片过滤值。'all' 只是界面上的「全部」，不下发给后端。 */
export type AngleScopeFilter = 'article' | 'comic' | 'shared';

export interface AngleListQuery {
  trackId: number;
  used?: AngleUsedFilter;
  /** 角度切片过滤：article / comic / shared */
  scope?: AngleScopeFilter;
  /** 只看含 IP 外角色的选题。 */
  offIp?: boolean;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface AngleListResult {
  total: number;
  limit: number;
  offset: number;
  items: AngleItem[];
}

/** 赛道下的产线（文章 / 漫画）配置视图。seeded=false 表示用的是回落值。 */
export interface TrackPipelineItem {
  kind: string;
  quotaPerDay: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  seeded: boolean;
  /** 该产线真正吃得到的未用角度数（按 scope 切片统计）。0 = 开了也出不了稿。 */
  angleUnused: number;
}

export interface AnglePayload {
  trackId: number;
  theme?: string;
  content: string;
  source?: string;
  /** 角度切片，默认 article；给漫画产线用要传 comic 或 shared。 */
  scope?: AngleScopeFilter;
}

export interface AngleUpdatePayload {
  theme?: string;
  content?: string;
  /** 改切片 = 把这条选题划给另一条产线。 */
  scope?: AngleScopeFilter;
}

export interface AngleDeleteResult {
  ok: boolean;
  id: number;
  trackId: number;
  theme: string;
  used: boolean;
  /** 因删除本选题而被解除关联的文章数 */
  unlinkedArticles: number;
  message: string;
}

export interface TrackPayload {
  name: string;
  slug?: string;
  quotaPerDay?: number;
  enabled?: boolean;
}

export interface TrackUpdatePayload {
  name?: string;
  quotaPerDay?: number;
  enabled?: boolean;
}

/** 选题扩库结果。 */
export interface TrackExpandResult {
  ok: boolean;
  trackId: number;
  track: string;
  requested: number;
  added: number;
  skippedDuplicate: number;
  generated: number;
  /** 本批产出的角度切片 */
  scope: AngleScopeFilter;
  /** 该切片扩完后的未用条数 */
  scopeUnused: number;
  poolTotal: number;
  poolUnused: number;
  message: string;
}

// ── 模型 ──

/**
 * 四个维度彼此独立，前端不要混用：
 * - vendor   谁提供（OpenAI / DeepSeek / Agnes / 自定义…）
 * - protocol 怎么调（OpenAI 对话 / OpenAI 生图 / Agnes 生图…）
 * - capability 产出什么（文本 / 图片 / 视频 / 多模态）
 * - role     哪个业务环节用它（写作 / 改写 / 封面 / 扩角度）
 */
export type ModelRole = 'write' | 'revise' | 'cover' | 'expand_angles';
export type ModelCapability = 'text' | 'image' | 'video' | 'multimodal';
export type ModelProtocol =
  | 'openai_chat'
  | 'openai_images'
  | 'agnes_image'
  | 'anthropic_messages'
  | 'openai_video';

export interface LlmModelView {
  id: number;
  name: string;
  vendor: string;
  protocol: ModelProtocol | string;
  capability: ModelCapability | string;
  baseUrl: string;
  modelId: string;
  apiKeyMask: string;
  paramsJson: Record<string, unknown>;
  enabled: boolean;
  /** 一个模型可被多个角色共用，所以是数组而不是单个值。 */
  boundRoles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LlmModelPayload {
  name: string;
  vendor?: string;
  protocol: ModelProtocol | string;
  capability: ModelCapability | string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  paramsJson?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
  sample?: string | null;
}

export type BindingMap = Record<string, { modelId: number; modelName: string } | null>;

/** GET /models/meta：候选项与中文标签全部由后端下发，前端不再硬编码一份。 */
export interface ModelMeta {
  vendors: VendorOption[];
  protocols: ProtocolOption[];
  capabilities: CapabilityOption[];
  roles: RoleSpecDto[];
  imageDefaults: {
    size: string;
    ratio: string;
    sizes: string[];
    ratios: string[];
  };
}

export interface VendorOption {
  id: string;
  label: string;
  defaultBaseUrl: string;
  protocols: string[];
  note?: string;
}

export interface ProtocolOption {
  value: string;
  label: string;
  kind: 'chat' | 'image' | 'video' | 'other';
  /** false 的协议后端会拒绝保存，前端置灰并说明原因。 */
  implemented: boolean;
}

export interface CapabilityOption {
  value: string;
  label: string;
  desc?: string;
}

export interface RoleSpecDto {
  role: ModelRole | string;
  label: string;
  desc: string;
  /** 该角色接受的能力；选模型时用它过滤候选项。 */
  capabilities: string[];
  /** 该角色接受的协议。 */
  protocols: string[];
  kind: string;
  active: boolean;
}

/** GET /models/resolve/:role：解释「为什么这个角色现在不可用」。 */
export interface RoleResolveResult {
  role: string;
  model: LlmModelView | null;
  usable: boolean;
  reason: string | null;
}

// ── AI 改写 ──

export type ReviseMode = 'polish' | 'rewrite' | 'shorten';

export interface RevisePreviewResult {
  contentHtml: string;
  modelName: string;
  changed: boolean;
}

export interface ReviseApplyResult {
  id: number;
  changed: boolean;
  modelName: string;
  title: string;
  digest: string;
  contentWechat: string;
}

// ── 封面生图 ──

export interface CoverGenerateResult {
  ok: boolean;
  id: number;
  coverPath: string;
  /** 形如 /api/content/covers/xxx.png，走 Vite 的 /api 代理。 */
  coverUrl: string;
  prompt: string;
  modelName: string;
  size: string;
  ratio: string;
  bytes: number;
  message: string;
}

export interface CoverPayload {
  prompt?: string;
  size?: string;
  ratio?: string;
}

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
  /** 产线（article / comic）。 */
  pipeline: 'article' | 'comic';
  need: number;
  alreadyToday: number;
  /** 本账号本产线配额。 */
  perDay: number;
  angles: PlanAngle[];
  short: number;
  avoid: { date: string; title: string }[];
}

export interface PlanResult {
  date: string;
  /** key = `${trackId}:${pipeline}`。 */
  perDay: Record<string, number>;
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
  created: { id: number; title?: string; angleId?: number | null; modelUsed?: string | null; note?: string | null }[];
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
  /** 阶段二（漫画生图）推进摘要；本轮没跑漫画时为 null。 */
  comic: {
    done: number;
    failed: number;
    /** 退避窗口内跳过、留给后续心跳的格数。 */
    skipped: number;
    rounds: number;
  } | null;
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
      /** 产线（article / comic）。 */
      pipeline?: string;
      quota: number;
      produced: number;
      pending: number;
      angleStock: number;
    }>;
    /** 按产线汇总（同一账号可跑多条产线，分开看才知道哪条线欠账）。 */
    byPipeline?: Array<{
      pipeline: string;
      quota: number;
      produced: number;
      pending: number;
      accounts: number;
    }>;
  };
  backlog: Array<{ date: string; account: string; got: number; miss: number }>;
  skipped: Array<{ track: string; account: string; reason: string }>;
  models: {
    total: number;
    enabled: number;
    bindings: BindingMap;
    writeModelReady: boolean;
    roleAvailability: Record<string, RoleAvailability>;
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

/** 仪表盘里每个角色的可用性摘要，ready=false 时 reason 解释原因。 */
export interface RoleAvailability {
  bound: boolean;
  modelName?: string;
  ready: boolean;
  reason?: string;
}

/** 轻量系统状态（GET /api/dashboard/status）：侧边栏常驻显示用。 */
export interface SystemStatus {
  generatedAt: string;
  models: {
    total: number;
    enabled: number;
    bindings: BindingMap;
    writeModelReady: boolean;
    roleAvailability: Record<string, RoleAvailability>;
  };
  health: {
    db: boolean;
    masterKey: boolean;
    autoPublishConstant: boolean;
    autoPublishSetting: string | null;
    scheduler: SchedulerConfig;
  };
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
  /** 产线（article / comic），缺省 article。 */
  pipeline?: string;
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
  createdAt: string;
  /** 产线（article / comic），缺省 article。 */
  pipeline?: string;
  /** 漫画元数据（pipeline='comic' 时存在）。 */
  comicJson?: Record<string, unknown> | null;
}

/** 内容标题前缀（文章 / 漫画各一条）。 */
export interface ContentPrefixItem {
  key: string;
  value: string;
  default: string;
  desc: string;
}

export interface ComicPanelItem {
  id: number;
  seq: number;
  lines: string;
  status: string;
  attempt: number;
  errorMsg: string;
  bytes: number;
  previewUrl: string | null;
  prompt: string;
}

export interface ComicPanelsResult {
  total: number;
  success: number;
  /** 已达重跑上限、需手动重画的格数。 */
  failed?: number;
  /** 后台是否正在自动生图（前端据此显示进度、禁用手动按钮）。 */
  generating?: boolean;
  items: ComicPanelItem[];
}

export interface ComicGenerateResult {
  ok: boolean;
  processed: number;
  done: number;
  failed: number;
  /** 退避窗口内被跳过、等待下次重试的格数。 */
  skipped?: number;
  /** 调用后后台是否处于生图状态（本接口会顺带把自动推进点着）。 */
  generating?: boolean;
  kicked?: boolean;
  articleReady: number[];
  details: { articleId: number; seq: number; ok: boolean; message: string }[];
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
  /** 漫画：插图是否已就绪（contentWechat 是否为落库的推送产物）。 */
  comicReady?: boolean;
  /** 漫画：还差几格未生成。 */
  comicPending?: number;
  /** 漫画未就绪时的说明文案。 */
  message?: string;
  /** 成稿体检（文章产线才有；漫画为 null）。未通过时推送会被门禁拦下。 */
  lint?: ArticleLint | null;
}

/** 成稿体检报告：与推送门禁同一套规则。 */
export interface ArticleLint {
  ok: boolean;
  stats: {
    h2Count: number;
    pCount: number;
    charCount: number;
    boldCount: number;
    keyCount: number;
    longPara: number;
    shortPara: number;
    longRatio: number;
    shortRatio: number;
  };
  issues: ArticleLintIssue[];
  errors: ArticleLintIssue[];
  warnings: ArticleLintIssue[];
}

export interface ArticleLintIssue {
  /** error 会拦推送，warn 只提示。 */
  level: 'error' | 'warn';
  code: string;
  message: string;
}

export interface PushResult {
  ok: boolean;
  id?: number;
  mediaId?: string;
  pushDate?: string;
  message?: string;
  errcode?: number | null;
  detail?: unknown;
  reason?: string;
  /** 被体检门禁拦下时带上完整报告。 */
  lint?: ArticleLint | null;
  coverMissing?: boolean;
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
