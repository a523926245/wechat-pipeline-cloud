/**
 * 封面路径的「库内表示」与「磁盘表示」互转。
 *
 * 为什么需要这一层：
 * 库里原先直接存绝对路径（本机形如 `K:\...\var\content\covers\cover-a1-....png`）。
 * 搬到服务器后 CONTENT_DIR 变了，publisher 的 `existsSync(coverPath)` 必然 false →
 * **不报错，静默推一篇没有封面的草稿**。而前端 coverUrl() 只取 basename 拼 URL，
 * 照样显示缩略图，于是出现「界面上有封面、推送出去没封面」的诡异现象。
 *
 * 约定：库里只存**相对 CONTENT_DIR 的 POSIX 相对路径**，形如 `covers/xxx.png`。
 * 读的时候一律走 resolveCoverPath()，写的时候一律走 toRelativeCoverPath()。
 *
 * 历史行（绝对路径）由 resolveCoverPath 的兜底分支兼容：截 `/covers/` 之后的部分，
 * 再不行取 basename。**兜底必须打 warn 日志**——静默正是这个 bug 的本质，
 * 兼容路径要在日志里看得见。彻底清理靠 scripts/fix-cover-paths.ts。
 */

import { basename, isAbsolute, join, normalize } from 'node:path';

import { CONTENT_DIR } from '../config.ts';
import { logger } from '../logger.ts';

/** Windows 盘符路径。Linux 上 isAbsolute('K:/x') 是 false，所以必须单独识别。 */
const DRIVE_RE = /^[A-Za-z]:\//;

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

function rootPosix(): string {
  return posix(CONTENT_DIR).replace(/\/+$/, '');
}

/** 库内值是否已是相对路径。空串算「没有封面」，不算相对路径。 */
export function isRelativeCoverPath(coverPath: string): boolean {
  const raw = (coverPath ?? '').trim();
  if (!raw) return false;
  const u = posix(raw);
  return !isAbsolute(raw) && !DRIVE_RE.test(u) && !u.startsWith('/');
}

/**
 * 库内 coverPath → 磁盘绝对路径。
 * 相对路径直接拼 CONTENT_DIR；历史绝对路径截 `/covers/` 之后，兜底取 basename。
 * 返回 '' 表示没有封面。
 */
export function resolveCoverPath(coverPath: string): string {
  const raw = (coverPath ?? '').trim();
  if (!raw) return '';

  const u = posix(raw);

  if (isRelativeCoverPath(raw)) {
    return join(CONTENT_DIR, normalize(u).replace(/^\/+/, ''));
  }

  // 历史绝对路径：优先保留 covers/ 之后的结构，兜底只取文件名。
  const i = u.toLowerCase().lastIndexOf('/covers/');
  const rel = i >= 0 ? u.slice(i + 1) : `covers/${basename(u)}`;
  const out = join(CONTENT_DIR, normalize(rel));
  logger.warn(
    { coverPath: raw, resolved: out },
    'coverPath 是历史绝对路径，已按 basename 兜底解析（建议跑 npm run fix:cover-paths 修数）',
  );
  return out;
}

/**
 * 磁盘绝对路径 → 写库用的相对路径（POSIX 斜杠）。
 * 不在 CONTENT_DIR 下的路径（例如调用方给了别处的临时文件）也兜底成 `covers/<basename>`，
 * 保证写库的值永远是相对路径，不会把某台机器的目录结构固化进数据。
 */
export function toRelativeCoverPath(absPath: string): string {
  if (!absPath) return '';
  const u = posix(absPath);
  const root = rootPosix();
  const rel = u.startsWith(`${root}/`) ? u.slice(root.length + 1) : `covers/${basename(u)}`;
  return rel.replace(/^\/+/, '');
}
