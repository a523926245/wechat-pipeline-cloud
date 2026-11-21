<script setup lang="ts">
import {
  DataAnalysis,
  Document,
  Edit,
  EditPen,
  Expand,
  Files,
  Fold,
  List,
  MagicStick,
  Memo,
  Moon,
  Odometer,
  Operation,
  Refresh,
  Setting,
  Sunny,
  Timer,
  User,
  UserFilled,
} from '@element-plus/icons-vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import BrandLogo from './components/BrandLogo.vue';
import { getHealth, getModelMeta, getPipelineMeta, getSystemStatus, logout } from './api/index.ts';
import { errMsg } from './api/http.ts';
import { roleText, setModelLabels, setPipelineLabels } from './utils/format.ts';
import { useTheme } from './composables/useTheme.ts';
import { useAuth } from './composables/useAuth.ts';
import type { Health, SystemStatus, UserRole } from './types.ts';

const route = useRoute();

const { pref, theme, set: setTheme } = useTheme();
const themeIcon = computed(() => (theme.value === 'dark' ? Sunny : Moon));

const health = ref<Health | null>(null);
const healthErr = ref('');
const collapsed = ref(false);
const status = ref<SystemStatus | null>(null);
/** 系统状态浮层开关：由右上角「系统状态」按钮触发（替代侧栏底部常驻块） */
const statusOpen = ref(false);
// 登录态：模块级单例（useAuth），LoginView 登录成功后刷新 → 菜单/顶栏即时更新，无需手动刷新页面
const { loadAuth, userRole, userName } = useAuth();

const ROLE_TEXT: Record<UserRole, string> = { admin: '管理员', member: '客户', guest: '游客' };

/**
 * 二级菜单（创作 / 运营 / 系统管理）+ 顶层仪表盘。
 * 按角色显隐（P2 RBAC）：admin 全量；member 隐去系统管理；guest 只读（仪表盘/文章）。
 * 组内成员全部被过滤掉时整组隐藏。
 */
interface MenuItem {
  path: string;
  label: string;
  icon: unknown;
  roles: UserRole[];
}
interface MenuGroup {
  key: string;
  label: string;
  icon: unknown;
  items: MenuItem[];
}

/**
 * 完整菜单定义（含 roles）。
 * 侧栏用它做角色过滤，面包屑用它做「页面属于哪个分组」的查表——
 * 面包屑不能依赖过滤结果：否则当前角色看不到某个菜单项时（例如非 admin 落到管理页），
 * 面包屑会莫名少一级。分组只是导航上的归属，与权限无关。
 */
const MENU_GROUPS: MenuGroup[] = [
  {
    key: 'create',
    label: '创作',
    icon: Edit,
    items: [
      { path: '/plan', label: '创作计划', icon: List, roles: ['admin', 'member'] },
      { path: '/articles', label: '文章', icon: Document, roles: ['admin', 'member', 'guest'] },
    ],
  },
  {
    key: 'ops',
    label: '运营',
    icon: Operation,
    items: [
      { path: '/scheduler', label: '自动调度', icon: Timer, roles: ['admin', 'member'] },
      { path: '/accounts', label: '账号管理', icon: User, roles: ['admin', 'member'] },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    icon: Setting,
    items: [
      { path: '/tracks', label: '赛道管理', icon: Files, roles: ['admin'] },
      { path: '/style-prompts', label: '文风配置', icon: EditPen, roles: ['admin'] },
      { path: '/prefixes', label: '标题前缀', icon: Memo, roles: ['admin'] },
      { path: '/models', label: '模型配置', icon: MagicStick, roles: ['admin'] },
      { path: '/users', label: '用户管理', icon: UserFilled, roles: ['admin'] },
    ],
  },
];

/** 侧栏实际渲染的菜单：admin 全量；member 隐去系统管理；guest 只读（仪表盘/文章）。 */
const menuGroups = computed<MenuGroup[]>(() =>
  MENU_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => it.roles.includes(userRole.value)),
  })).filter((g) => g.items.length > 0),
);

/** 仪表盘常驻顶层（所有角色可见）。 */
const dashboardItem: MenuItem = {
  path: '/',
  label: '仪表盘',
  icon: DataAnalysis,
  roles: ['admin', 'member', 'guest'],
};

/** 默认展开的分组（非收起态下让当前所在组处于展开态）。 */
const openGroups = computed(() => menuGroups.value.map((g) => g.key));

async function doLogout() {
  try {
    await logout();
  } catch {
    /* 登出失败也照样回登录页 */
  }
  window.location.href = '/login';
}

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

/** 轻量系统状态（模型绑定 + 健康），供右上角状态浮层显示。失败静默：浮层内提示未取到。 */
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

/**
 * 异常提示：只要有一项硬健康信号不成立，右上角按钮就带红点。
 * 只在拿到状态后判断——拿不到状态不等于系统坏了（可能只是瞬时失败），
 * 那种情况由顶栏的后端离线标签表达。
 */
const statusProblem = computed(() => {
  const s = status.value;
  if (!s) return false;
  return !s.health.db || !s.health.masterKey || (s.degraded?.length ?? 0) > 0;
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
  void loadAuth();
  syncCollapsed();
  window.addEventListener('resize', syncCollapsed);
});

onUnmounted(() => {
  window.removeEventListener('resize', syncCollapsed);
});

/** 顶栏面包屑与 document.title 用的页面标题（来自路由 meta）；页面内部标题由页面自己渲染。 */
const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '控制台');

/**
 * 独立页（登录/注册）：不套侧边栏与头部，整页只渲染自己。
 * meta.bare 标记，登录页是全屏居中布局，套壳反而局促。
 */
const isBarePage = computed(() => route.meta.bare === true);

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

/**
 * 面包屑：首页 / 分组 / 父级（仅下钻页）/ 当前页。
 * 分组名取自 menuGroups，保证「导航里叫什么，面包屑里就叫什么」，不在两处各写一份。
 * 当前页只显示文字（不可点），避免点了没反应。
 */
interface Crumb {
  label: string;
  path: string;
}
const crumbs = computed<Crumb[]>(() => {
  const p = route.path;
  if (p === '/') return [{ label: '仪表盘', path: '' }];

  const list: Crumb[] = [{ label: '首页', path: '/' }];

  const group = MENU_GROUPS.find((g) =>
    g.items.some((it) => p === it.path || p.startsWith(`${it.path}/`)),
  );
  if (group) list.push({ label: group.label, path: '' });

  // 下钻页补一级父栏目，否则「在线改稿」看不出属于文章
  const parent = p.startsWith('/articles/')
    ? { label: '文章', path: '/articles' }
    : p.startsWith('/tracks/')
      ? { label: '赛道管理', path: '/tracks' }
      : null;
  if (parent) list.push(parent);

  list.push({ label: pageTitle.value, path: '' });
  return list;
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
  <!-- 独立页（登录/注册）：无侧边栏、无头部，整页渲染 -->
  <template v-if="isBarePage">
    <router-view v-slot="{ Component }">
      <transition name="wb-fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </template>

  <template v-else>
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
          :default-openeds="openGroups"
          class="menu"
        >
          <el-menu-item :index="dashboardItem.path">
            <el-icon><component :is="dashboardItem.icon" /></el-icon>
            <template #title>{{ dashboardItem.label }}</template>
          </el-menu-item>

          <el-sub-menu v-for="g in menuGroups" :key="g.key" :index="g.key">
            <template #title>
              <el-icon><component :is="g.icon" /></el-icon>
              <span>{{ g.label }}</span>
            </template>
            <el-menu-item v-for="it in g.items" :key="it.path" :index="it.path">
              <el-icon><component :is="it.icon" /></el-icon>
              <template #title>{{ it.label }}</template>
            </el-menu-item>
          </el-sub-menu>
        </el-menu>
      </nav>
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
          <!-- 顶栏只负责「我在哪」：面包屑导航。页面主标题由页内 PageHead 渲染，不在此重复 -->
          <el-breadcrumb class="crumbs" separator="/" aria-label="面包屑导航">
            <el-breadcrumb-item
              v-for="(c, i) in crumbs"
              :key="`${i}-${c.label}`"
              :to="c.path ? { path: c.path } : undefined"
            >
              <span :class="{ 'crumb-current': i === crumbs.length - 1 }">{{ c.label }}</span>
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-tag class="backend-tag" :type="backend.type" size="small" effect="light">{{ backend.text }}</el-tag>

          <!-- 系统状态：原侧栏底部常驻块，改为右上角浮层（窄屏同样可达） -->
          <el-popover
            v-model:visible="statusOpen"
            placement="bottom-end"
            trigger="click"
            :width="330"
            popper-class="sys-pop"
          >
            <template #reference>
              <el-button class="status-btn" text size="small" aria-label="系统状态">
                <el-icon><Odometer /></el-icon>
                <span v-if="statusProblem" class="status-btn__dot" aria-hidden="true" />
              </el-button>
            </template>

            <div class="sys-pop__body">
              <div class="sys-pop__head">
                <strong>系统状态</strong>
                <el-button link type="primary" size="small" :icon="Refresh" @click="refreshAll">刷新</el-button>
              </div>

              <template v-if="status">
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

                <div class="sys-pop__sub">角色绑定</div>
                <el-tooltip
                  v-for="r in statusRoles"
                  :key="r.role"
                  :content="r.tip"
                  :disabled="!r.tip"
                  placement="left"
                >
                  <div class="sys-role">
                    <span class="mini-dot" :class="r.cls" />
                    <span class="sys-role__label">{{ r.label }}</span>
                    <span class="sys-role__model">{{ r.modelName ?? '未绑定' }}</span>
                  </div>
                </el-tooltip>

                <p v-if="status.degraded?.length" class="sys-pop__warn">
                  部分模块数据降级：{{ status.degraded.join('、') }}
                </p>
              </template>

              <p v-else class="sys-pop__warn">
                未取到系统状态（后端可能未连接）。点「刷新」重试，或查看顶栏的连接状态。
              </p>

              <p class="sys-pop__foot wb-muted">自动发布始终关闭；推送只进草稿箱，不群发。</p>
            </div>
          </el-popover>

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
          <el-dropdown trigger="click" aria-label="用户菜单" @command="(c: string) => { if (c === 'logout') doLogout(); }">
            <el-button size="small" text>
              <el-icon><User /></el-icon>&nbsp;{{ userName || '未登录' }}
              <el-tag size="small" effect="plain" class="role-tag">{{ ROLE_TEXT[userRole] }}</el-tag>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ userName }}（{{ ROLE_TEXT[userRole] }}）</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
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

.menu {
  border-right: none;
  flex: 1;
  --el-menu-item-height: 40px;
  --el-menu-sub-menu-title-height: 40px;
}

/* 顶层条目与分组标题统一胶囊样式 */
.menu :deep(.el-menu-item),
.menu :deep(.el-sub-menu__title) {
  margin: 2px 10px;
  border-radius: var(--wb-radius-sm);
  transition: background 0.15s ease, color 0.15s ease;
}

.menu :deep(.el-menu-item:hover),
.menu :deep(.el-sub-menu__title:hover) {
  background: var(--wb-primary-soft-2);
}

.menu :deep(.el-menu-item.is-active) {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}

/* 一级（分组）标题：比子项大一号 + 加粗 + 主文字色——层级从「字大」体现，
   不再用「字小弱化」的反向做法（曾导致一级比二级还小、没有存在感）。 */
.menu :deep(.el-sub-menu__title) {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
  letter-spacing: 0.02em;
}

/* 分组内有激活项：整行品牌高亮，与激活条目同一套视觉语言
   （不挂 is-opened——默认全展开时会三个组一起亮，反而花）。 */
.menu :deep(.el-sub-menu.is-active > .el-sub-menu__title) {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}

/* 二级子条目：略缩进、字号略小，层级一眼可辨 */
.menu :deep(.el-sub-menu .el-menu-item) {
  padding-left: 46px !important;
  height: 36px;
  line-height: 36px;
  font-size: 13px;
}

/* 折叠态：条目紧凑、留出图标列对齐（Element Plus 折叠时自带 el-menu--collapse 类） */
.menu.el-menu--collapse :deep(.el-sub-menu__title),
.menu.el-menu--collapse :deep(.el-menu-item) {
  margin: 2px 6px;
}

/* nav 是侧边栏的 flex 子元素，必须由它撑开剩余高度（折叠态下菜单占满整列）。 */
nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

nav .menu {
  flex: 1;
}

/* ── 系统状态浮层（内容） ── */
.sys-pop__body {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-2);
  max-height: 60vh;
  overflow-y: auto;
  font-size: var(--wb-fs-aux);
  color: var(--wb-text-secondary);
}

.sys-pop__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-2);
  color: var(--wb-text);
}

.sys-pop__sub {
  font-weight: 600;
  color: var(--wb-text-muted);
  letter-spacing: 0.02em;
}

.sys-pop__warn {
  margin: 0;
  color: var(--wb-warning);
  line-height: 1.6;
}

.sys-pop__foot {
  margin: var(--wb-space-1) 0 0;
  line-height: 1.6;
}

.sys-status__row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
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
  background: var(--wb-success);
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

/* 面包屑：字号与正文一致，末级用主文字色加粗，前级弱化 */
.crumbs {
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
}

.crumbs :deep(.el-breadcrumb__inner) {
  color: var(--wb-text-muted);
  font-weight: 400;
}

.crumbs :deep(.el-breadcrumb__inner.is-link:hover) {
  color: var(--wb-primary);
}

.crumbs :deep(.el-breadcrumb__separator) {
  color: var(--wb-border-strong);
}

.crumb-current {
  color: var(--wb-text);
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex: none;
}

.status-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 16px;
}

/* 异常红点：只在真有问题时出现（见 statusProblem），不伪造任何状态 */
.status-btn__dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-danger);
  box-shadow: 0 0 0 2px var(--wb-surface);
}

.main {
  overflow: auto;
  padding: var(--wb-space-4) var(--wb-space-5) var(--wb-space-6);
}

@media (max-width: 900px) {
  /* 状态信息在浮层里仍可看，窄屏把顶栏的后端标签让位给面包屑 */
  .backend-tag {
    display: none;
  }
}

@media (max-width: 767px) {
  .main {
    padding: var(--wb-space-3) 12px 24px;
  }

  .header {
    padding: 0 10px;
    gap: var(--wb-space-2);
  }

  .crumbs {
    font-size: 12px;
  }

  /* 窄屏只留末两级，避免面包屑把折叠按钮挤走 */
  .crumbs :deep(.el-breadcrumb__item:not(:nth-last-child(-n + 2))) {
    display: none;
  }

  .header-right :deep(.el-button) {
    padding: 0 6px;
  }
}
</style>
