<script setup lang="ts">
import { Edit, Refresh, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { listArticles, pushArticle } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { ArticleListItem } from '../types.ts';
import { friendlyTime, statusTag, statusText } from '../utils/format.ts';

const router = useRouter();
const route = useRoute();

const items = ref<ArticleListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const pushingId = ref<number | null>(null);

const PAGE_SIZE = 20;

/** 筛选与页码放进 URL：可分享、可返回、刷新不丢失。 */
const status = computed<string>(() => (typeof route.query.status === 'string' ? route.query.status : ''));
const page = computed<number>(() => {
  const n = Number(route.query.page ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await listArticles({
      status: status.value || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    items.value = res.items;
    total.value = res.total;
  } catch (e) {
    error.value = errMsg(e, '文章列表加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([status, page], load);

function setQuery(patch: Record<string, string | number | undefined>) {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...route.query, ...patch })) {
    if (v !== undefined && v !== '') query[k] = String(v);
  }
  void router.replace({ query });
}

function goEdit(id: number) {
  void router.push(`/articles/${id}`);
}

async function push(row: ArticleListItem) {
  try {
    await ElMessageBox.confirm(
      `将「${row.title}」推送到公众号草稿箱（不会群发）。确认继续？`,
      '推送确认',
      { type: 'warning', confirmButtonText: '推送草稿箱', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  pushingId.value = row.id;
  try {
    const res = await pushArticle(row.id);
    if (res.ok) {
      ElMessage.success(res.message ?? '已推送到草稿箱');
    } else {
      ElMessageBox.alert(res.message ?? '推送失败', `推送未成功（${res.errcode ?? '无 errcode'}）`, {
        type: 'error',
        confirmButtonText: '知道了',
      });
    }
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '推送失败'));
  } finally {
    pushingId.value = null;
  }
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载文章…">
    <header class="wb-page-head">
      <div>
        <h2>文章</h2>
        <p class="wb-page-desc">共 {{ total }} 篇 · 改稿后可推送到公众号草稿箱</p>
      </div>
      <div class="wb-page-actions">
        <el-select
          :model-value="status"
          placeholder="全部状态"
          clearable
          style="width: 140px"
          @update:model-value="(v: string) => setQuery({ status: v, page: undefined })"
        >
          <el-option label="草稿" value="draft" />
          <el-option label="已推送" value="pushed" />
          <el-option label="已更新" value="updated" />
          <el-option label="失败" value="failed" />
        </el-select>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-card shadow="never">
      <el-table v-if="items.length" :data="items" size="default">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="title" label="标题" min-width="260" show-overflow-tooltip />
        <el-table-column label="账号" width="110" class-name="col-optional">
          <template #default="{ row }">{{ row.account ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="chars" label="字数" width="76" />
        <el-table-column prop="blocks" label="段落" width="70" class-name="col-optional" />
        <el-table-column label="创建" width="150" class-name="col-optional">
          <template #default="{ row }">
            <span class="wb-muted">{{ friendlyTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="176" fixed="right">
          <template #default="{ row }">
            <el-button :icon="Edit" size="small" @click="goEdit(row.id)">改稿</el-button>
            <el-button
              :icon="Upload"
              size="small"
              type="primary"
              plain
              :loading="pushingId === row.id"
              @click="push(row)"
            >
              推送
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-else-if="!loading" description="暂无文章，可到「创作计划」立即出稿" :image-size="64">
        <el-button type="primary" size="small" @click="router.push('/plan')">去创作计划</el-button>
      </el-empty>

      <div v-if="total > PAGE_SIZE" class="pager">
        <el-pagination
          layout="prev, pager, next, total"
          :total="total"
          :page-size="PAGE_SIZE"
          :current-page="page"
          background
          @current-change="(p: number) => setQuery({ page: p })"
        />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--wb-space-3);
}
</style>
