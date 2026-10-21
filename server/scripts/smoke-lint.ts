/**
 * 成稿体检 + 写作提示词冒烟。
 *
 * 为什么单独一个脚本（不塞进 smoke:p2）：这两块是**文风规则的唯一执行点**，
 * 之前踩过两次坑且都是静默失效——
 *   ① style_dna.json 的 tracks 用中文键，writer.ts 按英文键取值 → 赛道调性一行都没进 prompt；
 *   ② constants.ts 的字数/节数阈值零引用 → 宣称的「五项质检」根本没跑。
 * 这里用断言把这两条钉死，以后改文风配置不会再静默失效。
 *
 * 覆盖：
 *   1. buildPrompt 真的注入了赛道调性 / 禁忌 / 段落形态规范（中文键回归测试）
 *   2. lint：旧文风（9 个小标题 + 通篇一句一段）必须报错且不通过
 *   3. lint：新文风（3-4 个小标题 + 复合长段落为主）必须通过
 *   4. lint：破折号、否定框架必须拦；段落形态与强调密度只提示不拦
 *   5. HTTP：GET /:id/lint 与 POST /:id/push 的门禁行为一致
 *
 * ⚠️ 输出不要接 `| head -N`（管道截断会让 node 提前退出，清理不执行，留脏数据）。
 * ⚠️ SQLite 单写者，必须与其他 smoke 串行。
 *
 * 跑法：npm run smoke:lint
 */

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import {
  MAX_CHARS,
  MAX_SECTIONS,
  MIN_CHARS,
  MIN_SECTIONS,
  PARA_TARGET_MAX,
  PARA_TARGET_MIN,
  TARGET_CHARS_MAX,
  TARGET_CHARS_MIN,
} from '../src/constants.ts';
import { processEmphasis } from '../src/services/emphasis.ts';
import { ensureEllipsis } from '../src/services/ellipsis.ts';
import { looksLikeArticleHtml, sanitizeModelHtml } from '../src/services/html-sanitize.ts';
import { lintArticle, lintSummary } from '../src/services/lint.ts';
import { reflowParagraphs } from '../src/services/paragraph-reflow.ts';
import { buildPrompt, SYSTEM_PROMPT } from '../src/services/writer.ts';
import { newStyleHtml, oldStyleHtml } from './fixtures/article-sample.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

// ── 1. 提示词注入（中文键回归）──
function testPrompt(): void {
  const track = { id: 1, name: '育儿', slug: 'parenting' } as never;
  const angle = { id: 1, theme: '饭桌拉锯', content: '孩子说不想吃时，家长的第一反应决定了整场对话' } as never;
  const p = buildPrompt(angle, track);

  expect('1 提示词：赛道名进来了', p.includes('赛道：育儿'), p.slice(0, 60));
  expect('1 提示词：本赛道文风块进来了', p.includes('【本赛道文风】'));
  expect('1 提示词：调性读到了（中文键回归测试）', p.includes('调性：温柔共情'), p.slice(0, 300));
  expect('1 提示词：目标读者读到了', p.includes('目标读者：'));
  expect('1 提示词：禁忌读到了', p.includes('禁忌：'));
  expect('1 提示词：结构主线规范进来了', p.includes('【结构主线规范'));
  expect('1 提示词：段落形态规范进来了', p.includes('【段落形态规范】'));
  expect('1 提示词：禁止概括句进来了', p.includes('禁止概括句'));
  expect('1 提示词：细腻度规范进来了', p.includes('【细腻度规范】'));
  expect('1 提示词：句式禁忌规范进来了', p.includes('【句式禁忌规范'));
  expect('1 提示词：替代表达进来了（只禁不给写法会失效）', p.includes('替代表达'), p.slice(0, 400));
  expect('1 提示词：选题主题与角度在末尾', p.includes('本次选题角度：') && p.indexOf('本次选题角度') > p.indexOf('【细腻度规范】'));
  // 结尾钩子写在不可截断的 tail 里：实测它在规范区被预算挤掉过一次，成稿提问就整个消失了。
  expect('1 提示词：结尾钩子指令进来了', p.includes('雨靴里的那颗玻璃珠'), p.slice(-400));

  // 去 AI 味（2026-10-14 新增）：朱雀检测判 100% AI 特征，三条判定理由必须逐条进 prompt。
  // 这块最容易静默失效——预算不够时排在最末的规范会被截掉，所以必须断言「真的渲染出来了」。
  expect('1 提示词：去AI味规范进来了', p.includes('【去AI味规范'), p.slice(0, 400));
  expect('1 提示词：语言去模式化进来了（对应「语言模式化」）', p.includes('一 语言去模式化'));
  expect('1 提示词：结构去规整进来了（对应「结构高度规整」）', p.includes('二 结构去规整'));
  expect('1 提示词：情感写实进来了（对应「情感色彩较弱」）', p.includes('三 情感写实'));
  expect('1 提示词：引用禁区进来了（杜撰人名实证发生过）', p.includes('引用禁区'));
  expect('1 提示词：优先级排在段落形态之前', p.indexOf('【去AI味规范') < p.indexOf('【段落形态规范】'));

  const unknown = buildPrompt(angle, { id: 2, name: '不存在的赛道', slug: 'nope' } as never);
  expect('1 提示词：未知赛道不注入文风块但流程不崩', !unknown.includes('【本赛道文风】') && unknown.includes('本次选题角度'));

  expect(`1 提示词：小标题区间取自 constants（${MIN_SECTIONS}-${MAX_SECTIONS}）`, MIN_SECTIONS === 3 && MAX_SECTIONS === 4);

  // ── 段落数锚与提示词自洽（2026-10-15）────────────────────────────
  // 背景：字数上不去的真因不是模型不听话，而是提示词里三处账互相打架
  //   （「每节 6-7 段」vs「至少一节只有 2 段」无解；主提示词要 1800-2200，
  //     修补提示词却要 1300-2300；「另加结尾 1-2 段」被读成「末节只写 1-2 段」）。
  // 这类矛盾**不会报错**，只会让产出静默变短，所以必须用断言钉住。
  const sys = SYSTEM_PROMPT;
  expect(
    `1 提示词：段落锚取自 constants（${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 段）`,
    sys.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`) &&
      p.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`),
    { inSystem: sys.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`), inTail: p.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`) },
  );
  expect(
    `1 提示词：目标字数取自 constants（${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX}）`,
    sys.includes(`${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字`) && p.includes(`${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字`),
  );
  // 旧配额必须被清干净：留着任意一条，模型就会在两条无解的要求里取下限。
  // ⚠️ 但要先剥掉「已作废 / 旧版」这类**变更说明**再断言：那些是给人看的历史记录
  // （例如「旧版写的『结尾 1-2 段』被读成末节只写 1-2 段」），不是给模型的指令。
  // 不做这一步，断言会把说明文字当成违规，逼着以后不敢在注释里写清踩过的坑。
  const stripNotes = (s: string): string =>
    s.replace(/[^。；\n]*(已作废|旧版|旧写法|改自旧版|此前)[^。；\n]*[。；]?/g, '');
  const sysLive = stripNotes(sys);
  const pLive = stripNotes(p);
  expect('1 提示词：旧「每节 6-7 段」配额已清除', !sysLive.includes('每节 6-7'));
  expect(
    '1 提示词：旧「结尾 1-2 段」歧义措辞已清除',
    !sysLive.includes('结尾 1-2 段') && !pLive.includes('结尾 1-2 段'),
  );
  expect('1 提示词：tail 不再把门禁 1300-2300 当目标', !p.includes(`正文 ${MIN_CHARS}-${MAX_CHARS} 字`));
  // style_dna 侧的对应矛盾（算术上无解的那条）也必须清掉。
  expect('1 提示词：style_dna 旧「至少有一节只有 2 段」已清除', !pLive.includes('至少有一节只有 2 段'));
  expect('1 提示词：style_dna 旧「某一节只写 250 字」已清除', !pLive.includes('只写 250 字就收住'));
}

// ── 1.5 模型产出清洗：能救回来就不判废 ──
function testSanitize(): void {
  // ① 漏了全部 <p>：2026-10-13 首篇样稿的真实翻车现场，写成 "<h2>…</h2> 正文裸文本"
  const bare =
    '<h1>早晨七点半</h1>\n<h2>背带滑落的那一刻</h2>\n' +
    '天刚放晴，栅栏上的雨珠滴在我鞋面上。我蹲下来系鞋带，余光看见女儿扒着大门的铁杆不肯松手，' +
    '她没有哭，只是把脸埋在我后背上，呼吸一下比一下沉。\n' +
    '我把手从她腋下穿过去，托住她，慢慢往前挪了三步。';
  const fixed = sanitizeModelHtml(bare);
  expect('1.5 缺 <p>：补出段落标签', looksLikeArticleHtml(fixed), fixed.slice(0, 80));
  expect('1.5 缺 <p>：正文一个字没丢', fixed.includes('雨珠滴在我鞋面上') && fixed.includes('慢慢往前挪了三步'), fixed);
  expect('1.5 缺 <p>：每个裸文本各成一段', (fixed.match(/<p>/g) ?? []).length === 2, fixed);
  expect('1.5 缺 <p>：补齐后体检不再误报字数为 0', lintArticle(fixed).stats.charCount > 60, lintArticle(fixed).stats);

  // ② 部分有 <p>、部分是裸文本：混合情况不能漏掉裸的那段
  const mixed = '<h1>标题</h1>\n<p>第一段有标签。</p>\n第二段忘了标签，写了很多字，也要被救回来，不能丢。';
  const mixedFixed = sanitizeModelHtml(mixed);
  expect('1.5 混合：裸段落被补上', mixedFixed.includes('第二段忘了标签'), mixedFixed);
  expect('1.5 混合：原有段落没被重复包裹', (mixedFixed.match(/<p>第一段/g) ?? []).length === 1, mixedFixed);

  // ③ markdown 围栏照旧剥离
  const fenced = '```html\n' + newStyleHtml() + '\n```';
  const fencedFixed = sanitizeModelHtml(fenced);
  expect('1.5 围栏：剥离且不破坏结构', !fencedFixed.includes('```') && looksLikeArticleHtml(fencedFixed));

  // ④ 正常输入不能被改坏：新文风样本洗一遍仍然体检通过
  const cleanRsanitize = sanitizeModelHtml(newStyleHtml());
  expect('1.5 幂等：正常文章洗一遍仍通过体检', lintArticle(cleanRsanitize).ok === true, lintArticle(cleanRsanitize).errors);

  // ⑤ 真的没有标题时不介入（那是没写出文章，该判废的还得判废）
  const junk = '抱歉，我无法完成这个请求。';
  expect('1.5 无标题：不伪造结构', looksLikeArticleHtml(sanitizeModelHtml(junk)) === false, sanitizeModelHtml(junk));
}

// ── 2. lint：旧文风必须拦 ──
function testOldStyle(): void {
  const r = lintArticle(oldStyleHtml());
  const codes = r.errors.map((e) => e.code);
  const warns = r.warnings.map((w) => w.code);
  expect('2 旧文风：不通过', r.ok === false, r.errors);
  expect('2 旧文风：小标题数违规被拦', codes.includes('sections'), r.errors);
  expect('2 旧文风：字数不足被拦', codes.includes('chars'), r.errors);
  expect('2 旧文风：提示「复合长段落不足」', warns.includes('para_shape'), r.warnings);
  expect('2 旧文风：提示「一句一段过多」', warns.includes('para_short'), r.warnings);
  expect('2 旧文风：统计里长段落为 0', r.stats.longPara === 0, r.stats);
  expect('2 旧文风：摘要可读', lintSummary(r).includes('不合规'), lintSummary(r));
}

// ── 3. lint：新文风必须过 ──
function testNewStyle(): void {
  const r = lintArticle(newStyleHtml());
  expect('3 新文风：通过', r.ok === true, r.errors);
  expect('3 新文风：无 error', r.errors.length === 0, r.errors);
  expect('3 新文风：3 个小标题', r.stats.h2Count === 3, r.stats);
  expect('3 新文风：字数落在门禁区间', r.stats.charCount >= 1300 && r.stats.charCount <= 2300, r.stats.charCount);
  expect('3 新文风：长段落占比 ≥ 1/3', r.stats.longRatio >= 1 / 3, r.stats);
  expect('3 新文风：一句一段占比 ≤ 1/2', r.stats.shortRatio <= 1 / 2, r.stats);
}

// ── 4. lint：单项规则 ──
function testRules(): void {
  const dash = lintArticle(newStyleHtml().replace('第2次我在客厅门口站住了', '第2次我在客厅门口站住了——'));
  expect('4 破折号：拦', dash.errors.some((e) => e.code === 'dash'), dash.errors);

  const neg = lintArticle(newStyleHtml().replace('我蹲下去把抹布搭在椅背上，什么也没说', '我蹲下去，不是要讲道理，而是要让他先吃完'));
  expect('4 否定框架：拦', neg.errors.some((e) => e.code === 'negation'), neg.errors);
  expect(
    '4 否定框架：报告带命中片段（定向修补要用）',
    (neg.errors.find((e) => e.code === 'negation')?.hits ?? []).some((h) => h.includes('不是要讲道理')),
    neg.errors.find((e) => e.code === 'negation')?.hits,
  );
  expect(
    '4 破折号：报告带命中片段',
    (dash.errors.find((e) => e.code === 'dash')?.hits ?? []).length > 0,
    dash.errors.find((e) => e.code === 'dash')?.hits,
  );

  const summary = lintArticle(
    newStyleHtml()
      .replace('<p>第3次我在客厅门口站住了', '<p>说到底，第3次我在客厅门口站住了')
      .replace('<p>第4次我在客厅门口站住了', '<p>总之，第4次我在客厅门口站住了'),
  );
  expect('4 概括句：多处才提示（不硬拦）', summary.warnings.some((w) => w.code === 'summary_openers') && summary.ok === true, summary.warnings);

  // 换皮写法必须也拦得住：实测模型会用「不需要X，而是Y」绕开「不是X，而是Y」
  const negVariant = lintArticle(
    newStyleHtml().replace(
      '我蹲下去把抹布搭在椅背上，什么也没说',
      '手足之间的爱，不需要消除竞争，而是需要确认彼此的重要性',
    ),
  );
  expect('4 否定框架：换皮写法（不需要X而是Y）也拦', negVariant.errors.some((e) => e.code === 'negation'), negVariant.errors);

  // 巨型段落：长短混排容易被理解反，整节糊成 300 字的墙比一句一段还难读
  const wall = lintArticle(
    '<h1>标题</h1><h2>一</h2><p>' +
      Array.from({ length: 24 }, (_, i) => `这是撑长度的第${i + 1}句话。`).join('') +
      '</p>',
  );
  const overlong = wall.warnings.find((w) => w.code === 'para_overlong');
  expect('4 超长段落：存在且只是提示级', overlong !== undefined && overlong.level === 'warn', wall.warnings);
  expect('4 超长段落：不进 error 清单（不拦推送）', !wall.errors.some((e) => e.code === 'para_overlong'), wall.errors);
  expect('4 超长段落：同时被算作复合长段落', wall.stats.longPara === 1, wall.stats);
  expect('4 正常段落：不提示超长', !lintArticle(newStyleHtml()).warnings.some((w) => w.code === 'para_overlong'), lintArticle(newStyleHtml()).warnings);

  const empty = lintArticle('<h1>标题</h1>');
  expect('4 空正文：不通过且不崩', empty.ok === false && empty.errors.some((e) => e.code === 'sections'), empty.errors);

  const noKey = lintArticle(newStyleHtml());
  expect('4 红字金句：缺失只提示不拦', noKey.warnings.some((w) => w.code === 'key_emphasis') && noKey.ok === true, noKey.warnings);
}

interface JsonRes<T> {
  status: number;
  json: T;
}

async function main(): Promise<void> {
  console.log('— 提示词注入 —');
  testPrompt();
  console.log('— 模型产出清洗 —');
  testSanitize();
  console.log('— 旧文风必须被拦 —');
  testOldStyle();
  console.log('— 新文风必须放行 —');
  testNewStyle();
  console.log('— 单项规则 —');
  testRules();

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

  // ── 段落重排（2026-10-14）：长度不靠模型，改由确定性后处理 ──
  // 背景：模型对「每段 N 字」服从度极低（实测 121 ↔ 236 字/段），
  // 与其继续加 prompt 条款，不如生成后按句边界重排。这几条断言钉住三条硬约束。
  console.log('— 段落重排 —');
  const longPara = '这是一句用于测试的完整句子。'.repeat(12);
  const rf = reflowParagraphs(
    `<h1>标题</h1><h2>01 小标题</h2><p>${longPara}</p><h2>02 小标题</h2><p>短句。</p>`,
  );
  expect('7 重排：长段落被切开', rf.after > rf.before, { before: rf.before, after: rf.after });
  const rfLens = [...rf.contentHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(
    (m) => (m[1] ?? '').replace(/<[^>]+>/g, '').length,
  );
  expect('7 重排：无段落破 150 字', rfLens.every((n) => n <= 150), rfLens);
  expect('7 重排：小标题数量不变', (rf.contentHtml.match(/<h2/g) ?? []).length === 2, rf.contentHtml);
  expect(
    '7 重排：内容不跨小标题',
    rf.contentHtml.indexOf('02 小标题') > rf.contentHtml.lastIndexOf('这是一句'),
  );

  const rf2 = reflowParagraphs('<p>前面一句。<strong>整句加粗的一句话。</strong>后面还有一句。</p>');
  const openN = (rf2.contentHtml.match(/<strong/g) ?? []).length;
  const closeN = (rf2.contentHtml.match(/<\/strong>/g) ?? []).length;
  expect('7 重排：加粗不被拆破', openN === closeN && openN === 1, { openN, closeN, html: rf2.contentHtml });
  expect('7 重排：哨兵无残留', !/⟦S\d+⟧/.test(rf2.contentHtml));
  expect('7 重排：非预期输入原样返回', reflowParagraphs('<div>没有段落</div>').changed === false);
  // 中文的句号常写在引号内（「…摆正的。」）。只按「。」切会把光秃秃的 」 甩到下一节开头，
  // 成稿出现「</p><p>」他愣了一下」这种破句——这是 2026-10-15 在真机上抓到的。
  const rf3 = reflowParagraphs(
    `<p>${'我蹲下来，看着他说：「你今天自己把两只鞋都放平了。」他抬头笑了，没说话。'.repeat(3)}</p>`,
  );
  const rf3Paras = [...rf3.contentHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, ''),
  );
  expect('7 重排：收尾引号不被切到下一节开头', rf3Paras.every((s) => !/^[」』”]/.test(s)), rf3Paras);
  expect(
    '7 重排：引号成对',
    (rf3.contentHtml.match(/「/g) ?? []).length === (rf3.contentHtml.match(/」/g) ?? []).length,
  );

  // 嵌套加粗：模型复述整篇时会造出来，带着它往下走计数与插入位置全错位，必须先拍平。
  const nested = processEmphasis(
    '<p><strong>前面半句<strong class="key">原来「棒」这个字，听多了就轻了。</strong>后面接着说。</strong></p>',
  );
  expect('7 强调：嵌套加粗被拍平', !/<strong[^>]*>[^<]*<strong/.test(nested.contentHtml), nested.contentHtml);

  // ── 省略号补齐（2026-10-15）──
  // 本机 14 篇成稿实测省略号恒为 0 处——提示词里写了也没用，与加粗是同一类病：
  // 颗粒太细、不影响语义，模型不照做。这几条断言钉住后处理的三条硬约束。
  console.log('— 省略号补齐 —');
  // 第 3 段是专门的陷阱：整句落在 <strong> 里时，标签在匹配区间**外面**，
  // 只靠字符类排除尖括号挡不住（实测把模型写好的金句改成了「…先蹲下来……」）。
  const noEllipsis = [
    '<p>我站在门口，不知道该不该进去。他没抬头。</p>',
    '<p>那天晚上我其实很累，后来还是把灯关了。</p>',
    '<p><strong>我喘了口气，不知道该不该说那句话。</strong>他没抬头，继续摆弄鞋带。</p>',
    '<p>他把门关上了，声音很轻。</p>',
  ].join('\n');
  const el1 = ensureEllipsis(noEllipsis);
  expect('8 省略号：不足时补 2 处', el1.added === 2 && el1.changed === true, el1);
  expect(
    '8 省略号：补完达到 2 处',
    (el1.contentHtml.replace(/<[^>]+>/g, '').match(/…+/g) ?? []).length === 2,
    el1.contentHtml,
  );
  expect('8 省略号：不动加粗里的句子', !/<strong[^>]*>[^<]*…/.test(el1.contentHtml), el1.contentHtml);
  expect(
    '8 省略号：只改句末标点、一个字都没增删',
    el1.contentHtml.replace(/<[^>]+>/g, '').replace(/…+/g, '。') === noEllipsis.replace(/<[^>]+>/g, ''),
    el1.contentHtml,
  );
  const el2 = ensureEllipsis(el1.contentHtml);
  expect('8 省略号：够了就不再加（幂等）', el2.added === 0 && el2.changed === false, el2);
  expect('8 省略号：没有合适候选就原样返回', ensureEllipsis('<p>他来了。他走了。</p>').changed === false);

  // ── 结尾钩子（2026-10-15）──
  // 成稿结尾曾收在一句抒情比喻上、提问整个消失（style_dna 里「三件套最多执行两项」
  // 还给了模型省掉提问的正当理由）。门禁侧留一条提示，免得又静默丢掉。
  console.log('— 结尾钩子 —');
  const head = '<h1>标题</h1><h2>01 小标题</h2><p>开场的一个具体场景，写了动作和一句对话。</p>';
  const hookless = lintArticle(`${head}<p>它吃完还会抬头望一望窗户，像在看谁。</p>`);
  expect(
    '9 结尾钩子：没有提问会被提示',
    hookless.warnings.some((w) => w.code === 'ending_hook') === true,
    hookless.warnings,
  );
  const hooked = lintArticle(
    `${head}<p>雨靴里的那颗玻璃珠还在鞋柜最下层。</p>` +
      '<p>你现在家里的旧语法还剩几件没收回来的？</p>',
  );
  expect(
    '9 结尾钩子：有回扣物件的提问不提示',
    hooked.warnings.some((w) => w.code === 'ending_hook') === false,
    hooked.warnings,
  );

  const stamp = Date.now().toString(36);
  let trackId = 0;

  try {
    const track = await prisma.track.create({
      data: { name: `__smoke_lint_${stamp}__`, slug: `smoke-lint-${stamp}`, quotaPerDay: 1, enabled: true },
    });
    trackId = track.id;

    // credStatus='ok' 但没有真实密钥：门禁排在微信调用之前，所以能安全地验证「拦住了」。
    const account = await prisma.account.create({
      data: { trackId, name: `__smoke_lint_acc_${stamp}__`, appid: `wx${stamp}`, credStatus: 'ok', enabled: true },
    });

    const bad = await prisma.article.create({
      data: {
        trackId,
        accountId: account.id,
        pipeline: 'article',
        title: '冒烟-旧文风',
        digest: '',
        contentHtml: oldStyleHtml(),
        contentWechat: '<section></section>',
        pushDate: '',
        status: 'draft',
        idempotencyKey: `smoke-lint-bad-${stamp}`,
      },
    });

    console.log('— HTTP：体检接口与推送门禁 —');
    const lintRes = await call<{ id: number; lint: { ok: boolean; errors: { code: string }[] } | null }>(
      'GET',
      `/api/articles/${bad.id}/lint`,
    );
    expect('5 HTTP：GET /:id/lint 200', lintRes.status === 200, lintRes.status);
    expect('5 HTTP：旧文风体检不通过', lintRes.json.lint?.ok === false, lintRes.json.lint);
    expect(
      '5 HTTP：错误码包含 sections',
      lintRes.json.lint?.errors?.some((e) => e.code === 'sections') === true,
      lintRes.json.lint?.errors,
    );

    const push = await call<{ ok: boolean; reason?: string; lint?: { ok: boolean } | null }>(
      'POST',
      `/api/articles/${bad.id}/push`,
    );
    expect('5 HTTP：推送被门禁拦下（ok=false）', push.json.ok === false, push.json);
    expect('5 HTTP：reason=lint_failed', push.json.reason === 'lint_failed', push.json.reason);
    expect('5 HTTP：响应带上体检报告', push.json.lint?.ok === false, push.json.lint);
    expect('5 HTTP：拦下时返回 200 而非 500（失败收敛）', push.status === 200, push.status);

    const stillDraft = await prisma.article.findUnique({ where: { id: bad.id }, select: { status: true } });
    expect('5 HTTP：被拦的文章仍是 draft', stillDraft?.status === 'draft', stillDraft);

    const good = await prisma.article.create({
      data: {
        trackId,
        accountId: account.id,
        pipeline: 'article',
        title: '冒烟-新文风',
        digest: '',
        contentHtml: newStyleHtml(),
        contentWechat: '<section></section>',
        pushDate: '',
        status: 'draft',
        idempotencyKey: `smoke-lint-good-${stamp}`,
      },
    });
    const goodLint = await call<{ lint: { ok: boolean } | null }>('GET', `/api/articles/${good.id}/lint`);
    expect('6 HTTP：新文风体检通过', goodLint.json.lint?.ok === true, goodLint.json.lint);

    const comic = await prisma.article.create({
      data: {
        trackId,
        accountId: account.id,
        pipeline: 'comic',
        title: '冒烟-漫画',
        digest: '',
        contentHtml: '<h1>漫画</h1>',
        contentWechat: '<section></section>',
        pushDate: '',
        status: 'draft',
        idempotencyKey: `smoke-lint-comic-${stamp}`,
      },
    });
    const comicLint = await call<{ lint: unknown }>('GET', `/api/articles/${comic.id}/lint`);
    expect('6 HTTP：漫画产线不做文章体检（lint=null）', comicLint.json.lint === null, comicLint.json.lint);
  } finally {
    server.close();
    // 赛道删除会级联账号与其名下文章，一次清干净。
    if (trackId) await prisma.track.delete({ where: { id: trackId } }).catch(() => undefined);
    await prisma.$disconnect();
  }

  console.log(`\n通过 ${passed} 项`);
}

main().catch((e) => {
  console.error('\n冒烟失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
