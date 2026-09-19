#!/usr/bin/env node
/**
 * Navi · 一键发布到 GitHub
 *
 * 流程：暂存 → 安全预检（硬闸门）→ 配提交身份 → 提交 → 配 remote → 建仓 → 推送。
 *
 * 用法（两种来源，环境变量优先；敏感值不进 argv、不进任何被跟踪的文件）：
 *
 *   方式一（推荐）：写进项目根目录的 .env —— 令牌不会出现在命令行与终端历史里
 *     GH_USER=你的GitHub用户名
 *     GH_EMAIL=你的邮箱
 *     GH_TOKEN=github_pat_xxx
 *     node scripts/publish-github.cjs
 *
 *   方式二：临时用环境变量覆盖
 *     GH_USER=xxx GH_EMAIL=xxx GH_TOKEN=xxx node scripts/publish-github.cjs
 *
 *   可选 GH_REPO（默认 navi-homepage）、GH_VISIBILITY（public|private，默认 public）
 *   可选 GH_NAME（提交记录里的显示名，默认取 GH_USER）
 *   可选 GH_TRANSPORT=ssh|https（默认按现有 origin 形态自动判断）
 *     · https 需要 GH_TOKEN；
 *     · ssh 用密钥即可，不需要令牌 —— 本机所在网络下 github.com 主站连不通，
 *       已在 ~/.ssh/config 把 github.com 映射到 ssh.github.com:443（GitHub 官方备用入口）。
 *
 *   # 只做本地提交与 remote 配置，不推送（想自己推时用）
 *   GH_USER=xxx GH_EMAIL=xxx node scripts/publish-github.cjs --no-push
 *
 *   # 先空跑一遍看会做什么（不提交、不推送、不改 remote；仍会执行 git add —— 否则预检看不到内容）
 *   GH_USER=xxx GH_EMAIL=xxx GH_TOKEN=xxx node scripts/publish-github.cjs --dry-run
 *
 *   # 远程已有「无关历史」导致 non-fast-forward 时，用它覆盖（会改写远程分支历史，先确认清楚）
 *   node scripts/publish-github.cjs --force
 *
 * 安全设计：
 *  1. 推送前**强制**跑 scripts/git-preflight.cjs，未通过则直接中止 —— 密钥一旦进历史很难清；
 *  2. 令牌**不写进 .git/config**（remote 里存的是干净 URL），也**不出现在命令行参数**里：
 *     用 git 的 credential.helper 内联函数从环境变量读取，git 的 sh 自行展开；
 *  3. 全程不把令牌打印出来；出错信息里也会替换成 ***。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;

const args = process.argv.slice(2);
const NO_PUSH = args.includes("--no-push");
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

const BRANCH = "main";

/* ---------------- 凭据来源：环境变量优先，其次本机 .env ---------------- */
/*
 * 令牌绝不经过聊天窗口、不进命令行参数、不落 .git/config：
 * 把它写进项目根目录的 .env 即可（该文件已被 .gitignore 排除，也不会被 compose 注入容器）。
 */

function loadDotEnv() {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {
    /* 没有 .env 就用环境变量，属于正常情况 */
  }
  return out;
}

const DOTENV = loadDotEnv();
const FROM_DOTENV = [];

function pick(name, fallback) {
  const env = (process.env[name] || "").trim();
  if (env) return env;
  const file = (DOTENV[name] || "").trim();
  if (file) {
    FROM_DOTENV.push(name);
    return file;
  }
  return (fallback || "").trim();
}

const USER = pick("GH_USER");
const REPO = pick("GH_REPO", "navi-homepage");
const EMAIL = pick("GH_EMAIL");
const NAME = pick("GH_NAME", USER);
const TOKEN = pick("GH_TOKEN");
const VISIBILITY = pick("GH_VISIBILITY", "public").toLowerCase();

/* ---------------- 基础工具 ---------------- */

function findGit() {
  const candidates = [
    process.env.GIT_BIN,
    "git",
    "C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch (e) { /* 下一个 */ }
  }
  return null;
}

const GIT = findGit();
if (!GIT) {
  console.error("❌ 找不到 git。可设 GIT_BIN=<git.exe 完整路径> 后重试。");
  process.exit(2);
}

function git(a, opts) {
  return execFileSync(GIT, a, Object.assign({ cwd: ROOT, encoding: "utf8" }, opts || {}));
}

function gitOk(a) {
  const r = spawnSync(GIT, a, { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function die(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

function step(n, t) {
  console.log("");
  console.log("【" + n + "】" + t);
}

/* ---------------- 强推保护 ---------------- */
/*
 * --force 时不用裸 `--force`，改用 `--force-with-lease=<ref>:<已知提交>`：
 * 只有远程仍停在「我们上次看到的那一个提交」时才允许覆盖，
 * 若期间别处推了新东西（另一台机器 / GitHub 网页操作），推送会被拒绝而不是悄悄覆盖。
 *
 * 已知值来源依次为：远程跟踪引用 → FETCH_HEAD（最近一次 fetch 的结果）。
 * 本机实测存在「fetch 报告创建了 origin/main，但引用并未落盘」的情况，
 * 所以两个来源都要试；都拿不到就退化为普通 --force 并明确提示。
 */

function leaseArg() {
  if (!FORCE) return [];
  for (const ref of ["refs/remotes/origin/" + BRANCH, "FETCH_HEAD"]) {
    const r = gitOk(["rev-parse", "--verify", ref]);
    if (r.code !== 0) continue;
    const sha = r.out.trim().split(/\s+/).pop();
    if (/^[0-9a-f]{40}$/.test(sha)) {
      console.log("   · 强推保护：仅当远程 " + BRANCH + " 仍是 " + sha.slice(0, 7) + " 时才覆盖");
      return ["--force-with-lease=refs/heads/" + BRANCH + ":" + sha];
    }
  }
  console.log("   ⚠️  无法确定远程当前提交，退化为普通 --force（建议先跑 git fetch origin）");
  return ["--force"];
}

/* ---------------- 传输方式：https（令牌）或 ssh（密钥） ---------------- */
/*
 * 本机所在网络下 github.com:443 连不通，但 api.github.com 与 ssh.github.com 正常
 * → 走 SSH over 443（配置见 ~/.ssh/config）。
 * 判定顺序：GH_TRANSPORT → 现有 origin 的形态（git@ / ssh:// 即视为 ssh）。
 */

const EXISTING_ORIGIN = (() => {
  const r = gitOk(["remote", "get-url", "origin"]);
  return r.code === 0 ? r.out.trim() : "";
})();

const TRANSPORT = (
  process.env.GH_TRANSPORT || DOTENV.GH_TRANSPORT ||
  (/^(git@|ssh:\/\/)/.test(EXISTING_ORIGIN) ? "ssh" : "https")
).trim().toLowerCase();

const USE_SSH = TRANSPORT === "ssh";

/* ---------------- 参数校验 ---------------- */

if (!USER) {
  console.error("❌ 缺少 GH_USER（你的 GitHub 用户名）。");
  console.error("   例：GH_USER=octocat GH_EMAIL=you@example.com node scripts/publish-github.cjs");
  process.exit(2);
}
if (!EMAIL) {
  console.error("❌ 缺少 GH_EMAIL（提交记录里的邮箱）。");
  console.error("   隐私做法：用 GitHub 提供的 noreply 邮箱，形如 " + USER + "@users.noreply.github.com");
  process.exit(2);
}

console.log("仓库：" + ROOT);
if (FROM_DOTENV.length) {
  console.log("凭据来源：本机 .env（" + FROM_DOTENV.join("、") + "）—— 该文件已被 .gitignore 排除，不会入库");
}
console.log("目标：github.com/" + USER + "/" + REPO + "（" + VISIBILITY + "）");
console.log("传输：" + (USE_SSH ? "SSH（密钥；github.com 实际连到 ssh.github.com:443）" : "HTTPS（访问令牌）"));
console.log("模式：" + (NO_PUSH
  ? "只做本地提交与 remote 配置"
  : (USE_SSH || TOKEN ? "提交 + 建仓 + 推送" : "提交 + 配 remote（未提供令牌，不推送）")));

/* ---------------- 1. 暂存改动 ---------------- */
/*
 * 必须在预检**之前**：预检扫描的是「已暂存的文件」，也就是即将进入仓库的内容。
 * 顺序颠倒会出现假故障：刚提交完再跑一次 → 暂存区是空的 → 预检无事可查（退出码 2）→ 整体中止。
 */

step(1, "暂存改动");
git(["add", "-A"]);

const staged = git(["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);
const hasCommit = gitOk(["rev-parse", "--verify", "HEAD"]).code === 0;
console.log("   " + staged.length + " 个文件待提交" + (staged.length ? "" : "（工作区没有新改动）"));

/* ---------------- 2. 安全预检（硬闸门） ---------------- */

step(2, "安全预检（密钥扫描）");
if (!staged.length) {
  // 没有新内容要进仓库，就没有可预检的对象（已在历史里的内容在当初提交时已过闸）
  console.log("   · 本次无新文件进入仓库，跳过预检");
} else {
  const pf = spawnSync(NODE, [path.join(ROOT, "scripts", "git-preflight.cjs")], {
    cwd: ROOT, encoding: "utf8",
  });
  process.stdout.write(pf.stdout || "");
  if (pf.status !== 0) {
    console.error("");
    console.error("🚫 预检未通过（退出码 " + pf.status + "），已中止。");
    console.error("   先把上面 ❌ 的问题处理掉 —— 密钥进了历史之后清理成本极高。");
    process.exit(1);
  }
}

/* ---------------- 3. 提交身份 ---------------- */

step(3, "配置提交身份（仅本仓库，不动你的全局配置）");
git(["config", "--local", "user.name", NAME]);
git(["config", "--local", "user.email", EMAIL]);
console.log("   user.name  = " + NAME);
console.log("   user.email = " + EMAIL);

/* ---------------- 4. 创建提交 ---------------- */

step(4, "创建提交");

const commitMsg = hasCommit
  ? "chore: 更新"
  : "chore: 首次提交 —— Navi 导航站（零依赖 Node 服务端 + 服务发现 + 图床库）";

if (DRY_RUN) {
  console.log("   [dry-run] 将提交 " + staged.length + " 个文件");
  console.log("   [dry-run] 提交信息：" + commitMsg);
  console.log("   [dry-run] 提交身份：" + NAME + " <" + EMAIL + ">");
} else if (!staged.length) {
  if (!hasCommit) die("没有任何可提交的内容（工作区是空的？）");
  console.log("   · 无新改动，跳过");
} else {
  git(["commit", "-m", commitMsg]);
  console.log("   ✓ 已提交 " + staged.length + " 个文件");
  console.log("   " + git(["log", "-1", "--pretty=%h %an <%ae> %s"]).trim());
}

/* ---------------- 5. 远程仓库 ---------------- */

step(5, "配置远程仓库 origin");
const webUrl = "https://github.com/" + USER + "/" + REPO;
const cleanUrl = USE_SSH
  ? "git@github.com:" + USER + "/" + REPO + ".git"
  : webUrl + ".git";
const cur = gitOk(["remote", "get-url", "origin"]);
if (DRY_RUN) {
  console.log("   [dry-run] origin 将是 " + cleanUrl);
} else if (cur.code === 0) {
  if (cur.out.trim() !== cleanUrl) {
    git(["remote", "set-url", "origin", cleanUrl]);
    console.log("   · 已更新 origin → " + cleanUrl);
  } else {
    console.log("   · origin 已是 " + cleanUrl);
  }
} else {
  git(["remote", "add", "origin", cleanUrl]);
  console.log("   · 已添加 origin → " + cleanUrl);
}
console.log(USE_SSH
  ? "   （SSH 地址不含任何密钥，私钥只留在本机 ~/.ssh/ 下）"
  : "   （remote 里存的是不含令牌的干净地址，令牌不会被写进 .git/config）");

// SSH 模式：把 git 要用的 ssh 可执行文件固定下来。
// 便携版 git 不在 PATH 里，自己找不到 ssh，不写这一条会报 "cannot run ssh"。
if (USE_SSH && !DRY_RUN) {
  const hasSshCmd = gitOk(["config", "--local", "--get", "core.sshCommand"]).code === 0;
  if (!hasSshCmd) {
    const gitDir = path.dirname(GIT);                       // …/cmd
    const cand = [
      path.join(gitDir, "..", "usr", "bin", "ssh.exe"),     // 便携版自带
      path.join(gitDir, "..", "usr", "bin", "ssh"),
      "ssh",                                                // 退化到 PATH
    ].map(function (p) { return p.replace(/\\/g, "/"); });
    const found = cand.find(function (p) {
      if (p === "ssh") return true;                          // 交给 PATH 解析
      try { return fs.statSync(p).isFile(); } catch (e) { return false; }
    });
    if (found) {
      git(["config", "--local", "core.sshCommand", found]);
      console.log("   · 已固定 core.sshCommand → " + found);
    }
  } else {
    console.log("   · core.sshCommand 已配置：" +
      git(["config", "--local", "--get", "core.sshCommand"]).trim());
  }
}

if (NO_PUSH) {
  console.log("");
  console.log("✅ 本地已完成。想推送时去掉 --no-push 重跑。");
  process.exit(0);
}
if (!USE_SSH && !TOKEN) {
  console.log("");
  console.log("⚠️  未提供 GH_TOKEN，跳过建仓与推送（本地提交已完成）。");
  console.log("   拿到令牌后二选一：");
  console.log("     · 推荐：在项目根目录 .env 里加一行  GH_TOKEN=你的令牌  再重跑本脚本");
  console.log("     · 或临时：GH_TOKEN=你的令牌 node scripts/publish-github.cjs");
  console.log("   若本机网络连不上 github.com 主站，改用 SSH：GH_TRANSPORT=ssh node scripts/publish-github.cjs");
  process.exit(0);
}

/* ---------------- 6. 建仓（REST API，已存在则跳过） ---------------- */

step(6, "在 GitHub 上创建仓库");
let created = false;
const apiBody = JSON.stringify({
  name: REPO,
  private: VISIBILITY !== "public",
  description: "零依赖 Node 导航站：自动端口识别、图标匹配、本地图床库，支持 Docker / 飞牛 fnOS 部署",
  has_issues: true,
  has_wiki: false,
  auto_init: false,
});

try {
  if (DRY_RUN) { throw new Error("__dryrun_skip__"); }   // 空跑时不打真实请求
  if (!TOKEN) throw new Error("__skip_no_token__");
  const res = execFileSync("curl", [
    "-sS", "-o", "-", "-w", "\n%{http_code}",
    "-X", "POST", "https://api.github.com/user/repos",
    "-H", "Authorization: Bearer " + TOKEN,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
    "-H", "Content-Type: application/json",
    "--data-binary", apiBody,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const nl = res.lastIndexOf("\n");
  const code = res.slice(nl + 1).trim();
  const body = res.slice(0, nl);
  if (code === "201") {
    created = true;
    console.log("   ✓ 仓库已创建：" + cleanUrl);
  } else if (code === "422" && /already exists/i.test(body)) {
    console.log("   · 仓库已存在，直接复用：" + cleanUrl);
  } else {
    console.log("   ⚠️  建仓接口返回 " + code + "（不致命，继续尝试推送）");
    const m = body.match(/"message"\s*:\s*"([^"]+)"/);
    if (m) console.log("      原因：" + maskSecret(m[1]));
  }
} catch (e) {
  if (String(e.message).includes("__skip_no_token__")) {
    console.log("   · 未提供令牌，跳过建仓接口（要求仓库已存在）");
    console.log("     若还没建：打开 https://github.com/new 建一个名为 " + REPO + " 的空仓库（**不要**勾选 README）");
  } else if (String(e.message).includes("__dryrun_skip__")) {
    console.log("   [dry-run] 将调用 GitHub API 创建 " + VISIBILITY + " 仓库：" + USER + "/" + REPO);
  } else {
    console.log("   ⚠️  调不通 GitHub API（" + String(e.message).split("\n")[0] + "）");
    console.log("      如果你是先在网页上手动建好仓库的，这不算问题，继续推送即可。");
  }
}

/* ---------------- 7. 推送 ---------------- */

step(7, "推送到 GitHub");
// 令牌通过环境变量交给 git 的 sh 展开 —— 不出现在 argv，也不落盘
const helper = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
const lease = leaseArg();
const pushArgs = (USE_SSH ? [] : ["-c", "credential.helper=", "-c", "credential.helper=" + helper])
  .concat(["push"], lease, ["-u", "origin", "HEAD:" + BRANCH]);
if (DRY_RUN) {
  console.log("   [dry-run] 将执行：git " + pushArgs.join(" "));
  if (USE_SSH) console.log("   [dry-run] 走 SSH，使用 ~/.ssh 下的密钥，不需要令牌");
  else console.log("   [dry-run] 令牌长度 " + TOKEN.length + " 字符，仅经环境变量传递");
  console.log("");
  console.log("✅ dry-run 结束，未做任何提交 / 推送。");
  process.exit(0);
}
console.log(USE_SSH
  ? "   $ git push" + (FORCE ? " --force-with-lease" : "") + " -u origin HEAD:" + BRANCH + "   （SSH，无需令牌）"
  : "   $ git -c credential.helper= -c credential.helper='!f(){...}' push" + (FORCE ? " --force-with-lease" : "") + " -u origin HEAD:" + BRANCH);
const pr = spawnSync(GIT, pushArgs, {
  cwd: ROOT,
  encoding: "utf8",
  env: Object.assign({}, process.env, {
    GH_TOKEN: TOKEN,
    GIT_TERMINAL_PROMPT: "0",   // 非交互环境：宁可报错也不要挂住等输入
  }),
});
const out = (pr.stdout || "") + (pr.stderr || "");
console.log(out.trim().split(/\r?\n/).map((l) => "   " + maskSecret(l)).join("\n"));

if (pr.status !== 0) {
  console.error("");
  console.error("❌ 推送失败（退出码 " + pr.status + "）。常见原因：");
  if (USE_SSH) {
    console.error("   · 公钥还没登记到 GitHub → 打开 https://github.com/settings/ssh/new 添加");
    console.error("   · 验证连通性：ssh -T git@github.com（成功应回 “Hi 用户名! You've successfully authenticated”）");
    console.error("   · 远端已有无关历史 → 报 non-fast-forward；确认后可用 node scripts/publish-github.cjs --force 覆盖");
    console.error("   · 仓库名或用户名拼错 → 检查 GH_USER / GH_REPO");
  } else {
    console.error("   · 令牌无效 / 已过期 → 重新生成，勾选 Contents: Read and write");
    console.error("   · 令牌没勾对该仓库的权限（fine-grained 令牌必须把本仓库加进 Repository access）");
    console.error("   · 远端已有无关历史 → 报 non-fast-forward；确认后可用 node scripts/publish-github.cjs --force 覆盖");
    console.error("   · 仓库名或用户名拼错 → 检查 GH_USER / GH_REPO");
    console.error("   · 网络不通 → 试试能否打开 https://github.com；若连不上主站请改用 GH_TRANSPORT=ssh");
  }
  process.exit(1);
}

/* ---------------- 修补远程跟踪引用 ---------------- */

// 本机环境的 git 有个怪癖：push -u 之后 branch.<name>.remote 写进去了，
// 但 .git/refs/remotes/origin/ 这个目录和里面的 ref 文件没落盘，
// 于是 git status 一直显示 [gone]，像是分支"跟丢了"。
// 手动先建目录、再直接写文件就正常，所以这里补一刀。
{
  const refName = "refs/remotes/origin/" + BRANCH;
  const resolved = gitOk(["rev-parse", "--verify", refName]);
  if (resolved.code !== 0) {
    try {
      const sha = git(["rev-parse", "HEAD"]).trim();
      const refPath = path.join(ROOT, ".git", "refs", "remotes", "origin", BRANCH);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });   // ← 关键就是这一步
      fs.writeFileSync(refPath, sha + "\n");
      const back = gitOk(["rev-parse", "--verify", refName]);
      if (back.code === 0) {
        console.log("   · 已补写远程跟踪引用 " + refName + "（否则 status 会显示 [gone]）");
      }
    } catch (e) {
      console.log("   · 远程跟踪引用修补失败（不影响推送本身）：" + String(e.message).split("\n")[0]);
    }
  }
}

/* ---------------- 完成 ---------------- */

console.log("");
console.log("==================================================");
console.log("✅ 发布完成");
console.log("   仓库地址：" + webUrl);
console.log("   可见性  ：" + VISIBILITY);
if (created) console.log("   刚创建，GitHub 生成 README 预览可能需要几秒");
console.log("");
console.log("下一步（可选）：");
console.log("   · 把仓库地址补进 README 的「相关链接」");
console.log("   · Settings → 打开 Issues / 设置 Topics 便于他人发现");
console.log("   · 再去飞牛上重建镜像不会受影响（Docker 不读 GitHub）");
console.log("==================================================");

/* 兜底：万一 git 把账号信息回显出来，也替换掉 */
function maskSecret(text) {
  if (!TOKEN) return text;
  let s = text;
  s = s.split(TOKEN).join("***");
  s = s.split(encodeURIComponent(TOKEN)).join("***");
  const b64 = Buffer.from(TOKEN, "utf8").toString("base64");
  s = s.split(b64).join("***");
  return s;
}
