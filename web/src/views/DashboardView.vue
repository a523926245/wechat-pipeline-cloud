<script setup lang="ts">
import { ArrowDown, DataAnalysis, Document, InfoFilled, Refresh, Right, User, WarningFilled } from '@element-plus/icons-vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { getDashboard } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { DashboardData } from '../types.ts';
import { pipelineTagType, pipelineText, statusTag, statusText } from '../utils/format.ts';

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
      label: '就绪账号',
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
</script>

<template>
  <div class="wb-page dash" v-loading="loading" element-loading-text="正在汇总系统状态…">
    <header class="wb-page-head">
      <div>
        <h2>仪表盘</h2>
        <p class="wb-page-desc">今天的产出进度与角度库存（系统状态常驻侧边栏底部）</p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

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
            <el-empty v-else description="暂无可排产账号（需凭据就绪且启用）" :image-size="48" />
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
                  <el-table-column label="状态" width="76">
                    <template #default="{ row }">
                      <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="trigger" label="触发" width="72" class-name="col-optional" />
                  <el-table-column prop="runDate" label="日期" width="96" class-name="col-optional" />
                  <el-table-column prop="errorMessage" label="错误" min-width="120" show-overflow-tooltip />
                </el-table>
                <el-empty v-else description="暂无任务流水" :image-size="48" />
              </el-tab-pane>

              <el-tab-pane label="最近文章">
                <el-table v-if="data.recentArticles.length" :data="data.recentArticles" size="small" max-height="238">
                  <el-table-column prop="id" label="ID" width="50" />
                  <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
                  <el-table-column prop="account" label="账号" width="92" class-name="col-optional" />
                  <el-table-column label="状态" width="76">
                    <template #default="{ row }">
                      <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="chars" label="字数" width="64" />
                </el-table>
                <el-empty v-else description="暂无文章" :image-size="48" />
              </el-tab-pane>

              <el-tab-pane label="运行日志">
                <el-table v-if="data.recentLogs.length" :data="data.recentLogs" size="small" max-height="238">
                  <el-table-column prop="id" label="ID" width="50" />
                  <el-table-column prop="level" label="级别" width="64" />
                  <el-table-column prop="stage" label="阶段" width="96" class-name="col-optional" />
                  <el-table-column prop="message" label="内容" min-width="180" show-overflow-tooltip />
                </el-table>
                <el-empty v-else description="暂无日志" :image-size="48" />
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
  gap: 12px;
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
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}

.hero-body p {
  margin: 0 0 8px;
  font-size: 12.5px;
  line-height: 1.6;
}

.pipeline-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-bottom: 10px;
  font-size: 12px;
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
  font-size: 24px;
  font-weight: 600;
}

.ring-inner span {
  font-size: 11.5px;
}

.hero-cta {
  height: 32px;
  border-radius: 8px;
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
  border-radius: 7px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 12px;
  flex: none;
}

.metric-label {
  color: var(--wb-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.metric-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  margin: 2px 0;
  color: var(--wb-text);
}

.metric-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
  margin-left: 2px;
}

.metric-hint {
  font-size: 11.5px;
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
  border-radius: 10px;
  background: var(--wb-danger-soft);
  font-size: 12px;
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
  border-radius: 12px;
  animation: wb-rise 0.42s var(--wb-ease-out) 0.08s both;
}

.table-card :deep(.el-card__header) {
  padding: 12px 16px;
  font-size: 13.5px;
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
  font-size: 12.5px;
  height: 32px;
  line-height: 32px;
}

.dash-foot {
  margin: 0;
  font-size: 11.5px;
  text-align: right;
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
  border-radius: 12px;
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
  font-size: 13.5px;
  color: var(--wb-text);
}

.todo-sub {
  margin-left: 6px;
  font-size: 11.5px;
}

.todo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--wb-warning);
  color: #fff;
  flex: none;
}

.todo-badge--sm {
  width: 22px;
  height: 22px;
  border-radius: 7px;
}

.todo-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
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
  border-radius: 8px;
  font-size: 12.5px;
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
  font-size: 11px;
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
  font-size: 13px;
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
  font-size: 11px;
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
