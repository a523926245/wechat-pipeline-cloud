/** 展示层用的小工具，避免各页面重复实现。 */

import type { ModelMeta } from '../types.ts';

export type TagType = 'success' | 'warning' | 'danger' | 'info' | 'primary';

/**
 * 状态词表（S5-UI-1 收口）：全站唯一真源。
 *
 * 为什么要分 kind：文章状态、选题审核态、任务状态是**三套不同的语义**，
 * 以前合在一张表里，靠 key 不撞车来「碰巧」区分。现在按业务维度分开，
 * 页面用 <StatusTag kind="..." :value="..." /> 取用，不允许各自复制一份词表。
 *
 * 口径纪律：文字与颜色一一对应；未知值原样显示（不猜、不归并成含糊状态）。
 */
export type StatusKind = 'article' | 'angle' | 'verdict' | 'task' | 'pipeline' | 'usage';

export interface StatusMeta {
  text: string;
  type: TagType;
}

/** 文章状态（ArticleStatus 枚举：draft / updated / pushed / failed）。 */
export const ARTICLE_STATUS_META: Record<string, StatusMeta> = {
  draft: { text: '草稿', type: 'info' },
  updated: { text: '已更新', type: 'warning' },
  pushed: { text: '已推送', type: 'success' },
  failed: { text: '失败', type: 'danger' },
};

/** 选题审核态（AngleStatus 枚举：candidate / needs_revision / approved / rejected）。 */
export const ANGLE_STATUS_META: Record<string, StatusMeta> = {
  candidate: { text: '候选待审', type: 'info' },
  needs_revision: { text: '待修改', type: 'warning' },
  approved: { text: '已通过', type: 'success' },
  rejected: { text: '已拒绝', type: 'danger' },
};

/**
 * 审核动作（TopicReview.verdict）。
 * 与 AngleStatus 是两个概念：verdict 是「这一轮做了什么」（通过 / 要求修改 / 拒绝），
 * AngleStatus 是「现在是什么状态」（已通过 / 待修改 / 已拒绝）。
 * 文字口径保持不同，不合并——合并会把「历史动作」说出来当成「当前状态」。
 */
export const REVIEW_VERDICT_META: Record<string, StatusMeta> = {
  approved: { text: '通过', type: 'success' },
  needs_revision: { text: '要求修改', type: 'warning' },
  rejected: { text: '拒绝', type: 'danger' },
};

/** 任务状态（TaskStatus 枚举：pending / running / success / failed / canceled，另兼容历史 ok / error / skipped）。 */
export const TASK_STATUS_META: Record<string, StatusMeta> = {
  pending: { text: '排队中', type: 'info' },
  queued: { text: '排队中', type: 'info' },
  running: { text: '运行中', type: 'primary' },
  success: { text: '成功', type: 'success' },
  ok: { text: '成功', type: 'success' },
  failed: { text: '失败', type: 'danger' },
  error: { text: '失败', type: 'danger' },
  canceled: { text: '已取消', type: 'info' },
  skipped: { text: '跳过', type: 'info' },
};

/** 选题消费态（Angle.used 布尔 → 两个展示值；与审核态是两个维度，不合并）。 */
export const USAGE_STATUS_META: Record<string, StatusMeta> = {
  used: { text: '已用', type: 'info' },
  unused: { text: '未用', type: 'success' },
};

/**
 * 取状态文案与配色。
 * 产线文案由后端 GET /api/pipelines 下发（pipelineText），这里委托给它，避免两处维护。
 */
export function statusMeta(kind: StatusKind, value: string | null | undefined): StatusMeta {
  const v = String(value ?? '');
  if (kind === 'pipeline') return { text: pipelineText(v), type: pipelineTagType(v) };
  const table: Record<string, StatusMeta> =
    kind === 'article'
      ? ARTICLE_STATUS_META
      : kind === 'angle'
        ? ANGLE_STATUS_META
        : kind === 'verdict'
          ? REVIEW_VERDICT_META
          : kind === 'task'
            ? TASK_STATUS_META
            : USAGE_STATUS_META;
  return table[v] ?? { text: v || '—', type: 'info' };
}

/** 选题审核态文案（筛选下拉等只需要文字的地方用）。 */
export function angleStatusText(status: string): string {
  return statusMeta('angle', status).text;
}

/**
 * 旧签名：文章状态取文案 / 配色。
 * 仅为尚未迁移的历史调用（ArticleEditView）保留，新代码请用 statusMeta 或 <StatusTag>。
 */
export function statusText(status: string): string {
  return statusMeta('article', status).text;
}

export function statusTag(status: string): TagType {
  return statusMeta('article', status).type;
}

/** 凭据状态 → Element 标签类型。 */
const CRED_TAG: Record<string, TagType> = {
  ok: 'success',
  placeholder: 'info',
  invalid: 'danger',
  missing: 'warning',
};

/**
 * 凭据状态文案（S5-UI-5-P2-2）：后端 credStatus 只做「格式校验」，
 * 系统没有真实验证状态字段——ok 仅代表 AppID/Secret 格式合规，
 * 绝不能写成「就绪 / 已验证 / 可用」暗示微信接口认证成功。
 */
const CRED_TEXT: Record<string, string> = {
  ok: '格式合规',
  placeholder: '待填写',
  invalid: '格式错误',
  missing: '未填写',
};

/** 状态标签的辅助说明（tooltip）；ok 明确点出「不代表接口验证成功」。 */
const CRED_HINT: Record<string, string> = {
  ok: 'AppID / AppSecret 格式符合要求；尚未代表微信公众号接口验证成功，请点「测试连通」确认。',
  placeholder: '当前是占位示例值，需填入真实 AppID / AppSecret 才能启用。',
  invalid: 'AppID / AppSecret 格式不合规，请检查后重新填写。',
  missing: '尚未填写 AppID / AppSecret，补齐后才会启用。',
};

export function credTag(status: string): TagType {
  return CRED_TAG[status] ?? 'info';
}

export function credText(status: string): string {
  return CRED_TEXT[status] ?? status;
}

/** 凭据状态的完整含义（用于 tooltip / 说明）。 */
export function credHint(status: string): string {
  return CRED_HINT[status] ?? '凭据状态未知';
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
