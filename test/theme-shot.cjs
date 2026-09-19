/* 临时脚本：截取首页日间/夜间两种主题各一张图，供效果核验 */
"use strict";
const { chromium } = require("playwright");

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const BASE = process.argv[2] || "http://127.0.0.1:8632";

  // 夜间
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });
  await page.evaluate(() => localStorage.removeItem("navi-theme"));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });
  await page.screenshot({ path: "test/theme-dark.png", fullPage: false });

  // 日间
  await page.click("#themeToggle");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test/theme-light.png", fullPage: false });

  await browser.close();
  console.log("截图完成");
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
