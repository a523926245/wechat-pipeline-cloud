<script setup lang="ts">
/**
 * 统一状态标签（S5-UI-1）。
 *
 * 词表在 utils/format.ts 的 statusMeta 里集中维护，页面不得再各自复制一套
 * （此前 TrackAnglesView 自带 statusText / statusTagType，与 format.ts 分叉）。
 *
 * 状态必须「文字 + 颜色」双通道表达：色弱用户与黑白打印下也能读，
 * 所以文字永远渲染，颜色只是辅助。未知状态原样显示，不猜也不归并。
 */
import { computed } from 'vue';

import { statusMeta, type StatusKind } from '../utils/format.ts';

const props = withDefaults(
  defineProps<{
    /** 状态所属业务维度：文章 / 选题审核 / 任务 / 产线 / 选题消费 */
    kind: StatusKind;
    /** 状态原值（来自 API，直接传，不做映射前的加工） */
    value: string | null | undefined;
    size?: 'large' | 'default' | 'small';
    effect?: 'dark' | 'light' | 'plain';
  }>(),
  { size: 'small', effect: 'light' },
);

const meta = computed(() => statusMeta(props.kind, props.value));
</script>

<template>
  <el-tag v-if="value" :type="meta.type" :size="size" :effect="effect">{{ meta.text }}</el-tag>
</template>
