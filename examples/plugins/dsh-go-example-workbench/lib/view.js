// Plain JSON keeps this example installable without a runtime SDK dependency.
const b = (path) => ({ $: `data.${path}` })
const text = (text, style) => ({ type: 'text', text, ...(style ? { style } : {}) })
const input = (type, key, label, props = {}) => ({ type, label, bind: `data.form.${key}`, ...props })
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg=='

export function workbenchView(_scope, caps = {}) {
  const en = caps.locale?.startsWith('en') === true
  const t = (zh, english) => en ? english : zh
  if (!caps.components?.includes('textField') || !caps.components?.includes('form')) {
    return {
      v: 1, type: 'stack', title: t('工作台', 'Workbench'), children: [
        text(t('当前 App 显示设置摘要。', 'This app displays the settings summary.')),
        { type: 'keyValue', items: [[t('名称', 'Name'), b('form.name')], [t('数量', 'Count'), b('form.count')], [t('金额', 'Amount'), b('form.amount')]] },
      ],
    }
  }
  return {
    v: 2, type: 'stack', accent: '#3D6F9C', title: t('工作台', 'Workbench'), style: { gap: 'L' }, children: [
      text(t('把设置留在这里', 'Make it your workspace'), { size: 'title', weight: 'semibold', color: 'accent' }),
      {
        type: 'text', text: t('编辑在本地，保存后同步。', 'Edit locally, then save to sync.'),
        spans: [{ text: t('本地草稿', 'Local draft'), weight: 'bold', background: 'blue' }, { text: t(' · 保存后同步', ' · sync on save'), color: 'gray' }],
      },
      { type: 'tabs', items: [
        { label: t('设置', 'Settings'), children: [{ type: 'form', label: t('偏好设置', 'Preferences'), submit: 'save', submitLabel: t('保存设置', 'Save settings'), children: [
          input('textField', 'name', t('名称', 'Name'), { required: true, minLength: 2, maxLength: 80, placeholder: t('给工作台起个名字', 'Name your workspace') }),
          input('textField', 'notes', t('备注', 'Notes'), { multiline: true, maxLines: 4, maxLength: 500 }),
          input('number', 'amount', t('单价', 'Unit price'), { min: 0, max: 10000, required: true }),
          input('stepper', 'count', t('数量', 'Count'), { min: 1, max: 20 }),
          input('toggle', 'enabled', t('启用提醒', 'Enable reminders'), { onChange: 'change' }),
          input('slider', 'level', t('强度', 'Intensity'), { min: 0, max: 100, step: 5, onChange: 'change' }),
          input('slider', 'range', t('范围', 'Range'), { min: 0, max: 100, step: 5, range: true }),
          input('select', 'category', t('分类', 'Category'), { options: [{ label: t('个人', 'Personal'), value: 'personal' }, { label: t('团队', 'Team'), value: 'team' }] }),
          input('segmented', 'mode', t('模式', 'Mode'), { options: [{ label: t('专注', 'Focused'), value: 'focused' }, { label: t('轻松', 'Relaxed'), value: 'relaxed' }] }),
          input('chips', 'tags', t('标签', 'Tags'), { multi: true, options: ['design', 'writing', 'code'] }),
          input('date', 'date', t('日期', 'Date')),
          input('time', 'time', t('时间', 'Time')),
          input('rating', 'rating', t('评分', 'Rating'), { max: 5 }),
          { type: 'metric', label: t('合计', 'Total'), value: { '=': 'data.form.amount * data.form.count' }, caption: t('随本地输入更新', 'Updates with local edits') },
        ] }] },
        { label: t('预览', 'Preview'), children: [
          { type: 'grid', columns: 2, children: [
            { type: 'stack', style: { card: 'outlined', padding: 'M' }, children: [{ type: 'badge', text: t('已连接', 'Connected') }, { type: 'metric', label: t('已保存', 'Saves'), value: b('saves') }] },
            { type: 'stack', style: { card: 'tinted', padding: 'M' }, children: [{ type: 'avatar', src: png, alt: t('示例头像', 'Example avatar') }, { type: 'tag', text: 'native' }] },
          ] },
          { type: 'divider' },
          { type: 'carousel', items: [
            { label: t('本地', 'Local'), children: [text(t('输入先保留在 App。', 'Inputs stay in the app first.'))] },
            { label: t('同步', 'Sync'), children: [text(t('保存走 invoke，结果通过 patch 回写。', 'Save invokes the plugin; patch writes the result back.'))] },
          ] },
          { type: 'accordion', items: [
            { label: t('数据格式', 'Data format'), children: [{ type: 'codeBlock', language: 'javascript', code: 'return { patch: { form: validatedValues } };' }] },
            { label: t('资源边界', 'Resource limits'), children: [text(t('没有外链图片，也不执行脚本。', 'No external images or script execution.'))] },
          ] },
          { type: 'collapsible', label: t('更多说明', 'More details'), children: [text(t('此示例使用进程内数据，重载后恢复初始值。', 'This example stores data in memory and resets when reloaded.'), { size: 'caption', italic: true })] },
          { type: 'timeline', items: [
            { label: t('编辑', 'Edit'), children: [text(t('即时更新本地视图。', 'Update the local view immediately.'))] },
            { label: t('验证', 'Validate'), children: [text(t('App 和插件各自验证。', 'The app and plugin validate independently.'))] },
            { label: t('保存', 'Save'), children: [text(t('等待确认后采用回写值。', 'Adopt returned values after confirmation.'))] },
          ] },
          { type: 'spacer', size: 'S' },
        ] },
      ] },
    ],
  }
}
