# DSH app-boot root Include identity patch

触发症状：主题设置通过 Host `settings.mutate` 持久化时返回 `settings/rejected`，提示 `profile reload requires the root Include entry`，偏好值未改变。

实际身份诊断证明两个 app-boot ESM 实例持有独立私有 WeakMap：失败实例 `moduleToken=2`、`currentModuleMountedAny=false`，但 `ctxIsOwnRoot=true`、`exactCtxSeenByAnyModule=true`、`canonicalRootSeenByAnyModule=true`、`sameRootOtherModule=true`、`moduleCount=2`。修复只共享以 exact Context 为键的 WeakMap；缺少登记的其他 Context 仍被原 guard 拒绝。query 变体集成回归先复现失败，修复后 app-boot 测试 84/84 通过。

从目标 DSH runtime 根目录应用（路径按本机 checkout 调整）：

```powershell
$tradeLoomRoot = 'C:\path\to\tradeloom'
git apply --check "$tradeLoomRoot\docs\runtime-patches\2026-10-23-app-boot-root-include.patch"
git apply "$tradeLoomRoot\docs\runtime-patches\2026-10-23-app-boot-root-include.patch"
```

只构建 app-boot 包，不运行全 Host build：

```powershell
pnpm exec tsc -b packages/boot/app-boot/tsconfig.json
pnpm exec tsdown --config-loader native --config packages/boot/app-boot/tsdown.config.ts
```

定向验证：`pnpm exec vitest run packages/boot/app-boot/tests/app-boot.spec.ts`。

实机验收补充：修复后的 owned Host 已接受 `ui-theme.preference=dark` 单字段写入，`describe` 返回 `preference=dark`、`revision=1`。重启后默认深色保持；正式主题按钮从深色切换到 system/light 后稳定未回退。外壳保持深色时切换到资料与交付物业务场景，业务 iframe 也同步深色；主题 origin 无需额外兼容处理。

## DSH `ui-layout` sidebar suppression — withdrawn

**已按用户于 2026-10-23 的更正撤回，不属于当前启用实现。** 当时生成的 `2026-10-23-ui-layout-sidebar-suppression.patch` 已从工作树删除，Host runtime 源与窄构建产物已逆向恢复。工作台和独立对话均保留原生会话侧栏、历史与入口；工具菜单在两种模式下都调用既有 `layout.toggleSidebar()`。上节记录的 88 项通过只验证了现在已撤回的实现，不作为当前侧栏行为的验证依据。
