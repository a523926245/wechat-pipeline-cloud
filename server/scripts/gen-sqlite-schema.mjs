/**
 * 从 prisma/schema.prisma（MySQL 真源）生成等价的 SQLite 版本。
 *
 * 目的：本地没有 MySQL 时也能跑起来做开发验证，同时只需要维护一份 schema。
 * SQLite 不支持 enum / Json / @db.* 原生类型注解，这里统一降级为 String。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'prisma', 'schema.prisma');
const dst = join(here, '..', 'prisma', 'schema.sqlite.prisma');

let text = readFileSync(src, 'utf8');

// 1. 收集所有 enum 名称
const enumNames = [];
const enumBlockRe = /enum\s+(\w+)\s*\{[^}]*\}/g;
for (const m of text.matchAll(enumBlockRe)) {
  enumNames.push(m[1]);
}

// 2. 删除 enum 定义块
text = text.replace(enumBlockRe, '');

// 3. enum 字段类型降级为 String，并把 @default(值) 的值加上引号
for (const name of enumNames) {
  const typeRe = new RegExp(`(\\b\\w+\\s+)${name}\\b(\\??)`, 'g');
  text = text.replace(typeRe, (_all, prefix, optional) => `${prefix}String${optional === '?' ? '?' : ''}`);
}
// @default(ok) → @default("ok")，仅处理刚才降级的枚举默认值
const enumValues = new Set();
for (const name of enumNames) {
  void name;
}
text = text.replace(/@default\(([a-z_][a-z0-9_]*)\)(?=\s*(?:\n|@|\/\/))/g, (all, val) => {
  // 排除布尔与函数式默认值，只处理看起来像枚举值的裸标识符
  if (['true', 'false', 'now', 'autoincrement', 'cuid', 'uuid'].includes(val)) return all;
  enumValues.add(val);
  return `@default("${val}")`;
});

// 4. Json → String
text = text.replace(/(\b\w+\s+)Json\??/g, (_all, prefix) => `${prefix}String?`);

// 5. 去掉 MySQL 原生类型注解
text = text.replace(/@db\.(?:Text|LongText|MediumText|VarChar\(\d+\)|TinyInt|DateTime\(\d*\))/g, '');

// 6. provider 换成 sqlite
text = text.replace(/provider\s*=\s*"mysql"/, 'provider = "sqlite"');

// 7. 清理多余空行与尾随空格
text = text
  .split('\n')
  .map((l) => l.replace(/\s+$/, ''))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');

const header = `// 自动生成，请勿手工编辑。\n// 源：prisma/schema.prisma（MySQL 真源），由 scripts/gen-sqlite-schema.mjs 生成。\n// 本地开发用（SQLite），生产请用 MySQL 版。\n\n`;

writeFileSync(dst, header + text.trim() + '\n', 'utf8');
console.log(`[schema] 已生成 ${dst}`);
console.log(`[schema] 降级处理：enum(${enumNames.length}) → String，Json → String，@db.* 注解已移除`);
