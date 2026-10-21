/**
 * 系统级路由：健康检查、版本信息。
 */

import { Router } from 'express';
import { z } from 'zod';

import { AUTO_PUBLISH } from '../../constants.ts';
import { IS_SQLITE, NODE_ENV } from '../../config.ts';
import { checkDb, prisma } from '../../db.ts';
import { BadRequestError } from '../../errors.ts';
import { ANGLE_SCOPE_META, PIPELINES, PIPELINE_SPEC } from '../../services/pipeline.ts';
import { asyncHandler } from '../async-handler.ts';

export const systemRouter: Router = Router();

systemRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const db = await checkDb();
    res.json({
      ok: db,
      env: NODE_ENV,
      db: db ? 'up' : 'down',
      driver: IS_SQLITE ? 'sqlite' : 'mysql',
      // 暴露出来是为了让运维一眼确认红线没被打开
      autoPublish: AUTO_PUBLISH,
      time: new Date().toISOString(),
    });
  }),
);

systemRouter.get('/version', (_req, res) => {
  res.json({ name: 'wechat-pipeline-cloud', node: process.version });
});

/**
 * 产线与角度切片的元数据下发（前端禁止硬编码产线文案，一律走这里）。
 */
systemRouter.get('/pipelines', (_req, res) => {
  res.json({
    pipelines: PIPELINES.map((k) => PIPELINE_SPEC[k]),
    angleScopes: (['article', 'comic', 'shared'] as const).map((s) => ({
      value: s,
      label: ANGLE_SCOPE_META[s].label,
      desc: ANGLE_SCOPE_META[s].desc,
    })),
  });
});

/**
 * 内容标题前缀（文章 / 漫画各一个）。
 *
 * 为什么要有接口：前缀可直接决定用户看到的文章标题，此前只能改库；
 * 而且它还是**迁移污染的重灾区**——旧流水线 config.json 里的 title_prefix 曾被
 * 原样 upsert 进来（值「【冒烟】」），于是所有新草稿标题都带【冒烟】。
 * 现在 migrate 只在缺失时写入，运行期由这里读写。
 */
const PREFIX_SPEC: Record<string, { def: string; desc: string }> = {
  title_prefix: { def: '【话】', desc: '文章产线标题前缀，渲染与推送时幂等添加' },
  comic_title_prefix: { def: '【漫】', desc: '漫画产线标题前缀，建稿时幂等添加' },
};

const prefixSchema = z
  .object({
    title_prefix: z.string().trim().min(1, '前缀不能为空').max(12, '前缀不要超过 12 个字').optional(),
    comic_title_prefix: z.string().trim().min(1, '前缀不能为空').max(12, '前缀不要超过 12 个字').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个前缀' });

systemRouter.get(
  '/content-prefixes',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.setting.findMany({ where: { k: { in: Object.keys(PREFIX_SPEC) } } });
    const byKey = new Map(rows.map((r) => [r.k, r.v] as const));
    const items = Object.entries(PREFIX_SPEC).map(([k, spec]) => ({
      key: k,
      value: byKey.get(k) ?? spec.def,
      default: spec.def,
      desc: spec.desc,
    }));
    res.json({ items });
  }),
);

systemRouter.put(
  '/content-prefixes',
  asyncHandler(async (req, res) => {
    const body = prefixSchema.parse(req.body ?? {});
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string') continue;
      const spec = PREFIX_SPEC[k];
      if (!spec) throw new BadRequestError(`未知的前缀设置 ${k}`);
      await prisma.setting.upsert({
        where: { k },
        create: { k, v, kind: 'string', readonly: false, desc: spec.desc },
        update: { v, kind: 'string', readonly: false, desc: spec.desc },
      });
    }
    const rows = await prisma.setting.findMany({ where: { k: { in: Object.keys(PREFIX_SPEC) } } });
    const byKey = new Map(rows.map((r) => [r.k, r.v] as const));
    res.json({
      items: Object.entries(PREFIX_SPEC).map(([k, spec]) => ({
        key: k,
        value: byKey.get(k) ?? spec.def,
        default: spec.def,
        desc: spec.desc,
      })),
      message: '已保存。已生成文章的标题不受影响，下次渲染/建稿时生效',
    });
  }),
);
