/**
 * 列表页「批量删除」的通用逻辑。
 *
 * 各列表页（选题库 / 文章 / 账号 / 赛道 / 模型）的批量删除长得一样：
 * 表格多选 → 顶部出现「已选 N 项 + 批量删除」→ 二次确认 → 调后端 → 刷新列表。
 * 这套流程抽成一个 composable，页面只负责三件事：
 *   1. 表格加 selection 列（带 reserve-selection）并把 selection-change 交给它；
 *   2. 提供「这条资源的删除影响说明」（如"会连带删掉 N 篇文章"）；
 *   3. 传删除完要刷新的 load 函数。
 *
 * 四个容易踩的点，这里已经处理：
 *   - **跨页选择**：表格翻页会重建数据，EP 在没有 row-key/reserve-selection 时
 *     会直接清空勾选。页面要给表格加 row-key + reserve-selection，
 *     这样"第 1 页勾 5 条、翻到第 2 页再勾 5 条"能攒成一次删 10 条。
 *   - **陈旧选择**：改筛选条件后，上一批勾的行不该还留着（EP 内部不会自动清）。
 *     所以筛选变更时页面要调 clearSelection()，它会同时清掉 EP 内部状态。
 *   - **部分失败**：后端逐条独立执行，可能一部分成功一部分失败。
 *     不能只弹一个"操作成功"就完事，失败的 id 与原因要逐条告诉用户。
 *   - **重复提交**：删除期间禁用按钮，避免连点把接口打爆。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, ref, shallowRef, type Ref } from 'vue';

import { errMsg } from '../api/http.ts';
import type { BulkDeleteResult } from '../types.ts';

/** el-table 实例上我们用到的两个方法。 */
interface BatchTableLike {
  clearSelection: () => void;
}

/** 批量删除时需要页面提供的信息。 */
export interface BatchDeleteOptions<T> {
  /** 表格行 → 资源 id。 */
  idOf: (row: T) => number;
  /** 调后端批量删除接口。 */
  api: (ids: number[]) => Promise<BulkDeleteResult>;
  /**
   * 二次确认时展示的影响说明。
   * 接收已选中的行，便于把"其中 3 条已被文章使用"这类具体数字讲清楚。
   */
  impact: (rows: T[]) => string;
  /** 确认框标题，默认「批量删除」。 */
  title?: string;
  /** 删除完成后刷新列表。参数是本次删除的结果（页面可能要据此判断是否要翻页）。 */
  reload: (result: BulkDeleteResult) => Promise<void> | void;
  /**
   * el-table 实例。用于在清空选择时同步清掉 EP 内部状态——
   * 页面用 ref="xxx" 拿到实例后传进来即可（可后传，setup 里先声明 ref）。
   */
  tableRef?: Ref<BatchTableLike | null | undefined>;
}

export function useBatchDelete<T>(options: BatchDeleteOptions<T>) {
  /**
   * 选中的行（真相源，不依赖表格内部状态）。
   *
   * 用 shallowRef：ref 会对泛型 T 做 UnwrapRef 拆包，
   * 对 T = 任意行类型时推导出 UnwrapRefSimple<T>，与回调签名对不上。
   * 行对象本身不需要深层响应式（勾选变化靠整体替换触发），shallowRef 正好。
   */
  const selected = shallowRef<T[]>([]);
  /** 删除进行中：期间禁用按钮，防止重复提交。 */
  const deleting = ref(false);

  const count = computed(() => selected.value.length);

  /** EP 的 selection-change：同步到真相源。 */
  function onSelectionChange(rows: T[]): void {
    selected.value = rows;
  }

  /**
   * 清空选择：同时清掉 EP 内部状态。
   *
   * 只清我们的数组是不够的——EP 内部还留着那些行，
   * 下次 render 时勾选框会显示成"已勾"，用户会以为没清掉。
   */
  function clearSelection(): void {
    selected.value = [];
    options.tableRef?.value?.clearSelection();
  }

  /** 把失败明细拼成可读文本。 */
  function formatFailures(failed: BulkDeleteResult['failed']): string {
    return failed.map((f) => `· #${f.id}：${f.reason}`).join('\n');
  }

  /**
   * 执行批量删除。
   *
   * 流程：二次确认 → 调接口 → 汇总展示 → 刷新列表。
   * 取消确认时不报错，直接返回。
   */
  async function runBatchDelete(): Promise<void> {
    if (deleting.value || selected.value.length === 0) return;

    const rows = [...selected.value];
    const ids = rows.map(options.idOf);

    try {
      await ElMessageBox.confirm(
        `确定删除选中的 ${ids.length} 条吗？\n\n${options.impact(rows)}`,
        options.title ?? '批量删除',
        {
          type: 'warning',
          confirmButtonText: `删除 ${ids.length} 条`,
          cancelButtonText: '取消',
          confirmButtonClass: 'el-button--danger',
        },
      );
    } catch {
      return; // 用户取消
    }

    deleting.value = true;
    try {
      const res = await options.api(ids);
      // 先清勾选再刷新：EP 的 reserve-selection 会把已删的行留在内部状态里
      clearSelection();

      if (res.failed.length > 0) {
        // 部分失败：成功与失败都要讲清楚，别让用户以为全删掉了
        ElMessageBox.alert(
          `${res.message}\n\n未删除的条目：\n${formatFailures(res.failed)}`,
          '批量删除完成（有失败项）',
          { type: 'warning', confirmButtonText: '知道了' },
        );
      } else {
        ElMessage.success(res.message);
      }

      await options.reload(res);
    } catch (e) {
      ElMessage.error(errMsg(e, '批量删除失败'));
    } finally {
      deleting.value = false;
    }
  }

  return {
    selected,
    count,
    deleting,
    onSelectionChange,
    clearSelection,
    runBatchDelete,
  };
}
