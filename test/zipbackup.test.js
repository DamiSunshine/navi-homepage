/* Navi 导航站 · ZIP 备份（备份含图片）专项测试
   覆盖两层：
     A. zip.js 单元 —— 容器格式正确性、CRC 校验、压缩择优、损坏检测、可复现性
     B. 服务端 —— GET /api/backup?format=zip 与 POST /api/backup/restore 的
        完整往返、逐项 SHA-256 校验、路径穿越防护、旧 JSON 备份向后兼容
   全部使用隔离的临时 config 与 uploads 目录，不触碰真实数据。
   用法：node test/zipbackup.test.js */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const zip = require("../zip");

const PORT = 8651;
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
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
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

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_8x8_B64 = (() => {
  // 用真实 PNG 头 + 填充，凑出 >64 字节以便走 deflate 分支
  const head = Buffer.from(PNG_1x1_B64, "base64");
  return Buffer.concat([head, Buffer.alloc(600, 0x5a)]).toString("base64");
})();

const BASE_CONFIG = {
  site: { title: "ZipBackupTest", subtitle: "测试实例" },
  groups: [{ name: "G1", items: [{ title: "Alpha", url: "https://alpha.example.com" }] }]
};

(async () => {
  /* ================= A. zip.js 单元 ================= */
  console.log("== A. zip.js 容器格式 ==");

  const small = zip.zipCreate([{ name: "a.txt", data: "hello" }]);
  check("生成的字节以 PK\\x03\\x04 开头", small[0] === 0x50 && small[1] === 0x4b && small[2] === 0x03 && small[3] === 0x04);
  check("looksLikeZip 认出自己生成的文件", zip.looksLikeZip(small) === true);
  check("looksLikeZip 对 JSON 返回 false", zip.looksLikeZip(Buffer.from('{"format":"navi-backup"}')) === false);
  check("looksLikeZip 对空 Buffer 返回 false", zip.looksLikeZip(Buffer.alloc(0)) === false);

  let back = zip.zipRead(small);
  check("往返读回 1 个条目且内容一致",
    back.length === 1 && back[0].name === "a.txt" && back[0].data.toString() === "hello",
    JSON.stringify(back.map((b) => b.name)));

  check("空 zip（0 条目）可正常读写", zip.zipRead(zip.zipCreate([])).length === 0);

  // 大数据 → 应自动择优用 deflate，且压缩后确实更小
  const big = Buffer.alloc(200000, 0x41); // 20 万个 'A'，deflate 后极小
  const bigZip = zip.zipCreate([{ name: "big.bin", data: big }]);
  check("高压缩比数据：ZIP 明显小于原始数据", bigZip.length < big.length / 10, bigZip.length + " vs " + big.length);
  const bigBack = zip.zipRead(bigZip);
  check("deflate 条目解压后与原始字节完全一致",
    bigBack.length === 1 && Buffer.compare(bigBack[0].data, big) === 0);

  // 不可压缩数据 → 应回退 store，不会让备份变大
  const rnd = crypto.randomBytes(5000);
  const rndZip = zip.zipCreate([{ name: "rnd.bin", data: rnd }]);
  check("随机数据：ZIP 不超过原始大小 + 200 字节头开销",
    rndZip.length <= rnd.length + 200, rndZip.length + " vs " + rnd.length + "+200");
  check("store 条目往返一致", Buffer.compare(zip.zipRead(rndZip)[0].data, rnd) === 0);

  // 中文/多级路径文件名
  const uniZip = zip.zipCreate([{ name: "uploads/图标-测试.png", data: "x" }]);
  check("UTF-8 文件名（含中文与子目录）往返正确",
    zip.zipRead(uniZip)[0].name === "uploads/图标-测试.png", zip.zipRead(uniZip)[0].name);

  // 多条目顺序保持
  const multi = zip.zipRead(zip.zipCreate([
    { name: "b.txt", data: "2" }, { name: "a.txt", data: "1" }, { name: "c/d.txt", data: "3" }
  ]));
  check("多条目按写入顺序读回", multi.map((m) => m.name).join(",") === "b.txt,a.txt,c/d.txt", multi.map((m) => m.name).join(","));

  // 可复现性：同样内容两次生成 → 字节完全相同（时间戳固定，不做随机化）
  const r1 = zip.zipCreate([{ name: "x.txt", data: "same" }]);
  const r2 = zip.zipCreate([{ name: "x.txt", data: "same" }]);
  check("同内容两次生成字节完全一致（可复现，便于比对）", Buffer.compare(r1, r2) === 0);

  // CRC 篡改检测：改掉数据区一个字节，但保留原 CRC
  const target = zip.zipCreate([{ name: "z.txt", data: "AAAAAAAAAA" }]);
  const dataOff = 30 + "z.txt".length;
  const tamperedBuf = Buffer.from(target);
  tamperedBuf[dataOff + 2] = 0x42;
  let crcErr = "";
  try { zip.zipRead(tamperedBuf); } catch (e) { crcErr = e.message; }
  check("数据被篡改（CRC 不符）→ 读取报错", /CRC 校验失败/.test(crcErr), crcErr || "(未报错)");

  // 截断检测
  let truncErr = "";
  try { zip.zipRead(small.slice(0, small.length - 10)); } catch (e) { truncErr = e.message; }
  check("文件被截断 → 读取报错", /损坏|长度不足|未找到/.test(truncErr), truncErr || "(未报错)");

  let junkErr = "";
  try { zip.zipRead(Buffer.from("这不是一个 zip 文件，只是一段普通文本内容而已，长度足够 22 字节")); }
  catch (e) { junkErr = e.message; }
  check("非 ZIP 内容 → 读取报错", junkErr.length > 0, junkErr || "(未报错)");

  // crc32 已知值（"123456789" 的 IEEE CRC-32 = 0xCBF43926）
  check("crc32 对已知向量正确（123456789 → cbf43926）",
    zip.crc32(Buffer.from("123456789")).toString(16) === "cbf43926",
    zip.crc32(Buffer.from("123456789")).toString(16));

  /* ================= B. 服务端 zip 备份 / 恢复 ================= */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-zip-test-"));
  const tmpConfig = path.join(tmpDir, "config.json");
  const tmpUploads = path.join(tmpDir, "uploads");
  fs.writeFileSync(tmpConfig, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");
  fs.mkdirSync(tmpUploads, { recursive: true });

  const srv = await startServer(PORT, { NAVI_CONFIG_PATH: tmpConfig, NAVI_UPLOAD_DIR: tmpUploads });

  try {
    console.log("");
    console.log("== B1. 准备图床库素材 ==");

    // 两张根目录图片 + 一张子目录图片（模拟 favicon 缓存这类子目录）
    let r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + PNG_1x1_B64, name: "pic-one.png" })
    });
    const up1 = JSON.parse(r.buf.toString());
    check("上传第 1 张图片成功", r.status === 200 && up1.ok === true, r.status + " " + r.buf.toString());

    r = await request(PORT, "POST", "/api/upload", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64," + PNG_8x8_B64, name: "pic-two.png" })
    });
    const up2 = JSON.parse(r.buf.toString());
    check("上传第 2 张图片成功（>64 字节，走 deflate）", r.status === 200 && up2.ok === true);

    fs.mkdirSync(path.join(tmpUploads, "favicons"), { recursive: true });
    fs.writeFileSync(path.join(tmpUploads, "favicons", "site.png"), Buffer.from(PNG_1x1_B64, "base64"));

    console.log("");
    console.log("== B2. zip 备份导出 ==");
    r = await request(PORT, "GET", "/api/backup?format=zip");
    check("GET /api/backup?format=zip -> 200", r.status === 200, String(r.status));
    check("Content-Type 为 application/zip", /application\/zip/.test(r.headers["content-type"] || ""), r.headers["content-type"]);
    check("附件文件名以 .zip 结尾", /\.zip"?$/.test(r.headers["content-disposition"] || ""), r.headers["content-disposition"]);
    check("响应体是合法 ZIP（PK 文件头）", zip.looksLikeZip(r.buf) === true);
    check("X-Backup-Images 报告 3 张图片", r.headers["x-backup-images"] === "3", r.headers["x-backup-images"]);

    const zipBuf = r.buf;
    let entries = zip.zipRead(zipBuf);
    const names = entries.map((e) => e.name).sort();
    check("ZIP 内包含 navi-backup.json 与 3 个 uploads 条目",
      names.join(",") === ["navi-backup.json", "uploads/favicons/site.png", "uploads/" + up1.name, "uploads/" + up2.name].sort().join(","),
      names.join(","));

    const mfEntry = entries.filter((e) => e.name === "navi-backup.json")[0];
    const mf = JSON.parse(mfEntry.data.toString("utf-8"));
    check("清单保留原有格式字段与校验和",
      mf.format === "navi-backup" && mf.version === 1 && typeof mf.checksum === "string" &&
      mf.checksum === sha256(JSON.stringify(mf.config)));
    check("清单 files 数组长度 = 3", Array.isArray(mf.files) && mf.files.length === 3, JSON.stringify(mf.files));
    check("files 每项都有 path/size/sha256",
      mf.files.every((f) => typeof f.path === "string" && f.path.indexOf("uploads/") === 0 &&
        typeof f.size === "number" && /^[0-9a-f]{64}$/.test(f.sha256)),
      JSON.stringify(mf.files[0]));
    check("清单里图片 sha256 与 ZIP 内实际字节一致",
      mf.files.every((f) => {
        const e = entries.filter((x) => x.name === f.path)[0];
        return e && sha256(e.data) === f.sha256 && e.data.length === f.size;
      }));
    // 无 files 字段的纯 JSON 备份仍与历史版本一致（向后兼容的关键）
    const jsonBackup = JSON.parse((await request(PORT, "GET", "/api/backup")).buf.toString());
    check("纯 JSON 备份不含 files 字段（与历史版本逐字段一致）", jsonBackup.files === undefined,
      JSON.stringify(Object.keys(jsonBackup)));

    console.log("");
    console.log("== B3. zip 备份恢复（先删光图片再还原）==");
    fs.rmSync(tmpUploads, { recursive: true, force: true });
    fs.mkdirSync(tmpUploads, { recursive: true });
    check("恢复前图床库确已清空", fs.readdirSync(tmpUploads).length === 0);

    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: zipBuf
    });
    const rr = JSON.parse(r.buf.toString());
    check("恢复 zip 备份 -> 200 {ok:true, format:zip}", r.status === 200 && rr.ok === true && rr.format === "zip",
      r.status + " " + r.buf.toString());
    check("报告还原了 3 张图片", rr.images && rr.images.total === 3 && rr.images.written === 3, JSON.stringify(rr.images));
    check("图片文件确实落回磁盘（含子目录）",
      fs.existsSync(path.join(tmpUploads, up1.name)) &&
      fs.existsSync(path.join(tmpUploads, up2.name)) &&
      fs.existsSync(path.join(tmpUploads, "favicons", "site.png")));
    check("还原后的图片字节与原文件一致",
      sha256(fs.readFileSync(path.join(tmpUploads, up2.name))) === sha256(Buffer.from(PNG_8x8_B64, "base64")));

    // 重复恢复：内容一致 → 应全部跳过，不产生无谓写入
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: zipBuf
    });
    const rr2 = JSON.parse(r.buf.toString());
    check("重复恢复同一备份：全部跳过、不覆盖", r.status === 200 && rr2.images.written === 0 && rr2.images.skipped === 3,
      JSON.stringify(rr2.images));

    // 配置也一并还原
    const modified = JSON.parse(JSON.stringify(BASE_CONFIG));
    modified.site.title = "被改过了";
    await request(PORT, "PUT", "/api/config", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(modified)
    });
    await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: zipBuf
    });
    r = await request(PORT, "GET", "/api/config");
    check("zip 恢复同时还原了配置（标题回到 ZipBackupTest）",
      JSON.parse(r.buf.toString()).site.title === "ZipBackupTest");

    console.log("");
    console.log("== B4. zip 备份的异常与防护 ==");

    // 图片被篡改：清单里的 sha256 与包内字节不符 → 整体拒绝
    const tamperEntries = zip.zipRead(zipBuf).map((e) =>
      e.name === "uploads/" + up1.name ? { name: e.name, data: Buffer.concat([e.data, Buffer.from([0])]) } : e);
    const tamperedZip = zip.zipCreate(tamperEntries);
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: tamperedZip
    });
    check("图片被篡改 -> 400 且提示体积/校验不符",
      r.status === 400 && /体积与清单不符|校验失败/.test(r.buf.toString()), r.status + " " + r.buf.toString());

    // 路径穿越：清单声明 uploads/../evil.png
    const evilMf = JSON.parse(JSON.stringify(mf));
    evilMf.files = [{ path: "uploads/../evil.png", size: 3, sha256: sha256("abc") }];
    evilMf.checksum = sha256(JSON.stringify(evilMf.config));
    const evilZip = zip.zipCreate([
      { name: "navi-backup.json", data: JSON.stringify(evilMf) },
      { name: "uploads/../evil.png", data: "abc" }
    ]);
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: evilZip
    });
    check("路径穿越（../）-> 400 拒绝", r.status === 400 && /非法路径/.test(r.buf.toString()),
      r.status + " " + r.buf.toString());
    check("穿越尝试未在数据目录外写出文件", !fs.existsSync(path.join(tmpDir, "evil.png")));

    // 清单声明了文件但包里没有
    const missMf = JSON.parse(JSON.stringify(mf));
    missMf.files = [{ path: "uploads/not-there.png", size: 3, sha256: sha256("abc") }];
    missMf.checksum = sha256(JSON.stringify(missMf.config));
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" },
      body: zip.zipCreate([{ name: "navi-backup.json", data: JSON.stringify(missMf) }])
    });
    check("清单声明的文件缺失 -> 400", r.status === 400 && /缺少清单声明的文件/.test(r.buf.toString()), r.buf.toString());

    // 没有 navi-backup.json 的普通 zip
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" },
      body: zip.zipCreate([{ name: "readme.txt", data: "not a navi backup" }])
    });
    check("非 Navi 的 zip -> 400 提示缺少 navi-backup.json",
      r.status === 400 && /缺少 navi-backup\.json/.test(r.buf.toString()), r.buf.toString());

    // 损坏的 zip：破坏中央目录结尾签名（末 22 字节即 EOCD，无注释）→ 应报「解析失败」而非 500
    const broken = Buffer.from(zipBuf);
    broken.writeUInt32LE(0, broken.length - 22);
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: broken
    });
    check("损坏的 zip -> 400 解析失败（不是 500）", r.status === 400 && /备份包解析失败/.test(r.buf.toString()),
      r.status + " " + r.buf.toString());

    // ZIP 内配置被篡改（校验和不符）
    const badCfgMf = JSON.parse(JSON.stringify(mf));
    badCfgMf.config.site.title = "篡改标题";
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" },
      body: zip.zipCreate([{ name: "navi-backup.json", data: JSON.stringify(badCfgMf) }])
    });
    check("ZIP 内配置被篡改 -> 400 完整性校验失败",
      r.status === 400 && /完整性校验失败/.test(r.buf.toString()), r.buf.toString());

    console.log("");
    console.log("== B5. 旧 JSON 备份向后兼容 ==");
    const oldStyle = { format: "navi-backup", version: 1, appVersion: "1.0.0", exportedAt: new Date().toISOString(),
      config: BASE_CONFIG };
    oldStyle.checksum = sha256(JSON.stringify(oldStyle.config));
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(oldStyle)
    });
    const ro = JSON.parse(r.buf.toString());
    check("不含 files 的旧 JSON 备份仍可恢复 -> 200 format=json",
      r.status === 200 && ro.ok === true && ro.format === "json", r.status + " " + r.buf.toString());
    check("旧 JSON 恢复不会动到图床库文件", fs.existsSync(path.join(tmpUploads, up1.name)));

    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/json" }, body: "{依然非法"
    });
    check("非法 JSON 仍报原有错误文案", r.status === 400 && /不是合法 JSON/.test(r.buf.toString()), r.buf.toString());

    // 安全兜底：上面一连串非法恢复都没能改动数据（图床库 3 个文件仍在、配置仍是原值）
    const libFiles = fs.readdirSync(tmpUploads).filter((n) => n !== "favicons").sort();
    check("全部非法恢复尝试后：图床库文件未被破坏（仍是 2 个根文件 + 1 个子目录）",
      libFiles.length === 2 && fs.existsSync(path.join(tmpUploads, "favicons", "site.png")),
      JSON.stringify(libFiles));
    r = await request(PORT, "GET", "/api/config");
    check("全部非法恢复尝试后：配置仍为备份中的原值",
      JSON.parse(r.buf.toString()).site.title === "ZipBackupTest");
    check("恢复过程不残留临时 staging 目录",
      !fs.existsSync(path.join(tmpUploads, ".restore-staging")));

    console.log("");
    console.log("== B6. Windows 重打包（反斜杠条目名）兼容 ==");
    // 在 Windows 上解包再重新压缩，条目名会变成 "uploads\a.png"；清单里仍是 "uploads/a.png"。
    fs.rmSync(tmpUploads, { recursive: true, force: true });
    fs.mkdirSync(tmpUploads, { recursive: true });
    const winZip = zip.zipCreate([
      { name: "navi-backup.json", data: JSON.stringify(mf) },
      { name: "uploads\\" + up1.name, data: Buffer.from(PNG_1x1_B64, "base64") },
      { name: "uploads\\favicons\\site.png", data: Buffer.from(PNG_1x1_B64, "base64") }
    ]);
    // 上面这种 zip 只含 2 张图，但清单声明 3 个 → 应报「缺少清单声明的文件」（说明确实按清单严格核对）
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" }, body: winZip
    });
    check("反斜杠条目名也能按清单匹配（此处故意少一张 → 精确报缺失而非乱报）",
      r.status === 400 && /缺少清单声明的文件/.test(r.buf.toString()), r.buf.toString());

    // 完整版：清单缩到 2 个文件，条目名用反斜杠 → 应恢复成功
    const winMf = JSON.parse(JSON.stringify(mf));
    winMf.files = [
      { path: "uploads/" + up1.name, size: Buffer.from(PNG_1x1_B64, "base64").length, sha256: sha256(Buffer.from(PNG_1x1_B64, "base64")) },
      { path: "uploads/favicons/site.png", size: Buffer.from(PNG_1x1_B64, "base64").length, sha256: sha256(Buffer.from(PNG_1x1_B64, "base64")) }
    ];
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" },
      body: zip.zipCreate([
        { name: "navi-backup.json", data: JSON.stringify(winMf) },
        { name: "uploads\\" + up1.name, data: Buffer.from(PNG_1x1_B64, "base64") },
        { name: "uploads\\favicons\\site.png", data: Buffer.from(PNG_1x1_B64, "base64") }
      ])
    });
    check("反斜杠条目名的 Windows 重打包备份可正常恢复",
      r.status === 200 && JSON.parse(r.buf.toString()).images.written === 2, r.status + " " + r.buf.toString());
    check("反斜杠条目确实还原到了正确路径",
      fs.existsSync(path.join(tmpUploads, up1.name)) && fs.existsSync(path.join(tmpUploads, "favicons", "site.png")));

    // 但清单里若声明反斜杠路径 → 必须拒绝（安全边界，不给路径穿越任何想象空间）
    const badMf = JSON.parse(JSON.stringify(mf));
    badMf.files = [{ path: "uploads\\..\\evil.png", size: 3, sha256: sha256("abc") }];
    badMf.checksum = sha256(JSON.stringify(badMf.config));
    r = await request(PORT, "POST", "/api/backup/restore", {
      headers: { "Content-Type": "application/zip" },
      body: zip.zipCreate([{ name: "navi-backup.json", data: JSON.stringify(badMf) }, { name: "x", data: "abc" }])
    });
    check("清单里出现反斜杠路径 -> 400 拒绝",
      r.status === 400 && /非法路径/.test(r.buf.toString()), r.buf.toString());
  } finally {
    srv.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
