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

  // 按需加载必须在「任何搜索行为之前」断言，否则前面的搜索已经把它加载了
  check("首屏未加载拼音表（按需加载 P0-1）",
    (await page.evaluate(() => typeof window.NaviPinyin)) === "undefined");
  check("index.html 未静态引入 pinyin.js（保持首屏轻量）",
    (await page.evaluate(() => !document.querySelector('script[src*="pinyin.js"]'))));
  check("拼音表文件可被浏览器取到（HTTP 200）",
    (await page.evaluate(() => fetch("/js/pinyin.js").then((r) => r.status))) === 200);

  check("标题正确", (await page.title()).indexOf("Navi") !== -1, await page.title());
  check("导航卡片数量 = " + initialCount, (await page.locator(".card").count()) === initialCount);
  check("分组数量 = " + apiCfg.groups.length,
    (await page.locator(".group").count()) === apiCfg.groups.length);
  const clock = await page.locator("#clock").textContent();
  check("时钟运行", /^\d{2}:\d{2}:\d{2}$/.test(clock.trim()), clock);
  check("默认自动模式（P0-3：不再整站一刀切）",
    (await page.locator("#netLabel").textContent()).trim() === "自动",
    await page.locator("#netLabel").textContent());
  const iconCount = await page.locator(".card-icon img, .card-icon .icon-fallback").count();
  check("图标均已解析（图片或字母回退）", iconCount === initialCount, String(iconCount));

  console.log("== 图标本地优先（P1-6：内网/断网也能出图） ==");
  // 等本地图标全部就绪，否则会把「还没加载完」误判成「裂图」
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll(".card-icon img"))
      .filter((i) => (i.getAttribute("src") || "").indexOf("/icons/") === 0)
      .every((i) => i.complete),
    null, { timeout: 10000 }
  ).catch(() => {});
  const iconStats = await page.evaluate((cfg) => {
    const map = window.NAVI_LOCAL_ICONS || {};
    const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const imgs = Array.from(document.querySelectorAll(".card-icon img"));
    const srcs = imgs.map((i) => i.getAttribute("src") || "");
    const localImgs = imgs.filter((i) => (i.getAttribute("src") || "").indexOf("/icons/") === 0);
    let mappable = 0;
    (cfg.groups || []).forEach((g) => {
      (g.items || []).forEach((it) => {
        if (!it.logo && it.icon && map[slug(it.icon)]) mappable++;
      });
    });
    return {
      mapSize: Object.keys(map).length,
      total: srcs.length,
      local: localImgs.length,
      remote: srcs.filter((s) => /^https?:\/\//.test(s)).length,
      broken: localImgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")),
      mappable: mappable
    };
  }, apiCfg);
  check("内置图标映射表已加载且规模 >= 200（P1-6 的 200+ 目标）",
    iconStats.mapSize >= 200, String(iconStats.mapSize));
  check("配置里能本地命中的图标全部走了本地 /icons/（不是仍去打 CDN）",
    iconStats.local >= iconStats.mappable,
    "本地命中 " + iconStats.local + " 个 / 期望至少 " + iconStats.mappable + " 个");
  check("本地图标在浏览器里全部加载成功（无裂图）",
    iconStats.broken.length === 0, iconStats.broken.join(", "));

  // 解析契约：本地优先 ≠ 只能用本地。四条分支都要有人守着，
  // 否则「P1-6 把图标全改成本地」这种过度修正不会有任何测试报警。
  const rLocal = await page.evaluate(() => window.NaviApp.resolveIcon("jellyfin", ""));
  check("本地库收录的 slug 解析为本地路径（离线可用）", rLocal === "/icons/jellyfin.svg", rLocal);
  const rMiss = await page.evaluate(() => window.NaviApp.resolveIcon("not-in-local-library-xyz", ""));
  check("本地库没有的 slug 仍回退到 CDN（本地优先不是只能用本地）",
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/walkxcode\/dashboard-icons\/png\/not-in-local-library-xyz\.png$/.test(rMiss),
    rMiss);
  const rSelf = await page.evaluate(() => window.NaviApp.resolveIcon("selfhst:portainer", ""));
  check("selfhst: 短名同样本地优先", rSelf === "/icons/portainer.svg", rSelf);
  const rSelfMiss = await page.evaluate(() => window.NaviApp.resolveIcon("selfhst:no-such-thing-xyz", ""));
  check("selfhst: 未收录时回退 self.hst CDN",
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/selfhst\/icons\/png\/no-such-thing-xyz\.png$/.test(rSelfMiss),
    rSelfMiss);
  const rIconify = await page.evaluate(() => window.NaviApp.resolveIcon("iconify:simple-icons:github", ""));
  check("iconify: 明确指定的在线图标不被本地替换",
    /^https:\/\/api\.iconify\.design\/simple-icons\/github\.svg/.test(rIconify), rIconify);
  const rDirect = await page.evaluate(() => window.NaviApp.resolveIcon("https://cdn.example.com/a.png", ""));
  check("图片直链原样返回（不劫持用户自己的地址）",
    rDirect === "https://cdn.example.com/a.png", rDirect);

  console.log("== 内外网切换（P0-3 三态：自动 / 内网 / 外网） ==");
  check("默认自动模式", (await page.locator("#netLabel").textContent()).trim() === "自动",
    await page.locator("#netLabel").textContent());
  check("默认不加 body.lan-mode", (await page.locator("body.lan-mode").count()) === 0);
  check("开关带 data-mode=auto", (await page.locator("#netToggle").getAttribute("data-mode")) === "auto");
  check("每张卡片都带 data-net（实际走向）",
    await page.evaluate(() => Array.prototype.every.call(document.querySelectorAll(".card"),
      (c) => c.getAttribute("data-net") === "lan" || c.getAttribute("data-net") === "wan")));

  const anyLan = apiCfg.groups.flatMap((g) => g.items).find((i) => i.lanUrl);
  const lanCard = '.card[data-has-lan="true"]';

  // 强制内网：应覆盖自动判断
  await page.click("#netToggle");
  check("第 1 次点击 -> 强制内网", (await page.locator("#netLabel").textContent()).trim() === "内网");
  check("强制内网时 body 应用 lan-mode", (await page.locator("body.lan-mode").count()) === 1);
  check("强制内网：有内网地址的卡片 href = lanUrl",
    (await page.locator(lanCard).first().getAttribute("href")) === anyLan.lanUrl,
    await page.locator(lanCard).first().getAttribute("href"));
  check("强制内网：data-net 全为 lan（与链接一致）",
    await page.evaluate((sel) => Array.prototype.every.call(document.querySelectorAll(sel),
      (c) => c.getAttribute("data-net") === "lan"), lanCard));

  // 强制外网
  await page.click("#netToggle");
  check("第 2 次点击 -> 强制外网", (await page.locator("#netLabel").textContent()).trim() === "外网");
  check("强制外网：href = 外网 url",
    (await page.locator(lanCard).first().getAttribute("href")) === anyLan.url,
    await page.locator(lanCard).first().getAttribute("href"));
  check("强制外网：data-net 全为 wan",
    await page.evaluate((sel) => Array.prototype.every.call(document.querySelectorAll(sel),
      (c) => c.getAttribute("data-net") === "wan"), lanCard));

  // 回到自动（三态循环闭合）
  await page.click("#netToggle");
  check("第 3 次点击 -> 回到自动", (await page.locator("#netLabel").textContent()).trim() === "自动");
  check("用户选择写入 localStorage（下次访问沿用）",
    (await page.evaluate(() => localStorage.getItem("navi-net-mode"))) === "auto");
  check("自动模式下每张卡片的 href 与 data-net 自洽",
    await page.evaluate(() => {
      var bad = 0;
      Array.prototype.forEach.call(document.querySelectorAll(".card"), function (c) {
        var href = c.getAttribute("href");
        var net = c.getAttribute("data-net");
        if (net === "lan" && !/^https?:/.test(href)) bad++;
        if (net === "lan" && c.getAttribute("data-has-lan") !== "true") bad++;
      });
      return bad === 0;
    }));
  check("自动模式徽标汇报内/外网分布",
    /自动模式/.test((await page.locator("#netBadgeText").textContent()) || ""),
    await page.locator("#netBadgeText").textContent());

  console.log("== 搜索过滤 ==");
  await page.fill("#searchInput", "jelly");
  await page.waitForTimeout(200);
  check("搜索 jelly -> 仅 1 张卡片", (await page.locator(".card").count()) === 1,
    String(await page.locator(".card").count()));
  await page.fill("#searchInput", "");
  await page.waitForTimeout(200);
  check("清空搜索恢复全部", (await page.locator(".card").count()) === initialCount);

  console.log("== 拼音搜索（P0-1） ==");
  // 搜索框获得焦点 = 搜索意图 → 触发加载
  await page.click("#searchInput");
  await page.waitForFunction(() => !!window.NaviPinyin, null, { timeout: 15000 });
  const pyMeta = await page.evaluate(() => ({ size: window.NaviPinyin.size, syls: window.NaviPinyin.syllables }));
  check("聚焦搜索框后拼音表已加载", pyMeta.size > 20000, JSON.stringify(pyMeta));
  check("拼音表音节数合理（约 410）", pyMeta.syls >= 380 && pyMeta.syls <= 500, String(pyMeta.syls));

  // 全拼命中
  await page.fill("#searchInput", "wangyi");
  await page.waitForTimeout(250);
  check("全拼「wangyi」命中 网易云音乐",
    (await page.locator('.card:has-text("网易云音乐")').count()) === 1);
  // 首字母缩写命中
  await page.fill("#searchInput", "wyyy");
  await page.waitForTimeout(250);
  check("首字母「wyyy」命中 网易云音乐",
    (await page.locator('.card:has-text("网易云音乐")').count()) === 1);
  await page.fill("#searchInput", "bd");
  await page.waitForTimeout(250);
  check("首字母「bd」命中 百度", (await page.locator('.card:has-text("百度")').count()) === 1);
  // 精度：不在音节边界上的短拼音不应命中（否则短查询会把整页点亮）
  await page.fill("#searchInput", "ya");
  await page.waitForTimeout(250);
  check("非音节边界的短查询「ya」不命中 网易云音乐（避免噪音）",
    (await page.locator('.card:has-text("网易云音乐")').count()) === 0);
  // 原有字面搜索能力不受影响
  await page.fill("#searchInput", "jelly");
  await page.waitForTimeout(250);
  check("字面搜索「jelly」仍命中 1 张卡片", (await page.locator(".card").count()) === 1);
  await page.fill("#searchInput", "");
  await page.waitForTimeout(250);
  check("清空后恢复全部卡片", (await page.locator(".card").count()) === initialCount);

  /* ---------- 命令面板（P0-2） ---------- */
  console.log("== 命令面板 Ctrl+K（P0-2） ==");
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#paletteMask:not([hidden])", { timeout: 5000 });
  check("Ctrl+K 打开命令面板", await page.locator("#paletteMask").isVisible());
  check("面板打开即自动聚焦输入框",
    await page.evaluate(() => document.activeElement && document.activeElement.id === "paletteInput"));

  await page.fill("#paletteInput", "jelly");
  await page.waitForTimeout(400);
  const itemRows = await page.locator('#paletteList .palette-row:not([data-engine])').count();
  check("面板内搜索「jelly」命中 1 个导航项", itemRows === 1, String(itemRows));
  check("同时给出 1 行搜索引擎出口（任何时候都能上网搜）",
    (await page.locator('#paletteList .palette-row[data-engine="1"]').count()) === 1);
  check("默认高亮第一行", (await page.locator("#paletteList .palette-row.is-active").count()) === 1);
  const activeHref = await page.locator("#paletteList .palette-row.is-active").getAttribute("href");
  const jellyItem = apiCfg.groups.flatMap((g) => g.items).find((i) => /jelly/i.test(i.title));
  // 不写死走内网还是外网（那取决于探测结果与运行环境），而是断言
  // 「面板与网格两处判定一致」—— 这正是最容易写岔的地方。
  check("面板条目与网格卡片指向同一地址（两处判定一致）",
    activeHref === (await page.locator('.card:has-text("Jellyfin")').getAttribute("href")),
    activeHref + " vs " + (await page.locator('.card:has-text("Jellyfin")').getAttribute("href")));
  check("面板条目地址是该项的 url 或 lanUrl 之一",
    activeHref === jellyItem.url || activeHref === jellyItem.lanUrl, activeHref);
  check("默认高亮的是导航项而非搜索出口（Enter 不会误上网）",
    (await page.locator('#paletteList .palette-row[data-engine="1"].is-active').count()) === 0);
  check("命中数统计已展示",
    /命中/.test((await page.locator("#paletteScope").textContent()) || ""),
    await page.locator("#paletteScope").textContent());

  // 高亮片段
  await page.fill("#paletteInput", "jelly");
  await page.waitForTimeout(300);
  check("命中片段被 mark 高亮标记",
    (await page.locator("#paletteList .palette-row-title mark").count()) >= 1);
  check("中文标题搜拼音时展示拼音徽标（无字面片段可高亮）",
    await (async () => {
      await page.fill("#paletteInput", "wyyy");
      await page.waitForTimeout(350);
      return (await page.locator("#paletteList .palette-row-py").count()) >= 1;
    })());

  // 分组小节
  await page.fill("#paletteInput", "e");
  await page.waitForTimeout(350);
  check("结果按分组小节展示（分组小节 + 联网搜索小节）",
    (await page.locator("#paletteList .palette-sec").count()) >= 2,
    String(await page.locator("#paletteList .palette-sec").count()));
  check("相邻同组结果只出现一次小节标题（不按行重复）",
    await page.evaluate(() => {
      var secs = Array.prototype.map.call(document.querySelectorAll("#paletteList .palette-sec"),
        function (s) { return s.textContent; });
      for (var i = 1; i < secs.length; i++) if (secs[i] === secs[i - 1]) return false;
      return true;
    }));

  // 键盘导航
  const rowCount = await page.locator("#paletteList .palette-row").count();
  if (rowCount >= 2) {
    const idxBefore = await page.evaluate(() =>
      Array.prototype.indexOf.call(document.querySelectorAll("#paletteList .palette-row"),
        document.querySelector("#paletteList .palette-row.is-active")));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const idxAfter = await page.evaluate(() =>
      Array.prototype.indexOf.call(document.querySelectorAll("#paletteList .palette-row"),
        document.querySelector("#paletteList .palette-row.is-active")));
    check("ArrowDown 移动高亮", idxAfter === idxBefore + 1, idxBefore + " -> " + idxAfter);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(120);
    const idxBack = await page.evaluate(() =>
      Array.prototype.indexOf.call(document.querySelectorAll("#paletteList .palette-row"),
        document.querySelector("#paletteList .palette-row.is-active")));
    check("ArrowUp 回退高亮", idxBack === idxBefore, idxBefore + " -> " + idxBack);
  } else {
    check("ArrowDown 移动高亮（行数不足，跳过）", true);
    check("ArrowUp 回退高亮（行数不足，跳过）", true);
  }

  // 搜索引擎出口（config.json 已配置 site.searchEngines）
  await page.fill("#paletteInput", "zzz-绝不可能匹配的查询");
  await page.waitForTimeout(400);
  check("无命中时展示空态提示", (await page.locator("#paletteList .palette-empty").count()) === 1);
  check("无命中时仍给出搜索引擎出口",
    (await page.locator('#paletteList .palette-row[data-engine="1"]').count()) === 1);
  const engHref = await page.locator('#paletteList .palette-row[data-engine="1"]').getAttribute("href");
  check("搜索引擎链接携带已编码的关键词",
    /baidu\.com\/s\?wd=/.test(engHref || "") && /zzz-/.test(decodeURIComponent(engHref || "")), engHref);
  check("搜索出口默认高亮（Enter 即可上网搜）",
    (await page.locator('#paletteList .palette-row[data-engine="1"].is-active').count()) === 1);

  // Enter 打开新标签
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 8000 }).catch(() => null),
    page.keyboard.press("Enter")
  ]);
  check("Enter 在新标签打开结果", !!popup, popup ? "已打开" : "未捕获到新标签");
  if (popup) await popup.close();
  check("Enter 打开后自动关闭面板", await page.locator("#paletteMask").isHidden());

  // Esc 关闭
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#paletteMask:not([hidden])", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Esc 关闭命令面板", await page.locator("#paletteMask").isHidden());
  check("Esc 关闭后面板输入框不再持有焦点",
    await page.evaluate(() => document.activeElement && document.activeElement.id !== "paletteInput"));
  // Ctrl+K 可再次打开并切换（再按一次关闭）
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#paletteMask:not([hidden])", { timeout: 5000 });
  check("Ctrl+K 可再次打开", await page.locator("#paletteMask").isVisible());
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(200);
  check("再次 Ctrl+K 关闭（可切换）", await page.locator("#paletteMask").isHidden());

  // 兼容性：老的「/」快捷键仍然可用
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  check("「/」快捷键仍然聚焦搜索框（向后兼容）",
    await page.evaluate(() => document.activeElement && document.activeElement.id === "searchInput"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

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
  // 用 RFC 5737 TEST-NET-1（192.0.2.0/24，保证不可路由）作为内网地址：
  // 探测结论必然为「不可达」，这样对自动降级行为的断言才是确定性的，
  // 不会因为在哪台机器上跑测试而改变。
  await page.fill('#itemForm [name="lanUrl"]', "http://192.0.2.1:9000");
  await page.fill('#itemForm [name="icon"]', "iconify:simple-icons:testcafe");
  check("编辑表单含「内外网策略」选择器", (await page.locator('#itemForm [name="netMode"]').count()) === 1);
  check("默认策略为「自动」", (await page.locator('#itemForm [name="netMode"]').inputValue()) === "auto");
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
  check("未指定策略的卡片不带 data-net-pinned 属性",
    (await page.locator('.card:has-text("UI测试项-改")').getAttribute("data-net-pinned")) === null);

  // 保存写回服务器
  await page.click("#saveBtn");
  await page.waitForTimeout(600);
  const savedCfg = await (await fetch(BASE + "/api/config")).json();
  const savedItem = savedCfg.groups[0].items.find((i) => i.title === "UI测试项-改");
  check("保存已写回服务器 config.json", !!savedItem && savedItem.lanUrl === "http://192.0.2.1:9000");
  check("保存后未指定策略的卡片不带 netMode 字段", !!savedItem && savedItem.netMode === undefined,
    JSON.stringify(savedItem && savedItem.netMode));
  check("保存后退出编辑模式", !(await page.locator("#saveBar").isVisible()));

  /* ---------- P0-3：内网可达性探测 + 卡片级 netMode ---------- */
  console.log("== 内网可达性探测与卡片级策略（P0-3） ==");
  check("探测已启动（首帧渲染之后）",
    await page.evaluate(() => window.NaviApp.probeState().started));
  check("探测只针对内网地址、并做了去重",
    await page.evaluate(() => {
      const s = window.NaviApp.probeState();
      // 重复的 host:port 只探一次；目标数应为个位数而不是卡片数
      return s.total <= 20 && Object.keys(s.verdicts).length >= 1;
    }));
  // 等待本轮探测收敛（不可达地址要等 2s 超时）
  await page.waitForFunction(() => {
    const s = window.NaviApp.probeState();
    return s.started && (s.total === 0 || s.done >= s.total);
  }, null, { timeout: 30000 });
  const probe = await page.evaluate(() => window.NaviApp.probeState());
  check("探测全部收敛", probe.done >= probe.total, JSON.stringify(probe));
  check("探测结论写入 sessionStorage 缓存（刷新不重复探测）",
    await page.evaluate(() => !!sessionStorage.getItem("navi-lan-probe")));
  // 关键断言：不可达的内网地址必须被判定为不可达
  await page.waitForFunction(() => {
    const v = window.NaviApp.probeState().verdicts["http://192.0.2.1:9000"];
    return v && v.ok === false;
  }, null, { timeout: 30000 });
  check("不可达的内网地址被判定为 ok=false",
    await page.evaluate(() => window.NaviApp.probeState().verdicts["http://192.0.2.1:9000"].ok === false));

  const testCardSel = '.card:has-text("UI测试项-改")';
  check("自动模式：内网不可达 -> 自动回退外网地址",
    (await page.locator(testCardSel).getAttribute("href")) === "https://test.example.com",
    await page.locator(testCardSel).getAttribute("href"));
  check("自动模式：该卡片 data-net=wan",
    (await page.locator(testCardSel).getAttribute("data-net")) === "wan");

  // 卡片级 netMode 优先级最高：即使探测说不可达，显式指定内网也要走内网
  await page.click("#editToggle");
  await page.locator(testCardSel).locator('[data-act="edit-item"]').click();
  await page.selectOption('#itemForm [name="netMode"]', "lan");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("显式指定「只用内网」后 href = lanUrl（优先级高于探测结论）",
    (await page.locator(testCardSel).getAttribute("href")) === "http://192.0.2.1:9000",
    await page.locator(testCardSel).getAttribute("href"));
  check("显式指定的卡片带 data-net-pinned 角标",
    (await page.locator(testCardSel).getAttribute("data-net-pinned")) === "lan");
  check("卡片上出现「内网」钉住角标",
    (await page.locator(testCardSel + " .net-pin").count()) === 1);
  await page.click("#saveBtn");
  await page.waitForTimeout(600);
  const pinnedCfg = await (await fetch(BASE + "/api/config")).json();
  const pinnedItem = pinnedCfg.groups[0].items.find((i) => i.title === "UI测试项-改");
  check("netMode 已随配置落库", !!pinnedItem && pinnedItem.netMode === "lan",
    JSON.stringify(pinnedItem && pinnedItem.netMode));

  // 改回自动后应立刻按探测结论走外网
  await page.click("#editToggle");
  await page.locator(testCardSel).locator('[data-act="edit-item"]').click();
  await page.selectOption('#itemForm [name="netMode"]', "auto");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("改回「自动」后按探测结论走外网",
    (await page.locator(testCardSel).getAttribute("href")) === "https://test.example.com",
    await page.locator(testCardSel).getAttribute("href"));
  check("钉住角标消失", (await page.locator(testCardSel + " .net-pin").count()) === 0);
  await page.click("#saveBtn");
  await page.waitForTimeout(600);
  const backCfg = await (await fetch(BASE + "/api/config")).json();
  const backItem = backCfg.groups[0].items.find((i) => i.title === "UI测试项-改");
  check("改回自动后 netMode 字段被移除（不残留）",
    !!backItem && backItem.netMode === undefined, JSON.stringify(backItem && backItem.netMode));

  // 服务端校验：非法 netMode 必须被拒绝
  const badCfg = JSON.parse(JSON.stringify(backCfg));
  badCfg.groups[0].items.find((i) => i.title === "UI测试项-改").netMode = "LAN";
  const badRes = await fetch(BASE + "/api/config", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(badCfg)
  });
  const badBody = await badRes.json();
  check("服务端拒绝非法 netMode（400）", badRes.status === 400 && /netMode/.test(badBody.error || ""),
    badRes.status + " " + JSON.stringify(badBody));

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

  // 此处刻意**不**截图：test/ui-home.png 是对外发布的资产，唯一生产者是 test/page-shots.cjs
  // （它会显式写 navi-theme=dark、用 1280x900 视口）。本套件若顺手截一张，会把发布图
  // 覆成浅色且尺寸另一个样（曾发生：preview.html 标注「夜间主题」而图是浅色）。
  // 需要看图请跑 node test/page-shots.cjs；护栏见 imagecompose.test.cjs 的「唯一生产者」断言。

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
