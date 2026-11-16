<script setup lang="ts">
/**
 * 选题库：某赛道下选题角度的查看 / 编辑 / 删除 / 手动新增。
 *
 * 定位：这是「赛道管理」的下钻子页面，从赛道列表的「选题池 96/105」点进来。
 * 角度池此前只有聚合计数，看不到正文也无法修正，模型生成得不好的条目只能干瞪眼。
 *
 * 删除语义（与用户确认过）：已使用的选题允许删除，但必须先弹强提示——
 * 文章正文保留，只是解除选题关联，避免用户以为文章会被一起删掉。
 *
 * 角度切片（scope）：决定这条选题归哪条产线消费。
 * 漫画产线只吃 comic / shared，而扩库与手动新增默认都落在 article 切片上——
 * 所以「漫画线可用角度 0」的解法就在这个页面：扩库时选漫画，或把现有选题改成共享/漫画专用。
 */
import {
  Delete,
  Edit,
  Files,
  MagicStick,
  Plus,
  Refresh,
  RefreshLeft,
  Select,
  Share,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { errMsg } from "../api/http.ts";
import {
  bulkDeleteAngles,
  createAngle,
  deleteAngle,
  expandTrackAngles,
  getAngle,
  listAngleReviews,
  listAngles,
  listTracks,
  reassignOffIpAngles,
  releaseAngle,
  rescoreAngle,
  reviewAngle,
  updateAngle,
} from "../api/index.ts";
import BatchBar from "../components/BatchBar.vue";
import StateError from "../components/StateError.vue";
import RowActions, { type RowAction } from "../components/RowActions.vue";
import { useBatchDelete } from "../composables/useBatchDelete.ts";
import type {
  AngleDupHit,
  AngleItem,
  AngleReviewVerdict,
  AngleScopeFilter,
  AngleStatus,
  AngleUsedFilter,
  TopicReviewRecord,
} from "../types.ts";
import { angleScopeText } from "../utils/format.ts";

/** 用途选项：与后端 Angle.scope 一一对应，文案由 /api/pipelines 下发（有兜底）。 */
const SCOPE_OPTIONS: AngleScopeFilter[] = ["article", "comic", "shared"];
/** 审核态选项（D1 四态）。 */
const STATUS_OPTIONS: AngleStatus[] = ["candidate", "needs_revision", "approved", "rejected"];

const router = useRouter();
const route = useRoute();

const items = ref<AngleItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");
const trackName = ref("");
const deletingId = ref<number | null>(null);
const saving = ref(false);

const PAGE_SIZE = 20;

/** 路由已用 (\\d+) 约束，这里再兜一次：NaN 会让后端报「received nan」。 */
const trackId = computed<number>(() => Number(route.params.trackId));
const invalidId = computed(
  () => !Number.isInteger(trackId.value) || trackId.value <= 0,
);

/** 筛选与页码放进 URL：可分享、可返回、刷新不丢失。 */
const used = computed<AngleUsedFilter>(() => {
  const v = route.query.used;
  return v === "unused" || v === "used" ? v : "all";
});
const page = computed<number>(() => {
  const n = Number(route.query.page ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
});
const keyword = computed<string>(() =>
  typeof route.query.keyword === "string" ? route.query.keyword : "",
);
/** 用途筛选（角度切片）。从产线弹窗跳过来时会带 ?scope=comic。 */
const scope = computed<AngleScopeFilter | "all">(() => {
  const v = route.query.scope;
  return v === "article" || v === "comic" || v === "shared" ? v : "all";
});
/** 审核态筛选（S4-1）。 */
const status = computed<AngleStatus | "all">(() => {
  const v = route.query.status;
  return v === "candidate" || v === "needs_revision" || v === "approved" || v === "rejected"
    ? v
    : "all";
});
/** 排序：score=按总分降序（评分影响排序，S4-1）。 */
const sort = computed<"seq" | "score">(() =>
  route.query.sort === "score" ? "score" : "seq",
);
const filtered = computed(
  () =>
    used.value !== "all" ||
    keyword.value !== "" ||
    scope.value !== "all" ||
    status.value !== "all",
);

/** 表单与 URL 解耦：点「搜索/重置」才提交，避免每敲一个字就 replace 一次。 */
const usedInput = ref<string>(used.value);
const keywordInput = ref(keyword.value);
const scopeInput = ref<string>(scope.value);
const statusInput = ref<string>(status.value);
const sortInput = ref<string>(sort.value);

/** URL 被外部改动（返回、分享链接）时同步表单控件。 */
watch([used, keyword, scope, status, sort], () => {
  usedInput.value = used.value;
  keywordInput.value = keyword.value;
  scopeInput.value = scope.value;
  statusInput.value = status.value;
  sortInput.value = sort.value;
});

async function loadTrackName() {
  try {
    const res = await listTracks();
    trackName.value = res.items.find((t) => t.id === trackId.value)?.name ?? "";
  } catch {
    trackName.value = "";
  }
}

async function load() {
  if (invalidId.value) {
    error.value = "赛道参数无效";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const res = await listAngles({
      trackId: trackId.value,
      used: used.value,
      status: status.value,
      scope: scope.value === "all" ? undefined : scope.value,
      keyword: keyword.value || undefined,
      sort: sort.value,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    items.value = res.items;
    total.value = res.total;
  } catch (e) {
    error.value = errMsg(e, "选题列表加载失败");
  } finally {
    loading.value = false;
  }
}

// ── 漫画选题体检：含 IP 外人物（奶奶/老师…）的漫画选题要退回文章专用 ──
// 漫画画面来自固定家庭 IP（爸爸/妈妈/哥哥/弟弟），选题里出现外人时模型只能硬塞成爸妈，
// 于是「标题写奶奶、画面是妈妈、台词对不上」。文章线不受这个限制，所以退回即可。
const offIpComicCount = ref(0);
const reassigning = ref(false);

async function loadOffIpCount() {
  if (invalidId.value) return;
  try {
    const res = await listAngles({
      trackId: trackId.value,
      scope: "comic",
      offIp: true,
      limit: 1,
    });
    offIpComicCount.value = res.total;
  } catch {
    offIpComicCount.value = 0;
  }
}

async function reassignOffIp() {
  if (reassigning.value) return;
  try {
    await ElMessageBox.confirm(
      `把这 ${offIpComicCount.value} 条含「奶奶 / 婆婆 / 老师」等 IP 外人物的选题退回「文章专用」？\n\n` +
        `选题本身不删、正文与占用关系都不变，只是漫画产线不再选到它们（文章线照常可用）。`,
      "退回文章专用",
      { type: "warning", confirmButtonText: "退回", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  reassigning.value = true;
  try {
    const res = await reassignOffIpAngles(trackId.value);
    ElMessage.success(res.message || "已退回文章专用");
    await Promise.all([load(), loadOffIpCount()]);
  } catch (e) {
    ElMessage.error(errMsg(e, "操作失败"));
  } finally {
    reassigning.value = false;
  }
}

onMounted(() => {
  void loadTrackName();
  void load();
  void loadOffIpCount();
});
watch([used, keyword, scope, status, sort, page, trackId], load);

function setQuery(patch: Record<string, string | number | undefined>) {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...route.query, ...patch })) {
    if (v !== undefined && v !== "") query[k] = String(v);
  }
  void router.replace({ query });
}

function applyFilter() {
  keywordInput.value = keywordInput.value.trim();
  setQuery({
    used: usedInput.value === "all" ? undefined : usedInput.value,
    scope: scopeInput.value === "all" ? undefined : scopeInput.value,
    status: statusInput.value === "all" ? undefined : statusInput.value,
    sort: sortInput.value === "seq" ? undefined : sortInput.value,
    keyword: keywordInput.value || undefined,
    page: 1,
  });
}

function resetFilter() {
  usedInput.value = "all";
  keywordInput.value = "";
  scopeInput.value = "all";
  statusInput.value = "all";
  sortInput.value = "seq";
  setQuery({
    used: undefined,
    scope: undefined,
    status: undefined,
    sort: undefined,
    keyword: undefined,
    page: 1,
  });
}

function backToTracks() {
  void router.push("/tracks");
}

/** 查看该选题关联的文章：跳文章页带 angle 过滤参数。 */
function goArticles(row: AngleItem) {
  void router.push({ path: "/articles", query: { angle: String(row.id) } });
}

// ── 新增 / 编辑 ──
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({
  editingId: 0,
  theme: "",
  content: "",
  scope: "article" as AngleScopeFilter,
});

// S4-2 去重拦截：L0/L1 命中 400 时在对话框内展示命中明细（为什么不能保存），不关弹窗。
const dedupError = ref<{ level: string; hits: AngleDupHit[] } | null>(null);

/** 命中明细一行文案：级别 + 内容/标题 + 相似度 + 来源赛道。 */
function dupHitLine(h: AngleDupHit): string {
  const pct = `${Math.round(h.score * 100)}%`;
  const track = h.trackName ? `（赛道：${h.trackName}）` : "";
  const label = h.sourceType === "article" ? "历史文章" : "现有选题";
  return `[${h.level}] ${label}：${h.targetText} · 相似度 ${pct}${track}`;
}

const rules: FormRules = {
  theme: [{ max: 64, message: "主题不能超过 64 字", trigger: "blur" }],
  content: [
    {
      required: true,
      whitespace: true,
      message: "选题内容不能为空",
      trigger: "blur",
    },
    { max: 500, message: "选题内容不能超过 500 字", trigger: "blur" },
  ],
};

function openCreate() {
  form.editingId = 0;
  form.theme = "";
  form.content = "";
  // 新增时默认跟随当前筛选的切片：正在看漫画选题，新增的自然也该是漫画的
  form.scope = scope.value === "all" ? "article" : scope.value;
  dedupError.value = null;
  dialogVisible.value = true;
  void nextTick(() => formRef.value?.clearValidate());
}

function openEdit(row: AngleItem) {
  form.editingId = row.id;
  form.theme = row.theme;
  form.content = row.content;
  form.scope = row.scope ?? "article";
  dedupError.value = null;
  dialogVisible.value = true;
  void nextTick(() => formRef.value?.clearValidate());
}

async function submitForm() {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return; // 校验未通过，停留表单
  }

  const content = form.content.trim();
  saving.value = true;
  dedupError.value = null;
  try {
    if (form.editingId === 0) {
      const res = await createAngle({
        trackId: trackId.value,
        theme: form.theme.trim() || undefined,
        content,
        scope: form.scope,
      });
      ElMessage.success(res.message ?? "选题已新增");
      showDedupWarnings(res.dedupWarnings);
    } else {
      const res = await updateAngle(form.editingId, {
        theme: form.theme.trim(),
        content,
        scope: form.scope,
      });
      ElMessage.success(res.message ?? "已保存");
      showDedupWarnings(res.dedupWarnings);
    }
    dialogVisible.value = false;
    await load();
  } catch (e) {
    // S4-2：L0/L1 命中 → 400 带结构化明细，对话框内展示命中信息，不关弹窗。
    const detail = (e as { detail?: unknown }).detail as
      | { level?: string; hits?: AngleDupHit[] }
      | undefined;
    if (
      detail &&
      (detail.level === "L0" || detail.level === "L1") &&
      Array.isArray(detail.hits) &&
      detail.hits.length > 0
    ) {
      dedupError.value = { level: detail.level, hits: detail.hits };
    }
    ElMessage.error(errMsg(e, "保存失败"));
  } finally {
    saving.value = false;
  }
}

/** L2 历史文章标题相似：允许保存，只提示（展示历史文章标题），不做阻断式错误。 */
function showDedupWarnings(warnings?: AngleDupHit[]) {
  if (!warnings || warnings.length === 0) return;
  const titles = warnings.slice(0, 2).map((h) => h.targetText).join("、");
  const more = warnings.length > 2 ? " 等" : "";
  ElMessage.warning(
    `与 ${warnings.length} 篇历史文章标题相似（仅提示，不影响保存）：${titles}${more}`,
  );
}

// ── AI 扩库 ──
// 入口放在选题库里：「漫画线没角度」的人在赛道页转一圈也找不到扩库按钮在哪，
// 而这里能直接按当前筛选的用途扩，扩完立刻就在列表里看得到。
const expandDialog = reactive({
  visible: false,
  running: false,
  count: 20,
  seed: "",
  scope: "article" as AngleScopeFilter,
});

function openExpand() {
  expandDialog.count = 20;
  expandDialog.seed = "";
  expandDialog.scope = scope.value === "all" ? "article" : scope.value;
  expandDialog.visible = true;
}

async function submitExpand() {
  if (expandDialog.running) return;
  expandDialog.running = true;
  try {
    const res = await expandTrackAngles(
      trackId.value,
      expandDialog.count,
      expandDialog.seed.trim() || undefined,
      expandDialog.scope,
    );
    if (res.added > 0) {
      ElMessage.success(res.message ?? `新增 ${res.added} 条选题`);
      expandDialog.visible = false;
    } else {
      ElMessage.warning(res.message ?? "没有新增，全部与现有选题重复");
    }
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "扩库失败"));
  } finally {
    expandDialog.running = false;
  }
}

// ── 删除 ──
async function remove(row: AngleItem) {
  if (deletingId.value !== null) return;

  // 列表里的 articleCount 可能已过期，删除前重新取一次最新值再做提示
  let fresh: AngleItem;
  try {
    fresh = await getAngle(row.id);
  } catch (e) {
    ElMessage.error(errMsg(e, "读取选题失败"));
    return;
  }

  let text: string;
  if (fresh.articleCount > 0) {
    text =
      `该选题已被 ${fresh.articleCount} 篇文章使用。` +
      `删除后这些文章仅解除选题关联，正文不受影响。确认删除？`;
  } else if (fresh.used) {
    text =
      `该选题已被「${fresh.usedBy || "未知账号"}」占用（${fresh.usedDate ?? "日期未知"}），` +
      `当前没有文章关联它，删除后占用记录一并消失。确认删除？`;
  } else {
    text = `确定删除这条选题？删除后不可恢复。`;
  }

  try {
    await ElMessageBox.confirm(text, "删除选题", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消",
      confirmButtonClass: "el-button--danger",
    });
  } catch {
    return;
  }

  deletingId.value = row.id;
  try {
    const res = await deleteAngle(row.id);
    ElMessage.success(res.message || "已删除");
    // 删掉当前页最后一条时回退一页，否则停在空页
    if (items.value.length === 1 && page.value > 1) {
      setQuery({ page: page.value - 1 });
    } else {
      await load();
    }
  } catch (e) {
    ElMessage.error(errMsg(e, "删除失败"));
  } finally {
    deletingId.value = null;
  }
}

/**
 * 批量删除：与单条删除同一套语义（删除即从池中移除，关联文章只解绑、正文保留）。
 * 提示要说清「有多少条正在被文章用着」——这是删除后不可逆的部分。
 */
const angleTableRef = ref<{ clearSelection: () => void } | null>(null);

const batch = useBatchDelete<AngleItem>({
  idOf: (row) => row.id,
  api: bulkDeleteAngles,
  tableRef: angleTableRef,
  impact: (rows) => {
    const usedCount = rows.filter((r) => r.used).length;
    const linked = rows.reduce((s, r) => s + (r.articleCount ?? 0), 0);
    const parts: string[] = [];
    if (usedCount > 0) {
      parts.push(`其中 ${usedCount} 条已被文章占用，删除后这些选题将从池中消失（不可恢复）。`);
    }
    if (linked > 0) {
      parts.push(
        `关联的 ${linked} 篇文章只会解除选题关联，正文与配图不受影响。`,
      );
    }
    if (parts.length === 0) parts.push("删除后不可恢复。");
    return parts.join("\n");
  },
  title: "批量删除选题",
  reload: async (res) => {
    // 删空当前页时回退一页，否则停在空页
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
 *
 * reserve-selection 会让勾选跨数据刷新保留——翻页时这是想要的（跨页攒一批），
 * 但换筛选后旧勾选指向的是另一个结果集，留着会让用户删到看不见的选题。
 */
watch([used, keyword, scope, status, sort], () => {
  batch.clearSelection();
});

/**
 * 归还孤儿选题：已用但 0 关联文章（典型：已推送的文章被删后按设计不自动归还）。
 * 手动确认后重置回未用池，让该选题可再次被排产选用。
 */
const releasingId = ref<number | null>(null);

async function release(row: AngleItem) {
  if (releasingId.value !== null) return;
  try {
    await ElMessageBox.confirm(
      `该选题标记为已被「${row.usedBy || "未知"}」使用（${row.usedDate ?? "日期未知"}），` +
        `但当前没有任何文章关联它（原文章可能已删除）。\n\n` +
        `归还后它会被排产再次选用；若这篇选题其实已推送过公众号，归还可能导致同题重写。确认归还？`,
      "归还选题池",
      { type: "warning", confirmButtonText: "归还", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  releasingId.value = row.id;
  try {
    const res = await releaseAngle(row.id);
    ElMessage.success(res.message || "已归还选题池");
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "归还失败"));
  } finally {
    releasingId.value = null;
  }
}

/**
 * 快捷改用途（切片）：把这条选题划给另一条产线。
 * 「设为共享」是最常用的一个——文章线攒的选题，改共享后漫画线立刻能吃。
 */
const scopingId = ref<number | null>(null);

async function changeScope(row: AngleItem, next: AngleScopeFilter) {
  if (scopingId.value !== null) return;
  scopingId.value = row.id;
  try {
    await updateAngle(row.id, { scope: next });
    ElMessage.success(`已设为「${angleScopeText(next)}」`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "修改用途失败"));
  } finally {
    scopingId.value = null;
  }
}

/**
 * 人工审核（S4-1）：通过 / 拒绝 / 要求修改。
 * - 评分只做排序与参考，不替代人工审核；approved / rejected 为终态（后端状态机校验）。
 * - 拒绝 / 要求修改时可填原因（可选），留空也允许。
 */
const reviewingId = ref<number | null>(null);

// ── 重新评分（R1）：approved 编辑退回的候选须重评后才能再过审 ──
const rescoringId = ref<number | null>(null);

async function rescore(row: AngleItem) {
  if (rescoringId.value !== null) return;
  rescoringId.value = row.id;
  try {
    const res = await rescoreAngle(row.id);
    if (res.rescored) ElMessage.success(res.message ?? "已重新评分");
    else ElMessage.warning(res.message ?? "重新评分失败，仍需重评后才能审核通过");
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "重新评分失败"));
  } finally {
    rescoringId.value = null;
  }
}

function statusText(s: AngleStatus): string {
  return (
    { candidate: "候选待审", needs_revision: "待修改", approved: "已通过", rejected: "已拒绝" } as const
  )[s];
}

function statusTagType(s: AngleStatus): "info" | "warning" | "success" | "danger" {
  return (
    { candidate: "info", needs_revision: "warning", approved: "success", rejected: "danger" } as const
  )[s];
}

/** 六维标签（与后端 SCORE_DIMENSION_LABELS 同源文案）。 */
const SCORE_LABELS: Array<{ key: string; label: string }> = [
  { key: "fit", label: "定位契合" },
  { key: "scene", label: "具体画面" },
  { key: "conflict", label: "冲突反差" },
  { key: "method", label: "方法落点" },
  { key: "safety", label: "情绪安全" },
  { key: "novelty", label: "差异化" },
];

/** 取单维分数（模板里不做类型断言）。 */
function scoreDim(s: AngleItem["scores"], key: string): number | string {
  if (!s) return "—";
  return (s as unknown as Record<string, number>)[key] ?? "—";
}

async function review(row: AngleItem, verdict: AngleReviewVerdict) {
  if (reviewingId.value !== null) return;
  const label =
    verdict === "approved" ? "通过" : verdict === "rejected" ? "拒绝" : "要求修改";
  let reason = "";
  try {
    if (verdict === "approved") {
      await ElMessageBox.confirm(
        `将选题「${row.theme || row.content.slice(0, 20)}」审核为**通过**。\n通过后它才会被排产消费（used 由排产置）。确认？`,
        "审核通过",
        { type: "info", confirmButtonText: "通过", cancelButtonText: "取消" },
      );
    } else {
      const r = await ElMessageBox.prompt(
        `将选题「${row.theme || row.content.slice(0, 20)}」标为「${label}」。可填写原因（可选，≤500 字）：`,
        verdict === "rejected" ? "审核拒绝" : "要求修改",
        {
          type: "warning",
          confirmButtonText: label,
          cancelButtonText: "取消",
          inputPlaceholder: "原因（可选）",
          inputValidator: (v: string) => v.trim().length <= 500 || "原因不能超过 500 字",
        },
      );
      reason = (r.value ?? "").trim();
    }
  } catch {
    return;
  }
  reviewingId.value = row.id;
  try {
    const res = await reviewAngle(row.id, verdict, reason || undefined);
    ElMessage.success(res.message || `已${label}`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, "审核失败"));
  } finally {
    reviewingId.value = null;
  }
}

// ── 审核记录（一候选多轮全留）──
const reviewDialog = reactive({
  visible: false,
  loading: false,
  theme: "",
  content: "",
  items: [] as TopicReviewRecord[],
});

async function openReviewRecords(row: AngleItem) {
  reviewDialog.visible = true;
  reviewDialog.loading = true;
  reviewDialog.theme = row.theme;
  reviewDialog.content = row.content;
  reviewDialog.items = [];
  try {
    const res = await listAngleReviews(row.id);
    reviewDialog.items = res.items;
  } catch (e) {
    ElMessage.error(errMsg(e, "审核记录加载失败"));
  } finally {
    reviewDialog.loading = false;
  }
}

function reviewVerdictText(v: AngleReviewVerdict): string {
  return v === "approved" ? "通过" : v === "rejected" ? "拒绝" : "要求修改";
}

function angleActions(row: AngleItem): RowAction[] {
  const actions: RowAction[] = [{ command: "edit", label: "编辑", icon: Edit }];
  // R1 待重新评分：approved 编辑退回的候选必须先重评才能过审——把入口放在审核按钮之前
  if (row.rescoreRequired) {
    actions.push({
      command: "rescore",
      label: "重新评分",
      icon: Refresh,
      loading: rescoringId.value === row.id,
    });
  }
  // 审核操作只出现在可流转状态（approved / rejected 是终态，后端也会拒）。
  if (row.status === "candidate" || row.status === "needs_revision") {
    actions.push({
      command: "review:approved",
      label: "审核通过",
      icon: Select,
      loading: reviewingId.value === row.id,
    });
    actions.push({
      command: "review:needs_revision",
      label: "要求修改",
      loading: reviewingId.value === row.id,
    });
    actions.push({
      command: "review:rejected",
      label: "审核拒绝",
      type: "danger",
      loading: reviewingId.value === row.id,
    });
  }
  if (row.reviewRound > 0) {
    actions.push({
      command: "reviews",
      label: "审核记录",
    });
  }
  const cur: AngleScopeFilter = row.scope ?? "article";
  const busy = scopingId.value === row.id;
  if (cur !== "shared") {
    actions.push({
      command: "scope:shared",
      label: "设为共享",
      icon: Share,
      loading: busy,
    });
  }
  if (cur !== "comic") {
    actions.push({
      command: "scope:comic",
      label: "设为漫画专用",
      loading: busy,
    });
  }
  if (cur !== "article") {
    actions.push({
      command: "scope:article",
      label: "设为文章专用",
      loading: busy,
    });
  }
  // 孤儿选题（已用但 0 关联文章）才出现「归还」：仍有文章挂着的删除文章时会自动归还
  if (row.used && row.articleCount === 0) {
    actions.push({
      command: "release",
      label: "归还选题池",
      icon: RefreshLeft,
      loading: releasingId.value === row.id,
    });
  }
  actions.push({
    command: "delete",
    label: "删除",
    icon: Delete,
    type: "danger",
    divided: true,
    loading: deletingId.value === row.id,
  });
  return actions;
}

/** 用途标签配色：共享=主色（两边都能吃），漫画=warning，文章=info。 */
function scopeTagType(s?: string): "success" | "warning" | "info" | "primary" {
  if (s === "shared") return "primary";
  if (s === "comic") return "warning";
  return "info";
}

function scopeTitle(s?: string): string {
  if (s === "shared") return "文章与漫画产线都能消费，先到先得";
  if (s === "comic") return "只有漫画产线消费";
  return "只有文章产线消费";
}

function onAngleCommand(cmd: string, row: AngleItem) {
  if (cmd === "edit") openEdit(row);
  else if (cmd === "rescore") void rescore(row);
  else if (cmd === "release") void release(row);
  else if (cmd === "delete") void remove(row);
  else if (cmd === "reviews") void openReviewRecords(row);
  else if (cmd.startsWith("review:")) {
    void review(row, cmd.slice(7) as AngleReviewVerdict);
  } else if (cmd.startsWith("scope:")) {
    void changeScope(row, cmd.slice(6) as AngleScopeFilter);
  }
}
</script>

<template>
  <div class="wb-page">
    <header class="wb-page-head">
      <div>
        <h2>选题库</h2>
        <p class="wb-page-desc">
          {{ trackName ? `赛道「${trackName}」` : "赛道" }} · 共
          {{ total }} 条{{ scope === "all" ? "" : angleScopeText(scope) }}选题
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button :icon="MagicStick" @click="openExpand"
          >AI 扩充选题</el-button
        >
        <el-button @click="backToTracks">返回赛道</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate"
          >新增选题</el-button
        >
      </div>
    </header>

    <!-- 漫画选题体检：一眼看出有多少条画不出来，并给一键处置 -->
    <el-alert
      v-if="offIpComicCount > 0"
      type="warning"
      show-icon
      :closable="false"
      class="offip-alert"
      title="漫画产线选题体检"
    >
      <span class="wb-secondary">
        有 {{ offIpComicCount }} 条漫画选题含 IP 外人物（奶奶 / 婆婆 /
        老师等）。 漫画画面只由「爸爸 / 妈妈 / 哥哥 /
        弟弟」出演，这类选题会被硬画成爸妈，导致图文不符。
      </span>
      <el-button
        link
        type="primary"
        :loading="reassigning"
        @click="reassignOffIp"
      >
        一键退回文章专用
      </el-button>
    </el-alert>

    <StateError
      v-if="invalidId"
      message="赛道参数无效，请从赛道管理重新进入"
      label="无法加载"
      @retry="backToTracks"
    />
    <StateError
      v-else-if="error"
      :message="error"
      label="选题列表加载失败"
      @retry="load"
    />

    <el-card
      v-else
      shadow="never"
      v-loading="loading"
      element-loading-text="正在加载选题…"
    >
      <el-form :inline="true" class="wb-filter-bar" @submit.prevent>
        <el-form-item label="状态" class="wb-filter-item">
          <el-select
            v-model="usedInput"
            placeholder="全部"
            style="width: 120px"
          >
            <el-option label="全部" value="all" />
            <el-option label="已用" value="used" />
            <el-option label="未用" value="unused" />
          </el-select>
        </el-form-item>
        <el-form-item label="审核" class="wb-filter-item">
          <el-select
            v-model="statusInput"
            placeholder="全部"
            style="width: 130px"
          >
            <el-option label="全部" value="all" />
            <el-option
              v-for="s in STATUS_OPTIONS"
              :key="s"
              :label="statusText(s)"
              :value="s"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="用途" class="wb-filter-item">
          <el-select
            v-model="scopeInput"
            placeholder="全部"
            style="width: 120px"
          >
            <el-option label="全部" value="all" />
            <el-option
              v-for="s in SCOPE_OPTIONS"
              :key="s"
              :label="angleScopeText(s)"
              :value="s"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="排序" class="wb-filter-item">
          <el-select v-model="sortInput" style="width: 130px">
            <el-option label="按序号" value="seq" />
            <el-option label="按评分（高→低）" value="score" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词" class="wb-filter-item">
          <el-input
            v-model="keywordInput"
            style="width: 240px"
            placeholder="搜索选题内容或主题"
            clearable
            @keyup.enter="applyFilter"
          />
        </el-form-item>
        <el-form-item class="wb-filter-item">
          <el-button type="primary" :icon="Files" @click="applyFilter"
            >搜索</el-button
          >
          <el-button :icon="Refresh" @click="resetFilter">重置</el-button>
        </el-form-item>
      </el-form>

      <!-- 批量操作条：有勾选时才出现 -->
      <BatchBar
        :count="batch.count.value"
        :loading="batch.deleting.value"
        @delete="batch.runBatchDelete()"
        @clear="batch.clearSelection()"
      />

      <!-- 宽度约定：数字/状态列固定 width；文本列用 min-width + show-overflow-tooltip——
           min-width 列会按比例分摊表格剩余宽度（自适应撑满），只有挤不下时才出省略号 -->
      <el-table
        v-if="total"
        ref="angleTableRef"
        :data="items"
        size="default"
        row-key="id"
        @selection-change="batch.onSelectionChange"
      >
        <!-- reserve-selection：翻页后仍保留勾选（配合 row-key），
             这样可以「第 1 页勾 5 条 → 第 3 页再勾 5 条 → 一次删 10 条」 -->
        <el-table-column type="selection" width="46" reserve-selection />
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column label="主题" width="110" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ 'wb-muted': !row.theme }">{{
              row.theme || "—"
            }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="content"
          label="选题内容"
          min-width="300"
          show-overflow-tooltip
        />
        <!-- 用途决定这条选题归哪条产线：漫画线只吃「漫画专用/共享」 -->
        <el-table-column label="用途" width="200">
          <template #default="{ row }">
            <el-tag
              :type="scopeTagType(row.scope)"
              size="small"
              :title="scopeTitle(row.scope)"
            >
              {{ angleScopeText(row.scope ?? "article") }}
            </el-tag>
            <el-tag
              v-if="row.offIp"
              type="warning"
              size="small"
              effect="plain"
              class="offip-tag"
              title="含 IP 外人物（奶奶/老师等）：文章线可用，漫画线画不出来"
            >
              IP外
            </el-tag>
          </template>
        </el-table-column>
        <!-- 审核态（S4-1）：candidate/needs_revision/approved/rejected，与消费态（已用/未用）是两个维度 -->
        <el-table-column label="审核" width="150">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusText(row.status) }}
            </el-tag>
            <span
              v-if="row.reviewRound > 0"
              class="wb-muted review-round"
              :title="`已完成 ${row.reviewRound} 轮审核`"
              >R{{ row.reviewRound }}</span
            >
            <!-- S4-2：去重命中提示（L2 历史文章相似为主）——悬停看明细 -->
            <el-popover
              v-if="row.dedupHits && row.dedupHits.length > 0"
              placement="left"
              :width="340"
              trigger="hover"
            >
              <template #reference>
                <el-tag
                  type="warning"
                  size="small"
                  effect="plain"
                  class="dedup-tag"
                  title="保存时与历史文章/现有选题的去重命中（仅提示，不影响保存）"
                  >去重</el-tag
                >
              </template>
              <div class="dedup-pop">
                <div class="wb-muted dedup-pop-title">
                  去重命中（保存时快照；L2 仅提示，不拦截）
                </div>
                <div
                  v-for="(h, i) in row.dedupHits"
                  :key="i"
                  class="dedup-hit-line"
                >
                  {{ dupHitLine(h) }}
                </div>
              </div>
            </el-popover>
          </template>
        </el-table-column>
        <!-- 六维评分（0-5/维，总分=等权合计 0-30）：只做排序与人工参考，无阈值、不自动批准 -->
        <el-table-column label="评分" width="96">
          <template #default="{ row }">
            <el-popover v-if="row.scores" placement="left" :width="230" trigger="hover">
              <template #reference>
                <span
                  class="score-total"
                  :title="`总分 ${row.scoreTotal}/30（六维等权合计）`"
                  >{{ row.scoreTotal }}<span class="wb-muted">/30</span></span
                >
              </template>
              <div class="score-pop">
                <div v-for="d in SCORE_LABELS" :key="d.key" class="score-row">
                  <span>{{ d.label }}</span>
                  <span>{{ scoreDim(row.scores, d.key) }}</span>
                </div>
                <div class="score-row score-sum">
                  <span>总分</span><span>{{ row.scoreTotal }}/30</span>
                </div>
                <div v-if="row.scoreSuggestion" class="wb-muted score-sug">
                  模型建议：{{ row.scoreSuggestion }}（仅供参考，以人工审核为准）
                </div>
              </div>
            </el-popover>
            <span
              v-else
              class="wb-muted"
              :title="row.scoreError || '未评分——不视为高质量，仅可人工审核'"
              >未评分</span
            >
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag :type="row.used ? 'info' : 'success'" size="small">
              {{ row.used ? "已用" : "未用" }}
            </el-tag>
            <span v-if="row.used" class="wb-muted used-by">
              {{ row.usedBy || "未知"
              }}<template v-if="row.usedDate"> · {{ row.usedDate }}</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="关联文章" width="88">
          <template #default="{ row }">
            <!-- 有关联才可点：跳到文章页按该选题过滤 -->
            <el-link
              v-if="row.articleCount > 0"
              type="primary"
              :underline="false"
              title="查看这条选题关联的文章"
              @click="goArticles(row)"
            >
              {{ row.articleCount }}
            </el-link>
            <span v-else class="wb-muted">0</span>
          </template>
        </el-table-column>
        <el-table-column
          label="来源"
          width="110"
          class-name="col-optional"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span :class="{ 'wb-muted': !row.source }">{{
              row.source || "—"
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="angleActions(row)"
              :busy="deletingId === row.id"
              @command="(cmd: string) => onAngleCommand(cmd, row)"
            />
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-else
        :description="
          filtered
            ? '当前筛选没有匹配的选题'
            : '这个赛道还没有选题，可点「新增选题」手动添加'
        "
        :image-size="60"
      >
        <!-- 空态给出路：没选题给「新增」，筛不出来给「重置筛选」 -->
        <el-button
          v-if="filtered"
          :icon="Refresh"
          size="small"
          @click="resetFilter"
          >重置筛选</el-button
        >
        <template v-else>
          <el-button
            type="primary"
            :icon="MagicStick"
            size="small"
            @click="openExpand"
            >AI 扩充选题</el-button
          >
          <el-button :icon="Plus" size="small" @click="openCreate"
            >新增选题</el-button
          >
        </template>
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

    <el-dialog
      v-model="dialogVisible"
      :title="form.editingId === 0 ? '新增选题' : '编辑选题'"
      width="min(560px, 92vw)"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="72px">
        <el-form-item label="主题" prop="theme">
          <el-input
            v-model="form.theme"
            maxlength="64"
            placeholder="2~6 字主题词，可留空自动取首句"
          />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="一条 20~60 字的选题，有具体画面感，暗含冲突或反差"
          />
        </el-form-item>
        <el-form-item label="用途">
          <el-radio-group v-model="form.scope">
            <el-radio
              v-for="s in SCOPE_OPTIONS"
              :key="s"
              :value="s"
              :title="scopeTitle(s)"
            >
              {{ angleScopeText(s) }}
            </el-radio>
          </el-radio-group>
          <div class="wb-muted scope-hint">
            漫画产线只吃「漫画专用 /
            共享」；想让漫画线用上这批选题，选这两项之一。
          </div>
        </el-form-item>
      </el-form>
      <!-- S4-2：L0/L1 重复拦截——展示命中选题、相似度与来源赛道，说明为什么不能保存 -->
      <el-alert
        v-if="dedupError"
        type="error"
        show-icon
        :closable="false"
        class="dedup-alert"
      >
        <template #title>
          {{ dedupError.level === "L0" ? "与现有选题完全重复（L0）" : "与现有选题高度相似（L1）" }}，不能保存
        </template>
        <div v-for="(h, i) in dedupError.hits" :key="i" class="dedup-hit-line">
          {{ dupHitLine(h) }}
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitForm"
          >保存</el-button
        >
      </template>
    </el-dialog>

    <!-- AI 扩充选题：按用途（切片）生成，漫画产线要选「漫画 / 共享」才吃得到 -->
    <el-dialog
      v-model="expandDialog.visible"
      :title="`AI 扩充选题 · ${trackName || '本赛道'}`"
      width="min(560px, 92vw)"
    >
      <el-form label-width="96px" @submit.prevent>
        <el-form-item label="用途">
          <el-radio-group v-model="expandDialog.scope">
            <el-radio
              v-for="s in SCOPE_OPTIONS"
              :key="s"
              :value="s"
              :title="scopeTitle(s)"
            >
              {{ angleScopeText(s) }}
            </el-radio>
          </el-radio-group>
          <div class="wb-muted scope-hint">
            漫画产线只吃「漫画专用 / 共享」；给漫画线补选题就选这两项之一。
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
            placeholder="可选。例如：聚焦「奶奶追着喂饭」这类一眼能画出来的场景"
          />
        </el-form-item>
      </el-form>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="用「模型配置」里绑定到「扩角度(expand_angles)」角色的模型生成，与现有选题归一化去重后进入「候选」。生成后自动做六维评分（复用「写作」角色模型，失败=未评分），并需人工审核通过（approved）后才会被排产消费。"
      />

      <template #footer>
        <el-button @click="expandDialog.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="expandDialog.running"
          @click="submitExpand"
          >开始生成</el-button
        >
      </template>
    </el-dialog>

    <!-- 审核记录：一候选多轮全留（回答「修改后重审如何追踪」） -->
    <el-dialog
      v-model="reviewDialog.visible"
      :title="`审核记录 · ${reviewDialog.theme || reviewDialog.content.slice(0, 20)}`"
      width="min(640px, 92vw)"
    >
      <div v-loading="reviewDialog.loading">
        <p class="wb-muted review-head">
          {{ reviewDialog.content }}
        </p>
        <el-empty
          v-if="!reviewDialog.loading && reviewDialog.items.length === 0"
          description="还没有审核记录"
          :image-size="48"
        />
        <div
          v-for="r in reviewDialog.items"
          :key="r.id"
          class="review-row"
        >
          <div class="review-row-head">
            <el-tag :type="statusTagType(r.verdict)" size="small">
              {{ reviewVerdictText(r.verdict) }}
            </el-tag>
            <span class="wb-muted"
              >第 {{ r.round }} 轮 · {{ r.createdAt.slice(0, 19).replace("T", " ")
              }}<template v-if="r.reviewedBy"> · {{ r.reviewedBy }}</template></span
            >
            <span v-if="r.scores" class="wb-muted"
              >评分 {{ r.scores.total }}/30</span
            >
            <span v-else class="wb-muted">未评分</span>
          </div>
          <div v-if="r.reason" class="review-reason">{{ r.reason }}</div>
          <!-- S4-2：审核时刻的去重命中快照（TopicReview.dupHits，历史记录不随后续重判改写） -->
          <div v-if="r.dupHits && r.dupHits.length > 0" class="review-duphits">
            <div class="wb-muted">去重命中快照：</div>
            <div v-for="(h, i) in r.dupHits" :key="i" class="dedup-hit-line">
              {{ dupHitLine(h) }}
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="reviewDialog.visible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.used-by {
  margin-left: var(--wb-space-1);
  font-size: 12px;
}

/* 六维评分（S4-1） */
.score-total {
  cursor: default;
  font-weight: 600;
}

.score-pop .score-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  line-height: 1.9;
}

.score-pop .score-sum {
  border-top: 1px solid var(--el-border-color-lighter);
  margin-top: 4px;
  padding-top: 4px;
  font-weight: 600;
}

.score-pop .score-sug {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
}

.review-round {
  margin-left: 4px;
  font-size: 11px;
}

/* 审核记录弹窗 */
.review-head {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}

.review-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.review-row:last-child {
  border-bottom: none;
}

.review-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.review-reason {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.scope-hint {
  font-size: 12px;
  line-height: 1.5;
  margin-top: var(--wb-space-1);
}

.offip-alert {
  margin-bottom: var(--wb-space-3);
}

.offip-tag {
  margin-left: var(--wb-space-1);
}

/* S4-2 去重命中展示 */
.dedup-alert {
  margin-top: var(--wb-space-2);
}

.dedup-tag {
  margin-left: 4px;
}

.dedup-pop-title {
  margin-bottom: 4px;
  font-size: 12px;
}

.dedup-hit-line {
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.review-duphits {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}
</style>
