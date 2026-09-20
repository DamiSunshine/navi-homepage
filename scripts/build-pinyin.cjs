/* ============================================================
   Navi 导航站 · 生成拼音索引表（public/js/pinyin.js）

   为什么用「生成」而不是手写：
     拼音表是纯数据，手写必然出错且无法审计；因此从公开权威数据源
     mozillazg/pinyin-data（MIT）的 pinyin.txt 生成，产物提交入库。
     运行时零依赖、零网络：pinyin.js 是自包含的静态数据 + 几行纯函数。

   数据加工规则：
     1. 只取 CJK 基本区 U+4E00–U+9FFF（常用汉字都在这段），扩展区不取（体积翻倍、收益极小）
     2. 每个字只保留**第一个读音**（数据源按常用度排序）→ 单字只归属一个音节，
        反查时不存在歧义，也不必做「多音字择优」这种无法验证的猜测
     3. 无声调；ü 系（ü ǖ ǘ ǚ ǜ）统一记为 "v"，这样：
        存 "nv" → 同时能派生出 "nu"（运行时把 v 换成 u），"nv"/"nu" 两种输入都能命中
     4. 输出为「音节 → 汉字串」的反向表：人可读、可 diff、体积小（比 char→拼音 省一半）

   用法：node scripts/build-pinyin.cjs            # 联网生成
        node scripts/build-pinyin.cjs --dry-run  # 只统计，不写文件
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const SOURCES = [
  "https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt",
  "https://cdn.jsdelivr.net/gh/mozillazg/pinyin-data/pinyin.txt",
];
const OUT = path.join(__dirname, "..", "public", "js", "pinyin.js");
const RANGE_MIN = 0x4e00;
const RANGE_MAX = 0x9fff;

const DRY = process.argv.indexOf("--dry-run") >= 0;

function fetchText(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "navi-build-pinyin" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume();
        resolve(fetchText(res.headers.location, depth + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode + " " + url)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("下载超时: " + url)); });
  });
}

// ü 系先转 v（NFD 分解会把 ü 拆成 u+分音符，先转 v 才不会丢掉「ü」这个信息）
const U_UMLAUT = /[\u00fc\u01d6\u01d8\u01da\u01dc]/g;

function toTonelessV(syl) {
  return String(syl)
    .replace(U_UMLAUT, "v")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // 去掉所有组合用变音符号（声调）
    .toLowerCase()
    .replace(/[^a-z]/g, "");           // 数据里偶见 "ê" 之类，一律滤掉非字母
}

(async () => {
  let text = null, used = "";
  for (const url of SOURCES) {
    try {
      process.stdout.write("下载 " + url + " … ");
      text = await fetchText(url);
      used = url;
      console.log("OK（" + text.length + " 字符）");
      break;
    } catch (e) {
      console.log("失败：" + e.message);
    }
  }
  if (!text) {
    console.error("\n所有数据源都取不到。若本机无外网，可手动下载 pinyin.txt 到 scripts/pinyin.txt 后重跑。");
    process.exit(1);
  }

  // 解析：U+4E00: yī  # 一
  const lines = text.split(/\r?\n/);
  const byChar = new Map();   // char -> 首个读音（无声调）
  let parsed = 0, outside = 0;
  for (const line of lines) {
    const m = /^U\+([0-9A-Fa-f]{4,6})\s*:\s*([^#\s][^#]*)/.exec(line);
    if (!m) continue;
    const cp = parseInt(m[1], 16);
    if (cp < RANGE_MIN || cp > RANGE_MAX) { outside++; continue; }
    const first = m[2].split(",")[0].trim();
    if (!first) continue;
    const syl = toTonelessV(first);
    if (!syl) continue;
    parsed++;
    if (!byChar.has(cp)) byChar.set(cp, syl);
  }
  if (byChar.size < 5000) {
    console.error("解析结果过少（" + byChar.size + " 字），数据源格式可能已变化，已中止以免写出残表。");
    process.exit(1);
  }

  // 反转为 音节 → 汉字串，并按音节字母序输出（稳定、可 diff）
  const bySyl = new Map();
  for (const [cp, syl] of byChar) {
    if (!bySyl.has(syl)) bySyl.set(syl, []);
    bySyl.get(syl).push(cp);
  }
  const syls = [...bySyl.keys()].sort();
  for (const s of syls) bySyl.get(s).sort((a, b) => a - b);

  const multi = syls.filter((s) => s.length > 1).length;
  console.log("覆盖汉字 " + byChar.size + " 个 / 音节 " + syls.length + " 个（多字母音节 " + multi + "）");
  console.log("区间外忽略 " + outside + " 行，区间内总行 " + parsed);

  // ---- 抽样自检（用常识断言，防止数据源整体错位）----
  const probe = { "一": "yi", "家": "jia", "庭": "ting", "影": "ying", "音": "yin", "中": "zhong", "国": "guo", "女": "nv", "服": "fu", "务": "wu", "器": "qi", "云": "yun", "盘": "pan", "下": "xia", "载": "zai" };
  let bad = 0;
  for (const ch of Object.keys(probe)) {
    const got = byChar.get(ch.codePointAt(0));
    if (got !== probe[ch]) { console.log("  ⚠ 抽样不符：" + ch + " 期望 " + probe[ch] + " 实得 " + got); bad++; }
  }
  console.log(bad ? ("抽样自检有 " + bad + " 处不符") : "抽样自检 15/15 全部通过");
  if (bad) process.exit(1);

  // ---- 输出 ----
  const parts = [];
  parts.push("/* Navi 导航站 · 拼音索引（离线可用 · 零依赖）");
  parts.push("   ⚠️ 本文件由 scripts/build-pinyin.cjs 自动生成，请勿手工修改。");
  parts.push("   数据源：" + used.replace(/^https:\/\//, ""));
  parts.push("            （mozillazg/pinyin-data，MIT License）");
  parts.push("   覆盖：CJK 基本区 U+4E00–U+9FFF 中的 " + byChar.size + " 个常用汉字，");
  parts.push("        每字只保留第一个读音（无声调），ü 记作 v。反向表（音节 → 汉字）便于人工审阅与 diff。");
  parts.push("   运行时不联网、不依赖任何库；由 app.js 在用户首次使用搜索时按需加载。 */");
  parts.push('(function (global) {');
  parts.push('  "use strict";');
  parts.push("  // 音节 → 该读音下的全部汉字（按码位升序）");
  parts.push("  var RAW = {");
  const linesOut = [];
  for (const s of syls) {
    const chars = bySyl.get(s).map((cp) => String.fromCodePoint(cp)).join("");
    linesOut.push('    "' + s + '": "' + chars + '"');
  }
  parts.push(linesOut.join(",\n"));
  parts.push("  };");
  parts.push("");
  parts.push("  var MAP = null;");
  parts.push("  function map() {");
  parts.push("    if (MAP) return MAP;");
  parts.push("    MAP = Object.create(null);");
  parts.push("    for (var syl in RAW) {");
  parts.push("      var chars = RAW[syl];");
  parts.push("      for (var i = 0; i < chars.length; i++) MAP[chars.charAt(i)] = syl;");
  parts.push("    }");
  parts.push("    return MAP;");
  parts.push("  }");
  parts.push("");
  parts.push("  // 单个汉字 → 无声调拼音（未收录返回 null）");
  parts.push("  function syllable(ch) { return map()[ch] || null; }");
  parts.push("");
  parts.push("  // 一段文本 → 检索串：全拼 + ü 的 u 变体 + 首字母缩写，用空格分隔。");
  parts.push("  // 例：「女武神」→ \"nvwushen nuwushen nws\"（搜 nv / nu / nws / wu 都能命中）");
  parts.push("  //     「家庭影音」→ \"jiatingyingyin jtyy\"");
  parts.push("  // 非汉字字符与未收录汉字直接跳过（不影响子串匹配这条主路径）。");
  parts.push("  function index(text) {");
  parts.push("    var s = String(text == null ? \"\" : text);");
  parts.push("    var full = \"\", ini = \"\";");
  parts.push("    for (var i = 0; i < s.length; i++) {");
  parts.push("      var syl = syllable(s.charAt(i));");
  parts.push("      if (!syl) continue;");
  parts.push("      full += syl;");
  parts.push("      ini += syl.charAt(0);");
  parts.push("    }");
  parts.push("    if (!full) return \"\";");
  parts.push("    var out = full;");
  parts.push("    var alt = full.replace(/v/g, \"u\");");
  parts.push("    if (alt !== full) out += \" \" + alt;");
  parts.push("    return out + \" \" + ini;");
  parts.push("  }");
  parts.push("");
  parts.push("  global.NaviPinyin = {");
  parts.push("    index: index,");
  parts.push("    syllable: syllable,");
  parts.push("    size: " + byChar.size + ",");
  parts.push("    syllables: " + syls.length);
  parts.push("  };");
  parts.push("})(typeof window !== \"undefined\" ? window : this);");
  parts.push("");

  const out = parts.join("\n");
  console.log("产物长度 " + out.length + " 字符（约 " + Math.round(Buffer.byteLength(out) / 1024) + " KB）");
  if (DRY) { console.log("--dry-run：未写入文件"); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, "utf-8");
  console.log("已写入 " + path.relative(path.join(__dirname, ".."), OUT));
})().catch((e) => { console.error("生成失败:", e); process.exit(1); });
