/* S5-UI-3-1 回归断言：推送事实 / 批量删除 impact / 推送失败分类。
   ══════════════════════════════════════════════════════════════════════
   用法：npm run test:article-push   （node --experimental-strip-types）
   被测对象：web/src/utils/article-push.ts（纯函数，无 Vue / API 依赖）
   覆盖：
   1) hasPushTrace：空串 / 纯空白 / mediaId / pushDate / 两者都有 / 非字符串
   2) pushFact：无痕迹（draft/failed）、已推送、推送后改稿（draft/updated）、
      历史 failed、未知 status；日期缺失不虚构
   3) batchDeleteImpact：判据与后端 hasPushTrace 同口径（含「draft 有痕迹」不再算未推送）
   4) pushFailView：lint_failed / already_pushed / pushing / everPushed / 真实 errcode / 普通失败
   不覆盖（需浏览器）：表格列渲染、tooltip、SaveBar/PageHead 视觉 —— 见实施报告。 */

import assert from 'node:assert/strict';

import {
  batchDeleteImpact,
  hasPushTrace,
  pushFailView,
  pushFact,
} from '../src/utils/article-push.ts';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('[1] hasPushTrace —— 与后端 article-delete.hasPushTrace 等价');
check('空串无痕迹', () => {
  assert.equal(hasPushTrace({ mediaId: '', pushDate: '' }), false);
});
check('纯空白无痕迹（trim）', () => {
  assert.equal(hasPushTrace({ mediaId: '   ', pushDate: '\t\n' }), false);
});
check('仅 mediaId 有痕迹', () => {
  assert.equal(hasPushTrace({ mediaId: 'xyz', pushDate: '' }), true);
});
check('仅 pushDate 有痕迹', () => {
  assert.equal(hasPushTrace({ mediaId: '', pushDate: '2026-11-17 10:00:00' }), true);
});
check('mediaId 带空格也算有痕迹', () => {
  assert.equal(hasPushTrace({ mediaId: '  abc  ', pushDate: '' }), true);
});
check('非字符串字段按无痕迹', () => {
  assert.equal(hasPushTrace({ mediaId: null, pushDate: undefined }), false);
  assert.equal(hasPushTrace({ mediaId: 123, pushDate: {} }), false);
});

console.log('[2] pushFact —— 事实与状态分开看');
check('无痕迹 + draft → 未推送', () => {
  const f = pushFact({ status: 'draft', mediaId: '', pushDate: '' });
  assert.equal(f.text, '未推送');
  assert.equal(f.type, 'info');
  assert.equal(f.dateRaw, '');
});
check('首次推送失败（failed 但无痕迹）→ 未推送，不误判成历史推送', () => {
  const f = pushFact({ status: 'failed', mediaId: '', pushDate: '' });
  assert.equal(f.text, '未推送');
});
check('有痕迹 + pushed → 已推送，带日期', () => {
  const f = pushFact({ status: 'pushed', mediaId: 'm1', pushDate: '2026-11-17T10:00:00.000Z' });
  assert.equal(f.text, '已推送');
  assert.equal(f.type, 'success');
  assert.equal(f.dateRaw, '2026-11-17T10:00:00.000Z');
});
check('有痕迹但无日期 → 不虚构日期（dateRaw 空）', () => {
  const f = pushFact({ status: 'pushed', mediaId: 'm1', pushDate: '   ' });
  assert.equal(f.text, '已推送');
  assert.equal(f.dateRaw, '');
  assert.match(f.hint, /无日期记录/);
});
check('推送后改稿：有痕迹 + draft → 推送后已改', () => {
  const f = pushFact({ status: 'draft', mediaId: 'm1', pushDate: '2026-11-17 10:00:00' });
  assert.equal(f.text, '推送后已改');
  assert.equal(f.type, 'warning');
});
check('推送后改写：有痕迹 + updated → 推送后已改', () => {
  const f = pushFact({ status: 'updated', mediaId: 'm1', pushDate: '2026-11-17 10:00:00' });
  assert.equal(f.text, '推送后已改');
  assert.equal(f.type, 'warning');
});
check('历史脏数据：有痕迹 + failed → 有历史推送记录，不误判成「推送后已改」', () => {
  const f = pushFact({ status: 'failed', mediaId: 'm1', pushDate: '2026-11-17 10:00:00' });
  assert.equal(f.text, '有历史推送记录');
  assert.equal(f.type, 'info');
});
check('未知 status 但有痕迹 → 有推送记录，不臆测', () => {
  const f = pushFact({ status: 'weird', mediaId: 'm1', pushDate: '' });
  assert.equal(f.text, '有推送记录');
  assert.equal(f.type, 'info');
});
check('dateRaw 已 trim', () => {
  const f = pushFact({ status: 'pushed', mediaId: 'm1', pushDate: '  2026-11-17  ' });
  assert.equal(f.dateRaw, '2026-11-17');
});

console.log('[3] batchDeleteImpact —— 与后端删除事务回收口径一致');
check('全未推送 → 全部归还角度', () => {
  const s = batchDeleteImpact([
    { mediaId: '', pushDate: '' },
    { mediaId: '', pushDate: '' },
  ]);
  assert.match(s, /其余 2 篇占用的选题角度会归还角度池/);
  assert.doesNotMatch(s, /已推送到公众号草稿箱/);
});
check('全已推送（按痕迹）→ 无角度归还文案', () => {
  const s = batchDeleteImpact([
    { mediaId: 'm1', pushDate: '' },
    { mediaId: '', pushDate: '2026-11-17 10:00:00' },
  ]);
  assert.match(s, /其中 2 篇已推送到公众号草稿箱/);
  assert.doesNotMatch(s, /角度会归还角度池/);
});
check('关键回归：status=draft 但有痕迹 → 算已推送，不说归还角度', () => {
  // 这正是旧实现（status==='pushed'）会判错、导致文案误导的场景。
  const s = batchDeleteImpact([
    { status: 'draft', mediaId: 'm1', pushDate: '' },
    { status: 'draft', mediaId: '', pushDate: '' },
  ]);
  assert.match(s, /其中 1 篇已推送到公众号草稿箱/);
  assert.match(s, /其余 1 篇占用的选题角度会归还角度池/);
});
check('混合：failed 有痕迹算已推送、failed 无痕迹算未推送', () => {
  const s = batchDeleteImpact([
    { status: 'failed', mediaId: 'm1', pushDate: '' },
    { status: 'failed', mediaId: '', pushDate: '' },
  ]);
  assert.match(s, /其中 1 篇已推送到公众号草稿箱/);
  assert.match(s, /其余 1 篇占用的选题角度会归还角度池/);
});

console.log('[4] pushFailView —— 推送失败分类（列表/改稿页共用）');
check('lint_failed → 体检口径，error', () => {
  const v = pushFailView({ reason: 'lint_failed', errcode: null });
  assert.equal(v.title, '成稿体检未通过');
  assert.equal(v.type, 'error');
});
check('already_pushed → 已推送提示，warning（不是「无 errcode」）', () => {
  const v = pushFailView({ reason: 'already_pushed', errcode: null });
  assert.equal(v.title, '该文章已推送过，不能重复建草稿');
  assert.equal(v.type, 'warning');
  assert.doesNotMatch(v.title, /errcode/);
});
check('pushing → 推送中提示，warning', () => {
  const v = pushFailView({ reason: 'pushing' });
  assert.equal(v.title, '该文章正在推送中');
  assert.equal(v.type, 'warning');
});
check('everPushed → 曾推送提示', () => {
  const v = pushFailView({ everPushed: true, errcode: 40001 });
  assert.match(v.title, /未清除此前的推送记录/);
  assert.equal(v.type, 'error');
});
check('真实微信错误 → 显示 errcode', () => {
  const v = pushFailView({ errcode: 40001 });
  assert.equal(v.title, '推送未成功（40001）');
  assert.equal(v.type, 'error');
});
check('普通失败（无 errcode）→ 如实显示「无 errcode」', () => {
  const v = pushFailView({ errcode: null });
  assert.equal(v.title, '推送未成功（无 errcode）');
  assert.equal(v.type, 'error');
});
check('分类优先级：lint_failed 压过 everPushed', () => {
  const v = pushFailView({ reason: 'lint_failed', everPushed: true, errcode: 40001 });
  assert.equal(v.title, '成稿体检未通过');
});

console.log(`\n✅ assert-article-push：${passed} 项通过`);
