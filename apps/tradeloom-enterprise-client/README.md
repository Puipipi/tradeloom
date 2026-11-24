# TradeLoom 企业客户端

这是独立 Electron 客户端，只连接单独运行的 TradeLoom Django 企业服务器。它不调用原工作台启动器，不启动本机 PostgreSQL、Django 或 DSH，也不要求安装 Python。

## Windows 启动

1. 如需从源码运行，在此目录执行 `npm install`，Electron 版本固定为 45.4.1。
2. 使用仓库中的 `scripts/package-enterprise-client.ps1` 生成 Windows 文件夹包，将 `dist/TradeLoom 企业服务器客户端` 整个目录交付，双击其中的 `TradeLoom 企业服务器客户端.exe` 即可。
3. 输入企业提供的服务器地址，例如 `https://trade.example.com`。地址保存在本机 Electron userData 的 `enterprise-client.json`；企业密码不会由客户端保存。
4. 客户端打开服务器同源 `/enterprise/`。未登录时 Django 继续跳转到同源 `/accounts/login/`。使用企业已有账号登录，数据和权限由该服务器处理。

服务器地址必须为 HTTPS；只允许 `http://127.0.0.1` 或 `http://[::1]` 用于受控本机开发调试。输入只接受 origin（协议、主机名和可选端口），不接受 URL 账号、路径、查询参数或片段。

本地设置窗口拥有最小 preload API。远程企业页面不设置 preload，启用 `sandbox` 和 `contextIsolation`，禁用 `nodeIntegration`；只允许同源请求、跳转，不允许打开外部窗口。网页登录使用独立、按服务器 origin 隔离的持久 Electron session，不与 DSH/桌面工作台登录共享。

## 源码检查

```powershell
node --test apps/tradeloom-enterprise-client/tests/*.test.cjs
```

合成登录 smoke 使用 Electron 45.4.1 运行 `tests/electron-smoke.cjs`，传入 `--smoke-enterprise`、`--server-origin`、`--credentials-file` 和 `--result-file`；账号凭据只从隔离文件读取，不作为命令参数或输出。
