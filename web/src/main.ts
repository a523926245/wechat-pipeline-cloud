import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
// 暗色变量必须在 styles.css 之前引入，这样本项目的 html.dark 令牌覆盖才能压过 EP 默认的蓝色主色
import 'element-plus/theme-chalk/dark/css-vars.css';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import router from './router/index.ts';

import './styles.css';

// 主题：在挂载前应用，避免浅色先闪一下（深色逻辑见 web/src/composables/useTheme.ts）
const THEME_KEY = 'wb-theme-pref';
const savedPref = localStorage.getItem(THEME_KEY) as 'light' | 'dark' | 'system' | null;
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const initialDark = savedPref === 'dark' || (savedPref !== 'light' && prefersDark);
if (initialDark) document.documentElement.classList.add('dark');

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');
