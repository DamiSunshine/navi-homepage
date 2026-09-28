/*
 * 生成 fnOS 应用包图标（ICON.PNG 64×64 / ICON_256.PNG 256×256）。
 *
 * 为什么单独写脚本而不是手放两张图：
 *   fnOS 对包图标有硬性要求（正方形画布、圆角矩形主体、sRGB、≤1024KB、64px 下仍可辨），
 *   手工导出很容易忘了某个尺寸或改了品牌色后两边不一致。这里用项目已有的 Playwright
 *   把 public/favicon.svg 的同款图形按两个尺寸各渲染一次，保证「同一视觉、两种尺寸」。
 *
 * 用法（需要 NODE_PATH 指向含 playwright 的 node_modules）：
 *   NODE_PATH=<.../node_modules> node scripts/build-fpk-icon.cjs
 *
 * 产物：
 *   deploy/fnos/ICON.PNG              64×64
 *   deploy/fnos/ICON_256.PNG          256×256
 *   deploy/fnos/app/ui/images/icon_64.png     （桌面入口图标）
 *   deploy/fnos/app/ui/images/icon_256.png
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FNOS = path.join(ROOT, "deploy", "fnos");
const UI_IMAGES = path.join(FNOS, "app", "ui", "images");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error("未找到 playwright。请设置 NODE_PATH 指向含 playwright 的 node_modules 后重试。");
  process.exit(1);
}

// 图形取自 public/favicon.svg（指南针 = 导航），底色用站点主色 #4f8cff 的渐变。
function htmlFor(size) {
  const radius = Math.round(size * 0.22); // 圆角矩形主体，避免"直角满铺"
  const glyph = Math.round(size * 0.58);
  const inner = Math.round(size * 0.03);
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; }
  .icon {
    width: ${size}px; height: ${size}px; box-sizing: border-box; padding: ${inner}px;
    border-radius: ${radius}px;
    background: linear-gradient(135deg, #5b9dff 0%, #2f6be0 100%);
    display: grid; place-items: center;
  }
  svg { width: ${glyph}px; height: ${glyph}px; display: block; }
</style>
<div class="icon">
  <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="#ffffff"></polygon>
  </svg>
</div>`;
}

async function render(browser, size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(htmlFor(size), { waitUntil: "load" });
  // 注意：Playwright 只按小写扩展名推断图片格式，而 fnOS 要求文件名是全大写的
  // ICON.PNG —— 所以先截到 .png，再改名为 .PNG。
  const tmp = out + ".tmp.png";
  await page.screenshot({ path: tmp, omitBackground: true });
  await page.close();
  fs.renameSync(tmp, out);
  const bytes = fs.statSync(out).size;
  const kb = (bytes / 1024).toFixed(1);
  const ok = bytes <= 1024 * 1024;
  console.log((ok ? "  ✓ " : "  ✗ ") + path.relative(ROOT, out) + "  " + size + "×" + size + "  " + kb + " KB");
  return ok;
}

(async () => {
  fs.mkdirSync(UI_IMAGES, { recursive: true });
  const browser = await chromium.launch();
  try {
    const results = [];
    results.push(await render(browser, 256, path.join(FNOS, "ICON_256.PNG")));
    results.push(await render(browser, 64, path.join(FNOS, "ICON.PNG")));
    // 桌面入口图标与包图标保持同一视觉
    fs.copyFileSync(path.join(FNOS, "ICON_256.PNG"), path.join(UI_IMAGES, "icon_256.png"));
    fs.copyFileSync(path.join(FNOS, "ICON.PNG"), path.join(UI_IMAGES, "icon_64.png"));
    console.log("  ✓ app/ui/images/icon_64.png、icon_256.png 已同步");
    if (results.some((r) => !r)) {
      console.error("存在体积超限的图标（fnOS 要求 ≤1024KB）");
      process.exit(1);
    }
    console.log("图标生成完成。");
  } finally {
    await browser.close();
  }
})();
