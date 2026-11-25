# 本地会话文件夹名称的20字符合同

Refs W17-B（普通状态持久化，无对应公开issue编号）。不会改 runtimeVersion。Android 未编译。

这是v1.0.11已有普通本地名称合同问题，没有证据表明由rc.1升级新增。maxName=20数值不变。

文件夹创建/编辑的现有TextField使用maxLength=DrawerViewController.maxName=20，按Unicode grapheme计数；_submit仅trim/判空/同名检查。文件夹只保存在本机每Host SharedPreferences JSON中，没有外部20 UTF16协议或存储上限。

状态层_clean由substring(0,20)改为取trim后前20个完整grapheme，与现有用户输入合同对齐。创建、改名共享该归一化。19ASCII加emoji、组合重音或ZWJ序列构成的第20字符都完整保留；超过20则保留前20字符。21字符测试是直接公开状态API限长控制，页面maxLength=20本身不会送入第21个字符；不把全部控制称为页面合法输入。仍先trim，不改空/同名策略、key归属/owner守卫、持久化时序或既有数据迁移。

通过Flutter既有widgets公开导出的StringCharacters扩展使用原锁characters1.4.1，不新增依赖或修改锁。不同于有Host120UTF16上限的终端695，不能只退一个单位而丢掉合法第20个字符。

正式公开ProviderContainer/DrawerViewController/SharedPreferences mock测试，统一收集内存、保存JSON、独立container重载三点后断言；不是实际Android存储或UI验收。原版最终6案实际5红1绿；最初3案因任务消息交错提前执行，单独历史不叠计。仅正常合法字符串，不尝试修复原已损坏历史名。
