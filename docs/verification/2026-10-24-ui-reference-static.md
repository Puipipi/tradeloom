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

## UI 候选增量核对（2026-10-24）

- **键盘分栏：**候选在 Dockview sash 上增加焦点与 separator 语义；只用公开 `groups`、`adjacentGroupInDirection`、`boundingBox` 和 `group.api.setSize`。真实 pinned Dockview 集成测试使用确定性几何夹具，检查箭头键调整 split、走既有布局保存/校验路径、无可靠邻组时不拦截按键，以及卸载恢复原 ARIA 属性。此证据不是实际 Electron 键鼠验收。
- **原生会话标题：**release 0.2.1-rc.2 的 `ConversationRoot.module.css` 原始 header 最小高度 76px、标题区上内边距 10px、无 tabs 时仍约 50px；标题/crumb 为 14px、tabs 为 13px。候选仅作用于 `.tl-native-conversation` 下公开 `data-slot`、`data-conversation-header-leading`、`data-conversation-tabs` 锚点，保留原生 header、actions、lineage、utilities、corner 和 tabs；单行标题最小高度 34px，tabs 出现时允许自然扩展。真实 Dockview DOM 集成测试以稳定原生 DOM 结构夹具验证应用样式、token 映射及控件仍在；没有挂载 DSH release 的真实会话窗口，也未量测 Electron 盒模型。
- **颜色与字体：**原生会话区域的 DSW alias 在 wrapper 范围映射到现有 `--tl-theme-*` palette；标题使用 `--tl-font-body`，tabs 使用 `--tl-font-compact`。浏览器对原生字体的最终渲染和参考图精确字号仍未实测，不据 source 值声称匹配参考图。
- **主题缺失 alias 回归：**真实 `client.js` theme bridge 用例曾捕获 RED：空 alias 被隐藏 swatch 的继承文字色误读为有效背景（实值 `#dfe7f3`，预期中央 dark canvas `#0c1017`）；修正为缺失 alias 直接中央 fallback 后，该定向用例 GREEN（1/1）。
- **脚本缓存：**`base.html` app.js 查询版本现为 `native-theme-palette-ui1`，与当前 19 色主题和 UI token bridge 对齐；README 说明了静态服务/CDN 缓存头仍需按实际部署核验。本轮未请求实际页面或检查浏览器缓存响应。
- **默认场景：**`scenes.json` 的 profile 经 `dock-layout.js` 生成每 scene 推荐布局：center 为水平业务32/chat68，协作 scene 为上下60/40、上排75/25、下排50/50，business-lead scene 为水平业务72/chat28。profile 只选择默认生成路径，服务端每 scene 存档优先恢复；本轮未改默认或已保存布局。S088 的左侧指标+下方跨中右聊天布局与当前通用协作模板并非同一映射，不将该静帧强套到所有场景。
- **模型标记：**顶部模型目录不是品牌图标：`client.scenes.js` 的 `providerBadgeLabel` 按 provider 名取大写首个 ASCII 字母/数字，非拉丁名取首个字符，空名回退“模”。该映射不读取 provider logo/icon 字段；检查的 pinned `ui-model-selection` 包也未发现可复用的 provider logo/icon 组件。故目前是自定义文字 fallback，不声称复刻参考图的品牌图标。

本节定向集成检查通过 1/1；测试输出仍含 React `act(...)` 警告。前轮 64 格 HTML/CSS fixture 矩阵没有在本轮重跑。键盘、native header 的新增样式与交互未在实际 GUI 验收；原生独立参考字号和页面实时缓存行为仍待实机核验。

### 导航与原生发送按钮窄核验（2026-10-24）

- 用 pinned Playwright Core 1.61.1 + 本机 Chrome headless，直接提取候选 `client.js` / `client.scenes.js` 两个 style 模板，并在 700px、230px viewport 渲染多 scene 导航。700px 下 nav `offsetHeight/clientHeight=29/28px`、`scrollWidth/clientWidth=700/700px`；230px 下为 `29/28px`、`406/230px`，聚焦末尾 scene 后 `scrollLeft=176px`。两种宽度滚动条均未占高度（0px），按钮随 focus 可见。导航按钮 rect 为 y=31–57，nav 为 y=30–59，工具按钮 28×28px；修正后 scene tab 的 focus outline offset 为 -2px，边框在 nav 内。此验证确认原导航横滚不裁高度，唯一发现的 focus ring 裁切已在自有按钮规则中收紧；未另加 box reset 或滚动条规则。
- pinned DSH `InputBar.module.css` 的 `.primary:hover:not(:disabled)` 使用 `--dsw-alias-button-info-hover`，按钮白色箭头由源码明确指定。wrapper 将 hover alias 指向同一 palette 的 `accentStrong`；当前 resolver 的实际颜色为浅色 `#356fc4`、深色 `#4d83dd`。headless CSS 实渲染得到白色图标对比度分别 4.97:1 与 3.75:1，均高于图形 3:1 门槛；这不是独立 DSH 窗口实测。
- 定向套件命令：从 repo root 以 release 8 的 React 18.3.1、ReactDOM 18.3.1、jsdom 30.1.3 设置 `TRADELOOM_REACT_LIBRARY`、`TRADELOOM_REACT_SERVER_LIBRARY`、`TRADELOOM_DOM_MODULE` 后，运行 `node --test packages/tradeloom-shell/tests/shell.test.js packages/tradeloom-shell/tests/scenes.test.js packages/tradeloom-shell/tests/theme-bridge-dom.test.js packages/tradeloom-shell/tests/dockview-integration.test.js packages/tradeloom-shell/tests/dockview-pointer-dnd.test.js packages/tradeloom-shell/tests/intake-ui.test.js`。结果 95 tests：90 pass、0 fail、5 skip；stdout 有 32 条 React `act(...)` 警告。跳过项依次需要真实 Cordis context、composer slot anchor、完整 pinned Cordis Loader contract、compiled DSH tools library、pinned DSH source + app-boot/include libraries；不代表这些集成已验证。命令退出码 0。
- 候选源码 SHA-256：`client.js` 为 `92A87FE6DAA8140BF744268B42D88CB6ED5CDBE84A40AB7672650F47AD4F294C`；`client.scenes.js` 为 `4F9D348F8AA75AFD0F38343461542F72A7DFE0790931D605C4AF570A77230D29`。此候选仍未提交、未同步、未部署；GUI 与真实 Electron 仍待主控验收。未实测独立参考精确字体，也不据 headless fixture 声称真实 DSH/Electron 窗口已通过。
