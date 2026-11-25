# 文件变更记录：失败的内容副本不得参与后续去重

Refs W17-B，无对应公开issue编号。基底为63e255fab5cb9d817af30b631c3643ccce8e9231，DSH 0.2.2-rc.1。会改 runtimeVersion。Android 未编译；ARM、PRoot及手机存储故障未验证。

## 可达问题

官方 `dsh-workspace-changes` 在文件工具修改前，按原文件完整字节的SHA-1命名临时副本。原实现以 `writeFile(path, bytes, {flag: "wx"})` 直接写入该名称；遇到EEXIST时视作已有完整副本。实际写入中途失败可能留下不完整文件，但其名称仍是完整内容的摘要。该Session后续turn再捕获相同内容时，EEXIST会使这个残留被接受，公开summary/diff遂使用被截短的旧内容。

这些副本位于每个TurnRecorder独占的临时目录，只服务当前Host中的Session变更记录，直到Session释放时删除。本问题影响变更摘要和比较内容；测试另外逐字验证用户文件及持久化会话日志完整，不将显示错误扩大为用户源文件被截断。

## 最小改动及归属

先显式 `open(path, "wx")`。只有成功取得本次独占创建的句柄时才写入、关闭；写入或关闭拒绝时，在句柄关闭尝试之后移除本次新建的副本，再传播失败。仅在打开阶段处理EEXIST，已有副本保持原去重行为。清理失败仍向外传播，不能把失败副本当作成功返回。

`captureFile` 的两个内部调用点均在 `TurnRecorder.enqueue` 任务链内：工具前的capture任务，以及turn结束的record任务；record循环逐项await。`scratchDir()`同步保存唯一mkdtemp Promise，每个recorder使用独占目录。dispose先中止生命周期、等待任务链，再删除目录。因此本模块的正常内部写入不存在同一副本的并行writer；成功独占打开后出错的文件由该任务负责清理。打开阶段的EEXIST不进入清理分支。

没有更换摘要算法、文件命名、公开RPC、变更排序、文件数量或字节预算；没有新增依赖、配置、fsync或缓存。用户原文件的写入机制不变。清理只针对本次成功独占创建的临时副本，不以预先检查存在性来推断归属。

## 真实验证入口

从应用补丁并准备运行时前缀的仓库执行：

```sh
DSH_PREFIX=/absolute/prepared-prefix DSH_EVIDENCE_DIR=/absolute/new-evidence \
  node runtime/tests/workspace-capture-recovery-live.mjs
```

该手动live测试需要Linux、Python的resource.prlimit和真实DSH CLI，不加入普通CI测试glob，不要求root。父进程只改变自身启动的Host子进程的软文件大小限制，硬限制不变；范围包围第一次官方文件工具的真实捕获写入，finally立即恢复原限制。没有填满磁盘、更改全局配额、替换I/O返回或构造私有生产者。

三个固定场景：2048字节/128行的首次捕获受256字节软限制后恢复；128字节文件在同限制下正常完成；2048字节文件不改变原限制并在下一turn复用既有副本。每场景两turn、六次自有loopback模型协议请求、四次成功的官方read/write，最终通过公共workspaceChanges.summary/diff观察结果。真实SessionController、Agent和文件服务参与，不把合成模型应答称为外部模型验证。

Golden为：故障仍产生原EFBIG warning，失败捕获不留不完整副本，下一turn重新捕获后diff保留完整128行；两个成功场景保留完整原文和修改后正文；用户文件逐字正确；经flush和真实read handle读取的已校验持久日志与live events深等；软限制恢复原值。Host由fixture在finally用SIGTERM收尾，driver退出码单独记录。

已知本地subprocess containment提示仅允许其精确原文且必须在首次捕获之前出现，不改变进程隔离设置、不忽略其它运行时失败。关闭、删除等其它系统故障仅说明源码处理边界，没有声称本文件大小限制实验覆盖了这些故障。

## 设备检查

按正常构建流程部署后，在自有普通文件上完成两次读取与修改，核对变更卡和完整比较行数。若本机有受控的自有存储故障测试环境，再验证一次记录副本写失败后下一turn恢复完整比较；不要填满用户设备或改变全局存储限制。缺少该设施时，将设备故障恢复门禁标为未运行。回退本runtime diff及相关测试、文档即可恢复原行为。
