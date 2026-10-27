# DSH 工作台参考：严格逐项 UI 对照清单

> **本清单替代旧稿的“全部完成”结论。** 旧稿 `ui-reference-implementation-20261024.md` 的逐阶段大项无法证明几十种细节均已完成；该结论已撤回，历史记录仍保留。当前文档按原始实机观察、补充文字清单和当前代码逐组件列项。135张S与31张D图片已经逐张视觉复核；这不等于每个UI要求都已对实现做逐项GUI验收。

**2026-10-25 17:23 最新部署覆盖说明**：正式 desktop-14 已同步启动，source/runtime/live profile 的 34 文件 tree SHA-256 同为 `2e0c2f20391feb7f8583f59591df34b61585b5ee19437855bde0714d2c08b5fd`，receipt/descriptor/runner 匹配。下方 desktop-13、候选暂停、内存草稿和阻塞描述均为历史阶段，不再指当前运行态。最新原生 startup/web-document 147/147；完整 pane 内容拖动、连续缩放和回坞隔离夹具已通过，但真实窗口功能仍待验。UIA 仅确认四 pane、历史消息、模拟模型和空输入；用户正在使用电脑，停止桌面输入。启动前配置 hash 全相同，启动后原生程序改写 cordis.yml/state.json，精确布局和语义保持仍待核。详情与待办见 [交接入口](ui-reference-handoff.md)。本次未发送消息，未操作业务执行，未声称全套 UI 已完成。

**当前交接摘要（desktop-13）**：正式stop desktop-12→sync→hidden start成功；source/runtime/profile bundle hash一致：`c7c1164f9fd8742ca4714e177806e26c9546d8249478a61b815a2d5537140b94`。Window27789548首次coldboot及Window16187696在一次无sync、无PG操作的受控stop/start后，均对同一“生产指令单.xlsx”预览成功（608个非空单元格、Sheet1、I13图片，无403）。preview浮起为左侧约56%宽/94%高，青绿色细边可见，停靠恢复pane顺序及约43%/57%上下布局；maximize后四pane比例约顶部65/35、底部26.6/73.4，取近似值。roles/sceneWorkbench绑定hash、DataRoot及PG PID 52604保持；Host 3088 PID 41460、Django 3090 PID 44588。防火墙弹窗已由用户处理。用户随后手动将“生产指令单.xlsx”拖回商品会话；父在Window16187696只读UIA确认待发送附件组包含“移除文件 生产指令单.xlsx”，发送按钮enabled，状态为“已将‘生产指令单.xlsx’加入附件草稿；尚未发送”，未执行发送。保留原登记文件137552B、SHA-256 `e26aa4b91a61aec30e10afaef796cb07ac5f1944fea0f6e9347988f1f7d5c638`只作为源文件校验，不代表内存附件重算哈希。附件只存在于当前会话内存；不要刷新或重启工作台，直到另行安排。CSRF只对这条登记工作簿预览路径两次通过，不泛化到所有来源请求。

**独立桌面窗口最新集成阻塞**：用户希望面板突破主窗口边界，以真正独立窗口拖出并停靠返回。desktop-13已验的preview左侧浮起是Dockview内部overlay，不满足此要求。SceneWorkbench + Dockview React 8.6 + hidden Electron集成fixture失败（`evidence/dockview-popout-integration-20261025/failure.json`）：弹出阶段同DOM、File、文本保持，mount 1/unmount 0，子窗口收到2次owner-document通知；点击生产停靠后panel经`removeGroup`销毁并重新mount（mount 2/unmount 1），输入框重建、局部文字/File丢失。business正在调查原生窗口关闭/回坞路径；desktop-14候选build已暂停。该fixture使用本地React state，不等同真实SessionProvider；native基础fixture与104项组件级owner-document测试仍有效，但不覆盖这次失败。真实Electron回坞与会话草稿保持尚未通过。当前desktop-13及已恢复的未发送XLSX内存草稿未动；勿刷新或重启。

**当前未发布工作批次**：PaneState源码与20组合fixture已完成但未部署。S120实际`ShellToolsMenu`合成23行fixture在420×720/字号22与1280×900/字号14通过，覆盖71/78绿、176黄、539红、unknown、内部滚动、分组折叠和Esc回焦；证据`evidence/session-usage-reference-20261025/`，不是Electron验收。`question-composer-density.patch`含共享Button CSS和`client.scenes.js`的`--dsh-ui-scale`桥，官方隔离prepare/check、36/36通过。最终IAB证据`question-composer-reference-20261025/formal-iab-grid-final.json`与`question-composer-iab-font22-grid-final.png`，CSS SHA-256 `C858ED46477D7FAB8DAED41266B2F8583E9DB9BB935667A84772A7B8117EBAC0`：420×720真实组件14→22→14时card为324×432→296.58×432、title 15→23.5714、body 303→119、footer高36→56.56，label/description 14→22；无横溢或按钮越界，折叠展开及字号恢复通过，未提交。旧font22截图和`formal-iab-observation`是header修复前中间态，不作最终证据；自动probe显示组件尚未就绪，未通过且不采用。该离线组件测试不代表原生pending提问流程GUI通过，源码仍未部署。独立桌面窗native patch `desktop-pane-popout.patch`使用精确`dsh-app://app/desktop-pane-popout.html`；17 helper单测通过。最新`workspace/runtime/tradeloom-harness/evidence/pane-popout-integration-20261025/result.json`记录官方PowerShell运行exit 0、Electron 44.7.0：distinct HWND、child bounds可越opener右边界、精确ticket blankroute、child顶层app导航blocked 1、二次popup deny 1、关闭opener后child销毁、networkListeners 0、Host business调用0。证据只覆盖native基础与测试preload→真实invoke→production registrar/store；sender断言为fixture替身，main-startup未运行，Dockview/editor/真实附件仍未验证。早期ticket fixture因`did-create`时初始URL为空且`isLoadingMainFrame=false`而过早失败；现等待`did-finish-load`后通过，production gate未放宽。不可将native fixture通过写作Dockview独立pane或完整用户功能通过。`ui_build_map`负责native main/web-document及隔离fixture，不改lock；`business_mapping`负责Question CSS与renderer/editor/menu/iframe ownerDocument patch及lock/scripts串行登记；renderer/editor仍在实施。当前生产仍desktop-13/`c7c1164…`，已恢复XLSX仍为未发送内存草稿及现有layout，禁止刷新/重启当前工作台。各项详细证据保存在相应evidence目录，不代表V01–V07整体完成。



**新增未发布批次（窗口拖动、工作台动效、小窗原生composer）**：顶行拖动区仅把实际交互控件和原生Windows菜单标为no-drag，保留剩余flex空白作为拖动区及OS caption避让。工作台动效菜单用localStorage键`tradeloom.workbench.motion`保存`system|on|off`；最大化/还原做真实几何FLIP；Dockview内部拖放监听真实onWillDrop，在下一帧对已移动组做FLIP（同实例移动走_onMove，不依赖onDidDrop），浮起/停靠对同一group元素淡入，不在指针跟手阶段加transition。隔离Dockview Electron motion夹具已验证三态（包括`on`覆盖系统reduce、`off`禁用及`system`跟随系统）、最大化/还原几何和浮/停连续性，证据`workspace/runtime/tradeloom-harness/evidence/workbench-motion-integration-20261025/result.json`；它不代表生产GUI验收。顶行/动画源码在`packages/tradeloom-shell/client.js`、`client.scenes.js`，定向shell测试`scenes.test.js`为35项（34通过、0失败、1既有跳过），React/JSDOM动效菜单测试1/1、真实Dockview pointer-DnD事件路径1/1通过。变更前最近一次全包`npm test --prefix packages/tradeloom-shell`为270项中252通过、3失败、15跳过；失败在`dockview-integration.test.js:313`（floatingGroups断言）、`execution-plans-dom.test.js:131`（主题token fixture）及`theme-bridge-dom.test.js:38`（旧15/13px字号期望），尚待各测试owner核对，不记全量通过。小窗原生composer补丁`integrations/dsh/patches/composer-pane-density.patch` SHA-256 `BA21F927D8B887CD6A7F47200F88C9E4D633F63C45552389316BF87373211147`，仅包含`ConversationRoot.module.css`与`InputBar.module.css`；官方隔离prepare为18项prepared、check-upstream兼容且`targetMutated=false`。真实组件几何已由desktop13真实React Conversation组件与冻结CSS夹具4/4验证，证据`workspace/runtime/tradeloom-harness/evidence/composer-pane-density-20261025/result.json`：640×240/14的composer/card/input/历史分别109/105/28/129.67px，640×240/22为121/117/36/117.67px；420×240/14同为109/105/28/129.67px，420×240/22为161/157/36/77.67px。各组合无横溢，按钮和工具可用区留在pane内，输入scroll为auto且max-height 50.6562px。该夹具使用真实React Conversation组件和冻结CSS，但不是生产UI/真实会话；顶行OS拖动区域也尚无hidden Electron hit-test或生产GUI验证。本批native patch尚未build，shell源码尚未部署；desktop-13/`c7c1164…`运行状态及内存附件不变，勿刷新或重启。

**owner-document与停靠集成状态**：renderer已在Dockview弹出/移回生命周期向目标文档标记root派发owner-document事件。104项组件测试覆盖手动adopt+事件后的Menu/Tooltip/HoverCard、Lexical root/editorState与附件卡/File身份保持；新集成fixture观察到弹出阶段事件2次且实例未卸载。但停靠阶段生产路径通过`removeGroup`销毁并重建panel，fixture中的输入文字/File随之丢失。因此不能记真实Electron/Dockview回坞、SessionProvider连续性或草稿保留通过；需先修停靠保留实例路径，再补集成复验。

**当前未部署源码批次**：共享 `PaneState` 已补原生chat未绑定/连接中/失败，以及ERP未配置/配置无效/不可用/fetch失败状态；保留原有connected ERP与QuotationDraft路径。busy spinner支持reduced-motion，动作disabled，文本可断行，尺寸跟随`--tl-ui-scale`。`scenes`测试35项（31通过、4既有跳过、0失败），新增三边界用例3/3；真实React 18 + headless Chromium的组件与SceneWorkbench样式fixture组合20项通过（420×320、dark/light、14/22及5类状态）。父看过dark14 loading与light22 error代表图；这些是静态/Headless fixture证据，不是Electron验收。证据在`evidence/pane-state-reference-20261025/`。源码仍待同步，当前运行时仍为desktop-13/c7c1164；S019/S133状态组件的Electron实机验收未完成，V01–V07整体也未完成。V07 S129的原生提问链已接通但尚无织贸真实pending样本，见对应逐项行。附件已在当前Window16187696由用户手动恢复并经父只读UIA确认，仍仅为当前会话内存草稿；不要刷新或重启当前工作台。

## 历史检查点：desktop-12（2026-10-25；已由desktop-13取代）

- **构建/receipt**：官方候选run `0.2.1-rc.3-tradeloom-desktop-12-20261025T033426595Z-25168`成功；[final-result.json](C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/evidence/build-0.2.1-rc.3-tradeloom-desktop-12-20261025T033426595Z-25168/final-result.json)显示构建、Primary Runtime组装、descriptor与receipt阶段通过，`primary-runtime-smoke`按请求跳过。Receipt SHA-256 `1E050E140CCDE173E2F14BE50ABE7EF4EDA6FEC28D3E55D9E8BD1FAAB9082459`，patch-set SHA `44cef24abf17f8a86e149beb68164494045fb408681b2f3adf57291841761d60`，source commit `1f81c047fc48fa190a683e469daa699857e9afe8`。
- **此前profile迁移记录（c9befa）**：source、desktop profile bundle副本及launcher record hash当时一致：`c9befa7c72116b7c33da621c5995530ed33af89be0c53370eb6a6bc2fbe8a8c1`，现已由下方9c323a当前bundle取代。Runtime为`C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\releases\0.2.1-rc.3-tradeloom-desktop-12`；DataRoot保持`C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\local-dev\workbench-20261020-02`，PG PID 52604保持；正式runner candidate已更新为12。
- **启动与实机复验**：第一次hidden launch exit 0但未见窗口，原因未确认；第二次hidden launch后Window64687408出现，3088 Electron PID 58928、Django 3090 PID 47828。用户手动处理Windows安全中心防火墙权限弹窗后，恢复最小化窗口时弹窗已消失。父在desktop-12 bundle `c9befa7c72116b7c33da621c5995530ed33af89be0c53370eb6a6bc2fbe8a8c1`实机选择同一“生产指令单.xlsx”，预览成功显示608个非空单元格、Sheet1及I13图片，未出现HTTP403；这验证原生桥修复在该登记工作簿预览路径有效。
- **当时部署身份（desktop-12）**：bundle `9c323a827bed65089d6fa2fc4edc4cc2ffe28e5f3fcb8fbe9878b7930191a8d5`、main `26612964`；DataRoot、PG与布局保持不变。此为已被desktop-13取代的部署快照。
- **当时GUI（desktop-12）**：Window64687408中心助手浮起→停靠后，底部商品/商品助手/中心助手顺序与约49/50/50/50分隔比例恢复；9c323a bundle浮窗青绿色描边已出现，未发送模型消息。light主题未验。desktop-13预览浮停结果见顶部当前交接摘要。
- **当时工作簿与CSRF状态**：c9befa bundle的指定工作簿曾显示608个非空单元格、Sheet1及I13；12:25:33另一次来源POST返回403，原因为`X-Csrftoken HTTP header incorrect`。desktop-13后续两次coldboot在同一指定工作簿preview成功；CSRF gate 14/14仍仅为fixture，不代表所有HTTP端点稳定通过。
- **当时真实拖放验收**：父手动将“生产指令单.xlsx”（134 KB）拖入商品composer形成待发送草稿，send启用并显示“已将…加入附件草稿；尚未发送”；未发送/调用模型。该draft为内存态，desktop-13重启后卡片消失，当前恢复待手动操作。此前DevTools未见drop是当次自动化操作未完成，不构成产品失败证据。源码探针已清理，runtime随desktop-13仍有旧探针，待干净同步移除。
- **当时S131/S132差异**：desktop-12观察preview和chat均向右浮起。desktop-13已实机验证preview左浮、右侧chat可见及停靠恢复近似布局，详见顶部。
- desktop-11状态仍仅作历史证据。

## 历史：desktop-11 / 782cdc GUI验收（2026-10-25；已被desktop-12覆盖）

本节只记录desktop-11 bundle `782cdc08e453086c26aba6c0c93f2bfd850ac3bb005cba1ccd357fa65ec27dcd`下的Window9836564与对应旧GUI结果；它们不能证明desktop-12同一界面已验。

- **历史部署身份**：当时正式stop/sync/hidden launch后source/runtime/profile/launcher一致；3088 Electron PID 58996、Django PID 31120、PG PID 52604。此快照是历史记录。
- **V02浮动/停靠**：Window9836564实机先观察三pane底排均分（商品、商品助手、中心助手；root约49%，其它sash约50%），中心助手单独浮起再停靠后，原顺序与比例恢复。聊天历史与两个模型都保留；没有发送消息或创建session。浮窗约覆盖右侧56%，左侧业务可见，无黑色遮罩；青色描边仍不够明显，待视觉细调/复验。此前旧bundle的停靠换序失败由本轮新版实机恢复，按两个不同bundle分别保留。
- **绑定状态提示**：两个native-chat header显示“✓已绑定”，业务pane不显示。该提示只说明role已有session关联，不说明在线或调用成功。
- **S010图像文件网格**：Window9836564显示两列真实缩略图、完整contain、蓝色selected边框与真实文件大小134.3KB/3.6MB。该状态已GUI确认。主preview选择同一`生产指令单.xlsx`后返回HTTP403、workbook unavailable，I13仍可见；主preview尚未通过，业务方正在定位拒绝原因。诊断明确后再追加结论。
- **整体大小/Workflow Graph Electron实机（Window9836564）**：商品scene中14→10（Home测试）→16→14，正文、导航按钮/tab、文件toolbar与原生composer均跟随整体大小。父打开真实workflow `a0618507…`、展开任务，canvas由39%手动调至79%并平移到可见位置；选中黄框、type左带与completed绿badge显示清楚。再执行菜单14→17（slider中部）→16→14；canvas缩放持续79%，节点尺寸/间距、edge端点、toolbar/details随密度同步。回14后截图位置、选中节点与产品资料Inspector内容恢复。末尾点击“适应画布”并还原任务pane；没有写review或执行任务。Headless物理鼠标fixture有node-drag证据，但Electron里未执行node drag，故此动作仍未GUI验证。workflow-graph5验证结果须和这次实机分开记录。
- 此次桌面状态由父实际GUI观察，本代理未操作窗口。部署刷新与上述明确列出的UI动作不代表V01–V07整体通过。

以下逐V组审计保留各时点的实现证据；desktop-11/12部署快照均已是历史，不能覆盖顶部desktop-13当前检查点。更新下方某bundle的局部GUI结论时，只修正受该功能影响的状态，不抹除其他不相关且仍有效的既有GUI证据。

## 历史：203c部署后的候选修复记录（被782cdc及后续desktop-12覆盖）

本节记录旧bundle `203c`时期的失败、源码修复和测试。文中“尚未部署/进行中/S010与graph未GUI”等均指当时状态；当前结论以文档最上方唯一当前检查点为准。

- **V02浮动→停靠失败记录**：旧bundle `203c`窗口中，底排商品、商品助手、中心助手约各占三分之一。只把右侧中心助手悬浮后再停靠，稳定结果顺序变为商品、中心助手、商品助手，尺寸约四分之一、四分之一、二分之一。未操作底层pane；消息历史保留。浮起窗口约覆盖右侧56%，左侧业务pane可见，无黑色modal遮罩；停靠的布局恢复仍失败，故不能记S036/S131/V02停靠通过。
- **Dockview根因及修复候选**：`client.scenes.js`原比较在浮动目标剔除后直接比较序列化的绝对`size`。desktop-11真实Dockview API测试显示，浮起右侧第三pane后剩余两个等宽pane从约323px重新扩展为485px；树和相对比例未改，但尺寸值变化使原比较误判为用户改布局，随后fallback把浮起pane固定插到`business-main`右侧，造成面板换序。当前代码将每个分支子尺寸比例归一后再比较；实际API端到端回归验证右侧第三pane浮/停回原顺序和比例。既有“用户在浮起期间改兄弟比例则不恢复旧全树”的保护测试仍通过。此修复尚未部署，需父GUI验证真实停靠和其它宽度；JSDOM不提供真实floating overlay bounds。
- **会话绑定状态提示**：当前活动native-chat header新增“已绑定/未绑定”，只反映当前role是否关联已有session，不表达在线、连接或模型/工具调用成功，不自动创建session；切换业务pane不显示，role或binding改变会刷新。测试不等同桌面验收。
- **双chat模型设置反例**：旧bundle `203c`下中心会话选择接口A测试模型后，刷新观察到空商品会话也显示接口A；父随后在中心恢复DeepSeek Flash，两pane再次显示DeepSeek Flash。未发模型消息、未创建session，完整模型隔离未证明。desktop-11源码中当前session选择外还保存全局默认；空会话会采用共享默认。此现象不归因于shell context串接，也未改原生模型默认契约。
- **验证范围**：本次desktop-11 shell完整测试266项，251通过、0失败、15跳过；日志 `workspace/runtime/tradeloom-harness/evidence/local-dev-workbench-20261020-02/shell-full-npm-test-dock-restore-20261025.txt`。真实Dockview包的浮/停回归1/1，既有布局用户修改保护回归1/1。JSDOM实际组件/打包API只证明序列化与生产操作链；不替代Electron GUI。未部署/重启。
- **当时待办（desktop-11源码验收时）**：该时点S010文件缩略图/密度与workflow graph GUI尚未覆盖；S120实现使用Host公开session id、role binding与context-pressure，unknown不填0，不读取历史，轮数/压缩字段缺失时显示“—”。之后的S010、workflow graph、S120与附件草稿实机证据见本清单顶部或对应逐项行；这一历史待办状态不再代表当前验收。

## 历史：203c部署与density10刷新记录（2026-10-25；被782cdc及后续desktop-12覆盖）

本节只记录bundle `203c`及Window3349020/15665866的历史状态，不代表当前部署。旧窗口工作簿预览成功不能覆盖desktop-11/782cdc上的HTTP403，也不能证明desktop-12已修复预览。

- desktop-11已通过官方 `workbench-control stop` → `sync-dev-bundle` → `launch-local-desktop.ps1` 正式启动。source、runtime bundle、desktop profile SHA-256一致：`203c62d03652fadea7035d56177d0c506c7c6b6973d8041ecc5437b6fe71ffbd`。DataRoot为 `workspace/runtime/tradeloom-harness/local-dev/workbench-20261020-02`；PG 55432保持运行。实时启动时3088由Electron监听、3090由Django/Python监听。
- **密度10受控刷新（2026-10-25）**：此前`GET /artifacts`（Host `10.16.30.54`）为200但HTML仍引用density9；没有官方Django单服务重载入口，按授权使用官方`workbench-control stop`与隐藏正式launcher重启一次，未同步shell bundle、未改DataRoot、PG55432保持运行。刷新后`/artifacts`为200，只引用`business-ui-density10`；`/static/workbench/styles.css?v=business-ui-density10`为200/110936B，SHA-256匹配源码；`/static/workbench/artifact-browser.js?v=files-browser11`为200/36488B且hash匹配源码。runtime/profile hash未变（`203c62d03652fadea7035d56177d0c506c7c6b6973d8041ecc5437b6fe71ffbd`）。进程快照：CLI 10100、3088 Electron 6636、3090 Python 56532、PG 55432 PID 52604。受控刷新后另有Window15665866 GUI复验，见下一条；启动器成功不能表述为Django完整日志无warning，既有`mandatory-status` warning仍需如实保留。
- **本次Electron局部验收（Window3349020）**：S006单行文件工具栏、真实类型glyph、右侧日期、密度与四pane正常；文件范围原生select以键盘Down/Return切为“来源”后，交付项隐藏，仅显示4条源文件。选择“生产指令单.xlsx”后真实预览显示608 cells、Sheet1及I13图片，选择边框保留。未发送消息、创建session或调用模型。S120共31条（场景6、助手8、其他17）；场景组默认收起且可展开，真实percent与unknown分开，滚轮仅滚用量列表，标题/footer固定，Esc关闭并回焦工具。上述只覆盖此窗口中的这些状态，不代表完整V01–V07验收。
- **density10原生scope下拉GUI已验（Window15665866）**：商品四pane、files实际行和原生composer正常；scope组合框展开为深色底/浅色可读字，选中项系统蓝高亮；Esc关闭后资料保留、composer为空且send disabled。白底浅绿字问题已复验消失。没有发送消息或创建新session。此窗口未重复Window3349020的S120全表、来源过滤或工作簿预览操作；这些仍引用各自原窗口证据，不合并成一次测试。
- shell最新日志 `workspace/runtime/tradeloom-harness/evidence/local-dev-workbench-20261020-02/shell-full-npm-test-usage-reconcile-20261025.txt`：266项，251通过、0失败、15跳过；business定向测试最新为11/11与8/8（8/8日志：`workspace/runtime/tradeloom-harness/evidence/files-density-s006-20261025/test-business-embed-shell-theme.log`；此前7/7为历史结果），file-drop DOM为3/3。file-drop采用真实ReactDOM子节点/原生document listener，但导出和draft callback是stub，不能外推为Electron实拖或完整会话草稿集成已验。静态PNG和离线fixture仅证明其各自静态内容/夹具行为，不替代Electron验收。

## 范围、证据与状态规则

- 主实机参考：`workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V01` 至 `V07`。S001–S135 共135张，S134在V02；按 README 与 `reference-index.md`，S帧是画面证据而非后端功能保证。
- 本文在`tradeloom/docs/`内；所有以`workspace/...`开头的路径都是相对ICT根 `C:\Users\23825\Desktop\ICT`，不是相对`tradeloom`仓库。
- 主文字证据：`workspace/research/video-ui-reference-20261023/observations/2026-10-23-v01-v03.md`、`observations/2026-10-23-v04-v07.md`、`originals/七段视频_UI特点与工作站复用.md`、`reference-index.md`、`extracted/DSH_Workbench_UI_Reference/截图目录.md`、`视频覆盖与排除记录.md`。
- **证据优先级：原视频精确PTS/实机截图 > 同期文字观察 > 后续GPT总结/建议。** 原视频当前位于 `workspace/research/video/`，7条MP4均已找到，编码与时长见父代理的只读清点消息；截图索引的timecode/联系表标题曾出现与精确原视频PTS不一致，故只作寻帧线索，不作精确映射保证。135张S图已逐张实看，但不代表原视频逐帧穷尽；D图是概念材料，不代表实机功能。
- 补充组件证据：`workspace/research/ui-reference-20261022/frame-review.md`、`controls-inventory.md`、`source-semantics-addendum.md`。frame-06/08/09 是相同图像，不重复计状态；source-semantics-addendum 只核实 DSH 原项目资料中的部分标题展开、场景标签行为，不证明 TradeLoom 已有同一 API。
- `extracted/DSH_Workbench_UI_Reference/02_UI示意_非实机/V06/D001–D031` 是概念提案；可检查其中视觉结构，但不得把身份记忆、权限策略、预算阈值、任务暂停、场景九宫格等写成实机能力。主S截图也不能证明后端状态正确。
- 状态含义：**已验**=本轮父代理明确提供当前 GUI 观察；**实现待验**=源文件已含对应组件/样式但本轮没有逐项实机证据；**进行中**=父代理报告正在修改，不算完成；**缺失**=在检查过的现有配置/页面中没有同类组件；**未知**=静态帧或现有代码不足以证明语义。GUI验收只覆盖表中明确描述的窗口与动作。
- 内容边界：替换为织贸真实商品、规格、批次、来源、版本、任务、审批与交付数据。不得复制服务器、股票、实验测量、Blender、ComfyUI、剪辑、私人路径或视频正文；这不构成排除其通用文件树、表格、表单、预览、状态、菜单和布局控件。未接通的排产/报工/ERP/Agent能力不能伪造。

### 新增附件核对（2026-10-25）

- 附件位于 `C:/Users/23825/Downloads/DSH_UI_Timestamp_Notes.md`、`DSH_UI_Codex_Report.md`、`DSH_UI_Codex_Package.zip`、`deep-research-report.md`。时间点说明与参考包内 `字幕与时间点_Codex补充.md` 字节一致（SHA-256 `41c1f5…d7d9b`）；Codex report前缀与仓库原报告完全相同，仅追加该时间点补充。因此它们是原文再包装/补充，不构成独立的新视频证据。补充说明ASS是弹幕评论而非旁白；时间戳只用作定位线索。
- `DSH_UI_Codex_Package.zip` 共341项，含135张S实机帧（V01–V07数量25/18/16/29/13/22/12）、31张D概念图及缩略图；无 `codex_ui_manifest.json`、schema、SRT或MP4。没有执行包内脚本/HTML，也未批量查看图片。
- `deep-research-report.md` 是二级总结/建议，指向本次未提供且Downloads匹配文件中未找到的 `DSH_七段视频_UI全量逐项分析_Codex深度实施包.zip`、manifest与schema。其“7个视频/SRT、13项验收、API/schema”等声称未由现有附件证实。ZIP里确有截图目录和索引，但不含这些完整深度产物。
- 50个补充时间点的S编号/timecode与仓库 `截图索引.json` 标签逐项相符；这只证明索引文字一致，不证明联系表标签对应原视频精确PTS画面。经精确映射，标称134秒样本 `sample-000068.jpg` 实际PTS为134.9833125秒，标称224秒样本 `sample-000113.jpg` 实际PTS为224.9833125秒；源帧证明图分别为 `review-20261025/V01/pts-audit-133-137_223-229/proof-selected-source-pts-2159733.jpg` 和 `proof-selected-source-pts-3599733.jpg`。两组proof图与旧样本的JPEG字节SHA-256、解码RGB像素SHA-256一致（134.9833125s像素SHA `AA910683E8281DB02132794E2665B59B5FC4957A2E3C774ADC58A0E5D19716F3`；224.9833125s `251A6BE240DE2863AF6441B8346A6B00E77BFE072C9A1CE90D93263A02CF68FE`）。这证明旧样本所选帧的PTS，不代表标称整数秒（134.000/224.000）的画面相同；旧联系表标签可能误导，未校准其他样本不得按整数时刻作证。父补看V01：134.9833125s proof画面可见整pane拖入overlay，而实际135.000s PNG为普通chat；故该状态仅证实在特定拖动中间态出现，不代表常驻。先前名义时间170.1/210.417秒spinner均降级为“待校正线索”。标称230秒精确帧显示左上about tooltip（DSH/workbench版本、Electron/Chromium/Node/engine path），该状态原S帧没有覆盖；标称226秒精确画面有椭圆剪辑标注，归属待辨，不直接复刻。
- 映射/索引为 `workspace/research/video-ui-reference-20261023/review-20261025/V01/pts-audit-133-137_223-229/fps-mapping-full.json` 与 `.csv`；八页校正联系表 `sample-contact-actual-pts-001.jpg`–`008.jpg`。源视频为 `workspace/research/video/无限进步 P1 我被ai解放了！deepseekharness太好用了_41973059542.mp4`。名义134.5/224.5网格图可辅助浏览，但不是旧联系表样本实际选帧；实际选帧以proof-selected文件和哈希为准。
- V02抽帧另有PTS校正：视频 `workspace/research/video/无限进步 P1 deepseekharness超级拼装！大量实验分析的人爽了！_42053405851.mp4`，SHA-256 `FCD3FFD4FEC2197BBFF0CD23D63332E53989DA46E820DF268DCCCF7700BD5C45`，16k tbn。60张旧样本的实际PTS都比旧tick标签晚0.9833125秒；新映射在 `review-20261025/V02/pts-correction-20261025/sample-times-actual-pts.json/.csv`，新联系表`sample-actual-pts-contact-001.jpg`–`004.jpg`。旧 `V02/sample-times.*` 与 `sample-contact-*` 不作为准确时间引用。1/30/60号样本源PTS为15733/943733/1903733（各除以16000），proof文件名 `proof-v02-sample-001-source-pts-15733.jpg`、`proof-v02-sample-030-source-pts-943733.jpg`、`proof-v02-sample-060-source-pts-1903733.jpg`；源帧proof与旧JPEG文件字节hash、解码像素hash均经核对一致。
- 对下列核查，证据标签区分为：**视频可见**（画面中可见的控件/关系）、**文字记录**（观察/报告描述）、**近似提取**（从画面估读的颜色/尺寸/比例）、**设计建议**（深度报告建议的API、数据模型或测试）。近似值与建议均非源代码合同。用户最新要求是参考独立预览《DSH 布局参考（独立）》；如果图像字号难判断，就略大于该预览。该快捷方式指向`workspace/previews/luanyujia-reference-20261020/start.cmd`，其启动`adapter/`本地Electron预览。`adapter/index.html:2`标题/stylesheet；`adapter/style.css:1`是压缩单行CSS。根字体为14px/1.45，面板标题11px，文件行10px，图标控件13px，scene label/辅助文字多为9–10px；这不是统一按钮尺寸。嵌入的真实DSH聊天采用宿主主题：聊天正文默认14px、secondary默认13px。用户明确“字号”包括按钮、组件等尺寸：界面大小菜单默认14、范围10–22，以比例同步shell/原生聊天tokens与业务`--wb-ui-scale`；字号及按钮/图标/标题条/内边距/间距/卡片均缩放，保持参考分层略大且整体紧凑。shell `c9e76e4b…`已部署，Window3411404实机验菜单稳定打开、14→16可调整、导航/按钮/文件行/composer控件变大、Ctrl+R持久化、恢复14和Esc焦点通过。此前发现恢复14后局部标题/原生composer可能滞后；token同步已修，14→16→14回归通过。更多窄pane/overlay组件的密度仍需逐项核对，不把全部组件密度标为已验。
- 后续复核时证据优先级仍为原视频精确PTS/帧图高于文字观察，高于GPT总结；父已逐张实看135/135张S帧及31/31张D概念图。两类图片视觉复核完成，但不等于连续原视频逐帧审查、源码/GUI需求完成或功能验收。凡文字标题与画面冲突，以实际画面为准；未核PTS的时间仍只是线索。

### 历史：shell自动化及零事件拖放记录（2026-10-25；当前拖放观测以顶部DevTools记录为准）

- **附件拖放（历史GUI空操作记录）**：Sky窗口状态读取受安全策略中止，未执行拖放。独立headful诊断runner记录0个事件后正常关闭；零事件只表示该次未操作，不代表拖放成功/失败。后续顶部记录的真实DevTools观察只看到source `dragstart`/`setdata`和chat `dragenter`，且custom MIME存在；未看到`dragover`、`drop`或export。新旧证据不可互相替代或合并成完整链路结论。
- **布局/密度**：14→16→14 token同步回归已通过。该时点文件定位后内容恢复已有父实机证据，但files pane位置由父手动拖回右上，精确比例及持久化未验；此记录不覆盖后续部署状态。
- 证据日志：`workspace/runtime/tradeloom-harness/evidence/local-dev-workbench-20261020-02/file-drop-dom-test-20261025.log`（3 pass/0 fail/0 skip，显式runtime）；`file-drop-dom-test-default-env-20261025.log`（默认环境3 skip/0 fail）；headful零事件记录为`artifact-browser-sky-drag-result-2026-10-25T02-09-52-423Z.json`。

### 主代理逐图复核追加：V01 S001–S006

| 帧 | 新确认的可复用视觉要求 | 织贸适配/当前验收点 |
|---|---|---|
| S001 场景导航 | 宽屏时各场景标签均显示图标+文字；只有空间不足时才进入compact。当前场景高亮属于选中状态。 | 不应只让active/hover标签显示文字；检查宽屏所有标签可读，窄屏compact后仍可辨。V05另有密度状态，分别对照。 |
| S002 多面板总览 | 面板按职责组合；聊天是单一主标题条；底色近黑冷灰，面板边界清晰。 | 以织贸真实职责配置面板，避免重复标题/嵌套多条顶栏；面板底色层次做差异但不过度提亮。 |
| S003 状态指标 | 指标为2×2卡片，内层近黑；标题较小、数值突出、进度条细，底部服务状态横排。 | 可复用紧凑指标层级与状态行；仅当真实业务API提供时显示织贸指标，严禁伪造CPU/服务器健康数字。 |
| S004 终端 | 近黑内嵌内容区；header展示连接状态，底部有命令输入。 | 业务操作日志/可用命令入口应单独评估真实功能；普通表格不是终端的视觉或交互等价物。没有真实命令能力时不仿制终端操作。 |
| S005 云文件目录 | category chips与当前path位于同一header，内部为有边框的文件容器。 | 对照分类筛选与路径信息的层级/同栏布局；分类chip不应被误作树路径。 |
| S006 本地文件列表 | 紧凑单行：黄色文件夹图标、左侧名称、右侧小号日期；header中路径为绿色chip，旁边有打开/上级操作；滚动条只在内层列表。 | 下一项最高优先视觉核对：图号`V01 / S006 本地文件列表`。当前对应`workbench/templates/workbench/artifacts.html`、`workbench/static/workbench/artifact-browser.js`、`workbench/static/workbench/styles.css`及`files` iframe pane。实机逐项确认单行/黄文件夹/名称左对齐/小日期右对齐；绿色路径chip与打开/上级动作在同一header；仅列表内部滚动且长列表不推挤header。仅检查登记资料，不扩展任意目录树。当前是否逐项匹配尚未实机核验。 |

### 主代理逐图复核追加：V01 S007–S025

| 帧 | 新确认的可复用视觉要求 | 织贸适配/当前验收点 |
|---|---|---|
| S007 操作日志 | Header同时有采集间隔、时间、刷新；内tab用描边区分active，灰色disabled；日志monospace左齐且独立滚动。 | 可用于真实业务事件/导入日志；时间范围/刷新必须有真实查询，disabled态不能仅灰而无可达说明。 |
| S008 探活卡 | 黑底状态卡左侧绿色竖边；标题与右侧在线点，地址链接/复制，延迟小字。此绿色表示在线状态，不是selected。 | 仅接真实探活数据；颜色须配状态词/时间，不能把业务行选中套成在线绿。 |
| S009 会话附件与输入 | 附件横卡左type图标、两级文字，右侧打开split按钮；下有copy/赞踩/share/usage/time行；输入为浅灰胶囊并固定底部。 | 当前native chat已有附件/输入实机证据；逐项确认消息动作、附件卡结构和composer固定行为，不推断其全有。 |
| S010 文件网格 | 真图片2列缩略图、contain保比例、文件名/大小、选中蓝边。类型字母图标卡不能替代真实缩略图。 | Window9836564曾实机验两列真实缩略图contain、蓝色selected边框、大小134.3KB/3.6MB。desktop-13另在两次coldboot对“生产指令单.xlsx”预览成功（608非空单元格、Sheet1、I13）；保留为不同状态/版本的局部证据，不代表S010所有行元信息均在desktop-13复验。 |
| S011 拖拽缩略图 | 特定拖动中间态出现覆盖整聊天pane的半透明thumbnail/overlay；proof帧约134.9833s，实际135.000s已回到普通chat，因此不是常驻状态。单帧不证明附件落下后已接收。 | Window8785158三次早期Electron实拖未形成附件，是历史尝试；之后desktop-12父手动将“生产指令单.xlsx”(134 KB)拖入商品composer，真实原生draft附件出现、发送启用并显示“已将…加入附件草稿；尚未发送”。该文件到当时会话draft路径通过；desktop-13重启后draft消失，恢复仍待手动操作。fixture的page.mouse drop仅证明fixture dropzone收到事件，不替代Electron证据。未发送消息/调用模型，不外推其它文件/会话。 |
| S012–S013 展开chat | 展开态青色细外框、单一header；Markdown标题/bullets/表格分隔/inline code/file chip；右下scroll-to-bottom；发送区保持底部。 | 青框是聊天展开/浮动状态候选，不等于当前页选中。聊天功能GUI已验核心，消息格式与滚动动作待逐项核。 |
| S014–S016 移动输入状态 | 浅色native chat：空输入时send淡蓝，输入后亮蓝；发送中变白方块stop；用户消息淡蓝气泡有时间/copy，另有思考状态。裁图不能证明整套mobile breakpoint。 | 只作为状态样式证据；本轮桌面窗窄化验收不等于移动端适配验收。发送/停止依赖真实host状态，本轮未调用模型。 |
| S017–S018 场景加载 | 相同站点布局为大预览上左、文件上右、项目卡/网址卡左下、大chat右下；空到有内容时外围几何稳定，chat有载入态。 | 可迁移稳态分区与loading反馈；织贸卡片仅绑定真实项目/来源，空态变化不应导致面板跳动。 |
| S019 工具未运行 | 中央图标/标题/说明/outline蓝启动按钮；header显示灰状态并有启动/关闭/重嵌动作。 | 只为织贸真实可启用的服务展示对应动作；不仿造Blender等工具或无效启动入口。 |
| S020 产物卡 | 画面是视频、工程、MD三个产物附件卡，不是tool-call结果；窄chat权限/模型文字折叠为icons。 | 附件/产物卡不可误记为工具调用消息；缩窄后图标需有tooltip/aria名称并保持权限/模型可辨。 |
| S021 服务控制内页 | 工具内页含6个紧凑指标、横向动作、最近输出thumbnail、底部双列清单/进度。 | 可迁移信息层级至真实业务运行台；不得复制GPU等示例数值。指标来源和更新时间必须可追溯。 |
| S022 技能列表 | 单列整行卡；顶部数量/path chip/open/help；卡左青边、图标/名/type badge/描述、右侧可用状态，分隔后有路径与打开正文。 | 可复用目录/详情信息结构；仅当织贸真实提供可用技能实体时实现，状态不是当前卡片选中态。 |
| S023 插件弹窗 | Modal标题+close、路径提示条、name/version badge/description/path逐行信息。 | 宿主插件详情是否保留需逐项实机确认；不要把仅可达入口说成详情已验。 |
| S024 usage浮层 | 总量粗体左右布局，分隔线，下方三项统计/百分比。 | 仅在host提供真实usage值时显示；popover独立于业务指标，缺数不填0。 |
| S025 chat覆盖 | 右侧浮动chat约覆盖75%，左侧约25%底层pane仍可见；青细边+暗影，不是整屏黑罩modal；消息可见上下文注入/思考/停止状态。 | 已验浮动chat覆盖与底层可见、停靠/刷新恢复；约75/25比例与上下文注入等细节应单独复核。区别浮窗shadow与选中光晕，不把背景整屏遮黑。 |

### 六类组件细化验收约束

| 组件簇 | 需逐项对照的可复用视觉/状态要求 | 证据性质与可用定位 | 当前实现映射及审查界限 |
|---|---|---|---|
| A. 文件树、上传与选择 | 文件夹层级/缩进、展开箭头、当前位置与上级；行/卡视图切换、类型图标/缩略图、文件名和元信息；hover、selected、focus、空/加载/错误/重试；上传queued/uploading/processing/success/error/cancelled分别呈状态、进度和可执行动作；拖到会话时预览与附件身份。 | V01 S006/S010/S011，V02 S026/S029，V04 S068/S069，V06 S117/S118；画面可见UI不证明文件权限/API，文件生命周期枚举属于二级报告建议。 | `artifacts.html`、`artifact-browser.js`提供登记资料列表/选择/预览桥；source缩略图grid仅在可信`thumbnail_url`可用时显示；无通用目录树/任意路径。Window8785158的两次早期拖入未形成附件，是历史尝试。desktop-12父后续手动把“生产指令单.xlsx”(134 KB)拖入商品composer，附件进入待发送native draft、send启用且状态提示加入附件草稿；preview选择联动也可见。desktop-13重启后该draft卡片消失，当前恢复待手动操作。未发送或调用模型；场景unit/DOM测试仍未覆盖真实Electron全部跨iframe事件链。 |
| B. 文档/媒体预览 | 独立pane标题和操作；PDF/Markdown/表格/图片/文本内容各自阅读区与滚动；适合/缩放/原尺寸、刷新/重读、打开/定位/复制/关闭等动作只在真实支持时出现；预览加载/不支持/失败；文件列表选择驱动预览，来源与派生物可区分。 | V04 S063/S085/S086，V06 S101/S106，V07 S123/S124/S125/S131/S132/S135；代表帧的可见控件不代表本业务已有对应文件类型或系统操作。 | 既有Markdown Source/Reader内容、footer固定、独立滚动、定位重开与重读恢复在Window37424282通过；这是保留的既往证据。当前desktop-13另在Window27789548及Window16187696两次coldboot验同一登记工作簿preview成功（608 cells、Sheet1、I13），预览float左约56%/94%且停靠恢复原pane顺序与近似分区。具体当前窗口/比例见文档顶部。PDF通用viewer仍因织贸无PDF artifact类型/API而不适用；不外推任意文件预览。 |
| C. 聊天、消息与队列 | 消息正文/工具结果/表格/附件卡分层；历史区独立滚动、composer固定底部；未绑定禁用、输入/排队/运行/完成/失败、停止/重试、空态；双chat分别标识上下文并隔离模型/消息/附件；queue tray与任务队列区分，不能伪造计数。 | V01 S009/S012–016，V02 S028，V03 S047/S049，V05 S091/S097–100；消息part schema与完整双chat隔离仍需核验；desktop-11已定位真实QueueDock宿主组件。 | Window8785158已并列打开中心/商品chat，商品unsent draft只影响自己的输入框。父在中心history区滚动(-533至首条A用户消息、+664回末尾)未带动商品空history/composer；只证明该history滚动独立。desktop-12后续手动将“生产指令单.xlsx”加入商品composer的native draft，见A项；该draft重启后消失，当前恢复待用户手动操作。完整工具/provider/context隔离及QueueDock/发送状态仍待核。早期三次Electron实拖、自动DevTools未见drop均是当次操作未完成的历史证据，不代表当前产品失败。 |
| D. 流程画布、节点与运行详情 | 点阵画布、节点类型/端口/连线、缩放/适应/整理；节点模板与实际运行实例区分；选中描边、运行/等待/成功/失败文字图标、结果分支、错误详情；节点菜单分组与长菜单滚动；详情表单标签/说明/校验/取消保存。 | V03 S044/S057/S058，V04 S059/S074–086；idle/queued/running/success/failed/cancelled枚举、画布操作与运行API有些属于设计建议。 | 当前Django `workflow_detail.html`/`workflow-graph.js/.css`实现真实计划、步骤、事件、审核和Artifact图并已在desktop-11；图形细项GUI未验。父已核验PR #1的React canvas方案，但它有模拟executor/内存run、JSON持久化到`DSH_HOME`等独立运行域；合并曾被`dd5b829f`撤销，不得擅自重合并。后续比较/衔接以队友PR分支为参考，不把其能力称为已部署Django功能。 |
| E. 工具、技能、历史、健康与上下文 | 工具/技能/插件分组卡与版本/状态；历史分组、当前选择、归档/恢复；健康树按分类显示正常/异常/未知；上下文/usage popover与消息队列分开；空、加载、错误、无权限需可读说明。 | V01 S019/S022–024，V03 S046/S051–055，V05 S092/S095/S098，V06 S111/S113/S119/S120；建议API/usage结构不构成当前后端证据。 | 原生侧栏入口实机确认可达，Plugins实现位置与单会话ContextMeter/StatsPills/TurnUsagePanel源码已定位。Window3411404已GUI验Skills双列卡片、selected蓝边、卡内滚动、固定header及Esc关闭；health tree三组置顶、中文badge也已验。全局S120 popup显示1个绑定/1个已载入会话，tokens unknown/unknown且Esc关闭；完整14条/分组/字段限制见S120与下方用量行。单会话ContextMeter另已打开并验证Esc关闭，不能与全局清单混为一项。Dock sash z99穿透旧overlay的问题已修；全宽root sash修复已部署。父实机拖动记录Down 50→53%、Up 49%，并以鼠标恢复初始状态；证明可调/可复位，精确比例持久化仍待验收。 |
| F. 全局视觉与操作反馈 | 深色壳/面板/抬高层/浅纸预览背景分层；细边框、圆角、统一间距、标题/正文/辅助字号与字重；selected glow与floating overlay分别表达；hover/focus/disabled/等待/加载/错误各有可读状态；弹层阴影/z-index、内部滚动、键盘/Esc、窄窗折叠与恢复。 | V01 S001/S025，V02 S035/S036，V04 S060/S072/S077，V05 S090，V07 S131/S132；具体hex、4/8/12/16/24间距、半径、阴影值属于估读或二级报告建议，不是精确视频事实。 | shell界面大小菜单已部署，Window3411404已验基本缩放、导航/按钮/文件行/composer控件联动、刷新持久化、恢复14及Esc焦点；同步token的RAF时序已修并有14→16→14 inline/dock/composer回归。Capabilities与共同overlay层级已有验收；当前bundle含root sash修复；父实机已试拖Down 50→53%、Up 49%并用鼠标恢复，证明可调和可复位，非持久化/精确比例回归通过。 |

## 当前实现文件索引

| 代码文件 | 本清单用于判断的职责 |
|---|---|
| `tradeloom/packages/tradeloom-shell/scenes.json` | 配置场景的业务 iframe / native-chat 面板身份、默认路径与初始几何；可选角色聊天不代表已经实机验证双聊天隔离。 |
| `tradeloom/packages/tradeloom-shell/client.scenes.js` | 场景标签、NativeChatPanel、PanelFrame、Dockview尺寸/展开/浮动/恢复、标题栏动作、工作区渲染。 |
| `tradeloom/packages/tradeloom-shell/client.js` | 壳层与业务 iframe 的颜色方案/字体 token 桥接。 |
| `tradeloom/packages/tradeloom-shell/dock-layout.js` | Dockview布局序列化、恢复、校验与旧布局迁移。 |
| `tradeloom/workbench/templates/workbench/base.html` | 业务应用页框架、导航、嵌入态隐藏重复导航与样式/脚本版本。 |
| `tradeloom/workbench/static/workbench/styles.css` | 业务模板视觉、字号、按钮、状态、表格、表单、预览与响应式规则。 |
| `tradeloom/workbench/static/workbench/app.js` | 业务交互与表单/路由公共行为。 |
| `tradeloom/workbench/templates/workbench/home.html`、`products.html` | 工作总览和商品资料。 |
| `tradeloom/workbench/templates/workbench/agent_center.html`、`workflow_detail.html` | 计划、子任务、依赖、审核/等待状态、事件与运行详情。 |
| `tradeloom/workbench/templates/workbench/artifacts.html` | 来源导入、工作簿单元格预览、交付版本/预览/下载/来源校验。 |
| `tradeloom/workbench/templates/workbench/runs.html` | 运行记录、事件和平台健康信息。 |

**历史部署快照（desktop-11/6568ec7）**：下列是Window12061600的独立验收记录，不是当前desktop-13 PID或部署身份。该窗口在原DataRoot coldboot后模型目录A/B/DeepSeek、files来源行与产品资料库正常；未先访问运行记录，直接打开optional center即可看到既有A/B历史；商品历史空，两composer空且send disabled。未见connecting/错误/iframe空白/菜单无响应。关闭临时center后四pane恢复、files右上。该证据验证当时只读existing binding hydration和retain重入修复；未发消息、未建session。Reader的footer/header、独立滚动、SVG、定位重读由Window37424282另行验证。完整双chat隔离仍待验。desktop-13当前部署、身份及新GUI验收以本文顶部当前交接摘要和handoff为准。

**失败revision的历史记录与修复证据：** `d66b00b…`版首次部署后Window4589366出现model directory错误、NativeChatPanel持续connecting、iframe空白和菜单无响应。根因为`packages/api/session-controller/src/client/sessions/service.ts`的`retainScope→publishRetention→list.set`同步通知触发递归：旧helper acquired状态在retain返回后才置位。现修复为前置acquiring guard、pending catalogue只读refresh并先置refreshRequested，ModelDirectoryRail复用helper。父审源码及`workspace/runtime/tradeloom-harness/evidence/local-dev-workbench-20261020-02/shell-modelrail-reentrancy-npm-test-20261025.txt`日志（263 tests、248 pass、0 fail、15 skip，target 3/3）；随后bundle `6568ec7d…`Window12061600 coldboot GUI正常。失败revision保留作历史，不作为当前状态。

### 文件/文档预览源码核查（只读）

此处的“预览器”是工作台`files`/`preview` pane中的业务预览容器，不存在已定位的独立通用Markdown/PDF桌面查看器。文件选择与预览桥已在desktop-11 shell/业务源码；以下区别用于避免把容器存在误记为各类viewer已实现：

| 真实业务入口/源码 | 当前行为 | 与参考的差异及可执行闭环 |
|---|---|---|
| `workbench/templates/workbench/artifacts.html:219-236`、`workbench/static/workbench/artifact-browser.js:308-394`；`/artifacts#files`、`/artifacts#preview`及deliverables角色 | 只从后端登记来源工作簿和ArtifactVersion构造文件条目；点击/拖动会设置`kind/id`并驱动同工作区选择。来源侧显示工作簿单元格预览、原件下载及当API返回时的图片；交付版本显示文件元数据、折叠的校验来源、下载，且只有`preview_url`时进入sandbox iframe。 | S063/S085/S086、S101/S106、S123/S131/S132中的“文件选择→预览、独立pane/浮层并保留底层”有容器/选择桥基础；Window9770188及Window1968974确认真实来源选择/内容显示。第二批Window37424282已验Markdown footer/reader独立滚动、定位重开并重读还原内容；files右上位置由父手动拖回，比例仍需精确性验证。**文件列表刷新不是已选文档的重读。** |
| `workbench/views.py:416-479`、`workbench/delivery/service.py:1200-1215`、`workbench/api.py:181-242`；预览API为`/api/workflow-tasks/<workflow_id>/artifact-versions/<version_id>/preview` | 现存真实交付预览类型为catalog HTML、catalog Markdown和sample checklist CSV；CSV有专用模板校验/表格呈现，HTML/Markdown以登记字节和MIME返回，校验SHA后放入sandbox iframe。JSON质检报告/清单没有在线预览URL。业务登记没有PDF artifact类型。 | `text/markdown`端点仍返回原始已登记Markdown；desktop-11正式bundle已含catalog Markdown Source/Reader。Window37424282已验真实内容渲染、footer固定、正文滚动及定位后的重读恢复。PDF控件（页码、缩放、打印/下载）、任意来源PDF预览仍无真实业务类型/API证据。没有登记PDF类型时维持说明+下载，不造入口。 |
| `artifacts.html:230-233`、`artifact-browser.js:211-230,238-306,598-645` | 当前preview header含名称/状态、图片专用适应/100%/±控件、下载；文件信息和技术来源可折叠；图片按安全预览URL显示，workbook另用现有cell/grid preview。刷新按钮仅重载文件列表或deliverables页面。 | S063/S085/S131可见的重读/系统打开/定位/复制路径/关闭按钮目前没有对应viewer动作。未接入前不要显示无效控件。实现顺序：先建立安全的登记文件身份/虚拟路径及真实操作契约，再接“重读当前preview、打开支持的外部viewer、在业务列表定位、关闭/返回pane”；仅当业务存在可展示的相对路径时才提供复制路径，不暴露内网绝对`file_path`。 |
| shell `packages/tradeloom-shell/client.scenes.js`与业务`workbench/static/workbench/intake.js`/`artifact-browser.js` | Shell `preview` pane和文件选择/ready桥承担pane布局与跨pane选择；`ArtifactMarkdownPreview`为真实catalog Markdown提供Source/Reader。正式desktop-11在Window37424282验收Source/Reader固定header/footer、正文独立滚动和重读恢复；files tab由父手动拖回右上并恢复四pane，比例约49–50%，不是布局持久恢复证据。Window12061600已GUI证明商品existing binding coldboot hydration正常，optional center可读到既有A/B会话历史。该窗只确认绑定/面板可用，不覆盖完整双chat隔离。 | 参考 `S101_V06_01m11s250_三文件联动_文档预览与聊天.png`、`S106_V06_04m09s750_PDF预览与原工作区.png`、`S123_V07_00m31s750_文档预览_上下文与会话分栏.png`、`S131_V07_02m01s250_文档预览停靠在左下.png`、`S132_V07_02m02s750_文档预览扩大到左侧.png`显示内容查看器及其浮层布局；当前实现/部署与验收状态见下文checkpoint。PDF能力没有业务类型证据，不从容器geometry推断。 |

**精确图文对应：** 研究文字`workspace/research/video-ui-reference-20261023/observations/2026-10-23-v04-v07.md:19,41-43,67-72,94-105`记录S063/S085/S086的图像预览header（重读/系统打开/定位/关闭）、S101/S106的DOCX经PDF viewer页码/缩放/打印下载、S123的上方Markdown reader与下方双chat、S124/S125文档列表和S131/S132停靠/浮动PDF preview。S135仅显示文档管理标题、绿色路径chip和工具栏裁切，不证明按钮具体行为。对应图片的准确basename见各V组清单；这次只查文字和源码，未重新打开图片。

**catalog Markdown reader当前状态：已部署并通过本批实机内容/滚动/重读检查。** desktop-11 runtime复用安全renderer：`workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-11/packages/client/ui-primitives/src/index.ts:109-110`导出`MarkdownText`，module loader同步`require`先查静态seed；shell `packages/tradeloom-shell/client.scenes.js:7,1117-1229,1844,2773-2794`仅对真实登记`catalog.md`提供Source/Reader、刷新、版本复制、定位、下载原文件、关闭及受控pathImages。Window37424282中真实2747B Markdown的Source模式header/footer固定，Reader正文可独立滚动，真实产品标题及既有Demo SVG正常渲染，关闭files后定位并重读能恢复正文/图/元数据。此项不代表任意Markdown/PDF viewer；没有PDF artifact类型，不据S131/S132复制PDF页码/打印功能。files tab回右上与四pane恢复由父手动完成，精确比例保存/恢复尚未验。 |

## V01 — 顶栏、文件、聊天附件与工具/状态卡

来源：`observations/2026-10-23-v01-v03.md` §V01；原图代表帧：`V01/S001_V01_01m50s250_顶栏与场景页签.png`、`S002_V01_01m50s250_运维场景_多面板总览.png`、`S009_V01_02m12s250_聊天放大_附件卡与反馈.png`、`S010_V01_02m12s250_文件缩略图网格.png`、`S011_V01_02m14s250_文件拖入会话_悬浮缩略图.png`、`S019_V01_02m58s250_嵌入工具未启动占位.png`、`S022_V01_03m39s250_技能管理_列表式卡片.png`、`S023_V01_03m47s250_插件列表.png`、`S024_V01_03m50s750_Token统计提示层.png`、`S025_V01_03m57s250_聊天窗口覆盖工作区.png`。

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 顶层导航 | 品牌/工具栏与其下场景栏分层；标签紧凑、当前场景保持可识别名称。S001当前页签高亮是**选中**；不可把光晕一律删除或当装饰。 | `client.scenes.js` 场景页签；GUI已验当前场景选中效果，应用/编辑宿主菜单与原生侧栏保留已验。全部顶层图标密度/hover/焦点未逐项GUI验。 |
| 面板框架 | 面板有独立标题栏、内容区和1px类分隔，标题右侧动作，深色底上区分面板层级；紧凑标题不能与整行导航冲突。 | `client.scenes.js` PanelFrame、`scenes.json`；四区已验布局，不代表所有标题工具栏实现。 |
| 文件导航路径 | 文件pane有当前位置、打开/刷新、上级入口；行列表含文件/文件夹图标和元信息；路径状态随目录变化。S006、S010。 | `artifacts.html`/`artifact-browser.js`已有业务来源/交付列表、分类筛选、当前位置、上级筛选复位、刷新；`scenes.json`已有`files`/`preview` iframe panes。代码与测试存在，需GUI验；它不是层级文件夹树/任意目录浏览，不得暗示全盘浏览。 |
| 文件行与缩略图 | 同一资源区至少有可读行模式和2列图像卡模式；卡含缩略图、文件名、大小；选择项需有可辨状态。S006、S010。 | `artifact-browser.js`提供行/grid切换、ARIA selected与可信`thumbnail_url`。历史Window9836564（desktop-11/782cdc）确认S010两列真实缩略图contain、蓝色selected边框、大小134.3KB/3.6MB；这是独立于后续bundle变化的既有S010证据。当前desktop-13另经Window27789548与Window16187696两次coldboot确认“生产指令单.xlsx”主preview成功显示608非空单元格、Sheet1、I13图片，无403；仅限该登记工作簿路径。不支持任意本地目录。 |
| 附件手递 | 拖动文件到聊天时可见浮动缩略图，落入后成为有文件身份的附件卡；附件卡能展开/打开。S009–S011。S011特定中间态proof约134.9833s有整pane overlay，实际135.000s恢复普通chat；单帧不证明成功落下。 | `client.scenes.js`已有dragover与nonce导出Blob→真实File→scoped native-chat草稿；`node --test tests/scenes.test.js`报告24 pass/0 fail/4既有skip。含rollback断言的patch lifecycle revision 9/9（217.984s）和desktop11 DOM fixture 3/3均是源码/fixture证据。Window8785158早期实拖未形成附件，是历史尝试；desktop-12首次手动拖入曾通过但重启后内存草稿消失。desktop-13 Window16187696用户手动恢复同一登记文件后，父只读UIA确认商品composer内有“移除文件 生产指令单.xlsx”、发送按钮启用及“已将‘生产指令单.xlsx’加入附件草稿；尚未发送”；未发送或调用模型。本次仅证实该文件进入当前商品会话草稿，不外推其他文件/会话。 |
| 聊天主体与消息动作 | 长消息滚动但输入框固定贴底；附件卡、复制/赞/踩等消息动作和元信息行有各自层次；消息正文可用Markdown表格。S009、S012、S013、S020。 | `client.scenes.js`复用原生会话 slot；聊天历史、输入、模型、附件已GUI验。反馈动作、表格排版、固定输入/底部滚动、反馈状态逐项未验。 |
| Composer状态 | 加号、权限/上下文、模型选择、发送按钮在输入区底边；发送后运行态文字/图标，发送控件变停止。S014–S016为移动窄屏状态例。 | 原生输入/模型已验，未发送实模；发送→停止与权限语义依宿主。移动浅色聊天端不是TradeLoom工作台验收范围，响应状态未GUI验。 |
| 工具、技能、插件清单 | 工具/技能/插件分别呈分组卡/列表；插件信息条/关闭按钮、技能用途/路径/正文打开、统计气泡。S022–S024、V03 S051–055。 | 原生侧栏包含插件入口GUI已验；自有业务设置页不应伪造工具目录。技能卡详情、插件/工具详情与使用量浮层是否保留在原生侧栏逐项未验。 |
| 空/加载/未连接 | 未启动工具显示居中图标、解释、启动/重配动作；空预览不伪装运行成功。S017–S019。 | 源码现有共享`PaneState`可表达native-chat未绑定/连接中/失败，以及ERP未配置、配置无效、不可用和fetch失败；connected ERP与QuotationDraft仍走原组件。35项scenes测试31通过/4既有跳过、三边界定向3/3；真实React+SceneWorkbench stylesheet的headless fixture 20项覆盖420×320、dark/light、14/22和5类状态，父已看dark14 loading、light22 error代表图。实现尚未同步；状态视觉/动作尚未在Electron逐项验收，不能称S019/S133完整实机通过。 |
| 悬浮覆盖 | S025青色描边是聊天覆盖工作区状态；浮层有阴影/清楚层叠，底层仍可见；不是选中态。 | Dockview chat浮动遮盖底层、原生刷新后保持、停靠后约60:40比例均已GUI验。阴影/描边色与焦点/选中组合状态未对所有组件验。 |

## V02 — 多工具四区、文档/文件与双聊天

来源：同 observations §V02；代表图：`V02/S026_V02_00m09s750_嵌入会话_文件树_独立助手组合.png`、`S028_V02_00m23s250_双会话并排分工.png`、`S029_V02_00m33s750_文档_目录_双会话四分区.png`、`S032_V02_00m51s250_Markdown表格文档预览.png`、`S035_V02_00m56s750_调整窗格比例后的两列布局.png`、`S036_V02_00m58s250_右侧聊天悬浮展开.png`、`S039_V02_01m25s250_实验场景_分析与图像预览.png`、`S040_V02_01m36s750_图像分析工具_分区和区域选框.png`、`S134_V02_01m36s750_图像分析场景_预览与测量结果表.png`。

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 四面板几何 | 多种分区组合；S029上排文档约75%/文件约25%，下排网页chat/native chat约各50%。网页可浮动覆盖约半区而其余doc/files/native chat仍在。S026/S029/S035/S036。 | Dockview已有场景和浮动/恢复源码，部分resize与恢复实机已验；逐一核实各真实场景的面板比例、未被浮层覆盖的pane仍可见与可用，不能用单一四区布局概括所有参考组合。 |
| 双原生会话 | S028双chat约50/50，各自独立header、滚动区、composer；输入框上方可见任务队列条。原生host历史侧栏/会话内容与网页内自带历史栏是不同层级。 | 并列中心/商品chat、独立输入和历史滚动已有旧窗口GUI证据；Window12061600已验existing roleId绑定经coldboot水合，optional center显示原A/B历史。未发送消息。不得为填充pane新建会话或将织贸任务队列冒充原生未发送消息队列。 |
| 文档查看器 | Markdown/表格文档在独立浅纸面或阅读区呈现；标题与刷新/文件夹/复制等工具栏；与文件列表、聊天共享工作区但分别滚动。S029/S032、S123/S131/S132。 | desktop-11有`files`/`preview`独立pane与选择桥；业务内容为工作簿网格、图片预览及登记Artifact HTML/Markdown/CSV iframe。Window37424282已实机验Source/Reader结构、固定footer、独立滚动和重读恢复。files pane回右上由父手动拖动，比例/持久恢复待验。不是任意Markdown/PDF viewer；无PDF业务类型时不添加PDF动作。详见“文件/文档预览源码核查”。 |
| 嵌入网页与历史 | S026网页DeepSeek左侧约半宽悬浮，内部另有网页历史栏；S030网页欢迎/居中composer且内部栏折叠；S031虽名“历史展开”但画面仅见折叠icon capsule，不能证明已展开；S042网页历史展开且doc/file/native chat保留。原生host history见S027，勿混为一层。 | TradeLoom iframe不具备网页内历史/浏览器操作的默认承诺；需分别识别iframe应用历史和宿主会话历史，不能臆造前端历史。 |
| 原生完整会话 | S027显示host历史侧栏、对话/轨迹、工具状态/路径/diff及右侧历史小地图。 | 原生历史入口实机可达已验；对话轨迹、路径/diff和小地图等是否具备未逐项GUI验证。 |
| Markdown文件 | S029文件标题含filename/icon控件/path/size/time，文件夹黄图标，选中项全行蓝；S032表格网格线与header对比明显，inline code及蓝边callout；独立滚动。 | 当前文件/预览业务pane源码存在，但通用文件夹/Markdown展示尚需真实GUI核验；不能只以iframe页面有内容认定对齐。 |
| 服务控制页 | S033–S035为六项紧凑指标响应排列（6列变4+2）、动作按钮状态可区分；下左reserved placeholder、下右chat。 | 真实业务可用时复用信息密度和响应布局；reserved区域不得塞入伪造状态或新增功能。 |
| chat浮层 | S036右chat青色边框浮在右半，原页面左侧仍可见；可见工具read/edit、思考/压缩/注入/执行中状态。 | 浮层覆盖背景的基础行为已实机验；各种工具状态是Host真实状态，未逐项验收。青边/暗影属浮层而非selected。 |
| 拖动/分离 | S037标题写“面板外拖中间态”，静态画面实际仍是普通停靠四区，不能证明拖动。 | 不把该帧当跨窗拖放或分离面板要求；面板float是另一项已见交互。 |
| 工具空态 | S038标题称“未挂载工具空态”，实际为偏右的独立工作台窗口，服务控制页正在运行，仅左下reserved pane为空。 | 纠正泛称：这是局部空pane，不是整个工具未运行。只有真实服务未运行时才呈启动状态。 |
| 图像分析场景 | S039/S134：左chat约半宽；右上preview约占2/3、files约1/3，右下为工具/结果表；编号01–04青色小badge；chat有红色error/wait-aborted状态。 | 只能映射为真实商品素材处理的来源/预览/结果关系，不复制实验内容。错误/中断必须来自真实状态；编号无业务含义时不可造。 |
| 图像预览控件 | S040多行紧凑工具条含适应/100%/±、选择态蓝描边、数值字段focus金圈、checkbox；棋盘透明背景、窄彩色ROI带与拖拽handles。红粗框可能是讲解标注，不直接当UI。 | 可复用通用缩放/选择/结果分区，商品图需真实图像工具及授权ROI语义。生物/实验参数和测量不能照搬；当前通用标注API未证。 |
| 产物修改汇总 | S041是文件修改summary卡：蓝代码icon、已编辑3文件、绿色+25/红色-3、下方路径列表；不是普通tool output。卡片中的回滚命令只是画面文本。 | 若织贸后端提供版本diff，可做差异摘要并用真实数值/受控路径；命令仅展示不得自动执行。当前是否有对应业务数据待核。 |

## V03 — 流程画布、会话错误/历史、技能与工具设置

来源：observations §V03；代表图 `V03/S044_V03_00m33s750_工作流画布_预览与聊天.png`、`S047_V03_00m49s250_历史记录与失败状态.png`、`S049_V03_01m00s750_单助手欢迎与输入区.png`、`S051_V03_01m02s750_已归档会话列表.png`、`S053_V03_01m13s750_技能卡片网格_展开.png`、`S054_V03_01m20s250_MCP按工具启停弹窗.png`、`S057_V03_01m39s750_节点连线与选中态.png`、`S058_V03_01m55s250_不同类型节点的边框与端口.png`。

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 节点画布外观 | 点阵深底、带颜色类型边线的节点卡、标题/状态/小徽标、圆形端口与曲线/直线连接；需要缩放/适应和节点布局空间。S044/S057/S058。 | 当前Django `workflow_detail.html`/`workflow-graph.js/.css`真实plan/subtask/schema/step/review/Artifact节点与关系、检查器已在desktop-11 bundle；16%最小zoom/左右端口已修，model+jsdom 6/6通过。父核验的队友PR #1为不同React canvas/运行域；合并后曾由`dd5b829f`撤销，当前不重合并；等待按队友分支差异衔接。无GUI验当前节点状态、连线缩放和实际布局。 |
| 选择、运行、状态 | 画布上蓝/青/金边、红/绿点及徽标用于不同节点态，但截图无法完全判定各色语义；需选中、焦点、运行、失败各自图例和可访问文案。 | 源按真实状态和选择关系绘图并区分类型/活动/选择；色彩对应含义尚须父级GUI核验。金色等未确认语义保持未知，不把类型/运行/选择混为一态。 |
| 历史/归档/恢复 | 原生侧栏按工作区/文件夹分组历史；当前行灰底选中；归档列表提供取消归档恢复；主区标题有代理/模式/对话轨迹。S047/S051。 | 原生侧栏与历史入口已GUI验；归档展开/取消归档、轨迹tabs、当前项focus和历史列表密度未逐项验。 |
| 错误和续接 | 错误记录清楚，不只红色文字；失败对话可有“继续”按钮；空态有欢迎、工作区/模式、composer和绑定状态。S047–S050。 | `agent_center.html`/`workflow_detail.html`有真实失败/等待/继续业务动作；native chat原生错误状态依Host。business_mapping只读确认当前真实工作流共2条，均completed，无pending、failed或retryable记录；相应UI无法用真实状态数据做实机核验，属于状态数据缺席，不是功能缺失。不得伪造失败/待审核记录。 |
| 工具、技能、插件弹窗 | 插件列表纵向卡片/详情，含目录来源；技能列表/2列卡片、用途、路径与正文打开；MCP/工具按工具组、数量、启用/停用状态、写入位置和刷新。S052–055。 | 原生插件入口已GUI验，不代表每张卡/路径/详情/状态/刷新全验。业务端未复制第三方MCP工具治理页面；织贸工具目录属缺失/待需求与权限数据。 |
| 会话统计与反馈 | 会话统计小浮层按模型用时、工具用时、TTFT、TPS分行；消息可有时间、复制/赞/踩/分支。S046/S050。 | 原生聊天功能可能提供，父只确认历史/输入/模型/附件；统计浮层和反馈动作未确认，标待GUI验，不能伪造业务指标。 |
| 节点菜单层级 | 画布工具类别菜单应作为overlay覆盖画布而不重排节点；菜单长时内部滚动。具体菜单/键盘关闭/点击因果另需动态验证。 | 源码有类型/关系可视化和受控的人审dialog；并未实现任意plan CRUD或通用节点增删菜单，这是有意按真实业务限制的范围，不应声称参考菜单已匹配。窄窗/键盘/焦点与dialog GUI待验。 |

### 主代理逐图复核追加：V03 S043–S058

主代理已实看V03全部16张（目前135/135张S图和31/31张D图均已复核）。以下为画面可见结论；对应实现、测试与GUI证据分栏记录，不因参考图已看完就标为已实现。

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S043 | 浮动网页有独立浏览器式header：后退/前进/刷新/最小化/外开/关闭；与Dock面板header不同。 | iframe现有title/refresh不能视作浏览器完整控制条；只支持的操作才露出。 |
| S044 | 左上节点画布、左下preview、右半native chat浮动；点网格、彩色类型菜单、适应/整理/状态/Markdown/清空、类型计数；双击节点可开preview。 | 织贸依赖/计划图可先只读展示真实plan/steps；不得把只读图标成可编辑/可执行工作流引擎。 |
| S045 | 文件名称“错误提示”，实际画面没有明显error，只有右chat表格与说明。 | 以可见画面/运行状态为准，不按文件标题推断错误态。 |
| S046 | usage popover左右label/value、分隔线四项（模型时长/工具时长/TTFT/TPS），下方轮次/步骤速度bar。 | Host提供实际数据时才能显示，禁止仿填或把耗时统计混作织贸业务指标。 |
| S047 | 原生完整侧栏+选中history；model selection注入；红色失败413；最右INVALID_REQUEST与minimap。 | 原生历史入口可达已验；失败细节、路径与小地图未逐项验。错误码不能作为新业务状态。 |
| S048 | 思考行中连续插入红色工具错误文本，含repeat-tool-reminder与edit×3。 | 仅在真实工具返回错误/重试次数时展示，不伪造retry/次数。 |
| S049 | 未选workspace欢迎态：工作区/模式选择、虚线composer、disabled send。 | 这是未选工作区，不是运行错误；未绑定/不可发送应区别于请求失败。 |
| S050 | 用户消息右对齐气泡+time/copy；assistant思考可折叠，带actions/usage/duration/time。 | 原生chat核心已验，折叠、metadata和动作仍需GUI逐项验，不将使用量填成假值。 |
| S051 | 设置左tab“已归档会话”选中，右侧记录有title/workspace/age和逐行取消归档；画面无删除。 | 不增加删除语义；归档恢复功能须按真实host能力核验。 |
| S052 | 名称“工具列表弹窗”，画面实际是已安装插件modal：顶部path notice，插件version badge/描述/path，底部内置包计数。 | 插件详情与工具清单分开命名；入口可达不等于弹窗/插件状态已验。 |
| S053 | Skills为自适应两列card grid；sticky count/path/actions header；青色左边、蓝色selected border、类型badge/可用/适用说明、footer路径+正文打开。V01 S022则为单列整行卡。 | 这是不同密度/视口布局，不是冲突；只能呈现真实skills实体/状态，selected蓝边不能简化成青色左条。 |
| S054–S055 | 面板实际是MCP工具组级开关，四组group toggle、蓝enabled pill/灰disabled、tool count及估算token文字、底部刷新使会话生效；并非每个单工具开关。 | group与tool权限是不同实体；不复制固定数量/token值，也不改权限语义。只显示真实管理API允许操作的控件。 |
| S056–S057 | 画布浮层在左约75%，右侧files/native chat仍存在；内容可pan/zoom并被边缘裁切，不是全屏modal。节点端口：灰input环/蓝output环、紫连线点、细曲线、sequence badge、卡内分隔/状态。 | 当前源码已将真实依赖关系与运行状态分开呈现；缩放/浮层/节点类型状态尚未本轮部署GUI对照。 |
| S058 | 被选中的工具节点有金描边+同色左条，其他节点没有全局光晕；画面展示video→剪映连接。节点类型、运行状态、选中态是三种不同维度。 | 只复用类型/选中视觉区分原则；不得复制video/剪映节点或将金色等同运行中状态。以独立文字/icon说明真实业务状态。 |

## V04 — 工作流工具条、表单、文件树、运行与预览细节

来源：observations §V04；代表图 `V04/S059_V04_00m09s250_工作流主场景_四分区.png`、`S063_V04_00m31s750_节点结果与底部预览联动.png`、`S068_V04_01m11s750_文件树内联展开与多级路径.png`、`S069_V04_01m18s750_右侧文件卡片网格.png`、`S074_V04_03m12s250_内容节点下拉菜单.png`、`S075_V04_03m13s750_方式节点下拉菜单.png`、`S076_V04_03m16s250_工具节点下拉菜单.png`、`S077_V04_03m18s250_工具节点编辑表单.png`、`S080_V04_03m27s250_文件节点编辑表单.png`、`S081_V04_03m40s250_方式节点编辑_长文本字段.png`、`S083_V04_03m59s250_运行中的节点状态高亮.png`、`S085_V04_04m57s250_媒体预览容器与标题工具栏.png`、`S086_V04_05m03s250_多分支结果与宽幅预览.png`。

### 主代理逐图复核追加：V04 S059–S061（V04仅审前三帧）

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S059 工作流四分区 | 顶部画布tab、加号和“1 of 3”计数；五类节点菜单；实线/虚线曲线；节点结果thumb。上部约75% graph/25% files，下部约50% preview/50% chat。 | 织贸流程图需使用真实workflow/plan关系；节点计数、可新增类型及结果缩略图应来自实际数据与支持功能。该图本身不证明编辑/执行均已实现。 |
| S060 chat浮层 | 右半chat浮动覆盖；左侧graph仍可见；底部成功toast表示任务已发送至会话。 | 浮层不是全屏modal；toast只在真实发送成功后出现。不要将单纯打开聊天提示成任务已发。 |
| S061 工具未启动 | 真正未启动工具空态：中央图标/说明/start，header有start/close/reembed；右侧files和chat welcome仍在。 | 该态和V02 S038（服务控制仍运行、仅reserved pane空）不同。启停按钮仅连接真实可用业务服务；保持其它pane。 |

父级当前逐图进度已更新至135/135张S帧；此处V04备注仅描述该阶段当时已审的S059–S068，不覆盖后来完成的V04剩余帧、V05–V07，也不表示源代码/GUI验收完成。抽帧联系表标签存在PTS偏差；未校准时间不能作为准确视频证据。

### 主代理逐图复核追加：V04 S062–S068

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S062 | 画布放大覆盖左侧约75%，并覆盖preview区域；node有真实thumb与绿色路径check，连线区分实/虚曲线。 | 节点状态与资源路径须来自真实计划/产物；放大画布会遮盖preview时，应有明确恢复/浮动层级，不能伪造路径check。 |
| S063 | 停靠后被选node蓝描边；左下preview随选择更新为图像，独立显示filename与重读/系统打开/定位/关闭操作。 | 文件选择→preview联动源码/桥接需实际GUI核验；只呈现已实现的动作，不假设所有打开路径或系统调用。 |
| S064 | 运行监控页为2×2 metrics和多service行；组合SSH/log/cloud/files/chat；log为等宽错误堆栈，不应把所有区块都做普通卡片。 | 真实业务运行指标、日志与错误堆栈可以按职责组织；不得复制机器资源数值/SSH能力或伪造服务。 |
| S065 | 右侧选中图片用蓝outline，中央大图contain，底部path与保存状态。 | 商品图查看可复用选中/contain/保存状态，但路径仅用授权业务标识/展示名，不泄露内部绝对路径；保存状态必须真实。 |
| S066 | assistant正文可图文/标题混排；右侧minimap，底部composer固定。 | native chat需分别验富文本/图片混排、小地图和固定输入；不得把右侧小地图误判为普通历史侧栏。 |
| S067 | 尽管标题称“运维会话/结构化表格”，实际为上部doc约75%/files约25%，下部双chat；文档有headings/callout/bullets，未见所称表格。 | 以画面核验内容组件，不按标题推断；织贸业务说明文档可用标题/提示框/列表，表格需求须另有证据。 |
| S068 | 标题称文件树内联展开，画面实际是flat folder/file rows与selected README，不能证明树展开。 | 文件树层级/展开仍待其它帧/真实GUI证明；不得以此帧声称实现层级树。 |

### 主代理逐图复核追加：V04 S069–S087

父级已实看V04全部29帧；以下以实际画面而非标题词语为证据，当前织贸实现/GUI仍逐项待验。

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S069 | 视频缩略图2列；角落play icon，duration+size，蓝色selected状态。 | 只有真实视频文件才显示播放时长/缩略图；不可用文件类型字母卡替代。 |
| S070 | Website pane与file/project/links/native chat共同布局稳定；composer在无可用模型时解释“当前模型不可用”。 | iframe/模型空态需保留相邻pane，并展示真实模型可用性原因。 |
| S071 | 日志等宽、独立滚动，有refresh和time。 | 错误栈/日志内容必须来自真实运行记录；不复制视频示例错误。 |
| S072 | 右chat约半宽青框浮动；左侧node有两个halo表示活动关系，不由静态图推断resize。 | 浮层与节点状态分层表达；不从一帧推断拖动/缩放操作。 |
| S073 | chat内三列表格是“支持状态行”的可复用性说明，不是产品设置页面。 | 用于织贸时必须绑定真实数据和状态定义，不能把demo说明直接当功能。 |
| S074 | 内容菜单项有图标/title/灰色多行description；hover蓝灰；popover较大。 | 仅为真实可用的内容节点类型提供说明；键盘焦点/边界行为仍需实测。 |
| S075 | 方式菜单列出HTML/流程预设。 | 可按织贸场景替换模板，不能照搬无关预设或声明可执行但无后端能力。 |
| S076 | 工具菜单较长且可内部滚动。 | 分组/滚动可复用；工具项以真实权限和能力为准。 |
| S077 | 工具编辑panel蓝outline；name聚焦、description/address、picker、default textarea、红色not-running、helper、取消/保存。 | 配置表单可复用字段密度/状态层级；保存/启动依实际服务，红色状态需表达真实未运行。 |
| S078 | 画布底部legend说明右口主线、下口方式、上口依据；实/虚线代表不同关系类型。 | 织贸流程图要用本业务依赖类型替换，并有图例解释，不直接复用视频节点类别。 |
| S079 | 黄色描边选中的是项目文件夹node，不是内容节点。 | 不以文件夹类型推断节点类型；选中态与节点类型/运行态分开标识。 |
| S080 | Folder editor有长description、path picker、helper及footer actions。 | 文件目录编辑只能用于授权的业务资料路径；不得提供任意本机路径写入。 |
| S081 | Preset editor有name/description/template select/steps textarea/instruction textarea/preview select及footer。画面是实际编辑表单，不只是只读整图。 | 可映射现有业务配置/审核表单；字段/步骤以真实后端模型为准，不新增任意plan CRUD。 |
| S082 | compact green start action位于header；成功toast表示工单已发到指定会话。 | 成功提示须在真实dispatch成功后呈现，不能点击即toast。 |
| S083 | 两个node同时有cyan halo，表示同时活动。 | 多节点活动态需以真实运行事件确认；不能把halo一律当selected。 |
| S084 | 节点含真实thumbnail与绿色filename；尚未生成的结果仍显示紫色待生成。 | 文件/结果状态要区分可用产物与待生成placeholder，不以空图标伪装产物。 |
| S085 | preview有独立title、重读/系统打开/定位/关闭，媒体contain。 | 只有宿主支持的操作才露出；资源路径不能暴露内部绝对路径。 |
| S086 | 选中产物与下方preview联动；多分支结果使用不同aspect。 | 结果关系应与真实产物ID/分支对应；选择态与运行状态分开呈现。 |
| S087 | 实际为text editor/preview，含Save/重读/打开；右chat的工具调用可折叠。 | 文件编辑与预览的保存语义需要版本/权限支持；折叠结果不可隐藏错误/审核状态。 |

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 工作区组合 | 左/中画布约3/4，右窄文件tree，底部预览和聊天；不同工作场景可用多个独立卡片，标题/工具/正文各自分层。 | desktop-13四pane顺序preview/files/business-main/native-chat及用户布局已保留；Window27789548、Window16187696确认工作簿preview和preview左浮/停靠恢复。此为特定业务、尺寸与启动状态的验证，不代表任意场景组合都已核对；iframe仍非任意文件/媒体浏览器。 |
| 文件夹树 | 文件列表有行图标/名称/日期、当前位置与上级操作和独立滚动。S059/S068/S069。S068实际flat folder/file rows，未显示展开树。 | 业务资料浏览器只提供登记分类/列表导航；任意目录树无真实资料API，属于不适用范围，不应伪造。files pane密度/窄宽度有既往GUI与独立浏览器fixture证据，desktop-13未重测每个宽度。 |
| 文件缩略卡 | 视频/图片两列卡片预览，卡片名称和当前目录对应，选择文件可在底部预览。S063/S069。 | 登记资料grid、选择桥与真实thumbnail URL已有实现；Window9836564实机确认两列contain/选中边框/大小，Window27789548与Window16187696另确认当前工作簿preview联动。仅限已登记资料与实际可用图像，不提供任意媒体浏览。 |
| 预览工具栏 | 预览头部有刷新/重读、系统打开、定位/复制路径、关闭；媒体居中且预览区可单独扩大。S063/S085。 | desktop-13已实机验preview左侧浮层（约56%宽/94%高、青绿细边）、右侧files/chat可见及停靠回原顺序/近似分区；reader的重读、定位等另有Window37424282历史GUI证据。只记业务真实支持的动作，不假设PDF或任意系统viewer。 |
| 节点新增菜单 | 内容/方式/工具/看板等分类下拉，图标+标题+简短说明；长工具列表内部滚动；当前触发按钮焦点描边。S074–076。 | 只读真实节点与引用及审核表单有实现并在旧workflow `a0618507…`GUI验过密度/状态；泛化新增/CRUD菜单无业务后端，属于真正未实现且当前不应补造。菜单细节和键盘/焦点待验。 |
| 纵向表单 | 工具字段名称/描述/地址/默认行为/状态；文件表单有路径、选择文件、说明；方式预设长表单有模板、步骤、指令和预览下拉；textarea内部滚动、底部取消/保存。S077/S080/S081。 | 现有图检查器与dispatch/retry/review门禁表单已有入口；旧workflow GUI验过Inspector随密度变化和内容保留，未逐项核字段布局、错误/焦点及取消保存。泛化plan CRUD不适用。 |
| 画布工具操作 | 开始、画布刷新、适应、整理、状态、Markdown、清空、模板等有明确工具分组；节点可拖、端口连线、滚轮缩放、右键修改、双击查看提示。 | 真实计划图已有只读可视化、zoom/pan、适应画布及受门禁操作；Window9836564验14→10→16→14密度与79% zoom保持，但Electron未验证node drag/连线/右键/双击整套参考交互。任意编辑器动作不作为当前能力。 |
| 运行反馈 | 开始/运行前、运行节点边框/警告标记、结果节点缩略、分支结果能区分；状态来自真实运行事件，不能只靠颜色。S082–086。 | workflow_detail/runs呈现真实状态/事件/步骤；旧workflow GUI已见真实“已完成”、选中边框、类型侧带与独立状态徽标。当前真实数据库只有2条completed、无pending/failed/retryable；其余状态是数据缺席，不是缺少代码功能。 |
| 工作流浮窗 | 助手扩大覆盖右侧画布，画布剩余面积缩窄；停靠后回到底部布局；预览/助手状态仍可辨。 | desktop-13已实机验preview左浮、chat右侧可见及停靠恢复pane顺序/约分区；中心助手浮窗→停靠比例恢复另有GUI证据。只覆盖现有工作区组合和窗口，不代表全部分辨率。 |

## V05 — 场景标签密度、原生侧栏、双聊天、队列消息

来源：observations §V05；代表图按实际basename：`V05/S090_V05_00m30s750_工作场景页签的活动光效.png`、`S091_V05_00m37s250_双助手并排的工具结果.png`、`S092_V05_00m55s250_主会话与助手导航.png`、`S095_V05_01m26s750_工作区与多个助手列表.png`、`S097_V05_02m10s250_排队消息浮层与消息条.png`、`S098_V05_02m19s250_会话内风险提醒与统计表.png`、`S100_V05_03m20s250_双面板结论与后续输入.png`。

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 选中和光晕 | 当前场景明显蓝边/发光是**选中**；需与focus和浮动面板外框区分。S090；参考补充 frame-14。 | `client.scenes.js`使用`aria-current=page`样式，GUI已验选中场景；整体focus/keyboard和浮动与选中样式组合未逐项验。 |
| 原生工作区侧栏 | 左侧占宽约1/6，工作区分组、会话列表/滚动、当前行选中灰底、更多会话；插件、自动化、搜索/筛选/新建、设置入口。S092/S095。 | 父GUI已确认侧栏可展开/收起及插件、自动化、上下文洞察、GitHub、搜索/历史、设置可达。desktop-11宿主插件入口定位在`workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-11/packages/client/ui-plugin-manager/src/index.ts`（sidebar id `plugins`，68–72）；Settings内置插件与全局Plugins侧栏是不同入口。已验可达性，不覆盖列表hover/selected/scroll细节。 |
| 双助手 | 两个独立chat分别持有header、消息、输入与结果。S091。 | Window8785158从商品scene用“工作区布局→并排协作助手→中心助手”打开第二chat成功；中心已有旧AB历史、商品初始空历史，两编辑框独立。商品输入一个临时未发送draft只出现在商品composer，Ctrl+A Backspace清空；未发送消息。父实测中心history可独立滚动且商品空pane保持不变；商品因无历史不能证明第二个history滚动容器的独立行为。完整session上下文/工具状态隔离仍需GUI核。 |
| 工具结果摘要 | 长对话用摘要/折叠结果片段、统计/风险用表格；正文继续滚动，底部输入固定并提供跳到底部按钮。S096/S098/S100、V04 S073。 | 业务 `workflow_detail.html`、`runs.html`有步骤/事件表等，但不证明原生chat摘要/折叠消息与跳底工具；待验。织贸risk字段必须来自业务数据。 |
| 队列消息浮层 | 输入附近队列计数，展开后是多条圆角堆叠卡，可见消息内容；这是消息队列面板，不等于任务完成或发送中。S097。 | desktop-11宿主实现已定位：`workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-11/packages/client/ui-conversation/src/client/queue/QueueDock.tsx`（101–140、168–190、236–319、390–410），由`ConversationContent.tsx`（164–169）挂在composer上方，空队列不显示。GUI仍待验计数、卡片、显隐；本轮未发送/排队消息。不要拿`agent_center.html`审核队列冒充聊天队列。
| 仪表/资源 | 资源卡、圆环、进度横条、分区统计在参考中属本机资源运维。S093/S094。 | 不照搬CPU/磁盘/行情数字。若有真实业务健康度则在 `runs.html`呈实测状态；将仪表重绘成业务指标尚待真实服务数据，当前不应装饰性假数据。 |

### 主代理逐图复核追加：V05 S088–S100

主代理已实看V05全部13张，当前总进度101/135张S帧；以下记录参考细节，不代表织贸实现已完成。

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S088 | 分析看板左约1/4全高、中央上方chart、右上grid、下方chat；蓝filter pills+暗色input，卡片icon/metric/bar，事件行左红stripe；chat loading有HARNESS spinner。 | 仅映射真实业务分析；金融数据不能照搬。loading仅随真实等待状态出现。 |
| S089 | 资源/日志数据未到时内容为空但pane几何稳定；chat处于loading而非welcome；组合工作区还分SSH/cloud/log。 | 区分无数据、加载、欢迎；保留pane位置且不造健康数值/服务。 |
| S090 | 标题区并列model icon与绿/灰availability dot；scene行compact时当前项保留完整文字+叠窗icon，其余只显示icon；发光并非所有状态都代表selected。 | availability、selected、浮动标记分开编码；场景名在当前项仍可辨。 |
| S091 | 双native chat约50/50，各有header、职能subtitle/path/refresh/binding，独立error/tool/history/composer。 | Window8785158已在商品scene并排打开中心chat；两边header和composer可分别使用，中心旧AB历史与商品空历史不同，商品临时unsent draft仅在商品输入框出现并已清除。中心history向上(-533)再向下(+664)滚动未影响商品空pane；只证明有内容的一侧滚动独立，未测第二个有历史chat、工具/context/provider隔离或发送结果。 |
| S092 | 完整host sidebar含new/plugins/automations/groups/search/filter/folder；hover行出现ellipsis/archive/pin，active灰底，running circle，右侧时间；主header有agent count dropdown。 | 父已验侧栏入口可达；逐项hover/归档/pin/运行状态/数量菜单仍需验，只有host真实能力才展示。 |
| S093 | 磁盘监控2×2 ring cards（左ring/右三字段）、summary totals与右上poll time、右侧排行bar list、左下大数和list/ledger。 | 只迁移信息层级至真实业务比例；禁止伪造disk/GPU或轮询时间。 |
| S094 | 右侧chat约75%浮动遮盖，左侧约25%原dashboard仍可见。 | 浮动覆盖和底层pane要同时保持；不是全屏modal。 |
| S095 | Sidebar列多个assistant，右侧有两条queue；红框为视频讲解标记，不属产品UI。 | 队列内容要从真实chat queue取值；红框/演示标记不复刻。 |
| S096 | 标题称“折叠摘要子步骤”，实际只显示header的426子智能体count/dropdown，静态画面未见展开内容。 | 不推断子步骤内容或自动执行；count需真实数据。 |
| S097 | queue 40条header和堆叠圆角行。静帧无法证明它是独立modal。 | desktop-11真实`QueueDock`挂在composer上方且空队列隐藏；GUI尚未验证展开形态，静帧也不能断言它是独立modal。 |
| S098 | 普通chat Markdown状态表格+warning heading，不是特制risk组件。 | 可复用表格/警告语义，但织贸风险提示需真实字段/规则来源。 |
| S099 | 完成项/耗时可折叠；文件diff summary以绿增/红减；sidebar绿dot是状态。 | 仅有真实版本diff/状态才展示；绿色dot不是selected。 |
| S100 | 双chat分别有table/code block（language/copy controls）、message actions和固定composer/IME输入；两个scroll独立。 | 父已在Window8785158证明中心history独立滚动且商品history/composer不受影响；两侧复制动作、IME、底部行为及完整provider/tool/context隔离仍待逐项验。 |

## V06 — 文档/文件、技能插件、健康树、上下文浮层与概念图

来源：observations §V06；实机代表图 `V06/S101_V06_01m11s250_三文件联动_文档预览与聊天.png`、`S102_V06_03m10s250_生成结果预览_文件树_底部聊天.png`、`S106_V06_04m09s750_PDF预览与原工作区.png`、`S111_V06_06m24s250_技能管理_多卡片列表.png`、`S113_V06_08m13s250_已安装插件_说明与版本.png`、`S117_V06_09m19s750_文件知识库_类别行与子目录.png`、`S118_V06_09m29s750_文件知识库_PDF条目.png`、`S119_V06_10m38s750_健康检查树_状态图标与分类.png`、`S120_V06_10m51s750_全局会话上下文用量浮层.png`。概念图单列：`02_UI示意_非实机/V06/D001–D031`，具体标题见`截图目录.md`/`截图索引.json`。已用文件系统确认S120该精确basename存在；下一帧为S120，图文件basename不与视频PTS另作冲突推定。

### 主代理逐图复核追加：V06 S101–S119（V06后3帧待看）

父已实看V06前19帧；本节只记录可复用画面事实，功能/状态必须按织贸真实数据适配，不代表实现完成。

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S101 | DOCX实际经PDF viewer展示（page 1/4、100%、±、打印/下载）；左半浮动预览青边，底层图/文件/chat仍可见。 | viewer与workspace overlay关系可复用；只显示后端实际提供的页数、缩放及打印/下载能力。 |
| S102 | 视频原生controls、contain；上部预览约75%/文件25%，下部项目25%/chat75%；项目区域显示clock空态。 | 媒体控制来自真实播放器，空数据仍保留几何；不能把空项目卡称为运行状态。 |
| S103 | chat浮动有青边，底层工作区仍露出。 | 证明局部浮层，不证明覆盖整个窗口或其他操作行为。 |
| S104 | chat浮窗上移并覆盖2×2环图。 | overlay可遮住部分底层仪表；不能由遮挡推断仪表数值/状态改变。 |
| S105 | 文件项为紧凑平列；没有目录展开证据。 | 不将标题里的“展开”用作树已实现的证据。 |
| S106 | DOCX被选中时蓝色状态，viewer显示PDF page 2/4。 | selected与预览当前页分别表达，页码须来自实际文件。 |
| S107 | 复合运维pane：SSH/cloud各半、各有独立标题；下方日志有tabs、poll、mono文字和内部scroll。 | 保留各职责面板与日志滚动；SSH不是织贸默认业务能力，日志仅显示真实服务。 |
| S108 | 深色terminal显示连接状态、底部prompt/input。 | 可复用连接态和输入区层级；不复制SSH能力或开放任意命令。 |
| S109 | 绿色path chip，复制后toast“已复制当前路径”；breadcrumb独立。 | 可复用路径层级和反馈；路径显示需遵守不泄露内网/用户绝对路径约束。 |
| S110 | 环图2×2与排名列表。 | 指标映射真实业务比例/健康API，不能伪造disk/GPU等机器值。 |
| S111–S112 | Skills两列modal；count/path/actions header固定，body独立scroll；卡片蓝selected、青左边、type/availability/description/适用说明/footer path。 | 可复用完整列表/详情层级；技能必须来自真实目录，selected蓝边和青色分类条语义分开。 |
| S113 | 插件modal有顶部path notice，按行展示name/version/description/path。 | 与Skills/MCP分属不同对象，不能混成一类卡片。 |
| S114 | MCP按组可展开，网页版AI下还有子项；count/enabled/token信息跟组展示。 | 分组和子工具层级不可混淆；数量、启用和token只取真实管理数据。 |
| S115 | 当前未选择文档时有空态说明和目录chip，不是纯空白pane。 | 空态保留入口/说明，不能伪造所选文件。 |
| S116 | 知识库文件呈平列folder，无展开三角。 | 不能据此声称树形目录展开已验证。 |
| S117 | 行hover为灰色，但仍不能证明有子树或内联展开。 | hover状态与folder层级独立。 |
| S118 | 有父级`..`行、PDF/MD类型icon/size、灰色hover。 | 仅据此确认列表元信息和parent导航线索，不推断目录权限。 |
| S119 | 健康扫描是实际三角树；title/subtext/count，绿或amber状态；顶部scan summary，hover整行。 | 可映射既有runtime/readiness真实检查；未知/未扫描不可伪装健康或补造检查项。 |
| S120 | **全局**“各会话的上下文用量”参考浮层共14条；分“场景主会话·10条/助手会话·4条”可折叠，行有名称、used/总容量/%、轮数、压缩状态；绿/黄/红表示用量，可超过100%。 | 原图已实际查看。当前Shell用真实Host目录、role bindings与`contextPressure`聚合，不retain/create或读history；`projectedTokens ?? pressureTokens`与`contextWindow`缺失时显示未知，比例不截100%。公开数据没有turnCount/compact state，显示“轮数 — · 压缩 —”。Window9836564实机GUI显示31条，场景6/助手8/其他17；该窗口分组和视觉通过，实际Host目录与截图14条不同，不伪造匹配数。全viewport及阈值矩阵仍待验。旧Window3411404的1绑定/1载入unknown是早期状态，不代表本轮计数。 |
| S121 | 左workspace sidebar有search/filter/new；folder下会话名+相对日期；右侧“已完成 用时18秒”为可折叠完成状态。 | 相对时间/完成时长来自真实会话；状态内容可折叠但标题与状态仍可见。 |
| S122 | 2×2环图；D盘卡有绿色边框和“已选”，右侧排名对应D盘目录；左下两叠小panel、右chat，整体上部约75%/底部区域分布。光晕/边框表示选择，不应所有卡片统一发光。 | 仅复用真实业务指标和选择语义；不复制D盘/GPU数值，不将全卡统一加glow。 |

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| 文件列表元信息 | 目录/路径、图标、名称、日期/大小、行悬停、选中行，以及列表滚动条；文件行状态不依赖颜色单信号。S117/S118。 | `artifact-browser.js`已呈来源/交付登记资料的类型、名称、日期/大小/解析状态、选择态与分页/错误重试；独立`files`pane在`scenes.json`配置。源码匹配待GUI验；仍非子目录树或任意文件详情。 |
| 文档预览层 | PDF/Markdown作为独立文档面板，白/浅纸页置于深色壳，保留原工作区/文件树/聊天；每面板独立滚动与标题操作。S101/S106。 | `preview`独立iframe pane与同步桥已部署；业务支持工作簿单元格和有`preview_url`的交付物。旧窗口已GUI验图片fit、source表格/grid滚动和展开/还原；Window37424282再验真实Markdown Source/Reader固定header/footer、正文独立滚动、Demo SVG及关闭→定位→重读恢复。files pane位置由父手动拖回右上，布局持久恢复与精确比例仍待验。无真实PDF业务类型，不补造PDF页码/打印控件。 |
| 技能卡片 | 滚动列表/卡片，名称/用途/适用说明、目录/路径、详情正文打开；卡片分组清晰。S111/S112。 | shell Skills API弹层实现真实count/选中态、固定header与刷新、宽窗双列/窄窗单列；DOM 1/1且随desktop-11部署。Window3411404已GUI验双列卡、蓝边selected、卡片内滚动、固定header、Esc关闭；详情路径字段及所有卡片文本未逐项核。TradeLoom业务页不另造技能实体。 |
| 插件/工具详情 | 插件名称/说明/版本、安装状态、目录来源或打开位置；开关必须反映真实许可/状态。S113/S114/S054。 | 原生入口已验可见，具体详情/版本由宿主提供与否未逐项核验；业务端设置页不具备该详情卡，缺失/宿主待核。 |
| 健康分类树 | 分类节点、层级、图标/计数、逐项健康/异常/未知；“无数据”不得渲染为0/健康。S119。 | `runs.html`含`platform-health-tree`，`runs-health.css`定义层级和真实runtime状态样式。Window3411404已GUI验三组置顶及中文状态badge；最新overlay z1100统一revision仍待部署/GUI复验。异常/未知交互、窄pane可读性待核。 |
| 单会话上下文浮层 | 单个当前会话的用量入口；未知数值不显示为伪百分比。 | desktop-11 `ui-conversation/src/client/skeleton/ContextMeter.tsx`（56–89、108–177）读取该会话真实`contextPressure`/heuristic；provider没有occupancy/capacity时不渲染，挂在`InputBar.tsx`（520–525），百分比环打开该session详情。源码已定位，父GUI已打开该单会话浮层，看到占用/容量和系统工具会话估算构成，Esc关闭通过。此证据仅覆盖单会话。 |
| 全局会话用量清单 | S120跨session汇总，按场景主会话/助手会话可折叠分组；逐行显示名称、used/capacity/%、轮数、压缩状态。 | `client.js`实现对真实Host session目录、绑定与`contextPressure`的全局聚合/订阅，不retain/create或读聊天正文；`projectedTokens ?? pressureTokens`为估算used、`contextWindow`为capacity，未知值不填0且percent不截100。宿主未公开turnCount/compact status，因此UI明确显示“轮数 — · 压缩 —”。只读list/projection按role绑定、parentId/origin分类，缺少真实目录条目的绑定不会虚构为目录会话。Window9836564曾在desktop-11 GUI验到31条（场景6/助手8/其他17）、折叠分组与基础视觉；这是保留的历史实机证据，目录条数来自该时点Host数据，不能代称S120截图14条或desktop-13当前数量。desktop-13未重复验usage popup。单会话ContextMeter/StatsPills/TurnUsagePanel不是S120全局清单。 |
| D概念提案 | D001–D031逐图视觉观察见下方“D概念组”；它们提供布局/组件提案，不证明实机功能。 | 概念中的通用列表、标签、文件卡、状态卡和折叠样式可映射真实业务；不新增记忆、权限、预算/暂停后端。按每条具体组件需求和实际API评估。 |

## V07 — Markdown/文件、图像对照与预览pane变化

来源：observations §V07；实机文件代表帧以实际basename为准：`S123_V07_00m31s750_文档预览_上下文与会话分栏.png`、`S124_V07_00m38s750_文件面板_上级路径与列表.png`、`S125_V07_00m42s750_文件夹切换后的Markdown条目.png`、`S126_V07_01m18s750_内嵌图像工具_空输入与输出.png`、`S127_V07_01m22s750_内嵌图像工具_输入图片.png`、`S128_V07_01m25s250_内嵌图像工具_处理前后对照.png`、`S129_V07_01m34s250_文档引用与工具执行说明.png`、`S130_V07_01m50s250_文件区_目录树与页签.png`、`S131_V07_02m01s250_文档预览停靠在左下.png`、`S132_V07_02m02s750_文档预览扩大到左侧.png`、`S133_V07_02m05s750_内嵌页面加载与助手空态.png`、`S135_V07_00m38s750_文件面板标题_路径与上级按钮.png`。

### 主代理逐图复核追加：V07 S123–S133、S135

父级已实看V07全部12帧，135/135张S帧复核完成；以下仍只证明截图上的可见组件，不证明全部后端能力/连续视频已审。

| 帧 | 新确认的可复用视觉要求与语义 | 织贸适配/状态边界 |
|---|---|---|
| S123 | 上部为原始Markdown编辑/预览，下方为双chat；各自有标题/subtitle/reload/bound，不是单纯“上下文文档分栏”。 | 双chat身份和绑定状态分开；编辑/保存能力需有对应后端文件版本语义。 |
| S124 | 文件区有上级pill和平列文档小icon/name/size/time。 | 路径/元信息可复用；授权边界与路径展示须遵守业务规范。 |
| S125 | 换目录后布局几何保持，metadata右对齐；首行size没显示不能推断字段不存在。 | 切目录避免pane跳动；数据缺失与字段隐藏语义分别验。 |
| S126–S128 | 局部抠图算法不在织贸范围；可借用原始只读/结果棋盘格双栏、顶部紧凑动作/模型/状态、底部分组工具条/slider/撤销重置保存/路径定位/步骤提示。S127首次处理中展示model；S128完成时有绿色状态、结果名/分辨率并实际前后对照。 | 不复制示例算法/model。只在真实商品图版本与编辑API存在时映射组件；未保存时不能冒充成功结果。 |
| S129 | 标题“文档引用与工具执行说明”不准确：左浮chat内trajectory思考/read/output/待答提问卡，卡有title/collapse/close、长选项及独立scroll；右侧还有独立chat。 | 这是可交互确认卡而非静态文档；需现有review/approval API和门禁，不把两个会话合并。 |
| S130 | 平列目录+Markdown文件，打开/上级toolbar；没有树展开或tab证据。 | 只标平列文件列表/路径导航，不能称层级树/多tab。 |
| S131 | 空图画布仍有canvas tab/+、数量/上限、节点菜单和适应/整理/状态/Markdown/清空/模板/counts；底拖动/连线帮助与zoom。右files约25%，下preview/chat各50%；preview是DOCX经PDF控件page1/2/100%。 | 计划图是只读表示时需标注能力边界；PDF工具数值按真实文档提供。 |
| S132 | preview放大为左半全高的青边浮层，底层canvas和右chat仍可见。 | overlay不清空/覆盖整个场景；selected glow和floating border需区分。 |
| S133 | 网页未载入；右窄chat显示HARNESS spinner与“Loading plugins...”，是loading而非无会话welcome。 | 保留pane和加载文案；加载/空会话/未绑定/失败需区分。 |
| S135 | header有文档管理、绿色路径chip，长路径省略，另有工具栏。 | 路径截断需保留可查全文的方式，不能泄露内部绝对路径；工具只显示已支持动作。 |

| 细项 | 可复用要求与证据状态语义 | TradeLoom映射/状态 |
|---|---|---|
| Markdown/文档内容 | S123上部是原始Markdown文本编辑/预览，下方是双chat；S135 header显示文档管理、绿色路径chip（长路径省略）、工具栏。长文/格式需独立滚动。 | Source/Reader已部署；Window37424282真实检查2747B、mtime、ID、Source/Reader切换，Reader内容独立滚动且header/footer固定；Product Catalog与既有Demo SVG正常，重读恢复完整内容/图/元数据。仅适用登记catalog Markdown，不称通用PDF/Markdown viewer；编辑保存未接真实文档版本语义，不纳入Reader声明。 |
| 图片原始/结果 | 原图和处理结果并置/切换，能区分源与派生版本；编辑动作有撤销/重置/保存约束，不能覆盖原业务资产。S126。 | 当前无图像变换/对照编辑器API，缺失；不得复制生物工程样本/泳道内容，未来应先定义受控副本与版本记录。 |
| 文件夹/详情 | S124上级pill+平列文档小icon/name/size/time；S125切目录后几何稳定、右对齐metadata（首行未见size不代表字段不存在）；S129是带title/collapse/close、长选项和独立滚动的真实提问卡，不是静态文档；S130平列目录+Markdown条目及打开/上级toolbar，没有树展开/页签证据。 | 来源/交付分类列表可显示登记元数据和校验详情；不是层级文件夹树或任意文件详情。对引用/提问卡要接真实交互而非硬编码文档。 |
| dock/expand | S131空画布仍有canvas tab/+、数量/上限、node menus/适应整理/Markdown/清空/模板/counts，底部拖动/连线帮助与zoom；右files约25%，下preview/chat各约50%，preview为DOCX经PDF控件page1/2/100%。S132 preview可扩大为左半全高青边浮层，底层canvas与右chat仍在。 | desktop13 / Window27789548及16187696已实机验：preview左侧浮起约56%宽、94%高，青绿色细边可见，files/chat与底层工作区仍可见；停靠恢复原pane顺序及近似比例。最大化后约顶65/35、底26.6/73.4，像素取整允许差异。计划图仍为只读表示，不宣称完整编辑器；S131 PDF控件的全部操作未逐项实测。 |
| 空/加载 | S133网页pane未载入，右窄chat显示HARNESS spinner和“Loading plugins...”，属于加载态而非无会话welcome；S123下双chat各有标题/subtitle/reload/bound。 | 原生chat welcome/连接与业务empty state需分别显示；加载、空闲、无绑定/失败不能混称。 |
| 图像处理工具 | S126–128为局部抠图工具与结果，不要求复制其算法；可借用原图只读/结果棋盘格双栏、紧凑工具/模型/状态、底部分组工具条/slider/撤销重置保存/路径定位/步骤提示；S127首载processing含model文案，S128完成态绿状态+结果名/分辨率，是真正前后对照。 | 抠图算法在织贸当前范围外；只评估真实商品图编辑与版本能力是否支持通用双栏和状态，不复制示例模型/算法。 |
| chat内交互卡 | S129左浮chat里有trajectory（思考/read/output/提问待答）和带标题/collapse/close、长选项、独立滚动的真实提问卡，右侧另有独立chat；不是静态文档。 | **原生提问链已接通，待真实pending数据与视觉实机核验；不属于缺失功能。** desktop13 `client.scenes.js` 的 `SceneChatPanel` 通过 `renderFactorySlot('conversation.content')` 挂原生会话；原生 `ui-tool` 将 `ask_user_question` 注册到 session-scoped `conversation.chat.node`，其 `QuestionToolRow` 可折叠，展开后 `AskQuestionCard` 自带最高360px内部滚动。原生 `ui-user-questions` 将真实 `PendingQuestion` 注入该会话的 `conversation.composer`，并由 `user-questions/request` 处理；答案经对应 sessionId/callId 的 waterfall 或 `remote.userQuestions.answer(...)` 回传。交互以各自会话为范围；本轮没有真实pending提问样本，未验证其在织贸具体场景中的GUI出现/与S129完全同视觉。此接口不是通用业务审批门禁，不能凭空造待确认事项。 |

## D概念组 — 31张非实机方案图（逐图复核）

父已逐张实看D001–D031。以下记录图中可复用的布局/视觉，不将图示领域逻辑当作现有能力。D图均为概念或说明材料；身份/记忆、权限、预算策略、任务暂停、成本数字、自动写回、算法执行等不能据此承诺。状态统一为“设计参考，织贸映射待核”：后续按真实商品/计划/工单/交付域替换示例内容，并核现有API。`workspace/...`路径相对ICT根。

| 图 | 画面实际可见的组件/规则 | 织贸适配边界 |
|---|---|---|
| D001 | 继续任务进度蓝青条、下一步提示、绿色状态 | 可映射真实任务进度/下一动作；不得伪造推进百分比或已完成状态。 |
| D002 | 上下文提示条、左右对齐消息、角色区textarea与pill标签 | 可复用消息/角色表单结构；不是新上下文记忆系统证据。 |
| D003 | 进度满条呈橙红、旧消息变暗并显示“已遗忘”语义 | 可参考过载/历史折叠对比；遗忘/清理策略不照搬。 |
| D004 | 项目聊天长历史示意 | 只借消息列表层级/滚动；不将图中历史机制当产品事实。 |
| D005 | 新会话header与新建按钮、项目Markdown长段原文 | 可复用新建入口和文档阅读排版；文案与写入能力按现有流程。 |
| D006 | 左侧三张场景卡、active蓝边；中间身份卡；右侧Markdown条目/原文开关 | 可复用场景/任务选择卡和内容列表；场景“身份”数据不可凭图新增。 |
| D007 | 编号规则行、绿色勾选、Markdown已写回状态、当前交接高亮 | 可用于真实校验结果及当前任务高亮；写回状态必须由后端确认。 |
| D008 | 交接文本段、虚线流程箭头 | 可用作关系/说明视觉；不能据此声称跨会话自动写入机制存在。 |
| D009 | 文件header、大小、纵横容量展示 | 可复用文件信息栏/容量指标；数值须来自真实文件元数据。 |
| D010 | 超限橙红状态、归档浮标、交接段虚线边 | 可复用超限/归档视觉状态；阈值与归档能力需真实策略支持。 |
| D011 | 会话1→交接Markdown→会话2三卡流程 | 可用于描述人工交接链；不能表示自动跨会话执行已实现。 |
| D012 | 目录缩略项矩阵、缺索引amber提示、右侧summary、底部虚线排除类别卡 | 可复用文件/索引状态、摘要和筛选说明；不得新增记忆索引/排除策略后端。 |
| D013 | 同类矩阵加成本对照和底部顺序chip | 可复用排序chip/成本栏外观；成本只在真实计量API存在时呈现。 |
| D014 | 场景卡片内含三个Markdown入口 | 可复用卡内多文档链接；链接只指向允许访问的真实页面。 |
| D015 | 左侧sidebar、右侧2×2面板概念布局 | 可借多pane几何；不推翻已验的顶层scene strip。 |
| D016 | 角色header/icon、身份/规则/口吻三条彩色标签、footer文件路径 | 可借标签行和来源footer；不照搬角色人格/身份管理语义。 |
| D017 | 三角色卡用不同色条区分，下面列对应文件来源 | 可映射业务角色/来源卡片；色彩需有文字说明且数据真实。 |
| D018 | 身份与记忆两张文件卡并列，重点行绿色强调 | 可复用并列文件卡/重点行；不新增记忆文件类型。 |
| D019 | AGENTS文件卡amber强调，右侧红色禁止与绿色允许条 | 仅是图中内容示例，不是给本代理或项目增加指令；可借红/绿规则条样式展示真实政策。 |
| D020 | 白色嵌入页居中loading态 | 可映射实际网页/pane加载；须与空态、未绑定、错误区分。 |
| D021 | 三张等高规则卡的normal状态 | 可复用规则/检查结果卡布局；具体规则由真实业务数据决定。 |
| D022 | 规则卡变红，表示负载/往返消息超限 | 可映射真实错误/超限；图中数字和限制不可照搬。 |
| D023 | 余额错误与paused状态、底部处理提示 | 可复用错误原因与恢复提示；余额/暂停策略并非现有功能承诺。 |
| D024 | 九宫格场景缩略布局，各格内部几何不同 | 可用于场景布局选择器评估；不得把图中九格和场景集当现有功能。 |
| D025 | 被选面板青色边框，与旁侧对话指代关系 | 可复用selected outline及关联标识；选中语义不能混同浮层边框。 |
| D026 | 面板结构、位置、尺寸、颜色的数据示意 | 只作为配置概念；不证明UI已有采集/解析此类几何数据的功能。 |
| D027 | 任务卡中新增SKILL.md行以绿色高亮 | 可借新增/变更行提示；不能据此声称技能动态安装。 |
| D028 | 左侧技能名/简介紧凑列表，右侧开销大数字与bar，底部token账单 | 可借左右主次和计量布局；token计费须取宿主真实值，不新增计费。 |
| D029 | 左侧selected行amber、右侧详情同色呼应、底部账单更新 | 可复用列表选择与详情联动；颜色状态不可表示未有的授权/记忆能力。 |
| D030 | 红绿成本对照条 | 可借对比图例；“节省90%”是图中示例数字，不是软件实测。 |
| D031 | 场景/文件/预览/网页/SSH等面板类型palette与plus按钮、下方说明；标题称“输入框内场景标签”与画面不符 | 只映射已支持pane类型的添加菜单；不代表聊天composer支持场景标签，也不增加SSH等后端。 |

**图像复核边界：** 本轮已完成135张S实机截图与31张D概念图的逐张视觉复核（共166张）；父提供了D图逐项观察。它们并非原视频逐帧审完，也不代表图上示例功能已实现。V02–V07共35页scene-change媒体筛查由子代理报告，分别见`workspace/research/video-ui-reference-20261023/review-20261025/video-gap-review-v02-v04.md`与`video-gap-review-v05-v07.md`；父未逐页复看联系表，只能记为未发现已确认的新状态，不升级为父级视频验收。

## 跨全部组：视觉和交互细节验收矩阵

> 以下矩阵保留逐项审查过程中的先前状态。若其状态文字与本文顶部最新bundle/Window验收记录冲突，以顶部记录中明确的bundle、窗口和动作范围为准；不被最新记录覆盖的细节仍按矩阵中的待验项处理。

下面将样式本身拆成独立核查项；参考视频无法精确推出CSS数值，因此“建议值”只使用原说明书区间，最终像素以实际组件一致性/GUI可读性为准。补充 frame-review 的彩色/字体/按钮内容不能当做织贸文案或功能合同。

| 细节 | 参考依据与目标检查 | 当前源码/状态 |
|---|---|---|
| 全局配色 | originals §1–2、observations各组：深色主壳、略亮panel/header、浅色文档页；蓝=主操作/选中，青=焦点或浮层候选，绿/黄/红=成功/等待/错误并配文字/图标。S001/S025/S090/S106；亮色含义非所有组件通用。 | `client.js` palette/theme bridge、`client.scenes.js`壳token、业务 `styles.css`；neutral主题已随desktop-11部署。旧bundle上的部分场景/绿色approved徽章曾验；新bundle的light/dark、对比度与状态token无完整GUI核验。 |
| 背景/层次 | 画布底层与panel、header、popover、modal、白纸预览有明确层级；层与层有对比，避免每卡都同一亮度。 | neutral主题源码已部署；各层级、预览白纸和弹层叠放尚无desktop-11全面GUI验收。 |
| 渐变/辉光 | 只在明确状态用，S001/S090当前场景选中有蓝光，S025会话浮层青边。金色节点S058语义不确定；不能全局加光晕，也不能统一删掉选中/浮层反馈。 | Window9836564在workflow选中节点实见黄色外框、类型左带与独立完成绿badge；中心助手悬浮可用但青色边仍不明显。未做所有hover/focus/overlay视觉逐态核对。 |
| 整体界面大小（字体与组件） | 独立参考HTML的基础字14px/1.45；pane title 11px、文件行10px、icon control 13px，scene/辅助多9–10px；真实DSH chat正文默认14px、secondary 13px。用户允许图像难判断时略大一点，且明确按钮/组件等尺寸也要改。 | 菜单名称“界面大小”，默认14、合法范围10–22，按比例同步调整shell/原生聊天tokens及业务`--wb-ui-scale`。旧窗口已验14→16→14；本轮Window9836564又验14→10→16→14和14→17→16→14，导航、tab、file toolbar、composer及workflow graph nodes/edges/toolbar/details随比例更新，回14后位置与Inspector状态恢复。graph缩放79%保持不变。node drag未在Electron实测。 |
| 字重/文本层级 | 标题/面板标题/字段值/辅助说明区分粗细；状态需简洁可读；行高够中文；时间/technical hash可次级折叠但仍可完整查看。 | templates/CSS具体页面已实现；“已批准”单行、版本来源/SHA展开/收起、标题/底边稳定已GUI验；其它所有截断/长文本未验。 |
| 图标/图标状态 | 工具栏统一尺寸/对齐/按钮hit area；icon-only必须可访问名称或tooltip；图标、badge、文字位置不挤；无语义图标不照搬。 | `client.scenes.js`有场景图标和原生宿主图标；图标tooltip/键盘名字、各业务工具icon一致性未全验。 |
| 间距/密度 | originals建议4/8/12/16/24间距阶梯；常规行36–44px；主要信息区少数关键列，密集工作区不挤。场景tabs紧凑，V05侧栏不能压成窄历史条。 | `client.js` token、client scene CSS、业务 `styles.css`；正文/关键状态改善部分已GUI，完整V01–V07密度/行高未核。 |
| 圆角/边框 | 卡片/弹层适度圆角，标题/主体面板用细1px边界，输入/聚焦边界清楚；S040选框和S077字段focus蓝边。 | `client.scenes.js`与业务CSS各自样式、neutral主题已部署；实际border width/radius、focus及不同overlay的统一性仍需GUI抽查。 |
| 滚动条/独立滚动 | 文件树、消息区、弹窗长清单、textarea各自可滚；composer/标题固定；不能嵌套滚动困住；缩放/浮层不复位滚动。S012/S066/S068/S076/S081。 | Dockview各pane和业务iframe自身滚动；交付物iframe滚动修复已GUI验。其它独立pane/长弹窗/textarea与双chat需实际滚动验。 |
| hover / focus / selected | pointer hover与键盘focus可区分；ARIA selected/current映射选中；卡片被选中可有蓝边/底色；焦点青边不能冒充场景selected；状态有文字而不止颜色。S090/S117/S118。 | shell `aria-current`/业务tab ARIA选择器CSS；当前scene选中/文件版本detail折叠交互有局部GUI证据；键盘tab顺序与hover全矩阵未验。 |
| disabled / waiting | 禁用动作可视但不可执行且解释原因；waiting human/queued有明确状态文案；未绑定不显示可发送，绑定后启用。 | `client.scenes.js` chat connection、业务 workflow statuses；绑定后对话enabled已GUI验；disabled原因、queued/waiting所有状态逐个未GUI。 |
| loading / empty / error | 空态有说明/下一步，加载使用进度/状态而不占永久空间，错误有原因/重试依据/失败阶段；不把未知当健康/0。S017/S019/S030/S047/S133。 | 业务 `empty-state`、`agent_center.html`、`workflow_detail.html`、`runs.html`；当前工作总览/交付物可显示已GUI验；所有错误、空/加载形态未逐项实测。 |
| 浮层/阴影/z-index | hover popover、工具菜单、modal、浮动panel不同层级；overlay应覆盖而不改变canvas geometry；S025、V04 S060/S074/S077、V07 S132。 | 历史Window9836564（desktop-11/782cdc）验中心助手约覆盖右侧56%、业务底层可见、无黑色遮罩；悬浮后停靠恢复pane顺序/比例。青色边在该旧bundle上不明显。desktop-12浮窗边缘像素尚未GUI验；新的selector fix只有DOM集成1/1。Capabilities盖home分隔线的旧GUI验收仍是旧版本证据。 |
| 菜单/气泡 | 菜单有锚点、分组、长项内部滚动、边界避让、关闭/焦点语义；usage/queue气泡显示明确来源和状态。静态图不能推 hover/click。 | native应用/编辑菜单与“界面大小”菜单可打开已验；Window3411404验证界面大小popover稳定打开、Esc关闭回焦trigger。Skills菜单、health tree、global S120基础usage popup也已验各自状态；全局S120的完整14行、QueueDock显隐/锚点及其余popover视觉仍待核。 |
| 表单控件 | 标签、输入、select、textarea、单位/帮助文本、必填/错误/成功反馈；长textarea内部滚动，保存/取消固定；文件选择遵循当前权限。S040/S077/S080/S081。 | 来源映射/业务确认表单在 `artifacts.html`/`agent_center.html`；workflow已有真实表单的人审dialog入口，非任意节点CRUD。各状态/validation/focus未全GUI验。 |
| 表格/列表/树 | 表头、列对齐、行高、行hover/selected、滚动、空结果、筛选/排序/分页；文件列表还需路径/文件类型/日期/大小；数据单位语义。 | `products.html`、`artifacts.html`、`runs.html`有业务表/真实版本属性，`runs.html`健康分类树已实现；父已实看三组和“正常/部分可用/未检查”语义。交付approved/折叠source hash曾GUI验；Window24186174与Window8785158已GUI验source表格与grid独立滚动、图片不随grid滚动，density7标题/分类/toolbar不再与来源列表重叠。任意文件目录树不在现有登记资料能力内。 |
| tooltip/帮助 | icon-only动作需label/tooltip；工具用说明/字段帮助与错误原因；悬停语义不能作唯一渠道。补充 controls-inventory 仅建议控件可用性，截图没证全部tooltip。 | 逐页tooltip/ARIA title未审，状态待验。 |
| 聊天/双chat状态 | 消息history滚动、标题会话/绑定状态、composer固定、附件与动作、队列提示、发送/停止、错误续接；双chat上下文严格独立。 | native单chat核心已GUI验；Window8785158已并列开启中心/商品chat、商品draft隔离，并实测中心history独立滚动(-533再+664)，商品pane保持空。后续desktop-12父手动将“生产指令单.xlsx”(134 KB)拖入商品composer，真实附件进入草稿、发送按钮启用、状态为“已将…加入附件草稿；尚未发送”；未发送或调用模型。此前Electron自动化未观察到drop是当次操作未完成的历史记录，不代表当前产品失败。完整消息/model/tool/context隔离仍待核；QueueDock和发送/停止状态也未逐项验。 |
| 任务/上下文/队列 | 任务状态、审批阻塞、attempt/时间、队列消息/总览、usage分开呈现；只有来自后端真实值才显示，未数据=未知。D图属于概念。 | `workflow_detail.html`和`runs.html`有真实业务任务状态/事件/依赖与health tree；desktop-11宿主另有QueueDock、ContextMeter、StatsPills与TurnUsagePanel源码（路径/行号见C/E）。Window9836564已实看workflow `a0618507…`任务、selected/完成态、79%缩放及Inspector随整体大小变化；未执行任务或review。S120当前窗口为真实31条/场景6/助手8/其他17。QueueDock显隐/锚点与完成态队列GUI未验。 |
| 响应式与窗口 | 多列布局逐渐收缩；窄窗切换当前pane的可读入口；窄屏输入仍可用；恢复宽度比例/滚动不跳变。原报告建议最小pane约280px、手机简化成审核/报告而非多栏桌面。 | 父GUI：866×823切换当前pane与聊天输入可用；1260px恢复两列比例。手机尺寸、各panel最小宽、缩放/DPI其他状态未验。 |
| 键盘与减少动画 | Tab顺序、Esc关闭展开/浮层、focus-visible；动效只用于状态/载入转场，并支持reduced motion。参考文字仅建议，视频无验证。 | 未见本轮全面键盘/reduced-motion验收；列为待验视觉/无障碍细项。 |

## 明确边界与当前剩余优先项

**本尾段当前状态以文档顶部“当前交接摘要（desktop-13）”为准。** 下方desktop-12/desktop-11等窗口记录保留为各自发生时的历史证据，不能覆盖desktop-13的双coldboot预览与浮停结果，也不能把局部通过扩大成全项完成。

1. **当前部署与运行时**：desktop-13 source/runtime/profile hash为`c7c1164f9fd8742ca4714e177806e26c9546d8249478a61b815a2d5537140b94`；DataRoot、role bindings、PG保持，Host/Django窗口与checkpoint见顶部及handoff。桌面端CSRF/DND探针尚随旧runtime存在；源码已清理route11/files14和探针，下一步干净同步。
2. **当前GUI已验范围**：desktop-13 Window27789548与Window16187696两次coldboot均对同一登记工作簿验到608非空单元格、Sheet1与I13且无403；preview左浮约56%宽/94%高、右侧files/chat可见，停靠恢复原pane顺序及近似比例。light主题未验，不能概括为全UI完成。
3. **当前待验项**：附件已由用户手动恢复并经父在Window16187696只读UIA确认，仍是内存待发送草稿；本轮未发送。当前工作台不要刷新或重启，以免再次清除草稿。原生文件选择器未弹出、Sky.drag未完成drop不影响这次手动拖放确认。CSRF结果仅覆盖同一工作簿preview的两次coldboot，不泛化至所有来源/端点；runtime旧探针需干净同步移除。
4. **既有GUI证据保留**：desktop-11/12的S010缩略、整体大小同步、workflow graph状态/79% zoom、S120 31条分组等仍是对应窗口时的有效局部证据；本轮没有据bundle变动抹除它们，也未重复验。它们不是desktop-13新GUI证据，具体窗口/范围见相应历史条目。
5. **持续边界**：双chat输入/历史局部隔离已验，但完整模型、工具与context隔离仍未证明；父曾观察中心模型选择使空商品pane跟随全局默认。QueueDock显示/锚点尚未全验；没有真实API的任意目录浏览、SSH、股票/实验数据、虚构ERP/报工或任意workflow CRUD不纳入。
6. **其他测试边界**：自动化、DOM/Playwright fixture及静态截图只证明各自覆盖范围，不替代Electron逐项GUI；逐张图像复核不等于连续视频逐帧全审或所有功能已验。
