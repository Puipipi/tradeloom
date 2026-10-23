# BingusSharedLoader 方法映射与 TradeLoom 当前验收基线

状态：**完成本轮只读方法审计；不是 TradeLoom 全项目完成声明。** 日期：2026-10-21。未修改产品运行代码，未启动或停止应用/服务，未发起模型或 ERP 请求，未安装、构建、打包或上传。

上游固定为 [BingusSharedLoader `9471bcb16f3a479efdff3e0520def4573ae0a028`](https://github.com/CowboyBingus/BingusSharedLoader/tree/9471bcb16f3a479efdff3e0520def4573ae0a028)。最终方法 JSON SHA-256 `92550944D689FC464D5C0FB0707B6148C6425F243637CAA69636299A6EA95AF6`，方法 Markdown SHA-256 `C86C05C0BCF023157774EADFA6D3F80BCB7BB713738C014CC71B5A046E346CCE`，阅读 ledger SHA-256 `556676CE450914992E2F424A171785E8E0C70C1C8DB5F7F6252FCEAF9DF83688`。本轮按 16 项作者主题拆为 43 个 leaf checks；另列 N01–N06 六个不采用的专用机制与 O01–O03 三个审计观察。66 个文本源文件已完整阅读，2 个 PNG 仅核对清单，没有作为方法输入。

本文把**采用决策**和**验证状态**分开。`部分`表示可定位到实现或证据但范围不足；`未执行`表示没有对应产品行为证据；技术上不适配的上游机制单独列在“不采用”中，不把产品目标误记为已通过。所有上游源路径与行号都相对固定 commit。

## 审核顺序

- 固定上游commit、源码清单与阅读覆盖；分离作者方法和审计观察。
- 按43个独立leaf逐项判定采纳与验证状态。
- 将产品源码、特定测试/日志和GUI/provider证据绑定到对应层级；历史证据不得跨版本外推。
- 单列六项具体不采用机制，不把技术差异当成产品通过。
- 单列三项上游观察；不将观察误记为作者建议。
- 列出未执行项与最小下一步；不操作运行实例、不读取凭据、不重跑测试。

## 基线与证据边界

TradeLoom 基线为 branch `feature/workbench-shell`、HEAD `ea61736d3d7366c9c7436a330bb90d7e831a40ad`；采样时有 81 个 dirty/untracked 项。本审计没有重置或改写这些文件。冻结清单保存在项目外验收证据 `desktop-package-contract/unified-workbench-erpnext-20261021/theme-style-freeze-20261021.json`，SHA-256 `A58CD94C45795771BB5C634FCDD73F1BBEABD03B06C3F23A8DAFEAB96C916B2C`；其 21 个 package.files、package.json 与 3 个 Django 集成文件 hash 均与当时源文件匹配。该清单不随 Git 仓库提供。

最新 Site 主题原生窗口验收记录的 SHA-256 为 `28153926322DB2B9A7295EACAC1D1A76378C318CE59AD9F162A9CED40A798CF8`，bundle SHA `48813c1be56f59c600bf5092e04b9f8aaa5855d947d27f191e46dd979ce33618`，manifest 与上述 25 项 source 文件集相符。该记录只证明主题、助手选择器、边距等所列 GUI 项；不能证明鼠标 Dockview 面板拖放、整套 workflow、安装版或所有平台。真实 DeepSeek Flash 记录位于项目外验收证据 `real-provider-gui-20261021/acceptance.json`，SHA-256 `4E9A682915A08A27D61BBE778398AF9AABFFF27951388EC7DBB55488E4CB46C5`，仅覆盖演示数据下有限提案、澄清和只读工具。

当前已保存的自动化记录（不是本轮执行）：

- Renderer：`pnpm exec vitest run --config testing/desktop-package-contract/main-slot-renderer/vitest.config.mjs --reporter=verbose`，exit 0，7 passed。
- Shell：`node --test --test-reporter=spec packages/tradeloom-shell/tests/scenes.test.js packages/tradeloom-shell/tests/shell.test.js`，exit 0，42 passed, 5 skipped。
- Django：2026-10-20 全量 327/327、exit 0；日志 `<LOCAL_EVIDENCE>/run-full-final05-673e7847cfe94e259e3adde742f70524/workbench-full-final.log` SHA-256 `099C10BAA2B7ED4DE165FF724876A5E75DCD57C69993AC7B1076957323B6A426`。这不是 Dockview/ERP 当前树的最新全量结果。

### Node/launcher 历史结果核对

2026-10-20 的旧 Node/launcher 全套命令为 `node --test --test-reporter=spec @files`（PowerShell先收集两个测试目录的显式文件数组）；结果为 131 项：121 pass、2 fail、8 skip，exit 1。原始日志保存在项目外验收证据 `desktop-package-contract/framework-suite-current-20261020/framework-suite.log`，SHA-256 `02997DF3069DFDAAC72E401390C6502AE01B1B538D6A3FF1EEED513FAAD2ACC4`；两项失败记录归因为默认 `slots-1` 与 `desktop-2` runtime 缺 `@deepseek-ai/cordis`。其后可定位的 candidate7 profile 定向复跑为 2/2、0 skip、exit 0，命令 `PowerShell: TRADELOOM_DSH_TEST_RUNTIME=candidate7; node --test apps/tradeloom-launcher/tests/profile-contract.test.mjs`；日志保存在项目外验收证据 `desktop-package-contract/framework-suite-current-20261020/profile-contract-candidate7.log`，SHA-256 `A319CF3430AEC79CD0A7F9D541F6DC42743C42562783A374E2775E8176AE33AB`。这只校正该定向文件，不把 131 项全套改写成通过。

另有父级摘要提到一轮 163 项/2 fail，归因为旧 runtime 缺 Cordis。在已检查的项目外验收证据索引中未找到该轮对应的完整日志、命令、时间或 exit 记录，因此标为**不可定位**，不以此数字替换 131 项，也不编造补跑结果。

## 43 个独立 leaf checks

每行独立对应最终方法清单中的一个可判定子项。状态只根据该条件自己的产品证据判定；父级方法有其他测试不自动提升本行。

| Leaf | 上游要求与源 | TradeLoom对应证据 | 采用决策 | 子项判断与下一步 |
|---|---|---|---|---|
| **M01.1 版本身份由两份二进制散列组成** | `docs/AUTHORING.md:65-76; scripts/archive.py:10-12; src/build_gate.lua`；记录产品版号、main/Host协议及关键资源digest的映射。 | apps/tradeloom-launcher/bootstrap-core.mjs:184-207,271; apps/tradeloom-launcher/receipt-writer.mjs:12-74; 本次25项source freeze hash匹配。 | 调整采用 | 部分: 产品有main/Host与bundle receipt/hash证据；本轮未核安装版实际identity receipt。 下一步：安装候选时逐项比较应用版本、Host协议及资源hash。 |
| **M01.2 未知/读失败时关闭扩展加载但保留原始游戏启动** | `docs/AUTHORING.md:67-95; tests/test_build_gate.lua:194-224,251-293`；启动失败回归同时断言应用生命周期仍可正常退出、服务未产生半初始化状态。 | apps/tradeloom-launcher/bootstrap-core.mjs:184-207,271; 既有profile-contract定向测试2/2。 | 调整采用 | 未验证: profile契约通过不直接证明未知runtime/读失败时扩展关闭且原始应用仍正常启动退出。 下一步：针对未知runtime版本和receipt读取失败分别检查安全拒绝及正常退出。 |
| **M02.1 对比旧版本可观察合同而非实现细节** | `tests/test_contract.py:1-17,24-48; tests/test_contract.py:140-193; tests/fixtures/loader-contract.json`；对比renderer-host消息、Django路由、API schema和退出时序的外部可观察合同。 | packages/tradeloom-shell/tests/business-tools.test.js:109-144,168-267,307-481; workbench/agents/tool_contracts.py:154。 | 采用契约测试原则；不采用游戏GUID/Lua全局名/Wwise身份 | 部分: 具体覆盖工具对象schema及结果投影；没有涵盖所有renderer-host、Django和退出事件的旧新版合同基线。 下一步：挑选稳定公开的Host消息、Django响应及桌面生命周期合同做版本化差异测试。 |
| **M02.2 以capabilities代替内部版本数值分支** | `docs/AUTHORING.md:134-172; docs/THIRD_PARTY_REFERENCE.md:16-29; tests/test_contract.py:33-45`；提供产品能力清单并按能力做feature detection，不让插件比较内部build number。 | packages/tradeloom-shell/business-tools.js:33-57,530-592; 当前shell package来源与实际注册固定在Cordis配置。 | 采用契约测试原则；不采用游戏GUID/Lua全局名/Wwise身份 | 未验证: 尚无证据表明所有可选能力均以能力发现代替内部版本号分支。 下一步：逐个检查可选依赖的feature detection合同并增加未知能力回归。 |
| **M02.3 依赖工具链版本固定** | `CONTRIBUTING.md:3; dependencies.json`；release使用锁文件和确定的runtime版本，并将版本/哈希记录进receipt。 | packages/tradeloom-shell/vendor/dockview-package-lock.json; packages/tradeloom-shell/scripts/build-dockview-chunk.mjs; theme-style-freeze package.json及lock hashes。 | 采用契约测试原则；不采用游戏GUID/Lua全局名/Wwise身份 | 部分: Dockview与构建工具链有版本锁及源hash；全桌面/ERP构建依赖和安装receipt没有在本轮统一核验。 下一步：对所有运行时工具链和安装依赖列锁定版本及receipt来源。 |
| **M02.4 版本化黑盒合同并规范动态字段** | `tests/contract_snapshot.lua:1-6,20-53,194-245; tests/test_contract.py:1-48,140-221`；为Electron renderer-host协议、Django API响应及业务事件建立带版本的外部合同快照；仅规范化时间戳、临时路径等已批准动态字段，保留安全相关字段严格比较。 | packages/tradeloom-shell/tests/business-tools.test.js:109-144,168-267,307-481; workbench/agents/tool_contracts.py:154。 | 采用版本化黑盒合同和受控动态字段归一化 | 部分: 工具schema/结果有契约测试；未发现renderer-host和所有公开Django响应全面版本化快照。 下一步：选定稳定公开API建立schema snapshot并只规范化已批准动态字段。 |
| **M03.1 优先级按数值与明确顺序处理** | `docs/AUTHORING.md:97-128; tests/test_discovery.lua:101-140,156-180`；业务路由/插件冲突按明示优先级测试，避免依赖文件系统枚举顺序。 | packages/tradeloom-shell/client.js:160-168; packages/tradeloom-shell/tests/scenes.test.js。 | 调整采用；不采用Lua/Wwise加载顺序 | 未验证: 已测试现有场景注册/入口；未找到多个冲突插件按数值优先级及稳定次序解决冲突的直接证据。 下一步：若产品出现优先级竞争，增加逆文件枚举顺序的冲突测试。 |
| **M03.2 声明/影子副本规则明确** | `docs/AUTHORING.md:97-128,142-168; tests/test_discovery.lua:80-140,156-180`；manifest和实际部署包一致性、重复插件来源应有冲突测试。 | packages/tradeloom-shell/package.json:16; packages/tradeloom-shell/host.js:129-218; freeze manifest。 | 调整采用；不采用Lua/Wwise加载顺序 | 部分: 部署文件清单明确并哈希匹配；没有完整验证重复/影子组件来源冲突如何处置。 下一步：为重复panel/模块身份和shadow来源增加拒绝或确定性选择测试。 |
| **M03.3 格式损坏和隐藏读取失败不得阻塞后续项** | `docs/AUTHORING.md:108-128; tests/test_discovery.lua:141-207; tests/test_discovery_integration.lua:1-27`；对单个tool、bundle文件或非关键provider错误做故障注入，确认其他功能与基本UI继续工作。 | packages/tradeloom-shell/tests/business-proxy.test.js:148-227; workbench/diagnostics.py:78。 | 调整采用；不采用Lua/Wwise加载顺序 | 部分: 代理的超限/断流/错误脱敏有定向测试；没有覆盖所有插件配置损坏和非关键资源枚举失败。 下一步：逐项故障注入单个bundle/provider失败，确认其余shell功能继续加载。 |
| **M03.4 资源枚举限制读取并释放native handle** | `docs/TECHNICAL.md:3-31; tests/test_discovery.lua:214-244`；限制上传/manifest解析尺寸、清理文件句柄并测异常中断。 | packages/tradeloom-shell/proxy.js; packages/tradeloom-shell/tests/business-proxy.test.js:148-227。 | 调整采用；不采用Lua/Wwise加载顺序 | 部分: 请求体边界和不完整转发有测试；没有枚举native资源并证明每条异常路径都释放handle的对应资源契约。 下一步：若引入文件/native枚举，单独测读取上限及正常/异常释放；不能用HTTP流测试替代。 |
| **M04.1 包装必须保留原始启动参数和完整返回元组** | `scripts/build.py:110-121; tests/test_discovery_integration.lua:1-30; tests/test_build_gate.lua:1-8,184-190`；bootstrap与主进程事件封装需保留返回值、事件顺序和原始退出语义。 | apps/tradeloom-launcher/bootstrap-core.mjs:184-207,271-292; apps/tradeloom-launcher/cli.mjs:135。 | 调整采用错误局部化、取消/退出及协议边界契约；不移植Lua回调实现 | 部分: 启动参数/子进程归属有实现与文档；没有对应Lua包装完整保留多返回元组的技术需求，等价产品外部返回合同未全测。 下一步：为启动参数、退出码、Host回执的可观察合同增加集成断言。 |
| **M04.2 一次性启动钩子要有可验证时序** | `docs/AUTHORING.md:196-242; tests/test_after_startup.lua:1-20,87-180`；初始化/退出/业务任务提交只触发一次且顺序可测试。 | apps/tradeloom-launcher/cli.mjs:135; packages/tradeloom-shell/client.js:160-168。 | 调整采用错误局部化、取消/退出及协议边界契约；不移植Lua回调实现 | 未验证: 源码有启动注册时序；本轮未找到一次性启动钩子被恰好触发一次及其顺序的独立回归。 下一步：在隔离launcher里记录初始化/关闭事件序列并断言一次性行为。 |
| **M04.3 一次性回调错误被隔离且有上限** | `docs/AUTHORING.md:224-242; tests/test_after_startup.lua:181-362`；为队列/回调系统设错误边界与资源上限；安全日志不包含敏感body。 | workbench/diagnostics.py:78; packages/tradeloom-shell/tests/business-proxy.test.js:148-227。 | 调整采用错误局部化、取消/退出及协议边界契约；不移植Lua回调实现 | 未验证: 安全错误摘要/代理失败边界存在；没有给通用回调队列错误数与上限建立直接测试。 下一步：若存在回调队列，测试单回调抛错隔离、计数上限与安全日志。 |
| **M05.1 解析时校验包头、范围和长度** | `scripts/archive.py:37-48; tests/test_package.py:35-47; tests/test_discovery.lua:192-207`；对ASAR、manifest和provider schema做边界/长度/版本校验。 | packages/tradeloom-shell/tests/business-proxy.test.js:148-227; packages/tradeloom-shell/tests/business-tools.test.js:109-144,168-267,307-481。 | 采用来源/hash/结构交叉核验 | 部分: 请求长度/超限与工具schema有边界验证；没有证明所有archive/package输入头和长度字段在导入时都校验。 下一步：将外部资产解析的头、范围、长度与版本校验逐项连接到负例测试。 |
| **M05.2 输入版本/头与编译mode双校验** | `CONTRIBUTING.md:3-5; scripts/build.py:124-146`；校验官方payload版本与实际manifest hash，防止静态存在被误当可用。 | apps/tradeloom-launcher/receipt-writer.mjs:12-74; packages/tradeloom-shell/package.json:16; theme-style-freeze-20261021.json。 | 采用来源/hash/结构交叉核验 | 部分: receipt与bundle源hash存在；本轮没有当前官方payload头与编译mode双校验的完整集成记录。 下一步：安装候选上对官方runtime版本、manifest与编译模式做同一收据检查。 |
| **M06.1 release build运行分层离线测试** | `scripts/build.py:149-165,197-211`；package命令前执行产品当前gate集合，并保存每个子命令真实exit证据。 | freeze renderer7/7、shell42 pass/5 skip；历史Django327/327；launcher历史Node记录131:121/2/8及不可定位163摘要。 | 调整采用分层门禁；替换游戏LuaJIT/HUD/Arsenal专用层 | 部分: 项目按层运行过测试；本轮方法审计未运行任何测试，且没有证明每次release build强制调用完整相关门禁。 下一步：将构建入口与当前分层门禁关联并保存每条真实exit，不把旧套件结果移植到新源码。 |
| **M06.2 宿主专用环境缺失以skip而不是伪通过** | `scripts/build.py:201-208; tests/test_jit_budget_game.py; tests/game_lua.py; CONTRIBUTING.md:31-44`；将skip记为skip，并单列真人provider、原生GUI、phone、host部署等未验项。 | theme-style-freeze记录shell5 skipped；旧Node131记录8 skipped；候选profile定向2/2。 | 调整采用分层门禁；替换游戏LuaJIT/HUD/Arsenal专用层 | 部分: 已将部分宿主依赖缺失记为skip并对单个profile做candidate7复跑；旧131全套和skip没有全部补齐。 下一步：找到完整163证据或明确其不可定位；运行时缺失继续真实标skip。 |
| **M07.1 manifest部署路径集合必须准确** | `scripts/build.py:213-237; scripts/package.py:18-51; tests/test_package.py:20-34`；对installer/asar文件清单逐项校验，阻止临时诊断文件进入产物。 | packages/tradeloom-shell/package.json:16; theme-style-freeze核对21项package.files及package.json。 | 采用精确package.files清单与哈希原则；不采用Arsenal ZIP/sidecar格式 | 部分: 当前shell发布白名单与源码匹配；没有扫描含所有模块的asar/NSIS实际文件集合。 下一步：对最终安装器和asar做真实清单比对，证明临时文件被排除。 |
| **M07.2 ZIP元数据规范化但不等于全链跨机复现** | `scripts/package.py:52-62; tests/test_package.py:20-34`；固定打包时间/文件顺序并说明工具链版本，比较是否可重现。 | packages/tradeloom-shell/vendor/dockview-package-lock.json; packages/tradeloom-shell/scripts/build-dockview-chunk.mjs。 | 采用精确package.files清单与哈希原则；不采用Arsenal ZIP/sidecar格式 | 未验证: 锁定输入依赖但未做两次独立构建的产物比较；不能证明ZIP/包元数据或跨机可复现。 下一步：对相同锁/工具链执行两次干净构建并比较规范化产物，限定环境结论。 |
| **M08.1 Pin要求clean为真且未清洁原因列表为空** | `scripts/pin_tested.py:53-71; tests/test_pin_tested.py:105-116`；实际条件是`clean is True`且`not_clean_because == []`，不是“没有clean原因”这一概括。 | site-theme-verification-20261021.json；当前freeze source hashes matched。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 未验证: GUI记录绑定bundle/manifest；没有产品pin gate直接检查`clean`布尔值为真且`not_clean_because`为空列表的证据。 下一步：为产品runtime_verified/pin校验构造clean为假、原因列表非空及clean为真的隔离用例。 |
| **M08.2 Pin要求到达目标场景及正常引擎退出** | `scripts/pin_tested.py:60-65; tests/test_pin_tested.py:110-116,126-135`；真实桌面生命周期需记录窗口关闭后的子进程close码和资源释放。 | local-native-quit-20261021/lifecycle.json SHA B70A6BC964A89EAB9C1A3DA10C10B8D478F00A9B8308D46704B0CC17ED1FDDFF；docs/work-report.md原生退出条目。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 部分: 菜单退出后的真实进程结束及重开持久状态已验；目标游戏场景/正常engine-exit不可移植，其他产品层结束语义未覆盖。 下一步：分别记录本机source与安装版窗口/子进程关闭结果，不把X隐藏当退出。 |
| **M08.3 Pin要求无dump且安装恢复** | `scripts/pin_tested.py:66-67; tests/test_pin_tested.py:116-120`；升级验收核profile持久化、无crash且回滚路径未破坏。 | 本地菜单退出/重开保留workflow证据；p8安装历史首启曾Web RPC失败。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 部分: 已证明source-mode无重执行并保持交付状态；没有安装恢复/升级修复以及崩溃dump完整性对应证据。 下一步：安装候选验证更新失败回滚、工作区恢复和crash/dump状态。 |
| **M08.4 Pin要求支持的精确游戏build** | `scripts/pin_tested.py:68-69; scripts/archive.py:10-12; tests/test_pin_tested.py:118-119`；receipt的产品main/Host/build身份和manifest需一致。 | freeze25项hash；site-theme-verification-20261021.json bundle/manifest匹配。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 部分: 当前source GUI与清单关联；支持版本matrix未覆盖安装版p8和所有runtime变体。 下一步：按精确支持的runtime/app组合创建来源矩阵与拒绝未知版本回归。 |
| **M08.5 Pin只承认确切部署ZIP的SHA** | `scripts/pin_tested.py:74-99; tests/test_pin_tested.py:97-101,119-135`；将实际运行版本与被验installer/asar SHA绑定。 | p8历史安装receipt不含本轮source变化；当前只有source manifest SHA。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 未验证: 没有确切当前安装ZIP/asar SHA与本次GUI run绑定的证据。 下一步：如产生获准安装候选，核对该候选原始artifact SHA与实际运行receipt。 |
| **M08.6 Pin要求相符日志与现源码构建resource** | `scripts/pin_tested.py:102-135,153-157; tests/test_pin_tested.py:126-158`；对installed main/Host/bootstrap/UI chunk与候选源码逐项hash对照。 | site-theme-verification-20261021.json bundle SHA 48813c1be56f59c600bf5092e04b9f8aaa5855d947d27f191e46dd979ce33618 与manifest SHA；source 25 files matched。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 部分: 该GUI记录和本批source资源hash一致；未证明所有运行日志/构建resource/安装bundle都一致。 下一步：在候选run中将日志、receipt、实际资源hash关联并检查一致性。 |
| **M08.7 Pin的失败必须解释且无写入** | `scripts/pin_tested.py:160-173; tests/test_pin_tested.py:140-165`；只读dry-run必须不变更receipt/状态，失败摘要不宣称通过。 | 本轮未运行pin/dry-run脚本；上游脚本静态清单见固定commit。 | 采用分层授证原则；不采用TestHarness字段/游戏里程碑 | 未验证: 没有直接证明pin失败报告原因且无任何写入。 下一步：对产品只读验证命令做失败前后状态hash对照和安全摘要测试。 |
| **M09.1 开发探针产物路径与release隔离** | `CONTRIBUTING.md:16-18; scripts/build.py:33-58,181-190`；debug/local bundle不得覆盖受审release目录。 | packages/tradeloom-shell/package.json:16 excludes testing; main-slot-renderer probe in testing tree。 | 采用开发probe与正式文件清单隔离 | 部分: 精确source清单排除probe路径；未检查一个实际发行包。 下一步：最终候选扫描开发构建标记、临时renderer probe及fixture。 |
| **M09.2 包和隐私审计拒绝探针版** | `tests/test_package.py:15-18,31-39; scripts/privacy_audit.py:105-121`；检查构建通道与开发/probe标志可判定，开发产物不得被当作正式验证产物。 | 当前source manifest记录；未运行产品发行检查。 | 采用开发probe与正式文件清单隔离 | 未验证: 没有实际测试证明发行检查会拒绝开发/probe构建。源方法JSON里的`tradeLoomCheck`属于迁移建议，不等同作者要求；签名建议本轮不纳入验收门槛，因为拒绝probe不推出必须签名且当前核验为source-mode。 下一步：针对开发通道和probe标志构造显式拒绝用例。 |
| **M10.1 隔离manager fixture并验证全部载入/卸载组合** | `CONTRIBUTING.md:52-58; scripts/test_arsenal_packages.cjs:1-24,60-126; docs/DISCOVERY_VALIDATION.md:17-27`；在独立profile/DB上验证升级/回滚/启停组合，检查无真实profile修改。 | 独立PG历史fixture停止记录；workbench ERP client支持transport注入与离线测试。 | 采用隔离fixture原则；不引入HDArsenal/HD2MM/游戏内存API | 部分: 已有多个隔离fixture/数据库证据；未验证全部外部manager加载卸载组合。 下一步：逐个integration fixture核唯一端口、唯一DataRoot与正常停机证据。 |
| **M10.2 依赖组合与加载顺序矩阵** | `tests/test_overlay_compatibility.lua:15-41,49-120,123-193; tests/test_hud_compatibility.lua:15-79; tests/test_discovery_integration.py:14-26,50-110; tests/test_discovery_integration.lua:16-60,141-188`；对可选provider、插件/业务bundle、Host service与renderer注入做隔离组合测试；覆盖加载顺序、缺模块、重复启动、取消/关闭转发和局部故障。 | candidate7 renderer、shell、pinned Cordis/ToolRuntime定向验证记录；131全套及profile定向记录。 | 调整采用provider/bundle/Host注入组合矩阵；不引入HUD/ECS/Wwise/FFI/PE | 部分: 覆盖若干真实依赖组合；163项报告不可定位，且没有全加载顺序矩阵。 下一步：基于可复核的runtime组合记录只补缺失组合，不把定向结果叠加成全套通过。 |
| **M11.1 publication inventory与Git index集合约束** | `scripts/privacy_audit.py:73-90; publication-files.json:1-63`；发布物只从经审的manifest清单导出并核source tree。 | theme-style-freeze核25 source files；Bingus inventory observation记录68 tracked vs 63 allowlist。 | 调整采用敏感变量过滤、错误脱敏和文件清单；不复制上游游戏账号/路径正则 | 部分: 产品包有精确文件白名单，但产品Git/publication集合的全量inventory gate没有在本轮执行。 下一步：对产品tracked、发布白名单和产物集合做集合差异审计。 |
| **M11.2 识别敏感模式但不回显匹配值** | `scripts/privacy_audit.py:12-53,123-129; tests/test_package.py:48-52`；输出安全类别而非原值；限制扫描范围并记录遗漏/误报限制。 | apps/tradeloom-launcher/core.mjs:131-170; packages/tradeloom-shell/business-tools.js:33-57。 | 调整采用敏感变量过滤、错误脱敏和文件清单；不复制上游游戏账号/路径正则 | 未验证: 代码存在环境值过滤/固定响应投影；没有本轮扫描日志、截图、Git历史和发布目录的隐私审计结果。 下一步：按产品敏感类别运行不回显匹配值的静态/日志审计并记录漏报限制。 |
| **M11.3 历史作者身份检查为仓库专用规则** | `scripts/privacy_audit.py:92-104`；如需历史身份核验，应采用TradeLoom自己的签名/组织策略，独立配置并测试。 | 本审计未运行产品Git作者身份扫描。 | 不采用上游特定作者姓名/邮箱正则；若审Git作者身份须使用TradeLoom自己的组织策略 | 未执行: 此子项仅讨论上游可选的作者身份规则；不采用上游个人姓名/email正则，不能据此声称产品身份审核通过。 下一步：仅当发布策略需要时另定义组织签名/身份验证规则并单独测试。 |
| **M12.1 每份验证声明绑定版本与范围** | `docs/DISCOVERY_VALIDATION.md:1-9,33-38; docs/MIGRATION_VALIDATION.md:1-10; README.md:66-68`；说明版本/模式/设备限制；不同验收环境证据分开保存。 | docs/work-report.md分批八字段记录；docs/acceptance-matrix.md当前范围；Site及real-provider验收分别绑定hash。 | 采用按证据层级声明状态 | 部分: 多个证据层按版本和范围记录；163套件记录与部分未跟踪文件差异仍不可核。 下一步：每项状态只引用同一源码/bundle的具体证据，继续分开skip、未执行和失败。 |
| **M13.1 日志初始化/写入错误不阻断主流程** | `docs/TECHNICAL.md:88-94; tests/test_logging.lua; src/health.lua`；日志写失败不可阻断应用正常启动/保存，但应暴露受控诊断状态。 | workbench/diagnostics.py:18-36,78; workbench/erpnext/api.py:22-46,115-137。 | 调整采用健康状态、安全错误类别、局部日志和定点故障注入；不复制Bingus游戏专用日志路径与日志格式 | 未验证: 状态API和安全错误代码存在；没有日志初始化/写失败不阻塞的直接测试。 下一步：隔离日志路径模拟不可写，并断言主流程完成与有限诊断状态。 |
| **M13.2 对健康诊断路径做定点故障注入** | `tests/test_health.lua:118-386; tests/test_health.lua:388-544; tests/test_health.lua:546-588`；对崩溃日志/健康端点/安装收据使用合成损坏输入，逐个验证错误分类、读取上限、脱敏和应用仍可退出。 | workbench/diagnostics.py:18-36,78; workbench/erpnext/api.py:22-46,115-137; 历史Django全量327/327（2026-10-20）。 | 调整采用健康诊断路径定点故障注入；不解析游戏minidump/GC/JIT数据 | 部分: 存在健康分类/ERP未配置处理；327总数不是逐项health故障注入报告，本轮也未重跑。 下一步：针对损坏health receipt、异常日志读取和ERP连接错误分别列出精确测试结果。 |
| **M14.1 缓存预算是显式扩大，不是保持配置不变** | `README.md:24-30; docs/TECHNICAL.md:160-205; src/jit_budget.lua`；只迁移“先测量，再明确资源预算并暴露状态”的原则。 | 无可引用的产品性能profile/资源预算记录。 | 不采用LuaJIT maxmcode/maxtrace具体预算；只把先测量再明确资源预算作为可迁移原则 | 未执行: 未运行Electron/Host/Django性能采样，不导入LuaJIT预算。 下一步：若目标要求性能证据，先定义每层指标和采样基线。 |
| **M14.2 Churn guard只在trace异常事件工作** | `README.md:30-36; docs/TECHNICAL.md:206-298; tests/test_jit_guard.lua:1-55,129-163; src/jit_guard.lua`；对性能修复以异常事件触发、节流、安全开关和有界开销审查。 | packages/tradeloom-shell/client.scenes.js:428-461; workbench/diagnostics.py:78。 | 调整采用异常事件触发、限频与可关闭观测原则；不直接操纵LuaJIT trace/cache | 未验证: 运行错误边界存在，但没有trace异常事件式的触发/节流/成本对照测试。 下一步：只在真实可复现异常路径上增加事件触发诊断和限频测试。 |
| **M14.3 测量专用probe不进入release** | `CONTRIBUTING.md:16-18; docs/TECHNICAL.md:453-455; src/frame_probe.lua`；性能探针在本地或测试构建启用，避免额外代码进入release。 | packages/tradeloom-shell/package.json:16 excludes testing; renderer probe lives under testing/desktop-package-contract/main-slot-renderer。 | 采用开发probe与release隔离原则，不将逐帧探针带入产品 | 部分: source package清单排除专用probe目录；实际NSIS/asar仍未扫描。 下一步：从最终发行产物确认probe与诊断代码未进入release。 |
| **M14.4 用对照臂检验探针测量与被测行为不变量** | `tests/test_frame_probe.lua:1-27; tests/test_frame_probe.lua:76-110; tests/test_frame_probe.lua:112-180`；验证诊断/埋点开关前后业务状态、HTTP行为和退出生命周期不变；用对照请求校准观测影响。 | 本轮无诊断开关前后对照组结果。 | 调整采用对照组验证观测不改变产品不变量；不移植游戏逐帧hook | 未验证: 普通功能测试不能证明观测本身不改变HTTP、业务状态或退出行为。 下一步：任何新增观测探针采用启停两臂并比较外部不变量。 |
| **M15.1 入口文本和声明格式严格前置校验** | `docs/AUTHORING.md:9-61; scripts/build_addon.py:16-41; tests/test_addon_package.py:1-46`；前置校验用户plugin/tool manifest格式并给具体缺项。 | packages/tradeloom-shell/business-tools.js:33-57,419-592; workbench/agents/tool_contracts.py:154; workbench/tests/test_roles.py:620,678,714。 | 调整采用schema、身份、权限和依赖白名单；不采用Lua命名/GUID/MurmurHash64A | 部分: 固定工具和schema前置校验有代码/测试；没有通用新集成manifest的完整schema示例。 下一步：以一个无业务规则的可选panel/tool示例验证身份、schema和权限声明。 |
| **M15.2 包身份稳定而依赖不可被假定自动安装** | `docs/AUTHORING.md:16-32,59-61; scripts/build_addon.py:36-71; examples/README.md`；明确发行身份稳定规则与依赖由谁安装/验证；不把包目录存在当依赖可用。 | packages/tradeloom-shell/package.json:16; apps/tradeloom-launcher/receipt-writer.mjs:12-74; existing deps lock. | 调整采用schema、身份、权限和依赖白名单；不采用Lua命名/GUID/MurmurHash64A | 部分: 包身份和release文件可定位；跨机器依赖准备及新增集成安装说明仍未形成可复现证据。 下一步：文档说明稳定plugin identity、由谁准备依赖及缺依赖时的诊断。 |
| **M16.1 更新需要明确purge/redeploy且不自动热加载** | `README.md:16-22; docs/AUTHORING.md:97-128; INSTALL.txt:53-101`；指定产品升级/重启窗口，确认主进程退出和bundle同步后重开，不绕过安装器/数据库门禁。 | apps/tradeloom-launcher/installed-bootstrap.mjs:33-68; apps/tradeloom-launcher/bootstrap-core.mjs:184-207,271; source-mode helper restart history。 | 调整采用升级后重新核验与持久化回归；不采用Purge/Deploy mod资源流程 | 部分: source bundle通过显式停止/同步/重启验证；p8没有本批更新并重验，未测试自动更新禁用行为。 下一步：后续安装候选按明确窗口停机、更新/恢复、hash对照和重开验证。 |

## 六项具体不采用机制

以下是上游专用机制的逐条不采用判断。其余可迁移原则仍按 leaf 状态单独验收。

| ID | 上游专用机制与源证据 | 不采用理由及保留的通用原则 |
|---|---|---|
| **N01** EXE与game.dll双SHA支持锁 | `README.md:20-22,68; docs/AUTHORING.md:65-76; src/build_gate.lua:11-16,39-56` | TradeLoom是Electron/Node桌面产品，不加载Helldivers进程或game.dll；其适配对象是自身app/Host协议、资源与数据库迁移版本。可迁移的是精确版本边界和未知版本的安全处理。 |
| **N02** 游戏船舱/任务/TestHarness专有运行态与私有字段 | `README.md:1,18; CONTRIBUTING.md:20-27; scripts/pin_tested.py:53-71,85-125; tests/game_lua.py:1-67` | 不采用游戏船舱/任务/TestHarness的专有场景字段与引擎语义；TradeLoom仍应保留通用崩溃采集、干净退出、恢复与启动故障回归，这些原则适用于Electron桌面应用。 |
| **N03** LuaJIT缓存扩容、trace churn guard与每帧probe | `README.md:24-36; docs/TECHNICAL.md:160-298,453-455; src/jit_budget.lua:1-152; src/jit_guard.lua:1-392; src/frame_probe.lua:1-387` | TradeLoom运行在Electron/Node/Chromium与Python/Django，不运行LuaJIT trace或游戏帧循环；不搬其cache参数、trace hook或逐帧测量。只保留以症状触发、低开销、可关闭的观测原则。 |
| **N04** Arsenal/HD2MM ZIP、patch优先级与Purge/Deploy流程 | `README.md:8-10,16-18,62; docs/DISCOVERY_VALIDATION.md:17-30; scripts/package.py:18-63; scripts/test_arsenal_packages.cjs:1-24,60-75` | TradeLoom使用Electron-builder/NSIS及产品自有bundle同步，不使用游戏manager ZIP安装、patch合并或游戏目录清理。迁移精确manifest、安装/更新边界和非破坏验证，不采用其manager操作。 |
| **N05** Lua addon入口名、seed-zero MurmurHash64A及256字节声明限制 | `docs/AUTHORING.md:41-60; scripts/build_addon.py:15-23,36-62; tests/test_addon_package.py:1-44` | TradeLoom的provider/tool/plugin identity由实际JSON schema、协议ID、manifest和Electron资源路径约束；MurmurHash资源名及Lua头声明与其格式不兼容。迁移入口白名单与边界校验原则。 |
| **N06** privacy audit硬编码上游作者与noreply身份 | `scripts/privacy_audit.py:92-104` | 这是该仓库历史审核的专用身份正则，与TradeLoom作者、依赖和发行流程无关；不复制个人名/邮件规则，只按产品组织与发行授权另设审计。 |

## 三项上游审计观察（非作者方法）

| ID | 观察主题与证据 | 具体事实及TradeLoom处理 |
|---|---|---|
| **O01** README/INSTALL/CONTRIBUTING/旧验证报告版本漂移及license说法不一致 | `README.md:1,83-87; INSTALL.txt:1,17,49; CONTRIBUTING.md:14,60; docs/MIGRATION_VALIDATION.md:1-10; docs/DISCOVERY_VALIDATION.md:1-5; LICENSE:1` | README/INSTALL写v20而CONTRIBUTING示例输出仍为v16；旧migration验证标v18、discovery验证标v15；CONTRIBUTING称未选全仓license而README/LICENSE称0BSD。此为文档版本/license陈述漂移，不是作者推荐方法。 |
| **O02** 受控tracked inventory未发现仓库级CI workflow/config | `BingusSharedLoader-method-review-20261021/tracked-files.txt:1-68; 固定commit git ls-files静态检查未发现CI workflow/config` | 固定commit的68项tracked file清单中未发现仓库级CI workflow/config；只描述受审清单，不推断外部CI。 |
| **O03** 68个tracked文件与63项publication allowlist差5项 | `publication-files.json:1-63; scripts/privacy_audit.py:73-90` | tracked为68项、publication allowlist为63项，集合差异5项：src/bingus_memory.lua, src/bingus_runtime.lua, src/build_gate.lua, tests/build_fixture.lua, tests/test_build_gate.lua。privacy_audit.py --git 的集合相等断言按静态输入会失败；该脚本本次未运行。 |

## 本轮未执行与限制

- 未运行Bingus脚本或游戏runtime。
- 未运行TradeLoom测试；所列自动化结果均为既存记录。
- 未启动或停止应用/服务。
- 未发出provider请求或ERP服务请求。
- 未执行build/package/install/upload。
- 未读取凭据或真实会话内容。
- 不把源码存在、脚本可运行或旧 GUI 截图外推成最新安装包、鼠标拖放、ERP服务、实体手机或完整供应商能力已通过。
- 当前缺口包括：统一Agent注册表、跨Agent共享协作DTO、受控ERP草稿写入/回读/审计、图像与网页桥接扩展示例、完整的模块目录与新增示例；这些是未实现/未验证项，不属于不采用机制。
- 真正下一步应对照本文件 leaf 状态选择具体未完成项，并绑定该项当前源码与独立证据；本审计没有启动运行态来补证。

### 后续窄屏与 ERPNext 操作状态增量（2026-10-21）

（同步前基线；其后的窗口结果见“最终窗口复核增量”。）

本增量只补充对应的后台证据，不改变43个 leaf 的既有采用决策/验证状态，也不把代码存在外推为 GUI 或远端事务成功。

- **shell 可见性：** candidate7 pinned React/ReactDOM server/Cordis 环境 `node --test tests/scenes.test.js` 实跑 23 pass、0 skip、0 fail、exit 0。断言覆盖窄侧栏下 `.tl-shell-top` 可见以及仅在 `html[data-meow-smooth-furled]` 状态为顶行预留既有10px内距+56px FAB空间。主控修前在同步后的 621×627 收起侧栏窗口确认顶栏可见、导航可用，但 FAB 遮住助手首行入口且 `elementFromPoint` 命中 FAB；本轮新源的窗口效果仍待复验，Node 合同不能替代 GUI 验收。
- **草稿 API：** 隔离 PostgreSQL `workbench.tests.test_erpnext_draft_api` 实跑 32/32、exit 0，run ID `2026-10-21T133741-872Z-46892`，result SHA-256 `7B48ACE1C2A70829C95B37509F1ED4A8C7C52D8C4801FACB68C9F6A092F4B666`。专门的 forbidden-create 回归另有 1/1、exit 0 的先前记录。此前 Django 全套 389/389、exit 0 仍保持为那次全套结果；本模块定向测试不能描述成更新的全项目回归。
- **真实只读与写尝试：** 外部 checkpoint（路径规范为 `<LOCAL_EVIDENCE_ROOT>/erpnext-live-20261021/checkpoint.json`，SHA-256 `C372C3E08E9F5602D068F7D9F3E53984F2E014E0BB5AE66DD858AC216A074FB4`）记录七类 DocType list 的 HTTP 200。一次 Quotation create 得到 HTTP 202，操作随后被读为 `outcome_unknown`，安全错误类别为 `forbidden`，没有远端名；没有重发、更新或 CAS。403 不构成无副作用证明，因此保持 unknown，不自动重试。独立远端只读证据 `<LOCAL_EVIDENCE_ROOT>/erpnext-engine-20261021/deployment/quotation-readonly-hook-evidence-20261021.json`（SHA-256 `AA1A2FDE7C3377E5EC5C14FB33E73D3FB1A6239000841C4DC9E4A6C177BE16EA`，UTC `2026-10-21T13:41:51.639290+00:00`）显示只读检查前后11类交易计数为0；它不确定403原因，也不能证明该次 Quotation 请求绝无副作用。
- **其余界限：** 七业务场景、日夜主题及 MCP/Skill 能力列表此前已有主控 GUI 查看证据；修前窗口观察确认 `.tl-shell-top` 可见并发现 FAB 遮挡，修后窗口尚未观察，不能描述为窄屏已通过。插件 GUI 结果不代表所有插件交互均已验证；22 个共享 Skill/52个文件的资产 hash 核对也不等于逐项 GUI 查看。正式提交/取消/删除/库存未开放；图像/网页桥仍为预留扩展接缝。
- **完整目标状态：** 本更新不是全目标完成声明。草稿在 ERPNext 的成功写入与更新 CAS、窄屏补丁窗口验收仍未验证；原43项 leaf 状态维持既有审计基线。

机器可读逐项记录：`testing/desktop-package-contract/bingus-audit-20261021/methodology-audit.json`。

## 基线后的执行补充（2026-10-21）

上文“本轮未运行TradeLoom测试”描述的是该只读方法审计时点，保留为历史事实。之后的单独执行记录如下，不反向改写方法审计基线，也不据此宣称全项目完成。

- 助手能力只读面板增加固定 role 查询、live `composedPreset` 双重核验及未绑定时的预设 MCP 声明投影。修正后的最终 Node shell suite 为115/115、exit 0；launcher suite 为58项，54 pass、4项因缺少独立 Stage 6 bundle inventory fixture 而 skip、0 fail、exit 0。candidate7 pinned SlotTestRuntime renderer 为7/7、exit 0。完整测试命令、candidate7 路径变量与原始日志在被忽略的本机记录 `LOCAL_EVIDENCE/desktop-package-contract/agent-capabilities-final2-20261021/`；这些运行结果不自动改变本文件43项逐条验证状态。
- Django `workbench.tests` 的357/357、43.353秒、exit 0 是此前独立 PostgreSQL 运行 `2026-10-21T072416-295Z-24040` 的结果，result JSON SHA-256 为 `A333461144A81C68CA9FCD451295492ADF3FD59DD8C95C3A4B2890A5E53BDB9A`。本次助手能力改动没有 Python 变更，因此没有重跑；该结果不覆盖客户端能力面板。
- 方法审计基线中的 Site 主题 GUI 证据仍绑定旧 bundle `48813c1be56f59c600bf5092e04b9f8aaa5855d947d27f191e46dd979ce33618`、manifest `A58CD94C45795771BB5C634FCDD73F1BBEABD03B06C3F23A8DAFEAB96C916B2C` 及 evidence SHA `28153926322DB2B9A7295EACAC1D1A76378C318CE59AD9F162A9CED40A798CF8`。本次未同步/重启运行副本，也未对新增能力面板做 GUI 验收，旧主题截图不能充当本次面板证据。
- 机器记录 `postBaselineVerification` 保存了上述结果、范围边界和外部日志路径；原43个 leaf 的采用决策/验证状态与“本审计未运行测试”的历史描述均保持原样。后续需逐 leaf 复核新增证据是否满足其独立条件，不能整体外推。

### 后续回归与当前目标边界（2026-10-21，同步前 GUI 基线）

此补充记录在方法审计基线之后的代码与测试证据；原43个leaf状态维持已审计的27项部分、14项未验证、2项未执行，本补充没有重算逐项状态，也不把单个套件结果外推成完整目标通过。

- 当前实现和记录已覆盖：统一 shell role 元数据、隔离的 workflow collaboration envelope、固定ERPNext七类只读适配、Quotation 草稿 operation 后端及界面/工具、角色范围内 MCP/Skill 只读能力快照，以及全局插件/共享 Skill 的本机资产同步。前两项不把 Python workflow role 与 DSH preset 身份混为一个域；能力面板也没有提供逐项授权/编辑或连接健康证明。
- 本轮共享卡片 inset 的综合门禁：Django `workbench.tests` 389/389，exit 0；shell Node 121/121，exit 0；launcher 57 pass、0 fail、4个 Stage 6 payload 专项skip；candidate7 pinned renderer 7/7，exit 0。Django run `2026-10-21T120157-034Z-48700` 的 `result.json` SHA-256 为 `76EFA445B0EE4CF2C39C901083B7836E629D9E653F1CD3A848DCB47931E86584`。本机原始日志在 `<LOCAL_EVIDENCE_ROOT>/ui-spacing-20261021/`；测试证明代码路径，不证明当前窗口已加载本批 CSS。
- 四个 launcher skip 明确需要 `TRADELOOM_STAGE6_BUSINESS_SHELL` 指向经冻结的旧 Stage 6 11文件 bundle，用于旧bundle升级和事务恢复边界。该变量未设置；candidate7 是后续当前包，没有等价的历史 inventory，因此不据此删除skip或声明补验。
- 当前尚未验证的范围包括：本批 spacing 的 GUI 效果，以及 TradeLoom 本地 Django 到 ERPNext 的真实读取、Quotation 条件更新与草稿读回。远端 ERP 服务健康，八个 token GET 返回 HTTP 200；私密配置已导入本机，但当前运行的 Django 尚未启用该配置，因而外部服务健康不能替代 TradeLoom 集成证据。正式提交、取消、删除和库存写操作仍依既定边界保持关闭；图像/网页模型桥是预留接缝，并非本阶段必做的真实 provider。MCP/Skill 面板此前已实机查看其能力摘要，但它不报告连接健康；没有已确认的逐项编辑/授权需求，不把它们列作当前必做缺口。
- 20项插件资产（19项安装及 Codex experimental，其中14项为更新）与22项共享 Skill/52个文件此前已由主控在 GUI 核实。本轮没有重做这些检查。当前 source 已同步并后台启动；本轮没有打开 GUI，所以 spacing 尚无新窗口证据。完整目标仍未完成。

### 最终窗口复核增量（2026-10-21）

本节后续更新上文“同步前 GUI 基线”的状态；保留各自当时记录，不把最终版本检查范围外推。

此增量只更新 GUI 观察，不重算43个 leaf 的采用决策或验证状态，也不表示整体验收完成。此前“本轮没有打开 GUI”的记录是该次审计的历史时点；之后的实际观察如下。

- 七个场景逐页检查卡片留白、明暗主题、侧栏及 MCP/Skill 能力面板滚动是在前一同步版本 `a2e86a34bcdba5216c372172054885a64b14c0aea66d2be40426347a03e9fdb5` 完成。最终 bundle `babaee741aa6be4a7d3b3e35453c4b771d44d7aa110b32c16a2e944848ec8491` 仅重开桌面检查工作总览、ERP 新中性文案/已连接 DEMO Item 列表，以及 621×627 窄屏菜单、主题与单面板切换。外部 GUI 证据 `workspace/testing/ui-spacing-20261021/ui-verification-final.json` SHA-256 `6dfff530f317224cbcdcc6d36b2f555f76e2e60a2cfe2cbe819c091b19f5b4e0`，记录五张外部截图的 hash；截图未纳入源码。
- 621×627 窄窗口中顶栏、助手选择菜单和单面板切换可用，助手菜单 hit-test 正确，页面无横向溢出；system/light 与 dark 切换可见。没有测试实体手机。
- 本次自动化原生标签拖动只选中参考标签，没有证明移动/停靠；结果标为未证实。较早的拖放观察只适用于其当时 bundle，不能外推到本次最终版本。
- ERP 实际只读页面可显示连接和 DEMO Item；Quotation create 仍保持 HTTP 202 后 `outcome_unknown/forbidden`、无远端名的记录状态，本次未重发、未更新、未做 CAS。远端11类交易计数只读快照为0，不足以证明该未知操作没有副作用。没有新模型请求或付费请求。
- 本增量没有改变本审计43项逐 leaf 状态；图像/网页桥继续作为预留接缝，其余 leaf 仍按各自记录独立验证，不由预留接缝推导新增必做项。MCP/Skill 是只读能力查看，不能据此宣称逐项授权编辑或连接健康已完成。整体目标仍未完成。
