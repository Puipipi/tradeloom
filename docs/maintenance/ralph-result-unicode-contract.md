# 可选Ralph结果文本的Unicode边界（680）

基底63e255fab5cb9d817af30b631c3643ccce8e9231，DSH0.2.2-rc.1。Refs W17-B：本轮显式挂载的官方Ralph真实CLI消费者发现，无对应公开issue编号；不宣称默认配置自动启用该工具。

Ralph成功结果的父模型文本包含固定说明、格式化报告及必要的截断标记。maxResultChars保持原有合法范围和UTF-16代码单元预算；未超限时原文返回，预算只容得下标记时仍按现有规则取标记前缀。可保留正文前缀时，若裁切点恰在合法surrogate pair中间，退一代码单元，不输出半个字符，同时保持原截断标记及总预算。

本项不改变Ralph何时可以调用、显式人类请求约定、fresh-child隔离、轮数、报告schema/状态解释、错误或取消结算。报告自述完成仍不是独立认证。未将普通任务自动转成Ralph，不新增默认挂载，不修改workflow/subagent，也不回写任何历史事件。

真实live门禁使用自有profile显式挂已有官方模块，测试用户明确请求Ralph，最多一轮，真实子Agent与公开structured_output；不提取私有formatter或使用假workflow。它依实际CLI/fresh-child环境，命名为-live.mjs并手动运行，不扩普通CI前提。最终README说明实测预算与请求数量，不把有限成功路径扩大为默认16384预算、多轮、取消或全Ralph验收。

会改runtimeVersion；pins/版本由所有者录制。Android 未编译，PRoot/ARM和真实设备未验证。
