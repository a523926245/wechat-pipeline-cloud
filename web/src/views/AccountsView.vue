<script setup lang="ts">
import { Connection, Delete, Edit, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, nextTick, onMounted, reactive, ref } from 'vue';

import { errMsg } from '../api/http.ts';
import {
  createCredential,
  deleteCredential,
  listArticles,
  listCredentials,
  listTracks,
  testCredential,
  updateCredential,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import RowActions, { type RowAction } from '../components/RowActions.vue';
import type { CredentialItem, TrackItem } from '../types.ts';
import { credTag, credText } from '../utils/format.ts';

const items = ref<CredentialItem[]>([]);
const loading = ref(false);
const error = ref('');
const testingId = ref<number | null>(null);
const keyword = ref('');

const tracks = ref<TrackItem[]>([]);
const tracksError = ref('');

async function loadTracks() {
  try {
    const res = await listTracks();
    tracks.value = res.items;
    tracksError.value = '';
  } catch (e) {
    tracksError.value = errMsg(e, '赛道列表加载失败');
  }
}

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

onMounted(() => {
  void load();
  void loadTracks();
});

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

function trackName(trackId: number): string {
  return tracks.value.find((t) => t.id === trackId)?.name ?? `#${trackId}`;
}

// ── 编辑 ──
const dialog = reactive({
  visible: false,
  saving: false,
  id: 0,
  name: '',
  trackId: 0,
  appid: '',
  secret: '',
  author: '',
});
const editFormRef = ref<FormInstance>();

function openEdit(row: CredentialItem) {
  dialog.id = row.id;
  dialog.name = row.name;
  dialog.trackId = row.trackId;
  dialog.appid = row.appid;
  dialog.secret = '';
  dialog.author = row.author ?? '';
  dialog.visible = true;
  void nextTick(() => editFormRef.value?.clearValidate());
}

async function save() {
  if (!editFormRef.value) return;
  try {
    await editFormRef.value.validate();
  } catch {
    return;
  }

  dialog.saving = true;
  try {
    const payload: Record<string, string | number> = {
      name: dialog.name.trim(),
      trackId: dialog.trackId,
    };
    if (dialog.appid) payload.appid = dialog.appid;
    if (dialog.secret) payload.secret = dialog.secret;
    payload.author = dialog.author ?? '';

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

// ── 新增 ──
const createDialog = reactive({
  visible: false,
  saving: false,
  name: '',
  trackId: 0,
  appid: '',
  secret: '',
  author: '',
});
const createFormRef = ref<FormInstance>();

const createRules: FormRules = {
  name: [{ required: true, whitespace: true, message: '账号名不能为空', trigger: 'blur' }],
  trackId: [
    {
      validator: (_rule, value, callback) => {
        if (typeof value === 'number' && value > 0) callback();
        else callback(new Error('请选择所属赛道'));
      },
      trigger: 'change',
    },
  ],
  appid: [{ required: true, whitespace: true, message: 'AppID 不能为空', trigger: 'blur' }],
};

const editRules: FormRules = {
  name: [{ required: true, whitespace: true, message: '账号名不能为空', trigger: 'blur' }],
  trackId: [
    {
      validator: (_rule, value, callback) => {
        if (typeof value === 'number' && value > 0) callback();
        else callback(new Error('请选择所属赛道'));
      },
      trigger: 'change',
    },
  ],
};

function openCreate() {
  createDialog.name = '';
  createDialog.trackId = tracks.value[0]?.id ?? 0;
  createDialog.appid = '';
  createDialog.secret = '';
  createDialog.author = '';
  createDialog.visible = true;
  if (tracksError.value) void loadTracks();
  void nextTick(() => createFormRef.value?.clearValidate());
}

async function submitCreate() {
  if (!createFormRef.value) return;
  try {
    await createFormRef.value.validate();
  } catch {
    return;
  }

  createDialog.saving = true;
  try {
    const res = await createCredential({
      trackId: createDialog.trackId,
      name: createDialog.name.trim(),
      appid: createDialog.appid.trim(),
      secret: createDialog.secret,
      author: createDialog.author || undefined,
    });
    ElMessage.success(res.message ?? '账号已创建');
    createDialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '创建失败'));
  } finally {
    createDialog.saving = false;
  }
}

// ── 删除 ──
async function removeAccount(row: CredentialItem) {
  let articleCount = 0;
  try {
    const res = await listArticles({ accountId: row.id, limit: 1 });
    articleCount = res.total;
  } catch {
    // 取不到数量也要能删，只是提示里不带数字
  }

  const detail =
    articleCount > 0
      ? `该账号名下还有 ${articleCount} 篇文章，删除账号时这些文章会一并删除（微信草稿箱里已推送的内容不受影响）。`
      : '该账号名下目前没有文章。';

  try {
    await ElMessageBox.confirm(
      `确定要删除账号「${row.name}」吗？\n\n${detail}`,
      '删除账号',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        dangerouslyUseHTMLString: false,
      },
    );
  } catch {
    return;
  }

  try {
    const res = await deleteCredential(row.id);
    ElMessage.success(res.message ?? '账号已删除');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '删除失败'));
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

/** 行操作菜单项，供 RowActions 组件渲染。 */
function accountActions(row: CredentialItem): RowAction[] {
  return [
    {
      command: 'test',
      label: '测试连通',
      icon: Connection,
      loading: testingId.value === row.id,
    },
    { command: 'edit', label: '编辑', icon: Edit },
    { command: 'delete', label: '删除', icon: Delete, type: 'danger', divided: true },
  ];
}

function onAccountCommand(cmd: string, row: CredentialItem) {
  if (cmd === 'test') runTest(row);
  else if (cmd === 'edit') openEdit(row);
  else if (cmd === 'delete') removeAccount(row);
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
        <el-button type="primary" :icon="Plus" @click="openCreate">新增账号</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <template v-else>
    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="Secret 落库为 AES-256-GCM 密文，接口只返回掩码；保存后请点「测试连通」真实校验一次。账号来自哪个赛道决定了它用哪个选题池。"
    />

    <el-card shadow="never">
      <!-- 宽度约定：数字/状态列固定 width；文本列用 min-width + show-overflow-tooltip——
           min-width 列会按比例分摊表格剩余宽度（自适应撑满），只有挤不下时才出省略号 -->
      <el-table :data="rows" size="default">
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column prop="name" label="账号" min-width="170" show-overflow-tooltip />
        <el-table-column
          label="赛道"
          width="130"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            {{ row.track || trackName(row.trackId) }}
          </template>
        </el-table-column>
        <el-table-column label="AppID" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="wb-mono">{{ row.appid || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Secret" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="wb-mono">{{ row.secretMask || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="author"
          label="作者"
          width="110"
          class-name="col-optional"
          show-overflow-tooltip
        />
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="credTag(row.credStatus)" size="small">{{ credText(row.credStatus) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="72">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="accountActions(row)"
              @command="(cmd: string) => onAccountCommand(cmd, row)"
            />
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :description="keyword ? '没有匹配的账号' : '还没有账号，新增一个开始创作'">
            <el-button v-if="!keyword" type="primary" :icon="Plus" size="small" @click="openCreate">
              新增账号
            </el-button>
          </el-empty>
        </template>
      </el-table>
    </el-card>
    </template>

    <!-- 新增账号 -->
    <el-dialog v-model="createDialog.visible" title="新增账号" width="min(560px, 92vw)">
      <el-alert
        v-if="tracksError"
        type="warning"
        show-icon
        :closable="false"
        :title="tracksError"
      >
        <template #default>
          <span>{{ tracksError }}</span>
          <el-button link type="primary" size="small" @click="loadTracks">重试</el-button>
        </template>
      </el-alert>

      <el-form ref="createFormRef" :model="createDialog" :rules="createRules" label-width="96px">
        <el-form-item label="所属赛道" prop="trackId">
          <el-select
            v-model="createDialog.trackId"
            placeholder="选择赛道（决定用哪个选题池）"
            style="width: 100%"
          >
            <el-option
              v-for="t in tracks"
              :key="t.id"
              :label="`${t.name}（选题可用 ${t.angleUnused}）`"
              :value="t.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="账号名称" prop="name">
          <el-input v-model="createDialog.name" placeholder="给账号起个好认的名字" maxlength="64" />
        </el-form-item>
        <el-form-item label="AppID" prop="appid">
          <el-input v-model="createDialog.appid" placeholder="wx 开头，18 位" />
        </el-form-item>
        <el-form-item label="Secret">
          <el-input
            v-model="createDialog.secret"
            type="password"
            show-password
            placeholder="可留空，之后再补（留空则为「缺失」状态，不会启用）"
          />
        </el-form-item>
        <el-form-item label="作者">
          <el-input v-model="createDialog.author" placeholder="草稿箱显示的作者名" maxlength="64" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="createDialog.saving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑账号 -->
    <el-dialog v-model="dialog.visible" :title="`编辑账号 · ${dialog.name}`" width="min(560px, 92vw)">
      <el-form ref="editFormRef" :model="dialog" :rules="editRules" label-width="96px">
        <el-form-item label="账号名称" prop="name">
          <el-input v-model="dialog.name" maxlength="64" />
        </el-form-item>
        <el-form-item label="所属赛道" prop="trackId">
          <el-select v-model="dialog.trackId" style="width: 100%">
            <el-option
              v-for="t in tracks"
              :key="t.id"
              :label="`${t.name}（选题可用 ${t.angleUnused}）`"
              :value="t.id"
            />
          </el-select>
        </el-form-item>
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

<style scoped>
</style>
