# Phase 6 Task 21：离线 AgentArts Runtime 封套

## 官方调用契约

本批复核时间为 2026-10-19；华为云 `InvokeRuntime` 页面标记的更新时间为 2026-10-16。契约为低代码 Runtime `POST /runtimes/{runtime_name}/invocations`；请求使用 `Authorization`、`X-Invoke-Mode`（`debug`/`published`，默认 published）和 `x-hw-agentarts-session-id`；session/runtime 名称限字母、数字、`_`、`-` 且不超过 64 字符。单/多 Agent 使用非空字符串 `query`；Workflow 使用 `inputs` 对象，其键由开始节点变量定义。Workflow 可选 `plugin_configs` 为对象数组，条目含可选字符串 `plugin_id` 和 `Map<String,String>` 的 `config`。JSON 成功响应为 `event`、`data`、毫秒级整数 `createdTime`，示例中 `data.text` 为 null。本地映射器要求 `data.text` 键存在并接受字符串或 null，这是本地支持边界，不表示官方字段必填。401/404/500 状态映射由本地离线测试覆盖，不是账号端实测。

来源：[InvokeRuntime API](https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html)（官方 API 文档，2026-10-16 复核）。流式 SSE、文件上传、AK/SK 签名、账号调用和部署均不在本地验收范围。

## SDK 适配判断

华为云官方 [`agentarts-sdk-python`](https://github.com/huaweicloud/agentarts-sdk-python) 在本次查阅时 `main` 指向 commit `0d620ccdf5a30e8ef2d556137a9c93cde4d18e78`。按此 commit 只读保存 README、`pyproject.toml`、Apache-2.0 LICENSE、`src/agentarts/sdk/runtime/app.py` 与 `src/agentarts/sdk/service/runtime_client.py`，文件位于项目外 `workspace/research/references/agentarts-sdk-python-0d620cc/`；未安装 SDK、未运行下载脚本。

README 与源码显示该官方 SDK 覆盖自建 Agent 的高代码开发、HTTP server、CLI 部署及云服务客户端；`AgentArtsRuntimeApp` 提供本地 Agent server，而 `RuntimeClient.invoke_agent` 也构造 `/runtimes/{agent_name}/invocations` 并实现真实 HTTP 传输、Bearer/session、鉴权签名和 JSON/SSE 分发。它可作为未来 transport/认证实现的复用候选。本批需求只包含无 I/O 的低代码 payload 校验与有限 JSON 响应映射，因此不引入 SDK 依赖，也不重写其 HTTP、签名、流式或部署实现。

## 本地实现边界与证据

`workbench/agents/agentarts.py` 只构造 POST 请求描述并映射有限 JSON 响应；没有默认 transport、账号凭据读取、日志写入、重试或持久化。`Authorization` 只原样携带调用方提供的值（API Key/OAuth 等方式的具体值仍待账号验证）；不生成 IAM/AK/SK 签名，也不添加 IAM 所需的 `X-Sdk-Content-Sha256: UNSIGNED-PAYLOAD` 条件头。适配器 repr 与固定错误不包含 Authorization。健康状态始终是 `agentarts=not_configured`、`evidence=documented_not_connected`。API health 保留旧字段并增加 `agentarts_status`。

项目外 `workspace/testing/phase6-offline-adapter/` 保存编辑前存在状态/SHA-256 清单、编辑后副本及逐文件 live-hash 比较、canonical manifest 和测试日志。使用项目外运行环境执行专用 workbench 测试；未启动正式服务，未使用真实账号、远端 API、付费服务或浏览器。API 层通过 `RequestFactory` 与本地诊断 stub 的单测只验证 view JSON，不是正式 HTTP/正式实例验收。正式 `--noreload` 服务未重启，仍加载旧进程代码。
