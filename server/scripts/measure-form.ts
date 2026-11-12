/**
 * 形态达成度量化（真机）：改完提示词后，判断「形态到底有没有写出来」。
 *
 * 为什么不能只看 lint：lint 管的是合规（节数/字数/破折号/否定框架），
 * 管不了「清单条目有没有各占一段」「同一个星座有没有被写两遍」。
 * 这些是**形态**问题，只能靠结构性指标量出来。
 *
 * 判据：
 *   多序号段 = 一个 <p> 里有 ≥2 个「1. 2.」序号（说明几条挤一段）
 *   续段     = 段落以「因为 / 为什么」开头（本该并进上一条的解释单独成段）
 *   同座多段 = 同一星座名出现在 ≥2 个段落（群像退化回小故事）
 *
 * 跑法（会真调模型，按篇计费，别随手全量跑）：
 *   npm run measure:form -- 星座:3 职场:3
 *   → 产物在 var/verify/batch/<赛道>-<序号>.html
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '../src/db.ts';
import { lintArticle } from '../src/services/lint.ts';
import { parseArticle } from '../src/services/parse/index.ts';
import { generateDraft } from '../src/services/writer.ts';

const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
const listItems = (t: string): number => (t.match(/(?:^|[。；\s])\s*\d{1,2}\s*[.、)]\s/g) ?? []).length;
const plain = (t: string): string => t.replace(/<[^>]*>/g, '').trim();

const specs = process.argv.slice(2).map((a) => {
  const [name = '', n = '1'] = a.split(':');
  return { name, n: Number(n) || 1 };
});

const dir = join(process.cwd(), 'var', 'verify', 'batch');
mkdirSync(dir, { recursive: true });

for (const spec of specs) {
  const track = await prisma.track.findFirst({ where: { name: spec.name } });
  if (!track) {
    console.log(`${spec.name}: 赛道不存在`);
    continue;
  }
  const angles = await prisma.angle.findMany({
    where: { trackId: track.id, used: false },
    take: spec.n,
    orderBy: { seq: 'asc' },
  });
  const fallback = angles[0] ?? (await prisma.angle.findFirst({ where: { trackId: track.id } }));
  if (!fallback) {
    console.log(`${spec.name}: 没有可用选题`);
    continue;
  }

  for (let i = 0; i < spec.n; i += 1) {
    const angle = angles[i] ?? fallback;
    const r = await generateDraft(angle, track, null);
    const p = parseArticle(r.contentHtml);
    const lint = lintArticle(r.contentHtml, p, spec.name);
    const ps = p.blocks.filter((b) => b.tag === 'p').map((b) => plain(b.text));
    const multi = ps.filter((t) => listItems(t) >= 2).length;
    const cont = ps.filter((t) => /^(因为|为什么)/.test(t)).length;
    const dup = SIGNS.map((s) => [s, ps.filter((t) => t.includes(s)).length] as const).filter(([, c]) => c > 1);
    const distinctSigns = SIGNS.filter((s) => ps.some((t) => t.includes(s))).length;

    writeFileSync(join(dir, `${spec.name}-${i + 1}.html`), r.contentHtml, 'utf8');
    console.log(
      [
        spec.name.padEnd(3),
        `#${i + 1}`,
        `字=${p.charCount}`.padEnd(8),
        `段=${p.pCount}`.padEnd(5),
        `h2=${p.h2Count}`,
        lint.ok ? '门禁过' : `未过[${lint.errors.map((e) => e.code).join(',')}]`,
        `多序号段=${multi}`,
        `续段=${cont}`,
        `星座数=${distinctSigns}`,
        `同座多段=${dup.length ? dup.map(([s, c]) => `${s}×${c}`).join(' ') : '0'}`,
      ].join('  '),
    );
  }
}

await prisma.$disconnect();
