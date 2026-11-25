# 会话枚举与 runtime 控制命名空间

精确的 sessions 根级 `.dsh-go-lifecycle` 是本 runtime 删除接缝拥有的租约与 tombstone 控制目录，不是 JSONL 项目目录。`listProjectDirs` 仅排除这个保留名；不按点前缀排除其它目录，不改变合法点开头 SessionId。当前官方有 cwd 项目编码为 `--...--`，无 cwd 为 `_no-cwd`，均不能产生该保留名。

该枚举由公开 list、findLog、历史 corpus fingerprint、strict root encoding 共同使用，故排除作用于这些入口；其它真实项目的混合压缩、legacy flat、根目录错误、取消和676的单项隔离规则不变。删除 marker 的直接 stat、writer 的身份/产物双租约、mutation 的直接租约入口完全保留，不依赖将控制目录当成项目扫描。

有限真实12会话观测中，原版额外读取控制目录及12个ID槽和_mutations，14次；修复后这14次为0，列表仍返回12个正确ID。48会话同形数据节省50次控制树目录读取。只证明冗余I/O消除，不证明手机启动时延改善，不把它认作#38/#57设备慢的根因；#527旧权限故障已由其它工作处理，不重复交付。PRoot/Android未测、Android未编译；vendor补丁及pins会改变构建计算的runtimeVersion。
