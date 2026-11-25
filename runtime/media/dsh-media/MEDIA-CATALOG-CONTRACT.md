# MEDIA-CATALOG-CONTRACT · v1 / 插件 0.3.0

本文件是 App 读取插件目录与配置的契约，不修改冻结的 tool/result.meta["dsh-go/media"] v1。状态：插件 0.3.0 的 Node 测试已通过；0.2.0 的真实 rc.4 headless 结果见 VERIFICATION.md，0.3.0 未重跑 headless。真实 settings RPC、App 与真机仍 UNRUN。§2、§5 的源码位置取自 DSH 0.2.1-rc.2（git 687f282e8625c6b8d11ff58211a90524be2e4317）和 2026-10-28 的 App 源码，行号以后可能偏移。

## 1. 唯一目录位置

目录位于插件 namespace schema 中 services 字段本身的：

    schema.fields["services"].meta.extra["dsh-go/media/catalog"]

这是 App 解析后的 SchemaNode 访问位置。原始 Schemastery JSON 采用 {uid,refs} 图结构，不能硬写 JSON 根 dict 路径或固定数字 uid。先解析 graph，再找 services。由于本候选 services 为 transform(array)，目录在外层 services.meta.extra，不能只读取 services.effective.meta.extra；effective array 不一定携带外层 metadata。

目录形状：

    {
      v: 1,
      revision: "2026-11-01.0.3.0",
      asOf: "2026-11-01",
      contract: "dsh-go/media/catalog",
      capabilities: {tools:["generate_image","edit_image","generate_video","get_media_result","resume_media"],commands:[],image:true,video:true,edit:true},
      limits: {maxN:4,promptUtf8Bytes:4096},
      availability: "...",
      sources: [...],
      models: [...],
      presets: [...]
    }

0.2.0 增加可选 video 字段 `durations`、`resolutions`、`videoSizes`、`defaultSize`、`requiresRef`，以及编辑专用 `editOnly`。`profiles` 给出已核原生端点、queryPath 和取消能力；它们是 Host 适配数据，不允许 App 或模型传任意 API 字段。未列的时长/分辨率须省略，不能猜默认值。目录缺少价格即未知。

models 含 id、label、kind、profile、ratios、sizes、aspectSizes、qualities、maxN、maxRefs、edit、extend、upscale、sources。不存在 price 时表示未提供可靠价目。布尔能力与 maxN 是插件开放子集；不得推断供应商无其他能力。

可选 responseFormats 字段：存在时是该模型服务配置必须显式选择的返回格式白名单；缺失时仍遵从 profile 的既有规则，GPT Image 必须省略 responseFormat。它不是工具参数，也不授权模型改变服务返回格式。ratios/sizes/qualities 的空数组与空 aspectSizes 表示插件没有开放已核值；App 应允许省略该参数，不制造默认值，不显示空选择器。所选模型 maxN=1 时不能根据目录顶层 maxN=4 显示 2–4 张为可用。

### presets（0.3.0 新增，App 可选）

根节点 `presets` 是可选的 ≤16 项数组，提供“新建服务”模板。每项字段：

    {id, label, labelEn?, provider, profile, baseUrl, responseFormat, models, kind, keyGroup}

- `id` 与 `keyGroup`：`^[a-z][a-z0-9-]{0,31}$`，`id` 唯一。同一 `keyGroup` 的图片和视频预设期望共用同一个凭据。
- `label` 中文非空 ≤80 字节；`labelEn` 可选英文非空 ≤80 字节；`provider` 仅用于展示。
- `profile` 必须属于目录 `profiles`（或内建 `openai-compatible` / `openai-gpt-image`）；`baseUrl` 与服务一样只接受 HTTPS，不允许认证信息、query 或 fragment，原生 profile 还必须落在目录声明的主机或工作空间后缀。
- `responseFormat` 为 `"" | "url" | "b64_json"`；非 `openai-compatible` 必须为空。
- `models` 为 1..16 个目录模型 ID，必须与预设的 `profile` 和 `kind` 一致。App 仍应与已安装目录及当前服务 value 求交，不能只信预设。
- `kind` 为 `image` 或 `video`。

App 可以用预设填入服务 ID、协议、API 根地址、返回格式和模型列表；保存前仍按本契约校验。0.2.x 目录没有该字段：读到缺失或非法的 `presets` 时应忽略预设并退回手动流程，而不是让设置页不可用。未知字段忽略。

### defaults（0.3.0 扩展）

`value.defaults` 在旧版 `serviceId` / `modelId` 之外新增：

    {imageServiceId, imageModelId, videoServiceId, videoModelId}

四个字段都是可选字符串，空串表示未设置。`generate_image` / `edit_image` 先使用图片默认服务与模型，`generate_video` 先使用视频默认服务与模型；类型默认解析不到时回落到旧版 `serviceId` / `modelId`，再回落首个可用候选。旧版只写 `serviceId` / `modelId` 的配置行为不变。App 应把默认值绑定到发起时的 Host / namespace / service / model 身份；字段缺失视为空，不推断旧服务。

默认 bundle 的 entry ID 是 dsh-media，但 Host 可以另命名实例。客户端应在选定 Host 的 settings namespaces 中按 metadata 契约发现，保留 namespace 身份；多个实例不得按同名 label 合并。

## 2. 源码链已经确认的内容

| 环节 | 精确位置（DSH rc.2；标 App 的为 App 源码） | 所支持结论 |
|---|---|---|
| metadata 写入 | vendor/schemastery/src/index.ts:385–388 | extra(key,value) 合并 schema.meta；本候选使用 extra('extra', {...}) |
| JSON 序列化 | 同文件:311–321 | toJSON 用 schema 属性和 refs 序列化，plain JSON extra 被保留 |
| volatile projection | packages/settings/settings/src/schema.ts:plainSchema / volatileForm | services 自身 volatile，因此 clone 整个 services schema，只移除 volatile 标记及 secret 默认值；extra 不被删除 |
| 根字段筛选 | 同文件:volatileForm | 非 volatile 根 object 被重建，根 metadata 可能丢失；因此目录没有放到根上 |
| 实际 describe | packages/settings/settings/src/index.ts:302–331 | descriptor.schema=form.toJSON；value/base/user 分别 projectForm，metadata 不混入这些值 |
| RPC projection | packages/api/settings-controller/src/index.ts:namespaceView / describe | descriptor.schema 直接作为 JSON 输出，未另过滤 extra |
| App graph parser | packages/dsh_client/lib/src/engine_settings_api.dart:132–187 | 解析 uid/refs 并构造 SchemaNode |
| App metadata parser | 同文件:58–80 | 未知 meta 键被丢弃，但明确保留 map['extra'] |
| App namespace | 同文件:387–402 | schema 被解析为 SchemaNode；不能假定还保留原始 JSON |
| 生命周期 | vendor/loader/src/index.ts:29–34 | volatile-update 在引用提交后向所属实例通知 |

因此“可挂任意 JS 属性”不是采用该路径的依据；已逐层读到序列化、表单筛选、RPC 与 App parser。尚未运行真实 SettingsForms/describe 或 Flutter 解析测试，结论限于这条固定版本源码链。

## 3. App 端的读取要求

App 侧实现在 `app/lib/state/media_catalog.dart`。现有 SchemaMeta.extra 已保留目录，不需要为了本路径修改未知 meta 的处理。App（M5）的读取须满足：

1. 从 services.meta.extra 取本契约，校验 v 与基本类型，保留 namespace、Host 和连接代际。
2. 读取真实服务配置 value.services，按 enabled、profile 与该服务允许的 models 列表求交；必要时走公开 credentials.describe 判断 keyRef 是否配置。不要把静态目录存在视为服务可用。
3. 使用 header.js 相同语法渲染参数头。显式参数不支持时拒绝；不能把 3:4 改成 2:3，也不能把同名模型默认为第一个服务。
4. label 相同的模型使用〈serviceId/modelId〉消歧；label 与标记同时匹配。目录提供实际 model ID，不可用显示名猜 ID。
5. 请求、后续展示与默认值都绑定发起时的 Host / namespace / service / model 身份，不能在等待后向新 Host 重新取默认目标。
6. 0.3.0 按目录与当前已配置服务开放图片、编辑和视频。video=true 不能代替服务凭据和模型可用性校验；没有可用视频服务时不显示可执行视频选择。
7. 可选读取 `presets`、`defaults.image*` / `defaults.video*`：字段缺失、类型不符或目录 `v` 未知时忽略并退回手动配置，不阻断旧版读取。App 保存服务前仍按本契约校验 `presets` 提供的值。

catalog.v 未知或字段损坏时，停止生成模式选择，保留普通对话工具路径。目录缺失时可显示当前 Host 未提供目录，不从 App 内置旧模型表猜测。未来若需新的位置或结构，使用新版本及明确迁移；本稿不把旧候选 value.catalog 当成权威 fallback。

旧 App 无需读此目录才能发普通对话；工具结果用现有 Markdown 图片回退显示。专用生成模式与精确工具选择仍需与真实 Host 端到端验证。

## 4. 为什么目录不做 const 配置值

const+volatile+disabled 的 value.catalog 存在真实升级反例：客户端显式把 C1 写进 raw config，升级包 schema 改 const(C2) 且 C1!=C2；旧显式值不走 default 分支，常量校验会失败。disabled 仅控制 UI，也不提供 Host 写保护。

本候选没有 catalog 配置字段。目录仅在 schema metadata，services/defaults/limits/budget/credentials 的普通值均不包含目录。settings describe 的 value/base/user、替换表单与用户覆盖不应带目录；升级只换安装 JSON 与 schema metadata，不迁移持久目录值。应在真实设置集成测试中加入“旧版本写过普通服务配置→升级目录→仍能启动”的回归，不能只断言按钮 disabled。

## 5. 固定凭据槽与已否决的设计

### 数组里的 secret 不可用

App 的 schema_fields.dart:kindOf 把 array<object> 识别为 objectList。但 field_sheets.dart:_ObjectItemPage._draftField:1539–1596 只编辑 toggle/choice/text/number，其他类型包括 secret 都是 disabled 行。故 services 数组只放普通配置；不能因为顶层存在 SecretFieldTile 就声称数组里的密钥按钮可用。

### 可变凭据编辑器被否决

曾候选普通 keyRef 输入加 transform 生成 hidden credentialRef，再让 secret 读取 sibling。正常路径中 _AcknowledgedSheet._save 会等待服务确认后关闭；SettingsEditSession._checkSecretTarget 也会比较旧/当前引用，拒绝目标已变的旧 secret 弹层。

但如果 keyRef 写入挂起时用户 dismiss，乐观 keyRef 与服务端派生 credentialRef 可能暂时不同；仅靠说明“等保存完成”不能消掉向旧目标写入的窗口。本候选没有该动态编辑器。

### 当前四槽

credentials 是普通对象组；slot1–slot4 各有固定 const credentialRef，分别为 DSH_MEDIA_SLOT_1_API_KEY 等。secret 是叶节点，目标永远不随服务数组改变。服务 keyRef 是显式普通配置，引用槽或用户已知的现有引用。

SecretFieldTile（schema_form.dart:404–457）构造 SettingsEditSession；controller（engine_settings_state.dart:418–442、776–815）先核来源与目标，再通过 client.setProviderKey / clearProviderKey 写 Host credentials。它不把真实 Key 保存到 config。

只把 secret 直接写成 const('') 还有错误回显问题：Schemastery const resolver 抛出的错误含 got 值（657–659）。改成 transform(any) 的严格空串验证，非空只抛固定中文错误。再包 intersect 也不可用：App 的 schemaSections:555 会优先把 intersect 当 group。当前 transform 的 effective any 是叶；kindOf 先看到外层 secret role，因此保留密钥按钮路径，同时拒绝所有非空普通配置写入。

这些是固定源支持的设计理由；实际按钮点击、凭据持久化、App 重连及设置重载仍待运行。Node 测试已通过，覆盖非空拒绝且错误不含假 Key、固定引用不可改以及 secret redaction。

0.3.0 起 `keyRef` 可以是任意已配置的 env 风格凭据名（例如 `DSH_MEDIA_ARK_API_KEY`）；新版 App 可以在写入服务前按服务商创建该凭据。固定四槽继续保留，旧配置无需迁移。Host 仍只按显式 `keyRef` 解析，不枚举其他插件的凭据渠道。

## 6. Key 复用边界

已知 CredentialRef 可由 credentials.resolve 按 Host 的实际 provider 解析，可能来自持久化凭据、环境或 dotenv 回退。M0 不把 unset 一概解释为“绝无 Key”。

这不等于自动枚举 llm-pi-ai 当前选择渠道的全部身份。后者还涉及实例、provider、endpoint、认证方式和 scoped credential record。M0 只允许用户明确填写已知 ref，不窥探其他插件的 scoped grant，也不静默切换到另一个“看起来已配置”的 Key。

## 7. 目录来源与日期

2026-10-28 打开并检索下列官方页面（不沿用设计文档中的 V 标签）：

- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- https://ai.google.dev/gemini-api/docs/openai （读全文；页面标注 Last updated 2026-10-26 UTC，没有固定版本，不当作永久协议保证）

精确三个 OpenAI 模型 ID 在本次 Image API 页面中列明；三个标准尺寸与 low/medium/high 属于已核子集。GPT Image 返回 base64，不接受旧 response_format。页面包含更多尺寸、质量和能力，本 M0 数据没有全部开放。价格与账号权限未验证，目录不提供。

目录另含 gemini-2.5-flash-image 的最小兼容条目，profile=openai-compatible、responseFormats=[b64_json]、maxN=1，其他可选参数集合为空。依据是上面 Gemini 页面“Generate an image”的请求形状（model、prompt、n=1、response_format=b64_json，读 data[].b64_json），只推断与现有核心在文档形状上兼容，未发真实请求，也未证明账号可用；不新增视频、上传或 extra_body。

## 8. 未运行验收

| 验收项 | 当前状态 |
|---|---|
| 实际 Config / Schemastery / redactSecrets Node 测试 | 0.3.0 `npm test` 314/314 已通过；0.2.0 rc.4 依赖细节见 VERIFICATION.md |
| 真 Loader→SettingsForms→settings/describe graph→extra | 源码链已核，运行 UNRUN |
| App SchemaNode 真实解码后 extra 定位 | 源码已核，Flutter UNRUN |
| 四槽密钥写入、清除与普通 settings 非空拒绝 | Node 测试已通过；真实 UI 与 Host 持久化 UNRUN |
| 更改服务 keyRef 时固定槽旧弹层仍写原固定目标 | 需真实 UI 运行，UNRUN |
| 目录更新不把旧值固化到用户覆盖 | 源码设计支持，集成 UNRUN |
| 同名模型标记、Host 变化与旧目录回包抑制 | App（M5）范围，端到端 UNRUN |
| 实际生成参数头触发 / 普通说法触发两条 headless | 本地 mock 下已通过（模型是固定脚本，不证明真实模型）；事件记录未入库，未伪造夹具 |

所有测试命令显式 TZ=Asia/Shanghai。
