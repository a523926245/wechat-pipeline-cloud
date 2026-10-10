<script setup lang="ts">
import { Cpu, Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import {
  getPlan,
  getSchedulerStatus,
  schedulerStart,
  schedulerStop,
  schedulerTick,
  setSchedulerConfig,
  triggerPlan,
} from '../api/index.ts';
import StateError from '../components/StateError.vue';
import type { PlanResult, SchedulerConfig, SchedulerStatus } from '../types.ts';

const router = useRouter();

const plan = ref<PlanResult | null>(null);
const status = ref<SchedulerStatus | null>(null);
const loading = ref(false);
const planError = ref('');
const statusError = ref('');
const ticking = ref(false);
const triggeringId = ref<number | null>(null);

const cfg = reactive<SchedulerConfig>({ enabled: false, writeTime: '06:00', pushEnabled: false });
const cfgDirty = ref(false);
const savingCfg = ref(false);

async function loadPlan() {
  loading.value = true;
  planError.value = '';
  try {
    plan.value = await getPlan({ backlogDays: 3 });
  } catch (e) {
    planError.value = errMsg(e, '计划加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadStatus() {
  statusError.value = '';
  try {
    status.value = await getSchedulerStatus();
    cfg.enabled = status.value.config.enabled;
    cfg.writeTime = status.value.config.writeTime;
    cfg.pushEnabled = status.value.config.pushEnabled;
    cfgDirty.value = false;
  } catch (e) {
    statusError.value = errMsg(e, '调度状态加载失败');
  }
}

onMounted(() => {
  void Promise.all([loadPlan(), loadStatus()]);
});

const totalPending = computed(() =>
  (plan.value?.tasks ?? []).reduce((s, t) => s + Math.max(0, t.need), 0),
);

function onCfgChange() {
  cfgDirty.value = true;
}

async function saveCfg() {
  savingCfg.value = true;
  try {
    const res = await setSchedulerConfig({ ...cfg });
    Object.assign(cfg, res.config);
    cfgDirty.value = false;
    ElMessage.success('调度配置已保存');
    await loadStatus();
  } catch (e) {
    ElMessage.error(errMsg(e, '保存失败'));
  } finally {
    savingCfg.value = false;
  }
}

async function runTick() {
  ticking.value = true;
  try {
    const res = await schedulerTick(true);
    const r = res.result;
    const wrote = r.wrote ?? [];
    const total = wrote.reduce((s, w) => s + (w.created ?? 0), 0);
    ElMessageBox.alert(
      `到期：${r.due ? '是' : '否'}　启用：${r.enabled ? '是' : '否'}\n` +
        `本次产出：${total} 篇\n` +
        `明细：${wrote.map((w) => `${w.account}(${w.created}${w.reason ? ' · ' + w.reason : ''})`).join('、') || '无'}`,
      '心跳执行完成',
      { type: total > 0 ? 'success' : 'info', confirmButtonText: '知道了' },
    );
    await loadPlan();
  } catch (e) {
    ElMessage.error(errMsg(e, '心跳执行失败'));
  } finally {
    ticking.value = false;
  }
}

async function toggleRunning(start: boolean) {
  try {
    const res = start ? await schedulerStart() : await schedulerStop();
    ElMessage.success(res.message);
    await loadStatus();
  } catch (e) {
    ElMessage.error(errMsg(e, '操作失败'));
  }
}

/** 近作避让标题拼接（模板里不便写类型标注，故提到 script）。 */
function avoidTitles(list: { date: string; title: string }[]): string {
  return (list ?? []).map((a) => a.title).join('、');
}

async function trigger(row: { accountId: number; account: string; need: number }) {
  triggeringId.value = row.accountId;
  try {
    const res = await triggerPlan(row.accountId, Math.max(1, row.need || 1));
    if (res.ok) {
      ElMessage.success(res.message);
      const first = res.created[0];
      if (first) {
        try {
          await ElMessageBox.confirm('是否立即打开第一篇进行改稿？', '已生成草稿', {
            type: 'success',
            confirmButtonText: '去改稿',
            cancelButtonText: '稍后',
          });
          await router.push(`/articles/${first.id}`);
        } catch {
          /* 用户选择稍后 */
        }
      }
    } else {
      ElMessageBox.alert(res.reason ?? res.message, '未生成草稿', {
        type: 'warning',
        confirmButtonText: '知道了',
      });
    }
    await loadPlan();
  } catch (e) {
    ElMessage.error(errMsg(e, '触发失败'));
  } finally {
    triggeringId.value = null;
  }
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在计算今日排产…">
    <header class="wb-page-head">
      <div>
        <h2>创作计划</h2>
        <p class="wb-page-desc">
          {{ plan?.date ?? '' }}<template v-if="totalPending"> · 今日待补 {{ totalPending }} 篇</template>
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="loadPlan">刷新</el-button>
      </div>
    </header>

    <StateError v-if="planError" :message="planError" label="创作计划加载失败" @retry="loadPlan" />
    <StateError v-if="statusError" :message="statusError" label="调度状态加载失败" @retry="loadStatus" />

    <!-- 调度控制 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>自动调度</span>
          <el-tag :type="status?.running ? 'success' : 'info'" size="small" effect="light">
            {{ status?.running ? '定时器运行中' : '定时器未运行' }}
          </el-tag>
        </div>
      </template>

      <el-form label-width="96px" class="cfg-form">
        <el-form-item label="启用调度">
          <el-switch v-model="cfg.enabled" aria-label="启用自动调度" @change="onCfgChange" />
          <span class="wb-muted hint">到点后按各账号配额自动写稿</span>
        </el-form-item>
        <el-form-item label="写稿时间">
          <el-time-picker
            v-model="cfg.writeTime"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="06:00"
            style="width: 140px"
            @change="onCfgChange"
          />
        </el-form-item>
        <el-form-item label="级联推送">
          <el-switch v-model="cfg.pushEnabled" aria-label="级联推送到草稿箱" @change="onCfgChange" />
          <span class="wb-muted hint">并行期建议关闭，只写草稿不推送</span>
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button type="primary" :loading="savingCfg" :disabled="!cfgDirty" @click="saveCfg">
          {{ cfgDirty ? '保存配置' : '配置已保存' }}
        </el-button>
        <el-button :icon="Cpu" :loading="ticking" @click="runTick">立即心跳补跑</el-button>
        <el-button
          v-if="!status?.running"
          :icon="VideoPlay"
          type="success"
          plain
          @click="toggleRunning(true)"
        >
          启动定时器
        </el-button>
        <el-button v-else :icon="VideoPause" type="warning" plain @click="toggleRunning(false)">
          停止定时器
        </el-button>
        <span v-if="status?.lastTick" class="wb-muted last-tick">
          上次心跳产出
          {{ status.lastTick.wrote.reduce((s, w) => s + (w.created ?? 0), 0) }} 篇
        </span>
      </div>

      <el-alert
        v-if="cfg.enabled && !cfg.pushEnabled"
        type="info"
        show-icon
        :closable="false"
        title="当前为 dry-run：调度会写草稿，但不会推送到公众号。"
      />
    </el-card>

    <!-- 今日排产 -->
    <el-card shadow="never">
      <template #header>今日排产</template>

      <el-table v-if="plan && plan.tasks.length" :data="plan.tasks" size="default">
        <el-table-column prop="account" label="账号" min-width="120" />
        <el-table-column prop="track" label="赛道" min-width="100" class-name="col-optional" />
        <el-table-column prop="alreadyToday" label="已出" width="70" />
        <el-table-column label="待补" width="74">
          <template #default="{ row }">
            <el-tag :type="row.need > 0 ? 'warning' : 'success'" size="small">{{ row.need }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可用角度" width="100">
          <template #default="{ row }">
            <span :class="{ 'wb-danger-text': row.angles.length === 0 }">{{ row.angles.length }}</span>
            <el-tag v-if="row.short > 0" type="danger" size="small" style="margin-left: 4px">
              缺 {{ row.short }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="近作避让" min-width="160" class-name="col-optional">
          <template #default="{ row }">
            <span v-if="!row.avoid.length" class="wb-muted">无</span>
            <span v-else class="wb-muted">{{ avoidTitles(row.avoid) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="112" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              size="small"
              :loading="triggeringId === row.accountId"
              @click="trigger(row)"
            >
              立即出稿
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无可排产账号（需凭据就绪且启用）" :image-size="60" />

      <template v-if="plan && plan.tasks.length">
        <el-divider content-position="left">候选角度</el-divider>
        <el-collapse>
          <el-collapse-item
            v-for="t in plan.tasks"
            :key="t.accountId"
            :title="`${t.account}（${t.angles.length} 个）`"
          >
            <ol class="angle-list">
              <li v-for="a in t.angles" :key="a.id">{{ a.text }}</li>
            </ol>
          </el-collapse-item>
        </el-collapse>
      </template>
    </el-card>

    <el-row :gutter="12">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>计划告警</template>
          <el-alert
            v-for="(w, i) in plan?.warnings ?? []"
            :key="`pw-${i}`"
            type="warning"
            :title="w"
            show-icon
            :closable="false"
          />
          <el-empty v-if="!plan?.warnings?.length" description="无告警" :image-size="52" />
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>近期欠账与未排产</template>
          <el-table v-if="plan?.backlog?.length" :data="plan.backlog" size="small" max-height="160">
            <el-table-column prop="date" label="日期" width="106" />
            <el-table-column prop="account" label="账号" min-width="100" />
            <el-table-column label="缺口" width="74">
              <template #default="{ row }">
                <el-tag type="danger" size="small">{{ row.miss }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <p v-else class="wb-muted none-line">无欠账</p>

          <el-divider content-position="left">未排产账号</el-divider>
          <el-table v-if="plan?.skipped?.length" :data="plan.skipped" size="small" max-height="160">
            <el-table-column prop="account" label="账号" width="100" />
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
          </el-table>
          <p v-else class="wb-muted none-line">无</p>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
}

.cfg-form {
  max-width: 520px;
}

.cfg-form :deep(.el-form-item) {
  margin-bottom: var(--wb-space-2);
}

.hint {
  margin-left: var(--wb-space-3);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  margin-top: var(--wb-space-2);
}

.last-tick {
  margin-left: auto;
}

.angle-list {
  margin: 0;
  padding-left: 20px;
  color: var(--wb-text-secondary);
  font-size: 13px;
  line-height: 1.9;
}

.none-line {
  margin: 0 0 var(--wb-space-3);
}

@media (max-width: 767px) {
  .hint {
    display: none;
  }

  .last-tick {
    margin-left: 0;
  }
}
</style>
