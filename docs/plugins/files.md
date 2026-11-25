# 选择文件与图片

NA v1.3 的 `files` 能力让插件在用户点按后打开系统选择器。用户选中的内容送到当前主机，插件通过一次性句柄读取字节；没有额外授权弹窗，也不会得到手机文件路径或可写 URI。

## 声明与降级

清单中声明 `"capabilities": ["files"]`。清单按钮加 `"requires": ["files"]`；面板内的选择按钮只在 `caps.features?.includes('files')` 时显示。不支持时显示普通说明文字。旧 App、旧桥、未实现原生适配器的平台和 DSH Remote 中转连接不会协商此能力；普通面板仍能打开。

`files` 不改变视图格式。仅使用 v1 组件也能取文件。清单 `dshGo.v`、HTTP 路径和 WebSocket `v` 仍为 `1`，不能填写 `1.3`。

## 发起与接收

```js
import { createHash } from 'node:crypto'
import { effects } from '@dsh-go/plugin-kit'

ctx.dshGo.panel('files', {
  view: (scope, caps) => caps.features?.includes('files')
    ? { type: 'actions', items: [{ label: '选择文件', action: 'choose' }] }
    : { type: 'text', text: '当前连接不支持文件选择' },
  actions: {
    choose: () => effects.pickFile('selected', { maxFiles: 2 }),
    selected: async (scope, event) => {
      if (event.value.status !== 'selected') return
      const files = event.value.files.map(file => {
        const bytes = ctx.dshGo.readPickedFile(file.handle)
        return { name: file.name, sha256: createHash('sha256').update(bytes).digest('hex') }
      })
      return { patch: { files } }
    },
  },
})
```

选择图片用 `effects.pickImage('selected', { maxFiles: 2 })`。不使用 SDK 的等价返回值为 `{ type: 'pickFile', action: 'selected', maxFiles: 2 }`。`maxFiles` 默认 `1`，只接受整数 `1–4`；`action` 使用普通动作 id 的规则。

回调在同一个面板的 `actions[action]` 上执行。没有该 handler 时，回落到 `ctx.dshGo.on(原贡献 id, handler)`，通过 `event.action` 分支。回调保留原 `scope`、`surface`、`id` 和 `locale`，并增加随请求撤销的 `event.signal`。`event.value` 是：

```js
{ status: 'selected', files: [
  { handle: '不透明字符串', name: 'note.txt', bytes: 12,
    mediaType: 'text/plain', access: 'read' },
] }
// 或 { status: 'cancelled', files: [] }
// 或 { status: 'error', files: [] }
```

文件名仅用于显示；桥接清除目录片段和控制字符，最多保留 128 字符。MIME 是提供方的声明，不能据此信任内容。`bytes` 是实际上传字节数。取消不返回已经上传的部分文件；越限或上传失败则整批撤销。连接已断开或插件已卸载时，回调无法送达，句柄仍会撤销。

## 句柄的有效期

`ctx.dshGo.readPickedFile(handle)` 返回 `Uint8Array` 的独立副本（Node 实现为 `Buffer`）。它只在所属插件的**这一次被等待的选择回调内**有效，回调中的 `await` 不会立即使它失效。回调结束、抛错、超过现有 3 秒 handler 时限、插件卸载、注册替换、主机断连或请求到期后，继续读取会抛错；另一个插件也不能通过此接口读取这个句柄。

发起动作与文件回调都绑定本次 invoke 开始调用时的注册。桥在调用动作函数之前保存实际 panel action / 回落 handler 的注册身份和 callback 候选；函数等待期间替换任一实际使用的注册，会拒绝旧函数返回的文件效果，不分配选择槽。不能在动作开始后才注册新的 callback 来承接这个旧调用。已签发请求也同时绑定发起动作与 callback；其中任一注册撤销后，旧请求不可继续上传或读文件。

需要长期处理时，在回调内复制内容，或 `await` 写到插件自己管理的位置。不要保存句柄留待下一次 invoke；不要把 `file.name` 直接拼成目标路径。比如导入插件可在自己的已知目录中使用随机名：

```js
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const bytes = ctx.dshGo.readPickedFile(file.handle)
// pluginDataDir 由插件配置并创建，与用户文件名无关。
const importedPath = join(pluginDataDir, randomUUID())
await writeFile(importedPath, bytes, { flag: 'wx', mode: 0o600, signal: event.signal })
// 插件负责自己副本的容量、取消后的清理和保留期限。
```

图片也按字节交付。句柄不是视图 `image.src`；要显示图片，插件需在回调中处理副本，并继续遵守插件资源/data URI 的既有图像格式和体积预算。

“只读”保证这条链路不修改用户选中的原文件：Android 仅以 `r` 打开，桥接仅给内容副本。宿主上的 Node 插件本来就在同一进程中运行；这不是隔离恶意宿主插件的沙箱，也不能约束插件主动复制后的存储。

## 用户动作与收尾

选择效果必须来自当场点按的直接 invoke，并在既有 3 秒窗口内到达 App。静态 `effect`、后台数据推送、延后效果和 `onChange` 都不能打开选择器。App 发 `userGesture: true`，桥和原生适配器再核对；作者不能自行填写 `request` 等授权字段。

选择器可等待较久，其回调只接受 `patch`、`refresh`、`toast`。不能借回调再次打开选择器、复制到剪贴板、发送命令或创建延后效果。再次选择必须让用户重新点按。

App 全局一次只允许一个选择流程。切换主机、插件不可用、连接断开、Activity 销毁或请求到期会取消读取。Android 的 Cursor 和 InputStream 在后台工作线程关闭，晚到的系统结果被丢弃。系统选择器打开期间，原有后台断线等待只为这次请求有界延长；结束后恢复原规则。

读取连续十秒没有新增字节时，App 先向这次请求的原 owner 发原生取消，再取消源订阅并以 error 结束流程；不等待仍卡在 provider 的 read 返回。已有部分字节不会作为 selected 交付，晚回的数据不会取消新选择。原生 worker 若仍未退出，`ioBusy` / `closing` 继续拒绝新选择；App 的流程结束不代表 Android 已能强制终止不合作的内容提供方。

## 固定预算

| 项目 | 上限 | 取值理由 |
|---|---:|---|
| 文件数 | 插件请求的 `1–4` | 保持一次点按为小批导入；三个接收层都校验 |
| 单文件 | 8 MiB | App 一次只保留一个有界上传缓冲区 |
| 单次总量 | 16 MiB | 两个满额文件或四个较小文件，限制移动上传成本 |
| 桥接保留的内容缓冲区 | 全主机 64 MiB | 多连接共享限额；未知长度也先预留容量 |
| 桥接未结束请求 | 全主机 8 个，每连接 1 个 | 未上传的等待请求也受限 |
| 原生读取块 | 64 KiB | 不在返回 Dart 前完整复制大文件 |
| 请求生命周期 | 5 分钟 | 选择、上传和回调共享有界租期 |
| 每次上传 | 30 秒 | 慢连接失败后可以重新点按 |
| 原生读取无进展 | 10 秒 | 避免坏的内容提供方长期占用 App 流程 |
| 选择回调 | 既有 3 秒 | 大任务先取得副本，后续状态通过既有数据通道展示 |

这些是资源策略，不是性能测量结果。上传前按已知大小与文件数检查；大小未知、为负或虚报不能绕过实际字节计数。原生、Dart 和桥接分别计数；任何层越限都不交付部分成功。原生系统或内容提供方可能仍保有自己的内部资源，本桥的预算只约束本实现申请和保留的缓冲区。

## Android 与远程主机

- 普通文件：`ACTION_OPEN_DOCUMENT` + `CATEGORY_OPENABLE`，MIME `*/*`；本 App 最低 Android 26。
- 图片：Android 33 起用 `MediaStore.ACTION_PICK_IMAGES`，多选上限取请求数量与 `getPickImagesMaxLimit()` 的较小值；旧系统或没有 Photo Picker Activity 时退回 `ACTION_OPEN_DOCUMENT` + `image/*`。
- 只请求临时读授权，不请求目录、写授权或新的存储权限，不调用 `takePersistableUriPermission`。读取走带 `CancellationSignal` 的 `ContentResolver.openAssetFileDescriptor(uri, "r", ...)`；不使用依赖库中先完整复制到缓存的路径。
- 本地与 SSH 直连复用现有主机认证、HTTP carrier 和 SSH 隧道，在我们自己的 `/dsh-go/v1/files/` 路由上传，不改 DSH 引擎协议。旧 `fileUploads/upload` 只返回对话附件凭据，没有插件可读文件路径，因此不能伪装成可用的导入接口。
- DSH Remote 中转当前不转发 `/dsh-go/*`，因此 `files` 为不可用；不会先打开选择器再假报成功。需要上游提供受认证的桥路由转发后，才能启用。

Android API 依据：[Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)、[MediaStore Photo Picker](https://developer.android.com/reference/android/provider/MediaStore#ACTION_PICK_IMAGES)、[ContentResolver](https://developer.android.com/reference/android/content/ContentResolver#openAssetFileDescriptor(android.net.Uri,java.lang.String,android.os.CancellationSignal))。本轮通过真实 API jar 编译和跨层自动化测试；系统 UI、厂商提供方、进程重建及 SSH 实机链路仍需设备验证。

可运行示例：[`dsh-go-example-files`](../../examples/plugins/dsh-go-example-files/)，读取真实内容计算 SHA-256；不会把文件自动加入对话或自动提交模型。
