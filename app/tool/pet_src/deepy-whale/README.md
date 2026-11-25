# Deepy 小鲸鱼：Clawd on Desk 主题包

这是一只像素小鲸鱼桌宠，给 DeepSeek 驱动的编程 agent 用，对标 Clawd 的小螃蟹。它是非官方的粉丝主题，和 DeepSeek、Anthropic 都没有关系。

- 画布 `viewBox` 为 52×52（逻辑像素）。动画资产是 260×260 的 APNG（5× 导出，带真正的半透明阴影），20 fps。
- 待机状态用 `idle-follow.svg`，里面有 `#eyes-js`、`#body-js`、`#shadow-js` 三个组，眼睛会跟着鼠标转，还带 CSS 呼吸、眨眼和摆尾。
- 已经用 Clawd 自带的 `scripts/validate-theme.js` 校验过，全部通过。也用它的 `theme-loader` 做过严格加载，SVG 过 sanitizer 后内容不变。

## 安装

1. 把整个 `deepy-whale/` 文件夹（顶层直接是 `theme.json`）复制到下面的目录：
   - Windows：`%APPDATA%/clawd-on-desk/themes/deepy-whale/`
   - macOS：`~/Library/Application Support/clawd-on-desk/themes/deepy-whale/`
   - Linux：`~/.config/clawd-on-desk/themes/deepy-whale/`
2. 在 Clawd 里打开 `Settings…` → `Theme`，选择 **Deepy 小鲸鱼**。如果列表里没有，重启一次 Clawd。
3. 想让小鲸鱼跟着 DeepSeek 干活，可以在 `Settings…` → `Agents` 里接入 DeepSeek Harness（实验性），其他已支持的 agent 也一样能驱动它。

## 状态映射

| Clawd 状态 / 槽位 | 触发事件 | 文件 | 动作 |
|---|---|---|---|
| idle | 无任务 | idle-follow.svg | 眼睛跟随鼠标、呼吸、眨眼、摆尾 |
| idleAnimations | 待机随机 | idle.apng / idle-look.apng / idle-spout.apng | 呼吸、东张西望、开心喷水 |
| thinking | UserPromptSubmit | thinking.apng | 思考云、点点波浪跳、灵光一闪 |
| working（1 个会话） | PreToolUse / PostToolUse | typing.apng | 趴在键盘后写代码，写完一段小跳一下 |
| working（2 个会话） | 同上 | music.apng | 戴耳机律动 |
| working（3 个及以上会话） | 同上 | building.apng | 戴安全帽把掉下来的砖顶正 |
| juggling（1 个子代理） | SubagentStart | music.apng | 戴耳机律动 |
| juggling（2 个及以上子代理） | SubagentStart | conducting.apng | 用尾巴打拍子，带三只小鲸鱼分身干活 |
| error | PostToolUseFailure | error.apng | 受惊抖动、✕、冒烟、眼冒金星 |
| attention | Stop / PostCompact | happy.apng | 空翻庆祝、彩纸、✓ |
| notification | PermissionRequest | notification.apng | 感叹气泡摇铃，边跳边甩尾 |
| sweeping | PreCompact | compacting.apng | 把上下文碎片吸进去，压缩成方块吐出来 |
| carrying | WorktreeCreate | carrying.apng | 顶着箱子蹦跳赶路 |
| sleeping | 60 秒无操作 | sleeping.apng | 睡帽、鼻涕泡、Zzz |
| waking | 睡眠中移动鼠标 | waking.apng | 惊醒弹起，睡帽飞走 |
| roam | 自由漫步 | roam-hop.apng | 用肚皮一弹一弹往前蹦（`roamFlipAssets: true`） |
| reactions.clickLeft / clickRight | 双击左半边 / 右半边 | react-left.apng / react-right.apng | 果冻回弹，冒出爱心 |
| reactions.double | 快速点击 4 下 | react-double.apng | 被挠痒痒，笑得乱抖 |
| reactions.drag | 拖动 | react-drag.apng | 被拎起来，像钟摆一样晃，慌张扑腾 |

## 暂不支持的功能

- Mini 模式（`miniMode.supported: false`）。开启它需要再画 8 个 mini 状态。
- 头饰和嘴部配件目录（`customization.accessories`）。
- 睡眠序列用的是 `direct` 模式：60 秒无操作后直接进入 `sleeping`，被唤醒时播放 `waking`。
