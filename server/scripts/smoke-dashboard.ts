/**
 * 工作台待办队列冒烟（S5-UI-2-B）。
 *
 * 目的：把「待办口径」的每条边界钉成断言，防止以后有人把它简化成
 * `count({status:'draft'})` 或「历史失败次数」这类看起来对、实际会虚报的写法。
 *
 * 覆盖（对应 S5-UI-2-B 验收清单 1–18）：
 *   A 选题：candidate/needs_revision 计入；used/approved/rejected 不计入；按赛道分组；最久等待；member 不可见
 *   B 文章：draft 无痕迹=未推送；draft+mediaId / draft+pushDate / updated=待重推；
 *           failed 无痕迹=推送失败；failed 有痕迹不计入；漫画单列
 *   C 体检：只取最新一条；旧失败被新通过覆盖；hash 不一致(stale)不计入；漫画排除；读操作不新增记录
 *   D 任务：7 天窗口；同键最新成功则旧失败不计入；push 不重复计数；comic_panel 按文章分组
 *   E 降级：某块失败 → 该块 null + degraded 登记，其他块不受影响
 *   F 空库：全部为 0（不是 null）
 *   G HTTP：GET /api/dashboard 仍返回原有字段 + todos
 *
 * ⚠️ 只跑隔离库（经 smoke-isolated.ts）；不调用真实 LLM / 微信；不写业务库。
 * 跑法：npm run smoke:dashboard（必须与其他 smoke 串行）
 */

process.env.SMOKE_NO_AUTH = '1';

import type { AddressInfo } from 'node:net';

import { prisma } from '../src/db.ts';
import { hashPassword, SESSION_COOKIE } from '../src/services/auth.ts';
import { getDashboard } from '../src/services/dashboard.ts';
import { htmlFingerprint } from '../src/services/lint-store.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

type DashboardPayload = Awaited<ReturnType<typeof getDashboard>>;

const STAMP = `s5ui2-${Date.now().toString(36)}`;
/** member 的登录口令（仅隔离库内的临时账号，用于验证 needs 不会绕过归属过滤）。 */
const MEMBER_PW = 'smoke-dash-12345';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** 造一篇文章（只填本测试用到的字段）。 */
function articleData(input: {
  trackId: number;
  accountId: number;
  title: string;
  status: 'draft' | 'updated' | 'pushed' | 'failed';
  pipeline?: 'article' | 'comic';
  mediaId?: string;
  pushDate?: string;
}) {
  return {
    trackId: input.trackId,
    accountId: input.accountId,
    title: input.title,
    contentHtml: `<h1>${input.title}</h1><p>正文段落，用于体检指纹。</p>`,
    contentWechat: '<p>x</p>',
    status: input.status,
    pipeline: input.pipeline ?? 'article',
    mediaId: input.mediaId ?? '',
    pushDate: input.pushDate ?? '',
    idempotencyKey: `${STAMP}-${input.title}`,
  };
}

async function main(): Promise<void> {
  console.log(`\n[s5-ui-2] 待办队列冒烟 ${STAMP}`);

  // ── 夹具：两条赛道、两个账号（一个无主=admin 视野，一个属 member）──
  const t1 = await prisma.track.create({ data: { name: `${STAMP}主赛道`, slug: `${STAMP}-t1` } });
  const t2 = await prisma.track.create({ data: { name: `${STAMP}次赛道`, slug: `${STAMP}-t2` } });
  const trackIds = [t1.id, t2.id];

  const accAdmin = await prisma.oAAccount.create({
    data: { trackId: t1.id, name: `${STAMP}管理员号`, appid: `${STAMP}-app1`, credStatus: 'missing' },
  });
  const member = await prisma.user.create({
    data: { username: `${STAMP}-member`, passwordHash: hashPassword(MEMBER_PW), role: 'member', status: 'active' },
  });
  const accMember = await prisma.oAAccount.create({
    data: {
      trackId: t1.id,
      name: `${STAMP}客户号`,
      appid: `${STAMP}-app2`,
      credStatus: 'missing',
      ownerUserId: member.id,
    },
  });
  const accountIds = [accAdmin.id, accMember.id];

  // 供 cleanup 定位「无 accountId 的 comic_panel 任务行」
  let a1Id = 0;
  let a5Id = 0;

  async function cleanup(): Promise<void> {
    await prisma.taskRun.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.taskRun.deleteMany({ where: { accountId: null, articleId: { in: [a1Id, a5Id] } } });
    await prisma.articleLintRun.deleteMany({ where: { article: { trackId: { in: trackIds } } } });
    await prisma.article.deleteMany({ where: { trackId: { in: trackIds } } });
    await prisma.angle.deleteMany({ where: { trackId: { in: trackIds } } });
    await prisma.oAAccount.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.user.deleteMany({ where: { id: member.id } });
    await prisma.track.deleteMany({ where: { id: { in: trackIds } } });
  }

  try {
    // ── A. 选题夹具 ──
    const g1 = await prisma.angle.create({
      data: {
        trackId: t1.id,
        code: `${STAMP}-g1`,
        seq: 1,
        theme: '关系修复',
        content: `${STAMP} 水逆第三天，她终于把攒了半年的旧账说出口`,
        status: 'candidate',
        used: false,
        updatedAt: daysAgo(5),
        metaJson: { scores: { total: 21 } },
      },
    });
    await prisma.angle.create({
      data: {
        trackId: t1.id,
        code: `${STAMP}-g2`,
        seq: 2,
        theme: '育儿',
        content: `${STAMP} 孩子写作业磨蹭，其实是在等你先坐下`,
        status: 'needs_revision',
        used: false,
        updatedAt: daysAgo(1),
      },
    });
    await prisma.angle.create({
      data: { trackId: t1.id, code: `${STAMP}-g3`, seq: 3, theme: 'x', content: `${STAMP} 已通过`, status: 'approved', used: false },
    });
    await prisma.angle.create({
      data: { trackId: t1.id, code: `${STAMP}-g4`, seq: 4, theme: 'x', content: `${STAMP} 已拒绝`, status: 'rejected', used: false },
    });
    const g5 = await prisma.angle.create({
      data: { trackId: t1.id, code: `${STAMP}-g5`, seq: 5, theme: 'x', content: `${STAMP} 候选但已被占用`, status: 'candidate', used: true },
    });
    await prisma.angle.create({
      data: {
        trackId: t2.id,
        code: `${STAMP}-g6`,
        seq: 1,
        theme: 'x',
        content: `${STAMP} 次赛道候选`,
        status: 'candidate',
        used: false,
        updatedAt: daysAgo(2),
      },
    });

    // ── B. 文章夹具（除 a8 外都挂 accAdmin）──
    const a1 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-草稿未推`, status: 'draft' }),
    });
    const a2 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-换封面回退`, status: 'draft', mediaId: 'm-a2' }),
    });
    const a3 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-只有pushDate`, status: 'draft', pushDate: '2026-11-10' }),
    });
    const a4 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-已改写待重推`, status: 'updated', mediaId: 'm-a4' }),
    });
    const a5 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-推送失败`, status: 'failed' }),
    });
    const a6 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-失败但有痕迹`, status: 'failed', mediaId: 'm-a6' }),
    });
    const a7 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accAdmin.id, title: `${STAMP}-漫画草稿`, status: 'draft', pipeline: 'comic' }),
    });
    // 两个推送字段都有值：仍属「草稿 + 有推送痕迹」→ 待重推
    const a9 = await prisma.article.create({
      data: articleData({
        trackId: t1.id,
        accountId: accAdmin.id,
        title: `${STAMP}-两字段都有`,
        status: 'draft',
        mediaId: 'm-a9',
        pushDate: '2026-11-12',
      }),
    });
    const a8 = await prisma.article.create({
      data: articleData({ trackId: t1.id, accountId: accMember.id, title: `${STAMP}-客户草稿`, status: 'draft' }),
    });
    a1Id = a1.id;
    a5Id = a5.id;

    // ── C. 体检夹具 ──
    // a5：最新一条 ok=false 且指纹一致 → 唯一有效失败
    await prisma.articleLintRun.create({
      data: { articleId: a5.id, trigger: 'save', ok: false, errorCount: 3, warnCount: 5, contentHash: htmlFingerprint(a5.contentHtml) },
    });
    // a1：先失败、后通过 → 只认最新一条，不应算失败
    await prisma.articleLintRun.create({
      data: { articleId: a1.id, trigger: 'save', ok: false, errorCount: 2, warnCount: 0, contentHash: htmlFingerprint(a1.contentHtml) },
    });
    await prisma.articleLintRun.create({
      data: { articleId: a1.id, trigger: 'check', ok: true, errorCount: 0, warnCount: 2, contentHash: htmlFingerprint(a1.contentHtml) },
    });
    // a2：最新失败但指纹不匹配（正文已改、未重新体检）→ stale，不计入
    await prisma.articleLintRun.create({
      data: { articleId: a2.id, trigger: 'save', ok: false, errorCount: 4, warnCount: 1, contentHash: htmlFingerprint('<p>旧正文</p>') },
    });
    // a7：漫画即使有失败记录也不进文章体检口径（防御性夹具）
    await prisma.articleLintRun.create({
      data: { articleId: a7.id, trigger: 'save', ok: false, errorCount: 9, warnCount: 0, contentHash: htmlFingerprint(a7.contentHtml) },
    });

    const lintCountBefore = await prisma.articleLintRun.count();

    // ── D. 任务夹具 ──
    const runBase = { runDate: '2026-11-17', attempt: 1, trigger: 'manual' as const };
    // 8 天前失败：超出 7 天窗口
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'write', status: 'failed', accountId: accAdmin.id, errorCode: 'write_failed', errorMessage: '老失败', createdAt: daysAgo(8) },
    });
    // 同键（write+账号）：3 天前失败、1 天前成功 → 最新成功，不计入
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'write', status: 'failed', accountId: accAdmin.id, errorCode: 'write_failed', errorMessage: '已恢复', createdAt: daysAgo(3) },
    });
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'write', status: 'success', accountId: accAdmin.id, createdAt: daysAgo(1) },
    });
    // comic_script 批次失败：与 write 是不同键，应计入
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'comic_script', status: 'failed', accountId: accAdmin.id, errorCode: 'comic_script_failed', errorMessage: '脚本失败', createdAt: daysAgo(1) },
    });
    // comic_panel 按 articleId 分组：计入
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'comic_panel', status: 'failed', articleId: a1.id, createdAt: daysAgo(1) },
    });
    // push 失败：已有 articles.pushFailed 口径，这里不得重复计入
    await prisma.taskRun.create({
      data: { ...runBase, jobType: 'push', status: 'failed', accountId: accAdmin.id, articleId: a5.id, errorCode: '40164', errorMessage: '推送失败', createdAt: daysAgo(1) },
    });

    // ════════════════════════════ 断言 ════════════════════════════
    console.log('\n[1] admin：选题待办');
    const admin = await getDashboard(null);
    const t = admin.todos;
    expect('1 scope=all', t.scope === 'all', t.scope);
    expect('2 candidate + needs_revision 计入（total=3）', t.angles?.total === 3, t.angles);
    expect('3 candidate=2', t.angles?.candidate === 2, t.angles);
    expect('4 needsRevision=1', t.angles?.needsRevision === 1, t.angles);
    expect('5 approved / rejected 不计入', (t.angles?.total ?? 0) === 3, t.angles?.byTrack);
    expect('6 used=true 的 candidate 不计入明细', !t.angles?.recent.some((r) => r.id === g5.id), t.angles?.recent.map((r) => r.id));
    const byT1 = t.angles?.byTrack.find((x) => x.trackId === t1.id);
    const byT2 = t.angles?.byTrack.find((x) => x.trackId === t2.id);
    expect('7 按赛道分组：T1 = 1 候选 + 1 待改', byT1?.candidate === 1 && byT1?.needsRevision === 1, byT1);
    expect('8 按赛道分组：T2 = 1 候选', byT2?.candidate === 1 && byT2?.needsRevision === 0, byT2);
    expect('9 最久等待天数取 updatedAt（≥5 天）', (t.angles?.oldestWaitingDays ?? 0) >= 5, t.angles?.oldestWaitingDays);
    expect('10 明细最多 3 条', (t.angles?.recent.length ?? 0) <= 3, t.angles?.recent.length);
    expect('11 明细按等待时间从长到短（最久的是 g1）', t.angles?.recent[0]?.id === g1.id, t.angles?.recent.map((r) => r.id));
    expect('12 明细带六维总分', t.angles?.recent[0]?.scoreTotal === 21, t.angles?.recent[0]);

    console.log('\n[2] member：选题不可见且不算降级');
    const own = await getDashboard(member.id);
    expect('13 scope=own', own.todos.scope === 'own', own.todos.scope);
    expect('14 member 的 angles 为 null', own.todos.angles === null, own.todos.angles);
    expect('15 权限限制不进 degraded', own.todos.degraded.length === 0, own.todos.degraded);
    expect('16 member 只看到自己账号的文章（未推送=1）', own.todos.articles.draftUnpushed === 1, own.todos.articles);

    console.log('\n[3] admin：文章三类 + 漫画单列');
    expect('17 未推送草稿 = 2（admin 号 + 客户号，均无推送痕迹）', t.articles.draftUnpushed === 2, t.articles);
    expect('18 待重推 = 4（draft+mediaId / draft+pushDate / draft+两字段 / updated）', t.articles.repush === 4, t.articles);
    expect('19 推送失败 = 1（只有无痕迹的 failed）', t.articles.pushFailed === 1, t.articles);
    expect('20 failed 但有 mediaId 不计入任何一类', !t.articles.recent.some((r) => r.id === a6.id) && t.articles.pushFailed === 1, {
      recent: t.articles.recent.map((r) => r.id),
      pushFailed: t.articles.pushFailed,
    });
    expect('21 漫画草稿单列 = 1', t.articles.comicDraft === 1, t.articles);
    expect('22 漫画不混入文章三类（未推送仍为 2）', t.articles.draftUnpushed === 2, t.articles);
    expect('23 文章明细 ≤ 3 且不含漫画稿', (t.articles.recent.length ?? 0) <= 3 && !t.articles.recent.some((r) => r.id === a7.id), t.articles.recent);

    console.log('\n[4] 体检：最新一条 + 指纹一致');
    expect('24 有效失败 = 1', t.lint.failed === 1, t.lint);
    expect('25 明细指向 a5', t.lint.recent[0]?.articleId === a5.id, t.lint.recent);
    expect('26 旧失败被更新的「通过」覆盖（a1 不计入）', !t.lint.recent.some((r) => r.articleId === a1.id), t.lint.recent);
    expect('27 指纹不一致(stale)不计入（a2 不计入）', !t.lint.recent.some((r) => r.articleId === a2.id), t.lint.recent);
    expect('28 漫画文章不进文章体检口径（a7 不计入）', !t.lint.recent.some((r) => r.articleId === a7.id), t.lint.recent);
    expect('29 明细带 errorCount/warnCount/checkedAt', t.lint.recent[0]?.errorCount === 3 && Boolean(t.lint.recent[0]?.checkedAt), t.lint.recent[0]);

    console.log('\n[5] 任务：7 天窗口 + 同键恢复 + push 不重复');
    expect('30 windowDays=7', t.runs.windowDays === 7, t.runs.windowDays);
    expect('31 未恢复失败 = 2（comic_script 1 + comic_panel 1）', t.runs.unresolved === 2, t.runs);
    expect('32 push 失败不重复计入', t.runs.recent.every((r) => r.jobType !== 'push'), t.runs.recent);
    expect('33 窗口外失败不计入、恢复后旧失败不计入', t.runs.unresolved === 2, t.runs);
    expect('34 comic_script 按批次计 1 次（不是按篇）', t.runs.recent.filter((r) => r.jobType === 'comic_script').length === 1, t.runs.recent);
    expect('35 明细 ≤ 3 条', t.runs.recent.length <= 3, t.runs.recent.length);

    console.log('\n[6] 读操作零副作用');
    const lintCountAfter = await prisma.articleLintRun.count();
    expect('36 工作台请求不新增 ArticleLintRun', lintCountAfter === lintCountBefore, { lintCountBefore, lintCountAfter });

    console.log('\n[7] 降级：单块失败不拖垮其他块，且显示 null 而非 0');
    const realAngle = prisma.angle;
    const originalGroupBy = realAngle.groupBy;
    (realAngle as unknown as { groupBy: unknown }).groupBy = () => {
      throw new Error('注入失败：模拟 angles 聚合查询挂掉');
    };
    let degraded: DashboardPayload;
    try {
      degraded = await getDashboard(null);
    } finally {
      (realAngle as unknown as { groupBy: unknown }).groupBy = originalGroupBy;
    }
    expect('37 失败块计数为 null（不是 0）', degraded.todos.angles?.total === null, degraded.todos.angles);
    expect('38 失败块登记进 degraded', degraded.todos.degraded.includes('angles'), degraded.todos.degraded);
    expect('39 其他块不受影响（文章仍为 2）', degraded.todos.articles.draftUnpushed === 2, degraded.todos.articles);
    expect('40 其他块不受影响（体检仍为 1）', degraded.todos.lint.failed === 1, degraded.todos.lint);

    console.log('\n[8] HTTP：GET /api/dashboard 原字段 + todos');
    const { createApp } = await import('../src/app.ts');
    const app = createApp();
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const net = (globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__;
    if (!net?.register(srv)) throw new Error('smoke-net-guard 未预载，拒绝运行');
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      const body = (await res.json()) as {
        todos?: { scope?: string; angles?: { total?: number } };
        counts?: unknown;
        today?: { byPipeline?: unknown };
        recentRuns?: unknown;
      };
      expect('41 /api/dashboard 200', res.status === 200, res.status);
      expect('42 响应含 todos 且 scope=all', body.todos?.scope === 'all', body.todos?.scope);
      expect('43 todos.angles.total 与直调一致', body.todos?.angles?.total === 3, body.todos?.angles);
      expect('44 原有 counts 仍在', Boolean(body.counts), body.counts);
      expect('45 原有 today.byPipeline 仍在', Array.isArray(body.today?.byPipeline), body.today);
      expect('46 原有 recentRuns 仍在', Array.isArray(body.recentRuns), typeof body.recentRuns);

      /* ── S5-UI-2-D-2：GET /api/articles?needs=… 走真实 Prisma 下推 ── */
      const base = `http://127.0.0.1:${port}`;
      type ListBody = {
        total?: number;
        items?: Array<{ id: number; status?: string }>;
      };
      const getArticles = async (qs: string, cookie?: string) => {
        const r = await fetch(`${base}/api/articles${qs}`, cookie ? { headers: { Cookie: cookie } } : undefined);
        return { status: r.status, body: (await r.json()) as ListBody };
      };
      const idsOf = (b: ListBody): number[] => (b.items ?? []).map((x) => x.id).sort((x, y) => x - y);
      const eqSet = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

      const du = await getArticles('?needs=draft_unpushed&limit=100');
      expect('47 needs=draft_unpushed 200', du.status === 200, du.status);
      expect('48 draft_unpushed total = 2（admin 号 + 客户号，均无推送痕迹）', du.body.total === 2, du.body.total);
      expect(
        '49 draft_unpushed 集合 = {a1, a8}（漫画 / 有痕迹 / updated / failed 都不进）',
        eqSet(idsOf(du.body), [a1.id, a8.id].sort((x, y) => x - y)),
        idsOf(du.body),
      );

      const rp = await getArticles('?needs=repush&limit=100');
      expect('50 needs=repush 200', rp.status === 200, rp.status);
      expect('51 repush total = 4（mediaId / pushDate / 两字段 / updated）', rp.body.total === 4, rp.body.total);
      expect(
        '52 repush 集合 = {a2, a3, a4, a9}',
        eqSet(idsOf(rp.body), [a2.id, a3.id, a4.id, a9.id].sort((x, y) => x - y)),
        idsOf(rp.body),
      );
      expect(
        '53 repush 不含 pushed / failed / 漫画（a5 a6 a7 均不在）',
        ![a5.id, a6.id, a7.id].some((id) => idsOf(rp.body).includes(id)),
        idsOf(rp.body),
      );

      // needs 与 status 同传：needs 优先（status 被忽略）
      const both = await getArticles('?needs=draft_unpushed&status=pushed&limit=100');
      expect('54 needs 与 status 同传时 needs 优先', both.body.total === 2, both.body.total);

      // 非法 needs：按未传处理（退化为普通列表，不是 400、不是空列表）
      const allCount = await prisma.article.count();
      const bogus = await getArticles('?needs=whatever&limit=100');
      expect('55 非法 needs 退化为普通列表', bogus.status === 200 && bogus.body.total === allCount, {
        status: bogus.status,
        total: bogus.body.total,
        allCount,
      });

      // 叠加 accountId 仍生效
      const byAcc = await getArticles(`?needs=draft_unpushed&accountId=${accMember.id}&limit=100`);
      expect('56 accountId 可与 needs 叠加', byAcc.body.total === 1 && idsOf(byAcc.body)[0] === a8.id, {
        total: byAcc.body.total,
        ids: idsOf(byAcc.body),
      });

      // 分页：两页合并 = 全量，且无重复
      const p1 = await getArticles('?needs=repush&limit=2&offset=0');
      const p2 = await getArticles('?needs=repush&limit=2&offset=2');
      const paged = [...idsOf(p1.body), ...idsOf(p2.body)];
      expect('57 分页无重复无遗漏（2+2 = total 4）', paged.length === 4 && new Set(paged).size === 4 && p1.body.total === 4, {
        paged,
        total: p1.body.total,
      });
      expect('58 total 与 items 实际集合一致（拉全后长度相等）', idsOf(rp.body).length === rp.body.total, {
        items: idsOf(rp.body).length,
        total: rp.body.total,
      });

      // 与 Dashboard 数字对照（同一批夹具、同口径）
      const dash = await getDashboard(null);
      expect('59 needs=draft_unpushed 的 total 与 Dashboard draftUnpushed 一致', du.body.total === dash.todos.articles.draftUnpushed, {
        api: du.body.total,
        dashboard: dash.todos.articles.draftUnpushed,
      });
      expect('60 needs=repush 的 total 与 Dashboard repush 一致', rp.body.total === dash.todos.articles.repush, {
        api: rp.body.total,
        dashboard: dash.todos.articles.repush,
      });

      // member 会话：needs 不得绕过归属过滤。
      // 注意：请求必须在「旁路关闭」期间发出——旁路一旦生效会无视 Cookie 直接给 admin，
      // 断言就变成在测 admin（第一版踩过：total 返回 2 而不是 1）。
      const prevBypass = process.env.SMOKE_NO_AUTH;
      let memList: { status: number; body: ListBody };
      try {
        delete process.env.SMOKE_NO_AUTH;
        const lr = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: `${STAMP}-member`, password: MEMBER_PW }),
        });
        const sc = lr.headers.get('set-cookie') ?? '';
        const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(sc)?.[1] ?? '';
        memList = await getArticles('?needs=draft_unpushed&limit=100', `${SESSION_COOKIE}=${sid}`);
      } finally {
        process.env.SMOKE_NO_AUTH = prevBypass;
      }
      expect('61 member 的 needs 结果只含自己账号的文章', memList.body.total === 1 && idsOf(memList.body)[0] === a8.id, {
        total: memList.body.total,
        ids: idsOf(memList.body),
      });

      /* ── 纯空白监测（D2 的兜底）：隔离库里不存在「非空但 trim 为空」的推送字段 ── */
      const allRows = await prisma.article.findMany({ select: { id: true, mediaId: true, pushDate: true } });
      const blankRows = allRows.filter(
        (r) => (r.mediaId !== '' && r.mediaId.trim() === '') || (r.pushDate !== '' && r.pushDate.trim() === ''),
      );
      expect('62 隔离库无「非空但 trim 为空」的 mediaId / pushDate', blankRows.length === 0, blankRows);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }

    console.log('\n[9] 清空后：0 而不是 null');
    await cleanup();
    const empty = await getDashboard(null);
    expect('63 空库 angles.total=0', empty.todos.angles?.total === 0, empty.todos.angles);
    expect('64 空库 draftUnpushed=0', empty.todos.articles.draftUnpushed === 0, empty.todos.articles);
    expect('65 空库 lint.failed=0', empty.todos.lint.failed === 0, empty.todos.lint);
    expect('66 空库 runs.unresolved=0', empty.todos.runs.unresolved === 0, empty.todos.runs);
    expect('67 空库无降级', empty.todos.degraded.length === 0, empty.todos.degraded);

    console.log(`\n全部通过：${passed} 项断言`);
  } finally {
    await cleanup().catch(() => undefined);
  }
}

main()
  .catch((e) => {
    console.error('SMOKE DASHBOARD FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  })
  .finally(() => {
    // express 会持有事件循环，不显式退出会让 runner 等到超时。
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
