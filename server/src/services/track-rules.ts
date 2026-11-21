/**
 * 赛道机器规则：决定「这条赛道跑哪些专项体检、选题守门走哪套」。
 *
 * 为什么单独一个模块（而不是塞进 style-prompts.ts）：`lint.ts` 必须保持**纯函数**，
 * 不能为了读一条规则就去初始化 Prisma。这里只放常量与查表，DB 读写留在
 * `style-prompts.ts` 的 `loadTrackRule()`。
 *
 * ⚠️ 2026-11-11 之前这两件事写在代码里（`trackName === '星座'` / `=== '育儿'`），
 * 结果是新增一条赛道必须改代码、而且分散在 writer / lint / angles 三个文件里。
 * 现在代码只查这张表；表里的值可以在配置页改（`r:{赛道}`），改完立即生效。
 */

export interface TrackRule {
  /** 启用的赛道专项体检 code（取值与 lint 的 LintIssue.code 一致）。 */
  checks: string[];
  /**
   * 选题形态：
   *  - `default`：通用形态（题面暗含冲突/反差 + 结尾留方法钩子）
   *  - `zodiac`：星座（反差 / 误解 / 行为切片 / 对号入座，禁止咨询式提问）
   *  - `moment`：激励（普通时刻 + 一件小事，不强制冲突与方法钩子）
   *  - `scene`：科技（真实使用场景 + 可感知比喻或判断信号，不强制冲突与方法钩子）
   *
   * ⚠️ **选题生成与选题守门只读代码种子（`ruleFor`），数据库 `StylePrompt` 里的 `angleMode`
   * 不参与选题**。库里的这个字段目前只对"配置页展示 / 人工查阅"有意义；不要以为改库就会
   * 改变选题形态（见 angles.ts 的 buildMessages / topicRejectReason）。
   */
  angleMode: 'default' | 'zodiac' | 'moment' | 'scene';
  /**
   * 该赛道豁免的 **warn** 项（`para_shape` / `para_short` 等）。
   *
   * 段落形态那套判据是给叙事散文定的。星座群像一星座一段、育儿口语体一句一段，
   * 是**形式不同**而不是写坏了；用散文尺子量清单体，每篇都会刷两条假警报。
   * 只能豁免 warn——error 是推送门禁，任何赛道都不能关（lintArticle 里强制）。
   */
  relax?: string[];
}

/**
 * 出厂默认规则。只作**种子**与兜底：
 * 库里配了 `r:{赛道}` 就以库为准（见 style-prompts.ts 的 loadTrackRule）。
 */
export const DEFAULT_TRACK_RULES: Record<string, TrackRule> = {
  星座: {
    checks: ['zodiac_topic', 'zodiac_textbook', 'zodiac_repeat', 'zodiac_dup'],
    angleMode: 'zodiac',
    // 群像切片是一星座一段的短段结构，按散文标准必然触发这两条。
    // ending_hook（S4-5 A 档）：`sys:星座` 明文要求「一句可截图的话，或一句『你是第几个 / @ 那个 XX 座』」，
    // 并禁止抒情提问——判据却要求结尾有问号，是判据与本赛道口径的结构性冲突，不是写坏了。
    relax: ['para_shape', 'para_short', 'ending_hook'],
  },
  育儿: {
    checks: [],
    angleMode: 'default',
    // 四拍清单允许一句一段（判断句要短），这是本赛道的正常节奏。
    // ending_hook：`sys:育儿` 全文没有结尾提问的写法要求（四拍收在「一句顶回去的话」上），
    // 判据要问号等于给这条赛道加了一项它没被要求过的任务。
    relax: ['para_short', 'ending_hook'],
  },
  激励: {
    checks: [],
    // S4-5 B 档：普通时刻 + 一件小事。`sys:激励` 的写稿形态本来就是「一个普通时刻 →
    // 一条发现 → 3-4 件今天能做的小事」，通用选题规则却要求「冲突/反差 + 方法钩子」，
    // 选题层与写稿层对不上，产出容易变成「怎么才能早起」这类咨询题。
    angleMode: 'moment',
    relax: ['para_short'],
  },
  科技: {
    checks: [],
    // S4-5 B 档：真实场景 + 可感知的比喻/判断信号。`sys:科技` 的形态是「一个场景 + 一个比喻
    // + 三个信号 + 两件能做的事」；通用规则会把它推向「XX 会不会取代你」这类技术争议题。
    // 不设 relax：科技是混合节奏，段落判据按默认走。
    angleMode: 'scene',
  },
};

/** 无配置时的默认：没有专项体检 + 通用选题规则。 */
const FALLBACK_RULE: TrackRule = { checks: [], angleMode: 'default' };

/** 某赛道的规则（同步版，只读出厂默认）。需要吃配置页改动时用 loadTrackRule。 */
export function ruleFor(track: string): TrackRule {
  return DEFAULT_TRACK_RULES[track] ?? FALLBACK_RULE;
}
