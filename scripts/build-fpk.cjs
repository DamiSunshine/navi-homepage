/*
 * 构建 fnOS 应用安装包（.fpk）。
 *
 * 为什么要有这个脚本，而不是直接敲 fnpack：
 *   1) fnpack 必须能被执行到 —— 它不在 npm 里，得先从飞牛官方下载（见 deploy/fnos/README.md），
 *      脚本负责按「环境变量 → deploy/fnos/tools → PATH」的顺序自动找。
 *   2) fnpack 在 Windows 上打出来的包，文件属主是空的、权限一律 0666，cmd/ 下的生命周期
 *      脚本没有可执行位。Linux 上没问题，但飞牛解包后设置目录权限时容易报
 *      「设置目录权限失败」。所以打包后统一规范化：属主 root、目录 0755、cmd/ 下脚本 0755、其余 0644。
 *   3) 出包前要能自证「包是对的」——校验必需成员、校验 manifest 的 checksum 与 app.tgz 的
 *      MD5 真的对得上、校验版本号与 manifest 一致。这些检查失败就直接非零退出，不发残包。
 *
 * 用法：
 *   node scripts/build-fpk.cjs                    # 构建到 deploy/fnos/dist/
 *   node scripts/build-fpk.cjs --skip-build       # 复用已存在的 navi.fpk，只做规范化+校验+出包
 *   FNPACK=/path/to/fnpack node scripts/build-fpk.cjs
 *
 * --skip-build 的用途：某些受限环境禁止 Node 派生子进程（本机实测 spawnSync 直接 EBUSY），
 * 这时先在 deploy/fnos 下手动跑一次 fnpack build，再用 --skip-build 让脚本接管后续步骤。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PKG_DIR = path.join(ROOT, "deploy", "fnos");
const DIST_DIR = path.join(PKG_DIR, "dist");
const BLOCK = 512;

/* ---------------- tar 读写（只处理 fpk 用得到的这几种条目） ---------------- */

function parseTar(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + BLOCK <= buf.length) {
    const header = Buffer.from(buf.slice(off, off + BLOCK));
    if (header.every((b) => b === 0)) break;
    const text = (start, len) => header.slice(start, start + len).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(text(124, 12) || "0", 8) || 0;
    const type = String.fromCharCode(header[156]) || "0";
    const data = buf.slice(off + BLOCK, off + BLOCK + size);
    const name = text(0, 100) || longName || "";
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/, "");
    } else {
      entries.push({ name, type, size, header, data, padded: Math.ceil(size / BLOCK) * BLOCK });
      longName = null;
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

function writeOctal(buf, value, start, len) {
  const s = value.toString(8).padStart(len - 1, "0").slice(-(len - 1)) + "\0";
  buf.write(s, start, len, "ascii");
}

function setHeaderField(header, { mode, uid, gid, uname, gname }) {
  writeOctal(header, mode, 100, 8);
  writeOctal(header, uid, 108, 8);
  writeOctal(header, gid, 116, 8);
  header.fill(0x20, 265, 297); // uname
  header.write(uname, 265, 32, "ascii");
  header.fill(0x20, 297, 329); // gname
  header.write(gname, 297, 32, "ascii");
  // 校验和：先把自己这 8 字节当空格，再求和
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

function buildTar(entries, gzip) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(e.header);
    if (e.data.length) {
      chunks.push(e.data);
      const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const raw = Buffer.concat(chunks);
  return gzip ? zlib.gzipSync(raw, { level: 9 }) : raw;
}

/* ---------------- 规范化 ---------------- */

function normalize(fpkPath) {
  const entries = parseTar(zlib.gunzipSync(fs.readFileSync(fpkPath)));
  for (const e of entries) {
    if (e.type === "L" || e.type === "x") continue; // 长文件名/pax 头原样保留
    if (e.name === "manifest") {
      // fnpack 1.2.3 在 Windows 上会把 manifest 重写成 CRLF，而飞牛按行解析这份 INI：
      // 值尾残留的 \r 会让 version / appname 之类的字段对不上。统一回 LF。
      // （manifest 在 app.tgz 之外，改它不影响 manifest.checksum —— checksum 算的是 app.tgz）
      const text = e.data.toString("utf8").replace(/\r\n/g, "\n");
      e.data = Buffer.from(text, "utf8");
      writeOctal(e.header, e.data.length, 124, 12);
    }
    const isDir = e.type === "5";
    const isScript = /^cmd\//.test(e.name) || /\.sh$/.test(e.name);
    const mode = isDir ? 0o755 : isScript ? 0o755 : 0o644;
    setHeaderField(e.header, { mode, uid: 0, gid: 0, uname: "root", gname: "root" });
  }
  fs.writeFileSync(fpkPath, buildTar(entries, true));
  return entries;
}

/* ---------------- 校验 ---------------- */

function verify(fpkPath) {
  const raw = zlib.gunzipSync(fs.readFileSync(fpkPath));
  const entries = parseTar(raw);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const problems = [];

  const required = [
    "manifest", "app.tgz", "cmd", "cmd/main", "config", "config/privilege",
    "config/resource", "wizard", "ICON.PNG", "ICON_256.PNG",
  ];
  for (const name of required) {
    if (!byName.has(name)) problems.push("缺少必需成员：" + name);
  }

  const manifestEntry = byName.get("manifest");
  const appEntry = byName.get("app.tgz");
  let composeText = ""; // 后面要拿 compose 的 env_file 与 cmd/install_init 交叉校验
  if (manifestEntry && appEntry) {
    const text = manifestEntry.data.toString("utf8");
    const declared = (text.match(/^checksum\s*=\s*([0-9a-f]+)/m) || [])[1] || "";
    const actual = crypto.createHash("md5").update(appEntry.data).digest("hex");
    if (declared !== actual) {
      problems.push("manifest.checksum 与 app.tgz 实际 MD5 不一致（声明 " + declared + "，实际 " + actual + "）");
    }
    const version = (text.match(/^version\s*=\s*(\S+)/m) || [])[1] || "";
    const appname = (text.match(/^appname\s*=\s*(\S+)/m) || [])[1] || "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push("manifest.version 不是 X.Y.Z 格式：" + version);
    if (appname !== "navi") problems.push("manifest.appname 期望 navi，实际 " + appname);
    if (/\r/.test(text)) problems.push("manifest 里存在 CRLF（飞牛按行解析 INI，必须 LF）");
  }

  // app.tgz 内部：入口配置与引导配置必须在。
  // 注意路径基准是 app/ 目录本身（fnpack 把 app/ 的内容打成 tgz 根），所以是 ui/config 而不是 app/ui/config。
  const innerRequired = [
    "ui/config",
    "ui/images/icon_64.png",
    "ui/images/icon_256.png",
    "docker/docker-compose.yaml",
    "docker/bootstrap/config.json",
  ];
  if (appEntry) {
    const innerEntries = parseTar(zlib.gunzipSync(appEntry.data));
    const inner = innerEntries.map((e) => e.name);
    for (const name of innerRequired) {
      if (!inner.includes(name)) problems.push("app.tgz 内缺少 " + name);
    }
    const compose = innerEntries.find((e) => e.name === "docker/docker-compose.yaml");
    if (compose) {
      const text = compose.data.toString("utf8");
      composeText = text;
      if (/:latest\b/.test(text)) {
        problems.push("compose 里出现了 :latest 浮动标签，包内应固定版本标签");
      }
      // 包内镜像标签必须与 manifest.version 一致：版本升了却忘了改 compose，
      // 装出来的包会去拉上一版镜像 —— 而且装的时候一切正常，只有行为不对。
      const tag = (text.match(/^\s*image:\s*\S+:(\S+)\s*$/m) || [])[1] || "";
      const declaredVer = (manifestEntry ? manifestEntry.data.toString("utf8") : "")
        .match(/^version\s*=\s*(\S+)/m);
      if (tag && declaredVer && tag !== declaredVer[1]) {
        problems.push("compose 镜像标签 " + tag + " 与 manifest.version " + declaredVer[1] + " 不一致");
      }
    }
    const uiConfig = innerEntries.find((e) => e.name === "ui/config");
    if (uiConfig) {
      try {
        const cfg = JSON.parse(uiConfig.data.toString("utf8"));
        const entries = Object.keys(cfg[".url"] || {});
        if (!entries.length) problems.push("app/ui/config 里 .url 没有任何入口");
      } catch (err) {
        problems.push("app/ui/config 不是合法 JSON：" + err.message);
      }
    }
  }

  // 生命周期脚本：安装/升级前的检查不得把「环境探测」当闸门。
  // 真实事故（v1.1.1）：install_init 用 `docker info` 判定 Docker 可用性并在失败时 exit 1，
  // 结果 Docker 明明正常，安装却被直接判失败，应用中心弹出「Docker 服务当前不可用」。
  // 真因是生命周期脚本的执行身份/环境与用户 SSH 里不是一回事（PATH、DOCKER_HOST、
  // docker context、docker 组成员关系都可能不同），这种探测天然会误报。
  // 拉起 docker-project 是飞牛自己的事，真失败它会报自己的错 —— 安装前只应提示、不应阻断。
  for (const name of ["cmd/install_init", "cmd/upgrade_init"]) {
    const entry = byName.get(name);
    if (!entry) continue;
    const text = entry.data.toString("utf8");
    if (/^\s*exit\s+[1-9]/m.test(text)) {
      problems.push(name + " 里有非零退出：安装/升级前的检查只能提示，阻断会因执行环境差异误判（v1.1.1 事故）");
    }
    if (!/^\s*exit\s+0\s*$/m.test(text)) {
      problems.push(name + " 没有以 exit 0 结束，生命周期脚本必须可重复执行且返回成功");
    }
  }

  // cmd/main status：必须有与权限无关的兜底，否则应用中心会把运行中的应用一直显示成已停止。
  // 用「必须存在」的正向断言而不是「先匹配 docker inspect 再检查兜底」——
  // 后者一旦脚本改成通过变量调用（"$DOCKER_BIN" inspect），字面量就匹配不上，
  // 护栏会静默退化成永远不触发的空断言（这条坑当场踩过一次）。
  const mainEntry = byName.get("cmd/main");
  if (mainEntry) {
    const text = mainEntry.data.toString("utf8");
    if (!(/-ltn/.test(text) && /curl/.test(text))) {
      problems.push("cmd/main 缺少不依赖 Docker 的状态兜底（需要「端口在监听 + HTTP 有应答」）：拿不到 Docker 时会把运行中的应用误报成未运行");
    }
  }

  // 生命周期脚本的两类「退出码 / 日志」事故 —— v1.1.1 第二轮安装失败的真正原因：
  //   ① `[ ... ] && echo ...` 当条件为假时退出码是 1，而 `{ ...; }` 取最后一条命令的退出码，
  //      于是「向导里留空的字段」（内网地址基址默认就是空）会让整组返回 1，
  //      被外面的 `|| { exit 1; }` 误判成「写文件失败」—— 文件其实早已写好，安装却失败了。
  //   ② 用 `>` 写 TRIM_TEMP_LOGFILE：同一脚本内多处写日志会互相覆盖，把真正的原因句冲掉，
  //      排查时只能看到最后一句提示。
  for (const e of entries) {
    if (!/^cmd\//.test(e.name)) continue;
    const text = e.data.toString("utf8");
    const risky = text.split("\n")
      .map((l, i) => ({ line: l, no: i + 1 }))
      .filter(({ line }) => /^\s*\[[^\]]*\]\s*&&\s*(echo|printf)\b/.test(line));
    if (risky.length) {
      problems.push(e.name + " 第 " + risky.map((r) => r.no).join("/") + " 行用了 `[ ... ] && echo` 写法：" +
        "条件为假时退出码为 1，会让所在组命令被 `||` 误判成失败（v1.1.1 事故），请改用 if 语句");
    }
    if (/(^|[^>])>\s*"\$\{?TRIM_TEMP_LOGFILE/.test(text) || /(^|[^>])>\s*"\$LOG"/.test(text)) {
      problems.push(e.name + " 用 `>` 写日志文件：同脚本内多处写会互相覆盖，应改成追加 `>>`");
    }
    if (/>>>/.test(text)) problems.push(e.name + " 出现了 `>>>` 重定向（改写事故）");
  }

  // compose 的 env_file 指向的文件必须由 cmd/install_init 预先落好。
  // 真实事故：env_file 指向 ${TRIM_PKGVAR}/navi.env，而该文件原本只由 install_callback 创建 ——
  // 只要应用中心拉起 docker-project 的时点早于 install_callback，docker compose 就会直接
  // 报 `env file ... not found` 并让整个安装失败。文件必须由流程最早的一步准备好。
  const installInit = byName.get("cmd/install_init");
  const envFileRef = composeText.match(/env_file\s*:[\s\S]{0,200}?-\s*(\S+)/);
  if (envFileRef && installInit) {
    const base = path.basename(envFileRef[1].replace(/["']/g, ""));
    if (!installInit.data.toString("utf8").includes(base)) {
      problems.push("compose 的 env_file 指向 " + base + "，但 cmd/install_init 没有预先创建它：" +
        "文件不存在时 docker compose 会直接让安装失败（v1.1.1 事故）");
    }
  }

  // 取不到向导密码时必须降级（沿用已有 / 生成随机），而不是中止安装 ——
  // 中止会让「装不上」，而裸奔会被随机密码挡住。PASSWORD.txt 是这个降级链的落点。
  const installCallback = byName.get("cmd/install_callback");
  if (installCallback) {
    const text = installCallback.data.toString("utf8");
    if (!/PASSWORD\.txt/.test(text)) {
      problems.push("cmd/install_callback 缺少随机密码兜底（PASSWORD.txt）：取不到向导密码时既不能中止安装，也不能写出空密码");
    }
    if (!/navi\.env/.test(text)) {
      problems.push("cmd/install_callback 没有写 navi.env：站点会拿不到访问密码");
    }
  }

  if (entries.some((e) => /\.DS_Store$/.test(e.name))) problems.push("包里混入了 .DS_Store");

  return { entries, problems, manifest: manifestEntry ? manifestEntry.data.toString("utf8") : "" };
}

/* ---------------- 主流程 ---------------- */

function findFnpack() {
  const candidates = [
    process.env.FNPACK,
    path.join(PKG_DIR, "tools", "fnpack.exe"),
    path.join(PKG_DIR, "tools", "fnpack"),
    path.join(ROOT, "fnpack.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // PATH 兜底
  for (const name of ["fnpack", "fnpack.exe"]) {
    const r = spawnSync(name, ["--help"], { encoding: "utf-8" });
    if (r.status === 0 || (r.stdout || "").includes("fnpack")) return name;
  }
  return null;
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const built = path.join(PKG_DIR, "navi.fpk");

  if (!skipBuild) {
    const fnpack = findFnpack();
    if (!fnpack) {
      console.error("未找到 fnpack。请先从 https://developer.fnnas.com/docs/cli/fnpack/ 下载对应平台的");
      console.error("fnpack，放到 deploy/fnos/tools/ 下（Windows 版重命名为 fnpack.exe），或用 FNPACK 指定路径。");
      process.exit(1);
    }
    console.log("使用 fnpack：" + fnpack);
    if (fs.existsSync(built)) fs.rmSync(built);

    // fnpack 把 navi.fpk 写在「当前工作目录」，不是 -d 指定的目录；
    // 且部分环境下传绝对路径参数会失败（本机实测），所以直接以包目录为工作目录执行。
    const r = spawnSync(fnpack, ["build"], { cwd: PKG_DIR, encoding: "utf-8" });
    if (r.error) {
      console.error("无法调用 fnpack（" + r.error.code + "）。若当前环境禁止 Node 派生子进程，");
      console.error("请在 deploy/fnos 目录下手动执行一次 `fnpack build`，然后加 --skip-build 重跑本脚本。");
      process.exit(1);
    }
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) {
      console.error("fnpack build 失败（退出码 " + r.status + "）");
      process.exit(1);
    }
  }

  if (!fs.existsSync(built)) {
    console.error("未找到待处理的产物：" + built);
    console.error("请先执行 `fnpack build`（工作目录 deploy/fnos），或去掉 --skip-build 让脚本自行调用。");
    process.exit(1);
  }

  normalize(built);
  const { entries, problems, manifest } = verify(built);
  const version = (manifest.match(/^version\s*=\s*(\S+)/m) || [])[1] || "unknown";

  if (problems.length) {
    console.error("");
    console.error("包校验未通过：");
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const finalPath = path.join(DIST_DIR, "navi-" + version + ".fpk");
  fs.copyFileSync(built, finalPath);

  const size = fs.statSync(finalPath).size;
  console.log("");
  console.log("包成员（" + entries.length + " 项）：");
  for (const e of entries) {
    console.log("  " + (e.type === "5" ? "[dir] " : "      ") + e.name + "  " + e.size + "B");
  }
  console.log("");
  console.log("✓ 校验通过：必需成员齐全 / checksum 与 app.tgz 一致 / 版本 " + version + " / 无 :latest 浮动标签");
  console.log("✓ 产物：" + path.relative(ROOT, finalPath) + "（" + (size / 1024).toFixed(1) + " KB）");
}

main();
