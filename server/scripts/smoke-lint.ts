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

process.env.SMOKE_NO_AUTH = '1';

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
import { buildPrompt, buildSystemPrompt, renderTemplate, SYSTEM_PROMPT } from '../src/services/writer.ts';
import { DEFAULT_SYSTEM_PROMPTS, parseSystemTemplate } from '../src/services/style-prompts.ts';
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

  // ① 什么都不配：只有赛道名 + 选题 + 篇幅锚。
  // ⚠️ 2026-11-11 起不再从 style_dna.json 兜底任何文风块——没配就是没配，
  // 缺了要在产稿/体检里暴露，而不是悄悄塞一份别的赛道的调性。
  const bare = buildPrompt(angle, track);
  expect('1 提示词：赛道名进来了', bare.includes('赛道：育儿'), bare.slice(0, 60));
  expect('1 提示词：没配文风时不虚构文风块', !bare.includes('【本赛道文风'), bare.slice(0, 200));
  expect('1 提示词：选题主题与角度在末尾', bare.includes('本次选题主题：') && bare.includes('本次选题角度：'));
  // ①.5 系统提示词按赛道分开（2026-11-12）
  //
  // 这是「星座稿写成育儿稿」的直接防线。改造前六条赛道共用一份写死的 12 条，
  // 实测两篇不同赛道的成稿标题句式、四节骨架、结尾句型全部同构。
  // 这里钉死三件事：赛道之间 system 不同、赛道 tail 真的进 prompt、数字变量没有丢。
  const zodTpl = parseSystemTemplate(DEFAULT_SYSTEM_PROMPTS['星座'] ?? '');
  const parTpl = parseSystemTemplate(DEFAULT_SYSTEM_PROMPTS['育儿'] ?? '');
  expect('1 提示词：星座 / 育儿 的 system 不是同一份', zodTpl.system !== parTpl.system);
  expect('1 提示词：星座 system 要求群像覆盖', /12 个/.test(zodTpl.system) && /类别 \+ 数量/.test(zodTpl.system));
  expect('1 提示词：育儿 system 要求成人世界类比', parTpl.system.includes('成人世界类比'));
  const zodRendered = buildSystemPrompt({ template: zodTpl.system });
  expect(
    '1 提示词：星座 system 仍带段数锚（模板没写数字时由代码补）',
    zodRendered.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`),
  );
  expect('1 提示词：星座 system 不再要求复合长段落', !zodRendered.includes('主体是复合长段落'));

  const zodPrompt = buildPrompt(angle, { id: 2, name: '星座', slug: 'zodiac' } as never, {
    system: { system: zodTpl.system, tail: zodTpl.tail, fromDb: false, sourceKey: 'code:星座' },
  });
  expect('1 提示词：赛道 tail 进了 user 消息', zodPrompt.includes('每个星座一段'));
  expect('1 提示词：不同赛道的 tail 不一样', !bare.includes('每个星座一段'));

  // 模板漏写数字时必须补硬锚：否则「提示词可配置」会变成「门禁静默失效」
  const noAnchor = buildPrompt(angle, track, {
    system: { system: '', tail: '随便写点收尾。', fromDb: false, sourceKey: 'test' },
  });
  expect(
    '1 提示词：tail 漏写数字时程序补硬锚',
    noAnchor.includes(`${PARA_TARGET_MIN}-${PARA_TARGET_MAX} 个 <p>`) &&
      noAnchor.includes(`${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字`),
  );

  // 未定义变量原样保留，配置页写错变量名时能在 prompt 里一眼看见
  const rt = renderTemplate('段数 {{pMin}} 个，未知 {{nope}}', { pMin: 7 });
  expect('1 提示词：模板变量替换', rt.text === '段数 7 个，未知 {{nope}}', rt.text);
  expect('1 提示词：未定义变量被报出来', rt.unknown.includes('nope'));

  // ② 旧的全局规范块全部退役（改为按赛道存 `s:{赛道}`）
  for (const gone of ['【结构主线规范', '【段落形态规范】', '【细腻度规范】', '【句式禁忌规范', '【强调标注规范', '【去AI味规范']) {
    expect(`1 提示词：全局块已退役（${gone}）`, !bare.includes(gone), gone);
  }

  // ③ 配了赛道文风 + 写作规范：按 s:{赛道} 的 `##` 小节逐个注入
  const spec = {
    sections: {
      段落形态: '- 主体段落 3-5 句',
      强调标注: '- 全篇 8-12 处加粗',
      句式补充: '- 不许写星座歧视',
      '去AI味（预留）': '- 未启用，不应进 prompt',
    },
    loose: '',
    fromDb: true,
  };
  const p = buildPrompt(angle, track, { style: { trackPrompt: '调性：温柔共情' }, spec });
  expect('1 提示词：本赛道文风块进来了', p.includes('【本赛道文风（硬性）】'));
  expect('1 提示词：赛道行原文进来了', p.includes('调性：温柔共情'));
  expect('1 提示词：写作规范·段落形态进来了', p.includes('【写作规范 · 段落形态】'));
  expect('1 提示词：写作规范·强调标注进来了', p.includes('【写作规范 · 强调标注】'));
  expect('1 提示词：写作规范·句式补充进来了', p.includes('【写作规范 · 句式补充】'));
  expect('1 提示词：去AI味预留小节不进 prompt', !p.includes('未启用，不应进 prompt'));

  // ④ 多行骨架卡（--- 分隔）必须整块进 tail，不能被切成一行
  const card = '骨架｜对号入座型\n① 开场一个场景\n② 六个行为切片\n③ 写一个反例\n④ 回扣物件提问';
  const withCard = buildPrompt(angle, track, {
    variants: { title: '标题甲', structure: card, length: '1800-2200|17-19|标准', lengthTarget: null, cursor: 1 },
  });
  expect('1 提示词：骨架卡整块进 tail', withCard.includes(card), withCard.slice(-600));

  const unknown = buildPrompt(angle, { id: 2, name: '不存在的赛道', slug: 'nope' } as never);
  expect('1 提示词：未知赛道不注入文风块但流程不崩', !unknown.includes('【本赛道文风') && unknown.includes('本次选题角度'));

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

  // ⑥ 标题写成 <strong> 的救回（2026-11-11 真机抓到）
  // 模型偶尔把标题包进 <strong> 而不是 <h1>，原先直接判「内容不可用」回退骨架，
  // 白烧一次生成。这里断言它被救回来，且正文里的 <strong> 不被误改。
  const strongTitle = sanitizeModelHtml(
    '<strong>水逆第三天，已读不回不是忙</strong> <h2>火象把没回翻成我在搞事情</h2> <p>周三下午两点四十分。</p>',
  );
  expect('1.5 强标题：救回成 h1', strongTitle.includes('<h1>水逆第三天，已读不回不是忙</h1>'), strongTitle);
  expect('1.5 强标题：救回后仍是合法文章结构', looksLikeArticleHtml(strongTitle) === true, strongTitle);
  const normalStrong = sanitizeModelHtml('<h1>标题</h1><p>这里是<strong>强调</strong>，不是标题。</p>');
  expect('1.5 强标题：正文里的 strong 不被误改', normalStrong.includes('<strong>强调</strong>'), normalStrong);
}

// ── 1.6 星座赛道：赛道规范按配置注入、专属体检按 r: 启用 ──
//
// 为什么单独一个函数：星座是最早需要「不同于通用写法」的赛道，
// 也是唯一带专属体检项的赛道，这里把它的三条契约钉死：
//   ① 写作规范从 s:星座 进来，不再靠代码里的赛道名分支
//   ② 结尾示范句与赛道同源（育儿示范出现在星座稿里 = 塞了无关物件）
//   ③ 体检项由 r:星座 决定，其它赛道不该被星座规则误伤
function testZodiac(): void {
  const track = { id: 3, name: '星座', slug: 'zodiac' } as never;
  const angle = { id: 1, theme: '水逆第三天', content: '水逆第三天，他把已读不回包装成了在忙' } as never;

  // ① 没有任何配置时：不虚构星座专属规范（旧版会塞一大块 星座赛道规范）
  const bare = buildPrompt(angle, track);
  expect('1.6 未配规范时不虚构星座块', !bare.includes('【星座赛道规范'), bare.slice(0, 300));
  for (const gone of ['【结构主线规范', '【细腻度规范', '【去AI味规范']) {
    expect(`1.6 全局块已退役（${gone}）`, !bare.includes(gone), gone);
  }

  // ② 配了 s:星座：段落形态 / 强调标注 / 句式补充 三节都在
  const spec = {
    sections: {
      段落形态: '- 主体段落 3-5 句',
      强调标注: '- 全篇 8-12 处加粗',
      句式补充: '- 不做星座歧视与排序',
      '去AI味（预留）': '- 未启用',
    },
    loose: '',
    fromDb: true,
  };
  const p = buildPrompt(angle, track, { style: { trackPrompt: '内容身份：写的是星座内容\n分组纪律：不许写满 12 个' }, spec });
  expect('1.6 星座写作规范·段落形态进了 prompt', p.includes('【写作规范 · 段落形态】'), p.slice(0, 400));
  expect('1.6 星座写作规范·句式补充进了 prompt', p.includes('【写作规范 · 句式补充】'), p.slice(0, 400));
  expect('1.6 赛道行里的分组纪律进了 prompt', p.includes('不许写满 12 个'), p.slice(0, 400));
  expect('1.6 星座禁忌进了 prompt', p.includes('不做星座歧视与排序'), p.slice(0, 400));

  // ③ 示范句必须与赛道同源
  //
  // 2026-11-12：示范句从代码常量搬进了 `sys:{赛道}` 的 tail 节，可以改。
  // 这里钉的是「不传赛道模板就不许出现别的赛道的物件」——历史上星座稿结尾
  // 出现过育儿语境的雨靴玻璃珠，根因就是示范句写死在代码里、六赛道共用一份。
  const zodTpl2 = parseSystemTemplate(DEFAULT_SYSTEM_PROMPTS['星座'] ?? '');
  const pz = buildPrompt(angle, track, {
    style: { trackPrompt: '内容身份：写的是星座内容\n分组纪律：不许写满 12 个' },
    spec,
    system: { system: zodTpl2.system, tail: zodTpl2.tail, fromDb: false, sourceKey: 'code:星座' },
  });
  expect('1.6 不传赛道模板时不泄漏别的赛道物件', !p.includes('雨靴里的那颗玻璃珠'), p.slice(-500));
  expect(
    '1.6 传入星座模板后用的是星座收尾',
    pz.includes('每个星座一段') && !pz.includes('雨靴里的那颗玻璃珠'),
    pz.slice(-500),
  );


  // 星座稿的体检：星象词不足 → 提示「不像星座文章」
  const noAstro = newStyleHtml();
  const zr = lintArticle(noAstro, undefined, '星座');
  expect('1.6 星座稿缺星象词会被提示', zr.warnings.some((w) => w.code === 'zodiac_topic'), zr.warnings);
  // 同一篇稿子不传赛道名 → 不查星座专属项（其它赛道不该被星座规则误伤）
  const other = lintArticle(noAstro);
  expect('1.6 非星座赛道不查星座专属项', !other.warnings.some((w) => w.code === 'zodiac_topic'), other.warnings);

  // 教科书腔：星座稿里插学术引用 → 提示
  const textbook = newStyleHtml().replace(
    '我蹲下去把抹布搭在椅背上，什么也没说',
    '心理学里有个概念叫认知负荷，当多任务切换频繁时，个体的沟通意愿会呈非线性下降',
  );
  const tr = lintArticle(textbook, undefined, '星座');
  expect('1.6 教科书腔会被提示', tr.warnings.some((w) => w.code === 'zodiac_textbook'), tr.warnings);

  // 否定框架补了「与其X不如Y」：提示词早禁了，正则却一直没抓 —— 这里钉死
  const consult = newStyleHtml().replace(
    '我蹲下去把抹布搭在椅背上，什么也没说',
    '与其追着问，不如等他先开口',
  );
  expect(
    '1.6 否定框架：「与其X不如Y」也被拦',
    lintArticle(consult).errors.some((e) => e.code === 'negation'),
    lintArticle(consult).errors,
  );
}

// ── 2. lint：旧文风必须拦 ──
function testOldStyle(): void {
  const r = lintArticle(oldStyleHtml());  const codes = r.errors.map((e) => e.code);
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
  testZodiac();
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
  // /api/* 已加鉴权；本脚本测门禁不测鉴权，走 SMOKE_NO_AUTH 旁路（同 smoke:cover 等）。
  async function call<T>(method: string, path: string, body?: unknown): Promise<JsonRes<T>> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
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

  // ── 阶梯跨节连续（2026-11-11 修的确定性 bug）──
  // 原来阶梯每节都从第 0 项重新取，于是各节的段长节奏一模一样
  // （实测 4 节的段长序列几乎重合），各节段数齐齐整整 [6,6,6,6]——
  // 这正是 AI 检测器说的「结构高度规整」，而且是**我们自己造出来的**，不是模型写的。
  // 这里用两节内容相同的长文钉死：两节的段长序列不能一样。
  const sameSection = `<p>${'这是内容相同的一节，用来检查阶梯是不是每节都从零开始。'.repeat(6)}</p>`;
  const rfLadder = reflowParagraphs(`<h2>第一节</h2>${sameSection}<h2>第二节</h2>${sameSection}`);
  const ladderSections = rfLadder.contentHtml
    .split(/<h2>/)
    .slice(1)
    .map((sec) =>
      [...sec.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, '').length),
    );
  expect('7 重排：阶梯跨节连续（两节都有内容）', ladderSections.length === 2, ladderSections);
  expect(
    '7 重排：两节段长节奏不相同（否则是自己制造模板感）',
    JSON.stringify(ladderSections[0]) !== JSON.stringify(ladderSections[1]),
    ladderSections,
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
    const account = await prisma.oAAccount.create({
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
