/**
 * 全局登录态（模块级单例，App.vue / LoginView / 路由守卫共享）。
 *
 * 起因：App.vue 在 onMounted 拉一次 auth 就不再更新，LoginView 登录成功只做了路由跳转，
 * 菜单与顶栏还挂着「未登录/游客」的旧状态，要手动刷新页面才恢复。
 * 解法：把 auth 放到模块级 ref，登录成功/登出/路由守卫都刷新同一份，谁改全页面都可见。
 */
import { computed, ref } from 'vue';

import { getAuthStatus } from '../api/index.ts';
import type { AuthStatus, UserRole } from '../types.ts';

const auth = ref<AuthStatus | null>(null);

export function useAuth() {
  /** 拉取并覆盖当前登录态。后端不可达时置 null（页面自行提示连接失败）。 */
  async function loadAuth(): Promise<void> {
    try {
      auth.value = await getAuthStatus();
    } catch {
      auth.value = null;
    }
  }

  const userRole = computed<UserRole>(() => auth.value?.user?.role ?? 'guest');
  const userName = computed(() => auth.value?.user?.username ?? '');
  const loggedIn = computed(() => auth.value?.loggedIn ?? false);

  return { auth, loadAuth, userRole, userName, loggedIn };
}
