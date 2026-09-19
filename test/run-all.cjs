/*
 * 一条命令跑完全部测试套件。
 *
 * 为什么需要它：13 个套件里有 4 个（server / ui / ui-theme / ui-backup）需要先有一个
 * 运行中的实例，且该实例必须用【隔离的临时 config + 临时 uploads】启动——直接用仓库里的
 * public/config.json 会把真实导航数据改掉。手工拼环境变量很容易漏，所以固化在这里。
 *
 * 用法：
 *   NODE_PATH=<含 playwright 的 node_modules> node test/run-all.cjs
 *   NODE_PATH=<含 playwright 的 node_modules> node test/run-all.cjs ui-backup   # 只跑名字含该串的套件
 *
 * 端口：共享实例固定 8633（8632 常被用户长期运行的实例占用）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
const PORT = 8633;
const BASE = "http://127.0.0.1:" + PORT;

// [套件文件, 是否需要 baseUrl]
const SUITES = [
  ["server.test.js", true],
  ["ui.test.cjs", true],
  ["ui-theme.test.cjs", true],
  ["ui-backup.test.cjs", true],
  ["auth.test.js", false],
  ["backup.test.js", false],
  ["discover.test.js", false],
  ["library.test.js", false],
  ["ui-auth.test.cjs", false],
  ["ui-discover.test.cjs", false],
  ["ui-library.test.cjs", false],
  ["checkdeploy.test.cjs", false],
  ["imagecompose.test.cjs", false],
];

// 可选过滤：node test/run-all.cjs ui-backup → 只跑文件名包含该子串的套件
const FILTER = process.argv[2] || "";
const SELECTED = FILTER ? SUITES.filter(([f]) => f.includes(FILTER)) : SUITES;
if (!SELECTED.length) {
  console.error("没有匹配「" + FILTER + "」的套件；可用：" + SUITES.map((s) => s[0]).join(", "));
  process.exit(1);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "navi-runall-"));
const cfgPath = path.join(tmpRoot, "config.json");
const upDir = path.join(tmpRoot, "uploads");
fs.mkdirSync(upDir, { recursive: true });

// 隔离配置：优先用本机真实配置（含 lanUrl，部分 UI 断言依赖它），兜底用示例配置
const realCfg = path.join(ROOT, "public", "config.json");
const exampleCfg = path.join(ROOT, "public", "config.example.json");
fs.copyFileSync(fs.existsSync(realCfg) ? realCfg : exampleCfg, cfgPath);

const child = spawn(NODE, [path.join(ROOT, "server.js")], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: "::",
    NAVI_CONFIG_PATH: cfgPath,
    NAVI_UPLOAD_DIR: upDir,
    NAVI_SCAN_LOCAL: "0",
    NAVI_ICON_PROBE: "0",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

let summary = [];
let totalPass = 0;
let totalFail = 0;
let infraError = null;

function finish(code) {
  try { child.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(code);
}

child.on("exit", (c) => {
  if (!(summary.length >= SELECTED.length) && !infraError) {
    console.error("共享实例提前退出，退出码 " + c);
  }
});

const timer = setTimeout(() => {
  console.error("服务启动超时（15s）");
  finish(1);
}, 15000);

child.stdout.on("data", (d) => {
  if (String(d).includes("listening on")) {
    clearTimeout(timer);
    runAll();
  }
});

function runSuite(file, needBase) {
  const args = [path.join(__dirname, file)];
  if (needBase) args.push(BASE);
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/结果：\s*(\d+)\s*通过,\s*(\d+)\s*失败/);
  const p = m ? Number(m[1]) : 0;
  const f = m ? Number(m[2]) : -1;
  totalPass += p;
  if (f < 0) totalFail += 1;
  else totalFail += f;
  summary.push({ file, pass: p, fail: f, code: r.status });
  console.log(
    (f === 0 ? "  ✓ " : "  ✗ ") +
    file.padEnd(24) +
    (m ? p + " 通过, " + f + " 失败" : "无法解析结果（退出码 " + r.status + "）")
  );
  if (f !== 0) {
    console.log("---- " + file + " 输出 ----");
    console.log(out.trim());
    console.log("---------------------------");
  }
}

function runAll() {
  console.log("共享实例已就绪：" + BASE + (FILTER ? "（过滤：" + FILTER + "）" : ""));
  console.log("");
  for (const [file, needBase] of SELECTED) runSuite(file, needBase);
  console.log("");
  const bad = summary.filter((s) => s.fail !== 0);
  console.log("合计：" + totalPass + " 通过, " + totalFail + " 失败 / 共 " + summary.length + " 个套件");
  if (bad.length) console.log("失败套件：" + bad.map((b) => b.file).join(", "));
  finish(totalFail ? 1 : 0);
}

process.on("uncaughtException", (e) => { console.error(e); finish(1); });
