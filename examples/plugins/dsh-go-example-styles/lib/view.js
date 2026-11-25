const words = locale => String(locale).startsWith('en') ? {
  title: 'Focus on today', subtitle: 'A little progress each day', week: 'Focus this week', tasks: 'Completed',
  next: 'Next goal', goal: 'Write one clear goal and leave enough time to finish it.',
  rest: 'Leave room for a break', done: 'Previous goal complete', copy: 'Copy summary', open: 'Read the guide',
  prefix: 'Completed ', suffix: ' — keep going.', hours: 'h',
} : {
  title: '专注于今天', subtitle: '每天前进一点', week: '本周专注', tasks: '已完成',
  next: '下一个目标', goal: '写下一个清晰的小目标，留出足够的时间完成它。',
  rest: '留白也是计划的一部分', done: '上一个目标已完成', copy: '复制摘要', open: '阅读指南',
  prefix: '完成 ', suffix: '，继续保持。', hours: '小时',
}

export const focusData = Object.freeze({ hours: '12.4', completed: '7 / 10' })

export function focusView(_scope, caps) {
  const w = words(caps?.locale)
  return {
    v: 2, accent: 'teal', type: 'stack', style: { gap: 'L' },
    children: [
      { type: 'text', text: w.title, style: { size: 'display', weight: 'bold' } },
      { type: 'text', text: w.subtitle, style: { size: 'subtitle', color: 'teal' } },
      { type: 'text', text: `${w.prefix}7 / 10${w.suffix}`, spans: [
        { text: w.prefix, color: 'gray' },
        { text: { $: 'data.completed' }, weight: 'semibold', mono: true, background: 'green' },
        { text: w.suffix, color: 'green' },
      ] },
      { type: 'row', style: { columns: [1, 1], gap: 'M' }, children: [
        { type: 'stack', style: { card: 'tinted', padding: 'M', background: 'teal' }, children: [
          { type: 'metric', label: w.week, value: { $: 'data.hours' }, caption: w.hours,
            style: { size: 'title', weight: 'semibold', color: 'teal' } },
        ] },
        { type: 'stack', style: { card: 'outlined', padding: 'M' }, children: [
          { type: 'metric', label: w.tasks, value: { $: 'data.completed' }, style: { size: 'title', align: 'end' } },
        ] },
      ] },
      { type: 'stack', style: { card: 'surface', padding: 'L', gap: 'S', dividers: true }, children: [
        { type: 'text', text: w.next, style: { weight: 'medium' } },
        { type: 'text', text: w.goal, style: { size: 'body', maxLines: 2 } },
        { type: 'text', text: w.rest, style: { size: 'caption', italic: true, underline: true, align: 'center' } },
      ] },
      { type: 'text', text: w.done, style: { strike: true, color: 'gray' } },
      { type: 'text', text: 'focus.week = 12.4', style: { size: 'mono', color: 'indigo' } },
      { type: 'actions', items: [{ label: w.copy, icon: 'summary', action: 'copy' }, { label: w.open, action: 'guide' }] },
    ],
  }
}
