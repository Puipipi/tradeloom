# subprocess 零尾容量游标约定（642）

本文先于实现记录 636 已交付改动引入的回归补正。基底为公开 main 的 63e255fab5cb9d817af30b631c3643ccce8e9231（tag v1.0.11），DSH 0.2.2-rc.1。发布基底未包含 636/637/638，本包不声称 1.0.11 自身已有该回归。只读上游 `SubprocessCollect.maxBytes` 未禁止 0，公开 LocalSubprocessRuntime.spawn 接受 `{maxBytes:0}`；Bash 自有参数校验不能替代此公开服务合同。

原始 d935 与 1.0.11 的对应实现中，普通 Node 输出 `abc` 后，零尾容量的 readFrom(0) 返回空 text、nextOffset=3、lossy=true。636 为保留“正容量尾部仅含未完整 UTF-8 前缀”的丢失标记，令空且 lossy 的读取不推进 cursor，却也作用于完全空的尾 buffer，造成 nextOffset 停在 0。原始基线通过、636+637+638 组合失败已有真实子进程证据。

最小修复：readFrom 开始处仅在 `this.bytes === 0` 时返回空 text、nextOffset=this.total、lossy=(fromByte < this.total)，按原逻辑附带 spillPath。该分支在发布基底 1.0.11 上保持既有值；与已交付 636、637、638 组合时纠正回归。fromByte==total 仍为非 lossy 空读，fromByte>total 仍返回 total，不新增游标校验。

正容量、实际保留了未完整 UTF-8 字节的情况不进入此分支：636 的 pending/gap 保护继续有效。零尾容量只是不保留内存文本，不禁止已有完整 spill artifact；活跃及结束后均应承认原始字节进度。

新增独立 runtime diff 排在 638 的 zsingle-read 之后，不替换或修改已冻结补丁，不新增公开 API/配置、不更改授权。会改变 runtimeVersion 输入，版本/pins 由本机按既有流程录制；本补丁不提供新 pins。验证使用自有 Node、公开 subprocess、真实 pipe/socket 握手，禁止依赖 sleep 制造分片。
