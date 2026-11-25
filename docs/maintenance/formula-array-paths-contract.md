# 原生插件公式的数组路径与 App 保持一致

Refs W17-B（插件协议兼容性；无新增公开 issue）。

`sdk/plugin-kit/lib/formula.js` 是 App 有界公式求值器的对应实现。公式的数据来自 JSON；数组可以通过非负数字下标读取，不能把 JavaScript 数组对象本身的 `length` 属性当成 JSON 数据字段。真实对象中名为 `length` 的字段仍然可以读取，对象的数字字符串键也保留已有行为。

原 SDK 用统一的 `hasOwnProperty` 读取数组和对象，所以普通 `{ rows: [2, 3] }` 上的 `data.rows.length` 得到 2，公开 `checkView` 也不报告公式缺失。App 的 `evaluateDshUiFormula` 经 `dshUiLookup` 读取 List 时只接受数字索引，同一公式结果为缺失并在 `view.value` 留下诊断。插件作者因此会得到不能在 App 重现的本地校验结果。

修复只在 SDK 公式读取路径遇到数组时排除点字段，沿原失败出口返回缺失。公式语法、运算、资源上限、JSON 对象字段、数字下标与 `$` 绑定语义都不变。不增加 `length` 运算，也不修改 App 生产源码、布局、资源或协议格式。

## Golden 与复现

`sdk/plugin-kit/test/formula-array-paths.test.js` 通过实际 `evaluateFormula` 与 `checkView` 检查十案：非空、空、嵌套及根数组的 `length` 为缺失且出现 `view.value` 诊断；数组、嵌套数组、根数组的数字下标有效；对象 `length` 数字和十进制字符串有效；对象数字键有效。原源码的前四案失败，后六案原本通过。对照不使用伪数组、自定义属性或宿主对象。

从仓库根目录运行：

```sh
node --test sdk/plugin-kit/test/formula-array-paths.test.js
node --test sdk/plugin-kit/test/*.test.js
```

`app/test/plugins/view/plugin_formula_array_consumer_test.dart` 另外通过真实 `parsePluginView` 及其公式求值入口验证数组 length 为缺失、合法下标和对象 length 为 2。这三案在 App 未修改的源码上本来就通过，是独立兼容性参照；不能把 SDK 自己生成的期望文件当成双端一致的唯一证据。测试不修改生成的 parity 期望、schema、翻译或资产。

合并时按现有 `sdk/plugin-kit/scripts/sync-skill.mjs` 同步插件技能所携带的 SDK，并执行其检查入口；本补丁只交权威源码。准确生成命令与实际运行范围见交付 README。不会改 runtimeVersion：本项不改运行时版本计算纳入的 patches/bridge/boot/direct 或构建输入；同步更新的是 App 所携带的插件技能检查器。Android 未编译；不据 Linux 源码与测试结果宣称已在真机核实。
