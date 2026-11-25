# 媒体私有下载写盘错误归属

实施前约定：沿用现有 MediaError.storage，不增加协议字段或错误码。普通调用入口为 media-engine 的视频任务 succeeded → createStreamStager → writeStagedChunk；HTTP 已正常返回时，本地写入失败不应报告 network（无法连接生成服务）。

本补丁只在明确的本地文件 write、sync、正常 close 调用边界，将原生失败转换为 storage。网络请求和响应读取的失败仍为 network；既有 MediaError 原样保留。超时/主动取消由既有 control.signal 优先处理；无法确认安全清理时 cleanup_failed 仍优先。已写部分文件依旧按原 inode/目录身份校验清理，不改变产物提交或删除合同。

生成器已取得供应商的 `succeeded` 回执后，非取消的下载、校验或保存错误应保留既有安全错误码，例如 `storage` 和下载器的 `timeout`；不能仅因仍有 task id 就覆盖为 `remote_may_continue`。只在查询尚未确认成功时沿用原未知状态覆盖。清理失败、主任务取消/超时及确认远端取消的优先级保持不变；预算预留、结算时机和续查不重新提交的规则也不变。`completed-video-errors.test.js` 从公开工具入口验证最终 `get_media_result`，并以子进程文件大小限制触发真实写入失败；外部供应商回执和 Host 服务/任务注册为测试夹具。它不证明真机、真实供应商或生产 30 分钟时限已经跑过。

真实 Linux 自有进程 RLIMIT_FSIZE=1024、忽略该测试进程 SIGXFSZ，以本地 HTTP 的8192字节触发真实短写后EFBIG。原版正确拒绝及清理，但误报network。512字节在相同限制下成功，8192字节无限制成功，均保持原始字节/哈希；失败保留已有非临时文件。这个限制仅作用测试子进程，不模拟write返回，不修改机器全局配额。无法在此验证的sync/close平台故障仅按源码错误边界说明，不冒称真实故障覆盖。

独立媒体 npm bundle 不在当前 runtime/build-runtime.sh inputs_sha 的 patches/bridge/boot/direct集合，不改变现行 runtimeVersion。源码应用后需重新打包安装媒体插件；本补丁不指定/发布新版本，不修改构建配置或pins。Android 未编译；PRoot/ARM 未运行。
