<script setup lang="ts">
/**
 * 任务状态展示（S5-UI-1）。
 *
 * 边界（重要）：只展示后端**已经记录**的事实——状态、阶段说明、错误原因。
 * 没有真实百分比就不要画进度条：传 progress=null 时只显示状态文字，
 * 绝不为了让界面「看起来在跑」而编造百分比或假动画。
 *
 * 单次调用的耗时/进度目前后端没有落库（TaskRun 只有 status + errorMessage），
 * 所以本组件默认形态就是「状态胶囊 + 可选阶段/原因」，等后端有真数据再扩展。
 *
 * 这不是任务中心：不做列表、不做轮询、不做全局悬浮窗——那属后续独立阶段。
 */
import { computed } from 'vue';

import { statusMeta } from '../utils/format.ts';

const props = withDefaults(
  defineProps<{
    /** 任务状态原值（TaskStatus：pending / running / success / failed / canceled） */
    status: string;
    /** 阶段说明（后端真实字段，如 write / push / lint 等；没有就不传） */
    stage?: string;
    /** 失败原因等补充信息，悬停可见；showMessage 时同时内联显示 */
    message?: string;
    /** 真实进度 0-100；后端没有真实进度时**不要传**，组件不会画进度条 */
    progress?: number | null;
    /** 是否把 message 内联显示（默认仅在 title 悬停里给） */
    showMessage?: boolean;
  }>(),
  { progress: null, showMessage: false, stage: '', message: '' },
);

const meta = computed(() => statusMeta('task', props.status));

/** 只有拿到有限数值才画进度条——0 也是合法值，不能用真值判断 */
const hasProgress = computed(
  () => typeof props.progress === 'number' && Number.isFinite(props.progress),
);

const percentage = computed(() =>
  hasProgress.value ? Math.min(100, Math.max(0, Math.round(props.progress as number))) : 0,
);

const tip = computed(() => [props.stage, props.message].filter(Boolean).join(' · '));
</script>

<template>
  <div class="task-progress" :class="`task-progress--${meta.type}`">
    <span class="task-dot" aria-hidden="true" />
    <span class="task-text">{{ meta.text }}</span>
    <span v-if="stage" class="task-stage">{{ stage }}</span>

    <span v-if="hasProgress" class="task-bar">
      <el-progress :percentage="percentage" :stroke-width="4" :show-text="false" />
      <span class="task-pct wb-num">{{ percentage }}%</span>
    </span>

    <span v-if="showMessage && message" class="task-msg" :title="message">{{ message }}</span>
    <span v-else-if="!showMessage && tip" class="task-tip" :title="tip" aria-hidden="true" />
  </div>
</template>

<style scoped>
.task-progress {
  display: inline-flex;
  align-items: center;
  gap: var(--wb-space-1);
  min-width: 0;
  font-size: var(--wb-fs-aux);
  color: var(--wb-text-secondary);
}

.task-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--wb-text-muted);
}

.task-progress--success .task-dot {
  background: var(--wb-success);
}

.task-progress--danger .task-dot {
  background: var(--wb-danger);
}

.task-progress--warning .task-dot {
  background: var(--wb-warning);
}

.task-progress--primary .task-dot {
  background: var(--wb-primary);
}

.task-text {
  color: var(--wb-text);
  flex: none;
}

.task-stage {
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.task-bar {
  display: inline-flex;
  align-items: center;
  gap: var(--wb-space-1);
  min-width: 90px;
}

.task-bar :deep(.el-progress) {
  flex: 1;
  min-width: 60px;
}

.task-pct {
  flex: none;
  color: var(--wb-text-muted);
}

.task-msg {
  color: var(--wb-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

/* 有阶段/原因但选择不内联时，给一个可悬停的小圆点，避免信息彻底丢失 */
.task-tip {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--wb-border-strong);
  flex: none;
}
</style>
