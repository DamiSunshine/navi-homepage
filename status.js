/* ============================================================
   Navi 个人导航站 · 系统状态采集（零依赖，仅内置模块）
   ------------------------------------------------------------
   给首页 Widget 状态板提供数据：容器统计 + 资源水位。

   设计原则（与项目红线一致）：
     1. **任何一项采不到都不算失败**。缺 Docker、非 Linux、无 /proc、
        statfs 不支持 —— 对应字段返回 null 并带 `source`/`error` 说明原因，
        绝不让整个接口 500，也绝不抛异常到调用方。
     2. **不额外拉取昂贵数据**。容器只统计 `State`（不逐个拉 stats），
        磁盘用 `fs.statfsSync`（不遍历目录算大小）。
     3. **短 TTL 缓存**。状态板 30s 轮询，多人同时打开会放大 Docker 压力，
        默认 5s 内复用同一份结果；`fresh` 可绕过（用户手动点刷新时用）。

   本模块与 discovery.js 的关系：Docker 客户端复用 discovery.js 里那套零依赖
   Engine API 客户端（`listContainers`），不重写第二份。为了可测试，这里用
   **注入**的方式拿它（`dockerList`），单测因此不需要真的连 Docker。
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/* ---------- 通用小工具 ---------- */

function clamp(n, lo, hi) {
  if (!isFinite(n)) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : dflt;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; }
}

/* ---------- CPU ---------- */

// 一次 CPU 快照：从 os.cpus() 累加各核的 jiffies（不可读时返回全 0，交由上层判空）
function cpuSnapshot(cpus) {
  const list = cpus || os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of list) {
    const t = (c && c.times) || {};
    idle += toInt(t.idle, 0);
    total += toInt(t.user, 0) + toInt(t.nice, 0) + toInt(t.sys, 0) +
             toInt(t.idle, 0) + toInt(t.irq, 0);
  }
  return { idle: idle, total: total, cores: list.length, at: Date.now() };
}

// 两次快照的差值 → 占用率。总 jiffies 没前进（间隔太短/时钟异常）时返回 null，
// 而不是强行给出 0% —— 「测不准」和「真的很闲」必须能分辨。
function cpuPercentBetween(prev, now) {
  if (!prev || !now) return null;
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  if (!(dTotal > 0)) return null;
  const busy = dTotal - dIdle;
  if (busy <= 0) return 0;
  return round1(clamp((busy / dTotal) * 100, 0, 100));
}

// 模块级基线：服务启动后第一次取状态就能给出真实数字（进程已跑了一段时间）
let cpuPrev = null;

async function cpuUsage(windowMs) {
  const win = toInt(windowMs, 150) > 0 ? toInt(windowMs, 150) : 150;
  let now = cpuSnapshot();

  if (!cpuPrev) {
    // 无基线（服务刚启动 / 刚被 reset）：现场补一次短间隔采样。
    // 代价 ~150ms 且只发生一次，换来的是首屏就能显示一个真实数字，而不是等下一轮轮询。
    await delay(win);
    const after = cpuSnapshot();
    const percent = cpuPercentBetween(now, after);
    cpuPrev = after;
    return { percent: percent, cores: after.cores };
  }

  const elapsed = now.at - cpuPrev.at;
  if (elapsed < win) {
    await delay(win - elapsed);
    now = cpuSnapshot();
  }
  const percent = cpuPercentBetween(cpuPrev, now);
  cpuPrev = now;
  return { percent: percent, cores: now.cores };
}

/* ---------- 内存 ---------- */

// 解析 /proc/meminfo（字段值单位 kB）→ 字节
function parseMeminfo(text) {
  const out = {};
  if (!text) return out;
  const lines = String(text).split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)\s*(kB)?\s*$/);
    if (!m) continue;
    out[m[1]] = toInt(m[2], 0) * 1024;
  }
  return out;
}

// 解析 cgroup 内存限制。v2 的 "max" 表示不限（null）。
function parseCgroupLimit(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s || s === "max" || s === "-1") return null;
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return null;
  // v1 的「不限」是一个天文数字（9223372036854771712）
  if (n > 1024 * 1024 * 1024 * 1024) return null;
  return Math.round(n);
}

// 内存水位。优先级：cgroup（容器视角，最贴近「这个容器能用多少」）> /proc/meminfo > os.*
function memInfo(procRoot) {
  const root = procRoot || "/";

  // ---- cgroup v2 ----
  const v2max = readTextSafe(path.join(root, "sys/fs/cgroup/memory.max"));
  const v2cur = readTextSafe(path.join(root, "sys/fs/cgroup/memory.current"));
  const limit2 = parseCgroupLimit(v2max);
  if (limit2 && v2cur != null) {
    const used = toInt(v2cur, 0);
    if (used > 0) {
      return {
        total: limit2, used: used, available: Math.max(0, limit2 - used),
        percent: round1(clamp((used / limit2) * 100, 0, 100)), source: "cgroup-v2"
      };
    }
  }

  // ---- cgroup v1 ----
  const v1max = readTextSafe(path.join(root, "sys/fs/cgroup/memory/memory.limit_in_bytes"));
  const v1cur = readTextSafe(path.join(root, "sys/fs/cgroup/memory/memory.usage_in_bytes"));
  const limit1 = parseCgroupLimit(v1max);
  if (limit1 && v1cur != null) {
    const used = toInt(v1cur, 0);
    if (used > 0) {
      return {
        total: limit1, used: used, available: Math.max(0, limit1 - used),
        percent: round1(clamp((used / limit1) * 100, 0, 100)), source: "cgroup-v1"
      };
    }
  }

  // ---- /proc/meminfo（Linux 宿主）----
  const mi = parseMeminfo(readTextSafe(path.join(root, "proc/meminfo")));
  const total = mi.MemTotal || 0;
  if (total > 0) {
    let avail = mi.MemAvailable;
    if (!avail) avail = (mi.MemFree || 0) + (mi.Buffers || 0) + (mi.Cached || 0);
    // 兜底：连 MemAvailable/MemFree 都没有时按 MemFree 记 0，仍给出结论
    avail = avail || 0;
    return {
      total: total, used: Math.max(0, total - avail), available: avail,
      percent: round1(clamp(((total - avail) / total) * 100, 0, 100)), source: "proc"
    };
  }

  // ---- 通用兜底（Windows / macOS / 受限容器）----
  const t = os.totalmem(), f = os.freemem();
  if (t > 0) {
    return {
      total: t, used: t - f, available: f,
      percent: round1(clamp(((t - f) / t) * 100, 0, 100)), source: "os"
    };
  }
  return null;
}

/* ---------- 磁盘 ---------- */

function diskInfo(target) {
  if (!target) return null;
  if (typeof fs.statfsSync !== "function") return null;   // Node < 18.15
  let st;
  try { st = fs.statfsSync(target); } catch (e) { return null; }
  if (!st) return null;
  const bsize = toInt(st.bsize, 0);
  const blocks = toInt(st.blocks, 0);
  const bfree = toInt(st.bfree, 0);
  const bavail = toInt(st.bavail, 0);
  if (!(bsize > 0 && blocks > 0)) return null;
  const total = bsize * blocks;
  const available = bsize * bavail;
  const used = bsize * (blocks - bfree);
  return {
    path: String(target),
    total: total,
    used: used >= 0 ? used : 0,
    available: available >= 0 ? available : 0,
    percent: total > 0 ? round1(clamp((used / total) * 100, 0, 100)) : null,
    source: "statfs"
  };
}

/* ---------- Docker ---------- */

// 只统计数量：容器逐个拉 /stats 太贵（每个要 1~2s），状态板不需要那么细
function summarizeContainers(list) {
  const arr = Array.isArray(list) ? list : [];
  let running = 0, paused = 0, stopped = 0;
  for (const c of arr) {
    const s = String((c && c.State) || "").toLowerCase();
    if (s === "running") running++;
    else if (s === "paused" || s === "restarting") paused++;
    else stopped++;
  }
  return { total: arr.length, running: running, paused: paused, stopped: stopped };
}

function defaultDockerList(opts) {
  const discovery = require("./discovery");     // 延迟 require：不用 Docker 的场景不加载
  return discovery.listContainers(opts);
}

// Docker 汇总。无论何种原因采不到，一律返回 available:false + 可读 error，
// 让前端能显示「不可用」而不是显示 0（0 会被误读成「没有容器」）。
async function dockerSummary(dockerOpts, listFn) {
  const d = dockerOpts || {};
  const base = { available: false, running: null, stopped: null, paused: null, total: null };
  if (!d.socketPath && !d.host) {
    return Object.assign({}, base, { error: "未配置 Docker 连接（可挂载 /var/run/docker.sock 或设置 DOCKER_HOST_NAME）" });
  }
  try {
    const lister = typeof listFn === "function" ? listFn : defaultDockerList;
    const r = await lister(d);
    if (!r || !r.ok) return Object.assign({}, base, { error: (r && r.error) || "Docker 不可用" });
    const s = summarizeContainers(r.containers);
    return {
      available: true, running: s.running, stopped: s.stopped, paused: s.paused, total: s.total,
      via: r.kind || null
    };
  } catch (e) {
    return Object.assign({}, base, { error: String((e && e.message) || e) });
  }
}

/* ---------- 图床库体量 ---------- */

// 递归统计张数与总体积。只做 stat（不读内容），并在 cap 处硬停，
// 避免超大目录把状态接口拖慢。超过 cap 时 truncated=true，前端据此显示「N+」。
function scanUploads(dir, cap) {
  const limit = toInt(cap, 5000);
  const out = { count: 0, bytes: 0, truncated: false };
  if (!dir) return out;
  const walk = function (d) {
    let names;
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const name of names) {
      if (out.count >= limit) { out.truncated = true; return; }
      if (path.basename(name) !== name) continue;
      const abs = path.join(d, name);
      let st;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      out.count++;
      out.bytes += st.size;
    }
  };
  walk(dir);
  return out;
}

/* ---------- 汇总 ---------- */

function hostSection() {
  let hostname = "";
  try { hostname = os.hostname(); } catch (e) {}
  const la = typeof os.loadavg === "function" ? os.loadavg() : [0, 0, 0];
  const laOk = process.platform !== "win32" && Array.isArray(la) && la.some(function (v) { return v > 0; });
  return {
    hostname: hostname,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    kernel: (os.release ? os.release() : ""),
    uptimeSec: Math.round(os.uptime ? os.uptime() : 0),
    // Windows 上 loadavg 恒为 0，直接置 null 比给个假的 0 诚实
    loadavg: laOk ? la.map(round1) : null
  };
}

async function buildStatus(o) {
  const opts = o || {};
  const cpu = await cpuUsage(opts.cpuWindowMs);
  const docker = await dockerSummary(opts.docker, opts.dockerList);
  const uploads = opts.skipUploads ? null : scanUploads(opts.uploadsDir, opts.uploadsCap);

  return {
    ok: true,
    at: new Date().toISOString(),
    host: hostSection(),
    cpu: { cores: cpu.cores, percent: cpu.percent, source: cpu.percent === null ? null : "delta" },
    mem: memInfo(opts.procRoot),
    disk: diskInfo(opts.dataDir || opts.uploadsDir),
    docker: docker,
    navi: {
      version: opts.version || null,
      uptimeSec: Math.round(process.uptime()),
      dataDir: opts.dataDir ? String(opts.dataDir) : null,
      uploads: uploads
    }
  };
}

let cache = { at: 0, data: null };

async function getStatus(o) {
  const opts = o || {};
  const ttl = toInt(opts.ttlMs, 5000);
  if (!opts.fresh && cache.data && (Date.now() - cache.at) < ttl) {
    return Object.assign({}, cache.data, { cached: true, cacheAgeMs: Date.now() - cache.at });
  }
  const data = await buildStatus(opts);
  cache = { at: Date.now(), data: data };
  return Object.assign({}, data, { cached: false, cacheAgeMs: 0 });
}

function clearCache() { cache = { at: 0, data: null }; }
function resetCpuBaseline() { cpuPrev = null; }

module.exports = {
  getStatus: getStatus,
  buildStatus: buildStatus,
  clearCache: clearCache,
  resetCpuBaseline: resetCpuBaseline,
  // 纯函数（供单测直接验证，不需要真环境）
  cpuSnapshot: cpuSnapshot,
  cpuPercentBetween: cpuPercentBetween,
  parseMeminfo: parseMeminfo,
  parseCgroupLimit: parseCgroupLimit,
  memInfo: memInfo,
  diskInfo: diskInfo,
  summarizeContainers: summarizeContainers,
  dockerSummary: dockerSummary,
  scanUploads: scanUploads,
  hostSection: hostSection
};
