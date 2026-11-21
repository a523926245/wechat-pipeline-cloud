/**
 * 单元测试（Mock，全程不连库）：lint-store 两条**读**路径在「表缺失 / 查询异常」时降级。
 *
 * 背景（S5-2 审计 + S5-2-HF1 修复）：
 * - `ArticleLintRun` 迁移尚未部署到业务库时，`findFirst/findMany` 会抛 Prisma P2021；
 * - 这两条读路径服务于「最近存档 / 历史记录」，是非核心的辅助信息，
 *   一旦抛出就把 `GET /articles/:id/preview`（改稿页主流程）拖成 500；
 * - 修复口径：读失败 → latest 返 null、list 返 []，并打 warn（降级但不静默）；
 * - 写路径（recordLintRun）不在本测试范围——它的失败必须显式透出 `saved:false`。
 *
 * 测试手法：把 `prisma.articleLintRun` 换成假委托（同一对象上的属性替换，
 * lint-store 通过 `{ prisma }` 拿到的是同一个单例，因此替换即生效），
 * 因此**不需要数据库、不执行任何 SQL、不触发 Prisma 引擎连接**。
 *
 * 跑法：`npm run test:lint-store`
 */
import { Prisma } from '@prisma/client';

import { prisma } from '../src/db.ts';
import { logger } from '../src/logger.ts';
import { latestLintRun, listLintRuns } from '../src/services/lint-store.ts';

// ─────────────────────────────────────────────────────────────
// 极简断言器（与项目其它脚本同款：不引第三方测试框架）
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failed: string[] = [];

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ❌ ${name}${detail ? `  ← ${detail}` : ''}`);
  }
}

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, name, a === e ? '' : `期望 ${e} / 实际 ${a}`);
}

// ─────────────────────────────────────────────────────────────
// Mock：替换 Prisma 模型委托 + 捕获 logger.warn
// ─────────────────────────────────────────────────────────────
interface WarnCall {
  obj: Record<string, unknown>;
  msg: string;
}

const realDelegate = prisma.articleLintRun;
const realWarn = logger.warn;
let warns: WarnCall[] = [];

/** 把 `prisma.articleLintRun` 换成假委托（只提供被测函数用到的两个方法）。 */
function stubDelegate(delegate: Record<string, unknown>): void {
  (prisma as unknown as { articleLintRun: unknown }).articleLintRun = delegate;
}

function restoreDelegate(): void {
  (prisma as unknown as { articleLintRun: unknown }).articleLintRun = realDelegate;
}

function spyWarn(): void {
  warns = [];
  (logger as unknown as { warn: unknown }).warn = (obj: Record<string, unknown>, msg: string): void => {
    warns.push({ obj, msg });
  };
}

function restoreWarn(): void {
  (logger as unknown as { warn: unknown }).warn = realWarn;
}

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

/** 一行体检记录。Json 列按项目约定存**字符串**（db-json.ts：写 stringify / 读 parse）。 */
function row(id: number, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    trigger: 'save',
    ok: true,
    errorCount: 0,
    warnCount: 1,
    contentHash: 'a'.repeat(64),
    createdAt: new Date('2026-11-17T01:02:03.456Z'),
    statsJson: '{"h2Count":2,"pCount":3,"charCount":900}',
    issuesJson: '[{"level":"warn","code":"para_short","message":"段落偏短","hits":1}]',
    ruleJson: '{"checks":["para_shape"],"relax":[]}',
    ...extra,
  };
}

/** 模拟 Prisma P2021（表不存在）——与真实运行时抛出的错误同类型、同 code。 */
function tableMissingError(): Error {
  return new Prisma.PrismaClientKnownRequestError(
    'The table `wechat_pipeline.ArticleLintRun` does not exist in the current database.',
    { code: 'P2021', clientVersion: '5.22.0' },
  );
}

/** 模拟表存在但查询失败（连接池超时 / 网络中断等）。 */
function queryError(): Error {
  return new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool', {
    code: 'P2024',
    clientVersion: '5.22.0',
  });
}

// ─────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('══ lint-store 读路径降级测试（Mock，不连库）══\n');

  // ── 1. latestLintRun：正常查询 ──────────────────────────────
  console.log('[1] latestLintRun() 正常查询');
  {
    let seenArgs: unknown = null;
    stubDelegate({
      findFirst: async (args: unknown) => {
        seenArgs = args;
        return row(7, { ok: false, errorCount: 2, warnCount: 1 });
      },
    });
    spyWarn();
    const r = await latestLintRun(7);
    ok(r !== null, '返回记录（非 null）');
    eq(r?.id, 7, 'id 原样返回');
    eq(r?.trigger, 'save', 'trigger 原样返回');
    eq(r?.ok, false, 'ok 反映失败结论（不因查询路径而变成 true）');
    eq(r?.errorCount, 2, 'errorCount 原样返回');
    eq(r?.warnCount, 1, 'warnCount 原样返回');
    eq(r?.createdAt, '2026-11-17T01:02:03.456Z', 'createdAt 转 ISO 字符串');
    eq(r?.stats, { h2Count: 2, pCount: 3, charCount: 900 }, 'statsJson 反序列化');
    eq(r?.issues?.[0]?.code, 'para_short', 'issuesJson 明细保留');
    eq(r?.rule, { checks: ['para_shape'], relax: [] }, 'ruleJson 快照保留');
    eq(seenArgs, { where: { articleId: 7 }, orderBy: { id: 'desc' } }, '查询条件与排序未被改动');
    eq(warns.length, 0, '成功路径不产生 warning');
    restoreWarn();
    restoreDelegate();
  }

  // ── 2. latestLintRun：表缺失（P2021） ───────────────────────
  console.log('\n[2] latestLintRun() 表缺失（P2021）');
  {
    stubDelegate({
      findFirst: async () => {
        throw tableMissingError();
      },
    });
    spyWarn();
    const r = await latestLintRun(11);
    eq(r, null, '返回 null（不当成记录、不当成通过）');
    eq(warns.length, 1, '产生 1 条 warning（不静默）');
    ok(warns[0]!.msg.includes('latestLintRun'), '日志可区分是 latestLintRun', warns[0]!.msg);
    eq(warns[0]!.obj.articleId, 11, '日志带文章 ID');
    eq(warns[0]!.obj.code, 'P2021', '日志带 Prisma 错误码');
    eq(warns[0]!.obj.tableMissing, true, '日志标明「表缺失」');
    ok(
      typeof warns[0]!.obj.err === 'string' && !String(warns[0]!.obj.err).includes('mysql://'),
      '日志不含连接串/密码',
    );
    restoreWarn();
    restoreDelegate();
  }

  // ── 3. latestLintRun：其它查询异常 ─────────────────────────
  console.log('\n[3] latestLintRun() 其它数据库异常（P2024）');
  {
    stubDelegate({
      findFirst: async () => {
        throw queryError();
      },
    });
    spyWarn();
    const r = await latestLintRun(12);
    eq(r, null, '返回 null（不拖垮主流程）');
    eq(warns.length, 1, '产生 1 条 warning');
    eq(warns[0]!.obj.tableMissing, false, '非表缺失时 tableMissing=false');
    eq(warns[0]!.obj.code, 'P2024', '保留错误码便于排查');
    restoreWarn();
    restoreDelegate();
  }

  // ── 4. latestLintRun：空结果（表存在但没有记录） ────────────
  console.log('\n[4] latestLintRun() 空结果（表存在、无记录）');
  {
    stubDelegate({ findFirst: async () => null });
    spyWarn();
    const r = await latestLintRun(13);
    eq(r, null, '无记录返回 null');
    eq(warns.length, 0, '「无记录」不算异常，不打 warning（不制造噪音）');
    restoreWarn();
    restoreDelegate();
  }

  // ── 5. listLintRuns：正常查询 ──────────────────────────────
  console.log('\n[5] listLintRuns() 正常查询');
  {
    let seenArgs: unknown = null;
    stubDelegate({
      findMany: async (args: unknown) => {
        seenArgs = args;
        return [row(3), row(2)];
      },
    });
    spyWarn();
    const r = await listLintRuns(7);
    eq(r.map((x) => x.id), [3, 2], '保持数据库返回顺序（不重排、不翻转）');
    eq(seenArgs, { where: { articleId: 7 }, orderBy: { id: 'desc' }, take: 20 }, '默认分页 20 / 排序 desc 未变');
    eq(warns.length, 0, '成功路径不产生 warning');
    restoreWarn();
    restoreDelegate();
  }

  // ── 6. listLintRuns：limit 边界（原有夹取逻辑不变） ─────────
  console.log('\n[6] listLintRuns() limit 夹取');
  {
    const takes: unknown[] = [];
    stubDelegate({
      findMany: async (args: unknown) => {
        takes.push((args as { take: unknown }).take);
        return [];
      },
    });
    await listLintRuns(7, 500);
    await listLintRuns(7, 0);
    await listLintRuns(7, -3);
    await listLintRuns(7, 30);
    eq(takes, [100, 1, 1, 30], '500→100 / 0→1 / -3→1 / 30→30');
    restoreDelegate();
  }

  // ── 7. listLintRuns：表缺失（P2021） ───────────────────────
  console.log('\n[7] listLintRuns() 表缺失（P2021）');
  {
    stubDelegate({
      findMany: async () => {
        throw tableMissingError();
      },
    });
    spyWarn();
    const r = await listLintRuns(21);
    eq(r, [], '返回空数组（不伪造历史）');
    eq(warns.length, 1, '产生 1 条 warning');
    ok(warns[0]!.msg.includes('listLintRuns'), '日志可区分是 listLintRuns', warns[0]!.msg);
    eq(warns[0]!.obj.articleId, 21, '日志带文章 ID');
    eq(warns[0]!.obj.tableMissing, true, '日志标明「表缺失」');
    restoreWarn();
    restoreDelegate();
  }

  // ── 8. listLintRuns：其它查询异常 ──────────────────────────
  console.log('\n[8] listLintRuns() 其它数据库异常');
  {
    stubDelegate({
      findMany: async () => {
        throw queryError();
      },
    });
    spyWarn();
    const r = await listLintRuns(22);
    eq(r, [], '返回空数组');
    eq(warns.length, 1, '产生 1 条 warning');
    eq(warns[0]!.obj.tableMissing, false, '非表缺失时 tableMissing=false');
    restoreWarn();
    restoreDelegate();
  }

  // ── 9. 非 Prisma 异常（如代码/运行时错误）也不外溢 ─────────
  console.log('\n[9] 非 Prisma 异常（普通 Error）也不外溢');
  {
    stubDelegate({
      findFirst: async () => {
        throw new Error('unexpected');
      },
      findMany: async () => {
        throw new Error('unexpected');
      },
    });
    spyWarn();
    const a = await latestLintRun(31);
    const b = await listLintRuns(31);
    eq(a, null, 'latestLintRun 返回 null');
    eq(b, [], 'listLintRuns 返回 []');
    eq(warns.length, 2, '两条路径各打 1 条 warning');
    eq(warns[0]!.obj.code, null, '非 Prisma 错误 code=null');
    restoreWarn();
    restoreDelegate();
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────');
  if (failed.length === 0) {
    console.log(`ALL PASS（${passed} 项）`);
  } else {
    console.log(`FAILED ${failed.length} 项 / PASS ${passed} 项`);
    for (const f of failed) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error('测试脚本异常：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
