import { ref } from 'vue';

export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'wb-theme-pref';

const pref = ref<ThemePref>('system');
const theme = ref<'light' | 'dark'>('light');
let initialized = false;

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(p: ThemePref): 'light' | 'dark' {
  if (p === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return p;
}

function apply(p: ThemePref) {
  pref.value = p;
  const t = resolve(p);
  theme.value = t;
  document.documentElement.classList.toggle('dark', t === 'dark');
}

/**
 * 初始化一次：挂载前 main.ts 已按持久化偏好设置好 <html class="dark">，
 * 这里只把响应式状态同步过来，并监听系统配色变化（仅在「跟随系统」时联动）。
 */
function init() {
  if (initialized) return;
  theme.value = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  pref.value = (localStorage.getItem(STORAGE_KEY) as ThemePref | null) ?? 'system';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (pref.value === 'system') apply('system');
  });
  initialized = true;
}

export function useTheme() {
  init();
  function set(p: ThemePref) {
    apply(p);
    localStorage.setItem(STORAGE_KEY, p);
  }
  return { pref, theme, set };
}
