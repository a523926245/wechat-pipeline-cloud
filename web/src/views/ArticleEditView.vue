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
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import {
  applyEmphasis,
  applyRevise,
  generateComicImages,
  generateCover,
  getArticle,
  listComicPanels,
  previewArticle,
  previewEmphasis,
  previewRevise,
  pushArticle,
  regenerateComicPanel,
  updateArticleContent,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type {
  ArticleDetail,
  ArticleRenderResult,
  ComicPanelItem,
  CoverGenerateResult,
  ReviseMode,
} from '../types.ts';
import {
  coverUrl,
  defaultImageRatio,
  defaultImageSize,
  imageRatios,
  imageSizes,
  reviseModeText,
  statusTag,
  statusText,
} from '../utils/format.ts';

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
const revising = ref(false);
const dirty = ref(false);

// ── AI 改写（revise 角色）──
const reviseMode = ref<ReviseMode>('polish');
const reviseInstruction = ref('');
const reviseModes: ReviseMode[] = ['polish', 'rewrite', 'shorten'];

// ── 封面生成（cover 角色）──
const coverDialog = reactive({
  visible: false,
  generating: false,
  prompt: '',
  size: '',
  ratio: '',
  result: null as CoverGenerateResult | null,
  error: '',
});
const coverSizes = imageSizes();
const coverRatios = imageRatios();

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
    if ((article.value.pipeline ?? 'article') === 'comic') {
      await loadPanels();
      // 进来时若还有没画完的格（或后端正在画）→ 自动轮询看进度；若后端没在跑，
      // 顺手把自动推进点着（不 await：同步那一格要 30~40 秒，页面不该等它）。
      // 语义是「建了漫画就该有图」，用户不需要再手动点一次生成。
      if (pendingCount.value > 0 || panelsGenerating.value) {
        startPoll();
        if (pendingCount.value > 0 && !panelsGenerating.value) {
          void generateComicImages(articleId.value).catch(() => undefined);
        }
      } else {
        stopPoll();
      }
    }
  } catch (e) {
    loadError.value = errMsg(e, '文章加载失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 重新渲染预览：走后端同一个渲染函数，保证「所见即所推」。
 * 漫画的预览产物由格图与金句卡现算，格图未就绪时后端返回空/未完成，这里如实展示即可。
 */
async function reloadPreview() {
  try {
    rendered.value = await previewArticle(articleId.value);
  } catch (e) {
    ElMessage.error(errMsg(e, '预览渲染失败'));
  }
}

// ── 漫画模式：分镜格图面板 ──

const isComic = computed(() => (article.value?.pipeline ?? 'article') === 'comic');
const panels = ref<ComicPanelItem[]>([]);
const panelsLoading = ref(false);
const generating = ref(false);
/** 后端后台是否正在生图（真正的产出由后端 kick 推进，前端只负责看进度）。 */
const panelsGenerating = ref(false);

const successCount = computed(() => panels.value.filter((p) => p.status === 'success').length);
const pendingCount = computed(() => panels.value.filter((p) => p.status === 'pending').length);
const failedCount = computed(() => panels.value.filter((p) => p.status === 'failed').length);
const comicReady = computed(() => panels.value.length > 0 && pendingCount.value === 0 && failedCount.value === 0);
const comicPct = computed(() =>
  panels.value.length === 0 ? 0 : Math.round((successCount.value / panels.value.length) * 100),
);
/** 大图预览列表：只含有图可看的格。 */
const panelPreviewList = computed(() =>
  panels.value.filter((p) => p.previewUrl).map((p) => p.previewUrl as string),
);

async function loadPanels() {
  if (!isComic.value) return;
  panelsLoading.value = true;
  try {
    const res = await listComicPanels(articleId.value);
    panels.value = res.items;
    panelsGenerating.value = res.generating === true;
  } catch (e) {
    ElMessage.error(errMsg(e, '分镜格加载失败'));
  } finally {
    panelsLoading.value = false;
  }
}

// 轮询：生图在后端逐格跑（每格 30~40 秒），前端只能靠轮询看进度。
// 条件「还有待生成格 或 后端仍在跑」→ 继续轮询；否则停。
let pollTimer: number | null = null;

function stopPoll() {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

function startPoll() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    void (async () => {
      await loadPanels();
      if (pendingCount.value === 0 && !panelsGenerating.value) stopPoll();
    })();
  }, 3000);
}

/** 手动推一把：接口会顺带把后端的自动推进点着，然后前端开始轮询看进度。 */
async function generatePanels() {
  if (generating.value) return;
  generating.value = true;
  try {
    const res = await generateComicImages(articleId.value);
    const skipped = res.skipped ?? 0;
    if (res.done === 0 && res.failed === 0 && skipped === 0 && pendingCount.value === 0) {
      ElMessage.success('插图已全部生成');
    } else {
      ElMessage({
        type: res.failed > 0 ? 'warning' : 'success',
        message:
          `已推进 ${res.done} 格，插图生成中` +
          (res.failed ? `，失败 ${res.failed} 格` : '') +
          (skipped ? `，${skipped} 格退避中（稍后自动重试）` : ''),
      });
    }
    await loadPanels();
    await load();
    if (pendingCount.value > 0 || panelsGenerating.value) startPoll();
  } catch (e) {
    ElMessage.error(errMsg(e, '生图失败'));
  } finally {
    generating.value = false;
  }
}

async function redoPanel(seq: number) {
  try {
    await regenerateComicPanel(articleId.value, seq);
    ElMessage.success(`第 ${seq} 格已重新生成`);
    await loadPanels();
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '重画失败'));
  }
}

// ── 提示词编辑 + 改词重画 ──
const panelEdit = ref<{ seq: number; prompt: string; lines: string } | null>(null);
const panelEditSaving = ref(false);
const panelEditShow = computed({
  get: () => panelEdit.value !== null,
  set: (v: boolean) => {
    if (!v) panelEdit.value = null;
  },
});

function openPanelEdit(p: ComicPanelItem) {
  panelEdit.value = { seq: p.seq, prompt: p.prompt, lines: p.lines };
}

/** 保存并按新提示词重画（后端先落库再清状态推进）。 */
async function savePanelEdit() {
  const edit = panelEdit.value;
  if (!edit) return;
  if (!edit.prompt.trim()) {
    ElMessage.warning('提示词不能为空');
    return;
  }
  panelEditSaving.value = true;
  try {
    await regenerateComicPanel(articleId.value, edit.seq, {
      prompt: edit.prompt,
      lines: edit.lines,
    });
    ElMessage.success(`第 ${edit.seq} 格已按新提示词重画`);
    panelEdit.value = null;
    await loadPanels();
    await load();
    if (pendingCount.value > 0 || panelsGenerating.value) startPoll();
  } catch (e) {
    ElMessage.error(errMsg(e, '改词重画失败'));
  } finally {
    panelEditSaving.value = false;
  }
}

/**
 * 格状态展示。attempt>0 且仍是 pending = 失败过、正在退避等重试，
 * 必须和「还没轮到（待生成）」区分开，否则用户会以为卡死了。
 */
function panelStatusView(p: ComicPanelItem): { text: string; type: 'success' | 'danger' | 'warning' | 'info' } {
  if (p.status === 'success') return { text: '已生成', type: 'success' };
  if (p.status === 'failed') {
    return { text: p.attempt > 0 ? `失败（已试 ${p.attempt} 次）` : '失败', type: 'danger' };
  }
  if (p.attempt > 0) return { text: `待重试（第 ${p.attempt + 1} 次）`, type: 'warning' };
  return { text: '待生成', type: 'info' };
}

onMounted(() => {
  void load();
  syncNarrow();
  window.addEventListener('beforeunload', guardUnload);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', syncNarrow);
});

onUnmounted(() => {
  stopPoll();
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
    dirty.value = false;
    if (article.value) article.value.status = res.status;
    // 漫画的推送产物是落库的插图序列，PUT 返回的是文字重渲染结果——不能拿它当预览，
    // 否则改一次台词预览就从「插图」退回「脚本」。统一走 preview 拿真实产物。
    if (isComic.value) await reloadPreview();
    else rendered.value = { ...res } as ArticleRenderResult;
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

/**
 * AI 改写：预览只动编辑框（仍需确认保存），应用则直接写库并重渲染。
 * 未绑定 revise 角色 / 模型停用时后端返回 400 + 可读文案，这里照常展示。
 */
async function runRevise(apply: boolean) {
  revising.value = true;
  try {
    if (!apply) {
      const res = await previewRevise({
        contentHtml: html.value,
        mode: reviseMode.value,
        instruction: reviseInstruction.value.trim() || undefined,
      });
      if (!res.changed) {
        ElMessage.info(`「${res.modelName}」认为无需改动`);
        return;
      }
      html.value = res.contentHtml;
      dirty.value = true;
      ElMessage.success(`已由「${res.modelName}」${reviseModeText(reviseMode.value)}，请确认后保存`);
      return;
    }

    const res = await applyRevise(articleId.value, {
      mode: reviseMode.value,
      instruction: reviseInstruction.value.trim() || undefined,
    });
    if (article.value) article.value.status = 'updated';
    await load();
    ElMessage.success(res.changed ? `已应用「${res.modelName}」的改写并重渲染` : '模型未做改动');
  } catch (e) {
    ElMessage.error(errMsg(e, 'AI 改写失败'));
  } finally {
    revising.value = false;
  }
}

const currentCover = computed(() => coverUrl(article.value?.coverPath ?? ''));

function openCoverDialog() {
  coverDialog.visible = true;
  coverDialog.generating = false;
  coverDialog.error = '';
  coverDialog.result = null;
  coverDialog.prompt = '';
  coverDialog.size = defaultImageSize();
  coverDialog.ratio = defaultImageRatio();
}

async function doGenerateCover() {
  coverDialog.generating = true;
  coverDialog.error = '';
  try {
    const res = await generateCover(articleId.value, {
      prompt: coverDialog.prompt.trim() || undefined,
      size: coverDialog.size || undefined,
      ratio: coverDialog.ratio || undefined,
    });
    coverDialog.result = res;
    await load();
    ElMessage.success(res.message);
  } catch (e) {
    coverDialog.error = errMsg(e, '封面生成失败');
  } finally {
    coverDialog.generating = false;
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
      // 被成稿体检拦下时没有 errcode，标题要换成体检口径，否则会显示「无 errcode」让人以为是微信报错。
      const title =
        res.reason === 'lint_failed'
          ? '成稿体检未通过'
          : `推送未成功（${res.errcode ?? '无 errcode'}）`;
      ElMessageBox.alert(res.message ?? '推送失败', title, {
        type: 'error',
        confirmButtonText: '知道了',
      });
      // 体检报告随推送结果回传，直接刷新预览区的体检面板，省得用户再点一次重渲染。
      if (res.lint && rendered.value) rendered.value.lint = res.lint;
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

    <template v-else>
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

    <!-- 漫画模式：分镜格图面板（格图未齐全时推送会被后端拦住） -->
    <el-card v-if="isComic" shadow="never" class="pane comic-pane">
      <template #header>
        <div class="pane-head">
          <span class="pane-title">
            分镜插图 {{ successCount }}/{{ panels.length }}
            <el-tag v-if="panelsGenerating" type="warning" size="small" effect="light">生成中…</el-tag>
            <el-tag v-else-if="comicReady" type="success" size="small">已就绪</el-tag>
            <el-tag v-else-if="failedCount" type="danger" size="small">{{ failedCount }} 格失败</el-tag>
          </span>
          <span class="pane-ops">
            <!-- 生图在后端后台逐格跑（每格 30~40 秒），离开本页也会继续 -->
            <span v-if="panelsGenerating" class="wb-muted">后台自动生成中，可离开本页</span>
            <el-button
              size="small"
              type="primary"
              :loading="generating"
              :disabled="panelsGenerating"
              @click="generatePanels"
            >
              {{ panelsGenerating ? '生成中…' : pendingCount > 0 ? '继续生成格图' : '重新推进' }}
            </el-button>
          </span>
        </div>
      </template>

      <el-progress
        v-if="panels.length && !comicReady"
        :percentage="comicPct"
        :stroke-width="6"
        :status="failedCount ? 'exception' : undefined"
        class="comic-progress"
      />

      <el-empty v-if="!panels.length && !panelsLoading" description="还没有分镜格" :image-size="60" />
      <el-row v-else :gutter="10">
        <el-col v-for="p in panels" :key="p.seq" :xs="12" :sm="8" :md="6" class="panel-col">
          <div class="panel-card">
            <el-image
              v-if="p.previewUrl"
              :src="p.previewUrl"
              fit="cover"
              class="panel-img"
              :preview-src-list="panelPreviewList"
              :initial-index="Math.max(0, panelPreviewList.indexOf(p.previewUrl as string))"
            />
            <div v-else class="panel-img panel-empty">未生成</div>
            <div class="panel-meta">
              <el-tag :type="panelStatusView(p).type" size="small">
                第 {{ p.seq }} 格 · {{ panelStatusView(p).text }}
              </el-tag>
              <el-button size="small" text @click="redoPanel(p.seq)">重画</el-button>
              <el-button size="small" text @click="openPanelEdit(p)">提示词</el-button>
            </div>
            <p v-if="p.lines" class="panel-lines">气泡：{{ p.lines }}</p>
            <p v-if="p.errorMsg && p.status !== 'success'" class="panel-err">{{ p.errorMsg }}</p>
          </div>
        </el-col>
      </el-row>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="comic-hint"
        title="建稿后插图会自动逐格生成（每格约 30~40 秒，失败自动重跑最多 3 次）。全部成功后推送时会自动上传金句卡与插图并渲染正文；连续失败 3 次的格需手动「重画」。"
      />
    </el-card>

    <!-- 单格提示词编辑：改词后保存即按新提示词重画 -->
    <el-dialog
      v-model="panelEditShow"
      :title="`第 ${panelEdit?.seq ?? ''} 格 · 生图提示词`"
      width="640px"
      destroy-on-close
    >
      <el-alert
        type="info"
        show-icon
        :closable="false"
        style="margin-bottom: 12px"
        title="改完点「保存并重画」会用这份提示词重新生图。常见修法：删掉气泡长独白改成短台词；强调「只有一个男孩」；删掉多余人物描述。"
      />
      <el-form label-width="70px">
        <el-form-item label="气泡台词">
          <el-input v-model="panelEdit!.lines" maxlength="20" show-word-limit placeholder="画中人说出口的话（≤10 字最佳）" />
        </el-form-item>
        <el-form-item label="提示词">
          <el-input
            v-model="panelEdit!.prompt"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 16 }"
            placeholder="完整英文/中文混合生图提示词"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="panelEditShow = false">取消</el-button>
        <el-button type="primary" :loading="panelEditSaving" @click="savePanelEdit">保存并重画</el-button>
      </template>
    </el-dialog>

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

          <div class="ai-bar">
            <span class="wb-muted">AI 改写：</span>
            <el-radio-group v-model="reviseMode" size="small">
              <el-radio-button v-for="m in reviseModes" :key="m" :value="m">
                {{ reviseModeText(m) }}
              </el-radio-button>
            </el-radio-group>
            <el-input
              v-model="reviseInstruction"
              size="small"
              maxlength="500"
              placeholder="补充要求（可选），例如：语气更克制、少用感叹号"
              class="ai-input"
            />
            <el-button size="small" :icon="MagicStick" :loading="revising" @click="runRevise(false)">
              预览改写
            </el-button>
            <el-button size="small" type="primary" :loading="revising" @click="runRevise(true)">
              改写并保存
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
              <!-- 漫画：这里预览的是台词脚本；格图与金句卡在推送时才现算进正文 -->
              <span>{{ isComic ? '脚本预览（推送时替换为插图序列）' : '微信预览（即推送产物）' }}</span>
              <el-button size="small" text :icon="Refresh" @click="reloadPreview">重渲染</el-button>
            </div>
          </template>

          <div v-if="rendered">
            <div class="cover-row">
              <div class="cover-thumb">
                <img v-if="currentCover" :src="currentCover" alt="当前封面" />
                <span v-else class="wb-muted">暂无封面</span>
              </div>
              <div class="cover-side">
                <el-button size="small" :icon="Picture" @click="openCoverDialog">
                  {{ currentCover ? '重新生成封面' : '生成封面' }}
                </el-button>
                <span class="wb-muted">由「封面」角色绑定的生图模型产出，画面不含文字</span>
              </div>
            </div>

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

            <!-- 成稿体检：与推送门禁同一套规则，未通过时推送会被拦下 -->
            <div v-if="rendered.lint" class="lint">
              <div class="lint-head">
                <el-tag :type="rendered.lint.ok ? 'success' : 'danger'" size="small">
                  {{ rendered.lint.ok ? '体检通过，可推送' : '体检未通过，推送会被拦下' }}
                </el-tag>
                <span class="wb-muted lint-nums">
                  复合长段落 {{ rendered.lint.stats.longPara }}/{{ rendered.lint.stats.pCount }} ·
                  一句一段 {{ rendered.lint.stats.shortPara }}
                </span>
              </div>
              <ul v-if="rendered.lint.issues.length" class="lint-list">
                <li
                  v-for="(it, i) in rendered.lint.issues"
                  :key="`li-${i}`"
                  :class="['lint-item', it.level === 'error' ? 'is-error' : 'is-warn']"
                >
                  {{ it.message }}
                </li>
              </ul>
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
          <el-empty v-else description="暂无预览" :image-size="64" />

          <p v-if="article?.mediaId" class="wb-muted media-row">
            已推送 media_id：<span class="wb-mono">{{ article.mediaId }}</span> · {{ article.pushDate }}
          </p>
        </el-card>
      </el-col>
    </el-row>
    </template>

    <el-dialog v-model="coverDialog.visible" title="生成封面" width="min(560px, 92vw)">
      <el-form label-width="88px">
        <el-form-item label="画面描述">
          <el-input
            v-model="coverDialog.prompt"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="留空则由系统依据标题、摘要与正文自动构造提示词"
          />
        </el-form-item>
        <el-form-item label="尺寸">
          <el-select v-model="coverDialog.size" style="width: 100%">
            <el-option v-for="s in coverSizes" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="宽高比">
          <el-select v-model="coverDialog.ratio" style="width: 100%">
            <el-option v-for="r in coverRatios" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
      </el-form>

      <StateError
        v-if="coverDialog.error"
        :message="coverDialog.error"
        @retry="doGenerateCover"
        class="cover-error"
      />

      <div v-if="coverDialog.result" class="cover-result">
        <img :src="coverUrl(coverDialog.result.coverUrl)" alt="生成的封面" />
        <p class="wb-muted">
          {{ coverDialog.result.modelName }} · {{ coverDialog.result.size }} ·
          {{ coverDialog.result.ratio }} · {{ (coverDialog.result.bytes / 1024).toFixed(0) }} KB
        </p>
      </div>

      <template #footer>
        <el-button @click="coverDialog.visible = false">关闭</el-button>
        <el-button type="primary" :loading="coverDialog.generating" @click="doGenerateCover">
          {{ coverDialog.result ? '再生成一张' : '生成' }}
        </el-button>
      </template>
    </el-dialog>
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
  gap: var(--wb-space-2);
  margin-bottom: var(--wb-space-2);
}

.src-editor {
  width: 100%;
  min-height: 380px;
  height: 46vh;
  resize: vertical;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  padding: var(--wb-space-2) var(--wb-space-3);
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
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  margin-top: var(--wb-space-3);
}

.ai-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  margin-top: var(--wb-space-3);
}

.ai-input {
  flex: 1 1 180px;
  min-width: 150px;
}

.save-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  margin-top: var(--wb-space-3);
  flex-wrap: wrap;
}

.cover-row {
  display: flex;
  gap: var(--wb-space-3);
  align-items: flex-start;
  margin-bottom: var(--wb-space-3);
}

.cover-thumb {
  width: 168px;
  height: 72px;
  flex: none;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--wb-surface-muted);
}

.cover-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-side {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-2);
  align-items: flex-start;
  min-width: 0;
  font-size: 12px;
}

.cover-result {
  margin-top: var(--wb-space-3);
}

.cover-result img {
  width: 100%;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
}

.cover-error {
  margin-top: var(--wb-space-2);
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

/* 成稿体检 */
.lint {
  margin-bottom: var(--wb-space-3);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  padding: var(--wb-space-2) var(--wb-space-3);
}

.lint-head {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
}

.lint-nums {
  font-size: 12px;
}

.lint-list {
  margin: var(--wb-space-2) 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

.lint-item.is-error {
  color: var(--wb-danger);
}

.lint-item.is-warn {
  color: var(--wb-text-2);
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

/* 漫画分镜格面板 */
.comic-pane {
  margin-bottom: var(--wb-space-3);
}

/* 漫画面板头：标题 + 状态标签在左，生成按钮与说明在右 */
.pane-title {
  display: inline-flex;
  align-items: center;
  gap: var(--wb-space-2);
  font-weight: 500;
}

.pane-ops {
  display: inline-flex;
  align-items: center;
  gap: var(--wb-space-2);
  margin-left: auto;
  font-size: 12px;
}

.comic-progress {
  margin-bottom: var(--wb-space-3);
}

.comic-hint {
  margin-top: var(--wb-space-2);
}

.panel-col {
  margin-bottom: var(--wb-space-2);
}

.panel-card {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  padding: var(--wb-space-2);
}

.panel-img {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 4px;
  background: var(--wb-surface-2);
}

.panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--wb-text-3);
  font-size: 12px;
}

.panel-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--wb-space-1);
}

.panel-lines,
.panel-err {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--wb-text-2);
  word-break: break-all;
}

.panel-err {
  color: var(--wb-danger);
}
</style>
