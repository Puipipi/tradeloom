# DSH 基座边界（先读这一页）

> 本页是**强制约束**。任何阶段开工前先读；改动前先跑守卫。
> 机器可读版本：仓库根 `dsh-base.manifest.json`；守卫：`node scripts/check-dsh-base-boundary.mjs`。

## 1. 三类文件，禁止混用

| 类别 | 位置 | 能不能改 |
|---|---|---|
| **DSH 基座** | `app/resources/app.asar` 内的 `dsh/**`（当前 17,171 个文件、约 430 MB，含 `@deepseek-ai/dsh-*` 插件本体与内置 cordis / MCP / OpenAI / OTel 依赖） | **禁止**。不是我们的代码，改了就等着升级时全丢 |
| **基座补丁（受控例外）** | `apps/tradeloom-launcher/accepted-sdk-overrides/**` | 只能改**已登记**的 5 个文件；新增必须先写进 `dsh-base.manifest.json` 的 `base.sanctionedPatches`，否则守卫直接红 |
| **TradeLoom 自有** | `packages/tradeloom-shell/**`、`apps/tradeloom-launcher/accepted-runtime/**`、`workbench/**`、`config/**`、`docs/**`、`scripts/**` | 可自由改 |
| **生成物** | `app/resources/tradeloom/business-shell/**`、`app/resources/tradeloom/deployment.json` | 禁止手改；改源文件后重新打包 |

## 2. 五个受控补丁（唯一允许碰基座的地方）

- `@deepseek-ai/dsh-client-ui-attachment/lib/client.js`
- `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
- `@deepseek-ai/dsh-client-ui-layout/lib/client.js`
- `production-execution-origin.patch`
- `session-list-failure-phase.patch`

这些补丁是**按基座版本写的**，基座一升级就必须重新核对锚点；对不上就得重写补丁，不能硬塞。

## 3. 引擎版本必须三处一致

| 位置 | 常量 |
|---|---|
| `apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/renderers.js` | `ADAPTED_ENGINE` |
| `apps/tradeloom-launcher/accepted-runtime/lib/main.js` | `desktopClientVersion()` |
| `packages/tradeloom-shell/package.json` | `peerDependencies.@deepseek-ai/dsh-scope` |

三处任一与 `dsh-base.manifest.json` 的 `base.version` 不一致，守卫就失败。这条就是为了防止“只改了一处，运行时版本提示和实际基座对不上”。

## 4. dsh 插件必须保持可直接导入

profile 只认这三个 bundle，顺序不能变（`apps/tradeloom-launcher/installed-bootstrap.mjs:INSTALLED_PROFILE_BUNDLES`）：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@tradeloom/dsh-business-shell
```

我们自己的插件 `@tradeloom/dsh-business-shell` 必须同时满足：

1. `packages/tradeloom-shell/package.json` 的 `name` 不变；
2. `exports` 里 13 个键（`.`、`./client`、`./listener-identity`、`./policy`、`./profile`、`./business-tools`、`./tool-schemas`、`./skills-open`、`./step-policy`、`./state`、`./execution-origin-authority`、`./scene-memory-store`、`./diagnostics-store`）全部存在且指向真实文件；
3. `host.js` 与 `client.js` 两个入口都在。

**少一个键 = 插件再也导入不了**，这是守卫第 4 组检查。

## 5. 基座升级的正确做法（不要跳步）

1. 拿新基座的 `dsh/**`（例如从新版 DSH 桌面应用的 `app.asar` 提取），先放进**隔离候选包**，不动用户正在用的那份；
2. 逐个核对 5 个受控补丁的锚点是否仍匹配，不匹配就重写补丁；
3. 同步改三处引擎版本钉 + `dsh-base.manifest.json`；
4. 跑 `node scripts/check-dsh-base-boundary.mjs` + 全量 Shell 回归；
5. 打包 → 装到已放行路径 → 真机跑登录/会话/面板/工具四类动作；
6. 全绿才推 GitHub。任何一步红，回退到旧基座，并记录卡在哪。

## 6. 为什么这么严

上一轮（面板关闭/恢复）就踩过：真正的桌面面板头不在 `packages/tradeloom-shell`，而在基座打包进 asar 的 `replica-ui`。不知道边界就会改错层、白改一遍。所以边界先写死，再动代码。