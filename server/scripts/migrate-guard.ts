/**
 * migrate dev 命令级安全护栏（S6-4-A-R-FIX：主目标 + Shadow 双重身份校验）。
 *
 * 由 `npm run prisma:migrate` 调用，代替裸 `prisma migrate dev`。
 * 在任何 prisma 进程启动之前，用结构化 URL 解析确认两处数据库身份：
 *   - 主目标：DATABASE_URL 指向的库，必须与显式配置的 MIGRATE_DEV_DATABASE_URL 身份全等，
 *     且不属于保留集合 {wechat_pipeline, wechat_pipeline_shadow, wechat_pipeline_smoke}。
 *   - Shadow：prisma migrate dev 会重置 SHADOW_DATABASE_URL 指向的库并重放迁移历史
 *     （Shadow 不是只读连接！），因此也必须校验：
 *       · SHADOW_DATABASE_URL（Prisma 实际使用的 Shadow 连接，取最终生效值）必须存在、可解析；
 *       · 必须与显式配置的 MIGRATE_DEV_SHADOW_DATABASE_URL 身份全等；
 *       · 不属于保留集合，且与主目标 DATABASE_URL 不是同一个数据库身份。
 *
 * 身份规范化：WHATWG URL 解析后取 host(小写) + port(缺省补全 3306) + db(decodeURIComponent 后小写)，
 * 三元组全等才视为同一身份；同一主机不同库允许，默认端口与显式 3306 视为相同。
 * 不打印用户名/密码，不通过字符串包含判断身份。
 *
 * 任一身份缺失 / 解析失败 / 不匹配 / 命中保留库 / 危险参数 → exit(1)（fail-closed）。
 *
 * 自检：`node --experimental-strip-types scripts/migrate-guard.ts --self-test`
 *   （纯函数 + 假 URL，绝不连接任何数据库、不调用 Prisma CLI、不依赖真实 .env。）
 *
 * 残留风险（如实记录）：本脚本只保护 npm script 入口；直接执行
 *   `npx prisma migrate dev` 或 `node prisma/build/index.js migrate dev` 会绕过本护栏。
 *   彻底封堵需数据库账号权限分离或 shell 层包装，不在本实施单元范围内。
 */

import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const PRISMA_CLI = join(SERVER_DIR, 'node_modules', 'prisma', 'build', 'index.js');

/** 保留库名：任何情况下都不得作为 migrate dev 的主目标或 Shadow。 */
const RESERVED_DB_NAMES = new Set([
  'wechat_pipeline',
  'wechat_pipeline_shadow',
  'wechat_pipeline_smoke',
]);

/** 危险参数：一旦出现立即拒绝，不透传给 prisma。 */
const DANGEROUS_FLAGS = new Set([
  '--force-reset',
  '--force-accept-data-loss',
  '--force',
  '--reset',
]);
/** 危险子命令词（作为独立参数出现时拒绝，防止改变迁移意图）。 */
const DANGEROUS_SUBCOMMANDS = new Set([
  'reset', 'resolve', 'deploy', 'push', 'status', 'diff',
]);

type Env = Record<string, string | undefined>;

/** 规范化后的数据库身份三元组。 */
type DbIdentity = { db: string; host: string; port: string };

type Identity =
  | ({ ok: true } & DbIdentity)
  | { ok: false; error: string };

type Verdict = { allow: boolean; reason: string };

/**
 * 结构化解析 MySQL 连接串（WHATWG URL，不做字符串包含判断）。
 * 规范化：host 小写、port 缺省补 3306、db 走 decodeURIComponent 后小写（lct=1 库名大小写不敏感）。
 */
function parseIdentity(raw: string): Identity {
  if (!raw) return { ok: false, error: '连接串为空' };
  let u: URL;
  let db: string;
  try {
    u = new URL(raw);
    db = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
  } catch {
    return { ok: false, error: '连接串解析失败' };
  }
  if (u.protocol !== 'mysql:') {
    return { ok: false, error: '协议不是 mysql:' };
  }
  if (!db) {
    return { ok: false, error: '连接串缺库名' };
  }
  const host = u.hostname.toLowerCase();
  const port = u.port || '3306';
  if (!host) {
    return { ok: false, error: '连接串缺主机' };
  }
  return { ok: true, db, host, port };
}

/** 身份三元组全等比较（host + port + database）。 */
function sameIdentity(a: DbIdentity, b: DbIdentity): boolean {
  return a.db === b.db && a.host === b.host && a.port === b.port;
}

/** 可读身份串（不含任何凭据）——用于日志与拒绝原因。 */
function idString(i: DbIdentity): string {
  return `${i.db}@${i.host}:${i.port}`;
}

/** 凭据脱敏：任何输出路径都不落用户名/密码。 */
function mask(raw: string): string {
  return raw.replace(/:\/\/([^:/@]+):([^@/]*)@/, '://***:***@');
}

/** 解析必需 env：缺失 / 解析失败即返回拒绝裁定。 */
function requireIdentity(
  env: Env,
  key: string,
  label: string,
): { ok: true; raw: string; id: DbIdentity } | { ok: false; verdict: Verdict } {
  const raw = env[key] ?? '';
  if (!raw) {
    return { ok: false, verdict: { allow: false, reason: `拒绝：${key}（${label}）未配置，fail-closed` } };
  }
  const parsed = parseIdentity(raw);
  if (!parsed.ok) {
    return { ok: false, verdict: { allow: false, reason: `拒绝：${key}（${label}）身份无法确认：${parsed.error}（${mask(raw)}）` } };
  }
  return { ok: true, raw, id: parsed };
}

/**
 * 核心判定（纯函数，便于自检）。
 * env：参与判定的环境变量容器（main 中即 process.env，与 spawn 传给 Prisma 的是同一份）；
 * argv：透传给 prisma 的额外参数。
 */
function evaluate(env: Env, argv: string[]): Verdict {
  // ① 危险参数 / 危险子命令拦截（先于一切）
  for (const arg of argv) {
    const lower = arg.toLowerCase();
    if (DANGEROUS_FLAGS.has(lower) || lower.startsWith('--force')) {
      return { allow: false, reason: `危险参数被拦截：${arg}` };
    }
    // --schema path / --schema=path 均拦截：防止指定备用 Schema 绕过护栏
    if (lower === '--schema' || lower.startsWith('--schema=')) {
      return { allow: false, reason: '危险参数被拦截：--schema（禁止指定备用 Prisma Schema 绕过护栏）' };
    }
    if (!arg.startsWith('-') && DANGEROUS_SUBCOMMANDS.has(lower)) {
      return { allow: false, reason: `危险子命令被拦截：${arg}` };
    }
  }

  // ② 主目标：DATABASE_URL 必须存在、可解析、非保留库
  const mainR = requireIdentity(env, 'DATABASE_URL', '迁移主目标');
  if (!mainR.ok) return mainR.verdict;
  const main = mainR.id;
  if (RESERVED_DB_NAMES.has(main.db)) {
    return {
      allow: false,
      reason: `拒绝：主目标 ${idString(main)} 是保留库（正式库/Shadow/Smoke 一律禁止 migrate dev，正式库请用 prisma:deploy）`,
    };
  }

  // ③ 开发库必须显式配置，且与主目标身份全等
  const devR = requireIdentity(env, 'MIGRATE_DEV_DATABASE_URL', '显式开发库配置');
  if (!devR.ok) return devR.verdict;
  const dev = devR.id;
  if (RESERVED_DB_NAMES.has(dev.db)) {
    return { allow: false, reason: `拒绝：MIGRATE_DEV_DATABASE_URL 指向保留库 ${idString(dev)}` };
  }
  if (!sameIdentity(main, dev)) {
    return {
      allow: false,
      reason: `拒绝：DATABASE_URL(${idString(main)}) 与 MIGRATE_DEV_DATABASE_URL(${idString(dev)}) 身份不匹配`,
    };
  }

  // ④ Shadow 校验（P0 修复）：Prisma migrate dev 会重置 Shadow 并重放迁移历史。
  //    SHADOW_DATABASE_URL 是 Prisma 实际读取的最终生效值（dotenv + 进程级覆盖后），必须与
  //    显式允许的 MIGRATE_DEV_SHADOW_DATABASE_URL 全等、非保留库、且与主目标不同库。
  const shadowR = requireIdentity(env, 'SHADOW_DATABASE_URL', 'Prisma 实际使用的 Shadow 连接');
  if (!shadowR.ok) return shadowR.verdict;
  const shadow = shadowR.id;
  if (RESERVED_DB_NAMES.has(shadow.db)) {
    return {
      allow: false,
      reason: `拒绝：SHADOW_DATABASE_URL 指向保留库 ${idString(shadow)}（正式库/现有 Shadow/Smoke 均不得作为开发 Shadow）`,
    };
  }
  if (sameIdentity(shadow, main)) {
    return { allow: false, reason: `拒绝：Shadow(${idString(shadow)}) 与迁移主目标身份相同，migrate dev 会重置 Shadow` };
  }

  const devShadowR = requireIdentity(env, 'MIGRATE_DEV_SHADOW_DATABASE_URL', '显式开发 Shadow 配置');
  if (!devShadowR.ok) return devShadowR.verdict;
  const devShadow = devShadowR.id;
  if (RESERVED_DB_NAMES.has(devShadow.db)) {
    return { allow: false, reason: `拒绝：MIGRATE_DEV_SHADOW_DATABASE_URL 指向保留库 ${idString(devShadow)}` };
  }
  if (!sameIdentity(shadow, devShadow)) {
    return {
      allow: false,
      reason: `拒绝：SHADOW_DATABASE_URL(${idString(shadow)}) 与 MIGRATE_DEV_SHADOW_DATABASE_URL(${idString(devShadow)}) 身份不匹配`,
    };
  }
  if (sameIdentity(devShadow, main)) {
    return { allow: false, reason: `拒绝：开发 Shadow(${idString(devShadow)}) 与迁移主目标身份相同` };
  }

  return {
    allow: true,
    reason: `允许 migrate dev → 主目标 ${idString(main)} / Shadow ${idString(shadow)}（均为显式配置的独立库、身份匹配且互不相同）`,
  };
}

/** 纯本地自检：假 URL，绝不连接数据库、不调用 Prisma、不依赖真实 .env。 */
function runSelfTest(): void {
  const fake = (db: string, host = '127.0.0.1', port = '3306'): string =>
    `mysql://dev_user:fake_secret@${host}:${port}/${db}`;
  const DEV = 'dev_local';
  const SHADOW = 'dev_local_shadow';
  /** 完全合法的环境基线；各用例在此基础上做最小改动。 */
  const baseEnv = (): Env => ({
    DATABASE_URL: fake(DEV),
    MIGRATE_DEV_DATABASE_URL: fake(DEV),
    SHADOW_DATABASE_URL: fake(SHADOW),
    MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW),
  });
  const cases: Array<{ name: string; env: Env; argv: string[]; expectAllow: boolean; expectReason?: string }> = [
    // —— 主目标拒绝 ——
    { name: '主目标为正式库 → 拒绝',
      env: { ...baseEnv(), DATABASE_URL: fake('wechat_pipeline'), MIGRATE_DEV_DATABASE_URL: fake('wechat_pipeline') },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: '主目标为 Shadow 保留库 → 拒绝',
      env: { ...baseEnv(), DATABASE_URL: fake('wechat_pipeline_shadow'), MIGRATE_DEV_DATABASE_URL: fake('wechat_pipeline_shadow') },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: '主目标为 Smoke 库 → 拒绝',
      env: { ...baseEnv(), DATABASE_URL: fake('wechat_pipeline_smoke'), MIGRATE_DEV_DATABASE_URL: fake('wechat_pipeline_smoke') },
      argv: [], expectAllow: false, expectReason: '保留库' },
    // —— 合法允许 ——
    { name: '主目标合法 + Shadow 合法且与显式配置匹配 → 允许',
      env: baseEnv(), argv: [], expectAllow: true },
    { name: '主目标与 Shadow 同一 MySQL 主机、不同数据库 → 允许',
      env: baseEnv(), argv: [], expectAllow: true },
    { name: '主机名大小写规范化后匹配 → 允许',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake(SHADOW, 'LOCALHOST'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW, 'localhost') },
      argv: [], expectAllow: true },
    { name: '数据库名 URL 编码解码后匹配 → 允许',
      env: { ...baseEnv(), MIGRATE_DEV_SHADOW_DATABASE_URL: `mysql://dev_user:fake_secret@127.0.0.1:3306/dev_local%5Fshadow` },
      argv: [], expectAllow: true },
    { name: '合法配置 + 安全参数 --name → 允许',
      env: baseEnv(), argv: ['--name', 'add_example'], expectAllow: true },
    // —— 数据库名大小写规范化（lower_case_table_names=1）——
    { name: '主目标库名大小写变体 WeChat_Pipeline → 命中保留库拒绝',
      env: { ...baseEnv(), DATABASE_URL: fake('WeChat_Pipeline'), MIGRATE_DEV_DATABASE_URL: fake('WeChat_Pipeline') },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: 'Shadow 库名大小写变体 WECHAT_PIPELINE → 命中保留库拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('WECHAT_PIPELINE'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake('WECHAT_PIPELINE') },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: '主目标 dev_local 与 Shadow DEV_LOCAL 规范化后同库 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('DEV_LOCAL'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake('DEV_LOCAL') },
      argv: [], expectAllow: false, expectReason: '身份相同' },
    { name: '主目标 Dev_Local 与开发库配置 dev_local 规范化后身份一致 → 允许',
      env: { ...baseEnv(),
        DATABASE_URL: fake('Dev_Local'),
        MIGRATE_DEV_DATABASE_URL: fake('dev_local') },
      argv: [], expectAllow: true },
    { name: '同主机不同库名规范化后仍不同 → 允许',
      env: { ...baseEnv(),
        DATABASE_URL: fake('Dev_App'),
        MIGRATE_DEV_DATABASE_URL: fake('dev_app'),
        SHADOW_DATABASE_URL: fake('Dev_Shadow'),
        MIGRATE_DEV_SHADOW_DATABASE_URL: fake('dev_shadow') },
      argv: [], expectAllow: true },
    // —— Shadow 拒绝（P0 场景全覆盖）——
    { name: 'Shadow 指向正式业务库 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('wechat_pipeline'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW) },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: 'Shadow 指向现有 Shadow 保留库 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('wechat_pipeline_shadow'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW) },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: 'Shadow 指向 Smoke 库 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('wechat_pipeline_smoke'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW) },
      argv: [], expectAllow: false, expectReason: '保留库' },
    { name: 'Shadow 与主目标为同一数据库身份 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake(DEV), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(DEV) },
      argv: [], expectAllow: false, expectReason: '身份相同' },
    { name: '默认端口与显式 3306 视为同一身份（主目标与 Shadow 重合）→ 拒绝',
      env: { ...baseEnv(),
        DATABASE_URL: 'mysql://dev_user:fake_secret@127.0.0.1/dev_local',
        MIGRATE_DEV_DATABASE_URL: 'mysql://dev_user:fake_secret@127.0.0.1/dev_local',
        SHADOW_DATABASE_URL: fake('dev_local', '127.0.0.1', '3306'),
        MIGRATE_DEV_SHADOW_DATABASE_URL: fake('dev_local', '127.0.0.1', '3306') },
      argv: [], expectAllow: false, expectReason: '身份相同' },
    { name: 'Shadow 缺失 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: undefined },
      argv: [], expectAllow: false, expectReason: 'SHADOW_DATABASE_URL' },
    { name: 'MIGRATE_DEV_SHADOW_DATABASE_URL 缺失 → 拒绝',
      env: { ...baseEnv(), MIGRATE_DEV_SHADOW_DATABASE_URL: undefined },
      argv: [], expectAllow: false, expectReason: 'MIGRATE_DEV_SHADOW_DATABASE_URL' },
    { name: 'Shadow URL 无法解析 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: 'not a url' },
      argv: [], expectAllow: false, expectReason: 'SHADOW_DATABASE_URL' },
    { name: 'Shadow 与显式允许配置不匹配 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('other_shadow') },
      argv: [], expectAllow: false, expectReason: '身份不匹配' },
    { name: 'Shadow 指向其他未授权数据库 → 拒绝',
      env: { ...baseEnv(), SHADOW_DATABASE_URL: fake('unauthorized_db'), MIGRATE_DEV_SHADOW_DATABASE_URL: fake(SHADOW) },
      argv: [], expectAllow: false, expectReason: '身份不匹配' },
    // —— 参数安全 ——
    { name: '危险参数 --force-reset → 拒绝',
      env: baseEnv(), argv: ['--force-reset'], expectAllow: false, expectReason: '危险参数被拦截' },
    { name: '危险参数 --force-accept-data-loss → 拒绝',
      env: baseEnv(), argv: ['--force-accept-data-loss'], expectAllow: false, expectReason: '危险参数被拦截' },
    { name: '危险子命令 reset → 拒绝',
      env: baseEnv(), argv: ['reset'], expectAllow: false, expectReason: '危险子命令被拦截' },
    { name: '--schema path 形式 → 拒绝',
      env: baseEnv(), argv: ['--schema', 'other.prisma'], expectAllow: false, expectReason: '--schema' },
    { name: '--schema=path 形式 → 拒绝',
      env: baseEnv(), argv: ['--schema=other.prisma'], expectAllow: false, expectReason: '--schema' },
    // —— 主目标 fail-closed（回归）——
    { name: 'MIGRATE_DEV_DATABASE_URL 缺失 → 拒绝',
      env: { ...baseEnv(), MIGRATE_DEV_DATABASE_URL: undefined },
      argv: [], expectAllow: false, expectReason: 'MIGRATE_DEV_DATABASE_URL' },
    { name: '主目标非 mysql 协议 → 拒绝',
      env: { ...baseEnv(), DATABASE_URL: 'file:./dev.db' },
      argv: [], expectAllow: false, expectReason: 'DATABASE_URL' },
    { name: '主目标缺库名 → 拒绝',
      env: { ...baseEnv(), DATABASE_URL: 'mysql://u:p@127.0.0.1:3306' },
      argv: [], expectAllow: false, expectReason: 'DATABASE_URL' },
    { name: '主目标与开发库配置不匹配 → 拒绝',
      env: { ...baseEnv(), MIGRATE_DEV_DATABASE_URL: fake('other_dev') },
      argv: [], expectAllow: false, expectReason: '身份不匹配' },
  ];

  let failed = 0;
  for (const c of cases) {
    const v = evaluate(c.env, c.argv);
    let ok = v.allow === c.expectAllow;
    if (ok && c.expectReason) ok = v.reason.includes(c.expectReason);
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} → allow=${v.allow} (${v.reason})`);
  }
  console.log(`self-test: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const verdict = evaluate(process.env, argv);
  if (!verdict.allow) {
    console.error(`[migrate-guard] 拒绝执行：${verdict.reason}`);
    process.exit(1);
  }
  console.error(`[migrate-guard] PASS：${verdict.reason}`);

  const r = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'dev', ...argv], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.error) {
    console.error(`[migrate-guard] prisma 进程启动失败：${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

main();
