<script setup lang="ts">
/**
 * 登录页（P2 多用户版）：账号口令登录 + 注册（管理令牌入口已按需求移除）。
 * 登录成功后种 httpOnly cookie，前端不存任何凭证。
 */
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import BrandLogo from '../components/BrandLogo.vue';
import { errMsg } from '../api/http.ts';
import { login, register } from '../api/index.ts';
import { useAuth } from '../composables/useAuth.ts';

const route = useRoute();
const router = useRouter();
const { loadAuth } = useAuth();

const tab = ref<'login' | 'register'>('login');
const loading = ref(false);

const form = reactive({ username: '', password: '' });
const confirm = ref('');

function goHome(): void {
  const redirect = (route.query.redirect as string | undefined) || '/';
  void router.replace(redirect);
}

/** 登录成功后先刷新全局登录态（App.vue 菜单/顶栏共享它），再跳转——否则要手动刷新页面。 */
async function afterLogin(): Promise<void> {
  await loadAuth();
  ElMessage.success('登录成功');
  goHome();
}

async function submitLogin(): Promise<void> {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入用户名和口令');
    return;
  }
  loading.value = true;
  try {
    await login({ username: form.username.trim(), password: form.password });
    await afterLogin();
  } catch (e) {
    ElMessage.error(errMsg(e, '登录失败'));
  } finally {
    loading.value = false;
  }
}

async function submitRegister(): Promise<void> {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入用户名和口令');
    return;
  }
  if (form.password.length < 8) {
    ElMessage.warning('口令至少 8 个字符');
    return;
  }
  if (form.password !== confirm.value) {
    ElMessage.warning('两次口令不一致');
    return;
  }
  loading.value = true;
  try {
    await register({ username: form.username.trim(), password: form.password });
    ElMessage.success('注册成功，请等待管理员审批后登录');
    tab.value = 'login';
  } catch (e) {
    ElMessage.error(errMsg(e, '注册失败'));
  } finally {
    loading.value = false;
  }
}

</script>

<template>
  <div class="login-page">
    <!-- 极浅品牌渐变纹理（Carbon「brand-approved background texture」：点缀不是色块） -->
    <div class="login-bg" aria-hidden="true" />

    <main class="login-main">
      <section class="login-card" aria-labelledby="login-heading">
        <div class="brand"><BrandLogo :size="34" /></div>

        <h1 id="login-heading" class="heading">{{ tab === 'login' ? '欢迎回来' : '创建账号' }}</h1>
        <p class="sub">{{ tab === 'login' ? '登录以继续使用公众号产销' : '注册后需管理员审批开通' }}</p>

        <el-tabs v-model="tab">
          <el-tab-pane label="登录" name="login">
            <el-form @submit.prevent="submitLogin" label-position="top">
              <el-form-item label="用户名">
                <el-input v-model="form.username" placeholder="请输入用户名" size="large" />
              </el-form-item>
              <el-form-item label="口令">
                <el-input v-model="form.password" type="password" placeholder="请输入口令" size="large" show-password />
              </el-form-item>
              <el-button type="primary" size="large" :loading="loading" native-type="submit" class="submit-btn">
                登录
              </el-button>
            </el-form>
          </el-tab-pane>

          <el-tab-pane label="注册" name="register">
            <el-form @submit.prevent="submitRegister" label-position="top">
              <el-form-item label="用户名">
                <el-input v-model="form.username" placeholder="3 字符以上，仅字母/数字/_-@." size="large" />
              </el-form-item>
              <el-form-item label="口令">
                <el-input v-model="form.password" type="password" placeholder="至少 8 位" size="large" show-password />
              </el-form-item>
              <el-form-item label="确认口令">
                <el-input v-model="confirm" type="password" placeholder="再输入一次口令" size="large" show-password />
              </el-form-item>
              <el-button type="primary" size="large" :loading="loading" native-type="submit" class="submit-btn">
                注册
              </el-button>
            </el-form>
          </el-tab-pane>
        </el-tabs>

      </section>

    </main>
  </div>
</template>

<style scoped>
/* ── 页面底：浅色 + 极低透明度品牌渐变纹理（品牌绿只做点缀，不铺色块） ── */
.login-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--wb-bg, #f4f6f8);
  padding: 32px 16px;
}

.login-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(560px 380px at 12% 8%, rgba(10, 124, 71, 0.06), transparent 62%),
    radial-gradient(640px 460px at 88% 92%, rgba(10, 124, 71, 0.05), transparent 62%);
}

/* ── 居中卡片（shadcn/Carbon 2025 默认形态：单卡聚焦，无营销分屏） ── */
.login-main {
  position: relative;
  width: 100%;
  max-width: 420px;
}

.login-card {
  background: var(--wb-surface, #fff);
  border: 1px solid var(--wb-border, #e5e6eb);
  border-radius: 16px;
  box-shadow: 0 12px 32px rgba(31, 35, 41, 0.07);
  padding: 36px 32px 28px;
}

.brand {
  display: flex;
  justify-content: center;
  margin-bottom: 18px;
}

/* 标题用低饱和渐变文字，有质感但不抢表单（shadcn 惯例） */
.heading {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 700;
  text-align: center;
  letter-spacing: 0.01em;
  background: linear-gradient(135deg, #1f2329 0%, #4e5969 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.sub {
  margin: 0 0 20px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted, #86909c);
}

/* 可见标签（WCAG：占位符不能当标签用） */
.login-card :deep(.el-form-item__label) {
  font-size: 13px;
  color: var(--wb-text-secondary, #4e5969);
  margin-bottom: 2px;
}

.login-card :deep(.el-form-item) {
  margin-bottom: 16px;
}

.submit-btn {
  width: 100%;
  margin-top: 4px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.hint {
  margin: 8px 0 12px;
  font-size: 12px;
  color: var(--wb-text-secondary, #4e5969);
  line-height: 1.6;
}




@media (max-width: 480px) {
  .login-card {
    padding: 28px 20px 22px;
    border-radius: 12px;
  }

  .heading {
    font-size: 21px;
  }
}
</style>
