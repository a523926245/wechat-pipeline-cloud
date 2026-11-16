/**
 * 成稿体检（lint）结果的落库与读取。
 *
 * 为什么要有这一层：`lint.ts` 是**纯函数**，只回答「此刻这份正文过不过门禁」。
 * 在 S4-3 之前，结论只在响应里活一次——页面一关就没了，事后谁也说不清
 * 「这篇为什么在 10:31 没过、后来改了什么才过的」。这里把每次执行钉成一行记录，
 * 让检查从「瞬时判定」变成「可追溯的事件」。
 *
 * 三条设计纪律：
 * 1. **一次执行一行，历史不覆盖**。latestLintRun 只是查询口径（按 id 倒序取一），
 *    不是存储口径——旧记录永远在，新结果不会把旧结果挤掉。
 * 2. **落库失败绝不静默**。recordLintRun 不抛异常（不想因为留痕失败把保存/推送搞挂），
 *    但一定返回 `saved:false + error`，并写 error 级日志；调用方必须把它透出到响应里。
 *    吞掉失败会让「检查成功但没保存」看起来像一切正常——这正是本阶段要消灭的问题。
 * 3. **只记录，不参与判定**。推送门禁仍以 publisher 现算的报告为准，本表是留痕不是真源，
 *    不存在「库里说通过就放行」的路径。
 */

import { createHash } from 'node:crypto';

import { prisma } from '../db.ts';
import { packJson, unpackJson } from '../db-json.ts';
import { logger } from '../logger.ts';
import type { LintIssue, LintReport, LintStats } from './lint.ts';

/** 检查触发入口。新增入口必须在这里登记，避免库里出现来历不明的 trigger 值。 */
export type LintTrigger = 'check' | 'save' | 'push';

const TRIGGERS: readonly LintTrigger[] = ['check', 'save', 'push'];

/** 生效规则快照：回答「这条结论是按哪套 checks/relax 算出来的」。 */
export interface LintRuleSnapshot {
  checks?: string[];
  relax?: string[];
}

/** 列表/面板用的精简形态（不含 issues 明细）。 */
export interface LintRunBrief {
  id: number;
  trigger: LintTrigger;
  ok: boolean;
  errorCount: number;
  warnCount: number;
  /** 记录所对应正文的 SHA-256；与当前正文比对可判断「这条结论是否已过期」。 */
  contentHash: string;
  createdAt: string;
}

/** 单条记录的完整形态（含 stats / issues / rule 快照）。 */
export interface LintRunDetail extends LintRunBrief {
  stats: LintStats | null;
  issues: LintIssue[];
  rule: LintRuleSnapshot | null;
}

/** 落库结果。`saved:false` 时 error 必非空——调用方不许把它当成成功。 */
export interface LintPersistResult {
  saved: boolean;
  run?: LintRunBrief;
  error?: string;
}

/** 正文指纹：同一份正文得到同一 hash，用来判断「存档结论还对不对得上当前正文」。 */
export function htmlFingerprint(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

function asTrigger(v: string): LintTrigger {
  return (TRIGGERS as readonly string[]).includes(v) ? (v as LintTrigger) : 'check';
}

interface RunRow {
  id: number;
  trigger: string;
  ok: boolean;
  errorCount: number;
  warnCount: number;
  contentHash: string;
  createdAt: Date;
  statsJson: unknown;
  issuesJson: unknown;
  ruleJson: unknown;
}

function toBrief(r: RunRow): LintRunBrief {
  return {
    id: r.id,
    trigger: asTrigger(r.trigger),
    ok: r.ok,
    errorCount: r.errorCount,
    warnCount: r.warnCount,
    contentHash: r.contentHash,
    createdAt: r.createdAt.toISOString(),
  };
}

function toDetail(r: RunRow): LintRunDetail {
  return {
    ...toBrief(r),
    stats: unpackJson<LintStats>(r.statsJson),
    issues: unpackJson<LintIssue[]>(r.issuesJson) ?? [],
    rule: unpackJson<LintRuleSnapshot>(r.ruleJson),
  };
}

export interface RecordLintInput {
  articleId: number;
  trigger: LintTrigger;
  /** 现算的报告（与门禁同一份，不重新计算、不改写结论）。 */
  report: LintReport;
  /** 被检查的正文，用于算 contentHash。 */
  contentHtml: string;
  /** 生效规则快照（checks/relax），可缺省。 */
  rule?: LintRuleSnapshot;
}

/**
 * 记录一次体检。**不抛异常**——返回 `saved:false` 时调用方必须把 error 透出给使用者。
 */
export async function recordLintRun(input: RecordLintInput): Promise<LintPersistResult> {
  const { articleId, trigger, report, contentHtml, rule } = input;
  try {
    const row = await prisma.articleLintRun.create({
      data: {
        articleId,
        trigger,
        ok: report.ok,
        errorCount: report.errors.length,
        warnCount: report.warnings.length,
        statsJson: packJson(report.stats) ?? undefined,
        issuesJson: packJson(report.issues) ?? undefined,
        ruleJson: packJson(rule ?? null) ?? undefined,
        contentHash: htmlFingerprint(contentHtml),
      },
    });
    return { saved: true, run: toBrief(row) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // error 级：留痕失败是「数据可追溯性丢失」，不是无关噪音，必须能在日志里找到。
    logger.error({ articleId, trigger, err: msg }, '成稿体检结果落库失败');
    return { saved: false, error: msg };
  }
}

/** 最近一次体检记录（按 id 倒序；同一毫秒内多次写入也不会取错）。 */
export async function latestLintRun(articleId: number): Promise<LintRunDetail | null> {
  const row = await prisma.articleLintRun.findFirst({
    where: { articleId },
    orderBy: { id: 'desc' },
  });
  return row ? toDetail(row) : null;
}

/** 历史记录（新的在前）。改稿页用它回答「这篇以前检查过几次、每次结论如何」。 */
export async function listLintRuns(articleId: number, limit = 20): Promise<LintRunDetail[]> {
  const rows = await prisma.articleLintRun.findMany({
    where: { articleId },
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map(toDetail);
}
