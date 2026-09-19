/* 临时脚本：启动带密码实例并截取登录页效果图 */
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, { PORT: "8645", NAVI_PASSWORD: "demo-shot" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((res) => srv.stdout.on("data", (d) => {
    if (String(d).includes("listening")) res();
  }));

  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.goto("http://127.0.0.1:8645/login.html");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test/ui-login.png" });

  // 再验证一次真实登录跳转
  await page.fill("#password", "demo-shot");
  await page.click("#loginBtn");
  await page.waitForURL("**/", { timeout: 5000 });
  await page.waitForSelector(".card", { timeout: 8000 });
  console.log("浏览器端登录跳转验证: PASS（登录后进入首页，卡片已渲染）");

  await browser.close();
  srv.kill();
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
