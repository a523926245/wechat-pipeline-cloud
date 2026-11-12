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
  /** 选题守门形态：'default' 走通用方法钩子规则，'zodiac' 走星座规则。 */
  angleMode: 'default' | 'zodiac';
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
    relax: ['para_shape', 'para_short'],
  },
  育儿: {
    checks: [],
    angleMode: 'default',
    // 四拍清单允许一句一段（判断句要短），这是本赛道的正常节奏。
    relax: ['para_short'],
  },
  激励: {
    checks: [],
    angleMode: 'default',
    relax: ['para_short'],
  },
};

/** 无配置时的默认：没有专项体检 + 通用选题规则。 */
const FALLBACK_RULE: TrackRule = { checks: [], angleMode: 'default' };

/** 某赛道的规则（同步版，只读出厂默认）。需要吃配置页改动时用 loadTrackRule。 */
export function ruleFor(track: string): TrackRule {
  return DEFAULT_TRACK_RULES[track] ?? FALLBACK_RULE;
}

/** 这条赛道是否要跑某项专项体检。 */
export function hasCheck(track: string, code: string, checks?: string[]): boolean {
  return (checks ?? ruleFor(track).checks).includes(code);
}
