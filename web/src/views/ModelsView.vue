<script setup lang="ts">
/**
 * 模型配置页。四个维度彼此独立，界面也按这个分层组织：
 *   供应商（谁提供）→ 协议（怎么调）→ 能力（产出什么）→ 角色（哪个环节用）
 *
 * 候选项与中文标签全部来自 GET /models/meta，前端不硬编码枚举；
 * 以后加供应商 / 加协议 / 加角色，只改后端 model-registry 一处。
 *
 * 角色绑定做了「选不中就禁用并说明原因」的引导：
 * 与其让用户绑上之后运行时才发现能力不符，不如在下拉里就拦住。
 */
import {
  Connection,
  Delete,
  Edit,
  Plus,
  Refresh,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { computed, nextTick, onMounted, reactive, ref } from "vue";

import RowActions, { type RowAction } from "../components/RowActions.vue";
import { errMsg } from "../api/http.ts";
import {
  bindRole,
  createModel,
  deleteModel,
  getBindings,
  getModelMeta,
  listModels,
  testModel,
  unbindRole,
  updateModel,
} from "../api/index.ts";
import StateError from "../components/StateError.vue";
import type {
  BindingMap,
  LlmModelPayload,
  LlmModelView,
  ModelMeta,
  RoleSpecDto,
} from "../types.ts";
import {
  capabilityText,
  defaultImageRatio,
  defaultImageSize,
  imageRatios,
  imageSizes,
  isProtocolImplemented,
  protocolText,
  roleDesc,
  roleText,
  setModelLabels,
  vendorText,
} from "../utils/format.ts";
import type { TagType } from "../utils/format.ts";

const FALLBACK_ROLES: RoleSpecDto[] = [
  {
    role: "write",
    label: "写作",
    desc: "",
    capabilities: ["text", "multimodal"],
    protocols: [],
    kind: "chat",
    active: true,
  },
  {
    role: "revise",
    label: "改写",
    desc: "",
    capabilities: ["text", "multimodal"],
    protocols: [],
    kind: "chat",
    active: true,
  },
  {
    role: "cover",
    label: "封面",
    desc: "",
    capabilities: ["image"],
    protocols: [],
    kind: "image",
    active: true,
  },
  {
    role: "expand_angles",
    label: "扩角度",
    desc: "",
    capabilities: ["text", "multimodal"],
    protocols: [],
    kind: "chat",
    active: true,
  },
  {
    role: "comic_script",
    label: "漫画脚本",
    desc: "",
    capabilities: ["text", "multimodal"],
    protocols: [],
    kind: "chat",
    active: true,
  },
  {
    role: "comic_panel",
    label: "漫画格",
    desc: "",
    capabilities: ["image"],
    protocols: ["modelscope_qwen_image", "agnes_image"],
    kind: "image",
    active: true,
  },
];

/** 下拉里的解绑哨兵：el-option 用 null 值不稳，用字符串代替。 */
const UNBIND = "__unbind__";

const meta = ref<ModelMeta | null>(null);
const models = ref<LlmModelView[]>([]);
const bindings = ref<BindingMap>({});
const loading = ref(false);
const error = ref("");
const testingId = ref<number | null>(null);
const bindingRole = ref<string>("");

const roles = computed<RoleSpecDto[]>(() =>
  meta.value?.roles?.length ? meta.value.roles : FALLBACK_ROLES,
);
const vendors = computed(() => meta.value?.vendors ?? []);
const protocols = computed(() => meta.value?.protocols ?? []);
const capabilities = computed(() => meta.value?.capabilities ?? []);
/** 生图参数的候选项由 meta 注入到 format.ts，这里只做读取。 */
const imageSizesList = computed(() => imageSizes());
const imageRatiosList = computed(() => imageRatios());

const enabledCount = computed(
  () => models.value.filter((m) => m.enabled).length,
);

interface ModelForm {
  name: string;
  vendor: string;
  protocol: string;
  capability: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  enabled: boolean;
  temperature: number | null;
  maxTokens: number | null;
  size: string;
  ratio: string;
}

const dialog = reactive({
  visible: false,
  saving: false,
  editingId: 0,
  form: {
    name: "",
    vendor: "custom",
    protocol: "openai_chat",
    capability: "text",
    baseUrl: "",
    modelId: "",
    apiKey: "",
    enabled: true,
    temperature: null,
    maxTokens: null,
    size: "2K",
    ratio: "21:9",
  } as ModelForm,
});

/** 表单引用与校验规则：交给 el-form 原生渲染错误，不手写 .field-error。 */
const formRef = ref<FormInstance>();

const rules: FormRules = {
  name: [
    {
      required: true,
      whitespace: true,
      message: "请填写模型名称",
      trigger: "blur",
    },
    { max: 64, message: "模型名称不能超过 64 字", trigger: "blur" },
  ],
  baseUrl: [
    {
      required: true,
      whitespace: true,
      message: "请填写 Base URL",
      trigger: "blur",
    },
  ],
  modelId: [
    {
      required: true,
      whitespace: true,
      message: "请填写模型 ID",
      trigger: "blur",
    },
  ],
};

/** el-collapse 的 v-model 是激活面板名数组，不是布尔。 */
const advOpen = ref<string[]>([]);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // meta 失败不应拖垮整页：标签退化成英文原值，列表照常可用。
    const [m, b, metaRes] = await Promise.all([
      listModels(),
      getBindings(),
      getModelMeta().catch(() => null),
    ]);
    models.value = m.items;
    bindings.value = b.bindings;
    if (metaRes) {
      meta.value = metaRes;
      setModelLabels(metaRes);
    }
  } catch (e) {
    error.value = errMsg(e, "模型列表加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function emptyForm(): ModelForm {
  return {
    name: "",
    vendor: "custom",
    protocol: "openai_chat",
    capability: "text",
    baseUrl: "",
    modelId: "",
    apiKey: "",
    enabled: true,
    temperature: null,
    maxTokens: null,
    size: defaultImageSize(),
    ratio: defaultImageRatio(),
  };
}

function openCreate() {
  dialog.editingId = 0;
  dialog.form = emptyForm();
  advOpen.value = [];
  dialog.visible = true;
  void nextTick(() => formRef.value?.clearValidate());
}

function openEdit(row: LlmModelView) {
  const p = (row.paramsJson ?? {}) as Record<string, unknown>;
  const hasAdv = Boolean(p.size || p.temperature || p.maxTokens);
  dialog.editingId = row.id;
  advOpen.value = hasAdv ? ["adv"] : [];
  dialog.form = {
    name: row.name,
    vendor: row.vendor || "custom",
    protocol: row.protocol,
    capability: row.capability,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    apiKey: "",
    enabled: row.enabled,
    temperature: typeof p.temperature === "number" ? p.temperature : null,
    maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : null,
    size: typeof p.size === "string" ? p.size : defaultImageSize(),
    ratio: typeof p.ratio === "string" ? p.ratio : defaultImageRatio(),
  };
  dialog.visible = true;
  void nextTick(() => formRef.value?.clearValidate());
}

/** 选供应商时顺手带出 Base URL 与协议，减少手填；已填过的 URL 不覆盖。 */
function onVendorChange(vendorId: string) {
  const v = vendors.value.find((x) => x.id === vendorId);
  if (!v) return;
  if (v.defaultBaseUrl && !dialog.form.baseUrl.trim())
    dialog.form.baseUrl = v.defaultBaseUrl;
  if (v.protocols?.length) {
    const first =
      v.protocols.find((p) => isProtocolImplemented(p)) ?? v.protocols[0];
    if (first) onProtocolChange(first);
  }
}

/** 协议决定能力：对话协议配文本、生图协议配图片、视频协议配视频。 */
function onProtocolChange(protocol: string) {
  dialog.form.protocol = protocol;
  const kind = protocols.value.find((p) => p.value === protocol)?.kind;
  if (kind === "image") dialog.form.capability = "image";
  else if (kind === "video") dialog.form.capability = "video";
  else if (
    dialog.form.capability === "image" ||
    dialog.form.capability === "video"
  ) {
    dialog.form.capability = "text";
  }
}

const isImageModel = computed(() => dialog.form.capability === "image");

/** 能力说明由后端下发（尤其「多模态不等于能生图」这句，避免用户绑错）。 */
const capabilityHint = computed(
  () =>
    capabilities.value.find((c) => c.value === dialog.form.capability)?.desc ??
    "",
);

async function save() {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return; // 校验未通过，停留表单
  }

  const form = dialog.form;
  const paramsJson: Record<string, unknown> = {};
  if (isImageModel.value) {
    paramsJson.size = form.size;
    paramsJson.ratio = form.ratio;
  } else {
    if (form.temperature !== null) paramsJson.temperature = form.temperature;
    if (form.maxTokens !== null) paramsJson.maxTokens = form.maxTokens;
  }

  const payload: LlmModelPayload & { apiKey?: string } = {
    name: form.name.trim(),
    vendor: form.vendor,
    protocol: form.protocol,
    capability: form.capability,
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    paramsJson,
    enabled: form.enabled,
  };
  // 编辑时留空表示不改动 Key
  if (form.apiKey) payload.apiKey = form.apiKey;

  dialog.saving = true;
  try {
    if (dialog.editingId === 0) {
      await createModel(payload);
      ElMessage.success("模型已创建");
    } else {
      await updateModel(dialog.editingId, payload);
      ElMessage.success("模型已更新");
    }
    dialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "保存失败"));
  } finally {
    dialog.saving = false;
  }
}

async function remove(row: LlmModelView) {
  try {
    await ElMessageBox.confirm(
      `确定删除模型「${row.name}」？若它正被角色绑定，绑定会一并解除。`,
      "删除确认",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  try {
    await deleteModel(row.id);
    ElMessage.success("已删除");
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "删除失败"));
  }
}

async function runTest(row: LlmModelView) {
  testingId.value = row.id;
  try {
    const res = await testModel(row.id);
    if (res.ok) {
      ElMessageBox.alert(
        res.sample ? `响应示例：${res.sample}` : res.message,
        "连通成功",
        {
          type: "success",
          confirmButtonText: "知道了",
        },
      );
    } else {
      ElMessageBox.alert(res.message, "连通失败", {
        type: "error",
        confirmButtonText: "知道了",
      });
    }
  } catch (e) {
    ElMessage.error(errMsg(e, "连通测试失败"));
  } finally {
    testingId.value = null;
  }
}

// ── 角色绑定 ──

/** 角色候选项：不匹配的一并列出但禁用，并注明原因，避免「看起来没这个模型」。 */
function roleOptions(role: RoleSpecDto) {
  return models.value.map((m) => {
    const reason = rejectReason(role, m);
    return {
      value: String(m.id),
      label: reason ? `${m.name}（${reason}）` : m.name,
      disabled: Boolean(reason),
      reason,
    };
  });
}

function rejectReason(role: RoleSpecDto, m: LlmModelView): string {
  if (!role.capabilities.includes(m.capability))
    return `能力为${capabilityText(m.capability)}，本角色需${role.capabilities.map(capabilityText).join("/")}`;
  const protocolOk =
    role.protocols.length > 0
      ? role.protocols.includes(m.protocol)
      : protocols.value.find((p) => p.value === m.protocol)?.kind === role.kind;
  if (!protocolOk) return `协议为${protocolText(m.protocol)}，本角色不适用`;
  return "";
}

function boundModel(role: string): LlmModelView | null {
  const b = bindings.value[role];
  if (!b) return null;
  return models.value.find((m) => m.id === b.modelId) ?? null;
}

/**
 * 下拉当前值：el-select 用字符串值，未绑定时给 undefined 以显示 placeholder。
 * 绑定指向的模型若已删除（脏绑定），也要回落到 undefined——否则 el-select
 * 会把找不到选项的原始值（一个纯数字 id）直接显示在框里。
 */
function boundValue(role: string): string | undefined {
  const b = bindings.value[role];
  if (!b || b.modelId == null) return undefined;
  return models.value.some((m) => m.id === b.modelId)
    ? String(b.modelId)
    : undefined;
}

/**
 * 角色就绪状态。照「绑定 → 存在 → 启用 → 有 Key」的顺序逐环降级，
 * 任何一环不过都要给出可读原因，而不是笼统显示「未绑定」。
 */
function bindState(role: string): { type: TagType; text: string } {
  const b = bindings.value[role];
  if (!b || b.modelId == null) return { type: "info", text: "未绑定" };
  const m = boundModel(role);
  if (!m) return { type: "danger", text: "绑定已失效" };
  if (!m.enabled) return { type: "danger", text: "模型已停用" };
  if (!m.apiKeyMask) return { type: "warning", text: "未填 API Key" };
  return { type: "success", text: "就绪" };
}

async function onBindChange(role: string, raw: unknown) {
  if (raw === UNBIND) {
    await doUnbind(role);
    return;
  }
  const modelId = Number(raw);
  if (!Number.isInteger(modelId) || modelId <= 0) return;
  bindingRole.value = role;
  try {
    const res = await bindRole(role, modelId);
    ElMessage.success(`${roleText(role)} 已绑定到「${res.modelName}」`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "绑定失败"));
  } finally {
    bindingRole.value = "";
  }
}

async function doUnbind(role: string) {
  bindingRole.value = role;
  try {
    await unbindRole(role);
    ElMessage.success(`${roleText(role)} 已解绑`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "解绑失败"));
  } finally {
    bindingRole.value = "";
  }
}

function capabilityTag(capability: string): TagType {
  const map: Record<string, TagType> = {
    text: "primary",
    image: "warning",
    video: "danger",
    multimodal: "success",
  };
  return map[capability] ?? "info";
}

/** 行操作菜单项，供 RowActions 组件渲染。 */
function modelActions(row: LlmModelView): RowAction[] {
  return [
    {
      command: "test",
      label: "连通测试",
      icon: Connection,
      loading: testingId.value === row.id,
    },
    { command: "edit", label: "编辑", icon: Edit },
    {
      command: "delete",
      label: "删除",
      icon: Delete,
      type: "danger",
      divided: true,
    },
  ];
}

function onModelCommand(cmd: string, row: LlmModelView) {
  if (cmd === "test") runTest(row);
  else if (cmd === "edit") openEdit(row);
  else if (cmd === "delete") remove(row);
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载模型…">
    <header class="wb-page-head">
      <div>
        <h2>模型配置</h2>
        <p class="wb-page-desc">
          共 {{ models.length }} 个模型 · 启用 {{ enabledCount }} 个 · Key
          加密落库只回掩码
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button :icon="Plus" type="primary" @click="openCreate"
          >新增模型</el-button
        >
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="四个维度各管一件事"
    >
      <span class="wb-muted">
        供应商说明「谁提供」，协议说明「怎么调」，能力说明「产出什么」，角色决定「哪个业务环节用它」。
        角色只接受能力匹配的模型，不匹配的下拉项会禁用并注明原因。
      </span>
    </el-alert>

    <el-card shadow="never">
      <template #header>角色绑定</template>

      <el-empty
        v-if="models.length === 0"
        description="还没有模型，先新增一个再来绑定"
        :image-size="64"
      />

      <el-row v-else :gutter="12">
        <el-col
          v-for="role in roles"
          :key="role.role"
          :xs="24"
          :sm="12"
          :md="6"
        >
          <div class="bind-cell">
            <div class="bind-head">
              <label class="bind-label" :for="`bind-${role.role}`">{{
                role.label
              }}</label>
              <el-tag
                :type="bindState(role.role).type"
                size="small"
                effect="light"
              >
                {{ bindState(role.role).text }}
              </el-tag>
            </div>
            <el-select
              :id="`bind-${role.role}`"
              :model-value="boundValue(role.role)"
              :loading="bindingRole === role.role"
              placeholder="未绑定"
              size="default"
              style="width: 100%"
              @update:model-value="(v: unknown) => onBindChange(role.role, v)"
            >
              <el-option :value="UNBIND" label="— 解绑 —" />
              <el-option
                v-for="opt in roleOptions(role)"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
                :disabled="opt.disabled"
              />
            </el-select>
            <span class="wb-muted bind-note">
              {{ role.desc || roleDesc(role.role) || "暂无说明" }}
            </span>
            <span class="wb-muted bind-note">
              需要：{{ role.capabilities.map(capabilityText).join(" / ") }}
            </span>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never">
      <template #header>模型列表</template>

      <!-- 宽度约定：数字/状态列固定 width；文本列用 min-width + show-overflow-tooltip——
           min-width 列会按比例分摊表格剩余宽度（自适应撑满），只有挤不下时才出省略号。
           不显示 ID：模型按名称识别，省一列给更有信息量的调用参数。 -->
      <el-table :data="models" size="default">
        <el-table-column
          prop="name"
          label="名称"
          min-width="80"
          show-overflow-tooltip
        />
        <el-table-column
          label="供应商"
          width="100"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ vendorText(row.vendor) }}</template>
        </el-table-column>
        <el-table-column
          label="协议"
          width="130"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{
            protocolText(row.protocol)
          }}</template>
        </el-table-column>
        <el-table-column label="能力" width="84">
          <template #default="{ row }">
            <el-tag :type="capabilityTag(row.capability)" size="small">
              {{ capabilityText(row.capability) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Base URL" min-width="100" show-overflow-tooltip>
          <template #default="{ row }"
            ><span class="wb-mono">{{ row.baseUrl }}</span></template
          >
        </el-table-column>
        <el-table-column label="模型 ID" min-width="100" show-overflow-tooltip>
          <template #default="{ row }"
            ><span class="wb-mono">{{ row.modelId }}</span></template
          >
        </el-table-column>
        <el-table-column
          label="Key"
          width="150"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span class="wb-mono">{{ row.apiKeyMask || "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="绑定角色" width="200">
          <template #default="{ row }">
            <el-tag
              v-for="r in row.boundRoles ?? []"
              :key="r"
              size="small"
              effect="plain"
              style="margin: 2px 4px 2px 0"
            >
              {{ roleText(r) }}
            </el-tag>
            <span v-if="!(row.boundRoles ?? []).length" class="wb-muted"
              >—</span
            >
          </template>
        </el-table-column>
        <el-table-column label="状态" width="76">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="modelActions(row)"
              @command="(cmd: string) => onModelCommand(cmd, row)"
            />
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有配置模型" :image-size="60">
            <el-button
              type="primary"
              :icon="Plus"
              size="small"
              @click="openCreate"
              >新增模型</el-button
            >
          </el-empty>
        </template>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialog.visible"
      :title="dialog.editingId ? '编辑模型' : '新增模型'"
      width="min(560px, 92vw)"
    >
      <el-form
        ref="formRef"
        :model="dialog.form"
        :rules="rules"
        label-width="110px"
      >
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="dialog.form.name"
            placeholder="例如：主力写作模型"
            maxlength="64"
          />
        </el-form-item>

        <el-form-item label="供应商">
          <el-select
            v-model="dialog.form.vendor"
            style="width: 100%"
            filterable
            allow-create
            default-first-option
            @change="onVendorChange"
          >
            <el-option
              v-for="v in vendors"
              :key="v.id"
              :label="v.label"
              :value="v.id"
            >
              <span>{{ v.label }}</span>
              <span
                v-if="v.note"
                class="wb-muted"
                style="float: right; font-size: 12px"
                >{{ v.note }}</span
              >
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="协议">
          <el-select
            v-model="dialog.form.protocol"
            style="width: 100%"
            @change="onProtocolChange"
          >
            <el-option
              v-for="p in protocols"
              :key="p.value"
              :label="p.implemented ? p.label : `${p.label}（规划中）`"
              :value="p.value"
              :disabled="!p.implemented"
            />
          </el-select>
          <div class="wb-muted form-hint">
            决定请求怎么发，切换后会自动修正能力
          </div>
        </el-form-item>

        <el-form-item label="能力">
          <el-radio-group v-model="dialog.form.capability">
            <el-radio-button
              v-for="c in capabilities"
              :key="c.value"
              :value="c.value"
            >
              {{ c.label }}
            </el-radio-button>
          </el-radio-group>
          <div class="wb-muted form-hint">
            {{ capabilityHint || "决定这个模型能用在哪些角色上" }}
          </div>
        </el-form-item>

        <el-form-item label="Base URL" prop="baseUrl">
          <el-input
            v-model="dialog.form.baseUrl"
            placeholder="https://api.openai.com/v1"
          />
        </el-form-item>

        <el-form-item label="模型 ID" prop="modelId">
          <el-input
            v-model="dialog.form.modelId"
            placeholder="gpt-4o-mini"
            maxlength="128"
          />
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
      </el-form>

      <el-collapse v-model="advOpen" class="adv">
        <el-collapse-item name="adv" title="高级参数（可选）">
          <el-form label-width="110px">
            <template v-if="isImageModel">
              <el-form-item label="生成尺寸">
                <el-select v-model="dialog.form.size" style="width: 100%">
                  <el-option
                    v-for="s in imageSizesList"
                    :key="s"
                    :label="s"
                    :value="s"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="宽高比">
                <el-select v-model="dialog.form.ratio" style="width: 100%">
                  <el-option
                    v-for="r in imageRatiosList"
                    :key="r"
                    :label="r"
                    :value="r"
                  />
                </el-select>
              </el-form-item>
            </template>
            <template v-else>
              <el-form-item label="温度">
                <el-input-number
                  v-model="dialog.form.temperature"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  :precision="1"
                  controls-position="right"
                  placeholder="默认 0.8"
                />
              </el-form-item>
              <el-form-item label="最大 Token">
                <el-input-number
                  v-model="dialog.form.maxTokens"
                  :min="1"
                  :max="32000"
                  :step="100"
                  controls-position="right"
                  placeholder="默认 2400"
                />
              </el-form-item>
            </template>
          </el-form>
        </el-collapse-item>
      </el-collapse>

      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="save"
          >保存</el-button
        >
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

.bind-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-1);
  min-height: 24px;
}

.bind-label {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.bind-note {
  font-size: 12px;
  line-height: 1.4;
}

.form-hint {
  font-size: 12px;
  line-height: 1.4;
  margin-top: var(--wb-space-1);
}

.adv {
  margin-top: 4px;
  border-top: 1px solid var(--wb-border);
}
</style>
