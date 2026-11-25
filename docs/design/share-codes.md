# 分享码

> 2026-10-24。把一个插件或一份 DSH 配置做成链接 / 二维码 / 文件；对方打开后看到确认弹层，一下装进手机里的 DSH 或连着的远程 DSH。没有后端：链接要么指向公开来源（npm / GitHub），要么自己带着内容。

代码位置：

| 部分 | 文件 |
|---|---|
| App 链接基础设施 | `app/lib/links/app_links.dart`、`android/.../links/LinksPlugin.kt`、`LinkTrampolineActivity.kt`、`AndroidManifest.xml` |
| 编解码、格式校验 | `app/lib/share_code/share_codec.dart`、`share_models.dart`、`share_link.dart` |
| 导出 / 导入 | `profile_export.dart`、`settings_sanitizer.dart`、`share_import.dart`、`restore_point.dart`、`guest_fs.dart`、`share_net.dart` |
| 弹层 | `app/lib/ui/share_code/` |
| 着陆页 | `site/share/index.html`、`site/share/share.js` |

## 1. 链接

| 形式 | 例子 | 用在 |
|---|---|---|
| App 链接 | `dshgo://share/<kind>?p=<code>` | App 之间直接打开 |
| 大配置 | `dshgo://share/profile?gist=<id>&c=<sum>` | 内容放在私密 Gist 里 |
| 着陆页 | `https://go.dshtui.com/share/#p=<code>`、`…/#gist=<id>&c=<sum>`（旧地址 `https://ccch1mneyyy.github.io/dsh-go/share/` 仍能打开） | 复制链接、二维码、发到微信 |
| 文件 | `dsh-go-profile-20261024.dshgo`（`application/vnd.dshgo+json`） | 分享面板、存为文件、微信里转发 |

- `<kind>`：`plugin` / `profile` / `conversation`（对话见 §8，链接走托管，不内联）。着陆页链接不带 kind，解码后才知道。
- 着陆页的内容全在 `#` 后面：浏览器不会把它发给服务器。
- 换域名：改 `share_link.dart` 的 `shareLandingUrl`、`site/share/share.js` 里没有域名（只认相对路径），App Links 另见 §6。
- 「复制链接」「二维码」「分享」用的都是着陆页链接：微信不打开自定义 scheme，https 在哪儿都能点；着陆页上的「用 dsh-go 打开」再跳 `dshgo://`。

## 2. 编码

```
<code> = base64url(deflate-raw(JSON)) "." base64url(SHA-256(JSON)[0..6])
```

- JSON 是紧凑 UTF-8；校验和覆盖解压后的 JSON 字节，截断、改字都会被发现（「这个分享码不完整或已损坏」）。
- `v` 是格式版本，当前 1；比 App 新的版本拒绝（「需要更新 dsh-go 才能打开」）。
- 解压上限 1 MB（防压缩炸弹）。着陆页链接 ≤ 1800 字符时内联，二维码用 L 级纠错（> 600 字符）或 M 级，不放中心图标（理由见 community.md「二维码中心图标」）；更大的配置走文件或 Gist。
- `.dshgo` 文件和 Gist 里放同一个 code，外面包一层可读的头：`{"dshgo": 1, "kind": "profile", "name": "…", "code": "<code>"}`。一条解码路径。
- 着陆页用 `DecompressionStream('deflate-raw')` 和 `crypto.subtle` 解同一个格式。Python（zlib + hashlib）生成的 code 在 Dart 测试里能解；Dart 生成的 code 用 Node 跑过着陆页脚本（手动验证，没进测试）。

## 3. 内容

### 插件（`kind: plugin`）

```json
{"v":1,"kind":"plugin","plugin":{"name":"@acme/dsh-notes","source":"npm","spec":"@acme/dsh-notes@1.4.2",
 "version":"1.4.2","integrity":"sha512-…","title":"读书笔记","author":"Acme","summary":"…"}}
```

链接只能装这几种，读的时候严格校验：

| source | spec | 说明 |
|---|---|---|
| `npm` | 必须等于 `name@<精确版本>` | `integrity` 取 npm 的 `dist.integrity`（导出时从 registry.npmjs.org，答不上来再问 npmmirror） |
| `github` | `github:owner/repo#ref[&path:/dir]` 或 `git+https://github.com/…#ref` | DSH 的安装器（pnpm）接受这两种 |
| `git` | `git+https://<host>/…#ref[&path:/dir]` | 只认 https |
| `official` | 无 | DSH 自带的可选插件，导入时只是打开 |

本地路径、`file:`、`link:`、tarball、`git+ssh` 一律不能分享（清单里显示「本地安装，无法分享」）。显示文字截断、去换行，只当文字用。

### 配置（`kind: profile`）

```json
{"v":1,"kind":"profile","name":"…","created":"…Z",
 "settings":{"subagent":{"maxDepth":3}},
 "plugins":[…], "presets":[{"id":"writer","name":"写作","bundle":"@acme/dsh-notes"}],
 "skills":[{"name":"outline","files":{"SKILL.md":"…"}}], "agentsMd":"…"}
```

- **设置**：每个命名空间（`settings/describe` 的 ns）只取**用户层**（`user`，不是合成后的值）。清洗规则（`settings_sanitizer.dart`）：
  - 账号、凭据、遥测、网络监听类命名空间整个不出现（名字含 account / credential / telemetry / analytics / remote-access / webserver / gateway / auth …）；
  - schema 标了 `secret` 的字段、`secrets` 列出的槽位去掉（Host 本来也不返回值）；标了 `credential-ref` 的字段保留——它只是凭据的**名字**；
  - 字段名以 token / secret / password / cookie / authorization / apiKey 结尾（或 `api/private/client…` + `key`）的去掉，`maxTokens`、`apiKeyEnv`、`keyId` 这类保留；
  - 值像密钥（与聊天里遮挡凭据同一套识别：`sk-…`、`ghp_…`、JWT、私钥块…）、像长串随机令牌、是 `Bearer …`、URL 里带账号密码或 `token=` 一类参数、是绝对本地路径（`/…`、`~/…`、`C:\…`、`file:`）的去掉；被删空的对象 / 数组一并去掉。
- **插件**：已安装的第三方插件按精确版本，加上打开了的官方可选插件。
- **预设**：智能体预设只能由插件声明（Host 没有写预设的接口），所以预设跟着声明它的插件走：插件选上，它的预设才在里面；导入时预设行跟随插件的开关。
- **技能**：只从本机引擎读（`/root/.dsh/skills`、`/root/.agents/skills`），文件夹里的小文本文件一起带（≤ 12 个，每个 ≤ 64 KB，不带隐藏文件和二进制）。
- **AGENTS.md**：本机的个人偏好（`/root/.dsh/AGENTS.md` 不是 App 托管的那份时用它，否则用 `/root/.agents/AGENTS.md`）。默认**不勾**。

技能中的所有文本文件和个人偏好都使用聊天凭据识别规则扫描；命中密钥的整项显示「含有密钥，无法分享」，不加入分享内容。`Bearer $TOKEN` 这类变量引用不视为密钥。

导出清单每行标大小（JSON 字节），底部写「已选 N 项 · 可生成二维码 / 以文件分享」。

## 4. 打开与导入

入口：`dshgo://share/…`、着陆页链接（App Links 验证之后）、`.dshgo` 文件（文件管理器「打开方式」或从微信「分享」给 dsh-go，Manifest 里 VIEW / SEND 的 `application/vnd.dshgo+json`、`application/octet-stream`）。这些 intent filter 挂在不显示界面的 `LinkTrampolineActivity` 上：微信这类 App 不带 `NEW_TASK` 启动时，直接打到 `MainActivity` 会在微信的任务里再起一个 Flutter 界面；跳板把链接转给 App 自己的任务（`NEW_TASK | SINGLE_TOP | CLEAR_TOP`，连同 `content:` 的读权限），由 `LinksPlugin` 经 `onNewIntent` 或启动 intent 交给 Dart。`ShareCodeHost` 在启动时注册到 `LinkRouter`，冷启动带进来的链接也能接住。

确认弹层（`import_sheet.dart`）：

- **是什么**：插件图标、名称、说明；配置的名称和「3 个插件 · 5 项设置 · …」。
- **来源**：npm · 发布者（registry 的 `_npmUser`）/ GitHub · owner/repo / 主机名 / 分享链接、文件、GitHub Gist。
- **校验**：npm 插件拿 registry 当前的 `dist.integrity` 和链接里的比——一致「校验通过」，不一致「校验不一致」（该插件不能装），拿不到或 git 来源「无法校验」。配置校验和只检测内容完整性，不显示「校验通过」。
- **大小**：插件是 npm 的 `unpackedSize`，配置是内容大小。
- **装到哪**：本机（引擎在跑）和当前连着的远程主机，两个都在时是分段胶囊，切换就重新比对。
- **改动**（配置）：插件（安装 / 更新 1.2.0 → 1.4.2 / 启用 / 无需改动）、预设（随某插件添加）、设置（每个命名空间一行，`maxDepth 1 → 3`，已一致的不显示；目标上还没有、但这次会装插件的写「装好插件后应用」）、技能（默认不勾；同名不同内容是「替换同名技能」）、个人偏好（默认不勾，替换时标明「替换现有内容」）。每行一个圆形勾选；不能做的写原因（「只能导入到本机」「这台主机不能从这里安装插件」「安全模式下不能安装插件」）。
- **安装**：按顺序——还原点 → 插件（目标是当前主机时走插件页同一个安装队列 `pluginInstallsProvider`，进度在插件页也看得到；否则直接调那台的 `pluginManager/*`）→ 重新 `settings/describe`，逐个命名空间 `settings/mutate`（带 `expectedRevision`）→ 技能 → AGENTS.md。每行实时转圈 / 打勾 / 报错；需要重启时本机给「重启引擎」，远程写「重启 … 上的 DSH 后生效」。

### 设置和文本的确认

- 账号、认证、网络监听等禁止分享的命名空间，解析分享码时就丢掉。
- schema 的 secret、secrets 槽位和密钥字段名不生成写入操作；嵌套对象按点路径展示和写入，数组含密钥字段时整项略过。
- 模型、权限、沙箱命名空间，凭据引用，以及名称以 URL／URI／endpoint／host／proxy／registry 结尾的字段属于敏感设置，整行默认不勾。敏感字段优先展示，地址保留完整主机和路径，不折叠到「等 N 项」。
- 插件未安装时显示「装好插件后应用」及具体改动；读取设置失败时所有设置行不可选。
- 技能和个人偏好默认不勾，点「查看」可先阅读完整文件，再决定是否导入。

### 还原点

本机导入配置前，把主配置当前的状态写成「上次正常的配置」记录（`filesDir/runtime/lkg/lkg.json`，格式与 `LastKnownGood.kt` 的 `load` / `save` 一致：启用的组合包、已装的包和版本、`cordis.patch.yml` 设置层）。所以导入后出问题，安全模式里的「恢复上次正常的配置」回到导入前；导入的配置自己在重启后健康跑满两分钟，原生代码会照常把它记成新的「上次正常」。技能和 AGENTS.md 不在那份记录里：被替换的文件先复制到 `/root/.dsh/backups/share-import-<时间>/`（不是技能根目录，不会被加载）。AGENTS.md 的备份目录在时间后附加唯一后缀，每次导入分别保留，避免同一秒内再次导入时覆盖旧备份。

远程主机没有还原点（安全模式是本机功能）。

## 5. 着陆页

`site/share/`：一个 `index.html`（样式内联）+ `share.js`，不用构建。读 `#p=` / `#gist=`，在浏览器里解压、校验、显示卡片（名称、来源、版本、里面有什么），两个按钮：「用 dsh-go 打开」（`dshgo://…`）、「下载 dsh-go」（`github.com/ccch1mneyyy/dsh-go/releases/latest`）。浅色 / 深色跟系统。

- 不上传任何东西；CSP 只允许自己的脚本，`connect-src` 只有 GitHub API（Gist 链接要取 Gist）。所有数据用 `textContent` 写进页面。
- 微信内置浏览器打不开自定义 scheme：检测到时提示在浏览器中打开。
- 浏览器不支持 `DecompressionStream` 时不显示内容，仍给「用 dsh-go 打开」。

## 6. App Links（https 直接进 App）

现在只有 `dshgo://` 和文件能直接进 App；https 链接先到着陆页。要让 `https://<域名>/…/share/` 直接打开 App：

1. 定下域名，改 `shareLandingUrl`；
2. 在 `https://<域名>/.well-known/assetlinks.json` 放 `delegate_permission/common.handle_all_urls`，`package_name: io.github.ccch1mneyyy.dsh_app`，`sha256_cert_fingerprints` 填发布签名证书的指纹（GitHub Pages 的项目页做不到——`.well-known` 必须在域名根上，要用 `ccch1mneyyy.github.io` 用户站或自有域名）；
3. Manifest 里 `LinkTrampolineActivity` 加 `<intent-filter android:autoVerify="true">`：VIEW + DEFAULT + BROWSABLE，`scheme="https" host="<域名>" pathPrefix="/…/share"`。

`LinkRouter` 已经按 `<host>/<path>` 注册了着陆页路由，第 3 步之后不用改 Dart。

## 7. 其他功能怎么接链接（`app/lib/links/app_links.dart`）

```dart
final router = ref.read(linkRouterProvider);
final off = router.registerLinkHandler('forum/auth', (uri) async { …; return true; });
router.registerFileHandler('dshgo', (fileUri) async => …);
router.context; // home 路由下的 BuildContext，开弹层用
```

- 按 host（可带路径前缀，最长匹配优先）路由；https 链接的 host 就是网址的 host。返回 false 或抛异常 → 「无法打开这个链接」。
- 每个链接只派发一次，包括冷启动的那个；home shell 出现前到的链接排队；没有处理器的链接最多等 4 秒（从 home shell 第一次出现算），所以处理器要在启动时注册（home shell 里的 widget 或它读的 provider），不要等页面打开。
- 保留的 host：`share`（分享码）、`forum`（社区登录）。

## 8. 对话文件与回放

> 2026-10-25。把一段对话分享出去：对方用 dsh-go 打开能回放、接着聊；没装 App 的人用浏览器看。三种形式共用一份文件：`.dshgo` 文件、自包含 `.html`、托管链接（端到端加密）。

| 部分 | 文件 |
|---|---|
| 格式、编解码、图片 | `app/lib/share_code/conversation_share.dart` |
| 从聊天导出 | `conversation_export.dart`、`conversation_redact.dart`、`image_shrink.dart`、`jpeg_encoder.dart` |
| 自包含网页 | `conversation_html.dart`、`replay_viewer.g.dart`（生成） |
| 回放页 | `app/lib/ui/replay/`（`replay_timeline.dart`、`replay_frame.dart`、`replay_list.dart`、`replay_page.dart`、`continue_chat.dart`） |
| 分享面板 | `app/lib/ui/share/share_panel.dart`、`share_panel_pages.dart`、`ui/replay/conversation_out.dart`（见 [share-redesign.md](share-redesign.md)） |
| 网页查看器 | `site/share/viewer.js`、`viewer.css`、`viewer.html`（页面骨架），构建：`app/tool/make_replay_viewer.py` |

### 8.1 格式

文件外层和 §2 一样是可读的信封，多了 `assets`：

```json
{"dshgo": 2, "kind": "conversation", "name": "修复登录重复提交",
 "code": "<base64url(deflate-raw(body))>.<sum>",
 "assets": {"<id>": {"type": "image/jpeg", "w": 1600, "h": 900, "data": "<base64>"}}}
```

- `code` 里的正文用 §2 的编码；`v: 2`。插件 / 配置仍写 `v: 1`，所以旧版 App 读到对话会说「需要更新」，而不是「已损坏」。正文解压上限 16 MB（插件和配置仍是 1 MB）。
- 图片不进正文，放在 `assets` 里，按内容命名：`id` = base64url(SHA-256(bytes) 前 9 字节)，12 个字符。读的时候逐张校验，对不上的图丢掉，其余照常打开；正文没用到的图不写。
- 整个文件上限 4 MB（`maxConversationFileBytes`，安卓「打开方式」能交给 App 的上限，`LinksPlugin.kt`）。

正文是**规范化 schema**，不是 DSH 的原始事件，App 和网页都只认它：

```json
{"v": 2, "kind": "conversation", "schema": 1,
 "title": "…", "model": "deepseek-v4-pro", "app": "dsh-go 1.0.0",
 "created": "…Z", "start": "…Z",
 "range": {"from": 2, "to": 3, "of": 5},
 "include": {"thinking": false, "tools": true},
 "entries": [ … ]}
```

- `start` 是时间原点，每条的 `t` 是相对它的毫秒数，`d` 是持续毫秒数（可缺）。`range` 只在分享一部分时出现；`include` 只在去掉了思考或工具输出时出现。
- `schema` 是这份结构的版本。只加字段、加条目类型不升版本（读的人跳过不认识的类型）；改了含义才升，旧读者拒绝并提示更新。

| `type` | 字段 | 说明 |
|---|---|---|
| `turn` | `t` `d` `end` `steps` `tokens` | 一轮开始（排在它的提问前面，和 DSH 记日志的顺序一致）；`end` 是结束原因，没有 = 导出时还在跑 |
| `user` | `text` `images[{id,w,h,name}]` `files[{name,size}]` `source` | 提问；文件只带名字和大小；`source` 不是人发的时候才有（`goal`、`schedule`） |
| `reply` | `t`(首个 token) `d`(流式用时) `think` `text` `plain` `model` `cut` | `text` 是 App 渲染的 Markdown（含可视化回复）；`plain` 是把可视化块换成一行摘要的版本，只在有可视化块时出现，给网页用 |
| `tool` | `name` `args` `summary` `verb` `status` `result` `more` `error` | `status`：`ok` `failed` `denied` `cancelled`；`summary` / `verb` 是 App 工具行上那一行字；`result` 首尾保留、中间截断，`more` 是截掉的字数 |
| `notice` | `kind` `text` | 出错、已停止、重试… |
| `todos` | `items[{text,status}]` | 待办整张替换；下一轮开始时清空（与 DSH 投影一致） |
| `goal` | `text` `phase` | `text` 缺省 = 目标清除 |
| `command` | `line` `ok` `text` | 斜杠指令和结果 |

为什么这样定：App 回放要把条目还原成聊天自己的行（`ChatItem` / `TurnTrace`），所以留着工具参数、轮的起止和步数；网页没有 App 的工具视图和可视化渲染，所以导出时把「工具行那一行字」和「可视化摘要」预先算好放进去。两边因此看到同一份东西，而原始事件里的签名、请求头、子代理细节一概不带。

### 8.2 导出

入口：分享面板（[share-redesign.md](share-redesign.md)）的「链接」「文件」「文字」。回复下方的分享键、长按菜单、抽屉、回放里的回复都打开它（`share_entry.dart`）。

- 先把整段历史读全（`loadOlder` 到头），图片读出来缩小一次（长边 ≤ 1600；已经够小的 PNG / JPEG / WebP 原样保留，透明图转 PNG，其余用纯 Dart 编码 JPEG q82）。
- 范围：这条回复（和上面的提问）、选中的消息、整段对话（`ConversationExport.build(only:)`）。选中消息时只收选中的提问和回复，工具、待办、目标只收选中回复所在的轮；`range` 记录覆盖到的轮次。一轮 = 一条提问到下一条提问之前；轮的开始取它那一轮的 `turn/start`。
- 包含：思考过程、工具调用（关掉时整条调用连同参数、结果、待办、目标都不带）、图片（关掉时提问图片的引用和资产都不进文件）。打码始终进行（§8.3）。
- 预览：用接收方看到的同一个回放页打开（没有「接着聊」）。
- 文件形式：对话文件 `.dshgo`、网页 `.html`、Markdown（「接着聊」那份整理，不带思考和工具输出）。
- 超过 4 MB（对话文件、网页、链接）：一行「超过 4 MB，请缩小范围」，按钮不可用。

### 8.3 打码（`conversation_redact.dart`）

进文件的每一段文字都过一遍——消息、思考、工具参数和输出、提示、待办、目标、文件名：

- 凭据：聊天里遮挡用的那套识别（`sk-…`、`ghp_…`、JWT、私钥块、URL 里的密码），外加「名字像密钥的赋值」（`API_KEY=…`、`"password": "…"`），`$VAR`、`<token>` 这类占位不动；
- 家目录：`/home/<名字>`、`/Users/<名字>`、`C:\Users\<名字>` → `~`。`/root` 保留：手机引擎都是它，说明不了任何人；
- App 私有目录 `/data/user/0/<包名>`、`/data/data/<包名>` → `…`；
- 回复里的图片 `![alt](…)` 换成 `〔alt〕`：查看方不发任何请求，本机路径在别处也没意义。

### 8.4 网页查看器

一份源码（`site/share/viewer.js` + `viewer.css`），三种来源，由 `DshgoViewer.boot()` 判断：

| 来源 | 页面 | 数据从哪来 |
|---|---|---|
| 本地文件 | 着陆页 `index.html`（没有 `#` 参数时） | 选择或拖入 `.dshgo` |
| 自包含网页 | App 导出的 `.html` | 页面里的 `<script type="application/json" id="dshgo-data">` |
| 托管链接 | 分享域名的 `/c/<id>`（构建出的 `c.html`） | `GET /api/v1/c/<id>`，用 `#k=` 解密 |

`app/tool/make_replay_viewer.py` 把源码内联成两个页面：`replay_viewer.g.dart`（App 填入标题和数据，`connect-src 'none'`）和 `<out>/c.html`（`connect-src 'self'`），并把着陆页文件一起拷到 `<out>/`（默认 `site/build/share/`，由分享服务发布）。内联脚本用 CSP 哈希锁定；数据只以文字节点和 `data:` 图片进入页面；嵌入的 JSON 把 `<` `>` `&` 转义。`test/share_code/replay_viewer_sync_test.dart` 检查生成文件和源码一致；`node site/share/test/viewer_test.mjs` 检查网页的解码、校验、解密，以及回放节奏与 App 逐项相同（共用 `app/test/replay/fixtures/timeline.json`）。

Markdown 和代码高亮是查看器自带的轻量实现（标题、列表、引用、表格、代码块、行内格式、链接只放 http(s) / mailto），不依赖 CDN。

### 8.5 回放节奏（`replay_timeline.dart` 与 `viewer.js` 的 `timeline`，常量一致）

按原时间戳排，长等待压短、短的照旧：

1. 两段之间的空闲 `g`：≤ 500 ms 照旧，超出部分 × 0.2；一轮之内封顶 1.6 s，提问和一轮开始之前（人在打字）封顶 0.9 s。
2. 和前面还在跑的东西重叠的条目（并行的工具调用）：比上一条晚 120–400 ms 出现，依次出来。
3. 回复：思考按原用时，夹在 0.6–2.4 s；正文按原流式用时，但不慢于 30 字/秒、不快于 500 字/秒，最长 6 s，最短 0.3 s；没有用时按 80 字/秒估。文字按字符逐步出现，带光标。
4. 工具：≤ 300 ms 照旧，超出部分 × 0.15，夹在 0.25–2.5 s；运行中转圈，结束显示结果。
5. 一轮在它最后一段结束后 150 ms 收尾：收起过程、出脚注，和聊天里看着一轮结束一样。
6. 倍速 1× / 2× / 4× 只改时钟快慢；拖进度条直接跳到那一刻（不播动画）；「全文」跳到结尾并停下。

### 8.6 托管链接

服务端、Dart 客户端和「我的分享链接」见 `docs/design/share-links.md`，接口以 `services/share-worker/` 的实现为准。本节只讲 App 一侧：分享面板的「链接」：有效期 7 天 / 30 天（默认）/ 永久，生成后复制、二维码、分享、停止分享（确认后 4 秒内可撤销，之后向服务端删除，与「我的分享链接」的删除同一路径），一行「端到端加密，服务器看不到内容」，页底「我的分享链接」；上传的是 §8.1 的文件原样（UTF-8），由客户端 gzip + AES-256-GCM 加密，密钥只在链接 `#k=` 里。App 里经 `conversationLinkMakerProvider`（`conversation_out.dart`，默认是 `ui/share_hosted/hosted_link_maker.dart` 的适配，生成的链接都记进「我的分享链接」）；provider 为 null 时面板不出现「链接」。上传失败显示客户端给的那句话（网络、太大、太频繁…）。查看器的解密：`"DSG1"` + 12 字节 IV + 密文（含 tag），解出后 gunzip，按 §8.1 读。

### 8.7 App 里打开

`.dshgo` 文件（打开方式 / 系统分享进来）和 `dshgo://share/…` 链接都经 `share_code_host.dart`：先读信封，正文 `kind: conversation` 的进「对话回放」（`replay_page.dart`），其余照旧进导入确认。

回放页：顶栏返回 · 标题 · 全文；下面一枚胶囊：播放 / 暂停、进度条、时间、倍速。列表用聊天自己的行组件画（`deriveRows` + 同样的行组件和间距），图片从文件里读；待办和目标条跟着回放时刻变化。底部主按钮「接着聊」：新建对话，把这段对话整理成 Markdown（提问、回答、每次工具调用一行；不带思考和工具输出）作为附件，输入框预填「接着附件里这段对话聊：」，由人改完再发。DSH 没有导入对话的接口，所以不能原样续上同一个对话。
