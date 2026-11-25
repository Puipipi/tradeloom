window.__ModuleLoader__.load({
	id: "dsh-go-bridge",
	factory: (require) => {
		// Boot awaits this factory before mounting Markdown, whose file-link parser
		// calls URL.canParse. Older WebViews have URL but lack that static method.
		const URLConstructor = URL;
		if (typeof URLConstructor.canParse !== "function") {
			Object.defineProperty(URLConstructor, "canParse", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: {
					canParse(url) {
						if (arguments.length === 0) throw new TypeError("URL.canParse requires a URL argument");
						// WebIDL converts both arguments before parsing; conversion errors
						// must escape rather than becoming an invalid-URL result.
						const urlString = `${url}`;
						const base = arguments[1];
						const baseString = base === undefined ? undefined : `${base}`;
						try {
							new URLConstructor(urlString, baseString);
							return true;
						} catch {
							return false;
						}
					},
				}.canParse,
			});
		}
		var module = { exports: {} };
		// dsh-go-bridge, browser half (docs/design/plugin-seams.md §5.2, §6.1).
		//
		// 1. Attribution: a slot entry only records `registrant` (the plugin's exported `name`, or an
		//    ancestor's when it exports none), so it cannot be traced to a package. When the `slots`
		//    service appears this plugin wraps its `_register` to stamp each new entry with the package
		//    of the registering Loader entry. Cordis starts the service's consumers one microtask after
		//    `internal/service` fires, so every consumer is stamped if this plugin is running by then;
		//    hence no `inject` and `dsh.client.immediately`.
		// 2. Occupancy: reports every slot's entries to POST /dsh-go/v1/occupancy (debounced, deduped).
		// 3. Island mode (`#dsh-go-island=<slot>[,<slot>...]` or `window.__dshGoBridge.mask([...])`):
		//    shadows the official entries of those list / keyed slots with empty ones at a lower
		//    priority. Outlets that render entry components (input dock, header actions) then show only
		//    third-party entries; menus whose owner draws entry labels itself (sidebar.panellist,
		//    settings navigation) keep a stub row per masked cell, which the island's CSS must hide.
		// 4. Right pane tabs: a `sidebar.right.pane.tab(.title)` entry is keyed by a tab type id whose
		//    name lives in the `sidebarRightTabs` registry, not in the slot. Reports carry that type
		//    (`tab`, and `label` = its name); `openTab(id)` / `#dsh-go-tab=<id>` opens it on screen.
		const NAME = "dsh-go-bridge";
		const ORIGINAL = Symbol.for("cordis.original");
		const MASK_PRIORITY = -1000000007;
		const REPORT_DELAY_MS = 1200;
		const isOfficial = (pkg) => typeof pkg === "string" && pkg.startsWith("@deepseek-ai/");
		const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const raw = (service) => (service && service[ORIGINAL]) || service;

		/** Package of the Loader entry owning `fiber` (walks up to the nearest entry fiber). */
		function packageOfFiber(fiber) {
			for (let f = fiber, depth = 0; f && depth < 64; depth++) {
				const name = f.entry && f.entry.options && f.entry.options.name;
				if (typeof name === "string") return name.replace(/\/client$/, "");
				const parent = f.parent && f.parent.fiber;
				if (!parent || parent === f) break;
				f = parent;
			}
			return undefined;
		}

		function labelOf(label) {
			try {
				const text = typeof label === "function" ? label() : label;
				return typeof text === "string" ? text.slice(0, 256) : undefined;
			} catch {
				return undefined;
			}
		}

		function hashParam(name) {
			const match = new RegExp(`(?:^#|[#&])${name}=([^&]*)`).exec(location.hash);
			if (!match) return undefined;
			try {
				return decodeURIComponent(match[1]);
			} catch {
				return undefined;
			}
		}

		function islandSlots() {
			return (hashParam("dsh-go-island") || "").split(",").map((s) => s.trim()).filter(Boolean);
		}

		const RIGHT_TAB_SLOTS = new Set(["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]);
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/** One right pane tab type, JSON-safe: what the guide calls it and how to open it. */
		function tabTypeInfo(definition) {
			const guide = (Array.isArray(definition.guide) ? definition.guide : []).map((g) => {
				const entry = { id: String(g.id), order: finite(g.order) };
				const title = labelOf(g.title);
				if (title !== undefined) entry.title = title;
				return entry;
			}).sort((a, b) => a.order - b.order);
			const info = { id: String(definition.id), kind: String(definition.kind), guide };
			let title;
			try {
				title = typeof definition.title === "function" ? definition.title(`sidebar://${definition.kind}`) : undefined;
			} catch {}
			if (typeof title === "string") info.title = title.slice(0, 256);
			if (definition.multiple === true) info.multiple = true;
			return info;
		}

		function apply(ctx) {
			// StoredEntry -> package. Kept on the page, so a re-applied bridge (HMR, plugin reload)
			// still knows the entries stamped by its predecessor.
			const STAMPS = Symbol.for("dsh-go-bridge.stamps");
			const stamps = window[STAMPS] || (window[STAMPS] = new WeakMap());
			const masks = new Map();        // `${slot}\0${cell}` -> { entry?, dispose }
			const maskedSlots = new Map();  // slot -> disposer
			const filters = new Map();      // slot -> package/cell allowlist (display only)
			const syncing = new Set();
			let wrappedSlots;
			let stampedFrom = "late";

			const wrap = (service, when) => {
				const target = raw(service);
				if (!target || target === wrappedSlots || typeof target._register !== "function") return;
				const original = target._register;
				target._register = function (options, component) {
					const key = options && options.name;
					let before;
					try {
						before = typeof key === "string" ? new Set(this.entries(key)) : undefined;
					} catch {}
					const dispose = original.call(this, options, component);
					try {
						const pkg = packageOfFiber(this.ctx && this.ctx.fiber);
						if (before !== undefined && pkg !== undefined) {
							for (const entry of this.entries(key)) if (!before.has(entry)) stamps.set(entry, pkg);
						}
					} catch {}
					return dispose;
				};
				wrappedSlots = target;
				stampedFrom = when;
				ctx.effect(() => () => {
					if (target._register !== original) delete target._register;
					if (wrappedSlots === target) wrappedSlots = undefined;
				}, "dsh-go-bridge: slot attribution");
			};
			wrap(ctx.get("slots"), "late");
			ctx.on("internal/service", (name, value) => {
				if (name === "slots" && value !== undefined) wrap(value, "start");
			});

			/** registrant -> package, for entries registered before attribution started (unique names only). */
			const nameMap = () => {
				const byName = new Map();
				try {
					for (const entry of ctx.get("loader").entries()) {
						const fiberName = entry.fiber && entry.fiber.name;
						if (typeof fiberName !== "string" || typeof entry.options.name !== "string") continue;
						const set = byName.get(fiberName) || new Set();
						set.add(entry.options.name.replace(/\/client$/, ""));
						byName.set(fiberName, set);
					}
				} catch {}
				return byName;
			};

			/** Stamped package, else the unique package behind the entry's registrant, else null. */
			const resolvePackage = (entry, names) => {
				const stamped = stamps.get(entry);
				if (stamped !== undefined) return stamped;
				const candidates = names.get(entry.registrant);
				return candidates && candidates.size === 1 ? [...candidates][0] : null;
			};

			/** Right pane tab types in force (the `sidebarRightTabs` registry), or none. */
			const rightTabTypes = () => {
				try {
					const registry = ctx.get("sidebarRightTabs");
					return registry ? [...registry.entries()] : [];
				} catch {
					return [];
				}
			};

			const collect = () => {
				const slots = ctx.get("slots");
				if (!slots) return undefined;
				const keys = new Set();
				const walk = (nodes) => {
					for (const node of nodes || []) {
						if (node.type === "slot") keys.add(node.name);
						walk(node.children);
					}
				};
				walk(slots.snapshot());
				const names = nameMap();
				const ownMasks = new Set([...masks.values()].map((m) => m.entry).filter(Boolean));
				const out = {};
				let unresolved = 0;
				for (const key of keys) {
					let winners;
					try {
						winners = new Set(slots.entriesOfSlot(key));
					} catch {
						winners = new Set();
					}
					// A cell this page shadows (island mode) reports the entry that would win without the
					// mask: the first remaining one in priority order.
					const shadowed = new Set();
					for (const w of winners) if (ownMasks.has(w)) shadowed.add(String((w.options || {}).id ?? (w.options || {}).key ?? ""));
					const list = [];
					for (const entry of slots.entries(key)) {
						if (ownMasks.has(entry)) continue;
						const cellOf = String((entry.options || {}).id ?? (entry.options || {}).key ?? "");
						if (shadowed.delete(cellOf)) winners.add(entry);
						const pkg = resolvePackage(entry, names);
						if (pkg === NAME) continue;
						if (pkg === null) unresolved++;
						const o = entry.options || {};
						const occupant = {
							package: pkg,
							cell: String(o.id ?? o.key ?? ""),
							order: finite(o.order),
							priority: finite(o.priority),
							active: winners.has(entry),
						};
						let label = labelOf(o.label);
						if (RIGHT_TAB_SLOTS.has(key)) {
							const type = rightTabTypes().find((d) => String(d.id) === occupant.cell);
							if (type !== undefined) {
								occupant.tab = tabTypeInfo(type);
								if (label === undefined) label = (occupant.tab.guide[0] && occupant.tab.guide[0].title) || occupant.tab.title;
							}
						}
						if (label !== undefined) occupant.label = label;
						if (typeof entry.registrant === "string") occupant.registrant = entry.registrant;
						list.push(occupant);
					}
					if (list.length > 0) out[key] = list;
				}
				return { slots: out, unresolved };
			};

			let timer;
			let lastSent = "";
			const report = async () => {
				timer = undefined;
				const boot = window.__DSH_BOOT__;
				const collected = collect();
				if (!collected || !boot || typeof boot.rev !== "string") return;
				const body = JSON.stringify({ bootRev: boot.rev, attribution: stampedFrom, unresolved: collected.unresolved, slots: collected.slots });
				if (body === lastSent) return;
				try {
					const response = await fetch(new URL("dsh-go/v1/occupancy", document.baseURI), {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body,
					});
					if (response.ok) lastSent = body;
				} catch {}
			};
			const schedule = () => {
				if (timer !== undefined) clearTimeout(timer);
				timer = setTimeout(report, REPORT_DELAY_MS);
			};
			ctx.on("slots/changed", schedule);
			ctx.on("connection/reset", () => {
				lastSent = "";
				schedule();
			});
			// Tab names live in their own registry; a rename or a new type reports too.
			let tabsWatched;
			const watchTabs = (registry) => {
				if (!registry || registry === tabsWatched || typeof registry.subscribe !== "function") return;
				tabsWatched = registry;
				const off = registry.subscribe(schedule);
				ctx.effect(() => () => off(), "dsh-go-bridge: right pane tab names");
			};
			watchTabs(ctx.get("sidebarRightTabs"));
			ctx.on("internal/service", (name, value) => {
				if (name === "sidebarRightTabs" && value !== undefined) watchTabs(value);
			});

			/**
			 * Open a right pane tab on the on-screen conversation: `target` is a tab type id (the slot
			 * cell), its kind, or one of its guide entry ids. Waits up to `timeoutMs` (default 15 s) for a
			 * conversation to be on screen, expands the column and resolves once the tab is active.
			 */
			const openTab = async (target, options = {}) => {
				const deadline = Date.now() + (finite(options.timeoutMs) || 15000);
				const find = () => {
					const types = rightTabTypes();
					return types.find((d) => d.id === target) || types.find((d) => d.kind === target)
						|| types.find((d) => (d.guide || []).some((g) => g.id === target));
				};
				let type;
				let opened = false;
				let lastError = "no-sidebar";
				while (Date.now() <= deadline) {
					const sidebar = ctx.get("sidebarRight");
					type = type || find();
					if (sidebar && type) {
						try {
							if (!opened) {
								sidebar.openTab(type.kind, options.replaceTab === true ? { replaceTab: true } : {});
								opened = true;
							}
							if (!sidebar.isExpanded()) sidebar.toggleExpanded();
							const active = sidebar.active();
							if (active && active.kind === type.kind) return { ok: true, id: String(type.id), kind: String(type.kind), tabId: String(active.id) };
							lastError = "not-active";
						} catch (error) {
							lastError = /no session surface/.test(String(error && error.message)) ? "no-session" : String(error && error.message || error).slice(0, 200);
						}
					} else {
						lastError = sidebar ? "unknown-tab" : "no-sidebar";
					}
					await sleep(200);
				}
				return { ok: false, reason: lastError };
			};
			const pendingTab = hashParam("dsh-go-tab");
			if (pendingTab) {
				ctx.effect(() => {
					let cancelled = false;
					openTab(pendingTab, { timeoutMs: 30000 }).then((result) => {
						if (!cancelled && !result.ok) console.warn(`[${NAME}] cannot open right pane tab ${pendingTab}: ${result.reason}`);
					});
					return () => {
						cancelled = true;
					};
				}, "dsh-go-bridge: island tab");
			}
			ctx.effect(() => {
				schedule();
				return () => {
					if (timer !== undefined) clearTimeout(timer);
				};
			}, "dsh-go-bridge: occupancy report");

			const Empty = () => null;
			const syncMasks = (key) => {
				const slots = ctx.get("slots");
				if (!slots || syncing.has(key)) return;
				syncing.add(key);
				try {
					const names = nameMap();
					const allow = filters.get(key);
					const own = new Set([...masks.values()].map((m) => m.entry));
					const seen = new Set();
					const hidden = new Set();
					for (const entry of slots.entries(key)) {
						if (own.has(entry)) continue;
						const pkg = resolvePackage(entry, names);
						const cell = String((entry.options || {}).id ?? (entry.options || {}).key ?? "");
						if (allow) {
							// Keep the original election: never promote a lower-priority allowed plugin.
							if (seen.has(cell)) continue;
							seen.add(cell);
							if (!isOfficial(pkg) && allow.some((a) => a.package === pkg && a.cell === cell)) continue;
						} else if (!isOfficial(pkg)) continue; // legacy mask leaves unresolved entries visible
						const o = entry.options || {};
						const field = o.id !== undefined ? "id" : o.key !== undefined ? "key" : undefined;
						if (field === undefined) {
							if (allow) throw new Error("filter requires a list or keyed cell");
							continue;
						}
						const id = `${key}\u0000${o[field]}`;
						hidden.add(id);
						const priority = allow ? Math.min(MASK_PRIORITY, finite(o.priority) - 1) : MASK_PRIORITY;
						const previous = masks.get(id);
						if (previous) {
							if (!allow || (previous.entry && previous.entry.options.priority <= priority)) continue;
							masks.delete(id);
							previous.dispose && previous.dispose();
						}
						const record = { entry: undefined, dispose: undefined };
						masks.set(id, record);
						try {
							const before = new Set(slots.entries(key));
							record.dispose = slots.register({ name: key, [field]: o[field], order: o.order, priority }, Empty);
							for (const e of slots.entries(key)) if (!before.has(e)) record.entry = e;
						} catch (error) {
							masks.delete(id);
							if (allow) throw error;
							console.warn(`[${NAME}] cannot mask ${key}/${o[field]}:`, error);
						}
					}
					for (const [id, record] of masks) {
						if (!allow || !id.startsWith(`${key}\u0000`) || hidden.has(id)) continue;
						masks.delete(id);
						record.dispose && record.dispose();
					}
				} finally { syncing.delete(key); }
			};
			const mask = (keys) => {
				const slots = ctx.get("slots");
				if (!slots) return false;
				for (const key of keys) {
					if (typeof key !== "string" || maskedSlots.has(key)) continue;
					maskedSlots.set(key, slots.inject(key, () => {
						syncMasks(key);
						const off = slots.subscribe(key, () => syncMasks(key));
						return () => {
							off();
							for (const [id, record] of masks) {
								if (!id.startsWith(`${key}\u0000`)) continue;
								masks.delete(id);
								try { record.dispose && record.dispose(); } catch {}
							}
						};
					}));
				}
				return true;
			};
			// Fail closed for unsupported/malformed requests; [] deliberately hides every entry.
			const filter = (key, allow) => {
				if (typeof key !== "string" || !Array.isArray(allow) || allow.some((a) => !a || typeof a.package !== "string" || typeof a.cell !== "string")) return false;
				if (!ctx.get("slots")) return false;
				filters.set(key, allow.map((a) => ({ package: a.package, cell: a.cell })));
				try {
					mask([key]);
					syncMasks(key);
					return true;
				} catch { return false; }
			};
			const pending = islandSlots();
			const tryMask = () => pending.length === 0 || mask(pending);
			if (!tryMask()) {
				ctx.on("internal/service", (name) => {
					if (name === "slots") queueMicrotask(tryMask);
				});
			}
			ctx.effect(() => {
				window.__dshGoBridge = {
					version: 1,
					mask: (keys) => mask(Array.isArray(keys) ? keys : [keys]),
					filter,
					/** Original report entries; `masked` is local display state, never sent to occupancy. */
					occupants: (key) => {
						const collected = collect();
						const own = new Set([...masks.keys()].filter((id) => id.startsWith(`${key}\u0000`)).map((id) => id.slice(key.length + 1)));
						return ((collected && collected.slots[key]) || []).map((o) => ({ ...o, masked: own.has(o.cell) && (filters.has(key) || isOfficial(o.package)) }));
					},
					report: () => {
						lastSent = "";
						return report();
					},
					/** Right pane tab types on this page: [{id, kind, title?, guide, multiple?}]. */
					rightPaneTabs: () => rightTabTypes().map(tabTypeInfo),
					openTab,
				};
				return () => {
					delete window.__dshGoBridge;
					for (const dispose of maskedSlots.values()) {
						try { dispose(); } catch {}
					}
					maskedSlots.clear();
					filters.clear();
				};
			}, "dsh-go-bridge: island API");
		}

		module.exports.name = NAME;
		module.exports.apply = apply;
		return module.exports;
	}
});
