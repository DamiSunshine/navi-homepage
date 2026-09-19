/* Navi 导航站 · 日/夜模式切换 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   用法：先启动无鉴权 server.js，再运行
   NODE_PATH=<managed_workspace>/node_modules node test/ui-theme.test.cjs [baseUrl]
   设计：主题初始值跟随系统偏好，因此测试对初始明暗不敏感，只验证"能切换 + 能持久化 + 奇偶次往返一致"。 */
"use strict";

const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const BASE = process.argv[2] || "http://127.0.0.1:8632";

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

const themeAttr = (page) => page.locator("html").getAttribute("data-theme");

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage();
  await stubExternal(page);   // 外部图标 CDN 就地应答，避免网络抖动污染「无 JS 错误」断言
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text()); });

  try {
    // 清掉历史主题记录，验证可无痕初始化（首次 goto 前一次性清除，不污染后续 reload）
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card", { timeout: 10000 });

    console.log("== 主题按钮存在 ==");
    check("主题切换按钮显示", await page.locator("#themeToggle").isVisible());

    const initialState = await themeAttr(page); // null=夜间, "light"=日间
    check("初始为合法主题(夜间=null 或 日间=light)", initialState === null || initialState === "light",
      String(initialState));

    console.log("== 首次切换（应翻转到相反主题）==");
    const savedBefore = await page.evaluate(() => localStorage.getItem("navi-theme"));
    await page.click("#themeToggle");
    const flipped = await themeAttr(page);
    check("点击后主题翻转", (initialState === null ? flipped === "light" : flipped === null),
      "initial=" + initialState + " -> " + flipped);

    const savedAfter = await page.evaluate(() => localStorage.getItem("navi-theme"));
    check("选择已持久化(与翻转后主题一致)",
      (flipped === "light" && savedAfter === "light") || (flipped === null && savedAfter === "dark"),
      "theme=" + flipped + ", saved=" + savedAfter);

    // 翻转后必与之前相反
    check("localStorage 已改变", savedAfter !== savedBefore, savedBefore + " -> " + savedAfter);

    console.log("== 刷新后保持 ==");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card", { timeout: 10000 });
    const afterReload = await themeAttr(page);
    check("刷新后主题保持翻转结果", afterReload === flipped, "expect " + flipped + " got " + afterReload);

    console.log("== 再点一次回到初始 ==");
    await page.click("#themeToggle");
    const back = await themeAttr(page);
    check("二次切换回到初始主题", back === initialState, "expect " + initialState + " got " + back);

    console.log("== 无 JS 错误 ==");
    check("无 JS 运行时错误", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser.close();
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
