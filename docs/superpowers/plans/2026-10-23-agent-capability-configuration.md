# [Feature] 按角色配置 MCP、Skill 与工具权限

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to carry out this plan task by task. Each task has a verification checkpoint. Do not stage or commit changes; the repository owner will review and decide integration.

**Goal:** 在现有能力面板中为每个角色编辑并保存 MCP、Skill 搜索根目录和工具拒绝名单，随后由用户明确创建使用新配置的新对话，同时完整保留旧会话。

**Architecture:** 在 Host 增加窄配置适配器，按固定角色映射通过 DSH 官方 ConfigEditor 修改唯一 ACTIVE preset root 的 managed child plugins；通过 scoped preset guard 执行工具拒绝名单。现有能力面板编辑和查看持久化配置，单独显示当前 Agent generation 的实际能力，并以官方 sessionController 创建新对话。配置只保存在当前专属 profile overlay，不触碰全局 DSH 配置。

**Tech Stack:** Node.js、现有 Tradeloom shell Host/API、DSH ConfigEditor/Loader、MCP client、skill-filesystem、agent preset scoped tools guard、现有 React UI 和 Node test runner。

**Spec:** `docs/superpowers/specs/2026-10-23-agent-capability-configuration-design.md`

## 全局约束

- 角色值必须来自 `roles.js` 的封闭集合，并映射到唯一的 `ROLE_PRESETS[role]`。只编辑 `@deepseek-ai/dsh-agent-preset` 且 `config.id` 精确匹配的唯一 root entry；fiber 必须等于官方 `FiberState.ACTIVE`。
- 写入前以 `resolveOwnedHome()` 校验当前 `.tradeloom-owned` marker，再核对官方 `profileContext.home/dir/patchPath` 与 owned home 下专属 active profile 一致。profile 不在此范围内或 ConfigEditor 服务缺失时，GET 返回固定 unavailable 状态，PUT 不落盘；严禁直接写 YAML、改 home overlay 或回退到手动改文件。
- 只改该 preset `config.plugins` 中本项目标记的 child rows。保留配置其它字段、非 managed rows、其它角色、全局 plugins、Home 配置、会话 ID 和历史。
- 所有持久化写入都通过 `ConfigEditor.edit()`。在其锁定 callback 内对当前 managed subtree 做 revision/CAS 检查；不另写 YAML、profile 文件或配置引擎。
- MCP 的 env 与 HTTP header 值不接受原始值、任意表达式、YAML 或 Loader tag。仅接受 `{envName, scheme}`；写入固定可信环境表达式，缺失环境变量时拒绝保存，GET 只投影 env/header 引用与存在状态，不回显已求值的值。command/args/cwd 仍是用户提供的普通配置文本，不宣称不含用户自行写入的敏感文本；HTTP URL 必须拒绝 user/pass。managed MCP/Skill/policy row 有未知字段、表达式、非 primitive 配置或 disabled 标记时只投影安全状态并拒绝整份 PUT。非 managed MCP row 原样保留且不回显；Host 只在内存中检查其 serverName，避免与新 managed server 重名。
- Skill 配置只使用官方 `includeDefaultRoots` 与 `customSkillDirs`，保留默认根继承；新增路径必须在 TradeLoom 专属目录范围内，不更改全局目录。
- 工具拒绝策略通过角色 preset scoped plugin 中 `ctx.tools.guard()` 实际执行，按 `ToolExecution.name` 精确拒绝。激活前校验官方 `scopeOf(ctx) !== undefined`，全局 scope 必须拒绝激活。它不得覆盖或放宽其它 guard、`TOOL_ACCESS` 或默认权限。
- 保存配置不重组已启动 Agent。ConfigEditor Loader reconciliation 可能在保存时连接/启动 MCP child；UI 必须在保存前告知。只有用户明确选择“用已保存配置新建对话”才创建新的 session；旧 session id 不改不删，角色 binding 只在成功后可切换到新 session id。新会话请求必须带当前 `expectedSessionId` 和 UUID `operationId`，同 payload 重试幂等、并发或陈旧 binding 冲突不能覆盖。
- 先写失败行为断言并实际运行取得 RED，再实现并验证 GREEN。所有 provider/Agent 测试使用本地 synthetic fixture，不访问付费模型、真实服务或个人 DSH。测试失败时保留原始日志，不跳过失败用例掩盖问题。

## 文件与执行顺序

任务 1、2、3 已完成并经 Root 审查。本计划记录其实现与验证边界；本地运行时激活的单独验收见[工作台本地激活记录](../verification/2026-10-23-workbench-local-activation.md)。本计划不代表桌面窗口或手机视觉验收完成。

### 任务 1：实现 profile 配置适配器与 scoped tool policy

**文件：** 新建 `packages/tradeloom-shell/agent-configuration.js`、`packages/tradeloom-shell/tool-policy.js`、`packages/tradeloom-shell/tests/agent-configuration.test.js`；修改 `packages/tradeloom-shell/host.js`、`packages/tradeloom-shell/package.json` 与 `packages/tradeloom-shell/cordis.patch.yml`。

- [x] 先为角色越权、缺失/重复/非 ACTIVE preset root、额外 JSON 字段、陈旧 revision、缺失 env 引用、超范围 Skill 根和无效工具名编写可运行的行为测试，确认 RED 来自预期拒绝或缺少 endpoint。
- [x] 添加封闭角色解析和唯一 root-entry 查找；用官方 `ConfigEditor.entries()` 读取并以 `FiberState.ACTIVE` 比较状态，拒绝不唯一或不可编辑的目标。
- [x] 定义 API 的闭合输入/输出 schema。GET 严格投影可识别的 managed 配置；不安全的 managed row 只返回不含值的状态并令配置只读。非 managed MCP row 不回显，写入时只在内存检查 serverName 冲突。PUT 只接受 managed MCP rows、Skill roots、denied tool names 与 `expectedRevision`。
- [x] API 契约固定为：GET 成功 `{role,preset,revision,editable,mcpServers,skill,deniedTools}`；PUT 只接受 `{expectedRevision,mcpServers,skill,deniedTools}`，成功 `{role,preset,revision,appliedForNewAgents:true,currentSessionUnchanged:true}`。transport 分别使用官方 `stdio` / `streamable-http` 字段；env/header 每个值只有 `{envName,scheme:'raw'|'bearer'}`。缺 ConfigEditor / 非 owned profile 时 GET 返回 `{error:'configuration-unavailable'}`，PUT 原子拒绝。
- [x] 规范化 managed subtree 并生成 SHA-256 revision；在 `ConfigEditor.edit()` callback 锁内重算 revision，只有匹配时才合并到当前配置并保留所有非 managed 字段/rows。把 schema 错误、冲突及 reconcile 失败转换为固定错误码，不输出异常正文。
- [x] MCP 配置仅支持官方 stdio 与 streamable HTTP 结构；校验唯一 serverName、字段类型和必需项。将 env 引用限制为合法环境变量名及 `raw`/`bearer` scheme，构造固定 Loader expression，并在写入前验证变量存在；响应中永不读取或返回秘密值。
- [x] Skill 配置使用官方字段并验证自定义目录实际解析后仍位于允许的 TradeLoom 专属根目录。保留默认继承，不改变全局 provider roots。
- [x] 增加 preset scoped `tool-policy` plugin；激活时通过 `scopeOf(ctx)` 确认 scope 非空，否则拒绝激活；通过 `ctx.tools.guard()` 按 `ToolExecution.name` 拒绝名单中的执行，返回固定拒绝结果。默认空名单不影响当前行为，不引入“允许名单”来扩大权限。
- [x] 在 `host.js` 注册同源 GET/PUT `/tradeloom/agent-configuration`，调用现有 `ctx.connection.requestRejection(req)`；添加输入校验、CSRF/来源拒绝、revision 409 和安全错误投影。
- [x] GREEN 后运行新定向测试及现有 shell/capabilities 测试，检查 `git diff --check`，记录命令、退出码和受影响文件。

**Task 1 状态：** 代码与定向行为测试已完成并经 Root 审查。另用隔离的真实 profileBoot/ConfigEditor 运行链验证 preset child 启动失败的检测与补偿编辑；这是通过第二次官方 `ConfigEditor.edit()` 恢复 managed rows，不等同于 ConfigEditor 自身异常回滚，也不保证 YAML 原始字节、注释或格式完全复原。单元测试仍使用受控 fake，不能单独声称验证了官方链路。

**验收点：** 修改一个角色只改变该角色 preset 的 managed child subtree；ConfigEditor 的完整配置校验/reconcile/rollback 生效。冲突和非法数据不会写入；秘密值、任意表达式及非 managed 配置不会被 API 读取或回显。工具 guard 对一个角色生效而不影响其它角色。

### 任务 2：在现有能力面板编辑配置并创建新对话

**文件：** 修改 `packages/tradeloom-shell/client.js`、`packages/tradeloom-shell/client.scenes.js` 与必要的 `host.js`；新增或扩展 `packages/tradeloom-shell/tests/agent-configuration-ui.test.js`、`packages/tradeloom-shell/tests/session-generation.test.js`。尽量复用当前能力 panel、`sceneApi.selectRole()` 和现有测试 fixtures。

- [x] DOM/React 行为测试覆盖：已保存配置与当前会话能力分开呈现、旧会话不热更新、角色切换期间草稿保留、保存期间禁用编辑控件、新对话更新角色绑定、双击复用同一个请求，旧会话身份保留。
- [x] 现有能力 panel 增加按角色编辑入口，不增加顶栏或独立导航。支持 MCP stdio/HTTP 基础字段、环境变量/请求头引用、专属 Skill 根目录和实际工具拒绝名单；不可见旧 deny 项仍可保留或撤销。
- [x] 表单从闭合 schema API 加载/保存；保存错误保留草稿，显示版本冲突；保存期间禁用重复提交和编辑。读取/渲染不显示 env 实际值，也不回传 GET `present`。新会话结果未知时说明旧会话仍保持、原操作已保留；不能建议创建另一操作来绕过核对。
- [x] 持久化配置与当前 Session 的实际能力分开；说明保存供新 Agent 使用、当前 started Agent 保持旧 generation，且 ConfigEditor 保存可能立即校验并连接/启动 MCP。
- [x] 显式“用已保存配置新建对话”经官方 sessionController 在同角色 workspace/preset 下创建新 session。Host 先持久化 operation intent 和角色绑定 CAS；重试先只读核验 stable ID、workspace membership、cwd、preset 与官方空白 `turnBoundary` 谓词（`undefined`，或 `openTurnStartSeq === null && lastTurn === 0`；允许非 turn 初始化事件）。确认后才更新 binding；结果未知或 ID 不符时保持 pending/outcome-unknown，不盲目重建或清理 session。
- [x] 不调用关闭、删除、重命名或复用旧 session 的 API；失败保留旧会话和旧历史。
- [x] Task 2 定向 RED/GREEN 与任务 1、shell、capabilities 和 scene 行为回归已运行。桌面窗口视觉验收未做，不以 DOM 测试替代。

**验收点：** 用户能在已有能力 panel 编辑、保存并创建真正使用新 preset 的新对话；旧会话继续保留其原 ID、generation 和可从原生历史打开的能力。保存动作本身不改变旧 Agent。

### 任务 3：验证官方 Loader、MCP、Skill 与 generation 隔离

**文件：** 新建 `packages/tradeloom-shell/tests/agent-configuration-runtime.test.js`，必要时只修改本功能 owned 文件修复已证实的问题；验证数据全部使用测试临时目录与 synthetic fixtures。

- [x] 构建本地 profile fixture，调用真实官方 ConfigEditor API 保存配置；验证 managed rows 写入隔离 profile overlay，非 managed 行/字段和原会话历史保持原样。
- [x] 用官方 Loader reconciliation 加载 stdio 与 streamable HTTP synthetic MCP servers。检查新 Agent 可发现配置工具，旧 Agent 仍持有旧 generation；不调用任何外部服务或付费 provider。
- [x] 验证 env reference 只在 runtime 求值；API、DOM、脱敏后的捕获流和 test output 中都不存在 synthetic secret value。缺失 env 在保存前失败。
- [x] 用独立 synthetic Skill root 放置测试 Skill；验证该角色的官方 Skill provider 能发现它、默认根继承保留、其它角色未获得这个 preset child provider 的新增项；不宣称抑制 Host/global provider 的继承能力。
- [x] 在隔离 profileBoot Agent scope 上执行测试：产品 scoped deny 拒绝对应工具执行，而旧 Agent 仍按旧 generation 执行。其它角色/global 的默认继承不因 preset child 写入而被遮蔽。
- [x] 验证显式新建流程创建新 session、新 Agent generation 并更新磁盘 binding；旧 session id、磁盘历史和原 Agent generation 仍在，失败路径恢复配置并保留旧绑定。
- [x] 使用固定 Node 24.21.0 运行最终完整 Shell `tests/*.test.js` gate：226/226 通过、0 跳过、exit 0；源码与脱敏后的测试证据清单已冻结。

**验收点：** 真实官方配置链路与 scope guard 在隔离测试环境工作，能区分旧/新 Agent generation，并证明角色隔离和旧会话保留。preset registry 把 child activation 记录为 broken 时，Host 通过 CAS 受控的第二次 ConfigEditor edit 进行语义补偿；若外部已变更 managed revision 则返回冲突，若补偿失败则返回独立错误。测试不承诺 raw YAML 字节恢复，也不把 synthetic MCP/provider 测试描述成真实远端 MCP、付费模型或桌面视觉验收。

## 最终交付边界

- 以上三个实现任务及其测试已完成；本地激活另按审查过的有限流程执行，实际结果见[工作台本地激活记录](../verification/2026-10-23-workbench-local-activation.md)。
- 本计划不授权写入个人 DSH、连接远程 ERP、调用付费 provider、修改全局配置、提交或推送代码；未通过记录验收桌面窗口/手机视觉效果。
- 不将工具可见状态等同于远端可用性，也不将新 preset 保存等同于旧 Agent 热更新。
