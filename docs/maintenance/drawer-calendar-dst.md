# 抽屉按本地日历分组

Refs：源码回归排查，无新增公开 issue。不会改 runtimeVersion。

`sessionDayOf` 的合同是本地日历分组，周一开周，昨天优先于本周，未来日期沿既有行为归今天。生产 `now` 来自 `drawerClockProvider` 的本地 `DateTime.now`；本项保留传入 `now` 年月日字段的原语义，不额外转换 UTC-now。

纽约 2026-03-08 与 03-09 的本地午夜仅相差23小时。把两个本地午夜的时长截断成整天，会把昨天归为今天，也会把前两天的47小时归为昨天。修复把已经取好的当地年月日放到UTC日期轴后比较，使民用日期的一天固定24小时。实际会话时间仍先 `toLocal`；这不改变会话时间戳、排序、文件夹或持久化数据。

真实调用链：`SessionSummary.fromJson` 经 `asEpochMs` 读取 `session/list` 的毫秒时间；`drawerBlocks` 根据活动或创建时间选择分组键，调用 `sessionDayOf`。新用例同时覆盖这两种分组路径。

在 App 目录、匹配原锁依赖和测试字体就绪后运行：

```bash
TZ=America/New_York flutter test --no-pub test/drawer/drawer_calendar_test.dart
TZ=America/New_York flutter test --no-pub test/drawer test/shell/shell_logic_test.dart
flutter analyze --no-pub
```

显式纽约进程必须断言春进23小时、秋回25小时，不能跳过。默认时区也可运行这组日历用例，但默认时区通过不能替代真实 DST 覆盖。原版新10案为5通过、5失败、0跳过；失败包括纯函数与反序列化到 `drawerBlocks` 两种排序的昨日错误分组。

真机验证：在使用DST的系统时区查看春进后一日的会话，昨日应归昨天、前两日不得归昨天；切换活动/创建时间排序均一致，再检查秋回后一日、周一、置顶及文件夹成员。Android 未编译，未在真机核实；未跑全量 Flutter 或 App JVM。
