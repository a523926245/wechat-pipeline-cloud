<script setup lang="ts">
/**
 * 品牌标识：绿叶生长寓意的圆角磁贴 + 可选字标。
 * 展开态显示图标与「公众号产销 · pipeline cloud」，收起态仅显示图标。
 * 图标用内联 SVG，无外部字体依赖；白字在品牌绿渐变上对比度达标。
 */
withDefaults(defineProps<{ size?: number; withWordmark?: boolean }>(), {
  size: 30,
  withWordmark: true,
});
</script>

<template>
  <div class="brand-logo" :class="{ 'brand-logo--compact': !withWordmark }">
    <span class="brand-logo__tile" :style="{ width: `${size}px`, height: `${size}px` }">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" :width="size * 0.62" :height="size * 0.62">
        <path d="M12 21V11" stroke="#fff" stroke-width="2" stroke-linecap="round" />
        <path
          d="M12 13C10.5 13 8.5 12 7 10.5C5.6 9.1 5.2 7 5.8 5.6C7.9 6 10 7.6 11.2 9.7C11.7 10.8 12 12 12 13Z"
          fill="#fff"
        />
        <path
          d="M12 13C13.5 13 15.5 12 17 10.5C18.4 9.1 18.8 7 18.2 5.6C16.1 6 14 7.6 12.8 9.7C12.3 10.8 12 12 12 13Z"
          fill="#fff"
          opacity="0.82"
        />
      </svg>
    </span>

    <span v-if="withWordmark" class="brand-logo__text">
      <strong class="brand-logo__main">公众号产销</strong>
      <span class="brand-logo__sub">pipeline cloud</span>
    </span>
  </div>
</template>

<style scoped>
.brand-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.brand-logo__tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--wb-primary-grad);
  box-shadow: 0 2px 6px rgba(10, 124, 71, 0.28);
  flex: none;
}

.brand-logo__text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}

.brand-logo__main {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text-strong);
  white-space: nowrap;
}

.brand-logo__sub {
  font-size: 11px;
  color: var(--wb-text-muted);
  letter-spacing: 0.4px;
  white-space: nowrap;
}
</style>
