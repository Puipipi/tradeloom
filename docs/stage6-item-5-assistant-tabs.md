# 阶段 6 第 5 项：助手标签

## 验收步骤

1. 在「商品」场景的「商品助手」上打开右键菜单，选择「添加助手」，选「中心助手」；切换回固定的「商品助手」，再切回「中心助手」。
2. 关闭当前选中的新增标签，确认新增标签消失、商品助手仍可用，并能再次添加同一中心会话。
3. 在「交付」场景重复以上操作，确认「交付助手」固定标签仍可用；随后切到「工作总览」，确认内置「中心助手」仍可回切。
4. 对每个场景检查固定标签无 ×、新增标签有 ×，关闭新增标签后会选择剩余标签或固定助手。

## 本次实际验证

- `node --test apps/tradeloom-launcher/tests/assistant-tabs.test.mjs`：3 项通过。右键事件进入既有面板菜单并触发助手选择事件；商品与交付场景分别保留各自固定 `product` / `delivery` role；新增中心助手使用原 `center-chat` 的绑定与 session，在场景固定助手和新增标签间往返；控制器接受与真实绑定身份匹配的模拟挂载确认，产生 `context-mounted`，状态仍回传到对应标签控制 key。
- 同一测试直接执行标签栏和关闭逻辑：内置商品助手没有关闭按钮，新增标签有关闭按钮；关闭选中的新增标签只移除标签状态，固定助手与会话 surface 保留，另一个新增助手成为选中项，之后可重新添加已关闭的助手。
- `node --test apps/tradeloom-launcher/tests/panel-drag-snap.test.mjs`：4 项通过。
- 修改的 `.mjs`、`.cjs`、`.js` 均通过 `node --check`。

本次以隔离的 Fake Electron/Host surface 验证控制器 IPC、绑定身份和挂载确认，并通过 DOM 函数测试覆盖菜单及标签行为；没有启动 Windows 合包或真实登录 Host，因此这些结果不代表真实 GUI/Host 验收。以上步骤供后续 Windows 合包验收照做。

## 集成候选窄回归

- `node --test packages/tradeloom-shell/tests/dock-layout.test.js apps/tradeloom-launcher/tests/assistant-tabs.test.mjs apps/tradeloom-launcher/tests/panel-expansion-geometry.test.mjs packages/tradeloom-shell/tests/workflow-files.test.mjs`：27 项通过，1 项跳过（授权目录卡片分支）。覆盖标签切换/关闭、五路由旧配置补入订单入口、订单场景固定角色以及预览文件绑定校验。
- `node --test --test-name-pattern='Windows source maps the order scene' packages/tradeloom-shell/tests/source-scene-copy.test.mjs`：1 项通过，覆盖内置模板、投影、`order-production` 助手角色与 `/orders` 路由。
- 集成 ASAR 的 main、source-shell controller、business bridge 与 replica adapter 通过 `node --check`。
- 此环境未安装 Django，`python manage.py test workbench.tests.test_orders_api` 未能启动（`ModuleNotFoundError: django`），订单 Python API 测试待有依赖的构建环境执行。
