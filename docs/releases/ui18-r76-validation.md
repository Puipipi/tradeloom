# UI18 R76 验证与重建边界

## R76 程序包

- `TradeLoom-r76.zip`：797,266,789 字节，SHA-256 `868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341`。逐项 ZIP 写入及读回匹配；39,739 个程序文件、2,218,777,236 字节，程序树 SHA-256 `c9c46e77d1dccfa32ce4af7445daf6ed2f7702f4b0686ed1dc1e11f7e8193849`。ZIP 本身未在本轮重新启动；R75 同基线已做隔离 C10 fresh 启动。
- R76 相对 R75 只改 business-shell adapter 一处：移除 toast 背景 alias，让 SDK 原生 toast 样式决定背景。ASAR保持 `e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d`；deployment 仅 `resources.businessShell.bytes` 和 `.sha256` 两个叶字段更新。
- R76 在隔离 QA profile 中做了冷更新。Root核看了用户触发的截图：坏图加入草稿后，发送前附件校验出现深色原生提示框、橙色警示图标和完整白色说明文字；用户确认显示正确。坏图可先加入草稿，阻止的是发送前校验；工具未发出消息。浅色/深色两态配色对比是浏览器证据，不称为原生双主题验收。该范围不代表 R76 ZIP 做过 fresh-profile 冷启动。
- 便携包包含 Electron、Node、Python、PostgreSQL、Django/backend 和 25,170 个纯程序 seed 文件；保留随包程序数据资产，不带个人 profile、凭据、数据库、聊天或附件。R76 已冻结待发布，拟用 tag 为 `ui18-r76-portable-20261106`；R75 Release 仍为草稿，仅作历史验证基线。

## R75 fresh-start baseline

R75 ZIP `c9f56e6ba6511d14f84acde731f191eeaf75dcbd7e0f225b5c760fbf9f3305d0`（797,266,799 字节）已逐项读回、解压到独立目录，并由随包 C10 从空数据目录启动。启动到达角色面板 mounted；22 bundles、20 dependencies、639 links 与4个非空角色 session 引用均通过只读摘要核对。未登录、未发送消息，也未执行模型业务端到端。QA profile 保留在独立目录；正式 R73 安装及数据未被 QA 数据替换。

## 源码构建边界

- R76 源快照基于 `Puipipi/tradeloom` R75 merge 后代码；冻结清单包含300个唯一目标，R76 相对 R75 只有 adapter 字节变化。R76 adapter：6707 字节，SHA-256 `a086140cbb7a241a0cab30a797472bb42e707cba89c9d4e17321e454aef90b69`。
- 固定 R74 build-input ZIP 为 1,585 项、427,915,196 字节；ZIP SHA-256 `1636ac1a650796a944ece9d4351ff95c60081bb854716f8c40f6b83c0eba42c2`。R76 manifest 固定300个源码目标和一个额外 build-only preimage：`apps/tradeloom-launcher/accepted-build-inputs/r75/client.replica-palette.js`（6749字节，SHA-256 `d1ad47c2a8241a0f968016f69a6768a0177d19cc3487c56d016e2832ec56d5bc`），用于从R76完整程序树恢复R74 p2基线，不进入运行程序。构建器核验300个源码目标、该preimage、R74 ASAR/deployment与程序 seed；由R74 deployment和冻结Main pin派生R75 deployment，再更新 shell 的 bytes/SHA 得到R76 deployment。R76 复用与R75完全相同的ASAR和SDK snapshots；没有重建整个SDK的TypeScript源码。
- R76 deployment：75,753 字节，SHA-256 `82c06b270620a22d31682c92da65fd776c7f3bb3d0d433f2066751c021a825d6`。business-shell：57文件、2,589,497字节，tree SHA-256 `375fa7a53b7b004537351cc1c5dd5d66b2d980e8217d9982de8a1adfeae76558`。
- ZIP打包器以恢复后的完整R74 p2程序树作为固定基线，只覆盖R76 ASAR、deployment与adapter；逐项读回所有ZIP成员，并验证最终文件数和程序树摘要。该构建过程不启动应用、不访问用户profile。

## 重建命令

准备 R74 输入 ZIP 解压后的 `resources` 目录、完整 R76 程序包内的 `app/resources`（其中提供与 R75 相同的 ASAR）及其中的 `tradeloom/plugin-seed`。构建器从R74 deployment派生并验证R75 deployment，不要求额外提供R75 deployment文件。若要从R76 ZIP恢复便携打包器要求的固定R74 p2基线：先将R76 ZIP解压到新目录，再以R74 build-input ZIP中的 `resources/app.asar` 和 `resources/tradeloom/deployment.json` 覆盖对应两项，并以源码仓库中的R75 adapter preimage覆盖 `app/resources/tradeloom/business-shell/client.replica-palette.js`。打包器会校验完整固定p2 tree。所有输入/输出目录使用新目录；preimage只用于还原打包基线，不会被复制进最终R76覆盖层。

```powershell
node apps/tradeloom-launcher/scripts/build-release-r76.mjs `
  --r74-resources <r74-input>/resources `
  --r75-resources <r76-program>/app/resources `
  --plugin-seed <r76-program>/app/resources/tradeloom/plugin-seed `
  --output-root <new-build-output>

node apps/tradeloom-launcher/scripts/build-portable-program-zip-r76.mjs `
  --p2-root <restored-r74-p2-program> `
  --r75-resources <r76-program>/app/resources `
  --r76-resources <new-build-output>/resources `
  --output-root <new-zip-output> `
  --python <python-executable>
```

R76目前是本地验证候选；拟用tag为 `ui18-r76-portable-20261106`。公开下载可用性以GitHub Release页面为准。
