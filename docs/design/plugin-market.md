# DSH Go 插件市场

> 2026-10-30。研究在 [../research/plugin-market.md](../research/plugin-market.md)，App 现有市场在 `app/lib/state/plugins_state.dart`（读 dshfind 的格式 1 索引）和 `app/lib/ui/plugins/market_tab.dart`。生图生视频插件见 [media-generation.md](media-generation.md)。

## 1. 已定的事（owner，10-30）

| # | 决定 |
|---|---|
| D1 | 官方插件发在 npm 作用域 `@dsh-go`（组织）；组织建不了时用个人作用域 `@ccchimneyyy` |
| D2 | **自动上架**：提交通过自动检查就合并上架，不等人工；检查出的风险**标给用户看** |
| D3 | 生图生视频插件**不预装**进本机运行时，从市场一键装 |
| D4 | 提交走 GitHub |
| D5 | 媒体插件既生图也生视频 |

## 2. 三个分区

| 分区 | 收录 | 来源 | 卡片标记 |
|---|---|---|---|
| 官方 | 补全 DSH Go 功能的插件（首个：`@ccch1mneyyy/dsh-media`） | 官方索引，`tier: official` | 「官方」 |
| 适配 DSH Go | 声明并通过 DSH Go 原生协议检查的社区插件 | 官方索引，`tier: community` | 「适配 DSH Go」 |
| 全部 | dshfind 全量 | dshfind 格式 1 索引，照旧 | 无 |

同一个包同时出现在官方索引和 dshfind 里时，以官方索引的条目为准（锁定的版本、风险标记）。

## 3. 数据：两个文件

都由市场仓库的 CI 生成，发到 GitHub Pages（`MARKET_SOURCE_URL`，默认 `https://ccch1mneyyy.github.io/dsh-go-market/`）。App 不直接读那里：

```
GitHub Pages
  → Worker 的 Cron（每 10 分钟，src/market.ts publishMarket）：取两个文件，一起校验（validateCatalog）
      通过 → 写到公开桶 dshgo-dl 的 market/index.json、market/dsh-go.json
             （application/json; charset=utf-8，Cache-Control: public, max-age=300），
             同一份快照也存进 Worker 自己的缓存（KV）
      失败 → 什么都不写，桶里和缓存里还是上一份
  → https://dl.dshtui.com/market/…   App 1.0.9 起先读这里（CDN 按 max-age 缓存，不经过 Worker）
  → https://go.dshtui.com/market/…   Worker 照常提供同一份快照，作为后备；
                                      旧版 App 来这里会被 zone 的 Redirect Rule 302 到 dl（带 Origin 头的网页请求不跳，
                                      照旧拿 Worker 的 CORS 头）
```

- `https://go.dshtui.com/market/index.json`（= `https://dl.dshtui.com/market/index.json`）：**格式 1**，必须通过 DSH 0.2.1 官方校验器（`dsh-plugin-market-index`）。DSH 网页版、dsh-TUI 也能直接添加这个地址。每个插件**只列锁定的那一个版本**。
- `https://go.dshtui.com/market/dsh-go.json`（= `https://dl.dshtui.com/market/dsh-go.json`）：格式 1 装不下的东西，App 用。
- 两个文件在 CDN 上各自缓存，目录变化后的 5 分钟内可能拿到新旧不配套的一对：App 照常显示（版本对不上的 sidecar 条目不用），但不存下来，下次再取（§6）。

```jsonc
// dsh-go.json
{
  "schema": 1,
  "generatedAt": "2026-10-30T12:00:00Z",
  "plugins": {
    "@ccch1mneyyy/dsh-media": {
      "version": "0.2.0",              // 与 index.json 里锁定的版本一致
      "tier": "official",              // official | community
      "title": { "zh": "生图生视频", "en": "Images & video" },
      "summary": { "zh": "…", "en": "…" },
      "screenshots": ["https://…"],     // https，最多 4 张
      "dshGo": {
        "adapted": true,               // 用了 DSH Go 原生协议（卡片、表单、设置页）
        "minApp": "1.0.3",             // 低于这个版本的 App 只显示，不让装
        "features": ["native-cards", "settings-page", "media"]
      },
      "risk": {
        "level": "low",                // low | medium | high，CI 按下面的规则算
        "flags": ["network"]           // 见 §5
      },
      "integrity": "sha512-…",         // npm dist.integrity，装前核对
      "checkedAt": "2026-10-30T11:58:00Z",
      "blockedVersions": []            // 下架的版本：已装的用户会看到警告
    }
  }
}
```

## 4. 市场仓库与提交流程（GitHub，自动上架）

公开仓库 `ccch1mneyyy/dsh-go-market`：

```
plugins/<包名，@scope__name 形式>.json   每个插件一个文件（作者提交的）
schema/plugin.schema.json
scripts/check.mjs                         自动检查
scripts/build.mjs                         生成 index.json + dsh-go.json
.github/workflows/check.yml               PR 上跑检查，全过就自动合并
.github/workflows/publish.yml             合并后生成并发布
.github/workflows/watch.yml               每天查一次已上架包的新版本，自动开 PR
```

作者提交的条目：

```jsonc
{
  "name": "@someone/dsh-weather",
  "version": "1.2.0",
  "title": { "zh": "天气", "en": "Weather" },
  "summary": { "zh": "…", "en": "…" },
  "category": "tools",
  "screenshots": [],
  "homepage": "https://github.com/…"
}
```

流程：作者提 PR → `check.yml` 跑检查 → 全过且只改了一个 `plugins/*.json` → 自动合并 → `publish.yml` 生成两个文件 → 几分钟后 App 里能看到。`tier: official` 只能由仓库维护者设置，社区 PR 带这个字段直接不过。作者升级就是改版本号再提 PR，同样自动。

## 5. 自动检查与风险标记

**挡住（不合并）**：npm 上没有这个精确版本；没有许可证或不是 OSI 许可；格式 1 校验不过；包大于 50 MB；npm 安全公告里有高危；作者冒用 `tier: official`。

**放行但标风险**（`risk.flags`，App 里给用户看）：

| flag | 怎么判断 | 级别 |
|---|---|---|
| `install-scripts` | `package.json` 有 preinstall / install / postinstall | high |
| `native-code` | 包里有 `.node`、`binding.gyp`、预编译二进制 | high |
| `shell` | 源码里调用 child_process / 执行命令 | medium |
| `network` | 源码里有网络请求（fetch、http、ws） | low |
| `filesystem` | 写工作区以外的路径 | medium |
| `obfuscated` | 压缩混淆的大文件，难以审阅 | medium |
| `not-adapted` | 没有 DSH Go 原生协议声明 | low（进「全部」逻辑，不进「适配」分区） |

`risk.level` 取所有 flag 里最高的那个。判断是启发式的，文档和 App 里都这么说明：「自动检查发现的特征，不代表插件有恶意」。

## 6. App 侧

- 市场页三个分区：官方 / 适配 DSH Go / 全部。前两个来自官方索引，第三个是 dshfind。
- 读官方索引（1.0.9 起，`app/lib/state/plugins_state.dart` `fetchOfficialMarket`）：先 `https://dl.dshtui.com/market/`，不行再 `https://go.dshtui.com/market/`。最近一份读得通、且每个插件都有锁定版本的 listing 的目录，连同两个文件的 ETag 存在手机上（SharedPreferences `market.official`）：6 小时内直接用，不发请求；过了 6 小时带 `If-None-Match` 重新验证（304 就续期）；下拉刷新和「重试」总是重新验证；两个地址都连不上时用手机上那份（不论多旧）。手机上没有时照旧：哪儿都没发布（404）是空市场，其余是错误。
- 卡片：分区标记 + 风险标签（low 不显示，medium 黄色，high 红色）。
- 详情页：截图、中文介绍、风险逐条解释、版本、来源链接。
- 安装：装到当前主机，用索引锁定的版本（`name@version`），装前核对 integrity。medium / high 先弹确认，列出风险。
- 更新：已装的官方索引插件，索引里的版本更新时显示「有更新」。装的版本在 `blockedVersions` 里时显示警告和卸载入口。
- 提交：市场页底部「提交插件」，打开市场仓库的提交说明。
- 分享：插件详情可以分享链接 `https://go.dshtui.com/p/<包名>`，网页显示卡片，点开唤起 App 进入详情。
- 生图生视频：当前主机没装媒体插件、但官方索引里有时，「生成」入口照常显示，点开是「在此主机上安装」（`MediaPluginState.installable`），不再整个隐藏。

### 安装校验边界（App 实现）

App 在删除旧版本或开始安装之前，通过现有 `ShareNet.npmFacts` 读取精确版本的 `dist.integrity`（npm 官方注册表优先，npmmirror 后备），与 sidecar 比较。已提供 integrity 的条目遇到不一致或暂时查不到时会停止安装；取消、切换主机也不会继续开始安装。

这只能核对**注册表的版本元数据**。现有 `pluginManager/inspect`、`installBundle` 参数和返回值都不支持传递预期 integrity 或回报实际下载包的摘要；主机端 pnpm 依据其使用的注册表验证 tarball，App 不能证明那份 tarball 与市场检查过的包一致。要闭合端到端校验，需要宿主安装 API 接受并强制校验预期 integrity。sidecar 缺失、损坏或版本不匹配时不显示其检查标记；这些条目使用原有安装路径，不声称完成市场校验。

插件分享沿用已有 `dshgo://` scheme：网页把 `https://go.dshtui.com/p/<编码包名>` 交接为 `dshgo://go.dshtui.com/p/<编码包名>`，App 打开详情。App 内打开同路径 HTTPS 链接也可解析；Android 系统直接接管 HTTPS 仍取决于后端的 App Links 验证配置。

## 7. 分工

| 部分 | 谁做 |
|---|---|
| `@ccch1mneyyy/dsh-media`：补视频生成、编辑图片、国内服务商，整理发包 | Pro（后端） |
| 市场仓库、检查与生成脚本、GitHub Actions、Worker 的 `/market/*`、`/p/<包名>` 和写 `dl` 的 Cron | Pro（后端） |
| App 市场页、风险展示、安装与更新、媒体入口 | Claude（前端） |
| npm 组织 `dsh-go` 和发包令牌、市场仓库的创建 | owner |
