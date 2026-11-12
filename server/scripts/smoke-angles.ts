/**
 * 选题库 CRUD 端到端冒烟：单进程起 app + fetch，跑完自清理，不依赖任何真实上游。
 *
 * 覆盖：
 *   1. 明细列表（赛道 / 使用状态 / 关键词过滤 + 分页，total 不受分页影响）
 *   2. 手动新增（seq 自增、code 唯一、消费态固定未用）
 *   3. 编辑（只改 theme/content，消费态不可被外部改写）
 *   4. 删除（含「已用选题」：解除文章关联但正文保留，返回 unlinkedArticles）
 *   5. 参数校验（非法 id 走 400/404 而不是 500）与赛道计数回归
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * 跑法：npm run smoke:angles（SQLite 单写者，必须与其他 smoke 串行）
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

interface SmokeAngle {
  id: number;
  trackId: number;
  code: string;
  seq: number;
  theme: string;
  content: string;
  used: boolean;
  usedBy: string;
  usedDate: string | null;
  source: string;
  articleCount: number;
}

interface ListResult {
  total: number;
  limit: number;
  offset: number;
  items: SmokeAngle[];
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const stamp = Date.now().toString(36);
  const trackName = `__smoke_angles_${stamp}__`;
  let trackId = 0;

  try {
    const track = await prisma.track.create({
      data: { name: trackName, slug: `smoke-angles-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    trackId = track.id;

    // ── 造数据：2 条未用 + 1 条已用（被一篇草稿占用） ──
    const a1 = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-1`,
        seq: 1,
        theme: '起床战争',
        content: '早上叫孩子起床像打仗，吼完又后悔的那个瞬间',
        source: 'smoke',
      },
    });
    const a2 = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-2`,
        seq: 2,
        theme: '作业陪伴',
        content: '陪写作业陪到自己先崩溃，最后一句「算了你睡吧」',
        source: 'smoke',
      },
    });
    const a3 = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-3`,
        seq: 3,
        theme: '兴趣班退费',
        content: '花两万报的兴趣班，孩子上了三次就不肯去了',
        used: true,
        usedBy: 'smoke-account',
        usedDate: '2026-10-11',
        source: 'smoke',
      },
    });
    const article = await prisma.article.create({
      data: {
        trackId,
        angleId: a3.id,
        title: '冒烟-关联已用选题',
        contentHtml: '<h1>冒烟-关联已用选题</h1><p>正文内容保持不变。</p>',
        contentWechat: '<p>正文内容保持不变。</p>',
        idempotencyKey: `smoke-angles-${stamp}`,
        pushDate: '2026-10-11',
        status: 'draft',
      },
    });

    async function call(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: Record<string, unknown> }> {
      const res = await fetch(`${base}/api/angles${path}`, {
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

    // 1) 列表明细
    let r = await call('GET', `/?trackId=${trackId}`);
    let list = r.json as unknown as ListResult;
    expect('1 列表 total=3', r.status === 200 && list.total === 3, r.json);
    expect('1 列表含 articleCount 字段', typeof list.items[0]?.articleCount === 'number', list.items[0]);
    expect(
      '1 列表含正文 content',
      list.items.some((x) => x.content.includes('叫孩子起床')),
    );

    // 2) 状态过滤
    r = await call('GET', `/?trackId=${trackId}&used=unused`);
    expect('2 used=unused → 2 条', (r.json as unknown as ListResult).total === 2, r.json);
    r = await call('GET', `/?trackId=${trackId}&used=used`);
    expect('2 used=used → 1 条', (r.json as unknown as ListResult).total === 1, r.json);

    // 3) 关键词（content / theme 都命中）
    r = await call('GET', `/?trackId=${trackId}&keyword=${encodeURIComponent('兴趣班')}`);
    expect('3 keyword 命中 content', (r.json as unknown as ListResult).total === 1, r.json);
    r = await call('GET', `/?trackId=${trackId}&keyword=${encodeURIComponent('起床战争')}`);
    expect('3 keyword 命中 theme', (r.json as unknown as ListResult).total === 1, r.json);

    // 4) 分页：total 不受 limit 影响
    r = await call('GET', `/?trackId=${trackId}&limit=2&offset=0`);
    list = r.json as unknown as ListResult;
    expect('4 分页 items=2 且 total 仍=3', list.items.length === 2 && list.total === 3, r.json);

    // 5) 非法参数 → 400 不是 500
    r = await call('GET', '/');
    expect('5 缺 trackId → 400', r.status === 400, r.json);
    r = await call('GET', '/?trackId=abc');
    expect('5 trackId=abc → 400', r.status === 400, r.json);

    // 6) 不存在的赛道 → 空列表而非 404
    r = await call('GET', '/?trackId=999999');
    expect('6 不存在赛道 → 200 total=0', r.status === 200 && (r.json as unknown as ListResult).total === 0, r.json);

    // 7) 手动新增：seq 自增、code 唯一、消费态未用
    r = await call('POST', '/', { trackId, theme: '冒烟主题', content: '手动新增的第一条选题' });
    const c1 = r.json as unknown as SmokeAngle;
    expect('7 新增 → 201', r.status === 201, r.json);
    expect('7 新增 seq=max+1(4)', c1.seq === 4, c1);
    expect('7 新增 code ≤32 且非空', Boolean(c1.code) && c1.code.length <= 32, c1);
    expect('7 新增 used=false 且 source=manual', c1.used === false && c1.source === 'manual', c1);

    r = await call('POST', '/', { trackId, content: '手动新增的第二条选题' });
    const c2 = r.json as unknown as SmokeAngle;
    expect('7 再新增 seq=5 且 code 不重复', c2.seq === 5 && c2.code !== c1.code, { c1: c1.code, c2: c2.code });

    // 8) 内容校验
    r = await call('POST', '/', { trackId, content: '   ' });
    expect('8 content 空 → 400', r.status === 400, r.json);
    r = await call('POST', '/', { trackId, content: 'x'.repeat(501) });
    expect('8 content 501 字 → 400', r.status === 400, r.json);

    // 9) 新增到不存在的赛道 → 404
    r = await call('POST', '/', { trackId: 999999, content: '没有赛道的选题' });
    expect('9 新增到不存在赛道 → 404', r.status === 404, r.json);

    // 10) 编辑 theme/content
    r = await call('PUT', `/${a1.id}`, { theme: '改后主题', content: '改后正文内容' });
    const u1 = r.json as unknown as SmokeAngle;
    expect('10 编辑生效', r.status === 200 && u1.theme === '改后主题' && u1.content === '改后正文内容', r.json);

    // 11) 消费态不可被外部改写
    r = await call('PUT', `/${a1.id}`, { theme: '再改主题', used: true, usedBy: 'hacker' });
    const u2 = r.json as unknown as SmokeAngle;
    expect(
      '11 传 used/usedBy 不改消费态',
      u2.used === false && u2.usedBy === '' && u2.usedDate === null,
      u2,
    );

    // 12) 编辑不存在的 id → 404（不是 nan 400）
    r = await call('PUT', '/999999', { theme: 'x' });
    expect('12 编辑不存在 → 404', r.status === 404, r.json);

    // 13) 删除未用选题
    r = await call('DELETE', `/${a2.id}`);
    expect(
      '13 删未用 → unlinkedArticles=0',
      r.status === 200 && r.json.unlinkedArticles === 0,
      r.json,
    );

    // 14) 删除已用且被 1 篇文章引用的选题
    r = await call('DELETE', `/${a3.id}`);
    const del = r.json as unknown as { unlinkedArticles: number; used: boolean };
    expect('14 删已用 → unlinkedArticles=1 且 used=true', del.unlinkedArticles === 1 && del.used === true, r.json);
    const after = await prisma.article.findUnique({ where: { id: article.id } });
    expect('14 文章 angleId 已置空', after?.angleId === null, { angleId: after?.angleId });
    expect('14 文章正文不受影响', after?.contentHtml === '<h1>冒烟-关联已用选题</h1><p>正文内容保持不变。</p>');

    // 15) 重复删除 → 404
    r = await call('DELETE', `/${a3.id}`);
    expect('15 重复删除 → 404', r.status === 404, r.json);

    // 16) 非数字 id → 404（被 (\\d+) 挡掉，不是 nan 400）
    r = await call('DELETE', '/abc');
    expect('16 DELETE /abc → 404', r.status === 404, r.json);

    // 17) 回归：赛道计数已同步（3+2 新增 -2 删除 = 3）
    const tracksRes = await fetch(`${base}/api/tracks`);
    const tracksJson = (await tracksRes.json()) as {
      items: { id: number; angleTotal: number; angleUnused: number }[];
    };
    const mine = tracksJson.items.find((t) => t.id === trackId);
    expect('17 赛道 angleTotal 已同步为 3', mine?.angleTotal === 3, mine);

    // 18) 回归：删掉已用选题后再删那篇文章 → 200 且 recycledAngle=false（不 500）
    const artRes = await fetch(`${base}/api/articles/${article.id}`, { method: 'DELETE' });
    const artJson = (await artRes.json()) as { ok: boolean; recycledAngle: boolean };
    expect('18 删文章 → 200 且 recycledAngle=false', artRes.status === 200 && artJson.recycledAngle === false, artJson);

    console.log(`\nSMOKE ANGLES: ALL PASS (${passed} 项)`);
  } finally {
    // ── 清理：绝不留下脏数据 ──
    await prisma.angle.deleteMany({ where: { trackId } });
    await prisma.article.deleteMany({ where: { trackId } });
    await prisma.track.deleteMany({ where: { id: trackId } });
    server.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
