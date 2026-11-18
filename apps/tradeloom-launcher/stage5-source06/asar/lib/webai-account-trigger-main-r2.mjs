import {
  accountMenuTriggerCaptureCancelScript,
  accountMenuTriggerCaptureInstallScript,
  createWebAiAccountTriggerProbe,
} from "./webai-account-trigger-probe-r2.mjs";

export { accountMenuTriggerCaptureCancelScript, accountMenuTriggerCaptureInstallScript, createWebAiAccountTriggerProbe };

const PROVIDERS = new Set(["deepseek", "doubao"]);
const REASONS = new Set(["observed", "menuNotConfirmed", "captureClosed", "probeError"]);
const RELATIONS = new Set(["linked", "unknown"]);
const EVIDENCE_KINDS = new Set(["ariaExactAssociation", "pointerCandidate", "activeOnly", "none"]);
const TAGS = new Set(["a", "button", "div", "input", "li", "path", "span", "svg", "other"]);
const ROLES = new Set(["button", "link", "menu", "menuitem", "option", "tab", "other"]);
const ROOT_KEYS = [
  "status", "provider", "menuConfirmed", "reason", "relation", "evidenceKind",
  "matchedControlsCount", "ariaControlsElementsAvailable", "pointerPath", "activeElement",
].sort();

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};
function safeElement(value, active) {
  const expected = active
    ? ["tag", "role", "isButton", "visible", "insideConfirmedMenu", "hasAriaControls"].sort()
    : ["tag", "role", "isButton", "visible", "hasAriaControls", "hasPopup", "expanded", "isConnected", "classTokens"].sort();
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.some(key => !expected.includes(key))
    || !["tag", "isButton", "visible", "hasAriaControls"].every(key => keys.includes(key))) return null;
  if (!TAGS.has(value.tag) || typeof value.isButton !== "boolean"
    || ![true, false, null].includes(value.visible) || typeof value.hasAriaControls !== "boolean"
    || (value.role !== undefined && !ROLES.has(value.role))) return null;
  if (active) {
    if (!keys.includes("insideConfirmedMenu") || typeof value.insideConfirmedMenu !== "boolean") return null;
    return Object.freeze({
      tag: value.tag, ...(value.role === undefined ? {} : { role: value.role }),
      isButton: value.isButton, visible: value.visible,
      insideConfirmedMenu: value.insideConfirmedMenu, hasAriaControls: value.hasAriaControls,
    });
  }
  if (!["hasPopup", "expanded", "isConnected", "classTokens"].every(key => keys.includes(key))
    || typeof value.hasPopup !== "boolean" || !["true", "false", "unknown"].includes(value.expanded)
    || typeof value.isConnected !== "boolean" || !Array.isArray(value.classTokens)
    || value.classTokens.length > 8
    || value.classTokens.some(token => typeof token !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(token))) return null;
  return Object.freeze({
    tag: value.tag, ...(value.role === undefined ? {} : { role: value.role }),
    isButton: value.isButton, visible: value.visible, hasAriaControls: value.hasAriaControls,
    hasPopup: value.hasPopup, expanded: value.expanded, isConnected: value.isConnected,
    classTokens: Object.freeze([...value.classTokens]),
  });
}

/** Re-project the helper result before it enters Main's bounded, private diagnostics export. */
export function projectAccountTriggerDiagnostic(value, provider) {
  if (!PROVIDERS.has(provider) || !hasExactKeys(value, ROOT_KEYS)
    || value.provider !== provider || !["observed", "unknown"].includes(value.status)
    || typeof value.menuConfirmed !== "boolean" || !REASONS.has(value.reason)
    || !RELATIONS.has(value.relation) || !EVIDENCE_KINDS.has(value.evidenceKind)
    || ![0, 1, 2].includes(value.matchedControlsCount)
    || ![true, false, null].includes(value.ariaControlsElementsAvailable)
    || !Array.isArray(value.pointerPath) || value.pointerPath.length > 4) return null;
  const pointerPath = value.pointerPath.map(item => safeElement(item, false));
  if (pointerPath.some(item => item === null)) return null;
  const activeElement = value.activeElement === null ? null : safeElement(value.activeElement, true);
  if (value.activeElement !== null && activeElement === null) return null;
  if (value.menuConfirmed !== (value.status === "observed" && value.reason === "observed")) return null;
  return Object.freeze({
    status: value.status, provider, menuConfirmed: value.menuConfirmed, reason: value.reason,
    relation: value.relation, evidenceKind: value.evidenceKind,
    matchedControlsCount: value.matchedControlsCount,
    ariaControlsElementsAvailable: value.ariaControlsElementsAvailable,
    pointerPath: Object.freeze(pointerPath), activeElement,
  });
}
