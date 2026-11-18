<script setup lang="ts">
/**
 * 统一空状态（S5-UI-1）。
 *
 * 只表达「查询成功但没有数据」，不用于错误态：
 * 加载失败请用 StateError（带重试），否则用户会以为「本来就没有数据」，
 * 把一个可恢复的故障当成业务空档。
 *
 * 三种语义靠传参区分，不新增状态值：
 *   - 无数据："还没有赛道，新增一个开始创作"
 *   - 搜索无结果："没有匹配的账号"（并给「重置筛选」这类出口）
 *   - 无可用数据："暂无可排产账号（需凭据格式合规且启用）"
 */
withDefaults(
  defineProps<{
    /** 主文案：说清「为什么空」 */
    description: string;
    /** 补充说明（可省）：说清「满足什么条件才会有」 */
    hint?: string;
    /** 插图尺寸，默认 60（表格内嵌用 48） */
    imageSize?: number;
  }>(),
  { imageSize: 60 },
);
</script>

<template>
  <el-empty :description="description" :image-size="imageSize">
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <!-- 默认插槽放下一步动作（新增/重置筛选/去配置），由页面决定 -->
    <slot />
  </el-empty>
</template>

<style scoped>
.empty-hint {
  margin: 0 0 var(--wb-space-2);
  max-width: 420px;
  color: var(--wb-text-muted);
  font-size: var(--wb-fs-aux);
  line-height: 1.6;
  text-align: center;
}
</style>
