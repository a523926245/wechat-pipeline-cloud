/**
 * 把本机 ~/.imagegen.env 里的 Key 配成本地开发用的模型（写作 + 漫画格生图）。
 *
 * 为什么需要它：`npm run smoke:models --force` 会清空模型表（列表断言要求空表），
 * 跑一次冒烟就把浏览器里配好的模型和角色绑定删光了。本脚本把开发环境一键恢复回来。
 *
 * 幂等：同一个 modelId 已存在则复用（补齐 Key/地址/绑定），不会重复建行。
 * 缺 Key 的模型直接跳过（只配有的），不报错。
 *
 * 跑法：npm run model:local
 * 可选环境变量：
 *   AGNES_API_KEY / AGNES_BASE_URL / AGNES_MODEL
 *   MODELSCOPE_API_TOKEN
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { encryptSecret } from '../src/lib/crypto.ts';
import { prisma } from '../src/db.ts';
import { packJson } from '../src/db-json.ts';
import { testModel } from '../src/services/llm.ts';
import type { Role } from '../src/services/model-registry.ts';

const ENV_FILE = join(homedir(), '.imagegen.env');

/** 环境变量优先，其次读 ~/.imagegen.env（与本机其它脚本共用同一份 Key）。 */
function readToken(key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.trimStart().startsWith(`${key}=`));
  const v = line?.split('=')[1]?.trim();
  return v && v.length > 0 ? v : undefined;
}

interface ModelSpec {
  key: 'AGNES_API_KEY' | 'MODELSCOPE_API_TOKEN';
  name: string;
  vendor: string;
  protocol: string;
  capability: 'text' | 'image';
  baseUrl: string;
  modelId: string;
  role: Role;
  params: Record<string, unknown>;
}

/**
 * 本地开发要的模型清单。
 *
 * ⚠️ Qwen Image 的 gradio 接口名**必须按模型配置**（`gradioApiName`）：
 * 2-0-pro 暴露的是 generate_image，2-1 是 generate_with_enhance，
 * 参数名也不一样（prompt_extend / edit_custom_size vs enable_extend / custom_size）。
 * 代码已改成按参数名映射，但接口名仍需逐个声明。
 */
const SPECS: ModelSpec[] = [
  {
    key: 'AGNES_API_KEY',
    name: 'Agnes 3.0 Flash（本地）',
    vendor: 'agnes',
    protocol: 'openai_chat',
    capability: 'text',
    baseUrl: process.env.AGNES_BASE_URL ?? 'https://api.agnes-ai.cn/v1',
    modelId: process.env.AGNES_MODEL ?? 'agnes-3.0-flash',
    role: 'write',
    params: {},
  },
  {
    key: 'MODELSCOPE_API_TOKEN',
    name: 'Qwen Image 2.0 Pro（魔搭）',
    vendor: 'modelscope',
    protocol: 'modelscope_qwen_image',
    capability: 'image',
    baseUrl: process.env.MODELSCOPE_BASE_URL ?? 'https://studio-qwen-qwen-image-2-0-pro.api-inference.modelscope.net',
    modelId: 'qwen-image-2-0-pro',
    role: 'comic_panel',
    params: { gradioApiName: 'generate_image', genWidth: 1344, genHeight: 768, ratio: '16:9' },
  },
  {
    key: 'MODELSCOPE_API_TOKEN',
    name: 'Qwen Image 2.0 Pro（魔搭·MCP 备选）',
    vendor: 'modelscope',
    protocol: 'modelscope_qwen_image_mcp',
    capability: 'image',
    baseUrl: process.env.MODELSCOPE_BASE_URL ?? 'https://studio-qwen-qwen-image-2-0-pro.api-inference.modelscope.net',
    modelId: 'qwen-image-2-0-pro-mcp',
    role: 'comic_panel_fallback',
    params: { gradioApiName: 'generate_image', genWidth: 1344, genHeight: 768, ratio: '16:9' },
  },
];

async function main(): Promise<void> {
  let configured = 0;
  let skipped = 0;

  for (const spec of SPECS) {
    const apiKey = readToken(spec.key);
    if (!apiKey) {
      console.log(`跳过「${spec.name}」：${spec.key} 未配置`);
      skipped += 1;
      continue;
    }

    const data: Record<string, unknown> = {
      name: spec.name,
      vendor: spec.vendor,
      protocol: spec.protocol,
      capability: spec.capability,
      baseUrl: spec.baseUrl,
      modelId: spec.modelId,
      apiKeyEnc: encryptSecret(apiKey),
      apiKeyMask: `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`,
      enabled: true,
      paramsJson: packJson(spec.params),
    };

    const found = await prisma.llmModel.findFirst({ where: { modelId: spec.modelId } });
    if (found) {
      // ⚠️ 不覆写库里已有的非空 Key（2026-11-11 教训：本脚本曾把用户在界面改过的 Key
      // 静默回写成 env 令牌——「密匙被覆盖」）。env 令牌只在库里 Key 为空时才补。
      if (found.apiKeyEnc && found.apiKeyEnc.length > 0) {
        delete data.apiKeyEnc;
        delete data.apiKeyMask;
        console.log('  保留界面已配置的 API Key（不回写 env 令牌）');
      }
    }
    const model = found
      ? await prisma.llmModel.update({ where: { id: found.id }, data })
      : await prisma.llmModel.create({ data: data as never });
    console.log(`${found ? '已更新' : '已建立'}模型 #${model.id}：${spec.name}`);

    const bound = await prisma.modelBinding.findUnique({ where: { role: spec.role } });
    if (bound?.modelId === model.id) {
      console.log(`  ${spec.role} 角色已绑定`);
    } else {
      if (bound) await prisma.modelBinding.delete({ where: { role: spec.role } });
      await prisma.modelBinding.create({ data: { role: spec.role, modelId: model.id } as never });
      console.log(`  已绑定到 ${spec.role} 角色`);
    }
    configured += 1;
  }

  if (configured > 0) {
    console.log('\n连通测试…');
    for (const spec of SPECS) {
      const model = await prisma.llmModel.findFirst({ where: { modelId: spec.modelId } });
      if (!model) continue;
      const r = await testModel(model);
      console.log(`  ${spec.name}：${r.ok ? `连通成功 ${r.sample ?? ''}` : `连通失败 ${r.message}`}`);
      if (!r.ok) process.exitCode = 1;
    }
  }
  console.log(`\n完成：配置 ${configured} 个，跳过 ${skipped} 个`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('配置失败：', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
