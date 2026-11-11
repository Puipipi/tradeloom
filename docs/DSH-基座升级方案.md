# DSH 基座升级方案（0.2.1-rc.3 → 0.2.2-rc.1）

> 结论先行：**一键工具已就位，但升级被 9 个 hunk 卡住**（详见第 6 节）。
> 实测：0.2.2-rc.1 上 27 个 hunk 中 18 个可自动套用，9 个需重做（8 个在 `dsh-agent-loop`，1 个是前端哈希产物）。
> 旧结论（不可机械替换）：实测证明 5 个受控补丁在新基座上全部对不上锚点，硬换会同时打破：场景记忆授权、会话列表失败相位、面板客户端补丁、以及前端打包产物。
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

## 6. 一键工具实测结果（本轮）

```
node scripts/upgrade-dsh-base.mjs --source <新版 app.asar> --version 0.2.2-rc.1 --dry-run
```

输出（对 0.2.2-rc.1 实测）：

| 项 | 结果 |
|---|---|
| 状态 | `blocked-unresolved-hunks`（非零退出，拒绝产出半成品） |
| `session-list-failure-phase.patch` | **0 失败**，3 个 hunk 全部可套 |
| `production-execution-origin.patch` | 9 个 hunk 失败 |
| 三个 `dsh-client-ui-*.js` | 新基座 `intact`（无截断瑕疵）→ 升级后这 3 个覆盖**应删除** |
| 缺失目标 | 旧前端哈希产物 `index-D4iGkJJO.js`、补丁新建的 `native-operation-origin-adapter.mjs` |

9 个待重做 hunk 的归属：

- `dsh-agent-loop/lib/index.js`：8 个（上游 0.2.2 没有 `operationOrigin` 传播，需在新版重新植入；已确认新基座里 `sceneMemory/executionOrigin/originGrant` 计数均为 0）。
- `dsh-web-frontend/dist/assets/<hash>.js`：1 个（文件名变化，需重定向）。

### 一键升级还差什么（明确、可交接）

1. 把这 8 个 hunk 移植到 0.2.2-rc.1 的 `dsh-agent-loop/lib/index.js`（唯一需要读代码的活）。
2. 前端哈希产物重定向：把补丁目标改成新哈希名，并判断 `native-operation-origin-adapter.mjs` 是否仍需要。
3. 之后 `--stage` 一键流程即可跑完：提取 → 打补丁 → 修截断 → 改三处版本钉 → 守卫 → 回归 → 打包 → 真机。

工具的安全边界：任何 hunk 失败即非零退出，绝不生成“少了功能但看起来正常”的基座。


## 7. 三方合并实测（判断“能不能机械升级”）

用 `git merge-file` 对最难的文件做三方合并：

| 角色 | 内容 | 大小 |
|---|---|---|
| ours | 旧基座里已打我们补丁的 `dsh-agent-loop/lib/index.js` | 84,141 |
| ancestor | 反打补丁恢复的 0.2.1 原始文件 | 74,599 |
| theirs | 0.2.2-rc.1 的同名文件 | 66,629 |
| 合并结果 | 4 处冲突 | 86,066 |

冲突位置与性质：

1. 工具调用区（240 行）：0.2.1 在 agent-loop 内联 `executeToolCalls`；**0.2.2 改成 `loopCtx.tools.execute(...)`**，内联函数计数为 0。
2. pre-step 的 origin ledger（100 行）：我们的 `operationOrigin` 记账逻辑需要按新结构重写。
3. 工具调用点（23 行）：同上，调用形态不同。
4. 启动路径（22 行）：`setupAndPublish`（0.2.1，3 处）→ `initializeAgent`（0.2.2，4 处）。

**结论**：这是架构级重构，不是补丁级差异。新基座里 `operationOrigin`、`sceneMemoryOriginAuthority` 计数均为 0，说明上游完全没采用我们的改动；要在 0.2.2 上保留阶段5的 origin 权威保证，必须按新架构重新实现这 4 处。

因此本轮**不产出部分升级的基座**——部分合并恰恰会丢掉阶段5验过的 origin 权威语义，属于“看起来升级了但坏了”的最坏情况。


## 8. 全量升级已推进到“只差 IPC 契约”

本轮把 0.2.2 基座真正装进隔离候选并启动，逐个击穿阻塞：

| 阻塞 | 处置 | 结果 |
|---|---|---|
| asar 头部 2 字节对齐填充 | 修正 extract/pack 的 base 偏移 | 内容逐字节一致（20,580 条） |
| unpacked 载荷不匹配 | asar 与 `app.asar.unpacked` 同步安装 | 后端能起、Django/PG 端口就绪 |
| `registerSceneMemoryOriginGrant` 落错位置 | 移到 `control.quitInspection` 之后 | `dsh-desktop-host` 语法通过 |
| agent-loop 架构重构 | 在干净基座上重做 ledger / send / 调用点 | 71,319 字节、63 处 `operationOrigin` |

**当前唯一阻塞**：`lib/main.js` 不认 0.2.2 host 新增的 3 个 IPC 事件——

- `starting` `{runId}`：host 启动即发
- `plugin-operation` `{record}`：插件操作诊断流
- `file-drag-resource` `{requestId, resource|error}`：拖拽资源响应

（同时 0.2.2 去掉了 `native-import-confirmation` 两个事件。）

这意味着“基座”不只是 `dsh/**`，还包括 `lib/main.js` 与 `renderer/**` 这层 Electron 外壳——TradeLoom 在这层的补丁也得跟着 0.2.2 一起移植。下一步就是在 `apps/tradeloom-launcher/accepted-runtime/lib/main.js` 里接住这三个事件，再重打装机验收。
