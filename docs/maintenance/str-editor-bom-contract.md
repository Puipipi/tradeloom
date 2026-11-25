# str_replace_editor 编辑保留 UTF-8 BOM

Refs W17-B，无对应公开issue编号。基底63e255f。本变更会改 runtimeVersion；Android 未编译。

仅 str_replace/insert 的元数据恢复，不改变 view/create、逐字匹配、CRLF/LF、insert行号、replaceIfVersion与sandbox错误映射。不是rc.1新增缺陷；工具是可选str_replace_editor，不是默认Plugins页bundle。

LocalFS readText消耗一个原始UTF-8 BOM。修改后写回须恢复该格式标记，同时保持正文FEFF（包括第二个首FEFF与new_str主动提供FEFF），不能去重。仅已知info.size等于Buffer.byteLength(before,"utf8")+3时，在原匹配/行号验证成功后通过公开readByteRange读首3字节；确为EFBBBF才加一个标记。无BOM常见路径无额外文件读取；unknown size沿旧行为。保BOM后端size等于编码before，guard不补，这是源码证明，不宣称自定义后端动态覆盖。第三方其它文本规范化不在保证范围。

附加读取沿原signal、try/catch，最终仍原replaceIfVersion，不承诺跨读取原子快照或修改版本规则。使用readByteRange不是readBytes(max3)，后者是完整文件上限而非前缀读取。

正式9案全部真实Context/Tools.execute/LocalFS；无FakeAgent或FakeFS。原BOM两路径、无BOM、双首BOM、显式正文FEFF及CRLF逐字失败不写。相关editor-view-format完整7案保持；无真实Agent、远端模型、Android/PRoot/ARM验证。
