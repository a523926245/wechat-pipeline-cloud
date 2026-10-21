<script setup lang="ts">
import {
  DataAnalysis,
  Document,
  Expand,
  Files,
  Fold,
  List,
  MagicStick,
  Moon,
  Refresh,
  Sunny,
  Timer,
  User,
} from '@element-plus/icons-vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import BrandLogo from './components/BrandLogo.vue';
import { getHealth, getModelMeta, getPipelineMeta, getSystemStatus } from './api/index.ts';
import { errMsg } from './api/http.ts';
import { roleText, setModelLabels, setPipelineLabels } from './utils/format.ts';
import { useTheme } from './composables/useTheme.ts';
import type { Health, SystemStatus } from './types.ts';

const route = useRoute();

const { pref, theme, set: setTheme } = useTheme();
const themeIcon = computed(() => (theme.value === 'dark' ? Sunny : Moon));

const health = ref<Health | null>(null);
const healthErr = ref('');
const collapsed = ref(false);
const status = ref<SystemStatus | null>(null);

const menuItems = [
  { path: '/', label: '仪表盘', icon: DataAnalysis },
  { path: '/plan', label: '创作计划', icon: List },
  { path: '/scheduler', label: '自动调度', icon: Timer },
  { path: '/articles', label: '文章', icon: Document },
  { path: '/accounts', label: '账号管理', icon: User },
  { path: '/tracks', label: '赛道管理', icon: Files },
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

/**
 * 拉一次模型域标签表（供应商/协议/能力/角色中文名）。
 * 失败不弹错、不阻塞：各页面有兜底文案，只是显示成原始英文值。
 */
async function loadModelMeta() {
  try {
    setModelLabels(await getModelMeta());
  } catch {
    setModelLabels(null);
  }
}

/** 产线标签（文章/漫画与角度切片的中文名），同样由后端下发。失败静默走兜底。 */
async function loadPipelineMeta() {
  try {
    setPipelineLabels(await getPipelineMeta());
  } catch {
    setPipelineLabels(null);
  }
}

/** 轻量系统状态（模型绑定 + 健康），侧边栏底部常驻显示。失败静默：区块整体隐藏。 */
async function loadStatus() {
  try {
    status.value = await getSystemStatus();
  } catch {
    status.value = null;
  }
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadStatus()]);
}

/** 角色行：ready 与否决定状态点颜色，未就绪原因放 tooltip。 */
const statusRoles = computed(() => {
  const m = status.value?.models;
  if (!m) return [];
  const keys = Object.keys(m.roleAvailability ?? {});
  const list = keys.length ? keys : Object.keys(m.bindings ?? {});
  return list.map((role) => {
    const avail = m.roleAvailability?.[role] ?? null;
    const boundModel = m.bindings?.[role]?.modelName ?? null;
    const ready = avail ? avail.ready : Boolean(boundModel);
    return {
      role,
      label: roleText(role),
      modelName: boundModel,
      cls: ready ? 'ok' : boundModel || avail?.bound ? 'bad' : 'off',
      tip: avail && !avail.ready ? (avail.reason ?? '') : '',
    };
  });
});

/** 窄屏自动收起侧边栏，避免导航挤压内容区。 */
function syncCollapsed() {
  collapsed.value = window.innerWidth < 1180;
}

onMounted(() => {
  void loadHealth();
  void loadModelMeta();
  void loadPipelineMeta();
  void loadStatus();
  syncCollapsed();
  window.addEventListener('resize', syncCollapsed);
});

onUnmounted(() => {
  window.removeEventListener('resize', syncCollapsed);
});

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '控制台');
const pageDesc = computed(() => (route.meta.desc as string | undefined) ?? '');

/**
 * 菜单高亮：下钻页（/tracks/3/angles、/articles/12）不属于任何顶层菜单项，
 * 直接用 route.path 会导致侧边栏一个都不亮，体感像走丢，故回落到所属父栏目。
 */
const activeMenu = computed(() => {
  const p = route.path;
  if (p.startsWith('/tracks')) return '/tracks';
  if (p.startsWith('/articles')) return '/articles';
  return p;
});

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
          :default-active="activeMenu"
          class="menu"
        >
          <el-menu-item v-for="it in menuItems" :key="it.path" :index="it.path">
            <el-icon><component :is="it.icon" /></el-icon>
            <template #title>{{ it.label }}</template>
          </el-menu-item>
        </el-menu>
      </nav>

      <!-- 常驻系统状态：替代原仪表盘上的「系统健康 / 模型与角色绑定」独立板块 -->
      <div v-if="!collapsed && status" class="sys-status" aria-label="系统状态">
        <div class="sys-status__title">系统状态</div>
        <div class="sys-status__row">
          <span class="sys-chip">
            <span class="mini-dot" :class="status.health.db ? 'ok' : 'bad'" />数据库
          </span>
          <span class="sys-chip">
            <span class="mini-dot" :class="status.health.masterKey ? 'ok' : 'bad'" />密钥
          </span>
          <span class="sys-chip">
            <span class="mini-dot" :class="status.health.scheduler.enabled ? 'ok' : 'off'" />调度
          </span>
          <span class="sys-chip sys-chip--muted">模型 {{ status.models.enabled }}/{{ status.models.total }}</span>
        </div>
        <el-tooltip
          v-for="r in statusRoles"
          :key="r.role"
          :content="r.tip"
          :disabled="!r.tip"
          placement="right"
        >
          <div class="sys-role">
            <span class="mini-dot" :class="r.cls" />
            <span class="sys-role__label">{{ r.label }}</span>
            <span class="sys-role__model">{{ r.modelName ?? '未绑定' }}</span>
          </div>
        </el-tooltip>
      </div>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-button
            class="collapse-btn"
            text
            :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="collapsed = !collapsed"
          >
            <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
          </el-button>
          <div class="titles">
            <strong>{{ pageTitle }}</strong>
            <span v-if="pageDesc" class="wb-muted">{{ pageDesc }}</span>
          </div>
        </div>
        <div class="header-right">
          <span class="status-dot" :class="`status-dot--${backend.type}`" aria-hidden="true" />
          <el-tag class="backend-tag" :type="backend.type" size="small" effect="light">{{ backend.text }}</el-tag>
          <el-dropdown trigger="click" :aria-label="'主题：' + (pref === 'system' ? '跟随系统' : pref === 'dark' ? '深色' : '浅色')" @command="setTheme">
            <el-button :icon="themeIcon" size="small" text />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="system" :class="{ 'is-active': pref === 'system' }">跟随系统</el-dropdown-item>
                <el-dropdown-item command="light" :class="{ 'is-active': pref === 'light' }">浅色</el-dropdown-item>
                <el-dropdown-item command="dark" :class="{ 'is-active': pref === 'dark' }">深色</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button :icon="Refresh" size="small" text @click="refreshAll">刷新状态</el-button>
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

/* nav 是侧边栏的 flex 子元素，必须由它撑开剩余高度，
   系统状态块才能被推到侧边栏底部（左下角）。 */
nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

nav .menu {
  flex: 1;
}

/* ── 侧边栏底部系统状态 ── */
.sys-status {
  border-top: 1px solid var(--wb-border);
  padding: 10px 16px 12px;
  font-size: 12px;
  color: var(--wb-text-secondary);
  flex: none;
}

.sys-status__title {
  font-weight: 600;
  color: var(--wb-text-muted);
  letter-spacing: 0.02em;
  margin-bottom: 6px;
}

.sys-status__row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 6px;
}

.sys-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.sys-chip--muted {
  color: var(--wb-text-muted);
}

.mini-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--wb-text-muted);
}

.mini-dot.ok {
  background: #16a34a;
}

.mini-dot.bad {
  background: var(--wb-danger);
}

.mini-dot.off {
  background: var(--wb-border);
}

.sys-role {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.7;
  min-width: 0;
}

.sys-role__label {
  flex: none;
}

.sys-role__model {
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  font-size: 16px;
  flex: none;
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
