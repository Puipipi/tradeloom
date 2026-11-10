# O08 原生 artifact 字节闭环：基线失败与已应用修复复验

本记录保留独立 main 基线 handler 的历史复验失败。provider 身份修补随后先在临时 source overlay 通过真实组合验收，再由前端单写窗口应用到 shared；独立 main 当前工作树也含同语义修复。应用回执见 `C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\evidence\o08-artifact-service-identity-apply-20261030\apply-receipt.json`。当前 r3 包仍不含此修复。验收调用真实 rep4 SDK child/ToolRuntime、真实 `WorkspaceFiles`、候选 `createNativeArtifactHandler`，以及本批自有 PostgreSQL/Django loopback。确定性 LLM、目录选择、一次性导入授权、connection admission、Host pairing 和 role/workspace/settings 是测试 fixture；没有真实 GUI picker、Electron Host、网页或外部模型。

## 基线失败（保留历史）

- 官方 `write`/`present` 与 child `deliverables/presented` 事件、journal declared 来源链通过本场景中的外层断言。
- 安装包 `@deepseek-ai/dsh-api-workspace-files` 的真实 `WorkspaceFiles.stat/readBytes` 能读取临时 workspace 的 `catalog.md`，字节与 SDK 写入内容一致。
- 原 artifact handler 的空列表 GET 经自有 Django/PostgreSQL 返回 HTTP 200。
- 注册 POST 经原 handler 返回安全拒绝 `unavailable`；单次 `authorizeImport` 回调计数为 0，尚未进入导入授权、Django registration 或文件发布；因此没有验证真实注册、列表读回、下载或预览。

本批执行命令：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONNOUSERSITE='1'
& "$env:TEMP\tlr4p\targets\win-x64\unsigned-artifacts\win-unpacked\resources\runtime\primary-runtime\dependencies\python\python.exe" -B testing\o08_native_artifact_acceptance.py
```

修补前最后一次结果为 exit 1，历史安全收据指向当时的 `testing/o08_sdk_native_workflow_acceptance.mjs:615`：`handler-unavailable`、`authorize-count-0`。该结果不代表当前候选状态。Django 的 `TRADELOOM_MEDIA_ROOT` 与 `TRADELOOM_ARTIFACT_ROOT` 均指向该次 PG runner 唯一临时根内的 `media/` 和 `artifact-storage/`；runner 报告 `cleanupCode:null`，没有留下自有服务或临时根。

## 基线故障与修复范围

rep4 Cordis `ctx.get(name)` 每次返回不同的 service proxy，但这些 proxy 的 `Symbol.for('cordis.original')` 指向同一个 provider。本次仅输出身份布尔值：

| 服务 | 两次 `ctx.get` 对象相同 | original 符号存在 | original 相同 |
|---|---:|---:|---:|
| `sessionQuery` | 否 | 是 | 是 |
| `fs` | 否 | 是 | 是 |
| `workspaceFiles` | 否 | 是 | 是 |
| 测试 `directoryPicker` | 是 | — | — |

同一真实 `sessionQuery.readEvent` 成功读回目标 `deliverables/presented` 事件。基线 handler 在 [workflow-native-artifact-http.js](/C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/packages/tradeloom-shell/workflow-native-artifact-http.js:89) await 后以 `get('sessionQuery') !== query` 拒绝；后续 [fresh 检查](/C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/packages/tradeloom-shell/workflow-native-artifact-http.js:111) 对 `fs` 和 `workspaceFiles` 也比较 proxy 外观身份。首次错误发生在授权回调之前；独立候选修正了该身份比较。

最小修复是在 handler 的 freshness 检查比较 provider 身份：对 Cordis proxy 使用 `Symbol.for('cordis.original')` 所指对象；对没有该符号的稳定普通对象保持严格身份比较。修复未缓存/替换 `ctx.get` proxy，也未跳过 await 后的 freshness 检查。独立候选、原始补丁、shared 应用状态和字节说明见[补丁记录](../../recovery-20261029/o08-artifact-service-identity-candidate-20261030/README.md)。本轮开始时独立 main 已有同义修复，本轮未改 handler。root逐字节复核确认 main、shared、approved after 与原候选 base 均使用 `JSON.parse(Buffer.concat(parts))`；规范化后文本相同，main 为 19308 bytes/180 CRLF，shared 与 approved after 为 19128 bytes/180 LF，差异仅为 EOL。

## 候选组合复验

临时 source overlay 只替换 artifact handler 为候选 after，实际 rep4 SDK、官方 child `write`/`present`、sessionQuery、`WorkspaceFiles`，原 Django/PostgreSQL 注册、列表、下载、预览均参与。验收 exit 0：外层 handler 的注册/list/download/preview 响应均 HTTP 200；Django 新建注册接口按原契约返回 201，幂等回放允许 200；文件 storage、download、preview 字节一致。真实官方 sessionQuery provider 撤销及重新挂载后替换都令在途注册返回 503，列表项数保持不变。PostgreSQL 停止为状态码 3，重启后同 run revision 4、done、单 terminal、相同 child/output；清理状态码 3，临时根已删除。此为候选 overlay 的真实组合证据，不是 GUI/生产 Host 证据。

候选复验的第一轮失败是隔离 Django 子进程未设置 validator 要求的 `TRADELOOM_ARTIFACT_NODE` 与 `TRADELOOM_ARTIFACT_NODE_SHA256`；随后 runner 仅在本次自有环境中提供解析后的 Node 可执行路径及其实际 SHA，未修改原 validator。另两处失败是验收合同误把注册响应缺省 `previewSupported` 当作 true，以及把 HTTP 201 新注册只接受为 200；已按原 API 分阶段响应修正验收。

最终命令为：

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:TRADELOOM_O08_SCENARIO='native-artifact'
& "$env:TEMP\tlr4p\targets\win-x64\unsigned-artifacts\win-unpacked\resources\runtime\primary-runtime\dependencies\python\python.exe" -B testing\o08_native_artifact_acceptance.py
```

最终 exit 0 的原始安全 JSON 收据保存在 [o08_native_artifact_acceptance.evidence.json](/C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/testing/o08_native_artifact_acceptance.evidence.json)。它记录 handler 注册/list/download/preview 均 HTTP 200、字节 SHA `4b8105bb6742ce77fc218610b49947660233d1275c7b20e9d8cc518aea7f50d7`、官方 provider 撤销/替换均为 503 且 artifact 数不增加、PG 停止/重启/最终状态 `3/0/3` 与临时根清理。该证据证明独立候选 overlay 组合，不证明 shared 已应用。

## 临时根合同

Django 设置在 [settings.py](/C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/config/settings.py:84) 支持 `TRADELOOM_MEDIA_ROOT` 与 `TRADELOOM_ARTIFACT_ROOT`；原生文件写入使用 [storage.py](/C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/workbench/delivery/storage.py:185) 的独立 artifact root。本批 Python runner 仅将两者指向唯一临时 PG 根。候选验收已证明 NativeArtifactVersion 注册、真实存储与下载/Markdown preview 字节闭环；shared 已应用修复，独立 main 工作树也包含修复，但当前 r3 包不含修复，GUI/生产 Host 仍未验。
