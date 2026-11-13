/**
 * T0 隔离库守卫（失败关闭、零绕过）。
 *
 * 由 smoke-run.ts（引导入口）**只静态 import 本模块**，且本模块只依赖
 * node:fs / node:path / node:url / node:process —— 不 import db.ts / config.ts，
 * 因此守卫一定先于 PrismaClient 加载（次序由 smoke-run.ts 的动态 import 构造保证）。
 *
 * 校验（任一失败或守卫自身异常 → exit(1)，无警告放行、无降级、无隐藏开关）：
 *   ① DATABASE_URL 已注入且是 SQLite file: 连接串（env 注入失败即退出）；
 *   ② 命名符合 dev.smoke-*.db（隔离命名约定）；
 *   ③ 路径归一（resolve + realpath 展开 8.3 短名 + 盘符归一）后 ≠ 真实 dev.db
 *      及其任何别名（含 config.ts 历史兜底路径）；
 *   ④ 文件确实存在且大小 > 0（由 runner 的 schema-only 链创建）；
 *   ⑤ 必须落在 server/prisma/ 目录下（隔离库固定位置，收紧可写面）。
 *
 * 通过后打 REAL/ISOLATED 横幅，并置 __SMOKE_ISO_OK__ 标记（供网守登记 API 核验）。
 * 反例验证见 `npm run verify:smoke-iso`。
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url)); // server/scripts
const PRISMA_DIR = resolve(SCRIPTS_DIR, '..', 'prisma'); // server/prisma
const REAL_DB_PATHS = [
  resolve(PRISMA_DIR, 'dev.db'),
  resolve(SCRIPTS_DIR, '..', 'var', 'tmp', 'dev.db'), // config.ts 历史兜底路径
];

/** 路径归一：绝对化 + realpath（展开 8.3 短名/符号链接）+ Windows 大小写不敏感比对。 */
function normAbs(p: string): string {
  let s = resolve(p);
  try {
    if (existsSync(s)) s = realpathSync(s);
  } catch {
    /* realpath 失败时保留 resolve 结果，比对只会更严 */
  }
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function fail(msg: string): never {
  console.error(`[smoke-db-guard] FAIL ${msg}`);
  process.exit(1);
}

/** 解析 Prisma SQLite file: 连接串为文件系统路径（相对路径按 schema 目录解析，与 Prisma 语义一致）。 */
function parseFileUrl(raw: string): string {
  let p = raw.slice('file:'.length);
  if (p.startsWith('///')) {
    p = p.slice(2); // file:///C:/x → /C:/x
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  } else if (p.startsWith('//')) {
    fail(`不支持的 DATABASE_URL 形态（file://host/ 不是本地文件）：${raw}`);
  }
  return p;
}

export function assertIsolatedDatabase(): void {
  try {
    const raw = process.env.DATABASE_URL ?? '';
    if (!raw) {
      fail('DATABASE_URL 未注入（env 注入失败即退出，禁止直跑）');
    }
    if (!raw.startsWith('file:')) {
      fail(`DATABASE_URL 不是 SQLite file: 连接串：${raw}`);
    }

    const abs = resolve(PRISMA_DIR, parseFileUrl(raw));
    const name = basename(abs);
    const norm = normAbs(abs);

    // ③ ≠ 真实 dev.db 及别名（路径归一后精确比对；最先查，反例证据最明确）
    for (const real of REAL_DB_PATHS) {
      if (norm === normAbs(real)) {
        fail(`指向真实数据库，拒绝执行：${abs}`);
      }
    }

    // ② 命名约定
    if (!/^dev\.smoke-.+\.db$/i.test(name)) {
      fail(`隔离库命名不符 dev.smoke-*.db：${name}`);
    }

    // ⑤ 目录收紧
    if (normAbs(dirname(abs)) !== normAbs(PRISMA_DIR)) {
      fail(`隔离库必须位于 server/prisma/ 下：${abs}`);
    }

    // ④ 文件确实落盘（runner 的 schema-only 链产物）
    if (!existsSync(abs)) {
      fail(`隔离库文件不存在（runner 未建库或已被删除）：${abs}`);
    }
    if (statSync(abs).size <= 0) {
      fail(`隔离库文件为空：${abs}`);
    }

    process.env.__SMOKE_ISO_OK__ = '1';
    console.error(`[smoke-db-guard] REAL      = ${resolve(REAL_DB_PATHS[0]!)}`);
    console.error(`[smoke-db-guard] ISOLATED  = ${abs}`);
    console.error('[smoke-db-guard] PASS（命名 / 路径归一反真实库 / 目录 / 落盘 校验通过）');
  } catch (e) {
    // 守卫自身异常一律失败关闭
    fail(`守卫自身异常：${e instanceof Error ? e.message : String(e)}`);
  }
}
