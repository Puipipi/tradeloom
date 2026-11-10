---
name: wf-planner
description: "把用户的大任务拆成可视化工作流（wf）并提交到「工作流」画布。用户要求拆分任务、安排多个 agent 协作、做流程/工作流、或想省 token 让便宜模型干简单活时使用。"
---

# wf-planner：把任务拆成工作流

目标：把一个大任务拆成小节点，每个节点交给最合适的执行者——简单环节给便宜/免费的模型或外部平台，核心环节才用强模型，从而省 token。拆完调用 `tradeloom_wf_propose` 提交草稿，由用户在「工作流」画布上检查、修改并确认。

## 步骤

1. 先澄清：目标、输入资料、期望产物。缺关键信息就问，不要编造企业事实、价格或规则。
2. 规划画布模拟图时，按「输入 → 处理 → 人工确认 → 输出」思路列节点，节点数一般 3–10 个，能并行的不要串成一条线。这是 mock 规划建议，不是 native 单节点限制下的执行格式。
3. 写出完整 wf JSON，一次调用 `tradeloom_wf_propose`。返回 `invalid_workflow` 时按 `issues` 全部修完再提交一次。
4. 告诉用户：草稿已在「工作流」画布上，请检查并点「确认」；确认后可以在画布点运行，或让你调用 `tradeloom_wf_run`。不得声称已执行。

## 格式（version 1）

```json
{
  "version": 1,
  "id": "ribbon-catalog-20261024",
  "title": "丝带资料整理并出英文目录",
  "description": "一句话说明",
  "nodes": [
    { "id": "in", "kind": "input", "title": "商品表与图片", "instruction": "用户上传的 CSV 和图片" },
    { "id": "clean", "kind": "agent", "agent": "product", "title": "整理商品字段", "instruction": "补齐缺项，标出待确认" },
    { "id": "translate", "kind": "external", "platform": "免费网页模型", "title": "英文名初译", "instruction": "简单翻译交给免费平台" },
    { "id": "check", "kind": "review", "title": "人工核对" },
    { "id": "pack", "kind": "agent", "agent": "delivery", "title": "生成目录", "model": null },
    { "id": "out", "kind": "output", "title": "英文目录" }
  ],
  "edges": [
    { "from": "in", "to": "clean" }, { "from": "in", "to": "translate" },
    { "from": "clean", "to": "check" }, { "from": "translate", "to": "check" },
    { "from": "check", "to": "pack" }, { "from": "pack", "to": "out" }
  ]
}
```

规则：

- `id` 只用小写字母、数字、`-`、`_`，最长 48；wf 的 `id` 建议带日期，避免覆盖用户已有 wf。
- `kind`：`input` 起点；`agent` 交给角色；`review` 等人确认（不通过则下游跳过）；`external` 交给外部平台（必须写 `platform`）；`output` 终点。
- `agent` 只能是：`center` 中心、`product` 商品专家、`market` 市场研究（占位）、`quote` 询报价（占位）、`delivery` 交付协同、`user-profile` 用户资料（演示）。
- `model` 可省略或为 `null`（跟随该 agent 默认模型）；只有用户指定时才写 `{ "provider": "...", "model": "..." }`。
- `edges` 表示依赖，不能成环；没有上游的节点会最先执行，依赖都完成的节点会并行执行。
- 不写 `position`，画布会自动排版。
- 涉及对外发送、报价、改 ERP 等风险操作，前面加一个 `review` 节点。

## 三条独立路线

- 业务工作台 WorkflowTask：继续使用现有 read/begin/bind/advice 流程及其服务端授权、人审规则；不能用 Canvas 或 native run 回执替代。
- Canvas「运行」与 `tradeloom_wf_run`：仍为 `local_mock`，不调用真实 Agent 或外部平台；仅保留当前进程最近 30 条运行记录。上面的多节点例子属于这条规划/模拟路线。
- 新 native 路线：只接受用户已确认、恰好一个非 center 的 `agent` 节点且 `edges:[]` 的已保存定义；不支持 center、external、input、review、output 或多节点。禁止自动删边、删节点或降级 mock 来冒充 native。

原生运行先调用 `tradeloom_wf_native_prepare({workflowId})`，检查 `eligible:true`、`executionMode:native_dsh`、`confirmed:true` 及返回的 definitionRevision/bindingRevision；再调用 `tradeloom_wf_native_submit` 带 workflowId、expectedDefinitionRevision、expectedBindingRevision。expected 值仅用于比对，不授予权限；prepare 不替用户批准或确认。

accepted/runId 仅代表持久提交。用 `tradeloom_wf_native_get` 读取持久状态及匹配的 subagent/end 回执，不能把 activation、ack 或提交成功说成 completed。`native_cancel` 仅请求 abort，仍须读取收敛状态。unknown/interrupted 不自动重派；完整 DAG 和人工 resume 尚未实现。不得编造 Artifact、业务事实或审批结论。

wf 定义存于自有 DSH_HOME/tradeloom-workflows。native 持久运行与业务工作台 workbench/workflows 审批记录相互独立，不能互作执行凭据。
