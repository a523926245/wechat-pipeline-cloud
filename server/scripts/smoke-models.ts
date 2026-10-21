/**
 * 模型配置重构的端到端冒烟：单进程起 app + 假上游，跑完自清理。
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * ⚠️ 模型表的**独占性**要求：列表类断言（`items[0]`）会被库里别的模型干扰，
 *    所以本脚本要求模型表为空。但**不再无条件清空全表**——那会把业务配置一起删掉；
 *    只在 `--force` 下才清空，否则发现有非冒烟模型就直接拒绝跑。
 *
 * 跑法：
 *   npm run smoke:models              # 要求模型表为空，否则拒绝
 *   npm run smoke:models -- --force   # 确认库里没要紧配置后才用这个
 */

import { createServer } from 'node:http';

import { createApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { countForeignModels, deleteSmokeModels } from './smoke-utils.ts';

const KEY = 'sk-SMOKE-PLAINTEXT-KEY-DO-NOT-LEAK';

const FORCE = process.argv.includes('--force');

// ── 假上游：同时冒充对话与生图接口 ──
const REVISED = '<h1>冒烟标题</h1><h2>冒烟小标题</h2><p>冒烟正文段落，用于验证改写链路。</p>';
// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    res.end(JSON.stringify({ choices: [{ message: { content: REVISED } }] }));
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
    // 0. 清理历史脏数据。
    //
    // ⚠️ 这里曾经是全表 `deleteMany({})`，会把用户真正在用的模型和角色绑定一起删光
    // （2026-10-13 实测：跑一次冒烟，刚配好的写作模型就没了，写稿链路随即退回骨架草稿）。
    // 现在改为「只删本脚本自己建的」，并且开局若发现业务数据就拒绝跑。
    await deleteSmokeModels();
    const foreign = await countForeignModels();
    if (foreign > 0 && !FORCE) {
      throw new Error(
        `库里还有 ${foreign} 个非冒烟模型。本脚本要求模型表为空（否则列表断言会被别的行干扰）；` +
          '它也不再替你清空整表——请先记下这些模型的配置，再跑 `npm run smoke:models -- --force`。',
      );
    }
    if (foreign > 0) await prisma.llmModel.deleteMany({});

    // 1. 元数据
    const meta = await call('GET', '/models/meta');
    check('GET /models/meta 200', meta.status === 200, `status=${meta.status}`);
    // 不写死角色个数：加一条产线就会多几个角色，写死会长期假红。
    // 只钉住「四个基础角色都在」且「每个角色都声明了所需能力」。
    const roles = meta.json?.roles ?? [];
    const roleValues = roles.map((r: any) => r.role);
    check(
      'meta 含四个基础角色且每个都带能力声明',
      ['write', 'revise', 'cover', 'expand_angles'].every((r) => roleValues.includes(r)) &&
        roles.every((r: any) => Array.isArray(r.capabilities) && r.capabilities.length > 0),
      JSON.stringify(roleValues),
    );
    check(
      'meta 协议区分已实现/规划中',
      meta.json?.protocols?.some((p: any) => p.value === 'agnes_image' && p.implemented) &&
        meta.json?.protocols?.some((p: any) => p.value === 'openai_video' && !p.implemented),
    );
    check(
      'meta 能力为 4 选 1',
      meta.json?.capabilities?.map((c: any) => c.value).join(',') === 'text,image,video,multimodal',
      JSON.stringify(meta.json?.capabilities?.map((c: any) => c.value)),
    );

    // 2. 核心回归：/bindings 曾被 /:id 吞掉报 nan
    const b0 = await call('GET', '/models/bindings');
    check('GET /models/bindings 200（回归：此前是 400 nan）', b0.status === 200, `status=${b0.status}`);

    // 3. 交叉校验：协议 ↔ 能力
    const bad = await call('POST', '/models', {
      name: '矛盾组合',
      vendor: 'openai',
      protocol: 'openai_chat',
      capability: 'image',
      baseUrl: base,
      modelId: 'x',
      apiKey: KEY,
    });
    check('对话协议 + 图像能力 → 400', bad.status === 400, `status=${bad.status} ${bad.text.slice(0, 120)}`);

    const unimpl = await call('POST', '/models', {
      name: '未实现协议',
      vendor: 'custom',
      protocol: 'anthropic_messages',
      capability: 'text',
      baseUrl: base,
      modelId: 'x',
      apiKey: KEY,
    });
    check('未实现协议 → 400', unimpl.status === 400, `status=${unimpl.status}`);

    const badSize = await call('POST', '/models', {
      name: '非法尺寸',
      vendor: 'agnes',
      protocol: 'agnes_image',
      capability: 'image',
      baseUrl: base,
      modelId: 'x',
      apiKey: KEY,
      paramsJson: { size: '8K' },
    });
    check('非法生图尺寸 → 400', badSize.status === 400, `status=${badSize.status}`);

    // 4. 建两个模型：文本 + 生图
    const text = await call('POST', '/models', {
      name: '冒烟-文本模型',
      vendor: 'openai',
      protocol: 'openai_chat',
      capability: 'text',
      baseUrl: base,
      modelId: 'smoke-text',
      apiKey: KEY,
    });
    check('创建文本模型 201', text.status === 201, `status=${text.status} ${text.text.slice(0, 120)}`);
    check('响应不泄漏明文 Key', !text.text.includes(KEY) && text.json?.apiKeyMask !== KEY,
      `mask=${text.json?.apiKeyMask}`);

    const image = await call('POST', '/models', {
      name: '冒烟-生图模型',
      vendor: 'agnes',
      protocol: 'agnes_image',
      capability: 'image',
      baseUrl: base,
      modelId: 'smoke-image',
      apiKey: KEY,
      paramsJson: { size: '2K', ratio: '21:9' },
    });
    check('创建生图模型 201', image.status === 201, `status=${image.status} ${image.text.slice(0, 120)}`);

    const textId = text.json?.id as number;
    const imageId = image.json?.id as number;

    // 5. 列表：boundRoles 是数组（旧版是单值，多角色会丢）
    let list = await call('GET', '/models');
    check(
      '列表 boundRoles 为数组',
      Array.isArray(list.json?.items?.[0]?.boundRoles),
      JSON.stringify(list.json?.items?.[0]?.boundRoles),
    );
    check('列表不含 provider / isDefault 旧字段',
      list.json?.items?.[0] && !('provider' in list.json.items[0]) && !('isDefault' in list.json.items[0]),
      Object.keys(list.json?.items?.[0] ?? {}).join(','));

    // 6. 角色绑定：能力不符要被拦
    const wrong = await call('PUT', '/models/bindings/cover', { modelId: textId });
    check('把文本模型绑到封面角色 → 400', wrong.status === 400, `status=${wrong.status} ${wrong.text.slice(0, 160)}`);

    const okCover = await call('PUT', '/models/bindings/cover', { modelId: imageId });
    check('把生图模型绑到封面角色 → 200', okCover.status === 200, `status=${okCover.status}`);

    const okWrite = await call('PUT', '/models/bindings/write', { modelId: textId });
    check('把文本模型绑到写作角色 → 200', okWrite.status === 200, `status=${okWrite.status}`);

    list = await call('GET', '/models');
    const textRow = list.json?.items?.find((m: any) => m.id === textId);
    const imageRow = list.json?.items?.find((m: any) => m.id === imageId);
    check('一个模型可被多个角色共用（boundRoles 都非空）',
      (textRow?.boundRoles ?? []).includes('write') && (imageRow?.boundRoles ?? []).includes('cover'),
      `text=${JSON.stringify(textRow?.boundRoles)} image=${JSON.stringify(imageRow?.boundRoles)}`);

    // 7. 连通测试：真的发请求，不再假阳性
    const test = await call('POST', `/models/${textId}/test`);
    check('文本模型连通测试通过（真发请求）', test.status === 200 && test.json?.ok === true,
      `status=${test.status} ok=${test.json?.ok}`);

    const imgTest = await call('POST', `/models/${imageId}/test`);
    check('生图模型连通测试通过', imgTest.status === 200 && imgTest.json?.ok === true,
      `status=${imgTest.status} ok=${imgTest.json?.ok}`);

    // 8. AI 改写：绑定后可用，解绑后 400
    const src = '<h1>原标题</h1><p>原段落</p>';
    const noRevise = await call('POST', '/revise/preview', { contentHtml: src, mode: 'polish' });
    check('未绑改写角色 → 400', noRevise.status === 400, `status=${noRevise.status}`);

    const okRevise = await call('PUT', '/models/bindings/revise', { modelId: textId });
    check('把文本模型绑到改写角色 → 200', okRevise.status === 200, `status=${okRevise.status}`);

    const prev = await call('POST', '/revise/preview', { contentHtml: src, mode: 'polish' });
    check('改写预览 200 且返回新 HTML', prev.status === 200 && typeof prev.json?.contentHtml === 'string',
      `status=${prev.status} ${prev.text.slice(0, 120)}`);

    const prevModel = await call('POST', '/revise/preview', { contentHtml: src, mode: 'shorten' });
    check('改写预览带出模型名', typeof prevModel.json?.modelName === 'string' && prevModel.json.modelName.length > 0,
      String(prevModel.json?.modelName));

    const unbindWrite = await call('DELETE', '/models/bindings/write');
    check('DELETE /models/bindings/:role 解绑 200', unbindWrite.status === 200, `status=${unbindWrite.status}`);
    await call('DELETE', '/models/bindings/revise');

    const prevNoBind = await call('POST', '/revise/preview', { contentHtml: src, mode: 'polish' });
    check('解绑后改写 → 400（不是 500）', prevNoBind.status === 400,
      `status=${prevNoBind.status} ${prevNoBind.text.slice(0, 160)}`);

    // 删模型会解绑，重新绑回以便验证 PUT null 解绑
    const rebind = await call('PUT', '/models/bindings/write', { modelId: textId });
    const nullUnbind = await call('PUT', '/models/bindings/write', { modelId: null });
    check('PUT bindings/{role} {modelId:null} 解绑 200', nullUnbind.status === 200 && rebind.status === 200,
      `put=${rebind.status} null=${nullUnbind.status}`);

    const bAfter = await call('GET', '/models/bindings');
    check('解绑后 bindings.write 为 null', bAfter.json?.bindings?.write == null,
      JSON.stringify(bAfter.json?.bindings?.write));

    // 9. 封面生成：走真实生图假上游
    const track = await prisma.track.create({ data: { name: '冒烟模型赛道', slug: 'smoke-models', quotaPerDay: 1 } });
    const article = await prisma.article.create({
      data: {
        title: '冒烟文章标题',
        digest: '摘要',
        contentHtml: src,
        contentWechat: src,
        trackId: track.id,
        status: 'draft',
        pushDate: new Date().toISOString().slice(0, 10),
        idempotencyKey: `smoke-models-${Date.now()}`,
      },
    });

    const cover = await call('POST', `/articles/${article.id}/cover`, {});
    check('生成封面 200', cover.status === 200 && cover.json?.ok === true,
      `status=${cover.status} ${cover.text.slice(0, 160)}`);
    check('封面返回可访问 URL', typeof cover.json?.coverUrl === 'string' && cover.json.coverUrl.startsWith('/api/content/covers/'),
      String(cover.json?.coverUrl));

    const imgFetch = await fetch(`http://127.0.0.1:${port}${cover.json?.coverUrl ?? ''}`);
    check('封面文件可静态访问', imgFetch.status === 200, `status=${imgFetch.status}`);

    const afterUnbind = await call('DELETE', '/models/bindings/cover');
    check('解绑封面角色 200', afterUnbind.status === 200, `status=${afterUnbind.status}`);
    const cover2 = await call('POST', `/articles/${article.id}/cover`, {});
    check('解绑后再生成封面 → 400', cover2.status === 400, `status=${cover2.status} ${cover2.text.slice(0, 160)}`);

    // 10. 仪表盘带出每个角色的可用性与原因
    const dash = await call('GET', '/dashboard');
    const ra = dash.json?.models?.roleAvailability ?? {};
    check(
      '仪表盘含 roleAvailability（覆盖全部角色）',
      ['write', 'revise', 'cover', 'expand_angles'].every((r) => r in ra),
      JSON.stringify(Object.keys(ra)),
    );
    check('未绑定角色给出 reason', typeof ra.write?.reason === 'string' && ra.write.reason.length > 0,
      String(ra.write?.reason));

    // 11. 全量响应不泄漏明文 Key
    list = await call('GET', '/models');
    check('列表响应不含明文 Key', !list.text.includes(KEY));
    const one = await call('GET', `/models/${textId}`);
    check('详情响应不含明文 Key', !one.text.includes(KEY), Object.keys(one.json ?? {}).join(','));

    // 12. 通配段不再吞子路径
    const notFound = await call('GET', '/models/999999');
    check('GET /models/999999 → 404（不是 nan 400）', notFound.status === 404, `status=${notFound.status}`);
  } finally {
    // ── 清理：无论中途是否抛错都要执行 ──
    await deleteSmokeModels();
    const smokeArticles = await prisma.article.findMany({ where: { title: '冒烟文章标题' }, select: { id: true } });
    for (const a of smokeArticles) await prisma.article.delete({ where: { id: a.id } });
    await prisma.track.deleteMany({ where: { slug: 'smoke-models' } });
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
