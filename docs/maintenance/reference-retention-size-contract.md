# 会话引用裁剪的精确字节数复用

Refs W17-B，无对应公开issue编号。基底63e255f；本变更会改 runtimeVersion。Android 未编译。

仅改`retainReferencedSession`内部第二个shorten循环，不更改公开字段、捕获时点或存储所有权。每条消息仍独立读取来源；preview/spill沿用其原snapshot。没有跨消息/跨调用缓存。

原57补丁已令第一drop循环维护精确renderedBytes：初始值等于TagSafe JSON的UTF8字节数；每次删除一项扣其JSON字节数和一个逗号。newest必留，删除前至少两项，故扣逗号始终精确。其他项及metadata不变，第二循环入口仍有renderedBytes=size()。

第二循环以该精确值判断超限并计算overflow。每次retained[longestIndex]赋值后立即重新size()，恢复不变量。因此选最长项及并列顺序、每轮目标、截断标记、正文、预算失败、omittedBytes及所有返回字段与原算法相同；仅去掉重复全量序列化/UTF8测长。若执行k次shorten，包含初始size的相关测长从2k+2次变k+1次，不计函数外其它序列化。

既有reference-drop-cost四规模无shorten路径的完整对象序列化计数由2变1，测试仅机械更新该成本断言；已有内容与预算golden不变。新手动live使用真实Host/Agent、自己的闭合来源Session及本地模型HTTP gate，两条公开steer输入进入同一步，仍各读一次来源。

性能不是功能错误修复。固定1/8MiB、AB/BA各3样本；1MiB AB中位退约4.4%，8MiB两顺序中位较低但噪声高。不得宣传全规模稳定收益或设备加速。完整模型请求存在真实运行路径/时间/session/端口及其衍生输出预算差异，需独立保留；不能把归一后的引用上下文相同写成raw请求完全相同。旧记录及日志不修改，不改变模型正文或授权。
