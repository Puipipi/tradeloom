# 贴纸相册：聊天页插件弹层示例

[English](README.en.md)

一个放在聊天页「插件」弹层和「全部功能」里的贴纸面板，演示视图 v2 的四样东西：图集（`gallery`）、空状态（`emptyState`）、环形进度（`progress.shape: "ring"`）和趋势线（`metric.trend`），整块跟随用户在 App 里选的主题色（`accent: "app"`）。贴纸是包里自带的四张小图（`assets/stickers/`），不联网。

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-album
```

需要主机提供 `dsh-go-bridge`。装好后打开任一对话，输入框上方胶囊行最后多一枚「插件」，点开就是这个面板；「全部功能」里也有一份。

- 点一张贴纸：它的名字放进输入框，不发送。长按任一张：App 的看图页，左右滑看这一组，保存和分享是 App 的动作。
- 「清空」之后是空状态，按钮「放回」把示例贴纸放回来。
- 老 App 不认图集和空状态：用 SDK 的 `adaptView` 能换成图片和提示条（见测试）。

`lib/view.js` 只产生有界 JSON，`lib/index.js` 注册面板并处理三个动作。在仓库内验证：

```sh
node --test examples/plugins/dsh-go-example-album/test/*.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-album --load
```

诊断里的颜色校正是正常提示。组件的写法见[组件目录](../../../docs/plugins/components.md)，弹层见[网页面板](../../../docs/plugins/web-panels.md)。
