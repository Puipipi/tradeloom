# O06/O07 WebAI 文件模块（后端模块交付）

此前的模块交付把四个 WebAI 文件模块纳入当前 `@tradeloom/dsh-business-shell` 源码。模块原先已在 `package.json` 的 `exports` 与 `files` 中列出，但文件本身不在此 worktree，导致子路径不可导入；那一批没有改 `package.json`，四个自引用子路径现可导入。本轮另将既有 split Host transport/auth/wire 模块纳入正常包，并为三个子路径补了 `exports` 和 `files`。

主源文件来自 `C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell/`，来源和副本 SHA-256 见[来源清单](../../recovery-20261029/o06-o07-webai-modules-20261031/SOURCE-SHA256.json)。当前代码保持主源字节：

- `createWebAiFileTools({ fs, ... })`：签发短时能力，限定授权根、provider/window/conversation、当前任务、请求缓存和文件上限；`write_new` 只创建，不覆盖现有文件。
- `createLocalDirectoryLister(fs, LocalFileSystem)`：只接受 SDK `LocalFileSystem` 实例，列举有界目录项并标明 symlink，不跟随链接读取内容。
- `createWebAiToolEnvelope({ fileTools })`：只处理可信原生观察到的完整 assistant 消息；校验 task/request 绑定、exact keys 和重放，不从用户消息、旧消息或部分流取指令。
- `createWebAiRuntimeFiles(ctx, sdk, options)`：把一次有效 ToolRuntime 调用绑定到 SDK 文件工具；默认 `enableFullRead=false`、`enableStandardWrite=false`。启用标准写时 Host 应按 SDK 组合顺序先装本模块返回的 `FileSystem`，再加载真实 `tool-fs` 插件；本模块将 WebAI 写入限制为 create-if-absent。完整读取须显式启用并仍受 grant 与工具策略约束。

示意调用（不是 Host 接线实现）：

```js
const runtimeFiles = createWebAiRuntimeFiles(ctx, sdkModules, {
  enableFullRead: false,
  enableStandardWrite: false,
})
// Host 必须从真实用户选择和当前会话状态取得 root / isCurrent / denied tools。
const grant = await runtimeFiles.bind({ exec, root, getRoot, isCurrent, getDeniedTools })
const result = await runtimeFiles.execute(grant, {
  requestId: 'opaque-request-id', op: 'list', path: '.',
})
```

Host/WebContents 的真实用户目录选择、生产 target registry/policy producer、当前会话到页面目标的绑定、网站 DOM/登录状态和前端文件面板仍未实现或接入。本轮虽纳入 Host transport 与 SDK caller authorization adapter，但没有把它挂入生产 Host，也未配置真实 target policy 或向真实网站发起请求。因此 O06 的网页提问/完整回答验收仍未完成；O07 仅完成可复用后端文件能力的包内交付，尚未证明真实用户选择目录到网页模型的完整闭环。

## Native Host transport 与授权适配模块

本轮从 `candidates/webai-native-bridge/split/` 迁入三个独立模块：`webai-native-host.js`（`createHostWebAiTransport`）、`webai-native-authorization.js`（`createNativeWebAiAuthorization`、`mountOptionalWebAiHost`）和 `webai-native-wire.js`（固定 `/api/tradeloom.webai-native` 路由、私有 bridge header 与严格 DTO 校验）。来源字节及正常包副本 SHA-256 见[本轮来源清单](../../recovery-20261029/o06-webai-native-host-modules-20261031/SOURCE-SHA256.json)。模块仅将相邻文件扩展名 import 改为正常包文件名；候选原件未改。

这些接口允许后续可信 Host 组合显式提供 bridge key、真实 native caller policy 与传输依赖。工具仅列出明确授权目标，并在每次 ask 时重新授权；`withFiles` 仍在原生授权适配器中 fail closed。本次没有把 O07 文件 grant 自动接入问答，也没有将 target policy、key 或 grant 变成模型参数。

### 本轮验证与边界

- 候选 split 行为基线：12/12、0 skip、exit 0，使用当前正常包已有的四个文件能力模块；原始输出位于本轮 recovery 目录。候选 native SDK 测试首次使用错误的 SDK 根路径，exit 1 且未进入测试用例；该记录保留，不计为基线通过。
- 正常包 split/Main 协议定向测试：13/13、0 skip、exit 0，包含三个 package self-import 与 `package.json` `files` 声明检查。Main 仍从 `candidates/webai-native-bridge/split/main.mjs` 导入，仅用于 split 协议测试，不属于正常包模块或产品接线。
- 正常包 native authorization 的 rep12 SDK 测试：最终 5/5、0 skip、exit 0。除身份、策略和 `withFiles` 拒绝用例外，新增正向 ask 通过真实 SDK ToolRuntime/AgentLoop 调用授权工具，经 Host transport 到 candidate Main adapter，再校验返回完整回答、requestId 关联、恰好一次 adapter dispatch 与 Host job settle。目标清单、授权 policy、bridge key、工作区及 Main 页面/adapter 均为测试 fixture，不调用外部模型。
- 这些测试证明包内模块行为和真实 SDK 执行上下文的授权适配，不证明生产 Host 安装/调用该 adapter。Main target registry/真实网页 DOM producer、Host bootstrap 挂载、实际网站、GUI 与用户授权目录仍未验；O06/O07整体不标完成。

原始命令、stdout/stderr 与退出码见[本轮验证记录](../../recovery-20261029/o06-webai-native-host-modules-20261031/VALIDATION.md)。

## 验证边界

- 主源两份既有测试在迁入前的 baseline：19/19，0 skip，退出码 0。
- 当前正常包定向测试：`webai-file-tools.test.js`、`webai-tool-envelope.test.js`、`webai-runtime-files-sdk.test.js` 共 21/21，0 skip，退出码 0。新运行时测试使用 rep12 实际 Cordis `Context`、`ToolRuntime`、`LocalFileSystem`、`SandboxedFileSystem` 与 `tool-fs`；本地文件和 agent 为受控 fixture，模型调用数为 0。
- 测试证明本地 SDK 工具执行、grant 绑定/失效、默认禁读、显式启用读取、列表策略拒绝和不可覆盖写入。task `isCurrent`、根目录选择与 denied-tools 的生产来源仍由 fixture 提供。
- 这不是生产 Host/安装包、网页 DOM、登录站点、GUI 或实际用户目录验收；不代表 O06/O07 整项完成。

原始命令、stdout/stderr、退出码和 owned 测试目录位于[验证记录](../../recovery-20261029/o06-o07-webai-modules-20261031/VALIDATION.md)。
