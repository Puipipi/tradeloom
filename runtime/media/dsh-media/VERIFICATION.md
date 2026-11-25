# Media 验证与复现

## 0.3.0 兼容性集成 — 2026-11-07

本节基于最新 main 基线 3a91fab9 的隔离工作树，不沿用旧工作树的 320 项通过结论。保留 main 已有 owner teardown、暂存清理和 storage 错误分类修复及测试；没有改动生产 runtime 锁、补丁或媒体执行代码。

- DSH 0.2.2-rc.1：完整 Node suite 325 通过，4 个 DSH_PREFIX 门控用例跳过；另以 rc.1 的真实服务执行 owner 生命周期 4/4 通过（无跳过）。headless 图片与视频均通过，分别 27/38 个事件。
- DSH 0.2.1-rc.4：完整 Node suite 325 通过，4 个仅针对 rc.1 的 DSH_PREFIX 用例跳过；headless 图片与视频均通过，分别 27/38 个事件。
- 两版测试 prefix 由各自已有 runtime lock 派生，仅补入精确 SRI 的 mock-server 和 image-size；compatibility.test 逐条比对原 lock 的所有非根记录，并验证真实 host compatibility evaluator 的正/负版本门禁。
- headless 等到实际 video job settled 再取结果；rc.1 保留显式 native executor 开启/PTC executor 关闭，只有 rc.4 使用旧 tools.mode 配置。
- Linux arm64 / Android PRoot，Node v24.22.1，本地 HTTP/LLM mock，无真实付费供应商、App 安装、媒体查看器或市场发布验证。

复现：prepare.mjs 默认选 0.2.2-rc.1；旧版加 --dsh-version 0.2.1-rc.4。每版单独 npm ci --ignore-scripts，串行切换源码的 node_modules 测试链接。不要省略当前平台的 native loader/system optional binding。真实 owner 生命周期用例另设置 DSH_PREFIX 为 rc.1 prefix 后运行，跳过不能写成通过。

## 历史：0.2.0 验证与复现

运行环境：Linux，Node v24.21.0，DSH npm `0.2.1-rc.4`，`TZ=Asia/Shanghai`。现有 rc.4 runtime lock 的 628 个非根记录全部保留，只加入精确 integrity 的 `dsh-llm-mock-server@0.2.1-rc.4` 与 `image-size@2.0.2`；不混用其他版本的 jobs。

## 复现

从仓库根执行，`/absolute/media-deps` 与 `/absolute/media-evidence` 必须是新目录。安装步骤不运行 npm 生命周期脚本；实际工作区的 node_modules 已存在时不要覆盖，先核对其来源。

```sh
node runtime/media/dsh-media/test/headless-v2/prepare.mjs --dsh-version 0.2.1-rc.4 --out /absolute/media-deps
npm ci --ignore-scripts --prefix /absolute/media-deps
ln -s /absolute/media-deps/node_modules runtime/media/dsh-media/node_modules
TZ=Asia/Shanghai node --test runtime/media/dsh-media/test/*.test.js
TZ=Asia/Shanghai node runtime/media/dsh-media/test/headless-v2/run.mjs --out /absolute/media-evidence
```

共享开发机应串行运行测试 / headless，并为每个工作区指定独立的 TMPDIR。prepare 生成脚本只写独立目录，不重解析或修改 runtime 锁；输出 test-inputs.json 记录基准哈希和保留条目数。

## 已执行与证据范围

- 全套 Node：**306 / 306 通过**，含既有 M0、预算账本、HTTP / 文件安全回归和新增 provider / jobs 接线用例。
- 本地真实 HTTP：OpenAI、方舟、百炼、硅基流动的图片及编辑；三家文生 / 图生视频、实际 DELETE / POST 取消、运行中不可取消、失败、提交超时、查询超时。接受 POST 后 socket 断开只提交一次并保持 submission_unknown。下载保持原件字节，不带服务密钥。
- 安全边界：精确参考文件审批、审批后替换身份拒绝、FIFO 拒绝、JSON 转义膨胀的元数据在 POST 前拒绝、预算跨请求、默认图片服务下调用视频、原会话恢复。真实子进程在发布 MP4 后、写索引前 `process.exit(77)`，随后新进程状态下用新文件名续查发布，旧文件保留、供应商 POST 为零。
- 真实未改动 rc.4 公共 CLI：图片与视频各一条实际 Session，经过生产 admission / approval / ledger；mock seam 只替换 HTTP 目标，不替换 generate 或跳过费用审批。视频使用真正的 jobs.start、完成 producer 状态与 tool-jobs 通知，随后真正执行 get_media_result，初始和终态 rid/job 一致。

headless 输出包含 identity.json（Node、CLI、源码与测试锁哈希）、summary.json、每案 wire-audit.json、Session 原始事件、物理 V4 JSONL 和 verified.json。验证连续 seq、原始事件与持久事件逐对象一致、正常退出、无假凭据回显、输出与 fixture 字节一致。日志保留私有测试工作区绝对路径，不改写成手机路径，也不复制为 App 的 live fixture。

headless rc.4 单次运行不自动等待普通 jobs。测试让第二次本地 mock LLM 响应等待下载完成后再结束当前 turn，确保真实通知进入仍存活的 Host；不调用会标记 awaited 并抑制通知的 jobs.wait / job_output(wait:true)。这验证真实 Host 接线，不证明任意 one-shot headless 进程会自行等到视频结束。

视频 fixture 是本地合成 32×24 蓝色 1 秒 H.264 MP4，无第三方素材；生成命令：

```sh
ffmpeg -f lavfi -i color=c=blue:s=32x24:r=1:d=1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart synthetic.mp4
base64 -w0 synthetic.mp4 > runtime/media/dsh-media/test/fixtures/video.base64
```

## 未验证 / 有意限制

未调用真实付费服务；接口字段来自 data/models.json 列出的官方资料，不证明账号权限或实际图像质量。未执行 Android / PRoot / App 媒体完整链路、真实模型语言理解、真实 settings 表单写入 reload、跨 Host 部署。旧 test/headless 的 M0 验证材料仅作历史记录，当前入口为 headless-v2。

当前报价未知，逐次审批与本地预留不能保证供应商账单不超过 ¥20；没有退款推断。Host 重启需原会话显式 resume_media，不自动重建任务；无 task ID 的不确定提交不可自动恢复。恢复新命名避免覆盖半发布遗留，崩溃产生的旧文件与 .pending 目录不自动删除。MP4 只做格式与实际头部元数据验证，不保证每台设备解码。方舟/百炼只确认排队取消，硅基取消未提供。

npm pack 已完成本地内容检查与解包 import。2026-10-31 发布前及切换备用组织后，精确 rc.4 依赖下全套均为 306/306 通过。旧 0.2.0 包暂存下载逐字节匹配；新令牌直发因已暂存版本占用返回 409，正常更新为 `@ccch1mneyyy/dsh-media@0.2.1`。最终 tarball 19 个文件与源码一致，48,019 bytes；与 306 通过的包对比只有 package.json 版本字段变化，运行时代码无改动。历史 headless 的 JS 源码、CLI、Node 与测试锁身份均匹配，没有重复运行。

前一枚令牌的直发限制最终明确为 `E_STAGE_REQUIRED`，并非所有 npm 发布都必须人工审批。最新令牌提交 0.2.1 返回 HTTP 202；2026-10-30 19:55:51 UTC 后匿名精确版本查询和公开 tarball 下载均为 200，48,019 bytes 的下载包与本地 SHA256、registry SHA512 完全一致，确认正式版本可下载。设备安装、Android/PRoot 媒体完整链路与真实付费生成仍未新增验证，见 PUBLISH.md 和市场验收记录。

## 公开包安装与 profile 组合（0.2.1）

全新私有 consumer 使用独立空 npmrc，从公开 registry 实际安装精确的 `@ccch1mneyyy/dsh-media@0.2.1`；使用 `--ignore-scripts --legacy-peer-deps`，安装 6 个普通依赖。10 个 Host peer 逐一核对精确版本后复用既有 rc.4 依赖，安装锁记录的 tarball URL 与 SHA512 等于正式发布物。

通过真实 bare-specifier 导入 `. / ./config / ./package.json` 三个 exports；安装包的 `cordis.patch.yml` 指向正式新 scope、entry ID 仍为 `dsh-media`。未改动 rc.4 CLI 在独立 `DSH_HOME` 中运行 `--dump-config`，使用安装包原 patch 成功组合出 `dsh-media`。这是实际 npm 安装、导出加载与 profile patch 组合验证，不声称实际 mounted activation、App 安装或新增媒体生成验证。

市场真实 npm 扫描与 24 项测试、全部 5 包构建通过；Pages 和 Worker 双文件线上均为 HTTP 200，Worker `X-Market-Stale:false`，官方格式 1 parser 与实际 Worker validator 均通过，媒体正式条目为 official / 0.2.1，SRI 与 npm 一致。独立验证 `/p/%40ccch1mneyyy%2Fdsh-media` 分享页为 200，包含中文标题、0.2.1 与正确的 `dshgo://` deep link。App 内入口为设置 → 插件 → 插件市场 → 官方；未安装时，设置 → 图像与视频也提供当前主机安装按钮。这确认线上发现路径与现有 UI 接线，没有执行手机上的真实点击安装。
