# go.dshtui.com 首页

`https://go.dshtui.com/` 的展示网站。网页由社区开发者 **ClayGao233 / 采云师烧饼**（[GitHub](https://github.com/ClayGao233)、[B站](https://space.bilibili.com/28879571)）制作，作者交付用于 go.dshtui.com；交付包没有附许可证声明，所以这部分不在本仓库的 AGPL-3.0 授权范围内，见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。页底的「网页开发」署名保留。

纯 HTML、CSS、JavaScript，没有第三方依赖，也不从别的网站加载任何东西。

## 怎么上线

`services/share-worker/scripts/build-site.mjs` 把 `dist/` 拷进 Worker 静态资源 `public/` 的根下，`/` 返回 `index.html`（直接访问 `/index.html` 是 404），页面里的相对路径（`/app.js`、`/assets/…`）按原路径提供，都不经过 Worker；每个文件的安全头写在生成的 `public/_headers` 里。部署照旧：`CF_TOKEN_FILE=… services/share-worker/scripts/provision.sh deploy`。路由、安全头和缓存见 [share-links.md](../../docs/design/share-links.md) §2。

- **CSP**：写在 `dist/index.html` 的 `<meta>` 里，Worker 构建时取出来作为响应头（再加 `frame-ancestors 'none'`）。脚本只能是本站文件，没有内联脚本和事件属性；样式表只能是本站文件，允许内联 `style` 属性（开场动画用 `style="--order:…"` 这类 CSS 变量）；图片只能是本站的；`connect-src` 只有本站（Star 数）。所以头像、二维码要放在 `dist/assets/author/`，不能填外链。
- **Star 数**：页面向本站的 `GET /api/github/stars` 要数（`services/share-worker/src/github.ts`），由 Worker 去问 GitHub、缓存 10 分钟，访客的浏览器不连 GitHub。拿不到数时气泡照常显示，只是没有数字。Worker 固定查 `ccch1mneyyy/dsh-go`。
- **搜索引擎**：首页和它的文件可以被收录（`robots.txt` 只放行这些，其余页面仍是 `noindex`）。
- **缓存**：HTML `no-cache`，其余文件一小时。换图请换文件名（例如 `download-qr-v3.png`），不要同名覆盖。

## 改内容

1. 所有可填项都在 `dist/site-config.js`：作者头像 / ID / 自述、下载入口（二维码、下载页、GitHub Releases）、平台说明、仓库、贡献者、分享元信息。
2. 改了 `metadata` 后运行 `npm run prepare:publish`，把标题、描述、canonical、Open Graph 写进 `dist/index.html`。
3. 运行 `npm run check`（语法）、`npm run check:content`（必填项、链接、本地图片）、`npm test`（发布工具的回归用例），再在 `services/share-worker` 跑 `npm test`。

以上命令都只用 Node，不联网，不需要 `npm install`。`npm run dev` 在 http://127.0.0.1:4173/ 本地预览（没有 Star 数）。

下载二维码 `dist/assets/author/download-qr-v2.png` 的内容和 `download.url` 相同，纠错级别 M、每格 10 像素、留白 4 格（`qrencode -t PNG -l M -s 10 -m 4` 或同等工具）。改了 `download.url` 就要重新生成并扫码核对。

分享封面 `dist/assets/author/share.png` 是 `docs/assets/social-preview.png` 的副本。

## 还要作者确认

当前填的是暂定内容：作者 ID `ccch1mneyyy`、头像用品牌图标、分享封面用仓库的社交预览图。确认或替换后按上面的步骤重新检查。
