/**
 * 模型配置备份恢复（smoke:models -- --force 的反向操作）。
 *   npm run restore:models -- prisma/models-backup-<ts>.json
 *
 * 把备份文件里的 LlmModel / ModelBinding 原样回灌（含 apiKeyEnc 密文，
 * 用 Buffer.from(row.apiKeyEnc.data) 还原 Buffer）。已存在的同 modelId 模型跳过不覆盖。
 */

import * as fs from 'node:fs';

import { prisma } from '../src/db.ts';

interface BackupFile {
  models: Array<Record<string, unknown> & { modelId: string; apiKeyEnc?: unknown }>;
  bindings: Array<Record<string, unknown> & { role: string; modelId: number }>;
}

/** Prisma Bytes 经 JSON.stringify 会变成 { type:'Buffer', data:[...] }，这里还原。 */
function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v && typeof v === 'object' && 'data' in (v as object)) {
    return Buffer.from((v as { data: number[] }).data);
  }
  return Buffer.alloc(0);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：npm run restore:models -- <备份文件.json>');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile;
  const idMap = new Map<number, number>(); // 旧 id → 新 id（绑定要重映射）

  for (const row of raw.models) {
    const modelId = row.modelId as string;
    const exists = await prisma.llmModel.findFirst({ where: { modelId } });
    if (exists) {
      console.log(`跳过「${row.name}」：modelId=${modelId} 已存在（不覆盖）`);
      idMap.set(row.id as number, exists.id);
      continue;
    }
    const created = await prisma.llmModel.create({
      data: {
        name: row.name as string,
        vendor: row.vendor as string,
        protocol: row.protocol as string,
        capability: row.capability as string,
        baseUrl: row.baseUrl as string,
        modelId,
        apiKeyEnc: toBuffer(row.apiKeyEnc),
        apiKeyMask: (row.apiKeyMask as string) ?? '',
        paramsJson: row.paramsJson as string,
        enabled: Boolean(row.enabled),
      },
    });
    idMap.set(row.id as number, created.id);
    console.log(`已恢复模型 #${created.id}：${row.name}`);
  }

  for (const b of raw.bindings) {
    const newModelId = idMap.get(b.modelId);
    if (!newModelId) continue;
    await prisma.modelBinding.upsert({
      where: { role: b.role },
      create: { role: b.role, modelId: newModelId },
      update: { modelId: newModelId },
    });
    console.log(`已恢复绑定 ${b.role} → #${newModelId}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
