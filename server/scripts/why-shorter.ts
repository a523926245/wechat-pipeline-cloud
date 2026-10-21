/**
 * 「规则到底吃掉了多少字」归因实验（一次性排障用）。
 *
 * 拿最初那篇 2119 字 / 段均 111.5 的原始稿（var/deai/orig-2119.txt，纯文本），
 * 逐段套用现行后处理链，看每一步各减多少：
 *   ① 原样（无任何规则）
 *   ② 只过 processEmphasis（加粗/红字，不改字数）
 *   ③ 再过 reflowParagraphs（现行 LADDER，均值 93）
 *   ④ 再过 ensureEllipsis（省略号，不改字数）
 *
 * 用法：node --experimental-strip-types scripts/why-shorter.ts ../var/deai/orig-2119.txt
 */
import { readFileSync } from 'node:fs';
import { reflowParagraphs } from '../src/services/paragraph-reflow.ts';
import { processEmphasis } from '../src/services/emphasis.ts';
import { ensureEllipsis } from '../src/services/ellipsis.ts';

const TAG_RE = /<[^>]+>/g;

function stat(html: string, label: string): void {
  const lens = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(TAG_RE, '').trim().length)
    .filter((n) => n > 0);
  const total = lens.reduce((a, b) => a + b, 0);
  const avg = lens.length ? total / lens.length : 0;
  const sd = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length)
    : 0;
  const over = lens.filter((l) => l > 150).length;
  console.log(
    `${label.padEnd(22)} ${String(lens.length).padStart(3)} 段  ${String(total).padStart(5)} 字  ` +
      `段均 ${avg.toFixed(1).padStart(5)}  段CV ${avg ? (sd / avg).toFixed(2) : '0.00'}  ` +
      `最长 ${String(lens.length ? Math.max(...lens) : 0).padStart(3)}  >150字 ${over} 段`,
  );
}

const file = process.argv[2];
if (!file) {
  console.error('用法: why-shorter.ts <纯文本稿>');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8').trim();
const lines = raw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

// 把纯文本还原成语义 HTML：`NN 标题` 行当 h2，其余当 p
const html = lines
  .map((l) => (/^\d{2}\s+\S/.test(l) ? `<h2>${l}</h2>` : `<p>${l}</p>`))
  .join('\n');

console.log(`\n输入：${file}`);
stat(html, '① 原样（无规则）');
const em = processEmphasis(html).contentHtml;
stat(em, '② + 强调后处理');
const rf = reflowParagraphs(em).contentHtml;
stat(rf, '③ + reflow(现行)');
const el = ensureEllipsis(rf).contentHtml;
stat(el, '④ + 省略号');
console.log();
