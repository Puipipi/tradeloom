# WebAI 账户菜单触发器关系探针（隔离候选）

本候选只提供一个 host-only、只读的触发器关系诊断。它不改 `authState`，不签发登录结论，也未接入 Main、preload、SDK 或实际窗口。之前的认证候选保持不变。

## 固定调用顺序

1. Host 核对当前 owned/focused WebContents 的 origin、document identity 和 generation。origin 必须是对应的固定站点；调用方不能从 query、renderer 参数或菜单内容指定 provider、selector 或脚本。
2. 在用户打开菜单前，Host 在固定 isolated world 执行 `accountMenuTriggerCaptureInstallScript(provider)`。探针只捕获**第一个 `isTrusted === true` 的 `pointerdown`**，在内存中保留目标元素及最多三层祖先引用。它不点按、不聚焦、不发送输入，也不读取目标文本、label、id、`aria-controls` 值、HTML、账号或聊天内容。
3. 后续由既有固定账户菜单探针完成其原有语义检查。在**同一次 JS 执行**中，只有原探针已确认唯一、可见的正菜单根时，才能在该分支调用 `accountMenuTriggerCaptureConfirmedMenuExpression(provider)`。表达式使用当前局部变量 `menu`，把这个精确 DOM 引用传给 isolated-world capture。若没有唯一已确认根，固定探针应返回 `projectNoConfirmedMenu(provider)` 对应的中性 DTO；此时不返回点击路径或 activeElement 元数据。
4. Host 通过 `createWebAiAccountTriggerProbe` 的无参数可信闭包运行 arm/confirmed probe，并在调用前后复核 owner/focus、origin、document identity 和 generation。页面替换、导航、关闭或过期结果均得到 `unknown`；不匹配时取消并清理捕获。

**不能**先通过一次 executeJavaScript 得到“菜单为真”布尔值，再在第二次执行中猜测或重新寻找菜单根。DOM 根引用不能跨调用 DTO 恢复；integration 必须在现有固定探针的同次调用局部作用域内接线。原有固定语义扫描规则由 Host 保留，本候选不复制或增加任何文本扫描。

## 关系字段含义

| 字段 | 含义 |
| --- | --- |
| `relation: linked` / `evidenceKind: ariaExactAssociation` | 唯一捕获候选按钮的 `ariaControlsElements` 中包含同次语义确认的 menu 元素对象；严格比较对象引用，不读菜单/按钮 id 或 `aria-controls` 属性值。 |
| `relation: unknown` / `evidenceKind: pointerCandidate` | 捕获到一个受信 pointerdown，但没有唯一精确对象关联。它可能是无关点击，**不是**触发器或登录证明。 |
| `relation: unknown` / `evidenceKind: activeOnly` | 没有有效受信点击，仅投影当前 activeElement 的安全 tag/role/可见性/布尔结构。activeElement 不被当作触发器。 |
| `relation: unknown` / `evidenceKind: none` | 没有可投影的候选。 |

`matchedControlsCount` 上限为 2；2 表示多重匹配或超出检查界限，不任意挑选。每个候选只投影 `tag`/有限 `role`、按钮/可见/属性存在布尔和 `aria-expanded` 的固定枚举。`aria-haspopup` 只投影是否存在，不输出原值。只检查受信点击目标及最多两层祖先，不枚举页面控件或遍历菜单内容。浏览器不支持 `ariaControlsElements` 时关系保持 `unknown`，不回退到 id/属性字符串。

采集器监听首个受信 pointerdown；首次捕获后立即移除 listener。它不安装 MutationObserver，也不遍历 DOM。固定 30 秒到期会清理 listener、timer 和内存引用；confirmed hook、取消、Host 生命周期失效也执行幂等清理。confirmed probe 无论 positive、unknown、异常还是 DTO 校验失败，都会消费本次 arm 并调用固定取消闭包；同次 arm 之后的重复 sample 返回 unavailable。没有自动轮询、自动点击或窗口操作。

`ariaExactAssociation` 只检查受信 pointerdown 路径（目标及最多两层祖先）中的 button 与已确认 menu 的 `ariaControlsElements` 对象引用；它不枚举整个文档的 controls。只找到 activeElement、点击候选没有精确关联、没有 pointerdown，或反射不支持，都不能输出 `linked`。未找到关系不表示站点不存在关联按钮。

## 最小 Host 接线示例

以下是接线位置示意，不是可直接替换的完整 Main 文件。Host 先在用户操作前运行固定 arm script；既有菜单探针随后在其本地循环中保留当前 `menu` 引用。原正语义分支及现有 `authState` 更新保持原样，只额外把独立诊断结果放进 development-only envelope：

```js
// Host only: run before the user opens the menu, in the same isolated world.
await executeFixedIsolatedWorld(accountMenuTriggerCaptureInstallScript(provider))

// Inside the existing fixed account-menu probe, after its existing check has
// identified exactly one qualifying visible menu. `menu` is that local root.
const triggerEvidence = globalThis[Symbol.for(`tradeloom.webai.account-trigger-capture.v1.${provider}`)]
  ?.projectConfirmedMenuTrigger(menu) ?? null
return { existingMenuEvidence, developmentTriggerEvidence: triggerEvidence }
```

该示例中的 `executeFixedIsolatedWorld` 是 Host 自有固定调用，不属于本候选的新 RPC。实际接线还必须在 no-positive/多 root 分支返回无元数据的 unknown，并在导航/销毁时执行固定 cancel script。不要把 `developmentTriggerEvidence` 合入认证 DTO、publisher 白名单或业务授权。

## 边界与验证

- 本轮仅 Node DOM/Host fixtures：两站固定 root 的组合回调、精确引用、缺少反射、歧义、pointer/active fallback、no-positive 不导出候选、生命周期及迟到结果。测试没有读取真实网页或真实登录窗口。
- 豆包/Doubao 和 DeepSeek 的实际 DOM trigger 关联都未在本轮采样；此探针也不证明站点请求已认证、账户权限或业务操作可用。
- Main/Host 尚未接入本候选。Main 必须在同一固定探针执行中插入确认 hook；不能独立调用 helper 重找菜单根。部署或现场 GUI 验收均未进行。
- 固定 DOM 采样脚本与 host wrapper 都没有 `authState` 字段。触发器关联始终是开发诊断信息，不是认证依据。

源码：`webai-account-trigger-probe.js`；类型：`webai-account-trigger-probe.d.ts`；验证命令和原始输出位于 `recovery-20261029/webai-account-trigger-probe-20261102/`。
