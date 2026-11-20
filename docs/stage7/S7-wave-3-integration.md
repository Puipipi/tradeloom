# S7-06 与 S7-07 串行集成回执

集成基线 `b627c1efb57b845d3a8be60e63101196a5843f33`，tree `27e4efcacfa87d46739f9d94b46b13b29c46b956`。两个独立作者树基于同一身份。已逐项核对 30/16 个许可路径、baseBlob、完整实际差异及物理字节，写入范围交集 0。各作者原始字节摘要见 `[local-path-redacted]`。

- S7-06 集成四个工作流私有源及交接，范围是运行视图轮询、原生服务投影、journal 声明和产物读取重检。浏览器接收复数 `/tradeloom/workflows/native/artifacts?` 而 Host 生成单数 `/tradeloom/workflows/native/artifact?` 的静态差异在基线与集成均存在，保留原路径，实际登记及下载待 S7-08 验证。
- S7-07 集成七个私有源、三个现有测试及交接。共享生产契约只修一行，记录 MCP chunk 惰性加载后空注册，以及手动网页登录入口经过 replica business-bridge、source preload、Main/controller 的可信窗校验至 aiWebWindows。历史代发、自动取回和文件 agent 仍留历史范围。
- rc.3 配方仅更新上述 11 个真实业务源的 exact pre/post 字节及 SHA-256 和业务库存。其他 66 项逐字节与旧 pin 一致，实际 native-FS 验证为 77 件、3,037,873 B，SHA-256 `874761fe0739dc091fd2075fa5ed3b7a809fd19a83f4aac63e8fd41dae7a9686`。

## 集中验证

日志位于 `[local-path-redacted]`。固定 Node 24.16.0 及本地官方 rc.3 SDK。以下项目均零跳过，失败测试名称与失败字段见 `test-comparison.json`。

| 队列 | 原始源码 → 集成源码 |
| --- | --- |
| S7-06 三文件，已跟踪 accepted-runtime 固定夹具 | 5/27 → 5/27，均退出 1；22 项继承失败同名同因。初次默认旧夹具路径缺文件，保留原日志。使用首选固定目录复跑后取得完整 27 项。 |
| S7-06 补充对照，第二波严格重放 desktop 实物固定夹具 | 14/27 → 14/27，均退出 1；13 项同名同因。此对照同时区分陈旧面板样本与实际消费的固定桌面资源。 |
| S7-07 全六文件 | 同路径加载冻结模块及测试时 16/23，集成 21/23，均退出 1。候选把五个此前被 rc.2 精确断言阻挡的 MCP/音频生产夹具切到真实 rc.3 后执行通过。继承失败为导航所需的旧 rc.2 样本未提供，以及 Windows System.Speech 返回 `session_speech_provider_unavailable`。 |
| S7-07 补充同路径朗读及受控生产验证 | 短 D 路径归档基线下 Windows 提供器通过，故其全套为 17/23。固定在集成工作树运行位置分别加载冻结与集成朗读模块，Windows 用例都报同一不可用错误。受控 MCP、记忆和音频 14/14，受控朗读 7/7，均退出 0。 |
| DSH 边界与官方严格重放 | 边界 11/11，守卫直接运行退出 0、问题 0。官方 rc.3 原件和 unpacked 输入的严格重放退出 0，状态 `fixed 0.2.2-rc.3 replay exact`。ASAR 228,830,030 B，SHA-256 `2c062d456069a6bdad4177509cfb84001f8b839d4125148fdd7b7be8ab819d0f`，与第二波固定 ASAR 相同；业务文件 native-FS 读回见 `strict/evidence/business-nativefs-readback.json`。 |

本轮为隔离自动验证。完整包、实机工作流及语音、人工网页和用户数据保持列入 S7-08 集中验收。
