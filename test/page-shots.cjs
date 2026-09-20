/* 首页效果图生成（供 preview.html / share/ 使用，可重复运行）

   用法：NODE_PATH=<含 playwright 的 node_modules> node test/page-shots.cjs

   产物：
     test/ui-home.png     首页总览（夜间主题，默认主题）
     test/theme-dark.png  夜间主题
     test/theme-light.png 日间主题

   说明：
     · 自带隔离实例（临时 config + 临时 uploads 的副本），不写真实数据；
     · 刻意**不**伪造 /api/status —— 这些图对外标注为「真实运行截图」，
       状态板在该机器上取不到 Docker 就如实显示「不可用」，不修图。
*/
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const PORT = 8638;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navi-shot-"));
  fs.mkdirSync(path.join(tmp, "uploads"), { recursive: true });
  // 用仓库里真实的 config.json 内容出图（只读复制，截图过程不会写回）
  const realCfg = path.join(ROOT, "public", "config.json");
  const exampleCfg = path.join(ROOT, "public", "config.example.json");
  fs.copyFileSync(fs.existsSync(realCfg) ? realCfg : exampleCfg, path.join(tmp, "config.json"));

  const srv = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: "127.0.0.1",
      NAVI_CONFIG_PATH: path.join(tmp, "config.json"),
      NAVI_UPLOAD_DIR: path.join(tmp, "uploads"),
      NAVI_SCAN_LOCAL: "0", NAVI_ICON_PROBE: "0"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("服务启动超时")), 15000);
    srv.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(t); res(); }
    });
  });

  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // 主题跟随系统偏好（本机是 light）→ 显式写入 dark，保证「首页总览 / 夜间主题」两张图名副其实
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("navi-theme", "dark"));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });
  // 等状态板拿到数据再截图，避免截到半截的占位符
  await page.waitForFunction(() => window.NaviApp && window.NaviApp.status().hasData === true, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, "ui-home.png") });
  await page.screenshot({ path: path.join(__dirname, "theme-dark.png") });

  await page.click("#themeToggle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, "theme-light.png") });

  await browser.close();
  try { srv.kill(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log("截图完成：ui-home.png / theme-dark.png / theme-light.png");
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
