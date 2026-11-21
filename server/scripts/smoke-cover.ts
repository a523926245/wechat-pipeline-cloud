/**
 * 封面链路端到端冒烟：单进程起 app + 假 LLM 生图上游 + 假微信上游，跑完自清理。
 *
 * 覆盖三件事：
 *   1. coverPath 改存相对路径（换机器不会静默无封面）
 *   2. 封面永久素材 media_id 复用（不再每次推送都往永久素材库传一张）
 *   3. 历史绝对路径的兼容层 + 封面缺失时显式 coverMissing（不再是静默失败）
 *
 * ⚠️ 运行输出绝对不要接 `| head -N`：管道截断会让 node 提前退出，
 *    清理逻辑不执行，库里会留下脏数据。
 *
 * 跑法：npm run smoke:cover
 */

// 冒烟旁路：本脚本带裸 fetch/静态请求，跳过 /api 鉴权（生产环境无效）。
process.env.SMOKE_NO_AUTH = '1';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { prisma } from '../src/db.ts';
import { encryptSecret } from '../src/lib/crypto.ts';
import { ensureContentDirs } from '../src/config.ts';
import { resolveCoverPath } from '../src/services/content-path.ts';
import { newStyleHtml } from './fixtures/article-sample.ts';
import { deleteSmokeModels } from './smoke-utils.ts';

/** 1x1 PNG */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LEGACY_ABS = 'K:/WorkBuddy WorkSpace/project/wechat-pipeline-cloud/var/content/covers/legacy.png';

// ── 假上游 ──
const uploads: string[] = [];
const drafts: Record<string, unknown>[] = [];

const llm = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
});

const wechat = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url.startsWith('/cgi-bin/token')) {
      res.end(JSON.stringify({ access_token: 'SMOKE_TOKEN', expires_in: 7200 }));
      return;
    }
    if (url.includes('/material/add_material')) {
      const m = /filename="([^"]+)"/.exec(body);
      uploads.push(m?.[1] ?? 'unknown');
      res.end(JSON.stringify({ media_id: `MEDIA_${uploads.length}`, url: 'http://example.invalid/x.png' }));
      return;
    }
    if (url.includes('/draft/add')) {
      drafts.push(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ media_id: `DRAFT_${drafts.length}` }));
      return;
    }
    res.end(JSON.stringify({ errcode: 0 }));
  });
});

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

function listen(s: ReturnType<typeof createServer>): Promise<number> {
  return new Promise<void>((r) => s.listen(0, '127.0.0.1', r)).then(
    () => (s.address() as { port: number }).port,
  );
}

async function main(): Promise<void> {
  const llmPort = await listen(llm);
  const wxPort = await listen(wechat);

  /** 跑之前 cover 角色真实绑的是谁（结束后原样还原）。 */
  let savedCoverBinding: { modelId: number } | null = null;

  // 必须在 import wechat.ts 之前注入，API_BASE 是模块加载时读的
  process.env.WECHAT_API_BASE = `http://127.0.0.1:${wxPort}/cgi-bin`;
  const { createApp } = await import('../src/app.ts');

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const api = `http://127.0.0.1:${port}/api`;

  const coversDir = ensureContentDirs().covers;
  const legacyFile = join(coversDir, 'legacy.png');
  const createdFiles: string[] = [legacyFile];

  async function call(method: string, path: string, body?: unknown) {
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
      /* 非 JSON 保留 text */
    }
    return { status: resp.status, json, text };
  }

  try {
    // ── 准备：赛道 / 账号 / 生图模型 + cover 绑定 / 文章 ──
    // 只回收本脚本遗留的模型，不动用户在用的配置（其余实体同理都带「冒烟」标识）。
    await deleteSmokeModels();

    const track = await prisma.track.create({
      data: { name: '冒烟封面赛道', slug: 'smoke-cover', quotaPerDay: 1 },
    });
    const secret = 'smoke-secret-0123456789';
    const accountA = await prisma.oAAccount.create({
      data: {
        trackId: track.id,
        name: '冒烟账号A',
        appid: 'wxsmokecover000001',
        secretEnc: encryptSecret(secret),
        secretMask: 'smo********789',
        author: '冒烟',
        credStatus: 'ok',
        enabled: true,
      },
    });
    const accountB = await prisma.oAAccount.create({
      data: {
        trackId: track.id,
        name: '冒烟账号B',
        appid: 'wxsmokecover000002',
        secretEnc: encryptSecret(secret),
        secretMask: 'smo********789',
        author: '冒烟',
        credStatus: 'ok',
        enabled: true,
      },
    });

    const model = await prisma.llmModel.create({
      data: {
        name: '冒烟生图模型',
        vendor: 'agnes',
        protocol: 'agnes_image',
        capability: 'image',
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        modelId: 'smoke-image',
        apiKeyEnc: encryptSecret('sk-smoke-cover'),
        apiKeyMask: 'sk-****cover',
        enabled: true,
      },
    });
    // 临时借用 cover 角色：用户在用的绑定必须原样保留，结束时还原。
    // 早前这里直接 create，而 ModelBinding.role 是 @unique，用户自己绑了封面模型就会撞唯一约束。
    savedCoverBinding = await prisma.modelBinding.findUnique({ where: { role: 'cover' } });
    await prisma.modelBinding.upsert({
      where: { role: 'cover' },
      update: { modelId: model.id },
      create: { role: 'cover', modelId: model.id },
    });

    const article = await prisma.article.create({
      data: {
        trackId: track.id,
        accountId: accountA.id,
        title: '冒烟封面文章',
        digest: '摘要',
        // 必须用合规样本：推送前有成稿体检门禁，随便写两句话会被拦下，
        // 这个冒烟测的是封面上传与复用，不该被内容规则干扰。
        contentHtml: newStyleHtml(),
        contentWechat: '<section><p>正文</p></section>',
        status: 'draft',
        pushDate: '',
        idempotencyKey: `smoke-cover-${Date.now()}`,
      },
    });
    const articleId = article.id;

    // 1. 生成封面 → 库里是相对路径
    const c1 = await call('POST', `/articles/${articleId}/cover`, {});
    const rel1: string = c1.json?.coverPath ?? '';
    check(
      '生成封面 200 且 coverPath 为相对路径',
      c1.status === 200 && rel1.startsWith('covers/') && !/^[A-Za-z]:/.test(rel1) && !rel1.includes('var/content'),
      `${c1.status} ${rel1}`,
    );

    // 2. 静态可访问
    const imgRes = await fetch(`http://127.0.0.1:${port}${c1.json?.coverUrl ?? ''}`);
    check('封面文件可静态访问', imgRes.status === 200, `status=${imgRes.status}`);

    // 3. 首次推送 → 上传 1 次
    const p1 = await call('POST', `/articles/${articleId}/push`);
    check('首次推送成功且上传 1 次封面', p1.json?.ok === true && uploads.length === 1,
      `ok=${p1.json?.ok} uploads=${uploads.length} ${p1.text.slice(0, 120)}`);

    // 4. 再推 → 复用，不重复上传
    const p2 = await call('POST', `/articles/${articleId}/push`);
    check('再次推送复用 media_id，不重复上传', p2.json?.ok === true && uploads.length === 1,
      `ok=${p2.json?.ok} uploads=${uploads.length}`);

    // 5. coverUploaded 形如 <accountId>:covers/xxx.png
    let row = await prisma.article.findUnique({ where: { id: articleId } });
    check(
      '库里 coverMediaId/coverUploaded 已回填且带 accountId',
      Boolean(row?.coverMediaId) && row?.coverUploaded === `${accountA.id}:${rel1}`,
      `mediaId=${row?.coverMediaId} uploaded=${row?.coverUploaded}`,
    );

    // 6. 换封面 → 再推 → 上传次数 +1
    const c2 = await call('POST', `/articles/${articleId}/cover`, {});
    const rel2: string = c2.json?.coverPath ?? '';
    const p3 = await call('POST', `/articles/${articleId}/push`);
    check('换封面后重新上传（+1）', p3.json?.ok === true && uploads.length === 2 && rel2 !== rel1,
      `uploads=${uploads.length} rel1=${rel1} rel2=${rel2}`);
    row = await prisma.article.findUnique({ where: { id: articleId } });
    check('coverUploaded 已更新为新封面', row?.coverUploaded === `${accountA.id}:${rel2}`,
      String(row?.coverUploaded));

    // 7. 历史绝对路径兼容：造一个 legacy.png 并把库值写成 Windows 绝对路径
    writeFileSync(legacyFile, Buffer.from(PNG_B64, 'base64'));
    await prisma.article.update({
      where: { id: articleId },
      data: { coverPath: LEGACY_ABS, coverMediaId: '', coverUploaded: '' },
    });
    const p4 = await call('POST', `/articles/${articleId}/push`);
    check(
      '历史绝对路径被兼容解析并上传（文件名正确）',
      p4.json?.ok === true && uploads.length === 3 && uploads[2] === 'legacy.png',
      `uploads=${uploads.length} last=${uploads[uploads.length - 1]}`,
    );

    // 8. 换账号 → 必须重传（永久素材 media_id 是账号维度的）
    await prisma.article.update({ where: { id: articleId }, data: { accountId: accountB.id } });
    const p5 = await call('POST', `/articles/${articleId}/push`);
    check('换账号后重传（+1）', p5.json?.ok === true && uploads.length === 4,
      `uploads=${uploads.length}`);
    await prisma.article.update({ where: { id: articleId }, data: { accountId: accountA.id } });

    // 9. 封面文件删掉 → 显式 coverMissing，但仍推送成功
    const currentRel = (await prisma.article.findUnique({ where: { id: articleId } }))?.coverPath ?? '';
    const resolved = resolveCoverPath(currentRel);
    if (existsSync(resolved)) unlinkSync(resolved);
    const p6 = await call('POST', `/articles/${articleId}/push`);
    check(
      '封面文件缺失 → 返回 coverMissing 且仍推送成功（不静默）',
      p6.json?.ok === true && p6.json?.coverMissing === true && uploads.length === 4,
      `ok=${p6.json?.ok} coverMissing=${p6.json?.coverMissing} msg=${p6.json?.message}`,
    );

    // 10. 已推送文章换封面 → status 回退 draft，coverMediaId 清空
    const beforeStatus = (await prisma.article.findUnique({ where: { id: articleId } }))?.status;
    const c3 = await call('POST', `/articles/${articleId}/cover`, {});
    row = await prisma.article.findUnique({ where: { id: articleId } });
    check(
      '已推送文章换封面 → status 回退 draft 且 coverMediaId 清空',
      beforeStatus === 'pushed' && c3.status === 200 && row?.status === 'draft' && row?.coverMediaId === '',
      `before=${beforeStatus} after=${row?.status} mediaId="${row?.coverMediaId}"`,
    );

    // 11. 前端 coverUrl 对相对路径仍然正确
    const detail = await call('GET', `/articles/${articleId}`);
    check(
      '详情返回相对 coverPath 与新字段',
      detail.json?.coverPath?.startsWith('covers/') &&
        'coverMediaId' in detail.json &&
        'coverUploaded' in detail.json,
      `coverPath=${detail.json?.coverPath}`,
    );

    // 12. 修数脚本视角：不应再有绝对路径（本脚本造的已由代码归一化）
    const all = await prisma.article.findMany({
      where: { coverPath: { not: '' } },
      select: { coverPath: true },
    });
    const abs = all.filter((r) => /^[A-Za-z]:\//.test(r.coverPath) || r.coverPath.startsWith('/'));
    check('库内无绝对路径残留', abs.length === 0, JSON.stringify(abs.slice(0, 3)));
  } finally {
    // ── 清理 ──
    const smokeArticles = await prisma.article.findMany({
      where: { idempotencyKey: { startsWith: 'smoke-cover-' } },
      select: { id: true },
    });
    for (const a of smokeArticles) {
      await prisma.taskRun.deleteMany({ where: { articleId: a.id } });
      await prisma.article.delete({ where: { id: a.id } });
    }
    await deleteSmokeModels();
    // 还原用户自己的 cover 绑定（冒烟只是临时借用这个角色）
    if (savedCoverBinding) {
      await prisma.modelBinding.upsert({
        where: { role: 'cover' },
        update: { modelId: savedCoverBinding.modelId },
        create: { role: 'cover', modelId: savedCoverBinding.modelId },
      });
    } else {
      await prisma.modelBinding.deleteMany({ where: { role: 'cover' } });
    }
    await prisma.wechatToken.deleteMany({});
    await prisma.oAAccount.deleteMany({ where: { appid: { startsWith: 'wxsmokecover' } } });
    await prisma.track.deleteMany({ where: { slug: 'smoke-cover' } });
    for (const f of createdFiles) if (existsSync(f)) unlinkSync(f);
    for (const f of readdirSync(coversDir)) {
      if (f.startsWith('cover-a') || f.startsWith('legacy')) {
        try {
          unlinkSync(join(coversDir, f));
        } catch {
          /* 忽略 */
        }
      }
    }
    server.close();
    llm.close();
    wechat.close();
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
