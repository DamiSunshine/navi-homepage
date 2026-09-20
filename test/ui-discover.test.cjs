/* Navi 导航站 · 服务发现 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   自包含：测试内自行启动「伪造 Docker API」与隔离的 navi 实例，
   不依赖外部已运行的服务，也不触碰真实 public/config.json。
   覆盖：入口可见性 / 弹窗渲染 / 图标解析 / 默认勾选 / 全选 / 加入草稿 /
        忽略与取消忽略 / 保存落盘 / 无 JS 错误。
   用法：NODE_PATH=<managed_workspace>/node_modules node test/ui-discover.test.cjs */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");

const PORT = 8661;
const DOCKER_PORT = 8662;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

const FAKE_CONTAINERS = [
  { Id: "aaaa1111", Names: ["/jellyfin"], Image: "linuxserver/jellyfin:latest", State: "running",
    Status: "Up 2 hours", Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: "tcp" }] },
  { Id: "bbbb2222", Names: ["/portainer"], Image: "portainer/portainer-ce", State: "running",
    Status: "Up 3 hours", Ports: [{ PrivatePort: 9443, PublicPort: 9443, Type: "tcp" }] },
  { Id: "cccc3333", Names: ["/qbittorrent"], Image: "linuxserver/qbittorrent", State: "running",
    Status: "Up 4 hours", Ports: [{ PrivatePort: 8081, PublicPort: 8081, Type: "tcp" }] },
  { Id: "dddd4444", Names: ["/redis"], Image: "redis:7", State: "running",
    Status: "Up 4 hours", Ports: [{ PrivatePort: 6379, PublicPort: 16379, Type: "tcp" }] },
  { Id: "eeee5555", Names: ["/legacy"], Image: "foo/legacy", State: "exited",
    Status: "Exited (0)", Ports: [{ PrivatePort: 8080, PublicPort: 18080, Type: "tcp" }] }
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navi-ui-discover-"));
const cfgPath = path.join(tmp, "config.json");
const upDir = path.join(tmp, "uploads");
fs.mkdirSync(upDir, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({
  site: { title: "DiscoverUI", subtitle: "服务发现 UI 测试" },
  groups: [{ name: "常用服务", items: [
    { title: "Jellyfin", desc: "影音媒体库", icon: "jellyfin",
      url: "http://192.168.1.10:8096", lanUrl: "http://192.168.1.10:8096" },
    // P1-7 用：来自服务发现、但容器已不在伪造结果里（id 对不上）→ 应被「只标记不删」。
    { title: "已消失的服务", desc: "容器已被删除", icon: "jellyfin",
      url: "http://192.168.1.10:9999", lanUrl: "http://192.168.1.10:9999",
      source: { type: "discover", via: "docker", id: "gone0000", syncedAt: "2026-09-01T00:00:00.000Z" } },
    // P1-7 用：本机端口来源，而本套件关掉了本机扫描 → 属「未接入，无法判定」，
    // 绝不能因为「扫描结果里没有它」就被判失效。
    { title: "本机端口服务", desc: "本机监听", icon: "jellyfin",
      url: "http://192.168.1.10:8899", lanUrl: "http://192.168.1.10:8899",
      source: { type: "discover", via: "local", id: "port-8899" } }
  ] }]
}, null, 2), "utf-8");

function startFakeDocker() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.indexOf("/containers/json") === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FAKE_CONTAINERS));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    srv.listen(DOCKER_PORT, "127.0.0.1", () => resolve(srv));
  });
}

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
        NAVI_LAN_HOST: "192.168.1.10",
        NAVI_WAN_HOST: "nav.example.com",
        DOCKER_SOCKET: path.join(tmp, "missing.sock"),
        DOCKER_HOST_NAME: "127.0.0.1",
        DOCKER_HOST_PORT: String(DOCKER_PORT)
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
let fake = null, navi = null, browser = null;

function cleanup() {
  try { if (browser) browser.close(); } catch (e) {}
  try { if (navi) navi.kill(); } catch (e) {}
  try { if (fake) fake.close(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  fake = await startFakeDocker();
  navi = await startNavi();

  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  const page = await browser.newPage();
  // 本套件声称"自包含"，就必须真的不依赖外网：图标 CDN 的请求就地应答。
  // 否则 CDN 抖一下会以 "Failed to load resource: ERR_CONNECTION_CLOSED" 的形式
  // 混进下面的「全程无 JS 错误」断言，看起来像被测代码有 Bug（曾实测偶发 1 失败）。
  await stubExternal(page);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (!isNotJsError(m.text())) return;
    pageErrors.push(m.text());
  });

  console.log("== 入口可见性 ==");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 10000 });
  check("非编辑模式下不显示「服务发现」入口",
    await page.locator("#saveBar[hidden]").count() === 1);
  check("编辑模式外弹窗保持隐藏", await page.locator("#discoverModal[hidden]").count() === 1);

  console.log("== 编辑模式与弹窗 ==");
  await page.click("#editToggle");
  await page.waitForSelector("#saveBar:not([hidden])");
  check("编辑模式出现「服务发现」按钮",
    await page.locator("#discoverBtn:visible").count() === 1);

  await page.click("#discoverBtn");
  await page.waitForSelector("#discoverModal:not([hidden])");
  await page.waitForSelector(".discover-row", { timeout: 15000 });
  check("弹窗打开并渲染候选行", await page.locator(".discover-row").count() > 0);

  const rowCount = await page.locator(".discover-row").count();
  check("候选数 = 5（容器全部列出）", rowCount === 5, String(rowCount));

  const srcText = (await page.locator("#discoverSrc").textContent()).trim();
  check("来源摘要显示 Docker", srcText.indexOf("Docker") !== -1, srcText);

  console.log("== P1-7 失效标记：源侧已消失 → 只标记、不删除 ==");
  // 配置里 id=gone0000 的卡片来自 docker，但伪造容器列表里没有它 → 应被判为可能已失效
  check("触发失效提示条", await page.locator("#staleBar:not([hidden])").count() === 1);
  const staleBarTxt = (await page.locator("#staleBarText").textContent()) || "";
  check("提示条写明「只标记、未删除」并交代判定来源",
    /未删除/.test(staleBarTxt) && /Docker/.test(staleBarTxt), staleBarTxt);
  check("对应的卡片挂上失效角标（data-stale）",
    await page.locator('.card[data-stale="1"]').count() === 1);
  check("角标文案可读",
    ((await page.locator(".stale-pin").first().textContent()) || "").indexOf("可能失效") !== -1,
    await page.locator(".stale-pin").first().textContent());
  check("失效卡片的角标来自服务发现（data-source=discover）",
    await page.locator('.card[data-stale="1"]').getAttribute("data-source") === "discover",
    await page.locator('.card[data-stale="1"]').getAttribute("data-source"));
  check("失效卡片仍可点击（href 未被清空）",
    /^https?:\/\//.test(await page.locator('.card[data-stale="1"]').getAttribute("href") || ""),
    await page.locator('.card[data-stale="1"]').getAttribute("href"));
  check("卡片数不变（只标记，绝不自动删除）",
    await page.locator(".card").count() === 3, String(await page.locator(".card").count()));
  check("来源未接入的卡片不被误标（本机端口来源 + 本套件关了本机扫描）",
    await page.locator('.card[data-source="discover"][data-stale="1"]').count() === 1 &&
    !(await page.locator('.card[href="http://192.168.1.10:8899"]').getAttribute("data-stale")),
    await page.locator('.card[href="http://192.168.1.10:8899"]').getAttribute("data-stale"));
  const staleSnap = await page.evaluate(() => window.NaviApp.staleCards());
  check("失效快照可读且带 source.id / via",
    staleSnap.length === 1 && staleSnap[0].id === "gone0000" && staleSnap[0].via === "docker",
    JSON.stringify(staleSnap));
  const staleMeta = await page.evaluate(() => window.NaviApp.staleMeta());
  check("stale 元数据可读：checked 含 docker、skipped 含 local（未接入 ≠ 失效）",
    Array.isArray(staleMeta.checked) && staleMeta.checked.indexOf("docker") >= 0 &&
    Array.isArray(staleMeta.skipped) && staleMeta.skipped.indexOf("local") >= 0,
    JSON.stringify(staleMeta));

  console.log("== 图标自动匹配 ==");
  const iconImgs = await page.locator(".discover-row .discover-icon img").count();
  const iconFb = await page.locator(".discover-row .discover-icon .icon-fallback").count();
  check("每行图标都已解析（图片或字母回退）", iconImgs + iconFb === rowCount, `${iconImgs}+${iconFb}`);

  const jfRow = page.locator('.discover-row[data-id="aaaa1111"]');
  const jfSrc = await jfRow.locator(".discover-icon img").getAttribute("src");
  // P1-6 起图标本地优先：jellyfin 在内置库里，所以解析成 /icons/ 而不是外链。
  // 断网/局域网场景下这条才是能出图的那条路（CDN 只在本地没收录时才兜底）。
  check("Jellyfin 命中内置本地图标库（离线可用）", jfSrc === "/icons/jellyfin.svg", jfSrc);

  const ptRow = page.locator('.discover-row[data-id="bbbb2222"]');
  const ptSrc = await ptRow.locator(".discover-icon img").getAttribute("src");
  check("Portainer 命中内置本地图标库（selfhst 短名也走本地）", ptSrc === "/icons/portainer.svg", ptSrc);
  // 本地命中不算本事，本地没有时还能回退 CDN 才算链路完整
  const fbSrc = await page.evaluate(() => window.NaviApp.resolveIcon("no-such-icon-slug-zzz", ""));
  check("本地库未收录的图标仍回退公共 CDN（本地优先 ≠ 只能用本地）",
    /^https:\/\/cdn\.jsdelivr\.net\//.test(fbSrc), fbSrc);

  console.log("== 地址自动生成 ==");
  check("Jellyfin 内网地址自动拼接",
    (await jfRow.locator('input[data-k="lanUrl"]').inputValue()) === "http://192.168.1.10:8096",
    await jfRow.locator('input[data-k="lanUrl"]').inputValue());
  check("Jellyfin 外网地址走 https 无端口",
    (await jfRow.locator('input[data-k="url"]').inputValue()) === "https://nav.example.com",
    await jfRow.locator('input[data-k="url"]').inputValue());
  check("Portainer 内网地址带映射端口",
    (await ptRow.locator('input[data-k="lanUrl"]').inputValue()) === "http://192.168.1.10:9443");

  console.log("== 默认勾选与状态标注 ==");
  check("已存在的 Jellyfin 勾选框禁用",
    await jfRow.locator('input[data-k="sel"]').isDisabled());
  check("已在导航中显示对应标签",
    (await jfRow.locator(".discover-tag").textContent()).indexOf("已在导航中") !== -1,
    await jfRow.locator(".discover-tag").textContent());

  const redisRow = page.locator('.discover-row[data-id="dddd4444"]');
  check("依赖容器 Redis 默认不勾选",
    !(await redisRow.locator('input[data-k="sel"]').isChecked()));
  check("依赖容器标注「依赖容器」",
    (await redisRow.locator(".discover-tag").textContent()).indexOf("依赖容器") !== -1);

  const legacyRow = page.locator('.discover-row[data-id="eeee5555"]');
  check("已停止容器默认不勾选", !(await legacyRow.locator('input[data-k="sel"]').isChecked()));

  const qbRow = page.locator('.discover-row[data-id="cccc3333"]');
  check("运行中且可用的 qBittorrent 默认勾选",
    await qbRow.locator('input[data-k="sel"]').isChecked());

  const cntText = await page.locator("#discoverCount").textContent();
  check("统计文案正确（可加入 4 项 · 已选 2 项）",
    cntText.indexOf("可加入 4 项") !== -1 && cntText.indexOf("已选 2 项") !== -1, cntText);

  console.log("== 全选 / 忽略交互 ==");
  await page.uncheck("#discoverAll");
  check("取消全选后按钮禁用", await page.locator("#discoverAddBtn").isDisabled());
  check("取消全选不会勾选依赖 / 已停止容器",
    !(await redisRow.locator('input[data-k="sel"]').isChecked()) &&
    !(await legacyRow.locator('input[data-k="sel"]').isChecked()));
  await page.check("#discoverAll");
  check("全选后推荐项全部勾选",
    (await qbRow.locator('input[data-k="sel"]').isChecked()) &&
    (await ptRow.locator('input[data-k="sel"]').isChecked()));
  check("全选不改变依赖 / 已停止容器的勾选态",
    !(await redisRow.locator('input[data-k="sel"]').isChecked()) &&
    !(await legacyRow.locator('input[data-k="sel"]').isChecked()));

  await legacyRow.locator('[data-act="ignore"]').click();
  check("忽略后标签变为「已忽略」",
    (await legacyRow.locator(".discover-tag").textContent()).indexOf("已忽略") !== -1,
    await legacyRow.locator(".discover-tag").textContent());
  check("忽略后该项不参与加入（可加入降为 3 项 · 已选仍 2 项）",
    (await page.locator("#discoverCount").textContent()).indexOf("可加入 3 项") !== -1 &&
    (await page.locator("#discoverCount").textContent()).indexOf("已选 2 项") !== -1,
    await page.locator("#discoverCount").textContent());
  await legacyRow.locator('[data-act="unignore"]').click();
  check("取消忽略后恢复原状态",
    (await legacyRow.locator(".discover-tag").textContent()).indexOf("已忽略") === -1);

  console.log("== 加入选中项 ==");
  const beforeCards = await page.locator(".card").count();
  await page.locator("#discoverAddBtn").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".card").length > n, beforeCards, { timeout: 5000 }
  );
  const afterCards = await page.locator(".card").count();
  check("卡片数增加 2 张（Portainer + qBittorrent）", afterCards === beforeCards + 2,
    `${beforeCards} -> ${afterCards}`);
  check("新增分组「Docker 服务」已创建",
    await page.locator('.group[data-name="Docker 服务"]').count() === 1);
  check("已加入项在弹窗中标记为「已在导航中」",
    (await ptRow.locator(".discover-tag").textContent()).indexOf("已在导航中") !== -1);
  check("加入后按钮回到禁用（无可加入项）",
    await page.locator("#discoverAddBtn").isDisabled());

  console.log("== 保存落盘 ==");
  await page.locator('#discoverModal [data-close="discoverModal"]').click();
  await page.locator("#saveBtn").click();
  await page.waitForSelector("#saveBar", { state: "hidden", timeout: 10000 });

  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const grp = (saved.groups || []).filter((g) => g.name === "Docker 服务")[0];
  check("配置已写入服务器（新增分组存在）", !!grp);
  check("新增分组含 2 个导航项", grp && grp.items.length === 2,
    grp && String(grp.items.length));
  const savedPt = grp && grp.items.filter((i) => i.title === "Portainer")[0];
  check("Portainer 图标与内网地址已落盘",
    !!savedPt && savedPt.icon === "selfhst:portainer" &&
    savedPt.lanUrl === "http://192.168.1.10:9443",
    JSON.stringify(savedPt));
  check("忽略记录随草稿持久化（discovery.ignored 存在）",
    saved.discovery && Array.isArray(saved.discovery.ignored));
  check("原有导航项未被破坏",
    saved.groups.some((g) => g.items.some((i) => i.title === "Jellyfin")));

  // P1-7：来源与失效标记必须真的落盘（否则「只标记不删」在重启后就丢了）
  check("发现来源随卡片落盘（source.type/id/via）",
    !!savedPt && !!savedPt.source && savedPt.source.type === "discover" &&
    savedPt.source.id === "bbbb2222" && savedPt.source.via === "docker",
    JSON.stringify(savedPt && savedPt.source));
  const savedStale = (saved.groups || []).reduce((a, g) => a.concat(g.items || []), [])
    .filter((i) => i.stale === true);
  check("失效标记随保存落盘（stale:true + staleAt）",
    savedStale.length === 1 && savedStale[0].title === "已消失的服务" && !!savedStale[0].staleAt,
    JSON.stringify(savedStale));
  check("手工新建/原有卡片不被误标失效",
    !savedStale.some((i) => i.title === "Jellyfin") &&
    (saved.groups || []).reduce((a, g) => a.concat(g.items || []), [])
      .filter((i) => i.title === "Jellyfin").every((i) => i.stale === undefined));

  console.log("== P1-7 恢复 / 清理（两个显式动作） ==");
  // 保存后会退出编辑模式，重新进编辑模式再开发现弹窗
  await page.click("#editToggle");
  await page.waitForSelector("#saveBar:not([hidden])");
  await page.click("#discoverBtn");
  await page.waitForSelector("#discoverModal:not([hidden])");
  await page.waitForSelector(".discover-row", { timeout: 15000 });
  check("重新扫描后失效标记仍在（落盘的 stale 被读回）",
    await page.locator('.card[data-stale="1"]').count() === 1);

  await page.locator("#staleRestoreBtn").click();
  check("「恢复全部」清除标记后提示条隐藏",
    await page.locator("#staleBar[hidden]").count() === 1);
  check("「恢复全部」不删除卡片",
    await page.locator('.card[data-stale="1"]').count() === 0 &&
    await page.locator(".card").count() === 5, String(await page.locator(".card").count()));
  check("恢复后失效快照为空",
    (await page.evaluate(() => window.NaviApp.staleCards())).length === 0);

  // 重新扫描 → 再次判定失效（源侧依旧没有它），用「清理失效项」走删除路径
  await page.locator("#discoverRescan").click();
  await page.waitForFunction(
    () => document.querySelectorAll('.card[data-stale="1"]').length === 1, null, { timeout: 15000 }
  );
  check("重新扫描重新判定失效（标记可重复建立）",
    await page.locator("#staleBar:not([hidden])").count() === 1);

  // 「清理失效项」是唯一会删数据的动作 → 必须二次确认
  let dialogMsg = "";
  page.on("dialog", (d) => { dialogMsg = d.message(); d.accept(); });
  const cardsBeforeClean = await page.locator(".card").count();
  await page.locator("#staleCleanBtn").click();
  check("清理前弹出二次确认（说明可恢复路径）",
    /确定要删除/.test(dialogMsg) && /恢复全部/.test(dialogMsg), dialogMsg);
  check("确认清理后失效卡片被移除",
    await page.locator(".card").count() === cardsBeforeClean - 1,
    `${cardsBeforeClean} -> ${await page.locator(".card").count()}`);
  check("清理后不再有失效卡片",
    await page.locator('.card[data-stale="1"]').count() === 0 &&
    await page.locator("#staleBar[hidden]").count() === 1);

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
