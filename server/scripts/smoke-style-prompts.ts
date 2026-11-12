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
  parseLengthLine,
  pickVariants,
  upsertStylePrompt,
  variantKey,
} from '../src/services/style-prompts.ts';
import { buildPrompt, buildSystemPrompt } from '../src/services/writer.ts';
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
