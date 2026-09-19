/*
 * check-deploy.cjs（部署判定探针）的自检测试
 *
 * 为什么要有它：这个探针是「NAS 上跑的到底是不是新代码」的唯一裁判，
 * 如果它自己判错，用户会被误导。所以正反两面都要固化：
 *   正向：用当前 server.js 起实例 → 必须判为「新代码」
 *   反向：用复刻旧行为的桩服务（HTML 原样输出 + 7 天强缓存 + 旧 app.js）→ 必须判为「旧代码」
 *
 * 自包含：自行拉起两个临时实例（临时 config + 临时 uploads），不碰真实数据，不需要先起服务。
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
const PASSWORD = "selftest-pw-123";

let pass = 0;
let fail = 0;
function ok(label, extra) {
  pass++;
  console.log("  \u2705 " + label + (extra ? "  \u2192 " + extra : ""));
}
function bad(label, extra) {
  fail++;
  console.log("  \u274c " + label + (extra ? "  \u2192 " + extra : ""));
}
function section(t) {
  console.log("");
  console.log("== " + t + " ==");
}

function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "navi-chkdep-"));
  fs.mkdirSync(path.join(d, "uploads"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "public", "config.example.json"), path.join(d, "config.json"));
  return d;
}

function waitUp(url, tries) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n++;
      http.get(url, (res) => { res.resume(); resolve(); }).on("error", () => {
        if (n > (tries || 80)) return reject(new Error("服务未就绪：" + url));
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function runProbe(args, extraEnv) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, extraEnv || {});
    const p = spawn(NODE, [path.join(ROOT, "scripts", "check-deploy.cjs")].concat(args), { cwd: ROOT, env: env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (c) => resolve({ code: c, out: out }));
  });
}

/* 复刻旧 server.js 的静态行为：
 * - HTML 原样输出（不替换 ?v=），且不带 Cache-Control
 * - js/css 仍是 public, max-age=604800
 * - app.js 还原成有 Bug 的旧写法（算不出哈希时误报校验失败）
 */
function startLegacyStub(port) {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    if (rel === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ipv6: true, authEnabled: true }));
      return;
    }
    if (rel === "/api/login") {
      res.writeHead(200, { "Set-Cookie": "navi_session=stub; Path=/", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const fp = path.join(ROOT, "public", rel);
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      const ext = path.extname(fp).toLowerCase();
      const h = { "Content-Type": MIME[ext] || "application/octet-stream" };
      if (!/\.(html|json)$/i.test(ext)) h["Cache-Control"] = "public, max-age=604800";
      if (rel === "/js/app.js") {
        const stale = buf.toString("utf-8").replace(
          /if\s*\(\s*!expect\s*\)\s*return\s+null\s*;/,
          'if (!expect) return "文件完整性校验失败（数据可能被篡改或损坏）";'
        );
        res.writeHead(200, h);
        res.end(Buffer.from(stale, "utf-8"));
        return;
      }
      res.writeHead(200, h);
      res.end(buf);
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

(async () => {
  const PORT_NEW = 8641;
  const PORT_OLD = 8642;
  const tmp = mktmp();
  let child = null;
  let stub = null;

  try {
    child = spawn(NODE, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT_NEW),
        NAVI_CONFIG_PATH: path.join(tmp, "config.json"),
        NAVI_UPLOAD_DIR: path.join(tmp, "uploads"),
        NAVI_PASSWORD: PASSWORD
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", (d) => process.stderr.write("[isolated] " + d));
    await waitUp("http://127.0.0.1:" + PORT_NEW + "/api/health");

    /* ---------- 正向：当前代码应判为新 ---------- */
    section("正向：当前 server.js → 应判为「新代码」");
    const a = await runProbe(["http://127.0.0.1:" + PORT_NEW, PASSWORD]);
    if (a.code === 0) ok("退出码 0"); else bad("退出码 0", "实际 " + a.code + "\n" + a.out);
    if (/\u2705 .*HTML 响应头不参与强缓存/.test(a.out)) ok("识别出 HTML 不参与强缓存");
    else bad("识别出 HTML 不参与强缓存");
    if (/\u2705 .*版本号由服务端自动生成/.test(a.out)) ok("识别出服务端自动版本号");
    else bad("识别出服务端自动版本号");
    if (/\u2705 .*含导入校验修复标记/.test(a.out)) ok("识别出 app.js 含修复标记");
    else bad("识别出 app.js 含修复标记");
    if (/\u2705 .*登录成功/.test(a.out)) ok("能带密码登录并取到首页");
    else bad("能带密码登录并取到首页");
    if (/结论：部署的是最新代码/.test(a.out)) ok("结论行正确");
    else bad("结论行正确");

    /* ---------- 反向：旧行为桩服务应判为旧 ---------- */
    section("反向：复刻旧行为的桩服务 → 应判为「旧代码」");
    stub = await startLegacyStub(PORT_OLD);
    const b = await runProbe(["http://127.0.0.1:" + PORT_OLD, PASSWORD]);
    if (b.code === 1) ok("退出码 1"); else bad("退出码 1", "实际 " + b.code);
    if (/\u274c HTML 仍被强缓存/.test(b.out)) ok("报出 HTML 缓存策略未更新");
    else bad("报出 HTML 缓存策略未更新");
    if (/\u274c 版本号仍是硬编码字面量/.test(b.out)) ok("报出版本号未自动改写");
    else bad("报出版本号未自动改写");
    if (/\u274c 下发值 = 本地 index.html 的字面量/.test(b.out)) ok("报出「下发值 = 字面量」这一决定性证据");
    else bad("报出「下发值 = 字面量」这一决定性证据");
    if (/\u274c 不含导入校验修复标记/.test(b.out)) ok("报出 app.js 仍是旧版");
    else bad("报出 app.js 仍是旧版");
    if (/docker build -t navi:latest/.test(b.out) && /--force-recreate/.test(b.out)) ok("给出可执行的处置指引");
    else bad("给出可执行的处置指引");

    /* ---------- 参数与异常 ---------- */
    section("参数与异常处理");
    const c = await runProbe([]);
    if (c.code === 2 && /用法/.test(c.out)) ok("缺 URL 时输出用法并退出码 2");
    else bad("缺 URL 时输出用法并退出码 2", "exit=" + c.code);

    const d = await runProbe(["http://127.0.0.1:1", PASSWORD]);
    if (d.code === 2 && /检查中断/.test(d.out)) ok("端口不通时明确报错（不静默通过）");
    else bad("端口不通时明确报错（不静默通过）", "exit=" + d.code);

    const e = await runProbe(["http://127.0.0.1:" + PORT_NEW, "错误密码"]);
    // 密码错属于「检查无法完成」，退出码 2（区别于「检查完成且判定为旧代码」的 1）
    if (e.code === 2 && /登录失败/.test(e.out)) ok("密码错误时明确报错（退出码 2，不误判为新代码）");
    else bad("密码错误时明确报错（退出码 2）", "exit=" + e.code + " " + (e.out.match(/\u274c[^\n]*/) || [""])[0]);

    // 本轮修复：认证不通过时不再「整体中断」，仍用公开的 /login.html 给 server.js 定性
    if (/\u2705 server\.js 已是新版（凭 \/login\.html 的响应头）/.test(e.out)) ok("密码错误时仍能降级定性 server.js（不再整体中断）");
    else bad("密码错误时仍能降级定性 server.js", (e.out.match(/== 2\.[\s\S]{0,300}/) || [""])[0]);
    if (/\u23ed\ufe0f  .*取不到 \/js\/app\.js/.test(e.out)) ok("明确标注 app.js 这一项被跳过（不假装通过）");
    else bad("明确标注 app.js 这一项被跳过");
    if (/结论（部分）/.test(e.out) && /NAVI_PASSWORD=你的密码/.test(e.out)) ok("给出「部分判定」结论 + 补全办法");
    else bad("给出「部分判定」结论 + 补全办法");
    if (/wc -c \/app\/server\.js \/app\/discovery\.js \/app\/public\/js\/app\.js/.test(e.out)) ok("给出不会折行的容器内 wc -c 比对命令");
    else bad("给出不会折行的容器内 wc -c 比对命令");
    {
      const localApp = fs.statSync(path.join(ROOT, "public", "js", "app.js")).size;
      const localSrv = fs.statSync(path.join(ROOT, "server.js")).size;
      if (new RegExp("server\\.js\\s+" + localSrv).test(e.out) && new RegExp("public/js/app\\.js\\s+" + localApp).test(e.out)) {
        ok("列出本地源码字节数供逐一比对", localSrv + " / " + localApp);
      } else bad("列出本地源码字节数供逐一比对");
    }

    // 完全不给密码（含清空环境变量）：同样应降级而不是崩
    const f = await runProbe(["http://127.0.0.1:" + PORT_NEW], { NAVI_PASSWORD: "" });
    if (f.code === 2 && /未提供密码/.test(f.out) && /server\.js 已是新版/.test(f.out)) {
      ok("未提供密码时降级判定（退出码 2，不误判为通过）");
    } else bad("未提供密码时降级判定", "exit=" + f.code + "\n" + f.out);

    // 密码也可来自环境变量
    const g = await runProbe(["http://127.0.0.1:" + PORT_NEW], { NAVI_PASSWORD: PASSWORD });
    if (g.code === 0 && /结论：部署的是最新代码/.test(g.out)) ok("密码可由 NAVI_PASSWORD 环境变量提供");
    else bad("密码可由 NAVI_PASSWORD 环境变量提供", "exit=" + g.code);
  } catch (err) {
    bad("测试执行异常", err && err.message ? err.message : String(err));
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
    if (stub) { try { stub.close(); } catch (e) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("");
  console.log("结果：" + pass + " 通过, " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
