/* Navi 导航站 · 服务端集成测试（零依赖，Node 内置模块）
   用法：先启动 server.js，再运行 node test/server.test.js [baseUrl] */
"use strict";

const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8632";
const BASE_V6 = BASE.replace("127.0.0.1", "[::1]");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

async function req(path, opts) {
  const res = await fetch(BASE + path, opts);
  return res;
}

(async () => {
  console.log("== 静态资源 ==");
  for (const [p, type] of [
    ["/", "text/html"],
    ["/css/style.css", "text/css"],
    ["/js/app.js", "text/javascript"],
    ["/config.json", "application/json"],
    ["/favicon.svg", "image/svg+xml"]
  ]) {
    const r = await req(p);
    check("GET " + p + " -> 200 " + type,
      r.status === 200 && (r.headers.get("content-type") || "").includes(type),
      r.status + " " + r.headers.get("content-type"));
  }

  const notFound = await req("/no-such-file");
  check("GET 不存在文件 -> 404", notFound.status === 404, String(notFound.status));

  const traverse = await req("/../server.js");
  check("路径穿越被拦截（403/404）", [403, 404].includes(traverse.status), String(traverse.status));

  const method = await req("/", { method: "POST" });
  check("POST 静态路径 -> 405", method.status === 405, String(method.status));

  /* ---------- 前端资源版本号（?v= 由服务端按 mtime 自动推导）----------
     回归背景：js/css 走 7 天强缓存，缓存键是 URL。以前靠手工改 index.html 的 ?v=，
     一旦「改了 app.js 却忘了换版本号」，用户重建镜像后浏览器仍用旧文件，
     表现为「代码明明修了、镜像也重建了，页面还是老行为」。
     现在改为服务端下发时自动改写 ?v=，这里守住这个行为。 */
  console.log("== 前端资源版本号（自动推导）==");

  // 与服务端同一算法独立复算：public/js + public/css 的最新 mtime
  function deriveNewest() {
    let newest = 0;
    for (const dir of ["js", "css"]) {
      for (const n of fs.readdirSync(path.join(PUBLIC_DIR, dir))) {
        const st = fs.statSync(path.join(PUBLIC_DIR, dir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
    return newest;
  }
  function deriveToken() { return String(Math.round(deriveNewest())).slice(-10); }

  const idxRes = await req("/");
  const idxHtml = await idxRes.text();
  const srcHtml = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
  const servedJs = (idxHtml.match(/js\/app\.js\?v=([^"']*)/) || [])[1];
  const servedCss = (idxHtml.match(/css\/style\.css\?v=([^"']*)/) || [])[1];
  const literal = (srcHtml.match(/js\/app\.js\?v=([^"']*)/) || [])[1];

  check("HTML 中的 js/css 都带版本号", !!servedJs && !!servedCss, servedJs + " / " + servedCss);
  check("js 与 css 版本号一致", servedJs === servedCss, servedJs + " vs " + servedCss);
  check("版本号由 mtime 推导（不是源文件字面值透传）",
    servedJs !== literal && /^[0-9]+$/.test(servedJs || ""), "下发 " + servedJs + " / 字面 " + literal);
  check("版本号与前端文件最新修改时间一致", servedJs === deriveToken(), servedJs + " != " + deriveToken());
  check("HTML 不参与强缓存（no-cache）",
    /no-cache/.test(idxRes.headers.get("cache-control") || ""), idxRes.headers.get("cache-control"));
  check("静态资源仍走长缓存（靠版本号破键）",
    /max-age/.test((await req("/js/app.js")).headers.get("cache-control") || ""));

  // 断言「改了前端不用手工换版本号」：改动 mtime 后版本号必须自动跟着变。
  // 只动 mtime（+60s）不碰内容，测完还原；服务端 token 缓存 TTL 3s，故等待 3.3s。
  const appJs = path.join(PUBLIC_DIR, "js", "app.js");
  const origStat = fs.statSync(appJs);
  const origAtime = origStat.atime, origMtime = origStat.mtime;
  try {
    // 基准必须取「整个前端目录的最大 mtime」再加偏移，而不是 app.js 自己 +60s：
    // token 看的是 js 与 css 里的最新者。若刚改过 style.css（mtime 比 app.js 新），
    // 只把 app.js 调新并不能让它成为最大者，token 本就不该变 ——
    // 那样断言失败是假警报（真实发生过：改完 CSS 跑回归，这条挂了而功能完全正常）。
    const bumped = new Date(deriveNewest() + 60000);
    fs.utimesSync(appJs, origAtime, bumped);
    await new Promise((r) => setTimeout(r, 3300));
    const t2 = ((await (await req("/")).text()).match(/js\/app\.js\?v=([^"']*)/) || [])[1];
    check("前端文件一变，版本号自动变（无需手工改 ?v=）", t2 !== servedJs && t2 === deriveToken(), servedJs + " -> " + t2);
  } finally {
    fs.utimesSync(appJs, origAtime, origMtime);
    await new Promise((r) => setTimeout(r, 3300));
  }
  const t3 = ((await (await req("/")).text()).match(/js\/app\.js\?v=([^"']*)/) || [])[1];
  check("版本号可回退（mtime 还原后一致）", t3 === servedJs, t3 + " vs " + servedJs);

  // 反向守一条语义：token 看的是「js 与 css 目录里的最新 mtime」，不是只看 app.js。
  // 不守的话，将来有人把上面那条改回「只碰 app.js」，同一个坑会以假警报的形式再次出现。
  const cssPath = path.join(PUBLIC_DIR, "css", "style.css");
  const cssStat = fs.statSync(cssPath);
  try {
    fs.utimesSync(cssPath, cssStat.atime, new Date(deriveNewest() + 120000));
    await new Promise((r) => setTimeout(r, 3300));
    const t4 = ((await (await req("/")).text()).match(/js\/app\.js\?v=([^"']*)/) || [])[1];
    check("css 更新同样推进版本号（token 取整个前端目录的最新 mtime）",
      t4 !== servedJs && t4 === deriveToken(), servedJs + " -> " + t4);
  } finally {
    fs.utimesSync(cssPath, cssStat.atime, cssStat.mtime);
    await new Promise((r) => setTimeout(r, 3300));
  }
  const t5 = ((await (await req("/")).text()).match(/js\/app\.js\?v=([^"']*)/) || [])[1];
  check("css 的 mtime 还原后版本号也还原", t5 === servedJs, t5 + " vs " + servedJs);

  console.log("== 配置 API ==");
  const getRes = await req("/api/config");
  const cfg = await getRes.json();
  check("GET /api/config -> 200 且含 groups",
    getRes.status === 200 && Array.isArray(cfg.groups) && cfg.groups.length > 0);

  const putOk = await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg)
  });
  check("PUT 合法配置 -> {ok:true}", putOk.status === 200 && (await putOk.json()).ok === true);

  const badCfg = { groups: [{ name: "x", items: [{ title: "bad", url: "ftp://x" }] }] };
  const putBad = await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(badCfg)
  });
  check("PUT 非法 url -> 400 拒写", putBad.status === 400, String(putBad.status));

  {
    const badBody = await putBad.json().catch(() => ({}));
    check("PUT 非法 url -> 400 且返回 error 字段（前端清晰提示依赖此字段）",
      putBad.status === 400 && typeof badBody.error === "string" && badBody.error.length > 0,
      JSON.stringify(badBody));
  }

  const putBadJson = await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{not json"
  });
  check("PUT 非法 JSON -> 400", putBadJson.status === 400, String(putBadJson.status));

  const after = await (await req("/api/config")).json();
  check("非法写入后配置未被破坏",
    JSON.stringify(after.groups) === JSON.stringify(cfg.groups));

  // P1-7：来源追踪（source）与失效标记（stale）的写入口校验。
  // 与 netMode 同一套纪律：写错就在入口拒绝，而不是让它静默退化 ——
  // 例如 stale 写成字符串 "true"，前端的判断分支会悄悄走错，而用户毫无察觉。
  console.log("== 来源追踪 / 失效标记字段校验（P1-7） ==");
  const badFieldCases = [
    ["stale 非布尔", { title: "a", url: "https://a.example.com", stale: "true" }],
    ["source 是字符串", { title: "a", url: "https://a.example.com", source: "discover" }],
    ["source.type 非法", { title: "a", url: "https://a.example.com", source: { type: "guessed" } }],
    ["source.id 非字符串", { title: "a", url: "https://a.example.com", source: { type: "discover", id: 5 } }],
    ["staleAt 非字符串", { title: "a", url: "https://a.example.com", stale: true, staleAt: 123 }]
  ];
  for (const [name, item] of badFieldCases) {
    const r = await req("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: [{ name: "x", items: [item] }] })
    });
    const b = await r.json().catch(() => ({}));
    check("PUT " + name + " -> 400 拒写", r.status === 400, String(r.status));
    check("PUT " + name + " -> 返回可读 error",
      typeof b.error === "string" && b.error.length > 0, JSON.stringify(b));
  }

  // P2：卡片标签（tags）的写入口校验。标签是给搜索用的「跨分组索引」，
  // 写成字符串 "下载" 会让前端遍历出单个汉字当标签、检索结果莫名其妙；
  // 写成 [{name:"下载"}] 则整条标签链路静默失效 —— 因此在入口拒绝，与 netMode / stale 同策略。
  console.log("== 卡片标签字段校验（P2） ==");
  const badTagCases = [
    ["tags 是字符串", { title: "a", url: "https://a.example.com", tags: "下载" }],
    ["tags 含非字符串", { title: "a", url: "https://a.example.com", tags: ["下载", 7] }],
    ["tags 含空串", { title: "a", url: "https://a.example.com", tags: ["下载", "   "] }],
    ["tags 单项超 12 字", { title: "a", url: "https://a.example.com", tags: ["这个标签名字实在是太长了啊啊"] }],
    ["tags 超过 8 个", { title: "a", url: "https://a.example.com",
      tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"] }]
  ];
  for (const [name, item] of badTagCases) {
    const r = await req("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: [{ name: "x", items: [item] }] })
    });
    const b = await r.json().catch(() => ({}));
    check("PUT " + name + " -> 400 拒写", r.status === 400, String(r.status));
    check("PUT " + name + " -> 返回可读 error",
      typeof b.error === "string" && /标签/.test(b.error), JSON.stringify(b));
  }

  const okCfg = { groups: [{ name: "x", items: [
    { title: "源侧已消失", url: "https://a.example.com", stale: true,
      staleAt: "2026-09-20T00:00:00.000Z",
      tags: ["下载", "媒体"],
      source: { type: "discover", via: "docker", id: "abc123", syncedAt: "2026-09-19T00:00:00.000Z" } },
    { title: "手工", url: "https://b.example.com", source: { type: "manual" } }
  ] }] };
  const putOk2 = await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(okCfg)
  });
  check("PUT 合法 source/stale -> {ok:true}",
    putOk2.status === 200 && (await putOk2.json()).ok === true, String(putOk2.status));

  const backItem = (await (await req("/api/config")).json()).groups[0].items[0];
  check("source / stale / staleAt 原样往返（服务端不会抹掉这类元数据）",
    backItem.stale === true && backItem.staleAt === "2026-09-20T00:00:00.000Z" &&
    backItem.source && backItem.source.type === "discover" &&
    backItem.source.via === "docker" && backItem.source.id === "abc123",
    JSON.stringify(backItem));

  check("tags 原样往返（顺序与写法都不被改写，中文标签不丢）",
    Array.isArray(backItem.tags) && backItem.tags.length === 2 &&
    backItem.tags[0] === "下载" && backItem.tags[1] === "媒体",
    JSON.stringify(backItem.tags));

  // 边界不误杀：恰好 8 个标签、单项恰好 12 字都必须放行 ——
  // 上限是用来挡异常数据的，不该让合法数据在边界上莫名其妙被拒。
  const putEdgeTags = await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groups: [{ name: "x", items: [
      { title: "边界", url: "https://c.example.com",
        tags: ["一二三四五六七八九十十一", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] }
    ] }] })
  });
  check("PUT 恰好 8 个标签 / 单项恰好 12 字 -> 放行（边界不误杀）",
    putEdgeTags.status === 200, String(putEdgeTags.status));

  // 还原配置，避免影响后续检查
  await req("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg)
  });

  const health = await (await req("/api/health")).json();
  check("GET /api/health -> ok:true", health.ok === true);

  console.log("== IPv6 双栈 ==");
  try {
    const r6 = await fetch(BASE_V6 + "/api/health");
    check("IPv6 [::1] 访问 /api/health -> 200", r6.status === 200);
  } catch (e) {
    check("IPv6 [::1] 访问 /api/health -> 200", false, e.message);
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
