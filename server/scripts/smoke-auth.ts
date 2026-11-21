/**
 * /api 鉴权冒烟（2026-11-11 上线红线收口；同日管理令牌退场，改为会话版）。
 *
 * 钉死六条：
 *   1. /api/health 与 /api/auth/status 公开
 *   2. 业务接口无会话 401（含 /api/content 静态内容）
 *   3. 错误口令 401；正确口令登录 200 且种 httpOnly 会话 cookie
 *   4. 会话 cookie 能过鉴权；登出后会话失效
 *   5. 无 { token } 登录分支（管理令牌已退场，传 token 一律 400/401）
 *   6. 旁路 SMOKE_NO_AUTH 由其他 smoke 使用，此处不覆盖
 *
 * ⚠️ 输出不要接 `| head`；SQLite 单写者，与其他 smoke 串行。
 * 跑法：npm run smoke:auth
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

const P = 'smoke-auth-';

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
}

async function main(): Promise<void> {
  console.log('auth smoke (session)');
  await cleanup();

  const pw = 'smoke-auth-12345';
  await prisma.user.create({
    data: { username: `${P}user`, passwordHash: hashPassword(pw), role: 'member', status: 'active' },
  });

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
  const sidFrom = (sc: string): string =>
    new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(sc)?.[1] ?? '';

  console.log('\n[1] 公开路径');
  expect('health 公开', (await call('GET', '/api/health')).status === 200);
  expect('auth/status 公开', (await call('GET', '/api/auth/status')).status === 200);

  console.log('\n[2] 未登录拦截');
  expect('业务接口 401', (await call('GET', '/api/style-prompts')).status === 401);
  expect('content 静态内容也拦（401 或 404，不得 200）',
    (await call('GET', '/api/content/index.html')).status !== 200);

  console.log('\n[3] 口令登录');
  let r = await call('POST', '/api/auth/login', { body: { username: `${P}user`, password: 'wrong' } });
  expect('错误口令 401', r.status === 401, r.json);
  r = await call('POST', '/api/auth/login', { body: { username: `${P}user`, password: pw } });
  expect('正确口令 200', r.status === 200, r.json);
  expect('种了 httpOnly 会话 cookie',
    r.setCookie.includes(SESSION_COOKIE) && r.setCookie.includes('HttpOnly'), r.setCookie);
  const cookie = `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  expect('session id 非空', sidFrom(r.setCookie).length > 10);

  console.log('\n[4] 会话鉴权与登出');
  // 用 member 有权的端点验会话（style-prompts 是 admin-only，member 403 是正确行为）
  r = await call('GET', '/api/dashboard', { cookie });
  expect('会话 cookie 访问 200', r.status === 200, r.status);
  r = await call('GET', '/api/auth/status', { cookie });
  expect('已登录 loggedIn=true', r.json?.loggedIn === true, r.json);
  r = await call('POST', '/api/auth/logout', { cookie });
  expect('logout 200', r.status === 200, r.json);
  r = await call('GET', '/api/dashboard', { cookie });
  expect('登出后旧会话 401', r.status === 401, r.status);

  console.log('\n[5] 管理令牌已退场');
  r = await call('POST', '/api/auth/login', { body: { token: 'whatever' } });
  expect('传 token 登录被拒（400/401）', r.status === 400 || r.status === 401, r.status);

  await cleanup();
  server.close();
  await prisma.$disconnect();
  console.log(`\nSMOKE AUTH: ALL PASS (${passed} 项)`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
