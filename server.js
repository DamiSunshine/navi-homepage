/* ============================================================
   Navi 个人导航站 · 零依赖后端服务
   - 静态文件托管（public/）
   - GET  /api/config  读取导航配置（支持环境变量覆盖站点标题）
   - PUT  /api/config  写回导航配置（前端编辑模式保存）
   - GET  /api/backup  导出结构化备份包（含 SHA-256 校验和，附件下载）
   - POST /api/backup/restore  校验并恢复备份（格式/版本/完整性/结构）
   - POST /api/upload  上传本地 logo 图片（base64，落盘 public/uploads）
   - GET  /api/library 列出本地图床库全部图片（含被引用情况）与在线图标预设
   - POST /api/library/upload  批量上传图标到本地图床库（逐张独立校验，允许部分成功）
   - POST /api/library/delete  从图床库删除图片（默认拒绝删除仍被卡片引用的图片）
   - GET  /api/discover  服务发现：自动识别 Docker 容器 / 本机监听端口，
                         按服务类型匹配图标，输出可直接生成导航卡片的候选条目
                         依赖见下方「服务发现」配置区；不可用时返回明确原因
   - POST /api/login   密码登录（签发 HMAC 会话 Cookie）
   - POST /api/logout  退出登录（吊销会话）
   - GET  /api/auth/status  认证状态查询
   - IPv4 / IPv6 双栈监听（绑定 ::）

   访问控制：
   - 设置环境变量 NAVI_PASSWORD（明文，仅存在服务器环境）或
     NAVI_PASSWORD_HASH（sha256 十六进制，更推荐）后启用密码保护
   - 未设置密码时站点开放访问（本地开发模式）
   - 启用后：除 /login.html 与 /api/login 外，所有页面与静态资源
     一律校验会话；未认证页面请求 302 跳登录页，API 请求返回 401
   仅使用 Node.js 内置模块，无需 npm install
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const discovery = require("./discovery");

const PORT = parseInt(process.env.PORT || "80", 10);
const HOST = process.env.HOST || "::"; // :: 同时接受 IPv4 与 IPv6（dual-stack）
const ROOT = path.join(__dirname, "public");
const CONFIG_PATH = process.env.NAVI_CONFIG_PATH || path.join(ROOT, "config.json");
const MAX_BODY = 1024 * 1024; // 1MB（普通 API）
const MAX_UPLOAD_BODY = 5 * 1024 * 1024; // 5MB（图片上传）
const MAX_LIBRARY_BODY = 16 * 1024 * 1024; // 16MB（图床库批量上传：单图上限 3MB，前端按体积分片，此值留 4 张余量）
const LIBRARY_MAX_FILES = 20; // 单次请求最多接收的图片张数（前端分片时亦以此为界）
const LIBRARY_MAX_SIZE = 3 * 1024 * 1024; // 单张图片体积上限 3MB（与 /api/upload 保持一致）
const LIBRARY_IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1 }; // 图床库允许的扩展名（删除接口白名单）
const LIBRARY_MAX_LIST = 2000; // 列表接口单次最多返回的图片数（超出置 truncated=true，避免超大目录拖慢接口）
const UPLOAD_DIR = process.env.NAVI_UPLOAD_DIR || path.join(ROOT, "uploads");
const BACKUP_FORMAT = "navi-backup";
const BACKUP_VERSION = 1;
const APP_VERSION = "1.0.0";

/* ---------- 服务发现配置（环境变量驱动，均有合理默认） ----------
   Docker 接入二选一：
     - 挂载 /var/run/docker.sock（推荐，本机 Docker）→ DOCKER_SOCKET
     - 远程 Docker API（TCP）→ DOCKER_HOST_NAME / DOCKER_HOST_PORT
   地址推断：
     - NAVI_LAN_HOST 内网 IP 或主机名（不设则自动探测 / 取请求 Host）
     - NAVI_WAN_HOST 公网域名或 IP（不设则不生成外网地址，用内网地址兜底）
   其余：
     - NAVI_ICON_PROBE=0 关闭图标在线探测（离线环境建议关闭）
     - NAVI_DISCOVER_TIMEOUT 单次 Docker API 超时毫秒（默认 2500） */
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "";
const DOCKER_HOST_PORT = parseInt(process.env.DOCKER_HOST_PORT || "2375", 10);
const DISCOVER_TIMEOUT = parseInt(process.env.NAVI_DISCOVER_TIMEOUT || "2500", 10);
const ICON_PROBE_ENABLED = process.env.NAVI_ICON_PROBE !== "0";
const LAN_HOST_ENV = process.env.NAVI_LAN_HOST || "";
const WAN_HOST_ENV = process.env.NAVI_WAN_HOST || "";
// 本机端口扫描总开关（容器内通常无意义，Docker 可用时也建议保留以便发现宿主机服务）
const SCAN_LOCAL_ENABLED = process.env.NAVI_SCAN_LOCAL !== "0";

// 启动时确保上传目录存在（logo 图片存储于此，可由 /uploads/* 直接访问）
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

/* ---------- 认证配置（环境变量，不硬编码） ---------- */
const AUTH_USERNAME = process.env.NAVI_USERNAME || "";           // 登录用户名（非机密，存于环境变量）
const AUTH_PASSWORD = process.env.NAVI_PASSWORD || "";           // 明文密码（仅存于服务器环境变量）
const AUTH_PASSWORD_HASH = process.env.NAVI_PASSWORD_HASH || ""; // 或直接给 sha256 哈希
const SESSION_TTL_HOURS = parseFloat(process.env.SESSION_TTL_HOURS || "72"); // 会话有效期，默认 72 小时
// 启用认证需要密码；NAVI_USERNAME 为可选维度：设置后登录必须同时提供正确用户名+密码
const AUTH_ENABLED = !!(AUTH_PASSWORD || AUTH_PASSWORD_HASH);
const REQUIRE_USERNAME = !!AUTH_USERNAME;
const COOKIE_NAME = "navi_session";

// 会话签名密钥：每次启动随机生成（重启后旧会话全部失效，更安全）
const SESSION_SECRET = crypto.randomBytes(32);
// 已吊销的令牌（登出后立即失效）
const revokedTokens = new Set();
// 登录失败限流：IP -> { fails, lockedUntil }
const loginAttempts = new Map();
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

/* ---------- 密码与会话 ---------- */
function hashPassword(pw) {
  // 加固定盐后 sha256，避免裸哈希被彩虹表命中
  return crypto.createHash("sha256").update("navi-site:" + String(pw)).digest("hex");
}

function verifyPassword(pw) {
  const expected = AUTH_PASSWORD_HASH || (AUTH_PASSWORD ? hashPassword(AUTH_PASSWORD) : "");
  const a = Buffer.from(hashPassword(pw));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b); // 恒时比较，防时序侧信道
}

function signToken() {
  const exp = Date.now() + SESSION_TTL_HOURS * 3600 * 1000;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(String(exp)).digest("hex");
  return exp + "." + sig;
}

function verifyUsername(u) {
  // 未配置用户名维度时视为通过（兼容"仅密码"老部署）
  if (!AUTH_USERNAME) return true;
  const a = Buffer.from(String(u == null ? "" : u));
  const b = Buffer.from(AUTH_USERNAME);
  // 先比长度避免 timingSafeEqual 因长度不等抛错
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || revokedTokens.has(token)) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expectSig = crypto.createHmac("sha256", SESSION_SECRET).update(exp).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expectSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(function (pair) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const token = parseCookies(req)[COOKIE_NAME];
  return verifyToken(token);
}

function buildSessionCookie(req, token) {
  const parts = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",                                  // 禁止 JS 读取，防 XSS 窃取
    "SameSite=Lax",                              // 防 CSRF 跨站携带
    "Max-Age=" + Math.max(0, Math.floor(SESSION_TTL_HOURS * 3600))
  ];
  // HTTPS 部署（含反代终止 TLS）时加 Secure，避免明文信道传输
  const proto = req.headers["x-forwarded-proto"];
  if (req.socket.encrypted || proto === "https") parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie() {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/* ---------- 登录限流 ---------- */
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function loginLocked(ip) {
  const rec = loginAttempts.get(ip);
  return !!(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.fails = 0;
  }
  loginAttempts.set(ip, rec);
}

function clearLoginFail(ip) { loginAttempts.delete(ip); }

/* ---------- 工具 ---------- */
function send(res, status, body, headers) {
  const h = Object.assign({ "Cache-Control": "no-cache" }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-cache" });
  res.end();
}

function readBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ---------- 配置读写 ---------- */
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  cfg.site = cfg.site || {};
  if (process.env.SITE_TITLE) cfg.site.title = process.env.SITE_TITLE;
  if (process.env.SITE_SUBTITLE) cfg.site.subtitle = process.env.SITE_SUBTITLE;
  return cfg;
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return "配置必须是 JSON 对象";
  if (!Array.isArray(cfg.groups)) return "缺少 groups 数组";
  for (const g of cfg.groups) {
    if (!g || typeof g.name !== "string" || !g.name.trim()) return "每个分组必须有 name";
    if (!Array.isArray(g.items)) return "分组 " + g.name + " 缺少 items 数组";
    for (const it of g.items) {
      if (!it || typeof it.title !== "string" || !it.title.trim()) return "每个导航项必须有 title";
      if (typeof it.url !== "string" || !/^https?:\/\//i.test(it.url)) {
        return "导航项「" + (it.title || "?") + "」的 url 必须以 http(s):// 开头";
      }
      if (it.lanUrl && !/^https?:\/\//i.test(it.lanUrl)) {
        return "导航项「" + it.title + "」的 lanUrl 必须以 http(s):// 开头";
      }
    }
  }
  return null;
}

// 原子写：先写临时文件再 rename（同一目录内原子替换，避免写出半截文件）。
// 但当 config 走“单文件 bind mount”（如 docker -v /host/a.json:/app/a.json）时，
// rename 会跨挂载点触发 EBUSY/EXDEV 失败。此时降级为直接写目标文件（并非安全
// 的前提已经过完整校验，降级仅牺牲一点原子性，换取保存可用性）。
function saveConfigAtomic(cfg) {
  const data = JSON.stringify(cfg, null, 2) + "\n";
  const tmp = CONFIG_PATH + ".tmp";
  try {
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, CONFIG_PATH);
    return { ok: true, mode: "atomic" };
  } catch (e) {
    const code = e && e.code;
    // 仅对“跨设备/占用”类错误降级；真实磁盘写入错误仍抛出，交由上层报告
    if (code === "EBUSY" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
      try {
        fs.unlinkSync(tmp);           // 清掉残留临时文件
        fs.writeFileSync(CONFIG_PATH, data, "utf-8");
        return { ok: true, mode: "direct" };
      } catch (e2) {
        const err = new Error((e2 && e2.message ? e2.message : e2) + " (atomic: " + (e && e.message) + ")");
        err.code = e2 && e2.code;
        throw err;
      }
    }
    throw e;
  }
}

/* ---------- 备份 / 恢复 / 上传 ---------- */
// 通过文件头魔数识别真实图片类型，防止伪造的 data URL
function detectImageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "png";
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
}

/* ---------- 图床库（本地图标库） ----------
   设计要点：不引入数据库，也不维护索引文件——图床库的「目录」直接由上传目录的文件系统
   推导（文件名 / 体积 / 修改时间），因此库内容永远与磁盘一致，不会出现索引与文件不同步，
   也不会给既有的备份 / 恢复流程增加新的状态。
   卡片侧通过 item.logo = "/uploads/<name>" 引用库中图片，前端 resolveLogo() 优先于 icon。 */

// 把「原始文件名」清洗成安全 slug：小写、只保留 [a-z0-9]、其余转连字符并截断。
// 作用有二：让库内文件名可读可搜索；同时从源头杜绝 ../ 等路径穿越字符。
function slugifyName(name) {
  return String(name || "")
    .replace(/\.[a-z0-9]+$/i, "")            // 去掉扩展名（最终扩展名由真实图片类型决定）
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// 在上传目录内生成不冲突的文件名。
// 带 nameHint（批量上传时传原始文件名）→ "github-3f9a2b11.png"，便于在图床库里辨认；
// 不带 nameHint → 纯随机名，与既有 /api/upload 命名保持一致（向后兼容）。
function uniqueFileName(ext, nameHint) {
  const slug = slugifyName(nameHint);
  if (!slug) return crypto.randomBytes(12).toString("hex") + "." + ext;
  for (let i = 0; i < 5; i++) {
    const fname = slug + "-" + crypto.randomBytes(4).toString("hex") + "." + ext;
    if (!fs.existsSync(path.join(UPLOAD_DIR, fname))) return fname;
  }
  return crypto.randomBytes(12).toString("hex") + "." + ext;
}

// 单张图片的统一落盘入口：解析 data URL → 真实类型校验 → 体积校验 → 写入上传目录。
// 返回 { ok:true, url, name } 或 { ok:false, error }，供 /api/upload 与批量上传共用，
// 保证两条链路的校验强度完全一致。
function saveImageDataUrl(dataUrl, nameHint) {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!m) return { ok: false, error: "仅支持 PNG / JPEG / GIF / WebP 图片（data URL）" };
  const imgType = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
  let buf;
  try { buf = Buffer.from(m[2], "base64"); }
  catch (e) { return { ok: false, error: "图片数据解码失败" }; }
  if (buf.length === 0) return { ok: false, error: "图片内容为空" };
  const realType = detectImageType(buf);
  if (!realType || realType !== imgType) {
    return { ok: false, error: "图片文件头校验失败（实际类型与声明不符）" };
  }
  if (buf.length > LIBRARY_MAX_SIZE) return { ok: false, error: "图片过大（上限 3MB）" };
  const ext = realType === "jpeg" ? "jpg" : realType;
  const fname = uniqueFileName(ext, nameHint);
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  } catch (e) {
    return { ok: false, error: "图片保存失败：" + (e && e.message ? e.message : e) };
  }
  return { ok: true, url: "/uploads/" + fname, name: fname };
}

// 读取图床库：扫描上传目录并按修改时间倒序返回，同时标注每张图的「被引用情况」。
// cfg 可为 null（配置读取失败时仍应能列出图床库，只是没有引用统计）。
function listLibrary(cfg) {
  let names;
  try { names = fs.readdirSync(UPLOAD_DIR); }
  catch (e) { return { ok: false, error: "无法读取上传目录：" + (e && e.message ? e.message : e) }; }

  const usage = {};
  const scan = (groups) => {
    (groups || []).forEach((g) => (g.items || []).forEach((it) => {
      const logo = it && typeof it.logo === "string" ? it.logo : "";
      const hit = /^\/uploads\/(.+)$/.exec(logo);
      if (!hit) return;
      const key = hit[1];
      if (!usage[key]) usage[key] = [];
      usage[key].push(it.title || "(未命名)");
    }));
  };
  if (cfg) scan(cfg.groups);

  const images = [];
  let totalBytes = 0;
  let truncated = false;
  for (const name of names) {
    if (images.length >= LIBRARY_MAX_LIST) { truncated = true; break; }
    if (path.basename(name) !== name) continue;                 // 防御性：目录项必定是纯文件名
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!LIBRARY_IMAGE_EXT[ext]) continue;                      // 只列图片，忽略 .tmp 等残留文件
    let st;
    try { st = fs.statSync(path.join(UPLOAD_DIR, name)); } catch (e) { continue; }
    if (!st.isFile()) continue;
    totalBytes += st.size;
    images.push({
      name: name,
      url: "/uploads/" + name,
      size: st.size,
      ext: ext,
      mtime: st.mtimeMs,
      used: !!usage[name],
      usedBy: usage[name] || []
    });
  }
  images.sort((a, b) => b.mtime - a.mtime);

  return { ok: true, dir: UPLOAD_DIR, count: images.length, totalBytes: totalBytes, truncated: truncated, images: images };
}

// 「在线图标库」标签页的推荐列表：复用服务发现的内置服务指纹库（33 个常见自托管服务），
// 完全本地、离线可用；真正的在线搜索由前端直连 Iconify 搜索 API 完成。
function libraryIconPresets() {
  return (discovery.SERVICE_PRESETS || []).map((p) => ({
    name: p.name, icon: p.icon, desc: p.desc || "", infra: !!p.infra
  }));
}

// 生成结构化备份包：将配置序列化后计算 SHA-256 嵌入，供导入时校验完整性
function buildBackup(cfg) {
  const payload = JSON.stringify(cfg);
  const checksum = crypto.createHash("sha256").update(payload).digest("hex");
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    config: cfg,
    checksum: checksum
  };
}

// 校验备份文件：依次校验 格式 / 版本 / 完整性(校验和) / 结构。返回 { ok, config?, error? }
function verifyBackup(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "文件格式错误（不是合法 JSON 对象）" };
  }
  if (body.format !== BACKUP_FORMAT) {
    return { ok: false, error: "文件格式不匹配（不是 Navi 备份文件）" };
  }
  if (typeof body.version !== "number" || body.version > BACKUP_VERSION) {
    return { ok: false, error: "不支持的备份版本（v" + body.version + "）" };
  }
  if (!body.config || typeof body.config !== "object") {
    return { ok: false, error: "备份内容缺少 config 字段" };
  }
  const payload = JSON.stringify(body.config);
  const expect = crypto.createHash("sha256").update(payload).digest("hex");
  if (typeof body.checksum !== "string" || body.checksum.toLowerCase() !== expect) {
    return { ok: false, error: "文件完整性校验失败（数据可能被篡改或损坏）" };
  }
  const err = validateConfig(body.config);
  if (err) return { ok: false, error: "备份配置内容无效：" + err };
  return { ok: true, config: body.config };
}

/* ============================================================
   服务发现（Docker 容器 / 本机监听端口）
   ============================================================ */

// 取请求 Host 中的主机名（去端口、去 IPv6 方括号），用于推断内网 IP
function hostFromRequest(req) {
  var raw = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!raw) return "";
  if (raw.charAt(0) === "[") {                 // 形如 [::1]:8080
    var end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(":")[0];
}

// 内网地址来源优先级：环境变量 NAVI_LAN_HOST > 配置 discovery.lanHost > 请求 Host（须为私网）> 网卡自动探测
function resolveLanHost(req, cfg) {
  if (LAN_HOST_ENV) return LAN_HOST_ENV;
  var fromCfg = cfg && cfg.discovery && cfg.discovery.lanHost;
  if (fromCfg) return String(fromCfg).trim();
  var h = hostFromRequest(req);
  if (h && discovery.isLanHost(h)) return h;
  return discovery.detectLocalIPv4();
}

// 外网地址来源优先级：环境变量 NAVI_WAN_HOST > 配置 discovery.wanHost
function resolveWanHost(cfg) {
  if (WAN_HOST_ENV) return WAN_HOST_ENV;
  var fromCfg = cfg && cfg.discovery && cfg.discovery.wanHost;
  return fromCfg ? String(fromCfg).trim() : "";
}

// 归一化 URL 用于「是否已在导航中」比对（去尾斜杠、去默认端口）
function normalizeUrlKey(url) {
  return String(url || "")
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/:(80|443)$/, "");
}

// 读取发现设置（存于 config.json 的 discovery 字段，随既有保存流程持久化）
function readDiscoverySettings(cfg) {
  var d = (cfg && cfg.discovery) || {};
  return {
    ignored: Array.isArray(d.ignored)
      ? d.ignored.filter(function (x) { return typeof x === "string" && x; })
      : []
  };
}

// GET /api/discover：扫描并返回候选卡片（只读，不写任何配置）
async function handleDiscover(req, res, u) {
  var cfg = {};
  try { cfg = loadConfig(); } catch (e) { /* 配置异常时仍允许发现 */ }

  var settings = readDiscoverySettings(cfg);
  var lanHost = resolveLanHost(req, cfg);
  var wanHost = resolveWanHost(cfg);
  var probeParam = u.searchParams.get("probe");
  var probeIcon = ICON_PROBE_ENABLED && probeParam !== "0";

  var result;
  try {
    result = await discovery.discover({
      lanHost: lanHost,
      wanHost: wanHost,
      probeIcon: probeIcon,
      scanLocal: SCAN_LOCAL_ENABLED,
      iconProbeTimeout: 1200,
      docker: {
        socketPath: DOCKER_SOCKET,
        host: DOCKER_HOST_NAME,
        port: DOCKER_HOST_PORT,
        timeout: DISCOVER_TIMEOUT
      }
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "服务发现失败：" + (e && e.message ? e.message : e) });
    return;
  }

  // 标注「已在导航配置中」，前端据此默认不重复勾选
  var existingUrls = {};
  var existingTitles = {};
  (cfg.groups || []).forEach(function (g) {
    (g.items || []).forEach(function (it) {
      if (it.url) existingUrls[normalizeUrlKey(it.url)] = true;
      if (it.lanUrl) existingUrls[normalizeUrlKey(it.lanUrl)] = true;
      if (it.title) existingTitles[String(it.title).toLowerCase()] = true;
    });
  });

  result.items = result.items.map(function (it) {
    var duplicated = !!(existingUrls[normalizeUrlKey(it.url)] ||
                       (it.lanUrl && existingUrls[normalizeUrlKey(it.lanUrl)]) ||
                       existingTitles[String(it.title).toLowerCase()]);
    it.ignored = settings.ignored.indexOf(it.id) !== -1;
    it.added = duplicated;
    // 默认勾选：运行中、非依赖容器、未忽略、未重复
    it.selected = !it.ignored && !duplicated && !it.infra && it.running;
    return it;
  });

  result.ignored = settings.ignored;
  result.settings = { lanHost: lanHost, wanHost: wanHost };
  result.capabilities = {
    dockerSocket: DOCKER_SOCKET,
    dockerHostConfigured: !!DOCKER_HOST_NAME,
    iconProbe: ICON_PROBE_ENABLED,
    scanLocal: SCAN_LOCAL_ENABLED
  };
  sendJson(res, 200, result);
}

// 超大请求体的统一拒绝方式。
// 直接响应后立刻关闭连接会触发 TCP RST，而 RST 会丢弃客户端尚未读走的响应数据，
// 结果调用方只看到 ECONNRESET、看不到「太大了」这句提示。因此这里先把请求体读空
// （丢弃）再回响应；加超时兜底，避免客户端不发完时把连接挂住。
function rejectBodyTooLarge(req, res, status, message) {
  let sent = false;
  const finish = () => {
    if (sent) return;
    sent = true;
    sendJson(res, status, { ok: false, error: message });
  };
  const timer = setTimeout(finish, 10000);
  const done = () => { clearTimeout(timer); finish(); };
  req.resume();
  req.on("end", done);
  req.on("aborted", done);
  req.on("error", done);
  req.on("close", done);
}

/* ---------- 图床库接口 ---------- */
// GET /api/library：列出本地图床库全部图片 + 在线图标推荐（只读，不写任何文件）
function handleLibraryList(req, res) {
  let cfg = null;
  try { cfg = loadConfig(); } catch (e) { cfg = null; }   // 配置异常不应连带图床库不可用
  const lib = listLibrary(cfg);
  if (!lib.ok) { sendJson(res, 500, lib); return; }
  lib.presets = libraryIconPresets();
  lib.limits = { maxFiles: LIBRARY_MAX_FILES, maxSize: LIBRARY_MAX_SIZE, accept: ["png", "jpg", "jpeg", "gif", "webp"] };
  sendJson(res, 200, lib);
}

// POST /api/library/upload：批量上传图标到图床库。
// 采用「逐张独立校验 + 部分成功」语义：单张失败不影响其余图片落盘，
// 返回逐条结果（results）与汇总（success / failed），前端据此展示失败原因。
async function handleLibraryUpload(req, res) {
  // 先看 Content-Length 提前拦截：浏览器/前端一定会带这个头，
  // 这样超限时能返回明确的 413，而不是读到一半中断连接（体验更友好）。
  const declared = parseInt(req.headers["content-length"] || "0", 10);
  if (declared > MAX_LIBRARY_BODY) {
    rejectBodyTooLarge(req, res, 413,
      "本次上传数据过大（" + Math.round(declared / 1024 / 1024) + "MB，上限 " +
      Math.round(MAX_LIBRARY_BODY / 1024 / 1024) + "MB，请减少批次数或压缩图片）");
    return;
  }
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, MAX_LIBRARY_BODY);
  } catch (e) {
    sendJson(res, 413, { ok: false, error: "本次上传数据过大（上限 " + Math.round(MAX_LIBRARY_BODY / 1024 / 1024) + "MB，请减少批次数或压缩图片）" });
    return;
  }
  let body;
  try {
    body = JSON.parse(bodyBuf.toString("utf-8"));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "请求格式错误（不是合法 JSON）" });
    return;
  }

  // 兼容两种载荷：{ files: [{name, dataUrl}] } 批量；{ name, dataUrl } 单张。
  let files = Array.isArray(body && body.files) ? body.files : [];
  if (!files.length && body && body.dataUrl) files = [{ name: body.name, dataUrl: body.dataUrl }];
  if (!files.length) {
    sendJson(res, 400, { ok: false, error: "没有待上传的图片" });
    return;
  }
  if (files.length > LIBRARY_MAX_FILES) {
    sendJson(res, 413, { ok: false, error: "单次最多上传 " + LIBRARY_MAX_FILES + " 张图片，请分批上传" });
    return;
  }

  const results = [];
  let okCount = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const label = String(f.name || ("图片 " + (i + 1)));
    const r = saveImageDataUrl(f.dataUrl, f.name);
    if (r.ok) {
      okCount++;
      results.push({ ok: true, name: r.name, url: r.url, label: label });
    } else {
      results.push({ ok: false, label: label, error: r.error });
    }
  }
  sendJson(res, 200, {
    ok: okCount > 0,
    total: files.length,
    success: okCount,
    failed: files.length - okCount,
    results: results
  });
}

// POST /api/library/delete：从图床库删除图片。
// 默认拒绝删除「仍被导航卡片引用」的图片（409 + 引用清单），需显式 force:true 才强制删除，
// 避免一次误点让线上卡片集体变成字母回退图标。
async function handleLibraryDelete(req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, MAX_BODY);
  } catch (e) {
    sendJson(res, 413, { ok: false, error: "请求数据过大" });
    return;
  }
  let body;
  try {
    body = JSON.parse(bodyBuf.toString("utf-8"));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "请求格式错误（不是合法 JSON）" });
    return;
  }

  const raw = String((body && body.name) || "");
  const name = path.basename(raw);
  if (!raw || name !== raw || name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) {
    sendJson(res, 400, { ok: false, error: "文件名非法" });
    return;
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!LIBRARY_IMAGE_EXT[ext]) {
    sendJson(res, 400, { ok: false, error: "只能删除图床库中的图片文件" });
    return;
  }
  const target = path.join(UPLOAD_DIR, name);
  const rel = path.relative(UPLOAD_DIR, target);                 // 双保险：规范化后必须仍在上传目录内
  if (rel.indexOf("..") === 0 || path.isAbsolute(rel)) {
    sendJson(res, 400, { ok: false, error: "文件名非法" });
    return;
  }
  if (!fs.existsSync(target)) {
    sendJson(res, 404, { ok: false, error: "图片不存在（可能已被删除）" });
    return;
  }

  if (!(body && body.force === true)) {
    let cfg = null;
    try { cfg = loadConfig(); } catch (e) { cfg = null; }
    const lib = listLibrary(cfg);
    const hit = (lib.images || []).filter((im) => im.name === name)[0];
    if (hit && hit.usedBy.length) {
      sendJson(res, 409, {
        ok: false,
        name: name,
        usedBy: hit.usedBy,
        error: "该图片仍被 " + hit.usedBy.length + " 张卡片引用（" + hit.usedBy.slice(0, 3).join("、") + "）"
      });
      return;
    }
  }
  try {
    fs.unlinkSync(target);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "删除失败：" + (e && e.message ? e.message : e) });
    return;
  }
  sendJson(res, 200, { ok: true, name: name });
}

/* ---------- 静态文件 ---------- */
// 前端资源版本号：由 public/js 与 public/css 下最新的修改时间自动推导。
// 背景：js/css 走 7 天强缓存，缓存键是 URL（含 ?v=）。以前靠手工改 index.html 的
// ?v=，一旦「改了 app.js 却忘了换版本号」，浏览器就会若无其事地继续用旧文件，
// 表现为「代码明明修了、镜像也重建了，页面还是老行为」，极难排查。
// 改为服务端下发时按 mtime 自动改写 ?v= 后，任何前端改动都会自动换键，不会再忘。
let assetTokenCache = { token: "", at: 0 };
function assetToken() {
  const now = Date.now();
  if (assetTokenCache.token && now - assetTokenCache.at < 3000) return assetTokenCache.token;
  let newest = 0;
  for (const dir of ["js", "css"]) {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, dir)); } catch (e) { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(ROOT, dir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) { /* 单个文件读不到不影响整体 */ }
    }
  }
  const token = newest ? String(Math.round(newest)).slice(-10) : "0";
  assetTokenCache = { token: token, at: now };
  return token;
}

// 统一按扩展名输出文件（静态资源与上传目录共用）
function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (!/\.(html|json)$/i.test(ext)) headers["Cache-Control"] = "public, max-age=604800";
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// HTML 输出前把 ?v=xxx 统一替换为当前资源版本号（自动跟随前端改动），并禁止 HTML 强缓存
function sendHtml(res, filePath) {
  let html;
  try {
    html = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    send(res, 500, "Internal Error", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const token = assetToken();
  html = html.replace(/(\.(?:js|css))\?v=[^"']*/g, "$1?v=" + token);
  const buf = Buffer.from(html, "utf-8");
  res.writeHead(200, {
    "Content-Type": MIME[".html"],
    "Cache-Control": "no-cache",
    "Content-Length": buf.length
  });
  res.end(buf);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";

  // 自定义上传目录（NAVI_UPLOAD_DIR，Docker 通常为 /app/data/uploads）不在 public/ 内，
  // 若只从 public/ 取文件，卡片 Logo 会 404。这里优先从上传目录映射，
  // 未命中再回退 public/（默认部署即 UPLOAD_DIR === public/uploads，行为完全不变）。
  if (rel.indexOf("/uploads/") === 0 &&
      path.normalize(UPLOAD_DIR) !== path.normalize(path.join(ROOT, "uploads"))) {
    const upFile = path.join(UPLOAD_DIR, path.basename(rel)); // basename 阻断路径穿越
    let upStat = null;
    try { upStat = fs.statSync(upFile); } catch (e) {}
    if (upStat && upStat.isFile()) {
      sendFile(res, upFile);
      return;
    }
  }

  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (path.extname(filePath).toLowerCase() === ".html") {
      sendHtml(res, filePath);   // 注入当前资源版本号，避免旧缓存被长期使用
      return;
    }
    sendFile(res, filePath);
  });
}

/* ---------- 登录 / 登出 ---------- */
async function handleLogin(req, res) {
  if (!AUTH_ENABLED) {
    sendJson(res, 200, { ok: true, authEnabled: false });
    return;
  }
  const ip = clientIp(req);
  if (loginLocked(ip)) {
    sendJson(res, 429, { ok: false, error: "失败次数过多，请 1 分钟后再试" });
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "请求格式错误" });
    return;
  }
  // 联合校验：用户名（若启用）+ 密码。任一不符均返回统一错误，避免用户枚举
  if (!body || typeof body.password !== "string" || (REQUIRE_USERNAME && typeof body.username !== "string")) {
    recordLoginFail(ip);
    sendJson(res, 401, { ok: false, error: "用户名或密码错误" });
    return;
  }
  const okUser = verifyUsername(body.username);
  const okPass = verifyPassword(body.password);
  if (!okUser || !okPass) {
    recordLoginFail(ip);
    sendJson(res, 401, { ok: false, error: "用户名或密码错误" });
    return;
  }
  clearLoginFail(ip);
  const token = signToken();
  sendJson(res, 200, { ok: true }, { "Set-Cookie": buildSessionCookie(req, token) });
}

function handleLogout(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) revokedTokens.add(token); // 服务端立即吊销，旧 Cookie 作废
  sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
}

/* ---------- 服务 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  try {
    /* ---- 公开接口（无需认证） ---- */
    if (pathname === "/api/login" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }
    if (pathname === "/api/auth/status" && req.method === "GET") {
      sendJson(res, 200, { authEnabled: AUTH_ENABLED, requireUsername: REQUIRE_USERNAME, authenticated: isAuthenticated(req) });
      return;
    }
    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, ipv6: true, authEnabled: AUTH_ENABLED });
      return;
    }
    if (pathname === "/api/logout" && req.method === "POST") {
      handleLogout(req, res);
      return;
    }

    /* ---- 登录页（未认证可访问；已认证直接回首页） ---- */
    if (pathname === "/login.html" && req.method === "GET") {
      if (!AUTH_ENABLED || isAuthenticated(req)) {
        redirect(res, "/");
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    /* ---- 认证闸门：其余所有页面 / 静态资源 / API ---- */
    if (!isAuthenticated(req)) {
      if (pathname.indexOf("/api/") === 0) {
        sendJson(res, 401, { ok: false, error: "未认证或会话已过期" });
      } else {
        redirect(res, "/login.html");
      }
      return;
    }

    /* ---- 业务接口 ---- */
    if (pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, loadConfig());
      return;
    }

    if (pathname === "/api/config" && req.method === "PUT") {
      const body = await readBody(req);
      let cfg;
      try {
        cfg = JSON.parse(body.toString("utf-8"));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON 解析失败：" + e.message });
        return;
      }
      const errMsg = validateConfig(cfg);
      if (errMsg) {
        sendJson(res, 400, { ok: false, error: errMsg });
        return;
      }
      let result;
      try {
        result = saveConfigAtomic(cfg);
      } catch (e) {
        console.error("[navi] 写入 config.json 失败:", e && e.message);
        sendJson(res, 500, { ok: false, error: "服务器写入配置失败：" + (e && e.message ? e.message : e) });
        return;
      }
      sendJson(res, 200, { ok: true, mode: result.mode });
      return;
    }

    /* ---- 数据备份 / 恢复 / 上传（均需认证） ---- */
    if (pathname === "/api/backup" && req.method === "GET") {
      // 导出当前全部数据：结构化备份包，浏览器按附件下载
      const cfg = loadConfig();
      const backup = buildBackup(cfg);
      const raw = JSON.stringify(backup);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      send(res, 200, raw, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="navi-backup-' + stamp + '.json"',
        "Content-Length": Buffer.byteLength(raw)
      });
      return;
    }

    if (pathname === "/api/backup/restore" && req.method === "POST") {
      // 恢复：先整体校验（格式/版本/校验和/结构），通过才原子写入，绝不影响现有运行
      const bodyBuf = await readBody(req, MAX_BODY);
      let body;
      try {
        body = JSON.parse(bodyBuf.toString("utf-8"));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "文件格式错误（不是合法 JSON）" });
        return;
      }
      const v = verifyBackup(body);
      if (!v.ok) {
        sendJson(res, 400, { ok: false, error: v.error });
        return;
      }
      try {
        saveConfigAtomic(v.config);
      } catch (e) {
        console.error("[navi] 恢复配置写入失败:", e && e.message);
        sendJson(res, 500, { ok: false, error: "服务器写入配置失败：" + (e && e.message ? e.message : e) });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      // 本地 logo 图片上传（单张）：与图床库共用同一套校验与落盘逻辑，
      // 因此这里上传的图片会同时进入图床库，后续可在其它卡片上重复选用。
      if (parseInt(req.headers["content-length"] || "0", 10) > MAX_UPLOAD_BODY) {
        rejectBodyTooLarge(req, res, 413, "图片数据过大（请求体上限 5MB）");
        return;
      }
      let bodyBuf;
      try {
        bodyBuf = await readBody(req, MAX_UPLOAD_BODY);
      } catch (e) {
        sendJson(res, 413, { ok: false, error: "图片数据过大（请求体上限 5MB）" });
        return;
      }
      let body;
      try {
        body = JSON.parse(bodyBuf.toString("utf-8"));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "请求格式错误（不是合法 JSON）" });
        return;
      }
      const r = saveImageDataUrl(body && body.dataUrl, body && body.name);
      if (!r.ok) {
        const clientErr = /过大|文件头校验失败|解码失败|内容为空|仅支持/.test(r.error);
        sendJson(res, clientErr ? 400 : 500, { ok: false, error: r.error });
        return;
      }
      sendJson(res, 200, { ok: true, url: r.url, name: r.name });
      return;
    }

    /* ---- 图床库（均需认证；上传/删除会写盘，列表只读） ---- */
    if (pathname === "/api/library" && req.method === "GET") {
      handleLibraryList(req, res);
      return;
    }
    if (pathname === "/api/library/upload" && req.method === "POST") {
      await handleLibraryUpload(req, res);
      return;
    }
    if (pathname === "/api/library/delete" && req.method === "POST") {
      await handleLibraryDelete(req, res);
      return;
    }

    /* ---- 服务发现（需认证；只读扫描，不写配置） ---- */
    if (pathname === "/api/discover" && req.method === "GET") {
      await handleDiscover(req, res, u);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname);
      return;
    }

    send(res, 405, "Method Not Allowed", { "Content-Type": "text/plain; charset=utf-8" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log("[navi] listening on " + (addr.family === "IPv6" ? "[" + addr.address + "]" : addr.address) + ":" + addr.port + " (dual-stack)");
  console.log("[navi] config file: " + CONFIG_PATH);
  console.log("[navi] 图床库目录: " + UPLOAD_DIR + "（请确保其所在卷已持久化，否则重建容器后图标会丢失）");
  console.log("[navi] auth: " + (AUTH_ENABLED ? "ENABLED (ttl " + SESSION_TTL_HOURS + "h)" : "DISABLED (set NAVI_PASSWORD to enable)"));
  console.log("[navi] discover: docker=" +
    (DOCKER_HOST_NAME ? "tcp://" + DOCKER_HOST_NAME + ":" + DOCKER_HOST_PORT : "unix://" + DOCKER_SOCKET) +
    ", local-scan=" + (SCAN_LOCAL_ENABLED ? "on" : "off") +
    ", icon-probe=" + (ICON_PROBE_ENABLED ? "on" : "off") +
    ", lanHost=" + (LAN_HOST_ENV || "(auto)") + ", wanHost=" + (WAN_HOST_ENV || "(auto)"));
});
