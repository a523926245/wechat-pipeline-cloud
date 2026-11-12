<script setup lang="ts">
/**
 * 变体库逐条编辑器（**按条目编辑，不是按行**）。
 *
 * 背景（2026-11-11 改造）：一条变体现在可以是一整张**骨架卡**（5-8 行：第一节/第二节…），
 * 多条之间用单独一行 `---` 分隔。如果还按「一行一条」渲染，就会出现两个难看的现象：
 *   1. 卡里的每一行都变成一条独立条目（实测 5 张卡被拆成 34 条）；
 *   2. 分隔符 `---` 自己变成一条内容，还会被判「格式不合规」。
 *
 * 所以这里改为按**条目**编辑：
 * - 结构变体 → 卡片式：卡片头显示「骨架名」，正文是一个多行输入框；
 * - 标题 / 篇幅 → 单行条目（篇幅仍做格式校验）。
 * 对外依旧是纯文本，拼回去用 `joinVariantBlocks()`，与后端同源。
 */
import { ArrowDown, ArrowUp, Delete, Plus } from '@element-plus/icons-vue';
import { ElInput } from 'element-plus';
import { computed, nextTick, ref, watch } from 'vue';

import {
  blockTitle,
  joinVariantBlocks,
  parseLengthLine,
  splitVariantBlocks,
} from '../utils/variants.ts';

type VariantDim = 'title' | 'structure' | 'length';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 维度：structure 走卡片式；length 走篇幅档格式校验 */
    dim?: VariantDim;
    placeholder?: string;
    disabled?: boolean;
    /** 这份配置是全局库还是赛道库——决定空态时说「回落全局」还是「用内置兜底」 */
    scope?: 'global' | 'track';
  }>(),
  { dim: 'title', placeholder: '', disabled: false, scope: 'track' },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

interface Row {
  id: number;
  text: string;
}

let seq = 0;
const rows = ref<Row[]>([]);
const inputs = new Map<number, InstanceType<typeof ElInput>>();

function fromText(text: string) {
  rows.value = splitVariantBlocks(text).map((t) => ({ id: ++seq, text: t }));
}

function read(): string {
  return joinVariantBlocks(rows.value.map((r) => r.text));
}

/**
 * 只在外部值与当前内容不同步时才重建。
 * 少了这层判断，每次敲键盘都会重建整个列表，光标会跳到末尾。
 */
watch(
  () => props.modelValue,
  (v) => {
    if ((v ?? '') !== read()) fromText(v ?? '');
  },
  { immediate: true },
);

function sync() {
  emit('update:modelValue', read());
}

function setRef(id: number) {
  return (el: unknown) => {
    if (el) inputs.set(id, el as InstanceType<typeof ElInput>);
    else inputs.delete(id);
  };
}

/** 新增条目的初始模板：给个能直接改的骨架，比空文本框好上手。 */
function templateFor(): string {
  if (props.dim === 'structure') {
    return ['骨架｜新骨架', '第一节：', '第二节：', '第三节：', '第四节：收尾，回扣一个物件 + 问读者'].join('\n');
  }
  if (props.dim === 'length') return '1800-2200|17-19|标准型：完整展开，方法收尾';
  return '公式名：{一个具体场景} + {星座/对象} + {一句人话后果}';
}

function addAt(index: number) {
  const row: Row = { id: ++seq, text: templateFor() };
  rows.value.splice(index + 1, 0, row);
  sync();
  void nextTick(() => inputs.get(row.id)?.focus());
}

function addFirst() {
  const row: Row = { id: ++seq, text: templateFor() };
  rows.value.push(row);
  sync();
  void nextTick(() => inputs.get(row.id)?.focus());
}

function removeAt(index: number) {
  rows.value.splice(index, 1);
  sync();
}

function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= rows.value.length) return;
  const [row] = rows.value.splice(index, 1);
  if (!row) return;
  rows.value.splice(target, 0, row);
  sync();
}

/** 篇幅档：多行必然不合规（一条就是一档）。 */
const parsedRows = computed(() =>
  rows.value.map((r) => (props.dim === 'length' ? parseLengthLine(r.text) : null)),
);

const badCount = computed(
  () => (props.dim === 'length' ? parsedRows.value.filter((p) => !p).length : 0),
);

const placeholders: Record<VariantDim, string> = {
  title: '一条标题公式，如：数字清单型：{N} 个{行为细节}，你是第几个',
  structure: '第一行写「骨架｜名字」，下面逐节写清要干什么',
  length: '1400-1650|13-15|短打型：一个场景讲透一个点',
};

const emptyText = computed(() => {
  if (props.scope === 'global') {
    return props.dim === 'length'
      ? '还没有篇幅档，写稿会用代码内置的默认篇幅锚'
      : '这一维是空的，写稿会用代码内置的默认变体';
  }
  return props.dim === 'length'
    ? '没有篇幅档，写稿会回落全局库或默认锚'
    : '这一维是空的，会回落到全局变体库';
});

const isCard = computed(() => props.dim === 'structure');
</script>

<template>
  <div class="variant-lines">
    <p v-if="isCard" class="vl-hint wb-muted">
      一张卡 = 一套节结构（第一节到第四节各干什么、写哪几个、段数）。第一行写「骨架｜名字」，
      下面的行写具体要求。<strong>按顺序轮换</strong>，右上角可以调顺序。
    </p>

    <div v-for="(row, i) in rows" :key="row.id" class="vitem" :class="{ 'is-card': isCard }">
      <div class="vitem__head">
        <span class="vitem__no wb-num" :class="{ 'is-bad': dim === 'length' && !parsedRows[i] }">
          {{ i + 1 }}
        </span>
        <span v-if="isCard" class="vitem__title">{{ blockTitle(row.text, i) }}</span>
        <span v-else-if="dim === 'length'" class="vitem__title">
          {{ parsedRows[i] ? `${parsedRows[i]?.min}-${parsedRows[i]?.max} 字 · ${parsedRows[i]?.pMin}-${parsedRows[i]?.pMax} 段` : '待修正' }}
        </span>
        <span v-else class="vitem__title wb-muted">第 {{ i + 1 }} 条</span>

        <div class="vitem__ops">
          <el-tooltip content="上移（更早被轮换到）" placement="top" :show-after="400">
            <el-button link size="small" :icon="ArrowUp" :disabled="disabled || i === 0" aria-label="上移" @click="move(i, -1)" />
          </el-tooltip>
          <el-tooltip content="下移" placement="top" :show-after="400">
            <el-button link size="small" :icon="ArrowDown" :disabled="disabled || i === rows.length - 1" aria-label="下移" @click="move(i, 1)" />
          </el-tooltip>
          <el-tooltip content="删除这一条" placement="top" :show-after="400">
            <el-button link size="small" type="danger" :icon="Delete" :disabled="disabled" aria-label="删除" @click="removeAt(i)" />
          </el-tooltip>
        </div>
      </div>

      <el-input
        :ref="setRef(row.id)"
        v-model="row.text"
        type="textarea"
        :autosize="{ minRows: isCard ? 4 : 1, maxRows: isCard ? 20 : 5 }"
        :placeholder="placeholder || placeholders[dim]"
        :disabled="disabled"
        @input="sync"
      />

      <div v-if="dim === 'length' && !parsedRows[i]" class="vitem__meta">
        <el-tag size="small" type="danger" effect="plain">格式不合规</el-tag>
        <span class="bad-hint">
          须为 <code>字数区间|段数锚|说明</code>，如 <code>1400-1650|13-15|短打型</code>
          —— 不合法会被静默忽略，写稿回退默认篇幅
        </span>
      </div>
    </div>

    <el-empty v-if="rows.length === 0" :image-size="46" :description="emptyText" />

    <div class="variant-lines__foot">
      <el-button size="small" :icon="Plus" :disabled="disabled" @click="rows.length === 0 ? addFirst() : addAt(rows.length - 1)">
        {{ isCard ? '新增一张骨架卡' : dim === 'length' ? '新增一档' : '新增一条' }}
      </el-button>
      <span class="wb-muted">
        共 {{ rows.length }} {{ isCard ? '张' : '条' }}，按上面的顺序循环取用<span v-if="badCount > 0" class="bad-count">
          · {{ badCount }} 条格式不合规</span
        >
      </span>
    </div>
  </div>
</template>

<style scoped>
.variant-lines {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-2);
}

.vl-hint {
  margin: 0 0 var(--wb-space-1);
  font-size: 12px;
  line-height: 1.7;
}

.vitem {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--wb-space-2) var(--wb-space-3);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
}

.vitem.is-card {
  padding: var(--wb-space-3);
}

.vitem:focus-within {
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 3px var(--wb-ring);
}

.vitem__head {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  min-height: 22px;
}

.vitem__no {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--wb-chip-bg);
  color: var(--wb-text-secondary);
  font-size: 11px;
  line-height: 20px;
  text-align: center;
  font-weight: 600;
}

.vitem__no.is-bad {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

.vitem__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text);
}

.vitem:not(.is-card) .vitem__title {
  font-weight: 400;
  font-size: 12px;
}

.vitem__ops {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.vitem__body :deep(.el-textarea__inner),
.vitem :deep(.el-textarea__inner) {
  padding: 6px 10px;
  line-height: 1.7;
  box-shadow: none;
  resize: none;
  background: var(--wb-surface-muted);
}

.vitem :deep(.el-textarea__inner:focus) {
  background: var(--wb-surface);
  box-shadow: 0 0 0 1px var(--wb-primary) inset;
}

.vitem__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wb-space-2);
  font-size: 12px;
}

.variant-lines__foot {
  display: flex;
  align-items: center;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
}

.bad-hint {
  color: var(--wb-danger);
  font-size: 12px;
}

.bad-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--wb-chip-bg);
  font-family: "JetBrains Mono", Consolas, Menlo, monospace;
  font-size: 11px;
}

.bad-count {
  color: var(--wb-danger);
}
</style>
