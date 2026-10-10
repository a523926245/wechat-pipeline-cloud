/**
 * 不可动摇的常量与业务规则。
 *
 * 这里的常量不允许通过配置或数据库覆盖 —— 那是本项目的安全底线。
 */

/** 群发永不自动，文章只到草稿箱。publisher 中不允许出现任何 masssend 调用。 */
export const AUTO_PUBLISH = false as const;

/** 40164 = 调用方 IP 不在公众号白名单，重试无意义，必须人工加白名单。 */
export const ERR_NO_RETRY = new Set([40164]);
/** token 失效类：强制刷新 token 后重试一次。 */
export const ERR_REFRESH_TOKEN = new Set([40001, 42001]);
/** 网络/限流类：指数退避重试。 */
export const ERR_RETRYABLE = new Set([-1, 45009, 45015, 45016]);

export const MAX_RETRY = 4;
export const RETRY_BASE_DELAY = 1.5;

// ── 凭据门禁 ──────────────────────────────────────────────
export const APPID_LEN = 18;
export const APPID_PREFIX = 'wx';
export const SECRET_MIN_LEN = 20;
export const PLACEHOLDER_PATTERNS = ['填入', 'placeholder', 'todo', 'xxx', 'your_'];

// ── 创作规范（与 config/style_dna.json 一致，这里只放程序可校验的硬指标） ──
export const MIN_SECTIONS = 9;
export const MAX_SECTIONS = 12;
export const MIN_CHARS = 1500;
export const MAX_CHARS = 2000;
export const MIN_EMPHASIS = 8;
export const MAX_EMPHASIS = 12;
export const MIN_KEY_EMPHASIS = 2;
export const MAX_KEY_EMPHASIS = 3;
export const MAX_RESEARCH_REFS = 2;

// ── 去重阈值（与本机 add_angles.py 保持一致，改动需同步） ──
export const SIM_ANGLE = 0.45;
export const SIM_HISTORY = 0.35;
export const THEME_CAP = 8;
/** 太短的句子不算包含率，避免短句偶然命中。 */
export const MIN_GRAMS_FOR_CONTAINMENT = 8;
/** 包含率的折扣：直接取 max 会误伤，减去这个量再和 Jaccard 比。 */
export const CONTAINMENT_PENALTY = 0.15;

// ── 幂等与锁 ──────────────────────────────────────────────
export const LOCK_TIMEOUT_SEC = 10;
export const LOCK_PLAN = 'wechat_plan';
export const LOCK_TOKEN = 'wechat_token';

// ── 日期格式 ──────────────────────────────────────────────
export const DATE_LEN = 10;
