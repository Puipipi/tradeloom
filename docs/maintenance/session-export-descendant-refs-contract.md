# 子会话导出附件引用复用合同（649）

本优化仅在 ZIP descendants 内部读取路径复用 persistence handle.read 返回的 validated SessionEvent，避免把刚序列化的每行再 JSON.parse 一次。公开 readSessionLogText、sessionLogZipEntries、streamSessionLogZip 参数及返回类型不变；rootContent 字符串仍按旧路径解析，兼容直接调用者和不含子会话的导出。

先 serializeSessionLog 成功，再从同一批 events 提取已声明的附件 carrier；序列化错误仍在 finally 中 close。这里依赖 persistence 合同的 JSON SessionEvent：不是给任意带 toJSON/getter/可变外部对象新增序列化等价承诺。只保留被选择的附件引用，不保留整个 events 数组；没有跨请求缓存。collectEventAttachmentRefs 原函数及选择规则原样复用，未知事件和无关字段仍不解释。

保留根到子会话的顺序、重复 image ID 最后引用胜出、file ID+name 去重与插入顺序。每个 live session 仍先 flush 再 open/read/close；任一读取/序列化失败仍终止 ZIP。ZIP 路径、字节内容、压缩等级、队列背压、取消信号、附件完整性验证及流读取不改变。部分响应已经发出不能回滚，未增加成功保证。

验证明确区分：公共 route/Response/fflate 和自有服务 fixture 用于精确重复解析计数；另有真实 Cordis+Session+JSONL create/append/flush/reopen/read/close 链。后者的 descendants 列表仍由明确的 query fixture 提供，不称完整 Host/真实 session-query/HTTP 认证/Android 实测。
