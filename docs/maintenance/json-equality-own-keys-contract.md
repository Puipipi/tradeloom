# JSON结构相等的自有字段合同

Refs W17-B，公开JSON函数数据一致性，无对应公开issue编号。基底63e255fab5cb9d817af30b631c3643ccce8e9231。

公开deepEqualJson声明比较两个JSON兼容值是否包含相同JSON数据。JSON.parse创建的普通自有字段`__proto__`也是合法文档数据，isJsonValue接受；对象成员比较不能以继承属性代替缺失自有字段。不同自有字段的对象应双向不等，相同字段应双向相等。对象键插入顺序不影响相等，数组顺序有意义。

修复仅将记录分支`key in right`替换为`Object.hasOwn(right, key)`。不改变===、null/类型判断、数组长度/顺序、递归值比较或公开接口；没有对象原型赋值、权限/账号逻辑或新依赖。测试全部用JSON.parse合法数据，先用公开isJsonValue确认域，再比较结果与输入不变。

实际证据限定公开函数合同，不声称translator、历史PTC日志或模型配置下游已经发生真实损坏。会改runtimeVersion，Android 未编译。无App/UI/资产修改。
