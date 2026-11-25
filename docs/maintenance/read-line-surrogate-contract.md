# read 单行裁切合同（668）

Refs W17-B：正常 UTF-8 文本读取的结果完整性，无对应公开 issue 编号。

readMaxLineLength 保持 UTF-16 code unit 上限，不改成码点或字素计数。仅在实际需要截断且预算边界位于一个合法高/低代理对之间时，将保留末端退一个单位；否则字节相同。原截断标记仍报告配置上限。

不改变 offset、limit、总行数、CRLF/EOF、按最终正文及标记计算的字节预算、文件读取/权限/取消行为。lineBufferCap=max+1 已保留判断合法配对所需的后一单位，无需扩大缓冲。公开工具文本与结构化 lines 应一致；whole/stream 都经过同一表现函数。

不处理字素簇、不重解释原始非法输入、不修改写入工具或新增参数。实际原版公开工具已有三案证据；正式门禁使用真实临时文件、公开工具执行和合法流阈值配置，无私有 chunk 注入。Android 未编译；无真机、ARM 或 PRoot 验证，不能据此关闭 #570。新增 runtime patch 将改变 runtimeVersion。
