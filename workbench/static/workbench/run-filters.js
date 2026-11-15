(() => {
  const groups = [
    ['all', '全部'],
    ['active', '待处理 / 进行中'],
    ['ended', '已结束'],
    ['attention', '需关注'],
    ['other', '其他状态'],
  ];
  const statuses = {
    active: new Set(['created', 'draft', 'pending', 'queued', 'running', 'submitted']),
    ended: new Set(['completed', 'succeeded', 'cancelled']),
    attention: new Set(['failed', 'unavailable', 'waiting_human', 'needs_review', 'pending_review', 'awaiting_confirmation', 'rejected']),
  };

  for (const panel of document.querySelectorAll('[data-run-records]')) {
    const controls = panel.querySelector('[data-run-filters]');
    const summary = panel.querySelector('[data-run-filter-summary]');
    const empty = panel.querySelector('[data-run-filter-empty]');
    const rows = [...panel.querySelectorAll('tbody [data-run-status]')];
    if (!controls || !summary || !empty || !rows.length) continue;
    const category = row => Object.keys(statuses).find(key => statuses[key].has(row.dataset.runStatus)) || 'other';
    const counts = Object.fromEntries(groups.map(([key]) => [key, key === 'all' ? rows.length : rows.filter(row => category(row) === key).length]));
    const buttons = [];
    const select = key => {
      let visible = 0;
      for (const row of rows) {
        row.hidden = key !== 'all' && category(row) !== key;
        if (!row.hidden) visible += 1;
      }
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.runFilter === key));
      summary.textContent = `当前已加载 ${rows.length} 条，筛选后 ${visible} 条`;
      empty.hidden = visible !== 0;
    };
    for (const [key, label] of groups) {
      if (!counts[key]) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.runFilter = key;
      button.textContent = `${label} · ${counts[key]}`;
      button.setAttribute('aria-controls', 'run-records-table');
      button.addEventListener('click', () => select(key));
      controls.appendChild(button);
      buttons.push(button);
    }
    select('all');
    controls.hidden = false;
    summary.hidden = false;
  }
})();
