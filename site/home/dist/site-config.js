/* 作者只需修改本文件，填写方法见 site/home/README.md。
   所有内容会公开显示，请不要填写密钥或私人信息。图片放在 assets/author/。
   头像和二维码只能用本站的 assets/ 路径：页面的 CSP 只允许加载本站图片，外链图片显示不出来。
   空链接不会跳转；贡献者留空不会生成虚构姓名。保存后刷新网页生效。 */
window.DSH_GO_CONFIG = {
  // 分享元信息：填写后执行 npm run prepare:publish，写入静态 HTML。
  // 不更换品牌时保留标题、描述；siteUrl 填最终完整网址，目录网址以 / 结尾。
  metadata: {
    title: "DSH Go · 万物皆插件，随身而行",
    description: "DSH Go，由 DSH-TUI 作者 ccchimneyyy 精心打造的非官方 DeepSeek Harness 移动应用。万物皆插件，现在随身而行。",
    siteUrl: "https://go.dshtui.com/",
    shareImage: "assets/author/share.png", // 可选：本站图片或完整 HTTPS 图片地址，推荐 1200×630 PNG/JPEG
    shareImageAlt: "DSH Go 的手机和平板界面：把 DeepSeek Harness 装进口袋"
  },
  author: {
    avatar: "assets/dsh-go.svg", // 换成 assets/author/avatar.png
    id: "ccch1mneyyy",
    message: "DSH Go 是由 DSH-TUI 作者 ccchimneyyy 精心打造的非官方 DeepSeek Harness 手机客户端。我们希望把「万物皆插件」的体验带到手机上，让灵感不受地点限制。"
  },
  download: {
    label: "下载 DSH Go",
    platform: "Android 8.0+",
    title: "获取 DSH Go",
    description: "DSH Go 1.0 已发布，支持 Android 8.0 及以上的手机。下载页列出了当前可用的下载线路。",
    qrImage: "assets/author/download-qr-v2.png", // 内容是下面的 url；改 url 时要重新生成并换文件名
    qrNote: "扫码打开下载页",
    url: "https://go.dshtui.com/download", // 下载入口：下载页，在微信、QQ 里会提示换浏览器
    urlLabel: "打开下载页",
    altUrl: "https://github.com/ccch1mneyyy/dsh-go/releases/latest", // 第二个入口：GitHub Releases 最新版本，空值隐藏
    altLabel: "从 GitHub 下载"
  },
  // 代码框和 Star 气泡都链接到这里；气泡上的 Star 数由本站的 /api/github/stars
  // 提供（services/share-worker/src/github.ts，固定查 ccch1mneyyy/dsh-go）。
  repository: {
    label: "github / ccch1mneyyy / dsh-Go", // 整行文字均可修改
    url: "https://github.com/ccch1mneyyy/dsh-Go"
  },
  // 三行从右向左滚动。每项可指定 row: 1、2 或 3；省略则轮流分配。
  // name 只用于无平台链接的姓名。平台对象的 label 是对应平台显示名。
  // 示例：{ name: "贡献者ID", row: 1 }
  // 示例：{ github: { label: "GitHub ID", url: "https://github.com/用户名" }, row: 2 }
  // 示例：{ bilibili: { label: "B站昵称", url: "https://space.bilibili.com/数字ID" } }
  // 同一项同时写 github、bilibili 即可得到「GitHub ID / B站昵称」。
  contributors: [
    { github: { label: "ccch1mneyyy", url: "https://github.com/ccch1mneyyy" }, row: 1 }
  ]
};
