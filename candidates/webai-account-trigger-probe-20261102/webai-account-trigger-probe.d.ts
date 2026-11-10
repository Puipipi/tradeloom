export type WebAiTriggerProvider = 'deepseek' | 'doubao'
export type WebAiTriggerRelation = 'linked' | 'unknown'
export type WebAiTriggerEvidenceKind = 'ariaExactAssociation' | 'pointerCandidate' | 'activeOnly' | 'none'
export type WebAiTriggerStatus = 'observed' | 'unknown'
export type WebAiTriggerReason = 'observed' | 'menuNotConfirmed' | 'captureClosed' | 'probeError'
  | 'unavailable' | 'stale' | 'invalidResult' | 'probeFailed'
export type WebAiTriggerSafeTag = 'a' | 'button' | 'div' | 'input' | 'li' | 'path' | 'span' | 'svg' | 'other'
export type WebAiTriggerSafeRole = 'button' | 'link' | 'menu' | 'menuitem' | 'option' | 'tab' | 'other'

export interface WebAiTriggerElementProjection {
  readonly tag: WebAiTriggerSafeTag
  readonly role?: WebAiTriggerSafeRole
  readonly isButton: boolean
  readonly visible: boolean | null
  readonly hasAriaControls: boolean
  readonly hasPopup: boolean
  readonly expanded: 'true' | 'false' | 'unknown'
  readonly isConnected: boolean
}

export interface WebAiTriggerActiveElementProjection {
  readonly tag: WebAiTriggerSafeTag
  readonly role?: WebAiTriggerSafeRole
  readonly isButton: boolean
  readonly visible: boolean | null
  readonly insideConfirmedMenu: boolean
  readonly hasAriaControls: boolean
}

export interface WebAiAccountTriggerEvidence {
  readonly status: WebAiTriggerStatus
  readonly provider: WebAiTriggerProvider
  readonly menuConfirmed: boolean
  readonly reason: WebAiTriggerReason
  readonly relation: WebAiTriggerRelation
  readonly evidenceKind: WebAiTriggerEvidenceKind
  /** Saturates at 2; 2 means ambiguous or over the fixed inspection bound. */
  readonly matchedControlsCount: 0 | 1 | 2
  readonly ariaControlsElementsAvailable: boolean | null
  readonly pointerPath: readonly WebAiTriggerElementProjection[]
  readonly activeElement: WebAiTriggerActiveElementProjection | null
}

export interface WebAiTriggerDocumentIdentity {
  readonly url: string
  readonly documentId: string
  readonly alive: boolean
}

export interface WebAiAccountTriggerProbeOptions {
  readonly provider: WebAiTriggerProvider
  readonly readDocumentIdentity: () => WebAiTriggerDocumentIdentity
  readonly readGeneration: () => number
  readonly isOwnedAndFocused: () => boolean
  /** Fixed host-owned install callback; accepts no script, DOM element, or renderer input. */
  readonly executeArmCapture?: () => unknown | Promise<unknown>
  /** Runs the existing fixed semantic probe and trigger hook in one document execution. */
  readonly executeConfirmedMenuProbe?: () => unknown | Promise<unknown>
  /** Fixed host-owned cancellation callback. */
  readonly executeCancelCapture: () => unknown | Promise<unknown>
  readonly subscribeLifecycle?: (listener: () => void) => () => void
}

export interface WebAiAccountTriggerProbe {
  arm(): Promise<boolean>
  sampleConfirmedMenu(): Promise<WebAiAccountTriggerEvidence>
  dispose(): void
}

/** Install a fixed 30-second capture in the host's isolated world before the user opens the menu. */
export function accountMenuTriggerCaptureInstallScript(provider: WebAiTriggerProvider): string
/** Fixed isolated-world cancellation script. */
export function accountMenuTriggerCaptureCancelScript(provider: WebAiTriggerProvider): string
/** Fixed expression for insertion inside the existing positive branch where local `menu` is the confirmed root. */
export function accountMenuTriggerCaptureConfirmedMenuExpression(provider: WebAiTriggerProvider): string
/** Safe unknown DTO for the existing fixed probe's no-confirmed-menu branch. */
export function projectNoConfirmedMenu(provider: WebAiTriggerProvider): WebAiAccountTriggerEvidence
/** Host-only wrapper around trusted, no-argument callbacks. */
export function createWebAiAccountTriggerProbe(options: WebAiAccountTriggerProbeOptions): WebAiAccountTriggerProbe

