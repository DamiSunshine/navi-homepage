/* Navi 导航站 · 登录页（用户名 + 密码）浏览器端测试
   自动启动带 NAVI_USERNAME + NAVI_PASSWORD 的实例，用本机 Edge/Chrome 内核验证：
     - 登录页在 requireUsername 时显示用户名字段
     - 错误用户名/密码给出统一提示，正确组合才能进入
   用法：NODE_PATH=<managed_workspace>/node_modules node test/ui-auth.test.cjs */
"use strict";

const { chromium } = require("playwright");
const path = require("path");
const { spawn } = require("child_process");

const USERNAME = "admin";
const PASSWORD = "ui-auth-pass";
const PORT = 8655;
const BASE = "http://127.0.0.1:" + PORT;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(PORT), NAVI_USERNAME: USERNAME, NAVI_PASSWORD: PASSWORD }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

(async () => {
  console.log("启动带用户名+密码认证的测试实例（端口 " + PORT + "）…");
  const srv = await startServer();

  let browser;
  try {
    try { browser = await chromium.launch({ channel: "msedge" }); }
    catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
    const page = await browser.newPage();

    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    console.log("== 登录页（requireUsername） ==");
    await page.goto(BASE + "/login.html", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#usernameField", { timeout: 10000 });

    check("登录页显示用户名字段（requireUsername）", await page.locator("#usernameField").isVisible());
    check("用户名字段标记为必填", await page.locator("#username").getAttribute("required") !== null);

    // 错误组合：正确用户名 + 错误密码
    await page.fill("#username", USERNAME);
    await page.fill("#password", "wrong-pass");
    await page.click("#loginBtn");
    await page.waitForTimeout(400);
    const tipWrong = await page.locator("#errorTip").textContent();
    check("错误密码 -> 提示『用户名或密码错误』",
      await page.locator("#errorTip.show").count() === 1 && tipWrong.indexOf("用户名或密码错误") !== -1,
      tipWrong);
    check("登录失败仍停留在登录页", page.url().indexOf("/login.html") !== -1);

    // 错误用户名 + 正确密码
    await page.fill("#username", "bad-user");
    await page.fill("#password", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForTimeout(400);
    check("错误用户名 -> 同样提示『用户名或密码错误』（不区分项）",
      (await page.locator("#errorTip").textContent()).indexOf("用户名或密码错误") !== -1);

    // 正确组合
    await page.fill("#username", USERNAME);
    await page.fill("#password", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForSelector(".card", { timeout: 10000 });
    check("正确用户名+密码 -> 进入首页并渲染卡片",
      page.url().indexOf("/login.html") === -1 && (await page.locator(".card").count()) > 0,
      page.url());

    console.log("== 登录后访问 ==");
    const cfg = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
    check("登录后可读取 /api/config", Array.isArray(cfg.groups) && cfg.groups.length > 0,
      JSON.stringify(cfg).slice(0, 80));

    console.log("== 页面错误 ==");
    const fatal = pageErrors.filter((e) => !/net::|Failed to load resource|ERR_INTERNET|favicon/i.test(e));
    check("无 JS 运行时错误", fatal.length === 0, fatal.join(" | ").slice(0, 200));

    await browser.close();
  } finally {
    srv.kill();
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
