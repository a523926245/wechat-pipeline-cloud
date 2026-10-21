/**
 * A/B 文风对照出稿（2026-10-14「减法实验」专用）。
 *
 * 同一个选题，分别用「全量规则」和「精简规则」各写一篇，把 HTML 落盘，
 * 交给 var/deai/ai_taste_check.py 与本机 quality_check.py 量化对比，最后由人盲评。
 *
 * 跑法：
 *   node --experimental-strip-types scripts/ab-gen.ts --angle=12 --tag=full
 *   STYLE_DNA_FILE=style_dna_slim.json node --experimental-strip-types scripts/ab-gen.ts --angle=12 --tag=slim
 *
 * ⚠️ 永远不写数据库（不落草稿、不占用选题），只写磁盘文件。
 */

import { writeFileSync } from 'node:fs';

import { prisma } from '../src/db.ts';
import { lintArticle } from '../src/services/lint.ts';
import { parseArticle } from '../src/services/parse/index.ts';
import { generateDraft } from '../src/services/writer.ts';

const argv = process.argv.slice(2);
const arg = (k: string, def = ''): string =>
  argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? def;

async function main(): Promise<void> {
  const angleId = Number(arg('angle'));
  const tag = arg('tag', 'out');
  const outPath = arg('out', `var/deai/ab-${tag}.html`);
  if (!Number.isFinite(angleId)) throw new Error('必须指定 --angle=<选题 id>');

  const dnaFile = process.env.STYLE_DNA_FILE?.trim() || 'style_dna.json（默认全量）';

  const angle = await prisma.angle.findUnique({ where: { id: angleId } });
  if (!angle) throw new Error(`选题 ${angleId} 不存在`);
  const track = await prisma.track.findUnique({ where: { id: angle.trackId } });
  if (!track) throw new Error(`选题 ${angleId} 所属赛道不存在`);

  console.log('══ A/B 出稿 ══');
  console.log(`规则集      ${dnaFile}`);
  console.log(`赛道        ${track.name}`);
  console.log(`选题        [${angle.theme}] ${angle.content}`);

  const t0 = Date.now();
  const draft = await generateDraft(angle, track, null);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`模型        ${draft.modelUsed ?? '（未调用，走了骨架草稿）'}  · 耗时 ${secs}s`);
  console.log(`说明        ${draft.note}`);
  if (!draft.modelUsed) throw new Error('没有可用的写作模型，中止（不想浪费一次占位骨架当样本）');

  writeFileSync(outPath, draft.contentHtml, 'utf8');

  const parsed = parseArticle(draft.contentHtml);
  const lint = lintArticle(draft.contentHtml, parsed);

  console.log('\n══ 统计 ══');
  console.log(`小标题 ${parsed.h2Count} · 段落 ${parsed.pCount} · 字数 ${parsed.charCount} · 加粗 ${parsed.boldCount}`);
  console.log(
    `复合长段落 ${lint.stats.longPara}/${parsed.pCount}（${Math.round(lint.stats.longRatio * 100)}%）· ` +
      `一句一段 ${lint.stats.shortPara}（${Math.round(lint.stats.shortRatio * 100)}%）`,
  );

  console.log('\n══ 成稿体检 ══');
  console.log(`结论        ${lint.ok ? '通过，可推送' : '未通过，推送会被拦下'}`);
  for (const i of lint.errors) console.log(`  [error] ${i.code}: ${i.message}`);
  for (const i of lint.warnings) console.log(`  [warn ] ${i.code}: ${i.message}`);
  if (lint.errors.length === 0 && lint.warnings.length === 0) console.log('  无问题');

  console.log(`\n已落盘      ${outPath}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('\n出稿失败：', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
