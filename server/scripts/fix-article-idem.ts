/**
 * 一次性改键：把 Article.idempotencyKey 从旧算法换到新算法。
 *
 * ## 为什么需要
 *
 * 旧键 `import:${date}:${account}:${i}` 里的 `i` 是**源数组下标**。
 * 源 history 只要在中间插入一条，后面所有下标平移 → 键全变 →
 * 重跑迁移时整表重复插入。新键是内容派生的（见 src/cli/migrate-key.ts）。
 *
 * ## 为什么不直接 UPDATE 库里的字段
 *
 * 库里只有「结果」，没有算出这个结果所需的 `i`（下标丢了没法反推）。
 * 所以必须**回到源 history 重新算一遍**，得到 oldKey → newKey 的映射。
 * 这也意味着：**改键时源目录必须还在、且没被大幅改写**。
 *
 * ## 安全约定
 *
 * - 默认 dry-run，加 `--apply` 才写库
 * - 写之前先把完整映射落到 `var/tmp/idem-backup-<ts>.json` 作为回滚依据
 * - 内置断言：改前改后 `import%` 文章总数必须相等（既不能多也不能少）
 * - 新键与库中已有行冲突时**跳过并报告**，绝不覆盖
 *
 * 跑法：
 *   npm run fix:article-idem                          # 只看不改
 *   npm run fix:article-idem -- --apply
 *   npm run fix:article-idem -- --source <dir>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '../src/db.ts';
import { logger } from '../src/logger.ts';
import { buildArticleIdemKeys, isLegacyIdemKey, oldArticleIdemKey } from '../src/cli/migrate-key.ts';

const DEFAULT_SOURCE = process.env.MIGRATE_SOURCE_DIR ?? 'K:/WorkBuddy WorkSpace/wechat-pipeline';

interface SourceArticle {
  date: string;
  track: string;
  account: string;
  title: string;
  digest?: string;
  angle_ref?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const apply = process.argv.includes('--apply');
const sourceDir = arg('source', DEFAULT_SOURCE) ?? DEFAULT_SOURCE;

async function main(): Promise<void> {
  if (!existsSync(sourceDir)) {
    logger.error(`源目录不存在: ${sourceDir}`);
    process.exit(1);
  }

  const hist = JSON.parse(
    readFileSync(join(sourceDir, 'data', 'history', 'articles_history.json'), 'utf8'),
  ) as { articles: SourceArticle[] };
  const articles = hist.articles ?? [];

  // 旧键按下标算，新键按内容算（含重复内容消歧）
  const oldKeys = articles.map((a, i) => oldArticleIdemKey(a, i));
  const newKeys = buildArticleIdemKeys(articles);

  const mapping = new Map<string, string>();
  articles.forEach((_, i) => mapping.set(oldKeys[i]!, newKeys[i]!));

  const rows = await prisma.article.findMany({
    where: { idempotencyKey: { in: oldKeys } },
    select: { id: true, idempotencyKey: true },
  });

  const before = await prisma.article.count({
    where: { OR: [{ idempotencyKey: { startsWith: 'import:' } }, { idempotencyKey: { startsWith: 'import2:' } }] },
  });

  // 新键是否已被别的行占用（比如之前手工跑过一次半）
  const ownerOfNew = new Map(
    (
      await prisma.article.findMany({
        where: { idempotencyKey: { in: newKeys } },
        select: { id: true, idempotencyKey: true },
      })
    ).map((r) => [r.idempotencyKey, r.id] as const),
  );

  const updates: Array<{ id: number; from: string; to: string }> = [];
  const conflicts: Array<{ id: number; from: string; to: string }> = [];
  const rowIds = new Set(rows.map((r) => r.id));

  for (const r of rows) {
    if (!isLegacyIdemKey(r.idempotencyKey)) continue;
    const to = mapping.get(r.idempotencyKey);
    if (!to || to === r.idempotencyKey) continue;
    const owner = ownerOfNew.get(to);
    // 占用者是「本次也要改键的行」→ 良性（改完自然就冲突了），否则是真冲突
    if (owner != null && !rowIds.has(owner)) {
      conflicts.push({ id: r.id, from: r.idempotencyKey, to });
      continue;
    }
    ownerOfNew.set(to, r.id);
    updates.push({ id: r.id, from: r.idempotencyKey, to });
  }

  const missed = oldKeys.length - rows.length;

  console.log('');
  console.log('══════ 幂等键改键预检 ══════');
  console.log(`源目录          ${sourceDir}`);
  console.log(`源 history      ${articles.length} 条`);
  console.log(`库内命中旧键    ${rows.length} 条`);
  console.log(`源有库无        ${missed} 条（正常：从未迁移过的历史条目）`);
  console.log(`待改写          ${updates.length} 条`);
  console.log(`冲突跳过        ${conflicts.length} 条`);
  console.log('');
  for (const u of updates.slice(0, 10)) console.log(`  #${u.id}  ${u.from}\n      → ${u.to}`);
  if (updates.length > 10) console.log(`  ...（另有 ${updates.length - 10} 条）`);
  for (const c of conflicts.slice(0, 10)) {
    console.log(`  ✗ #${c.id}  ${c.from} → ${c.to}（新键已被占用，需人工核对）`);
  }
  console.log('');

  if (!apply) {
    console.log('[dry-run] 未写库。确认无误后加 --apply 执行。');
    console.log('');
    return;
  }
  if (updates.length === 0) {
    console.log('无需改写。');
    console.log('');
    return;
  }

  // 回滚依据：完整映射先落盘
  const backupDir = join(process.cwd(), 'var', 'tmp');
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, `idem-backup-${Date.now()}.json`);
  writeFileSync(
    backupFile,
    JSON.stringify(
      {
        sourceDir,
        at: new Date().toISOString(),
        applied: updates,
        conflicts,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`已备份映射 → ${backupFile}`);
  console.log('');

  // 数组式事务：每 100 条一批
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    await prisma.$transaction(
      batch.map((u) =>
        prisma.article.update({ where: { id: u.id }, data: { idempotencyKey: u.to } }),
      ),
    );
    console.log(`已写入 ${Math.min(i + 100, updates.length)}/${updates.length}`);
  }

  // ── 断言：总数必须守恒 ──
  const after = await prisma.article.count({
    where: { OR: [{ idempotencyKey: { startsWith: 'import:' } }, { idempotencyKey: { startsWith: 'import2:' } }] },
  });
  const stillLegacy = await prisma.article.count({
    where: { idempotencyKey: { startsWith: 'import:' } },
  });

  console.log('');
  console.log(`断言 改前总数 ${before} = 改后总数 ${after}  → ${before === after ? 'OK' : '失败'}`);
  console.log(`剩余旧键      ${stillLegacy}（应为 0；非 0 说明有行不在源 history 里）`);

  if (before !== after) {
    logger.error('总数不守恒，请用备份文件回滚并人工核对');
    process.exitCode = 1;
  }
}

void main()
  .catch((e: unknown) => {
    logger.error({ err: e }, '改键脚本异常');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
