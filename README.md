# TradeLoom desktop16 portable 打包材料

这里提供便携启动器、打包/验证脚本和身份/许可清单，供审阅分发产物。它不是原desktop16全部源码工作树，也不声称恢复了精确25日23:00的完整历史源码。

## 产物身份

- Windows x64，unsigned unpackaged portable。
- 原desktop16上游锚点：`1f81c047fc48fa190a683e469daa699857e9afe8`。
- desktop main SHA256：`d42278d60092ad90e96fdd8df18fa861722dedbb7940b22bbfe31bc91c560373`。
- desktop-host SHA256：`61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e`。
- 冻结A34工作台hashTree：`ea6a7e30985d360099d39af9ca9035d718bf46d1681ff0bd7f05f10e0ccf2eca`。
- Electron44.7.0 engine inventory digest：`142d28396b3abe2ead4238c85c2c96c7718135eb0bc083956dc198a51277e3fa`。

只有上面两个compiled文件与A34、Electron独立清单具有对应锚点比对证据。其他必需依赖从已保留desktop16实体树的生产声明闭包物化；没有为此重编译产品，也没有把历史完整可复建性说成已证明。

## 构建输入与步骤

构建机器需要Node24+和Python；运行朋友下载的包不需要安装它们。设置 `DESKTOP16_SOURCE` 为已核desktop16运行树、`DESKTOP16_BACKUP` 为分层保全输入目录。所有脚本放在新的隔离目录；输出必须尚不存在。

```powershell
$env:DESKTOP16_SOURCE = '<audited desktop16 runtime directory>'
$env:DESKTOP16_BACKUP = '<layered desktop16 backup directory>'
node ./inspect-closure.mjs
node ./build-portable.mjs
node ./verify-portable.mjs
# 审阅preflight-verification.json，仅对已确认的构建注释路径进行去标识。
node ./redact-build-comments.mjs
node ./verify-portable.mjs
python -X utf8 ./archive-portable.py
python -X utf8 ./verify-clean-extract.py
```

构建器按生产/peer/已安装optional依赖闭包复制普通文件，保留必要多版本解析并逐边校验，不复制整个pnpm store；workspace包使用files白名单。不执行未知安装脚本，不复制profile、数据库、登录、会话、日志、`.env`或真实业务数据。templates包含独立启动入口和用户说明。第三方许可证保留在原包目录中，GNU LGPL/GPL标准文本来自SPDX license-list-data。

最终SHA256SUMS和file-manifest不互相自引用：file-manifest列出普通payload，SHA256SUMS还校验file-manifest；外部ZIP SHA256绑定整个压缩包。

## 初始化和测试边界

cmd只调用随包Node并清除NODE_OPTIONS/NODE_PATH；bootstrap用白名单child环境、loopback动态端口、新owned数据根，官方initProfile、冻结A34本地profile副本及精确ownership marker。实际Electron路径按desktop16固定main的LOCALAPPDATA setPath规则隔离。

真实无GUIHost已验证23个只读路由200：7场景/6角色、角色能力与配置、场景布局、profile、原生及shell实际广告的revision资源、4个shell懒加载chunk。首次GUI的启动配置缺漏已在便携bootstrap补齐；遵照用户后续要求，最终修正后没有再次抢占窗口进行GUI视觉复验，不能称最终完整视觉验收已做。

本包未包含Django/ERPNext/Postgres/业务数据/模型账号；Office高级转换还可能需要系统VC++ x64 runtime。已有desktop16产品问题保留；只在便携层修运行依赖和首次初始化合同。
