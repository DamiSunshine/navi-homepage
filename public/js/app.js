/* ============================================================
   Navi 个人导航站 · 前端逻辑
   - 加载配置渲染分组卡片（优先 /api/config，降级静态 config.json）
   - 内网 / 外网一键切换（含内网环境自动识别）
   - 在线图标库：Dashboard Icons / selfh.st Icons / Iconify
   - 实时搜索过滤
   - 编辑模式：增 / 删 / 改 / 拖拽排序 / 分组管理 / 保存写回服务器
   ============================================================ */

(function () {
  "use strict";

  var API_URL = "/api/config";
  var STATIC_CONFIG_URL = "config.json";
  var BACKUP_FORMAT = "navi-backup";
  var BACKUP_VERSION = 1;
  var APP_VERSION = "1.0.0";

  /* ---------- 图标解析器 ---------- */
  // icon 字段支持五种写法：
  //   1. "https://...png"                直接外链图片
  //   2. "iconify:simple-icons:github"   明确指定 Iconify 在线图标（api.iconify.design）
  //   3. "selfhst:portainer"             self.hst 图标库短名
  //   4. "jellyfin"                      Dashboard Icons 风格短名
  //   5. 留空                             按名称自动推断（同 4）
  //
  // 「本地优先」是 P1-6 的核心：public/icons/ 里内置了 200+ 常用图标（含国内站点），
  // 由 scripts/build-icons.cjs 生成，映射表是 public/js/icon-map.js（需先于本文件加载）。
  // 原因：用户实访是局域网 HTTP，内网/断网时公共 CDN 一律拉不到，
  // 本地文件才是那条能出图的路；CDN 补充「本地没有这个图标」的情况，而不是主路。
  //
  // 注意 2 不做本地替换：那是用户**明确指定**的在线图标，替他换成别的图标更糟。
  var localIconMap = window.NAVI_LOCAL_ICONS || null;

  function iconSlug(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function localIcon(slug) {
    if (!slug || !localIconMap) return null;
    var f = localIconMap[slug];
    return f ? "/" + f : null;
  }

  function resolveIcon(icon, name) {
    if (icon && /^https?:\/\//i.test(icon)) return icon;
    if (icon && icon.indexOf("iconify:") === 0) {
      var parts = icon.slice(8).split(":");
      if (parts.length === 2) {
        return "https://api.iconify.design/" + parts[0] + "/" + parts[1] + ".svg?color=%237db1ff";
      }
    }
    if (icon && icon.indexOf("selfhst:") === 0) {
      var raw = icon.slice(8);
      return localIcon(iconSlug(raw)) || ("https://cdn.jsdelivr.net/gh/selfhst/icons/png/" + raw + ".png");
    }
    var slug = iconSlug(icon || name || "");
    if (!slug) return null;
    return localIcon(slug) || ("https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/" + slug + ".png");
  }

  // 优先使用本地上传的 logo（/uploads/* 或任意图片直链），否则回退到 icon 解析逻辑
  function resolveLogo(item) {
    if (item && item.logo && typeof item.logo === "string") {
      if (/^https?:\/\//i.test(item.logo) || item.logo.indexOf("/uploads/") === 0) {
        return item.logo;
      }
    }
    return resolveIcon(item.icon, item.title);
  }

  /* ---------- 内网环境自动识别 ---------- */
  function isLanHost(hostname) {
    if (!hostname) return false;
    var h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost") return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h === "::1") return true;
    if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA
    if (/^fe80:/.test(h)) return true;               // IPv6 link-local
    return false;
  }

  /* ---------- 状态 ---------- */
  var state = {
    config: null,      // 已保存的配置
    draft: null,       // 编辑模式下的工作副本
    mode: "auto",      // "auto" | "lan" | "wan"（auto = 按卡片逐项自动判断）
    keyword: "",
    editMode: false,
    dirty: false,
    apiAvailable: true // 后端 API 是否可用（纯静态托管时降级）
  };

  var STORAGE_MODE_KEY = "navi-net-mode";
  var STORAGE_DRAFT_KEY = "navi-offline-draft";
  var STORAGE_THEME_KEY = "navi-theme"; // "light" | "dark"
  var STORAGE_PROBE_KEY = "navi-lan-probe"; // 内网探测结论缓存（sessionStorage）

  var NET_MODES = ["auto", "lan", "wan"];
  var NET_MODE_LABEL = { auto: "自动", lan: "内网", wan: "外网" };

  function initMode() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_MODE_KEY); } catch (e) {}
    if (NET_MODES.indexOf(saved) >= 0) return saved;
    // 默认「自动」：让每张卡片自己决定走内网还是外网，而不是整站一个开关。
    // 用户手动切过开关后（存入 localStorage）以他的选择为准，行为与旧版一致。
    return "auto";
  }

  function activeConfig() {
    return state.editMode ? state.draft : state.config;
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- DOM 引用 ---------- */
  var navRoot = document.getElementById("navRoot");
  var emptyTip = document.getElementById("emptyTip");
  var searchInput = document.getElementById("searchInput");
  var paletteMask = document.getElementById("paletteMask");
  var paletteInput = document.getElementById("paletteInput");
  var paletteList = document.getElementById("paletteList");
  var paletteScope = document.getElementById("paletteScope");
  var paletteClose = document.getElementById("paletteClose");
  var netToggle = document.getElementById("netToggle");
  var netLabel = document.getElementById("netLabel");
  var netBadge = document.getElementById("netBadge");
  var netBadgeText = document.getElementById("netBadgeText");
  var themeToggle = document.getElementById("themeToggle");
  var editToggle = document.getElementById("editToggle");
  var editLabel = document.getElementById("editLabel");
  var addGroupBtn = document.getElementById("addGroupBtn");
  var saveBar = document.getElementById("saveBar");
  var saveBarTip = document.getElementById("saveBarTip");
  var saveBtn = document.getElementById("saveBtn");
  var cancelEditBtn = document.getElementById("cancelEditBtn");
  var backupBtn = document.getElementById("backupBtn");
  var backupModal = document.getElementById("backupModal");
  var backupZipOpt = document.getElementById("backupZipOpt");
  var backupJsonOpt = document.getElementById("backupJsonOpt");
  var importBtn = document.getElementById("importBtn");
  var importFile = document.getElementById("importFile");

  /* Logo 上传相关 DOM */
  var logoFile = document.getElementById("logoFile");
  var logoPreview = document.getElementById("logoPreview");
  var logoEmpty = document.getElementById("logoEmpty");
  var logoPickBtn = document.getElementById("logoPickBtn");
  var logoClearBtn = document.getElementById("logoClearBtn");
  var logoLibraryBtn = document.getElementById("logoLibraryBtn");
  var logoStatus = document.getElementById("logoStatus");
  var logoInput = document.getElementById("logoInput");
  var iconGalleryBtn = document.getElementById("iconGalleryBtn");

  /* 图床库 / 图标选择器 DOM */
  var libraryBtn = document.getElementById("libraryBtn");
  var libraryModal = document.getElementById("libraryModal");
  var libraryTitle = document.getElementById("libraryTitle");
  var libraryModeTag = document.getElementById("libraryModeTag");
  var libTabs = document.getElementById("libTabs");
  var libPaneLocal = document.getElementById("libPaneLocal");
  var libPaneOnline = document.getElementById("libPaneOnline");
  var libSearch = document.getElementById("libSearch");
  var libCount = document.getElementById("libCount");
  var libSelectAllBtn = document.getElementById("libSelectAllBtn");
  var libDeleteBtn = document.getElementById("libDeleteBtn");
  var libRefreshBtn = document.getElementById("libRefreshBtn");
  var libDrop = document.getElementById("libDrop");
  var libFile = document.getElementById("libFile");
  var libUploadBtn = document.getElementById("libUploadBtn");
  var libProgress = document.getElementById("libProgress");
  var libProgressFill = document.getElementById("libProgressFill");
  var libProgressText = document.getElementById("libProgressText");
  var libResult = document.getElementById("libResult");
  var libGrid = document.getElementById("libGrid");
  var libEmpty = document.getElementById("libEmpty");
  var iconSearch = document.getElementById("iconSearch");
  var iconSearchBtn = document.getElementById("iconSearchBtn");
  var iconGrid = document.getElementById("iconGrid");
  var iconEmpty = document.getElementById("iconEmpty");
  var iconOnlineHint = document.getElementById("iconOnlineHint");

  /* ---------- 工具 ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  var escapeAttr = escapeHtml;

  /* ---------- 渲染 ---------- */
  /* 决定一张卡片实际打开的地址。优先级（高 → 低）：
       ① 卡片显式 netMode = "lan" / "wan"   ← 用户明确指定，永远尊重
       ② 全局开关被用户手动切到 内网 / 外网  ← 整站强制覆盖
       ③ 内网可达性探测结论                  ← 自动模式下每张卡片各自判断
       ④ 主机名启发式（原行为）              ← 探测尚未完成时的兜底，保证不出现「空窗」
     之所以把探测放在第三步而不是第一步：探测是异步的，页面首帧还没有结论，
     此时必须有一个立刻可用的判断，否则卡片链接会短暂为空或闪烁。 */
  function pickUrl(item) {
    if (item.netMode === "lan" && item.lanUrl) return item.lanUrl;
    if (item.netMode === "wan") return item.url;
    if (state.mode === "lan") return item.lanUrl || item.url;
    if (state.mode === "wan") return item.url;
    if (!item.lanUrl) return item.url;
    var verdict = lanReachable(item.lanUrl);
    if (verdict === true) return item.lanUrl;
    if (verdict === false) return item.url;
    return isLanHost(location.hostname) ? item.lanUrl : item.url;
  }

  // 这张卡片当前会走内网吗（用于卡片上的角标与测试断言）
  function picksLan(item) {
    return !!item.lanUrl && pickUrl(item) === item.lanUrl;
  }

  /* ---------- 内网可达性探测（P0-3） ----------
     为什么需要它：原来整站只有一个内网/外网开关，靠「页面主机名像不像内网」猜测。
     但真实场景是混合的 —— NAS 在家可达、云主机只在公网可达；在公司连 VPN 时
     又反过来。逐张卡片探测一次，比让用户每次手动切全局开关准确得多。

     三条硬约束（都是踩过的坑）：
       1. **绝不阻塞点击**：探测完全在后台跑，卡片链接在首帧就已可用（走启发式兜底），
          探测出结论后只做「就地改写 href」，不重渲染、不重播入场动画。
       2. **HTTPS 页面不探测 http 目标**：浏览器会按「混合内容」直接拦掉请求，
          结论会恒为「不可达」→ 把全部卡片错误地推向外网。这种情况直接放弃探测、
          退回原有启发式，并在界面上说明，而不是给出一个反向的错误结论。
       3. **探测请求不要求 CORS**：用 mode:"no-cors"，只要 TCP/HTTP 握手成功就会 resolve
          （响应不可读也无所谓，我们只关心「通不通」）。连接被拒 / 超时 → 判为不可达。 */
  var PROBE_TIMEOUT_MS = 2000;      // 单次探测超时（内网服务正常应在百毫秒级）
  var PROBE_CONCURRENCY = 4;        // 并发上限，避免一次刷出几十个请求
  var PROBE_TTL_MS = 5 * 60 * 1000; // 结论有效期：5 分钟（刷新页面不必重复探测）

  var probeCache = Object.create(null);        // origin -> { ok, at }
  var probeRun = { started: false, total: 0, done: 0, skippedMixed: 0, skippedCached: 0 };

  function probeLoad() {
    try {
      var raw = sessionStorage.getItem(STORAGE_PROBE_KEY);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && typeof obj === "object") probeCache = obj;
    } catch (e) { /* 存储不可用（隐私模式）时静默放弃缓存，只是每次都重新探测 */ }
  }

  function probeSave() {
    try { sessionStorage.setItem(STORAGE_PROBE_KEY, JSON.stringify(probeCache)); } catch (e) {}
  }

  function probeCached(origin) {
    var rec = probeCache[origin];
    if (rec && typeof rec.ok === "boolean" && Date.now() - rec.at < PROBE_TTL_MS) return rec.ok;
    return undefined;
  }

  function originOf(url) {
    try { return new URL(String(url), location.href).origin; } catch (e) { return ""; }
  }

  // 该目标能否在当前页面被探测（HTTPS 页面探测 http 目标 → 混合内容，必失败）
  function probeAllowed(origin) {
    if (!origin) return false;
    if (location.protocol === "https:" && /^http:\/\//i.test(origin)) return false;
    return true;
  }

  // 返回 true / false / undefined（undefined = 还没有结论）
  function lanReachable(lanUrl) {
    var origin = originOf(lanUrl);
    if (!origin) return undefined;
    if (origin === location.origin) return true;   // 与当前页面同源，必然可达
    return probeCached(origin);
  }

  // 收集需要探测的 origin（去重；显式设过 netMode 的卡片不需要探测）
  function probeTargets() {
    var cfg = state.config;
    var seen = Object.create(null);
    var list = [];
    (((cfg && cfg.groups) || [])).forEach(function (g) {
      ((g && g.items) || []).forEach(function (it) {
        if (!it || !it.lanUrl) return;
        if (it.netMode === "lan" || it.netMode === "wan") return;
        var o = originOf(it.lanUrl);
        if (!o || seen[o]) return;
        seen[o] = 1;
        list.push(o);
      });
    });
    return list;
  }

  function probeOne(origin) {
    return new Promise(function (resolve) {
      var settled = false;
      var ctl = null;
      var timer = null;
      function done(ok) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (ctl) ctl.abort(); } catch (e) {}
        resolve(ok);
      }
      try {
        if (typeof AbortController !== "undefined") ctl = new AbortController();
        fetch(origin + "/", {
          mode: "no-cors",
          cache: "no-store",
          redirect: "follow",
          signal: ctl ? ctl.signal : undefined
        }).then(function () { done(true); }, function () { done(false); });
      } catch (e) {
        done(false);
        return;
      }
      timer = setTimeout(function () { done(false); }, PROBE_TIMEOUT_MS);
    });
  }

  // 启动探测：不返回 promise，调用方不应等待它（绝不能阻塞渲染或点击）
  function startLanProbes() {
    if (probeRun.started) return;
    probeRun.started = true;
    probeLoad();

    var targets = probeTargets();
    var todo = [];
    for (var i = 0; i < targets.length; i++) {
      var o = targets[i];
      if (o === location.origin) { probeCache[o] = { ok: true, at: Date.now() }; continue; }
      if (!probeAllowed(o)) { probeRun.skippedMixed++; continue; }
      if (probeCached(o) !== undefined) { probeRun.skippedCached++; continue; }
      todo.push(o);
    }
    probeRun.total = todo.length;
    if (!todo.length) { probeSave(); updateNetBadgeDetail(); return; }

    var idx = 0;
    function worker() {
      if (idx >= todo.length) return Promise.resolve();
      var origin = todo[idx++];
      return probeOne(origin).then(function (ok) {
        probeCache[origin] = { ok: ok, at: Date.now() };
        probeRun.done++;
        refreshCardUrls();       // 每出一个结论就立即生效，不等全部完成
        return worker();
      });
    }
    var workers = [];
    for (var w = 0; w < Math.min(PROBE_CONCURRENCY, todo.length); w++) workers.push(worker());
    Promise.all(workers).then(function () {
      probeSave();
      refreshCardUrls();
    });
  }

  // 配置变更后重新起一轮探测（新加的卡片可能带来新的内网地址）
  function restartLanProbes() {
    probeRun.started = false;
    probeRun.total = 0;
    probeRun.done = 0;
    startLanProbes();
  }

  // 就地改写卡片链接与角标：不重新渲染，避免入场动画重播与滚动位置跳动
  function refreshCardUrls() {
    var cfg = activeConfig();
    if (!cfg) return;
    var cards = navRoot.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      var gi = Number(el.getAttribute("data-gi"));
      var ii = Number(el.getAttribute("data-ii"));
      var g = (cfg.groups || [])[gi];
      if (!g) continue;
      var it = (g.items || [])[ii];
      if (!it) continue;
      var url = pickUrl(it);
      if (el.getAttribute("href") !== url) {
        el.setAttribute("href", url);
        el.setAttribute("title", url);
      }
      el.setAttribute("data-net", picksLan(it) ? "lan" : "wan");
    }
    updateNetBadgeDetail();
  }

  /* ---------- 搜索匹配（子串 → 拼音 → 描述 → 网址） ----------
     匹配等级越小越优先。改这里等于同时改了「网格过滤」与「命令面板排序」两处行为，
     两级共用同一个 matchRank()，避免两边判定不一致。 */
  var RANK = {
    TITLE_START: 0,  // 标题以关键词开头
    TITLE: 1,        // 标题包含关键词
    PY_INI: 2,       // 拼音首字母连续命中（音节边界对齐，如「家庭影音」→ jtyy 命中 jt）
    PY_FULL: 3,      // 全拼从某个音节边界起的命中（如 jiating、yingyin）
    PY_LOOSE: 4,     // 全拼串里的松散命中（≥3 字符才启用，避免短查询噪音）
    DESC: 5,         // 描述命中
    URL: 6,          // 网址命中
    NONE: -1
  };
  var PY_LOOSE_MIN = 3;

  // 拼音索引：按标题缓存（同一标题在一次会话里只解析一遍）
  var pyIndexCache = Object.create(null);
  function pinyinIndex(title) {
    var key = String(title == null ? "" : title);
    if (key in pyIndexCache) return pyIndexCache[key];
    var out = null;
    if (key && window.NaviPinyin && typeof window.NaviPinyin.syllable === "function") {
      var syls = [];
      for (var i = 0; i < key.length; i++) {
        var s = window.NaviPinyin.syllable(key.charAt(i));
        if (s) syls.push(s);
      }
      if (syls.length) {
        var bounds = [0];
        var full = "";
        for (var j = 0; j < syls.length; j++) { full += syls[j]; bounds.push(full.length); }
        out = { syls: syls, full: full, bounds: bounds, ini: syls.map(function (x) { return x.charAt(0); }).join("") };
      }
    }
    pyIndexCache[key] = out;
    return out;
  }

  function matchRank(item, kw) {
    if (!kw) return RANK.TITLE_START;
    var title = String(item.title || "").toLowerCase();
    if (title.indexOf(kw) === 0) return RANK.TITLE_START;
    if (title.indexOf(kw) >= 0) return RANK.TITLE;

    if (/^[a-z0-9]+$/.test(kw)) {
      var py = pinyinIndex(item.title);
      if (py) {
        // ① 首字母：必须是连续若干「完整音节」的首字母，避免 ty 命中 jtyy 这类跨音节噪音
        for (var i = 0; i + kw.length <= py.syls.length; i++) {
          var hit = true;
          for (var j = 0; j < kw.length; j++) {
            if (py.syls[i + j].charAt(0) !== kw.charAt(j)) { hit = false; break; }
          }
          if (hit) return RANK.PY_INI;
        }
        // ② 全拼：命中必须从某个音节边界开始（jiat / jiating / yingyin 都算）
        for (var b = 0; b < py.bounds.length - 1; b++) {
          if (py.syls.length && py.full.slice(py.bounds[b]).indexOf(kw) === 0) return RANK.PY_FULL;
        }
        // ③ 松散兜底：允许跨音节（如 yiny），但要求查询足够长，否则短词会把整页点亮
        if (kw.length >= PY_LOOSE_MIN && py.full.indexOf(kw) >= 0) return RANK.PY_LOOSE;
      }
    }

    if (String(item.desc || "").toLowerCase().indexOf(kw) >= 0) return RANK.DESC;
    var urls = [item.url, item.lanUrl].filter(Boolean).join(" ").toLowerCase();
    if (urls.indexOf(kw) >= 0) return RANK.URL;
    return RANK.NONE;
  }

  function itemMatches(item, kw) {
    return matchRank(item, kw) >= 0;
  }

  /* ---------- 拼音表按需加载 ----------
     69KB 的纯数据表，页面首屏不需要它，因此在「用户表现出搜索意图」时才加载：
     搜索框获得焦点、或在搜索框里敲下第一个字符。加载失败一律降级为纯子串匹配，
     不抛错、不阻断任何功能（离线/静态托管场景下 pinyin.js 可能取不到）。 */
  var pinyinState = { ready: false, failed: false, promise: null };
  function ensurePinyin() {
    if (window.NaviPinyin) { pinyinState.ready = true; return Promise.resolve(true); }
    if (pinyinState.failed) return Promise.resolve(false);
    if (pinyinState.promise) return pinyinState.promise;
    pinyinState.promise = new Promise(function (resolve) {
      var s = document.createElement("script");
      // 复用 app.js 自身的版本号做缓存键：任何前端改动都会连带刷新拼音表，
      // 同时避免「改了 pinyin.js 但浏览器还在用 7 天强缓存的旧表」。
      var ref = document.querySelector('script[src*="/js/app.js"]');
      var m = ref && String(ref.src).match(/[?&]v=([^&]+)/);
      s.src = "/js/pinyin.js" + (m ? "?v=" + m[1] : "");
      s.async = true;
      s.onload = function () {
        if (window.NaviPinyin) {
          pinyinState.ready = true;
          pyIndexCache = Object.create(null);   // 加载前缓存的 null 结果必须清掉
          resolve(true);
        } else { pinyinState.failed = true; resolve(false); }
      };
      s.onerror = function () {
        pinyinState.failed = true;
        pinyinState.promise = null;             // 允许后续重试（例如网络恢复）
        resolve(false);
      };
      document.head.appendChild(s);
    });
    return pinyinState.promise;
  }

  function needsPinyin(kw) {
    return !!kw && /[a-z0-9]/.test(kw) && !pinyinState.ready && !pinyinState.failed;
  }

  function render() {
    var cfg = activeConfig();
    var groups = (cfg && cfg.groups) || [];
    var kw = state.keyword.trim().toLowerCase();
    var html = "";
    var totalShown = 0;

    groups.forEach(function (group, gi) {
      var visible = (group.items || []).filter(function (it) { return itemMatches(it, kw); });
      if (!visible.length && !state.editMode) return;
      totalShown += visible.length;

      html += '<section class="group" data-name="' + escapeAttr(group.name) + '">';
      html += '<h2 class="group-title">' + escapeHtml(group.name) +
              '<span class="group-count">' + visible.length + "</span>";

      if (state.editMode) {
        html += '<span class="group-tools">' +
                '<button type="button" class="mini-btn" data-act="rename-group" data-gi="' + gi + '" title="重命名分组">' +
                  '<svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>' +
                '</button>' +
                '<button type="button" class="mini-btn" data-act="add-item" data-gi="' + gi + '" title="添加导航项">' +
                  '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                '</button>' +
                '<button type="button" class="mini-btn danger" data-act="del-group" data-gi="' + gi + '" title="删除分组">' +
                  '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                '</button>' +
                '</span>';
      }
      html += "</h2>";
      html += '<div class="card-grid" data-gi="' + gi + '">';

      visible.forEach(function (item, idx) {
        var ii = group.items.indexOf(item);
        var url = pickUrl(item);
        var iconUrl = resolveLogo(item);
        var delay = Math.min(idx * 30, 360);
        var pinned = item.netMode === "lan" || item.netMode === "wan";

        html += '<a class="card" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer"' +
                ' data-gi="' + gi + '" data-ii="' + ii + '"' +
                ' data-has-lan="' + (!!item.lanUrl) + '"' +
                ' data-net="' + (picksLan(item) ? "lan" : "wan") + '"' +
                ' data-source="' + escapeAttr((item.source && item.source.type) || "") + '"' +
                (item.stale ? ' data-stale="1"' : "") +
                (pinned ? ' data-net-pinned="' + escapeAttr(item.netMode) + '"' : "") +
                (state.editMode ? ' draggable="true"' : "") +
                ' style="animation-delay:' + delay + 'ms"' +
                ' title="' + escapeAttr(url) + '">';
        html += '<span class="card-icon">';
        if (iconUrl) {
          html += '<img src="' + escapeAttr(iconUrl) + '" alt="" loading="lazy" ' +
                  'onerror="NaviApp.iconFallback(this,\'' + escapeAttr((item.title || "?").charAt(0)) + '\')">';
        } else {
          html += '<span class="icon-fallback">' + escapeHtml((item.title || "?").charAt(0)) + "</span>";
        }
        html += "</span>";
        html += '<span class="card-body">';
        html += '<span class="card-title">' + escapeHtml(item.title) + "</span>";
        if (item.desc) html += '<span class="card-desc">' + escapeHtml(item.desc) + "</span>";
        // P1-7：来自服务发现、但源侧已消失的卡片 —— 只标记不删。
        // 做成 body 内的行内角标（而非绝对定位），避免与右上角 LAN / 右下角 net-pin 重叠。
        if (item.stale) {
          html += '<span class="stale-pin" title="' + escapeAttr(staleHintText(item)) +
                  '">⚠ 可能失效</span>';
        }
        html += "</span>";
        html += '<span class="lan-flag">LAN</span>';
        // 钉住的卡片（显式指定 netMode）加一个角标：让用户一眼看出「这张是我手动指定的」，
        // 避免以后自己忘了为什么这张卡片不走自动判断
        if (pinned) {
          html += '<span class="net-pin" data-mode="' + escapeAttr(item.netMode) + '" title="' +
                  (item.netMode === "lan" ? "已指定：只用内网地址" : "已指定：只用外网地址") + '">' +
                  (item.netMode === "lan" ? "内网" : "外网") + "</span>";
        }

        if (state.editMode) {
          html += '<span class="card-tools">' +
                  '<button type="button" class="mini-btn" data-act="edit-item" title="编辑">' +
                    '<svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>' +
                  '</button>' +
                  '<button type="button" class="mini-btn danger" data-act="del-item" title="删除">' +
                    '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                  '</button>' +
                  '</span>';
        }
        html += "</a>";
      });

      html += "</div></section>";
    });

    navRoot.innerHTML = html;
    emptyTip.hidden = totalShown > 0 || state.editMode;
  }

  /* ---------- 图标加载失败回退 ---------- */
  window.NaviApp = {
    iconFallback: function (img, letter) {
      var span = document.createElement("span");
      span.className = "icon-fallback";
      span.textContent = letter || "?";
      img.replaceWith(span);
    },
    // 暴露内外网判定与探测状态，供自动化测试与排障使用（只读，不改变行为）
    netMode: function () { return state.mode; },
    // 图标解析结果（本地优先 / CDN 兜底）也暴露出来：断网时最常被怀疑的就是图标链路，
    // 让测试能直接问「这个 slug 会解析成什么」，而不是靠截图猜。
    resolveIcon: function (icon, name) { return resolveIcon(icon, name); },
    localIconCount: function () { return localIconMap ? Object.keys(localIconMap).length : 0; },
    pickUrl: function (item) { return pickUrl(item); },
    probeState: function () {
      return {
        verdicts: JSON.parse(JSON.stringify(probeCache)),
        total: probeRun.total,
        done: probeRun.done,
        skippedMixed: probeRun.skippedMixed,
        skippedCached: probeRun.skippedCached,
        started: probeRun.started
      };
    },
    refreshCardUrls: function () { refreshCardUrls(); },
    // 状态板：只读快照 + 手动刷新（供自动化测试与排障使用）
    status: function () { return statusSnapshot(); },
    refreshStatus: function (fresh) { return refreshStatus(!!fresh); },
    // P1-7：失效卡片的只读快照 + 来源文案（供自动化测试与排障使用；不改变任何行为）
    staleCards: function () {
      return collectStaleCards().map(function (c) {
        return {
          gi: c.gi, ii: c.ii,
          title: c.item.title || "",
          id: (c.item.source && c.item.source.id) || "",
          via: (c.item.source && c.item.source.via) || "",
          staleAt: c.item.staleAt || ""
        };
      });
    },
    sourceLabel: function (it) { return sourceLabel(it); },
    // 最近一次扫描的失效判定元数据（checked / skipped / count），只读
    staleMeta: function () {
      return {
        count: discoverStale ? discoverStale.count : 0,
        marked: discoverStale ? discoverStale.marked : 0,
        checked: (discoverStale && discoverStale.checked) || [],
        skipped: (discoverStale && discoverStale.skipped) || []
      };
    },
    // 拖入链接的解析规则（纯函数，单独暴露便于测试各种粘贴/拖拽形态）
    parseDroppedLink: function (t) { return parseDroppedLink(t); },
    // 首次引导是否应该出现（只读判断，便于测试；不触发任何 UI）
    shouldShowFirstRun: function () {
      return !!state.apiAvailable && !firstRunDismissed() && configItemCount(state.config) === 0;
    }
  };

  /* ---------- 内外网切换 ----------
     三态循环：自动 → 内网 → 外网 → 自动。
     「自动」= 每张卡片按内网可达性各自判断；「内网 / 外网」= 用户手动强制，
     优先级高于自动判断（但低于卡片自身显式指定的 netMode），行为与旧版一致。 */
  function applyModeUI() {
    var mode = state.mode;
    var isLan = mode === "lan";
    var isAuto = mode === "auto";
    netToggle.classList.toggle("lan", isLan);
    netToggle.classList.toggle("auto", isAuto);
    netToggle.setAttribute("aria-pressed", String(!isAuto));
    netToggle.setAttribute("data-mode", mode);
    netLabel.textContent = NET_MODE_LABEL[mode] || "自动";
    netToggle.title = isAuto
      ? "自动模式：每张卡片按内网是否可达自行选择（点击切到「只用内网」）"
      : (isLan ? "已强制只用内网地址（点击切到「只用外网」）" : "已强制只用外网地址（点击切回「自动」）");
    netBadge.classList.toggle("lan", isLan);
    netBadge.classList.toggle("auto", isAuto);
    document.body.classList.toggle("lan-mode", isLan);
    updateNetBadgeDetail();
  }

  // 徽标文案：自动模式下顺带汇报探测进度与结论，让用户知道「为什么这张走了外网」
  function updateNetBadgeDetail() {
    if (state.mode !== "auto") {
      netBadgeText.textContent = state.mode === "lan" ? "内网模式（已强制）" : "外网模式（已强制）";
      netBadge.title = "";
      return;
    }
    var cfg = activeConfig() || state.config;
    var lan = 0, wan = 0, total = 0;
    (((cfg && cfg.groups) || [])).forEach(function (g) {
      ((g && g.items) || []).forEach(function (it) {
        total++;
        if (!it.lanUrl) return;
        if (picksLan(it)) lan++; else wan++;
      });
    });
    var extra = (lan || wan) ? " · 内网 " + lan + " / 外网 " + wan : "";
    var running = probeRun.total && probeRun.done < probeRun.total;
    netBadgeText.textContent = "自动模式" + extra + (running ? "（探测中 " + probeRun.done + "/" + probeRun.total + "）" : "");
    netBadge.title = running
      ? "正在探测内网地址可达性…"
      : (probeRun.skippedMixed
          ? "HTTPS 页面无法探测 http 内网地址（浏览器混合内容限制），这几张卡片按主机名推断"
          : "每张卡片按内网是否可达自行选择地址");
    // 全部无内网地址时不必占位提示
    if (!total) netBadgeText.textContent = "自动模式";
  }

  netToggle.addEventListener("click", function () {
    // 自动 → 内网 → 外网 → 自动
    state.mode = state.mode === "auto" ? "lan" : (state.mode === "lan" ? "wan" : "auto");
    try { localStorage.setItem(STORAGE_MODE_KEY, state.mode); } catch (e) {}
    applyModeUI();
    render();
  });

  /* ---------- 日 / 夜主题切换 ---------- */
  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_THEME_KEY); } catch (e) {}
    // 已保存优先；否则跟随系统偏好（缺省夜间）
    if (saved === "light" || saved === "dark") return saved;
    return systemPrefersDark() ? "dark" : "light";
  }
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === "light") {
      root.setAttribute("data-theme", "light");
      themeToggle.setAttribute("aria-pressed", "true");
    } else {
      root.removeAttribute("data-theme");
      themeToggle.setAttribute("aria-pressed", "false");
    }
  }
  applyTheme(initTheme());

  themeToggle.addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem(STORAGE_THEME_KEY, next); } catch (e) {}
  });

  /* ---------- 搜索 ---------- */
  // 搜索框获得焦点即预取拼音表：这是「用户打算搜索」的最强信号，
  // 比首屏无条件加载省流量，又比等第一个字符敲下去再加载少一次可见的等待。
  searchInput.addEventListener("focus", function () { ensurePinyin(); });
  searchInput.addEventListener("input", function () {
    state.keyword = searchInput.value;
    render();
    if (needsPinyin(state.keyword.trim().toLowerCase())) {
      ensurePinyin().then(function (ok) { if (ok) render(); });
    }
  });

  /* ---------- 命令面板（Ctrl / ⌘ + K） ----------
     与网格过滤共用 matchRank()，但多做了三件事：
       ① 跨分组汇总并带命中等级排序（网格要保留分组结构，无法整体排序）
       ② 键盘 ↑↓/Enter 全键盘操作
       ③ 非导航命中时给出「用搜索引擎搜索」的出口 —— 用户常常是想查东西，而不是找卡片 */
  var paletteState = { open: false, rows: [], active: -1, query: "" };

  // 从 site 配置里取搜索引擎（老配置没有这些字段时返回空数组，界面不出现该行、也不报错）
  function searchEngines() {
    var site = (activeConfig() && activeConfig().site) || {};
    var out = [];
    if (Array.isArray(site.searchEngines)) {
      site.searchEngines.forEach(function (e) {
        if (e && typeof e.name === "string" && typeof e.url === "string" && e.name.trim() && /%s|\{q\}/.test(e.url)) {
          out.push({ name: e.name.trim(), url: e.url });
        }
      });
    }
    // 兼容更早的单引擎写法：site.searchEngineUrl
    if (!out.length && typeof site.searchEngineUrl === "string" && /%s|\{q\}/.test(site.searchEngineUrl)) {
      out.push({ name: "搜索引擎", url: site.searchEngineUrl });
    }
    return out;
  }

  function defaultEngine() {
    var list = searchEngines();
    if (!list.length) return null;
    var site = (activeConfig() && activeConfig().site) || {};
    var want = typeof site.defaultEngine === "string" ? site.defaultEngine.trim() : "";
    if (want) {
      for (var i = 0; i < list.length; i++) if (list[i].name === want) return list[i];
    }
    return list[0];
  }

  function engineUrl(engine, query) {
    var enc = encodeURIComponent(query);
    return engine.url.replace(/\{q\}/g, enc).replace(/%s/g, enc);
  }

  // 标题高亮：只在「字面命中」时标注，拼音命中没有可高亮的片段（改为展示拼音徽标）
  function highlightTitle(title, kw, rank) {
    var t = String(title == null ? "" : title);
    if (kw && (rank === RANK.TITLE_START || rank === RANK.TITLE)) {
      var i = t.toLowerCase().indexOf(kw);
      if (i >= 0) {
        return escapeHtml(t.slice(0, i)) + "<mark>" + escapeHtml(t.slice(i, i + kw.length)) + "</mark>" +
               escapeHtml(t.slice(i + kw.length));
      }
    }
    return escapeHtml(t);
  }

  function paletteResults(query) {
    var kw = query.trim().toLowerCase();
    var cfg = activeConfig();
    var groups = (cfg && cfg.groups) || [];
    var rows = [];
    var total = 0;
    groups.forEach(function (g, gi) {
      (g.items || []).forEach(function (it, ii) {
        total++;
        var rank = matchRank(it, kw);
        if (rank < 0) return;
        rows.push({
          kind: "item", rank: rank, item: it, gi: gi, ii: ii,
          group: g.name || "未命名分组", title: it.title || "(未命名)"
        });
      });
    });
    // 排序：先命中等级，再按分组顺序与组内顺序（同分保持用户自己的编排，不引入随机感）
    rows.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.gi !== b.gi) return a.gi - b.gi;
      return a.ii - b.ii;
    });
    return { rows: rows, kw: kw, total: total };
  }

  function renderPalette() {
    var res = paletteResults(paletteState.query);
    paletteState.rows = res.rows;
    var kw = res.kw;
    var html = "";

    if (!res.rows.length) {
      paletteState.rows = [];
      paletteState.active = -1;
      var engOnly = kw ? defaultEngine() : null;
      paletteList.innerHTML = kw
        ? '<div class="palette-empty">没有匹配「' + escapeHtml(paletteState.query.trim()) + '」的导航项' +
          (engOnly ? "<br>按 Enter 用 " + escapeHtml(engOnly.name) + " 上网搜一搜" :
                     "<br>可在 config.json 的 site.searchEngines 配置搜索引擎，这里就能一键上网搜") + "</div>"
        : '<div class="palette-empty">输入关键词开始搜索<br>支持标题、描述、网址，以及中文的拼音与首字母（如「家庭影音」搜 jtyy）</div>';
      paletteScope.textContent = res.total ? res.total + " 个导航项" : "";
      if (engOnly) { appendEngineRow(engOnly); paletteSetActive(0, false); }
      return;
    }

    var lastGroup = null;
    res.rows.forEach(function (r, i) {
      if (r.group !== lastGroup) {
        html += '<div class="palette-sec">' + escapeHtml(r.group) + "</div>";
        lastGroup = r.group;
      }
      var iconUrl = resolveLogo(r.item);
      var iconHtml = iconUrl
        ? '<span class="palette-row-icon"><img src="' + escapeAttr(iconUrl) + '" alt="" loading="lazy" ' +
          'onerror="this.replaceWith(document.createTextNode(\'?\'))"></span>'
        : '<span class="palette-row-icon">' + escapeHtml(String(r.title).charAt(0)) + "</span>";
      var url = pickUrl(r.item);
      var pyBadge = (r.rank === RANK.PY_INI || r.rank === RANK.PY_FULL || r.rank === RANK.PY_LOOSE)
        ? (function () {
            var py = pinyinIndex(r.item.title);
            return py ? '<span class="palette-row-py">' + escapeHtml(py.full) + "</span>" : "";
          })()
        : "";
      html += '<a class="palette-row' + (i === paletteState.active ? " is-active" : "") + '"' +
              ' data-idx="' + i + '" role="option" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' +
              iconHtml +
              '<span class="palette-row-body">' +
                '<span class="palette-row-title">' + highlightTitle(r.title, kw, r.rank) + "</span>" +
                '<span class="palette-row-meta">' + escapeHtml(r.group) +
                  (r.item.desc ? " · " + escapeHtml(String(r.item.desc).slice(0, 60)) : "") + "</span>" +
              "</span>" + pyBadge + "</a>";
    });

    // 最后一项：用搜索引擎搜索当前关键词（仅配置了引擎时出现）
    var eng = kw ? defaultEngine() : null;
    paletteList.innerHTML = html;
    if (eng) appendEngineRow(eng);
    paletteScope.textContent = "命中 " + res.rows.length + " / " + res.total + " 项";
    paletteSetActive(paletteState.active < 0 ? 0 : paletteState.active, false);
  }

  // 搜索引擎出口行（追加在结果列表末尾，键盘可达）
  function appendEngineRow(eng) {
    var sec = document.createElement("div");
    sec.className = "palette-sec";
    sec.textContent = "联网搜索";
    var a = document.createElement("a");
    a.className = "palette-row";
    a.setAttribute("data-engine", "1");
    a.setAttribute("role", "option");
    a.href = engineUrl(eng, paletteState.query.trim());
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.innerHTML = '<span class="palette-row-icon">🔍</span>' +
      '<span class="palette-row-body">' +
        '<span class="palette-row-title">用 ' + escapeHtml(eng.name) + ' 搜索「' +
          escapeHtml(paletteState.query.trim()) + '」</span>' +
        '<span class="palette-row-meta">当前没有合适的导航项时，直接上网查找</span>' +
      "</span>";
    paletteList.appendChild(sec);
    paletteList.appendChild(a);
  }

  function paletteTotalRows() {
    return paletteList.querySelectorAll(".palette-row").length;
  }

  function paletteSetActive(idx, scroll) {
    var rowEls = paletteList.querySelectorAll(".palette-row");
    if (!rowEls.length) { paletteState.active = -1; return; }
    var n = rowEls.length;
    var i = ((idx % n) + n) % n;   // 环绕
    paletteState.active = i;
    for (var k = 0; k < n; k++) rowEls[k].classList.toggle("is-active", k === i);
    if (scroll !== false && rowEls[i].scrollIntoView) rowEls[i].scrollIntoView({ block: "nearest" });
  }

  function paletteMove(delta) {
    if (!paletteTotalRows()) return;
    paletteSetActive((paletteState.active < 0 ? 0 : paletteState.active + delta));
  }

  function paletteActivate() {
    var el = paletteList.querySelectorAll(".palette-row")[paletteState.active];
    if (!el) return;
    window.open(el.getAttribute("href"), "_blank", "noopener");
    closePalette();
  }

  function openPalette() {
    paletteState.open = true;
    paletteState.active = -1;
    paletteInput.value = state.keyword || "";
    paletteState.query = paletteInput.value;
    paletteMask.hidden = false;
    renderPalette();
    paletteInput.focus();
    paletteInput.select();
    // 面板就是搜索界面，打开即取拼音表（不等待、不阻塞渲染）
    ensurePinyin().then(function (ok) { if (ok && paletteState.open) renderPalette(); });
  }

  function closePalette() {
    paletteState.open = false;
    paletteMask.hidden = true;
  }

  function togglePalette() {
    if (paletteState.open) closePalette(); else openPalette();
  }

  paletteInput.addEventListener("input", function () {
    paletteState.query = paletteInput.value;
    paletteState.active = -1;
    renderPalette();
    if (needsPinyin(paletteState.query.trim().toLowerCase())) {
      ensurePinyin().then(function (ok) { if (ok && paletteState.open) { paletteState.active = -1; renderPalette(); } });
    }
  });

  paletteList.addEventListener("mousemove", function (e) {
    var row = e.target.closest ? e.target.closest(".palette-row") : null;
    if (!row) return;
    var idx = Number(row.getAttribute("data-idx"));
    if (!isNaN(idx) && idx !== paletteState.active) paletteSetActive(idx, false);
  });
  paletteList.addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest(".palette-row") : null;
    if (!row) return;
    if (String(row.getAttribute("href") || "").charAt(0) === "#") e.preventDefault();
    closePalette();   // 由浏览器按 target="_blank" 打开链接
  });
  paletteClose.addEventListener("click", closePalette);
  paletteMask.addEventListener("click", function (e) { if (e.target === paletteMask) closePalette(); });

  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();

    // Ctrl/⌘ + K：开关命令面板（在任何位置都生效，包括输入框内）
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === "k") {
      e.preventDefault();
      togglePalette();
      return;
    }

    if (paletteState.open) {
      if (k === "escape") { e.preventDefault(); closePalette(); paletteInput.blur(); return; }
      if (k === "arrowdown") { e.preventDefault(); paletteMove(1); return; }
      if (k === "arrowup") { e.preventDefault(); paletteMove(-1); return; }
      if (k === "enter") { e.preventDefault(); paletteActivate(); return; }
      if (k === "tab") { e.preventDefault(); paletteMove(e.shiftKey ? -1 : 1); return; }
      return;   // 面板打开时吞掉其余按键，避免触发页面级快捷键
    }

    if (e.key === "/" && document.activeElement !== searchInput &&
        !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      searchInput.focus();
    } else if (e.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      state.keyword = "";
      render();
      searchInput.blur();
    }
  });

  /* ---------- 时钟 ---------- */
  function tickClock() {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    document.getElementById("clock").textContent =
      pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    var week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    document.getElementById("dateText").textContent =
      now.getFullYear() + " 年 " + (now.getMonth() + 1) + " 月 " + now.getDate() + " 日 · 星期" + week;
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ============================================================
     系统状态板（Widget：容器 / CPU / 内存 / 磁盘）
     ------------------------------------------------------------
     数据来自 GET /api/status，正常 30s 轮询一次。三条都是「降级」要求：
       ① 页面切到后台就停止轮询（document.hidden），切回时若数据已陈旧立刻补一次；
       ② 任何一项为 null 一律显示「不可用」而不是 0 —— 0 会被读成「真的没有」；
       ③ 失败不刷屏：连续失败走指数退避（30s → 60s → 120s 封顶）；
          从来没拿到过数据（例如旧镜像里没有 /api/status）就把状态板隐藏掉，
          静默退场比在首页挂个报错体面。
     ============================================================ */
  var STATUS_URL = "/api/status";
  var STATUS_INTERVAL = 30000;
  var STATUS_MAX_BACKOFF = 120000;

  var sbBoard = document.getElementById("statusBoard");
  var sbRefresh = document.getElementById("sbRefresh");
  var sbNodes = {
    docker: document.getElementById("sbDocker"),
    cpu: document.getElementById("sbCpu"),
    mem: document.getElementById("sbMem"),
    disk: document.getElementById("sbDisk")
  };
  var sbItems = {
    docker: document.getElementById("sbDockerItem"),
    cpu: document.getElementById("sbCpuItem"),
    mem: document.getElementById("sbMemItem"),
    disk: document.getElementById("sbDiskItem")
  };
  var sbBars = {
    cpu: document.getElementById("sbCpuBar"),
    mem: document.getElementById("sbMemBar"),
    disk: document.getElementById("sbDiskBar")
  };
  var statusState = {
    timer: null, started: false, stopped: false,
    fails: 0, busy: false, hasData: false, last: null, lastAt: 0
  };

  // 站点配置可整体关掉状态板：site.statusBoard = false
  function statusBoardEnabled() {
    var site = (state.config && state.config.site) || {};
    return site.statusBoard !== false;
  }

  function fmtBytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) return "";
    var units = ["B", "KB", "MB", "GB", "TB", "PB"];
    var i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0)) + " " + units[i];
  }

  function fmtDuration(sec) {
    var s = Math.round(Number(sec) || 0);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
  }

  // opt = { text, percent, title, na }
  function setStat(key, opt) {
    var o = opt || {};
    var item = sbItems[key], node = sbNodes[key], bar = sbBars[key];
    if (node) node.textContent = o.text;
    if (item) {
      if (o.na) {
        item.setAttribute("data-state", "na");
        item.removeAttribute("data-level");
      } else {
        item.setAttribute("data-state", "ok");
        var pct = o.percent;
        if (typeof pct === "number" && pct >= 90) item.setAttribute("data-level", "hot");
        else if (typeof pct === "number" && pct >= 75) item.setAttribute("data-level", "warn");
        else item.removeAttribute("data-level");
      }
      if (o.title) item.title = o.title; else item.removeAttribute("title");
    }
    if (bar) {
      var p = (typeof o.percent === "number") ? o.percent : null;
      // 有值就给最小 2% 的可见宽度，让「1%」和「0%」在视觉上能区分
      bar.style.width = p === null ? "0" : Math.max(2, Math.min(100, p)) + "%";
    }
  }

  function renderStatus(data) {
    if (!sbBoard) return;
    var d = data || {};
    var docker = d.docker || {};
    var host = d.host || {};

    if (docker.available) {
      var extra = [];
      if (docker.stopped) extra.push(docker.stopped + " 已停止");
      if (docker.paused) extra.push(docker.paused + " 暂停");
      setStat("docker", {
        text: docker.running + " / " + docker.total,
        title: "Docker 容器：" + docker.running + " 运行中" +
               (extra.length ? "、" + extra.join("、") : "") + "，共 " + docker.total + " 个"
      });
    } else {
      setStat("docker", { text: "不可用", na: true, title: docker.error || "无法连接 Docker" });
    }

    var cpu = d.cpu || {};
    var cpuPct = (typeof cpu.percent === "number") ? cpu.percent : null;
    setStat("cpu", {
      text: cpuPct === null ? "不可用" : cpuPct + "%",
      percent: cpuPct,
      na: cpuPct === null,
      title: (cpu.cores ? cpu.cores + " 核" : "") +
             (host.loadavg ? " · 1/5/15 分钟负载 " + host.loadavg.join(" / ") : "")
    });

    var mem = d.mem;
    if (mem && typeof mem.percent === "number") {
      setStat("mem", {
        text: mem.percent + "%",
        percent: mem.percent,
        title: "内存：" + fmtBytes(mem.used) + " / " + fmtBytes(mem.total) +
               (mem.source ? "（来源 " + mem.source + "）" : "")
      });
    } else {
      setStat("mem", { text: "不可用", na: true, title: "当前环境取不到内存信息" });
    }

    var disk = d.disk;
    if (disk && typeof disk.percent === "number") {
      setStat("disk", {
        text: disk.percent + "%",
        percent: disk.percent,
        title: "数据盘 " + (disk.path || "") + "：" + fmtBytes(disk.used) + " / " + fmtBytes(disk.total) +
               "（剩余 " + fmtBytes(disk.available) + "）"
      });
    } else {
      setStat("disk", { text: "不可用", na: true, title: "当前环境取不到磁盘信息" });
    }

    var navi = d.navi || {};
    if (sbBoard) {
      sbBoard.title = "Navi 已运行 " + fmtDuration(navi.uptimeSec) +
                      (host.hostname ? " · 主机 " + host.hostname : "") +
                      (navi.uploads ? " · 图床库 " + navi.uploads.count + (navi.uploads.truncated ? "+" : "") +
                        " 张（" + fmtBytes(navi.uploads.bytes) + "）" : "") +
                      "\n数据目录：" + (navi.dataDir || "未知") +
                      "\n数据更新于 " + new Date(d.at || Date.now()).toLocaleTimeString();
    }
  }

  function scheduleStatusPoll() {
    if (statusState.stopped || document.hidden) return;
    // 连续失败时退避：30s → 60s → 120s（封顶）
    var wait = Math.min(STATUS_INTERVAL * Math.pow(2, Math.min(statusState.fails, 2)), STATUS_MAX_BACKOFF);
    if (statusState.timer) clearTimeout(statusState.timer);
    statusState.timer = setTimeout(function () {
      statusState.timer = null;
      if (statusState.stopped || document.hidden) return;
      refreshStatus(false);
    }, wait);
  }

  function stopStatusPolling() {
    statusState.stopped = true;
    if (statusState.timer) { clearTimeout(statusState.timer); statusState.timer = null; }
  }

  function refreshStatus(fresh) {
    if (!sbBoard || statusState.busy) return Promise.resolve(null);
    statusState.busy = true;
    if (sbRefresh) sbRefresh.classList.add("is-busy");
    return fetch(STATUS_URL + (fresh ? "?fresh=1" : ""), { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        statusState.fails = 0;
        // 服务端显式关闭状态板（NAVI_STATUS_BOARD=0）：静默隐藏，不再轮询
        if (data && data.disabled) { sbBoard.hidden = true; stopStatusPolling(); return null; }
        if (!data || data.ok !== true) throw new Error((data && data.error) || "状态接口返回异常");
        statusState.last = data;
        statusState.lastAt = Date.now();
        statusState.hasData = true;
        renderStatus(data);
        sbBoard.hidden = false;
        sbBoard.classList.remove("is-stale");
        return data;
      })
      .catch(function () {
        statusState.fails++;
        if (!statusState.hasData) {
          // 从未成功过：多半是接口不存在（老镜像 / 纯静态托管）→ 隐藏并停止轮询
          sbBoard.hidden = true;
          stopStatusPolling();
        } else {
          sbBoard.classList.add("is-stale");   // 曾有过数据：标脏但保留上一轮数字
        }
        return null;
      })
      .then(function (r) {
        statusState.busy = false;
        if (sbRefresh) sbRefresh.classList.remove("is-busy");
        scheduleStatusPoll();
        return r;
      });
  }

  function startStatusPolling() {
    if (statusState.started || !sbBoard) return;
    if (!statusBoardEnabled()) return;
    statusState.started = true;
    statusState.stopped = false;
    refreshStatus(false);
  }

  // 只读快照，供自动化测试与排障使用
  function statusSnapshot() {
    return {
      started: statusState.started,
      stopped: statusState.stopped,
      fails: statusState.fails,
      hasData: statusState.hasData,
      lastAt: statusState.lastAt,
      waiting: !!statusState.timer,
      hidden: !!(sbBoard && sbBoard.hidden),
      stale: !!(sbBoard && sbBoard.classList.contains("is-stale")),
      data: statusState.last
    };
  }

  document.addEventListener("visibilitychange", function () {
    if (!statusState.started || statusState.stopped) return;
    if (document.hidden) {
      // 后台不排期：省掉无意义的请求（NAS 上可能有一堆标签页开着）
      if (statusState.timer) { clearTimeout(statusState.timer); statusState.timer = null; }
      return;
    }
    if (Date.now() - statusState.lastAt >= STATUS_INTERVAL) refreshStatus(false);
    else scheduleStatusPoll();
  });

  if (sbRefresh) {
    sbRefresh.addEventListener("click", function () {
      statusState.fails = 0;             // 手动刷新视为「重新开始」，清掉退避
      refreshStatus(true);
    });
  }

  /* ============================================================
     编辑模式
     ============================================================ */

  function enterEditMode() {
    state.editMode = true;
    state.dirty = false;
    state.draft = deepCopy(state.config);
    document.body.classList.add("edit-mode");
    editToggle.setAttribute("aria-pressed", "true");
    editLabel.textContent = "完成";
    addGroupBtn.hidden = false;
    saveBar.hidden = false;
    updateSaveBarTip();
    render();
  }

  function exitEditMode(keepDraft) {
    state.editMode = false;
    state.dirty = false;
    state.draft = null;
    document.body.classList.remove("edit-mode");
    editToggle.setAttribute("aria-pressed", "false");
    editLabel.textContent = "编辑";
    addGroupBtn.hidden = true;
    saveBar.hidden = true;
    // 退出编辑模式时一并关闭服务发现弹窗并清空结果，避免草稿销毁后残留界面
    var dm = document.getElementById("discoverModal");
    if (dm) dm.hidden = true;
    discoverItems = [];
    discoverMeta = null;
    render();
  }

  function updateSaveBarTip() {
    if (!state.apiAvailable) {
      saveBarTip.textContent = "静态托管模式：保存将存入浏览器本地，建议同时「导出」JSON 备份";
    } else if (state.dirty) {
      saveBarTip.textContent = "有未保存的修改";
    } else {
      saveBarTip.textContent = "编辑模式：拖动卡片排序，完成后记得保存";
    }
  }

  function markDirty() {
    state.dirty = true;
    updateSaveBarTip();
  }

  editToggle.addEventListener("click", function () {
    if (!state.editMode) {
      enterEditMode();
    } else if (!state.dirty || confirm("有未保存的修改，确定退出编辑模式吗？")) {
      exitEditMode();
    }
  });

  /* ---------- 保存 / 取消 / 导出 ---------- */
  saveBtn.addEventListener("click", function () {
    if (!state.draft) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";

    fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.draft)
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (res.status === 401) {
            location.replace("/login.html"); // 编辑保存时会话已过期
            throw { unauth: true };
          }
          if (res.ok && data && data.ok) {
            // 保存成功：写回本地配置、给出成功反馈后退出编辑模式
            state.config = deepCopy(state.draft);
            applySiteInfo(state.config.site);
            // 新加的卡片可能带来新的内网地址 → 重新探测一轮；
            // 已探测过的 origin 命中 5 分钟缓存，不会被重复打扰。
            restartLanProbes();
            saveBtn.textContent = "已保存 ✓";
            setTimeout(function () { exitEditMode(); }, 350);
            return;
          }
          // 服务端明确拒绝（400 校验失败 / 500 写入失败等）：清晰提示，
          // 保留编辑内容，不降级本地、不退出编辑模式，让用户修正后重试
          var msg = (data && data.error) ? data.error : ("HTTP " + res.status);
          throw { serverError: msg };
        });
      })
      .catch(function (err) {
        if (err && err.unauth) return; // 已跳转到登录页
        if (err && err.serverError) {
          // 服务端明确拒绝：仅提示具体原因，保留编辑内容
          alert("保存失败：" + err.serverError);
          return;
        }
        // 真正的网络/连接层错误（无法到达服务器）：降级为浏览器本地保存 + 提示导出
        try {
          localStorage.setItem(STORAGE_DRAFT_KEY, JSON.stringify(state.draft));
        } catch (e) {}
        state.config = deepCopy(state.draft);
        applySiteInfo(state.config.site);
        exitEditMode();
        alert("未能连接服务器（" + (err && err.message ? err.message : "网络错误") + "）。\n" +
              "修改已保存到浏览器本地；如需在其他设备生效，请点「导出」下载 config.json 替换服务器上的同名文件。");
      })
      .finally(function () {
        saveBtn.disabled = false;
        if (saveBtn.textContent === "保存中…") saveBtn.textContent = "保存";
      });
  });

  cancelEditBtn.addEventListener("click", function () {
    if (!state.dirty || confirm("放弃所有未保存的修改？")) {
      exitEditMode();
    }
  });

  /* ---------- 数据备份 / 恢复 ---------- */
  // 导出：后端支持时弹出格式选择（完整 zip / 仅配置 json）；纯静态托管只能导出本地草稿
  backupBtn.addEventListener("click", function () {
    if (state.apiAvailable) {
      openModal(backupModal);
      return;
    }
    downloadConfigJson();
  });

  // 完整备份（zip）：配置 + 图床库图片，后端已附带 Content-Disposition 附件头，直接导航下载
  backupZipOpt.addEventListener("click", function () {
    closeModal(backupModal);
    window.location.href = "/api/backup?format=zip";
  });

  // 仅配置（json）：体积小、可人工阅读编辑，与历史版本逐字节一致
  backupJsonOpt.addEventListener("click", function () {
    closeModal(backupModal);
    window.location.href = "/api/backup";
  });

  // 纯静态托管的降级导出（只有本地草稿，没有图片可打包）
  function downloadConfigJson() {
    var data = state.draft || state.config;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  importBtn.addEventListener("click", function () {
    importFile.value = "";
    importFile.click();
  });

  importFile.addEventListener("change", function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;

    // 统一按二进制读入：ZIP 与 JSON 都能处理；格式判定以文件头为准，不轻信扩展名
    var reader = new FileReader();
    reader.onload = function () {
      var raw = reader.result;
      var bytes = new Uint8Array(raw || []);
      // "PK\x03\x04"（普通 zip）/ "PK\x05\x06"（空 zip）
      var isZipMagic = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
        ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
      if (isZipMagic) { restoreFromZip(raw); return; }
      restoreFromJson(raw);
    };
    reader.onerror = function () {
      alert("导入失败：无法读取所选文件。");
    };
    reader.readAsArrayBuffer(file);
  });

  // ---- JSON 备份恢复（原有链路，仅改为从 ArrayBuffer 解码） ----
  function restoreFromJson(raw) {
    var text;
    try {
      text = new TextDecoder("utf-8").decode(new Uint8Array(raw || []));
    } catch (e) {
      alert("导入失败：无法解码文件内容。");
      return;
    }
    var body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      alert("导入失败：文件不是合法的 JSON 数据，也不是 Navi 的 ZIP 备份包。");
      return;
    }
    // 客户端先行校验格式/版本/校验和，减少无谓的服务器往返，并给出更早的明确提示
    verifyBackupLocal(body).then(function (localErr) {
      if (localErr) {
        alert("导入失败：" + localErr);
        return;
      }
      var count = 0;
      (body.config.groups || []).forEach(function (g) { count += (g.items || []).length; });
      var imgNote = Array.isArray(body.files) && body.files.length
        ? "\n注意：该备份记录了 " + body.files.length + " 张图片，但它不是 ZIP 包，图片无法随配置一起恢复。"
        : "";
      if (!confirm("即将用备份文件覆盖当前全部数据（共 " + count + " 个导航项）。" + imgNote + "\n此操作不可撤销，是否继续？")) {
        return;
      }
      if (!state.apiAvailable) {
        // 无后端：直接写入本地草稿并刷新渲染
        state.config = deepCopy(body.config);
        applySiteInfo(state.config.site);
        render();
        alert("已从备份恢复到本地草稿（静态托管模式）。");
        return;
      }
      postRestore(new Blob([text], { type: "application/json" }));
    });
  }

  // ---- ZIP 完整备份恢复 ----
  // 浏览器侧不做预检：ZIP 需要解包才能读到清单，而在前端实现解包既增加体积又与后端逻辑重复。
  // 完整性由后端逐项 SHA-256 权威校验（前端预检从来只是「提前提示」，不是把关口）。
  function restoreFromZip(raw) {
    if (!state.apiAvailable) {
      alert("导入失败：ZIP 完整备份需要后端服务支持（当前为静态托管模式）。\n请改用仅配置的 .json 备份。");
      return;
    }
    var sizeMB = ((raw && raw.byteLength) || 0) / 1024 / 1024;
    if (!confirm("即将用这个备份包（" + sizeMB.toFixed(1) + " MB）覆盖当前全部数据，并还原其中的图床库图片。\n" +
                 "此操作不可撤销，是否继续？")) {
      return;
    }
    postRestore(new Blob([raw], { type: "application/zip" }));
  }

  // 统一的恢复提交：JSON 与 ZIP 走同一入口，仅 Content-Type 不同
  function postRestore(blob) {
    var ctype = blob.type || "application/json";
    fetch("/api/backup/restore", { method: "POST", headers: { "Content-Type": ctype }, body: blob })
      .then(function (res) {
        return res.text().then(function (txt) {
          if (res.status === 401) {
            location.replace("/login.html");
            throw { unauth: true };
          }
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { data = null; }
          if (!res.ok || !data || !data.ok) {
            throw { serverError: (data && data.error) || ("HTTP " + res.status) };
          }
          return data;
        });
      })
      .then(function (data) {
        var msg = "恢复成功";
        if (data && data.format === "zip" && data.images) {
          msg += "，已还原图片 " + data.images.written + " 张";
          if (data.images.skipped) msg += "（另有 " + data.images.skipped + " 张内容一致，已跳过）";
        }
        if (data && data.rollbackDir) {
          msg += "\n被覆盖的原图已备份到：\n" + data.rollbackDir;
        }
        alert(msg + "，即将刷新以加载最新数据。");
        location.reload();
      })
      .catch(function (err) {
        if (err && err.unauth) return;
        alert("导入失败：" + (err && err.serverError ? err.serverError : (err && err.message ? err.message : "未知错误")));
      });
  }

  // 客户端备份校验（与后端 verifyBackup 同规则，用于尽早提示）。返回 Promise<error|null>
  function verifyBackupLocal(body) {
    if (!body || typeof body !== "object") return Promise.resolve("文件格式错误（不是合法 JSON 对象）");
    if (body.format !== BACKUP_FORMAT) return Promise.resolve("文件格式不匹配（不是 Navi 备份文件）");
    if (typeof body.version !== "number" || body.version > BACKUP_VERSION) {
      return Promise.resolve("不支持的备份版本（v" + body.version + "）");
    }
    if (!body.config || typeof body.config !== "object") return Promise.resolve("备份内容缺少 config 字段");
    if (!Array.isArray(body.config.groups)) return Promise.resolve("配置缺少 groups 数组");
    // 有校验和则校验完整性（老版无校验和的 config 导出则跳过）
    if (body.checksum && typeof body.checksum === "string") {
      return sha256hex(JSON.stringify(body.config)).then(function (expect) {
        // expect 为 null = 本地算不出哈希，跳过预检：
        // 局域网 IP + 明文 HTTP 属非安全上下文，浏览器不提供 crypto.subtle。
        // 真正的完整性校验以后端为准，这里只是「尽早提示」，绝不能反客为主。
        if (!expect) return null;
        return body.checksum.toLowerCase() === expect ? null : "文件完整性校验失败（数据可能被篡改或损坏）";
      });
    }
    return Promise.resolve(null);
  }

  // 前端 SHA-256（异步，基于 Web Crypto）。返回 null 表示「本地无法计算」，
  // 调用方必须据此跳过校验，而不是当成校验不通过。
  function sha256hex(str) {
    // 非安全上下文（http:// + 局域网 IP/域名，非 localhost）下 crypto.subtle 为 undefined
    if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest)) {
      return Promise.resolve(null);
    }
    try {
      var utf8 = new TextEncoder().encode(str);
      return crypto.subtle.digest("SHA-256", utf8).then(function (buf) {
        var hex = "";
        var bytes = new Uint8Array(buf);
        for (var i = 0; i < bytes.length; i++) {
          hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
        }
        return hex;
      }).catch(function () {
        return null; // 摘要失败同样降级为「本地无法校验」
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* ---------- 弹窗 ---------- */
  var itemModal = document.getElementById("itemModal");
  var itemForm = document.getElementById("itemForm");
  var itemModalTitle = document.getElementById("itemModalTitle");
  // P1-7：卡片被标记为「可能已失效」时，在编辑弹窗里说明原因并给一个恢复入口
  var itemStaleNote = document.getElementById("itemStaleNote");
  var itemStaleText = document.getElementById("itemStaleText");
  var itemRestoreBtn = document.getElementById("itemRestoreBtn");
  var groupModal = document.getElementById("groupModal");
  var groupForm = document.getElementById("groupForm");
  var groupModalTitle = document.getElementById("groupModalTitle");
  var editingItem = null;  // {gi, ii}，ii = -1 表示新增
  var editingGroup = -1;   // 分组索引，-1 表示新增

  function openModal(mask) { mask.hidden = false; }
  function closeModal(mask) { mask.hidden = true; }

  document.querySelectorAll("[data-close]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeModal(document.getElementById(btn.getAttribute("data-close")));
    });
  });
  [itemModal, groupModal, backupModal, document.getElementById("discoverModal"), libraryModal].forEach(function (mask) {
    mask.addEventListener("click", function (e) {
      if (e.target === mask) closeModal(mask);
    });
  });

  /* ---------- 首次使用引导 ----------
     只在「有后端（能保存）、且配置里一张卡片都没有、且没被跳过过」时出现。
     三个判断缺一不可：
       · 无后端（静态托管预览）→ 用户改不了任何东西，弹向导只会碍事；
       · 已有卡片 → 老用户不需要它；
       · 跳过过 → 尊重用户选择，不再打扰（localStorage 记住）。 */
  var firstRun = document.getElementById("firstRun");
  var frStart = document.getElementById("frStart");
  var frDiscover = document.getElementById("frDiscover");
  var frDismiss = document.getElementById("frDismiss");
  var FIRST_RUN_KEY = "navi-firstrun-done";

  function configItemCount(cfg) {
    if (!cfg || !Array.isArray(cfg.groups)) return 0;
    var n = 0;
    cfg.groups.forEach(function (g) { n += ((g && g.items) || []).length; });
    return n;
  }

  function firstRunDismissed() {
    try { return localStorage.getItem(FIRST_RUN_KEY) === "1"; } catch (e) { return true; }
  }

  function dismissFirstRun() {
    try { localStorage.setItem(FIRST_RUN_KEY, "1"); } catch (e) {}
    closeModal(firstRun);
  }

  function maybeShowFirstRun() {
    if (!state.apiAvailable) return;          // 无后端：改了也存不下来
    if (firstRunDismissed()) return;
    if (configItemCount(state.config) > 0) return;
    openModal(firstRun);
  }

  frDismiss.addEventListener("click", dismissFirstRun);

  frStart.addEventListener("click", function () {
    dismissFirstRun();
    if (!state.editMode) editToggle.click();
    openGroupModal(-1);                        // 空配置下第一步就是建分组
  });

  frDiscover.addEventListener("click", function () {
    dismissFirstRun();
    if (!state.editMode) editToggle.click();
    var btn = document.getElementById("discoverBtn");
    if (btn) btn.click();                      // 复用既有入口，不另写一套加载逻辑
  });

  /* ---------- P1-7：来源文案与失效说明 ---------- */
  // 来源可读文案：「服务发现 · Docker 容器（a1b2c3d4）」/「手工添加」/「导入」。
  // 旧配置里没有 source 的卡片返回空串（不显示来源行，也不当作手工卡片去猜）。
  function sourceLabel(it) {
    var src = it && it.source;
    if (!src || typeof src !== "object" || !src.type) return "";
    if (src.type === "discover") {
      var via = src.via === "docker" ? "Docker 容器" : (src.via === "local" ? "本机端口" : "服务发现");
      return "服务发现 · " + via + (src.id ? "（" + src.id + "）" : "");
    }
    if (src.type === "manual") return "手工添加";
    if (src.type === "import") return "导入";
    return "";
  }

  function staleHintText(it) {
    var t = "此卡片来自服务发现，但最近一次扫描已找不到它的来源" +
            "（容器被删除，或该端口已不再监听）。它不会因此被自动删除，" +
            "链接照常可用 —— 确认不再需要时再自行删除。";
    var at = it && it.staleAt ? new Date(it.staleAt) : null;
    if (at && !isNaN(at.getTime())) t += "（标记于 " + at.toLocaleString() + "）";
    return t;
  }

  function openItemModal(gi, ii) {
    editingItem = { gi: gi, ii: ii };
    itemForm.reset();
    resetLogoField();
    if (ii >= 0) {
      var it = state.draft.groups[gi].items[ii];
      itemForm.title.value = it.title || "";
      itemForm.desc.value = it.desc || "";
      itemForm.url.value = it.url || "";
      itemForm.lanUrl.value = it.lanUrl || "";
      itemForm.netMode.value = NET_MODES.indexOf(it.netMode) >= 0 ? it.netMode : "auto";
      itemForm.icon.value = it.icon || "";
      setLogoValue(it.logo || "");
      itemModalTitle.textContent = "编辑导航项";
      // 失效标记：说明原因 + 就地恢复入口（恢复只清标记，不动其它字段）
      itemStaleNote.hidden = !it.stale;
      itemStaleText.textContent = it.stale ? staleHintText(it) : "";
    } else {
      itemModalTitle.textContent = "添加导航项";
      itemStaleNote.hidden = true;
      itemStaleText.textContent = "";
    }
    openModal(itemModal);
    itemForm.title.focus();
  }

  // 「恢复」：清除失效标记（不删除卡片、不改任何其它字段）
  itemRestoreBtn.addEventListener("click", function () {
    if (!editingItem || editingItem.ii < 0 || !state.draft) return;
    var it = state.draft.groups[editingItem.gi].items[editingItem.ii];
    if (!it) return;
    delete it.stale;
    delete it.staleAt;
    itemStaleNote.hidden = true;
    itemStaleText.textContent = "";
    markDirty();
  });

  /* ---------- Logo 本地上传 ---------- */
  function resetLogoField() {
    logoInput.value = "";
    setLogoStatus("", "");
    refreshIconPreview();
  }

  // 卡片最终生效的图标：本地图床（logo）优先，其次在线图标（icon）——
  // 与 render() 里 resolveLogo() 的判定顺序完全一致，保证弹窗预览＝卡片真实显示结果。
  function effectiveIconPreview() {
    if (logoInput.value) return logoInput.value;
    var ic = (itemForm.icon.value || "").trim();
    if (ic) return resolveIcon(ic, (itemForm.title.value || "").trim());
    return null;
  }

  function refreshIconPreview() {
    var url = effectiveIconPreview();
    if (url) {
      if (logoPreview.getAttribute("src") !== url) logoPreview.src = url;
      logoPreview.hidden = false;
      logoEmpty.hidden = true;
    } else {
      logoPreview.hidden = true;
      logoPreview.removeAttribute("src");
      logoEmpty.hidden = false;
    }
    logoClearBtn.hidden = !logoInput.value;
  }

  function setLogoValue(url) {
    logoInput.value = url || "";
    refreshIconPreview();
  }

  function setLogoStatus(msg, kind) {
    logoStatus.textContent = msg || "";
    logoStatus.className = "logo-status" + (kind ? " " + kind : "");
  }

  logoPickBtn.addEventListener("click", function () {
    logoFile.value = "";
    logoFile.click();
  });

  logoClearBtn.addEventListener("click", function () {
    setLogoValue("");
    setLogoStatus("已清除本地上传 Logo", "ok");
  });

  // 「上传图片」：可一次选多张。全部写入本地图床库，本卡片直接选用第一张成功的，
  // 其余留在图床库里供其它卡片复用（这是与「从图床库选择」配套的核心行为）。
  logoFile.addEventListener("change", function () {
    var files = Array.prototype.slice.call(logoFile.files || []);
    logoFile.value = "";
    if (!files.length) return;

    setLogoStatus(files.length > 1 ? ("上传中（共 " + files.length + " 张）…") : "上传中…", "");
    uploadFilesToLibrary(files).then(function (sum) {
      if (sum.unauth) return;
      if (!sum.urls.length) {
        setLogoStatus("上传失败：" + (sum.failures[0] || "未知错误"), "err");
        return;
      }
      setLogoValue(sum.urls[0]);
      var msg = "上传成功 " + sum.success + " 张";
      if (files.length > 1) msg += "，本卡片已选用首张（其余可在「从图床库选择」中复用）";
      if (sum.failed) msg += "；失败 " + sum.failed + " 张：" + sum.failures.join("；");
      setLogoStatus(msg, sum.failed ? "" : "ok");
    });
  });

  itemForm.title.addEventListener("input", refreshIconPreview);

  // 手动填写 / 修改在线图标时同步刷新预览（含 Dashboard Icons 按名称推断的情况）
  itemForm.icon.addEventListener("input", refreshIconPreview);

  /* ============================================================
     本地图床库 + 图标选择器
     - 图床库的「目录」直接来自服务端上传目录（GET /api/library），前端不维护副本；
     - 卡片侧两种来源互不冲突：图床（logo 字段，/uploads/*）优先于在线图标（icon 字段）；
     - 批量上传按「原图字节预算 + 单批张数」分片，串行提交，部分失败不影响其余图片。
     ============================================================ */
  var LIB_MAX_FILES = 20;                    // 与服务端一致：单次请求最多 20 张
  var LIB_MAX_SIZE = 3 * 1024 * 1024;        // 单张上限 3MB（与服务端一致）
  var LIB_CHUNK_BYTES = 6 * 1024 * 1024;     // 单请求的原图字节预算（base64 膨胀约 1.33 倍，服务端上限 16MB）

  var libraryState = {
    mode: "manage",     // manage = 图床库管理；pick = 为卡片挑图标
    tab: "local",
    images: [],
    presets: [],
    dir: "",
    query: "",
    selected: {},       // name -> true（仅管理模式使用）
    onlineResults: null, // null 表示未搜索（显示内置推荐）
    onlineError: "",
    loading: false
  };

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error("无法读取文件")); };
      reader.readAsDataURL(file);
    });
  }

  // 批量上传图标到本地图床库。返回汇总：
  // { success, failed, urls: [已入库图片地址], failures: [可读原因], unauth }
  function uploadFilesToLibrary(fileList, onProgress) {
    var list = Array.prototype.slice.call(fileList || []);
    var sum = { success: 0, failed: 0, urls: [], failures: [], unauth: false };
    var total = list.length;
    var done = 0;
    var idx = 0;

    function report() { if (onProgress) onProgress(done, total); }

    // 取下一批：跳过非法文件（记为失败），并按字节预算 + 张数上限切分
    function nextBatch() {
      var batch = [], bytes = 0;
      while (idx < list.length && batch.length < LIB_MAX_FILES) {
        var f = list[idx];
        if (!/^image\/(png|jpeg|gif|webp)$/i.test(f.type)) {
          sum.failures.push(f.name + "：格式不支持（仅 PNG / JPEG / GIF / WebP）");
          sum.failed++; idx++; done++; report(); continue;
        }
        if (f.size > LIB_MAX_SIZE) {
          sum.failures.push(f.name + "：超过单张 3MB 上限");
          sum.failed++; idx++; done++; report(); continue;
        }
        if (batch.length && bytes + f.size > LIB_CHUNK_BYTES) break;
        batch.push(f); bytes += f.size; idx++;
      }
      return batch;
    }

    function postBatch(payload) {
      if (!payload.length) return Promise.resolve({ results: [] });
      return fetch("/api/library/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: payload })
      }).then(function (res) {
        if (res.status === 401) {
          sum.unauth = true;
          location.replace("/login.html");
          return { results: [] };
        }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data) {
            var em = (data && data.error) || ("HTTP " + res.status);
            payload.forEach(function (it) { sum.failures.push(it.name + "：" + em); sum.failed++; });
            return { results: [] };
          }
          return data;
        });
      }).catch(function () {
        payload.forEach(function (it) { sum.failures.push(it.name + "：网络错误"); sum.failed++; });
        return { results: [] };
      });
    }

    function loop() {
      var batch = nextBatch();
      while (!batch.length && idx < list.length) batch = nextBatch();
      if (!batch.length) return Promise.resolve(sum);

      return Promise.all(batch.map(function (f) {
        return fileToDataUrl(f)
          .then(function (dataUrl) { return { name: f.name, dataUrl: dataUrl }; })
          .catch(function () { return { name: f.name, readError: true }; });
      })).then(function (items) {
        var payload = [], readFails = 0;
        items.forEach(function (it) {
          if (it.readError) { sum.failures.push(it.name + "：无法读取文件"); sum.failed++; readFails++; }
          else payload.push(it);
        });
        return postBatch(payload).then(function (json) {
          (json.results || []).forEach(function (r) {
            if (r.ok) { sum.success++; sum.urls.push(r.url); }
            else { sum.failed++; sum.failures.push((r.label || "图片") + "：" + (r.error || "上传失败")); }
          });
          done += readFails ? (batch.length - payload.length) : 0;
          done += payload.length;
          report();
          return loop();
        });
      });
    }

    report();
    return loop();
  }

  /* ---------- 图床库弹窗：打开 / 关闭 / 标签页 ---------- */
  function setLibraryTab(tab) {
    libraryState.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".lib-tab"), function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    libPaneLocal.hidden = tab !== "local";
    libPaneOnline.hidden = tab !== "online";
    if (tab === "online") renderOnlineIcons();
    else renderLibrary();
  }

  function openLibrary(mode, tab) {
    libraryState.mode = mode === "pick" ? "pick" : "manage";
    libraryState.selected = {};
    libraryState.query = "";
    libraryState.onlineResults = null;
    libraryState.onlineError = "";
    iconSearch.value = "";
    libSearch.value = "";
    libResult.hidden = true;
    libProgress.hidden = true;
    libDrop.classList.remove("is-busy", "is-over");

    if (libraryState.mode === "pick") {
      libraryTitle.textContent = "选择图标";
      libraryModeTag.textContent = "点选即应用到当前卡片";
      libTabs.hidden = false;
    } else {
      libraryTitle.textContent = "图床库管理";
      libraryModeTag.textContent = "批量上传 · 重复选用 · 清理";
      libTabs.hidden = true;
    }
    setLibraryTab(libraryState.mode === "pick" && tab === "online" ? "online" : "local");
    openModal(libraryModal);
    loadLibrary();
  }

  function loadLibrary() {
    libraryState.loading = true;
    renderLibrary();
    return fetch("/api/library")
      .then(function (res) {
        if (res.status === 401) { location.replace("/login.html"); throw { unauth: true }; }
        return res.json();
      })
      .then(function (data) {
        libraryState.loading = false;
        if (!data || !data.ok) {
          libraryState.images = [];
          libEmpty.hidden = false;
          libEmpty.textContent = "图床库读取失败：" + ((data && data.error) || "未知错误");
          return;
        }
        libraryState.images = data.images || [];
        libraryState.presets = data.presets || [];
        libraryState.dir = data.dir || "";
        renderLibrary();
        renderOnlineIcons();
      })
      .catch(function (err) {
        libraryState.loading = false;
        if (err && err.unauth) return;
        libraryState.images = [];
        libEmpty.hidden = false;
        libEmpty.textContent = "图床库读取失败：" + ((err && err.message) || "网络错误");
        renderLibrary();
      });
  }

  /* ---------- 图床库列表渲染 ---------- */
  function renderLibrary() {
    var manage = libraryState.mode === "manage";
    var q = libraryState.query.trim().toLowerCase();
    var images = libraryState.images.filter(function (im) {
      return !q || im.name.toLowerCase().indexOf(q) >= 0;
    });
    var picked = Object.keys(libraryState.selected).filter(function (k) { return libraryState.selected[k]; });
    var allPicked = images.length > 0 && images.every(function (im) { return libraryState.selected[im.name]; });

    libCount.textContent = libraryState.images.length
      ? ("共 " + libraryState.images.length + " 张" + (q ? " · 匹配 " + images.length + " 张" : ""))
      : "";
    libSelectAllBtn.hidden = !manage || images.length === 0;
    libSelectAllBtn.textContent = allPicked ? "取消全选" : "全选";
    libDeleteBtn.hidden = !manage;
    libDeleteBtn.disabled = picked.length === 0;
    libDeleteBtn.textContent = picked.length ? ("删除选中（" + picked.length + "）") : "删除选中";

    if (!images.length) {
      libGrid.innerHTML = "";
      libEmpty.hidden = false;
      if (libraryState.loading) libEmpty.textContent = "正在读取图床库…";
      else if (q) libEmpty.textContent = "没有匹配「" + libraryState.query + "」的图标";
      else libEmpty.textContent = "图床库还是空的。点上方「批量选择图片」一次上传多张图标，之后所有卡片都能重复选用。";
      return;
    }
    libEmpty.hidden = true;

    var html = "";
    images.forEach(function (im) {
      var cls = "lib-cell";
      if (!manage && logoInput.value === im.url) cls += " is-picked";
      var tip = im.name + " · " + Math.max(1, Math.round(im.size / 1024)) + "KB"
        + (im.used ? " · 使用中：" + im.usedBy.join("、") : "");
      html += '<div class="' + cls + '" data-name="' + escapeAttr(im.name) + '" data-url="' + escapeAttr(im.url) + '" title="' + escapeAttr(tip) + '">';
      if (manage) {
        html += '<input type="checkbox" class="lib-cell-check" data-check="' + escapeAttr(im.name) + '"'
          + (libraryState.selected[im.name] ? " checked" : "") + ' aria-label="选择 ' + escapeAttr(im.name) + '">';
        html += '<button type="button" class="lib-cell-del" data-del="' + escapeAttr(im.name) + '" title="删除这张图标">×</button>';
      }
      html += '<span class="lib-cell-thumb">'
        + '<img src="' + escapeAttr(im.url) + '" alt="" loading="lazy" '
        + 'onerror="NaviApp.iconFallback(this,\'' + escapeAttr((im.name || "?").charAt(0).toUpperCase()) + '\')">'
        + "</span>"
        + '<span class="lib-cell-name">' + escapeHtml(im.name) + "</span>";
      if (im.used) html += '<span class="lib-cell-used">使用中 ' + im.usedBy.length + "</span>";
      html += "</div>";
    });
    libGrid.innerHTML = html;
  }

  /* ---------- 在线图标库渲染（内置推荐 + Iconify 搜索） ---------- */
  function renderOnlineIcons() {
    var results = libraryState.onlineResults;
    var items = (results && results.length) ? results : libraryState.presets;
    var cur = (itemForm.icon.value || "").trim();

    if (libraryState.onlineError) {
      iconOnlineHint.textContent = libraryState.onlineError;
    } else if (results) {
      iconOnlineHint.textContent = results.length
        ? ("找到 " + results.length + " 个图标（内置图标库优先，联网时追加 Iconify 结果），点选即写入「在线图标」")
        : "没找到匹配图标，换个关键词试试（如 github / nas / docker / 影音 / 淘宝）";
    } else {
      iconOnlineHint.textContent = "「推荐」是内置本地图标库（200+，含国内站点），断网也能用；搜索会先查本地，再补充 Iconify 在线结果。";
    }

    if (!items.length) {
      iconGrid.innerHTML = "";
      iconEmpty.hidden = false;
      iconEmpty.textContent = "暂无可选图标";
      return;
    }
    iconEmpty.hidden = true;

    var html = "";
    items.forEach(function (it) {
      var icon = it.icon || "";
      var url = icon ? resolveIcon(icon, it.name) : null;
      var sub = it.desc || "";
      var letter = escapeAttr((it.name || "?").charAt(0).toUpperCase());
      html += '<div class="lib-cell' + (cur && cur === icon ? " is-picked" : "") + '" data-icon="' + escapeAttr(icon)
        + '" title="' + escapeAttr(it.name + (sub ? " · " + sub : "") + (icon ? "（" + icon + "）" : "")) + '">';
      html += '<span class="lib-cell-thumb">';
      html += url
        ? '<img src="' + escapeAttr(url) + '" alt="" loading="lazy" onerror="NaviApp.iconFallback(this,\'' + letter + '\')">'
        : '<span class="icon-fallback">' + escapeHtml(letter) + "</span>";
      html += "</span>";
      html += '<span class="lib-cell-name">' + escapeHtml(it.name) + "</span>";
      html += "</div>";
    });
    iconGrid.innerHTML = html;
  }

  /* 搜索：先查本地内置库，再（联网时）追加 Iconify 结果。
     合并而非替换的原因：局域网/断网时 Iconify 一定失败，如果直接回退成「内置推荐」，
     用户输的关键词就等于白输了。本地命中排前面 —— 它们离线也能显示，是更可靠的选择。 */
  function searchOnlineIcons() {
    var q = iconSearch.value.trim();
    libraryState.onlineError = "";
    if (!q) {
      libraryState.onlineResults = null;
      renderOnlineIcons();
      return;
    }

    var ql = q.toLowerCase();
    var localHits = (libraryState.presets || []).filter(function (it) {
      return (it.name || "").toLowerCase().indexOf(ql) !== -1
        || (it.icon || "").toLowerCase().indexOf(ql) !== -1
        || (it.desc || "").toLowerCase().indexOf(ql) !== -1;
    });

    iconSearchBtn.disabled = true;
    iconOnlineHint.textContent = "正在搜索「" + q + "」（先本地，再联网）…";
    iconGrid.innerHTML = "";
    iconEmpty.hidden = true;
    fetch("https://api.iconify.design/search?limit=60&query=" + encodeURIComponent(q))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var icons = (data && data.icons) || [];
        var online = icons.map(function (full) {
          var parts = String(full).split(":");
          return { name: parts[1] || parts[0], icon: "iconify:" + full, desc: parts[0] };
        });
        libraryState.onlineResults = localHits.concat(online);
      })
      .catch(function () {
        // 离线 / 跨域被拦截时不留空白：本地库的结果照常给出
        libraryState.onlineError = localHits.length
          ? "在线搜索失败（离线或网络受限）；下面 " + localHits.length + " 个来自内置图标库"
          : "在线搜索失败（可能离线或网络受限），内置图标库里也没有匹配项";
        libraryState.onlineResults = localHits.length ? localHits : null;
      })
      .then(function () {
        iconSearchBtn.disabled = false;
        renderOnlineIcons();
      });
  }

  /* ---------- 选用 / 删除 ---------- */
  function applyLibraryPick(url) {
    setLogoValue(url);
    setLogoStatus("已选用图床库图标：" + url, "ok");
    closeModal(libraryModal);
  }

  function applyOnlinePick(icon) {
    if (!icon) return;
    itemForm.icon.value = icon;
    refreshIconPreview();
    var extra = logoInput.value
      ? "；本卡片已设本地 Logo（优先级更高），如需改用在线图标请先点「清除」"
      : "";
    setLogoStatus("已选用在线图标：" + icon + extra, "ok");
    closeModal(libraryModal);
  }

  function postLibraryDelete(name, force) {
    return fetch("/api/library/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, force: !!force })
    }).then(function (res) {
      if (res.status === 401) { location.replace("/login.html"); throw { unauth: true }; }
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function showDeleteResult(removed, kept) {
    libResult.hidden = false;
    libResult.className = "lib-result" + (kept ? " err" : " ok");
    libResult.textContent = "删除完成：" + removed + " 张"
      + (kept ? "，保留 " + kept + " 张（仍被卡片引用，已取消删除）" : "");
  }

  // 删除图床库图片。默认不带 force：服务端会拦住「仍被卡片引用」的图片并返回引用清单，
  // 此时再向用户二次确认；确认后才强制删除。避免一次误点让线上卡片集体变回字母图标。
  function removeLibraryImages(names) {
    if (!names.length) return Promise.resolve();
    libResult.hidden = false;
    libResult.className = "lib-result";
    libResult.textContent = "正在删除 " + names.length + " 张…";
    var removed = 0;
    var blocked = [];
    var chain = Promise.resolve();
    names.forEach(function (name) {
      chain = chain.then(function () {
        return postLibraryDelete(name, false).then(function (r) {
          if (r.status === 200) removed++;
          else if (r.status === 409) blocked.push({ name: name, usedBy: (r.data && r.data.usedBy) || [] });
        }).catch(function () {});
      });
    });
    return chain.then(function () {
      libraryState.selected = {};
      if (!blocked.length) {
        showDeleteResult(removed, 0);
        return loadLibrary();
      }
      var detail = blocked.map(function (b) {
        return "· " + b.name + " —— 被「" + b.usedBy.join("、") + "」使用";
      }).join("\n");
      var go = window.confirm("以下 " + blocked.length + " 张图标仍被导航卡片使用：\n\n" + detail
        + "\n\n仍要删除吗？删除后这些卡片会回退为字母图标（可在卡片编辑里重新选图标）。");
      if (!go) {
        showDeleteResult(removed, blocked.length);
        return loadLibrary();
      }
      var chain2 = Promise.resolve();
      blocked.forEach(function (b) {
        chain2 = chain2.then(function () {
          return postLibraryDelete(b.name, true).then(function (r) {
            if (r.status === 200) removed++;
          }).catch(function () {});
        });
      });
      return chain2.then(function () {
        showDeleteResult(removed, 0);
        return loadLibrary();
      });
    });
  }

  function startLibraryUpload(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    libResult.hidden = true;
    libProgress.hidden = false;
    libProgressFill.style.width = "0%";
    libProgressText.textContent = "准备上传 " + files.length + " 张…";
    libDrop.classList.add("is-busy");

    uploadFilesToLibrary(files, function (d0, total) {
      libProgressFill.style.width = (total ? Math.round((d0 / total) * 100) : 0) + "%";
      libProgressText.textContent = "已处理 " + d0 + " / " + total + " 张";
    }).then(function (sum) {
      libDrop.classList.remove("is-busy");
      libProgressFill.style.width = "100%";
      libProgressText.textContent = "已处理 " + (sum.success + sum.failed) + " / " + files.length + " 张";
      if (sum.unauth) return;
      libResult.hidden = false;
      libResult.className = "lib-result" + (sum.failed ? (sum.success ? "" : " err") : " ok");
      libResult.textContent = "上传完成：成功 " + sum.success + " 张，失败 " + sum.failed + " 张"
        + (sum.failures.length ? "\n" + sum.failures.join("\n") : "");
      setTimeout(function () { libProgress.hidden = true; }, 1200);
      return loadLibrary();
    });
  }

  /* ---------- 图床库事件绑定 ---------- */
  libraryBtn.addEventListener("click", function () { openLibrary("manage"); });
  logoLibraryBtn.addEventListener("click", function () { openLibrary("pick", "local"); });
  iconGalleryBtn.addEventListener("click", function () { openLibrary("pick", "online"); });

  libRefreshBtn.addEventListener("click", function () {
    libResult.hidden = true;
    loadLibrary();
  });

  libSearch.addEventListener("input", function () {
    libraryState.query = libSearch.value;
    renderLibrary();
  });

  libSelectAllBtn.addEventListener("click", function () {
    var q = libraryState.query.trim().toLowerCase();
    var visible = libraryState.images.filter(function (im) { return !q || im.name.toLowerCase().indexOf(q) >= 0; });
    var allPicked = visible.length > 0 && visible.every(function (im) { return libraryState.selected[im.name]; });
    visible.forEach(function (im) {
      if (allPicked) delete libraryState.selected[im.name];
      else libraryState.selected[im.name] = true;
    });
    renderLibrary();
  });

  libDeleteBtn.addEventListener("click", function () {
    var names = Object.keys(libraryState.selected).filter(function (k) { return libraryState.selected[k]; });
    if (names.length) removeLibraryImages(names);
  });

  libGrid.addEventListener("change", function (e) {
    var cb = e.target.closest && e.target.closest(".lib-cell-check");
    if (!cb) return;
    var name = cb.getAttribute("data-check");
    if (cb.checked) libraryState.selected[name] = true;
    else delete libraryState.selected[name];
    renderLibrary();
  });

  libGrid.addEventListener("click", function (e) {
    var delBtn = e.target.closest && e.target.closest("[data-del]");
    if (delBtn) {
      e.stopPropagation();
      removeLibraryImages([delBtn.getAttribute("data-del")]);
      return;
    }
    if (e.target.closest && e.target.closest(".lib-cell-check")) return;  // 交给 change 事件
    var cell = e.target.closest && e.target.closest(".lib-cell");
    if (!cell) return;

    if (libraryState.mode === "pick") {
      applyLibraryPick(cell.getAttribute("data-url"));
      return;
    }
    var name = cell.getAttribute("data-name");
    if (libraryState.selected[name]) delete libraryState.selected[name];
    else libraryState.selected[name] = true;
    renderLibrary();
  });

  libUploadBtn.addEventListener("click", function () {
    libFile.value = "";
    libFile.click();
  });

  libFile.addEventListener("change", function () {
    startLibraryUpload(libFile.files);
    libFile.value = "";
  });

  ["dragenter", "dragover"].forEach(function (ev) {
    libDrop.addEventListener(ev, function (e) {
      e.preventDefault();
      libDrop.classList.add("is-over");
    });
  });
  ["dragleave", "dragend"].forEach(function (ev) {
    libDrop.addEventListener(ev, function () { libDrop.classList.remove("is-over"); });
  });
  libDrop.addEventListener("drop", function (e) {
    e.preventDefault();
    libDrop.classList.remove("is-over");
    var dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) startLibraryUpload(dt.files);
  });

  libTabs.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".lib-tab");
    if (btn) setLibraryTab(btn.getAttribute("data-tab"));
  });

  iconSearchBtn.addEventListener("click", searchOnlineIcons);
  iconSearch.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      searchOnlineIcons();
    }
  });

  iconGrid.addEventListener("click", function (e) {
    var cell = e.target.closest && e.target.closest(".lib-cell");
    if (cell) applyOnlinePick(cell.getAttribute("data-icon"));
  });

  itemForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var gi = editingItem.gi;
    var item = {
      title: itemForm.title.value.trim(),
      desc: itemForm.desc.value.trim(),
      url: itemForm.url.value.trim(),
      lanUrl: itemForm.lanUrl.value.trim(),
      icon: itemForm.icon.value.trim()
    };
    if (!item.desc) delete item.desc;
    if (!item.lanUrl) delete item.lanUrl;
    if (!item.icon) delete item.icon;
    // 内外网策略：只在显式指定时落库，"auto" 不写入（保持配置文件干净、与旧格式兼容）
    var nm = itemForm.netMode ? itemForm.netMode.value : "auto";
    if (nm === "lan" || nm === "wan") item.netMode = nm;
    if (logoInput.value) item.logo = logoInput.value;

    // 编辑已有卡片时保留表单不管理的字段（如服务发现的来源追踪 source、失效标记 stale），
    // 否则「点开看一眼再保存」会把这类元数据悄悄抹掉。
    if (editingItem.ii >= 0) {
      var prev = state.draft.groups[gi].items[editingItem.ii] || {};
      if (prev.source !== undefined && item.source === undefined) item.source = prev.source;
      if (prev.stale !== undefined && item.stale === undefined) item.stale = prev.stale;
      if (prev.staleAt !== undefined && item.staleAt === undefined) item.staleAt = prev.staleAt;
    } else {
      // 手工新建的卡片显式标为 manual：与发现卡片区分开 —— 手工卡片永不参与
      // 「源侧消失 → 失效」的判定（否则用户自己填的链接会被扫描结果牵连）。
      item.source = { type: "manual" };
    }

    if (editingItem.ii >= 0) {
      state.draft.groups[gi].items[editingItem.ii] = item;
    } else {
      state.draft.groups[gi].items.push(item);
    }
    closeModal(itemModal);
    markDirty();
    render();
  });

  function openGroupModal(gi) {
    editingGroup = gi;
    groupForm.reset();
    if (gi >= 0) {
      groupForm.name.value = state.draft.groups[gi].name;
      groupModalTitle.textContent = "重命名分组";
    } else {
      groupModalTitle.textContent = "添加分组";
    }
    openModal(groupModal);
    groupForm.name.focus();
  }

  groupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = groupForm.name.value.trim();
    if (!name) return;
    if (editingGroup >= 0) {
      state.draft.groups[editingGroup].name = name;
    } else {
      state.draft.groups.push({ name: name, items: [] });
    }
    closeModal(groupModal);
    markDirty();
    render();
  });

  addGroupBtn.addEventListener("click", function () { openGroupModal(-1); });

  /* ---------- 卡片 / 分组操作（事件委托） ---------- */
  navRoot.addEventListener("click", function (e) {
    if (!state.editMode) return;

    // 编辑模式下点击卡片不跳转
    var card = e.target.closest(".card");
    if (card) e.preventDefault();

    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");

    if (act === "add-item") {
      openItemModal(+btn.getAttribute("data-gi"), -1);
    } else if (act === "rename-group") {
      openGroupModal(+btn.getAttribute("data-gi"));
    } else if (act === "del-group") {
      var gi = +btn.getAttribute("data-gi");
      var g = state.draft.groups[gi];
      if (confirm("删除分组「" + g.name + "」及其下 " + g.items.length + " 个导航项？")) {
        state.draft.groups.splice(gi, 1);
        markDirty();
        render();
      }
    } else if (act === "edit-item" && card) {
      openItemModal(+card.getAttribute("data-gi"), +card.getAttribute("data-ii"));
    } else if (act === "del-item" && card) {
      var cgi = +card.getAttribute("data-gi");
      var cii = +card.getAttribute("data-ii");
      var it = state.draft.groups[cgi].items[cii];
      if (confirm("删除导航项「" + it.title + "」？")) {
        state.draft.groups[cgi].items.splice(cii, 1);
        markDirty();
        render();
      }
    }
  });

  /* ---------- 拖拽排序（支持跨分组） ---------- */
  var dragEl = null;

  navRoot.addEventListener("dragstart", function (e) {
    if (!state.editMode) { e.preventDefault(); return; }
    var card = e.target.closest(".card");
    if (!card) { e.preventDefault(); return; }
    dragEl = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
  });

  navRoot.addEventListener("dragover", function (e) {
    if (!state.editMode || !dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    var over = e.target.closest(".card");
    if (over && over !== dragEl) {
      var r = over.getBoundingClientRect();
      var midY = r.top + r.height / 2;
      var sameRow = Math.abs(e.clientY - midY) < r.height / 2;
      var before = sameRow ? (e.clientX < r.left + r.width / 2) : (e.clientY < midY);
      over.parentNode.insertBefore(dragEl, before ? over : over.nextSibling);
    } else {
      var grid = e.target.closest(".card-grid");
      if (grid && !over) grid.appendChild(dragEl); // 拖到空白处放入该分组末尾
    }
  });

  navRoot.addEventListener("dragend", function () {
    if (!dragEl) return;
    dragEl.classList.remove("dragging");
    dragEl = null;
    // 按 DOM 顺序回写 draft
    var draft = state.draft;
    var newGroups = [];
    navRoot.querySelectorAll(".group").forEach(function (sec) {
      var name = sec.getAttribute("data-name");
      var items = [];
      sec.querySelectorAll(".card").forEach(function (c) {
        var gi = +c.getAttribute("data-gi");
        var ii = +c.getAttribute("data-ii");
        items.push(draft.groups[gi].items[ii]);
      });
      newGroups.push({ name: name, items: items });
    });
    // 搜索过滤时被隐藏的卡片不在 DOM 中，把它们补回各自原分组
    if (state.keyword.trim()) {
      var placed = {};
      newGroups.forEach(function (g) {
        g.items.forEach(function (it) { placed[it.title + "|" + it.url] = true; });
      });
      draft.groups.forEach(function (g, gi) {
        g.items.forEach(function (it) {
          if (!placed[it.title + "|" + it.url]) {
            var target = newGroups.filter(function (ng) { return ng.name === g.name; })[0];
            if (target) target.items.push(it);
          }
        });
      });
    }
    state.draft.groups = newGroups;
    markDirty();
    render();
  });

  /* ---------- 从外部拖入链接建卡（仅编辑模式） ----------
     把浏览器地址栏 / 书签 / 聊天窗口里的链接直接拖到页面上，预填「添加导航项」弹窗。
     与本页的卡片拖拽排序互不干扰：排序进行中 dragEl 非空，这里一律放行不处理。
     解析成链接才弹窗；拖进来一段普通文字不打扰用户。 */
  function externalDragHasLink(e) {
    if (!e.dataTransfer) return false;
    var types = Array.prototype.slice.call(e.dataTransfer.types || []);
    return types.indexOf("text/uri-list") >= 0 || types.indexOf("text/plain") >= 0;
  }

  // 浏览器给的形态不统一：Chrome 常见 "标题\r\nhttps://…"，Firefox 还是单行 uri-list。
  // 所以「URL 取第一个含链接的行、标题优先取同行的剩余文本，其次取不含链接的那一行」。
  function parseDroppedLink(text) {
    if (!text) return null;
    var lines = String(text).split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.charAt(0) !== "#"; });   // uri-list 用 # 作注释
    var url = "", title = "";
    lines.forEach(function (line) {
      var m = line.match(/https?:\/\/\S+/i);
      if (m && !url) {
        url = m[0];
        // 只在还没有标题时，才用「URL 同一行的剩余文字」当标题
        // （否则会把上一行已提取的标题覆盖成空 —— 典型的「标题在上」形态）
        var rest = line.replace(m[0], "").trim();
        if (!title && rest) title = rest;
      } else if (!title && !/https?:\/\//i.test(line)) {
        title = line;
      }
    });
    if (!url) return null;
    return { url: url, title: title.slice(0, 40) };
  }

  function openItemModalForNew(url, title) {
    if (!state.draft) return;
    if (!Array.isArray(state.draft.groups) || !state.draft.groups.length) {
      state.draft.groups = [{ name: "默认分组", items: [] }];
      markDirty();
      render();
    }
    openItemModal(0, -1);
    itemForm.url.value = url || "";
    if (title) {
      itemForm.title.value = title;
    } else {
      try { itemForm.title.value = new URL(url).hostname; } catch (e) {}
    }
    itemForm.title.focus();
  }

  navRoot.addEventListener("dragover", function (e) {
    if (!state.editMode || dragEl) return;          // 排序中的拖拽交给上面的处理器
    if (!externalDragHasLink(e)) return;
    e.preventDefault();                             // 不 preventDefault 就不会触发 drop
    e.dataTransfer.dropEffect = "copy";
  });

  navRoot.addEventListener("drop", function (e) {
    if (!state.editMode || dragEl) return;
    if (!externalDragHasLink(e)) return;
    var uri = "", plain = "";
    try { uri = e.dataTransfer.getData("text/uri-list") || ""; } catch (err) {}
    try { plain = e.dataTransfer.getData("text/plain") || ""; } catch (err) {}
    // uri-list 常常只有裸 URL，标题其实在 text/plain 里 → 优先取「带标题」的那个
    var fromUri = parseDroppedLink(uri), fromPlain = parseDroppedLink(plain);
    var picked = (fromUri && fromUri.title) ? fromUri
              : (fromPlain && fromPlain.title) ? fromPlain
              : (fromUri || fromPlain);
    if (!picked) return;                            // 不是链接 → 什么都不做
    e.preventDefault();
    openItemModalForNew(picked.url, picked.title);
  });

  /* ---------- 站点信息 ---------- */
  function applySiteInfo(site) {
    if (!site) return;
    if (site.title) {
      document.getElementById("siteTitle").textContent = site.title;
      document.title = site.title + " · 个人导航站";
    }
    if (site.subtitle) document.getElementById("siteSubtitle").textContent = site.subtitle;
    if (site.footer) document.getElementById("footerText").textContent = site.footer;
  }

  /* ---------- 认证状态与退出登录 ---------- */
  var logoutBtn = document.getElementById("logoutBtn");
  fetch("/api/auth/status", { cache: "no-cache" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (s) {
      if (s && s.authEnabled) logoutBtn.hidden = false; // 仅在启用密码保护时显示退出入口
    })
    .catch(function () {}); // 纯静态托管时静默忽略

  logoutBtn.addEventListener("click", function () {
    fetch("/api/logout", { method: "POST" })
      .finally(function () { location.replace("/login.html"); });
  });

  /* ============================================================
     服务发现（Docker 容器 / 本机监听端口 → 自动匹配图标 → 生成卡片）
     ------------------------------------------------------------
     设计原则：本功能只把识别结果「加入当前编辑草稿」，落盘仍走既有的
     「保存」流程。因此不会绕过既有校验，也不会破坏既有数据与交互。
     ============================================================ */
  var discoverBtn = document.getElementById("discoverBtn");
  var discoverModal = document.getElementById("discoverModal");
  var discoverSrc = document.getElementById("discoverSrc");
  var discoverHint = document.getElementById("discoverHint");
  var discoverToolbar = document.getElementById("discoverToolbar");
  var discoverAll = document.getElementById("discoverAll");
  var discoverCount = document.getElementById("discoverCount");
  var discoverRescan = document.getElementById("discoverRescan");
  var discoverList = document.getElementById("discoverList");
  var discoverEmpty = document.getElementById("discoverEmpty");
  var discoverAddBtn = document.getElementById("discoverAddBtn");
  // P1-7：失效项提示条（源侧已消失的发现卡片 —— 只标记、不自动删除）
  var staleBar = document.getElementById("staleBar");
  var staleBarText = document.getElementById("staleBarText");
  var staleRestoreBtn = document.getElementById("staleRestoreBtn");
  var staleCleanBtn = document.getElementById("staleCleanBtn");

  var discoverItems = [];   // 当前扫描结果（含用户就地编辑后的值）
  var discoverMeta = null;  // 后端返回的来源 / 能力信息
  var discoverStale = null; // 后端返回的失效判定结果（{items,count,marked,checked,skipped}）
  var DISCOVER_GROUP = "Docker 服务";   // 灰区默认归入的分组名

  // 发现设置挂在草稿配置上（随既有保存流程一起落盘，无需新增接口）
  function discoverySettings() {
    if (!state.draft) return { ignored: [] };
    if (!state.draft.discovery || typeof state.draft.discovery !== "object") {
      state.draft.discovery = { ignored: [] };
    }
    if (!Array.isArray(state.draft.discovery.ignored)) state.draft.discovery.ignored = [];
    return state.draft.discovery;
  }

  function findDiscoverItem(id) {
    for (var i = 0; i < discoverItems.length; i++) {
      if (discoverItems[i].id === id) return discoverItems[i];
    }
    return null;
  }

  /* ---------- P1-7：失效卡片（只标记、不删除） ----------
     判定在后端（`discovery.computeStale`）：只有 source.type === "discover" 的卡片
     参与，且**来源本次必须真的接入了**才判 —— Docker 没挂载时扫描结果天然为空，
     不加这个前提就会把所有发现卡片一次性冤枉成「已失效」。
     前端这里只做三件事：把标记写进草稿、显示提示条、提供恢复/清理两个显式动作。 */
  function collectStaleCards() {
    var out = [];
    if (!state.draft || !Array.isArray(state.draft.groups)) return out;
    state.draft.groups.forEach(function (g, gi) {
      (g.items || []).forEach(function (it, ii) {
        if (it && it.stale === true) out.push({ gi: gi, ii: ii, item: it });
      });
    });
    return out;
  }

  // 用 source.id + source.via 匹配（不用下标：用户可能刚改过草稿，下标会漂）
  function applyStaleMarks(info) {
    if (!info || !Array.isArray(info.items) ||
        !state.draft || !Array.isArray(state.draft.groups)) return 0;
    var now = new Date().toISOString();
    var changed = 0;
    info.items.forEach(function (s) {
      state.draft.groups.forEach(function (g) {
        (g.items || []).forEach(function (it) {
          var src = it && it.source;
          if (!src || typeof src !== "object" || src.type !== "discover") return;
          if (String(src.id || "") !== String(s.id || "")) return;
          if (String(src.via || "") !== String(s.via || "")) return;
          if (it.stale === true) return;
          it.stale = true;
          it.staleAt = now;
          changed++;
        });
      });
    });
    return changed;
  }

  function renderStaleBar() {
    if (!staleBar) return;
    var cards = collectStaleCards();
    var info = discoverStale || {};
    if (!cards.length) {
      staleBar.hidden = true;
      staleBarText.textContent = "";
      return;
    }
    // 来源 id → 可读文案（提示条是给用户看的，不该直接吐 "docker"/"local" 这种内部值）
    function viaLabel(v) {
      return v === "docker" ? "Docker 容器" : (v === "local" ? "本机端口" : v);
    }
    staleBar.hidden = false;
    var txt = "有 " + cards.length + " 张卡片已从源侧消失，可能已失效（已标记，未删除）。";
    var checked = (info.checked || []).map(viaLabel);
    if (checked.length) txt += "本次判定来源：" + checked.join(" / ") + "。";
    var skipped = (info.skipped || []).map(viaLabel);
    if (skipped.length) {
      txt += " ⚠ " + skipped.join(" / ") + " 本次未接入，来自它的卡片未做失效判定（未接入 ≠ 失效）。";
    }
    staleBarText.textContent = txt;
  }

  // 来源摘要，如「Docker ×12 · 本机端口 ×3」
  function discoverSourceText() {
    if (!discoverMeta) return "";
    var s = discoverMeta.sources || {};
    var parts = [];
    if (s.docker && s.docker.available) parts.push("Docker ×" + s.docker.count);
    if (s.local && s.local.available) parts.push("本机端口 ×" + s.local.count);
    return parts.length ? parts.join(" · ") : "未接入";
  }

  // 单项状态文案
  function discoverTag(it) {
    if (it.added) return "已在导航中";
    if (it.ignored) return "已忽略";
    var src = it.source === "docker" ? "容器" : "本机";
    var st = it.running ? "运行中" : "已停止";
    if (it.infra) return src + " · " + st + " · 依赖容器";
    return src + " · " + st + " · " + (it.image || it.container || ("端口 " + it.port));
  }

  function discoverRowHtml(it) {
    var iconUrl = it.icon ? resolveIcon(it.icon, it.title) : null;
    var cls = "discover-row" + (it.added ? " is-added" : "") + (it.ignored ? " is-ignored" : "");
    var dis = (it.added || it.ignored) ? " disabled" : "";
    var letter = escapeAttr((it.title || "?").charAt(0));

    var h = '<div class="' + cls + '" data-id="' + escapeAttr(it.id) + '">';
    h += '<label class="discover-pick"><input type="checkbox" data-k="sel"' +
         (it.selected ? " checked" : "") + dis + ' aria-label="选择加入"></label>';

    h += '<span class="discover-icon">';
    if (iconUrl) {
      h += '<img src="' + escapeAttr(iconUrl) + '" alt="" loading="lazy" ' +
           'onerror="NaviApp.iconFallback(this,\'' + letter + '\')">';
    } else {
      h += '<span class="icon-fallback">' + escapeHtml((it.title || "?").charAt(0)) + "</span>";
    }
    h += "</span>";

    h += '<div class="discover-fields">';
    h += '<input class="discover-in title" data-k="title" maxlength="40" placeholder="名称" value="' +
         escapeAttr(it.title || "") + '">';
    h += '<input class="discover-in" data-k="desc" maxlength="60" placeholder="描述（可留空）" value="' +
         escapeAttr(it.desc || "") + '">';
    h += '<div class="row2">';
    h += '<input class="discover-in url" data-k="lanUrl" placeholder="内网地址" value="' +
         escapeAttr(it.lanUrl || "") + '">';
    h += '<input class="discover-in url" data-k="url" placeholder="外网地址" value="' +
         escapeAttr(it.url || "") + '">';
    h += "</div></div>";

    h += '<div class="discover-meta">';
    h += '<span class="discover-port">:' + escapeHtml(it.port) +
         (it.extraPorts && it.extraPorts.length ? " +" + it.extraPorts.length : "") + "</span>";
    h += '<span class="discover-tag">' + escapeHtml(discoverTag(it)) + "</span>";
    h += "</div>";

    if (it.added) {
      h += '<span class="mini-btn" aria-hidden="true" title="已在导航中">' +
           '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>';
    } else {
      h += '<button type="button" class="mini-btn' + (it.ignored ? "" : " danger") +
           '" data-act="' + (it.ignored ? "unignore" : "ignore") +
           '" title="' + (it.ignored ? "取消忽略" : "忽略此项") + '">' +
           (it.ignored
             ? '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
             : '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>') +
           "</button>";
    }
    h += "</div>";
    return h;
  }

  // 「推荐项」：可加入 && 运行中 && 非依赖容器（全选与默认勾选以此为范围，
  //  避免把 mysql/redis 这类依赖容器、以及已停止的容器一起塞进导航）
  function discoverRecommended(it) {
    return !it.ignored && !it.added && it.running && !it.infra;
  }

  function renderDiscovery() {
    var joinable = discoverItems.filter(function (it) { return !it.ignored && !it.added; });
    var recommended = discoverItems.filter(discoverRecommended);
    var picked = joinable.filter(function (it) { return it.selected; });

    discoverAll.checked = recommended.length > 0 && recommended.every(function (it) {
      return it.selected;
    });
    discoverCount.textContent = joinable.length
      ? ("可加入 " + joinable.length + " 项 · 已选 " + picked.length + " 项")
      : "没有可加入的新服务";
    discoverAddBtn.disabled = picked.length === 0;
    discoverAddBtn.textContent = picked.length ? ("加入选中项（" + picked.length + "）") : "加入选中项";

    if (!discoverItems.length) {
      discoverList.innerHTML = "";
      discoverEmpty.hidden = false;
      discoverEmpty.textContent = "未识别到可访问的服务。请确认 Docker Socket 已挂载，或本机有正在监听的 Web 服务。";
      discoverToolbar.hidden = false;
      renderStaleBar();
      return;
    }

    discoverEmpty.hidden = true;
    discoverToolbar.hidden = false;
    discoverList.innerHTML = discoverItems.map(discoverRowHtml).join("");
    discoverSrc.textContent = discoverSourceText();

    var hint = "已识别 " + discoverItems.length + " 个服务，图标按服务类型自动匹配，可逐项修改后再加入。";
    var warns = (discoverMeta && discoverMeta.warnings) || [];
    if (warns.length) hint += "（" + warns.join("；") + "）";
    discoverHint.className = "discover-hint";
    discoverHint.textContent = hint;
    renderStaleBar();
  }

  function loadDiscovery() {
    discoverHint.className = "discover-hint";
    discoverHint.textContent = "正在扫描容器与本机监听端口…";
    discoverToolbar.hidden = true;
    discoverList.innerHTML = "";
    discoverEmpty.hidden = true;
    discoverSrc.textContent = "";
    discoverAddBtn.disabled = true;

    return fetch("/api/discover", { cache: "no-cache" })
      .then(function (res) {
        if (res.status === 401) {
          location.replace("/login.html");
          throw { unauth: true };
        }
        return res.json().then(function (data) {
          if (!res.ok || !data || !data.ok) {
            throw { serverError: (data && data.error) || ("HTTP " + res.status) };
          }
          return data;
        });
      })
      .then(function (data) {
        discoverMeta = data;
        discoverStale = data.stale || null;
        var ignored = discoverySettings().ignored;
        discoverItems = (data.items || []).map(function (it) {
          // 以草稿中的忽略列表为准，避免保存前被服务端旧值回滚
          it.ignored = ignored.indexOf(it.id) !== -1 || !!it.ignored;
          if (it.ignored) it.selected = false;
          return it;
        });
        // P1-7：把本次「源侧已消失」的发现卡片在草稿上打标记（只标记，不删除）。
        // 落盘仍由既有「保存」流程负责 —— 不新增写接口，也不静默改服务器上的数据。
        var marked = applyStaleMarks(discoverStale);
        if (marked) {
          markDirty();
          render();   // 主网格要立刻出现「可能失效」角标（markDirty 只负责保存条，不重渲染）
          saveBarTip.textContent = "有 " + marked + " 张卡片已从源侧消失（已标记，未删除）—— 点「保存」生效";
        }
        renderDiscovery();
      })
      .catch(function (err) {
        if (err && err.unauth) return;
        discoverHint.className = "discover-hint err";
        discoverHint.textContent = "扫描失败：" + (err && err.serverError
          ? err.serverError
          : "无法连接服务器（" + (err && err.message ? err.message : "网络错误") + "）。纯静态托管模式下不支持服务发现。");
        discoverToolbar.hidden = true;
        discoverList.innerHTML = "";
        discoverEmpty.hidden = false;
        discoverEmpty.textContent = "服务发现依赖后端：请在 Docker 部署环境中使用，并把 /var/run/docker.sock 挂载进容器。";
      });
  }

  /* ---------- 服务发现：交互 ---------- */
  discoverBtn.addEventListener("click", function () {
    if (!state.editMode) return;      // 入口仅存在于编辑模式
    openModal(discoverModal);
    loadDiscovery();
  });

  discoverRescan.addEventListener("click", function () {
    discoverRescan.disabled = true;
    loadDiscovery().finally(function () { discoverRescan.disabled = false; });
  });

  discoverAll.addEventListener("change", function () {
    var v = discoverAll.checked;
    discoverItems.forEach(function (it) {
      if (it.ignored || it.added) return;
      // 全选只覆盖「推荐项」；手动勾选的依赖/已停止容器不被取消，避免误伤
      if (!discoverRecommended(it)) return;
      it.selected = v;
    });
    renderDiscovery();
  });

  // 就地编辑：文本输入不重渲染（避免打断输入），勾选才重算统计
  discoverList.addEventListener("input", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var row = el.closest(".discover-row");
    if (!row) return;
    var it = findDiscoverItem(row.getAttribute("data-id"));
    if (!it) return;
    var key = el.getAttribute("data-k");
    if (!key) return;
    if (key === "sel") {
      it.selected = !!el.checked;
      renderDiscovery();
      return;
    }
    it[key] = el.value;
  });

  // 忽略 / 取消忽略：同步写入草稿的 discovery.ignored
  discoverList.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var row = btn.closest(".discover-row");
    if (!row) return;
    var it = findDiscoverItem(row.getAttribute("data-id"));
    if (!it) return;

    var act = btn.getAttribute("data-act");
    if (act !== "ignore" && act !== "unignore") return;

    it.ignored = act === "ignore";
    // 取消忽略时恢复「默认推荐」状态，而不是一律勾选——
    // 否则已停止 / 依赖容器会在取消忽略后被顺带加入
    it.selected = discoverRecommended(it);

    var s = discoverySettings();
    var idx = s.ignored.indexOf(it.id);
    if (it.ignored && idx < 0) s.ignored.push(it.id);
    if (!it.ignored && idx >= 0) s.ignored.splice(idx, 1);

    markDirty();
    renderDiscovery();
  });

  // 加入选中项：写入当前编辑草稿，落盘由既有「保存」流程负责
  discoverAddBtn.addEventListener("click", function () {
    var picks = discoverItems.filter(function (it) {
      return it.selected && !it.ignored && !it.added;
    });
    if (!picks.length) return;

    var cfg = state.draft;
    if (!cfg || !Array.isArray(cfg.groups)) return;

    var group = null;
    cfg.groups.forEach(function (g) { if (!group && g.name === DISCOVER_GROUP) group = g; });
    if (!group) {
      group = { name: DISCOVER_GROUP, items: [] };
      cfg.groups.push(group);
    }

    var skipped = [];
    var added = 0;
    picks.forEach(function (it) {
      var title = String(it.title || "").trim();
      var url = String(it.url || "").trim();
      // 与后端 validateConfig 同规则：url 必须是 http(s)，名称必填
      if (!title || !/^https?:\/\//i.test(url)) {
        skipped.push(title || it.id);
        return;
      }
      var item = { title: title, url: url };
      var desc = String(it.desc || "").trim();
      var lanUrl = String(it.lanUrl || "").trim();
      if (desc) item.desc = desc;
      if (lanUrl && /^https?:\/\//i.test(lanUrl)) item.lanUrl = lanUrl;
      if (it.icon) item.icon = it.icon;
      // P1-7 来源追踪：记下「从哪来的哪一项」，之后重新扫描时才能判断它是否已从源侧消失。
      // via/id 都取自本次扫描结果；syncedAt 是本次同步时间（只用于展示与排障）。
      item.source = {
        type: "discover",
        via: it.source === "docker" ? "docker" : "local",
        id: String(it.id || ""),
        syncedAt: new Date().toISOString()
      };

      group.items.push(item);
      it.added = true;
      it.selected = false;
      added++;
    });

    markDirty();
    render();
    renderDiscovery();

    if (skipped.length) {
      alert("以下条目因名称或地址不合法被跳过：" + skipped.join("、") +
            "\n请修正后重试（地址需以 http:// 或 https:// 开头）。");
    } else if (added) {
      saveBarTip.textContent = "已加入 " + added + " 个服务，记得点「保存」写入服务器";
    }
  });

  /* ---------- P1-7：失效项的两个显式动作 ---------- */

  // 「恢复全部」：只清掉失效标记，不删任何卡片、不动其它字段
  staleRestoreBtn.addEventListener("click", function () {
    var cards = collectStaleCards();
    if (!cards.length) return;
    cards.forEach(function (c) {
      delete c.item.stale;
      delete c.item.staleAt;
    });
    saveBarTip.textContent = "已恢复 " + cards.length + " 张卡片的失效标记，记得点「保存」写入服务器";
    markDirty();
    render();
    renderDiscovery();
  });

  // 「清理失效项」：真的删除（唯一会动数据的地方，因此必须二次确认）
  staleCleanBtn.addEventListener("click", function () {
    var cards = collectStaleCards();
    if (!cards.length) return;
    if (!window.confirm(
      "确定要删除这 " + cards.length + " 张已标记失效的卡片吗？\n\n" +
      "· 它们来自服务发现，但最近一次扫描已找不到来源；\n" +
      "· 删除后只能靠备份恢复（卡片里的地址、图标都会一并消失）；\n" +
      "· 若只是暂时连不上，请选「取消」并改用「恢复全部」。"
    )) {
      return;
    }
    // 从后往前删，避免删除过程中下标位移
    cards.slice().sort(function (a, b) { return (b.gi - a.gi) || (b.ii - a.ii); })
      .forEach(function (c) { state.draft.groups[c.gi].items.splice(c.ii, 1); });
    saveBarTip.textContent = "已清理 " + cards.length + " 张失效卡片，记得点「保存」写入服务器";
    markDirty();
    render();
    renderDiscovery();
  });

  /* ---------- 启动：加载配置 ---------- */
  function bootstrap(cfg, apiOk) {
    state.config = cfg;
    state.apiAvailable = apiOk;
    state.mode = initMode();

    // 静态托管 + 本地草稿：自动恢复
    if (!apiOk) {
      try {
        var draft = localStorage.getItem(STORAGE_DRAFT_KEY);
        if (draft) {
          state.config = JSON.parse(draft);
          document.getElementById("footerText").textContent =
            (state.config.site && state.config.site.footer ? state.config.site.footer + " · " : "") +
            "（本地草稿模式）";
        }
      } catch (e) {}
    }

    applySiteInfo(state.config.site);
    applyModeUI();
    render();
    // 空配置的新用户：给一个可跳过的三步向导（有卡片 / 无后端 / 跳过过 → 不出现）
    maybeShowFirstRun();
    // 探测在首帧渲染之后才启动：卡片链接在渲染时已用启发式兜底，
    // 所以就算探测要 2 秒，用户此刻点卡片也是通的 —— 探测只负责「越往后越准」。
    startLanProbes();
    // 状态板最后启动：它是最不重要的信息，绝不与首屏渲染抢时间（首屏不依赖它）
    startStatusPolling();
  }

  fetch(API_URL, { cache: "no-cache" })
    .then(function (res) {
      if (res.status === 401) {
        location.replace("/login.html"); // 会话过期 / 未认证 → 回登录页
        throw new Error("unauthorized");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (cfg) { bootstrap(cfg, true); })
    .catch(function () {
      // 无后端（如 python http.server 预览）：降级读静态文件
      fetch(STATIC_CONFIG_URL, { cache: "no-cache" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (cfg) { bootstrap(cfg, false); })
        .catch(function (err) {
          navRoot.innerHTML =
            '<div class="empty-tip">配置加载失败：' + escapeHtml(err.message) +
            "<br>请确认 config.json 存在且格式正确</div>";
        });
    });
})();
