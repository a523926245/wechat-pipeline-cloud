<script setup lang="ts">
import {
  ArrowLeft,
  Document,
  MagicStick,
  Picture,
  Refresh,
  Select,
  Upload,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import {
  applyEmphasis,
  getArticle,
  previewArticle,
  previewEmphasis,
  pushArticle,
  updateArticleContent,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { ArticleDetail, ArticleRenderResult } from '../types.ts';
import { statusTag, statusText } from '../utils/format.ts';

const props = defineProps<{ id: string | number }>();
const router = useRouter();
const articleId = computed(() => Number(props.id));

const article = ref<ArticleDetail | null>(null);
const html = ref('');
const rendered = ref<ArticleRenderResult | null>(null);
const loading = ref(false);
const loadError = ref('');
const saving = ref(false);
const pushing = ref(false);
const emphasizing = ref(false);
const dirty = ref(false);

/** 窄屏一次只看一侧，避免源码与预览相互挤压。断点由内容何时需要重排决定。 */
const isNarrow = ref(false);
const mobileTab = ref<'edit' | 'preview'>('edit');

function syncNarrow() {
  isNarrow.value = window.innerWidth < 992;
}

const taRef = ref<HTMLTextAreaElement | null>(null);
const emphParams = ref({ min: 6, max: 12, keyMin: 2 });

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    article.value = await getArticle(articleId.value);
    html.value = article.value.contentHtml;
    dirty.value = false;
    await reloadPreview();
  } catch (e) {
    loadError.value = errMsg(e, '文章加载失败');
  } finally {
    loading.value = false;
  }
}

/** 重新渲染预览：走后端同一个渲染函数，保证「所见即所推」。 */
async function reloadPreview() {
  try {
    rendered.value = await previewArticle(articleId.value);
  } catch (e) {
    ElMessage.error(errMsg(e, '预览渲染失败'));
  }
}

onMounted(() => {
  void load();
  syncNarrow();
  window.addEventListener('beforeunload', guardUnload);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', syncNarrow);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', guardUnload);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', syncNarrow);
});

function onInput() {
  dirty.value = true;
}

function guardUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (dirty.value && !saving.value) void save();
  }
}

/** 有未保存改动时离开路由前确认，避免误触丢失改稿。 */
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前有未保存的修改，离开后会丢失。是否确认离开？', '未保存的改动', {
      type: 'warning',
      confirmButtonText: '放弃并离开',
      cancelButtonText: '留在本页',
      distinguishCancelAndClose: true,
    });
    return true;
  } catch {
    return false;
  }
});

async function save() {
  if (!html.value.trim()) {
    ElMessage.warning('正文不能为空');
    return;
  }
  saving.value = true;
  try {
    const res = await updateArticleContent(articleId.value, html.value);
    rendered.value = { ...res } as ArticleRenderResult;
    dirty.value = false;
    if (article.value) article.value.status = res.status;
    ElMessage.success('已保存并重新渲染');
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    saving.value = false;
  }
}

/** 在光标处包裹标签；无选中时插入占位文字便于替换。 */
function wrapTag(tag: string, cls?: string, placeholder = '文字') {
  const el = taRef.value;
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const selected = html.value.slice(start, end) || placeholder;
  const open = cls ? `<${tag} class="${cls}">` : `<${tag}>`;
  html.value = html.value.slice(0, start) + `${open}${selected}</${tag}>` + html.value.slice(end);
  dirty.value = true;
  void nextTick(() => {
    el.focus();
    el.selectionStart = start + open.length;
    el.selectionEnd = start + open.length + selected.length;
  });
}

function insertBlock(tag: string, text: string) {
  const el = taRef.value;
  if (!el) return;
  const start = el.selectionStart ?? html.value.length;
  const block = `\n<${tag}>${text}</${tag}>\n`;
  html.value = html.value.slice(0, start) + block + html.value.slice(start);
  dirty.value = true;
  void nextTick(() => {
    el.focus();
    const pos = start + block.length;
    el.selectionStart = pos;
    el.selectionEnd = pos;
  });
}

async function runEmphasis(apply: boolean) {
  emphasizing.value = true;
  try {
    if (!apply) {
      const res = await previewEmphasis({
        contentHtml: html.value,
        min: emphParams.value.min,
        max: emphParams.value.max,
        keyMin: emphParams.value.keyMin,
      });
      if (!res.changed) {
        ElMessage.info('已达标，无需补充强调');
      } else {
        html.value = res.contentHtml;
        dirty.value = true;
        ElMessage.success(`已补充 ${res.stats.added ?? ''} 处强调，请确认后保存`);
      }
      return;
    }

    const res = await applyEmphasis(articleId.value, { ...emphParams.value });
    html.value = await getArticle(articleId.value).then((a) => a.contentHtml);
    if (article.value) article.value.status = 'updated';
    await reloadPreview();
    dirty.value = false;
    ElMessage.success(res.changed ? '已应用强调补全并重新渲染' : '已达标，未做改动');
  } catch (e) {
    ElMessage.error(errMsg(e, '强调补全失败'));
  } finally {
    emphasizing.value = false;
  }
}

async function push() {
  if (dirty.value) {
    ElMessage.warning('有未保存的改动，请先保存再推送');
    return;
  }
  try {
    await ElMessageBox.confirm('将当前预览产物推送到公众号草稿箱（不会群发）。确认继续？', '推送确认', {
      type: 'warning',
      confirmButtonText: '推送草稿箱',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  pushing.value = true;
  try {
    const res = await pushArticle(articleId.value);
    if (res.ok) {
      ElMessage.success(res.message ?? '已推送到草稿箱');
      await load();
    } else {
      ElMessageBox.alert(res.message ?? '推送失败', `推送未成功（${res.errcode ?? '无 errcode'}）`, {
        type: 'error',
        confirmButtonText: '知道了',
      });
    }
  } catch (e) {
    ElMessage.error(errMsg(e, '推送失败'));
  } finally {
    pushing.value = false;
  }
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载文章…">
    <header class="wb-page-head">
      <div class="head-main">
        <h2>在线改稿</h2>
        <p class="wb-page-desc">
          {{ rendered?.title ?? '加载中…' }}
        </p>
      </div>
      <div class="wb-page-actions">
        <el-tag v-if="article" :type="statusTag(article.status)" size="small">
          {{ statusText(article.status) }}
        </el-tag>
        <el-button :icon="ArrowLeft" @click="router.push('/articles')">返回列表</el-button>
        <el-button :icon="Refresh" @click="load">重新加载</el-button>
      </div>
    </header>

    <StateError v-if="loadError" :message="loadError" @retry="load" />

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="正文为语义化 HTML：h1 标题 / h2 小标题 / p 段落；加粗用 strong，品牌红字用 strong class=&quot;key&quot;。右侧预览即真实推送产物。"
    />

    <!-- 窄屏切换 -->
    <el-radio-group v-model="mobileTab" size="small" class="mobile-switch">
      <el-radio-button value="edit">编辑</el-radio-button>
      <el-radio-button value="preview">预览</el-radio-button>
    </el-radio-group>

    <el-row :gutter="12" class="editor-row">
      <el-col v-show="mobileTab === 'edit' || !isNarrow" :xs="24" :md="12">
        <el-card shadow="never" class="pane">
          <template #header>
            <div class="pane-head">
              <span>正文源码</span>
              <el-tag v-if="dirty" type="warning" size="small" effect="light">未保存</el-tag>
              <span v-else class="wb-muted">已保存</span>
            </div>
          </template>

          <div class="tag-tools" role="group" aria-label="插入标签">
            <el-button size="small" :icon="Document" @click="insertBlock('h2', '小标题')">
              H2 小标题
            </el-button>
            <el-button size="small" :icon="Picture" @click="insertBlock('p', '段落内容。')">段落</el-button>
            <el-button size="small" @click="wrapTag('strong')">加粗</el-button>
            <el-button size="small" type="danger" plain @click="wrapTag('strong', 'key', '金句')">
              品牌红字
            </el-button>
          </div>

          <label class="wb-visually-hidden" :for="`src-${articleId}`">正文 HTML 源码</label>
          <textarea
            :id="`src-${articleId}`"
            ref="taRef"
            v-model="html"
            class="src-editor"
            spellcheck="false"
            @input="onInput"
          />

          <div class="emph-bar">
            <span class="wb-muted">强调补全：</span>
            <el-tooltip content="全篇加粗数量下限" placement="top">
              <el-input-number
                v-model="emphParams.min"
                :min="1"
                :max="40"
                size="small"
                controls-position="right"
                style="width: 88px"
                aria-label="加粗下限"
              />
            </el-tooltip>
            <span class="wb-muted">~</span>
            <el-tooltip content="全篇加粗数量上限" placement="top">
              <el-input-number
                v-model="emphParams.max"
                :min="1"
                :max="40"
                size="small"
                controls-position="right"
                style="width: 88px"
                aria-label="加粗上限"
              />
            </el-tooltip>
            <span class="wb-muted">红字≥</span>
            <el-input-number
              v-model="emphParams.keyMin"
              :min="0"
              :max="10"
              size="small"
              controls-position="right"
              style="width: 84px"
              aria-label="红字下限"
            />
            <el-button size="small" :icon="MagicStick" :loading="emphasizing" @click="runEmphasis(false)">
              预览补全
            </el-button>
            <el-button
              size="small"
              type="primary"
              :icon="Select"
              :loading="emphasizing"
              @click="runEmphasis(true)"
            >
              应用并保存
            </el-button>
          </div>

          <div class="save-bar">
            <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">
              {{ dirty ? '保存并重渲染' : '已保存' }}
            </el-button>
            <el-button :icon="Upload" :loading="pushing" @click="push">推送草稿箱</el-button>
            <span class="wb-muted shortcut">Ctrl / ⌘ + S 保存</span>
          </div>
        </el-card>
      </el-col>

      <el-col v-show="mobileTab === 'preview' || !isNarrow" :xs="24" :md="12">
        <el-card shadow="never" class="pane">
          <template #header>
            <div class="pane-head">
              <span>微信预览（即推送产物）</span>
              <el-button size="small" text :icon="Refresh" @click="reloadPreview">重渲染</el-button>
            </div>
          </template>

          <div v-if="rendered">
            <div class="meta">
              <div class="meta-row">
                <span class="wb-muted label">标题</span><span>{{ rendered.title }}</span>
              </div>
              <div class="meta-row">
                <span class="wb-muted label">摘要</span><span>{{ rendered.digest }}</span>
              </div>
              <div class="meta-row stats">
                <span>小标题 {{ rendered.h2Count }}</span>
                <span>段落 {{ rendered.pCount }}</span>
                <span>字数 {{ rendered.charCount }}</span>
                <span>强调 {{ rendered.boldCount }}</span>
              </div>
            </div>

            <el-alert
              v-for="(w, i) in rendered.warnings"
              :key="`aw-${i}`"
              type="warning"
              :title="w"
              show-icon
              :closable="false"
              class="warn-item"
            />

            <div class="wb-preview" v-html="rendered.contentWechat" />
          </div>
          <el-empty v-else description="暂无预览" :image-size="60" />

          <p v-if="article?.mediaId" class="wb-muted media-row">
            已推送 media_id：<span class="wb-mono">{{ article.mediaId }}</span> · {{ article.pushDate }}
          </p>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.head-main {
  min-width: 0;
}

.head-main .wb-page-desc {
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-row {
  flex: 1;
}

.pane {
  display: flex;
  flex-direction: column;
}

.pane-head {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
}

.pane-head span:first-child {
  font-weight: 600;
}

.pane-head .el-button {
  margin-left: auto;
}

.mobile-switch {
  display: none;
}

.tag-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--wb-space-2);
}

.src-editor {
  width: 100%;
  min-height: 380px;
  height: 46vh;
  resize: vertical;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  padding: 10px 12px;
  font-family: 'JetBrains Mono', Consolas, Menlo, monospace;
  font-size: 13px;
  line-height: 1.75;
  color: var(--wb-text);
  outline: none;
}

.src-editor:focus {
  border-color: var(--wb-primary);
}

.emph-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: var(--wb-space-3);
}

.save-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  margin-top: var(--wb-space-3);
  flex-wrap: wrap;
}

.shortcut {
  margin-left: auto;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-1);
  margin-bottom: var(--wb-space-3);
  font-size: 13px;
}

.meta-row {
  display: flex;
  gap: var(--wb-space-2);
  align-items: baseline;
}

.meta-row .label {
  flex: none;
  width: 32px;
}

.meta-row.stats {
  gap: var(--wb-space-4);
  color: var(--wb-text-muted);
  font-size: 12px;
}

.warn-item {
  margin-bottom: var(--wb-space-2);
}

.media-row {
  margin-top: var(--wb-space-3);
}

@media (max-width: 991px) {
  .mobile-switch {
    display: inline-flex;
  }

  .shortcut {
    display: none;
  }
}
</style>
