/**
 * 归属隔离冒烟（P3）：水平越权防护。
 *
 * 钉死六条：
 *   1. member 建号挂自己 ownerUserId，且受 maxOAAccounts 配额约束
 *   2. 列表隔离：member A 只见自己的账号/文章，B 的不可见
 *   3. 单查/改/测/删他人账号 → 404（防枚举）
 *   4. 他人文章的详情/改稿/推送/删除 → 404
 *   5. 往他人账号挂文章 → 404；手动触发他人账号排产 → 404
 *   6. admin（break-glass 令牌）全量可见可管；未归属账号（ownerUserId=null）member 不可见
 *
 * ⚠️ 输出不要接 `| head`；SQLite 单写者，与其他 smoke 串行。
 * 跑法：npm run smoke:ownership
 */

process.env.SMOKE_NO_AUTH = '0';

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { createAccount, deleteAccount } from '../src/services/accounts.ts';
import { hashPassword, SESSION_COOKIE } from '../src/services/auth.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}`, detail ?? '');
  throw new Error(`断言失败：${label}`);
}

const P = 'smoke-own-';

async function cleanup(): Promise<void> {
  // 账号级联删文章；用户删号（会话随之级联）
  await prisma.oAAccount.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
}

async function main(): Promise<void> {
  console.log('ownership smoke');
  await cleanup();

  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; cookie?: string } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.Cookie = opts.cookie;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    const json = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, json: json as Record<string, unknown>, setCookie };
  };

  const sidFrom = (sc: string): string => new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(sc)?.[1] ?? '';

  // ── 准备：admin 会话 + 两个 member ──
  const pw = 'smoke-owner-12345';

  for (const u of [`${P}A`, `${P}B`]) {
    await prisma.user.create({
      data: { username: u, passwordHash: hashPassword(pw), role: 'member', status: 'active', maxOAAccounts: 1 },
    });
  }
  const userA = await prisma.user.findUnique({ where: { username: `${P}A` } });
  const userB = await prisma.user.findUnique({ where: { username: `${P}B` } });
  if (!userA || !userB) throw new Error('用户准备失败');

  const login = async (u: string): Promise<string> => {
    const r = await call('POST', '/api/auth/login', { body: { username: u, password: pw } });
    return `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  };
  const cookieA = await login(`${P}A`);
  const cookieB = await login(`${P}B`);
  // admin 主体（管理令牌已退场）：直插建号 + 真实登录拿会话
  await prisma.user.create({
    data: { username: `${P}admin`, passwordHash: hashPassword(pw), role: 'admin', status: 'active' },
  });
  const adminCookie = await login(`${P}admin`);

  // 建号走服务层（绕过外网测连通），挂 owner
  const track = await prisma.track.findFirst({ select: { id: true } });
  if (!track) throw new Error('需要至少一条赛道');
  const accA = await createAccount({ trackId: track.id, name: `${P}账号A`, appid: `wx${P}A00000000001`.slice(0, 18), secret: 'q7f2h9k1w4e8r5t6y0u3i9o2', ownerUserId: userA.id });
  const accB = await createAccount({ trackId: track.id, name: `${P}账号B`, appid: `wx${P}B00000000001`.slice(0, 18), secret: 'q7f2h9k1w4e8r5t6y0u3i9o2', ownerUserId: userB.id });

  console.log('\n[1] 配额');
  let r = await call('POST', '/api/credentials', {
    cookie: cookieA,
    body: { trackId: track.id, name: `${P}超额`, appid: `wx${P}C00000000001`.slice(0, 18) },
  });
  expect('member 超配额建号被拒（409）', r.status === 409, { status: r.status, body: r.json });

  console.log('\n[2] 列表隔离');
  r = await call('GET', '/api/credentials', { cookie: cookieA });
  const idsA = ((r.json?.items as { id: number }[]) ?? []).map((x) => x.id);
  expect('A 列表只见自己的账号', idsA.length === 1 && idsA[0] === accA.id, idsA);
  r = await call('GET', '/api/credentials', { cookie: cookieB });
  const idsB = ((r.json?.items as { id: number }[]) ?? []).map((x) => x.id);
  expect('B 列表只见自己的账号', idsB.length === 1 && idsB[0] === accB.id, idsB);

  console.log('\n[2b] 只改名称/赛道（Secret 留空）不得重置凭据状态');
  // 回归钉死 2026-11-11 bug：Secret 留空被当成空值参与 decideCredStatus，
  // 只改赛道就把 credStatus 重置成 placeholder、账号被禁用（排产报「仍是占位凭据」）。
  const before = await prisma.oAAccount.findUnique({ where: { id: accA.id } });
  expect('前置：A 账号凭据状态 ok', before?.credStatus === 'ok' && before?.enabled === true, before?.credStatus);
  r = await call('PUT', `/api/credentials/${accA.id}`, {
    cookie: cookieA,
    body: { name: `${P}账号A改名`, trackId: track.id },
  });
  expect('只改名称/赛道保存成功', r.status === 200, r.status);
  expect('保存后 credStatus 仍为 ok', r.json?.credStatus === 'ok', r.json);
  expect('保存后仍启用', r.json?.enabled === true, r.json);
  const after = await prisma.oAAccount.findUnique({ where: { id: accA.id } });
  expect('库里 Secret 未被动过', after?.secretMask === before?.secretMask, after?.secretMask);
  await prisma.oAAccount.update({ where: { id: accA.id }, data: { name: `${P}账号A` } });

  console.log('\n[3] 他人账号单查/改/测/删 → 404');
  r = await call('GET', `/api/credentials/${accB.id}`, { cookie: cookieA });
  expect('A 查 B 账号 404', r.status === 404, r.status);
  r = await call('PUT', `/api/credentials/${accB.id}`, { cookie: cookieA, body: { name: '恶意改名' } });
  expect('A 改 B 账号 404', r.status === 404, r.status);
  r = await call('POST', `/api/credentials/${accB.id}/test`, { cookie: cookieA });
  expect('A 测 B 账号 404', r.status === 404, r.status);
  r = await call('DELETE', `/api/credentials/${accB.id}`, { cookie: cookieA });
  expect('A 删 B 账号 404（级联删文高危路径）', r.status === 404, r.status);
  const bAlive = await prisma.oAAccount.findUnique({ where: { id: accB.id } });
  expect('B 账号还在（没被删掉）', bAlive !== null);

  console.log('\n[4] 他人文章 404');
  const artB = await prisma.article.create({
    data: {
      accountId: accB.id,
      title: `${P}B的文章`,
      contentHtml: '<p>内容</p>',
      pushDate: '2026-11-11',
      idempotencyKey: `${P}-artB-1`,
    },
  });
  r = await call('GET', `/api/articles/${artB.id}`, { cookie: cookieA });
  expect('A 看 B 文章详情 404', r.status === 404, r.status);
  // member 本就无改稿权（content:revise=admin）——403 先于归属校验，同样安全
  r = await call('PUT', `/api/articles/${artB.id}/content`, { cookie: cookieA, body: { contentHtml: '<p>篡改</p>' } });
  expect('A 改 B 文章被拦（403 无改稿权 / 404 无归属）', r.status === 403 || r.status === 404, r.status);
  r = await call('POST', `/api/articles/${artB.id}/push`, { cookie: cookieA });
  expect('A 推 B 文章 404', r.status === 404, r.status);
  r = await call('DELETE', `/api/articles/${artB.id}`, { cookie: cookieA });
  expect('A 删 B 文章 404', r.status === 404, r.status);
  const artBAlive = await prisma.article.findUnique({ where: { id: artB.id } });
  expect('B 文章还在', artBAlive !== null);

  console.log('\n[5] 挂稿/排产越权');
  r = await call('POST', '/api/articles', {
    cookie: cookieA,
    body: { contentHtml: '<p>hi</p>', accountId: accB.id, title: '越权挂稿' },
  });
  expect('A 往 B 账号挂稿 404', r.status === 404, r.status);
  r = await call('POST', '/api/plan/trigger', { cookie: cookieA, body: { accountId: accB.id, count: 1 } });
  expect('A 触发 B 账号排产 404', r.status === 404, r.status);

  console.log('\n[6] 文章列表隔离');
  await prisma.article.create({
    data: {
      accountId: accA.id,
      title: `${P}A的文章`,
      contentHtml: '<p>内容</p>',
      pushDate: '2026-11-11',
      idempotencyKey: `${P}-artA-1`,
    },
  });
  r = await call('GET', '/api/articles?limit=50', { cookie: cookieA });
  const titlesA = ((r.json?.items as { title: string }[]) ?? []).map((x) => x.title);
  expect('A 文章列表只有自己的', titlesA.every((t) => t.startsWith(P + 'A')) && titlesA.length >= 1, titlesA);

  console.log('\n[7] admin 全量 + 未归属账号');
  const orphan = await createAccount({ trackId: track.id, name: `${P}未归属`, appid: `wx${P}D00000000001`.slice(0, 18), secret: 'q7f2h9k1w4e8r5t6y0u3i9o2', ownerUserId: null });
  r = await call('GET', '/api/credentials', { cookie: cookieA });
  const idsA2 = ((r.json?.items as { id: number }[]) ?? []).map((x) => x.id);
  expect('member 看不到未归属账号', !idsA2.includes(orphan.id), idsA2);
  r = await call('GET', '/api/credentials', { cookie: adminCookie });
  const adminIds = ((r.json?.items as { id: number }[]) ?? []).map((x) => x.id);
  expect('admin 全量可见（含未归属）', adminIds.includes(accA.id) && adminIds.includes(accB.id) && adminIds.includes(orphan.id), adminIds.length);
  r = await call('DELETE', `/api/credentials/${orphan.id}`, { cookie: adminCookie });
  expect('admin 可删未归属账号', r.status === 200, r.status);

  console.log('\n[8] deleteAccount 服务层兜底');
  let threw = false;
  try {
    // 模拟入口层漏校验：直接带错 owner 调服务层
    await deleteAccount(accB.id, userA.id);
  } catch {
    threw = true;
  }
  expect('deleteAccount 带错 owner 被拒', threw);
  const bAlive2 = await prisma.oAAccount.findUnique({ where: { id: accB.id } });
  expect('B 账号仍未被删', bAlive2 !== null);

  await cleanup();
  server.close();
  await prisma.$disconnect();
  console.log(`\nSMOKE OWNERSHIP: ALL PASS (${passed} 项)`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
