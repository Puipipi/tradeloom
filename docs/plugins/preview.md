# 在本机预览视图 JSON

[English](en/preview.md)

检查器能列出视图的路径问题。需要看实际排版时，可用仓库内的预览命令调用 App 的 `PluginView`，把一份静态 JSON 和数据快照画成浅色、深色 PNG。它使用 App 的 Flutter 解析器、组件和主题；不启动 DSH，不加载插件 JavaScript，也不发送动作。

## 准备

需要完整 dsh-go 源码、Node 22.19+、仓库指定的 Flutter，以及已经准备好依赖、本地化、App 字体和测试字体的 `app/`。预览沿用 `test/flutter_test_config.dart` 的严格字体检查；缺字体会失败，不静默换成占位字体。`DSH_TEST_FONT_DIR` 可指定 Noto Sans CJK 字体目录，见 `app/test/support/test_fonts.dart`。

先按项目现有流程准备 App；预览本身运行 `flutter test --no-pub`，不改依赖、构建配置或生成本地化。它是源码仓库内的开发工具，不是手机内置技能的一部分。

## 一条命令

在仓库根目录执行，输出目录必须尚不存在：

```sh
node sdk/plugin-kit/bin/preview.mjs /绝对路径/view.json \
  --data /绝对路径/data.json \
  --out /绝对路径/新的预览目录 \
  --width 320 --height 960 --scale 1.3
```

`--data` 可省略。原始视图默认按面板检查；形如 `{ "dsh-go/view": ... }` 的工具结果元数据自动使用工具卡上限，工具卡不会读取数据模型。也可以显式传 `--budget panel|strip|toolCard`。

| 参数 | 默认值与范围 |
|---|---|
| `--width` | 390 逻辑像素，整数 240–800 |
| `--height` | 960 逻辑像素，整数 240–2400 |
| `--scale` | 1，范围 1–2；大字号可用 1.3 或 2 |
| `--theme` | `both`；也可 `light` 或 `dark` |
| `--lang` | `zh`；也可 `en`，影响 App 文案而不翻译插件内容 |
| `--flutter` | PATH 上的 `flutter`；可传 Flutter 可执行文件的绝对路径 |

每个输入文件上限 1 MiB，这只是预览读入保护；实际视图仍遵守 App 的工具卡、面板或状态条预算。先用已有 `check.mjs` 调整输入，再看排版。预览命令也先输出检查诊断；根节点整体无效时直接返回 2，不调用 Flutter。局部错误保留占位后仍可预览。

## 看哪些文件

- `light.png`、`dark.png`：所选主题的第一屏视口，PNG 像素和逻辑像素 1:1。
- `light.json`、`dark.json`：App 解析问题、实际主题/字号、`remainingScrollExtent` 和原生根错误标记。剩余滚动距离大于零说明后面还有内容，不能凭第一屏说整份视图都已检查。
- `sdk-diagnostics.json`：Node 检查器的诊断。
- `request.json`：本次固定的视图和数据。它可能包含你提供的私有数据，请按原输入的用途保存和分享。

命令返回原检查器的 0/1/2 状态；Flutter 编译、布局、截图或文件写入失败返回 3，App 发现根错误至少返回 2。输出目录不会覆盖；失败后可能保留输入和部分图片，重跑要选新目录。

## 预览边界

图片只代表所选视口。面板按钮显示其正常外观，但没有主机处理函数；不要把图片当作动作、权限或后台流的测试。`asset:` 图片没有插件资产解析器，会显示既有占位；内联图片沿用 App 解码，异步图片的完整时序仍需专门测试。不会读取网页或执行 Markdown 中的插件代码。

这是本地渲染结果，不会读取、写入或批准任何 golden 基准。最终视觉检查应使用完整产品字体和资产；真实设备的字体回退、GPU、系统字号策略及点击行为仍要单独检查。已在 Linux、Node 24、Flutter 3.47 上验证；其他系统请先确认本机能正常运行 Flutter 测试。Windows 上 `--flutter` 可以直接给 `flutter.bat` 的路径（不给时用 PATH 里的 `flutter`），会经 `cmd.exe` 启动。
