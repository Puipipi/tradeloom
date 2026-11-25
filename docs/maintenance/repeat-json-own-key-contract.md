# 重复工具提醒的合法 JSON 自有字段合同

Refs W17-B：正常工具参数数据一致性，无对应公开 issue 编号。

基底63e255fab5cb9d817af30b631c3643ccce8e9231，DSH0.2.2-rc.1。重复工具提醒按工具名和完整canonical参数识别连续相同调用。合法JSON对象的每个自有字段都是数据，包括名为`__proto__`的普通文档字段；字段值不同不得仅因此被归入相同调用。对象键递归排序忽略插入顺序，数组元素顺序与字符串值保持；阈值及每Agent计数归属不变。

私有sortJsonValue的临时字典改为Object.create(null)，使逐key赋值保留所有JSON自有键。没有新增公开API、依赖或wire字段；不修改预览裁切、不修改实际工具参数或执行结果、不触及权限或对象原型。仅内部canonical字典使用null原型，最终仍JSON.stringify后用于原chain key。

正式live由真实CLI/Agent/native ToolRuntime运行自有只读回显工具，公开object schema允许附加字段。六案：自有特殊名字段不同值、普通字段不同值、相同参数、同语义对象键顺序不同、嵌套数组内自有键不同值、数组顺序不同。各3次工具调用与4次本地模型请求；阈值[2,3]。不依赖私有canonical函数，不使用假Agent或安全实验。

这是独立可回退runtime补丁，会改变runtimeVersion。Android 未编译；不代表真实远程模型、PTC、所有失败执行路径或移动设备性能已验证。npm发布包不含上游测试源码，不宣称上游完整套件通过。
