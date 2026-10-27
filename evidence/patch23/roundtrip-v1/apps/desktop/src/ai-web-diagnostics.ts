/** Read-only, fixed-code DOM diagnostics for a native-owned AI web window. */

export type NativeAiWebDiagnosticProvider = 'deepseek' | 'doubao'
export type DiagnosticBoolean = boolean | 'unknown'

export type NativeAiWebDiagnosticErrorCode =
  | 'invalid-provider' | 'window-destroyed' | 'unsupported-origin'
  | 'document-changed' | 'diagnostic-failed' | 'result-too-large'
  | 'diagnostic-timeout'

const ORIGINS: Readonly<Record<NativeAiWebDiagnosticProvider, string>> = {
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
}

const SAFE_TAGS = new Set(['article', 'button', 'div', 'form', 'input', 'li', 'section', 'span', 'textarea'])
const SAFE_ROLES = new Set(['alert', 'button', 'combobox', 'dialog', 'group', 'listitem', 'option', 'searchbox', 'status', 'textbox'])
const SAFE_ACTION_LABELS = new Set([
  'Send', 'Send message', 'Stop generating', 'Log in', 'Login', 'Sign in', 'Sign up', 'Upload file',
  '发送', '发送消息', '停止生成', '登录', '注册', '上传文件',
])
const MESSAGE_IDENTITY_ATTRIBUTES = [
  'data-message-id', 'data-turn-id', 'data-message-key', 'data-turn', 'data-id',
] as const
const MAX_OUTPUT_CHARS = 8_192
const MAX_CANDIDATES = 32
const DIAGNOSTIC_WORLD_ID = 0x544c

export class NativeAiWebDiagnosticError extends Error {
  readonly code: NativeAiWebDiagnosticErrorCode
  constructor(code: NativeAiWebDiagnosticErrorCode) {
    super(code)
    this.name = 'NativeAiWebDiagnosticError'
    this.code = code
  }
}

export interface NativeAiWebDiagnosticCandidate {
  readonly kind: 'input' | 'button'
  readonly tag: string
  readonly role?: string
  readonly testId?: string
  readonly hasTestId?: true
  readonly ariaLabel?: string
  readonly hasLabel?: true
}

export interface NativeAiWebDiagnosticResult {
  readonly provider: NativeAiWebDiagnosticProvider
  readonly origin: string
  readonly documentStable: true
  readonly inputPresent: DiagnosticBoolean
  readonly loginRequired: DiagnosticBoolean
  readonly draftState: 'unknown'
  readonly generationState: 'unknown'
  readonly candidateListComplete: boolean
  readonly candidates: readonly NativeAiWebDiagnosticCandidate[]
  readonly messageIdentityAttributes: readonly { readonly name: typeof MESSAGE_IDENTITY_ATTRIBUTES[number]; readonly present: DiagnosticBoolean }[]
}

interface DiagnosticFrame {
  readonly processId: number
  readonly routingId: number
  readonly url: string
}

/** The minimal read-only WebContents surface used by this helper. */
export interface NativeAiWebDiagnosticContents {
  /** Must include both WebContents destruction and its owning BrowserWindow destruction. */
  isDestroyed(): boolean
  getURL(): string
  readonly mainFrame: DiagnosticFrame
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>
}

interface RawCandidate {
  readonly kind: unknown
  readonly tag: unknown
  readonly role?: unknown
  readonly testId?: unknown
  readonly hasTestId?: unknown
  readonly ariaLabel?: unknown
  readonly hasLabel?: unknown
}

interface RawDiagnostic {
  readonly schema: unknown
  readonly origin: unknown
  readonly documentStable: unknown
  readonly inputPresent: unknown
  readonly loginRequired: unknown
  readonly candidateListComplete: unknown
  readonly candidates: unknown
  readonly messageIdentityAttributes: unknown
}

function diagnosticFailure(code: NativeAiWebDiagnosticErrorCode): never {
  throw new NativeAiWebDiagnosticError(code)
}

function readIdentity(
  contents: NativeAiWebDiagnosticContents,
  expectedOrigin: string,
  originMismatch: 'unsupported-origin' | 'document-changed',
): { readonly href: string; readonly frame: DiagnosticFrame } {
  try { if (contents.isDestroyed()) diagnosticFailure('window-destroyed') }
  catch (error) {
    if (error instanceof NativeAiWebDiagnosticError) throw error
    diagnosticFailure('diagnostic-failed')
  }
  try {
    const href = contents.getURL()
    const url = new URL(href)
    const frame = contents.mainFrame
    const frameUrl = new URL(frame.url)
    if (url.origin !== expectedOrigin || url.protocol !== 'https:' || url.username || url.password || url.port
      || frameUrl.origin !== expectedOrigin || !Number.isSafeInteger(frame.processId) || !Number.isSafeInteger(frame.routingId)) {
      diagnosticFailure(originMismatch)
    }
    return { href, frame: { processId: frame.processId, routingId: frame.routingId, url: frame.url } }
  } catch (error) {
    if (error instanceof NativeAiWebDiagnosticError) throw error
    diagnosticFailure('diagnostic-failed')
  }
}

function sameDocument(
  before: { readonly href: string; readonly frame: DiagnosticFrame },
  after: { readonly href: string; readonly frame: DiagnosticFrame },
): boolean {
  return before.href === after.href
    && before.frame.processId === after.frame.processId
    && before.frame.routingId === after.frame.routingId
    && before.frame.url === after.frame.url
}

function isStableTestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
    && !/\d/.test(value) && /^[a-z][a-z0-9]*(?:[_-][a-z][a-z0-9]*)*$/.test(value)
}

function projectCandidate(raw: RawCandidate): NativeAiWebDiagnosticCandidate {
  if ((raw.kind !== 'input' && raw.kind !== 'button') || typeof raw.tag !== 'string' || !SAFE_TAGS.has(raw.tag)) {
    diagnosticFailure('diagnostic-failed')
  }
  const projected: {
    kind: 'input' | 'button'; tag: string; role?: string; testId?: string; hasTestId?: true; ariaLabel?: string; hasLabel?: true
  } = { kind: raw.kind, tag: raw.tag }
  if (typeof raw.role === 'string' && SAFE_ROLES.has(raw.role)) projected.role = raw.role
  if (isStableTestId(raw.testId)) projected.testId = raw.testId
  else if (raw.hasTestId === true) projected.hasTestId = true
  if (typeof raw.ariaLabel === 'string' && SAFE_ACTION_LABELS.has(raw.ariaLabel)) projected.ariaLabel = raw.ariaLabel
  else if (raw.hasLabel === true) projected.hasLabel = true
  return projected
}

function buildFixedProbe(provider: NativeAiWebDiagnosticProvider): string {
  const expectedOrigin = ORIGINS[provider]
  return `(() => {
    'use strict';
    const expectedOrigin = ${JSON.stringify(expectedOrigin)};
    const docBefore = document;
    const winBefore = window;
    const hrefBefore = location.href;
    const originBefore = location.origin;
    if (originBefore !== expectedOrigin || !docBefore.body) return { schema: 1, origin: originBefore, documentStable: false };

    const allowedTags = new Set(['article','button','div','form','input','li','section','span','textarea']);
    const allowedRoles = new Set(['alert','button','combobox','dialog','group','listitem','option','searchbox','status','textbox']);
    const allowedLabels = new Set(['Send','Send message','Stop generating','Log in','Login','Sign in','Sign up','Upload file','发送','发送消息','停止生成','登录','注册','上传文件']);
    const identityNames = ['data-message-id','data-turn-id','data-message-key','data-turn','data-id'];
    const safeTestId = value => typeof value === 'string' && value.length > 0 && value.length <= 80
      && !/\\d/.test(value) && /^[a-z][a-z0-9]*(?:[_-][a-z][a-z0-9]*)*$/.test(value);
    const metadata = element => {
      const tag = element.tagName.toLowerCase();
      const rawRole = element.getAttribute('role');
      const rawTestId = element.getAttribute('data-testid');
      const rawLabel = element.getAttribute('aria-label');
      const item = { tag };
      if (rawRole && allowedRoles.has(rawRole)) item.role = rawRole;
      if (safeTestId(rawTestId)) item.testId = rawTestId;
      else if (rawTestId !== null) item.hasTestId = true;
      if (rawLabel && allowedLabels.has(rawLabel)) item.ariaLabel = rawLabel;
      else if (rawLabel !== null) item.hasLabel = true;
      return item;
    };
    const nearestComposerRoot = element => {
      let current = element.parentElement;
      for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
        const tag = current.tagName.toLowerCase();
        const testId = current.getAttribute('data-testid');
        if (tag === 'form' || (safeTestId(testId) && /(?:composer|chat[_-]input)[_-]?(?:container|wrapper|area|form)?$/.test(testId))) return current;
      }
      return null;
    };
    const isInputCandidate = element => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'textarea') return true;
      if (tag === 'input') return ['text',''].includes((element.getAttribute('type') || '').toLowerCase());
      return element.getAttribute('contenteditable') === 'true' || element.getAttribute('role') === 'textbox';
    };

    const inputs = [];
    const roots = new Set();
    let candidateScanComplete = true;
    const knownDoubaoInput = ${provider === 'doubao' ? 'docBefore.querySelector("textarea[data-testid=\\\"chat_input_input\\\"]")' : 'null'};
    const addInput = (element, root) => {
      if (!inputs.some(item => item.element === element) && inputs.length < ${MAX_CANDIDATES}) {
        inputs.push({ element, root });
        if (root) roots.add(root);
      }
    };
    if (knownDoubaoInput) addInput(knownDoubaoInput, nearestComposerRoot(knownDoubaoInput));
    // Inspect only explicit form boundaries containing a multiline or
    // contenteditable composer candidate. Ordinary sidebar search inputs are
    // outside this scope and never have their attributes read or returned.
    let formCount = 0;
    for (const form of docBefore.querySelectorAll('form')) {
      if (++formCount > 64) { candidateScanComplete = false; break; }
      const scopedInputs = form.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]');
      if (!scopedInputs.length) continue;
      const walker = docBefore.createTreeWalker(form, NodeFilter.SHOW_ELEMENT);
      let current = form;
      let visited = 0;
      while (current && visited < 256 && inputs.length < ${MAX_CANDIDATES}) {
        visited++;
        if (isInputCandidate(current)) addInput(current, form);
        current = walker.nextNode();
      }
      if (current !== null || inputs.length >= ${MAX_CANDIDATES}) candidateScanComplete = false;
    }
    // A standalone textarea is a safe input candidate even without a trusted
    // composer root. In that case roots stays empty, so no nearby buttons are
    // inspected and button candidates remain unknown.
    const uncollectedTextareas = Array.from(docBefore.querySelectorAll('textarea'))
      .filter(textarea => !inputs.some(item => item.element === textarea));
    if (uncollectedTextareas.length === 1) {
      const standalone = uncollectedTextareas[0];
      addInput(standalone, nearestComposerRoot(standalone));
    } else if (uncollectedTextareas.length > 1) candidateScanComplete = false;

    const identityPresent = new Set();
    const messageWalker = docBefore.createTreeWalker(docBefore.body, NodeFilter.SHOW_ELEMENT);
    let current = docBefore.body;
    let visited = 0;
    while (current && visited < 3000) {
      visited++;
      const tag = current.tagName.toLowerCase();
      const role = current.getAttribute('role');
      const testId = current.getAttribute('data-testid');
      const messageLike = tag === 'article' || role === 'article' || role === 'listitem'
        || (safeTestId(testId) && /(?:message|turn|answer)/.test(testId));
      if (messageLike) for (const name of identityNames) if (current.hasAttribute(name)) identityPresent.add(name);
      current = messageWalker.nextNode();
    }
    const messageScanComplete = current === null;

    const candidates = [];
    for (const item of inputs.slice(0, ${MAX_CANDIDATES})) {
      const value = metadata(item.element);
      if (allowedTags.has(value.tag)) candidates.push({ kind: 'input', ...value });
    }
    for (const root of roots) {
      const buttonWalker = docBefore.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let buttonNode = root;
      let buttonVisits = 0;
      while (buttonNode && buttonVisits < 256 && candidates.length < ${MAX_CANDIDATES}) {
        buttonVisits++;
        const role = buttonNode.getAttribute('role');
        if (buttonNode.tagName.toLowerCase() === 'button' || role === 'button') {
          const value = metadata(buttonNode);
          if (allowedTags.has(value.tag)) candidates.push({ kind: 'button', ...value });
        }
        buttonNode = buttonWalker.nextNode();
      }
      if (buttonNode !== null) candidateScanComplete = false;
      if (candidates.length >= ${MAX_CANDIDATES}) break;
    }

    const doubaoLoginRequired = ${provider === 'doubao' ? 'docBefore.querySelector("[data-testid=\\\"to_login_button\\\"]") !== null' : 'false'};
    const documentStable = document === docBefore && window === winBefore
      && location.href === hrefBefore && location.origin === originBefore;
    return {
      schema: 1,
      origin: originBefore,
      documentStable,
      inputPresent: inputs.length ? true : 'unknown',
      loginRequired: doubaoLoginRequired ? true : 'unknown',
      candidateListComplete: candidateScanComplete && candidates.length < ${MAX_CANDIDATES},
      candidates,
      messageIdentityAttributes: identityNames.map(name => ({
        name,
        present: identityPresent.has(name) ? true : messageScanComplete ? false : 'unknown',
      })),
    };
  })()`
}

function projectDiagnostic(raw: unknown, provider: NativeAiWebDiagnosticProvider): NativeAiWebDiagnosticResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) diagnosticFailure('diagnostic-failed')
  const value = raw as RawDiagnostic
  if (value.schema !== 1 || value.origin !== ORIGINS[provider] || value.documentStable !== true) diagnosticFailure('document-changed')
  if (value.inputPresent !== true && value.inputPresent !== 'unknown') diagnosticFailure('diagnostic-failed')
  if (value.loginRequired !== true && value.loginRequired !== false && value.loginRequired !== 'unknown') diagnosticFailure('diagnostic-failed')
  if (typeof value.candidateListComplete !== 'boolean') diagnosticFailure('diagnostic-failed')
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) diagnosticFailure('diagnostic-failed')
  const candidates = value.candidates.map(item => projectCandidate(item as RawCandidate))
  if (!Array.isArray(value.messageIdentityAttributes) || value.messageIdentityAttributes.length !== MESSAGE_IDENTITY_ATTRIBUTES.length) {
    diagnosticFailure('diagnostic-failed')
  }
  const byName = new Map(value.messageIdentityAttributes.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) diagnosticFailure('diagnostic-failed')
    const row = item as { name?: unknown; present?: unknown }
    if (typeof row.name !== 'string' || !MESSAGE_IDENTITY_ATTRIBUTES.includes(row.name as typeof MESSAGE_IDENTITY_ATTRIBUTES[number])
      || (typeof row.present !== 'boolean' && row.present !== 'unknown')) diagnosticFailure('diagnostic-failed')
    return [row.name, row.present] as const
  }))
  if (byName.size !== MESSAGE_IDENTITY_ATTRIBUTES.length) diagnosticFailure('diagnostic-failed')
  const result: NativeAiWebDiagnosticResult = {
    provider,
    origin: ORIGINS[provider],
    documentStable: true,
    inputPresent: value.inputPresent,
    loginRequired: value.loginRequired,
    draftState: 'unknown',
    generationState: 'unknown',
    candidateListComplete: value.candidateListComplete,
    candidates,
    messageIdentityAttributes: MESSAGE_IDENTITY_ATTRIBUTES.map(name => ({ name, present: byName.get(name)! })),
  }
  if (JSON.stringify(result).length > MAX_OUTPUT_CHARS) diagnosticFailure('result-too-large')
  return result
}

/** Run one built-in read-only probe against a native-owned, fixed-origin WebContents. */
export async function diagnoseNativeAiWebPage(
  contents: NativeAiWebDiagnosticContents,
  provider: NativeAiWebDiagnosticProvider,
): Promise<NativeAiWebDiagnosticResult> {
  if (provider !== 'deepseek' && provider !== 'doubao') diagnosticFailure('invalid-provider')
  const expectedOrigin = ORIGINS[provider]
  const before = readIdentity(contents, expectedOrigin, 'unsupported-origin')
  let raw: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    raw = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(DIAGNOSTIC_WORLD_ID, [{ code: buildFixedProbe(provider) }], false),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NativeAiWebDiagnosticError('diagnostic-timeout')), 5_000)
      }),
    ])
  } catch (error) {
    if (error instanceof NativeAiWebDiagnosticError && error.code === 'diagnostic-timeout') throw error
    diagnosticFailure('diagnostic-failed')
  } finally { if (timer !== undefined) clearTimeout(timer) }
  const after = readIdentity(contents, expectedOrigin, 'document-changed')
  if (!sameDocument(before, after)) diagnosticFailure('document-changed')
  return projectDiagnostic(raw, provider)
}
