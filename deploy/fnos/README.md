# Navi 导航站 · fnOS 应用包（`.fpk`）

把 Navi 打包成飞牛 fnOS 可以用「应用中心 → 手动安装」直接装的安装包。
装完自带启动 / 停止 / 升级 / 卸载与桌面图标，用户不必手写 compose。

> 面向**构建者**。只是想装的话看 `docs/fnos-deploy-guide.html` 第 16 节。

---

## 1. 依赖

| 依赖 | 用途 | 获取方式 |
| --- | --- | --- |
| **fnpack** | 飞牛官方打包工具（Go 单文件二进制，约 3.9MB） | 见下方下载地址表 |
| **Node.js** | 跑本目录的构建脚本（`scripts/build-fpk.cjs`） | 项目本来就要求 Node 18+ |
| **Playwright**（可选） | 只在需要**重新生成图标**时用到 | 见 `README.md` 的测试说明 |

fnpack 下载地址（按平台取其一）：

```
https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64     → 存为 fnpack.exe
https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64
https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-arm64
https://static2.fnnas.com/fnpack/fnpack-1.2.3-darwin-amd64
https://static2.fnnas.com/fnpack/fnpack-1.2.3-darwin-arm64
```

下载后放到本目录的 `tools/` 下（已被 `.gitignore` 忽略，不入库）：

```bash
mkdir -p deploy/fnos/tools
# Windows 版必须命名为 fnpack.exe，构建脚本按这个名字找
mv fnpack-1.2.3-windows-amd64 deploy/fnos/tools/fnpack.exe
chmod +x deploy/fnos/tools/fnpack-*          # Linux / macOS
```

构建脚本按 **`FNPACK` 环境变量 → `deploy/fnos/tools/` → `PATH`** 的顺序查找，找不到会明确报错而不是静默出个坏包。

---

## 2. 目录结构

```
deploy/fnos/
├── manifest                  # 包元信息（INI，必须 LF 换行）
├── ICON.PNG                  # 64×64 应用图标
├── ICON_256.PNG              # 256×256 应用图标
├── config/
│   ├── privilege             # 运行身份（package 用户）
│   └── resource              # 声明这是一份 docker-project 编排
├── app/                      # 打进 app.tgz 的内容（路径基准就是这个目录）
│   ├── ui/
│   │   ├── config            # 桌面图标 / 入口定义
│   │   └── images/           # 入口图标（icon_64 / icon_256）
│   └── docker/
│       ├── docker-compose.yaml   # 应用中心据此起停容器
│       └── bootstrap/config.json # 首次安装的初始配置模板
├── cmd/                      # 生命周期钩子（无扩展名的 shell 脚本）
│   ├── main                  # 必需：status（exit 0 运行中 / 3 未运行；拿不到 Docker 时用端口+HTTP 兜底）
│   ├── install_init / _callback
│   ├── upgrade_init / _callback
│   ├── uninstall_init / _callback
│   └── config_init / _callback
├── wizard/
│   ├── install               # 安装向导（JSON）
│   └── config                # 装完后的「应用设置」（JSON）
└── dist/                     # 产物输出（.gitignore 忽略）
```

---

## 3. 构建

```bash
# 1)（可选）重新生成图标——改了品牌色 / 换了图形才需要
NODE_PATH=<含 playwright 的 node_modules> node scripts/build-fpk-icon.cjs

# 2) 一条命令出包：调 fnpack → 规范化属主权限 → 出厂校验 → 落到 dist/
node scripts/build-fpk.cjs
```

产物：`deploy/fnos/dist/navi-<版本>.fpk`。

### `--skip-build`：本机 Node 不能派生子进程时

若脚本报 `无法调用 fnpack（EBUSY）`（某些受限环境禁止 Node 创建子进程），手动跑一次 fnpack 再让脚本接管后续步骤：

```bash
cd deploy/fnos && ./tools/fnpack.exe build && cd ../..
node scripts/build-fpk.cjs --skip-build
```

> 注意：`fnpack build` 把 `navi.fpk` 写在**当前工作目录**，不是 `-d` 指定的目录，所以要先 `cd` 进 `deploy/fnos`。

---

## 4. 构建脚本做了哪些额外的事

`fnpack` 只负责按规则打 tar.gz，下面这些它不管，`scripts/build-fpk.cjs` 补齐：

1. **规范化属主与权限** —— fnpack 在 Windows 上打出来的包里文件属主是空的、权限一律 `0666`、`cmd/` 下的脚本没有可执行位。飞牛解包后设置目录权限时会报「设置目录权限失败」。脚本统一改为：属主 `root:root`、目录 `0755`、`cmd/` 下脚本 `0755`、其余 `0644`。
2. **manifest 换行修正** —— fnpack 1.2.3 在 Windows 上会把 `manifest` 重写成 CRLF，而飞牛按行解析这份 INI，值尾残留的 `\r` 会让 `version` / `appname` 之类的字段对不上。脚本统一改回 LF。
3. **出厂校验** —— 全部通过才把产物复制到 `dist/`：
   - 必需成员齐全（`manifest` / `app.tgz` / `cmd/` / `config/privilege` / `config/resource` / `wizard/` / 两张图标）
   - `manifest.checksum` 与 `app.tgz` 的**实际 MD5** 一致
   - `version` 是 `X.Y.Z`、`appname` 是 `navi`
   - `manifest` 里没有 CR
   - `app.tgz` 内含 `ui/config`、`ui/images/icon_*.png`、`docker/docker-compose.yaml`、`docker/bootstrap/config.json`
   - `app/ui/config` 是合法 JSON 且 `.url` 里至少有一个入口
   - compose 里**不得出现 `:latest`**，且镜像标签必须**等于** `manifest.version`
   - `cmd/install_init` 与 `cmd/upgrade_init` 里**没有非零退出**，且都以 `exit 0` 结束（安装 / 升级前的检查只提示、不阻断）
   - `cmd/main` 用 `docker inspect` 判状态时，**必须同时保留端口 + HTTP 兜底**
   - 包里没有混进 `.DS_Store`

   最后一条特别重要：**版本升了却忘了改 compose 里的镜像标签**，装出来的包会去拉上一版镜像——装的时候一切正常，只有行为不对。

---

## 5. 关键约定与踩过的坑

### 路径基准有两套，别混

| 位置 | 内容 | 基准 |
| --- | --- | --- |
| fpk 外层 | `manifest`、`cmd/`、`config/`、`wizard/`、图标 | 包根目录 |
| `app.tgz` 内部 | 源工程 `app/` 下的内容 | **`app/` 目录本身** |

所以 `app.tgz` 里看到的是 `ui/config`、`docker/docker-compose.yaml`，**不是** `app/ui/config`。按后者去校验必然报「缺少文件」。

### fnOS 注入的环境变量

生命周期脚本与 compose 里可以直接用（不需要自己探测）：

| 变量 | 含义 |
| --- | --- |
| `TRIM_APPDEST` | 应用安装目录 |
| `TRIM_PKGVAR` | **运行时数据目录**（持久化数据放这里） |
| `TRIM_PKGETC` | 配置目录 |
| `TRIM_SERVICE_PORT` | manifest 里 `service_port` 的当前值 |
| `TRIM_APPNAME` / `TRIM_APPVER` | 应用名 / 版本 |
| `TRIM_TEMP_LOGFILE` | 出错日志文件——脚本失败时把原因写进去，应用中心会展示 |

自定义向导字段的变量名建议加 `wizard_` 前缀；**禁止用 `TRIM_` 前缀**（会被当成系统保留字段）。

### docker-project 的起停不由我们管

声明了 `config/resource` 的 `docker-project` 之后，**启动 / 停止由应用中心负责**（它自己调 compose），`cmd/main` 只需要回答「现在是否在运行」。判定要分两级：

```sh
# ① 能问 Docker 就问（最准确，能区分 running / exited / 容器不存在）
docker inspect -f '{{.State.Status}}' navi-fnos   # running → exit 0

# ② 问不到时（命令不在 PATH / socket 不可达 / 执行身份没有权限）不能直接报「未运行」，
#    否则应用中心会一直显示已停止。退回与权限无关的探测：
#    端口在监听 + HTTP 确实有应答
```

### 生命周期脚本只提示、不阻断 ⚠️

**这是 v1.1.1 安装失败的真因**，写下来免得再犯。

当时的 `install_init` 用 `docker info` 当闸门，失败就 `exit 1`：

```sh
# ❌ 错的写法
if ! docker info >/dev/null 2>&1; then
    echo "Docker 服务当前不可用，请先在应用中心启动 Docker。" > "$LOG"
    exit 1
fi
```

结果在 **Docker 明明可用**的机器上，应用中心弹出「无法安装 navi：Docker 服务当前不可用」，安装被直接中断，用户也没有办法绕过。

原因不是 Docker 坏了，而是**生命周期脚本的执行身份与环境，和用户在 SSH 里看到的不是一回事**：`PATH` 更窄、没有交互式 shell 的 `DOCKER_HOST` / docker context、可能不在 `docker` 组、`HOME` 也不同。任何「探测外部服务」的判定在这种环境里都天然会误报。

所以现在的规则是：

- `install_init` / `upgrade_init` **不做任何阻断式判定**，永远 `exit 0`，只把事实写进 `TRIM_TEMP_LOGFILE` 与标准错误（应用中心会统一收集）。
- 想知道到底为什么连不上，就把 `docker info` 的**原文**记进日志（保留诊断能力），但不拿它当闸门。
- 判断 Docker 是否在，用 `[ -S /var/run/docker.sock ]` —— `stat` 一个 socket 文件不需要任何权限，不会误判。
- 命令一律**先查 `PATH`、再查 `/usr/bin`、`/usr/local/bin`**：生命周期环境的 `PATH` 窄，只认 `PATH` 会平白多出一批「命令不存在」的假故障。
- 真正的失败交给飞牛：docker-project 是它负责拉起的，它会报自己的错。

这三条已经写进 `scripts/build-fpk.cjs` 的出厂校验，改回阻断式写法**打不出包**。

### 组命令里别用 `[ ... ] && echo` ⚠️

**这是 v1.1.1 第二次安装失败的真因**，比上面那条更隐蔽 —— 因为文件其实写成功了。

```sh
# ❌ 错的写法
{
    echo "NAVI_PASSWORD=${navi_password}"
    [ -n "${navi_site_title:-}" ] && echo "SITE_TITLE=${navi_site_title}"
    [ -n "${navi_lan_host:-}" ] && echo "NAVI_LAN_HOST=${navi_lan_host}"
} > "$ENV_FILE" || { echo "写入环境变量文件失败"; exit 1; }
```

`[ -n "$X" ] && echo ...` 在条件为假时**退出码是 1**，而 `{ ...; }` 的退出码取**最后一条命令**。
向导里「内网地址基址」的默认值就是空 → 整组返回 1 → 被 `||` 判成「写文件失败」并 `exit 1`。
文件早已写好，安装却被判失败。

```sh
# ✅ 对的写法：一律用 if，退出码恒为 0
{
    echo "NAVI_PASSWORD=${navi_password}"
    if [ -n "${navi_site_title:-}" ]; then echo "SITE_TITLE=${navi_site_title}"; fi
    if [ -n "${navi_lan_host:-}" ]; then echo "NAVI_LAN_HOST=${navi_lan_host}"; fi
} > "$ENV_FILE" || { echo "写入环境变量文件失败"; exit 1; }
```

出厂校验会拦下这种写法。

### 用户输入一律走 compose 变量插值 —— `env_file` 是陷阱 ⚠️

**这是本项目最贵的一条教训。** v1.1.1 连续三次安装失败，报错都是 docker compose 自己抛的：

```
env file /vol1/@appdata/navi/navi.env not found: stat /vol1/@appdata/navi/navi.env: no such file or directory
```

compose 对 `env_file` 是**硬依赖** —— 文件不在，直接报错并**整包回滚**。

而「提前把文件写出来」的每一个时机都赶不上。这不是推测，是 `/tmp/navi-lifecycle.log` 实测出的顺序：

| 时机 | 写 `@appdata/navi` | 说明 |
|---|---|---|
| `install_init` | ❌ `pkgvar_writable=no` | 跑得最早，但那时 `@appdata/<app>` **尚未创建/授权** |
| ↓ 飞牛拉起 docker-project（compose） | — | **失败即整包回滚 —— 后面两步根本没机会执行** |
| `install_callback` | ✅ `pkgvar_writable=yes` | 轨迹里**一行都没有** → 它压根没被调用过 |
| `cmd/main` 的 `start` | ✅ | 同上 |

同一次安装、同一台机器上的两组轨迹，把因果钉死了：

```
navi/install_init     ... pkgvar_writable=no     ← 最早的一步，写不成
navi/install_callback ... pkgvar_writable=yes    ← 只有安装成功时才会出现这一行
```

所以此前「三层保险」的**整个前提就是错的**：前两层赶不上，第三层排在 compose 后面同样赶不上。

**改对了的做法**：把用户输入**直接交给 compose 做变量插值**，彻底不碰文件。

```yaml
environment:
  - NAVI_PASSWORD=${wizard_navi_password:-}
  - SITE_TITLE=${wizard_navi_site_title:-}
```

**为什么它一定拿得到值**：飞牛确实会把环境变量交给 docker compose —— 上面那句报错里的
`${TRIM_PKGVAR}` 已被正确展开成 `/vol1/@appdata/navi`，这就是实证（否则报错里会是一串未展开的变量名）。
向导字段与 `TRIM_*` 出自同一批环境。**现在的 compose 里已经不写 `env_file` 了。**

> ⚠️ 变量未定义时 `${VAR:-}` 会得到**空串**，而空密码意味着站点是开放访问的。
> 所以 `cmd/install_callback` **仍会**把向导值写一份到 `${TRIM_PKGVAR}/navi.env`
> （给手动部署或"以后时机变了"留通路），但它只是**备份**，compose 不再依赖它。
> `cmd/main` 的 `start` 与 `install_init` 里那两层写入也一并留作尽力而为，写不成不会再影响安装。

出厂校验盯着两条（都用**上一版 compose 反向验证**过，确认拦得住）：
compose 必须含 `${wizard_navi_password}` 插值；compose 里若出现 `env_file`，**必须**同时声明
`required: false`（Docker Compose 2.24+ 起支持，本机 NAS 实测 v2.40.3）。

### 向导字段一律加 `wizard_` 前缀

官方文档写的是「`field` 成为同名环境变量」，但同时**建议自定义字段用 `wizard_` 前缀**。
早期版本用的是 `navi_` 前缀，为了不因命名差异丢掉用户填的密码，现在的脚本**两种都认**：

```sh
WIZ_PW="${wizard_navi_password:-${navi_password:-}}"
```

### 取不到向导密码时降级，不要中止安装

「密码为空 → `exit 1`」的老写法，结果是用户面对一个完全无从判断的失败。
现在的顺序是：向导值 → `install_init` 已写好的那份 → 现场生成随机密码并写 `PASSWORD.txt`。
**站点任何时候都不会裸奔**（永远有密码），最坏情况只是「密码不是自己填的那个」——
看 `PASSWORD.txt` 就能用，之后还能在「应用设置」里改。

### 日志一律用 `>>` 追加

`TRIM_TEMP_LOGFILE` 在同一个脚本里可能被写多次。用 `>` 会把前面写的内容清掉，
真正的原因句会被最后一句提示覆盖，排查时看不到关键信息。

### 数据放在 `TRIM_PKGVAR`，且刻意不随卸载删除

- 数据目录：`${TRIM_PKGVAR}/data`（`config.json` + `uploads/`），compose 里整目录挂到 `/app/data`
- 密码等敏感配置写在 `${TRIM_PKGVAR}/navi.env`，用 `umask 077` + `chmod 600`
- `uninstall_callback` **只记日志、不删数据**——升级 / 重装 / 误卸载都不至于把导航数据弄没，用户要清理得自己动手
- `config_callback` 是**逐项合并**：只改标题时不会把密码清掉（密码字段留空 = 保持不变）

### 容器名与端口刻意避开已有部署

包内 `container_name` 是 `navi-fnos`（手工部署通常叫 `navi`），默认端口 `8080`。
因此两种部署可以并存，互不覆盖。

### 别自己手改生成物

- `dist/` 下是构建产物，删了重跑即可
- `app/ui/images/icon_*.png` 与两张 `ICON*.PNG` 由 `scripts/build-fpk-icon.cjs` 生成，改了要重跑脚本，别手改

---

## 6. 发版顺序（重要）

`.fpk` 里的镜像标签是**固定版本**，所以**必须先有镜像、再有包**：

1. 改四处版本号（`server.js` / `public/js/app.js` / `test/status.test.js` / `CHANGELOG.md`），改 `deploy/fnos/manifest` 的 `version` 与 `app/docker/docker-compose.yaml` 里的镜像标签
2. 全量回归：`NODE_PATH=<...> node test/run-all.cjs`
3. 推 `main`，打 `vX.Y.Z` 标签并推送 → CI 构建并发布 `ghcr.io/damisunshine/navi-homepage:X.Y.Z`（同时推进 `X.Y` 与 `latest`）
4. 去 GHCR 确认该标签真的存在（用匿名令牌验，别只看 CI 绿灯）
5. **然后**才 `node scripts/build-fpk.cjs` 出包

顺序颠倒的后果是：包能装、能启动，但 `docker pull` 拉不到那个标签，容器起不来。

> 顺带一提：`push main` 只产 `edge`，只有 `v*.*.*` 标签才会更新 `X.Y.Z` / `X.Y` / `latest`。

---

## 7. 安装失败时怎么定位

**先记住一件事：安装失败会被完整回滚。** 所以事后去看 `/vol1/@appcenter/navi/`
与 `/vol1/@appdata/navi/` 通常是「都不存在」—— 这不代表「从来没装过」，只是被清掉了，
**没有任何残留要清理**（手工部署的同名容器也不受影响）。

### 第一步：分辨报错是谁发的

| 报错文案 | 出处 | 含义 |
|---|---|---|
| `Docker 服务当前不可用…` | 本包 `cmd/install_init`（v1.1.1 早期版才有） | 旧版用 `docker info` 当闸门，已改为只提示 |
| `env file …/navi.env not found` | **docker compose 本身** | compose 曾把 `env_file` 当硬依赖；**现已移除该依赖，不可能再出现**（见第 5 节） |
| `写入环境变量文件失败：…` | 本包 `cmd/install_callback` | 写文件真的失败了（**不是** `{}` 退出码那个 bug）。现在它只在安装**成功之后**执行、且只是备份写入，失败不影响站点运行 |
| 其他 | 飞牛应用中心 | 多为校验不过（manifest / 图标 / JSON 格式） |

判断依据很简单：**这句话是从哪个文件里 echo 出来的** —— 全仓 grep 一下就能确认归属。

### 第二步：拿到日志

应用中心的失败弹窗里能展开日志；磁盘上则找 `TRIM_TEMP_LOGFILE` 指向的文件。本包的脚本
都会往这个文件里写诊断线索（且**日志一律用 `>>` 追加**，不会被互相覆盖），关键几行长得像：

```
提示：未看到 /var/run/docker.sock …
提示：本脚本环境下 docker info 未能连通 Docker（不影响安装…）
      <docker info 的原文>
已预先创建 /vol1/@appdata/navi/navi.env（密码取自安装向导）。   ← 老版写法，现已不是关键路径
提示：无法创建数据目录 /vol1/@appdata/navi …   ← ⚠️ 在 install_init 阶段看到这句是**正常的**：
                                                  那时 @appdata/<app> 还没建（实测 pkgvar_writable=no）。
                                                  它**不再影响安装** —— 密码改由 compose 变量插值注入
--- 诊断 ---
运行身份 TRIM_RUN_USERNAME=… / 应用用户 TRIM_USERNAME=…
数据目录 TRIM_PKGVAR=/vol1/@appdata/navi → 实际使用 /vol1/@appdata/navi
收到的向导字段：TRIM_APPNAME TRIM_PKGVAR … wizard_navi_password …
```

最后一行最有用：**「收到的向导字段」**里有没有 `wizard_navi_password`，直接决定密码从哪来。

**trace 文件（第三轮新增，最可靠的一手证据）**：安装失败会**整包回滚**，`@appdata/navi` 连同里面的
日志一起消失。所以 `install_init` / `install_callback` / `cmd/main` 都会把一行事实追加到

```
/tmp/navi-lifecycle.log
```

它不随回滚消失，一行一次调用，形如：

```
navi/install_init     2026-09-29 10:07:06 status=INSTALL run=docker-navi(uid=913) appuser=docker-navi pkgvar=/vol1/@appdata/navi pkgvar_writable=no
navi/install_callback 2026-09-29 10:31:12 status=INSTALL run=docker-navi(uid=913) appuser=docker-navi pkgvar=/vol1/@appdata/navi pkgvar_writable=yes
```

这两行是**同一次安装**上真实取到的，信息量极大：

| 看什么 | 怎么判 |
|---|---|
| **`install_callback` 这一行在不在** | **不在 = 安装已失败并回滚**（compose 排在它前面）。这是最快的定性判据 |
| `pkgvar_writable=` | `install_init` 阶段**恒为 `no`**（目录还没建），这是正常的；到 `install_callback` 才变 `yes` |
| `run=` | 执行身份。`docker-navi(uid=913)` 即 `config/privilege` 里的 `run-as` |

（`status` 分支刻意不记：应用中心会轮询，会把文件撑大。）

### 第三步：环境侧确认（只读）

```bash
docker compose version                      # 本机实测 v2.40.3（支持 env_file 的 required: false）
ls -la /vol1/ | head -20                    # 存储空间布局（@appdata 为 0755 root:root，属正常）
docker ps -a --filter name=navi-fnos        # 有没有残留容器占着 8080
ls -ld /vol1/@appdata/docker-komga          # ★ 对照已装成功的应用：属主就是它自己
```

> 最后那条对照命令很关键：它证明 `@appdata/<app>` **确实会被创建并授权给应用用户** ——
> 只不过时机在 `install_init` **之后**。这也正是为什么"提前写文件"这条路的每一个时机都赶不上。

