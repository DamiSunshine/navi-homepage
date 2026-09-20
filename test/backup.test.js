/* Navi 导航站 · 数据备份 / 恢复 / Logo 上传 专项测试
   自动启动独立服务实例（无鉴权），并使用独立的临时 config 与 uploads 目录，
   全程不触碰真实的 public/config.json 与 public/uploads/。
   覆盖：备份导出结构/校验和、恢复成功/损坏/格式不匹配/校验和篡改/结构非法、上传合法/伪造/超限。
   用法：node test/backup.test.js */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = 8644;

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

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const BASE_CONFIG = {
  site: { title: "BackupTest", subtitle: "测试实例" },
  groups: [
    { name: "G1", items: [{ title: "Alpha", url: "https://alpha.example.com", desc: "首个站点" }] },
    { name: "G2", items: [
      { title: "Beta", url: "https://beta.example.com", lanUrl: "http://192.168.1.10:8080" },
      // P1-7：失效标记（stale）与来源追踪（source）都是普通配置字段，
      // 备份 / 恢复必须原样带走 —— 不能因为「已失效」就被静默剔除，
      // 那等于用户在自己的备份里不知情地丢了数据。
      { title: "已消失的服务", url: "http://192.168.1.10:9999", stale: true,
        staleAt: "2026-09-20T00:00:00.000Z",
        source: { type: "discover", via: "docker", id: "gone0000" } }
    ] }
  ]
};

// 1x1 透明 PNG（合法图片魔数 89 50 4E 47）
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

(async () => {
  // 建立隔离的临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-backup-test-"));
  const tmpConfig = path.join(tmpDir, "config.json");
  const tmpUploads = path.join(tmpDir, "uploads");
  fs.writeFileSync(tmpConfig, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");

  console.log("临时目录: " + tmpDir);
  const srv = await startServer(PORT, { NAVI_CONFIG_PATH: tmpConfig, NAVI_UPLOAD_DIR: tmpUploads });

  try {
    console.log("== 备份导出 ==");
    let r = await request(PORT, "GET", "/api/backup");
    let backup = null;
    try { backup = JSON.parse(r.body); } catch (e) {}
    check("GET /api/backup -> 200", r.status === 200, String(r.status));
    check("响应为附件下载（Content-Disposition）",
      /attachment/i.test(r.headers["content-disposition"] || ""), r.headers["content-disposition"]);
    check("备份含 format/version/appVersion/exportedAt/config/checksum",
      backup && backup.format === "navi-backup" && backup.version === 1 &&
      typeof backup.appVersion === "string" && typeof backup.exportedAt === "string" &&
      backup.config && typeof backup.checksum === "string", JSON.stringify(backup && Object.keys(backup)));
    check("checksum 与 config 序列化一致", backup && backup.checksum === sha256(JSON.stringify(backup.config)),
      backup && backup.checksum);
    check("备份导出内含失效卡片（只标记不删 → 备份同样不丢）",
      backup && JSON.stringify(backup.config).indexOf("gone0000") !== -1,
      JSON.stringify(backup && backup.config && backup.config.groups));

    console.log("== 恢复：正常往返 ==");
    // 先改配置，再恢复，验证可还原
    const modified = JSON.parse(JSON.stringify(BASE_CONFIG));
    modified.site.title = "已修改";
    r = await request(PORT, "PUT", "/api/config", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(modified)
    });
    check("PUT 修改配置 -> 200", r.status === 200, String(r.status));

    r = await request(PORT, "GET", "/api/config");
    check("修改已生效（标题=已修改）", JSON.parse(r.body).site.title === "已修改");

    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup)
    });
    check("恢复合法备份 -> 200 {ok:true}", r.status === 200 && JSON.parse(r.body).ok === true, r.status + " " + r.body);

    r = await request(PORT, "GET", "/api/config");
    check("恢复后数据还原（标题=BackupTest）", JSON.parse(r.body).site.title === "BackupTest");

    const restoredStale = JSON.parse(r.body).groups
      .reduce((a, g) => a.concat(g.items || []), []).filter((i) => i.stale === true);
    check("失效标记与来源随恢复原样保留（不因「已失效」被剔除）",
      restoredStale.length === 1 && restoredStale[0].title === "已消失的服务" &&
      restoredStale[0].staleAt === "2026-09-20T00:00:00.000Z" &&
      restoredStale[0].source && restoredStale[0].source.id === "gone0000",
      JSON.stringify(restoredStale));

    console.log("== 恢复：异常处理 ==");
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: "{not json"
    });
    check("损坏 JSON -> 400 且含错误提示", r.status === 400 && /不是合法 JSON/.test(r.body), r.status + " " + r.body);

    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "other-format" })
    });
    check("格式不匹配 -> 400", r.status === 400 && /格式不匹配/.test(r.body), r.body);

    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.config.site.title = "被篡改";
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(tampered)
    });
    check("校验和篡改 -> 400 完整性校验失败", r.status === 400 && /完整性校验失败/.test(r.body), r.status + " " + r.body);

    const badVersion = JSON.parse(JSON.stringify(backup));
    badVersion.version = 99;
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(badVersion)
    });
    check("不支持的版本 -> 400", r.status === 400 && /不支持的备份版本/.test(r.body), r.body);

    const badStruct = { format: "navi-backup", version: 1, config: { site: {} } };
    badStruct.checksum = sha256(JSON.stringify(badStruct.config));
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(badStruct)
    });
    check("结构非法（缺 groups）-> 400", r.status === 400 && /无效/.test(r.body), r.status + " " + r.body);

    r = await request(PORT, "GET", "/api/config");
    check("多次非法恢复后配置未被破坏（标题=BackupTest）", JSON.parse(r.body).site.title === "BackupTest");

    console.log("== Logo 上传 ==");
    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + PNG_1x1_B64 })
    });
    let up = null;
    try { up = JSON.parse(r.body); } catch (e) {}
    check("上传合法 PNG -> 200 且返回 /uploads/ 路径",
      r.status === 200 && up && up.ok === true && typeof up.url === "string" && up.url.indexOf("/uploads/") === 0,
      r.status + " " + r.body);
    const savedPath = up && up.url ? path.join(tmpUploads, path.basename(up.url)) : null;
    check("图片确实落盘", savedPath && fs.existsSync(savedPath), savedPath);

    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/jpeg;base64," + PNG_1x1_B64 })
    });
    check("声明 JPEG 实为 PNG -> 400 文件头校验失败", r.status === 400 && /文件头校验失败/.test(r.body), r.status + " " + r.body);

    const textB64 = Buffer.from("hello, not an image").toString("base64");
    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + textB64 })
    });
    check("非图片内容 -> 400 文件头校验失败", r.status === 400 && /文件头校验失败/.test(r.body), r.status + " " + r.body);

    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "https://not-a-data-url.example.com/x.png" })
    });
    check("非 data URL -> 400 仅支持图片", r.status === 400 && /仅支持/.test(r.body), r.status + " " + r.body);

    const bigBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(3 * 1024 * 1024 + 16)]);
    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + bigBuf.toString("base64") })
    });
    check("超过 3MB -> 400 图片过大", r.status === 400 && /过大/.test(r.body), r.status + " " + r.body);
  } finally {
    srv.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    console.log("已清理临时目录: " + tmpDir);
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
