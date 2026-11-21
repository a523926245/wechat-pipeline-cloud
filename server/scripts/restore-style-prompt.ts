/**
 * `r:{赛道}` 机器规则行的**备份 / 校验 / 回滚**工具（S4-5 S2）。
 *
 * 为什么不用 mysql CLI 存备份（2026-11-16 实测，Windows 8.0.30 客户端）：
 *   - `-N -B`（batch）会把换行/制表/反斜杠**转义**成字面 `\n` `\t` `\\`：
 *     DB 里是 `61 0A 62`，导出来是 `61 5C 6E 62`（`a\nb`），JSON 直接解析失败；
 *   - 加 `--raw` 能关掉转义，但 Windows 客户端在文本模式下会把**所有 LF 改写成 CRLF**：
 *     导出的文件是 `61 0D 0A 62`，与库内 `61 0A 62` 逐字节不同；
 *   - 且两种方式都会额外追加一个行尾换行。
 * 结论：CLI 在 Windows 上做不到「逐字节等于库内原文」。本脚本走 Prisma 读 `prompt` 原样落盘，
 * 不转义、不换行转换、不补行尾——备份文件与库内字符串逐字节一致。
 *
 * 三个动作（互斥）：
 *   --dump <file>   备份：把库内 prompt 原样写入文件，并打印其 SHA-256
 *                   **fail-closed**：文件与库内不逐字节一致 → exit 1；`JSON.parse` 失败 → exit 1
 *   --from <file>   回滚：把文件内容原样写回库（参数化 update，不拼 SQL）
 *   --dry-run       只比对不写库（配合 --from 使用）
 *   --pin-flag      回滚时**先**钉死 style_seed_v16=16，**再**恢复 prompt（顺序不可反，
 *                   否则恢复期间任何一次配置读取都会把豁免补回来）
 *                   恢复后回读校验 SHA-256，与备份不一致 → exit 1
 *
 * 用法（在 server/ 目录下）：
 *   node --experimental-strip-types scripts/restore-style-prompt.ts --key "r:星座" --dump var/tmp/s45/zodiac.before.json
 *   node --experimental-strip-types scripts/restore-style-prompt.ts --key "r:星座" --from var/tmp/s45/zodiac.before.json --dry-run
 *   node --experimental-strip-types scripts/restore-style-prompt.ts --key "r:星座" --from var/tmp/s45/zodiac.before.json --pin-flag
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { prisma } from '../src/db.ts';

const V16_FLAG = 'style_seed_v16';

interface Args {
  key: string;
  from?: string;
  dump?: string;
  dryRun: boolean;
  pinFlag: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const key = get('--key');
  const from = get('--from');
  const dump = get('--dump');
  if (!key || (!from && !dump)) {
    console.error(
      '用法：--key "r:星座" (--dump <备份文件> | --from <备份文件>) [--dry-run] [--pin-flag]',
    );
    process.exit(1);
  }
  if (from && dump) {
    console.error('--from 与 --dump 不能同时使用');
    process.exit(1);
  }
  // 只允许动机器规则行：这条限制让误操作无法波及 global / sys: / s: / v: 等提示词行。
  if (!key.startsWith('r:')) {
    console.error(`拒绝执行：--key 必须形如 "r:赛道"，收到 ${key}`);
    process.exit(1);
  }
  return { key, from, dump, dryRun: argv.includes('--dry-run'), pinFlag: argv.includes('--pin-flag') };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const brief = (v: unknown): string => JSON.stringify(v);

function relaxOf(prompt: string): unknown {
  try {
    const o = JSON.parse(prompt) as Record<string, unknown>;
    return o.relax ?? null;
  } catch {
    return '(JSON 解析失败)';
  }
}

function assertRuleJson(text: string, key: string): { checks: unknown; angleMode: unknown; relax?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`拒绝写入：${key} 的备份不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`拒绝写入：${key} 的备份不是 JSON 对象`);
    process.exit(1);
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.checks)) {
    console.error(`拒绝写入：${key} 的备份缺少 checks 数组`);
    process.exit(1);
  }
  if (typeof o.angleMode !== 'string') {
    console.error(`拒绝写入：${key} 的备份缺少 angleMode 字符串`);
    process.exit(1);
  }
  return { checks: o.checks, angleMode: o.angleMode, relax: o.relax };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const row = await prisma.stylePrompt.findUnique({ where: { key: args.key } });
  if (!row) {
    console.error(`目标行不存在：${args.key}（拒绝创建新行）`);
    process.exit(1);
  }

  // ── 备份 ──
  if (args.dump) {
    // 原样落盘：不做 JSON.stringify、不做换行转换、不补行尾换行。
    writeFileSync(args.dump, row.prompt, 'utf8');
    const back = readFileSync(args.dump, 'utf8');
    const sameBytes = back === row.prompt;
    let jsonOk = true;
    let jsonErr = '';
    try {
      JSON.parse(back);
    } catch (e) {
      jsonOk = false;
      jsonErr = e instanceof Error ? e.message : String(e);
    }
    console.log(`已备份 ${args.key} → ${args.dump}`);
    console.log(`  库内 sha256 : ${sha(row.prompt)}`);
    console.log(`  文件 sha256 : ${sha(back)}`);
    console.log(`  逐字节一致  : ${sameBytes ? '是' : '否'}`);
    console.log(`  文件字节数  : ${Buffer.byteLength(back, 'utf8')}`);
    console.log(`  relax       : ${brief(relaxOf(row.prompt))}`);
    console.log(`  JSON.parse  : ${jsonOk ? '通过' : `失败（${jsonErr}）`}`);
    // fail-closed：备份要么「与库内逐字节一致」，要么「能被 JSON.parse」——任一不满足都不许 exit 0。
    // 否则后续回滚会拿一个坏文件覆盖库里的规则，`loadTrackRule` 还会静默回落到种子，极难排查。
    if (!sameBytes) {
      console.error('备份失败：文件内容与库内原文不一致（可能被写入路径做了编码/换行转换）');
      process.exit(1);
    }
    if (!jsonOk) {
      console.error('备份失败：库内 prompt 不是合法 JSON（这条规则本身已坏，请先人工确认再决定是否改动）');
      process.exit(1);
    }
    console.log('备份可用：逐字节一致 + JSON 合法');
    return;
  }

  // ── 校验 / 回滚 ──
  const payload = readFileSync(args.from!, 'utf8');
  const parsed = assertRuleJson(payload, args.key);
  const same = sha(row.prompt) === sha(payload);

  console.log(`目标行：${args.key}`);
  console.log('当前 relax :', brief(relaxOf(row.prompt)));
  console.log('备份 relax :', brief(parsed.relax));
  console.log(`当前 prompt sha256: ${sha(row.prompt)}`);
  console.log(`备份 prompt sha256: ${sha(payload)}`);
  console.log(`备份与库内原文一致: ${same ? '是（无需恢复）' : '否'}`);
  console.log(`备份 checks/angleMode: ${brief(parsed.checks)} / ${brief(parsed.angleMode)}`);

  if (args.dryRun) {
    console.log('--dry-run：未写库。');
    return;
  }

  // ① 先钉死标记，再动数据（顺序不能反）。
  // 反了会有一个窗口：代码还在迁移链上、标记仍缺失时，任何一次配置读取都会把豁免补回来，
  // 等于刚恢复的数据立刻被覆盖。先钉标记 = 先关掉那个并发入口。
  if (args.pinFlag) {
    await prisma.setting.upsert({
      where: { k: V16_FLAG },
      create: { k: V16_FLAG, v: '16', kind: 'json', desc: '文风种子版本 v16（已回滚，保留标记防重跑）' },
      update: { v: '16', desc: '文风种子版本 v16（已回滚，保留标记防重跑）' },
    });
    console.log(`① 已钉死迁移标记 ${V16_FLAG}=16（此后不会再触发 V16）`);
  }

  // ② 再恢复 prompt 原文
  if (same) {
    console.log('② 内容已与备份一致，跳过 update。');
  } else {
    // 参数化写入：不拼 SQL 字符串，原文里的引号/换行/反斜杠都不需要额外处理。
    await prisma.stylePrompt.update({ where: { key: args.key }, data: { prompt: payload } });
    console.log(`② 已恢复 ${args.key} 的 prompt`);
  }

  // ③ 回读校验：原文必须与备份逐字节一致，否则本轮恢复不算成功。
  const after = await prisma.stylePrompt.findUnique({ where: { key: args.key } });
  if (!after) {
    console.error('回读失败：目标行已不存在');
    process.exit(1);
  }
  const backSha = sha(after.prompt);
  const wantSha = sha(payload);
  console.log(`③ 回读 sha256: ${backSha}`);
  console.log(`  备份 sha256: ${wantSha}`);
  console.log(`  回读 relax : ${brief(relaxOf(after.prompt))}`);
  if (backSha !== wantSha) {
    console.error('恢复失败：回读内容与备份不一致（可能被并发写入覆盖）');
    process.exit(1);
  }
  console.log('恢复成功：回读与备份逐字节一致');
}

await main();
await prisma.$disconnect();
