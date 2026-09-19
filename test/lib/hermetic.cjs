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
 *     ① `stubExternal(page)` —— 非本机请求一律就地应答成一张 1×1 PNG，从源头消除噪声；
 *     ② `isNotJsError(text)` —— 兜底过滤"资源加载失败"类消息。它不是 JS 错误，是网络事实。
 *
 *   ⚠️ ① 只替换**响应**，不替换 URL —— 所以「图标指向的 CDN 地址是否正确」这类断言依然有效，
 *      被削弱的只是"这张图真的从公网下载成功了"，而那个能力本来就不该由单元测试来保证。
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

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

/**
 * 拦截页面发出的所有请求：
 *   · 本机（被测实例、伪造 Docker API）→ 放行
 *   · 外部图片 → 就地返回一张 1×1 PNG
 *   · 其它外部请求 → 就地返回空响应（避免 abort 又产生一条 "Failed to load resource"）
 * 必须在 page.goto() 之前调用。
 */
async function stubExternal(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (LOCAL.test(url) || /^(data|blob|file):/i.test(url)) return route.continue();
    if (route.request().resourceType() === "image") {
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

module.exports = { stubExternal, isNotJsError, TINY_PNG };
