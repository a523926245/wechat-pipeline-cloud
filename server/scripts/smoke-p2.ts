/**
 * P2 冒烟：漫画生图并发/退避 + 仪表盘按产线分组 + Track.quotaPerDay 迁移兼容。
 *
 * 刻意**不真发生图**（一次 30~40s，不该进冒烟）：并发与退避是可判定的纯逻辑，
 * 直接断言 panelBackoffMs / isPanelDue / mapLimit；产线相关的落库与双写走 HTTP 真跑。
 *
 * 覆盖：
 *   1. 退避：attempt 0 不等、指数增长、触及上限、退避窗口内外是否到期
 *   2. 并发：mapLimit 限制同时在飞数、结果按输入顺序返回、空数组安全
 *   3. 分组：groupByPipeline 求和/排序（已知产线固定序，未知产线排最后）
 *   4. GET /api/pipelines 元数据、GET /api/dashboard 的 byPipeline 与总数自洽
 *   5. 建赛道即播种产线；改 deprecated 的 Track.quotaPerDay 会双写到 article 产线；删赛道级联
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * 跑法：npm run smoke:p2（SQLite 单写者，必须与其他 smoke 串行）
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { COMIC_IMAGE } from '../src/config.ts';
import { groupByPipeline } from '../src/services/dashboard.ts';
import { isPanelDue, mapLimit, panelBackoffMs } from '../src/services/comic/panels.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. 退避（纯函数）──
function testBackoff(): void {
  const base = COMIC_IMAGE.retryBaseDelayMs;
  const cap = COMIC_IMAGE.retryMaxDelayMs;
  expect('1 退避：未失败过（attempt=0）不等待', panelBackoffMs(0) === 0, panelBackoffMs(0));
  expect('1 退避：第 1 次失败 = 基数', panelBackoffMs(1) === base, panelBackoffMs(1));
  expect('1 退避：第 2 次失败 = 2×基数（指数）', panelBackoffMs(2) === Math.min(base * 2, cap), panelBackoffMs(2));
  expect('1 退避：第 3 次失败 = 4×基数', panelBackoffMs(3) === Math.min(base * 4, cap), panelBackoffMs(3));
  expect('1 退避：大 attempt 触及上限不再增长', panelBackoffMs(99) === cap, panelBackoffMs(99));
  expect('1 退避：非法值按 0 处理', panelBackoffMs(Number.NaN) === 0 && panelBackoffMs(-1) === 0);

  const now = Date.now();
  expect('1 到期：attempt=0 立即可跑', isPanelDue({ attempt: 0, updatedAt: new Date(now) }, now));
  expect(
    '1 到期：刚失败（attempt=1, 0ms）在退避窗口内',
    isPanelDue({ attempt: 1, updatedAt: new Date(now) }, now) === false,
  );
  expect(
    '1 到期：已等够退避时长则可重试',
    isPanelDue({ attempt: 1, updatedAt: new Date(now - base - 1) }, now),
  );
  expect(
    '1 到期：等待不足仍不可重试',
    isPanelDue({ attempt: 1, updatedAt: new Date(now - Math.floor(base / 2)) }, now) === false,
  );
}

// ── 2. 并发（纯函数）──
async function testConcurrency(): Promise<void> {
  const items = [1, 2, 3, 4, 5, 6];
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await mapLimit(items, 2, async (n) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(20);
    inFlight -= 1;
    return n * 10;
  });
  expect('2 并发：结果按输入顺序返回', JSON.stringify(out) === JSON.stringify([10, 20, 30, 40, 50, 60]), out);
  expect('2 并发：同时在飞数不超过设定值 2', maxInFlight <= 2, maxInFlight);
  expect('2 并发：确实并发了（在飞数 > 1）', maxInFlight > 1, maxInFlight);

  const single = await mapLimit(items, 1, async (n) => n);
  expect('2 并发：limit=1 时串行且结果一致', JSON.stringify(single) === JSON.stringify(items) && maxInFlight <= 2);

  const empty = await mapLimit([], 3, async (n: number) => n);
  expect('2 并发：空数组安全返回 []', Array.isArray(empty) && empty.length === 0);

  let rejected = false;
  try {
    await mapLimit([1, 2], 2, async () => {
      throw new Error('boom');
    });
  } catch {
    rejected = true;
  }
  expect('2 并发：任务抛错会向上冒泡（调用方自行收敛）', rejected);
}

// ── 3. 按产线分组（纯函数）──
function testGroupByPipeline(): void {
  const rows = [
    { accountId: 1, account: 'A', track: 'T', pipeline: 'article', quota: 2, produced: 1, pending: 1, angleStock: 90 },
    { accountId: 1, account: 'A', track: 'T', pipeline: 'comic', quota: 1, produced: 0, pending: 1, angleStock: 90 },
    { accountId: 2, account: 'B', track: 'T', pipeline: 'article', quota: 2, produced: 2, pending: 0, angleStock: 90 },
  ];
  const g = groupByPipeline(rows);
  expect('3 分组：两条产线各一组', g.length === 2, g);
  expect('3 分组：文章在前、漫画在后（与排产顺序一致）', g[0].pipeline === 'article' && g[1].pipeline === 'comic', g);
  expect('3 分组：文章线汇总 配额4/已出3/待补1/账号2', g[0].quota === 4 && g[0].produced === 3 && g[0].pending === 1 && g[0].accounts === 2, g[0]);
  expect('3 分组：漫画线汇总 配额1/已出0/待补1/账号1', g[1].quota === 1 && g[1].produced === 0 && g[1].pending === 1 && g[1].accounts === 1, g[1]);

  const withUnknown = groupByPipeline([
    ...rows,
    { accountId: 3, account: 'C', track: 'T', pipeline: 'video', quota: 1, produced: 0, pending: 1, angleStock: 90 },
  ]);
  expect('3 分组：未知产线也成组且不丢', withUnknown.length === 3, withUnknown);
  expect('3 分组：未知产线排在已知产线之后', withUnknown[2].pipeline === 'video', withUnknown);

  expect('3 分组：空输入返回空数组', groupByPipeline([]).length === 0);
}

interface JsonRes<T> {
  status: number;
  json: T;
}

async function main(): Promise<void> {
  console.log('— 纯函数 —');
  testBackoff();
  await testConcurrency();
  testGroupByPipeline();

  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<JsonRes<T>> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as T;
    return { status: res.status, json };
  }

  const stamp = Date.now().toString(36);
  const slug = `smoke-p2-${stamp}`;
  let trackId = 0;

  try {
    console.log('— 产线元数据 —');
    const meta = await call<{
      pipelines: { kind: string; label: string; angleScopes: string[] }[];
      angleScopes: { value: string }[];
    }>('GET', '/api/pipelines');
    expect('4 元数据：/api/pipelines 200', meta.status === 200, meta.json);
    expect('4 元数据：含 article/comic 两条产线', meta.json.pipelines?.length === 2, meta.json.pipelines);
    expect(
      '4 元数据：产线有中文名与角度切片',
      !!meta.json.pipelines?.every((p) => p.label && p.angleScopes?.length > 0),
      meta.json.pipelines,
    );
    expect('4 元数据：角度切片含 shared', meta.json.angleScopes?.some((s) => s.value === 'shared'), meta.json.angleScopes);

    console.log('— 仪表盘按产线分组 —');
    const dash = await call<{
      today: {
        quotaTotal: number;
        produced: number;
        pending: number;
        byAccount: { pipeline: string; quota: number; produced: number; pending: number }[];
        byPipeline: { pipeline: string; quota: number; produced: number; pending: number; accounts: number }[];
      };
    }>('GET', '/api/dashboard');
    expect('5 仪表盘：200 且含 byPipeline 数组', dash.status === 200 && Array.isArray(dash.json.today?.byPipeline), dash.status);
    const bp = dash.json.today.byPipeline ?? [];
    const sumQuota = bp.reduce((s, x) => s + x.quota, 0);
    const sumAccounts = bp.reduce((s, x) => s + x.accounts, 0);
    const sumPending = bp.reduce((s, x) => s + x.pending, 0);
    expect('5 仪表盘：分组配额之和 = 总配额', sumQuota === dash.json.today.quotaTotal, { sumQuota, total: dash.json.today.quotaTotal });
    expect('5 仪表盘：分组账号数之和 = 任务条数', sumAccounts === dash.json.today.byAccount.length, { sumAccounts, n: dash.json.today.byAccount.length });
    expect('5 仪表盘：分组待补之和 = 总待补', sumPending === dash.json.today.pending, { sumPending, pending: dash.json.today.pending });
    expect(
      '5 仪表盘：分组顺序为已知产线优先',
      bp.every((x, i) => i === 0 || !(x.pipeline === 'article' && bp[i - 1].pipeline === 'comic')),
      bp,
    );

    console.log('— deprecated 字段 Track.quotaPerDay 的迁移兼容 —');
    const created = await call<{ id: number; quotaPerDay: number }>('POST', '/api/tracks', {
      name: `__smoke_p2_${stamp}__`,
      slug,
      quotaPerDay: 2,
      enabled: true,
    });
    expect('6 建赛道：201', created.status === 201, created.json);
    trackId = created.json.id ?? 0;
    expect('6 建赛道：拿到 id', trackId > 0, created.json);

    const seeded = await call<{
      items: { kind: string; quotaPerDay: number; enabled: boolean; seeded: boolean }[];
    }>('GET', `/api/tracks/${trackId}/pipelines`);
    expect('6 建赛道：立即播种两条产线（不再是回落值）', seeded.json.items?.length === 2 && seeded.json.items.every((i) => i.seeded), seeded.json);
    const article0 = seeded.json.items?.find((i) => i.kind === 'article');
    const comic0 = seeded.json.items?.find((i) => i.kind === 'comic');
    expect('6 建赛道：article 沿用配额 2 且启用', article0?.quotaPerDay === 2 && article0?.enabled === true, article0);
    expect('6 建赛道：comic 默认 0 且停用', comic0?.quotaPerDay === 0 && comic0?.enabled === false, comic0);

    const patched = await call<{ quotaPerDay: number }>('PUT', `/api/tracks/${trackId}`, { quotaPerDay: 5 });
    expect('7 双写：旧入口改配额返回 200', patched.status === 200, patched.json);
    expect('7 双写：赛道镜像值已变 5', patched.json.quotaPerDay === 5, patched.json);
    const afterPatch = await call<{ items: { kind: string; quotaPerDay: number }[] }>('GET', `/api/tracks/${trackId}/pipelines`);
    expect(
      '7 双写：article 产线真源同步为 5（旧字段不再是独立真源）',
      afterPatch.json.items?.find((i) => i.kind === 'article')?.quotaPerDay === 5,
      afterPatch.json,
    );

    const comicSet = await call<{ quotaPerDay: number; enabled: boolean }>('PUT', `/api/tracks/${trackId}/pipelines/comic`, {
      quotaPerDay: 1,
      enabled: true,
    });
    expect('8 产线：漫画线开配额 1 并启用', comicSet.status === 200 && comicSet.json.quotaPerDay === 1 && comicSet.json.enabled === true, comicSet.json);
    const trackRow = await prisma.track.findUnique({ where: { id: trackId }, select: { quotaPerDay: true } });
    expect('8 产线：改漫画线不影响文章线镜像值', trackRow?.quotaPerDay === 5, trackRow);

    console.log('— 角度切片：给漫画产线补选题的入口 —');
    // 漫画产线只吃 comic/shared。此前扩库与新增都硬落在 article 切片上，
    // 于是「漫画线可用角度 0」——这里把「按切片造、按切片查、按切片改」整条链路钉住。
    const mk = async (content: string, scope: string) =>
      call<{ id: number; scope: string; offIp: boolean }>('POST', '/api/angles', {
        trackId,
        content,
        scope,
      });

    const aArt = await mk('冒烟-文章切片选题：陪写作业陪到自己先崩溃', 'article');
    const aComic = await mk('冒烟-漫画切片选题：奶奶端着碗追在孩子后面喂饭', 'comic');
    const aShared = await mk('冒烟-共享切片选题：孩子把牛奶打翻后先看来不来得及擦', 'shared');
    expect('10 切片：新增可指定 article/comic/shared', aArt.json.scope === 'article' && aComic.json.scope === 'comic' && aShared.json.scope === 'shared', [aArt.json, aComic.json, aShared.json]);

    const listComic = await call<{ total: number; items: { scope: string }[] }>(
      'GET',
      `/api/angles?trackId=${trackId}&scope=comic`,
    );
    expect('10 切片：按 comic 过滤只剩漫画专用', listComic.json.total === 1 && listComic.json.items[0]?.scope === 'comic', listComic.json);
    const listAll = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}`);
    expect('10 切片：不传 scope 返回全部 3 条', listAll.json.total === 3, listAll.json);

    const moved = await call<{ scope: string }>('PUT', `/api/angles/${aArt.json.id}`, { scope: 'shared' });
    expect('11 改切片：文章专用 → 共享', moved.status === 200 && moved.json.scope === 'shared', moved.json);
    const listShared = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}&scope=shared`);
    expect('11 改切片：共享池从 1 变 2', listShared.json.total === 2, listShared.json);

    const pipes = await call<{ items: { kind: string; angleUnused: number }[] }>(
      'GET',
      `/api/tracks/${trackId}/pipelines`,
    );
    const pArt = pipes.json.items?.find((i) => i.kind === 'article');
    const pComic = pipes.json.items?.find((i) => i.kind === 'comic');
    // 改完后：article=0、comic=1、shared=2 → 文章线吃 0+2=2，漫画线吃 1+2=3
    expect('12 可用选题：文章线按切片统计为 2', pArt?.angleUnused === 2, pipes.json);
    expect('12 可用选题：漫画线按切片统计为 3', pComic?.angleUnused === 3, pipes.json);

    const badExpand = await call<{ error?: unknown }>('POST', `/api/tracks/${trackId}/expand`, {
      count: 1,
      scope: 'bogus',
    });
    expect('13 校验：扩库传非法切片 → 400（不触发 LLM）', badExpand.status === 400, badExpand.status);
    const badQuery = await call<{ error?: unknown }>('GET', `/api/angles?trackId=${trackId}&scope=bogus`);
    expect('13 校验：列表传非法切片 → 400', badQuery.status === 400, badQuery.status);

    console.log('— 漫画选题体检：IP 外人物（奶奶/老师）识别与退回 —');
    // 家庭 IP 只有爸爸/妈妈/哥哥/弟弟，选题里出现「奶奶」这类角色时漫画画不出来
    // （会被硬塞成爸妈 → 图文不符）。这里钉住「标记 → 统计 → 一键退回文章专用」。
    expect(
      '14 IP 检出：前面那条含「奶奶」的漫画选题被标为 offIp',
      aComic.json.offIp === true,
      aComic.json,
    );
    const offIpAll = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}&offIp=1`);
    expect('14 IP 检出：全赛道命中 1 条', offIpAll.json.total === 1, offIpAll.json);

    const cleanComic = await mk('冒烟-漫画切片选题：哥哥抢弟弟的玩具车谁也不肯先松手', 'comic');
    expect(
      '14 IP 检出：不含 IP 外角色的选题 offIp=false',
      cleanComic.json.offIp === false,
      cleanComic.json,
    );
    const offIpAfterAdd = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}&offIp=1`);
    expect('14 IP 检出：新增合规选题不改变命中数', offIpAfterAdd.json.total === 1, offIpAfterAdd.json);

    const before = await call<{ items: { kind: string; angleUnused: number }[] }>(
      'GET',
      `/api/tracks/${trackId}/pipelines`,
    );
    const comicBefore = before.json.items?.find((i) => i.kind === 'comic')?.angleUnused ?? -1;

    const reassign = await call<{ changed: number; ids: number[]; message: string }>(
      'POST',
      '/api/angles/off-ip-to-article',
      { trackId },
    );
    expect('15 退回：只动漫画切片里那 1 条', reassign.status === 200 && reassign.json.changed === 1, reassign.json);
    expect('15 退回：返回被改的 id', reassign.json.ids?.includes(aComic.json.id) === true, reassign.json);

    const offIpAfter = await call<{ total: number }>(
      'GET',
      `/api/angles?trackId=${trackId}&scope=comic&offIp=1`,
    );
    expect('15 退回：漫画切片已无 IP 外选题', offIpAfter.json.total === 0, offIpAfter.json);

    // 退回前后：comic 切片 2 → 1（那条含「奶奶」的移走了，合规的 cleanComic 还在）
    const stillComic = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}&scope=comic`);
    expect('15 退回：漫画切片只剩合规那条', stillComic.json.total === 1, stillComic.json);
    const allAngles = await call<{ total: number }>('GET', `/api/angles?trackId=${trackId}`);
    expect('15 退回：选题没被删（全赛道总数不变）', allAngles.json.total === 4, allAngles.json);

    const after = await call<{ items: { kind: string; angleUnused: number }[] }>(
      'GET',
      `/api/tracks/${trackId}/pipelines`,
    );
    const comicAfter = after.json.items?.find((i) => i.kind === 'comic')?.angleUnused ?? -1;
    expect(
      '15 退回：漫画线可用选题减少 1（不再是它能消费的切片）',
      comicBefore > 0 && comicAfter === comicBefore - 1,
      { comicBefore, comicAfter },
    );

    const del = await call<{ ok: boolean }>('DELETE', `/api/tracks/${trackId}`);
    expect('9 删赛道：200', del.status === 200, del.json);
    const left = await prisma.trackPipeline.count({ where: { trackId } });
    expect('9 删赛道：产线行级联清理', left === 0, { left });

    console.log(`\nSMOKE P2: ALL PASS (${passed} 项)`);
  } finally {
    // ── 清理：绝不留下脏数据 ──
    if (trackId > 0) {
      await prisma.angle.deleteMany({ where: { trackId } });
      await prisma.trackPipeline.deleteMany({ where: { trackId } });
      await prisma.track.deleteMany({ where: { id: trackId } });
    }
    server.close();
    await prisma.$disconnect();
  }
}

main()
  .then(() => setTimeout(() => process.exit(0), 200))
  .catch((e) => {
    console.error('SMOKE FAILED:', e instanceof Error ? e.message : e);
    setTimeout(() => process.exit(1), 200);
  });
