/* Navi 导航站 · 浏览器端 UI 测试（Playwright + 本机 Edge 内核）
   用法：先启动 server.js，再运行
   NODE_PATH=<managed_workspace>/node_modules node test/ui.test.cjs [baseUrl] */
"use strict";

const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const BASE = process.argv[2] || "http://127.0.0.1:8632";

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge" });
  } catch (e) {
    browser = await chromium.launch({ channel: "chrome" });
  }
  const page = await browser.newPage();
  await stubExternal(page);   // 外部图标 CDN 就地应答，避免网络抖动污染「无 JS 错误」断言

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text()); });

  // 记录初始卡片数（自动读取 API 配置）
  const apiCfg = await (await fetch(BASE + "/api/config")).json();
  const initialCount = apiCfg.groups.reduce((n, g) => n + g.items.length, 0);

  console.log("== 页面渲染 ==");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });

  check("标题正确", (await page.title()).indexOf("Navi") !== -1, await page.title());
  check("导航卡片数量 = " + initialCount, (await page.locator(".card").count()) === initialCount);
  check("分组数量 = " + apiCfg.groups.length,
    (await page.locator(".group").count()) === apiCfg.groups.length);
  const clock = await page.locator("#clock").textContent();
  check("时钟运行", /^\d{2}:\d{2}:\d{2}$/.test(clock.trim()), clock);
  check("默认外网模式", (await page.locator("#netLabel").textContent()).trim() === "外网");
  const iconCount = await page.locator(".card-icon img, .card-icon .icon-fallback").count();
  check("图标均已解析（图片或字母回退）", iconCount === initialCount, String(iconCount));

  console.log("== 内外网切换 ==");
  await page.click("#netToggle");
  check("切换后为内网模式", (await page.locator("#netLabel").textContent()).trim() === "内网");
  check("body 应用 lan-mode", await page.locator("body.lan-mode").count() === 1);
  const lanHref = await page.locator('.card[data-has-lan="true"]').first().getAttribute("href");
  const lanItem = null;
  const anyLan = apiCfg.groups.flatMap((g) => g.items).find((i) => i.lanUrl);
  check("内网链接已切换为 lanUrl", lanHref === anyLan.lanUrl, lanHref);
  await page.click("#netToggle");
  check("切回外网模式", (await page.locator("#netLabel").textContent()).trim() === "外网");

  console.log("== 搜索过滤 ==");
  await page.fill("#searchInput", "jelly");
  await page.waitForTimeout(200);
  check("搜索 jelly -> 仅 1 张卡片", (await page.locator(".card").count()) === 1,
    String(await page.locator(".card").count()));
  await page.fill("#searchInput", "");
  await page.waitForTimeout(200);
  check("清空搜索恢复全部", (await page.locator(".card").count()) === initialCount);

  console.log("== 编辑模式 ==");
  await page.click("#editToggle");
  check("保存栏显示", await page.locator("#saveBar").isVisible());
  check("添加分组按钮显示", await page.locator("#addGroupBtn").isVisible());
  check("卡片可拖拽", (await page.locator(".card").first().getAttribute("draggable")) === "true");

  // 添加导航项
  await page.locator('[data-act="add-item"]').first().click();
  check("添加弹窗打开", await page.locator("#itemModal").isVisible());
  await page.fill('#itemForm [name="title"]', "UI测试项");
  await page.fill('#itemForm [name="desc"]', "自动化测试添加");
  await page.fill('#itemForm [name="url"]', "https://test.example.com");
  await page.fill('#itemForm [name="lanUrl"]', "http://192.168.99.99:9000");
  await page.fill('#itemForm [name="icon"]', "iconify:simple-icons:testcafe");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(200);
  check("添加后卡片数 +1", (await page.locator(".card").count()) === initialCount + 1);

  // 编辑刚添加的项（改名）
  const newCard = page.locator('.card:has-text("UI测试项")');
  await newCard.locator('[data-act="edit-item"]').click();
  await page.fill('#itemForm [name="title"]', "UI测试项-改");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(200);
  check("修改后标题生效", (await page.locator('.card:has-text("UI测试项-改")').count()) === 1);

  // 保存写回服务器
  await page.click("#saveBtn");
  await page.waitForTimeout(600);
  const savedCfg = await (await fetch(BASE + "/api/config")).json();
  const savedItem = savedCfg.groups[0].items.find((i) => i.title === "UI测试项-改");
  check("保存已写回服务器 config.json", !!savedItem && savedItem.lanUrl === "http://192.168.99.99:9000");
  check("保存后退出编辑模式", !(await page.locator("#saveBar").isVisible()));

  // 清理：删除测试项并保存，恢复现场
  await page.click("#editToggle");
  const testCard = page.locator('.card:has-text("UI测试项-改")');
  page.once("dialog", (d) => d.accept());
  await testCard.locator('[data-act="del-item"]').click();
  await page.waitForTimeout(200);
  await page.click("#saveBtn");
  await page.waitForTimeout(600);
  const finalCfg = await (await fetch(BASE + "/api/config")).json();
  const finalCount = finalCfg.groups.reduce((n, g) => n + g.items.length, 0);
  check("测试项已删除并恢复原始数据", finalCount === initialCount, String(finalCount));

  // 截图供人工核对样式
  await page.screenshot({ path: "test/ui-home.png", fullPage: true });

  console.log("== 保存失败分流（问题1修复验证） ==");
  await page.click("#editToggle");
  check("再次进入编辑模式", await page.locator("#saveBar").isVisible());
  const firstCard = page.locator(".card").first();
  await firstCard.locator('[data-act="edit-item"]').click();
  await page.fill('#itemForm [name="url"]', "ftp://example.com");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(200);
  let savedFailMsg = null;
  page.once("dialog", (d) => { savedFailMsg = d.message(); d.accept(); });
  await page.click("#saveBtn");
  await page.waitForTimeout(400);
  check("保存非法配置时弹窗提示『保存失败』", !!savedFailMsg && savedFailMsg.indexOf("保存失败") !== -1, savedFailMsg);
  check("保存失败后保持编辑模式（不退出、不误导为本地保存）", await page.locator("#saveBar").isVisible());
  page.once("dialog", (d) => d.accept()); // 放弃未保存修改的确认框
  await page.click("#cancelEditBtn");
  await page.waitForTimeout(200);
  check("取消后退出编辑模式", !(await page.locator("#saveBar").isVisible()));
  const afterSave = await (await fetch(BASE + "/api/config")).json();
  check("非法方案 url 未被写入服务器（数据未被污染）",
    !afterSave.groups.flatMap((g) => g.items).some((i) => i.url === "ftp://example.com"));

  console.log("== 页面错误 ==");
  const fatal = pageErrors.filter((e) => !/net::|Failed to load resource|ERR_INTERNET|favicon/i.test(e));
  check("无 JS 运行时错误", fatal.length === 0, fatal.join(" | ").slice(0, 200));

  await browser.close();
  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
