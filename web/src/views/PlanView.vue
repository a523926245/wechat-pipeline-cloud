<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { getPlan, triggerPlan } from '../api/index.ts';
import EmptyState from '../components/EmptyState.vue';
import PageHead from '../components/PageHead.vue';
import StateError from '../components/StateError.vue';
import StatusTag from '../components/StatusTag.vue';
import RowActions, { type RowAction } from '../components/RowActions.vue';
import type { PlanResult, PlanTask } from '../types.ts';

const router = useRouter();

const plan = ref<PlanResult | null>(null);
const loading = ref(false);
const planError = ref('');
const triggeringKey = ref<string | null>(null);

async function loadPlan() {
  loading.value = true;
  planError.value = '';
  try {
    plan.value = await getPlan({ backlogDays: 3 });
  } catch (e) {
    planError.value = errMsg(e, '计划加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadPlan();
});

const totalPending = computed(() =>
  (plan.value?.tasks ?? []).reduce((s, t) => s + Math.max(0, t.need), 0),
);

/**
 * 后端排产预警与历史欠账（S5-UI-5-P2-1）：只展示接口真实返回的数组，
 * 空/null/不可用一律不渲染，不自行推断或补 0。
 * - warnings: string[]，每条已自带具体原因（角度不足/库存告急/角色未就绪）。
 * - backlog: {date,account,got,miss}[]，近 N 天未写满配额的「历史欠账」，
 *   不是当前批次失败；date 为历史日期，got 当日已出、miss 当日缺口。
 */
const planWarnings = computed<string[]>(() =>
  Array.isArray(plan.value?.warnings) ? plan.value!.warnings : [],
);
const planBacklog = computed<Array<{ date: string; account: string; got: number; miss: number }>>(() =>
  Array.isArray(plan.value?.backlog) ? plan.value!.backlog : [],
);
const warningsExpanded = ref(false);
const shownWarnings = computed(() =>
  warningsExpanded.value ? planWarnings.value : planWarnings.value.slice(0, 2),
);

/** 近作避让标题拼接（模板里不便写类型标注，故提到 script）。 */
function avoidTitles(list: { date: string; title: string }[]): string {
  return (list ?? []).map((a) => a.title).join('、');
}

/** 产线级行标识：同一账号的文章/漫画两条产线各自独立，防重锁不能共用。 */
function rowKey(row: { accountId: number; pipeline: string }): string {
  return `${row.accountId}:${row.pipeline}`;
}


async function trigger(row: { accountId: number; account: string; need: number; pipeline: 'article' | 'comic' }) {
  // 防重入：LLM 写作/漫画脚本是数十秒级重操作，任何触发进行中都不允许再次触发
  if (triggeringKey.value !== null) return;
  triggeringKey.value = rowKey(row);
  const isComic = row.pipeline === 'comic';
  try {
    const res = await triggerPlan(row.accountId, Math.max(1, row.need || 1), row.pipeline);
    // 结果语义（S5-UI-5-P1）：只用真实创建的文章（res.created 均为 id>0）决定能否跳转。
    // failed / skipped 来自后端；旧响应缺省时按 [] / 0 处理，保持兼容。
    const succeeded = res.created ?? [];
    const failed = res.failed ?? [];
    const skipped = res.skipped ?? 0;
    const first = succeeded[0]; // 真实成功文章，id 必然 > 0
    const failedLines = failed.map((f, i) => `  ${i + 1}. ${f.note ?? f.title ?? '失败'}`).join('\n');

    if (!res.ok && failed.length === 0) {
      // 全部跳过（配额满 / 无可消费选题）：与失败明确区分，无绿色成功、无跳转。
      ElMessageBox.alert(
        `本批未创建草稿${skipped > 0 ? `，跳过 ${skipped} 条` : ''}。\n${res.reason ?? res.message}`,
        '未生成草稿',
        { type: 'warning', confirmButtonText: '知道了' },
      );
    } else if (!res.ok) {
      // 全部失败：明确失败结果 + 真实原因 + 可执行下一步，绝不跳 /articles/0。
      ElMessageBox.alert(
        h('p', { style: 'white-space: pre-line; margin: 0' },
          `本批 ${failed.length} 篇建稿失败，未生成任何草稿：\n${failedLines}\n\n` +
          (isComic
            ? '请确认「漫画脚本」模型已就绪，再到选题库检查该选题是否已归还。'
            : '请确认「写作」模型已绑定并就绪，或到选题库检查该选题是否已归还后重试。')),
        '建稿失败',
        { type: 'error', confirmButtonText: '知道了' },
      );
    } else if (failed.length > 0) {
      // 部分成功：成功数与失败数都显示，失败项不隐藏；只跳真实成功文章。
      const skeleton = succeeded.filter((c) => !c.modelUsed).length;
      const body =
        `已生成 ${succeeded.length} 篇草稿，${failed.length} 篇失败。\n` +
        `失败明细：\n${failedLines}` +
        (skeleton > 0 ? `\n\n其中 ${skeleton} 篇未使用模型（骨架草稿），可打开编辑。` : '') +
        '\n\n是否打开第一篇成功草稿？';
      try {
        await ElMessageBox.confirm(body, '部分草稿生成成功', {
          type: 'warning', confirmButtonText: '去改稿', cancelButtonText: '稍后',
        });
        if (first) await router.push(`/articles/${first.id}`);
      } catch { /* 用户选择稍后 */ }
    } else {
      // 全部成功：保留骨架草稿 / 漫画插图的既有提示。
      ElMessage.success(res.message);
      if (first) {
        const skeletonNotes = succeeded
          .filter((c) => !c.modelUsed)
          .map((c) => `《${c.title ?? `ID ${c.id}`}》：未使用模型，已生成骨架草稿`);
        const hasSkeleton = skeletonNotes.length > 0;
        const title = isComic ? '漫画已开始生成' : '已生成草稿';
        const message = hasSkeleton
          ? h('p', { style: 'white-space: pre-line; margin: 0' },
              `${skeletonNotes.join('\n')}\n\n${isComic ? '请到「模型配置」绑定「漫画脚本」角色后重试。' : '请到「模型配置」添加模型并绑定「写作」角色后重新出稿；骨架草稿仍可打开编辑。'}`)
          : isComic
            ? '脚本已生成，分镜插图正在后台自动生成（每格约 30~40 秒，可离开本页）。'
            : '是否立即打开第一篇进行改稿？';
        try {
          await ElMessageBox.confirm(message, hasSkeleton ? (isComic ? '漫画脚本生成异常' : '已生成骨架草稿（模型未参与写作）') : title, {
            type: hasSkeleton ? 'warning' : 'success',
            confirmButtonText: isComic ? '去看插图进度' : '去改稿',
            cancelButtonText: '稍后',
          });
          await router.push(`/articles/${first.id}`);
        } catch { /* 用户选择稍后 */ }
      }
    }
    await loadPlan();
  } catch (e) {
    ElMessage.error(errMsg(e, '触发失败'));
  } finally {
    triggeringKey.value = null;
  }
}

/** 行操作菜单项，供 RowActions 组件渲染。 */
function planActions(row: PlanTask): RowAction[] {
  return [
    {
      command: 'trigger',
      label: row.pipeline === 'comic' ? '生成漫画' : '立即出稿',
      loading: triggeringKey.value === rowKey(row),
    },
  ];
}

function onPlanCommand(cmd: string, row: PlanTask) {
  if (cmd === 'trigger') trigger(row);
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在计算今日排产…">
    <PageHead :desc="`${plan?.date ?? ''}${totalPending ? ` · 今日待补 ${totalPending} 篇` : ''} · 调度设定请到「自动调度」`" title="创作计划">
      <template #actions>
        <el-button :icon="Refresh" @click="loadPlan">刷新</el-button>
      </template>
    </PageHead>

    <StateError v-if="planError" :message="planError" label="创作计划加载失败" @retry="loadPlan" />

    <!-- 今日排产 -->
    <el-card
      shadow="never"
      v-loading="triggeringKey !== null"
      element-loading-text="正在生成（模型处理中，约需数十秒，请勿重复触发）…"
    >
      <template #header>今日排产</template>

      <el-table v-if="plan && plan.tasks.length" :data="plan.tasks" size="default">
        <el-table-column prop="account" label="账号" width="150" show-overflow-tooltip />
        <el-table-column prop="track" label="赛道" width="110" class-name="col-optional" show-overflow-tooltip />
        <el-table-column label="产线" width="84">
          <template #default="{ row }">
            <StatusTag kind="pipeline" :value="row.pipeline" />
          </template>
        </el-table-column>
        <el-table-column prop="alreadyToday" label="已出" width="70" />
        <el-table-column label="待补" width="74">
          <template #default="{ row }">
            <el-tag :type="row.need > 0 ? 'warning' : 'success'" size="small">{{ row.need }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可用角度" width="100">
          <template #default="{ row }">
            <!-- 真实池余量 stock（与赛道管理页一致）。此前误用 angles.length（今日预选数），
                 配额已满时 need=0 会显示 0，被误读成「角度用光了」。 -->
            <span :class="{ 'wb-danger-text': row.stock === 0 }">{{ row.stock }}</span>
            <el-tag v-if="row.short > 0" type="danger" size="small" style="margin-left: var(--wb-space-1)">
              缺 {{ row.short }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="近作避让" min-width="320" class-name="col-optional">
          <template #default="{ row }">
            <span v-if="!row.avoid.length" class="wb-muted">无</span>
            <span v-else class="avoid-cell" :title="avoidTitles(row.avoid)">{{ avoidTitles(row.avoid) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="planActions(row)"
              :busy="triggeringKey === `${row.accountId}:${row.pipeline}`"
              @command="(cmd: string) => onPlanCommand(cmd, row)"
            />
          </template>
        </el-table-column>
      </el-table>
      <EmptyState v-else description="暂无可排产账号（需凭据格式合规且启用）" :image-size="60" />

      <!-- 排产预警（S5-UI-5-P2-1）：后端真实返回的提醒，逐条展示具体原因；空数组不渲染 -->
      <div v-if="planWarnings.length" class="plan-notices">
        <el-alert
          v-for="(w, i) in shownWarnings"
          :key="`warn-${i}`"
          type="warning"
          :closable="false"
          show-icon
          class="plan-warning"
        >
          <template #title><span class="notice-text">{{ w }}</span></template>
        </el-alert>
        <el-button
          v-if="planWarnings.length > 2"
          link
          type="primary"
          size="small"
          class="notice-toggle"
          @click="warningsExpanded = !warningsExpanded"
        >
          {{ warningsExpanded ? '收起提醒' : `展开全部 ${planWarnings.length} 条提醒` }}
        </el-button>
      </div>

      <!-- 历史欠账：近 N 天未写满配额的账号/日期，不是当前批次失败 -->
      <el-alert
        v-if="planBacklog.length"
        type="info"
        :closable="false"
        show-icon
        class="plan-backlog"
      >
        <template #title>
          <div class="backlog-line">
            <span class="backlog-label">近 3 天欠账（非本次排产）：</span>
            <span v-for="(b, i) in planBacklog" :key="`bl-${i}`" class="backlog-item">
              {{ b.date }} · {{ b.account }} 已出 {{ b.got }}、缺 {{ b.miss }}<span v-if="i < planBacklog.length - 1">；</span>
            </span>
          </div>
        </template>
      </el-alert>

      <!-- 未排产原因：原独立卡片「近期欠账与未排产」的保留部分，降级为一行轻提示 -->
      <p v-if="plan?.skipped?.length" class="wb-muted skipped-line">
        未参与排产：<template v-for="(s, i) in plan.skipped" :key="`sk-${i}`">
          <span>{{ s.account }}（{{ s.reason }}）</span><span v-if="i < plan.skipped.length - 1">、</span>
        </template>
      </p>
    </el-card>
  </div>
</template>

<style scoped>
/* 排产预警与历史欠账（S5-UI-5-P2-1） */
.plan-notices {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-1);
  margin-top: var(--wb-space-3);
}

.plan-warning :deep(.el-alert__title) {
  font-size: 13px;
  line-height: 1.6;
}

.notice-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.notice-toggle {
  align-self: flex-start;
  padding: 0;
}

.plan-backlog {
  margin-top: var(--wb-space-2);
}

.plan-backlog :deep(.el-alert__title) {
  font-size: 13px;
  line-height: 1.6;
}

.backlog-line {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.backlog-label {
  font-weight: 600;
}

.backlog-item {
  white-space: nowrap;
}

/* 未排产账号轻提示 */
.skipped-line {
  margin: var(--wb-space-3) 0 0;
  font-size: 13px;
}

/* 近作避让：限两行截断，行高不被长标题列表撑爆；悬停 title 看全文 */
.avoid-cell {
  color: var(--wb-text-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  line-height: 1.6;
  word-break: break-all;
}
</style>
