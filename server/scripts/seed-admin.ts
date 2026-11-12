/**
 * 管理员种子工具。
 *   npm run seed:admin                     幂等建 admin 用户（用户名 admin，口令随机，打印一次）
 *   npm run seed:admin -- --user <name>    指定用户名
 *   npm run seed:admin -- --pass <pw>      指定口令（默认随机生成并打印）
 *
 * 已存在同名用户则不覆盖（幂等）。首个管理员由此产生——开放注册永远不会造出 admin。
 */

import { prisma } from '../src/db.ts';
import { hashPassword } from '../src/services/auth.ts';
import { randomBytes } from 'node:crypto';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const username = argValue('--user') ?? 'admin';
  const existing = await prisma.user.findUnique({ where: { username } });

  // 应急救济：重置已存在用户的口令（管理令牌退场后，忘口令走这里）
  if (argFlag('--reset-pass')) {
    if (!existing) {
      console.error(`用户 ${username} 不存在，无法重置口令。先跑 npm run seed:admin 创建。`);
      process.exit(1);
    }
    const password = argValue('--pass') ?? randomBytes(12).toString('base64url');
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: hashPassword(password), status: existing.status === 'disabled' ? 'active' : existing.status },
    });
    console.log(`已重置 ${username} 的口令。`);
    if (argValue('--pass') === undefined) console.log(`新口令（仅此一次显示）：${password}`);
    return;
  }

  if (existing) {
    console.log(`用户 ${username} 已存在（id=${existing.id}, role=${existing.role}, status=${existing.status}），未做修改。`);
    console.log('忘记口令：npm run seed:admin -- --reset-pass');
    return;
  }
  const password = argValue('--pass') ?? randomBytes(12).toString('base64url');
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: hashPassword(password),
      role: 'admin',
      status: 'active',
      maxOAAccounts: 100,
    },
    select: { id: true, username: true, role: true, status: true },
  });
  console.log(`已创建管理员：${user.username}（id=${user.id}）`);
  if (argValue('--pass') === undefined) {
    console.log(`口令（仅此一次显示）：${password}`);
    console.log('请立即登录并妥善保存；丢失可用 --pass 重置（需先删旧用户）。');
  }
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
