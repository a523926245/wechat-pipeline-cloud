/**
 * 模型配置的**单一真源**。
 *
 * 这里把四个彼此正交的概念分开定义，避免再出现「字段名是厂商、装的却是协议」这类错位：
 *   - Vendor（供应商）：谁提供的。开放集合，只影响展示，新增厂商不需要改 schema。
 *   - Protocol（协议）：怎么调。封闭集合，直接决定 services/llm.ts 走哪条 HTTP 通道。
 *   - Capability（能力）：能产出什么。四选一，决定能绑哪些角色。
 *   - Role（角色）：业务流程的哪个环节要用模型。角色只声明「我需要什么能力」。
 *
 * 之前角色值在 6 处硬编码（llm.ts / routes/models.ts / dashboard.ts /
 * web/types.ts / DashboardView.vue / utils/format.ts），加一个角色要改 6 个地方。
 * 现在后端收敛到本文件；前端通过 GET /api/models/meta 下发，不再维护第二份。
 *
 * 注意：本地 SQLite 的 Prisma 客户端把枚举降级成了 String，所以这里用本地联合类型，
 * 不 import Prisma 生成的枚举（那条路在 SQLite 下根本不存在）。
 */

import { z } from 'zod';

// ── 类型 ──

export type Protocol =
  | 'openai_chat'
  | 'openai_images'
  | 'agnes_image'
  | 'modelscope_qwen_image'
  | 'modelscope_qwen_image_mcp'
  | 'anthropic_messages'
  | 'openai_video';

export type Capability = 'text' | 'image' | 'video' | 'multimodal';
export type Role =
  | 'write'
  | 'revise'
  | 'cover'
  | 'expand_angles'
  | 'comic_script'
  | 'comic_panel'
  | 'comic_panel_fallback';
/** 供应商是开放集合，仅用于展示与分组。 */
export type Vendor = string;

export const protocolSchema = z.enum([
  'openai_chat',
  'openai_images',
  'agnes_image',
  'modelscope_qwen_image',
  'modelscope_qwen_image_mcp',
  'anthropic_messages',
  'openai_video',
]);

export const capabilitySchema = z.enum(['text', 'image', 'video', 'multimodal']);
export const roleSchema = z.enum([
  'write',
  'revise',
  'cover',
  'expand_angles',
  'comic_script',
  'comic_panel',
  'comic_panel_fallback',
]);
export const vendorSchema = z.string().trim().min(1).max(32);

// ── 供应商预设（下发给前端做下拉，允许用户自填） ──

export interface VendorPreset {
  id: string;
  label: string;
  defaultBaseUrl: string;
  /** 该供应商常见的协议，仅用于前端联动提示。 */
  protocols: Protocol[];
  note?: string;
}

export const VENDOR_PRESETS: readonly VendorPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    protocols: ['openai_chat', 'openai_images'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    protocols: ['openai_chat'],
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云）',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocols: ['openai_chat'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['openai_chat'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    protocols: ['openai_chat'],
  },
  {
    id: 'agnes',
    label: 'Agnes',
    defaultBaseUrl: 'https://api.agnes-ai.cn/v1',
    protocols: ['agnes_image'],
    note: '生图模型。若厂商给的域名不同，请以厂商文档为准填写',
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    defaultBaseUrl: 'https://studio-qwen-qwen-image-2-1.api-inference.modelscope.net',
    protocols: ['modelscope_qwen_image'],
    note: 'Qwen Image 生图（gradio REST）。Base URL 填 studio 域名根，Key 用 MODELSCOPE_API_TOKEN',
  },
  {
    id: 'custom',
    label: '自定义',
    defaultBaseUrl: '',
    protocols: [],
    note: '自行填写 Base URL 并选择协议',
  },
];

// ── 协议规格 ──

export type ProtocolKind = 'chat' | 'image' | 'video' | 'other';

export interface ProtocolSpec {
  value: Protocol;
  label: string;
  kind: ProtocolKind;
  /** 是否已在 services/llm.ts 实现分派。false 的协议 API 层会拒绝保存。 */
  implemented: boolean;
  /** 追加到 baseUrl 之后的子路径。 */
  path: string;
}

export const PROTOCOL_SPEC: readonly ProtocolSpec[] = [
  {
    value: 'openai_chat',
    label: 'OpenAI 对话协议',
    kind: 'chat',
    implemented: true,
    path: '/chat/completions',
  },
  {
    value: 'openai_images',
    label: 'OpenAI 生图协议',
    kind: 'image',
    implemented: true,
    path: '/images/generations',
  },
  {
    value: 'agnes_image',
    label: 'Agnes 生图协议',
    kind: 'image',
    implemented: true,
    path: '/images/generations',
  },
  {
    value: 'modelscope_qwen_image',
    label: 'ModelScope Qwen 生图',
    kind: 'image',
    implemented: true,
    // gradio REST 不走 baseUrl+path 拼接：baseUrl 即 studio 域名根，
    // 实际调用 /gradio_api/call/... 与 /gradio_api/upload，由 llm.ts 单独分派。
    path: '',
  },
  {
    value: 'modelscope_qwen_image_mcp',
    label: 'ModelScope Qwen 生图（MCP 备选通道）',
    kind: 'image',
    implemented: true,
    // MCP Streamable HTTP：JSON-RPC over SSE（POST /gradio_api/mcp/，须带 Accept: text/event-stream）。
    path: '',
  },
  {
    value: 'anthropic_messages',
    label: 'Anthropic Messages',
    kind: 'other',
    implemented: false,
    path: '',
  },
  {
    value: 'openai_video',
    label: 'OpenAI 视频协议',
    kind: 'video',
    implemented: false,
    path: '',
  },
];

const PROTOCOL_BY_VALUE = new Map<string, ProtocolSpec>(PROTOCOL_SPEC.map((p) => [p.value, p]));

export function protocolSpec(p: string): ProtocolSpec | undefined {
  return PROTOCOL_BY_VALUE.get(p);
}

export function protocolLabel(p: string): string {
  return PROTOCOL_BY_VALUE.get(p)?.label ?? p;
}

export function protocolPath(p: string): string {
  return PROTOCOL_BY_VALUE.get(p)?.path ?? '';
}

export function protocolKind(p: string): ProtocolKind {
  return PROTOCOL_BY_VALUE.get(p)?.kind ?? 'other';
}

export function isProtocolImplemented(p: string): boolean {
  return PROTOCOL_BY_VALUE.get(p)?.implemented === true;
}

/** 该协议能否做文本生成（对话通道）。 */
export function supportsTextGeneration(p: string): boolean {
  return protocolKind(p) === 'chat';
}

/** 该协议能否生成图片。 */
export function supportsImageGeneration(p: string): boolean {
  return protocolKind(p) === 'image';
}

// ── 能力 ──

export interface CapabilitySpec {
  value: Capability;
  label: string;
  desc: string;
}

export const CAPABILITY_SPEC: readonly CapabilitySpec[] = [
  { value: 'text', label: '文本', desc: '能生成文字内容，供写作 / 改写 / 扩题使用' },
  { value: 'image', label: '图像', desc: '能生成图片，供封面 / 配图使用' },
  { value: 'video', label: '视频', desc: '能生成视频（暂未接入业务流程）' },
  { value: 'multimodal', label: '多模态', desc: '能理解图片+文字并输出文字（注意：不等于能生图）' },
];

const CAPABILITY_BY_VALUE = new Map<string, CapabilitySpec>(CAPABILITY_SPEC.map((c) => [c.value, c]));

export function capabilityLabel(c: string): string {
  return CAPABILITY_BY_VALUE.get(c)?.label ?? c;
}

export function isCapability(value: string): value is Capability {
  return CAPABILITY_BY_VALUE.has(value);
}

// ── 角色 ──

export interface RoleSpec {
  role: Role;
  label: string;
  desc: string;
  /** 该角色接受的能力。绑定模型时按此校验。 */
  capabilities: Capability[];
  /** 该角色需要的协议种类（chat / image）。 */
  kind: ProtocolKind;
  /** 该角色额外限定的协议白名单。空数组表示只要种类对即可。 */
  protocols: Protocol[];
  /** 真正调用它的服务，用于排查。 */
  consumer: string;
  /** 该角色是否已在业务流程中通电。false 表示「绑了但暂时不会自动跑」。 */
  active: boolean;
}

export const ROLE_SPEC: Readonly<Record<Role, RoleSpec>> = {
  write: {
    role: 'write',
    label: '写作',
    desc: '按选题角度生成一篇公众号草稿',
    capabilities: ['text', 'multimodal'],
    kind: 'chat',
    protocols: [],
    consumer: 'services/writer.ts',
    active: true,
  },
  revise: {
    role: 'revise',
    label: '改写',
    desc: '在在线改稿页润色 / 改写正文',
    capabilities: ['text', 'multimodal'],
    kind: 'chat',
    protocols: [],
    consumer: 'services/revise.ts',
    active: true,
  },
  cover: {
    role: 'cover',
    label: '封面',
    desc: '为文章生成封面配图',
    // 刻意不接受 multimodal：多模态指「能看图说话」，不等于「能生图」，
    // 放行只会让用户绑定成功后才在生成时失败。
    capabilities: ['image'],
    kind: 'image',
    protocols: ['agnes_image', 'openai_images'],
    consumer: 'services/cover.ts',
    active: true,
  },
  expand_angles: {
    role: 'expand_angles',
    label: '扩角度',
    desc: '为赛道扩充选题角度池',
    capabilities: ['text', 'multimodal'],
    kind: 'chat',
    protocols: [],
    consumer: 'services/angles.ts',
    active: true,
  },
  comic_script: {
    role: 'comic_script',
    label: '漫画脚本',
    desc: '把选题写成 N 个插图单元（论点标题/阐释/画面/气泡/英文提示词）',
    capabilities: ['text', 'multimodal'],
    kind: 'chat',
    protocols: [],
    consumer: 'services/comic/script.ts',
    active: true,
  },
  comic_panel: {
    role: 'comic_panel',
    label: '漫画格',
    desc: '按单元提示词逐格生成场景插图（画面内含中文气泡）',
    // 刻意不接受 multimodal，理由同 cover：能看图说话 ≠ 能生图。
    capabilities: ['image'],
    kind: 'image',
    protocols: ['modelscope_qwen_image', 'agnes_image'],
    consumer: 'services/comic/panels.ts',
    active: true,
  },
  comic_panel_fallback: {
    role: 'comic_panel_fallback',
    label: '漫画格（备选通道）',
    desc: '主通道失败时同心跳降级使用的备用生图通道（MCP）',
    // 同 comic_panel：生图角色，刻意不接受 multimodal。
    capabilities: ['image'],
    kind: 'image',
    protocols: ['modelscope_qwen_image_mcp'],
    consumer: 'services/comic/panels.ts',
    active: true,
  },
};

export const ROLES: readonly Role[] = [
  'write',
  'revise',
  'cover',
  'expand_angles',
  'comic_script',
  'comic_panel',
  'comic_panel_fallback',
];

export function roleSpec(role: string): RoleSpec | undefined {
  return (ROLE_SPEC as Record<string, RoleSpec | undefined>)[role];
}

export function roleLabel(role: string): string {
  return roleSpec(role)?.label ?? role;
}

export interface RoleMatch {
  ok: boolean;
  reason?: string;
}

/**
 * 该角色是否接受这个模型（能力 + 协议双重校验）。
 * 绑定时用来提前给用户反馈；运行时也会再校验一次——
 * 因为模型的能力/协议/启用状态事后可能被改，既有绑定会因此失效。
 */
export function roleAcceptsModel(
  role: Role,
  model: { capability: string; protocol: string; name?: string },
): RoleMatch {
  const spec = ROLE_SPEC[role];
  if (!spec) return { ok: false, reason: `未知角色 ${role}` };

  if (!spec.capabilities.includes(model.capability as Capability)) {
    const need = spec.capabilities.map(capabilityLabel).join(' / ');
    const got = capabilityLabel(model.capability);
    return {
      ok: false,
      reason: `「${spec.label}」角色需要「${need}」能力的模型，而「${model.name ?? ''}」的能力是「${got}」`,
    };
  }

  if (protocolKind(model.protocol) !== spec.kind) {
    const needTxt = spec.kind === 'image' ? '生图' : '对话';
    return {
      ok: false,
      reason: `「${spec.label}」角色需要${needTxt}类协议，而「${model.name ?? ''}」用的是「${protocolLabel(model.protocol)}」`,
    };
  }

  if (spec.protocols.length > 0 && !spec.protocols.includes(model.protocol as Protocol)) {
    const need = spec.protocols.map(protocolLabel).join(' / ');
    return {
      ok: false,
      reason: `「${spec.label}」角色只接受 ${need} 协议的模型，而「${model.name ?? ''}」用的是「${protocolLabel(model.protocol)}」`,
    };
  }

  return { ok: true };
}

// ── 生图默认参数 ──

/** 公众号封面约 2.35:1，故默认 21:9 + 2K。 */
export const DEFAULT_IMAGE_PARAMS = { size: '2K', ratio: '21:9', responseFormat: 'b64_json' } as const;

export const IMAGE_SIZES = ['1K', '2K', '3K', '4K'] as const;
export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const;
