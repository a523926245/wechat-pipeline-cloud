/**
 * 星座赛道真机验证（**隔离库**，不碰真实数据）。
 *
 * 为什么必须隔离：脚本会写库（生成草稿、占用选题、递增变体游标）。
 * 2026-11-11 已经有两次「验证脚本直接跑真实 dev.db 把用户数据删光」的事故，
 * 那条铁律是：任何写库的验证先复制 dev.db 到临时库再跑，真实库全程只读一次。
 *
 * 它验什么（2026-11-11 改造后的契约）：
 *   1. 写作规范按赛道注入（`s:星座` 的段落形态 / 强调标注 / 句式补充），
 *      旧的全局规范块（结构主线 / 细腻度 / 去AI味）**一个都不该出现**
 *   2. 结构变体是**骨架卡**（多行，含「骨架｜」与「第一节」），不是一句话口号
 *   3. 选题守门：旧的「职场沟通式」星座题被拒，新的星座形态题能过
 *   4. 真机生成 N 篇：像不像星座文章（确定性判据）+ 推送门禁过不过
 *
 * ── 断言口径（重要）────────────────────────────────────────────────
 * **确定性结果**逐篇硬断言：星象词够不够、有没有教科书腔、跨星座复不复读、门禁过不过。
 *
 * **随机量**（字数、段数、各节段数分布）只报数、不逐篇断言：
 * 同一提示词连跑多篇，字数在 1500-2400 之间跳。对随机量逐篇断言等于用一条样本
 * 否定整批（项目铁律：单批 n≈10 的均值/σ 不足以支撑结论）。
 *
 * 跑法：npm run verify:zodiac   （VERIFY_ZODIAC_N=4 可调篇数）
 */
import 'dotenv/config';

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_DB = join(process.cwd(), 'prisma', 'dev.db');
if (!existsSync(REAL_DB)) {
  console.error(`找不到真实库：${REAL_DB}`);
  process.exit(1);
}

// ── 1. 复制真实库到临时目录（真实库只被读一次） ──
const dir = mkdtempSync(join(tmpdir(), 'wb-zodiac-verify-'));
const tmpDb = join(dir, 'dev.db');
copyFileSync(REAL_DB, tmpDb);
console.log(`隔离库：${tmpDb}`);

// ── 2. 用临时库（必须在 import db.ts 之前改 DATABASE_URL） ──
process.env.DATABASE_URL = `file:${tmpDb}`;

const { prisma } = await import('../src/db.ts');
const { buildPrompt, buildSystemPrompt, generateDraft } = await import('../src/services/writer.ts');
const { lintArticle } = await import('../src/services/lint.ts');
const { topicRejectReason } = await import('../src/services/angles.ts');
const { loadStyleForTrack, pickVariants } = await import('../src/services/style-prompts.ts');
const { parseArticle } = await import('../src/services/parse/index.ts');
const { ZODIAC_MIN_DISTINCT_TERMS } = await import('../src/constants.ts');

let passed = 0;
function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** 生成篇数（默认 3 篇；调大要同时看 token 预算）。 */
const N = Number(process.env.VERIFY_ZODIAC_N ?? 3);

/** 基线：改造前两篇星座成稿的实测值（星象词各 1-2 个）。 */
const BASELINE = { terms: 2 };

/** 已被整体移除的全局规范块（出现任何一个都说明改造没生效）。 */
const RETIRED_BLOCKS = ['【结构主线规范', '【细腻度规范', '【去AI味规范', '【强调标注规范', '【段落形态规范】'];

async function main(): Promise<void> {
  const zodiac = await prisma.track.findFirst({ where: { name: '星座' } });
  if (!zodiac) throw new Error('数据库里没有「星座」赛道');

  console.log('\n[1] 提示词注入（按赛道读 s:/v:，全局块已退役）');
  const angle = {
    id: -1,
    trackId: zodiac.id,
    code: 'verify-zodiac',
    seq: 0,
    theme: '水逆第三天',
    content: '水逆第三天，他把已读不回包装成了在忙',
    scope: 'article',
    used: false,
    usedBy: '',
    usedDate: null,
    source: 'verify',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const style = await loadStyleForTrack('星座');
  const variants = await pickVariants('星座');
  const p = buildPrompt(angle as never, zodiac, { style, variants, spec: style.spec });

  expect('1 本赛道文风注入（赛道行原文进来了）', p.includes('【本赛道文风（硬性）】') && p.includes('星象语汇'));
  expect('1 写作规范·段落形态注入', p.includes('【写作规范 · 段落形态】'));
  expect('1 写作规范·强调标注注入', p.includes('【写作规范 · 强调标注】'));
  expect('1 写作规范·句式补充注入', p.includes('【写作规范 · 句式补充】'));
  expect('1 去AI味预留小节不进 prompt', !p.includes('去AI味（预留）'));
  for (const gone of RETIRED_BLOCKS) {
    expect(`1 全局块已退役（${gone.slice(1)}）`, !p.includes(gone), gone);
  }
  expect('1 结构变体是骨架卡（含「骨架｜」与「第一节」）',
    variants.structure.includes('骨架｜') && variants.structure.includes('第一节'), variants.structure.slice(0, 80));
  expect('1 骨架卡整块进了 prompt', p.includes(variants.structure), p.slice(-600));
  // 2026-11-12：星座改成群像切片后段落锚不再是 17-19（改成 10-14），
  // 所以这里不再钉死数字，改钉「标题/段数锚确实跟随本次抽中的篇幅档」。
  {
    const lt = variants.lengthTarget;
    expect(
      '1 篇幅锚跟随星座篇幅档',
      lt === null ||
        (p.includes(`${lt.pMin}-${lt.pMax} 个 <p>`) && p.includes(`${lt.min}-${lt.max} 字`)),
      lt,
    );
  }
  expect('1 结尾示范是星座的（不是雨靴玻璃珠）', !p.includes('雨靴里的那颗玻璃珠'));
  expect(
    '1 system 用的是星座自己的提示词（不是通用模板）',
    buildSystemPrompt({ target: variants.lengthTarget ?? undefined, template: style.system.system }).includes('群像切片'),
    style.system.sourceKey,
  );
  expect('1 本赛道体检项来自 r:星座', style.rule.checks.includes('zodiac_topic') && style.rule.angleMode === 'zodiac', style.rule);

  console.log('\n[2] 选题守门（旧的职场沟通式题目必须被拒）');
  const oldBad = [
    '水逆期间因回复慢被老板误判为态度消极，委屈却无法直说，此刻该如何高情商澄清？',
    '摩羯座的完美主义让团队进度停滞，想追求细节又怕被同事抱怨推诿，如何平衡？',
    '双鱼座面对重要考试只想逃避到梦里，想制定复习计划却总拖延，怎么破？',
  ];
  for (const c of oldBad) {
    expect(`2 旧式咨询题被拒：${c.slice(0, 16)}…`, topicRejectReason({ theme: 'x', content: c }, '星座') !== null);
  }
  const newGood = [
    '水逆第三天，他把已读不回包装成了在忙',
    '都说天蝎记仇，其实它只是记性太好',
    '火象的人吵架时最先把话说完了，也最先后悔',
  ];
  for (const c of newGood) {
    expect(`2 新式星座题通过：${c.slice(0, 16)}…`, topicRejectReason({ theme: 'x', content: c }, '星座') === null);
  }
  expect('2 其它赛道不受影响（仍要方法钩子）',
    topicRejectReason({ theme: '磨蹭', content: '早上出门前他磨蹭了十分钟，家长该怎么开口？' }, '育儿') === null);

  console.log(`\n[3] 真机生成 ${N} 篇星座稿`);
  const outDir = join(process.cwd(), '..', 'var', 'verify');
  mkdirSync(outDir, { recursive: true });

  const results: Array<{ title: string; chars: number; pCount: number; h2: number; terms: number; warnCodes: string[]; ok: boolean }> = [];
  for (let i = 0; i < N; i += 1) {
    const draft = await generateDraft(angle as never, zodiac, null);
    console.log(`\n  ── 第 ${i + 1} 篇 ──`);
    console.log(`  模型：${draft.modelUsed ?? '（未调用）'}`);
    if (!draft.modelUsed) {
      console.log(`  note：${draft.note}`);
      expect(`3 第 ${i + 1} 篇真的调了模型`, false, draft.note);
    }
    const parsed = parseArticle(draft.contentHtml);
    const lint = lintArticle(draft.contentHtml, parsed, '星座', style.rule.checks);
    const terms = [
      '星座', '星盘', '命盘', '上升', '太阳', '月亮', '金星', '火星', '水星', '土星', '守护星', '宫位', '相位',
      '逆行', '水逆', '落陷', '火象', '风象', '水象', '土象', '白羊', '金牛', '双子', '巨蟹', '狮子', '处女',
      '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼',
    ].filter((t) => parsed.blocks.some((b) => b.text.includes(t)));
    const warnCodes = [...new Set(lint.warnings.map((w) => w.code))];

    console.log(`  标题：${parsed.title ?? '（无）'}`);
    console.log(`  字数：${parsed.charCount}  段落：${parsed.pCount}  小标题：${parsed.h2Count}`);
    console.log(`  星象/星座词：${terms.length} 个（需 ≥${ZODIAC_MIN_DISTINCT_TERMS}）：${terms.slice(0, 10).join('、')}`);
    console.log(`  体检：ok=${lint.ok}  提示项=${warnCodes.join(',') || '（无）'}`);

    // 先存成 HTML 再断言：断言失败时也要留下现场供排查。
    const outFile = join(outDir, `zodiac-${i + 1}.html`);
    writeFileSync(outFile, draft.contentHtml, 'utf8');
    console.log(`  已存：${outFile}`);

    // ── 硬断言：确定性结果 ──
    expect(`3.${i + 1} 像是星座文章（星象词 ≥${ZODIAC_MIN_DISTINCT_TERMS}）`, terms.length >= ZODIAC_MIN_DISTINCT_TERMS, terms);
    expect(`3.${i + 1} 没有教科书腔`, !warnCodes.includes('zodiac_textbook'), lint.warnings);
    expect(`3.${i + 1} 跨星座没复读`, !warnCodes.includes('zodiac_repeat'), lint.warnings);
    expect(`3.${i + 1} 推送门禁通过（无 error）`, lint.ok, lint.errors);

    results.push({
      title: parsed.title ?? '', chars: parsed.charCount, pCount: parsed.pCount,
      h2: parsed.h2Count, terms: terms.length, warnCodes, ok: lint.ok,
    });
  }

  console.log('\n[4] 汇总（随机量只报数，不逐篇断言）');
  console.log(`  篇数：${results.length}`);
  console.log(`  字数：中位数 ${median(results.map((r) => r.chars))}｜逐篇 ${results.map((r) => r.chars).join(', ')}`);
  console.log(`  段数：中位数 ${median(results.map((r) => r.pCount))}｜逐篇 ${results.map((r) => r.pCount).join(', ')}`);
  console.log(`  小标题：${results.map((r) => r.h2).join(', ')}`);
  console.log(`  星象词：中位数 ${median(results.map((r) => r.terms))}（基线 ${BASELINE.terms}）｜逐篇 ${results.map((r) => r.terms).join(', ')}`);
  console.log(`  门禁：${results.map((r) => (r.ok ? '通过' : '不通过')).join(', ')}`);

  expect('4 星象词中位数达标（≥4，基线 2）', median(results.map((r) => r.terms)) >= ZODIAC_MIN_DISTINCT_TERMS);

  await prisma.$disconnect();
  console.log(`\n全部通过（${passed} 项断言）`);
}

main()
  .then(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('\n验证失败：', e instanceof Error ? e.stack ?? e.message : e);
    await prisma.$disconnect().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
