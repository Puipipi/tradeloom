# 场景组件

在桌面「场景配置」复制内置场景。在自建场景的「可添加组件」菜单中选择「文件」或「商品」。如果 4×4 网格已满，先缩小或移动现有面板，再添加。每个新增组件都有独立标识，可编辑名称、起始行列、宽度和高度，也可单独移除。不在同一场景重复已使用的业务路径。

原「运行记录」副本仍可在 `reference` 槽切换「资料／文件」，在 `auxiliary` 槽切换「任务／商品」。保存并应用使用原有配置版本校验，保留必备助手、模板和全局业务入口。Web 用原有配置刷新入口读取新选择。保存过的布局预设保留其他面板；用旧预设时，新增组件可从右键菜单恢复。若既有桌面布局的位置与新增组件冲突，先保留原面板并关闭冲突组件，可从右键菜单恢复。

Host 的 `scene-layout.js` 管理受支持的组件目录，`GET /tradeloom/scenes` 返回只读 `componentCatalog`。每条目录记录有稳定的 `id`，以 `templateSceneId`、`panelId` 定位自建场景里的槽，并固定渲染 `type`、受控 `path` 与 `category`。同槽选项共享 `defaultPath` 和 `defaultLabel`。第一项 `artifact-files` 复用既有 `/artifacts#files`，没有额外数据字段。保存的面板用 `componentId` 指明选择；省略它时沿用旧配置语义。Web 和桌面都使用 Host 返回的槽与路径。

扩展时在 `scene-layout.js` 的 `SCENE_COMPONENT_CATALOG` 中追加一个登记项。当前跨端支持的槽为 `runs/reference` 和 `runs/auxiliary`，类型为 `business-iframe`。同槽各项的 `defaultPath`、`defaultLabel`、`category` 必须与 `scenes.json` 原槽一致。ID 需为 1–48 个小写字母、数字或连字符，全目录唯一；同槽不能重复目标路径。路径只能用两端已支持的业务页面，新增槽位或新渲染类型需要先支持两端投影。不要复用已持久化 ID 表示另一种组件。

下面是测试采用的附加登记项示例，正式目录只登记文件和商品组件：

```js
Object.freeze({
  id: 'artifact-deliverables', label: '交付物',
  templateSceneId: 'runs', panelId: 'reference',
  type: 'business-iframe', path: '/artifacts#deliverables', category: 'resources',
  defaultPath: '/artifacts', defaultLabel: '资料',
})
```

调用方用原有受保护的 `GET /tradeloom/scenes` 读取目录和配置，随后可用原有 `PUT /tradeloom/scenes` 提交 `{ expectedRevision, configuration }`。其中 `configuration` 是 `version`、`grid`、`businessRoutes`、`scenes` 组成的文档；不要回传 GET 的目录、角色或会话元数据。配置按 `componentId` 核对槽、类型、类别和路径，仍使用原有 409 版本冲突处理。切回默认时去除 `componentId` 并恢复原路径；没有该字段的旧配置继续可读。目录不接受外部插件、脚本、远程 URL 或任意数据字段。

登记项有 `allowStandalone: true` 时，允许给受支持内置模板派生的自建场景新增该组件。新增实例用独立的 `component-<标识>` 面板 ID，组件类型、类别和路径仍来自目录；删除实例可移除整条面板记录。已有换槽声明继续使用原 ID。

新增登记后先跑 `source-scene-copy.test.mjs` 和 `scene-configuration.test.mjs`。前者让测试目录新增第二项并走现有选择器及双端投影，后者覆盖现有实际登记的保存、读回和回退。发布前用目标路由确认嵌入可用。
