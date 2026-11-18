<script setup lang="ts">
import { Delete, Edit, Refresh, Upload, View } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { errMsg } from "../api/http.ts";
import {
  bulkDeleteArticles,
  deleteArticle,
  getArticle,
  listArticles,
  previewArticle,
  pushArticle,
} from "../api/index.ts";
import BatchBar from "../components/BatchBar.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHead from "../components/PageHead.vue";
import StateError from "../components/StateError.vue";
import StatusTag from "../components/StatusTag.vue";
import RowActions, { type RowAction } from "../components/RowActions.vue";
import { useAuth } from "../composables/useAuth.ts";
import { useBatchDelete } from "../composables/useBatchDelete.ts";
import type {
  ArticleDetail,
  ArticleListItem,
  ArticleRenderResult,
} from "../types.ts";
import {
  batchDeleteImpact,
  noAccountGuide,
  pushFailView,
  pushFact,
} from "../utils/article-push.ts";
import {
  coverUrl,
  friendlyTime,
  pipelineText,
} from "../utils/format.ts";
import { parseArticleNeeds, type ArticleNeeds } from "../utils/todo-nav.ts";

const router = useRouter();
const { userRole } = useAuth();
const route = useRoute();

const items = ref<ArticleListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");
const pushingId = ref<number | null>(null);
const deletingId = ref<number | null>(null);

/** 详情/预览弹窗状态：账号名取自列表行，其余详情与实时预览并行拉取。 */
const previewDialog = ref({
  visible: false,
  loading: false,
  error: "",
  id: 0,
  account: null as string | null,
  detail: null as ArticleDetail | null,
  rendered: null as ArticleRenderResult | null,
});

const PAGE_SIZE = 20;

/** 筛选与页码放进 URL：可分享、可返回、刷新不丢失。 */
const status = computed<string>(() =>
  typeof route.query.status === "string" ? route.query.status : "",
);
/** 选题下钻：从选题库点「关联文章」跳进来，angle>0 表示按选题过滤。 */
const angle = computed<number>(() => {
  const n = Number(route.query.angle);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
});
/** 产线过滤：全部 / 文章 / 漫画（与选题下钻同款 URL query 约定）。 */
const pipeline = computed<string>(() => {
  const v = route.query.pipeline;
  return typeof v === "string" && ["article", "comic"].includes(v) ? v : "";
});
/**
 * 工作台待办专项筛选（S5-UI-2-D-2）：只认服务端支持的 draft_unpushed / repush，
 * 非法值视为未传（页面回退普通列表，不报错、不空列表）。
 */
const needs = computed<ArticleNeeds | undefined>(() =>
  parseArticleNeeds(route.query.needs),
);
/** 待办专项筛选的说明文案：标题 + 条件，进页面就要能看懂「现在是按什么筛的」。 */
const NEEDS_META: Record<ArticleNeeds, { title: string; cond: string }> = {
  draft_unpushed: {
    title: "未推送草稿",
    cond: "普通文章 · 草稿状态 · 无推送记录",
  },
  repush: {
    title: "待重推文章",
    cond: "普通文章 · 曾经推送 · 当前处于待处理状态（updated，或有推送痕迹的 draft）",
  },
};
const needsMeta = computed(() => (needs.value ? NEEDS_META[needs.value] : null));

const page = computed<number>(() => {
  const n = Number(route.query.page ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await listArticles({
      // needs 生效时不发 status/pipeline：服务端本就以 needs 为准，少发两个条件，
      // 请求与页面显示（状态下拉已禁用）才能对得上。
      status: needs.value ? undefined : status.value || undefined,
      needs: needs.value,
      angleId: angle.value || undefined,
      pipeline: needs.value ? undefined : pipeline.value || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    items.value = res.items;
    total.value = res.total;
  } catch (e) {
    error.value = errMsg(e, "文章列表加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([status, angle, pipeline, page, needs], load);

/**
 * 批量删除：与单条删除同一套语义（永久删除；未推送文章占用的选题角度会归还角度池）。
 * 提示里要点明「哪些会归还角度」——归还后同一选题可能被再次使用。
 */
const articleTableRef = ref<{ clearSelection: () => void } | null>(null);

/**
 * 窄屏（≤900px）表格紧凑模式（S5-UI-3-3 · B）。
 * 与全局 col-optional 断点一致：窄屏把「推送事实」与选择列一起固定在左侧，
 * 确保它真实进入可视区且不被 fixed=right 的操作列遮挡；桌面端保持原布局。
 */
const narrow = ref(false);
function syncNarrow() {
  narrow.value = window.matchMedia("(max-width: 900px)").matches;
}
onMounted(syncNarrow);
window.addEventListener("resize", syncNarrow);
onUnmounted(() => window.removeEventListener("resize", syncNarrow));

/** 推送事实 tooltip：窄屏日期进 tooltip，完整信息仍可查看，不改 pushFact 判定本身。 */
function pushFactTip(row: ArticleListItem): string {
  const f = pushFact(row);
  const date = f.dateRaw ? friendlyTime(f.dateRaw) : "";
  return date ? (f.hint + " · 推送日期 " + date) : f.hint;
}

const batch = useBatchDelete<ArticleListItem>({
  idOf: (row) => row.id,
  api: bulkDeleteArticles,
  tableRef: articleTableRef,
  // 推送口径与后端删除事务一致：用 hasPushTrace（mediaId/pushDate 任一非空）判「已推送」，
  // 不再用 status==='pushed'——后者会把「推送后退回草稿」误判成未推送，导致「角度会归还」的文案误导。
  impact: batchDeleteImpact,
  title: "批量删除文章",
  reload: async (res) => {
    const remain = items.value.length - res.deleted;
    if (remain <= 0 && page.value > 1) {
      setQuery({ page: page.value - 1 });
    } else {
      await load();
    }
  },
});

/**
 * 换筛选条件（不是翻页）时清空勾选。
 * reserve-selection 会让勾选跨数据刷新保留，换筛选后旧勾选指向另一个结果集，留着会删到看不见的文章。
 */
watch([status, angle, pipeline, needs], () => {
  batch.clearSelection();
});

function setQuery(patch: Record<string, string | number | undefined>) {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...route.query, ...patch })) {
    if (v !== undefined && v !== "") query[k] = String(v);
  }
  void router.replace({ query });
}

function goEdit(id: number) {
  void router.push(`/articles/${id}`);
}

/** 打开详情/预览弹窗：详情（含封面、状态）与实时渲染产物并行拉取。 */
function openPreview(row: ArticleListItem) {
  previewDialog.value.id = row.id;
  previewDialog.value.account = row.account;
  previewDialog.value.visible = true;
  void loadPreviewDialog();
}

async function loadPreviewDialog() {
  previewDialog.value.loading = true;
  previewDialog.value.error = "";
  try {
    const [detail, rendered] = await Promise.all([
      getArticle(previewDialog.value.id),
      previewArticle(previewDialog.value.id),
    ]);
    previewDialog.value.detail = detail;
    previewDialog.value.rendered = rendered;
  } catch (e) {
    previewDialog.value.error = errMsg(e, "文章详情加载失败");
  } finally {
    previewDialog.value.loading = false;
  }
}

async function remove(row: ArticleListItem) {
  try {
    await ElMessageBox.confirm(
      `将永久删除「${row.title}」，删除后不可恢复。未推送的文章占用的选题角度会归还角度池。确认删除？`,
      "删除文章",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  deletingId.value = row.id;
  try {
    const res = await deleteArticle(row.id);
    ElMessage.success(
      res.recycledAngle ? "已删除，选题角度已归还角度池" : "已删除",
    );
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "删除失败"));
  } finally {
    deletingId.value = null;
  }
}

async function push(row: ArticleListItem) {
  try {
    await ElMessageBox.confirm(
      `将「${row.title}」推送到公众号草稿箱（不会群发）。确认继续？`,
      "推送确认",
      {
        type: "warning",
        confirmButtonText: "推送草稿箱",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  pushingId.value = row.id;
  try {
    const res = await pushArticle(row.id);
    if (res.ok) {
      ElMessage.success(res.message ?? "已推送到草稿箱");
    } else {
      // 与改稿页共用同一套分类：already_pushed / pushing / lint_failed 不是微信报错，
      // 不能用「无 errcode」当标题误导用户（S5-UI-3-0 · P2-5）。
      // no_account：后端明确 reason，给出真实可执行的账号配置引导（S5-UI-5-P2-4）。
      if (res.reason === "no_account") {
        const guide = noAccountGuide(userRole.value);
        try {
          if (guide.canManage) {
            await ElMessageBox.confirm(guide.message, "尚未配置可用于推送的公众号账号", {
              type: "warning",
              confirmButtonText: "去账号管理",
              cancelButtonText: "稍后",
            });
            await router.push("/accounts");
          } else {
            await ElMessageBox.alert(guide.message, "尚未配置可用于推送的公众号账号", {
              type: "warning",
              confirmButtonText: "知道了",
            });
          }
        } catch { /* 用户选择稍后 */ }
      } else {
        const view = pushFailView(res);
        ElMessageBox.alert(res.message ?? "推送失败", view.title, {
          type: view.type,
          confirmButtonText: "知道了",
        });
      }
    }
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "推送失败"));
  } finally {
    pushingId.value = null;
  }
}

/** 行操作菜单项，供 RowActions 组件渲染。 */
function articleActions(row: ArticleListItem): RowAction[] {
  return [
    { command: "view", label: "详情 / 预览", icon: View },
    { command: "edit", label: "改稿", icon: Edit },
    {
      command: "push",
      label: "推送草稿箱",
      icon: Upload,
      loading: pushingId.value === row.id,
    },
    {
      command: "delete",
      label: "删除",
      icon: Delete,
      type: "danger",
      divided: true,
      loading: deletingId.value === row.id,
    },
  ];
}

function onArticleCommand(cmd: string, row: ArticleListItem) {
  if (cmd === "view") void openPreview(row);
  else if (cmd === "edit") goEdit(row.id);
  else if (cmd === "push") push(row);
  else if (cmd === "delete") void remove(row);
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载文章…">
    <PageHead title="文章" :desc="`共 ${total} 篇 · 改稿后可推送到公众号草稿箱（只进草稿箱，不会群发）`">
      <template #actions>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </template>
    </PageHead>

    <StateError v-if="error" :message="error" @retry="load" />

    <!-- 待办专项筛选说明：从工作台点进来时，必须一眼看出「按什么筛的」以及怎么退出去 -->
    <el-alert
      v-if="needsMeta"
      type="info"
      show-icon
      :closable="false"
      class="needs-alert"
      :title="`当前筛选：${needsMeta.title}`"
    >
      <div class="needs-alert__body">
        <span class="wb-secondary">{{ needsMeta.cond }}</span>
        <span class="wb-muted">专项筛选期间状态下拉暂不可用</span>
        <el-button link type="primary" @click="setQuery({ needs: undefined, page: undefined })">
          清除筛选
        </el-button>
      </div>
    </el-alert>

    <!-- 注意：这里不能用 v-else——上面的提示条把 v-if/v-else 链打断了（踩过：
         v-else 找不到相邻 v-if，整张表被丢弃，页面只剩标题）。用独立条件。 -->
    <el-card v-if="!error" shadow="never">
      <el-form :inline="true" class="wb-filter-bar" @submit.prevent>
        <el-form-item label="状态">
          <el-select
            :model-value="status"
            :disabled="Boolean(needs)"
            :placeholder="needs ? '待办筛选中' : '全部状态'"
            clearable
            style="width: 140px"
            @update:model-value="
              (v: string) => setQuery({ status: v, page: undefined })
            "
          >
            <el-option label="草稿" value="draft" />
            <el-option label="已推送" value="pushed" />
            <el-option label="已更新" value="updated" />
            <el-option label="失败" value="failed" />
          </el-select>
        </el-form-item>
        <!-- 选题下钻过滤器：来自选题库的「关联文章」链接，可关闭还原 -->
        <el-form-item v-if="angle">
          <el-tag
            closable
            effect="plain"
            @close="setQuery({ angle: undefined, page: undefined })"
          >
            选题 #{{ angle }}
          </el-tag>
        </el-form-item>
        <el-form-item label="产线">
          <el-select
            :model-value="pipeline"
            :disabled="Boolean(needs)"
            :placeholder="needs ? '待办筛选中' : '全部产线'"
            clearable
            style="width: 130px"
            @update:model-value="
              (v: string) => setQuery({ pipeline: v, page: undefined })
            "
          >
            <el-option :label="pipelineText('article')" value="article" />
            <el-option :label="pipelineText('comic')" value="comic" />
          </el-select>
        </el-form-item>
      </el-form>

      <!-- 批量操作条：有勾选时才出现 -->
      <BatchBar
        :count="batch.count.value"
        :loading="batch.deleting.value"
        @delete="batch.runBatchDelete()"
        @clear="batch.clearSelection()"
      />

      <el-table
        v-if="items.length"
        ref="articleTableRef"
        :data="items"
        size="default"
        row-key="id"
        @selection-change="batch.onSelectionChange"
      >
        <!-- reserve-selection：翻页后仍保留勾选（配合 row-key） -->
        <el-table-column type="selection" width="46" reserve-selection :fixed="narrow ? 'left' : false" />
        <el-table-column prop="id" label="ID" width="60" class-name="col-optional" />
        <el-table-column label="标题" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="article-title-cell">
              <!-- 产线标识（S5-UI-3-3 · A）：仅漫画显示，普通文章不渲染冗余标签。
                   pipeline 缺失的历史响应按普通文章处理；文案沿用 GET /pipelines 词表。 -->
              <StatusTag
                v-if="row.pipeline === 'comic'"
                kind="pipeline"
                value="comic"
                class="pipeline-tag"
              />
              <el-link
                type="primary"
                :underline="false"
                class="article-title-link"
                @click="openPreview(row)"
                >{{ row.title }}</el-link
              >
            </span>
          </template>
        </el-table-column>
        <el-table-column label="账号" width="110" class-name="col-optional">
          <template #default="{ row }">{{ row.account ?? "—" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <StatusTag kind="article" :value="row.status" />
          </template>
        </el-table-column>
        <!-- 推送事实：与「状态」分开看。事实取 mediaId/pushDate（痕迹），文案再按当前 status 细分，
             避免把「推送后退回草稿」当成没推过（S5-UI-3-0 · P2-1）。
             S5-UI-3-3 · B：窄屏固定在左侧，真实进入可视区且不被 fixed=right 操作列遮挡；
             日期收进 tooltip（pushFactTip），列宽紧凑；桌面端维持原宽度与行内日期。 -->
        <el-table-column
          label="推送事实"
          :width="narrow ? 108 : 132"
          :fixed="narrow ? 'left' : false"
        >
          <template #default="{ row }">
            <el-tooltip
              :content="pushFactTip(row)"
              placement="top"
            >
              <span class="push-fact-cell">
                <el-tag :type="pushFact(row).type" size="small" effect="light">
                  {{ pushFact(row).text }}
                </el-tag>
                <span v-if="!narrow && pushFact(row).dateRaw" class="push-fact-date">
                  {{ friendlyTime(pushFact(row).dateRaw) }}
                </span>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="chars" label="字数" width="76" class-name="col-optional" />
        <el-table-column
          prop="blocks"
          label="段落"
          width="70"
          class-name="col-optional"
        />
        <el-table-column label="创建" width="150" class-name="col-optional">
          <template #default="{ row }">
            <span class="wb-muted">{{ friendlyTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="articleActions(row)"
              @command="(cmd: string) => onArticleCommand(cmd, row)"
            />
          </template>
        </el-table-column>
      </el-table>

      <!-- needs 专项的空 ≠ 没文章：给定向文案 + 一个退出筛选的出口，避免被当成加载失败 -->
      <EmptyState
        v-else-if="!loading && needs === 'draft_unpushed'"
        description="没有未推送草稿"
        hint="所有草稿都已推送过；换过封面被退回草稿的文章会出现在「待重推」里"
        :image-size="64"
      >
        <el-button size="small" @click="setQuery({ needs: undefined, page: undefined })">
          看全部文章
        </el-button>
      </EmptyState>

      <EmptyState
        v-else-if="!loading && needs === 'repush'"
        description="没有待重推文章"
        hint="已推送文章被 AI 改写或换封面后才会进入这里"
        :image-size="64"
      >
        <el-button size="small" @click="setQuery({ needs: undefined, page: undefined })">
          看全部文章
        </el-button>
      </EmptyState>

      <EmptyState
        v-else-if="!loading"
        description="暂无文章，可到「创作计划」立即出稿"
        :image-size="64"
      >
        <el-button type="primary" size="small" @click="router.push('/plan')"
          >去创作计划</el-button
        >
      </EmptyState>

      <div v-if="total > PAGE_SIZE" class="wb-pager">
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

    <!-- 详情 / 预览弹窗：预览内容即推送产物（同一渲染函数） -->
    <el-dialog
      v-model="previewDialog.visible"
      :title="previewDialog.rendered?.title ?? '文章详情'"
      width="min(78%, 92vw)"
      top="6vh"
      destroy-on-close
    >
      <div
        v-loading="previewDialog.loading"
        element-loading-text="正在加载文章详情…"
      >
        <StateError
          v-if="previewDialog.error"
          :message="previewDialog.error"
          @retry="loadPreviewDialog"
        />

        <template v-if="previewDialog.detail && previewDialog.rendered">
          <div class="meta-row">
            <div class="cover-thumb">
              <el-image
                v-if="coverUrl(previewDialog.detail.coverPath)"
                :src="coverUrl(previewDialog.detail.coverPath)"
                fit="cover"
                class="cover-img"
              >
                <template #error
                  ><span class="wb-muted">暂无封面</span></template
                >
              </el-image>
              <span v-else class="wb-muted">暂无封面</span>
            </div>
            <el-descriptions :column="2" border size="small" class="meta-desc">
              <el-descriptions-item label="状态">
                <StatusTag kind="article" :value="previewDialog.detail.status" />
              </el-descriptions-item>
              <el-descriptions-item label="ID">{{
                previewDialog.detail.id
              }}</el-descriptions-item>
              <el-descriptions-item label="账号">{{
                previewDialog.account ?? "未分配账号"
              }}</el-descriptions-item>
              <el-descriptions-item label="创建于">{{
                friendlyTime(previewDialog.detail.createdAt)
              }}</el-descriptions-item>
              <el-descriptions-item label="摘要" :span="2">{{
                previewDialog.rendered.digest
              }}</el-descriptions-item>
              <el-descriptions-item label="小标题">{{
                previewDialog.rendered.h2Count
              }}</el-descriptions-item>
              <el-descriptions-item label="段落">{{
                previewDialog.rendered.pCount
              }}</el-descriptions-item>
              <el-descriptions-item label="字数">{{
                previewDialog.rendered.charCount
              }}</el-descriptions-item>
              <el-descriptions-item label="强调">{{
                previewDialog.rendered.boldCount
              }}</el-descriptions-item>
            </el-descriptions>
          </div>

          <el-alert
            v-for="(w, i) in previewDialog.rendered.warnings"
            :key="`pw-${i}`"
            type="warning"
            :title="w"
            show-icon
            :closable="false"
            class="warn-alert"
          />

          <div
            class="wb-preview preview-box"
            v-html="previewDialog.rendered.contentWechat"
          />
        </template>
      </div>

      <template #footer>
        <el-button @click="previewDialog.visible = false">关闭</el-button>
        <el-button
          v-if="previewDialog.detail"
          type="primary"
          @click="
            previewDialog.visible = false;
            goEdit(previewDialog.detail.id);
          "
        >
          去改稿
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.meta-row {
  display: flex;
  gap: var(--wb-space-3);
  margin-bottom: var(--wb-space-3);
  align-items: flex-start;
}

.cover-thumb {
  width: 168px;
  height: 72px;
  flex: none;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  overflow: hidden;
  background: var(--wb-surface-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.cover-img {
  width: 100%;
  height: 100%;
}

.meta-desc {
  flex: 1;
  min-width: 0;
}

.push-fact-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

/* 产线标识（S5-UI-3-3 · A）：标题列内漫画标签与标题并排，不换行撑高行高。 */
.article-title-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}

.article-title-cell .pipeline-tag {
  flex: none;
}

.article-title-cell .article-title-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.push-fact-date {
  font-size: 12px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}

.warn-alert {
  margin-bottom: var(--wb-space-2);
}

.preview-box {
  max-height: 56vh;
  overflow-y: auto;
}

/* 待办专项筛选说明条：与 TracksView 的 pending-alert 同一套克制风格 */
.needs-alert {
  margin-bottom: var(--wb-space-3);
}

.needs-alert__body {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
}
</style>
