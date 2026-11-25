# Plugin manager 锁等待与 owner 生命周期

基底63e255f。manager 的 owner 卸载会中止 lifetime signal；普通 mutation 在等待自有 profile/package.json 文件锁时也应退出等待，不能继续保有默认 ref'ed retry timer。只把该 lifetime signal 接入已有 withFileLock options，保留 waitMs、文件锁内容、业务操作和公开RPC字段。不是新增逐请求取消。

已取得锁后的原取消检查继续存在；正常竞争仍可取得锁并执行。等待取消沿既有抛错路径传播 AbortError，timers/promises 的 AbortError 可通过cause携带原reason，不承诺错误对象identity不变。

公开Host owner卸载已测原生retry timer仍ref'ed。没有等待120秒，不能宣称所有CLI退出被拖慢：dsh bin的plugin子命令对runPlugin结果调用process.exit；profile-boot的process shutdown普通完成设置exitCode，而interrupt走forceExit，dispose尚未完成时有5秒强制退出计时器，正常dispose完成即清除。主动退出可以越过event-loop排空。产品修复范围是服务owner生命周期，不是改变CLI退出机制。

Android 未编译；PRoot/ARM未运行。此runtime补丁改变构建内容，runtimeVersion须由本机依既有流程录制；不提交pins。
