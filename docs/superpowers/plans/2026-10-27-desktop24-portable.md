# Desktop24 Windows 完整便携包实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Windows x64 新解压路径可启动、可配置模型并具备业务与空数据库的 desktop24 便携包，保留 desktop16。

**Architecture:** 以 desktop24 已验 receipt 与冻结 shell 为输入，复用 `stage-desktop.mjs` 的 packaged schema 2 和 `installed-bootstrap.mjs` 的受管生命周期；参考 desktop16 便携包的依赖物化、ZIP 和干净解压验证机制。服务、DB 及 authority 由后端负责；总装不复制任何当前用户数据，也不将 UI-only 包冒充完整包。

**Tech Stack:** Windows x64、Electron 44.7.0、Node 24.21.0、pnpm 11.28.5、CPython 3.12.14、Django、PostgreSQL 17.11、Node test、Python zipfile。

**Spec:** 本次用户完整 Windows 便携包要求，及 `docs/desktop-bootstrap.md` 的 schema 2 资源接口。

## Global Constraints

- 使用 desktop24 receipt `305df33b648825454a928a99397b103aeb3f5a038933f84b13055049d7578064`、main `426f6706c6c080c3430fff5f8519cc0fd0e19366e9a969c1ff190c952b96bb04`、SDK34 lock `848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c`、33 patches；UI 安装树 现用基线 `8f7311e7343bccf43ee4b4ca557b6df467859e0b079e9e1604242ec00d89b48a`；便携 shell 在独立候选加两处端口适配，installed aggregate `e212822f57447838ea66264651f548d8dad604026a1d0e8cf433664628f52494`。
- 原作者 key、cookie、会话、数据库、日志、附件、profile、布局及既有 DataRoot 不入包；不停止或修改现用实例。模型使用者自行配置。
- 旧 desktop16 和旧 release 不覆盖；不创建新安装器架构。最终提交、上传和发布仅在明确授权及审查后进行。
- `stage-desktop.mjs:158-178` 的 Python 依赖合同和 runtime24 的 `primary-runtime/runtime.json` 均为 3.12.14；Node 24.21.0、pnpm 11.28.5。仍须逐文件证明实际 payload 与 manifest 匹配，不能仅凭版本标签；stage 当前锁定旧默认 lock 与仓库 shell，必须显式适配 SDK34 和冻结 shell 并测试。

## 文件与责任

- 总装：`apps/tradeloom-launcher/stage-desktop.mjs` 与 `apps/tradeloom-launcher/tests/stage-desktop.test.mjs`，增加仅经审核的显式 lock 和 shell 输入；不修改旧默认选择。
- 后端：`apps/tradeloom-launcher/installed-bootstrap.mjs`、`apps/tradeloom-launcher/tests/installed-bootstrap.test.mjs`、业务源码/迁移与 Python/PG payload 责任由后端承担，先审现有 schema 2 迁移、认证和端口合同。
- 总装证据：`workspace/release/desktop24-portable-20261027/` 的 `input-manifest.json`、新 builder/验证脚本、逐文件 manifest、ZIP 与 receipt；复制机制参照 `workspace/release/desktop16-portable-20261026/{build-portable.mjs,archive-portable.py,verify-portable.mjs,verify-clean-extract.py}`，不得原地运行旧脚本。
- 用户说明：新包内 `Start-TradeLoom.cmd`、README；明确首次配置、目标 schema、端口冲突和错误输出，不写用户秘密。

## Task 1：输入与版本闭合

- [ ] 对 runtime24 只读调用 `verifyDesktopBuildReceipt(runtime, lock34)`、`assertDesktopDevelopmentProjectReady`、`assertTradeLoomDesktopAppIdentity`，记录返回和原始 exit；核 main、descriptor、lock、33 patches 和 frozen shell 树 SHA。仅从 `integrations/dsh/desktop24-ui-bundle` 读取 51 声明文件，禁止从 52 文件当前源码树替代。
- [ ] 从 `apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime/runtime.json` 核 3.12.14 / 24.21.0 / 11.28.5，并将 Python、PG17.11 的公开 payload、manifest、逐文件 hash 和许可证交后端确认；任何解释器版本、ABI、依赖或版本合同不符立即停止，后端修合同或给同版本正式 payload，不能改 descriptor 字段伪装一致。
- [ ] 复核上游 LICENSE SHA `ebb4f09972aee8608be255debaF78451a68e95c290f55c240dec2ecfa16ea6be` 和 Dockview/QRCode LICENSE；连同依赖版权写许可索引。对最终输入重新清点；此前 637 源规则和排除 47 条 evidence、23 条已证 fake 测试凭据仅作历史线索，不能替代最终清单扫描。

## Task 2：后端 schema 2 合同

- [ ] 后端用 `node --test apps/tradeloom-launcher/tests/installed-bootstrap.test.mjs` 复验资源校验、首启 owned root、空 PG 初始化、迁移/失败清理和已有集群保护；首次全新 owned 独立 DB 按包内 schema 正常初始化，包含已审仅建表且依赖 0012 的 0013；现用 tradeloom_dev 保持仅 0012，不连接或迁移现用库。
- [ ] 验证当前实现固定 3088/3090/55432 与现用实例冲突时明确报错而不停止已有服务；若正式配置支持隔离端口，证明 Host/Django/PG 和 bridge 一致传递；若不支持，安排独立主机或经授权维护窗口，禁止自行换端口或掩盖冲突。
- [ ] 后端核对真实文件授权和 native authority 是否在包内闭合；无法验证则界面准确提示不可用，不把已验 Native run 当文件授权证明。

## Task 3：受控 stage 与依赖物化

- [ ] 在 `stage-desktop.test.mjs` 先添加：SDK34 锁/冻结 shell 被接受，旧默认不变，锁或 shell 单字节漂移拒绝，用户 profile 与仓库外私有目录不被读取；运行 `node --test apps/tradeloom-launcher/tests/stage-desktop.test.mjs` 保存失败后再最窄实现显式输入。使用官方 `verifyDesktopBuildReceipt`，不可构造新 receipt。
- [ ] 在全新 release 目录调用 `stage-desktop.mjs --mode packaged --runtime-path <已验runtime24> --stage-path <新stage> --python-payload-root <已验Python根> --python-manifest <Python manifest> --python-files-manifest <Python文件清单> --postgres-payload-root <已验PG根> --postgres-manifest <PG manifest> --postgres-files-manifest <PG文件清单>`，并传入经实现并测试的 SDK34 lock/冻结 shell 显式参数；保存完整参数、进程/exit、输入 SHA、schema 2 manifest。占位尖括号由 Task 1 核实后的绝对路径替换，未审核前不执行。
- [ ] 在新 builder 中复用 desktop16 的依赖闭包/碰撞检查和非 link 物化方式，验证每条依赖解析边；Electron/Node/pnpm/primary runtime、Django依赖、PG17及许可均来自已核公共输入。不得复制原 desktop16 backup 中的 profile 或把旧 UI-only 包当业务包；输出 `build-identity.json` 和逐文件清单。

## Task 4：干净提取与实际验收

- [ ] ZIP 只包含相对安全路径和普通文件；运行新 archive 脚本生成逐文件 SHA/大小、`SHA256SUMS.txt`、许可索引，再用 `zipfile.testzip()` 校 CRC 并记录 ZIP SHA256；拒绝 link、绝对路径、`..` 和私人数据。新清单重新扫描密钥/敏感路径，未覆盖项明确记录。
- [ ] 在包含空格的新解压路径用新 `Start-TradeLoom.cmd --check`、系统 PATH 与无继承私有 DSH home 验证资源闭合和可读错误。`verify-clean-extract.py` 风格校验每个提取文件 SHA；这是预检，不称 GUI 通过。
- [ ] 获得独立测试环境或维护许可后，双击 Start：首启创建独立 owned DataRoot 与空 DB，仅迁至 Task 2 审定 schema；测试合成 profile，在 GUI 创建业务对象、读回、正常应用菜单退出、重启再读回。验证新路径、未配置模型提示及失败可读；不得使用现有工作 profile/会话/附件，也不上传文件或发送真实业务数据。记录 PID、端口、截图来源和实际退出，保留失败。

## Task 5：审查与发布

- [ ] 将 final 文件清单、license、CRC/SHA、清洁解压、GUI/DB 实测和秘密扫描交主控及后端审查；对尚未验证的文件授权、真实网页及 51/166/88 保留边界。
- [ ] 确认 GitHub 目标 PRIVATE、新 release 名称/资产及不覆盖 desktop16；只在用户授权且策略允许后创建新 release，上传最终 ZIP 和 SHA256SUMS，下载核对 SHA。若任一关口未通过，保留证据，不发布。

## 字节冻结及 Git 交付

当前 `git check-attr text eol` 对 `integrations/dsh/prospective/desktop24-exit/patches.prospective.lock.json` 和 `integrations/dsh/desktop24-ui-bundle/proxy.js` 均为 unspecified，现有 `.gitattributes` 只覆盖 `integrations/dsh/patches/*.patch`。提交前由代码责任人新增最窄规则（不改变全局行尾）：

```gitattributes
integrations/dsh/prospective/desktop24-exit/** -text
integrations/dsh/desktop24-ui-bundle/** -text
```

在新 clone 与最终 ZIP 解压后分别核对 lock `848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c`、order `a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c`、33 patch 的 lock 逐项 hash 和 shell aggregate `8f7311e7343bccf43ee4b4ca557b6df467859e0b079e9e1604242ec00d89b48a`；任一漂移停止。源码 commit 与历史分叉由主控最终审查，不使用 `git add -A`、force push 或切换他人分支。

阶段记录：Task 1 版本/输入只读核对、Task 3 packaged stage-1（exit 0）和外层静态物料准备已完成；production closure 官方 descriptor 已验证。electron-builder hooks、实际 dir 打包、干净解压与 GUI/空库验收仍未执行。新 portable shell 使用 `integrations/dsh/desktop24-portable-ui-bundle`、aggregate e212822f57447838ea66264651f548d8dad604026a1d0e8cf433664628f52494；现用 8f 保留。
