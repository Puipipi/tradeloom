# 按角色配置 MCP、Skill 与工具权限

## 目标

在现有助手能力面板中，为每个 TradeLoom 角色编辑其 preset 下的 MCP server、Skill 搜索根目录和工具拒绝名单；保存后由 DSH 官方 ConfigEditor 校验、持久化并经 Loader reconciliation 应用。用户可明确创建一个使用新配置的新助手对话，原对话及历史保留。

## 当前行为与边界

roles.js 将封闭角色标识映射到固定 preset。capabilities.js 和 client.js 当前只提供能力快照查看。DSH 的 agentPresets.read 只读，不能用于写配置。

Host profile 已随 base bundle 提供 configEditor 服务。configEditor.entries() 返回唯一可寻址的 profile-root Include entries；适配器只允许目标 entry 是 @deepseek-ai/dsh-agent-preset、其 config.id 精确等于 ROLE_PRESETS[role] 且 fiber 状态为官方 FiberState.ACTIVE。configEditor.edit(entry, change) 在 profile 锁内校验完整配置、原子更新 profile cordis.patch.yml、执行 Loader reconciliation，并在失败时恢复旧配置。应用写入只作用于当前专属 DSH profile，不改产品包 bundle 文件、其它 preset、Home/CLI overlays 或全局 plugin composition。

Loader 更新 preset definition 后，已有 Agent 继续持有原 generation，新建 Agent 读取新 definition。因此保存成功表示“默认配置已保存并应用给新 Agent”；现有 started Agent 的实际能力快照仍以其当前 scope 为准，UI 必须并列显示两种状态。不能把 profile 应用描述成对历史会话热更新。

TradeLoom 当前每个角色只保留一个绑定 Session。用户明确选择“用已保存配置新建对话”时，Host 创建同角色、同 preset 的新 Session，并把该角色绑定切换到新 Session；不关闭、删除、改写或复用旧 Session。旧 Session 仍保有原 ID、generation 和历史，继续可从原生会话历史打开。

新建会话请求必须同时带上 `expectedSessionId`（当前角色绑定的 session id；未绑定时为 `null`）和客户端生成的 `operationId`（UUID）。Host 先校验 owned home，再按 owned-home 与 operationId 隔离请求；持久化 operation intent 后检查当前绑定仍等于 `expectedSessionId`，并在调用官方创建器前记下 create attempt。稳定目标 ID 由该 UUID 派生。同一 operation 的重试先通过只读 `sessionQuery.observeSession()` 核对目标 ID、cwd、preset、官方空白会话谓词、目标 workspace membership 及未归档状态。空白谓词使用官方 `turnBoundary`：其值为 `undefined`，或 `openTurnStartSeq === null && lastTurn === 0`；初始化、context 或 preset 选择事件不妨碍判为空白，已开始的 turn 则不通过。核对完全匹配才可恢复绑定，已尝试但暂时不存在、查询失败、或任何属性不符均保持 pending/outcome-unknown，绝不再次调用 create。Host 不依赖 UUID 本身或进程内 single-flight 冒充跨重启幂等。只有首次、尚未标记为 attempted 的 operation 才调用一次官方创建器。并发的新建请求在更新绑定时再次校验 expectedSessionId；只有一个请求能从该绑定前进，失败方不得覆盖新绑定。旧 session id 永远不变，只有角色 binding 可以切换到新 id。

## 写入归属与安全边界

配置写 API 只有在当前 DSH_HOME 通过现有 `.tradeloom-owned` marker 校验、`profileContext` 指向此 owned home 下的专属 active profile、且 profile patch 路径与该 profile 一致时才可用。适配器不得写入个人 DSH home、home overlay 或全局配置。缺少 ConfigEditor 时，GET 返回固定 `configuration-unavailable`，PUT 同样拒绝且不写入；禁止退回手写 YAML 或直接改 profile patch。

工具拒绝插件只能在 Agent preset scope 中生效。激活时必须确认 `scopeOf(ctx) !== undefined`；若插件误挂到 Host/global scope，立即拒绝激活，不注册全局 guard。guard 按 `ToolExecution.name` 精确拒绝，随该 preset generation dispose；只增加拒绝，不影响别的 Agent 或放宽已有规则。

## 角色级配置模型

权威数据存于目标 preset entry 的 config.plugins：

- @deepseek-ai/dsh-mcp-client：每个 MCP server 一行，使用受控稳定 entry id；支持官方 stdio 与 streamable-http 字段。stdio 接收 command、args、cwd；HTTP 接收 URL；两者可设超时及启动失败策略。保存时只更新本项目拥有的 server rows。
- @deepseek-ai/dsh-skill-filesystem：每个 role 至多一行，使用官方 includeDefaultRoots 和 customSkillDirs 配置。默认继承保留；新增根目录只能指向 TradeLoom 专属工作目录下的真实目录。不能把 dshHome 或 agentsHome 改指向全局用户 DSH/Agents 目录。每个角色使用稳定唯一的 providerName `tradeloom-<role>-skills`，避免默认 `filesystem` 名称遮蔽继承 provider。该配置只表示此 preset provider 追加的技能搜索来源；Host/global Skill provider 仍按 DSH 规则继承，不能宣称其被隔离或隐藏。
- @tradeloom/dsh-business-shell/tool-policy：在每个角色 preset scope 中登记一个 guard，以 ToolExecution.name 对拒绝名单做精确匹配。拒绝名单中的调用返回固定拒绝原因；删除一项只恢复上游原有策略允许的调用，不能绕过任何现有 guard、TOOL_ACCESS 或权限边界。禁止用没有运行时执行边界的 UI 勾选来表示工具已禁用。

只有本项目明确标记的 child rows 属于管理范围。保存时完整保留 preset 的其它顶层字段、所有非本项目管理的 plugin rows、其它 role preset、全局插件和配置层。旧 profile 若无 policy row，保存时补上空默认 policy row；首次安装的默认 preset 也声明相同行为，空名单不改变现有权限。ConfigEditor 保存会执行 Loader reconciliation；preset 的 MCP child 可能在保存时连接或启动。保存前 UI 必须说明该副作用；自动化只使用本地 synthetic MCP，绝不运行用户配置的命令。

MCP 每条 server row 的 serverName 必须符合官方 [A-Za-z0-9_-]{1,32} 规则，并在同一 preset scope 内唯一。HTTP URL 与 stdio command/args/cwd 按官方 schema 校验，界面不提交任意 YAML、Loader JS tag 或表达式对象。

## 密钥引用

MCP plugin 的 env 和 HTTP headers 接收普通字符串，官方 README 支持 Loader 环境变量表达式。本功能仅允许 {envName, scheme} 引用，环境名匹配 ^[A-Z_][A-Z0-9_]*$，scheme 只能是 raw 或 bearer。Host 从该封闭对象构造固定的环境变量表达式（raw 为 process.env[JSON.stringify(envName)]，bearer 为固定 Bearer 前缀模板）；绝不接受客户端提供的表达式或秘密正文。写入前确认引用变量存在，但响应只给环境名与可用/缺失状态，不读取或返回变量值。

GET 只反向解析本功能生成的精确表达式。env/header 返回引用名、scheme 与“变量是否存在”，不回传其 Loader 求值后的值；managed MCP/Skill/policy row 若出现未知字段、未知表达式、非 primitive 配置值或 disabled 标记，只投影安全状态并使整份 managed 配置只读，PUT 返回冲突，避免丢弃未知配置。非本功能管理的 MCP row 保持原样且不投影其配置；Host 只在内存中检查其 `serverName`，拒绝与新 managed server 重名，不向响应或日志回显该 row 的字段。GET 投影的 command/args/cwd 是用户提交的普通配置文本，不承诺其中不含用户自己写入的敏感字串；HTTP URL 必须拒绝用户名/密码，header/env 值则只允许 env 引用。文件型密钥引用本次不支持，因为 MCP client 没有文件引用解析器。

## Host API

新增同源、经过 ctx.connection.requestRejection(req) 的资源：

- GET /tradeloom/agent-configuration?role=<role>：成功响应严格为 `{role,preset,revision,editable,mcpServers,skill,deniedTools}`。`mcpServers` 只投影本功能管理的 rows；未知或不安全的 managed row 只返回安全状态，不回显表达式或任意字段，并令 `editable:false`。非本功能管理的 MCP row 不投影、不修改；写入时仅在内存检查 serverName 冲突。env/headers 只返回 `{envName,scheme,present}` 引用，不回显 Loader 求值后的值。command/args/cwd 等用户配置文本按严格字段形状投影，不声称其中不含用户自行写入的敏感字串。缺少 owned profile 或 ConfigEditor 时返回 `{error:'configuration-unavailable'}`，绝不回退直接写文件。
- PUT /tradeloom/agent-configuration?role=<role>：唯一接受 `{expectedRevision,mcpServers,skill,deniedTools}`。每个 stdio server 形状为 `{id,transport:'stdio',serverName,command,args,cwd,toolCallTimeoutMs,failOnStartupError,env}`；每个 HTTP server 形状为 `{id,transport:'streamable-http',serverName,url,headers,toolCallTimeoutMs,failOnStartupError}`。`env` 与 `headers` 的每个值必须是 `{envName,scheme:'raw'|'bearer'}`，不能提交普通值或 JS/YAML。HTTP URL 拒绝用户名和密码。`skill` 形状为 `{includeDefaultRoots,customSkillDirs}`；目录为角色工作目录下的相对路径，Host 写入固定 `providerName:'tradeloom-<role>-skills'`。成功响应为 `{role,preset,revision,appliedForNewAgents:true,currentSessionUnchanged:true}`。
- GET 的 `400 unknown-role`、`403 profile-not-owned`、`503 configuration-unavailable` 及 PUT 的 `400 invalid-configuration`、`403 profile-not-owned`、`409 revision-conflict` / `409 unsupported-managed-config` / `503 configuration-apply-failed` / `503 configuration-restore-failed` 均只返回固定错误码，不包含任意异常文本。通过现有连接层认证/CSRF 拒绝保持其状态码与无响应体行为。
- POST /tradeloom/session/new：唯一接受 `{role,expectedSessionId,operationId}`，其中 `expectedSessionId` 是当前绑定 session id 或 `null`，`operationId` 是 UUID。成功响应 `{role,sessionId,operationId}`。同 operationId 同 payload 的已完成请求回放原结果；不同 payload 冲突。服务端在专属 owned home 下持久化 intent、expected binding 和状态；若进程重启后目标 session 已存在，只读核对 header id/cwd、preset、官方空白 `turnBoundary` 谓词、workspace 归属且未归档，全部吻合后才完成 binding。谓词为 `turnBoundary === undefined`，或其值满足 `openTurnStartSeq === null && lastTurn === 0`，所以初始化/context/preset 选择事件允许存在。曾开始调用而结果未知的操作不会再次 create。创建或并发校验失败不更改当前 binding，不删除或改写任何旧 Session。

revision 是当前 managed 子树规范化 JSON 的 SHA-256。PUT 按 owned home 与角色串行化本项目的配置流程，并仍通过 `ConfigEditor.edit()` 的锁定 callback 重算 revision/CAS；外部编辑导致当前版本变化时返回 409，不覆盖其结果。保存前用官方 `agentPresets.resolve()` 确认 resolver 可用；写入后再核对当前 revision 并解析 preset。preset child 启动失败可能由 preset registry 记录为 `broken` 而不向 ConfigEditor 抛出异常，所以不能依赖 ConfigEditor 自动回滚覆盖该情形。Host 会在版本仍属于本次写入时再调用官方 `ConfigEditor.edit()` 做一次补偿编辑，只恢复 managed rows、保留当时的非 managed rows 和顶层/其它并发字段，并复核恢复版本及 preset 状态。若版本已被外部改动返回 409；恢复失败返回固定 `configuration-restore-failed`。这是配置语义恢复，不保证 YAML 文件的原始字节、注释或格式完全复原。对原本就处于 broken 状态的 preset，只承诺恢复旧 managed 配置，不宣称它已健康。保存响应只在 ConfigEditor 完成且新版本仍对应目标 preset 时标记 `appliedForNewAgents`。

新 Session 创建只在用户按下明确按钮后发生。Host 在原 role workspace 中调用现有 sessionController.create，使用 UUID 派生的稳定目标 session id 与固定 preset；请求携带 expected current binding 与 operationId。进程内 single-flight 仅减少并发，跨重启依赖持久化 intent/attempt 状态与只读核验。恢复目标必须是 workspace 当前成员、未归档、cwd/preset 与原意图一致且符合官方空白 `turnBoundary` 谓词的 session：`undefined`，或 `openTurnStartSeq === null && lastTurn === 0`；允许非 turn 初始化事件。确定性核对成功后才能更新 state binding；绑定改变后旧 expectedSessionId 请求返回冲突；并发更新使用 state transact 内的条件更新。UI 用现有 sceneApi.selectRole(role, sessionId) 打开该对话。创建失败时保留旧绑定，绝不清理可能已创建的 session。旧 session id 永不修改；角色 binding 指向新 id 是唯一允许变动的关联。

## 用户界面

在既有“查看 MCP 与 Skill 能力”panel 中增加按 role 切换的“配置”编辑态，不增加顶栏或新导航。编辑内容包括：

- MCP server 列表、添加/删除、stdio/Streamable HTTP 字段及 env/header 引用输入。
- Skill 自定义根目录列表，使用专属 workspace/agents-home 下的相对路径选择。
- 当前 Agent 实际可见工具列表与“禁用此工具”控制；该控制更新真实 scoped guard 的 deny 名单。

页面分别显示“已保存配置”和“当前会话实际能力”。保存过程中禁用重复提交；成功后显示新配置已应用于新 Agent、当前会话仍使用原 generation，并出现“用已保存配置新建对话”按钮。用户新建后切换到新 session，旧会话留在原生历史中。验证或应用失败保留草稿并显示固定错误提示；不显示任意服务异常或秘密。

## 验收标准

1. 保存一个角色的 MCP/Skill/deniedTools 后，目标 profile preset patch 只改该角色的 managed plugins 子树；其它 role、其它 plugin rows、顶层字段、全局 plugin、workspace 和会话历史不变。
2. 缺少唯一/ACTIVE root preset entry、错误 role、重复/非法 serverName、未知工具名、非支持 transport、超范围 Skill root、错误环境名、缺失 env、额外 JSON 字段、错误 revision 均拒绝。ConfigEditor 自身抛错使用其官方回滚；registry 将 child failure 记为 broken 时，Host 以第二次 ConfigEditor edit 做 managed subtree 的语义补偿。补偿前 revision 已改变返回 409，补偿失败或原先健康的 preset 恢复后仍 broken 则返回固定 503；不承诺 YAML 原始字节、注释或格式恢复。
3. MCP stdio 和 streamable HTTP 配置均由官方插件加载；环境变量值只通过精确引用表达式进入 runtime，不出现在 API response、DOM、日志或测试输出。
4. 新角色 scope 可发现新 MCP tools 和指定 Skill；其它角色没有该 preset child provider 的新增项。拒绝名单通过真实 ctx.tools.guard 拒绝指定 tool call，移除后不覆盖任何其他 guard。全局 provider/ToolAccess 行为保持原样。
5. 配置应用后，旧 started Agent 仍保留旧 generation 和历史；显式创建的新对话使用新 generation。旧 session id 不变且旧 session 没有被删除；角色的新绑定只在 session creation 成功后改变。
6. 现有能力读取和模型选择不回归；小屏与键盘可操作；同源/CSRF、并发 revision 冲突和敏感信息过滤均有测试。

## 不在本功能范围

- 不编辑全局 DSH MCP/plugin 配置，不修改个人 DSH、个人 Agents 目录或远程 ERP。
- 不支持任意 YAML/JavaScript、file-secret 引用、任意外部 Skill 路径或基于现有工具可见列表以外的工具。
- 不强行重组已开始的 Agent，不覆盖旧会话历史，不自动调用 MCP tools 或模型。
- 不提供逐 server 健康承诺；能力列表中的 tool 可见状态不等同于远端服务可用或工具调用成功。
