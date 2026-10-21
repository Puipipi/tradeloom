# 安装版桌面启动契约

安装版通过 `apps/tradeloom-launcher/bootstrap-entry.mjs` 作为 packaged `main`。它消费 `resources/tradeloom/deployment.json` 的 `packaged` schema 2，使用 Electron 的实际 `process.resourcesPath` 解析所有资源，并核对 `appPath/lib/main.js` 与清单 hash；不依赖仓库、`.git`、source runtime receipt 或用户机器已有 Python/Django。source-mode schema 1 仍走原有 source bootstrap。

原生业务工具只从当前产品 Host 的受信 LAN 地址构造 Django Host/Origin，网络目标固定为本机 Django `3090`，POST 使用 Django CSRF。runtime 与用户数据只属于 TradeLoom 专用安装目录；升级只更新 TradeLoom 自己的版本化副本。电脑上既有工作用 DSH 的安装、home、账号、配置、会话、进程、凭据和端口均不接入、不迁移、不读取、不修改。

受控 builder 的 source-mode stage 只接受显式绝对路径 `TRADELOOM_DESKTOP_STAGE=%LOCALAPPDATA%\TradeLoom\staging\desktop`，并验证 stage marker。既有 electron-builder FileSet 把 `stage\launcher` 复制到 `lib\tradeloom`（只含 `.mjs`），把 `stage\resources\tradeloom` 精确复制到 `resources\tradeloom`；`extraMetadata.main` 指向 `lib/tradeloom/bootstrap-entry.mjs`。stage 必须先由 `stage-desktop.mjs` 生成；缺少 stage 时 builder 明确失败，不会改用官方入口。

stage 命令参数依次为受控 pinned runtime、位于 `LOCALAPPDATA\TradeLoom` 内的专用 Python、同一产品目录内的 Django `manage.py` 和用户明确选择的当前活动物理网卡 RFC1918 地址。stage 写入 `deployment.json`，其中 runtime/python/manage 都是产品根相对路径，记录 LAN 地址、当前 compiled `apps/desktop/lib/main.js` SHA256 和完整 patch lock。runtime 字段指向后续部署目标 `runtime/releases/<版本目录名>`；desktop-2 source runtime 已有与当前 patch lock 匹配的 receipt，且其两个真实入口 hashes 已通过验证，但 stage 仍不搬动 source runtime。后续专属安装步骤负责把经验证 release 部署到这个 LocalAppData 目标，缺少目标时 bootstrap 会拒绝启动。部署文件与输出路径拒绝 reparse/link。Python、Django 或 LAN 地址尚未准备时，不会生成可启动 stage。

历史版本 p5 的 unsigned 安装器构建与安装记录：electron-builder 子阶段退出码为 0，安装器 SHA256 为 `DA538F21E660010253968E272C2AF45A1E74A64EC52105588C833071F71E1F1D`。本机交付副本位于 `<USER_HOME>\Desktop\ICT\workspace\deliverables\tradeloom-desktop-p5-20261020\tradeloom-0.2.1-rc.2-win-x64-unsigned.exe`（336,933,699 字节）；当时安装内容 14,150 个文件的比较结果为 missing/extra/mismatch 全 0，app.asar 入口与核心文件 hash 匹配 stage 5。该版本已被后续安装替换；p5 unsigned 安装器与交付副本可重新安装回退，不是正式签名发行版。

后续 p7 官方 `package:win:x64:unsigned` 于 PID `31792`、UTC `2026-10-19T18:16:31.128Z` close code 0，候选、receipt 和交付副本 SHA 记录见本节历史证据。用户曾启动 p7 并截图确认顶部业务导航和左侧六个 Agent；这只证明 p7 当时的窗口布局，不证明原生聊天或工具调用。随后 p8 unsigned 安装和 14,150 项资源核验通过，但 p8 首启出现 welcome/account.state Web RPC failure，故安装成功不代表当前 GUI 可用。p6 `runtime:smoke` 临时安装 pnpm 插件时对 `package.json` 原子 rename 收到 EPERM，p7 未复现，原因未确认。

`receipt-writer.mjs` 仅在独立 builder 已确认全部 pinned patches 应用成功且官方 desktop build exit 0 后，读取两个真实发行入口 `apps/desktop/lib/main.js` 和 `apps/desktop-host/lib/index.js` 生成 hash receipt；CSRF 桥已内联在 main.js，receipt 不要求单独的 web-document chunk。写入使用唯一临时文件和 hard-link 原子创建，既有 receipt 不会被覆盖。receipt 是本机 build 记录，不是签名。`TRADELOOM_EXTERNAL_SUPERVISOR=1` 是命令行受管开发模式：外层 launcher 已负责 Django 和互斥锁时，bootstrap 仍检查 ownhome、profile 与 receipt，但跳过重复 Django/锁。

正式安装包资源使用 `stage-desktop.mjs --mode packaged`，必须显式传入受控 runtime、stage 输出目录以及 b2 Python 和 PostgreSQL 17 payload 根目录与对应 manifest/file-list 路径。该模式不依赖 `LOCALAPPDATA` 中已有 Python 或 `manage.py`；每个外部 file manifest 都逐文件核对路径、字节数和 SHA256，再复制到带 ownership marker 的 stage。Django allowlist 仅含 `manage.py`、`requirements-workbench.txt`、`config`、`workbench` 和 `data/samples`；业务 shell 按其 package.json 的 `files` 列表复制。Python `__pycache__`/`.pyc` 被排除，测试、venv、缓存、`.env`、用户上传和数据库目录不进入资源包。Python 3.12.14 依赖、PostgreSQL 17.11 与 business-shell 都写入相对 `resources/tradeloom/...` 的 manifest 路径并记录版本、文件数、字节数与 stage 树摘要；Python/PostgreSQL 授权文件随资源保留。主 Python 固定为 `resources/runtime/primary-runtime/dependencies/python/python.exe`，由官方 Electron builder 提供，不在本 stage 重复打包。packaged manifest 是 schemaVersion 2，明确表示安装资源合同；source-mode schemaVersion 1 与既有 LOCALAPPDATA/source runtime 启动契约保持兼容。schema 2 bootstrap 有针对性 fixture 覆盖，p5 安装资源也已逐文件对比；两者都不替代安装后首次 GUI 启动验收。

首次启动会验证业务 allowlist、business-shell、Python 依赖树和 PostgreSQL 可执行资源的实际文件摘要；然后在 TradeLoom 专属 home 下调用 packaged DSH 依赖闭包公开导出的 `initProfile`，并将已核验的 business-shell 文件物化到 profile 的 `node_modules/@tradeloom/dsh-business-shell`。LAN 地址从当前活动物理 Wi-Fi/以太网候选中选择，清单不保存本机地址。用户数据默认放 `%LOCALAPPDATA%\TradeLoom`，也可用绝对路径 `TRADELOOM_DATA_ROOT` 覆盖；媒体与交付文件写入该数据根，安装资源保持只读。

PostgreSQL 17 首次初始化位于数据根的 `postgres` 子目录，使用 SCRAM、UTF-8、C locale、loopback `55432` 和专属数据库 `tradeloom`。已有带产品 ownership marker 的集群会复用；冲突端口只报错，不终止其他进程。密码只保存在本地 owned 文件并传入子进程环境。Django 使用安装内 CPython primary runtime，以 isolated `-I -B -c` runner 明确加入已打包的 Python dependencies 和 backend 路径，先迁移再监听 `127.0.0.1:3090`。启动失败会停止本次启动的受管服务；退出会停止产品自己的 Django 与 PostgreSQL。DSH 绑定所选 LAN IP 的 `3088`，主模块导入后再异步等待 Host ready。

packaged stage 的命令参数为 `--mode packaged --runtime-path <绝对路径> --stage-path <绝对路径> --python-payload-root <b2 根目录> --python-manifest <b2 manifest> --python-files-manifest <b2 文件清单> --postgres-payload-root <PG17 根目录> --postgres-manifest <PG17 manifest> --postgres-files-manifest <PG17 文件清单>`。Stage 输出路径必须是新的、专用的受控目录；每个候选使用独立目录名，避免旧资源残留。命令仍要求 runtime receipt 与当前 patch lock 匹配。

安装 bootstrap 的 schema 2 fixture 覆盖路径、启动顺序、集群复用、foreign-port 拒绝、迁移失败清理和 `pg_ctl` 文件句柄等待。当前安装仍为 p8 unsigned，安装资源与解包资源对比无差异；p8 首启 welcome/account.state 曾显示 Web RPC failure。之后通过本地 source-mode Electron（隔离 DataRoot、p8 runtime 只读 junction）成功打开并实际操作两场景、五业务入口和六 Agent；这不更新或修复 p8 安装内容。GUI 摘要与截图见 `workspace/testing/desktop-package-contract/local-workbench-gui-acceptance-20261020.json`。隔离 Django/PostgreSQL 演示也曾完成两条本地模拟工作流、下载核对和 Django 重启后状态复核；演示站目前已停，且不代表真实 provider 调用。现有电脑工作用 DSH 的安装、home、账号、配置、会话、进程与协议关联保持未触碰。

#### 本机安装前置与人工验收

历史安装前快照曾显示旧 p3 测试实例占用固定端口 `3088`（DSH Host）、`3090`（Django）和 `55432`（PostgreSQL）；`2026-10-20 08:06 UTC` 的后续快照又显示这些端口当时无监听，不代表现在的持续状态。在任务管理器中如需识别 p3，应核对可执行路径 `<EXTERNAL_RUNTIME_ROOT>\tradeloom-harness\build\p3\targets\win-x64\unsigned-artifacts\win-unpacked\织贸助手.exe`，再通过该测试实例的原生窗口或托盘正常退出；标题可能仍显示 `DeepSeek Harness`，不要只凭标题判断进程，也不要关闭个人工作用 DSH。未发现受支持的外部 DSH quit 命令或端口覆盖选项，启动器 `stop --data-root` 只管理它自己启动的服务。当前安装路径为 `<USER_HOME>\AppData\Local\Programs\tradeloom\织贸助手.exe`，已安装 p8，p8 首启 Web RPC failure 仍是该安装版本的历史问题。此次通过的是隔离 source-mode 本地 Electron：当次 session `73905`、CLI PID `29424`、DataRoot `<EXTERNAL_RUNTIME_ROOT>\tradeloom-harness\local-dev\workbench-20261020-02`；最终 stability snapshot 在 `2026-10-20T11:56:06Z` 至 `12:05:20Z` 连续 9.2 分钟，health 200、PostgreSQL ready、无新 crash。快捷方式 `<USER_HOME>\Desktop\织贸助手（本地开发）.lnk` 已核对 target/args/icon；可复启指引见 `<EXTERNAL_RUNTIME_ROOT>\tradeloom-harness\local-dev\workbench-runner\README.md`。这不是安装版启动证明。隔离演示站 8011 已停，不能替代本地 GUI 记录。

- [!] 当前安装版 p8 首启曾报 Web RPC failure；隔离 source-mode 本地 Electron 已启动并实际验证顶部 5 入口。
- [x] 本地 source-mode 左侧 6 个通用 Agent 均逐个进入正确 preset/workspace；重启后六个 workspace 与 last-delivery 会话保留。安装版尚未更新复验。
- [ ] 原生对话/资料调用使用产品自己的 provider 配置；本轮未输入或保存 API Key，也未发模型请求。
- [ ] 验证关窗隐藏、退出确认取消后服务继续，以及批准退出后产品自有服务正常清理。
- [-] 官方连接手机入口生成授权 URL，并在同 profile 浏览器授权跳转后打开工作台；尚未用窄视口或实体手机验证，手机不能使用 `127.0.0.1`。

本次 source-mode GUI 摘要（含五入口路由、两场景交互、provider 表单可见性与未调用边界）见 `<LOCAL_EVIDENCE_ROOT>\desktop-package-contract\local-workbench-gui-acceptance-20261020.json`，截图见 `<LOCAL_EVIDENCE_ROOT>\visualizations\2026\10\18\01a14efa-72b3-7a63-8b40-a274f33629cf\tradeloom-local-workbench-final-20261020.jpg`。124 pass / 4 skip 的 shell/launcher 自动测试日志为 `<LOCAL_EVIDENCE_ROOT>\desktop-package-contract\framework-suite-candidate7-20261020-01.log`；自动化与 GUI 手动验收分别记录。

源码开发时，先停止自己的 TradeLoom 开发实例，再同步源码 bundle 并重新启动。仅当 source runtime 已通过当前 patch lock/receipt 校验并完成官方 development preparation 后才适用；同步命令必须明确传入该已准备版本的绝对路径。这只适用于 source-mode 开发副本，不能用于已安装用户资源，也不代表本机默认 source runtime 已实机验收。场景配置与 DSH 动态 chunk 的修改入口见 [`packages/tradeloom-shell/README.md`](../packages/tradeloom-shell/README.md)：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-tradeloom.ps1 -DataRoot <EXTERNAL_RUNTIME_ROOT>\tradeloom-app-data
$env:TRADELOOM_DATA_ROOT = '<EXTERNAL_RUNTIME_ROOT>\tradeloom-app-data'
node .\apps\tradeloom-launcher\cli.mjs sync-dev-bundle --mode desktop --runtime '<已准备且符合当前lock/receipt的source-runtime绝对路径>'
powershell -ExecutionPolicy Bypass -File .\scripts\launch-tradeloom.ps1 -Mode desktop -DataRoot <EXTERNAL_RUNTIME_ROOT>\tradeloom-app-data
```

启动脚本使用它当前配置的默认 source runtime；只有默认路径正是上面同步所用的同一份已准备版本时才执行。若二者不一致，应使用现有开发环境中已验证的 source-mode 启动配置明确选用同一 runtime；本说明不提供对安装版资源或默认候选已验收的保证。
