/**
 * 模型配置路由：LlmModel 的增删改查 + 连通测试 + 角色绑定。
 *
 * 安全约束（与凭据一致）：
 * - apiKey 明文只在请求体出现，落库一律 encryptSecret 加密；
 * - 列表/详情只返 apiKeyMask，绝不返回 apiKeyEnc 字节或明文；
 * - 连通测试失败信息经 scrub 脱敏，不会把 Key 写进响应或日志。
 *
 * ⚠️ 路由注册顺序很重要：所有具体子路径（/meta、/bindings*、/resolve/:role）
 *   必须排在通配的 /:id 之前。此前 /bindings 注册在 /:id 之后，请求
 *   GET /api/models/bindings 会先命中 /:id，把 "bindings" 当成 id 转成 NaN，
 *   报「请求参数：Expected number, received nan」，整个模型页都因此空白。
 *   现在除顺序外，还给 /:id 加了 (\d+) 约束作为第二道保险。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { asyncHandler } from '../async-handler.ts';
import { bulkDeleteSchema, runBulkDelete } from '../bulk-delete.ts';
import { requirePermission } from '../permissions.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { encryptSecret, maskSecret } from '../../lib/crypto.ts';
import { packJson, unpackJson } from '../../db-json.ts';
import { testModel, tryResolveForRole } from '../../services/llm.ts';
import {
  CAPABILITY_SPEC,
  DEFAULT_IMAGE_PARAMS,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  PROTOCOL_SPEC,
  ROLES,
  ROLE_SPEC,
  VENDOR_PRESETS,
  capabilitySchema,
  isProtocolImplemented,
  protocolKind,
  roleAcceptsModel,
  roleSchema,
  protocolLabel,
  protocolSchema,
  vendorSchema,
} from '../../services/model-registry.ts';

const modelsRouter = Router();

// P2 RBAC：/meta 是前端标签下发（登录即可）；模型配置本体 admin only
modelsRouter.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/meta') {
    return requirePermission('data:view')(req, res, next);
  }
  return requirePermission('system:manage')(req, res, next);
});

/** 通配段带数字约束：即使将来有人把子路径插错位置，"bindings" 也不会被当成 id。 */
const ID_PATH = '/:id(\\d+)';

const idParam = z.coerce
  .number({ invalid_type_error: '模型 ID 必须是正整数' })
  .int('模型 ID 必须是正整数')
  .positive('模型 ID 必须是正整数');

/** 协议 ↔ 能力的交叉校验：避免存进「生图协议 + 文本能力」这种矛盾组合。 */
function refineProtocolCapability(
  v: { protocol?: string; capability?: string; paramsJson?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  if (v.protocol && !isProtocolImplemented(v.protocol)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protocol'],
      message: `协议「${protocolLabel(v.protocol)}」尚未实现，暂不可选用`,
    });
    return;
  }

  if (v.protocol && v.capability) {
    const kind = protocolKind(v.protocol);
    if (kind === 'chat' && v.capability !== 'text' && v.capability !== 'multimodal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: `「${protocolLabel(v.protocol)}」是对话协议，能力应选「文本」或「多模态」`,
      });
    }
    if (kind === 'image' && v.capability !== 'image') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: `「${protocolLabel(v.protocol)}」是生图协议，能力应选「图像」`,
      });
    }
    if (kind === 'video' && v.capability !== 'video') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: `「${protocolLabel(v.protocol)}」是视频协议，能力应选「视频」`,
      });
    }
  }

  // null = 删除该参数（合并语义），跳过校验
  const size = v.paramsJson?.size;
  if (size !== undefined && size !== null && !(IMAGE_SIZES as readonly unknown[]).includes(size)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paramsJson', 'size'],
      message: `生成尺寸只能是 ${IMAGE_SIZES.join(' / ')}`,
    });
  }
  const ratio = v.paramsJson?.ratio;
  if (ratio !== undefined && ratio !== null && !(IMAGE_RATIOS as readonly unknown[]).includes(ratio)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paramsJson', 'ratio'],
      message: `宽高比只能是 ${IMAGE_RATIOS.join(' / ')}`,
    });
  }
}

/** 剔除对象里的 null/undefined 值（「传 null = 删除该参数」语义用）。 */
function stripNulls(v: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!v) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== null && val !== undefined) out[k] = val;
  }
  return out;
}

const baseSchema = z.object({
  name: z.string().trim().min(1, '请填写模型名称').max(64),
  vendor: vendorSchema.default('custom'),
  protocol: protocolSchema,
  capability: capabilitySchema,
  baseUrl: z.string().trim().min(1, '请填写 Base URL').max(255),
  modelId: z.string().trim().min(1, '请填写模型 ID').max(128),
  apiKey: z.string().max(512).optional().default(''),
  paramsJson: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
});

const createSchema = baseSchema.superRefine(refineProtocolCapability);

const updateSchema = baseSchema.partial().superRefine((v, ctx) => {
  if (v.protocol && v.capability) refineProtocolCapability(v, ctx);
  else if (v.paramsJson) refineProtocolCapability({ paramsJson: v.paramsJson }, ctx);
});

interface ModelRow {
  id: number;
  name: string;
  vendor: string;
  protocol: string;
  capability: string;
  baseUrl: string;
  modelId: string;
  apiKeyMask: string;
  paramsJson: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 把库实体映射成对外安全视图（剔除 apiKeyEnc 字节）。 */
function toView(m: ModelRow, boundRoles: string[] = []) {
  return {
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    protocol: m.protocol,
    capability: m.capability,
    baseUrl: m.baseUrl,
    modelId: m.modelId,
    apiKeyMask: m.apiKeyMask ?? '',
    paramsJson: unpackJson<Record<string, unknown>>(m.paramsJson) ?? {},
    enabled: m.enabled,
    boundRoles,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function bindRoleText(rows: { role: string; modelId: number }[]): Map<number, string[]> {
  const byModel = new Map<number, string[]>();
  for (const r of rows) {
    const arr = byModel.get(r.modelId) ?? [];
    arr.push(r.role);
    byModel.set(r.modelId, arr);
  }
  return byModel;
}

// ── 元数据（供应商/协议/能力/角色的候选项与中文标签，避免前端再硬编码一份） ──

modelsRouter.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    res.json({
      vendors: VENDOR_PRESETS,
      protocols: PROTOCOL_SPEC.map((p) => ({
        value: p.value,
        label: p.label,
        kind: p.kind,
        implemented: p.implemented,
      })),
      capabilities: CAPABILITY_SPEC,
      roles: ROLES.map((r) => {
        const s = ROLE_SPEC[r];
        return {
          role: s.role,
          label: s.label,
          desc: s.desc,
          capabilities: s.capabilities,
          protocols: s.protocols,
          kind: s.kind,
          active: s.active,
        };
      }),
      imageDefaults: {
        size: DEFAULT_IMAGE_PARAMS.size,
        ratio: DEFAULT_IMAGE_PARAMS.ratio,
        sizes: IMAGE_SIZES,
        ratios: IMAGE_RATIOS,
      },
    });
  }),
);

// ── 角色绑定（必须在 /:id 之前） ──

modelsRouter.get(
  '/bindings',
  asyncHandler(async (_req, res) => {
    const bindings = await prisma.modelBinding.findMany({ include: { model: true } });
    const map: Record<string, { modelId: number; modelName: string } | null> = {};
    for (const r of ROLES) map[r] = null;
    for (const b of bindings) map[b.role] = { modelId: b.model.id, modelName: b.model.name };
    res.json({ bindings: map });
  }),
);

const bindSchema = z.object({ modelId: z.number().int().positive().nullable() });

modelsRouter.put(
  '/bindings/:role',
  asyncHandler(async (req, res) => {
    const role = roleSchema.parse(req.params.role);
    const { modelId } = bindSchema.parse(req.body);

    // modelId 为 null 表示解绑
    if (modelId === null) {
      await prisma.modelBinding.deleteMany({ where: { role } });
      res.json({ ok: true, role, modelId: null, modelName: null });
      return;
    }

    const m = await prisma.llmModel.findUnique({ where: { id: modelId } });
    if (!m) throw new NotFoundError(`模型 ${modelId} 不存在`);

    // 能力/协议必须与角色匹配，避免「绑得上、跑不通」。
    const match = roleAcceptsModel(role, m);
    if (!match.ok) throw new BadRequestError(match.reason ?? '该模型不满足此角色的要求');

    await prisma.modelBinding.upsert({
      where: { role },
      create: { role, modelId },
      update: { modelId },
    });
    res.json({ ok: true, role, modelId, modelName: m.name });
  }),
);

modelsRouter.delete(
  '/bindings/:role',
  asyncHandler(async (req, res) => {
    const role = roleSchema.parse(req.params.role);
    await prisma.modelBinding.deleteMany({ where: { role } });
    res.json({ ok: true, role });
  }),
);

// 便捷：解析某角色当前模型 + 是否可用（供界面解释「为什么不可用」）。
modelsRouter.get(
  '/resolve/:role',
  asyncHandler(async (req, res) => {
    const role = roleSchema.parse(req.params.role);
    const r = await tryResolveForRole(role);
    res.json({
      role,
      model: r.model ? toView(r.model) : null,
      usable: r.usable,
      reason: r.reason ?? null,
    });
  }),
);

// ── 模型 CRUD ──

/** 列表：带出每个模型绑定的全部角色（一个模型可被多个角色共用）。 */
modelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [models, bindings] = await Promise.all([
      prisma.llmModel.findMany({ orderBy: { id: 'asc' } }),
      prisma.modelBinding.findMany({ select: { role: true, modelId: true } }),
    ]);
    const byModel = bindRoleText(bindings);
    const items = models.map((m) => toView(m, byModel.get(m.id) ?? []));
    res.json({ total: items.length, items });
  }),
);

modelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    // 空白 Key 视同未填（与「留空=不修改」口径一致，防误存空格/换行）
    const apiKey = body.apiKey.trim();
    const apiKeyEnc = apiKey ? encryptSecret(apiKey) : Buffer.alloc(0);
    const created = await prisma.llmModel.create({
      data: {
        name: body.name,
        vendor: body.vendor,
        protocol: body.protocol,
        capability: body.capability,
        baseUrl: body.baseUrl,
        modelId: body.modelId,
        apiKeyEnc,
        apiKeyMask: apiKey ? maskSecret(apiKey) : '',
        paramsJson: packJson(stripNulls(body.paramsJson) ?? null),
        enabled: body.enabled,
      },
    });
    res.status(201).json(toView(created, []));
  }),
);

modelsRouter.get(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const m = await prisma.llmModel.findUnique({ where: { id } });
    if (!m) throw new NotFoundError(`模型 ${id} 不存在`);
    const bs = await prisma.modelBinding.findMany({ where: { modelId: id }, select: { role: true } });
    res.json(toView(m, bs.map((b) => b.role)));
  }),
);

modelsRouter.put(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.llmModel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError(`模型 ${id} 不存在`);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.vendor !== undefined) data.vendor = body.vendor;
    if (body.protocol !== undefined) data.protocol = body.protocol;
    if (body.capability !== undefined) data.capability = body.capability;
    if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
    if (body.modelId !== undefined) data.modelId = body.modelId;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    // paramsJson 是**合并**语义：只覆盖传入的键，未传的键（如 gradioApiName/genWidth）保留；
    // 传 null 的键表示删除（清空温度等可选参数）。
    // 同款覆写 bug 教训（2026-11-11）：整包替换会让界面表单外的参数静默丢失，MCP 模型直接坏。
    if (body.paramsJson !== undefined) {
      // ⚠️ existing.paramsJson 在库里是 JSON 字符串，必须 unpackJson 解开再合并
      const existingParams = unpackJson<Record<string, unknown>>(existing.paramsJson) ?? {};
      const merged = { ...existingParams, ...body.paramsJson };
      data.paramsJson = packJson(stripNulls(merged));
    }
    // apiKey 留空/空白=不修改（UI 约定）；只有非空才覆写密文
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
      const apiKey = body.apiKey.trim();
      data.apiKeyEnc = encryptSecret(apiKey);
      data.apiKeyMask = maskSecret(apiKey);
    }

    const updated = await prisma.llmModel.update({ where: { id }, data });
    const bs = await prisma.modelBinding.findMany({ where: { modelId: id }, select: { role: true } });
    res.json(toView(updated, bs.map((b) => b.role)));
  }),
);

/**
 * 批量删除模型。
 *
 * 复用单条删除的「先解绑再删」逻辑，避免留下悬空外键。
 * 逐条独立执行：一条失败不影响其余，失败原因原样返回。
 *
 * 路由顺序：'/bulk-delete' 是字母路径，必须排在 '/:id(\\d+)' 之前
 * （虽然 ID_PATH 的数字约束本身也能挡住，但按项目约定固定路径一律前置）。
 */
modelsRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const { ids } = bulkDeleteSchema.parse(req.body ?? {});
    const result = await runBulkDelete(
      ids,
      async (id) => {
        const existing = await prisma.llmModel.findUnique({ where: { id } });
        if (!existing) throw new NotFoundError(`模型 ${id} 不存在`);
        const bs = await prisma.modelBinding.count({ where: { modelId: id } });
        // 解除绑定后再删，避免悬空外键
        await prisma.modelBinding.deleteMany({ where: { modelId: id } });
        await prisma.llmModel.delete({ where: { id } });
        return { unboundRoles: bs };
      },
      '模型',
    );
    res.json(result);
  }),
);

modelsRouter.delete(
  ID_PATH,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const existing = await prisma.llmModel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError(`模型 ${id} 不存在`);
    // 解除绑定后再删，避免悬空外键
    await prisma.modelBinding.deleteMany({ where: { modelId: id } });
    await prisma.llmModel.delete({ where: { id } });
    res.json({ ok: true, id });
  }),
);

/** 连通测试：取库内模型（含密文），由 llm.testModel 解密后按协议真实发一次请求。 */
modelsRouter.post(
  `${ID_PATH}/test`,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const m = await prisma.llmModel.findUnique({ where: { id } });
    if (!m) throw new NotFoundError(`模型 ${id} 不存在`);
    const result = await testModel(m);
    res.json({ ok: result.ok, message: result.message, sample: result.sample ?? null });
  }),
);

export { modelsRouter };
