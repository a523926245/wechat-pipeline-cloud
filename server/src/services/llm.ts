/**
 * LLM 模型抽象层。
 *
 * 设计要点：
 * - 支持 OpenAI 兼容协议（一个 provider 覆盖多家厂商：OpenAI / DeepSeek / 通义 / 智谱等）。
 * - API Key 从库里 apiKeyEnc 解密，明文只在内存中存在，绝不落盘、绝不进日志。
 * - 调用失败归一为 BadRequestError，路由层再决定如何优雅返回（不崩溃）。
 * - 角色解析：写/修订/封面/扩库各用一个模型，由 ModelBinding 决定。
 */

import type { LlmModel } from '@prisma/client';

/**
 * 角色类型。注意：schema 真源用 MySQL 枚举 ModelRole，但本地 SQLite（由
 * gen-sqlite-schema.mjs 生成）把枚举转成 String，客户端不导出枚举类型。
 * 这里用本地联合类型，运行时传字符串即可在两端兼容。
 */
export type ModelRole = 'write' | 'revise' | 'cover' | 'expand_angles';

import { LLM_TIMEOUT_MS } from '../config.ts';
import { decryptSecret, scrub } from '../lib/crypto.ts';
import { BadRequestError } from '../errors.ts';
import { logger } from '../logger.ts';
import { prisma } from '../db.ts';
import { unpackJson } from '../db-json.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

function readParams(model: LlmModel): ModelParams {
  const p = unpackJson<ModelParams>(model.paramsJson);
  return p ?? {};
}

/**
 * 调用 OpenAI 兼容的 chat/completions，返回模型文本输出。
 * 非对话模型（如 agnes_image）不允许走此通道，直接抛错。
 */
export async function chatComplete(
  model: LlmModel,
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<string> {
  if (model.provider !== 'openai_compat') {
    throw new BadRequestError(
      `模型「${model.name}」的 provider=${model.provider} 不是对话模型，无法走 chat 通道`,
    );
  }

  const apiKey = decryptSecret(model.apiKeyEnc);
  if (!apiKey) {
    throw new BadRequestError(`模型「${model.name}」未配置 API Key（或密钥解密失败）`);
  }

  const p = readParams(model);
  const body = {
    model: model.modelId,
    messages,
    temperature: opts.temperature ?? p.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? p.maxTokens ?? 2400,
    top_p: opts.topP ?? p.topP ?? 0.9,
  };

  const url = model.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);

  try {
    logger.info({ model: model.name, url }, 'LLM chat 请求');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const safe = scrub(text, [apiKey]);
      logger.warn({ model: model.name, status: resp.status, text: safe.slice(0, 300) }, 'LLM 返回非 2xx');
      throw new BadRequestError(`LLM 返回 ${resp.status}: ${safe.slice(0, 200)}`, { status: resp.status });
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return content;
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError 是超时触发的
    throw new BadRequestError(`LLM 调用失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
  sample?: string;
}

/** 连通测试：非对话模型给说明，缺 Key 直接失败，否则发一个极简请求验证可达性。 */
export async function testModel(model: LlmModel): Promise<ModelTestResult> {
  if (model.provider !== 'openai_compat') {
    return {
      ok: true,
      message: `provider=${model.provider} 非对话模型，请通过对应生图/专用接口验证连通`,
    };
  }
  const apiKey = decryptSecret(model.apiKeyEnc);
  if (!apiKey) {
    return { ok: false, message: '未配置 API Key，无法测试连通' };
  }
  try {
    const content = await chatComplete(
      model,
      [{ role: 'user', content: 'ping' }],
      { maxTokens: 4, temperature: 0 },
    );
    return {
      ok: true,
      sample: content.slice(0, 80),
      message: '连通成功，已收到模型响应',
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 解析某角色当前绑定的模型；未绑定返回 null。 */
export async function resolveModelForRole(role: ModelRole): Promise<LlmModel | null> {
  const binding = await prisma.modelBinding.findUnique({ where: { role } });
  if (!binding) return null;
  return prisma.llmModel.findUnique({ where: { id: binding.modelId } });
}
