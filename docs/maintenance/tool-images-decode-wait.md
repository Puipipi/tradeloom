# 工具图片测试等待真实首帧

Refs：629整chat测试遗留的 `ImageViewerPage` 找不到失败；没有新增公开issue。不会改 runtimeVersion。仅改测试和验证夹具，不改UI生产代码或资产。

`Image` widget可以在首帧解码前存在。生产 `ToolImages` 的 `frameBuilder` 在首帧前显示placeholder，首帧后才创建点击打开查看器的手势。测试原来真实等待50ms后直接点击；这个时限不能保证解码已完成。改为按现有 `message_menu_test.dart` 的方式 `precacheImage` 等待相同ResizeImage的流，success或error都结束，再pump绘制；坏字节仍由原测试断言没有查看器与未处理异常。

显式复现器 `app/test/chat/support/tool_images_decode_probe.dart` 用公开Flutter测试binding挂起首个真实codec。ImageCache对同一ResizeImage的再次resolve是显式流等待的测试协调点；原测试若直接点击，夹具在点击派发后才释放，以保证真实codec继续完成。实际解码仍调用super，没有伪造Image、frame或应用结果。gate运行在测试fake时钟之外，不新增真实sleep。它证明一种可复现的充分机制，不代表真实设备时延，也不能单独断定629历史失败的唯一根因。

在App目录、原锁依赖及测试字体就绪后：

```bash
flutter test --no-pub test/chat/support/tool_images_decode_probe.dart --plain-name 'one image loads only on expansion and opens the existing viewer'
flutter test --no-pub test/chat/tool_images_test.dart
flutter analyze --no-pub
```

复现器放在support且无 `_test.dart` 后缀，普通chat目录自动发现不会重复注册整份测试。正式测试文件保留所有9案和4张既有golden；不更新golden。Android未编译，未跑全量Flutter、App JVM或真机。本项不宣称消除全部历史chat门禁问题。
