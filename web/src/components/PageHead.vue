<script setup lang="ts">
/**
 * 页面标题区（S5-UI-1）：统一「标题 + 一句话说明 + 主操作」的排版。
 *
 * 与顶栏的分工：顶栏只显示面包屑（我在哪），页面主标题由这里唯一负责。
 * 曾经两处都显示同一个标题（App.vue 的 pageTitle 与各页 h2），造成重复。
 *
 * 语义用 h1：一个页面只应有一个 h1，正好由本组件承担；
 * 标题文案仍来自各页实际业务（如「选题库」「文风配置」），本组件不做任何拼装。
 */
defineProps<{
  /** 页面主标题 */
  title: string;
  /** 一句话用途说明（可省略） */
  desc?: string;
}>();
</script>

<template>
  <header class="wb-page-head">
    <div class="head-main">
      <h1 class="head-title">{{ title }}</h1>
      <p v-if="desc" class="wb-page-desc">{{ desc }}</p>
    </div>
    <div v-if="$slots.actions" class="wb-page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.head-main {
  min-width: 0;
}

.head-title {
  /* 字号/行高/字重由 styles.css 的 .wb-page-head h1 统一给出，这里只管不被挤压 */
  word-break: break-word;
}
</style>
