/* Navi 导航站 · 本地图床库 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   自包含：测试内自行启动隔离的 navi 实例（独立的 config 与 uploads 目录），
   不依赖外部已运行的服务，也不触碰真实 public/config.json 与 public/uploads/。
   覆盖：入口可见性 / 管理模式（空状态·批量上传·逐条结果·批量选择·删除）/
        选择模式（图床点选回填·在线图标库点选）/ 引用保护二次确认 / 保存落盘 /
         无 JS 运行时错误。
   用法：NODE_PATH=<managed_workspace>/node_modules node test/ui-library.test.cjs */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const PORT = 8692;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

// 1x1 透明 PNG（合法图片魔数 89 50 4E 47）
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navi-ui-library-"));
const cfgPath = path.join(tmp, "config.json");
const upDir = path.join(tmp, "uploads");
fs.mkdirSync(upDir, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({
  site: { title: "LibraryUI", subtitle: "图床库 UI 测试" },
  groups: [{ name: "常用服务", items: [
    { title: "Jellyfin", desc: "影音媒体库", icon: "jellyfin",
      url: "http://192.168.1.10:8096", lanUrl: "http://192.168.1.10:8096" }
  ] }]
}, null, 2), "utf-8");

function startNavi() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        NAVI_CONFIG_PATH: cfgPath,
        NAVI_UPLOAD_DIR: upDir,
        NAVI_PASSWORD: "",
        NAVI_PASSWORD_HASH: "",
        NAVI_ICON_PROBE: "0",
        NAVI_SCAN_LOCAL: "0"
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error("服务提前退出 " + c)); });
  });
}

const BASE = "http://127.0.0.1:" + PORT;
let navi = null, browser = null;

function cleanup() {
  try { if (browser) browser.close(); } catch (e) {}
  try { if (navi) navi.kill(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  navi = await startNavi();

  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const page = await browser.newPage();
  await stubExternal(page);   // 外部图标 CDN 就地应答，套件不再依赖外网
  const pageErrors = [];
  // 只收集真正的 JS 异常与脚本错误；外部图标 CDN 加载失败不算（离线环境应能正常降级）
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (!isNotJsError(m.text())) return;
    pageErrors.push(m.text());
  });

  // 引用保护会弹出原生确认框，这里统一接管
  let dialogMsg = "";
  let dialogAction = "dismiss";
  page.on("dialog", async (d) => {
    dialogMsg = d.message();
    if (dialogAction === "accept") await d.accept();
    else await d.dismiss();
  });

  // 等一个条件成立（超时返回 false 而不是抛错，便于把失败计入断言统计）
  async function waitForTrue(fn, timeoutMs) {
    try {
      await page.waitForFunction(fn, null, { timeout: timeoutMs || 10000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  try {
    console.log("== 入口可见性 ==");
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card", { timeout: 10000 });
    check("非编辑模式下不显示「图床库」入口",
      await page.locator("#saveBar[hidden]").count() === 1);
    check("编辑模式外图床库弹窗保持隐藏",
      await page.locator("#libraryModal[hidden]").count() === 1);

    await page.click("#editToggle");
    await page.waitForSelector("#saveBar:not([hidden])");
    check("编辑模式出现「图床库」按钮",
      await page.locator("#libraryBtn:visible").count() === 1);

    console.log("== 图床库管理：空状态 ==");
    await page.click("#libraryBtn");
    await page.waitForSelector("#libraryModal:not([hidden])");
    check("标题为「图床库管理」",
      (await page.locator("#libraryTitle").textContent()).indexOf("图床库管理") !== -1,
      await page.locator("#libraryTitle").textContent());
    check("管理模式隐藏「在线图标库」标签页",
      await page.locator("#libTabs[hidden]").count() === 1);
    // ⚠️ 必须先等「读取中 → 空状态」切换完成再断言。
    // 打开弹窗的一瞬间 #libEmpty 显示的是 loading 文案「正在读取图床库…」，
    // 直接断言就会偶发拿到它 —— 这正是本套件长期「全量回归偶发 1 项失败、
    // 单独跑必过」的真正原因：机器忙时 /api/library 回得慢一点就中招，
    // 而它看起来像产品缺陷（空库提示消失），实际是断言早于数据到达。
    await page.waitForFunction(
      () => {
        const el = document.getElementById("libEmpty");
        return !!el && !el.hidden &&
          !/正在读取/.test(el.textContent || "") &&
          /批量选择图片|还是空的/.test(el.textContent || "");
      },
      null, { timeout: 5000 }
    ).catch(() => { /* 超时交给下面的断言报出真实文案 */ });
    check("空库给出可操作提示",
      /批量选择图片|还是空的/.test(await page.locator("#libEmpty").textContent()),
      await page.locator("#libEmpty").textContent());
    check("管理模式显示批量选择入口",
      await page.locator("#libUploadBtn:visible").count() === 1);
    check("管理模式显示拖拽投放区",
      await page.locator("#libDrop:visible").count() === 1);

    console.log("== 批量上传（含 1 个非法文件） ==");
    await page.setInputFiles("#libFile", [
      { name: "Jellyfin.png", mimeType: "image/png", buffer: PNG_1x1 },
      { name: "Grafana.png", mimeType: "image/png", buffer: PNG_1x1 },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") }
    ]);
    await page.waitForFunction(
      () => {
        const el = document.getElementById("libResult");
        return el && !el.hidden && /上传完成/.test(el.textContent || "");
      },
      null, { timeout: 20000 }
    );
    const upText = await page.locator("#libResult").textContent();
    check("上传汇总：成功 2 张 / 失败 1 张",
      /成功 2 张/.test(upText) && /失败 1 张/.test(upText), upText);
    check("失败原因逐条列出（点名具体文件）",
      /notes\.txt/.test(upText) && /格式不支持/.test(upText), upText);

    await page.waitForFunction(
      () => document.querySelectorAll("#libGrid .lib-cell").length === 2,
      null, { timeout: 10000 }
    );
    const cells = await page.locator("#libGrid .lib-cell").count();
    check("图床库列出 2 张图标", cells === 2, String(cells));
    check("列表计数文案正确",
      /共 2 张/.test(await page.locator("#libCount").textContent()),
      await page.locator("#libCount").textContent());
    const firstName = await page.locator("#libGrid .lib-cell").first().getAttribute("data-name");
    check("文件名带原始名为前缀（jellyfin-… / grafana-…）",
      /^(jellyfin|grafana)-/.test(firstName), String(firstName));
    const thumbSrc = await page.locator("#libGrid .lib-cell").first().locator("img").getAttribute("src");
    check("缩略图指向 /uploads/ 地址", /^\/uploads\//.test(String(thumbSrc)), String(thumbSrc));
    const thumbResp = await page.evaluate((u) => fetch(u).then((r) => r.status), thumbSrc);
    check("缩略图可被真实访问（200）", thumbResp === 200, String(thumbResp));
    const localResolved = await waitForTrue(() => {
      const imgs = Array.from(document.querySelectorAll("#libGrid .lib-cell-thumb img"));
      return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0);
    });
    check("图床库缩略图在浏览器中全部真实加载", localResolved);

    console.log("== 搜索过滤 ==");
    await page.fill("#libSearch", "grafana");
    await page.waitForFunction(() => document.querySelectorAll("#libGrid .lib-cell").length === 1);
    check("按文件名过滤生效", await page.locator("#libGrid .lib-cell").count() === 1);
    await page.fill("#libSearch", "");
    await page.waitForFunction(() => document.querySelectorAll("#libGrid .lib-cell").length === 2);

    console.log("== 选择模式：从图床库点选 ==");
    await page.click('[data-close="libraryModal"]');
    await page.waitForSelector("#libraryModal", { state: "hidden" });
    await page.locator('[data-act="add-item"]').first().click();
    await page.waitForSelector("#itemModal:not([hidden])");
    await page.fill('#itemForm [name="title"]', "图床卡片");
    await page.fill('#itemForm [name="url"]', "https://lib.example.com");
    check("编辑卡片时可见「从图床库选择」入口",
      await page.locator("#logoLibraryBtn:visible").count() === 1);
    check("编辑卡片时可见「图标库」入口",
      await page.locator("#iconGalleryBtn:visible").count() === 1);

    await page.click("#logoLibraryBtn");
    await page.waitForSelector("#libraryModal:not([hidden])");
    check("选择模式标题为「选择图标」",
      (await page.locator("#libraryTitle").textContent()).indexOf("选择图标") !== -1,
      await page.locator("#libraryTitle").textContent());
    check("选择模式恢复「在线图标库」标签页",
      await page.locator("#libTabs:not([hidden])").count() === 1);
    check("选择模式不显示批量删除按钮",
      await page.locator("#libDeleteBtn[hidden]").count() === 1);
    await page.waitForFunction(() => document.querySelectorAll("#libGrid .lib-cell").length === 2);

    await page.locator("#libGrid .lib-cell").first().click();
    await page.waitForSelector("#libraryModal", { state: "hidden" });
    const pickedLogo = await page.locator("#logoInput").inputValue();
    check("点选后写入 /uploads/ 地址", /^\/uploads\//.test(pickedLogo), pickedLogo);
    check("点选后预览可见", await page.locator("#logoPreview").isVisible());
    check("点选后有状态提示",
      /已选用图床库图标/.test(await page.locator("#logoStatus").textContent()),
      await page.locator("#logoStatus").textContent());

    console.log("== 在线图标库（内置推荐 + 点选写入 icon 字段） ==");
    await page.click("#iconGalleryBtn");
    await page.waitForSelector("#libraryModal:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#iconGrid .lib-cell").length > 0, null, { timeout: 10000 });
    const presetCount = await page.locator("#iconGrid .lib-cell").count();
    check("在线图标库默认展示内置本地图标库（>=200 个）", presetCount >= 200, String(presetCount));
    // 缩略图是 loading="lazy" 的：不滚出视口就不会发请求，naturalWidth 恒为 0。
    // 内置库有 200+ 个（远超一屏），所以必须先把网格滚一遍再判定，
    // 否则测的只是「首屏那几张」——那等于把这条断言测废。
    await page.evaluate(async () => {
      const grid = document.querySelector("#iconGrid");
      let box = grid;
      while (box && box.scrollHeight <= box.clientHeight + 4 && box.parentElement) box = box.parentElement;
      if (!box) return;
      const step = Math.max(200, box.clientHeight - 40);
      for (let y = 0; y <= box.scrollHeight; y += step) {
        box.scrollTop = y;
        await new Promise((r) => setTimeout(r, 120));
      }
      box.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 200));
    });
    // 图标要么真的加载成功，要么已由 onerror 回退为字母图标，不允许空白
    const iconsResolved = await waitForTrue(() => {
      const thumbs = Array.from(document.querySelectorAll("#iconGrid .lib-cell-thumb"));
      return thumbs.length > 0 && thumbs.every((t) => {
        if (t.querySelector(".icon-fallback")) return true;
        const img = t.querySelector("img");
        return !!img && img.naturalWidth > 0;
      });
    }, 25000);
    check("在线图标全部解析为图片或字母回退（无空白缩略图）", iconsResolved);
    const firstIcon = await page.locator("#iconGrid .lib-cell").first().getAttribute("data-icon");
    await page.locator("#iconGrid .lib-cell").first().click();
    await page.waitForSelector("#libraryModal", { state: "hidden" });
    const iconField = await page.locator('#itemForm [name="icon"]').inputValue();
    check("点选后写入在线图标字段", iconField === firstIcon, iconField + " vs " + firstIcon);
    check("已有本地 Logo 时给出优先级提示",
      /优先级更高|清除/.test(await page.locator("#logoStatus").textContent()),
      await page.locator("#logoStatus").textContent());
    check("预览仍显示本地图床 Logo（logo 优先）",
      (await page.locator("#logoPreview").getAttribute("src")) === pickedLogo);

    console.log("== 清除本地 Logo 后回退在线图标 ==");
    await page.click("#logoClearBtn");
    const afterClear = await page.locator("#logoPreview").getAttribute("src");
    check("清除后预览不再使用图床图片",
      !!afterClear && afterClear !== pickedLogo, String(afterClear));
    check("清除后预览切到所选在线图标",
      afterClear !== null && (await page.locator("#logoPreview").isVisible()), String(afterClear));
    // 重新选回图床图标，用于后续保存断言
    await page.click("#logoLibraryBtn");
    await page.waitForSelector("#libraryModal:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#libGrid .lib-cell").length === 2);
    await page.locator("#libGrid .lib-cell").first().click();
    await page.waitForSelector("#libraryModal", { state: "hidden" });

    await page.click('#itemForm button[type="submit"]');
    await page.waitForSelector("#itemModal", { state: "hidden" });
    await page.click("#saveBtn");
    await page.waitForSelector("#saveBar", { state: "hidden", timeout: 15000 });

    const saved = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
    const all = [];
    (saved.groups || []).forEach((g) => (g.items || []).forEach((it) => all.push(it)));
    const added = all.filter((it) => it.title === "图床卡片")[0];
    check("卡片已落盘且携带图床 logo",
      !!added && /^\/uploads\//.test(String(added.logo)), JSON.stringify(added));
    check("同卡片同时保留了在线图标字段",
      !!added && added.icon === firstIcon, JSON.stringify(added) + " vs " + firstIcon);

    console.log("== 引用统计与删除保护 ==");
    await page.click("#editToggle");
    await page.waitForSelector("#saveBar:not([hidden])");
    await page.click("#libraryBtn");
    await page.waitForSelector("#libraryModal:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#libGrid .lib-cell").length === 2);
    const usedName = String(added.logo).replace("/uploads/", "");
    const usedCell = page.locator('#libGrid .lib-cell[data-name="' + usedName + '"]');
    // 列表会先渲染上一轮缓存、再被新数据覆盖，这里必须等「使用中」标记真正出现后再断言
    const markedUsed = await waitForTrue(() => document.querySelectorAll("#libGrid .lib-cell-used").length === 1);
    check("被卡片引用的图片标注「使用中」",
      markedUsed && (await usedCell.locator(".lib-cell-used").count()) === 1,
      await usedCell.innerHTML());
    check("被引用项 hover 提示含卡片名",
      String(await usedCell.getAttribute("title")).indexOf("图床卡片") !== -1,
      await usedCell.getAttribute("title"));

    console.log("== 批量选择与删除（未引用图片可直接删除） ==");
    const freeName = await page.locator("#libGrid .lib-cell").evaluateAll(
      (nodes, u) => (nodes.map((n) => n.getAttribute("data-name")).filter((n) => n !== u)[0] || ""),
      usedName
    );
    check("存在一张未被引用的图片用于删除测试", !!freeName, String(freeName));
    await page.locator('#libGrid .lib-cell[data-name="' + freeName + '"] .lib-cell-check').check();
    check("勾选后删除按钮计数更新",
      /删除选中（1）/.test(await page.locator("#libDeleteBtn").textContent()),
      await page.locator("#libDeleteBtn").textContent());
    await page.click("#libDeleteBtn");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#libGrid .lib-cell").length === 1
        && !document.querySelector('#libGrid .lib-cell[data-name="' + n + '"]'),
      freeName, { timeout: 15000 }
    );
    check("未引用图片删除成功且列表刷新", await page.locator("#libGrid .lib-cell").count() === 1);
    check("删除结果有明确反馈",
      /删除完成：1 张/.test(await page.locator("#libResult").textContent()),
      await page.locator("#libResult").textContent());

    console.log("== 引用保护（取消 + 强制删除） ==");
    await page.locator('#libGrid .lib-cell[data-name="' + usedName + '"] .lib-cell-check').check();
    dialogAction = "dismiss";
    dialogMsg = "";
    await page.click("#libDeleteBtn");
    await page.waitForFunction(
      () => /删除完成|保留/.test(document.getElementById("libResult").textContent || ""),
      null, { timeout: 15000 }
    );
    check("删除被引用图片时弹出二次确认",
      /仍被导航卡片使用/.test(dialogMsg) && /图床卡片/.test(dialogMsg), dialogMsg);
    check("取消确认后图片被保留",
      /保留 1 张/.test(await page.locator("#libResult").textContent()),
      await page.locator("#libResult").textContent());
    check("取消后列表仍有该图片",
      (await page.locator('#libGrid .lib-cell[data-name="' + usedName + '"]').count()) === 1);

    await page.locator('#libGrid .lib-cell[data-name="' + usedName + '"] .lib-cell-check').check();
    dialogAction = "accept";
    await page.click("#libDeleteBtn");
    await page.waitForFunction(
      (n) => !document.querySelector('#libGrid .lib-cell[data-name="' + n + '"]'),
      usedName, { timeout: 15000 }
    );
    check("确认后强制删除成功",
      (await page.locator('#libGrid .lib-cell[data-name="' + usedName + '"]').count()) === 0);
    check("强制删除后文件确实从磁盘移除",
      !fs.existsSync(path.join(upDir, usedName)), usedName);
    check("卡片配置未被删除动作破坏（logo 仍在配置里）",
      fs.readFileSync(cfgPath, "utf-8").indexOf(usedName) !== -1);

    console.log("== 页面错误 ==");
    check("无 JS 运行时错误", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    cleanup();
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  cleanup();
  process.exit(1);
});
