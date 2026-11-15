# UI18 R75 验证与重建边界

## 便携包与首次启动

- `TradeLoom-r75.zip`：SHA-256 `c9f56e6ba6511d14f84acde731f191eeaf75dcbd7e0f225b5c760fbf9f3305d0`，797,266,799 字节。逐项 ZIP 读回通过；39,739 个程序文件、2,218,777,278 字节，程序树 SHA-256 `81e5e8f9aa4af04b8aa987f4d0c575cbeb61b2cf966c229a2c9f3ef5b9eb0674`。
- GitHub 发布入口使用 tag `ui18-r75-portable-20261106`；资产可用性以对应 [GitHub Release 页面](https://github.com/Puipipi/tradeloom/releases/tag/ui18-r75-portable-20261106)为准。
- 从该 ZIP 解压到隔离目录后，由随包 C10 首次启动并创建新的 `data-ui-r2`。启动阶段到达角色面板 `mounted-end`，启动器、Host、Django、PostgreSQL均就绪。
- 新 profile 的只读结构摘要为22个 bundle、20个依赖、639个内部链接，4个角色绑定均有非空 session 引用；R23 插入一次，Whale/R23 程序文件摘要匹配。没有登录账号或发送消息；这次启动验证角色面板挂载和程序初始化，不覆盖业务模型端到端。
- QA profile 保留在隔离解压目录。结束后通过其自身正常停机路径停止 QA 服务，并恢复原正式安装；没有把 QA 数据写回原安装的数据目录。

## 当前正式安装与原生验收边界

- 最终 ZIP QA 后原正式安装恢复为 R73+R23；程序文件未被本次 ZIP QA 替换。原安装的用户数据保持原位，QA 数据未回灌。
- 已沿用的原生证据包括 R65 PNG 预览/历史末条与 Whale 尺寸往返，R68 五场景窗口、主题写入和跨场景 gutter 保存，R73 窄窗/关闭语义/原生标题栏交互。交叠时的临时隐藏对应既有业务桥碰撞隐藏分支，恢复后可见；不表示数据丢失。
- Root 本轮还实际确认原生侧栏 Logo、打开关闭后的布局恢复，以及交付物标题栏双击最大化/还原后的面板顺序。动画中间帧只在浏览器测量，不宣称原生逐帧通过。
- 未进行模型业务端到端对话、未登录 fresh profile，也未发送消息；不把这些未做项推导成程序包或角色挂载失败。任务栏关闭入口没有单独 GUI 点击。

## 源码重建边界

- 本地交付分支 `delivery/ui18-r75-20261106` 从 `Puipipi/tradeloom` 的 `4f56f8a1d7528e3bfcb805b2d5bb99501dfdcf34` 起始。冻结源清单包含300个唯一文件（27,108,692 字节）；7项角色初始化回归通过。
- 相对源码 builder 使用固定 R74 ASAR、unpacked sidecar 与 deployment 输入，并将采纳的 UI18 runtime 源码和外置 shell、程序 seed 映射到对应产物；结果复现 R75 ASAR `e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d` 与 deployment `6847189104017cc29cf292361e70a2568db6a824b965562aa36a89a1c91586aa`。
- 固定 R74 输入包 `r74-build-inputs.zip`：1,585 项 / 427,915,196 字节，ZIP 149,080,656 字节，SHA-256 `1636ac1a650796a944ece9d4351ff95c60081bb854716f8c40f6b83c0eba42c2`。只含 `resources/app.asar`、`resources/app.asar.unpacked/` 与 `resources/tradeloom/deployment.json`，没有外置 shell 或 seed 的重复副本。生成器为 `apps/tradeloom-launcher/scripts/package-r74-build-inputs.py`；逐项读回收据保存在仓库外的构建证据目录。
- SDK 其余文件沿用固定 vendor 基线；3份已采纳 SDK compiled compatibility snapshots 不等于完整 SDK TypeScript 重建。完整 ZIP 含 Electron、Python、PostgreSQL 与纯程序 seed；不含个人 profile、凭据、数据库、聊天或附件。

## 复现命令

源码重建使用发布的 R74 固定输入包（ZIP SHA-256 `1636ac1a650796a944ece9d4351ff95c60081bb854716f8c40f6b83c0eba42c2`）及便携包中的纯程序 seed。先把 R74 输入 ZIP 解压到目录 `<r74-input>`，使其包含 `resources/app.asar`、`resources/app.asar.unpacked/` 和 `resources/tradeloom/deployment.json`。把完整 R75 程序目录复制到新的 `<p2-base>`（ZIP 中没有新建的 profile 数据），然后用 R74 输入中的 `resources/app.asar` 和 `resources/tradeloom/deployment.json` 覆盖该目录对应两项；其余运行时、shell、seed 和程序文件保留 R75 ZIP 原样。该恢复基线由打包器的完整 `c7c5c0e3fdddce08e6cddbb251edc14088d67a92c740a40c3b13669c356651a8` 树摘要校验。再将 R75 ZIP 中的 `TradeLoom-r75/app/resources/tradeloom/plugin-seed/` 提取到 `<seed-root>`。`<asar-tools>` 必须能解析固定 `@electron/asar` 4.3.1。所有输出目录必须在仓库外且为新目录。

```powershell
node apps/tradeloom-launcher/scripts/build-release-r75.mjs `
  --base-resources <p2-base>/app/resources `
  --plugin-seed <seed-root> `
  --asar-tools <asar-tools> `
  --output-root <new-build-output>
```

该命令从恢复后的固定 R74 ASAR/vendor 基线和300个冻结源码目标构建 ASAR/deployment；固定 SDK 其余部分沿用 vendor 输入，不是完整 SDK TypeScript 重建。得到 R75 `resources/` 后，可用同一完整程序树生成完整便携 ZIP：

```powershell
node apps/tradeloom-launcher/scripts/build-portable-program-zip-r75.mjs `
  --p2-root <p2-base> `
  --r75-resources <new-build-output>/resources `
  --output-root <new-output-directory> `
  --python <python-executable>
```

R75 完整 ZIP 与 R74 输入包这两个资产即可恢复 builder 所需的完整匹配 p2 基线，无需再获取另一份重复的 p2 程序包。两个构建入口均核验固定程序输入、生成并读回工件；不会启动、安装或发布应用。
