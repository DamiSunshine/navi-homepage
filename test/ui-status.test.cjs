/* Navi 导航站 · 系统状态板 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   用法：先启动 server.js，再运行
     NODE_PATH=<managed_workspace>/node_modules node test/ui-status.test.cjs [baseUrl]

   覆盖的都是「降级」这条主线 —— 状态板最容易出的问题不是显示不准，而是：
     · 接口不存在（旧镜像）时在首页挂一个报错 / 疯狂重试；
     · Docker 采不到时显示 0，被读成「真的没有容器」；
     · 页面切到后台还一直轮询（NAS 上开着一堆标签页时不礼貌）。
   资源水位数字只做「形状」断言（百分比或不可用），不比对具体数值 —— 那取决于跑测试的机器。 */
"use strict";

const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const BASE = process.argv[2] || "http://127.0.0.1:8632";

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const pageErrors = [];
  function track(p) {
    p.on("pageerror", (e) => pageErrors.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text()); });
  }

  try {
    /* ============================================================
       ① 正常路径：状态板出现且数字成形
       ============================================================ */
    console.log("== 状态板渲染 ==");
    const page = await browser.newPage();
    await stubExternal(page);          // 必须在 goto 之前
    track(page);
    // 记录对 /api/status 的调用（后注册的 handler 优先，所以能盖过 hermetic 的桩）
    const statusCalls = [];
    await page.route("**/api/status*", (route) => {
      statusCalls.push(route.request().url());
      return route.continue();
    });

    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card", { timeout: 10000 });
    await page.waitForFunction(() => window.NaviApp && window.NaviApp.status().hasData === true, { timeout: 10000 });

    check("状态板可见", await page.locator("#statusBoard").isVisible());
    check("首屏就发起了 /api/status 请求", statusCalls.length >= 1, String(statusCalls.length));

    const cpuText = await page.locator("#sbCpu").textContent();
    const memText = await page.locator("#sbMem").textContent();
    const diskText = await page.locator("#sbDisk").textContent();
    check("CPU 显示百分比或「不可用」", /^\d+(\.\d+)?%$/.test(cpuText) || cpuText === "不可用", cpuText);
    check("内存显示百分比或「不可用」", /^\d+(\.\d+)?%$/.test(memText) || memText === "不可用", memText);
    check("磁盘显示百分比或「不可用」", /^\d+(\.\d+)?%$/.test(diskText) || diskText === "不可用", diskText);

    const cpuBar = await page.locator("#sbCpuBar").evaluate((el) => el.style.width);
    check("CPU 进度条宽度已写入（渲染生效）", /%$/.test(cpuBar), cpuBar);

    const snap1 = await page.evaluate(() => window.NaviApp.status());
    check("轮询已启动（started=true）", snap1.started === true);
    check("拿到过数据（hasData=true）", snap1.hasData === true);
    check("数据里含 docker 段", !!(snap1.data && snap1.data.docker));
    check("数据里含 navi 版本与运行时长",
      !!(snap1.data && snap1.data.navi && snap1.data.navi.version && typeof snap1.data.navi.uptimeSec === "number"));

    console.log("== Docker 不可用时的降级 ==");
    const dockerSnap = snap1.data.docker;
    if (dockerSnap.available) {
      // 跑测试的机器真挂了 docker.sock：那条路径由 status.test.js 的假 API 覆盖，这里只做形状断言
      check("Docker 可用时显示「运行中 / 总数」", /^\d+ \/ \d+$/.test(await page.locator("#sbDocker").textContent()),
        await page.locator("#sbDocker").textContent());
    } else {
      check("Docker 不可用时文案为「不可用」（不是 0）",
        (await page.locator("#sbDocker").textContent()) === "不可用");
      check("Docker 不可用时该项标记 data-state=na",
        (await page.locator("#sbDockerItem").getAttribute("data-state")) === "na");
      check("Docker 不可用时 total 为 null（不给假 0）", dockerSnap.total === null);
      check("Docker 不可用时状态板整体仍然可见（其余指标照常显示）",
        await page.locator("#statusBoard").isVisible());
    }

    console.log("== 手动刷新走 fresh=1（绕过服务端缓存）==");
    const before = statusCalls.length;
    await page.click("#sbRefresh");
    await page.waitForTimeout(600);
    check("点刷新后产生了新请求", statusCalls.length > before, String(statusCalls.length));
    check("手动刷新请求带 fresh=1",
      statusCalls.some((u) => /fresh=1/.test(u)), statusCalls.join(" | "));
    check("刷新按钮的忙碌态已复位",
      String(await page.locator("#sbRefresh").getAttribute("class")).indexOf("is-busy") === -1,
      await page.locator("#sbRefresh").getAttribute("class"));

    /* ============================================================
       ② 页面切到后台 → 停止轮询；切回 → 重新排期
       ============================================================ */
    console.log("== 后台暂停轮询 ==");
    const canFakeHidden = await page.evaluate(() => {
      try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        return document.hidden === true;
      } catch (e) { return false; }
    });
    check("测试环境可模拟 document.hidden（前置条件）", canFakeHidden);
    if (canFakeHidden) {
      await page.waitForTimeout(250);   // 若在途请求刚好返回，也不应再排期
      const hiddenSnap = await page.evaluate(() => window.NaviApp.status());
      check("页面隐藏后不再排期下一次轮询", hiddenSnap.waiting === false, String(hiddenSnap.waiting));
      check("页面隐藏不清空已有数据", hiddenSnap.hasData === true);
      check("页面隐藏状态板仍保留（不闪没）", await page.locator("#statusBoard").isVisible());

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(250);
      const backSnap = await page.evaluate(() => window.NaviApp.status());
      check("切回前台后重新排期（waiting=true）", backSnap.waiting === true, String(backSnap.waiting));
    }

    /* ============================================================
       ③ 接口不存在（旧镜像）→ 静默退场，不报错、不重试
       ============================================================ */
    console.log("== 接口 404 时的静默退场 ==");
    const pageGone = await browser.newPage();
    await stubExternal(pageGone);
    track(pageGone);
    let goneCalls = 0;
    await pageGone.route("**/api/status*", (route) => {
      goneCalls++;
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    });
    await pageGone.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await pageGone.waitForSelector(".card", { timeout: 10000 });
    await pageGone.waitForTimeout(600);
    const goneSnap = await pageGone.evaluate(() => window.NaviApp.status());
    check("接口不可用时状态板隐藏", goneSnap.hidden === true);
    check("接口不可用时停止轮询", goneSnap.stopped === true);
    check("接口不可用时 hasData 仍为 false", goneSnap.hasData === false);
    check("仅尝试一次，不做无意义重试", goneCalls === 1, String(goneCalls));
    await pageGone.close();

    /* ============================================================
       ④ 服务端关闭状态板（disabled:true）→ 同样静默隐藏
       ============================================================ */
    console.log("== 服务端关闭状态板 ==");
    const pageOff = await browser.newPage();
    await stubExternal(pageOff);
    track(pageOff);
    await pageOff.route("**/api/status*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, disabled: true, docker: { available: false, error: "已关闭" } })
    }));
    await pageOff.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await pageOff.waitForSelector(".card", { timeout: 10000 });
    await pageOff.waitForTimeout(500);
    const offSnap = await pageOff.evaluate(() => window.NaviApp.status());
    check("disabled:true 时状态板隐藏", offSnap.hidden === true);
    check("disabled:true 时停止轮询", offSnap.stopped === true);
    await pageOff.close();

    /* ============================================================
       ⑤ site.statusBoard = false → 根本不启动
       ============================================================ */
    console.log("== 站点配置可整体关闭状态板 ==");
    const pageCfg = await browser.newPage();
    await stubExternal(pageCfg);
    track(pageCfg);
    await pageCfg.route("**/api/config", async (route) => {
      const res = await route.fetch();
      let cfg = {};
      try { cfg = await res.json(); } catch (e) {}
      cfg.site = Object.assign({}, cfg.site, { statusBoard: false });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cfg) });
    });
    let cfgCalls = 0;
    await pageCfg.route("**/api/status*", (route) => { cfgCalls++; return route.continue(); });
    await pageCfg.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await pageCfg.waitForSelector(".card", { timeout: 10000 });
    await pageCfg.waitForTimeout(500);
    const cfgSnap = await pageCfg.evaluate(() => window.NaviApp.status());
    check("site.statusBoard=false 时不启动轮询", cfgSnap.started === false, String(cfgSnap.started));
    check("site.statusBoard=false 时一次状态请求都不发", cfgCalls === 0, String(cfgCalls));
    check("site.statusBoard=false 时状态板保持隐藏", cfgSnap.hidden === true);
    await pageCfg.close();

    /* ============================================================
       ⑥ 全程无 JS 错误
       ============================================================ */
    console.log("== 无 JS 错误 ==");
    check("无 JS 运行时错误", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser.close();
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
