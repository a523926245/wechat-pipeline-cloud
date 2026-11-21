/**
 * 文风配置路由：创作总纲 + 赛道文体 + 三维变体库 的增删改查。
 *
 * 前端「文风配置」页走这里；写稿（writer.ts）与题库扩库（angles.ts）经
 * services/style-prompts.ts 读同一份数据——配置页改完即生效，不用改代码。
 *
 * key 形态：'global' | '{赛道名}' | 'v:global:{dim}' | 'v:{赛道}:{dim}'（dim ∈ title|structure|length）。
 *
 * ⚠️ Express 路由顺序：`/defaults`、`/cursor` 必须注册在 `/:key` 之前，否则会被当成 key 吃掉。
 */

import { Router } from 'express';
import { z } from 'zod';

import { BadRequestError, NotFoundError } from '../../errors.ts';
import {
  allDefaults,
  defaultFor,
  deleteStylePrompt,
  getStylePrompt,
  getVariantCursors,
  listStylePrompts,
  upsertStylePrompt,
} from '../../services/style-prompts.ts';
import { asyncHandler } from '../async-handler.ts';
import { requirePermission } from '../permissions.ts';

export const stylePromptsRouter: Router = Router();

// P2 RBAC：本路由统一权限点
stylePromptsRouter.use(requirePermission('system:manage'));

const keyParam = z
  .string()
  .trim()
  .min(1, 'key 不能为空')
  .max(64, 'key 最长 64 字符')
  .regex(/^[^/\\]+$/, 'key 不能包含斜杠');

const upsertSchema = z.object({
  prompt: z.string().max(20000, '配置文本最长 20000 字符'),
});

/** 出厂默认值（「恢复默认」按钮用）。必须在 /:key 之前注册。 */
stylePromptsRouter.get(
  '/defaults',
  asyncHandler(async (_req, res) => {
    res.json(allDefaults());
  }),
);

/** 变体轮换游标（配置页显示「下次取第几条」）。只读，不推进。必须在 /:key 之前注册。 */
stylePromptsRouter.get(
  '/cursor',
  asyncHandler(async (_req, res) => {
    res.json({ cursors: await getVariantCursors() });
  }),
);

stylePromptsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await listStylePrompts();
    res.json({ total: items.length, items });
  }),
);

stylePromptsRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    const item = await getStylePrompt(key);
    if (!item) throw new NotFoundError(`配置项不存在：${key}`);
    res.json(item);
  }),
);

stylePromptsRouter.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    const { prompt } = upsertSchema.parse(req.body);
    const item = await upsertStylePrompt(key, prompt);
    res.json(item);
  }),
);

stylePromptsRouter.delete(
  '/:key',
  asyncHandler(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    try {
      await deleteStylePrompt(key);
    } catch (e) {
      // 总纲不可删是业务约束，不是服务器错误
      throw new BadRequestError(e instanceof Error ? e.message : '删除失败');
    }
    res.json({ ok: true, key });
  }),
);

/** 某 key 的出厂默认值；自定义 key 无默认则 404。 */
stylePromptsRouter.get(
  '/:key/default',
  asyncHandler(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    const d = defaultFor(key);
    if (!d) throw new NotFoundError(`该配置没有出厂默认值：${key}`);
    res.json({ key, ...d });
  }),
);
