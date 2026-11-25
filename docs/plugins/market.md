# 发布与上架

写好的插件要走三层：npm 包 → 市场索引 → App 里能装。三层互相独立，逐层确认。

## 1. 发布 npm 包

基础是 npm 包，构建与发布流程见[从零到市场](from-zero.md)第 6 节。要点：

- 包名自己拥有；`cordis.patch.yml` 的 `name` 与包名完全一致；带 scope 的包名在 YAML 里加引号。
- `engines.dsh` 与 peer 写实际验证过的版本范围。
- `repository` 指向真实的公开仓库；`keywords` 加 `dsh-plugin`、`dsh-bundle`。
- 选择 OSI 认可的许可并提供 LICENSE，元数据与实际内容一致。
- 发布：仅适用于没有 `prepare`/`prepublishOnly` 等构建脚本的插件，可用 `npm publish --access public --ignore-scripts`；依赖这些脚本的插件，先按[从零到市场](from-zero.md)第 6 节完成构建与测试再发布。用 `npm view <包名> name version repository dist.integrity --json` 核对。

## 2. 进入发现索引（dshfind）

App 默认读 dshfind 的 format-1 索引。先给公开仓库加 `dsh-plugin` topic，核对 npm 的 `repository` 回链；发现任务会在刷新时处理（不承诺固定时间到账）。

收录条件（2026-10）：识别为插件、未被标记风险、带 bundle、已发布到 npm、回链匹配、包名与版本有效；`@deepseek-ai/*` 不收录。版本兼容性由安装端另外检查，风险标记由市场给出、作者不能自设。

## 3. 上架官方市场（dsh-go-market）

App 的插件市场分**官方**、**适配 DSH Go**、**全部**三个入口。官方目录里的同名包使用经过检查的固定版本，详情显示风险标记、适配能力、最低 App 版本、截图和双语介绍。

投稿步骤：

1. 到 [dsh-go-market](https://github.com/ccch1mneyyy/dsh-go-market) 仓库，按「提交插件」的说明新增一个 `plugins/*.json` 条目，提 PR。
2. 条目只写作者字段（包名、精确版本、标题、摘要、分类、截图、主页等）；tier、risk、integrity 由该仓库的构建生成，作者不能自设。
3. 审核与自动合并按该仓库的规则执行。**规则以仓库为准**，本文只描述 App 怎样使用这些数据。

要点：

- 每个条目钉一个**精确版本**，且与 npm 上的版本一致。
- 分类从市场声明的固定集合里选；截图只用 HTTPS，最多 4 张。
- 许可必须是 OSI 认可；包体积有上限（50 MiB 量级，以仓库规则为准）。
- **官方身份只来自该仓库的 policy.json**，作者无法自行声明「官方」。
- 风险标记描述包具备的能力，**不代表安全保证**；中、高风险的安装会先列出原因，确认后才继续。

## 4. 四个独立状态

网站有页面、npm 已发布、市场索引有条目、App 能安装——这是四件事，逐一核对：

| 状态 | 怎么确认 |
|---|---|
| npm 已发布 | `npm view … --json` |
| dshfind 索引有条目 | 用精确包名查 dshfind 的 format-1 索引 `https://api.dshfind.com/market/dsh-index.json`（见 from-zero 示例）；它决定「全部」分区 |
| 官方市场索引有条目 | 用精确包名查官方市场的 format-1 索引 `https://go.dshtui.com/market/index.json`；它决定「官方」和「适配 DSH Go」分区 |
| App 市场能看到 | App 里搜包名，核对版本、来源和筛选分区 |
| 能安装并运行 | 装到目标主机，做一次真实工具调用 |

## 常见问题

| 现象 | 先核对 |
|---|---|
| 网站能搜到，App 没有 | 索引结果、当前筛选分区、精确版本、npm 回链 |
| 官方分区没有，只在「全部」 | 投稿条目是否已合入、条目版本是否与 npm 一致 |
| 装的时候要求确认风险 | 风险标记来自对包内容的自动扫描（安装脚本、原生二进制、子进程、文件写入、网络等特征），不只看能力声明；到 [dsh-go-market](https://github.com/ccch1mneyyy/dsh-go-market) 的 `audit.json` 里按包名查具体文件路径；确认后仍可安装 |
| 已安装版本被下架 | 详情页会提醒；发布修复版本并更新条目 |

发布层的通用规则见 [DSH 官方 bundle 发布说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
