<script setup lang="ts">
/**
 * 用户管理（admin 专属）：审批注册、改角色/状态/有效期/配额、吊销会话。
 * 预留「订阅付费自动开通」口子——届时由支付回调自动 approve，本页只做人工通道。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { errMsg } from '../api/http.ts';
import { approveUser, listUsers, patchUser } from '../api/index.ts';
import type { UserAdminItem } from '../types.ts';

const users = ref<UserAdminItem[]>([]);
const loading = ref(false);
const filter = ref<'all' | 'pending'>('pending');

const shown = computed(() =>
  filter.value === 'pending' ? users.value.filter((u) => u.status === 'pending') : users.value,
);

const ROLE_TEXT: Record<string, string> = { admin: '管理员', member: '客户', guest: '游客' };
const STATUS_TEXT: Record<string, string> = { pending: '待审批', active: '正常', disabled: '已停用' };

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await listUsers();
    users.value = r.users;
  } catch (e) {
    ElMessage.error(errMsg(e, '加载失败'));
  } finally {
    loading.value = false;
  }
}

async function approve(u: UserAdminItem): Promise<void> {
  try {
    await approveUser(u.id);
    ElMessage.success(`已审批：${u.username} → 客户`);
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '审批失败'));
  }
}

async function setRole(u: UserAdminItem, role: string): Promise<void> {
  try {
    await patchUser(u.id, { role: role as 'admin' | 'member' | 'guest' });
    ElMessage.success('角色已更新');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '修改失败'));
  }
}

async function setStatus(u: UserAdminItem, status: string): Promise<void> {
  try {
    await patchUser(u.id, { status: status as 'pending' | 'active' | 'disabled' });
    ElMessage.success('状态已更新');
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e, '修改失败'));
  }
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '永久';
  return new Date(v).toLocaleDateString('zh-CN');
}

onMounted(load);
</script>

<template>
  <div class="users-page">
    <div class="toolbar">
      <el-radio-group v-model="filter" size="small">
        <el-radio-button value="pending">待审批</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-table :data="shown" v-loading="loading" stripe>
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column prop="role" label="角色" width="90">
        <template #default="{ row }">{{ ROLE_TEXT[row.role] ?? row.role }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : 'info'">
            {{ STATUS_TEXT[row.status] ?? row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="有效期至" width="110">
        <template #default="{ row }">{{ fmtDate(row.expiresAt) }}</template>
      </el-table-column>
      <el-table-column label="公众号配额" width="100">
        <template #default="{ row }">{{ row.oaAccountCount }} / {{ row.maxOAAccounts }}</template>
      </el-table-column>
      <el-table-column prop="createdAt" label="注册时间" width="110">
        <template #default="{ row }">{{ fmtDate(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="220" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="approve(row)">审批通过</el-button>
          <el-select
            :model-value="row.role"
            size="small"
            style="width: 88px; margin: 0 6px"
            @change="(v: string) => setRole(row, v)"
          >
            <el-option v-for="(label, value) in ROLE_TEXT" :key="value" :label="label" :value="value" />
          </el-select>
          <el-button
            v-if="row.status !== 'disabled'"
            size="small"
            type="danger"
            plain
            @click="setStatus(row, 'disabled')"
          >停用</el-button>
          <el-button v-else size="small" @click="setStatus(row, 'active')">启用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <p class="hint">
      开放注册 + 管理员审批：新用户默认「游客/待审批」，审批后升「客户」。订阅有效期为付费预留字段（永久=不限）。
    </p>
  </div>
</template>

<style scoped>
.users-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-secondary, #909399);
}
</style>
