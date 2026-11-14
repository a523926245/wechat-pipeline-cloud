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
import { unpackJson } from '../src/db-json.ts';
import { expandAnglesForTrack } from '../src/services/angles.ts';
import { reserveAnglesForPipeline } from '../src/services/planner.ts';
import { normalizeScores, parseScoreBatch } from '../src/services/topic-review.ts';

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
  // S4-1：审核态与评分（老用例只用上面的字段，这里按需读取）
  status?: string;
  reviewRound?: number;
  scores?: { total: number } | null;
  scoreTotal?: number | null;
  scoreSuggestion?: string;
  scoreError?: string | null;
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
  if (!(globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__?.register(server)) throw new Error('smoke-net-guard 未预载，拒绝运行（必须经 smoke-run.ts 引导）'); // T0 端口登记胶水
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

    // ═══════════ S4-1：选题评分与审核状态机 ═══════════

    // 19) 手动新增进 candidate、未评分（评分缺失不视为高质量、不自动批准）
    expect(
      '19 手动新增 → candidate/未评分/round=0',
      c1.status === 'candidate' && c1.scoreTotal === null && (c1.reviewRound ?? 0) === 0,
      c1,
    );

    // 20) 扩库（Mock LLM）：进 candidate + 六维评分入 metaJson；评分失败=未评分且不自动批准
    const mockGen = async () =>
      JSON.stringify([
        { theme: '扩库甲', content: '孩子把牛奶打翻后主动收拾，妈妈该怎么夸才不空洞' },
        { theme: '扩库乙', content: '老人追着喂饭孩子直躲，这顿饭到底该怎么收场' },
      ]);
    const mockScore = async () =>
      JSON.stringify([
        { id: 1, fit: 4, scene: 3, conflict: 4, method: 5, safety: 4, novelty: 2, suggestion: 'approved', why: '具体' },
        { id: 2, fit: 9, scene: 3, conflict: 3, method: 3, safety: 3, novelty: 3, why: '越界应判失败' },
      ]);
    const exp = await expandAnglesForTrack(trackId, 2, undefined, 'article', {
      gen: mockGen as never,
      score: mockScore as never,
    });
    expect('20 扩库 Mock 入库 2 条、评上 1 条', exp.added === 2 && exp.scored === 1, exp);
    const expanded = await prisma.angle.findMany({
      where: { trackId, source: 'llm-expand' },
      orderBy: { seq: 'asc' },
    });
    expect('20 两条均进 candidate（不自动批准）', expanded.every((x) => x.status === 'candidate'), expanded.map((x) => x.status));
    const e1 = expanded[0]!;
    const e2 = expanded[1]!;
    const e1Meta = unpackJson<{ scores?: { total: number }; scoreError?: string }>(e1.metaJson) ?? {};
    const e2Meta = unpackJson<{ scores?: unknown; scoreError?: string }>(e2.metaJson) ?? {};
    expect('20 六维合计 22 入库', e1Meta.scores?.total === 22, e1Meta);
    expect(
      '20 评分越界判失败（未评分+scoreError，不当高质量）',
      e2Meta.scores == null && Boolean(e2Meta.scoreError),
      e2Meta,
    );

    // 21) 评分纯函数：缺维/越界整体判失败；批次缺条目有 scoreError
    expect('21 normalizeScores 合法 → 合计', normalizeScores({ fit: 5, scene: 4, conflict: 3, method: 2, safety: 1, novelty: 0 })?.total === 15);
    expect('21 normalizeScores 缺维 → null', normalizeScores({ fit: 5, scene: 4, conflict: 3, method: 2, safety: 1 }) === null);
    expect('21 normalizeScores 越界 → null', normalizeScores({ fit: 6, scene: 4, conflict: 3, method: 2, safety: 1, novelty: 0 }) === null);
    const pb = parseScoreBatch('[{"id":1,"fit":4,"scene":4,"conflict":4,"method":4,"safety":4,"novelty":4}]', [1, 2]);
    expect('21 批次缺条目 → scoreError', pb.get(2)?.scores === null && Boolean(pb.get(2)?.scoreError), pb.get(2));

    // 22) 审核状态机（API）：合法流转 + 终态拦截 + 多轮留痕
    r = await call('POST', `/${c1.id}/review`, { verdict: 'approved' });
    const rv1 = r.json as unknown as { ok: boolean; review: { round: number; verdict: string; reviewedBy: string }; item: SmokeAngle };
    expect(
      '22 candidate → approved（round=1，reviewedBy 记录）',
      r.status === 200 && rv1.item.status === 'approved' && rv1.review.round === 1 && rv1.review.reviewedBy === 'smoke',
      r.json,
    );
    r = await call('POST', `/${c1.id}/review`, { verdict: 'rejected' });
    expect('22 approved 终态 → 400', r.status === 400, r.json);

    r = await call('POST', `/${c2.id}/review`, { verdict: 'needs_revision', reason: '再改改' });
    expect('22 candidate → needs_revision', r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'needs_revision', r.json);
    r = await call('POST', `/${c2.id}/review`, { verdict: 'needs_revision', reason: '还是不行' });
    expect('22 needs_revision → needs_revision（round=2 多轮留痕）', r.status === 200 && (r.json as unknown as { review: { round: number } }).review.round === 2, r.json);
    r = await call('POST', `/${c2.id}/review`, { verdict: 'rejected', reason: '定位不符' });
    expect('22 needs_revision → rejected（round=3）', r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'rejected', r.json);
    r = await call('POST', `/${c2.id}/review`, { verdict: 'approved' });
    expect('22 rejected 终态 → 400', r.status === 400, r.json);
    r = await call('POST', `/${c2.id}/review`, { verdict: 'auto_approve' });
    expect('22 非法 verdict → 400（评分/自动结论不可走人工端口）', r.status === 400, r.json);

    r = await call('GET', `/${c2.id}/reviews`);
    const reviews = r.json as unknown as { total: number; items: { round: number; verdict: string; reason: string }[] };
    expect('22 审核记录 3 条且新轮在前', reviews.total === 3 && reviews.items[0]?.round === 3 && reviews.items[2]?.round === 1, reviews);
    expect('22 记录含 verdict+reason', reviews.items[0]?.verdict === 'rejected' && reviews.items[0]?.reason === '定位不符', reviews.items[0]);

    // 23) 消费链路：只有 approved 可消费；approved 内 FIFO（seq 升序）不变
    const acc = await prisma.oAAccount.create({
      data: { trackId, name: `smoke-angles-acc-${stamp}`, appid: `wxsmokeang${stamp}`.slice(0, 18), credStatus: 'ok', enabled: true },
    });
    const mk = (code: string, seq: number, status: string) =>
      prisma.angle.create({
        data: { trackId, code, seq, theme: `消费测试${seq}`, content: `消费测试选题第 ${seq} 条，该怎么收场`, source: 'smoke', status: status as never },
      });
    const x1 = await mk(`smoke-${stamp}-c10`, 10, 'candidate');
    const x2 = await mk(`smoke-${stamp}-c11`, 11, 'approved');
    const x3 = await mk(`smoke-${stamp}-c12`, 12, 'approved');
    const x4 = await mk(`smoke-${stamp}-c13`, 13, 'needs_revision');
    const x5 = await mk(`smoke-${stamp}-c14`, 14, 'rejected');
    const reserved = await reserveAnglesForPipeline(acc.id, 3, 'article');
    expect(
      '23 只消费 approved 且 FIFO（seq 4→11→12，c1 已在 22 通过）',
      reserved.map((x) => x.id).join(',') === `${c1.id},${x2.id},${x3.id}`,
      reserved.map((x) => ({ id: x.id, seq: x.seq })),
    );
    const leftovers = await prisma.angle.findMany({
      where: { id: { in: [x1.id, x4.id, x5.id] } },
      select: { id: true, used: true, status: true },
    });
    expect(
      '23 candidate/needs_revision/rejected 不可消费（used 仍=false）',
      leftovers.every((x) => x.used === false),
      leftovers,
    );
    const noMore = await reserveAnglesForPipeline(acc.id, 1, 'article');
    expect('23 再取一次 → 空（approved 已用完）', noMore.length === 0, noMore.length);

    // 24) 评分影响排序：sort=score 总分降序、未评分排最后
    r = await call('GET', `/?trackId=${trackId}&sort=score&limit=100`);
    const sorted = (r.json as unknown as ListResult).items;
    const idxOf = (id: number) => sorted.findIndex((x) => x.id === id);
    expect(
      '24 有分条目排在无分条目前（E1=22 分最前）',
      sorted[0]?.id === e1.id && sorted[0]?.scoreTotal === 22,
      sorted.slice(0, 3).map((x) => ({ id: x.id, t: x.scoreTotal })),
    );
    expect(
      '24 未评分（E2）排在已评分之后',
      idxOf(e2.id) > idxOf(e1.id),
      { e1: idxOf(e1.id), e2: idxOf(e2.id) },
    );

    // 25) 改正文 → 旧评分失效（不给过期分数可乘之机）
    r = await call('PUT', `/${e1.id}`, { content: '改了正文之后旧评分必须失效，该怎么收场' });
    const u3 = r.json as unknown as SmokeAngle;
    expect(
      '25 改正文后评分失效（scores=null + scoreError）',
      u3.scoreTotal === null && Boolean(u3.scoreError),
      { scoreTotal: u3.scoreTotal, scoreError: u3.scoreError },
    );

    // ═══════════ S4-1 补充核查：手动指定 angleId 的创作入口四状态门禁 ═══════════
    // 覆盖：POST /api/articles（手动挂稿）与 POST /api/articles/comic/create（漫画建稿）。
    // approved 保持原功能；candidate / needs_revision / rejected 一律 400 拒绝；不存在的 angleId 按原行为。
    const GATE = '只有审核通过';
    async function postJson(
      path: string,
      body: unknown,
    ): Promise<{ status: number; json: Record<string, unknown> }> {
      const res = await fetch(`${base}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: res.status, json };
    }
    const msgOf = (j: Record<string, unknown>) => {
      const err = j.error as { message?: string } | undefined;
      return String(j.message ?? err?.message ?? '');
    };

    // 26) 手动挂稿：三态拒 + approved 原功能（201 落库）
    for (const [label, ang] of [
      ['candidate', x1],
      ['needs_revision', x4],
      ['rejected', x5],
    ] as Array<[string, { id: number }]>) {
      const rr = await postJson('/articles', {
        contentHtml: '<h1>未过审选题挂稿</h1><p>正文内容样例。</p>',
        trackId,
        accountId: acc.id,
        angleId: ang.id,
      });
      expect(
        `26 挂稿 ${label} 被拒（400+明确文案）`,
        rr.status === 400 && msgOf(rr.json).includes(GATE) && msgOf(rr.json).includes('审核'),
        rr.json,
      );
    }
    const okHang = await postJson('/articles', {
      contentHtml: '<h1>通过选题的挂稿</h1><p>正文内容保持不变。</p>',
      trackId,
      accountId: acc.id,
      angleId: x2.id,
    });
    expect(
      '26 挂稿 approved → 201 原功能不变',
      okHang.status === 201 && typeof okHang.json.id === 'number',
      okHang.json,
    );

    // 27) 漫画建稿：三态拒 + approved 过门禁（无模型时按原流程报模型错，非审核门错）
    for (const [label, ang] of [
      ['candidate', x1],
      ['needs_revision', x4],
      ['rejected', x5],
    ] as Array<[string, { id: number }]>) {
      const rr = await postJson('/articles/comic/create', { accountId: acc.id, angleId: ang.id });
      expect(
        `27 漫画建稿 ${label} 被拒（400+明确文案）`,
        rr.status === 400 && msgOf(rr.json).includes(GATE),
        rr.json,
      );
    }
    const okComic = await postJson('/articles/comic/create', { accountId: acc.id, angleId: x3.id });
    expect(
      '27 漫画建稿 approved 过门禁（后续为模型/角色错，非审核门）',
      !msgOf(okComic.json).includes(GATE),
      okComic.json,
    );

    // 28) 不存在的 angleId 仍按原有方式处理（不新增审核门 404/400 语义）
    const missComic = await postJson('/articles/comic/create', { accountId: acc.id, angleId: 999999 });
    expect('28 漫画建稿 不存在选题 → 404 原行为', missComic.status === 404, missComic.json);
    const missHang = await postJson('/articles', {
      contentHtml: '<p>hi</p>',
      trackId,
      accountId: acc.id,
      angleId: 999999,
    });
    expect(
      '28 挂稿 不存在选题 → 原失败路径（非审核门拒绝）',
      missHang.status !== 201 && !msgOf(missHang.json).includes(GATE),
      missHang.json,
    );

    console.log(`\nSMOKE ANGLES: ALL PASS (${passed} 项)`);
  } finally {
    // ── 清理：绝不留下脏数据（TopicReview 随 Angle 级联删） ──
    await prisma.oAAccount.deleteMany({ where: { trackId } });
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
