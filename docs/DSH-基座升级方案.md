# DSH 基座升级方案（0.2.1-rc.3 → 0.2.2-rc.1）

> 结论先行：**这次不能直接换基座**。实测证明 5 个受控补丁在新基座上全部对不上锚点，硬换会同时打破：场景记忆授权、会话列表失败相位、面板客户端补丁、以及前端打包产物。
> 证据：`D:/TL-S5-A20261110/evidence/dsh-base-compat-probe.json`

## 1. 现状（已核实）

| 项 | TradeLoom 当前 | 本机安装的 DSH |
|---|---|---|
| 基座版本 | `0.2.1-rc.3` | `0.2.2-rc.1` |
| asar 内 `dsh/` 文件数 | 17,171 | 21,047 |
| `dsh/` 体积 | 约 430.6 MB | 约 454.1 MB |
| `@deepseek-ai` 包数量 | 未逐一比对（旧包结构解析受限） | 329 |

新基座就在本机：`C:/Users/23825/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`，无需联网。

## 2. 为什么不能机械替换（实测）

| 补丁 | 目标文件 | 旧体积 → 新体积 | 能否直接套用 |
|---|---|---|---|
| `production-execution-origin.patch` | `dsh-desktop-host/lib/index.js` | 22,911 → 24,579 | 否 |
| 同上 | `dsh-web-frontend/dist/assets/` 前端产物 | `index-D4iGkJJO.js` → `index-BgUyXZcc.js` | **否（文件名带内容哈希，必然变）** |
| `session-list-failure-phase.patch` | `dsh-api-gateway/lib/client.browser.js` | 85,260 → 84,134 | 否 |
| `dsh-client-ui-layout/lib/client.js`（整文件覆盖） | 同左 | 43,858 → 38,881 | 否 |
| `dsh-client-ui-conversation/lib/client.js`（整文件覆盖） | 同左 | 803,113 → 940,214 | 否 |
| `dsh-client-ui-attachment/lib/client.js`（整文件覆盖） | 同左 | 48,137 → 100,197 | 否 |

其中 conversation 体积涨 17%、attachment 翻倍，说明上游本身在这些插件上做了实质改动；把旧覆盖文件硬盖回去等于**回退上游功能**。

## 3. 正确做法（分 5 步，每步可回退）

1. **隔离**：从本机新版 DSH 的 `app.asar` 提取 `dsh/**`，放进新建候选包（不动用户正在用的 `D:/TL-S5-A76532/...`）。
2. **重写补丁**：对每个补丁目标，在新文件里重新定位锚点：
   - `scene-memory-origin-grant` 消息处理（desktop-host）
   - 会话列表失败相位（api-gateway client）
   - 三个 ui 客户端插件：以**新基座文件为底**重新施加我们的改动（不是拿旧文件覆盖）
   - 前端产物：按新哈希文件名重写 patch，并复核新增的 `native-operation-origin-adapter.mjs` 是否仍需要
3. **改三处版本钉**：`ADAPTED_ENGINE`、`desktopClientVersion()`、`peerDependencies['@deepseek-ai/dsh-scope']`，同步 `dsh-base.manifest.json` 的 `base.version`。
4. **验证**：`node scripts/check-dsh-base-boundary.mjs` → 全量 Shell 回归 → 打包 → 装到已放行路径 → 真机跑「登录 / 会话列表 / 面板关闭恢复 / 业务工具调用」四类动作。
5. **全绿才推**。任何一步红：回退候选包，记录卡点，不发布。

## 4. 本次交付了什么

- `dsh-base.manifest.json`：基座/自有/生成物边界、5 个受控补丁清单、插件导入契约。
- `docs/DSH-基座边界.md`：人读版规则（含“少一个 exports 键 = 插件导入不了”）。
- `scripts/check-dsh-base-boundary.mjs`：自动守卫，已接入回归（354 项全绿）。
- 本文件：升级方案与实测阻塞点。

**本轮没有替换基座**，因为替换即意味着 5 个补丁同时失效。当前线上基座 `0.2.1-rc.3` 保持原样且健康。

## 5. 当前基座健康度（真机 + 日志）

- 启动观察日志：本实例 215 条记录，仅 1 条历史性 `OWNER_REJECTED`（早期与另一实例竞争侧栏状态），其余为正常的 origin-grant 相位序列。
- 面板关闭/恢复、右键恢复、助手能力、业务工具调用均在真机验证通过（见 `panel-x-context-menu-live.json`）。
- 基座边界守卫：3 处版本钉一致、5 个补丁全部登记、3 个 profile bundle 顺序正确、插件 13 个 exports 键齐全。