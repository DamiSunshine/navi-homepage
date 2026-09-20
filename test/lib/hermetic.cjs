/*
 * 让 UI 测试**真正自包含**：把页面发往外部网络的请求就地应答掉。
 *
 * 为什么需要它：
 *   导航卡片与在线图标库里的图标指向公共 CDN（Dashboard Icons / selfh.st / Iconify）。
 *   几个 UI 套件都带一条「全程无 JS 错误」断言，而 Chromium 在图片加载失败时会往 console
 *   发一条 error：`Failed to load resource: net::ERR_CONNECTION_CLOSED`。
 *   结果是 —— **外部 CDN 抖一下，看起来就像被测代码有 Bug**。
 *   这不是假设：一次全量回归里 ui-discover 就因此偶发 1 失败，单独重跑立刻 36/36 通过。
 *
 *   断言本身没错（它要抓的是 JS 异常），错的是套件声称"自包含"却依赖了外网。
 *   所以这里两件事一起做：
 *     ① `stubExternal(page)` —— 公网请求就地应答成一张 1×1 PNG / 空响应，从源头消除噪声；
 *     ② `isNotJsError(text)` —— 兜底过滤"资源加载失败"类消息。它不是 JS 错误，是网络事实。
 *
 *   ⚠️ ① 只替换**响应**，不替换 URL —— 所以「图标指向的 CDN 地址是否正确」这类断言依然有效，
 *      被削弱的只是"这张图真的从公网下载成功了"，而那个能力本来就不该由单元测试来保证。
 *
 * ⚠️ 作用域只限**公网域名**。IP 字面量（含 127.0.0.1）与 localhost 一律放行，
 *    因为内网地址正是被测功能的一部分：
 *      · 内网可达性探测（P0-3）要真实地「连不上」才能得到 ok=false；
 *      · 若把探测请求也答成 200，全部卡片都会被误判为「内网可达」，
 *        测出来的是一条完全相反的结论 —— 比测试失败更糟。
 *
 * 用法：
 *   const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");
 *   ...
 *   const page = await browser.newPage();
 *   await stubExternal(page);                                  // 必须在 goto 之前
 *   page.on("console", (m) => {
 *     if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text());
 *   });
 */
"use strict";

// 1×1 透明 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// 本机 / 私网 / 保留地址：放行给真实网络栈（内网探测依赖真实的连通性结果）
function isLocalOrPrivate(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  // 域名形态（含点、非纯数字）才可能是公网；无点的单标签名按内网处理
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;   // 任意 IPv4 字面量一律放行
  if (h.indexOf(":") >= 0) return true;                  // IPv6 字面量
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home")) return true;
  if (h.indexOf(".") < 0) return true;                   // 单标签主机名 = 内网
  return false;                                          // 其余（example.com / cdn…）按公网处理
}

/**
 * 拦截页面发出的请求：
 *   · 本机 / IP 字面量 / 内网主机名 → 放行（内网探测必须拿到真实结论）
 *   · 公网图片 → 就地返回一张 1×1 PNG
 *   · 其它公网请求 → 就地返回空响应（避免 abort 又产生一条 "Failed to load resource"）
 * 必须在 page.goto() 之前调用。
 */
async function stubExternal(page) {
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = req.url();
    if (/^(data|blob|file):/i.test(url)) return route.continue();
    let host = "";
    try { host = new URL(url).hostname; } catch (e) { return route.continue(); }
    if (isLocalOrPrivate(host)) return route.continue();
    if (req.resourceType() === "image") {
      return route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
    }
    return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });
}

// 资源加载失败 ≠ JS 错误。这类消息一律不计入「无 JS 错误」断言。
const RESOURCE_NOISE =
  /Failed to load resource|net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i;

function isNotJsError(text) {
  return !RESOURCE_NOISE.test(String(text));
}

module.exports = { stubExternal, isNotJsError, TINY_PNG, isLocalOrPrivate };
