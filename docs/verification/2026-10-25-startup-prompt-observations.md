# 启动权限窗口：本会话已见事实

- 本会话使用普通 `Start-Process -WindowStyle Hidden` 启动 Node 的官方workbench runner；未使用 `-Verb RunAs`、runas.exe、管理员PowerShell或提权入口。
- 未修改Windows防火墙、UAC、注册表、保护/通知或网络默认值；防火墙窗口均交用户手动选择允许/取消。
- desktop16第一次启动的实际截图标题为“Windows 安全中心”，正文“是否要允许公共网络和专用网络访问此应用？”，应用Electron，发布者GitHub, Inc.；不是本会话观察到的UAC设备更改窗口。
- 实际启动程序由版本化目录desktop15切到desktop16；CUA inventory明确显示相应 `.pnpm/electron@44.7.0_supports-color@9.4.0/node_modules/electron/dist/electron.exe`。二进制复用缓存SHA不变，程序绝对路径改变。该事实不单独证明所有历史提示的根因。
- 普通构建preflight的进程参数 `-ExecutionPolicy Bypass` 仅为该PowerShell进程的脚本执行策略；不是管理员启动。未修改系统ExecutionPolicy。
- 2026-10-25 21:08在用户明确同意后做同路径desktop16 stop/sync/start，只更新冻结host元数据与前端chunk，native receipt不变。是否再次出现防火墙窗口以本次GUI后续观察为准，不预先宣布不再弹窗。
- 协调会话后续转述用户已确认是防火墙提示，结束UAC方向猜测。稳定启动路径的宿主方案由后端提出，与frontend/launcher所有者对齐，不关闭LAN/手机能力、不加宽泛允许规则。

证据：workspace/runtime/tradeloom-harness/evidence/desktop16-deployment-20261025 中的 deploy16.mjs、start16.*、sync-binding16.mjs、restart16-binding.*；首次防火墙画面见本会话CUA工具记录。没有为追查权限额外重启，21:08重启用于已批准的功能部署和登录保留验收。
