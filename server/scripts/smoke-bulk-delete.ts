/**
 * 批量删除端到端冒烟：单进程起 app + fetch，跑完自清理，不依赖任何真实上游。
 *
 * 覆盖五类资源的 bulk-delete 端点：
 *   1. 选题 angles：删除后文章只解绑、正文保留（与单条删除同一语义）
 *   2. 文章 articles：未推送的归还选题角度、已推送的不归还
 *   3. 账号 credentials：级联删名下文章 + 归还未推送文章占用的角度
 *   4. 赛道 tracks：**赛道下有账号则拒绝删除**（批量里不放宽这条规则）
 *   5. 模型 models：先解绑再删，不留悬空外键
 *
 * 另外覆盖三个通用行为：
 *   - **部分失败**：一条失败不阻断其余，failed[] 逐条带原因
 *   - **去重**：ids 重复只删一次，计数不虚高
 *   - **参数校验**：空数组 / 超量 / 非数字 → 400 不是 500
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * 跑法：npm run smoke:bulk（SQLite 单写者，必须与其他 smoke 串行）
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

interface BulkResult {
  ok: boolean;
  total: number;
  deleted: number;
  failed: { id: number; reason: string }[];
  details: Record<string, number>;
  message: string;
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const stamp = Date.now().toString(36);
  const trackName = `__smoke_bulk_${stamp}__`;
  let trackId = 0;
  let track2Id = 0;

  async function call(
    prefix: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/${prefix}${path}`, {
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

  try {
    const track = await prisma.track.create({
      data: { name: trackName, slug: `smoke-bulk-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    trackId = track.id;
    const track2 = await prisma.track.create({
      data: { name: `${trackName}_2`, slug: `smoke-bulk-2-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    track2Id = track2.id;

    // ── 造数据 ──
    const mkAngle = (seq: number, used = false) =>
      prisma.angle.create({
        data: {
          trackId,
          code: `smoke-bulk-${stamp}-${seq}`,
          seq,
          theme: `批量主题${seq}`,
          content: `批量删除冒烟用选题 ${seq}`,
          used,
          usedBy: used ? 'smoke-account' : '',
          usedDate: used ? '2026-11-11' : null,
          source: 'smoke',
        },
      });
    const a1 = await mkAngle(1);
    const a2 = await mkAngle(2);
    const a3 = await mkAngle(3, true);

    // a3 被一篇草稿占用 → 删选题时文章只解绑
    const art1 = await prisma.article.create({
      data: {
        trackId,
        angleId: a3.id,
        title: '冒烟-批量关联草稿',
        contentHtml: '<h1>冒烟-批量关联草稿</h1><p>正文内容保持不变。</p>',
        contentWechat: '<p>正文内容保持不变。</p>',
        idempotencyKey: `smoke-bulk-${stamp}-art1`,
        pushDate: '2026-11-11',
        status: 'draft',
      },
    });
    // 已推送的文章：占用角度但删文章时不归还
    const a4 = await mkAngle(4, true);
    const art2 = await prisma.article.create({
      data: {
        trackId,
        angleId: a4.id,
        title: '冒烟-批量已推送',
        contentHtml: '<h1>冒烟-批量已推送</h1><p>已推送内容。</p>',
        contentWechat: '<p>已推送内容。</p>',
        idempotencyKey: `smoke-bulk-${stamp}-art2`,
        pushDate: '2026-11-11',
        status: 'pushed',
      },
    });

    // ── 1. 参数校验：空数组 / 非数字 / 超量 → 400 ──
    let r = await call('angles', 'POST', '/bulk-delete', { ids: [] });
    expect('1 空 ids → 400', r.status === 400, r.json);
    r = await call('angles', 'POST', '/bulk-delete', { ids: ['abc'] });
    expect('1 非数字 id → 400', r.status === 400, r.json);
    r = await call('angles', 'POST', '/bulk-delete', {
      ids: Array.from({ length: 201 }, (_, i) => i + 1),
    });
    expect('1 超量(201) → 400', r.status === 400, r.json);

    // ── 2. 选题批量删除：文章只解绑、正文保留 ──
    r = await call('angles', 'POST', '/bulk-delete', { ids: [a1.id, a2.id, a3.id] });
    let bulk = r.json as unknown as BulkResult;
    expect('2 选题批量删 3 条全部成功', r.status === 200 && bulk.deleted === 3, r.json);
    expect('2 无失败项', bulk.failed.length === 0, r.json);
    expect('2 汇总了被解绑的文章数', bulk.details.unlinkedArticles === 1, r.json);

    const art1After = await prisma.article.findUnique({ where: { id: art1.id } });
    expect('2 关联文章仍在（正文保留）', art1After !== null, art1After);
    expect('2 关联文章的选题已解绑', art1After?.angleId === null, art1After);
    const gone = await prisma.angle.count({ where: { id: { in: [a1.id, a2.id, a3.id] } } });
    expect('2 三条选题都没了', gone === 0);

    // ── 3. 选题批量删除·部分失败：一条不存在，其余照删 ──
    const a5 = await mkAngle(5);
    r = await call('angles', 'POST', '/bulk-delete', { ids: [a5.id, 999999] });
    bulk = r.json as unknown as BulkResult;
    expect('3 部分失败：删掉 1 条', r.status === 200 && bulk.deleted === 1, r.json);
    expect('3 部分失败：1 条失败', bulk.failed.length === 1, r.json);
    expect('3 失败项带 id', bulk.failed[0]?.id === 999999, r.json);
    expect('3 失败项带原因', Boolean(bulk.failed[0]?.reason), r.json);
    expect('3 ok=false 表示有失败', bulk.ok === false, r.json);

    // ── 4. 去重：ids 重复只删一次 ──
    const a6 = await mkAngle(6);
    r = await call('angles', 'POST', '/bulk-delete', { ids: [a6.id, a6.id, a6.id] });
    bulk = r.json as unknown as BulkResult;
    expect('4 重复 id 只算 1 条', bulk.total === 1 && bulk.deleted === 1, r.json);

    // ── 5. 文章批量删除：未推送的归还角度、已推送的不归还 ──
    const a7 = await mkAngle(7, true);
    const art3 = await prisma.article.create({
      data: {
        trackId,
        angleId: a7.id,
        title: '冒烟-批量未推送',
        contentHtml: '<h1>冒烟-批量未推送</h1><p>未推送。</p>',
        contentWechat: '<p>未推送。</p>',
        idempotencyKey: `smoke-bulk-${stamp}-art3`,
        pushDate: '2026-11-11',
        status: 'draft',
      },
    });
    r = await call('articles', 'POST', '/bulk-delete', { ids: [art3.id, art2.id] });
    bulk = r.json as unknown as BulkResult;
    expect('5 文章批量删 2 条', r.status === 200 && bulk.deleted === 2, r.json);
    // art3 未推送 → 归还；art2 已推送 → 不归还
    expect('5 只归还了未推送文章占用的 1 个角度', bulk.details.recycledAngles === 1, r.json);
    const a7After = await prisma.angle.findUnique({ where: { id: a7.id } });
    expect('5 未推送文章的角度已回池', a7After?.used === false, a7After);
    const a4After = await prisma.angle.findUnique({ where: { id: a4.id } });
    expect('5 已推送文章的角度不归还', a4After?.used === true, a4After);

    // ── 6. 账号批量删除：级联删名下文章 + 归还未推送文章占用的角度 ──
    const acc = await prisma.oAAccount.create({
      data: {
        trackId,
        name: `冒烟批量账号${stamp}`,
        appid: `wxsmokebulk${stamp}`,
        secretEnc: Buffer.from('x'),
        secretMask: '***',
        credStatus: 'ok',
        enabled: true,
      },
    });
    const a8 = await mkAngle(8, true);
    const art4 = await prisma.article.create({
      data: {
        trackId,
        accountId: acc.id,
        angleId: a8.id,
        title: '冒烟-账号名下文章',
        contentHtml: '<h1>冒烟-账号名下文章</h1><p>随账号删除。</p>',
        contentWechat: '<p>随账号删除。</p>',
        idempotencyKey: `smoke-bulk-${stamp}-art4`,
        pushDate: '2026-11-11',
        status: 'draft',
      },
    });
    r = await call('credentials', 'POST', '/bulk-delete', { ids: [acc.id] });
    bulk = r.json as unknown as BulkResult;
    expect('6 账号批量删成功', r.status === 200 && bulk.deleted === 1, r.json);
    expect('6 级联删了名下 1 篇文章', bulk.details.deletedArticles === 1, r.json);
    expect('6 归还未推送文章占用的 1 个角度', bulk.details.recycledAngles === 1, r.json);
    const accGone = await prisma.oAAccount.count({ where: { id: acc.id } });
    expect('6 账号已删', accGone === 0);
    const art4Gone = await prisma.article.count({ where: { id: art4.id } });
    expect('6 名下文章已级联删除', art4Gone === 0);

    // ── 7. 赛道批量删除：有账号的赛道被跳过，其余照删 ──
    const acc2 = await prisma.oAAccount.create({
      data: {
        trackId: track2Id,
        name: `冒烟占位账号${stamp}`,
        appid: `wxsmokebulk2${stamp}`,
        secretEnc: Buffer.from('x'),
        secretMask: '***',
        credStatus: 'ok',
        enabled: true,
      },
    });
    const emptyTrack = await prisma.track.create({
      data: { name: `${trackName}_3`, slug: `smoke-bulk-3-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    r = await call('tracks', 'POST', '/bulk-delete', { ids: [track2Id, emptyTrack.id] });
    bulk = r.json as unknown as BulkResult;
    expect('7 有账号的赛道被跳过，其余删掉', r.status === 200 && bulk.deleted === 1, r.json);
    expect('7 跳过项带原因', bulk.failed.length === 1 && bulk.failed[0].id === track2Id, r.json);
    expect('7 原因提到账号', (bulk.failed[0]?.reason ?? '').includes('账号'), r.json);
    const t2Still = await prisma.track.count({ where: { id: track2Id } });
    expect('7 有账号的赛道还在', t2Still === 1);

    // ── 8. 模型批量删除：先解绑再删 ──
    // role 是唯一键，库里已有 write 等真实绑定——用带时间戳的独立 role，
    // 绝不碰用户自己的绑定（删模型会连带删掉该 role 的绑定）。
    const smokeRole = `smoke_bulk_role_${stamp}`;
    const model = await prisma.llmModel.create({
      data: {
        name: `冒烟批量模型${stamp}`,
        vendor: 'custom',
        protocol: 'openai',
        capability: 'text',
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'smoke-bulk-model',
        apiKeyEnc: Buffer.from('x'),
        apiKeyMask: '***',
        enabled: true,
      },
    });
    await prisma.modelBinding.create({ data: { role: smokeRole, modelId: model.id } });
    r = await call('models', 'POST', '/bulk-delete', { ids: [model.id] });
    bulk = r.json as unknown as BulkResult;
    expect('8 模型批量删成功', r.status === 200 && bulk.deleted === 1, r.json);
    expect('8 统计了解绑的角色数', bulk.details.unboundRoles === 1, r.json);
    const bindingGone = await prisma.modelBinding.count({ where: { modelId: model.id } });
    expect('8 绑定已解除（无悬空外键）', bindingGone === 0);
    // 关键：不能影响用户自己的角色绑定
    const foreignBindings = await prisma.modelBinding.count({
      where: { role: { not: smokeRole } },
    });
    expect('8 用户原有绑定未受影响', foreignBindings > 0, { foreignBindings });

    console.log(`\n全部通过：${passed} 项断言`);
  } finally {
    // 清理：只删本脚本造的赛道（Angle/Article 级联），以及带冒烟前缀的模型
    await prisma.track.deleteMany({ where: { name: { startsWith: trackName } } });
    await prisma.article.deleteMany({ where: { title: { startsWith: '冒烟-批量' } } });
    await prisma.angle.deleteMany({ where: { code: { startsWith: `smoke-bulk-${stamp}` } } });
    await prisma.modelBinding.deleteMany({ where: { model: { name: { startsWith: '冒烟批量模型' } } } });
    await prisma.llmModel.deleteMany({ where: { name: { startsWith: '冒烟批量模型' } } });
    server.close();
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error('\n冒烟失败：', e);
  process.exitCode = 1;
});
