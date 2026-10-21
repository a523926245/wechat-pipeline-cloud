/**
 * 一次性修数：把 Article.coverPath 从「绝对路径」规约成「相对 CONTENT_DIR 的路径」。
 *
 * 背景：库里原先存的是本机绝对路径（K:\...\var\content\covers\xxx.png）。换机器后
 * CONTENT_DIR 变了，publisher 的 existsSync 必然 false → 静默推无封面草稿。
 * 代码里已加兼容层（services/content-path.ts），这个脚本负责把历史脏值一次性洗干净。
 *
 * 安全约定：默认 dry-run，加 `--apply` 才写库（与 migrate 一致）。
 *
 * 跑法：npm run fix:cover-paths           # 只看不改
 *      npm run fix:cover-paths -- --apply
 */

import { basename } from 'node:path';

import { prisma } from '../src/db.ts';
import { isRelativeCoverPath } from '../src/services/content-path.ts';

const apply = process.argv.includes('--apply');

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 规约成 `covers/<basename>`；已经是相对路径的也统一斜杠方向。 */
function normalizeCoverPath(raw: string): string {
  const u = posix(raw.trim());
  if (isRelativeCoverPath(raw)) return u.replace(/^\/+/, '');
  return `covers/${basename(u)}`;
}

async function main(): Promise<void> {
  const rows = await prisma.article.findMany({
    where: { coverPath: { not: '' } },
    select: { id: true, coverPath: true },
  });

  const updates: { id: number; from: string; to: string }[] = [];
  for (const r of rows) {
    const to = normalizeCoverPath(r.coverPath);
    if (to !== r.coverPath) updates.push({ id: r.id, from: r.coverPath, to });
  }

  console.log(`扫描 ${rows.length} 条带封面的文章，其中 ${updates.length} 条需要改写：`);
  for (const u of updates.slice(0, 20)) {
    console.log(`  #${u.id}  ${u.from}\n      → ${u.to}`);
  }
  if (updates.length > 20) console.log(`  ...（另有 ${updates.length - 20} 条）`);

  if (!apply) {
    console.log('\n[dry-run] 未写库。确认无误后加 --apply 执行。');
    return;
  }
  if (updates.length === 0) {
    console.log('\n无需改写。');
    return;
  }

  // 数组式事务：每 100 条一批，避免单批 SQL 过大
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    await prisma.$transaction(
      batch.map((u) => prisma.article.update({ where: { id: u.id }, data: { coverPath: u.to } })),
    );
    console.log(`已写入 ${Math.min(i + 100, updates.length)}/${updates.length}`);
  }

  // 后置校验：不应再有绝对路径残留
  const left = await prisma.article.findMany({
    where: { coverPath: { not: '' } },
    select: { coverPath: true },
  });
  const bad = left.filter((r) => !isRelativeCoverPath(r.coverPath));
  console.log(`\n完成：改写 ${updates.length} 条；剩余非相对路径 ${bad.length} 条`);
  if (bad.length > 0) process.exitCode = 1;
}

void main()
  .catch((e) => {
    console.error('修数脚本异常：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
