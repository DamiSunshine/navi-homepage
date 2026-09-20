/* Navi 导航站 · 首次引导 + 拖链接建卡 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   自包含：测试内自行启动两个隔离实例，不依赖外部服务，也不触碰真实 public/config.json。

   覆盖：
     A. 空配置    → 首次引导出现（三步 / 密码提醒 / 跳过持久化 / 跳过不再出现）
     B. 有卡片    → 首次引导不出现（老用户不该被向导打扰）
     C. 拖入链接  → 解析规则（多种粘贴形态）+ 编辑模式下拖入即预填弹窗
     D. 边界      → 非编辑模式 / 非链接内容 不弹窗

   用法：NODE_PATH=<managed_workspace>/node_modules node test/ui-firstrun.test.cjs */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const PORT_EMPTY = 8681;   // 空配置实例
const PORT_FULL = 8682;    // 有卡片实例

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navi-ui-firstrun-"));

function makeInstance(port, cfgName) {
  const dir = path.join(tmp, cfgName);
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  const cfgPath = path.join(dir, "config.json");
  return { dir, cfgPath };
}

const empty = makeInstance(PORT_EMPTY, "empty");
const full = makeInstance(PORT_FULL, "full");

// 空配置：一张卡片都没有 → 正是首次引导该出现的场景
fs.writeFileSync(empty.cfgPath, JSON.stringify({
  site: { title: "FirstRunEmpty", subtitle: "空配置" },
  groups: []
}, null, 2), "utf-8");

// 有卡片的配置：老用户场景
fs.writeFileSync(full.cfgPath, JSON.stringify({
  site: { title: "FirstRunFull", subtitle: "有卡片" },
  groups: [{ name: "常用", items: [
    { title: "Jellyfin", url: "http://192.168.1.10:8096", lanUrl: "http://192.168.1.10:8096" }
  ] }]
}, null, 2), "utf-8");

function startNavi(port, cfgPath, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, {
        PORT: String(port),
        NAVI_CONFIG_PATH: cfgPath,
        NAVI_UPLOAD_DIR: path.join(dir, "uploads"),
        NAVI_PASSWORD: "",
        NAVI_PASSWORD_HASH: "",
        NAVI_ICON_PROBE: "0",
        NAVI_SCAN_LOCAL: "0",
        NAVI_STATUS_BOARD: "0",
        DOCKER_SOCKET: path.join(dir, "missing.sock")
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

const BASE_EMPTY = "http://127.0.0.1:" + PORT_EMPTY;
const BASE_FULL = "http://127.0.0.1:" + PORT_FULL;
let srvEmpty = null, srvFull = null, browser = null;

function cleanup() {
  try { if (browser) browser.close(); } catch (e) {}
  try { if (srvEmpty) srvEmpty.kill(); } catch (e) {}
  try { if (srvFull) srvFull.kill(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

// 模拟「从外部（地址栏 / 书签 / 聊天窗口）拖一个链接进来」：
// 浏览器不会给你真的外部拖拽，只能自己造带 dataTransfer 的拖拽事件。
function dropLink(page, uri, plain) {
  return page.evaluate(([u, p]) => {
    const dt = new DataTransfer();
    if (u) dt.setData("text/uri-list", u);
    if (p !== null && p !== undefined) dt.setData("text/plain", p);
    const el = document.getElementById("navRoot");
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    el.dispatchEvent(new DragEvent("dragover", opts));
    el.dispatchEvent(new DragEvent("drop", opts));
    return true;
  }, [uri, plain]);
}

(async () => {
  srvEmpty = await startNavi(PORT_EMPTY, empty.cfgPath, empty.dir);
  srvFull = await startNavi(PORT_FULL, full.cfgPath, full.dir);

  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const pageErrors = [];

  /* ==================== A. 空配置：首次引导出现 ==================== */
  console.log("== A. 空配置 → 首次引导 ==");
  const pageA = await browser.newPage();
  await stubExternal(pageA);
  pageA.on("pageerror", (e) => pageErrors.push("A: " + String(e)));
  pageA.on("console", (m) => {
    if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push("A: " + m.text());
  });
  await pageA.goto(BASE_EMPTY + "/", { waitUntil: "domcontentloaded" });
  await pageA.waitForSelector("#navRoot .loading", { state: "detached", timeout: 10000 }).catch(() => {});

  check("空配置 + 有后端 → 判断为「应出现引导」",
    (await pageA.evaluate(() => window.NaviApp.shouldShowFirstRun())) === true);
  check("引导弹窗确实显示", await pageA.locator("#firstRun:not([hidden])").count() === 1);
  check("引导含三步说明", await pageA.locator(".fr-steps li").count() === 3,
    String(await pageA.locator(".fr-steps li").count()));
  const frText = (await pageA.locator(".first-run").textContent()) || "";
  check("引导提到编辑模式与保存", /编辑模式/.test(frText) && /保存/.test(frText));
  check("引导提到服务发现与拖链接", /服务发现/.test(frText) && /拖到页面/.test(frText));
  check("引导提到含图片的完整备份", /完整 \.zip/.test(frText) || /含图床库图片/.test(frText));
  check("引导提醒设置 NAVI_PASSWORD（不设等于无密码）",
    /NAVI_PASSWORD/.test(frText) && /无密码/.test(frText));

  console.log("== A2. 跳过后的持久化 ==");
  await pageA.click("#frDismiss");
  check("点「以后再说」后引导关闭", await pageA.locator("#firstRun[hidden]").count() === 1);
  check("跳过状态写入 localStorage",
    (await pageA.evaluate(() => localStorage.getItem("navi-firstrun-done"))) === "1");
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForSelector("#navRoot .loading", { state: "detached", timeout: 10000 }).catch(() => {});
  check("刷新后不再出现（尊重用户选择）",
    await pageA.locator("#firstRun[hidden]").count() === 1 &&
    (await pageA.evaluate(() => window.NaviApp.shouldShowFirstRun())) === false);

  await pageA.evaluate(() => localStorage.removeItem("navi-firstrun-done"));
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForSelector("#navRoot .loading", { state: "detached", timeout: 10000 }).catch(() => {});
  check("清掉跳过标记后再次出现（判断基于条件，不是一次性）",
    await pageA.locator("#firstRun:not([hidden])").count() === 1);

  console.log("== A3. 引导的两个出口 ==");
  await pageA.click("#frStart");
  check("「开始添加」关闭引导并进入编辑模式",
    await pageA.locator("#firstRun[hidden]").count() === 1 &&
    await pageA.locator("#saveBar:not([hidden])").count() === 1);
  check("「开始添加」直接打开新建分组弹窗（空配置的第一步）",
    await pageA.locator("#groupModal:not([hidden])").count() === 1);
  await pageA.locator('#groupModal [data-close="groupModal"]').click();

  // 清掉跳过标记 → 重载 → 走「用服务发现」这条出口
  await pageA.evaluate(() => localStorage.removeItem("navi-firstrun-done"));
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForSelector("#navRoot .loading", { state: "detached", timeout: 10000 }).catch(() => {});
  await pageA.click("#frDiscover");
  await pageA.waitForSelector("#discoverModal:not([hidden])", { timeout: 10000 });
  check("「用服务发现自动添加」进入编辑模式并打开发现弹窗",
    await pageA.locator("#saveBar:not([hidden])").count() === 1 &&
    await pageA.locator("#discoverModal:not([hidden])").count() === 1);
  check("发现弹窗给出无服务时的可操作提示（后端在、但没挂 docker.sock）",
    /未识别到可访问的服务/.test((await pageA.locator("#discoverEmpty").textContent()) || ""),
    await pageA.locator("#discoverEmpty").textContent());

  /* ==================== B. 有卡片：引导不出现 ==================== */
  console.log("== B. 有卡片 → 不打扰 ==");
  const pageB = await browser.newPage();
  await stubExternal(pageB);
  pageB.on("pageerror", (e) => pageErrors.push("B: " + String(e)));
  pageB.on("console", (m) => {
    if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push("B: " + m.text());
  });
  await pageB.goto(BASE_FULL + "/", { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector(".card", { timeout: 10000 });
  check("有卡片时判断为「不出现」",
    (await pageB.evaluate(() => window.NaviApp.shouldShowFirstRun())) === false);
  check("引导弹窗保持隐藏", await pageB.locator("#firstRun[hidden]").count() === 1);

  /* ==================== C. 拖入链接的解析规则 ==================== */
  console.log("== C. parseDroppedLink 解析形态 ==");
  const parsed = await pageB.evaluate(() => {
    const f = window.NaviApp.parseDroppedLink;
    return {
      bare: f("https://a.example.com/page"),
      titled: f("示例站点\r\nhttps://a.example.com/page"),
      titledFirst: f("https://a.example.com/page\r\n示例站点"),
      commented: f("https://uri.example.com/x\n# 这是注释"),
      notLink: f("这只是一段普通文字，没有链接"),
      empty: f(""),
      nil: f(null),
      longTitle: f("A".repeat(50) + "\r\nhttps://b.example.com"),
      multi: f("https://first.example.com\nhttps://second.example.com")
    };
  });
  check("单行 URL 可解析", parsed.bare && parsed.bare.url === "https://a.example.com/page",
    JSON.stringify(parsed.bare));
  check("「标题 + 换行 + URL」形态：标题被提取",
    parsed.titled && parsed.titled.url === "https://a.example.com/page" && parsed.titled.title === "示例站点",
    JSON.stringify(parsed.titled));
  check("「URL + 换行 + 标题」形态同样能取到标题",
    parsed.titledFirst && parsed.titledFirst.title === "示例站点", JSON.stringify(parsed.titledFirst));
  check("uri-list 的 # 注释行被忽略",
    parsed.commented && parsed.commented.url === "https://uri.example.com/x",
    JSON.stringify(parsed.commented));
  check("纯文字不算链接（返回 null，不弹窗）", parsed.notLink === null, JSON.stringify(parsed.notLink));
  check("空串 / null 安全", parsed.empty === null && parsed.nil === null);
  check("标题超长被截断到 40 字",
    parsed.longTitle && parsed.longTitle.title.length === 40, JSON.stringify(parsed.longTitle));
  check("多个链接取第一个", parsed.multi && parsed.multi.url === "https://first.example.com",
    JSON.stringify(parsed.multi));

  /* ==================== D. 拖链接建卡（编辑模式） ==================== */
  console.log("== D. 拖入链接 → 预填弹窗 ==");
  await pageB.click("#editToggle");
  await pageB.waitForSelector("#saveBar:not([hidden])");

  // 非编辑模式先验一次（此时还没进编辑模式？—— 上面已进，故这里先退出再验）
  await pageB.click("#cancelEditBtn");
  // 注意：#saveBar 是「隐藏」态（hidden 属性），要等的是 state:"hidden"，不是默认的 visible
  await pageB.waitForSelector("#saveBar", { state: "hidden", timeout: 5000 });
  await dropLink(pageB, "https://outside.example.com/a", "外部站点\r\nhttps://outside.example.com/a");
  check("非编辑模式下拖入链接不弹窗（避免误触改内容）",
    await pageB.locator("#itemModal[hidden]").count() === 1);

  await pageB.click("#editToggle");
  await pageB.waitForSelector("#saveBar:not([hidden])");

  await dropLink(pageB, "https://outside.example.com/b", "外部站点 B\r\nhttps://outside.example.com/b");
  await pageB.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
  check("编辑模式下拖入链接打开「添加导航项」弹窗", await pageB.locator("#itemModal:not([hidden])").count() === 1);
  check("外网地址已预填",
    (await pageB.locator('#itemForm input[name="url"]').inputValue()) === "https://outside.example.com/b",
    await pageB.locator('#itemForm input[name="url"]').inputValue());
  check("名称已用拖拽带来的标题预填",
    (await pageB.locator('#itemForm input[name="title"]').inputValue()) === "外部站点 B",
    await pageB.locator('#itemForm input[name="title"]').inputValue());
  check("弹窗标题是「添加导航项」（而不是编辑）",
    (await pageB.locator("#itemModalTitle").textContent()).indexOf("添加") !== -1);
  await pageB.locator('#itemModal [data-close="itemModal"]').click();

  await dropLink(pageB, null, "只是一段文字，没有链接");
  check("拖入非链接内容不弹窗（不打扰）",
    await pageB.locator("#itemModal[hidden]").count() === 1);

  await dropLink(pageB, "https://host.example.com/", "");
  await pageB.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
  check("只有 URL 没有标题时用主机名兜底",
    (await pageB.locator('#itemForm input[name="title"]').inputValue()) === "host.example.com",
    await pageB.locator('#itemForm input[name="title"]').inputValue());
  await pageB.locator('#itemModal [data-close="itemModal"]').click();

  console.log("== 稳定性 ==");
  check("全程无 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  cleanup();
  process.exit(1);
});
