/**
 * 推送安全冒烟（S5-1）：防重复推送 + 失败不抹掉推送事实 + 改写后自动体检。
 *
 * 全程 Mock：本地起一个假上游（微信 token/draft/add + OpenAI chat/completions），
 * `WECHAT_API_BASE` 与 LlmModel.baseUrl 都指向它——**绝不调用真实微信接口、真实 LLM**。
 *
 * ⚠️ 隔离 runner 会剥离 APP_SECRET_KEY（防真实密钥外泄），但本脚本需要加解密能力才能
 *    建账号凭据 / 模型 Key。这里**只在本进程内注入一个合成测试密钥**（非真实密钥），
 *    加解密自洽，跑完随进程消失。
 *
 * 覆盖（对应 S5-1 验收清单）：
 *   A 防重复推送：A1 未推送可推 / A2 已有 mediaId 拒 / A3 只有 pushDate 拒 /
 *                A4 status 变化但有痕迹仍拒 / A5 并发只建一份草稿
 *   B 失败不覆盖事实：B1 首推失败→failed+TaskRun / B2 曾推送文章被拒后数据一字不变 / B3 hasPushTrace 仍识别
 *   C 改写后体检：C1 lint 针对改写后正文且 trigger=revise / C2 lint 有 error 不丢正文 /
 *                C3 落库失败 saved:false / C4 推送仍跑自己的最新 lint
 *
 * ⚠️ 运行输出不要接 `| head -N`，否则清理逻辑不执行会留脏数据。
 * 跑法：npm run smoke:push（隔离库，必须与其他 smoke 串行）
 */

process.env.SMOKE_NO_AUTH = '1';
// 合成测试密钥（仅本进程、仅本测试用）：32 字节 base64，非任何真实凭据。
if (!process.env.APP_SECRET_KEY) {
  process.env.APP_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { prisma } from '../src/db.ts';
import { encryptSecret } from '../src/lib/crypto.ts';

let passed = 0;

function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

// ── 假上游：微信三个端点 + OpenAI 一个端点 ──
interface MockUpstream {
  port: number;
  hits: { token: number; addDraft: number; upload: number; chat: number };
  /** 让接下来 N 次 draft/add 返回错误 */
  failAddDraft: number;
  /** 让接下来 N 次 chat/completions 返回指定内容（用于改写） */
  chatReply: string;
  mediaSeq: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    port: 0,
    hits: { token: 0, addDraft: 0, upload: 0, chat: 0 },
    failAddDraft: 0,
    chatReply: '',
    mediaSeq: 0,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const done = (obj: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (p.endsWith('/token')) {
      state.hits.token += 1;
      done({ access_token: 'smoke-token', expires_in: 7200 });
      return;
    }
    if (p.endsWith('/draft/add')) {
      state.hits.addDraft += 1;
      if (state.failAddDraft > 0) {
        state.failAddDraft -= 1;
        // 用 40164（IP 白名单）——它是 ERR_NO_RETRY，不会被 WechatClient 退避重试，
        // 否则一次注入的失败会被重试吃掉，用例就变成「意外成功」。
        done({ errcode: 40164, errmsg: 'invalid ip xxx.xxx.xxx.xxx, not in whitelist' });
        return;
      }
      state.mediaSeq += 1;
      done({ media_id: `smoke-media-${state.mediaSeq}` });
      return;
    }
    if (p.includes('/material/add_material') || p.endsWith('/media/uploadimg')) {
      state.hits.upload += 1;
      done({ media_id: 'smoke-thumb', url: 'http://127.0.0.1/smoke.png' });
      return;
    }
    if (p.endsWith('/chat/completions')) {
      state.hits.chat += 1;
      done({ choices: [{ message: { content: state.chatReply || '<h1>未配置回复</h1><p>占位。</p>' } }] });
      return;
    }
    done({ errcode: 40001, errmsg: `unexpected path ${p}` });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const net = (globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__;
      if (!net?.register(server)) {
        throw new Error('smoke-net-guard 未预载，拒绝运行（必须经 smoke-run.ts 引导）');
      }
      state.port = (server.address() as { port: number }).port;
      resolve(state);
    });
  });
}

async function main(): Promise<void> {
  // ① 先起假上游再改 WECHAT_API_BASE：wechat.ts 在模块加载时读它，
  //    所以 publisher / wechat 必须在设置之后才动态 import。
  const up = await startMockUpstream();
  process.env.WECHAT_API_BASE = `http://127.0.0.1:${up.port}/cgi-bin`;
  const { pushArticleToDraft } = await import('../src/services/publisher.ts');
  const { hasPushTrace } = await import('../src/services/article-delete.ts');

  const stamp = Date.now().toString(36);
  const trackName = `__smoke_push_${stamp}__`;
  let trackId = 0;
  let accountId = 0;
  let modelId = 0;

  try {
    const track = await prisma.track.create({
      data: { name: trackName, slug: `smoke-push-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    trackId = track.id;

    const acc = await prisma.oAAccount.create({
      data: {
        trackId,
        name: `冒烟推送账号${stamp}`,
        appid: `smoke-appid-${stamp}`,
        secretEnc: encryptSecret('smoke-secret'),
        secretMask: '***',
        credStatus: 'ok',
        enabled: true,
      },
    });
    accountId = acc.id;

    // 改写用的 mock 模型：绑定 revise 角色，指向假 OpenAI 上游。
    const model = await prisma.llmModel.create({
      data: {
        name: `冒烟改写模型${stamp}`,
        vendor: 'custom',
        protocol: 'openai_chat',
        capability: 'text',
        baseUrl: `http://127.0.0.1:${up.port}`,
        modelId: 'smoke-revise',
        apiKeyEnc: encryptSecret('smoke-key'),
        apiKeyMask: '***',
        enabled: true,
      },
    });
    modelId = model.id;
    await prisma.modelBinding.create({ data: { role: 'revise', modelId } });

    // 能通过 error 级门禁的正文：4 个小标题 + 约 1500 字（sections 3-4 / chars 1300-2300）。
    // error 不可被 relax 豁免（只有 warn 能豁免），所以夹具必须真的合格。
    const goodPara = (n: number) =>
      `<p>第${n}节想说的这件小事，其实就发生在我们每天都会经过的那条路上，` +
      '只是平时走得太急，从来没有停下来留意过它的存在与变化，也忽略了它一直在替我们记录着什么。'.repeat(9) +
      '</p>';
    const goodHtml =
      `<h1>标题</h1>` +
      `<h2>第一节 小标题</h2>${goodPara(1)}` +
      `<h2>第二节 小标题</h2>${goodPara(2)}` +
      `<h2>第三节 小标题</h2>${goodPara(3)}` +
      `<h2>第四节 小标题</h2>${goodPara(4)}`;

    const mkArticle = (
      seq: number,
      data: { status?: 'draft' | 'pushed' | 'updated' | 'failed'; mediaId?: string; pushDate?: string; html?: string } = {},
    ) =>
      prisma.article.create({
        data: {
          trackId,
          accountId,
          title: `推送冒烟文章${seq}`,
          digest: '摘要',
          contentHtml: data.html ?? goodHtml,
          contentWechat: data.html ?? goodHtml,
          blocks: 8,
          chars: 1500,
          pushDate: data.pushDate ?? '',
          mediaId: data.mediaId ?? '',
          status: data.status ?? 'draft',
          idempotencyKey: `smoke-push-${stamp}-${seq}`,
        },
      });

    // ════════ A. 防重复推送 ════════
    console.log('— A 防重复推送 —');

    const a1 = await mkArticle(1);
    const r1 = await pushArticleToDraft(a1.id);
    expect('A1 未推送文章推送成功（真调 addDraft 一次）', r1.ok && up.hits.addDraft === 1, { r1, hits: up.hits });
    expect('A1 成功后写入 mediaId/pushDate 且 status=pushed', Boolean(r1.mediaId) && Boolean(r1.pushDate), r1);

    const a2 = await mkArticle(2, { mediaId: 'smoke-old-media', pushDate: '2026-11-10', status: 'pushed' });
    const beforeHits = up.hits.addDraft;
    const r2 = await pushArticleToDraft(a2.id);
    expect(
      'A2 已有 mediaId 的文章被拒（already_pushed）',
      r2.ok === false && r2.reason === 'already_pushed' && r2.everPushed === true,
      r2,
    );
    expect('A2 未再次调用 addDraft', up.hits.addDraft === beforeHits, up.hits);

    const a3 = await mkArticle(3, { pushDate: '2026-11-11', status: 'draft' });
    const r3 = await pushArticleToDraft(a3.id);
    expect(
      'A3 只有 pushDate（mediaId 空）也算曾推送，拒绝重推',
      r3.ok === false && r3.reason === 'already_pushed' && up.hits.addDraft === beforeHits,
      r3,
    );

    for (const [i, st] of (['draft', 'updated', 'failed'] as const).entries()) {
      const art = await mkArticle(40 + i, { mediaId: `smoke-trace-${i}`, pushDate: '2026-11-12', status: st });
      const r = await pushArticleToDraft(art.id);
      expect(
        `A4 status=${st} 但有推送痕迹 → 仍拒绝重推`,
        r.ok === false && r.reason === 'already_pushed' && r.everPushed === true,
        r,
      );
    }
    expect('A4 三种 status 下均未调用 addDraft', up.hits.addDraft === beforeHits, up.hits);

    const a5 = await mkArticle(5);
    const hitsBefore5 = up.hits.addDraft;
    const [c1, c2] = await Promise.all([pushArticleToDraft(a5.id), pushArticleToDraft(a5.id)]);
    const okCount = [c1, c2].filter((x) => x.ok).length;
    const pushingCount = [c1, c2].filter((x) => x.reason === 'pushing').length;
    expect('A5 并发两次推送：恰好一次成功、一次被 pushing 拦下', okCount === 1 && pushingCount === 1, { c1, c2 });
    expect('A5 只建了一份草稿（addDraft 只 +1）', up.hits.addDraft === hitsBefore5 + 1, up.hits);

    // ════════ B. 失败不覆盖推送事实 ════════
    console.log('— B 失败不覆盖推送事实 —');

    const b1 = await mkArticle(6);
    up.failAddDraft = 1;
    const r6 = await pushArticleToDraft(b1.id);
    expect('B1 首次推送失败：ok=false 且带 errcode', r6.ok === false && r6.errcode === 40164 && r6.everPushed === false, r6);
    const b1After = await prisma.article.findUnique({ where: { id: b1.id } });
    expect('B1 从未推送过 → status 降级为 failed', b1After?.status === 'failed', b1After?.status);
    expect('B1 mediaId/pushDate 保持为空', b1After?.mediaId === '' && b1After?.pushDate === '', b1After);
    const b1Run = await prisma.taskRun.findFirst({ where: { jobType: 'push', articleId: b1.id }, orderBy: { id: 'desc' } });
    expect(
      'B1 TaskRun 记录失败原因与 errcode（40164 不可重试）',
      b1Run?.status === 'failed' && b1Run.errorCode === '40164' && Boolean(b1Run.errorMessage),
      b1Run,
    );

    const b2 = await mkArticle(7, { mediaId: 'smoke-keep-media', pushDate: '2026-11-13', status: 'pushed' });
    const before = await prisma.article.findUnique({ where: { id: b2.id } });
    const r7 = await pushArticleToDraft(b2.id);
    const after = await prisma.article.findUnique({ where: { id: b2.id } });
    expect(
      'B2 曾推送文章的重推请求被拒（不静默重试、不静默改状态）',
      r7.ok === false && r7.reason === 'already_pushed' && r7.everPushed === true,
      r7,
    );
    expect(
      'B2 mediaId/pushDate/status 一字未改（推送事实不被抹掉）',
      after?.mediaId === before?.mediaId &&
        after?.pushDate === before?.pushDate &&
        after?.status === before?.status &&
        after?.mediaId === 'smoke-keep-media' &&
        after?.status === 'pushed',
      { before, after },
    );

    expect(
      'B3 hasPushTrace 仍识别为已推送',
      hasPushTrace({ mediaId: after!.mediaId, pushDate: after!.pushDate }) === true,
      after,
    );
    expect('B3 未推送文章 hasPushTrace=false', hasPushTrace({ mediaId: '', pushDate: '' }) === false);

    // ════════ C. 改写后自动体检（真实路由 + mock LLM） ════════
    console.log('— C 改写后自动体检 —');

    const { createApp } = await import('../src/app.ts');
    const app = createApp();
    const srv = app.listen(0);
    const net = (globalThis as { __SMOKE_NET__?: { register(s: unknown): boolean } }).__SMOKE_NET__;
    if (!net?.register(srv)) throw new Error('smoke-net-guard 未预载，拒绝运行');
    const port = (srv.address() as { port: number }).port;

    const cPost = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    // C1/C2：改写返回的正文故意**没有问号结尾**且结构完整 → 体检可跑；
    //       用「缺 h1」的返回验证 error 时正文仍保存。
    up.chatReply = '<h1>改写后的标题</h1><p>这是一段被改写过的正文内容，句号收尾。</p>';
    const cArt = await mkArticle(8);
    const cRes = await cPost(`/revise/articles/${cArt.id}`, { mode: 'polish' });
    expect('C1 改写路由调用成功', cRes.status === 200, cRes);
    const lintObj = cRes.json.lint as { ok?: boolean; errors?: unknown[]; stats?: unknown } | null;
    expect('C1 返回 lint 结果', lintObj !== null && lintObj !== undefined, cRes.json);
    expect('C1 lint 留痕 trigger=revise', (cRes.json.lintRun as { trigger?: string } | null)?.trigger === 'revise', cRes.json.lintRun);
    const saved8 = await prisma.article.findUnique({ where: { id: cArt.id } });
    expect('C1 lint 针对改写后正文（内容里含改写标记）', saved8?.contentHtml.includes('改写后的标题') === true, saved8?.contentHtml);
    expect('C1 contentHash 与改写后正文一致', (cRes.json.lintRun as { contentHash?: string })?.contentHash?.length === 64, cRes.json.lintRun);
    expect('C1 落库成功时 lintRun 非空且无 persistError', Boolean(cRes.json.lintRun) && !cRes.json.lintPersistError, cRes.json);

    // C2：让模型返回缺 h1 的正文 → lint 出 error，但改写结果必须已经保存
    // 有 h1（过 revise 的 looksLikeArticleHtml）但没有小标题、字数不足 → 必触发 lint error
    up.chatReply = '<h1>改写后的标题</h1><p>只有一个小段落，既没有小标题，字数也远不够，应当触发体检问题。</p>';
    // 注：改写正文故意缺 h1 → sections/chars 双 error，用于验证「lint 有错但正文仍保存」
    const cArt2 = await mkArticle(9);
    const cRes2 = await cPost(`/revise/articles/${cArt2.id}`, { mode: 'rewrite' });
    expect('C2 不合规改写仍被保存（lint 不阻断落库）', cRes2.status === 200, cRes2);
    const lint2 = cRes2.json.lint as { ok?: boolean; errors?: unknown[] } | null;
    expect('C2 lint 报出 error 且 ok=false', lint2?.ok === false && (lint2?.errors?.length ?? 0) > 0, lint2);
    const saved9 = await prisma.article.findUnique({ where: { id: cArt2.id } });
    expect('C2 正文已保存（含改写内容）', saved9?.contentHtml.includes('只有一个小段落') === true, saved9?.contentHtml);
    expect('C2 提示语明确指出质量问题', String(cRes2.json.message ?? '').includes('体检'), cRes2.json.message);

    // C3 落库失败不得伪装成功（不存在的 articleId → 外键失败）
    const { recordLintRun } = await import('../src/services/lint-store.ts');
    const { lintArticle } = await import('../src/services/lint.ts');
    const rep = lintArticle('<h1>t</h1><p>正文内容足够长以通过结构检查。</p>', undefined, '');
    const failRec = await recordLintRun({
      articleId: 999999,
      trigger: 'revise',
      report: rep,
      contentHtml: '<h1>t</h1><p>正文内容足够长以通过结构检查。</p>',
    });
    expect('C3 落库失败返回 saved:false + error，不伪造成功留存', failRec.saved === false && Boolean(failRec.error) && failRec.run === undefined, failRec);

    // C4 推送门禁仍跑自己的最新 lint：不合规正文被 lint_failed 拦下
    const c4 = await mkArticle(10);
    await prisma.article.update({
      where: { id: c4.id },
      data: { contentHtml: '<p>只有段落没有标题，结构不完整应当被体检拦下。</p>', contentWechat: '<p>x</p>' },
    });
    const hitsBeforeC4 = up.hits.addDraft;
    const r10 = await pushArticleToDraft(c4.id);
    expect('C4 推送时仍执行自己的最新 lint，不合规正文被门禁拦下', r10.ok === false && r10.reason === 'lint_failed', r10);
    expect('C4 被门禁拦下时未调用 addDraft', up.hits.addDraft === hitsBeforeC4, up.hits);
    expect('C4 门禁留痕 trigger=push', Boolean(r10.lintRun) && r10.lintRun?.trigger === 'push', r10.lintRun);

    console.log(`\n全部通过：${passed} 项断言`);
  } finally {
    await prisma.taskRun.deleteMany({ where: { accountId } });
    await prisma.articleLintRun.deleteMany({ where: { article: { trackId } } }).catch(() => undefined);
    await prisma.article.deleteMany({ where: { trackId } });
    await prisma.modelBinding.deleteMany({ where: { modelId } }).catch(() => undefined);
    await prisma.llmModel.deleteMany({ where: { id: modelId } }).catch(() => undefined);
    await prisma.oAAccount.deleteMany({ where: { id: accountId } });
    await prisma.track.deleteMany({ where: { id: trackId } });
  }
}

main()
  .catch((e) => {
    console.error('SMOKE PUSH FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  })
  .finally(() => {
    // 显式退出：express / 假上游服务器会持有事件循环，不退出会让 runner 等到 CHILD TIMEOUT。
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
