import { registerHooks } from "node:module";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { inspect } from "node:util";
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh/profile-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as officeSkills from "@deepseek-ai/dsh-skill-office";
import * as workspaceDependencies from "@deepseek-ai/dsh-tool-workspace-dependencies";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region lib/types/office-engine.js
/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
/**
* Locate the archive containing a packaged runtime.
* @param runtimeDir - Prepared or ASAR-contained runtime directory.
* @returns Parent archive path, or undefined for a prepared directory.
*/
function runtimeArchivePath(runtimeDir) {
	const parent = dirname(runtimeDir);
	return basename(parent) === "app.asar" ? parent : void 0;
}
/**
* Keep engine executable and resource paths usable by native child processes outside Electron.
* Hooks apply only to this thread; worker threads must install their own resolver.
* @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
* @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
*/
function installOfficeEngineResolution(runtimeDir) {
	if (runtimeArchivePath(runtimeDir) === void 0) return void 0;
	const root = realpathSync(runtimeDir);
	const archive = dirname(root);
	const source = pathToFileURL(join(root, "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
	return registerHooks({ resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (!resolved.url.startsWith("file:")) return resolved;
		const engineRequest = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier);
		const engineTarget = /\/node_modules\/@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\//u.test(new URL(resolved.url).pathname);
		if (!engineRequest && !engineTarget) return resolved;
		const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href;
		if (!canonical.startsWith(source)) {
			if (canonical.startsWith(pathToFileURL(archive + "/").href)) throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`);
			return resolved;
		}
		const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)));
		return {
			...resolved,
			url: pathToFileURL(physical).href
		};
	} });
}
//#endregion
//#region lib/types/office.js
/** Desktop Office skills and bundled authoring dependencies. */
var office_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply,
	name: () => name
});
/** Loader identity for the application-owned Office composition. */
const name = "desktop-office";
/**
* Enable offline Office authoring and LibreOffice Kit operations in the Desktop profile.
* @param ctx - Profile scope; child plugins declare their own service requirements.
* @param config - Bundled payload source and Harness-home installation root.
*/
async function apply(ctx, config) {
	await ctx.plugin(workspaceDependencies, config);
	const archive = runtimeArchivePath(config.runtimeDir) === void 0 ? void 0 : dirname(realpathSync(config.runtimeDir));
	const manifest = fileURLToPath(import.meta.resolve("@deepseek-ai/libreoffice-kit/package.json"));
	const packageRoot = dirname(archive === void 0 ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)));
	await ctx.plugin(officeSkills, {
		assetRoot: join(dirname(config.source), "office-skills"),
		node: join(config.source, "dependencies", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
		cli: join(packageRoot, "lib", "cli.js")
	});
}
//#endregion
//#region lib/types/update-tasks.js
/** Desktop installation admission and task inspection for the shared Web Host. */
/**
* Whether stopping the Host now would interrupt work: a generating or tool-running
* agent (including subagents and turns waiting for approval), queued inbox
* messages, or a running or stopping background job.
* @param liveAgents - Current agent roster.
* @param jobs - Job registry queried for the global roster and each agent's own jobs.
* @returns true when any of those conditions holds.
*/
function hasDesktopActiveTasks(liveAgents, jobs) {
	return liveAgents.some((agent) => agent.status === "running" || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || [void 0, ...liveAgents].some((agent) => jobs.list(agent?.id).some((job) => job.status === "running" || job.status === "stopping"));
}
/**
* Register update admission on the owning Host context.
* @param ctx - Booted Desktop profile context; disposal removes the request listener.
* @returns Task inspector whose lock refuses new API requests, drains admitted requests, and rechecks work.
*/
function installDesktopUpdateTaskControl(ctx) {
	let locked = false;
	let lockGeneration = 0;
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	});
	const pendingRequests = /* @__PURE__ */ new Set();
	ctx.on("connection/request", async (_request, response, next) => {
		if (locked) {
			response.writeHead(503);
			response.end();
			return;
		}
		const finished = Promise.withResolvers();
		pendingRequests.add(finished.promise);
		try {
			await next();
		} finally {
			pendingRequests.delete(finished.promise);
			finished.resolve();
		}
	});
	return async (action) => {
		if (stopped) throw new Error("desktop update: Host is stopping");
		if (action === "unlock") {
			locked = false;
			lockGeneration++;
		}
		const agents = ctx.get("agents");
		const jobs = ctx.get("jobs");
		if (agents === void 0 || jobs === void 0) throw new Error("desktop update: task services are unavailable");
		if (action === "lock") {
			locked = true;
			const generation = ++lockGeneration;
			await Promise.all(pendingRequests);
			if (stopped) throw new Error("desktop update: Host is stopping");
			if (generation !== lockGeneration) throw new Error("desktop update: admission lock was superseded");
		}
		return hasDesktopActiveTasks(agents.list(), jobs);
	};
}
//#endregion
//#region lib/types/quit-inspection.js
/** Quit-time inspection of interruptible work and armed scheduled reminders for the Electron shell. */
/**
* Register the quit inspector on the owning Host context.
* @param ctx - Booted Desktop profile context; disposal makes the inspector reject.
* @returns Inspector reporting active tasks together with armed reminders of the loaded sessions
*   (the `schedule` family of `workspace/session-activity`); reminders in sessions that were never
*   loaded during this run cannot fire and are not counted.
*/
function installDesktopQuitInspection(ctx) {
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	});
	return async () => {
		if (stopped) throw new Error("desktop quit: Host is stopping");
		const agents = ctx.get("agents");
		const jobs = ctx.get("jobs");
		if (agents === void 0 || jobs === void 0) throw new Error("desktop quit: task services are unavailable");
		const liveAgents = agents.list();
		const activeTasks = hasDesktopActiveTasks(liveAgents, jobs);
		let scheduledTasks = false;
		for (const agent of liveAgents) if ((await ctx.waterfall("workspace/session-activity", { sessionId: agent.id }, () => Promise.resolve([]))).some((entry) => entry.kind === "schedule")) {
			scheduledTasks = true;
			break;
		}
		return {
			activeTasks,
			scheduledTasks
		};
	};
}
//#endregion
//#region lib/types/platform-session.js
/**
* Publish account sessions for each provider lifetime, clearing them on removal or stream termination.
* @param ctx - Host context owning the account dependency subscription.
* @param publish - Synchronous private IPC delivery; never forwards credentials to the renderer.
*/
function installPlatformSessionPublisher(ctx, publish) {
	ctx.inject(["deepseekAccount"], (accountCtx) => {
		const account = accountCtx.deepseekAccount;
		accountCtx.effect(() => {
			const lifetime = new AbortController();
			const updates = (async () => {
				try {
					for await (const _state of account.watch(lifetime.signal, true)) {
						if (lifetime.signal.aborted) break;
						const session = await account.getPlatformSession();
						if (!lifetime.signal.aborted) publish(session);
					}
				} catch {
					if (!lifetime.signal.aborted) accountCtx.logger("desktop-platform").warn("Account session subscription failed");
				} finally {
					if (!lifetime.signal.aborted) publish(null);
				}
			})();
			return async () => {
				lifetime.abort();
				publish(null);
				await updates;
			};
		});
	});
}
//#endregion
//#region lib/types/index.js
/** Launch the Desktop profile through the Web application and report its URL to Electron. */
const nativeImportContextKeys = [
	"runId",
	"nodeId",
	"attempt",
	"sourceSessionSeq",
	"fileIndex",
	"childSessionId",
	"presentCallId",
	"sourceTurn",
	"parentAgentId",
	"parentSessionId",
	"root",
	"file"
];
const nativeImportUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeNativeImportText = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
function isNativeImportContext(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...nativeImportContextKeys].sort().join(",")) return false;
	const request = value;
	return nativeImportUuid.test(typeof request.runId === "string" ? request.runId : "") && safeNativeImportText(request.nodeId) && safeNativeImportText(request.childSessionId) && safeNativeImportText(request.presentCallId) && safeNativeImportText(request.parentAgentId) && safeNativeImportText(request.parentSessionId) && safeNativeImportText(request.root) && safeNativeImportText(request.file) && Number.isSafeInteger(request.attempt) && request.attempt > 0 && Number.isSafeInteger(request.sourceSessionSeq) && request.sourceSessionSeq >= 0 && Number.isSafeInteger(request.fileIndex) && request.fileIndex >= 0 && Number.isSafeInteger(request.sourceTurn) && request.sourceTurn > 0;
}
async function main() {
	const runtimeDir = process.argv[2];
	const projectDir = process.argv[3];
	installOfficeEngineResolution(runtimeDir);
	const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
	const profile = loadProfileDirectory("dsh", projectDir, installAnchor);
	reportSkippedBundles("dsh", profile);
	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: "desktop",
		resolvedProfile: {
			profile,
			installAnchor
		},
		patchFiles: [],
		args: [
			"--no-open",
			"--host",
			process.env.TRADELOOM_DSH_BIND_HOST ?? "127.0.0.1",
			"--port",
			process.env.TRADELOOM_DSH_BIND_PORT ?? "0"
		],
		...process.argv[5] === void 0 ? {} : { packageManager: {
			command: process.execPath,
			args: ["--expose-internals", process.argv[5]],
			env: {
				ELECTRON_RUN_AS_NODE: "1",
				DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
				PATH: `${process.argv[6] ?? ""}${delimiter}${process.env.PATH ?? ""}`
			}
		} }
	});
	let stopping;
	const control = {};
	let nextNativeImportRequestId = 1;
	const nativeImportRequests = /* @__PURE__ */ new Map();
	const send = (message) => new Promise((resolve, reject) => {
		if (!process.connected || process.send === void 0) {
			resolve();
			return;
		}
		process.send(message, (error) => {
			if (error === null) resolve();
			else reject(error);
		});
	});
	const finishNativeImport = (requestId, allowed) => {
		const pending = nativeImportRequests.get(requestId);
		if (!pending) return;
		nativeImportRequests.delete(requestId);
		pending.signal.removeEventListener("abort", pending.abort);
		pending.resolve(allowed);
	};
	const cancelNativeImports = () => {
		for (const [requestId, pending] of nativeImportRequests) {
			nativeImportRequests.delete(requestId);
			pending.signal.removeEventListener("abort", pending.abort);
			pending.resolve(false);
			if (process.connected) send({
				type: "native-import-confirmation-cancel",
				requestId
			}).catch(() => void 0);
		}
	};
	const authorizeNativeImport = (context, signal) => {
		if (stopping !== void 0 || !process.connected || signal.aborted || !isNativeImportContext(context)) return Promise.resolve(void 0);
		const requestId = nextNativeImportRequestId++;
		if (!Number.isSafeInteger(requestId)) return Promise.resolve(void 0);
		return new Promise((resolve) => {
			const abort = () => {
				if (!nativeImportRequests.get(requestId)) return;
				nativeImportRequests.delete(requestId);
				signal.removeEventListener("abort", abort);
				resolve(void 0);
				if (process.connected) send({
					type: "native-import-confirmation-cancel",
					requestId
				}).catch(() => void 0);
			};
			nativeImportRequests.set(requestId, {
				resolve: (allowed) => resolve(allowed ? "allowed-once" : void 0),
				signal,
				abort
			});
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			send({
				type: "native-import-confirmation",
				requestId,
				context
			}).then(() => {
				if (!process.connected) finishNativeImport(requestId, false);
			}, () => finishNativeImport(requestId, false));
		});
	};
	const stop = () => stopping ??= (async () => {
		cancelNativeImports();
		await (await application.catch(() => void 0))?.shutdown.shutdown(0);
		await send({ type: "shutdown-complete" });
		if (process.connected) process.disconnect();
	})();
	process.on("message", (message) => {
		if (typeof message !== "object" || message === null || !("type" in message)) return;
		if (message.type === "shutdown") {
			stop();
			return;
		}
		if (message.type === "native-import-confirmation-response") {
			if ("requestId" in message && Number.isSafeInteger(message.requestId) && message.requestId > 0 && "allowed" in message && typeof message.allowed === "boolean") finishNativeImport(message.requestId, message.allowed);
			return;
		}
		if (message.type === "quit-inspection") {
			if (!("requestId" in message) || !Number.isSafeInteger(message.requestId)) return;
			const requestId = message.requestId;
			(async () => {
				try {
					if (stopping !== void 0 || control.quitInspection === void 0) throw new Error("desktop quit: Host is unavailable");
					await send({
						type: "quit-inspection",
						requestId,
						...await control.quitInspection()
					});
				} catch (error) {
					await send({
						type: "quit-inspection",
						requestId,
						activeTasks: true,
						scheduledTasks: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			})().catch((error) => {
				console.error(error);
			});
			return;
		}
		if (message.type !== "update-tasks" || !("requestId" in message) || !Number.isSafeInteger(message.requestId) || !("action" in message) || ![
			"inspect",
			"lock",
			"unlock"
		].includes(String(message.action))) return;
		(async () => {
			try {
				if (stopping !== void 0 || control.updateTasks === void 0) throw new Error("desktop update: Host is unavailable");
				const active = await control.updateTasks(message.action);
				await send({
					type: "update-tasks",
					requestId: message.requestId,
					active
				});
			} catch (error) {
				await send({
					type: "update-tasks",
					requestId: message.requestId,
					active: true,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		})().catch((error) => {
			console.error(error);
		});
	});
	process.once("disconnect", () => {
		cancelNativeImports();
		stop();
	});
	const { ctx } = await application;
	ctx.provide("nativeImportAuthorization", Object.freeze({ authorizeImport: authorizeNativeImport }));
	control.updateTasks = installDesktopUpdateTaskControl(ctx);
	control.quitInspection = installDesktopQuitInspection(ctx);
	await ctx.plugin(office_exports, {
		runtimeDir,
		source: process.argv[4] ?? join(runtimeDir, "..", "runtime", "primary-runtime"),
		root: join(resolveDshHome(), "dsh-runtimes", "dsh-primary-runtime")
	});
	installPlatformSessionPublisher(ctx, (session) => {
		if (process.connected) process.send?.({
			type: "platform-session",
			session
		});
	});
// UI18 CLIENT RESOURCE ORIGIN DIAGNOSTIC START (temporary fixed observation only)
async function writeUi18ClientResourceOrigin(ctx) {
	const ids = [
		"@deepseek-ai/dsh-client-ui-settings-general",
		"@deepseek-ai/dsh-client-ui-theme",
		"@deepseek-ai/dsh-client-ui-layout"
	];
	const items = ids.map((id) => ({ id, status: "error", errorCode: "client_modules_unavailable" }));
	try {
		let graph;
		try {
			if (ctx.clientModules && typeof ctx.clientModules.graph === "function") graph = ctx.clientModules.graph();
		} catch {}
		if (!graph || !Array.isArray(graph.entries)) {
			for (const row of items) row.errorCode = "client_modules_unavailable";
		} else {
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i];
				const row = items[i];
				try {
					const matches = graph.entries.filter((entry) => entry && entry.id === id);
					if (matches.length !== 1) {
						row.errorCode = matches.length === 0 ? "entry_missing" : "entry_ambiguous";
						continue;
					}
					const entry = matches[0];
					const clientPath = ctx.clientModules.clientPath(id);
					if (typeof clientPath !== "string" || !/^[A-Za-z]:[\\/](?![\\/])[^<>:"|?*\x00-\x1F]*$/u.test(clientPath)) {
						row.errorCode = "client_path_invalid";
						continue;
					}
					row.clientPath = clientPath;
					if (typeof entry.url !== "string" || !entry.url.startsWith("/")) {
						row.errorCode = "bundle_reference_invalid";
						continue;
					}
					const bundleUrl = new URL(entry.url, origin);
					if (bundleUrl.origin !== origin || !bundleUrl.pathname.startsWith("/plugins/")) {
						row.errorCode = "bundle_reference_invalid";
						continue;
					}
					if (typeof entry.rev === "string" && (/^[A-Fa-f0-9]{32,128}$/u.test(entry.rev) || /^\d{1,16}$/u.test(entry.rev))) row.rev = entry.rev;
					let response;
					try {
						response = await ctx.clientModules.fetchBundle(new Request(bundleUrl));
					} catch {
						row.errorCode = "bundle_fetch_failed";
						continue;
					}
					if (!response || response.status !== 200) {
						row.errorCode = "bundle_http_non_200";
						continue;
					}
					try {
						const bytes = Buffer.from(await response.arrayBuffer());
						row.responseBytes = bytes.length;
						row.responseSha256 = createHash("sha256").update(bytes).digest("hex");
						row.status = "ok";
						delete row.errorCode;
					} catch {
						row.errorCode = "bundle_read_failed";
					}
				} catch {
					row.errorCode = "entry_inspection_failed";
				}
			}
		}
		const receipt = { processId: Number.isInteger(process.pid) ? process.pid : null, observedAt: new Date().toISOString(), items };
		const directory = "C:/Users/23825/AppData/Local/Temp/tradeloom-launch-diag-20261031/ui18-controller-runtime-diagnostic-20261101";
		await writeFile(directory + "/ui18-client-resource-origin.json", JSON.stringify(receipt, null, 2), { encoding: "utf8" });
	} catch {
		// Diagnostics must never affect the Host's normal ready flow.
	}
}
// UI18 CLIENT RESOURCE ORIGIN DIAGNOSTIC END
	const origin = new URL(`${ctx.webServer.protocol}//${ctx.webServer.host}:${String(ctx.webServer.port)}`).origin;
	void Promise.resolve().then(() => writeUi18ClientResourceOrigin(ctx)).catch(() => void 0);
	const url = ctx.connection.authenticatedUrl(origin);
	if (process.connected) process.send?.({
		type: "ready",
		url,
		injections: ctx.webServer.collectIndexInjections()
	}, (error) => {
		if (error !== null) console.error(error);
	});
}
/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024;
if (import.meta.main) main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	const diagnostic = inspect(error, {
		depth: 4,
		maxArrayLength: 50
	}).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS);
	if (process.connected) process.send?.({
		type: "fatal",
		message,
		diagnostic
	}, (error) => {
		if (error !== null) console.error(error);
	});
	console.error(error);
	process.exitCode = 1;
	if (process.connected) process.disconnect();
});
//#endregion
export {};
