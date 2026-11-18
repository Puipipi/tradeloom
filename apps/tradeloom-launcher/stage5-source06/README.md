# 阶段5 source06：自有源码与精确后置覆盖

本提交基于 main 048cb638ae43db92c866e36fefddf0d4e575e544，纳入已审核 source06 正常源码、最终 77 件业务源码、168 件 backend 及 85 件自有 ASAR JS/assets，补齐 16 项恢复工具与 2 项 seed 来源。不是完整 Windows 程序、依赖树或 ASAR 归档。

## 使用边界

现有固定官方基座和版本化 replay/program recipes 是中间构建；其 businessShell.sourceRoot 仅改为本目录 legacy-business-inputs，保存source06的原86文件中间源和旧自动任务测试。正常 packages/tradeloom-shell 已是最终77文件，九个退役模块不在其 files/exports/loader/Host注册中。legacy 只为复现旧中间态，不是可安装最终入口，不得把该目录整体加入最终程序。

最终源权威为 SOURCE-MANIFEST.json 的相对来源、目标逻辑路径、bytes 和 SHA256。按既有 source06 配方最后应用 exact ASAR/business/backend/program postimages，再核九项退役和 deployment.json；旧 replay 的 expected ASAR 是旧中间代，不等于 source06 当前程序。这里不新增通用构建系统，也不声称仅运行旧 replay 就自动得到 source06 完整程序。原便携构包和真实资源 validator 的输出另行审查交付。

85项ASAR成员中不在正常仓库位置的精确JS/assets置于 asar/。仅两个已接受 voice 覆盖以 vendor-overrides 存储，逻辑member仍记在manifest；没有整份 node_modules。精确 accepted lib 优先于历史 VoiceInput.tsx，不能用旧TS覆盖它。program/用短名避免Windows传统路径上限，完整目标仍由manifest明确记录。derived/Program.cs为已有启动器源码与补丁的精确postimage。

## 内容与核对

- 撤下我方代发提问、自动取回答和自动文件任务；保留两站手动网页AI、登录、人工提问、附件、网页保存和手动诊断。
- 客户别名表单只增加六行按内层列宽响应的CSS；清单仅其真实记录和backend总量/树摘要随之更新。
- 精确覆盖与最终正常运行源通过.gitattributes禁EOL转换，Git blob必须与公开相对清单一致；其它正常源码沿原规则。
- `python apps/tradeloom-launcher/stage5-source06/verify.py --git-blobs` 核精确源码/索引blob、正常退役及保留的source06旧中间源字节。
- `node apps/tradeloom-launcher/stage5-source06/verify-manifest.mjs` 使用已有installed-bootstrap实际digest/schema验证77/168/16库存。它们不构建、不启动服务、不接触用户DATA。

现存源码中有非秘密的诊断和测试fixture字面路径，仅为保留已接受源字节而存在；没有导出它们指向的目录。controller初始化默认会尝试有界UI18诊断写入，失败被捕获，不声称默认禁用。公共来源清单、发布说明和新装配置不含个人机器origin；固定示例配置不能替用户选择真实DATA。

## 验收状态

source06/AA35/AJ44离线源与库存校验不等同GUI、冷启动、首次初始化、正常退出或安装/回退全通过。旧cleanup_failed事实保留。12、13已取消，07由用户确认完成；不恢复新语音或目录任务。本提交不发布远端tag/release或启动程序。

### 已知旧配方输入限制（未修复）

真实严格检查发现旧recipe的client.js与client.source-native.js两个preimage pin已不等于source06原源码，其余4项匹配；这不是本提交后置映射引入的新差异，未改期望pin求绿。详见LEGACY-INPUT-LIMITS.json。`verify.py --legacy-replay-inputs`会如实返回失败；不宣称现有旧replay可从该快照完整运行。最终77/168/85/16/2精确postimages与manifest可独立核对，这项source交付不新增TS追溯或功能门槛。
