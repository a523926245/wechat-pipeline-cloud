<script setup lang="ts">
/**
 * 批量操作条：选中行后浮现在列表上方。
 *
 * 只做展示与两个动作（批量删除 / 取消选择），具体逻辑在 useBatchDelete 里。
 * 页面把它放在表格上方即可，不必自己写一遍「已选 N 项」的排版。
 */
import { Delete } from '@element-plus/icons-vue';

defineProps<{
  /** 已选条数 */
  count: number;
  /** 删除进行中（禁用按钮防重复提交） */
  loading?: boolean;
  /** 按钮文案，默认「批量删除」 */
  label?: string;
}>();

const emit = defineEmits<{
  (e: 'delete'): void;
  (e: 'clear'): void;
}>();
</script>

<template>
  <div v-if="count > 0" class="batch-bar">
    <span class="batch-count">已选 <b>{{ count }}</b> 项</span>
    <el-button size="small" type="danger" :loading="loading" :icon="Delete" @click="emit('delete')">
      {{ label ?? '批量删除' }}
    </el-button>
    <el-button size="small" :disabled="loading" @click="emit('clear')">取消选择</el-button>
  </div>
</template>

<style scoped>
.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  padding: var(--wb-space-2) var(--wb-space-3);
  margin-bottom: var(--wb-space-2);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-primary-soft);
  flex-wrap: wrap;
}

.batch-count {
  font-size: 13px;
  color: var(--wb-text);
  margin-right: auto;
}

.batch-count b {
  color: var(--wb-primary);
  font-size: 14px;
}
</style>
