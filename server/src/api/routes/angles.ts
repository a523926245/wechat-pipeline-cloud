/**
 * 选题路由：选题角度池明细的查看 / 新增 / 编辑 / 删除。
 *
 * 背景：角度池此前只能「扩库」和「看计数」，界面上只有「96/105」这种聚合数字，
 * 看不到任何一条选题正文，也无法修正模型生成得不好的条目。这里补上明细 CRUD，
 * 让选题池从黑盒变成可运营的资产。
 *
 * 两条硬约束：
 *   1. 消费态（used / usedBy / usedDate）由排产与文章删除逻辑维护，
 *      本路由不接受外部改写（updateSchema 里根本没有这些字段）。
 *   2. 删除允许删「已用」选题——文章正文保留，仅解除关联；
 *      但必须把关联文章数返回给前端，由前端做强提示后再确认。
 *
 * 路由顺序：`/`、`/bulk` 这类固定路径必须排在 `/:id(\d+)` 之前，
 * 否则具体子路径会被当成 id 转 NaN（models.ts 已踩过这个坑）。
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  createAngle,
  deleteAngle,
  getAngle,
  listAngles,
  reassignOffIpAngles,
  releaseAngle,
  updateAngle,
} from '../../services/angles.ts';
import { asyncHandler } from '../async-handler.ts';

export const anglesRouter: Router = Router();

const ID_PATH = '/:id(\\d+)';
const idParam = z.coerce.number().int().positive();

/**
 * 角度切片（article / comic / shared）决定哪条产线能消费这条选题。
 * 与产线 kind 用同一套枚举，别在路由里另起炉灶。
 */
const scopeField = z.enum(['article', 'comic', 'shared']);

const listQuery = z.object({
  trackId: z.coerce.number().int().positive(),
  used: z.enum(['unused', 'used', 'all']).optional().default('all'),
  scope: scopeField.optional(),
  /** offIp=1 只看含 IP 外角色的选题（漫画产线治理）。 */
  offIp: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional(),
  keyword: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createSchema = z.object({
  trackId: z.number().int().positive(),
  theme: z.string().trim().max(64).optional(),
  content: z.string().trim().min(1, '选题内容不能为空').max(500),
  source: z.string().trim().max(64).optional(),
  scope: scopeField.optional(),
});

const updateSchema = z.object({
  theme: z.string().trim().max(64).optional(),
  content: z.string().trim().min(1, '选题内容不能为空').max(500).optional(),
  scope: scopeField.optional(),
});

/** 列表：按赛道 + 使用状态 + 切片 + 关键词过滤，分页返回明细。 */
anglesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const result = await listAngles({
      trackId: q.trackId,
      used: q.used,
      scope: q.scope,
      offIp: q.offIp === '1' || q.offIp === 'true',
      keyword: q.keyword,
      limit: q.limit,
      offset: q.offset,
    });
    res.json(result);
  }),
);

/** 手动新增一条选题（seq 自动取当前最大值 +1）。 */
anglesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const item = await createAngle({
      trackId: body.trackId,
      theme: body.theme,
      content: body.content,
      source: body.source,
      scope: body.scope,
    });
    res.status(201).json({ ...item, message: '选题已新增' });
  }),
);

/**
 * 把漫画切片里含 IP 外角色的选题批量退回「文章专用」。
 * 放在 `/:id(\d+)` 之前（字母路径不会被数字约束匹配，但仍按项目约定前置）。
 */
anglesRouter.post(
  '/off-ip-to-article',
  asyncHandler(async (req, res) => {
    const body = z.object({ trackId: z.number().int().positive() }).parse(req.body ?? {});
    res.json(await reassignOffIpAngles(body.trackId));
  }),
);

/** 详情。删除前前端会再来拉一次，避免用列表里的过期数据做提示（防重入靠最新值）。 */
anglesRouter.get(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    res.json(await getAngle(id));
  }),
);

/** 编辑：只允许改 theme / content / scope（消费态不可改）。 */
anglesRouter.put(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateSchema.parse(req.body);
    const item = await updateAngle(id, body);
    res.json({ ...item, message: '已保存' });
  }),
);

/**
 * 归还：把「已用但已无任何文章引用」的孤儿选题重置回未用池。
 * 典型场景：已推送的文章被删除后，按设计角度不自动归还（防同题重写），由人决定是否回收。
 */
anglesRouter.post(
  '/:id(\\d+)/release',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    res.json(await releaseAngle(id));
  }),
);

/** 删除：解除文章关联后删除选题，返回被解除关联的文章数供前端提示。 */
anglesRouter.delete(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    res.json(await deleteAngle(id));
  }),
);
