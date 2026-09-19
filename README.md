# Navi · 个人导航站

参考 [sun-panel](https://github.com/hslr-s/sun-panel) 核心思路实现的轻量级个人导航面板：**前端可视化编辑 + 零依赖 Node 后端**的 All-in-One Docker 镜像，开箱即用。

> **已经发布预构建镜像**：`ghcr.io/mijunyi/navi-homepage`（含 `linux/amd64` 与 `linux/arm64`）。
> 不想构建、不想传源码，只想在另一台机器上一条命令跑起来 → 直接看 **[`docs/image-deploy-guide.html`](docs/image-deploy-guide.html)**（拉取镜像部署指南）。

## 特性

- **前端可视化编辑（类 sun-panel）**：点击右上角「编辑」进入编辑模式——
  - 卡片**拖拽排序**，支持跨分组拖动
  - 添加 / 修改 / 删除导航项（弹窗表单：名称、描述、外网地址、内网地址、在线图标、本地图床 Logo）
  - 分组添加 / 重命名 / 删除
  - 「保存」通过 API 直接写回服务器 `config.json`；「备份」下载结构化备份文件；「导入」校验后一键恢复
  - 纯静态托管（无后端）时自动降级：修改保存在浏览器本地并提示导出
- **数据备份与恢复**：一键导出含 SHA-256 校验和的结构化备份文件；导入时校验格式 / 版本 / 完整性 / 结构，导入前二次确认，损坏或格式不匹配时明确报错且**不影响现有数据**
- **卡片 Logo 本地上传**：导航项可上传本地图片（PNG / JPEG / GIF / WebP）作为 Logo，服务器按文件头魔数校验真实类型并落盘
- **本地图床库（图标一次上传、所有卡片复用）**：卡片 Logo 支持「在线图标库」与「本地图床库」两种来源，上传过的图片进入本地图床库并可被任意卡片重复选用——
  - **批量上传**：一次可选 / 拖入多张图标（单张上限 3MB），前端按体积与张数自动分片提交，逐张独立校验，**部分失败不影响其余图片**，并逐条给出失败原因
  - **库内管理**：按文件名搜索、缩略图预览、标注「使用中 N」（并显示引用它的卡片名）、批量勾选删除
  - **引用保护**：删除仍被卡片引用的图片时默认拒绝，需二次确认后才强制删除，避免误点让线上卡片集体回退为字母图标
  - **零额外状态**：图床库目录直接由上传目录的文件系统推导（不建数据库、不写索引文件），与既有备份 / 恢复流程互不干扰
- **内外网一键切换**：导航项可分别配置 `url`（外网）与 `lanUrl`（内网）；通过内网 IP / IPv6 ULA 地址访问时自动进入内网模式
- **IPv4 / IPv6 双栈**：服务绑定 `::`，同时接受 IPv4 与 IPv6 连接
- **在线图标库接入**：内置 4 种图标来源，无需本地存图：
  | 写法 | 来源 |
  | --- | --- |
  | `"icon": "jellyfin"` | [Dashboard Icons](https://github.com/walkxcode/dashboard-icons)（按名称自动匹配） |
  | `"icon": "selfhst:portainer"` | [selfh.st Icons](https://selfh.st/icons) |
  | `"icon": "iconify:simple-icons:github"` | [Iconify](https://icon-sets.iconify.design/) 全量图标库 |
  | `"icon": "https://…/logo.png"` | 任意图片直链 |
  | 留空 | 按标题首字母生成回退图标 |
- **服务发现（Docker-Panel 同思路）**：自动识别 Docker 容器与本机监听端口，按服务类型自动匹配图标，一键生成导航卡片——
  - **端口自动识别**：读取容器端口映射（Docker Engine API），以及本机监听端口（Linux 解析 `/proc/net/tcp*` 并反查进程名；Windows / macOS 降级为 `netstat` / `lsof`）；自动过滤系统进程与 `udp` 端口
  - **图标自动匹配**：按「镜像名 → 容器名 → 进程名 → 端口」匹配内置服务指纹库（30+ 常见服务，含 qBittorrent / Jellyfin / Portainer / Alist 等），未命中时自动探测 Dashboard Icons 与 selfh.st 图标库，最终回退字母图标
  - **地址自动拼装**：内网 `http://<内网IP>:<宿主机映射端口>`；外网为域名时走 `https://` 且不追加端口，为公网 IP 时走 `http://` 并追加端口
  - **卡片动态生成**：编辑模式点「服务发现」→ 勾选 → 加入选中项 → 保存，即写入 `config.json`；已在导航中的服务自动标记并跳过，依赖容器（数据库 / 缓存）与已停止容器默认不勾选，也可逐项「忽略」
- **访问密码保护**：环境变量一键启用，登录页 + HMAC 会话 Cookie + 全站强制校验 + 登录限流 + 服务端登出吊销（详见下文）
- **日间 / 夜间模式**：导航站右上角一键切换，跟随系统偏好作为初始值，选择保存在浏览器本地（登录页同样支持）
- **简约科技感 UI**：暗色玻璃拟态卡片、网格辉光背景、实时时钟、卡片渐入动画
- **实时搜索**：支持标题 / 描述 / URL 过滤，`/` 键快速聚焦搜索框
- **零依赖零数据库**：后端仅用 Node 内置模块（无需 npm install），所有导航数据都在 `config.json` 中

## 快速开始（Docker）

### 方式 A：拉预构建镜像（最省事，不需要构建）

镜像由 GitHub Actions 在打 tag 时自动构建并推送到 GHCR，同时提供 `linux/amd64` 与 `linux/arm64`：

```bash
mkdir -p data

# ① 从镜像里导出初始配置（挂载会遮住镜像内置的示例配置，这步不能省）
docker run --rm ghcr.io/mijunyi/navi-homepage:latest cat /app/data/config.json > data/config.json

# ② 写下访问密码（compose 用 ${NAVI_PASSWORD:?...} 强制校验，缺了会直接报错退出）
echo 'NAVI_PASSWORD=你的强密码' > .env

# ③ 先 pull 再起（直接 up 会复用本地旧镜像，升级时最容易踩这个坑）
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

> 完整说明见 **[`docs/image-deploy-guide.html`](docs/image-deploy-guide.html)**：包可见性与登录凭据、
> 国内访问 ghcr.io 的三种对策、CPU 架构匹配、图形界面部署要点、升级回滚与 12 项排查表。
>
> ⚠️ **两个常见前提**：① 镜像首次发布前 `pull` 会报 `manifest unknown`，需先去 Actions 触发一次构建；
> ② GHCR 的包默认可能是 private，需在包设置里改成 public（否则目标机要先 `docker login ghcr.io`）。

### 方式 B：从源码构建

```bash
# 构建镜像
docker build -t navi .

# 首次先放置一份初始化配置（可拷贝仓库附带的示例）
mkdir -p ./data && cp public/config.example.json ./data/config.json

# 运行（IPv4/IPv6 双栈，宿主机 8080 端口；挂载整个 data 目录便于编辑持久化）
docker run -d --name navi \
  -p 8080:80 \
  -e NAVI_CONFIG_PATH=/app/data/config.json \
  -e NAVI_UPLOAD_DIR=/app/data/uploads \
  -v $(pwd)/data:/app/data \
  navi
```

或使用 docker compose（**源码构建模式**，会先在本机构建）：

```bash
mkdir -p data && cp public/config.example.json data/config.json
docker compose up -d
```

> 仓库里有**两份**编排文件，是二选一的关系，靠 `-f` 切换：
>
> | 文件 | 行为 | 用途 |
> | --- | --- | --- |
> | `docker-compose.yml` | 先 `build: .` 再起容器 | 改了代码要重建时用 |
> | `docker-compose.image.yml` | 不含 `build:`，只拉 `ghcr.io` 上的预构建镜像 | 部署到别的机器时用 |
>
> 可用 `node scripts/check-compose.cjs` 自检（会强制校验「纯拉取编排不得含 `build:`」、
> 密码护栏仍是 `:?`、数据目录是整目录挂载）。

访问 `http://localhost:8080` 或 `http://[你的IPv6地址]:8080`。

> **为什么整目录挂载而不是单文件挂载？** 见下方「数据持久化与写入说明」——这能避免在部分 NAS/挂载平台上保存失败（EBUSY）的问题。

> **部署到飞牛 fnOS / NAS？** 请直接看 **`docs/fnos-deploy-guide.html`**（浏览器打开即可）。该指南覆盖 fnOS 的存储路径约定（`/vol1/1000/docker/...`）、SSH 开启方式、图形界面 Compose 项目的限制、文件属主权限处理、完整故障排查表与部署检查清单。更通用的 Docker 说明见 `docs/docker-guide.html`。

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 容器内监听端口 | `80` |
| `SITE_TITLE` | 覆盖站点标题（展示层，不写回配置） | 读 config.json |
| `SITE_SUBTITLE` | 覆盖站点副标题 | 读 config.json |
| `NAVI_PASSWORD` | 访问密码（设置后启用密码保护；不设置则开放访问） | 空 |
| `NAVI_PASSWORD_HASH` | 密码的 sha256 哈希（与上面的明文二选一，更推荐） | 空 |
| `NAVI_USERNAME` | 登录用户名（设置后启用「用户名 + 密码」联合登录；不设置则仅用密码） | 空 |
| `SESSION_TTL_HOURS` | 会话有效期（小时），过期自动回登录页 | `72` |
| `NAVI_CONFIG_PATH` | 自定义 config.json 路径（默认 `public/config.json`；Docker 通常设为 `/app/data/config.json`） | 内置默认 |
| `NAVI_UPLOAD_DIR` | 自定义 Logo 上传目录（默认 `public/uploads`；Docker 通常设为 `/app/data/uploads`） | 内置默认 |
| `DOCKER_SOCKET` | Docker Socket 路径（服务发现用；默认 `/var/run/docker.sock`） | `/var/run/docker.sock` |
| `DOCKER_HOST_NAME` / `DOCKER_HOST_PORT` | 改用远程 Docker API（TCP）时的主机与端口（不挂 Socket 时可选） | 空 / `2375` |
| `NAVI_LAN_HOST` | 服务发现生成的**内网地址**基址（IP 或主机名；不设则取请求 Host / 自动探测网卡） | 自动 |
| `NAVI_WAN_HOST` | 服务发现生成的**外网地址**基址（域名或公网 IP；不设则用内网地址兜底） | 空 |
| `NAVI_ICON_PROBE` | 设为 `0` 关闭图标在线探测（离线环境建议关闭，加快扫描） | `1` |
| `NAVI_ICON_PROBE_BASE` | 图标探测的 CDN 基址，可指向自建镜像（须保持上游目录结构） | `https://cdn.jsdelivr.net/gh/` |
| `NAVI_SCAN_LOCAL` | 设为 `0` 关闭本机监听端口扫描（只用 Docker 容器发现） | `1` |
| `NAVI_DISCOVER_TIMEOUT` | 单次 Docker API 超时（毫秒） | `2500` |
| `NAVI_IMAGE` | **仅 compose 读取**：换用 GHCR 镜像站 / 自建代理（国内直连 ghcr.io 常不通） | `ghcr.io/mijunyi/navi-homepage` |
| `NAVI_TAG` | **仅 compose 读取**：固定镜像版本，避免 `latest` 漂移（可填 `1.2.3` / `1.2` / `edge`） | `latest` |

> `NAVI_IMAGE` / `NAVI_TAG` 是 **compose 插值变量**，不是容器内的环境变量 ——
> 它们只在解析编排文件时生效，不会被注入容器。其余变量才是在容器里被 `server.js` 读取的。

## 访问密码保护

设置 `NAVI_PASSWORD` 或 `NAVI_PASSWORD_HASH` 即启用密码保护；**同时设置 `NAVI_USERNAME`** 则升级为「用户名 + 密码」联合登录（两项都正确才能进入）。不设置密码则站点开放访问。

```bash
# 方式一：明文密码（仅存于服务器环境变量，代码中无硬编码）
docker run -d --name navi -p 8080:80 \
  -e NAVI_PASSWORD="你的强密码" \
  -e NAVI_CONFIG_PATH=/app/data/config.json \
  -v $(pwd)/data:/app/data \
  navi

# 方式二（推荐）：先算哈希再部署，环境变量里也不留明文
node -e "console.log(require('crypto').createHash('sha256').update('navi-site:你的强密码').digest('hex'))"
docker run -d --name navi -p 8080:80 \
  -e NAVI_PASSWORD_HASH="上一步输出的哈希" \
  -e NAVI_CONFIG_PATH=/app/data/config.json \
  -v $(pwd)/data:/app/data \
  navi

# 方式三（增强）：用户名 + 密码联合登录
docker run -d --name navi -p 8080:80 \
  -e NAVI_USERNAME="admin" \
  -e NAVI_PASSWORD="你的强密码" \
  -e NAVI_CONFIG_PATH=/app/data/config.json \
  -v $(pwd)/data:/app/data \
  navi
```

启用后的行为：

- 未认证访问任何页面 / 静态资源 / API，一律 302 跳转登录页（API 返回 401）
- 设置了 `NAVI_USERNAME` 后，登录页会**额外显示用户名字段且必填**，必须同时输入正确的用户名 + 密码；用户名或密码任一错误均提示「用户名或密码错误」（不区分是哪项，防用户枚举）
- 登录页密码错误时给出明确提示；同一 IP 连续失败 5 次锁定 1 分钟
- 登录成功签发 HMAC 签名会话令牌，存于 **HttpOnly + SameSite=Lax** Cookie（HTTPS 部署自动加 `Secure`），有效期内免重复登录
- 密码校验使用加盐 sha256 + 恒时比较；用户名校验同样恒时比较；签名密钥每次启动随机生成，重启后旧会话全部失效
- 页头出现「退出」按钮，登出会**服务端吊销**当前令牌并清除 Cookie

> 提示：暴露公网建议再套一层 HTTPS（如 Caddy / Nginx 反代或 Cloudflare），登录请求全程加密传输。

## 本地开发（不用 Docker）

```bash
node server.js          # 默认 80 端口
PORT=3000 node server.js
```

也可以用任意静态服务器（如 `python -m http.server`）预览，但编辑保存会降级为浏览器本地存储。

## 编辑导航项

**推荐方式：直接在网页上编辑**——右上角点「编辑」，拖动排序 / 增删改 / 分组管理，最后点「保存」写回服务器。

也可以手动编辑 `public/config.json`：

```jsonc
{
  "site": { "title": "Navi", "subtitle": "个人导航站", "footer": "…" },
  "groups": [
    {
      "name": "分组名称",
      "items": [
        {
          "title": "Jellyfin",            // 站点名（必填）
          "desc": "影音媒体库",            // 描述（可选）
          "icon": "jellyfin",             // 图标（可选，见上文图标规则）
          "url": "https://media.example.com",  // 外网地址（必填）
          "lanUrl": "http://192.168.1.10:8096" // 内网地址（可选）
        }
      ]
    }
  ]
}
```

## 数据持久化与写入说明

Navi 的运行时数据分为两部分：**导航配置 `config.json`** 与 **Logo 上传图片**。它们都会被前端编辑/上传修改，因此必须落在可写、可持久化的位置。

- **推荐挂载整个数据目录**（`./data:/app/data`），而不是单独挂载 `config.json` 一个文件。
- 原因：写配置采用**原子写**（先写 `.tmp` 再 `rename` 覆盖）。若只挂载单个文件，`rename` 会发生在两个不同的挂载点（临时文件在镜像层、目标文件在宿主机），在部分平台（如飞牛 NAS、网络/Overlay 文件系统）会触发 **`EBUSY: resource busy or locked`**，导致保存失败。整目录挂载后，`rename` 位于同一挂载点内，天然规避该问题。
- 服务已内置**写入降级兜底**：即便仍遇到 `EBUSY`/`EXDEV` 等跨挂载错误，会自动改为直接覆盖写入，保存流程照常成功（仅放弃一点儿原子性以保证可用）。
- 容器内已内置一份示例配置（`/app/data/config.json`），未挂载时可直接运行；挂载后会使用宿主 `./data/config.json`（建议先从 `public/config.example.json` 拷贝一份作为初始配置）。

### 从旧版（单文件挂载）平滑升级

如果之前是用旧命令单文件挂载（`-v .../config.json:/app/public/config.json`）部署，想切换到整目录挂载而不丢数据，仓库提供一键脚本：

```bash
cd 导航站项目目录
sudo bash scripts/migrate-to-dir-mount.sh        # 默认用 docker compose 起容器
# 或不用 compose：
sudo bash scripts/migrate-to-dir-mount.sh --no-compose
```

脚本会自动：备份现有 config 与 uploads 到 `./backups/<时间戳>/` → 迁移真实数据到 `./data/{config.json,uploads/}` → 重建镜像 → 用整目录挂载重启容器 → 健康检查。全程幂等，不丢数据。

## 开源发布到 GitHub（只发源码，不含私有数据）

本项目源码可安全开源，私有数据请**不要**提交仓库。仓库已内置 `.gitignore` 完成默认排除，发布前请复核：

1. **已排除**：`public/config.json`（你的真实导航链接/内网地址）、`public/uploads/`（你的 Logo 图片）、`data/`（挂载的数据目录）、`.env`（真实密码）、`.workbuddy/`、`.wbapp_*.genie`、`preview-launcher.js`、`*.tmp`、`node_modules` 等。
2. **保留提交**：`public/config.example.json`、`.env.example`、`server.js`、`discovery.js`、`Dockerfile`、`docker-compose.yml`、`docker-compose.image.yml`、`.github/workflows/`（镜像发布工作流）、前端文件、`test/`、`README.md`、`LICENSE`。
3. **密码只走 `.env`**：`docker-compose.yml` 中为 `NAVI_PASSWORD=${NAVI_PASSWORD:?...}`，真实密码写在项目根目录的 `.env`（已被 gitignore / dockerignore 排除）。首次部署：

   ```bash
   cp .env.example .env        # 然后编辑 .env 填入真实密码
   ```

   缺少 `.env` 时 compose 会**直接报错退出**，不会静默退化成「无密码开放访问」。
4. 首次初始化数据目录：`cp public/config.example.json data/config.json`。
5. **哈希必须带盐前缀**：`NAVI_PASSWORD_HASH` 比对的是 `sha256("navi-site:" + 密码)`。直接用裸 `sha256(密码)` 填进去会**永远登录失败（返回 401 且不报错）**，容易误判成密码写错。正确生成方式：

   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update('navi-site:'+process.argv[1]).digest('hex'))" '你的密码'
   ```

## 发布预构建镜像（GHCR）

`.github/workflows/docker-publish.yml` 会在 **GitHub 的机器上**自动构建镜像并推送到 GHCR，
把用户侧的操作从「clone + build」压缩成「一句 `pull`」——**本地完全不需要装 Docker**。

| 触发方式 | 产出的标签 | 备注 |
| --- | --- | --- |
| 推送 `main` | `edge` | 开发中的最新代码，**不会**动 `latest` |
| 打 tag `v1.2.3` | `1.2.3`、`1.2`、`latest` | 正式发布，只有这条路径更新 `latest` |
| Actions 页面手动触发 | `edge` | 不想改代码、只想立刻构建一次时用 |

发布一个正式版本：

```bash
git tag v1.0.0
git push origin v1.0.0
```

工作流包含两个作业：

1. **构建并推送** —— 通过 QEMU 在 amd64 runner 上同时产出 `linux/amd64` 与 `linux/arm64` 两个架构；
2. **冒烟验证** —— 构建完成后**真实启动一次容器**，校验镜像架构、暴露端口、声明的数据卷，
   并请求 `/api/health` 确认返回 `"ok":true`。「构建成功」不等于「跑得起来」，这一步把后者也变成事实。

> ⚠️ **首次发布后请把包改成 public**：GHCR 上的包可见性与代码仓库**不完全联动**，
> 手动推送创建的包默认可能是 private。去
> `https://github.com/users/<用户名>/packages/container/navi-homepage/settings` →
> Danger Zone → Change package visibility 改成 Public，否则目标机器要先 `docker login ghcr.io`。
>
> 这条链路的不变量由 `test/imagecompose.test.cjs`（72 项）固化：多架构构建、`packages: write` 权限、
> `latest` 只在打 tag 时更新、纯拉取编排不得含 `build:`、两条部署路径的环境变量/端口/挂载不得漂移，
> 并**反向验证** `scripts/check-compose.cjs` 确实能抓到「护栏被拆掉」（4 类畸形夹具必须判失败）。

## 数据备份与恢复

编辑模式底部有「备份」与「导入」两个按钮：

- **备份**：下载一个结构化备份文件（`navi-backup-<时间>.json`），内含 `format`（`navi-backup`）、`version`、`exportedAt`、完整 `config` 以及基于配置序列化计算的 `checksum`（SHA-256）。
- **导入**：选择备份文件后，前端先本地校验格式 / 版本 / 校验和；通过后弹出二次确认（显示将覆盖的导航项数量），确认后调用 `/api/backup/restore` 由后端再次完整校验并**原子写回**。
- **异常处理**：文件损坏（非 JSON）、格式不匹配、版本过高、校验和篡改、结构非法等情况均会被拦截并给出明确错误提示，且**绝不会破坏现有数据**——只有全部校验通过才会写回。
- **可移植**：备份文件是纯 JSON，可跨设备 / 跨部署迁移，恢复后数据与服务器当前状态保持一致（导入成功自动刷新）。

## 卡片图标来源与本地图床库

导航卡片的图标有两种来源，可单独使用，也可同时配置（本地图床优先）：

| 来源 | 存储字段 | 取值 | 说明 |
| --- | --- | --- | --- |
| **在线图标库** | `icon` | `jellyfin` / `selfhst:xxx` / `iconify:集:名` / 图片直链 | 不占本地磁盘，随卡片配置一起保存 |
| **本地图床库** | `logo` | `/uploads/<文件名>` | 图片实体存在服务器上传目录，可被多张卡片重复引用 |

> 渲染优先级：`logo`（本地图床）> `icon`（在线）> 字母回退图标。弹窗里的预览与卡片实际显示保持一致。

### 功能范围

| 能力 | 说明 |
| --- | --- |
| 上传即入库 | 「上传图片」与「批量选择图片」写入的图片都会进入图床库，不再是「用完即弃」 |
| 批量上传 | 一次可选 / 拖入多张（单张 ≤ 3MB）；前端按「字节预算 + 单批 20 张」分片提交，避免单请求过大 |
| 逐张校验 | 服务端对每张图做**文件头魔数**校验（防止伪造 data URL / 扩展名与内容不符）与体积校验，**部分失败不影响其余图片** |
| 库内复用 | 任意卡片都可通过「从图床库选择」点选同一张图片，无需重复上传 |
| 库内检索 | 按文件名实时过滤；缩略图懒加载；标注「使用中 N」并显示引用它的卡片名 |
| 库内清理 | 管理模式可勾选多张批量删除；仍被卡片引用的图片**默认拒绝删除**，需二次确认后强制删除 |
| 文件名可读 | 新上传图片按「原始文件名 slug + 随机后缀」命名（如 `jellyfin-3f9a2b11.png`），便于在库内辨认；纯中文 / 非法字符名自动回退为随机名 |

### 数据存储与调用逻辑

- **存储位置**：上传目录 `NAVI_UPLOAD_DIR`（默认 `public/uploads`，Docker 为 `/app/data/uploads`）。库内容**直接由文件系统推导**（文件名 / 体积 / 修改时间），不建数据库、不写索引文件——因此不会出现索引与文件不同步，也不给备份 / 恢复流程增加新状态。
- **访问地址**：图片通过 `/uploads/<文件名>` 访问，由静态文件服务映射到上传目录（自定义上传目录同样生效），并带长效缓存头。
- **引用关系**：卡片以 `item.logo = "/uploads/<文件名>"` 引用库内图片。「使用中」与删除保护都由服务端扫描当前配置实时计算，不额外持久化。
- **接口调用**：`GET /api/library` 列库（含引用统计与在线图标推荐，只读不写盘）→ `POST /api/library/upload` 批量入库 → `POST /api/library/delete` 删除（默认带引用保护）。三者均在启用密码保护时强制鉴权。
- **持久化要求**：上传目录必须挂载在持久卷上（Docker 已整目录挂载 `./data`），否则容器重建后图标会丢失。
- **与备份的边界**：备份文件（`/api/backup`）只包含 `config.json`，**不打包图片实体**。迁移 / 恢复后请一并拷贝 `data/uploads` 目录；`logo` 指向的图片缺失时卡片会自动回退为字母图标，不会报错。

### 批量上传流程

1. 进入编辑模式 → 底部保存栏点「图床库」（打开的是**管理模式**，标签页只保留本地图床库）。
2. 点「批量选择图片」多选文件，或把多张图片直接**拖入**投放区。
3. 前端先做本地预检：非 PNG/JPEG/GIF/WebP、或超过 3MB 的文件当场标注失败原因，不占用网络。
4. 通过预检的图片按「字节预算 6MB + 单批 20 张」自动分片，逐批串行 `POST /api/library/upload`；上传过程中显示进度条与「已处理 x / y 张」。
5. 服务端逐张做魔数校验并落盘，返回逐条结果；前端汇总为「成功 N 张，失败 M 张」并逐条列出失败原因（文件名 + 原因）。
6. 列表自动刷新，新图片立即可被任意卡片选用。

### 卡片上选择图标的流程

1. 编辑模式下新增 / 编辑卡片，弹窗内的「Logo（本地图床库）」与「在线图标」两行即为两种来源。
2. 点「从图床库选择」→ 弹窗以**选择模式**打开（标题为「选择图标」，标签页可用），缩略图网格点选即回填 `logo`，弹窗自动关闭，预览立即更新。
3. 点「图标库」→ 直接打开**在线图标库**标签页，默认展示内置推荐（复用服务发现的 33 个常见服务指纹，离线可用）；输入关键词回车即向 Iconify 公开 API 搜索（需联网），点选写入 `icon` 字段。
4. 「上传图片」也支持一次选多张：全部入库，本卡片直接选用第一张成功的，其余留在图床库供其它卡片复用。
5. 若同时配置了本地 Logo 与在线图标，界面会提示「本地 Logo 优先级更高」，点「清除」即可回退到在线图标。
6. 提交卡片 → 保存草稿 → 点「保存」随既有流程写入 `config.json`（不绕过既有校验，也不新增写盘入口）。

## 服务发现（自动识别端口 · 自动配图标 · 自动生成卡片）

参考 Docker-Panel 的思路实现：让散落在不同容器、不同端口上的服务，自动变成可点击的导航卡片。

### 使用步骤

1. 在 Docker 部署中挂载 Docker Socket（**可选但推荐**，否则只能发现本机监听端口）：
   ```bash
   docker run -d --name navi -p 8080:80 \
     -e NAVI_PASSWORD="你的强密码" \
     -e NAVI_CONFIG_PATH=/app/data/config.json \
     -e NAVI_UPLOAD_DIR=/app/data/uploads \
     -e NAVI_LAN_HOST=192.168.1.10 \
     -e NAVI_WAN_HOST=nav.example.com \
     -v $(pwd)/data:/app/data \
     -v /var/run/docker.sock:/var/run/docker.sock:ro \
     navi
   ```
   > ⚠️ 挂载 `docker.sock` 会让容器获得等价于宿主机 root 的 Docker 控制权，请仅在可信环境开启。不想挂载时可改用远程 API：`-e DOCKER_HOST_NAME=192.168.1.10 -e DOCKER_HOST_PORT=2375`。
2. 打开导航站 → 右上角「编辑」→ 底部「服务发现」。
3. 弹窗中会列出识别到的服务（图标、名称、描述、内网 / 外网地址），可按需修改每一项的名称与地址。
4. 勾选后点「加入选中项」（写入编辑草稿）→ 点底部「保存」写入服务器。

### 识别与匹配规则

| 环节 | 规则 |
| --- | --- |
| 端口识别 | Docker：读容器 `Ports` 中的宿主机映射端口（无映射时退回容器端口），忽略 `udp`；本机：Linux 读 `/proc/net/tcp*` 的 `LISTEN` 记录并反查进程名，非 Linux 退化为 `netstat` / `lsof` |
| 噪声过滤 | 过滤 40+ 系统进程（systemd / svchost / launchd 等）与高位随机端口；本机扫描只保留「指纹命中」或「常见 Web 端口」 |
| 图标匹配 | 依次尝试：内置服务指纹（匹配镜像名 / 容器名 / 进程名 / 端口）→ 在线探测 Dashboard Icons → selfh.st → 字母回退图标 |
| 内网地址 | `http://<NAVI_LAN_HOST>:<映射端口>`（端口为 80/443 时省略） |
| 外网地址 | 域名 → `https://<域名>`（不追加端口）；公网 IP → `http://<IP>:<端口>`；未配置则用内网地址兜底 |
| 默认勾选 | 仅勾选「运行中 且 非依赖容器 且 未忽略 且 不在导航中」的项 |
| 依赖容器 | 数据库 / 缓存类（MySQL、PostgreSQL、Redis、MongoDB 等）标注「依赖容器」，默认不勾选，可用「全选推荐项」之外的复选框手动选择 |
| 忽略 | 点行尾「划掉的眼睛」忽略某项，取消即恢复；忽略列表持久化在 `config.json` 的 `discovery.ignored` 字段 |

> **增量 & 安全**：服务发现只做只读扫描（`GET /api/discover`），结果仅写入当前编辑草稿，落盘依旧走既有「保存」流程；因此不会绕过既有校验，也不会影响既有数据。未接入 Docker 时接口仍返回 200，并给出可操作的原因提示。

## 内外网切换说明

- 点击右上角 **外网 / 内网** 按钮即可全局切换，选择会保存在浏览器本地
- 未手动选择过时自动识别：通过私网 IPv4（`10.x`、`172.16-31.x`、`192.168.x`）、`localhost`、IPv6 ULA（`fc00::/7`）或链路本地地址访问时，默认进入**内网模式**
- 切换后，配置了 `lanUrl` 的卡片右上角会亮起 `LAN` 角标

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/config` | 读取导航配置（应用环境变量覆盖） |
| `PUT /api/config` | 保存导航配置（带格式校验，原子写回 config.json） |
| `GET /api/backup` | 导出结构化备份（含 SHA-256 校验和，浏览器按附件下载） |
| `POST /api/backup/restore` | 校验并恢复备份（格式/版本/完整性/结构，通过后原子写回） |
| `POST /api/upload` | 上传单张卡片 Logo（base64 data URL，按文件头魔数校验类型与体积）；上传后同样进入本地图床库 |
| `GET /api/library` | 列出本地图床库（文件名 / 体积 / 修改时间 / 被哪些卡片引用）+ 在线图标推荐；只读不写盘 |
| `POST /api/library/upload` | 批量上传图标到图床库（`{files:[{name,dataUrl}]}`，单批 ≤ 20 张、请求体 ≤ 16MB），逐张校验、允许部分成功 |
| `POST /api/library/delete` | 从图床库删除图片（`{name}`）；仍被卡片引用时返回 409 + 引用清单，需 `{force:true}` 才强制删除 |
| `GET /api/discover` | 服务发现（只读）：识别 Docker 容器 / 本机监听端口 → 匹配图标 → 返回候选卡片；`?probe=0` 跳过图标在线探测 |
| `POST /api/login` | 密码登录，签发会话 Cookie（带 IP 限流） |
| `POST /api/logout` | 退出登录，吊销令牌并清除 Cookie |
| `GET /api/auth/status` | 查询是否启用密码保护及当前认证状态 |
| `GET /api/health` | 健康检查 |

## 静态效果预览页（preview.html）

需要给别人看效果、或不想启动服务就能展示界面时，直接双击打开根目录的 `preview.html` 即可：

- **纯静态、零依赖**：不启动 Node、不联网也能打开；不读写任何配置文件，所有交互都在浏览器本地完成。
- **含交互式界面复刻**：主题变量、卡片样式、图标解析与内网识别规则均取自项目源码，演示数据与 `config.json` 一致。可直接体验：搜索（`/` 聚焦）、日/夜切换、内外网切换、编辑模式、服务发现弹窗、图床库 / 在线图标库。
- **含真实截图画廊**：8 张截图全部来自 `test/` 下由 Playwright 在真实浏览器中自动生成的运行截图，点击可放大。
- **含功能、测试与部署说明**：427 项断言的分套件结果、接口清单、数据结构与三种部署方式。

> 该页面用于**展示与验收**，不具备后端能力（不写盘、不扫端口、不真实上传）。要体验完整功能请按下文启动服务或使用 Docker。

## 项目结构

```
├── Dockerfile                  # All-in-One 镜像（node:22-alpine，零依赖，含 /app/data 数据目录）
├── docker-compose.yml          # 【源码构建模式】双栈端口 + 整目录数据卷挂载（./data:/app/data）
├── docker-compose.image.yml    # 【纯拉取模式】无 build:，直接拉 ghcr.io 上的预构建镜像（二选一，靠 -f 切换）
├── .github/workflows/
│   └── docker-publish.yml      # 打 tag / 推 main 时自动构建多架构镜像并发布到 GHCR + 冒烟启动验证
├── .gitignore                  # 排除私有/运行时数据（config.json、uploads、data、backups 等），发布 GitHub 前必备
├── server.js                   # 静态托管 + /api/config 读写 + 备份/恢复 + 图床库 / Logo 上传 + 服务发现（仅 Node 内置模块）
├── discovery.js                # 服务发现模块：Docker Engine API / 本机端口扫描 / 服务指纹库 / 图标匹配 / 地址拼装
├── preview.html                # 静态效果预览页（界面复刻 + 真实截图画廊 + 功能/测试说明，浏览器直接打开）
├── docs/
│   ├── fnos-deploy-guide.html  # ★ 飞牛 fnOS 部署指南（存储路径约定 / 图形界面 Compose 限制 / 文件属主权限 / 故障排查 / 检查清单）
│   ├── image-deploy-guide.html # ★ 拉取镜像部署指南（包可见性 / 国内网络对策 / 架构匹配 / 升级回滚 / 排查表）
│   └── docker-guide.html       # 通用 Docker 部署指南（可用浏览器打印为 PDF）
├── scripts/
│   ├── migrate-to-dir-mount.sh # 从旧版单文件挂载平滑升级到整目录挂载的一键脚本
│   ├── check-compose.cjs       # ★ compose 自检：缩进折叠 / 密码护栏 / 纯拉取编排不得含 build: / 整目录挂载
│   ├── check-deploy.cjs        # ★ 部署判定探针：一条命令判断「线上跑的是不是最新代码」
│   ├── check-github-net.cjs    # GitHub 连通性诊断：区分「网络不通」与「令牌无权限」
│   └── publish-github.cjs      # 预检 → 提交 → 建仓 → 推送（凭据从环境变量或 .env 读，不进 argv）
├── test/
│   ├── run-all.cjs             # 一键跑完全部 13 个套件（自动拉起隔离实例，用临时 config/uploads）
│   ├── lib/hermetic.cjs        # 让 UI 套件真正自包含：外部图标 CDN 请求就地应答（否则网络抖动会伪装成 JS 错误）
│   ├── server.test.js          # 服务端集成测试（静态资源 / API / 校验 / 防护 / IPv6）
│   ├── auth.test.js            # 密码保护专项测试（拦截/登录/会话/伪造/过期/登出/限流/联合登录）
│   ├── backup.test.js          # 备份/恢复/上传专项测试（导出/校验/恢复异常/图片魔数/体积）
│   ├── discover.test.js        # 服务发现专项测试（纯函数 + 伪造 Docker API 端到端 + 图标探测协议/并发 + 鉴权）
│   ├── library.test.js         # 图床库专项测试（列表/批量上传部分成功/魔数校验/引用保护/删除防护/鉴权）
│   ├── ui.test.cjs             # 浏览器端 UI 测试（渲染/切换/搜索/编辑增删改/保存写回）
│   ├── ui-auth.test.cjs        # 登录页 UI 测试（用户名字段/错误提示/联合登录）
│   ├── ui-backup.test.cjs      # 备份/导入/Logo 上传 UI 测试（含非安全上下文导入回归）
│   ├── ui-discover.test.cjs    # 服务发现 UI 测试（自启动伪造 Docker API，覆盖勾选/忽略/加入/保存）
│   ├── ui-library.test.cjs     # 图床库 UI 测试（批量上传/搜索/点选回填/在线图标/批量删除/引用保护）
│   ├── checkdeploy.test.cjs    # 部署判定探针自检（正反双向验证 scripts/check-deploy.cjs）
│   ├── imagecompose.test.cjs   # ★ 镜像发布契约自检（多架构/权限/无 build:/两条路径不漂移 + 反向验证自检脚本）
│   └── ui-theme.test.cjs       # 日/夜模式切换 UI 测试
└── public/
    ├── index.html              # 单页入口（含编辑弹窗、图床库弹窗、退出按钮）
    ├── login.html              # 登录页（内联样式，未认证即可访问）
    ├── css/style.css           # 科技感暗色主题 + 编辑模式 / 图床库样式
    ├── js/app.js               # 渲染 / 切换 / 搜索 / 编辑 / 拖拽排序 / 备份导入 / 图床库
    ├── config.json             # 本机导航数据（编辑保存写回这里；已被 .gitignore 排除，勿提交）
    ├── config.example.json     # 开源示例配置（可直接作为初始化配置，可提交仓库）
    ├── uploads/                # 本地图床库（Logo 图片实体，已被 .gitignore 排除，勿提交）
    └── favicon.svg
```

> **docs/ 下另有已渲染好的 PDF**（`Navi-飞牛fnOS部署指南.pdf`、`Navi-Docker部署指南.pdf`），可直接发给别人。改了对应 HTML 后重新生成：
> `node test/make-pdf.cjs`（生成全部）或 `node test/make-pdf.cjs fnos-deploy-guide.html`（只生成一份）。需先设置 `NODE_PATH` 指向已安装 playwright 的目录。

## 验证 IPv6

```bash
# 通过 IPv6 访问
curl -g "http://[::1]:8080/api/health"
```

## 升级后：确认部署的确实是新代码

改完源码、重建镜像后，如果浏览器仍表现旧行为，最省事的排查方式是跑一次部署判定探针：

```bash
node scripts/check-deploy.cjs http://NAS的IP:端口 你的密码
```

它会检查 3 件外部可观测的事，并给出明确结论（退出码 0=新代码 / 1=旧代码 / 2=检查无法完成）：

| 检查项 | 判定依据 |
|---|---|
| HTML 缓存策略 | 新 `server.js` 下发 HTML 时带 `Cache-Control: no-cache`；旧版不带 |
| 前端资源版本号 | 新版按 `public/js`、`public/css` 的最新 mtime **自动推导** 10 位数字；旧版是 `index.html` 里的硬编码字面量（如下发值恰等于本地字面量，即为旧服务端） |
| 线上 `app.js` 内容 | 抓取 `/js/app.js`，确认含已知修复的标记代码，并与本地源码比对字节数 |

> `server.js` 与 `discovery.js` 在容器内、网页上看不到，探针会提示你用
> `docker exec navi wc -c /app/server.js /app/discovery.js /app/public/js/app.js`
> 自行比对，并列出本地源码的期望字节数。
> 用 `wc -c` 而不是 `ls -l`：前者每行只有一个短数字，不会像 `ls -l` 那样在窄终端里被折行搞乱。
>
> **密码不对或没给密码时探针不会中断**：它会退化为免登录判定，凭公开的 `/login.html`
> 响应头给 `server.js` 定性（旧 `server.js` 对 `.html` 不设 `Cache-Control`，新版设 `no-cache`），
> 并在结论里明确标注 `app.js` 那一项**未验证**、如何补全——判定不到就说不确定，绝不假装通过。

该探针自身的正反双向判定由 `test/checkdeploy.test.cjs` 固化保护（含「旧代码必须被判定为旧」的反向用例）。

## 自动化测试

**推荐：一条命令跑完全部 13 个套件（427 项断言）**

```bash
NODE_PATH=<已装 playwright 的 node_modules> node test/run-all.cjs
```

`run-all.cjs` 会自动用「临时 config + 临时 uploads」在 8633 端口拉起隔离实例，
跑完 4 个需要实例的套件后再依次跑 9 个自包含套件，最后汇总通过/失败数——**不会碰真实数据**。

排查单个功能时可按文件名过滤，只跑关心的套件（如 `ui-backup`、`discover`）：

```bash
NODE_PATH=<已装 playwright 的 node_modules> node test/run-all.cjs ui-backup
```

也可以按需单独运行：

```bash
# 1. 服务端集成测试（静态资源 / API / 校验 / 防护 / IPv6）
node test/server.test.js http://127.0.0.1:8632

# 2. 浏览器端 UI 测试（渲染 / 内外网切换 / 搜索 / 编辑增删改 / 保存写回）
#    使用本机 Edge/Chrome 内核，无需下载 Chromium
npm install playwright
node test/ui.test.cjs http://127.0.0.1:8632
node test/ui-auth.test.cjs
node test/ui-backup.test.cjs http://127.0.0.1:8632
node test/ui-theme.test.cjs http://127.0.0.1:8632

# 3. 密码保护专项测试（自动启动独立实例，不影响运行中的服务）
node test/auth.test.js

# 4. 备份/恢复/Logo 上传专项测试（自动启动隔离实例 + 临时目录，不触碰真实数据）
node test/backup.test.js

# 5. 服务发现专项测试（自动启动隔离实例 + 伪造 Docker API；不联网、不触碰真实数据）
node test/discover.test.js

# 6. 服务发现 UI 测试（自包含：内部自行启动伪造 Docker API 与隔离实例，无需先起服务）
node test/ui-discover.test.cjs

# 7. 图床库专项测试（隔离实例 + 临时目录：批量上传部分成功/魔数校验/引用保护/删除防护）
node test/library.test.js

# 8. 图床库 UI 测试（自包含：批量上传/搜索/点选回填/在线图标/批量删除/引用保护）
node test/ui-library.test.cjs

# 9. 部署判定探针自检（自包含：正反双向验证 scripts/check-deploy.cjs 能准确区分新旧代码）
node test/checkdeploy.test.cjs

# 10. 镜像发布契约自检（自包含：多架构构建 / GHCR 推送 / 纯拉取编排不得含 build: /
#     两条部署路径不漂移；并反向验证 scripts/check-compose.cjs 能抓到护栏被拆掉）
node test/imagecompose.test.cjs
```

> **关于「无 JS 错误」断言与网络**：多个 UI 套件都有一条「全程无 JS 错误」断言。
> 页面里的卡片图标指向公共 CDN，而 Chromium 在图片加载失败时会发一条
> `Failed to load resource: net::ERR_CONNECTION_CLOSED` 的 console error ——
> 于是**外部 CDN 抖一下就会被误报成「代码有 Bug」**（实测偶发过一次）。
> `test/lib/hermetic.cjs` 统一解决：非本机请求就地应答成一张 1×1 PNG，把套件变成真正自包含；
> 同时把「资源加载失败」类消息排除出 JS 错误统计——它不是代码缺陷，是网络事实。
> 注意它只替换**响应**、不替换 URL，所以「图标地址是否正确」的断言依然有效。

## License

MIT
