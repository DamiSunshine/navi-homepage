/* Navi 导航站 · 服务发现专项测试
   覆盖两层：
     A. discovery.js 纯函数（指纹匹配 / 地址拼装 / 端口解析 / 噪声过滤）
     B. /api/discover 端到端：启动独立实例 + 伪造 Docker API（TCP 回退路径）
        验证容器发现、图标匹配、地址生成、added 去重、只读性、鉴权
   全程使用临时 config 与临时目录，不触碰真实数据，也不联网（NAVI_ICON_PROBE=0）。
   用法：node test/discover.test.js */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const D = require(path.join(__dirname, "..", "discovery.js"));

// 端口与其他测试套件错开：server 8632 / backup 8644 / ui-auth 8655
const FAKE_DOCKER_PORT = 8670;
const NAVI_PORT = 8671;
const NAVI_AUTH_PORT = 8672;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

function request(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()
        }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

/* ---------- 伪造 Docker Engine API ---------- */
const FAKE_CONTAINERS = [
  {
    Id: "aaaa11112222", Names: ["/jellyfin"], Image: "linuxserver/jellyfin:latest",
    State: "running", Status: "Up 2 hours",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 8096, PublicPort: 8096, Type: "tcp" }]
  },
  {
    Id: "bbbb33334444", Names: ["/portainer"], Image: "portainer/portainer-ce:latest",
    State: "running", Status: "Up 3 hours",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 9443, PublicPort: 9443, Type: "tcp" }]
  },
  {
    Id: "cccc55556666", Names: ["/searxng-redis"], Image: "redis:7-alpine",
    State: "running", Status: "Up 3 hours",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 6379, PublicPort: 16379, Type: "tcp" }]
  },
  {
    Id: "dddd77778888", Names: ["/my-nginx"], Image: "nginx:alpine",
    State: "running", Status: "Up 1 hour", Ports: []          // 无端口 → 应跳过
  },
  {
    Id: "eeee9999aaaa", Names: ["/legacy-app"], Image: "foo/legacy",
    State: "exited", Status: "Exited (0) 2 days ago",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 8080, PublicPort: 18080, Type: "tcp" }]
  },
  {
    Id: "ffffbbbbcccc", Names: ["/qbittorrent"], Image: "linuxserver/qbittorrent:latest",
    State: "running", Status: "Up 5 hours",
    Ports: [{ IP: "0.0.0.0", PrivatePort: 8081, PublicPort: 8081, Type: "tcp" },
            { IP: "0.0.0.0", PrivatePort: 6881, PublicPort: 6881, Type: "udp" }]  // udp 应忽略
  }
];

function startFakeDocker(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.indexOf("/containers/json") === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FAKE_CONTAINERS));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

/* ---------- 测试用配置 ---------- */
const BASE_CONFIG = {
  site: { title: "DiscoverTest", subtitle: "服务发现测试" },
  groups: [
    { name: "常用服务", items: [
      { title: "Jellyfin", desc: "影音媒体库", icon: "jellyfin",
        url: "http://192.168.1.10:8096", lanUrl: "http://192.168.1.10:8096" }
    ] }
  ]
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "navi-discover-"));
const cfgPath = path.join(tmpRoot, "config.json");
const upDir = path.join(tmpRoot, "uploads");
fs.mkdirSync(upDir, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");
const configBefore = fs.readFileSync(cfgPath, "utf-8");

let fakeDocker = null;
let navi = null;
let naviAuth = null;

function cleanup() {
  [navi, naviAuth].forEach((c) => { try { if (c) c.kill(); } catch (e) {} });
  try { if (fakeDocker) fakeDocker.close(); } catch (e) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  /* ==================== A. 纯函数 ==================== */
  console.log("== A1. 名称归一化 ==");
  check("registry/namespace/tag 全部剥离",
    D.normalizeName("linuxserver/jellyfin:latest") === "jellyfin" &&
    D.normalizeName("ghcr.io/x/y/uptime-kuma:1.23") === "uptime-kuma",
    D.normalizeName("ghcr.io/x/y/uptime-kuma:1.23"));
  check("容器名前导斜杠剥离", D.normalizeName("/jellyfin") === "jellyfin", D.normalizeName("/jellyfin"));
  check("副本后缀剥离", D.normalizeName("fastgithub-fastgithub-1") === "fastgithub-fastgithub",
    D.normalizeName("fastgithub-fastgithub-1"));

  console.log("== A2. 服务指纹匹配（图标自动匹配的核心） ==");
  const m1 = D.matchPreset(["linuxserver/jellyfin"], [8096]);
  check("镜像名命中 Jellyfin 且带图标", !!m1 && m1.name === "Jellyfin" && m1.icon === "jellyfin",
    JSON.stringify(m1 && { n: m1.name, i: m1.icon }));
  const m2 = D.matchPreset(["portainer/portainer-ce"], [9443]);
  check("Portainer 使用 selfhst 图标源", !!m2 && m2.icon === "selfhst:portainer", m2 && m2.icon);
  // 真实流程下名称列表为 [镜像名, 容器名]，镜像名优先——redis:7 命中 Redis，
  // 而非同名容器 searxng-redis 的 SearXNG 子串
  const m3 = D.matchPreset(["redis:7-alpine", "/searxng-redis"], [16379]);
  check("镜像名优先于容器名命中（Redis 而非 SearXNG）", !!m3 && m3.name === "Redis", m3 && m3.name);
  const m4 = D.matchPreset(["redis"], [6379]);
  check("依赖容器被标记 infra", !!m4 && m4.infra === true, JSON.stringify(m4 && { n: m4.name, i: m4.infra }));
  const m5 = D.matchPreset(["alist"], [5244]);
  check("Alist 使用 Iconify 图标源",
    !!m5 && m5.icon === "iconify:simple-icons:alist", m5 && m5.icon);
  check("通用端口不误判（8000 独用不命中 Portainer）",
    D.matchPreset(["unknown-svc"], [8000]) === null);
  check("无法识别时返回 null（交由 slug 探测 / 字母回退）",
    D.matchPreset(["totally-unknown-thing"], [17777]) === null);
  check("my-grafana 这类前缀也能命中", (D.matchPreset(["my-grafana"], []) || {}).name === "Grafana");

  console.log("== A3. 图标 slug 兜底 ==");
  check("从镜像名推导 slug", D.inferIconSlug(["myapp/server:1.0"]) === "server",
    D.inferIconSlug(["myapp/server:1.0"]));
  check("从容器名推导 slug", D.inferIconSlug(["/Jellyfin-2"]) === "jellyfin",
    D.inferIconSlug(["/Jellyfin-2"]));
  check("空输入返回空串", D.inferIconSlug([""]) === "");

  console.log("== A4. 地址拼装（对齐自动补全规则） ==");
  const a1 = D.buildAddresses("192.168.1.10", "", 8096);
  check("仅内网：http:// + 端口", a1.lanUrl === "http://192.168.1.10:8096", JSON.stringify(a1));
  check("无外网地址时用内网兜底（保证 url 必填校验通过）",
    a1.url === "http://192.168.1.10:8096", a1.url);
  const a2 = D.buildAddresses("192.168.1.10", "media.example.com", 8096);
  check("域名走 https 且不追加端口", a2.url === "https://media.example.com", a2.url);
  const a3 = D.buildAddresses("192.168.1.10", "1.2.3.4", 8096);
  check("公网 IP 走 http 且追加端口", a3.url === "http://1.2.3.4:8096", a3.url);
  const a4 = D.buildAddresses("192.168.1.10", "example.com", 80);
  check("80 端口省略端口号", a4.url === "https://example.com" && a4.lanUrl === "http://192.168.1.10",
    JSON.stringify(a4));
  const a5 = D.buildAddresses("192.168.1.10", "media.example.com:8443", 8096);
  check("带端口域名只取主机名", a5.url === "https://media.example.com", a5.url);

  console.log("== A5. 内外网判定（含 IPv6） ==");
  check("私网 IPv4 判定", D.isLanHost("192.168.1.10") && D.isLanHost("10.0.0.5") && D.isLanHost("172.20.3.4"));
  check("非私网 IPv4 判定", !D.isLanHost("8.8.8.8") && !D.isLanHost("172.32.0.1"));
  check("IPv4:端口 形式剥离端口", D.isLanHost("192.168.1.10:8080"));
  check("IPv6 本机 / ULA / 链路本地",
    D.isLanHost("::1") && D.isLanHost("[::1]") && D.isLanHost("fd00::1") && D.isLanHost("fe80::1"));
  check("域名不算内网", !D.isLanHost("media.example.com"));

  console.log("== A6. /proc/net/tcp 解析（仅 LISTEN） ==");
  const procText = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1 0 100 0 0 10 0",
    "   1: 0100007F:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0 100 0 0 10 0",
    "   2: 0100007F:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 333 1 0 100 0 0 10 0",
    "   3: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 444 1 0 100 0 0 10 0"
  ].join("\n");
  const procParsed = D.parseProcNetTcp(procText);
  check("hex 端口正确解码（1F90=8080, 2382=9090, 0050=80）",
    procParsed.map((x) => x.port).join(",") === "8080,9090,80",
    procParsed.map((x) => x.port).join(","));
  check("非 LISTEN(01) 记录被忽略", procParsed.length === 3, procParsed.length);
  check("inode 被正确提取", procParsed[0].inode === 111, procParsed[0].inode);

  console.log("== A7. netstat 解析（Windows / Unix 两种格式） ==");
  const winNetstat = [
    "活动连接", "",
    "  协议  本地地址          外部地址        状态           PID",
    "  TCP    0.0.0.0:8096           0.0.0.0:0              LISTENING       4321",
    "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       5678",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       999",
    "  UDP    0.0.0.0:6881           *:*                                    111"
  ].join("\n");
  const winParsed = D.parseNetstat(winNetstat, true);
  check("Windows 格式解析出监听端口与 PID",
    winParsed.length === 3 && winParsed[0].port === 8096 && winParsed[0].pid === 4321,
    JSON.stringify(winParsed));
  check("UDP 行被忽略", !winParsed.some((x) => x.port === 6881));

  const unixNetstat = [
    "tcp4       0      0  127.0.0.1.8096         *.*                    LISTEN",
    "tcp6       0      0  *.5244                 *.*                    LISTEN",
    "tcp4       0      0  192.168.1.10.22        10.0.0.1.50000         ESTABLISHED"
  ].join("\n");
  const unixParsed = D.parseNetstat(unixNetstat, false);
  check("Unix 格式解析（点号分隔端口）",
    unixParsed.map((x) => x.port).join(",") === "8096,5244",
    unixParsed.map((x) => x.port).join(","));
  check("ESTABLISHED 行被忽略", unixParsed.length === 2, unixParsed.length);

  console.log("== A8. 本机条目构造与噪声过滤 ==");
  check("系统进程 svchost 被过滤", D.buildLocalItem(135, "svchost") === null);
  check("systemd 被过滤", D.buildLocalItem(80, "systemd") === null);
  const li = D.buildLocalItem(8096, "jellyfin");
  check("指纹命中生成正确条目",
    !!li && li.title === "Jellyfin" && li.icon === "jellyfin" && li.source === "local",
    JSON.stringify(li && { t: li.title, i: li.icon }));
  const li2 = D.buildLocalItem(8080, "myapp");
  check("常见 Web 端口即使不识别也保留", !!li2 && li2.port === 8080, JSON.stringify(li2 && li2.id));
  check("高位随机端口且不识别 → 丢弃", D.buildLocalItem(49152, "myapp") === null);

  console.log("== A9. Docker 容器转换 ==");
  check("udp 端口忽略、published 优先",
    JSON.stringify(D.extractPorts({
      Ports: [
        { PrivatePort: 8096, PublicPort: 18096, Type: "tcp" },
        { PrivatePort: 6881, PublicPort: 6881, Type: "udp" }
      ]
    }).published) === "[18096]");
  check("无 published 时退回 exposed", JSON.stringify(D.extractPorts({
    Ports: [{ PrivatePort: 3000, Type: "tcp" }]
  }).usable) === "[3000]");
  const conv = D.containersToCandidates(FAKE_CONTAINERS, {});
  check("无端口容器被跳过（6 个容器 → 5 个候选）", conv.length === 5, conv.length);
  check("容器标题来自服务指纹",
    conv.some((c) => c.title === "Jellyfin") && conv.some((c) => c.title === "Portainer"),
    conv.map((c) => c.title).join(","));
  check("已停止容器被标记 running:false",
    (conv.filter((c) => c.container === "legacy-app")[0] || {}).running === false);
  check("依赖容器标记 infra",
    (conv.filter((c) => c.container === "searxng-redis")[0] || {}).infra === true);

  /* ==================== B. 端到端 ==================== */
  console.log("== B1. /api/discover 端到端（伪造 Docker API） ==");
  fakeDocker = await startFakeDocker(FAKE_DOCKER_PORT);
  navi = await startServer(NAVI_PORT, {
    NAVI_CONFIG_PATH: cfgPath,
    NAVI_UPLOAD_DIR: upDir,
    NAVI_PASSWORD: "",
    NAVI_PASSWORD_HASH: "",
    NAVI_ICON_PROBE: "0",             // 测试不联网
    NAVI_SCAN_LOCAL: "0",             // 本机扫描关掉，保证结果确定性
    NAVI_LAN_HOST: "192.168.1.10",
    NAVI_WAN_HOST: "nav.example.com",
    DOCKER_SOCKET: path.join(tmpRoot, "no-such.sock"),   // 先失败 → 回退 TCP
    DOCKER_HOST_NAME: "127.0.0.1",
    DOCKER_HOST_PORT: String(FAKE_DOCKER_PORT)
  });

  const r = await request(NAVI_PORT, "GET", "/api/discover");
  check("GET /api/discover -> 200", r.status === 200, String(r.status));
  const body = JSON.parse(r.body);
  check("返回 ok:true", body.ok === true);
  check("Docker 经 TCP 回退后可用",
    body.sources.docker.available === true && body.sources.docker.connection === "tcp",
    JSON.stringify(body.sources.docker));
  check("容器候选全部返回（5 项）", body.items.length === 5, body.items.length);

  const jf = body.items.filter((it) => it.title === "Jellyfin")[0];
  check("Jellyfin 图标自动匹配", !!jf && jf.icon === "jellyfin", jf && jf.icon);
  check("Jellyfin 内网地址自动拼装（IP + 映射端口）",
    !!jf && jf.lanUrl === "http://192.168.1.10:8096", jf && jf.lanUrl);
  check("Jellyfin 外网地址走 https 且无端口",
    !!jf && jf.url === "https://nav.example.com", jf && jf.url);
  check("已存在于导航配置的项被标记 added",
    !!jf && jf.added === true && jf.selected === false, jf && JSON.stringify({ a: jf.added, s: jf.selected }));

  const pt = body.items.filter((it) => it.title === "Portainer")[0];
  check("Portainer 使用 selfhst 图标", !!pt && pt.icon === "selfhst:portainer", pt && pt.icon);
  check("Portainer 内网地址带映射端口",
    !!pt && pt.lanUrl === "http://192.168.1.10:9443", pt && pt.lanUrl);

  const rd = body.items.filter((it) => it.title === "Redis")[0];
  check("依赖容器默认不勾选", !!rd && rd.infra === true && rd.selected === false,
    rd && JSON.stringify({ i: rd.infra, s: rd.selected }));

  const qb = body.items.filter((it) => it.title === "qBittorrent")[0];
  check("qBittorrent 图标自动匹配", !!qb && qb.icon === "q-bittorrent", qb && qb.icon);
  check("udp 端口未污染卡片端口", !!qb && qb.port === 8081, qb && qb.port);

  const lg = body.items.filter((it) => it.container === "legacy-app")[0];
  check("已停止容器排在运行中之后且不默认勾选",
    !!lg && lg.running === false && lg.selected === false && body.items[body.items.length - 1].running === false,
    lg && JSON.stringify({ r: lg.running, s: lg.selected }));

  check("无端口容器未生成卡片", !body.items.some((it) => it.container === "my-nginx"));
  check("运行中项默认勾选",
    body.items.filter((it) => it.running && !it.infra && !it.added).every((it) => it.selected === true));
  check("每项都有 http(s) 地址（满足 config 校验）",
    body.items.every((it) => /^https?:\/\//.test(it.url)));
  check("返回 ignored / settings / capabilities",
    Array.isArray(body.ignored) &&
    body.settings.lanHost === "192.168.1.10" && body.settings.wanHost === "nav.example.com" &&
    body.capabilities.iconProbe === false,
    JSON.stringify({ ig: body.ignored, s: body.settings, c: body.capabilities }));

  check("发现接口是只读的（config.json 未被改动）",
    fs.readFileSync(cfgPath, "utf-8") === configBefore);

  const noProbe = JSON.parse((await request(NAVI_PORT, "GET", "/api/discover?probe=0")).body);
  check("probe=0 参数生效且不影响结果", noProbe.ok === true && noProbe.items.length === 5);

  const postRes = await request(NAVI_PORT, "POST", "/api/discover");
  check("POST /api/discover -> 405", postRes.status === 405, String(postRes.status));

  console.log("== B2. Docker 不可用时的降级表现 ==");
  const navi2 = await startServer(NAVI_PORT + 100, {
    NAVI_CONFIG_PATH: cfgPath,
    NAVI_UPLOAD_DIR: upDir,
    NAVI_PASSWORD_HASH: "",
    NAVI_ICON_PROBE: "0",
    NAVI_SCAN_LOCAL: "0",
    DOCKER_SOCKET: path.join(tmpRoot, "definitely-missing.sock")
  });
  try {
    const r2 = await request(NAVI_PORT + 100, "GET", "/api/discover");
    const b2 = JSON.parse(r2.body);
    check("Docker 不可用时仍返回 200（不崩溃）", r2.status === 200 && b2.ok === true, String(r2.status));
    check("明确给出不可用原因",
      b2.sources.docker.available === false && typeof b2.sources.docker.reason === "string" &&
      b2.sources.docker.reason.length > 0, JSON.stringify(b2.sources.docker));
    check("原因中包含可操作提示（挂载 docker.sock）",
      /docker\.sock|挂载/.test(b2.sources.docker.reason), b2.sources.docker.reason);
    check("warnings 汇总提示", Array.isArray(b2.warnings) && b2.warnings.length === 1, JSON.stringify(b2.warnings));
    check("无服务时 items 为空数组", Array.isArray(b2.items) && b2.items.length === 0);
  } finally { try { navi2.kill(); } catch (e) {} }

  console.log("== B3. 鉴权（服务发现同样受密码保护） ==");
  naviAuth = await startServer(NAVI_AUTH_PORT, {
    NAVI_CONFIG_PATH: cfgPath,
    NAVI_UPLOAD_DIR: upDir,
    NAVI_PASSWORD: "discover-test-pw",
    NAVI_ICON_PROBE: "0",
    DOCKER_SOCKET: path.join(tmpRoot, "no-such.sock")
  });
  const anon = await request(NAVI_AUTH_PORT, "GET", "/api/discover");
  check("未认证访问 /api/discover -> 401", anon.status === 401, String(anon.status));
  const login = await request(NAVI_AUTH_PORT, "POST", "/api/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "discover-test-pw" })
  });
  check("登录成功", login.status === 200, `${login.status} ${login.body}`);
  const cookie = (login.headers["set-cookie"] || [])[0] || "";
  const authed = await request(NAVI_AUTH_PORT, "GET", "/api/discover", {
    headers: { Cookie: cookie.split(";")[0] }
  });
  check("认证后访问 /api/discover -> 200", authed.status === 200, String(authed.status));

  console.log("== C. 图标在线探测：协议处理与并发（本地桩服务，不联网） ==");
  {
    // 本地桩服务：/walkxcode/* 一律 404，/selfhst/* 一律 200 —— 用来验证图标源回退，
    // 同时把 https 场景也覆盖掉（不需要真联网，也不需要证书）。
    let delayMs = 0;
    const stub = http.createServer((req, res) => {
      const reply = () => {
        const hit = req.url.indexOf("/selfhst/") === 0;
        res.writeHead(hit ? 200 : 404);
        res.end(hit ? "ok" : "");
      };
      if (delayMs) setTimeout(reply, delayMs); else reply();
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = stub.address().port;
    process.env.NAVI_ICON_PROBE_BASE = "http://127.0.0.1:" + stubPort + "/";

    // C1. 回归：https:// 传给 http.request 会【同步抛】ERR_INVALID_PROTOCOL，
    //     错误回调接不住，会把整次服务发现打挂（线上表现为
    //     「服务发现失败：Protocol "https:" not supported. Expected "http:"」）。
    let threw = null, httpsResult = null;
    try { httpsResult = await D.probeUrl("https://127.0.0.1:1/none.png", 600); }
    catch (e) { threw = e; }
    check("https 地址探测不抛异常（回归用例）", threw === null, threw && threw.message);
    check("https 探测连不上时降级为 false（不影响其余条目）", httpsResult === false, String(httpsResult));

    // C2. 基本语义
    check("http 200 → true", (await D.probeUrl("http://127.0.0.1:" + stubPort + "/selfhst/x.png", 800)) === true);
    check("http 404 → false", (await D.probeUrl("http://127.0.0.1:" + stubPort + "/walkxcode/x.png", 800)) === false);
    check("端口拒绝连接 → false 而非抛错", (await D.probeUrl("http://127.0.0.1:1/x.png", 800)) === false);

    // C3. 图标源回退：dashboard 未命中 → selfhst
    check("dashboard 404 时回退 selfhst", (await D.probeIcon("stub-fallback-probe", 800)) === "selfhst");

    // C4. 并发：12 个 slug，每个要走 2 次请求、每次 250ms。
    //     串行 ≈ 6000ms；并发上限 6 应 ≈ 1000ms。阈值取 2500ms 有足够区分度。
    delayMs = 250;
    const concItems = [];
    for (let i = 0; i < 12; i++) concItems.push({ icon: "", iconSlug: "conc-probe-" + i });
    const t0 = Date.now();
    await D.resolveAutoIcon(concItems, 2000);
    const cost = Date.now() - t0;
    check("图标探测并发执行（12 slug × 2 请求 × 250ms，耗时 < 2500ms）", cost < 2500, cost + "ms");
    check("并发下每个条目各自写入正确图标（顺序不受影响）",
      concItems.every((it) => it.icon === "selfhst:" + it.iconSlug),
      JSON.stringify(concItems.map((i) => i.icon).slice(0, 3)));
    delayMs = 0;

    delete process.env.NAVI_ICON_PROBE_BASE;
    await new Promise((r) => stub.close(r));
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  cleanup();
  process.exit(1);
});
