/**
 * 一次性播种：为所有现存赛道补齐 TrackPipeline 两行（article / comic）。
 *
 * ## 为什么需要
 *
 * 产线改造（P0）后，配额与开关的读口径统一走 services/pipeline.ts：
 * 缺行时会回落旧语义（article → Track.quotaPerDay / 启用，comic → 0 / 停用），
 * 所以不播种系统也能正确工作。但播种后口径唯一、且漫画产线才有物理行可配置，
 * 建议上线后跑一次。
 *
 * ## 安全约定
 *
 * - 默认 dry-run，加 `--apply` 才写库
 * - 幂等：已有行的赛道直接跳过，绝不覆盖已有配额/开关
 * - article 行沿用该赛道当前的 Track.quotaPerDay 并置 enabled=true（与旧行为一致）
 *
 * 跑法：
 *   npm run seed:pipelines                          # 只看不改
 *   npm run seed:pipelines -- --apply
 */

import { prisma } from '../src/db.ts';
import { ensureSeeded } from '../src/services/pipeline.ts';
import { logger } from '../src/logger.ts';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const tracks = await prisma.track.findMany({ select: { id: true, name: true, quotaPerDay: true } });
  if (tracks.length === 0) {
    logger.info('没有赛道，无需播种');
    return;
  }

  let created = 0;
  for (const t of tracks) {
    const before = await prisma.trackPipeline.findMany({ where: { trackId: t.id }, select: { kind: true } });
    const have = new Set(before.map((r) => r.kind));
    const missing: string[] = [];
    if (!have.has('article')) missing.push('article');
    if (!have.has('comic')) missing.push('comic');

    if (missing.length === 0) {
      logger.info({ track: t.name }, '已播种，跳过');
      continue;
    }
    logger.info(
      { track: t.name, missing, articleQuota: t.quotaPerDay },
      apply ? '播种产线行' : '[dry-run] 将播种产线行',
    );
    if (apply) {
      await ensureSeeded(t.id);
      created += missing.length;
    }
  }

  logger.info({ apply, created }, '播种完成' + (apply ? '' : '（dry-run，加 --apply 才写库）'));
  await prisma.$disconnect();
}

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, '播种失败');
  process.exit(1);
});
