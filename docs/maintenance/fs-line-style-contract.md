# 长首行文件的行尾写回

editText、patchText、moveFile 将文本归一化为 LF 后处理，再按读取时识别的原风格写回。原前4096 UTF-16单位采样若包含LF，继续原CRLF多数、平票LF规则；不改变混合行尾的既有归一化策略。

仅当样本完全无LF时，从sample.length起寻找第一个LF。其前单位是CR则选择CRLF，否则LF；全文无LF仍选LF。此补足首行超过采样窗口时纯CRLF文件的识别，也包含CR恰在sample末端、LF刚在窗外的情况。不是全文多数统计，不承诺混合行尾逐项保留，不改变公开before/after的LF文本、版本锁、原子发布、BOM或move删除结果合同。

旧rc.4同样存在此缺口，不称升级新引入。此runtime vendor补丁会改 runtimeVersion；Android 未编译。Refs W17-B，无对应公开issue编号。真实公开LocalFileSystem测试只使用自有普通文本，无权限/私有回调模拟。
