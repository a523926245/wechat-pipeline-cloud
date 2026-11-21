/**
 * S5-4 · 正式业务库（`wechat_pipeline`）应用层集成验证。
 *
 * 这是**唯一**允许对正式库做写操作的验证脚本，因此纪律写在最前面：
 *
 * 1. **库名硬校验**：进程级 `DATABASE_URL` 由本脚本自己拼（`..env` 的凭据 + 库名段换成
 *    `wechat_pipeline`），连库后第一件事就是断言
 *    `DATABASE()/CURRENT_USER()/VERSION()`，任一项不符立即退出，**不写任何数据**。
 *    `.env` 默认指向 `wechat_pipeline_smoke`，绝不依赖默认值。
 * 2. **只碰本轮数据**：赛道/账号/模型/绑定/选题/文章全部带 `s54-<stamp>` 标识，
 *    清理一律按主键精确删（见 `cleanup()`），**不使用模糊条件批量删除**，
 *    跑完逐表比对「测试前基线 → 测试后行数」，用数字证明没有遗留。
 * 3. **零真实外呼**：微信（token/draft/add/material）与 LLM（chat/completions）
 *    全部指向本地假上游；不发真实请求、不建真实推送任务。
 * 4. **业务代码不绕过**：走真实 Express 路由与真实 service（publisher/lint-store/planner），
 *    只 mock 外部边界（微信 / 模型）。
 *
 * 跑法：`npm run verify:s5-4`（必须在 server/ 下，且 8787/8797 无本项目服务在跑）
 */

process.env.SMOKE_NO_AUTH = '1'; // 仅非 production 生效：本脚本测业务门禁，不测鉴权
process.env.PROMPT_DUMP = '0'; // 排产写稿会落提示词文件，验证不需要污染 var/prompts
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const TARGET_DB = 'wechat_pipeline';

// ── 0. 拼出正式库连接串（不落盘、不打印凭据） ──────────────────────────────
function buildTargetUrl(target: string): string {
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const line = text.split(String.fromCharCode(10)).find((l) => l.trim().startsWith('DATABASE_URL='));
  if (!line) throw new Error('.env 缺少 DATABASE_URL，无法确定连接凭据');
  let raw = line.slice(line.indexOf('=') + 1).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  const schemeEnd = raw.indexOf('://') + 3;
  const slash = raw.indexOf('/', schemeEnd);
  if (slash < 0) throw new Error('DATABASE_URL 缺少库名段');
  const q = raw.indexOf('?', slash);
  const url = raw.slice(0, slash + 1) + target + (q >= 0 ? raw.slice(q) : '');
  // 二次确认：拼出来的库名必须正好是目标库，否则宁可不跑
  const dbName = url.slice(slash + 1).split('?')[0];
  if (dbName !== target) throw new Error(`连接串库名异常：期望 ${target}，实际 ${dbName}`);
  return url;
}

process.env.DATABASE_URL = buildTargetUrl(TARGET_DB);

// ── 断言器（与项目其它脚本同款，不引测试框架） ─────────────────────────────
let passed = 0;
function expect(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  throw new Error(`断言失败：${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}
function section(title: string): void {
  console.log(`\n══ ${title} ══`);
}
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── 假上游：微信（token / draft/add / 素材）+ OpenAI（chat/completions） ────
interface MockUpstream {
  port: number;
  hits: { token: number; addDraft: number; upload: number; chat: number };
  failAddDraft: number;
  chatReply: string;
  chatStatus: number;
  mediaSeq: number;
  draftTitles: string[];
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    port: 0,
    hits: { token: 0, addDraft: 0, upload: 0, chat: 0 },
    failAddDraft: 0,
    chatReply: '',
    chatStatus: 200,
    mediaSeq: 0,
    draftTitles: [],
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    let body = '';
    req.on('data', (c) => (body += String(c)));
    const done = (obj: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    req.on('end', () => {
      if (p.endsWith('/token')) {
        state.hits.token += 1;
        done({ access_token: 's54-token', expires_in: 7200 });
        return;
      }
      if (p.endsWith('/draft/add')) {
        state.hits.addDraft += 1;
        if (state.failAddDraft > 0) {
          state.failAddDraft -= 1;
          // 40164 = IP 白名单错误，属 ERR_NO_RETRY，不会被 WechatClient 退避重试吃掉
          done({ errcode: 40164, errmsg: 'invalid ip 127.0.0.1, not in whitelist' });
          return;
        }
        try {
          state.draftTitles.push(String((JSON.parse(body) as { title?: string }).title ?? ''));
        } catch {
          state.draftTitles.push('');
        }
        state.mediaSeq += 1;
        done({ media_id: `s54-media-${state.mediaSeq}` });
        return;
      }
      if (p.includes('/material/add_material') || p.endsWith('/media/uploadimg')) {
        state.hits.upload += 1;
        done({ media_id: 's54-thumb', url: 'http://127.0.0.1/s54.png' });
        return;
      }
      if (p.endsWith('/chat/completions')) {
        state.hits.chat += 1;
        if (state.chatStatus !== 200) {
          done({ error: { message: 's54 mock upstream failure' } }, state.chatStatus);
          return;
        }
        done({ choices: [{ message: { content: state.chatReply || '<h1>未配置</h1><p>占位。</p>' } }] });
        return;
      }
      done({ errcode: 40001, errmsg: `unexpected path ${p}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as { port: number }).port;
      resolve(state);
    });
  });
}

// ── 正文夹具 ────────────────────────────────────────────────────────────────
/** 过得了 error 级门禁的正文：4 个小标题 + 约 1500 字（sections 3-4 / chars 1300-2300）。 */
const goodPara = (n: number): string =>
  `<p>第${n}节想说的这件小事，其实就发生在我们每天都会经过的那条路上，` +
  '只是平时走得太急，从来没有停下来留意过它的存在与变化，也忽略了它一直在替我们记录着什么。'.repeat(9) +
  '</p>';
const GOOD_HTML =
  '<h1>验证用标题</h1>' +
  `<h2>第一节 小标题</h2>${goodPara(1)}` +
  `<h2>第二节 小标题</h2>${goodPara(2)}` +
  `<h2>第三节 小标题</h2>${goodPara(3)}` +
  `<h2>第四节 小标题</h2>${goodPara(4)}`;
/** 明确不合规：没有小标题、字数远不够 → error 必现。error 不可被 relax 豁免。 */
const BAD_HTML = '<h1>结构不完整</h1><p>只有一段话，没有小标题，字数也远远不够。</p>';

// ── 表行数快照（用于「测试前后逐表比对」） ─────────────────────────────────
const TABLES = [
  'article',
  'articlelintrun',
  'taskrun',
  'angle',
  'topicreview',
  'account',
  'track',
  'trackpipeline',
  'llmmodel',
  'modelbinding',
  'wechattoken',
  'comicpanel',
  'setting',
  'styleprompt',
  'user',
  'usersession',
  '_prisma_migrations',
] as const;

async function snapshot(prisma: { $queryRawUnsafe: (q: string) => Promise<unknown> }): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM \`${t}\``)) as Array<{ c: bigint | number }>;
    out[t] = Number(rows[0]?.c ?? 0);
  }
  return out;
}

async function main(): Promise<void> {
  // ① 先起假上游，再改 WECHAT_API_BASE —— wechat.ts 在模块加载时读它，
  //    所以所有 src 模块必须在这之后动态 import。
  const up = await startMockUpstream();
  process.env.WECHAT_API_BASE = `http://127.0.0.1:${up.port}/cgi-bin`;

  const { prisma } = await import('../src/db.ts');
  const { encryptSecret } = await import('../src/lib/crypto.ts');
  const { createApp } = await import('../src/app.ts');
  const { pushArticleToDraft } = await import('../src/services/publisher.ts');
  const { latestLintRun, listLintRuns, recordLintRun } = await import('../src/services/lint-store.ts');
  const { lintArticle } = await import('../src/services/lint.ts');

  const stamp = Date.now().toString(36);
  const created = {
    trackIds: [] as number[],
    pipelineIds: [] as number[],
    accountIds: [] as number[],
    modelIds: [] as number[],
    angleIds: [] as number[],
    articleIds: [] as number[],
    /** 变体游标行的原值（null=本轮开始前不存在），跑完按它恢复。 */
    cursorBefore: null as string | null,
  };

  let server: { close(cb?: () => void): void } | null = null;
  let baseline: Record<string, number> | null = null;

  try {
    // ════════ 第一阶段：环境与身份 ════════
    section('一 环境与身份');

    const idRows = (await prisma.$queryRawUnsafe(
      'SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS ver, @@port AS port',
    )) as Array<{ db: string; usr: string; ver: string; port: number }>;
    const id = idRows[0];
    console.log(`  实测：db=${id.db} user=${id.usr} version=${id.ver} port=${String(id.port)}`);

    // 身份不符必须**在任何写入之前**中止
    if (id.db !== TARGET_DB) throw new Error(`目标库不符：${id.db} ≠ ${TARGET_DB}，立即中止`);
    expect('DATABASE() = wechat_pipeline', id.db === 'wechat_pipeline', id.db);
    expect('CURRENT_USER() = wpc_app@127.0.0.1', id.usr === 'wpc_app@127.0.0.1', id.usr);
    expect('MySQL 版本 8.0.30', id.ver.startsWith('8.0.30'), id.ver);

    const tbl = (await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ArticleLintRun'",
    )) as Array<{ c: bigint | number }>;
    expect('ArticleLintRun 表存在于业务库', Number(tbl[0]?.c ?? 0) === 1, Number(tbl[0]?.c ?? 0));

    const mig = (await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at',
    )) as Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>;
    expect(
      '迁移记录含 20261116120000_add_article_lint_run 且已成功（未回滚）',
      mig.some((m) => m.migration_name === '20261116120000_add_article_lint_run' && m.finished_at && !m.rolled_back_at),
      mig.map((m) => m.migration_name),
    );
    expect(
      '无未完成/失败迁移（finished_at 空且未回滚的行数=0）',
      mig.filter((m) => !m.finished_at && !m.rolled_back_at).length === 0,
    );

    baseline = await snapshot(prisma);
    console.log(`  基线行数：article=${baseline.article} lintrun=${baseline.articlelintrun} angle=${baseline.angle} account=${baseline.account} track=${baseline.track} setting=${baseline.setting}`);

    // 排产写稿会推进 `Setting.style_variant_cursor`（变体轮换游标，每写一篇 +1，键是赛道名）。
    // 这是产品既定行为、不是测试残留，但它确实会写系统配置行——所以**先记原值，跑完原样写回**
    // （原本不存在就删掉），否则「逐表行数一致」看起来干净，配置行里却留着测试赛道的键。
    const cursorBefore = await prisma.setting.findUnique({ where: { k: 'style_variant_cursor' } });
    created.cursorBefore = cursorBefore ? String(cursorBefore.v) : null;
    console.log(
      `  变体游标：${cursorBefore ? '已存在，跑完按原值写回' : '不存在，跑完删除（否则会留下测试赛道键）'}`,
    );

    // ════════ 夹具：赛道 / 产线 / 账号 / 模型（全部带 s54 标识） ════════
    section('二 夹具（本轮专用测试数据）');

    const track = await prisma.track.create({
      data: { name: `S5-4验证赛道-${stamp}`, slug: `s54-${stamp}`, quotaPerDay: 4, enabled: true },
    });
    created.trackIds.push(track.id);
    const pipe = await prisma.trackPipeline.create({
      data: { trackId: track.id, kind: 'article', quotaPerDay: 4, enabled: true },
    });
    created.pipelineIds.push(pipe.id);

    const acc = await prisma.oAAccount.create({
      data: {
        trackId: track.id,
        name: `S5-4验证账号-${stamp}`,
        appid: `s54-appid-${stamp}`,
        secretEnc: encryptSecret('s54-fake-secret'),
        secretMask: '***',
        author: '验证',
        credStatus: 'ok',
        enabled: true,
      },
    });
    created.accountIds.push(acc.id);

    // 同一模型绑 write + revise：排产写稿与改写都走这个假上游
    const model = await prisma.llmModel.create({
      data: {
        name: `S5-4验证模型-${stamp}`,
        vendor: 'custom',
        protocol: 'openai_chat',
        capability: 'text',
        baseUrl: `http://127.0.0.1:${up.port}`,
        modelId: 's54-mock',
        apiKeyEnc: encryptSecret('s54-fake-key'),
        apiKeyMask: '***',
        enabled: true,
      },
    });
    created.modelIds.push(model.id);
    for (const role of ['revise', 'write'] as const) {
      const exist = await prisma.modelBinding.findUnique({ where: { role } });
      expect(`角色 ${role} 当前未被占用（否则不覆盖既有绑定）`, exist === null, exist?.id);
      await prisma.modelBinding.create({ data: { role, modelId: model.id } });
    }

    // 真实 Express 应用，监听随机端口（不占用 8787，避免与既有服务冲突）
    const app = createApp();
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    server = srv;
    const port = (srv.address() as { port: number }).port;
    console.log(`  API 监听 127.0.0.1:${port}（进程内，跑完关闭）`);

    const api = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      return { status: res.status, json };
    };

    const mkArticle = async (
      label: string,
      html: string,
      extra: Record<string, unknown> = {},
    ): Promise<number> => {
      const r = await api('POST', '/articles', { contentHtml: html, trackId: track.id, accountId: acc.id, ...extra });
      expect(`文章新增成功（${label}，201）`, r.status === 201, r);
      const articleId = Number(r.json.id);
      created.articleIds.push(articleId);
      return articleId;
    };

    // ════════ 三 ArticleLintRun 真实库写入 / 读取 ════════
    section('三 ArticleLintRun 写入与读取');

    const a1 = await mkArticle('体检读写', GOOD_HTML);

    // 3.1 通过真实业务代码写入
    const rep1 = lintArticle(GOOD_HTML, undefined, track.name);
    const rec1 = await recordLintRun({
      articleId: a1,
      trigger: 'check',
      report: rep1,
      contentHtml: GOOD_HTML,
      rule: { checks: ['sections'], relax: ['para_short'] },
    });
    expect('recordLintRun 返回 saved:true 且带 run', rec1.saved === true && Boolean(rec1.run?.id), rec1);
    const run1Id = rec1.run!.id;

    const row1 = await prisma.articleLintRun.findUnique({ where: { id: run1Id } });
    expect('数据库确实新增 1 行（主键可查）', row1 !== null, run1Id);
    expect('字段映射：articleId / trigger', row1?.articleId === a1 && row1?.trigger === 'check', row1);
    expect(
      '字段映射：ok / errorCount / warnCount 与报告一致',
      row1?.ok === rep1.ok && row1?.errorCount === rep1.errors.length && row1?.warnCount === rep1.warnings.length,
      { db: { ok: row1?.ok, e: row1?.errorCount, w: row1?.warnCount }, rep: { ok: rep1.ok, e: rep1.errors.length, w: rep1.warnings.length } },
    );
    expect('字段映射：contentHash = sha256(被检查正文)', row1?.contentHash === sha256(GOOD_HTML), row1?.contentHash);
    expect('JSON 字段三列均已写入（stats/issues/rule）', row1?.statsJson != null && row1?.issuesJson != null && row1?.ruleJson != null);
    // 注意：项目约定 Json 列存**字符串**（db-json.ts：写 stringify / 读 parse），
    // 所以这里用 $queryRaw 之外的方式拿到的是字符串，必须自己 parse 再比对。
    const statsCol = (v: unknown): Record<string, unknown> => {
      if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>;
      return (v ?? {}) as Record<string, unknown>;
    };
    const statsObj = statsCol(row1?.statsJson);
    expect(
      'statsJson 快照与报告规模一致',
      statsObj['h2Count'] === rep1.stats.h2Count && statsObj['charCount'] === rep1.stats.charCount,
      statsObj,
    );

    // 3.2 latestLintRun 读回
    const latest1 = await latestLintRun(a1);
    expect('latestLintRun 取到刚写入的那一条', latest1?.id === run1Id, latest1?.id);
    expect('latestLintRun 是完整形态（stats/issues/rule 已反序列化）',
      latest1?.stats != null && Array.isArray(latest1?.issues) && latest1?.rule != null,
      { stats: latest1?.stats != null, issues: Array.isArray(latest1?.issues), rule: latest1?.rule });
    expect('latestLintRun.createdAt 为 ISO 字符串', typeof latest1?.createdAt === 'string' && latest1.createdAt.includes('T'), latest1?.createdAt);

    // 3.3 listLintRuns 历史
    const list1 = await listLintRuns(a1);
    expect('listLintRuns 含该记录且排第一（新的在前）', list1[0]?.id === run1Id, list1.map((x) => x.id));

    // 3.4 多次记录：不覆盖、排序正确、数量正确
    const htmlCheck2 = GOOD_HTML.replace('验证用标题', '验证用标题二');
    for (const [i, trig] of (['save', 'check', 'push'] as const).entries()) {
      const html = i === 0 ? htmlCheck2 : GOOD_HTML;
      await recordLintRun({
        articleId: a1,
        trigger: trig,
        report: lintArticle(html, undefined, track.name),
        contentHtml: html,
        rule: { checks: ['sections'], relax: [] },
      });
    }
    const allRuns = await listLintRuns(a1);
    expect('同一篇文章共 4 条记录（新记录不覆盖旧记录）', allRuns.length === 4, allRuns.length);
    const ids = allRuns.map((x) => x.id);
    expect('历史按 id 倒序', ids.every((v, i) => i === 0 || ids[i - 1] > v), ids);
    expect('最新记录 = 最后一次写入（trigger=push）', allRuns[0]?.trigger === 'push' && allRuns[0]?.id === Math.max(...ids), allRuns[0]);
    expect('最初那条仍在历史里（未被挤出）', ids.includes(run1Id), ids);
    const latest2 = await latestLintRun(a1);
    expect('latestLintRun 随新写入前移', latest2?.id === Math.max(...ids), { latest: latest2?.id, max: Math.max(...ids) });
    const limited = await listLintRuns(a1, 2);
    expect('limit=2 生效', limited.length === 2 && limited[0]?.id === ids[0], limited.map((x) => x.id));
    const clamped = await listLintRuns(a1, 0);
    expect('limit=0 被夹到 1（不返回空表）', clamped.length === 1, clamped.length);

    // ════════ 四 文章删除与级联 ════════
    section('四 删除文章 → 级联删除体检记录');

    const a2 = await mkArticle('级联删除', GOOD_HTML);
    for (const trig of ['check', 'save'] as const) {
      await recordLintRun({ articleId: a2, trigger: trig, report: lintArticle(GOOD_HTML, undefined, track.name), contentHtml: GOOD_HTML });
    }
    const beforeCascade = await prisma.articleLintRun.count({ where: { articleId: a2 } });
    expect('删除前该文章有 2 条体检记录', beforeCascade === 2, beforeCascade);
    const delRes = await api('DELETE', `/articles/${a2}`);
    expect('删除接口返回 ok', delRes.status === 200 && delRes.json.ok === true, delRes);
    const afterCascade = await prisma.articleLintRun.count({ where: { articleId: a2 } });
    expect('文章删除后体检记录级联清零（外键 CASCADE 生效）', afterCascade === 0, afterCascade);
    const gone = await prisma.article.findUnique({ where: { id: a2 } });
    expect('文章本身已不存在', gone === null);
    created.articleIds = created.articleIds.filter((x) => x !== a2);

    // ════════ 五 预览 / 体检接口 / 降级 ════════
    section('五 预览接口、stale 标记与读取降级');

    const a3 = await mkArticle('预览空态', GOOD_HTML);
    const p0 = await api('GET', `/articles/${a3}/preview`);
    expect('预览 200', p0.status === 200, p0.status);
    expect('无历史时 lintRun=null、lintRunStale=false', p0.json.lintRun === null && p0.json.lintRunStale === false, { run: p0.json.lintRun, stale: p0.json.lintRunStale });
    expect('预览返回现算体检结果（lint 非空）', (p0.json.lint as { ok?: boolean } | null)?.ok === true, p0.json.lint);
    const lr0 = await api('GET', `/articles/${a3}/lint-runs`);
    expect('无历史时历史接口返回空数组', lr0.status === 200 && Array.isArray(lr0.json.items) && (lr0.json.items as unknown[]).length === 0, lr0.json);

    // 5.1 检查一次 → 存档，与当前正文匹配（stale=false）
    const chk = await api('GET', `/articles/${a3}/lint`);
    expect('重新检查接口 200', chk.status === 200, chk.status);
    const chkRun = chk.json.lintRun as { id?: number; trigger?: string } | null;
    expect('检查结果已存档（trigger=check，无 lintPersistError）', chkRun?.trigger === 'check' && !chk.json.lintPersistError, chk.json);
    const p1 = await api('GET', `/articles/${a3}/preview`);
    expect('预览带回最近存档', (p1.json.lintRun as { id?: number } | null)?.id === chkRun?.id, p1.json.lintRun);
    expect('正文未变 → lintRunStale=false', p1.json.lintRunStale === false, p1.json.lintRunStale);
    expect('预览 contentHash 与存档 contentHash 一致',
      p1.json.contentHash === sha256(GOOD_HTML) && (p1.json.lintRun as { contentHash?: string } | null)?.contentHash === p1.json.contentHash,
      { preview: p1.json.contentHash });

    // 5.2 正文被改（模拟「保存未留痕/顺手改了库」）→ stale=true
    const htmlChanged = GOOD_HTML + '<p>这是新增的一段，用来制造「存档与当前正文不一致」。</p>';
    await prisma.article.update({ where: { id: a3 }, data: { contentHtml: htmlChanged } });
    const p2 = await api('GET', `/articles/${a3}/preview`);
    expect('正文变了 → lintRunStale=true（旧结论不再冒充现行结论）', p2.json.lintRunStale === true, p2.json);
    expect('stale 时仍返回旧存档本身（供界面显示「最近一次」）', (p2.json.lintRun as { id?: number } | null)?.id === chkRun?.id, p2.json.lintRun);
    const chk2 = await api('GET', `/articles/${a3}/lint`);
    const p3 = await api('GET', `/articles/${a3}/preview`);
    expect('重新检查后 stale 复位为 false', p3.json.lintRunStale === false && (p3.json.lintRun as { id?: number } | null)?.id === (chk2.json.lintRun as { id?: number } | null)?.id, { p3: p3.json.lintRunStale, chk2: chk2.json.lintRun });

    // 5.3 读取失败降级（S5-2-HF1）：把委托换成抛 P2021 的假实现，走真实路由
    const { Prisma } = await import('@prisma/client');
    type Delegate = { articleLintRun: unknown };
    const realDelegate = (prisma as unknown as Delegate).articleLintRun;
    const p2021 = (): Error =>
      new Prisma.PrismaClientKnownRequestError('The table `ArticleLintRun` does not exist in the current database.', {
        code: 'P2021',
        clientVersion: '5.22.0',
        meta: { modelName: 'ArticleLintRun' },
      });
    try {
      (prisma as unknown as Delegate).articleLintRun = {
        findFirst: async () => {
          throw p2021();
        },
        findMany: async () => {
          throw p2021();
        },
      };
      const pDeg = await api('GET', `/articles/${a3}/preview`);
      expect('存档读取失败时预览仍 200（不把主流程拖成 500）', pDeg.status === 200, { status: pDeg.status, body: pDeg.json });
      expect('降级后 lintRun=null（不伪造记录）', pDeg.json.lintRun === null, pDeg.json.lintRun);
      expect('降级后 lintRunStale=false（没有存档就谈不上过期）', pDeg.json.lintRunStale === false, pDeg.json.lintRunStale);
      expect('降级不影响现算体检结论（lint 仍在）', (pDeg.json.lint as { ok?: boolean } | null) !== null, pDeg.json.lint);
      const lrDeg = await api('GET', `/articles/${a3}/lint-runs`);
      expect('历史读取失败时接口仍 200 且返回空数组', lrDeg.status === 200 && Array.isArray(lrDeg.json.items) && (lrDeg.json.items as unknown[]).length === 0, { status: lrDeg.status, body: lrDeg.json });
    } finally {
      (prisma as unknown as Delegate).articleLintRun = realDelegate;
    }
    const pRestored = await api('GET', `/articles/${a3}/preview`);
    expect('恢复委托后存档读取正常（验证降级只发生在故障期）', (pRestored.json.lintRun as { id?: number } | null) !== null, pRestored.json.lintRun);

    // 5.4 边界：正文近乎为空（作者刚建壳）→ 预览/检查都不能 500，结论如实报 error
    const aEmpty = await mkArticle('空正文', '<p>还没写。</p>');
    const pEmpty = await api('GET', `/articles/${aEmpty}/preview`);
    expect('空壳正文预览 200（不崩）', pEmpty.status === 200, pEmpty);
    expect('空壳正文体检如实不通过（不伪装成通过）', (pEmpty.json.lint as { ok?: boolean; errors?: unknown[] } | null)?.ok === false, pEmpty.json.lint);
    const chkEmpty = await api('GET', `/articles/${aEmpty}/lint`);
    expect('空壳正文检查 200 且留痕（errorCount>0）', chkEmpty.status === 200 && Number((chkEmpty.json.lintRun as { errorCount?: number } | null)?.errorCount ?? 0) > 0, chkEmpty.json);

    // ════════ 六 保存 / 改写后自动体检 ════════
    section('六 保存体检与改写后自动体检');

    // 6.1 保存即体检（trigger=save），正文确实落库
    const a4 = await mkArticle('保存体检', GOOD_HTML);
    const saveRes = await api('PUT', `/articles/${a4}/content`, { contentHtml: GOOD_HTML.replace('验证用标题', '保存后的标题') });
    expect('保存正文接口 200', saveRes.status === 200, saveRes);
    const saveRun = saveRes.json.lintRun as { id?: number; trigger?: string; contentHash?: string } | null;
    expect('保存即体检并留痕（trigger=save）', saveRun?.trigger === 'save' && !saveRes.json.lintPersistError, saveRes.json);
    const savedRow = await prisma.article.findUnique({ where: { id: a4 } });
    expect('正文已落库且与留痕 hash 对应', savedRow?.contentHtml === GOOD_HTML.replace('验证用标题', '保存后的标题') && saveRun?.contentHash === sha256(savedRow!.contentHtml), { hash: saveRun?.contentHash });

    // 6.2 保存不合规正文：正文必须保存，体检报错但绝不回滚
    const badSave = await api('PUT', `/articles/${a4}/content`, { contentHtml: BAD_HTML });
    expect('不合规正文保存接口 200（体检不阻断保存）', badSave.status === 200, badSave);
    expect('体检明确不通过且带 error', (badSave.json.lint as { ok?: boolean; errors?: unknown[] } | null)?.ok === false && ((badSave.json.lint as { errors?: unknown[] }).errors?.length ?? 0) > 0, badSave.json.lint);
    const badRow = await prisma.article.findUnique({ where: { id: a4 } });
    expect('不合规正文确实已落库（没有被体检回滚）', badRow?.contentHtml === BAD_HTML, badRow?.contentHtml);
    expect('不合规结果同样留痕（errorCount>0）', Number((badSave.json.lintRun as { errorCount?: number } | null)?.errorCount ?? 0) > 0, badSave.json.lintRun);

    // 6.3 改写（mock LLM）：先落库，再对最终正文体检
    const a5 = await mkArticle('改写体检', GOOD_HTML);
    up.chatReply = '<h1>改写后的标题</h1>' + GOOD_HTML.slice(GOOD_HTML.indexOf('<h2>'));
    const revPreview = await api('POST', '/revise/preview', { contentHtml: GOOD_HTML, mode: 'polish' });
    expect('改写预览接口 200（不动库）', revPreview.status === 200 && String(revPreview.json.contentHtml ?? '').includes('改写后的标题'), revPreview);
    const stillOld = await prisma.article.findUnique({ where: { id: a5 } });
    expect('改写预览不落库（正文仍是原文）', stillOld?.contentHtml === GOOD_HTML);

    const revRes = await api('POST', `/revise/articles/${a5}`, { mode: 'polish' });
    expect('应用改写 200', revRes.status === 200, revRes);
    const revRun = revRes.json.lintRun as { id?: number; trigger?: string; contentHash?: string } | null;
    const revRow = await prisma.article.findUnique({ where: { id: a5 } });
    expect('改写结果已保存（正文含改写标记）', revRow?.contentHtml.includes('改写后的标题') === true, revRow?.contentHtml?.slice(0, 60));
    expect('改写后自动体检留痕 trigger=revise', revRun?.trigger === 'revise' && !revRes.json.lintPersistError, revRes.json);
    expect('体检针对改写后的最终正文（hash 对齐落库正文）', revRun?.contentHash === sha256(revRow!.contentHtml), { run: revRun?.contentHash });
    expect('改写返回同时给出体检结论与提示语', (revRes.json.lint as { ok?: boolean } | null) !== null && String(revRes.json.message ?? '').includes('改写已保存'), revRes.json.message);
    expect('contentWechat 由改写后正文现算（推送产物非空）', String(revRes.json.contentWechat ?? '').length > 0, String(revRes.json.contentWechat ?? '').length);

    // 6.4 改写出「体检不通过」的正文：已保存正文不得丢失
    up.chatReply = '<h1>改写后的标题</h1><p>只有一个小段落，既没有小标题，字数也远不够。</p>';
    const revBad = await api('POST', `/revise/articles/${a5}`, { mode: 'rewrite' });
    expect('不合规改写仍 200 且正文已保存', revBad.status === 200 && String((await prisma.article.findUnique({ where: { id: a5 } }))?.contentHtml).includes('只有一个小段落'), revBad);
    expect('不合规改写如实报错并提示会被门禁拦下', (revBad.json.lint as { ok?: boolean } | null)?.ok === false && String(revBad.json.message ?? '').includes('门禁'), revBad.json.message);

    // 6.5 存档失败 ≠ 体检失败：把 create 打成抛错，体检结论仍应返回，正文仍应保存
    const realDelegate2 = (prisma as unknown as Delegate).articleLintRun;
    up.chatReply = '<h1>存档失败用例</h1>' + GOOD_HTML.slice(GOOD_HTML.indexOf('<h2>'));
    try {
      (prisma as unknown as Delegate).articleLintRun = {
        create: async () => {
          throw new Error('s54 mock 落库失败');
        },
      };
      const revNoStore = await api('POST', `/revise/articles/${a5}`, { mode: 'polish' });
      expect('存档失败时改写仍 200（正文不因留痕失败丢失）', revNoStore.status === 200, revNoStore);
      expect('存档失败时仍返回体检结论（lint 非空）', (revNoStore.json.lint as { ok?: boolean } | null) !== null, revNoStore.json.lint);
      expect('存档失败时 lintRun=null 且 lintPersistError 非空', revNoStore.json.lintRun === null && String(revNoStore.json.lintPersistError ?? '').length > 0, { run: revNoStore.json.lintRun, err: revNoStore.json.lintPersistError });
      expect('提示语明确区分「未存档」与「体检不通过」', String(revNoStore.json.message ?? '').includes('未能存档') || String(revNoStore.json.message ?? '').includes('未能完成'), revNoStore.json.message);
      const noStoreRow = await prisma.article.findUnique({ where: { id: a5 } });
      expect('存档失败但正文已保存', noStoreRow?.contentHtml.includes('存档失败用例') === true, noStoreRow?.contentHtml?.slice(0, 40));
    } finally {
      (prisma as unknown as Delegate).articleLintRun = realDelegate2;
    }

    // ════════ 七 推送门禁 ════════
    section('七 推送门禁（全 Mock，不触达微信）');

    // 7.1 无体检历史 + 正文合格 → 门禁自己算一遍并放行
    const p1Art = await mkArticle('推送放行', GOOD_HTML);
    const hitsBefore = up.hits.addDraft;
    const push1 = await api('POST', `/articles/${p1Art}/push`);
    expect('无体检历史时仍可推送（门禁不依赖历史存档）', push1.json.ok === true, push1.json);
    expect('放行后确实调用了一次 addDraft', up.hits.addDraft === hitsBefore + 1, up.hits);
    const push1Run = push1.json.lintRun as { trigger?: string; ok?: boolean } | null;
    expect('门禁结论留痕 trigger=push 且 ok=true', push1Run?.trigger === 'push' && push1Run?.ok === true, push1Run);
    const pushed1 = await prisma.article.findUnique({ where: { id: p1Art } });
    expect('推送成功写入 mediaId/pushDate 且 status=pushed', Boolean(pushed1?.mediaId) && Boolean(pushed1?.pushDate) && pushed1?.status === 'pushed', { m: pushed1?.mediaId, d: pushed1?.pushDate, s: pushed1?.status });

    // 7.2 最新体检不通过 → 拦下，不调微信，不写推送事实
    const p2Art = await mkArticle('推送拦截', BAD_HTML);
    const hits2 = up.hits.addDraft;
    const push2 = await api('POST', `/articles/${p2Art}/push`);
    expect('最新体检不通过 → reason=lint_failed', push2.json.ok === false && push2.json.reason === 'lint_failed', push2.json);
    expect('被拦下时未调用 addDraft', up.hits.addDraft === hits2, up.hits);
    const blocked = await prisma.article.findUnique({ where: { id: p2Art } });
    expect('被拦下时不写 mediaId/pushDate、status 保持 draft', blocked?.mediaId === '' && blocked?.pushDate === '' && blocked?.status === 'draft', { m: blocked?.mediaId, d: blocked?.pushDate, s: blocked?.status });
    expect('拦下也留痕（trigger=push, ok=false）', (push2.json.lintRun as { ok?: boolean; trigger?: string } | null)?.trigger === 'push' && (push2.json.lintRun as { ok?: boolean }).ok === false, push2.json.lintRun);

    // 7.3 旧体检通过、但正文已变 → 不得把旧结论当最新（门禁现算）
    const p3Art = await mkArticle('旧结论失效', GOOD_HTML);
    const okCheck = await api('GET', `/articles/${p3Art}/lint`);
    expect('先存一条「通过」的历史', (okCheck.json.lintRun as { ok?: boolean } | null)?.ok === true, okCheck.json.lintRun);
    await prisma.article.update({ where: { id: p3Art }, data: { contentHtml: BAD_HTML, contentWechat: '<p>x</p>' } });
    const hits3 = up.hits.addDraft;
    const push3 = await api('POST', `/articles/${p3Art}/push`);
    expect('正文已变 → 旧「通过」不被采信，推送被拦', push3.json.ok === false && push3.json.reason === 'lint_failed', push3.json);
    expect('此路径同样零 addDraft', up.hits.addDraft === hits3, up.hits);
    const runs3 = await listLintRuns(p3Art);
    expect('历史里同时存在「通过(check)」与「拦下(push)」两条', runs3.filter((r) => r.trigger === 'check' && r.ok).length === 1 && runs3.filter((r) => r.trigger === 'push' && !r.ok).length === 1, runs3.map((r) => `${r.trigger}:${r.ok}`));

    // 7.4 已有 mediaId / pushDate → 拒绝重复推送，字段一字不改
    const traceArt = await mkArticle('重复推送', GOOD_HTML);
    await prisma.article.update({ where: { id: traceArt }, data: { mediaId: 's54-old-media', pushDate: '2026-11-16', status: 'pushed' } });
    const hits4 = up.hits.addDraft;
    const dupPush = await api('POST', `/articles/${traceArt}/push`);
    expect('已有推送痕迹 → reason=already_pushed、everPushed=true', dupPush.json.reason === 'already_pushed' && dupPush.json.everPushed === true, dupPush.json);
    expect('重复推送零 addDraft', up.hits.addDraft === hits4, up.hits);
    const traceAfter = await prisma.article.findUnique({ where: { id: traceArt } });
    expect('推送事实（mediaId/pushDate/status）一字未改', traceAfter?.mediaId === 's54-old-media' && traceAfter?.pushDate === '2026-11-16' && traceAfter?.status === 'pushed', traceAfter);
    const traceRuns = await prisma.taskRun.count({ where: { articleId: traceArt } });
    expect('被拒的重复推送不产生 TaskRun 流水（未进入推送流程）', traceRuns === 0, traceRuns);

    // 7.4b 只有 pushDate（mediaId 为空）也算「曾经送达」——判据是两字段任一非空，不是 status
    const traceDateOnly = await mkArticle('仅 pushDate', GOOD_HTML);
    await prisma.article.update({ where: { id: traceDateOnly }, data: { pushDate: '2026-11-14' } });
    const hits4b = up.hits.addDraft;
    const dupPush2 = await api('POST', `/articles/${traceDateOnly}/push`);
    expect('只有 pushDate（mediaId 空）同样拒绝重推', dupPush2.json.reason === 'already_pushed' && dupPush2.json.everPushed === true, dupPush2.json);
    expect('此路径同样零 addDraft', up.hits.addDraft === hits4b, up.hits);

    // 7.5 并发同文章推送 → 进程内防重，只建一份草稿
    const cArt = await mkArticle('并发推送', GOOD_HTML);
    const hits5 = up.hits.addDraft;
    const [cp1, cp2] = await Promise.all([api('POST', `/articles/${cArt}/push`), api('POST', `/articles/${cArt}/push`)]);
    const okCnt = [cp1, cp2].filter((x) => x.json.ok === true).length;
    const pushingCnt = [cp1, cp2].filter((x) => x.json.reason === 'pushing').length;
    expect('并发两次：恰好一次成功、一次 reason=pushing', okCnt === 1 && pushingCnt === 1, { a: cp1.json, b: cp2.json });
    expect('并发只建一份草稿（addDraft 只 +1）', up.hits.addDraft === hits5 + 1, up.hits);

    // 7.6 首次推送失败 → status=failed、无推送事实、TaskRun 记 errcode；修好后可重试成功
    const fArt = await mkArticle('首推失败', GOOD_HTML);
    up.failAddDraft = 1;
    const failPush = await api('POST', `/articles/${fArt}/push`);
    expect('首推失败：ok=false、errcode=40164、everPushed=false', failPush.json.ok === false && failPush.json.errcode === 40164 && failPush.json.everPushed === false, failPush.json);
    const failedRow = await prisma.article.findUnique({ where: { id: fArt } });
    expect('从未送达 → status 降级 failed，mediaId/pushDate 仍为空', failedRow?.status === 'failed' && failedRow?.mediaId === '' && failedRow?.pushDate === '', failedRow);
    const failRun = await prisma.taskRun.findFirst({ where: { articleId: fArt, jobType: 'push' }, orderBy: { id: 'desc' } });
    expect('TaskRun 记录失败与 errcode', failRun?.status === 'failed' && failRun?.errorCode === '40164', { s: failRun?.status, c: failRun?.errorCode });
    const retryPush = await api('POST', `/articles/${fArt}/push`);
    expect('失败不产生推送事实 → 修好后重试成功', retryPush.json.ok === true, retryPush.json);
    const retryRow = await prisma.article.findUnique({ where: { id: fArt } });
    expect('重试成功写入推送事实', Boolean(retryRow?.mediaId) && retryRow?.status === 'pushed', retryRow);

    // 7.7 有推送事实的文章即使凭据异常也不走推送流程（事实优先于凭据判断）
    const badCred = await mkArticle('凭据异常', GOOD_HTML);
    await prisma.article.update({ where: { id: badCred }, data: { mediaId: 's54-keep', pushDate: '2026-11-15' } });
    await prisma.oAAccount.update({ where: { id: acc.id }, data: { credStatus: 'invalid' } });
    const hits7 = up.hits.addDraft;
    const pushCred = await api('POST', `/articles/${badCred}/push`);
    expect('推送事实优先于凭据校验（仍 already_pushed）', pushCred.json.reason === 'already_pushed', pushCred.json);
    await prisma.oAAccount.update({ where: { id: acc.id }, data: { credStatus: 'ok' } });
    const credArt = await mkArticle('无凭据', GOOD_HTML);
    await prisma.oAAccount.update({ where: { id: acc.id }, data: { credStatus: 'invalid' } });
    const pushNoCred = await api('POST', `/articles/${credArt}/push`);
    expect('凭据不 ok → reason=cred_not_ok 且零外呼', pushNoCred.json.reason === 'cred_not_ok' && up.hits.addDraft === hits7, pushNoCred.json);
    await prisma.oAAccount.update({ where: { id: acc.id }, data: { credStatus: 'ok' } });

    // 7.8 封面配了但文件不存在 → 推无封面草稿并**显式**返回 coverMissing（不静默）
    const coverArt = await mkArticle('封面缺失', GOOD_HTML, { coverPath: 'covers/s54-nonexistent.png' });
    const uploadBefore = up.hits.upload;
    const coverPush = await api('POST', `/articles/${coverArt}/push`);
    expect('封面文件缺失时仍推成（草稿箱无封面）', coverPush.json.ok === true, coverPush.json);
    expect('显式返回 coverMissing=true 且上传零调用', coverPush.json.coverMissing === true && up.hits.upload === uploadBefore, { coverMissing: coverPush.json.coverMissing, hits: up.hits });

    // ════════ 八 原有流程回归 ════════
    section('八 原有流程回归（选题 / 占题 / 回收 / 排产）');

    // 8.1 选题：新增 → 候选；未审核不得用于建稿
    // 三条题面刻意写成互不相似的自然句：判重是 L0/L1 文本相似（同赛道内 88% 就会拦），
    // 用同一模板加编号的写法会被自己的判重规则挡住，那不是被测代码的问题。
    const A1_TEXT = '小区门口那盏总也不换的灯，昨天傍晚终于被人换成了暖黄色';
    const A2_TEXT = '便利店夜班店员递热豆浆时顺手多给了一根吸管';
    const A3_TEXT = '地铁口卖花的阿姨今天多送了一支满天星，说卖不完也是扔掉';
    const ang1 = await api('POST', '/angles', { trackId: track.id, content: A1_TEXT });
    expect('选题新增 201 且进入 candidate', ang1.status === 201 && ang1.json.status === 'candidate', ang1.json);
    const angle1Id = Number(ang1.json.id);
    created.angleIds.push(angle1Id);
    const badCreate = await api('POST', '/articles', { contentHtml: GOOD_HTML, trackId: track.id, accountId: acc.id, angleId: angle1Id });
    expect('候选选题不得直接建稿（400 审核门）', badCreate.status === 400, badCreate);

    // 8.2 审核通过 → approved；重复审核被终态拒绝
    const appr = await api('POST', `/angles/${angle1Id}/review`, { verdict: 'approved', reason: 'S5-4 验证通过' });
    expect('审核通过接口 200 且状态 approved', appr.status === 200 && (appr.json.item as { status?: string } | undefined)?.status === 'approved', appr.json);
    const apprAgain = await api('POST', `/angles/${angle1Id}/review`, { verdict: 'approved' });
    expect('approved 为终态，再次审核被拒（400）', apprAgain.status === 400, apprAgain);

    // 8.3 建稿占题 + 重复占题 409
    const claimArt = await api('POST', '/articles', { contentHtml: GOOD_HTML, trackId: track.id, accountId: acc.id, angleId: angle1Id });
    expect('approved 选题可建稿（201）', claimArt.status === 201, claimArt);
    const claimArticleId = Number(claimArt.json.id);
    created.articleIds.push(claimArticleId);
    const angleAfterClaim = await prisma.angle.findUnique({ where: { id: angle1Id } });
    expect('建稿即占题（used=true，占用者=本账号）', angleAfterClaim?.used === true && angleAfterClaim?.usedByAccountId === acc.id, { used: angleAfterClaim?.used, by: angleAfterClaim?.usedByAccountId });
    const dupClaim = await api('POST', '/articles', { contentHtml: GOOD_HTML, trackId: track.id, accountId: acc.id, angleId: angle1Id });
    expect('同一选题重复建稿被拒（409）', dupClaim.status === 409, dupClaim);

    // 8.4 删稿归还（未送达微信 → 归还）
    const delClaim = await api('DELETE', `/articles/${claimArticleId}`);
    expect('删除文章 200', delClaim.status === 200, delClaim);
    created.articleIds = created.articleIds.filter((x) => x !== claimArticleId);
    const angleAfterDel = await prisma.angle.findUnique({ where: { id: angle1Id } });
    expect('未推送文章删除后选题归还（used=false）', angleAfterDel?.used === false, { used: angleAfterDel?.used });

    // 8.5 已推送文章删除 → 不归还（防同题重写）
    const pushedDel = await api('DELETE', `/articles/${p1Art}`);
    expect('已推送文章可删除（200）', pushedDel.status === 200, pushedDel);
    created.articleIds = created.articleIds.filter((x) => x !== p1Art);

    // 8.6 选题去重：同内容再新增 → 400
    const dupAngle = await api('POST', '/angles', { trackId: track.id, content: A1_TEXT });
    expect('重复选题被 L0/L1 判重拦下（400）', dupAngle.status === 400, dupAngle);

    // 8.7 排产：2 条 approved 选题 → 触发建稿 2 篇，占题成功
    for (const [idx, text] of [A2_TEXT, A3_TEXT].entries()) {
      const r = await api('POST', '/angles', { trackId: track.id, content: text });
      expect(`排产用选题（第 ${idx + 2} 条）新增成功`, r.status === 201, r);
      created.angleIds.push(Number(r.json.id));
      const ap = await api('POST', `/angles/${r.json.id}/review`, { verdict: 'approved' });
      expect(`排产用选题（第 ${idx + 2} 条）审核通过`, ap.status === 200, ap);
    }
    up.chatReply = GOOD_HTML.replace('验证用标题', '排产草稿标题');
    const planGet = await api('GET', `/plan?account=${encodeURIComponent(acc.name)}`);
    expect('今日计划接口 200', planGet.status === 200, planGet.status);
    const trig = await api('POST', '/plan/trigger', { accountId: acc.id, count: 2 });
    expect('排产触发 200 且生成 2 篇草稿', trig.status === 200 && (trig.json.created as unknown[]).length === 2, trig.json);
    const createdFromPlan = (trig.json.created as Array<{ id: number }>).map((c) => c.id).filter((x) => x > 0);
    created.articleIds.push(...createdFromPlan);
    const usedAngles = await prisma.angle.count({ where: { trackId: track.id, used: true } });
    expect('排产消费的选题被占用（used=true）', usedAngles >= 2, usedAngles);
    const writeRun = await prisma.taskRun.findFirst({ where: { accountId: acc.id, jobType: 'write' }, orderBy: { id: 'desc' } });
    expect('排产留 write 任务流水且 status=success', writeRun?.status === 'success', writeRun?.status);
    const planArticles = await prisma.article.findMany({ where: { id: { in: createdFromPlan } }, select: { angleId: true, pipeline: true } });
    expect('排产文章挂在被消费的选题上（angleId 非空）', planArticles.every((p) => p.angleId != null && p.pipeline === 'article'), planArticles);

    // 8.8 排产无题：新赛道无 approved 选题 → 明确报「角度池已空」，且不留下 used 泄漏
    const track2 = await prisma.track.create({
      data: { name: `S5-4空池赛道-${stamp}`, slug: `s54b-${stamp}`, quotaPerDay: 2, enabled: true },
    });
    created.trackIds.push(track2.id);
    const acc2 = await prisma.oAAccount.create({
      data: {
        trackId: track2.id,
        name: `S5-4空池账号-${stamp}`,
        appid: `s54b-appid-${stamp}`,
        secretEnc: encryptSecret('s54-fake-secret-2'),
        secretMask: '***',
        credStatus: 'ok',
        enabled: true,
      },
    });
    created.accountIds.push(acc2.id);
    const trig2 = await api('POST', '/plan/trigger', { accountId: acc2.id, count: 1 });
    expect('空池排产：created=0 且给出可读原因', trig2.status === 200 && (trig2.json.created as unknown[]).length === 0 && String(trig2.json.message ?? '').includes('角度池已空'), trig2.json);
    const leak = await prisma.angle.count({ where: { trackId: track2.id, used: true } });
    expect('空池排产不产生任何 used 泄漏', leak === 0, leak);

    // 8.9 图片产线不受影响：漫画文章在预览/体检接口上按约定返回 null
    const comicArt = await prisma.article.create({
      data: {
        trackId: track.id, accountId: acc.id, pipeline: 'comic', title: `S5-4漫画占位-${stamp}`,
        contentHtml: '<h1>漫画脚本</h1><h2>第1格</h2><p>台词。</p>', contentWechat: '',
        idempotencyKey: `s54-comic-${stamp}`, status: 'draft', pushDate: '',
      },
    });
    created.articleIds.push(comicArt.id);
    const comicLint = await api('GET', `/articles/${comicArt.id}/lint`);
    expect('漫画产线体检接口返回 lint=null、lintRun=null（不套文章规则）', comicLint.status === 200 && comicLint.json.lint === null && comicLint.json.lintRun === null, comicLint.json);
    const comicRuns = await api('GET', `/articles/${comicArt.id}/lint-runs`);
    expect('漫画产线历史接口返回空数组', comicRuns.status === 200 && (comicRuns.json.items as unknown[]).length === 0, comicRuns.json);

    // ════════ 九 清理 ════════
    section('九 测试数据清理（按主键精确删除）');

    const before = await prisma.articleLintRun.count({ where: { articleId: { in: created.articleIds } } });
    console.log(`  本轮体检记录 ${before} 条、文章 ${created.articleIds.length} 篇待清理`);

    const removed = await cleanup(prisma, created);
    console.log(`  删除行数：${JSON.stringify(removed)}`);

    // 只对本轮「一定有」的实体断言删除数 > 0；comicPanel / wechatToken / taskRun 允许为 0
    for (const k of ['articleLintRun', 'article', 'modelBinding', 'llmModel', 'account', 'trackPipeline', 'track']) {
      expect(`清理项 ${k} 确实删到了本轮数据（>0）`, (removed[k] ?? 0) > 0, removed);
    }

    const after = await snapshot(prisma);
    const diffs = Object.entries(after).filter(([t, c]) => baseline![t] !== c);
    expect('清理后逐表行数与测试前基线完全一致（无遗留测试数据）', diffs.length === 0, diffs);

    const cursorAfter = await prisma.setting.findUnique({ where: { k: 'style_variant_cursor' } });
    expect(
      '变体游标行已恢复/清除（不留下测试赛道键）',
      created.cursorBefore === null ? cursorAfter === null : cursorAfter?.v === created.cursorBefore,
      { before: created.cursorBefore, after: cursorAfter?.v ?? null },
    );

    // 二次核验：本轮标识的数据一条不剩
    const leftover = {
      track: await prisma.track.count({ where: { slug: { contains: `s54-${stamp}` } } }),
      account: await prisma.oAAccount.count({ where: { appid: { contains: `s54` } } }),
      article: await prisma.article.count({ where: { idempotencyKey: { contains: `s54-${stamp}` } } }),
      model: await prisma.llmModel.count({ where: { name: { contains: `S5-4验证模型-${stamp}` } } }),
      binding: await prisma.modelBinding.count({ where: { modelId: { in: created.modelIds } } }),
    };
    expect('按 s54 标识复查：零遗留', Object.values(leftover).every((v) => v === 0), leftover);

    console.log(`\n══ 全部通过：${passed} 项断言 ══`);
    console.log(
      'S54-SUMMARY ' +
        JSON.stringify({
          passed,
          db: id.db,
          user: id.usr,
          version: id.ver,
          baseline,
          after,
          created,
          removed,
          mockHits: up.hits,
        }),
    );
  } finally {
    // 兜底清理：任何中途失败也按同一套精确删除收尾（清理本身失败不掩盖原错误）
    try {
      await cleanup(prisma, created);
    } catch (e) {
      console.error('兜底清理失败（需人工核对）：', e instanceof Error ? e.message : e);
    }
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await prisma.$disconnect();
  }
}

/** 按主键精确删除本轮数据；顺序遵守外键依赖（先子后父）。 */
async function cleanup(
  prisma: any,
  created: {
    trackIds: number[];
    pipelineIds: number[];
    accountIds: number[];
    modelIds: number[];
    angleIds: number[];
    articleIds: number[];
    cursorBefore?: string | null;
  },
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { articleIds, angleIds, accountIds, trackIds, modelIds, pipelineIds } = created;
  const del = async (key: string, fn: () => Promise<{ count: number }>): Promise<void> => {
    try {
      const r = await fn();
      out[key] = (out[key] ?? 0) + r.count;
    } catch {
      out[key] = out[key] ?? 0;
    }
  };
  if (articleIds.length > 0) {
    await del('articleLintRun', () => prisma.articleLintRun.deleteMany({ where: { articleId: { in: articleIds } } }));
    await del('taskRun', () => prisma.taskRun.deleteMany({ where: { articleId: { in: articleIds } } }));
    await del('comicPanel', () => prisma.comicPanel.deleteMany({ where: { articleId: { in: articleIds } } }));
    await del('article', () => prisma.article.deleteMany({ where: { id: { in: articleIds } } }));
  }
  if (angleIds.length > 0) {
    await del('topicReview', () => prisma.topicReview.deleteMany({ where: { angleId: { in: angleIds } } }));
    await del('angle', () => prisma.angle.deleteMany({ where: { id: { in: angleIds } } }));
  }
  if (accountIds.length > 0) {
    await del('taskRunByAccount', () => prisma.taskRun.deleteMany({ where: { accountId: { in: accountIds } } }));
    await del('wechatToken', () => prisma.wechatToken.deleteMany({ where: { accountId: { in: accountIds } } }));
  }
  if (modelIds.length > 0) {
    await del('modelBinding', () => prisma.modelBinding.deleteMany({ where: { modelId: { in: modelIds } } }));
    await del('llmModel', () => prisma.llmModel.deleteMany({ where: { id: { in: modelIds } } }));
  }
  if (pipelineIds.length > 0) {
    await del('trackPipeline', () => prisma.trackPipeline.deleteMany({ where: { id: { in: pipelineIds } } }));
  }
  if (accountIds.length > 0) {
    await del('account', () => prisma.oAAccount.deleteMany({ where: { id: { in: accountIds } } }));
  }
  if (trackIds.length > 0) {
    await del('track', () => prisma.track.deleteMany({ where: { id: { in: trackIds } } }));
  }
  // 变体游标恢复：本轮开始前存在就写回原值，不存在就删掉本轮新建的那一行。
  if ('cursorBefore' in created) {
    if (created.cursorBefore) {
      await prisma.setting.updateMany({ where: { k: 'style_variant_cursor' }, data: { v: created.cursorBefore } });
    } else {
      await del('variantCursor', () => prisma.setting.deleteMany({ where: { k: 'style_variant_cursor' } }));
    }
  }
  return out;
}

main()
  .catch((e) => {
    console.error('\nS5-4 集成验证失败：', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  })
  .finally(() => {
    // express / 假上游服务器持有事件循环，显式退出（与 smoke-push 同款）
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
