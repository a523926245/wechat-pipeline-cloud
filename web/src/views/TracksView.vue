<script setup lang="ts">
import { Delete, Edit, Files, InfoFilled, MagicStick, Plus, Refresh, Setting } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import {
  createTrack,
  deleteTrack,
  expandTrackAngles,
  listTracks,
  updateTrack,
  updatePipeline,
  getPipelines,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import RowActions, { type RowAction } from '../components/RowActions.vue';
import { pipelineDesc, pipelineTagType, pipelineText } from '../utils/format.ts';
import type { AngleScopeFilter, TrackItem } from '../types.ts';

const router = useRouter();

const items = ref<TrackItem[]>([]);
const loading = ref(false);
const error = ref('');
const busyId = ref<number | null>(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await listTracks();
    items.value = res.items;
    await loadPipelines(res.items);
  } catch (e) {
    error.value = errMsg(e, '赛道列表加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const totalAngles = computed(() => items.value.reduce((s, t) => s + t.angleTotal, 0));
const unusedAngles = computed(() => items.value.reduce((s, t) => s + t.angleUnused, 0));
/** 角度池偏少的阈值：按每天每账号 2 篇粗估，够 10 天算健康。 */
function poolType(t: TrackItem): 'success' | 'warning' | 'danger' {
  const burn = Math.max(1, t.accountCount) * t.quotaPerDay;
  if (burn <= 0) return 'success';
  const days = t.angleUnused / burn;
  if (days <= 3) return 'danger';
  if (days <= 10) return 'warning';
  return 'success';
}

// ── 新增 ──
const createDialog = reactive({ visible: false, saving: false, name: '', slug: '', quotaPerDay: 2 });
const createFormRef = ref<FormInstance>();

function openCreate() {
  createDialog.name = '';
  createDialog.slug = '';
  createDialog.quotaPerDay = 2;
  createDialog.visible = true;
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
    const res = await createTrack({
      name: createDialog.name.trim(),
      slug: createDialog.slug.trim() || undefined,
      quotaPerDay: createDialog.quotaPerDay,
    });
    ElMessage.success(res.message ?? '赛道已创建');
    createDialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '创建失败'));
  } finally {
    createDialog.saving = false;
  }
}

// ── 编辑 ──
const editDialog = reactive({ visible: false, saving: false, id: 0, name: '', quotaPerDay: 2, enabled: true });
const editFormRef = ref<FormInstance>();

function openEdit(row: TrackItem) {
  editDialog.id = row.id;
  editDialog.name = row.name;
  editDialog.quotaPerDay = row.quotaPerDay;
  editDialog.enabled = row.enabled;
  editDialog.visible = true;
  void nextTick(() => editFormRef.value?.clearValidate());
}

async function submitEdit() {
  if (!editFormRef.value) return;
  try {
    await editFormRef.value.validate();
  } catch {
    return;
  }
  editDialog.saving = true;
  try {
    const res = await updateTrack(editDialog.id, {
      name: editDialog.name.trim(),
      quotaPerDay: editDialog.quotaPerDay,
      enabled: editDialog.enabled,
    });
    ElMessage.success(res.message ?? '已保存');
    editDialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    editDialog.saving = false;
  }
}

// ── 删除 ──
async function removeTrack(row: TrackItem) {
  if (row.accountCount > 0) {
    ElMessageBox.alert(
      `赛道「${row.name}」下还有 ${row.accountCount} 个账号。\n` +
        '请先把这些账号删除或改绑到其他赛道，再删除本赛道。',
      '无法删除',
      { type: 'warning', confirmButtonText: '知道了' },
    );
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除赛道「${row.name}」吗？\n\n` +
        `它的 ${row.angleTotal} 条选题会一并清除；已生成的文章会保留但变成「未归属」。`,
      '删除赛道',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      },
    );
  } catch {
    return;
  }
  try {
    const res = await deleteTrack(row.id);
    ElMessage.success(res.message ?? '赛道已删除');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '删除失败'));
  }
}

// ── 扩充选题 ──
const expandDialog = reactive({
  visible: false,
  running: false,
  id: 0,
  name: '',
  count: 20,
  seed: '',
  scope: 'article' as AngleScopeFilter,
});
const expandFormRef = ref<FormInstance>();

const nameRules: FormRules = {
  name: [{ required: true, whitespace: true, message: '赛道名不能为空', trigger: 'blur' }],
};

function openExpand(row: TrackItem) {
  expandDialog.id = row.id;
  expandDialog.name = row.name;
  expandDialog.count = 20;
  expandDialog.seed = '';
  expandDialog.scope = 'article';
  expandDialog.visible = true;
  void nextTick(() => expandFormRef.value?.clearValidate());
}

async function submitExpand() {
  if (expandFormRef.value) {
    try {
      await expandFormRef.value.validate();
    } catch {
      return;
    }
  }
  expandDialog.running = true;
  busyId.value = expandDialog.id;
  try {
    const res = await expandTrackAngles(
      expandDialog.id,
      expandDialog.count,
      expandDialog.seed.trim() || undefined,
      expandDialog.scope,
    );
    if (res.added > 0) {
      ElMessage.success(res.message ?? `新增 ${res.added} 条选题`);
      expandDialog.visible = false;
    } else {
      ElMessage.warning(res.message ?? '没有新增，全部与现有选题重复');
    }
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '扩库失败'));
  } finally {
    expandDialog.running = false;
    busyId.value = null;
  }
}

// ── 产线（赛道 → 产线的层级，展开行就地看与改）──
//
// 为什么从弹窗改成展开行：产线是赛道的子资源，配额/开关/可用选题/扩题都围着它转，
// 塞在弹窗里等于把所有产线信息藏起来一次只露两行——「漫画线为什么没选题」这种问题
// 在主表上根本看不到。展开行同时是概览与操作台，省掉「打开弹窗 → 改 → 保存 → 关掉」的往返。
interface PipelineRow {
  kind: string;
  quotaPerDay: number;
  enabled: boolean;
  seeded: boolean;
  /** 该产线真正吃得到的未用角度数（按 scope 切片统计）。 */
  angleUnused: number;
}

const pipelineMap = ref<Record<number, PipelineRow[]>>({});
/** 打开时的快照：用来标出「有未保存改动」，避免改完忘了保存就刷新丢掉。 */
const pipelineSnapshot = ref<Record<number, string>>({});
const savingPipelineId = ref<number | null>(null);
const expandedKeys = ref<number[]>([]);

/** 随列表一起拉（赛道是十位数以内，成本可忽略）；单条失败只降级该赛道，不整页报错。 */
async function loadPipelines(tracks: TrackItem[]): Promise<void> {
  const entries = await Promise.all(
    tracks.map(async (t) => {
      try {
        const res = await getPipelines(t.id);
        const rows: PipelineRow[] = (res.items ?? []).map((p) => ({
          kind: p.kind,
          quotaPerDay: p.quotaPerDay,
          enabled: p.enabled,
          seeded: p.seeded,
          angleUnused: p.angleUnused,
        }));
        return [t.id, rows] as const;
      } catch {
        return [t.id, [] as PipelineRow[]] as const;
      }
    }),
  );
  const map: Record<number, PipelineRow[]> = {};
  const snap: Record<number, string> = {};
  for (const [id, rows] of entries) {
    map[id] = rows;
    snap[id] = JSON.stringify(rows);
  }
  pipelineMap.value = map;
  pipelineSnapshot.value = snap;
}

function isPipelineDirty(id: number): boolean {
  const rows = pipelineMap.value[id];
  if (!rows) return false;
  return JSON.stringify(rows) !== pipelineSnapshot.value[id];
}

async function savePipelines(row: TrackItem) {
  const rows = pipelineMap.value[row.id] ?? [];
  if (rows.length === 0 || savingPipelineId.value !== null) return;
  savingPipelineId.value = row.id;
  try {
    for (const r of rows) {
      await updatePipeline(row.id, r.kind, { quotaPerDay: r.quotaPerDay, enabled: r.enabled });
    }
    ElMessage.success('产线配额已保存');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '产线配额保存失败'));
  } finally {
    savingPipelineId.value = null;
  }
}

function togglePipelines(row: TrackItem) {
  expandedKeys.value = expandedKeys.value.includes(row.id)
    ? expandedKeys.value.filter((x) => x !== row.id)
    : [...expandedKeys.value, row.id];
}

/** 点箭头与点菜单走同一份受控状态，两边不会打架。 */
function onExpandChange(_row: TrackItem, expanded: TrackItem[]) {
  expandedKeys.value = expanded.map((r) => r.id);
}

/** 下钻到该赛道的选题库，查看/编辑/删除具体选题。 */
function goAngles(row: TrackItem) {
  void router.push(`/tracks/${row.id}/angles`);
}

/**
 * 跳到选题库并按该产线的专用切片预筛。
 * 提示：产线还会吃 shared 切片，这里只预筛专用部分，要看全部就切「用途 = 全部」。
 */
function goAnglesFor(trackId: number, kind: string) {
  void router.push({
    path: `/tracks/${trackId}/angles`,
    query: { scope: kind === 'comic' ? 'comic' : 'article' },
  });
}

/** 给某条产线扩题：预置用途，条数仍需人确认（一键直达但不误烧 Token）。 */
function openExpandFor(trackId: number, trackName: string, kind: string) {
  expandDialog.id = trackId;
  expandDialog.name = `${trackName} · ${pipelineText(kind)}产线`;
  expandDialog.count = 20;
  expandDialog.seed = '';
  expandDialog.scope = kind === 'comic' ? 'comic' : 'article';
  expandDialog.visible = true;
}

/** 行操作菜单项，供 RowActions 组件渲染。 */
function trackActions(row: TrackItem): RowAction[] {
  return [
    { command: 'angles', label: '选题库', icon: Files },
    {
      command: 'expand',
      label: '扩充选题',
      icon: MagicStick,
      loading: busyId.value === row.id,
    },
    {
      command: 'pipelines',
      label: expandedKeys.value.includes(row.id) ? '收起产线' : '展开产线',
      icon: Setting,
    },
    { command: 'edit', label: '编辑', icon: Edit },
    { command: 'delete', label: '删除', icon: Delete, type: 'danger', divided: true },
  ];
}

function onTrackCommand(cmd: string, row: TrackItem) {
  if (cmd === 'angles') goAngles(row);
  else if (cmd === 'expand') openExpand(row);
  else if (cmd === 'edit') openEdit(row);
  else if (cmd === 'pipelines') togglePipelines(row);
  else if (cmd === 'delete') removeTrack(row);
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载赛道…">
    <header class="wb-page-head">
      <div>
        <h2>赛道管理</h2>
        <p class="wb-page-desc">
          共 {{ items.length }} 个赛道 · 选题 {{ unusedAngles }}/{{ totalAngles }} 条可用 ·
          点左侧箭头展开「产线」（配额 / 开关 / 可用选题 / 扩题）
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增赛道</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="赛道决定账号用哪个选题池：同赛道多账号共享一套选题。新建的赛道角度池是空的，需先「扩充选题」才能开始创作。"
    />

    <el-card shadow="never">
      <!-- 宽度约定：数字/状态列固定 width；文本列用 min-width + show-overflow-tooltip——
           min-width 列会按比例分摊表格剩余宽度（自适应撑满），只有挤不下时才出省略号 -->
      <el-table
        :data="items"
        size="default"
        row-key="id"
        :expand-row-keys="expandedKeys"
        @expand-change="onExpandChange"
      >
        <!-- 层级：赛道 → 产线。展开区就是产线操作台（配额/开关/可用选题/扩题） -->
        <el-table-column type="expand" width="42">
          <template #default="{ row }">
            <div class="pipeline-panel">
              <div class="pipeline-head">
                <span class="wb-muted">
                  产线：配额与开关各自独立，可用选题按切片统计（不是赛道总数）
                </span>
                <div class="pipeline-head-actions">
                  <el-tag v-if="isPipelineDirty(row.id)" type="warning" size="small">
                    有未保存改动
                  </el-tag>
                  <el-button
                    size="small"
                    type="primary"
                    :loading="savingPipelineId === row.id"
                    :disabled="!isPipelineDirty(row.id)"
                    @click="savePipelines(row)"
                  >
                    保存产线
                  </el-button>
                </div>
              </div>

              <el-table
                v-if="(pipelineMap[row.id] ?? []).length"
                :data="pipelineMap[row.id]"
                size="small"
                class="pipeline-table"
              >
                <el-table-column label="产线" width="110">
                  <template #default="{ row: p }">
                    <el-tag :type="pipelineTagType(p.kind)" size="small">
                      {{ pipelineText(p.kind) }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="配额/天" width="150">
                  <template #default="{ row: p }">
                    <el-input-number v-model="p.quotaPerDay" :min="0" :max="20" size="small" />
                  </template>
                </el-table-column>
                <el-table-column label="启用" width="86">
                  <template #default="{ row: p }">
                    <el-switch v-model="p.enabled" size="small" />
                  </template>
                </el-table-column>
                <el-table-column label="可用选题" width="100">
                  <template #default="{ row: p }">
                    <el-tag :type="p.angleUnused > 0 ? 'info' : 'danger'" size="small">
                      {{ p.angleUnused }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="说明" min-width="200">
                  <template #default="{ row: p }">
                    <span class="wb-muted">{{ pipelineDesc(p.kind) || '—' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="180">
                  <template #default="{ row: p }">
                    <div class="pipeline-ops">
                      <el-button
                        link
                        type="primary"
                        size="small"
                        :icon="MagicStick"
                        @click="openExpandFor(row.id, row.name, p.kind)"
                      >
                        扩题
                      </el-button>
                      <el-button
                        link
                        type="primary"
                        size="small"
                        :icon="Files"
                        @click="goAnglesFor(row.id, p.kind)"
                      >
                        选题库
                      </el-button>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-else description="该赛道暂无产线配置" :image-size="48" />

              <!-- 开了产线却没有它能吃的选题，是「排产报角度不足」的第一原因，就地给出路 -->
              <el-alert
                v-for="p in (pipelineMap[row.id] ?? []).filter(
                  (x) => x.enabled && x.angleUnused === 0,
                )"
                :key="`no-angle-${row.id}-${p.kind}`"
                type="warning"
                show-icon
                :closable="false"
                class="pipeline-alert"
                :title="`「${pipelineText(p.kind)}」产线没有可用选题`"
              >
                <span class="wb-secondary">
                  现有选题都在别的切片上（{{ pipelineText(p.kind) }}产线只吃
                  {{ p.kind === 'comic' ? '「漫画专用 / 共享」' : '「文章专用 / 共享」' }}）。
                </span>
                <el-button link type="primary" @click="goAnglesFor(row.id, p.kind)">
                  去补{{ pipelineText(p.kind) }}选题
                </el-button>
              </el-alert>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column prop="name" label="赛道" min-width="180" show-overflow-tooltip />
        <el-table-column
          prop="slug"
          label="标识"
          min-width="150"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span class="wb-mono">{{ row.slug }}</span>
          </template>
        </el-table-column>
        <el-table-column label="每日配额" width="100" class-name="col-optional">
          <template #header>
            <!-- deprecated 提示：真源已迁到产线配额，这里是文章产线的镜像 -->
            <el-tooltip placement="top">
              <template #content>
                已迁到「产线配额」：本列是文章产线的镜像值，<br />
                在任一侧修改都会同步，推荐只改「产线配额」。
              </template>
              <span class="th-hint">
                每日配额
                <el-icon><InfoFilled /></el-icon>
              </span>
            </el-tooltip>
          </template>
          <template #default="{ row }">{{ row.quotaPerDay }} 篇</template>
        </el-table-column>
        <el-table-column label="启用" width="72">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="账号" width="72">
          <template #default="{ row }">{{ row.accountCount }}</template>
        </el-table-column>
        <el-table-column label="文章" width="72" class-name="col-optional">
          <template #default="{ row }">{{ row.articleCount }}</template>
        </el-table-column>
        <el-table-column label="选题池" width="130">
          <template #default="{ row }">
            <el-tag
              :type="poolType(row)"
              size="small"
              class="pool-tag"
              role="link"
              tabindex="0"
              :title="`查看「${row.name}」的选题库`"
              @click="goAngles(row)"
              @keydown.enter="goAngles(row)"
            >
              {{ row.angleUnused }} / {{ row.angleTotal }}
            </el-tag>
          </template>
        </el-table-column>
        <!-- 产线概览：一眼看出哪条线有米下锅（数字 = 该产线真正吃得下的未用选题） -->
        <el-table-column label="产线（可用选题）" min-width="200">
          <template #default="{ row }">
            <div v-if="(pipelineMap[row.id] ?? []).length" class="pipeline-tags">
              <el-tag
                v-for="p in pipelineMap[row.id]"
                :key="p.kind"
                size="small"
                :type="p.angleUnused > 0 ? 'info' : 'danger'"
                :title="`${pipelineText(p.kind)}产线 · 配额 ${p.quotaPerDay}/天 · ${p.enabled ? '已启用' : '已停用'}`"
              >
                {{ pipelineText(p.kind) }} {{ p.angleUnused }}
              </el-tag>
            </div>
            <span v-else class="wb-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="trackActions(row)"
              @command="(cmd: string) => onTrackCommand(cmd, row)"
            />
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有赛道，新增一个开始创作">
            <el-button type="primary" :icon="Plus" size="small" @click="openCreate">新增赛道</el-button>
          </el-empty>
        </template>
      </el-table>
    </el-card>

    <!-- 新增赛道 -->
    <el-dialog v-model="createDialog.visible" title="新增赛道" width="min(520px, 92vw)">
      <el-form ref="createFormRef" :model="createDialog" :rules="nameRules" label-width="96px">
        <el-form-item label="赛道名称" prop="name">
          <el-input v-model="createDialog.name" placeholder="例如：育儿、职场、星座" maxlength="32" />
        </el-form-item>
        <el-form-item label="标识 slug">
          <el-input v-model="createDialog.slug" placeholder="留空则按名称自动生成" maxlength="64" />
        </el-form-item>
        <el-form-item label="每日配额">
          <el-input-number v-model="createDialog.quotaPerDay" :min="0" :max="20" />
          <span class="wb-muted hint">每个账号每天出几篇</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="createDialog.saving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑赛道 -->
    <el-dialog v-model="editDialog.visible" title="编辑赛道" width="min(520px, 92vw)">
      <el-form ref="editFormRef" :model="editDialog" :rules="nameRules" label-width="96px">
        <el-form-item label="赛道名称" prop="name">
          <el-input v-model="editDialog.name" maxlength="32" />
        </el-form-item>
        <el-form-item label="每日配额">
          <el-input-number v-model="editDialog.quotaPerDay" :min="0" :max="20" />
          <span class="wb-muted hint">每个账号每天出几篇</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="editDialog.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="editDialog.saving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 扩充选题 -->
    <el-dialog v-model="expandDialog.visible" :title="`扩充选题 · ${expandDialog.name}`" width="min(520px, 92vw)">
      <el-form ref="expandFormRef" :model="expandDialog" label-width="96px">
        <el-form-item label="用途">
          <el-radio-group v-model="expandDialog.scope">
            <el-radio value="article">文章</el-radio>
            <el-radio value="comic">漫画</el-radio>
            <el-radio value="shared">共享</el-radio>
          </el-radio-group>
          <div class="wb-muted hint">
            决定这批选题归哪条产线：漫画产线只吃「漫画 / 共享」，选文章它一粒都吃不到。
          </div>
        </el-form-item>
        <el-form-item label="生成条数">
          <el-input-number v-model="expandDialog.count" :min="1" :max="100" />
        </el-form-item>
        <el-form-item label="侧重方向">
          <el-input
            v-model="expandDialog.seed"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="可选。例如：聚焦「婆媳同住」这类具体场景，避开泛泛而谈的鸡汤"
          />
        </el-form-item>
      </el-form>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="会用「模型配置」里绑定到「扩角度(expand_angles)」角色的模型来生成。生成结果与现有选题做归一化去重，重复的不入库。漫画用途会按「能一眼画出来的场景」来写提示词。"
      />

      <template #footer>
        <el-button @click="expandDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="expandDialog.running" @click="submitExpand">
          开始生成
        </el-button>
      </template>
    </el-dialog>

  </div>
</template>

<style scoped>
/* 表头的 deprecated 提示图标：比正文弱一点，不抢视线。 */
.th-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.th-hint .el-icon {
  color: var(--wb-text-muted);
}

/* 展开区 = 产线层：底色与主表区分开，表示这是下一层 */
.pipeline-panel {
  padding: var(--wb-space-3) var(--wb-space-4);
  background: var(--wb-surface-muted);
  border-radius: var(--wb-radius-sm);
}

.pipeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--wb-space-2);
  font-size: 12px;
}

.pipeline-head-actions {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
}

.pipeline-table {
  width: 100%;
}

.pipeline-ops {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
}

.pipeline-alert {
  margin-top: var(--wb-space-3);
}

.pipeline-tags {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
}

/* 选题池是可下钻的入口，给明显的可点击暗示。 */
.pool-tag {
  cursor: pointer;
}

.pool-tag:focus-visible {
  outline: 2px solid var(--wb-primary);
  outline-offset: 2px;
}

.hint {
  margin-left: var(--wb-space-2);
  font-size: 12px;
}
</style>
