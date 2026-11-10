# O08：真实 SDK 交付物声明生产链

## 验收结果

运行 `node testing/o08_sdk_deliverable_acceptance.mjs`。runner 调用既有真实 SDK 工作流场景，并在外层检查 SDK 工具收据、child 生命周期、run/node 状态和声明证据。

本次由真实 SDK `AgentLoop`/`ToolRuntime` 启动子代理；在 SDK 串行 `agent/created` hook 中，把 rep4 官方 `dsh-tool-fs` 与 `dsh-tool-present` 插件挂到真实 child context。确定性本地 ScriptAdapter 驱动官方 `write` 将 `catalog.md` 写入本次临时 workspace，再调用官方 `present`。测试通过 SDK session query 读回 child 的 `deliverables/presented` 事件，核对其 turn、callId、seq、文件路径及描述，并用真实临时文件内容比对。原 executor 将该证据投影为 `artifactState: declared`；child 和 run 均以一次 attempt 完成。

## 边界

工具收据、SDK child/session 事件、文件写入和工作流声明链为真实 rep4 SDK/项目实现。LLM 输出为本地确定性 ScriptAdapter；role、workspace、connection/settings 为隔离测试配置。这里验证的是 producer 与 journal，不调用 native artifact 注册或上传，不计算哈希，也不证明产物已被复制或托管。未验证生产 Host 挂载、Electron/GUI、网页、外部模型或真实用户 workspace；O08 整体仍需单独验收。
