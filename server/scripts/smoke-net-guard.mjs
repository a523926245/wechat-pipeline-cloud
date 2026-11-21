/**
 * T0 网络守卫（第 1 层：Node 进程内网络入口隔离）——由 smoke-isolated.ts 经
 * `node --import ./scripts/smoke-net-guard.mjs …` 预载，先于一切模块执行。
 *
 * 能力边界（诚实声明，T0-SAFETY-SUPPLEMENT.md v3 Q4）：
 *   本守卫是「已覆盖并验证的 Node 网络入口隔离」，**不宣称 OS 级全网络隔离**。
 *   纯 JS 包装无法证明封锁了所有出网路径（原生扩展直调系统网络栈不在覆盖范围内）。
 *
 * 封堵面（命中即抛错；网络面命中额外把进程退出码钉死为非零）：
 *   ① HTTP 家族：globalThis.fetch（undici 底层）与 http/https 的 request/get
 *      各自独立封装（互不覆盖），各自反向验证；
 *   ② 低层套接字：net.connect/createConnection、net.Socket.prototype.connect、
 *      tls.connect、dgram.Socket.prototype.bind/send、globalThis.WebSocket；
 *   ③ 旁路通道（fail-closed）：dns.*（含 promises 与 Resolver 实例）、child_process.*、
 *      worker_threads.Worker。唯一例外：dns.lookup / promises.lookup 的**数值 IP 字面量**
 *      在调用栈内**同步短路回调**（不委派原函数）——Node 的 Server.listen→lookupAndListen
 *      无条件走 dns.lookup 且回调恒异步，同步短路才能恢复冒烟脚本依赖的同步 bind
 *      语义（listen 后立即 address() 取端口）；等价 getaddrinfo 数值短路、零解析流量。
 *      域名照旧命中抛错（net-dns 反例不变）。
 *   ④ 代理绕过封死：预载时清除 HTTP(S)_PROXY/ALL_PROXY/NOPROXY，封装层只按目标地址判定。
 *
 * 自建临时端口白名单（6 条规则，v3 收紧）：
 *   1. 只允许数值 loopback 绑定（127.0.0.1 / ::1）；listen 未指定 host 时强制改绑 127.0.0.1
 *      （同步 bind 语义由 dns 数值同步短路保证，见③）；
 *   2. 只允许 listen(0)（系统分配临时端口），显式端口直接拒绝；
 *   3. bind 成功后才登记：经 server.address() 取实际端口登记（__SMOKE_NET__.register）；
 *   4. 出站请求归一化（localhost / ::ffff: 别名先归一）后必须精确命中登记项；
 *      connect 系强制改写 options.lookup 为仅数值直通（禁别名），实际连接地址恒等于匹配地址；
 *   5. server.close() 调用即撤销登记；
 *   6. 无任何手工放行入口（不实现 SMOKE_NET_ALLOW）。
 *
 * child_process 命中策略（与 v3 文案的实测差异，见 T0 验收报告「与设计差异」）：
 *   抛错拒绝执行，但不把进程退出码钉死——src/logger.ts 在 win32 下 import 时会
 *   execSync('chcp 65001')（自带 try/catch 降级），是已知的本地无网络能力调用；
 *   该调用同样被拒绝执行（不真的跑子进程），只是不让它把整轮冒烟打成失败。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 0. 代理环境变量清除（封装层不读代理配置，只按目标地址判定） ──
for (const k of [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NOPROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]) {
  try {
    delete process.env[k];
  } catch {
    /* 忽略 */
  }
}

// ── 登记表：归一化后的 `ip:port` 精确键 ──
const registry = new Set();

/** 归一化目标主机：localhost/::ffff: 映射先归一，再精确比对（规则 4）。 */
function normalizeIp(raw) {
  let h = String(raw ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return '127.0.0.1';
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (m) return m[1];
  return h;
}

function hit(entry, detail, hard = true) {
  const msg = `[smoke-net-guard] BLOCKED ${entry} → ${detail}`;
  console.error(msg);
  if (hard) {
    // 即便调用方 try/catch 吞掉错误，进程退出码也必须非零（命中即测试失败）
    process.exitCode = 1;
  }
  throw new Error(msg);
}

function checkTarget(entry, host, port) {
  const ip = normalizeIp(host);
  if (ip === '0.0.0.0' || ip === '::') {
    hit(entry, `非法目标地址 ${host}`);
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    hit(entry, `非法目标端口 ${port}`);
  }
  const key = `${ip}:${n}`;
  if (!registry.has(key)) {
    hit(entry, `未登记端点 ${key}（仅放行本进程自绑临时端口）`);
  }
}

// ── 1. 全局 fetch（undici 底层，与 http.request 互不覆盖，入口各自封） ──
const origFetch = globalThis.fetch;
if (typeof origFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    try {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
      url = new URL(href);
    } catch {
      hit('fetch', `无法解析目标 URL：${String(input)}`);
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
    checkTarget('fetch', url.hostname, port);
    return origFetch.call(this, input, init);
  };
}

// ── 2. http / https 家族（request/get 分别封装） ──
function wrapHttpFamily(mod, name) {
  const origRequest = mod.request;
  const origGet = mod.get;
  function parseTarget(args) {
    const a0 = args[0];
    if (typeof a0 === 'string' || a0 instanceof URL) {
      const u = new URL(a0);
      const opts = args[1] && typeof args[1] === 'object' ? args[1] : {};
      const host = opts.hostname || opts.host || u.hostname;
      const port = Number(opts.port || u.port || (u.protocol === 'https:' ? 443 : 80));
      return { host, port };
    }
    const opts = a0 && typeof a0 === 'object' ? a0 : {};
    const host = opts.hostname || opts.host || 'localhost';
    const port = Number(opts.port || (name === 'https' ? 443 : 80));
    return { host, port };
  }
  mod.request = function guardedRequest(...args) {
    const t = parseTarget(args);
    checkTarget(`${name}.request`, t.host, t.port);
    return origRequest.apply(this, args);
  };
  mod.get = function guardedGet(...args) {
    const t = parseTarget(args);
    checkTarget(`${name}.get`, t.host, t.port);
    return origGet.apply(this, args);
  };
}

// ── 3. net / tls / dgram ──
function parseConnectArgs(args) {
  const a0 = args[0];
  if (a0 && typeof a0 === 'object') {
    if (a0.path) return { path: a0.path };
    return { host: a0.host || 'localhost', port: Number(a0.port || 0) };
  }
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { host, port: Number(a0) };
}

function guardConnectArgs(entry, args) {
  const t = parseConnectArgs(args);
  if (t.path) {
    hit(entry, `unix 域套接字不允许：${t.path}`);
  }
  checkTarget(entry, t.host, t.port);
}

// ── 4. dns / child_process / worker_threads（旁路通道，fail-closed） ──
const DNS_FNS = [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
];

// ── 组装封装（经 createRequire 改 CJS exports + 原型方法，ESM 命名导入同样命中） ──
{
  const http = require('node:http');
  wrapHttpFamily(http, 'http');
  const https = require('node:https');
  wrapHttpFamily(https, 'https');

  const net = require('node:net');

  // 出站强制 lookup（规则 4 收口）：connect 系支持自定义 options.lookup，若不覆盖，
  // 调用方可把已通过精确匹配的数值 host 重定向解析到任意地址。强制改写 lookup 为
  // 仅数值直通（非数值即命中抛错）：实际连接地址恒等于匹配地址，别名无从产生。
  function numericOnlyLookup(host, _opts, cb) {
    const family = net.isIP(host);
    if (!family) {
      hit('connect.lookup', `非数值 host 不允许（禁别名，规则 4）：${String(host)}`);
    }
    cb(null, host, family);
  }
  function forceNumericLookupArgs(args) {
    const a0 = args[0];
    const rest = args.slice(1);
    const cb = rest.find((a) => typeof a === 'function');
    if (a0 && typeof a0 === 'object') {
      const o = { ...a0, lookup: numericOnlyLookup };
      return cb ? [o, cb] : [o];
    }
    let host;
    for (const a of rest) {
      if (typeof a === 'string') host = a;
    }
    const o = { port: a0, host: host ?? '127.0.0.1', lookup: numericOnlyLookup };
    return cb ? [o, cb] : [o];
  }

  const origConnect = net.connect;
  const origCreateConnection = net.createConnection;

  // Node 内部（net.connect → socket.connect）会传 normalizeArgs 预归一化的
  // [options, cb] 数组（带 normalizedArgsSymbol）；先展开成常规参数形态再校验/改写，
  // 否则数组被当作 options 对象、.port 取不到而误杀（实测 undici/fetch 路径命中）。
  function unwrapNormalizedArgs(args) {
    return Array.isArray(args[0]) ? args[0] : args;
  }

  net.connect = function guardedConnect(...args) {
    args = unwrapNormalizedArgs(args);
    guardConnectArgs('net.connect', args);
    return origConnect.apply(this, forceNumericLookupArgs(args));
  };
  net.createConnection = function guardedCreateConnection(...args) {
    args = unwrapNormalizedArgs(args);
    guardConnectArgs('net.createConnection', args);
    return origCreateConnection.apply(this, forceNumericLookupArgs(args));
  };
  const origSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    args = unwrapNormalizedArgs(args);
    guardConnectArgs('net.Socket.prototype.connect', args);
    return origSocketConnect.apply(this, forceNumericLookupArgs(args));
  };

  // listen 规则 1/2：仅数值 loopback、仅 listen(0)；未指定 host 强制改绑 127.0.0.1。
  // 登记不在这里做——登记是显式动作（规则 3，见 __SMOKE_NET__.register）。
  //
  // 同步 bind 语义（实测差异修正，见 T0 验收报告）：Node 带 host 的 listen 走
  // lookupAndListen → dns.lookup（回调恒异步，且**无视** options.lookup），bind 被
  // 推迟，listen() 返回时 server.address() 为 null；而冒烟脚本沿用原生无 host
  // listen(0) 的同步 bind 语义（listen 后立即 address() 取端口）。由 dns 包装层的
  // 数值同步短路恢复同步 bind（见下方 dns 段），此处只做规则 1/2 校验与 host 强制。
  let coerced = false;
  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    if (args[0] && typeof args[0] === 'object') {
      const o = args[0];
      if (o.path) hit('net.Server.listen', `unix 域套接字不允许：${o.path}`);
      if (o.port !== 0) hit('net.Server.listen', `只允许 listen(0)（规则 2），收到 port=${o.port}`);
      if (o.host === undefined || o.host === null) {
        o.host = '127.0.0.1';
        if (!coerced) {
          coerced = true;
          console.error('[smoke-net-guard] listen(0) 未指定 host → 强制绑定 127.0.0.1（规则 1）');
        }
      } else if (o.host !== '127.0.0.1' && o.host !== '::1') {
        hit('net.Server.listen', `只允许数值 loopback 绑定（规则 1），收到 host=${o.host}`);
      }
    } else {
      const port = args[0];
      if (port !== 0) hit('net.Server.listen', `只允许 listen(0)（规则 2），收到 port=${port}`);
      let host;
      let cb;
      let backlog;
      for (const a of args.slice(1)) {
        if (typeof a === 'function') cb = a;
        else if (typeof a === 'string') host = a;
        else if (typeof a === 'number') backlog = a;
      }
      if (host === undefined) {
        if (!coerced) {
          coerced = true;
          console.error('[smoke-net-guard] listen(0) 未指定 host → 强制绑定 127.0.0.1（规则 1）');
        }
      } else if (host !== '127.0.0.1' && host !== '::1') {
        hit('net.Server.listen', `只允许数值 loopback 绑定（规则 1），收到 host=${host}`);
      }
      // 重写为 options 形式统一入口（positional 形式 host 缺省语义不一）
      const opts = { port: 0, host: host ?? '127.0.0.1' };
      if (backlog !== undefined) opts.backlog = backlog;
      args = cb ? [opts, cb] : [opts];
    }
    return origListen.apply(this, args);
  };
  const origClose = net.Server.prototype.close;
  net.Server.prototype.close = function guardedClose(...args) {
    try {
      const addr = this.address();
      if (addr && typeof addr === 'object') {
        registry.delete(`${normalizeIp(addr.address)}:${addr.port}`);
      }
    } catch {
      /* 未绑定服务关闭时 address() 可能抛错，忽略 */
    }
    return origClose.apply(this, args);
  };

  const tls = require('node:tls');
  const origTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    guardConnectArgs('tls.connect', args);
    return origTlsConnect.apply(this, forceNumericLookupArgs(args));
  };

  const dgram = require('node:dgram');
  const origBind = dgram.Socket.prototype.bind;
  const origSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.bind = function guardedBind(...args) {
    hit('dgram.Socket.prototype.bind', 'UDP 不在冒烟放行范围');
    return origBind.apply(this, args);
  };
  dgram.Socket.prototype.send = function guardedSend(...args) {
    hit('dgram.Socket.prototype.send', 'UDP 不在冒烟放行范围');
    return origSend.apply(this, args);
  };

  const dns = require('node:dns');
  // lookup 数值 IP 同步短路（详见文件头③）：Server.listen→lookupAndListen 无条件走
  // dns.lookup 且回调恒异步（即便数值 IP），bind 被推迟导致 listen() 返回时
  // server.address() 为 null，破坏冒烟脚本同步取端口语义（原生无 host listen(0)
  // 是同步 bind）。对数值 host 在调用栈内同步回调恢复同步 bind——与 getaddrinfo
  // 数值短路语义等价、零解析流量。域名照旧命中抛错（net-dns 反例不变）；
  // 数值 host 但无回调的调用交原函数报标准错误。
  function numericLookupSyncCb(args) {
    const host = args[0];
    const family = net.isIP(host);
    const a1 = args[1];
    const opts = a1 && typeof a1 === 'object' ? a1 : typeof a1 === 'number' ? { family: a1 } : {};
    const cb = args[args.length - 1];
    if (opts.family && opts.family !== 0 && opts.family !== family) {
      cb(Object.assign(new Error(`EAI_ADDRFAMILY: 地址族不匹配 ${host}`), { code: 'EAI_ADDRFAMILY' }));
      return;
    }
    if (opts.all === true) cb(null, [{ address: host, family }]);
    else cb(null, host, family);
  }
  function numericLookupSyncPromise(args) {
    const host = args[0];
    const family = net.isIP(host);
    const a1 = args[1];
    const opts = a1 && typeof a1 === 'object' ? a1 : {};
    if (opts.family && opts.family !== 0 && opts.family !== family) {
      return Promise.reject(Object.assign(new Error(`EAI_ADDRFAMILY: 地址族不匹配 ${host}`), { code: 'EAI_ADDRFAMILY' }));
    }
    const entry = { address: host, family };
    return Promise.resolve(opts.all === true ? [entry] : entry);
  }
  const isNumericHost = (v) => typeof v === 'string' && net.isIP(v) !== 0;
  for (const fn of DNS_FNS) {
    if (typeof dns[fn] !== 'function') continue;
    const orig = dns[fn];
    dns[fn] = function guardedDns(...args) {
      if (fn === 'lookup' && isNumericHost(args[0]) && typeof args[args.length - 1] === 'function') {
        numericLookupSyncCb(args);
        return;
      }
      hit(`dns.${fn}`, `DNS 不在冒烟放行范围：${String(args[0] ?? '')}`);
      return orig.apply(this, args);
    };
  }
  if (dns.promises) {
    for (const fn of DNS_FNS) {
      if (typeof dns.promises[fn] !== 'function') continue;
      const orig = dns.promises[fn];
      dns.promises[fn] = function guardedDnsPromises(...args) {
        if (fn === 'lookup' && isNumericHost(args[0])) {
          return numericLookupSyncPromise(args);
        }
        hit(`dns.promises.${fn}`, `DNS 不在冒烟放行范围：${String(args[0] ?? '')}`);
        return orig.apply(this, args);
      };
    }
  }
  // Resolver 实例（c-ares 独立通道）同样 fail-closed：lookup/getaddrinfo 系仅模块级存在，其余全封。
  for (const Resolver of [dns.Resolver, dns.promises?.Resolver]) {
    if (typeof Resolver !== 'function' || !Resolver.prototype) continue;
    for (const fn of DNS_FNS) {
      if (fn === 'lookup' || fn === 'lookupService') continue;
      const orig = Resolver.prototype[fn];
      if (typeof orig !== 'function') continue;
      Resolver.prototype[fn] = function guardedResolverDns(...args) {
        hit(`dns.Resolver.${fn}`, `DNS 不在冒烟放行范围：${String(args[0] ?? '')}`);
        return orig.apply(this, args);
      };
    }
  }

  const cp = require('node:child_process');
  // child_process 命中：抛错拒绝执行，但不钉死退出码（见文件头说明）。
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    if (typeof cp[fn] !== 'function') continue;
    const orig = cp[fn];
    cp[fn] = function guardedChildProcess(...args) {
      hit(`child_process.${fn}`, `子进程不在冒烟放行范围：${String(args[0] ?? '')}`, false);
      return orig.apply(this, args);
    };
  }

  const wt = require('node:worker_threads');
  const OrigWorker = wt.Worker;
  wt.Worker = class GuardedWorker extends OrigWorker {
    constructor(...args) {
      hit('worker_threads.Worker', '独立执行上下文不在冒烟放行范围');
      super(...args);
    }
  };

  if (typeof globalThis.WebSocket === 'function') {
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = function GuardedWebSocket(url) {
      hit('WebSocket', String(url));
      return new OrigWS(url);
    };
  }
}

// ── 5. 登记 API（规则 3：bind 成功后登记实际端口；先过隔离标记再登记） ──
globalThis.__SMOKE_NET__ = {
  /**
   * 登记「本进程自绑的临时端口」。调用方 = 冒烟脚本里 app.listen(0) 之后的胶水行。
   * @returns {true} 成功返回 true（胶水行用 `??` 判定守卫缺失）
   */
  register(server) {
    if (process.env.__SMOKE_ISO_OK__ !== '1') {
      throw new Error(
        '[smoke-net-guard] 拒绝端口登记：隔离守卫未通过（未经 smoke-run.ts 引导，或 db 守卫失败）',
      );
    }
    const addr = server && typeof server.address === 'function' ? server.address() : null;
    if (!addr || typeof addr === 'string') {
      throw new Error('[smoke-net-guard] 拒绝端口登记：服务尚未 bind 成功（规则 3）');
    }
    const ip = normalizeIp(addr.address);
    if (ip !== '127.0.0.1' && ip !== '::1') {
      throw new Error(`[smoke-net-guard] 拒绝端口登记：非数值 loopback 绑定 ${addr.address}（规则 1）`);
    }
    const key = `${ip}:${addr.port}`;
    registry.add(key);
    console.error(`[smoke-net-guard] REGISTERED ${key}`);
    return true;
  },
  registered() {
    return [...registry];
  },
};

console.error(`[smoke-net-guard] loaded（Node 层网络入口隔离，非 OS 级全网络隔离）pid=${process.pid}`);
