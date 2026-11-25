# 插件详情正文取消错误归属（658）

基底为 63e255fab5cb9d817af30b631c3643ccce8e9231 / v1.0.11，DSH 0.2.2-rc.1。实施前先确认以下既有行为边界；不新增协议字段或错误类别。

公开 `fetchBody` 的请求阶段 catch 已优先检查 caller signal、再检查服务 lifetime，将其原始取消 reason 原样抛出。正文阶段应采用相同顺序。正常调用在响应头前后取消，不应仅因阶段不同而变成 `DetailFailure('network')`。

本修仅在正文迭代 catch 起始补相同检查。调用者与 lifetime 均未取消时，真正网络断连、现有请求 deadline 的 network 分类、正文过大 too-large、正常字节输出均保持。若两种取消同时成立，沿用请求阶段 caller 优先顺序；不新增优先级。

取消已使原生 fetch 关闭响应；这不是连接泄漏修复。测试使用真实 HTTP 和公开 fetchBody，观察同一 Response 的公开 iterator 入口、返回原 iterator，不额外读字节。deadline 控制仅触发测试专用 AbortSignal，不等待真实 30 秒，不能称自然墙钟超时验收。

plugin-manager 的详情读取使用此 helper；其将 DetailFailure 转为 detail-unavailable，图片路由映射 network 为 502。此上层影响仅源码分析，没有证明 App 展示或实际 CDN 请求结果。无 URL/权限/认证、UI、构建配置修改。Android 未编译；PRoot/ARM 未运行。
