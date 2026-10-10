/** 展示层用的小工具，避免各页面重复实现。 */

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

export function roleText(role: string): string {
  const map: Record<string, string> = {
    write: '写作',
    revise: '改写',
    cover: '封面',
    expand_angles: '扩角度',
  };
  return map[role] ?? role;
}

/** 去掉毫秒与时区后缀，显示成可读时间。 */
export function friendlyTime(iso: string): string {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(0, 19);
}
