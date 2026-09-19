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

  /* ---------- 在线图标库解析器 ---------- */
  // icon 字段支持四种写法：
  //   1. "https://...png"           直接外链图片
  //   2. "iconify:simple-icons:github"  Iconify 在线图标库（api.iconify.design）
  //   3. "selfhst:portainer"        selfh.st 图标库（cdn.jsdelivr.net/gh/selfhst/icons）
  //   4. "jellyfin"                 Dashboard Icons（cdn.jsdelivr.net/gh/walkxcode/dashboard-icons）
  //   5. 留空                       自动按名称尝试 Dashboard Icons，失败回退字母图标
  function resolveIcon(icon, name) {
    if (icon && /^https?:\/\//i.test(icon)) return icon;
    if (icon && icon.indexOf("iconify:") === 0) {
      var parts = icon.slice(8).split(":");
      if (parts.length === 2) {
        return "https://api.iconify.design/" + parts[0] + "/" + parts[1] + ".svg?color=%237db1ff";
      }
    }
    if (icon && icon.indexOf("selfhst:") === 0) {
      return "https://cdn.jsdelivr.net/gh/selfhst/icons/png/" + icon.slice(8) + ".png";
    }
    var slug = (icon || name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) return null;
    return "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/" + slug + ".png";
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
    mode: "wan",       // "wan" | "lan"
    keyword: "",
    editMode: false,
    dirty: false,
    apiAvailable: true // 后端 API 是否可用（纯静态托管时降级）
  };

  var STORAGE_MODE_KEY = "navi-net-mode";
  var STORAGE_DRAFT_KEY = "navi-offline-draft";
  var STORAGE_THEME_KEY = "navi-theme"; // "light" | "dark"

  function initMode() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_MODE_KEY); } catch (e) {}
    if (saved === "lan" || saved === "wan") return saved;
    return isLanHost(location.hostname) ? "lan" : "wan";
  }

  function activeConfig() {
    return state.editMode ? state.draft : state.config;
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- DOM 引用 ---------- */
  var navRoot = document.getElementById("navRoot");
  var emptyTip = document.getElementById("emptyTip");
  var searchInput = document.getElementById("searchInput");
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
  function pickUrl(item) {
    if (state.mode === "lan" && item.lanUrl) return item.lanUrl;
    return item.url;
  }

  function itemMatches(item, kw) {
    if (!kw) return true;
    var hay = [item.title, item.desc, item.url, item.lanUrl]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(kw) !== -1;
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

        html += '<a class="card" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer"' +
                ' data-gi="' + gi + '" data-ii="' + ii + '"' +
                ' data-has-lan="' + (!!item.lanUrl) + '"' +
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
        html += "</span>";
        html += '<span class="lan-flag">LAN</span>';

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
    }
  };

  /* ---------- 内外网切换 ---------- */
  function applyModeUI() {
    var isLan = state.mode === "lan";
    netToggle.classList.toggle("lan", isLan);
    netToggle.setAttribute("aria-pressed", String(isLan));
    netLabel.textContent = isLan ? "内网" : "外网";
    netBadge.classList.toggle("lan", isLan);
    netBadgeText.textContent = isLan ? "内网模式" : "外网模式";
    document.body.classList.toggle("lan-mode", isLan);
  }

  netToggle.addEventListener("click", function () {
    state.mode = state.mode === "lan" ? "wan" : "lan";
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
  searchInput.addEventListener("input", function () {
    state.keyword = searchInput.value;
    render();
  });
  document.addEventListener("keydown", function (e) {
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
  // 导出：优先走后端结构化备份接口（含校验和，可完整还原）；无后端时降级为纯 config 导出
  backupBtn.addEventListener("click", function () {
    if (state.apiAvailable) {
      // 直接用浏览器导航下载，后端已附带 Content-Disposition 附件头
      window.location.href = "/api/backup";
      return;
    }
    // 纯静态托管：本地草稿降级导出
    var data = state.draft || state.config;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  importBtn.addEventListener("click", function () {
    importFile.value = "";
    importFile.click();
  });

  importFile.addEventListener("change", function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var body;
      try {
        body = JSON.parse(String(reader.result));
      } catch (e) {
        alert("导入失败：文件不是合法的 JSON 数据。");
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
        if (!confirm("即将用备份文件覆盖当前全部数据（共 " + count + " 个导航项）。\n此操作不可撤销，是否继续？")) {
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
        fetch("/api/backup/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function (res) {
            return res.json().then(function (data) {
              if (res.status === 401) {
                location.replace("/login.html");
                throw { unauth: true };
              }
              if (!res.ok || !data || !data.ok) {
                throw { serverError: (data && data.error) || ("HTTP " + res.status) };
              }
              return data;
            });
          })
          .then(function () {
            // 恢复成功：重新加载，与服务器当前状态保持一致
            alert("恢复成功，即将刷新以加载最新数据。");
            location.reload();
          })
          .catch(function (err) {
            if (err && err.unauth) return;
            alert("导入失败：" + (err && err.serverError ? err.serverError : (err && err.message ? err.message : "未知错误")));
          });
      });
    };
    reader.onerror = function () {
      alert("导入失败：无法读取所选文件。");
    };
    reader.readAsText(file);
  });

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
  [itemModal, groupModal, document.getElementById("discoverModal"), libraryModal].forEach(function (mask) {
    mask.addEventListener("click", function (e) {
      if (e.target === mask) closeModal(mask);
    });
  });

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
      itemForm.icon.value = it.icon || "";
      setLogoValue(it.logo || "");
      itemModalTitle.textContent = "编辑导航项";
    } else {
      itemModalTitle.textContent = "添加导航项";
    }
    openModal(itemModal);
    itemForm.title.focus();
  }

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
      iconOnlineHint.textContent = libraryState.onlineError + "——下方为内置推荐图标，离线也能用。";
    } else if (results) {
      iconOnlineHint.textContent = results.length
        ? ("Iconify 搜索到 " + results.length + " 个图标，点选即写入「在线图标」")
        : "Iconify 未找到匹配图标，换个关键词试试（如 github / nas / docker / music）";
    } else {
      iconOnlineHint.textContent = "「推荐」来自内置服务指纹库，离线可用；搜索走 Iconify 公开 API，需要联网。";
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

  function searchOnlineIcons() {
    var q = iconSearch.value.trim();
    libraryState.onlineError = "";
    if (!q) {
      libraryState.onlineResults = null;
      renderOnlineIcons();
      return;
    }
    iconSearchBtn.disabled = true;
    iconOnlineHint.textContent = "正在向 Iconify 搜索「" + q + "」…";
    iconGrid.innerHTML = "";
    iconEmpty.hidden = true;
    fetch("https://api.iconify.design/search?limit=60&query=" + encodeURIComponent(q))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var icons = (data && data.icons) || [];
        libraryState.onlineResults = icons.map(function (full) {
          var parts = String(full).split(":");
          return { name: parts[1] || parts[0], icon: "iconify:" + full, desc: parts[0] };
        });
      })
      .catch(function () {
        // 离线 / 跨域被拦截时不留空白：回退到内置推荐图标
        libraryState.onlineResults = null;
        libraryState.onlineError = "在线搜索失败（可能离线或网络受限）";
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
    if (logoInput.value) item.logo = logoInput.value;

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

  var discoverItems = [];   // 当前扫描结果（含用户就地编辑后的值）
  var discoverMeta = null;  // 后端返回的来源 / 能力信息
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
        var ignored = discoverySettings().ignored;
        discoverItems = (data.items || []).map(function (it) {
          // 以草稿中的忽略列表为准，避免保存前被服务端旧值回滚
          it.ignored = ignored.indexOf(it.id) !== -1 || !!it.ignored;
          if (it.ignored) it.selected = false;
          return it;
        });
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
