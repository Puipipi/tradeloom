# 手机操控诊断状态

Refs #570。诊断包和引擎内的诊断 Markdown 使用现有 `dsh/phone` 的 `status` 只读调用采样；不使用可能未订阅的界面缓存，不开启手机操控、不请求权限、不读屏、不触发 root/Sui 操作，也不新增平台方法。

`summary.json.phone` 为固定字段集合：`available` 表示本次原生状态读取可用；可用时另外记录 `enabled`、`bridgeListening`、`a11y.enabled` 和 `a11y.serviceConnected`。不可用、异常或超时只记录 `available:false`，不把整次不可用写成无障碍已关闭。读取使用诊断采集已有的5秒上限和降级逻辑，不能阻断其它诊断内容。此顺序读取最多新增一段5秒等待；Dart超时不会取消底层状态查询，晚返回值不会改写已形成的快照。

依赖当前63e原生 `PhoneControl.status()` 的完整字段合同及已有 `PhoneStatus` 解码；其布尔缺省规则不变，不能声称能识别任意旧版/不完整 Map 中的字段缺失。`a11y.enabled` 是系统设置中的启用状态，`serviceConnected` 是本进程已注册主屏 driver 的连接事实，不证明手势能成功。

只导出这五个布尔值，不导出任务描述、应用名称、屏幕、剪贴板、插话或原生错误文本。Markdown 使用同一采样结果。状态是生成报告过程中的本机快照，不是失败 tap 的同时记录，也不描述远端主机的无障碍状态；生成时间沿用整个诊断快照的时间，不保证各源原子采样。

本项补观测，不能据此宣称修复 #570。不会改 runtimeVersion；Android 未编译。
