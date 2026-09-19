#!/usr/bin/env node
/**
 * Navi · 推送到 GitHub 前的起飞自检
 *
 * 目的：公开仓库一旦推上去，历史里的密钥就再也删不干净了（除非 rewrite 历史）。
 * 所以推之前必须确认「即将进入仓库的东西」里没有任何秘密。
 *
 * 用法：
 *   node scripts/git-preflight.cjs            # 检查仓库内全部被跟踪文件（与是否已 add 无关，任何时候都准）
 *   node scripts/git-preflight.cjs --all      # 兼容参数，现在与默认行为一致（早期版本用 --all 才扫全量）
 *
 * 退出码：0 = 干净可推 / 1 = 发现问题，先解决再推 / 2 = 无法检查（没 init 等）
 *
 * 零依赖。git 可执行文件会自动探测：PATH → WorkBuddy 便携版。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCAN_ALL = process.argv.includes("--all");

/* ---------------- git 可执行文件探测 ---------------- */
function findGit() {
  const candidates = [
    process.env.GIT_BIN,
    "git",
    "C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null;
}

const GIT = findGit();
if (!GIT) {
  console.error("❌ 找不到 git 可执行文件。可设 GIT_BIN=<git.exe 路径> 再跑。");
  process.exit(2);
}

function git(args) {
  return execFileSync(GIT, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/* ---------------- 结果收集 ---------------- */
const problems = [];   // 必须处理，否则禁止推送
const warns = [];      // 建议确认
const pass = [];

function bad(msg) { problems.push(msg); }
function warn(msg) { warns.push(msg); }
function ok(msg) { pass.push(msg); }

/* ---------------- 列出检查范围：索引里的全部文件 ----------------
 * ⚠️ 不能用 git diff --cached —— 它只含「本次新暂存的」文件。
 * 第二次提交时 README / LICENSE / .gitignore 等早已提交，不在暂存区里，
 * 于是「必备文件」检查会把它们全部误报为「缺失」，预检直接卡死。
 * git ls-files 列出索引的全部内容：既含历史提交，也含刚 add 的新文件，两种场景都正确。
 */
let files;
try {
  files = git(["ls-files"]).split(/\r?\n/).filter(Boolean);
} catch (e) {
  console.error("❌ 不是 git 仓库，或 git 命令失败：" + String(e.message).split("\n")[0]);
  console.error("   先在项目根执行：git init -b main && git add -A");
  process.exit(2);
}

if (!files.length) {
  console.error("⚠️  索引里没有任何文件（还没 git add？）。先执行 git add -A 再跑本脚本。");
  process.exit(2);
}

console.log("仓库：" + ROOT);
console.log("检查范围：仓库内被跟踪的全部文件（" + files.length + " 个）");
console.log("");

/* ---------------- 1. 不该被跟踪的路径 ---------------- */
console.log("== 1. 敏感路径是否被跟踪 ==");
const FORBIDDEN = [
  [/^\.env$/, ".env（真实密码）"],
  [/^public\/config\.json$/, "public/config.json（站点数据与内网地址）"],
  [/^preview-launcher\.js$/, "preview-launcher.js（含预览密码哈希）"],
  [/^\.workbuddy\//, ".workbuddy/（工作记录与平台元数据）"],
  [/^\.wbapp_.*\.genie$/, ".wbapp_*.genie（平台应用登记）"],
  [/^share\//, "share/（线上发布包，纯生成物）"],
  [/^docs\/.*-new\.pdf$/, "docs/*-new.pdf（PDF 被占用时的应急产物）"],
  [/^public\/uploads\//, "public/uploads/（本地上传图片）"],
  [/^data\//, "data/（Docker 数据目录）"],
  [/^backups\//, "backups/（备份目录）"],
  [/^node_modules\//, "node_modules/"],
  [/\.tmp$/, "*.tmp（原子写入半成品）"],
];
for (const [re, label] of FORBIDDEN) {
  const hit = files.filter((f) => re.test(f));
  if (hit.length) bad("不该入库却被跟踪：" + label + " → " + hit.slice(0, 3).join(", "));
}
if (!problems.length) ok("未跟踪任何敏感路径（.env / config.json / 上传图片 / 数据目录）");

/* ---------------- 2. 关键文件是否在 ---------------- */
console.log("== 2. 仓库必备文件 ==");
const REQUIRED = [
  ["README.md", "说明文档"],
  [".gitignore", "忽略规则"],
  [".gitattributes", "行尾规则"],
  ["LICENSE", "开源许可证"],
  [".env.example", "环境变量示例"],
  ["Dockerfile", "镜像构建"],
  ["docker-compose.yml", "Compose 配置"],
  ["server.js", "服务端入口"],
];
for (const [f, label] of REQUIRED) {
  if (!files.includes(f)) bad("缺少必备文件：" + f + "（" + label + "）");
}
if (REQUIRED.every(([f]) => files.includes(f))) ok("必备文件齐全（README / LICENSE / .gitignore 等 " + REQUIRED.length + " 项）");

/* ---------------- 3. 内容级密钥扫描 ---------------- */
console.log("== 3. 内容密钥扫描 ==");

/*
 * ⚠️ 本文件会被提交到公开仓库，因此**绝不能内嵌真实密码字面量**。
 * 真实值从下面两个来源动态获取，它们都在 .gitignore 里：
 *   1) .env（本地真实配置，永不入库）
 *   2) 环境变量 PREFLIGHT_SECRETS=A,B,C（逗号分隔，临时补扫）
 */
function loadRealSecrets() {
  const out = new Set();
  try {
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      if (!/(PASSWORD|PASS|SECRET|TOKEN|KEY)/i.test(m[1])) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      // 太短的值扫起来噪声大（如 "1"、"yes"），且不像密码
      if (v && v.length >= 6) out.add(v);
    }
  } catch (e) { /* 没有 .env 就跳过 */ }
  for (const v of (process.env.PREFLIGHT_SECRETS || "").split(",")) {
    const t = v.trim();
    if (t.length >= 6) out.add(t);
  }
  return [...out];
}

const REAL_SECRETS = loadRealSecrets();
console.log("   比对源：.env 中提取到 " + REAL_SECRETS.length +
  " 个真实密钥值（仅在本机内存中使用，不会写入任何文件）");

/*
 * 判定分两层，刻意把「一定会拦」和「看一眼就行」分开 ——
 * 否则把 `${NAVI_PASSWORD:?}`、`NAVI_PASSWORD: PASSWORD`、`CHANGE_ME`
 * 这类正常写法也判成泄露，自检会变成"狼来了"，反而没人看。
 */

/* A. 高置信度特征：命中即致命，必须处理才能推 */
const FATAL_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥内容"],
  [/\bghp_[A-Za-z0-9]{20,}/, "GitHub Personal Access Token (ghp_)"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained PAT"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS Access Key ID"],
  [/\bsk-[A-Za-z0-9]{20,}/, "OpenAI 风格 API Key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack Token"],
  [/NAVI_PASSWORD_HASH\s*[=:]\s*["']?[0-9a-f]{32,}/i, "密码哈希被写死（等同于泄露口令）"],
];

/* B. 真实密钥字面量：值取自 .env / PREFLIGHT_SECRETS，绝不出现在本源码里 */
const REAL_RES = REAL_SECRETS.map((s) => [new RegExp(escapeRe(s), "g"), "出现 .env 中的真实密钥值"]);

/* C. 弱特征：只提示，人工扫一眼（占位符、变量引用、compose 插值都会命中，属正常） */
const ASSIGN_RE = /(?<![\w${])NAVI_PASSWORD\s*[=:]/;

/*
 * 判断 NAVI_PASSWORD 后面跟的那串是不是「占位符 / 变量引用 / 文档说明」。
 * 目的是把 `.env.example` 的 CHANGE_ME、compose 的 `${NAVI_PASSWORD:?}`、
 * README 里给人看的 "你的强密码" 这些正常写法全部过滤掉，
 * 只把「看起来真像一句密码」的留下 —— 否则自检会刷满几十行噪声。
 */
function isPlaceholderValue(v) {
  if (!v) return true;
  if (/[<$]/.test(v)) return true;                    // ${插值} / 变量 / HTML 标签
  if (/NAVI_PASSWORD/.test(v)) return true;           // 指向了另一个赋值（文档示例的典型形态）
  if (/<\/|&\w+;|&#\d+;/.test(v)) return true;        // HTML 实体或闭合标签
  if (/[你我的]|强密码|占位|示例|此处/.test(v)) return true; // 中文提示语
  if (/^(change[_-]?me|your|xxx+|example|placeholder|todo|none|null|true|false|password|passwd|pw|secret)$/i.test(v)) return true;
  if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(v)) return true; // 纯标点（如 "..."、"***"）
  if (/^[A-Za-z_$][\w$]*$/.test(v)) return true;       // 标识符引用（如 PASSWORD）
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 把真实密钥值替换成 ***，只留首尾各 2 个字符便于定位
function mask(text) {
  let out = text;
  for (const s of REAL_SECRETS) {
    out = out.split(s).join(s.slice(0, 2) + "***" + s.slice(-2));
  }
  return out;
}

const TEXT_EXT = /\.(js|cjs|mjs|json|html|css|md|txt|yml|yaml|sh|cmd|bat|example|gitignore|gitattributes|LICENSE|env)$/i;
const NAME_HINT = /(^|\/)(\.env\.example|\.gitignore|\.gitattributes|LICENSE)$/;

let scanned = 0;
let testSkipped = 0;
const hits = [];
for (const rel of files) {
  // 文本类才扫；无扩展名的按名字判断（如 .gitignore / LICENSE）
  if (!TEXT_EXT.test(rel) && !NAME_HINT.test(rel)) continue;
  let text;
  try {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (buf.includes(0)) continue; // 二进制
    text = buf.toString("utf8");
  } catch (e) {
    continue;
  }
  scanned++;
  const isTestFixture = /^test\//.test(rel);
  text.split(/\r?\n/).forEach((line, i) => {
    const push = (label, level) => hits.push({
      rel, line: i + 1, label, level,
      // 打印时把真实密钥值打码，避免它进终端记录
      excerpt: mask(line.trim().slice(0, 130)),
    });
    // B 类：真实密钥值 —— 任何文件（含 test/）都不允许出现
    for (const [re, label] of REAL_RES) { re.lastIndex = 0; if (re.test(line)) push(label, "bad"); }
    // A 类：高置信度特征（token / 私钥 / 哈希）
    for (const [re, label] of FATAL_PATTERNS) if (re.test(line)) push(label, "bad");
    // C 类：NAVI_PASSWORD 赋值 —— 只报「值看着像真密码」的；
    //       测试夹具按约定豁免（里面本就是假密码）
    const am = ASSIGN_RE.exec(line);
    if (am) {
      // 只取紧跟其后的第一个词，避免把整行（含说明文字、HTML 尾巴）当成值
      const rest = line.slice(am.index + am[0].length).trim();
      const vm = rest.match(/^["']?([^\s"'`,;、)]+)/);
      const value = vm ? vm[1] : rest;
      if (isTestFixture) testSkipped++;
      else if (!isPlaceholderValue(value)) {
        push("NAVI_PASSWORD 后面跟的像是一句真实密码（占位符不会报这条）", "warn");
      }
    }
  });
}
for (const h of hits) {
  const msg = h.rel + ":" + h.line + "  " + h.label + "\n        " + h.excerpt;
  if (h.level === "bad") bad(msg);
  else warn(msg);
}
if (!hits.length) {
  ok("已扫描 " + scanned + " 个文本文件，未发现密钥特征" +
    (testSkipped ? "（另 " + testSkipped + " 处测试夹具中的假密码已按约定豁免）" : ""));
}

/* ---------------- 4. LICENSE 占位符 ---------------- */
console.log("== 4. LICENSE 版权人 ==");
try {
  const lic = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  if (/<Copyright Holder>|<YOUR NAME>|<版权人>/i.test(lic)) {
    warn("LICENSE 仍是占位符 —— 推公开仓库前建议换成你的名字或 GitHub 用户名");
  } else {
    ok("LICENSE 版权人已填写");
  }
} catch (e) {
  /* 已在第 2 步报缺失 */
}

/* ---------------- 5. 体量与体积 ---------------- */
console.log("== 5. 仓库体量 ==");
const GA_WARN = 25 * 1024 * 1024;   // 25MB：接近 GitHub 单文件提示阈值
const GA_HARD = 100 * 1024 * 1024;  // 100MB：GitHub 硬限制
let total = 0;
const sized = [];
for (const rel of files) {
  try {
    const st = fs.statSync(path.join(ROOT, rel));
    total += st.size;
    sized.push({ rel, size: st.size });
  } catch (e) {
    warn("文件读不到（是否已被删除？）：" + rel);
  }
}
sized.sort((a, b) => b.size - a.size);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
for (const s of sized) {
  if (s.size >= GA_HARD) bad("单文件超过 GitHub 100MB 硬限制：" + s.rel + "（" + mb(s.size) + "）");
  else if (s.size >= GA_WARN) warn("单文件较大（" + mb(s.size) + "）：" + s.rel);
}
ok("总体积 " + mb(total) + "，" + files.length + " 个文件；最大 " +
   (sized[0] ? sized[0].rel + "（" + mb(sized[0].size) + "）" : "—"));

/* ---------------- 汇总 ---------------- */
console.log("");
console.log("---------------- 检查结果 ----------------");
for (const p of pass) console.log("  ✅ " + p);
for (const w of warns) console.log("  ⚠️  " + w);
for (const p of problems) console.log("  ❌ " + p);
console.log("------------------------------------------");
console.log("通过 " + pass.length + " 项，警告 " + warns.length + " 项，问题 " + problems.length + " 项");
if (problems.length) {
  console.log("");
  console.log("🚫 结论：先解决上面的 ❌ 再推送。若已 commit 进历史，需用 git rebase / filter-repo 清除。");
  process.exit(1);
}
console.log("");
console.log("✅ 结论：可以推送" + (warns.length ? "（建议先看一眼 ⚠️ 项）" : "") + "。");
