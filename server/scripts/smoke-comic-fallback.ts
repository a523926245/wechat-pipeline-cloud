/**
 * 漫画产线「生图备选通道」冒烟：MCP 传输 + 同心跳降级（t7/t8/t9）。
 *
 * 单进程起 app + 假 MCP 上游，跑完自清理。验证点：
 *  1) MCP 传输走完整握手：POST /gradio_api/mcp/ 先 initialize 再 tools/call，带 SSE Accept 头；
 *  2) 备选通道取回图片字节并识别格式（PNG）；
 *  3) comic_panel 主通道失败时，同心跳自动切 comic_panel_fallback 并成功返回；
 *  4) 备选角色未绑定时，降级不生效，抛主通道的错误；
 *  5) 假上游收到的请求命中 2-0-pro studio MCP 路径（协议形态断言）。
 *
 * 跑法：
 *   npm run smoke:comic-fallback
 */

import { createServer } from 'node:http';

import { prisma } from '../src/db.ts';
import { generateImage } from '../src/services/llm.ts';
import { countForeignModels, deleteSmokeModels, SMOKE_PREFIX } from './smoke-utils.ts';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

// ── 假 MCP 上游：MCP 走 JSON-RPC over SSE，REST 走 gradio call 流 ──
const mcpPaths: string[] = [];
let mcpAccepts: string[] = [];
let sawBearer = false;
let failNextTool = false;
let failRest = true;

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const url = req.url ?? '';
    mcpPaths.push(url);
    mcpAccepts.push(String(req.headers.accept ?? ''));
    if (String(req.headers.authorization ?? '').startsWith('Bearer ')) sawBearer = true;

    // REST gradio 流：主通道（comic_panel）走这条；failRest 时返回 500 逼出降级
    if (url.includes('/gradio_api/call/')) {
      if (failRest) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const dataDst = `data:image/png;base64,${TINY_PNG_B64}`;
      const isResultStream = /\/gradio_api\/call\/[^/]+\/.+/.test(url);
      res.setHeader('Content-Type', isResultStream ? 'text/event-stream' : 'application/json');
      if (isResultStream) {
        res.write(`event: complete\ndata: ${JSON.stringify([dataDst, 0, 'x'])}\n\n`);
      } else {
        res.write(JSON.stringify({ event_id: 'smoke-evt-1' }));
      }
      res.end();
      return;
    }
    if (url.includes('/gradio_api/file=')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(TINY_PNG_B64, 'base64'));
      return;
    }

    let msg: { id?: number | string; method?: string } = {};
    try {
      msg = JSON.parse(body) as typeof msg;
    } catch {
      /* ignore */
    }

    if (msg.id === undefined) {
      // 通知（notifications/*）：MCP 规范要求 202；这里回空 200 即可。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Mcp-Session-Id', 'smoke-session-1');
    let result: unknown;
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', serverInfo: { name: 'Gradio', version: '1.29.0' }, capabilities: {} };
    } else if (msg.method === 'tools/call') {
      if (failNextTool) {
        result = { isError: true, content: [{ type: 'text', text: '模拟服务端生成失败' }] };
      } else {
        result = { content: [{ type: 'image', data: TINY_PNG_B64 }] };
      }
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'generate_image' }] };
    } else {
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n\n`);
      res.end();
      return;
    }
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    res.end();
  });
});

async function createSmokeModel(
  name: string,
  protocol: string,
  baseUrl: string,
): Promise<number> {
  const created = await prisma.llmModel.create({
    data: {
      name,
      vendor: 'modelscope',
      protocol,
      capability: 'image',
      baseUrl,
      modelId: `${name}-id`,
      apiKeyEnc: '',
      apiKeyMask: 'smoke****',
      enabled: true,
      paramsJson: '{}',
    },
  });
  return created.id;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = (upstream.address() as { port: number }).port;
  const base = `http://127.0.0.1:${upPort}`;

  try {
    await deleteSmokeModels();
    const foreign = await countForeignModels();
    if (foreign > 0) {
      throw new Error(`库里还有 ${foreign} 个非冒烟模型；请先清空模型表再跑。`);
    }

    const { encryptSecret } = await import('../src/lib/crypto.ts');
    const key = 'sk-SMOKE-MCP-KEY';
    const mcpId = await createSmokeModel(`${SMOKE_PREFIX}-MCP备选`, 'modelscope_qwen_image_mcp', base);
    await prisma.llmModel.update({ where: { id: mcpId }, data: { apiKeyEnc: encryptSecret(key) } });

    const mcpModel = await prisma.llmModel.findUniqueOrThrow({ where: { id: mcpId } });

    // 1) MCP 传输 + 握手 + 取图
    mcpPaths.length = 0;
    mcpAccepts = [];
    const img = await generateImage(mcpModel, '一只蓝色的猫', { genWidth: 64, genHeight: 64 });
    check('MCP 传输命中 /gradio_api/mcp/ 路径', mcpPaths.length > 0 && mcpPaths.every((p) => p === '/gradio_api/mcp/'), mcpPaths.join(','));
    check('MCP 请求带 SSE Accept 头', mcpAccepts.every((a) => a.includes('text/event-stream')), mcpAccepts[0] ?? '');
    check('MCP 请求带 Bearer 鉴权', sawBearer, `bearer=${sawBearer}`);
    check('MCP 握手 ≥2 次（initialize + tools/call）', mcpPaths.length >= 2, `n=${mcpPaths.length}`);
    check('MCP 取回 PNG 字节', img.ext === 'png' && img.bytes.length > 0, `ext=${img.ext} len=${img.bytes.length}`);

    // 2) 降级语义：主通道（同 base，但 REST 路径，404）失败 → 同心跳切备选（MCP）
    const restId = await createSmokeModel(`${SMOKE_PREFIX}-REST主通道`, 'modelscope_qwen_image', base);
    await prisma.llmModel.update({ where: { id: restId }, data: { apiKeyEnc: encryptSecret(key) } });
    await prisma.modelBinding.create({ data: { role: 'comic_panel', modelId: restId } });
    await prisma.modelBinding.create({ data: { role: 'comic_panel_fallback', modelId: mcpId } });

    const { tryResolveForRole } = await import('../src/services/llm.ts');
    const fb = await tryResolveForRole('comic_panel_fallback');
    check('备选角色绑定后可用', fb.usable && fb.model?.id === mcpId, `usable=${fb.usable} reason=${fb.reason ?? ''}`);

    // 真表驱动 processComicImages：主通道 REST 会 404，验证同心跳降级后该格成功
    const { processComicImages } = await import('../src/services/comic/panels.ts');
    const article = await prisma.article.create({
      data: {
        title: '冒烟备选通道文章',
        contentHtml: '<p>x</p>',
        pushDate: '2026-10-21',
        pipeline: 'comic',
        status: 'draft',
        idempotencyKey: `smoke-fallback-${Date.now()}`,
      },
    });
    await prisma.comicPanel.create({
      data: { articleId: article.id, seq: 1, prompt: '一只蓝色的猫', status: 'pending' },
    });
    mcpPaths.length = 0;
    const run = await processComicImages(article.id, { limit: 1 });
    const panelAfter = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: article.id, seq: 1 } });
    check(
      '同心跳降级：主通道失败 → 备选生成成功',
      run.done === 1 && panelAfter.status === 'success' && mcpPaths.some((p) => p === '/gradio_api/mcp/'),
      `done=${run.done} status=${panelAfter.status} mcpHits=${mcpPaths.length} detail=${run.details[0]?.message ?? ''}`,
    );

    // 主通道自己成功时，备选通道必须一次都不被调用（comic_panel 仍绑 REST，令其 200）
    failRest = false;
    const okArticle = await prisma.article.create({
      data: {
        title: '冒烟主通道成功文章',
        contentHtml: '<p>x</p>',
        pushDate: '2026-10-21',
        pipeline: 'comic',
        status: 'draft',
        idempotencyKey: `smoke-primary-ok-${Date.now()}`,
      },
    });
    await prisma.comicPanel.create({
      data: { articleId: okArticle.id, seq: 1, prompt: '一只绿色的狗', status: 'pending' },
    });
    const mcpBefore = mcpPaths.filter((p) => p === '/gradio_api/mcp/').length;
    const okRun = await processComicImages(okArticle.id, { limit: 1 });
    const okPanel = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: okArticle.id, seq: 1 } });
    const mcpAfter = mcpPaths.filter((p) => p === '/gradio_api/mcp/').length;
    check(
      '主通道成功时降级不触发（零 MCP 命中、detail 无备选标记）',
      okRun.done === 1 && okPanel.status === 'success' && mcpAfter === mcpBefore && !String(okRun.details[0]?.message ?? '').includes('备选'),
      `done=${okRun.done} status=${okPanel.status} mcpHitsDelta=${mcpAfter - mcpBefore} detail=${okRun.details[0]?.message ?? ''}`,
    );
    failRest = true;

    // 3) 未绑定备选时：降级不生效（主通道错误直接抛出）
    await prisma.modelBinding.deleteMany({ where: { role: 'comic_panel_fallback' } });
    await prisma.modelBinding.deleteMany({ where: { role: 'comic_panel' } });
    const fbUnbound = await tryResolveForRole('comic_panel_fallback');
    check('备选未绑定时 unusable', !fbUnbound.usable, `reason=${fbUnbound.reason ?? ''}`);

    // MCP isError 归一为可识别错误
    await prisma.modelBinding.create({ data: { role: 'comic_panel_fallback', modelId: mcpId } });
    failNextTool = true;
    let errMsg = '';
    try {
      await generateImage(mcpModel, 'x', {});
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    check('MCP isError 归一为可识别错误', errMsg.includes('isError') || errMsg.includes('未取回图片'), errMsg.slice(0, 120));
    failNextTool = false;

    // t9(3) 双 500 → 格子失败，且仅按既有 attempt 语义（无新增重试环）
    await prisma.modelBinding.deleteMany({ where: {} });
    await prisma.modelBinding.create({ data: { role: 'comic_panel', modelId: restId } });
    await prisma.modelBinding.create({ data: { role: 'comic_panel_fallback', modelId: mcpId } });
    failRest = true;
    failNextTool = true;
    const bothArticle = await prisma.article.create({
      data: {
        title: '冒烟双通道失败文章',
        contentHtml: '<p>x</p>',
        pushDate: '2026-10-21',
        pipeline: 'comic',
        status: 'draft',
        idempotencyKey: `smoke-both-fail-${Date.now()}`,
      },
    });
    await prisma.comicPanel.create({
      data: { articleId: bothArticle.id, seq: 1, prompt: '一只黄色的鸟', status: 'pending' },
    });
    const bothRun = await processComicImages(bothArticle.id, { limit: 1 });
    const bothPanel = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: bothArticle.id, seq: 1 } });
    check(
      '双通道失败：格子失败且 attempt 仅 +1（无新增重试环）',
      bothRun.failed === 1 && bothPanel.status !== 'success' && bothPanel.attempt === 1,
      `failed=${bothRun.failed} status=${bothPanel.status} attempt=${bothPanel.attempt}`,
    );
    failNextTool = false;

    // t9(4) 未绑定 fallback 时 primary 500 行为 = 基线（不因降级改变尝试语义）
    await prisma.modelBinding.deleteMany({ where: { role: 'comic_panel_fallback' } });
    const baseArticle = await prisma.article.create({
      data: {
        title: '冒烟未绑定基线文章',
        contentHtml: '<p>x</p>',
        pushDate: '2026-10-21',
        pipeline: 'comic',
        status: 'draft',
        idempotencyKey: `smoke-unbound-${Date.now()}`,
      },
    });
    await prisma.comicPanel.create({
      data: { articleId: baseArticle.id, seq: 1, prompt: '一只紫色的鱼', status: 'pending' },
    });
    const baseRun = await processComicImages(baseArticle.id, { limit: 1 });
    const basePanel = await prisma.comicPanel.findFirstOrThrow({ where: { articleId: baseArticle.id, seq: 1 } });
    check(
      '未绑定备选：primary 失败按基线落 errorMsg、attempt=1',
      baseRun.failed === 1 && basePanel.status !== 'success' && basePanel.attempt === 1 && basePanel.errorMsg.length > 0,
      `failed=${baseRun.failed} status=${basePanel.status} attempt=${basePanel.attempt} err=${basePanel.errorMsg.slice(0, 60)}`,
    );
  } finally {
    await deleteSmokeModels();
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
