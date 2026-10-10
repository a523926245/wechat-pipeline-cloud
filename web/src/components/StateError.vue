<script setup lang="ts">
/**
 * 错误态：加载失败时给出明确文案与重试入口。
 * 异步数据必须有「错误 + 可恢复」路径，只弹一条消息是不够的。
 */
import { RefreshRight, WarningFilled } from '@element-plus/icons-vue';

defineProps<{ message: string; label?: string }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="state-error" role="alert">
    <el-icon class="icon"><WarningFilled /></el-icon>
    <div class="text">
      <strong>{{ label ?? '数据加载失败' }}</strong>
      <span class="wb-secondary">{{ message }}</span>
    </div>
    <el-button size="small" :icon="RefreshRight" @click="emit('retry')">重试</el-button>
  </div>
</template>

<style scoped>
.state-error {
  display: flex;
  align-items: center;
  gap: var(--wb-space-3);
  padding: 12px 16px;
  background: #fef2f1;
  border: 1px solid #f7c9c5;
  border-radius: var(--wb-radius);
}

.icon {
  color: var(--wb-danger);
  font-size: 18px;
  flex: none;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

@media (max-width: 520px) {
  .state-error {
    flex-wrap: wrap;
  }
}
</style>
