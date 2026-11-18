<script setup lang="ts">
import { ArrowDown, CopyDocument, DataAnalysis, Document, InfoFilled, Refresh, Right, User, WarningFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { getDashboard } from '../api/index.ts';
import EmptyState from '../components/EmptyState.vue';
import PageHead from '../components/PageHead.vue';
import StateError from '../components/StateError.vue';
import StatusTag from '../components/StatusTag.vue';
import TaskProgress from '../components/TaskProgress.vue';
import type { DashboardData, TodoArticleReason, TodoRunItem } from '../types.ts';
import { friendlyTime, pipelineTagType, pipelineText } from '../utils/format.ts';
import { anglesQuery, anglesTopTarget, articlesNeedsQuery } from '../utils/todo-nav.ts';

const router = useRouter();

const data = ref<DashboardData | null>(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await getDashboard();
  } catch (e) {
    error.value = errMsg(e, '仪表盘加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const angleUsage = computed(() => Math.round((data.value?.counts.angles.usageRate ?? 0) * 100));

const quotaPct = computed(() => {
  const t = data.value?.today;
  if (!t || t.quotaTotal === 0) return 0;
  return Math.min(100, Math.round((t.produced / t.quotaTotal) * 100));
});

function pctOf(produced: number, quota: number): number {
  if (!quota) return 0;
  return Math.min(100, Math.round((produced / quota) * 100));
}

/** 按产线汇总（后端 groupByPipeline）。单产线时不重复展示，避免和总进度打架。 */
const pipelineRows = computed(() => data.value?.today.byPipeline ?? []);
const multiPipeline = computed(() => pipelineRows.value.length > 1);

/** 待处理浮窗展开态（默认展开做提醒，可收起成胶囊）。 */
const todoOpen = ref(true);

/** 告警与降级收拢成浮窗的行列表。 */
const alertRows = computed(() => {
  const d = data.value;
  if (!d) return [];
  const rows: Array<{ type: 'warning' | 'info'; text: string }> = [];
  for (const w of d.warnings ?? []) rows.push({ type: 'warning', text: w });
  if (d.degraded?.length) {
    rows.push({ type: 'info', text: `部分模块数据降级（其余区块正常）：${d.degraded.join('、')}` });
  }
  return rows;
});

/** 概览指标（hero 卡右三分栏，与出稿进度同卡 = 单一视觉焦点）。 */
const metricCards = computed(() => {
  const c = data.value?.counts;
  if (!c) return [];
  return [
    {
      label: '格式合规账号',
      value: c.accounts.ready,
      unit: `/ ${c.accounts.total}`,
      hint: `启用 ${c.accounts.enabled} · 赛道 ${c.tracks}`,
      icon: User,
    },
    {
      label: '未用角度',
      value: c.angles.unused,
      unit: '',
      hint: `总 ${c.angles.total} · 已用 ${c.angles.used}（${angleUsage.value}%）`,
      icon: DataAnalysis,
    },
    {
      label: '文章存量',
      value: c.articles.total,
      unit: '',
      hint: `草稿 ${c.articles.draft} · 已推 ${c.articles.pushed} · 失败 ${c.articles.failed}`,
      icon: Document,
    },
  ];
});

/* ══════════════════════════════════════════════════════════════════════
   待办队列（S5-UI-2）
   - 数字全部来自 /api/dashboard 的 todos 块，前端零推算、零假数据。
   - `number | null`：0=确实没有；null=该块查询失败 → 显示「统计暂不可用」，绝不显示 0。
   - member 拿到 angles=null 属正常权限（不进 degraded），整行不渲染。
   ══════════════════════════════════════════════════════════════════════ */

const todos = computed(() => data.value?.todos ?? null);
const todoDegraded = computed(() => new Set(todos.value?.degraded ?? []));

/** 选题块只对 admin 出现；member 没有选题入口，不该看到全站待审数量。 */
const showAnglesRow = computed(() => todos.value?.scope === 'all');
const anglesBlock = computed(() => todos.value?.angles ?? null);
/**
 * 选题块「有数字」= total 不是 null。
 * 注意：降级时后端返回的是「字段全为 null 的对象」（member 才是真 null），
 * 所以不能只判 `anglesBlock` 是否存在——那会把「统计暂不可用」渲染成一句空话。
 */
const anglesUsable = computed(() => (anglesBlock.value?.total ?? null) !== null);
const anglesUnavailable = computed(() => showAnglesRow.value && !anglesUsable.value);

const articlesBlock = computed(() => todos.value?.articles ?? null);
const articlesUnavailable = computed(() => articlesBlock.value?.draftUnpushed == null);

const lintBlock = computed(() => todos.value?.lint ?? null);
const lintUnavailable = computed(() => lintBlock.value?.failed == null);

const runsBlock = computed(() => todos.value?.runs ?? null);
const runsUnavailable = computed(() => runsBlock.value?.unresolved == null);

/** 赛道分布：只取前三个赛道，避免一行塞满。 */
const angleTrackText = computed(() =>
  (anglesBlock.value?.byTrack ?? [])
    .slice(0, 3)
    .map((t) => `${t.track} ${t.candidate + t.needsRevision}`)
    .join(' · '),
);

/**
 * 是否「确实没有待办」：所有**可见块**都取到了数据且全为 0。
 * 有任何一块降级就不算空——那种情况要显示「统计暂不可用」，不能伪装成空。
 */
const todoClear = computed(() => {
  const t = todos.value;
  if (!t) return false;
  if (todoDegraded.value.size > 0) return false;
  if (t.angles && (t.angles.total ?? 0) > 0) return false;
  const a = t.articles;
  const articleSum =
    (a.draftUnpushed ?? 0) + (a.repush ?? 0) + (a.pushFailed ?? 0) + (a.comicDraft ?? 0);
  if (articleSum > 0) return false;
  if ((t.lint.failed ?? 0) > 0) return false;
  if ((t.runs.unresolved ?? 0) > 0) return false;
  return true;
});

const ARTICLE_REASON_TEXT: Record<TodoArticleReason, string> = {
  draft_unpushed: '未推送',
  repush: '待重推',
  push_failed: '推送失败',
};

const JOB_TYPE_TEXT: Record<string, string> = {
  write: '写稿',
  comic_script: '漫画脚本',
  comic_panel: '漫画面板',
};

function articleReasonText(reason: TodoArticleReason): string {
  return ARTICLE_REASON_TEXT[reason] ?? reason;
}

function jobTypeText(jobType: string): string {
  return JOB_TYPE_TEXT[jobType] ?? jobType;
}

/**
 * 选题库支持 status / used / scope 三个 URL 筛选（见 TrackAnglesView）。
 * `status` 为空表示「不筛审核态」——明细行永远传该条记录自己的真实 status。
 */
function goAngles(trackId?: number, status?: string | null) {
  if (!trackId) {
    void router.push('/tracks');
    return;
  }
  void router.push({
    path: `/tracks/${trackId}/angles`,
    query: anglesQuery(status),
  });
}

/**
 * 有多个赛道待审时，一键入口只能落到赛道列表——跨赛道选题页当前不存在。
 * 单赛道时必须按该赛道真实分布选初始审核态：只有待改题的赛道若仍按 candidate 跳，
 * 会落到「共 0 条选题」（S5-UI-2-C 审计 P0）。
 */
function goAnglesTop() {
  const target = anglesTopTarget(anglesBlock.value?.byTrack ?? []);
  void router.push(target);
}

/**
 * 文章列表只支持单 status + pipeline 筛选。
 * 「待重推」是复合条件（updated 或 draft+推送痕迹），列表无法精确表达 → 跳全列表，
 * 不假装已经筛选出完整集合；其余三类按各自 status 跳，属已知超集/精确集。
 */
/**
 * 文章待办跳转（S5-UI-2-D-2）：
 * - 未推送草稿 / 待重推 → `needs=`，由服务端精确筛选（total 与卡片数字同源同条件）。
 * - 推送失败 / 漫画 / 去文章 → 维持原有 status / pipeline 参数，行为不变。
 */
function goArticles(kind: 'all' | 'draft' | 'repush' | 'failed' | 'comic') {
  const query = articlesNeedsQuery(kind === 'draft' ? 'draft_unpushed' : kind);
  void router.push(Object.keys(query).length > 0 ? { path: '/articles', query } : { path: '/articles' });
}

function goArticle(id: number) {
  void router.push(`/articles/${id}`);
}

/* ── 执行异常详情抽屉（S5-UI-2-D-3-B）──────────────────────────────────
   失败原因本来就在 todos.runs.recent 里（errorMessage），卡片上也是同一份数据。
   所以点击明细改成**就地展开**：不跳页、不二次请求，理由是「跳走会离开唯一的
   信息来源」。抽屉只读当前选中的 TodoRunItem，关掉就回到原位置。 */
const runDrawer = ref(false);
const currentRun = ref<TodoRunItem | null>(null);

function openRun(row: TodoRunItem): void {
  currentRun.value = row;
  runDrawer.value = true;
}

/** 原文，不做 trim / 改写——复制出去的必须与库里的 errorMessage 完全一致。 */
const runReasonRaw = computed(() => currentRun.value?.errorMessage ?? '');
const runReasonEmpty = computed(() => runReasonRaw.value.trim() === '');
const runIsComicPanel = computed(() => currentRun.value?.jobType === 'comic_panel');
/** write / comic_script 的摘要在写入时被 slice(0, 900)；没到上限不代表内容完整，只提示已知上限。 */
const runReasonTruncated = computed(() => runReasonRaw.value.length >= 900);

async function copyRunReason(): Promise<void> {
  const text = runReasonRaw.value;
  if (text.trim() === '') return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    ElMessage.success('失败原因已复制');
  } catch {
    // 不假装成功：直接告诉用户手动选中复制
    ElMessage.error('复制失败（浏览器未授予剪贴板权限），请手动选中文本复制');
  }
}

/** 有 articleId（comic_panel）→ 去文章看分镜；批次任务没有文章 → 去创作计划（不承诺能定位这条失败）。 */
function goRunArticle(): void {
  const id = currentRun.value?.articleId;
  if (id == null) return;
  runDrawer.value = false;
  void router.push(`/articles/${id}`);
}

function goRunPlan(): void {
  runDrawer.value = false;
  void router.push('/plan');
}

/** 明细最多 3 条，unresolved 可能更多——差额如实提示，不推测。 */
const runsHiddenCount = computed(() => {
  const b = runsBlock.value;
  if (!b) return 0;
  return Math.max(0, (b.unresolved ?? 0) - b.recent.length);
});
</script>

<template>
  <div class="wb-page dash" v-loading="loading" element-loading-text="正在汇总系统状态…">
    <PageHead title="仪表盘" desc="今天的产出进度与角度库存（系统状态在右上角「系统状态」里）">
      <template #actions>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </template>
    </PageHead>

    <StateError v-if="error" :message="error" @retry="load" />

    <template v-if="data">
      <!-- Hero：出稿进度 + 概览指标同卡（单一视觉焦点，不碎成小卡） -->
      <el-card shadow="never" class="hero-card">
        <div class="hero">
          <div class="hero-progress">
            <el-progress type="dashboard" :percentage="quotaPct" :width="112" :stroke-width="8">
              <template #default>
                <div class="ring-inner">
                  <strong class="wb-num">{{ data.today.produced }}</strong>
                  <span class="wb-muted">/ {{ data.today.quotaTotal }} 篇</span>
                </div>
              </template>
            </el-progress>

            <div class="hero-body">
              <h3>今日出稿进度</h3>
              <p class="wb-secondary">
                <template v-if="data.today.pending > 0">
                  还差 <strong class="wb-num">{{ data.today.pending }}</strong> 篇达到今日配额，
                  可去创作计划立即出稿。
                </template>
                <template v-else>今日配额已完成，无需补稿。</template>
              </p>
              <!-- 多产线时按产线拆开看：一条线欠账、另一条线完成，总进度会把它抹平 -->
              <div v-if="multiPipeline" class="pipeline-chips">
                <span v-for="p in pipelineRows" :key="p.pipeline" class="pipeline-chip">
                  <el-tag :type="pipelineTagType(p.pipeline)" size="small">{{ pipelineText(p.pipeline) }}</el-tag>
                  <span class="wb-num">{{ p.produced }}/{{ p.quota }}</span>
                  <span class="wb-muted">· {{ p.accounts }} 个账号</span>
                  <el-tag v-if="p.pending > 0" type="warning" size="small" effect="plain">待补 {{ p.pending }}</el-tag>
                  <el-tag v-else type="success" size="small" effect="plain">已完成</el-tag>
                </span>
              </div>
              <el-button
                v-if="data.today.pending > 0"
                type="primary"
                size="small"
                class="hero-cta"
                @click="router.push('/plan')"
              >
                去出稿
                <el-icon class="el-icon--right"><Right /></el-icon>
              </el-button>
            </div>
          </div>

          <div class="hero-metrics">
            <div v-for="card in metricCards" :key="card.label" class="metric">
              <div class="metric-head">
                <span class="metric-icon">
                  <el-icon><component :is="card.icon" /></el-icon>
                </span>
                <span class="metric-label">{{ card.label }}</span>
              </div>
              <div class="metric-value wb-num">
                {{ card.value }}<span v-if="card.unit" class="metric-unit">{{ card.unit }}</span>
              </div>
              <div class="wb-muted metric-hint">{{ card.hint }}</div>
            </div>
          </div>
        </div>
      </el-card>

      <!-- 未排产账号：条件出现，压成一条横排窄条（不占整卡） -->
      <div v-if="data.skipped.length" class="skipped-strip">
        <el-icon class="inline-icon"><WarningFilled /></el-icon>
        <span class="skipped-strip__label">未排产</span>
        <span v-for="s in data.skipped" :key="s.account" class="skipped-chip" :title="s.reason">
          {{ s.account }}
          <span class="wb-muted">· {{ s.reason }}</span>
        </span>
      </div>

      <!-- 待办队列（S5-UI-2）：只聚合真实业务事实。数量为「—」= 该块统计失败，不代表 0 -->
      <el-card v-if="todos" shadow="never" class="todo-card">
        <template #header>
          <div class="todo-head">
            <span class="todo-head__title">待办</span>
            <span class="wb-muted">打开系统先看这里 · 数字取自当前库，取不到的显式标注</span>
          </div>
        </template>

        <EmptyState
          v-if="todoClear"
          description="暂无待办"
          hint="待审核题、未推草稿、体检失败、执行异常都会出现在这里"
          :image-size="52"
        >
          <el-button size="small" type="primary" @click="router.push('/plan')">去创作计划</el-button>
        </EmptyState>

        <div v-else class="todo-rows">
          <!-- 1. 待审核选题（仅 admin 视野） -->
          <section v-if="showAnglesRow" class="todo-row">
            <div class="todo-row__head">
              <span class="todo-row__label">待审核选题</span>
              <template v-if="anglesUsable && anglesBlock">
                <span class="todo-num wb-num">{{ anglesBlock.total }}</span>
                <span class="todo-sub">候选 {{ anglesBlock.candidate }} · 待改 {{ anglesBlock.needsRevision }}</span>
                <span v-if="angleTrackText" class="todo-sub">{{ angleTrackText }}</span>
                <span v-if="anglesBlock.oldestWaitingDays" class="todo-sub">等最久 {{ anglesBlock.oldestWaitingDays }} 天</span>
              </template>
              <el-tag v-else-if="anglesUnavailable" type="info" size="small" effect="plain">统计暂不可用</el-tag>
              <span class="todo-spacer" />
              <el-button
                v-if="anglesUsable && (anglesBlock?.total ?? 0) > 0"
                link
                type="primary"
                size="small"
                @click="goAnglesTop()"
              >
                去审核
              </el-button>
            </div>
            <ul v-if="anglesBlock?.recent.length" class="todo-detail">
              <li v-for="a in anglesBlock.recent" :key="`angle-${a.id}`">
                <button type="button" class="todo-detail__btn" @click="goAngles(a.trackId, a.status)">
                  <span class="todo-detail__text">{{ a.content }}</span>
                  <span class="todo-detail__meta">{{ a.track }}</span>
                  <StatusTag kind="angle" :value="a.status" />
                  <span v-if="a.scoreTotal !== null" class="wb-num todo-detail__meta">{{ a.scoreTotal }}/30</span>
                </button>
              </li>
            </ul>
          </section>

          <!-- 2. 文章三类 + 漫画单列（不合并成「待处理 N 篇」） -->
          <section class="todo-row">
            <div class="todo-row__head">
              <span class="todo-row__label">文章待处理</span>
              <template v-if="!articlesUnavailable && articlesBlock">
                <button type="button" class="todo-metric" @click="goArticles('draft')">
                  <span class="todo-num wb-num">{{ articlesBlock.draftUnpushed }}</span>
                  <span class="todo-sub">未推送草稿</span>
                </button>
                <button type="button" class="todo-metric" @click="goArticles('repush')">
                  <span class="todo-num wb-num">{{ articlesBlock.repush }}</span>
                  <span class="todo-sub">待重推</span>
                </button>
                <button type="button" class="todo-metric" @click="goArticles('failed')">
                  <span class="todo-num wb-num" :class="{ 'todo-num--bad': (articlesBlock.pushFailed ?? 0) > 0 }">
                    {{ articlesBlock.pushFailed }}
                  </span>
                  <span class="todo-sub">推送失败</span>
                </button>
                <button
                  v-if="(articlesBlock.comicDraft ?? 0) > 0"
                  type="button"
                  class="todo-metric"
                  @click="goArticles('comic')"
                >
                  <span class="todo-num wb-num">{{ articlesBlock.comicDraft }}</span>
                  <span class="todo-sub">漫画草稿</span>
                </button>
              </template>
              <el-tag v-else type="info" size="small" effect="plain">统计暂不可用</el-tag>
              <span class="todo-spacer" />
              <el-button link type="primary" size="small" @click="goArticles('all')">去文章</el-button>
            </div>
            <ul v-if="articlesBlock?.recent.length" class="todo-detail">
              <li v-for="a in articlesBlock.recent" :key="`art-${a.id}`">
                <button type="button" class="todo-detail__btn" @click="goArticle(a.id)">
                  <span class="todo-detail__text">{{ a.title }}</span>
                  <span class="todo-detail__meta">{{ articleReasonText(a.reason) }}</span>
                  <span v-if="a.account" class="todo-detail__meta">{{ a.account }}</span>
                </button>
              </li>
            </ul>
          </section>

          <!-- 3. 文章体检：只算「最新一次 + 与当前正文一致」的失败 -->
          <section class="todo-row">
            <div class="todo-row__head">
              <span class="todo-row__label">文章体检</span>
              <template v-if="!lintUnavailable">
                <span class="todo-num wb-num" :class="{ 'todo-num--bad': (lintBlock?.failed ?? 0) > 0 }">
                  {{ lintBlock?.failed }}
                </span>
                <span class="todo-sub">最新一次体检不通过（记录早于当前正文的不计入）</span>
              </template>
              <el-tag v-else type="info" size="small" effect="plain">统计暂不可用</el-tag>
              <span class="todo-spacer" />
              <el-button
                v-if="(lintBlock?.failed ?? 0) > 0"
                link
                type="primary"
                size="small"
                @click="router.push('/articles')"
              >
                去文章
              </el-button>
            </div>
            <ul v-if="lintBlock?.recent.length" class="todo-detail">
              <li v-for="l in lintBlock.recent" :key="`lint-${l.articleId}`">
                <button type="button" class="todo-detail__btn" @click="goArticle(l.articleId)">
                  <span class="todo-detail__text">{{ l.title }}</span>
                  <span class="todo-detail__bad">{{ l.errorCount }} 个 error</span>
                  <span class="todo-detail__meta">{{ l.warnCount }} warn</span>
                  <span class="todo-detail__meta">{{ friendlyTime(l.checkedAt) }}</span>
                </button>
              </li>
            </ul>
          </section>

          <!-- 4. 任务执行异常：批次按「次」统计，不按篇 -->
          <section class="todo-row todo-row--last">
            <div class="todo-row__head">
              <span class="todo-row__label">执行异常</span>
              <template v-if="!runsUnavailable">
                <span class="todo-num wb-num" :class="{ 'todo-num--bad': (runsBlock?.unresolved ?? 0) > 0 }">
                  {{ runsBlock?.unresolved }}
                  <span class="todo-unit">次</span>
                </span>
                <span class="todo-sub">
                  近 {{ runsBlock?.windowDays }} 天未恢复的失败（写稿 / 漫画脚本 / 漫画面板）
                </span>
              </template>
              <el-tag v-else type="info" size="small" effect="plain">统计暂不可用</el-tag>
              <span class="todo-spacer" />
              <el-button
                v-if="(runsBlock?.unresolved ?? 0) > 0"
                link
                type="primary"
                size="small"
                @click="router.push('/plan')"
              >
                去创作计划
              </el-button>
            </div>
            <ul v-if="runsBlock?.recent.length" class="todo-detail">
              <li v-for="r in runsBlock.recent" :key="`run-${r.id}`">
                <button
                  type="button"
                  class="todo-detail__btn"
                  :title="r.errorMessage || '查看执行异常详情'"
                  @click="openRun(r)"
                >
                  <span class="todo-detail__text">{{ jobTypeText(r.jobType) }}</span>
                  <span v-if="r.account" class="todo-detail__meta">{{ r.account }}</span>
                  <span class="todo-detail__bad">{{ r.errorCode || '失败' }}</span>
                  <span class="todo-detail__meta todo-detail__msg">{{ r.errorMessage }}</span>
                  <span class="todo-detail__meta">{{ friendlyTime(r.createdAt) }}</span>
                </button>
              </li>
            </ul>
            <!-- 数字（组数）可能大于明细条数：只补一句差额，不推测、不额外请求 -->
            <p v-if="runsHiddenCount > 0" class="todo-note">
              当前仅展示最近 {{ runsBlock?.recent.length }} 条异常，另有 {{ runsHiddenCount }} 条未在此处展开。
            </p>
          </section>
        </div>
      </el-card>

      <!-- 明细区：今日配额 + 最近动态 并排（一屏） -->
      <el-row :gutter="12" class="tables-row">
        <el-col :xs="24" :md="13">
          <el-card shadow="never" class="table-card">
            <template #header>今日配额（各账号 · 各产线）</template>
            <el-table
              v-if="data.today.byAccount.length"
              :data="data.today.byAccount"
              size="small"
              max-height="272"
            >
              <el-table-column prop="account" label="账号" min-width="112" />
              <el-table-column prop="track" label="赛道" min-width="88" class-name="col-optional" />
              <el-table-column v-if="multiPipeline" label="产线" width="82">
                <template #default="{ row }">
                  <el-tag :type="pipelineTagType(row.pipeline)" size="small">
                    {{ pipelineText(row.pipeline) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="quota" label="配额" width="58" />
              <el-table-column prop="produced" label="已出" width="58" />
              <el-table-column label="待补" width="64">
                <template #default="{ row }">
                  <el-tag :type="row.pending > 0 ? 'warning' : 'success'" size="small">{{ row.pending }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="angleStock" label="可用角度" width="84" class-name="col-optional" />
              <el-table-column label="进度" min-width="110">
                <template #default="{ row }">
                  <el-progress :percentage="pctOf(row.produced, row.quota)" :stroke-width="7" />
                </template>
              </el-table-column>
            </el-table>
            <EmptyState v-else description="暂无可排产账号（需凭据格式合规且启用）" :image-size="48" />
          </el-card>
        </el-col>

        <el-col :xs="24" :md="11">
          <el-card shadow="never" class="table-card">
            <template #header>最近动态</template>
            <el-tabs class="activity-tabs">
              <el-tab-pane label="任务流水">
                <el-table v-if="data.recentRuns.length" :data="data.recentRuns" size="small" max-height="238">
                  <el-table-column prop="id" label="ID" width="50" />
                  <el-table-column prop="jobType" label="类型" width="84" />
                  <el-table-column label="状态" width="92">
                    <template #default="{ row }">
                      <TaskProgress :status="row.status" />
                    </template>
                  </el-table-column>
                  <el-table-column prop="trigger" label="触发" width="72" class-name="col-optional" />
                  <el-table-column prop="runDate" label="日期" width="96" class-name="col-optional" />
                  <el-table-column prop="errorMessage" label="错误" min-width="120" show-overflow-tooltip />
                </el-table>
                <EmptyState v-else description="暂无任务流水" :image-size="48" />
              </el-tab-pane>

              <el-tab-pane label="最近文章">
                <el-table v-if="data.recentArticles.length" :data="data.recentArticles" size="small" max-height="238">
                  <el-table-column prop="id" label="ID" width="50" />
                  <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
                  <el-table-column prop="account" label="账号" width="92" class-name="col-optional" />
                  <el-table-column label="状态" width="84">
                    <template #default="{ row }">
                      <StatusTag kind="article" :value="row.status" />
                    </template>
                  </el-table-column>
                  <el-table-column prop="chars" label="字数" width="64" />
                </el-table>
                <EmptyState v-else description="暂无文章" :image-size="48" />
              </el-tab-pane>

              <el-tab-pane label="运行日志">
                <el-table v-if="data.recentLogs.length" :data="data.recentLogs" size="small" max-height="238">
                  <el-table-column prop="id" label="ID" width="50" />
                  <el-table-column prop="level" label="级别" width="64" />
                  <el-table-column prop="stage" label="阶段" width="96" class-name="col-optional" />
                  <el-table-column prop="message" label="内容" min-width="180" show-overflow-tooltip />
                </el-table>
                <EmptyState v-else description="暂无日志" :image-size="48" />
              </el-tab-pane>
            </el-tabs>
          </el-card>
        </el-col>
      </el-row>

      <p class="wb-muted dash-foot">数据生成于 {{ data.generatedAt }}</p>
    </template>

    <!-- 待处理浮窗：右下角浮动提醒（默认展开提示，可收起成胶囊） -->
    <div v-if="alertRows.length" class="todo-float" :class="{ 'todo-float--collapsed': !todoOpen }">
      <template v-if="todoOpen">
        <div class="todo-float__head">
          <span class="todo-float__title">
            <span class="todo-badge">
              <el-icon><WarningFilled /></el-icon>
            </span>
            <span>
              <strong>待处理</strong>
              <span class="wb-muted todo-sub">{{ alertRows.length }} 项需要关注</span>
            </span>
          </span>
          <button class="todo-collapse" type="button" aria-label="收起待处理提醒" @click="todoOpen = false">
            <el-icon><ArrowDown /></el-icon>
          </button>
        </div>
        <ul class="todo-list">
          <li v-for="(a, i) in alertRows" :key="i" class="todo-item" :class="`todo-item--${a.type}`">
            <span class="todo-dot">
              <el-icon><component :is="a.type === 'info' ? InfoFilled : WarningFilled" /></el-icon>
            </span>
            <span class="todo-text">{{ a.text }}</span>
          </li>
        </ul>
      </template>
      <button v-else class="todo-float__pill" type="button" @click="todoOpen = true">
        <span class="todo-badge todo-badge--sm">
          <el-icon><WarningFilled /></el-icon>
        </span>
        待处理
        <span class="pill-count">{{ alertRows.length }}</span>
      </button>
    </div>

    <!-- 执行异常详情：只读当前这条 TodoRunItem，不发请求、不跳页 -->
    <el-drawer
      v-model="runDrawer"
      title="执行异常详情"
      size="min(520px, 92vw)"
      class="run-drawer"
      append-to-body
    >
      <div v-if="currentRun" class="run-detail">
        <div class="run-detail__head">
          <span class="run-detail__type">{{ jobTypeText(currentRun.jobType) }}</span>
          <!-- 这批数据本身就是 failed 集合（unresolved 只统计最新一条仍失败的键），故状态恒为「失败」 -->
          <TaskProgress status="failed" />
        </div>

        <dl class="run-detail__facts">
          <div>
            <dt>任务 ID</dt>
            <dd class="wb-mono">{{ currentRun.id }}</dd>
          </div>
          <div>
            <dt>账号</dt>
            <dd>{{ currentRun.account || '未关联账号' }}</dd>
          </div>
          <div>
            <dt>执行时间</dt>
            <dd>{{ friendlyTime(currentRun.createdAt) }}</dd>
          </div>
          <div>
            <dt>错误代码</dt>
            <dd>
              <span v-if="currentRun.errorCode" class="wb-mono">{{ currentRun.errorCode }}</span>
              <span v-else class="wb-muted">未记录</span>
            </dd>
          </div>
        </dl>

        <section class="run-detail__reason">
          <div class="run-detail__reason-head">
            <span>失败原因</span>
            <el-button
              v-if="!runReasonEmpty"
              link
              type="primary"
              size="small"
              :icon="CopyDocument"
              @click="copyRunReason"
            >
              复制失败原因
            </el-button>
          </div>

          <p v-if="!runReasonEmpty" class="run-detail__text">{{ runReasonRaw }}</p>
          <p v-else-if="runIsComicPanel" class="run-detail__empty">
            漫画面板任务未记录文字错误详情。请前往文章页面查看失败分镜，并根据失败格进行重画。
          </p>
          <p v-else class="run-detail__empty">该任务没有记录文字失败原因。</p>

          <p v-if="runReasonTruncated" class="run-detail__note">
            失败原因可能已达到存储长度上限，当前内容可能不完整。
          </p>
          <p v-if="!runIsComicPanel && !runReasonEmpty" class="run-detail__note">
            当前记录包含执行失败摘要，不包含失败选题标题。
          </p>
        </section>
      </div>

      <template #footer>
        <div class="run-detail__footer">
          <el-button @click="runDrawer = false">关闭</el-button>
          <el-button
            v-if="currentRun?.articleId != null"
            type="primary"
            @click="goRunArticle"
          >
            去文章看分镜
          </el-button>
          <el-button v-else type="primary" @click="goRunPlan">去创作计划</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   设计系统（ui-design-system skill 审查后重排）
   - 8pt 网格：间距 8/12/16/24
   - 字号 3 档：数值 22 / 标题 15 / 正文 12.5（辅助 11.5 归并）
   - 单一视觉焦点：hero 卡整合「进度 + 概览」，不碎小卡
   - 微交互：hover 位移 + stagger 入场 + 弹性曲线
   ══════════════════════════════════════════════════════════════ */
.dash {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-3);
}

/* ── Hero 卡：唯一视觉焦点 ── */
.hero-card {
  border: none;
  background:
    radial-gradient(560px 160px at 8% -40%, rgba(10, 124, 71, 0.08), transparent 70%),
    var(--wb-surface);
  box-shadow: 0 1px 2px rgba(31, 35, 41, 0.04), 0 8px 24px rgba(31, 35, 41, 0.05);
  animation: wb-rise 0.4s var(--wb-ease-out) both;
}

.hero-card :deep(.el-card__body) {
  padding: 20px 24px;
}

.hero {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.hero-progress {
  display: flex;
  align-items: center;
  gap: 20px;
  flex: 1 1 380px;
  min-width: 0;
}

.hero-body h3 {
  margin: 0 0 4px;
  font-size: var(--wb-fs-module);
  font-weight: 600;
  color: var(--wb-text);
}

.hero-body p {
  margin: 0 0 8px;
  font-size: var(--wb-fs-aux);
  line-height: 1.6;
}

.pipeline-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-bottom: 10px;
  font-size: var(--wb-fs-aux);
}

.pipeline-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ring-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.15;
}

.ring-inner strong {
  font-size: var(--wb-fs-num);
  font-weight: 600;
}

.ring-inner span {
  font-size: var(--wb-fs-aux);
}

.hero-cta {
  height: 32px;
  border-radius: var(--wb-radius-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: transform 150ms ease, filter 150ms ease;
}

.hero-cta:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
}

.hero-cta:active {
  transform: translateY(0);
}

/* ── 概览指标：hero 内三分栏（分隔线轻隔，不成碎片卡） ── */
.hero-metrics {
  display: flex;
  gap: 0;
  flex: 1 1 300px;
  min-width: 260px;
}

.metric {
  flex: 1;
  min-width: 0;
  padding: 2px 16px;
  border-left: 1px solid var(--wb-border);
  animation: wb-rise 0.42s var(--wb-ease-out) both;
}

.metric:first-child {
  border-left: none;
  padding-left: 4px;
}

.metric:nth-child(2) {
  animation-delay: 0.06s;
}

.metric:nth-child(3) {
  animation-delay: 0.12s;
}

.metric-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.metric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: var(--wb-fs-aux);
  flex: none;
}

.metric-label {
  color: var(--wb-text-muted);
  font-size: var(--wb-fs-aux);
  white-space: nowrap;
}

.metric-value {
  font-size: var(--wb-fs-num);
  font-weight: 600;
  line-height: 1.2;
  margin: 2px 0;
  color: var(--wb-text);
}

.metric-unit {
  font-size: var(--wb-fs-aux);
  font-weight: 400;
  color: var(--wb-text-muted);
  margin-left: 2px;
}

.metric-hint {
  font-size: var(--wb-fs-aux);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── 未排产窄条（唯一红色层，克制） ── */
.skipped-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 8px 14px;
  border: 1px solid var(--wb-danger-border);
  border-radius: var(--wb-radius);
  background: var(--wb-danger-soft);
  font-size: var(--wb-fs-aux);
  animation: wb-rise 0.36s var(--wb-ease-out) both;
}

.skipped-strip__label {
  font-weight: 600;
  color: var(--wb-danger);
}

.skipped-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 320px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--wb-text);
}

/* ── 明细区两卡 ── */
.tables-row {
  align-items: stretch;
}

.tables-row :deep(.el-col) {
  display: flex;
  flex-direction: column;
}

.table-card {
  height: 100%;
  border: none;
  box-shadow: 0 1px 2px rgba(31, 35, 41, 0.04), 0 6px 20px rgba(31, 35, 41, 0.05);
  border-radius: var(--wb-radius);
  animation: wb-rise 0.42s var(--wb-ease-out) 0.08s both;
}

.table-card :deep(.el-card__header) {
  padding: 12px 16px;
  font-size: var(--wb-fs-body);
  font-weight: 600;
  color: var(--wb-text);
  border-bottom: 1px solid var(--wb-border);
}

.table-card :deep(.el-card__body) {
  padding: 8px 12px 12px;
}

.activity-tabs :deep(.el-tabs__header) {
  margin: 0 0 6px;
}

.activity-tabs :deep(.el-tabs__item) {
  font-size: var(--wb-fs-aux);
  height: 32px;
  line-height: 32px;
}

.dash-foot {
  margin: 0;
  font-size: var(--wb-fs-aux);
  text-align: right;
}

/* ── 待办队列（S5-UI-2）：一行一类，明细只在有数据时出现 ── */
.todo-card {
  border: none;
  box-shadow: 0 1px 2px rgba(31, 35, 41, 0.04), 0 6px 20px rgba(31, 35, 41, 0.05);
  animation: wb-rise 0.38s var(--wb-ease-out) both;
}

.todo-card :deep(.el-card__header) {
  padding: 12px 16px;
  border-bottom: 1px solid var(--wb-border);
}

.todo-card :deep(.el-card__body) {
  padding: 6px 16px 12px;
}

.todo-head {
  display: flex;
  align-items: baseline;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  font-size: var(--wb-fs-aux);
}

.todo-head__title {
  font-size: var(--wb-fs-body);
  font-weight: 600;
  color: var(--wb-text);
}

.todo-rows {
  display: flex;
  flex-direction: column;
}

.todo-row {
  padding: var(--wb-space-3) 0;
  border-top: 1px dashed var(--wb-border);
}

.todo-row:first-child {
  border-top: none;
  padding-top: var(--wb-space-2);
}

.todo-row--last {
  padding-bottom: var(--wb-space-2);
}

.todo-row__head {
  display: flex;
  align-items: baseline;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
}

.todo-row__label {
  min-width: 84px;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}

.todo-spacer {
  flex: 1 1 auto;
}

.todo-num {
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
  color: var(--wb-text);
}

.todo-num--bad {
  color: var(--wb-danger);
}

.todo-unit {
  font-size: var(--wb-fs-aux);
  font-weight: 400;
  color: var(--wb-text-muted);
}

.todo-sub {
  font-size: var(--wb-fs-aux);
  color: var(--wb-text-muted);
}

/* 可点数字：视觉上仍像数字，但整块可点、可聚焦（键盘可达） */
.todo-metric {
  display: inline-flex;
  align-items: baseline;
  gap: var(--wb-space-1);
  padding: 0 var(--wb-space-1);
  border: none;
  background: none;
  border-radius: var(--wb-radius-sm);
  font: inherit;
  cursor: pointer;
  transition: background 150ms ease;
}

.todo-metric:hover {
  background: var(--wb-surface-muted);
}

.todo-metric:hover .todo-num {
  color: var(--wb-primary);
}

.todo-detail {
  margin: var(--wb-space-1) 0 0;
  padding: 0;
  list-style: none;
}

.todo-detail__btn {
  display: flex;
  align-items: baseline;
  gap: var(--wb-space-2);
  width: 100%;
  padding: 3px var(--wb-space-2);
  border: none;
  background: none;
  border-radius: var(--wb-radius-sm);
  font-size: var(--wb-fs-aux);
  text-align: left;
  cursor: pointer;
  transition: background 150ms ease;
}

.todo-detail__btn:hover {
  background: var(--wb-surface-muted);
}

.todo-detail__text {
  max-width: 380px;
  color: var(--wb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.todo-detail__meta {
  color: var(--wb-text-muted);
  white-space: nowrap;
}

.todo-detail__bad {
  color: var(--wb-danger);
  white-space: nowrap;
}

.todo-detail__msg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 明细差额脚注：只说明「还有几条没列出」，不与数字抢视觉 */
.todo-note {
  margin: var(--wb-space-2) 0 0;
  color: var(--wb-text-muted);
  font-size: var(--wb-fs-aux);
}

/* ── 执行异常详情（抽屉）─────────────────────────────────────────────
   原因文本必须可换行、可选中、可滚动：这里是后台唯一能看到完整失败原因的地方，
   再截断就等于没修。 */
.run-detail {
  display: flex;
  flex-direction: column;
  gap: var(--wb-space-4);
}

.run-detail__head {
  display: flex;
  align-items: center;
  gap: var(--wb-space-3);
  flex-wrap: wrap;
}

.run-detail__type {
  font-size: var(--wb-fs-module);
  font-weight: 600;
  color: var(--wb-text);
}

.run-detail__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--wb-space-3);
  margin: 0;
  padding: var(--wb-space-3);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-muted);
}

.run-detail__facts dt {
  margin: 0 0 2px;
  color: var(--wb-text-muted);
  font-size: var(--wb-fs-aux);
}

.run-detail__facts dd {
  margin: 0;
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
  word-break: break-word;
}

.run-detail__reason-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-2);
  margin-bottom: var(--wb-space-2);
  color: var(--wb-text-secondary);
  font-size: var(--wb-fs-aux);
}

.run-detail__text {
  margin: 0;
  padding: var(--wb-space-3);
  max-height: 44vh;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-muted);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
  line-height: 1.7;
  /* 原始文本：保留换行与连续空格，长串（URL / 堆栈）强制断行，不许撑破抽屉 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.run-detail__empty {
  margin: 0;
  padding: var(--wb-space-3);
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text-secondary);
  font-size: var(--wb-fs-body);
  line-height: 1.7;
}

.run-detail__note {
  margin: var(--wb-space-2) 0 0;
  color: var(--wb-text-muted);
  font-size: var(--wb-fs-aux);
}

.run-detail__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--wb-space-2);
}

@media (max-width: 767px) {
  .todo-row__label {
    min-width: 0;
  }

  .todo-detail__text {
    max-width: 100%;
    flex: 1 1 100%;
    white-space: normal;
  }
}

/* ── 待处理浮窗 ── */
.todo-float {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 30;
  width: min(384px, calc(100vw - 32px));
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  box-shadow: 0 16px 40px rgba(31, 35, 41, 0.16);
  overflow: hidden;
  animation: wb-rise 0.3s var(--wb-ease-out) both;
}

.todo-float--collapsed {
  width: auto;
  border: none;
  background: transparent;
  box-shadow: none;
  overflow: visible;
  animation: none;
}

.todo-float__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px 14px;
  background: linear-gradient(180deg, var(--wb-warning-soft) 0%, transparent 100%);
  border-bottom: 1px solid var(--wb-border);
}

.todo-float__title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: var(--wb-fs-body);
  color: var(--wb-text);
}

.todo-sub {
  margin-left: 6px;
  font-size: var(--wb-fs-aux);
}

.todo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-warning);
  color: #fff;
  flex: none;
}

.todo-badge--sm {
  width: 22px;
  height: 22px;
  border-radius: var(--wb-radius-sm);
}

.todo-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-muted);
  cursor: pointer;
  transition: background 150ms ease;
}

.todo-collapse:hover {
  background: rgba(31, 35, 41, 0.06);
}

.todo-list {
  margin: 0;
  padding: 8px 10px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 46vh;
  overflow-y: auto;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--wb-radius-sm);
  font-size: var(--wb-fs-aux);
  line-height: 1.55;
  color: var(--wb-text-secondary);
  transition: background 150ms ease;
}

.todo-item:hover {
  background: var(--wb-surface-muted);
}

.todo-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex: none;
  margin-top: 1px;
  font-size: var(--wb-fs-aux);
}

.todo-item--warning .todo-dot {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.todo-item--info .todo-dot {
  background: var(--wb-primary-soft-2);
  color: var(--wb-primary);
}

.todo-text {
  min-width: 0;
}

.todo-float__pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  box-shadow: 0 10px 28px rgba(31, 35, 41, 0.14);
  font-size: var(--wb-fs-aux);
  font-weight: 500;
  color: var(--wb-text);
  cursor: pointer;
  transition: transform 150ms ease, box-shadow 150ms ease;
}

.todo-float__pill:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 32px rgba(31, 35, 41, 0.18);
}

.pill-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-warning);
  color: #fff;
  font-size: var(--wb-fs-aux);
  font-weight: 600;
}

.inline-icon {
  color: var(--wb-warning);
  vertical-align: -2px;
}

@keyframes wb-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 992px) {
  .hero-metrics {
    border-top: 1px solid var(--wb-border);
    padding-top: 12px;
  }

  .metric:first-child {
    padding-left: 16px;
  }
}

@media (max-width: 520px) {
  .hero {
    gap: 16px;
  }

  .hero-card :deep(.el-card__body) {
    padding: 16px;
  }

  .hero-metrics {
    flex-direction: column;
    gap: 10px;
  }

  .metric {
    border-left: none;
    padding: 0 4px;
  }

  .todo-float {
    right: 12px;
    bottom: 12px;
  }
}
</style>
