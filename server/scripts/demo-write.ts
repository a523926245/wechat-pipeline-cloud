/**
 * 现场写一篇样稿（验文风用，不是生产链路）。
 *
 * 用当前「写作」角色绑定的模型，挑一个未用选题真写一篇文章，落库成草稿，
 * 并把成稿体检结果打到控制台——改完 style_dna.json 或 SYSTEM_PROMPT 后，
 * 靠它肉眼确认新文风是否真的生效了。
 *
 * 跑法：
 *   npm run demo:write                    # 用第一个赛道的第一个未用选题
 *   npm run demo:write -- --angle=12      # 指定选题
 *   npm run demo:write -- --keep          # 保留生成的草稿（默认也保留，加 --dry 才不落库）
 *   npm run demo:write -- --dry           # 只看结果，不落库
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../src/db.ts';
import { parseArticle } from '../src/services/parse/index.ts';
import { renderArticle } from '../src/services/render/index.ts';
import { lintArticle } from '../src/services/lint.ts';
import { generateDraft } from '../src/services/writer.ts';
import { todayKey } from '../src/lib/day.ts';

const argv = process.argv.slice(2);
const arg = (k: string, def = ''): string => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? def;
const DRY = argv.includes('--dry');

async function main(): Promise<void> {
  const angleIdArg = arg('angle');

  const angle = angleIdArg
    ? await prisma.angle.findUnique({ where: { id: Number(angleIdArg) } })
    : await prisma.angle.findFirst({
        where: { used: false, scope: { in: ['article', 'shared'] } },
        orderBy: [{ trackId: 'asc' }, { seq: 'asc' }],
      });
  if (!angle) throw new Error('没有可用的未用选题，先去选题库扩库');

  const track = await prisma.track.findUnique({ where: { id: angle.trackId } });
  if (!track) throw new Error(`选题 ${angle.id} 所属赛道不存在`);

  console.log('══ 现场写稿 ══');
  console.log(`赛道        ${track.name}`);
  console.log(`选题        [${angle.theme}] ${angle.content}`);
  console.log('');

  const t0 = Date.now();
  const draft = await generateDraft(angle, track, null);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`模型        ${draft.modelUsed ?? '（未调用，走了骨架草稿）'}  · 耗时 ${secs}s`);
  console.log(`说明        ${draft.note}`);

  const parsed = parseArticle(draft.contentHtml);
  const rendered = renderArticle(parsed, { titlePrefix: '【话】' });
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

  console.log('\n══ 正文（微信渲染稿）══');
  console.log('标题：', rendered.title);
  console.log('摘要：', rendered.digest);
  console.log(rendered.contentWechat.replace(/<[^>]+>/g, (m) => (m === '</p>' || m === '</h2>' ? '\n' : '')).trim());

  if (DRY) {
    console.log('\n[dry] 未落库。');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction([
    prisma.angle.update({ where: { id: angle.id }, data: { used: true, usedBy: '样稿', usedDate: todayKey() } }),
    prisma.article.create({
      data: {
        trackId: track.id,
        angleId: angle.id,
        pipeline: 'article',
        title: rendered.title,
        digest: rendered.digest,
        contentHtml: draft.contentHtml,
        contentWechat: rendered.contentWechat,
        blocks: parsed.h2Count + parsed.pCount,
        chars: parsed.charCount,
        pushDate: '',
        status: 'draft',
        idempotencyKey: `demo-${randomUUID()}`,
      },
    }),
  ]);

  const created = await prisma.article.findFirst({ where: { title: rendered.title }, orderBy: { id: 'desc' } });
  console.log(`\n已落库草稿 #${created?.id}  →  http://127.0.0.1:5173/articles/${created?.id}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('\n写稿失败：', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
