# 2026-10-22 Agent intake runtime follow-up

## 结论

只读真实资料读取与来源回溯在第二次本地 full probe 中通过：中心与交付角色分别读取来源目录和同一生产候选详情；两者的来源摘要及坐标一致，候选状态保持 `unconfirmed`。产品角色目录中没有生产候选，显式读取生产详情被 `role_not_authorized` 拒绝，且没有发出详情 HTTP 请求。Django 启动时确认 `default_transaction_read_only=on`。这证明本次已有数据路径的只读读取和来源回溯，以及被测角色边界；不代表付费模型、多 Agent 委派、UI 或移动端验收。

## 分阶段证据

- **官方协议 fixture（4 个 case）**：新 Host SSE 与冻结旧探针 SSE 生成器分别返回 source 工具调用，均以 `tool-calls` 正常结束。空工具列表下，旧 helper 仍返回工具调用并以 `tool-calls` 结束；普通文本回应则以 `stop` 结束。四个 case 均通过。这说明空工具上下文时 mock 仍可发出工具调用，但该 fixture 本身没有复现 `INVALID_REQUEST`。
- **隔离 loopback Host，新 mock**：Host 就绪并观察到 source 工具调用，但该实验没有启动 Django；authority 因隔离地址不满足既有配置边界，在业务 HTTP 请求前拒绝。因此它只验证了运行时调度，不是业务集成验收。
- **隔离 Host，完整旧 dispatcher**：首个 provider 请求包含 19 个工具，其中包括 `tradeloom_intake_sources` 且根 schema 为 object，但没有旧 mock 所需角色标记。冻结 dispatcher 按原逻辑返回空正文 HTTP 400；Host 的 `assistant/attempt` 与 `turn/end` 报告 `INVALID_REQUEST`，必要错误文字为 `400 status code (no body)`。这精确复现了该旧 mock 拒绝路径。
- **第一次只读 full probe**：三角色的 LLM turn 均正常结束且发出工具调用，但 source-list 路由均返回 HTTP 400，未获得来源或候选。该版探针没有传入 DSH embed 主机 allowlist 配置。源码显示，未启用 embed 时 Django 默认只允许 loopback Host；业务工具请求使用已选定的局域网 Host，形成配置不匹配的具体假设。第一次报告只保存状态码，没有响应正文或异常详情，故不能据此确认唯一根因。
- **第二次只读 full probe**：仅在新探针的 Django 子进程配置中加入显式主机 allowlist 和对应工作台 Origin 的 trusted-origin 配置，并输出有效配置的布尔值。Host 与 Django 就绪，数据库只读检查为真；中心和交付角色的 source-list、候选目录、候选详情均返回 HTTP 200，各自发现同一候选并验证来源 SHA 与坐标一致。产品角色只列出 `product_identity`，生产候选可见数为 0；显式生产详情调用返回 `role_not_authorized`，没有相应详情 HTTP 请求。全程没有 INVALID_REQUEST，工具缺失列表为空，脚本退出码为 0。

## 历史与限制

早期六次旧探针运行的安全报告仍保留，旧 manifest 未修改；这些报告没有记录每次完整 provider 请求，因此不能断言它们都与本次完整旧 dispatcher 的 400 逐项相同。本轮协议预备阶段三次失败的原始日志曾被覆盖，`preliminary-run-history.json` 按原生命令历史重建其命令、退出码与事件标识；它不是原始日志。第一次 full probe 的响应正文和具体 Django 错误也未保留。第二次结果验证的是本地现有资料、只读 Django 和本次三角色探针路径，不是付费模型行为、跨角色委派、UI 或移动端验收；也没有修改正式 Django settings、业务 API、模型权限或旧冻结报告。

## 本机证据

私有日志和安全摘要位于 `workspace/testing/llm-error-diagnosis-20261022/`，仅保留在本机。私有 full-probe 安全报告含核验所需的 candidate/source ID、来源摘要 SHA 和坐标，但不含来源正文、原始模型请求、HTTP 头、cookie 或认证值；隔离 profile 自动持久化的 session JSONL 可能含会话正文与工具结果，作为私有证据留在本机，不上传。本文是公开摘要，不包含真实 candidate/source ID 或业务文件 SHA。应用恢复证据也保存在本机；进程与 HTTP 恢复不代表已完成视觉界面验收。
