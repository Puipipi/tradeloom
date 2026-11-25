# W17：显式卸载后拒绝晚到 domain（用户包 537 重做）

固定引擎0.2.2-rc.1，源码补丁基底ce00763。当前K仍可复现三个实际Cordis/JSON后端泄漏：backend.open、loadAll或backupRecord挂起期间卸载domain插件，disposer已完成closeAll后，晚到open仍发布domain并保留unit。

## 修改与旧包回归处理

所有await完成之后、构造/发布DomainImpl之前调用真实 `this.ctx.fiber.assertActive()`；现有catch关闭unit、清reserved、传播INACTIVE_EFFECT。保留活facility显式closeAll后可reopen，不永久设置closed，不扩大成重启卸载协议。

旧537曾使title-cache三个手写context fixture缺fiber失败。本次显式给它们真实Cordis Context的fiber并清理；不在产品加可选链逃避合同，不删断言。原K对summaryKeys和deleteMany测试变更不由本包重复携带，组合测试以K原文件加本包局部hunk验证。

## 命令、golden和结果

`DSH_PREFIX=<候选prefix> node --test runtime/tests/storage-domain-owner.test.mjs`：基线3失败2通过，候选5/5。三个gate的golden均close=1、retired-domains=0、retained-unit=false、reserved=0，共享backend及无关unit仍存活；替代插件可重新open。原IO异常保持原对象。

受影响门禁：workspace-lifecycle、deletion-durability、runtime-upgrade-sessions-schedule，加两项原子锁模块合计25/25；title-cache-regression通过、title-cache-stat-regression8/8、title-cache-scale两种500条路径及overlap断言通过。未用真实等待。

逐条运行：`node runtime/tests/title-cache-regression.mjs <prefix>`、`node runtime/tests/title-cache-stat-regression.mjs <prefix>`、`node runtime/tests/title-cache-scale.mjs <prefix>`。升级测试还需DSH_OLD_PREFIX=<只读rc4完整原补丁prefix>。

完整K前置后domain模块SHA256：516caad9c0dd0c67c9785eb95490b84f459eaa41e818e41a5b3c4ae8917b79d8；候选a50f853f9cc1d4d4d2eea6c4f21498ef604ef11ae3131bc41e21189fc5f4483a。生成方法：官方rc1按字典序叠加已审前置，新增检查后用Python difflib.unified_diff生成对应a/b node_modules路径；git diff相对ce索引导出源码补丁。57项严格链通过，测试两个生产文件与严格链输出逐字节相同。本包不改pins，最终由本机录制。

## 范围和本机步骤

保证显式plugin.dispose后的inactive fiber；不宣称覆盖保留uid的restart/_unload，也不改变caller负责关闭handle的公共合同。三gate是真实Cordis和JSONbackend，只有I/O完成位置由测试gate控制，不冒称设备压力结果。

本机应用最终累计、录pins并构建后跑上述模块；一次性profile反复启停storage-domain相关插件，检查正常数据读取和重新挂载，无晚到domain残留。不得在用户唯一数据上做破坏性故障。Android未编译、PRoot/真机未执行、不装NDK，无UI改动。
