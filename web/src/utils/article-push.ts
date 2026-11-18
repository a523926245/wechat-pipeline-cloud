/**
 * 文章「推送事实 / 推送反馈」展示层的唯一口径（S5-UI-3-1）。
 *
 * 为什么单独成模块：
 *  - 列表页与改稿页曾各写一份推送失败分类，列表页把 already_pushed / pushing / lint_failed
 *    都显示成「无 errcode」，被误读成微信接口报错（S5-UI-3-0 · P2-5）。
 *  - 批量删除 impact 曾用 status==='pushed' 判推送，与后端删除事务的 hasPushTrace 口径不一致（P2-4）。
 *  - 列表长期不展示推送事实，无法区分「从未推送」与「推送后退回草稿」（P2-1）。
 *
 * 口径来源（只读引用，本模块不修改任何后端逻辑）：
 *  - 推送事实判据 = server/src/services/article-delete.ts 的 hasPushTrace()：
 *    mediaId / pushDate 任一 trim 后非空即视为有推送痕迹，**不看 status**。
 *  - status 是会被覆盖的当前态，事实是历史痕迹；两者分开理解，绝不互相推导。
 *
 * 本模块是纯函数、无 Vue / API 依赖，供页面直接使用，也可被 node --experimental-strip-types
 * 的断言脚本直接加载测试（见 web/scripts/assert-article-push.mjs）。
 */

import type { TagType } from './format.ts';

/** 推送痕迹所需的最小字段集合（ArticleListItem 与 PushResult 都结构兼容）。 */
export interface PushTraceFields {
  mediaId?: string | null;
  pushDate?: string | null;
}

/** 推送失败结果所需的最小字段集合（PushResult 结构兼容）。 */
export interface PushFailFields {
  reason?: string | null;
  everPushed?: boolean;
  errcode?: number | null;
}

/**
 * 前端等价的「有推送痕迹」判据，逐字对齐后端 hasPushTrace()。
 * 非字符串、null、undefined 一律按无痕迹处理；空白串不算痕迹。
 */
export function hasPushTrace(row: PushTraceFields): boolean {
  const media = typeof row.mediaId === 'string' ? row.mediaId.trim() : '';
  const date = typeof row.pushDate === 'string' ? row.pushDate.trim() : '';
  return media !== '' || date !== '';
}

export interface PushFact {
  /** 主文案（表格推送事实列展示） */
  text: string;
  /** el-tag 配色 */
  type: TagType;
  /** trim 后的 pushDate；仅当有痕迹且日期非空时给出，页面再用 friendlyTime 格式化。无日期时为空串，绝不虚构。 */
  dateRaw: string;
  /** tooltip 补充，解释「为什么这么显示」，避免用户把事实误读成审核状态 */
  hint: string;
}

/**
 * 由「推送痕迹 + 当前 status」派生推送事实展示。
 *
 * 展示规则（与 S5-UI-3-0 §4.2 映射表一致）：
 *  - 无痕迹                  → 未推送（不管 status 是 draft 还是 failed，首次失败也算从未推送）
 *  - 有痕迹 + status=pushed  → 已推送（有日期才展示日期）
 *  - 有痕迹 + status=draft/updated → 推送后已改（内容或状态已发生变化）
 *  - 有痕迹 + status=failed  → 有历史推送记录（历史脏数据，不能误判成「已推送后修改」）
 *  - 有痕迹 + 其它未知 status → 有推送记录（如实说有痕迹，不臆测具体语义）
 */
export function pushFact(row: PushTraceFields & { status?: string | null }): PushFact {
  if (!hasPushTrace(row)) {
    return {
      text: '未推送',
      type: 'info',
      dateRaw: '',
      hint: '尚无推送到公众号草稿箱的记录',
    };
  }
  const dateRaw = typeof row.pushDate === 'string' ? row.pushDate.trim() : '';
  const status = String(row.status ?? '');
  if (status === 'pushed') {
    return {
      text: '已推送',
      type: 'success',
      dateRaw,
      hint: dateRaw ? '已推送到公众号草稿箱' : '已推送到公众号草稿箱（无日期记录）',
    };
  }
  if (status === 'draft' || status === 'updated') {
    return {
      text: '推送后已改',
      type: 'warning',
      dateRaw,
      hint: '曾推送到草稿箱，当前内容或状态已变化；本系统不支持原地更新公众号草稿',
    };
  }
  if (status === 'failed') {
    return {
      text: '有历史推送记录',
      type: 'info',
      dateRaw,
      hint: '本次推送失败，但此前曾成功推送到草稿箱',
    };
  }
  return {
    text: '有推送记录',
    type: 'info',
    dateRaw,
    hint: '有推送到公众号草稿箱的记录',
  };
}

/**
 * 批量删除的 impact 文案：只把「已推送」判据从 status 换成推送痕迹，
 * 其余措辞与原文案逐字一致。这样「其余 N 篇归还角度」与后端删除事务
 * （article-delete.ts 用 hasPushTrace 决定是否回收角度）严格同口径。
 */
export function batchDeleteImpact(rows: PushTraceFields[]): string {
  const pushed = rows.filter(hasPushTrace).length;
  const parts: string[] = ['文章删除后不可恢复。'];
  if (pushed > 0) {
    parts.push(
      `其中 ${pushed} 篇已推送到公众号草稿箱，删除只影响本系统内的副本，微信侧不受影响。`,
    );
  }
  const notPushed = rows.length - pushed;
  if (notPushed > 0) {
    parts.push(
      `其余 ${notPushed} 篇占用的选题角度会归还角度池，可能被再次用于新文章。`,
    );
  }
  return parts.join('\n');
}

export interface PushFailView {
  /** 失败弹窗 / 提示的标题 */
  title: string;
  /** 弹窗类型：业务规则拦截（已推送 / 推送中）用 warning，其余用 error */
  type: 'warning' | 'error';
}

/**
 * 推送失败反馈映射：列表页与改稿页共用，杜绝把业务拦截显示成「无 errcode」。
 *
 * 分类顺序不可调换（与改稿页已验收逻辑一致）：
 *  1) lint_failed   → 成稿体检未通过（推送门禁，非微信报错）
 *  2) already_pushed→ 已推送过，不能重复建草稿（防重复守卫，非微信报错）
 *  3) pushing       → 正在推送中（in-flight 串行守卫，非微信报错）
 *  4) everPushed    → 本次失败未清除此前推送记录（历史痕迹提示）
 *  5) 有 errcode    → 微信接口返回的真实错误码
 *  6) 无 errcode    → 普通失败（如实显示「无 errcode」，不臆造微信错误）
 *
 * 调用方仍使用 res.message 作为正文、res.detail 等作为详情，本函数只统一标题与类型，
 * 不吞掉 PushResult 中的任何有效信息。
 */
export function pushFailView(res: PushFailFields): PushFailView {
  if (res.reason === 'no_account') {
    // 后端 no_account = 文章没有 accountId（未绑定账号），不是微信接口报错。
    return { title: '尚未配置可用于推送的公众号账号', type: 'warning' };
  }
  if (res.reason === 'lint_failed') {
    return { title: '成稿体检未通过', type: 'error' };
  }
  if (res.reason === 'already_pushed') {
    return { title: '该文章已推送过，不能重复建草稿', type: 'warning' };
  }
  if (res.reason === 'pushing') {
    return { title: '该文章正在推送中', type: 'warning' };
  }
  if (res.everPushed) {
    return { title: '推送未成功（本次失败未清除此前的推送记录）', type: 'error' };
  }
  return { title: `推送未成功（${res.errcode ?? '无 errcode'}）`, type: 'error' };
}

/**
 * 无账号错误的引导文案（S5-UI-5-P2-4）：纯函数、无 Vue/API 依赖。
 * 后端 no_account 只表示文章未绑定账号；凭据格式错误/停用/微信失败是其它 reason，
 * 绝不能混进来。路由与权限口径：
 *  - 账号管理真实路由 /accounts（router/index.ts）；
 *  - oa_account:manage 权限 admin/member 有、guest 无（server/src/api/permissions.ts）；
 *  - 页面菜单 /accounts 对 admin/member 可见（App.vue）。
 * 文案不声称「已验证/已就绪」——凭据格式合规不代表微信接口验证成功。
 */
export function noAccountGuide(role: string): { message: string; canManage: boolean } {
  const canManage = role === 'admin' || role === 'member';
  return {
    canManage,
    message: canManage
      ? '这篇文章没有绑定可用于推送的公众号账号，因此未创建草稿。\n请到「账号管理」新增账号、填写 AppID / AppSecret，并点「测试连通」确认可用后再推送。（测试连通只验证接口，不会群发。）'
      : '这篇文章没有绑定可用于推送的公众号账号，因此未创建草稿。\n账号配置需要管理员或有管理权限的成员完成，请联系他们到「账号管理」处理。',
  };
}
