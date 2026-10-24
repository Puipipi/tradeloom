# UI 参考静态对照（2026-10-24）

## 审计范围

对照版本：`tradeloom`，分支 `codex/ui-native-acceptance`，HEAD `c619ed20afe26db85e94e632aadba0dad1922b84`。主控逐张核读了六张主截图、补充帧和图册预览；这不是对 135 张截图或原视频的全量复核，也不是对当前运行软件的检查。观察记录见仓库外 [`reference-index.md`](../../../workspace/research/video-ui-reference-20261023/reference-index.md)；本记录不复制截图或私人画面内容。

## 观察与源码对应

| 参考图 | 可见结构（仅静帧） | 当前源码对应 |
|---|---|---|
| [S001（V01，01m50s250）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V01/S001_V01_01m50s250_顶栏与场景页签.png)；[补充 frame-14](../../../workspace/research/video-ui-reference-20261023/supplementary-20261022-14-frames/images/frame-14.png) | S001 展示品牌/全局工具行与场景导航两层；补充帧显示品牌后模型图标、下一行选中场景带文字而其余场景为图标。 | [client.js](../../packages/tradeloom-shell/client.js#L167) 已按两行组织顶栏；导航高度 38px、横向溢出可滚动（390–407）。[client.scenes.js](../../packages/tradeloom-shell/client.scenes.js#L723) 已有未选中标签收起文字、hover/focus/current 展开文字的样式（723–737）。故两行导航和紧凑标签已有实现，仍需渲染检查总高度、与原生标题栏叠加效果及窄容器交互。 |
| [S076（V04，03m16s250）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V04/S076_V04_03m16s250_工具节点下拉菜单.png) | 工作流工具节点选择菜单；静帧可见纵向菜单和滚动条，不据此推断实际滚动动作。 | 当前仅有全局工作台工具弹层（[client.js](../../packages/tradeloom-shell/client.js#L407) 及 415–423），语义与工具节点选择器不同。只对照弹层边距、边界和滚动表现，不声称节点工具库已实现，也不新增该功能。 |
| [S029（V02，00m33s750）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V02/S029_V02_00m33s750_文档_目录_双会话四分区.png) | 文档预览占左上主宽、目录在右上较窄；下方并列两会话，分区不等宽。 | 默认四面板布局采用上下 60/40、上排 75/25、下排 50/50（[dock-layout.js](../../packages/tradeloom-shell/dock-layout.js#L63)）。对照重点是实渲染分隔比例、内容最小尺寸及窄尺寸下的布局保护。 |
| [S088（V05，00m12s750）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V05/S088_V05_00m12s750_图表与指标面板组合.png) | 左侧窄指标列，上方中/右内容，下方聊天跨中右；不是等分四格。 | 四面板默认比例见 [dock-layout.js](../../packages/tradeloom-shell/dock-layout.js#L63)。检查特定场景布局映射及卡片留白、独立滚动；不从参考帧推出源码已裁切。 |
| [S092（V05，00m55s250）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V05/S092_V05_00m55s250_主会话与助手导航.png) | 原生侧栏仍可见新会话、插件、自动化、工作区和历史导航。 | 此图作为保留原侧栏的对照项；本记录未据单张截图推断当前运行态是否完整。 |
| [S014（V01，00m29s250）](../../../workspace/research/video-ui-reference-20261023/extracted/DSH_Workbench_UI_Reference/01_实机截图/V01/S014_V01_00m29s250_移动端浅色会话.png) | 浅色窄屏会话示例，左侧窄图标 rail 与输入区可见。 | 仅作窄屏会话参考，不作为顶部 scene 导航规格，也不证明真实手机兼容性。 |

场景配置分别声明 `960×560`、`1000×360`、`1143×360` 等最低画布尺寸（[scenes.json](../../packages/tradeloom-shell/scenes.json#L14)、28、70）；运行时根据实际 host 宽高计算 narrow（[client.scenes.js](../../packages/tradeloom-shell/client.scenes.js#L1389)）。这些阈值不等于浏览器窗口断点或已验证的裁切结果。

另有仓库外 release 参考 `../workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-8/packages/client/ui-layout/src/client/columns.ts`：侧栏默认 280px、范围 264–420px、折叠 56px、自动折叠宽度 1024px；右栏最小 300px、中栏保护宽度 400px。它只说明该 release 源码的列行为；本仓库对应的是 `integrations/dsh/patches/ui-layout-shell-top.patch`，不能把 release 源码当成本仓库交付或已应用的补丁。

## 待做渲染检查

1. **顶栏与导航：**量测两行总高及原生标题栏叠加；检查横向溢出、选中/hover/focus 标签展开和窄容器下的可达性。
2. **不等比分区与布局保护：**核对场景面板映射、实际分隔比例、最小可用尺寸、卡片留白与各面板独立滚动。
3. **容器响应与滚动：**分别在不同 host 宽高下验证各场景阈值、窄态提示/布局行为及菜单/面板滚动，不将宽高门槛误当窗口断点。

本记录是静态源码与指定截图的对照；未运行应用或测试，未声称动画、点击行为或实机效果已验证。
