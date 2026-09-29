# 更新日志

本文件记录 Navi 导航站的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 镜像标签与版本号的关系：打 `v1.2.3` 的 tag 会推送 `1.2.3` / `1.2` / `latest` 三个镜像标签
> （semver 会剥掉前缀 `v`，所以 `docker pull …:v1.2.3` 是不存在的标签）。
> 本文件里的版本号与 `server.js` 的 `APP_VERSION` 保持一致。

## [1.2.0] - 2026-09-29

本版为**用户反馈修复**而发：编辑模式下分组可整体拖动。运行时代码有变更
（`public/js/app.js`、`public/css/style.css`），**必须更新镜像**才会生效。

> 打 `v1.2.0` 标签会推送 `1.2.0` / `1.2` / `latest` 三个镜像标签。

### 修正

- **编辑模式下分组无法整体拖动**（用户反馈）：原先只有卡片带 `draggable` 属性，分组的位置只能靠
  「删掉重建」来调整。现在**按下的位置决定拖什么** ——
  按在分组标题栏（或标题栏里的拖动手柄）时**临时**给该分组加上 `draggable`，松开或拖拽结束立即收回；
  按在卡片上仍是拖卡片（卡片离按下点更近，天然优先）；按在标题栏的「重命名 / 添加 / 删除」按钮上
  两边都不武装，按钮点击照常生效。
  分组排序结果按 `data-gi` 下标（而不是分组名 —— 名字允许重复，下标不会）写回草稿，随「保存」落盘。
  拖链接建卡与站内拖拽之间加了显式互斥，三方不抢事件。
  新增 20 项断言（`ui.test.cjs` 103 → 123），其中三项专门盯「不冲突」：按钮上按下不武装、
  一次只武装一个分组、松开即收回。

### 变更

- 全量回归基线 **961 → 981 项断言**（19 个套件 / 0 失败）。README、`preview.html`、
  `docs/overview.html`、`docs/site.html`、`docs/showcase.html`、`docs/roadmap.html`、
  `docs/docker-guide.html` 与发布包新鲜度校验里的数字同步更新，旧值一律进 `mustNots`。

> ⚠️ 本次改的是**运行时代码**（`public/js/app.js`、`public/css/style.css`，都在镜像里），
> 所以要拿到这个修复必须**更新镜像**：只重装安装包不够。
> 版本号四处硬编码（`server.js` / `public/js/app.js` / `test/status.test.js` / 本文件）已一并升到
> `1.2.0`，`deploy/fnos/manifest` 与包内 compose 的镜像标签同步指向 `1.2.0`。

## [1.1.1] - 2026-09-28

本版为 **fnOS 原生安装包** 而发：新增 `.fpk` 打包工程，飞牛 NAS 用户可在应用中心一键安装 /
升级 / 卸载，不必手写 compose。**运行时代码无行为变更**（仅版本号与引用地址更新）。

> 打 `v1.1.1` 标签会推送 `1.1.1` / `1.1` / `latest` 三个镜像标签。

### 新增

- **fnOS 应用安装包（`.fpk`）**：`deploy/fnos/` 是完整的打包工程 —— `manifest`、`config/privilege`、
  `config/resource`、`app/ui/config`、`app/docker/docker-compose.yaml`、`cmd/` 下九个生命周期脚本、
  `wizard/install|config` 图形化向导与两套图标。`scripts/build-fpk.cjs` 负责调用官方 `fnpack` 出包、
  把 Windows 下打出来的属主/权限规范化成 Linux 友好的形态，再做一轮出厂校验
  （必需成员、`manifest.checksum` 与 `app.tgz` 实际 MD5、版本号格式、`app.tgz` 内关键文件、
  `ui/config` 是否为合法 JSON、compose 不得出现浮动标签且镜像标签必须等于包版本），
  全部通过才把产物落到 `deploy/fnos/dist/`。
  安装时在向导里设站点密码、标题与监听端口；数据落在应用数据目录，**卸载不删**；
  桌面图标以 iframe 直达站点。
- **品牌图标生成脚本**：`scripts/build-fpk-icon.cjs` 用 Playwright 渲染 64 / 256 两个尺寸的
  `ICON.PNG` 与 `app/ui/images/icon_*.png`，与站点 favicon 同源，改品牌色后重跑即可。

### 变更

- **仓库 / 镜像地址随 GitHub 用户名迁移**：`mijunyi` → `DamiSunshine`。README、compose、
  `.env.example`、`LICENSE` 与全部文档共 58 处引用一并更新
  （`docs/roadmap.html` 里 2026-09-19 的审计快照按原样保留，以维持对照价值）。
  新的镜像地址是 `ghcr.io/damisunshine/navi-homepage`。
  旧命名空间 `ghcr.io/mijunyi/navi-homepage` **已冻结在 1.1.0，不再更新**，请改用新地址。
- 包内 compose 固定使用**版本标签**（不用 `latest`）：避免"装了新版却拉到旧镜像"这种装的时候
  一切正常、只有行为不对的故障。

### 修正（2026-09-29）

- **fnOS 上安装被误判失败、且无法绕过**：`cmd/install_init`（及同源的 `cmd/upgrade_init`）
  原先拿 `docker info` 当闸门，失败即 `exit 1` 并提示「Docker 服务当前不可用」，
  结果是**在 Docker 明明正常的机器上，安装被直接判失败**（用户无从绕过）。
  根因是生命周期脚本的执行身份 / 环境 ≠ 用户 SSH 里的环境（`PATH` 更窄、没有 docker context、
  可能不在 `docker` 组、`HOME` 不同）——这类外部依赖探测天然会误报。
  现改为**只提示、不阻断**：两个脚本永远 `exit 0`，只把事实与 `docker info` 的失败原文写进
  `TRIM_TEMP_LOGFILE` 保留诊断；判 Docker 在不在改用 `[ -S /var/run/docker.sock ]`（`stat` 不需要权限）。
- **应用中心把运行中的应用显示成「已停止」**：`cmd/main` 的 `status` 原先只看 `docker inspect`，
  一旦同样拿不到 Docker 就会误报未运行。现增加与权限无关的兜底 —— 端口在听 **且** HTTP 有应答
  即视为运行中。
- **fnOS 上安装失败：`env file ... not found`**（上面那条修掉之后暴露出的下一个问题）。
  compose 的 `env_file` 指向 `${TRIM_PKGVAR}/navi.env`，而该文件原本只由 `install_callback` 创建 ——
  只要应用中心拉起 docker-project 的时点早于它，docker compose 就报
  `env file /vol1/@appdata/navi/navi.env not found` 并**令整个安装失败**。
  现由流程最早的 `install_init` 先落一份（拿得到向导密码就用，拿不到用随机密码并留
  `INITIAL_PASSWORD.txt`），`install_callback` 随后覆盖。
- **fnOS 上安装失败：`install_callback` 误判「写环境变量文件失败」**（同一场景下的第二个真因）。
  脚本里用 `{ ...; } > "$ENV_FILE" || { echo "写入失败"; exit 1; }` 包住写文件，
  而组内有 `[ -n "$X" ] && echo ...` —— 条件为假时退出码是 1，`{ ...; }` 取的正是最后一条命令的退出码。
  向导里「内网地址基址」默认留空，于是整组返回 1、被误判成失败并 `exit 1`；
  **文件其实早就写好了**。现已全部改用 `if` 语句，退出码恒为 0。
- **向导字段改用 `wizard_` 前缀**（`wizard_navi_password` 等，官方建议的自定义字段前缀）。
  为避免升级/重装时读不到值，脚本**同时兼容**旧的 `navi_` 前缀。
- **取不到向导密码时降级而不是中止安装**：原先是「密码为空 → `exit 1`」，用户面对的是一个
  完全无从判断的失败。现在依次取「向导值 → 已写好的那份 → 随机密码（落 `PASSWORD.txt`）」，
  **站点任何时候都不会裸奔**。
- 日志写入统一改为追加（`>>`）：同脚本内多处写 `TRIM_TEMP_LOGFILE` 时，`>` 会把真正的原因句覆盖掉。
- **`env_file` 的创建改为「三层保险」**（第三轮加固）。`install_init` 预先创建这一步，依赖
  「飞牛调用它时 `${TRIM_PKGVAR}` 已存在且可写」，而这一点**官方文档并未保证** ——
  社区生产级 fpk 的注释里明确写着「`install_init` 被调用时 `@appdata` 可能尚未挂载或创建」；
  本机实测 `/vol1/@appdata` 是 `0755 root:root`，**非 root 的包用户无法在其中新建目录**。
  因此在 `cmd/main` 的 `start` 分支补了第三层：文件缺失就补一份、**已存在则一律不动**
  （`start` 一定发生在安装完成之后，那时目录必然已存在且可写）。
  三层顺序：`install_init` → `install_callback`（写入向导真实值）→ `main start`（最后救援）。
- **新增诊断轨迹 `/tmp/navi-lifecycle.log`**：安装失败会被飞牛**整包回滚**，`@appdata/navi`
  连同里面的日志一起消失 —— 前两轮排查都因为「什么都没留下」而只能靠猜。
  现在 `install_init` / `install_callback` / `cmd/main` 各自追加一行事实（执行身份、数据目录是否可写、
  向导字段名、各脚本先后顺序），该文件不随回滚消失。
- 上述各条**全部**加入了 `scripts/build-fpk.cjs` 的出厂校验（构造成正向/可判定的断言：
  禁用 `[ ... ] && echo`、禁用覆盖式日志写入、`install_init` 必须创建 `env_file` 指向的文件、
  `cmd/main` 必须能兜住 `env_file`、三个关键脚本必须保留诊断轨迹、
  `install_callback` 必须有随机密码兜底），并以旧版本为坏样本做过反向验证 ——
  **旧脚本会一次性触发 4 条护栏、打不出包**。
- **【根治】`env_file` 是硬依赖 —— 前三轮的修复方向本身就是错的**。
  上面那条「三层保险」依赖一个前提：**能抢在 compose 拉起之前把 `navi.env` 写出来**。
  实测证明这个前提不成立，`/tmp/navi-lifecycle.log` 把顺序钉死了：

  ```
  navi/install_init     ... pkgvar_writable=no     ← 最早的一步，@appdata/navi 尚未创建/授权
  navi/install_callback ... pkgvar_writable=yes    ← 只有安装成功时才会出现这一行
  ```

  失败的那几次，轨迹里**只有 `install_init` 的行**：飞牛在 `install_init` 之后即拉起
  docker-project，compose 一报错就整包回滚 —— `install_callback` 与 `cmd/main` 的 `start`
  **根本没被调用过**。所以前两层赶不上，第三层排在 compose 后面同样赶不上。

  真正的解法是**让 compose 不依赖任何文件**：把用户输入交给 compose 做**变量插值**直接注入 ——

  ```yaml
  environment:
    - NAVI_PASSWORD=${wizard_navi_password:-}
  ```

  依据来自报错信息本身：`env file /vol1/@appdata/navi/navi.env not found` 里的 `${TRIM_PKGVAR}`
  **已被正确展开**，证明飞牛确实把环境变量交给了 docker compose；向导字段与 `TRIM_*` 出自同一批环境。
  现在包内 compose 里**不再出现 `env_file`**。`install_callback` 仍会把向导值写一份到 `navi.env`
  （作为手动部署与"将来时机变了"的备份），但**它已不在关键路径上**。
  实机验证：新包装上后应用正常留存、容器 `navi-fnos` 运行中，访问首页返回 **302 跳登录页**
  （= 密码已生效），`navi.env` 里的值与安装向导里填的完全一致。
- **出厂校验相应改写为两条正向断言**（并以上一版 compose 为坏样本反向验证）：
  compose 必须含 `${wizard_navi_password}` 插值；compose 里若出现 `env_file`，**必须**同时声明
  `required: false`（Docker Compose 2.24+ 起支持，本机实测 NAS 为 v2.40.3）。
  旧版 compose 会同时触发这两条、打不出包。
- **本版 Release 附件里的 `.fpk` 已替换为最终修正版**（`80102 B`，
  sha256 `e9aae0ed3359ac45d719668d8fddaae52919f3d561e3171ce8a13430b80b7ec1`）。
  包版本仍是 `1.1.1`、**镜像标签未变** —— 本次只改包内 compose 与出厂校验脚本，运行时代码与镜像都没动，
  已装过的用户无需重新拉取镜像，重装安装包即可。

## [1.1.0] - 2026-09-20

本轮为对标同类项目做的一轮系统性改进，全部以「不破坏既有行为」为前提，并配了回归断言
（目前 **19 个套件 / 961 项断言 / 0 失败**）。

> 打 `v1.1.0` 标签会推送 `1.1.0` / `1.1` / `latest` 三个镜像标签。
> NAS 上若要升级到本版：`docker compose -f docker-compose.image.yml pull && … up -d`。

### 新增

- **拼音搜索**：支持中文子串、全拼（`jiating`）与首字母缩写（`jtyy`），按拼音音节边界对齐
  （`ya` 不会误命中「网易云音乐」）；69KB 拼音表按需懒加载，取不到时静默降级为纯子串匹配。
- **`Ctrl / ⌘ + K` 命令面板**：分组结果、`↑↓` 选择、`Enter` 打开，并可把关键词交给搜索引擎
  （`site.searchEngines` / `site.defaultEngine`，支持 `%s` 与 `{q}`）。
- **卡片级内外网策略**：全局三态（自动 / 只用内网 / 只用外网）+ 卡片级 `netMode`；
  「自动」模式对每张卡片的内网地址做**异步可达性探测**，**不阻塞点击**（首帧先用启发式渲染，
  出结论后原地改写链接）。HTTPS 页面无法探测 `http://内网IP`（浏览器混合内容限制）时**显式跳过**
  并如实说明，不给出假结论。
- **含图片的完整备份**：`GET /api/backup?format=zip` 导出配置 + 图床库全部图片，包内逐项 SHA-256；
  恢复按文件头判格式、图片「只增不删」、被覆盖的原图另存回滚副本；手写 ZIP 读写，仍然零第三方依赖。
- **首页状态板**：容器数 / CPU / 内存 / 磁盘水位（`GET /api/status`）。**降级是一等公民**——
  采不到的项返回 `null` 而**不是 `0`**，整块取不到就静默隐藏并停止轮询；后台标签页暂停轮询。
- **内置本地图标库（离线可用）**：随仓库与镜像分发 227 个常用图标（含国内站点 favicon），
  图标解析顺序为「**本地 → 公共 CDN → 首字母回退**」——内网 / 断网环境不再是一排空框。
- **服务发现的来源追踪与失效管理**：加入的卡片记录来源（来自哪个容器 / 端口）；重新扫描时
  源侧已消失的卡片**只标记 `stale` 并显示「⚠ 可能失效」角标，绝不自动删除**，
  并提供「恢复全部」与「清理失效项（二次确认）」两个显式动作。
  **本次未接入的来源不做失效判定**（Docker 未挂载时不会把全部发现卡片冤枉成已失效）。
- **卡片标签（跨分组检索）**：卡片可加可选 `tags[]`（逗号分隔输入，最多 8 个、单个 12 字，
  中英文逗号都认）。搜索框与 `Ctrl/⌘ + K` 面板都能按标签命中，**命中不再受分组限制**——
  搜「下载」能把散落在各组里的下载类站点一次找出来，面板上还会标出「标签」说明命中原因。
  卡片上的标签**点一下就筛**（跨分组）；标签本身也支持拼音（「下载」搜 `xz` 或 `xiazai`）。
  与拼音搜索天然互补：拼音解决「读音记得、字忘了」，标签解决「类别记得、名字忘了」。
  标签是人工整理的索引，因此**随备份原样带走**；后端会校验字段形状（写成字符串会被直接拒，
  否则前端会把它遍历成单个汉字当标签，检索结果莫名其妙）。
- **首次使用引导**：配置为空时给出可跳过的新手向导（三步说明 + 公网部署务必设 `NAVI_PASSWORD` 的提醒）；
  「以后再说」会被记住，之后不再打扰。已有卡片的老用户、以及纯静态托管（改不了数据）时不出现。
- **拖链接建卡**：把地址栏 / 书签 / 聊天窗口里的链接**直接拖到页面上**即弹出「添加导航项」并预填地址与标题。
  仅在编辑模式生效（浏览时误触不会改数据）；只认链接，拖进来普通文字不打扰。
  解析兼容 `text/uri-list` 与 `text/plain` 两种形态（`标题\r\nURL` / `URL\r\n标题` / 多链接取第一个 / 忽略 `#` 注释行）。
- **`DOCKER_GID` 说明**：以非 root（`user:`）运行时读取 `docker.sock` 的权限解法。
  刻意**默认不启用**（`group_add` 是注释掉的）——因为镜像本就默认 root，补组 `0` 会把降权运行的意图
  悄悄抵消，属于「为省事而绕过自己的安全设置」，所以做成显式选择。
- **`CHANGELOG.md`**：补上 Keep a Changelog 格式的更新日志，并把镜像标签与版本号的关系写清
  （`v1.2.3` 的 tag → `1.2.3` / `1.2` / `latest`，**不存在** `v1.2.3` 这个标签）。

### 变更

- 接口口径统一为 **13 个 `/api/*` 接口**（文档原先按「15 个 HTTP 接口」描述，与实现不符）。
- 前端静态资源版本号由服务端按文件 mtime 自动注入 `?v=`，不再需要手工改号。
- `docs/roadmap.html` 保留审计当时的数字快照，当前状态集中在「实施进度更新」一节。

### 修复

- **对外发布的首页截图被测试套件覆盖**：`test/ui.test.cjs` 曾把正式发布图 `ui-home.png`
  重截成浅色（标注「夜间主题」而图是白的），跑一次回归就覆盖一次并随发布包上线。
  已删除该写者并加护栏：发布截图只允许 `test/page-shots.cjs` 写，且截图清单可机器校验。
- **新增本地模块漏进 Dockerfile 的 `COPY` 清单**：会让本地测试全绿而容器启动即
  `MODULE_NOT_FOUND`。已补 `COPY` 并加断言（从 `server.js` 抽出全部 `require("./x")` 逐个核对）。
- `scripts/check-deploy.cjs` 在无密码时改为**如实标注未验证**并说明如何补全，而不是假装通过。
- **弹窗过高导致底部按钮点不到**：`.modal` 原先没有高度上限，字段一多（编辑弹窗新增「标签」后就到了
  临界点）弹窗会向视口上下两端同时溢出，底部的「保存 / 取消」被推到屏幕外，在小屏笔记本上根本点不到。
  已封顶为 `calc(100vh - 40px)` 并改为弹窗内滚动。此问题由 UI 套件真实点击按钮时暴露，而非肉眼发现。
- **图床库「空库提示」偶发消失**（长期存在的不稳定项，本次定位）：打开弹窗的一瞬间空状态区显示的是
  加载文案「正在读取图床库…」，而断言没有等它切到空状态就取值 —— 机器稍忙、`/api/library` 回来得慢一点
  就会失败，看起来像产品缺陷，实际是断言早于数据到达。已改为等状态落定后再断言。
  这是「全量回归偶发 1 项失败、单独跑必过」的真正原因。
- **文档与发布页里的陈旧数字**：`preview.html` 的套件数还停在 **17 套**（实际 19 套）、
  段落里写着「其中 7 套为真实浏览器 UI 测试」（实际 9 套）；`docs/roadmap.html`、`README.md`、
  `docs/docker-guide.html` 与 `scripts/share-index.html` 里的断言总数停在 940。
  已全部校正到当前值，并把旧数字（`940`、`<b>17</b> 套`、`其中 7 套为真实浏览器 UI 测试`）
  写进 `scripts/verify-share-ui.cjs` 的 **mustNots** —— 防止把旧发布包发上线。

### 文档

- `README.md` 补齐上述能力的说明、项目结构树与测试清单；`docs/` 下新增
  「拉取镜像部署指南」与「飞牛 fnOS 部署指南」（含可打印 PDF）。
- **`docs/overview.html`（项目概览）**：一次性讲清目录组织、四个后端模块的职责与依赖方向、
  数据模型全字段、接口清单、六条关键调用链、功能实现盘点与技术取舍。它是维护视角文档，
  **刻意不进发布包**（与 `docs/roadmap.html` 同策略）。
  为避免它写完就烂掉，其中三张表受断言保护：**模块表**必须等于 `server.js` 实际 `require` 的本地模块、
  **套件表**必须与 `test/_baseline.txt` 的套件名与断言数逐条一致、**路由表**必须等于 `server.js` 里
  所有 `pathname` 字面量；图标数、服务指纹数、「N 条接口路由」的声明也一并钉住。
  行数快照同样校验 —— 改了代码就得顺手改那几个数字，断言会直接告诉你该改成多少。
- **`docs/showcase.html`（迭代成果预览站点）**：把本轮改进做成一页可交互的对照 —— 10 项改动各有
  「修改前 / 修改后」切换与能直接上手点的演示，另有 5 处真实缺陷的前后对照、断言基线增长曲线与复现命令。
  单文件自包含（零外部资源）、日 / 夜双主题、桌面与移动端自适应。与 `overview.html` 同策略**不进发布包**；
  它声明的套件数 / 断言数、后端模块清单与「零外部依赖」由 `test/imagecompose.test.cjs` 钉住。

## [1.0.0] - 2026-09-19

首次发布。零第三方运行时依赖的 Node.js 个人导航站：单页前端 + 内置 HTTP 服务，
支持分组导航、编辑模式、图床库、访问密码保护、IPv4/IPv6 双栈、Docker 一键部署，
并提供 `linux/amd64` 与 `linux/arm64` 多架构预构建镜像。

[未发布]: https://github.com/DamiSunshine/navi-homepage/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/DamiSunshine/navi-homepage/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/DamiSunshine/navi-homepage/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/DamiSunshine/navi-homepage/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DamiSunshine/navi-homepage/releases/tag/v1.0.0
