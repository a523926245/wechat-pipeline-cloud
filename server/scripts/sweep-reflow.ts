/**
 * reflow 阶梯取值的 A/B 实测脚本（一次性排障用，不进 CI）。
 *
 * 背景：阶梯是**上限**不是均值——packUnits 只在「再塞一句就超 target」时收段，
 * 所以实际段长 ≈ target − 句长（句均 23 字）。想调段均必须实测，不能照着目标值填。
 *
 * 用法：node --experimental-strip-types scripts/sweep-reflow.ts ../var/deai/ab-final.html
 */
import { readFileSync } from 'node:fs';
import { reflowParagraphs } from '../src/services/paragraph-reflow.ts';
import { processEmphasis } from '../src/services/emphasis.ts';

const TAG_RE = /<[^>]+>/g;

interface Stats {
  paras: number;
  chars: number;
  avg: number;
  cv: number;
  max: number;
  over150: number;
  over170: number;
}

function stats(html: string): Stats {
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
    m[1].replace(TAG_RE, '').trim(),
  );
  const lens = paras.map((p) => p.length);
  const chars = lens.reduce((a, b) => a + b, 0);
  const avg = lens.length ? chars / lens.length : 0;
  const varc = lens.length ? lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length : 0;
  const sd = Math.sqrt(varc);
  return {
    paras: lens.length,
    chars,
    avg: Math.round(avg * 10) / 10,
    cv: avg ? Math.round((sd / avg) * 100) / 100 : 0,
    max: lens.length ? Math.max(...lens) : 0,
    over150: lens.filter((l) => l > 150).length,
    over170: lens.filter((l) => l > 170).length,
  };
}

/**
 * 2026-10-15 实测结果（ab-final / ab-len1 / ab-len2 三篇成稿）：
 *   A 段均 68.5 / 73.8 / 75.0，段 CV 0.57 / 0.49 / 0.44   ← 现行默认
 *   B 段均 76.1 / 84.7 / 88.3，段 CV 0.49 / 0.41 / 0.36
 *   C 段均 97.8 /  104 / 107.2，段 CV 0.46 / 0.37 / 0.36   ← CV 掉破 0.40 红线
 *   D 段均 105.3 / 95.3 / 100.1，段 CV 0.44 / 0.44 / 0.46
 *
 * 结论：段均往 100+ 调没有收益——本域人工稿段均只有 30-42，
 * 段均 124.8 的那篇样本 AI 分反而最高（100/100）。留 A。
 */
const VARIANTS: Array<{ name: string; ladder: number[]; targetMax: number; hardMax: number }> = [
  { name: 'A 均值93 封顶150', ladder: [45, 135, 58, 122, 72, 145, 50, 108, 65, 128], targetMax: 145, hardMax: 150 },
  { name: 'B 均值115 封顶148', ladder: [62, 145, 78, 138, 88, 148, 70, 130, 95, 122], targetMax: 147, hardMax: 150 },
  { name: 'C 均值130 封顶165', ladder: [152, 78, 166, 140, 88, 168, 128, 95, 158, 134], targetMax: 165, hardMax: 170 },
  { name: 'D 均值128 双峰拉宽', ladder: [168, 52, 160, 92, 165, 60, 150, 80, 162, 100], targetMax: 168, hardMax: 172 },
  { name: 'E 均值66 贴近人工', ladder: [95, 30, 88, 42, 100, 35, 80, 48, 92, 55], targetMax: 100, hardMax: 105 },
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: sweep-reflow.ts <html 文件...>');
  process.exit(1);
}

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const base = processEmphasis(raw).contentHtml;
  console.log(`\n═══ ${f} ═══`);
  const b = stats(base);
  console.log(
    `  [输入] ${b.paras} 段 / ${b.chars} 字 / 段均 ${b.avg} / CV ${b.cv} / 最长 ${b.max}`,
  );
  for (const v of VARIANTS) {
    const r = reflowParagraphs(base, { ladder: v.ladder, targetMax: v.targetMax, hardMax: v.hardMax });
    const s = stats(r.contentHtml);
    console.log(
      `  ${v.name.padEnd(24)} → ${String(s.paras).padStart(2)} 段 / ${s.chars} 字 / ` +
        `段均 ${String(s.avg).padStart(5)} / CV ${s.cv} / 最长 ${String(s.max).padStart(3)} / ` +
        `>150:${s.over150} >170:${s.over170}`,
    );
  }
}
