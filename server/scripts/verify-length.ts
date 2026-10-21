/**
 * 写稿篇幅验证（真机，走完整生产链路含定向修补）。
 *
 * 用途：改完提示词 / style_dna / writer.ts 后，用真实模型跑 N 次，
 * 看落点分布是否落在目标区（1800-2200）且体检通过率可接受。
 * 这是「改文风后验稿」的量化入口，与 demo:write 的单篇肉眼验收互补。
 *
 * 不落库、不改数据（generateDraft 是纯函数）。
 *
 * 跑法：
 *   npm run verify:length             # 默认 8 次
 *   npm run verify:length -- --n=12   # 指定次数
 *   npm run verify:length -- --angle=12
 */
import 'dotenv/config';

import { prisma } from '../src/db.ts';
import { MAX_CHARS, MIN_CHARS, TARGET_CHARS_MAX, TARGET_CHARS_MIN } from '../src/constants.ts';
import { generateDraft, buildPrompt, SYSTEM_PROMPT } from '../src/services/writer.ts';
import { lintArticle } from '../src/services/lint.ts';
import { parseArticle } from '../src/services/parse/index.ts';

const argv = process.argv.slice(2);
const arg = (k: string, def = ''): string => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? def;
const N = Number(arg('n', '8')) || 8;

async function main(): Promise<void> {
  const angleId = arg('angle');
  const angle = angleId
    ? await prisma.angle.findUnique({ where: { id: Number(angleId) } })
    : await prisma.angle.findFirst({
        where: { used: false, scope: { in: ['article', 'shared'] } },
        orderBy: [{ trackId: 'asc' }, { seq: 'asc' }],
      });
  if (!angle) throw new Error('没有可用的未用选题');
  const track = await prisma.track.findUnique({ where: { id: angle.trackId } });
  if (!track) throw new Error(`选题 ${angle.id} 所属赛道不存在`);

  console.log('══ 写稿篇幅验证（真机 · 完整链路）══');
  console.log(`选题        #${angle.id} [${angle.theme}] ${angle.content}`);
  console.log(`目标        ${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX} 字（门禁 ${MIN_CHARS}-${MAX_CHARS}）`);
  console.log(`采样        ${N} 次（保存模型与参数固定，方差来自模型自身随机性）`);
  console.log(`提示词      SYSTEM ${SYSTEM_PROMPT.length} 字 · USER ${buildPrompt(angle, track).length} 字`);
  console.log('');

  interface Row {
    chars: number;
    p: number;
    h2: number;
    avg: number;
    ok: boolean;
    codes: string;
    note: string;
  }
  const rows: Row[] = [];

  for (let i = 1; i <= N; i += 1) {
    const r = await generateDraft(angle, track, null);
    const pa = parseArticle(r.contentHtml);
    const lint = lintArticle(r.contentHtml, pa);
    const row: Row = {
      chars: pa.charCount,
      p: pa.pCount,
      h2: pa.h2Count,
      avg: pa.pCount ? Number((pa.charCount / pa.pCount).toFixed(1)) : 0,
      ok: lint.ok,
      codes: lint.errors.map((e) => e.code).join(','),
      note: r.note,
    };
    rows.push(row);
    console.log(
      `${String(i).padStart(2)}. 段=${String(row.p).padStart(2)} 小标题=${row.h2} 字数=${String(row.chars).padStart(4)} ` +
        `段均=${String(row.avg).padStart(5)}  ${row.ok ? '通过' : `未过[${row.codes}]`}`,
    );
    if (!row.ok) console.log(`      ${row.note.slice(0, 150)}`);
  }

  const cs = rows.map((r) => r.chars);
  const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
  const sd = Math.sqrt(cs.reduce((a, b) => a + (b - mean) ** 2, 0) / cs.length);
  const inTarget = cs.filter((c) => c >= TARGET_CHARS_MIN && c <= TARGET_CHARS_MAX).length;
  const passGate = cs.filter((c) => c >= MIN_CHARS && c <= MAX_CHARS).length;
  const okCount = rows.filter((r) => r.ok).length;

  console.log('');
  console.log('══ 统计 ══');
  console.log(`字数        均值 ${mean.toFixed(0)} · σ ${sd.toFixed(0)} · 区间 ${Math.min(...cs)}-${Math.max(...cs)}`);
  console.log(`落在目标区  ${inTarget}/${rows.length}（${TARGET_CHARS_MIN}-${TARGET_CHARS_MAX}）`);
  console.log(`过字数门禁  ${passGate}/${rows.length}（${MIN_CHARS}-${MAX_CHARS}）`);
  console.log(`体检全通过  ${okCount}/${rows.length}`);
  const paras = rows.map((r) => r.p);
  console.log(`终稿段数    均值 ${(paras.reduce((a, b) => a + b, 0) / paras.length).toFixed(1)} · 区间 ${Math.min(...paras)}-${Math.max(...paras)}`);
  console.log(`终稿段均    ${(mean / (paras.reduce((a, b) => a + b, 0) / paras.length)).toFixed(1)} 字`);

  // 未能达标时给出可行动的结论，而不只是一个数字
  if (inTarget < rows.length) {
    const low = cs.filter((c) => c < TARGET_CHARS_MIN).length;
    const high = cs.filter((c) => c > TARGET_CHARS_MAX).length;
    console.log('');
    console.log(`偏离方向：偏低 ${low} 次 · 偏高 ${high} 次`);
    if (low > high) {
      console.log('→ 偏低为主：把 constants.ts 的 PARA_TARGET_MIN/MAX 上调 1-2 段后重跑。');
    } else if (high > low) {
      console.log('→ 偏高为主：把 PARA_TARGET_MIN/MAX 下调 1-2 段后重跑。');
    } else {
      console.log('→ 两侧都偏：模型方差主导，考虑缩窄目标或接受门禁区间（1300-2300）。');
    }
  }
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
