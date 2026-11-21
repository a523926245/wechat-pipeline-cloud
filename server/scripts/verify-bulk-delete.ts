/**
 * 批量删除端到端验证（**隔离库**，不碰真实数据）。
 *
 * ⚠️⚠️ 为什么必须隔离：批量删除是全站后果最重的操作之一。
 *    如果直接在真实 dev.db 上验证，脚本里的删除会真的删掉用户的模型/账号/文章，
 *    而且**删掉的模型会连带解绑角色**（写作链路当场下线）。
 *    2026-11-11 我就是这么把用户的 Agnes 主模型和公众号账号删掉的，
 *    靠 dev.db.bak-20261111-pre-clean 备份才救回来——**不要再犯**。
 *
 * 做法：把 dev.db 复制成临时库 → 用临时库起服务 → 所有读写只碰副本 →
 *       跑完删掉副本。真实库全程只被读取一次（复制）。
 *
 * 覆盖（与 smoke:bulk 的断言互补，这里验的是**前端真实请求序列**）：
 *   1. 勾选 → POST /bulk-delete → 刷新列表，确认真的删掉了
 *   2. 部分失败：一条不存在，其余照删，失败项带原因
 *   3. 五类资源端点全通：angles / articles / credentials / tracks / models
 *
 * 跑法：npm run verify:bulk
 */
import 'dotenv/config';

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_DB = join(process.cwd(), 'prisma', 'dev.db');

if (!existsSync(REAL_DB)) {
  console.error(`找不到真实库：${REAL_DB}`);
  process.exit(1);
}

// ── 1. 复制真实库到临时目录（真实库只被读一次） ──
const dir = mkdtempSync(join(tmpdir(), 'wb-bulk-verify-'));
const tmpDb = join(dir, 'dev.db');
copyFileSync(REAL_DB, tmpDb);
console.log(`隔离库：${tmpDb}`);

// ── 2. 用临时库起服务（必须在 import db.ts 之前改 DATABASE_URL） ──
process.env.DATABASE_URL = `file:${tmpDb}`;
process.env.SMOKE_NO_AUTH = '1';

const { createApp } = await import('../src/app.ts');
const { prisma } = await import('../src/db.ts');

const app = createApp();
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

async function j(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

const stamp = Date.now().toString(36);

try {
  // ── 造数据：临时赛道 + 3 条选题 ──
  const tr = await j('POST', '/api/tracks', { name: `VERIFY批量赛道${stamp}`, quotaPerDay: 1 });
  const trackId = tr.json.id as number;
  expect('造临时赛道', typeof trackId === 'number', tr.json);

  const ids: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const a = await j('POST', '/api/angles', {
      trackId,
      content: `VERIFY 批量删除选题 ${i}`,
      theme: `VERIFY${i}`,
    });
    ids.push(a.json.id as number);
  }
  expect('造 3 条选题', ids.length === 3);

  // ── 1. 选题批量删除：列表 → 删 → 刷新，确认真的删掉了 ──
  const before = await j('GET', `/api/angles?trackId=${trackId}&limit=100`);
  expect('删除前列表有 3 条', (before.json.items as unknown[]).length === 3, before.json);

  const del = await j('POST', '/api/angles/bulk-delete', { ids });
  expect('批量删除返回 200', del.status === 200, del.json);
  expect('deleted=3', del.json.deleted === 3, del.json);
  expect('无失败项', (del.json.failed as unknown[]).length === 0, del.json);

  const after = await j('GET', `/api/angles?trackId=${trackId}&limit=100`);
  expect(
    '刷新后列表已空',
    (after.json.items as unknown[]).length === 0,
    after.json,
  );

  // ── 2. 部分失败 ──
  const a2 = await j('POST', '/api/angles', { trackId, content: 'VERIFY 部分失败', theme: 'VERIFYP' });
  const pf = await j('POST', '/api/angles/bulk-delete', { ids: [a2.json.id as number, 999999] });
  expect('部分失败：删掉 1 条', pf.json.deleted === 1, pf.json);
  expect('部分失败：1 条失败', (pf.json.failed as unknown[]).length === 1, pf.json);
  expect(
    '失败项带 id 与原因',
    (pf.json.failed as { id: number; reason: string }[])[0]?.id === 999999 &&
      Boolean((pf.json.failed as { reason: string }[])[0]?.reason),
    pf.json,
  );

  // ── 3. 五类资源端点全通 ──
  const arts = await j('GET', '/api/articles?limit=100');
  const artIds = ((arts.json.items as { id: number }[]) ?? []).slice(0, 1).map((x) => x.id);
  if (artIds.length > 0) {
    const ad = await j('POST', '/api/articles/bulk-delete', { ids: artIds });
    expect('文章批量删端点可用', ad.status === 200 && ad.json.deleted === artIds.length, ad.json);
  }

  const accs = await j('GET', '/api/credentials');
  const accId = ((accs.json.items as { id: number }[]) ?? [])[0]?.id;
  if (accId) {
    const cd = await j('POST', '/api/credentials/bulk-delete', { ids: [accId] });
    expect('账号批量删端点可用', cd.status === 200 && cd.json.deleted === 1, cd.json);
  }

  const td = await j('POST', '/api/tracks/bulk-delete', { ids: [trackId] });
  expect('赛道批量删端点可用', td.status === 200 && td.json.deleted === 1, td.json);
  const afterT = await j('GET', '/api/tracks');
  expect(
    '赛道已消失',
    !((afterT.json.items as { id: number }[]) ?? []).some((x) => x.id === trackId),
  );

  const ms = await j('GET', '/api/models');
  const mid = ((ms.json.items as { id: number }[]) ?? [])[0]?.id;
  if (mid) {
    const md = await j('POST', '/api/models/bulk-delete', { ids: [mid] });
    expect('模型批量删端点可用', md.status === 200 && md.json.deleted === 1, md.json);
    expect('模型删除统计了解绑角色数', typeof md.json.details?.unboundRoles === 'number', md.json);
  }

  console.log(`\n全部通过：${passed} 项断言（隔离库，真实数据未受影响）`);
} finally {
  server.close();
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
  console.log('隔离库已清理');
}
