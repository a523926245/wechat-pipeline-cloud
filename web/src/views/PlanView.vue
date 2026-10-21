<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errMsg } from '../api/http.ts';
import { getPlan, triggerPlan } from '../api/index.ts';
import StateError from '../components/StateError.vue';
import RowActions, { type RowAction } from '../components/RowActions.vue';
import { pipelineTagType, pipelineText } from '../utils/format.ts';
import type { PlanResult, PlanTask } from '../types.ts';

const router = useRouter();

const plan = ref<PlanResult | null>(null);
const loading = ref(false);
const planError = ref('');
const triggeringKey = ref<string | null>(null);

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

onMounted(() => {
  void loadPlan();
});

const totalPending = computed(() =>
  (plan.value?.tasks ?? []).reduce((s, t) => s + Math.max(0, t.need), 0),
);

/** 近作避让标题拼接（模板里不便写类型标注，故提到 script）。 */
function avoidTitles(list: { date: string; title: string }[]): string {
  return (list ?? []).map((a) => a.title).join('、');
}

/** 产线级行标识：同一账号的文章/漫画两条产线各自独立，防重锁不能共用。 */
function rowKey(row: { accountId: number; pipeline: string }): string {
  return `${row.accountId}:${row.pipeline}`;
}


async function trigger(row: { accountId: number; account: string; need: number; pipeline: 'article' | 'comic' }) {
  // 防重入：LLM 写作/漫画脚本是数十秒级重操作，任何触发进行中都不允许再次触发
  if (triggeringKey.value !== null) return;
  triggeringKey.value = rowKey(row);
  const isComic = row.pipeline === 'comic';
  try {
    const res = await triggerPlan(row.accountId, Math.max(1, row.need || 1), row.pipeline);
    if (res.ok) {
      ElMessage.success(res.message);
      const first = res.created[0];
      if (first) {
        // 文章：modelUsed 为空 = 写作服务回退骨架草稿（未绑模型 / 缺 Key / 调用失败）；
        // 漫画：note 里带脚本失败信息（漫画不设 modelUsed）。
        const problemNotes = (res.created ?? [])
          .filter((c) => (isComic ? c.note && c.note.includes('失败') : !c.modelUsed))
          .map((c) => `《${c.title ?? `ID ${c.id}`}》：${c.note ?? '未使用模型，已生成骨架草稿'}`);
        const hasProblem = problemNotes.length > 0;
        const title = isComic ? '漫画已开始生成' : '已生成草稿';
        // 漫画：脚本落地后**插图已在后台自动逐格开跑**（不用再去文章页手动点生成），
        // 所以这里的文案是「去看进度」而不是「去生成」。
        const message = hasProblem
          ? h('p', { style: 'white-space: pre-line; margin: 0' },
              `${problemNotes.join('\n')}\n\n${isComic ? '请到「模型配置」绑定「漫画脚本」角色后重试。' : '请到「模型配置」添加模型并绑定「写作」角色后重新出稿；骨架草稿仍可打开编辑。'}`)
          : isComic
            ? '脚本已生成，分镜插图正在后台自动生成（每格约 30~40 秒，可离开本页）。'
            : '是否立即打开第一篇进行改稿？';
        try {
          await ElMessageBox.confirm(message, hasProblem ? (isComic ? '漫画脚本生成异常' : '已生成骨架草稿（模型未参与写作）') : title, {
            type: hasProblem ? 'warning' : 'success',
            confirmButtonText: isComic ? '去看插图进度' : '去改稿',
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
    triggeringKey.value = null;
  }
}

/** 行操作菜单项，供 RowActions 组件渲染。 */
function planActions(row: PlanTask): RowAction[] {
  return [
    {
      command: 'trigger',
      label: row.pipeline === 'comic' ? '生成漫画' : '立即出稿',
      loading: triggeringKey.value === rowKey(row),
    },
  ];
}

function onPlanCommand(cmd: string, row: PlanTask) {
  if (cmd === 'trigger') trigger(row);
}
</script>

<template>
  <div class="wb-page" v-loading="loading" element-loading-text="正在计算今日排产…">
    <header class="wb-page-head">
      <div>
        <h2>创作计划</h2>
        <p class="wb-page-desc">
          {{ plan?.date ?? '' }}<template v-if="totalPending"> · 今日待补 {{ totalPending }} 篇</template>
          · 调度设定请到「自动调度」
        </p>
      </div>
      <div class="wb-page-actions">
        <el-button :icon="Refresh" @click="loadPlan">刷新</el-button>
      </div>
    </header>

    <StateError v-if="planError" :message="planError" label="创作计划加载失败" @retry="loadPlan" />

    <!-- 今日排产 -->
    <el-card
      shadow="never"
      v-loading="triggeringKey !== null"
      element-loading-text="正在生成（模型处理中，约需数十秒，请勿重复触发）…"
    >
      <template #header>今日排产</template>

      <el-table v-if="plan && plan.tasks.length" :data="plan.tasks" size="default">
        <el-table-column prop="account" label="账号" width="150" show-overflow-tooltip />
        <el-table-column prop="track" label="赛道" width="110" class-name="col-optional" show-overflow-tooltip />
        <el-table-column label="产线" width="84">
          <template #default="{ row }">
            <el-tag :type="pipelineTagType(row.pipeline)" size="small">
              {{ pipelineText(row.pipeline) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="alreadyToday" label="已出" width="70" />
        <el-table-column label="待补" width="74">
          <template #default="{ row }">
            <el-tag :type="row.need > 0 ? 'warning' : 'success'" size="small">{{ row.need }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可用角度" width="100">
          <template #default="{ row }">
            <!-- 真实池余量 stock（与赛道管理页一致）。此前误用 angles.length（今日预选数），
                 配额已满时 need=0 会显示 0，被误读成「角度用光了」。 -->
            <span :class="{ 'wb-danger-text': row.stock === 0 }">{{ row.stock }}</span>
            <el-tag v-if="row.short > 0" type="danger" size="small" style="margin-left: var(--wb-space-1)">
              缺 {{ row.short }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="近作避让" min-width="320" class-name="col-optional">
          <template #default="{ row }">
            <span v-if="!row.avoid.length" class="wb-muted">无</span>
            <span v-else class="avoid-cell" :title="avoidTitles(row.avoid)">{{ avoidTitles(row.avoid) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="92" fixed="right">
          <template #default="{ row }">
            <RowActions
              :actions="planActions(row)"
              :busy="triggeringKey === `${row.accountId}:${row.pipeline}`"
              @command="(cmd: string) => onPlanCommand(cmd, row)"
            />
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无可排产账号（需凭据就绪且启用）" :image-size="60" />

      <!-- 未排产原因：原独立卡片「近期欠账与未排产」的保留部分，降级为一行轻提示 -->
      <p v-if="plan?.skipped?.length" class="wb-muted skipped-line">
        未参与排产：<template v-for="(s, i) in plan.skipped" :key="`sk-${i}`">
          <span>{{ s.account }}（{{ s.reason }}）</span><span v-if="i < plan.skipped.length - 1">、</span>
        </template>
      </p>
    </el-card>
  </div>
</template>

<style scoped>
/* 未排产账号轻提示 */
.skipped-line {
  margin: var(--wb-space-3) 0 0;
  font-size: 13px;
}

/* 近作避让：限两行截断，行高不被长标题列表撑爆；悬停 title 看全文 */
.avoid-cell {
  color: var(--wb-text-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  line-height: 1.6;
  word-break: break-all;
}
</style>
