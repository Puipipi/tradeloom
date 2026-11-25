# 静态视图的规范化字节预算

Refs W17-B，无对应公开 issue。基底 a1928136c2429d967b5442e1f9a74963800a5836。

Native bridge 的视图值预算为 32768 字节（stats.bytes / JSON.stringify(view) 的 UTF-8 长度），不是整个 HTTP 响应 envelope 的总长度。静态文件的磁盘大小检查仍保留，但 JSON.parse/toJson 可能改变表示长度，例如数值 `1e20` 规范化为21位十进制数字。静态路径现在同时检查规范化的 JSON 字节数，再发布到缓存，使它与动态视图的既有字节预算一致。

超额仍返回 HTTP500 / invalid-view，不新增违规计数。无法规范化的既有 plugin-error 路径、JSON数字与own-key语义不改。精确等于预算允许，原有节点/深度提示与限额也不改。此修复不处理并发文件替换或读取竞态。

真实 HTTP 测试使用生产 NativeCore、路由和 toJson；Loader身份沿既有模块fixture，不是完整Cordis插件或Android端测试。合法对象包含科学计数法数值：raw8052字节、规范化35252字节，原路由200，候选500；nodes1/depth1。本证据证明通用JSON预算缺口，不声称该任意metadata字段是App组件绘制合同。完整static-view-cache模块覆盖精确32768字节、正常under、重复读取、文件修复恢复、动态视图、不可规范化对象与旧缓存行为。

此bridge源文件属于runtimeVersion输入，会改runtimeVersion。Android 未编译；App组件实际绘制、真机及PRoot未验证。没有运行sync-bridge或手工编辑App生成资产；bridge/lib同步由owner现行流水线完成。
