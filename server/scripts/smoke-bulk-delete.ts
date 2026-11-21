/**
 * 批量删除端到端冒烟：单进程起 app + fetch，跑完自清理，不依赖任何真实上游。
 *
 * 覆盖五类资源的 bulk-delete 端点：
 *   1. 选题 angles：删除后文章只解绑、正文保留（与单条删除同一语义）
 *   2. 文章 articles：未送达微信的归还选题角度、已送达的不归还
 *   3. 账号 credentials：级联删名下文章 + 归还未送达文章占用的角度
 *   4. 赛道 tracks：**赛道下有账号则拒绝删除**（批量里不放宽这条规则）
 *   5. 模型 models：先解绑再删，不留悬空外键
 *
 * 另覆盖三个通用行为：
 *   - **部分失败**：一条失败不阻断其余，failed[] 逐条带原因
 *   - **去重**：ids 重复只删一次，计数不虚高
 *   - **参数校验**：空数组 / 超量 / 非数字 → 400 不是 500
 *
 * ── S4-4-1 新增（第 9-12 节）──
 *   9. 推送事实保护（R1）：曾送达微信的文章，无论当前 status 是 pushed/draft/updated/failed，
 *      删除时一律不归还选题；其中「pushed → 改稿」走真实 HTTP 接口产生状态流转，不是造数据。
 *   10. 多文章引用保护（R3）：同一选题被多篇引用时，删到最后一篇才归还；删账号同理。
 *   11. 手动建稿占用（R4）：带 angleId 建稿成功后占题、重复使用 409、建稿失败回滚不占题；
 *       漫画建稿用本地 mock 模型走真实链路。
 *   12. 排产预留补偿（R5）：releaseReservedAngles 的三重闸门 + 漫画脚本失败的真实端到端补偿。
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * 跑法：npm run smoke:bulk（经 smoke-isolated 在隔离库 wechat_pipeline_smoke 上跑）
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { releaseReservedAngles, runPipelineForAccount } from '../src/services/planner.ts';

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
  // ── S4-4-1-R5-HF1：可控故障注入（只让「归还」用的 Angle.updateMany(used:false) 失败）──
  // 目的：验证 ① 失败分支不再提前把选题移出 pending；② finally 兜底能再试一次；
  // ③ 兜底再失败时有明确记录、不伪装成功。
  // 用 Prisma 中间件而不是在生产代码里留测试钩子：故障只存在于本测试进程，run 结束即消失。
  let angleReleaseFailures = 0;
  prisma.$use(async (params, next) => {
    const data = (params.args as { data?: { used?: boolean } } | undefined)?.data;
    if (
      angleReleaseFailures > 0 &&
      params.model === 'Angle' &&
      params.action === 'updateMany' &&
      data?.used === false
    ) {
      angleReleaseFailures -= 1;
      throw new Error('SMOKE: 模拟归还时的数据库故障');
    }
    return next(params);
  });

  const app = createApp();
  const server = app.listen(0);
  // 隔离运行器预载了网守：未登记的 loopback 端口一律拒绝，这里登记测试端口。
  const net = (globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__;
  if (!net?.register(server)) throw new Error('smoke-net-guard 未预载，拒绝运行（必须经 smoke-run.ts 引导）');
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
    // 第三参只用于 S4-4-1 的新用例（手动建稿要求 approved；R5 需要归属账号与产线切片）。
    const mkAngle = (
      seq: number,
      used = false,
      opts: { status?: 'candidate' | 'approved'; usedByAccountId?: number | null; scope?: string } = {},
    ) =>
      prisma.angle.create({
        data: {
          trackId,
          code: `smoke-bulk-${stamp}-${seq}`,
          seq,
          theme: `批量主题${seq}`,
          content: `批量删除冒烟用选题 ${seq}`,
          scope: opts.scope ?? 'article',
          used,
          usedBy: used ? 'smoke-account' : '',
          usedDate: used ? '2026-11-11' : null,
          usedByAccountId: opts.usedByAccountId ?? null,
          status: opts.status ?? 'candidate',
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
        // 未推送的草稿：pushDate 必须为空（S4-4-1 起它是「曾送达微信」的判据之一）
        pushDate: '',
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
        mediaId: 'smoke-media-art2',
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
        // 未推送的草稿：pushDate 必须为空（S4-4-1 起它是「曾送达微信」的判据之一）
        pushDate: '',
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
        // 未推送的草稿：pushDate 必须为空（S4-4-1 起它是「曾送达微信」的判据之一）
        pushDate: '',
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
    // role 是 ModelRole 枚举（唯一键），不能自造字符串值；隔离库是空库，
    // 直接用 write / revise 两个真实角色各绑一个模型，互不影响。
    const smokeRole = 'write' as const;
    const keepRole = 'revise' as const;
    const model = await prisma.llmModel.create({
      data: {
        name: `冒烟批量模型${stamp}`,
        vendor: 'custom',
        protocol: 'openai_chat',
        capability: 'text',
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'smoke-bulk-model',
        apiKeyEnc: Buffer.from('x'),
        apiKeyMask: '***',
        enabled: true,
      },
    });
    const keepModel = await prisma.llmModel.create({
      data: {
        name: `冒烟批量模型保留${stamp}`,
        vendor: 'custom',
        protocol: 'openai_chat',
        capability: 'text',
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'smoke-bulk-model-keep',
        apiKeyEnc: Buffer.from('x'),
        apiKeyMask: '***',
        enabled: true,
      },
    });
    await prisma.modelBinding.create({ data: { role: smokeRole, modelId: model.id } });
    // 对照绑定：删另一个模型时它必须还在（隔离库是空库，不能用「库里有别人的绑定」当参照）
    await prisma.modelBinding.create({ data: { role: keepRole, modelId: keepModel.id } });
    r = await call('models', 'POST', '/bulk-delete', { ids: [model.id] });
    bulk = r.json as unknown as BulkResult;
    expect('8 模型批量删成功', r.status === 200 && bulk.deleted === 1, r.json);
    expect('8 统计了解绑的角色数', bulk.details.unboundRoles === 1, r.json);
    const bindingGone = await prisma.modelBinding.count({ where: { modelId: model.id } });
    expect('8 绑定已解除（无悬空外键）', bindingGone === 0);
    // 关键：删这个模型不能连累其它绑定
    const keptBinding = await prisma.modelBinding.count({ where: { role: keepRole } });
    expect('8 其它模型绑定未受影响', keptBinding === 1, { keptBinding });

    // ═══════════════════ S4-4-1：状态与回收语义（9-12 节） ═══════════════════

    const angleUsed = async (id: number): Promise<boolean> =>
      (await prisma.angle.findUnique({ where: { id }, select: { used: true } }))?.used === true;

    const mkArticle = (
      seq: number,
      angleId: number | null,
      data: {
        status?: 'draft' | 'pushed' | 'updated' | 'failed';
        mediaId?: string;
        pushDate?: string;
        accountId?: number | null;
        contentHtml?: string;
      } = {},
    ) =>
      prisma.article.create({
        data: {
          trackId,
          accountId: data.accountId ?? null,
          angleId,
          title: `冒烟-批量-R${seq}`,
          digest: '',
          contentHtml: data.contentHtml ?? `<h1>冒烟-批量-R${seq}</h1><p>正文内容保持不变。</p>`,
          contentWechat: '<p>正文内容保持不变。</p>',
          mediaId: data.mediaId ?? '',
          pushDate: data.pushDate ?? '',
          status: data.status ?? 'draft',
          idempotencyKey: `smoke-bulk-${stamp}-r${seq}`,
        },
      });

    const mkAcc = (tag: string) =>
      prisma.oAAccount.create({
        data: {
          trackId,
          name: `冒烟批量账号${tag}${stamp}`,
          appid: `wxsmokebulk${tag}${stamp}`,
          secretEnc: Buffer.from('x'),
          secretMask: '***',
          credStatus: 'ok',
          enabled: true,
        },
      });

    // ── 9. 推送事实保护（R1）──
    // 核心：删除时判断「送没送过微信」不再看 status，而看 mediaId / pushDate。
    console.log('— 9 推送事实保护（R1）—');

    // 9.1 直接删已推送文章
    const g91 = await mkAngle(91, true);
    const a91 = await mkArticle(91, g91.id, { status: 'pushed', mediaId: 'smoke-media-91', pushDate: '2026-11-11' });
    const d91 = await call('articles', 'DELETE', `/${a91.id}`);
    expect(
      '9.1 直接删 pushed：不归还',
      d91.status === 200 && (await angleUsed(g91.id)) === true,
      d91.json,
    );

    // 9.2 pushed → 改稿（走真实 PUT /content 产生状态流转）→ 删除
    const g92 = await mkAngle(92, true);
    const a92 = await mkArticle(92, g92.id, { status: 'pushed', mediaId: 'smoke-media-92', pushDate: '2026-11-11' });
    const put92 = await call('articles', 'PUT', `/${a92.id}/content`, {
      contentHtml: '<h1>冒烟-批量-R92</h1><p>人工改过的正文，用来制造 pushed→draft 的真实流转。</p>',
    });
    const st92 = await prisma.article.findUnique({ where: { id: a92.id }, select: { status: true } });
    expect(
      '9.2 真实改稿把 pushed 降为 draft（状态流转前置成立）',
      put92.status === 200 && st92?.status === 'draft',
      { http: put92.status, status: st92?.status },
    );
    const d92 = await call('articles', 'DELETE', `/${a92.id}`);
    expect(
      '9.2 pushed→draft→删除：不归还',
      d92.status === 200 && (await angleUsed(g92.id)) === true,
      d92.json,
    );

    // 9.3 pushed → updated（AI 改写/强调补全会写这个状态）
    const g93 = await mkAngle(93, true);
    const a93 = await mkArticle(93, g93.id, { status: 'updated', mediaId: 'smoke-media-93', pushDate: '2026-11-11' });
    await call('articles', 'DELETE', `/${a93.id}`);
    expect('9.3 pushed→updated→删除：不归还', (await angleUsed(g93.id)) === true);

    // 9.4 pushed → failed（重推失败会写这个状态）
    const g94 = await mkAngle(94, true);
    const a94 = await mkArticle(94, g94.id, { status: 'failed', mediaId: 'smoke-media-94', pushDate: '2026-11-11' });
    await call('articles', 'DELETE', `/${a94.id}`);
    expect('9.4 pushed→failed→删除：不归还', (await angleUsed(g94.id)) === true);

    // 9.5 只有 mediaId（状态被打回 draft、pushDate 为空）→ 仍视为曾推送
    const g95 = await mkAngle(95, true);
    const a95 = await mkArticle(95, g95.id, { status: 'draft', mediaId: 'smoke-media-95' });
    await call('articles', 'DELETE', `/${a95.id}`);
    expect('9.5 mediaId 非空但 status=draft：不归还', (await angleUsed(g95.id)) === true);

    // 9.6 只有 pushDate（mediaId 缺失，历史/异常数据）→ 仍视为曾推送
    const g96 = await mkAngle(96, true);
    const a96 = await mkArticle(96, g96.id, { status: 'draft', pushDate: '2026-11-10' });
    await call('articles', 'DELETE', `/${a96.id}`);
    expect('9.6 pushDate 非空但 mediaId 为空：不归还', (await angleUsed(g96.id)) === true);

    // 9.7 对照：完全没有推送痕迹的草稿，仍然要正常归还（别把规则改反）
    const g97 = await mkAngle(97, true);
    const a97 = await mkArticle(97, g97.id, { status: 'draft' });
    const d97 = await call('articles', 'DELETE', `/${a97.id}`);
    expect(
      '9.7 无推送痕迹的草稿：照常归还',
      (await angleUsed(g97.id)) === false && d97.json.recycledAngle === true,
      d97.json,
    );

    // ── 10. 多文章引用保护（R3）──
    console.log('— 10 多文章引用保护（R3）—');

    // 10.1 / 10.2 两篇草稿引用同一选题：删第一篇不归还，删最后一篇才归还
    const g10 = await mkAngle(101, true);
    const a10a = await mkArticle(101, g10.id);
    const a10b = await mkArticle(102, g10.id);
    await call('articles', 'DELETE', `/${a10a.id}`);
    expect('10.1 还有一篇在引用：不归还', (await angleUsed(g10.id)) === true);
    const d10b = await call('articles', 'DELETE', `/${a10b.id}`);
    expect(
      '10.2 删掉最后一篇引用：归还',
      (await angleUsed(g10.id)) === false && d10b.json.recycledAngle === true,
      d10b.json,
    );

    // 10.3 已推送那篇仍在引用 → 删掉未推送那篇也不能归还
    const g103 = await mkAngle(103, true);
    const a103p = await mkArticle(103, g103.id, { status: 'pushed', mediaId: 'smoke-media-103', pushDate: '2026-11-11' });
    const a103d = await mkArticle(104, g103.id);
    await call('articles', 'DELETE', `/${a103d.id}`);
    expect('10.3 已推送文章仍引用该选题：不归还', (await angleUsed(g103.id)) === true);
    expect('10.3 已推送那篇仍在库', (await prisma.article.count({ where: { id: a103p.id } })) === 1);

    // 10.4 / 10.5 删账号：跨账号引用时不得归还；只被该账号引用才归还
    const accA = await mkAcc('A');
    const accB = await mkAcc('B');
    const g104 = await mkAngle(104, true, { usedByAccountId: accA.id });
    const g105 = await mkAngle(105, true, { usedByAccountId: accA.id });
    const a104A = await mkArticle(105, g104.id, { accountId: accA.id });
    const a104B = await mkArticle(106, g104.id, { accountId: accB.id });
    const a105A = await mkArticle(107, g105.id, { accountId: accA.id });
    const delAccA = await call('credentials', 'POST', '/bulk-delete', { ids: [accA.id] });
    expect(
      '10.4 账号删除成功',
      delAccA.status === 200 && (delAccA.json as unknown as BulkResult).deleted === 1,
      delAccA.json,
    );
    expect('10.4 另一账号的文章仍引用：不归还', (await angleUsed(g104.id)) === true);
    expect('10.5 只被该账号引用：归还', (await angleUsed(g105.id)) === false);
    void a104A;
    void a104B;
    void a105A;

    // ── 11. 手动建稿占用选题（R4）──
    console.log('— 11 手动建稿占用选题（R4）—');
    const accR4 = await mkAcc('R4');
    const mkHtml = (n: number) =>
      `<h1>冒烟-批量-手动${n}</h1><p>手动挂稿的正文内容，用于验证建稿即占题。</p>`;

    // 11.1 带 angleId → 201 且占用（归属写对）
    const g111 = await mkAngle(111, false, { status: 'approved' });
    const c111 = await call('articles', 'POST', '', {
      contentHtml: mkHtml(1),
      accountId: accR4.id,
      trackId,
      angleId: g111.id,
    });
    expect('11.1 手动建稿成功（201）', c111.status === 201, c111.json);
    const g111after = await prisma.angle.findUnique({ where: { id: g111.id } });
    expect('11.1 建稿成功即占用选题', g111after?.used === true, g111after?.used);
    expect(
      '11.1 占用归属写对（账号 + 客户）',
      g111after?.usedByAccountId === accR4.id && g111after?.usedById === accR4.ownerUserId,
      { by: g111after?.usedByAccountId, byId: g111after?.usedById },
    );

    // 11.2 重复使用已占用选题 → 409
    const c112 = await call('articles', 'POST', '', {
      contentHtml: mkHtml(2),
      accountId: accR4.id,
      trackId,
      angleId: g111.id,
    });
    expect('11.2 重复使用已占用选题 → 409', c112.status === 409, { status: c112.status, json: c112.json });

    // 11.3 不带 angleId → 201 且不关联任何选题
    const c113 = await call('articles', 'POST', '', {
      contentHtml: mkHtml(3),
      accountId: accR4.id,
      trackId,
    });
    const a113 = await prisma.article.findUnique({
      where: { id: Number(c113.json.id) },
      select: { angleId: true },
    });
    expect(
      '11.3 不带 angleId：201 且不关联选题',
      c113.status === 201 && a113?.angleId === null,
      { status: c113.status, angleId: a113?.angleId },
    );

    // 11.4 S4-1 门禁不被绕过：未审核选题仍被拒，且不占用
    const g114 = await mkAngle(114, false);
    const c114 = await call('articles', 'POST', '', {
      contentHtml: mkHtml(4),
      accountId: accR4.id,
      trackId,
      angleId: g114.id,
    });
    expect('11.4 未审核选题仍被拒（S4-1 门禁保留）', c114.status === 400, { status: c114.status });
    expect('11.4 被拒时不占用', (await angleUsed(g114.id)) === false);

    // 11.5 建稿失败 → 占用回滚（用不存在的 trackId 触发外键失败）
    const g115 = await mkAngle(115, false, { status: 'approved' });
    const c115 = await call('articles', 'POST', '', {
      contentHtml: mkHtml(5),
      accountId: accR4.id,
      trackId: 999999,
      angleId: g115.id,
    });
    expect('11.5 建稿失败：请求非 201', c115.status !== 201, c115.status);
    expect('11.5 建稿失败：占用已回滚', (await angleUsed(g115.id)) === false);

    // 11.6 漫画入口：已占用选题在门禁处被拒（409），不触发任何模型调用
    const g116 = await mkAngle(116, true, { status: 'approved', scope: 'comic' });
    const c116 = await call('articles', 'POST', '/comic/create', { accountId: accR4.id, angleId: g116.id });
    expect('11.6 漫画建稿：已占用选题被拒（409）', c116.status === 409, {
      status: c116.status,
      json: c116.json,
    });

    // 11.7 漫画建稿失败（本库没有 comic_script 角色绑定）→ 不得留下占用
    const g117 = await mkAngle(117, false, { status: 'approved', scope: 'comic' });
    const c117 = await call('articles', 'POST', '/comic/create', { accountId: accR4.id, angleId: g117.id });
    expect('11.7 漫画建稿失败：请求被拒', c117.status >= 400, c117.status);
    expect('11.7 漫画建稿失败：选题未被占用', (await angleUsed(g117.id)) === false);

    // ── 12. 排产预留补偿（R5）──
    console.log('— 12 排产预留补偿（R5）—');
    const accR5 = await mkAcc('R5');
    const accX = await mkAcc('X');

    // 12.1 已有文章引用 → 不释放
    const g121 = await mkAngle(121, true, { status: 'approved', usedByAccountId: accR5.id });
    await mkArticle(121, g121.id, { accountId: accR5.id });
    const r121 = await releaseReservedAngles([g121.id], accR5.id, 'smoke-has-article', 'article');
    expect(
      '12.1 已有文章引用：不释放（且归入 skipped，不重试）',
      r121.released === 0 && r121.retryable.length === 0 && r121.skipped.includes(g121.id) && (await angleUsed(g121.id)) === true,
      r121,
    );

    // 12.2 无文章引用 → 释放
    const g122 = await mkAngle(122, true, { status: 'approved', usedByAccountId: accR5.id });
    const r122 = await releaseReservedAngles([g122.id], accR5.id, 'smoke-write-failed', 'article');
    expect(
      '12.2 未产出文章：释放 1 个',
      r122.released === 1 && r122.retryable.length === 0 && (await angleUsed(g122.id)) === false,
      r122,
    );

    // 12.3 归属其他账号 → 不误放
    const g123 = await mkAngle(123, true, { status: 'approved', usedByAccountId: accX.id });
    const r123 = await releaseReservedAngles([g123.id], accR5.id, 'smoke-wrong-owner', 'article');
    expect(
      '12.3 归属其他账号：不误放（skipped，不重试）',
      r123.released === 0 && r123.retryable.length === 0 && r123.skipped.includes(g123.id) && (await angleUsed(g123.id)) === true,
      r123,
    );

    // 12.4 批次剩余多个：只放没产文章的，已产文章的不动
    const g124 = await mkAngle(124, true, { status: 'approved', usedByAccountId: accR5.id });
    const g125 = await mkAngle(125, true, { status: 'approved', usedByAccountId: accR5.id });
    const g126 = await mkAngle(126, true, { status: 'approved', usedByAccountId: accR5.id });
    await mkArticle(124, g126.id, { accountId: accR5.id });
    const r124 = await releaseReservedAngles([g124.id, g125.id, g126.id], accR5.id, 'smoke-batch-aborted', 'article');
    expect(
      '12.4 批次剩余 2 个被释放、已产文章的不动（skipped）',
      r124.released === 2 &&
        r124.skipped.includes(g126.id) &&
        (await angleUsed(g124.id)) === false &&
        (await angleUsed(g125.id)) === false &&
        (await angleUsed(g126.id)) === true,
      r124,
    );

    // 12.5 漫画脚本失败的真实端到端补偿（planner 全链路：reserve → 失败 → 归还）
    await prisma.trackPipeline.create({
      data: { trackId, kind: 'comic', quotaPerDay: 1, enabled: true },
    });
    const g127 = await mkAngle(127, false, { status: 'approved', scope: 'comic' });
    const accComic = await mkAcc('C');
    const trig = await runPipelineForAccount(accComic.id, 'comic');
    // 按「实际被预留的那一条」断言，而不是凭假设的 id —— 否则别的用例留下的未用选题
    // 会被 reserve 先取走，断言看着过、实际什么都没验到。
    const trigAngleId = trig.created[0]?.angleId ?? 0;
    const trigAngleAfter = await prisma.angle.findUnique({ where: { id: trigAngleId }, select: { used: true } });
    expect(
      '12.5 漫画脚本失败：结果如实记录失败项',
      trigAngleId > 0 &&
        trig.created.length === 1 &&
        trig.created[0]?.id === 0 &&
        (trig.created[0]?.note ?? '').includes('漫画脚本失败'),
      trig.created,
    );
    expect('12.5 补偿生效：该选题已归还', trigAngleAfter?.used === false, trigAngleAfter);

    // ── 12.6-12.9 S4-4-1-R5-HF1：pending 生命周期 + finally 兜底（故障注入）──
    console.log('— 12.6 故障注入：归还失败不得伪造成成功 —');
    const g128 = await mkAngle(128, true, { status: 'approved', usedByAccountId: accR5.id });
    angleReleaseFailures = 1;
    const r128 = await releaseReservedAngles([g128.id], accR5.id, 'smoke-db-fail-first', 'article');
    expect(
      '12.6 首次归还数据库失败：released=0 且标记为可重试（不伪装成功）',
      r128.released === 0 && r128.retryable.includes(g128.id) && Boolean(r128.error),
      r128,
    );
    expect('12.6 失败后选题仍 used=true', (await angleUsed(g128.id)) === true);

    const r129 = await releaseReservedAngles([g128.id], accR5.id, 'smoke-db-fail-retry', 'article');
    expect(
      '12.7 再次补偿成功（等价于 finally 的兜底动作）',
      r129.released === 1 && r129.retryable.length === 0 && (await angleUsed(g128.id)) === false,
      r129,
    );

    // 12.8 端到端：planner 失败分支首轮补偿失败 → 选题留在 pending → finally 兜底成功
    console.log('— 12.8 planner 端到端：首轮补偿失败 → finally 兜底 —');
    const accHf1 = await mkAcc('H1');
    angleReleaseFailures = 1;
    const trigHf1 = await runPipelineForAccount(accHf1.id, 'comic');
    const hf1Angle = trigHf1.created[0]?.angleId ?? 0;
    expect(
      '12.8 建稿失败且首轮补偿失败：结果标注「批次结束时再试一次」',
      trigHf1.created.length === 1 &&
        trigHf1.created[0]?.id === 0 &&
        (trigHf1.created[0]?.note ?? '').includes('将在本批次结束时再试一次'),
      trigHf1.created,
    );
    const hf1After = await prisma.angle.findUnique({ where: { id: hf1Angle }, select: { used: true } });
    expect('12.8 finally 兜底生效：该选题最终被归还（used=false）', hf1After?.used === false, hf1After);

    // 12.9 端到端：两轮补偿都失败 → 遗留 used=true，但必须有明确记录（不静默、不谎报）
    console.log('— 12.9 planner 端到端：两轮补偿都失败 —');
    const accHf2 = await mkAcc('H2');
    angleReleaseFailures = 2;
    const trigHf2 = await runPipelineForAccount(accHf2.id, 'comic');
    const hf2Angle = trigHf2.created[0]?.angleId ?? 0;
    expect(
      '12.9 两轮都失败：兜底失败被写入批次结果（含 angleId 与原因）',
      trigHf2.created.some(
        (c) => (c.note ?? '').includes('兜底补偿失败') && (c.note ?? '').includes(String(hf2Angle)),
      ),
      trigHf2.created,
    );
    const hf2After = await prisma.angle.findUnique({ where: { id: hf2Angle }, select: { used: true } });
    expect('12.9 两轮都失败：选题仍 used=true（如实反映，不伪装成功）', hf2After?.used === true, hf2After);
    expect('12.9 故障注入已耗尽（不污染后续用例）', angleReleaseFailures === 0, angleReleaseFailures);
    // 收尾：把这条遗留的选题手动归位，避免 finally 清理阶段留下 used=true 的脏状态
    await prisma.angle.updateMany({ where: { id: hf2Angle }, data: { used: false } });

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
