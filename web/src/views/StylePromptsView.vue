<script setup lang="ts">
/**
 * 文风配置：创作总纲 + 各赛道文体 + 三维变体库（标题/结构/篇幅）。
 *
 * 这里是文风与题库口径的**单一真源**（落库 StylePrompt 表）：
 * - 写稿（writer.ts）：注入总纲/赛道文体，并按游标轮换三维变体（反模板化）
 * - 题库扩库（angles.ts）：注入创作总纲（选题也必须正能量）
 *
 * 变体行格式（篇幅）：`{min}-{max}|{pMin}-{pMax}|说明`，一行一档；
 * 标题/结构变体一行一条公式/骨架。轮换顺序 = 行序（每篇取下一行，循环）。
 *
 * 布局取向（2026-11-11 重做）：配置项数量随赛道增长，原来所有 textarea 竖排铺开，
 * 5 个赛道就是 20 多个大文本框，找一项要滚很久，而且改完不知道存没存。所以改成
 * 「左侧固定导航 + 右侧单面板」：
 *   - 页面一次只显示一个配置项，赛道内部再分 Tab，基本不用滚；
 *   - 每个配置项独立 dirty 检测与保存，顶部汇总「N 处未保存」+ 全部保存；
 *   - 切页/关页有拦截，避免改了一屏全丢。
 *
 * key 约定：'global' | '{赛道名}' | 'v:{赛道}:{dim}'（dim ∈ title|structure|length）。
 */
import {
  Check,
  Delete,
  Plus,
  Refresh,
  RefreshLeft,
  Search,
  WarningFilled,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';

import { errMsg } from '../api/http.ts';
import {
  deleteStylePrompt,
  getStylePromptCursors,
  getStylePromptDefaults,
  listStylePrompts,
  listTracks,
  upsertStylePrompt,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import VariantLinesEditor from '../components/VariantLinesEditor.vue';
import { splitVariantBlocks } from '../utils/variants.ts';
import type { StylePromptDefaults, StylePromptItem, TrackItem } from '../types.ts';

const K_GLOBAL = 'global';

const DIMS = [
  { dim: 'title', label: '标题变体', short: '标题', hint: '一条一个标题公式，按顺序轮换' },
  { dim: 'structure', label: '结构变体', short: '结构', hint: '一条一张骨架卡（5-8 行），按顺序轮换' },
  { dim: 'length', label: '篇幅变体', short: '篇幅', hint: '一行一档：字数区间|段数锚|说明' },
] as const;
type Dim = (typeof DIMS)[number]['dim'];

const vkey = (track: string, dim: string) => `v:${track}:${dim}`;
/** 写作规范（段落形态 / 强调标注 / 句式补充）——按赛道一份。 */
const skey = (track: string) => `s:${track}`;
/** 系统提示词（`## system` + `## tail`）——按赛道一份，这是决定「文章长什么样」的那份。 */
const syskey = (track: string) => `sys:${track}`;

/** 模板里可用的变量。必须与后端 style-prompts.ts 的 TEMPLATE_VARS 一致。 */
const TEMPLATE_VARS = [
  { name: 'minSections', desc: '最少小标题数' },
  { name: 'maxSections', desc: '最多小标题数' },
  { name: 'targetMin', desc: '目标字数下限' },
  { name: 'targetMax', desc: '目标字数上限' },
  { name: 'minChars', desc: '门禁字数下限' },
  { name: 'maxChars', desc: '门禁字数上限' },
  { name: 'pMin', desc: '段落数下限' },
  { name: 'pMax', desc: '段落数上限' },
] as const;

/** 变量在界面上的字面写法。放在脚本里返回，避免模板里写 `{{` 被当成插值。 */
const varLabel = (name: string) => `{{${name}}}`;

// ── 状态 ────────────────────────────────────────────────────────────────────
const loading = ref(false);
const loadError = ref('');
const items = ref<StylePromptItem[]>([]);
const defaults = ref<StylePromptDefaults | null>(null);
const tracks = ref<TrackItem[]>([]);
const cursors = ref<Record<string, number>>({});

/** 编辑缓冲区（可随便改） */
const buf = reactive<Record<string, string>>({});
/** 服务端快照（用来判断 dirty / 还原） */
const saved = reactive<Record<string, string>>({});

const saving = ref('');
const savingAll = ref(false);
const current = ref('global');
const kw = ref('');
const gvTab = ref<Dim>('title');
const trackTab = ref<string>('prompt');

// ── 派生 ────────────────────────────────────────────────────────────────────
/**
 * 机器配置 key（`s:{赛道}` 写作规范 / `r:{赛道}` 规则 / `v:{赛道}:{维度}` 变体）。
 *
 * 这些不是赛道，不该出现在「赛道」导航里——它们分别对应赛道页签内的
 * 「写作规范」与三个变体 Tab。加这层前缀过滤是为了**不依赖后端 kind 字段**：
 * 服务端没重启（还是旧的 kindOf）时，`s:` / `r:` 会被报成 track，
 * 侧栏就会冒出「r:星座」这种条目，点进去还把 JSON 当赛道文体编辑。
 */
const isMachineKey = (k: string) =>
  k.startsWith('s:') || k.startsWith('r:') || k.startsWith('v:') || k.startsWith('sys:');

const trackNames = computed(() =>
  items.value
    .filter((i) => i.kind === 'track' && !isMachineKey(i.key))
    .map((i) => i.key),
);

const currentTrack = computed(() =>
  current.value.startsWith('track:') ? current.value.slice('track:'.length) : '',
);

/** 当前右侧面板正在编辑的 key（总纲 / 全局变体某一维 / 赛道文体或某一维）。 */
const currentEditorKey = computed(() => {
  if (current.value === 'global') return K_GLOBAL;
  if (current.value === 'gv') return vkey(K_GLOBAL, gvTab.value);
  const n = currentTrack.value;
  if (!n) return '';
  if (trackTab.value === 'prompt') return n;
  if (trackTab.value === 'sys') return syskey(n);
  if (trackTab.value === 'spec') return skey(n);
  return vkey(n, trackTab.value);
});

const isDirty = (key: string) => (buf[key] ?? '') !== (saved[key] ?? '');

const dirtyKeys = computed(() => Object.keys(buf).filter((k) => (buf[k] ?? '') !== (saved[k] ?? '')));

const trackDirty = (name: string) =>
  isDirty(name) || isDirty(syskey(name)) || DIMS.some((d) => isDirty(vkey(name, d.dim)));

const trackMap = computed(() => {
  const m: Record<string, TrackItem> = {};
  for (const t of tracks.value) m[t.name] = t;
  return m;
});

/** 还没单独配文风的赛道（文风层不配也能跑，会回落全局/兜底文案）。 */
const unconfigured = computed(() => tracks.value.filter((t) => !trackNames.value.includes(t.name)));

const savedAt = computed(() => {
  const m: Record<string, string> = {};
  for (const it of items.value) m[it.key] = it.updatedAt;
  return m;
});

const q = computed(() => kw.value.trim().toLowerCase());
const shownGlobal = computed(() =>
  [{ id: 'global', label: '创作总纲' }].filter((n) => !q.value || n.label.toLowerCase().includes(q.value)),
);
const shownTracks = computed(() =>
  trackNames.value
    .map((n) => ({ id: `track:${n}`, label: n }))
    .filter((n) => !q.value || n.label.toLowerCase().includes(q.value)),
);

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');

const lineCount = (s?: string) => (s ?? '').split('\n').filter((x) => x.trim() !== '').length;
/** 变体条数 = 轮换周期。必须按**条目**算（一条可以是一整张骨架卡），按行算会把 5 张卡报成 34 条。 */
const blockCount = (s?: string) => splitVariantBlocks(s).length;

const charCount = (s?: string) => (s ?? '').replace(/\s/g, '').length;

/** 变体生效来源：赛道自己的库 → 全局库 → 代码内兜底值。 */
function variantInfo(track: string, dim: Dim): { source: 'track' | 'global' | 'code'; lines: number } {
  const own = blockCount(buf[vkey(track, dim)]);
  if (own > 0) return { source: 'track', lines: own };
  const g = blockCount(buf[vkey(K_GLOBAL, dim)]);
  if (g > 0) return { source: 'global', lines: g };
  return { source: 'code', lines: 0 };
}

/**
 * 下一篇会取第几条。写稿侧是先 +1 再取模（nextVariantCursor），所以按同样口径推。
 * 只对赛道游标有效——游标按赛道名记录，全局库没有独立游标。
 */
function nextPick(track: string, lines: number): number | null {
  if (lines <= 0) return null;
  return (((cursors.value[track] ?? 0) + 1) % lines) + 1;
}

function alignOf(name: string): 'ok' | 'disabled' | 'missing' {
  const t = trackMap.value[name];
  if (!t) return 'missing';
  return t.enabled ? 'ok' : 'disabled';
}

function labelOf(key: string): string {
  if (key === K_GLOBAL) return '创作总纲';
  if (key.startsWith('sys:')) return `${key.slice(4)}·系统提示词`;
  if (key.startsWith('v:')) {
    const parts = key.split(':');
    const dim = parts[parts.length - 1];
    const d = DIMS.find((x) => x.dim === dim);
    return `${parts[1] ?? ''}·${d?.short ?? dim}`;
  }
  return key;
}

// ── 加载 ────────────────────────────────────────────────────────────────────
function ensureKey(key: string) {
  if (!(key in buf)) buf[key] = '';
  if (!(key in saved)) saved[key] = '';
}

/** 当前面板用到哪些 key —— 切面板时补齐，dirty 比较才有稳定的基准。 */
function ensurePanelKeys(id: string) {
  if (id === 'global') ensureKey(K_GLOBAL);
  else if (id === 'gv') for (const d of DIMS) ensureKey(vkey(K_GLOBAL, d.dim));
  else if (id.startsWith('track:')) {
    const n = id.slice('track:'.length);
    ensureKey(n);
    ensureKey(syskey(n));
    for (const d of DIMS) ensureKey(vkey(n, d.dim));
  }
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [list, defs] = await Promise.all([listStylePrompts(), getStylePromptDefaults()]);
    for (const k of Object.keys(buf)) delete buf[k];
    for (const k of Object.keys(saved)) delete saved[k];
    items.value = list.items;
    defaults.value = defs;
    for (const it of list.items) {
      buf[it.key] = it.prompt;
      saved[it.key] = it.prompt;
    }
    // 选中的赛道可能已被别处删掉，先回退再补键
    if (current.value.startsWith('track:') && !trackNames.value.includes(currentTrack.value)) {
      current.value = 'global';
    }
    ensurePanelKeys(current.value);
    // 侧栏辅助信息：真实赛道与轮换游标。失败只少几条提示，不挡编辑。
    const [tk, cur] = await Promise.all([
      listTracks().catch(() => ({ total: 0, items: [] as TrackItem[] })),
      getStylePromptCursors().catch(() => ({ cursors: {} as Record<string, number> })),
    ]);
    tracks.value = tk.items;
    cursors.value = cur.cursors;
  } catch (e) {
    loadError.value = errMsg(e, '文风配置加载失败');
  } finally {
    loading.value = false;
  }
}

/** 手动刷新：先把未保存的改动问清楚，别让一次点错白改。 */
async function refresh() {
  if (dirtyKeys.value.length > 0) {
    try {
      await ElMessageBox.confirm(
        `有 ${dirtyKeys.value.length} 处改动还没保存，刷新会用库里的值覆盖当前编辑内容。`,
        '刷新会丢弃改动',
        { type: 'warning', confirmButtonText: '仍然刷新', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  await load();
}

// ── 保存 / 还原 ─────────────────────────────────────────────────────────────
/** 变体库存的是「一行一条」，写库前统一去空白行，和后端读取口径一致。 */
function normalize(key: string, value: string): string {
  if (!key.startsWith('v:')) return value;
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

function applySaved(item: StylePromptItem) {
  buf[item.key] = item.prompt;
  saved[item.key] = item.prompt;
  const i = items.value.findIndex((x) => x.key === item.key);
  if (i >= 0) items.value[i] = item;
  else items.value.push(item);
}

async function saveKey(key: string): Promise<void> {
  saving.value = key;
  try {
    const item = await upsertStylePrompt(key, normalize(key, buf[key] ?? ''));
    applySaved(item);
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    saving.value = '';
  }
}

async function saveAll() {
  const keys = dirtyKeys.value.slice();
  if (keys.length === 0) return;
  savingAll.value = true;
  const fails: string[] = [];
  for (const k of keys) {
    try {
      applySaved(await upsertStylePrompt(k, normalize(k, buf[k] ?? '')));
    } catch (e) {
      fails.push(`${labelOf(k)}（${errMsg(e, '保存失败')}）`);
    }
  }
  savingAll.value = false;
  if (fails.length === 0) ElMessage.success(`已保存 ${keys.length} 项`);
  else ElMessage.error(`${keys.length - fails.length} 项已保存，${fails.length} 项失败：${fails.join('；')}`);
}

/** 只作用于当前选中面板的那个 key（Ctrl+S 与面板底部保存共用）。 */
async function saveCurrent(): Promise<void> {
  const key = currentEditorKey.value;
  if (!key) return;
  return saveKey(key);
}

function onNavSelect(index: string) {
  current.value = index;
  // 切过去的可能是一个从不存在的 key（赛道没配变体库），先补齐缓冲区
  ensurePanelKeys(index);
}

function pickCreate(name: string) {
  createForm.name = name;
  createVisible.value = true;
}

function discardAll() {
  for (const k of Object.keys(buf)) buf[k] = saved[k] ?? '';
}

async function restoreKey(key: string) {
  const d = defaults.value;
  if (!d) return;
  const v =
    d.variants[key] ??
    d.systems[key] ??
    d.specs[key] ??
    d.rules[key] ??
    d.tracks[key] ??
    (key === K_GLOBAL ? d.global : undefined);
  if (v === undefined) {
    ElMessage.warning('这一项没有出厂默认值（自定义赛道需要自己写文体）');
    return;
  }
  try {
    await ElMessageBox.confirm('用出厂默认值替换当前编辑内容？替换后仍需点「保存」才写库。', '恢复默认', {
      type: 'warning',
      confirmButtonText: '替换',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  buf[key] = v;
  ElMessage.success('已填入出厂默认值，记得保存');
}

// ── 赛道维护 ────────────────────────────────────────────────────────────────
const createVisible = ref(false);
const createFormRef = ref<FormInstance>();
const createForm = reactive({ name: '' });

const createRules: FormRules = {
  name: [
    {
      validator: (_rule, value: string, cb) => {
        const name = (value ?? '').trim();
        if (!name) return cb(new Error('请选择或输入赛道名'));
        if (name === K_GLOBAL || name.startsWith('v:')) return cb(new Error('不能用 global 或 v: 开头的名字'));
        if (trackNames.value.includes(name)) return cb(new Error('该赛道已有文风配置'));
        cb();
      },
      trigger: 'change',
    },
  ],
};

function openCreate() {
  createForm.name = '';
  createVisible.value = true;
}

async function submitCreate() {
  const f = createFormRef.value;
  if (!f) return;
  const ok = await f.validate().then(() => true).catch(() => false);
  if (!ok) return;
  const name = createForm.name.trim();
  saving.value = `new:${name}`;
  try {
    // 有出厂文体就带出来，没有就建空行等填写；变体库不建（空即回落全局）
    const item = await upsertStylePrompt(name, defaults.value?.tracks[name] ?? '');
    applySaved(item);
    for (const d of DIMS) ensureKey(vkey(name, d.dim));
    createVisible.value = false;
    current.value = `track:${name}`;
    trackTab.value = 'prompt';
    ElMessage.success(item.prompt ? '已创建，并填入出厂文体' : '已创建，赛道文体待填写');
  } catch (e) {
    ElMessage.error(errMsg(e, '创建失败'));
  } finally {
    saving.value = '';
  }
}

async function removeTrack(name: string) {
  try {
    await ElMessageBox.confirm(
      `删除「${name}」的赛道文体与三条变体库？写稿时会回落到全局配置（不影响赛道管理里的赛道本身）。`,
      '删除赛道文风配置',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  saving.value = `del:${name}`;
  const keys = [name, skey(name), ...DIMS.map((d) => vkey(name, d.dim))];
  try {
    for (const k of keys) await deleteStylePrompt(k).catch(() => undefined);
    for (const k of keys) {
      delete buf[k];
      delete saved[k];
    }
    items.value = items.value.filter((i) => !keys.includes(i.key));
    if (current.value === `track:${name}`) current.value = 'global';
    ElMessage.success('已删除，写稿将回落全局配置');
  } catch (e) {
    ElMessage.error(errMsg(e, '删除失败'));
  } finally {
    saving.value = '';
  }
}

// ── 交互守护 ────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveCurrent();
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirtyKeys.value.length === 0) return;
  e.preventDefault();
  e.returnValue = '';
}

onBeforeRouteLeave(async () => {
  if (dirtyKeys.value.length === 0) return true;
  try {
    await ElMessageBox.confirm(
      `有 ${dirtyKeys.value.length} 处改动还没保存（${dirtyKeys.value.slice(0, 3).map(labelOf).join('、')}${
        dirtyKeys.value.length > 3 ? ' 等' : ''
      }），离开后会丢失。`,
      '有未保存的改动',
      { type: 'warning', confirmButtonText: '仍然离开', cancelButtonText: '留下保存' },
    );
    return true;
  } catch {
    return false;
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <div class="wb-page">
    <header class="wb-page-head">
      <div>
        <h2>文风配置</h2>
        <p class="wb-page-desc">
          创作总纲、赛道文体与三维变体（标题/结构/篇幅）的单一真源。左侧选配置项，改完在底部保存，写稿与题库扩库都读这里。
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :icon="Check" :loading="savingAll" :disabled="dirtyKeys.length === 0" @click="saveAll">
          全部保存<span v-if="dirtyKeys.length" class="btn-badge">{{ dirtyKeys.length }}</span>
        </el-button>
      </div>
    </header>

    <StateError v-if="loadError" :message="loadError" label="文风配置加载失败" @retry="load" />

    <!-- 未保存汇总：改动散落在不同面板时，这里能一次收掉 -->
    <div v-if="dirtyKeys.length" class="dirty-bar" role="status">
      <el-icon class="dirty-bar__icon"><WarningFilled /></el-icon>
      <span class="dirty-bar__text">
        <b>{{ dirtyKeys.length }} 处改动未保存</b>
        <span class="wb-muted">{{ dirtyKeys.slice(0, 4).map(labelOf).join('、') }}{{ dirtyKeys.length > 4 ? ' 等' : '' }}</span>
      </span>
      <el-button size="small" text @click="discardAll">放弃改动</el-button>
      <el-button size="small" type="primary" :loading="savingAll" @click="saveAll">全部保存</el-button>
    </div>

    <div class="sp-layout">
      <!-- 左：配置项导航 -->
      <aside class="sp-nav">
        <el-input
          v-model="kw"
          size="small"
          clearable
          :prefix-icon="Search"
          placeholder="筛选配置项"
          aria-label="筛选配置项"
        />

        <el-menu :default-active="current" class="sp-menu" @select="onNavSelect">
          <el-menu-item-group title="全局">
            <el-menu-item v-for="n in shownGlobal" :key="n.id" :index="n.id">
              <span class="nav-label">{{ n.label }}</span>
              <i v-if="n.id === 'global' && isDirty(K_GLOBAL)" class="dirty-dot" title="有未保存改动" />
              <i
                v-else-if="n.id === 'gv' && DIMS.some((d) => isDirty(vkey(K_GLOBAL, d.dim)))"
                class="dirty-dot"
                title="有未保存改动"
              />
            </el-menu-item>
          </el-menu-item-group>

          <el-menu-item-group>
            <template #title>
              <span class="group-title">
                赛道
                <el-button link size="small" :icon="Plus" class="group-add" @click="openCreate">新增</el-button>
              </span>
            </template>
            <el-menu-item v-for="n in shownTracks" :key="n.id" :index="n.id">
              <span class="nav-label" :title="n.label">{{ n.label }}</span>
              <span v-if="alignOf(n.label) === 'missing'" class="nav-flag" title="赛道管理里没有同名赛道">!</span>
              <span v-else-if="alignOf(n.label) === 'disabled'" class="nav-flag is-muted" title="赛道已停用">停</span>
              <i v-if="trackDirty(n.label)" class="dirty-dot" title="有未保存改动" />
            </el-menu-item>
            <div v-if="shownTracks.length === 0" class="nav-empty wb-muted">
              {{ q ? '没有匹配的赛道' : '还没有赛道配置' }}
            </div>
          </el-menu-item-group>
        </el-menu>

        <div v-if="unconfigured.length" class="nav-note">
          <span class="wb-muted">{{ unconfigured.length }} 个赛道未单独配置，会用全局兜底：</span>
          <span class="nav-note__tags">
            <el-tag
              v-for="t in unconfigured.slice(0, 6)"
              :key="t.id"
              size="small"
              type="info"
              effect="plain"
              class="clickable"
              @click="pickCreate(t.name)"
            >
              {{ t.name }}
            </el-tag>
          </span>
        </div>
      </aside>

      <!-- 右：单面板编辑区 -->
      <section class="sp-main" v-loading="loading" element-loading-text="正在加载文风配置…">
        <!-- 创作总纲 -->
        <el-card v-if="current === 'global' && !loadError" shadow="never" class="sp-panel">
          <template #header>
            <div class="panel-head">
              <div class="panel-title">
                <strong>创作总纲</strong>
                <span class="wb-muted">写稿与题库扩库共用，正能量底线就写在这里</span>
              </div>
              <div class="panel-ops">
                <el-button size="small" :icon="RefreshLeft" @click="restoreKey(K_GLOBAL)">恢复默认</el-button>
                <el-button
                  size="small"
                  type="primary"
                  :loading="saving === K_GLOBAL"
                  :disabled="!isDirty(K_GLOBAL)"
                  @click="saveKey(K_GLOBAL)"
                >
                  保存
                </el-button>
              </div>
            </div>
          </template>

          <el-input
            v-model="buf[K_GLOBAL]"
            type="textarea"
            :autosize="{ minRows: 14, maxRows: 30 }"
            placeholder="正能量三原则、素材查证、逻辑自洽等全局约束"
          />
          <div class="editor-meta">
            <span class="wb-muted">{{ charCount(buf[K_GLOBAL]) }} 字 · {{ lineCount(buf[K_GLOBAL]) }} 行</span>
            <span class="wb-muted">{{ savedAt[K_GLOBAL] ? `上次保存 ${fmt(savedAt[K_GLOBAL])}` : '尚未落库' }}</span>
          </div>
        </el-card>

        <!-- 全局变体库 -->
        <el-card v-else-if="current === 'gv' && !loadError" shadow="never" class="sp-panel">
          <template #header>
            <div class="panel-head">
              <div class="panel-title">
                <strong>全局变体库</strong>
                <span class="wb-muted">赛道没单独配变体时用这里兜底</span>
              </div>
            </div>
          </template>

          <el-alert type="info" :closable="false" class="panel-hint">
            <p>
              <b>为什么要轮换：</b>平台会把「结构、框架、标题长期高度相似」判为低创作度。每写一篇自动取下一行，
              三个维度各转各的，连续多篇不重样。条数越少，重复得越快。
            </p>
            <p>
              <b>篇幅档格式：</b><code>1400-1650|13-15|短打型：说明</code>（字数区间 | 全文段落数锚 | 这一档的写法）。
              区间必须落在推送门禁 1300-2300 字内，写错格式会被静默忽略并回退默认篇幅。
            </p>
          </el-alert>

          <el-tabs v-model="gvTab" class="sp-tabs">
            <el-tab-pane name="spec">
              <template #label>
                <span class="tab-label">
                  写作规范
                  <i v-if="isDirty(skey(currentTrack))" class="dirty-dot" />
                </span>
              </template>
              <p class="tab-hint wb-muted">
                按 <code>## 段落形态</code> / <code>## 强调标注</code> / <code>## 句式补充</code> 分节，每节单独注入。
                「去AI味（预留）」小节可以留着占位，但**当前不会生效**（能力尚未开发）。
              </p>
              <el-input
                v-model="buf[skey(currentTrack)]"
                type="textarea"
                :autosize="{ minRows: 16, maxRows: 34 }"
                placeholder="## 段落形态&#10;- 主体段落 3-5 句、60-140 字&#10;&#10;## 强调标注&#10;- 全篇 8-12 处加粗&#10;&#10;## 句式补充&#10;- 本赛道额外禁忌…"
              />
            </el-tab-pane>

            <el-tab-pane v-for="d in DIMS" :key="d.dim" :name="d.dim">
              <template #label>
                <span class="tab-label">
                  {{ d.label }}
                  <i v-if="isDirty(vkey(K_GLOBAL, d.dim))" class="dirty-dot" />
                </span>
              </template>
              <VariantLinesEditor v-model="buf[vkey(K_GLOBAL, d.dim)]" :dim="d.dim" scope="global" />
            </el-tab-pane>
          </el-tabs>

          <div class="editor-foot">
            <div class="foot-state">
              <el-tag v-if="isDirty(vkey(K_GLOBAL, gvTab))" size="small" type="warning" effect="plain">未保存</el-tag>
              <span class="wb-muted">{{ DIMS.find((d) => d.dim === gvTab)?.hint }}</span>
            </div>
            <div class="foot-ops">
              <el-button size="small" :icon="RefreshLeft" @click="restoreKey(vkey(K_GLOBAL, gvTab))">恢复默认</el-button>
              <el-button
                size="small"
                type="primary"
                :loading="saving === vkey(K_GLOBAL, gvTab)"
                :disabled="!isDirty(vkey(K_GLOBAL, gvTab))"
                @click="saveKey(vkey(K_GLOBAL, gvTab))"
              >
                保存这一维
              </el-button>
            </div>
          </div>
        </el-card>

        <!-- 赛道文体与变体 -->
        <el-card v-else-if="currentTrack && !loadError" shadow="never" class="sp-panel">
          <template #header>
            <div class="panel-head">
              <div class="panel-title">
                <strong>{{ currentTrack }}</strong>
                <el-tag v-if="alignOf(currentTrack) === 'ok'" size="small" type="success" effect="plain">
                  已对接赛道管理
                </el-tag>
                <el-tag v-else-if="alignOf(currentTrack) === 'disabled'" size="small" type="info" effect="plain">
                  赛道已停用
                </el-tag>
                <el-tooltip
                  v-else
                  content="赛道管理里没有同名赛道。写稿按赛道名匹配，名字对不上时这份配置读不到。"
                  placement="bottom"
                >
                  <el-tag size="small" type="warning" effect="plain">赛道管理中无此赛道</el-tag>
                </el-tooltip>
              </div>
              <div class="panel-ops">
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :icon="Delete"
                  :loading="saving === `del:${currentTrack}`"
                  @click="removeTrack(currentTrack)"
                >
                  删除此赛道配置
                </el-button>
              </div>
            </div>
          </template>

          <el-tabs v-model="trackTab" class="sp-tabs">
            <el-tab-pane name="sys">
              <template #label>
                <span class="tab-label">
                  系统提示词
                  <i v-if="isDirty(syskey(currentTrack))" class="dirty-dot" />
                </span>
              </template>
              <p class="tab-hint wb-muted">
                这一段决定<b>文章长什么样</b>，权重高于赛道文体。用 <code>## system</code> 分出入 system 消息的部分
                （结构、形态、禁令），用 <code>## tail</code> 分出拼在 user 消息末尾的收尾指令（这次怎么写、自检清单）。
                数字一律用变量，<b>不要写死</b>——写死会和推送门禁打架。
              </p>
              <div class="var-chips">
                <span class="wb-muted">可用变量：</span>
                <el-tooltip v-for="v in TEMPLATE_VARS" :key="v.name" :content="v.desc" placement="top">
                  <code class="var-chip">{{ varLabel(v.name) }}</code>
                </el-tooltip>
              </div>
              <el-input
                v-model="buf[syskey(currentTrack)]"
                type="textarea"
                :autosize="{ minRows: 18, maxRows: 40 }"
                placeholder="## system&#10;你是…类公众号写手。&#10;1. 结构：<h1> + {{minSections}}-{{maxSections}} 个 <h2>&#10;…&#10;&#10;## tail&#10;全文 {{pMin}}-{{pMax}} 个 <p> 段落，目标 {{targetMin}}-{{targetMax}} 字。…"
              />
            </el-tab-pane>

            <el-tab-pane name="prompt">
              <template #label>
                <span class="tab-label">
                  赛道文体
                  <i v-if="isDirty(currentTrack)" class="dirty-dot" />
                </span>
              </template>
              <p class="tab-hint wb-muted">
                调性 / 目标读者 / 语气 / 结构偏好 / 金句风格 / 禁忌。写稿时这段会整段注入，所以按「字段：内容」一行一条最稳。
              </p>
              <el-input
                v-model="buf[currentTrack]"
                type="textarea"
                :autosize="{ minRows: 14, maxRows: 30 }"
                placeholder="赛道：育儿（0-12 岁孩子的家庭养育）。&#10;调性：温柔共情 + 实用可操作。&#10;禁忌：…"
              />
            </el-tab-pane>

            <el-tab-pane v-for="d in DIMS" :key="d.dim" :name="d.dim">
              <template #label>
                <span class="tab-label">
                  {{ d.label }}
                  <i v-if="isDirty(vkey(currentTrack, d.dim))" class="dirty-dot" />
                </span>
              </template>

              <div class="source-line">
                <template v-if="variantInfo(currentTrack, d.dim).source === 'track'">
                  <el-tag size="small" type="success" effect="plain">本赛道自己的库</el-tag>
                  <span class="wb-muted">
                    共 {{ variantInfo(currentTrack, d.dim).lines }} {{ d.dim === 'structure' ? '张' : '条' }}，下一篇用第
                    {{ nextPick(currentTrack, variantInfo(currentTrack, d.dim).lines) }} {{ d.dim === 'structure' ? '张' : '条' }}
                  </span>
                </template>
                <template v-else-if="variantInfo(currentTrack, d.dim).source === 'global'">
                  <el-tag size="small" type="info" effect="plain">回落全局库</el-tag>
                  <span class="wb-muted">
                    这里空着就用全局库的 {{ variantInfo(currentTrack, d.dim).lines }} {{ d.dim === 'structure' ? '张' : '条' }}，加了才会覆盖
                  </span>
                </template>
                <template v-else>
                  <el-tag size="small" type="warning" effect="plain">用内置兜底</el-tag>
                  <span class="wb-muted">这里和全局库都空着，写稿时用代码内的默认变体</span>
                </template>
              </div>

              <VariantLinesEditor v-model="buf[vkey(currentTrack, d.dim)]" :dim="d.dim" />
            </el-tab-pane>
          </el-tabs>

          <div class="editor-foot">
            <div class="foot-state">
              <el-tag v-if="isDirty(currentEditorKey)" size="small" type="warning" effect="plain">未保存</el-tag>
              <span class="wb-muted">
                {{
                  savedAt[currentEditorKey]
                    ? `上次保存 ${fmt(savedAt[currentEditorKey])}`
                    : '这一项还没落库'
                }}
              </span>
            </div>
            <div class="foot-ops">
              <el-button size="small" :icon="RefreshLeft" @click="restoreKey(currentEditorKey)">恢复默认</el-button>
              <el-button
                size="small"
                type="primary"
                :loading="saving === currentEditorKey"
                :disabled="!isDirty(currentEditorKey)"
                @click="saveKey(currentEditorKey)"
              >
                保存
              </el-button>
            </div>
          </div>
        </el-card>

        <el-empty v-else-if="!loadError" description="从左侧选一个配置项开始编辑" />
      </section>
    </div>

    <!-- 新增赛道 -->
    <el-dialog v-model="createVisible" title="新增赛道文风" width="min(480px, 92vw)">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="72px">
        <el-form-item label="赛道" prop="name">
          <el-select
            v-model="createForm.name"
            filterable
            allow-create
            default-first-option
            placeholder="选赛道管理里的赛道，或直接输入新名字"
            style="width: 100%"
          >
            <el-option v-for="t in unconfigured" :key="t.id" :label="t.name" :value="t.name">
              <span>{{ t.name }}</span>
              <span class="opt-hint">{{ t.enabled ? '赛道管理中' : '已停用' }}</span>
            </el-option>
          </el-select>
          <div class="form-tip">名字要与「赛道管理」里的赛道名一致，写稿才能读到这份配置。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving.startsWith('new:')" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ── 顶部未保存条 ── */
.dirty-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-3);
  padding: 8px 12px;
  border: 1px solid var(--wb-warning);
  border-radius: var(--wb-radius);
  background: var(--wb-warning-soft);
  position: sticky;
  top: 0;
  z-index: 6;
}

.dirty-bar__icon {
  color: var(--wb-warning);
  font-size: 16px;
  flex: none;
}

.dirty-bar__text {
  display: flex;
  align-items: baseline;
  gap: var(--wb-space-2);
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  font-size: 13px;
}

.btn-badge {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.28);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* ── 两栏骨架 ── */
.sp-layout {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: var(--wb-gap);
  align-items: start;
}

.sp-nav {
  position: sticky;
  top: var(--wb-space-2);
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-2);
  padding: var(--wb-space-2);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: var(--wb-shadow-card);
  max-height: calc(100vh - 40px);
  overflow: auto;
}

.sp-menu {
  border-right: none;
  background: transparent;
  --el-menu-item-height: 38px;
  --el-menu-base-level-padding: 10px;
}

.sp-menu :deep(.el-menu-item) {
  height: 38px;
  line-height: 38px;
  margin: 1px 0;
  padding: 0 8px;
  border-radius: var(--wb-radius-sm);
  font-size: 13px;
  gap: 6px;
}

.sp-menu :deep(.el-menu-item.is-active) {
  background: var(--wb-nav-active-bg);
  color: var(--wb-primary);
  font-weight: 600;
}

.sp-menu :deep(.el-menu-item:not(.is-active):hover) {
  background: var(--wb-surface-muted);
}

.sp-menu :deep(.el-menu-item-group__title) {
  padding: 8px 8px 2px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--wb-text-muted);
  font-weight: 600;
}

.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-2);
}

.group-add {
  font-size: 12px;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-flag {
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-weight: 700;
}

.nav-flag.is-muted {
  background: var(--wb-chip-bg);
  color: var(--wb-text-muted);
}

.dirty-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-warning);
  display: inline-block;
}

.nav-empty {
  padding: 6px 10px;
  font-size: 12px;
}

.nav-note {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--wb-border);
  font-size: 12px;
}

.nav-note__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.clickable {
  cursor: pointer;
}

/* ── 面板 ── */
.sp-main {
  min-width: 0;
  min-height: 320px;
}

.sp-panel :deep(.el-card__body) {
  padding-top: 12px;
}

/* autosize 的 textarea 不需要拖拽手柄，否则一拖就撑破卡片 */
.sp-panel :deep(.el-textarea__inner) {
  resize: none;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.panel-title strong {
  font-size: 15px;
}

.panel-ops {
  display: flex;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
}

.panel-hint {
  margin-bottom: var(--wb-space-3);
}

.panel-hint p {
  margin: 2px 0;
  line-height: 1.7;
  font-size: 13px;
}

.panel-hint code,
.tab-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--wb-chip-bg);
  font-family: "JetBrains Mono", Consolas, Menlo, monospace;
  font-size: 11px;
}

.sp-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--wb-space-3);
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-hint {
  margin: 0 0 var(--wb-space-2);
  font-size: 12px;
}

.source-line {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  margin-bottom: var(--wb-space-2);
  font-size: 12px;
}

/* 系统提示词的可用变量：做成可点即知的 chip，省得去翻文档 */
.var-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--wb-space-2);
  font-size: 12px;
}

.var-chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-chip-bg);
  font-family: "JetBrains Mono", Consolas, Menlo, monospace;
  font-size: 11px;
  cursor: help;
}

.editor-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
  margin-top: var(--wb-space-2);
}

/* 底部操作条吸底：即使变体条目很多，保存也不用往上翻 */
.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
  position: sticky;
  bottom: 0;
  margin-top: var(--wb-space-3);
  padding: 10px 0 2px;
  background: linear-gradient(to top, var(--wb-surface) 72%, transparent);
}

.foot-state {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  font-size: 12px;
}

.foot-ops {
  display: flex;
  gap: var(--wb-space-2);
}

.form-tip {
  margin-top: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.5;
}

.opt-hint {
  float: right;
  color: var(--wb-text-muted);
  font-size: 12px;
}

/* ── 窄屏：导航回到顶部，单列 ── */
@media (max-width: 992px) {
  .sp-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .sp-nav {
    position: static;
    max-height: none;
  }
}
</style>
