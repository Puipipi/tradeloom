# 0.2.1-rc.4 保存的完整 preset：升级 0.2.2-rc.1

适用范围：从官方 rc4 `standard` 或 `ptc` 复制后，保存在自定义 bundle 或 profile `config.plugins` 中的完整 preset。只引用内置 preset、没有覆盖整个 `plugins` 数组的配置，会使用新版官方声明，不需要照本文改写。

## 为什么原副本不能直接启动

rc1 的 `@deepseek-ai/dsh-tool-subagent-control` 主插件已直接注册 `list_agents`，不再导出旧的 `/list-agents` 子路径。旧完整副本同时包含这两行插件，加载旧子路径会导致 `agent-preset/invalid`。

同时，子代理模型配置从 `modelSelectionSettings` 改为 `modelSelection`、`modelDiscovery`。仅修复加载错误不足以保留模型选择/发现入口。旧 `dsh-agent-tool-presentation` 的 `mode: ptc` 仍有官方兼容支持，本路径保留它。

## 原文件不变的自动兼容

App 运行时可在注册 preset 时兼容旧官方 standard/PTC 的**完整、未改动 delegation 子树**：包含原来的六行声明、主 control、旧 list-agents、旧 true 配置，以及官方的 group/isolate 字段。PTC 的 workflow 两行 disabled:true 也必须保持官方形状。匹配比较整个子树，包括字段、数组顺序和值；添加字段、改为 false、加入新模型字段、增删子行或调整作用域都不套用。

兼容只创建内存副本，移除冗余旧声明并映射两个模型字段；原 profile/bundle 文件不写入，组外的 persona 与其它自定义配置保留。预设“查看配置”读取的是本次生效的兼容后声明，磁盘原件仍保留旧写法；回退补丁即可恢复旧加载行为。不会改写会话、迁移任意插件或把未知加载错误变成重试。

`runtime/tests/preset-legacy-delegation-live.py` 用锁定官方 rc4 输入和实际 rc1 Host 验证两种旧完整 preset、新官方正控、六种未匹配形状继续失败、原文件字节不变、native/PTC executor、模型参数与只读子代理工具。未验证模型生成或 Android。其余配置仍按下文人工步骤逐项判断，不能整体覆盖 plugins 数组。

## 人工最小修改

先备份实际拥有该 preset 的文件。确认没有其他程序正在编辑，并检查以下前提：

- 同一 `delegation` composition 已有启用的 `@deepseek-ai/dsh-tool-subagent-control` 主插件。
- 旧 `tool-subagent-list-agents` 行只有下面的 `id` 和 `name`，没有自定义配置、注入、隔离或禁用条件。
- `tool-subagent` 的旧字段明确是 `modelSelectionSettings: true`，并且没有已有的 `modelSelection` / `modelDiscovery` 新字段。

满足前提时，仅移除这一冗余声明：

```yaml
- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

在原 `tool-subagent` 的 `config` 中，将：

```yaml
modelSelectionSettings: true
```

改为：

```yaml
modelSelection: true
modelDiscovery: true
```

其余内容保留，包括工具顺序、persona、provider、限制、用户自定义字段、disabled 表达式及旧 PTC selector。不要用整份新版官方 `plugins` 数组覆盖用户数组，也不要在同一作用域同时添加第二个 executor。

若旧值为 `false`、已经存在新字段、缺主 control、旧行有自定义字段或处于不同 scope，应停止套用此路径，单独评估配置。本文未验证这些情形，不提供通用自动迁移器。

## 验证与实际覆盖

测试 `runtime/tests/preset-manual-migration-live.py` 使用实际官方 rc4 的 standard/PTC 文件，在临时副本加入自定义 persona，然后只做上述两处映射，验证其他字节与顺序不变。真实 rc1 Host 验证：

- 两种 preset 均能通过真实 `session/create` 创建。
- scoped executor 分别为 native、PTC；旧 PTC selector 保留。
- 该 Agent 作用域可见 `list_agents`、`subagent`、`list_subagent_models`。
- `subagent` 公开 schema 保留 `provider`、`model`、`reasoning_effort` 参数。
- 直接调用真实已注册的只读列表工具：`list_agents` 返回空子代理列表，`list_subagent_models` 返回父会话允许的 provider。未伪造工具结果。

```bash
python3 runtime/tests/preset-manual-migration-live.py \
  --prefix /absolute/patched-rc1-prefix \
  --old-prefix /absolute/rc4-prefix \
  --out /absolute/disposable-evidence-directory \
  --port 39422
```

测试不触碰用户 profile，不启动真实模型子任务；未验证子代理模型实际生成、完整 PTC 程序运输或 Android UI。不得把通过范围扩大为任意第三方 preset 均可迁移。新建 Host 的原始日志含临时 token，不应分享；只分享 `result.json` 和安全审计摘要。

## 回滚

恢复原 preset 文件只回滚这次配置修改，不会回滚引擎已经升级的数据。尤其 schedule 域在 rc1 首次更新后会写 v2，rc4 会拒绝该版本。回退引擎时应使用升级前一致时间点的配置与数据备份，不能仅替换可执行文件，也不能覆盖升级后用户新做的配置修改。
