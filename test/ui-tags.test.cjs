/* Navi 导航站 · 卡片标签（P2）UI 测试（Playwright + 本机 Edge/Chrome 内核）
   自包含：测试内自行启动一个隔离实例（独立 config + uploads），不依赖外部服务，
   也不触碰真实 public/config.json。

   覆盖：
     A. 归一化规则  → 半角/全角逗号、空白、重复、超长、超量、非法类型（纯函数）
     B. 卡片渲染    → 标签行 / 顺序 / 超 3 个折叠成 +n / 无标签不渲染
     C. 点标签筛选  → 跨分组（P2 的核心诉求）+ 编辑模式下不误触
     D. 搜索检索    → 标签词、标签拼音（首字母与全拼）
     E. 命令面板    → Ctrl+K 跨分组命中 + 「标签」命中徽章
     F. 编辑与保存  → 回填 / 收敛 / 空标签不落库

   用法：NODE_PATH=<managed_workspace>/node_modules node test/ui-tags.test.cjs */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const PORT = 8683;
const BASE = "http://127.0.0.1:" + PORT;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navi-ui-tags-"));
const upDir = path.join(tmp, "uploads");
fs.mkdirSync(upDir, { recursive: true });
const cfgPath = path.join(tmp, "config.json");

// 刻意让「媒体」这个标签跨越「下载」「媒体」两个分组 —— 这正是「跨分组检索」要证明的事。
// 另放一张 5 标签的卡片专验「折叠 +n」，一张完全无标签的卡片验「不渲染标签行」。
fs.writeFileSync(cfgPath, JSON.stringify({
  site: { title: "TagsTest", subtitle: "标签" },
  groups: [
    { name: "下载", items: [
      { title: "qBittorrent", url: "http://192.168.1.10:8080", tags: ["下载", "媒体"] },
      { title: "Transmission", url: "http://192.168.1.10:9091", tags: ["下载"] }
    ] },
    { name: "媒体", items: [
      { title: "Jellyfin", url: "http://192.168.1.10:8096", tags: ["媒体", "影视"] },
      { title: "无标签站点", url: "http://192.168.1.10:9999" }
    ] },
    { name: "工具", items: [
      { title: "多标签卡片", url: "http://192.168.1.10:7000", tags: ["A", "B", "C", "D", "E"] }
    ] }
  ]
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
        NAVI_SCAN_LOCAL: "0",
        NAVI_STATUS_BOARD: "0",
        DOCKER_SOCKET: path.join(tmp, "missing.sock")
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

let srv = null, browser = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (e) { /* ignore */ }
  try { if (srv) srv.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// 按「标题恰好是某张卡片」定位。必须锚在 .card-title 上 —— 否则卡片正文里的标签文本
// 也会被 hasText 命中（例如找「媒体」时会连带命中 Jellyfin 卡片）。
function cardOf(page, title) {
  return page.locator(".card").filter({ has: page.locator(".card-title", { hasText: title }) });
}

(async () => {
  srv = await startNavi();
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const pageErrors = [];
  const page = await browser.newPage();
  await stubExternal(page);
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text()); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });
  await page.waitForTimeout(300);

  const cfg0 = await (await fetch(BASE + "/api/config")).json();
  const total = cfg0.groups.reduce((n, g) => n + g.items.length, 0);

  /* ==================== A. 归一化规则（纯函数） ==================== */
  console.log("== A. 标签归一化规则 ==");
  const pt = (v) => page.evaluate((x) => window.NaviApp.parseTags(x), v);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check("半角逗号分隔 → 数组（并去掉首尾空白）",
    eq(await pt("下载, 媒体"), ["下载", "媒体"]));
  check("全角逗号也当分隔符（中文输入法打出来的就是它）",
    eq(await pt("下载，媒体"), ["下载", "媒体"]));
  check("连续分隔符 / 纯空白被丢掉（不产生空标签）",
    eq(await pt(",,  ,下载,,媒体,,"), ["下载", "媒体"]));
  check("重复项去重", eq(await pt("下载, 下载,下载"), ["下载"]));
  check("去重不区分大小写，但保留首次出现的写法",
    eq(await pt("DL, dl, Dl"), ["DL"]));
  check("单个标签超 12 字 → 截断（而不是整条丢掉）",
    eq(await pt("一二三四五六七八九十十一十二"), ["一二三四五六七八九十十一"]));
  check("超过 8 个 → 只留前 8 个（与后端上限一致）",
    eq(await pt("1,2,3,4,5,6,7,8,9,10"), ["1", "2", "3", "4", "5", "6", "7", "8"]));
  check("非字符串非数组 → 空数组（不抛错）",
    eq(await pt(123), []) && eq(await pt(null), []));
  check("数组输入（来自 config.json）也过一遍清洗",
    eq(await pt(["下载", null, 7, " 媒体 "]), ["下载", "媒体"]));

  /* ==================== B. 卡片标签渲染 ==================== */
  console.log("== B. 卡片标签渲染 ==");
  const qb = cardOf(page, "qBittorrent");
  check("带标签的卡片渲染出标签行",
    (await qb.locator(".card-tags .tag").count()) === 2,
    String(await qb.locator(".card-tags .tag").count()));
  check("标签文本与顺序与配置一致",
    eq(await qb.locator(".card-tags .tag").allTextContents(), ["下载", "媒体"]),
    JSON.stringify(await qb.locator(".card-tags .tag").allTextContents()));
  check("标签带 data-tag 属性（点击筛选的依据）",
    (await qb.locator('.card-tags .tag[data-tag="媒体"]').count()) === 1);
  const many = cardOf(page, "多标签卡片");
  check("超过 3 个标签只铺 3 个，其余折成 +n",
    (await many.locator(".card-tags .tag").count()) === 3 &&
    (await many.locator(".tag-more").textContent()).trim() === "+2",
    (await many.locator(".tag-more").textContent()).trim());
  check("无标签的卡片不渲染标签行",
    (await cardOf(page, "无标签站点").locator(".card-tags").count()) === 0);

  /* ==================== C. 点标签即跨分组筛选 ==================== */
  console.log("== C. 点标签即筛选（跨分组） ==");
  await qb.locator('.card-tags .tag[data-tag="媒体"]').click();
  await page.waitForTimeout(300);
  check("点标签后搜索框被填上该标签",
    (await page.locator("#searchInput").inputValue()) === "媒体",
    await page.locator("#searchInput").inputValue());
  check("筛选后只剩带该标签的 2 张卡片",
    (await page.locator(".card").count()) === 2,
    String(await page.locator(".card").count()));
  check("结果横跨两个分组（这就是「跨分组检索」）",
    (await page.locator(".group").count()) === 2,
    String(await page.locator(".group").count()));
  check("另一个分组里的同标签卡片出现了（Jellyfin 在「媒体」组）",
    (await cardOf(page, "Jellyfin").count()) === 1);
  check("不带该标签的卡片被过滤掉",
    (await cardOf(page, "无标签站点").count()) === 0);

  await page.fill("#searchInput", "");
  await page.waitForTimeout(250);
  check("清空搜索后全部卡片恢复", (await page.locator(".card").count()) === total);

  /* ==================== D. 搜索框按标签检索 ==================== */
  console.log("== D. 搜索命中标签 ==");
  await page.fill("#searchInput", "媒体");
  await page.waitForTimeout(300);
  check("搜标签词 → 命中跨分组的卡片",
    (await page.locator(".card").count()) === 2,
    String(await page.locator(".card").count()));
  // 标签与标题一样支持拼音：标题全是英文，所以下面两条的命中只可能来自「下载」这个标签
  await page.fill("#searchInput", "xz");
  await page.waitForTimeout(400);
  check("搜标签的拼音首字母（xz → 下载）命中带该标签的卡片",
    (await page.locator(".card").count()) === 2,
    String(await page.locator(".card").count()));
  await page.fill("#searchInput", "xiazai");
  await page.waitForTimeout(400);
  check("搜标签的全拼（xiazai）同样命中",
    (await page.locator(".card").count()) === 2,
    String(await page.locator(".card").count()));
  await page.fill("#searchInput", "");
  await page.waitForTimeout(200);

  /* ==================== E. 命令面板（Ctrl+K） ==================== */
  console.log("== E. 命令面板 ==");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  check("Ctrl+K 打开面板", (await page.locator("#paletteMask:not([hidden])").count()) === 1);
  await page.fill("#paletteInput", "媒体");
  await page.waitForTimeout(300);
  check("面板里搜标签 → 命中跨分组的 2 条",
    (await page.locator(".palette-row[data-idx]").count()) === 2,
    String(await page.locator(".palette-row[data-idx]").count()));
  check("面板按分组分段，结果确实来自两个分组",
    (await page.locator(".palette-sec").count()) === 2,
    String(await page.locator(".palette-sec").count()));
  check("面板标出「标签」是命中原因",
    (await page.locator(".palette-row-hit").count()) === 2,
    String(await page.locator(".palette-row-hit").count()));
  check("面板行里也显示该卡片的标签",
    (await page.locator(".palette-row-tag").count()) >= 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Esc 关闭面板", (await page.locator("#paletteMask[hidden]").count()) === 1);

  /* ==================== F. 编辑与保存 ==================== */
  console.log("== F. 标签的编辑与保存 ==");
  await page.click("#editToggle");
  await page.waitForTimeout(200);

  // 编辑模式下那一下留给「编辑卡片」，不该顺手把页面筛掉
  await cardOf(page, "qBittorrent").locator('.card-tags .tag[data-tag="媒体"]').click();
  await page.waitForTimeout(250);
  check("编辑模式下点标签不触发筛选（避免编排卡片时误触）",
    (await page.locator("#searchInput").inputValue()) === "",
    await page.locator("#searchInput").inputValue());
  check("编辑模式下全部卡片仍可见",
    (await page.locator(".card").count()) === total,
    String(await page.locator(".card").count()));

  await cardOf(page, "qBittorrent").locator('[data-act="edit-item"]').click();
  await page.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
  check("编辑弹窗回填已有标签（逗号分隔）",
    (await page.locator('#itemForm [name="tags"]').inputValue()) === "下载, 媒体",
    await page.locator('#itemForm [name="tags"]').inputValue());

  // 全角逗号 + 重复一起塞进去，验证保存前被收敛成规范数组
  await page.fill('#itemForm [name="tags"]', "下载，媒体, 常用, 下载");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("保存前即时收敛：卡片上立刻是 3 个规范标签",
    eq(await cardOf(page, "qBittorrent").locator(".card-tags .tag").allTextContents(),
       ["下载", "媒体", "常用"]),
    JSON.stringify(await cardOf(page, "qBittorrent").locator(".card-tags .tag").allTextContents()));

  await page.click("#saveBtn");
  await page.waitForTimeout(700);
  let saved = await (await fetch(BASE + "/api/config")).json();
  let qbItem = saved.groups[0].items.find((i) => i.title === "qBittorrent");
  check("落库的标签是规范数组（全角逗号已拆开、重复已去掉）",
    qbItem && eq(qbItem.tags, ["下载", "媒体", "常用"]),
    JSON.stringify(qbItem && qbItem.tags));
  check("保存后退出编辑模式", !(await page.locator("#saveBar").isVisible()));

  // 空标签：不该写进配置文件（保持文件干净、与旧格式兼容）
  await page.click("#editToggle");
  await page.waitForTimeout(200);
  await cardOf(page, "无标签站点").locator('[data-act="edit-item"]').click();
  await page.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
  check("无标签的卡片编辑框是空的",
    (await page.locator('#itemForm [name="tags"]').inputValue()) === "");
  await page.fill('#itemForm [name="tags"]', "临时");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("加上标签后卡片上立刻出现该标签",
    (await cardOf(page, "无标签站点").locator('.card-tags .tag[data-tag="临时"]').count()) === 1);

  await cardOf(page, "无标签站点").locator('[data-act="edit-item"]').click();
  await page.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
  await page.fill('#itemForm [name="tags"]', "   ");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("清空标签后卡片上不再有标签行",
    (await cardOf(page, "无标签站点").locator(".card-tags").count()) === 0);

  await page.click("#saveBtn");
  await page.waitForTimeout(700);
  saved = await (await fetch(BASE + "/api/config")).json();
  const cleared = saved.groups[1].items.find((i) => i.title === "无标签站点");
  check("空标签不落库（不写 tags: []，而是没有这个字段）",
    cleared && cleared.tags === undefined, JSON.stringify(cleared && cleared.tags));

  /* ==================== G. 脚本错误 ==================== */
  console.log("== G. 无脚本错误 ==");
  check("全过程无 JS 错误", pageErrors.length === 0, pageErrors.join(" | "));

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
