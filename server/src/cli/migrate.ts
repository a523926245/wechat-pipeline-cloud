/**
 * 数据迁移：本机 JSON → 数据库。
 *
 * 用法：
 *   node --experimental-strip-types src/cli/migrate.ts --dry-run
 *   node --experimental-strip-types src/cli/migrate.ts --apply
 *
 * 三条纪律：
 * 1. 绝不写回源目录（源是正在运行的本机流水线，改了会破坏它）
 * 2. 断链必须在导入副本上修好再加外键，否则关联会失败
 * 3. 幂等：可重复执行，按唯一键 upsert，不会产生重复数据
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { prisma } from '../db.ts';
import { dupScore } from '../services/dedup.ts';
import { encryptSecret, looksLikePlaceholder, maskSecret } from '../lib/crypto.ts';
import { APPID_LEN, APPID_PREFIX, SECRET_MIN_LEN } from '../constants.ts';
import { logger } from '../logger.ts';

const DEFAULT_SOURCE = 'K:/WorkBuddy WorkSpace/wechat-pipeline';

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

  logger.info({ sourceDir, apply }, '开始迁移');

  if (!existsSync(sourceDir)) {
    logger.error(`源目录不存在: ${sourceDir}`);
    process.exit(1);
  }

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

  // ── 报告 ──
  const accountCount = Object.values(cfg.tracks).reduce((n, t) => n + t.accounts.length, 0);
  console.log('');
  console.log('══════ 迁移预检 ══════');
  console.log(`源目录        ${sourceDir}`);
  console.log(`赛道          ${Object.keys(cfg.tracks).length}`);
  console.log(`账号          ${accountCount}`);
  console.log(`选题角度      ${flatAngles.length}（已用 ${flatAngles.filter((a) => a.used).length}）`);
  console.log(`历史文章      ${articles.length}`);
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
  let nSetting = 0;

  for (const [trackName, tcfg] of Object.entries(cfg.tracks)) {
    const slug = SLUG_MAP[trackName] ?? trackName;
    const track = await prisma.track.upsert({
      where: { slug },
      update: { name: trackName, quotaPerDay: cfg.posts_per_account_per_day },
      create: {
        slug,
        name: trackName,
        quotaPerDay: cfg.posts_per_account_per_day,
        enabled: true,
      },
    });
    nTrack += 1;

    for (const accName of tcfg.accounts) {
      const cred = loadCredential(accName);
      const status = credStatusOf(cred.appid, cred.secret);
      const enabled = status === 'ok';
      const secretEnc = cred.secret ? encryptSecret(cred.secret) : null;
      await prisma.account.upsert({
        where: { appid: cred.appid || `placeholder-${slug}-${accName}` },
        update: {
          name: accName,
          secretEnc,
          secretMask: maskSecret(cred.secret),
          author: cred.author,
          credStatus: status,
          enabled,
        },
        create: {
          trackId: track.id,
          name: accName,
          appid: cred.appid || `placeholder-${slug}-${accName}`,
          secretEnc,
          secretMask: maskSecret(cred.secret),
          author: cred.author,
          credStatus: status,
          enabled,
        },
      });
      nAccount += 1;
      console.log(`  账号 ${accName.padEnd(8)} 凭据=${status}${enabled ? '' : '（未启用）'}`);
    }

    // 角度
    for (const a of allAngles.find((g) => g.track === trackName)?.angles ?? []) {
      const seq = Number.parseInt(/(\d+)\s*$/.exec(a.id)?.[1] ?? '0', 10);
      const existing = await prisma.angle.findUnique({
        where: { trackId_code: { trackId: track.id, code: a.id } },
      });
      const payload = {
        theme: a.theme,
        content: a.angle,
        used: Boolean(a.used),
        usedBy: a.used_by ?? '',
        usedDate: a.used_date ?? null,
        source: a.source ?? 'import',
      };
      if (existing) {
        await prisma.angle.update({ where: { id: existing.id }, data: payload });
      } else {
        await prisma.angle.create({ data: { trackId: track.id, code: a.id, seq, ...payload } });
        nAngle += 1;
      }
    }
  }

  // 文章
  for (let i = 0; i < articles.length; i += 1) {
    const art = articles[i]!;
    const trackSlug = SLUG_MAP[art.track] ?? art.track;
    const track = await prisma.track.findUnique({ where: { slug: trackSlug } });
    if (!track) continue;

    // 「默认(.wechat_publish.env)」这类兜底串不是真实账号，accountId 留空
    const account = await prisma.account.findFirst({
      where: { name: art.account, trackId: track.id },
    });

    const angle = art.angle_ref
      ? await prisma.angle.findUnique({
          where: { trackId_code: { trackId: track.id, code: art.angle_ref } },
        })
      : null;

    const idem = `import:${art.date}:${art.account}:${i}`;
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
    const existing = await prisma.article.findUnique({ where: { idempotencyKey: idem } });
    if (existing) {
      await prisma.article.update({ where: { id: existing.id }, data: payload });
    } else {
      await prisma.article.create({
        data: {
          ...payload,
          idempotencyKey: idem,
          trackId: track.id,
          accountId: account?.id ?? null,
          angleId: angle?.id ?? null,
        },
      });
      nArticle += 1;
    }
  }

  // 系统设置
  const settings: Array<[string, string, boolean, string]> = [
    ['title_prefix', cfg.title_prefix, false, '标题前缀，推送时幂等添加'],
    ['posts_per_account_per_day', String(cfg.posts_per_account_per_day), false, '每账号每天篇数'],
    ['auto_publish', String(cfg.auto_publish), true, '群发开关。代码层硬常量为 false，此处只读'],
  ];
  for (const [k, v, readonly, desc] of settings) {
    await prisma.setting.upsert({
      where: { k },
      update: { v, readonly, desc },
      create: { k, v, readonly, desc },
    });
    nSetting += 1;
  }

  console.log('');
  console.log('══════ 迁移结果 ══════');
  console.log(`赛道 ${nTrack} · 账号 ${nAccount} · 角度 ${nAngle} · 文章 ${nArticle} · 设置 ${nSetting}`);
  console.log('');

  // ── 断言 ──
  const orphanUsed = await prisma.angle.count({
    where: { used: true, articles: { none: {} } },
  });
  console.log(`断言 孤儿已用角度 = ${orphanUsed}（迁移期允许 >0，切换前必须为 0）`);
  if (orphanUsed > 0) {
    logger.warn('存在已用但无文章关联的角度，正式切换前需核对');
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
