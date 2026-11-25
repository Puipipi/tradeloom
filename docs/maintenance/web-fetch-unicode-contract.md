# web_fetch 合法 UTF-8 内容截断合同（670）

基底63e255f，DSH0.2.2-rc.1。实施前已用自有普通HTTP UTF-8 text/plain、text/html，经真实Cordis WebRuntime/HTTP provider和ToolRuntime公开admission/execute重现三处裁切产生孤立high surrogate：provider maxBodyChars、HTML转换前源输入、最终带footer输出。

长度预算仍是UTF-16单位，不改成码点/字素。provider maxBodyChars原合同为正finite，允许小数；保留slice对正小数取整语义，先按原cap切前缀，仅当切点左右为合法high/low配对时退一单位，不增加依赖。原truncated判定不变，包括不足一个单位的正cap。

工具沿用其已依赖的truncateWithoutSplittingSurrogatePair，处理renderBody源输入及带footer的prefix；不新增helper或接口。该现有helper在实际裁切后去末端high，未裁切输入原样保留；本次测试源都是合法UTF-8。小于78的输出分支普通HTTP URL/header前缀是ASCII，本次未证明Unicode正文能到达，保持原slice不改。

保留原footer、truncated/meta与总长度上限；保留HTTP验证、重定向、timeout、取消、字节cap和HTML转换机制。工具render/presentationMeta原memo不变。不修复任意已损坏输入，不宣称所有历史自定义provider无效Unicode输出等价。

可证后果仅为返回JavaScript字符串中不再由本次合法配对裁切制造孤立surrogate；不等于已经测出网络非法UTF-8、JSON拒绝、模型错误或设备崩溃。会改变runtimeVersion，不改pins；Android未编译，真实模型/PRoot/ARM未运行。
