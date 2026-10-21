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
//
// 2026-10-13 改版：用户反馈「小标题太多、每个小标题下先写概括句、通篇一句一段太碎」，
// 小标题从 9-12 收紧到 3-4，并新增段落形态指标。改动这里等于改动推送门禁，慎动。
export const MIN_SECTIONS = 3;
export const MAX_SECTIONS = 4;
/**
 * 门禁区间比提示词里的目标区间（TARGET_CHARS_MIN/MAX）宽，刻意留公差：
 * 卡死在目标区会把大量只差几十字的好稿误杀，门禁的意义是拦「明显跑偏」。
 */
export const MIN_CHARS = 1300;
export const MAX_CHARS = 2300;
/**
 * 提示词里的**目标**区间（门禁是 MIN/MAX_CHARS，比它宽，刻意留公差）。
 * 抽成常量是因为此前 1800-2200 被硬编码在三处（SYSTEM_PROMPT、buildPrompt tail、
 * repairOnce 的收尾要求），改一处就会与其他两处打架——实测已经出现过
 * 主提示词要 1800-2200、修补提示词要 1300-2300 的自相矛盾。
 */
export const TARGET_CHARS_MIN = 1800;
export const TARGET_CHARS_MAX = 2200;
/**
 * 段落数锚：把「字数」翻译成模型**数得清**的段落数。
 *
 * 2026-10-15 实测依据（同一选题、同一采样参数，共 100+ 次真机调用）：
 * - 模型对**可数**指标（段落数）服从度高，对**不可数**指标（总字数）只能先验估、边写边无法核；
 *   实测同一提示词的字数区间是 971-3883，段数区间却集中在 16-20。
 * - 模型原始产出的段均约 **116 字**（n=8：71/104/135/163/168… 均值 116.2）。
 *   所以 1800-2200 字 ÷ 116 ≈ **16-19 段**，这正是本区间的由来，不是拍的数。
 * - 此前提示词写「每节 6-7 段」却同时要求「至少有一节只有 2 段」——
 *   两条在算术上无解（3×6=18 段 vs 2+7+7=16 段），模型只能取下限，段数从此腰斩。
 *
 * ⚠️ 这里约束的是**模型自己写出的** `<p>` 个数（reflow 之前）。
 * 不要拿它去卡 lint 的 `pCount`：那是 reflow **之后**的数，由 LADDER 切分决定、与模型无关
 * （实测 reflow 把 16.3 段切成 25.1 段，但一个字都不改）。
 */
export const PARA_TARGET_MIN = 17;
export const PARA_TARGET_MAX = 19;
export const MIN_EMPHASIS = 8;
export const MAX_EMPHASIS = 12;
export const MIN_KEY_EMPHASIS = 2;
export const MAX_KEY_EMPHASIS = 3;
export const MAX_RESEARCH_REFS = 2;

// ── 段落形态（2026-10-13 新增，对应 style_dna 的「段落形态规范」） ──
/** 复合长段落的句子数下限（≥ 此值算一个「长段落」）。 */
export const PARA_LONG_MIN_SENT = 3;
/** 复合长段落占正文段落数的最低比例：低于此值说明通篇还是一句一段。 */
export const MIN_LONG_PARA_RATIO = 1 / 3;
/** 一句一段的段落占正文段落数的最高比例：超过就太碎。 */
export const MAX_SHORT_PARA_RATIO = 1 / 2;
/**
 * 单段字数上限（提示级，不拦推送）。
 * 「长短混排」容易被理解反：模型有时把整节糊成一个 300+ 字的巨型段落，
 * 在手机上是一整屏的墙，比一句一段还难读。150 字约等于移动端满屏。
 */
export const MAX_PARA_CHARS = 150;

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
/** 漫画逐格生图的独立锁（慢任务，不阻塞排产主锁）。 */
export const LOCK_COMIC_IMAGE = 'wechat_comic_image';

// ── 日期格式 ──────────────────────────────────────────────
export const DATE_LEN = 10;
