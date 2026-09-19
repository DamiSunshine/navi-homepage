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
  function deriveToken() {
    let newest = 0;
    for (const dir of ["js", "css"]) {
      for (const n of fs.readdirSync(path.join(PUBLIC_DIR, dir))) {
        const st = fs.statSync(path.join(PUBLIC_DIR, dir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
    return String(Math.round(newest)).slice(-10);
  }

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
    const bumped = new Date(origMtime.getTime() + 60000);
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
