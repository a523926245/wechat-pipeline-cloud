/**
 * 文风配置冒烟：创作总纲 / 赛道文体 / 三维变体库 的播种、读写、轮换与 prompt 注入。
 *
 * 为什么单独一个脚本：2026-11-11 新增的「文风配置 + 变体轮换」是文风与题库口径的
 * 唯一真源，注入路径一旦静默失效（参考 tracks 中文键那次事故），产出会悄悄退回旧模板。
 * 这里把四条钉死：
 *   1. 播种：global + 赛道 + 变体行齐全，幂等
 *   2. 读写：upsert/get/delete 往返，global 不可删
 *   3. 轮换：pickVariants 游标递增，篇幅档解析出字数/段数锚
 *   4. 注入：buildPrompt 带上【创作总纲】【本赛道文风】【本次变体】，且变体文本真的进 prompt
 *
 * ⚠️ 输出不要接 `| head -N`（管道截断会让 node 提前退出，清理不执行，留脏数据）。
 * ⚠️ SQLite 单写者，必须与其他 smoke 串行。
 *
 * 跑法：npm run smoke:style
 */

import { prisma } from '../src/db.ts';
import {
  VARIANT_CURSOR_KEY,
  allDefaults,
  splitVariantBlocks,
  parseSpecSections,
  defaultFor,
  deleteStylePrompt,
  ensureStylePromptsSeeded,
  getStylePrompt,
  getVariantCursors,
  listStylePrompts,
  loadGlobalPrompt,
  loadStyleForTrack,
  loadTrackRule,
  parseLengthLine,
  pickVariants,
  resetStyleSeedGate,
  ruleKey,
  upsertStylePrompt,
  variantKey,
} from '../src/services/style-prompts.ts';
import { lintArticle } from '../src/services/lint.ts';
import { buildPrompt, buildSystemPrompt } from '../src/services/writer.ts';
import { oldStyleHtml } from './fixtures/article-sample.ts';
import type { Angle, Track } from '@prisma/client';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}`, detail ?? '');
  throw new Error(`断言失败：${label}`);
}

const SMOKE_TRACK = '冒烟赛道';
const SMOKE_KEYS = [
  SMOKE_TRACK,
  ruleKey(SMOKE_TRACK),
  variantKey(SMOKE_TRACK, 'title'),
  variantKey(SMOKE_TRACK, 'structure'),
  variantKey(SMOKE_TRACK, 'length'),
];

async function cleanup(): Promise<void> {
  for (const k of SMOKE_KEYS) {
    await prisma.stylePrompt.deleteMany({ where: { key: k } });
  }
  // 顺手清掉冒烟赛道的轮换游标，别在 setting 里留脏键
  try {
    const row = await prisma.setting.findUnique({ where: { k: VARIANT_CURSOR_KEY } });
    if (row?.v) {
      const map = JSON.parse(row.v) as Record<string, number>;
      if (SMOKE_TRACK in map) {
        delete map[SMOKE_TRACK];
        await prisma.setting.update({ where: { k: VARIANT_CURSOR_KEY }, data: { v: JSON.stringify(map) } });
      }
    }
  } catch {
    /* setting 里是脏值也不影响冒烟结论 */
  }
}

function fakeAngle(): Angle {
  const now = new Date();
  return {
    id: 999999,
    trackId: 1,
    code: '冒烟-A01',
    seq: 1,
    theme: '冒烟主题',
    content: '一条带具体画面的选题角度，暗含冲突。',
    scope: 'article',
    used: false,
    usedBy: '',
    usedDate: null,
    source: 'smoke',
    createdAt: now,
    updatedAt: now,
  } as unknown as Angle;
}

function fakeTrack(name: string): Track {
  const now = new Date();
  return {
    id: 1,
    name,
    slug: 'smoke',
    quotaPerDay: 1,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  } as unknown as Track;
}

async function main(): Promise<void> {
  console.log('style-prompts smoke');

  console.log('\n[1] 播种与清单');
  await ensureStylePromptsSeeded();
  const list = await listStylePrompts();
  const keys = new Set(list.map((i) => i.key));
  expect('总纲已播种', keys.has('global'));
  expect('赛道文体已播种（育儿）', keys.has('育儿'));
  expect('变体行已播种（v:global:title）', keys.has(variantKey('global', 'title')));
  expect('变体行已播种（v:职场:length）', keys.has(variantKey('职场', 'length')));
  const before = list.length;
  await ensureStylePromptsSeeded();
  expect('重复播种不增加行数', (await listStylePrompts()).length === before);

  console.log('\n[2] 读写与默认值');
  const up = await upsertStylePrompt(SMOKE_TRACK, '赛道：冒烟。\n调性：测试用。');
  expect('upsert 返回 key', up.key === SMOKE_TRACK);
  const got = await getStylePrompt(SMOKE_TRACK);
  expect('get 往返一致', got?.prompt === '赛道：冒烟。\n调性：测试用。');
  expect('global 不可删', await deleteStylePrompt('global').then(() => false, () => true));
  const d = defaultFor(variantKey('global', 'length'));
  expect('篇幅变体有出厂默认值', !!d && d.kind === 'variant');
  const all = allDefaults();
  expect('默认值含总纲与变体', !!all.global && Object.keys(all.variants).length >= 6);

  console.log('\n[2.5] 变体分隔符（骨架卡）与写作规范分节');
  // 一条变体可以跨多行（骨架卡），多条之间用单独一行 `---`。
  const blocks = splitVariantBlocks('骨架甲\n第一节：A\n第二节：B\n---\n骨架乙\n第一节：C');
  expect('有 --- 时按块切（2 条，不是 5 条）', blocks.length === 2, blocks);
  expect('骨架卡整块保留换行', blocks[0]?.includes('\n') === true, blocks[0]);
  // 没有 --- 时退回历史口径「一行一条」——旧数据因此完全不受影响
  const legacy = splitVariantBlocks('公式甲\n公式乙\n公式丙');
  expect('无 --- 时按行切（兼容旧数据）', legacy.length === 3, legacy);
  const specs = parseSpecSections('## 段落形态\n- 甲\n## 强调标注\n- 乙');
  expect('s: 按 ## 切小节', Object.keys(specs.sections).length === 2 && specs.sections['强调标注']?.includes('乙'), specs);

  console.log('\n[3] 变体轮换与篇幅档解析');
  const parsed = parseLengthLine('1400-1650|13-15|短打型：说明');
  expect('篇幅档解析', parsed?.min === 1400 && parsed?.max === 1650 && parsed?.pMin === 13 && parsed?.pMax === 15);
  expect('非法篇幅档拒绝', parseLengthLine('乱写的') === null);
  await upsertStylePrompt(variantKey(SMOKE_TRACK, 'title'), '公式甲\n公式乙\n公式丙');
  await upsertStylePrompt(variantKey(SMOKE_TRACK, 'structure'), '骨架A\n骨架B');
  await upsertStylePrompt(variantKey(SMOKE_TRACK, 'length'), '1400-1650|13-15|短档\n1800-2200|17-19|标准档');
  const v1 = await pickVariants(SMOKE_TRACK);
  const v2 = await pickVariants(SMOKE_TRACK);
  expect('游标递增', v2.cursor === v1.cursor + 1);
  expect('标题轮换（3 条周期）', v1.title !== v2.title);
  expect('篇幅档解析出锚', v1.lengthTarget !== null && v1.lengthTarget.min > 0);
  expect('篇幅档轮换', v1.length !== v2.length);
  // 配置页要显示「下次取第几条」，读游标不能推进游标
  const cursors = await getVariantCursors();
  expect('游标可读回', cursors[SMOKE_TRACK] === v2.cursor);
  expect('读游标不推进', (await getVariantCursors())[SMOKE_TRACK] === v2.cursor);

  console.log('\n[4] prompt 注入');
  const style = await loadStyleForTrack(SMOKE_TRACK);
  expect('loadStyleForTrack 取到赛道文体', style.trackPrompt?.includes('冒烟'));
  expect('loadGlobalPrompt 取到总纲', (await loadGlobalPrompt()).includes('创作总纲'));
  const p = buildPrompt(fakeAngle(), fakeTrack(SMOKE_TRACK), { style, variants: v1 });
  expect('总纲进 prompt', p.includes('【创作总纲（硬性）】'));
  expect('赛道文风进 prompt', p.includes('【本赛道文风（硬性）】') && p.includes('调性：测试用'));
  expect('变体段进 prompt', p.includes('【本次变体（反模板化硬性要求'));
  expect('标题公式进 prompt', p.includes(v1.title));
  expect('结构骨架进 prompt', p.includes(v1.structure));
  expect('篇幅档进 prompt', p.includes('字、全文'));
  // 无配置时回落 style_dna，行为与改造前一致
  const p0 = buildPrompt(fakeAngle(), fakeTrack('不存在的赛道'));
  expect('无配置时回落兜底', !p0.includes('【本次变体') && p0.includes('赛道：不存在的赛道'));
  // system 提示词随篇幅档变锚
  const sys = buildSystemPrompt({ target: v1.lengthTarget ?? undefined });
  expect('system 篇幅锚跟随变体', sys.includes(`${v1.lengthTarget?.min}-${v1.lengthTarget?.max} 字`));

  console.log('\n[5] 机器规则：DB 覆盖 / 种子回落 / relax 豁免（S3 relax 修复验证）');
  // oldStyleHtml 稳定触发：errors=chars/sections，warns=para_shape/para_short。
  // 调用形态与修复后的 articles/publisher 一致：checks 与 relax 取自同一条 rule。
  // 5.1 DB 覆盖生效：库里 r:冒烟赛道 只豁免 para_shape（与种子不同）→ 以库为准
  await upsertStylePrompt(
    ruleKey(SMOKE_TRACK),
    JSON.stringify({ checks: [], angleMode: 'default', relax: ['para_shape'] }),
  );
  const dbRule = await loadTrackRule(SMOKE_TRACK);
  expect('5.1 loadTrackRule 读库：relax 以库为准', JSON.stringify(dbRule.relax) === JSON.stringify(['para_shape']), dbRule);
  const dbLint = lintArticle(oldStyleHtml(), undefined, SMOKE_TRACK, dbRule.checks, dbRule.relax);
  expect(
    '5.1 DB relax 生效：para_shape 被豁免',
    !dbLint.warnings.some((w) => w.code === 'para_shape'),
    dbLint.warnings,
  );
  expect(
    '5.1 豁免有边界：para_short 仍提示（库只列了 para_shape）',
    dbLint.warnings.some((w) => w.code === 'para_short'),
    dbLint.warnings,
  );
  // 5.2 种子默认生效：删掉库里的 r:育儿 → 回落出厂种子（relax: ['para_short','ending_hook']）
  // S4-5 A 档：育儿种子补了 ending_hook（sys:育儿 没要求过结尾提问），断言的语义仍是「回落种子」，
  // 期望值随种子更新——不是放宽断言。
  await deleteStylePrompt(ruleKey('育儿'));
  const seedRule = await loadTrackRule('育儿');
  expect(
    '5.2 loadTrackRule 回落种子：relax=para_short+ending_hook',
    JSON.stringify(seedRule.relax) === JSON.stringify(['para_short', 'ending_hook']),
    seedRule,
  );
  const seedLint = lintArticle(oldStyleHtml(), undefined, '育儿', seedRule.checks, seedRule.relax);
  expect(
    '5.2 种子 relax 生效：para_short 被豁免',
    !seedLint.warnings.some((w) => w.code === 'para_short'),
    seedLint.warnings,
  );
  expect(
    '5.2 种子豁免有边界：para_shape 仍提示（育儿只豁免 para_short）',
    seedLint.warnings.some((w) => w.code === 'para_shape'),
    seedLint.warnings,
  );
  // 5.3 relax 只豁免 warn：error 是推送门禁，任何豁免配置都关不掉。
  // oldStyleHtml 的 warn 全集：para_shape/para_short/ending_hook/emphasis/key_emphasis。
  const warnCodes = ['para_shape', 'para_short', 'ending_hook', 'emphasis', 'key_emphasis'];
  const hard = lintArticle(oldStyleHtml(), undefined, SMOKE_TRACK, [], [...warnCodes, 'chars', 'sections']);
  expect(
    '5.3 relax 关不掉 error：error 码放进 relax 也仍拦',
    hard.errors.some((e) => e.code === 'chars') && hard.errors.some((e) => e.code === 'sections'),
    hard.errors,
  );
  expect('5.3 relax 可免尽 warn', hard.warnings.length === 0, hard.warnings);

  // ── 6. V16 是否真的在迁移链里被调用（S4-5 S2 接线验证）──
  // 本进程启动时链已经跑过一遍（5.x 的读取触发的），但那时库里是新种子（已带豁免）→ V16 空转。
  // 要验证「链调用了 V16」，必须制造「旧值 + 标记缺失」，再用 resetStyleSeedGate() 重开闸门，
  // 让 ensureStylePromptsSeeded() 真跑一遍**完整迁移链**。全程只在隔离库内，不碰真实库。
  console.log('\n[6] V16 接入迁移链');
  const oldZodiacRule = {
    checks: ['zodiac_topic', 'zodiac_textbook', 'zodiac_repeat', 'zodiac_dup'],
    angleMode: 'zodiac',
    relax: ['para_shape', 'para_short'],
  };
  const oldParentingRule = { checks: [], angleMode: 'default', relax: ['para_short'] };
  const putRule = async (key: string, rule: unknown): Promise<void> => {
    const prompt = JSON.stringify(rule, null, 2);
    await prisma.stylePrompt.upsert({
      where: { key },
      create: { key, kind: 'rule', prompt },
      update: { prompt },
    });
  };
  const readRule = async (
    key: string,
  ): Promise<{ checks?: unknown; angleMode?: unknown; relax?: string[] } | null> => {
    const row = await prisma.stylePrompt.findUnique({ where: { key } });
    return row ? (JSON.parse(row.prompt) as { checks?: unknown; angleMode?: unknown; relax?: string[] }) : null;
  };

  await putRule('r:星座', oldZodiacRule);
  await putRule('r:育儿', oldParentingRule);
  await prisma.setting.deleteMany({ where: { k: 'style_seed_v16' } });
  const preZ = await readRule('r:星座');
  const v16FlagBefore = await prisma.setting.findUnique({ where: { k: 'style_seed_v16' } });
  expect(
    '6.1 前置：两条 r: 已还原为旧值、标记已删',
    JSON.stringify(preZ?.relax) === JSON.stringify(['para_shape', 'para_short']) && v16FlagBefore === null,
    { relax: preZ?.relax, flag: v16FlagBefore },
  );

  // ★ 这一步是本次验证的核心：只调公开入口 ensureStylePromptsSeeded()，不直接调 V16。
  resetStyleSeedGate();
  await ensureStylePromptsSeeded();
  const z6 = await readRule('r:星座');
  const y6 = await readRule('r:育儿');
  const v16Flag = await prisma.setting.findUnique({ where: { k: 'style_seed_v16' } });
  expect(
    '6.1 链上调用生效：星座/育儿 relax 均被追加 ending_hook',
    JSON.stringify(z6?.relax) === JSON.stringify(['para_shape', 'para_short', 'ending_hook']) &&
      JSON.stringify(y6?.relax) === JSON.stringify(['para_short', 'ending_hook']),
    { zodiac: z6?.relax, parenting: y6?.relax },
  );
  expect(
    '6.1 链上迁移不碰规则本体：checks / angleMode 保持原样',
    JSON.stringify(z6?.checks) === JSON.stringify(oldZodiacRule.checks) &&
      z6?.angleMode === 'zodiac' &&
      JSON.stringify(y6?.checks) === '[]' &&
      y6?.angleMode === 'default',
    { zodiac: z6, parenting: y6 },
  );
  expect('6.1 迁移标记已写入（v=16）', v16Flag?.v === '16', v16Flag);

  // 幂等：再重开闸门跑一遍完整链，不得重复追加
  resetStyleSeedGate();
  await ensureStylePromptsSeeded();
  const z6b = await readRule('r:星座');
  expect(
    '6.2 幂等：重复跑整条迁移链不重复追加',
    (z6b?.relax ?? []).filter((c) => c === 'ending_hook').length === 1,
    z6b?.relax,
  );

  await cleanup();
  expect('清理完成', (await prisma.stylePrompt.count({ where: { key: { in: SMOKE_KEYS } } })) === 0);
  console.log(`\n全部通过（${passed} 项断言）`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('\n冒烟失败：', e instanceof Error ? e.message : e);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
