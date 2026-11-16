/**
 * T0 引导入口（子进程唯一入口）。初始化次序由构造保证（Q3'）：
 *
 *   1. runner（smoke-isolated.ts）建隔离库、注入 DATABASE_URL 并回读断言；
 *   2. spawn：node --import ./scripts/smoke-net-guard.mjs --experimental-strip-types scripts/smoke-run.ts <target>
 *      （--import 预载网守，先于一切模块）；
 *   3. 本文件**只静态 import** smoke-db-guard.ts（守卫仅用 fs/path/url/process）；
 *   4. 守卫执行路径断言，通过后才 `await import()` 动态加载测试模块；
 *   5. 测试模块的静态依赖（含 src/db.ts → PrismaClient）此时才加载。
 *
 * ⚠️ 禁止把测试模块改为静态 import —— 那会让 PrismaClient 早于守卫加载，防护失效。
 *
 * <target>：
 *   lint | style | angles | bulk → 动态 import ./smoke-<target>.ts（标准冒烟 + 批量删除）
 *   selftest:<name>              → 内置自检（verify:smoke-iso 的验收用例，见下）
 */

import { assertIsolatedDatabase } from './smoke-db-guard.ts';

function die(msg: string): never {
  console.error(`[smoke-run] FAIL ${msg}`);
  process.exit(1);
}

// ── 1. 守卫先于一切测试模块（含 db.ts） ──
try {
  assertIsolatedDatabase();
} catch (e) {
  die(`db 守卫未通过：${e instanceof Error ? e.message : String(e)}`);
}

const target = process.argv[2] ?? '';

// ── 2a. 内置自检（verify:smoke-iso 验收用例） ──
if (target.startsWith('selftest:')) {
  const name = target.slice('selftest:'.length);
  await runSelftest(name);
  process.exit(0);
}

// ── 2b. 标准冒烟：校验目标名后动态 import（PrismaClient 此时才加载） ──
const TARGET_MODULE: Record<string, string> = {
  lint: './smoke-lint.ts',
  style: './smoke-style-prompts.ts',
  angles: './smoke-angles.ts',
  // S4-4-1：批量删除冒烟原本直跑（会连到 .env 的业务库），改为经本运行器走隔离库。
  bulk: './smoke-bulk-delete.ts',
};
if (!/^[a-z][a-z0-9-]*$/.test(target)) {
  die(`非法 target：${target}`);
}
const modPath = TARGET_MODULE[target];
if (!modPath) {
  die(`未知 target：${target}（只允许 lint | style | angles | bulk）`);
}
console.log(`[smoke-run] import ${modPath} …`);
await import(modPath);

// ─────────────────────────────────────────────────────────────
// selftest 实现。网络类用例**故意不捕获守卫抛错**——命中即非零退出是验收项。
// ─────────────────────────────────────────────────────────────
async function runSelftest(name: string): Promise<void> {
  console.log(`SELFTEST ${name} START`);

  switch (name) {
    case 'ok': {
      // 正向对照：守卫放行 + 自建数据可创建/查询/清理（空库证明第 5 环）
      const { prisma } = await import('../src/db.ts');
      await prisma.setting.create({ data: { k: '__smoke_iso_probe__', v: '1' } });
      const got = await prisma.setting.findUnique({ where: { k: '__smoke_iso_probe__' } });
      if (got?.v !== '1') throw new Error('fixture 查询失败');
      await prisma.setting.delete({ where: { k: '__smoke_iso_probe__' } });
      await prisma.$disconnect();
      console.log('SELFTEST FIXTURE-PROBE-OK');
      console.log('SELFTEST OK');
      return;
    }

    case 'throw':
      throw new Error('selftest: 模拟未捕获异常');

    case 'exit1':
      console.log('SELFTEST EXIT3');
      process.exit(3);

    case 'hang':
      console.log('SELFTEST HANG');
      // 裸 await 不算活跃句柄，进程会以 code 13 自退——必须留定时器保活事件循环，
      // 同时永不 resolve（否则回到入口的 process.exit(0)），直到 runner 超时/信号收割。
      setInterval(() => {
        /* keep-alive */
      }, 1000);
      await new Promise(() => {
        /* hang */
      });
      return;

    // ── 网络反向测试（Node 层能力验证）──
    case 'net-external-https': {
      await fetch('https://example.com/', { signal: AbortSignal.timeout(5000) });
      throw new Error('selftest: 外部 HTTPS 竟然放行了');
    }
    case 'net-external-http': {
      await fetch('http://example.com/', { signal: AbortSignal.timeout(5000) });
      throw new Error('selftest: 外部 HTTP 竟然放行了');
    }
    case 'net-unregistered-fetch': {
      await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(5000) });
      throw new Error('selftest: 未登记 loopback 端口竟然放行了');
    }
    case 'net-unregistered-http': {
      const http = await import('node:http');
      http.get('http://127.0.0.1:8787/health');
      throw new Error('selftest: http.get 未登记端口竟然放行了');
    }
    case 'net-unregistered-netconnect': {
      const net = await import('node:net');
      net.connect({ host: '127.0.0.1', port: 8787 });
      throw new Error('selftest: net.connect 未登记端口竟然放行了');
    }
    case 'net-registered': {
      // 已登记临时端口可达 → close 撤销后拒绝（规则 3/5 双向验证）
      const http = await import('node:http');
      const server = http.createServer((_req, res) => {
        res.end('ok');
      });
      server.listen(0);
      const reg = (globalThis as Record<string, unknown>).__SMOKE_NET__ as {
        register(s: unknown): boolean;
      };
      reg.register(server);
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      if (res.status !== 200) throw new Error('selftest: 已登记端口访问异常');
      console.log('SELFTEST REGISTERED_OK');
      server.close();
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      throw new Error('selftest: close 后端口竟然仍放行');
    }
    case 'net-proxy': {
      // ① 预载时代理 env 必须已被清除（runner 注入过 HTTP_PROXY 证明是守卫清的）
      const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
      const left = names.filter((n) => process.env[n]);
      if (left.length > 0) throw new Error(`selftest: 代理 env 未清除：${left.join(',')}`);
      console.log('SELFTEST PROXY_ENV_CLEARED');
      // ② 运行时再设代理也不能绕过（封装层不读代理配置，只按目标判定）
      process.env.HTTP_PROXY = 'http://127.0.0.1:65002';
      process.env.ALL_PROXY = 'http://127.0.0.1:65002';
      await fetch('http://example.com/', { signal: AbortSignal.timeout(5000) });
      throw new Error('selftest: 代理竟然绕过了网络封堵');
    }
    case 'net-dns': {
      const dns = await import('node:dns');
      dns.lookup('example.com', () => undefined);
      throw new Error('selftest: dns.lookup 竟然放行了');
    }
    case 'net-childproc': {
      const cp = await import('node:child_process');
      cp.spawn('node', ['-v']);
      throw new Error('selftest: child_process.spawn 竟然放行了');
    }
    case 'net-ws': {
      new WebSocket('ws://127.0.0.1:8787');
      throw new Error('selftest: WebSocket 竟然放行了');
    }
    case 'net-tls': {
      const tls = await import('node:tls');
      tls.connect({ host: '127.0.0.1', port: 8787 });
      throw new Error('selftest: tls.connect 竟然放行了');
    }
    case 'net-dgram': {
      const dgram = await import('node:dgram');
      const sock = dgram.createSocket('udp4');
      sock.bind(0);
      throw new Error('selftest: dgram.bind 竟然放行了');
    }
    case 'net-worker': {
      const wt = await import('node:worker_threads');
      new wt.Worker('console.log(1)', { eval: true });
      throw new Error('selftest: worker_threads.Worker 竟然放行了');
    }

    default:
      die(`未知 selftest：${name}`);
  }
}
