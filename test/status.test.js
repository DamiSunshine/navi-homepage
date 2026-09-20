/* Navi 导航站 · 系统状态板（/api/status + status.js）专项测试
   自动启动独立服务实例（无鉴权），使用独立的临时 config 与 uploads 目录。

   覆盖三层：
     ① 纯函数：meminfo / cgroup / CPU 差值 / statfs / 容器计数 —— 不需要真环境；
     ② 注入式：用一个假 Docker Engine API（本机小 HTTP 服务）验证「Docker 可用」
        这条路径，不必真的装 Docker；
     ③ 真服务：降级行为是一等公民 —— 没挂 docker.sock 时必须 available:false 且
        total 为 null（不能给 0，0 会被前端读成「真的没有容器」）。

   用法：node test/status.test.js */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const status = require(path.join(__dirname, "..", "status.js"));

const PORT = 8670;        // 常规实例（无 Docker）
const PORT_DOCKER = 8671; // 假 Docker Engine API 实例
const PORT_OFF = 8672;    // NAVI_STATUS_BOARD=0
const PORT_AUTH = 8673;   // 开启鉴权（验证状态信息不裸奔）
const DOCKER_API_PORT = 8674; // 假 Docker API 自身

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

function request(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: port, path: p, method: method, headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function getJson(port, p) {
  return request(port, "GET", p).then((r) => {
    let json = null;
    try { json = JSON.parse(r.body); } catch (e) {}
    return { status: r.status, headers: r.headers, json: json };
  });
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1" }, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

// 假 Docker Engine API：任何 GET 都回同一份容器列表
const FAKE_CONTAINERS = [
  { Id: "a1", Names: ["/jellyfin"], State: "running", Status: "Up 3 hours" },
  { Id: "b2", Names: ["/qbittorrent"], State: "running", Status: "Up 2 hours" },
  { Id: "c3", Names: ["/nginx"], State: "exited", Status: "Exited (0) 1 day ago" },
  { Id: "d4", Names: ["/old"], State: "paused", Status: "Up 5 minutes (Paused)" },
  { Id: "e5", Names: ["/gone"], State: "dead", Status: "Dead" }
];

function startFakeDocker(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FAKE_CONTAINERS));
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "navi-status-"));
  const cfgPath = path.join(tmpRoot, "config.json");
  const upDir = path.join(tmpRoot, "uploads");
  fs.mkdirSync(path.join(upDir, "favicons"), { recursive: true });
  fs.writeFileSync(path.join(upDir, "a.png"), Buffer.alloc(1234, 7));
  fs.writeFileSync(path.join(upDir, "favicons", "b.png"), Buffer.alloc(456, 9));
  fs.copyFileSync(path.join(path.join(__dirname, ".."), "public", "config.example.json"), cfgPath);

  const baseEnv = {
    NAVI_CONFIG_PATH: cfgPath,
    NAVI_UPLOAD_DIR: upDir,
    NAVI_SCAN_LOCAL: "0",
    NAVI_ICON_PROBE: "0",
    DOCKER_SOCKET: path.join(tmpRoot, "no-such.sock")
  };

  let srv = null, srvDocker = null, srvOff = null, srvAuth = null, fakeDocker = null;
  try {
    /* ============================================================
       ① 纯函数
       ============================================================ */
    console.log("== 纯函数：/proc/meminfo 解析 ==");
    const memTxt = [
      "MemTotal:       16384000 kB",
      "MemFree:         2048000 kB",
      "MemAvailable:    8192000 kB",
      "Buffers:          512000 kB",
      "Cached:          4096000 kB",
      "HugePages_Total:       0"
    ].join("\n");
    const mi = status.parseMeminfo(memTxt);
    check("MemTotal 按 kB 换算成字节", mi.MemTotal === 16384000 * 1024, String(mi.MemTotal));
    check("MemAvailable 按 kB 换算成字节", mi.MemAvailable === 8192000 * 1024, String(mi.MemAvailable));
    check("无 kB 后缀的行也能解析", mi.HugePages_Total === 0, String(mi.HugePages_Total));
    check("空输入返回空对象（不抛）", Object.keys(status.parseMeminfo("")).length === 0);
    check("非字符串输入不抛异常", Object.keys(status.parseMeminfo(null)).length === 0);

    console.log("== 纯函数：cgroup 内存限制 ==");
    check("v2 的 max（不限）→ null", status.parseCgroupLimit("max") === null);
    check("v1 的 -1（不限）→ null", status.parseCgroupLimit("-1") === null);
    check("v1 的天文数字（不限）→ null", status.parseCgroupLimit("9223372036854771712") === null);
    check("正常限制值原样返回", status.parseCgroupLimit("536870912") === 536870912);
    check("空值 → null", status.parseCgroupLimit(null) === null);
    check("非数字 → null", status.parseCgroupLimit("abc") === null);

    console.log("== 纯函数：CPU 占用率差值 ==");
    const pct50 = status.cpuPercentBetween(
      { idle: 100, total: 200 }, { idle: 150, total: 300 });
    check("总 jiffies 走 100、空闲走 50 → 50%", pct50 === 50, String(pct50));
    check("总 jiffies 未前进 → null（测不准 ≠ 0%）",
      status.cpuPercentBetween({ idle: 1, total: 5 }, { idle: 1, total: 5 }) === null);
    check("全程空闲 → 0%",
      status.cpuPercentBetween({ idle: 10, total: 20 }, { idle: 30, total: 40 }) === 0);
    check("busy 为负（快照异常）→ 0 而不是负数",
      status.cpuPercentBetween({ idle: 100, total: 200 }, { idle: 210, total: 260 }) === 0);
    check("缺快照 → null", status.cpuPercentBetween(null, { idle: 1, total: 2 }) === null);
    const snap = status.cpuSnapshot();
    check("cpuSnapshot 的核数与 os.cpus() 一致", snap.cores === os.cpus().length, String(snap.cores));
    check("cpuSnapshot 的 total >= idle", snap.total >= snap.idle);

    console.log("== 纯函数：容器分类计数 ==");
    const sc = status.summarizeContainers(FAKE_CONTAINERS);
    check("running 计 2 个", sc.running === 2, String(sc.running));
    check("paused 计 1 个", sc.paused === 1, String(sc.paused));
    check("exited/dead 归入 stopped 计 2 个", sc.stopped === 2, String(sc.stopped));
    check("total 为 5", sc.total === 5, String(sc.total));
    check("空数组 → 全 0",
      JSON.stringify(status.summarizeContainers([])) ===
      JSON.stringify({ total: 0, running: 0, paused: 0, stopped: 0 }));
    check("非数组输入 → 全 0（不抛）", status.summarizeContainers(null).total === 0);

    console.log("== 注入式：内存水位优先级（cgroup > /proc > os）==");
    const fakeRoot = path.join(tmpRoot, "fakeroot");
    fs.mkdirSync(path.join(fakeRoot, "sys/fs/cgroup"), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, "proc"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "sys/fs/cgroup/memory.max"), "1073741824\n");
    fs.writeFileSync(path.join(fakeRoot, "sys/fs/cgroup/memory.current"), "268435456\n");
    fs.writeFileSync(path.join(fakeRoot, "proc/meminfo"), memTxt);
    const m1 = status.memInfo(fakeRoot);
    check("cgroup-v2 优先于 /proc/meminfo", m1 && m1.source === "cgroup-v2", m1 && m1.source);
    check("cgroup 总量取自 memory.max", m1 && m1.total === 1073741824, m1 && String(m1.total));
    check("cgroup 用量取自 memory.current", m1 && m1.used === 268435456, m1 && String(m1.used));
    check("cgroup 占用率 = used/total", m1 && m1.percent === 25, m1 && String(m1.percent));

    fs.rmSync(path.join(fakeRoot, "sys/fs/cgroup/memory.max"));
    const m2 = status.memInfo(fakeRoot);
    check("cgroup 无限制时退回 /proc/meminfo", m2 && m2.source === "proc", m2 && m2.source);
    check("/proc 路径下 used = total - available",
      m2 && m2.used === 16384000 * 1024 - 8192000 * 1024, m2 && String(m2.used));

    const emptyRoot = path.join(tmpRoot, "emptyroot");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const m3 = status.memInfo(emptyRoot);
    check("既无 cgroup 也无 /proc 时退回 os（通用兜底）", m3 && m3.source === "os", m3 && m3.source);
    check("兜底值仍有正的总量", m3 && m3.total > 0);

    console.log("== 纯函数：磁盘 ==");
    const d1 = status.diskInfo(tmpRoot);
    check("能取到数据盘容量", d1 && d1.total > 0, d1 && String(d1.total));
    check("used + available <= total", d1 && (d1.used + d1.available) <= d1.total,
      d1 && d1.used + "+" + d1.available + " vs " + d1.total);
    check("占用率落在 0..100", d1 && d1.percent >= 0 && d1.percent <= 100, d1 && String(d1.percent));
    check("不存在的路径 → null（不抛）",
      status.diskInfo(path.join(tmpRoot, "definitely-not-here")) === null);
    check("空路径 → null", status.diskInfo(null) === null);

    console.log("== 纯函数：图床库体量 ==");
    const up1 = status.scanUploads(upDir, 5000);
    check("递归统计张数（含子目录）", up1.count === 2, String(up1.count));
    check("字节数 = 1234 + 456", up1.bytes === 1690, String(up1.bytes));
    check("未超上限时 truncated=false", up1.truncated === false);
    const up2 = status.scanUploads(upDir, 1);
    check("超过上限时截断并置 truncated", up2.count === 1 && up2.truncated === true,
      up2.count + "/" + up2.truncated);
    check("空目录 → 0 张且不抛", status.scanUploads(path.join(tmpRoot, "nope"), 10).count === 0);

    console.log("== 注入式：Docker 汇总的降级与成功路径 ==");
    const noConn = await status.dockerSummary({}, null);
    check("未配置连接 → available:false", noConn.available === false);
    check("未配置连接时的 error 给出可操作提示",
      /docker\.sock|DOCKER_HOST_NAME/.test(noConn.error || ""), noConn.error);
    check("未配置连接时 total 为 null（不是 0）", noConn.total === null, String(noConn.total));

    const failed = await status.dockerSummary({ socketPath: "/x" }, async () => ({ ok: false, error: "boom" }));
    check("底层失败 → available:false 且保留原因", failed.available === false && failed.error === "boom");

    const threw = await status.dockerSummary({ socketPath: "/x" }, async () => { throw new Error("ECONNREFUSED"); });
    check("底层抛异常 → 不冒泡，转成 available:false", threw.available === false && /ECONNREFUSED/.test(threw.error));

    const okSum = await status.dockerSummary({ socketPath: "/x" }, async () => ({ ok: true, kind: "tcp", containers: FAKE_CONTAINERS }));
    check("成功 → available:true", okSum.available === true);
    check("成功 → running=2 / total=5", okSum.running === 2 && okSum.total === 5,
      okSum.running + "/" + okSum.total);
    check("成功 → 保留连接方式（tcp/socket）", okSum.via === "tcp", String(okSum.via));

    console.log("== 注入式：缓存与组装（getStatus）==");
    status.clearCache();
    status.resetCpuBaseline();
    const g1 = await status.getStatus({ docker: {}, dockerList: async () => ({ ok: false }), skipUploads: true, ttlMs: 60000 });
    const g2 = await status.getStatus({ docker: {}, dockerList: async () => ({ ok: false }), skipUploads: true, ttlMs: 60000 });
    check("首次调用 cached=false", g1.cached === false);
    check("TTL 内第二次调用复用缓存", g2.cached === true && g2.cacheAgeMs >= 0);
    const g3 = await status.getStatus({ docker: {}, dockerList: async () => ({ ok: false }), skipUploads: true, ttlMs: 60000, fresh: true });
    check("fresh=true 绕过缓存", g3.cached === false);
    status.clearCache();
    const g4 = await status.getStatus({ docker: {}, dockerList: async () => ({ ok: false }), skipUploads: true, ttlMs: 60000 });
    check("clearCache 后重新采集", g4.cached === false);
    check("组装结果 ok:true", g1.ok === true);
    check("组装结果含 host/cpu/mem/disk/docker/navi 六段",
      ["host", "cpu", "mem", "disk", "docker", "navi"].every((k) => g1[k] !== undefined));
    check("cpu.percent 是数字或 null（绝不 NaN）",
      g1.cpu.percent === null || typeof g1.cpu.percent === "number", String(g1.cpu.percent));

    /* ============================================================
       ② 真服务：无 Docker → 必须降级
       ============================================================ */
    console.log("== GET /api/status（无 Docker）==");
    srv = await startServer(PORT, baseEnv);
    const r1 = await getJson(PORT, "/api/status");
    check("状态码 200", r1.status === 200, String(r1.status));
    check("Content-Type 为 JSON",
      /application\/json/.test(r1.headers["content-type"] || ""), r1.headers["content-type"]);
    check("Cache-Control: no-store（状态不能进缓存）",
      /no-store/.test(r1.headers["cache-control"] || ""), r1.headers["cache-control"]);
    check("ok:true", r1.json && r1.json.ok === true);
    check("host.hostname 非空", !!(r1.json && r1.json.host && r1.json.host.hostname));
    check("host 带 platform / arch / node",
      !!(r1.json.host.platform && r1.json.host.arch && r1.json.host.node));
    check("cpu.cores > 0", r1.json.cpu.cores > 0, String(r1.json.cpu.cores));
    check("cpu.percent 在 0..100 或 null",
      r1.json.cpu.percent === null || (r1.json.cpu.percent >= 0 && r1.json.cpu.percent <= 100),
      String(r1.json.cpu.percent));
    check("mem.total > 0（Windows 走 os 兜底也算通过）", r1.json.mem && r1.json.mem.total > 0);
    check("mem.percent 在 0..100", r1.json.mem.percent >= 0 && r1.json.mem.percent <= 100,
      String(r1.json.mem.percent));
    check("disk.total > 0", r1.json.disk && r1.json.disk.total > 0);
    check("disk.path 指向数据目录", r1.json.disk.path === tmpRoot, r1.json.disk.path);
    check("navi.uploads 统计到 2 张图",
      r1.json.navi.uploads && r1.json.navi.uploads.count === 2, JSON.stringify(r1.json.navi.uploads));
    check("navi.uploads 字节数正确",
      r1.json.navi.uploads.bytes === 1690, JSON.stringify(r1.json.navi.uploads));
    check("navi.version 与 APP_VERSION 一致", r1.json.navi.version === "1.1.0", String(r1.json.navi.version));

    check("Docker 不可用时 available:false", r1.json.docker.available === false);
    check("Docker 不可用时 total 为 null（不给假 0）", r1.json.docker.total === null,
      String(r1.json.docker.total));
    check("Docker 不可用时 running 为 null", r1.json.docker.running === null);
    check("Docker 不可用时给出可读原因", /Docker|docker\.sock|DOCKER_HOST_NAME/.test(r1.json.docker.error || ""),
      r1.json.docker.error);

    const r2 = await getJson(PORT, "/api/status");
    check("第二次请求命中服务端缓存（cached=true）", r2.json && r2.json.cached === true,
      r2.json && String(r2.json.cached));
    const r3 = await getJson(PORT, "/api/status?fresh=1");
    check("?fresh=1 绕过缓存（cached=false）", r3.json && r3.json.cached === false);
    check("带参请求不影响结果结构", r3.json.ok === true && !!r3.json.disk);

    /* ============================================================
       ③ 真服务：假 Docker Engine API → 必须报可用的容器数
       ============================================================ */
    console.log("== GET /api/status（假 Docker API 可用）==");
    fakeDocker = await startFakeDocker(DOCKER_API_PORT);
    srvDocker = await startServer(PORT_DOCKER, Object.assign({}, baseEnv, {
      DOCKER_HOST_NAME: "127.0.0.1",
      DOCKER_HOST_PORT: String(DOCKER_API_PORT)
    }));
    const rd = await getJson(PORT_DOCKER, "/api/status");
    check("Docker 可用时 available:true", rd.json && rd.json.docker.available === true,
      JSON.stringify(rd.json && rd.json.docker));
    check("Docker 可用时 running=2", rd.json.docker.running === 2, String(rd.json.docker.running));
    check("Docker 可用时 total=5", rd.json.docker.total === 5, String(rd.json.docker.total));
    check("Docker 可用时 stopped=2", rd.json.docker.stopped === 2, String(rd.json.docker.stopped));
    check("Docker 可用时 paused=1", rd.json.docker.paused === 1, String(rd.json.docker.paused));
    check("Docker 可用时不再带 error", !rd.json.docker.error, String(rd.json.docker.error));

    /* ============================================================
       ④ 真服务：开关与鉴权
       ============================================================ */
    console.log("== NAVI_STATUS_BOARD=0 与鉴权闸门 ==");
    srvOff = await startServer(PORT_OFF, Object.assign({}, baseEnv, { NAVI_STATUS_BOARD: "0" }));
    const roff = await getJson(PORT_OFF, "/api/status");
    check("开关关闭时 200 而不是 404（前端好判断）", roff.status === 200, String(roff.status));
    check("开关关闭时 disabled:true", roff.json && roff.json.disabled === true);
    check("开关关闭时 docker.available:false 并说明原因",
      roff.json.docker.available === false && !!roff.json.docker.error, String(roff.json.docker.error));

    srvAuth = await startServer(PORT_AUTH, Object.assign({}, baseEnv, { NAVI_PASSWORD: "test-pw-123" }));
    const rauth = await request(PORT_AUTH, "GET", "/api/status");
    check("开启鉴权后未登录取状态 → 401（状态信息不裸奔）", rauth.status === 401, String(rauth.status));
    check("401 响应为 JSON 错误体", /未认证/.test(rauth.body), rauth.body.slice(0, 80));
  } finally {
    for (const c of [srv, srvDocker, srvOff, srvAuth]) { try { c && c.kill(); } catch (e) {} }
    try { fakeDocker && fakeDocker.close(); } catch (e) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
