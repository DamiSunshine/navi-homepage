/* 临时脚本：截取部署指南 HTML 版面（近似 PDF 效果） */
"use strict";
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } }); // A4 @96dpi
  const htmlPath = path.join(__dirname, "..", "docs", "docker-guide.html");
  await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle" });
  await page.screenshot({ path: "test/doc-preview.png", fullPage: true });
  await browser.close();
  console.log("截图完成");
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
