/* Navi 导航站 · 本地图床库 专项测试
   自动启动独立服务实例，并使用独立的临时 config 与 uploads 目录，
   全程不触碰真实的 public/config.json 与 public/uploads/。
   覆盖：空库列表 / 批量上传（部分成功、逐条原因、文件名清洗、落盘）/ 引用统计 /
        删除的引用保护与强制删除 / 非法文件名与路径穿越 / 批次与体积上限 / 单张接口兼容 / 鉴权。
   用法：node test/library.test.js */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 8690;
const PORT_AUTH = 8691;
const PASSWORD = "lib-test-pw";

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

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

// 1x1 透明 PNG（合法图片魔数 89 50 4E 47）
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const BASE_CONFIG = {
  site: { title: "LibraryTest", subtitle: "图床库测试" },
  groups: [
    { name: "G1", items: [{ title: "Alpha", url: "https://alpha.example.com" }] }
  ]
};

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-library-test-"));
  const tmpConfig = path.join(tmpDir, "config.json");
  const tmpUploads = path.join(tmpDir, "uploads");
  fs.mkdirSync(tmpUploads, { recursive: true });
  fs.writeFileSync(tmpConfig, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");
  // 干扰文件：非图片应被图床库列表忽略
  fs.writeFileSync(path.join(tmpUploads, "notes.txt"), "not an image", "utf-8");

  const commonEnv = {
    NAVI_CONFIG_PATH: tmpConfig,
    NAVI_UPLOAD_DIR: tmpUploads,
    NAVI_SCAN_LOCAL: "0"
  };

  let srv = null, srvAuth = null;
  try {
    srv = await startServer(PORT, commonEnv);

    console.log("== 图床库列表（空库） ==");
    let r = await request(PORT, "GET", "/api/library");
    let lib = JSON.parse(r.body);
    check("空库 -> 200 且 ok=true", r.status === 200 && lib.ok === true, r.status + " " + r.body);
    check("非图片文件被忽略（notes.txt 不入库）", lib.count === 0, JSON.stringify(lib.images));
    check("返回内置本地图标库（>=200 个，离线可用）",
      Array.isArray(lib.presets) && lib.presets.length >= 200, lib.presets && lib.presets.length);
    check("预设项含 name/icon 字段",
      lib.presets.every((p) => p.name && p.icon), JSON.stringify(lib.presets[0]));
    check("预设项标记为本地图标（前端据此走本地优先）",
      lib.presets.every((p) => p.local === true), JSON.stringify(lib.presets[0]));
    check("返回上传目录与限额信息",
      typeof lib.dir === "string" && lib.limits && lib.limits.maxFiles > 0 && lib.limits.maxSize > 0,
      JSON.stringify(lib.limits));

    console.log("== 批量上传（部分成功语义） ==");
    const batch = [
      { name: "GitHub.png", dataUrl: "data:image/png;base64," + PNG_B64 },
      { name: "百度 图标.png", dataUrl: "data:image/png;base64," + PNG_B64 },
      { name: "fake.jpg", dataUrl: "data:image/jpeg;base64," + PNG_B64 },          // 声明 jpeg 实为 png
      { name: "readme.txt", dataUrl: "data:image/png;base64," + Buffer.from("hello").toString("base64") }
    ];
    r = await request(PORT, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: batch })
    });
    const up = JSON.parse(r.body);
    check("批量上传 -> 200 且部分成功（2 成功 / 2 失败）",
      r.status === 200 && up.success === 2 && up.failed === 2, r.status + " " + r.body);
    check("失败项带逐条可读原因",
      up.results.filter((x) => !x.ok).every((x) => typeof x.error === "string" && x.error.length > 0),
      JSON.stringify(up.results));
    check("成功项带 /uploads/ 地址与落盘文件名",
      up.results.filter((x) => x.ok).every((x) => x.url.indexOf("/uploads/") === 0 && !!x.name),
      JSON.stringify(up.results));
    const names = up.results.filter((x) => x.ok).map((x) => x.name);
    check("文件名被清洗为安全字符集（中文名不会破坏命名）",
      names.length === 2 && names.every((n) => /^[a-z0-9-]+\.png$/.test(n)), names.join(","));
    check("英文原始名保留可读前缀（github-…）",
      names.some((n) => n.indexOf("github-") === 0), names.join(","));
    check("两张图片确实落盘",
      names.length === 2 && names.every((n) => fs.existsSync(path.join(tmpUploads, n))), names.join(","));

    console.log("== 列表 / 引用统计 ==");
    r = await request(PORT, "GET", "/api/library");
    lib = JSON.parse(r.body);
    check("列表返回 2 张图片", lib.count === 2, lib.count);
    check("列表按修改时间倒序（最新在上）",
      lib.images.length === 2 && lib.images[0].mtime >= lib.images[1].mtime,
      lib.images.map((i) => i.mtime).join(","));
    check("未引用的图片标记 used=false",
      lib.images.every((im) => im.used === false && im.usedBy.length === 0));
    const first = lib.images[0];
    check("列表项含 url / size / ext / mtime",
      first.url === "/uploads/" + first.name && first.size > 0 && first.ext === "png" && first.mtime > 0,
      JSON.stringify(first));

    console.log("== 单张写法兼容 ==");
    r = await request(PORT, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "single-icon", dataUrl: "data:image/png;base64," + PNG_B64 })
    });
    const one = JSON.parse(r.body);
    check("单张写法 { name, dataUrl } 亦可（success=1）",
      r.status === 200 && one.success === 1, r.status + " " + r.body);
    const usedName = one.results[0].name;
    check("单张上传沿用原始名 slug 前缀", /^single-icon-/.test(usedName), usedName);

    console.log("== 引用保护与强制删除 ==");
    const cfg2 = JSON.parse(JSON.stringify(BASE_CONFIG));
    cfg2.groups[0].items[0].logo = "/uploads/" + usedName;
    r = await request(PORT, "PUT", "/api/config", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg2)
    });
    check("配置写入成功（Alpha 卡片引用该图）", r.status === 200, r.status + " " + r.body);

    r = await request(PORT, "GET", "/api/library");
    lib = JSON.parse(r.body);
    const usedImg = lib.images.filter((im) => im.name === usedName)[0];
    check("列表中该图标标记为使用中并给出引用卡片名",
      !!usedImg && usedImg.used === true && usedImg.usedBy.indexOf("Alpha") >= 0, JSON.stringify(usedImg));

    r = await request(PORT, "POST", "/api/library/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: usedName })
    });
    const del = JSON.parse(r.body);
    check("删除被引用的图片 -> 409 且返回引用清单",
      r.status === 409 && del.ok === false && Array.isArray(del.usedBy) && del.usedBy.indexOf("Alpha") >= 0,
      r.status + " " + r.body);
    check("被拒绝时文件仍在磁盘上", fs.existsSync(path.join(tmpUploads, usedName)));

    r = await request(PORT, "POST", "/api/library/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: usedName, force: true })
    });
    check("force=true 可强制删除且文件消失",
      r.status === 200 && !fs.existsSync(path.join(tmpUploads, usedName)), r.status + " " + r.body);

    console.log("== 非法输入防护 ==");
    for (const bad of ["../config.json", "..\\config.json", "config.json", "sub/evil.png", ""]) {
      r = await request(PORT, "POST", "/api/library/delete", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: bad })
      });
      check("拒绝删除非法文件名 " + JSON.stringify(bad), r.status === 400, r.status + " " + r.body);
    }
    check("非法删除未波及真实配置文件", fs.existsSync(tmpConfig));

    r = await request(PORT, "POST", "/api/library/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "not-exist.png" })
    });
    check("删除不存在的图片 -> 404", r.status === 404, r.status + " " + r.body);

    console.log("== 批次 / 体积上限 ==");
    const many = [];
    for (let i = 0; i < 21; i++) {
      many.push({ name: "m" + i, dataUrl: "data:image/png;base64," + PNG_B64 });
    }
    r = await request(PORT, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: many })
    });
    check("单次超过 20 张 -> 413", r.status === 413 && /最多上传/.test(r.body), r.status + " " + r.body);

    const bigBuf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.alloc(3 * 1024 * 1024 + 32)
    ]);
    r = await request(PORT, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ name: "big", dataUrl: "data:image/png;base64," + bigBuf.toString("base64") }] })
    });
    const big = JSON.parse(r.body);
    check("单张超过 3MB -> 该张失败且给出原因",
      r.status === 200 && big.success === 0 && big.failed === 1 && /过大/.test(big.results[0].error),
      r.status + " " + r.body);

    // 请求体整体超出上限。分两种情况：
    //   A. 浏览器/前端发送 JSON 字符串时一定带 Content-Length → 服务端按声明长度提前拒绝，返回明确 413；
    //   B. 分块传输（chunked，无 Content-Length）→ 服务端读到上限即中断连接。
    // 两种情况的共同底线都是：不落盘、服务不崩（见下一个断言）。
    const hugeName = "huge-body-icon";
    const hugeBody = JSON.stringify({
      files: [{
        name: hugeName,
        dataUrl: "data:image/png;base64," + Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
          Buffer.alloc(13 * 1024 * 1024)
        ]).toString("base64")
      }]
    });
    r = await request(PORT, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(hugeBody) },
      body: hugeBody
    });
    check("超大请求体（带 Content-Length，浏览器行为）-> 413 且带可读原因",
      r.status === 413 && /过大/.test(r.body), r.status + " " + String(r.body).slice(0, 160));

    try {
      await request(PORT, "POST", "/api/library/upload", {
        headers: { "Content-Type": "application/json" },
        body: hugeBody
      });
    } catch (e) {
      // 分块传输下连接被中断属于预期行为，由下一个断言统一验证「未落盘 + 服务存活」
    }
    r = await request(PORT, "GET", "/api/library");
    check("超大请求之后服务仍存活且未落盘",
      r.status === 200 && !fs.readdirSync(tmpUploads).some((f) => f.indexOf(hugeName) === 0),
      r.status);

    console.log("== 与既有单张上传接口的兼容 ==");
    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + PNG_B64 })
    });
    const legacy = JSON.parse(r.body);
    check("POST /api/upload 仍返回 200 与 /uploads/ 地址",
      r.status === 200 && legacy.ok === true && /^\/uploads\//.test(legacy.url), r.status + " " + r.body);
    r = await request(PORT, "GET", "/api/library");
    lib = JSON.parse(r.body);
    check("单张接口上传的图片同时进入图床库（可直接复用）",
      lib.images.some((im) => im.name === legacy.name), legacy.name + " | " + lib.images.map((i) => i.name).join(","));

    console.log("== 鉴权（启用密码的实例） ==");
    srvAuth = await startServer(PORT_AUTH, Object.assign({ NAVI_PASSWORD: PASSWORD }, commonEnv));
    r = await request(PORT_AUTH, "GET", "/api/library");
    check("未登录访问 /api/library -> 401", r.status === 401, r.status + " " + r.body);
    r = await request(PORT_AUTH, "POST", "/api/library/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + PNG_B64 })
    });
    check("未登录上传 -> 401（不会被写入图床库）", r.status === 401, r.status);
    r = await request(PORT_AUTH, "POST", "/api/library/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x.png" })
    });
    check("未登录删除 -> 401", r.status === 401, r.status);

    r = await request(PORT_AUTH, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    const cookie = String((r.headers["set-cookie"] || [])[0] || "").split(";")[0];
    check("登录成功并下发会话 Cookie", r.status === 200 && /navi_session=/.test(cookie), r.status + " " + cookie);
    r = await request(PORT_AUTH, "GET", "/api/library", { headers: { Cookie: cookie } });
    check("登录后可正常读取图床库", r.status === 200 && JSON.parse(r.body).ok === true, r.status);
  } finally {
    if (srv) srv.kill();
    if (srvAuth) srvAuth.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
