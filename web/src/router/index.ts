import { createRouter, createWebHistory } from 'vue-router';

/** 每个页面声明标题与一句话说明，供顶部区域与文档标题使用。 */
const routes = [
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
  // 旧路径保留跳转，避免历史书签与外链失效。
  { path: '/credentials', redirect: '/accounts' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/** 切换页面时同步文档标题，方便多标签页识别与辅助技术朗读。 */
router.afterEach((to) => {
  const title = (to.meta.title as string | undefined) ?? '';
  document.title = title ? `${title} · 公众号产销` : '公众号产销';
});

export default router;
