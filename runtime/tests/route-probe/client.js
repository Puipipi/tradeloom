window.__ModuleLoader__.load({
	id: "dsh-app-route-probe",
	factory: (require) => {
		var module = { exports: {} };
		// Test-only browser half: third-party occupants in a settings section, the input dock and a
		// right pane tab (type in `sidebarRightTabs`, body and title in the keyed slots), so the
		// bridge's attribution, island masking and tab opening can be checked on a real page.
		const React = require("react");
		const TAB_ID = "route-probe:tab";
		const Dock = () => React.createElement("div", { "data-route-probe": "dock" }, "route-probe dock");
		const Section = () => React.createElement("div", { "data-route-probe": "section" }, "route-probe section");
		const TabBody = () => React.createElement("div", { "data-route-probe": "tab" }, "route-probe tab body");
		const TabTitle = () => React.createElement("span", { "data-route-probe": "tab-title" }, "Probe tab");
		module.exports.inject = ["slots"];
		module.exports.apply = (ctx) => {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
				{ name: "conversation.input.dock", id: "route-probe-dock", order: 900, label: "Probe dock" }, Dock));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "route-probe", order: 900, label: () => "Probe section" }, Section));
			ctx.inject(["sidebarRightTabs"], (inner) => {
				inner.effect(() => inner.get("sidebarRightTabs").register({
					id: TAB_ID,
					kind: "route-probe-tab",
					priority: "extension",
					title: () => "Probe tab",
					guide: [{ id: "route-probe-tab", order: 900, title: () => "Probe tab" }],
				}), "route-probe: tab type");
			});
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
				{ name: "sidebar.right.pane.tab", key: TAB_ID }, TabBody));
			ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
				{ name: "sidebar.right.pane.tab.title", key: TAB_ID }, TabTitle));
		};
		return module.exports;
	}
});
