// dsh-go share landing page (docs/design/share-codes.md). Reads the share
// code from the URL fragment — which browsers never send to the server —
// decodes it here, shows what it holds and hands it to the app as a
// dshgo:// link. Nothing is uploaded; only a Gist link fetches its Gist.
// Without a link the page opens conversation files (viewer.js).
//
// Code format (app/lib/share_code/share_codec.dart):
//   <base64url(deflate-raw(json))>.<base64url(sha256(json)[0..6])>
'use strict';

(function () {
  var browserLanguage = typeof document !== 'undefined' && typeof navigator !== 'undefined' ? navigator.language || '' : '';
  var lang = !browserLanguage || /^zh/i.test(browserLanguage) ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  var I18N = {
    "zh": {
      "defaultModel": "默认模型",
      "defaultPreset": "默认预设",
      "agent": "智能体",
      "subagent": "子代理",
      "subagentModel": "子代理模型",
      "deepseekModel": "DeepSeek 模型",
      "deepseekAccountModel": "DeepSeek 账号模型",
      "customProvider": "自定义模型服务",
      "web": "联网",
      "webSearch": "联网搜索",
      "webSearchApi": "联网搜索接口",
      "commands": "命令执行",
      "permissions": "权限",
      "chatLog": "对话日志",
      "thinkingTranslation": "思考翻译",
      "language": "语言",
      "webAppearance": "网页版外观",
      "webChat": "网页版对话",
      "webInput": "网页版输入",
      "dshOfficial": "DSH 官方",
      "plugin": "插件",
      "source": "来源",
      "version": "版本",
      "checksum": "校验",
      "checksumIncluded": "附带校验",
      "pluginSuffix": " · dsh-go 插件",
      "profile": "dsh-go 配置",
      "official": "官方",
      "settings": "设置",
      "preset": "预设",
      "skill": "技能",
      "globalInstructions": "全局指令",
      "viewerTitle": "查看对话 · dsh-go",
      "incompleteLink": "这个链接不完整",
      "wechatHint": "请点右上角「…」，在浏览器中打开",
      "shareTitle": "dsh-go 分享",
      "viewInApp": "在 dsh-go 里查看内容",
      "errorNewer": "需要更新 dsh-go 才能打开",
      "errorGist": "没能读取这个 Gist",
      "errorCode": "这个分享码不完整或已损坏",
      "share": "分享",
      "reading": "正在读取…",
      "openApp": "用 dsh-go 打开",
      "download": "下载 dsh-go",
      "plugins": "插件",
      "presets": "预设",
      "skills": "技能",
      "pluginCount": "{n} 个插件",
      "settingCount": "{n} 项设置",
      "presetCount": "{n} 个预设",
      "skillCount": "{n} 个技能",
      "itemCount": "{n} 项",
      "fileCount": "{n} 个文件",
      "lineCount": "{n} 行"
    },
    "en": {
      "defaultModel": "Default model",
      "defaultPreset": "Default preset",
      "agent": "Agent",
      "subagent": "Subagent",
      "subagentModel": "Subagent model",
      "deepseekModel": "DeepSeek model",
      "deepseekAccountModel": "DeepSeek account model",
      "customProvider": "Custom model provider",
      "web": "Web access",
      "webSearch": "Web search",
      "webSearchApi": "Web search API",
      "commands": "Command execution",
      "permissions": "Permissions",
      "chatLog": "Chat log",
      "thinkingTranslation": "Thinking translation",
      "language": "Language",
      "webAppearance": "DSH Web appearance",
      "webChat": "DSH Web chat",
      "webInput": "DSH Web input",
      "dshOfficial": "Official DSH",
      "plugin": "Plugin",
      "source": "Source",
      "version": "Version",
      "checksum": "Checksum",
      "checksumIncluded": "Checksum included",
      "pluginSuffix": " · dsh-go plugin",
      "profile": "dsh-go profile",
      "official": "Official",
      "settings": "Settings",
      "preset": "Preset",
      "skill": "Skill",
      "globalInstructions": "Global instructions",
      "viewerTitle": "View chat · dsh-go",
      "incompleteLink": "This link is incomplete",
      "wechatHint": "Tap “…” at the top right, then open in your browser",
      "shareTitle": "dsh-go share",
      "viewInApp": "View this in dsh-go",
      "errorNewer": "Update dsh-go to open this",
      "errorGist": "Couldn’t read this Gist",
      "errorCode": "This share code is incomplete or damaged",
      "share": "Share",
      "reading": "Reading…",
      "openApp": "Open in dsh-go",
      "download": "Download dsh-go",
      "plugins": "Plugins",
      "presets": "Presets",
      "skills": "Skills",
      "pluginCount": {
        "one": "{n} plugin",
        "other": "{n} plugins"
      },
      "settingCount": {
        "one": "{n} setting",
        "other": "{n} settings"
      },
      "presetCount": {
        "one": "{n} preset",
        "other": "{n} presets"
      },
      "skillCount": {
        "one": "{n} skill",
        "other": "{n} skills"
      },
      "itemCount": {
        "one": "{n} item",
        "other": "{n} items"
      },
      "fileCount": {
        "one": "{n} file",
        "other": "{n} files"
      },
      "lineCount": {
        "one": "{n} line",
        "other": "{n} lines"
      }
    }
  };

  function tr(key, values) {
    var value = I18N[lang][key];
    values = values || {};
    if (typeof value === 'object') value = value[values.n === 1 ? 'one' : 'other'];
    return value.replace(/\{(\w+)\}/g, function (_, name) { return values[name]; });
  }

  var APP_SCHEME = 'dshgo';
  var FORMAT_VERSION = 1;
  var MAX_BODY = 1024 * 1024;

  var LABELS = {
    'agent-default-model': tr('defaultModel'),
    'agent-preset-registry': tr('defaultPreset'),
    'agent-loop': tr('agent'),
    'subagent': tr('subagent'),
    'subagent-model-selection-settings': tr('subagentModel'),
    'llm-deepseek': tr('deepseekModel'),
    'llm-deepseek-account': tr('deepseekAccountModel'),
    'llm-pi-ai': tr('customProvider'),
    'web': tr('web'),
    'web-search-deepseek': tr('webSearch'),
    'web-deepseek-api': tr('webSearchApi'),
    'bash-sandbox': tr('commands'),
    'permission': tr('permissions'),
    'session-log-deepseek': tr('chatLog'),
    'cot-translation': tr('thinkingTranslation'),
    'locale': tr('language'),
    'ui-theme': tr('webAppearance'),
    'ui-chat': tr('webChat'),
    'ui-conversation': tr('webInput')
  };

  function $(id) { return document.getElementById(id); }

  function text(el, value) { el.textContent = value; return el; }

  function el(tag, cls, value) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value != null) node.textContent = value;
    return node;
  }

  function b64urlToBytes(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64');
    var padded = s.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var bin = atob(padded);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > MAX_BODY) { reader.cancel(); throw new Error('too large'); }
      chunks.push(r.value);
    }
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  async function checksum(bytes) {
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return bytesToB64url(digest.slice(0, 6));
  }

  /** The body of `<data>.<sum>`, checked. */
  async function decode(code) {
    var parts = code.split('.');
    if (parts.length !== 2 || !parts[0]) throw new Error('format');
    var body = await inflate(b64urlToBytes(parts[0]));
    if ((await checksum(body)) !== parts[1]) throw new Error('checksum');
    var json = JSON.parse(new TextDecoder().decode(body));
    if (!json || typeof json.v !== 'number' || json.v < 1) throw new Error('format');
    if (json.v > FORMAT_VERSION) throw new Error('newer');
    if (json.kind !== 'plugin' && json.kind !== 'profile') throw new Error('kind');
    return json;
  }

  async function fetchGistCode(id, sum) {
    var res = await fetch('https://api.github.com/gists/' + encodeURIComponent(id), {
      headers: { Accept: 'application/vnd.github+json' },
      referrerPolicy: 'no-referrer',
      credentials: 'omit'
    });
    if (!res.ok) throw new Error('gist');
    var gist = await res.json();
    var files = gist && gist.files ? Object.values(gist.files) : [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || typeof f.filename !== 'string' || !/\.dshgo$/.test(f.filename)) continue;
      var content = f.content;
      if (f.truncated && typeof f.raw_url === 'string' && f.raw_url.indexOf('https://gist.githubusercontent.com/') === 0) {
        content = await (await fetch(f.raw_url, { referrerPolicy: 'no-referrer', credentials: 'omit' })).text();
      }
      var m = /"code"\s*:\s*"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8})"/.exec(content || '');
      if (m && m[1].slice(-sum.length - 1) === '.' + sum) return m[1];
    }
    throw new Error('gist');
  }

  function str(v, max) {
    if (typeof v !== 'string') return null;
    var t = v.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
  }

  function sourceText(p) {
    var spec = String(p.spec || '');
    switch (p.source) {
      case 'npm': return 'npm';
      case 'github': {
        var m = /^github:([^/]+\/[^#]+)#/.exec(spec) || /^git\+https:\/\/github\.com\/([^/]+\/[^#.]+)/.exec(spec);
        return 'GitHub' + (m ? ' · ' + m[1] : '');
      }
      case 'git': {
        var h = /^git\+https:\/\/([^/]+)\//.exec(spec);
        return h ? h[1] : 'Git';
      }
      case 'official': return tr('dshOfficial');
      default: return '—';
    }
  }

  function gitRef(spec) {
    var m = /#([A-Za-z0-9_./-]+)/.exec(String(spec || ''));
    return m ? m[1] : null;
  }

  function addFact(label, value, chip) {
    var li = el('li');
    li.appendChild(el('span', null, label));
    li.appendChild(el('span', chip ? 'chip' : null, value));
    $('facts').appendChild(li);
    $('facts').hidden = false;
  }

  function addGroup(title, rows) {
    if (!rows.length) return;
    var g = el('div', 'group');
    g.appendChild(el('h2', null, title));
    var ul = el('ul');
    rows.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('span', r[2] ? 'mono' : null, r[0]));
      li.appendChild(el('span', null, r[1] || ''));
      ul.appendChild(li);
    });
    g.appendChild(ul);
    $('groups').appendChild(g);
  }

  var PROFILE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17a1 1 0 0 1 1-1h5a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm0-10a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm10 12v-1h7a1 1 0 1 0 0-2h-7v-1a1 1 0 1 0-2 0v4a1 1 0 1 0 2 0ZM7 11v-1a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0v-1H4a1 1 0 1 1 0-2h3Zm13 0a1 1 0 1 1 0 2h-9v-2h9ZM16 3a1 1 0 0 1 1 1v1h3a1 1 0 1 1 0 2h-3v1a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z"/></svg>';

  function showPlugin(body) {
    var p = body.plugin || {};
    var title = str(p.title, 80) || str(p.name, 214) || tr('plugin');
    text($('tile'), Array.from(title)[0].toUpperCase());
    text($('title'), title);
    text($('sub'), str(p.author, 80) || str(p.name, 214) || '');
    if (str(p.summary, 200)) { text($('summary'), str(p.summary, 200)); $('summary').hidden = false; }
    addFact(tr('source'), sourceText(p));
    addFact(tr('version'), str(p.version, 64) || gitRef(p.spec) || '—');
    if (p.integrity) addFact(tr('checksum'), tr('checksumIncluded'), true);
    document.title = title + tr('pluginSuffix');
  }

  function showProfile(body) {
    $('tile').innerHTML = PROFILE_ICON; // a constant, never data
    var title = str(body.name, 40) || tr('profile');
    text($('title'), title);
    var plugins = Array.isArray(body.plugins) ? body.plugins : [];
    var settings = body.settings && typeof body.settings === 'object' ? Object.keys(body.settings) : [];
    var presets = Array.isArray(body.presets) ? body.presets : [];
    var skills = Array.isArray(body.skills) ? body.skills : [];
    var parts = [];
    if (plugins.length) parts.push(tr('pluginCount', {n: plugins.length}));
    if (settings.length) parts.push(tr('settingCount', {n: settings.length}));
    if (presets.length) parts.push(tr('presetCount', {n: presets.length}));
    if (skills.length) parts.push(tr('skillCount', {n: skills.length}));
    if (typeof body.agentsMd === 'string') parts.push('AGENTS.md');
    text($('sub'), parts.join(' · '));
    addGroup(tr('plugins'), plugins.slice(0, 64).map(function (p) {
      return [str(p.title, 80) || str(p.name, 214) || tr('plugin'), p.source === 'official' ? tr('official') : (str(p.version, 64) || gitRef(p.spec))];
    }));
    addGroup(tr('settings'), settings.slice(0, 64).map(function (ns) {
      var values = body.settings[ns];
      var n = values && typeof values === 'object' ? Object.keys(values).length : 0;
      return [LABELS[ns] || ns, tr('itemCount', {n: n}), !LABELS[ns]];
    }));
    addGroup(tr('presets'), presets.slice(0, 64).map(function (p) { return [str(p.name, 60) || str(p.id, 64) || tr('preset'), '']; }));
    addGroup(tr('skills'), skills.slice(0, 32).map(function (s) {
      var n = s && s.files && typeof s.files === 'object' ? Object.keys(s.files).length : 0;
      return [str(s && s.name, 64) || tr('skill'), tr('fileCount', {n: n})];
    }));
    if (typeof body.agentsMd === 'string') addGroup(tr('globalInstructions'), [['AGENTS.md', tr('lineCount', {n: body.agentsMd.split('\n').length})]]);
    document.title = title + ' · dsh-go';
  }

  function fail(message) {
    text($('title'), message);
    text($('sub'), '');
    $('tile').textContent = '!';
    $('open').hidden = true;
  }

  function note(message) {
    text($('note'), message);
    $('note').hidden = false;
  }

  /** The conversation viewer takes the page (viewer.js). */
  function viewerPage() {
    document.querySelector('main').hidden = true;
    document.body.className = 'dv-page';
    var host = $('dv-root');
    host.hidden = false;
    return host;
  }

  async function main() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    var code = params.get('p');
    var gist = params.get('gist');
    var sum = params.get('c');
    var appLink = null;
    if (!code && !gist && window.DshgoViewer) {
      document.title = tr('viewerTitle');
      window.DshgoViewer.opener(viewerPage());
      return;
    }
    if (code && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8}$/.test(code)) {
      appLink = null; // set once the kind is known
    } else if (gist && sum && /^[0-9a-f]{20,40}$/.test(gist) && /^[A-Za-z0-9_-]{8}$/.test(sum)) {
      appLink = APP_SCHEME + '://share/profile?gist=' + gist + '&c=' + sum;
    } else {
      fail(tr('incompleteLink'));
      return;
    }
    var openBtn = $('open');
    if (appLink) { openBtn.href = appLink; openBtn.hidden = false; }
    if (typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent || '')) note(tr('wechatHint'));

    if (typeof DecompressionStream === 'undefined' || !window.crypto || !crypto.subtle) {
      // Can't read it here; the app can.
      text($('title'), tr('shareTitle'));
      text($('sub'), tr('viewInApp'));
      if (code) { openBtn.href = APP_SCHEME + '://share/plugin?p=' + code; openBtn.hidden = false; }
      return;
    }
    try {
      if (!code) code = await fetchGistCode(gist, sum);
      var body = await decode(code);
      if (!appLink) {
        openBtn.href = APP_SCHEME + '://share/' + body.kind + '?p=' + code;
        openBtn.hidden = false;
      }
      if (body.kind === 'plugin') showPlugin(body); else showProfile(body);
    } catch (e) {
      var msg = String(e && e.message);
      fail(msg === 'newer' ? tr('errorNewer') : msg === 'gist' ? tr('errorGist') : tr('errorCode'));
    }
  }

  document.title = tr('shareTitle');
  document.querySelectorAll('[data-i18n]').forEach(function (node) {
    node.textContent = tr(node.getAttribute('data-i18n'));
  });
  main();
})();
