# 工具结果码点计数：减少中间数组

基底为 63e255fab5cb9d817af30b631c3643ccce8e9231，DSH 0.2.2-rc.1。仅优化公开 codePointLength 的实现，不修复功能错误，不改变裁剪策略。

原实现 Array.from(text).length 对每个码点构造数组。真实 pruneSession 的 pruneContent 先计数原文，随后再次计数原文；pruneContent 另有用于保留头尾的数组，本次保持不变。

新计数从 UTF16 length 开始，对相邻有效 high/low surrogate pair 减一并跳过 low。普通BMP、ASCII、孤立high/low各计一；组合字符与ZWJ仍按多个码点计，不变成字素计数，也不归一化输入。等价理由：JS字符串迭代器对有效high+low一次消费两个UTF16单位并产出一个码点，其余每个单位产出一个码点，因此计数等于UTF16长度减有效相邻pair数。扫描配对后跳过low避免重复计数，孤立单位仍计一。保持原阈值、head/tail、marker、rich block顺序、TokenMeter估价、shadow-price事件、替换记录和原日志。第二次裁剪仍无新变更。

先测后优化：固定真实Session/Registry/TokenMeter/pruneSession的1MiB与8MiB A/B、B/A。数值扫描原型8MiB中位减少约23%与41%，每组只有3个计时样本；1MiB第一对几乎无益。64KiB ASCII/纯emoji仅作小控制。此前for-of机制明显退化，历史数据保留。性能数字不是CI断言，不能推导实际Agent压力触发、PRoot、ARM或Android收益。

普通测试只使用已有prepared prefix与Node，延迟读取DSH_TEST_PREFIX或DSH_PREFIX；手动benchmark-live入口无新增依赖，打印完整结果与原始样本。功能原版应全绿，不制造first-red。npm发布包没有可运行的上游完整测试，原仓库也没有直接pruner专项测试，故不冒称这些套件已运行。

本改动增加runtime vendor patch，会影响runtimeVersion输入；版本与pins由本机既有流程生成。本包不改pins。Android 未编译；无实际模型、完整Agent触发或设备验收。
