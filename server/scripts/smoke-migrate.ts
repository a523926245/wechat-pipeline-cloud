/**
 * 迁移链路端到端冒烟。
 *
 * 造假源目录 + 假 HOME（Windows 下 os.homedir() 读 USERPROFILE，
 * 因此可以隔离出一套 ~/.wechat_accounts 而不污染真实家目录），
 * 用子进程真跑 `src/cli/migrate.ts`，然后用 prisma 直接查库断言。
 *
 * 核心回归点（都是踩过/预见到的坑）：
 *   1. 文章幂等键不含源数组下标 → 在 history 头部插入一条，重跑只应 +1
 *   2. --since 只过滤文章，其余全量
 *   3. 断点续传：中途失败不推进断点
 *   4. Account 按 (trackId, name) 兜底 → 不产生孤儿占位行
 *   5. 库里已是真实 appid 时，源里的占位串绝不回退覆盖
 *   6. 默认 dry-run 不写库
 *
 * ⚠️ 输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，清理不执行。
 *
 * 跑法：npm run smoke:migrate
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { prisma } from '../src/db.ts';
import { decryptSecret } from '../src/lib/crypto.ts';

const ROOT = process.cwd();
const CLI = join(ROOT, 'src', 'cli', 'migrate.ts');
const NODE = process.execPath;

/** 18 位、wx 开头，能通过 credStatusOf 的校验 */
const APPID_A = 'wxsmokemigrate0001';
const APPID_C = 'wxsmokemigrate0002';
const SECRET_OK = 'smoke-secret-abcdefghijklmnop';

const T1 = '冒烟赛道一';
const T2 = '冒烟赛道二';
const ACC_A = '冒烟账号A';
const ACC_B = '冒烟账号B';
const ACC_C = '冒烟账号C';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

interface HistArt {
  date: string;
  track: string;
  account: string;
  title: string;
  digest?: string;
  angle_ref?: string;
  media_id?: string;
}

function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}

function runCli(args: string[], env: Record<string, string>): string {
  return execFileSync(
    NODE,
    ['--experimental-strip-types', CLI, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** 造一批历史文章：前 27 条正常，另有 2 条「同日同账号同标题」、1 条空标题、1 条在 since 之前。 */
function makeArticles(): HistArt[] {
  const out: HistArt[] = [];
  for (let i = 1; i <= 27; i += 1) {
    out.push({
      date: `2026-09-${String((i % 27) + 1).padStart(2, '0')}`,
      track: i % 2 === 0 ? T1 : T2,
      account: i % 3 === 0 ? ACC_C : i % 3 === 1 ? ACC_A : ACC_B,
      title: `冒烟文章${i}`,
      digest: `摘要${i}`,
      angle_ref: i % 2 === 0 ? `${T1}-${String(i).padStart(3, '0')}` : `${T2}-${String(i).padStart(3, '0')}`,
    });
  }
  // 同日同账号同标题两条（内容完全相同 → 必须靠 -g2 消歧，不能被覆盖掉一条）
  out.push({ date: '2026-09-28', track: T1, account: ACC_A, title: '重复标题', digest: '重复摘要' });
  out.push({ date: '2026-09-28', track: T1, account: ACC_A, title: '重复标题', digest: '重复摘要' });
  // 空标题（退化场景，哈希仍能派生，不该崩）
  out.push({ date: '2026-09-29', track: T1, account: ACC_B, title: '', digest: '' });
  // 早于 --since 的一条
  out.push({ date: '2026-08-01', track: T2, account: ACC_C, title: '很早以前', digest: '' });
  return out;
}

function writeSource(dir: string, arts: HistArt[]): void {
  const cfg = {
    auto_publish: false,
    posts_per_account_per_day: 2,
    title_prefix: '【冒烟】',
    tracks: {
      [T1]: { accounts: [ACC_A, ACC_B], angles_file: `data/angles/${T1}.json` },
      [T2]: { accounts: [ACC_C], angles_file: `data/angles/${T2}.json` },
    },
  };
  writeJson(join(dir, 'config', 'config.json'), cfg);

  for (const [t, n] of [[T1, 40], [T2, 20]] as const) {
    const angles = Array.from({ length: n }, (_, i) => ({
      id: `${t}-${String(i + 1).padStart(3, '0')}`,
      theme: `${t}主题${i + 1}`,
      angle: `${t}角度${i + 1}`,
      used: false,
      used_by: null,
      used_date: null,
      source: 'seed',
    }));
    writeJson(join(dir, 'data', 'angles', `${t}.json`), { angles });
  }

  writeJson(join(dir, 'data', 'history', 'articles_history.json'), { articles: arts });

  const artDir = join(dir, 'content', 'articles');
  mkdirSync(artDir, { recursive: true });
  for (const a of arts) {
    if (!a.angle_ref) continue;
    writeFileSync(
      join(artDir, `${a.angle_ref}-${a.title || 'untitled'}.html`),
      `<h1>${a.title}</h1><p>正文</p>`,
      'utf8',
    );
  }
}

/** 假 HOME：给 A、C 配真实凭据；B 故意不配（走占位） */
function writeHome(dir: string): void {
  const d = join(dir, '.wechat_accounts');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${ACC_A}.env`),
    `WECHAT_APPID=${APPID_A}\nWECHAT_SECRET=${SECRET_OK}\nWECHAT_AUTHOR=${ACC_A}作者\n`,
    'utf8',
  );
  writeFileSync(
    join(d, `${ACC_C}.env`),
    `WECHAT_APPID=${APPID_C}\nWECHAT_SECRET=${SECRET_OK}\nWECHAT_AUTHOR=${ACC_C}作者\n`,
    'utf8',
  );
}

async function cleanDb(): Promise<void> {
  await prisma.article.deleteMany({ where: { idempotencyKey: { startsWith: 'import2:' } } });
  await prisma.angle.deleteMany({
    where: { track: { name: { in: [T1, T2] } } },
  });
  await prisma.oAAccount.deleteMany({
    where: { OR: [{ name: ACC_A }, { name: ACC_B }, { name: ACC_C }] },
  });
  await prisma.wechatToken.deleteMany({});
  await prisma.track.deleteMany({ where: { name: { in: [T1, T2] } } });
  await prisma.setting.deleteMany({ where: { k: 'migrate_checkpoint' } });
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-migrate-'));
  const home = mkdtempSync(join(tmpdir(), 'smoke-home-'));
  const source = join(tmp, 'source');
  writeHome(home);
  const env = { USERPROFILE: home, HOME: home };

  let arts = makeArticles();
  writeSource(source, arts);

  try {
    const before = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });

    // 0. dry-run 不写库
    runCli(['--source', source, '--dry-run'], env);
    const afterDry = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    check('dry-run 不写库', before === afterDry, `${before} → ${afterDry}`);

    // 1. 首次 --apply
    runCli(['--source', source, '--apply'], env);
    const n1 = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    check('首次迁移写入全部文章', n1 - before === arts.length, `新增 ${n1 - before} / 期望 ${arts.length}`);

    // 2. 重复标题的两条都在（消歧后缀起作用，没被互相覆盖）
    const dup = await prisma.article.count({
      where: { idempotencyKey: { startsWith: 'import2:' }, title: '重复标题' },
    });
    check('同内容两条都被保留（-g2 消歧）', dup === 2, `count=${dup}`);

    // 3. 幂等：原样重跑
    runCli(['--source', source, '--apply'], env);
    const n2 = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    check('原样重跑幂等（不重复插入）', n2 === n1, `${n1} → ${n2}`);

    // 4. 核心回归：在 history **头部**插入一条，重跑只应 +1
    arts = [
      { date: '2026-08-15', track: T1, account: ACC_A, title: '头部新插入', digest: '新摘要' },
      ...arts,
    ];
    writeSource(source, arts);
    runCli(['--source', source, '--apply'], env);
    const n3 = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    check('头部插入一条后只 +1（旧键会因下标平移全表重复）', n3 === n2 + 1, `${n2} → ${n3}`);

    // 5. --since 只过滤文章：只应新增 since 之后的
    const fresh = await prisma.track.findFirst({ where: { name: T1 } });
    if (fresh) {
      await prisma.article.deleteMany({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    }
    runCli(['--source', source, '--apply', '--since', '2026-09-20'], env);
    const sinceCount = await prisma.article.count({
      where: { idempotencyKey: { startsWith: 'import2:' } },
    });
    const expectSince = arts.filter((a) => a.date >= '2026-09-20').length;
    check('--since 只同步该日期之后的文章', sinceCount === expectSince, `实际 ${sinceCount} / 期望 ${expectSince}`);

    // 6. 断点：跑完自动清理，不应残留
    const cp = await prisma.setting.findUnique({ where: { k: 'migrate_checkpoint' } });
    check('跑完自动清除断点', cp === null, cp ? `残留 v=${cp.v}` : 'null');

    // 7. --reset-checkpoint 可正常使用（不报错）
    runCli(['--source', source, '--apply', '--reset-checkpoint'], env);
    const n4 = await prisma.article.count({ where: { idempotencyKey: { startsWith: 'import2:' } } });
    check('--reset-checkpoint 后全量重跑幂等', n4 === n3, `${n3} → ${n4}`);

    // 8. Account 不产生孤儿：按 (trackId, name) 兜底
    const accCount = await prisma.oAAccount.count({
      where: { OR: [{ name: ACC_A }, { name: ACC_B }, { name: ACC_C }] },
    });
    check('账号恰好 3 个，无孤儿占位行', accCount === 3, `count=${accCount}`);

    // 9. 占位 → 真实升级：C 应拿到真实 appid
    const accC = await prisma.oAAccount.findFirst({ where: { name: ACC_C } });
    check('占位账号升级为真实 appid', accC?.appid === APPID_C && accC?.credStatus === 'ok',
      `appid=${accC?.appid} status=${accC?.credStatus}`);

    // 10. 真实值绝不回退：把 A 的 appid 改成另一个真实值，再跑迁移，源里是占位串也不该覆盖
    await prisma.oAAccount.update({
      where: { id: accC!.id },
      data: { appid: 'wxsmokemanualedit99' },
    });
    runCli(['--source', source, '--apply'], env);
    const accC2 = await prisma.oAAccount.findFirst({ where: { name: ACC_C } });
    check(
      '库内真实 appid 不被源覆盖（真实绝不回退）',
      accC2?.appid === 'wxsmokemanualedit99',
      `appid=${accC2?.appid}`,
    );

    // 11. 未配凭据的 B 走占位，且不启用
    const accB = await prisma.oAAccount.findFirst({ where: { name: ACC_B } });
    check(
      '无凭据账号落为占位且不启用',
      Boolean(accB?.appid.startsWith('placeholder-')) && accB?.enabled === false,
      `appid=${accB?.appid} enabled=${accB?.enabled}`,
    );

    // 12. 参数校验：非法 --since 应退出非 0
    let rejected = false;
    try {
      runCli(['--source', source, '--apply', '--since', '2026/09/01'], env);
    } catch {
      rejected = true;
    }
    check('非法 --since 被拒绝（exit != 0）', rejected, '');

    // 13. 明文密钥不落库：库里不是明文，且能解密回原文
    // （AES-GCM 每次 IV 随机，密文不可复现，所以不能比对密文相等）
    const accA = await prisma.oAAccount.findFirst({ where: { name: ACC_A } });
    const raw = accA?.secretEnc ? Buffer.from(accA.secretEnc) : null;
    const notPlain =
      raw != null && Buffer.compare(raw, Buffer.from(SECRET_OK, 'utf8')) !== 0;
    const decOk = raw != null && decryptSecret(raw) === SECRET_OK;
    check(
      'AppSecret 加密落库且可解密回原文（非明文）',
      notPlain && decOk,
      `bytes=${raw?.length} notPlain=${notPlain} decOk=${decOk}`,
    );
  } finally {
    await cleanDb();
    for (const d of [tmp, home]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e: unknown) => {
  console.error('冒烟脚本异常：', e);
  process.exitCode = 1;
});
