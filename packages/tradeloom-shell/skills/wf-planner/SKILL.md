---
name: wf-planner
description: "把用户的大任务拆成可视化工作流（wf）并提交到「工作流」画布。用户要求拆分任务、安排多个 agent 协作、做流程/工作流、或想省 token 让便宜模型干简单活时使用。"
---

# wf-planner：把任务拆成工作流

目标：把一个大任务拆成小节点，每个节点交给最合适的执行者——简单环节给便宜/免费的模型或外部平台，核心环节才用强模型，从而省 token。拆完调用 `tradeloom_wf_propose` 提交草稿，由用户在「工作流」画布上检查、修改并确认。

## 步骤

1. 先澄清：目标、输入资料、期望产物。缺关键信息就问，不要编造企业事实、价格或规则。
2. 拆分：按「输入 → 处理 → 人工确认 → 输出」思路列节点，节点数一般 3–10 个，能并行的不要串成一条线。
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
