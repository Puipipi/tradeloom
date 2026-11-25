# read 长行内部 CR 的截断标记合同

基底63e255f，DSH 0.2.2-rc.1。实施前源合同：read逐行展示以UTF-16单位限长，超过上限应加原有截断标记；真实末尾CR（CRLF或EOF前CR）按既有语义剥除，内部CR不应掩盖超长事实。

公开实际read输入2000a+CR+tail被max+1缓冲裁为2000a+CR，stripCarriageReturn误去内部CR，原输出漏标记。最小修复将缓冲由N+1改N+2，不增加flags或改变截断函数。若完整行L<=N+2，仍完整判断真实末端CR；若L>N+2，截取末端即使恰好是CR并被剥除，剩余至少N+1，仍触发标记。保留前N单位、原marker、offset/limit/行数及按最终输出计算byte cap；额外最多一个UTF-16单位常驻行缓冲。

668在truncateLine修合法代理对，本组在buildWindow仅改缓冲上限，独立不依赖668；组合也保留668需要的N+1邻居。修正后marker增加真实输出字节，靠近byte cap时原错误纳入行可能被正确整行排除，不声称全部边界输出逐字相同。

只修展示，不改文件、权限、取消、解码或接口。真实公开工具测试不等于真实模型/Android验收；Android未编译，PRoot/ARM未运行。会改变runtimeVersion，按owner流程重录，不在本包改pins。
