#!/usr/bin/env node
/*
 * check-deploy.cjs —— 「部署的到底是不是新代码」一条命令判定
 *
 * 背景：navi 的前端 js/css 走 7 天强缓存（缓存键是含 ?v= 的 URL），而 server.js 现在
 * 会在下发 HTML 时按前端文件 mtime 自动改写 ?v=。于是「服务端是新代码」这件事有
 * 可观测的外部特征：
 *   - 旧 server.js：HTML 响应头【没有】Cache-Control（只有 js/css/json 设了 max-age）
 *   - 新 server.js：HTML 响应头 Cache-Control: no-cache，且 ?v= 是 10 位数字（mtime 推导）
 *   - 首页 / 先要登录，但 /login.html 是公开的，所以【即使没密码】也能对 server.js 定性
 *
 * 用法：
 *   node scripts/check-deploy.cjs http://10.10.10.18:18880
 *   node scripts/check-deploy.cjs http://10.10.10.18:18880 你的密码
 *   NAVI_PASSWORD=你的密码 node scripts/check-deploy.cjs http://10.10.10.18:18880
 *
 * 退出码：0 = 关键项全部通过（线上是新代码）
 *         1 = 有失败项（容器里跑的还是旧代码）
 *         2 = 无法完成完整判定（服务器不可达 / 认证信息不对 / 只完成了降级判定）
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const PASSWORD = process.argv[3] || process.env.NAVI_PASSWORD || "";

if (!BASE || !/^https?:\/\//i.test(BASE)) {
  console.error("用法：node scripts/check-deploy.cjs <http://NAS的IP:端口> [密码]");
  console.error("      也可用环境变量：NAVI_PASSWORD=你的密码 node scripts/check-deploy.cjs <地址>");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const LOCAL_INDEX = path.join(ROOT, "public", "index.html");

// 本地源码字节数（给用户做容器内比对用）
const LOCAL_SIZES = {};
for (const rel of ["server.js", "discovery.js", "public/js/app.js", "public/index.html"]) {
  try { LOCAL_SIZES[rel] = fs.statSync(path.join(ROOT, rel)).size; } catch (e) { LOCAL_SIZES[rel] = null; }
}

let pass = 0;
let fail = 0;
let skipped = 0;
const warns = [];

function ok(msg, extra) {
  pass++;
  console.log("  \u2705 " + msg + (extra ? "  \u2192 " + extra : ""));
}
function bad(msg, extra) {
  fail++;
  console.log("  \u274c " + msg + (extra ? "  \u2192 " + extra : ""));
}
function warn(msg) {
  warns.push(msg);
  console.log("  \u26a0\ufe0f  " + msg);
}
function skip(msg) {
  skipped++;
  console.log("  \u23ed\ufe0f  " + msg);
}

function request(url, opts) {
  opts = opts || {};
  const http = url.indexOf("https:") === 0 ? require("https") : require("http");
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      timeout: opts.timeout || 10000
    }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
    });
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* HTML 响应头能否证明是新 server.js：旧版对 .html 不设 Cache-Control */
function verdictHtml(cc) {
  const v = String(cc || "");
  if (!v) return { new: false, why: "响应头里根本没有 Cache-Control（旧 server.js 对 .html 不设缓存头）" };
  if (/no-cache|no-store|max-age=0/.test(v)) return { new: true, why: "Cache-Control: " + v };
  if (/max-age=\d{4,}/.test(v)) return { new: false, why: "Cache-Control: " + v + "（HTML 被强缓存，旧行为）" };
  return { new: null, why: "Cache-Control: " + v };
}

const state = { cookie: "", authenticated: false, serverJsIsNew: null };

function main() {
  console.log("");
  console.log("检查目标：" + BASE);
  console.log("");

  return Promise.resolve()
    // ---- 1. 连通性 ----
    .then(() => {
      console.log("== 1. 连通性与认证 ==");
      return request(BASE + "/api/health");
    })
    .then((r) => {
      if (r.status !== 200) throw new Error("/api/health 返回 " + r.status + "（服务没起来？端口/路径对不对？）");
      let info = {};
      try { info = JSON.parse(r.body); } catch (e) {}
      ok("/api/health 可达", "authEnabled=" + info.authEnabled + "  ipv6=" + info.ipv6);
      if (!info.authEnabled) { state.authenticated = true; return null; }

      if (!PASSWORD) {
        warn("该实例启用了密码保护，但未提供密码 \u2192 跳过登录（仍会做免登录的降级判定）");
        return null;
      }
      return request(BASE + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: PASSWORD })
      }).then((lr) => {
        if (lr.status !== 200) {
          warn("登录失败（HTTP " + lr.status + "）\u2192 密码不对？"
            + "注意这是站点密码（NAVI_PASSWORD），不是 NAS 登录密码；"
            + "若在 GUI 环境变量里填的，留意有没有多打空格/换行");
          return null;
        }
        const sc = lr.headers["set-cookie"];
        if (!sc || !sc.length) { warn("登录成功但没拿到会话 Cookie"); return null; }
        state.cookie = sc[0].split(";")[0];
        state.authenticated = true;
        ok("登录成功", state.cookie.split("=")[0] + "=\u2026");
        return null;
      });
    })

    // ---- 2. 首页 HTML：缓存策略 + 资源版本号 ----
    .then(() => {
      console.log("");
      console.log("== 2. 首页 HTML 的缓存策略与资源版本号 ==");
      return request(BASE + "/", { headers: state.cookie ? { Cookie: state.cookie } : {} });
    })
    .then((r) => {
      if (r.status === 200) {
        const cc = String(r.headers["cache-control"] || "");
        const v1 = verdictHtml(cc);
        state.serverJsIsNew = v1.new;
        if (v1.new === true) ok("HTML 响应头不参与强缓存", v1.why);
        else if (v1.new === false) bad("HTML 仍被强缓存", v1.why + " —— 容器里跑的还是旧 server.js");
        else warn("HTML 缓存头无法定性：" + v1.why);

        // ?v= 必须是服务端自动推导的 10 位数字
        const m = r.body.match(/js\/app\.js\?v=([^"']+)/);
        if (!m) {
          warn("首页 HTML 里没找到 app.js 的 ?v= 参数，跳过版本号判定");
        } else {
          const served = m[1];
          console.log("  服务端下发的版本号：" + served);
          if (/^\d{10}$/.test(served)) {
            ok("版本号由服务端自动生成", "10 位数字（= 前端文件最新修改时间）");
          } else if (/^\d{6,}$/.test(served)) {
            ok("版本号是数字形式", served);
          } else {
            bad("版本号仍是硬编码字面量", served + " —— 容器里跑的还是旧 server.js");
          }
          try {
            const lm = fs.readFileSync(LOCAL_INDEX, "utf-8").match(/js\/app\.js\?v=([^"']+)/);
            if (lm && lm[1] === served) {
              bad("下发值 = 本地 index.html 的字面量", served + " —— 说明服务端没做自动改写，是旧 server.js");
            } else if (lm) {
              ok("下发值已脱离本地字面量", "本地 " + lm[1] + " / 线上 " + served);
            }
          } catch (e) {
            warn("读不到本地 public/index.html，跳过字面量对比");
          }
        }

        // 正文与本地源码比对（仅版本号不同视为一致）
        try {
          const local = fs.readFileSync(LOCAL_INDEX, "utf-8");
          const norm = (s) => s.replace(/js\/app\.js\?v=[^"']+/g, "js/app.js?v=X")
            .replace(/css\/style\.css\?v=[^"']+/g, "css/style.css?v=X").replace(/\s+/g, " ").trim();
          if (norm(local) === norm(r.body)) ok("首页内容与本地源码一致", "仅版本号不同");
          else warn("首页内容与本地源码有差异（你改过本地文件，或 NAS 上还是旧 index.html）");
        } catch (e) {}
        return null;
      }

      // 拿不到首页 → 降级：用公开的 /login.html 给 server.js 定性
      console.log("  \u2139\ufe0f  GET / 返回 " + r.status + "，首页判不了，改用公开的 /login.html 降级判定");
      return request(BASE + "/login.html").then((lr) => {
        if (lr.status !== 200) {
          skip("/login.html 也取不到（HTTP " + lr.status + "）");
          return null;
        }
        const v = verdictHtml(lr.headers["cache-control"]);
        state.serverJsIsNew = v.new;
        if (v.new === true) ok("server.js 已是新版（凭 /login.html 的响应头）", v.why);
        else if (v.new === false) bad("server.js 仍是旧版", v.why);
        else warn("/login.html 的缓存头无法定性：" + v.why);
        return null;
      });
    })

    // ---- 3. 线上 app.js ----
    .then(() => {
      console.log("");
      console.log("== 3. 线上 app.js 是否含已修复的代码 ==");
      if (!state.authenticated) {
        skip("未登录，取不到 /js/app.js（它受密码保护）—— 想查这步请带上正确的密码");
        return null;
      }
      return request(BASE + "/js/app.js", { headers: { Cookie: state.cookie } }).then((r) => {
        if (r.status !== 200) {
          bad("取不到 /js/app.js", "HTTP " + r.status);
          return null;
        }
        const js = r.body;
        const len = Buffer.byteLength(js, "utf-8");
        console.log("  线上字节数：" + len + "（本地源码：" + LOCAL_SIZES["public/js/app.js"] + "）");

        // 修复：非安全上下文（局域网 http）下算不出哈希时应跳过本地预检，而不是报「校验失败」
        if (/if\s*\(\s*!expect\s*\)\s*return\s+null/.test(js)) {
          ok("含导入校验修复标记", "localDigest 为空时返回 null（跳过预检）");
        } else {
          bad("不含导入校验修复标记", "线上 app.js 还是旧版 \u2192 局域网 http 下导入会误报「完整性校验失败」");
        }
        if (/verifyBackupLocal/.test(js) && /api\/restore/.test(js)) {
          ok("仍然后端权威校验", "/api/restore 路径保留");
        }
        if (LOCAL_SIZES["public/js/app.js"] === len) ok("app.js 与本地源码字节数一致", len + " 字节");
        else warn("app.js 字节数与本地不一致（本地 " + LOCAL_SIZES["public/js/app.js"] + " / 线上 " + len + "）");
        return null;
      });
    })

    // ---- 4. 容器内文件：给一条不会折行的比对命令 ----
    .then(() => {
      console.log("");
      console.log("== 4. 容器内文件（server.js / discovery.js 网页上看不到）==");
      console.log("  在 NAS 上执行下面这条，一次拿到三个文件的字节数（输出很短，不会被终端折行搞乱）：");
      console.log("");
      console.log("    sudo docker exec navi wc -c /app/server.js /app/discovery.js /app/public/js/app.js");
      console.log("");
      console.log("  应当依次等于本地源码的字节数：");
      console.log("    server.js         " + (LOCAL_SIZES["server.js"] || "?"));
      console.log("    discovery.js      " + (LOCAL_SIZES["discovery.js"] || "?"));
      console.log("    public/js/app.js  " + (LOCAL_SIZES["public/js/app.js"] || "?"));
      console.log("");
      console.log("  三个数都对得上 = 源码已同步；有对不上的，把那个文件重新覆盖后重建镜像。");
      return null;
    })

    // ---- 汇总 ----
    .then(() => {
      console.log("");
      console.log("---------------------------------------------");
      console.log("结果：" + pass + " 通过, " + fail + " 失败" + (skipped ? "，跳过 " + skipped + " 项" : ""));
      if (warns.length) console.log("提醒：" + warns.length + " 条（见上方 \u26a0\ufe0f）");

      let code = 0;
      if (fail) {
        code = 1;
        console.log("");
        console.log("结论：容器里跑的不是最新代码。按下面顺序处理：");
        console.log("  1) 把 server.js / discovery.js / public/js/app.js / public/index.html 一起覆盖到 NAS 项目目录");
        console.log("  2) sudo docker build -t navi:latest /vol1/1000/docker/navi");
        console.log("  3) sudo docker compose up -d --force-recreate");
        console.log("  4) 浏览器按一次 Ctrl+F5（仅第一次需要），再跑本脚本");
      } else if (!state.authenticated) {
        code = 2;
        console.log("");
        console.log("结论（部分）：server.js 这一项已定性，但 app.js 没验证。");
        console.log("  想拿到完整判定，用正确密码再跑一次，或改用环境变量：");
        console.log("    NAVI_PASSWORD=你的密码 node scripts/check-deploy.cjs " + BASE);
      } else {
        console.log("");
        console.log("结论：部署的是最新代码 \u2705");
      }
      console.log("---------------------------------------------");
      process.exit(code);
    });
}

main().catch((e) => {
  console.error("");
  console.error("\u274c 检查中断：" + (e && e.message ? e.message : e));
  console.error("   （这表示检查本身没跑起来，不代表线上是旧代码）");
  process.exit(2);
});
