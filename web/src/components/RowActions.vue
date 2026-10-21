<script setup lang="ts">
/**
 * 通用「行操作」下拉菜单。
 * 各列表页的「操作」列统一收进一个下拉，避免按钮挤在一行。
 * 用法：把每行的动作组装成 RowAction[] 传进来，@command 回传 command 字符串。
 *
 * 约定：
 *  - type 仅 'danger' 有视觉强调（红色），其余为默认文字色；
 *  - loading 时该项显示旋转图标且不可再触发（handler 也应自行防重入）；
 *  - divided 为 true 会在该项前画一条分隔线，通常用来把「删除」这类危险操作隔开。
 */
import { ArrowDown, Loading } from '@element-plus/icons-vue';
import { type Component } from 'vue';

export interface RowAction {
  command: string;
  label: string;
  type?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  icon?: Component;
  disabled?: boolean;
  loading?: boolean;
  divided?: boolean;
}

defineProps<{
  actions: RowAction[];
  triggerText?: string;
  /** 行级忙态：触发按钮转圈并禁用，防止下拉已关闭时看不到 loading 又重复点击。 */
  busy?: boolean;
}>();

const emit = defineEmits<{ (e: 'command', command: string): void }>();

function onCommand(cmd: string) {
  emit('command', cmd);
}
</script>

<template>
  <span class="row-actions">
    <el-dropdown trigger="click" @command="onCommand">
      <el-button size="small" link type="primary" :loading="busy" :disabled="busy">
        <template v-if="!busy">{{ triggerText ?? '操作' }}</template>
        <el-icon v-if="!busy" class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <template v-for="(a, i) in actions" :key="a.command">
            <el-dropdown-item v-if="a.divided && i > 0" divided />
            <el-dropdown-item
              :command="a.command"
              :disabled="a.disabled || a.loading"
              :class="{ 'is-danger': a.type === 'danger' }"
            >
              <el-icon v-if="a.loading" class="is-loading"><Loading /></el-icon>
              <el-icon v-else-if="a.icon"><component :is="a.icon" /></el-icon>
              <span>{{ a.label }}</span>
            </el-dropdown-item>
          </template>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </span>
</template>

<style scoped>
.row-actions :deep(.el-dropdown) {
  line-height: 1;
}

/* 危险操作（删除等）红色，hover 时反白填充，和按钮的 danger 风格一致 */
.row-actions :deep(.el-dropdown-menu__item.is-danger) {
  color: var(--wb-danger);
}
.row-actions :deep(.el-dropdown-menu__item.is-danger:hover),
.row-actions :deep(.el-dropdown-menu__item.is-danger:focus) {
  color: #fff;
  background-color: var(--wb-danger);
}
</style>
