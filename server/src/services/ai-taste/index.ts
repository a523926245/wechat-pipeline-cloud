/**
 * 去 AI 味能力（**预留，未实现**）。
 *
 * 背景：2026-11-11 起，去 AI 味从写稿链路里整体移除——提示词条款、`lint` 的
 * `ai_taste` 检查、`constants` 的阈值、`var/deai/ai_taste_check.py`、成稿后处理里的
 * 省略号补齐，全部下线。原因是它作为独立能力还没定型，混在写稿链路里会让
 * 「写文章」这件事的调试信号变浑：改一句提示词，说不清是写作变好了还是机器感变少了。
 *
 * 本文件只留一个**稳定契约**，后期实现时不需要再动架构：
 * - `AI_TASTE_ENABLED` 开关：现在恒 false，接线点因此是死代码；
 * - `analyzeAiTaste()` 恒返回 null，调用方按「没有 AI 味问题」处理。
 *
 * 后期接入时要补的三件事（记在这里，免得忘）：
 * 1. 阈值唯一真源：别再把数字抄一份到 Python 脚本里，导出成 JSON 两边读同一份；
 * 2. 与 `lint` 的关系：建议仍走 warn，**不要**升级成拦推送（误杀风险，实测过）；
 * 3. 与修补循环的关系：AI 味与合规是两根独立的轴，采纳判据必须分开算，
 *    合进一个标量会互相抵消（改好机器感却弄坏字数，看起来「有进步」实际更糟）。
 */

export const AI_TASTE_ENABLED = false;

export interface AiTasteIssue {
  code: string;
  message: string;
}

export interface AiTasteReport {
  /** 0-100，越大越像机器写的。 */
  score: number;
  issues: AiTasteIssue[];
}

export interface AiTasteOptions {
  html: string;
  /** 赛道名：不同赛道的"人味"标准不同，预留。 */
  track?: string;
}

/** 预留：去 AI 味分析。未实现时恒返回 null，调用方按「无问题」处理。 */
export async function analyzeAiTaste(_o: AiTasteOptions): Promise<AiTasteReport | null> {
  return null;
}
