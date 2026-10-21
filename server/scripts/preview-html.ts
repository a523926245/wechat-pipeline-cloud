/**
 * 生成「人工预览页」：把一篇草稿按微信渲染稿包进页面外壳，方便肉眼比对排版。
 *
 * ⚠️ 只用于人工查看，**不参与推送**。正文部分仍然来自 `composeArticle()`
 * （与推送共用同一渲染函数），所以在这里看到的排版 = 发出去的排版；
 * 页面外壳（底色、白卡、复制按钮）在 `data-copy` 之外，不会被复制进剪贴板。
 *
 * 跑法：
 *   node --experimental-strip-types scripts/preview-html.ts --in=../var/deai/ab-full2.html --out=../var/deai/preview-full2.html
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { composeArticle } from '../src/services/render/index.ts';

const argv = process.argv.slice(2);
const arg = (k: string, def = ''): string =>
  argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? def;

const INK = '#33302C';
const ACCENT = '#B35D3E';
const SUB = '#9A8578';

function main(): void {
  const inPath = arg('in');
  const outPath = arg('out', '../var/deai/preview.html');
  const prefix = arg('prefix', '【话】');
  if (!inPath) throw new Error('必须指定 --in=<html 文件>');

  const raw = readFileSync(inPath, 'utf8');
  const { rendered, warnings } = composeArticle(raw, { titlePrefix: prefix });

  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>排版预览 · ' + escapeHtml(rendered.title) + '</title>',
    '</head>',
    `<body style="margin:0;background:${ACCENT}14;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">`,

    `<div style="background:#2E2A26;color:#F3EDE7;padding:10px 14px;text-align:center;font-size:13px;letter-spacing:.5px;">`,
    '预览外壳（不会进入复制内容）',
    '<button onclick="copyArticle()" style="margin-left:12px;padding:4px 14px;border:0;border-radius:4px;background:#B35D3E;color:#fff;font-size:13px;cursor:pointer;">一键复制全文</button>',
    '</div>',

    `<div style="max-width:677px;margin:20px auto;background:#FFFFFF;border-radius:8px;padding:26px 20px 34px;">`,
    `<h1 style="font-size:23px;font-weight:700;color:${INK};line-height:1.5;margin:0 0 8px;">${escapeHtml(rendered.title)}</h1>`,
    `<p style="margin:0 0 22px;font-size:14px;color:${SUB};line-height:1.7;">${escapeHtml(rendered.digest)}</p>`,
    `<div id="article" data-copy="1">${rendered.contentWechat}</div>`,
    '</div>',

    '<script>',
    'function copyArticle(){',
    '  var n=document.getElementById("article");',
    '  var r=document.createRange(); r.selectNodeContents(n);',
    '  var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);',
    '  try{document.execCommand("copy");}catch(e){}',
    '  s.removeAllRanges();',
    '}',
    '<\/script>',

    '</body></html>',
  ].join('\n');

  writeFileSync(outPath, html, 'utf8');
  console.log(`已生成 ${outPath}`);
  console.log(`标题 ${rendered.title} · 小标题 ${rendered.h2Count} · 段落 ${rendered.pCount} · 字数 ${rendered.charCount}`);
  if (warnings.length > 0) console.log(`解析告警 ${warnings.join('；')}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main();
