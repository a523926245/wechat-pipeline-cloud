/**
 * 存量旧文风草稿清理。
 *
 * 背景：2026-10-13 文风改版后启用了成稿体检门禁（`services/lint.ts`），
 * 库里 9-12 个小标题、通篇一句一段的旧草稿**永远推不出去**，成了死数据。
 * 这个脚本负责把它们清掉。
 *
 * 设计原则：
 * - **默认 dry-run**：只报告不删，加 `--apply` 才真删。删文章不可逆，不能默认动手。
 * - **默认不碰已推送的**：pushed 的文章已经进了公众号草稿箱，本地行是唯一的 media_id 记录，
 *   删了就查不到对应关系；必须显式 `--include-pushed` 才纳入。
 * - **复用与 HTTP DELETE /:id 完全相同的删除语义**：未送达微信（draft/updated/failed）的文章
 *   占用的选题角度要归还池里，pushed 的不归还（否则同一选题会被再写一遍）。
 *
 * 跑法：
 *   npm run prune:old                 # 只看报告
 *   npm run prune:old -- --apply       # 真删（先看清上面的报告再打）
 *   npm run prune:old -- --apply --include-pushed
 */

import { prisma } from '../src/db.ts';
import { lintArticle } from '../src/services/lint.ts';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const INCLUDE_PUSHED = argv.includes('--include-pushed');
const VERBOSE = argv.includes('--verbose');
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0) || 0;

interface Target {
  id: number;
  title: string;
  status: string;
  accountId: number | null;
  trackId: number | null;
  angleId: number | null;
  createdAt: Date;
  reasons: string[];
}

async function main(): Promise<void> {
  const rows = await prisma.article.findMany({
    where: { pipeline: { not: 'comic' } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      status: true,
      accountId: true,
      trackId: true,
      angleId: true,
      createdAt: true,
      contentHtml: true,
    },
  });

  const failed: Target[] = [];
  const skippedPushed: Target[] = [];
  const passed: number[] = [];

  for (const r of rows) {
    const report = lintArticle(r.contentHtml ?? '');
    if (report.ok) {
      passed.push(r.id);
      continue;
    }
    const t: Target = {
      id: r.id,
      title: r.title,
      status: r.status,
      accountId: r.accountId,
      trackId: r.trackId,
      angleId: r.angleId,
      createdAt: r.createdAt,
      reasons: report.errors.map((e) => e.message),
    };
    if (r.status === 'pushed') skippedPushed.push(t);
    else failed.push(t);
  }

  const targets = INCLUDE_PUSHED ? [...failed, ...skippedPushed] : failed;
  const limited = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;

  console.log('══ 成稿体检扫描 ══');
  console.log(`文章产线总行数        ${rows.length}`);
  console.log(`体检通过（保留）      ${passed.length}`);
  console.log(`体检不通过            ${failed.length + skippedPushed.length}`);
  console.log(`  其中未送达（可删）  ${failed.length}`);
  console.log(`  其中已推送（默认保留）${skippedPushed.length}`);
  console.log(`本次将删除            ${limited.length}${INCLUDE_PUSHED ? '（含已推送）' : ''}`);

  // 按「为什么不合格」归类，先让用户一眼看出是不是批量同因
  const byReason = new Map<string, number>();
  for (const t of failed) {
    const key = t.reasons.join(' | ').slice(0, 60);
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  if (byReason.size > 0) {
    console.log('\n不合格原因分布：');
    for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
  }

  if (limited.length > 0) {
    console.log('\n受影响清单：');
    const show = VERBOSE ? limited : limited.slice(0, 20);
    for (const t of show) {
      console.log(
        `  #${String(t.id).padStart(4)}  [${t.status}]  ${t.title.slice(0, 34).padEnd(36)} ${t.reasons[0] ?? ''}`,
      );
    }
    if (!VERBOSE && limited.length > show.length) {
      console.log(`  … 还有 ${limited.length - show.length} 条，加 --verbose 看全部`);
    }
  }

  if (!APPLY) {
    console.log('\n[dry-run] 未做任何改动。确认无误后加 --apply 执行删除。');
    await prisma.$disconnect();
    return;
  }

  if (limited.length === 0) {
    console.log('\n没有需要删除的行。');
    await prisma.$disconnect();
    return;
  }

  let deleted = 0;
  let recycledAngles = 0;
  for (const t of limited) {
    await prisma.$transaction(async (tx) => {
      // 与 articles.ts 的 DELETE /:id 同语义：只有未送达微信的文章才归还角度。
      if (t.status !== 'pushed' && t.angleId != null) {
        const back = await tx.angle.updateMany({
          where: { id: t.angleId },
          data: { used: false, usedBy: '', usedDate: null, usedById: null, usedByAccountId: null },
        });
        if (back.count > 0) recycledAngles += 1;
      }
      await tx.article.delete({ where: { id: t.id } });
    });
    deleted += 1;
  }

  console.log('\n══ 执行结果 ══');
  console.log(`已删除文章            ${deleted}`);
  console.log(`归还选题角度          ${recycledAngles}`);
  if (skippedPushed.length > 0 && !INCLUDE_PUSHED) {
    console.log(
      `保留已推送的文章      ${skippedPushed.length} 条（如需一并删除请加 --include-pushed）`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('\n清理失败：', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
