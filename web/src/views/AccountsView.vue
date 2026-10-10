<script setup lang="ts">
import { Connection, Edit, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { errMsg } from '../api/http.ts';
import { listCredentials, testCredential, updateCredential } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { CredentialItem } from '../types.ts';
import { credTag, credText } from '../utils/format.ts';

const items = ref<CredentialItem[]>([]);
const loading = ref(false);
const error = ref('');
const testingId = ref<number | null>(null);
const keyword = ref('');

const dialog = reactive({
  visible: false,
  saving: false,
  id: 0,
  name: '',
  appid: '',
  secret: '',
  author: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await listCredentials();
    items.value = res.items;
  } catch (e) {
    error.value = errMsg(e, '账号列表加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const rows = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return items.value;
  return items.value.filter(
    (i) =>
      i.name.toLowerCase().includes(k) ||
      i.track.toLowerCase().includes(k) ||
      i.appid.toLowerCase().includes(k),
  );
});

const readyCount = computed(() => items.value.filter((i) => i.credStatus === 'ok').length);

function openEdit(row: CredentialItem) {
  dialog.id = row.id;
  dialog.name = row.name;
  dialog.appid = row.appid;
  dialog.secret = '';
  dialog.author = row.author ?? '';
  dialog.visible = true;
}

async function save() {
  dialog.saving = true;
  try {
    const payload: Record<string, string> = {};
    if (dialog.appid) payload.appid = dialog.appid;
    if (dialog.secret) payload.secret = dialog.secret;
    if (dialog.author !== undefined) payload.author = dialog.author;

    if (Object.keys(payload).length === 0) {
      ElMessage.warning('没有需要保存的改动');
      return;
    }

    const res = await updateCredential(dialog.id, payload);
    ElMessage.success(res.message ?? '已保存');
    dialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    dialog.saving = false;
  }
}

async function runTest(row: CredentialItem) {
  if (row.credStatus === 'placeholder' || row.credStatus === 'missing') {
    ElMessageBox.alert(
      `账号「${row.name}」尚未填写真实凭据（当前状态：${credText(row.credStatus)}）。\n` +
        '请先在编辑中填入有效的 AppID 与 Secret，再测试连通。',
      '无法测试',
      { type: 'warning', confirmButtonText: '知道了' },
    );
    return;
  }
  testingId.value = row.id;
  try {
    const res = await testCredential(row.id);
    if (res.ok) {
      ElMessage.success(res.message);
    } else {
      ElMessageBox.alert(res.message, `连通失败（${res.errcode ?? '无 errcode'}）`, {
        type: 'error',
        confirmButtonText: '知道了',
      });
    }
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '连通测试失败'));
  } finally {
    testingId.value = null;
  }
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载账号…">
    <header class="wb-page-head">
      <div>
        <h2>账号管理</h2>
        <p class="wb-page-desc">
          共 {{ items.length }} 个公众号账号 · 就绪 {{ readyCount }} 个 · Secret 只显示掩码
        </p>
      </div>
      <div class="wb-page-actions">
        <el-input
          v-model="keyword"
          :prefix-icon="Search"
          placeholder="搜索账号 / 赛道 / AppID"
          clearable
          style="width: 220px"
          aria-label="搜索账号"
        />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="Secret 落库为 AES-256-GCM 密文，接口只返回掩码；保存后请点「测试连通」真实校验一次。"
    />

    <el-card shadow="never">
      <el-table :data="rows" size="default">
        <el-table-column prop="id" label="ID" width="58" />
        <el-table-column prop="name" label="账号" min-width="120" />
        <el-table-column prop="track" label="赛道" min-width="90" class-name="col-optional" />
        <el-table-column label="AppID" min-width="170">
          <template #default="{ row }">
            <span class="wb-mono">{{ row.appid || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Secret" min-width="140">
          <template #default="{ row }">
            <span class="wb-mono">{{ row.secretMask || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="author" label="作者" width="100" class-name="col-optional" />
        <el-table-column label="状态" width="88">
          <template #default="{ row }">
            <el-tag :type="credTag(row.credStatus)" size="small">{{ credText(row.credStatus) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="70">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="184" fixed="right">
          <template #default="{ row }">
            <el-button :icon="Edit" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button
              :icon="Connection"
              size="small"
              type="primary"
              plain
              :loading="testingId === row.id"
              @click="runTest(row)"
            >
              测试连通
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <span class="wb-muted">{{ keyword ? '没有匹配的账号' : '暂无账号' }}</span>
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog.visible" :title="`编辑账号凭据 · ${dialog.name}`" width="520px">
      <el-form label-width="88px">
        <el-form-item label="AppID">
          <el-input v-model="dialog.appid" placeholder="wx 开头，18 位" />
        </el-form-item>
        <el-form-item label="Secret">
          <el-input
            v-model="dialog.secret"
            type="password"
            show-password
            placeholder="留空表示不修改（后端不返回明文）"
          />
        </el-form-item>
        <el-form-item label="作者">
          <el-input v-model="dialog.author" placeholder="草稿箱显示的作者名" maxlength="64" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
