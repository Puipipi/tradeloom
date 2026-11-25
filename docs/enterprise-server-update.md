# 更新已安装的企业服务

适用于同一 Windows 账号安装的 rc.15 及其后续兼容版本。仅支持发行说明明确声明向后兼容的 Django migration；不升级 Python/PostgreSQL 运行库。替换 ZIP 或 GUI 不会替换 DataRoot/app。

1. 将可信的新 Server 包完整解压到 DataRoot 外。关闭该安装的 GUI，停止其他终端的启动操作。
2. 使用原包 `Stop-EnterpriseServer.ps1 -DataRoot <目录>` 停止服务。
3. 从新包运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Update-EnterpriseServer.ps1 -DataRoot <目录>`。
4. 脚本拒绝运行中的服务、占用端口、路径归属不符或目录链接。它复制新应用到暂存区，保留旧应用与停止状态下的数据库副本，再调用既有 Start 执行 migrate 并健康检查。成功后用新包 GUI 管理原 DataRoot。

运行库、server-config.json、secrets、operations-vault、原数据库保留。更新备份 `DataRoot/upgrade-*` 含私密数据库，限制为当前 Windows 账号；不要上传或作为程序包分发。需为数据库副本预留空间。仅 GUI 启动器与更新脚本共享启动锁，命令行 Start 不共享；更新期间不要另行启动。

若更新或启动失败，脚本保留新代码，避免迁移后自动恢复旧代码。查看私有 logs 和 upgrade-*/state.txt；修复后从新包再次 Start。需要完全恢复时，先停止服务并确认对应端口空闲，将当前 app 和 postgres-data 移到另一个私有保留目录，再将同一个 upgrade-* 内的 app 与 postgres-data **成对复制**回 DataRoot，使用原包 Start。配置、密码库不回滚；若升级后产生新业务数据，应先由管理员决定恢复影响。保留备份直到验收完毕。

发行包需包含根 Update-EnterpriseServer.ps1、scripts/Update-EnterpriseServer.ps1 和本文，并纳入该包 role-manifest 文件哈希。

## 当前版本迁移

当前版本在 rc.15 的 0001–0003 基础上新增向后兼容的 0004_emailloginchallenge，用于邮箱验证码挑战，不删除或重建既有用户和业务表。隔离旧安装升级已验证原账号、密码哈希、业务行及数据库身份保留，配置和运行库保持不变；旧的未完成邮箱验证会话须重新登录。这不代表生产数据已验收；部署前仍应备份，并按本说明保留成对恢复资料。
