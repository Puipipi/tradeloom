# dsh-Go 验证映射
先读当前 CONTRIBUTING.md 的「常用检查」、tooling 脚本与 .github/workflows；本表仅选择方法，漂移依仓库真源并记报告。

## 禁止虚构
只记实跑命令、退出码、SHA 与关键输出；不将应通过写成已通过。缺设备/依赖/引擎时写"未运行"及原因。

## 最小通用关口
按改动面选择；纯文档/纯 workflow 改动依贡献指南分流，不机械全跑。

## 改动面 → 验证类别
| 改动面 | 至少核对 |
|---|---|
| app/lib 界面/状态/Riverpod | `(cd app && flutter analyze)` + 聚焦 `flutter test test/<相关>` |
| app 界面文案 ARB | `python3 app/tool/l10n_merge.py --check` |
| packages/dsh_client 协议/API | `(cd packages/dsh_client && dart analyze && dart test)` |
| packages/dsh_remote 传输 | `(cd packages/dsh_remote && dart analyze && dart test)` |
| runtime/bridge 路由与删除逻辑 | `node --test runtime/tests/*.test.mjs` |
| runtime/patches | pins 同步检查、补丁仍可应用、对应 node 测试 |
| sdk/plugin-kit | `(cd sdk/plugin-kit && npm test)` + `node sdk/plugin-kit/scripts/sync-skill.mjs --check` |
| docs/guide 用户指南 | `python3 app/tool/guide_sync.py --check` |
| tooling/ 构建脚本 | `tooling/build-apk.sh`（环境允许时）或静态复核 |
| .github/workflows、pr-intake | permissions、fork 信任、fail-open、路径过滤、动作版本 |
| 维护技能 .agents/skills/ | frontmatter、相对引用、脚本 self-test |

具体脚本名从当前包清单/贡献指南搜索，不按表猜。

## 选择算法
依次：diff 列行为/owner/公共契约/用户可见面 → 各找最近已有回归 → 核 CI/聚合调用或明本地补证 → 先最小聚焦，再依失败/风险扩大聚合 → 真机/平台敏感补真实演练（桌面绿不足）→ 报告分静态证明/自动回归/人工演练/未执行。

## 不可信 fork 执行门
若未来重新接受外部 PR：head 任意命令都可能执行贡献者改过的脚本或构建配置。默认静态；须用户明确许可，隔离工作树/容器，无仓库 secrets/生产凭据，只用最小只读凭据，限网络/CPU/内存/磁盘/时间。

## 反假绿检查
### 坏基线
回归须在未修实现失败；优先隔离树反向 patch、最小故障注入破被保护不变量；不改坏共享树、不破坏性 reset 回滚。

### 独立 oracle
oracle 不以实现同 helper 算 expected、不复制实现或同源自比；不恒真/只验符号字符串存在、不用本地化文案/随机内容/宽松子串替结构断言；事件/exports/features 白名单直比官方/目标全集；字段白名单直比真实响应。

### 真实路径
按脚本设计 import 真实源码或干净构建产物，走真实注册/调用/销毁路径；mock 仅替不可控外部边界；读写隔离临时目录、恢复 env/listener。

### CI 挂载
脚本存在不证保护：须 workflow/package script 实引、路径过滤不误跳、上游 failed/cancelled/空输出时 fail-closed、最新 head checks 非空且符当前 SHA。

## 报告记录模板
| 命令/核验 | 类型 | SHA | 结果 | 说明 |
|---|---|---|---|---|
| `...` | static / regression / manual | `...` | exit / pass / fail / blocked | 失败归因、环境、覆盖不变量 |

静态确定的阻断机制直接报告，不藏"建议补跑测试"；测试用来证明影响/修复。
