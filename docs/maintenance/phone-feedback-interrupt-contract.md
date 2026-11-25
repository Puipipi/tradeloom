# 无障碍反馈中断与手机任务停止

Refs #570。本合同区分 Android 的 feedback interruption 与 DSH 手机任务的显式停止。Android 设备回归尚未运行，不据此宣布华为时钟问题已修复。

Android `AccessibilityService.onInterrupt` 请求打断服务正在提供的反馈；它不是服务解绑通知，也不携带用户停止 DSH 手机任务的意图。`AccessibilityManager.interrupt()` 会请求所有绑定服务中断反馈。DSH 的此回调不应因此退休 PhoneTasks owner、取消确认或中断 phone worker。

目前本服务没有持有持续 TTS、音频或振动反馈任务。悬浮条的 `announceForAccessibility` 将事件交给无障碍系统，长按球的 `performHapticFeedback` 是一次性反馈；不为这些调用增加整项任务取消。此回调只记录收到反馈中断，今后若新增本服务持有的持续反馈，必须在这里只停止该反馈。

用户在 App、通知、悬浮条、确认框、handoff 明确停止，以及屏幕关闭、服务解绑/销毁、引擎结束，仍保留各自原停止路径。禁止吞掉 worker Interrupted、忽略 owner 失效、把 gesture onCancelled 改成成功或自动重试。

仅调试构建的既有 A11yProbe 增加公开 `AccessibilityManager.interrupt()` 触发与 task 快照读取。保持 FLAG_DEBUGGABLE 和 android.permission.DUMP 门禁；不自动触发，不从助手工具暴露。该请求影响设备上所有绑定服务的反馈，owner仅在自有测试设备主动执行。

设备先行门禁：probe-only 原版中先用正常手机工具建立任务，公开interrupt后确认原版任务停止；完整候选中先确认callback到达，再核task id/lifecycle与active保持；另明确点击用户Stop仍使旧owner失效、停止后续动作。平台请求异步，不能将“已发送”当作“回调已到达”。华为时钟实际tap还需独立记录callback和停止来源，平台合同测试不替代该设备复现。

官方来源：

- https://developer.android.com/guide/topics/ui/accessibility/views/service#methods
- https://developer.android.com/reference/android/view/accessibility/AccessibilityManager#interrupt()
- https://android.googlesource.com/platform/frameworks/base/+/android-12.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityManagerService.java
- https://android.googlesource.com/platform/frameworks/base/+/android-12.0.0_r1/core/java/android/accessibilityservice/AccessibilityService.java
- https://android.googlesource.com/platform/cts/+/android-12.0.0_r1/tests/accessibilityservice/src/android/accessibilityservice/cts/AccessibilityEndToEndTest.java
