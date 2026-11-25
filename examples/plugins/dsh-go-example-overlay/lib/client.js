window.__ModuleLoader__.load({
  id: "dsh-go-example-overlay",
  factory: (require) => {
    const React = require("react");
    const { createElement: h, useEffect, useRef, useState } = React;
    const NAME = "dsh-go-example-overlay";

    const pillStyle = {
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "8px 14px", minHeight: 40, borderRadius: 999,
      border: "1px solid var(--dsw-alias-border-l2, rgba(75, 103, 180, 0.28))",
      background: "var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.92))",
      color: "var(--dsw-alias-label-primary, #1b2434)",
      boxShadow: "0 8px 24px rgba(15, 23, 42, 0.14)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      fontSize: 13, fontWeight: 500, lineHeight: 1.2, cursor: "pointer",
      fontVariantNumeric: "tabular-nums",
    };

    const badgeStyle = {
      padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: "var(--dsw-alias-bg-layer-2, rgba(75, 103, 180, 0.12))",
      color: "var(--dsw-alias-brand-primary, #4b67b4)",
      fontVariantNumeric: "tabular-nums",
    };

    const dotStyle = {
      width: 8, height: 8, borderRadius: 999, flexShrink: 0,
      background: "var(--dsw-alias-state-success-primary, #10b981)",
      boxShadow: "0 0 0 3px rgba(16, 185, 129, 0.18)",
    };

    function Counter({ title, subtitle }) {
      const [count, setCount] = useState(0);
      return h("section", {
        style: {
          padding: 16, borderRadius: 18,
          border: "1px solid var(--dsw-alias-border-l2, rgba(148, 163, 184, 0.24))",
          background: "var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.72))",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        },
      },
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1b2434)" } }, title),
          subtitle ? h("div", { style: { marginTop: 4, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #64748b)" } }, subtitle) : null,
        ),
        h("button", {
          type: "button", style: pillStyle,
          onClick: () => setCount((value) => value + 1),
        },
          h("span", null, "Clicks"),
          h("span", { style: badgeStyle }, String(count)),
        ),
      );
    }

    function Overlay() {
      const root = useRef(null);
      const button = useRef(null);
      const drag = useRef(null);
      const [position, setPosition] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [count, setCount] = useState(0);
      const maxOrigin = () => ({
        x: Math.max(0, (root.current ? root.current.clientWidth : 0) - (button.current ? button.current.offsetWidth : 0)),
        y: Math.max(0, (root.current ? root.current.clientHeight : 0) - (button.current ? button.current.offsetHeight : 0)),
      });
      const clamp = (point) => {
        const max = maxOrigin();
        return { x: Math.max(0, Math.min(point.x, max.x)), y: Math.max(0, Math.min(point.y, max.y)) };
      };
      const snapEdge = (point) => {
        const max = maxOrigin();
        const clamped = clamp(point);
        return { x: clamped.x <= max.x / 2 ? 0 : max.x, y: clamped.y };
      };

      useEffect(() => {
        // Tracks the clipped chat viewport as native keyboard layout resizes it.
        const sync = () => setPosition((point) => point ? clamp(point) : maxOrigin());
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(root.current);
        const node = button.current;
        return () => {
          observer.disconnect();
          const active = drag.current;
          drag.current = null;
          if (active && node && node.hasPointerCapture(active.id)) node.releasePointerCapture(active.id);
        };
      }, []);

      const down = (event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        const origin = position || maxOrigin();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
          start: origin, moved: false };
        setDragging(true);
      };
      const move = (event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        const dx = event.clientX - active.x;
        const dy = event.clientY - active.y;
        if (Math.hypot(dx, dy) > 5) active.moved = true;
        if (active.moved) setPosition(clamp({ x: active.start.x + dx, y: active.start.y + dy }));
      };
      const finish = (event, cancelled) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(active.id)) event.currentTarget.releasePointerCapture(active.id);
        if (active.moved) setPosition((point) => snapEdge(point || active.start));
        else if (!cancelled) setCount((value) => value + 1);
      };

      const placed = position || { x: 0, y: 0 };
      return h("div", { ref: root, style: {
        position: "fixed", left: 12, right: 12,
        top: "calc(var(--dsh-go-island-top, 0px) + 12px)",
        bottom: "calc(var(--dsh-go-island-bottom, 0px) + 12px)",
        pointerEvents: "none",
      } }, h("button", {
        ref: button, type: "button", "aria-label": "Overlay sample: drag or tap to count",
        style: {
          ...pillStyle, position: "absolute", left: placed.x, top: placed.y,
          visibility: position ? "visible" : "hidden",
          transform: dragging ? "scale(0.97)" : "scale(1)",
          transition: dragging
            ? "transform 120ms ease"
            : "left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 150ms ease",
          maxWidth: "100%", boxSizing: "border-box", pointerEvents: "auto",
          touchAction: "none", userSelect: "none",
        },
        onPointerDown: down, onPointerMove: move,
        onPointerUp: (event) => finish(event, false),
        onPointerCancel: (event) => finish(event, true),
        onLostPointerCapture: (event) => finish(event, true),
        // Pointer taps count on pointerup; detail=0 keeps keyboard activation working.
        onClick: (event) => { if (event.detail === 0) setCount((value) => value + 1); },
      },
        h("span", { style: dotStyle }),
        h("span", null, "Overlay"),
        h("span", { style: badgeStyle }, String(count)),
      ));
    }

    function Footer() {
      const [count, setCount] = useState(0);
      return h("button", {
        type: "button", style: pillStyle,
        onClick: () => setCount((value) => value + 1),
      },
        h("span", { style: dotStyle }),
        h("span", null, "Sidebar action"),
        h("span", { style: badgeStyle }, String(count)),
      );
    }
    const Settings = () => h(Counter, { title: "Overlay sample settings", subtitle: "Isolated settings.plugins.tab page island" });
    const Detail = ({ subject }) => subject?.pkg?.name === NAME
      ? h(Counter, { title: "Overlay sample detail", subtitle: "Isolated plugins.detail.section page island" }) : null;

    return {
      name: NAME,
      inject: ["slots"],
      apply(ctx) {
        for (const [name, id, label, component] of [
          ["shell.overlay", "overlay", "Overlay sample", Overlay],
          ["sidebar.footer.action", "footer", "Overlay sample sidebar", Footer],
          ["settings.plugins.tab", "settings", "Overlay sample settings", Settings],
          ["plugins.detail.section", "detail", "Overlay sample detail", Detail],
        ]) {
          ctx.slots.inject(name, () => ctx.slots.register(
            { name, id: NAME + ":" + id, order: 900, label: () => label }, component));
        }
      },
    };
  },
});
