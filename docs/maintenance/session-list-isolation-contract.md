# 单项会话存储故障的列表隔离约定

Refs #591；基底63e255f，DSH 0.2.2-rc.1。

`sessionPersistence.list()`枚举的是可读且身份一致的会话。某个项目子目录、会话子目录或日志的已知文件读取故障、身份/代际不一致、不可解释格式，只使该项从本轮列表中缺席，并记录包含路径与原因的warning。其它有效会话继续返回，真实workspaceRegistry可以用这些头部完成初始化。重复物理记录声明相同会话ID时，该ID的所有歧义记录都排除，不能按遍历顺序猜选一份。

枚举不改名、不删除、不重写任何原始会话目录或日志。身份错及读后内容校验失败使用官方SessionPersistenceCorruptionError；不支持的物理布局/压缩使用官方SessionFormatUnsupportedError。文件系统错误保留原errno，取消优先于隔离。根目录读取失败、资源耗尽和未知程序错误继续拒绝，不转换成成功的空列表。

宽容枚举仅由公开list开启，不把这次扫描记成严格rootEncodingCheck成功；直接open/stat/create及历史迁移内部扫描继续原有严格入口。列表为历史代际生成corpus revision时仍包括可识别的坏头部路径；单路径stat无法读取时用包含该路径及errno的不可读标记参与指纹，不伪造其内容。之后恢复可读将改变revision。

点开头本身不表示损坏。官方SessionId编码允许`.ordinary`、`.retired-valid`等合法ID；这类头部与物理身份一致的会话仍可列出。被改名的隐藏备份、`.retired-*`残留通过身份校验隔离，不全局过滤点前缀。

#401的存量workspace.json两个ID同路径，与坏会话日志是两个独立问题；已有并发create去重不代表旧数据已修。本项不自动删行、合并ID或改写成员顺序，其当前真实复现与数据保留约束另见REPLY。安全模式独立DSH_HOME仅分析，不在本补丁实现；App重置文案不在范围。

测试使用真实Cordis、JSONL、JSON Storage、Domain、WorkspaceRegistry和自有临时文件。POSIX权限拒绝测试在root或Windows跳过，不能把跳过计为实测权限通过。Android 未编译；PRoot/ARM/真实设备未验证。会改runtimeVersion，pins由所有者录制。
