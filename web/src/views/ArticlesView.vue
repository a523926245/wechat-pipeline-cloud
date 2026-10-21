<script setup lang="ts">
import { Delete, Edit, Refresh, Upload, View } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { errMsg } from "../api/http.ts";
import {
  deleteArticle,
  getArticle,
  listArticles,
  previewArticle,
  pushArticle,
} from "../api/index.ts";
import StateError from "../components/StateError.vue";
import RowActions, { type RowAction } from "../components/RowActions.vue";
import type {
  ArticleDetail,
  ArticleListItem,
  ArticleRenderResult,
} from "../types.ts";
import {
  coverUrl,
  friendlyTime,
  pipelineText,
  statusTag,
  statusText,
} from "../utils/format.ts";

const router = useRouter();
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
const page = computed<number>(() => {
  const n = Number(route.query.page ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await listArticles({
      status: status.value || undefined,
      angleId: angle.value || undefined,
      pipeline: pipeline.value || undefined,
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
watch([status, angle, pipeline, page], load);

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
      ElMessageBox.alert(
        res.message ?? "推送失败",
        `推送未成功（${res.errcode ?? "无 errcode"}）`,
        {
          type: "error",
          confirmButtonText: "知道了",
        },
      );
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
    <header class="wb-page-head">
      <div>
        <h2>文章</h2>
        <p class="wb-page-desc">
          共 {{ total }} 篇 · 改稿后可推送到公众号草稿箱
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <el-card v-else shadow="never">
      <el-form :inline="true" class="wb-filter-bar" @submit.prevent>
        <el-form-item label="状态">
          <el-select
            :model-value="status"
            placeholder="全部状态"
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
            placeholder="全部产线"
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

      <el-table v-if="items.length" :data="items" size="default">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="标题" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <el-link
              type="primary"
              :underline="false"
              @click="openPreview(row)"
              >{{ row.title }}</el-link
            >
          </template>
        </el-table-column>
        <el-table-column label="账号" width="110" class-name="col-optional">
          <template #default="{ row }">{{ row.account ?? "—" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{
              statusText(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="chars" label="字数" width="76" />
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

      <el-empty
        v-else-if="!loading"
        description="暂无文章，可到「创作计划」立即出稿"
        :image-size="64"
      >
        <el-button type="primary" size="small" @click="router.push('/plan')"
          >去创作计划</el-button
        >
      </el-empty>

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
                <el-tag
                  :type="statusTag(previewDialog.detail.status)"
                  size="small"
                >
                  {{ statusText(previewDialog.detail.status) }}
                </el-tag>
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

.warn-alert {
  margin-bottom: var(--wb-space-2);
}

.preview-box {
  max-height: 56vh;
  overflow-y: auto;
}
</style>
