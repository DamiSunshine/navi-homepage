/* 将 docs 下的 HTML 指南打印为 PDF
   用法：
     node test/make-pdf.cjs                         # 生成下方 DOCS 列表中的全部 PDF
     node test/make-pdf.cjs docker-guide.html       # 只生成指定 HTML 对应的 PDF
   说明：改用系统 Edge/Chrome 内核，无需下载 Chromium；需先设置 NODE_PATH 指向 playwright 所在目录。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const DOCS_DIR = path.join(__dirname, "..", "docs");

// [源 HTML, 输出 PDF]；输出名留空则按 HTML 同名生成
const DOCS = [
  ["fnos-deploy-guide.html", "Navi-飞牛fnOS部署指南.pdf"],
  ["docker-guide.html", "Navi-Docker部署指南.pdf"],
];

(async () => {
  const only = process.argv[2];
  const targets = only ? DOCS.filter(([h]) => h === only) : DOCS;
  if (!targets.length) {
    console.error("未匹配到目标 HTML：" + only + "（可选：" + DOCS.map(([h]) => h).join(", ") + "）");
    process.exit(1);
  }

  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); }
  catch (e) { browser = await chromium.launch({ channel: "chrome" }); }

  for (const [htmlName, pdfName] of targets) {
    const htmlPath = path.join(DOCS_DIR, htmlName);
    if (!fs.existsSync(htmlPath)) { console.error("跳过（不存在）：" + htmlName); continue; }
    const page = await browser.newPage();
    await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle" });
    await page.emulateMedia({ media: "print" });
    const out = path.join(DOCS_DIR, pdfName);
    // 先写到 .tmp，再原子替换：目标 PDF 若正被阅读器打开（Windows 会锁文件），
    // 直接写会抛 EBUSY 并把已渲染的内容丢掉；这样至少能给出明确提示而不留半成品。
    const tmp = out + ".tmp";
    await page.pdf({ path: tmp, format: "A4", printBackground: true });
    await page.close();
    try {
      fs.renameSync(tmp, out);
    } catch (e) {
      // 目标被占用：把 .tmp 保留成可用的新版，提示用户关闭阅读器后重跑
      const alt = out.replace(/\.pdf$/i, "-new.pdf");
      try { fs.rmSync(alt, { force: true }); fs.renameSync(tmp, alt); } catch (_) { /* 保底：留在 .tmp */ }
      console.error("警告：" + pdfName + " 正被其它程序占用（" + (e.code || e.message) + "）。");
      console.error("      新版已另存为：" + path.basename(alt) + "，关闭阅读器后重跑本脚本即可覆盖原文件。");
      continue;
    }
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log("PDF 生成完成：" + pdfName + "（" + kb + " KB）");
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
