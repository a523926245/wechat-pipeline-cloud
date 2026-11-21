/**
 * 一次性迁移：把「按赛道各一份」的写作配置落进 `StylePrompt` 表。
 *
 * 2026-11-11 结构调整后要做三件事：
 *   1. 补 `s:{赛道}`（写作规范）与 `r:{赛道}`（体检项 / 选题形态）——这两类 key 是新增的；
 *   2. 把所有**没被改过**的变体行升级成骨架卡（旧值是一句话，新值是一张 5-8 行的卡）；
 *   3. 已被人工改过的行**一律不动**，只报告，避免覆盖用户的定制。
 *
 * 判断「有没有被改过」用的是硬对照：把迁移前库里的原文（`scripts/legacy-variants.json`，
 * 从 2026-11-11 的备份库导出）逐字比对。相等 = 还是出厂的，可以升级；不等 = 人改过，跳过。
 *
 * 用法：
 *   npm run migrate:track-config -- --dry   只报告，不写库
 *   npm run migrate:track-config            真写库（先自行备份 dev.db）
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '../src/db.ts';
import {
  DEFAULT_TRACK_RULES,
  DEFAULT_TRACK_SPECS,
  DEFAULT_VARIANT_LINES,
  VARIANT_DIMS,
  ruleKey,
  specKey,
  variantKey,
  type VariantDim,
} from '../src/services/style-prompts.ts';

const DRY = process.argv.includes('--dry');
const LEGACY_FILE = join(process.cwd(), 'scripts', 'legacy-variants.json');

/**
 * 允许无条件升级的 key。
 *
 * 为什么需要例外：2026-11-11 当天中途还有一版迁移（`migrate-style-prompts.ts`）
 * 把星座的三条变体写成过「一句话骨架库」，那批值既不是出厂旧值、也不是人写的，
 * 逐字比对识别不出来，会一直被当成「人工改过」而跳过。
 * 这三个 key 从未被人工编辑（当天所有写入都来自脚本），所以允许覆盖。
 */
const FORCE_UPGRADE = new Set(['v:星座:title', 'v:星座:structure', 'v:星座:length']);

type Change = { key: string; action: string; note: string };
const changes: Change[] = [];

function legacyMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(LEGACY_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const legacy = legacyMap();
  const rows = await prisma.stylePrompt.findMany();
  const existing = new Map(rows.map((r) => [r.key, r.prompt]));

  const write = async (key: string, kind: string, prompt: string): Promise<void> => {
    if (!DRY) {
      await prisma.stylePrompt.upsert({
        where: { key },
        create: { key, kind, prompt },
        update: { prompt },
      });
    }
  };

  // ── 1. 写作规范 s:{赛道} ──
  for (const [track, prompt] of Object.entries(DEFAULT_TRACK_SPECS)) {
    const key = specKey(track);
    const cur = existing.get(key);
    if (cur === undefined) {
      await write(key, 'spec', prompt);
      changes.push({ key, action: '新增', note: '写作规范（段落形态/强调标注/句式补充/去AI味预留）' });
    } else if (cur === prompt) {
      changes.push({ key, action: '跳过', note: '已与出厂值一致' });
    } else {
      changes.push({ key, action: '跳过', note: '已被人工改过，保留现内容' });
    }
  }

  // ── 2. 机器规则 r:{赛道} ──
  for (const [track, rule] of Object.entries(DEFAULT_TRACK_RULES)) {
    const key = ruleKey(track);
    const prompt = JSON.stringify(rule, null, 2);
    const cur = existing.get(key);
    if (cur === undefined) {
      await write(key, 'rule', prompt);
      changes.push({ key, action: '新增', note: `体检项 ${rule.checks.join('/') || '无'} · 选题形态 ${rule.angleMode}` });
    } else if (cur === prompt) {
      changes.push({ key, action: '跳过', note: '已与出厂值一致' });
    } else {
      changes.push({ key, action: '跳过', note: '已被人工改过，保留现内容' });
    }
  }

  // ── 3. 变体：一句话 → 骨架卡（只动没被改过的）──
  for (const [track, dims] of Object.entries(DEFAULT_VARIANT_LINES)) {
    for (const dim of VARIANT_DIMS) {
      const lines = dims[dim as VariantDim];
      if (!lines || lines.length === 0) continue;
      const key = variantKey(track, dim);
      const next = lines.join('\n---\n');
      const cur = existing.get(key);
      const old = legacy[key];

      if (cur === undefined) {
        await write(key, 'variant', next);
        changes.push({ key, action: '新增', note: `${lines.length} 条` });
        continue;
      }
      if (cur === next) {
        changes.push({ key, action: '跳过', note: '已是新版' });
        continue;
      }
      if (old !== undefined && cur === old) {
        await write(key, 'variant', next);
        changes.push({ key, action: '升级', note: `${cur.split('\n').length} 行 → ${lines.length} 条骨架/公式` });
        continue;
      }
      // 单行值一定是「骨架卡之前」的形态（旧变体都是一句话/一条公式），
      // 而多行值要么是新版卡、要么是人工写的卡——后者不能动，所以只升级单行。
      if (!cur.includes('\n') || FORCE_UPGRADE.has(key)) {
        await write(key, 'variant', next);
        changes.push({
          key,
          action: '升级',
          note: FORCE_UPGRADE.has(key) ? '当天脚本写入的中间值 → 骨架卡' : `单行旧值 → ${lines.length} 条骨架/公式`,
        });
        continue;
      }
      changes.push({ key, action: '跳过', note: '内容与出厂旧值不符（疑似人工改过），保留现内容' });
    }
  }

  // ── 报告 ──
  const byAction = new Map<string, number>();
  for (const c of changes) byAction.set(c.action, (byAction.get(c.action) ?? 0) + 1);
  console.log(`\n${DRY ? '【dry-run】' : '【已写库】'} 共 ${changes.length} 项`);
  for (const [k, v] of byAction) console.log(`  ${k}: ${v}`);
  console.log('');
  for (const c of changes) console.log(`  ${c.action.padEnd(3)} ${c.key.padEnd(24)} ${c.note}`);
  console.log('');
  if (DRY) console.log('这是预览，未写入。去掉 --dry 才会真正落库（请先备份 dev.db）。');
}

main()
  .catch((e: unknown) => {
    console.error('迁移失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
