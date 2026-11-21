<script setup lang="ts">
/**
 * 统一保存状态条（S5-UI-1）。
 *
 * 只做「展示 + 转发保存意图」：组件不碰接口、不判断业务能否保存，
 * 真实保存由页面在 @save 里执行，执行结果再通过 state 回灌。
 * 这样同一套文案与视觉可以覆盖文风配置、产线配额等所有可编辑面板。
 *
 * 五态语义（与此前各页自写的「未保存 tag + 上次保存」等价，但收敛成一处）：
 *   clean   没有改动，不需要保存
 *   dirty   有未保存改动（保存按钮可用）
 *   saving  保存请求进行中（按钮 loading，防重复提交）
 *   saved   已保存（带上一次保存时间更有用，由 hint 传入）
 *   error   保存失败（errorText 说明原因，可重试）
 */
import { computed } from 'vue';

/** 保存五态（组件内类型，页面按同一字符串字面量传入即可） */
type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

const props = withDefaults(
  defineProps<{
    state: SaveState;
    /** 右侧补充说明：上次保存时间、保存范围等，文案由页面组织 */
    hint?: string;
    /** state=error 时的失败原因 */
    errorText?: string;
    /** 保存按钮文案，默认「保存」 */
    saveLabel?: string;
    /** clean 态也显示保存按钮（默认隐藏，避免常挂一个不能点的按钮） */
    alwaysShowSave?: boolean;
  }>(),
  { saveLabel: '保存', alwaysShowSave: false },
);

const emit = defineEmits<{ (e: 'save'): void }>();

const META: Record<SaveState, { text: string; tone: string }> = {
  clean: { text: '无未保存改动', tone: 'idle' },
  dirty: { text: '有未保存改动', tone: 'warn' },
  saving: { text: '保存中…', tone: 'idle' },
  saved: { text: '已保存', tone: 'ok' },
  error: { text: '保存失败', tone: 'bad' },
};

const meta = computed(() => META[props.state]);
const showSave = computed(
  () => props.alwaysShowSave || props.state === 'dirty' || props.state === 'error',
);
</script>

<template>
  <div class="save-bar" :class="`save-bar--${state}`" role="status" aria-live="polite">
    <span class="save-dot" :class="`save-dot--${meta.tone}`" aria-hidden="true" />
    <span class="save-text">{{ meta.text }}</span>
    <span v-if="errorText && state === 'error'" class="save-detail">{{ errorText }}</span>
    <span v-else-if="hint" class="save-hint">{{ hint }}</span>

    <span class="save-spacer" />

    <!-- 页面自定义动作（如「恢复默认」）放这里，保持与保存按钮同一行 -->
    <slot />

    <el-button
      v-if="showSave || state === 'saving'"
      type="primary"
      size="small"
      :loading="state === 'saving'"
      :disabled="state === 'saving'"
      @click="emit('save')"
    >
      {{ saveLabel }}
    </el-button>
  </div>
</template>

<style scoped>
.save-bar {
  display: flex;
  align-items: center;
  gap: var(--wb-space-2);
  flex-wrap: wrap;
  min-width: 0;
  font-size: var(--wb-fs-aux);
  color: var(--wb-text-secondary);
}

.save-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--wb-text-muted);
}

.save-dot--warn {
  background: var(--wb-warning);
}

.save-dot--ok {
  background: var(--wb-success);
}

.save-dot--bad {
  background: var(--wb-danger);
}

.save-text {
  color: var(--wb-text);
  flex: none;
}

.save-bar--dirty .save-text {
  color: var(--wb-warning);
  font-weight: 600;
}

.save-bar--error .save-text {
  color: var(--wb-danger);
  font-weight: 600;
}

.save-detail {
  color: var(--wb-danger);
  min-width: 0;
  word-break: break-word;
}

.save-hint {
  color: var(--wb-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.save-spacer {
  flex: 1 1 auto;
}
</style>
