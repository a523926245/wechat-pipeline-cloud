/**
 * 数据迁移：本机 JSON → 数据库。
 *
 * 用法：
 *   npm run migrate:dry                              # 只预检，不写库（默认）
 *   npm run migrate -- --apply                       # 全量
 *   npm run migrate -- --apply --since 2026-10-01    # 只同步该日期之后的文章
 *   npm run migrate -- --apply --batch 100 --fail-fast
 *   npm run migrate -- --apply --reset-checkpoint    # 丢弃断点，从头重跑
 *
 * 四条纪律：
 * 1. 绝不写回源目录（源是正在运行的本机流水线，改了会破坏它）
 * 2. 断链必须在导入副本上修好再加外键，否则关联会失败
 * 3. 幂等：可重复执行，按唯一键 upsert，不会产生重复数据
 *    —— 文章幂等键必须**内容派生**，绝不能含源数组下标（见 cli/migrate-key.ts）
 * 4. 默认 dry-run，必须显式 --apply 才写库
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { Prisma } from '@prisma/client';

import { prisma } from '../db.ts';
import { dupScore } from '../services/dedup.ts';
import { encryptSecret, looksLikePlaceholder, maskSecret } from '../lib/crypto.ts';
import { APPID_LEN, APPID_PREFIX, SECRET_MIN_LEN } from '../constants.ts';
import { logger } from '../logger.ts';
import { buildArticleIdemKeys, isLegacyIdemKey } from './migrate-key.ts';

const DEFAULT_SOURCE = process.env.MIGRATE_SOURCE_DIR ?? 'K:/WorkBuddy WorkSpace/wechat-pipeline';

/** 断点存在 Setting 表，只记「已完整写入的最后一个日期」。 */
const CHECKPOINT_KEY = 'migrate_checkpoint';

/** 赛道中文名 → 拼音 slug，避免中文出现在路径与 URL 里 */
const SLUG_MAP: Record<string, string> = {
  育儿: 'parenting',
  职场: 'career',
  星座: 'zodiac',
  科技: 'tech',
  教育: 'education',
};

interface SourceAngle {
  id: string;
  theme: string;
  angle: string;
  used?: boolean;
  used_by?: string | null;
  used_date?: string | null;
  source?: string;
  note?: string;
}

interface SourceArticle {
  date: string;
  track: string;
  account: string;
  title: string;
  digest?: string;
  angle_ref?: string;
  media_id?: string;
  blocks?: number;
  chars?: number;
  note?: string;
}

interface FixLog {
  kind: 'angle_used_backfill' | 'article_angle_backfill';
  detail: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

/** 读取 ~/.wechat_accounts/<账号>.env，返回 APPID/SECRET/AUTHOR */
function loadCredential(name: string): { appid: string; secret: string; author: string } {
  const p = join(homedir(), '.wechat_accounts', `${name}.env`);
  if (!existsSync(p)) return { appid: '', secret: '', author: '' };
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([\w]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const val = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return {
    appid: out.WECHAT_APPID ?? '',
    secret: out.WECHAT_SECRET ?? '',
    author: out.WECHAT_AUTHOR ?? '',
  };
}

function credStatusOf(appid: string, secret: string): 'ok' | 'placeholder' | 'missing' {
  if (!appid || !secret) return 'missing';
  if (looksLikePlaceholder(appid) || looksLikePlaceholder(secret)) return 'placeholder';
  if (appid.length !== APPID_LEN || !appid.startsWith(APPID_PREFIX)) return 'placeholder';
  if (secret.length < SECRET_MIN_LEN) return 'placeholder';
  return 'ok';
}

/**
 * 两个候选值取更「真」的那个：绝不把真实值回退成占位串/空串。
 *
 * 场景：用户后来在界面填了真实 AppID，再跑迁移时源里仍是占位串——
 * 若直接覆盖，凭据就废了。
 */
function pickBetter(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (looksLikePlaceholder(existing)) {
    // 库里是占位串 → 源里是真实值才升级，否则维持原样
    return looksLikePlaceholder(incoming) ? existing : incoming;
  }
  // 库里已是真实值：绝不覆盖。用户在界面改过凭据后，库才是事实来源。
  return existing;
}

async function loadCheckpoint(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { k: CHECKPOINT_KEY } });
  return row?.v ?? '';
}

async function saveCheckpoint(date: string): Promise<void> {
  await prisma.setting.upsert({
    where: { k: CHECKPOINT_KEY },
    update: { v: date },
    create: { k: CHECKPOINT_KEY, v: date, readonly: true, desc: '迁移断点：已完整写入的最后一个日期' },
  });
}

async function clearCheckpoint(): Promise<void> {
  await prisma.setting.deleteMany({ where: { k: CHECKPOINT_KEY } });
}

/**
 * 修断链。只改内存中的副本。
 *
 * 两类断链（实测确认）：
 *  - 角度被历史引用，但角度库仍 used=false（手工补录未回写）
 *  - 角度已 used=true，但历史文章缺 angle_ref（导致无法关联）
 */
function fixLinks(angles: SourceAngle[], articles: SourceArticle[]): FixLog[] {
  const fixes: FixLog[] = [];

  // 第一类：被引用的角度必须标为已用
  const byCode = new Map(angles.map((a) => [a.id, a]));
  for (const art of articles) {
    const code = art.angle_ref;
    if (!code) continue;
    const a = byCode.get(code);
    if (a && !a.used) {
      a.used = true;
      a.used_by = a.used_by || art.account;
      a.used_date = a.used_date || art.date;
      fixes.push({ kind: 'angle_used_backfill', detail: `${code} 被历史文章引用但未标记已用，已回写` });
    }
  }

  // 第二类：历史文章缺 angle_ref，用「已用日期 + 使用账号」缩小范围，
  // 有多个候选时再用标题与角度文本的语义相关度消歧（实测 10-09 同天同账号有两条，必须消歧）。
  const referenced = new Set(articles.map((a) => a.angle_ref).filter(Boolean) as string[]);
  for (const art of articles) {
    if (art.angle_ref) continue;
    const candidates = angles.filter(
      (a) => a.used && !referenced.has(a.id) && a.used_date === art.date && a.used_by === art.account,
    );
    if (candidates.length === 0) continue;

    let hit = candidates[0]!;
    if (candidates.length > 1) {
      const probe = `${art.title} ${art.digest ?? ''}`;
      let best = -1;
      for (const c of candidates) {
        const s = dupScore(probe, `${c.angle} ${c.theme}`);
        if (s > best) {
          best = s;
          hit = c;
        }
      }
      if (best <= 0) {
        logger.warn(`多条候选且无语义关联，需人工确认：《${art.title}》`);
        continue;
      }
    }
    art.angle_ref = hit.id;
    referenced.add(hit.id);
    fixes.push({
      kind: 'article_angle_backfill',
      detail: `《${art.title.slice(0, 20)}…》缺 angle_ref，回填为 ${hit.id}`,
    });
  }

  return fixes;
}

/**
 * 从源 content/articles 目录里找回正文 HTML。
 *
 * 主要靠「赛道+角度序号」前缀匹配（如 育儿019-xxx.html）。
 * 个别历史文件名不符合该规则（如最初的预制娃初稿），用显式映射补齐。
 */
const MANUAL_BODY_MAP: Record<string, string> = {
  '育儿-010': '预制娃-公众号初稿.html',
};

function loadArticleBodies(sourceDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(sourceDir, 'content', 'articles');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.html')) continue;
    const m = /^(.+?)(\d{3})-/.exec(basename(f));
    if (!m) continue;
    out.set(`${m[1]}-${m[2]}`, readFileSync(join(dir, f), 'utf8'));
  }
  for (const [code, fname] of Object.entries(MANUAL_BODY_MAP)) {
    const p = join(dir, fname);
    if (existsSync(p) && !out.has(code)) out.set(code, readFileSync(p, 'utf8'));
  }
  return out;
}

async function main(): Promise<void> {
  const sourceDir = arg('source', DEFAULT_SOURCE) ?? DEFAULT_SOURCE;
  const apply = hasFlag('apply');
  const dryRun = hasFlag('dry-run') || !apply;
  const failFast = hasFlag('fail-fast');
  const resetCheckpoint = hasFlag('reset-checkpoint');
  const sinceArg = arg('since');
  const batchSize = Number.parseInt(arg('batch', '50') ?? '50', 10);

  if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
    logger.error(`--since 必须是 YYYY-MM-DD，收到: ${sinceArg}`);
    process.exit(1);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    logger.error(`--batch 必须是 1..500 的整数，收到: ${arg('batch')}`);
    process.exit(1);
  }

  logger.info({ sourceDir, apply, since: sinceArg ?? null, batchSize }, '开始迁移');

  if (!existsSync(sourceDir)) {
    logger.error(`源目录不存在: ${sourceDir}`);
    process.exit(1);
  }

  // ── 断点 ──
  let checkpoint = '';
  if (resetCheckpoint) {
    if (dryRun) {
      console.log('[dry-run] 跳过 --reset-checkpoint（不写库）');
    } else {
      await clearCheckpoint();
      console.log('已清除迁移断点');
    }
  } else {
    checkpoint = await loadCheckpoint();
  }
  // 显式 --since 优先；否则沿用断点（下次跑自动从断点之后继续）
  const effectiveSince = sinceArg ?? checkpoint;

  // ── 读取源数据 ──
  const cfg = readJson<{
    auto_publish: boolean;
    posts_per_account_per_day: number;
    title_prefix: string;
    tracks: Record<string, { accounts: string[]; angles_file: string }>;
  }>(join(sourceDir, 'config', 'config.json'));

  const allAngles: Array<{ track: string; angles: SourceAngle[] }> = [];
  for (const [track, tcfg] of Object.entries(cfg.tracks)) {
    const p = join(sourceDir, tcfg.angles_file);
    if (!existsSync(p)) {
      logger.warn(`角度库缺失，跳过: ${p}`);
      continue;
    }
    const data = readJson<{ angles: SourceAngle[] }>(p);
    allAngles.push({ track, angles: data.angles });
  }

  const hist = readJson<{ articles: SourceArticle[] }>(
    join(sourceDir, 'data', 'history', 'articles_history.json'),
  );
  const articles = hist.articles.slice();

  const flatAngles = allAngles.flatMap((g) => g.angles);
  const fixes = fixLinks(flatAngles, articles);
  const bodies = loadArticleBodies(sourceDir);

  // ── --since 只过滤文章 ──
  // 赛道/账号/角度/设置没有日期字段，且是文章的外键依赖，必须全量 upsert。
  // 它们本身是幂等的（按 slug / (trackId,name) / (trackId,code) / k），
  // 全量跑一遍成本极低，收益是「新增赛道不用单独再跑一次」。
  const targetArticles = effectiveSince
    ? articles.filter((a) => (a.date ?? '') >= effectiveSince)
    : articles;

  // ── 报告 ──
  const accountCount = Object.values(cfg.tracks).reduce((n, t) => n + t.accounts.length, 0);
  console.log('');
  console.log('══════ 迁移预检 ══════');
  console.log(`源目录        ${sourceDir}`);
  console.log(`模式          ${dryRun ? 'dry-run（不写库）' : 'apply'}`);
  console.log(`起始日期      ${effectiveSince || '（全量）'}${checkpoint && !sinceArg ? ' ← 来自断点' : ''}`);
  console.log(`赛道          ${Object.keys(cfg.tracks).length}（无日期，全量 upsert）`);
  console.log(`账号          ${accountCount}（无日期，全量 upsert）`);
  console.log(`选题角度      ${flatAngles.length}（已用 ${flatAngles.filter((a) => a.used).length}）（无日期，全量 upsert）`);
  console.log(`历史文章      ${articles.length} → 本次处理 ${targetArticles.length}`);
  console.log(`正文可关联    ${articles.filter((a) => a.angle_ref && bodies.has(a.angle_ref)).length}`);
  console.log(`断链修复      ${fixes.length}`);
  for (const f of fixes) console.log(`  · ${f.detail}`);
  console.log('');

  if (dryRun) {
    console.log('（dry-run：未写入数据库。加 --apply 真正执行）');
    console.log('');
    return;
  }

  // ── 写库 ──
  let nTrack = 0;
  let nAccount = 0;
  let nAngle = 0;
  let nArticle = 0;
  let nArticleUpdated = 0;
  let nSetting = 0;
  const failures: Array<{ scope: string; key: string; message: string }> = [];

  /**
   * 幂等键**必须基于全量 articles 计算**，不能用 targetArticles。
   * 否则 --since 会改变重复项的消歧序号（A / A-g2），导致增量与全量算出不同的键，
   * 进而重复插入。算法本身与数组顺序无关（见 cli/migrate-key.ts）。
   */
  const allKeys = buildArticleIdemKeys(articles);
  const keyOf = new Map<SourceArticle, string>();
  articles.forEach((a, i) => keyOf.set(a, allKeys[i]!));

  // 事务外预取：把逐条 findUnique 压成常数次查询，事务内只做写入。
  // SQLite 单写者，交互式事务一旦拉长会阻塞整库，这一步是必须的。
  const [trackRows, accountRows, angleRows] = await Promise.all([
    prisma.track.findMany({ select: { id: true, slug: true } }),
    prisma.account.findMany({
      select: {
        id: true,
        trackId: true,
        name: true,
        appid: true,
        author: true,
        credStatus: true,
        enabled: true,
        secretEnc: true,
      },
    }),
    prisma.angle.findMany({ select: { id: true, trackId: true, code: true } }),
  ]);
  const trackBySlug = new Map(trackRows.map((t) => [t.slug, t]));
  const accountByName = new Map(accountRows.map((a) => [`${a.trackId}|${a.name}`, a]));
  const angleByCode = new Map(angleRows.map((a) => [`${a.trackId}|${a.code}`, a]));

  /** 失败默认跳过并汇总，--fail-fast 才中断。 */
  async function runOp(scope: string, key: string, ops: Prisma.PrismaPromise<unknown>[]): Promise<boolean> {
    try {
      await prisma.$transaction(ops);
      return true;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ scope, key, message });
      logger.error({ scope, key, err: message }, '批次写入失败');
      if (failFast) throw e;
      return false;
    }
  }

  for (const [trackName, tcfg] of Object.entries(cfg.tracks)) {
    const slug = SLUG_MAP[trackName] ?? trackName;
    let track = trackBySlug.get(slug) ?? null;
    const trackData = { name: trackName, quotaPerDay: cfg.posts_per_account_per_day };
    if (track) {
      await prisma.track.update({ where: { id: track.id }, data: trackData });
    } else {
      track = await prisma.track.create({ data: { slug, ...trackData, enabled: true } });
      trackBySlug.set(slug, track);
      nTrack += 1;
    }

    for (const accName of tcfg.accounts) {
      const cred = loadCredential(accName);
      const status = credStatusOf(cred.appid, cred.secret);
      const placeholderAppid = `placeholder-${slug}-${accName}`;
      // 先按 (trackId, name) 查：用户在界面填了真实 AppID 后，
      // 按 appid 查会找不到 → 旧代码会新建一行占位，留下孤儿。
      const existing = accountByName.get(`${track.id}|${accName}`) ?? null;

      const finalAppid = pickBetter(existing?.appid ?? '', cred.appid || placeholderAppid);
      const hasRealSecret = Boolean(cred.secret) && !looksLikePlaceholder(cred.secret);
      const secretEnc = hasRealSecret ? encryptSecret(cred.secret) : (existing?.secretEnc ?? null);
      const finalStatus = status === 'ok' ? 'ok' : (existing?.credStatus ?? status);
      const finalEnabled = status === 'ok' ? true : (existing?.enabled ?? false);
      const finalAuthor = cred.author || existing?.author || '';

      const accData = {
        name: accName,
        secretEnc,
        secretMask: maskSecret(hasRealSecret ? cred.secret : null),
        author: finalAuthor,
        credStatus: finalStatus,
        enabled: finalEnabled,
      };

      try {
        if (existing) {
          // appid 是 @unique，升级占位→真实时可能与别行冲突；冲突就保留原值
          const data = finalAppid === existing.appid ? accData : { ...accData, appid: finalAppid };
          const row = await prisma.account.update({ where: { id: existing.id }, data });
          accountByName.set(`${track.id}|${accName}`, {
            ...row,
            secretEnc: row.secretEnc ?? null,
          });
        } else {
          const row = await prisma.account.create({
            data: { ...accData, trackId: track.id, appid: finalAppid },
          });
          accountByName.set(`${track.id}|${accName}`, {
            ...row,
            secretEnc: row.secretEnc ?? null,
          });
          nAccount += 1;
        }
      } catch (e: unknown) {
        failures.push({
          scope: 'account',
          key: `${trackName}/${accName}`,
          message: e instanceof Error ? e.message : String(e),
        });
        logger.error({ err: e, accName }, '账号写入失败');
        if (failFast) throw e;
      }
      console.log(`  账号 ${accName.padEnd(8)} 凭据=${finalStatus}${finalEnabled ? '' : '（未启用）'}`);
    }

    // 角度
    const angleOps: Prisma.PrismaPromise<unknown>[] = [];
    for (const a of allAngles.find((g) => g.track === trackName)?.angles ?? []) {
      const seq = Number.parseInt(/(\d+)\s*$/.exec(a.id)?.[1] ?? '0', 10);
      const payload = {
        theme: a.theme,
        content: a.angle,
        used: Boolean(a.used),
        usedBy: a.used_by ?? '',
        usedDate: a.used_date ?? null,
        source: a.source ?? 'import',
      };
      const existing = angleByCode.get(`${track.id}|${a.id}`);
      if (existing) {
        angleOps.push(prisma.angle.update({ where: { id: existing.id }, data: payload }));
      } else {
        angleOps.push(
          prisma.angle.create({ data: { trackId: track.id, code: a.id, seq, ...payload } }),
        );
        nAngle += 1;
      }
      if (angleOps.length >= batchSize) {
        await runOp('angle', `${trackName}#${a.id}`, angleOps.splice(0, angleOps.length));
      }
    }
    if (angleOps.length > 0) await runOp('angle', trackName, angleOps);
  }

  // ── 文章：按日期分批 + 断点续传 ──
  const sorted = targetArticles
    .slice()
    .sort((x, y) => (x.date ?? '').localeCompare(y.date ?? ''));

  // 事务外一次性取回已存在的键，避免事务内查询
  const wantKeys = sorted.map((a) => keyOf.get(a)!);
  const existingRows = await prisma.article.findMany({
    where: { idempotencyKey: { in: wantKeys } },
    select: { id: true, idempotencyKey: true },
  });
  const existingByKey = new Map(existingRows.map((r) => [r.idempotencyKey, r.id]));

  let ops: Prisma.PrismaPromise<unknown>[] = [];
  let batchKeys: string[] = [];
  let curDate = '';
  let dateFailed = 0;

  async function flushBatch(): Promise<void> {
    if (ops.length === 0) return;
    const ok = await runOp('article', `${curDate}/${batchKeys.length}条`, ops);
    if (!ok) dateFailed += 1;
    ops = [];
    batchKeys = [];
  }

  for (const art of sorted) {
    const date = art.date ?? '';
    if (date !== curDate) {
      await flushBatch();
      // 只有该日期整组都成功才推进断点，失败则下次从这里重试
      if (curDate && dateFailed === 0) await saveCheckpoint(curDate);
      curDate = date;
      dateFailed = 0;
      console.log(`  ▸ ${date || '(无日期)'} 起`);
    }

    const idem = keyOf.get(art)!;
    const trackSlug = SLUG_MAP[art.track] ?? art.track;
    const track = trackBySlug.get(trackSlug);
    if (!track) {
      failures.push({ scope: 'article', key: idem, message: `赛道不存在: ${art.track}` });
      continue;
    }

    // 「默认(.wechat_publish.env)」这类兜底串不是真实账号，accountId 留空
    const account = accountByName.get(`${track.id}|${art.account}`) ?? null;
    const angle = art.angle_ref
      ? (angleByCode.get(`${track.id}|${art.angle_ref}`) ?? null)
      : null;

    const bodyHtml = (art.angle_ref && bodies.get(art.angle_ref)) || '';
    const payload = {
      title: art.title,
      digest: art.digest ?? '',
      contentHtml: bodyHtml,
      mediaId: art.media_id ?? '',
      status: 'pushed' as const,
      pushDate: art.date,
      blocks: art.blocks ?? 0,
      chars: art.chars ?? 0,
      note: [art.note, account ? '' : `原账号串「${art.account}」非真实账号，未关联`]
        .filter(Boolean)
        .join(' | '),
    };

    const existingId = existingByKey.get(idem);
    if (existingId != null) {
      ops.push(prisma.article.update({ where: { id: existingId }, data: payload }));
      nArticleUpdated += 1;
    } else {
      ops.push(
        prisma.article.create({
          data: {
            ...payload,
            idempotencyKey: idem,
            trackId: track.id,
            accountId: account?.id ?? null,
            angleId: angle?.id ?? null,
          },
        }),
      );
      nArticle += 1;
    }
    batchKeys.push(idem);

    if (ops.length >= batchSize) await flushBatch();
  }
  await flushBatch();
  if (curDate && dateFailed === 0) await saveCheckpoint(curDate);
  // 全部跑完就清掉断点，下次默认全量（除非显式 --since）
  await clearCheckpoint();

  // 系统设置
  //
  // ⚠️ 只在**缺失**时写入，绝不 update：这些是运行期可被用户在界面上修改的设置，
  //    用 update 会让「再跑一次增量迁移」把线上值覆盖回旧流水线的配置。
  //    真实踩过的坑：旧 config.json 里 title_prefix='【冒烟】'，迁移后所有新草稿标题都带【冒烟】，
  //    而漫画线的前缀是另一个 key（comic_title_prefix），于是文章【冒烟】、漫画【漫】混排。
  const settings: Array<[string, string, boolean, string]> = [
    ['title_prefix', cfg.title_prefix, false, '文章标题前缀，渲染与推送时幂等添加（文章产线）'],
    ['posts_per_account_per_day', String(cfg.posts_per_account_per_day), false, '每账号每天篇数'],
    ['auto_publish', String(cfg.auto_publish), true, '群发开关。代码层硬常量为 false，此处只读'],
  ];
  for (const [k, v, readonly, desc] of settings) {
    const exist = await prisma.setting.findUnique({ where: { k } });
    if (exist) continue;
    await prisma.setting.create({ data: { k, v, readonly, desc } });
    nSetting += 1;
  }

  console.log('');
  console.log('══════ 迁移结果 ══════');
  console.log(
    `赛道 +${nTrack} · 账号 +${nAccount} · 角度 +${nAngle} · ` +
      `文章 新增${nArticle}/更新${nArticleUpdated} · 设置 ${nSetting}`,
  );
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 批：`);
    for (const f of failures.slice(0, 20)) console.log(`  ✗ [${f.scope}] ${f.key}: ${f.message}`);
    if (failures.length > 20) console.log(`  ...（另有 ${failures.length - 20} 条）`);
  } else {
    console.log('失败 0 批');
  }
  console.log('');

  // ── 断言 ──
  const orphanUsed = await prisma.angle.count({
    where: { used: true, articles: { none: {} } },
  });
  console.log(`断言 孤儿已用角度 = ${orphanUsed}（迁移期允许 >0，切换前必须为 0）`);
  if (orphanUsed > 0) {
    logger.warn('存在已用但无文章关联的角度，正式切换前需核对');
  }

  // 旧算法残留检查：还有 import: 开头的键说明没跑 scripts/fix-article-idem.ts
  const legacyRows = await prisma.article.findMany({
    where: { idempotencyKey: { startsWith: 'import:' } },
    select: { id: true, idempotencyKey: true },
  });
  const legacyCount = legacyRows.filter((r) => isLegacyIdemKey(r.idempotencyKey)).length;
  if (legacyCount > 0) {
    logger.warn(
      `仍有 ${legacyCount} 条文章用旧幂等键（含数组下标，源一追加就会重复插入）。` +
        ' 请跑 `npm run fix:article-idem -- --apply` 一次性改键',
    );
  }

  if (failures.length > 0) {
    logger.error('存在失败批次，请修好后重跑（断点会自动续跑，或 --reset-checkpoint 从头来）');
    process.exitCode = 1;
  }
}

main()
  .catch((e: unknown) => {
    logger.error({ err: e }, '迁移失败');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
