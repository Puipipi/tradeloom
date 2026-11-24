# 更新已安装的企业服务

适用于同一 Windows 账号安装的 rc.15 及其后续兼容版本。仅支持发行说明明确声明向后兼容的 Django migration；不升级 Python/PostgreSQL 运行库。替换 ZIP 或 GUI 不会替换 DataRoot/app。

1. 将可信的新 Server 包完整解压到 DataRoot 外。关闭该安装的 GUI，停止其他终端的启动操作。
2. 使用原包 `Stop-EnterpriseServer.ps1 -DataRoot <目录>` 停止服务。
3. 从新包运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Update-EnterpriseServer.ps1 -DataRoot <目录>`。
4. 脚本拒绝运行中的服务、占用端口、路径归属不符或目录链接。它复制新应用到暂存区，保留旧应用与停止状态下的数据库副本，再调用既有 Start 执行 migrate 并健康检查。成功后用新包 GUI 管理原 DataRoot。

运行库、server-config.json、secrets、operations-vault、原数据库保留。更新备份 `DataRoot/upgrade-*` 含私密数据库，限制为当前 Windows 账号；不要上传或作为程序包分发。需为数据库副本预留空间。仅 GUI 启动器与更新脚本共享启动锁，命令行 Start 不共享；更新期间不要另行启动。

若更新或启动失败，脚本保留新代码，避免迁移后自动恢复旧代码。查看私有 logs 和 upgrade-*/state.txt；修复后从新包再次 Start。需要完全恢复时，先停止服务并确认对应端口空闲，将当前 app 和 postgres-data 移到另一个私有保留目录，再将同一个 upgrade-* 内的 app 与 postgres-data **成对复制**回 DataRoot，使用原包 Start。配置、密码库不回滚；若升级后产生新业务数据，应先由管理员决定恢复影响。保留备份直到验收完毕。

发行包需包含根 Update-EnterpriseServer.ps1、scripts/Update-EnterpriseServer.ps1 和本文，并纳入该包 role-manifest 文件哈希。

## 隔离验证（2026-11-24）

使用只读 rc.15 Server 发行包的 Python、Django 包和 PostgreSQL 运行库，在独立合成 DataRoot 初始化空白服务（HTTP 28431 / PG 57431），未接触真实安装。

- 正常路径：原包安装、停止；新包增加合成向后兼容 CreateModel migration；更新后日志显示 `0004_upgrade_synthetic_probe... OK`，既有 Start 健康检查通过。server-config.json 哈希未变，旧 app 与冷数据库副本保留。
- 拒绝路径：服务运行时再次更新，拒绝且不停止现有进程；配置 app_root 指向非归属路径时拒绝。
- 失败路径：下一条合成 migration 主动抛错；脚本报错并保留新 app，没有自动恢复旧代码。server-config.json 和 service-secrets.json 哈希均未变；测试结束已停止隔离服务。
- 证据在本机 `D:/tl618-workflow-editor-delivery/enterprise-upgrade-qa/result.log`、`failure-result.log` 与同目录验证脚本。该目录含合成数据库，不作为发行内容。未验证生产数据迁移或正式 OTP migration；最终发行版需针对其实际 migration 再验收。
