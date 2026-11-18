<script setup lang="ts">
/**
 * 自动调度：定时任务开关、写稿时间、级联推送，以及手动心跳补跑与启停定时器。
 *
 * 这一块原先混在「创作计划」页里。两者职责本就不同：创作计划是每天高频查看的
 * 运营视图，调度配置是配好就很少动的设置项，拆开后各自更清爽。
 *
 * ⚠️ 命名提醒：本系统的 AUTO_PUBLISH 是恒为 false 的硬常量，调度只会写草稿、
 *    最多推到公众号草稿箱，永远不会群发。页面上的「级联推送」指的也是推草稿箱。
 */
import { Cpu, Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { errMsg } from '../api/http.ts';
import {
  getSchedulerStatus,
  schedulerStart,
  schedulerStop,
  schedulerTick,
  setSchedulerConfig,
} from '../api/index.ts';
import PageHead from '../components/PageHead.vue';
import { useAuth } from '../composables/useAuth.ts';
import StateError from '../components/StateError.vue';
import type { AutomationMode, SchedulerConfig, SchedulerStatus } from '../types.ts';

const { userRole } = useAuth();
/** 全局开关只有 admin 可改（后端 scheduler.ts:90-94 硬拦）；据此构造 payload 与控制禁用态。 */
const isAdmin = computed(() => userRole.value === 'admin');

const status = ref<SchedulerStatus | null>(null);
const statusError = ref('');
const loading = ref(false);
const ticking = ref(false);
const toggling = ref(false);
const savingCfg = ref(false);
const cfgDirty = ref(false);

const cfg = reactive<SchedulerConfig>({ enabled: false, writeTime: '06:00', pushEnabled: false });
const my = reactive<{ automationMode: AutomationMode; writeTime: string }>({
  automationMode: 'manual',
  writeTime: '06:00',
});
const modeOptions = ref<Array<{ value: AutomationMode; label: string }>>([
  { value: 'manual', label: '纯手动（只手动出稿/推送）' },
  { value: 'auto_draft', label: '自动写稿（到点入库，人工审后手动推）' },
  { value: 'auto_draft_push', label: '自动写稿 + 自动推草稿箱（全自动）' },
]);

/**
 * 推送意图横幅。
 *
 * 口径（必须与后端一致）：tick 是按**每账号 owner 的 automationMode** 决定推不推
 * （scheduler.ts `push = auto.mode === 'auto_draft_push'`），全局 `pushEnabled`
 * 只是「无主账号」的兜底值。所以这里**只消费后端 `pushIntent`**，不再用
 * `cfg.enabled && !cfg.pushEnabled` 反推——那会把「其实会推」说成「不会推」。
 *
 * `pushIntent` 缺省（旧后端 / 夹具未提供）时返回 null：宁可不显示，也不编结论。
 */
const pushBanner = computed<{ type: 'info' | 'warning'; title: string } | null>(() => {
  const s = status.value?.pushIntent?.status;
  if (!s) return null;
  if (s === 'none') {
    return {
      type: 'info',
      title: '本次不会推送：没有账号处于「自动写稿 + 自动推草稿箱」模式（到点只写草稿，推送需人工操作）。',
    };
  }
  if (s === 'partial') {
    return {
      type: 'warning',
      title: '本次会有部分账号推草稿箱：全自动模式的账号会推，其余账号只写草稿，人工审后可手动推。仅进草稿箱，不会群发。',
    };
  }
  if (s === 'all') {
    return {
      type: 'warning',
      title: '本次所有就绪账号都会推草稿箱：仍然只是草稿箱，不会群发（AUTO_PUBLISH 恒为 false）。',
    };
  }
  return {
    type: 'info',
    title: '无法判断本次是否会推送：当前没有就绪账号（需已启用且凭据格式合规），请先检查账号配置。',
  };
});

async function loadStatus() {
  loading.value = true;
  statusError.value = '';
  try {
    status.value = await getSchedulerStatus();
    cfg.enabled = status.value.config.enabled;
    cfg.writeTime = status.value.config.writeTime;
    cfg.pushEnabled = status.value.config.pushEnabled;
    my.automationMode = status.value.my?.automationMode ?? 'manual';
    my.writeTime = status.value.my?.writeTime ?? '06:00';
    if (status.value.modeOptions?.length) modeOptions.value = status.value.modeOptions;
    cfgDirty.value = false;
  } catch (e) {
    statusError.value = errMsg(e, '调度状态加载失败');
  } finally {
    loading.value = false;
  }
}


function onCfgChange() {
  cfgDirty.value = true;
}

async function saveCfg() {
  savingCfg.value = true;
  try {
    // P4：automationMode/writeTime=我的每用户配置（所有角色可改自己）；
    // enabled/pushEnabled=全局开关，后端对非 admin 只要携带就拒绝（scheduler.ts:90-94）。
    // 因此 member/guest 只提交个人字段，绝不携带全局字段——不是隐藏功能，而是按真实权限
    // 提交合法 payload；全局开关对非 admin 禁用（见模板），避免误触与误导。
    const payload = isAdmin.value
      ? { ...cfg, automationMode: my.automationMode, writeTime: my.writeTime }
      : { automationMode: my.automationMode, writeTime: my.writeTime };
    const res = await setSchedulerConfig(payload);
    Object.assign(cfg, res.config);
    if (res.my) {
      my.automationMode = res.my.automationMode;
      my.writeTime = res.my.writeTime;
    }
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
    await loadStatus();
  } catch (e) {
    ElMessage.error(errMsg(e, '心跳执行失败'));
  } finally {
    ticking.value = false;
  }
}

async function toggleRunning(start: boolean) {
  if (toggling.value) return;
  toggling.value = true;
  try {
    const res = start ? await schedulerStart() : await schedulerStop();
    ElMessage.success(res.message);
    await loadStatus();
  } catch (e) {
    ElMessage.error(errMsg(e, '操作失败'));
  } finally {
    toggling.value = false;
  }
}

onMounted(() => {
  void loadStatus();
});
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在加载调度配置…">
    <PageHead title="自动调度" desc="定时任务开关、写稿时间与手动心跳补跑">
      <template #actions>
        <el-button :icon="Refresh" @click="loadStatus">刷新</el-button>
      </template>
    </PageHead>

    <StateError v-if="statusError" :message="statusError" label="调度状态加载失败" @retry="loadStatus" />

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>自动调度</span>
          <el-tag :type="status?.running ? 'success' : 'info'" size="small" effect="light">
            {{ status?.running ? '定时器运行中' : '定时器未运行' }}
          </el-tag>
        </div>
      </template>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="安全边界：系统只会写草稿，最多推到公众号草稿箱，不会自动群发（AUTO_PUBLISH 恒为 false）。"
      />

      <el-form label-width="96px" class="cfg-form">
        <el-form-item label="自动化模式">
          <el-radio-group v-model="my.automationMode" @change="onCfgChange">
            <el-radio v-for="opt in modeOptions" :key="opt.value" :value="opt.value" border style="margin: 4px 8px 4px 0">
              {{ opt.label }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="写稿时间">
          <el-time-picker
            v-model="my.writeTime"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="06:00"
            style="width: 140px"
            @change="onCfgChange"
          />
          <span class="wb-muted hint">到点后按各账号配额自动写稿（manual 模式不生效）</span>
        </el-form-item>
        <el-form-item label="全局总开关">
          <el-switch v-model="cfg.enabled" aria-label="全局调度总开关" :disabled="!isAdmin" @change="onCfgChange" />
          <span class="wb-muted hint">关掉后所有人的自动化都不跑（仅管理员可改）{{ isAdmin ? '' : '；当前账号无权限修改' }}</span>
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
          :loading="toggling"
          @click="toggleRunning(true)"
        >
          启动定时器
        </el-button>
        <el-button
          v-else
          :icon="VideoPause"
          type="warning"
          plain
          :loading="toggling"
          @click="toggleRunning(false)"
        >
          停止定时器
        </el-button>
        <span v-if="status?.lastTick" class="wb-muted last-tick">
          上次心跳产出
          {{ status.lastTick.wrote.reduce((s, w) => s + (w.created ?? 0), 0) }} 篇
          <!-- 漫画格是慢任务：生图在心跳锁外分轮推进，这里把进度与退避数显式出来 -->
          <template v-if="status.lastTick.comic">
            · 漫画格 已生成 {{ status.lastTick.comic.done }}
            <template v-if="status.lastTick.comic.failed">/ 失败 {{ status.lastTick.comic.failed }}</template>
            <template v-if="status.lastTick.comic.skipped">/ 退避中 {{ status.lastTick.comic.skipped }}</template>
          </template>
        </span>
      </div>

      <el-alert
        v-if="cfg.enabled && pushBanner"
        class="push-intent"
        :type="pushBanner.type"
        show-icon
        :closable="false"
        :title="pushBanner.title"
      />
    </el-card>

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
  margin-top: var(--wb-space-3);
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

.push-intent {
  margin-top: var(--wb-space-3);
}
</style>
