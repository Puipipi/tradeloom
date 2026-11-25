# Workflow 返回文本裁切合同（671）

Refs W17-B，无对应公开issue编号。真实workflow工具接受JavaScript orchestration body及JSON meta，通过WorkflowEngine返回合法JSON值；不是YAML格式化。默认maxResultChars=50000，预算针对JSON.stringify(value,null,2)的UTF16单位，不含工具说明前缀或截断标记。

当且仅当需要裁切且边界分裂一个合法高/低代理对时，保留末端退1单位。其余保留内容与原有JSON缩进规则相同。遗漏计数必须为rendered.length减实际保留长度；标记格式不变。不会把预算改成码点/字素，不改工具value、脚本执行权限、run生命周期或工具参数，无新依赖。

前台正常run完成后的output.render与后台完成jobOutcomeOf共用renderResult。动态验收限真实前台CLI/Agent/ToolRuntime/WorkflowEngine/PTC执行；后台仅源证，不冒称已跑。自有脚本仅return标量/对象，0子agent，无脚本文件/网络操作。模型端点是本地合成，非真实远程模型。独立live回归保留模型请求中的工具结果精确字符串及完整JSON值语义边界；不把原probe自然exit0当修复前测试通过。

部署会改runtimeVersion。Android 未编译，没有ARM/PRoot或真机验收，不关闭#570。手动探针依赖完整CLI/runtime/PTC装配，按ADD6命名*-live.mjs，不混入普通CI *.test.mjs。
