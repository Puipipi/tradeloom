/* Public author configuration is rendered as text, never HTML. */
(() => {
  const config = window.DSH_GO_CONFIG || {};
  const author = config.author || {};
  const download = config.download || {};
  const repository = config.repository || {};
  const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const { safeUrl } = window.DSH_GO_UTILS;
  function configuredImage(value, field) {
    const url = safeUrl(value, true);
    if (value && !url) console.warn(`[DSH Go 配置] ${field} 无效：本地图片路径应以 assets/ 开头，不要加 dist/、../ 或 ?v=；也可填写完整 HTTP(S) 图片地址。图片更新建议换文件名。`);
    return url;
  }
  const authorImage = configuredImage(author.avatar, 'author.avatar');
  const downloadImage = configuredImage(download.qrImage, 'download.qrImage');
  function setLink(link, value) {
    const url = safeUrl(value);
    if (url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.removeAttribute('aria-disabled');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
    return Boolean(url);
  }
  document.querySelector('#download-label').textContent = text(download.label, '下载 DSH Go');
  document.querySelector('#platform-label').textContent = text(download.platform, 'Android · arm64');
  document.querySelector('#repository-label').textContent = text(repository.label, 'github / 仓库即将公布');
  setLink(document.querySelector('.repo-line'), repository.url);
  setLink(document.querySelector('.star-callout'), repository.url);

  const dialog = document.querySelector('#info-dialog');
  const avatar = document.querySelector('#dialog-avatar');
  const qr = document.querySelector('#download-qr');
  const qrNote = document.querySelector('#download-qr-note');
  const downloadLink = document.querySelector('#download-link');
  const altLink = document.querySelector('#download-alt-link');
  avatar.addEventListener('error', () => {
    console.warn('[DSH Go 配置] author.avatar 加载失败。请检查文件名大小写、图片是否随 dist 上传，运行 npm run check:content 检查本地文件。已尝试回退品牌图标。');
    if (avatar.getAttribute('src') !== 'assets/dsh-go.svg') avatar.src = 'assets/dsh-go.svg';
  });
  qr.addEventListener('error', () => {
    console.warn('[DSH Go 配置] download.qrImage 加载失败。请检查图片路径和文件是否已上传；二维码不会自动生成。');
    qr.hidden = true;
    qrNote.hidden = false;
    qrNote.textContent = '二维码暂时无法显示，请稍后再试。';
  });
  document.querySelectorAll('[data-dialog]').forEach(button => {
    button.addEventListener('click', () => {
      const about = button.dataset.dialog === 'about';
      avatar.src = about ? authorImage || 'assets/dsh-go.svg' : 'assets/dsh-go.svg';
      avatar.alt = about ? text(author.id, 'DSH Go 作者') + '的头像' : '';
      dialog.querySelector('.dialog-eyebrow').textContent = about ? 'DSH Go · DEVELOPER' : 'DSH Go · DOWNLOAD';
      document.querySelector('#dialog-title').textContent = about ? text(author.id, 'DSH Go 作者') : text(download.title, '获取 DSH Go');
      document.querySelector('#dialog-description').textContent = about ? text(author.message) : text(download.description, '下载信息即将公布。');
      document.querySelector('#download-details').hidden = about;
      if (!about) {
        const image = downloadImage;
        qr.hidden = !image;
        qrNote.hidden = !image;
        qrNote.textContent = text(download.qrNote, '扫码获取 DSH Go');
        if (image) qr.src = image;
        else qr.removeAttribute('src');
        downloadLink.hidden = !setLink(downloadLink, download.url);
        downloadLink.textContent = text(download.urlLabel, '打开下载地址');
        altLink.hidden = !setLink(altLink, download.altUrl);
        altLink.textContent = text(download.altLabel, '其他下载地址');
      }
      dialog.showModal();
    });
  });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });

  function platformIcon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + kind);
    svg.append(use);
    return svg;
  }
  function identityChip(person) {
    if (!person || typeof person !== 'object') return null;
    const chip = document.createElement('div');
    chip.className = 'identity-chip';
    for (const kind of ['github', 'bilibili']) {
      const profile = person[kind];
      if (!profile || typeof profile !== 'object' || !text(profile.label)) continue;
      if (chip.childElementCount) {
        const divider = document.createElement('span');
        divider.className = 'identity-divider';
        divider.textContent = '/';
        divider.setAttribute('aria-hidden', 'true');
        chip.append(divider);
      }
      const link = document.createElement(safeUrl(profile.url) ? 'a' : 'span');
      link.className = 'identity-profile';
      if (link.tagName === 'A') {
        setLink(link, profile.url);
        link.setAttribute('aria-label', `${text(profile.label)} 的 ${kind === 'github' ? 'GitHub' : '哔哩哔哩'} 主页`);
      }
      link.append(platformIcon(kind), document.createTextNode(text(profile.label)));
      chip.append(link);
    }
    if (!chip.childElementCount && text(person.name)) chip.textContent = text(person.name);
    return chip.textContent ? chip : null;
  }
  const rows = Array.from({ length: 3 }, () => []);
  (Array.isArray(config.contributors) ? config.contributors : []).forEach((person, index) => {
    const chip = identityChip(person);
    if (chip) rows[Number.isInteger(person.row) && person.row >= 1 && person.row <= 3 ? person.row - 1 : index % 3].push(chip);
  });
  const root = document.querySelector('#contributor-rows');
  rows.forEach((chips, index) => {
    const row = document.createElement('div');
    row.className = 'contributor-row';
    row.setAttribute('aria-label', `第 ${index + 1} 行贡献者`);
    const track = document.createElement('div');
    track.className = 'contributor-track';
    const group = document.createElement('div');
    group.className = 'contributor-group';
    group.append(...chips);
    // Blank slots preserve the three-row composition without inventing people.
    for (let slot = chips.length; slot < 5; slot++) {
      const blank = document.createElement('span');
      blank.className = 'identity-chip identity-empty';
      blank.setAttribute('aria-hidden', 'true');
      group.append(blank);
    }
    track.append(group);
    row.append(track);
    row.addEventListener('focusin', event => {
      if (event.target.matches('a:focus-visible')) {
        // Wait for the moving strip to become a static keyboard-browsable row.
        requestAnimationFrame(() => event.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
      }
    });
    root.append(row);
    // Fill wide viewports with complete copies, without stretching card spacing.
    const fillTrack = () => {
      const width = group.getBoundingClientRect().width;
      if (!width) return;
      track.style.setProperty('--contributor-cycle', `${width}px`);
      const copies = Math.max(1, Math.ceil(row.clientWidth / width));
      while (track.children.length > copies + 1) track.lastElementChild.remove();
      while (track.children.length < copies + 1) {
        const clone = group.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        clone.querySelectorAll('a').forEach(link => link.tabIndex = -1);
        track.append(clone);
      }
    };
    new ResizeObserver(fillTrack).observe(row);
    new ResizeObserver(fillTrack).observe(group);
    fillTrack();
  });
  document.querySelector('#developer-identity').append(identityChip({
    github: { label: 'ClayGao233', url: 'https://github.com/ClayGao233' },
    bilibili: { label: '采云师烧饼', url: 'https://space.bilibili.com/28879571' }
  }));
  // The repository's star count comes from this site's own server
  // (/api/github/stars, which asks GitHub): the browser never talks to
  // GitHub. Without an answer the bubble just has no number.
  const starCount = document.querySelector('#star-count');
  const compact = n => n < 1000 ? String(n) : n < 10000 ? (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k' : Math.floor(n / 1000) + 'k';
  fetch('/api/github/stars', { headers: { Accept: 'application/json' } })
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!Number.isInteger(data?.stars) || data.stars < 0) return;
      starCount.textContent = compact(data.stars);
      starCount.title = `${data.stars} Star`;
      starCount.hidden = false;
    })
    .catch(() => {});
  let visible = false;
  const syncTicker = () => root.classList.toggle('is-running', visible && !document.hidden && !dialog.open);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncTicker(); }).observe(root);
  document.addEventListener('visibilitychange', syncTicker);
  new MutationObserver(syncTicker).observe(dialog, { attributes: true, attributeFilter: ['open'] });
})();
