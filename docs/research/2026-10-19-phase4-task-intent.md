# Phase 4：自然语言入口与独立提示模板

本子批次为 Agent 中心增加受限的自然语言预览。解析器目前只用可编辑 JSON 规则识别 `prepare_product_data` 和 `generate_deliverables` 的中英文有限表达；未匹配、否定、冲突或范围外目标返回澄清/不支持。预览标记 `local_mock / simulated_rules / not_configured`，没有模型调用，也不把产品业务事实、报价规则或企业约束从目标中推断出来。

`workbench/intent/rules.json` 与 `prompt.md` 独立保存版本和 SHA-256。prompt 是面向未来解释器的受控模板；修改模板不改变当前规则执行。非法配置显式失败。工具参数及配置通过现有 JSON Schema 校验层验证。

创建页面采用“预览—明确确认”两步。预览只读，不调用 handler、不创建 workflow；确认请求由 Django signing token 绑定原始 batch、goal、类型、动作及当前配置版本/hash。该签名用于检测篡改和绑定请求，不加密数据，也不提供用户身份认证。已确认请求继续复用原创建 API 与幂等回执；legacy 三字段 fingerprint 保持不变。规划器消费确认分类并将公开意图记录在已有 center plan step，无需新增表或迁移。

实现参考：

- [12-factor agents：Natural Language to Tool Calls](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-01-natural-language-to-tool-calls.md) —— 参考将自然语言请求转换成受约束工具调用的边界。
- [12-factor agents：Own Your Prompts](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-02-own-your-prompts.md) —— 参考提示模板独立管理及版本溯源。
- [Django 5.2 signing](https://docs.djangoproject.com/en/5.2/topics/signing/) —— 使用带独立 salt 的签名对象绑定预览确认；签名非加密或鉴权。
- 本机固定参考 `ICT/workspace/research/references/luanyujia-workbench` 中的场景配置格式与最小 JSON 示例，仅借鉴配置和界面的分离方式，未复制 Electron harness。

保留 Django 5.2、PostgreSQL 和现有 API/step 模型；JSON Schema 依赖已存在，适用于本批有限结构校验。新增独立 harness 或新模型会重复现有能力并扩大迁移范围，因此没有引入。

验证与本地验收：Django `workbench` 全量 272/272 在最后的规则与 runtime Protocol 窄修之前通过；窄修之后受影响 Django 目标为 10/10 与 runtime/roles 28/28，Node workflow-create 最终 9 项、JS syntax、settings identity guard、Django system check 和 `git diff --check` 通过。Django 测试启动前的 settings guard 曾因路径比较和 `sys.path` 配置失败，均发生在测试执行或数据库连接之前并已修正。QA 启动前另有 guard 脚本配置/语法问题，在对应数据库操作前修正。此前真实 CUA 使用隔离 QA 环境验证首次后端提交后浏览器收到模拟 503，再用相同原始请求/key/token 重放并取得 201；前后完整业务表行 hash、创建回执、中心分类、子任务、步骤与事件一致。QA backend 重启后原 Workflow 可读；未派发 Agent、未提交审核、未生成交付物。正式环境只做带真实 CSRF 的 preview POST，返回 ready 和 `local_mock / simulated_rules / not_configured`；正式前后所有业务行、序列、迁移记录、90 个上传文件 hash 与既有 waiting_human 工作流均一致。后续一次只读检查发现 formal/PostgreSQL 进程 PID 均缺失且端口无 listener，8000 connection-refused、原目录 `pg_ctl status` 报 no server running；原因未知，不作 crash 或其他归因。核对原 PG 17 binary 与原 data dir 后正常启动 PG PID 30328，再用项目 Python hidden `--noreload` 启动 formal 8000 listener PID 33964（launcher PID 35200）。恢复后的 settings guard 通过，正式八组快照逐项一致；health、五板块、旧 Workflow GET 及 CSRF preview 均 200/ready。此次恢复后浏览器复查被 CUA browser URL 安全策略拒绝，所以本次以 HTTP/preview 和完整数据比较验证，不报告新一轮 CUA 通过；此前同代码 CUA 截图仍保留。QA owned 8011/8012 进程已停止，QA 数据库、媒体与证据保留。恢复过程日志、完整快照及 comparison 见项目外 `<LOCAL_EVIDENCE_ROOT>\phase4-task-intent\recovery\`。

实现记录：`mock_runtime.py` 与 `runtime.py` 的首次编辑前副本未纳入原始清单；后从已验证的 Phase 7 `source_snapshot` 恢复并依据 source manifest 校验。`context.py` 有 inventory 项但无内容 diff。上述 guard 失败均早于相应测试/数据库操作；未因这些失败连接或更改目标数据库。两次历史 `PermissionError` 仍未根治。

状态边界：仅本地自然语言预览/签名确认/幂等重试与独立 prompt/rule 文件子批次标记完成；Phase 4 整体、Task 16–18 及真实模型/AgentArts 账号适配仍待实现和实测。当前规则没有模型语义理解，编辑 prompt 不改变规则运行；没有调用付费 API，也没有在 QA 中执行角色、审核或交付生成。本地更新完成只表示 formal 8000 已运行当前源码且 schema 0003 已存在，不扩大为整体 Phase 4 验收。
