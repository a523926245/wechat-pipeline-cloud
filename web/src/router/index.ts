import { createRouter, createWebHistory } from 'vue-router';

import { getAuthStatus } from '../api/index.ts';
import { useAuth } from '../composables/useAuth.ts';

const { auth, loadAuth } = useAuth();

/** 每个页面声明标题与一句话说明，供顶部区域与文档标题使用。 */
const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { title: '登录', desc: '账号口令登录 / 注册', public: true, bare: true },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
    meta: { title: '仪表盘', desc: '一眼看清今天的产出、库存与系统健康' },
  },
  {
    path: '/plan',
    name: 'plan',
    component: () => import('../views/PlanView.vue'),
    meta: { title: '创作计划', desc: '今日排产、手动出稿与告警' },
  },
  {
    path: '/scheduler',
    name: 'scheduler',
    component: () => import('../views/SchedulerView.vue'),
    meta: { title: '自动调度', desc: '定时任务开关、写稿时间与手动心跳补跑' },
  },
  {
    path: '/articles',
    name: 'articles',
    component: () => import('../views/ArticlesView.vue'),
    meta: { title: '文章', desc: '已生成文章的列表、改稿与推送草稿箱' },
  },
  {
    path: '/articles/:id',
    name: 'article-edit',
    component: () => import('../views/ArticleEditView.vue'),
    meta: { title: '在线改稿', desc: '编辑语义化正文并实时预览推送产物' },
    props: true,
  },
  {
    path: '/accounts',
    name: 'accounts',
    component: () => import('../views/AccountsView.vue'),
    meta: { title: '账号管理', desc: '公众号账号的 AppID / Secret 维护与连通测试' },
  },
  {
    path: '/tracks',
    name: 'tracks',
    component: () => import('../views/TracksView.vue'),
    meta: { title: '赛道管理', desc: '赛道的新增、每日配额与选题扩库' },
  },
  {
    path: '/tracks/:trackId(\\d+)/angles',
    name: 'track-angles',
    component: () => import('../views/TrackAnglesView.vue'),
    props: true,
    meta: { title: '选题库', desc: '某赛道选题的查看、编辑与手动新增' },
  },
  {
    path: '/models',
    name: 'models',
    component: () => import('../views/ModelsView.vue'),
    meta: { title: '模型配置', desc: 'LLM 模型接入、连通测试与角色绑定' },
  },
  {
    path: '/style-prompts',
    name: 'style-prompts',
    component: () => import('../views/StylePromptsView.vue'),
    meta: { title: '文风配置', desc: '创作总纲、赛道文体与标题/结构/篇幅变体库' },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/UsersView.vue'),
    meta: { title: '用户管理', desc: '注册审批、角色与订阅配额', roles: ['admin'] },
  },
  {
    path: '/prefixes',
    name: 'prefixes',
    component: () => import('../views/PrefixSettingsView.vue'),
    meta: { title: '标题前缀', desc: '文章与漫画的标题前缀配置', roles: ['admin'] },
  },
  // 旧路径保留跳转，避免历史书签与外链失效。
  { path: '/credentials', redirect: '/accounts' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * 鉴权守卫（2026-11-11 登录态；P2 角色校验）：未登录一律去 /login；meta.roles 限定角色。
 * 状态问后端（httpOnly cookie 模式，前端不存凭证）；后端没连上时放行，让页面自己报「后端未连接」。
 * ⚠️ 前端显隐只是体验层——真正硬拦在后端 requirePermission，别把这当安全边界。
 */
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  try {
    const s = await getAuthStatus();
    // 同步到全局登录态（useAuth 单例）：路由守卫本来就每次跳转都问后端，
    // 顺带刷新共享状态，菜单/顶栏跟着自愈，不依赖页面手动刷新。
    auth.value = s;
    if (s.authRequired && !s.loggedIn) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }
    const roles = to.meta.roles as string[] | undefined;
    if (roles && s.user && !roles.includes(s.user.role)) {
      return { path: '/' };
    }
  } catch {
    // 后端不可达：放行到目标页，由页面级 StateError 提示连接失败
    await loadAuth().catch(() => undefined);
  }
  return true;
});

/** 切换页面时同步文档标题，方便多标签页识别与辅助技术朗读。 */
router.afterEach((to) => {
  const title = (to.meta.title as string | undefined) ?? '';
  document.title = title ? `${title} · 公众号产销` : '公众号产销';
});

export default router;
