/*
 * 「拉预构建镜像部署」这条路的自检测试
 *
 * 为什么要有它：
 *   这条路的特点是——**所有东西都在 GitHub 上跑，本地不做任何事**。
 *   所以一旦被改坏（工作流不再打多架构、镜像编排里混进 build:、
 *   密码护栏被换成 :- ），本地开发时**完全没有任何症状**，
 *   要等到用户在另一台机器上 pull 失败才发现。
 *   本套件把这批"看不见的契约"固化成断言。
 *
 * 覆盖三块：
 *   A. .github/workflows/docker-publish.yml —— 触发/权限/多架构/推送/冒烟
 *   B. docker-compose.image.yml —— 无 build:、指向远程仓库、护栏齐全
 *   C. 两条部署路径不能漂移 —— 源码编排与镜像编排的环境变量/端口/挂载必须一致
 *   D. 调用真的 scripts/check-compose.cjs（含反向验证：畸形夹具必须被判失败）
 *
 * 自包含：不联网、不起服务、不碰真实数据。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
const WORKFLOW = path.join(ROOT, ".github", "workflows", "docker-publish.yml");
const IMAGE_COMPOSE = path.join(ROOT, "docker-compose.image.yml");
const BUILD_COMPOSE = path.join(ROOT, "docker-compose.yml");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

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
function check(cond, label, extra) {
  if (cond) ok(label, extra);
  else bad(label, extra);
  return !!cond;
}

/* js-yaml：先常规 require，再从常见位置兜底（与 check-compose.cjs 同一策略） */
let yaml = null;
let jsYamlDir = null;
try {
  yaml = require("js-yaml");
} catch (e) { /* 兜底 */ }
if (!yaml) {
  const cands = [
    process.env.NAVI_JS_YAML_DIR,
    "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules",
    path.join(ROOT, "node_modules"),
  ].filter(Boolean);
  for (const d of cands) {
    try { yaml = require(path.join(d, "js-yaml")); jsYamlDir = d; break; } catch (e) { /* 继续 */ }
  }
}
if (yaml && !jsYamlDir) {
  try { jsYamlDir = path.dirname(path.dirname(require.resolve("js-yaml"))); } catch (e) { /* 忽略 */ }
}

if (!yaml) {
  console.log("\u274c 缺少 js-yaml，无法检查 YAML 契约（仅开发期需要，运行时零依赖）。");
  console.log("   解决：npm i -g js-yaml  或  NODE_PATH=<含 js-yaml 的 node_modules> node test/run-all.cjs");
  console.log("");
  console.log("结果：0 通过, 1 失败");
  process.exit(1);
}

function loadYamlFile(p) {
  return yaml.load(fs.readFileSync(p, "utf-8"));
}
function readText(p) {
  return fs.readFileSync(p, "utf-8");
}
/* 去掉纯注释行与行尾注释，避免注释里的字样干扰断言 */
function stripComments(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
}
function stepsOf(job) {
  return (job && job.steps) || [];
}
function findStepByUses(job, prefix) {
  return stepsOf(job).find((s) => typeof s.uses === "string" && s.uses.startsWith(prefix));
}
function runTextOf(job) {
  return stepsOf(job).filter((s) => typeof s.run === "string").map((s) => s.run).join("\n");
}

/* ---------------- A. 工作流 ---------------- */

section("A. .github/workflows/docker-publish.yml");
check(fs.existsSync(WORKFLOW), "工作流文件存在");
check(fs.existsSync(IMAGE_COMPOSE), "docker-compose.image.yml 存在");

try {
  const wf = loadYamlFile(WORKFLOW);
  ok("工作流 YAML 语法通过");

  const on = wf.on || {};
  const pushTags = (on.push && on.push.tags) || [];
  const pushBranches = (on.push && on.push.branches) || [];
  check(pushTags.some((t) => /^v\*/.test(String(t))),
    "打 tag 时触发（tag 是发布语义化版本的唯一入口）", JSON.stringify(pushTags));
  check(pushBranches.some((b) => /main/.test(String(b))),
    "推 main 分支时触发", JSON.stringify(pushBranches));
  check("workflow_dispatch" in on, "支持在 Actions 页面手动触发");

  const perm = wf.permissions || {};
  check(perm.packages === "write", "申请了 packages: write（推包必需，GITHUB_TOKEN 默认没有）", String(perm.packages));
  check(perm.contents === "read", "contents 保持只读（最小权限）", String(perm.contents));

  const build = (wf.jobs || {}).build || {};
  check(!!findStepByUses(build, "actions/checkout@"), "build 作业会检出源码");
  check(!!findStepByUses(build, "docker/setup-qemu-action@"),
    "启用了 QEMU（amd64 runner 上构建 arm64 的必需条件）");
  check(!!findStepByUses(build, "docker/setup-buildx-action@"), "启用了 Buildx");

  const login = findStepByUses(build, "docker/login-action@");
  if (login) {
    const withLogin = login.with || {};
    check(withLogin.registry === "ghcr.io", "登录目标是 ghcr.io", String(withLogin.registry));
    check(/secrets\.GITHUB_TOKEN/.test(String(withLogin.password)),
      "用内置 GITHUB_TOKEN 登录（无需用户自己配密钥）");
  } else bad("存在 docker/login-action 步骤");

  const meta = findStepByUses(build, "docker/metadata-action@");
  if (meta) {
    const tags = String((meta.with || {}).tags || "");
    check(/type=semver/.test(tags), "按语义化版本生成标签（v1.2.3 → 1.2.3 / 1.2）");
    check(/value=latest/.test(tags) && /startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(tags),
      "latest 仅在打 tag 时更新（往 main 推代码不会污染用户手里的 latest）");
  } else bad("存在 docker/metadata-action 步骤");

  const bpa = findStepByUses(build, "docker/build-push-action@");
  if (bpa) {
    const w = bpa.with || {};
    const platforms = String(w.platforms || "");
    check(/linux\/amd64/.test(platforms) && /linux\/arm64/.test(platforms),
      "同时构建 amd64 与 arm64（少了 arm64，树莓派/ARM NAS 就装不上）", platforms);
    check(w.push === true || String(w.push) === "true", "开启推送", String(w.push));
    check(/docker\/metadata-action@/.test(String(stepsOf(build).map((s) => s.uses).join(" "))),
      "镜像标签交给 metadata-action 统一生成（不手写标签）");
  } else bad("存在 docker/build-push-action 步骤");

  const buildRun = runTextOf(build);
  check(/\$\{GITHUB_REPOSITORY,,\}/.test(buildRun),
    "镜像名统一转小写（GHCR 只接受小写，否则推送报 invalid reference format）");

  const smoke = (wf.jobs || {}).smoke;
  check(!!smoke, "存在冒烟作业（构建成功 ≠ 跑得起来）");
  if (smoke) {
    const needs = Array.isArray(smoke.needs) ? smoke.needs : [smoke.needs];
    check(needs.indexOf("build") >= 0, "冒烟作业依赖 build 完成后再跑", JSON.stringify(smoke.needs));
    const smokeRun = runTextOf(smoke);
    check(/docker run/.test(smokeRun), "冒烟作业会真实启动容器");
    check(/\/api\/health/.test(smokeRun), "冒烟作业会请求健康接口");
    check(/"ok"/.test(smokeRun), "冒烟作业会校验健康接口的 ok 字段（只看 HTTP 200 不够）");
    check(/grep -q/.test(smokeRun), "冒烟作业有失败即中断的断言（否则跑挂了也返回成功）");
  }

  const wfRaw = stripComments(readText(WORKFLOW));
  check(!/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(wfRaw),
    "工作流里没有硬编码任何访问令牌（令牌进仓库等于泄露）");
  check(!/password:\s*['"]?[A-Za-z0-9]{16,}/.test(wfRaw),
    "工作流里没有硬编码密码");
} catch (e) {
  bad("工作流解析失败", e && e.message ? e.message : String(e));
}

/* ---------------- B. 镜像编排 ---------------- */

section("B. docker-compose.image.yml（纯拉取）");
let imgDoc = null;
try {
  imgDoc = loadYamlFile(IMAGE_COMPOSE);
  ok("YAML 语法通过");

  const svcs = imgDoc.services || {};
  const names = Object.keys(svcs);
  check(names.length > 0, "解析出 services", names.join(", "));
  const navi = svcs[names[0]] || {};

  check(navi.build === undefined,
    "不含 build: 键（一旦有 build:，compose 会转去本地构建，「拉镜像」就静默失效）");
  check(typeof navi.image === "string", "设置了 image:", String(navi.image));
  check(/ghcr\.io\//.test(String(navi.image)), "image 指向 ghcr.io 远程仓库", String(navi.image));
  check(/\$\{NAVI_IMAGE:-/.test(String(navi.image)),
    "镜像地址可用 NAVI_IMAGE 覆盖（国内可换成 GHCR 镜像站）");
  check(/\$\{NAVI_TAG:-/.test(String(navi.image)),
    "镜像标签可用 NAVI_TAG 覆盖（可固定版本号避免 latest 漂移）");

  const envArr = Array.isArray(navi.environment) ? navi.environment.map(String) : [];
  const pwLine = envArr.find((l) => l.startsWith("NAVI_PASSWORD=")) || "";
  check(/\$\{NAVI_PASSWORD:\?/.test(pwLine),
    "NAVI_PASSWORD 保留 :? 强制校验（缺变量时 compose 直接报错，不会静默变成无密码公开）", pwLine);
  check(!/\$\{NAVI_PASSWORD:-/.test(pwLine), "没有退化成 :- 的静默默认值");

  const vols = (Array.isArray(navi.volumes) ? navi.volumes : []).map(String);
  check(vols.some((v) => /:\/app\/data$/.test(v)),
    "整目录挂载 /app/data（单文件挂载在飞牛等平台会 EBUSY）", vols.join(" | "));
  check(!vols.some((v) => /config\.json:\/app\/data/.test(v)), "没有把单个 config.json 挂进数据目录");

  const ports = (Array.isArray(navi.ports) ? navi.ports : []).map(String);
  check(ports.some((p) => /:\s*80$/.test(p) || /:\s*"?80"?$/.test(p)),
    "端口从容器 80 发布出来（镜像内监听 80）", ports.join(" | "));
  check(envArr.some((l) => l === "NAVI_CONFIG_PATH=/app/data/config.json"),
    "配置路径指向挂载目录内的文件");
} catch (e) {
  bad("镜像编排解析失败", e && e.message ? e.message : String(e));
}

/* ---------------- C. 两条部署路径不能漂移 ---------------- */

section("C. 源码编排 vs 镜像编排（不能漂移）");
try {
  const a = loadYamlFile(BUILD_COMPOSE).services || {};
  const b = (imgDoc && imgDoc.services) || {};
  const an = Object.keys(a)[0];
  const bn = Object.keys(b)[0];
  const A = a[an] || {};
  const B = b[bn] || {};

  check(an === bn, "服务名一致", an + " / " + bn);

  function envKeys(svc) {
    const e = svc.environment;
    if (!e) return [];
    return (Array.isArray(e) ? e.map(String) : Object.keys(e))
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => String(l).split("=")[0])
      .sort();
  }
  const ka = envKeys(A).join(",");
  const kb = envKeys(B).join(",");
  check(ka === kb, "环境变量集合一致（只改一处会让人在两份文件间反复踩坑）",
    "源码:[" + ka + "] 镜像:[" + kb + "]");

  check(JSON.stringify(A.ports) === JSON.stringify(B.ports),
    "端口映射一致", JSON.stringify(A.ports) + " / " + JSON.stringify(B.ports));

  const dataVol = (svc) => (Array.isArray(svc.volumes) ? svc.volumes.map(String) : []).filter((v) => /:\/app\/data$/.test(v));
  check(JSON.stringify(dataVol(A)) === JSON.stringify(dataVol(B)),
    "数据目录挂载一致", JSON.stringify(dataVol(A)) + " / " + JSON.stringify(dataVol(B)));

  check(B.build === undefined, "镜像编排仍然没有 build:（再次确认，防止漂移回来）");
} catch (e) {
  bad("两条路径一致性检查失败", e && e.message ? e.message : String(e));
}

/* ---------------- D. 调用真实的 check-compose.cjs ---------------- */

section("D. scripts/check-compose.cjs（真实调用 + 反向验证）");
const CHECKER = path.join(ROOT, "scripts", "check-compose.cjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-imgcompose-"));

function runChecker(args) {
  return spawnSync(NODE, [CHECKER].concat(args || []), {
    cwd: ROOT,
    encoding: "utf-8",
    env: Object.assign({}, process.env, jsYamlDir ? { NAVI_JS_YAML_DIR: jsYamlDir } : {}),
  });
}

try {
  const r = runChecker([]);
  check(r.status === 0, "对仓库现有 compose 文件返回 0（通过）",
    "exit=" + r.status + "  " + String(r.stdout || "").split(/\r?\n/).filter((l) => /✗/.test(l)).join(" ; "));

  // 反向验证：畸形夹具必须被判为失败，否则这个"裁判"只是个摆设
  const broken = [
    "services:",
    "  navi:",
    "    build: .",
    "    image: navi:latest",
    "    environment:",
    "      - NAVI_PASSWORD=${NAVI_PASSWORD:-}",
    "      - NAVI_UPLOAD_DIR=/app/data/uploads",
    "       - NAVI_LAN_HOST=http://10.10.10.18",
    "    volumes:",
    "      - ./data/config.json:/app/data/config.json",
    "",
  ].join("\n");
  const brokenPath = path.join(tmpDir, "fixture.image.yml");
  fs.writeFileSync(brokenPath, broken, "utf-8");

  const rb = runChecker([brokenPath]);
  const out = String(rb.stdout || "") + String(rb.stderr || "");
  check(rb.status === 1, "畸形夹具被判为失败（exit=1）", "exit=" + rb.status);
  check(/含有 build:/.test(out), "能抓到「纯拉取编排里混进 build:」");
  check(/不是远程仓库地址/.test(out), "能抓到「image 不是远程仓库地址」");
  check(/缩进比同级更深|\u6298\u8fdb\u4e86\u4e0b\u4e00\u884c/.test(out), "能抓到 YAML 静默折叠（变量失效）");
  check(/NAVI_PASSWORD:-|\u5192\u53f7\u51cf\u53f7/.test(out), "能抓到密码护栏退化成 :- 的静默默认值");
  check(/config\.json|EBUSY/.test(out), "能抓到单文件挂载（会触发 EBUSY）");

  // 语法都不合法的文件必须报语法错而不是静默通过
  const syntaxBad = path.join(tmpDir, "bad.image.yml");
  fs.writeFileSync(syntaxBad, "services:\n  navi:\n    image: x\n   environment:\n     - A=1\n", "utf-8");
  const rs = runChecker([syntaxBad]);
  check(rs.status === 1, "YAML 语法错误的文件返回 1 而不是静默通过", "exit=" + rs.status);
} catch (e) {
  bad("check-compose 调用异常", e && e.message ? e.message : String(e));
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* ---------------- E. 文档入口与镜像契约 ---------------- */

section("E. 文档入口与镜像契约");
try {
  const envEx = readText(ENV_EXAMPLE);
  check(/NAVI_IMAGE/.test(envEx), ".env.example 记录了 NAVI_IMAGE（换镜像站用）");
  check(/NAVI_TAG/.test(envEx), ".env.example 记录了 NAVI_TAG（固定版本用）");

  const df = readText(DOCKERFILE);
  check(/^FROM\s+node:22-alpine/m.test(df), "Dockerfile 仍基于 node:22-alpine");
  check(/^EXPOSE\s+80/m.test(df), "Dockerfile 仍暴露 80 端口（与 compose 的映射一致）");
  check(/^VOLUME\s+\["?\/app\/data"?\]/m.test(df) || /VOLUME.*\/app\/data/.test(df),
    "Dockerfile 仍声明 /app/data 为数据卷");
  check(/NAVI_CONFIG_PATH=\/app\/data\/config\.json/.test(df),
    "Dockerfile 默认配置路径指向数据卷内");

  const guide = path.join(ROOT, "docs", "image-deploy-guide.html");
  check(fs.existsSync(guide), "存在 docs/image-deploy-guide.html（拉取部署指南）");
  if (fs.existsSync(guide)) {
    const g = readText(guide);
    check(/docker-compose\.image\.yml/.test(g), "指南里给出了镜像编排的文件名");
    check(/docker compose -f docker-compose\.image\.yml pull/.test(g) || /pull/.test(g),
      "指南里讲了要先 pull（不 pull 会一直用本地旧镜像）");
    check(/ghcr\.io/.test(g), "指南里说明了镜像地址");
    check(/arm64|架构/.test(g), "指南里讲了 CPU 架构");
    check(/可见性|public/.test(g), "指南里讲了镜像可见性");
    check(/config\.json/.test(g), "指南里讲了 data/config.json 的前置条件");

    check(/uname -m/.test(g), "指南给出了确认 CPU 架构的命令");
    check(/i386|i686|32 位/.test(g), "指南说明 32 位 x86 不受支持（只提供 amd64）");
    check(/SSE4\.2/.test(g) && /sse4_2/.test(g), "指南说明 x86 需支持 SSE4.2 并给出自检命令");
    check(/Illegal instruction/.test(g), "指南说明老 CPU 的「非法指令」现象与成因");
    check(/SELinux/.test(g) && /:Z/.test(g), "指南说明 SELinux 环境挂载需加 :Z");
    check(/--platform/.test(g), "指南提醒 x86 无需加 --platform");
  }

  const readme = readText(path.join(ROOT, "README.md"));
  check(/x86_64/.test(readme), "README 说明 x86_64 为原生支持");
  check(/i386|32 位/.test(readme), "README 说明 32 位 x86 没有对应镜像");
} catch (e) {
  bad("文档/镜像契约检查异常", e && e.message ? e.message : String(e));
}

/* ---------------- F. 指南文档结构 ---------------- */

section("F. 指南文档结构（目录锚点必须真实存在）");
try {
  const guide = path.join(ROOT, "docs", "image-deploy-guide.html");
  if (!fs.existsSync(guide)) {
    bad("指南文件存在（缺失则无法检查结构）");
  } else {
    const html = readText(guide);
    const h2ids = [];
    const h2re = /<h2\s+id="([^"]+)"/g;
    let m;
    while ((m = h2re.exec(html))) h2ids.push(m[1]);

    const allH2 = (html.match(/<h2[\s>]/g) || []).length;
    check(allH2 > 0 && allH2 === h2ids.length,
      "每个 h2 都带 id（没有 id 的标题会让目录点不过去）",
      "h2 共 " + allH2 + " 个，带 id 的 " + h2ids.length + " 个");

    const tocHrefs = [];
    const tocBlock = (html.match(/<div class="toc">[\s\S]*?<\/ol>/) || [""])[0];
    const are = /href="#([^"]+)"/g;
    while ((m = are.exec(tocBlock))) tocHrefs.push(m[1]);

    check(tocHrefs.length === h2ids.length,
      "目录条目数与正文章节数一致", tocHrefs.length + " vs " + h2ids.length);

    const dangling = tocHrefs.filter((h) => h2ids.indexOf(h) < 0);
    check(dangling.length === 0,
      "目录里没有指向不存在锚点的链接", dangling.length ? "悬空锚点：" + dangling.join(", ") : "0 个");

    const unused = h2ids.filter((h) => tocHrefs.indexOf(h) < 0);
    check(unused.length === 0,
      "没有章节漏进目录", unused.length ? "未收录：" + unused.join(", ") : "0 个");

    check(!/<!--\s*##PART\d+##\s*-->/.test(html),
      "没有残留的占位注释（写完长文档最容易漏）");
    check(/<\/html>\s*$/.test(html), "HTML 正常闭合");
  }
} catch (e) {
  bad("指南文档结构检查异常", e && e.message ? e.message : String(e));
}

console.log("");
console.log("结果：" + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
