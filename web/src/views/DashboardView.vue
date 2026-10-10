<script setup lang="ts">
import { DataAnalysis, Document, Refresh, Right, User, WarningFilled } from '@element-plus/icons-vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { getDashboard } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { DashboardData } from '../types.ts';
import { statusTag, statusText } from '../utils/format.ts';

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

const roleLabels: Record<string, string> = {
  write: '写作',
  revise: '改写',
  cover: '封面',
  expand_angles: '扩角度',
};

function pctOf(produced: number, quota: number): number {
  if (!quota) return 0;
  return Math.min(100, Math.round((produced / quota) * 100));
}

/** 次要指标卡：图标芯片 + 顶部品牌强调条（由 .wb-stat 提供），数字右对齐更整齐。 */
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
  <div class="wb-page" v-loading="loading" element-loading-text="正在汇总系统状态…">
    <header class="wb-page-head">
      <div>
        <h2>仪表盘</h2>
        <p class="wb-page-desc">今天的产出进度、角度库存与系统健康</p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </header>

    <StateError v-if="error" :message="error" @retry="load" />

    <template v-if="data">
      <!-- 需要处理的先看到 -->
      <el-alert
        v-for="(w, i) in data.warnings"
        :key="`w-${i}`"
        type="warning"
        :title="w"
        show-icon
        :closable="false"
      />

      <!-- 区块级降级：后端某数据源异常时仍打得开，这里把降级项明示，避免静默丢失信息 -->
      <el-alert
        v-if="data.degraded?.length"
        type="info"
        show-icon
        :closable="false"
        title="部分模块数据降级（其余区块正常）"
      >
        <span class="wb-secondary">{{ data.degraded.join('、') }}</span>
      </el-alert>

      <!-- 唯一主入口：今日产出 -->
      <el-card shadow="never" class="focus-card">
        <div class="focus">
          <el-progress type="dashboard" :percentage="quotaPct" :width="112" :stroke-width="8">
            <template #default>
              <div class="ring-inner">
                <strong class="wb-num">{{ data.today.produced }}</strong>
                <span class="wb-muted">/ {{ data.today.quotaTotal }} 篇</span>
              </div>
            </template>
          </el-progress>

          <div class="focus-body">
            <h3>今日出稿进度</h3>
            <p class="wb-secondary">
              <template v-if="data.today.pending > 0">
                还差 <strong class="wb-num">{{ data.today.pending }}</strong> 篇达到今日配额，
                可去创作计划立即出稿。
              </template>
              <template v-else>今日配额已完成，无需补稿。</template>
            </p>
            <div class="focus-meta">
              <span>就绪账号 <strong class="wb-num">{{ data.counts.accounts.ready }}</strong></span>
              <span>可用角度 <strong class="wb-num">{{ data.counts.angles.unused }}</strong></span>
              <span>草稿 <strong class="wb-num">{{ data.counts.articles.draft }}</strong></span>
            </div>
            <el-button
              v-if="data.today.pending > 0"
              type="primary"
              size="small"
              @click="router.push('/plan')"
            >
              去出稿
              <el-icon class="el-icon--right"><Right /></el-icon>
            </el-button>
          </div>
        </div>
      </el-card>

      <!-- 次要指标 -->
      <el-row :gutter="12">
        <el-col v-for="card in metricCards" :key="card.label" class="metric-col" :xs="24" :sm="8">
          <el-card shadow="never" class="metric wb-stat">
            <div class="metric-head">
              <span class="metric-label">{{ card.label }}</span>
              <span class="wb-chip wb-chip--soft">
                <el-icon><component :is="card.icon" /></el-icon>
              </span>
            </div>
            <div class="metric-value wb-num">
              {{ card.value }}<span v-if="card.unit" class="metric-unit">{{ card.unit }}</span>
            </div>
            <div class="wb-muted">{{ card.hint }}</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 今日各账号 -->
      <el-card shadow="never">
        <template #header>今日配额（各账号）</template>
        <el-table v-if="data.today.byAccount.length" :data="data.today.byAccount" size="small">
          <el-table-column prop="account" label="账号" min-width="130" />
          <el-table-column prop="track" label="赛道" min-width="110" class-name="col-optional" />
          <el-table-column prop="quota" label="配额" width="72" />
          <el-table-column prop="produced" label="已出" width="72" />
          <el-table-column label="待补" width="78">
            <template #default="{ row }">
              <el-tag :type="row.pending > 0 ? 'warning' : 'success'" size="small">{{ row.pending }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="angleStock" label="可用角度" width="96" />
          <el-table-column label="进度" min-width="150">
            <template #default="{ row }">
              <el-progress :percentage="pctOf(row.produced, row.quota)" :stroke-width="8" />
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无可排产账号（需凭据就绪且启用）" :image-size="60" />
      </el-card>

      <el-row :gutter="12">
        <el-col :xs="24" :md="12">
          <el-card shadow="never">
            <template #header>系统健康</template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="数据库">
                <el-tag :type="data.health.db ? 'success' : 'danger'" size="small">
                  {{ data.health.db ? '正常' : '异常' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="主密钥">
                <el-tag :type="data.health.masterKey ? 'success' : 'danger'" size="small">
                  {{ data.health.masterKey ? '已就绪' : '未就绪' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="自动发布（硬常量）">
                <el-tag :type="data.health.autoPublishConstant ? 'danger' : 'success'" size="small">
                  {{ data.health.autoPublishConstant ? '已开启' : 'false（不可开启）' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="库中 auto_publish">
                <span class="wb-mono">{{ data.health.autoPublishSetting ?? '(未设置)' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="调度">
                <el-tag :type="data.health.scheduler.enabled ? 'success' : 'info'" size="small">
                  {{ data.health.scheduler.enabled ? `已启用 ${data.health.scheduler.writeTime}` : '未启用' }}
                </el-tag>
                <span class="wb-muted" style="margin-left: 6px">
                  {{ data.health.scheduler.pushEnabled ? '含推送' : '不推送' }}
                </span>
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="12">
          <el-card shadow="never">
            <template #header>
              <span>模型与角色绑定</span>
              <el-tag size="small" type="info" style="margin-left: 8px">
                {{ data.models.enabled }}/{{ data.models.total }} 启用
              </el-tag>
            </template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item v-for="(label, role) in roleLabels" :key="role" :label="label">
                <el-tag :type="data.models.bindings[role] ? 'success' : 'warning'" size="small" effect="light">
                  {{ data.models.bindings[role]?.modelName ?? '未绑定' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="写作模型">
                <el-tag :type="data.models.writeModelReady ? 'success' : 'warning'" size="small">
                  {{ data.models.writeModelReady ? '已配置 Key' : '无 Key（回退骨架）' }}
                </el-tag>
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="12" v-if="data.backlog.length || data.skipped.length">
        <el-col v-if="data.backlog.length" :xs="24" :md="12">
          <el-card shadow="never">
            <template #header>
              <span><el-icon class="inline-icon"><WarningFilled /></el-icon> 近期欠账</span>
            </template>
            <el-table :data="data.backlog" size="small" max-height="220">
              <el-table-column prop="date" label="日期" width="108" />
              <el-table-column prop="account" label="账号" min-width="110" />
              <el-table-column prop="got" label="实出" width="68" />
              <el-table-column label="缺口" width="76">
                <template #default="{ row }">
                  <el-tag type="danger" size="small">{{ row.miss }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col v-if="data.skipped.length" :xs="24" :md="12">
          <el-card shadow="never">
            <template #header>未排产账号</template>
            <el-table :data="data.skipped" size="small" max-height="220">
              <el-table-column prop="account" label="账号" width="110" />
              <el-table-column prop="track" label="赛道" width="96" class-name="col-optional" />
              <el-table-column prop="reason" label="原因" min-width="150" show-overflow-tooltip />
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never">
        <template #header>最近动态</template>
        <el-tabs>
          <el-tab-pane label="任务流水">
            <el-table v-if="data.recentRuns.length" :data="data.recentRuns" size="small" max-height="280">
              <el-table-column prop="id" label="ID" width="56" />
              <el-table-column prop="jobType" label="类型" width="96" />
              <el-table-column label="状态" width="84">
                <template #default="{ row }">
                  <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="trigger" label="触发" width="84" class-name="col-optional" />
              <el-table-column prop="runDate" label="日期" width="108" />
              <el-table-column prop="errorMessage" label="错误" min-width="150" show-overflow-tooltip />
            </el-table>
            <el-empty v-else description="暂无任务流水" :image-size="60" />
          </el-tab-pane>

          <el-tab-pane label="最近文章">
            <el-table v-if="data.recentArticles.length" :data="data.recentArticles" size="small" max-height="280">
              <el-table-column prop="id" label="ID" width="56" />
              <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
              <el-table-column prop="account" label="账号" width="110" class-name="col-optional" />
              <el-table-column label="状态" width="84">
                <template #default="{ row }">
                  <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="chars" label="字数" width="76" />
            </el-table>
            <el-empty v-else description="暂无文章" :image-size="60" />
          </el-tab-pane>

          <el-tab-pane label="运行日志">
            <el-table v-if="data.recentLogs.length" :data="data.recentLogs" size="small" max-height="280">
              <el-table-column prop="id" label="ID" width="56" />
              <el-table-column prop="level" label="级别" width="76" />
              <el-table-column prop="stage" label="阶段" width="110" />
              <el-table-column prop="message" label="内容" min-width="240" show-overflow-tooltip />
            </el-table>
            <el-empty v-else description="暂无日志" :image-size="60" />
          </el-tab-pane>
        </el-tabs>
      </el-card>

      <p class="wb-muted">数据生成于 {{ data.generatedAt }}</p>
    </template>
  </div>
</template>

<style scoped>
.focus-card {
  border-color: #cfe6d9;
  background: linear-gradient(180deg, #f4fbf7 0%, #ffffff 60%);
}

.focus {
  display: flex;
  align-items: center;
  gap: var(--wb-space-5);
  flex-wrap: wrap;
}

.focus-body h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.focus-body p {
  margin: 0 0 8px;
  font-size: 13px;
}

.focus-meta {
  display: flex;
  gap: var(--wb-space-4);
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--wb-text-muted);
  margin-bottom: var(--wb-space-3);
}

.focus-meta strong {
  color: var(--wb-text);
}

.ring-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.2;
}

.ring-inner strong {
  font-size: 24px;
}

.metric {
  height: 100%;
  animation: wb-rise 0.42s var(--wb-ease-out) both;
}

.metric-col:nth-child(2) .metric {
  animation-delay: 0.06s;
}

.metric-col:nth-child(3) .metric {
  animation-delay: 0.12s;
}

.metric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wb-space-2);
}

.metric-label {
  color: var(--wb-text-muted);
  font-size: 12px;
}

.metric-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
  margin: 2px 0;
}

.metric-unit {
  font-size: 13px;
  font-weight: 400;
  color: var(--wb-text-muted);
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

@media (max-width: 520px) {
  .focus {
    gap: var(--wb-space-3);
  }

  .focus-meta {
    gap: var(--wb-space-2);
  }
}
</style>
