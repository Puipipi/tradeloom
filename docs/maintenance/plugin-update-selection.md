# 非 HMR bundle 更新保留已保存的选择

Refs W17-B。适用于 DSH 0.2.2-rc.1 的公开 PluginManager.updateBundle 非 HMR 覆盖安装路径。

更新版本不构成新的启用请求。registry 检查期间其它公开 setBundleEnabled 调用已成功保存的选择，应由随后覆盖安装保留。未发生选择修改时，原启用 bundle 仍启用，原禁用 bundle 仍禁用。

## 原实现与修改

updateBundle 在 registry 检查前读取 bundle.enabled，检查后把旧值传给 installBundle。change 的 profile/package.json 文件锁覆盖实际安装，却没有覆盖前面的 registry 检查。因此 checking 期间成功禁用后，旧 enabled:true 会再次 selectBundle(name,true)。

非 HMR 覆盖安装不先移除 bundle，也没有改变选择的必要。本修改令此分支调用内部 installTarget(true)，只为内部 options 添加 preserveSelection 标记。installBundle 在既有 change 锁内、configure 应用阶段读取最新磁盘选择：仍启用则继续调用原 selectBundle(name,true) 的平台、兼容与bundle配置完整检查，已禁用则不重新启用。HMR 的 installTarget() 不传标记，失败恢复也不变。普通 installBundle 不传标记，原行为不变。该内部标记不进入公开类型、RPC schema或返回值。

## 返回字段

InstallBundleOptions.enabled 是此次安装是否请求激活，不是最终库存状态。ChangeResult.enabled 维持原来随安装请求记录的可选布尔字段；更新期间其它操作可改变最终选择，因此它不是最终库存状态。最终启用状态应读取 listBundles。官方 Web 的更新流程会重新读取 inventory；本轮未改 Web 或 App，不声称修复 App 市场的其它更新路径。

保留既有 application/restart-required、packageResult、错误与回滚语义。版本检查并发、HMR remove/install/restore竞争不在此次范围内；HMR 源码路径保持不变，未动态验证。

## 验证

runtime/tests/plugin-update-selection.test.mjs 通过公共 manager、真实 pnpm、自有 localhost registry 与普通 response gate 验证六案：初始开/关不变、checking期间成功关闭、checking期间成功打开，以及不支持平台的新版本在已启用时仍拒绝、在禁用时仍可安装而不激活。无私有方法替换、sleep调度或真实账号。初始安装目录是测试准备的有效 bundle，升级由真实 pnpm 执行；空 bundle patch 只验证持久选择，不证明插件实际加载效果。

会改 runtimeVersion。Android 未编译。设备上的正式启停、重启后选择与 HMR 仍由本机验证。
