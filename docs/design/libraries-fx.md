# Libraries.dev 特效在 dsh-go 里的用法

2026-11-14。用户说"参考 libraries.dev 的特效丰富语音模块和其他用得到的地方，MIT 随便用，但一定要切合整体风格，不能花里胡哨，要高级典雅精致"。

来源是 https://github.com/Jakubantalik/Libraries.dev（MIT，提交 `387b049`）。九个库从作者的 TypeScript、Swift、Metal 原样翻译到 `app/lib/ui/fx/`，着色器放在 `app/shaders/fx/`。每个移植都和原版逐帧比对过。

没有接的：
- 「磁吸 UI」「语音位置」：背后的模型文件受 `LICENSE-MODEL.md` 约束，商用要付费。
- Pro 预设：不在 MIT 范围内。

## 规则（作者的取用规则，照用）

- 等待短于 2 秒什么都不加；2 秒以上放思考光球，旁边配文字；超过 3 秒再给正在干活的元素加边框流光。
- 一个区域只放一种特效；同一个元素、相邻元素不叠两种。
- 金属一页只放一处。
- 颜色默认从主题色取：相邻色相、低饱和；作者的预设保留可选。
- 系统「移除动画」时：一律显示静止画面，或退化成淡入淡出。

## 放在哪

| 特效 | 位置 | 文件 |
|---|---|---|
| 思考光球 `ThinkingOrb` | 等待第一个字（`TypingIndicator`，`breathing`）；思考胶囊在思考中时的图形；工具运行中（命令 = solving，改文件 = composing，读和搜 = searching，子任务 = working，待办 = weaving，其他 = connecting）；机器人、酒馆、伙伴的"正在输入" | `ui/common/typing_indicator.dart`、`chat/widgets/thinking_pill.dart`、`tool_row.dart` |
| 语音光环 `VoiceRing` | 通话页中央，可选光环、细线、光球（原来的玻璃球）；只有选光球时才保留屏幕边缘光 | `ui/speech/voice_call_page.dart` |
| 语音辉光 `VoiceBeam` | 听写时，输入框玻璃里、文字下面一层，随声音升起；识别中左右扫 | `ui/chat/composer.dart` |
| 机器人头像 `BotAvatar` | 没有照片的 DS 机器人（按 id 固定一只，用它自己的颜色）；智能体（按名字固定一只）；运行中会跳。群组头像叠放时仍用首字母 | `ui/bots/bot_avatar.dart`、`ui/agents/agent_widgets.dart` |
| 边缘色带（Distortion waves 的 rim） | 手机操控时一圈柔和、不均匀的色带一直贴着屏幕边缘，鼓包缓慢漂移呼吸，Kotlin 原生实现（`phone/a11y/EdgeBeam.kt`，Android 13+ 用 AGSL）；截图和注入手势时隐藏 | `docs/design/phone-overlay.md` §12 |
| 液态金属 | 欢迎页标题、「新版本」徽章 | `onboarding/welcome_page.dart`、`update/update_tiles.dart` |
| 粘滴 `Liquid` | 灵动动效开启时，分段选择器的滑块（作者的标签栏参数） | `ui/common/segmented_pill.dart` |
| 图片 `ImageGeneration` | 生图进行中的占位：主题色的像素马赛克，进度文字在上面 | `chat/media/media_card.dart` |
| 扭曲波纹 | 切换到伙伴小屋或酒馆时，新页面随一道主题色波纹推上来；色差从 0.78 调到 0.35 | `ui/modes/mode_switch.dart` |

## 没在真机上验证

- 着色器在 GLES 后端会不会上下颠倒。
- 中低端机的帧率。
- 手机操控边缘色带在真实屏幕圆角处的样子。
- 波纹截图遇到平台视图（WebView）时的表现。
