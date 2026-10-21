# 织贸助手业务工作台

此组合插件为 DSH 提供六个通用 Agent、五个业务页面入口，以及两个产品场景入口：“工作总览”绑定 `center`，“资料整理”绑定 `user-profile`。场景由 `scenes.json` 描述面板和受限面板类型；Host 通过受保护的 `GET /tradeloom/scenes` 提供该配置。`client.scenes.js` 作为 DSH 包内 `client.*.js` 动态 chunk，经 `client.js` 的 `require.async()` 加载。stage 会依据 `package.json` 的 `files` 白名单一并复制场景 JSON 和 chunk。

每个场景显示对应的业务 iframe、通用待办占位和原生会话绑定卡。绑定卡通过既有 `POST /tradeloom/session` 解析对应角色的真实 session ID，再由单独按钮调用 `uiWorkspace.openSession()` 进入原生全屏会话；此界面不嵌入或伪造第二个聊天框。场景切换保留各自面板展开和刷新状态，会话仍按现有 role-session 存储映射。

业务页面地址为 `/home`、`/products`、`/agent-center`、`/artifacts` 和 `/runs`。实际页面由业务服务提供，场景中的资料面板使用 `/artifacts`。媒体资源路径由业务服务提供为 `/uploads/`。

状态文件只写入专用 DSH app home。启动配置必须显式设置 `DSH_HOME` 与 `TRADELOOM_DSH_APP_HOME` 为同一专用目录，并在其中放置内容为 `tradeloom-dsh-apphome-v1` 的 `.tradeloom-owned` 标记文件；未满足条件时，插件拒绝读写状态或创建专用工作区。用户演示资料通过受保护的 `/tradeloom/profile` 接口读取或修改。

中心只使用 DSH 原生 subagent 和 `send_message`。每个中心会话最多委派 4 次、向直接子会话发送 16 条消息，并且每轮最多运行 24 步；限制仅作用于该工作台 preset。用户资料助手通过只读工具读取当前演示资料。

#### 本地 source-mode 修改

编辑 `scenes.json`、`client.scenes.js` 或 Host 路由后，先停止自己的 TradeLoom 开发实例，再使用已通过当前 patch lock/receipt 和官方 development preparation 的 source runtime 同步 bundle，然后按同一 runtime 启动。同步仅更新受控 TradeLoom bundle 副本，不适用于安装版资源：

```powershell
node .\apps\tradeloom-launcher\cli.mjs sync-dev-bundle --mode desktop --runtime '<已准备且符合当前lock/receipt的source-runtime绝对路径>'
```

目前原生 DSH 会话仍由 `uiWorkspace.openSession()` 打开为全屏会话页；场景工作台不承载并排聊天面板。
