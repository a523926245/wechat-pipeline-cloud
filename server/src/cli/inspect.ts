/**
 * 数据库检视工具：确认迁移结果与凭据加密是否正常。
 *
 * 用法：
 *   node --experimental-strip-types src/cli/inspect.ts
 */

import { prisma } from '../db.ts';
import { decryptSecret, maskSecret } from '../lib/crypto.ts';

async function main(): Promise<void> {
  const tracks = await prisma.track.findMany({ include: { accounts: true, _count: { select: { angles: true } } } });

  console.log('');
  console.log('══════ 赛道 / 账号 ══════');
  for (const t of tracks) {
    console.log(`[${t.slug}] ${t.name}  配额${t.quotaPerDay}/天  角度${t._count.angles}`);
    for (const a of t.accounts) {
      const plain = decryptSecret(a.secretEnc);
      const ok = Boolean(plain) && plain.length >= 20;
      console.log(
        `    ${a.name.padEnd(8)} ${a.credStatus.padEnd(11)} enabled=${a.enabled ? 'Y' : 'N'} ` +
          `secret=${maskSecret(plain) || '(空)'} 解密${ok ? '正常' : '不可用'}`,
      );
    }
  }

  const used = await prisma.angle.count({ where: { used: true } });
  const free = await prisma.angle.count({ where: { used: false } });
  console.log('');
  console.log('══════ 选题库存 ══════');
  console.log(`已用 ${used} · 未用 ${free} · 合计 ${used + free}`);

  const articles = await prisma.article.findMany({
    include: { angle: true, account: true },
    orderBy: { pushDate: 'asc' },
  });
  console.log('');
  console.log('══════ 文章 ══════');
  for (const r of articles) {
    console.log(
      `${r.pushDate} ${r.account?.name ?? '(未关联)'} ${r.angle?.code ?? '(无角度)'} ` +
        `${r.chars}字 ${r.status} 《${r.title.slice(0, 24)}》`,
    );
  }

  const settings = await prisma.setting.findMany();
  console.log('');
  console.log('══════ 设置 ══════');
  for (const s of settings) {
    console.log(`  ${s.k} = ${s.v}${s.readonly ? '  (只读)' : ''}`);
  }

  // 断言
  const orphan = await prisma.angle.count({ where: { used: true, articles: { none: {} } } });
  console.log('');
  console.log(`断言 孤儿已用角度 = ${orphan}（应为 0）`);
  const dupAngle = await prisma.article.groupBy({
    by: ['angleId'],
    where: { angleId: { not: null } },
    having: { angleId: { _count: { gt: 1 } } },
  });
  void dupAngle;
  console.log('');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
