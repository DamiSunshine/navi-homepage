/* Navi 导航站 · 备份/导入/Logo 上传 浏览器端 UI 测试（Playwright + 本机 Edge/Chrome 内核）
   用法：先启动无鉴权 server.js（默认 8632，需含新接口），再运行
   NODE_PATH=<managed_workspace>/node_modules node test/ui-backup.test.cjs [baseUrl]
   注意：会临时备份并还原 public/config.json；上传的测试图片在结束后清理 */
"use strict";

const { chromium } = require("playwright");
const { stubExternal, isNotJsError } = require("./lib/hermetic.cjs");
const fs = require("fs");
const path = require("path");
const http = require("http");

const BASE = process.argv[2] || "http://127.0.0.1:8632";
const ROOT = path.join(__dirname, "..", "public");
const CONFIG = path.join(ROOT, "config.json");
const UPLOADS = path.join(ROOT, "uploads");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

// 1x1 透明 PNG（合法魔数）
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

(async () => {
  // 备份真实 config 与 uploads 目录内容，结束后还原
  const configBak = fs.readFileSync(CONFIG, "utf-8");
  const beforeUploads = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [];

  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage();
  await stubExternal(page);   // 外部图标 CDN 就地应答，套件不再依赖外网
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && isNotJsError(m.text())) pageErrors.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card", { timeout: 10000 });

    console.log("== 备份 / 导入按钮 ==");
    await page.click("#editToggle");
    check("备份按钮显示", await page.locator("#backupBtn").isVisible());
    check("导入按钮显示", await page.locator("#importBtn").isVisible());

    console.log("== Logo 本地上传 ==");
    await page.locator('[data-act="add-item"]').first().click();
    await page.waitForSelector("#itemModal:not([hidden])", { timeout: 5000 });
    check("Logo 上传块显示", await page.locator(".logo-box").isVisible());

    await page.setInputFiles("#logoFile", { name: "test.png", mimeType: "image/png", buffer: PNG_1x1 });
    await page.waitForSelector("#logoPreview:not([hidden])", { timeout: 8000 });
    check("Logo 上传后预览显示", await page.locator("#logoPreview").isVisible());
    const logoVal = await page.locator("#logoInput").inputValue();
    check("logoInput 已写入 /uploads/ 路径", /^\/uploads\//.test(logoVal), logoVal);
    const status = await page.locator("#logoStatus").textContent();
    check("上传状态提示成功", /上传成功/.test(status || ""), status);

    console.log("== 备份接口连通 ==");
    const backupStatus = await page.evaluate(() => fetch("/api/backup").then((r) => r.status));
    check("备份接口返回 200", backupStatus === 200, String(backupStatus));
    const zipStatus = await page.evaluate(() => fetch("/api/backup?format=zip").then((r) => r.status));
    check("zip 备份接口返回 200", zipStatus === 200, String(zipStatus));

    /* ---------- 备份格式选择弹窗（完整 zip / 仅配置 json） ---------- */
    console.log("== 备份格式选择弹窗 ==");
    // 先关掉上一步为测 Logo 上传而打开的「添加导航项」弹窗，否则它的遮罩会挡住保存栏按钮
    await page.click('#itemModal [data-close="itemModal"]');
    await page.waitForTimeout(200);
    check("关闭编辑弹窗后遮罩已移除", await page.locator("#itemModal").isHidden());
    await page.click("#backupBtn");
    await page.waitForSelector("#backupModal:not([hidden])", { timeout: 5000 });
    check("点击「备份」打开格式选择弹窗", await page.locator("#backupModal").isVisible());
    check("弹窗含「完整备份 .zip」选项", await page.locator("#backupZipOpt").isVisible());
    check("弹窗含「仅配置 .json」选项", await page.locator("#backupJsonOpt").isVisible());
    const zipOptText = (await page.locator("#backupZipOpt").textContent()) || "";
    const jsonOptText = (await page.locator("#backupJsonOpt").textContent()) || "";
    check("完整备份选项明确写了「含图片」", /图片/.test(zipOptText), zipOptText.trim());
    check("仅配置选项明确写了「不含图片」", /不含图片/.test(jsonOptText), jsonOptText.trim());
    check("弹窗点遮罩以外的取消按钮可关闭",
      await (async () => {
        await page.click('[data-close="backupModal"]');
        await page.waitForTimeout(200);
        return !(await page.locator("#backupModal").isVisible());
      })());

    // 选择「完整备份」应真的触发 .zip 下载（验证选项与后端接口确实连通）
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      (async () => { await page.click("#backupBtn"); await page.waitForSelector("#backupModal:not([hidden])"); await page.click("#backupZipOpt"); })()
    ]);
    check("选择完整备份触发下载且文件名为 .zip",
      /\.zip$/.test(dl.suggestedFilename() || ""), dl.suggestedFilename());
    check("下载文件名以 navi-backup- 开头",
      /^navi-backup-/.test(dl.suggestedFilename() || ""), dl.suggestedFilename());
    // 选择「仅配置」应触发 .json 下载
    const [dl2] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      (async () => { await page.click("#backupBtn"); await page.waitForSelector("#backupModal:not([hidden])"); await page.click("#backupJsonOpt"); })()
    ]);
    check("选择仅配置触发下载且文件名为 .json",
      /\.json$/.test(dl2.suggestedFilename() || ""), dl2.suggestedFilename());
    await page.waitForTimeout(300);

    /* ---------- 导出 → 导入 往返，以及「非安全上下文」回归 ----------
       背景（真实故障）：crypto.subtle 只在安全上下文可用。用户通过
       http://10.10.10.18:18880（局域网明文 HTTP）访问时浏览器不暴露它，
       早期实现把「本地算不出哈希」当成「校验不通过」，于是用户刚导出的备份
       自己都导不回来。夹具用 addInitScript 抹掉 crypto.subtle 来复现该环境。 */
    console.log("== 导出 → 导入 往返 ==");

    async function runImport(pg, file, accept) {
      const seen = [];
      const handler = async (d) => {
        seen.push(d.type() + ": " + d.message().split("\n")[0]);
        if (accept) await d.accept(); else await d.dismiss();
      };
      pg.on("dialog", handler);
      await pg.setInputFiles("#importFile", file);
      await pg.waitForTimeout(1500);
      pg.off("dialog", handler);
      return seen;
    }

    const bkp = await page.evaluate(() => fetch("/api/backup").then((r) => r.json()));
    check(
      "导出包含 format / version / checksum",
      bkp && bkp.format === "navi-backup" && typeof bkp.version === "number" && /^[0-9a-f]{64}$/.test(bkp.checksum || ""),
      JSON.stringify(bkp && Object.keys(bkp))
    );

    const validFile = path.join(__dirname, "_bk-valid.json");
    const tamperedFile = path.join(__dirname, "_bk-tampered.json");
    fs.writeFileSync(validFile, JSON.stringify(bkp), "utf-8");
    const tampered = JSON.parse(JSON.stringify(bkp));
    tampered.config.groups = (tampered.config.groups || []).concat([{ name: "被篡改的分组", items: [] }]);
    fs.writeFileSync(tamperedFile, JSON.stringify(tampered), "utf-8");

    // 1) 安全上下文（localhost）：本地预检可用
    const dSecureOk = await runImport(page, validFile, false);
    check("安全上下文：自导出备份不被误判为损坏", !dSecureOk.join("|").includes("完整性校验失败"), dSecureOk.join(" | "));
    check("安全上下文：自导出备份可进入覆盖确认", dSecureOk.some((t) => t.startsWith("confirm")), dSecureOk.join(" | "));

    const dSecureBad = await runImport(page, tamperedFile, false);
    check("安全上下文：被篡改备份仍被拦截", dSecureBad.join("|").includes("完整性校验失败"), dSecureBad.join(" | "));

    // 2) 非安全上下文：模拟 http:// + 局域网 IP（crypto.subtle 不可用）
    const page2 = await browser.newPage();
    await stubExternal(page2);
    await page2.addInitScript(() => {
      try { Object.defineProperty(window.crypto, "subtle", { configurable: true, get: () => undefined }); } catch (e) {}
    });
    await page2.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page2.waitForSelector(".card", { timeout: 10000 });
    check(
      "非安全上下文已模拟（crypto.subtle 不可用）",
      await page2.evaluate(() => !(window.crypto && window.crypto.subtle))
    );

    const dInsecureOk = await runImport(page2, validFile, false);
    check("非安全上下文：自导出备份不再误报校验失败", !dInsecureOk.join("|").includes("完整性校验失败"), dInsecureOk.join(" | "));
    check("非安全上下文：自导出备份可进入覆盖确认", dInsecureOk.some((t) => t.startsWith("confirm")), dInsecureOk.join(" | "));

    // 关键安全属性：本地预检被跳过后，后端必须仍然拦截篡改文件
    const dInsecureBad = await runImport(page2, tamperedFile, true);
    check(
      "非安全上下文：被篡改备份由后端拦截（安全属性未削弱）",
      dInsecureBad.join("|").includes("完整性校验失败"),
      dInsecureBad.join(" | ")
    );

    /* ---------- ZIP 完整备份（含图片）导入往返 ---------- */
    console.log("== ZIP 完整备份 导入 ==");
    const zipBuf = await new Promise((resolve, reject) => {
      http.get(BASE + "/api/backup?format=zip", (res) => {
        const cs = []; res.on("data", (d) => cs.push(d));
        res.on("end", () => resolve(Buffer.concat(cs)));
      }).on("error", reject);
    });
    check("ZIP 备份体是合法的 PK 文件头",
      zipBuf.length > 22 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b, zipBuf.length + " 字节");
    const zipFile = path.join(__dirname, "_bk-full.zip");
    fs.writeFileSync(zipFile, zipBuf);

    const dZip = await runImport(page, zipFile, false);
    check("导入 .zip 备份进入覆盖确认（被识别为 ZIP 而非误报 JSON 错误）",
      dZip.some((t) => t.startsWith("confirm")), dZip.join(" | "));
    check("导入 .zip 未出现「不是合法的 JSON」误报",
      !dZip.join("|").includes("不是合法的 JSON"), dZip.join(" | "));
    check("覆盖确认中说明了备份包体积", /MB/.test(dZip.join("|")), dZip.join(" | "));

    // 损坏的 zip：应以明确错误提示收尾，而不是静默或误判为成功
    const brokenFile = path.join(__dirname, "_bk-broken.zip");
    const brokenBuf = Buffer.from(zipBuf);
    brokenBuf.writeUInt32LE(0, brokenBuf.length - 22);
    fs.writeFileSync(brokenFile, brokenBuf);
    const dBroken = await runImport(page, brokenFile, true);
    check("导入损坏的 .zip：提示解析失败",
      dBroken.join("|").includes("解析失败"), dBroken.join(" | "));

    console.log("== 页面错误 ==");
    check("无 JS 运行时错误", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser.close();
    // 清理本次上传的图片，还原 config
    if (fs.existsSync(UPLOADS)) {
      fs.readdirSync(UPLOADS).forEach((f) => {
        if (!beforeUploads.includes(f)) {
          try { fs.unlinkSync(path.join(UPLOADS, f)); } catch (e) {}
        }
      });
    }
    fs.writeFileSync(CONFIG, configBak, "utf-8");
    // 清理本次导入用例的临时备份文件
    ["_bk-valid.json", "_bk-tampered.json", "_bk-full.zip", "_bk-broken.zip"].forEach((f) => {
      try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) {}
    });
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
