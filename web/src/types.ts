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
  /** 审核态（S4-1）：candidate / needs_revision / approved / rejected。 */
  status: AngleStatus;
  /** 已完成审核轮数（0=从未审核）。 */
  reviewRound: number;
  /** 六维评分（未评分为 null——不得视为高质量）。 */
  scores: AngleScores | null;
  /** 总分（0-30，六维等权合计）；未评分为 null。 */
  scoreTotal: number | null;
  /** 评分模型给出的参考建议（不是审核结论）。 */
  scoreSuggestion: string;
  /** 评分失败/缺失原因；null=已评分。 */
  scoreError: string | null;
  /** 待重新评分标记（R1）：approved 编辑退回后 true，重新评分成功后清除；带标记不可审核通过。 */
  rescoreRequired?: boolean;
  /** 去重命中明细（S4-2 metaJson.dedupHits）：L2 历史文章标题提示为主，列表/审核展示用。 */
  dedupHits?: AngleDupHit[];
  /** 引用了该选题的文章数，删除前据此给用户强提示 */
  articleCount: number;
  /** 含 IP 外角色（奶奶/婆婆/老师…）：漫画线画不出来，需要退回文章专用。 */
  offIp?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 选题审核态（D1：status 只管审核态，used 只管消费态）。 */
export type AngleStatus = 'candidate' | 'needs_revision' | 'approved' | 'rejected';
/** 人工审核结论（评分不替代人工审核，此枚举只来自人工操作）。 */
export type AngleReviewVerdict = 'approved' | 'needs_revision' | 'rejected';

/**
 * 去重命中明细（S4-2）。L0 完全重复 / L1 高度相似 → 拦截保存；
 * L2 历史文章标题相似 → 只提示不拦截。
 */
export interface AngleDupHit {
  level: 'L0' | 'L1' | 'L2';
  /** angle=现有选题（L0/L1）；article=历史文章标题（L2）。 */
  sourceType: 'angle' | 'article';
  targetId: number;
  /** 命中的选题内容或历史文章标题。 */
  targetText: string;
  /** 相似度 0~1（L0 固定 1）。 */
  score: number;
  trackId: number | null;
  trackName: string;
  reason: string;
}

/** 六维评分（0-5 整数/维，总分=等权合计 0-30；无权重、无阈值）。 */
export interface AngleScores {
  fit: number;
  scene: number;
  conflict: number;
  method: number;
  safety: number;
  novelty: number;
  total: number;
}

/** TopicReview 审核事件（一候选多轮全留）。 */
export interface TopicReviewRecord {
  id: number;
  angleId: number;
  round: number;
  scores: AngleScores | null;
  riskHits: string[];
  /** 审核时刻的去重命中快照（S4-2 TopicReview.dupHits）。 */
  dupHits?: AngleDupHit[];
  verdict: AngleReviewVerdict;
  reason: string;
  model: string;
  reviewedBy: string;
  createdAt: string;
}

export type AngleUsedFilter = 'unused' | 'used' | 'all';
/** 角度切片过滤值。'all' 只是界面上的「全部」，不下发给后端。 */
export type AngleScopeFilter = 'article' | 'comic' | 'shared';

export interface AngleListQuery {
  trackId: number;
  used?: AngleUsedFilter;
  /** 审核态过滤；'all' 不下发。 */
  status?: AngleStatus | 'all';
  /** 角度切片过滤：article / comic / shared */
  scope?: AngleScopeFilter;
  /** 只看含 IP 外角色的选题。 */
  offIp?: boolean;
  keyword?: string;
  /** score=按总分降序（未评分排最后）。 */
  sort?: 'seq' | 'score';
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
  /** 六维评分成功的条数（S4-1；评分失败按未评分，不自动批准）。 */
  scored: number;
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
  /** 改写后对**最终正文**的成稿体检结果；体检本身出错时为 null（正文仍已保存）。 */
  lint?: ArticleLint | null;
  /** 体检留痕（S4-3）；落库失败为 null 且带 lintPersistError。 */
  lintRun?: ArticleLintRun | null;
  /** 体检结果未能存档的原因（显式暴露，不伪装成已留存）。 */
  lintPersistError?: string;
  /** 面向使用者的一句话结论（含体检是否有问题）。 */
  message?: string;
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
  /** 只含真实创建成功的文章（id>0）；失败项在 failed，不再混入这里。 */
  created: { id: number; title?: string; angleId?: number | null; modelUsed?: string | null; note?: string | null }[];
  /** 本批失败项（无文章 id），仅用于反馈；兼容旧响应缺省为 []。 */
  failed?: { title?: string; angleId?: number | null; note?: string | null }[];
  /** 本批跳过条数；兼容旧响应缺省为 0。 */
  skipped?: number;
  reason?: string | null;
  message: string;
}

// ── 调度 ──

/** 每客户自动化模式（P4）：manual=纯手动 / auto_draft=自动写稿 / auto_draft_push=自动写稿+推草稿箱。
 *  群发红线 AUTO_PUBLISH 与本开关解耦，永不自动。 */
export type AutomationMode = 'manual' | 'auto_draft' | 'auto_draft_push';

export interface SchedulerConfig {
  /** 全局总开关（仅管理员可改）。 */
  enabled: boolean;
  /** 无主账号兜底写稿时间。每用户看 my.writeTime。 */
  writeTime: string;
  /** 无主账号兜底是否推草稿箱。每用户看 my.automationMode。 */
  pushEnabled: boolean;
}

/** 我的每客户自动化配置。 */
export interface MyAutomation {
  automationMode: AutomationMode;
  writeTime: string;
}

/** 推送意图：本次排产到底会不会推到公众号草稿箱。
 *  真源在后端（按每账号 owner 的 automationMode 聚合），前端只消费、不自行推断。 */
export type PushIntentStatus = 'none' | 'partial' | 'all' | 'unknown';

export interface PushIntent {
  /** none=不会推 / partial=部分账号会推 / all=全部就绪账号都会推 / unknown=无就绪账号，无法判断 */
  status: PushIntentStatus;
}

export interface SchedulerStatus {
  running: boolean;
  intervalMs: number;
  config: SchedulerConfig;
  my: MyAutomation;
  modeOptions?: Array<{ value: AutomationMode; label: string }>;
  lastTick: TickResult | null;
  /** 推送意图（服务端真源）。缺省=旧后端，前端不显示横幅而不是猜一个结论。 */
  pushIntent?: PushIntent;
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
  /**
   * 待办队列（S5-UI-2）。后端总是返回该字段；声明为可选只是为了让
   * 「前端已更新、后端还没上」的过渡期不炸——缺失时不渲染待办卡，不伪造数字。
   */
  todos?: TodoBlock;
}

/**
 * 工作台待办（S5-UI-2）。
 *
 * 口径约定（与 server/src/services/dashboard.ts 一一对应）：
 *   - 数字类型是 `number | null`：0 = 查询成功且确实没有；null = 该块查询失败，
 *     UI 必须显示「统计暂不可用」，**不得显示成 0**。
 *   - `angles` 为 null 有两种语义：member 权限（正常）或 admin 的该块查询失败（降级）。
 *     区分方式：看 `degraded` 里是否含 'angles'。
 */
export type TodoScope = 'all' | 'own';

export interface TodoAngleItem {
  id: number;
  trackId: number;
  track: string;
  status: string;
  theme: string;
  content: string;
  /** 六维总分（未评分为 null，不视为高质量）。 */
  scoreTotal: number | null;
  updatedAt: string;
}

export interface TodoAnglesBlock {
  total: number | null;
  candidate: number | null;
  needsRevision: number | null;
  /** 等最久的候选等了几天（按 updatedAt 算）。 */
  oldestWaitingDays: number | null;
  byTrack: Array<{ trackId: number; track: string; candidate: number; needsRevision: number }>;
  recent: TodoAngleItem[];
}

export type TodoArticleReason = 'draft_unpushed' | 'repush' | 'push_failed';

export interface TodoArticleItem {
  id: number;
  title: string;
  status: string;
  pipeline: string;
  account: string | null;
  reason: TodoArticleReason;
  updatedAt: string;
}

export interface TodoArticlesBlock {
  draftUnpushed: number | null;
  repush: number | null;
  pushFailed: number | null;
  /** 漫画待推草稿：独立口径，不与上面三项相加。 */
  comicDraft: number | null;
  oldestDraftDays: number | null;
  recent: TodoArticleItem[];
}

export interface TodoLintItem {
  articleId: number;
  title: string;
  trigger: string;
  errorCount: number;
  warnCount: number;
  checkedAt: string;
  stale: boolean;
}

export interface TodoLintBlock {
  /** 最新一次体检不通过、且记录与当前正文一致的篇数。 */
  failed: number | null;
  recent: TodoLintItem[];
}

export interface TodoRunItem {
  id: number;
  jobType: string;
  accountId: number | null;
  account: string | null;
  articleId: number | null;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
}

export interface TodoRunsBlock {
  windowDays: number;
  /** 窗口内「同键最新一条仍失败」的次数（write/comic_script 是批次，按「次」不看「篇」）。 */
  unresolved: number | null;
  recent: TodoRunItem[];
}

export interface TodoBlock {
  scope: TodoScope;
  angles: TodoAnglesBlock | null;
  articles: TodoArticlesBlock;
  lint: TodoLintBlock;
  runs: TodoRunsBlock;
  /** 查询失败的块名（angles / articles / lint / runs）。权限限制不会出现在这里。 */
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
  /** 最近一次落库的体检记录（S4-3）；从未检查过为 null。 */
  lintRun?: ArticleLintRun | null;
  /** 存档结论所对应的正文已不是当前正文（改过稿/换过版），需重新检查才可信。 */
  lintRunStale?: boolean;
  /** 当前正文指纹（与 lintRun.contentHash 比对判断存档是否过期）。 */
  contentHash?: string;
  /** 本次体检结果未能存档的原因（存在即表示「检查成功但没留痕」，必须展示）。 */
  lintPersistError?: string;
}

/** 单次成稿体检记录：一次检查一行，历史保留（S4-3 落库）。 */
export interface ArticleLintRun {
  id: number;
  /** check=改稿页手动重新检查 / save=保存正文 / push=推送门禁 / revise=AI 改写后自动复检 */
  trigger: 'check' | 'save' | 'push' | 'revise';
  ok: boolean;
  errorCount: number;
  warnCount: number;
  /** 被检查正文的 SHA-256。 */
  contentHash: string;
  createdAt: string;
  stats?: ArticleLint['stats'] | null;
  issues?: ArticleLintIssue[];
  /** 当时生效的规则参数（checks/relax）快照。 */
  rule?: { checks?: string[]; relax?: string[] } | null;
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
  /**
   * 命中片段（后端能精确定位时给出，最多 3 条；带上下文的字符串）。
   * 可选：很多规则（sections/chars/ending_hook 等）没有 hits。
   */
  hits?: string[];
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
  /** 本次操作前是否已有推送痕迹（mediaId/pushDate 任一非空）——用于区分「首次推送失败」与「曾经推送过、后续失败」。 */
  everPushed?: boolean;
  /** 被体检门禁拦下时带上完整报告。 */
  lint?: ArticleLint | null;
  /** 本次推送门禁体检的落库记录（S4-3）。 */
  lintRun?: ArticleLintRun | null;
  /** 门禁体检结果未能存档的原因。 */
  lintPersistError?: string;
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

// ── 文风配置 ──

/** 文风配置项。key：'global' | '{赛道名}' | 'v:global:{dim}' | 'v:{赛道}:{dim}'。 */
export interface StylePromptItem {
  key: string;
  kind: 'global' | 'track' | 'variant';
  prompt: string;
  updatedAt: string;
}

/** 出厂默认值（「恢复默认」用）。variants 的键即配置 key（v:...）。 */
export interface StylePromptDefaults {
  global: string;
  /** 系统提示词（`sys:{赛道}`）：`## system` + `## tail` 两节，含 `{{变量}}`。 */
  systems: Record<string, string>;
  tracks: Record<string, string>;
  variants: Record<string, string>;
  /** 写作规范（`s:{赛道}`）：段落形态 / 强调标注 / 句式补充 / 去AI味（预留）。 */
  specs: Record<string, string>;
  /** 机器规则（`r:{赛道}`）：体检项与选题形态，JSON 文本。 */
  rules: Record<string, string>;
}

/** 系统用户角色（与 ModelRole 区分：那是模型用途绑定）。admin>member>guest 只读。 */
export type UserRole = 'admin' | 'member' | 'guest';

/** 登录/状态返回的用户概要（不含口令）。 */
export interface AuthUser {
  id: number | null;
  username: string;
  role: UserRole;
  status?: 'pending' | 'active' | 'disabled';
  expiresAt?: string | null;
  /** 冒烟旁路 = smoke，正常登录 = session（管理令牌已退场）。 */
  via?: 'session' | 'smoke';
}

/** 鉴权状态（GET /api/auth/status）。不返回令牌本身。 */
export interface AuthStatus {
  authRequired: boolean;
  loggedIn: boolean;
  user: AuthUser | null;
}

/** 用户管理列表项（admin，GET /api/users）。 */
export interface UserAdminItem {
  id: number;
  username: string;
  role: UserRole;
  status: 'pending' | 'active' | 'disabled';
  expiresAt: string | null;
  maxOAAccounts: number;
  createdAt: string;
  oaAccountCount: number;
}

/** 批量删除里单条失败的明细。reason 直接展示给用户，不做二次加工。 */
export interface BulkDeleteFailure {
  id: number;
  reason: string;
}

/**
 * 批量删除结果（POST /api/<资源>/bulk-delete）。
 *
 * 逐条独立执行：一条失败不阻断其余，所以要同时给成功数与失败明细。
 */
export interface BulkDeleteResult {
  ok: boolean;
  /** 去重后的请求条数 */
  total: number;
  /** 成功删除的条数 */
  deleted: number;
  /** 失败明细（逐条带原因） */
  failed: BulkDeleteFailure[];
  /** 附加统计：如级联删了几篇文章、归还了几个选题 */
  details: Record<string, number>;
  /** 面向用户的一句话总结 */
  message: string;
}
