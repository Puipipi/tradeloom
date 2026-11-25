# Android 系统字体发现（#202）

运行时启动环境为 Linux 字体发现提供 `XDG_DATA_DIRS=/usr/local/share:/usr/share:/system`。原有系统目录顺序保留；当前 libreoffice-kit 为各项拼接 `/fonts`，因而可发现 PRoot 已绑定的 `/system/fonts`。用户字体目录仍由转换器按 HOME/XDG_DATA_HOME 发现。

登录 shell 的 profile 只在变量未设置时补同一默认值；显式空字符串或自定义列表保持原样。主引擎不依赖登录 shell，默认值直接进入 launch template；App 后置 GUEST_ENV 的显式值仍覆盖它。用户显式 office `fontDirectories` 配置仍有优先权，本改动不覆盖它、不改 `XDG_DATA_HOME`、字体替换规则或资源限额。

Direct 启动解析同一 guest environment，新增 `/system/fonts` 使用 Android 的真实路径。Direct 原有 `/usr/local/share`、`/usr/share` 未映射为 rootfs 内物理路径的问题未改变；本项不承诺 Direct 与 PRoot 的所有字体来源等价。

当前 0.1.5 WASM 对 #202 原 DOCX 的宿主对照：默认仅嵌 DejaVu，第一页中文空白；追加现有 NotoSansCJK TTC 所在字体根后嵌 NotoSansCJK、第一页中文可见。两者 missingFonts 都含 Microsoft YaHei，而且两者均可提取中文文本。字体缺失列表、文本可提取或全页像素差均不能独立作为绘制正确性证明。这只是发现机制和样张的有限证据，不是手机复现、全中文兼容性或完整排版验收。

`runtime/tests/test_font_environment.py` 调真实 rtbuild 生成器，通过真实 env/sh 核默认值、后置覆盖及 profile unset/custom/empty 行为。重建运行时会因 rtbuild.py 输入变化而改变 runtimeVersion，版本由现有构建流程生成。本项不修改 pins 或依赖。Android 未编译；JVM、PRoot、ARM、实机字体读取与文档预览未运行。
