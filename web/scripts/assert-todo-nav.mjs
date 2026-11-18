/* S5-UI-2-C-P0 回归断言：工作台「去审核」跳转参数。
   ══════════════════════════════════════════════════════════════════════
   用法：npm run test:todo-nav   （node --experimental-strip-types）
   被测对象：web/src/utils/todo-nav.ts（纯函数，无 Vue 依赖）
   覆盖：
   1) 单赛道 candidate=0 / needs_revision=1 → status=needs_revision + used=unused（P0 本身）
   2) 单赛道 candidate=1 / needs_revision=1 → 仍优先 candidate
   3) 单赛道只有候选 / 两者都为 0 → 候选、不构造 status
   4) 多赛道 / 空列表 → 落赛道列表，不构造选题 URL
   5) 明细行跳转：传自己的真实 status，used 条件不变
   不覆盖（需浏览器）：router 实际跳转与目标页是否真能筛出该条 —— 见本轮验收报告。 */

import assert from 'node:assert/strict';

import {
  anglesQuery,
  anglesTopTarget,
  articlesNeedsQuery,
  initialAngleStatus,
  parseArticleNeeds,
  parsePendingTrackIds,
  pendingTrackParam,
} from '../src/utils/todo-nav.ts';

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

console.log('[1] 单赛道：只有待改选题（本轮 P0 场景）');
const onlyRevision = [{ trackId: 5, track: '育儿', candidate: 0, needsRevision: 1 }];
check('初始审核态 = needs_revision', () => {
  assert.equal(initialAngleStatus(onlyRevision[0]), 'needs_revision');
});
check('落点 = 该赛道选题库', () => {
  assert.equal(anglesTopTarget(onlyRevision).path, '/tracks/5/angles');
});
check('URL 带 status=needs_revision 且保留 used=unused', () => {
  assert.deepEqual(anglesTopTarget(onlyRevision).query, {
    used: 'unused',
    status: 'needs_revision',
  });
});
check('修复前行为不应再出现（status 不得为 candidate）', () => {
  assert.notEqual(anglesTopTarget(onlyRevision).query?.status, 'candidate');
});

console.log('[2] 单赛道：候选与待改都有 → 仍优先候选');
const mixed = [{ trackId: 3, track: '星座', candidate: 2, needsRevision: 1 }];
check('初始审核态 = candidate', () => {
  assert.equal(initialAngleStatus(mixed[0]), 'candidate');
});
check('URL = candidate + used=unused', () => {
  assert.deepEqual(anglesTopTarget(mixed).query, { used: 'unused', status: 'candidate' });
});

console.log('[3] 单赛道：边界分布');
check('只有候选（candidate=2, needsRevision=0）→ candidate', () => {
  assert.equal(initialAngleStatus({ candidate: 2, needsRevision: 0 }), 'candidate');
});
check('两者都为 0 → 不构造 status（避免必然为空的筛选）', () => {
  assert.equal(initialAngleStatus({ candidate: 0, needsRevision: 0 }), undefined);
  assert.deepEqual(anglesTopTarget([{ trackId: 7, candidate: 0, needsRevision: 0 }]).query, {
    used: 'unused',
  });
});
check('分布缺失（null）→ 不构造 status', () => {
  assert.equal(initialAngleStatus(null), undefined);
  assert.equal(initialAngleStatus(undefined), undefined);
});

console.log('[4] 多赛道：落赛道列表并带上待审赛道 id（S5-UI-2-D-1）');
const twoTracks = [
  { trackId: 3, candidate: 2, needsRevision: 0 },
  { trackId: 5, candidate: 0, needsRevision: 1 },
];
check('两个赛道 → /tracks', () => {
  assert.equal(anglesTopTarget(twoTracks).path, '/tracks');
});
check('URL 带 pending=3,5（升序，来自真实 byTrack）', () => {
  assert.deepEqual(anglesTopTarget(twoTracks).query, { pending: '3,5' });
});
check('顺序稳定：输入逆序也得到同一个 URL', () => {
  assert.equal(anglesTopTarget([...twoTracks].reverse()).query?.pending, '3,5');
});
check('同一赛道重复出现 → 去重', () => {
  assert.equal(
    pendingTrackParam([
      { trackId: 5, candidate: 1, needsRevision: 0 },
      { trackId: 5, candidate: 0, needsRevision: 1 },
    ]),
    '5',
  );
});
check('分布为 0/0 的赛道不写入参数（不误标）', () => {
  assert.equal(
    pendingTrackParam([
      { trackId: 3, candidate: 1, needsRevision: 0 },
      { trackId: 9, candidate: 0, needsRevision: 0 },
    ]),
    '3',
  );
});
check('非法 id（0 / 负数 / 小数 / NaN）被丢弃', () => {
  assert.equal(
    pendingTrackParam([
      { trackId: 0, candidate: 1, needsRevision: 0 },
      { trackId: -5, candidate: 1, needsRevision: 0 },
      { trackId: 3.5, candidate: 1, needsRevision: 0 },
      { trackId: Number.NaN, candidate: 1, needsRevision: 0 },
      { trackId: 7, candidate: 0, needsRevision: 2 },
    ]),
    '7',
  );
});
check('没有赛道 → 赛道列表，且不带 query', () => {
  assert.deepEqual(anglesTopTarget([]), { path: '/tracks' });
});

console.log('[5] pending 参数解析（赛道页承接）');
check('"3,5" → [3,5]', () => {
  assert.deepEqual(parsePendingTrackIds('3,5'), [3, 5]);
});
check('容忍空格 / 空段："3, ,5," → [3,5]', () => {
  assert.deepEqual(parsePendingTrackIds('3, ,5,'), [3, 5]);
});
check('去重并排序："5,3,5" → [3,5]', () => {
  assert.deepEqual(parsePendingTrackIds('5,3,5'), [3, 5]);
});
check('无效 id 安全忽略："abc,-1,0,3.5,7" → [7]', () => {
  assert.deepEqual(parsePendingTrackIds('abc,-1,0,3.5,7'), [7]);
});
check('数组形式（?pending=3&pending=5）→ [3,5]', () => {
  assert.deepEqual(parsePendingTrackIds(['3', '5']), [3, 5]);
});
check('缺省 / null / 对象 → 空数组（页面按普通列表展示）', () => {
  assert.deepEqual(parsePendingTrackIds(undefined), []);
  assert.deepEqual(parsePendingTrackIds(null), []);
  assert.deepEqual(parsePendingTrackIds(''), []);
  assert.deepEqual(parsePendingTrackIds({}), []);
});
check('解析与生成互逆：pendingTrackParam → parsePendingTrackIds', () => {
  assert.deepEqual(parsePendingTrackIds(pendingTrackParam(twoTracks)), [3, 5]);
});

console.log('[6] 明细行：用该条记录自己的真实 status');
for (const status of ['candidate', 'needs_revision']) {
  check(`明细 status=${status} → URL 原样透传`, () => {
    assert.deepEqual(anglesQuery(status), { used: 'unused', status });
  });
}
check('明细 status 为空时不留空值键', () => {
  assert.deepEqual(anglesQuery(''), { used: 'unused' });
  assert.deepEqual(anglesQuery(undefined), { used: 'unused' });
});
check('used 条件恒为 unused（审核只看未占用的题）', () => {
  assert.equal(anglesQuery('candidate').used, 'unused');
  assert.equal(anglesQuery(undefined).used, 'unused');
});

console.log('[7] 文章待办跳转（S5-UI-2-D-2）');
check('未推送草稿 → needs=draft_unpushed（不再用 status=draft）', () => {
  assert.deepEqual(articlesNeedsQuery('draft_unpushed'), { needs: 'draft_unpushed' });
});
check('待重推 → needs=repush', () => {
  assert.deepEqual(articlesNeedsQuery('repush'), { needs: 'repush' });
});
check('推送失败保持 status=failed（本轮不改）', () => {
  assert.deepEqual(articlesNeedsQuery('failed'), { status: 'failed' });
});
check('漫画草稿保持 status=draft + pipeline=comic', () => {
  assert.deepEqual(articlesNeedsQuery('comic'), { status: 'draft', pipeline: 'comic' });
});
check('去文章（全部）不带任何参数', () => {
  assert.deepEqual(articlesNeedsQuery('all'), {});
});
check('非法 needs 视为未筛（undefined）', () => {
  for (const raw of ['', 'draft', 'repush ', 'DRAFT_UNPUSHED', null, undefined, 1, ['repush']]) {
    assert.equal(parseArticleNeeds(raw), undefined, String(raw));
  }
});
check('合法 needs 原样识别', () => {
  assert.equal(parseArticleNeeds('draft_unpushed'), 'draft_unpushed');
  assert.equal(parseArticleNeeds('repush'), 'repush');
});

console.log(`\n通过 ${passed} 项断言`);
if (process.exitCode) console.error('存在失败断言');
else console.log('全部通过');
