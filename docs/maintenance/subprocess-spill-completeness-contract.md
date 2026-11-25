# subprocess 完整 spill 写入约定（644）

基底为 main `63e255fab5cb9d817af30b631c3643ccce8e9231`（v1.0.11），内核0.2.2-rc.1。本文先于实现记录：spillPath 是完整原始输出的恢复位置，不能在普通文件短写后继续宣称完整；内存 tail、raw-byte total、原有 spill 上限不变。

真实故障来自公开 LocalSubprocessRuntime.spawn：自有测试进程在Linux RLIMIT_FSIZE=1024下收集普通Node的8192字节输出，内存tail64、spill预算16384。内核writeSync实际返回1024且未抛错；原实现忽略返回值，最终返回文件仅1024字节的spillPath，却报告total8192。限制只作用于该测试进程及其自有子进程，不改变全局quota、不填盘。

spillAll必须完整写完每个prior chunk与当前chunk，或沿既有catch执行discardSpill和一次onFailure；任何不完整文件不得作为spillPath发布，原始内存tail继续可读。完整文件仍依原保留合同留存，不新增清理策略。

最小实现使用Node内置writeFileSync(fd, Buffer)替换两处writeSync调用。本机Node24.22.1该函数Buffer分支明确while(length>0)调用writeSync并扣除实际written，且isUserFd时不自行close；现有collector继续拥有fd并在discard/seal关闭。无需新增通用写循环/接口/依赖，不改变stdout处理顺序。

验证必须真实内核短写，不替换系统调用结果；观察器只透传记录。覆盖单次大chunk、先保留prior再overflow、无错误完整spill、失败后后续任务复用。只控制自有进程/临时数据，不测Android/SSH。补丁会影响runtimeVersion，pins/版本由本机正常录制，不在此提供。
