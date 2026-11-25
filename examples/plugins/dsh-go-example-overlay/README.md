# 网页浮层与三槽示例

[English](README.en.md)

一个仅有网页界面的 DSH 插件：可拖动、可点击计数的小按钮，加上三个常见长尾 slot。它不声明原生 `dshGo` 贡献，不新增原生 `pets` / `bubbles` / `actions` 协议，也不做跨 App 悬浮。

## 包的约定

- [清单](package.json) 使用真实的 `exports["./client"]`、`dsh.client.platform: "web"` 和 [bundle patch](cordis.patch.yml)，不是原生插件 SDK 清单。声明适用 DSH 0.2.2-rc.1 至 0.3 之前；未做逐版本运行验证。
- [网页源码](lib/client.js) 通过宿主 `window.__ModuleLoader__.load` 加载，用 `require("react")` 取得宿主已有的 React，随后 `ctx.slots.inject/register` 注册。没有 npm 依赖、JSX、打包器、下载脚本或额外构建链；无需 `npm install`。
- 参考本仓库真实的 [route probe](../../../runtime/tests/route-probe/client.js) 和 [bridge 清单](../../../runtime/bridge/dsh-go-bridge/package.json)，不是凭空发明加载协议。[引擎半侧](lib/index.js) 不注册服务或执行操作。

| Slot | 示例 | 在 App 中 |
|---|---|---|
| `shell.overlay` | 拖动按钮；轻点计数，键盘也可激活 | 详情显式启用后显示在聊天内容区 |
| `sidebar.footer.action` | 侧栏底部计数按钮 | 详情 → 侧栏入口，单包整页岛 |
| `settings.plugins.tab` | 带计数按钮的插件设置页签正文 | 详情 → 插件设置页，单包整页岛 |
| `plugins.detail.section` | 本插件详情分区（按 `subject.pkg.name` 过滤） | 详情 → 插件详情扩展，单包整页岛 |

网页上的示例标题为英文且各不相同。稳定 cell id 都带包名前缀。点击与位置状态只在当前组件挂载期间保存，不读写文件、网络、剪贴板或音频。

## 手动使用（本轮没有执行）

在具备网页界面及桥接的本机引擎上，由用户主动安装：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-overlay
```

在 App 插件详情的「App 内界面」开启「在 App 内显示浮层」。这是**本机按主机保存**的偏好；不是安装即开启。主机 `ui.json` 的 `plugins.seats` 显式值优先，例如合并以下设置可显式启用；改成 `hidden` 则关闭，不要覆盖现有其他键：

```json
{"version":1,"plugins":{"seats":{"shell.overlay":{"dsh-go-example-overlay":"island"}}}}
```

手动验收：

1. 未启用时浮层不显示；启用后只有本插件的 cell 出现，其他未启用包不能跟着出现。
2. 小按钮轻点加一，拖动不加一；空白区可操作聊天。拖到边缘后旋转屏幕 / 打开键盘，浮层应跟随原生聊天内容区的可用视口收缩，按钮不应丢到可用区域之外。该示例用 `calc(var(--dsh-go-island-top, 0px) + 16px)` / `calc(var(--dsh-go-island-bottom, 0px) + 16px)` 读取宿主 inset；内容区已保留原生顶栏 / 输入框，变量可以为 `0`，不再扣一次原生 chrome 高度。
3. 分别从详情打开三个长尾入口，核对标题与计数按钮；只有本包、本 cell，设置页签可确认选中；找不到目标应降级网页版，不报假成功。
4. 浮层严格裁在原生顶栏与输入框之间，不覆盖原生 chrome、抽屉、右侧详情或模态；未决审批 / 未答问题时停止，离开聊天页不出现浮层；关闭开关后浮层消失。切换主机核对开关独立，`ui.json` 显式值仍优先。
5. 卸载组件后重开，计数和拖动位置重置；卸载 / 重载插件不残留监听或元素。仅暂时隐藏或缓存的岛不等于组件已卸载。

## 触摸、生命周期与限制

根容器 `pointer-events: none`，只有小按钮 `pointer-events: auto`；不放透明全屏点击层。按钮以 Pointer Events + pointer capture 完成拖动，处理 `pointerup`、`pointercancel`、失去 capture；卸载时释放 capture，并断开用于尺寸 / inset 变化的 ResizeObserver。React 卸载组件时撤销事件处理器，slot 注入随 Cordis 上下文释放；没有动画循环、计时器或 document 全局监听。

触摸穿透按**矩形而非像素透明度**；透明图片内的空像素仍可能占用触摸。快速运动（尤其 CSS 连续动画）时，上报命中区会有采样 / 桥接滞后，不等于已开始的拖动必然中断。本例仅手动拖动，不展示追着动画点按的保证。

浮层只属于 `HomeShell.chat` 内的 `ChatScreen` 聊天内容区，用 `ClipRect` 限定在原生顶栏与输入框之间，不覆盖原生 chrome、drawer、右详情或模态；未决审批 / 未答问题时停止。键盘出现时视口随原生布局收缩，不能跨 App。仍受桥接归属、路由守卫和资源预算限制；音频用户手势策略保持不变，本例无音频。首岛约 200 MB、首开约 1–3 秒仅为 Android 15 x86_64 debug 模拟器估测，真机未验。历史普查「19% 使用浮层」不是「19% 插件免改可用」。详见[网页接缝说明](../../../docs/plugins/web-panels.md)。

**验证状态：** 只做源码、清单和语法静态检查；本轮未安装或运行插件，未构建 App，未做真机验证。宿主 React / 模块加载器是必需运行条件，不是浏览器直接打开就能运行的独立 HTML 页面。
