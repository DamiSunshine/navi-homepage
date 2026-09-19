#!/usr/bin/env node
/**
 * Navi · GitHub 连通性诊断（零依赖）
 *
 * 用途：`git push` 失败时，先分清到底是「凭据问题」还是「网络问题」，
 * 别在令牌上反复折腾 —— 本机实测过一次：令牌完全正常，是 github.com 主站连不通。
 *
 * 背景：部分网络环境下 `github.com:443` 被拦，但
 *       `api.github.com` / `codeload.github.com` / `ssh.github.com` 都正常。
 *       此时 HTTPS 推送必然失败，而走 SSH over 443 可用
 *       （`ssh.github.com:443` 是 GitHub 官方为这类网络提供的备用入口）。
 *
 * 用法：
 *   node scripts/check-github-net.cjs
 *
 * 退出码：0 = github.com:443 可达（HTTPS + 令牌可用）
 *         1 = 主站不通、备用入口通（改用 SSH：GH_TRANSPORT=ssh）
 *         2 = 全都不通（检查本机网络、代理或防火墙）
 */

"use strict";

const https = require("https");
const net = require("net");
const dns = require("dns");

const PRIMARY = "github.com";
const ALTERNATES = [
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "ssh.github.com",
];

function tcp(host, port, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let settled = false;
    const fin = (r) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve(r);
    };
    sock.setTimeout(timeout);
    sock.on("connect", () => fin({ ok: true, ms: Date.now() - t0 }));
    sock.on("timeout", () => fin({ ok: false, msg: "超时", ms: Date.now() - t0 }));
    sock.on("error", (e) => fin({ ok: false, msg: e.code || e.message, ms: Date.now() - t0 }));
  });
}

function httpGet(host, path, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let req;
    try {
      req = https.request(
        { host, port: 443, path, method: "GET", timeout, headers: { "User-Agent": "navi-net-doctor" } },
        (res) => { res.resume(); resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0 }); }
      );
    } catch (e) {
      resolve({ ok: false, msg: String(e.message), ms: Date.now() - t0 });
      return;
    }
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, msg: "超时", ms: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ ok: false, msg: (e.code || "") + " " + e.message, ms: Date.now() - t0 }));
    req.end();
  });
}

function lookup(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (e, a) => {
      resolve(e ? "解析失败：" + e.message : a.map((x) => x.address).join(", "));
    });
  });
}

(async () => {
  console.log("Navi · GitHub 连通性诊断");
  console.log("");

  console.log("== 1. DNS 解析 ==");
  for (const h of [PRIMARY].concat(ALTERNATES)) {
    console.log("   " + h.padEnd(34) + " → " + (await lookup(h)));
  }

  console.log("");
  console.log("== 2. TCP 443 可达性 ==");
  const reach = {};
  for (const h of [PRIMARY].concat(ALTERNATES)) {
    const r = await tcp(h, 443, 8000);
    reach[h] = r.ok;
    console.log("   " + h.padEnd(34) + " → " + (r.ok ? "✅ 连通 " + r.ms + "ms" : "❌ " + r.msg + " " + r.ms + "ms"));
  }

  console.log("");
  console.log("== 3. HTTPS 请求 ==");
  for (const h of [PRIMARY, "api.github.com"]) {
    const r = await httpGet(h, "/", 10000);
    console.log("   https://" + h.padEnd(26) + " → " + (r.ok ? "✅ HTTP " + r.status + " " + r.ms + "ms" : "❌ " + r.msg));
  }

  console.log("");
  console.log("---------------- 结论 ----------------");
  const anyAlt = ALTERNATES.some((h) => reach[h]);

  if (reach[PRIMARY]) {
    console.log("✅ github.com 主站可达：HTTPS 传输（访问令牌）可正常使用。");
    console.log("   推送：node scripts/publish-github.cjs");
    console.log("--------------------------------------");
    process.exit(0);
  }

  if (anyAlt) {
    console.log("⚠️  github.com 主站不可达，但备用入口正常。");
    console.log("   影响：HTTPS 的 git clone / fetch / push 全部失败（它们都走 github.com）。");
    console.log("   API（api.github.com）不受影响，所以「建仓」能成功而「推送」失败 —— 容易误判成令牌问题。");
    console.log("");
    console.log("   解法（二选一）：");
    console.log("     A. 走 SSH over 443（推荐，一劳永逸）");
    console.log("        1) 生成密钥：ssh-keygen -t ed25519 -f ~/.ssh/navi_ed25519 -N \"\" -C navi");
    console.log("        2) ~/.ssh/config 写入：");
    console.log("             Host github.com");
    console.log("               HostName ssh.github.com");
    console.log("               Port 443");
    console.log("               User git");
    console.log("               IdentityFile ~/.ssh/navi_ed25519");
    console.log("               IdentitiesOnly yes");
    console.log("               StrictHostKeyChecking accept-new");
    console.log("        3) 把 ~/.ssh/navi_ed25519.pub 的内容加到 https://github.com/settings/ssh/new");
    console.log("        4) 改远程并推送：");
    console.log("             git remote set-url origin git@github.com:<用户名>/<仓库>.git");
    console.log("             git push -u origin HEAD:main");
    console.log("     B. 让本机能访问 github.com（代理 / 换网络），然后照旧用 HTTPS + 令牌。");
    console.log("--------------------------------------");
    process.exit(1);
  }

  console.log("❌ 全部不可达：先确认本机能否上网，再检查是否需要配置代理。");
  console.log("--------------------------------------");
  process.exit(2);
})();
