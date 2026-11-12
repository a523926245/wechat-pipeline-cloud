/**
 * 提示词落盘：把每次写稿实际发给模型的 system / user 消息原样存下来。
 *
 * 为什么需要它：提示词是**七拼八凑**出来的（总纲 → 赛道文风 → 规范三节 → 选题 → 变体 → tail），
 * 任何一处冲突都不会报错，只会让模型在两个要求之间自己选——
 * 实测「每个星座一段」写进了 system，但骨架卡里的一句话就把它顶掉了。
 * 只看单个配置项看不出冲突，**必须看拼完的成品**。
 *
 * 开关：`PROMPT_DUMP=0` 关闭；默认开启。
 * 位置：`var/prompts/YYYYMMDD-HHMMSS-<赛道>.md`，只保留最近 30 份（防止磁盘被写满）。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'var', 'prompts');
const KEEP = 30;

export function promptDumpEnabled(): boolean {
  return process.env.PROMPT_DUMP !== '0';
}

/** 落一份提示词。任何失败都不影响写稿——它只是排障用的旁路。 */
export function dumpPrompt(trackName: string, system: string, user: string): void {
  if (!promptDumpEnabled()) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const safe = trackName.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    const file = join(DIR, `${ts}-${safe}.md`);
    writeFileSync(
      file,
      [
        `# ${trackName} · ${new Date().toISOString()}`,
        '',
        '## SYSTEM',
        '',
        system,
        '',
        '## USER',
        '',
        user,
        '',
      ].join('\n'),
      'utf8',
    );

    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    while (files.length > KEEP) {
      const gone = files.shift();
      if (gone) rmSync(join(DIR, gone), { force: true });
    }
  } catch {
    // 落盘失败不阻断写稿
  }
}
