/**
 * 漫画产线「创意层对齐」冒烟：两阶段方向生成 + 风格硬锁（t3/t4）。
 *
 * 单进程起 app + 假上游，跑完自清理。验证点：
 *  1) generateCreativeDirections 先调一次 LLM，解析 3 组方向，采纳标记 recommended 的那组；
 *  2) generateComicScript 第二阶段注入已选方向，且 LLM 被调用 ≥2 次、顺序为「方向 → 脚本」；
 *  3) 模型未标记推荐时回落到第 1 组（不抛错）；
 *  4) 风格硬锁：即便传入 styleKey=guoman_flat，产物 styleKey 仍是 defaultStyle；
 *  5) 末单元金句候选确实进了第二阶段 prompt。
 *
 * 跑法：
 *   npm run smoke:comic-align
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { createServer } from 'node:http';

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { loadComicTemplates } from '../src/services/comic/script.ts';
import { countForeignModels, deleteSmokeModels, SMOKE_PREFIX } from './smoke-utils.ts';

const KEY = 'sk-SMOKE-PLAINTEXT-KEY-DO-NOT-LEAK';

// ── 假上游：按请求体里的标志词分派「方向」/「脚本」两种响应 ──
const DIRECTION_JSON = JSON.stringify({
  directions: [
    {
      dimension: '反常识',
      title: '方向A',
      thesis: '立意A',
      candidateTitles: ['标题A1', '标题A2', '标题A3'],
      closingLine: '金句A',
      recommended: false,
    },
    {
      dimension: '后果警示',
      title: '方向B',
      thesis: '立意B',
      candidateTitles: ['标题B1', '标题B2'],
      closingLine: '末单元升华金句B',
      recommended: true,
      recommendReason: '推荐维度好、贴合度高、情绪落点强',
    },
    {
      dimension: '情感共鸣',
      title: '方向C',
      thesis: '立意C',
      candidateTitles: ['标题C1'],
      closingLine: '金句C',
      recommended: false,
    },
  ],
});

function scriptJson(dimension: string): string {
  const units = Array.from({ length: 6 }, (_, i) => ({
    headline: `论点${i + 1}(${dimension})`,
    elaboration: `阐释${i + 1}`,
    scene: `场景${i + 1}`,
    characters: i === 0 ? ['son12'] : [],
    bubble: `台词${i + 1}`,
    bubblePos: '右上方',
    spatial: '',
  }));
  return JSON.stringify({ title: `方向${dimension}标题`, digest: '摘要', units });
}

const llmCalls: string[] = [];
let marker: 'recommended' | 'none' = 'recommended';

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    let content: string;
    // 方向阶段 system prompt 独有「产出 3 组差异化创意方向」；脚本阶段注入的 user prompt
    // 含「已选定的创意方向」，故不能拿「创意方向」判阶段——用这条独有短语。
    if (body.includes('产出 3 组差异化创意方向')) {
      llmCalls.push('direction');
      content = marker === 'none' ? DIRECTION_JSON.replace('"recommended":true', '"recommended":false') : DIRECTION_JSON;
    } else {
      llmCalls.push('script');
      const m = body.match(/方向标题：方向([A-Z])/);
      content = scriptJson(m?.[1] ?? '?');
    }
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

    const text = await call('POST', '/models', {
      name: `${SMOKE_PREFIX}-漫画脚本模型`,
      vendor: 'openai',
      protocol: 'openai_chat',
      capability: 'text',
      baseUrl: base,
      modelId: 'smoke-comic',
      apiKey: KEY,
    });
    check('创建漫画脚本模型 201', text.status === 201, `status=${text.status} ${text.text.slice(0, 120)}`);
    const textId = text.json?.id as number;

    const bind = await call('PUT', '/models/bindings/comic_script', { modelId: textId });
    check('绑定 comic_script 角色 200', bind.status === 200, `status=${bind.status} ${bind.text.slice(0, 120)}`);

    // ── 直接驱动服务层（不经 API 路由，聚焦两阶段语义）──
    const { generateCreativeDirections, generateComicScript } = await import('../src/services/comic/script.ts');

    const angle = { id: 1, theme: '主题X', content: '角度X' } as never;
    const track = { id: 1, name: '冒烟漫画赛道' } as never;

    // 1. 方向阶段：采纳 recommended=true（第 2 组）
    llmCalls.length = 0;
    const dir = await generateCreativeDirections(angle, track, {});
    check('方向阶段恰好调用 1 次 LLM', llmCalls.filter((c) => c === 'direction').length === 1, llmCalls.join(','));
    check('解析出 3 组方向', dir.directions.length === 3, `n=${dir.directions.length}`);
    check('采纳 recommended 组（index=1 方向B）', dir.selectedIndex === 1 && dir.selected.title === '方向B',
      `idx=${dir.selectedIndex} title=${dir.selected.title}`);

    // 2. 脚本阶段：两阶段顺序 + 方向注入
    llmCalls.length = 0;
    const tpl = loadComicTemplates();
    const script = await generateComicScript(angle, track, { styleKey: 'guoman_flat' });
    check('全流程调用顺序为 direction→script',
      llmCalls.length >= 2 && llmCalls[0] === 'direction' && llmCalls[1] === 'script', llmCalls.join(','));
    check('产物标题带上已选方向（方向B）', script.title.includes('B'), `title=${script.title}`);
    check('产物 6 单元', script.units.length === 6, `n=${script.units.length}`);

    // 3. 风格硬锁：传入 guoman_flat 仍被锁成 defaultStyle
    check('风格硬锁为 defaultStyle',
      script.styleKey === tpl.defaultStyle, `got=${script.styleKey} expect=${tpl.defaultStyle}`);

    // 4. 未标记推荐 → 回落第 1 组，不抛错
    marker = 'none';
    llmCalls.length = 0;
    const dir2 = await generateCreativeDirections(angle, track, {});
    check('无推荐标记时回落第 1 组', dir2.selectedIndex === 0, `idx=${dir2.selectedIndex}`);
    marker = 'recommended';

    // 5. 末单元金句候选 进第二阶段 prompt
    const { buildUserPrompt } = await import('../src/services/comic/script.ts');
    const up = buildUserPrompt(angle, track, {}, tpl, dir.selected);
    check('第二阶段 prompt 含末单元金句候选', up.includes('末单元升华金句B'), up.slice(0, 0) || 'found');
    check('第二阶段 prompt 含切入维度', up.includes('后果警示'));
  } finally {
    await deleteSmokeModels();
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
