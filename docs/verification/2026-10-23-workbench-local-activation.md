# 工作台本地激活验收记录（2026-10-23）

本记录汇总 Narrative Annotation、Agent 能力配置和本地工作台的有限验证。它不代表桌面窗口、手机或所有部署方式均已验收。

## 实现与隔离验证

- 此前的 Django 全量迁移验收为 504/504；本次激活未重跑 Django 全量套件。Node shell suite 为 226/226、0 跳过，使用固定 Node 24.21.0；该总数已包含以下 7 项官方 Loader、ConfigEditor、MCP、Skill、scoped tool guard 和新 Session generation 的隔离运行时用例，不应另加为 233 项。provider 均为本地 synthetic fixture。
- 数据库仅向前应用 `0011_narrative_annotation_revision`。恢复校验通过，既有业务表计数在迁移前后保持一致；annotation 结构及约束已建立。
- 本地来源闭环导入一份文字来源并追加一条 annotation。来源类型记录为二次摘要与分析，录音日期为空，核听状态为未核听，内容状态为待确认。报告不包含原文、来源标识或内容哈希；细节见[来源闭环记录](2026-10-23-narrative-native-source-closure.md)。
- 本地原生中心会话使用一次提示调用两项只读工具；两项后端 GET 均返回 HTTP 200，整轮完成。主 provider 的 3 次请求和 1 次辅助请求均来自本地 synthetic provider，不代表付费模型或外部服务验收。

## 本地激活结果

- 运行包同步后，源码、运行包和 profile 中的 25 个产品 bundle 文件校验一致。独立 post-start 哈希复核与已保存基线相比有 9/11 项一致；两项差异分别是按新 bundle 更新的启动器记录，以及启动时重建的生成 root `cordis.yml`。其余用户管理的 profile 文件（包括 `cordis.patch.yml`）、凭据、ERP 配置、会话状态和所有权标记均与基线匹配；不据此声称生成 root 字节不变。
- DSH profile 的 `cordis.yml` 是启动时重建的生成 root，不是用户权威配置；用户 patch 是 `cordis.patch.yml`。本次启动后，官方 Loader 对生成 root 执行写回，因此该文件与启动前哈希不同。启动源码的 `prepareProfile()` / `composeProfile()` 会重写生成 root；Loader 的配置更新和插件自卸载路径会触发 tree write。没有证据能确定本次具体由哪个插件事件触发。未改写用户 patch，也未恢复或覆盖生成文件。
- 应用启动后只读 readiness 检查为 5/5：工作台页面、资料静态资源、来源列表和 annotation 历史接口均通过；来源数为 1，没有读取来源原文或写入 annotation。启动前后数据库迁移与 15 项既有计数、annotation 计数一致。
- 更早的激活观察发生在来源导入前：4 次 GET 成功，第 5 项因当时没有来源而跳过。上面的 5/5 是来源建立后的后续独立检查，不替代或改写旧观察。
- 首次 post-start 报告把生成用的 `cordis.yml` 误列为应保持字节不变的用户配置，并标记失败；源码诊断后另存后续说明，原始失败记录保留。启动包装记录本身为 `null`，因此启动结论依据独立进程状态和后续 readiness，而非该记录文件。
- 启动诊断后续复核记录 0 个固定错误/警告/致命类别匹配，controller stderr 为空；DSH logs 目录当时不存在。此结果仅表示检查到的日志窗口没有这些固定类别，不代表所有运行时错误均不存在。
- 未认证的 DSH 根页返回 HTTP 401，符合现有认证边界；本次没有读取认证 token，也没有验证已认证桌面 cookie 或手机入口。

## 尚未验证

- 用于界面自动化的 app-server 因工具路径不存在而启动失败，因此没有完成桌面窗口、主题、拖拽布局、弹层边界或实体手机视觉验收。HTTP readiness 与 DOM 测试不能替代窗口检查。
- 未调用付费模型 API，未验证远程 ERP 的真实写入，也未验证真实 MCP 外部服务。

本记录对应上述本地采样时点。内容不含来源原文、人员信息、认证信息、数据库主机或机器绝对路径。

后续完成了 source-mode 原生窗口的局部 UI 复验，覆盖尺寸、主题持久化、业务 iframe 联动、窄 pane 与 provider 下拉/键盘路径；该后续结果和未验项见[验收矩阵](../acceptance-matrix.md)中的 2026-10-23 UI 增量。本记录中“尚未验证”描述的是本次较早的本地激活采样，不代表后续 UI 复验未发生。
