# Windows Electron 桌面版部署

适用于团队日常使用的 Windows x64 Electron 全量包。下载入口是 [Stage 6.17 发布页](https://github.com/Puipipi/tradeloom/releases/tag/stage6.17-windows-x64)，文件为 `TradeLoom-stage6.17-Windows-x64-full.zip` 和 `SHA256SUMS.txt`。不要用源码仓库、Django 网页或旧 R76 页面替代。

## 下载、校验、启动

1. 在发布页下载完整 ZIP 和 `SHA256SUMS.txt`，放在同一个临时目录。
2. 打开 PowerShell，切换到下载目录。运行以下命令；校验不匹配时不要解压或启动：

   ```powershell
   $zipName = 'TradeLoom-stage6.17-Windows-x64-full.zip'
   $line = Get-Content -LiteralPath '.\SHA256SUMS.txt' |
     Where-Object { $_ -match ('\s\*?' + [regex]::Escape($zipName) + '$') } |
     Select-Object -First 1
   if (-not $line) { throw "SHA256SUMS.txt 中找不到 $zipName" }
   $expected = ($line.Trim() -split '\s+')[0]
   $actual = (Get-FileHash -LiteralPath ".\$zipName" -Algorithm SHA256).Hash
   if ($actual -ine $expected) { throw 'SHA-256 不匹配，请重新下载。' }
   'SHA-256 校验通过'
   ```

   只以同一 Release 提供的 `SHA256SUMS.txt` 为校验依据。
3. 将整个 ZIP 解压到一个短、可写的目录，例如 `C:\Apps\TradeLoom`。不要只复制 exe，也不要在 ZIP 压缩包内直接运行。
4. 双击 `program\启动工作台.exe`。首次启动按应用提示完成必要的本机网络选择。

启动成功时应看到 Electron 窗口标题**「织贸工作台」**以及包含业务入口的完整工作台。仓库中的 TradeWeave 是同一项目 Django 业务网页的显示名称；单独打开浏览器中的 Django「产品资料」页，不表示 Electron 桌面版已经启动。

## 外部服务和配置

- 安装包包含桌面应用及其随包运行环境，不需要另外安装 Python、Node、PostgreSQL 或 Django。
- ERPNext 是独立外部服务；此包不包含 ERPNext 服务实例。使用 ERP 功能前需由团队提供并单独配置服务。
- 模型提供方账号、凭据和可用网络也由用户单独配置。安装包不附带个人账号或密钥。

## 用户数据与升级

Stage 6.17 的 `program\launcher.json` 将 profile 路径设为 `profile-data-f630-s6-20261122-17`，相对于 `program` 的父目录。因此解压后的布局为：

```text
<解压目录>/
  program/启动工作台.exe
  profile-data-f630-s6-20261122-17/   # 首次启动时由程序使用
```

该包不会自动读取 `%LOCALAPPDATA%\TradeLoom` 或旧版本目录中的 profile、数据库和设置。换版本时先退出应用，将新完整包解压到一个新的目录，再从新目录启动；保留旧程序目录和旧数据目录，直到团队明确完成需要的数据迁移并确认新版本结果。不要把旧 `profile-data-*` 目录改名为本包配置的目录，也不要把新旧程序解压到同一个目录来强行共用 dataRoot。当前没有自动迁移承诺。

首次安装和升级均使用完整包；README 中列出的 R76、R75 与 desktop16 仅为历史验证记录，不是本版安装来源。

## 源码开发

源码入口是 [GitHub 仓库](https://github.com/Puipipi/tradeloom)。克隆源码不会安装桌面运行环境、配置外部服务或启动 Electron。源码开发请按[快速开始](quick-start.md)和[运行时准备与升级](upgrade-harness.md)执行；这些步骤与团队下载安装完整 Windows 包的路径不同。
