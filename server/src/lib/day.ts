/**
 * 本地日期工具（「业务日」判定的单一真源）。
 *
 * 背景（P0 修复的时区 bug）：此前多处用 `date.toISOString().slice(0, 10)` 计算「今天」——
 * 那是 **UTC 日界**；而 scheduler.parseHm() 用**本地时间**判断到点。在 UTC+8 机器上
 * 06:00 触发时，当天文章的 createdAt 落在 UTC 的「昨天」，todayArticleCount 恒为 0，
 * 配额幂等失效 → 重复出稿。凡涉及「业务日」（配额、流水 runDate、pushDate、backlog）
 * 的判定一律走这里，禁止再直接 toISOString 截日期。
 */

/** 把任意 Date 格式化为本地时区的 YYYY-MM-DD。 */
export function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 当前本地日期 YYYY-MM-DD。 */
export function todayKey(): string {
  return dayKeyOf(new Date());
}

/** 当前本地日期偏移 n 天（n 为负数即过去），返回 YYYY-MM-DD。 */
export function dayKeyOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dayKeyOf(d);
}
