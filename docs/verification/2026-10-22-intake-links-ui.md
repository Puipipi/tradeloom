# 资料候选关联验证记录（2026-10-22）

本次实现为资料页增加人工关联判断：操作员可选同一来源或不同来源的两条候选，记录建议、确认或否决及理由；各条判断按时间保留，可从双方候选分别查看。候选详情只预览最近 20 条；存在更早记录时返回 `links_next_offset`，关联工作区通过现有分页接口继续读取完整历史。

确认一条关联判断只表示该判断状态，不表示真实产品身份已经核实。系统不自动合并候选，不改变产品、生产需求、候选状态或来源原件，也不写入 ERP。DSH 只读投影标记为 `association_decision`，不会把关联理由解释为已核实事实。

关系判断历史复用现有关联记录和回执模型；迁移 `workbench/migrations/0010_intake_candidate_link_history.py` 只移除技术性 pair 唯一约束，保留已有记录及幂等键。使用者可对同一对候选追加后续判断，旧记录不被覆盖。

## 验证

- `workbench.tests`：501 项通过、0 失败、0 跳过。使用隔离的 PostgreSQL 测试数据库，没有迁移主应用数据库。
- `packages/tradeloom-shell/tests/*.test.js`：165 项通过、0 失败、0 跳过。测试涵盖完整 Node 套件、实际 DOM 模板/脚本、candidate8 WebServer、Cordis、React 及只读工具投影。
- 工作台关联 UI 通过 jsdom 与合成 HTTP 响应测试。此次验证没有可用的桌面浏览器窗口，因此没有完成原生桌面窗口的视觉验收。

公开实现边界参考了 [django-import-export 的导入流程](https://django-import-export.readthedocs.io/en/stable/import_workflow.html)中的预览、明确目标和事务边界取舍；这里复用仓库已有来源、候选、关联与回执结构，不引入该库，也未复制其源码。该参考仅用于实现取舍，并非对本功能的外部验证。

旧预检中文路径遗漏已补核，新增代码仍需最终发布扫描。
