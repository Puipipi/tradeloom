# W17：主锁写失败清理（用户包 549 重做）

固定引擎 0.2.2-rc.1，源码补丁基底 ce00763。当前 K 累计未覆盖此问题：真实 Linux 文件大小限制令主锁 wx 打开成功、PID 写入 EFBIG 后，遗留空锁，后继调用超时。修复仅清理由本次成功 open 得到 handle 的主锁；不接管既存空锁、活进程锁或 takeover claim。

## 实现与旧包差异

withFileLock 使用 open(wx,0600)，显式 writeFile/finally close；取得 handle 后写入或 close 失败，删除本次主锁并抛错。未取得 handle 的错误继续原争用协议。前序 atomic-claim-write-failure 已导入 open，故删除旧549重复 import hunk，重生 rc1 精确行号，完整57项补丁链严格应用成功。day-gate-worker 同时观察真正 fs.open/fs.writeFile 的 EEXIST，保留午夜竞争测试，不修改预算产品。

## 命令与 golden

在项目根：`DSH_PREFIX=<独立完整候选prefix> node --test runtime/tests/atomic-claim-write-failure.test.mjs runtime/tests/atomic-lock-write-failure.test.mjs`。

`node --test runtime/media/dsh-media/test/budget-day-gate.test.js runtime/media/dsh-media/test/budget-ledger.test.js`（node_modules须解析实际候选prefix）。

新主锁5案基线2失败3通过，候选5通过；原claim7案通过；媒体预算26/26。真实EFBIG由只影响child的ulimit触发，stdout为pipe，无模拟I/O，不真实等待。golden：EFBIG后 lock=ENOENT、operation=0；后继成功一次；既存活锁和空legacy锁字节不变。

完整K前置后 atomic模块 SHA256：92b9d32bd271d1931bfff55a5d46996cbb691225ee911ee7f1483f35ae0916d4；候选000b8994abcbec4e01b2b714fe8c2a37e61670c52e7d3acaf40ec8d39f484dc7。生成方法：从官方rc1按文件名字典序应用已审前置diff，改主锁循环，用Python difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js',tofile='b/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')生成vendor diff。源码交付用git diff相对ce索引导出；pins由本机按最终顺序统一录制，本包不改pins。

## 边界与本机步骤

close失败可覆盖write错误，rm失败可再覆盖；不承诺所有清理失败均成功删锁。SIGKILL无法执行cleanup，不解决claim接管协议。非Linux真实ulimit案显式skip，不冒称跨平台验证。

本机先应用最终rc1累计并录pins/构建，运行以上命令；Android设备上验证配置编辑及媒体预算正常保存和并发不重复提交。不要在真实profile施加ulimit或写坏锁；故障注入只在一次性Host目录。Android未编译、PRoot/真机未执行、没有NDK，无UI改动。
