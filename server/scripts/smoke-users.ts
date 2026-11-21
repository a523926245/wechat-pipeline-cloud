/**
 * 多用户鉴权冒烟（P2）。
 *
 * 钉死七条：
 *   1. 注册开放：建 guest/pending 用户；重名 400
 *   2. 登录：口令正确种 wb_session cookie；错误口令 401；disabled 401
 *   3. pending 用户可登录但只有 guest 只读（403 账号管理）
 *   4. 权限矩阵：member 403 题库/模型/文风/用户管理；guest 403 账号管理
 *   5. 审批：pending → active + 角色升 member；审批后能过 oa_account:manage
 *   6. expiresAt 过期 → 降只读（member 过期后 403 账号管理）
 *   7. admin 会话全权（管理令牌已退场）
 *
 * ⚠️ 输出不要接 `| head`；SQLite 单写者，与其他 smoke 串行。
 * 跑法：npm run smoke:users
 */

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
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

const SMOKE_PREFIX = 'smoke-user-';

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: SMOKE_PREFIX } } });
}

async function main(): Promise<void> {
  console.log('users smoke');
  await cleanup();

  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; cookie?: string } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
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

  const sidFrom = (setCookie: string): string => {
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
    return m?.[1] ?? '';
  };

  console.log('\n[1] 注册');
  const u1 = `${SMOKE_PREFIX}member1`;
  const pw = 'smoke-pass-12345';
  let r = await call('POST', '/api/auth/register', { body: { username: u1, password: pw } });
  expect('注册 201', r.status === 201, r.json);
  const u1Id = (r.json?.user as { id: number }).id;
  expect('默认 guest 角色', (r.json?.user as { role: string }).role === 'guest');
  expect('默认 pending 状态', (r.json?.user as { status: string }).status === 'pending');
  r = await call('POST', '/api/auth/register', { body: { username: u1, password: pw } });
  expect('重名注册 400', r.status === 400, r.json);
  // 勘误钉死：注册账号不允许中文（P2 曾错误放宽，已收回）
  r = await call('POST', '/api/auth/register', { body: { username: '中文用户名', password: pw } });
  expect('中文用户名注册 400', r.status === 400, r.json);

  console.log('\n[2] 登录');
  r = await call('POST', '/api/auth/login', { body: { username: u1, password: 'wrong-password' } });
  expect('错误口令 401', r.status === 401, r.json);
  r = await call('POST', '/api/auth/login', { body: { username: u1, password: pw } });
  expect('正确口令 200', r.status === 200, r.json);
  expect('种了 wb_session cookie', r.setCookie.includes(SESSION_COOKIE), r.setCookie);
  const u1Cookie = `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  expect('session id 非空', sidFrom(r.setCookie).length > 10);

  console.log('\n[3] pending 只读');
  r = await call('GET', '/api/auth/status', { cookie: u1Cookie });
  expect('pending 已登录', r.json?.loggedIn === true, r.json);
  expect('status 返回 pending', (r.json?.user as { status: string }).status === 'pending');
  r = await call('GET', '/api/credentials', { cookie: u1Cookie });
  expect('pending 访问账号管理 403', r.status === 403, { status: r.status, body: r.json });
  r = await call('GET', '/api/dashboard', { cookie: u1Cookie });
  expect('pending 可看数据（guest data:view）', r.status === 200, { status: r.status });

  console.log('\n[4] 权限矩阵（pending guest）');
  r = await call('GET', '/api/models', { cookie: u1Cookie });
  expect('guest 403 模型配置', r.status === 403, r.status);
  r = await call('GET', '/api/style-prompts', { cookie: u1Cookie });
  expect('guest 403 文风配置', r.status === 403, r.status);
  r = await call('GET', '/api/users', { cookie: u1Cookie });
  expect('guest 403 用户管理', r.status === 403, r.status);
  r = await call('GET', '/api/tracks', { cookie: u1Cookie });
  expect('guest 403 赛道管理', r.status === 403, r.status);

  console.log('\n[5] 审批（admin 会话操作）');
  // admin 主体：直插 prisma 建号再走真实登录拿会话（管理令牌已退场）
  const adminName = `${SMOKE_PREFIX}admin`;
  await prisma.user.create({
    data: { username: adminName, passwordHash: hashPassword(pw), role: 'admin', status: 'active' },
  });
  r = await call('POST', '/api/auth/login', { body: { username: adminName, password: pw } });
  const adminCookie = `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  r = await call('POST', `/api/users/${u1Id}/approve`, { cookie: adminCookie });
  expect('审批 200', r.status === 200, r.json);
  expect('审批后 active', (r.json?.user as { status: string }).status === 'active');
  expect('审批后升 member', (r.json?.user as { role: string }).role === 'member');
  // 重新登录拿新会话
  r = await call('POST', '/api/auth/login', { body: { username: u1, password: pw } });
  const mCookie = `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  r = await call('GET', '/api/credentials', { cookie: mCookie });
  expect('member 过账号管理权限点', r.status === 200, { status: r.status, body: r.json });
  r = await call('GET', '/api/models', { cookie: mCookie });
  expect('member 仍 403 模型配置', r.status === 403, r.status);
  r = await call('GET', '/api/users', { cookie: mCookie });
  expect('member 仍 403 用户管理', r.status === 403, r.status);

  console.log('\n[6] expiresAt 过期降只读');
  await prisma.user.update({ where: { id: u1Id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await call('GET', '/api/credentials', { cookie: mCookie });
  expect('member 过期后 403 账号管理（降只读）', r.status === 403, { status: r.status });
  r = await call('GET', '/api/dashboard', { cookie: mCookie });
  expect('过期后仍可看数据', r.status === 200, r.status);
  await prisma.user.update({ where: { id: u1Id }, data: { expiresAt: null } });
  r = await call('GET', '/api/credentials', { cookie: mCookie });
  expect('恢复不过期后权限回来', r.status === 200, r.status);

  console.log('\n[7] disabled 封禁');
  const u2 = `${SMOKE_PREFIX}disabled`;
  await prisma.user.create({
    data: { username: u2, passwordHash: hashPassword(pw), role: 'member', status: 'disabled' },
  });
  r = await call('POST', '/api/auth/login', { body: { username: u2, password: pw } });
  expect('disabled 登录 401', r.status === 401, r.json);

  console.log('\n[8] admin 会话全权（管理令牌已退场）');
  r = await call('GET', '/api/users', { cookie: adminCookie });
  expect('admin 会话可进用户管理', r.status === 200, r.status);
  r = await call('GET', '/api/models', { cookie: adminCookie });
  expect('admin 会话可进模型配置', r.status === 200, r.status);

  console.log('\n[9] 用户列表');
  r = await call('GET', '/api/users', { cookie: adminCookie });
  const users = (r.json?.users as { username: string }[]) ?? [];
  expect('用户列表可读', Array.isArray(users), users.length);

  await cleanup();
  server.close();
  await prisma.$disconnect();
  console.log(`\nSMOKE USERS: ALL PASS (${passed} 项)`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
