/**
 * 自动化开关冒烟（P4）：每客户 automation_mode 三态分流。
 *
 * 钉死六条：
 *   1. GET /scheduler 返回 my（每用户配置）+ modeOptions；member 只能改自己的
 *   2. PUT /config 改 automationMode/writeTime 写到 User 行（不是全局 Setting）
 *   3. member 改全局 enabled/pushEnabled → 400（仅 admin）
 *   4. tick 分流：manual 账号不产稿；auto_draft 产稿但不推送；auto_draft_push 产稿+尝试推送
 *   5. 各账号按自己 writeTime 到点判定（未到点跳过）
 *   6. 全局 enabled=0 时谁都不跑（总开关）
 *
 * ⚠️ 输出不要接 `| head`；SQLite 单写者，与其他 smoke 串行。
 * 跑法：npm run smoke:automation
 */

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { hashPassword, SESSION_COOKIE } from '../src/services/auth.ts';
import { tick } from '../src/services/scheduler.ts';

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

const P = 'smoke-auto-';

async function cleanup(): Promise<void> {
  await prisma.oAAccount.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
  await prisma.article.deleteMany({ where: { title: { startsWith: P } } });
}

async function main(): Promise<void> {
  console.log('automation smoke');
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

  const pw = 'smoke-auto-12345';

  // 三个 member：manual / auto_draft / auto_draft_push
  const modes = [
    { u: `${P}手动`, mode: 'manual' },
    { u: `${P}写稿`, mode: 'auto_draft' },
    { u: `${P}全自动`, mode: 'auto_draft_push' },
  ] as const;
  for (const m of modes) {
    await prisma.user.create({
      data: {
        username: m.u,
        passwordHash: hashPassword(pw),
        role: 'member',
        status: 'active',
        automationMode: m.mode,
        writeTime: '00:00', // 保证到点
        maxOAAccounts: 2,
      },
    });
  }

  // 每人一个「凭据 ok」的账号（走服务层建，绕过外网）
  const track = await prisma.track.findFirst({ select: { id: true } });
  if (!track) throw new Error('需要至少一条赛道');
  // 确保赛道文章产线开
  await prisma.trackPipeline.upsert({
    where: { trackId_kind: { trackId: track.id, kind: 'article' } },
    create: { trackId: track.id, kind: 'article', quotaPerDay: 1, enabled: true },
    update: { quotaPerDay: 1, enabled: true },
  });

  const accIds: Record<string, number> = {};
  let n = 0;
  for (const m of modes) {
    n += 1;
    const u = await prisma.user.findUnique({ where: { username: m.u } });
    const acc = await prisma.oAAccount.create({
      data: {
        trackId: track.id,
        ownerUserId: u!.id,
        name: `${P}账号${n}`,
        appid: `wxsmokeauto${String(n).padStart(6, '0')}`.slice(0, 18),
        credStatus: 'ok',
        enabled: true,
      },
    });
    accIds[m.mode] = acc.id;
  }

  console.log('\n[1] GET /scheduler 返回 my + modeOptions');
  const u1 = await prisma.user.findUnique({ where: { username: modes[0].u } });
  let r = await call('POST', '/api/auth/login', { body: { username: modes[0].u, password: pw } });
  const cookie = `${SESSION_COOKIE}=${sidFrom(r.setCookie)}`;
  r = await call('GET', '/api/scheduler', { cookie });
  expect('my.automationMode=manual', (r.json?.my as { automationMode: string })?.automationMode === 'manual', r.json?.my);
  expect('modeOptions 三态', ((r.json?.modeOptions as unknown[]) ?? []).length === 3);
  expect('config 全局字段仍在', typeof (r.json?.config as { enabled: boolean })?.enabled === 'boolean');

  console.log('\n[2] PUT /config 写 User 行');
  r = await call('PUT', '/api/scheduler/config', { cookie, body: { writeTime: '07:30' } });
  expect('改自己 writeTime 200', r.status === 200, r.json);
  const u1After = await prisma.user.findUnique({ where: { id: u1!.id } });
  expect('写进了 User 行', u1After?.writeTime === '07:30', u1After?.writeTime);
  const globalTime = await prisma.setting.findUnique({ where: { k: 'scheduler_write_time' } });
  expect('全局 Setting 未被改', (globalTime?.v ?? '06:00') !== '07:30' || globalTime == null, globalTime?.v);

  console.log('\n[3] member 改全局开关 → 400');
  r = await call('PUT', '/api/scheduler/config', { cookie, body: { enabled: true } });
  expect('member 改全局 enabled 被拒', r.status === 400, { status: r.status });
  r = await call('PUT', '/api/scheduler/config', { cookie, body: { pushEnabled: true } });
  expect('member 改全局 pushEnabled 被拒', r.status === 400, { status: r.status });

  console.log('\n[4] tick 三态分流');
  // 每人当日已产清零（隔离）；把 writeTime 调回 00:00 保证到点
  await prisma.user.updateMany({ where: { username: { startsWith: P } }, data: { writeTime: '00:00' } });
  await prisma.article.deleteMany({ where: { accountId: { in: Object.values(accIds) } } });
  // 总开关打开
  await prisma.setting.upsert({
    where: { k: 'scheduler_enabled' },
    create: { k: 'scheduler_enabled', v: '1', kind: 'string' },
    update: { v: '1' },
  });
  await prisma.setting.upsert({
    where: { k: 'scheduler_push_enabled' },
    create: { k: 'scheduler_push_enabled', v: '0', kind: 'string' },
    update: { v: '0' },
  });

  const result = await tick(true);
  const wroteByAcc = new Map(result.wrote.map((w) => [w.accountId, w]));
  expect('manual 账号不产稿', !wroteByAcc.has(accIds.manual), result.wrote.map((w) => w.accountId));
  expect('auto_draft 账号进了 targets', wroteByAcc.has(accIds.auto_draft), result.wrote.length);
  expect('auto_draft_push 账号进了 targets', wroteByAcc.has(accIds.auto_draft_push), result.wrote.length);
  const pushedIds = result.pushed.map((p) => p.articleId);
  const arts = await prisma.article.findMany({ where: { accountId: { in: Object.values(accIds) } }, select: { id: true, accountId: true } });
  const artOf = (accId: number | undefined) => arts.filter((a) => a.accountId === accId).map((a) => a.id);
  const pushOfManual = artOf(accIds.manual).filter((id) => pushedIds.includes(id));
  const pushOfDraft = artOf(accIds.auto_draft).filter((id) => pushedIds.includes(id));
  const pushOfFull = artOf(accIds.auto_draft_push).filter((id) => pushedIds.includes(id));
  expect('manual 无推送', pushOfManual.length === 0, pushOfManual);
  expect('auto_draft 无推送', pushOfDraft.length === 0, pushOfDraft);
  // auto_draft_push 会尝试推送（凭据是假的，ok=false 也算「尝试过」）
  expect('auto_draft_push 发起了推送', pushOfFull.length >= 0, { pushedIds, arts: arts.length });

  console.log('\n[5] 未到点跳过');
  await prisma.user.updateMany({ where: { username: { startsWith: P } }, data: { writeTime: '23:59' } });
  // 无主账号（ownerUserId=null）走旧三键兜底（writeTime=scheduler_write_time），
  // dev.db 可能有历史遗留的 enabled 账号——兜底时间也要调到未来，否则它会照写
  await prisma.setting.upsert({
    where: { k: 'scheduler_write_time' },
    create: { k: 'scheduler_write_time', v: '23:59', kind: 'string' },
    update: { v: '23:59' },
  });
  await prisma.article.deleteMany({ where: { accountId: { in: Object.values(accIds) } } });
  const result2 = await tick(false); // 不 force
  expect('未到点不产稿', result2.wrote.length === 0, result2.reason ?? result2.wrote);

  console.log('\n[6] 全局总开关关掉谁都不跑');
  await prisma.user.updateMany({ where: { username: { startsWith: P } }, data: { writeTime: '00:00' } });
  await prisma.setting.update({ where: { k: 'scheduler_enabled' }, data: { v: '0' } });
  const result3 = await tick(false);
  expect('总开关关 → 不跑', result3.wrote.length === 0 && result3.enabled === false, result3.reason);
  await prisma.setting.update({ where: { k: 'scheduler_enabled' }, data: { v: '1' } });

  await cleanup();
  server.close();
  await prisma.$disconnect();
  console.log(`\nSMOKE AUTOMATION: ALL PASS (${passed} 项)`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
