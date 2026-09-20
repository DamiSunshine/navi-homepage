/*
 * 生成本地内置图标库（P1-6）。
 *
 *   用法：node scripts/build-icons.cjs [--force] [--only slug1,slug2]
 *
 * 为什么要有它：
 *   原先「在线图标库」只有 33 个推荐图标，而且**全部靠公共 CDN 现拉**
 *   （cdn.jsdelivr.net / api.iconify.design）。用户实访是局域网 HTTP（飞牛 NAS），
 *   内网或断网时图标全白 —— 这是项目已确认的第二大短板。
 *   这里把一份精选图标**下载进仓库**（public/icons/），前端本地优先，
 *   CDN 退居兜底，于是断网也能出图。
 *
 * 产物（都入库，和 scripts/build-pinyin.cjs 的产物一样是可重复生成的源料）：
 *   public/icons/<slug>.svg          图标本体（SVG 平均约 1KB，250 个约 300KB）
 *   public/icons/catalog.json        目录清单：slug / 名称 / 关键词 / 文件 / 体积
 *   public/js/icon-map.js            给前端同步查表用：{ slug: "icons/x.svg" }
 *
 * 设计取舍：
 *   · 只下载 SVG，不下 PNG —— 同样清晰度下体积小一个数量级（1KB vs 15KB）。
 *   · 精选清单写在下面，而不是「把上游仓库整个拉下来」：一是可控体积，
 *     二是能自己写中文名与中文关键词（上游只有英文，中文搜索会搜不到）。
 *   · 拉不到的 slug 只跳过并汇总打印，**不当作失败** —— 上游图标库偶尔改名，
 *     不该因此让整次构建挂掉。真正「够不够用」由 test/icons.test.js 断言（要求 ≥200 个）。
 *   · 已存在且非空的文件默认不重复下载，重跑很快；要刷新用 --force。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "icons");
const CATALOG = path.join(OUT_DIR, "catalog.json");
const MAP_JS = path.join(ROOT, "public", "js", "icon-map.js");

const FORCE = process.argv.indexOf("--force") !== -1;
const ONLY = (function () {
  const i = process.argv.indexOf("--only");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1].split(",") : null;
})();

/* 上游图标源（按顺序尝试，命中即止）。
   都是 jsDelivr 的 gh 通道：国内可达性比 GitHub raw 好很多。 */
const SOURCES = [
  { id: "dashboard-icons", url: (s) => "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/svg/" + s + ".svg" },
  { id: "selfhst", url: (s) => "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/" + s + ".svg" }
];

/* 精选清单：[slug, 显示名, 中文/英文关键词]
   关键词用于「在线图标库」的本地搜索（中文名 + 拼音式英文 + 用途词都放进去）。 */
const CURATED = [
  // ---------- 媒体影音 ----------
  ["jellyfin", "Jellyfin", "影音 媒体 视频 nas 流媒体"],
  ["plex", "Plex", "影音 媒体 视频"],
  ["emby", "Emby", "影音 媒体 视频"],
  ["kodi", "Kodi", "影音 播放器 htpc"],
  ["navidrome", "Navidrome", "音乐 流媒体 电台"],
  ["airsonic", "Airsonic", "音乐 流媒体"],
  ["audiobookshelf", "Audiobookshelf", "有声书 播客 音频"],
  ["sonarr", "Sonarr", "剧集 追剧 自动下载"],
  ["radarr", "Radarr", "电影 自动下载"],
  ["lidarr", "Lidarr", "音乐 自动下载"],
  ["readarr", "Readarr", "电子书 自动下载"],
  ["prowlarr", "Prowlarr", "索引器 bt"],
  ["bazarr", "Bazarr", "字幕"],
  ["overseerr", "Overseerr", "求片 媒体请求"],
  ["jellyseerr", "Jellyseerr", "求片 媒体请求"],
  ["ombi", "Ombi", "求片 媒体请求"],
  ["tautulli", "Tautulli", "统计 plex 监控"],
  ["jellystat", "Jellystat", "统计 jellyfin 监控"],
  ["pinchflat", "Pinchflat", "youtube 订阅 下载"],
  ["immich", "Immich", "照片 相册 备份 图库"],
  ["photoprism", "PhotoPrism", "照片 相册 ai"],
  ["piwigo", "Piwigo", "相册 图片"],
  ["photoview", "PhotoView", "照片 相册"],
  ["mealie", "Mealie", "菜谱 食谱"],
  ["tandoor", "Tandoor", "菜谱 食谱"],

  // ---------- 下载 ----------
  ["qbittorrent", "qBittorrent", "bt 下载 种子"],
  ["transmission", "Transmission", "bt 下载 种子"],
  ["deluge", "Deluge", "bt 下载 种子"],
  ["aria2", "Aria2", "下载 离线 多线程"],
  ["sabnzbd", "SABnzbd", "usenet 下载"],
  ["nzbget", "NZBGet", "usenet 下载"],
  ["jackett", "Jackett", "索引 bt 搜索"],
  ["syncthing", "Syncthing", "同步 文件 p2p"],
  ["rdtclient", "RDT-Client", "下载 离线 云"],

  // ---------- 网络存储 / NAS ----------
  ["nextcloud", "Nextcloud", "网盘 云盘 同步 办公"],
  ["owncloud", "ownCloud", "网盘 云盘 同步"],
  ["seafile", "Seafile", "网盘 同步 文件"],
  ["truenas", "TrueNAS", "nas 存储 zfs"],
  ["freenas", "FreeNAS", "nas 存储 zfs"],
  ["openmediavault", "OpenMediaVault", "nas 存储"],
  ["unraid", "Unraid", "nas 存储 阵列"],
  ["synology", "Synology", "群晖 nas 存储"],
  ["qnap", "QNAP", "nas 存储"],
  ["casaos", "CasaOS", "nas 面板"],
  ["umbrel", "Umbrel", "nas 面板"],
  ["proxmox", "Proxmox VE", "虚拟化 kvm lxc"],
  ["portainer", "Portainer", "docker 容器 管理"],
  ["docker", "Docker", "容器"],
  ["kubernetes", "Kubernetes", "k8s 容器 编排"],
  ["rancher", "Rancher", "k8s 容器 管理"],
  ["cockpit", "Cockpit", "linux 服务器 管理"],
  ["virtualbox", "VirtualBox", "虚拟机"],
  ["vmware", "VMware", "虚拟机 虚拟化"],
  ["qemu", "QEMU", "虚拟机 模拟器"],

  // ---------- 家庭自动化 ----------
  ["home-assistant", "Home Assistant", "智能家居 米家 自动化"],
  ["esphome", "ESPHome", "智能家居 固件 esp"],
  ["node-red", "Node-RED", "流程 自动化 编排"],
  ["zigbee2mqtt", "Zigbee2MQTT", "智能家居 网关 zigbee"],
  ["mosquitto", "Mosquitto", "mqtt 消息 物联网"],
  ["openhab", "openHAB", "智能家居 自动化"],
  ["homebridge", "Homebridge", "智能家居 homekit 苹果"],
  ["domoticz", "Domoticz", "智能家居 自动化"],
  ["tasmota", "Tasmota", "固件 智能家居"],
  ["homebox", "HomeBox", "家庭 物品 库存 清单"],

  // ---------- 路由 / 网络 ----------
  ["openwrt", "OpenWrt", "路由器 固件 软路由"],
  ["pfsense", "pfSense", "防火墙 路由 软路由"],
  ["opnsense", "OPNsense", "防火墙 路由 软路由"],
  ["unifi", "UniFi", "优倍快 网络 ap"],
  ["adguard-home", "AdGuard Home", "去广告 dns 广告拦截"],
  ["pi-hole", "Pi-hole", "去广告 dns 广告拦截"],
  ["technitium", "Technitium DNS", "dns 服务器"],
  ["wireguard", "WireGuard", "vpn 隧道"],
  ["tailscale", "Tailscale", "vpn 组网 内网穿透"],
  ["zerotier", "ZeroTier", "vpn 组网 内网穿透"],
  ["nginx-proxy-manager", "Nginx Proxy Manager", "反向代理 证书"],
  ["traefik", "Traefik", "反向代理 负载均衡"],
  ["caddy", "Caddy", "web 服务器 证书"],
  ["haproxy", "HAProxy", "负载均衡 代理"],
  ["nginx", "Nginx", "web 服务器 代理"],
  ["apache", "Apache", "web 服务器"],
  ["cloudflare", "Cloudflare", "dns cdn 防护"],
  ["cloudflared", "Cloudflare Tunnel", "内网穿透 隧道"],
  ["frp", "frp", "内网穿透 端口转发"],

  // ---------- 监控 / 运维 ----------
  ["grafana", "Grafana", "监控 面板 图表"],
  ["prometheus", "Prometheus", "监控 指标"],
  ["uptime-kuma", "Uptime Kuma", "监控 可用性 拨测"],
  ["netdata", "Netdata", "监控 性能"],
  ["zabbix", "Zabbix", "监控 告警"],
  ["influxdb", "InfluxDB", "时序数据库 监控"],
  ["victoriametrics", "VictoriaMetrics", "监控 时序数据库"],
  ["loki", "Loki", "日志 聚合"],
  ["glances", "Glances", "监控 系统"],
  ["speedtest-tracker", "Speedtest Tracker", "测速 带宽 监控"],
  ["changedetection", "Changedetection.io", "网页监控 变更提醒"],
  ["ntfy", "ntfy", "推送 通知"],
  ["gotify", "Gotify", "推送 通知"],

  // ---------- 数据库 ----------
  ["mysql", "MySQL", "数据库"],
  ["mariadb", "MariaDB", "数据库"],
  ["postgresql", "PostgreSQL", "数据库 pg"],
  ["mongodb", "MongoDB", "数据库 文档"],
  ["redis", "Redis", "缓存 数据库"],
  ["sqlite", "SQLite", "数据库 嵌入式"],
  ["elasticsearch", "Elasticsearch", "搜索 索引 数据库"],
  ["clickhouse", "ClickHouse", "数据库 olap"],
  ["cassandra", "Cassandra", "数据库 分布式"],
  ["neo4j", "Neo4j", "图数据库"],
  ["phpmyadmin", "phpMyAdmin", "数据库 管理 mysql"],
  ["adminer", "Adminer", "数据库 管理"],

  // ---------- 开发 / 协作 ----------
  ["github", "GitHub", "代码 托管 仓库"],
  ["gitlab", "GitLab", "代码 托管 ci"],
  ["gitea", "Gitea", "代码 托管 仓库"],
  ["forgejo", "Forgejo", "代码 托管 仓库"],
  ["gogs", "Gogs", "代码 托管"],
  ["jenkins", "Jenkins", "ci 持续集成"],
  ["drone", "Drone CI", "ci 持续集成"],
  ["argo-cd", "Argo CD", "gitops 持续部署"],
  ["sonarqube", "SonarQube", "代码质量 静态扫描"],
  ["code-server", "code-server", "vscode 编辑器 云端"],
  ["jupyter", "Jupyter", "notebook 数据分析"],
  ["vscode", "VS Code", "编辑器 开发"],
  ["docker-hub", "Docker Hub", "镜像 仓库"],
  ["npm", "npm", "包管理 node"],
  ["nodejs", "Node.js", "运行时 javascript"],
  ["python", "Python", "语言 编程"],
  ["golang", "Go", "语言 编程 golang"],
  ["rust", "Rust", "语言 编程"],
  ["java", "Java", "语言 编程"],
  ["php", "PHP", "语言 编程"],
  ["typescript", "TypeScript", "语言 编程 ts"],
  ["react", "React", "前端 框架"],
  ["vue", "Vue.js", "前端 框架"],
  ["svelte", "Svelte", "前端 框架"],
  ["tailwindcss", "Tailwind CSS", "前端 css 框架"],
  ["postman", "Postman", "接口 测试 api"],
  ["insomnia", "Insomnia", "接口 测试 api"],
  ["swagger", "Swagger", "api 文档"],
  ["ansible", "Ansible", "运维 自动化 配置"],
  ["terraform", "Terraform", "基础设施 编排"],
  ["vagrant", "Vagrant", "开发环境 虚拟机"],
  ["arduino", "Arduino", "硬件 单片机"],
  ["raspberry-pi", "Raspberry Pi", "树莓派 硬件"],

  // ---------- 文档 / 知识库 ----------
  ["joplin", "Joplin", "笔记 知识库"],
  ["trilium", "Trilium Notes", "笔记 知识库"],
  ["obsidian", "Obsidian", "笔记 markdown"],
  ["notion", "Notion", "笔记 协作"],
  ["outline", "Outline", "知识库 wiki"],
  ["bookstack", "BookStack", "文档 wiki"],
  ["wikijs", "Wiki.js", "文档 wiki"],
  ["dokuwiki", "DokuWiki", "文档 wiki"],
  ["mediawiki", "MediaWiki", "文档 wiki"],
  ["confluence", "Confluence", "文档 协作"],
  ["appflowy", "AppFlowy", "笔记 知识库"],
  ["affine", "AFFiNE", "知识库 笔记"],
  ["onlyoffice", "ONLYOFFICE", "办公 文档 表格"],
  ["collabora", "Collabora Online", "办公 文档"],
  ["paperless-ngx", "Paperless-ngx", "文档 扫描 归档"],
  ["stirling-pdf", "Stirling PDF", "pdf 工具 处理"],
  ["calibre-web", "Calibre-Web", "电子书 阅读 书库"],
  ["kavita", "Kavita", "漫画 阅读"],
  ["komga", "Komga", "漫画 阅读"],
  ["wallabag", "Wallabag", "稍后读 收藏"],
  ["freshrss", "FreshRSS", "rss 阅读 订阅"],
  ["miniflux", "Miniflux", "rss 阅读 订阅"],
  ["linkwarden", "Linkwarden", "书签 收藏"],
  ["apprise", "Apprise", "通知 推送"],

  // ---------- 通信 / 社交 ----------
  ["mattermost", "Mattermost", "聊天 团队 im"],
  ["rocket-chat", "Rocket.Chat", "聊天 团队 im"],
  ["element", "Element", "聊天 matrix im"],
  ["matrix", "Matrix", "聊天 协议 im"],
  ["discord", "Discord", "聊天 语音"],
  ["slack", "Slack", "聊天 团队"],
  ["telegram", "Telegram", "聊天 im"],
  ["signal", "Signal", "聊天 加密"],
  ["whatsapp", "WhatsApp", "聊天 im"],
  ["zoom", "Zoom", "会议 视频"],
  ["jitsi", "Jitsi", "会议 视频 开源"],
  ["mastodon", "Mastodon", "社交 微博 长毛象"],
  ["misskey", "Misskey", "社交"],
  ["mailcow", "Mailcow", "邮件 服务器"],
  ["mailu", "Mailu", "邮件 服务器"],
  ["roundcube", "Roundcube", "邮件 webmail"],
  ["postfix", "Postfix", "邮件 服务器"],
  ["dovecot", "Dovecot", "邮件 服务器"],
  ["thunderbird", "Thunderbird", "邮件 客户端"],

  // ---------- 密码 / 认证 / 安全 ----------
  ["vaultwarden", "Vaultwarden", "密码 管理 bitwarden"],
  ["bitwarden", "Bitwarden", "密码 管理"],
  ["keepass", "KeePass", "密码 管理"],
  ["passbolt", "Passbolt", "密码 管理 团队"],
  ["authentik", "Authentik", "认证 sso 单点登录"],
  ["authelia", "Authelia", "认证 sso 单点登录"],
  ["keycloak", "Keycloak", "认证 sso 单点登录"],
  ["crowdsec", "CrowdSec", "安全 防护 入侵"],
  ["wazuh", "Wazuh", "安全 siem"],
  ["suricata", "Suricata", "安全 ids 入侵检测"],

  // ---------- 财务 / 生活 / 导航 ----------
  ["firefly-iii", "Firefly III", "记账 财务 预算"],
  ["actual-budget", "Actual Budget", "记账 财务 预算"],
  ["grocy", "Grocy", "家庭 库存 采购"],
  ["homepage", "Homepage", "导航 面板 起始页"],
  ["homer", "Homer", "导航 面板 起始页"],
  ["dashy", "Dashy", "导航 面板 起始页"],
  ["heimdall", "Heimdall", "导航 面板 起始页"],
  ["whoogle", "Whoogle", "搜索 聚合"],
  ["searxng", "SearXNG", "搜索 聚合 元搜索"],

  // ---------- 常用网站 ----------
  ["google", "Google", "搜索 谷歌"],
  ["baidu", "百度", "搜索 中文"],
  ["bing", "Bing", "搜索 微软"],
  ["zhihu", "知乎", "问答 中文"],
  ["bilibili", "哔哩哔哩", "b站 视频 弹幕"],
  ["youtube", "YouTube", "视频 油管"],
  ["netflix", "Netflix", "流媒体 影视"],
  ["spotify", "Spotify", "音乐 流媒体"],
  ["twitch", "Twitch", "直播 游戏"],
  ["reddit", "Reddit", "社区 论坛"],
  ["twitter", "X / Twitter", "社交 微博客"],
  ["wikipedia", "Wikipedia", "维基 百科"],
  ["weibo", "微博", "社交 中文"],
  ["taobao", "淘宝", "购物 电商"],
  ["jd", "京东", "购物 电商"],
  ["netease-music", "网易云音乐", "音乐 中文"],
  ["qq-music", "QQ音乐", "音乐 中文"],
  ["aliyun", "阿里云", "云服务 云主机"],
  ["tencent-cloud", "腾讯云", "云服务 云主机"],
  ["openai", "OpenAI", "ai 大模型 gpt"],
  ["chatgpt", "ChatGPT", "ai 对话 大模型"],
  ["claude", "Claude", "ai 对话 大模型"],
  ["huggingface", "Hugging Face", "ai 模型 开源"],
  ["figma", "Figma", "设计 ui 协作"],
  ["csdn", "CSDN", "技术 博客 中文"],
  ["juejin", "掘金", "技术 社区 中文"],
  ["gitee", "Gitee", "代码 托管 中文 码云"],

  // ---------- 系统 / 平台 ----------
  ["linux", "Linux", "系统 操作系统"],
  ["ubuntu", "Ubuntu", "系统 linux 发行版"],
  ["debian", "Debian", "系统 linux 发行版"],
  ["centos", "CentOS", "系统 linux 发行版"],
  ["fedora", "Fedora", "系统 linux 发行版"],
  ["arch-linux", "Arch Linux", "系统 linux 发行版"],
  ["alpine-linux", "Alpine Linux", "系统 linux 发行版 容器"],
  ["opensuse", "openSUSE", "系统 linux 发行版"],
  ["freebsd", "FreeBSD", "系统 unix"],
  ["apple", "Apple", "系统 macos ios 苹果"],
  ["android", "Android", "系统 安卓"],
  ["windows", "Windows", "系统 微软"]
];

/* 上游图标库（dashboard-icons / selfh.st）里确实没有的站点 —— 主要是国内站点。
   对中文用户来说这些恰恰是最常用的几个，所以退一步：直接抓站点自己的 favicon 存本地。
   这样「本地优先」对中文用户才真的成立；抓不到就跳过，不影响其余图标。
   质量提醒：favicon 常是 16×16/32×32，放大到卡片尺寸会略糊，
   属于「有总比裂图强」的兜底，不追求美观。 */
const SITES = [
  ["zhihu", "知乎", "问答 中文", "https://www.zhihu.com"],
  ["taobao", "淘宝", "购物 电商", "https://www.taobao.com"],
  ["jd", "京东", "购物 电商", "https://www.jd.com"],
  ["netease-music", "网易云音乐", "音乐 中文", "https://music.163.com"],
  ["qq-music", "QQ音乐", "音乐 中文", "https://y.qq.com"],
  ["csdn", "CSDN", "技术 博客 中文", "https://www.csdn.net"],
  ["juejin", "掘金", "技术 社区 中文", "https://juejin.cn"],
  ["douyin", "抖音", "短视频 中文", "https://www.douyin.com"],
  ["xiaohongshu", "小红书", "社区 中文", "https://www.xiaohongshu.com"],
  ["tencent-cloud", "腾讯云", "云服务 云主机", "https://cloud.tencent.com"],
  ["docker-hub", "Docker Hub", "镜像 仓库", "https://hub.docker.com"],
  ["code-server", "code-server", "vscode 编辑器 云端", "https://coder.com"],
  ["dashy", "Dashy", "导航 面板 起始页", "https://dashy.to"]
];

/* 按文件头判断图片类型。存下来之前必须确认它真的是图，
   否则会把一段 HTML 错误页（很多站点对未知 UA 返回 403 页面）当成图标存进仓库。 */
function imageExt(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") return "png";
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return "ico";
  if (buf.slice(0, 3).toString("latin1") === "GIF") return "gif";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (/<svg[\s>]/i.test(buf.slice(0, 2048).toString("utf-8"))) return "svg";
  return null;
}

/* favicon 质量门槛。拿到 16×16 的单色图、或近乎全透明的空图，放进卡片只会变成一个
   糊成一团的白块 —— 比「没有图标」更糟（前端对加载失败的图标会回退成首字母，反而是可读的）。
   所以这里宁可拒掉。返回 null 表示可用，否则返回一句拒绝原因（会打印出来便于排查）。 */
function faviconQuality(buf) {
  if (!buf || buf.length < 32) return "体积过小";

  // ICO 里也可能嵌 PNG（现代站点常见），先按 PNG 头取尺寸
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    return w >= 24 && h >= 24 ? null : "PNG 仅 " + w + "×" + h;
  }
  if (buf.slice(0, 3).toString("latin1") === "GIF" || (buf[0] === 0xff && buf[1] === 0xd8)) return null;
  if (/<svg[\s>]/i.test(buf.slice(0, 2048).toString("utf-8"))) return null;

  if (!(buf[0] === 0x00 && buf[1] === 0x00 && buf[3] === 0x00)) return "无法识别的格式";
  const frames = buf.readUInt16LE(4);
  if (!frames) return "ICO 里没有帧";

  // 选「分辨率够大 + 字节数最多」的那一帧：同一尺寸可能同时有 4bpp 与 32bpp 两个版本，
  // 单看面积会挑到低色深的那个（jd.com 就是这样）。
  let best = null;
  for (let i = 0; i < frames; i++) {
    const off = 6 + i * 16;
    const w = buf[off] || 256, h = buf[off + 1] || 256;
    if (w < 24 || h < 24) continue;
    const size = buf.readUInt32LE(off + 8), start = buf.readUInt32LE(off + 12);
    if (start + size > buf.length) continue;
    if (!best || size > best.size) best = { w, h, size, start };
  }
  if (!best) return "所有帧都小于 24×24";

  const data = buf.slice(best.start, best.start + best.size);
  if (data[0] === 0x89) return null;                       // 该帧本身是 PNG
  if (data.length < 40) return "帧数据不完整";
  const bpp = data.readUInt16LE(14);
  if (bpp !== 32) return "最大帧仅 " + bpp + "bpp（低色深）";

  const px = data.slice(40);
  const colors = new Set();
  let opaque = 0, total = 0;
  for (let i = 0; i + 3 < px.length && total < best.w * best.h; i += 4) {
    total++;
    if (px[i + 3] > 16) {
      opaque++;
      colors.add((px[i + 2] >> 3) + "," + (px[i + 1] >> 3) + "," + (px[i] >> 3));
    }
  }
  if (!total) return "没有像素";
  const ratio = opaque / total;
  if (ratio < 0.4) return "图案过淡（不透明像素仅 " + Math.round(ratio * 100) + "%）";
  if (colors.size < 3) return "近乎单色（" + colors.size + " 色）";
  return null;
}

async function downloadFavicon(origin) {
  const tries = ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"];
  const rejected = [];
  for (const p of tries) {
    const r = await get(origin + p, 0);
    if (r.status !== 200 || !r.buf) continue;
    const ext = imageExt(r.buf);
    if (!ext) { rejected.push(p + ":不是图片"); continue; }
    const why = faviconQuality(r.buf);
    if (why) { rejected.push(p + ":" + why); continue; }
    return { buf: r.buf, ext: ext };
  }
  return rejected.length ? { reject: rejected.join(" / ") } : null;
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/* 上游改名了、但我们的清单里习惯用短名的，在这里补一条别名。
   这样清单里可以写人类顺手的 slug（rdtclient / cassandra），不必迁就上游仓库的命名。 */
const ALIASES = {
  rdtclient: ["rdt-client"],
  cassandra: ["apache-cassandra"],
  collabora: ["collabora-online"],
  tandoor: ["tandoor-recipes"],
  huggingface: ["hugging-face"]
};
function candidatesFor(slug) {
  return [slug].concat(ALIASES[slug] || []);
}

function get(url, depth) {
  return new Promise((resolve) => {
    if (depth > 5) { resolve({ status: "LOOP" }); return; }
    const req = https.request(url, {
      method: "GET", timeout: 15000,
      headers: { "User-Agent": "navi-build-icons/1.0", "Accept": "image/svg+xml,*/*" }
    }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        res.resume();
        get(new URL(res.headers.location, url).href, depth + 1).then(resolve);
        return;
      }
      const chunks = [];
      let len = 0;
      res.on("data", (c) => {
        chunks.push(c); len += c.length;
        if (len > 256 * 1024) { req.destroy(); }        // 上限：图标不该这么大
      });
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      res.on("error", () => resolve({ status: "ERR" }));
    });
    req.on("error", (e) => resolve({ status: "ERR", err: e.code }));
    req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT" }); });
    req.end();
  });
}

/* 只接受「看起来真的是 SVG」的内容。
   上游 404 时常返回一段 HTML 错误页；直接存下来会在浏览器里变成一个裂图/空白，
   比没有图标更难排查。所以这里做一次内容体检。 */
function looksLikeSvg(buf) {
  if (!buf || buf.length < 40) return false;
  const head = buf.slice(0, 4096).toString("utf-8");
  if (/^\s*(<!doctype html|<html)/i.test(head)) return false;
  return /<svg[\s>]/i.test(head);
}

async function downloadOne(slug) {
  for (const src of SOURCES) {
    for (const cand of candidatesFor(slug)) {
      const r = await get(src.url(cand), 0);
      if (r.status === 200 && looksLikeSvg(r.buf)) {
        return { src: src.id, buf: r.buf, as: cand };
      }
    }
  }
  return null;
}

(async function main() {
  const list = CURATED.filter((e) => !ONLY || ONLY.indexOf(e[0]) !== -1);
  if (ONLY) console.log("仅处理：" + list.map((e) => e[0]).join(", "));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(MAP_JS), { recursive: true });

  const entries = [];
  const missed = [];
  const failed = [];
  const seen = {};        // CURATED 内部去重（出现过就不要再试，避免重复条目）
  const done = {};        // 已经有本地文件的 slug（含站点 favicon 补齐的）
  let downloaded = 0, reused = 0;

  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const entry = list[cursor++];
      const slug = slugify(entry[0]);
      if (!slug) { failed.push(entry[0] + "(slug 非法)"); continue; }
      if (seen[slug]) { failed.push(slug + "(重复)"); continue; }
      seen[slug] = true;

      const file = slug + ".svg";
      const abs = path.join(OUT_DIR, file);
      let got = null;

      let exists = false;
      try { exists = fs.statSync(abs).size > 40; } catch (e) { exists = false; }

      if (exists && !FORCE) {
        reused++;
        entries.push({ slug, name: entry[1], keywords: entry[2] || "", file, bytes: fs.statSync(abs).size, source: "cache" });
        done[slug] = true;
        continue;
      }

      got = await downloadOne(slug);
      if (!got) { missed.push(slug); continue; }

      fs.writeFileSync(abs, got.buf);
      downloaded++;
      done[slug] = true;
      entries.push({
        slug, name: entry[1], keywords: entry[2] || "", file, bytes: got.buf.length,
        source: got.as === slug ? got.src : got.src + "(" + got.as + ")"
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  /* 第二遍：上游图标库没有的站点，抓它自己的 favicon 补齐。
     串行即可（只有十来个），失败只记一笔，不算错误。 */
  const siteMissed = [];
  for (const site of SITES) {
    const slug = slugify(site[0]);
    // 注意这里判的是 done（已有本地文件），不是 seen —— 上游查过但没收录的 slug
    // 必须留给这一遍再试 favicon，否则「上游没有 = 本地也没有」。
    if (!slug || done[slug]) continue;

    const have = ["svg", "png", "ico", "gif", "jpg"]
      .map((ext) => slug + "." + ext)
      .filter((f) => {
        try { return fs.statSync(path.join(OUT_DIR, f)).size > 40; } catch (err) { return false; }
      });
    if (have.length && !FORCE) {
      const f = have[0];
      reused++;
      done[slug] = true;
      // 已经有本地文件，同样要从「上游未收录」名单里撤下来，否则汇总数字自相矛盾
      const mi = missed.indexOf(slug);
      if (mi !== -1) missed.splice(mi, 1);
      entries.push({
        slug, name: site[1], keywords: site[2], file: f,
        bytes: fs.statSync(path.join(OUT_DIR, f)).size,
        source: "favicon:" + new URL(site[3]).hostname + "(缓存)"
      });
      continue;
    }

    const got = await downloadFavicon(site[3]);
    if (!got) { siteMissed.push(slug); continue; }
    if (got.reject) { siteMissed.push(slug + "〔" + got.reject + "〕"); continue; }
    const file = slug + "." + got.ext;
    fs.writeFileSync(path.join(OUT_DIR, file), got.buf);
    downloaded++;
    done[slug] = true;
    // 上游没收录、但 favicon 补齐了 —— 从「未收录」名单里撤下来，别让汇总数字自相矛盾
    const mi = missed.indexOf(slug);
    if (mi !== -1) missed.splice(mi, 1);
    entries.push({
      slug, name: site[1], keywords: site[2], file, bytes: got.buf.length,
      source: "favicon:" + new URL(site[3]).hostname
    });
  }

  /* 目录顺序：先按分类出现顺序（即 CURATED 顺序），保证 build 稳定、diff 可读。
     这里用 CURATED 的下标做排序键，避免 JSON 顺序随并发乱跳。 */
  const order = {};
  CURATED.forEach((e, i) => { order[slugify(e[0])] = i; });
  SITES.forEach((e, i) => { order[slugify(e[0])] = CURATED.length + i; });
  entries.sort((a, b) => (order[a.slug] || 0) - (order[b.slug] || 0));

  const catalog = {
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: SOURCES.map((s) => s.id),
    note: "由 scripts/build-icons.cjs 生成；本地优先，CDN 兜底。改动请改脚本里的 CURATED 清单。",
    count: entries.length,
    icons: entries
  };
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");

  // 前端同步查表用的映射（比读 catalog.json 少一次请求，也不受加载时序影响）
  const map = {};
  entries.forEach((e) => { map[e.slug] = "icons/" + e.file; });
  fs.writeFileSync(MAP_JS,
    "/* 由 scripts/build-icons.cjs 生成，不要手改。\n" +
    "   图标本体在 public/icons/ 下，本地优先；取不到时前端才回退公共 CDN。 */\n" +
    "window.NAVI_LOCAL_ICONS = " + JSON.stringify(map, null, 2) + ";\n");

  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  console.log("内置清单：" + list.length + " 条；站点兜底：" + SITES.length + " 条");
  console.log("成功 " + entries.length + "（新下载 " + downloaded + " / 复用 " + reused +
    "）  上游未收录 " + missed.length + "  站点 favicon 未取到 " + siteMissed.length + "  异常 " + failed.length);
  console.log("图标总量：" + Math.round(totalBytes / 1024) + " KB（平均 " + Math.round(totalBytes / Math.max(1, entries.length)) + " B）");
  if (missed.length) console.log("上游未收录（已跳过，交由在线搜索 / favicon 代理兜底）：" + missed.join(", "));
  if (siteMissed.length) console.log("站点 favicon 未取到：" + siteMissed.join(", "));
  if (failed.length) console.log("异常：" + failed.join(", "));
  console.log("产物：public/icons/*  public/icons/catalog.json  public/js/icon-map.js");
})().catch((e) => { console.error("异常:", e); process.exit(1); });
