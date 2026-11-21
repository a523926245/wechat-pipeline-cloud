/**
 * T0 隔离库守卫（失败关闭、零绕过）——S1-3 MySQL 载体适配版。
 *
 * 由 smoke-run.ts（引导入口）**只静态 import 本模块**，且本模块只依赖
 * node:process —— 不 import db.ts / config.ts / 任何 DB 驱动，
 * 因此守卫一定先于 PrismaClient 加载（次序由 smoke-run.ts 的动态 import 构造保证）。
 *
 * 校验（任一失败或守卫自身异常 → exit(1)，无警告放行、无降级、无隐藏开关）：
 *   ① DATABASE_URL 已注入且是 mysql:// 连接串（拒 file: 与一切其他形态）；
 *   ② 库名严格 = wechat_pipeline_smoke（库名白名单；拒业务库 / shadow 库名 / 一切其他库名）；
 *   ③ 主机严格 = 127.0.0.1、端口严格 = 3306（拒错主机 / 错端口）；
 *   ④ URL 解析失败、缺库名一律拒（fail-closed）。
 *
 * 通过后打 REAL/ISOLATED 横幅，并置 __SMOKE_ISO_OK__ 标记（供网守登记 API 核验）。
 * 反例验证见 `npm run verify:smoke-iso`（验收②③）。
 */

const SMOKE_DB_NAME = 'wechat_pipeline_smoke';
const REAL_DB_NAME = 'wechat_pipeline';
const ALLOWED_HOSTS = ['127.0.0.1'];
const ALLOWED_PORT = '3306';

/** 凭据脱敏：任何输出路径都不落密码。 */
function maskUrl(raw: string): string {
  return raw.replace(/:\/\/([^:/@]+):([^@/]*)@/g, '://$1:***@');
}

function fail(msg: string): never {
  console.error(`[smoke-db-guard] FAIL ${msg}`);
  process.exit(1);
}

export function assertIsolatedDatabase(): void {
  try {
    const raw = process.env.DATABASE_URL ?? '';
    if (!raw) {
      fail('DATABASE_URL 未注入（env 注入失败即退出，禁止直跑）');
    }

    // ① 只认 mysql://（file: 串与其他一切形态当场拒）
    if (!raw.startsWith('mysql://')) {
      fail(`DATABASE_URL 不是 mysql:// 连接串，拒绝执行：${maskUrl(raw)}`);
    }

    // ②③④ URL 解析 + 库名 / 主机 / 端口白名单
    let db = '';
    let host = '';
    let port = '';
    try {
      const u = new URL(raw);
      host = u.hostname;
      port = u.port || '3306'; // URL 省略默认端口时补全
      db = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
    } catch {
      fail(`DATABASE_URL 解析失败，拒绝执行：${maskUrl(raw)}`);
    }

    if (!db) {
      fail(`DATABASE_URL 缺库名，拒绝执行：${maskUrl(raw)}`);
    }
    if (db !== SMOKE_DB_NAME) {
      fail(`库名不在白名单（只允许 ${SMOKE_DB_NAME}；业务库/shadow/其他库一律拒），拒绝执行：${maskUrl(raw)}`);
    }
    if (!ALLOWED_HOSTS.includes(host)) {
      fail(`主机不在白名单（只允许 ${ALLOWED_HOSTS.join('/')}），拒绝执行：${maskUrl(raw)}`);
    }
    if (port !== ALLOWED_PORT) {
      fail(`端口不在白名单（只允许 ${ALLOWED_PORT}），拒绝执行：${maskUrl(raw)}`);
    }

    process.env.__SMOKE_ISO_OK__ = '1';
    console.error(`[smoke-db-guard] REAL      = ${REAL_DB_NAME}（业务库，永远拒绝连接）`);
    console.error(`[smoke-db-guard] ISOLATED  = ${SMOKE_DB_NAME}`);
    console.error('[smoke-db-guard] PASS（mysql 形态 / 库名白名单 / 主机端口白名单 校验通过）');
  } catch (e) {
    // 守卫自身异常一律失败关闭
    fail(`守卫自身异常：${e instanceof Error ? e.message : String(e)}`);
  }
}
