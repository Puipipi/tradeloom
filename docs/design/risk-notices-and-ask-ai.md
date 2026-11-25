# 风险提醒与「问 AI」

> 2026-10-27 · 范围：危险 / 敏感操作前的统一提醒；不懂的地方一键「问 AI」（走内置的 dsh-go-guide 技能）。

**结论**：风险提醒只在改变 AI 行为边界或授予系统权限的那一刻出现，分三档：高风险每次确认、中风险首次确认（「不再提示」默认勾上）、低风险就地说明。高、中两档用同一个底部弹层 `confirmRisk`（S9 的 `SheetDismissal.button`：标题 + ×，一句后果，一个写着具体动作的主键，可选的「不确定？问 AI」）。删除类沿用已经统一的居中确认框，只修颜色。

「问 AI」不直接发送，而是新开一个对话，把问题预填进输入框。本机引擎上问题前面加 `/dsh-go-guide`，保证加载使用说明。远程主机上没有这个技能，所以 App 把对应的说明页作为附件带上；主机不收文件时，在输入框上方提示一句。入口只放在五类地方：风险提醒、开启手机操控前的披露、手机操控 / 插件 / 远程主机三个页面的顶栏，以及设置里的「使用帮助」。

## 1. 现状清单

`lib/` 下（不含分享、引导页、插件视图等别的代理在改的目录）一共 42 处确认，39 处是 AlertDialog，3 处是弹层。下表只列和风险有关的部分；删除类整体单列在 §1.2。

### 1.1 风险与权限

| 操作 | 位置 | 有没有确认 | 写法 |
|---|---|---|---|
| 首次开启手机操控 | `phone/phone_control_screen.dart` `_onToggle` → `phone_disclosure_sheet.dart` | 有，只在第一次（`disclosureAccepted`） | 拖拽弹层，五条披露，「先不开 / 同意并开启」 |
| 确认方式 → 本任务免确认 | 同上，`_pickConfirmMode` | 没有（有意为之：每个任务开始时仍问一次，测试 `phone_confirm_mode_test` 写明了） | — |
| 确认方式 → 始终免确认 | 同上 | 有 | AlertDialog，警示图标，红底按钮但**没设 onDanger 前景色**，按钮是笼统的「开启」 |
| 应用名单放宽（不碰 → 照常，逐步确认 → 照常） | `phone/app_rules_page.dart` `confirmLoosening` | 有 | AlertDialog，警示图标，按钮**用主色**，「我知道风险，仍然修改」；正文两段 |
| 无障碍「去开启」 | `phone_control_screen.dart` `_openA11y` | 跳转前没有说明 | 披露里已经讲过看屏幕和点按，不需要再拦 |
| 宠物「App 外显示」→ 悬浮窗权限 | `pets/overlay_settings_tile.dart` → `PetOverlayController.turnOn` | **没有**，直接跳系统设置 | — |
| 设置 › 自动执行命令 | `settings/settings_screen.dart` `_onAutoApprove` | 有，只在打开时 | AlertDialog，红底按钮，按钮是笼统的「开启」 |
| 权限预设 → 完全权限 / 自动审查 | `features/permission_page.dart` `_confirm` | 有 | AlertDialog，红底按钮，「开启」；完全权限的文案和上一行是两套 key，中文一样 |
| 审批卡「本对话都允许」 | `chat/widgets/approval_card.dart` `_allowAll` | **没有** | 一点就打开整个对话的自动允许 |
| 设置 › 访问手机文件 | `settings_screen.dart` `_onPhoneStorage` | 有 | AlertDialog，**主色按钮**，图标是存储图标，正文两段 |
| 插件市场安装第三方插件 | `plugins/plugin_detail_sheet.dart` | 弹层里常驻一条琥珀色说明（低档，已就地） | `PluginTrustNote` |
| 允许构建脚本 | `plugins/plugin_actions.dart` `approveBuildsAndRetry` | 有 | AlertDialog，主色按钮，带软件包列表 |
| SSH / Relay 首次信任指纹 | `remote/host_key_dialog.dart` | 有 | 锁住遮罩的 AlertDialog，「信任并连接」；指纹变了时用红底「重新信任」 |
| 重置 SSH 指纹 | `remote/ssh_host_form.dart` | 有 | AlertDialog，**主色按钮**（和 Relay 的「重新信任」不一致） |
| 公开分享链接 | `ui/share/` 等 | 另一个代理在重设计，这里只给建议（§6） | — |

### 1.2 删除与不可恢复

工作区移除、插件卸载、Cordis 移除、预设、定时任务、渠道、SSH 主机、Bot / 群聊、托管链接、清除 API Key、重置 / 卸载运行环境，都已经有确认，几乎全部是「红底 + onDanger + 具体动词」的 AlertDialog。对话只能归档，归档有撤销提示，不需要确认。

写法不一致的地方：

- 只设了红底、没设 onDanger 前景色：始终免确认、移除工作区、关闭运行中的终端标签。
- 同等风险却用主色：应用名单放宽、访问手机文件、重置 SSH 指纹。
- 按钮写「开启」而不是具体动作：始终免确认、自动执行命令、完全权限、自动审查。

没有确认的删除：Bot 记忆、移除群成员、引擎设置里密钥和列表项的「移除」。这些不在本次范围内，见 §6。

## 2. 分级

| 档 | 什么时候用 | 交互 | 「不再提示」 |
|---|---|---|---|
| **高 · 每次确认** | 放开一整类保护（AI 不再问你），或让 AI 能动手机上的私人数据 | 底部弹层，红色主键写具体动作 | 没有：这些开关一年也拨不了几次，每次都问不打扰；一旦误开，代价是 AI 在没人看着时删文件、发消息 |
| **中 · 首次确认** | 风险有边界（只限这个对话），或只是跳去系统设置授权 | 底部弹层，主色主键；「不再提示」默认勾上 | 默认勾上，所以默认只提醒一次；取消勾选就下次还问；点 × 或返回不记 |
| **低 · 就地说明** | 结果写在入口旁边就够 | 不弹层，入口的副标题或页脚一句话 | 不需要 |

分级结果：

| 操作 | 档 | 理由 |
|---|---|---|
| 始终免确认 | 高 | 打开 App、点按、发送、删除都不再问 |
| 应用名单放宽 | 高 | 银行支付类 App 可能冻结账号，后果在 App 外 |
| 自动执行命令 / 完全权限 | 高 | 命令和改文件不再问 |
| 访问手机文件 | 高 | 相册、文档可被读写 |
| 允许构建脚本 | 高 | 以 DSH 权限执行第三方脚本；保留原对话框，带软件包列表 |
| 自动审查 | 中 | 仍有模型把关，只是可能误判 |
| 本对话都允许 | 中 | 只限这个对话，重启 App 就恢复；但常用，所以只提醒一次 |
| 宠物显示在其他应用上层 | 中 | 只是跳系统设置授权，说明一次就够 |
| 选用 root 通道（不打扰模式 › Root、自动恢复无障碍 › 申请 root 授权，`phone.root`） | 中 | 接下来是 root 管理器自己的授权弹窗；不放开 DSH 的任何规则，说明一次就够 |
| 首次开启手机操控 | 中（保留现有披露） | 合规要求的显著披露，比一句话完整，内容不动，只加「问 AI」 |
| 本任务免确认 | 不拦 | 每个任务开始时仍会问一次；保持现有行为 |
| 无障碍「去开启」 | 不拦 | 披露已讲过；再拦一次就成了二次打断 |
| 第三方插件安装 | 低（现有） | 详情里常驻的说明就在安装键上方 |
| 删除类 | 高（现有对话框） | 已统一，只修颜色 |
| 首次信任主机指纹 | 高（现有对话框） | 已统一且锁住遮罩；重置 SSH 指纹改成红色，和「重新信任」一致 |

## 3. 组件

### 3.1 `confirmRisk`（`lib/ui/common/risk_notice.dart`）

```
╭──────────────────────────────────────────╮
│ 始终免确认？                          (×) │  SheetHeader，20 内缩
│ 打开 App、点按、发送、删除都直接做，       │  bodyLarge · onSurfaceVariant
│ 不再问你。                                │
│ ☑ 不再提示                                │  只有中档
│ ┌──────────────────────────────────────┐ │
│ │              始终免确认               │ │  48 高，左右各 20，高档红底
│ └──────────────────────────────────────┘ │
│              ✦ 不确定？问 AI              │  居中，左右内边距相等
╰──────────────────────────────────────────╯
```

- 用 `showAppSheet(dismissal: SheetDismissal.button)`：不能拖走，也不能点遮罩关；× 和系统返回都算「不做」。
- 只放一个主键，没有「取消」键：取消由 × 承担，和 S9 锁定弹层的规则一致，也避免两个取消。
- 中档的「不再提示」默认勾上。确认时勾着，就记下这个提醒的 id，以后直接放行；取消勾选再确认，下次还会问。
- 点「问 AI」：弹层关闭、操作不执行，然后照 §4 去新对话。
- 存储：`SharedPreferences` 的 `risk_notice.silenced`（字符串列表），由 `riskNoticeStoreProvider` 提供，测试可替换。
- 测试里量的几何：主键左右各 20、宽度等于弹层宽减 40；勾选框可见方块的左边和主键左边对齐；「问 AI」的中心在弹层中线上，左右内边距相等；320dp 宽、1.3× 和 2× 字号下不溢出、不截断。

### 3.2 统一已有的确认

- 高档的五处 AlertDialog（始终免确认、应用名单放宽、自动执行命令、完全权限、访问手机文件）和中档的自动审查，都改用 `confirmRisk`。行为不变：确认就做，其他都不做。
- 删除类保持 AlertDialog：确认对象有名字、动作单一，居中对话框更直接，也没有「问 AI」的必要。只补上缺的 onDanger 前景色（移除工作区、关闭终端标签），并把重置 SSH 指纹改成红色。

## 4. 问 AI

### 4.1 机制

点任何「问 AI」入口，依次做这几件事：

1. 有未保存的编辑时，先问「放弃修改？」（`DiscardGuard.confirmLeave`）。
2. 关掉上面所有页面和弹层，回到聊天（侧栏已在打开页面时收起）。
3. 往 `composeInboxProvider` 推一个 `ComposeRequest`。聊天页把它放进**新对话**的输入框：接在已有草稿下面，不覆盖；聚焦，不发送。分享、启动器快捷方式用的是同一条路。

**为什么预填而不直接发**

- 发出去要花钱，也会占一个对话，应该由用户决定。App 里的「帮我修复」、社区玩法、分享进来的文字都是只填不发，「问 AI」保持一致。
- 用户常常想把问题改得更具体，比如「我的 vivo 上无障碍开不了」。直接发出去就没有这个机会了。
- 当前主机可能是一台远程主机，或者引擎还没起来。只填不发，用户能先看清这条消息要发到哪儿。

### 4.2 问题怎么拼

| 当前主机 | 输入框里的内容 | 说明 |
|---|---|---|
| 本机引擎（自动装好了 dsh-go-guide） | `/dsh-go-guide 手机操控是怎么工作的？有什么风险？` | `/名字` 就是 App 里「技能 › 在对话里用」的写法，主机看到它会加载技能，回答照说明来。 |
| 远程主机，能收文件（SSH） | 「关于 dsh-go App：{问题}\n请按附件里的使用说明回答。」＋ 附件 `dsh-go-guide-<主题>.md`（App 自带的那一页说明，按界面语言选中文或英文） | 远程主机没有这个技能，App 把对应的说明页附上，模型照样有依据。 |
| 远程主机，不能收文件（DSH Remote） | 「关于 dsh-go App：{问题}」 | 输入框上方提示一次：「这台主机没有 dsh-go 使用说明，回答可能不准确」。 |
| 网页模式 | 入口不显示 | 网页模式下首页是网页版，原生输入框不在。 |

### 4.3 入口与问题

只在使用说明讲到的地方放入口。自动审查、引擎设置的各分项、性能模式，使用说明里还没有写，问了只会得到「说明里没有写到」，所以先不放。

| 入口 | 形式 | 问题（中） | 问题（英） | 远程附带的说明页 |
|---|---|---|---|---|
| 设置 › 关于 › **使用帮助** | 设置行，✦ 图标，副标题「不懂的地方，问 AI」 | dsh-go 能做什么？我该从哪里开始？ | What can dsh-go do, and where should I start? | 10-settings |
| 手机操控页顶栏 | ✦ 玻璃圆键（44，和返回键镜像） | 手机操控是怎么工作的？有什么风险？ | How does phone control work, and what are the risks? | 04-phone-control |
| 开启手机操控前的披露 | 「不确定？问 AI」 | 同上 | 同上 | 04-phone-control |
| 插件页顶栏 | ✦，放在刷新键左边 | 插件能做什么？装第三方插件要注意什么？ | What can plugins do, and what should I watch for with third-party ones? | 08-plugins |
| 远程主机页顶栏 | ✦ | 怎么连接自己的电脑或服务器？和用本机有什么不同？ | How do I connect my own computer or server, and how is that different from this phone? | 03-engine-hosts |
| 风险提醒：始终免确认 | 「不确定？问 AI」 | 手机操控选「始终免确认」会怎样？和「每次都询问」比风险在哪？ | What changes with “Always skip confirmation” in phone control, and how is it riskier than asking each time? | 04-phone-control |
| 风险提醒：应用名单放宽 | 同上 | 手机操控的应用名单有什么用？放开银行、支付类 App 有什么风险？ | What is the app list in phone control for, and what are the risks of allowing banking and payment apps? | 04-phone-control |
| 风险提醒：自动执行命令 / 完全权限 | 同上 | 「自动执行命令」打开后会怎样？有什么风险？ | What happens when “Auto-run commands” is on, and what are the risks? | 10-settings |
| 风险提醒：访问手机文件 | 同上 | 「访问手机文件」打开后，AI 能读写哪些文件？怎么关掉？ | With “Access phone files” on, which files can AI read and change, and how do I turn it off? | 10-settings |
| 风险提醒：本对话都允许 | 同上 | 「本对话都允许」会放行哪些操作？怎么关掉？ | What does “Allow for chat” let through, and how do I turn it off? | 01-chat |

**取舍**

- 顶栏的 ✦ 只放在三个功能最复杂、也最容易出事的页面上。其他页面都不加，免得每页右上角都有一颗星。
- 设置首页不放顶栏键，而是在「关于」里加一行带文字的「使用帮助」。想找帮助的人会去「关于」里找，带文字的一行也比一颗星更容易看懂。
- 风险提醒里的「问 AI」放在主键下面，用小字。它是犹豫时的出路，不和主键抢视觉重心。
- 宠物悬浮窗和自动审查的提醒不放「问 AI」：前者只是去系统设置授权，后者说明里没有写到。

## 5. 文案（终稿）

所有文案都在 `lib/l10n/parts/risk_{zh,en}.arb`。沿用的旧 key 只改写正文，标题不动，因为使用说明里引用了这些标题（例如 **开启完全权限？**）。

| 提醒 | 标题 | 正文 | 主键 |
|---|---|---|---|
| 始终免确认（高） | 始终免确认？ / Always skip confirmation? | 打开 App、点按、发送、删除都直接做，不再问你。 / Opening apps, tapping, sending and deleting will happen without asking you. | 始终免确认 / Skip confirmation |
| 应用名单：不碰 → 照常（高） | 让 DSH 操作「{app}」？ | 银行、支付类 App 会检测自动操作，可能限制登录甚至冻结账号；DSH 仍不会输密码、不会付款。 / Banking and payment apps detect automation and may restrict sign-in or freeze your account. DSH still won’t enter passwords or pay. | 我知道风险，仍然修改 / Change anyway（使用说明里引用了，不改） |
| 应用名单：逐步确认 → 照常（高） | 「{app}」不再逐步确认？ | 微信这类 App 有风控，曾有手机助手操作后账号被强制下线；发消息等仍会先问你。 / Apps like WeChat watch for automation and have signed accounts out; sending messages still asks you first. | 同上 |
| 自动执行命令 / 完全权限（高） | 开启完全权限？ / Turn on Full access? | AI 执行命令、改动文件前不再问你。 / AI won’t ask before running commands or changing files. | 开启完全权限 / Turn on Full access |
| 访问手机文件（高） | 让 AI 访问手机文件？ / Let AI access phone files? | AI 能读取和修改相册、下载、文档等手机文件，引擎会重启一次。 / AI can read and change your photos, downloads and documents. The engine restarts once. | 允许读写 / Allow access |
| 自动审查（中） | 开启自动审查？ / Turn on Auto review? | 每次操作由模型判断放不放行，可能误判。 / The model decides whether to allow each action. It may get it wrong. | 开启自动审查 / Turn on Auto review |
| 本对话都允许（中） | 本对话都允许？ / Allow everything in this chat? | 这个对话之后的命令和改动都直接放行，可在输入框上方随时关闭。 / Commands and changes in this chat run without asking. Turn it off above the message box anytime. | 全部允许 / Allow all |
| 宠物显示在 App 外（中） | 显示在其他应用上层？ / Show over other apps? | 要在系统设置里为 dsh-go 打开「显示在其他应用上层」，宠物才能出现在别的 App 上。 / Turn on “Display over other apps” for dsh-go in system settings so your pet can appear outside the app. | 去设置 / Open settings |

通用：「不再提示 / Don’t show again」「不确定？问 AI / Not sure? Ask AI」「问 AI / Ask AI」「使用帮助 / Help」「不懂的地方，问 AI / Ask AI about anything here」。远程提示：「这台主机没有 dsh-go 使用说明，回答可能不准确 / This host doesn’t have the dsh-go guide, so answers may be off」。

## 6. 不在本次范围，给出建议

- **公开分享链接（另一个代理）**：建议归中档。第一次生成公开链接时用 `confirmRisk` 说一句「拿到链接的人都能看到这段对话，包括其中的文件内容」，主键写「生成链接」，默认只提醒一次。删除链接已经有确认和撤销，保持不变。
- **引导页（另一个代理）**：引导的最后一步可以加一行「不懂的地方，随时问 AI」，点了打开 §4.3 的总问题。这是唯一一处能主动告诉新用户「可以问 AI」的地方。
- **聊天空状态**：可以把四个建议之一（例如「rebase 还是 merge」）换成「dsh-go 怎么用」，提示词带 `/dsh-go-guide`。这是曝光最高的入口，但会改动首屏和一批 golden，需要 owner 拍板。
- **没有确认的删除**：Bot 记忆删除、移除群成员、引擎设置里密钥的「移除」，建议给撤销提示，而不是确认框，保持轻量。
- **「重置提醒」**：中档提醒一旦选了不再提示，现在没有恢复的入口。用的人少，先不做；需要时可以在「关于」里加「重置所有提醒」。
- **使用说明**：如果要放开引擎设置和性能页的「问 AI」，先在 `docs/guide/` 补上对应章节，再运行 `python3 app/tool/guide_sync.py` 生成 `app/assets/skills/dsh-go-guide/`。

## 7. 测试

- `test/common/risk_notice_test.dart`：两档的显示规则；「不再提示」默认勾上、取消勾选、× 不记、重启后仍然生效；「问 AI」不执行操作并发出问题；对称测量；320dp × 1.3 / 2 字号不溢出、不截断；浅色和深色 golden。
- `test/state/ask_ai_test.dart`：本机、SSH、Relay 三种主机拼出的内容；附件内容就是对应的说明页；网页模式下入口隐藏。
- 各入口：始终免确认、应用名单放宽、自动执行命令、访问手机文件、权限预设、本对话都允许、宠物悬浮窗都能到达对应的提醒；三个顶栏、设置行、披露里的「问 AI」都会关闭页面，并把正确的问题放进新对话。
