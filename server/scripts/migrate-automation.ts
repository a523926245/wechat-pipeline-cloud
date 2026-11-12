/**
 * P4 迁移：把旧的全局调度三键（scheduler_enabled/write_time/push_enabled）导入每个用户的
 * automationMode/writeTime。一次性跑，幂等（只覆盖未改动过的默认值）。
 *
 *   npm run migrate:automation            把全局口径复制给所有用户
 *   npm run migrate:automation -- --dry   只看将发生什么，不落库
 *
 * 推导：enabled=0 → manual；enabled=1 且 push=0 → auto_draft；enabled=1 且 push=1 → auto_draft_push。
 * 全局三键保留（scheduler_enabled=总开关；其余=无主账号兜底），本脚本不动它们。
 */

import { prisma } from '../src/db.ts';

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const dry = argFlag('--dry');
  const rows = await prisma.setting.findMany({
    where: { k: { in: ['scheduler_enabled', 'scheduler_write_time', 'scheduler_push_enabled'] } },
  });
  const byKey = new Map(rows.map((r) => [r.k, r.v] as const));
  const enabled = byKey.get('scheduler_enabled') === '1';
  const push = byKey.get('scheduler_push_enabled') === '1';
  const writeTime = byKey.get('scheduler_write_time') ?? '06:00';
  const mode = !enabled ? 'manual' : push ? 'auto_draft_push' : 'auto_draft';

  console.log(`全局口径：enabled=${enabled} push=${push} writeTime=${writeTime}`);
  console.log(`推导模式：${mode}`);

  const users = await prisma.user.findMany({
    select: { id: true, username: true, automationMode: true, writeTime: true },
  });
  if (users.length === 0) {
    console.log('没有用户，无需迁移。');
    return;
  }
  let touched = 0;
  for (const u of users) {
    // 只覆盖「还是出厂默认 manual/06:00」的用户，避免碾掉用户已做的选择
    const untouched = u.automationMode === 'manual' && u.writeTime === '06:00';
    if (!untouched) {
      console.log(`跳过 ${u.username}（已自定义 mode=${u.automationMode} time=${u.writeTime}）`);
      continue;
    }
    touched += 1;
    if (dry) {
      console.log(`[dry] ${u.username} → mode=${mode} writeTime=${writeTime}`);
    } else {
      await prisma.user.update({
        where: { id: u.id },
        data: { automationMode: mode, writeTime },
      });
      console.log(`已迁移 ${u.username} → mode=${mode} writeTime=${writeTime}`);
    }
  }
  console.log(`${dry ? '[dry] ' : ''}完成：${touched}/${users.length} 个用户受影响。`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
