# 扩展静态语言的构建入口

[English](i18n-static.en.md)

本文描述 `app/tool/l10n_merge.py --locale` 的构建准备能力。默认仍只生成中文、英文。放入俄语、日语、韩语或西班牙语草稿，**不会自动使应用支持这些语言**；语言设置、系统语言解析、原生/插件边界和实际显示还需独立实现与验证。

## 文案来源与显式选择

来源保持分片结构：`app/lib/l10n/parts/<area>_<locale>.arb`。`zh` 是模板，`en` 始终必需；额外语言用重复的 `--locale` 参数显式选择。支持规范 ARB locale 形式，如 `ru`、`ja`、`ko`、`es`、`es_MX`、`zh_Hant`。不接受路径片段或 `ru-RU` 这种带连字符的形式。脚本/地区语言必须同时选择基础语言，例如 `--locale es --locale es_MX`；`zh_Hant` 的基础 `zh` 已默认包含。

```sh
# 现有中英流程不变：
python3 app/tool/l10n_merge.py --check
python3 app/tool/l10n_merge.py

# 仅检查某个翻译草稿分片，不写文件，不运行生成器：
python3 app/tool/l10n_merge.py --part common --locale ru

# 检查全部分片后生成所选语言：
python3 app/tool/l10n_merge.py --check --locale ru
python3 app/tool/l10n_merge.py --locale ru

# 同时显式选择多个完整语言：
python3 app/tool/l10n_merge.py --check --locale ru --locale ja --locale ko --locale es
```

新增语言的完整构建必须为每个 area 提供对应分片，键集合与中文模板一致，值非空，参数集合一致，结构预检查通过。不自动用英文补齐缺失译文，也不将机器生成的文案标成已审核。`--part` 只是局部编写检查，不能作为语言发布验收。需要预览生成的 ARB 而暂时不运行 Flutter 时，使用 `--no-gen`。

模板 `@key` 元数据是生成器的类型来源。普通正文允许各语言按语法使用不同 ICU 结构：中文的 `{count}` 可以对应俄语的 plural；不要求不同语言的复数分支逐项相同。`plural` 接受已知类别和现有数字选择器，必需 `other`；拼错类别与重复分支失败。`select` 的语义分支要由审阅者核对，不能因为占位符集合相同就判定翻译正确。

## 防止草稿被意外编进应用

未显式选中的 `<area>_<locale>.arb` 不读取、不合并。Flutter 会扫描根 ARB 目录，因此如果 `app/lib/l10n/` 留有未选中的任何 `.arb`（包括 `draft_ru.arb`），完整检查/生成会失败并列出文件名；工具不会擅自删除这些文件。切换回中英构建时，使用干净工作副本，或在确认它们是本工具生成物后人工移除，再按来源重新生成。

发布启用额外语言时，需要把所选 `--locale` 参数同步到**所有**生成与 CI 入口，并单独更新 App 的支持语言及设置入口。此快照不包含所有构建调用方；本文不假设它们已完成同步。直到该工作与语言审核完成，保留默认中英构建。

不要手工编辑 `app/lib/l10n/app_*.arb` 或 `app/lib/l10n/gen/`。完整仓库中运行本工具会调用 `flutter gen-l10n`，后者才是当前项目 Flutter 版本的最终 ICU 语法与强类型生成检查。Python 预检查不宣称完整 ICU 支持，也不计算运行时复数。

## 验收

```sh
python3 -m unittest discover -s app/tool -p test_l10n_merge.py -v
python3 -m unittest discover -s app/tool -p test_console_encoding.py -v
python3 app/tool/l10n_merge.py --check
# 选定语言完整后，在项目规定的 Flutter 工具链中：
python3 app/tool/l10n_merge.py --locale ru
(cd app && flutter analyze && flutter test test/l10n)
```

还需人工检查术语、权限/删除/凭据提示，检查俄语 1/2/5/11/21/22/25/101 和小数的复数规则，验证小屏与放大字体、系统语言回退、已存设置升级、插件及原生文本。仅通过键完整性与 Python 测试不能宣称新语言正式支持。
