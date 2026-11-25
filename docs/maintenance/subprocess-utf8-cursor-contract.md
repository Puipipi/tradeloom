# 636 约定：本地进程增量 UTF-8 尾部

状态：实施前约定已完成源码与独立复核，本文对应最小实现。基底 d935432d18cd83c951a87823b791b66c18426a64，官方 rc.1。

## 已复现的入口

实际 LocalSubprocessRuntime 启动 Node，将“中”的首字节写 stdout，经正常 IPC 握手由消费者读取，再写剩余两字节并退出0。readFrom 两次得到 `�` / `��`，lossy=false；退出后的完整读取是 `中`。实际 LocalBashExecutor 的公开 resolve→execute→readOutput 同样红：两次 delta 拼成 `���`，最终 result.stdout.text 为 `中`。

证据 `probe.mjs/run.log`、`bash-probe.mjs/bash-red.log`。后者执行普通 `bash -c`，Node通过自有临时 loopback IPC 门控两次写入，onExpiry=none，无sleep、无真实超时等待。只包含自有脚本，不读取主机配置/凭据。

## 现行合同与最小变化

官方 SubprocessOutputReader 的 offset 是全流原始字节坐标，每个调用者独立维护，不是字符数；nextOffset 是下一次续读位置。保留此定义及 wire 字段。当前“Read everything captured”文案需澄清：进程输出尚未封口时，只交付可完成UTF-8解码的尾部；末尾如果是合法UTF-8字符的未完成前缀，最多暂缓3字节，并让 nextOffset 停在该前缀起点。新字节补齐后继续读取即可恢复字符，不引入每消费者状态或全局decoder。

1. ASCII、完整UTF-8、已确定非法字节按现行Buffer解码；只有仍可能被后续字节补成合法字符的末端前缀暂缓。
2. nextOffset 始终为原始流绝对字节偏移，不改累计原始字节计数、tail容量、spill内容或snapshot字节。
3. 没有更多字节且进程正常exit/cancel封口时，下一次读取必须按原Buffer replacement规则交付未完成尾部，并推进到raw total；不得永远扣留。
4. 头部ring截断仍按原lossy判定；保留前端不完整字符的现有replacement，不声称恢复丢失字节。尾部pending若随后被截断，按lossy路径处理。
5. 若lossy且本次因未完整前缀而没有文本，nextOffset保留调用者原cursor，直到能交付文本才推进；这样实际jobs pump忽略空文本后，后续EOF/续字节读取仍带lossy，不丢gapBefore。
6. 多个独立cursor从同一/不同合法边界读取互不影响；任意调用者主动给出字符中间偏移的现有replacement行为不扩成对齐协议。
7. 退出后readFrom(0)必须与完整final result一致（含tail截断）。stderr与stdout同样处理。

## 现成消费者及等待风险

- dsh-bash-local readOutput 将各流nextOffset保存为自己的游标；无基于raw available的等待循环。
- dsh-tool-bash/pwsh processSources 直接转接 observed[channel].readFrom。
- dsh-jobs-local startPump 每轮对各source读取一次，然后等待固定pollMs或producer完成；不会因 nextOffset 未前进立即再次读取。结束后最终drain会在subprocess seal之后看到EOF replacement。
- 暂未发现 waitForOutput 式raw偏移即时唤醒消费者；独审应复查所有readFrom调用点。测试须验证pending前缀期间重复读取无新输出/不前进，且真实job pump不产生忙循环；使用受控timer推进，禁止真实等待。

## 实施与验收边界

实现仅改官方 subprocess-local/output.js，新增按文件顺序可组合的runtime patch，不先修改不可变prefix。seal需在没有spill文件的情况下也记住流已封口；不能仅在spillFd存在时完成EOF状态。任何helper限制为最多4字节末端检查，不引入泛化缓存/decoder框架。

最少回归：真实子进程与Bash消费者红绿；2/3/4字节分割；stdout/stderr；独立cursor；完整/非法/EOF残留；tail前端截断和pending被淘汰；普通cancel封口；真实job pump控制时钟无忙循环。保留已有terminal UTF-8尾截断、job ring与输出字节成本门禁。Android/PTY/SSH未测试，不声称改善这些环境。

本补丁新增 runtime/patches 文件，属于 build-runtime.sh 的 inputs_sha 输入；按现行构建流程将改变 runtimeVersion。pins 由 owner 在正式环境录制，本补丁不修改 pins 或指定新版本。
