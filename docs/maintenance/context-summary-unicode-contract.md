# Notice摘要的Unicode截断边界（678）

基底63e255fab5cb9d817af30b631c3643ccce8e9231，DSH0.2.2-rc.1。Refs W17-B：本轮公开导出函数与消费者验证，无对应公开issue编号。

公开boundContextSummary继续使用120个UTF-16代码单元预算；短于或等于预算的输入逐字返回，超过预算才保留前缀并追加省略号。当原截断点恰位于合法high/low surrogate pair中间，向前退一单位而不输出半个字符。ASCII、BMP、完整落在前缀内的pair与既有省略规则保持；不改成码点或字素预算，不全串展开/转换，不修复原输入中已有的孤立代理项。

既有model切换、jobs、goal、subagent notice生产者继续调用同一公开函数，无新增API、wire字段或协议。只保护此后生成的摘要；旧摘要已属于持久化Session事件，不重写旧日志，也不声称旧值自动恢复。模型请求或Session原文中的完整内容不因摘要裁切被修改。

门禁按最终README分别列出公开helper与真实消费者范围，不把仅源码发现的调用方都称已动态验证。会改runtimeVersion，pins/版本由所有者录制。Android 未编译；PRoot/ARM/真实设备未运行。
