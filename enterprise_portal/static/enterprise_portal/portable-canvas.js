(() => {
  const data = document.getElementById("portable-graph-data");
  if (!data) return;
  const {nodes, edges} = JSON.parse(data.textContent);
  const stage = document.querySelector(".portable-graph-stage");
  const canvas = stage.querySelector("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;

  const translate = (axis, limit) => {
    const low = Math.min(...nodes.map(node => node[axis]));
    const high = Math.max(...nodes.map(node => node[axis]));
    const scale = high === low ? 1 : Math.min(1, limit / (high - low));
    return {scale, point: value => 16 + Math.round((value - low) * scale)};
  };
  const translateX = translate("x", 1620);
  const translateY = translate("y", 1380);
  const width = 142;
  const height = 46;
  const points = nodes.map(node => ({x: translateX.point(node.x), y: translateY.point(node.y)}));
  // Leave room to move the rightmost and bottommost nodes in the same view.
  canvas.width = Math.max(...points.map(point => point.x)) + width + 96;
  canvas.height = Math.max(...points.map(point => point.y)) + height + 96;
  canvas.hidden = false;
  document.getElementById("portable-graph-hint").hidden = false;

  function draw() {
    const style = getComputedStyle(canvas);
    const theme = name => style.getPropertyValue(name).trim();
    context.fillStyle = theme("--bg");
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = theme("--dim");
    context.fillStyle = context.strokeStyle;
    for (const [start, end] of edges) {
      const source = points[start];
      const target = points[end];
      const forward = target.x >= source.x + width;
      const fromX = source.x + (forward ? width : width / 2);
      const fromY = source.y + (forward ? height / 2 : height);
      const toX = target.x + (forward ? 0 : width / 2);
      const toY = target.y + (forward ? height / 2 : 0);
      const angle = Math.atan2(toY - fromY, toX - fromX);
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(toX, toY);
      context.stroke();
      context.beginPath();
      context.moveTo(toX, toY);
      context.lineTo(toX - 9 * Math.cos(angle - 0.45), toY - 9 * Math.sin(angle - 0.45));
      context.lineTo(toX - 9 * Math.cos(angle + 0.45), toY - 9 * Math.sin(angle + 0.45));
      context.closePath();
      context.fill();
    }

    context.font = "14px sans-serif";
    context.textBaseline = "middle";
    points.forEach(({x, y}, index) => {
      context.fillStyle = theme("--panel");
      context.fillRect(x, y, width, height);
      context.strokeRect(x, y, width, height);
      context.fillStyle = theme("--text");
      const label = `${index + 1}. ${nodes[index].title}`;
      const visible = Array.from(label);
      while (context.measureText(visible.join("")).width > width - 24) visible.pop();
      context.fillText(visible.join("") + (visible.length < Array.from(label).length ? "…" : ""), x + 8, y + height / 2);
    });
  }
  const dragThreshold = 8;
  const coordinateLimit = 100000;
  const bound = (value, min, max) => Math.max(min, Math.min(max, value));
  let drag = null;

  function positionHandle(handle, point) {
    handle.style.left = `${point.x}px`;
    handle.style.top = `${point.y}px`;
  }

  function moveNode(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
    drag.moved = true;
    drag.handle.classList.add("is-dragging");
    const {index, originalPoint, originalNode} = drag;
    const pointX = bound(originalPoint.x + dx, 0, canvas.width - width);
    const pointY = bound(originalPoint.y + dy, 0, canvas.height - height);
    const x = bound(originalNode.x + Math.round((pointX - originalPoint.x) / translateX.scale), -coordinateLimit, coordinateLimit);
    const y = bound(originalNode.y + Math.round((pointY - originalPoint.y) / translateY.scale), -coordinateLimit, coordinateLimit);
    nodes[index] = {...nodes[index], x, y};
    points[index] = {x: translateX.point(x), y: translateY.point(y)};
    positionHandle(drag.handle, points[index]);
    draw();
  }

  function stopDrag(event, cancel = false) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const {index, originalPoint, originalNode, handle, moved} = drag;
    drag = null;
    handle.classList.remove("is-dragging");
    if (!moved) return;
    if (cancel) {
      nodes[index] = originalNode;
      points[index] = originalPoint;
      positionHandle(handle, originalPoint);
      draw();
      return;
    }
    for (const axis of ["x", "y"]) {
      document.querySelector(`input[name="${axis}_${index}"]`).value = nodes[index][axis];
    }
  }

  points.forEach((point, index) => {
    const handle = document.createElement("div");
    handle.className = "portable-graph-handle";
    handle.style.width = `${width}px`;
    handle.style.height = `${height}px`;
    positionHandle(handle, point);
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      handle.setPointerCapture(event.pointerId);
      drag = {
        handle, index, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        originalNode: nodes[index], originalPoint: points[index], moved: false,
      };
    });
    handle.addEventListener("pointermove", moveNode);
    handle.addEventListener("pointerup", event => stopDrag(event));
    handle.addEventListener("pointercancel", event => stopDrag(event, true));
    handle.addEventListener("lostpointercapture", event => stopDrag(event, true));
    stage.append(handle);
  });

  draw();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
})();
