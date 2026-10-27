# DSH 固定版本准备与升级检查

本文件描述可复制的源码准备流程。它尚未作为 fresh-clone bootstrap 完整实测。`scripts/dsh/prepare-runtime.ps1` 克隆锁定源码、应用仓库中的版本化补丁并写入 ownership marker；它不安装依赖、不编译、不生成桌面 build receipt。`scripts/dsh/check-upstream.ps1` 检查锁定来源、patch target 和兼容性；通过检查本身不代表 runtime 可以启动。

## 固定版本和外部目录

权威版本记录在 [`integrations/dsh/patches/patches.lock.json`](../integrations/dsh/patches/patches.lock.json)：上游为 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，当前候选 `0.2.1-rc.3`，commit `1f81c047fc48fa190a683e469daa699857e9afe8`。准备脚本会核对 `LICENSE` SHA-256 `EBB4F09972AEE8608BE255DEBAF78451A68E95C290F55C240DEC2ECFA16EA6BE`、13 个按锁定顺序应用的 patch 文件，以及各 patch target 的基准/目标 hash。RC3 原生 sidebar 已提供 More/actions 菜单；未被 TradeLoom 插件消费且当前 shell 测试禁止注册的旧 `sidebar.agents` 补丁不再进入新序列。升级时选新版本目录，不能覆盖已有发行目录。

脚本按固定 sibling 布局查找路径。假设产品仓库位于 `<workspace>\tradeloom`，当前锁定的只读上游 checkout 应位于 `<workspace>\workspace\research\05-交付构建\references\deepseek-harness-v0.2.1-rc.3-readonly`，准备后的 runtime 应位于 `<workspace>\workspace\runtime\tradeloom-harness\releases\<version>`。脚本会拒绝错误根目录、reparse/link 路径和已存在的目标目录。若你的仓库布局不同，先调整工作区布局；不要绕过这些路径检查。

## 准备 pinned 源码及 patched runtime

从产品仓库根目录打开 PowerShell。以下命令会创建上游 checkout，并固定在 lock 中的 commit；`prepare-runtime.ps1` 随后从该只读 checkout 建立新的发行目录：

```powershell
$workspaceRoot = Split-Path -Parent (Resolve-Path .)
$referenceParent = Join-Path $workspaceRoot 'workspace\research\05-交付构建\references'
$reference = Join-Path $referenceParent 'deepseek-harness-v0.2.1-rc.3-readonly'
$releaseRoot = Join-Path $workspaceRoot 'workspace\runtime\tradeloom-harness\releases'
$runtime = Join-Path $releaseRoot '0.2.1-rc.3-tradeloom-desktop-10'
$pinnedCommit = '1f81c047fc48fa190a683e469daa699857e9afe8'

New-Item -ItemType Directory -Force -Path $referenceParent, $releaseRoot | Out-Null
git clone https://github.com/deepseek-ai/deepseek-harness.git $reference
if ($LASTEXITCODE -ne 0) { throw '上游 clone 失败；检查网络和目标目录后再重试。' }
git -C $reference checkout --detach $pinnedCommit
if ($LASTEXITCODE -ne 0) { throw '固定上游 commit 失败。' }
if ((git -C $reference rev-parse HEAD).Trim() -ne $pinnedCommit) { throw '上游 commit 不匹配。' }

powershell -ExecutionPolicy Bypass -File .\scripts\dsh\prepare-runtime.ps1 -ReferencePath $reference -RuntimePath $runtime
powershell -ExecutionPolicy Bypass -File .\scripts\dsh\check-upstream.ps1 -RuntimePath $runtime
```

准备脚本应输出 JSON `status: prepared`；核对脚本应输出 `status: compatible`。如目标目录已存在，脚本会拒绝覆盖；为升级选新的 version 目录并重新检查，保留旧目录便于回退。也可手动检查 marker：

```powershell
$expectedMarker = "tradeloom-dsh-runtime-v1`n$($pinnedCommit)`n"
$actualMarker = Get-Content -LiteralPath (Join-Path $runtime '.tradeloom-runtime-owned') -Raw
if ($actualMarker -ne $expectedMarker) { throw 'runtime ownership marker 或 pinned commit 不匹配。' }
```

对已经由受控 builder 编译并写入 receipt 的目录，可用产品 launcher 的同一校验函数检查 receipt 与两个编译文件 hash。该命令只验证，不会编译、写入或修复 receipt：

```powershell
$priorRuntime = $env:TRADELOOM_DSH_RUNTIME
try {
  $env:TRADELOOM_DSH_RUNTIME = $runtime
  $receiptCheck = @'
import { readFile } from 'node:fs/promises';
import { verifyDesktopBuildReceipt } from './apps/tradeloom-launcher/desktop-receipt.mjs';
const runtime = process.env.TRADELOOM_DSH_RUNTIME;
const lock = JSON.parse(await readFile('./integrations/dsh/patches/patches.lock.json', 'utf8'));
await verifyDesktopBuildReceipt(runtime, lock);
console.log('desktop build receipt verified');
'@
  $receiptCheck | node --input-type=module
  if ($LASTEXITCODE -ne 0) { throw 'desktop build receipt 校验失败。' }
} finally {
  if ($null -eq $priorRuntime) { Remove-Item Env:TRADELOOM_DSH_RUNTIME -ErrorAction SilentlyContinue }
  else { $env:TRADELOOM_DSH_RUNTIME = $priorRuntime }
}
```

这些命令展示受支持路径和检查步骤；fresh clone 上的整套准备尚未端到端验收。不要把 `status: compatible` 解释成安装完成或 GUI 可运行。

## 安装/编译与 launcher 启动门槛

RC3 上游 `package.json` 要求 Node.js `^22.19.0 || >=24.0.0` 和 pnpm `11.28.5`。源码定义的构建入口为 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm run build:lib`、`pnpm run build:web`、`pnpm run build:desktop`。候选 10 已以冻结 lockfile 和本机缓存完成 install 及三个官方 build 子命令，真实退出码记录在本机外置 evidence 目录；若构建后续版本，应从 runtime 根目录运行：

```powershell
Push-Location $runtime
try {
  pnpm install --frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败。' }
  pnpm run build:lib
  if ($LASTEXITCODE -ne 0) { throw 'build:lib 失败。' }
  pnpm run build:web
  if ($LASTEXITCODE -ne 0) { throw 'build:web 失败。' }
  pnpm run build:desktop
  if ($LASTEXITCODE -ne 0) { throw 'build:desktop 失败。' }
} finally { Pop-Location }
```

这些上游命令不由 `prepare-runtime.ps1` 调用，也没有被本文件包装成一键安装器；文档未声称它们在 fresh clone 上实测成功。编译产物还须满足发行自身的依赖准备要求。

source-mode desktop launcher 还要求发行根有普通 `.tradeloom-runtime-owned` marker、`apps/desktop/lib/main.js`、`apps/desktop-host/lib/index.js`、Electron 运行文件，以及 `.tradeloom-desktop-build-receipt.json`。receipt schema 为 1，记录 pinned source commit、marker、patch-set digest 和上述两个编译文件的 SHA-256。产品提供的 `apps/tradeloom-launcher/receipt-writer.mjs` 只接受外部 builder 报告的真实成功证据；它不是编译器，也不提供可用虚构 exit code 生成 receipt 的命令。不得手工伪造 receipt 来绕过启动校验。

仓库提供受控 builder，可依次复用上游 lib/web/desktop 构建、Primary Runtime 组装、descriptor 生成和官方 receipt writer。候选 10 的三个官方构建阶段均以退出码 0 完成，Primary Runtime 通过官方组装 API 准备；按用户要求未运行 Primary Runtime smoke，因此此候选没有 smoke 通过或 GUI 启动证据。普通启动脚本默认候选为 `0.2.1-rc.3-tradeloom-desktop-10`，但本轮尚未启动该 runtime；它不会自动升级 runtime。`-Runtime` 参数仍受信任 release 根目录、ownership marker、真实 build receipt、编译文件摘要、产品身份和 development project descriptor 校验。仅传入另一条路径或完成 `prepare-runtime.ps1` 不满足启动条件。严格单 pin 下，新 launcher 会拒绝 RC2 runtime8；回退须把旧 launcher/lock/patch 元数据与 runtime8 成对恢复，之后仍需执行对应的启动验证。仅保留旧目录不构成已验证回退。

## 升级原则

- 先阅读并更新 `integrations/dsh/patches/patches.lock.json` 与对应 patch；运行 `prepare-runtime.ps1` 创建新版本目录，再运行 `check-upstream.ps1`。校验失败时保留报告，不修改旧目录。
- 每个发行目录都应保留自己的 marker、编译产物和 build receipt。升级只切换到已独立构建并验证的目录；不把 profile/session 数据复制进源码仓库。
- source-mode 与 packaged-runtime 是不同部署合同。`docs/desktop-bootstrap.md` 中 Python 3.12.14 等要求只适用于 packaged runtime；source-mode Python 依赖见 `requirements-workbench.txt`。隔离 Django 全量回归用过 Python 3.14.5，但这不等于对所有 Python 版本的兼容承诺。
- 桌面菜单退出与普通窗口 X 隐藏是不同操作。运行实例使用自己的 DataRoot；不要对其他 DSH 实例调用 TradeLoom launcher 的停止脚本。

## 使用已经审阅的开发包

在多人同时修改源码的开发环境中，可向启动或同步入口显式传入 `--bundle-source <绝对目录路径>`，使用已审阅的冻结 package 及其文件清单。启动器仍执行原有 native receipt、目标目录、bundle SHA 与 profile 一致性校验；该参数不允许覆盖不匹配的版本化文件。省略参数时继续使用仓库源码目录。不要把未完成的共享后端源码覆盖到冻结包中。
