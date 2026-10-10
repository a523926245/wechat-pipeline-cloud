<script setup lang="ts">
import { DataAnalysis, Document, Expand, Fold, List, MagicStick, Refresh, User } from '@element-plus/icons-vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import BrandLogo from './components/BrandLogo.vue';
import { getHealth } from './api/index.ts';
import { errMsg } from './api/http.ts';
import type { Health } from './types.ts';

const route = useRoute();

const health = ref<Health | null>(null);
const healthErr = ref('');
const collapsed = ref(false);

const menuItems = [
  { path: '/', label: '仪表盘', icon: DataAnalysis },
  { path: '/plan', label: '创作计划', icon: List },
  { path: '/articles', label: '文章', icon: Document },
  { path: '/accounts', label: '账号管理', icon: User },
  { path: '/models', label: '模型配置', icon: MagicStick },
];

async function loadHealth() {
  try {
    health.value = await getHealth();
    healthErr.value = '';
  } catch (e) {
    healthErr.value = errMsg(e, '后端未连接');
    health.value = null;
  }
}

/** 窄屏自动收起侧边栏，避免导航挤压内容区。 */
function syncCollapsed() {
  collapsed.value = window.innerWidth < 1180;
}

onMounted(() => {
  void loadHealth();
  syncCollapsed();
  window.addEventListener('resize', syncCollapsed);
});

onUnmounted(() => {
  window.removeEventListener('resize', syncCollapsed);
});

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '控制台');
const pageDesc = computed(() => (route.meta.desc as string | undefined) ?? '');

const backend = computed(() => {
  if (healthErr.value) {
    return { type: 'danger' as const, text: `后端离线：${healthErr.value}` };
  }
  if (!health.value) return { type: 'info' as const, text: '检测中…' };
  const h = health.value;
  return {
    type: h.ok ? ('success' as const) : ('danger' as const),
    text: `${h.driver} · 自动发布 ${h.autoPublish ? '已开启' : '已关闭'}`,
  };
});
</script>

<template>
  <a class="wb-skip-link" href="#wb-main">跳到主要内容</a>

  <el-container class="shell">
    <el-aside class="aside" :class="{ 'aside--collapsed': collapsed }">
      <div class="brand">
        <BrandLogo :with-wordmark="!collapsed" />
      </div>

      <nav aria-label="主导航">
        <el-menu
          router
          :collapse="collapsed"
          :collapse-transition="false"
          :default-active="route.path"
          class="menu"
        >
          <el-menu-item v-for="it in menuItems" :key="it.path" :index="it.path">
            <el-icon><component :is="it.icon" /></el-icon>
            <template #title>{{ it.label }}</template>
          </el-menu-item>
        </el-menu>
      </nav>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <button
            class="collapse-btn"
            type="button"
            :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="collapsed = !collapsed"
          >
            <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
          </button>
          <div class="titles">
            <strong>{{ pageTitle }}</strong>
            <span v-if="pageDesc" class="wb-muted">{{ pageDesc }}</span>
          </div>
        </div>
        <div class="header-right">
          <span class="status-dot" :class="`status-dot--${backend.type}`" aria-hidden="true" />
          <el-tag class="backend-tag" :type="backend.type" size="small" effect="light">{{ backend.text }}</el-tag>
          <el-button :icon="Refresh" size="small" text @click="loadHealth">刷新状态</el-button>
        </div>
      </el-header>

      <el-main id="wb-main" class="main">
        <router-view v-slot="{ Component }">
          <transition name="wb-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.shell {
  height: 100vh;
}

.aside {
  width: 208px;
  background: var(--wb-surface);
  border-right: 1px solid var(--wb-border);
  display: flex;
  flex-direction: column;
  transition: width 0.18s ease;
  overflow: hidden;
}

.aside--collapsed {
  width: 64px;
}

.brand {
  padding: 16px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--wb-border);
  min-height: 56px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--wb-text-muted);
  box-shadow: 0 0 0 3px rgba(134, 144, 156, 0.18);
}

.status-dot--success {
  background: #16a34a;
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.16);
}

.status-dot--danger {
  background: var(--wb-danger);
  box-shadow: 0 0 0 3px rgba(213, 73, 65, 0.16);
}

.status-dot--info {
  background: var(--wb-text-muted);
  box-shadow: 0 0 0 3px rgba(134, 144, 156, 0.18);
}

.menu {
  border-right: none;
  flex: 1;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-3);
  background: var(--wb-surface);
  border-bottom: 1px solid var(--wb-border);
  height: 56px;
  padding: 0 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  min-width: 0;
}

.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  cursor: pointer;
  flex: none;
}

.collapse-btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.titles {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}

.titles strong {
  font-size: 15px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex: none;
}

.main {
  overflow: auto;
  padding: var(--wb-space-4) 20px 32px;
}

@media (max-width: 767px) {
  .main {
    padding: var(--wb-space-3) 12px 24px;
  }

  .header {
    padding: 0 10px;
  }

  .titles span {
    display: none;
  }

  .header-right :deep(.el-button) {
    padding: 0 6px;
  }
}
</style>
