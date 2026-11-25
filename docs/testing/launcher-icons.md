# 桌面图标切换与模拟器验证

第一次从默认雾蓝切到其他图标时，原默认入口会暂留到回到桌面。Android 会关闭通过显式禁用组件打开的任务，因此不能在这个任务还显示着 App、浏览器登录页或文件选择器时禁用它。切换不会主动重建 Activity；非默认入口之间切换使用 `DEFAULT` 恢复 manifest 的关闭状态，保留当前页面。

`LauncherIconPlugin` 在 Stop / Destroy 后立即检查清理条件；每次 `set` 完成也检查一次，覆盖先按 Home、后完成后台切换的竞态。启动时和新任务 Resume 时重新检查，处理进程在两次组件写入之间结束的情况。恢复计划优先采用合法的已保存选择，覆盖刚切换就重启、PackageManager 异步组件写入尚未落盘的情况；`current` 仍报告实际已启用入口，未完成写入时不虚报成功。过期的 Recents 卡片（`numActivities=0`）不阻止清理。锁屏、熄屏、默认入口任务上还有别的 App、或无法确定任务顶部时继续等待；关闭外部页面后再次回到桌面即可完成。再次点击旧默认入口启动，仍需等这次任务离开前台。

快速连选按串行 worker 顺序写入；每次清理重新读取最后选择，不保存过期的目标。原雾蓝入口禁用后，回到雾蓝使用 `LauncherMistAlt`。入口数恢复为 1 与 OEM 桌面缓存刷新是两件事；本测试分别记录组件、Launcher 查询和截图，不用强停桌面来掩盖缓存问题。

## Debug 探针

安装正常的 debug App 即可，使用完整 App 入口以便验证页面保留。探针只在 `FLAG_DEBUGGABLE` 时动态注册，广播发送者还必须持有 `android.permission.DUMP`。正式包不注册。以下命令只用于专用模拟器；不得用于用户手机。

```bash
export ANDROID_SERIAL=emulator-5556
pkg=io.github.ccch1mneyyy.dsh_app
probe() { adb shell am broadcast -a "$pkg.ICON_PROBE" -p "$pkg" "$@"; }
# 先正常打开 App，然后调用与 Dart 相同的 onMethodCall("set")，不是 pm enable/disable。
probe --es cmd state --es seq before
probe --es cmd set --es id night --es seq night
adb shell input keyevent KEYCODE_HOME
probe --es cmd state --es seq home
adb logcat -d -s DshIconProbe:I '*:S'
adb shell cmd package query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p "$pkg"
```

每条 `DshIconProbe` JSON 包含 `seq/status/current/enabled/states/tasks`，以及 `activity/engine/foreground/destroyed/task`。`states` 是 PackageManager 原始状态（0=DEFAULT，1=ENABLED，2=DISABLED），`enabled` 按 manifest 默认值计算有效入口。没有 `status=ok` 不能视为切换成功。`state` 只读取；清理来自真实生命周期或 `set` 完成。

需要从默认入口重做用例时，先强停模拟器里的 App，再用 `pm default-state` 将五个 alias 恢复为 manifest 状态，然后从 `LauncherMist` 启动。这只是测试前置状态，不是切换验证。不要清数据，否则会丢掉页面、聊天和其他探针配置。

```bash
# API 35 may require root for the fixture-only component reset.
# Save chosen=mist through the probe before force-stop, then reset aliases.
probe --es cmd set --es id mist
adb root
adb wait-for-device
adb shell am force-stop "$pkg"
for alias in LauncherMist LauncherMistAlt LauncherNight LauncherFrost LauncherInk; do
  adb shell pm default-state --user 0 "$pkg/.$alias"
done
adb shell am start -n "$pkg/.LauncherMist"
```

## 必须记录的路径

| 路径 | 前台 / 中间态 | 最终有效入口 |
| --- | --- | --- |
| 默认雾蓝 → night → Home | 切换返回后仍是同一 Activity、同一 engine；Mist + Night | Night |
| 默认入口连续 night → frost → ink → Home | 始终至多 Mist + 最新选择 | Ink |
| 默认入口 night → frost → mist → Home | 回雾蓝取消延迟 | Mist |
| Night → Frost → Mist | 无须等待、Activity 不变 | 最后为 MistAlt |
| set 后从最近任务划掉 | Stop / Destroy 触发清理 | 最新选择 |
| 开文件选择器后 set，再 Home | 原任务顶部 DocumentsUI；保护该任务和选择器 | 暂留两个；返回选择器并 Back 后，再 Home 剩最新选择 |
| set 后立刻强停 / 重启 | 下次启动按实际任务恢复；经新入口 Resume 后旧任务可清理 | 最新选择；若重开旧入口则等 Home |
| set 后熄屏 / 锁屏 | 保留解锁后的页面 | 解锁并 Home 后剩最新选择 |

外部 Activity 用 `probe --es cmd picker` 从当前 MainActivity 打开系统 DocumentsUI；确认 `tasks[].top` 是外部包且 `base/orig` 为默认 alias，再 `set`。如果系统选择器另开了独立任务，该次运行不能证明同任务外部页面保护，应改用实际浏览器 Custom Tab。

Destroy 兜底可用 `probe --es cmd finish`，同时还要跑真实 Recents 划掉。验证返回 App 后页面仍保留输入和滚动位置，`dsh/app` 的时区方法及普通设置仍可用；engine 身份不变只是辅助证据。

为了稳定复现 Home 与 worker 的竞态，先恢复默认入口，再执行：

```bash
probe --es cmd hold --es seq gate
# logcat 中确认 gate / held。门最多保持 8 秒，避免测试挂住 worker。
probe --es cmd set --es id frost --es seq raced
adb shell input keyevent KEYCODE_HOME
probe --es cmd release
probe --es cmd state --es seq raced-home
```

`raced` 应返回成功，`raced-home.enabled` 只有 Frost。在旧实现中 Stop 看不到稍后才置位的延迟标志，没有下一次 Stop 时两个入口会一直留下。

## 验证层级

纯 JVM `LauncherIconsTest` 覆盖上述清理策略、快速选择、未知顶部和空 Recents 卡片，但不能代替 Android 生命周期、组件管理和桌面缓存验证。Gradle 集成编译、完整 App 模拟器运行及 vivo 桌面验证应分别记录，不把纯测试或手动 `pm` 状态写入当作实际修复证据。

重启用例应通过系统 MAIN/LAUNCHER 查询启动当前有效入口，不能固定启动可能已回滚为禁用的目标 alias。若只剩 Mist，打开后应恢复已保存目标，Home 后收敛为单入口。adb 立即重启也用于模拟组件写入未落盘的边界。
