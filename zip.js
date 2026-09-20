/* ============================================================
   Navi 导航站 · 零依赖 ZIP 读写
   ------------------------------------------------------------
   为什么自己写：本项目坚持「零 npm 依赖」。备份要打包图片就必须有 ZIP，
   而 Node 内置的 zlib 只能压缩「流」，不提供容器格式 —— 于是这里手写
   ZIP 容器（本地文件头 / 中央目录 / 目录结尾），压缩交给 zlib.deflateRawSync。

   支持范围（刻意收窄，只做备份场景需要的部分）：
   - 写入：store(0) 与 deflate(8) 自动择优；UTF-8 文件名（置通用位 11）
   - 读取：store(0) / deflate(8)；容忍 ZIP 注释
   - 不支持 ZIP64（>4GB）→ 写入前显式拦截，读取时若遇 0xFFFFFFFF 会报错而非静默出错
   - 不使用文件时间做任何判断：统一写 1980-01-01，保证同一份数据的字节可复现，
     也避免跨时区导致「同样的内容产生不同备份」而让校验和无法比对。

   只使用 Node 内置模块，无需 npm install。
   ============================================================ */

"use strict";

const zlib = require("zlib");

const SIG_LOCAL = 0x04034b50;   // 本地文件头
const SIG_CENTRAL = 0x02014b50; // 中央目录项
const SIG_EOCD = 0x06054b50;    // 中央目录结尾

// ZIP 上限（避免生成 ZIP64 内容却当成普通 ZIP 读）
const MAX_ENTRY = 0xffffffff;
const MAX_TOTAL = 0xffffffff;

/* ---------- CRC-32（IEEE 802.3）查表实现 ----------
   不依赖 zlib.crc32（Node 22.2 才加入，老运行时没有），保证零依赖且可移植。 */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- 小工具：定长小端整数 ---------- */
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// 固定时间戳（1980-01-01 00:00:00），理由见文件头注释
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/* ---------- 判断是否像 ZIP（含空包 PK\x05\x06） ---------- */
function looksLikeZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  const b2 = buf[2], b3 = buf[3];
  return (b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06) || (b2 === 0x07 && b3 === 0x08);
}

/* ---------- 写入 ----------
   entries: [{ name: string, data: Buffer|string }]
   返回 Buffer；任一项超限或总量超限时抛错。 */
function zipCreate(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > 0xffff) throw new Error("ZIP 条目过多（上限 65535）");

  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of list) {
    const nameBuf = Buffer.from(String(e.name || ""), "utf8");
    if (!nameBuf.length) throw new Error("ZIP 条目名不能为空");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? "" : e.data), "utf8");
    if (raw.length > MAX_ENTRY) throw new Error("ZIP 条目过大：" + e.name);

    const crc = crc32(raw);
    // 小幅数据压不动时 deflate 反而更大 → 自动退回 store，保证「压缩不会让备份变大」
    let method = 0;
    let body = raw;
    if (raw.length > 64) {
      const def = zlib.deflateRawSync(raw, { level: 6 });
      if (def.length < raw.length) { method = 8; body = def; }
    }

    const flags = 0x0800; // 通用位 11：文件名以 UTF-8 编码

    const local = Buffer.concat([
      u32(SIG_LOCAL), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(raw.length),
      u16(nameBuf.length), u16(0), nameBuf
    ]);
    parts.push(local, body);

    central.push(Buffer.concat([
      u32(SIG_CENTRAL), u16(20), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(raw.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBuf
    ]));

    offset += local.length + body.length;
    if (offset > MAX_TOTAL) throw new Error("ZIP 总量超出 4GB（本项目不支持 ZIP64）");
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(SIG_EOCD), u16(0), u16(0),
    u16(list.length), u16(list.length),
    u32(cd.length), u32(offset), u16(0)
  ]);
  parts.push(cd, eocd);
  return Buffer.concat(parts);
}

/* ---------- 读取 ----------
   返回 [{ name, data }]。损坏时抛错并说明原因（不返回半截数据）。 */
function zipRead(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("不是有效的 ZIP 文件（长度不足）");

  // 从尾部向前找 EOCD —— 允许存在最多 64KB 的注释
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（未找到中央目录结尾）");

  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("不支持分卷 ZIP（本项目备份永远是单文件）");
  }
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdSize === 0xffffffff || cdOff === 0xffffffff || total === 0xffff) {
    throw new Error("不支持 ZIP64 格式（备份文件不会那么大）");
  }
  if (cdOff + cdSize > buf.length) throw new Error("ZIP 文件已损坏（中央目录越界）");

  const out = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error("ZIP 文件已损坏（第 " + (i + 1) + " 个目录项无效）");
    }
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const fnlen = buf.readUInt16LE(p + 28);
    const extralen = buf.readUInt16LE(p + 30);
    const commentlen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + fnlen);
    p += 46 + fnlen + extralen + commentlen;

    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
      throw new Error("不支持 ZIP64 条目：" + name);
    }
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOCAL) {
      throw new Error("ZIP 文件已损坏（" + name + " 的本地文件头无效）");
    }
    const lfnlen = buf.readUInt16LE(lho + 26);
    const lextralen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lfnlen + lextralen;
    const rawSlice = buf.slice(dataStart, dataStart + csize);
    if (rawSlice.length !== csize) throw new Error("ZIP 文件已损坏（" + name + " 数据被截断）");

    let data;
    if (method === 0) {
      data = Buffer.from(rawSlice);
    } else if (method === 8) {
      try { data = zlib.inflateRawSync(rawSlice); }
      catch (e) { throw new Error("ZIP 文件已损坏（" + name + " 解压失败）"); }
    } else {
      throw new Error("不支持的压缩方式（" + method + "）：" + name);
    }
    if (data.length !== usize) {
      throw new Error("ZIP 文件已损坏（" + name + " 解压后长度不符，期望 " + usize + " 实得 " + data.length + "）");
    }
    // 逐项 CRC 校验：能抓出「解压成功但内容已损坏」的情况
    if (crc32(data) !== crc) {
      throw new Error("ZIP 文件已损坏（" + name + " CRC 校验失败）");
    }
    out.push({ name: name, data: data });
  }
  return out;
}

module.exports = { zipCreate, zipRead, looksLikeZip, crc32 };
