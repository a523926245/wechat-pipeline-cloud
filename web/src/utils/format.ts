/** 展示层用的小工具，避免各页面重复实现。 */

import type { ModelMeta } from '../types.ts';

export type TagType = 'success' | 'warning' | 'danger' | 'info' | 'primary';

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  pushed: '已推送',
  failed: '失败',
  updated: '已更新',
  ok: '成功',
  success: '成功',
  error: '失败',
  running: '运行中',
  skipped: '跳过',
};

const STATUS_TAG: Record<string, TagType> = {
  draft: 'info',
  pushed: 'success',
  failed: 'danger',
  updated: 'warning',
  ok: 'success',
  success: 'success',
  error: 'danger',
  running: 'primary',
  skipped: 'info',
};

/** 凭据状态 → Element 标签类型。 */
const CRED_TAG: Record<string, TagType> = {
  ok: 'success',
  placeholder: 'info',
  invalid: 'danger',
  missing: 'warning',
};

const CRED_TEXT: Record<string, string> = {
  ok: '就绪',
  placeholder: '待填写',
  invalid: '无效',
  missing: '缺失',
};

export function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export function statusTag(status: string): TagType {
  return STATUS_TAG[status] ?? 'info';
}

export function credTag(status: string): TagType {
  return CRED_TAG[status] ?? 'info';
}

export function credText(status: string): string {
  return CRED_TEXT[status] ?? status;
}

/**
 * 模型域的中文标签由后端 /models/meta 下发，App.vue 启动时拉一次存到这里。
 * 没拉到之前用兜底文案，不阻塞渲染；拿到之后自动切换到后端口径，
 * 以后加供应商/协议/角色只改后端一处。
 */
const LABELS = {
  vendor: new Map<string, string>(),
  protocol: new Map<string, string>(),
  capability: new Map<string, string>(),
  role: new Map<string, string>(),
  protocolImplemented: new Map<string, boolean>(),
  roleDesc: new Map<string, string>(),
};

const ROLE_FALLBACK: Record<string, string> = {
  write: '写作',
  revise: '改写',
  cover: '封面',
  expand_angles: '扩角度',
  comic_script: '漫画脚本',
  comic_panel: '漫画格',
};

/** meta 没拉到时的兜底，保证下拉不会是空的。 */
const IMAGE_FALLBACK = {
  sizes: ['1K', '2K', '3K', '4K'],
  ratios: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'],
  size: '2K',
  ratio: '21:9',
};

const IMAGE_OPTS = {
  sizes: [...IMAGE_FALLBACK.sizes],
  ratios: [...IMAGE_FALLBACK.ratios],
  size: IMAGE_FALLBACK.size,
  ratio: IMAGE_FALLBACK.ratio,
};

export function setModelLabels(meta: ModelMeta | null): void {
  LABELS.vendor.clear();
  LABELS.protocol.clear();
  LABELS.capability.clear();
  LABELS.role.clear();
  LABELS.protocolImplemented.clear();
  LABELS.roleDesc.clear();
  if (!meta) return;
  for (const v of meta.vendors ?? []) LABELS.vendor.set(v.id, v.label);
  for (const p of meta.protocols ?? []) {
    LABELS.protocol.set(p.value, p.label);
    LABELS.protocolImplemented.set(p.value, p.implemented);
  }
  for (const c of meta.capabilities ?? []) LABELS.capability.set(c.value, c.label);
  for (const r of meta.roles ?? []) {
    LABELS.role.set(r.role, r.label);
    if (r.desc) LABELS.roleDesc.set(r.role, r.desc);
  }
  const d = meta.imageDefaults;
  if (d?.sizes?.length) IMAGE_OPTS.sizes = [...d.sizes];
  if (d?.ratios?.length) IMAGE_OPTS.ratios = [...d.ratios];
  if (d?.size) IMAGE_OPTS.size = d.size;
  if (d?.ratio) IMAGE_OPTS.ratio = d.ratio;
}

export function imageSizes(): string[] {
  return IMAGE_OPTS.sizes;
}

export function imageRatios(): string[] {
  return IMAGE_OPTS.ratios;
}

export function defaultImageSize(): string {
  return IMAGE_OPTS.size;
}

export function defaultImageRatio(): string {
  return IMAGE_OPTS.ratio;
}

export function roleText(role: string): string {
  return LABELS.role.get(role) ?? ROLE_FALLBACK[role] ?? role;
}

export function roleDesc(role: string): string {
  return LABELS.roleDesc.get(role) ?? '';
}

export function vendorText(vendor: string): string {
  return LABELS.vendor.get(vendor) ?? vendor;
}

export function protocolText(protocol: string): string {
  return LABELS.protocol.get(protocol) ?? protocol;
}

export function isProtocolImplemented(protocol: string): boolean {
  return LABELS.protocolImplemented.get(protocol) ?? true;
}

export function capabilityText(capability: string): string {
  return LABELS.capability.get(capability) ?? capability;
}

// ── 产线（Pipeline）与角度切片文案 ──
// 与模型域同款约定：由后端 GET /api/pipelines 下发，前端不硬编码。

const PIPELINE_LABELS = {
  label: new Map<string, string>(),
  desc: new Map<string, string>(),
  angleScope: new Map<string, string>(),
};

const PIPELINE_FALLBACK: Record<string, string> = { article: '文章', comic: '漫画' };
const ANGLE_SCOPE_FALLBACK: Record<string, string> = {
  article: '文章专用',
  comic: '漫画专用',
  shared: '共享',
};

export interface PipelineMetaView {
  pipelines?: { kind: string; label: string; desc?: string; angleScopes?: string[] }[];
  angleScopes?: { value: string; label: string; desc?: string }[];
}

/** App.vue 启动时拉 GET /api/pipelines 注入；拉不到时用兜底。 */
export function setPipelineLabels(meta: PipelineMetaView | null): void {
  PIPELINE_LABELS.label.clear();
  PIPELINE_LABELS.desc.clear();
  PIPELINE_LABELS.angleScope.clear();
  if (!meta) return;
  for (const p of meta.pipelines ?? []) {
    PIPELINE_LABELS.label.set(p.kind, p.label);
    if (p.desc) PIPELINE_LABELS.desc.set(p.kind, p.desc);
  }
  for (const s of meta.angleScopes ?? []) PIPELINE_LABELS.angleScope.set(s.value, s.label);
}

export function pipelineText(kind: string): string {
  return PIPELINE_LABELS.label.get(kind) ?? PIPELINE_FALLBACK[kind] ?? kind;
}

export function pipelineDesc(kind: string): string {
  return PIPELINE_LABELS.desc.get(kind) ?? '';
}

/** 产线标签配色（集中一处，避免各页各写一份三元表达式）。 */
export function pipelineTagType(kind: string): TagType {
  return kind === 'comic' ? 'warning' : 'success';
}

export function angleScopeText(scope: string): string {
  return PIPELINE_LABELS.angleScope.get(scope) ?? ANGLE_SCOPE_FALLBACK[scope] ?? scope;
}

const REVISE_MODE_TEXT: Record<string, string> = {
  polish: '润色',
  rewrite: '重写',
  shorten: '精简',
};

export function reviseModeText(mode: string): string {
  return REVISE_MODE_TEXT[mode] ?? mode;
}

/**
 * 封面是后端落到磁盘的静态文件，走 /api/content 静态挂载；
 * Vite 已把 /api 代理到 8787，所以这里直接相对路径即可。
 */
export function coverUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return pathOrUrl;
  const file = pathOrUrl.replace(/\\/g, '/').split('/').pop();
  return file ? `/api/content/covers/${encodeURIComponent(file)}` : '';
}

/** 去掉毫秒与时区后缀，显示成可读时间。 */
export function friendlyTime(iso: string): string {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(0, 19);
}
