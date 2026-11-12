/**
 * LLM 模型抽象层。
 *
 * 设计要点：
 * - 按 **协议(protocol)** 分派到不同 HTTP 通道：对话走 /chat/completions，
 *   生图走 /images/generations。新增协议只需在 model-registry.ts 里登记 + 在此加分派。
 * - 供应商(vendor) 只影响展示，不参与任何分支。
 * - API Key 从库里 apiKeyEnc 解密，明文只在内存中存在，绝不落盘、绝不进日志。
 * - 调用失败归一为 BadRequestError，路由层再决定如何优雅返回（不崩溃）。
 * - 角色解析：写/改写/封面/扩角度各用哪个模型，由 ModelBinding 决定；
 *   解析时统一做「启用 + 能力 + 协议 + Key」四层校验，避免绑定后才在运行时炸。
 */

import type { LlmModel } from '@prisma/client';

import { HTTP_TIMEOUT_MS, LLM_TIMEOUT_MS } from '../config.ts';
import { BadRequestError } from '../errors.ts';
import { logger } from '../logger.ts';
import { prisma } from '../db.ts';
import { unpackJson } from '../db-json.ts';
import { decryptSecret, scrub } from '../lib/crypto.ts';
import {
  DEFAULT_IMAGE_PARAMS,
  ROLE_SPEC,
  capabilityLabel,
  isProtocolImplemented,
  protocolKind,
  protocolLabel,
  protocolPath,
  roleAcceptsModel,
  supportsImageGeneration,
  supportsTextGeneration,
} from './model-registry.ts';
import type { Capability, Protocol, Role } from './model-registry.ts';

// 兼容旧的类型名（前端与路由曾用 ModelRole）。新代码请用 Role。
export type ModelRole = Role;
export type { Capability, Protocol, Role };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/** paramsJson 里按协议约定的高级参数。 */
interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  size?: string;
  ratio?: string;
  responseFormat?: string;
  /** ModelScope gradio 通道：生成像素与负面词（模型级默认）。 */
  genWidth?: number;
  genHeight?: number;
  negativePrompt?: string;
  /**
   * ModelScope gradio 通道的接口名（模型级覆盖）。
   * 不同 studio 版本暴露的函数名不一样：2-1 是 generate_with_enhance，2-0-pro 是 generate_image。
   * 不填则用 QWEN_DEFAULT_API_NAME。
   */
  gradioApiName?: string;
}

function readParams(model: LlmModel): ModelParams {
  return unpackJson<ModelParams>(model.paramsJson) ?? {};
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/**
 * 公共 POST：超时、非 2xx 归一、Key 脱敏。对话与生图共用。
 */
async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  modelName: string,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    logger.info({ model: modelName, url }, 'LLM 请求');
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
      logger.warn({ model: modelName, status: resp.status, text: safe.slice(0, 300) }, 'LLM 返回非 2xx');
      throw new BadRequestError(`LLM 返回 ${resp.status}: ${safe.slice(0, 200)}`, { status: resp.status });
    }

    return (await resp.json()) as unknown;
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError 是超时触发的
    throw new BadRequestError(`LLM 调用失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

function requireApiKey(model: LlmModel): string {
  const apiKey = decryptSecret(model.apiKeyEnc);
  if (!apiKey) {
    throw new BadRequestError(`模型「${model.name}」未配置 API Key（或密钥解密失败）`);
  }
  return apiKey;
}

/**
 * 调用 OpenAI 兼容的 chat/completions，返回模型文本输出。
 * 非对话协议（如生图）不允许走此通道，直接抛错。
 */
export async function chatComplete(
  model: LlmModel,
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<string> {
  if (!supportsTextGeneration(model.protocol)) {
    throw new BadRequestError(
      `模型「${model.name}」的协议是「${protocolLabel(model.protocol)}」，不支持文本生成，无法走对话通道`,
    );
  }

  const apiKey = requireApiKey(model);
  const p = readParams(model);
  const body = {
    model: model.modelId,
    messages,
    temperature: opts.temperature ?? p.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? p.maxTokens ?? 2400,
    top_p: opts.topP ?? p.topP ?? 0.9,
  };

  const data = (await postJson(
    joinUrl(model.baseUrl, protocolPath(model.protocol)),
    apiKey,
    body,
    LLM_TIMEOUT_MS,
    model.name,
  )) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
  };

  // 记 finish_reason 与用量：正文写成了半截时，看一眼 reason 就能断定是 token 预算不够
  // （length）还是模型自己停下来的（stop），不必在 prompt 上瞎猜。
  const finish = data.choices?.[0]?.finish_reason;
  if (finish === 'length') {
    logger.warn({ model: model.name, finish, usage: data.usage }, 'LLM 输出被 max_tokens 截断');
  }

  return data.choices?.[0]?.message?.content ?? '';
}

// ── 生图 ──

export interface ImageOptions {
  size?: string;
  ratio?: string;
  responseFormat?: string;
  /** 生图负面提示词（漫画格从产线配置传入；cover 走模型 paramsJson）。 */
  negativePrompt?: string;
  /** ModelScope gradio 通道的生成像素（width/height 都需为 8 的倍数）。 */
  genWidth?: number;
  genHeight?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
  /** 供落盘用的扩展名（wechat.uploadImage 按扩展名判 mime，必须准）。 */
  ext: 'png' | 'jpg' | 'gif' | 'bmp';
  sourceUrl?: string;
  size: string;
  ratio: string;
}

/** 按 magic bytes 判图片格式——不信服务端给的扩展名，也不信 URL 后缀。 */
function sniffImage(bytes: Buffer): { mime: string; ext: GeneratedImage['ext'] } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { mime: 'image/bmp', ext: 'bmp' };
  }
  return null;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function downloadBytes(url: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new BadRequestError(`图片下载失败：HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequestError('图片体积过大（超过 20MB），已放弃');
    return buf;
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError(`图片下载失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── ModelScope Qwen Image（gradio REST 直连） ──
//
// 端点形态（2026-10 实证，与 D:\Soft\OpenCode\skills\quote-comic-illustrator\scripts\gen_image.py 同通道）：
//   ① POST  {base}/gradio_api/call/{apiName}  body={"data":[...]}  → {event_id}
//   ② GET   {base}/gradio_api/call/{apiName}/{event_id}  （SSE，挂到 complete）
//   ③ 从 complete 事件的 data[0] 拿服务端文件 URL，直接下载
// 注意：studio 的 MCP 端点（/gradio_api/mcp/）不认 Bearer token（实测 401），别走那条路。
//
// ⚠️ **不要按数组下标硬塞参数**。gradio 的 data 数组顺序 = 组件顺序，各版本并不一致：
//   2-1   generate_with_enhance: input_images, original_prompt, enable_extend, custom_size,
//                                log_dir, seed, randomize_seed, height, width, negative_prompt
//   2-0-pro generate_image      : input_images, original_prompt, prompt_extend, edit_custom_size,
//                                seed, randomize_seed, height, width, negative_prompt   （没有 log_dir）
// 所以改成：先 GET /gradio_api/info 拿真实参数名与顺序，再**按名字**填值；接口名也可按模型覆盖。
// 探测失败才退回旧的下标布局（保 2-1 老配置不炸）。

const QWEN_DEFAULT_API_NAME = 'generate_with_enhance';
const QWEN_LOG_DIR = '/tmp/qwen-image-generation-logs';
/** 默认生成像素（skill 实测值）。宽高均需 8 的倍数。 */
const QWEN_DEFAULT_SIZE = { width: 2624, height: 1472 };

/**
 * 语义字段 → 各版本可能出现的参数名（按优先级）。
 * 2-1 用 enable_extend / custom_size，2-0-pro 改名成 prompt_extend / edit_custom_size，所以给别名。
 */
const QWEN_PARAM_ALIASES = {
  inputImages: ['input_images'],
  prompt: ['original_prompt', 'prompt'],
  // 气泡文字零错字的关键：必须 false。扩写会改写提示词，导致画面内文字错字。
  promptExtend: ['prompt_extend', 'enable_extend'],
  customSize: ['edit_custom_size', 'custom_size'],
  logDir: ['log_dir'],
  seed: ['seed'],
  randomizeSeed: ['randomize_seed'],
  height: ['height'],
  width: ['width'],
  negativePrompt: ['negative_prompt'],
} as const;

type QwenField = keyof typeof QWEN_PARAM_ALIASES;

interface GradioParam {
  name: string;
  default?: unknown;
}

/** 每个 base+apiName 探测一次即可，进程内缓存（生图是慢操作，不能每次多一个 RTT）。 */
const gradioSpecCache = new Map<string, GradioParam[] | null>();

/**
 * 拉取 gradio 接口的真实参数清单（名字 + 声明的默认值 + 顺序）。
 * 拿不到就返回 null，由调用方退回下标布局。
 */
async function fetchGradioParams(
  base: string,
  apiName: string,
  headers: Record<string, string>,
): Promise<GradioParam[] | null> {
  const cacheKey = `${base}#${apiName}`;
  if (gradioSpecCache.has(cacheKey)) return gradioSpecCache.get(cacheKey) ?? null;

  let params: GradioParam[] | null = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(`${base}/gradio_api/info`, { headers, signal: ctrl.signal });
    if (resp.ok) {
      const info = (await resp.json()) as {
        named_endpoints?: Record<string, { parameters?: Array<Record<string, unknown>> }>;
      };
      const wanted = apiName.replace(/^\/+/, '');
      for (const [name, spec] of Object.entries(info.named_endpoints ?? {})) {
        if (name.replace(/^\/+/, '') !== wanted) continue;
        const list = (spec.parameters ?? [])
          .filter((p) => typeof p.parameter_name === 'string')
          .map((p) => ({ name: p.parameter_name as string, default: p.parameter_default }));
        if (list.length > 0) params = list;
        break;
      }
    }
  } catch {
    params = null;
  } finally {
    clearTimeout(timer);
  }

  gradioSpecCache.set(cacheKey, params);
  return params;
}

/**
 * 按参数名把语义值填进 gradio 的 data 数组。
 * 认不出的参数用接口声明的默认值兜底（都没有就填 null），并打一条 warn——
 * 静默错位会生成废图还花额度，宁可吵一点。
 */
function buildGradioData(
  params: GradioParam[],
  apiName: string,
  values: Record<QwenField, unknown>,
): unknown[] {
  const data: unknown[] = [];
  const unknownNames: string[] = [];
  for (const p of params) {
    const field = (Object.keys(QWEN_PARAM_ALIASES) as QwenField[]).find((k) =>
      (QWEN_PARAM_ALIASES[k] as readonly string[]).includes(p.name),
    );
    if (field) data.push(values[field]);
    else if (p.default !== undefined) data.push(p.default);
    else {
      unknownNames.push(p.name);
      data.push(null);
    }
  }
  if (unknownNames.length > 0) {
    logger.warn({ apiName, unknownNames }, 'gradio 参数未识别，已按默认值填充');
  }
  return data;
}

/** 解析 gradio SSE 文本，取 complete 事件的 data JSON。generating 进度事件直接忽略。 */
function parseGradioSse(raw: string): unknown {
  const lines = raw.split('\n');
  let lastData: string | null = null;
  let pending = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('event:')) {
      pending = t.slice(6).trim() === 'complete';
      continue;
    }
    if (pending && t.startsWith('data:')) lastData = t.slice(5).trim();
  }
  if (lastData === null) {
    throw new BadRequestError(`ModelScope 生图流未返回 complete 事件：${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(lastData) as unknown;
  } catch {
    throw new BadRequestError(`ModelScope 生图流 data 解析失败：${lastData.slice(0, 200)}`);
  }
}

async function generateImageModelScope(
  model: LlmModel,
  prompt: string,
  opts: ImageOptions,
): Promise<GeneratedImage> {
  const apiKey = requireApiKey(model);
  const p = readParams(model);
  const base = model.baseUrl.replace(/\/+$/, '');
  const apiName = (p.gradioApiName ?? QWEN_DEFAULT_API_NAME).replace(/^\/+/, '');
  const width = opts.genWidth ?? p.genWidth ?? QWEN_DEFAULT_SIZE.width;
  const height = opts.genHeight ?? p.genHeight ?? QWEN_DEFAULT_SIZE.height;
  const negative = opts.negativePrompt ?? p.negativePrompt ?? '';

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  // 按参数名填值（各版本组件顺序不同，不能按下标硬塞）；探测失败退回旧布局。
  const values: Record<QwenField, unknown> = {
    // input_images：默认不传参考图（传规范图做参考实测会把标签文字泄漏进画面）
    inputImages: [],
    prompt,
    promptExtend: false,
    customSize: true,
    logDir: QWEN_LOG_DIR,
    seed: 0,
    randomizeSeed: true,
    height,
    width,
    negativePrompt: negative,
  };
  const legacyData = [
    values.inputImages,
    values.prompt,
    false,
    true,
    QWEN_LOG_DIR,
    0,
    true,
    height,
    width,
    negative,
  ];
  const params = await fetchGradioParams(base, apiName, headers);
  const data = params ? buildGradioData(params, apiName, values) : legacyData;

  logger.info(
    { model: model.name, apiName, width, height, mapped: params !== null, params: params?.map((x) => x.name) },
    'ModelScope 生图提交',
  );

  // ① 提交
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  let eventId: string;
  try {
    const resp = await fetch(`${base}/gradio_api/call/${apiName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const safe = scrub(text, [apiKey]);
      logger.warn({ model: model.name, status: resp.status, text: safe.slice(0, 300) }, 'ModelScope 提交非 2xx');
      throw new BadRequestError(`ModelScope 提交失败 ${resp.status}: ${safe.slice(0, 200)}`, { status: resp.status });
    }
    const j = (await resp.json()) as { event_id?: string };
    if (!j.event_id) throw new BadRequestError(`ModelScope 提交未返回 event_id：${JSON.stringify(j).slice(0, 200)}`);
    eventId = j.event_id;
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError(`ModelScope 提交失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  // ② SSE 挂到 complete（整段读完即流结束）
  const ctrl2 = new AbortController();
  const timer2 = setTimeout(() => ctrl2.abort(), LLM_TIMEOUT_MS);
  let result: unknown;
  try {
    const resp = await fetch(`${base}/gradio_api/call/${apiName}/${encodeURIComponent(eventId)}`, {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: ctrl2.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new BadRequestError(`ModelScope 结果流失败 ${resp.status}: ${scrub(text, [apiKey]).slice(0, 200)}`);
    }
    result = parseGradioSse(await resp.text());
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError(`ModelScope 结果流失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer2);
  }

  // complete data = [文件路径或 URL, seed, 改写后的提示词]
  if (!Array.isArray(result) || result.length < 1) {
    throw new BadRequestError(`ModelScope 生图结果格式异常：${JSON.stringify(result).slice(0, 200)}`);
  }
  const fileRef = result[0];
  let sourceUrl: string | undefined;
  if (typeof fileRef === 'string' && fileRef) {
    sourceUrl = fileRef.startsWith('http') ? fileRef : `${base}/gradio_api/file=${fileRef.replace(/^\/+/, '')}`;
  } else if (fileRef && typeof fileRef === 'object') {
    // 兼容 {path, url} 结构
    const o = fileRef as { url?: string; path?: string };
    sourceUrl = o.url ?? (o.path ? `${base}/gradio_api/file=${o.path.replace(/^\/+/, '')}` : undefined);
  }
  if (!sourceUrl) {
    throw new BadRequestError(`ModelScope 生图未返回文件：${JSON.stringify(result).slice(0, 200)}`);
  }

  const bytes = await downloadBytes(sourceUrl);
  if (bytes.length === 0) throw new BadRequestError('ModelScope 生图返回了空图片数据');
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new BadRequestError('ModelScope 生图返回的数据不是可识别的图片（仅支持 PNG/JPEG/GIF/BMP）');
  }
  return {
    bytes,
    mime: sniffed.mime,
    ext: sniffed.ext,
    sourceUrl,
    size: `${width}x${height}`,
    ratio: opts.ratio ?? p.ratio ?? DEFAULT_IMAGE_PARAMS.ratio,
  };
}

// ── ModelScope Qwen Image（MCP Streamable HTTP 备选通道） ──
//
// 移植自 skill scripts/mcp_fallback.py 的 MCPClient（判决 PATH=MCP，见
// .omo/evidence/task-6-comic-skill-align.md）。与 REST 通道的差别：
//   - 协议是 JSON-RPC over SSE：POST {base}/gradio_api/mcp/，
//     **必须**带 Accept: application/json, text/event-stream（否则 406）。
//   - 需 initialize 握手（多 protocolVersion 回退），回包可能带 Mcp-Session-Id。
//   - 用 tools/call 调 generate_image，参数名与 REST 的 data 数组不同（按名传 JSON 对象）。
// 原生 fetch 实现，零新依赖。

const MCP_PROTO_CANDIDATES = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface McpJsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

function parseMcpMessages(raw: string, contentType: string): McpJsonRpcMessage[] {
  const out: McpJsonRpcMessage[] = [];
  if (contentType.includes('event-stream')) {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data) as unknown;
        if (Array.isArray(obj)) out.push(...(obj as McpJsonRpcMessage[]));
        else out.push(obj as McpJsonRpcMessage);
      } catch {
        // 非 JSON 的 data 行是进度事件，跳过
      }
    }
    return out;
  }
  const text = raw.trim();
  if (!text) return out;
  try {
    const obj = JSON.parse(text) as unknown;
    if (Array.isArray(obj)) out.push(...(obj as McpJsonRpcMessage[]));
    else out.push(obj as McpJsonRpcMessage);
  } catch {
    // 解析失败留空，由调用方报「无终态响应」
  }
  return out;
}

function pickMcpTerminal(msgs: McpJsonRpcMessage[], id: number): McpJsonRpcMessage | null {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m && m.id === id && ('result' in m || 'error' in m)) return m;
  }
  return null;
}

interface McpSession {
  sessionId?: string;
  proto?: string;
  nextId: number;
}

async function mcpPost(
  base: string,
  apiKey: string,
  session: McpSession,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<McpJsonRpcMessage[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 关键：不带 text/event-stream 会被 studio 以 406 拒绝。
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    'MCP-Protocol-Version': session.proto ?? MCP_PROTO_CANDIDATES[0],
  };
  if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
  try {
    const resp = await fetch(`${base}/gradio_api/mcp/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new BadRequestError(
        `MCP ${String(payload.method ?? '')} 失败 HTTP ${resp.status}: ${scrub(text, [apiKey]).slice(0, 200)}`,
      );
    }
    const sid = resp.headers.get('Mcp-Session-Id');
    if (sid) session.sessionId = sid;
    const ctype = (resp.headers.get('Content-Type') ?? '').toLowerCase();
    return parseMcpMessages(await resp.text(), ctype);
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError(`MCP 请求失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function mcpInitialize(base: string, apiKey: string, session: McpSession): Promise<void> {
  let lastErr = 'unknown';
  for (const proto of MCP_PROTO_CANDIDATES) {
    session.sessionId = undefined;
    const id = (session.nextId += 1);
    const messages = await mcpPost(
      base,
      apiKey,
      { ...session, proto },
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: proto,
          capabilities: {},
          clientInfo: { name: 'wechat-pipeline-fallback', version: '1.0' },
        },
      },
      HTTP_TIMEOUT_MS,
    ).catch((e: unknown) => {
      lastErr = e instanceof Error ? e.message : String(e);
      return [] as McpJsonRpcMessage[];
    });
    const resp = pickMcpTerminal(messages, id);
    if (!resp || resp.error) {
      lastErr = resp ? JSON.stringify(resp.error).slice(0, 200) : `无 initialize 响应(${messages.length})`;
      continue;
    }
    const result = (resp.result ?? {}) as { protocolVersion?: string };
    session.proto = result.protocolVersion ?? proto;
    return;
  }
  throw new BadRequestError(`MCP initialize 全部 protocolVersion 均失败：${lastErr}`);
}

async function mcpCallTool(
  base: string,
  apiKey: string,
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const id = (session.nextId += 1);
  const messages = await mcpPost(
    base,
    apiKey,
    session,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    timeoutMs,
  );
  const resp = pickMcpTerminal(messages, id);
  if (!resp) throw new BadRequestError(`MCP ${name} 无终态响应（收到 ${messages.length} 条消息）`);
  if (resp.error) throw new BadRequestError(`MCP ${name} JSON-RPC error：${JSON.stringify(resp.error).slice(0, 300)}`);
  const result = (resp.result ?? {}) as Record<string, unknown>;
  if (result.isError) throw new BadRequestError(`MCP ${name} 服务端 isError：${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

const MCP_DATA_URI_RE = /^data:image\/[\w+.-]+;base64,(.*)$/s;
const MCP_B64_RE = /^[A-Za-z0-9+/=\s]+$/;

async function mcpImagesFromValue(v: unknown, base: string, apiKey: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  if (typeof v === 'string') {
    const s = v.trim().replace(/^"|"$/g, '');
    if (!s) return out;
    const dataUri = s.match(MCP_DATA_URI_RE);
    if (dataUri?.[1]) {
      const compact = dataUri[1].replace(/\s+/g, '');
      if (compact.length % 4 === 0) out.push(Buffer.from(compact, 'base64'));
      return out;
    }
    if (s.startsWith('http://') || s.startsWith('https://')) {
      out.push(await downloadBytes(s));
      return out;
    }
    if (s.startsWith('/gradio_api/file=') || s.startsWith('gradio_api/file=')) {
      const path = s.startsWith('/') ? s : `/${s}`;
      out.push(await downloadBytes(`${base}${path}`));
      return out;
    }
    if (s.length > 100 && s.length % 4 === 0 && MCP_B64_RE.test(s)) {
      const buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
      if (sniffImage(buf)) out.push(buf);
      return out;
    }
    return out;
  }
  if (Array.isArray(v)) {
    for (const item of v) out.push(...(await mcpImagesFromValue(item, base, apiKey)));
    return out;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.data === 'string' && (o.type === 'image' || !o.type)) {
      const buf = Buffer.from(o.data.replace(/\s+/g, ''), 'base64');
      if (sniffImage(buf)) return [buf];
    }
    for (const key of ['result_image', 'image', 'url', 'path', 'file', 'image_url', 'src', 'blob', 'base64']) {
      if (o[key] !== undefined && o[key] !== null) {
        const found = await mcpImagesFromValue(o[key], base, apiKey);
        if (found.length > 0) return found;
      }
    }
  }
  return out;
}

async function mcpExtractImages(result: Record<string, unknown>, base: string, apiKey: string): Promise<Buffer[]> {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const found = await mcpImagesFromValue(item, base, apiKey);
    if (found.length > 0) return found;
  }
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    for (const key of ['text', 'json', 'content', 'data']) {
      if (typeof o[key] === 'string') {
        const s = o[key] as string;
        try {
          const parsed = JSON.parse(s) as unknown;
          const found = await mcpImagesFromValue(parsed, base, apiKey);
          if (found.length > 0) return found;
        } catch {
          // 非 JSON：真实上游会回 Python repr（含 'url'/'path' 的单引号列表），按 URL 扫
          const urlHit = s.match(/https?:\/\/[^\s'"\\)\]]+/);
          if (urlHit) {
            const found = await mcpImagesFromValue(urlHit[0], base, apiKey);
            if (found.length > 0) return found;
          }
          const pathHit = s.match(/\/tmp\/gradio\/[^'"\s\]]+/);
          if (pathHit) {
            const found = await mcpImagesFromValue(`/gradio_api/file=${pathHit[0]}`, base, apiKey);
            if (found.length > 0) return found;
          }
        }
      }
    }
  }
  return mcpImagesFromValue(result, base, apiKey);
}

async function generateImageModelScopeMcp(
  model: LlmModel,
  prompt: string,
  opts: ImageOptions,
): Promise<GeneratedImage> {
  const apiKey = requireApiKey(model);
  const p = readParams(model);
  const base = model.baseUrl.replace(/\/+$/, '');
  const width = opts.genWidth ?? p.genWidth ?? QWEN_DEFAULT_SIZE.width;
  const height = opts.genHeight ?? p.genHeight ?? QWEN_DEFAULT_SIZE.height;
  const negative = opts.negativePrompt ?? p.negativePrompt ?? '';
  const toolName = (p.gradioApiName ?? 'generate_image').replace(/^\/+/, '');

  const session: McpSession = { nextId: 0 };
  await mcpInitialize(base, apiKey, session);

  // 参数按名传 JSON 对象（与 REST 的按序 data 数组不同）；prompt_extend=false 保气泡文字零错字。
  const args: Record<string, unknown> = {
    input_images: [],
    original_prompt: prompt,
    prompt_extend: false,
    edit_custom_size: true,
    seed: 0,
    randomize_seed: true,
    height,
    width,
    negative_prompt: negative,
  };

  logger.info({ model: model.name, toolName, width, height, proto: session.proto }, 'ModelScope MCP 备选通道提交');
  const result = await mcpCallTool(base, apiKey, session, toolName, args, LLM_TIMEOUT_MS);
  const images = await mcpExtractImages(result, base, apiKey);
  const bytes = images[0];
  if (!bytes) {
    throw new BadRequestError(`MCP 生图未取回图片：${JSON.stringify(result).slice(0, 300)}`);
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new BadRequestError('MCP 生图返回的数据不是可识别的图片（仅支持 PNG/JPEG/GIF/BMP）');
  }
  return {
    bytes,
    mime: sniffed.mime,
    ext: sniffed.ext,
    size: `${width}x${height}`,
    ratio: opts.ratio ?? p.ratio ?? DEFAULT_IMAGE_PARAMS.ratio,
  };
}

/**
 * 生成图片。支持 agnes_image 与 openai_images 两种协议。
 * 返回已解码的字节，由调用方决定落盘位置。
 */
export async function generateImage(
  model: LlmModel,
  prompt: string,
  opts: ImageOptions = {},
): Promise<GeneratedImage> {
  if (!supportsImageGeneration(model.protocol)) {
    throw new BadRequestError(
      `模型「${model.name}」的协议是「${protocolLabel(model.protocol)}」，不支持生成图片`,
    );
  }

  if (model.protocol === 'modelscope_qwen_image') {
    return generateImageModelScope(model, prompt, opts);
  }

  if (model.protocol === 'modelscope_qwen_image_mcp') {
    return generateImageModelScopeMcp(model, prompt, opts);
  }

  const apiKey = requireApiKey(model);
  const p = readParams(model);
  const size = opts.size ?? p.size ?? DEFAULT_IMAGE_PARAMS.size;
  const ratio = opts.ratio ?? p.ratio ?? DEFAULT_IMAGE_PARAMS.ratio;
  const responseFormat = opts.responseFormat ?? p.responseFormat ?? DEFAULT_IMAGE_PARAMS.responseFormat;

  // Agnes 与 OpenAI 生图都用 images/generations；response_format 放在 extra_body 里
  // 是 Agnes 的约定，OpenAI 侧同时接受顶层写法，这里统一走 extra_body。
  const body = {
    model: model.modelId,
    prompt,
    size,
    ratio,
    extra_body: { response_format: responseFormat },
  };

  const data = (await postJson(
    joinUrl(model.baseUrl, protocolPath(model.protocol)),
    apiKey,
    body,
    LLM_TIMEOUT_MS,
    model.name,
  )) as { data?: Array<{ url?: string; b64_json?: string }>; error?: unknown };

  const item = data.data?.[0];
  if (!item) {
    throw new BadRequestError(
      `生图接口未返回图片数据：${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  let bytes: Buffer;
  let sourceUrl: string | undefined;

  if (typeof item.b64_json === 'string' && item.b64_json) {
    const raw = item.b64_json.startsWith('data:')
      ? item.b64_json.slice(item.b64_json.indexOf(',') + 1)
      : item.b64_json;
    bytes = Buffer.from(raw, 'base64');
  } else if (typeof item.url === 'string' && item.url) {
    sourceUrl = item.url;
    bytes = await downloadBytes(item.url);
  } else {
    throw new BadRequestError('生图接口既未返回 url 也未返回 b64_json');
  }

  if (bytes.length === 0) throw new BadRequestError('生图接口返回了空图片数据');

  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new BadRequestError('生图接口返回的数据不是可识别的图片（仅支持 PNG/JPEG/GIF/BMP）');
  }

  return { bytes, mime: sniffed.mime, ext: sniffed.ext, sourceUrl, size, ratio };
}

// ── 连通测试 ──

export interface ModelTestResult {
  ok: boolean;
  message: string;
  sample?: string;
}

/**
 * 连通测试：按协议真实发一次最小请求。
 * 注意：生图协议的测试会真实消耗一次生图额度（此前这里对非对话协议直接返回
 * ok:true、一次请求都不发，是明确的假阳性，已修正）。
 */
export async function testModel(model: LlmModel): Promise<ModelTestResult> {
  if (!isProtocolImplemented(model.protocol)) {
    return { ok: false, message: `协议「${protocolLabel(model.protocol)}」尚未实现，暂不支持连通测试` };
  }
  if (!decryptSecret(model.apiKeyEnc)) {
    return { ok: false, message: '未配置 API Key，无法测试连通' };
  }

  try {
    if (supportsTextGeneration(model.protocol)) {
      const content = await chatComplete(model, [{ role: 'user', content: 'ping' }], {
        maxTokens: 4,
        temperature: 0,
      });
      return { ok: true, sample: content.slice(0, 80), message: '连通成功，已收到模型响应' };
    }

    if (supportsImageGeneration(model.protocol)) {
      // ModelScope gradio 通道忽略 size/ratio，用小像素节省额度与时间
      const isModelScope =
        model.protocol === 'modelscope_qwen_image' || model.protocol === 'modelscope_qwen_image_mcp';
      const img = await generateImage(model, 'a small blue circle on a plain white background', {
        size: '1K',
        ratio: '1:1',
        responseFormat: 'b64_json',
        ...(isModelScope ? { genWidth: 512, genHeight: 512, negativePrompt: 'text, watermark, label' } : {}),
      });
      const kb = (img.bytes.length / 1024).toFixed(0);
      return {
        ok: true,
        message: `连通成功，已生成一张 ${kb} KB 的测试图（本次测试真实消耗了一次生图额度）`,
      };
    }

    return { ok: false, message: `协议「${protocolLabel(model.protocol)}」暂不支持连通测试` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ── 角色解析（统一可用性判定） ──

export interface RoleResolution {
  model: LlmModel | null;
  usable: boolean;
  reason?: string;
}

/**
 * 解析某角色当前绑定的模型，并做完整可用性校验（不抛错版）。
 * 校验顺序：已绑定 → 模型存在 → 已启用 → 能力/协议匹配 → 协议已实现 → 有 Key。
 */
export async function tryResolveForRole(role: Role): Promise<RoleResolution> {
  const spec = ROLE_SPEC[role];
  const label = spec ? spec.label : role;

  const binding = await prisma.modelBinding.findUnique({ where: { role } });
  if (!binding) {
    return { model: null, usable: false, reason: `尚未给「${label}」角色绑定模型` };
  }

  const model = await prisma.llmModel.findUnique({ where: { id: binding.modelId } });
  if (!model) {
    return { model: null, usable: false, reason: `「${label}」角色绑定的模型已不存在` };
  }

  if (!model.enabled) {
    return { model, usable: false, reason: `模型「${model.name}」已被停用` };
  }

  const match = roleAcceptsModel(role, model);
  if (!match.ok) {
    return { model, usable: false, reason: match.reason };
  }

  if (!isProtocolImplemented(model.protocol)) {
    return { model, usable: false, reason: `模型「${model.name}」的协议「${protocolLabel(model.protocol)}」尚未实现` };
  }

  if (!model.apiKeyEnc || model.apiKeyEnc.length === 0) {
    return { model, usable: false, reason: `模型「${model.name}」未配置 API Key` };
  }

  return { model, usable: true };
}

/** 拿不到可用的模型就抛 400，文案直接可展示给用户。 */
export async function assertRoleUsable(role: Role): Promise<LlmModel> {
  const r = await tryResolveForRole(role);
  if (r.usable && r.model) return r.model;

  const spec = ROLE_SPEC[role];
  const need = spec.capabilities.map(capabilityLabel).join(' 或 ');
  throw new BadRequestError(
    `${r.reason}。请到「模型配置」页为「${spec.label}」角色绑定一个「${need}」能力的模型`,
  );
}

/** 给仪表盘用的可用性摘要。 */
export async function modelAvailability(
  role: Role,
): Promise<{ bound: boolean; modelName?: string; ready: boolean; reason?: string }> {
  const r = await tryResolveForRole(role);
  const out: { bound: boolean; modelName?: string; ready: boolean; reason?: string } = {
    bound: r.model != null,
    ready: r.usable,
  };
  if (r.model) out.modelName = r.model.name;
  if (!r.usable && r.reason) out.reason = r.reason;
  return out;
}

/** 兼容旧调用：只取模型，不带可用性信息。新代码请用 tryResolveForRole / assertRoleUsable。 */
export async function resolveModelForRole(role: Role): Promise<LlmModel | null> {
  return (await tryResolveForRole(role)).model;
}

/** 供路由复用：该角色需要的协议种类是否与协议一致（用于能力提示）。 */
export function protocolKindOf(protocol: string): string {
  return protocolKind(protocol);
}
