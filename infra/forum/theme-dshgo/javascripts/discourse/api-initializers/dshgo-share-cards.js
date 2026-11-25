// 把帖子里的 dsh-go 分享链接显示成安装卡片：名称、类型、「用 dsh-go 安装」「下载 dsh-go」。
// 链接格式的解析与解码在 ../lib/dshgo-share-link.js。
//
// 前提：站点设置 allowed_href_schemes 包含 dshgo，否则 dshgo:// 链接在烹饪时会被去掉 href
// （infra/forum/settings/site_settings.yml 已经加上）。

import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";
import {
  APP_LINK_TEXT_RE,
  appLinkFor,
  decodeShareCode,
  describePayload,
  parseShareLink,
} from "../lib/dshgo-share-link";

const CARD = "dshgo-share-card";
const SKIP_TEXT_IN = "a, code, pre, .dshgo-share-card, aside.quote";

function t(key, options) {
  return i18n(themePrefix(key), options);
}

function landingUrls() {
  return (settings.landing_urls || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function downloadUrl() {
  const url = (settings.download_url || "").trim();
  return /^https:\/\//i.test(url) ? url : null;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

// 正文里没写成链接的 dshgo://share/… 文本 → <a>，之后与普通链接走同一条路。
function linkifyPlainText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes("dshgo://share/")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.parentElement?.closest(SKIP_TEXT_IN) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    const value = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of value.matchAll(APP_LINK_TEXT_RE)) {
      fragment.append(value.slice(last, match.index));
      const a = make("a", "dshgo-share-link", match[0]);
      a.href = match[0];
      fragment.append(a);
      last = match.index + match[0].length;
    }
    if (last > 0) {
      fragment.append(value.slice(last));
      node.replaceWith(fragment);
    }
  }
}

// 链接独占一段时用卡片替换这一段；嵌在句子里时保留链接，卡片放在段落后面。
function placeCard(root, anchorNode, card) {
  const onebox = anchorNode.closest("aside.onebox");
  if (onebox && root.contains(onebox)) {
    onebox.replaceWith(card);
    return;
  }
  let block = anchorNode;
  while (block.parentElement && block.parentElement !== root) {
    block = block.parentElement;
  }
  if (block.parentElement !== root) {
    anchorNode.after(card);
    return;
  }
  const alone = block.tagName === "P" && block.textContent.trim() === anchorNode.textContent.trim();
  if (alone) {
    block.replaceWith(card);
  } else {
    block.after(card);
  }
}

function buildCard(link) {
  const card = make("div", CARD);
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", t("badge"));
  card.dataset.kind = link.kind || "unknown";
  card.dataset.state = "loading";

  const body = make("div", `${CARD}__body`);
  const mark = make("div", `${CARD}__mark`);
  mark.setAttribute("aria-hidden", "true");
  const textBox = make("div", `${CARD}__text`);
  const title = make("div", `${CARD}__title`, t("badge"));
  const meta = make("div", `${CARD}__meta`, link.kind ? t(`kind_${link.kind}`) : "");
  const summary = make("div", `${CARD}__summary`);
  summary.hidden = true;
  textBox.append(title, meta, summary);
  body.append(mark, textBox);

  const actions = make("div", `${CARD}__actions`);
  const install = make("a", `btn btn-primary no-track-link ${CARD}__install`, t("install"));
  const appLink = appLinkFor(link);
  if (appLink) {
    install.href = appLink;
  } else {
    install.hidden = true;
  }
  actions.append(install);
  const download = downloadUrl();
  if (download) {
    const get = make("a", `btn btn-default no-track-link ${CARD}__download`, t("download"));
    get.href = download;
    get.target = "_blank";
    get.rel = "noopener noreferrer";
    actions.append(get);
  }
  card.append(body, actions);

  const parts = { card, mark, title, meta, summary, install };
  if (link.gistId) {
    fill(parts, link, { kind: "profile", title: t("gist_profile"), counts: null });
  } else {
    decodeShareCode(link.code)
      .then((json) => fill(parts, link, describePayload(json)))
      .catch(() => broken(parts));
  }
  return card;
}

function fill(parts, link, info) {
  const { card, mark, title, meta, summary, install } = parts;
  card.dataset.kind = info.kind;
  card.dataset.state = "ready";

  const name = info.title || t("untitled_profile");
  title.textContent = name;
  mark.textContent = Array.from(name)[0]?.toUpperCase() || "";

  const bits = [t(`kind_${info.kind}`)];
  if (info.author) {
    bits.push(info.author);
  }
  if (info.version) {
    bits.push(`v${info.version.replace(/^v/i, "")}`);
  }
  if (info.counts) {
    if (info.counts.plugins) {
      bits.push(t("count_plugins", { count: info.counts.plugins }));
    }
    if (info.counts.skills) {
      bits.push(t("count_skills", { count: info.counts.skills }));
    }
    if (info.counts.presets) {
      bits.push(t("count_presets", { count: info.counts.presets }));
    }
  }
  meta.textContent = bits.join(" · ");

  if (info.summary) {
    summary.textContent = info.summary;
    summary.hidden = false;
  }

  const appLink = appLinkFor({ ...link, kind: link.kind || info.kind });
  if (appLink) {
    install.href = appLink;
    install.hidden = false;
  }
}

function broken(parts) {
  const { card, mark, title, meta, install } = parts;
  card.dataset.state = "broken";
  mark.textContent = "!";
  title.textContent = t("broken");
  meta.textContent = t("badge");
  install.hidden = true;
}

function decorate(root) {
  if (settings.decorate_plain_text) {
    linkifyPlainText(root);
  }
  const landings = landingUrls();
  const seen = new Set();

  const candidates = [
    ...Array.from(root.querySelectorAll("aside.onebox[data-onebox-src]")).map((node) => [
      node,
      node.dataset.oneboxSrc,
    ]),
    ...Array.from(root.querySelectorAll("a[href]")).map((node) => [node, node.getAttribute("href")]),
  ];

  for (const [node, href] of candidates) {
    if (node.dataset.dshgoCard || node.closest(`.${CARD}, aside.quote`) || !root.contains(node)) {
      continue;
    }
    const link = parseShareLink(href, landings);
    if (!link) {
      continue;
    }
    node.dataset.dshgoCard = "1";
    const key = link.code || `gist:${link.gistId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    placeCard(root, node, buildCard(link));
  }
}

export default apiInitializer((api) => {
  api.decorateCookedElement((element) => decorate(element));
});
