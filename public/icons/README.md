# public/icons —— 内置本地图标库

这里存放导航站**自带的图标**，目的是让图标在**内网 / 断网**环境下也能正常显示。

## 为什么要内置

用户实际访问方式是 `http://局域网IP:端口`（飞牛 NAS）。原先图标全部由浏览器直连公共 CDN
（`api.iconify.design` / `cdn.jsdelivr.net`）现拉 —— 一旦内网或断网，卡片上就是一排空框。
这是项目已确认的第二大短板，P1-6 通过「图标内置 + 本地优先」解决：

- 前端 `resolveIcon()` **先查本地**（映射表 `public/js/icon-map.js`），命中就用 `/icons/...`；
- 本地没有该图标时才回退公共 CDN（所以自定义图标、Iconify 搜索仍然可用）；
- 解析失败由前端 `iconFallback` 退化成首字母方块，不会留白。

## 怎么生成 / 更新

```bash
node scripts/build-icons.cjs            # 只下缺失的，很快
node scripts/build-icons.cjs --force    # 全部重下
node scripts/build-icons.cjs --only jellyfin,plex
```

**不要手改这个目录里的文件**，会被下次构建覆盖。要增删图标请改
`scripts/build-icons.cjs` 里的 `CURATED` / `SITES` 清单，然后重跑脚本。
产物（`*.svg` / `*.ico` + `catalog.json` + `public/js/icon-map.js`）都是入库的，
理由与 `public/js/pinyin.js` 一致：它们是**可重复生成的源料**，而不是构建缓存。

## 图标来源与致谢

图标来源于以下开源图标库，均为其各自作者创作；本项目仅做本地缓存以支持离线使用：

| slug 形式 | 来源 | 说明 |
|---|---|---|
| 短名（如 `jellyfin`） | [walkxcode/dashboard-icons](https://github.com/walkxcode/dashboard-icons)（现已迁至 homarr-labs） | 首选，SVG |
| `selfhst:` 前缀 | [selfh.st/icons](https://github.com/selfhst/icons) | 次选 |
| `iconify:集:名` | [Iconify](https://iconify.design/)（`api.iconify.design`） | **不本地化**，按用户指定在线加载 |
| 少量国内站点 | 站点自身的 `/favicon.ico` | 上游图标库未收录，见脚本里的 `SITES` |

> 各图标是其各自商标持有者的财产，此处仅用于个人自托管导航页的图标展示。
> 若你是某个图标的权利人并希望移除，删掉对应的 `CURATED` 条目并重跑脚本即可。

## 质量门槛

`build-icons.cjs` 对抓来的图标做体检，不合格的直接丢弃并打印原因，避免「有图标但显示成白块」：

- 必须是合法图片（按文件头判定，不看扩展名）——防止把上游的 HTML 错误页存成 `.svg`；
- favicon 要求**最大帧 ≥ 24×24 且为 32bpp**，不透明像素占比 ≥ 40%、颜色数 ≥ 3
  （16×16 单色图放大到卡片尺寸只会糊成一团，比「没有图标」更糟）。

`test/icons.test.js` 会对以上约定逐条断言。
