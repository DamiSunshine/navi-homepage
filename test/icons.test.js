/* Navi 导航站 · 内置本地图标库 专项测试（P1-6）
   背景：原先「在线图标库」只有 33 个推荐图标、且全部靠公共 CDN 现拉，
   而用户实访是局域网 HTTP —— 内网/断网时图标全白，是项目已确认的第二大短板。
   现在改为 public/icons/ 内置 200+ 个图标（脚本 scripts/build-icons.cjs 生成），
   前端本地优先、CDN 兜底。这个套件把「内置库真的完整、真的能用」变成可查事实。

   覆盖：清单自洽 / 每个文件真实存在且是合法图片 / 映射表与清单一致 /
        服务端能正确送出图标与目录 / 前端确实本地优先 / 中文站点兜底确实生效。
   用法：node test/icons.test.js（自带临时实例，不碰真实配置） */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ICON_DIR = path.join(ROOT, "public", "icons");
const CATALOG = path.join(ICON_DIR, "catalog.json");
const MAP_JS = path.join(ROOT, "public", "js", "icon-map.js");
const INDEX_HTML = path.join(ROOT, "public", "index.html");
const APP_JS = path.join(ROOT, "public", "js", "app.js");
const PORT = 8692;

const MIN_ICONS = 200;              // 路线图要求的「33 → 200+」
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;   // 体积上限：图标库不该悄悄膨胀到几 MB

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

function request(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: port, path: p, method: method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1" }, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

/* 按魔数判断文件是不是「浏览器真能当图片渲染」的东西。
   只看扩展名不够：把一段 HTML 错误页存成 .svg 也照样是 .svg。 */
function imageKind(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") return "png";
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return "ico";
  if (buf.slice(0, 3).toString("latin1") === "GIF") return "gif";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (/<svg[\s>]/i.test(buf.slice(0, 4096).toString("utf-8"))) return "svg";
  return null;
}

(async () => {
  console.log("== A. 目录清单自洽 ==");
  check("catalog.json 存在", fs.existsSync(CATALOG));
  let cat = null;
  try { cat = JSON.parse(fs.readFileSync(CATALOG, "utf-8")); } catch (e) { cat = null; }
  check("catalog.json 可以被解析", !!cat && Array.isArray(cat.icons));
  if (!cat) { console.log("\n结果：" + passed + " 通过, " + (failed + 1) + " 失败"); process.exit(1); }

  const icons = cat.icons || [];
  check("图标数量 >= " + MIN_ICONS + "（路线图 33 → 200+）", icons.length >= MIN_ICONS, String(icons.length));
  check("count 字段与数组长度一致（不允许自相矛盾）", cat.count === icons.length,
    cat.count + " vs " + icons.length);
  check("每条都有 slug / name / file 字段",
    icons.every((i) => i.slug && i.name && i.file),
    JSON.stringify(icons.find((i) => !i.slug || !i.name || !i.file) || ""));
  check("slug 一律是小写字母数字连字符（不会拼出越界路径）",
    icons.every((i) => /^[a-z0-9][a-z0-9-]*$/.test(i.slug)),
    JSON.stringify(icons.filter((i) => !/^[a-z0-9][a-z0-9-]*$/.test(i.slug)).slice(0, 5)));
  const dupSlug = icons.map((i) => i.slug).filter((s, i, a) => a.indexOf(s) !== i);
  check("slug 没有重复", dupSlug.length === 0, dupSlug.join(", "));
  const dupFile = icons.map((i) => i.file).filter((s, i, a) => a.indexOf(s) !== i);
  check("file 没有重复（不会两条指向同一个文件）", dupFile.length === 0, dupFile.join(", "));
  check("每条都有 keywords（本地搜索靠它）",
    icons.every((i) => typeof i.keywords === "string" && i.keywords.length >= 2),
    JSON.stringify(icons.filter((i) => !i.keywords).slice(0, 5)));
  check("每条都标了来源 source（可追溯）",
    icons.every((i) => i.source), JSON.stringify(icons.filter((i) => !i.source).slice(0, 5)));

  console.log("== B. 文件真实存在且是图片 ==");
  const missing = [], sizeMismatch = [], empty = [], notImage = [], htmlTrap = [];
  let totalBytes = 0;
  for (const it of icons) {
    const abs = path.join(ICON_DIR, it.file);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { missing.push(it.file); continue; }
    if (st.size <= 40) empty.push(it.file);
    if (typeof it.bytes === "number" && it.bytes !== st.size) sizeMismatch.push(it.file);
    totalBytes += st.size;
    const buf = fs.readFileSync(abs);
    if (!imageKind(buf)) notImage.push(it.file);
    if (/^\s*(<!doctype html|<html)/i.test(buf.slice(0, 512).toString("utf-8"))) htmlTrap.push(it.file);
  }
  check("清单里的文件全部存在于 public/icons/", missing.length === 0, missing.slice(0, 6).join(", "));
  check("记录体积与实际文件大小一致（清单没跑偏）", sizeMismatch.length === 0, sizeMismatch.slice(0, 6).join(", "));
  check("没有空文件", empty.length === 0, empty.slice(0, 6).join(", "));
  check("每个文件都是合法图片（按魔数判定，不看扩展名）", notImage.length === 0, notImage.slice(0, 6).join(", "));
  check("没有把上游的 HTML 错误页当成图标存下来", htmlTrap.length === 0, htmlTrap.slice(0, 6).join(", "));
  check("图标库总体积在预算内（< 2MB）", totalBytes < MAX_TOTAL_BYTES,
    Math.round(totalBytes / 1024) + " KB");
  check("图标全部放在 public/ 内（随 Dockerfile 的 COPY public/ 进镜像）",
    fs.realpathSync(ICON_DIR).startsWith(fs.realpathSync(path.join(ROOT, "public"))), ICON_DIR);

  console.log("== C. 中文站点兜底（上游图标库没有，靠 favicon 补齐） ==");
  const bySlug = {};
  icons.forEach((i) => { bySlug[i.slug] = i; });
  const CN_SITES = ["zhihu", "taobao", "jd", "netease-music"];
  const missingCn = CN_SITES.filter((s) => !bySlug[s]);
  check("含国内常用站点（知乎 / 淘宝 / 京东 / 网易云音乐）", missingCn.length === 0, missingCn.join(", "));
  const favSourced = icons.filter((i) => /^favicon:/.test(i.source || ""));
  check("至少有 8 个图标来自 favicon 兜底（证明这条链路真的跑通了）",
    favSourced.length >= 8, String(favSourced.length));
  const SELFHOSTED = ["jellyfin", "portainer", "nextcloud", "adguard-home", "home-assistant"];
  const missingSelf = SELFHOSTED.filter((s) => !bySlug[s]);
  check("含常见自托管服务图标", missingSelf.length === 0, missingSelf.join(", "));

  console.log("== D. 映射表与清单一致 ==");
  check("icon-map.js 存在", fs.existsSync(MAP_JS));
  let map = null;
  if (fs.existsSync(MAP_JS)) {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    try {
      vm.runInContext(fs.readFileSync(MAP_JS, "utf-8"), sandbox);
      map = sandbox.window.NAVI_LOCAL_ICONS || null;
    } catch (e) { map = null; }
  }
  check("icon-map.js 能执行并挂在 window.NAVI_LOCAL_ICONS 上", !!map && typeof map === "object");
  if (map) {
    const mapKeys = Object.keys(map).sort();
    const catKeys = icons.map((i) => i.slug).sort();
    check("映射表的 slug 集合与清单完全一致（不多不少）",
      JSON.stringify(mapKeys) === JSON.stringify(catKeys),
      "map=" + mapKeys.length + " catalog=" + catKeys.length);
    const badVal = icons.filter((i) => map[i.slug] !== "icons/" + i.file);
    check("映射表的取值与清单的 file 一一对应", badVal.length === 0,
      JSON.stringify(badVal.slice(0, 3)));
    check("值都是相对路径（不写死主机，换域名/子路径都不受影响）",
      Object.keys(map).every((k) => /^icons\/[a-z0-9-]+\.(svg|png|ico|gif|jpg)$/.test(map[k])),
      JSON.stringify(Object.entries(map).filter(([, v]) => !/^icons\/[a-z0-9-]+\.(svg|png|ico|gif|jpg)$/.test(v)).slice(0, 3)));
    check("文件头提示这是生成物（避免有人手改被下次 build 覆盖）",
      /不要手改|生成/.test(fs.readFileSync(MAP_JS, "utf-8").slice(0, 400)));
  }

  console.log("== E. 前端确实本地优先 ==");
  const html = fs.readFileSync(INDEX_HTML, "utf-8");
  const app = fs.readFileSync(APP_JS, "utf-8");
  check("index.html 引入了 js/icon-map.js", /<script[^>]+src=["']js\/icon-map\.js/.test(html));
  const iMap = html.indexOf("js/icon-map.js");
  const iApp = html.indexOf("js/app.js");
  check("icon-map.js 排在 app.js 之前（否则首屏渲染时映射表还没到）",
    iMap !== -1 && iApp !== -1 && iMap < iApp, "map@" + iMap + " app@" + iApp);
  check("app.js 读取 window.NAVI_LOCAL_ICONS", /window\.NAVI_LOCAL_ICONS/.test(app));
  check("app.js 有 localIcon() 本地优先查找", /function localIcon\s*\(/.test(app));
  check("短名形式先本地、后 CDN（正则确认顺序）",
    /return localIcon\(slug\) \|\| \("https:\/\/cdn\.jsdelivr\.net/.test(app));
  check("selfhst: 短名同样本地优先",
    /return localIcon\(iconSlug\(raw\)\) \|\| \("https:\/\/cdn\.jsdelivr\.net/.test(app));
  const iIconify = app.indexOf('icon.indexOf("iconify:")');
  const iSelfhst = app.indexOf('icon.indexOf("selfhst:")');
  const iconifyBlock = iIconify !== -1 && iSelfhst > iIconify ? app.slice(iIconify, iSelfhst) : "";
  check("能定位到 iconify 分支（否则下面那条断言形同虚设）", iconifyBlock.length > 40,
    String(iconifyBlock.length));
  check("iconify: 分支里不做本地替换（用户明确指定的在线图标不该被换掉）",
    !/localIcon\(/.test(iconifyBlock), iconifyBlock.replace(/\s+/g, " ").slice(0, 160));

  console.log("== F. 服务端能送出图标与目录 ==");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-icons-test-"));
  const tmpConfig = path.join(tmpDir, "config.json");
  fs.writeFileSync(tmpConfig, JSON.stringify({ site: { title: "IconsTest" }, groups: [] }), "utf-8");
  let srv = null;
  try {
    srv = await startServer(PORT, {
      NAVI_CONFIG_PATH: tmpConfig,
      NAVI_UPLOAD_DIR: path.join(tmpDir, "uploads"),
      NAVI_SCAN_LOCAL: "0"
    });

    // 取三种扩展名各一个做样本，避免只验到 svg
    const samples = ["svg", "ico", "png"].map((ext) => icons.find((i) => i.file.endsWith("." + ext))).filter(Boolean);
    check("样本覆盖到多种扩展名（不是只验 svg）", samples.length >= 2,
      samples.map((s) => s.file.split(".").pop()).join(", "));
    for (const s of samples) {
      const r = await request(PORT, "GET", "/icons/" + s.file);
      check("GET /icons/" + s.file + " 返回 200", r.status === 200, String(r.status));
      check("  " + s.file + " 的 Content-Type 正确",
        /^image\//.test(r.headers["content-type"] || ""), r.headers["content-type"]);
    }

    const rIdx = await request(PORT, "GET", "/index.html");
    check("首页 HTML 里带着 icon-map.js 的引用（版本号由服务端改写）",
      /js\/icon-map\.js\?v=\d+/.test(rIdx.body.toString("utf-8")));

    const rMap = await request(PORT, "GET", "/js/icon-map.js");
    check("GET /js/icon-map.js 返回 200", rMap.status === 200, String(rMap.status));

    const rLib = await request(PORT, "GET", "/api/library");
    const lib = JSON.parse(rLib.body.toString("utf-8"));
    check("GET /api/library 返回 200", rLib.status === 200, String(rLib.status));
    check("图床库的 presets 就是内置图标库（>= " + MIN_ICONS + "）",
      Array.isArray(lib.presets) && lib.presets.length >= MIN_ICONS,
      lib.presets && lib.presets.length);
    check("presets 首项与 catalog 首项对齐（服务端读的就是这份清单）",
      lib.presets && lib.presets[0] && lib.presets[0].icon === icons[0].slug,
      lib.presets && lib.presets[0] && lib.presets[0].icon);
    check("presets 的 icon 都是本地图标库里的 slug",
      (lib.presets || []).every((p) => !!bySlug[p.icon]),
      JSON.stringify((lib.presets || []).filter((p) => !bySlug[p.icon]).slice(0, 3)));
    check("presets 标记了 local=true（前端据此判断可离线用）",
      (lib.presets || []).every((p) => p.local === true),
      JSON.stringify((lib.presets || []).find((p) => p.local !== true) || ""));

    const rMiss = await request(PORT, "GET", "/icons/definitely-not-here.svg");
    check("不存在的图标返回 404（不会拿首页 HTML 冒充图片）", rMiss.status === 404, String(rMiss.status));
  } finally {
    if (srv) { try { srv.kill(); } catch (e) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("\n结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
