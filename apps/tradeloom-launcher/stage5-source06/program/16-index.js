import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { link, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { TextDecoder as TextDecoder$1 } from "node:util";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { isIP } from "node:net";
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/domain/ids.ts
/** Canonical Provider protocol types; provider enums, parsers and discriminants derive from this list. */
const PROVIDER_TYPES = [
	"self-hosted-v1",
	"self-hosted-legacy-v2",
	"official-v4"
];
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFIXED_ID = /^(?:mr|mf|mp|mo)_[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
const CACHE_KEY = /^[a-f0-9]{64}$/;
function assertSafePathSegment(value, label) {
	if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") throw new TypeError(`${label} must be a safe path segment`);
	return value;
}
function assertPrefixedId(value, prefix) {
	if (!value.startsWith(`${prefix}_`) || !PREFIXED_ID.test(value)) throw new TypeError(`invalid ${prefix} identifier`);
	return value;
}
const asResultId = (value) => assertPrefixedId(value, "mr");
const asFileId = (value) => assertPrefixedId(value, "mf");
const asProviderConfigId = (value) => assertPrefixedId(value, "mp");
const asOperationId = (value) => assertPrefixedId(value, "mo");
function asCacheKey(value) {
	if (!CACHE_KEY.test(value)) throw new TypeError("cache key must be a lowercase SHA-256 digest");
	return value;
}
function randomOperationId() {
	return `mo_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
const createOperationId = () => asOperationId(randomOperationId());
function createFileId(sha256, index = 0) {
	if (!CACHE_KEY.test(sha256)) throw new TypeError("source SHA-256 is invalid");
	return asFileId(`mf_${sha256.slice(0, 28)}_${String(index)}`);
}
function resultIdForCacheKey(cacheKey) {
	return asResultId(`mr_${cacheKey.slice(0, 32)}`);
}
//#endregion
//#region src/config/model.ts
/** Parse tiers advertised by the MinerU 4.0+ self-hosted V1 API. */
const SELF_HOSTED_TIERS = [
	"flash",
	"basic",
	"standard",
	"advanced"
];
const PROVIDER_TRAITS = {
	"self-hosted-v1": {
		requiresCredential: false,
		selectsModel: false
	},
	"self-hosted-legacy-v2": {
		requiresCredential: false,
		selectsModel: true
	},
	"official-v4": {
		requiresCredential: true,
		selectsModel: true
	}
};
const PROVIDER_DEFAULTS = {
	"self-hosted-v1": () => ({
		id: asProviderConfigId("mp_self_hosted_v1"),
		type: "self-hosted-v1",
		baseURL: "http://localhost:8000",
		apiKeyEnv: "MINERU_API_KEY",
		ocrMode: "auto",
		allowInsecureHttp: true
	}),
	"self-hosted-legacy-v2": () => ({
		id: asProviderConfigId("mp_self_hosted"),
		type: "self-hosted-legacy-v2",
		baseURL: "http://localhost:18000",
		apiKeyEnv: "MINERU_API_KEY",
		modelMap: {
			pipeline: "pipeline",
			vlm: "vlm-engine"
		},
		allowInsecureHttp: true
	}),
	"official-v4": () => ({
		id: asProviderConfigId("mp_official"),
		type: "official-v4",
		baseURL: "https://mineru.net/api/v4",
		apiKeyEnv: "MINERU_API_KEY",
		models: ["pipeline", "vlm"],
		configuredVersion: "v4"
	})
};
function defaultProviderConfig(type) {
	return PROVIDER_DEFAULTS[type]();
}
function providerById(config, id) {
	return config.providers.find((provider) => provider.id === id);
}
const DEFAULT_PARSE_DEFAULTS = {
	model: "pipeline",
	ocr: false,
	parseMethod: "auto",
	language: "ch",
	formula: true,
	table: true
};
/** V1 has no model/language/formula/table selectors; use stable internal sentinels for cache identity. */
function effectiveParseDefaults(defaults, provider) {
	if (provider.type !== "self-hosted-v1") return defaults;
	return {
		model: "pipeline",
		parseMethod: provider.ocrMode,
		ocr: provider.ocrMode === "ocr",
		language: "auto",
		formula: false,
		table: false
	};
}
const DEFAULT_POLLING_CONFIG = {
	pollIntervalMs: 2e3,
	pollTimeoutMs: 6e5,
	requestTimeoutMs: 6e4,
	operationTimeoutMs: 36e5
};
const DEFAULT_RETRY_CONFIG = {
	maxAttempts: 3,
	baseDelayMs: 500,
	maxDelayMs: 1e4
};
const DEFAULT_OUTPUT_CONFIG = {
	maxInlineChars: 12e3,
	maxInlineImages: 6
};
const DEFAULT_SECURITY_LIMITS = {
	maxFileBytes: 209715200,
	maxApiResponseBytes: 8388608,
	maxZipDownloadBytes: 536870912,
	maxZipEntries: 1e4,
	maxZipEntryBytes: 268435456,
	maxZipTotalBytes: 2147483648,
	maxZipCompressionRatio: 200
};
const DEFAULT_STORAGE_OPTIONS = {
	cacheEnabled: true,
	retainSources: false,
	stagingTtlMs: 864e5
};
//#endregion
//#region src/config/parse.ts
function dshHome() {
	const env = process.env.DSH_HOME?.trim();
	if (!env) return join(homedir(), ".dsh");
	if (env === "~") return homedir();
	if (env.startsWith("~/") || env.startsWith("~\\")) return resolve(join(homedir(), env.slice(2)));
	return resolve(env);
}
function defaultMinerUConfig() {
	const selfHosted = defaultProviderConfig("self-hosted-legacy-v2");
	const official = defaultProviderConfig("official-v4");
	return {
		schemaVersion: 3,
		activeProvider: selfHosted.id,
		providers: [
			selfHosted,
			official,
			defaultProviderConfig("self-hosted-v1")
		],
		defaults: { ...DEFAULT_PARSE_DEFAULTS },
		storage: {
			storageRoot: join(dshHome(), "cache", "pdf-mineru"),
			...DEFAULT_STORAGE_OPTIONS
		},
		polling: { ...DEFAULT_POLLING_CONFIG },
		retry: { ...DEFAULT_RETRY_CONFIG },
		output: { ...DEFAULT_OUTPUT_CONFIG },
		limits: { ...DEFAULT_SECURITY_LIMITS }
	};
}
const ALLOWED_TOP_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"activeProvider",
	"providers",
	"defaults",
	"storage",
	"polling",
	"retry",
	"output",
	"limits"
]);
/** Closed field set of each canonical provider profile. */
const PROVIDER_FIELDS = {
	"self-hosted-v1": /* @__PURE__ */ new Set([
		"id",
		"type",
		"baseURL",
		"apiKeyEnv",
		"tier",
		"ocrMode",
		"configuredVersion",
		"allowInsecureHttp"
	]),
	"self-hosted-legacy-v2": /* @__PURE__ */ new Set([
		"id",
		"type",
		"baseURL",
		"apiKeyEnv",
		"modelMap",
		"configuredVersion",
		"allowInsecureHttp"
	]),
	"official-v4": /* @__PURE__ */ new Set([
		"id",
		"type",
		"baseURL",
		"apiKeyEnv",
		"models",
		"configuredVersion"
	])
};
const ALLOWED_MODEL_MAP_KEYS = /* @__PURE__ */ new Set(["pipeline", "vlm"]);
const ALLOWED_DEFAULTS_KEYS = /* @__PURE__ */ new Set([
	"model",
	"ocr",
	"parseMethod",
	"language",
	"formula",
	"table"
]);
const ALLOWED_STORAGE_KEYS = /* @__PURE__ */ new Set([
	"storageRoot",
	"cacheEnabled",
	"retainSources",
	"stagingTtlMs"
]);
const ALLOWED_POLLING_KEYS = /* @__PURE__ */ new Set([
	"pollIntervalMs",
	"pollTimeoutMs",
	"requestTimeoutMs",
	"operationTimeoutMs"
]);
const ALLOWED_RETRY_KEYS = /* @__PURE__ */ new Set([
	"maxAttempts",
	"baseDelayMs",
	"maxDelayMs"
]);
const ALLOWED_OUTPUT_KEYS = /* @__PURE__ */ new Set(["maxInlineChars", "maxInlineImages"]);
const ALLOWED_LIMITS_KEYS = /* @__PURE__ */ new Set([
	"maxFileBytes",
	"maxApiResponseBytes",
	"maxZipDownloadBytes",
	"maxZipEntries",
	"maxZipEntryBytes",
	"maxZipTotalBytes",
	"maxZipCompressionRatio"
]);
function assertAllowedKeys(record, allowed, path) {
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${path} contains unsupported property ${key}`);
}
function record(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	return value;
}
function text(value, fallback, label) {
	const result = value === void 0 ? fallback : value;
	if (typeof result !== "string" || result.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
	return result;
}
function positive(value, fallback, label) {
	const result = value === void 0 ? fallback : value;
	if (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive safe integer`);
	return result;
}
function boundedPositive(value, fallback, label, min, max) {
	const result = positive(value, fallback, label);
	if (result < min || result > max) throw new TypeError(`${label} must be between ${String(min)} and ${String(max)}`);
	return result;
}
function boundedInteger$1(value, fallback, label, min, max) {
	const result = value === void 0 ? fallback : value;
	if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) throw new TypeError(`${label} must be an integer between ${String(min)} and ${String(max)}`);
	return result;
}
function booleanValue(value, fallback, label) {
	const result = value === void 0 ? fallback : value;
	if (typeof result !== "boolean") throw new TypeError(`${label} must be a boolean`);
	return result;
}
function credentialRef(value, fallback, required) {
	const result = value === void 0 ? fallback : value;
	if (result === void 0 && !required) return void 0;
	if (typeof result !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new TypeError("apiKeyEnv must be a valid credential reference");
	return result;
}
function baseUrl(value, fallback, allowHttp, label) {
	const parsed = new URL(text(value, fallback, label));
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError(`${label} must not contain credentials, query, or fragment`);
	if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) throw new TypeError(`${label} must use HTTPS`);
	return parsed.toString().replace(/\/$/, "");
}
function models(value, fallback) {
	const input = value === void 0 ? fallback : value;
	if (!Array.isArray(input) || input.length === 0 || input.some((item) => item !== "pipeline" && item !== "vlm")) throw new TypeError("provider models must contain pipeline and/or vlm");
	return [...new Set(input)];
}
const PROVIDER_PARSERS = {
	"official-v4": (input, id) => ({
		id,
		type: "official-v4",
		baseURL: baseUrl(input.baseURL, "https://mineru.net/api/v4", false, "provider.baseURL"),
		apiKeyEnv: credentialRef(input.apiKeyEnv, "MINERU_API_KEY", true),
		models: models(input.models, ["pipeline", "vlm"]),
		configuredVersion: "v4"
	}),
	"self-hosted-v1": (input, id) => {
		const allowInsecureHttp = booleanValue(input.allowInsecureHttp, false, "provider.allowInsecureHttp");
		let tier;
		if (input.tier !== void 0) {
			if (typeof input.tier !== "string" || !SELF_HOSTED_TIERS.includes(input.tier)) throw new TypeError("provider.tier must be flash, basic, standard or advanced");
			tier = input.tier;
		}
		const ocrMode = input.ocrMode === void 0 ? "auto" : input.ocrMode;
		if (ocrMode !== "auto" && ocrMode !== "txt" && ocrMode !== "ocr") throw new TypeError("provider.ocrMode must be auto, txt or ocr");
		return {
			id,
			type: "self-hosted-v1",
			baseURL: baseUrl(input.baseURL, "http://localhost:8000", allowInsecureHttp, "provider.baseURL"),
			apiKeyEnv: credentialRef(input.apiKeyEnv, void 0, false),
			...tier === void 0 ? {} : { tier },
			ocrMode,
			...input.configuredVersion === void 0 ? {} : { configuredVersion: text(input.configuredVersion, "", "configuredVersion") },
			allowInsecureHttp
		};
	},
	"self-hosted-legacy-v2": (input, id) => {
		const allowInsecureHttp = booleanValue(input.allowInsecureHttp, false, "provider.allowInsecureHttp");
		const map = record(input.modelMap, "provider.modelMap");
		assertAllowedKeys(map, ALLOWED_MODEL_MAP_KEYS, "modelMap");
		const pipeline = text(map.pipeline, "", "modelMap.pipeline");
		const vlm = text(map.vlm, "", "modelMap.vlm");
		if (pipeline === vlm) throw new TypeError("provider modelMap backends must be distinct");
		return {
			id,
			type: "self-hosted-legacy-v2",
			baseURL: baseUrl(input.baseURL, "http://localhost:18000", allowInsecureHttp, "provider.baseURL"),
			apiKeyEnv: credentialRef(input.apiKeyEnv, void 0, false),
			modelMap: {
				pipeline,
				vlm
			},
			...input.configuredVersion === void 0 ? {} : { configuredVersion: text(input.configuredVersion, "", "configuredVersion") },
			allowInsecureHttp
		};
	}
};
function isProviderType(value) {
	return PROVIDER_TYPES.includes(value);
}
function parseProvider(value) {
	const input = record(value, "provider");
	const id = asProviderConfigId(text(input.id, "", "provider.id"));
	if (!isProviderType(input.type)) throw new TypeError("provider.type is unsupported; choose " + PROVIDER_TYPES.slice(0, -1).join(", ") + " or " + PROVIDER_TYPES.at(-1));
	assertAllowedKeys(input, PROVIDER_FIELDS[input.type], "provider");
	return PROVIDER_PARSERS[input.type](input, id);
}
function parseCanonical(input, fallback) {
	if (input.schemaVersion !== void 0) {
		if (input.schemaVersion !== 3) throw new TypeError(`unsupported schemaVersion: ${String(input.schemaVersion)}`);
	}
	if (!Array.isArray(input.providers) || input.providers.length === 0) throw new TypeError("providers must be a non-empty array");
	const providers = input.providers.map(parseProvider);
	if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new TypeError("provider ids must be unique");
	const activeProvider = asProviderConfigId(text(input.activeProvider, "", "activeProvider"));
	if (!providers.some((provider) => provider.id === activeProvider)) throw new TypeError("activeProvider does not identify a configured provider");
	const defaults = record(input.defaults ?? {}, "defaults");
	assertAllowedKeys(defaults, ALLOWED_DEFAULTS_KEYS, "defaults");
	const storage = record(input.storage ?? {}, "storage");
	assertAllowedKeys(storage, ALLOWED_STORAGE_KEYS, "storage");
	const polling = record(input.polling ?? {}, "polling");
	assertAllowedKeys(polling, ALLOWED_POLLING_KEYS, "polling");
	const retry = record(input.retry ?? {}, "retry");
	assertAllowedKeys(retry, ALLOWED_RETRY_KEYS, "retry");
	const output = record(input.output ?? {}, "output");
	assertAllowedKeys(output, ALLOWED_OUTPUT_KEYS, "output");
	const limits = record(input.limits ?? {}, "limits");
	assertAllowedKeys(limits, ALLOWED_LIMITS_KEYS, "limits");
	const model = defaults.model === void 0 ? fallback.defaults.model : defaults.model;
	if (model !== "pipeline" && model !== "vlm") throw new TypeError("defaults.model is invalid");
	let parseMethod;
	if (defaults.parseMethod !== void 0) {
		if (defaults.parseMethod !== "auto" && defaults.parseMethod !== "txt" && defaults.parseMethod !== "ocr") throw new TypeError("defaults.parseMethod is invalid");
		parseMethod = defaults.parseMethod;
	} else if (defaults.ocr === true) parseMethod = "ocr";
	else parseMethod = fallback.defaults.parseMethod;
	const expectedOcr = parseMethod === "ocr";
	if (defaults.ocr !== void 0) {
		if (booleanValue(defaults.ocr, expectedOcr, "defaults.ocr") !== expectedOcr) throw new TypeError("defaults.ocr conflicts with defaults.parseMethod");
	}
	const ocr = expectedOcr;
	const storageRoot = text(storage.storageRoot, fallback.storage.storageRoot, "storage.storageRoot");
	if (storage.retainSources !== void 0 && storage.retainSources !== false) throw new TypeError("storage.retainSources must be false");
	const result = {
		schemaVersion: 3,
		activeProvider,
		providers,
		defaults: {
			model,
			ocr,
			parseMethod,
			language: text(defaults.language, fallback.defaults.language, "defaults.language"),
			formula: booleanValue(defaults.formula, fallback.defaults.formula, "defaults.formula"),
			table: booleanValue(defaults.table, fallback.defaults.table, "defaults.table")
		},
		storage: {
			storageRoot: resolve(storageRoot),
			cacheEnabled: booleanValue(storage.cacheEnabled, fallback.storage.cacheEnabled, "storage.cacheEnabled"),
			retainSources: false,
			stagingTtlMs: positive(storage.stagingTtlMs, fallback.storage.stagingTtlMs, "storage.stagingTtlMs")
		},
		polling: {
			pollIntervalMs: positive(polling.pollIntervalMs, fallback.polling.pollIntervalMs, "polling.pollIntervalMs"),
			pollTimeoutMs: positive(polling.pollTimeoutMs, fallback.polling.pollTimeoutMs, "polling.pollTimeoutMs"),
			requestTimeoutMs: positive(polling.requestTimeoutMs, fallback.polling.requestTimeoutMs, "polling.requestTimeoutMs"),
			operationTimeoutMs: positive(polling.operationTimeoutMs, fallback.polling.operationTimeoutMs, "polling.operationTimeoutMs")
		},
		retry: {
			maxAttempts: boundedPositive(retry.maxAttempts, fallback.retry.maxAttempts, "retry.maxAttempts", 1, 10),
			baseDelayMs: boundedPositive(retry.baseDelayMs, fallback.retry.baseDelayMs, "retry.baseDelayMs", 1, 6e4),
			maxDelayMs: boundedPositive(retry.maxDelayMs, fallback.retry.maxDelayMs, "retry.maxDelayMs", 1, 3e5)
		},
		output: {
			maxInlineChars: boundedPositive(output.maxInlineChars, fallback.output.maxInlineChars, "output.maxInlineChars", 1024, 1e6),
			maxInlineImages: boundedInteger$1(output.maxInlineImages, fallback.output.maxInlineImages, "output.maxInlineImages", 0, 100)
		},
		limits: {
			maxFileBytes: positive(limits.maxFileBytes, fallback.limits.maxFileBytes, "limits.maxFileBytes"),
			maxApiResponseBytes: positive(limits.maxApiResponseBytes, fallback.limits.maxApiResponseBytes, "limits.maxApiResponseBytes"),
			maxZipDownloadBytes: positive(limits.maxZipDownloadBytes, fallback.limits.maxZipDownloadBytes, "limits.maxZipDownloadBytes"),
			maxZipEntries: positive(limits.maxZipEntries, fallback.limits.maxZipEntries, "limits.maxZipEntries"),
			maxZipEntryBytes: positive(limits.maxZipEntryBytes, fallback.limits.maxZipEntryBytes, "limits.maxZipEntryBytes"),
			maxZipTotalBytes: positive(limits.maxZipTotalBytes, fallback.limits.maxZipTotalBytes, "limits.maxZipTotalBytes"),
			maxZipCompressionRatio: positive(limits.maxZipCompressionRatio, fallback.limits.maxZipCompressionRatio, "limits.maxZipCompressionRatio")
		}
	};
	const active = providers.find((provider) => provider.id === activeProvider);
	if (active.type === "official-v4") {
		if (!active.models.includes(result.defaults.model)) throw new TypeError("active official provider does not support defaults.model");
		if (result.defaults.parseMethod === "txt") throw new TypeError("official-v4 cannot use txt as defaults.parseMethod");
	}
	if (result.retry.baseDelayMs > result.retry.maxDelayMs) throw new TypeError("retry.baseDelayMs cannot exceed retry.maxDelayMs");
	if (result.limits.maxZipEntryBytes > result.limits.maxZipTotalBytes) throw new TypeError("maxZipEntryBytes cannot exceed maxZipTotalBytes");
	return result;
}
/** Strict canonical parser for current-version edits; historical documents load through parseConfigWithMigration. */
function parseConfig(value) {
	const fallback = defaultMinerUConfig();
	if (value === void 0 || value === null) return fallback;
	const input = record(value, "config");
	assertAllowedKeys(input, ALLOWED_TOP_KEYS, "config");
	if (input.schemaVersion !== void 0 && input.schemaVersion !== 3) throw new TypeError("unsupported schemaVersion: " + String(input.schemaVersion) + "; load through migration to schemaVersion " + String(3));
	return parseCanonical(input, fallback);
}
/** Validate one unsaved provider profile in the context of the current configuration. */
function parseProviderDraft(value, current) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("provider draft must be an object");
	const id = value.id;
	if (typeof id !== "string") throw new TypeError("provider draft id is required");
	return parseConfig({
		...current,
		activeProvider: id,
		providers: [value]
	}).providers[0];
}
//#endregion
//#region src/config/migration-values.ts
/** Repairs values only while loading known historical versions. It never persists or resolves credentials. */
function repairLegacyConfigValues(input, fallback) {
	const repaired = /* @__PURE__ */ new Set();
	const object = (value, path) => {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
		repaired.add(path);
		return {};
	};
	const validId = (value) => {
		try {
			return typeof value === "string" ? asProviderConfigId(value) : void 0;
		} catch {
			return;
		}
	};
	const rawProviders = Array.isArray(input.providers) && input.providers.length > 0 ? input.providers : fallback.providers;
	if (rawProviders !== input.providers) repaired.add("providers");
	const reserved = new Set(rawProviders.map((value) => validId(value?.id)).filter((value) => value !== void 0));
	const used = /* @__PURE__ */ new Set();
	const providers = rawProviders.map((value, index) => {
		const path = "providers[" + index + "]";
		const raw = object(value, path);
		const oldType = raw.type === "self-hosted-v2";
		const type = oldType ? "self-hosted-legacy-v2" : typeof raw.type === "string" && PROVIDER_TYPES.includes(raw.type) ? raw.type : "self-hosted-legacy-v2";
		if (type !== raw.type && !oldType) repaired.add(path + ".type");
		const defaults = defaultProviderConfig(type);
		let id = validId(raw.id);
		if (id === void 0 || used.has(id)) {
			id = defaults.id;
			for (let suffix = 2; reserved.has(id) || used.has(id); suffix++) id = defaults.id + "_" + suffix;
			repaired.add(path + ".id");
		}
		used.add(id);
		let provider = {
			...defaults,
			id: asProviderConfigId(id)
		};
		if (provider.type !== "official-v4") {
			const allowInsecureHttp = typeof raw.allowInsecureHttp === "boolean" ? raw.allowInsecureHttp : false;
			if (typeof raw.allowInsecureHttp !== "boolean") repaired.add(path + ".allowInsecureHttp");
			provider = {
				...provider,
				allowInsecureHttp,
				baseURL: allowInsecureHttp ? provider.baseURL : provider.baseURL.replace(/^http:/u, "https:"),
				apiKeyEnv: void 0
			};
		}
		const allowed = oldType ? /* @__PURE__ */ new Set([...PROVIDER_FIELDS[type], "tier"]) : PROVIDER_FIELDS[type];
		for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(path + " contains unsupported property " + key);
		for (const key of [
			"baseURL",
			"apiKeyEnv",
			"configuredVersion",
			"models",
			"modelMap",
			"tier",
			"ocrMode"
		]) {
			if (!allowed.has(key) || oldType && key === "tier") continue;
			if (raw[key] === void 0) {
				if (provider[key] !== void 0) repaired.add(path + "." + key);
				continue;
			}
			let next = raw[key];
			if (key === "modelMap" && provider.type === "self-hosted-legacy-v2") {
				const map = object(next, path + ".modelMap");
				for (const name of Object.keys(map)) if (name !== "pipeline" && name !== "vlm") throw new TypeError("modelMap contains unsupported property " + name);
				next = { ...provider.modelMap };
				for (const name of ["pipeline", "vlm"]) if (typeof map[name] === "string" && map[name].trim() !== "") next[name] = map[name];
				else repaired.add(path + ".modelMap." + name);
			}
			try {
				provider = parseProvider({
					...provider,
					[key]: next
				});
			} catch {
				repaired.add(path + "." + key);
			}
		}
		if (!oldType) return provider;
		const tier = raw.tier;
		const validTier = tier === void 0 || tier === null || typeof tier === "string" && [
			"flash",
			"basic",
			"standard",
			"advanced"
		].includes(tier);
		if (!validTier) repaired.add(path + ".tier");
		return {
			...provider,
			type: "self-hosted-v2",
			...Object.hasOwn(raw, "tier") ? { tier: validTier ? tier : void 0 } : {}
		};
	});
	const canonicalProviders = providers.map((provider) => {
		if (provider.type !== "self-hosted-v2") return parseProvider(provider);
		const { tier: _tier, ...legacy } = provider;
		return parseProvider({
			...legacy,
			type: "self-hosted-legacy-v2"
		});
	});
	let active = typeof input.activeProvider === "string" && used.has(input.activeProvider) ? input.activeProvider : void 0;
	if (active === void 0) {
		active = used.has(fallback.activeProvider) ? fallback.activeProvider : canonicalProviders[0].id;
		repaired.add("activeProvider");
	}
	const selected = canonicalProviders.find((provider) => provider.id === active);
	let canonical = {
		...fallback,
		providers: canonicalProviders,
		activeProvider: asProviderConfigId(active)
	};
	if (selected.type === "official-v4" && !selected.models.includes(canonical.defaults.model)) canonical = {
		...canonical,
		defaults: {
			...canonical.defaults,
			model: selected.models[0]
		}
	};
	const output = {
		...input,
		providers,
		activeProvider: active
	};
	for (const section of [
		"defaults",
		"storage",
		"polling",
		"retry",
		"output",
		"limits"
	]) {
		const raw = object(input[section], section);
		const sectionDefaults = canonical[section];
		const allowed = new Set(Object.keys(sectionDefaults));
		for (const key of Object.keys(raw)) {
			if (section === "defaults" && key === "artifacts" || section === "limits" && key === "maxFilesPerRequest") continue;
			if (!allowed.has(key)) throw new TypeError(section + " contains unsupported property " + key);
		}
		const values = { ...raw };
		if (section === "defaults") {
			let method = raw.parseMethod === void 0 && raw.ocr === true ? "ocr" : raw.parseMethod === void 0 ? canonical.defaults.parseMethod : raw.parseMethod;
			if (typeof method !== "string" || ![
				"auto",
				"txt",
				"ocr"
			].includes(method) || selected.type === "official-v4" && method === "txt") {
				method = "auto";
				repaired.add("defaults.parseMethod");
			}
			if (raw.ocr !== void 0 && raw.ocr !== (method === "ocr")) repaired.add("defaults.ocr");
			canonical = {
				...canonical,
				defaults: {
					...canonical.defaults,
					parseMethod: method,
					ocr: method === "ocr"
				}
			};
		}
		const proposed = {
			...canonical[section],
			...Object.fromEntries(Object.entries(raw).filter(([key, value]) => allowed.has(key) && value !== void 0))
		};
		if (section === "defaults") Object.assign(proposed, {
			parseMethod: canonical.defaults.parseMethod,
			ocr: canonical.defaults.ocr
		});
		let validSection = false;
		try {
			canonical = parseCanonical({
				...canonical,
				[section]: proposed
			}, fallback);
			validSection = true;
		} catch {}
		const accepted = { ...canonical[section] };
		for (const key of allowed) {
			if (section === "defaults" && (key === "parseMethod" || key === "ocr")) continue;
			if (raw[key] === void 0) {
				repaired.add(section + "." + key);
				continue;
			}
			if (validSection) continue;
			const candidate = {
				...canonical[section],
				[key]: raw[key]
			};
			if (typeof raw[key] === "number") {
				if (section === "retry" && key === "baseDelayMs") candidate.maxDelayMs = Math.max(canonical.retry.maxDelayMs, raw[key]);
				if (section === "retry" && key === "maxDelayMs") candidate.baseDelayMs = Math.min(canonical.retry.baseDelayMs, raw[key]);
				if (section === "limits" && key === "maxZipEntryBytes") candidate.maxZipTotalBytes = Math.max(canonical.limits.maxZipTotalBytes, raw[key]);
				if (section === "limits" && key === "maxZipTotalBytes") candidate.maxZipEntryBytes = Math.min(canonical.limits.maxZipEntryBytes, raw[key]);
			}
			try {
				accepted[key] = parseCanonical({
					...canonical,
					[section]: candidate
				}, fallback)[section][key];
			} catch {
				repaired.add(section + "." + key);
			}
		}
		if (!validSection) {
			const pair = section === "retry" ? ["baseDelayMs", "maxDelayMs"] : section === "limits" ? ["maxZipEntryBytes", "maxZipTotalBytes"] : void 0;
			if (pair && accepted[pair[0]] > accepted[pair[1]]) for (const key of pair) {
				accepted[key] = fallback[section][key];
				repaired.add(section + "." + key);
			}
			canonical = parseCanonical({
				...canonical,
				[section]: accepted
			}, fallback);
		}
		Object.assign(values, canonical[section]);
		if (section === "defaults" && Object.hasOwn(raw, "artifacts")) {
			values.artifacts = [];
			repaired.add("defaults.artifacts");
		}
		if (section === "limits" && Object.hasOwn(raw, "maxFilesPerRequest")) {
			values.maxFilesPerRequest = 1;
			repaired.add("limits.maxFilesPerRequest");
		}
		output[section] = values;
	}
	return {
		input: output,
		defaultedFields: [...repaired]
	};
}
//#endregion
//#region src/config/migrate.ts
const LEGACY_ARTIFACT_KINDS = /* @__PURE__ */ new Set([
	"markdown",
	"layout",
	"model-output",
	"content-list",
	"images"
]);
function hasLegacySchemaV1Fields(input) {
	const defaults = record(input.defaults ?? {}, "defaults");
	const limits = record(input.limits ?? {}, "limits");
	return Object.hasOwn(defaults, "artifacts") || Object.hasOwn(limits, "maxFilesPerRequest");
}
function migrateSchemaV1ToV2(input) {
	const defaults = record(input.defaults ?? {}, "defaults");
	const legacyArtifacts = defaults.artifacts;
	if (legacyArtifacts !== void 0 && (!Array.isArray(legacyArtifacts) || legacyArtifacts.some((item) => typeof item !== "string" || !LEGACY_ARTIFACT_KINDS.has(item)))) throw new TypeError("defaults.artifacts contains an unsupported artifact");
	const migratedDefaults = { ...defaults };
	delete migratedDefaults.artifacts;
	const limits = record(input.limits ?? {}, "limits");
	if (limits.maxFilesPerRequest !== void 0) positive(limits.maxFilesPerRequest, 1, "limits.maxFilesPerRequest");
	const migratedLimits = { ...limits };
	delete migratedLimits.maxFilesPerRequest;
	return {
		...input,
		schemaVersion: 2,
		defaults: migratedDefaults,
		limits: migratedLimits
	};
}
/** Narrow input migration only: never teach runtime providers or canonical schemas an old alias. */
function migrateSelfHostedProviders(input) {
	if (!Array.isArray(input.providers)) return {
		input,
		migrations: []
	};
	const migrations = [];
	const providers = input.providers.map((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
		const provider = value;
		if (provider.type !== "self-hosted-v2") return value;
		assertAllowedKeys(provider, /* @__PURE__ */ new Set([...PROVIDER_FIELDS["self-hosted-legacy-v2"], "tier"]), "provider");
		if (provider.tier !== void 0 && provider.tier !== null && (typeof provider.tier !== "string" || !SELF_HOSTED_TIERS.includes(provider.tier))) throw new TypeError("legacy provider.tier must be flash, basic, standard or advanced");
		const { tier: _tier, ...legacy } = provider;
		migrations.push({
			providerId: asProviderConfigId(text(provider.id, "", "provider.id")),
			from: "self-hosted-v2",
			to: "self-hosted-legacy-v2",
			removedFields: Object.hasOwn(provider, "tier") ? ["tier"] : []
		});
		return {
			...legacy,
			type: "self-hosted-legacy-v2"
		};
	});
	return {
		input: migrations.length === 0 ? input : {
			...input,
			providers
		},
		migrations
	};
}
/** Each entry advances exactly one version; never infer a protocol from an endpoint or tier. */
const CONFIG_MIGRATIONS = /* @__PURE__ */ new Map([[1, {
	to: 2,
	migrate: (input) => ({ input: migrateSchemaV1ToV2(input) })
}], [2, {
	to: 3,
	migrate: (input) => {
		const converted = migrateSelfHostedProviders(input);
		return {
			input: {
				...converted.input,
				schemaVersion: 3
			},
			providers: converted.migrations
		};
	}
}]]);
/** Parse startup/settings input, including known field and self-hosted profile migrations. Never persists. */
function parseConfigWithMigration(value) {
	const fallback = defaultMinerUConfig();
	if (value === void 0 || value === null) return {
		config: fallback,
		migrated: false
	};
	const input = record(value, "config");
	assertAllowedKeys(input, ALLOWED_TOP_KEYS, "config");
	const sourceVersion = input.schemaVersion === void 0 ? 2 : input.schemaVersion;
	if (typeof sourceVersion !== "number" || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 3) throw new TypeError("unsupported schemaVersion: " + String(sourceVersion));
	const repaired = sourceVersion < 3 ? repairLegacyConfigValues(input, fallback) : {
		input,
		defaultedFields: []
	};
	let current = repaired.input;
	const cleanComposedFields = sourceVersion !== 1 && hasLegacySchemaV1Fields(current);
	if (cleanComposedFields) current = {
		...migrateSchemaV1ToV2({
			...current,
			defaults: {
				...record(current.defaults ?? {}, "defaults"),
				artifacts: void 0
			},
			limits: {
				...record(current.limits ?? {}, "limits"),
				maxFilesPerRequest: void 0
			}
		}),
		schemaVersion: sourceVersion
	};
	const steps = [];
	const providers = [];
	let version = sourceVersion;
	while (version < 3) {
		const step = CONFIG_MIGRATIONS.get(version);
		if (!step || step.to !== version + 1 || step.to > 3) throw new TypeError("Missing configuration migration from schemaVersion " + String(version));
		const migrated = step.migrate(current);
		current = migrated.input;
		if (current.schemaVersion !== step.to) throw new TypeError("Configuration migration produced an invalid schemaVersion");
		steps.push({
			from: version,
			to: step.to
		});
		providers.push(...migrated.providers ?? []);
		version = step.to;
	}
	return {
		config: parseCanonical(current, fallback),
		migrated: cleanComposedFields || steps.length > 0,
		...sourceVersion < 3 ? { migratedFrom: sourceVersion } : {},
		...input.schemaVersion === void 0 ? { assumedVersion: 2 } : {},
		...steps.length === 0 ? {} : { migrationSteps: steps },
		...repaired.defaultedFields.length === 0 ? {} : { defaultedFields: repaired.defaultedFields },
		...providers.length === 0 ? {} : { providerMigrations: providers }
	};
}
//#endregion
//#region src/config/schema.ts
/** Native form projection of each canonical provider profile; the domain parser stays the validator. */
const PROVIDER_SCHEMAS = {
	"self-hosted-v1": z.object({
		id: z.string(),
		type: z.const("self-hosted-v1"),
		baseURL: z.string(),
		apiKeyEnv: z.string().role("credential-ref"),
		tier: z.union([
			"flash",
			"basic",
			"standard",
			"advanced"
		]),
		ocrMode: z.union([
			"auto",
			"txt",
			"ocr"
		]),
		configuredVersion: z.string(),
		allowInsecureHttp: z.boolean()
	}),
	"self-hosted-legacy-v2": z.object({
		id: z.string(),
		type: z.const("self-hosted-legacy-v2"),
		baseURL: z.string(),
		apiKeyEnv: z.string().role("credential-ref"),
		modelMap: z.object({
			pipeline: z.string(),
			vlm: z.string()
		}),
		configuredVersion: z.string(),
		allowInsecureHttp: z.boolean()
	}),
	"official-v4": z.object({
		id: z.string(),
		type: z.const("official-v4"),
		baseURL: z.string(),
		apiKeyEnv: z.string().role("credential-ref"),
		models: z.array(z.union(["pipeline", "vlm"])),
		configuredVersion: z.string()
	})
};
const Config = z.object({
	schemaVersion: z.union([
		z.const(1),
		z.const(2),
		z.const(3)
	]).volatile(),
	activeProvider: z.string().volatile(),
	providers: z.array(z.union(PROVIDER_TYPES.map((type) => PROVIDER_SCHEMAS[type]))).volatile(),
	defaults: z.object({
		model: z.union(["pipeline", "vlm"]),
		ocr: z.boolean(),
		parseMethod: z.union([
			"auto",
			"txt",
			"ocr"
		]),
		language: z.string(),
		formula: z.boolean(),
		table: z.boolean()
	}).volatile(),
	storage: z.object({
		storageRoot: z.string(),
		cacheEnabled: z.boolean().volatile(),
		retainSources: z.const(false),
		stagingTtlMs: z.number().volatile()
	}).default({}),
	polling: z.object({
		pollIntervalMs: z.number(),
		pollTimeoutMs: z.number(),
		requestTimeoutMs: z.number(),
		operationTimeoutMs: z.number()
	}).volatile(),
	retry: z.object({
		maxAttempts: z.number(),
		baseDelayMs: z.number(),
		maxDelayMs: z.number()
	}).volatile(),
	output: z.object({
		maxInlineChars: z.number(),
		maxInlineImages: z.number()
	}).volatile(),
	limits: z.object({
		maxFileBytes: z.number(),
		maxApiResponseBytes: z.number(),
		maxZipDownloadBytes: z.number(),
		maxZipEntries: z.number(),
		maxZipEntryBytes: z.number(),
		maxZipTotalBytes: z.number(),
		maxZipCompressionRatio: z.number()
	})
});
Object.defineProperty(Config, "~standard", { value: {
	...Config["~standard"],
	validate(value) {
		try {
			const parsed = parseConfigWithMigration(value);
			return { value: Config(parsed.migrated ? parsed.config : value) };
		} catch (error) {
			return { issues: [{ message: error instanceof Error ? error.message : "Invalid MinerU configuration" }] };
		}
	}
} });
//#endregion
//#region src/observability.ts
function createStructuredDiagnosticSink(logger) {
	return (event) => {
		try {
			logger[event.level]("dsh-pdf-mineru", event);
		} catch {}
	};
}
function emitDiagnostic(sink, event) {
	try {
		sink?.(event);
	} catch {}
}
//#endregion
//#region src/domain/errors.ts
var MinerUError = class extends Error {
	failure;
	http;
	constructor(failure, options) {
		super(failure.message, options);
		this.failure = failure;
		this.name = "MinerUError";
		this.http = options?.http;
	}
};
function sanitizeDiagnostic(input, secrets = []) {
	let sanitized = input;
	for (const secret of secrets) if (secret !== "") sanitized = sanitized.split(secret).join("[REDACTED]");
	return sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]").replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
		try {
			const url = new URL(raw);
			url.username = "";
			url.password = "";
			url.pathname = url.pathname === "/" ? "/" : "/[REDACTED]";
			url.search = "";
			url.hash = "";
			return url.toString();
		} catch {
			return "[REDACTED_URL]";
		}
	}).slice(0, 2e3);
}
function failure(code, message, retryable = false, details = {}) {
	return {
		code,
		message: sanitizeDiagnostic(message),
		retryable,
		...details
	};
}
function toMinerUFailure(error, fallback = "PROVIDER_UNAVAILABLE") {
	if (error instanceof MinerUError) return error.failure;
	if (error instanceof Error && error.name === "AbortError") return failure("CANCELLED", "MinerU operation was cancelled", true);
	return failure(fallback, error instanceof Error ? error.message : String(error), true);
}
function throwMinerU(code, message, retryable = false) {
	throw new MinerUError(failure(code, message, retryable));
}
//#endregion
//#region src/providers/contract.ts
function validateProviderCapabilities(request, capabilities) {
	const semantics = request.semantics;
	const unsupported = (message) => {
		throw new MinerUError(failure("UNSUPPORTED_OPTION", message));
	};
	if (!capabilities.models.includes(semantics.model)) unsupported(`Provider does not support model ${semantics.model}`);
	if (!capabilities.parseMethods.includes(semantics.parseMethod)) unsupported(`Provider does not support parse method ${semantics.parseMethod}`);
	if (semantics.ocr && !capabilities.supportsOcr) unsupported("Provider does not support OCR");
	if (semantics.language && semantics.language !== "auto" && !capabilities.supportsLanguage) unsupported("Provider does not support language selection");
	if (!capabilities.supportsFormula && semantics.formula) unsupported("Provider does not support formula parsing");
	if (!capabilities.supportsTable && semantics.table) unsupported("Provider does not support table parsing");
	if (semantics.pages !== void 0 && !capabilities.supportsPageRanges) unsupported("Provider does not support page ranges");
	for (const artifact of request.requiredArtifacts) if (!capabilities.supportedArtifacts.includes(artifact)) unsupported(`Provider does not support artifact ${artifact}`);
	if (request.files.length > capabilities.maxFilesPerSubmission) unsupported(`Provider accepts at most ${String(capabilities.maxFilesPerSubmission)} files per submission`);
	if (capabilities.maxFileBytes !== void 0) {
		for (const file of request.files) if (file.bytes > capabilities.maxFileBytes) throw new MinerUError(failure("FILE_TOO_LARGE", `${file.name} exceeds the provider file-size limit`));
	}
}
//#endregion
//#region src/providers/http/retry.ts
async function readBoundedResponseText(response, maxBytes, signal) {
	const body = response.body;
	if (body === null) return "";
	const reader = body.getReader();
	const chunks = [];
	let totalBytes = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", `Response body exceeded limit of ${String(maxBytes)} bytes`));
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch (error) {
		try {
			await reader.cancel();
		} catch {}
		throw error;
	} finally {
		reader.releaseLock();
	}
}
const DEFAULT_RETRY_POLICY = {
	maxRetries: 2,
	initialDelayMs: 500,
	maxDelayMs: 1e4,
	backoffFactor: 2,
	jitter: true
};
/**
* Parses a standard HTTP Retry-After header value.
* Supports decimal integer seconds (e.g. "120") and HTTP-date strings.
* Returns the delay in milliseconds, or undefined if missing/unparseable.
*/
function parseRetryAfter(header, now = Date.now()) {
	if (!header || typeof header !== "string") return void 0;
	const trimmed = header.trim();
	if (!trimmed) return void 0;
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1e3)) return seconds * 1e3;
	}
	if (/^[-+]?\d+/.test(trimmed) && !/\s/.test(trimmed)) return;
	if (/[A-Za-z]{3}/.test(trimmed)) {
		const parsedDate = Date.parse(trimmed);
		if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - now);
	}
}
/**
* Returns true if an HTTP status code is typically transient and safe to retry.
* Matches 408 (Request Timeout), 429 (Too Many Requests), and 5xx server errors.
*/
function isRetryableHttpStatus(status) {
	return status === 408 || status === 429 || status >= 500 && status <= 599;
}
/**
* Determines whether a caught error is retryable.
* Abort/cancellation errors and explicit non-retryable MinerUErrors return false.
*/
function isRetryableError(err, signal) {
	if (signal?.aborted) return false;
	if (err instanceof DOMException && err.name === "AbortError") return false;
	if (err instanceof MinerUError) {
		if (err.failure.code === "CANCELLED") return false;
		return err.failure.retryable;
	}
	return false;
}
/**
* Abort-aware delay utility using node:timers/promises.
*/
async function defaultSleep(ms, signal) {
	if (ms <= 0) return;
	try {
		await setTimeout$1(ms, void 0, { signal });
	} catch (error) {
		if (signal.aborted && signal.reason) throw signal.reason;
		throw error;
	}
}
/**
* Calculates exponential backoff delay with optional jitter or Retry-After header.
*/
function calculateBackoffDelay(attempt, policy, retryAfterMs, random = Math.random) {
	if (retryAfterMs !== void 0 && retryAfterMs >= 0) return Math.min(policy.maxDelayMs, retryAfterMs);
	const base = policy.initialDelayMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1));
	const clamped = Math.min(policy.maxDelayMs, base);
	if (!policy.jitter) return clamped;
	const jittered = clamped * (.5 + .5 * random());
	return Math.round(jittered);
}
function boundedInteger(value, label, min, max) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(label + " must be an integer between " + String(min) + " and " + String(max));
	return value;
}
function resolveRetryPolicy(options = {}) {
	const maxRetries = boundedInteger(options.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries, "maxRetries", 0, 9);
	const initialDelayMs = boundedInteger(options.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs, "initialDelayMs", 1, 6e4);
	const maxDelayMs = boundedInteger(options.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs, "maxDelayMs", 1, 3e5);
	const backoffFactor = options.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor;
	const jitter = options.jitter ?? DEFAULT_RETRY_POLICY.jitter;
	if (!Number.isFinite(backoffFactor) || backoffFactor < 1 || backoffFactor > 10) throw new TypeError("backoffFactor must be between 1 and 10");
	if (typeof jitter !== "boolean") throw new TypeError("jitter must be a boolean");
	if (initialDelayMs > maxDelayMs) throw new TypeError("initialDelayMs cannot exceed maxDelayMs");
	return {
		maxRetries,
		initialDelayMs,
		maxDelayMs,
		backoffFactor,
		jitter
	};
}
/**
* Reusable bounded, abort-aware retry executor for idempotent provider operations.
*/
async function executeWithRetry(ctx) {
	const policy = resolveRetryPolicy(ctx.retryOptions);
	const sleepFn = ctx.retryOptions?.sleep ?? defaultSleep;
	const randomFn = ctx.retryOptions?.random ?? Math.random;
	const onRetry = ctx.retryOptions?.onRetry;
	let attempt = 1;
	while (true) {
		ctx.signal.throwIfAborted();
		try {
			return await ctx.fn(attempt);
		} catch (err) {
			if (ctx.signal.aborted) throw new MinerUError(failure("CANCELLED", "Operation was cancelled", true), { cause: err });
			if (!isRetryableError(err, ctx.signal) || attempt > policy.maxRetries) throw err;
			const http = err instanceof MinerUError ? err.http : void 0;
			const status = http?.status;
			const retryAfterMs = http?.retryAfterMs;
			const delayMs = calculateBackoffDelay(attempt, policy, retryAfterMs, randomFn);
			const reason = status === void 0 ? "transport" : "http-status";
			if (onRetry) try {
				onRetry({
					provider: ctx.provider,
					operation: ctx.operation,
					attempt,
					maxRetries: policy.maxRetries,
					delayMs,
					reason,
					...status !== void 0 ? { status } : {},
					...retryAfterMs !== void 0 ? { retryAfterMs } : {}
				});
			} catch {}
			try {
				await sleepFn(delayMs, ctx.signal);
			} catch (sleepErr) {
				if (ctx.signal.aborted) throw new MinerUError(failure("CANCELLED", "Operation was cancelled during retry backoff", true), { cause: sleepErr });
				throw sleepErr;
			}
			attempt++;
		}
	}
}
//#endregion
//#region src/utils/crypto.ts
/** Stream a file into SHA-256; Node owns cancellation listener cleanup. */
async function computeFileSha256(filePath, signal) {
	signal?.throwIfAborted();
	const digest = createHash("sha256");
	const stream = createReadStream(filePath, { signal });
	try {
		for await (const chunk of stream) digest.update(chunk);
		signal?.throwIfAborted();
		return digest.digest("hex");
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		stream.destroy();
	}
}
//#endregion
//#region src/domain/request.ts
const ARTIFACT_KINDS = [
	"markdown",
	"layout",
	"model-output",
	"content-list",
	"images"
];
function normalizeArtifactKinds(kinds) {
	const requested = /* @__PURE__ */ new Set(["markdown", ...kinds]);
	return ARTIFACT_KINDS.filter((kind) => requested.has(kind));
}
//#endregion
//#region src/source/prepared-source.ts
const SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([
	".pdf",
	".png",
	".jpg",
	".jpeg",
	".jp2",
	".webp",
	".gif",
	".bmp",
	".tif",
	".tiff",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx"
]);
/** Stat, bound and stream-hash one absolute local source; the path stays ephemeral. */
async function prepareSource(path, maxFileBytes, signal) {
	signal.throwIfAborted();
	if (!isAbsolute(path)) throw new TypeError("Source path must be absolute");
	let before;
	try {
		before = await stat(path);
	} catch (error) {
		throw new MinerUError(failure("FILE_NOT_FOUND", `Document does not exist: ${basename(path)}`), { cause: error });
	}
	if (!before.isFile()) throw new MinerUError(failure("INVALID_REQUEST", `${basename(path)} is not a regular file`));
	if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) throw new MinerUError(failure("UNSUPPORTED_OPTION", `Unsupported document type: ${extname(path) || "(none)"}`));
	if (before.size > maxFileBytes) throw new MinerUError(failure("FILE_TOO_LARGE", `${basename(path)} exceeds the configured file-size limit`));
	const sha256 = await computeFileSha256(path, signal);
	const after = await stat(path);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev || before.ino !== after.ino) throw new MinerUError(failure("INVALID_REQUEST", `${basename(path)} changed while it was being hashed`, true));
	return {
		fileId: createFileId(sha256),
		name: basename(path),
		bytes: after.size,
		sha256,
		path,
		fingerprint: {
			size: after.size,
			mtimeMs: after.mtimeMs,
			device: after.dev,
			inode: after.ino
		}
	};
}
/** Re-stat hashed sources immediately before upload. */
async function assertSourcesUnchanged(sources, signal) {
	for (const source of sources) {
		signal.throwIfAborted();
		let current;
		try {
			current = await stat(source.path);
		} catch (error) {
			throw new MinerUError(failure("FILE_NOT_FOUND", `${source.name} disappeared after hashing and before upload`), { cause: error });
		}
		const expected = source.fingerprint;
		if (!current.isFile() || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.dev !== expected.device || current.ino !== expected.inode) throw new MinerUError(failure("INVALID_REQUEST", `${source.name} changed after hashing and before upload`, true));
	}
}
/** Canonical single-file request; semantics come only from the effective parse defaults. */
function canonicalParseRequest(defaults, source) {
	const { model, parseMethod, language, formula, table } = defaults;
	return {
		schemaVersion: 1,
		files: [{
			fileId: source.fileId,
			name: source.name,
			bytes: source.bytes,
			sha256: source.sha256
		}],
		semantics: {
			model,
			ocr: parseMethod === "ocr",
			parseMethod,
			language,
			formula,
			table
		},
		requiredArtifacts: ARTIFACT_KINDS
	};
}
//#endregion
//#region src/providers/http/http-client.ts
/**
* Resolves a request path against a base URL, preserving pathname prefix if any.
*/
function resolveProviderUrl(baseUrl, path) {
	const parsed = typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl;
	const basePath = parsed.pathname.replace(/\/+$/, "");
	const normalizedPath = path ? path.startsWith("/") ? path : `/${path}` : "";
	return `${parsed.origin}${basePath}${normalizedPath}`;
}
const UPSTREAM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Describes a MinerU 4.x V1 error object `{ type, code, message, param }`. API servers and Routers use
* it for HTTP error bodies (under `error`) and for per-file job errors. The code leads the diagnostic
* because it names the cause (`engine_dead`, `quality_tier_unavailable`, `file_not_found`) more
* precisely than the HTTP status. `fallbackMessage` stands in for a missing message.
*/
function describeV1Error(value, fallbackMessage) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const code = nonEmptyString(record.code);
	const text = nonEmptyString(record.message) ?? (code === void 0 ? void 0 : nonEmptyString(fallbackMessage));
	if (code === void 0 && text === void 0) return void 0;
	const param = nonEmptyString(record.param);
	return {
		message: [code, text].filter((part) => part !== void 0).join(": ") + (param === void 0 ? "" : ` (param: ${param})`),
		...code !== void 0 && UPSTREAM_CODE_PATTERN.test(code) ? { code } : {}
	};
}
/** Keeps an upstream code as `providerCode` only when it is a plain token carrying none of the secrets. */
function safeProviderCode(code, secrets = []) {
	if (code === void 0 || !UPSTREAM_CODE_PATTERN.test(code)) return void 0;
	return sanitizeDiagnostic(code, secrets) === code ? code : void 0;
}
/**
* Extracts the diagnostic of an API error response body. A self-hosted V1 body is read as the V1
* error envelope first; otherwise the JSON fields detail, message, error and msg are inspected
* (msg first for official-v4, detail first for self-hosted). Non-JSON bodies fall back to their
* truncated raw text.
*/
function extractErrorDetail(bodyText, provider) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		const raw = bodyText.slice(0, 500);
		return raw === "" ? {} : { message: raw };
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const json = parsed;
	if (provider === "self-hosted-v1") {
		const envelope = describeV1Error(json.error);
		if (envelope !== void 0) return envelope;
	}
	const fields = provider === "official-v4" ? [
		"msg",
		"message",
		"detail",
		"error"
	] : [
		"detail",
		"message",
		"error",
		"msg"
	];
	for (const field of fields) {
		const value = json[field];
		if (typeof value === "string") return { message: value };
	}
	return {};
}
/**
* Maps HTTP error status codes to typed MinerUError instances with provider-specific diagnostic phrasing.
* `providerCode` records the upstream error code when the body carried one.
*/
function createHttpStatusError(provider, status, diagnostic, retryAfterMs, providerCode) {
	const options = { http: {
		status,
		retryAfterMs
	} };
	const details = {
		provider,
		...providerCode === void 0 ? {} : { providerCode }
	};
	let err;
	if (provider === "official-v4") {
		if (status === 401 || status === 403) err = new MinerUError(failure("AUTHENTICATION_FAILED", `Official MinerU authentication failed (${String(status)})${diagnostic}`, false, details), options);
		else if (status === 404) err = new MinerUError(failure("JOB_NOT_FOUND", `Official MinerU resource not found (${String(status)})${diagnostic}`, false, details), options);
		else if (status === 413) err = new MinerUError(failure("FILE_TOO_LARGE", `File exceeds size limit (${String(status)})${diagnostic}`, false, details), options);
		else if (status === 429) err = new MinerUError(failure("PROVIDER_RATE_LIMITED", `Official MinerU rate limit exceeded (${String(status)})${diagnostic}`, true, details), options);
		else if (status === 408) err = new MinerUError(failure("PROVIDER_UNAVAILABLE", `Official MinerU request timeout (${String(status)})${diagnostic}`, true, details), options);
		else if (status >= 500) err = new MinerUError(failure("PROVIDER_UNAVAILABLE", `Official MinerU server error (${String(status)})${diagnostic}`, true, details), options);
		else err = new MinerUError(failure("REMOTE_PARSE_FAILED", `Official MinerU returned status ${String(status)}${diagnostic}`, false, details), options);
	} else if (status === 401 || status === 403) err = new MinerUError(failure("AUTHENTICATION_FAILED", `Authentication failed (${String(status)})${diagnostic}`, false, details), options);
	else if (status === 404) err = new MinerUError(failure("JOB_NOT_FOUND", `Resource not found (${String(status)})${diagnostic}`, false, details), options);
	else if (status === 413) err = new MinerUError(failure("FILE_TOO_LARGE", `Uploaded file is too large (${String(status)})${diagnostic}`, false, details), options);
	else if (status === 429) err = new MinerUError(failure("PROVIDER_RATE_LIMITED", `Provider rate limit exceeded (${String(status)})${diagnostic}`, true, details), options);
	else if (status === 408) err = new MinerUError(failure("PROVIDER_UNAVAILABLE", `MinerU server request timeout (${String(status)})${diagnostic}`, true, details), options);
	else if (status >= 500) err = new MinerUError(failure("PROVIDER_UNAVAILABLE", `MinerU server error (${String(status)})${diagnostic}`, true, details), options);
	else err = new MinerUError(failure("REMOTE_PARSE_FAILED", `MinerU returned unexpected status ${String(status)}${diagnostic}`, false, details), options);
	return err;
}
/**
* Reusable HTTP client for MinerU providers encapsulating request setup, credential injection,
* timeout management, error body extraction, status code mapping, and bounded retries.
*/
var ProviderHttpClient = class {
	baseUrl;
	provider;
	providerLabel;
	constructor(options) {
		this.baseUrl = typeof options.baseURL === "string" ? new URL(options.baseURL) : options.baseURL;
		this.provider = options.provider;
		this.providerLabel = options.providerLabel ?? (options.provider === "official-v4" ? "MinerU official API" : "MinerU server");
	}
	async requestJson(opts) {
		const method = opts.method ?? "GET";
		const reqPath = opts.path;
		const reqBody = opts.body;
		const reqHeaders = opts.headers ?? {};
		const reqContext = opts.context;
		const acceptedStatusesList = opts.acceptedStatuses ?? [200];
		const allowRetry = opts.retry ?? method.toUpperCase() === "GET";
		const operation = opts.operation ?? (reqPath.startsWith("/health") || reqPath.includes("probe") ? "probe" : "api-json");
		const executeOnce = async () => {
			reqContext.signal.throwIfAborted();
			const url = resolveProviderUrl(this.baseUrl, reqPath);
			const controller = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort(new DOMException(`Request timed out after ${String(reqContext.timeoutMs)}ms`, "TimeoutError"));
			}, reqContext.timeoutMs);
			const onParentAbort = () => {
				controller.abort(reqContext.signal.reason);
			};
			reqContext.signal.addEventListener("abort", onParentAbort, { once: true });
			try {
				const requestHeaders = { ...reqHeaders };
				if (reqContext.credential && reqContext.credential.trim() !== "") requestHeaders["authorization"] = `Bearer ${reqContext.credential}`;
				let response;
				try {
					const requestInit = {
						method,
						headers: requestHeaders,
						body: reqBody,
						signal: controller.signal,
						redirect: "error",
						...reqBody !== void 0 ? { duplex: "half" } : {}
					};
					response = await fetch(url, requestInit);
				} catch (err) {
					if (reqContext.signal.aborted) throw new MinerUError(failure("CANCELLED", "Operation was cancelled", true));
					if (timedOut) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", `Request to ${this.providerLabel} timed out after ${String(reqContext.timeoutMs)}ms`, true), { http: { status: 408 } });
					const message = err instanceof Error ? err.message : String(err);
					throw new MinerUError(failure("PROVIDER_UNAVAILABLE", `Failed to connect to ${this.providerLabel}: ${message}`, true), { cause: err });
				}
				const status = response.status;
				if (!acceptedStatusesList.includes(status)) {
					let errorBody = "";
					try {
						errorBody = await readBoundedResponseText(response, reqContext.limits.maxApiResponseBytes, controller.signal);
					} catch {
						if (response.body) try {
							await response.body.cancel();
						} catch {}
					}
					const secrets = [reqContext.credential ?? ""];
					const detail = extractErrorDetail(errorBody, this.provider);
					const diagnostic = detail.message ? `: ${sanitizeDiagnostic(detail.message, secrets)}` : "";
					const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
					throw createHttpStatusError(this.provider, status, diagnostic, retryAfterMs, safeProviderCode(detail.code, secrets));
				}
				const contentType = response.headers.get("content-type") ?? "";
				if (!contentType.toLowerCase().includes("application/json")) {
					if (response.body) try {
						await response.body.cancel();
					} catch {}
					throw new MinerUError(failure("REMOTE_PARSE_FAILED", this.provider === "official-v4" ? `Expected application/json response, got "${contentType}"` : `Expected application/json response, got ${contentType || "unknown"}`, false, { provider: this.provider }));
				}
				const rawText = await readBoundedResponseText(response, reqContext.limits.maxApiResponseBytes, controller.signal);
				let parsed;
				try {
					parsed = JSON.parse(rawText);
				} catch (err) {
					if (err instanceof MinerUError) throw err;
					throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`, false, { provider: this.provider }), { cause: err });
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", this.provider === "official-v4" ? "Official MinerU response must be an object" : "MinerU response must be an object", false, { provider: this.provider }));
				if (opts.validateResponse) {
					const validated = opts.validateResponse(parsed, response);
					if (validated !== void 0) return validated;
				}
				return parsed;
			} finally {
				clearTimeout(timer);
				reqContext.signal.removeEventListener("abort", onParentAbort);
			}
		};
		if (!allowRetry) return await executeOnce();
		return await executeWithRetry({
			provider: this.provider,
			operation,
			signal: reqContext.signal,
			retryOptions: reqContext.retry,
			fn: executeOnce
		});
	}
};
//#endregion
//#region src/providers/self-hosted-legacy-v2/index.ts
function mapSelfHostedStatus(rawStatus) {
	if (typeof rawStatus !== "string") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Missing task status from MinerU server response"));
	switch (rawStatus.toLowerCase()) {
		case "pending":
		case "waiting":
		case "queued": return "queued";
		case "processing":
		case "running":
		case "converting": return "processing";
		case "completed":
		case "done":
		case "success": return "completed";
		case "failed":
		case "error": return "failed";
		default: throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Unknown remote task status: "${rawStatus}"`));
	}
}
function jsonArtifact(value) {
	if (typeof value !== "string") return JSON.stringify(value);
	try {
		JSON.parse(value);
		return value;
	} catch {
		return JSON.stringify(value);
	}
}
function decodeBase64Image(value, fileId) {
	const compact = value.replace(/\s+/g, "");
	if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Self-hosted result contains invalid base64 image data", false, {
		provider: "self-hosted-legacy-v2",
		fileId
	}));
	return Buffer.from(compact, "base64");
}
function findFileResult(file, results, allFiles) {
	if (Object.prototype.hasOwnProperty.call(results, file.name)) return results[file.name];
	const stem = file.name.replace(/\.[^/.]+$/, "");
	if (Object.prototype.hasOwnProperty.call(results, stem)) {
		if (allFiles.length > 1) {
			if (allFiles.filter((f) => f.name.replace(/\.[^/.]+$/, "") === stem).length === 1) return results[stem];
			return;
		}
		return results[stem];
	}
	if (allFiles.length === 1) {
		const keys = Object.keys(results);
		if (keys.length === 1 && keys[0] !== void 0) return results[keys[0]];
	}
}
var SelfHostedLegacyV2Provider = class {
	id = "self-hosted-legacy-v2";
	config;
	capabilities;
	parsedBaseUrl;
	client;
	constructor(config) {
		this.config = config;
		this.parsedBaseUrl = new URL(config.baseURL);
		this.client = new ProviderHttpClient({
			baseURL: this.parsedBaseUrl,
			provider: "self-hosted-legacy-v2",
			providerLabel: "MinerU server"
		});
		const supportedModels = ["pipeline", "vlm"].filter((model) => config.modelMap[model] !== void 0);
		this.capabilities = {
			models: supportedModels,
			parseMethods: [
				"auto",
				"txt",
				"ocr"
			],
			supportsOcr: true,
			supportsLanguage: true,
			supportsFormula: true,
			supportsTable: true,
			supportsPageRanges: true,
			supportedArtifacts: [
				"markdown",
				"layout",
				"model-output",
				"content-list",
				"images"
			],
			maxFilesPerSubmission: 10
		};
	}
	compatibilityKey(request) {
		const originAndPath = `${this.parsedBaseUrl.origin}${this.parsedBaseUrl.pathname.replace(/\/+$/, "")}`;
		const backend = this.config.modelMap[request.semantics.model];
		return `self-hosted-legacy-v2:${createHash("sha256").update(JSON.stringify({
			originAndPath,
			configuredVersion: this.config.configuredVersion ?? "v2",
			model: request.semantics.model,
			backend
		}), "utf8").digest("hex").slice(0, 24)}`;
	}
	async probe(context) {
		try {
			const data = await this.requestJson("GET", "/health", void 0, {}, context, [200], {
				operation: "probe",
				retry: true
			});
			const isHealthy = data.status === "healthy";
			const protocolVersion = data.protocol_version !== void 0 ? `v${String(data.protocol_version)}` : "v2";
			const serverVersion = typeof data.version === "string" ? data.version : void 0;
			return {
				available: isHealthy,
				provider: "self-hosted-legacy-v2",
				authentication: context.credential && context.credential.trim() !== "" ? "valid" : "not-configured",
				protocolVersion,
				...serverVersion !== void 0 ? { serverVersion } : {},
				queue: {
					queued: typeof data.queued_tasks === "number" ? data.queued_tasks : void 0,
					processing: typeof data.processing_tasks === "number" ? data.processing_tasks : void 0,
					completed: typeof data.completed_tasks === "number" ? data.completed_tasks : void 0,
					failed: typeof data.failed_tasks === "number" ? data.failed_tasks : void 0,
					maxConcurrent: typeof data.max_concurrent_requests === "number" ? data.max_concurrent_requests : void 0
				},
				...isHealthy ? {} : { diagnostics: "Server reported unhealthy status" }
			};
		} catch (error) {
			if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Probe operation was cancelled", true));
			const minerUFailure = toMinerUFailure(error);
			return {
				available: false,
				provider: "self-hosted-legacy-v2",
				authentication: minerUFailure.code === "AUTHENTICATION_FAILED" ? "invalid" : context.credential && context.credential.trim() !== "" ? "unknown" : "not-configured",
				protocolVersion: "v2",
				diagnostics: minerUFailure.message
			};
		}
	}
	async submit(request, sources, context) {
		context.signal.throwIfAborted();
		const backend = this.config.modelMap[request.semantics.model];
		if (sources.length !== request.files.length) throw new MinerUError(failure("INVALID_REQUEST", "Prepared source files count does not match request files count"));
		await assertSourcesUnchanged(sources, context.signal);
		let pageInterval;
		if (request.semantics.pages !== void 0) {
			const intervals = request.semantics.pages.split(",").map((token) => {
				const parts = token.trim().split("-");
				const start = Number(parts[0]);
				return {
					start,
					end: parts[1] !== void 0 ? Number(parts[1]) : start
				};
			});
			if (intervals.length !== 1 || intervals[0] === void 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", "Self-hosted legacy v2 provider only supports a single continuous page range"));
			pageInterval = intervals[0];
		}
		const form = new FormData();
		for (const source of sources) {
			const blob = await openAsBlob(source.path);
			form.append("files", blob, source.name);
		}
		form.append("backend", backend);
		form.append("parse_method", request.semantics.parseMethod);
		form.append("lang_list", request.semantics.language);
		form.append("formula_enable", String(request.semantics.formula));
		form.append("table_enable", String(request.semantics.table));
		if (pageInterval !== void 0) {
			form.append("start_page_id", String(pageInterval.start - 1));
			form.append("end_page_id", String(pageInterval.end - 1));
		}
		const requiredSet = new Set(request.requiredArtifacts);
		form.append("return_md", String(requiredSet.has("markdown")));
		form.append("return_middle_json", String(requiredSet.has("layout")));
		form.append("return_model_output", String(requiredSet.has("model-output")));
		form.append("return_content_list", String(requiredSet.has("content-list")));
		form.append("return_images", String(requiredSet.has("images")));
		const data = await this.requestJson("POST", "/tasks", form, {}, context, [200, 202], {
			operation: "submit",
			retry: false
		});
		if (!data || typeof data.task_id !== "string" || data.task_id.trim() === "") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server did not return a valid task_id"));
		const state = mapSelfHostedStatus(data.status);
		const submittedFiles = request.files.map((f) => ({
			dataId: `data_${f.fileId}`,
			fileId: f.fileId,
			name: f.name
		}));
		return {
			ref: {
				provider: "self-hosted-legacy-v2",
				taskId: data.task_id,
				files: submittedFiles
			},
			state,
			files: request.files.map((f) => ({
				fileId: f.fileId,
				state: state === "queued" ? "queued" : state === "processing" ? "processing" : state === "completed" ? "completed" : "failed",
				rawState: data.status,
				failure: state === "failed" ? failure("REMOTE_PARSE_FAILED", sanitizeDiagnostic(data.error ?? "Remote task submission failed", [context.credential ?? ""]), false, {
					provider: "self-hosted-legacy-v2",
					fileId: f.fileId
				}) : void 0
			}))
		};
	}
	async inspect(ref, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "self-hosted-legacy-v2") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref "${ref.provider}" for SelfHostedLegacyV2Provider`));
		const data = await this.requestJson("GET", `/tasks/${encodeURIComponent(ref.taskId)}`, void 0, {}, context, [200], {
			operation: "inspect",
			retry: true
		});
		const state = mapSelfHostedStatus(data.status);
		const fileState = state === "queued" ? "queued" : state === "processing" ? "processing" : state === "completed" ? "completed" : "failed";
		const fileFailure = state === "failed" ? failure("REMOTE_PARSE_FAILED", sanitizeDiagnostic(data.error ?? "Remote task failed", [context.credential ?? ""]), false, { provider: "self-hosted-legacy-v2" }) : void 0;
		return {
			state,
			files: ref.files.map((f) => ({
				fileId: f.fileId,
				state: fileState,
				rawState: data.status,
				failure: fileFailure ? {
					...fileFailure,
					fileId: f.fileId
				} : void 0
			})),
			rawState: data.status,
			queuedAhead: typeof data.queued_ahead === "number" ? data.queued_ahead : void 0
		};
	}
	async collect(ref, request, sink, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "self-hosted-legacy-v2") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref "${ref.provider}" for SelfHostedLegacyV2Provider`));
		const data = await this.requestJson("GET", `/tasks/${encodeURIComponent(ref.taskId)}/result`, void 0, {}, context, [200], {
			operation: "collect",
			retry: true
		});
		if (!data || typeof data.results !== "object" || data.results === null) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server returned empty or invalid results"));
		const collectedFiles = [];
		const requiredSet = new Set(request.requiredArtifacts);
		for (const file of ref.files) {
			const fileResult = findFileResult(file, data.results, ref.files);
			if (!fileResult) {
				collectedFiles.push({
					fileId: file.fileId,
					name: file.name,
					artifacts: [],
					failure: failure("REMOTE_PARSE_FAILED", `No parse result found for file "${file.name}"`, false, {
						provider: "self-hosted-legacy-v2",
						fileId: file.fileId
					})
				});
				continue;
			}
			const artifacts = [];
			if (requiredSet.has("markdown") && typeof fileResult.md_content === "string") {
				const artifactRef = await sink.writeArtifact(file.fileId, "markdown", fileResult.md_content, {
					mediaType: "text/markdown; charset=utf-8",
					relativeName: "full.md"
				});
				artifacts.push(artifactRef);
			}
			if (requiredSet.has("layout") && fileResult.middle_json !== null && fileResult.middle_json !== void 0) {
				const content = jsonArtifact(fileResult.middle_json);
				const artifactRef = await sink.writeArtifact(file.fileId, "layout", content, {
					mediaType: "application/json",
					relativeName: "layout.json"
				});
				artifacts.push(artifactRef);
			}
			if (requiredSet.has("model-output") && fileResult.model_output !== null && fileResult.model_output !== void 0) {
				const content = jsonArtifact(fileResult.model_output);
				const artifactRef = await sink.writeArtifact(file.fileId, "model-output", content, {
					mediaType: "application/json",
					relativeName: "model.json"
				});
				artifacts.push(artifactRef);
			}
			if (requiredSet.has("content-list") && fileResult.content_list !== null && fileResult.content_list !== void 0) {
				const content = jsonArtifact(fileResult.content_list);
				const artifactRef = await sink.writeArtifact(file.fileId, "content-list", content, {
					mediaType: "application/json",
					relativeName: "content_list.json"
				});
				artifacts.push(artifactRef);
			}
			if (requiredSet.has("images")) {
				const imagePaths = [];
				for (const [imgName, dataUrl] of Object.entries(fileResult.images ?? {})) {
					if (typeof dataUrl !== "string" || dataUrl.trim() === "") continue;
					let mediaType = "image/png";
					let base64Payload = dataUrl;
					const dataUrlMatch = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
					if (dataUrlMatch && dataUrlMatch[1] && dataUrlMatch[2]) {
						mediaType = dataUrlMatch[1];
						base64Payload = dataUrlMatch[2];
					}
					const buffer = decodeBase64Image(base64Payload, file.fileId);
					const cleanName = imgName.split(/[/\\]/).filter(Boolean).filter((s) => s !== "." && s !== "..").join("_").replace(/[^A-Za-z0-9_.-]/g, "_");
					const relativeName = `images/${cleanName === "index.json" ? "source_index.json" : cleanName || "img.png"}`;
					imagePaths.push(relativeName);
					const artifactRef = await sink.writeArtifact(file.fileId, "images", buffer, {
						mediaType,
						relativeName
					});
					artifacts.push(artifactRef);
				}
				artifacts.push(await sink.writeArtifact(file.fileId, "images", JSON.stringify({ images: imagePaths }), {
					mediaType: "application/json",
					relativeName: "images/index.json"
				}));
			}
			const producedKinds = new Set(artifacts.map((artifact) => artifact.kind));
			const missingKinds = request.requiredArtifacts.filter((kind) => !producedKinds.has(kind));
			if (missingKinds.length > 0) collectedFiles.push({
				fileId: file.fileId,
				name: file.name,
				artifacts,
				failure: failure("REMOTE_PARSE_FAILED", `Provider result is missing required artifacts: ${missingKinds.join(", ")}`, false, {
					provider: "self-hosted-legacy-v2",
					fileId: file.fileId
				})
			});
			else collectedFiles.push({
				fileId: file.fileId,
				name: file.name,
				artifacts
			});
		}
		return { files: collectedFiles };
	}
	async requestJson(method, path, body, headers, context, acceptedStatuses = [200], options) {
		return await this.client.requestJson({
			method,
			path,
			body,
			headers,
			context,
			acceptedStatuses,
			operation: options?.operation,
			retry: options?.retry
		});
	}
};
//#endregion
//#region src/providers/self-hosted-v1/upload.ts
const EXTENSION_MIME_TYPES = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".jp2": "image/jp2",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
function uploadFailed(message, retryable = false, details = {}, http) {
	return new MinerUError(failure("UPLOAD_FAILED", message, retryable, {
		provider: "self-hosted-v1",
		...details
	}), { http });
}
function mimeTypeForName(name) {
	const match = /\.[^./\\]+$/.exec(name.toLowerCase());
	return (match === null ? void 0 : EXTENSION_MIME_TYPES[match[0]]) ?? "application/octet-stream";
}
function effectivePort(url) {
	return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}
/** Same scheme, host, and effective port; the only target that may receive the API key. */
function isSameOriginUrl(target, baseUrl) {
	return target.protocol === baseUrl.protocol && target.hostname.toLowerCase() === baseUrl.hostname.toLowerCase() && effectivePort(target) === effectivePort(baseUrl);
}
/** True when an HTTPS endpoint points the byte upload at a cleartext origin elsewhere. */
function isInsecureCrossOriginUpload(target, baseUrl) {
	return target.protocol === "http:" && baseUrl.protocol !== "http:" && !isSameOriginUrl(target, baseUrl);
}
/** Owns V1 upload-session allocation, fresh byte PUTs, and completion. */
var SelfHostedV1Uploader = class {
	baseUrl;
	client;
	constructor(baseUrl, client) {
		this.baseUrl = baseUrl;
		this.client = client;
	}
	async uploadSource(source, context) {
		const created = await this.client.requestJson({
			method: "POST",
			path: "/v1/uploads",
			body: JSON.stringify({
				filename: source.name,
				bytes: source.bytes,
				mime_type: mimeTypeForName(source.name),
				purpose: "parse",
				sha256sum: source.sha256
			}),
			headers: { "content-type": "application/json" },
			context,
			acceptedStatuses: [200],
			operation: "submit",
			retry: false
		});
		if (created?.status === "completed") return this.requireFileId(created, source.name);
		if (created?.status !== "pending") throw uploadFailed(`MinerU upload session entered unsupported state "${String(created?.status)}"`, false, { fileId: source.fileId });
		const uploadId = created.id;
		const uploadUrl = created.upload_url;
		if (typeof uploadId !== "string" || uploadId.trim() === "" || typeof uploadUrl !== "string" || uploadUrl.trim() === "") throw uploadFailed("MinerU server returned an incomplete upload session", false, { fileId: source.fileId });
		if (created.upload_method !== void 0 && created.upload_method !== null && created.upload_method !== "PUT") throw uploadFailed(`MinerU server requested unsupported upload method "${String(created.upload_method)}"`, false, { fileId: source.fileId });
		await this.putUploadBytes(uploadUrl, created.upload_headers ?? {}, source, context);
		const completed = await this.client.requestJson({
			method: "POST",
			path: `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
			body: JSON.stringify({}),
			headers: { "content-type": "application/json" },
			context,
			acceptedStatuses: [200],
			operation: "submit",
			retry: false
		});
		return this.requireFileId(completed, source.name);
	}
	requireFileId(upload, name) {
		const fileId = upload?.file?.id;
		if (typeof fileId !== "string" || fileId.trim() === "") throw uploadFailed(`MinerU server did not return a file id for "${name}"`);
		return fileId;
	}
	/**
	* Streams source bytes to the service-provided upload URL. The API key is attached only
	* when the target is same-origin with the configured endpoint; service-provided upload
	* headers are otherwise preserved verbatim. PUT is idempotent, so transient failures retry
	* with a freshly opened source file.
	*/
	async putUploadBytes(rawUploadUrl, uploadHeaders, source, context) {
		const target = this.resolveUploadUrl(rawUploadUrl);
		const sameOrigin = this.isSameOrigin(target);
		const headers = {};
		let serviceAuthorization = false;
		for (const [key, value] of Object.entries(uploadHeaders)) {
			if (typeof value !== "string" || /[\r\n]/.test(key) || /[\r\n]/.test(value)) throw uploadFailed("MinerU server returned an invalid upload header");
			if (key.toLowerCase() === "authorization") serviceAuthorization = true;
			headers[key] = value;
		}
		if (sameOrigin && !serviceAuthorization && typeof context.credential === "string" && context.credential.trim() !== "") headers["authorization"] = `Bearer ${context.credential}`;
		await executeWithRetry({
			provider: "self-hosted-v1",
			operation: "upload-put",
			signal: context.signal,
			retryOptions: context.retry,
			fn: async () => {
				context.signal.throwIfAborted();
				await assertSourcesUnchanged([source], context.signal);
				const controller = new AbortController();
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new DOMException(`Upload timed out after ${String(context.timeoutMs)}ms`, "TimeoutError"));
				}, context.timeoutMs);
				const onParentAbort = () => {
					controller.abort(context.signal.reason);
				};
				context.signal.addEventListener("abort", onParentAbort, { once: true });
				try {
					const blob = await openAsBlob(source.path);
					const requestInit = {
						method: "PUT",
						headers,
						body: blob,
						signal: controller.signal,
						redirect: "error"
					};
					let response;
					try {
						response = await fetch(target.toString(), requestInit);
					} catch (error) {
						if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Upload was cancelled", true));
						if (timedOut) throw uploadFailed(`Upload to MinerU server timed out after ${String(context.timeoutMs)}ms`, true, { fileId: source.fileId }, { status: 408 });
						throw uploadFailed(`Failed to upload source bytes: ${error instanceof Error ? error.message : String(error)}`, true, { fileId: source.fileId });
					}
					if (response.status !== 200 && response.status !== 204) {
						let errorBody = "";
						try {
							errorBody = await readBoundedResponseText(response, 2048, controller.signal);
						} catch {
							if (response.body) try {
								await response.body.cancel();
							} catch {}
						}
						const secrets = [context.credential ?? ""];
						const detail = extractErrorDetail(errorBody, "self-hosted-v1");
						const providerCode = safeProviderCode(detail.code, secrets);
						const diagnostic = detail.message || errorBody;
						throw uploadFailed(`Upload failed with HTTP status ${String(response.status)}${diagnostic === "" ? "" : `: ${sanitizeDiagnostic(diagnostic, secrets)}`}`, isRetryableHttpStatus(response.status), {
							fileId: source.fileId,
							...providerCode === void 0 ? {} : { providerCode }
						}, {
							status: response.status,
							retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
						});
					}
					if (response.body) try {
						await response.body.cancel();
					} catch {}
				} finally {
					clearTimeout(timer);
					context.signal.removeEventListener("abort", onParentAbort);
				}
			}
		});
	}
	resolveUploadUrl(raw) {
		let target;
		try {
			target = new URL(raw, this.baseUrl);
		} catch {
			throw uploadFailed("MinerU server returned an invalid upload URL");
		}
		if (target.protocol !== "https:" && target.protocol !== "http:" || target.username !== "" || target.password !== "") throw uploadFailed("MinerU server returned an unsupported upload URL");
		if (isInsecureCrossOriginUpload(target, this.baseUrl)) throw uploadFailed("MinerU server returned an insecure cross-origin upload URL");
		return target;
	}
	isSameOrigin(target) {
		return isSameOriginUrl(target, this.baseUrl);
	}
};
//#endregion
//#region src/providers/self-hosted-v1/canonical-artifacts.ts
async function readArtifactInputText(input, maxBytes) {
	if (typeof input === "string") return input;
	const stream = input instanceof Uint8Array ? Readable.from([input]) : input instanceof Readable ? input : Readable.fromWeb(input);
	const chunks = [];
	let totalBytes = 0;
	try {
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buffer.byteLength;
			if (maxBytes !== void 0 && totalBytes > maxBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", `Artifact input exceeded byte limit of ${String(maxBytes)} bytes`, false, { provider: "self-hosted-v1" }));
			chunks.push(buffer);
		}
	} catch (error) {
		stream.destroy();
		throw error;
	}
	return Buffer.concat(chunks).toString("utf8");
}
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function paragraphTitleLevel(type, source) {
	const level = source.level;
	if (type !== "doc_title" && type !== "paragraph_title" && type !== "title") return void 0;
	return typeof level === "number" && Number.isSafeInteger(level) && level >= 1 ? level : void 0;
}
/** MinerU 4.x captions/footnotes are strings or `{ bbox, content }` objects; the canonical artifact holds strings. */
function captionStrings$1(value) {
	if (!Array.isArray(value)) return [];
	const captions = [];
	for (const item of value) {
		const text = typeof item === "string" ? item : asRecord$1(item)?.content;
		if (typeof text === "string" && text.trim() !== "") captions.push(text);
	}
	return captions;
}
/**
* Converts the MinerU 4.x `structured_content.json` document into the plugin's canonical
* content-list array: the page container supplies each block's `page_idx`, MinerU title
* types map onto the canonical heading fields, and image/table references map onto the
* canonical caption and image-path fields. Unknown fields are preserved as-is.
*/
function canonicalizeStructuredContent(parsed) {
	if (Array.isArray(parsed)) return void 0;
	const pages = asRecord$1(parsed)?.pages;
	if (!Array.isArray(pages)) return void 0;
	const blocks = [];
	for (const page of pages) {
		const pageRecord = asRecord$1(page);
		if (pageRecord === void 0) continue;
		const pageBlocks = pageRecord.blocks;
		if (!Array.isArray(pageBlocks)) continue;
		const pageIndex = pageRecord.page_idx;
		for (const block of pageBlocks) {
			const source = asRecord$1(block);
			if (source === void 0) continue;
			const target = { ...source };
			if (typeof pageIndex === "number" && Number.isSafeInteger(pageIndex) && pageIndex >= 0) target.page_idx = pageIndex;
			const type = typeof source.type === "string" ? source.type.toLowerCase() : void 0;
			if (type === "doc_title" || type === "paragraph_title") target.type = "title";
			const level = paragraphTitleLevel(type, source);
			if (level !== void 0) target.text_level = level;
			delete target.level;
			if (typeof source.image_source === "string" && target.img_path === void 0) target.img_path = source.image_source;
			delete target.image_source;
			const isTable = type === "table";
			const captions = captionStrings$1(source.captions);
			if (captions.length > 0) {
				if (isTable) target.table_caption = captions;
				else target.image_caption = captions;
			}
			const footnotes = captionStrings$1(source.footnotes);
			if (footnotes.length > 0) {
				if (isTable) target.table_footnote = footnotes;
				else target.image_footnote = footnotes;
			}
			delete target.captions;
			delete target.footnotes;
			blocks.push(target);
		}
	}
	return blocks;
}
/**
* The plugin's canonical layout document exposes the ordered page list as `pdf_info[]`.
* MinerU 4.x publishes the same list as `pages[]`; keep the upstream document and add the
* canonical alias so physical page bounds stay verifiable.
*/
function canonicalizeLayoutDocument(parsed) {
	const document = asRecord$1(parsed);
	if (document === void 0) return void 0;
	if (Array.isArray(document.pdf_info)) return void 0;
	const pages = document.pages;
	if (!Array.isArray(pages)) return void 0;
	return {
		...document,
		pdf_info: pages
	};
}
/**
* Rewrites the two MinerU 4.x document shapes into canonical artifacts on their way into
* staging; every other entry is streamed through untouched.
*/
function canonicalizingSink(sink) {
	return {
		writeTemporary: async (name, input, maxBytes) => await sink.writeTemporary(name, input, maxBytes),
		writeArtifact: async (fileId, kind, input, options) => {
			const canonicalize = kind === "content-list" ? canonicalizeStructuredContent : kind === "layout" ? canonicalizeLayoutDocument : void 0;
			if (canonicalize === void 0) return await sink.writeArtifact(fileId, kind, input, options);
			const raw = await readArtifactInputText(input, options.maxBytes);
			let canonical;
			try {
				canonical = canonicalize(JSON.parse(raw));
			} catch {
				canonical = void 0;
			}
			return canonical === void 0 ? await sink.writeArtifact(fileId, kind, raw, options) : await sink.writeArtifact(fileId, kind, JSON.stringify(canonical), options);
		}
	};
}
//#endregion
//#region node_modules/.pnpm/pend@1.2.0/node_modules/pend/index.js
var require_pend = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Pend;
	function Pend() {
		this.pending = 0;
		this.max = Infinity;
		this.listeners = [];
		this.waiting = [];
		this.error = null;
	}
	Pend.prototype.go = function(fn) {
		if (this.pending < this.max) pendGo(this, fn);
		else this.waiting.push(fn);
	};
	Pend.prototype.wait = function(cb) {
		if (this.pending === 0) cb(this.error);
		else this.listeners.push(cb);
	};
	Pend.prototype.hold = function() {
		return pendHold(this);
	};
	function pendHold(self) {
		self.pending += 1;
		var called = false;
		return onCb;
		function onCb(err) {
			if (called) throw new Error("callback called twice");
			called = true;
			self.error = self.error || err;
			self.pending -= 1;
			if (self.waiting.length > 0 && self.pending < self.max) pendGo(self, self.waiting.shift());
			else if (self.pending === 0) {
				var listeners = self.listeners;
				self.listeners = [];
				listeners.forEach(cbListener);
			}
		}
		function cbListener(listener) {
			listener(self.error);
		}
	}
	function pendGo(self, fn) {
		fn(pendHold(self));
	}
}));
//#endregion
//#region node_modules/.pnpm/yauzl@3.4.0/node_modules/yauzl/fd-slicer.js
var require_fd_slicer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fs$1 = __require("fs");
	var util$1 = __require("util");
	var stream = __require("stream");
	var Readable = stream.Readable;
	var PassThrough = stream.PassThrough;
	var Pend = require_pend();
	var EventEmitter$1 = __require("events").EventEmitter;
	exports.BufferSlicer = BufferSlicer;
	exports.FdSlicer = FdSlicer;
	util$1.inherits(FdSlicer, EventEmitter$1);
	function FdSlicer(fd) {
		EventEmitter$1.call(this);
		this.fd = fd;
		this.pend = new Pend();
		this.pend.max = 1;
		this.refCount = 0;
	}
	FdSlicer.prototype.read = function(buffer, offset, length, position, callback) {
		var self = this;
		self.pend.go(function(cb) {
			fs$1.read(self.fd, buffer, offset, length, position, function(err, bytesRead, buffer) {
				cb();
				callback(err, bytesRead, buffer);
			});
		});
	};
	FdSlicer.prototype.createReadStream = function(options) {
		return new ReadStream(this, options);
	};
	FdSlicer.prototype.ref = function() {
		this.refCount += 1;
	};
	FdSlicer.prototype.unref = function() {
		var self = this;
		self.refCount -= 1;
		if (self.refCount < 0) throw new Error("invalid unref");
		if (self.refCount > 0) return;
		fs$1.close(self.fd, onCloseDone);
		function onCloseDone(err) {
			if (err) self.emit("error", err);
			else self.emit("close");
		}
	};
	util$1.inherits(ReadStream, Readable);
	function ReadStream(context, options) {
		options = options || {};
		Readable.call(this, options);
		this.context = context;
		this.context.ref();
		this.start = options.start || 0;
		this.endOffset = options.end;
		this.pos = this.start;
	}
	ReadStream.prototype._read = function(n) {
		var self = this;
		var toRead = Math.min(self._readableState.highWaterMark, n);
		if (self.endOffset != null) toRead = Math.min(toRead, self.endOffset - self.pos);
		if (toRead <= 0) {
			self.push(null);
			this._cleanup();
			return;
		}
		self.context.pend.go(function(cb) {
			var buffer = Buffer.allocUnsafe(toRead);
			fs$1.read(self.context.fd, buffer, 0, toRead, self.pos, function(err, bytesRead) {
				if (err) self.destroy(err);
				else if (bytesRead === 0) {
					self.push(null);
					self._cleanup();
				} else {
					self.pos += bytesRead;
					self.push(buffer.slice(0, bytesRead));
				}
				cb();
			});
		});
	};
	ReadStream.prototype._destroy = function(err, cb) {
		this._cleanup();
		cb(err);
	};
	ReadStream.prototype._cleanup = function() {
		if (this.context != null) {
			this.context.unref();
			this.context = null;
		}
	};
	util$1.inherits(BufferSlicer, EventEmitter$1);
	function BufferSlicer(buffer) {
		EventEmitter$1.call(this);
		this.refCount = 0;
		this.buffer = buffer;
	}
	BufferSlicer.prototype.read = function(buffer, offset, length, position, callback) {
		if (!(0 <= offset && offset <= buffer.length)) throw new RangeError("offset outside buffer: 0 <= " + offset + " <= " + buffer.length);
		if (position < 0) throw new RangeError("position is negative: " + position);
		if (offset + length > buffer.length) length = buffer.length - offset;
		if (position + length > this.buffer.length) length = this.buffer.length - position;
		if (length <= 0) {
			setImmediate(function() {
				callback(null, 0);
			});
			return;
		}
		this.buffer.copy(buffer, offset, position, position + length);
		setImmediate(function() {
			callback(null, length);
		});
	};
	BufferSlicer.prototype.createReadStream = function(options) {
		options = options || {};
		var readStream = new PassThrough(options);
		readStream.start = options.start || 0;
		readStream.endOffset = options.end;
		readStream.pos = readStream.endOffset || this.buffer.length;
		var entireSlice = this.buffer.slice(readStream.start, readStream.pos);
		var maxChunkSize = 65536;
		var offset = 0;
		while (true) {
			var nextOffset = offset + maxChunkSize;
			if (nextOffset >= entireSlice.length) {
				if (offset < entireSlice.length) readStream.write(entireSlice.slice(offset, entireSlice.length));
				break;
			}
			readStream.write(entireSlice.slice(offset, nextOffset));
			offset = nextOffset;
		}
		readStream.end();
		return readStream;
	};
	BufferSlicer.prototype.ref = function() {
		this.refCount += 1;
	};
	BufferSlicer.prototype.unref = function() {
		this.refCount -= 1;
		if (this.refCount < 0) throw new Error("invalid unref");
	};
}));
//#endregion
//#region node_modules/.pnpm/yauzl@3.4.0/node_modules/yauzl/crc32.js
var require_crc32 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const CRC_TABLE = new Int32Array([
		0,
		1996959894,
		3993919788,
		2567524794,
		124634137,
		1886057615,
		3915621685,
		2657392035,
		249268274,
		2044508324,
		3772115230,
		2547177864,
		162941995,
		2125561021,
		3887607047,
		2428444049,
		498536548,
		1789927666,
		4089016648,
		2227061214,
		450548861,
		1843258603,
		4107580753,
		2211677639,
		325883990,
		1684777152,
		4251122042,
		2321926636,
		335633487,
		1661365465,
		4195302755,
		2366115317,
		997073096,
		1281953886,
		3579855332,
		2724688242,
		1006888145,
		1258607687,
		3524101629,
		2768942443,
		901097722,
		1119000684,
		3686517206,
		2898065728,
		853044451,
		1172266101,
		3705015759,
		2882616665,
		651767980,
		1373503546,
		3369554304,
		3218104598,
		565507253,
		1454621731,
		3485111705,
		3099436303,
		671266974,
		1594198024,
		3322730930,
		2970347812,
		795835527,
		1483230225,
		3244367275,
		3060149565,
		1994146192,
		31158534,
		2563907772,
		4023717930,
		1907459465,
		112637215,
		2680153253,
		3904427059,
		2013776290,
		251722036,
		2517215374,
		3775830040,
		2137656763,
		141376813,
		2439277719,
		3865271297,
		1802195444,
		476864866,
		2238001368,
		4066508878,
		1812370925,
		453092731,
		2181625025,
		4111451223,
		1706088902,
		314042704,
		2344532202,
		4240017532,
		1658658271,
		366619977,
		2362670323,
		4224994405,
		1303535960,
		984961486,
		2747007092,
		3569037538,
		1256170817,
		1037604311,
		2765210733,
		3554079995,
		1131014506,
		879679996,
		2909243462,
		3663771856,
		1141124467,
		855842277,
		2852801631,
		3708648649,
		1342533948,
		654459306,
		3188396048,
		3373015174,
		1466479909,
		544179635,
		3110523913,
		3462522015,
		1591671054,
		702138776,
		2966460450,
		3352799412,
		1504918807,
		783551873,
		3082640443,
		3233442989,
		3988292384,
		2596254646,
		62317068,
		1957810842,
		3939845945,
		2647816111,
		81470997,
		1943803523,
		3814918930,
		2489596804,
		225274430,
		2053790376,
		3826175755,
		2466906013,
		167816743,
		2097651377,
		4027552580,
		2265490386,
		503444072,
		1762050814,
		4150417245,
		2154129355,
		426522225,
		1852507879,
		4275313526,
		2312317920,
		282753626,
		1742555852,
		4189708143,
		2394877945,
		397917763,
		1622183637,
		3604390888,
		2714866558,
		953729732,
		1340076626,
		3518719985,
		2797360999,
		1068828381,
		1219638859,
		3624741850,
		2936675148,
		906185462,
		1090812512,
		3747672003,
		2825379669,
		829329135,
		1181335161,
		3412177804,
		3160834842,
		628085408,
		1382605366,
		3423369109,
		3138078467,
		570562233,
		1426400815,
		3317316542,
		2998733608,
		733239954,
		1555261956,
		3268935591,
		3050360625,
		752459403,
		1541320221,
		2607071920,
		3965973030,
		1969922972,
		40735498,
		2617837225,
		3943577151,
		1913087877,
		83908371,
		2512341634,
		3803740692,
		2075208622,
		213261112,
		2463272603,
		3855990285,
		2094854071,
		198958881,
		2262029012,
		4057260610,
		1759359992,
		534414190,
		2176718541,
		4139329115,
		1873836001,
		414664567,
		2282248934,
		4279200368,
		1711684554,
		285281116,
		2405801727,
		4167216745,
		1634467795,
		376229701,
		2685067896,
		3608007406,
		1308918612,
		956543938,
		2808555105,
		3495958263,
		1231636301,
		1047427035,
		2932959818,
		3654703836,
		1088359270,
		936918e3,
		2847714899,
		3736837829,
		1202900863,
		817233897,
		3183342108,
		3401237130,
		1404277552,
		615818150,
		3134207493,
		3453421203,
		1423857449,
		601450431,
		3009837614,
		3294710456,
		1567103746,
		711928724,
		3020668471,
		3272380065,
		1510334235,
		755167117
	]);
	function crc32(buf) {
		let crc = -1;
		for (let x of buf) crc = CRC_TABLE[(crc ^ x) & 255] ^ crc >>> 8;
		return (crc ^ -1) >>> 0;
	}
	module.exports = crc32;
}));
//#endregion
//#region src/providers/http/safe-zip.ts
var import_yauzl = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
	var fs = __require("fs");
	var zlib = __require("zlib");
	var fd_slicer = require_fd_slicer();
	var util = __require("util");
	var EventEmitter = __require("events").EventEmitter;
	var Transform$1 = __require("stream").Transform;
	var PassThrough = __require("stream").PassThrough;
	var Writable$1 = __require("stream").Writable;
	const crc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : require_crc32();
	exports.open = open;
	function open(path, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = null;
		}
		if (options == null) options = {};
		if (options.autoClose == null) options.autoClose = true;
		if (options.lazyEntries == null) options.lazyEntries = false;
		if (options.decodeStrings == null) options.decodeStrings = true;
		if (options.validateEntrySizes == null) options.validateEntrySizes = true;
		if (options.strictFileNames == null) options.strictFileNames = false;
		if (callback == null) callback = defaultCallback;
		fs.open(path, "r", function(err, fd) {
			if (err) return callback(err);
			fromFd(fd, options, function(err, zipfile) {
				if (err) fs.close(fd, defaultCallback);
				callback(err, zipfile);
			});
		});
	}
	function fromFd(fd, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = null;
		}
		if (options == null) options = {};
		if (options.autoClose == null) options.autoClose = false;
		if (options.lazyEntries == null) options.lazyEntries = false;
		if (options.decodeStrings == null) options.decodeStrings = true;
		if (options.validateEntrySizes == null) options.validateEntrySizes = true;
		if (options.strictFileNames == null) options.strictFileNames = false;
		if (callback == null) callback = defaultCallback;
		fs.fstat(fd, function(err, stats) {
			if (err) return callback(err);
			fromRandomAccessReader(new fd_slicer.FdSlicer(fd), stats.size, options, callback);
		});
	}
	function fromRandomAccessReader(reader, totalSize, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = null;
		}
		if (options == null) options = {};
		if (options.autoClose == null) options.autoClose = true;
		if (options.lazyEntries == null) options.lazyEntries = false;
		if (options.decodeStrings == null) options.decodeStrings = true;
		var decodeStrings = !!options.decodeStrings;
		if (options.validateEntrySizes == null) options.validateEntrySizes = true;
		if (options.strictFileNames == null) options.strictFileNames = false;
		if (callback == null) callback = defaultCallback;
		if (typeof totalSize !== "number") throw new Error("expected totalSize parameter to be a number");
		if (totalSize > Number.MAX_SAFE_INTEGER) throw new Error("zip file too large. only file sizes up to 2^52 are supported due to JavaScript's Number type being an IEEE 754 double.");
		reader.ref();
		var eocdrWithoutCommentSize = 22;
		var zip64EocdlSize = 20;
		var bufferSize = Math.min(zip64EocdlSize + eocdrWithoutCommentSize + 65535, totalSize);
		var buffer = newBuffer(bufferSize);
		readAndAssertNoEof(reader, buffer, 0, bufferSize, totalSize - buffer.length, function(err) {
			if (err) return callback(err);
			for (var i = bufferSize - eocdrWithoutCommentSize; i >= 0; i -= 1) {
				if (buffer.readUInt32LE(i) !== 101010256) continue;
				var eocdrBuffer = buffer.subarray(i);
				var diskNumber = eocdrBuffer.readUInt16LE(4);
				var entryCount = eocdrBuffer.readUInt16LE(10);
				var centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
				var commentLength = eocdrBuffer.readUInt16LE(20);
				var expectedCommentLength = eocdrBuffer.length - eocdrWithoutCommentSize;
				if (commentLength !== expectedCommentLength) return callback(/* @__PURE__ */ new Error("Invalid comment length. Expected: " + expectedCommentLength + ". Found: " + commentLength + ". Are there extra bytes at the end of the file? Or is the end of central dir signature `PK☺☻` in the comment?"));
				var comment = decodeStrings ? decodeBuffer(eocdrBuffer.subarray(22), false) : eocdrBuffer.subarray(22);
				if (i - zip64EocdlSize >= 0 && buffer.readUInt32LE(i - zip64EocdlSize) === 117853008) {
					var zip64EocdrOffset = readUInt64LE(buffer.subarray(i - zip64EocdlSize, i - zip64EocdlSize + zip64EocdlSize), 8);
					var zip64EocdrBuffer = newBuffer(56);
					return readAndAssertNoEof(reader, zip64EocdrBuffer, 0, zip64EocdrBuffer.length, zip64EocdrOffset, function(err) {
						if (err) return callback(err);
						if (zip64EocdrBuffer.readUInt32LE(0) !== 101075792) return callback(/* @__PURE__ */ new Error("invalid zip64 end of central directory record signature"));
						diskNumber = zip64EocdrBuffer.readUInt32LE(16);
						if (diskNumber !== 0) return callback(/* @__PURE__ */ new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
						entryCount = readUInt64LE(zip64EocdrBuffer, 32);
						centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
						return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.autoClose, options.lazyEntries, decodeStrings, options.validateEntrySizes, options.strictFileNames));
					});
				}
				if (diskNumber !== 0) return callback(/* @__PURE__ */ new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
				return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.autoClose, options.lazyEntries, decodeStrings, options.validateEntrySizes, options.strictFileNames));
			}
			callback(/* @__PURE__ */ new Error("End of central directory record signature not found. Either not a zip file, or file is truncated."));
		});
	}
	util.inherits(ZipFile, EventEmitter);
	function ZipFile(reader, centralDirectoryOffset, fileSize, entryCount, comment, autoClose, lazyEntries, decodeStrings, validateEntrySizes, strictFileNames) {
		var self = this;
		EventEmitter.call(self);
		self.reader = reader;
		self.reader.on("error", function(err) {
			emitError(self, err);
		});
		self.reader.once("close", function() {
			self.emit("close");
		});
		self.readEntryCursor = centralDirectoryOffset;
		self.fileSize = fileSize;
		self.entryCount = entryCount;
		self.comment = comment;
		self.entriesRead = 0;
		self.autoClose = !!autoClose;
		self.lazyEntries = !!lazyEntries;
		self.decodeStrings = !!decodeStrings;
		self.validateEntrySizes = !!validateEntrySizes;
		self.strictFileNames = !!strictFileNames;
		self.isOpen = true;
		self.emittedError = false;
		self.hasEachEntryBeenCalled = false;
		if (!self.lazyEntries) self._readEntry();
	}
	ZipFile.prototype.close = function() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.reader.unref();
	};
	function emitErrorAndAutoClose(self, err) {
		if (self.autoClose) self.close();
		emitError(self, err);
	}
	function emitError(self, err) {
		if (self.emittedError) return;
		self.emittedError = true;
		self.emit("error", err);
	}
	ZipFile.prototype.readEntry = function() {
		if (!this.lazyEntries) throw new Error("readEntry() called without lazyEntries:true");
		this._readEntry();
	};
	ZipFile.prototype._readEntry = function() {
		var self = this;
		if (self.entryCount === self.entriesRead) {
			setImmediate(function() {
				if (self.autoClose) self.close();
				if (self.emittedError) return;
				self.emit("end");
			});
			return;
		}
		if (self.emittedError) return;
		var buffer = newBuffer(46);
		readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err) {
			if (err) return emitErrorAndAutoClose(self, err);
			if (self.emittedError) return;
			var entry = new Entry();
			var signature = buffer.readUInt32LE(0);
			if (signature !== 33639248) return emitErrorAndAutoClose(self, /* @__PURE__ */ new Error("invalid central directory file header signature: 0x" + signature.toString(16)));
			entry.versionMadeBy = buffer.readUInt16LE(4);
			entry.versionNeededToExtract = buffer.readUInt16LE(6);
			entry.generalPurposeBitFlag = buffer.readUInt16LE(8);
			entry.compressionMethod = buffer.readUInt16LE(10);
			entry.lastModFileTime = buffer.readUInt16LE(12);
			entry.lastModFileDate = buffer.readUInt16LE(14);
			entry.crc32 = buffer.readUInt32LE(16);
			entry.compressedSize = buffer.readUInt32LE(20);
			entry.uncompressedSize = buffer.readUInt32LE(24);
			entry.fileNameLength = buffer.readUInt16LE(28);
			entry.extraFieldLength = buffer.readUInt16LE(30);
			entry.fileCommentLength = buffer.readUInt16LE(32);
			entry.internalFileAttributes = buffer.readUInt16LE(36);
			entry.externalFileAttributes = buffer.readUInt32LE(38);
			entry.relativeOffsetOfLocalHeader = buffer.readUInt32LE(42);
			if (entry.generalPurposeBitFlag & 64) return emitErrorAndAutoClose(self, /* @__PURE__ */ new Error("strong encryption is not supported"));
			self.readEntryCursor += 46;
			buffer = newBuffer(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);
			readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err) {
				if (err) return emitErrorAndAutoClose(self, err);
				if (self.emittedError) return;
				entry.fileNameRaw = buffer.subarray(0, entry.fileNameLength);
				var fileCommentStart = entry.fileNameLength + entry.extraFieldLength;
				entry.extraFieldRaw = buffer.subarray(entry.fileNameLength, fileCommentStart);
				entry.fileCommentRaw = buffer.subarray(fileCommentStart, fileCommentStart + entry.fileCommentLength);
				try {
					entry.extraFields = parseExtraFields(entry.extraFieldRaw);
				} catch (err) {
					return emitErrorAndAutoClose(self, err);
				}
				if (self.decodeStrings) {
					var isUtf8 = (entry.generalPurposeBitFlag & 2048) !== 0;
					entry.fileComment = decodeBuffer(entry.fileCommentRaw, isUtf8);
					entry.fileName = getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, self.strictFileNames);
					var errorMessage = validateFileName(entry.fileName);
					if (errorMessage != null) return emitErrorAndAutoClose(self, new Error(errorMessage));
				} else {
					entry.fileComment = entry.fileCommentRaw;
					entry.fileName = entry.fileNameRaw;
				}
				entry.comment = entry.fileComment;
				self.readEntryCursor += buffer.length;
				self.entriesRead += 1;
				for (var i = 0; i < entry.extraFields.length; i++) {
					var extraField = entry.extraFields[i];
					if (extraField.id !== 1) continue;
					var zip64EiefBuffer = extraField.data;
					var index = 0;
					if (entry.uncompressedSize === 4294967295) {
						if (index + 8 > zip64EiefBuffer.length) return emitErrorAndAutoClose(self, /* @__PURE__ */ new Error("zip64 extended information extra field does not include uncompressed size"));
						entry.uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
						index += 8;
					}
					if (entry.compressedSize === 4294967295) {
						if (index + 8 > zip64EiefBuffer.length) return emitErrorAndAutoClose(self, /* @__PURE__ */ new Error("zip64 extended information extra field does not include compressed size"));
						entry.compressedSize = readUInt64LE(zip64EiefBuffer, index);
						index += 8;
					}
					if (entry.relativeOffsetOfLocalHeader === 4294967295) {
						if (index + 8 > zip64EiefBuffer.length) return emitErrorAndAutoClose(self, /* @__PURE__ */ new Error("zip64 extended information extra field does not include relative header offset"));
						entry.relativeOffsetOfLocalHeader = readUInt64LE(zip64EiefBuffer, index);
						index += 8;
					}
					break;
				}
				if (self.validateEntrySizes && entry.compressionMethod === 0) {
					var expectedCompressedSize = entry.uncompressedSize;
					if (entry.isEncrypted()) expectedCompressedSize += 12;
					if (entry.compressedSize !== expectedCompressedSize) {
						var msg = "compressed/uncompressed size mismatch for stored file: " + entry.compressedSize + " != " + entry.uncompressedSize;
						return emitErrorAndAutoClose(self, new Error(msg));
					}
				}
				self.emit("entry", entry);
				if (!self.lazyEntries) self._readEntry();
			});
		});
	};
	ZipFile.prototype.eachEntry = function() {
		const self = this;
		if (!self.lazyEntries) throw new Error("eachEntry() requires lazyEntries: true");
		if (self.hasEachEntryBeenCalled) throw new Error("eachEntry() must only be called once per ZipFile");
		self.hasEachEntryBeenCalled = true;
		let pendingResolveReject = null;
		self.on("entry", onEntry);
		self.on("end", onEnd);
		self.on("error", onError);
		function cleanup() {
			self.removeListener("entry", onEntry);
			self.removeListener("end", onEnd);
			self.removeListener("error", onError);
			if (self.autoClose) self.close();
		}
		function onEntry(entry) {
			let { resolve } = pendingResolveReject;
			pendingResolveReject = null;
			resolve({ value: entry });
		}
		function onEnd() {
			let { resolve } = pendingResolveReject;
			pendingResolveReject = null;
			cleanup();
			resolve({ done: true });
		}
		function onError(err) {
			let { reject } = pendingResolveReject;
			pendingResolveReject = null;
			cleanup();
			reject(err);
		}
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				const promise = new Promise((resolve, reject) => {
					if (pendingResolveReject != null) throw new Error("next() called before previous Promise was resolved.");
					pendingResolveReject = {
						resolve,
						reject
					};
				});
				self.readEntry();
				return promise;
			},
			return(value) {
				cleanup();
				return Promise.resolve({
					done: true,
					value
				});
			},
			throw(value) {
				cleanup();
				return Promise.reject(value);
			}
		};
	};
	ZipFile.prototype.openReadStream = function(entry, options, callback) {
		var self = this;
		var relativeStart = 0;
		var relativeEnd = entry.compressedSize;
		if (callback == null) {
			callback = options;
			options = null;
		}
		if (options == null) options = {};
		else {
			if (options.decodeFileData === false) {
				if (options.decrypt != null) throw new Error("cannot use options.decrypt when options.decodeFileData === false");
				if (options.decompress != null) throw new Error("cannot use options.decompress when options.decodeFileData === false");
			} else {
				if (options.decrypt != null) {
					if (!entry.isEncrypted()) throw new Error("options.decrypt can only be specified for encrypted entries. See also option decodeFileData.");
					if (options.decrypt !== false) throw new Error("invalid options.decrypt value: " + options.decrypt);
					if (entry.isCompressed()) {
						if (options.decompress !== false) throw new Error("entry is encrypted and compressed, and options.decompress !== false. See also option decodeFileData.");
					}
				}
				if (options.decompress != null) {
					if (!entry.isCompressed()) throw new Error("options.decompress can only be specified for compressed entries. See also option decodeFileData.");
					if (!(options.decompress === false || options.decompress === true)) throw new Error("invalid options.decompress value: " + options.decompress);
					decompress = options.decompress;
				}
			}
			if (options.start != null) {
				relativeStart = options.start;
				if (relativeStart < 0) throw new Error("options.start < 0");
				if (relativeStart > entry.compressedSize) throw new Error("options.start > entry.compressedSize");
			}
			if (options.end != null) {
				relativeEnd = options.end;
				if (relativeEnd < 0) throw new Error("options.end < 0");
				if (relativeEnd > entry.compressedSize) throw new Error("options.end > entry.compressedSize");
				if (relativeEnd < relativeStart) throw new Error("options.end < options.start");
			}
		}
		var rawMode = options.decodeFileData === false || (entry.compressionMethod === 0 || entry.compressionMethod === 8 && options.decompress === false) && (!entry.isEncrypted() || options.decrypt === false);
		if (options.start != null || options.end != null) {
			if (!rawMode) throw new Error("start/end range require options.decodeFileData === false for non-trivial encoded entries.");
		}
		if (!self.isOpen) return callback(/* @__PURE__ */ new Error("closed"));
		if (entry.isEncrypted() && !rawMode) {
			if (options.decrypt !== false) return callback(/* @__PURE__ */ new Error("entry is encrypted, and options.decodeFileData !== false"));
		}
		var decompress;
		if (rawMode) decompress = false;
		else if (entry.compressionMethod === 8) decompress = options.decodeFileData !== true;
		else return callback(/* @__PURE__ */ new Error("unsupported compression method: " + entry.compressionMethod));
		self.readLocalFileHeader(entry, { minimal: true }, function(err, localFileHeader) {
			if (err) return callback(err);
			self.openReadStreamLowLevel(localFileHeader.fileDataStart, entry.compressedSize, relativeStart, relativeEnd, decompress, entry.uncompressedSize, callback);
		});
	};
	ZipFile.prototype.openReadStreamLowLevel = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, callback) {
		var self = this;
		fileDataStart + compressedSize;
		var readStream = self.reader.createReadStream({
			start: fileDataStart + relativeStart,
			end: fileDataStart + relativeEnd
		});
		var endpointStream = readStream;
		if (decompress) {
			var destroyed = false;
			var inflateFilter = zlib.createInflateRaw();
			readStream.on("error", function(err) {
				setImmediate(function() {
					if (!destroyed) inflateFilter.emit("error", err);
				});
			});
			readStream.pipe(inflateFilter);
			if (self.validateEntrySizes) {
				endpointStream = new AssertByteCountStream(uncompressedSize);
				inflateFilter.on("error", function(err) {
					setImmediate(function() {
						if (!destroyed) endpointStream.emit("error", err);
					});
				});
				inflateFilter.pipe(endpointStream);
			} else endpointStream = inflateFilter;
			installDestroyFn(endpointStream, function() {
				destroyed = true;
				if (inflateFilter !== endpointStream) inflateFilter.unpipe(endpointStream);
				readStream.unpipe(inflateFilter);
				readStream.destroy();
			});
		}
		callback(null, endpointStream);
	};
	ZipFile.prototype.readLocalFileHeader = function(entry, options, callback) {
		var self = this;
		if (callback == null) {
			callback = options;
			options = null;
		}
		if (options == null) options = {};
		self.reader.ref();
		var buffer = newBuffer(30);
		readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader, function(err) {
			try {
				if (err) return callback(err);
				var signature = buffer.readUInt32LE(0);
				if (signature !== 67324752) return callback(/* @__PURE__ */ new Error("invalid local file header signature: 0x" + signature.toString(16)));
				var fileNameLength = buffer.readUInt16LE(26);
				var extraFieldLength = buffer.readUInt16LE(28);
				var fileDataStart = entry.relativeOffsetOfLocalHeader + 30 + fileNameLength + extraFieldLength;
				if (fileDataStart + entry.compressedSize > self.fileSize) return callback(/* @__PURE__ */ new Error("file data overflows file bounds: " + fileDataStart + " + " + entry.compressedSize + " > " + self.fileSize));
				if (options.minimal) return callback(null, { fileDataStart });
				var localFileHeader = new LocalFileHeader();
				localFileHeader.fileDataStart = fileDataStart;
				localFileHeader.versionNeededToExtract = buffer.readUInt16LE(4);
				localFileHeader.generalPurposeBitFlag = buffer.readUInt16LE(6);
				localFileHeader.compressionMethod = buffer.readUInt16LE(8);
				localFileHeader.lastModFileTime = buffer.readUInt16LE(10);
				localFileHeader.lastModFileDate = buffer.readUInt16LE(12);
				localFileHeader.crc32 = buffer.readUInt32LE(14);
				localFileHeader.compressedSize = buffer.readUInt32LE(18);
				localFileHeader.uncompressedSize = buffer.readUInt32LE(22);
				localFileHeader.fileNameLength = fileNameLength;
				localFileHeader.extraFieldLength = extraFieldLength;
				buffer = newBuffer(fileNameLength + extraFieldLength);
				self.reader.ref();
				readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader + 30, function(err) {
					try {
						if (err) return callback(err);
						localFileHeader.fileName = buffer.subarray(0, fileNameLength);
						localFileHeader.extraField = buffer.subarray(fileNameLength);
						return callback(null, localFileHeader);
					} finally {
						self.reader.unref();
					}
				});
			} finally {
				self.reader.unref();
			}
		});
	};
	ZipFile.prototype.openReadStreamPromise = function(entry, options) {
		return new Promise((resolve, reject) => {
			this.openReadStream(entry, options, function(err, readStream) {
				if (err) return reject(err);
				resolve(readStream);
			});
		});
	};
	ZipFile.prototype.openReadStreamLowLevelPromise = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize) {
		return new Promise((resolve, reject) => {
			this.openReadStream(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, function(err, readStream) {
				if (err) return reject(err);
				resolve(readStream);
			});
		});
	};
	ZipFile.prototype.readLocalFileHeaderPromise = function(entry, options) {
		return new Promise((resolve, reject) => {
			this.readLocalFileHeader(entry, options, function(err, localFileHeader) {
				if (err) return reject(err);
				resolve(localFileHeader);
			});
		});
	};
	function Entry() {}
	Entry.prototype.getLastModDate = function(options) {
		if (options == null) options = {};
		if (!options.forceDosFormat) for (var i = 0; i < this.extraFields.length; i++) {
			var extraField = this.extraFields[i];
			if (extraField.id === 21589) {
				var data = extraField.data;
				if (data.length < 5) continue;
				if (!(data[0] & 1)) continue;
				var posixTimestamp = data.readInt32LE(1);
				return /* @__PURE__ */ new Date(posixTimestamp * 1e3);
			} else if (extraField.id === 10) {
				var data = extraField.data;
				if (data.length !== 32) continue;
				if (data.readUInt16LE(4) !== 1) continue;
				if (data.readUInt16LE(6) !== 24) continue;
				var millisecondsSince1970 = (data.readUInt32LE(8) + 4294967296 * data.readInt32LE(12)) / 1e4 - 0xa9730b66800;
				return new Date(millisecondsSince1970);
			}
		}
		return dosDateTimeToDate(this.lastModFileDate, this.lastModFileTime, options.timezone);
	};
	Entry.prototype.canDecodeFileData = function() {
		return !this.isEncrypted() && (this.compressionMethod === 0 || this.compressionMethod === 8);
	};
	Entry.prototype.isEncrypted = function() {
		return (this.generalPurposeBitFlag & 1) !== 0;
	};
	Entry.prototype.isCompressed = function() {
		return this.compressionMethod === 8;
	};
	function LocalFileHeader() {}
	function dosDateTimeToDate(date, time, timezone) {
		var day = date & 31;
		var month = (date >> 5 & 15) - 1;
		var year = (date >> 9 & 127) + 1980;
		var millisecond = 0;
		var second = (time & 31) * 2;
		var minute = time >> 5 & 63;
		var hour = time >> 11 & 31;
		if (timezone == null || timezone === "local") return new Date(year, month, day, hour, minute, second, millisecond);
		else if (timezone === "UTC") return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
		else throw new Error("unrecognized options.timezone: " + options.timezone);
	}
	function getFileNameLowLevel(generalPurposeBitFlag, fileNameBuffer, extraFields, strictFileNames) {
		var fileName = null;
		for (var i = 0; i < extraFields.length; i++) {
			var extraField = extraFields[i];
			if (extraField.id === 28789) {
				if (extraField.data.length < 6) continue;
				if (extraField.data.readUInt8(0) !== 1) continue;
				var oldNameCrc32 = extraField.data.readUInt32LE(1);
				if (crc32(fileNameBuffer) !== oldNameCrc32) continue;
				fileName = decodeBuffer(extraField.data.subarray(5), true);
				break;
			}
		}
		if (fileName == null) fileName = decodeBuffer(fileNameBuffer, (generalPurposeBitFlag & 2048) !== 0);
		if (!strictFileNames) fileName = fileName.replace(/\\/g, "/");
		return fileName;
	}
	function validateFileName(fileName) {
		if (fileName.indexOf("\\") !== -1) return "invalid characters in fileName: " + fileName;
		if (/^[a-zA-Z]:/.test(fileName) || /^\//.test(fileName)) return "absolute path: " + fileName;
		if (fileName.split("/").indexOf("..") !== -1) return "invalid relative path: " + fileName;
		return null;
	}
	function parseExtraFields(extraFieldBuffer) {
		var extraFields = [];
		var i = 0;
		while (i < extraFieldBuffer.length - 3) {
			var headerId = extraFieldBuffer.readUInt16LE(i + 0);
			var dataSize = extraFieldBuffer.readUInt16LE(i + 2);
			var dataStart = i + 4;
			var dataEnd = dataStart + dataSize;
			if (dataEnd > extraFieldBuffer.length) throw new Error("extra field length exceeds extra field buffer size");
			var dataBuffer = extraFieldBuffer.subarray(dataStart, dataEnd);
			extraFields.push({
				id: headerId,
				data: dataBuffer
			});
			i = dataEnd;
		}
		return extraFields;
	}
	function readAndAssertNoEof(reader, buffer, offset, length, position, callback) {
		if (length === 0) return setImmediate(function() {
			callback(null, newBuffer(0));
		});
		reader.read(buffer, offset, length, position, function(err, bytesRead) {
			if (err) return callback(err);
			if (bytesRead < length) return callback(/* @__PURE__ */ new Error("unexpected EOF"));
			callback();
		});
	}
	util.inherits(AssertByteCountStream, Transform$1);
	function AssertByteCountStream(byteCount) {
		Transform$1.call(this);
		this.actualByteCount = 0;
		this.expectedByteCount = byteCount;
	}
	AssertByteCountStream.prototype._transform = function(chunk, encoding, cb) {
		this.actualByteCount += chunk.length;
		if (this.actualByteCount > this.expectedByteCount) {
			var msg = "too many bytes in the stream. expected " + this.expectedByteCount + ". got at least " + this.actualByteCount;
			return cb(new Error(msg));
		}
		cb(null, chunk);
	};
	AssertByteCountStream.prototype._flush = function(cb) {
		if (this.actualByteCount < this.expectedByteCount) {
			var msg = "not enough bytes in the stream. expected " + this.expectedByteCount + ". got only " + this.actualByteCount;
			return cb(new Error(msg));
		}
		cb();
	};
	util.inherits(RandomAccessReader, EventEmitter);
	function RandomAccessReader() {
		EventEmitter.call(this);
		this.refCount = 0;
	}
	RandomAccessReader.prototype.ref = function() {
		this.refCount += 1;
	};
	RandomAccessReader.prototype.unref = function() {
		var self = this;
		self.refCount -= 1;
		if (self.refCount > 0) return;
		if (self.refCount < 0) throw new Error("invalid unref");
		self.close(onCloseDone);
		function onCloseDone(err) {
			if (err) return self.emit("error", err);
			self.emit("close");
		}
	};
	RandomAccessReader.prototype.createReadStream = function(options) {
		if (options == null) options = {};
		var start = options.start;
		var end = options.end;
		if (start === end) {
			var emptyStream = new PassThrough();
			setImmediate(function() {
				emptyStream.end();
			});
			return emptyStream;
		}
		var stream = this._readStreamForRange(start, end);
		var destroyed = false;
		var refUnrefFilter = new RefUnrefFilter(this);
		stream.on("error", function(err) {
			setImmediate(function() {
				if (!destroyed) refUnrefFilter.emit("error", err);
			});
		});
		installDestroyFn(refUnrefFilter, function() {
			stream.unpipe(refUnrefFilter);
			refUnrefFilter.unref();
			stream.destroy();
		});
		var byteCounter = new AssertByteCountStream(end - start);
		refUnrefFilter.on("error", function(err) {
			setImmediate(function() {
				if (!destroyed) byteCounter.emit("error", err);
			});
		});
		installDestroyFn(byteCounter, function() {
			destroyed = true;
			refUnrefFilter.unpipe(byteCounter);
			refUnrefFilter.destroy();
		});
		return stream.pipe(refUnrefFilter).pipe(byteCounter);
	};
	RandomAccessReader.prototype._readStreamForRange = function(start, end) {
		throw new Error("not implemented");
	};
	RandomAccessReader.prototype.read = function(buffer, offset, length, position, callback) {
		var readStream = this.createReadStream({
			start: position,
			end: position + length
		});
		var writeStream = new Writable$1();
		var written = 0;
		writeStream._write = function(chunk, encoding, cb) {
			chunk.copy(buffer, offset + written, 0, chunk.length);
			written += chunk.length;
			cb();
		};
		writeStream.on("finish", callback);
		readStream.on("error", function(error) {
			callback(error);
		});
		readStream.pipe(writeStream);
	};
	RandomAccessReader.prototype.close = function(callback) {
		setImmediate(callback);
	};
	util.inherits(RefUnrefFilter, PassThrough);
	function RefUnrefFilter(context) {
		PassThrough.call(this);
		this.context = context;
		this.context.ref();
		this.unreffedYet = false;
	}
	RefUnrefFilter.prototype._flush = function(cb) {
		this.unref();
		cb();
	};
	RefUnrefFilter.prototype.unref = function(cb) {
		if (this.unreffedYet) return;
		this.unreffedYet = true;
		this.context.unref();
	};
	var cp437 = "\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xA0";
	function decodeBuffer(buffer, isUtf8) {
		if (isUtf8) return buffer.toString("utf8");
		else {
			var result = "";
			for (var i = 0; i < buffer.length; i++) result += cp437[buffer[i]];
			return result;
		}
	}
	function readUInt64LE(buffer, offset) {
		var lower32 = buffer.readUInt32LE(offset);
		return buffer.readUInt32LE(offset + 4) * 4294967296 + lower32;
	}
	var newBuffer;
	if (typeof Buffer.allocUnsafe === "function") newBuffer = function(len) {
		return Buffer.allocUnsafe(len);
	};
	else newBuffer = function(len) {
		return new Buffer(len);
	};
	function installDestroyFn(stream, fn) {
		if (typeof stream.destroy === "function") stream._destroy = function(err, cb) {
			fn();
			if (cb != null) cb(err);
		};
		else stream.destroy = fn;
	}
	function defaultCallback(err) {
		if (err) throw err;
	}
})))(), 1);
const MAX_JSON_VALIDATION_BYTES = 67108864;
const IMAGE_MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".tif": "image/tiff",
	".tiff": "image/tiff"
};
function archiveError(message) {
	return new MinerUError(failure("RESULT_ARCHIVE_INVALID", message));
}
function assertNotAborted(signal, action) {
	if (signal.aborted) throw new MinerUError(failure("CANCELLED", `${action} was cancelled`, true));
}
function validateEntrySecurity(entry, limits) {
	if (entry.isEncrypted()) throw archiveError("Encrypted ZIP entries are not supported");
	const type = entry.externalFileAttributes >> 16 & 61440;
	const directory = entry.fileName.endsWith("/");
	if (type === 40960) throw archiveError("Symbolic links inside ZIP archives are prohibited");
	if (type !== 0 && type !== 32768 && !(directory && type === 16384)) throw archiveError("Non-regular ZIP entries are prohibited");
	const name = entry.fileName;
	const raw = entry.fileNameRaw;
	if (name.includes("\0") || raw?.includes(0)) throw archiveError("Entry path contains NUL byte");
	if (name.includes("\\") || raw?.includes(92)) throw archiveError("Entry path contains backslash separator");
	if (/^[A-Za-z]:/.test(name)) throw archiveError("Entry path contains Windows drive prefix");
	if (name.startsWith("/") || name.startsWith("./") || name.startsWith("../")) throw archiveError("Entry path is absolute or begins with traversal prefix");
	for (const segment of name.split("/")) if (segment === "." || segment === "..") throw archiveError("Entry path contains traversal segment");
	if (entry.uncompressedSize > limits.maxZipEntryBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", `ZIP entry ${name} exceeds the entry byte limit`));
	if (entry.uncompressedSize > 0 && entry.compressedSize === 0) throw archiveError(`ZIP entry ${name} has an invalid zero compressed size`);
	if (entry.uncompressedSize > 65536 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxZipCompressionRatio) throw archiveError(`ZIP entry ${name} exceeds the compression ratio limit`);
}
function openZip(path) {
	return new Promise((resolve, reject) => {
		import_yauzl.open(path, {
			lazyEntries: true,
			autoClose: false,
			decodeStrings: true,
			strictFileNames: false,
			validateEntrySizes: true
		}, (error, zip) => {
			if (error !== null || zip === void 0) reject(new MinerUError(failure("RESULT_ARCHIVE_INVALID", `Failed to open ZIP: ${error?.message ?? "unknown error"}`), { cause: error ?? void 0 }));
			else resolve(zip);
		});
	});
}
function scanZip(path, limits, signal) {
	assertNotAborted(signal, "ZIP scan");
	return openZip(path).then((zip) => new Promise((resolve, reject) => {
		const entries = [];
		let declaredTotal = 0;
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			try {
				zip.close();
			} catch {}
			if (error === void 0) resolve(entries);
			else reject(error);
		};
		const onAbort = () => finish(new MinerUError(failure("CANCELLED", "ZIP scan was cancelled", true)));
		signal.addEventListener("abort", onAbort, { once: true });
		zip.on("entry", (entry) => {
			if (settled) return;
			try {
				if (entries.length + 1 > limits.maxZipEntries) throw archiveError("ZIP entries count exceeds configured limit");
				validateEntrySecurity(entry, limits);
				declaredTotal += entry.uncompressedSize;
				if (declaredTotal > limits.maxZipTotalBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", "ZIP declared uncompressed total exceeds configured limit"));
				entries.push({
					fileName: entry.fileName,
					directory: entry.fileName.endsWith("/"),
					compressedBytes: entry.compressedSize,
					uncompressedBytes: entry.uncompressedSize
				});
				zip.readEntry();
			} catch (error) {
				finish(error);
			}
		});
		zip.once("end", () => finish());
		zip.once("error", (error) => finish(archiveError(`ZIP parsing error: ${error.message}`)));
		zip.readEntry();
	}));
}
function classify(subpath) {
	const normalized = posix.normalize(subpath);
	const base = posix.basename(normalized).toLowerCase();
	if (normalized.startsWith("images/")) {
		const extension = extname(base).toLowerCase();
		const mediaType = IMAGE_MIME[extension];
		if (mediaType === void 0) return void 0;
		return {
			kind: "images",
			relativeName: `images/${normalized.slice(7).replaceAll("/", "_").replace(/[^A-Za-z0-9_.-]/g, "_") || "image.bin"}`,
			mediaType,
			json: false
		};
	}
	if (base === "full.md" || base === "markdown.md") return {
		kind: "markdown",
		relativeName: "full.md",
		mediaType: "text/markdown; charset=utf-8",
		json: false
	};
	if (base === "layout.json" || base === "middle.json" || base === "middle_json.json" || base.endsWith("_layout.json")) return {
		kind: "layout",
		relativeName: "layout.json",
		mediaType: "application/json",
		json: true
	};
	if (base === "content_list.json" || base === "structured_content.json" || base.endsWith("_content_list.json")) return {
		kind: "content-list",
		relativeName: "content_list.json",
		mediaType: "application/json",
		json: true
	};
	if (base === "model.json" || base === "model_output.json" || base.endsWith("_model.json")) return {
		kind: "model-output",
		relativeName: "model.json",
		mediaType: "application/json",
		json: true
	};
}
function structuredArchive(entries, files) {
	const prefixes = new Set(files.flatMap((file) => [file.dataId, String(file.fileId)]));
	return entries.some((entry) => prefixes.has(entry.fileName.split("/")[0] ?? ""));
}
function targetsForEntry(name, files, structured) {
	if (structured) {
		const slash = name.indexOf("/");
		if (slash <= 0) return [];
		const prefix = name.slice(0, slash);
		const file = files.find((candidate) => candidate.dataId === prefix || candidate.fileId === prefix);
		return file === void 0 ? [] : [{
			file,
			subpath: name.slice(slash + 1)
		}];
	}
	if (name.includes("/") && !name.startsWith("images/")) return [];
	return files.map((file) => ({
		file,
		subpath: name
	}));
}
function assertUniqueArtifactOutputs(entries, files, requiredArtifacts) {
	const structured = structuredArchive(entries, files);
	const outputs = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (entry.directory) continue;
		for (const target of targetsForEntry(entry.fileName, files, structured)) {
			const classification = classify(target.subpath);
			if (classification === void 0 || !requiredArtifacts.includes(classification.kind)) continue;
			const key = `${target.file.fileId}:${classification.relativeName}`;
			if (outputs.has(key)) throw archiveError(`ZIP entries collide on normalized artifact ${classification.relativeName}`);
			outputs.add(key);
		}
	}
}
function openEntryStream(zip, entry) {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error !== null || stream === void 0) reject(archiveError(`Failed to read ZIP entry ${entry.fileName}`));
			else resolve(stream);
		});
	});
}
function extractionTracker(entry, limits, totals) {
	let entryBytes = 0;
	return new Transform({ transform(chunk, _encoding, callback) {
		entryBytes += chunk.byteLength;
		totals.bytes += chunk.byteLength;
		if (entryBytes > limits.maxZipEntryBytes) return callback(new MinerUError(failure("RESULT_TOO_LARGE", "ZIP entry exceeded actual byte limit")));
		if (totals.bytes > limits.maxZipTotalBytes) return callback(new MinerUError(failure("RESULT_TOO_LARGE", "ZIP actual uncompressed total exceeded limit")));
		if (entry.compressedSize > 0 && entryBytes > 65536 && entryBytes / entry.compressedSize > limits.maxZipCompressionRatio) return callback(archiveError("ZIP entry exceeded streaming compression ratio limit"));
		callback(null, chunk);
	} });
}
async function validateJsonFile(path, maxBytes = MAX_JSON_VALIDATION_BYTES, signal) {
	signal?.throwIfAborted();
	if ((await stat(path)).size > maxBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", "JSON ZIP artifact exceeds validation limit"));
	signal?.throwIfAborted();
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw error;
	}
	signal?.throwIfAborted();
	try {
		JSON.parse(content);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new MinerUError(failure("RESULT_ARCHIVE_INVALID", "Invalid JSON artifact in archive"), { cause: error });
	}
}
async function consumeZip(options, metadata, onArtifact) {
	const zip = await openZip(options.zipPath);
	const totals = { bytes: 0 };
	const structured = structuredArchive(metadata, options.files);
	let index = 0;
	await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			options.signal.removeEventListener("abort", onAbort);
			try {
				zip.close();
			} catch {}
			if (error === void 0) resolve();
			else reject(error);
		};
		const onAbort = () => finish(new MinerUError(failure("CANCELLED", "ZIP extraction was cancelled", true)));
		options.signal.addEventListener("abort", onAbort, { once: true });
		zip.on("entry", (entry) => {
			if (settled) return;
			const currentIndex = index++;
			(async () => {
				validateEntrySecurity(entry, options.limits);
				if (entry.fileName.endsWith("/")) return;
				const classified = targetsForEntry(entry.fileName, options.files, structured).map((target) => ({
					target,
					classification: classify(target.subpath)
				})).filter((item) => item.classification !== void 0).filter((item) => options.requiredArtifacts.includes(item.classification.kind));
				const input = await openEntryStream(zip, entry);
				const tracker = extractionTracker(entry, options.limits, totals);
				if (classified.length === 0) {
					await pipeline(input, tracker, new Writable({ write(_chunk, _encoding, callback) {
						callback();
					} }), { signal: options.signal });
					return;
				}
				const tempPath = join(dirname(options.zipPath), `.entry_${String(currentIndex)}_${randomUUID().replaceAll("-", "")}`);
				try {
					await pipeline(input, tracker, createWriteStream(tempPath, {
						flags: "wx",
						mode: 384
					}), { signal: options.signal });
					if (classified.some((item) => item.classification.json)) await validateJsonFile(tempPath, MAX_JSON_VALIDATION_BYTES, options.signal);
					for (const item of classified) await onArtifact(item.target, item.classification, tempPath);
				} finally {
					await rm(tempPath, { force: true });
				}
			})().then(() => {
				if (!settled) zip.readEntry();
			}, finish);
		});
		zip.once("end", () => finish());
		zip.once("error", (error) => finish(archiveError(`ZIP extraction error: ${error.message}`)));
		zip.readEntry();
	});
}
async function extractSafeZip(options) {
	assertNotAborted(options.signal, "ZIP extraction");
	const metadata = await scanZip(options.zipPath, options.limits, options.signal);
	assertUniqueArtifactOutputs(metadata, options.files, options.requiredArtifacts);
	const artifacts = /* @__PURE__ */ new Map();
	const kinds = /* @__PURE__ */ new Map();
	for (const file of options.files) {
		artifacts.set(file.fileId, []);
		kinds.set(file.fileId, /* @__PURE__ */ new Set());
	}
	await consumeZip(options, metadata, async (target, classification, tempPath) => {
		const ref = await options.sink.writeArtifact(target.file.fileId, classification.kind, createReadStream(tempPath), {
			mediaType: classification.mediaType,
			relativeName: classification.relativeName,
			maxBytes: options.limits.maxZipEntryBytes
		});
		artifacts.get(target.file.fileId)?.push(ref);
		kinds.get(target.file.fileId)?.add(classification.kind);
	});
	const results = [];
	for (const file of options.files) {
		options.signal.throwIfAborted();
		const fileArtifacts = artifacts.get(file.fileId) ?? [];
		const fileKinds = kinds.get(file.fileId) ?? /* @__PURE__ */ new Set();
		if (options.requiredArtifacts.includes("images") && !fileKinds.has("images")) {
			fileArtifacts.push(await options.sink.writeArtifact(file.fileId, "images", JSON.stringify({ images: [] }), {
				mediaType: "application/json",
				relativeName: "images/index.json",
				maxBytes: options.limits.maxZipEntryBytes
			}));
			fileKinds.add("images");
		}
		const missing = options.requiredArtifacts.filter((kind) => !fileKinds.has(kind));
		results.push({
			fileId: file.fileId,
			name: file.name,
			artifacts: fileArtifacts,
			...missing.length === 0 ? {} : { failure: failure("REMOTE_PARSE_FAILED", `ZIP is missing required artifacts: ${missing.join(", ")}`, false, {
				provider: "official-v4",
				fileId: file.fileId
			}) }
		});
	}
	return results;
}
/** Upper bound for reading the error body of a failed result download. */
const DOWNLOAD_ERROR_BODY_BYTES = 2048;
/**
* Per-file failure carrying the upstream V1 error code and message. A job failed by a latched engine
* (`engine_dead`) or lost by a Router worker (`upstream_job_lost`) is told apart from a document the
* engine could not parse (`parse_failed`).
*/
function remoteFileFailure(jobFile, fileId, credential) {
	const secrets = [credential ?? ""];
	const detail = describeV1Error(jobFile.error, "Remote document extraction failed");
	const providerCode = safeProviderCode(detail?.code, secrets);
	return failure("REMOTE_PARSE_FAILED", sanitizeDiagnostic(detail?.message ?? "Remote document extraction failed", secrets), false, {
		provider: "self-hosted-v1",
		fileId,
		...providerCode === void 0 ? {} : { providerCode }
	});
}
function archiveInvalid(message, fileId) {
	return new MinerUError(failure("REMOTE_PARSE_FAILED", message, false, {
		provider: "self-hosted-v1",
		...fileId === void 0 ? {} : { fileId }
	}));
}
/**
* Maps a MinerU V1 job status to the plugin's aggregate job state.
* `canceled` has no dedicated plugin state and is reported as a failed job.
*/
function mapSelfHostedV1JobState(rawStatus) {
	if (typeof rawStatus !== "string") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Missing job status from MinerU server response", false, { provider: "self-hosted-v1" }));
	switch (rawStatus.toLowerCase()) {
		case "queued":
		case "pending": return "queued";
		case "running":
		case "processing": return "processing";
		case "completed": return "completed";
		case "partial": return "partially-completed";
		case "failed":
		case "canceled":
		case "cancelled": return "failed";
		default: throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Unknown remote job status: "${rawStatus}"`, false, { provider: "self-hosted-v1" }));
	}
}
/** Best-effort job state used where an unrecognized status must not fail the whole snapshot. */
function optionalSelfHostedV1JobState(rawStatus) {
	try {
		return mapSelfHostedV1JobState(rawStatus);
	} catch {
		return;
	}
}
/** Maps a MinerU V1 per-file status to the plugin's file state. */
function mapSelfHostedV1FileState(rawStatus) {
	if (typeof rawStatus !== "string") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Missing file status from MinerU server response", false, { provider: "self-hosted-v1" }));
	switch (rawStatus.toLowerCase()) {
		case "queued":
		case "pending": return "queued";
		case "running":
		case "processing": return "processing";
		case "completed": return "completed";
		case "failed":
		case "canceled":
		case "cancelled": return "failed";
		default: throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Unknown remote file status: "${rawStatus}"`, false, { provider: "self-hosted-v1" }));
	}
}
/**
* Matches a submitted file to its upstream job entry. The V1 API echoes job files in
* submission order, so the positional entry wins when its name agrees; otherwise a
* unique name match is used.
*/
function matchV1JobFile(jobFiles, file, index) {
	const positional = jobFiles[index];
	if (positional !== void 0 && (typeof positional.name !== "string" || positional.name === file.name)) return positional;
	const named = jobFiles.filter((candidate) => candidate.name === file.name);
	return named.length === 1 ? named[0] : void 0;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/**
* Positive shape check for the MinerU 4.x health document. The V1 schema always carries a
* `version` and never the legacy `protocol_version`/queue counters, so a generic proxy or an
* earlier self-hosted server answering 200 with some other JSON object is not mistaken for V1.
*/
function isSelfHostedV1Health(value) {
	const health = asRecord(value);
	if (health === void 0) return false;
	if (typeof health.version !== "string" || health.version.trim() === "") return false;
	if (health.protocol_version !== void 0 || health.queued_tasks !== void 0) return false;
	const status = health.status;
	return status === void 0 || status === "ok" || status === "healthy" || status === "unhealthy";
}
var SelfHostedV1Provider = class {
	id = "self-hosted-v1";
	config;
	capabilities = {
		models: ["pipeline"],
		parseMethods: [
			"auto",
			"txt",
			"ocr"
		],
		supportsOcr: true,
		supportsLanguage: false,
		supportsFormula: false,
		supportsTable: false,
		supportsPageRanges: true,
		supportedArtifacts: [
			"markdown",
			"layout",
			"model-output",
			"content-list",
			"images"
		],
		maxFilesPerSubmission: 10
	};
	options;
	uploader;
	constructor(config) {
		this.config = config;
		const baseUrl = new URL(config.baseURL);
		this.options = {
			baseUrl,
			client: new ProviderHttpClient({
				baseURL: baseUrl,
				provider: this.id
			})
		};
		this.uploader = new SelfHostedV1Uploader(baseUrl, this.options.client);
	}
	compatibilityKey(_request) {
		const { origin, pathname } = this.options.baseUrl;
		return "self-hosted-v1:" + createHash("sha256").update(JSON.stringify({
			originAndPath: origin + pathname.replace(/\/+$/, ""),
			configuredVersion: this.config.configuredVersion ?? "v1",
			tier: this.config.tier ?? null
		}), "utf8").digest("hex").slice(0, 24);
	}
	async probe(context) {
		try {
			return await this.probeHealth(context, await this.health(context));
		} catch (error) {
			if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Probe operation was cancelled", true));
			const reason = toMinerUFailure(error);
			return {
				available: false,
				provider: this.id,
				protocolVersion: "v1",
				authentication: reason.code === "AUTHENTICATION_FAILED" ? "invalid" : context.credential ? "unknown" : "not-configured",
				diagnostics: sanitizeDiagnostic(reason.message, [context.credential ?? ""])
			};
		}
	}
	/** Cheap protocol probe: answers whether the configured endpoint speaks the V1 API. */
	async health(context) {
		const health = await this.requestJson("GET", "/v1/health", void 0, {}, context, [200], {
			operation: "probe",
			retry: true
		});
		if (!isSelfHostedV1Health(health)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Endpoint did not answer the MinerU 4.x V1 health document", false, { provider: "self-hosted-v1" }));
		return health;
	}
	async discoverDeployment(context, health) {
		const response = await this.requestJson("GET", "/v1/tiers", void 0, {}, context, [200], {
			operation: "probe",
			retry: true
		});
		if (!Array.isArray(response?.data)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Invalid V1 tiers response", false, { provider: this.id }));
		return {
			availableTiers: [...new Set(response.data.map((item) => item?.id).filter((id) => typeof id === "string" && SELF_HOSTED_TIERS.includes(id)))],
			outputFormats: Array.isArray(health.features?.output_formats) ? [...new Set(health.features.output_formats.filter((value) => [
				"markdown",
				"middle_json",
				"structured_content",
				"zip"
			].includes(value)))] : [],
			sourceTypes: Array.isArray(health.features?.sources) ? [...new Set(health.features.sources.filter((value) => [
				"file_id",
				"url",
				"inline"
			].includes(value)))] : []
		};
	}
	deploymentIssue(deployment) {
		if (!deployment.outputFormats.includes("zip")) return "This V1 deployment does not advertise the required zip output";
		if (!deployment.sourceTypes.includes("file_id")) return "This V1 deployment does not advertise uploaded file_id sources";
		if (deployment.availableTiers.length === 0) return "This V1 deployment advertises no supported parse tiers";
		if (this.config.tier !== void 0 && !deployment.availableTiers.includes(this.config.tier)) return "The configured V1 tier is not available on this deployment";
	}
	async probeHealth(context, health) {
		const deployment = await this.discoverDeployment(context, health);
		const healthy = health.status === void 0 || health.status === "ok" || health.status === "healthy";
		const diagnostics = healthy ? this.deploymentIssue(deployment) : "Server reported unhealthy status";
		return {
			available: healthy && diagnostics === void 0,
			provider: this.id,
			protocolVersion: "v1",
			authentication: context.credential?.trim() ? "valid" : "not-configured",
			...typeof health.version === "string" ? { serverVersion: health.version } : {},
			...deployment,
			...diagnostics === void 0 ? {} : { diagnostics }
		};
	}
	async submit(request, sources, context) {
		context.signal.throwIfAborted();
		if (sources.length !== request.files.length) throw new MinerUError(failure("INVALID_REQUEST", "Prepared source files count does not match request files count"));
		await assertSourcesUnchanged(sources, context.signal);
		const health = await this.health(context);
		if (health.status !== void 0 && health.status !== "ok" && health.status !== "healthy") throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "V1 server reported unhealthy status", true, { provider: this.id }));
		const issue = this.deploymentIssue(await this.discoverDeployment(context, health));
		if (issue !== void 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", issue, false, { provider: this.id }));
		const upstreamFileIds = [];
		for (let index = 0; index < sources.length; index++) {
			context.signal.throwIfAborted();
			upstreamFileIds.push(await this.uploader.uploadSource(sources[index], context));
		}
		const pageRange = request.semantics.pages?.trim();
		const tier = this.config.tier;
		const payload = {
			files: upstreamFileIds.map((fileId) => ({
				source: {
					type: "file_id",
					file_id: fileId
				},
				...pageRange === void 0 || pageRange === "" ? {} : { page_range: pageRange }
			})),
			...tier === void 0 ? {} : { tier },
			ocr_mode: request.semantics.parseMethod,
			output_formats: ["zip"]
		};
		const job = await this.requestJson("POST", "/v1/parse/jobs", JSON.stringify(payload), { "content-type": "application/json" }, context, [200, 202], {
			operation: "submit",
			retry: false
		});
		const jobId = job?.job_id;
		if (typeof jobId !== "string" || jobId.trim() === "") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server did not return a valid job_id", false, { provider: "self-hosted-v1" }));
		const ref = {
			provider: "self-hosted-v1",
			taskId: jobId,
			files: request.files.map((file) => ({
				dataId: `data_${file.fileId}`,
				fileId: file.fileId,
				name: file.name
			}))
		};
		const snapshot = this.snapshotFromJob(ref, job, context);
		return {
			ref,
			state: snapshot.state,
			files: snapshot.files
		};
	}
	async inspect(ref, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "self-hosted-v1") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref for the self-hosted V1 API adapter`));
		const job = await this.requestJson("GET", `/v1/parse/jobs/${encodeURIComponent(ref.taskId)}`, void 0, {}, context, [200], {
			operation: "inspect",
			retry: true
		});
		return this.snapshotFromJob(ref, job, context);
	}
	async collect(ref, request, sink, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "self-hosted-v1") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref for the self-hosted V1 API adapter`));
		const job = await this.requestJson("GET", `/v1/parse/jobs/${encodeURIComponent(ref.taskId)}`, void 0, {}, context, [200], {
			operation: "collect",
			retry: true
		});
		const jobFiles = Array.isArray(job?.files) ? job.files : [];
		const collectedFiles = [];
		for (let index = 0; index < ref.files.length; index++) {
			context.signal.throwIfAborted();
			const file = ref.files[index];
			const jobFile = matchV1JobFile(jobFiles, file, index);
			if (jobFile === void 0) throw new MinerUError(failure("RESULT_NOT_READY", `Result for file "${file.name}" is not ready`, true, {
				provider: "self-hosted-v1",
				fileId: file.fileId
			}));
			const fileState = mapSelfHostedV1FileState(jobFile.status);
			if (fileState === "failed") {
				collectedFiles.push({
					fileId: file.fileId,
					name: file.name,
					artifacts: [],
					failure: remoteFileFailure(jobFile, file.fileId, context.credential)
				});
				continue;
			}
			if (fileState !== "completed") throw new MinerUError(failure("RESULT_NOT_READY", `Result for file "${file.name}" is not ready (state: ${String(jobFile.status)})`, true, {
				provider: "self-hosted-v1",
				fileId: file.fileId
			}));
			const archiveFileId = (jobFile.output_files?.["zip"])?.file_id;
			if (typeof archiveFileId !== "string" || archiveFileId.trim() === "") throw archiveInvalid(`Completed file "${file.name}" has no zip output`, file.fileId);
			const extracted = await extractSafeZip({
				zipPath: (await this.downloadResultArchive(archiveFileId, sink, context, index)).path,
				sink: canonicalizingSink(sink),
				files: [{
					fileId: file.fileId,
					dataId: file.dataId,
					name: file.name
				}],
				requiredArtifacts: request.requiredArtifacts,
				limits: context.limits,
				signal: context.signal
			});
			collectedFiles.push(...extracted);
		}
		return { files: collectedFiles };
	}
	snapshotFromJob(ref, job, context) {
		const jobFiles = Array.isArray(job?.files) ? job.files : [];
		if (jobFiles.length === 0) {
			const state = mapSelfHostedV1JobState(job?.status);
			const fileState = state === "queued" || state === "processing" ? state : "failed";
			return {
				state,
				files: ref.files.map((file) => ({
					fileId: file.fileId,
					state: fileState,
					rawState: typeof job?.status === "string" ? job.status : void 0,
					...fileState === "failed" ? { failure: failure("REMOTE_PARSE_FAILED", "Remote parse job did not complete", false, {
						provider: "self-hosted-v1",
						fileId: file.fileId
					}) } : {}
				}))
			};
		}
		const snapshots = [];
		let hasNonTerminal = false;
		let everyQueued = true;
		let allCompleted = true;
		let allFailed = true;
		const terminalJob = optionalSelfHostedV1JobState(job?.status);
		const jobFinished = terminalJob === "completed" || terminalJob === "failed" || terminalJob === "partially-completed";
		for (let index = 0; index < ref.files.length; index++) {
			const file = ref.files[index];
			const jobFile = matchV1JobFile(jobFiles, file, index);
			if (jobFile === void 0) {
				const missingState = jobFinished ? "failed" : "processing";
				snapshots.push({
					fileId: file.fileId,
					state: missingState,
					rawState: "pending",
					...missingState === "failed" ? { failure: failure("REMOTE_PARSE_FAILED", "Remote parse job finished without a result for this file", false, {
						provider: "self-hosted-v1",
						fileId: file.fileId
					}) } : {}
				});
				if (missingState === "processing") hasNonTerminal = true;
				everyQueued = false;
				allCompleted = false;
				if (missingState !== "failed") allFailed = false;
				continue;
			}
			const fileState = mapSelfHostedV1FileState(jobFile.status);
			snapshots.push({
				fileId: file.fileId,
				state: fileState,
				rawState: typeof jobFile.status === "string" ? jobFile.status : void 0,
				...fileState === "failed" ? { failure: remoteFileFailure(jobFile, file.fileId, context.credential) } : {}
			});
			if (fileState !== "completed" && fileState !== "failed") hasNonTerminal = true;
			if (fileState !== "queued") everyQueued = false;
			if (fileState !== "completed") allCompleted = false;
			if (fileState !== "failed") allFailed = false;
		}
		let state;
		if (hasNonTerminal) state = everyQueued ? "queued" : "processing";
		else if (allCompleted) state = "completed";
		else if (allFailed) state = "failed";
		else state = "partially-completed";
		return {
			state,
			files: snapshots
		};
	}
	/** Downloads the result archive of a completed file into a bounded staging temporary file. */
	async downloadResultArchive(fileId, sink, context, index) {
		const url = resolveProviderUrl(this.options.baseUrl, `/v1/files/${encodeURIComponent(fileId)}/content`);
		const headers = {};
		if (typeof context.credential === "string" && context.credential.trim() !== "") headers["authorization"] = `Bearer ${context.credential}`;
		return await executeWithRetry({
			provider: "self-hosted-v1",
			operation: "result-download",
			signal: context.signal,
			retryOptions: context.retry,
			fn: async () => {
				context.signal.throwIfAborted();
				const controller = new AbortController();
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new DOMException(`Download timed out after ${String(context.timeoutMs)}ms`, "TimeoutError"));
				}, context.timeoutMs);
				const onParentAbort = () => {
					controller.abort(context.signal.reason);
				};
				context.signal.addEventListener("abort", onParentAbort, { once: true });
				try {
					let response;
					try {
						response = await fetch(url, {
							method: "GET",
							headers,
							signal: controller.signal,
							redirect: "error"
						});
					} catch (error) {
						if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Download was cancelled", true));
						if (timedOut) throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Result download timed out after ${String(context.timeoutMs)}ms`, true, { provider: "self-hosted-v1" }), { http: { status: 408 } });
						throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Failed to download result archive: ${error instanceof Error ? error.message : String(error)}`, true, { provider: "self-hosted-v1" }));
					}
					if (response.status !== 200) {
						let errorBody = "";
						try {
							errorBody = await readBoundedResponseText(response, DOWNLOAD_ERROR_BODY_BYTES, controller.signal);
						} catch {
							if (response.body) try {
								await response.body.cancel();
							} catch {}
						}
						const secrets = [context.credential ?? ""];
						const detail = extractErrorDetail(errorBody, "self-hosted-v1");
						const providerCode = safeProviderCode(detail.code, secrets);
						throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Failed to download result archive, HTTP status ${String(response.status)}${detail.message ? `: ${sanitizeDiagnostic(detail.message, secrets)}` : ""}`, isRetryableHttpStatus(response.status), {
							provider: "self-hosted-v1",
							...providerCode === void 0 ? {} : { providerCode }
						}), { http: {
							status: response.status,
							retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
						} });
					}
					const body = response.body;
					if (body === null) throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", "Result archive response body is empty", false, { provider: "self-hosted-v1" }));
					const nodeStream = Readable.fromWeb(body);
					let bodyFailed = false;
					const onBodyError = () => {
						bodyFailed = true;
					};
					nodeStream.once("error", onBodyError);
					try {
						return await sink.writeTemporary(`mineru_v1_${String(index)}_${fileId.replace(/[^A-Za-z0-9._-]/g, "_")}.zip`, nodeStream, context.limits.maxZipDownloadBytes);
					} catch (error) {
						nodeStream.destroy();
						if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Download was cancelled", true));
						if (error instanceof MinerUError) throw error;
						const message = error instanceof Error ? error.message : String(error);
						if (bodyFailed) throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Result archive transfer was interrupted after HTTP 200: ${message}`, true, { provider: "self-hosted-v1" }), { http: timedOut ? { status: 408 } : void 0 });
						throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Failed to stage the downloaded result archive: ${message}`, false, { provider: "self-hosted-v1" }));
					} finally {
						nodeStream.removeListener("error", onBodyError);
					}
				} finally {
					clearTimeout(timer);
					context.signal.removeEventListener("abort", onParentAbort);
				}
			}
		});
	}
	async requestJson(method, path, body, headers, context, acceptedStatuses = [200], options) {
		return await this.options.client.requestJson({
			method,
			path,
			...body === void 0 ? {} : { body },
			headers,
			context,
			acceptedStatuses,
			operation: options?.operation,
			retry: options?.retry
		});
	}
};
//#endregion
//#region src/providers/official-v4/index.ts
function mapOfficialFileState(rawState) {
	if (typeof rawState !== "string") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official result is missing file state"));
	switch (rawState.toLowerCase()) {
		case "waiting-file":
		case "pending":
		case "queued": return "queued";
		case "running":
		case "converting":
		case "processing": return "processing";
		case "done":
		case "completed":
		case "success": return "completed";
		case "failed":
		case "error": return "failed";
		default: throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Unknown official file state: ${rawState}`, false, { provider: "official-v4" }));
	}
}
function isMissingBatchProbeSentinel(code, message) {
	const normalizedCode = String(code).toUpperCase();
	if (normalizedCode === "BATCH_NOT_FOUND") return true;
	return (normalizedCode === "-500" || normalizedCode === "-60012") && /^task not found or expire(?:d)?[.!]?$/i.test(message.trim());
}
function officialBusinessFailure(code, message, traceId, http) {
	const providerCode = String(code);
	const normalized = providerCode.toUpperCase();
	const details = {
		provider: "official-v4",
		providerCode,
		...traceId === void 0 ? {} : { traceId }
	};
	if (normalized === "A0202" || normalized === "A0211" || normalized === "401") return new MinerUError(failure("AUTHENTICATION_FAILED", message, false, details), { http });
	if (normalized === "-60018" || normalized === "-60019") return new MinerUError(failure("PROVIDER_QUOTA_EXHAUSTED", message, false, details), { http });
	if (normalized === "-60005") return new MinerUError(failure("FILE_TOO_LARGE", message, false, details), { http });
	if (normalized === "429") return new MinerUError(failure("PROVIDER_RATE_LIMITED", message, true, details), { http });
	return new MinerUError(failure("REMOTE_PARSE_FAILED", message, false, details), { http });
}
function externalHttpsUrl(raw, label) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new MinerUError(failure("REMOTE_PARSE_FAILED", `${label} is not a valid URL`));
	}
	if (url.protocol !== "https:" || url.username || url.password) throw new MinerUError(failure("REMOTE_PARSE_FAILED", `${label} must be an HTTPS URL without embedded credentials`));
	return url.toString();
}
function parseProgress(extractProgress) {
	if (typeof extractProgress === "object" && extractProgress !== null) {
		const obj = extractProgress;
		const extracted = typeof obj["extracted_pages"] === "number" ? obj["extracted_pages"] : void 0;
		const total = typeof obj["total_pages"] === "number" ? obj["total_pages"] : void 0;
		if (extracted !== void 0 && total !== void 0 && Number.isSafeInteger(extracted) && Number.isSafeInteger(total) && extracted >= 0 && total > 0 && extracted <= total) return {
			completed: extracted,
			total
		};
	}
	if (Number.isSafeInteger(extractProgress) && extractProgress >= 0 && extractProgress <= 100) return {
		completed: extractProgress,
		total: 100
	};
}
function indexExtractResults(extractResults, ref) {
	const expected = new Set(ref.files.map((file) => file.dataId));
	if (expected.size !== ref.files.length) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official provider reference contains duplicate data_id mappings", false, { provider: "official-v4" }));
	const results = /* @__PURE__ */ new Map();
	for (const item of extractResults) {
		if (typeof item.data_id !== "string" || item.data_id.trim() === "") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official result item is missing data_id", false, { provider: "official-v4" }));
		if (!expected.has(item.data_id)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official result contains an unknown data_id", false, { provider: "official-v4" }));
		if (results.has(item.data_id)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official result contains a duplicate data_id", false, { provider: "official-v4" }));
		results.set(item.data_id, item);
	}
	return results;
}
var OfficialV4Provider = class {
	id = "official-v4";
	config;
	capabilities;
	parsedBaseUrl;
	client;
	constructor(config) {
		this.config = config;
		this.parsedBaseUrl = new URL(config.baseURL);
		this.client = new ProviderHttpClient({
			baseURL: this.parsedBaseUrl,
			provider: "official-v4",
			providerLabel: "MinerU official API"
		});
		this.capabilities = {
			models: config.models,
			parseMethods: ["auto", "ocr"],
			supportsOcr: true,
			supportsLanguage: true,
			supportsFormula: true,
			supportsTable: true,
			supportsPageRanges: true,
			supportedArtifacts: [
				"markdown",
				"layout",
				"model-output",
				"content-list",
				"images"
			],
			maxFilesPerSubmission: 200,
			maxFileBytes: 209715200
		};
	}
	compatibilityKey(request) {
		const originAndPath = `${this.parsedBaseUrl.origin}${this.parsedBaseUrl.pathname.replace(/\/+$/, "")}`;
		return `official-v4:${createHash("sha256").update(JSON.stringify({
			originAndPath,
			configuredVersion: this.config.configuredVersion ?? "v4",
			model: request.semantics.model
		}), "utf8").digest("hex").slice(0, 24)}`;
	}
	async probe(context) {
		if (!context.credential || context.credential.trim() === "") return {
			available: false,
			provider: "official-v4",
			authentication: "not-configured",
			protocolVersion: "v4",
			diagnostics: "API key is not configured"
		};
		try {
			await this.requestJson("GET", "/extract-results/batch/__dsh_probe__", void 0, {}, context, [200, 404], {
				operation: "probe",
				retry: true,
				businessValidation: "probe"
			});
			return {
				available: true,
				provider: "official-v4",
				authentication: "valid",
				protocolVersion: "v4"
			};
		} catch (error) {
			if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Probe operation was cancelled", true));
			const minerUFailure = toMinerUFailure(error);
			return {
				available: false,
				provider: "official-v4",
				authentication: minerUFailure.code === "AUTHENTICATION_FAILED" ? "invalid" : "unknown",
				protocolVersion: "v4",
				diagnostics: minerUFailure.message
			};
		}
	}
	async submit(request, sources, context) {
		context.signal.throwIfAborted();
		if (sources.length !== request.files.length) throw new MinerUError(failure("INVALID_REQUEST", "Prepared source files count does not match request files count"));
		await assertSourcesUnchanged(sources, context.signal);
		const submittedFiles = request.files.map((f) => ({
			dataId: `data_${f.fileId}`,
			fileId: f.fileId,
			name: f.name
		}));
		const payload = {
			files: request.files.map((file, i) => {
				const sub = submittedFiles[i];
				return {
					name: file.name,
					data_id: sub.dataId,
					is_ocr: request.semantics.ocr,
					enable_formula: request.semantics.formula,
					enable_table: request.semantics.table,
					language: request.semantics.language,
					...request.semantics.pages !== void 0 ? { page_ranges: request.semantics.pages } : {}
				};
			}),
			model_version: request.semantics.model
		};
		const submitResponse = await this.requestJson("POST", "/file-urls/batch", JSON.stringify(payload), { "content-type": "application/json" }, context, [200], {
			operation: "submit",
			retry: false
		});
		if (!submitResponse || typeof submitResponse !== "object") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server returned empty or invalid response", false, { provider: "official-v4" }));
		const batchId = submitResponse.data?.batch_id;
		const fileUrls = submitResponse.data?.file_urls;
		if (!batchId || typeof batchId !== "string" || batchId.trim() === "") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server did not return a valid batch_id", false, {
			provider: "official-v4",
			traceId: submitResponse.trace_id
		}));
		if (!Array.isArray(fileUrls) || fileUrls.length !== sources.length) throw new MinerUError(failure("REMOTE_PARSE_FAILED", `MinerU returned ${String(fileUrls?.length ?? 0)} upload URLs, expected ${String(sources.length)}`, false, {
			provider: "official-v4",
			traceId: submitResponse.trace_id
		}));
		const ref = {
			provider: "official-v4",
			batchId,
			files: submittedFiles
		};
		for (let i = 0; i < sources.length; i++) {
			context.signal.throwIfAborted();
			const source = sources[i];
			const uploadUrl = externalHttpsUrl(fileUrls[i], "Official presigned upload URL");
			await this.barePutStream(uploadUrl, source, context);
		}
		return {
			ref,
			state: "processing",
			files: request.files.map((f) => ({
				fileId: f.fileId,
				state: "processing",
				rawState: "running"
			}))
		};
	}
	async inspect(ref, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "official-v4") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref "${ref.provider}" for OfficialV4Provider`));
		const data = await this.requestJson("GET", `/extract-results/batch/${encodeURIComponent(ref.batchId)}`, void 0, {}, context, [200], {
			operation: "inspect",
			retry: true
		});
		if (!data || typeof data !== "object") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server returned empty status response", false, { provider: "official-v4" }));
		const resultsByDataId = indexExtractResults(Array.isArray(data.data?.extract_result) ? data.data.extract_result : [], ref);
		const fileSnapshots = [];
		let hasNonTerminal = false;
		let allCompleted = true;
		let allFailed = true;
		for (const file of ref.files) {
			const item = resultsByDataId.get(file.dataId);
			if (!item) {
				fileSnapshots.push({
					fileId: file.fileId,
					state: "processing",
					rawState: "pending"
				});
				hasNonTerminal = true;
				allCompleted = false;
				allFailed = false;
				continue;
			}
			const fileState = mapOfficialFileState(item.state);
			const progress = parseProgress(item.extract_progress);
			const fileFailure = fileState === "failed" ? failure("REMOTE_PARSE_FAILED", sanitizeDiagnostic(item.err_msg || "Remote document extraction failed", [context.credential ?? ""]), false, {
				provider: "official-v4",
				fileId: file.fileId,
				traceId: data.trace_id
			}) : void 0;
			fileSnapshots.push({
				fileId: file.fileId,
				state: fileState,
				rawState: item.state,
				...progress !== void 0 ? { progress } : {},
				...fileFailure !== void 0 ? { failure: fileFailure } : {}
			});
			if (fileState !== "completed" && fileState !== "failed") hasNonTerminal = true;
			if (fileState !== "completed") allCompleted = false;
			if (fileState !== "failed") allFailed = false;
		}
		let batchState;
		if (hasNonTerminal) batchState = "processing";
		else if (allCompleted) batchState = "completed";
		else if (allFailed) batchState = "failed";
		else batchState = "partially-completed";
		return {
			state: batchState,
			files: fileSnapshots
		};
	}
	async collect(ref, request, sink, context) {
		context.signal.throwIfAborted();
		if (ref.provider !== "official-v4") throw new MinerUError(failure("INVALID_REQUEST", `Unsupported provider ref "${ref.provider}" for OfficialV4Provider`));
		const data = await this.requestJson("GET", `/extract-results/batch/${encodeURIComponent(ref.batchId)}`, void 0, {}, context, [200], {
			operation: "collect",
			retry: true
		});
		if (!data || typeof data !== "object") throw new MinerUError(failure("REMOTE_PARSE_FAILED", "MinerU server returned empty result response", false, { provider: "official-v4" }));
		const resultsByDataId = indexExtractResults(Array.isArray(data.data?.extract_result) ? data.data.extract_result : [], ref);
		const completedFilesByZipUrl = /* @__PURE__ */ new Map();
		const collectedFiles = [];
		for (const file of ref.files) {
			const item = resultsByDataId.get(file.dataId);
			if (!item) throw new MinerUError(failure("RESULT_NOT_READY", `Result for file "${file.name}" is not ready`, true, {
				provider: "official-v4",
				fileId: file.fileId
			}));
			const fileState = mapOfficialFileState(item.state);
			if (fileState === "failed") {
				collectedFiles.push({
					fileId: file.fileId,
					name: file.name,
					artifacts: [],
					failure: failure("REMOTE_PARSE_FAILED", sanitizeDiagnostic(item.err_msg || "Remote extraction failed", [context.credential ?? ""]), false, {
						provider: "official-v4",
						fileId: file.fileId,
						traceId: data.trace_id
					})
				});
				continue;
			}
			if (fileState !== "completed") throw new MinerUError(failure("RESULT_NOT_READY", `Result for file "${file.name}" is not ready (state: ${item.state})`, true, {
				provider: "official-v4",
				fileId: file.fileId
			}));
			const zipUrl = item.full_zip_url;
			if (!zipUrl || typeof zipUrl !== "string" || zipUrl.trim() === "") throw new MinerUError(failure("REMOTE_PARSE_FAILED", `Completed file "${file.name}" is missing full_zip_url`, false, {
				provider: "official-v4",
				fileId: file.fileId,
				traceId: data.trace_id
			}));
			const safeZipUrl = externalHttpsUrl(zipUrl, "Official result ZIP URL");
			const list = completedFilesByZipUrl.get(safeZipUrl) ?? [];
			list.push(file);
			completedFilesByZipUrl.set(safeZipUrl, list);
		}
		for (const [zipUrl, targetFiles] of completedFilesByZipUrl.entries()) {
			context.signal.throwIfAborted();
			const extracted = await extractSafeZip({
				zipPath: (await this.downloadZipToTemporary(zipUrl, sink, context)).path,
				sink,
				files: targetFiles,
				requiredArtifacts: request.requiredArtifacts,
				limits: context.limits,
				signal: context.signal
			});
			collectedFiles.push(...extracted);
		}
		return { files: collectedFiles };
	}
	async requestJson(method, path, bodyText, headers, context, acceptedStatuses = [200], options) {
		const businessValidation = options?.businessValidation ?? "strict";
		return await this.client.requestJson({
			method,
			path,
			body: bodyText,
			headers,
			context,
			acceptedStatuses,
			operation: options?.operation,
			retry: options?.retry,
			validateResponse: (parsed, response) => {
				if (!("code" in parsed)) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Official MinerU response is missing its business code", false, { provider: "official-v4" }));
				const envelope = parsed;
				if (envelope.code !== 0) {
					const normalizedCode = String(envelope.code).toUpperCase();
					if (businessValidation === "probe" && isMissingBatchProbeSentinel(envelope.code, envelope.msg)) return parsed;
					throw officialBusinessFailure(envelope.code, sanitizeDiagnostic(envelope.msg || `Official API failed with code ${String(envelope.code)}`, [context.credential ?? ""]), envelope.trace_id, normalizedCode === "429" ? {
						status: 429,
						retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
					} : void 0);
				}
				return parsed;
			}
		});
	}
	async barePutStream(uploadUrl, source, context) {
		context.signal.throwIfAborted();
		const safeUploadUrl = externalHttpsUrl(uploadUrl, "Official presigned upload URL");
		await executeWithRetry({
			provider: "official-v4",
			operation: "presigned-put",
			signal: context.signal,
			retryOptions: context.retry,
			fn: async () => {
				context.signal.throwIfAborted();
				await assertSourcesUnchanged([source], context.signal);
				const controller = new AbortController();
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new DOMException(`Upload timed out after ${String(context.timeoutMs)}ms`, "TimeoutError"));
				}, context.timeoutMs);
				const onParentAbort = () => {
					controller.abort(context.signal.reason);
				};
				context.signal.addEventListener("abort", onParentAbort, { once: true });
				const stream = createReadStream(source.path);
				const onStreamAbort = () => {
					stream.destroy(new DOMException("Aborted", "AbortError"));
				};
				context.signal.addEventListener("abort", onStreamAbort, { once: true });
				try {
					const requestInit = {
						method: "PUT",
						headers: {},
						body: Readable.toWeb(stream),
						signal: controller.signal,
						redirect: "error",
						duplex: "half"
					};
					let response;
					try {
						response = await fetch(safeUploadUrl, requestInit);
					} catch (err) {
						if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Upload was cancelled", true));
						if (timedOut) throw new MinerUError(failure("UPLOAD_FAILED", `Upload timed out after ${String(context.timeoutMs)}ms`, true), { http: { status: 408 } });
						throw new MinerUError(failure("UPLOAD_FAILED", `Failed to upload file to storage: ${err instanceof Error ? err.message : String(err)}`, true), { cause: err });
					}
					if (response.status !== 200 && response.status !== 204) {
						let errText = "";
						try {
							errText = await readBoundedResponseText(response, 2048, controller.signal);
						} catch {
							if (response.body) try {
								await response.body.cancel();
							} catch {}
						}
						const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
						const retryable = isRetryableHttpStatus(response.status);
						throw new MinerUError(failure("UPLOAD_FAILED", `Storage upload failed with HTTP status ${String(response.status)}${errText ? `: ${errText}` : ""}`, retryable), { http: {
							status: response.status,
							retryAfterMs: retryAfter
						} });
					}
					if (response.body) try {
						await response.body.cancel();
					} catch {}
				} finally {
					clearTimeout(timer);
					context.signal.removeEventListener("abort", onParentAbort);
					context.signal.removeEventListener("abort", onStreamAbort);
					if (!stream.destroyed) stream.destroy();
				}
			}
		});
	}
	async downloadZipToTemporary(cdnUrl, sink, context) {
		context.signal.throwIfAborted();
		const safeCdnUrl = externalHttpsUrl(cdnUrl, "Official result ZIP URL");
		return await executeWithRetry({
			provider: "official-v4",
			operation: "cdn-download",
			signal: context.signal,
			retryOptions: context.retry,
			fn: async () => {
				context.signal.throwIfAborted();
				const controller = new AbortController();
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new DOMException(`Download timed out after ${String(context.timeoutMs)}ms`, "TimeoutError"));
				}, context.timeoutMs);
				const onParentAbort = () => {
					controller.abort(context.signal.reason);
				};
				context.signal.addEventListener("abort", onParentAbort, { once: true });
				try {
					const requestInit = {
						method: "GET",
						headers: {},
						signal: controller.signal,
						redirect: "error"
					};
					let response;
					try {
						response = await fetch(safeCdnUrl, requestInit);
					} catch (err) {
						if (context.signal.aborted) throw new MinerUError(failure("CANCELLED", "Download was cancelled", true));
						if (timedOut) throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Download timed out after ${String(context.timeoutMs)}ms`, true), { http: { status: 408 } });
						throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Failed to download result archive: ${err instanceof Error ? err.message : String(err)}`, true), { cause: err });
					}
					if (response.status !== 200) {
						if (response.body) try {
							await response.body.cancel();
						} catch {}
						const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
						const retryable = isRetryableHttpStatus(response.status);
						throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", `Failed to download result archive, HTTP status ${String(response.status)}`, retryable), { http: {
							status: response.status,
							retryAfterMs: retryAfter
						} });
					}
					const body = response.body;
					if (!body) throw new MinerUError(failure("RESULT_DOWNLOAD_FAILED", "Result archive response body is empty", false));
					const nodeStream = Readable.fromWeb(body);
					const tempName = `mineru_v4_${createHash("sha256").update(safeCdnUrl).digest("hex").slice(0, 16)}.zip`;
					try {
						return await sink.writeTemporary(tempName, nodeStream, context.limits.maxZipDownloadBytes);
					} catch (error) {
						nodeStream.destroy();
						throw error;
					}
				} finally {
					clearTimeout(timer);
					context.signal.removeEventListener("abort", onParentAbort);
				}
			}
		});
	}
};
//#endregion
//#region src/providers/registry.ts
const providerFactories = {
	"self-hosted-v1": (config) => new SelfHostedV1Provider(config),
	"self-hosted-legacy-v2": (config) => new SelfHostedLegacyV2Provider(config),
	"official-v4": (config) => new OfficialV4Provider(config)
};
/** Build the protocol adapter for one validated provider profile. */
const createProvider = (config) => {
	const create = providerFactories[config.type];
	return create(config);
};
//#endregion
//#region src/domain/selection.ts
const FOCUS_KINDS = [
	"all",
	"text",
	"table",
	"image",
	"toc",
	"artifacts"
];
const MAX_PAGE = 99999;
const BLOCK_ID = /^mr_[a-zA-Z0-9_-]+:b[1-9][0-9]*$/;
const MAX_BLOCK_ID_CHARS = 160;
const MAX_QUERY_CHARS = 256;
function isBlockId(value) {
	return typeof value === "string" && value.length <= MAX_BLOCK_ID_CHARS && BLOCK_ID.test(value);
}
function isQueryText(value) {
	return typeof value === "string" && value.trim() !== "" && value.length <= MAX_QUERY_CHARS;
}
function isSha256(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
/** Cursor selection fields restored as a selection; the cursor text offset stays with the payload. */
function cursorSelection(cursor) {
	const target = cursor.block !== void 0 ? {
		kind: "block",
		blockId: cursor.block
	} : cursor.query !== void 0 ? {
		kind: "query",
		text: cursor.query
	} : void 0;
	return {
		...cursor.pages === "" ? {} : { pages: normalizePageSelection(cursor.pages) },
		focus: normalizeFocusSelection(cursor.focus),
		...target === void 0 ? {} : { target }
	};
}
function parsePageRangeTokens(input) {
	const intervals = [];
	for (const token of input.split(",")) {
		const trimmed = token.trim();
		if (trimmed === "") continue;
		const match = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
		if (match === null) throw new TypeError(`Invalid page range token: ${trimmed}`);
		const start = Number(match[1]);
		const end = match[2] === void 0 ? start : Number(match[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > MAX_PAGE) throw new TypeError(`Invalid page range token: ${trimmed}`);
		intervals.push({
			start,
			end
		});
	}
	if (intervals.length === 0) throw new TypeError("Page range cannot be empty");
	return intervals;
}
function normalizePageRanges(input) {
	const intervals = parsePageRangeTokens(input);
	intervals.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged = [];
	for (const current of intervals) {
		const previous = merged.at(-1);
		if (previous !== void 0 && current.start <= previous.end + 1) previous.end = Math.max(previous.end, current.end);
		else merged.push({ ...current });
	}
	return merged.map(({ start, end }) => start === end ? String(start) : `${String(start)}-${String(end)}`).join(",");
}
function narrowPageSelection(requested, totalPages) {
	if (requested === void 0) {
		if (totalPages === void 0) return {
			pagesSet: void 0,
			pagesLabel: "",
			outOfRange: [],
			fullyOutOfRange: false
		};
		const maxBound = Math.max(1, totalPages);
		return {
			pagesSet: void 0,
			pagesLabel: maxBound > 1 ? "1-" + String(maxBound) : "1",
			outOfRange: [],
			fullyOutOfRange: false
		};
	}
	if (totalPages === void 0) return {
		pagesSet: new Set(requested),
		pagesLabel: normalizePageRanges([...requested].join(",")),
		outOfRange: [],
		fullyOutOfRange: false
	};
	const maxBound = Math.max(1, totalPages);
	const valid = /* @__PURE__ */ new Set();
	const outOfRange = [];
	for (const p of requested) if (p >= 1 && p <= maxBound) valid.add(p);
	else outOfRange.push(p);
	outOfRange.sort((a, b) => a - b);
	if (valid.size === 0) return {
		pagesSet: /* @__PURE__ */ new Set(),
		pagesLabel: "",
		outOfRange,
		fullyOutOfRange: true
	};
	return {
		pagesSet: valid,
		pagesLabel: normalizePageRanges([...valid].join(",")),
		outOfRange,
		fullyOutOfRange: false
	};
}
function normalizePageSelection(input) {
	if (input === void 0 || input === null) return void 0;
	if (typeof input === "number") {
		if (!Number.isSafeInteger(input) || input < 1 || input > MAX_PAGE) throw new TypeError(`Invalid page number: ${String(input)}`);
		return /* @__PURE__ */ new Set([input]);
	}
	if (Array.isArray(input)) {
		if (input.length === 0) throw new TypeError("Page selection cannot be empty");
		const set = /* @__PURE__ */ new Set();
		for (const item of input) if (typeof item === "number") {
			if (!Number.isSafeInteger(item) || item < 1 || item > MAX_PAGE) throw new TypeError(`Invalid page number: ${String(item)}`);
			set.add(item);
		} else throw new TypeError(`Invalid page selection item: ${String(item)}`);
		return set;
	}
	if (typeof input === "string") {
		if (input.trim() === "") throw new TypeError("Page range cannot be empty");
		const intervals = parsePageRangeTokens(input);
		const set = /* @__PURE__ */ new Set();
		for (const { start, end } of intervals) for (let p = start; p <= end; p++) set.add(p);
		return set;
	}
	throw new TypeError(`Invalid page selection: ${String(input)}`);
}
function parseFocusToken(item) {
	if (typeof item !== "string") throw new TypeError(`Invalid focus option: ${String(item)}`);
	const trimmed = item.trim().toLowerCase();
	if (!FOCUS_KINDS.includes(trimmed)) throw new TypeError(`Invalid focus option: ${String(item)}`);
	return trimmed;
}
function normalizeFocusSelection(input) {
	if (input === void 0 || input === null) return /* @__PURE__ */ new Set(["all"]);
	if (typeof input === "string") return /* @__PURE__ */ new Set([parseFocusToken(input)]);
	if (Array.isArray(input)) {
		if (input.length === 0) return /* @__PURE__ */ new Set(["all"]);
		const set = /* @__PURE__ */ new Set();
		for (const item of input) set.add(parseFocusToken(item));
		return set;
	}
	throw new TypeError(`Invalid focus option: ${String(input)}`);
}
//#endregion
//#region src/domain/cache-key.ts
function normalizeJson(value) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return value.normalize("NFC");
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain non-finite numbers");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object") {
		const source = value;
		const target = Object.create(null);
		for (const rawKey of Object.keys(source).sort()) {
			const key = rawKey.normalize("NFC");
			if (Object.hasOwn(target, key)) throw new TypeError("canonical JSON key normalization collision");
			const entry = source[rawKey];
			if (entry === void 0) throw new TypeError("canonical JSON cannot contain undefined");
			target[key] = normalizeJson(entry);
		}
		return target;
	}
	throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}
function canonicalJson(value) {
	return JSON.stringify(normalizeJson(value));
}
function computeCacheKey(request, file, providerCompatibilityKey, versions = {}) {
	const encoded = canonicalJson({
		cacheKeySchemaVersion: versions.cacheKey ?? 1,
		sourceSha256: file.sha256,
		parseSemantics: request.semantics,
		requiredArtifacts: request.requiredArtifacts,
		providerCompatibilityKey,
		resultSchemaVersion: versions.result ?? 1
	});
	return asCacheKey(createHash("sha256").update(encoded, "utf8").digest("hex"));
}
//#endregion
//#region src/service/parse-service.ts
function reportProgress(listener, phase) {
	try {
		listener?.(phase);
	} catch {}
}
/** Parse orchestration: one cache key per source, same-process coalescing, and verified publication. */
var ParseService = class {
	options;
	constructor(options) {
		this.options = options;
	}
	diagnostic(event) {
		emitDiagnostic(this.options.diagnostics, event);
	}
	active(config) {
		const provider = providerById(config, config.activeProvider);
		return {
			config: provider,
			provider: this.options.createProvider(provider)
		};
	}
	async callContext(provider, config, signal, operationId, allowMissingCredential = false) {
		signal.throwIfAborted();
		const reference = provider.apiKeyEnv;
		const credential = reference === void 0 ? void 0 : await this.options.resolveCredential(reference, signal);
		signal.throwIfAborted();
		if (PROVIDER_TRAITS[provider.type].requiresCredential && credential === void 0 && !allowMissingCredential) throw new MinerUError(failure("CREDENTIAL_MISSING", `Credential ${provider.apiKeyEnv} is not configured`));
		return {
			signal,
			...credential === void 0 ? {} : { credential },
			timeoutMs: config.polling.requestTimeoutMs,
			retry: {
				maxRetries: config.retry.maxAttempts - 1,
				initialDelayMs: config.retry.baseDelayMs,
				maxDelayMs: config.retry.maxDelayMs,
				onRetry: (event) => {
					this.diagnostic({
						level: "warn",
						phase: "provider-retry",
						provider: event.provider,
						...operationId === void 0 ? {} : { operationId },
						providerOperation: event.operation,
						attempt: event.attempt,
						maxAttempts: event.maxRetries + 1,
						delayMs: event.delayMs,
						reason: event.reason,
						...event.status === void 0 ? {} : { status: event.status }
					});
				}
			},
			limits: {
				maxApiResponseBytes: config.limits.maxApiResponseBytes,
				maxZipDownloadBytes: config.limits.maxZipDownloadBytes,
				maxZipEntries: config.limits.maxZipEntries,
				maxZipEntryBytes: config.limits.maxZipEntryBytes,
				maxZipTotalBytes: config.limits.maxZipTotalBytes,
				maxZipCompressionRatio: config.limits.maxZipCompressionRatio
			}
		};
	}
	/** Discover the active (or an unsaved draft) provider without creating parse state. */
	async probe(config, signal, draft) {
		const resolved = draft === void 0 ? this.active(config) : {
			config: draft,
			provider: this.options.createProvider(draft)
		};
		const result = await resolved.provider.probe(await this.callContext(resolved.config, config, signal, void 0, true));
		return {
			available: result.available,
			provider: result.provider,
			authentication: result.authentication,
			protocol_version: result.protocolVersion,
			...result.serverVersion === void 0 ? {} : { server_version: result.serverVersion },
			...result.availableTiers === void 0 ? {} : { available_tiers: result.availableTiers },
			...result.outputFormats === void 0 ? {} : { output_formats: result.outputFormats },
			...result.sourceTypes === void 0 ? {} : { source_types: result.sourceTypes },
			...result.queue === void 0 ? {} : { queue: {
				...result.queue.queued === void 0 ? {} : { queued: result.queue.queued },
				...result.queue.processing === void 0 ? {} : { processing: result.queue.processing },
				...result.queue.completed === void 0 ? {} : { completed: result.queue.completed },
				...result.queue.failed === void 0 ? {} : { failed: result.queue.failed },
				...result.queue.maxConcurrent === void 0 ? {} : { max_concurrent: result.queue.maxConcurrent }
			} },
			...result.diagnostics === void 0 ? {} : { diagnostics: result.diagnostics }
		};
	}
	/**
	* Return the verified published result for one absolute source path, joining or
	* starting the shared producer. A timed-out wait leaves the producer running.
	*/
	async ensurePublished(sourcePath, config, signal, options = {}) {
		signal.throwIfAborted();
		reportProgress(options.onProgress, "preparing");
		const pending = await this.prepare(sourcePath, config, signal, options.cacheOnly === true);
		if (pending.kind === "published") {
			reportProgress(options.onProgress, "reading-result");
			return pending.result;
		}
		const wait = waitSignal(signal, options.waitTimeoutMs === null ? void 0 : options.waitTimeoutMs ?? config.polling.pollTimeoutMs);
		let outcome;
		try {
			reportProgress(options.onProgress, "waiting-for-parse");
			outcome = await pending.operation.waitForOutcome(wait.signal);
		} catch (error) {
			if (signal.aborted) throw signal.reason ?? error;
			if (wait.timedOut()) throw new MinerUError(failure("POLL_TIMEOUT", "Synchronous MinerU wait timed out; retry the same request to rejoin the shared operation", true));
			throw error;
		} finally {
			wait.dispose();
		}
		if (outcome.state === "failed" || outcome.resultId === void 0) throw new MinerUError(outcome.failure ?? failure("REMOTE_PARSE_FAILED", "Remote parse failed"));
		reportProgress(options.onProgress, "reading-result");
		const manifest = await this.options.results.get(pending.cacheKey, pending.prepared.request.requiredArtifacts, signal);
		if (manifest === void 0 || manifest.id !== outcome.resultId) throw new MinerUError(failure("CACHE_EVICTED", "Published MinerU result is missing or corrupt"));
		return {
			cacheKey: pending.cacheKey,
			manifest,
			source: pending.source,
			sourceFile: pending.prepared.request.files[0]
		};
	}
	async prepare(sourcePath, config, signal, cacheOnly) {
		const resolved = this.active(config);
		const source = await prepareSource(sourcePath, Math.min(config.limits.maxFileBytes, resolved.provider.capabilities.maxFileBytes ?? config.limits.maxFileBytes), signal);
		const prepared = {
			request: canonicalParseRequest(effectiveParseDefaults(config.defaults, resolved.config), source),
			sources: [source]
		};
		const file = prepared.request.files[0];
		validateProviderCapabilities(prepared.request, resolved.provider.capabilities);
		const compatibility = resolved.provider.compatibilityKey(prepared.request);
		const cacheKey = computeCacheKey(prepared.request, file, compatibility);
		const published = (manifest) => ({
			kind: "published",
			result: {
				cacheKey,
				manifest,
				source: "cache",
				sourceFile: file
			}
		});
		const hit = config.storage.cacheEnabled || cacheOnly ? await this.options.results.get(cacheKey, prepared.request.requiredArtifacts, signal) : void 0;
		if (hit !== void 0) {
			this.diagnostic({
				level: "info",
				phase: "cache-hit",
				provider: resolved.provider.id,
				bytes: file.bytes,
				cacheHit: true
			});
			return published(hit);
		}
		if (cacheOnly) throw new MinerUError(failure("CACHE_EVICTED", "Cursor result is missing or corrupt; restart without a cursor. Continuation never starts a new Provider parse."));
		const reservation = this.options.operations.reserve(cacheKey, resolved.config.id, config.polling.operationTimeoutMs);
		if (!reservation.created) return {
			kind: "operation",
			source: "shared-operation",
			operation: reservation.operation,
			prepared,
			cacheKey
		};
		try {
			const cached = config.storage.cacheEnabled ? await this.options.results.get(cacheKey, prepared.request.requiredArtifacts, signal) : void 0;
			if (cached !== void 0) {
				this.options.operations.start(reservation.operation, async () => ({
					state: "completed",
					resultId: cached.id
				}));
				return published(cached);
			}
			this.options.operations.start(reservation.operation, (operation) => this.options.accessGate.runShared(() => this.produce(operation, prepared, resolved, compatibility, config), operation.controller.signal));
		} catch (error) {
			this.options.operations.release(reservation.operation, error);
			throw error;
		}
		return {
			kind: "operation",
			source: "provider",
			operation: reservation.operation,
			prepared,
			cacheKey
		};
	}
	async produce(operation, prepared, resolved, compatibility, config) {
		let transaction;
		const startedAt = Date.now();
		const signal = operation.controller.signal;
		const requestBytes = prepared.request.files.reduce((total, source) => total + source.bytes, 0);
		const providerId = resolved.provider.id;
		try {
			const cached = config.storage.cacheEnabled ? await this.options.results.get(operation.cacheKey, prepared.request.requiredArtifacts, signal) : void 0;
			if (cached !== void 0) {
				this.diagnostic({
					level: "info",
					phase: "cache-hit",
					provider: providerId,
					operationId: operation.id,
					durationMs: Date.now() - startedAt,
					bytes: requestBytes,
					cacheHit: true,
					waiterCount: operation.waiterCount
				});
				return {
					state: "completed",
					resultId: cached.id
				};
			}
			await assertSourcesUnchanged(prepared.sources, signal);
			this.diagnostic({
				level: "info",
				phase: "uploading",
				provider: providerId,
				operationId: operation.id,
				bytes: requestBytes,
				waiterCount: operation.waiterCount
			});
			const call = () => this.callContext(resolved.config, config, signal, operation.id);
			const submission = await resolved.provider.submit(prepared.request, prepared.sources, await call());
			let snapshot = submission;
			this.diagnostic({
				level: snapshot.state === "failed" ? "warn" : "info",
				phase: "provider-accepted",
				provider: providerId,
				operationId: operation.id,
				bytes: requestBytes,
				waiterCount: operation.waiterCount
			});
			while (snapshot.state !== "completed" && snapshot.state !== "partially-completed") {
				if (snapshot.state === "failed") return {
					state: "failed",
					failure: snapshot.files.find((file) => file.failure)?.failure ?? failure("REMOTE_PARSE_FAILED", "Remote parse failed")
				};
				await setTimeout$1(config.polling.pollIntervalMs, void 0, { signal });
				snapshot = await resolved.provider.inspect(submission.ref, await call());
			}
			this.diagnostic({
				level: "info",
				phase: "collecting",
				provider: providerId,
				operationId: operation.id,
				durationMs: Date.now() - startedAt,
				bytes: requestBytes,
				waiterCount: operation.waiterCount
			});
			transaction = this.options.results.beginTransaction(operation.id, prepared.request, {
				providerId,
				providerConfigId: resolved.config.id,
				compatibilityKey: compatibility
			}, signal);
			const collection = await resolved.provider.collect(submission.ref, prepared.request, transaction, await call());
			const file = prepared.request.files[0];
			const collected = collection.files.find((candidate) => candidate.fileId === file.fileId);
			if (collected === void 0 || collected.failure !== void 0) {
				await transaction.abort();
				transaction = void 0;
				return {
					state: "failed",
					failure: collected?.failure ?? failure("REMOTE_PARSE_FAILED", "Provider did not collect the requested file")
				};
			}
			const manifest = transaction.buildManifest(file, collected.artifacts);
			const published = await this.options.results.commitTransaction(transaction, manifest, signal);
			transaction = void 0;
			this.diagnostic({
				level: "info",
				phase: "published",
				provider: providerId,
				operationId: operation.id,
				durationMs: Date.now() - startedAt,
				bytes: requestBytes,
				cacheHit: false,
				waiterCount: operation.waiterCount
			});
			return {
				state: "completed",
				resultId: published.resultId
			};
		} catch (error) {
			await transaction?.abort().catch(() => void 0);
			const normalized = toMinerUFailure(error);
			this.diagnostic({
				level: normalized.retryable ? "warn" : "error",
				phase: "failed",
				provider: providerId,
				operationId: operation.id,
				durationMs: Date.now() - startedAt,
				bytes: requestBytes,
				waiterCount: operation.waiterCount,
				errorCode: normalized.code,
				retryable: normalized.retryable
			});
			return {
				state: "failed",
				failure: normalized
			};
		}
	}
};
function waitSignal(signal, timeoutMs) {
	const controller = new AbortController();
	let didTimeOut = false;
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) controller.abort(signal.reason);
	const timer = timeoutMs === void 0 ? void 0 : setTimeout(() => {
		didTimeOut = true;
		controller.abort(new MinerUError(failure("POLL_TIMEOUT", "Synchronous MinerU wait timed out", true)));
	}, timeoutMs);
	timer?.unref?.();
	return {
		signal: controller.signal,
		timedOut: () => didTimeOut,
		dispose: () => {
			if (timer !== void 0) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}
//#endregion
//#region src/reader/document-index.ts
const MAX_DETAIL_WARNINGS = 19;
function diagnosticId(resultId, detail) {
	return `document-index:${createHash("sha256").update([
		resultId,
		String(detail.documentOrder),
		detail.code,
		detail.location,
		detail.message
	].join("\0")).digest("hex").slice(0, 24)}`;
}
var WarningCollector = class {
	resultId;
	orders;
	#details = [];
	#omitted = 0;
	#omissionScope;
	constructor(resultId, orders) {
		this.resultId = resultId;
		this.orders = orders;
	}
	forBlock(documentOrder, page) {
		const blockId = `${this.resultId}:b${String(documentOrder)}`;
		return { add: (code, location, message) => {
			if (this.orders !== void 0 && !this.orders.has(documentOrder)) return;
			const priority = /POSSIBLE_TEXT_GAP|CONFLICTING|UNKNOWN_NESTED|UNSUPPORTED_CONTENT/.test(code) ? 2 : /EMPTY_CONTENT/.test(code) ? 1 : 0;
			const detail = {
				code,
				location,
				message,
				priority,
				documentOrder,
				blockId,
				...page === void 0 ? {} : { page }
			};
			if (this.#details.length < MAX_DETAIL_WARNINGS) {
				this.#details.push(detail);
				return;
			}
			const lowest = Math.min(...this.#details.map((item) => item.priority));
			let omittedDetail = detail;
			if (priority > lowest) {
				const replacementIndex = this.#details.findIndex((item) => item.priority === lowest);
				omittedDetail = this.#details[replacementIndex];
				this.#details[replacementIndex] = detail;
			}
			this.#omitted++;
			this.#omissionScope ??= {
				documentOrder: omittedDetail.documentOrder,
				blockId: omittedDetail.blockId,
				...omittedDetail.page === void 0 ? {} : { page: omittedDetail.page }
			};
		} };
	}
	#sortedDetails() {
		return [...this.#details].sort((a, b) => b.priority - a.priority);
	}
	finish() {
		const details = this.#sortedDetails().map((detail) => `[${detail.code}] ${detail.location}: ${detail.message}`);
		if (this.#omitted === 0) return details;
		return [...details, `[DOCUMENT_INDEX_WARNINGS_OMITTED] ${String(this.#omitted)} additional normalization warning(s) omitted.`];
	}
	finishDiagnostics() {
		const diagnostics = this.#sortedDetails().map((detail) => ({
			id: diagnosticId(this.resultId, detail),
			code: detail.code,
			scope: "chunk",
			message: detail.message,
			block_id: detail.blockId,
			...detail.page === void 0 ? {} : { page: detail.page }
		}));
		if (this.#omitted === 0 || this.#omissionScope === void 0) return diagnostics;
		const message = `${String(this.#omitted)} additional normalization warning(s) omitted.`;
		const detail = {
			code: "DOCUMENT_INDEX_WARNINGS_OMITTED",
			location: `block ${String(this.#omissionScope.documentOrder)}`,
			message,
			priority: 0,
			documentOrder: this.#omissionScope.documentOrder,
			blockId: this.#omissionScope.blockId,
			...this.#omissionScope.page === void 0 ? {} : { page: this.#omissionScope.page }
		};
		return [...diagnostics, {
			id: diagnosticId(this.resultId, detail),
			code: detail.code,
			scope: "chunk",
			message,
			block_id: detail.blockId,
			...detail.page === void 0 ? {} : { page: detail.page }
		}];
	}
};
const KNOWN_BLOCK_TYPES = /* @__PURE__ */ new Set([
	"text",
	"title",
	"list",
	"header",
	"footer",
	"page_number",
	"page_footnote",
	"ref_text",
	"table",
	"image",
	"chart",
	"figure",
	"equation",
	"interline_equation",
	"inline_equation",
	"code"
]);
const POSSIBLE_TEXT_GAP_PATTERNS = [
	/中的\s+个/u,
	/(?:包含|通过率为|分别通过)\s+(?:个|和|，|；|。)/u,
	/其中，\s+表示可训练参数/u,
	/参考规约和\s+计算交叉熵/u,
	/批次大小为\s+，/u
];
function blockKind(type) {
	if (typeof type !== "string") return "text";
	const lower = type.toLowerCase();
	if (lower === "table" || lower.startsWith("table_")) return "table";
	if (lower === "image" || lower === "chart" || lower === "figure" || lower.startsWith("image_")) return "image";
	if (lower === "equation" || lower === "interline_equation" || lower === "inline_equation") return "equation";
	if (lower === "code") return "code";
	return "text";
}
function captionStrings(value) {
	if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}
/**
* Extract an author/provider supplied figure, table, or equation label.
*
* Only a label at the beginning of a relevant caption is accepted. This
* deliberately does not synthesize labels from the block's return position.
*/
function extractDocumentLabel(block) {
	const kind = blockKind(block.type);
	const captions = kind === "image" ? [
		...captionStrings(block.image_caption),
		...captionStrings(block.img_caption),
		...captionStrings(block.chart_caption),
		...captionStrings(block.caption)
	] : kind === "table" ? [...captionStrings(block.table_caption), ...captionStrings(block.caption)] : kind === "equation" ? [...captionStrings(block.equation_caption), ...captionStrings(block.caption)] : [];
	for (const caption of captions) {
		if (kind === "image") {
			const label = caption.match(/^\s*((?:figure|fig\.?|图)\s*(?:[A-Z]?\d+(?:[.-]\d+)*(?:\s*[（(][A-Za-z0-9]+[）)])?|[IVXLCDM]+|[一二三四五六七八九十百]+))(?=\s|[:：.、]|$)/iu)?.[1]?.trim();
			if (label !== void 0) return label;
			continue;
		}
		if (kind === "table") {
			const label = caption.match(/^\s*((?:table|tab\.?|表)\s*(?:[A-Z]?\d+(?:[.-]\d+)*(?:\s*[（(][A-Za-z0-9]+[）)])?|[IVXLCDM]+|[一二三四五六七八九十百]+))(?=\s|[:：.、]|$)/iu)?.[1]?.trim();
			if (label !== void 0) return label;
			continue;
		}
		if (kind === "equation") {
			const prefixed = caption.match(/^\s*((?:equation|eq\.?|公式|式)\s*(?:[（(]\s*[A-Za-z]?\d+(?:[.-]\d+)*\s*[）)]|[A-Za-z]?\d+(?:[.-]\d+)*))(?=\s|[:：.、]|$)/iu)?.[1];
			if (prefixed !== void 0) return prefixed.trim();
			const parenthesized = caption.match(/^\s*([（(]\s*[A-Za-z]?\d+(?:[.-]\d+)*\s*[）)])(?=\s|[:：.、]|$)/u)?.[1]?.trim();
			if (parenthesized !== void 0) return parenthesized;
		}
	}
}
function safeStringField(source, target, field, blockLocation, warnings) {
	const value = source[field];
	if (value === void 0) return void 0;
	if (typeof value === "string") return value;
	delete target[field];
	warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, `non-string ${field} was omitted`);
}
const CAPTION_FIELDS = [
	"table_caption",
	"table_footnote",
	"image_caption",
	"image_footnote",
	"img_caption",
	"img_footnote",
	"chart_caption",
	"chart_footnote",
	"equation_caption",
	"caption",
	"footnote"
];
function safeCaptionField(source, target, field, blockLocation, warnings) {
	const value = source[field];
	if (value === void 0) return void 0;
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) {
		delete target[field];
		warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, `non-string ${field} was omitted`);
		return;
	}
	const strings = value.filter((item) => typeof item === "string");
	if (strings.length !== value.length) {
		target[field] = strings;
		warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, `non-string ${field} item(s) were omitted`);
		return strings;
	}
	return value;
}
function contentFromListItems(value, target, blockLocation, warnings) {
	if (!Array.isArray(value)) {
		delete target.list_items;
		warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, "list_items is not an array; list content was omitted");
		return;
	}
	if (value.length === 0) {
		warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "list_items is empty");
		return;
	}
	const strings = [];
	for (let itemIndex = 0; itemIndex < value.length; itemIndex++) {
		const item = value[itemIndex];
		const itemLocation = `${blockLocation} list item ${String(itemIndex + 1)}`;
		if (typeof item !== "string") {
			warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", itemLocation, "list item is not a supported string; item was omitted");
			continue;
		}
		strings.push(item);
		if (item.length === 0) warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", itemLocation, "list item is empty");
	}
	if (strings.length !== value.length) target.list_items = strings;
	if (strings.length === 0) return void 0;
	return strings.join("\n");
}
function inlineEquation(content) {
	if (/^\$(?!\$)[\s\S]*\$$/u.test(content)) return content;
	if (/^\$\$[\s\S]*\$\$$/u.test(content)) return `$${content.slice(2, -2)}$`;
	return `$${content.match(/^\\\(([\s\S]*)\\\)$/u)?.[1] ?? content}$`;
}
function displayEquation(content) {
	if (/^\$\$[\s\S]*\$\$$/u.test(content)) return content;
	return `$$${content}$$`;
}
function nonBlank(value) {
	return value !== void 0 && value.trim().length > 0;
}
function preferNonBlank(...values) {
	return values.find(nonBlank) ?? values.find((value) => value !== void 0);
}
function comparableText(value) {
	return value.replace(/(?:\$\$|\$|\\\(|\\\)|\\\[|\\\])/gu, "").replace(/\s+/gu, "");
}
function contentFromNestedLines(lines, blockLocation, warnings) {
	if (!Array.isArray(lines)) {
		warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, "nested lines is not an array; nested content was omitted");
		return;
	}
	if (lines.length === 0) {
		warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "nested lines is empty");
		return;
	}
	const renderedLines = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const lineLocation = `${blockLocation} line ${String(lineIndex + 1)}`;
		const line = lines[lineIndex];
		if (typeof line !== "object" || line === null || Array.isArray(line)) {
			warnings.add("DOCUMENT_INDEX_UNKNOWN_NESTED_NODE", lineLocation, "line is not a supported object; line was omitted");
			continue;
		}
		const spans = line.spans;
		if (!Array.isArray(spans)) {
			warnings.add("DOCUMENT_INDEX_UNKNOWN_NESTED_NODE", lineLocation, "line has no spans array; line was omitted");
			continue;
		}
		if (spans.length === 0) {
			warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", lineLocation, "spans is empty");
			continue;
		}
		const pieces = [];
		for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
			const spanLocation = `${lineLocation} span ${String(spanIndex + 1)}`;
			const span = spans[spanIndex];
			if (typeof span !== "object" || span === null || Array.isArray(span)) {
				warnings.add("DOCUMENT_INDEX_UNKNOWN_NESTED_NODE", spanLocation, "span is not a supported object; span was omitted");
				continue;
			}
			const node = span;
			const type = node.type;
			if (typeof type !== "string") {
				warnings.add("DOCUMENT_INDEX_UNKNOWN_NESTED_NODE", spanLocation, "span has no string type; span was omitted");
				continue;
			}
			if (type !== "text" && type !== "inline_equation" && type !== "interline_equation" && type !== "equation" && type !== "code") {
				warnings.add("DOCUMENT_INDEX_UNKNOWN_NESTED_NODE", spanLocation, "unsupported span type; span was omitted");
				continue;
			}
			if (typeof node.content !== "string") {
				warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", spanLocation, "span content is not a string; span was omitted");
				continue;
			}
			if (node.content.length === 0) {
				warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", spanLocation, "span content is empty");
				continue;
			}
			if (type === "inline_equation") pieces.push(inlineEquation(node.content));
			else if (type === "interline_equation" || type === "equation") pieces.push(displayEquation(node.content));
			else pieces.push(node.content);
		}
		if (pieces.length > 0) renderedLines.push(pieces.join(""));
	}
	return renderedLines.length > 0 ? renderedLines.join("\n") : void 0;
}
/**
* Add stable document identities and faithfully expose known MinerU nested text.
* The input array and its blocks are never mutated.
*/
function normalizeDocumentBlockSubset(contentList, resultId, warningCollector, documentOrders) {
	return contentList.map((source, index) => {
		const documentOrder = documentOrders?.[index] ?? index + 1;
		const blockLocation = `block ${String(documentOrder)}`;
		const page = typeof source.page_idx === "number" && Number.isSafeInteger(source.page_idx) && source.page_idx >= 0 ? source.page_idx + 1 : void 0;
		const warnings = warningCollector.forBlock(documentOrder, page);
		const target = { ...source };
		delete target.document_label;
		if (source.type !== void 0 && typeof source.type !== "string") {
			delete target.type;
			warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, "non-string block type was omitted");
		} else if (typeof source.type === "string" && !KNOWN_BLOCK_TYPES.has(source.type.toLowerCase())) warnings.add("DOCUMENT_INDEX_UNKNOWN_BLOCK_TYPE", blockLocation, "unknown block type; only supported fields were projected, so textual coverage is not guaranteed");
		const text = safeStringField(source, target, "text", blockLocation, warnings);
		const content = safeStringField(source, target, "content", blockLocation, warnings);
		const code = safeStringField(source, target, "code", blockLocation, warnings);
		safeStringField(source, target, "language", blockLocation, warnings);
		const tableBody = safeStringField(source, target, "table_body", blockLocation, warnings);
		safeStringField(source, target, "img_path", blockLocation, warnings);
		safeStringField(source, target, "image_path", blockLocation, warnings);
		safeStringField(source, target, "path", blockLocation, warnings);
		const safeCaptions = {};
		for (const field of CAPTION_FIELDS) {
			const value = safeCaptionField(source, target, field, blockLocation, warnings);
			if (value !== void 0) safeCaptions[field] = value;
		}
		if (safeCaptions.image_caption === void 0) {
			const imageCaption = safeCaptions.img_caption ?? safeCaptions.chart_caption;
			if (imageCaption !== void 0) target.image_caption = imageCaption;
		}
		if (safeCaptions.image_footnote === void 0) {
			const imageFootnote = safeCaptions.img_footnote ?? safeCaptions.chart_footnote;
			if (imageFootnote !== void 0) target.image_footnote = imageFootnote;
		}
		const sourceType = typeof source.type === "string" ? source.type.toLowerCase() : void 0;
		const kind = blockKind(source.type);
		const listText = sourceType === "list" && source.list_items !== void 0 ? contentFromListItems(source.list_items, target, blockLocation, warnings) : void 0;
		const flatText = preferNonBlank(text, content);
		const selectedFlat = kind === "code" ? preferNonBlank(code, text, content) : kind === "table" ? preferNonBlank(tableBody, text, content) : flatText;
		let nestedText;
		if (source.lines !== void 0) {
			if (kind === "table") warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, "nested table lines cannot be losslessly normalized; raw fields were preserved");
			else {
				nestedText = contentFromNestedLines(source.lines, blockLocation, warnings);
				if (kind === "image" && nonBlank(nestedText)) warnings.add("DOCUMENT_INDEX_UNSUPPORTED_CONTENT", blockLocation, "nonempty nested image text was not merged; verify the original page");
			}
		}
		if (kind !== "table" && kind !== "image") {
			if (nonBlank(selectedFlat)) {
				if (kind === "code") target.code = selectedFlat;
				else target.text = selectedFlat;
				if (nonBlank(listText) && comparableText(selectedFlat) !== comparableText(listText)) warnings.add("DOCUMENT_INDEX_CONFLICTING_CONTENT", blockLocation, "nonempty flat and list text differ; flat content was kept");
				if (nonBlank(nestedText) && comparableText(selectedFlat) !== comparableText(nestedText)) warnings.add("DOCUMENT_INDEX_CONFLICTING_CONTENT", blockLocation, "nonempty flat and nested text differ; flat content was kept");
			} else if (nonBlank(listText)) {
				target.text = listText;
				if (nonBlank(nestedText) && comparableText(listText) !== comparableText(nestedText)) warnings.add("DOCUMENT_INDEX_CONFLICTING_CONTENT", blockLocation, "nonempty list and nested text differ; list content was kept");
			} else if (nonBlank(nestedText)) {
				if (kind === "code") target.code = nestedText;
				else target.text = nestedText;
			} else if (selectedFlat !== void 0) warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "flat textual content is empty");
			else if (source.lines === void 0) warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "no supported textual content was present");
			else warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "no supported textual content was recovered");
		} else if (kind === "table" && !nonBlank(selectedFlat)) {
			if (selectedFlat !== void 0) warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "flat textual content is empty");
			else if (source.lines === void 0) warnings.add("DOCUMENT_INDEX_EMPTY_CONTENT", blockLocation, "no supported textual content was present");
		}
		const normalizedProse = typeof target.text === "string" ? target.text : typeof target.content === "string" ? target.content : void 0;
		if ((sourceType === void 0 || sourceType === "text" || sourceType === "title") && normalizedProse !== void 0 && POSSIBLE_TEXT_GAP_PATTERNS.some((pattern) => pattern.test(normalizedProse))) warnings.add("DOCUMENT_INDEX_POSSIBLE_TEXT_GAP", blockLocation, "possible missing value detected; verify the original page");
		const documentLabel = extractDocumentLabel(source);
		return {
			...target,
			block_id: `${resultId}:b${String(documentOrder)}`,
			...documentLabel === void 0 ? {} : { document_label: documentLabel },
			document_order: documentOrder
		};
	});
}
/**
* Add stable document identities and faithfully expose known MinerU content.
* The input array and its blocks are never mutated.
*/
function normalizeDocumentBlocks(contentList, resultId, warningBlockOrders) {
	const warnings = new WarningCollector(resultId, warningBlockOrders);
	return {
		blocks: normalizeDocumentBlockSubset(contentList, resultId, warnings),
		warnings: warnings.finish()
	};
}
/** Diagnose only selected one-based original-order blocks without renumbering. */
function collectBlockDiagnostics(contentList, resultId, orders) {
	const selectedBlocks = [];
	const selectedOrders = [];
	for (let index = 0; index < contentList.length; index++) {
		const documentOrder = index + 1;
		if (!orders.has(documentOrder)) continue;
		selectedBlocks.push(contentList[index]);
		selectedOrders.push(documentOrder);
	}
	const diagnostics = new WarningCollector(resultId);
	normalizeDocumentBlockSubset(selectedBlocks, resultId, diagnostics, selectedOrders);
	return diagnostics.finishDiagnostics();
}
//#endregion
//#region src/reader/image-policy.ts
/** Internal image attachment byte policy (no model-facing options). */
/** Total decoded byte budget across one read response. */
const MAX_INLINE_IMAGE_TOTAL_BYTES = 25165824;
/** Per-image decoded byte budget. */
const MAX_INLINE_IMAGE_SINGLE_BYTES = 8388608;
/** Map a file extension to a supported raster media type, or undefined when unsupported. */
function mediaTypeForExtension(ext) {
	switch (ext.toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		case ".png": return "image/png";
		default: return;
	}
}
//#endregion
//#region src/utils/bounded-read.ts
/** Callers map the failure stage to their own domain error; bytesRead supports budget accounting. */
var BoundedReadError = class extends Error {
	reason;
	bytesRead;
	constructor(reason, bytesRead, options) {
		super("bounded file read failed: " + reason, options);
		this.reason = reason;
		this.bytesRead = bytesRead;
		this.name = "BoundedReadError";
	}
};
function sameVersion$1(left, right) {
	return right.isFile() && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
/**
* Read one regular file through a no-follow descriptor. The size is fixed by fstat
* before reading, and the descriptor must be unchanged after the last byte.
* Open failures and cancellation propagate unchanged.
*/
async function readFileBounded(path, limits, signal) {
	signal?.throwIfAborted();
	if (limits.expectedBytes !== void 0 && limits.expectedBytes > limits.maxBytes) throw new BoundedReadError("too-large", 0);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytesRead = 0;
	let result;
	let failure;
	try {
		const before = await handle.stat({ bigint: true });
		const size = Number(before.size);
		if (!before.isFile()) throw new BoundedReadError("not-file", 0);
		if (size > limits.maxBytes) throw new BoundedReadError("too-large", 0);
		if (limits.expectedBytes !== void 0 && size !== limits.expectedBytes) throw new BoundedReadError("size-mismatch", 0);
		const buffer = Buffer.alloc(size);
		while (bytesRead < size) {
			signal?.throwIfAborted();
			let read;
			try {
				read = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead);
			} catch (error) {
				throw new BoundedReadError("io", bytesRead, { cause: error });
			}
			bytesRead += read.bytesRead;
			if (read.bytesRead === 0) throw new BoundedReadError("short-read", bytesRead);
		}
		signal?.throwIfAborted();
		let after;
		try {
			after = await handle.stat({ bigint: true });
		} catch (error) {
			throw new BoundedReadError("io", bytesRead, { cause: error });
		}
		if (!sameVersion$1(before, after)) throw new BoundedReadError("changed", bytesRead);
		result = buffer;
	} catch (error) {
		failure = error;
	}
	try {
		await handle.close();
	} catch (error) {
		throw new BoundedReadError("io", bytesRead, { cause: error });
	}
	if (result === void 0) throw failure;
	return result;
}
//#endregion
//#region src/reader/page/pdfjs-backend.ts
const PDFJS_WORKER_URL = new URL("./pdfjs-worker.mjs", import.meta.url);
const PDFJS_MAX_OLD_SPACE_MIB = 512;
const MAX_PAGE_NUMBER = 1e6;
function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(name + " must be a positive safe integer");
	return String(value);
}
function pathArgument(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(name + " must be a non-empty path");
	return value;
}
/**
* Build fixed Node arguments for the local PDF.js renderer. The final four
* arguments are the worker protocol: snapshot, output, page, and byte limit.
*/
function buildPdfjsArgs(snapshotPath, outputPath, page, maxFileBytes) {
	return [
		"--max-old-space-size=" + String(PDFJS_MAX_OLD_SPACE_MIB),
		"--disallow-code-generation-from-strings",
		"--no-warnings",
		fileURLToPath(PDFJS_WORKER_URL),
		pathArgument(snapshotPath, "snapshotPath"),
		pathArgument(outputPath, "outputPath"),
		positiveInteger(page, "page", MAX_PAGE_NUMBER),
		positiveInteger(maxFileBytes, "maxFileBytes")
	];
}
//#endregion
//#region src/reader/page/page-renderer.ts
/** Aspect-preserving Poppler target: the longer page edge is capped at 1600 pixels. */
const PDF_PAGE_MAX_LONG_EDGE = 1600;
const MAX_RENDERED_PNG_BYTES = 8388608;
const MAX_PDFINFO_STDOUT_BYTES = 65536;
const MAX_PROCESS_STDERR_BYTES = 16384;
const MAX_RENDER_STDOUT_BYTES = 4096;
const MAX_PAGE_COUNT = 1e6;
const PNG_SIGNATURE = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
var ProcessFailure = class extends Error {
	kind;
	constructor(kind, message, options) {
		super(message, options);
		this.kind = kind;
		this.name = "PdfPageProcessFailure";
	}
};
var Semaphore = class {
	limit;
	active = 0;
	waiters = [];
	constructor(limit) {
		this.limit = limit;
	}
	acquire(signal) {
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve(this.makeRelease());
		}
		return new Promise((resolvePromise, rejectPromise) => {
			const waiter = {
				signal,
				resolve: resolvePromise,
				reject: rejectPromise,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					rejectPromise(signal.reason);
				}
			};
			this.waiters.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}
	makeRelease() {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift();
				waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal.aborted) {
					waiter.reject(waiter.signal.reason);
					continue;
				}
				waiter.resolve(this.makeRelease());
				return;
			}
			this.active -= 1;
		};
	}
};
function killChild(child) {
	try {
		child.kill("SIGKILL");
	} catch {}
}
/**
* Allow-listed renderer environment. `TZ=UTC` keeps Poppler's localized time-zone
* names (printed in the system code page on Windows, which ignores LC_ALL) out of
* pdfinfo date fields; no other host variable is inherited besides PATH.
*/
function rendererEnvironment(path = process.env.PATH) {
	return {
		PATH: path ?? "",
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC"
	};
}
/** Spawn a fixed local renderer command without a shell; settle only after child close/reaping. */
const runPdfPageProcess = (request) => new Promise((resolvePromise, rejectPromise) => {
	request.signal.throwIfAborted();
	let child;
	try {
		child = spawn(request.command === "pdfjs" ? process.execPath : request.command, [...request.args], {
			cwd: request.cwd,
			env: rendererEnvironment(),
			shell: false,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
	} catch (error) {
		rejectPromise(error);
		return;
	}
	const stdout = [];
	const stderr = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let terminalError;
	let watching = false;
	const failAndKill = (error) => {
		if (terminalError !== void 0) return;
		terminalError = error;
		killChild(child);
	};
	const capture = (target, kind, raw) => {
		if (terminalError !== void 0) return;
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		if (kind === "stdout") stdoutBytes += chunk.byteLength;
		else stderrBytes += chunk.byteLength;
		if ((kind === "stdout" ? stdoutBytes : stderrBytes) > (kind === "stdout" ? request.maxStdoutBytes : request.maxStderrBytes)) {
			failAndKill(new ProcessFailure("output-limit", request.command + " " + kind + " exceeded its byte limit"));
			return;
		}
		target.push(chunk);
	};
	child.stdout?.on("data", (chunk) => capture(stdout, "stdout", chunk));
	child.stderr?.on("data", (chunk) => capture(stderr, "stderr", chunk));
	child.once("error", (error) => failAndKill(error));
	const onAbort = () => failAndKill(request.signal.reason);
	request.signal.addEventListener("abort", onAbort, { once: true });
	if (request.signal.aborted) onAbort();
	const timeout = setTimeout(() => {
		failAndKill(new ProcessFailure("timeout", request.command + " exceeded its runtime limit"));
	}, request.timeoutMs);
	timeout.unref();
	const outputWatch = request.watchedOutput === void 0 ? void 0 : setInterval(() => {
		if (watching || terminalError !== void 0) return;
		watching = true;
		stat(request.watchedOutput.path).then((info) => {
			if (info.size > request.watchedOutput.maxBytes) failAndKill(new ProcessFailure("output-limit", "Rendered PNG exceeded its byte limit"));
		}, (error) => {
			if (errorCode(error) !== "ENOENT") failAndKill(new ProcessFailure("output-io", "Failed to inspect rendered output", { cause: error }));
		}).finally(() => {
			watching = false;
		});
	}, 25);
	outputWatch?.unref();
	child.once("close", (exitCode, signal) => {
		clearTimeout(timeout);
		if (outputWatch !== void 0) clearInterval(outputWatch);
		request.signal.removeEventListener("abort", onAbort);
		if (terminalError !== void 0) {
			rejectPromise(terminalError);
			return;
		}
		resolvePromise({
			exitCode,
			signal,
			stdout: Buffer.concat(stdout, stdoutBytes),
			stderr: Buffer.concat(stderr, stderrBytes)
		});
	});
});
function errorCode(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return void 0;
	return typeof error.code === "string" ? error.code : void 0;
}
function invalid$1(message, cause) {
	return new MinerUError(failure("INVALID_REQUEST", message), cause === void 0 ? void 0 : { cause });
}
function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}
function sameVersion(left, right) {
	return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function checkedPathStat(path, name) {
	let info;
	try {
		info = await lstat(path, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") throw new MinerUError(failure("FILE_NOT_FOUND", "PDF does not exist: " + name), { cause: error });
		throw error;
	}
	if (info.isSymbolicLink()) throw invalid$1("PDF source must not be a symbolic link: " + name);
	if (!info.isFile()) throw invalid$1("PDF source is not a regular file: " + name);
	return info;
}
async function openCheckedSource(path, name, maxFileBytes) {
	const before = await checkedPathStat(path, name);
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (errorCode(error) === "ENOENT") throw new MinerUError(failure("FILE_NOT_FOUND", "PDF does not exist: " + name), { cause: error });
		if (errorCode(error) === "ELOOP") throw invalid$1("PDF source must not be a symbolic link: " + name, error);
		throw error;
	}
	try {
		const opened = await handle.stat({ bigint: true });
		const afterOpen = await checkedPathStat(path, name);
		if (!opened.isFile() || !sameIdentity(before, opened) || !sameIdentity(opened, afterOpen)) throw invalid$1("PDF source changed while it was being opened: " + name);
		if (opened.size > BigInt(maxFileBytes)) throw new MinerUError(failure("FILE_TOO_LARGE", name + " exceeds the configured file-size limit"));
		return {
			handle,
			initial: opened
		};
	} catch (error) {
		await handle.close();
		throw error;
	}
}
async function snapshotSource(sourcePath, snapshotPath, sourceName, maxFileBytes, signal) {
	const { handle, initial } = await openCheckedSource(sourcePath, sourceName, maxFileBytes);
	const hash = createHash("sha256");
	let bytes = 0;
	const limiter = new Transform({ transform(chunk, _encoding, callback) {
		bytes += chunk.byteLength;
		if (bytes > maxFileBytes) {
			callback(new MinerUError(failure("FILE_TOO_LARGE", sourceName + " exceeds the configured file-size limit")));
			return;
		}
		hash.update(chunk);
		callback(null, chunk);
	} });
	try {
		await pipeline(handle.createReadStream({ autoClose: false }), limiter, createWriteStream(snapshotPath, {
			flags: "wx",
			mode: 384
		}), { signal });
		signal.throwIfAborted();
		const finalHandle = await handle.stat({ bigint: true });
		let finalPath;
		try {
			finalPath = await checkedPathStat(sourcePath, sourceName);
		} catch (error) {
			throw invalid$1("PDF source changed while it was being copied: " + sourceName, error);
		}
		if (!sameVersion(initial, finalHandle) || !sameVersion(finalHandle, finalPath) || BigInt(bytes) !== initial.size) throw invalid$1("PDF source changed while it was being copied: " + sourceName);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}
function boundedProcessResult(result, request) {
	if (result.stdout.byteLength > request.maxStdoutBytes || result.stderr.byteLength > request.maxStderrBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", request.command + " output exceeded its byte limit"));
	return result;
}
async function invokeProcess(runProcess, request) {
	try {
		return boundedProcessResult(await runProcess(request), request);
	} catch (error) {
		if (request.signal.aborted) throw request.signal.reason;
		if (error instanceof MinerUError) throw error;
		if ([
			"ENOENT",
			"EACCES",
			"EPERM",
			"ENOEXEC",
			"ENOSYS"
		].includes(errorCode(error) ?? "")) throw new RendererUnavailable();
		if (error instanceof ProcessFailure && error.kind === "output-limit") throw new MinerUError(failure("RESULT_TOO_LARGE", request.command + " output exceeded its byte limit"), { cause: error });
		if (error instanceof ProcessFailure && error.kind === "timeout") throw new MinerUError(failure("PROVIDER_UNAVAILABLE", request.command + " exceeded its runtime limit", true), { cause: error });
		throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "Failed to execute local " + request.command, true), { cause: error });
	}
}
/** Only dependency/execution-environment failures qualify for backend selection. */
var RendererUnavailable = class extends Error {};
function unavailableRenderers() {
	return new MinerUError(failure("UNSUPPORTED_OPTION", "Local PDF page rendering is unavailable: install Poppler (pdfinfo and pdftoppm) or reinstall the plugin with PDF.js and @napi-rs/canvas platform optional dependencies enabled on a supported Node/platform combination."));
}
function parsePdfjsPageCount(result) {
	if (result.signal !== null) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "PDF.js page renderer exited unexpectedly", true));
	if (result.exitCode === 20) throw unavailableRenderers();
	if (result.exitCode === 22) throw new MinerUError(failure("RESULT_TOO_LARGE", "PDF.js page rendering exceeded a resource limit"));
	if (result.exitCode === 21) throw invalid$1("PDF.js could not inspect or render the requested PDF page (invalid, encrypted, unsupported PDF, or page out of range)");
	if (result.exitCode !== 0) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "PDF.js page renderer exited unexpectedly", true));
	let parsed;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
	} catch {
		throw invalid$1("PDF.js returned invalid page metadata");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("page_count" in parsed) || !Number.isSafeInteger(parsed.page_count) || typeof parsed.page_count !== "number" || parsed.page_count < 1 || parsed.page_count > MAX_PAGE_COUNT) throw invalid$1("PDF.js returned invalid page metadata");
	return parsed.page_count;
}
/**
* Only the ASCII `Pages:` line is consumed. Latin-1 maps every byte to one
* character and cannot fail, so unrelated fields in a local code page (for
* example a CreationDate time-zone name on non-English Windows) are inert.
*/
function parsePageCount(stdout) {
	const matches = [...Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength).toString("latin1").matchAll(/^Pages:\s+([1-9][0-9]{0,6})\s*$/gm)];
	if (matches.length !== 1) throw invalid$1("pdfinfo did not return one valid physical page count");
	const pages = Number(matches[0][1]);
	if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGE_COUNT) throw invalid$1("PDF physical page count is outside the supported range");
	return pages;
}
async function readRenderedPng(path) {
	try {
		return await readFileBounded(path, { maxBytes: MAX_RENDERED_PNG_BYTES });
	} catch (error) {
		if (errorCode(error) === "ENOENT") throw invalid$1("Page renderer did not produce the requested PNG", error);
		if (!(error instanceof BoundedReadError)) throw error;
		if (error.reason === "io") throw error.cause;
		if (error.reason === "not-file") throw invalid$1("Rendered PNG is not a regular file");
		if (error.reason === "too-large") throw new MinerUError(failure("RESULT_TOO_LARGE", "Rendered PNG exceeds its byte limit"));
		throw invalid$1("Rendered PNG changed while it was being read");
	}
}
function pngDimensions(data) {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw invalid$1("Page renderer returned an invalid PNG");
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (width < 1 || height < 1 || width > 1600 || height > 2e3 || Math.max(width, height) > 1600 || width * height > 32e5) throw new MinerUError(failure("RESULT_TOO_LARGE", "Rendered PNG dimensions exceed the page-rendering limit"));
	let offset = 8;
	let imageData = false;
	let ended = false;
	let chunks = 0;
	while (offset < bytes.length) {
		if (++chunks > 65536 || bytes.length - offset < 12) throw invalid$1("Page renderer returned a malformed PNG");
		const length = bytes.readUInt32BE(offset);
		if (length > bytes.length - offset - 12) throw invalid$1("Page renderer returned a truncated PNG");
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || offset !== 8 && type === "IHDR") throw invalid$1("Page renderer returned a malformed PNG");
		if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw invalid$1("Page renderer returned a PNG with an invalid checksum");
		if (type === "IDAT") imageData ||= length > 0;
		offset += length + 12;
		if (type === "IEND") {
			if (length !== 0 || !imageData || offset !== bytes.length) throw invalid$1("Page renderer returned a malformed PNG");
			ended = true;
			break;
		}
	}
	if (!ended) throw invalid$1("Page renderer returned an incomplete PNG");
	return {
		width,
		height
	};
}
function outputName(sourceName, page) {
	const extension = extname(sourceName);
	return (basename(sourceName, extension).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160) || "document") + "-page-" + String(page) + ".png";
}
function normalizeFailure(error, timedOut) {
	if (error instanceof MinerUError) return error;
	if (timedOut || error instanceof DOMException && error.name === "TimeoutError") return new MinerUError(failure("PROVIDER_UNAVAILABLE", "PDF page rendering exceeded its runtime limit", true), { cause: error });
	if (error instanceof DOMException && error.name === "AbortError") return new MinerUError(failure("CANCELLED", "PDF page rendering was cancelled", true), { cause: error });
	return new MinerUError(failure("PROVIDER_UNAVAILABLE", "Local PDF page rendering failed", true), { cause: error });
}
function createPdfPageRenderer(dependencies = {}) {
	const runProcess = dependencies.runProcess ?? runPdfPageProcess;
	const temporaryRoot = dependencies.temporaryRoot ?? tmpdir();
	const maxConcurrency = dependencies.maxConcurrency ?? 2;
	const runtimeMs = dependencies.runtimeMs ?? 45e3;
	const removeTemporaryDirectory = dependencies.removeTemporaryDirectory ?? ((path) => rm(path, {
		recursive: true,
		force: true,
		maxRetries: 2
	}));
	if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new TypeError("maxConcurrency must be an integer between 1 and 32");
	if (!Number.isSafeInteger(runtimeMs) || runtimeMs < 1) throw new TypeError("runtimeMs must be a positive safe integer");
	const semaphore = new Semaphore(maxConcurrency);
	return async (input) => {
		const sourcePath = input.file_path;
		if (!isAbsolute(sourcePath)) throw new TypeError("Source path must be absolute");
		const sourceName = basename(sourcePath);
		if (extname(sourceName).toLowerCase() !== ".pdf") throw new MinerUError(failure("UNSUPPORTED_OPTION", "Original-page rendering supports PDF files only"));
		const expiresAt = performance.now() + runtimeMs;
		let timedOut = false;
		const operation = new AbortController();
		const onAbort = () => operation.abort(new DOMException("PDF page rendering was cancelled", "AbortError"));
		input.signal.addEventListener("abort", onAbort, { once: true });
		if (input.signal.aborted) onAbort();
		const deadline = setTimeout(() => {
			if (operation.signal.aborted) return;
			timedOut = true;
			operation.abort(new DOMException("PDF page rendering timed out", "TimeoutError"));
		}, runtimeMs);
		deadline.unref();
		const remainingMs = (cap = runtimeMs) => {
			operation.signal.throwIfAborted();
			const remaining = Math.ceil(expiresAt - performance.now());
			if (remaining <= 0) {
				timedOut = true;
				operation.abort(new DOMException("PDF page rendering timed out", "TimeoutError"));
				operation.signal.throwIfAborted();
			}
			return Math.min(cap, remaining);
		};
		let release;
		let temporaryDirectory;
		let outcome;
		let primaryFailure;
		let cleanupFailed = false;
		try {
			release = await semaphore.acquire(operation.signal);
			operation.signal.throwIfAborted();
			temporaryDirectory = await mkdtemp(join(temporaryRoot, "dsh-pdf-page-"));
			const snapshotPath = join(temporaryDirectory, "source.pdf");
			const outputPrefix = join(temporaryDirectory, "page");
			const outputPath = outputPrefix + ".png";
			const sha256 = await snapshotSource(sourcePath, snapshotPath, sourceName, input.maxFileBytes, operation.signal);
			if (input.expectedSha256 !== void 0 && sha256 !== input.expectedSha256.toLowerCase()) throw invalid$1("PDF source hash does not match expectedSha256: " + sourceName);
			let renderer = "poppler";
			let pageCount;
			try {
				const info = await invokeProcess(runProcess, {
					command: "pdfinfo",
					args: [
						"-enc",
						"UTF-8",
						snapshotPath
					],
					cwd: temporaryDirectory,
					signal: operation.signal,
					timeoutMs: remainingMs(1e4),
					maxStdoutBytes: MAX_PDFINFO_STDOUT_BYTES,
					maxStderrBytes: MAX_PROCESS_STDERR_BYTES
				});
				remainingMs();
				if (info.signal !== null || info.exitCode === 2) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "pdfinfo exited unexpectedly or encountered local output I/O failure", true));
				if (info.exitCode !== 0) throw invalid$1("pdfinfo could not inspect the PDF");
				pageCount = parsePageCount(info.stdout);
				if (input.page > pageCount) throw invalid$1("PDF page " + String(input.page) + " is outside the physical page range 1-" + String(pageCount));
				const rendered = await invokeProcess(runProcess, {
					command: "pdftoppm",
					args: [
						"-f",
						String(input.page),
						"-l",
						String(input.page),
						"-singlefile",
						"-png",
						"-scale-to",
						String(PDF_PAGE_MAX_LONG_EDGE),
						snapshotPath,
						outputPrefix
					],
					cwd: temporaryDirectory,
					signal: operation.signal,
					timeoutMs: remainingMs(3e4),
					maxStdoutBytes: MAX_RENDER_STDOUT_BYTES,
					maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
					watchedOutput: {
						path: outputPath,
						maxBytes: MAX_RENDERED_PNG_BYTES
					}
				});
				remainingMs();
				if (rendered.signal !== null || rendered.exitCode === 2) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "pdftoppm exited unexpectedly or encountered local output I/O failure", true));
				if (rendered.exitCode !== 0) throw invalid$1("pdftoppm could not render the requested PDF page");
			} catch (error) {
				remainingMs();
				if (!(error instanceof RendererUnavailable)) throw error;
				renderer = "pdfjs";
				let rendered;
				try {
					rendered = await invokeProcess(runProcess, {
						command: "pdfjs",
						args: buildPdfjsArgs(snapshotPath, outputPath, input.page, input.maxFileBytes),
						cwd: temporaryDirectory,
						signal: operation.signal,
						timeoutMs: remainingMs(),
						maxStdoutBytes: MAX_RENDER_STDOUT_BYTES,
						maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
						watchedOutput: {
							path: outputPath,
							maxBytes: MAX_RENDERED_PNG_BYTES
						}
					});
				} catch (fallbackError) {
					remainingMs();
					if (fallbackError instanceof RendererUnavailable) throw unavailableRenderers();
					throw fallbackError;
				}
				remainingMs();
				pageCount = parsePdfjsPageCount(rendered);
				if (input.page > pageCount) throw invalid$1("PDF page is outside the physical page range");
			}
			operation.signal.throwIfAborted();
			const data = await readRenderedPng(outputPath);
			const dimensions = pngDimensions(data);
			remainingMs();
			outcome = {
				renderer,
				name: outputName(sourceName, input.page),
				page: input.page,
				page_count: pageCount,
				sha256,
				data,
				media_type: "image/png",
				width: dimensions.width,
				height: dimensions.height
			};
		} catch (error) {
			primaryFailure = normalizeFailure(error, timedOut);
		} finally {
			try {
				if (temporaryDirectory !== void 0) await removeTemporaryDirectory(temporaryDirectory);
			} catch {
				cleanupFailed = true;
				emitDiagnostic(dependencies.diagnostics, {
					level: "warn",
					phase: "failed",
					errorCode: "PROVIDER_UNAVAILABLE",
					retryable: true
				});
			} finally {
				release?.();
				clearTimeout(deadline);
				input.signal.removeEventListener("abort", onAbort);
			}
		}
		if (primaryFailure !== void 0) throw primaryFailure;
		try {
			remainingMs();
		} catch (error) {
			throw normalizeFailure(error, timedOut);
		}
		if (cleanupFailed) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "Failed to remove temporary PDF page-rendering data", true));
		if (outcome === void 0) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "Local PDF page rendering produced no result", true));
		return outcome;
	};
}
const renderPdfPage = createPdfPageRenderer();
//#endregion
//#region src/reader/projection.ts
/** Block and Markdown projection into model text. Projected bytes feed cursor identity: keep them stable. */
function getBlockCategory(type) {
	if (!type) return "text";
	const lower = type.toLowerCase();
	if (lower === "table" || lower.startsWith("table_")) return "table";
	if (lower === "image" || lower === "chart" || lower === "figure" || lower.startsWith("image_")) return "image";
	return "text";
}
function formatCaption(caption) {
	if (typeof caption === "string") return caption.trim();
	if (Array.isArray(caption)) return caption.map((c) => typeof c === "string" ? c.trim() : String(c)).filter(Boolean).join(" ");
	return "";
}
function formatTocMarkdown(headings, options, ranges) {
	if (!headings || headings.length === 0) return options?.pageRange ? `*(No headings found in pages: ${options.pageRange})*` : "*(No headings detected in document outline)*";
	const lines = ["# Document Outline", ""];
	let nextOffset = 20;
	for (const heading of headings) {
		const indent = "  ".repeat(Math.max(0, heading.level - 1));
		const location = heading.page !== void 0 ? ` (Page ${String(heading.page)})` : heading.line !== void 0 ? ` (line ${String(heading.line)})` : "";
		const label = heading.block_id ? " [" + heading.block_id + "]" : "";
		const line = `${indent}- ${heading.title}${location}${label}`;
		if (heading.block_id && ranges) {
			const end = nextOffset + line.length;
			const markerStart = end - label.length + 1;
			const coordinates = {
				block_id: heading.block_id,
				...heading.page === void 0 ? {} : { page: heading.page }
			};
			ranges.push({
				...coordinates,
				start: nextOffset,
				locator_end: nextOffset,
				end: markerStart
			});
			ranges.push({
				...coordinates,
				start: markerStart,
				locator_end: end,
				end
			});
		}
		lines.push(line);
		nextOffset += line.length + 1;
	}
	return lines.join("\n");
}
/** Resolve an image reference to one artifact: a unique exact suffix, else a unique basename. */
function matchImageArtifact(rawPath, imageArtifacts) {
	const reference = String(rawPath).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
	const exact = imageArtifacts.filter((a) => {
		const candidate = a.path.replaceAll("\\", "/");
		return candidate === reference || candidate.endsWith("/" + reference);
	});
	const base = basename(reference).toLowerCase();
	const byBase = imageArtifacts.filter((a) => basename(a.path).toLowerCase() === base);
	const artifact = exact.length === 1 ? exact[0] : exact.length === 0 && byBase.length === 1 ? byBase[0] : void 0;
	return {
		reference,
		...artifact === void 0 ? {} : { artifact }
	};
}
/** Render already-selected blocks in order, recording each block's text range and image candidates. */
function extractBlocksMarkdown(contentList, imageArtifacts) {
	const orderedImages = [];
	const renderedBlocks = [];
	const ranges = [];
	let renderedLength = 0;
	const append = (text) => {
		renderedLength += text.length + (renderedBlocks.length ? 2 : 0);
		renderedBlocks.push(text);
	};
	for (const block of contentList) {
		const pageNum = typeof block.page_idx === "number" && Number.isSafeInteger(block.page_idx) && block.page_idx >= 0 ? block.page_idx + 1 : void 0;
		const cat = getBlockCategory(block.type);
		const rangeStart = renderedLength + (renderedBlocks.length ? 2 : 0);
		if (block.block_id !== void 0) append(`[${block.block_id}${pageNum === void 0 ? "" : " · Page " + pageNum}${block.document_label ? " · " + block.document_label : ""}]`);
		const locatorEnd = renderedLength;
		if (cat === "image") {
			const rawPath = block.img_path ?? block.image_path ?? block.path;
			const matched = rawPath === void 0 ? void 0 : matchImageArtifact(rawPath, imageArtifacts).artifact;
			const caption = formatCaption(block.image_caption ?? block.caption);
			let imgName = "image";
			let imgBytes = 0;
			let imgPath = "";
			let mediaType;
			if (matched) {
				imgPath = matched.path;
				imgBytes = matched.bytes;
				imgName = basename(matched.path);
				mediaType = mediaTypeForExtension(extname(matched.path));
			}
			const imgIdx = orderedImages.length + 1;
			const status = matched === void 0 ? "unavailable" : mediaType === void 0 ? "unsupported" : "available";
			orderedImages.push({
				...block.block_id ? { block_id: block.block_id } : {},
				...block.document_label ? { document_label: block.document_label } : {},
				path: imgPath,
				name: imgName,
				...pageNum !== void 0 ? { page: pageNum } : {},
				...caption ? { caption } : {},
				media_type: mediaType ?? "application/octet-stream",
				bytes: imgBytes,
				status
			});
			const imageLabel = block.document_label ?? (block.block_id ? "Image" : "Image " + String(imgIdx));
			const pageLabel = pageNum === void 0 ? "" : " (Page " + String(pageNum) + ")";
			let md = "> " + imageLabel + pageLabel + (mediaType === void 0 || imgPath === "" ? " unavailable" : "") + (caption ? ": " + caption : "");
			const footnote = formatCaption(block.image_footnote ?? block.footnote);
			if (footnote) md += `\n> *${footnote}*`;
			append(md);
		} else if (cat === "table") {
			const caption = formatCaption(block.table_caption ?? block.caption);
			const body = String(block.table_body ?? block.text ?? block.content ?? "").trim();
			const footnote = formatCaption(block.table_footnote ?? block.footnote);
			let md = "";
			if (caption) md += `**${caption}**\n\n`;
			if (body) md += body;
			if (footnote) md += `\n\n*${footnote}*`;
			if (md.trim()) append(md.trim());
		} else {
			const lower = (block.type ?? "").toLowerCase();
			if (lower === "code") {
				const lang = String(block.language ?? "").trim();
				const code = String(block.code ?? block.text ?? block.content ?? "");
				if (code.trim().startsWith("```")) append(code.trim());
				else append(`\`\`\`${lang}\n${code}\n\`\`\``);
			} else if (lower === "equation" || lower === "interline_equation") {
				const eq = String(block.text ?? block.content ?? "").trim();
				if (eq.startsWith("$$") || eq.startsWith("$")) append(eq);
				else append(`$$\n${eq}\n$$`);
			} else {
				const text = String(block.text ?? block.content ?? "").trim();
				const level = typeof block.text_level === "number" && block.text_level >= 1 && block.text_level <= 6 ? block.text_level : void 0;
				if (level !== void 0 && !text.startsWith("#")) append(`${"#".repeat(level)} ${text}`);
				else if (text) append(text);
			}
		}
		if (block.block_id) ranges.push({
			block_id: block.block_id,
			start: rangeStart,
			locator_end: locatorEnd,
			end: renderedLength,
			...pageNum === void 0 ? {} : { page: pageNum },
			...block.document_label ? { document_label: block.document_label } : {}
		});
	}
	return {
		text: renderedBlocks.join("\n\n"),
		ranges,
		orderedImages
	};
}
/** Markdown-only results: replace image links with numbered figure lines. */
function fallbackExtractFromMarkdown(fullMarkdownText, imageArtifacts) {
	const orderedImages = [];
	let annotatedText = fullMarkdownText;
	const imgRegex = /!\[(.*?)\]\((.*?)\)/g;
	let match;
	let imgIndex = 0;
	const matches = [];
	while ((match = imgRegex.exec(fullMarkdownText)) !== null) matches.push({
		fullMatch: match[0],
		alt: match[1] ?? "",
		url: match[2] ?? ""
	});
	for (const item of matches) {
		const { reference, artifact: matchedArtifact } = matchImageArtifact(item.url, imageArtifacts);
		const imgPath = matchedArtifact?.path;
		const imgName = matchedArtifact === void 0 ? basename(reference) || "image" : basename(matchedArtifact.path);
		const mediaType = matchedArtifact === void 0 ? void 0 : mediaTypeForExtension(extname(matchedArtifact.path));
		imgIndex++;
		orderedImages.push({
			path: imgPath ?? "",
			name: imgName,
			...item.alt ? { caption: item.alt } : {},
			media_type: mediaType ?? "application/octet-stream",
			bytes: matchedArtifact?.bytes ?? 0,
			status: matchedArtifact === void 0 ? "unavailable" : mediaType === void 0 ? "unsupported" : "available"
		});
		const replacement = mediaType === void 0 || imgPath === void 0 ? `> Figure ${String(imgIndex)} unavailable` : `> Figure ${String(imgIndex)}${item.alt ? `: ${item.alt}` : ""}`;
		annotatedText = annotatedText.replace(item.fullMatch, replacement);
	}
	return {
		text: annotatedText,
		orderedImages
	};
}
function extractMarkdownHeadings(fullText) {
	if (!fullText) return [];
	const lines = fullText.split(/\r?\n/);
	const headings = [];
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const title = match[2].trim();
			if (title.length > 0) headings.push({
				level: match[1].length,
				title,
				line: i + 1
			});
		}
	}
	return headings;
}
//#endregion
//#region src/reader/published-result.ts
const MAX_CONTENT_LIST_BYTES = 67108864;
const MAX_MARKDOWN_READ_BYTES = 67108864;
function openPublishedDocument(result, results) {
	const document = result.manifest.files[0];
	const view = (artifact) => ({
		kind: artifact.kind,
		path: results.resolveArtifactAbsolutePath(result.cacheKey, artifact.relativePath),
		bytes: artifact.bytes
	});
	const markdown = document.artifacts.find((artifact) => artifact.kind === "markdown");
	if (markdown === void 0) throw new MinerUError(failure("REMOTE_PARSE_FAILED", "Extracted markdown artifact is missing from result"));
	return {
		result,
		fileId: document.fileId,
		manifestPath: results.manifestAbsolutePath(result.cacheKey),
		markdown: view(markdown),
		artifacts: document.artifacts.filter((artifact) => artifact.kind !== "markdown").map(view)
	};
}
function contentListTooLarge() {
	return new MinerUError(failure("RESULT_TOO_LARGE", "content-list artifact exceeds the bounded reader limit"));
}
/** Read only a manifest-declared JSON artifact, at its declared size. */
async function loadJsonArtifact(artifact, maxBytes, signal) {
	let data;
	try {
		data = await readFileBounded(artifact.path, {
			maxBytes,
			expectedBytes: artifact.bytes
		}, signal);
	} catch (error) {
		if (error instanceof BoundedReadError && error.reason === "too-large") throw contentListTooLarge();
		throw error;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
async function loadContentList(artifact, maxBytes, signal) {
	const parsed = await loadJsonArtifact(artifact, maxBytes, signal);
	const container = typeof parsed === "object" && parsed !== null ? parsed : void 0;
	const candidate = Array.isArray(parsed) ? parsed : container?.list ?? container?.content_list;
	if (!Array.isArray(candidate)) throw new TypeError("content-list must be an array or contain list/content_list");
	for (const block of candidate) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) throw new TypeError("content-list contains a malformed block");
		if (block.page_idx !== void 0 && (!Number.isSafeInteger(block.page_idx) || block.page_idx < 0)) throw new TypeError("content-list contains an invalid page_idx");
		if (block.type !== void 0 && typeof block.type !== "string") throw new TypeError("content-list contains an invalid type");
	}
	return candidate;
}
/** A complete contiguous MinerU pdf_info page list is stronger than the last text block's index. */
async function loadLayoutPageCount(artifact, signal) {
	if (!artifact || artifact.bytes > 67108864) return void 0;
	const parsed = await loadJsonArtifact(artifact, MAX_CONTENT_LIST_BYTES, signal);
	const pages = typeof parsed === "object" && parsed !== null ? parsed.pdf_info : void 0;
	if (!Array.isArray(pages) || pages.length === 0 || pages.length > 99999) return void 0;
	if (!pages.every((page, index) => typeof page === "object" && page !== null && !Array.isArray(page) && page.page_idx === index)) return void 0;
	return pages.length;
}
function markdownChanged(stage) {
	return new MinerUError(failure("RESULT_DOWNLOAD_FAILED", "Markdown artifact changed " + stage));
}
async function loadMarkdown(artifact, signal) {
	signal.throwIfAborted();
	if (artifact.bytes > MAX_MARKDOWN_READ_BYTES) throw new MinerUError(failure("RESULT_TOO_LARGE", "Markdown artifact exceeds the bounded reader limit"));
	if (artifact.bytes === 0) return "";
	let data;
	try {
		data = await readFileBounded(artifact.path, {
			maxBytes: MAX_MARKDOWN_READ_BYTES,
			expectedBytes: artifact.bytes
		}, signal);
	} catch (error) {
		if (!(error instanceof BoundedReadError)) throw error;
		if (error.reason === "io") throw error.cause;
		throw markdownChanged(error.reason === "short-read" ? "while it was being read" : error.reason === "changed" ? "during reading" : "before reading");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
//#endregion
//#region src/utils/text.ts
/** Slice by UTF-16 units without leaving a dangling high surrogate. */
function safeStringSlice(str, maxLen) {
	if (str.length <= maxLen) return str;
	let end = maxLen;
	const code = str.charCodeAt(end - 1);
	if (code >= 55296 && code <= 56319) end--;
	return str.slice(0, end);
}
/** Cut at a paragraph (late enough) or line boundary when one exists. */
function truncateAtCleanBoundary(fullText, maxChars) {
	if (fullText.length <= maxChars) return {
		text: fullText,
		truncated: false
	};
	if (maxChars <= 0) return {
		text: "",
		truncated: true
	};
	const boundedSlice = safeStringSlice(fullText, maxChars);
	const paragraphIndex = boundedSlice.lastIndexOf("\n\n");
	const lineIndex = boundedSlice.lastIndexOf("\n");
	let cutIndex = -1;
	if (paragraphIndex !== -1 && paragraphIndex >= Math.floor(maxChars * .7)) cutIndex = paragraphIndex + 2;
	else if (lineIndex !== -1) cutIndex = lineIndex + 1;
	if (cutIndex > 0) return {
		text: boundedSlice.slice(0, cutIndex),
		truncated: true
	};
	return {
		text: boundedSlice,
		truncated: true
	};
}
function canonicalFocusList(focus) {
	return [...focus].sort();
}
function parseFocusList(input) {
	if (!Array.isArray(input)) throw new TypeError("cursor focus must be an array");
	const out = [];
	for (const item of input) {
		if (typeof item !== "string") throw new TypeError("cursor focus entries must be strings");
		const token = item.trim().toLowerCase();
		if (!FOCUS_KINDS.includes(token)) throw new TypeError("unknown cursor focus: " + item);
		out.push(token);
	}
	const canonical = [...new Set(out)].sort();
	if (canonical.length === 0 || JSON.stringify(canonical) !== JSON.stringify(input)) throw new TypeError("cursor focus is not canonical");
	return canonical;
}
function toBase64Url(input) {
	return Buffer.from(input, "utf8").toString("base64url");
}
function fromBase64Url(input) {
	return Buffer.from(input, "base64url").toString("utf8");
}
/** Encode a cursor bound to one result identity, selection, and text offset. */
function encodeReadCursor(payload) {
	if (!Number.isSafeInteger(payload.off) || payload.off < 0) throw new TypeError("cursor offset must be a non-negative safe integer");
	if (payload.rid.trim() === "") throw new TypeError("cursor result identity is required");
	if (payload.inline_images !== void 0 && typeof payload.inline_images !== "boolean") throw new TypeError("cursor inline_images must be a boolean");
	const canonical = {
		v: 3,
		rid: payload.rid,
		pages: payload.pages,
		focus: [...payload.focus].sort(),
		off: payload.off,
		inline_images: payload.inline_images ?? true,
		...payload.block === void 0 ? {} : { block: payload.block },
		...payload.query === void 0 ? {} : { query: payload.query },
		...payload.projection === void 0 ? {} : { projection: payload.projection }
	};
	const json = JSON.stringify(canonical);
	if (json.length > 1280) throw new MinerUError(failure("INVALID_REQUEST", "Selection is too complex to continue with a cursor; narrow pages or focus"));
	const token = toBase64Url(json);
	if (token.length > 2048) throw new MinerUError(failure("INVALID_REQUEST", "Selection is too complex to continue with a cursor; narrow pages or focus"));
	return token;
}
/** Decode and structurally validate a cursor token. Never throws MinerUError. */
function decodeReadCursor(token) {
	if (typeof token !== "string" || token.trim() === "" || token.length > 2048) throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	let json;
	try {
		json = fromBase64Url(token.trim());
	} catch {
		throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	}
	if (json.length > 1280) throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	let raw;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	const obj = raw;
	if (Object.keys(obj).sort().some((key) => ![
		"focus",
		"off",
		"pages",
		"rid",
		"v",
		"inline_images",
		"block",
		"query",
		"projection"
	].includes(key))) throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	if (obj.block !== void 0 && !isBlockId(obj.block)) throw new TypeError("cursor block is malformed");
	if (obj.query !== void 0 && !isQueryText(obj.query)) throw new TypeError("cursor query is malformed");
	if (obj.block !== void 0 && obj.query !== void 0) throw new TypeError("cursor selection is malformed");
	if (obj.v !== 3) throw new TypeError("cursor is expired; re-read without a cursor");
	if (typeof obj.inline_images !== "boolean") throw new TypeError("cursor inline_images must be a boolean");
	if (typeof obj.rid !== "string" || obj.rid.trim() === "") throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	if (typeof obj.pages !== "string" || obj.pages.length > 1024) throw new TypeError("cursor pages must be a bounded string");
	const pages = obj.pages;
	if (pages !== "" && normalizePageRanges(pages) !== pages) throw new TypeError("cursor selection is not canonical; re-read without a cursor");
	const focus = parseFocusList(obj.focus);
	if (obj.projection !== void 0 && (typeof obj.projection !== "string" || !/^[a-f0-9]{64}$/.test(obj.projection))) throw new TypeError("cursor projection is malformed");
	if (typeof obj.block === "string" && !obj.block.startsWith(obj.rid + ":b")) throw new TypeError("cursor block belongs to another result");
	if ((obj.block !== void 0 || obj.query !== void 0) && (focus.includes("toc") || focus.includes("artifacts"))) throw new TypeError("cursor selection cannot use toc or artifacts");
	if (typeof obj.off !== "number" || !Number.isSafeInteger(obj.off) || obj.off < 0) throw new TypeError("cursor is malformed or expired; re-read without a cursor");
	return {
		v: 3,
		rid: obj.rid,
		pages,
		focus,
		off: obj.off,
		inline_images: obj.inline_images,
		...typeof obj.block === "string" ? { block: obj.block } : {},
		...typeof obj.query === "string" ? { query: obj.query } : {},
		...typeof obj.projection === "string" ? { projection: obj.projection } : {}
	};
}
/** Create a cursor for the remainder of projected text starting at offset. */
function cursorForRemainder(resultId, pagesLabel, focus, offset, selection = {}) {
	return encodeReadCursor({
		v: 3,
		rid: resultId,
		pages: pagesLabel ?? "",
		focus: canonicalFocusList(focus),
		off: offset,
		...selection
	});
}
//#endregion
//#region src/reader/prose.ts
function formatResultProse(value) {
	const status = value.content_status ?? (value.markdown_content !== void 0 ? "complete" : "not_requested");
	const lines = [];
	const content = value.markdown_content;
	if (value.files.length > 0) for (let i = 0; i < value.files.length; i++) {
		const file = value.files[i];
		if (lines.length > 0) lines.push("");
		lines.push("# Document: " + file.name);
		if (i === 0 && content !== void 0) lines.push("", content);
		const secondary = file.artifacts.filter((artifact) => artifact.kind !== "markdown");
		if (secondary.length > 0) lines.push("", "Artifacts: " + secondary.map((a) => a.kind + " (" + String(a.bytes) + " bytes): " + a.path).join(", "));
		if (file.artifacts_truncated) lines.push("", "*(Artifact list truncated to output limit)*");
	}
	else if (content !== void 0) lines.push(content);
	if (status === "partial" && value.toc && value.toc.length > 0) {
		lines.push("", "Document Outline:");
		for (const heading of value.toc) {
			const indent = "  ".repeat(Math.max(0, heading.level - 1));
			const location = heading.page !== void 0 ? ` (Page ${String(heading.page)})` : heading.line !== void 0 ? ` (line ${String(heading.line)})` : "";
			lines.push(`${indent}- ${heading.title}${location}${heading.block_id ? " [" + heading.block_id + "]" : ""}`);
		}
		if (typeof value.cursor === "string" && value.cursor.length > 0) lines.push("", "Continue with the returned cursor using the same file_path.");
	}
	const totalPages = value.summary?.page_count;
	const pagesLabel = value.pages ?? (totalPages !== void 0 ? totalPages > 1 ? `1-${totalPages}` : "1" : void 0);
	const pagesParts = [];
	if (pagesLabel !== void 0) pagesParts.push(`Pages: ${pagesLabel}`);
	if (totalPages !== void 0) pagesParts.push(`${value.summary?.page_count_source === "content-list-lower-bound" ? "Parsed page lower bound" : "Total Pages"}: ${String(totalPages)}`);
	const pagesInfo = pagesParts.length > 0 ? pagesParts.join(", ") + ". " : "";
	let footer;
	if (status === "complete") footer = "\n---\n[Status: Content complete. " + pagesInfo + "Selected parsed text complete across this and preceding chunks; not a guarantee of OCR fidelity or visual coverage.]";
	else if (status === "partial") {
		const mdGuidance = typeof value.cursor === "string" && value.cursor.length > 0 ? `Continue with read_pdf({ file_path: "<same file_path>", cursor: "${value.cursor}" }); omit pages/focus.` : "Full markdown artifact available in local result storage.";
		footer = "\n---\n[Status: Content partial (truncated to output limit). " + pagesInfo + mdGuidance + "]";
	} else footer = "\n---\n[Status: Markdown content was not requested." + (pagesParts.length > 0 ? " " + pagesParts.join(", ") + "." : "") + "]";
	if (value.provenance) {
		const p = value.provenance;
		lines.push("", `Parse provenance: ${p.provider}/${p.model}, method ${p.parse_method}; upstream engine version unknown. Index v${p.index_version}, reader protocol v${p.reader_version}.`);
	}
	if (value.diagnostics?.length) lines.push("", "Diagnostics:", ...value.diagnostics.map((d) => `- [${d.code}] (${d.scope})${d.block_id ? " [" + d.block_id + "]" : ""}${d.page === void 0 ? "" : " Page " + d.page}: ${d.message}`));
	if (value.verification_hints?.length) lines.push("", "Formula verification suggested (advisory, not a detected error):", ...value.verification_hints.map((hint) => `- [${hint.block_id}]${hint.page === void 0 ? "" : " Page " + hint.page}: inspect the original page before relying on formula symbols.`));
	if (value.metadata_shortened?.length) lines.push("", "Metadata shortened to fit: " + value.metadata_shortened.join(", ") + ". Narrow the selection to inspect omitted details.");
	if (value.view === "page") lines.push("", "Original PDF page rendered locally" + (value.renderer ? " (" + value.renderer + ")" : "") + "; no Provider parsing was performed.");
	if (value.visuals) lines.push("", `Visuals in this chunk: ${value.visuals.attached}/${value.visuals.listed} attached, ${value.visuals.omitted} not attached.`);
	if (value.continuation_block) lines.push("", "Continuing block [" + value.continuation_block.block_id + "]" + (value.continuation_block.page ? " (Page " + value.continuation_block.page + ")" : ""));
	lines.push(footer);
	if (value.warnings && value.warnings.length > 0) lines.push("", "Warnings:", ...value.warnings.map((warning) => `- ${warning}`));
	if (value.inlined_images && value.inlined_images.length > 0) {
		lines.push("", "**Inlined Visual Figures**:");
		for (let idx = 0; idx < value.inlined_images.length; idx++) {
			const img = value.inlined_images[idx];
			const dim = img.width !== void 0 && img.height !== void 0 ? ` (${String(img.width)}x${String(img.height)})` : "";
			const label = value.view === "page" ? "Original PDF Page " + img.page : img.document_label ?? (img.block_id ? "Image [" + img.block_id + "]" : "Figure " + String(img.figure ?? idx + 1));
			lines.push(`- ${label}: ${img.name}${dim}`);
		}
	}
	if (value.ordered_images && value.ordered_images.length > 0) for (let idx = 0; idx < value.ordered_images.length; idx++) {
		const img = value.ordered_images[idx];
		const meta = [img.page !== void 0 ? `Page ${String(img.page)}` : "", img.caption ? `"${img.caption}"` : ""].filter(Boolean).join(", ");
		const metaStr = meta ? ` (${meta})` : "";
		const status = img.status && img.status !== "available" ? ` [${img.status}]` : "";
		const label = img.document_label ?? (img.block_id ? "Image" : "Figure " + String(idx + 1));
		const target = img.block_id ? "[" + img.block_id + "]" : img.path || "unavailable";
		lines.push(`${label}${metaStr}: ${target}${status}`);
	}
	return lines.join("\n");
}
function formatSingleSummaryProse(value) {
	const fileName = value.files[0]?.name ?? "Document";
	const summary = value.summary;
	const lines = [
		`**MinerU Document Parse Summary** (Source: ${value.source}, Cache: ${value.cache_hit ? "hit" : "miss"})`,
		"",
		`# Document: ${fileName}`
	];
	if (summary?.page_count !== void 0) lines.push(`- **Total Pages**: ${String(summary.page_count)}`);
	if (summary?.table_count !== void 0) lines.push(`- **Tables**: ${String(summary.table_count)}`);
	if (summary?.image_count !== void 0) lines.push(`- **Figures / Images**: ${String(summary.image_count)}`);
	if (summary?.equation_count !== void 0 && summary.equation_count > 0) lines.push(`- **Formulas / Equations**: ${String(summary.equation_count)}`);
	const outline = summary?.toc ?? value.toc;
	if (outline && outline.length > 0) {
		lines.push("", "**Document Outline**:");
		for (const heading of outline) {
			const indent = "  ".repeat(Math.max(0, heading.level - 1));
			const pageInfo = heading.page !== void 0 ? ` (Page ${String(heading.page)})` : heading.line !== void 0 ? ` (line ${String(heading.line)})` : "";
			lines.push(`${indent}- ${heading.title}${pageInfo}`);
		}
	}
	if (value.warnings?.length) lines.push("", ...value.warnings.map((warning) => "Note: " + warning));
	lines.push("", "---", "**Next Steps**: The document has been fully parsed and cached in local storage. Use `read_pdf` to inspect content on demand:", "- Reuse the original file_path for a page selection: `read_pdf({ file_path: \"<same file_path>\", pages: \"1-3\" })`", "- Reuse the original file_path for tables: `read_pdf({ file_path: \"<same file_path>\", focus: \"table\" })`", "- Reuse the original file_path for figures/images: `read_pdf({ file_path: \"<same file_path>\", focus: \"image\" })`", "- Reuse the original file_path for outline / TOC: `read_pdf({ file_path: \"<same file_path>\", focus: \"toc\" })`", "- Reuse the original file_path for complete text: `read_pdf({ file_path: \"<same file_path>\" })`");
	return lines.join("\n");
}
//#endregion
//#region src/reader/read-delivery.ts
/** Bounded model delivery, independent of provider/cache representation. */
/** Below DSH console object's 10,000-character string preview limit. */
const MAX_MODEL_MARKDOWN_CHARS = 8e3;
function boundedWarnings(warnings) {
	const unique = [...new Set(warnings)];
	const result = unique.slice(0, 8).map((warning) => safeStringSlice(warning, 240));
	if (unique.length > 8) result.push("[DIAGNOSTICS_SHORTENED] More quality warnings exist; narrow pages or block_id.");
	return result;
}
function fitsReadBudget(view) {
	const json = JSON.stringify(view);
	const prose = formatResultProse(view);
	return json.length <= view.output_limit_chars && prose.length <= view.output_limit_chars && Buffer.byteLength(json, "utf8") <= 48e3 && Buffer.byteLength(prose, "utf8") <= 48e3;
}
/** Last-resort metadata degradation never changes text, status, cursor, or image records. */
function compactReadMetadata(value) {
	let view = value;
	for (const key of [
		"summary",
		"provenance",
		"verification_hints",
		"diagnostics",
		"warnings"
	]) {
		if (fitsReadBudget(view)) break;
		if (view[key] === void 0) continue;
		const { [key]: _removed, ...rest } = view;
		view = {
			...rest,
			metadata_shortened: [.../* @__PURE__ */ new Set([...view.metadata_shortened ?? [], key])]
		};
	}
	return view;
}
/**
* Final response ladder after images are attached: drop image candidate records,
* then summary/outline, then artifact records, then compact metadata.
*/
function fitToBudget(value) {
	let fitted = value;
	const warn = (message) => {
		fitted = {
			...fitted,
			warnings: boundedWarnings([message, ...fitted.warnings ?? []])
		};
	};
	if (fitsReadBudget(fitted)) return fitted;
	if (fitted.ordered_images?.length) {
		const removed = fitted.ordered_images.length;
		const attached = fitted.inlined_images?.length ?? 0;
		const { ordered_images: _ordered, ...rest } = fitted;
		fitted = {
			...rest,
			visuals: {
				listed: attached,
				attached,
				omitted: 0,
				scope: "chunk"
			}
		};
		warn("[VISUAL_METADATA_SHORTENED] Removed " + removed + " image candidate records to fit; " + attached + " attachments remain. Use block IDs to inspect omitted candidates.");
		if (fitsReadBudget(fitted)) return fitted;
	}
	if (fitted.summary !== void 0 || fitted.toc !== void 0) {
		const { summary: _summary, toc: _toc, ...rest } = fitted;
		fitted = {
			...rest,
			metadata_shortened: [.../* @__PURE__ */ new Set([...rest.metadata_shortened ?? [], "summary"])]
		};
		warn("[SUMMARY_SHORTENED] Summary metadata was omitted to fit the response; request a narrower selection.");
		if (fitsReadBudget(fitted)) return fitted;
	}
	if (fitted.files.some((file) => file.artifacts.length > 0)) {
		fitted = {
			...fitted,
			files: fitted.files.map((file) => ({
				...file,
				artifacts: [],
				...file.artifacts.length ? { artifacts_truncated: true } : {}
			}))
		};
		warn("[ARTIFACT_METADATA_SHORTENED] Artifact records were omitted to fit the response; use focus: artifacts separately.");
		if (fitsReadBudget(fitted)) return fitted;
	}
	fitted = compactReadMetadata(fitted);
	if (fitsReadBudget(fitted)) return fitted;
	throw new MinerUError(failure("RESULT_TOO_LARGE", "Result metadata exceeds the output budget; narrow the selection or increase maxInlineChars"));
}
/** An artifact-only listing is the requested content: shorten its records silently, then compact. */
function fitArtifactListing(view) {
	if (fitsReadBudget(view)) return view;
	const compacted = compactReadMetadata({
		...view,
		files: view.files.map((file) => ({
			...file,
			artifacts: [],
			...file.artifacts.length > 0 ? { artifacts_truncated: true } : {}
		}))
	});
	if (!fitsReadBudget(compacted)) throw new MinerUError(failure("RESULT_TOO_LARGE", "Result metadata exceeds configured model output limit"));
	return compacted;
}
function deliverReadChunk(options) {
	const { base, text, focus, images, cursor, selection, ranges = [] } = options;
	options.signal?.throwIfAborted();
	const projection = createHash("sha256").update(text).update("\0").update(options.identity ?? "").digest("hex");
	if (cursor !== void 0 && cursor.projection !== projection) throw new MinerUError(failure("INVALID_REQUEST", "Cursor projection changed or expired; restart without a cursor"));
	const offset = cursor?.off ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) throw new MinerUError(failure("INVALID_REQUEST", "Cursor is outside the projection or splits a Unicode character; start over without a cursor"));
	if (ranges.some((range) => offset > range.start && offset < range.locator_end)) throw new MinerUError(failure("INVALID_REQUEST", "Cursor splits a generated block locator; restart without a cursor"));
	const activeBlock = ranges.find((range) => offset >= range.locator_end && offset < range.end);
	const remaining = text.slice(offset);
	let target = Math.min(MAX_MODEL_MARKDOWN_CHARS, remaining.length, Math.max(0, base.output_limit_chars));
	for (;;) {
		options.signal?.throwIfAborted();
		let content = target >= remaining.length ? remaining : truncateAtCleanBoundary(remaining, target).text;
		if (content.length < target / 2) content = safeStringSlice(remaining, target);
		const splitLocator = ranges.find((range) => range.start < offset + content.length && range.locator_end > offset + content.length);
		if (splitLocator) content = content.slice(0, Math.max(0, splitLocator.start - offset));
		if (remaining.length > 0 && content.length === 0) throw new MinerUError(failure("RESULT_TOO_LARGE", "Output budget cannot make reading progress; increase maxInlineChars"));
		const partial = offset + content.length < text.length;
		const chunkBlockIds = new Set(ranges.filter((range) => range.start >= offset && range.start < offset + content.length).map((range) => range.block_id));
		const chunkImages = images.filter((image) => image.block_id ? chunkBlockIds.has(image.block_id) : offset === 0);
		const activeIds = new Set(ranges.filter((range) => range.start < offset + content.length && range.end > offset).map((range) => range.block_id));
		const diagnostics = [...offset === 0 ? options.scopeDiagnostics ?? [] : [], ...options.diagnosticsForBlocks?.(activeIds) ?? []];
		const hints = (options.verificationHints ?? []).filter((hint) => activeIds.has(hint.block_id));
		const shortened = [...diagnostics.length > 6 ? ["diagnostics"] : [], ...hints.length > 4 ? ["verification_hints"] : []];
		const warnings = boundedWarnings([...offset === 0 ? base.warnings ?? [] : [], ...chunkImages.length > 20 ? ["[VISUAL_METADATA_SHORTENED] Use block_id to inspect images not listed in this chunk."] : []]);
		const { warnings: _scopeWarnings, provenance: _provenance, ...chunkBase } = base;
		const view = {
			...chunkBase,
			...offset === 0 && base.provenance ? { provenance: base.provenance } : {},
			markdown_content: content,
			content_status: partial ? "partial" : "complete",
			...partial && base.files.some((file) => file.artifacts.length > 0) ? { files: base.files.map((file) => ({
				...file,
				artifacts: [],
				artifacts_truncated: true
			})) } : {},
			cursor: partial ? cursorForRemainder(base.result_id, base.pages, focus, offset + content.length, {
				...selection,
				projection,
				inline_images: options.inlineImages ?? cursor?.inline_images ?? true
			}) : null,
			...chunkImages.length ? { ordered_images: chunkImages.slice(0, 20).map((image) => ({
				...image,
				...image.caption ? { caption: safeStringSlice(image.caption, 256) } : {}
			})) } : {},
			...warnings.length ? { warnings } : {},
			...diagnostics.length ? { diagnostics: diagnostics.slice(0, 6) } : {},
			...hints.length ? { verification_hints: hints.slice(0, 4) } : {},
			...shortened.length ? { metadata_shortened: shortened } : {},
			...activeBlock ? { continuation_block: {
				block_id: activeBlock.block_id,
				...activeBlock.page === void 0 ? {} : { page: activeBlock.page },
				...activeBlock.document_label ? { document_label: activeBlock.document_label } : {}
			} } : {}
		};
		if (fitsReadBudget(view)) return view;
		if (target <= 256) {
			const compact = compactReadMetadata(view);
			if (fitsReadBudget(compact)) return compact;
		}
		if (target === 0) throw new MinerUError(failure("RESULT_TOO_LARGE", "Result metadata exceeds model output budget"));
		target = Math.max(0, Math.floor(Math.min(target, content.length) * .75));
	}
}
//#endregion
//#region src/reader/selection.ts
function notice(code, scope, message) {
	return {
		code,
		scope,
		message,
		warning: "[" + code + "] " + message
	};
}
function invalid(message) {
	return new MinerUError(failure("INVALID_REQUEST", message));
}
/** Out-of-range error with the legal 1-based bounds when the physical page count is known. */
function formatPageOutOfRangeMessage(totalPages) {
	const prefix = "[PAGE_OUT_OF_RANGE] Requested pages are outside the document page range";
	if (typeof totalPages === "number" && Number.isSafeInteger(totalPages) && totalPages >= 1) return `${prefix} (valid: ${totalPages === 1 ? "1" : `1-${totalPages}`}, total pages: ${totalPages})`;
	return prefix;
}
/**
* Narrow requested physical pages to the document. Fails when selected blocks lack
* page coordinates; reports out-of-range pages and lower-bound page counts as notices.
*/
function scopePages(requested, blocks, focus, parsedPageCount, physicalPageCount, notices) {
	if (requested !== void 0 && blocks.some((block) => block.page_idx === void 0 && (focus.has("all") || focus.has(getBlockCategory(block.type)) || focus.has("toc") && block.text_level !== void 0))) throw invalid("[SELECTION_UNAVAILABLE] Some selected content has no page coordinates; read without pages or use block_id/original page view");
	if (requested !== void 0 && parsedPageCount === void 0) throw invalid("[SELECTION_UNAVAILABLE] No reliable physical page coordinates are available");
	const narrowed = narrowPageSelection(requested, physicalPageCount);
	if (narrowed.fullyOutOfRange) throw invalid(formatPageOutOfRangeMessage(physicalPageCount));
	if (narrowed.outOfRange.length) {
		const message = "Some requested pages are outside the document range: " + narrowed.outOfRange.slice(0, 20).join(", ");
		notices.push({
			code: "PAGE_SELECTION_ADJUSTED",
			scope: "selection",
			message,
			warning: message
		});
	}
	if (requested !== void 0 && physicalPageCount === void 0) notices.push(notice("PAGE_COUNT_LOWER_BOUND", "selection", "Physical page count is unknown; parsed page_count is a lower bound. An empty selection is not proof that the requested page is blank or absent."));
	return {
		pagesSet: narrowed.pagesSet,
		...requested === void 0 ? {} : { pagesLabel: narrowed.pagesLabel }
	};
}
function pageOf(block) {
	return typeof block.page_idx === "number" ? block.page_idx + 1 : void 0;
}
/** Blocks inside the page scope and focus, narrowed to the exact target block when one is given. */
function selectBlocks(blocks, pagesSet, focus, target) {
	const selected = blocks.filter((block) => {
		const page = pageOf(block);
		return (pagesSet === void 0 || page !== void 0 && pagesSet.has(page)) && (focus.has("all") || focus.has(getBlockCategory(block.type)));
	});
	if (target?.kind !== "block") return selected;
	if (!blocks.some((block) => block.block_id === target.blockId)) throw invalid("[BLOCK_NOT_FOUND] This block does not belong to the current parsed result; search again");
	const matching = selected.filter((block) => block.block_id === target.blockId);
	if (matching.length === 0) throw invalid("[BLOCK_NOT_FOUND] Block is outside the requested pages/focus");
	return matching;
}
/** Formula blocks are recommended for original-page verification; this is advisory only. */
function formulaHints(blocks) {
	return blocks.filter((block) => [
		"equation",
		"interline_equation",
		"inline_equation"
	].includes((block.type ?? "").toLowerCase())).map((block) => ({
		reason: "formula",
		block_id: block.block_id,
		view: "page",
		...typeof block.page_idx === "number" ? { page: block.page_idx + 1 } : {}
	}));
}
/** Case-insensitive literal search: one bounded snippet per matching block, located by its block locator. */
function searchBlocks(blocks, query, imageArtifacts, signal) {
	const escaped = [...query].map((character) => "\\.^$*+?()[]{}|".includes(character) ? "\\" + character : character).join("");
	const literal = new RegExp(escaped, "iu");
	const matches = [];
	const ranges = [];
	let matchLength = 0;
	for (const block of blocks) {
		signal.throwIfAborted();
		const projected = extractBlocksMarkdown([block], imageArtifacts).text;
		const locationEnd = projected.indexOf("]") + 1;
		const body = projected.slice(locationEnd).trim();
		const at = literal.exec(body)?.index;
		if (at === void 0) continue;
		let snippetStart = Math.max(0, at - 80);
		if (snippetStart > 0 && /[\uDC00-\uDFFF]/.test(body[snippetStart])) snippetStart--;
		const snippet = safeStringSlice(body.slice(snippetStart), 360).replace(/\s+/g, " ");
		const match = projected.slice(0, locationEnd) + "\n" + snippet;
		const start = matchLength + (matches.length ? 2 : 0);
		matchLength = start + match.length;
		matches.push(match);
		ranges.push({
			block_id: block.block_id,
			start,
			locator_end: start + locationEnd,
			end: matchLength,
			...typeof block.page_idx === "number" ? { page: block.page_idx + 1 } : {}
		});
	}
	return {
		text: matches.length ? matches.join("\n\n") : "No literal matches in the selected parsed blocks.",
		ranges
	};
}
/** Prefix the outline of the page scope, shifting body ranges past it. */
function prependOutline(outline, scope, text, ranges) {
	const headings = (outline ?? []).filter((heading) => scope.pagesSet === void 0 || heading.page !== void 0 && scope.pagesSet.has(heading.page));
	const tocRanges = [];
	const tocText = formatTocMarkdown(headings, { pageRange: scope.pagesLabel }, tocRanges);
	const shift = tocText.length + 2;
	const shifted = text ? ranges.map((range) => ({
		...range,
		start: range.start + shift,
		locator_end: range.locator_end + shift,
		end: range.end + shift
	})) : ranges;
	return {
		text: text ? tocText + "\n\n" + text : tocText,
		ranges: [...tocRanges, ...shifted]
	};
}
//#endregion
//#region src/reader/summary.ts
const MAX_SYNOPSIS_HEADINGS = 20;
const MAX_SYNOPSIS_TITLE_CHARS = 160;
function computeDocumentSummary(contentList) {
	const maxPage = contentList.reduce((max, b) => typeof b.page_idx === "number" ? Math.max(max, b.page_idx) : max, -1);
	const page_count = maxPage >= 0 ? maxPage + 1 : void 0;
	const table_count = contentList.filter((b) => getBlockCategory(b.type) === "table").length;
	const image_count = contentList.filter((b) => getBlockCategory(b.type) === "image").length;
	const equation_count = contentList.filter((b) => {
		const t = (b.type ?? "").toLowerCase();
		return t === "equation" || t === "interline_equation" || t === "inline_equation";
	}).length;
	const toc = [];
	for (const b of contentList) {
		const page = typeof b.page_idx === "number" && Number.isSafeInteger(b.page_idx) && b.page_idx >= 0 ? b.page_idx + 1 : void 0;
		if (typeof b.text_level === "number" && b.text_level >= 1 && b.text_level <= 6) {
			const title = String(b.text ?? b.content ?? "").trim().replace(/^#{1,6}\s+/, "");
			if (title) toc.push({
				level: b.text_level,
				title,
				...page === void 0 ? {} : { page },
				...b.block_id ? { block_id: b.block_id } : {}
			});
		} else if (b.type === "title") {
			const title = String(b.text ?? b.content ?? "").trim().replace(/^#{1,6}\s+/, "");
			if (title) toc.push({
				level: 1,
				title,
				...page === void 0 ? {} : { page },
				...b.block_id ? { block_id: b.block_id } : {}
			});
		} else if (typeof b.text === "string" && /^#{1,6}\s+/.test(b.text)) {
			const m = b.text.match(/^(#{1,6})\s+(.+)$/);
			if (m) toc.push({
				level: m[1].length,
				title: m[2].trim(),
				...page === void 0 ? {} : { page },
				...b.block_id ? { block_id: b.block_id } : {}
			});
		}
	}
	return {
		...page_count !== void 0 ? { page_count } : {},
		table_count,
		image_count,
		equation_count,
		toc
	};
}
/** Parse-completion synopsis: counts plus a shortened outline, never body text. */
function synopsisSummary(blocks) {
	if (blocks.length === 0) return { shortened: false };
	const full = computeDocumentSummary(blocks);
	const headings = full.toc ?? [];
	const toc = headings.slice(0, MAX_SYNOPSIS_HEADINGS).map((heading) => ({
		...heading,
		title: safeStringSlice(heading.title, MAX_SYNOPSIS_TITLE_CHARS)
	}));
	return {
		summary: {
			...full,
			toc
		},
		shortened: headings.length > toc.length || headings.some((heading) => heading.title.length > MAX_SYNOPSIS_TITLE_CHARS)
	};
}
//#endregion
//#region src/reader/visuals.ts
/**
* Attach the chunk's image candidates through the sink, charging actual bytes read
* (including failed partial reads) against the per-response budget.
*/
async function inlineImages(view, sink, maxInlineImages, signal) {
	const declared = view.ordered_images ?? [];
	if (declared.length === 0) return view;
	const statuses = declared.map((img) => ({ ...img }));
	const candidates = [];
	for (let index = 0; index < declared.length; index++) {
		const item = declared[index];
		const mediaType = mediaTypeForExtension(extname(item.name));
		if (index >= maxInlineImages || mediaType === void 0 || item.path === "") {
			statuses[index] = {
				...statuses[index],
				status: index >= maxInlineImages ? "omitted" : "unsupported"
			};
			continue;
		}
		if (item.bytes > 8388608) {
			statuses[index] = {
				...statuses[index],
				status: "omitted"
			};
			continue;
		}
		candidates.push({
			path: item.path,
			name: item.name,
			mediaType,
			index
		});
	}
	const inlined = [];
	let actualTotalBytes = 0;
	let emittedTotalBytes = 0;
	for (const item of candidates) {
		signal.throwIfAborted();
		const status = (next) => {
			statuses[item.index] = {
				...statuses[item.index],
				status: next
			};
		};
		const remaining = MAX_INLINE_IMAGE_TOTAL_BYTES - actualTotalBytes;
		let data;
		try {
			data = await readFileBounded(item.path, { maxBytes: remaining > 0 ? Math.min(MAX_INLINE_IMAGE_SINGLE_BYTES, remaining) : -1 }, signal);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof BoundedReadError) actualTotalBytes += error.bytesRead;
			status(error instanceof BoundedReadError && (error.reason === "not-file" || error.reason === "too-large") ? "omitted" : "failed");
			continue;
		}
		actualTotalBytes += data.byteLength;
		let ref;
		try {
			ref = await sink({
				data,
				mediaType: item.mediaType,
				name: item.name
			});
		} catch {
			signal.throwIfAborted();
			status("failed");
			continue;
		}
		signal.throwIfAborted();
		const emittedBytes = ref.bytes;
		if (!Number.isSafeInteger(emittedBytes) || emittedBytes < 0 || emittedBytes > 8388608 || emittedTotalBytes + emittedBytes > 25165824) {
			status("omitted");
			continue;
		}
		emittedTotalBytes += emittedBytes;
		status("available");
		const candidate = statuses[item.index];
		inlined.push({
			attachment_id: String(ref.attachmentId),
			name: ref.name ?? item.name,
			media_type: ref.mediaType,
			figure: item.index + 1,
			...candidate.block_id ? { block_id: candidate.block_id } : {},
			...candidate.document_label ? { document_label: candidate.document_label } : {},
			...candidate.page === void 0 ? {} : { page: candidate.page },
			...ref.width !== void 0 ? { width: ref.width } : {},
			...ref.height !== void 0 ? { height: ref.height } : {},
			...ref.bytes !== void 0 ? { bytes: ref.bytes } : {}
		});
	}
	return {
		...view,
		ordered_images: statuses,
		...inlined.length > 0 ? { inlined_images: inlined } : {}
	};
}
/** Chunk visual accounting; listed-but-unattached images point the model at block IDs or page view. */
function withVisualAccounting(view) {
	const listed = view.ordered_images?.length ?? 0;
	if (listed === 0) return view;
	const attached = view.inlined_images?.length ?? 0;
	return {
		...view,
		visuals: {
			listed,
			attached,
			omitted: listed - attached,
			scope: "chunk"
		},
		...listed > attached ? { warnings: [...view.warnings ?? [], "[VISUALS_NOT_ATTACHED] Some listed images were not attached; use block_id or original page view to inspect them."] } : {}
	};
}
/**
* Final content response: attach images only when the caller asked for them and the
* route can show them (a sink exists), account visuals, then fit the response budget.
*/
async function finishContentChunk(chunk, images, inlineIntent, maxInlineImages, signal) {
	return fitToBudget(withVisualAccounting(images !== void 0 && inlineIntent ? await inlineImages(chunk, images, maxInlineImages, signal) : chunk));
}
//#endregion
//#region src/reader/reader-service.ts
const MAX_SYNOPSIS_CONTENT_LIST_BYTES = 2097152;
/** The reader entry used by tools: bounded content reads, parse synopses and local page views. */
var ReaderService = class {
	options;
	constructor(options) {
		this.options = options;
	}
	/** Read one bounded chunk of a selection; continuations are cache-only. */
	async readContent(sourcePath, query, config, images, signal) {
		return await this.options.accessGate.runShared(async () => {
			const cursor = query.kind === "continue" ? query.cursor : void 0;
			const published = await this.options.parser.ensurePublished(sourcePath, config, signal, {
				cacheOnly: cursor !== void 0,
				waitTimeoutMs: query.pollTimeoutMs
			});
			if (cursor !== void 0 && cursor.rid !== String(published.manifest.id)) throw new MinerUError(failure("INVALID_REQUEST", "Cursor result identity does not match the published result; start over without a cursor"));
			return await finishContentChunk(await projectContent(openPublishedDocument(published, this.options.results), query.kind === "continue" ? cursorSelection(query.cursor) : query.selection, cursor, query.inlineImages, config.output.maxInlineChars, signal), images, query.inlineImages, config.output.maxInlineImages, signal);
		}, signal);
	}
	/** Render one original page locally and attach it; never invokes a Provider or persists the source. */
	async viewPage(sourcePath, query, config, images, signal) {
		const page = await renderPdfPage({
			file_path: sourcePath,
			page: query.page,
			...query.expectedSha256 ? { expectedSha256: query.expectedSha256 } : {},
			maxFileBytes: config.limits.maxFileBytes,
			signal
		});
		signal.throwIfAborted();
		const name = "page-" + page.page + ".png";
		const ref = await images({
			data: page.data,
			mediaType: page.media_type,
			name
		});
		signal.throwIfAborted();
		if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 8388608) throw new MinerUError(failure("RESULT_TOO_LARGE", "Rendered page attachment exceeds the image limit"));
		return fitToBudget({
			state: "completed",
			source: "local",
			cache_hit: false,
			result_id: asResultId("mr_page_" + page.sha256.slice(0, 32) + "_" + page.page),
			view: "page",
			renderer: page.renderer,
			files: [{
				file_id: createFileId(page.sha256),
				name: page.name,
				artifacts: []
			}],
			content_status: "not_requested",
			cursor: null,
			output_limit_chars: config.output.maxInlineChars,
			source_sha256: page.sha256,
			pages: String(page.page),
			summary: {
				page_count: page.page_count,
				page_count_source: page.renderer === "pdfjs" ? "pdfjs" : "pdfinfo"
			},
			inlined_images: [{
				attachment_id: String(ref.attachmentId),
				name: ref.name ?? name,
				media_type: ref.mediaType,
				bytes: ref.bytes,
				page: page.page,
				...ref.width === void 0 ? {} : { width: ref.width },
				...ref.height === void 0 ? {} : { height: ref.height }
			}],
			visuals: {
				listed: 1,
				attached: 1,
				omitted: 0,
				scope: "chunk"
			}
		});
	}
	/** Ensure publication and return a bounded synopsis, never a body projection. */
	async summarize(sourcePath, config, signal, onProgress) {
		return await this.options.accessGate.runShared(async () => {
			const published = await this.options.parser.ensurePublished(sourcePath, config, signal, {
				waitTimeoutMs: null,
				onProgress
			});
			const document = openPublishedDocument(published, this.options.results);
			reportProgress(onProgress, "summarizing");
			signal.throwIfAborted();
			const contentList = document.artifacts.find((item) => item.kind === "content-list");
			let summary;
			const warnings = [];
			if (contentList !== void 0) try {
				const synopsis = synopsisSummary(await loadContentList(contentList, MAX_SYNOPSIS_CONTENT_LIST_BYTES, signal));
				summary = synopsis.summary;
				if (synopsis.shortened) warnings.push("Outline shortened for the parse summary; use read_pdf to inspect the complete outline.");
			} catch {
				signal.throwIfAborted();
				warnings.push("Optional summary metadata is unavailable or exceeds the synopsis budget; the parsed result remains cached. Use read_pdf to inspect it.");
			}
			signal.throwIfAborted();
			return {
				state: "completed",
				source: published.source,
				cache_hit: published.source === "cache",
				result_id: published.manifest.id,
				files: [{
					file_id: document.fileId,
					name: published.sourceFile.name,
					artifacts: []
				}],
				content_status: "not_requested",
				manifest_path: document.manifestPath,
				...summary !== void 0 ? { summary } : {},
				...warnings.length > 0 ? { warnings } : {}
			};
		}, signal);
	}
};
/** Project one selection of a published document into a bounded, cursor-addressable chunk. */
async function projectContent(document, selection, cursor, inlineImageIntent, limit, signal) {
	signal.throwIfAborted();
	const { manifest, source, sourceFile } = document.result;
	const { focus, target } = selection;
	const blockId = target?.kind === "block" ? target.blockId : void 0;
	const query = target?.kind === "query" ? target.text : void 0;
	const artifactsRequested = focus.has("artifacts");
	const contentList = document.artifacts.find((artifact) => artifact.kind === "content-list");
	let rawBlocks = [];
	if (contentList) try {
		rawBlocks = await loadContentList(contentList, MAX_CONTENT_LIST_BYTES, signal);
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof MinerUError) throw error;
		throw new MinerUError(failure("INVALID_REQUEST", "Malformed content-list artifact; cannot provide a reliable selection"), { cause: error });
	}
	const blocks = normalizeDocumentBlocks(rawBlocks, manifest.id, /* @__PURE__ */ new Set()).blocks;
	const summary = blocks.length ? computeDocumentSummary(blocks) : void 0;
	const { toc: outline, ...rest } = summary ?? {};
	const counts = rest;
	const notices = [];
	let physicalPageCount;
	try {
		physicalPageCount = await loadLayoutPageCount(document.artifacts.find((artifact) => artifact.kind === "layout"), signal);
	} catch {
		signal.throwIfAborted();
		notices.push(notice("PAGE_COUNT_UNAVAILABLE", "document", "Layout page metadata could not be read reliably; use original page view to verify physical bounds."));
	}
	if (physicalPageCount !== void 0 && (summary?.page_count ?? 0) > physicalPageCount) {
		notices.push(notice("PAGE_MAPPING_CONFLICT", "document", "Content blocks exceed layout page metadata; physical bounds are not reliable."));
		physicalPageCount = void 0;
	}
	if (physicalPageCount !== void 0) counts.page_count = physicalPageCount;
	if (counts.page_count !== void 0) counts.page_count_source = physicalPageCount === void 0 ? "content-list-lower-bound" : "layout";
	const scope = scopePages(selection.pages, blocks, focus, summary?.page_count, physicalPageCount, notices);
	const artifactList = artifactsRequested ? [document.markdown, ...document.artifacts] : [];
	const warningsOf = () => notices.map((item) => item.warning);
	const base = {
		state: "completed",
		source,
		cache_hit: source === "cache",
		result_id: manifest.id,
		files: [{
			file_id: document.fileId,
			name: sourceFile.name,
			artifacts: artifactList.slice(0, 20),
			...artifactList.length > 20 ? { artifacts_truncated: true } : {}
		}],
		content_status: "not_requested",
		cursor: null,
		output_limit_chars: limit,
		source_sha256: sourceFile.sha256,
		provenance: {
			provider: manifest.producer.providerId,
			model: PROVIDER_TRAITS[manifest.producer.providerId].selectsModel ? manifest.request.semantics.model : null,
			parse_method: manifest.request.semantics.parseMethod,
			upstream_version: null,
			index_version: 2,
			reader_version: 3
		},
		...artifactsRequested ? {
			manifest_path: document.manifestPath,
			markdown_path: document.markdown.path
		} : {},
		...summary ? { summary: counts } : {},
		...scope.pagesLabel ? { pages: scope.pagesLabel } : {},
		...notices.length ? { warnings: boundedWarnings(warningsOf()) } : {}
	};
	if (focus.size === 1 && artifactsRequested) return fitArtifactListing(base);
	let text = "";
	let images = [];
	let ranges = [];
	let verificationHints = [];
	if (blocks.length) {
		const matching = selectBlocks(blocks, scope.pagesSet, focus, target);
		verificationHints = formulaHints(matching);
		const imageArtifacts = document.artifacts.filter((artifact) => artifact.kind === "images");
		if (query !== void 0) ({text, ranges} = searchBlocks(matching, query, imageArtifacts, signal));
		else {
			const projected = extractBlocksMarkdown(matching, imageArtifacts);
			text = projected.text;
			images = projected.orderedImages;
			ranges = projected.ranges;
		}
		if (focus.has("toc")) ({text, ranges} = prependOutline(outline, scope, text, ranges));
	} else {
		if (blockId !== void 0 || query !== void 0 || selection.pages !== void 0 || !focus.has("all") && !focus.has("toc")) throw new MinerUError(failure("INVALID_REQUEST", "[SELECTION_UNAVAILABLE] No content-list mapping; use unfiltered reading or original page view"));
		const markdown = await loadMarkdown(document.markdown, signal);
		if (focus.has("toc") && !focus.has("all")) text = formatTocMarkdown(extractMarkdownHeadings(markdown));
		else ({text, orderedImages: images} = fallbackExtractFromMarkdown(markdown, document.artifacts.filter((artifact) => artifact.kind === "images")));
		notices.push(notice("LOCATION_UNAVAILABLE", "document", "Reading Markdown fallback; page/block coordinates are unavailable."));
	}
	const scopeDiagnostics = notices.map((item) => ({
		id: createHash("sha256").update(manifest.id + "|" + item.scope + "|" + item.warning).digest("hex").slice(0, 24),
		code: item.code,
		scope: item.scope,
		message: item.message
	}));
	return deliverReadChunk({
		base: {
			...base,
			...notices.length ? { warnings: boundedWarnings(warningsOf()) } : {}
		},
		text,
		focus,
		images,
		ranges,
		cursor,
		signal,
		identity: JSON.stringify({
			index_version: 2,
			reader_version: 3,
			files: manifest.files
		}),
		inlineImages: inlineImageIntent,
		verificationHints,
		scopeDiagnostics,
		diagnosticsForBlocks: (ids) => collectBlockDiagnostics(rawBlocks, manifest.id, new Set([...ids].map((id) => Number(id.slice(id.lastIndexOf(":b") + 2))))),
		selection: {
			...blockId ? { block: blockId } : {},
			...query ? { query } : {}
		}
	});
}
//#endregion
//#region src/contracts/rpc.ts
const RPC_CHANNEL = "/dsh-pdf-mineru-api";
const RPC_ENDPOINTS = {
	configGet: "mineru/config.get",
	configSet: "mineru/config.set",
	probe: "mineru/probe",
	storageStats: "mineru/storage.stats",
	storageIntegrityScan: "mineru/storage.integrity.scan",
	storageQuarantineList: "mineru/storage.quarantine.list",
	storageQuarantineCleanup: "mineru/storage.quarantine.cleanup",
	storageCacheClear: "mineru/storage.cache.clear"
};
//#endregion
//#region src/loopback-rpc.ts
/** Accept only a bare loopback Host authority, never URL parts or trusted LAN names. */
function isLoopbackAuthority(host) {
	if (typeof host !== "string") return false;
	const match = /^(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
	if (match === null || match[0] !== host || match[2] !== void 0 && Number(match[2]) > 65535) return false;
	return !match[1].startsWith("127.") || match[1].split(".").every((part) => Number(part) <= 255);
}
/** Guard this caller’s Host authority; Connection owns authentication and transport. */
function normalizeLocalRpcIp(value) {
	if (typeof value !== "string" || value.includes("%")) return;
	const family = isIP(value);
	if (family === 4) return value;
	if (family !== 6) return;
	const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
	if (!mapped) return canonical;
	const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
	return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
function isOwnSocketConfigRead(request) {
	if (request.method !== "POST" || request.url !== "/dsh-pdf-mineru-api/mineru/config.get") return false;
	const socket = request.socket;
	if (!socket || !Number.isInteger(socket.localPort) || socket.localPort < 1 || socket.localPort > 65535) return false;
	const local = normalizeLocalRpcIp(socket.localAddress), remote = normalizeLocalRpcIp(socket.remoteAddress);
	if (local === void 0 || remote !== local) return false;
	const authority = request.headers.host;
	if (typeof authority !== "string") return false;
	const match = /^(?:\[([^\[\]]+)\]|([^:\[\]]+))(?::([1-9][0-9]{0,4}))?$/u.exec(authority);
	if (!match) return false;
	const literal = match[1] ?? match[2];
	if (isIP(literal) !== (match[1] === void 0 ? 4 : 6) || normalizeLocalRpcIp(literal) !== local) return false;
	const port = match[3] === void 0 ? socket.encrypted === true ? 443 : 80 : Number(match[3]);
	return port === socket.localPort;
}
function registerLoopbackRpc(ctx, channel, handler) {
	const webServer = ctx.webServer;
	return ctx.extend({ webServer: { register(route) {
		return webServer.register({
			...route,
			handler(request, response) {
				if (!isLoopbackAuthority(request.headers.host) && !isOwnSocketConfigRead(request)) {
					response.writeHead(403);
					response.end("forbidden");
					return;
				}
				return route.handler(request, response);
			}
		});
	} } }).connection.rpc.handle(channel, handler);
}
//#endregion
//#region src/rpc.ts
const MINERU_TO_RPC_ERROR_CODE = {
	INVALID_REQUEST: "mineru/invalid-argument",
	FILE_NOT_FOUND: "mineru/not-found",
	FILE_TOO_LARGE: "mineru/file-too-large",
	UNSUPPORTED_OPTION: "mineru/unsupported-option",
	CREDENTIAL_MISSING: "mineru/credential-missing",
	AUTHENTICATION_FAILED: "mineru/auth-failed",
	PROVIDER_UNAVAILABLE: "mineru/provider-unavailable",
	PROVIDER_CONFIG_MISSING: "mineru/provider-config-missing",
	PROVIDER_RATE_LIMITED: "mineru/provider-rate-limited",
	PROVIDER_QUOTA_EXHAUSTED: "mineru/quota-exhausted",
	UPLOAD_FAILED: "mineru/upload-failed",
	REMOTE_PARSE_FAILED: "mineru/remote-parse-failed",
	RESULT_NOT_READY: "mineru/result-not-ready",
	RESULT_DOWNLOAD_FAILED: "mineru/download-failed",
	RESULT_ARCHIVE_INVALID: "mineru/archive-invalid",
	RESULT_TOO_LARGE: "mineru/result-too-large",
	CACHE_CORRUPT: "mineru/cache-corrupt",
	CACHE_CONFLICT: "mineru/cache-conflict",
	CACHE_EVICTED: "mineru/cache-evicted",
	INTERRUPTED_UPLOAD: "mineru/interrupted-upload",
	POLL_TIMEOUT: "mineru/timeout",
	CANCELLED: "mineru/cancelled",
	UNAUTHENTICATED_SESSION: "mineru/unauthenticated",
	JOB_NOT_FOUND: "mineru/not-found",
	STORAGE_LOCKED: "mineru/storage-locked",
	SETTINGS_CONFLICT: "mineru/conflict"
};
function ok(value) {
	return {
		ok: true,
		value
	};
}
function payloadRecord(payload) {
	if (payload === void 0) return {};
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new TypeError("payload must be an object");
	return payload;
}
function optionalLimit(payload, key) {
	const value = payload[key];
	if (value === void 0) return void 0;
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(key + " must be a positive safe integer");
	return value;
}
function optionalBoolean(payload, key, fallback) {
	const value = payload[key];
	if (value === void 0) return fallback;
	if (typeof value !== "boolean") throw new TypeError(key + " must be a boolean");
	return value;
}
function fail(message, code = "mineru/internal") {
	return {
		ok: false,
		error: {
			code,
			message: sanitizeDiagnostic(message),
			details: {}
		}
	};
}
function mapRpcError(err) {
	if (err instanceof MinerUError) return {
		code: MINERU_TO_RPC_ERROR_CODE[err.failure.code] ?? "mineru/internal",
		message: err.failure.message
	};
	if (err instanceof TypeError) return {
		code: "mineru/invalid-argument",
		message: sanitizeDiagnostic(err.message)
	};
	if (err instanceof Error && err.name === "AbortError") return {
		code: "mineru/cancelled",
		message: sanitizeDiagnostic(err.message)
	};
	return {
		code: "mineru/internal",
		message: sanitizeDiagnostic(err instanceof Error ? err.message : String(err))
	};
}
function registerRpc(ctx, deps) {
	ctx.logger?.info("dsh-pdf-mineru: registering RPC channel /dsh-pdf-mineru-api");
	const handlers = {
		[RPC_ENDPOINTS.configGet]: async (_payload, _signal) => {
			return ok(deps.settings.current());
		},
		[RPC_ENDPOINTS.configSet]: async (p, _signal) => {
			if (!Object.hasOwn(p, "config") || p.config === void 0 || p.config === null) throw new TypeError("payload.config must be a non-null configuration object");
			const expected = p.expected_revision;
			if (expected !== void 0 && (!Number.isSafeInteger(expected) || expected < 0)) throw new TypeError("expected_revision must be a non-negative safe integer");
			return ok(await deps.settings.save(p.config, expected));
		},
		[RPC_ENDPOINTS.probe]: async (p, signal) => {
			return ok(await deps.probe(p.provider, signal));
		},
		[RPC_ENDPOINTS.storageStats]: async (_payload, signal) => {
			const report = await deps.maintenance.getStatistics(signal);
			ctx.logger?.info("dsh-pdf-mineru", {
				phase: "maintenance",
				operation: "stats"
			});
			return ok(report);
		},
		[RPC_ENDPOINTS.storageIntegrityScan]: async (p, signal) => {
			const isolateInvalid = optionalBoolean(p, "isolate_invalid", false);
			if (isolateInvalid && p.confirm !== true) throw new TypeError("confirm must be true when isolating invalid results");
			const report = await deps.maintenance.scanIntegrity({
				resultLimit: optionalLimit(p, "result_limit"),
				diagnosticLimit: optionalLimit(p, "diagnostic_limit"),
				isolateInvalid,
				signal
			});
			ctx.logger?.info("dsh-pdf-mineru", {
				phase: "maintenance",
				operation: isolateInvalid ? "integrity-isolate" : "integrity-scan",
				scanned: report.scan.scanned,
				quarantined: report.quarantinedCount
			});
			return ok(report);
		},
		[RPC_ENDPOINTS.storageQuarantineList]: async (p, signal) => {
			return ok(await deps.maintenance.listQuarantine({
				limit: optionalLimit(p, "limit"),
				signal
			}));
		},
		[RPC_ENDPOINTS.storageQuarantineCleanup]: async (p, signal) => {
			if (!Array.isArray(p.entry_ids) || p.entry_ids.some((entry) => typeof entry !== "string")) throw new TypeError("entry_ids must be an array of strings");
			const dryRun = optionalBoolean(p, "dry_run", true);
			if (!dryRun && p.confirm !== true) throw new TypeError("confirm must be true when deleting quarantine entries");
			const report = await deps.maintenance.cleanupQuarantine({
				entryIds: p.entry_ids,
				dryRun,
				signal
			});
			ctx.logger?.info("dsh-pdf-mineru", {
				phase: "maintenance",
				operation: dryRun ? "quarantine-cleanup-preview" : "quarantine-cleanup",
				requested: report.requestedCount,
				deleted: report.deletedCount,
				bytes: report.deletedBytes
			});
			return ok(report);
		},
		[RPC_ENDPOINTS.storageCacheClear]: async (p, signal) => {
			const dryRun = optionalBoolean(p, "dry_run", true);
			if (!dryRun && p.confirm !== true) throw new TypeError("confirm must be true when clearing published cache results");
			if (!dryRun && (typeof p.confirmation_token !== "string" || p.confirmation_token.length === 0)) throw new TypeError("confirmation_token from a cache clear preview is required");
			const report = await deps.maintenance.clearCache({
				resultLimit: optionalLimit(p, "result_limit"),
				diagnosticLimit: optionalLimit(p, "diagnostic_limit"),
				dryRun,
				...typeof p.confirmation_token === "string" ? { confirmationToken: p.confirmation_token } : {},
				signal
			});
			ctx.logger?.info("dsh-pdf-mineru", {
				phase: "maintenance",
				operation: dryRun ? "cache-clear-preview" : "cache-clear",
				eligible: report.eligible,
				planned: report.plannedCount,
				deleted: report.deletedCount,
				bytes: report.deletedBytes
			});
			return ok(report);
		}
	};
	return registerLoopbackRpc(ctx, RPC_CHANNEL, async (endpoint, payload, signal, peer) => {
		if (peer.principal.kind !== "owner") return {
			ok: false,
			error: {
				code: "mineru/forbidden",
				message: "Owner access required",
				details: {}
			}
		};
		try {
			if (!Object.hasOwn(handlers, endpoint)) return fail(`unknown endpoint: ${endpoint}`, "mineru/not-found");
			return await handlers[endpoint](payloadRecord(payload), signal);
		} catch (err) {
			const { code, message } = mapRpcError(err);
			return {
				ok: false,
				error: {
					code,
					message,
					details: {}
				}
			};
		}
	});
}
//#endregion
//#region src/service/shared-operations.ts
function deferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
function waitWithSignal(promise, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
/** One process-local producer shared by foreground calls and native DSH jobs. */
var SharedOperation = class {
	cacheKey;
	id = createOperationId();
	controller = new AbortController();
	outcome = deferred();
	settled = false;
	waiters = 0;
	constructor(cacheKey) {
		this.cacheKey = cacheKey;
		this.outcome.promise.catch(() => void 0);
	}
	get waiterCount() {
		return this.waiters;
	}
	resolve(value) {
		if (this.settled) return;
		this.settled = true;
		this.outcome.resolve(value);
	}
	reject(error) {
		if (this.settled) return;
		this.settled = true;
		this.outcome.reject(error);
	}
	async waitForOutcome(signal) {
		this.waiters++;
		try {
			return await waitWithSignal(this.outcome.promise, signal);
		} finally {
			this.waiters--;
		}
	}
	abort(reason) {
		if (!this.controller.signal.aborted) this.controller.abort(reason);
	}
};
var SharedOperationRegistry = class {
	operations = /* @__PURE__ */ new Map();
	disposed = false;
	operationKeys = /* @__PURE__ */ new WeakMap();
	operationTimeouts = /* @__PURE__ */ new WeakMap();
	started = /* @__PURE__ */ new WeakSet();
	runners = /* @__PURE__ */ new Set();
	reserve(cacheKey, authority, timeoutMs) {
		if (this.disposed) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "MinerU service is shutting down", true));
		const operationKey = `${cacheKey}:${authority}`;
		const existing = this.operations.get(operationKey);
		if (existing !== void 0) return {
			operation: existing,
			created: false
		};
		const operation = new SharedOperation(cacheKey);
		this.operations.set(operationKey, operation);
		this.operationKeys.set(operation, operationKey);
		this.operationTimeouts.set(operation, timeoutMs);
		return {
			operation,
			created: true
		};
	}
	start(operation, runner) {
		const operationKey = this.operationKeys.get(operation);
		if (operationKey === void 0 || this.operations.get(operationKey) !== operation) throw new TypeError("Shared operation is not reserved in this registry");
		if (this.started.has(operation)) throw new TypeError("Shared operation has already been started");
		this.started.add(operation);
		const timeout = setTimeout(() => {
			operation.abort(new MinerUError(failure("POLL_TIMEOUT", "Shared MinerU operation timed out", true)));
		}, this.operationTimeouts.get(operation) ?? 1);
		timeout.unref?.();
		const running = Promise.resolve().then(() => runner(operation)).then((outcome) => operation.resolve(outcome), (error) => operation.reject(error)).finally(() => {
			clearTimeout(timeout);
			this.runners.delete(running);
			if (this.operations.get(operationKey) === operation) this.operations.delete(operationKey);
		});
		this.runners.add(running);
	}
	release(operation, error) {
		const operationKey = this.operationKeys.get(operation);
		if (operationKey === void 0 || this.operations.get(operationKey) !== operation || this.started.has(operation)) return false;
		this.operations.delete(operationKey);
		operation.reject(error);
		return true;
	}
	activeOperationIds() {
		return new Set([...this.operations.values()].map((operation) => operation.id));
	}
	activeOperationCount() {
		return this.operations.size;
	}
	dispose() {
		this.disposed = true;
		const error = new MinerUError(failure("CANCELLED", "MinerU plugin disposed", true));
		for (const operation of this.operations.values()) if (!this.release(operation, error)) operation.abort(error);
	}
	async shutdown() {
		this.dispose();
		await Promise.allSettled(this.runners);
	}
};
//#endregion
//#region src/storage/process-lock.ts
/**
* Scoped local-filesystem Lamport bakery mutex. Requires one host/PID namespace
* and coherent local directory operations (not NFS/distributed locking).
* Each attempt owns a never-reused directory. Reclamation can delete only a
* confirmed-dead owner's unique directory, never a shared/reused lock pathname.
*/
const scopeBrand = Symbol("MinerU mutation scope");
const HOST = createHash("sha256").update(hostname().toLowerCase()).digest("hex");
const OWNER_ID = /^([cu])_([0-9a-f]{64})_([1-9][0-9]{0,9})_([0-9a-f]{32})$/;
const MAX_CLAIMS = 256;
const FENCE = Object.freeze({
	pid: 1,
	ownerToken: "mineru-lock-protocol-v2",
	createdAt: 0,
	hostname: "mineru-lock-protocol-v2:" + HOST
});
function createStorageOwnerId(prefix, pid = process.pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw new TypeError("Invalid storage owner PID");
	return `${prefix}_${HOST}_${pid}_${randomUUID().replaceAll("-", "")}`;
}
function storageOwnerState(id) {
	const match = OWNER_ID.exec(id);
	if (match === null) return "unknown";
	if (match[2] !== HOST) return "foreign";
	const pid = Number(match[3]);
	if (!Number.isSafeInteger(pid) || pid > 2147483647) return "unknown";
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		return errno(error) === "ESRCH" ? "dead" : "unknown";
	}
}
function errno(error) {
	return error?.code;
}
function locked(message) {
	return new MinerUError(failure("STORAGE_LOCKED", message));
}
/** No symlink is accepted in the configured root or coordination ancestry. */
async function ensureDirectory(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = [];
	for (let current = absolute; current !== root; current = dirname(current)) parts.push(current);
	for (const current of [root, ...parts.reverse()]) {
		if (current !== root) try {
			await mkdir(current, { mode: 448 });
		} catch (error) {
			if (errno(error) !== "EEXIST") throw locked("Storage coordination directory could not be created");
		}
		const details = await lstat(current);
		if (!details.isDirectory() || details.isSymbolicLink()) throw locked("Storage coordination paths must be real directories, not symlinks");
	}
}
async function readSmallFile(path, maxBytes) {
	let handle;
	try {
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw locked("Invalid storage coordination record");
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const current = await handle.stat();
		if (!current.isFile() || current.size > maxBytes || before.ino !== current.ino || before.dev !== current.dev) throw locked("Storage coordination record changed while opening");
		const buffer = Buffer.alloc(maxBytes + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > maxBytes) throw locked("Storage coordination record exceeds its size limit");
		return buffer.subarray(0, total).toString("utf8");
	} catch (error) {
		if (errno(error) === "ENOENT") return void 0;
		if (error instanceof MinerUError) throw error;
		throw locked("Storage coordination record cannot be safely read");
	} finally {
		await handle?.close();
	}
}
var ProcessLock = class {
	paths;
	lockDir;
	claimsDir;
	timeoutMs;
	pollMs;
	queueTail = Promise.resolve();
	activeScope;
	manualLease;
	constructor(paths, options = {}) {
		this.paths = paths;
		this.lockDir = join(paths.root, ".lock");
		this.claimsDir = join(this.lockDir, "claims");
		this.timeoutMs = options.acquireTimeoutMs ?? 5e3;
		this.pollMs = options.pollIntervalMs ?? 15;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 12e4 || !Number.isSafeInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 5e3) throw new TypeError("Invalid storage lock timeout or poll interval");
	}
	/** Diagnostic only. Never grants another invocation mutation authority. */
	isHeld() {
		return this.activeScope !== void 0;
	}
	get lockFilePath() {
		return this.paths.processLockFile();
	}
	assertScope(scope) {
		if (scope !== this.activeScope || scope === void 0) throw locked("The mutation scope is not active on this storage lock");
	}
	async withLock(operation, signal) {
		const lease = await this.enter(signal);
		try {
			return await operation(lease.scope);
		} finally {
			await lease.release();
		}
	}
	/** Compatibility for explicit test/host owners; never called to borrow a held scope. */
	async acquire(signal) {
		if (this.manualLease !== void 0) throw locked("This owner already holds an explicit storage lock");
		this.manualLease = await this.enter(signal);
	}
	async release() {
		const lease = this.manualLease;
		this.manualLease = void 0;
		await lease?.release();
	}
	async initialize(signal) {
		signal?.throwIfAborted();
		await ensureDirectory(this.paths.root);
		await this.ensureProtocolFence();
		await ensureDirectory(this.claimsDir);
		await ensureDirectory(join(this.lockDir, "users"));
		signal?.throwIfAborted();
	}
	async ensureProtocolFence() {
		const path = this.paths.processLockFile();
		let raw = await readSmallFile(path, 1024);
		if (raw === void 0) {
			const temporary = join(this.paths.root, ".lock-fence-" + randomUUID() + ".tmp");
			try {
				await writeFile(temporary, JSON.stringify(FENCE), {
					flag: "wx",
					mode: 384
				});
				try {
					await link(temporary, path);
				} catch (error) {
					if (errno(error) !== "EEXIST") throw locked("Storage protocol fence requires local filesystem hard-link support");
				}
			} finally {
				await rm(temporary, { force: true });
			}
			raw = await readSmallFile(path, 1024);
		}
		let value;
		try {
			value = JSON.parse(raw ?? "");
		} catch {
			value = void 0;
		}
		const record = value;
		if (record === null || typeof record !== "object" || record.pid !== FENCE.pid || record.ownerToken !== FENCE.ownerToken || record.createdAt !== 0 || record.hostname !== FENCE.hostname) throw locked("Legacy or foreign storage lock: stop all MinerU processes before a coordinated upgrade and manual lock recovery; never remove a live lock");
	}
	async enter(signal) {
		const deadline = performance.now() + this.timeoutMs;
		const releaseQueue = await this.enqueue(deadline, signal);
		let claimPath;
		try {
			await this.initialize(signal);
			this.checkDeadline(deadline, signal);
			const id = createStorageOwnerId("c");
			const candidatePath = join(this.claimsDir, id);
			await mkdir(candidatePath, { mode: 448 });
			claimPath = candidatePath;
			const max = (await this.scanClaims(signal)).reduce((value, claim) => Math.max(value, claim.ticket ?? 0), 0);
			if (max >= Number.MAX_SAFE_INTEGER) throw locked("Storage lock ticket range is exhausted");
			const ticket = max + 1;
			const temporary = join(claimPath, "choosing.tmp");
			await writeFile(temporary, String(ticket), {
				flag: "wx",
				mode: 384
			});
			await rename(temporary, join(claimPath, "ticket"));
			for (;;) {
				this.checkDeadline(deadline, signal);
				if (!(await this.scanClaims(signal)).some((claim) => claim.id !== id && (claim.ticket === void 0 || claim.ticket < ticket || claim.ticket === ticket && claim.id < id))) break;
				try {
					await setTimeout$1(Math.min(this.pollMs, Math.max(1, deadline - performance.now())), void 0, { signal });
				} catch (error) {
					signal?.throwIfAborted();
					throw error;
				}
			}
			const scope = Object.freeze({ [scopeBrand]: true });
			this.activeScope = scope;
			const ownedPath = claimPath;
			let released = false;
			return {
				scope,
				release: async () => {
					if (released) return;
					released = true;
					this.activeScope = void 0;
					try {
						await rm(ownedPath, {
							recursive: true,
							force: true
						});
					} finally {
						releaseQueue();
					}
				}
			};
		} catch (error) {
			try {
				if (claimPath !== void 0) await rm(claimPath, {
					recursive: true,
					force: true
				});
			} finally {
				releaseQueue();
			}
			throw error;
		}
	}
	checkDeadline(deadline, signal) {
		signal?.throwIfAborted();
		if (performance.now() >= deadline) throw locked("Storage lock contention timed out; retry after active work completes");
	}
	async enqueue(deadline, signal) {
		signal?.throwIfAborted();
		let release;
		const slot = new Promise((resolve) => {
			release = resolve;
		});
		const previous = this.queueTail;
		this.queueTail = previous.then(() => slot);
		try {
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					cleanup();
					reject(locked("Storage lock contention timed out in the local queue"));
				}, Math.max(1, deadline - performance.now()));
				const onAbort = () => {
					cleanup();
					reject(signal?.reason);
				};
				const cleanup = () => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) {
					onAbort();
					return;
				}
				previous.then(() => {
					cleanup();
					resolve();
				});
			});
			this.checkDeadline(deadline, signal);
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}
	async scanClaims(signal) {
		const result = [];
		const directory = await opendir(this.claimsDir);
		let count = 0;
		for await (const entry of directory) {
			signal?.throwIfAborted();
			if (++count > MAX_CLAIMS) throw locked("Storage lock contender limit exceeded");
			if (!entry.name.startsWith("c_") || !entry.isDirectory() || entry.isSymbolicLink()) throw locked("Invalid storage lock claim");
			const state = storageOwnerState(entry.name);
			if (state === "unknown" || state === "foreign") throw locked("Storage lock owner cannot be safely verified on this host");
			const path = join(this.claimsDir, entry.name);
			if (state === "dead") {
				await rm(path, {
					recursive: true,
					force: true
				});
				continue;
			}
			const raw = await readSmallFile(join(path, "ticket"), 32);
			if (raw === void 0) {
				try {
					await lstat(path);
				} catch (error) {
					if (errno(error) === "ENOENT") continue;
					throw error;
				}
				result.push({
					id: entry.name,
					ticket: void 0
				});
			} else {
				const ticket = Number(raw);
				if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(ticket)) throw locked("Invalid storage lock ticket");
				result.push({
					id: entry.name,
					ticket
				});
			}
		}
		return result;
	}
};
//#endregion
//#region src/storage/access-gate.ts
/** In-process reader/exclusive gate with cross-process reader and producer owner records. */
const MAX_USERS = 1024;
function errnoCode$1(error) {
	return error?.code;
}
/** Classify unique owner directories. Foreign and unverifiable owners fail closed. */
async function listUseRecords(paths) {
	const usersDir = paths.lockUsersDir();
	const records = [];
	try {
		const directory = await opendir(usersDir);
		let count = 0;
		for await (const entry of directory) {
			if (count++ >= MAX_USERS) {
				records.push({
					kind: "unknown",
					id: "lease-scan-limit"
				});
				break;
			}
			const id = entry.name;
			if (entry.isSymbolicLink() || !entry.isDirectory()) {
				records.push({
					kind: "unknown",
					id
				});
				continue;
			}
			const state = storageOwnerState(id);
			if (state === "live") records.push({
				kind: "active",
				record: { id }
			});
			else if (state === "dead") records.push({
				kind: "dead",
				id,
				record: { id }
			});
			else records.push({
				kind: "unknown",
				id
			});
		}
	} catch (error) {
		if (errnoCode$1(error) !== "ENOENT") throw error;
	}
	return records;
}
var StorageAccessGate = class {
	activeReaders = 0;
	exclusive = false;
	paths;
	lock;
	constructor(options) {
		this.paths = options.paths;
		this.lock = options.lock;
	}
	get activeReaderCount() {
		return this.activeReaders;
	}
	/** Covers the actual reader or producer I/O lifetime. */
	async runShared(operation, signal) {
		signal?.throwIfAborted();
		if (this.exclusive) throwMinerU("STORAGE_LOCKED", "MinerU storage maintenance is in progress");
		this.activeReaders++;
		let ownerId;
		try {
			await this.lock.initialize(signal);
			ownerId = await this.lock.withLock(async (scope) => {
				this.lock.assertScope(scope);
				if (this.exclusive) throwMinerU("STORAGE_LOCKED", "MinerU storage maintenance is in progress");
				const id = createStorageOwnerId("u");
				await mkdir(join(this.paths.lockUsersDir(), id), { mode: 448 });
				return id;
			}, signal);
			signal?.throwIfAborted();
			return await operation();
		} finally {
			try {
				if (ownerId !== void 0) await rm(join(this.paths.lockUsersDir(), ownerId), {
					recursive: true,
					force: true
				});
			} finally {
				this.activeReaders--;
			}
		}
	}
	/** Fail fast, then recheck and prune confirmed-dead records under the scoped mutex. */
	async runMaintenance(operation, signal) {
		signal?.throwIfAborted();
		if (this.exclusive || this.activeReaders > 0) throwMinerU("STORAGE_LOCKED", "MinerU storage is in use by an active reader or producer");
		await this.lock.initialize(signal);
		await this.assertNoActiveRecords(false);
		return await this.lock.withLock(async (scope) => {
			this.lock.assertScope(scope);
			if (this.exclusive || this.activeReaders > 0) throwMinerU("STORAGE_LOCKED", "MinerU storage is in use by an active reader or producer");
			await this.assertNoActiveRecords(true, scope);
			this.exclusive = true;
			try {
				return await operation(scope);
			} finally {
				this.exclusive = false;
			}
		}, signal);
	}
	async assertNoActiveRecords(pruneDead, scope) {
		const records = await listUseRecords(this.paths);
		if (pruneDead) {
			if (scope === void 0) throw new TypeError("Use-record pruning requires a process lock scope");
			this.lock.assertScope(scope);
			for (const record of records) if (record.kind === "dead" && storageOwnerState(record.id) === "dead") await rm(join(this.paths.lockUsersDir(), record.id), {
				recursive: true,
				force: true
			});
		}
		if ((pruneDead ? await listUseRecords(this.paths) : records).some((record) => record.kind !== "dead")) throwMinerU("STORAGE_LOCKED", "MinerU storage is in use or its owner cannot be safely verified");
	}
};
//#endregion
//#region src/storage/maintenance/fs-safety.ts
const MAX_STATS_ENTRIES = 5e4;
const MAX_STATS_DEPTH = 16;
const MAX_STATS_TIME_MS = 2e3;
function createUsage() {
	return {
		bytes: 0,
		regularFileCount: 0,
		directoryCount: 0,
		skippedSymlinkCount: 0,
		unexpectedEntryCount: 0,
		unreadableEntryCount: 0,
		depthLimitCount: 0,
		truncated: false,
		logicalEntryCount: 0
	};
}
function isSafeSegment(value) {
	try {
		assertSafePathSegment(value, "storage entry");
		return true;
	} catch {
		return false;
	}
}
async function classifyNode(path) {
	try {
		const details = await lstat(path);
		if (details.isSymbolicLink()) return "symlink";
		if (details.isDirectory()) return "directory";
		if (details.isFile()) return "file";
		return "unexpected";
	} catch (error) {
		return error?.code === "ENOENT" ? "missing" : "unreadable";
	}
}
function isWithinDirectory(target, parentDir) {
	const rel = relative(resolve(parentDir), resolve(target));
	return !rel.startsWith("..") && !isAbsolute(rel);
}
async function isSafeExistingDirectoryChain(target, signal) {
	const absolute = resolve(target);
	const root = parse(absolute).root;
	const segments = absolute.slice(root.length).split(sep).filter(Boolean);
	let current = root;
	for (const segment of segments) {
		signal?.throwIfAborted();
		current = join(current, segment);
		if (await classifyNode(current) !== "directory") return false;
	}
	try {
		return await realpath(absolute) === absolute;
	} catch {
		return false;
	}
}
async function isSafeReadableRoot(path, signal) {
	const absolute = resolve(path);
	const filesystemRoot = parse(absolute).root;
	const segments = absolute.slice(filesystemRoot.length).split(sep).filter(Boolean);
	let current = filesystemRoot;
	for (const segment of segments) {
		signal?.throwIfAborted();
		current = join(current, segment);
		try {
			const details = await lstat(current);
			if (details.isSymbolicLink() || !details.isDirectory()) return false;
		} catch (error) {
			if (error?.code === "ENOENT") return true;
			return false;
		}
	}
	return true;
}
async function readSafeDirectory(path, signal) {
	if (!await isSafeReadableRoot(path, signal)) return { kind: "unreadable" };
	const kind = await classifyNode(path);
	if (kind !== "directory") return { kind: kind === "file" ? "unexpected" : kind };
	try {
		const directory = await opendir(path);
		const entries = [];
		for await (const entry of directory) {
			entries.push(entry);
			if (entries.length > 5e4) break;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		return {
			kind: "entries",
			entries,
			truncated: entries.length > MAX_STATS_ENTRIES
		};
	} catch (error) {
		return { kind: error?.code === "ENOENT" ? "missing" : "unreadable" };
	}
}
async function collectUsage(root, signal, logicalDepth, validateLogical = (value) => assertSafePathSegment(value, "storage entry")) {
	const usage = createUsage();
	if (!await isSafeReadableRoot(root, signal)) {
		usage.unreadableEntryCount++;
		return usage;
	}
	const deadline = Date.now() + MAX_STATS_TIME_MS;
	let visited = 0;
	const walk = async (path, depth = 0) => {
		if (visited >= 5e4 || Date.now() > deadline) {
			usage.truncated = true;
			return;
		}
		if (depth > MAX_STATS_DEPTH) {
			usage.depthLimitCount++;
			usage.truncated = true;
			return;
		}
		visited++;
		signal?.throwIfAborted();
		const kind = await classifyNode(path);
		if (kind === "missing") return;
		if (kind === "symlink") {
			usage.skippedSymlinkCount++;
			return;
		}
		if (kind === "unreadable") {
			usage.unreadableEntryCount++;
			return;
		}
		if (kind === "unexpected") {
			usage.unexpectedEntryCount++;
			return;
		}
		if (kind === "file") {
			try {
				const details = await lstat(path);
				usage.regularFileCount++;
				usage.bytes += details.size;
			} catch (error) {
				if (error?.code !== "ENOENT") usage.unreadableEntryCount++;
			}
			return;
		}
		usage.directoryCount++;
		if (logicalDepth === depth) try {
			validateLogical(basename(path), path);
			usage.logicalEntryCount++;
		} catch {}
		const directory = await readSafeDirectory(path, signal);
		if (directory.kind !== "entries") {
			if (directory.kind === "symlink") usage.skippedSymlinkCount++;
			else if (directory.kind === "unreadable") usage.unreadableEntryCount++;
			else if (directory.kind === "unexpected") usage.unexpectedEntryCount++;
			return;
		}
		if (directory.truncated) usage.truncated = true;
		for (const entry of directory.entries.slice(0, MAX_STATS_ENTRIES)) {
			signal?.throwIfAborted();
			if (!isSafeSegment(entry.name)) {
				usage.unexpectedEntryCount++;
				continue;
			}
			if (entry.isSymbolicLink()) {
				usage.skippedSymlinkCount++;
				continue;
			}
			await walk(join(path, entry.name), depth + 1);
		}
	};
	await walk(root);
	return usage;
}
//#endregion
//#region src/storage/maintenance/statistics.ts
function toAreaStatistics(usage) {
	return {
		byteUsage: usage.bytes,
		logicalEntryCount: usage.logicalEntryCount,
		regularFileCount: usage.regularFileCount,
		directoryCount: usage.directoryCount,
		skippedSymlinkCount: usage.skippedSymlinkCount,
		unexpectedEntryCount: usage.unexpectedEntryCount,
		unreadableEntryCount: usage.unreadableEntryCount,
		depthLimitCount: usage.depthLimitCount,
		truncated: usage.truncated,
		complete: !usage.truncated && usage.depthLimitCount === 0 && usage.skippedSymlinkCount === 0 && usage.unexpectedEntryCount === 0 && usage.unreadableEntryCount === 0
	};
}
async function getStatistics(paths, signal) {
	const [publishedUsage, stagingUsage, quarantineUsage] = await Promise.all([
		collectUsage(paths.resultsDir(), signal, 2, (value, path) => {
			const key = asCacheKey(value);
			if (basename(dirname(path)) !== key.slice(0, 2)) throw new TypeError("cache prefix mismatch");
		}),
		collectUsage(paths.stagingDir(), signal, 1, (value) => asOperationId(value)),
		collectUsage(paths.quarantineDir(), signal, 1)
	]);
	return {
		generatedAt: Date.now(),
		publishedResults: toAreaStatistics(publishedUsage),
		staging: toAreaStatistics(stagingUsage),
		quarantine: toAreaStatistics(quarantineUsage)
	};
}
//#endregion
//#region src/storage/maintenance/limits.ts
/** Bounded maintenance work; truncation never grants destructive eligibility. */
const DEFAULT_RESULT_SCAN_LIMIT = 1e4;
const MAX_RESULT_SCAN_LIMIT = 5e4;
const MAX_DIAGNOSTIC_LIMIT = 1e3;
const MAX_QUARANTINE_LIST_LIMIT = 1e3;
function boundedLimit(value, fallback, maximum, label) {
	const resolved = value === void 0 ? fallback : value;
	if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`);
	return resolved;
}
//#endregion
//#region src/storage/maintenance/diagnostics.ts
function sanitizeEntry(value) {
	return isSafeSegment(value) ? value : "unknown";
}
function diagnosticMessage(code) {
	switch (code) {
		case "unexpected-entry": return "Ignored an entry outside the expected storage layout.";
		case "symlink-skipped": return "Skipped a symlink without following it.";
		case "unreadable-entry": return "Could not read a storage entry.";
		case "corrupt-result": return "Published result failed strict manifest or artifact validation.";
		case "missing-result": return "Published result was incomplete or disappeared during validation.";
		case "unsafe-result": return "Published result contained unsafe or unsupported filesystem data.";
		case "quarantine-failed": return "Could not move an invalid result to quarantine.";
	}
}
function createDiagnostics(limit) {
	return {
		limit,
		diagnostics: [],
		truncated: false
	};
}
function addDiagnostic(collector, area, entry, code) {
	if (collector === void 0) return;
	if (collector.diagnostics.length >= collector.limit) {
		collector.truncated = true;
		return;
	}
	collector.diagnostics.push({
		area,
		entry: sanitizeEntry(entry),
		code,
		message: diagnosticMessage(code)
	});
}
//#endregion
//#region src/storage/maintenance/published-walk.ts
async function visitPublishedResults(paths, limit, signal, diagnostics, visitor) {
	const root = await readSafeDirectory(paths.resultsDir(), signal);
	if (root.kind !== "entries") {
		recordDirectoryIssue(diagnostics, "published-results", "results", root.kind);
		return {
			scanned: 0,
			truncated: false,
			complete: root.kind === "missing"
		};
	}
	let scanned = 0;
	let inspected = 0;
	const deadline = Date.now() + MAX_STATS_TIME_MS;
	let complete = !root.truncated;
	let truncated = root.truncated;
	for (const prefixEntry of root.entries) {
		signal?.throwIfAborted();
		if (inspected++ >= 5e4 || Date.now() > deadline) return {
			scanned,
			truncated: true,
			complete: false
		};
		if (!isSafeSegment(prefixEntry.name) || !/^[a-f0-9]{2}$/.test(prefixEntry.name)) {
			complete = false;
			addDiagnostic(diagnostics, "published-results", prefixEntry.name, "unexpected-entry");
			continue;
		}
		if (prefixEntry.isSymbolicLink()) {
			complete = false;
			addDiagnostic(diagnostics, "published-results", prefixEntry.name, "symlink-skipped");
			continue;
		}
		const prefixPath = join(paths.resultsDir(), prefixEntry.name);
		const prefix = await readSafeDirectory(prefixPath, signal);
		if (prefix.kind !== "entries") {
			complete = false;
			recordDirectoryIssue(diagnostics, "published-results", prefixEntry.name, prefix.kind);
			continue;
		}
		if (prefix.truncated) {
			complete = false;
			truncated = true;
		}
		for (const resultEntry of prefix.entries) {
			signal?.throwIfAborted();
			if (inspected++ >= 5e4 || Date.now() > deadline) return {
				scanned,
				truncated: true,
				complete: false
			};
			if (scanned >= limit) return {
				scanned,
				truncated: true,
				complete: false
			};
			if (!isSafeSegment(resultEntry.name) || resultEntry.isSymbolicLink()) {
				complete = false;
				addDiagnostic(diagnostics, "published-results", resultEntry.name, resultEntry.isSymbolicLink() ? "symlink-skipped" : "unexpected-entry");
				continue;
			}
			let cacheKey;
			try {
				cacheKey = asCacheKey(resultEntry.name);
			} catch {
				complete = false;
				addDiagnostic(diagnostics, "published-results", resultEntry.name, "unexpected-entry");
				continue;
			}
			if (cacheKey.slice(0, 2) !== prefixEntry.name) {
				complete = false;
				addDiagnostic(diagnostics, "published-results", resultEntry.name, "unexpected-entry");
				continue;
			}
			const resultDir = paths.resultDir(cacheKey);
			if (resultDir !== join(prefixPath, resultEntry.name)) {
				complete = false;
				addDiagnostic(diagnostics, "published-results", resultEntry.name, "unexpected-entry");
				continue;
			}
			const kind = await classifyNode(resultDir);
			if (kind !== "directory") {
				complete = false;
				recordDirectoryIssue(diagnostics, "published-results", cacheKey, kind);
				continue;
			}
			scanned++;
			await visitor(cacheKey, resultDir);
		}
	}
	return {
		scanned,
		truncated,
		complete
	};
}
function recordDirectoryIssue(diagnostics, area, entry, kind) {
	if (kind === "missing") return;
	if (kind === "symlink") addDiagnostic(diagnostics, area, entry, "symlink-skipped");
	else if (kind === "unreadable") addDiagnostic(diagnostics, area, entry, "unreadable-entry");
	else addDiagnostic(diagnostics, area, entry, "unexpected-entry");
}
//#endregion
//#region src/storage/maintenance/integrity.ts
async function scanIntegrity(paths, results, lock, options, scope) {
	const resultLimit = boundedLimit(options.resultLimit, DEFAULT_RESULT_SCAN_LIMIT, MAX_RESULT_SCAN_LIMIT, "resultLimit");
	const diagnosticLimit = boundedLimit(options.diagnosticLimit, 100, MAX_DIAGNOSTIC_LIMIT, "diagnosticLimit");
	const isolateInvalid = options.isolateInvalid === true;
	const diagnostics = createDiagnostics(diagnosticLimit);
	let validCount = 0;
	let corruptCount = 0;
	let missingCount = 0;
	let unreadableCount = 0;
	let quarantinedCount = 0;
	const traversal = await visitPublishedResults(paths, resultLimit, options.signal, diagnostics, async (cacheKey, resultDir) => {
		const inspection = await results.inspectPublished(cacheKey, options.signal);
		if (inspection.status === "valid") {
			validCount++;
			return;
		}
		if (inspection.status === "missing") {
			missingCount++;
			addDiagnostic(diagnostics, "published-results", cacheKey, "missing-result");
		} else if (inspection.status === "unreadable") {
			unreadableCount++;
			addDiagnostic(diagnostics, "published-results", cacheKey, "unreadable-entry");
		} else {
			corruptCount++;
			addDiagnostic(diagnostics, "published-results", cacheKey, inspection.reason === "unsafe-entry" ? "unsafe-result" : "corrupt-result");
		}
		if (isolateInvalid && inspection.status !== "unreadable") try {
			if (scope === void 0) throw new TypeError("Integrity isolation requires maintenance scope");
			await results.quarantineScoped(lock, scope, resultDir, "maintenance_invalid");
			quarantinedCount++;
		} catch {
			addDiagnostic(diagnostics, "published-results", cacheKey, "quarantine-failed");
		}
	});
	return {
		generatedAt: Date.now(),
		readOnly: !isolateInvalid,
		isolateInvalid,
		validCount,
		corruptCount,
		missingCount,
		unreadableCount,
		quarantinedCount,
		scan: {
			limit: resultLimit,
			scanned: traversal.scanned,
			truncated: traversal.truncated,
			diagnosticsLimit: diagnosticLimit,
			diagnosticsTruncated: diagnostics.truncated
		},
		diagnostics: diagnostics.diagnostics
	};
}
//#endregion
//#region src/storage/maintenance/quarantine.ts
const MAX_QUARANTINE_CLEANUP_ENTRIES = 100;
async function listQuarantine(paths, options = {}) {
	const limit = boundedLimit(options.limit, 100, MAX_QUARANTINE_LIST_LIMIT, "limit");
	const entries = [];
	let totalBytes = 0;
	let totalCount = 0;
	let skippedSymlinkCount = 0;
	let unexpectedEntryCount = 0;
	let unreadableEntryCount = 0;
	const root = await readSafeDirectory(paths.quarantineDir());
	if (root.kind === "entries") for (const entry of root.entries) {
		options.signal?.throwIfAborted();
		if (!isSafeSegment(entry.name)) {
			unexpectedEntryCount++;
			continue;
		}
		if (entry.isSymbolicLink()) {
			skippedSymlinkCount++;
			continue;
		}
		const entryPath = paths.quarantineDir(entry.name);
		const kind = await classifyNode(entryPath);
		if (kind === "symlink") {
			skippedSymlinkCount++;
			continue;
		}
		if (kind === "unreadable") {
			unreadableEntryCount++;
			continue;
		}
		if (kind !== "directory") {
			if (kind !== "missing") unexpectedEntryCount++;
			continue;
		}
		const usage = await collectUsage(entryPath, options.signal);
		const details = await lstat(entryPath).catch(() => void 0);
		if (details === void 0 || details.isSymbolicLink() || !details.isDirectory()) {
			unreadableEntryCount++;
			continue;
		}
		totalCount++;
		totalBytes += usage.bytes;
		if (entries.length < limit) entries.push({
			id: entry.name,
			byteUsage: usage.bytes,
			regularFileCount: usage.regularFileCount,
			directoryCount: usage.directoryCount,
			modifiedAt: Math.max(0, Math.floor(details.mtimeMs))
		});
	}
	else if (root.kind === "symlink") skippedSymlinkCount++;
	else if (root.kind === "unreadable") unreadableEntryCount++;
	else if (root.kind === "unexpected") unexpectedEntryCount++;
	return {
		generatedAt: Date.now(),
		entries,
		totalCount,
		totalBytes,
		truncated: root.kind === "entries" && root.truncated || totalCount > entries.length,
		skippedSymlinkCount,
		unexpectedEntryCount,
		unreadableEntryCount
	};
}
async function cleanupQuarantine(paths, options) {
	if (options.entryIds.length > MAX_QUARANTINE_CLEANUP_ENTRIES) throw new TypeError(`entryIds cannot contain more than ${MAX_QUARANTINE_CLEANUP_ENTRIES} entries`);
	const entryIds = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entryId of options.entryIds) {
		const safeId = assertSafePathSegment(entryId, "quarantine entry ID");
		if (!seen.has(safeId)) {
			seen.add(safeId);
			entryIds.push(safeId);
		}
	}
	const dryRun = options.dryRun !== false;
	const quarantineRoot = await readSafeDirectory(paths.quarantineDir());
	if (quarantineRoot.kind !== "entries") {
		const rootMissing = quarantineRoot.kind === "missing";
		return {
			generatedAt: Date.now(),
			dryRun,
			requestedCount: entryIds.length,
			plannedCount: 0,
			plannedBytes: 0,
			deletedCount: 0,
			deletedBytes: 0,
			missingCount: rootMissing ? entryIds.length : 0,
			skippedCount: rootMissing ? 0 : entryIds.length,
			entries: []
		};
	}
	const plannedEntries = [];
	let plannedBytes = 0;
	let deletedBytes = 0;
	let deletedCount = 0;
	let missingCount = 0;
	let skippedCount = 0;
	for (const entryId of entryIds) {
		options.signal?.throwIfAborted();
		const entryPath = paths.quarantineDir(entryId);
		const kind = await classifyNode(entryPath);
		if (kind === "missing") {
			missingCount++;
			continue;
		}
		if (kind !== "directory") {
			skippedCount++;
			continue;
		}
		const usage = await collectUsage(entryPath, options.signal);
		const details = await lstat(entryPath).catch(() => void 0);
		if (details === void 0 || details.isSymbolicLink() || !details.isDirectory()) {
			skippedCount++;
			continue;
		}
		if (usage.truncated || usage.depthLimitCount > 0 || usage.skippedSymlinkCount > 0 || usage.unexpectedEntryCount > 0 || usage.unreadableEntryCount > 0) {
			skippedCount++;
			continue;
		}
		const entry = {
			id: entryId,
			byteUsage: usage.bytes,
			regularFileCount: usage.regularFileCount,
			directoryCount: usage.directoryCount,
			modifiedAt: Math.max(0, Math.floor(details.mtimeMs))
		};
		plannedEntries.push(entry);
		plannedBytes += usage.bytes;
		if (!dryRun) try {
			if (!await isSafeExistingDirectoryChain(entryPath, options.signal)) {
				skippedCount++;
				continue;
			}
			await rm(entryPath, {
				recursive: true,
				force: true,
				maxRetries: 2
			});
			deletedCount++;
			deletedBytes += usage.bytes;
		} catch (error) {
			if (error?.code === "ENOENT") missingCount++;
			else skippedCount++;
		}
	}
	return {
		generatedAt: Date.now(),
		dryRun,
		requestedCount: entryIds.length,
		plannedCount: plannedEntries.length,
		plannedBytes,
		deletedCount,
		deletedBytes,
		missingCount,
		skippedCount,
		entries: plannedEntries
	};
}
//#endregion
//#region src/storage/maintenance/cache-clear.ts
function cacheClearConfirmationToken(cacheKeys) {
	const ordered = [...cacheKeys].sort();
	return "cache-clear-" + createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}
async function clearCache(paths, operations, options, exclusiveAcquired, activeAccessCount) {
	const resultLimit = boundedLimit(options.resultLimit, DEFAULT_RESULT_SCAN_LIMIT, MAX_RESULT_SCAN_LIMIT, "resultLimit");
	const diagnosticLimit = boundedLimit(options.diagnosticLimit, 100, MAX_DIAGNOSTIC_LIMIT, "diagnosticLimit");
	const dryRun = options.dryRun !== false;
	const diagnostics = createDiagnostics(diagnosticLimit);
	const planned = [];
	let plannedBytes = 0;
	let deletedBytes = 0;
	let unsafeResultCount = 0;
	let deletedCount = 0;
	let skippedCount = 0;
	let traversal = {
		scanned: 0,
		truncated: false,
		complete: true
	};
	const resultsKind = await classifyNode(paths.resultsDir());
	if (!(resultsKind === "missing" || resultsKind === "directory" && await isSafeExistingDirectoryChain(paths.resultsDir(), options.signal))) {
		traversal = {
			scanned: 0,
			truncated: false,
			complete: false
		};
		addDiagnostic(diagnostics, "published-results", "results", resultsKind === "symlink" ? "symlink-skipped" : "unsafe-result");
	} else if (resultsKind === "directory") traversal = await visitPublishedResults(paths, resultLimit, options.signal, diagnostics, async (cacheKey, resultDir) => {
		if (!isWithinDirectory(resultDir, paths.resultsDir()) || !await isSafeExistingDirectoryChain(resultDir, options.signal)) {
			unsafeResultCount++;
			skippedCount++;
			addDiagnostic(diagnostics, "published-results", cacheKey, "unsafe-result");
			return;
		}
		const usage = await collectUsage(resultDir, options.signal);
		if (usage.truncated || usage.depthLimitCount > 0 || usage.skippedSymlinkCount > 0 || usage.unexpectedEntryCount > 0 || usage.unreadableEntryCount > 0) {
			unsafeResultCount++;
			skippedCount++;
			addDiagnostic(diagnostics, "published-results", cacheKey, "unsafe-result");
			return;
		}
		planned.push({
			cacheKey,
			resultDir,
			byteUsage: usage.bytes
		});
		plannedBytes += usage.bytes;
	});
	const token = cacheClearConfirmationToken(planned.map((entry) => entry.cacheKey));
	const activeOperationCount = operations.activeOperationCount();
	const preflightEligible = activeOperationCount === 0 && activeAccessCount === 0 && traversal.complete && !traversal.truncated && unsafeResultCount === 0;
	const tokenMatches = dryRun || typeof options.confirmationToken === "string" && options.confirmationToken === token;
	const eligible = preflightEligible && tokenMatches && (dryRun || exclusiveAcquired);
	if (!dryRun && eligible) for (const entry of planned) {
		options.signal?.throwIfAborted();
		try {
			if (!await isSafeExistingDirectoryChain(entry.resultDir, options.signal)) {
				skippedCount++;
				continue;
			}
			await rm(entry.resultDir, {
				recursive: true,
				force: true,
				maxRetries: 2
			});
			deletedCount++;
			deletedBytes += entry.byteUsage;
		} catch (error) {
			if (error?.code !== "ENOENT") skippedCount++;
		}
	}
	return {
		generatedAt: Date.now(),
		dryRun,
		eligible,
		activeOperationCount,
		activeAccessCount,
		...dryRun && preflightEligible && planned.length > 0 ? { confirmationToken: token } : {},
		plannedCount: planned.length,
		plannedBytes,
		deletedCount,
		deletedBytes,
		skippedCount,
		scan: {
			limit: resultLimit,
			scanned: traversal.scanned,
			truncated: traversal.truncated,
			diagnosticsLimit: diagnosticLimit,
			diagnosticsTruncated: diagnostics.truncated
		},
		diagnostics: diagnostics.diagnostics
	};
}
//#endregion
//#region src/storage/maintenance/service.ts
/** Privileged loopback-only maintenance. All destructive work holds exclusive scoped storage access. */
var StorageMaintenanceService = class {
	paths;
	results;
	operations;
	lock;
	accessGate;
	constructor(paths, results, operations, lock, accessGate) {
		this.paths = paths;
		this.results = results;
		this.operations = operations;
		this.lock = lock;
		this.accessGate = accessGate;
	}
	async getStatistics(signal) {
		return await getStatistics(this.paths, signal);
	}
	async scanIntegrity(options = {}) {
		if (options.isolateInvalid !== true) return await scanIntegrity(this.paths, this.results, this.lock, options);
		return await this.accessGate.runMaintenance(async (scope) => {
			this.assertNoLocalOperations();
			return await scanIntegrity(this.paths, this.results, this.lock, options, scope);
		}, options.signal);
	}
	async listQuarantine(options = {}) {
		return await listQuarantine(this.paths, options);
	}
	async cleanupQuarantine(options) {
		if (options.dryRun !== false) return await cleanupQuarantine(this.paths, options);
		return await this.accessGate.runMaintenance(async () => {
			this.assertNoLocalOperations();
			return await cleanupQuarantine(this.paths, options);
		}, options.signal);
	}
	async clearCache(options = {}) {
		if (options.dryRun !== false) return await clearCache(this.paths, this.operations, options, false, this.accessGate.activeReaderCount);
		return await this.accessGate.runMaintenance(async () => {
			this.assertNoLocalOperations();
			return await clearCache(this.paths, this.operations, options, true, 0);
		}, options.signal);
	}
	assertNoLocalOperations() {
		if (this.operations.activeOperationCount() > 0) throwMinerU("STORAGE_LOCKED", "MinerU storage is in use by an active parse operation");
	}
};
//#endregion
//#region src/domain/result.ts
const MINERU_RESULT_MANIFEST_SCHEMA_VERSION = 1;
//#endregion
//#region src/domain/schemas.ts
/**
* schemas.ts — Strict runtime parsers and validators for persistent domain JSON records.
*
* Enforces:
*   - Pinned schemaVersion validation (unknown versions rejected)
*   - Closed record shapes (additional/unknown properties rejected)
*   - Safe, branded identifier validation
*   - Clean POSIX relative paths for artifact references (rejection of traversal, absolute paths, NUL, backslashes)
*   - Elimination of local source paths, tokens, query parameters, presigned/CDN URLs from persistent records
*/
const VALID_MODELS = /* @__PURE__ */ new Set(["pipeline", "vlm"]);
const VALID_PARSE_METHODS = /* @__PURE__ */ new Set([
	"auto",
	"txt",
	"ocr"
]);
const VALID_PROVIDERS = new Set(PROVIDER_TYPES);
const VALID_ARTIFACT_KINDS = new Set(ARTIFACT_KINDS);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PAGE_RANGES = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const URL_OR_SECRET_PATTERN = /(?:https?:\/\/|Bearer\s+|[?&\0\r\n])/i;
function assertPlainObject(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
	const proto = Reflect.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new TypeError(`${label} must be a plain object`);
	return value;
}
function assertNoAdditionalProperties(record, allowedKeys, label) {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`unknown property "${key}" in ${label}`);
}
function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
	return value;
}
function assertNonNegativeSafeInteger(value, label) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
	return value;
}
function assertSha256(value, label = "SHA-256 digest") {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new TypeError(`${label} must be a 64-character lowercase hexadecimal SHA-256 digest`);
	return value;
}
function assertNoUrlOrSecret(value, label) {
	if (URL_OR_SECRET_PATTERN.test(value)) throw new TypeError(`${label} must not contain URLs, credentials, query parameters, or control characters`);
	return value;
}
function assertSafeFileName(value, label = "file name") {
	assertNonEmptyString(value, label);
	const str = value;
	if (str.length > 255 || /[\u0000-\u001f\u007f]/.test(str)) throw new TypeError(`${label} contains control characters or exceeds 255 characters`);
	if (str.includes("/") || str.includes("\\") || str === "." || str === "..") throw new TypeError(`${label} "${str}" must not contain path separators or traversal segments`);
	return str;
}
function assertSafeArtifactRelativePath(value, label = "artifact relativePath") {
	assertNonEmptyString(value, label);
	const path = value;
	assertNoUrlOrSecret(path, label);
	if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("./") || path.startsWith("../")) throw new TypeError(`${label} "${path}" must be a relative path and cannot start with / or ./ or ../`);
	if (path.includes("\\") || path.includes("//") || path.includes("\0")) throw new TypeError(`${label} "${path}" contains invalid path separators or control characters`);
	const segments = path.split("/");
	for (const seg of segments) if (!seg || seg === "." || seg === ".." || !SAFE_PATH_SEGMENT.test(seg)) throw new TypeError(`${label} "${path}" contains invalid or traversal path segment "${seg}"`);
	return path;
}
function parseArtifactKind(input) {
	if (typeof input !== "string" || !VALID_ARTIFACT_KINDS.has(input)) throw new TypeError(`invalid artifact kind: "${String(input)}"`);
	return input;
}
function parseParseSemantics(input) {
	const obj = assertPlainObject(input, "ParseSemantics");
	assertNoAdditionalProperties(obj, [
		"model",
		"ocr",
		"parseMethod",
		"language",
		"formula",
		"table",
		"pages"
	], "ParseSemantics");
	const model = obj["model"];
	if (typeof model !== "string" || !VALID_MODELS.has(model)) throw new TypeError(`invalid ParseSemantics.model: "${String(model)}"`);
	const ocr = obj["ocr"];
	if (typeof ocr !== "boolean") throw new TypeError("ParseSemantics.ocr must be a boolean");
	const parseMethod = obj["parseMethod"];
	if (typeof parseMethod !== "string" || !VALID_PARSE_METHODS.has(parseMethod)) throw new TypeError(`invalid ParseSemantics.parseMethod: "${String(parseMethod)}"`);
	if (ocr !== (parseMethod === "ocr")) throw new TypeError("ParseSemantics.ocr must agree with ParseSemantics.parseMethod");
	const language = assertNonEmptyString(obj["language"], "ParseSemantics.language");
	assertNoUrlOrSecret(language, "ParseSemantics.language");
	const formula = obj["formula"];
	if (typeof formula !== "boolean") throw new TypeError("ParseSemantics.formula must be a boolean");
	const table = obj["table"];
	if (typeof table !== "boolean") throw new TypeError("ParseSemantics.table must be a boolean");
	let pages;
	if (obj["pages"] !== void 0) {
		const rawPages = assertNonEmptyString(obj["pages"], "ParseSemantics.pages");
		if (!PAGE_RANGES.test(rawPages) || normalizePageRanges(rawPages) !== rawPages) throw new TypeError(`ParseSemantics.pages is not canonical: "${rawPages}"`);
		pages = rawPages;
	}
	return {
		model,
		ocr,
		parseMethod,
		language,
		formula,
		table,
		...pages === void 0 ? {} : { pages }
	};
}
function parseCanonicalSourceFile(input) {
	const obj = assertPlainObject(input, "CanonicalSourceFile");
	assertNoAdditionalProperties(obj, [
		"fileId",
		"name",
		"bytes",
		"sha256"
	], "CanonicalSourceFile");
	return {
		fileId: asFileId(assertNonEmptyString(obj["fileId"], "CanonicalSourceFile.fileId")),
		name: assertSafeFileName(obj["name"], "CanonicalSourceFile.name"),
		bytes: assertNonNegativeSafeInteger(obj["bytes"], "CanonicalSourceFile.bytes"),
		sha256: assertSha256(obj["sha256"], "CanonicalSourceFile.sha256")
	};
}
function parseCanonicalParseRequest(input) {
	const obj = assertPlainObject(input, "CanonicalParseRequest");
	assertNoAdditionalProperties(obj, [
		"schemaVersion",
		"files",
		"semantics",
		"requiredArtifacts"
	], "CanonicalParseRequest");
	if (obj["schemaVersion"] !== 1) throw new TypeError(`invalid CanonicalParseRequest schemaVersion: expected 1, got ${String(obj["schemaVersion"])}`);
	if (!Array.isArray(obj["files"]) || obj["files"].length === 0) throw new TypeError("CanonicalParseRequest.files must be a non-empty array");
	const files = obj["files"].map((f) => parseCanonicalSourceFile(f));
	const semantics = parseParseSemantics(obj["semantics"]);
	if (!Array.isArray(obj["requiredArtifacts"]) || obj["requiredArtifacts"].length === 0) throw new TypeError("CanonicalParseRequest.requiredArtifacts must be a non-empty array");
	const requiredArtifacts = obj["requiredArtifacts"].map((k) => parseArtifactKind(k));
	if (new Set(requiredArtifacts).size !== requiredArtifacts.length) throw new TypeError("CanonicalParseRequest.requiredArtifacts cannot contain duplicates");
	const normalizedArtifacts = normalizeArtifactKinds(requiredArtifacts);
	if (normalizedArtifacts.length !== requiredArtifacts.length || normalizedArtifacts.some((kind, index) => kind !== requiredArtifacts[index])) throw new TypeError("CanonicalParseRequest.requiredArtifacts must be canonical and include markdown");
	return {
		schemaVersion: 1,
		files,
		semantics,
		requiredArtifacts
	};
}
function parseArtifactRef(input) {
	const obj = assertPlainObject(input, "ArtifactRef");
	assertNoAdditionalProperties(obj, [
		"kind",
		"relativePath",
		"mediaType",
		"bytes",
		"sha256"
	], "ArtifactRef");
	const kind = obj["kind"];
	if (typeof kind !== "string" || kind !== "manifest" && !VALID_ARTIFACT_KINDS.has(kind)) throw new TypeError(`invalid ArtifactRef.kind: "${String(kind)}"`);
	return {
		kind,
		relativePath: assertSafeArtifactRelativePath(obj["relativePath"], "ArtifactRef.relativePath"),
		mediaType: assertNoUrlOrSecret(assertNonEmptyString(obj["mediaType"], "ArtifactRef.mediaType"), "ArtifactRef.mediaType"),
		bytes: assertNonNegativeSafeInteger(obj["bytes"], "ArtifactRef.bytes"),
		sha256: assertSha256(obj["sha256"], "ArtifactRef.sha256")
	};
}
function parseParsedDocumentManifest(input) {
	const obj = assertPlainObject(input, "ParsedDocumentManifest");
	assertNoAdditionalProperties(obj, [
		"fileId",
		"name",
		"artifacts"
	], "ParsedDocumentManifest");
	const fileId = asFileId(assertNonEmptyString(obj["fileId"], "ParsedDocumentManifest.fileId"));
	const name = assertSafeFileName(obj["name"], "ParsedDocumentManifest.name");
	if (!Array.isArray(obj["artifacts"]) || obj["artifacts"].length === 0) throw new TypeError("ParsedDocumentManifest.artifacts must be a non-empty array");
	return {
		fileId,
		name,
		artifacts: obj["artifacts"].map((a) => parseArtifactRef(a))
	};
}
function parseResultProducer(input) {
	const obj = assertPlainObject(input, "ResultProducer");
	assertNoAdditionalProperties(obj, [
		"providerId",
		"providerConfigId",
		"compatibilityKey"
	], "ResultProducer");
	const providerId = obj["providerId"];
	if (typeof providerId !== "string" || !VALID_PROVIDERS.has(providerId)) throw new TypeError(`invalid ResultProducer.providerId: "${String(providerId)}"`);
	return {
		providerId,
		providerConfigId: asProviderConfigId(assertNonEmptyString(obj["providerConfigId"], "ResultProducer.providerConfigId")),
		compatibilityKey: assertNoUrlOrSecret(assertNonEmptyString(obj["compatibilityKey"], "ResultProducer.compatibilityKey"), "ResultProducer.compatibilityKey")
	};
}
function parseMinerUResultManifest(input) {
	const obj = assertPlainObject(input, "MinerUResultManifest");
	assertNoAdditionalProperties(obj, [
		"schemaVersion",
		"id",
		"cacheKey",
		"sourceSha256",
		"request",
		"producer",
		"files",
		"createdAt"
	], "MinerUResultManifest");
	if (obj["schemaVersion"] !== 1) throw new TypeError(`invalid MinerUResultManifest schemaVersion: expected 1, got ${String(obj["schemaVersion"])}`);
	const id = asResultId(assertNonEmptyString(obj["id"], "MinerUResultManifest.id"));
	const cacheKey = asCacheKey(assertNonEmptyString(obj["cacheKey"], "MinerUResultManifest.cacheKey"));
	const sourceSha256 = assertSha256(obj["sourceSha256"], "MinerUResultManifest.sourceSha256");
	const request = parseCanonicalParseRequest(obj["request"]);
	const producer = parseResultProducer(obj["producer"]);
	if (!Array.isArray(obj["files"]) || obj["files"].length !== 1) throw new TypeError("MinerUResultManifest.files must be a tuple with exactly one ParsedDocumentManifest");
	return {
		schemaVersion: 1,
		id,
		cacheKey,
		sourceSha256,
		request,
		producer,
		files: [parseParsedDocumentManifest(obj["files"][0])],
		createdAt: assertNonNegativeSafeInteger(obj["createdAt"], "MinerUResultManifest.createdAt")
	};
}
//#endregion
//#region src/storage/paths.ts
/**
* paths.ts — Validated filesystem layout and path derivation for MinerU storage.
*
* Enforces:
*   - Strict identifier validation before path concatenation (prevents path traversal)
*   - Relative POSIX artifact path containment within result/staging roots
*   - Safe, deterministic directory layout documented in ARCHITECTURE.md
*/
function defaultStorageRoot() {
	const configured = process.env.DSH_HOME?.trim();
	const dshHome = !configured ? join(homedir(), ".dsh") : configured === "~" ? homedir() : configured.startsWith("~/") || configured.startsWith("~\\") ? resolve(join(homedir(), configured.slice(2))) : resolve(configured);
	return join(dshHome, "cache", "pdf-mineru");
}
var StoragePaths = class {
	root;
	constructor(root = defaultStorageRoot()) {
		if (!root || typeof root !== "string" || root.trim() === "") throw new TypeError("Storage root path must be a non-empty string");
		this.root = resolve(root);
	}
	resultsDir() {
		return join(this.root, "results", "sha256");
	}
	resultDir(cacheKey) {
		const key = asCacheKey(cacheKey);
		return join(this.resultsDir(), key.slice(0, 2), key);
	}
	manifestFile(cacheKey) {
		return join(this.resultDir(cacheKey), "manifest.json");
	}
	filesDir(cacheKey) {
		return join(this.resultDir(cacheKey), "files");
	}
	fileDir(cacheKey, fileId) {
		const fid = asFileId(fileId);
		return join(this.filesDir(cacheKey), fid);
	}
	stagingDir(operationId) {
		if (operationId === void 0) return join(this.root, "staging");
		const op = asOperationId(operationId);
		return join(this.root, "staging", op);
	}
	stagingFilesDir(operationId) {
		return join(this.stagingDir(operationId), "files");
	}
	stagingFileDir(operationId, fileId) {
		const fid = asFileId(fileId);
		return join(this.stagingFilesDir(operationId), fid);
	}
	stagingTempDir(operationId) {
		return join(this.stagingDir(operationId), "temp");
	}
	stagingManifestFile(operationId) {
		return join(this.stagingDir(operationId), "manifest.json");
	}
	quarantineDir(name) {
		if (name === void 0) return join(this.root, "quarantine");
		const safeName = assertSafePathSegment(name, "quarantine name");
		return join(this.root, "quarantine", safeName);
	}
	processLockFile() {
		return join(this.root, ".process.lock");
	}
	/** v2 bakery lock state directory (<root>/.lock). */
	lockDir() {
		return join(this.root, ".lock");
	}
	/** v2 bakery claim directory (<root>/.lock/claims). */
	lockClaimsDir() {
		return join(this.lockDir(), "claims");
	}
	/** Cross-process storage use records (<root>/.lock/users). */
	lockUsersDir() {
		return join(this.lockDir(), "users");
	}
	resolveArtifactPath(cacheKey, relativePath) {
		assertSafeArtifactRelativePath(relativePath);
		const base = this.resultDir(cacheKey);
		const target = resolve(base, relativePath);
		if (!target.startsWith(base + sep)) throw new TypeError(`artifact relative path "${relativePath}" escapes result directory`);
		return target;
	}
	resolveStagingArtifactPath(operationId, relativePath) {
		assertSafeArtifactRelativePath(relativePath);
		const base = this.stagingDir(operationId);
		const target = resolve(base, relativePath);
		if (!target.startsWith(base + sep)) throw new TypeError(`artifact relative path "${relativePath}" escapes staging directory`);
		return target;
	}
};
//#endregion
//#region src/storage/artifact-sink.ts
/**
* artifact-sink.ts — Staging-backed ArtifactSink implementation for MinerU providers.
*
* Enforces:
*   - Streaming I/O with on-the-fly SHA-256 and byte accounting
*   - Per-artifact byte limit enforcement (throws RESULT_TOO_LARGE on breach)
*   - Clean POSIX relative artifact paths within staging and result boundaries
*   - Automatic temporary file cleanup on stream failure
*/
function toNodeReadable(input) {
	if (typeof input === "string") return Readable.from([Buffer.from(input, "utf8")]);
	if (input instanceof Uint8Array) return Readable.from([input]);
	if (input instanceof Readable) return input;
	if (input !== null && typeof input === "object" && "getReader" in input && typeof input.getReader === "function") return Readable.fromWeb(input);
	throw new TypeError(`Unsupported artifact input type: ${typeof input}`);
}
async function streamToFile(input, destinationPath, maxBytes, signal) {
	signal?.throwIfAborted();
	await mkdir(dirname(destinationPath), { recursive: true });
	const hash = createHash("sha256");
	let totalBytes = 0;
	const source = toNodeReadable(input);
	const temporaryPath = `${destinationPath}.part_${randomUUID().replaceAll("-", "")}`;
	const byteTracker = new Transform({ transform(chunk, _encoding, callback) {
		totalBytes += chunk.length;
		if (maxBytes !== void 0 && totalBytes > maxBytes) {
			callback(/* @__PURE__ */ new Error("ARTIFACT_MAX_BYTES_EXCEEDED"));
			return;
		}
		hash.update(chunk);
		callback(null, chunk);
	} });
	const destination = createWriteStream(temporaryPath, {
		flags: "wx",
		mode: 384
	});
	try {
		await pipeline(source, byteTracker, destination, { signal });
		await link(temporaryPath, destinationPath);
		await unlink(temporaryPath);
		return {
			bytes: totalBytes,
			sha256: hash.digest("hex")
		};
	} catch (err) {
		try {
			await unlink(temporaryPath);
		} catch {}
		if (err instanceof Error && err.message === "ARTIFACT_MAX_BYTES_EXCEEDED") throwMinerU("RESULT_TOO_LARGE", `Artifact output exceeded byte limit of ${String(maxBytes)} bytes`);
		throw err;
	}
}
function defaultArtifactFileName(kind, imageIndex) {
	switch (kind) {
		case "markdown": return "full.md";
		case "layout": return "layout.json";
		case "model-output": return "model.json";
		case "content-list": return "content_list.json";
		case "images": return `images/img_${String(imageIndex)}.png`;
	}
}
var StagingArtifactSink = class {
	paths;
	signal;
	defaultMaxBytes;
	imageCounter = 0;
	operationId;
	constructor(operationId, paths, signal, defaultMaxBytes) {
		this.paths = paths;
		this.signal = signal;
		this.defaultMaxBytes = defaultMaxBytes;
		this.operationId = asOperationId(operationId);
	}
	async writeArtifact(fileId, kind, input, options) {
		const validFileId = asFileId(fileId);
		const validKind = parseArtifactKind(kind);
		let relativeSubPath;
		if (options.relativeName !== void 0 && options.relativeName.trim() !== "") relativeSubPath = assertSafeArtifactRelativePath(options.relativeName, "options.relativeName");
		else relativeSubPath = defaultArtifactFileName(validKind, this.imageCounter++);
		const relativePath = assertSafeArtifactRelativePath(`files/${validFileId}/${relativeSubPath}`, "artifact relativePath");
		const { bytes, sha256 } = await streamToFile(input, this.paths.resolveStagingArtifactPath(this.operationId, relativePath), options.maxBytes ?? this.defaultMaxBytes, this.signal);
		return parseArtifactRef({
			kind: validKind,
			relativePath,
			mediaType: options.mediaType,
			bytes,
			sha256
		});
	}
	async writeTemporary(name, input, maxBytes) {
		const safeName = assertSafeFileName(name, "temporary artifact name");
		const destPath = `${this.paths.stagingTempDir(this.operationId)}/${safeName}`;
		const { bytes, sha256 } = await streamToFile(input, destPath, maxBytes, this.signal);
		return {
			path: destPath,
			bytes,
			sha256
		};
	}
};
//#endregion
//#region src/storage/result-repository.ts
const DEFAULT_MAX_JSON_VALIDATION_BYTES = 67108864;
const DEFAULT_MAX_MANIFEST_BYTES = 16777216;
function errnoCode(error) {
	return error?.code;
}
function isAbort(error, signal) {
	return signal?.aborted === true || error instanceof Error && error.name === "AbortError";
}
function inspectionFailure(error, fallback) {
	const code = errnoCode(error);
	if (code === "ENOENT") return {
		status: "missing",
		reason: "missing-entry"
	};
	if (code === "EACCES" || code === "EPERM" || code === "EIO" || code === "EBUSY") return {
		status: "unreadable",
		reason: "io-error"
	};
	return {
		status: "corrupt",
		reason: fallback
	};
}
function containedSegments(root, candidate) {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep)) return;
	return relativePath.split(sep);
}
function assertQuarantineSourcePath(paths, sourcePath) {
	const candidate = resolve(sourcePath);
	const staging = containedSegments(paths.stagingDir(), candidate);
	if (staging?.length === 1) {
		const operationId = asOperationId(staging[0]);
		if (candidate === paths.stagingDir(operationId)) return candidate;
	}
	const published = containedSegments(paths.resultsDir(), candidate);
	if (published?.length === 2 && /^[a-f0-9]{2}$/.test(published[0])) {
		const cacheKey = asCacheKey(published[1]);
		if (published[0] === cacheKey.slice(0, 2) && candidate === paths.resultDir(cacheKey)) return candidate;
	}
	throw new TypeError("Only a complete staging operation or published result directory can be quarantined");
}
async function assertRegularDirectoryWithin(rootDir, directoryPath) {
	const relativePath = relative(rootDir, directoryPath);
	if (relativePath === "" || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep)) throw new TypeError("Result directory escapes its storage root");
	const root = await lstat(rootDir);
	if (root.isSymbolicLink() || !root.isDirectory()) throw new TypeError("Result storage root is not a regular directory");
	let current = rootDir;
	for (const segment of relativePath.split(sep)) {
		if (segment === "") throw new TypeError("Result directory contains an empty segment");
		current = join(current, segment);
		const details = await lstat(current);
		if (details.isSymbolicLink() || !details.isDirectory()) throw new TypeError("Result storage must not contain symlinked directories");
	}
}
/** Refuse symlinked path components before opening a published artifact. */
async function assertRegularFileWithin(rootDir, filePath) {
	const relativePath = relative(rootDir, filePath);
	if (relativePath === "" || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep)) throw new TypeError("Artifact path escapes its result directory");
	const root = await lstat(rootDir);
	if (root.isSymbolicLink() || !root.isDirectory()) throw new TypeError("Result directory is not a regular directory");
	const segments = relativePath.split(sep);
	let current = rootDir;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === void 0 || segment === "") throw new TypeError("Artifact path contains an empty segment");
		current = join(current, segment);
		const details = await lstat(current);
		if (details.isSymbolicLink()) throw new TypeError("Result data must not contain symlinks");
		if (index === segments.length - 1) {
			if (!details.isFile()) throw new TypeError("Artifact is not a regular file");
		} else if (!details.isDirectory()) throw new TypeError("Artifact parent is not a regular directory");
	}
}
async function readUtf8Bounded(path, maxBytes, label, signal) {
	const decoder = new TextDecoder$1("utf-8", { fatal: true });
	const stream = createReadStream(path);
	const onAbort = () => {
		stream.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	let totalBytes = 0;
	let text = "";
	try {
		signal?.throwIfAborted();
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			const buffer = chunk;
			totalBytes += buffer.byteLength;
			if (totalBytes > maxBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", label + " exceeds its validation limit"));
			text += decoder.decode(buffer, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		stream.destroy();
	}
}
async function validateUtf8(path, signal) {
	const decoder = new TextDecoder$1("utf-8", { fatal: true });
	const stream = createReadStream(path);
	const onAbort = () => {
		stream.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		signal?.throwIfAborted();
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			decoder.decode(chunk, { stream: true });
		}
		decoder.decode();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		stream.destroy();
	}
}
function samePublicationSemantics(left, right) {
	const leftSource = left.request.files[0];
	const rightSource = right.request.files[0];
	return left.cacheKey === right.cacheKey && left.sourceSha256 === right.sourceSha256 && leftSource?.sha256 === rightSource?.sha256 && leftSource?.bytes === rightSource?.bytes && left.request.schemaVersion === right.request.schemaVersion && left.producer.compatibilityKey === right.producer.compatibilityKey && canonicalJson(left.request.semantics) === canonicalJson(right.request.semantics) && canonicalJson(left.request.requiredArtifacts) === canonicalJson(right.request.requiredArtifacts);
}
var ResultTransaction = class {
	request;
	producer;
	paths;
	operationId;
	stagingDir;
	sink;
	constructor(operationId, request, producer, paths, signal, maxArtifactBytes) {
		this.request = request;
		this.producer = producer;
		this.paths = paths;
		this.operationId = asOperationId(operationId);
		this.stagingDir = paths.stagingDir(this.operationId);
		this.sink = new StagingArtifactSink(this.operationId, paths, signal, maxArtifactBytes);
	}
	writeArtifact(fileId, kind, input, options) {
		return this.sink.writeArtifact(fileId, kind, input, options);
	}
	writeTemporary(name, input, maxBytes) {
		return this.sink.writeTemporary(name, input, maxBytes);
	}
	buildManifest(file, artifacts) {
		if (this.request.files.length !== 1 || this.request.files[0]?.fileId !== file.fileId) throw new TypeError("Result manifests are single-file and must use the transaction request file");
		const cacheKey = computeCacheKey(this.request, file, this.producer.compatibilityKey);
		return {
			schemaVersion: 1,
			id: resultIdForCacheKey(cacheKey),
			cacheKey,
			sourceSha256: file.sha256,
			request: this.request,
			producer: this.producer,
			files: [{
				fileId: file.fileId,
				name: file.name,
				artifacts
			}],
			createdAt: Date.now()
		};
	}
	async abort() {
		await rm(this.stagingDir, {
			recursive: true,
			force: true
		});
	}
};
var ResultRepository = class {
	paths;
	lock;
	maxJsonValidationBytes;
	maxManifestBytes;
	maxArtifactBytes;
	mutationLock;
	constructor(paths, options = {}, lock) {
		this.paths = paths;
		this.lock = lock;
		this.maxJsonValidationBytes = options.maxJsonValidationBytes ?? DEFAULT_MAX_JSON_VALIDATION_BYTES;
		this.maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
		if (!Number.isSafeInteger(this.maxManifestBytes) || this.maxManifestBytes <= 0) throw new TypeError("maxManifestBytes must be a positive safe integer");
		this.maxArtifactBytes = options.maxArtifactBytes;
		this.mutationLock = lock;
	}
	beginTransaction(operationId, request, producer, signal) {
		return new ResultTransaction(operationId, request, producer, this.paths, signal, this.maxArtifactBytes);
	}
	assertManifestConsistency(tx, manifest) {
		const source = manifest.request.files[0];
		const document = manifest.files[0];
		if (manifest.request.files.length !== 1 || source === void 0) throw new TypeError("Result manifest request must contain exactly one file");
		if (manifest.sourceSha256 !== source.sha256 || document.fileId !== source.fileId) throw new TypeError("Result manifest source metadata is inconsistent");
		const expectedKey = computeCacheKey(manifest.request, source, manifest.producer.compatibilityKey);
		if (manifest.cacheKey !== expectedKey || manifest.id !== resultIdForCacheKey(expectedKey)) throw new TypeError("Result manifest content-addressed identifiers are inconsistent");
		if (tx !== void 0 && (canonicalJson(tx.request) !== canonicalJson(manifest.request) || canonicalJson(tx.producer) !== canonicalJson(manifest.producer))) throw new TypeError("Result manifest does not belong to its transaction");
		const required = new Set(manifest.request.requiredArtifacts);
		const present = new Set(document.artifacts.map((artifact) => artifact.kind));
		for (const kind of required) if (!present.has(kind)) throw new TypeError(`Result manifest is missing required artifact ${kind}`);
		const paths = /* @__PURE__ */ new Set();
		const prefix = `files/${document.fileId}/`;
		for (const artifact of document.artifacts) {
			if (!artifact.relativePath.startsWith(prefix)) throw new TypeError("Artifact path does not belong to the manifest file");
			if (paths.has(artifact.relativePath)) throw new TypeError("Result manifest contains duplicate artifact paths");
			paths.add(artifact.relativePath);
		}
	}
	async verifyArtifact(rootDir, path, artifact, signal) {
		signal?.throwIfAborted();
		await assertRegularFileWithin(rootDir, path);
		if ((await lstat(path)).size !== artifact.bytes) throw new TypeError(`Artifact ${artifact.relativePath} size mismatch`);
		if (await computeFileSha256(path, signal) !== artifact.sha256) throw new TypeError(`Artifact ${artifact.relativePath} SHA-256 mismatch`);
		if (artifact.kind === "markdown") await validateUtf8(path, signal);
		if (artifact.kind === "layout" || artifact.kind === "model-output" || artifact.kind === "content-list") {
			if (artifact.bytes > this.maxJsonValidationBytes) throw new MinerUError(failure("RESULT_TOO_LARGE", `JSON artifact ${artifact.relativePath} exceeds validation limit`));
			const json = await readUtf8Bounded(path, this.maxJsonValidationBytes, "JSON artifact", signal);
			JSON.parse(json);
		}
	}
	async verifyManifestArtifacts(manifest, rootDir, resolvePath, signal) {
		for (const artifact of manifest.files[0].artifacts) await this.verifyArtifact(rootDir, resolvePath(artifact.relativePath), artifact, signal);
	}
	async assertPublishedTreeContents(rootDir, manifest, signal) {
		const expectedFiles = /* @__PURE__ */ new Set(["manifest.json"]);
		const expectedDirectories = /* @__PURE__ */ new Set();
		for (const artifact of manifest.files[0].artifacts) {
			expectedFiles.add(artifact.relativePath);
			const segments = artifact.relativePath.split("/");
			for (let index = 1; index < segments.length; index++) expectedDirectories.add(segments.slice(0, index).join("/"));
		}
		const walk = async (directory, relativeDirectory) => {
			signal?.throwIfAborted();
			const details = await lstat(directory);
			if (details.isSymbolicLink() || !details.isDirectory()) throw new TypeError("Published result contains an unsafe directory");
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				signal?.throwIfAborted();
				assertSafePathSegment(entry.name, "published result entry");
				const relativePath = relativeDirectory === "" ? entry.name : relativeDirectory + "/" + entry.name;
				const path = join(directory, entry.name);
				const child = await lstat(path);
				if (child.isSymbolicLink()) throw new TypeError("Published result contains a symlink");
				if (child.isDirectory()) {
					if (!expectedDirectories.has(relativePath)) throw new TypeError("Published result contains an undeclared directory");
					await walk(path, relativePath);
				} else if (child.isFile()) {
					if (!expectedFiles.has(relativePath)) throw new TypeError("Published result contains an undeclared file");
				} else throw new TypeError("Published result contains an unsupported filesystem entry");
			}
		};
		await walk(rootDir, "");
	}
	async commitTransaction(tx, manifest, signal) {
		signal?.throwIfAborted();
		const validated = parseMinerUResultManifest(manifest);
		this.assertManifestConsistency(tx, validated);
		try {
			await this.verifyManifestArtifacts(validated, tx.stagingDir, (relativePath) => this.paths.resolveStagingArtifactPath(tx.operationId, relativePath), signal);
		} catch (error) {
			await tx.abort();
			if (error instanceof MinerUError) throw error;
			throw new MinerUError(failure("CACHE_CORRUPT", error instanceof Error ? error.message : String(error)));
		}
		const stagingManifestPath = this.paths.stagingManifestFile(tx.operationId);
		const serializedManifest = JSON.stringify(validated, null, 2);
		if (Buffer.byteLength(serializedManifest, "utf8") > this.maxManifestBytes) {
			await tx.abort();
			throw new MinerUError(failure("RESULT_TOO_LARGE", "Result manifest exceeds its publication limit"));
		}
		await writeFile(stagingManifestPath, serializedManifest, {
			encoding: "utf8",
			mode: 384
		});
		await rm(this.paths.stagingTempDir(tx.operationId), {
			recursive: true,
			force: true
		});
		try {
			await this.assertPublishedTreeContents(tx.stagingDir, validated, signal);
		} catch (error) {
			await tx.abort();
			if (error instanceof MinerUError) throw error;
			throw new MinerUError(failure("CACHE_CORRUPT", error instanceof Error ? error.message : String(error)));
		}
		const targetDir = this.paths.resultDir(validated.cacheKey);
		const resolveExisting = async (scope) => {
			const existing = await this.get(validated.cacheKey, void 0, signal);
			if (existing === void 0) return void 0;
			if (!samePublicationSemantics(existing, validated)) {
				await this.quarantineScoped(this.mutationLock, scope, tx.stagingDir, "conflict");
				throw new MinerUError(failure("CACHE_CONFLICT", `Cache conflict detected for key ${validated.cacheKey}`));
			}
			await tx.abort();
			return existing;
		};
		const doCommit = async (scope) => {
			this.mutationLock.assertScope(scope);
			await this.ensureResultParentScoped(scope, validated.cacheKey);
			const before = await resolveExisting(scope);
			if (before !== void 0) {
				await tx.abort().catch(() => void 0);
				return {
					resultId: before.id,
					cacheKey: before.cacheKey,
					manifest: before
				};
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				signal?.throwIfAborted();
				try {
					await rename(tx.stagingDir, targetDir);
					return {
						resultId: validated.id,
						cacheKey: validated.cacheKey,
						manifest: validated
					};
				} catch (error) {
					const code = error.code;
					if (code === "EEXIST" || code === "ENOTEMPTY") {
						const raced = await resolveExisting(scope);
						if (raced !== void 0) {
							await tx.abort().catch(() => void 0);
							return {
								resultId: raced.id,
								cacheKey: raced.cacheKey,
								manifest: raced
							};
						}
						continue;
					}
					await this.quarantineScoped(this.mutationLock, scope, tx.stagingDir, "commit_failed").catch(() => void 0);
					throw error;
				}
			}
			await this.quarantineScoped(this.mutationLock, scope, tx.stagingDir, "commit_race").catch(() => void 0);
			throw new MinerUError(failure("CACHE_CONFLICT", `Could not atomically publish cache key ${validated.cacheKey}`));
		};
		await this.mutationLock.initialize(signal);
		return await this.mutationLock.withLock(doCommit, signal);
	}
	/** Strictly verifies one published result without moving or modifying it. */
	async inspectPublished(cacheKey, signal) {
		signal?.throwIfAborted();
		const key = asCacheKey(cacheKey);
		const resultDir = this.paths.resultDir(key);
		try {
			await assertRegularDirectoryWithin(this.paths.resultsDir(), resultDir);
		} catch (error) {
			if (isAbort(error, signal)) throw signal?.reason ?? error;
			if (errnoCode(error) === "ENOENT") return {
				status: "missing",
				reason: "absent"
			};
			return inspectionFailure(error, "unsafe-entry");
		}
		let raw;
		try {
			const manifestPath = this.paths.manifestFile(key);
			await assertRegularFileWithin(resultDir, manifestPath);
			raw = await readUtf8Bounded(manifestPath, this.maxManifestBytes, "Result manifest", signal);
		} catch (error) {
			if (isAbort(error, signal)) throw signal?.reason ?? error;
			return inspectionFailure(error, "unsafe-entry");
		}
		let manifest;
		try {
			manifest = parseMinerUResultManifest(JSON.parse(raw));
			this.assertManifestConsistency(void 0, manifest);
			if (manifest.cacheKey !== key) throw new TypeError("Manifest cache key does not match its directory");
		} catch (error) {
			if (isAbort(error, signal)) throw signal?.reason ?? error;
			return {
				status: "corrupt",
				reason: "manifest-invalid"
			};
		}
		try {
			await this.verifyManifestArtifacts(manifest, resultDir, (relativePath) => this.paths.resolveArtifactPath(key, relativePath), signal);
			await this.assertPublishedTreeContents(resultDir, manifest, signal);
		} catch (error) {
			if (isAbort(error, signal)) throw signal?.reason ?? error;
			return inspectionFailure(error, "artifact-invalid");
		}
		return {
			status: "valid",
			manifest
		};
	}
	async get(cacheKey, requiredArtifacts, signal) {
		signal?.throwIfAborted();
		const key = asCacheKey(cacheKey);
		const inspection = await this.inspectPublished(key, signal);
		if (inspection.status !== "valid") {
			if (inspection.status === "missing" && inspection.reason === "absent") return void 0;
			throw new MinerUError(failure("CACHE_CORRUPT", "Published MinerU cache data is invalid; run explicit storage integrity maintenance before retrying"));
		}
		const manifest = inspection.manifest;
		if (requiredArtifacts !== void 0) {
			const present = new Set(manifest.files[0].artifacts.map((artifact) => artifact.kind));
			if (requiredArtifacts.some((kind) => !present.has(kind))) return void 0;
		}
		return manifest;
	}
	resolveArtifactAbsolutePath(cacheKey, relativePath) {
		return this.paths.resolveArtifactPath(cacheKey, relativePath);
	}
	manifestAbsolutePath(cacheKey) {
		return this.paths.manifestFile(cacheKey);
	}
	/** Mutation helper for callers already holding the exact authority lock. */
	async quarantineScoped(authority, scope, sourcePath, reason = "quarantine") {
		if (authority.paths.root !== this.paths.root) throw new TypeError("Quarantine lock root does not match repository root");
		authority.assertScope(scope);
		const safeSourcePath = assertQuarantineSourcePath(this.paths, sourcePath);
		if (containedSegments(this.paths.resultsDir(), safeSourcePath)?.length === 2) {
			if ((await listUseRecords(this.paths)).some((user) => user.kind !== "dead")) throw new MinerUError(failure("STORAGE_LOCKED", "Published MinerU data is in use by an active or unverifiable reader"));
		}
		const id = `${String(Date.now())}_${reason}_${randomUUID().slice(0, 8)}`;
		const destination = this.paths.quarantineDir(id);
		try {
			await assertRegularDirectoryWithin(this.paths.root, safeSourcePath);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return destination;
			throw new MinerUError(failure("CACHE_CORRUPT", "Failed to isolate corrupt MinerU data safely"));
		}
		try {
			await mkdir(this.paths.quarantineDir(), { recursive: true });
			const quarantineRoot = await lstat(this.paths.quarantineDir());
			if (quarantineRoot.isSymbolicLink() || !quarantineRoot.isDirectory()) throw new TypeError("Quarantine root is not a regular directory");
			await rename(safeSourcePath, destination);
			return destination;
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return destination;
			throw new MinerUError(failure("CACHE_CORRUPT", "Failed to isolate corrupt MinerU data"));
		}
	}
	async ensureResultParentScoped(scope, cacheKey) {
		this.mutationLock.assertScope(scope);
		const ancestors = [
			join(this.paths.root, "results"),
			this.paths.resultsDir(),
			dirname(this.paths.resultDir(cacheKey))
		];
		for (const ancestor of ancestors) {
			try {
				await mkdir(ancestor, { mode: 448 });
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") throw error;
			}
			const details = await lstat(ancestor);
			if (details.isSymbolicLink() || !details.isDirectory()) throw new MinerUError(failure("CACHE_CORRUPT", "Result publication ancestors must be regular directories"));
		}
	}
	async cleanupStaging(ttlMs, activeOperationIds = /* @__PURE__ */ new Set(), signal) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("staging TTL must be a positive safe integer");
		await this.mutationLock.initialize(signal);
		return await this.mutationLock.withLock(async (scope) => {
			this.mutationLock.assertScope(scope);
			if ((await listUseRecords(this.paths)).some((user) => user.kind !== "dead")) return 0;
			const stagingRoot = this.paths.stagingDir();
			let entries;
			try {
				const root = await lstat(stagingRoot);
				if (root.isSymbolicLink() || !root.isDirectory()) return 0;
				entries = await readdir(stagingRoot);
			} catch (error) {
				if (errnoCode(error) === "ENOENT") return 0;
				throw error;
			}
			let cleaned = 0;
			const now = Date.now();
			for (const entry of entries) {
				signal?.throwIfAborted();
				let operationId;
				try {
					operationId = asOperationId(entry);
				} catch {
					continue;
				}
				if (activeOperationIds.has(operationId)) continue;
				const path = this.paths.stagingDir(operationId);
				try {
					const details = await lstat(path);
					if (!details.isSymbolicLink() && details.isDirectory() && now - details.mtimeMs > ttlMs) {
						await rm(path, {
							recursive: true,
							force: true
						});
						cleaned++;
					}
				} catch (error) {
					if (errnoCode(error) !== "ENOENT") throw error;
				}
			}
			return cleaned;
		}, signal);
	}
};
//#endregion
//#region src/tools/common.ts
function invalidRequest(message, cause) {
	return new MinerUError(failure("INVALID_REQUEST", message), cause === void 0 ? void 0 : { cause });
}
function requireAgent(exec) {
	const agent = exec.agent;
	if (agent === void 0 || agent.session == null) throw new MinerUError(failure("UNAUTHENTICATED_SESSION", "MinerU operations require an authenticated agent session (UNAUTHENTICATED_SESSION)"));
	return agent;
}
function argumentRecord(args, allowed) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw invalidRequest("Tool arguments must be an object");
	const record = args;
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalidRequest(`Unsupported parameter: ${key}. Valid parameters: ${[...allowed].join(", ")}`);
	return record;
}
function parseDocumentSource(args) {
	if (args.file_path !== void 0 === (args.attachment_id !== void 0)) throw invalidRequest("Exactly one of file_path or attachment_id is required");
	if (args.file_path !== void 0) {
		if (typeof args.file_path !== "string" || args.file_path.trim() === "") throw invalidRequest("file_path must be a non-empty string");
		return { file_path: args.file_path.trim() };
	}
	if (typeof args.attachment_id !== "string" || !/^(?:sha256:)?[a-fA-F0-9]{8,64}$/.test(args.attachment_id.trim())) throw invalidRequest("attachment_id must be a SHA-256 digest or an unambiguous prefix of 8–64 hexadecimal characters, optionally prefixed with sha256:");
	return { attachment_id: args.attachment_id.trim().toLowerCase() };
}
function* fileReferences(blocks) {
	for (const block of blocks) if (block.type === "file") yield block.attachment;
}
/** Resolve a visible session file reference to its host path; never scan raw history or storage. */
function resolveAttachmentPath(attachmentId, session, attachments) {
	if (attachments === void 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", "Attachment input requires the DSH attachment service; use file_path instead"));
	const prefix = attachmentId.replace(/^sha256:/, "");
	const matches = /* @__PURE__ */ new Map();
	for (const message of session.deriveMessages()) for (const ref of fileReferences(message.content)) {
		const id = String(ref.attachmentId);
		if (id.slice(7).startsWith(prefix) && !matches.has(id)) matches.set(id, ref);
	}
	if (matches.size === 0) throw invalidRequest("No file attachment matches attachment_id on the current session surface");
	if (matches.size > 1) throw invalidRequest("attachment_id is ambiguous; use a longer prefix or the full SHA-256 ID");
	const ref = matches.values().next().value;
	const path = attachments.fileHostPath(ref);
	if (path === void 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", "The DSH attachment backend does not provide a host file path; use file_path instead"));
	return path;
}
/** Absolute source path: file paths resolve against the caller's effective working directory. */
async function resolveSourcePath(source, agent, exec, ctx, attachments) {
	if (source.file_path === void 0) return resolveAttachmentPath(source.attachment_id, agent.session, attachments);
	return resolve(await ctx.workingDirectory.ensure(agent, exec.signal), source.file_path);
}
/** Whether the calling model route accepts image input; unknown routes are text-only. */
async function modelSupportsImages(exec, ctx) {
	const routed = exec.agent?.session?.requestHeader?.()?.config;
	const provider = routed?.provider ?? exec.agent?.options?.provider;
	const model = routed?.model ?? exec.agent?.options?.model;
	const llm = ctx.get("llm");
	if (provider && model && llm) try {
		return (await llm.resolveModelInfo(provider, model, exec.signal))?.inputModalities?.includes("image") ?? false;
	} catch (error) {
		if (exec.signal.aborted) throw error;
		return false;
	}
	return false;
}
//#endregion
//#region src/tools/schemas.ts
/** Model-facing parameter and output schemas. Every object declares additionalProperties. */
const artifactViewSchema = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			required: true
		},
		path: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		}
	},
	additionalProperties: false
};
const inlinedImageViewSchema = {
	type: "object",
	properties: {
		block_id: { type: "string" },
		document_label: { type: "string" },
		page: { type: "integer" },
		attachment_id: {
			type: "string",
			required: true
		},
		name: {
			type: "string",
			required: true
		},
		media_type: {
			type: "string",
			required: true
		},
		width: { type: "integer" },
		height: { type: "integer" },
		bytes: { type: "integer" },
		figure: {
			type: "integer",
			description: "Attachment selection index only; use document_label for the original paper figure number."
		}
	},
	additionalProperties: false
};
const imageCandidateViewSchema = {
	type: "object",
	properties: {
		block_id: { type: "string" },
		document_label: { type: "string" },
		path: {
			type: "string",
			required: true
		},
		name: {
			type: "string",
			required: true
		},
		page: { type: "integer" },
		caption: { type: "string" },
		media_type: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		status: {
			type: "string",
			enum: [
				"available",
				"unavailable",
				"unsupported",
				"failed",
				"omitted"
			]
		}
	},
	additionalProperties: false
};
const documentHeadingSchema = {
	type: "object",
	properties: {
		block_id: { type: "string" },
		level: {
			type: "integer",
			required: true
		},
		title: {
			type: "string",
			required: true
		},
		line: { type: "integer" },
		page: { type: "integer" }
	},
	additionalProperties: false
};
const documentSummarySchema = {
	type: "object",
	properties: {
		page_count: { type: "integer" },
		page_count_source: {
			type: "string",
			enum: [
				"layout",
				"content-list-lower-bound",
				"pdfinfo",
				"pdfjs"
			]
		},
		table_count: { type: "integer" },
		image_count: { type: "integer" },
		equation_count: { type: "integer" },
		toc: {
			type: "array",
			items: documentHeadingSchema
		}
	},
	additionalProperties: false
};
const resultViewSchema = {
	type: "object",
	properties: {
		state: {
			type: "string",
			enum: ["completed"],
			required: true
		},
		source: {
			type: "string",
			enum: [
				"cache",
				"shared-operation",
				"provider",
				"local"
			],
			required: true
		},
		cache_hit: {
			type: "boolean",
			required: true
		},
		result_id: {
			type: "string",
			required: true
		},
		files: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file_id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					artifacts: {
						type: "array",
						items: artifactViewSchema,
						required: true
					},
					artifacts_truncated: { type: "boolean" },
					markdown_path: { type: "string" }
				},
				additionalProperties: false
			},
			required: true
		},
		markdown_content: { type: "string" },
		content_status: {
			type: "string",
			enum: [
				"complete",
				"partial",
				"not_requested"
			],
			required: true
		},
		markdown_path: { type: "string" },
		cursor: {
			oneOf: [{ type: "string" }, { type: "null" }],
			required: true,
			description: "Non-empty continuation token when content_status is partial; null otherwise. Stop reading when null."
		},
		warnings: {
			type: "array",
			items: { type: "string" }
		},
		provenance: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					enum: [...PROVIDER_TYPES],
					required: true
				},
				model: {
					oneOf: [{
						type: "string",
						enum: ["pipeline", "vlm"]
					}, { type: "null" }],
					required: true
				},
				parse_method: {
					type: "string",
					enum: [
						"auto",
						"txt",
						"ocr"
					],
					required: true
				},
				upstream_version: {
					type: "null",
					required: true
				},
				index_version: {
					type: "integer",
					required: true
				},
				reader_version: {
					type: "integer",
					required: true
				}
			},
			additionalProperties: false
		},
		diagnostics: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						required: true
					},
					code: {
						type: "string",
						required: true
					},
					scope: {
						type: "string",
						enum: [
							"document",
							"selection",
							"chunk"
						],
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					block_id: { type: "string" },
					page: { type: "integer" }
				},
				additionalProperties: false
			}
		},
		verification_hints: {
			type: "array",
			items: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						enum: ["formula"],
						required: true
					},
					block_id: {
						type: "string",
						required: true
					},
					page: { type: "integer" },
					view: {
						type: "string",
						enum: ["page"],
						required: true
					}
				},
				additionalProperties: false
			}
		},
		metadata_shortened: {
			type: "array",
			items: {
				type: "string",
				enum: [
					"summary",
					"provenance",
					"diagnostics",
					"verification_hints",
					"warnings"
				]
			}
		},
		manifest_path: { type: "string" },
		source_sha256: { type: "string" },
		continuation_block: {
			type: "object",
			properties: {
				block_id: {
					type: "string",
					required: true
				},
				page: { type: "integer" },
				document_label: { type: "string" }
			},
			additionalProperties: false
		},
		view: {
			type: "string",
			enum: ["content", "page"]
		},
		renderer: {
			type: "string",
			enum: ["poppler", "pdfjs"]
		},
		visuals: {
			type: "object",
			properties: {
				listed: {
					type: "integer",
					required: true
				},
				attached: {
					type: "integer",
					required: true
				},
				omitted: {
					type: "integer",
					required: true
				},
				scope: {
					type: "string",
					enum: ["chunk"],
					required: true
				}
			},
			additionalProperties: false
		},
		output_limit_chars: {
			type: "integer",
			required: true
		},
		inlined_images: {
			type: "array",
			items: inlinedImageViewSchema
		},
		ordered_images: {
			type: "array",
			items: imageCandidateViewSchema
		},
		summary: documentSummarySchema,
		toc: {
			type: "array",
			items: documentHeadingSchema
		},
		pages: { type: "string" }
	},
	additionalProperties: false
};
const asyncParseOutputSchema = {
	type: "object",
	properties: {
		job_id: {
			type: "string",
			required: true
		},
		state: {
			type: "string",
			enum: ["running"],
			required: true
		}
	},
	additionalProperties: false
};
const documentSourceParameters = {
	file_path: {
		type: "string",
		description: "Path of the local PDF document. Provide exactly one of file_path or attachment_id."
	},
	attachment_id: {
		type: "string",
		description: "File attachment on the current session surface: full SHA-256 ID or unique 8–64 hex-character digest prefix, with optional sha256: prefix. Uses the DSH host file path; not a URL or filesystem path. Mutually exclusive with file_path."
	}
};
const asyncParseParameters = documentSourceParameters;
const readPdfParameters = {
	...documentSourceParameters,
	view: {
		type: "string",
		enum: ["content", "page"],
		description: "content (default) reads parsed blocks; page renders one original PDF page locally without invoking a Provider. Requires exactly one page and an image-capable model."
	},
	block_id: {
		type: "string",
		description: "Read one exact stable block ID from a prior result; IDs are bound to that parsed result. Cannot combine with query or cursor."
	},
	query: {
		type: "string",
		description: "Case-insensitive literal search (1–256 characters) in selected parsed blocks. Returns bounded snippets and block IDs, not the full matching blocks. Use block_id to read a hit."
	},
	expected_sha256: {
		type: "string",
		description: "Optional source_sha256 from a parsed result. In page view, reject changed sources before rendering."
	},
	pages: {
		oneOf: [
			{
				type: "integer",
				description: "Single 1-based page number, e.g. 3"
			},
			{
				type: "string",
				description: "Page range string, e.g. \"1-3, 5\""
			},
			{
				type: "array",
				items: { type: "integer" },
				description: "Array of page numbers, e.g. [1, 2, 5]"
			}
		],
		description: "1-based page numbers to extract. Accepts a single page number (e.g. 3), an array of page numbers (e.g. [1, 2, 5]), or a range string (e.g. \"1-3, 5\")."
	},
	focus: {
		oneOf: [{
			type: "string",
			enum: [
				"all",
				"text",
				"table",
				"image",
				"toc",
				"artifacts"
			],
			description: "Focus content type"
		}, {
			type: "array",
			items: {
				type: "string",
				enum: [
					"all",
					"text",
					"table",
					"image",
					"toc",
					"artifacts"
				]
			},
			description: "Focus content types"
		}],
		description: "Content types to extract: \"all\" (default), \"text\" (paragraphs, headers, code, formulas), \"table\" (tables and captions), \"image\" (charts, figures, and captions), \"toc\" (document outline / table of contents), or \"artifacts\" (secondary artifact files like layout.json, model.json, and extracted images). Accepts a single kind or an array."
	},
	inline_images: {
		type: "boolean",
		description: "Whether to inline visual figures directly as multimodal image blocks. Defaults to true when calling model route supports images."
	},
	poll_timeout_ms: {
		type: "integer",
		description: "Maximum synchronous wait in milliseconds. A timeout leaves the shared producer running; retry the same request to rejoin it."
	},
	cursor: {
		type: "string",
		description: "Opaque continuation cursor returned by a previous partial read. Pass only a non-empty returned token, unchanged; null means stop, not restart. When provided, the same source (file_path or attachment_id) is required and pages/focus must be omitted."
	}
};
//#endregion
//#region src/tools/async-parse-pdf.ts
const ASYNC_PARAMETER_FIELDS = /* @__PURE__ */ new Set(["file_path", "attachment_id"]);
function parseAsyncArguments(args) {
	return parseDocumentSource(argumentRecord(args, ASYNC_PARAMETER_FIELDS));
}
function asyncParsePdfTool(ctx, deps, invocations) {
	return defineTool({
		name: "async_parse_pdf",
		description: "Submit PDF document parsing as a native background job. Fully parses the PDF to local cache and returns a structured summary (pages, outline, tables, images) upon completion. Use read_pdf to read specific content or pages on demand.",
		parameters: asyncParseParameters,
		output: {
			schema: asyncParseOutputSchema,
			render: (_args, value) => {
				return [{
					type: "text",
					text: "Started native MinerU background job " + value.job_id + "."
				}];
			},
			presentationMeta: (_args, value) => {
				const output = value;
				return {
					job_id: output.job_id,
					state: output.state
				};
			}
		},
		isConcurrencySafe: () => true,
		execute: async (args, exec) => {
			const agent = requireAgent(exec);
			exec.signal.throwIfAborted();
			const sourcePath = await resolveSourcePath(parseAsyncArguments(args), agent, exec, ctx, deps.attachments());
			exec.signal.throwIfAborted();
			const jobs = ctx.get("jobs");
			if (jobs === void 0) throw new MinerUError(failure("PROVIDER_UNAVAILABLE", "Native DSH background jobs are unavailable; load the jobs registry and job tools"));
			const config = deps.config();
			const controller = new AbortController();
			return {
				job_id: jobs.start({
					kind: "mineru",
					label: "Parse " + basename(sourcePath) + " with MinerU",
					owner: agent.session.id,
					toolCall: {
						callId: exec.callId,
						rootCallId: exec.rootCallId
					},
					outputLimitBytes: 48e3,
					run: (job) => {
						const done = deps.reader.summarize(sourcePath, config, controller.signal, (phase) => job.updateProgress(phase)).then((value) => ({
							status: "completed",
							detail: "completed",
							result: formatSingleSummaryProse(value)
						})).catch((error) => {
							if (controller.signal.aborted) return {
								status: "killed",
								detail: "cancelled"
							};
							const normalized = toMinerUFailure(error);
							return {
								status: "failed",
								detail: normalized.code,
								result: "[" + normalized.code + "] " + normalized.message
							};
						});
						const invocation = {
							controller,
							done
						};
						invocations.add(invocation);
						done.finally(() => invocations.delete(invocation));
						return {
							cancel: (reason) => {
								if (!controller.signal.aborted) controller.abort(new MinerUError(failure("CANCELLED", reason?.trim() || "MinerU background parse cancelled", true)));
							},
							done
						};
					}
				}),
				state: "running"
			};
		}
	});
}
//#endregion
//#region src/tools/render.ts
const DEFAULT_RENDER_LIMIT = 2e5;
function clampRenderText(rendered, limit = DEFAULT_RENDER_LIMIT) {
	if (!Number.isSafeInteger(limit) || limit <= 0) return "";
	if (rendered.length <= limit) return rendered;
	return "[RESULT_TOO_LARGE] Reader output could not be delivered intact; narrow the request or increase the output budget.".slice(0, limit);
}
/** Model content for read_pdf: bounded prose followed by the attached images. */
function renderResult(value) {
	const limit = typeof value.output_limit_chars === "number" && Number.isSafeInteger(value.output_limit_chars) && value.output_limit_chars > 0 ? value.output_limit_chars : DEFAULT_RENDER_LIMIT;
	return [{
		type: "text",
		text: clampRenderText(formatResultProse(value), limit)
	}, ...(value.inlined_images ?? []).map((img) => {
		return {
			type: "image",
			attachment: {
				attachmentId: img.attachment_id,
				mediaType: img.media_type,
				bytes: img.bytes ?? 0,
				width: img.width ?? 0,
				height: img.height ?? 0,
				...img.name !== void 0 ? { name: img.name } : {}
			}
		};
	})];
}
//#endregion
//#region src/tools/read-pdf.ts
const READ_PARAMETER_FIELDS = /* @__PURE__ */ new Set([
	"file_path",
	"attachment_id",
	"pages",
	"focus",
	"inline_images",
	"poll_timeout_ms",
	"cursor",
	"block_id",
	"query",
	"view",
	"expected_sha256"
]);
const PAGE_VIEW_EXCLUDED = [
	"focus",
	"cursor",
	"query",
	"block_id",
	"inline_images",
	"poll_timeout_ms"
];
function parsePollTimeout(value) {
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 864e5) throw invalidRequest("poll_timeout_ms must be an integer from 1 to 86400000");
	return value;
}
function parseFocus(value) {
	try {
		return normalizeFocusSelection(value);
	} catch (error) {
		throw invalidRequest(error instanceof Error ? error.message : "Invalid focus", error);
	}
}
function parsePageQuery(args) {
	if (PAGE_VIEW_EXCLUDED.some((key) => args[key] !== void 0)) throw invalidRequest("page view accepts only one source (file_path or attachment_id), pages, and optional expected_sha256");
	let selected;
	try {
		selected = normalizePageSelection(args.pages);
	} catch {
		throw invalidRequest("page view requires exactly one positive physical page");
	}
	if (selected === void 0 || selected.size !== 1) throw invalidRequest("page view requires exactly one physical page in pages");
	if (args.expected_sha256 !== void 0 && !isSha256(args.expected_sha256)) throw invalidRequest("expected_sha256 must be a lowercase SHA-256 digest");
	return {
		kind: "page",
		page: [...selected][0],
		...typeof args.expected_sha256 === "string" ? { expectedSha256: args.expected_sha256 } : {}
	};
}
/** The single validation boundary for read_pdf arguments. */
function parseReadArguments(args) {
	const obj = argumentRecord(args, READ_PARAMETER_FIELDS);
	const source = parseDocumentSource(obj);
	const pollTimeoutMs = parsePollTimeout(obj.poll_timeout_ms);
	const wait = pollTimeoutMs === void 0 ? {} : { pollTimeoutMs };
	if (obj.view !== void 0 && obj.view !== "content" && obj.view !== "page") throw invalidRequest("view must be content or page");
	if (obj.view === "page") return {
		source,
		query: parsePageQuery(obj)
	};
	if (obj.expected_sha256 !== void 0) throw invalidRequest("expected_sha256 is only supported in page view");
	if (obj.block_id !== void 0 && !isBlockId(obj.block_id)) throw invalidRequest("block_id must be an exact ID returned by read_pdf");
	if (obj.query !== void 0 && !isQueryText(obj.query)) throw invalidRequest("query must contain 1–256 characters");
	if (obj.block_id !== void 0 && obj.query !== void 0) throw invalidRequest("block_id and query cannot be combined");
	if ((obj.query !== void 0 || obj.block_id !== void 0) && [...parseFocus(obj.focus)].some((f) => f === "toc" || f === "artifacts")) throw invalidRequest("query/block_id cannot be combined with toc or artifacts focus");
	if (obj.inline_images !== void 0 && typeof obj.inline_images !== "boolean") throw invalidRequest("inline_images must be a boolean");
	const inlineImages = obj.inline_images;
	if (obj.cursor !== void 0) {
		if (typeof obj.cursor !== "string" || obj.cursor.trim() === "") throw invalidRequest("cursor must be a non-empty string");
		if (obj.pages !== void 0 || obj.focus !== void 0 || obj.block_id !== void 0 || obj.query !== void 0) throw invalidRequest("pages and focus must be omitted when cursor is provided, as must block_id and query");
		let cursor;
		try {
			cursor = decodeReadCursor(obj.cursor.trim());
		} catch (error) {
			throw invalidRequest(error instanceof Error ? error.message : "Cursor is malformed; start over without a cursor", error);
		}
		return {
			source,
			query: {
				kind: "continue",
				cursor,
				inlineImages: inlineImages ?? cursor.inline_images,
				...wait
			}
		};
	}
	let pages;
	try {
		pages = normalizePageSelection(obj.pages);
	} catch (error) {
		throw invalidRequest(error instanceof Error ? error.message : "Invalid page range", error);
	}
	const focus = parseFocus(obj.focus);
	const target = typeof obj.block_id === "string" ? {
		kind: "block",
		blockId: obj.block_id
	} : typeof obj.query === "string" ? {
		kind: "query",
		text: obj.query.trim()
	} : void 0;
	return {
		source,
		query: {
			kind: "select",
			selection: {
				...pages === void 0 ? {} : { pages },
				focus,
				...target === void 0 ? {} : { target }
			},
			inlineImages: inlineImages ?? true,
			...wait
		}
	};
}
function presentationMeta(result) {
	return {
		result_id: result.result_id,
		file_ids: result.files.map((file) => file.file_id),
		source: result.source,
		cache_hit: result.cache_hit,
		content_status: result.content_status,
		has_more: result.cursor !== null,
		counts: {
			files: result.files.length,
			artifacts: result.files.reduce((count, file) => count + file.artifacts.length, 0),
			images: result.ordered_images?.length ?? 0,
			attachments: result.inlined_images?.length ?? 0,
			headings: result.toc?.length ?? result.summary?.toc?.length ?? 0,
			diagnostics: result.diagnostics?.length ?? 0,
			warnings: result.warnings?.length ?? 0
		},
		...result.renderer === void 0 ? {} : { renderer: result.renderer }
	};
}
function readPdfTool(ctx, deps) {
	return defineTool({
		name: "read_pdf",
		description: "Read PDF evidence in bounded chunks with physical pages and stable block IDs. Start with focus: toc or a short query; use block_id to read a search hit. markdown_content contains selected parsed text; partial requires continuing with the unchanged cursor and same source (file_path or attachment_id) only (no pages/focus/block_id/query). The cursor is null when complete or not_requested. Continue only when partial; stop rather than passing null back. Complete ends that text selection, not a guarantee of OCR fidelity or visual coverage; check diagnostics and visuals. Diagnostics are scoped to delivered blocks; document/selection notices appear initially. verification_hints recommend original-page checks for formulas, not automatic corrections. provenance separates parsing configuration from index/reader versions; upstream_version null means unknown. Omitted inline_images inherits the cursor intent; an explicit boolean overrides it. metadata_shortened identifies budget-limited metadata. Use view: page with one page number to inspect the original PDF locally without Provider upload, optionally checking source_sha256 via expected_sha256. Use focus: artifacts only for exported cache paths. Output in run_code should preserve markdown_content and cursor, rather than dumping large/debug objects.",
		parameters: readPdfParameters,
		output: {
			schema: resultViewSchema,
			render: (_args, value) => renderResult(value),
			presentationMeta: (_args, value) => presentationMeta(value)
		},
		isConcurrencySafe: () => true,
		execute: async (args, exec) => {
			const agent = requireAgent(exec);
			const { source, query } = parseReadArguments(args);
			exec.signal.throwIfAborted();
			const attachments = deps.attachments();
			const sourcePath = await resolveSourcePath(source, agent, exec, ctx, attachments);
			const config = deps.config();
			const images = await modelSupportsImages(exec, ctx) && attachments !== void 0 ? (image) => attachments.saveImage(image) : void 0;
			if (query.kind !== "page") return await deps.reader.readContent(sourcePath, query, config, images, exec.signal);
			if (config.output.maxInlineImages === 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", "Original page view requires output.maxInlineImages greater than zero"));
			if (images === void 0) throw new MinerUError(failure("UNSUPPORTED_OPTION", "Original page view requires an image-capable model and attachment support"));
			return await deps.reader.viewPage(sourcePath, query, config, images, exec.signal);
		}
	});
}
//#endregion
//#region src/tools/index.ts
/** Register both model tools; the disposer cancels and awaits background parses this plugin started. */
function registerTools(ctx, deps) {
	const invocations = /* @__PURE__ */ new Set();
	const disposers = [ctx.tools.register(asyncParsePdfTool(ctx, deps, invocations)), ctx.tools.register(readPdfTool(ctx, deps))];
	return async () => {
		for (const dispose of disposers) dispose();
		const active = [...invocations];
		for (const invocation of active) if (!invocation.controller.signal.aborted) invocation.controller.abort(new MinerUError(failure("CANCELLED", "MinerU plugin disposed", true)));
		await Promise.allSettled(active.map((invocation) => invocation.done));
	};
}
//#endregion
//#region src/plugin/credentials.ts
/** Stored DSH credentials win; process.env is read only on hosts without the credential service. */
function credentialResolver(ctx) {
	return async (reference, signal) => {
		signal.throwIfAborted();
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(reference);
			signal.throwIfAborted();
			return resolved?.value;
		}
		return process.env[reference] || void 0;
	};
}
//#endregion
//#region src/plugin/settings-persistence.ts
function configSnapshot(value) {
	if (isVolatile(value)) return configSnapshot(value.get());
	if (Array.isArray(value)) return value.map(configSnapshot);
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, configSnapshot(child)]));
	return value;
}
/**
* Read the fiber's current Config as well as its volatile values: hosts without
* HMR may reload the fiber while a settings write is in flight. Migration is in memory only.
*/
function readRuntimeConfig(ctx, entryConfig) {
	return parseConfigWithMigration(configSnapshot(ctx.fiber?.config ?? entryConfig)).config;
}
function liveConfig(config) {
	const { storage, limits: _limits, ...live } = config;
	return {
		...live,
		storage: {
			cacheEnabled: storage.cacheEnabled,
			stagingTtlMs: storage.stagingTtlMs
		}
	};
}
function settingsConflict() {
	return new MinerUError(failure("SETTINGS_CONFLICT", "MinerU settings changed since they were read; reload them and retry the save"));
}
function isHostSettingsConflict(error) {
	return error instanceof Error && error.code === "SETTINGS_CONFLICT";
}
/** Explicit saves only; storageRoot and limits are fixed for the plugin's lifetime. */
function createSettingsPersistence(ctx, settings, read, fixed) {
	const validate = (value) => {
		const next = parseConfigWithMigration(value).config;
		if (next.storage.storageRoot !== fixed.storage.storageRoot) throw new TypeError("storage.storageRoot cannot change while the MinerU plugin is running");
		for (const key of Object.keys(fixed.limits)) if (next.limits[key] !== fixed.limits[key]) throw new TypeError(`limits.${key} requires a MinerU plugin restart`);
		return next;
	};
	const revision = (namespace) => namespace === void 0 ? null : settings.describe().find((row) => row.ns === namespace)?.revision ?? null;
	return {
		current: () => ({
			config: read(),
			revision: revision(ctx.fiber.entry?.options.id)
		}),
		save: async (value, expectedRevision) => {
			const next = validate(value);
			const entry = ctx.fiber.entry;
			if (entry === void 0) throw new Error("MinerU configuration requires a Loader profile entry");
			const namespace = entry.options.id;
			const original = entry.options.config;
			try {
				if (original !== void 0 && parseConfigWithMigration(original).migrated) {
					const editor = ctx.get("configEditor");
					if (editor === void 0) throw new Error("Saving a migrated configuration requires the host ConfigEditor");
					await editor.edit(entry, (current) => {
						if (expectedRevision !== void 0 && revision(namespace) !== expectedRevision) throw settingsConflict();
						validate(parseConfigWithMigration(current).config);
						return { ...next };
					});
				} else await settings.replace(namespace, liveConfig(next), expectedRevision);
			} catch (error) {
				throw isHostSettingsConflict(error) ? settingsConflict() : error;
			}
			return {
				config: read(),
				revision: revision(namespace)
			};
		}
	};
}
//#endregion
//#region src/plugin/lifecycle.ts
function isInactiveContextError(error) {
	if (!(error instanceof Error)) return false;
	return error.code === "INACTIVE_EFFECT" || error.message === "cannot create effect on inactive context";
}
/** Build the plugin graph; disposal stops tools first, then shared producers. */
async function apply(ctx, entryConfig = {}) {
	const runtimeConfig = () => readRuntimeConfig(ctx, entryConfig);
	const initialConfig = runtimeConfig();
	let toolDisposer;
	let operations;
	const startup = new AbortController();
	ctx.effect(() => () => startup.abort(), "dsh-pdf-mineru startup cancellation");
	const settings = ctx.get("settings");
	if (settings === void 0) throw new Error("settings service is unavailable");
	ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), "dsh-pdf-mineru settings presentation");
	const persistence = createSettingsPersistence(ctx, settings, runtimeConfig, {
		storage: initialConfig.storage,
		limits: { ...initialConfig.limits }
	});
	const paths = new StoragePaths(initialConfig.storage.storageRoot);
	const lock = new ProcessLock(paths);
	try {
		await lock.initialize(startup.signal);
		startup.signal.throwIfAborted();
		const operationRegistry = new SharedOperationRegistry();
		operations = operationRegistry;
		const accessGate = new StorageAccessGate({
			paths,
			lock
		});
		const results = new ResultRepository(paths, {
			maxArtifactBytes: initialConfig.limits.maxZipEntryBytes,
			maxJsonValidationBytes: Math.min(initialConfig.limits.maxZipEntryBytes, 67108864)
		}, lock);
		await results.cleanupStaging(initialConfig.storage.stagingTtlMs, operationRegistry.activeOperationIds(), startup.signal);
		startup.signal.throwIfAborted();
		const maintenance = new StorageMaintenanceService(paths, results, operationRegistry, lock, accessGate);
		const parser = new ParseService({
			createProvider,
			results,
			operations: operationRegistry,
			accessGate,
			diagnostics: createStructuredDiagnosticSink(ctx.logger),
			resolveCredential: credentialResolver(ctx)
		});
		const reader = new ReaderService({
			parser,
			results,
			accessGate
		});
		let attachments;
		ctx.inject(["attachments"], (attachmentCtx) => {
			attachments = attachmentCtx.attachments;
			return () => {
				attachments = void 0;
			};
		});
		toolDisposer = registerTools(ctx, {
			reader,
			config: runtimeConfig,
			attachments: () => attachments
		});
		ctx.inject(["connection", "webServer"], (connectionCtx) => registerRpc(connectionCtx, {
			settings: persistence,
			probe: async (provider, signal) => {
				const config = runtimeConfig();
				return await parser.probe(config, signal, provider === void 0 ? void 0 : parseProviderDraft(provider, config));
			},
			maintenance
		}));
		let disposing;
		const dispose = () => {
			disposing ??= (async () => {
				await toolDisposer?.();
				await operationRegistry.shutdown();
			})();
			return disposing;
		};
		ctx.effect(() => async () => {
			await dispose();
		}, "dsh-pdf-mineru lifecycle");
		return dispose;
	} catch (error) {
		await toolDisposer?.();
		if (operations !== void 0) await operations.shutdown();
		if (startup.signal.aborted || isInactiveContextError(error)) return async () => void 0;
		throw error;
	}
}
//#endregion
//#region src/index.ts
const name = "dsh-pdf-mineru";
const inject = [
	"tools",
	"jobs",
	"settings",
	"workingDirectory"
];
//#endregion
export { Config, MINERU_RESULT_MANIFEST_SCHEMA_VERSION, ParseService, ReaderService, apply, defaultMinerUConfig, formatResultProse, inject, name, parseConfig, parseMinerUResultManifest, parseReadArguments };
