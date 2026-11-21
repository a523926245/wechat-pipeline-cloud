/**
 * 漫画 QC「逐字核对」冒烟（t5）。
 *
 * 单进程起 app + 假上游；用隔离 SQLite DB 运行。验证点：
 *  1) QC 请求 payload 含该格期望台词原文，且含「逐字」核对指令；
 *  2) VLM 判不合格 → 该格进入重跑（attempt+1、status=pending）；
 *  3) 连续不合格到上限 → status=failed（不无限循环）；
 *  4) QC 判定 ok → status=success；QC 通道异常（非 JSON）→ 降级放行（success）。
 *
 * 跑法（需隔离 DB）：DATABASE_URL=file:./var/smoke-comic-qc.db npm run smoke:comic-qc
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { createServer } from 'node:http';

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { countForeignModels, deleteSmokeModels, SMOKE_PREFIX } from './smoke-utils.ts';

const KEY = 'sk-SMOKE-PLAINTEXT-KEY-DO-NOT-LEAK';

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const EXPECTED_LINE = '逐字核对测试台词';

/** QC 返回模式：fail=不合格、ok=合格、garbage=非 JSON（测降级放行）。 */
let qcMode: 'fail' | 'ok' | 'garbage' = 'fail';
const qcPayloads: string[] = [];

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if ((req.url ?? '').includes('/images/generations')) {
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
      return;
    }
    qcPayloads.push(body);
    let content: string;
    if (qcMode === 'ok') content = '{"ok":true}';
    else if (qcMode === 'garbage') content = '我觉得这张图还行（没给 JSON）';
    else content = '{"ok":false,"reason":"气泡台词写成了「逐字核对测试台词」少了最后一个字","category":"漏字"}';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = (upstream.address() as { port: number }).port;
  const base = `http://127.0.0.1:${upPort}/v1`;

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const api = `http://127.0.0.1:${port}/api`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any; text: string }> {
    const resp = await fetch(`${api}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 时保留 text */
    }
    return { status: resp.status, json, text };
  }

  try {
    await deleteSmokeModels();
    const foreign = await countForeignModels();
    if (foreign > 0) {
      throw new Error(`库里还有 ${foreign} 个非冒烟模型；本脚本只回收「${SMOKE_PREFIX}」前缀的行，请先清空模型表再跑。`);
    }

    // 生图模型（comic_panel）——agnes_image 走 images/generations
    const img = await call('POST', '/models', {
      name: `${SMOKE_PREFIX}-漫画生图`,
      vendor: 'agnes',
      protocol: 'agnes_image',
      capability: 'image',
      baseUrl: base,
      modelId: 'smoke-image',
      apiKey: KEY,
      paramsJson: { size: '2K', ratio: '21:9' },
    });
    check('创建生图模型 201', img.status === 201, `status=${img.status} ${img.text.slice(0, 100)}`);
    const imgId = img.json?.id as number;

    // QC 模型（revise 角色，multimodal）——openai_chat 走 chat/completions
    const qc = await call('POST', '/models', {
      name: `${SMOKE_PREFIX}-QC读图`,
      vendor: 'openai',
      protocol: 'openai_chat',
      capability: 'multimodal',
      baseUrl: base,
      modelId: 'smoke-qc',
      apiKey: KEY,
    });
    check('创建 multimodal QC 模型 201', qc.status === 201, `status=${qc.status} ${qc.text.slice(0, 100)}`);
    const qcId = qc.json?.id as number;

    const bindImg = await call('PUT', '/models/bindings/comic_panel', { modelId: imgId });
    check('绑定 comic_panel 200', bindImg.status === 200, `status=${bindImg.status}`);
    const bindQc = await call('PUT', '/models/bindings/revise', { modelId: qcId });
    check('绑定 revise(QC) 200', bindQc.status === 200, `status=${bindQc.status} ${bindQc.text.slice(0, 100)}`);

    // 建漫画文章 + N 格（含期望台词）
    const track = await prisma.track.create({ data: { name: '冒烟QC赛道', slug: 'smoke-comic-qc', quotaPerDay: 1 } });
    const article = await prisma.article.create({
      data: {
        title: '冒烟QC文章',
        digest: '摘要',
        contentHtml: '<h1>标题</h1><h2>论点一</h2><p>阐释一</p>',
        contentWechat: '',
        trackId: track.id,
        pipeline: 'comic',
        status: 'draft',
        pushDate: '',
        idempotencyKey: `smoke-qc-${Date.now()}`,
        comicJson: JSON.stringify({ genWidth: 2624, genHeight: 1472, maxAttemptsPerPanel: 2 }),
      },
    });

    const { processComicImages } = await import('../src/services/comic/panels.ts');

    async function resetPanel(): Promise<void> {
      await prisma.comicPanel.deleteMany({ where: { articleId: article.id } });
      await prisma.comicPanel.create({
        data: { articleId: article.id, seq: 1, prompt: '场景描述', lines: EXPECTED_LINE, status: 'pending' },
      });
    }

    // ── 场景 1：QC 不合格 → 重跑（attempt+1、pending）──
    await resetPanel();
    qcMode = 'fail';
    qcPayloads.length = 0;
    const r1 = await processComicImages(article.id);
    const p1 = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: article.id, seq: 1 } });
    check('QC 不合格 → 本格失败计入 failed', r1.failed >= 1, `failed=${r1.failed} done=${r1.done}`);
    check('QC 不合格 → attempt+1 且回 pending', p1.attempt === 1 && p1.status === 'pending',
      `attempt=${p1.attempt} status=${p1.status}`);
    check('QC 请求 payload 含期望台词原文', qcPayloads.some((p) => p.includes(EXPECTED_LINE)), `payloads=${qcPayloads.length}`);
    // 注意：不能断言 includes('逐字')——期望台词本身含「逐字」（逐字核对测试台词）会造成假阳性。
    // 断言只可能来自 QC 指令体的独有短语「逐字比对」。
    check('QC 请求 payload 含逐字比对指令', qcPayloads.some((p) => p.includes('逐字比对')),
      qcPayloads[0] ? qcPayloads[0].slice(0, 120) : 'no payload');
    check('QC 判定类别随 reason 带回', p1.errorMsg.includes('漏字'),
      p1.errorMsg.slice(0, 80));

    // ── 场景 2：连续不合格到上限（maxAttempts=2）→ failed 终态 ──
    // attempt 已=1；退避窗口内需等待，直接改为到期再跑第二轮。
    await prisma.comicPanel.updateMany({ where: { articleId: article.id }, data: { updatedAt: new Date(Date.now() - 3600_000) } });
    qcMode = 'fail';
    await processComicImages(article.id);
    const p2 = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: article.id, seq: 1 } });
    check('连续不合格达上限 → status=failed（不无限循环）', p2.status === 'failed' && p2.attempt >= 2,
      `attempt=${p2.attempt} status=${p2.status}`);

    // ── 场景 3：QC 合格 → success ──
    await resetPanel();
    qcMode = 'ok';
    const r3 = await processComicImages(article.id);
    const p3 = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: article.id, seq: 1 } });
    check('QC 合格 → status=success', p3.status === 'success' && r3.done >= 1, `status=${p3.status} done=${r3.done}`);

    // ── 场景 4：QC 通道异常（非 JSON）→ 降级放行（success）──
    await resetPanel();
    qcMode = 'garbage';
    const r4 = await processComicImages(article.id);
    const p4 = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: article.id, seq: 1 } });
    check('QC 非 JSON 异常 → 降级放行 success（不阻塞产线）', p4.status === 'success' && r4.done >= 1,
      `status=${p4.status} done=${r4.done}`);
  } finally {
    await deleteSmokeModels();
    const arts = await prisma.article.findMany({ where: { title: '冒烟QC文章' }, select: { id: true } });
    for (const a of arts) {
      await prisma.comicPanel.deleteMany({ where: { articleId: a.id } });
      await prisma.article.delete({ where: { id: a.id } });
    }
    await prisma.track.deleteMany({ where: { slug: 'smoke-comic-qc' } });
    server.close();
    upstream.close();
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exitCode = 1;
});
