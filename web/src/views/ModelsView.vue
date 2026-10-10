<script setup lang="ts">
import { Connection, Delete, Edit, Plus, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { errMsg } from '../api/http.ts';
import {
  bindRole,
  createModel,
  deleteModel,
  getBindings,
  listModels,
  testModel,
  updateModel,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { BindingMap, LlmModelPayload, LlmModelView, ModelRole } from '../types.ts';
import { roleText } from '../utils/format.ts';

const ROLES: ModelRole[] = ['write', 'revise', 'cover', 'expand_angles'];

const models = ref<LlmModelView[]>([]);
const bindings = ref<BindingMap>({});
const loading = ref(false);
const error = ref('');
const testingId = ref<number | null>(null);
const bindingRole = ref<string>('');

const dialog = reactive({
  visible: false,
  saving: false,
  editingId: 0,
  form: {
    name: '',
    provider: 'openai_compat',
    capability: 'text',
    baseUrl: '',
    modelId: '',
    apiKey: '',
    enabled: true,
    isDefault: false,
  } as LlmModelPayload & { enabled: boolean; isDefault: boolean },
});

/** 字段级错误：提交时给出，明确指向具体输入框。 */
const fieldErrors = reactive<{ name: string; baseUrl: string; modelId: string }>({
  name: '',
  baseUrl: '',
  modelId: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [m, b] = await Promise.all([listModels(), getBindings()]);
    models.value = m.items;
    bindings.value = b.bindings;
  } catch (e) {
    error.value = errMsg(e, '模型列表加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const enabledCount = computed(() => models.value.filter((m) => m.enabled).length);

function resetErrors() {
  fieldErrors.name = '';
  fieldErrors.baseUrl = '';
  fieldErrors.modelId = '';
}

function openCreate() {
  dialog.editingId = 0;
  dialog.form = {
    name: '',
    provider: 'openai_compat',
    capability: 'text',
    baseUrl: '',
    modelId: '',
    apiKey: '',
    enabled: true,
    isDefault: false,
  };
  resetErrors();
  dialog.visible = true;
}

function openEdit(row: LlmModelView) {
  dialog.editingId = row.id;
  dialog.form = {
    name: row.name,
    provider: row.provider,
    capability: row.capability,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    apiKey: '',
    enabled: row.enabled,
    isDefault: row.isDefault,
  };
  resetErrors();
  dialog.visible = true;
}

async function save() {
  resetErrors();
  let bad = false;
  if (!dialog.form.name.trim()) {
    fieldErrors.name = '请填写模型名称';
    bad = true;
  }
  if (!dialog.form.baseUrl.trim()) {
    fieldErrors.baseUrl = '请填写 Base URL';
    bad = true;
  }
  if (!dialog.form.modelId.trim()) {
    fieldErrors.modelId = '请填写模型 ID';
    bad = true;
  }
  if (bad) return;

  dialog.saving = true;
  try {
    const payload: Partial<LlmModelPayload> & { enabled?: boolean; isDefault?: boolean } = { ...dialog.form };
    // 编辑时留空表示不改动 Key
    if (dialog.editingId > 0 && !payload.apiKey) delete payload.apiKey;

    if (dialog.editingId === 0) {
      await createModel(payload as LlmModelPayload);
      ElMessage.success('模型已创建');
    } else {
      await updateModel(dialog.editingId, payload);
      ElMessage.success('模型已更新');
    }
    dialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    dialog.saving = false;
  }
}

async function remove(row: LlmModelView) {
  try {
    await ElMessageBox.confirm(
      `确定删除模型「${row.name}」？若它正被角色绑定，绑定会一并解除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteModel(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '删除失败'));
  }
}

async function runTest(row: LlmModelView) {
  testingId.value = row.id;
  try {
    const res = await testModel(row.id);
    if (res.ok) {
      ElMessageBox.alert(res.sample ? `响应示例：${res.sample}` : res.message, '连通成功', {
        type: 'success',
        confirmButtonText: '知道了',
      });
    } else {
      ElMessageBox.alert(res.message, '连通失败', { type: 'error', confirmButtonText: '知道了' });
    }
  } catch (e) {
    ElMessage.error(errMsg(e, '连通测试失败'));
  } finally {
    testingId.value = null;
  }
}

async function onBind(role: string, modelId: number | null) {
  if (!modelId) {
    ElMessage.info('请直接绑定到其他模型来替换当前绑定');
    await load();
    return;
  }
  bindingRole.value = role;
  try {
    const res = await bindRole(role, modelId);
    ElMessage.success(`${roleText(role)} 已绑定到「${res.modelName}」`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '绑定失败'));
  } finally {
    bindingRole.value = '';
  }
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载模型…">
    <header class="wb-page-head">
      <div>
        <h2>模型配置</h2>
        <p class="wb-page-desc">
          共 {{ models.length }} 个模型 · 启用 {{ enabledCount }} 个 · Key 加密落库只回掩码
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button :icon="Plus" type="primary" @click="openCreate">新增模型</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="写作角色未绑定有效模型时，自动创作会回退为骨架草稿；编辑模型时 API Key 留空表示不修改。"
    />

    <el-card shadow="never">
      <template #header>角色绑定</template>
      <el-row :gutter="12">
        <el-col v-for="role in ROLES" :key="role" :xs="24" :sm="12" :md="6">
          <div class="bind-cell">
            <label class="bind-label" :for="`bind-${role}`">{{ roleText(role) }}</label>
            <el-select
              :id="`bind-${role}`"
              :model-value="bindings[role]?.modelId ?? undefined"
              :loading="bindingRole === role"
              placeholder="未绑定"
              size="default"
              style="width: 100%"
              @update:model-value="(v: number | undefined) => onBind(role, v ?? null)"
            >
              <el-option v-for="m in models" :key="m.id" :label="m.name" :value="m.id" />
            </el-select>
            <span class="wb-muted">{{ bindings[role]?.modelName ?? '未绑定（回退骨架）' }}</span>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never">
      <template #header>模型列表</template>

      <el-table :data="models" size="default">
        <el-table-column prop="id" label="ID" width="58" />
        <el-table-column prop="name" label="名称" min-width="120" />
        <el-table-column prop="provider" label="提供方" width="118" class-name="col-optional" />
        <el-table-column prop="capability" label="能力" width="70" />
        <el-table-column label="Base URL" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><span class="wb-mono">{{ row.baseUrl }}</span></template>
        </el-table-column>
        <el-table-column prop="modelId" label="模型 ID" min-width="140" show-overflow-tooltip />
        <el-table-column label="Key" width="112">
          <template #default="{ row }">
            <span class="wb-mono">{{ row.apiKeyMask || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="132">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
            <el-tag v-if="row.isDefault" type="warning" size="small" style="margin-left: 4px">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="228" fixed="right">
          <template #default="{ row }">
            <el-button :icon="Connection" size="small" :loading="testingId === row.id" @click="runTest(row)">
              测试
            </el-button>
            <el-button :icon="Edit" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button :icon="Delete" size="small" type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <span class="wb-muted">还没有配置模型</span>
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog.visible" :title="dialog.editingId ? '编辑模型' : '新增模型'" width="560px">
      <el-form label-width="100px">
        <el-form-item label="名称" required :error="fieldErrors.name">
          <el-input v-model="dialog.form.name" placeholder="例如：主力写作模型" maxlength="64" />
        </el-form-item>
        <el-form-item label="提供方">
          <el-select v-model="dialog.form.provider" style="width: 100%">
            <el-option label="OpenAI 兼容" value="openai_compat" />
            <el-option label="Agnes Image" value="agnes_image" />
          </el-select>
        </el-form-item>
        <el-form-item label="能力">
          <el-select v-model="dialog.form.capability" style="width: 100%">
            <el-option label="文本" value="text" />
            <el-option label="图像" value="image" />
          </el-select>
        </el-form-item>
        <el-form-item label="Base URL" required :error="fieldErrors.baseUrl">
          <el-input v-model="dialog.form.baseUrl" placeholder="https://api.openai.com/v1" />
        </el-form-item>
        <el-form-item label="模型 ID" required :error="fieldErrors.modelId">
          <el-input v-model="dialog.form.modelId" placeholder="gpt-4o-mini" maxlength="128" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="dialog.form.apiKey"
            type="password"
            show-password
            :placeholder="dialog.editingId ? '留空表示不修改' : 'sk-...'"
          />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="dialog.form.enabled" />
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="dialog.form.isDefault" />
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
.bind-cell {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-1);
  padding-bottom: var(--wb-space-2);
}

.bind-label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
