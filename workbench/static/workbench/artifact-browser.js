(() => {
  const FILE_DRAG_MIME = "application/x-tradeloom-file";
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const root = document.querySelector("[data-file-browser]");
  const workbench = document.querySelector('[data-testid="intake-workbench"]');
  if (!root || !workbench) return;

  const by = selector => root.querySelector(selector);
  let mode = root.dataset.browserMode || "";
  const parentFrame = window.parent !== window;
  const localCombined = !parentFrame;
  const sourcePreviewNode = document.querySelector(".intake-main-preview");
  const sourceHostNode = root.querySelector("[data-file-source-preview]");
  if (sourceHostNode) sourceHostNode.hidden = true;
  const rowsNode = document.getElementById("file-browser-rows");
  let artifactRows = [];
  try { artifactRows = JSON.parse(rowsNode?.textContent || "[]"); } catch { artifactRows = []; }
  const sourceById = new Map();
  const artifactById = new Map(artifactRows.map(row => [row.id, row]));
  const sourceImageRequests = new Map();
  let selected = null;
  let selectedImageUrl = "";
  let imageScale = 0;
  let previewGeneration = 0;
  let activeFilter = mode === "deliverables" ? "artifact" : "all";
  let displayMode = "rows";
  let nextSourceOffset = null;
  let sourcesLoading = false;
  let sourcesLoaded = false;
  let sourceListReady = false;
  let sourceLoadError = "";
  let sourceMoreError = "";
  const sourceListReadyWaiters = [];

  function setPreviewEmpty(title, message) {
    const empty = by("[data-file-preview-empty]");
    empty.querySelector("h3").textContent = title;
    empty.querySelector("p").textContent = message;
    empty.hidden = false;
  }

  function send(type, detail = {}) {
    if (!parentFrame) return;
    const businessBridge = globalThis.TradeLoomBusiness;
    const bridgeTarget = typeof businessBridge?.bridgeTarget === "function" ? businessBridge.bridgeTarget() : window.parent;
    if (!bridgeTarget) return;
    bridgeTarget.postMessage({ type, ...detail }, window.location.origin);
  }

  function text(tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null || value === "" ? "—" : String(value);
    return node;
  }

  function sourceLabel(source) {
    const latest = source.snapshots?.[0];
    if (!latest) return "尚未解析";
    const labels = { ready: "解析就绪", failed: "解析失败", pending: "等待解析", running: "解析中" };
    const label = labels[latest.status] || latest.status || "解析状态未知";
    return latest.status === "ready" ? `${label} · ${latest.cell_count} 个非空单元格` : label;
  }

  function safeImageUrl(value) {
    if (typeof value !== "string" || !/^\/api\/intake\/images\/[A-Za-z0-9_-]+\/preview$/.test(value)) return "";
    return globalThis.TradeLoomBusiness?.businessUrl?.(value) || value;
  }

  function validImages(images) {
    return (images || []).map(image => ({ ...image, safe_preview_url: safeImageUrl(image.preview_url) }))
      .filter(image => image.safe_preview_url);
  }

  function sourceImages(source) {
    return validImages(source?.images || []);
  }

  async function loadSourceImages(source) {
    const existing = sourceImages(source);
    if (existing.length || source.imagesLoaded) return existing;
    const snapshot = source?.snapshots?.find(item => item.id);
    if (!snapshot || !workbench.dataset.previewUrl) return [];
    if (!sourceImageRequests.has(source.id)) {
      const request = (async () => {
        const path = workbench.dataset.previewUrl.replace("__SNAPSHOT__", encodeURIComponent(snapshot.id));
        const url = globalThis.TradeLoomBusiness?.businessUrl?.(path) || path;
        const response = await fetch(new URL(url, window.location.href).href, { credentials: "same-origin", headers: { Accept: "application/json" } });
        const body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.detail || "图片预览暂时不可用。");
        const images = validImages(body.images);
        source.images = images;
        source.imagesLoaded = true;
        source.imagePreviewError = "";
        return images;
      })();
      sourceImageRequests.set(source.id, request);
    }
    const request = sourceImageRequests.get(source.id);
    try { return await request; }
    catch (error) {
      if (sourceImageRequests.get(source.id) === request) sourceImageRequests.delete(source.id);
      source.imagePreviewError = error instanceof Error ? error.message : "图片预览暂时不可用。";
      return [];
    } finally {
      if (sourceImageRequests.get(source.id) === request) sourceImageRequests.delete(source.id);
    }
  }

  function makeRow(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-list-item";
    button.dataset.fileKind = item.kind;
    button.dataset.fileId = item.id;
    button.draggable = true;
    button.setAttribute("aria-current", String(selected?.kind === item.kind && selected?.id === item.id));
    const sourceTimestamp = String(item.metadata_timestamp || item.timestamp || "日期未知");
    const timestamp = displayFileTimestamp(item.timestamp || sourceTimestamp);
    const detail = item.kind === "source"
      ? `${formatSize(item.byte_size)} · ${sourceTimestamp}`
      : `${formatSize(item.byte_size)} · ${sourceTimestamp} · ${item.status || "状态未知"}`;
    const baseTitle = `${item.name} · ${detail}${item.kind === "source" ? ` · ${sourceLabel(item)}` : ""}`;
    const name = document.createElement("span");
    name.className = "file-list-name-wrap";
    const previewUrl = safeImageUrl(item.thumbnail_url);
    const sourceImageError = item.kind === "source" && Boolean(item.source_record?.imagePreviewError);
    const sourceThumbnailError = item.kind === "source" && Boolean(item.source_record?.thumbnailError);
    const sourceImageLoading = item.kind === "source" && sourceImageRequests.has(item.id);
    if (displayMode === "grid" && previewUrl && !sourceThumbnailError) {
      button.dataset.thumbnailState = "loading";
      const frame = document.createElement("span");
      frame.className = "file-card-thumbnail-frame";
      frame.dataset.state = "loading";
      const thumbnail = document.createElement("img");
      thumbnail.className = "file-card-thumbnail";
      thumbnail.src = previewUrl;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      const status = text("span", "正在载入预览…", "file-thumbnail-status");
      status.setAttribute("aria-hidden", "true");
      thumbnail.addEventListener("load", () => {
        frame.dataset.state = "ready";
        button.dataset.thumbnailState = "ready";
        status.hidden = true;
        if (item.source_record) {
          item.source_record.thumbnailError = false;
          item.source_record.thumbnailLoaded = true;
        }
        button.title = baseTitle;
        button.setAttribute("aria-label", baseTitle);
      }, { once: true });
      thumbnail.addEventListener("error", () => {
        if (item.source_record) {
          item.source_record.thumbnailError = true;
          item.source_record.thumbnailLoaded = false;
        }
        renderFiles([...sourceById.values()]);
      }, { once: true });
      frame.append(thumbnail, status);
      name.append(frame);
    } else if (displayMode === "grid" && (sourceImageError || sourceThumbnailError || sourceImageLoading)) {
      button.dataset.thumbnailState = sourceImageLoading ? "loading" : "error";
      name.append(makeFileTypeIcon(item));
      const status = sourceImageLoading
        ? "正在读取图片预览…"
        : "图片预览失败，点击此项重试";
      name.append(text("span", status, "file-thumbnail-status"));
    } else if (displayMode === "grid" && item.kind === "source" && item.source_record?.imagesLoaded) {
      button.dataset.thumbnailState = "empty";
      name.append(makeFileTypeIcon(item));
    } else {
      name.append(makeFileTypeIcon(item));
    }
    name.append(text("span", item.name, "file-list-name"));
    button.append(name);
    const dateParts = timestamp.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{2}:\d{2}))?/);
    if (displayMode === "grid" && item.kind === "source") {
      button.append(text("span", formatSize(item.byte_size), "file-list-detail file-list-size"));
    } else {
      const date = text("span", dateParts?.[1] || timestamp, "file-list-detail");
      if (dateParts?.[2]) date.append(text("span", dateParts[2], "file-list-time"));
      const metadata = document.createElement("span");
      metadata.className = "file-list-metadata";
      metadata.append(date);
      metadata.append(text("span", formatSize(item.byte_size), "file-list-size"));
      button.append(metadata);
    }
    const imageStatus = displayMode === "grid" && item.kind === "source"
      ? (sourceImageError || sourceThumbnailError
        ? " · 图片预览失败，点击此项重试"
        : (sourceImageLoading || (previewUrl && !item.source_record?.thumbnailLoaded) ? " · 图片预览正在载入" : ""))
      : "";
    button.title = `${baseTitle}${imageStatus}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      choose(item.kind, item.id, true);
      if (displayMode !== "grid" || item.kind !== "source" || (!sourceImageError && !sourceThumbnailError)) return;
      if (item.source_record) {
        item.source_record.imagePreviewError = "";
        item.source_record.thumbnailError = false;
        item.source_record.thumbnailLoaded = false;
      }
      const imageLoad = loadSourceImages(item.source_record);
      renderFiles([...sourceById.values()]);
      imageLoad.then(() => renderFiles([...sourceById.values()]));
    });
    button.addEventListener("dragstart", event => {
      if (!event.dataTransfer) return;
      choose(item.kind, item.id, true);
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify({ kind: item.kind, id: item.id }));
    });
    return button;
  }

  function displayFileTimestamp(value) {
    const raw = String(value || "日期未知");
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).formatToParts(parsed);
        const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`;
      }
    }
    const parts = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T]+(\d{2}):(\d{2}))?/);
    if (!parts) return raw;
    return `${parts[1]}-${parts[2]}-${parts[3]}${parts[4] ? ` ${parts[4]}:${parts[5]}` : ""}`;
  }

  function makeFileTypeIcon(item) {
    const extension = String(item.extension || (item.kind === "source" ? "XLSX" : "FILE")).toUpperCase();
    const icon = document.createElement("span");
    icon.className = "file-type-icon";
    icon.dataset.fileType = extension;
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const typePaths = {
      XLSX: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h6M5 10h6M5 12h6M7 7.5v5",
      CSV: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h6M5 10h6M5 12h6M7 7.5v5",
      PDF: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h6M5 10h6M5 12h4",
      MD: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h5M5 10h6M5 12h4",
      PNG: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M4.5 11.5l2-2 1.5 1.5 1.5-2 2 2.5 M5.25 6.75h.01",
      JPG: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M4.5 11.5l2-2 1.5 1.5 1.5-2 2 2.5 M5.25 6.75h.01",
      JPEG: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M4.5 11.5l2-2 1.5 1.5 1.5-2 2 2.5 M5.25 6.75h.01",
      HTML: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5.5 8.5 4 10l1.5 1.5M10.5 8.5 12 10l-1.5 1.5M9 8l-2 4",
      HTM: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5.5 8.5 4 10l1.5 1.5M10.5 8.5 12 10l-1.5 1.5M9 8l-2 4",
      DOCX: "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h6M5 10h6M5 12h4",
    };
    path.setAttribute("d", typePaths[extension] || "M3 1.75h6l4 4v8.5H3z M9 1.75v4h4 M5 8h6M5 10h6M5 12h4");
    svg.append(path);
    icon.append(svg);
    return icon;
  }

  function formatSize(value) {
    if (value == null || value === "") return "大小未知";
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderFiles(sources) {
    const host = by("[data-file-list]");
    host.replaceChildren();
    host.setAttribute("aria-busy", "false");
    host.dataset.displayMode = displayMode;
    const showSources = mode !== "deliverables" && activeFilter !== "artifact";
    const showArtifacts = activeFilter !== "source";
    const sourceHeading = text("h4", "来源资料", "file-list-group-title");
    if (showSources) host.append(sourceHeading);
    if (showSources && sources.length) sources.forEach(source => host.append(makeRow({
      id: source.id, kind: "source", name: source.display_name || `工作簿-${source.id.slice(0, 8)}.xlsx`,
      byte_size: source.byte_size, timestamp: source.received_at_display || source.received_at,
      metadata_timestamp: source.received_at, snapshots: source.snapshots,
      source_record: source,
      thumbnail_url: sourceImages(source)[0]?.preview_url,
    })));
    else if (showSources && !sourceLoadError) host.append(text("p", "尚未接收来源工作簿。", "file-list-empty"));
    if (showSources && sourceLoadError) {
      host.append(text("p", sources.length
        ? `刷新来源资料失败，仍显示上次读取的 ${sources.length} 个文件：${sourceLoadError}`
        : `来源资料暂时无法读取：${sourceLoadError}`, "file-list-error"));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "file-list-more";
      retry.dataset.fileRetrySources = "true";
      retry.textContent = "重试读取来源资料";
      retry.addEventListener("click", loadSources);
      host.append(retry);
    }
    if (showSources && sourceMoreError) host.append(text("p", `较早的资料无法载入：${sourceMoreError}`, "file-list-error"));
    if (showSources && nextSourceOffset !== null) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "file-list-more";
      more.textContent = sourcesLoading ? "正在读取…" : "载入较早的来源资料";
      more.disabled = sourcesLoading;
      more.addEventListener("click", loadMoreSources);
      host.append(more);
    }

    if (showArtifacts) {
      host.append(text("h4", "交付版本", "file-list-group-title"));
      if (artifactRows.length) artifactRows.forEach(row => host.append(makeRow(row)));
      else host.append(text("p", "尚未登记交付版本。", "file-list-empty"));
    }
    const scope = by("[data-file-filter]");
    if (scope) {
      scope.value = activeFilter;
      for (const option of scope.options) option.hidden = mode === "deliverables" && option.value !== "artifact";
    }
    for (const button of root.querySelectorAll("[data-file-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.fileView === displayMode));
    }
    const up = by("[data-file-up]");
    if (up) up.hidden = activeFilter === "all" || mode === "deliverables";
    if (selected) markSelected();
  }

  function markSelected() {
    for (const button of root.querySelectorAll("[data-file-kind][data-file-id]")) {
      const active = button.dataset.fileKind === selected?.kind && button.dataset.fileId === selected?.id;
      button.setAttribute("aria-current", String(active));
      button.classList.toggle("is-selected", active);
    }
  }

  function setMetadata(lines) {
    const host = by("[data-file-preview-metadata]");
    const details = by("[data-file-preview-info]");
    if (details) details.open = false;
    host.replaceChildren();
    for (const [label, value] of lines) {
      const row = document.createElement("div");
      row.append(text("span", label, "file-meta-label"), text("strong", value, "file-meta-value"));
      host.append(row);
    }
    host.hidden = lines.length === 0;
    if (details) details.hidden = lines.length === 0;
  }

  function setStatus(value) {
    by("[data-file-preview-status]").textContent = value;
  }

  function setImageControls(enabled) {
    const controls = by("[data-image-controls]");
    if (controls) controls.hidden = !enabled;
    for (const selector of ["[data-image-fit]", "[data-image-actual]", "[data-image-zoom-in]", "[data-image-zoom-out]"]) {
      const button = by(selector);
      if (button) button.disabled = !enabled;
    }
  }

  function renderImage(images, sourceName) {
    const viewer = by("[data-file-image-viewer]");
    const strip = by("[data-file-image-strip]");
    const imageNode = by("[data-file-image]");
    strip.replaceChildren();
    const available = validImages(images);
    if (!available.length) {
      viewer.hidden = true;
      imageNode.removeAttribute("src");
      imageNode.hidden = true;
      imageNode.style.width = "";
      imageNode.style.height = "";
      imageNode.style.transform = "";
      selectedImageUrl = "";
      setImageControls(false);
      return;
    }
    viewer.hidden = false;
    strip.hidden = available.length < 2;
    available.forEach((image, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-image-thumb";
      button.setAttribute("aria-label", `预览图片 ${index + 1}`);
      button.setAttribute("aria-pressed", "false");
      button.dataset.imageUrl = image.safe_preview_url;
      const thumb = document.createElement("img");
      thumb.src = image.safe_preview_url;
      thumb.alt = "";
      thumb.loading = "lazy";
      button.append(thumb);
      button.addEventListener("click", () => selectImage(image, sourceName));
      strip.append(button);
    });
    selectImage(available[0], sourceName);
  }

  function selectImage(image, sourceName) {
    const imageNode = by("[data-file-image]");
    selectedImageUrl = image.safe_preview_url || safeImageUrl(image.preview_url);
    if (!selectedImageUrl) return;
    imageScale = 0;
    imageNode.style.width = "";
    imageNode.style.height = "";
    imageNode.style.transform = "";
    imageNode.src = selectedImageUrl;
    imageNode.alt = `${sourceName || "来源工作簿"} 中的嵌入图片 ${image.coordinate || ""}`.trim();
    imageNode.hidden = false;
    imageNode.dataset.fit = "true";
    by("[data-file-image-stage]").dataset.fit = "true";
    for (const button of by("[data-file-image-strip]").children) {
      button.setAttribute("aria-pressed", String(button.dataset.imageUrl === selectedImageUrl));
    }
    setImageControls(true);
  }

  function applyImageScale(scale) {
    if (!selectedImageUrl) return;
    const stage = by("[data-file-image-stage]");
    const imageNode = by("[data-file-image]");
    imageScale = scale;
    const fit = scale === 0;
    stage.dataset.fit = String(fit);
    imageNode.dataset.fit = String(fit);
    if (fit) {
      fitImageToStage();
    } else {
      imageNode.style.width = "";
      imageNode.style.height = "";
      imageNode.style.transform = `scale(${scale})`;
    }
  }

  function fitImageToStage() {
    if (!selectedImageUrl || imageScale !== 0) return;
    const stage = by("[data-file-image-stage]");
    const imageNode = by("[data-file-image]");
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const naturalWidth = imageNode.naturalWidth;
    const naturalHeight = imageNode.naturalHeight;
    if (!(width > 0 && height > 0 && naturalWidth > 0 && naturalHeight > 0)) return;
    const scale = Math.min(width / naturalWidth, height / naturalHeight);
    imageNode.style.width = `${Math.floor(naturalWidth * scale)}px`;
    imageNode.style.height = `${Math.floor(naturalHeight * scale)}px`;
    imageNode.style.transform = "";
  }

  const imageStage = by("[data-file-image-stage]");
  by("[data-file-image]").addEventListener("load", fitImageToStage);
  if (typeof ResizeObserver === "function") {
    const imageStageObserver = new ResizeObserver(fitImageToStage);
    imageStageObserver.observe(imageStage);
  } else {
    window.addEventListener("resize", fitImageToStage);
  }

  function announceRoleReady() {
    if (!parentFrame || !sourceListReady) return;
    if (mode === "files") send("tradeloom:files-ready");
    if (mode === "preview") {
      send("tradeloom:preview-ready");
      send("tradeloom:file-request-selection");
    }
  }

  function preview(item) {
    const generation = ++previewGeneration;
    const empty = by("[data-file-preview-empty]");
    const heading = by("[data-file-preview-heading]");
    const sourceHost = by("[data-file-source-preview]");
    const iframe = by("[data-artifact-inline-preview]");
    const download = by("[data-file-download]");
    const technical = by("[data-file-technical-details]");
    const technicalContent = by("[data-file-technical-content]");
    by("[data-file-preview-name]").textContent = item?.name || "未选择文件";
    if (heading) heading.hidden = !item;
    sourceHost.hidden = true;
    technicalContent.replaceChildren();
    technical.hidden = true;
    iframe.removeAttribute("src");
    iframe.hidden = true;
    empty.hidden = true;
    download.hidden = true;
    renderImage([], "");

    if (item.kind === "source") {
      const source = sourceById.get(item.id);
      if (!source) { setStatus("来源资料列表中没有此文件，刷新后重试。 "); empty.hidden = false; return; }
      setMetadata([
        ["类别", "来源工作簿"], ["文件名", source.display_name], ["文件大小", `${source.byte_size} bytes`],
        ["接收时间", source.received_at_display || source.received_at], ["解析状态", sourceLabel(source)],
      ]);
      setStatus("工作簿单元格预览");
      const sourceDownloadUrl = workbench.dataset.sourceDownloadUrl.replace("__SOURCE__", encodeURIComponent(source.id));
      download.href = globalThis.TradeLoomBusiness?.businessUrl?.(sourceDownloadUrl) || sourceDownloadUrl;
      download.textContent = "下载原件";
      download.hidden = false;
      by("[data-file-preview-name]").textContent = source.display_name;
      if (sourcePreviewNode && sourcePreviewNode.parentNode !== sourceHost) sourceHost.append(sourcePreviewNode);
      if (sourcePreviewNode) sourcePreviewNode.hidden = true;
      setStatus("正在读取工作簿预览…");
      setPreviewEmpty("正在读取工作簿", "正在载入已选来源的工作表与单元格预览。");
      window.dispatchEvent(new CustomEvent("tradeloom:file-selection", { detail: { kind: "source", id: source.id } }));
      loadSourceImages(source).then(images => {
        if (window.closed || generation !== previewGeneration || selected?.kind !== "source" || selected.id !== source.id) return;
        renderImage(images, source.display_name);
      });
      return;
    }

    const artifact = artifactById.get(item.id);
    if (!artifact) { setStatus("交付版本不存在或已不可用。"); empty.hidden = false; return; }
    by("[data-file-preview-name]").textContent = artifact.name;
    setMetadata([
      ["类别", artifact.category], ["版本", artifact.name], ["状态", artifact.status],
      ["更新时间", artifact.timestamp], ["所属批次", artifact.task_title],
    ]);
    const checksum = document.createElement("p");
    checksum.append(text("span", "SHA-256", "file-meta-label"), text("code", artifact.sha256, "mono"));
    const sources = document.createElement("p");
    sources.append(text("span", "来源版本", "file-meta-label"));
    const sourceValues = Array.isArray(artifact.source_product_versions) ? artifact.source_product_versions : [];
    sources.append(text("span", sourceValues.length
      ? sourceValues.map(source => `${source.product_id || ""} / ${source.revision_id || ""} v${source.version || ""}`).join("、")
      : "—", "mono"));
    technicalContent.append(checksum, sources);
    technical.hidden = false;
    if (sourcePreviewNode) sourcePreviewNode.hidden = true;
    download.href = globalThis.TradeLoomBusiness?.businessUrl?.(artifact.download_url) || artifact.download_url;
    download.textContent = "下载交付文件";
    download.hidden = false;
    if (artifact.preview_url) {
      iframe.src = globalThis.TradeLoomBusiness?.businessUrl?.(artifact.preview_url) || artifact.preview_url;
      iframe.hidden = false;
      setStatus("交付文件预览");
    } else {
      setStatus("此文件类型暂不支持在线预览。");
      empty.querySelector("h3").textContent = "暂不支持在线预览";
      empty.querySelector("p").textContent = "可下载已登记的交付文件。";
      empty.hidden = false;
    }
  }

  function choose(kind, id, notifyParent) {
    if (!((kind === "source" && sourceById.has(id)) || (kind === "artifact" && artifactById.has(id)))) return;
    selected = { kind, id };
    markSelected();
    if (mode !== "files" || localCombined) preview(selected);
    if (notifyParent) send("tradeloom:file-selection", selectionPayload(selected));
  }

  function selectionPayload(selection) {
    const payload = { kind: selection.kind, id: selection.id };
    const artifact = selection.kind === "artifact" ? artifactById.get(selection.id) : null;
    if (artifact?.artifact_type === "catalog_markdown") payload.previewMime = "text/markdown";
    return payload;
  }

  window.addEventListener("tradeloom:source-preview-state", event => {
    const detail = event.detail;
    if (!detail || typeof detail.sourceId !== "string"
      || selected?.kind !== "source" || selected.id !== detail.sourceId) return;
    const empty = by("[data-file-preview-empty]");
    if (detail.phase === "ready") {
      if (sourceHostNode) sourceHostNode.hidden = false;
      if (sourcePreviewNode) sourcePreviewNode.hidden = false;
      empty.hidden = true;
      setStatus("工作簿单元格预览");
      return;
    }
    if (sourceHostNode) sourceHostNode.hidden = true;
    if (sourcePreviewNode) sourcePreviewNode.hidden = true;
    const message = typeof detail.message === "string" && detail.message
      ? detail.message : "来源工作簿暂时没有可显示的预览。";
    setStatus(message);
    setPreviewEmpty(detail.phase === "loading" ? "正在读取工作簿" : "工作簿预览不可用", message);
  });

  function onParentMessage(event) {
    if (!parentFrame || !globalThis.TradeLoomBusiness?.isTrustedBridgeEvent?.(event)) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "tradeloom:file-export-request") {
      void exportFile(message);
      return;
    }
    if (message.type === "tradeloom:file-request-selection") {
      if (selected && (mode === "files" || (mode === "deliverables" && selected.kind === "artifact"))) {
        send("tradeloom:file-selection", selectionPayload(selected));
      }
      return;
    }
    if (message.type === "tradeloom:file-focus") {
      void focusFile(message);
      return;
    }
    if (message.type !== "tradeloom:file-selection") return;
    if (!((message.kind === "source" || message.kind === "artifact") && typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128)) return;
    receiveSelection(message);
  }

  async function focusFile(message) {
    const { kind, id, nonce } = message;
    if (mode !== "files"
      || (kind !== "source" && kind !== "artifact")
      || typeof id !== "string" || !id || id.length > 128
      || typeof nonce !== "string" || !nonce || nonce.length > 128) return;

    let item = null;
    try {
      if (kind === "source") {
        if (!sourceListReady && sourcesLoading) {
          await new Promise(resolve => sourceListReadyWaiters.push(resolve));
        }
        item = sourceById.get(id) || await ensureSource(id);
      } else {
        item = artifactById.get(id) || null;
      }
      if (!item) {
        send("tradeloom:file-focus-result", { kind, id, nonce, found: false });
        return;
      }

      if (activeFilter !== "all" && activeFilter !== kind) activeFilter = kind;
      renderFiles([...sourceById.values()]);
      const row = [...root.querySelectorAll("[data-file-kind][data-file-id]")]
        .find(node => node.dataset.fileKind === kind && node.dataset.fileId === id);
      if (!row) {
        send("tradeloom:file-focus-result", { kind, id, nonce, found: false });
        return;
      }

      choose(kind, id, false);
      row.focus({ preventScroll: true });
      const list = by("[data-file-list]");
      const rowRect = row.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const visibleTop = listRect.top + list.clientTop;
      const visibleBottom = visibleTop + list.clientHeight;
      if (rowRect.top < visibleTop) list.scrollTop -= visibleTop - rowRect.top;
      else if (rowRect.bottom > visibleBottom) list.scrollTop += rowRect.bottom - visibleBottom;
      send("tradeloom:file-focus-result", { kind, id, nonce, found: true });
    } catch {
      send("tradeloom:file-focus-result", { kind, id, nonce, found: false });
    }
  }

  function sendExportResponse(payload) {
    if (!parentFrame) return;
    const businessBridge = globalThis.TradeLoomBusiness;
    const bridgeTarget = typeof businessBridge?.bridgeTarget === "function" ? businessBridge.bridgeTarget() : window.parent;
    if (!bridgeTarget) return;
    bridgeTarget.postMessage(payload, window.location.origin);
  }

  async function exportFile(request) {
    const { kind, id, nonce } = request;
    const modeAllowed = (kind === "source" && mode === "files")
      || (kind === "artifact" && (mode === "files" || mode === "deliverables"));
    const requestValid = typeof id === "string" && Boolean(id) && id.length <= 128
      && typeof nonce === "string" && Boolean(nonce) && nonce.length <= 128;
    if (!modeAllowed || !requestValid) return;
    try {
      let item;
      if (kind === "source") {
        item = sourceById.get(id) || await ensureSource(id);
        if (!item) throw new Error("来源文件已不在当前列表中，请刷新后重试。");
      } else {
        item = artifactById.get(id);
        if (!item) throw new Error("交付版本已不可用，请刷新列表后重试。");
      }
      const rawUrl = kind === "source"
        ? workbench.dataset.sourceDownloadUrl.replace("__SOURCE__", encodeURIComponent(id))
        : item.download_url;
      if (typeof rawUrl !== "string" || !rawUrl) throw new Error("文件下载地址不可用。");
      const resolvedUrl = globalThis.TradeLoomBusiness?.businessUrl?.(rawUrl) || rawUrl;
      const url = new URL(resolvedUrl, window.location.href);
      if (url.origin !== window.location.origin) throw new Error("文件下载地址不属于当前工作台。");
      const response = await fetch(url.href, { credentials: "same-origin" });
      if (!response.ok) throw new Error(response.status === 404 ? "文件不存在或已不可用。" : "读取文件失败，请稍后重试。");
      const blob = await response.blob();
      const expectedSize = kind === "source" ? Number(item.byte_size)
        : (typeof item.byte_size === "number" && Number.isSafeInteger(item.byte_size) && item.byte_size >= 0 ? item.byte_size : null);
      if (expectedSize !== null && blob.size !== expectedSize) throw new Error("下载文件大小与资料记录不一致。");
      if (kind === "source" && blob.size > MAX_SOURCE_BYTES) throw new Error("来源文件超过工作台允许的 20 MiB 上限。");
      const responseMime = (response.headers?.get?.("Content-Type") || blob.type || "").split(";", 1)[0].trim().toLowerCase();
      const expectedMime = kind === "source" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : (item.mime_type || responseMime);
      if (responseMime && responseMime !== "application/octet-stream" && expectedMime
        && responseMime !== expectedMime.toLowerCase()) throw new Error("下载文件类型与资料记录不一致。");
      const outputBlob = expectedMime && blob.type.toLowerCase() !== expectedMime.toLowerCase()
        ? new Blob([blob], { type: expectedMime }) : blob;
      const name = kind === "source" ? item.display_name : item.filename;
      if (typeof name !== "string" || !name) throw new Error("文件名不可用。");
      const lastModified = kind === "source" ? Date.parse(item.received_at) : Number(item.last_modified);
      sendExportResponse({
        type: "tradeloom:file-export-response", kind, id, nonce,
        name, mimeType: expectedMime || responseMime || "application/octet-stream",
        lastModified: Number.isFinite(lastModified) ? lastModified : 0,
        blob: outputBlob,
      });
    } catch (error) {
      sendExportResponse({
        type: "tradeloom:file-export-response", kind, id, nonce,
        error: String(error?.message || "无法导出文件。").slice(0, 240),
      });
    }
  }

  async function fetchSourcePage(offset) {
    const host = by("[data-file-list]");
    const url = new URL(globalThis.TradeLoomBusiness?.businessUrl?.(workbench.dataset.sourcesUrl) || workbench.dataset.sourcesUrl, window.location.href);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "100");
    const response = await fetch(url.href, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.detail || "来源资料暂时无法读取。");
    for (const source of body.sources || []) sourceById.set(source.id, {
      ...source,
      received_at_display: source.received_at ? new Date(source.received_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—",
    });
    nextSourceOffset = body.next_offset;
    renderFiles([...sourceById.values()]);
  }

  async function loadSources() {
    if (sourcesLoading) return false;
    const host = by("[data-file-list]");
    const previousSources = [...sourceById.entries()];
    for (const [id, source] of previousSources) {
      sourceImageRequests.delete(id);
      source.imagesLoaded = false;
      source.imagePreviewError = "";
      source.thumbnailError = false;
      source.thumbnailLoaded = false;
      delete source.images;
    }
    const previousOffset = nextSourceOffset;
    sourcesLoading = true;
    host.setAttribute("aria-busy", "true");
    sourceById.clear();
    nextSourceOffset = null;
    try {
      await fetchSourcePage(0);
      sourceLoadError = "";
      sourceMoreError = "";
      sourcesLoaded = true;
      return true;
    } catch (error) {
      sourceById.clear();
      for (const [id, source] of previousSources) sourceById.set(id, source);
      nextSourceOffset = previousOffset;
      sourceLoadError = error.message || "暂时无法读取";
      return false;
    } finally {
      sourcesLoading = false;
      sourceListReady = true;
      host.removeAttribute("aria-busy");
      renderFiles([...sourceById.values()]);
      announceRoleReady();
      while (sourceListReadyWaiters.length) sourceListReadyWaiters.shift()();
    }
  }

  async function loadMoreSources() {
    if (sourcesLoading || nextSourceOffset === null) return;
    const host = by("[data-file-list]");
    sourcesLoading = true;
    host.setAttribute("aria-busy", "true");
    sourceMoreError = "";
    try { await fetchSourcePage(nextSourceOffset); }
    catch (error) { sourceMoreError = error.message || "无法载入"; }
    finally {
      sourcesLoading = false;
      host.removeAttribute("aria-busy");
      renderFiles([...sourceById.values()]);
    }
  }

  async function ensureSource(id) {
    if (sourceById.has(id)) return sourceById.get(id);
    while (nextSourceOffset !== null && nextSourceOffset <= 100000 && !sourceById.has(id)) {
      await fetchSourcePage(nextSourceOffset);
    }
    return sourceById.get(id) || null;
  }

  async function receiveSelection(message) {
    if (message.kind === "artifact") {
      choose(message.kind, message.id, false);
      return;
    }
    if (sourceById.has(message.id)) {
      choose(message.kind, message.id, false);
      return;
    }
    if (mode !== "preview") return;
    setStatus("正在载入所选来源资料…");
    try {
      const source = await ensureSource(message.id);
      if (!source) throw new Error("来源资料不在当前可载入范围内。");
      choose("source", message.id, false);
    } catch (error) {
      setStatus(error.message || "来源资料暂时不可用。");
      by("[data-file-preview-empty]").hidden = false;
    }
  }

  window.addEventListener("message", onParentMessage);
  by("[data-file-filter]")?.addEventListener("change", event => {
      const nextFilter = event.currentTarget.value;
      if (!["all", "source", "artifact"].includes(nextFilter)) return;
      if (mode === "deliverables" && nextFilter !== "artifact") return;
      activeFilter = nextFilter;
      renderFiles([...sourceById.values()]);
  });
  for (const button of root.querySelectorAll("[data-file-view]")) {
    button.addEventListener("click", () => {
      displayMode = button.dataset.fileView === "grid" ? "grid" : "rows";
      renderFiles([...sourceById.values()]);
      if (displayMode === "grid") {
        const imageLoads = [...sourceById.values()].map(loadSourceImages);
        renderFiles([...sourceById.values()]);
        Promise.all(imageLoads).then(() => renderFiles([...sourceById.values()]));
      }
    });
  }
  by("[data-image-fit]")?.addEventListener("click", () => applyImageScale(0));
  by("[data-image-actual]")?.addEventListener("click", () => applyImageScale(1));
  by("[data-image-zoom-in]")?.addEventListener("click", () => applyImageScale(imageScale === 0 ? 1.25 : Math.min(8, imageScale + 0.25)));
  by("[data-image-zoom-out]")?.addEventListener("click", () => applyImageScale(imageScale === 0 ? 0.75 : Math.max(0.1, imageScale - 0.25)));
  window.addEventListener("tradeloom:source-images", event => {
    const detail = event.detail;
    if (!detail || typeof detail.sourceId !== "string") return;
    const source = sourceById.get(detail.sourceId);
    if (!source) return;
    source.images = validImages(detail.images);
    if (displayMode === "grid") renderFiles([...sourceById.values()]);
    if (selected?.kind === "source" && selected.id === source.id) renderImage(source.images, source.display_name);
  });
  by("[data-file-up]")?.addEventListener("click", () => {
    activeFilter = "all";
    renderFiles([...sourceById.values()]);
  });
  window.addEventListener("hashchange", () => {
    const previousMode = mode;
    mode = ["files", "preview", "deliverables"].includes(window.location.hash.slice(1))
      ? window.location.hash.slice(1)
      : "";
    if (previousMode === mode) return;
    if (mode === "deliverables" && selected?.kind === "source") selected = null;
    if (mode === "deliverables") activeFilter = "artifact";
    else if (previousMode === "deliverables") activeFilter = "all";
    if (sourcesLoaded) renderFiles([...sourceById.values()]);
    if ((mode === "files" || mode === "preview") && !sourcesLoaded) loadSources();
    else announceRoleReady();
    if (localCombined && mode) {
      by("[data-file-list-pane]").hidden = false;
      by("[data-file-preview-pane]").hidden = false;
    }
  });
  if (mode === "preview" && sourcePreviewNode) sourcePreviewNode.hidden = true;
  by("[data-file-refresh]")?.addEventListener("click", () => {
    if (mode === "deliverables") window.location.reload();
    else loadSources();
  });
  document.querySelector("[data-intake-refresh-sources]")?.addEventListener("click", loadSources);
  if (mode === "files" || mode === "preview") loadSources().then(ok => {
    if (ok) sourcesLoaded = true;
    if (ok && mode === "files" && displayMode === "grid") Promise.all([...sourceById.values()].map(loadSourceImages)).then(() => renderFiles([...sourceById.values()]));
    if (ok && localCombined) {
      by("[data-file-list-pane]").hidden = false;
      by("[data-file-preview-pane]").hidden = false;
    }
  });
  else if (mode === "deliverables") {
    renderFiles([]);
    if (localCombined) {
      by("[data-file-list-pane]").hidden = false;
      by("[data-file-preview-pane]").hidden = false;
    }
  }
})();
