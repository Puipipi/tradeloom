# 重复工具提醒参数预览Unicode边界（683）

基底63e255fab5cb9d817af30b631c3643ccce8e9231，DSH0.2.2-rc.1。Refs W17-B，本轮真实CLI消费者发现，无对应公开issue编号。

previewArguments仅控制给模型看的canonical参数前缀，不控制实际参数或完整重复检测chain key。保留argumentsPreviewChars正整数校验、UTF-16代码单元预算、阈值、原marker格式及未超限原文返回。超限时仅在cap恰跨合法surrogate pair时退一单位；遗漏数必须按canonical.length减实际end计算。此cap是前缀预算，原marker额外占长度，不将它变成整条文本总预算。

不改sortJsonValue、重复判定key、工具调用参数/结果、已有通知来源或执行语义；682 own-key修复独立。不修复输入本来存在的孤立surrogate，不做codepoint/grapheme预算、全串展开、缓存或新增依赖。

真实消费者用正常自有document工具与headless Agent/本地Messages，三次完全相同参数后第四个请求观察detailed reminder；thresholds[2,3]，一般cap500、最小正cap1控制。不假Agent/fiber，不提取私有preview。真实CLI环境按ADD6命名-live.mjs，不扩普通CI前提。远程模型、设备或默认所有业务路径未运行。

会改runtimeVersion，由owner录制pins/版本；Android 未编译，PRoot/ARM未运行。不修改旧Session事件。
