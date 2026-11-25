# 图片显示名截断的Unicode边界（679）

基底63e255fab5cb9d817af30b631c3643ccce8e9231，DSH0.2.2-rc.1。Refs W17-B：本轮真实公开图片存储API发现，无对应公开issue编号。

图片显示名继续取路径最后一段、去除控制字符并trim，至多保留255个UTF-16代码单元，不改变名称缺省/清理后为空时省略的行为。如果截断点恰在合法surrogate pair中间，则向前退一单位；不返回半个字符，不添加省略号，不扩大预算，不转为文件名字节预算。已有fileLeafName的UTF-8存储叶名规则不改。

图片对象仍按内容hash存盘。显示名属于返回的reference metadata，readImage按已有约定原样返回显示字段；本修复不增加name侧文件、不修改内容hash或图片字节，也不重写已有Session中的reference。不能把一次save/read通过说成App/模型或Session完整消费已验证。只保证新接收合法完整Unicode名称时，截断不会新制造孤立代理项；原本损坏的输入不在本修复的清洗范围。

会改runtimeVersion；pins/版本由所有者录制。Android 未编译，PRoot/ARM/真实设备未运行。
