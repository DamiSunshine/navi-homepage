/* ============================================================
   Navi 个人导航站 · 服务发现模块（零依赖）
   ------------------------------------------------------------
   参考 Docker-Panel 的核心思路，为 Navi 增量提供三项能力：
     1. 自动识别本地进程 / Docker 容器内服务的运行端口
     2. 依据服务类型（镜像名 / 容器名 / 进程名 / 端口）自动匹配图标
     3. 输出可直接生成导航卡片的候选条目（内网 / 外网地址自动拼装）

   本模块只做「发现 + 推断」，不写任何配置；是否落盘由 server.js
   与前端编辑流程决定，因此不会破坏既有数据与交互。

   仅使用 Node 内置模块，无需 npm install。
   ============================================================ */

"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

/* ---------- 服务指纹库 ----------
   匹配来源优先级：Docker 镜像名 > 容器名 > 进程名 > 监听端口
   icon 写法与 Navi 前端 resolveIcon 完全一致：
     "jellyfin"                  → Dashboard Icons
     "selfhst:portainer"         → selfh.st Icons
     "iconify:simple-icons:alist"→ Iconify
   infra:true 表示「依赖容器」（数据库 / 缓存等），默认不勾选。 */
const SERVICE_PRESETS = [
  { name: "Jellyfin", icon: "jellyfin", desc: "影音媒体库", match: ["jellyfin"], ports: [8096] },
  { name: "Emby", icon: "emby", desc: "影音媒体库", match: ["emby"], ports: [8920] },
  { name: "Plex", icon: "plex", desc: "影音媒体库", match: ["plex"], ports: [32400] },
  { name: "Portainer", icon: "selfhst:portainer", desc: "Docker 管理", match: ["portainer"], ports: [9443] },
  { name: "Home Assistant", icon: "home-assistant", desc: "智能家居", match: ["home-assistant", "homeassistant"], ports: [8123] },
  { name: "qBittorrent", icon: "q-bittorrent", desc: "下载工具", match: ["qbittorrent", "qbit"], ports: [8081] },
  { name: "Transmission", icon: "transmission", desc: "下载工具", match: ["transmission"], ports: [9091] },
  { name: "Alist", icon: "iconify:simple-icons:alist", desc: "网盘聚合", match: ["alist"], ports: [5244] },
  { name: "Gitea", icon: "gitea", desc: "私有 Git 服务", match: ["gitea"], ports: [3000] },
  { name: "Grafana", icon: "grafana", desc: "监控面板", match: ["grafana"], ports: [] },
  { name: "Prometheus", icon: "prometheus", desc: "指标采集", match: ["prometheus"], ports: [9090] },
  { name: "Uptime Kuma", icon: "uptime-kuma", desc: "可用性监控", match: ["uptime-kuma", "uptime_kuma"], ports: [] },
  { name: "Nginx", icon: "nginx", desc: "Web 服务器", match: ["nginx"], ports: [] },
  { name: "Nginx Proxy Manager", icon: "nginx-proxy-manager", desc: "反向代理管理", match: ["nginx-proxy-manager"], ports: [81] },
  { name: "Nextcloud", icon: "nextcloud", desc: "私有云盘", match: ["nextcloud"], ports: [] },
  { name: "Immich", icon: "immich", desc: "照片管理", match: ["immich"], ports: [2283] },
  { name: "Navidrome", icon: "navidrome", desc: "音乐流媒体", match: ["navidrome"], ports: [4533] },
  { name: "Vaultwarden", icon: "vaultwarden", desc: "密码管理", match: ["vaultwarden", "bitwarden"], ports: [] },
  { name: "AdGuard Home", icon: "adguard-home", desc: "去广告 DNS", match: ["adguard"], ports: [] },
  { name: "OpenWrt", icon: "openwrt", desc: "路由器管理", match: ["openwrt"], ports: [] },
  { name: "Syncthing", icon: "syncthing", desc: "文件同步", match: ["syncthing"], ports: [8384] },
  { name: "Cloudreve", icon: "cloudreve", desc: "网盘系统", match: ["cloudreve"], ports: [5212] },
  { name: "MinIO", icon: "minio", desc: "对象存储", match: ["minio"], ports: [9001] },
  { name: "frp", icon: "frp", desc: "内网穿透", match: ["frps", "frpc"], ports: [7500] },
  { name: "SearXNG", icon: "searxng", desc: "元搜索引擎", match: ["searxng", "searx"], ports: [] },
  { name: "Lucky", icon: "lucky", desc: "内网穿透 / 反代", match: ["lucky"], ports: [16601] },
  { name: "MySQL", icon: "mysql", desc: "数据库（依赖容器）", match: ["mysql", "mariadb"], ports: [3306], infra: true },
  { name: "PostgreSQL", icon: "postgresql", desc: "数据库（依赖容器）", match: ["postgres"], ports: [5432], infra: true },
  { name: "Redis", icon: "redis", desc: "缓存（依赖容器）", match: ["redis"], ports: [6379], infra: true },
  { name: "MongoDB", icon: "mongodb", desc: "数据库（依赖容器）", match: ["mongo"], ports: [27017], infra: true },
  { name: "RabbitMQ", icon: "rabbitmq", desc: "消息队列（依赖容器）", match: ["rabbitmq"], ports: [15672], infra: true },
  { name: "Elasticsearch", icon: "elasticsearch", desc: "搜索引擎（依赖容器）", match: ["elasticsearch"], ports: [9200], infra: true },
  { name: "MariaDB", icon: "mariadb", desc: "数据库（依赖容器）", match: ["mariadb"], ports: [], infra: true }
];

/* 通用端口：命中也不作为「服务类型」依据，避免把 80/8080 误判成某个具体服务 */
const GENERIC_PORTS = new Set([80, 443, 3000, 5000, 8000, 8080, 8443, 8888, 9000, 10000]);

/* 常见 Web 端口：用于判断「这个端口是否值得生成一张卡片」 */
const WEB_HINT_PORTS = new Set([
  80, 81, 443, 3000, 3001, 5000, 5001, 5244, 5212, 5433, 5601, 5984, 6080, 7000,
  8000, 8006, 8080, 8081, 8082, 8088, 8090, 8096, 8123, 8161, 8181, 8200, 8443,
  8888, 8920, 9000, 9001, 9090, 9091, 9200, 9443, 10000, 16601, 2283, 4533, 15672,
  32400, 8086, 8181, 9090
]);

/* 干扰进程名：系统自带 / 与导航无关，扫描时直接丢弃（Linux + Windows + macOS） */
const NOISE_PROCESSES = new Set([
  // Linux
  "systemd", "systemd-journal", "systemd-resolve", "systemd-timesyn", "systemd-udevd",
  "init", "kthreadd", "sshd", "cron", "crond", "rsyslogd", "dbus-daemon", "agetty",
  "login", "bash", "sh", "zsh", "su", "sudo", "polkitd", "containerd", "dockerd",
  "rpcbind", "avahi-daemon", "networkmanager", "dnsmasq", "smbd", "nmbd", "winbindd",
  "cupsd", "packagekitd", "fwupd", "udisksd", "upowerd", "rtkit-daemon", "chronyd",
  "ntpd", "wpa_supplicant", "dhclient", "dhcpcd", "node", "python", "python3",
  // Windows
  "system", "system idle process", "svchost", "services", "lsass", "wininit", "winlogon",
  "smss", "csrss", "spoolsv", "dwm", "taskhostw", "sihost", "fontdrvhost", "searchindexer",
  "searchprotocolhost", "searchfilterhost", "runtimebroker", "shellexperiencehost",
  "startmenuexperiencehost", "textinputhost", "ctfmon", "explorer", "wudfhost",
  "jhi_service", "wlanext", "mpdefendercoreservice", "securityhealthservice",
  "wmiprvse", "dllhost", "conhost", "audiodg", "registry", "memory compression",
  "msdtc", "nissrv", "sgrmbroker", "trustedinstaller", "tiworker", "usoclient",
  "mo_2541", "fn_sharelink", "trim", "browser", "chrome", "msedge", "firefox",
  // macOS
  "launchd", "mds", "mds_stores", "spotlight", "coreaudiod", "configd", "notifyd",
  "distnoted", "cfprefsd", "runningboardd", "logd", "syslogd", "bluetoothd",
  "rapportd", "sharingd", "airportd", "controlcenter", "useractivityd"
]);

/* ---------- 小工具 ---------- */
function toArray(v) { return Array.isArray(v) ? v : []; }

function slugify(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* 从镜像名 / 容器名 / 进程名中提取候选关键词（去掉 registry、tag、副本后缀） */
function normalizeName(raw) {
  var s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^\/+/, "");                      // Docker 容器名以 / 开头
  s = s.split("@")[0];                            // 去掉 digest
  var slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);         // 去掉 registry/namespace
  var colon = s.lastIndexOf(":");
  if (colon > 0) s = s.slice(0, colon);           // 去掉 tag
  s = s.replace(/-[0-9]+$/, "");                  // 去掉 -1 / -2 副本后缀
  s = s.replace(/_(server|web|app|main|api|db|worker)$/, "");
  return s;
}

/* 关键词是否命中服务指纹（做前缀/包含双向匹配，容忍 linuxserver-jellyfin 之类） */
function criteriaHit(criteria, target) {
  if (!criteria || !target) return false;
  var c = String(criteria).toLowerCase();
  if (c === target) return true;
  return target.indexOf(c) !== -1 || c.indexOf(target) !== -1;
}

/* 根据一组名称 + 端口，匹配服务指纹。返回 preset 或 null（带命中分数） */
function matchPreset(names, ports) {
  var list = toArray(names).map(normalizeName).filter(Boolean);
  var portList = toArray(ports);
  var best = null;
  var bestScore = 0;

  SERVICE_PRESETS.forEach(function (p) {
    var hit = false, score = 0;

    // 名称命中（权重最高）
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < p.match.length; j++) {
        if (criteriaHit(p.match[j], list[i])) {
          hit = true;
          score += (i === 0 ? 100 : 60) - j;
          break;
        }
      }
      if (hit) break;
    }

    // 端口命中（仅在名称未命中时兜底，且排除通用端口）
    if (!hit) {
      for (var k = 0; k < p.ports.length; k++) {
        if (portList.indexOf(p.ports[k]) !== -1 && !GENERIC_PORTS.has(p.ports[k])) {
          hit = true;
          score += 40;
          break;
        }
      }
    }

    if (hit && score > bestScore) { bestScore = score; best = p; }
  });

  return best;
}

/* 兜底：用镜像名 / 容器名 / 进程名推导 Dashboard Icons slug */
function inferIconSlug(names) {
  var list = toArray(names).map(normalizeName).filter(Boolean);
  for (var i = 0; i < list.length; i++) {
    var s = slugify(list[i]);
    if (s && s.length >= 2) return s;
  }
  return "";
}

/* ---------- 地址拼装 ---------- */
function isIpv4(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h); }

/* 判断是否私网 / 本机地址（与前端 isLanHost 同规则） */
function isLanHost(hostname) {
  if (!hostname) return false;
  var h = String(hostname).toLowerCase().trim().replace(/^\[|\]$/g, "");
  // 仅对 "IPv4:端口" 形式剥离端口；IPv6 地址自带冒号，不能按冒号切分
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(h)) h = h.split(":")[0];
  if (h === "localhost") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
}

/* 本机第一个私网 IPv4（无环境变量、无请求上下文时兜底） */
function detectLocalIPv4() {
  var ifaces = os.networkInterfaces();
  var keys = Object.keys(ifaces);
  for (var i = 0; i < keys.length; i++) {
    var arr = toArray(ifaces[keys[i]]);
    for (var j = 0; j < arr.length; j++) {
      var a = arr[j];
      if (a && a.family === "IPv4" && !a.internal && isLanHost(a.address)) return a.address;
    }
  }
  // 退而求其次：任意非内部 IPv4
  for (var m = 0; m < keys.length; m++) {
    var arr2 = toArray(ifaces[keys[m]]);
    for (var n = 0; n < arr2.length; n++) {
      var b = arr2[n];
      if (b && b.family === "IPv4" && !b.internal) return b.address;
    }
  }
  return "127.0.0.1";
}

/* 按 Docker-Panel 的「自动补全规则」拼装访问地址：
   - 内网：IP / 主机名 → 固定 http:// 且追加端口（80/443 省略）
   - 外网：域名 → 固定 https:// 且不追加端口；IP → http:// 且追加端口 */
function buildAddresses(lanHost, wanHost, port) {
  var lanBase = String(lanHost || "").trim();
  var wanBase = String(wanHost || "").trim();
  var out = { lanUrl: "", url: "" };

  if (lanBase) {
    var lh = lanBase.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    out.lanUrl = "http://" + lh + portSuffix(port);
  }

  if (wanBase) {
    var wh = wanBase.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    var whost = wh.split(":")[0];
    if (isIpv4(whost)) {
      out.url = "http://" + wh + portSuffix(port);
    } else {
      out.url = "https://" + whost;   // 域名走 https 且不追加端口
    }
  }

  // 无外网地址时，用内网地址兜底，保证 Navi 的 url 必填校验通过
  if (!out.url) out.url = out.lanUrl;
  return out;
}

function portSuffix(port) {
  var p = parseInt(port, 10);
  if (!p || p === 80 || p === 443) return "";
  return ":" + p;
}

/* ============================================================
   Docker Engine API 客户端（零依赖）
   ------------------------------------------------------------
   两种连接方式，按可用性自动选择：
     1. Unix Socket  挂载 /var/run/docker.sock（推荐，本机 Docker）
     2. TCP          DOCKER_HOST_NAME + DOCKER_HOST_PORT
   两者都不可用时返回明确原因，前端给出可操作的提示。
   ============================================================ */

function dockerRequest(opts, apiPath, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var reqOpts = {
      method: "GET",
      path: apiPath,
      headers: { Host: "localhost", Accept: "application/json" }
    };
    if (opts.socketPath) {
      reqOpts.socketPath = opts.socketPath;
    } else {
      reqOpts.host = opts.host;
      reqOpts.port = opts.port;
    }

    var settled = false;
    var req = http.request(reqOpts, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        if (settled) return;
        settled = true;
        var text = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode !== 200) {
          reject(new Error("Docker API " + apiPath + " 返回 " + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error("Docker API 响应解析失败")); }
      });
    });

    req.setTimeout(timeoutMs, function () {
      if (settled) return;
      settled = true;
      req.destroy(new Error("Docker API 超时"));
    });
    req.on("error", function (e) {
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.end();
  });
}

/* 列出所有容器（含已停止），失败时返回 { ok:false, error } */
async function listContainers(opts) {
  var cfg = opts || {};
  var timeout = cfg.timeout || 2500;

  // 候选连接：优先 Unix Socket，其次 TCP
  var candidates = [];
  if (cfg.socketPath) candidates.push({ kind: "socket", socketPath: cfg.socketPath });
  if (cfg.host) candidates.push({ kind: "tcp", host: cfg.host, port: cfg.port || 2375 });
  if (!candidates.length) {
    return { ok: false, error: "未配置 Docker 连接（可挂载 /var/run/docker.sock 或设置 DOCKER_HOST_NAME）" };
  }

  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    try {
      var list = await dockerRequest(candidates[i], "/containers/json?all=true", timeout);
      return { ok: true, kind: candidates[i].kind, containers: toArray(list) };
    } catch (e) {
      lastErr = e;
    }
  }
  var reason = lastErr && lastErr.message ? lastErr.message : "未知错误";
  if (/ENOENT|EACCES|EPERM/.test(reason)) {
    reason = "无法访问 Docker（" + reason + "）。请把 /var/run/docker.sock 挂载进容器，并确保进程有权限。";
  }
  return { ok: false, error: reason };
}

/* 从 Docker 容器对象提取「对外可访问的端口」。
   Docker 的 Ports 形如 { PrivatePort, PublicPort, Type, IP }；
   优先取有 PublicPort 的（宿主机映射），否则退回 PrivatePort（容器网络内部端口）。 */
function extractPorts(container) {
  var ports = toArray(container && container.Ports);
  var published = [];
  var exposed = [];
  ports.forEach(function (p) {
    if (!p || (p.Type && p.Type !== "tcp")) return;   // 忽略 udp（导航卡片走 http）
    var pub = parseInt(p.PublicPort, 10);
    var priv = parseInt(p.PrivatePort, 10);
    if (pub) published.push(pub);
    else if (priv) exposed.push(priv);
  });
  var uniq = function (arr) {
    return arr.filter(function (v, i) { return arr.indexOf(v) === i; });
  };
  published = uniq(published).sort(function (a, b) { return a - b; });
  exposed = uniq(exposed).sort(function (a, b) { return a - b; });
  return {
    published: published,
    exposed: exposed,
    // 卡片使用宿主机映射端口；无映射时退回容器端口（同网络时可访问）
    usable: published.length ? published : exposed,
    hasPublish: published.length > 0
  };
}

/* 取容器名（Docker 的 Names 数组首项，形如 "/jellyfin"） */
function containerName(container) {
  var names = toArray(container && container.Names);
  if (names.length) return String(names[0]).replace(/^\//, "");
  return String((container && container.Id) || "").slice(0, 12);
}

/* 把 Docker 容器列表转成候选条目 */
function containersToCandidates(containers, opts) {
  var out = [];
  toArray(containers).forEach(function (c) {
    var name = containerName(c);
    var image = String((c && c.Image) || "");
    var ports = extractPorts(c);
    if (!ports.usable.length) return;      // 无任何对外端口，不生成卡片

    var preset = matchPreset([image, name], ports.usable);
    var state = String((c && c.State) || "");
    var status = String((c && c.Status) || "");

    out.push({
      source: "docker",
      id: String((c && c.Id) || name).slice(0, 12),
      container: name,
      image: image,
      state: state,
      running: state === "running",
      status: status,
      ports: ports.usable,
      publishedPorts: ports.published,
      hasPublish: ports.hasPublish,
      presetKey: preset ? preset.name : "",
      infra: !!(preset && preset.infra),
      title: preset ? preset.name : name,
      desc: preset ? preset.desc : (image || "Docker 容器"),
      icon: preset ? preset.icon : "",
      iconSlug: preset ? "" : inferIconSlug([image, name])
    });
  });
  return out;
}

/* ============================================================
   本机监听端口扫描（Linux /proc 实现，纯 Node 内置模块）
   ------------------------------------------------------------
   思路：
     1. 解析 /proc/net/tcp 与 /proc/net/tcp6 中 state=0A(LISTEN) 的记录，
        拿到十六进制端口与 socket inode；
     2. 遍历 /proc/<pid>/fd 建立 inode -> pid 映射；
     3. 用 /proc/<pid>/comm 得到进程名，作为服务指纹输入。
   非 Linux（或权限不足）时优雅降级为空结果。
   ============================================================ */

function parseHexPort(hex) { return parseInt(hex, 16); }

/* 解析 /proc/net/tcp* 文本，返回 [{ port, inode }]，仅 LISTEN 状态 */
function parseProcNetTcp(text) {
  var out = [];
  toArray(String(text || "").split("\n")).forEach(function (line, idx) {
    if (idx === 0) return;                       // 表头
    var f = line.trim().split(/\s+/);
    if (f.length < 10) return;
    // f[1]=local_address(hex:port) f[3]=st f[9]=inode
    if (String(f[3]).toUpperCase() !== "0A") return;   // 0A = TCP_LISTEN
    var la = String(f[1]).split(":");
    if (la.length !== 2) return;
    var port = parseHexPort(la[1]);
    var inode = parseInt(f[9], 10);
    if (!port || !inode) return;
    out.push({ port: port, inode: inode });
  });
  return out;
}

/* 建立 socket inode -> { pid, name } 映射（遍历 /proc/<pid>/fd） */
function mapSocketInodes(procRoot) {
  var root = procRoot || "/proc";
  var map = {};
  var pids;
  try { pids = fs.readdirSync(root); } catch (e) { return map; }

  pids.forEach(function (pidStr) {
    if (!/^\d+$/.test(pidStr)) return;
    var fdDir = path.join(root, pidStr, "fd");
    var fds;
    try { fds = fs.readdirSync(fdDir); } catch (e) { return; }   // 权限不足则跳过
    var name = "";
    try {
      name = String(fs.readFileSync(path.join(root, pidStr, "comm"), "utf-8")).trim();
    } catch (e) { /* 进程可能已退出 */ }
    fds.forEach(function (fd) {
      var link = "";
      try { link = fs.readlinkSync(path.join(fdDir, fd)); } catch (e) { return; }
      var m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m) return;
      map[m[1]] = { pid: parseInt(pidStr, 10), name: name };
    });
  });
  return map;
}

/* 扫描本机监听端口，返回候选条目 */
function scanLocalPorts(opts) {
  var cfg = opts || {};
  var procRoot = cfg.procRoot || "/proc";
  var entries = [];

  ["tcp", "tcp6"].forEach(function (f) {
    var text;
    try { text = fs.readFileSync(path.join(procRoot, "net", f), "utf-8"); }
    catch (e) { return; }
    entries = entries.concat(parseProcNetTcp(text));
  });
  if (!entries.length) return { ok: false, items: [] };

  var inodeMap = mapSocketInodes(procRoot);
  var seen = {};
  var items = [];

  entries.forEach(function (e) {
    if (seen[e.port]) return;
    seen[e.port] = true;

    var proc = inodeMap[String(e.inode)] || null;
    var item = buildLocalItem(e.port, proc ? proc.name : "");
    if (item) items.push(item);
  });

  return { ok: true, items: items };
}

/* ============================================================
   非 Linux 兜底：解析 netstat 输出（Windows / macOS / BSD）
   ------------------------------------------------------------
   /proc 不可用时，退化为调用系统 netstat（Node 内置 child_process，
   仍属零依赖）。Windows 额外用 tasklist 反查 PID 对应的进程名。
   任何一步失败都静默降级，绝不影响主流程。
   ============================================================ */

function runCmd(cmd, args, timeoutMs) {
  try {
    var cp = require("child_process");
    return String(cp.execFileSync(cmd, args, {
      encoding: "utf-8",
      timeout: timeoutMs || 3000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (e) {
    return "";
  }
}

/* 解析 netstat 文本，返回 [{ port, pid }] */
function parseNetstat(text, isWindows) {
  var out = [];
  toArray(String(text || "").split("\n")).forEach(function (line) {
    var t = line.trim();
    if (!t) return;
    var isTcp = /^tcp[46]?\s/i.test(t) || /^TCP\s/i.test(t);
    if (!isTcp) return;
    if (!/LISTEN/i.test(t)) return;
    var f = t.split(/\s+/);

    var local = "";
    var pid = 0;
    if (isWindows) {
      // TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    1234
      local = f[1] || "";
      pid = parseInt(f[f.length - 1], 10) || 0;
    } else {
      // tcp4  0  0  127.0.0.1.8080  *.*  LISTEN
      local = f[3] || "";
    }
    if (!local) return;

    var p = "";
    if (isWindows) {
      var i = local.lastIndexOf(":");
      if (i < 0) return;
      p = local.slice(i + 1);
    } else {
      var j = local.lastIndexOf(".");
      if (j < 0) return;
      p = local.slice(j + 1);
    }
    var port = parseInt(p, 10);
    if (!port) return;
    out.push({ port: port, pid: pid });
  });
  return out;
}

/* Windows：构建 pid -> 进程名 映射（tasklist 一次性输出） */
function windowsPidNames() {
  var map = {};
  var text = runCmd("tasklist", ["/FO", "CSV", "/NH"], 4000);
  toArray(text.split("\n")).forEach(function (line) {
    var m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) map[m[2]] = m[1].replace(/\.exe$/i, "");
  });
  return map;
}

/* 兜底扫描本机监听端口 */
function scanLocalPortsFallback(opts) {
  var cfg = opts || {};
  var isWin = process.platform === "win32";
  if (!isWin && process.platform === "darwin") {
    // macOS 优先用 lsof（netstat 在 darwin 上不含进程名）
    var lsof = runCmd("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], 5000);
    if (lsof) {
      var items = [];
      var seen = {};
      toArray(lsof.split("\n")).slice(1).forEach(function (line) {
        var f = line.split(/\s+/);
        if (f.length < 9) return;
        var name = f[0];
        var addr = f[8] || "";
        var i = addr.lastIndexOf(":");
        if (i < 0) return;
        var port = parseInt(addr.slice(i + 1), 10);
        if (!port || seen[port]) return;
        seen[port] = true;
        items.push(buildLocalItem(port, name));
      });
      return { ok: true, items: items.filter(Boolean) };
    }
  }

  var netstat = runCmd("netstat", isWin ? ["-ano", "-p", "tcp"] : ["-an", "-p", "tcp"], 5000);
  if (!netstat) return { ok: false, items: [] };

  var nameMap = isWin ? windowsPidNames() : {};
  var seen2 = {};
  var items2 = [];
  parseNetstat(netstat, isWin).forEach(function (e) {
    if (seen2[e.port]) return;
    seen2[e.port] = true;
    var pname = (e.pid && nameMap[e.pid]) ? nameMap[e.pid] : "";
    var item = buildLocalItem(e.port, pname);
    if (item) items2.push(item);
  });
  return { ok: true, items: items2 };
}

/* 由「端口 + 进程名」构造候选条目（/proc 与 netstat 两条路径共用） */
function buildLocalItem(port, procName) {
  var pname = String(procName || "").trim();
  var lower = pname.toLowerCase();
  if (lower && NOISE_PROCESSES.has(lower)) return null;      // 系统进程过滤

  var preset = matchPreset([pname], [port]);
  var p = parseInt(port, 10);
  // 仅保留「服务指纹命中」或「常见 Web 端口」的监听项，避免系统服务刷屏
  if (!preset && !(WEB_HINT_PORTS.has(p) && p < 12000)) return null;

  return {
    source: "local",
    id: "port-" + port,
    port: p,
    container: pname || "",
    image: "",
    state: "listening",
    running: true,
    status: pname ? (pname + " · 本机监听") : "本机监听端口",
    ports: [port],
    publishedPorts: [port],
    hasPublish: true,
    presetKey: preset ? preset.name : "",
    infra: false,
    title: preset ? preset.name : (pname || ("端口 " + port)),
    desc: preset ? preset.desc : (pname ? pname + " 服务" : "本机监听端口"),
    icon: preset ? preset.icon : "",
    iconSlug: preset ? "" : inferIconSlug([pname])
  };
}

/* ============================================================
   失效判定（P1-7）：源侧已消失的「发现卡片」只标记、不删除
   ------------------------------------------------------------
   输入：
     items            配置里的扁平条目列表（含 title / url / source / stale）
     presentIdsByVia  { docker: {id:true}, local: {id:true} } 本次扫描到的候选 id
     availableByVia   { docker: bool, local: bool } 各来源本次是否真的接入了

   输出：{ items, checked, skipped }
     items    [{ index, id, via, title, url, marked }]  判为「可能已失效」的条目
     checked  ['docker','local'] 本次真正做了判定的来源
     skipped  ['docker']         本次无法判定的来源（未接入）

   为什么必须区分 checked / skipped（**这一条是正确性红线**）：
     Docker 没挂载时扫描结果天然为空。若不加区分地做 diff，会把**所有**
     发现卡片一次性判成「已失效」—— 那是「测不到」被当成了「测出来是坏的」，
     与 P0-3 里 HTTPS 页面探测 http 内网地址被误判为「不可达」是同一类错误。
     所以：来源没接入 → 本次不判定，并如实告知前端「本次未做失效判定」。

   判定范围只限 source.type === "discover"（且带 source.id）的卡片：
     手工添加 / 导入的卡片永远不会被判失效，否则用户自己填的链接会被牵连。
   ============================================================ */
function computeStale(items, presentIdsByVia, availableByVia) {
  var present = presentIdsByVia || {};
  var avail = availableByVia || {};
  var out = [];
  var checked = {};
  var skipped = {};

  toArray(items).forEach(function (it, idx) {
    var src = it && it.source;
    if (!src || typeof src !== "object" || Array.isArray(src)) return;
    if (src.type !== "discover") return;                       // 只管发现来的卡片
    var id = src.id ? String(src.id) : "";
    if (!id) return;                                           // 无 id 无法比对，不判
    var via = src.via ? String(src.via) : "";
    if (avail[via] !== true) { skipped[via || "unknown"] = true; return; }
    checked[via] = true;
    var set = present[via] || {};
    if (set[id]) return;                                       // 源侧仍在 → 不是失效
    out.push({
      index: idx,
      id: id,
      via: via,
      title: String(it.title || ""),
      url: String(it.url || ""),
      // 已经标过的也一并返回：前端要统计「N 项已标记」并支持一键恢复
      marked: it.stale === true
    });
  });

  return {
    items: out,
    checked: Object.keys(checked),
    skipped: Object.keys(skipped)
  };
}

/* ============================================================
   图标在线探测（可选）
   ------------------------------------------------------------
   按 Docker-Panel 的「图标匹配顺序」：预设命中 → 图标库探测 → 默认。
   预设未命中时，尝试 HEAD 校验 Dashboard Icons / selfh.st 是否存在该
   slug；命中则直接使用，避免卡片出现破图。默认开启，可用
   NAVI_ICON_PROBE=0 关闭（离线环境建议关闭）。
   ============================================================ */

var iconProbeCache = new Map();   // slug -> "dashboard" | "selfhst" | ""

function probeUrl(url, timeoutMs) {
  return new Promise(function (resolve) {
    // 必须按协议选模块：http.request() 收到 https:// 会【同步抛】
    // ERR_INVALID_PROTOCOL（不是 async error），下面的 error 回调接不住，
    // 会一路冒泡把整次服务发现打挂（表现为「服务发现失败：Protocol "https:"
    // not supported. Expected "http:"」）。
    var mod = String(url).indexOf("https:") === 0 ? https : http;
    var req;
    try {
      req = mod.request(url, { method: "HEAD", timeout: timeoutMs }, function (res) {
        var ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
    } catch (e) {
      resolve(false);   // 任何同步构造失败都降级为「探测不到」，不影响其余条目
      return;
    }
    req.on("error", function () { resolve(false); });
    req.on("timeout", function () { req.destroy(); resolve(false); });
    req.end();
  });
}

/* 图标 CDN 基址。默认 jsDelivr；离线/内网环境可用 NAVI_ICON_PROBE_BASE
   指向自建镜像（须与上游保持相同的目录结构）。测试也靠它注入本地桩服务。 */
function iconProbeBase() {
  var b = String(process.env.NAVI_ICON_PROBE_BASE || "").trim();
  if (!b) return "https://cdn.jsdelivr.net/gh/";
  return b.charAt(b.length - 1) === "/" ? b : b + "/";
}

async function probeIcon(slug, timeoutMs) {
  var s = slugify(slug);
  if (!s) return "";
  if (iconProbeCache.has(s)) return iconProbeCache.get(s);

  var base = iconProbeBase();
  var found = "";
  if (await probeUrl(base + "walkxcode/dashboard-icons/png/" + s + ".png", timeoutMs)) {
    found = "dashboard";
  } else if (await probeUrl(base + "selfhst/icons/png/" + s + ".png", timeoutMs)) {
    found = "selfhst";
  }
  iconProbeCache.set(s, found);
  return found;
}

/* 依据探测结果为条目补全最终 icon 字段。
   并发探测（上限 ICON_PROBE_CONCURRENCY）：图标 CDN 在外网不通时每个 slug 都要
   等满 timeout，串行会随条目数线性累积（20 个服务 ≈ 40s），弹窗看起来像卡死。
   每个条目只写自己的 icon，互不依赖，所以并发不影响结果顺序。 */
var ICON_PROBE_CONCURRENCY = 6;

async function resolveAutoIcon(items, timeoutMs) {
  var queue = items.filter(function (it) { return !it.icon && it.iconSlug; });
  var cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      var it = queue[cursor++];
      var kind = await probeIcon(it.iconSlug, timeoutMs);
      if (kind === "selfhst") it.icon = "selfhst:" + it.iconSlug;
      else if (kind === "dashboard") it.icon = it.iconSlug;
      else it.icon = "";                         // 探测失败 → 交给前端字母回退图标
    }
  }

  var workers = [];
  for (var i = 0; i < Math.min(ICON_PROBE_CONCURRENCY, queue.length); i++) workers.push(worker());
  await Promise.all(workers);
  return items;
}

/* ============================================================
   聚合入口：一次完整的服务发现
   ------------------------------------------------------------
   返回 { ok, lanHost, wanHost, sources, items, warnings }
     sources: { docker: {...}, local: {...} } 各自可用性与原因
     items:   已排序的候选卡片（运行中优先 → 非依赖容器优先 → 端口升序）
   ============================================================ */

async function discover(opts) {
  var cfg = opts || {};
  var warnings = [];
  var items = [];

  var lanHost = String(cfg.lanHost || "").trim() || detectLocalIPv4();
  var wanHost = String(cfg.wanHost || "").trim();

  // ---- 1. Docker 容器 ----
  var dockerCfg = cfg.docker || {};
  var dockerRes = { available: false, reason: "", count: 0 };
  if (dockerCfg.enabled !== false) {
    var listed = await listContainers({
      socketPath: dockerCfg.socketPath,
      host: dockerCfg.host,
      port: dockerCfg.port,
      timeout: dockerCfg.timeout || 2500
    });
    if (listed.ok) {
      var cItems = containersToCandidates(listed.containers, cfg);
      dockerRes.available = true;
      dockerRes.connection = listed.kind;
      dockerRes.count = cItems.length;
      items = items.concat(cItems);
    } else {
      dockerRes.reason = listed.error;
      warnings.push("Docker 未接入：" + listed.error);
    }
  }

  // ---- 2. 本机监听端口（Docker 不可用时更有价值，可用时也一并保留） ----
  var localRes = { available: false, reason: "", count: 0, method: "" };
  if (cfg.scanLocal !== false) {
    var scanned = scanLocalPorts({ procRoot: cfg.procRoot });
    var method = "proc";
    if (!scanned.ok) {
      // /proc 不可用（Windows / macOS / 权限不足）→ 退化为 netstat / lsof
      scanned = scanLocalPortsFallback({});
      method = "netstat";
    }
    if (scanned.ok) {
      localRes.available = true;
      localRes.method = method;
      // 已由 Docker 覆盖的端口不再重复（容器端口在宿主机同样处于监听）
      var dockerPorts = {};
      items.forEach(function (it) {
        toArray(it.publishedPorts).forEach(function (p) { dockerPorts[p] = true; });
      });
      var lItems = scanned.items.filter(function (it) {
        return !dockerPorts[it.ports[0]];
      });
      localRes.count = lItems.length;
      items = items.concat(lItems);
    } else {
      localRes.reason = "当前系统无法读取监听端口（/proc 与 netstat 均不可用）";
    }
  }

  // ---- 3. 补全地址与图标 ----
  items.forEach(function (it) {
    var port = it.ports[0];
    var addrs = buildAddresses(lanHost, wanHost, port);
    it.lanUrl = addrs.lanUrl;
    it.url = addrs.url;
    it.port = port;
    it.extraPorts = it.ports.slice(1);
  });

  if (cfg.probeIcon !== false && cfg.iconProbeEnabled !== false) {
    await resolveAutoIcon(items, cfg.iconProbeTimeout || 1200);
  }

  // ---- 4. 排序：运行中 → 非依赖 → 端口升序 ----
  items.sort(function (a, b) {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.infra !== b.infra) return a.infra ? 1 : -1;
    var ap = a.ports[0] || 0, bp = b.ports[0] || 0;
    if (ap !== bp) return ap - bp;
    return String(a.title).localeCompare(String(b.title));
  });

  return {
    ok: true,
    lanHost: lanHost,
    wanHost: wanHost,
    sources: { docker: dockerRes, local: localRes },
    items: items,
    warnings: warnings
  };
}

module.exports = {
  SERVICE_PRESETS: SERVICE_PRESETS,
  GENERIC_PORTS: GENERIC_PORTS,
  NOISE_PROCESSES: NOISE_PROCESSES,
  parseProcNetTcp: parseProcNetTcp,
  mapSocketInodes: mapSocketInodes,
  scanLocalPorts: scanLocalPorts,
  parseNetstat: parseNetstat,
  scanLocalPortsFallback: scanLocalPortsFallback,
  buildLocalItem: buildLocalItem,
  computeStale: computeStale,
  listContainers: listContainers,
  extractPorts: extractPorts,
  containerName: containerName,
  containersToCandidates: containersToCandidates,
  probeIcon: probeIcon,
  probeUrl: probeUrl,
  resolveAutoIcon: resolveAutoIcon,
  discover: discover,
  normalizeName: normalizeName,
  matchPreset: matchPreset,
  inferIconSlug: inferIconSlug,
  slugify: slugify,
  isLanHost: isLanHost,
  detectLocalIPv4: detectLocalIPv4,
  buildAddresses: buildAddresses,
  portSuffix: portSuffix
};
