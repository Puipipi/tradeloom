// NA v1.3: real selected bytes, read inside the awaited owning callback.
// Only digests enter the view model; this example does not persist file content.
import { createHash } from 'node:crypto'

export const name = 'dsh-go-example-files'
const english = locale => typeof locale === 'string' && locale.toLowerCase().startsWith('en')

export function fileView(scope, caps) {
  const en = english(caps?.locale)
  if (!caps?.features?.includes('files')) return {
    type: 'text', text: en ? 'File selection is unavailable on this connection' : '当前连接不支持文件选择', tone: 'muted',
  }
  return { type: 'stack', children: [
    { type: 'text', text: en ? 'Choose files to calculate their SHA-256' : '选择文件，计算内容的 SHA-256' },
    { type: 'actions', items: [
      { label: en ? 'Files' : '文件', icon: 'document', action: 'chooseFiles' },
      { label: en ? 'Images' : '图片', icon: 'image', action: 'chooseImages' },
    ] },
    { type: 'metric', label: en ? 'Files read' : '已读文件', value: { $: 'data.count' } },
    { type: 'list', items: { $: 'data.files' } },
  ] }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], ctx => {
    ctx.dshGo.panel('files', {
      view: fileView,
      data: (scope, emit) => { emit({ count: 0, files: [] }) },
      actions: {
        chooseFiles: () => ({ type: 'pickFile', action: 'selected', maxFiles: 4 }),
        chooseImages: () => ({ type: 'pickImage', action: 'selected', maxFiles: 4 }),
        selected: (scope, event) => {
          const selection = event.value
          if (selection.status === 'cancelled') return
          if (selection.status === 'error') return { toast: english(event.locale) ? 'Files could not be read' : '未能读取文件' }
          const files = selection.files.map(file => {
            // The service returns a copy. Retaining only the handle would be wrong:
            // it is revoked as soon as this callback settles.
            const bytes = ctx.dshGo.readPickedFile(file.handle)
            return {
              title: file.name,
              subtitle: createHash('sha256').update(bytes).digest('hex'),
              trailing: `${bytes.byteLength} B`,
              icon: file.mediaType.startsWith('image/') ? 'image' : 'document',
            }
          })
          return { type: 'patch', id: 'files', data: { count: files.length, files } }
        },
      },
    })
  })
}
