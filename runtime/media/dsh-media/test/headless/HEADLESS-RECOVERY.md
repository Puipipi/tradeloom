# M0 headless · rc4 运行说明

两条真实本地mock会话（参数头一条、普通中文一条）曾在下述环境实际通过；整体验证范围与未覆盖项见../../VERIFICATION.md。测试插件plugin.mjs只在headless里加载，不装入生产profile。

重跑前注意：run.mjs固定了十个生产文件的SHA-256。录制之后src/header.js、src/config.js和package.json已修改（参数头按定稿规格对齐等），与pin不符，runner会拒绝运行。须先复核这些改动并更新pin，新结果按新身份记录；原有两条记录对应的是改动前的文件。

## 可重复环境

DSH来自一个独立的npm测试prefix。run.mjs要求该prefix根部package-lock.json的SHA-256为8f1f2d0363e8c481ef1d163be1f263ba8089b378f9a2f99dd02707ce571fb68c（EXPECTED_TEST_LOCK）。这份锁以runtime/locks/dsh-0.2.1-rc.4/package-lock.json为基准，保留其全部628个非根记录，只追加image-size2.0.2与@deepseek-ai/dsh-llm-mock-server0.2.1-rc.4（直接依赖见dependencies.json）。测试prefix不应用runtime/patches，结论针对原始npm rc4，不代表打过补丁的移动rootfs。

缺少的输入：这份测试锁及其package.json没有入库。没有它，run.mjs的锁校验不会通过；自建时按上面的规则从基准锁生成，把EXPECTED_TEST_LOCK换成新锁的SHA，并按新身份记录结果。

建立新的隔离prefix，将package.json和package-lock.json放在prefix根，npm ci --ignore-scripts --no-audit --no-fund（有缓存可加--offline）。不得用npm install重新解算并默许传递依赖升级。把产品目录node_modules指向此prefix/node_modules；目标不存在时才建立符号链接，不覆盖已有依赖树。不在test/headless建立独立node_modules。

从runtime/media/dsh-media执行：

    TZ=Asia/Shanghai node --test test/*.test.js
    TZ=Asia/Shanghai node test/headless/run.mjs --out /absolute/new-private-result

out必须是不存在的绝对路径，父目录已存在。runner拒绝覆盖；期望Node22.19以上22.x或24以上，测试实际使用v24.22.1。关键引擎文件、精确锁、十个生产文件、父/子模块实例均会核对。若引擎已加补丁，不可删pin过测，先复核实际后像并为该树另定identity。

## 真正执行的路径

公开CLI dsh headless --patch <file> --json <task>，各例独立home/工作区。恢复credentials-local与本次固定假凭据；官方llm-deepseek-api-key只连接本地官方mock。脚本固定tool_call_success→success，不是真实模型决策。production Config仍使用HTTPS占位，只有test plugin进程内generate seam路由到本次固定loopback image endpoint。服务地址和transport不来自模型参数或用户设置。

第一次使用formatter生成头；第二次普通中文须parseGenerationMessage=null。两条记录录于参数头语法定稿之前，证明的是当时候选语法下的真实会话执行链；定稿语法由test/header.test.js对共享golden校验，headless尚未按定稿重录。

Session post-commit事件逐个原样JSON序列化，seq从0连续。flush采用排队checkpoint以免在其他observer的同步flush内抢先检查；保证已捕获至少所请求前缀。runtime-context的user/message保留，但只将source.kind=user计为真实用户输入。物理V4日志header后的全部事件与捕获逐对象相等。

正常成功路径必须exit0、close已观察、turn/end completed、一个用户输入/工具调用/成功media结果、正确请求体、原件字节/尺寸、Host索引和Session一致，且假凭据不进事件/stdout/stderr/index。未满足任一断言即失败，不创建成功summary。

## 产物及含义

- stdout.projection.jsonl仅为CLI展示投影，不作为App原始fixture。
- capture/session-events.jsonl是完整逻辑事件；capture-receipt与loaded-modules记录身份。
- durable-session.v4.jsonl原样复制物理文件，已对齐全部逻辑事件。
- wire-audit只记请求体和mock行为，不记认证header。
- verified/summary只在本例/两例全部断言成功后出现；failure/cleanup/process保留真实失败和关闭事实。
- 实际原件保留在独立工作区；fixture内的绝对路径不重写，消费测试应提供自己的文件provider映射。
- live_image.jsonl和live_image_plain.jsonl分别取两条Session的原始逻辑日志，不能拼接；没有手写媒体事件。

两条首要记录各含23个事件、2次本地LLM请求、1次本地图片请求。只证明实际DSH调度/工具/存储链；真实模型理解、供应商费用/权限、生产网络、App与移动runtime均未由它证明。

## 失败与进程清理

90秒限制到达先TERM，5秒后KILL；停止后10秒仍无close则失败并记录PID与kill诊断，关闭mock网络，不进入下一例。不把kill返回当进程已结束。成功实跑的child均观察到close且mock已关闭。

早期的九类纯JS故障模型仍只是历史模型。spawn同步异常、异步error/close、缺pipe、kill失败、多次error、exit但stdio未关、close超时等OS级故障注入未全部运行，不在当前PASS覆盖内。
