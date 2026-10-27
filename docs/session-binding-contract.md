# 角色会话绑定与归档状态

2026-10-25 源码已实现，尚未同步运行中的 desktop16。初始加载使用现有只读 `GET /tradeloom/scenes`，不能用可能创建会话的 POST 查询已有绑定。

## 只读初始加载

`GET /tradeloom/scenes` 保持原有 `sessionBindings: { roleId: sessionId }`，新增 `sessionBindingMetadata`。只为同一次状态读取中合法的绑定生成同键元数据：

```json
{
  "sessionBindings": { "center": "existing-session" },
  "sessionBindingMetadata": {
    "center": {
      "scope": "role",
      "roleId": "center",
      "sessionId": "existing-session",
      "workspaceId": "workspace-id",
      "archiveState": "archived"
    }
  }
}
```

没有合法绑定的角色在两个 map 中都没有该键。GET 只读一次状态，不调用 transact、创建会话、恢复归档或发送消息。消费者必须匹配 `roleId` 与当前 `sessionId`；迟到的旧会话元数据不能覆盖新绑定。旧版缺 map 或缺字段时保留未知状态。

## 创建或复用时的响应

受现有 connection gate 保护的 `POST /tradeloom/session` 请求仍为 `{ "role": "center" }`。成功响应保持原有 `role`、`sessionId`，新增：

```json
{
  "role": "center",
  "sessionId": "existing-session",
  "binding": {
    "scope": "role",
    "roleId": "center",
    "sessionId": "existing-session",
    "workspaceId": "workspace-id",
    "archiveState": "archived"
  }
}
```

- `scope: role` 表示目前按角色绑定，不表示每个场景独立上下文。
- `archiveState` 取 `archived`、`unarchived`、`unknown`，来自当前原生 WorkspaceRegistry 的归档集合。`unarchived` 仅表示不在归档集合，不能称正在执行、历史已加载或模型可用。
- 原有状态没有 `workspaceId` 时该值为 `null`，不生成假工作区身份。
- 既有会话即使归档也保持其身份，接口不创建替代会话、不恢复归档、不移动历史、不发送消息。
- 旧桌面版本没有 `binding` 时，消费者按未知处理，不能推断未归档。
- 归档提示可引导用户使用原生“显示归档”或归档管理入口；真正恢复必须由原生显式操作完成。原生归档行的不可打开规则继续保留。

## 已有证据与限制

- 新增测试覆盖归档、未归档及未知三种状态，验证已有绑定不变、没有创建或恢复会话。
- 加入只读 bootstrap 后，与既有 shell/scenes 回归合计69通过、0失败、8项既有环境跳过。日志：`workspace/testing/sidebar-catalog-20261025/bootstrap-green.log`。
- 同目录 `native-filter-result.json` 是磁盘元数据经未经修改的原生 `tree.ts` 过滤的离线证据。其 default0、show10、only10 不替代 live16 UI 的目录查询和过滤验收。
- 前端随后在 live16 验证显示归档10条、仅归档10条、默认0条；点击归档会话保留原生拒绝打开提示，没有恢复或创建会话。由此前后端确认目录并未丢注册，剩余工作是展示正确的归档绑定状态。
