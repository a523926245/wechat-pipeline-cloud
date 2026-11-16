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
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { packJson, unpackJson } from '../src/db-json.ts';
import { expandAnglesForTrack, rescoreAngle, topicRejectReason } from '../src/services/angles.ts';
import { loadTrackRule } from '../src/services/style-prompts.ts';
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

    // S4-2：内容与 c1 明显不同（原「手动新增的第二条选题」与第一条 dupScore=0.64，
    // 会命中 L1 判重被拒——夹具改写，语义仍是「再新增一条，seq/code 不重复」）。
    r = await call('POST', '/', { trackId, content: '整理书包时翻出孩子藏起来的数学试卷' });
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
    // S4-4-1 R4：挂稿现在会消耗选题，而 x2/x3 已在排产消费测试里被占用（used=true），
    // 不能再用它们验「approved 可挂稿」。新建两个 approved 且未占用的选题，保持原断言语义。
    const x26 = await mk(`smoke-${stamp}-c26`, 26, 'approved');
    const x27 = await mk(`smoke-${stamp}-c27`, 27, 'approved');
    const okHang = await postJson('/articles', {
      contentHtml: '<h1>通过选题的挂稿</h1><p>正文内容保持不变。</p>',
      trackId,
      accountId: acc.id,
      angleId: x26.id,
    });
    expect(
      '26 挂稿 approved → 201 原功能不变',
      okHang.status === 201 && typeof okHang.json.id === 'number',
      okHang.json,
    );
    // S4-4-1 R4：挂稿成功即占用该选题（选题进入生产，不能再被排产领走）
    const x26After = await prisma.angle.findUnique({ where: { id: x26.id }, select: { used: true } });
    expect('26 挂稿成功即占用选题（R4）', x26After?.used === true, x26After);

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
    const okComic = await postJson('/articles/comic/create', { accountId: acc.id, angleId: x27.id });
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

    // ═══════════ S4-1-HF1：approved 编辑内容实质必须退回 candidate（审核绕过修复） ═══════════
    // 判定规则（见 S4-1-HF1 报告）：theme+content=内容实质（变更→评分失效，approved 退回 candidate）；
    // scope=管理元数据（不触发退回）；与现值相同的空编辑不算变更。
    const mkScored = (code: string, seq: number, theme: string, content: string) =>
      prisma.angle.create({
        data: {
          trackId,
          code,
          seq,
          theme,
          content,
          source: 'smoke',
          metaJson: packJson({
            scores: { fit: 5, scene: 4, conflict: 4, method: 4, safety: 4, novelty: 4, total: 25 },
            scoreSource: 'llm',
            scoreModel: 'mock-write',
            scoredAt: new Date().toISOString(),
            scoreError: '',
            suggestion: 'approved',
            rationale: 'HF1 夹具评分',
          }) ?? Prisma.DbNull,
        },
      });

    const hf = await mkScored(
      `smoke-${stamp}-hf1`,
      30,
      'HF守门',
      'HF1 修复验证选题：孩子打碎花瓶后主动承认，家长该怎么回应',
    );
    r = await call('POST', `/${hf.id}/review`, { verdict: 'approved' });
    expect(
      '29 夹具：candidate → approved（round=1，评分 25 在库）',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'approved'
        && (r.json as unknown as { item: SmokeAngle }).item.scoreTotal === 25
        && (r.json as unknown as { review: { round: number } }).review.round === 1,
      r.json,
    );

    // 29-1 只改 scope（非正文元数据）→ 不退回、不误伤评分
    r = await call('PUT', `/${hf.id}`, { scope: 'comic' });
    const hfScope = r.json as unknown as SmokeAngle;
    expect(
      '29 只改 scope（元数据）→ 仍 approved 且评分保留',
      r.status === 200 && hfScope.status === 'approved' && hfScope.scoreTotal === 25 && hfScope.reviewRound === 1,
      hfScope,
    );

    // 29-2 与现值相同的「空编辑」→ 不退回、不失效
    r = await call('PUT', `/${hf.id}`, {
      content: 'HF1 修复验证选题：孩子打碎花瓶后主动承认，家长该怎么回应',
    });
    const hfSame = r.json as unknown as SmokeAngle;
    expect(
      '29 相同内容重存（空编辑）→ 仍 approved 且评分保留',
      r.status === 200 && hfSame.status === 'approved' && hfSame.scoreTotal === 25,
      hfSame,
    );

    // 29-3 改正文（内容实质）→ 退回 candidate + 评分失效 + reviewRound 保留
    r = await call('PUT', `/${hf.id}`, { content: 'HF1 修改后的全新正文，晚餐时的冲突该怎么收场' });
    const hfEdit = r.json as unknown as SmokeAngle & { message?: string };
    expect('29 改正文 → 退回 candidate', r.status === 200 && hfEdit.status === 'candidate', hfEdit);
    expect(
      '29 改正文 → 评分失效（scores=null + scoreError）',
      hfEdit.scoreTotal === null && Boolean(hfEdit.scoreError),
      { scoreTotal: hfEdit.scoreTotal, scoreError: hfEdit.scoreError },
    );
    expect('29 reviewRound 保留（仍=1）', hfEdit.reviewRound === 1, hfEdit);
    expect(
      '29 返回体带退回提示',
      String(hfEdit.message).includes('候选待审') && String(hfEdit.message).includes('评分已失效'),
      hfEdit.message,
    );

    // 29-4 TopicReview 历史完整保留（不删不改）
    r = await call('GET', `/${hf.id}/reviews`);
    const hfReviews = r.json as unknown as { total: number; items: { round: number; verdict: string }[] };
    expect(
      '29 TopicReview 历史保留（1 条 approved 记录）',
      hfReviews.total === 1 && hfReviews.items[0]?.round === 1 && hfReviews.items[0]?.verdict === 'approved',
      hfReviews,
    );

    // 29-5 正式创作门禁：退回后的选题不可挂稿
    const hfGate = await postJson('/articles', {
      contentHtml: '<h1>退回选题挂稿</h1><p>正文样例。</p>',
      trackId,
      accountId: acc.id,
      angleId: hf.id,
    });
    expect(
      '29 退回后挂稿被 approved 门禁拒绝',
      hfGate.status === 400 && msgOf(hfGate.json).includes(GATE),
      hfGate.json,
    );

    // 29-6 重新评分（写入新的有效评分，模拟重评——现无独立重评 API）+ 人工审核 → 可重新进入 approved
    await prisma.angle.update({
      where: { id: hf.id },
      data: {
        metaJson: packJson({
          scores: { fit: 4, scene: 4, conflict: 4, method: 4, safety: 4, novelty: 4, total: 24 },
          scoreSource: 'llm',
          scoreModel: 'mock-write-2',
          scoredAt: new Date().toISOString(),
          scoreError: '',
          suggestion: 'approved',
          rationale: 'HF1 重评',
        }) ?? Prisma.DbNull,
      },
    });
    r = await call('POST', `/${hf.id}/review`, { verdict: 'approved' });
    const hfRe = r.json as unknown as { item: SmokeAngle; review: { round: number } };
    expect(
      '29 重评+人工审核 → 重新 approved（round=2 续轮，新分 24）',
      r.status === 200 && hfRe.item.status === 'approved' && hfRe.review.round === 2 && hfRe.item.scoreTotal === 24,
      r.json,
    );

    // 29-7 改 theme（内容实质）→ 同样退回 + 评分失效（判定规则固化）
    r = await call('PUT', `/${hf.id}`, { theme: 'HF守门二' });
    const hfTheme = r.json as unknown as SmokeAngle;
    expect(
      '29 改 theme（内容实质）→ 退回 candidate 且评分失效',
      r.status === 200 && hfTheme.status === 'candidate' && hfTheme.scoreTotal === null && Boolean(hfTheme.scoreError),
      hfTheme,
    );

    // 29-8 非 approved 三态改正文：既有行为不变
    const hfCand = await mkScored(`smoke-${stamp}-hf-c`, 31, 'HF候选', 'HF candidate 态改正文：孩子抢玩具不肯道歉，该怎么引导');
    r = await call('PUT', `/${hfCand.id}`, { content: 'HF candidate 态改后正文：孩子抢玩具不认错，该怎么引导' });
    expect(
      '29 candidate 改正文 → 仍 candidate（评分照常失效）',
      r.status === 200 && (r.json as unknown as SmokeAngle).status === 'candidate'
        && (r.json as unknown as SmokeAngle).scoreTotal === null,
      r.json,
    );

    const hfRev = await mkScored(`smoke-${stamp}-hf-r`, 32, 'HF待改', 'HF needs_revision 态改正文：孩子练琴闹脾气，该怎么陪');
    await call('POST', `/${hfRev.id}/review`, { verdict: 'needs_revision', reason: '再改改' });
    r = await call('PUT', `/${hfRev.id}`, { content: 'HF needs_revision 态改后正文：孩子练琴摔琴谱，该怎么陪' });
    expect(
      '29 needs_revision 改正文 → 仍 needs_revision（round=1 保留）',
      r.status === 200 && (r.json as unknown as SmokeAngle).status === 'needs_revision'
        && (r.json as unknown as SmokeAngle).reviewRound === 1,
      r.json,
    );

    const hfRej = await mkScored(`smoke-${stamp}-hf-j`, 33, 'HF已拒', 'HF rejected 态改正文：孩子要买玩具躺地哭，该怎么收场');
    await call('POST', `/${hfRej.id}/review`, { verdict: 'rejected', reason: '定位不符' });
    r = await call('PUT', `/${hfRej.id}`, { content: 'HF rejected 态改后正文：孩子要买玩具撒泼打滚，该怎么收场' });
    expect(
      '29 rejected 改正文 → 仍 rejected（round=1 保留）',
      r.status === 200 && (r.json as unknown as SmokeAngle).status === 'rejected'
        && (r.json as unknown as SmokeAngle).reviewRound === 1,
      r.json,
    );

    // 29-9 更新失败（校验层）→ 状态和评分不发生部分更新
    r = await call('PUT', `/${hf.id}`, {});
    expect('29 空补丁 → 400', r.status === 400, r.json);
    r = await call('PUT', `/${hf.id}`, { content: '   ' });
    expect('29 空正文 → 400', r.status === 400, r.json);
    const hfAfterFail = await prisma.angle.findUnique({ where: { id: hf.id } });
    const hfAfterFailMeta = unpackJson<{ scores?: { total: number }; scoreError?: string }>(hfAfterFail?.metaJson) ?? {};
    expect(
      '29 失败请求零部分更新（状态/评分与失败前一致）',
      hfAfterFail?.status === 'candidate' && hfAfterFailMeta.scores == null && Boolean(hfAfterFailMeta.scoreError),
      { status: hfAfterFail?.status, meta: hfAfterFailMeta },
    );

    // ═══════════ S4-1-HF1-R1：重评硬门禁 + 编辑/审核并发竞态 ═══════════
    // 问题一：approved 编辑退回的 candidate 必须重评才能再过审（普通 candidate 不受影响）。
    // 问题二：编辑与审核并发不得出现「新正文 + approved」或过期审核结论落到新内容上。

    // 30-1 普通未评分 candidate 按 S4-1 原规则可直接人工过审（不强制先评分）
    const r1a = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-r1a`,
        seq: 40,
        theme: 'R1普通候选',
        content: 'R1 普通未评分候选直接过审：孩子睡前要抱三次，该怎么定规矩',
        source: 'smoke',
      },
    });
    r = await call('POST', `/${r1a.id}/review`, { verdict: 'approved' });
    expect(
      '30 普通未评分 candidate 直接过审（S4-1 语义保留）',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'approved',
      r.json,
    );

    // 30-2 approved 编辑退回 → 打 rescoreRequired 标记 + 提示含重新评分
    const r1b = await mkScored(`smoke-${stamp}-r1b`, 41, 'R1重评门禁', 'R1 门禁主流程：孩子把牛奶洒了还撒谎，该怎么引导');
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect(
      '30 夹具：过审 round=1（评分 25 在库）',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'approved'
        && (r.json as unknown as { item: SmokeAngle }).item.scoreTotal === 25,
      r.json,
    );
    r = await call('PUT', `/${r1b.id}`, { content: 'R1 门禁主流程改后：孩子撒谎又不认错，该怎么谈' });
    const r1bEdit = r.json as unknown as SmokeAngle & { rescoreRequired?: boolean; message?: string };
    expect(
      '30 改正文退回 candidate + rescoreRequired 标记',
      r.status === 200 && r1bEdit.status === 'candidate' && r1bEdit.rescoreRequired === true,
      r1bEdit,
    );
    expect('30 退回提示含「重新评分」', String(r1bEdit.message).includes('重新评分'), r1bEdit.message);

    // 30-3 未重评 approve 被拒（明确业务错误）；needs_revision/rejected 不受门禁影响
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect(
      '30 未重评 approve → 400 且提示重新评分',
      r.status === 400 && msgOf(r.json).includes('重新评分'),
      r.json,
    );

    // 30-4 评分失败（mock 越界分）→ rescored=false、标记保留 → approve 仍拒
    const failScore = async () =>
      JSON.stringify([{ id: 1, fit: 9, scene: 3, conflict: 3, method: 3, safety: 3, novelty: 3 }]);
    const failRes = await rescoreAngle(r1b.id, { score: failScore as never });
    expect(
      '30 重评失败（越界分）→ rescored=false 且标记保留',
      failRes.rescored === false && failRes.rescoreRequired === true && Boolean(failRes.scoreError),
      failRes,
    );
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect('30 评分失败后 approve 仍被拒', r.status === 400 && msgOf(r.json).includes('重新评分'), r.json);

    // 30-5 评分缺失（mock 输出缺条目）→ 标记保留
    const missScore = async () => JSON.stringify([{ id: 99, fit: 5, scene: 5, conflict: 5, method: 5, safety: 5, novelty: 5 }]);
    const missRes = await rescoreAngle(r1b.id, { score: missScore as never });
    expect(
      '30 重评缺失（缺条目）→ rescored=false 且标记保留',
      missRes.rescored === false && missRes.rescoreRequired === true,
      missRes,
    );

    // 30-6 路由级重评（隔离库无 write 角色 → 调用失败路径）→ 标记保留，approve 仍拒
    r = await call('POST', `/${r1b.id}/rescore`);
    const routeRescore = r.json as unknown as SmokeAngle & { rescored?: boolean };
    expect(
      '30 路由重评无模型 → 200 rescored=false 且标记保留',
      r.status === 200 && routeRescore.rescored === false && routeRescore.rescoreRequired === true,
      r.json,
    );
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect('30 路由重评失败后 approve 仍被拒', r.status === 400, r.json);

    // 30-7 重评成功（mock 完整六维）→ 清标记 → 可过审（round 续进）
    const okScore = async () =>
      JSON.stringify([{ id: 1, fit: 4, scene: 4, conflict: 4, method: 4, safety: 4, novelty: 4, suggestion: 'approved', why: 'ok' }]);
    const okRes = await rescoreAngle(r1b.id, { score: okScore as never });
    expect(
      '30 重评成功 → rescored=true 且标记清除且分数 24',
      okRes.rescored === true && okRes.rescoreRequired === false && okRes.scoreTotal === 24,
      okRes,
    );
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect(
      '30 重评后过审 → approved（round=2 续轮）',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'approved'
        && (r.json as unknown as { review: { round: number } }).review.round === 2,
      r.json,
    );

    // 30-8 TopicReview 历史保留（round 1 + 2 共两条）
    r = await call('GET', `/${r1b.id}/reviews`);
    expect('30 历史审核记录保留 2 条', (r.json as unknown as { total: number }).total === 2, r.json);

    // 30-9 多轮：再编辑 → 再置标记 → 再重评 → 再过审（round=3）
    r = await call('PUT', `/${r1b.id}`, { content: 'R1 第二轮改后：孩子和同学闹翻了，该怎么复盘' });
    expect(
      '30 二轮编辑再次退回并置标记',
      (r.json as unknown as SmokeAngle).status === 'candidate'
        && (r.json as unknown as { rescoreRequired?: boolean }).rescoreRequired === true,
      r.json,
    );
    const okRes2 = await rescoreAngle(r1b.id, { score: okScore as never });
    expect('30 二轮重评成功清标记', okRes2.rescored === true && okRes2.rescoreRequired === false, okRes2);
    r = await call('POST', `/${r1b.id}/review`, { verdict: 'approved' });
    expect(
      '30 二轮再过审（round=3）',
      r.status === 200 && (r.json as unknown as { review: { round: number } }).review.round === 3,
      r.json,
    );

    // 30-10 标记期间 needs_revision/rejected 不受门禁影响（仅 approve 受限）
    const r1d = await mkScored(`smoke-${stamp}-r1d`, 42, 'R1其他结论', 'R1 其他结论语义：孩子考差了把卷子藏起来，该怎么谈');
    await call('POST', `/${r1d.id}/review`, { verdict: 'approved' });
    await call('PUT', `/${r1d.id}`, { content: 'R1 其他结论语义改后：孩子藏了卷子还改分数，该怎么谈' });
    r = await call('POST', `/${r1d.id}/review`, { verdict: 'needs_revision', reason: '再改改' });
    expect(
      '30 标记期间 needs_revision 不受门禁影响',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'needs_revision',
      r.json,
    );
    r = await call('POST', `/${r1d.id}/review`, { verdict: 'rejected', reason: '定位不符' });
    expect('30 标记期间 rejected 不受门禁影响', r.status === 200, r.json);

    // 30-11 非 approved 编辑不打标记（普通候选语义，标记只来自 approved 退回）
    const r1c = await mkScored(`smoke-${stamp}-r1c`, 43, 'R1普通编辑', 'R1 普通候选编辑语义：孩子挑食不肯吃青菜，该怎么引导');
    r = await call('PUT', `/${r1c.id}`, { content: 'R1 普通候选编辑语义改后：孩子挑食只吃肉，该怎么引导' });
    const r1cEdit = r.json as unknown as SmokeAngle & { rescoreRequired?: boolean };
    expect(
      '30 非 approved 编辑不打标记且评分失效',
      r1cEdit.status === 'candidate' && r1cEdit.rescoreRequired !== true && r1cEdit.scoreTotal === null,
      r1cEdit,
    );

    // ── 30-RACE1 确定性竞态：并发「审核批准」与「内容编辑」交错 → 不允许新正文+approved ──
    // 手法：交互事务先行锁住行（模拟请求 A 读取后、写入前的窗口），编辑请求在窗口内进入
    // 条件更新的锁等待；窗口内再模拟请求 B 完成审核（candidate→approved）后放锁——
    // 编辑的条件更新必须命中回退分支（status='approved' 条件）把状态打回 candidate。
    const r2a = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-r2a`,
        seq: 50,
        theme: 'RACE1',
        content: 'RACE1 原始正文内容，讲一个场景该怎么收场',
        source: 'smoke',
      },
    });
    let releaseHold1!: () => void;
    let signalHeld1!: () => void;
    const holdGate1 = new Promise<void>((res) => {
      releaseHold1 = res;
    });
    const heldGate1 = new Promise<void>((res) => {
      signalHeld1 = res;
    });
    const holdTx1 = prisma.$transaction(async (tx) => {
      await tx.angle.updateMany({ where: { id: r2a.id }, data: { source: 'hold' } }); // 持行锁
      signalHeld1();
      await holdGate1;
      // 模拟并发审核提交（candidate → approved，round=1）
      await tx.angle.updateMany({
        where: { id: r2a.id, status: 'candidate' },
        data: { status: 'approved', reviewRound: 1 },
      });
    });
    await heldGate1;
    const putP1 = call('PUT', `/${r2a.id}`, { content: 'RACE1 修改后的全新正文，另一个场景该怎么收场' });
    await new Promise((res) => setTimeout(res, 250)); // 等编辑进入条件更新的锁等待
    releaseHold1();
    const putRes1 = await putP1;
    await holdTx1;
    const row1 = await prisma.angle.findUnique({ where: { id: r2a.id } });
    const meta1 = unpackJson<{ rescoreRequired?: boolean }>(row1?.metaJson) ?? {};
    expect(
      '30-RACE1 批准与编辑交错 → 编辑胜出退回（新正文绝不带 approved）',
      putRes1.status === 200 && row1?.status === 'candidate'
        && row1?.content === 'RACE1 修改后的全新正文，另一个场景该怎么收场',
      { put: putRes1.json, row: { status: row1?.status, content: row1?.content } },
    );
    expect('30-RACE1 退回后带重评标记', meta1.rescoreRequired === true, meta1);

    // ── 30-RACE2 确定性竞态：审核基于旧快照 vs 并发编辑提交 → 409 冲突，过期结论不落地 ──
    const r2b = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-r2b`,
        seq: 51,
        theme: 'RACE2',
        content: 'RACE2 原始正文内容，孩子顶嘴那一刻该怎么接',
        source: 'smoke',
      },
    });
    let releaseHold2!: () => void;
    let signalHeld2!: () => void;
    const holdGate2 = new Promise<void>((res) => {
      releaseHold2 = res;
    });
    const heldGate2 = new Promise<void>((res) => {
      signalHeld2 = res;
    });
    const holdTx2 = prisma.$transaction(async (tx) => {
      await tx.angle.updateMany({ where: { id: r2b.id }, data: { source: 'hold' } }); // 持行锁
      signalHeld2();
      await holdGate2;
      // 模拟并发编辑提交（内容变更 + 评分失效 + 重评标记）
      await tx.angle.updateMany({
        where: { id: r2b.id },
        data: {
          content: 'RACE2 被并发修改后的新正文，孩子顶嘴该怎么接',
          metaJson: packJson({
            scores: null,
            scoreSource: 'none',
            scoreModel: '',
            scoredAt: new Date().toISOString(),
            riskHits: [],
            suggestion: '',
            rationale: '',
            scoreError: '内容已修改，评分已失效（未重新评分）',
            rescoreRequired: true,
          }) ?? Prisma.DbNull,
        },
      });
    });
    await heldGate2;
    const revP2 = call('POST', `/${r2b.id}/review`, { verdict: 'approved' });
    await new Promise((res) => setTimeout(res, 250)); // 等审核进入 CAS 的锁等待
    releaseHold2();
    const revRes2 = await revP2;
    await holdTx2;
    const row2 = await prisma.angle.findUnique({ where: { id: r2b.id } });
    const meta2 = unpackJson<{ rescoreRequired?: boolean }>(row2?.metaJson) ?? {};
    expect(
      '30-RACE2 审核与编辑交错 → 409 冲突（过期结论不落地）',
      revRes2.status === 409 && row2?.status === 'candidate',
      { rev: revRes2.json, row: { status: row2?.status } },
    );
    expect(
      '30-RACE2 新正文与重评标记保留',
      row2?.content === 'RACE2 被并发修改后的新正文，孩子顶嘴该怎么接' && meta2.rescoreRequired === true,
      { content: row2?.content, meta2 },
    );

    // ── 30-RACE3 混合并发 ×5：编辑(实质) vs 审核(approve) 真并发（Promise.all 交错）──
    // 不变量：内容被改过 → 最终绝不允许 approved（无论交错顺序，成功路径必然退回+标记）。
    // S4-2：每轮文案取材不同场景（原模板只差轮次号，跨行 dupScore≈0.82 会被 L1 判重误拦，
    // 掩盖并发不变量本身；语义不变，仅夹具去模板化）。
    const R3_PAIRS: Array<[string, string]> = [
      ['孩子搭的积木塔塌了当场大哭，该怎么接住情绪', '孩子搭的积木塔塌了以后迁怒弟弟，该怎么引导'],
      ['孩子抢秋千把同学推倒在地，该怎么谈道歉', '孩子抢秋千被老师批评后装病回家，该怎么拆穿'],
      ['孩子考试时偷看同桌答案，该怎么谈诚实', '孩子考试偷看被抓后怪老师偏心，该怎么聊'],
      ['孩子把宠物金鱼喂太多撑死了，该怎么谈责任', '孩子喂死金鱼后骗妈妈金鱼睡着了，该怎么聊'],
      ['孩子在电梯里乱按楼层被邻居说，该怎么引导', '孩子电梯乱按被说后故意报复按遍楼层，该怎么谈'],
    ];
    for (let i = 0; i < 5; i += 1) {
      const [before, after] = R3_PAIRS[i]!;
      const rc = await prisma.angle.create({
        data: {
          trackId,
          code: `smoke-${stamp}-r3-${i}`,
          seq: 60 + i,
          theme: `R3-${i}`,
          content: before,
          source: 'smoke',
        },
      });
      const [editRes, revRes] = await Promise.all([
        call('PUT', `/${rc.id}`, { content: after }),
        call('POST', `/${rc.id}/review`, { verdict: 'approved' }),
      ]);
      const row = await prisma.angle.findUnique({ where: { id: rc.id } });
      const edited = row?.content === after;
      const invariant = !edited || row?.status !== 'approved';
      expect(
        `30-RACE3 第 ${i} 轮并发不变量（新正文绝不带 approved）`,
        invariant
          && (editRes.status === 200 || editRes.status === 409)
          && (revRes.status === 200 || revRes.status === 400 || revRes.status === 409),
        { edit: editRes.status, rev: revRes.status, row: { status: row?.status, content: row?.content } },
      );
    }

    // ═══════════ S4-1-HF1-R2：重评流程生命周期（重复编辑后的重评绕过封闭） ═══════════
    // 核心规则：进入 HF1 重评流程（rescoreWorkflow）的选题，在重新审核通过之前，
    // 每次实质修改 theme/content 都必须重新评分；评分成功只清当次；approve 才结束流程。

    const wf = await mkScored(`smoke-${stamp}-wf`, 70, 'R2流程', 'R2 流程主场景：孩子偷拿零花钱该怎么谈');
    const wfFlags = async (id = wf.id) => {
      const row = await prisma.angle.findUnique({ where: { id } });
      const m = unpackJson<{ rescoreRequired?: boolean; rescoreWorkflow?: boolean; scores?: unknown }>(row?.metaJson) ?? {};
      return { row, m };
    };

    // 31-1 approved 首次实质编辑 → 进入重评流程（双标记）
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect(
      '31 夹具过审 round=1',
      r.status === 200 && (r.json as unknown as { review: { round: number } }).review.round === 1,
      r.json,
    );
    r = await call('PUT', `/${wf.id}`, { content: 'R2 流程主场景改一：孩子偷拿零花钱还说谎，该怎么谈' });
    expect(
      '31 首次编辑退回 candidate + rescoreRequired',
      r.status === 200 && (r.json as unknown as SmokeAngle).status === 'candidate'
        && (r.json as unknown as { rescoreRequired?: boolean }).rescoreRequired === true,
      r.json,
    );
    let f = await wfFlags();
    expect('31 进入重评流程（rescoreWorkflow=true）', f.m.rescoreWorkflow === true && f.m.rescoreRequired === true, f.m);

    // 31-2 未重评直接 approve → 拒绝
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect('31 未重评 approve → 400 提示重新评分', r.status === 400 && msgOf(r.json).includes('重新评分'), r.json);

    // 31-3 首次重评成功 → 清当次标记、保留流程身份
    const rs1 = await rescoreAngle(wf.id, { score: okScore as never });
    expect('31 首次重评成功清待评分标记', rs1.rescored === true && rs1.rescoreRequired === false, rs1);
    f = await wfFlags();
    expect('31 流程身份保留（rescoreWorkflow=true）', f.m.rescoreWorkflow === true, f.m);

    // 31-4 重评成功后改 scope / 同值重存 → 不触发重评
    r = await call('PUT', `/${wf.id}`, { scope: 'comic' });
    expect(
      '31 scope 修改不触发重评',
      (r.json as unknown as { rescoreRequired?: boolean }).rescoreRequired !== true,
      r.json,
    );
    r = await call('PUT', `/${wf.id}`, { content: 'R2 流程主场景改一：孩子偷拿零花钱还说谎，该怎么谈' });
    expect(
      '31 同值重存不触发重评',
      (r.json as unknown as { rescoreRequired?: boolean }).rescoreRequired !== true,
      r.json,
    );
    f = await wfFlags();
    expect('31 标记未被误置（false+流程身份在）', f.m.rescoreRequired === false && f.m.rescoreWorkflow === true, f.m);

    // 31-5 核心规则：重评成功后再次实质修改 → 必须重新置位待评分标记
    r = await call('PUT', `/${wf.id}`, { content: 'R2 流程主场景改二：孩子又偷拿零花钱，这次该怎么谈' });
    const edit2 = r.json as unknown as SmokeAngle & { rescoreRequired?: boolean };
    expect(
      '31 重评后再编辑 → rescoreRequired 重新置位且评分失效',
      edit2.rescoreRequired === true && edit2.status === 'candidate' && edit2.scoreTotal === null,
      edit2,
    );
    f = await wfFlags();
    expect('31 流程身份仍在（双标记 true）', f.m.rescoreWorkflow === true && f.m.rescoreRequired === true, f.m);

    // 31-6 漏洞封闭点：再次编辑后不重评直接 approve → 必须拒绝
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect('31 二次编辑后未重评 approve → 400', r.status === 400 && msgOf(r.json).includes('重新评分'), r.json);

    // 31-7 二轮评分失败 → 标记保留，approve 仍拒
    const fail2 = await rescoreAngle(wf.id, { score: failScore as never });
    expect('31 二轮重评失败 → 标记保留', fail2.rescored === false && fail2.rescoreRequired === true, fail2);
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect('31 失败后 approve 仍拒', r.status === 400, r.json);

    // 31-8 二轮重评成功 → 可过审 → approve 成功结束本轮流程（round=2）
    const rs2 = await rescoreAngle(wf.id, { score: okScore as never });
    expect('31 二轮重评成功', rs2.rescored === true && rs2.rescoreRequired === false, rs2);
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect(
      '31 二轮过审 round=2',
      r.status === 200 && (r.json as unknown as { review: { round: number } }).review.round === 2,
      r.json,
    );
    f = await wfFlags();
    expect('31 approve 后流程身份清除（双标记 false）', f.m.rescoreWorkflow === false && f.m.rescoreRequired === false, f.m);

    // 31-9 approve 后再编辑 → 新一轮流程（重新置双标记）
    r = await call('PUT', `/${wf.id}`, { content: 'R2 流程主场景改三：孩子第三次拿钱买卡片，该怎么谈' });
    f = await wfFlags();
    expect('31 approve 后再编辑进入新一轮流程', f.m.rescoreWorkflow === true && f.m.rescoreRequired === true, f.m);

    // 31-10 多轮循环完整性：三轮重评 → 过审 round=3；TopicReview 历史 3 条全保留
    const rs3 = await rescoreAngle(wf.id, { score: okScore as never });
    expect('31 三轮重评成功', rs3.rescored === true && rs3.rescoreRequired === false, rs3);
    r = await call('POST', `/${wf.id}/review`, { verdict: 'approved' });
    expect(
      '31 三轮过审 round=3',
      r.status === 200 && (r.json as unknown as { review: { round: number } }).review.round === 3,
      r.json,
    );
    r = await call('GET', `/${wf.id}/reviews`);
    expect('31 TopicReview 历史完整保留（3 条）', (r.json as unknown as { total: number }).total === 3, r.json);

    // 31-11 普通 candidate 多次编辑 → 不误入流程，仍可未评分过审（S4-1 语义保留）
    const nc = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-nc`,
        seq: 71,
        theme: 'R2普通',
        content: 'R2 普通候选多轮编辑：孩子不肯睡午觉该怎么哄',
        source: 'smoke',
      },
    });
    await call('PUT', `/${nc.id}`, { content: 'R2 普通候选多轮编辑一：孩子午觉闹觉该怎么哄' });
    r = await call('PUT', `/${nc.id}`, { content: 'R2 普通候选多轮编辑二：孩子午觉装睡该怎么哄' });
    expect(
      '31 普通候选多次编辑不置标记',
      (r.json as unknown as { rescoreRequired?: boolean }).rescoreRequired !== true,
      r.json,
    );
    f = await wfFlags(nc.id);
    expect('31 普通候选无流程身份', f.m.rescoreWorkflow !== true, f.m);
    r = await call('POST', `/${nc.id}/review`, { verdict: 'approved' });
    expect(
      '31 普通候选多次编辑后未评分过审',
      r.status === 200 && (r.json as unknown as { item: SmokeAngle }).item.status === 'approved'
        && (r.json as unknown as { item: SmokeAngle }).item.scoreTotal === null,
      r.json,
    );

    // 31-12 不单凭 false 标记放行：流程内 flag=false 但评分失效（脏状态）→ approve 拒
    const bs = await mkScored(`smoke-${stamp}-bs`, 72, 'R2评分有效', 'R2 评分有效性防御：孩子怕黑不肯分房该怎么陪');
    await call('POST', `/${bs.id}/review`, { verdict: 'approved' });
    await call('PUT', `/${bs.id}`, { content: 'R2 评分有效性防御改后：孩子怕黑要开灯睡该怎么陪' });
    await rescoreAngle(bs.id, { score: okScore as never });
    f = await wfFlags(bs.id);
    await prisma.angle.update({
      where: { id: bs.id },
      data: {
        metaJson: packJson({
          ...(f.m as Record<string, unknown>),
          scores: null,
          scoreError: '模拟失效（标记未清但评分已作废）',
        }) ?? Prisma.DbNull,
      },
    });
    r = await call('POST', `/${bs.id}/review`, { verdict: 'approved' });
    expect(
      '31 flag=false 但评分无效 → approve 拒绝（评分有效性兜底）',
      r.status === 400 && msgOf(r.json).includes('评分'),
      r.json,
    );

    // ═══════════ S4-2：统一选题去重（L0/L1 拦截，L2 仅提示）═══════════
    //
    // 覆盖实施指令第六节 20 项中的去重用例（1~19 项；第 20 项=本文件既有用例全数回归）。
    // 阈值真源 constants：SIM_ANGLE=0.45（L1）、SIM_HISTORY=0.35（L2）。
    // 所有用例跑在隔离测试库（smoke-isolated），绝不写真实业务库。

    // ── S4-2 造数据：跨赛道 trackB + 历史文章（实质正文 H1 / 空壳正文 H2）──
    const trackBName = `__smoke_angles_b_${stamp}__`;
    const trackB = await prisma.track.create({
      data: { name: trackBName, slug: `smoke-angles-b-${stamp}`, quotaPerDay: 1, enabled: true },
    });
    const histH1 = await prisma.article.create({
      data: {
        trackId,
        title: '孩子考试失利后躲在房间哭，家长该怎么安慰才不空洞',
        contentHtml: `<h1>历史成文</h1><p>${'失利后孩子躲进房间不肯出来，家长在门口站了很久。'.repeat(3)}</p>`,
        contentWechat: '<p>实质正文（超过 50 字判定线）</p>',
        idempotencyKey: `smoke-s42-h1-${stamp}`,
        pushDate: '2026-11-01',
        status: 'pushed',
      },
    });
    // 空壳正文（<50 字）→ 不进 L2 历史范围（测试 13：非实质正文不参与）
    const histH2 = await prisma.article.create({
      data: {
        trackId,
        title: 'S42 空壳标题：完全一样的题目换个说法',
        contentHtml: '<p>太短</p>',
        contentWechat: '',
        idempotencyKey: `smoke-s42-h2-${stamp}`,
        pushDate: '2026-11-02',
        status: 'draft',
      },
    });

    interface DupErrDetail {
      level?: string;
      hits?: Array<{ level: string; targetId: number; targetText: string; score: number; trackId: number | null; trackName: string }>;
      warnings?: unknown[];
    }
    function dupDetail(json: Record<string, unknown>): DupErrDetail {
      return ((json.error as Record<string, unknown> | undefined)?.detail ?? {}) as DupErrDetail;
    }
    async function metaOf(id: number): Promise<Record<string, unknown>> {
      const row = await prisma.angle.findUnique({ where: { id }, select: { metaJson: true } });
      return (unpackJson<Record<string, unknown>>(row?.metaJson) ?? {}) as Record<string, unknown>;
    }

    // A0 基准选题（手动新增，同时覆盖「新增成功路径」）
    const A0 = 'S42 基准甲：孩子写作业拖拉磨蹭，家长催了就发火该怎么破';
    const A0p = '「S42 基准甲」孩子写作业拖拉磨蹭，家长催了就发火该怎么破！';
    r = await call('POST', '/', { trackId, theme: 'S42基准', content: A0 });
    expect('S42-0 基准选题入库 → 201', r.status === 201, r.json);
    const a0 = r.json as unknown as SmokeAngle;

    // ── 测试 1：L0 完全相同 → 扩库跳过（标点变体归一化后相等也算 L0）──
    const expL0 = await expandAnglesForTrack(trackId, 2, undefined, 'article', {
      gen: (async () =>
        JSON.stringify([
          { theme: 'S42L0', content: A0p },
          { theme: 'S42扩库', content: 'S42 扩库收留条目：孩子把书桌整理得井井有条，该怎么回应' },
        ])) as never,
      score: (async () => '[]') as never,
    });
    expect('S42-1 L0 扩库跳过（skippedDuplicate=1，added=1）', expL0.skippedDuplicate === 1 && expL0.added === 1, expL0);

    // ── 测试 2：L0 完全相同 → 手动新增 400（命中记录含重复对象与来源赛道）──
    r = await call('POST', '/', { trackId, content: A0p });
    const d2 = dupDetail(r.json);
    expect('S42-2 L0 手动新增 → 400', r.status === 400, r.json);
    expect(
      'S42-2 命中明细：L0 + 对象 id + 内容 + 相似度 1 + 来源赛道',
      d2.level === 'L0' && d2.hits?.[0]?.targetId === a0.id && d2.hits[0].targetText === A0
        && d2.hits[0].score === 1 && d2.hits[0].trackName === trackName,
      d2,
    );

    // ── 测试 3：L0 完全相同 → 手动编辑 400 ──
    const scratch1 = 'S42 编辑载体一：孩子忘记带课本被老师批评，回家后该怎么聊';
    r = await call('POST', '/', { trackId, content: scratch1 });
    expect('S42-3 编辑载体一入库', r.status === 201, r.json);
    const s1 = r.json as unknown as SmokeAngle;
    r = await call('PUT', `/${s1.id}`, { content: A0 });
    expect('S42-3 L0 手动编辑 → 400', r.status === 400 && dupDetail(r.json).level === 'L0', r.json);

    // ── 测试 4：编辑排除自身，不误判（标点变体=归一化同自，排除自身后可保存）──
    r = await call('PUT', `/${a0.id}`, { content: A0p });
    expect(
      'S42-4 编辑排除自身（标点变体不误判自身）→ 200',
      r.status === 200 && (r.json as unknown as SmokeAngle).content === A0p,
      r.json,
    );

    // ── 测试 5：L1 达 0.45 → 扩库跳过 ──
    const L1near = 'S42 基准甲，孩子写作业拖拉磨蹭家长催了就发火，到底该怎么破解';
    const expL1 = await expandAnglesForTrack(trackId, 2, undefined, 'article', {
      gen: (async () =>
        JSON.stringify([
          { theme: 'S42L1', content: L1near },
          { theme: 'S42扩库二', content: 'S42 扩库收留条目二：孩子主动给邻居阿姨让路，该怎么肯定' },
        ])) as never,
      score: (async () => '[]') as never,
    });
    expect('S42-5 L1 扩库跳过（skippedDuplicate=1，added=1）', expL1.skippedDuplicate === 1 && expL1.added === 1, expL1);

    // ── 测试 6：L1 达 0.45 → 手动新增 / 编辑 400 ──
    r = await call('POST', '/', { trackId, content: L1near });
    const d6 = dupDetail(r.json);
    expect('S42-6 L1 手动新增 → 400', r.status === 400 && d6.level === 'L1', r.json);
    expect(
      'S42-6 L1 命中含相似度 ≥0.45 与来源赛道',
      (d6.hits?.[0]?.score ?? 0) >= 0.45 && d6.hits?.[0]?.trackName === trackName && d6.hits[0].targetId === a0.id,
      d6,
    );
    r = await call('PUT', `/${s1.id}`, { content: L1near });
    expect('S42-6 L1 手动编辑 → 400', r.status === 400 && dupDetail(r.json).level === 'L1', r.json);

    // ── 测试 7 + 12：L1 未达阈值允许保存；相同主题不同角度不误伤 ──
    r = await call('POST', '/', { trackId, theme: 'S42同主题', content: 'S42 同主题甲：孩子第一次上台演讲腿发抖，该怎么鼓励' });
    expect('S42-7 同主题不同角度甲 → 201（不误伤）', r.status === 201, r.json);
    r = await call('POST', '/', { trackId, theme: 'S42同主题', content: 'S42 同主题乙：孩子把零花钱全买了贴纸，该怎么引导消费观' });
    expect('S42-12 同主题不同角度乙 → 201（相似度 0.20 < 0.45）', r.status === 201, r.json);

    // ── 测试 8：L2 达 0.35 → 只提示，允许保存，命中明细入库 ──
    const L2hit = 'S42 历史相似：孩子考试失利后躲在房间哭，家长该怎么安慰';
    r = await call('POST', '/', { trackId, content: L2hit });
    const w8 = (r.json as unknown as { dedupWarnings?: DupErrDetail['hits'] }).dedupWarnings ?? [];
    expect('S42-8 L2 命中允许保存 → 201', r.status === 201, r.json);
    expect(
      'S42-8 dedupWarnings 展示历史文章标题',
      w8.length >= 1 && w8[0]!.targetText === histH1.title && w8[0]!.level === 'L2' && w8[0]!.targetId === histH1.id,
      w8,
    );
    const l2row = r.json as unknown as SmokeAngle;
    const l2meta = await metaOf(l2row.id);
    expect(
      'S42-8 metaJson.dedupHits 记录命中明细（级别/对象/相似度/来源）',
      Array.isArray(l2meta.dedupHits) && (l2meta.dedupHits as DupErrDetail['hits'])[0]?.level === 'L2'
        && (l2meta.dedupHits as DupErrDetail['hits'])[0]?.score >= 0.35,
      l2meta,
    );

    // ── 测试 9 + 13：L2 不达阈值正常保存；非实质正文不进历史范围（H2 空壳正文）──
    r = await call('POST', '/', { trackId, content: 'S42 空壳标题：完全一样的题目换个说法再来一次' });
    const w9 = (r.json as unknown as { dedupWarnings?: unknown[] }).dedupWarnings ?? [];
    expect(
      'S42-9/13 空壳正文文章不进 L2（与 H2 标题 0.85 相似但不提示）→ 201 无警告',
      r.status === 201 && w9.length === 0,
      r.json,
    );

    // ── 测试 10：rejected 选题参与 L0/L1 判重 ──
    const rejContent = 'S42 被拒选题：孩子在超市躺地要玩具，该怎么收场';
    r = await call('POST', '/', { trackId, content: rejContent });
    expect('S42-10 被拒载体入库', r.status === 201, r.json);
    const rejRow = r.json as unknown as SmokeAngle;
    r = await call('POST', `/${rejRow.id}/review`, { verdict: 'rejected', reason: 'S42 判重测试拒绝' });
    expect('S42-10 载体审核为 rejected', r.status === 200, r.json);
    r = await call('POST', '/', { trackId, content: rejContent });
    expect(
      'S42-10 rejected 选题参与 L0 判重 → 400',
      r.status === 400 && dupDetail(r.json).hits?.[0]?.targetId === rejRow.id,
      r.json,
    );

    // ── 测试 11：跨赛道 L0/L1 正确拦截，明确展示来源赛道 ──
    const X = 'S42 跨赛道重复：孩子沉迷手机不肯写作业，家长断网就炸锅';
    const X2 = 'S42 跨赛道近似：孩子沉迷手机不肯写作业，家长一断网就炸锅';
    await prisma.angle.create({
      data: { trackId: trackB.id, code: `smoke-${stamp}-xb1`, seq: 1, theme: 'S42跨B', content: X, source: 'smoke' },
    });
    await prisma.angle.create({
      data: { trackId: trackB.id, code: `smoke-${stamp}-xb2`, seq: 2, theme: 'S42跨B', content: X2, source: 'smoke' },
    });
    r = await call('POST', '/', { trackId, content: X });
    const d11a = dupDetail(r.json);
    expect('S42-11 跨赛道 L0 → 400', r.status === 400 && d11a.level === 'L0', r.json);
    expect(
      'S42-11 跨赛道 L0 命中展示来源赛道（trackB）',
      d11a.hits?.[0]?.trackName === trackBName && d11a.hits[0].trackId === trackB.id,
      d11a,
    );
    r = await call('POST', '/', { trackId, content: X2 });
    const d11a2 = dupDetail(r.json);
    expect(
      'S42-11 跨赛道 X2 也有 L0 命中（与 trackB 同文）',
      r.status === 400 && d11a2.level === 'L0' && d11a2.hits?.[0]?.trackName === trackBName,
      r.json,
    );
    // X3：与 trackB 的 X2 高度相似但不完全相同 → 跨赛道 L1
    const X3 = 'S42 跨赛道近似：孩子沉迷手机不肯写作业，家长一断网就当场炸锅';
    r = await call('POST', '/', { trackId, content: X3 });
    const d11b = dupDetail(r.json);
    expect(
      'S42-11 跨赛道 L1 → 400（同赛道与跨赛道一视同仁）',
      r.status === 400 && d11b.level === 'L1' && d11b.hits?.[0]?.trackName === trackBName,
      r.json,
    );

    // ── 测试 14：边界案例——标点归一化 / 同义改写 / 扩写 ──
    r = await call('POST', '/', { trackId, content: 'S42 标点边界？孩子早上不肯穿外套！' });
    expect('S42-14a 标点版入库', r.status === 201, r.json);
    r = await call('POST', '/', { trackId, content: 'S42标点边界孩子早上不肯穿外套' });
    expect('S42-14a 删标点洗稿 → L0 400（归一化相等）', r.status === 400 && dupDetail(r.json).level === 'L0', r.json);
    r = await call('POST', '/', { trackId, content: 'S42 同义改写：一不如意就躺在地上打滚，家长该怎么接住情绪' });
    expect('S42-14b 同义改写原句入库', r.status === 201, r.json);
    r = await call('POST', '/', { trackId, content: 'S42 同义改写：一不如意就往地上一躺打滚，家长该怎么接住情绪' });
    expect('S42-14b 同义改写 → L1 400（0.71）', r.status === 400 && dupDetail(r.json).level === 'L1', r.json);
    r = await call('POST', '/', { trackId, content: 'S42 扩写短：孩子锁门拒绝沟通，家长敲门也不应' });
    expect('S42-14c 扩写短句入库', r.status === 201, r.json);
    r = await call('POST', '/', { trackId, content: 'S42 扩写长：孩子锁门拒绝沟通，家长敲门也不应，到底该怎么破冰打开话匣子好好聊' });
    expect('S42-14c 扩写（包含率兜底）→ L1 400（0.75）', r.status === 400 && dupDetail(r.json).level === 'L1', r.json);

    // ── 测试 15 + 16：编辑不覆盖原有 metaJson；HF1 rescoreWorkflow/rescoreRequired 不受去重写入影响 ──
    const mrow = await prisma.angle.create({
      data: {
        trackId,
        code: `smoke-${stamp}-m`,
        seq: 90,
        theme: 'S42元数据',
        content: 'S42 元数据载体：孩子练字半小时就烦躁，该怎么陪',
        source: 'smoke',
        metaJson: packJson({
          scores: null,
          scoreSource: 'none',
          scoreModel: '',
          scoredAt: '2026-11-15T00:00:00.000Z',
          riskHits: ['既有风险项'],
          suggestion: '',
          rationale: '既有依据',
          rescoreRequired: true,
          rescoreWorkflow: true,
          customKeep: 'keep-me',
        }) ?? Prisma.DbNull,
      },
    });
    r = await call('PUT', `/${mrow.id}`, { content: 'S42 元数据载体改后：孩子练字半小时就喊累，该怎么陪' });
    expect('S42-15 元数据载体编辑 → 200', r.status === 200, r.json);
    const mm = await metaOf(mrow.id);
    expect(
      'S42-15/16 原有 metaJson 字段与 HF1 双标记保留（去重写入不覆盖）',
      mm.rescoreWorkflow === true && mm.rescoreRequired === true && mm.customKeep === 'keep-me'
        && Array.isArray(mm.riskHits) && (mm.riskHits as string[])[0] === '既有风险项',
      mm,
    );
    expect('S42-15 无命中写空 dedupHits（不残留旧值）', Array.isArray(mm.dedupHits) && (mm.dedupHits as unknown[]).length === 0, mm);

    // ── 测试 17：TopicReview.dupHits 审核快照；历史记录不随后续重判被改写 ──
    r = await call('POST', `/${l2row.id}/review`, { verdict: 'needs_revision', reason: 'S42 快照测试' });
    expect('S42-17 带 L2 命中的选题审核 → 200', r.status === 200, r.json);
    r = await call('GET', `/${l2row.id}/reviews`);
    const revs = r.json as unknown as { items: Array<{ dupHits?: DupErrDetail['hits'] }> };
    expect(
      'S42-17 dupHits 快照固化（含历史文章标题）',
      Array.isArray(revs.items[0]?.dupHits) && revs.items[0].dupHits![0]?.targetText === histH1.title,
      revs.items[0],
    );
    // 后续重判改写 metaJson.dedupHits → 旧审核记录保持不变
    r = await call('PUT', `/${l2row.id}`, { content: 'S42 历史相似改后：这次和任何历史标题都不像了，讲孩子学骑车摔了又爬起来' });
    expect('S42-19 无命中编辑 → 200', r.status === 200, r.json);
    const l2meta2 = await metaOf(l2row.id);
    expect('S42-19 旧命中清空（dedupHits=[]）', Array.isArray(l2meta2.dedupHits) && (l2meta2.dedupHits as unknown[]).length === 0, l2meta2);
    r = await call('GET', `/${l2row.id}/reviews`);
    const revs2 = r.json as unknown as { items: Array<{ dupHits?: DupErrDetail['hits'] }> };
    expect(
      'S42-17 历史审核记录不被后续重判改写',
      Array.isArray(revs2.items[0]?.dupHits) && revs2.items[0].dupHits![0]?.targetText === histH1.title,
      revs2.items[0],
    );

    // ── 测试 18：多命中明细完整且排序合理（L0 优先 / 相似度降序）──
    const A1 = 'S42 基准乙：孩子考试作弊还不承认，家长该怎么谈才不炸';
    r = await call('POST', '/', { trackId, content: A1 });
    expect('S42-18 基准乙入库', r.status === 201, r.json);
    const a1row = r.json as unknown as SmokeAngle;
    const multi = 'S42 基准甲：孩子写作业拖拉磨蹭，家长催了就发火该怎么破；还有孩子考试作弊还不承认该怎么谈';
    r = await call('POST', '/', { trackId, content: multi });
    const d18 = dupDetail(r.json);
    const hits18 = d18.hits ?? [];
    expect('S42-18 多命中 → 400', r.status === 400 && hits18.length >= 2, r.json);
    expect(
      'S42-18 命中完整（含 A0 与基准乙）且按相似度降序',
      hits18.some((h) => h.targetId === a0.id) && hits18.some((h) => h.targetId === a1row.id)
        && hits18[0]!.score >= hits18[1]!.score,
      hits18,
    );

    // ═══════════ S4-5 B 档：选题形态分赛道（moment / scene）═══════════
    // 两条口径：① 守门按形态分派（基础保护不许退化）；② 提示词真的换了形态，且不再
    // 同时下发互相矛盾的通用要求（不能"只追加附录、通用硬性要求照旧生效"）。
    console.log('\n— S4-5 B：选题形态分赛道 —');
    const momentSample = '闹钟响到第三次，他把脚放回地板上的那三秒';
    const sceneSample = '她把体检单拍了三遍，读出来的结论和医生说的不一样';
    const zodiacSample = '水逆第三天，他把已读不回包装成了在忙';

    expect('B1 激励 moment：无方法钩子的普通时刻样本 → 放行', topicRejectReason({ theme: '闹钟', content: momentSample }, '激励') === null,
      topicRejectReason({ theme: '闹钟', content: momentSample }, '激励'));
    expect(
      'B2 同一样本给未配置赛道 → 仍按 default 拒（放宽没外溢）',
      topicRejectReason({ theme: '闹钟', content: momentSample }, '__smoke_unknown_b__') !== null,
      topicRejectReason({ theme: '闹钟', content: momentSample }, '__smoke_unknown_b__'),
    );
    expect('B3 科技 scene：真实场景 + 判断信号、无方法钩子 → 放行', topicRejectReason({ theme: '体检单', content: sceneSample }, '科技') === null,
      topicRejectReason({ theme: '体检单', content: sceneSample }, '科技'));
    expect(
      'B4 基础保护不退化：激励含心理病理标签仍拒',
      topicRejectReason({ theme: '焦虑症', content: momentSample }, '激励') !== null,
      topicRejectReason({ theme: '焦虑症', content: momentSample }, '激励'),
    );
    expect(
      'B4 基础保护不退化：scene 空内容仍拒',
      topicRejectReason({ theme: 'x', content: '   ' }, '科技') !== null,
    );

    // 提示词层：捕获真正发给生成器的 messages（新增捕获版 mock，不动原有 mockGen）
    type Msg = { role: string; content: string };
    const mkFormTrack = async (name: string) =>
      prisma.track.create({
        data: { name, slug: `smoke-b-${name}-${stamp}`, quotaPerDay: 1, enabled: true },
      });
    const runCapture = async (name: string, candidate: string): Promise<string> => {
      const tr = await mkFormTrack(name);
      const sink: { msgs?: Msg[] } = {};
      await expandAnglesForTrack(tr.id, 1, undefined, 'article', {
        gen: (async (msgs: Msg[]) => {
          sink.msgs = msgs;
          return JSON.stringify([{ theme: '样本', content: candidate }]);
        }) as never,
        score: (async () => '[]') as never,
      });
      return (sink.msgs ?? []).map((m) => m.content).join('\n');
    };

    const momentPrompt = await runCapture('激励', momentSample);
    expect('B5 激励提示词含 moment 形态规则', momentPrompt.includes('激励赛道专用，覆盖通用形态要求'), momentPrompt.length);
    expect('B5 激励提示词不含 zodiac 附录', !momentPrompt.includes('星座赛道专用规则'), momentPrompt.includes('星座赛道专用规则'));
    expect('B5 激励提示词不再强制方法钩子', !momentPrompt.includes('指向方法的钩子'), momentPrompt.includes('指向方法的钩子'));
    expect('B5 激励提示词不再强制冲突/反差', !momentPrompt.includes('暗含冲突、反差或两难'), momentPrompt.includes('暗含冲突、反差或两难'));

    const scenePrompt = await runCapture('科技', sceneSample);
    expect('B6 科技提示词含 scene 形态规则', scenePrompt.includes('科技赛道专用，覆盖通用形态要求'), scenePrompt.length);
    expect('B6 科技提示词不含 zodiac 附录', !scenePrompt.includes('星座赛道专用规则'));
    expect('B6 科技提示词不再强制方法钩子', !scenePrompt.includes('指向方法的钩子'), scenePrompt.includes('指向方法的钩子'));

    // 复用 __smoke_angles_b_ 前缀：finally 里已有按前缀清赛道的规则
    // （Track.name 是 VarChar(32)，名字要短）
    const defaultPrompt = await runCapture(`__smoke_angles_b_d${stamp}`, '孩子把牛奶打翻后自己拿抹布擦，这算不算在学责任');
    expect('B7 未配置赛道：无 moment/scene 附录', !defaultPrompt.includes('激励赛道专用') && !defaultPrompt.includes('科技赛道专用'));
    expect('B7 未配置赛道：仍保留方法钩子要求', defaultPrompt.includes('指向方法的钩子'));
    expect('B7 未配置赛道：仍保留冲突/反差要求', defaultPrompt.includes('暗含冲突、反差或两难'));
    expect(
      'B7 未配置赛道：总纲里那句通用钩子原文一字未改',
      defaultPrompt.includes('每条的结尾必须留一个指向方法的钩子（怎么开口/怎么办/如何化解这类问法）'),
    );

    const zodiacPrompt = await runCapture('星座', zodiacSample);
    expect('B8 星座：仍用 zodiac 附录', zodiacPrompt.includes('星座赛道专用规则（覆盖上面的通用选题补充）'));
    expect('B8 星座：不含 moment/scene 附录', !zodiacPrompt.includes('激励赛道专用') && !zodiacPrompt.includes('科技赛道专用'));
    expect(
      'B8 星座：结尾要求已与本赛道钩子对齐（不再要求方法问句）',
      zodiacPrompt.includes('本赛道钩子') && !zodiacPrompt.includes('不许停在僵局或纯情绪上'),
      zodiacPrompt.includes('不许停在僵局或纯情绪上'),
    );
    expect(
      'B8 星座：总纲里不再出现通用方法钩子那句',
      !zodiacPrompt.includes('每条的结尾必须留一个指向方法的钩子'),
      zodiacPrompt.includes('每条的结尾必须留一个指向方法的钩子'),
    );
    expect(
      'B8 星座：总纲结尾换成星座钩子（反差/误解/行为切片/对号入座）',
      zodiacPrompt.includes('每条的结尾用本赛道钩子（反差 / 误解 / 行为切片 / 对号入座）'),
    );

    // ── B9 angleMode 白名单（隔离库写 StylePrompt 行验证，不碰业务库）──
    // 重点防的是 `a === 'x' || 'y' || 'z'` 这种恒真写法：非法值必须回落 default。
    console.log('— B9 angleMode 白名单 —');
    const putRule = async (name: string, rule: Record<string, unknown>) => {
      const key = `r:${name}`;
      const prompt = JSON.stringify(rule, null, 2);
      await prisma.stylePrompt.upsert({ where: { key }, create: { key, kind: 'rule', prompt }, update: { prompt } });
      return loadTrackRule(name);
    };
    const badStr = await putRule(`__smoke_b_mode_${stamp}`, { checks: [], angleMode: 'weird' });
    expect('B9 非法字符串 angleMode → default', badStr.angleMode === 'default', badStr.angleMode);
    const noKey = await putRule(`__smoke_b_nomode_${stamp}`, { checks: [] });
    expect('B9 缺 angleMode 键 → default', noKey.angleMode === 'default', noKey.angleMode);
    const nullMode = await putRule(`__smoke_b_nullmode_${stamp}`, { checks: [], angleMode: null });
    expect('B9 angleMode=null → default', nullMode.angleMode === 'default', nullMode.angleMode);
    const numMode = await putRule(`__smoke_b_nummode_${stamp}`, { checks: [], angleMode: 123 });
    expect('B9 angleMode=123 → default', numMode.angleMode === 'default', numMode.angleMode);
    const okMoment = await putRule(`__smoke_b_okmoment_${stamp}`, { checks: [], angleMode: 'moment' });
    expect('B9 合法 moment 原样保留', okMoment.angleMode === 'moment', okMoment.angleMode);
    const okScene = await putRule(`__smoke_b_okscene_${stamp}`, { checks: [], angleMode: 'scene' });
    expect('B9 合法 scene 原样保留', okScene.angleMode === 'scene', okScene.angleMode);
    const okZodiac = await putRule(`__smoke_b_okzodiac_${stamp}`, { checks: [], angleMode: 'zodiac' });
    expect('B9 合法 zodiac 原样保留', okZodiac.angleMode === 'zodiac', okZodiac.angleMode);
    const okDefault = await putRule(`__smoke_b_okdefault_${stamp}`, { checks: [], angleMode: 'default' });
    expect('B9 合法 default 原样保留', okDefault.angleMode === 'default', okDefault.angleMode);

    console.log(`\nSMOKE ANGLES: ALL PASS (${passed} 项)`);
  } finally {
    // ── 清理：绝不留下脏数据（TopicReview 随 Angle 级联删） ──
    await prisma.oAAccount.deleteMany({ where: { trackId } });
    await prisma.angle.deleteMany({ where: { trackId } });
    await prisma.article.deleteMany({ where: { trackId } });
    await prisma.track.deleteMany({ where: { id: trackId } });
    // S4-2 跨赛道测试数据（trackB 及其名下选题）
    await prisma.angle.deleteMany({ where: { track: { name: { startsWith: '__smoke_angles_b_' } } } });
    await prisma.article.deleteMany({ where: { track: { name: { startsWith: '__smoke_angles_b_' } } } });
    await prisma.track.deleteMany({ where: { name: { startsWith: '__smoke_angles_b_' } } });
    // S4-5 B 档形态测试用的真名赛道（形态按 name 查种子，只能用「激励/科技/星座」真名）
    const formTracks = ['激励', '科技', '星座'];
    await prisma.angle.deleteMany({ where: { track: { name: { in: formTracks } } } });
    await prisma.article.deleteMany({ where: { track: { name: { in: formTracks } } } });
    await prisma.track.deleteMany({ where: { name: { in: formTracks } } });
    // B9 白名单用例写的 r:* 行
    await prisma.stylePrompt.deleteMany({ where: { key: { startsWith: 'r:__smoke_b_' } } });
    server.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
