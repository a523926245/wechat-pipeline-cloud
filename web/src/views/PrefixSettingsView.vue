<script setup lang="ts">
/**
 * 标题前缀设置（独立栏目，自「自动调度」页拆出）。
 *
 * 文章与漫画各一个标题前缀，避免「文章【冒烟】、漫画【漫】」混排。
 * 前缀在渲染/建稿时幂等添加（标题已带该前缀就不重复加），改动只影响之后生成的草稿。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';

import { errMsg } from '../api/http.ts';
import { getContentPrefixes, updateContentPrefixes } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { ContentPrefixItem } from '../types.ts';

const prefixes = ref<ContentPrefixItem[]>([]);
const prefixForm = reactive<Record<string, string>>({});
const loading = ref(false);
const saving = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await getContentPrefixes();
    prefixes.value = res.items;
    for (const it of res.items) prefixForm[it.key] = it.value;
  } catch (e) {
    error.value = errMsg(e, '标题前缀加载失败');
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const res = await updateContentPrefixes({ ...prefixForm });
    prefixes.value = res.items;
    for (const it of res.items) prefixForm[it.key] = it.value;
    ElMessage.success(res.message ?? '已保存');
  } catch (e) {
    ElMessage.error(errMsg(e, '前缀保存失败'));
  } finally {
    saving.value = false;
  }
}

function prefixLabel(key: string): string {
  if (key === 'title_prefix') return '文章前缀';
  if (key === 'comic_title_prefix') return '漫画前缀';
  return key;
}

onMounted(load);
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载标题前缀…">
    <header class="wb-page-head">
      <div>
        <h2>标题前缀</h2>
        <p class="wb-page-desc">文章与漫画的标题前缀（建稿/渲染时幂等添加）</p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <template v-if="!error">
      <el-card shadow="never" class="prefix-card">
        <el-form label-width="96px" @submit.prevent>
          <el-form-item v-for="p in prefixes" :key="p.key" :label="prefixLabel(p.key)">
            <el-input v-model="prefixForm[p.key]" maxlength="12" style="width: 180px" />
            <span class="wb-muted prefix-hint">
              {{ p.desc }}
              <template v-if="p.value !== prefixForm[p.key]">（当前生效：{{ p.value }}）</template>
            </span>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="前缀在渲染/建稿时幂等添加（标题已带该前缀就不重复加）。改动只影响之后生成的草稿，历史文章标题不变。"
        />

        <div class="prefix-actions">
          <el-button type="primary" :loading="saving" @click="save">保存前缀</el-button>
        </div>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.prefix-card {
  max-width: 720px;
}

.prefix-hint {
  margin-left: var(--wb-space-2);
  font-size: 12px;
}

.prefix-actions {
  margin-top: var(--wb-space-3);
  display: flex;
  justify-content: flex-end;
}
</style>
