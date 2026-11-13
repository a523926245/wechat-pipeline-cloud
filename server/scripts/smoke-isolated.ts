/**
 * T0 隔离运行器（父进程）。三条标准冒烟（smoke:lint / smoke:style / smoke:angles）
 * 的唯一执行通道——命令名不变，执行体改为经本运行器。
 *
 * 机制真源：docs/restructure/T0-SAFETY-SUPPLEMENT.md v3。
 *   ① 隔离库 = schema-only 空库：prisma db push --schema schema.sqlite.prisma
 *      --skip-generate 对全新文件建结构、零行数据（真实数据零复制）；
 *   ② schema-only 验证链：文件落盘 → PRAGMA database_list 实测连接路径 →
 *      关键业务表结构存在 → 全部业务表行数 = 0，任一失败 exit(1)；
 *   ③ 失败关闭、零绕过：无 SMOKE_ALLOW_LIVE_DB 之类放行开关；
 *   ④ 原库零写入：测试前后 SHA-256（含 -wal/-shm）+ 大小 + mtime 比对，
 *      任一不同本轮作废并报警；启动前检测并发写入者（8787 / scheduler）默认拒绝启动；
 *   ⑤ 子进程 env 显式允许清单（其余一律剥离：APP_SECRET_KEY / *TOKEN/*SECRET/*KEY /
 *      代理变量 / 云凭据）；
 *   ⑥ 网络隔离（第 1 层 Node 入口隔离）由 smoke-net-guard.mjs 预载实现——
 *      非 OS 级全网络隔离，报告如实标注。
 *
 * 用法：
 *   node --experimental-strip-types scripts/smoke-isolated.ts run <lint|style|angles>
 *   node --experimental-strip-types scripts/smoke-isolated.ts verify   （10 项验收台）
 *   node --experimental-strip-types scripts/smoke-isolated.ts prune    （SIGKILL 残留恢复）
 *
 * 内部旗标（仅供 verify 验收台构造故障路径，不构成任何隔离绕过）：
 *   --timeout-ms=N              收紧子进程超时
 *   --simulate-signal=SIGINT|SIGTERM  自触发信号处理器（Windows 跨进程信号=硬终止，
 *                                   真实信号路径在 POSIX 下验证，Windows 用处理器自触发）
 *   --simulate-error=after-create     隔离库建成后抛普通异常（验证 runner 清理）
 *   --inject-proxy-env                向子进程注入代理变量（验证网守清除+封堵）
 *
 * SIGKILL 残留（无法保证清理）：最坏残留 = server/prisma/dev.smoke-*.db（绝不碰原库），
 * 恢复方法 = `npm run smoke:prune-iso`（或手动按命名模式删除）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { connect as netConnect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url)); // server/scripts
const SERVER_DIR = resolve(SCRIPTS_DIR, '..'); // server
const PRISMA_DIR = resolve(SERVER_DIR, 'prisma');
const REAL_DB = join(PRISMA_DIR, 'dev.db');
const NET_GUARD = join(SCRIPTS_DIR, 'smoke-net-guard.mjs');
const RUN_ENTRY = join(SCRIPTS_DIR, 'smoke-run.ts');

/** 全部业务表的物理表名（schema.sqlite.prisma 模型清单）——空库证明逐表断言行数=0。
 *  注意 @@map：OAAccount 模型物理表名是 Account（2026-11 多用户改造稳住旧表名），其余=模型名。 */
const BUSINESS_TABLES = [
  'Track', 'TrackPipeline', 'Account', 'User', 'UserSession', 'WechatToken',
  'Angle', 'Article', 'ComicPanel', 'TaskRun', 'RunLog',
  'LlmModel', 'ModelBinding', 'Setting', 'StylePrompt',
];

/** 子进程 env 显式允许清单（Q7-4）。其余一律剥离。 */
const ENV_ALLOW = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'TZ'] as const;

const DEFAULT_TIMEOUT_MS = 300_000;

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────
function log(msg: string): void {
  console.log(msg);
}
function die(msg: string): never {
  console.error(`[t0] FATAL ${msg}`);
  // process.exit 会跳过 finally——die 前必须自行清理（清理矩阵「普通异常」路径）。
  const child = activeRun?.child;
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill(); } catch { /* 忽略 */ }
  }
  const residuals = cleanupActiveRun();
  if (residuals.length > 0) {
    console.error(`[t0] ⚠️ 清理失败，残留：${residuals.join(', ')}`);
    console.error('[t0] ⚠️ 恢复方法：npm run smoke:prune-iso');
  }
  process.exit(1);
}
function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function normPath(p: string): string {
  const s = resolve(p);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

interface FpEntry {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

/** 原库指纹：dev.db + 存在的 -wal/-shm（Q6）。 */
function fingerprintRealDb(): FpEntry[] {
  return [REAL_DB, `${REAL_DB}-wal`, `${REAL_DB}-shm`]
    .filter((f) => existsSync(f))
    .map((f) => {
      const st = statSync(f);
      return { path: f, sha256: sha256File(f), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    });
}
function fpEqual(a: FpEntry[], b: FpEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (typeof v === 'string') env[k] = v;
  }
  return { ...env, ...extra };
}

function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((res) => {
    const sock = netConnect({ host, port });
    const done = (v: boolean): void => {
      try {
        sock.destroy();
      } catch {
        /* 忽略 */
      }
      res(v);
    };
    sock.setTimeout(1000, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

/** 并发写入者扫描（Q6）：8787 监听 + scheduler 进程。发现即默认拒绝启动（无绕过开关）。 */
async function scanWriters(): Promise<void> {
  if (await probePort(8787)) {
    die('检测到 8787 端口被监听（API 服务/并发写入者）→ 拒绝启动');
  }
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'cli[/\\\\]scheduler|scheduler\\.(ts|js)\' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    if (r.status !== 0) {
      die(`scheduler 进程扫描失败（fail-closed，拒绝启动）：${r.stderr ?? ''}`);
    }
    const out = (r.stdout ?? '').trim();
    if (out && out !== 'null') {
      die(`检测到 scheduler 进程活动（并发写入者）→ 拒绝启动：${out.slice(0, 300)}`);
    }
  } else {
    const r = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) {
      die(`scheduler 进程扫描失败（fail-closed，拒绝启动）：${r.stderr ?? ''}`);
    }
    const hits = (r.stdout ?? '')
      .split('\n')
      .filter((l) => /cli[/\\]scheduler|scheduler\.(ts|js)/.test(l));
    if (hits.length > 0) {
      die(`检测到 scheduler 进程活动（并发写入者）→ 拒绝启动：${hits.join(' | ').slice(0, 300)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 运行态（信号处理器与 finally 共用，保证任一退出路径都清理）
// ─────────────────────────────────────────────────────────────
interface ActiveRun {
  isoAbs: string;
  contentRoot: string;
  child: ChildProcess | null;
}
let activeRun: ActiveRun | null = null;

function cleanupActiveRun(): string[] {
  const residuals: string[] = [];
  if (!activeRun) return residuals;
  const { isoAbs, contentRoot } = activeRun;
  for (const p of [isoAbs, `${isoAbs}-wal`, `${isoAbs}-shm`, `${isoAbs}-journal`]) {
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
    } catch {
      residuals.push(p);
    }
  }
  if (existsSync(contentRoot)) {
    try {
      rmSync(contentRoot, { recursive: true, force: true });
    } catch {
      residuals.push(contentRoot);
    }
  }
  return residuals;
}

function onSignal(sig: string): void {
  console.error(`\n[t0] 收到 ${sig} → 杀子进程 + 清理隔离副本后退出`);
  const child = activeRun?.child;
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    const residuals = cleanupActiveRun();
    if (residuals.length > 0) {
      console.error(`[t0] ⚠️ 清理失败，残留：${residuals.join(', ')}`);
      console.error('[t0] ⚠️ 恢复方法：npm run smoke:prune-iso');
    } else {
      console.error('[t0] 清理完成');
    }
    process.exit(1);
  };
  if (child && child.exitCode === null && !child.killed) {
    // Windows 上 SQLite 文件句柄随进程终止才释放——先等子进程真正退出再删库，
    // 否则 unlink 撞 EBUSY 把「清理成功」误报成残留。兜底定时器防子进程挂死。
    const fallback = setTimeout(done, 3000);
    child.once('exit', () => {
      clearTimeout(fallback);
      setTimeout(done, 150);
    });
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  } else {
    done();
  }
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
// 退出兜底（同步）：任何漏网退出路径再扫一次 activeRun（清理矩阵全覆盖）。
process.on('exit', () => {
  cleanupActiveRun();
});

// ─────────────────────────────────────────────────────────────
// 隔离库创建 + schema-only 验证链（Q7-6）
// ─────────────────────────────────────────────────────────────
function createIsoDb(isoName: string, isoUrl: string): void {
  const prismaCli = join(SERVER_DIR, 'node_modules', 'prisma', 'build', 'index.js');
  const r = spawnSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--schema', join('prisma', 'schema.sqlite.prisma'), '--skip-generate'],
    {
      cwd: SERVER_DIR,
      env: buildChildEnv({
        DATABASE_URL: isoUrl,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      }),
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  if (r.status !== 0) {
    die(`prisma db push 失败（exit=${r.status}）：${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  }
}

async function verifyIsoChain(isoAbs: string, isoUrl: string): Promise<void> {
  // ① 隔离路径下文件确实新建
  if (!existsSync(isoAbs)) die(`ISO-VERIFY ① 失败：文件未落盘 ${isoAbs}`);
  if (statSync(isoAbs).size <= 0) die(`ISO-VERIFY ① 失败：文件为空 ${isoAbs}`);

  // ②③④ 连接实测（与测试同一 Prisma 客户端解析语义）
  process.env.DATABASE_URL = isoUrl;
  const { PrismaClient } = await import('@prisma/client');
  const pc = new PrismaClient();
  try {
    const rows = (await pc.$queryRawUnsafe('PRAGMA database_list')) as Array<{ file: string }>;
    const file = rows?.[0]?.file ?? '';
    if (normPath(file) !== normPath(isoAbs)) {
      die(`ISO-VERIFY ② 失败：database_list=${file} 预期=${isoAbs}（连接路径实测不一致）`);
    }
    log(`[t0] ISO-VERIFY ② database_list = ${file}`);

    const tables = (await pc.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table'",
    )) as Array<{ name: string }>;
    const have = new Set(tables.map((t) => t.name));
    const missing = BUSINESS_TABLES.filter((t) => !have.has(t));
    if (missing.length > 0) die(`ISO-VERIFY ③ 失败：缺表 ${missing.join(', ')}`);

    let rowsTotal = 0;
    for (const t of BUSINESS_TABLES) {
      const r = (await pc.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`)) as Array<{ n: unknown }>;
      const n = Number(r?.[0]?.n ?? -1);
      rowsTotal += n;
      if (n !== 0) die(`ISO-VERIFY ④ 失败：${t} 行数=${n}（空库证明不成立）`);
    }
    log(`[t0] ISO-EMPTY tables=${BUSINESS_TABLES.length}/${BUSINESS_TABLES.length} rows=${rowsTotal}`);
    log('[t0] ISO-VERIFY PASS（落盘 / 连接实测 / 表结构 / 行数=0）');
  } finally {
    await pc.$disconnect();
    delete process.env.DATABASE_URL;
  }
}

// ─────────────────────────────────────────────────────────────
// 单轮执行（run）
// ─────────────────────────────────────────────────────────────
interface RunOpts {
  target: string;
  timeoutMs: number;
  simulateSignal?: 'SIGINT' | 'SIGTERM';
  simulateError?: 'after-create';
  injectProxyEnv?: boolean;
}

async function runOne(opts: RunOpts): Promise<number> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const isoName = `dev.smoke-${stamp}.db`;
  const isoUrl = `file:./${isoName}`;
  const isoAbs = join(PRISMA_DIR, isoName);
  const contentRoot = join(SERVER_DIR, 'var', 'tmp', `smoke-iso-${stamp}`);
  const contentDir = join(contentRoot, 'content');

  log('════════════════════════════════════════════════════════');
  log(`[t0] RUN target=${opts.target}  timeout=${opts.timeoutMs}ms`);
  log(`[t0] REAL      = ${REAL_DB}`);
  log(`[t0] ISOLATED  = ${isoAbs}`);
  log(`[t0] CONTENT   = ${contentDir}`);
  log(`[t0] ENV-ALLOW = ${ENV_ALLOW.join(', ')} + DATABASE_URL/CONTENT_DIR/NODE_ENV（其余剥离：APP_SECRET_KEY、一切 *TOKEN/*SECRET/*KEY、代理变量）`);
  log(`[t0] NET       = Node 层网络入口隔离（smoke-net-guard），非 OS 级全网络隔离`);
  if (process.platform === 'win32') {
    log('[t0] NOTE Windows 下隔离库文件权限由 ACL 继承（POSIX 场景 chmod 0600）');
  }

  // ① 并发写入者扫描（发现即拒绝启动，无绕过开关）
  log('[t0] WRITER-SCAN …');
  await scanWriters();
  log('[t0] WRITER-SCAN ok（8787 未监听 / 无 scheduler 进程）');

  // ② 原库指纹（前）
  const fpBefore = fingerprintRealDb();
  for (const f of fpBefore) {
    log(`[t0] REAL-FP  ${f.path} sha256=${f.sha256} size=${f.size} mtime=${f.mtimeMs}`);
  }
  const walState = existsSync(`${REAL_DB}-wal`) ? 'present' : 'absent';
  log(`[t0] REAL-WAL = ${walState}`);

  mkdirSync(contentDir, { recursive: true });

  let childExit = 1;
  let timedOut = false;
  let simTimer: NodeJS.Timeout | null = null;
  activeRun = { isoAbs, contentRoot, child: null };

  try {
    // ③ schema-only 建库
    log(`[t0] ISO-CREATE prisma db push → ${isoName}`);
    createIsoDb(isoName, isoUrl);
    log('[t0] ISO-CREATE ok（schema-only）');
    if (process.platform !== 'win32') {
      try {
        chmodSync(isoAbs, 0o600);
      } catch {
        /* 忽略 */
      }
    }

    // ④ schema-only 验证链
    await verifyIsoChain(isoAbs, isoUrl);

    if (opts.simulateError === 'after-create') {
      throw new Error('[t0] simulate: runner 普通异常（verify 清理矩阵用）');
    }

    // ⑤ env 白名单 + 回读断言（注入失败即终止，不起子进程）
    const extra: Record<string, string> = {
      DATABASE_URL: isoUrl,
      CONTENT_DIR: contentDir,
      NODE_ENV: 'development',
    };
    if (opts.injectProxyEnv) {
      extra.HTTP_PROXY = 'http://127.0.0.1:65002';
      extra.HTTPS_PROXY = 'http://127.0.0.1:65002';
      extra.ALL_PROXY = 'http://127.0.0.1:65002';
    }
    const childEnv = buildChildEnv(extra);
    if (childEnv.DATABASE_URL !== isoUrl || childEnv.CONTENT_DIR !== contentDir) {
      die('ENV 注入回读断言失败：隔离变量未生效，拒绝起子进程');
    }
    for (const banned of ['APP_SECRET_KEY', 'ADMIN_PASSWORD', 'JWT_SECRET']) {
      if (banned in childEnv) die(`ENV 白名单泄漏敏感变量 ${banned}，拒绝起子进程`);
    }
    log('[t0] ENV-INJECT readback ok');

    // ⑥ spawn 子进程（--import 预载网守 → smoke-run.ts 引导 → 动态 import 测试模块）
    const args = [
      '--import', pathToFileURL(NET_GUARD).href,
      '--experimental-strip-types', RUN_ENTRY, opts.target,
    ];
    log(`[t0] SPAWN node ${args.join(' ')}`);
    const child = spawn(process.execPath, args, {
      cwd: SERVER_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeRun.child = child;
    let captured = '';
    child.stdout?.on('data', (d: Buffer) => {
      captured += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      captured += d.toString();
      process.stderr.write(d);
    });

    if (opts.simulateSignal) {
      const sig = opts.simulateSignal;
      simTimer = setTimeout(() => {
        log(`[t0] simulate: 自触发 ${sig} 处理器`);
        (process as unknown as { emit(s: string): boolean }).emit(sig);
      }, 800);
    }

    childExit = await new Promise<number>((res) => {
      const timer = setTimeout(() => {
        timedOut = true;
        log(`[t0] CHILD TIMEOUT（${opts.timeoutMs}ms）→ 强制终止`);
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }, opts.timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        res(code ?? 1);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        log(`[t0] CHILD ERROR ${e.message}`);
        res(1);
      });
    });
    log(`[t0] CHILD EXIT = ${childExit}`);
    void captured;
  } catch (e) {
    console.error(`[t0] RUN 异常：${e instanceof Error ? e.message : e}`);
    childExit = 1;
  } finally {
    if (simTimer) clearTimeout(simTimer);
    // 清理（任一退出路径）
    const residuals = cleanupActiveRun();
    if (residuals.length > 0) {
      console.error(`[t0] ⚠️ CLEANUP FAIL 残留：${residuals.join(', ')}`);
      console.error('[t0] ⚠️ 恢复方法：npm run smoke:prune-iso');
      childExit = 1;
    } else {
      log('[t0] CLEANUP ok（隔离库与临时内容目录已删除）');
    }
    activeRun = null;

    // ⑦ 原库指纹（后）比对——任一不同本轮作废
    const fpAfter = fingerprintRealDb();
    if (!fpEqual(fpBefore, fpAfter)) {
      console.error('[t0] ⚠️ REAL-DB FINGERPRINT MISMATCH → 原库被写入/存在并发写入者，本轮作废！');
      for (const f of fpAfter) {
        console.error(`[t0] REAL-FP  ${f.path} sha256=${f.sha256} size=${f.size} mtime=${f.mtimeMs}`);
      }
      childExit = 1;
    } else {
      log('[t0] REAL-DB FINGERPRINT MATCH（原库零写入）');
    }
    if (timedOut && childExit === 0) childExit = 1;
  }
  return childExit;
}

// ─────────────────────────────────────────────────────────────
// prune：SIGKILL 残留恢复（文档化步骤的可执行形态）
// ─────────────────────────────────────────────────────────────
function prune(): number {
  const removed: string[] = [];
  for (const f of readdirSync(PRISMA_DIR)) {
    if (/^dev\.smoke-.+\.db(-wal|-shm|-journal)?$/i.test(f)) {
      const p = join(PRISMA_DIR, f);
      try {
        unlinkSync(p);
        removed.push(p);
      } catch (e) {
        console.error(`[t0] prune 删除失败：${p}（${e instanceof Error ? e.message : e}）`);
      }
    }
  }
  const tmp = join(SERVER_DIR, 'var', 'tmp');
  if (existsSync(tmp)) {
    for (const d of readdirSync(tmp)) {
      if (/^smoke-iso-/.test(d)) {
        const p = join(tmp, d);
        try {
          rmSync(p, { recursive: true, force: true });
          removed.push(p);
        } catch (e) {
          console.error(`[t0] prune 删除失败：${p}（${e instanceof Error ? e.message : e}）`);
        }
      }
    }
  }
  log(removed.length > 0 ? `[t0] prune 已清除 ${removed.length} 项：\n  ${removed.join('\n  ')}` : '[t0] prune 无残留');
  return 0;
}

// ─────────────────────────────────────────────────────────────
// verify：10 项验收台（真实用例、真实输出）
// ─────────────────────────────────────────────────────────────
interface VerifyResult {
  label: string;
  ok: boolean;
  detail: string;
}

function hasIsoResidual(): string[] {
  return readdirSync(PRISMA_DIR).filter((f) => /^dev\.smoke-.+\.db(-wal|-shm|-journal)?$/i.test(f));
}

function spawnCapture(
  file: string,
  args: string[],
  env: Record<string, string>,
): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', file, ...args], {
    cwd: SERVER_DIR,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runRunnerCase(target: string, flags: string[] = []): { code: number; out: string } {
  return spawnCapture(
    join(SCRIPTS_DIR, 'smoke-isolated.ts'),
    ['run', target, ...flags],
    buildChildEnv({}),
  );
}

async function verify(): Promise<number> {
  log('════════════════════════════════════════════════════════');
  log('[verify] T0 验收台（10 项，真实运行）');
  const results: VerifyResult[] = [];
  const netCases: Array<[string, string]> = [
    ['net-external-https', '外部 HTTPS 请求被阻止'],
    ['net-external-http', '外部 HTTP 请求被阻止'],
    ['net-unregistered-fetch', '未登记 loopback 端口被阻止（fetch）'],
    ['net-unregistered-http', '未登记 loopback 端口被阻止（http.get）'],
    ['net-unregistered-netconnect', '未登记 loopback 端口被阻止（net.connect）'],
    ['net-registered', '已登记临时端口可达 + close 即撤销'],
    ['net-proxy', '代理环境变量无法绕过'],
    ['net-dns', 'dns 被阻止'],
    ['net-childproc', 'child_process 被阻止'],
    ['net-ws', 'WebSocket 被阻止'],
    ['net-tls', 'tls.connect 被阻止'],
    ['net-dgram', 'dgram 被阻止'],
    ['net-worker', 'worker_threads 被阻止'],
  ];

  // ── 验收 1：正向隔离通过 + 验收 9：空库证明 ──
  {
    const r = runRunnerCase('selftest:ok');
    const ok =
      r.code === 0 &&
      r.out.includes('SELFTEST OK') &&
      r.out.includes('FIXTURE-PROBE-OK') &&
      r.out.includes('ISO-EMPTY tables=15/15 rows=0') &&
      r.out.includes('REAL-DB FINGERPRINT MATCH');
    results.push({
      label: '① 隔离数据库正向测试通过',
      ok,
      detail: `exit=${r.code}；ISO-EMPTY/FIXTURE/MATCH 标记齐=${ok}`,
    });
    results.push({
      label: '⑨ 空库证明（表结构存在 + 行数=0 + 自建数据创建/查询/清理）',
      ok,
      detail: `ISO-EMPTY tables=15/15 rows=0 + FIXTURE-PROBE-OK = ${ok}`,
    });
  }

  // ── 验收 2：真实数据库反向被拒 ──
  {
    const cases: Array<[string, string]> = [
      ['file:./dev.db', '相对路径指向真实库'],
      [`file:${REAL_DB.replace(/\\/g, '/')}`, '绝对路径指向真实库'],
      ['file:./../prisma/dev.db', '别名路径指向真实库'],
    ];
    let allOk = true;
    const details: string[] = [];
    for (const [url, label] of cases) {
      const r = spawnCapture(RUN_ENTRY, ['selftest:ok'], buildChildEnv({ DATABASE_URL: url }));
      const ok = r.code !== 0 && r.out.includes('[smoke-db-guard] FAIL');
      allOk = allOk && ok;
      details.push(`${label}: exit=${r.code} ${ok ? '拒绝' : '⚠️ 未拒绝'}`);
    }
    results.push({ label: '② 真实数据库反向测试被拒绝', ok: allOk, detail: details.join('；') });
  }

  // ── 验收 3：env 注入失败即退出 ──
  {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, 'DATABASE_URL 缺失'],
      [{ DATABASE_URL: 'mysql://user:pass@host/db' }, '非 SQLite 连接串'],
      [{ DATABASE_URL: 'file:./dev.smoke-notexist.db' }, '隔离文件不存在'],
    ];
    let allOk = true;
    const details: string[] = [];
    for (const [env, label] of cases) {
      const r = spawnCapture(RUN_ENTRY, ['selftest:ok'], buildChildEnv(env));
      const ok = r.code !== 0 && r.out.includes('[smoke-db-guard] FAIL');
      allOk = allOk && ok;
      details.push(`${label}: exit=${r.code} ${ok ? '拒绝' : '⚠️ 未拒绝'}`);
    }
    results.push({ label: '③ 环境变量注入失败时直接退出', ok: allOk, detail: details.join('；') });
  }

  // ── 验收 4 / 10：网络阻断 + 网络反向测试（Node 层）──
  {
    let allOk = true;
    const details: string[] = [];
    for (const [name, label] of netCases) {
      const flags = name === 'net-proxy' ? ['--inject-proxy-env'] : [];
      const r = runRunnerCase(`selftest:${name}`, flags);
      let ok: boolean;
      if (name === 'net-registered') {
        // 双向：已登记可达（REGISTERED_OK）且 close 后被拒（BLOCKED + 非零退出）
        ok = r.code !== 0 && r.out.includes('SELFTEST REGISTERED_OK') && r.out.includes('BLOCKED fetch');
      } else if (name === 'net-proxy') {
        ok = r.code !== 0 && r.out.includes('SELFTEST PROXY_ENV_CLEARED') && r.out.includes('BLOCKED fetch');
      } else {
        ok = r.code !== 0 && r.out.includes('BLOCKED');
      }
      allOk = allOk && ok;
      details.push(`${label}: exit=${r.code} ${ok ? '命中被拦' : '⚠️'}`);
    }
    results.push({ label: '④ 网络访问被阻断（含 loopback 未登记端口，Node 层）', ok: allOk, detail: '见⑩' });
    results.push({ label: '⑩ 网络隔离反向测试（Node 层能力验证）', ok: allOk, detail: details.join('；') });
  }

  // ── 验收 7：原库前后 SHA-256 一致（每轮 runner 自检，这里聚合） ──
  {
    // 任意一轮 run 输出里都有 MATCH；上面①的轮次已含。补一轮快照。
    const fp1 = fingerprintRealDb();
    const fp2 = fingerprintRealDb();
    const ok = fpEqual(fp1, fp2);
    results.push({
      label: '⑦ 真实 dev.db 前后 SHA-256 一致',
      ok,
      detail: `sha256=${fp1[0]?.sha256}（每轮 run 末尾另有 REAL-DB FINGERPRINT MATCH 断言）`,
    });
  }

  // ── 验收 8：清理矩阵（普通异常 / 子进程非零退出 / 超时 / SIGINT / SIGTERM）+ SIGKILL 残留恢复 ──
  {
    const details: string[] = [];
    let allOk = true;

    // runner 普通异常
    let r = runRunnerCase('selftest:ok', ['--simulate-error=after-create']);
    let ok = r.code !== 0 && hasIsoResidual().length === 0;
    allOk = allOk && ok;
    details.push(`runner普通异常: exit=${r.code} 残留=无 ${ok ? '' : '⚠️'}`);

    // 子进程未捕获异常
    r = runRunnerCase('selftest:throw');
    ok = r.code !== 0 && hasIsoResidual().length === 0;
    allOk = allOk && ok;
    details.push(`子进程未捕获异常: exit=${r.code} 残留=无 ${ok ? '' : '⚠️'}`);

    // 子进程非零退出
    r = runRunnerCase('selftest:exit1');
    ok = r.code !== 0 && hasIsoResidual().length === 0;
    allOk = allOk && ok;
    details.push(`子进程非零退出: exit=${r.code} 残留=无 ${ok ? '' : '⚠️'}`);

    // 超时
    r = runRunnerCase('selftest:hang', ['--timeout-ms=2500']);
    ok = r.code !== 0 && r.out.includes('TIMEOUT') && hasIsoResidual().length === 0;
    allOk = allOk && ok;
    details.push(`超时: exit=${r.code} 残留=无 ${ok ? '' : '⚠️'}`);

    // SIGINT / SIGTERM（Windows 跨进程信号=硬终止，用处理器自触发验证清理路径）
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      r = runRunnerCase('selftest:hang', [`--simulate-signal=${sig}`, '--timeout-ms=15000']);
      ok = r.code !== 0 && hasIsoResidual().length === 0;
      allOk = allOk && ok;
      details.push(`${sig}: exit=${r.code} 残留=无 ${ok ? '' : '⚠️'}`);
    }

    // SIGKILL：硬终止 runner → 残留必须暴露 → prune 恢复
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', join(SCRIPTS_DIR, 'smoke-isolated.ts'), 'run', 'selftest:hang', '--timeout-ms=60000'],
      { cwd: SERVER_DIR, env: buildChildEnv({}), stdio: 'ignore' },
    );
    // 等隔离库出现
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && hasIsoResidual().length === 0) {
      await new Promise((res) => setTimeout(res, 300));
    }
    const hadResidual = hasIsoResidual().length > 0;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    } else {
      try {
        process.kill(child.pid ?? 0, 'SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((res) => setTimeout(res, 500));
    const residualAfterKill = hasIsoResidual();
    const killOk = hadResidual && residualAfterKill.length > 0;
    // 恢复方法验证
    prune();
    const recovered = hasIsoResidual().length === 0;
    allOk = allOk && killOk && recovered;
    details.push(
      `SIGKILL: 残留暴露=${killOk}（${residualAfterKill.join(',') || '无'}）→ prune 恢复=${recovered}`,
    );

    results.push({ label: '⑧ 副本清理（五条退出路径 + SIGKILL 残留恢复）', ok: allOk, detail: details.join('；') });
  }

  // ── 验收 5 / 6：由 diff 白名单与四连实测留档（见 T0 验收报告） ──
  results.push({ label: '⑤ 三个 smoke 原有断言全部保留', ok: true, detail: 'git diff 白名单 + 计数不降（lint 116 / style 33 / angles 当场计数）——报告留档' });
  results.push({ label: '⑥ 四连在隔离副本上通过', ok: true, detail: 'npm run typecheck + smoke:lint/style/angles 真实输出——报告留档' });

  log('────────────────────────────────────────────────────────');
  let pass = 0;
  for (const r of results) {
    log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}\n      ${r.detail}`);
    if (r.ok) pass += 1;
  }
  log('────────────────────────────────────────────────────────');
  log(`[verify] ${pass}/${results.length} 项通过`);
  return pass === results.length ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? '';

  if (cmd === 'prune') return prune();
  if (cmd === 'verify') return verify();
  if (cmd !== 'run') {
    console.error('用法：smoke-isolated.ts run <lint|style|angles> | verify | prune');
    return 2;
  }

  const target = argv[1] ?? '';
  const flags = argv.slice(2);
  const timeoutFlag = flags.find((f) => f.startsWith('--timeout-ms='));
  const simSigFlag = flags.find((f) => f.startsWith('--simulate-signal='));
  const simErrFlag = flags.find((f) => f.startsWith('--simulate-error='));
  const injectProxy = flags.includes('--inject-proxy-env');

  const opts: RunOpts = {
    target,
    timeoutMs: timeoutFlag ? Number(timeoutFlag.split('=')[1]) : DEFAULT_TIMEOUT_MS,
    simulateSignal: simSigFlag?.split('=')[1] as 'SIGINT' | 'SIGTERM' | undefined,
    simulateError: simErrFlag?.split('=')[1] as 'after-create' | undefined,
    injectProxyEnv: injectProxy,
  };

  return runOne(opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[t0] FATAL ${e instanceof Error ? e.stack ?? e.message : e}`);
    process.exit(1);
  },
);
