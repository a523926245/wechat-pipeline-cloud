/**
 * 金句卡渲染：HTML/CSS 按模板参数排版 → headless Chrome 截图 1080×540 JPG。
 *
 * 版式逐项复刻 skill 的 generate_text_cards.py（Pillow）：
 * 白底垂直居中、标题 52px #2c3e50 粗体、阐释 30px #7f8c8d、间距 50px。
 * 与未来视频产线的 Remotion/headless 渲染共用「本机 Chrome」这一基建；
 * Chrome 路径：CHROME_PATH 环境变量 → 常见安装位置探测。
 *
 * 字体：Windows 依赖系统微软雅黑；Linux 服务器需安装 Noto Sans CJK SC /
 * Source Han Sans（见 deploy/README.md），否则中文会 fallback 到默认字体。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BadRequestError } from '../../errors.ts';
import { logger } from '../../logger.ts';
import { loadComicTemplates } from '../comic/script.ts';

type Puppeteer = typeof import('puppeteer-core');

let puppeteerMod: Puppeteer | null = null;
let executablePath: string | null | undefined; // undefined=未探测, null=没找到

const HERE = dirname(fileURLToPath(import.meta.url));
const CHEESE_FONT_PATH = join(HERE, 'assets', 'cheese-font.ttf');

let cheeseFontDataUri: string | null | undefined; // undefined=未读, null=缺文件

/**
 * 打包奶酪体的 data URI。不能直接用 pathToFileURL 的 file:// 地址：
 * setContent 建的页面（about:blank 源）会拒绝加载 file:// 子资源（实测
 * "Not allowed to load local resource"），字体静默 fallback。内联成 data URI
 * 则与页面源无关，Windows/Linux 都可加载。
 */
function cheeseFontDataUriOrNull(): string | null {
  if (cheeseFontDataUri !== undefined) return cheeseFontDataUri;
  if (!existsSync(CHEESE_FONT_PATH)) {
    cheeseFontDataUri = null;
    return null;
  }
  cheeseFontDataUri = `data:font/ttf;base64,${readFileSync(CHEESE_FONT_PATH).toString('base64')}`;
  return cheeseFontDataUri;
}

const CHROME_CANDIDATES =
  process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/msedge',
      ];

function resolveChrome(): string | null {
  if (executablePath !== undefined) return executablePath;
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    executablePath = fromEnv;
    return executablePath;
  }
  executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
  return executablePath;
}

async function getPuppeteer(): Promise<Puppeteer> {
  if (puppeteerMod) return puppeteerMod;
  const chrome = resolveChrome();
  if (!chrome) {
    throw new BadRequestError(
      '未找到 Chrome/Edge（金句卡渲染需要）。请设置 CHROME_PATH 指向 chrome 可执行文件',
    );
  }
  puppeteerMod = (await import('puppeteer-core')) as Puppeteer;
  return puppeteerMod;
}

export interface QuoteCardSpec {
  headline: string;
  elaboration: string;
  outPath: string;
  width?: number;
  height?: number;
  fontFamily?: string;
}

/** 金句卡版式版本号：改字体/版式时 +1，令旧缓存与旧上传态自动失配重生成。 */
export const QUOTE_CARD_VERSION = 2;

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 渲染一张金句卡并落盘。失败抛 BadRequestError。 */
export async function renderQuoteCard(spec: QuoteCardSpec): Promise<void> {
  const tpl = loadComicTemplates().quoteCard;
  const width = spec.width ?? tpl.width;
  const height = spec.height ?? tpl.height;
  const fontFamily = spec.fontFamily ?? tpl.fontFamily;

  // 仓库内打包奶酪体，用 @font-face 显式加载（不依赖系统安装字体，保 Linux 可部署）。
  const fontUri = cheeseFontDataUriOrNull();
  const fontFace = fontUri
    ? `@font-face { font-family: 'CheeseFont'; src: url('${fontUri}') format('truetype'); font-weight: normal; font-style: normal; }`
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${fontFace}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: ${tpl.background};
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    font-family: ${fontFamily};
  }
  .title {
    color: ${tpl.titleColor};
    font-size: ${tpl.titleSize}px;
    font-weight: ${tpl.titleWeight};
    line-height: 1.45;
    text-align: center;
    max-width: 86%;
  }
  .desc {
    color: ${tpl.descColor};
    font-size: ${tpl.descSize}px;
    font-weight: 400;
    line-height: 1.6;
    text-align: center;
    max-width: 86%;
    margin-top: ${tpl.titleDescGap}px;
  }
</style></head><body>
  <div class="title">${escapeHtml(spec.headline)}</div>
  <div class="desc">${escapeHtml(spec.elaboration)}</div>
</body></html>`;

  const chrome = resolveChrome();
  const puppeteer = await getPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: chrome ?? undefined,
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    // 等待字体就绪（@font-face / 系统字体加载），避免截图缺字（字符串表达式：server 端无 DOM lib）
    await page.evaluate('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 50));
    await page.screenshot({ path: spec.outPath, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width, height } });
    if (!existsSync(spec.outPath)) {
      throw new BadRequestError(`金句卡写入失败：${spec.outPath}`);
    }
    logger.info({ out: spec.outPath }, '金句卡已渲染');
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError(`金句卡渲染失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
