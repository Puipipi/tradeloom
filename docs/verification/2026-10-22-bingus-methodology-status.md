# BingusSharedLoader 方法映射：当前状态

日期：2026-10-22。对象是当前本地工作树（HEAD `e125ea97ca0bb573ddde55f0f297c9e55beeb87a`）及本文件列出的阶段证据；工作树存在既有未提交/未跟踪文件。本文是方法映射增量，不是产品整体验收或发布批准。

上游固定快照为 `BingusSharedLoader` `9471bcb16f3a479efdff3e0520def4573ae0a028`，该快照当前干净。16 个 M 主题、43 个编号叶子、N01–N06 和 O01–O03 均是项目审查者对上游材料的归纳编号，不是上游作者原编号或其自称的通用方法论。上游来源定位和审查边界见外部引用目录 `references/BingusSharedLoader-method-review-20261021/methodology.md` 与 `methodology.json`；旧报告的66份文本完整阅读是其历史 ledger 记录，本轮复用该 ledger，仅重核固定提交、方法清单、N01–N06原文以及与当前产品相关的阶段证据，没有重新阅读全部66份文本，也没有执行上游测试或隐私审计。

## 结论边界

执行计划切片已完成并本地激活，数据库迁移为0009；阶段5全套 Django 回归为492/492、0跳过，固定 candidate8 shell 回归为154/154、0跳过。实际合成链另有 loopback HTTP 与注册工具处理器验证。以上仅支持表中相应叶子的局部结论，不代表九部分总体目标完成。执行计划是草稿和人工提议；actual仍缺失，没有基于真实生产资料、真实ERP或真实模型推理。

原生桌面窗口/登录代理会话、实际渲染、手机、模型/provider、发布包仍未验收。原生窗口自动化入口当时不可用；未登录代理得到401只证明鉴权拒绝。业务事实缺口与GUI工具缺口彼此独立：现有访谈材料不能证明实际到料/报工载体、填报/审核角色及更正流程，需业务方核实后才能设计实际记录。参见 `docs/01-业务基线.md` 与 `docs/02-客户访谈问题表.md` 中生产现场及待确认问题。

## 43个叶子状态

状态是对当前 TradeLoom 证据的逐叶评估，不改变旧报告的历史结论。`局部支持`表示只满足表中范围；`未验证`表示没有该叶要求的直接证据；`机制不适用`仅指上游专用机制不迁移，不表示其通用原则可忽略。

| 叶子 | 原检查项（methodology.json） | 当前状态（证据是否满足原项） | 当前证据 | 尚未覆盖的边界 |
|---|---|---|---|---|
| M01.1 | 版本身份由两份二进制散列组成 | 局部支持 | `docs/verification/2026-10-22-intake-ui.md` 本地 bundle/source SHA；阶段4激活核对 | 没有安装包 receipt，也未核 native 窗口运行身份与所有资源版本 |
| M01.2 | 未知/读失败时关闭扩展加载但保留原始游戏启动 | 未验证 | `docs/verification/2026-10-22-execution-plan-http-e2e.md` API拒绝/异常边界 | 未验证未知桌面 runtime 或启动资源读取失败时原应用仍可正常启动/退出 |
| M02.1 | 对比旧版本可观察合同而非实现细节 | 局部支持 | `docs/verification/2026-10-22-execution-plan-backend.md` API契约/回放；HTTP E2E | 没有全产品 renderer-host、Django公开响应、桌面退出的跨版本快照 |
| M02.2 | 以capabilities代替内部版本数值分支 | 局部支持 | `packages/tradeloom-shell/business-tools.js`、`capabilities.js` 动态工具发现；final-gates shell tests | 未证明所有可选能力都避免内部版本分支，也未在真实模型会话验证 |
| M02.3 | 依赖工具链版本固定 | 局部支持 | `docs/verification/2026-10-22-execution-plan-http-e2e.md` 固定 candidate8 runtime；final-gates依赖哈希 | 没有全桌面构建/安装依赖的完整锁定与安装 receipt |
| M02.4 | 版本化黑盒合同并规范动态字段 | 局部支持 | `packages/tradeloom-shell/tests/business-tools.test.js`；API与工具schema测试 | 合同覆盖局限于现有工具及计划DTO，不是所有公开API/renderer-host的版本快照 |
| M03.1 | 优先级按数值与明确顺序处理 | 未验证 | `packages/tradeloom-shell/client.scenes.js` 入口测试 | 没有多个冲突插件按显式优先级稳定解决的证据 |
| M03.2 | 声明/影子副本规则明确 | 局部支持 | `packages/tradeloom-shell/package.json` 与阶段4 bundle核验 | 未覆盖重复/shadow panel、模块身份冲突处理 |
| M03.3 | 格式损坏和隐藏读取失败不得阻塞后续项 | 局部支持 | `packages/tradeloom-shell/tests/business-proxy.test.js`；Django错误注入测试 | 单一工具/provider/配置失败下其它桌面功能继续初始化未覆盖 |
| M03.4 | 资源枚举限制读取并释放native handle | 局部支持 | `workbench/intake/` 有界上传/API测试；execution-plan闭合schema | 未覆盖原生资源枚举及所有文件句柄异常释放路径 |
| M04.1 | 包装必须保留原始启动参数和完整返回元组 | 未验证 | launcher有相关测试源码，但阶段5只运行 `workbench.tests` 与 `packages/tradeloom-shell/tests/*.test.js`；本轮未执行 launcher 独立测试 | 未验证原始bootstrap合同、Host完整返回值及退出语义；Lua多返回元组是上游专用机制 |
| M04.2 | 一次性启动钩子要有可验证时序 | 未验证 | 阶段4应用启动/readiness只能说明本地服务可用；本轮全套测试未包含 launcher 独立测试 | 未验证启动钩子一次性语义、顺序及原生窗口时序 |
| M04.3 | 一次性回调错误被隔离且有上限 | 局部支持 | `workbench/tests/test_execution_plan.py` 异常回滚；final-gates 492项 | 没有覆盖所有桌面回调/注册数量上限与初始化故障隔离 |
| M05.1 | 解析时校验包头、范围和长度 | 局部支持 | `workbench/intake/` 上传/解析边界测试；`workbench/execution_plans/schemas.py` | 未审计所有导入格式、桌面包头和发布载荷结构 |
| M05.2 | 输入版本/头与编译mode双校验 | 局部支持 | 阶段4源码/迁移哈希与PostgreSQL恢复证明 | 没有验证应用发行包内二进制头/字节码模式或签名 |
| M06.1 | release build运行分层离线测试 | 局部支持 | `docs/verification/execution-plan-final-gates-20261022.md`：492 Django、154 shell，均0跳过 | 不是 release build/安装包测试；未覆盖真实桌面、模型和手机 |
| M06.2 | 宿主专用环境缺失以skip而不是伪通过 | 局部支持 | 上述全套运行无skip；缺少原生窗口的工具限制单独记录 | 运行时环境缺失不被伪称通过；但原生/手机门禁仍未运行，不能据离线0 skip推定通过 |
| M07.1 | manifest部署路径集合必须准确 | 局部支持 | `apps/tradeloom-launcher/sync-dev-bundle.mjs` 及阶段4同步哈希核对 | 没有构建最终 asar/NSIS 并审计其完整路径清单 |
| M07.2 | ZIP元数据规范化但不等于全链跨机复现 | 未验证 | 无发行归档证据 | 未构建ZIP/安装包，未评估元数据规范化或跨机复现 |
| M08.1 | Pin要求run确认为clean且无clean原因 | 未验证 | 阶段4启动readiness成功 | 本地启动仍有运行句柄；没有 clean 终态 pin/退出记录 |
| M08.2 | Pin要求到达目标场景及正常引擎退出 | 未验证 | 阶段3仅为合成HTTP与只读handler链 | 未完成真实目标场景或桌面正常退出验收 |
| M08.3 | Pin要求无dump且安装恢复 | 未验证 | 阶段4 `pg_dump` 是数据库逻辑备份；独立恢复仅证明该数据库备份可还原 | `pg_dump` 不是崩溃转储（crash dump）；没有无崩溃转储证据、应用安装恢复或profile恢复验证 |
| M08.4 | Pin要求支持的精确游戏build | 局部支持 | 固定 candidate8 runtime与哈希在阶段证据中绑定 | 上游的游戏build概念不适用；桌面原生实际兼容矩阵未验收 |
| M08.5 | Pin只承认确切部署ZIP的SHA | 未验证 | 未生成发行ZIP/安装包 | 没有可绑定的部署归档SHA |
| M08.6 | Pin要求相符日志与现源码构建resource | 局部支持 | 阶段4页面脚本/样式SHA与本地源码一致；readiness检查 | 未在原生浏览器渲染或已登录代理中复核，也没有发行包resource receipt |
| M08.7 | Pin的失败必须解释且无写入 | 未验证 | 阶段4有界checkpoint实际写入并应用0009；阶段3 HTTP拒绝/非法ID仅是不同层的无写入旁证 | 迁移成功不证明失败pin无写入；HTTP拒绝不满足上游运行失败记录合同；tag03只读权限失败保留为历史 |
| M09.1 | 开发探针产物路径与release隔离 | 局部支持 | 测试与阶段证据保存在项目外 `workspace/testing/`、`workspace/runtime/.../evidence/` | 未验证最终发行目录对所有开发探针的隔离 |
| M09.2 | 包和隐私审计拒绝探针版 | 未验证 | 本轮未构建发布包/运行发布隐私扫描 | 未证明探针会被发行/隐私门禁拒绝 |
| M10.1 | 隔离manager fixture并验证全部载入/卸载组合 | 局部支持 | `workbench/tests/test_execution_plan_http_e2e.py` 隔离PG/外置合成目录 | 未验证完整桌面 profile/所有 manager load-unload组合 |
| M10.2 | 依赖组合与加载顺序矩阵 | 局部支持 | Django 492项与shell 154项全套；HTTP端到端；故障注入 | 仅项目自己的mock/loopback和测试依赖，不含所有真实provider/桌面加载顺序组合 |
| M11.1 | publication inventory与Git index集合约束 | 未验证 | 本轮未执行项目发布清单与Git index集合审计 | 当前工作树含未提交/未跟踪变更，不能宣称发布allowlist匹配 |
| M11.2 | 识别敏感模式但不回显匹配值 | 未验证 | 新公开方法说明避免机器私密路径和业务内容 | 本轮未执行完整敏感模式扫描；不等于隐私门禁通过 |
| M11.3 | 历史作者身份检查为仓库专用规则 | 机制不适用 | 上游正则只绑定其作者身份；本项目未复制 | 项目自己的组织/签署策略仍须由发行流程定义和审计 |
| M12.1 | 每份验证声明绑定版本与范围 | 局部支持 | 本文绑定日期、HEAD、逐叶证据和边界；各阶段验证文档列run IDs | 本文不覆盖未列源码/安装包/实际业务；工作树非干净 |
| M13.1 | 日志初始化/写入错误不阻断主流程 | 未验证 | 阶段4只读readiness与受控错误码检查 | 没有注入日志初始化/写入故障来证明不阻塞主流程 |
| M13.2 | 对健康诊断路径做定点故障注入 | 未验证 | API异常脱敏与事务回滚测试只覆盖业务接口错误路径 | 尚无health、日志或receipt损坏/写入失败的定点注入；也未测诊断成本 |
| M14.1 | 缓存预算是显式扩大，不是保持配置不变 | 机制不适用 | 本项目为 Electron/Node/Chromium 与 Python/Django，不含LuaJIT预算 | 不把LuaJIT cache参数移入；若性能目标提出，应先定义本产品指标 |
| M14.2 | Churn guard只在trace异常事件工作 | 机制不适用 | 无LuaJIT trace；现有错误诊断不等同于trace guard | 不复制trace hook；未来只对可复现本产品异常做限频观测 |
| M14.3 | 测量专用probe不进入release | 局部支持 | 专用测试probe/合成fixture存于测试目录，未打包 | 未扫描最终发行包，不能确认release彻底排除 |
| M14.4 | 用对照臂检验探针测量与被测行为不变量 | 未验证 | 当前功能测试含多路径，但无观测开关前后成对对照 | 普通回归不能证明观测不改变业务或退出不变量 |
| M15.1 | 入口文本和声明格式严格前置校验 | 局部支持 | `workbench/execution_plans/schemas.py`、`packages/tradeloom-shell/business-tools.js` 严格schema与输入测试 | 覆盖计划API/tool，不是所有通用集成manifest示例 |
| M15.2 | 包身份稳定而依赖不可被假定自动安装 | 局部支持 | package/tool identity、候选8依赖显式注入与全套依赖哈希 | 未证明全机器依赖准备流程或最终安装器依赖责任 |
| M16.1 | 更新需要明确purge/redeploy且不自动热加载 | 局部支持 | 阶段4明确停自有应用、同步本地bundle、重启并核源码哈希 | 不是安装升级/Purge/Deploy等价流程；未验证自动热更新被禁用 |

## N01–N06：不采用的专用机制与保留原则

| 项 | 不采用原因 | 保留的通用原则 |
|---|---|---|
| N01 EXE与game.dll双SHA支持锁（上游 `README.md:20-22,68`；`docs/AUTHORING.md:65-76`；`src/build_gate.lua:11-16,39-56`） | TradeLoom不加载Helldivers进程或游戏DLL，双文件哈希条件无法映射其启动模型。 | 将兼容边界绑定到本产品app版本、Host协议、资源和数据库迁移；未知版本对危险动作安全拒绝并给诊断原因。 |
| N02 船舱/任务/TestHarness游戏状态和私有字段（上游 `README.md:1,18`；`CONTRIBUTING.md:20-27`；`scripts/pin_tested.py:53-71,85-125`；`tests/game_lua.py:1-67`） | 这些字段依赖游戏场景与引擎生命周期，不是本产品领域对象。 | 仍需测试桌面崩溃、正常退出、恢复与启动故障；不得用API通过替代真实运行证据。 |
| N03 LuaJIT缓存扩容、trace churn guard与逐帧probe（上游 `README.md:24-36`；`docs/TECHNICAL.md:160-298,453-455`；`src/jit_budget.lua:1-152`；`src/jit_guard.lua:1-392`；`src/frame_probe.lua:1-387`） | 产品运行于Electron/Node/Chromium与Python/Django，没有LuaJIT trace或游戏帧循环。 | 只有出现可复现性能/运行异常时，才选低开销、症状触发、可关闭的产品指标与观测。 |
| N04 Arsenal/HD2MM ZIP、patch优先级与Purge/Deploy（上游 `README.md:8-10,16-18,62`；`docs/DISCOVERY_VALIDATION.md:17-30`；`scripts/package.py:18-63`；`scripts/test_arsenal_packages.cjs:1-24,60-75`） | 产品使用Electron-builder/NSIS和自有bundle同步，不经过游戏mod manager，也没有其patch覆盖语义。 | 保留精确发布清单、更新边界、同步前后校验和非破坏性恢复验证。 |
| N05 Lua入口资源名、MurmurHash64A、256字节声明格式（上游 `docs/AUTHORING.md:41-60`；`scripts/build_addon.py:15-23,36-62`；`tests/test_addon_package.py:1-44`） | 这些编码依赖Lua addon头与上游资源加载器；TradeLoom按JSON schema、协议ID、manifest和Electron资源路径识别。 | 对真实入口格式做白名单、长度/编码/schema前置校验，拒绝未声明字段和不明身份。 |
| N06 上游作者/noreply历史身份正则（上游 `scripts/privacy_audit.py:92-104`） | 它只针对上游历史作者账号，不代表TradeLoom组织、依赖或授权人员。 | 发行审计应由本产品维护组织身份、签名与授权规则，避免硬编码个人身份值。 |

## 其它上游观察

O01 文档版本/许可声明漂移、O02 tracked inventory未发现CI、O03 68 tracked 对 63 项 publication allowlist 的差异属于审查观察，不是作者方法或N项机制；旧方法审计记录未执行上游隐私脚本，因为静态集合断言不匹配。本轮没有重跑该脚本，也没有把旧观察外推为当前产品问题。