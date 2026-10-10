/**
 * 模型配置路由：LlmModel 的增删改查 + 连通测试 + 角色绑定（write/revise/cover/expand_angles）。
 *
 * 安全约束（与凭据一致）：
 * - apiKey 明文只在请求体出现，落库一律 encryptSecret 加密；
 * - 列表/详情只返 apiKeyMask，绝不返回 apiKeyEnc 字节或明文；
 * - 连通测试失败信息经 scrub 脱敏，不会把 Key 写进响应或日志。
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.ts';
import { asyncHandler } from '../async-handler.ts';
import { BadRequestError, NotFoundError } from '../../errors.ts';
import { encryptSecret, maskSecret } from '../../lib/crypto.ts';
import { packJson, unpackJson } from '../../db-json.ts';
import { resolveModelForRole, testModel } from '../../services/llm.ts';

const modelsRouter = Router();

const PROVIDERS = ['openai_compat', 'agnes_image'] as const;
const CAPABILITIES = ['text', 'image'] as const;
const ROLES = ['write', 'revise', 'cover', 'expand_angles'] as const;

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  name: z.string().min(1).max(64),
  provider: z.enum(PROVIDERS),
  capability: z.enum(CAPABILITIES),
  baseUrl: z.string().url().or(z.string().min(1)),
  modelId: z.string().min(1).max(128),
  apiKey: z.string().max(512).optional().default(''),
  paramsJson: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

const updateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  provider: z.enum(PROVIDERS).optional(),
  capability: z.enum(CAPABILITIES).optional(),
  baseUrl: z.string().url().or(z.string().min(1)).optional(),
  modelId: z.string().min(1).max(128).optional(),
  apiKey: z.string().max(512).optional(),
  paramsJson: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** 把库实体映射成对外安全视图（剔除 apiKeyEnc 字节）。 */
function toView(m: {
  id: number;
  name: string;
  provider: string;
  capability: string;
  baseUrl: string;
  modelId: string;
  apiKeyMask: string;
  paramsJson: unknown;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  boundRole?: string | null;
}) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    capability: m.capability,
    baseUrl: m.baseUrl,
    modelId: m.modelId,
    apiKeyMask: m.apiKeyMask ?? '',
    paramsJson: unpackJson<Record<string, unknown>>(m.paramsJson) ?? {},
    enabled: m.enabled,
    isDefault: m.isDefault,
    boundRole: m.boundRole ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** 列表：带出每个模型当前绑定的角色（便于界面显示）。 */
modelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [models, bindings] = await Promise.all([
      prisma.llmModel.findMany({ orderBy: { id: 'asc' } }),
      prisma.modelBinding.findMany({ select: { role: true, modelId: true } }),
    ]);
    const roleByModel = new Map<number, string>();
    for (const b of bindings) roleByModel.set(b.modelId, b.role);
    const items = models.map((m) =>
      toView({ ...m, boundRole: roleByModel.get(m.id) ?? null }),
    );
    res.json({ total: items.length, items });
  }),
);

modelsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const m = await prisma.llmModel.findUnique({ where: { id } });
    if (!m) throw new NotFoundError(`模型 ${id} 不存在`);
    const b = await prisma.modelBinding.findFirst({ where: { modelId: id }, select: { role: true } });
    res.json(toView({ ...m, boundRole: b?.role ?? null }));
  }),
);

modelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    if (body.isDefault) {
      await prisma.llmModel.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const apiKeyEnc = body.apiKey ? encryptSecret(body.apiKey) : Buffer.alloc(0);
    const created = await prisma.llmModel.create({
      data: {
        name: body.name,
        provider: body.provider,
        capability: body.capability,
        baseUrl: body.baseUrl,
        modelId: body.modelId,
        apiKeyEnc,
        apiKeyMask: body.apiKey ? maskSecret(body.apiKey) : '',
        paramsJson: packJson(body.paramsJson ?? null),
        enabled: body.enabled,
        isDefault: body.isDefault,
      },
    });
    res.status(201).json(toView({ ...created, boundRole: null }));
  }),
);

modelsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.llmModel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError(`模型 ${id} 不存在`);

    if (body.isDefault) {
      await prisma.llmModel.updateMany({ where: { isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.provider !== undefined) data.provider = body.provider;
    if (body.capability !== undefined) data.capability = body.capability;
    if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
    if (body.modelId !== undefined) data.modelId = body.modelId;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.isDefault !== undefined) data.isDefault = body.isDefault;
    if (body.paramsJson !== undefined) {
      data.paramsJson = packJson(body.paramsJson);
    }
    if (body.apiKey !== undefined && body.apiKey.length > 0) {
      data.apiKeyEnc = encryptSecret(body.apiKey);
      data.apiKeyMask = maskSecret(body.apiKey);
    }

    const updated = await prisma.llmModel.update({ where: { id }, data });
    const b = await prisma.modelBinding.findFirst({ where: { modelId: id }, select: { role: true } });
    res.json(toView({ ...updated, boundRole: b?.role ?? null }));
  }),
);

modelsRouter.delete(
  '/:id',
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

/** 连通测试：取库内模型（含密文），由 llm.testModel 解密后发极简请求。 */
modelsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const m = await prisma.llmModel.findUnique({ where: { id } });
    if (!m) throw new NotFoundError(`模型 ${id} 不存在`);
    const result = await testModel(m);
    res.json({ ok: result.ok, message: result.message, sample: result.sample ?? null });
  }),
);

// ---- 角色绑定 ----

const bindSchema = z.object({ modelId: z.number().int().positive() });

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

modelsRouter.put(
  '/bindings/:role',
  asyncHandler(async (req, res) => {
    const role = z.enum(ROLES).parse(req.params.role);
    const { modelId } = bindSchema.parse(req.body);
    const m = await prisma.llmModel.findUnique({ where: { id: modelId } });
    if (!m) throw new NotFoundError(`模型 ${modelId} 不存在`);
    await prisma.modelBinding.upsert({
      where: { role },
      create: { role, modelId },
      update: { modelId },
    });
    res.json({ ok: true, role, modelId, modelName: m.name });
  }),
);

// 便捷：解析某角色当前模型，供其它路由复用验证。
modelsRouter.get(
  '/resolve/:role',
  asyncHandler(async (req, res) => {
    const role = z.enum(ROLES).parse(req.params.role);
    const m = await resolveModelForRole(role);
    if (!m) {
      res.json({ role, model: null });
      return;
    }
    const b = await prisma.modelBinding.findFirst({ where: { modelId: m.id }, select: { role: true } });
    res.json({ role, model: toView({ ...m, boundRole: b?.role ?? null }) });
  }),
);

export { modelsRouter };
