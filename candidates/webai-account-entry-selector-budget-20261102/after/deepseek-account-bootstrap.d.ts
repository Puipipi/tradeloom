export type DeepseekBootstrapReason =
  | 'observed' | 'existing_positive' | 'negative_evidence' | 'unsupported_context' | 'stale_context'
  | 'busy' | 'disposed' | 'entry_missing' | 'entry_ambiguous' | 'probe_failed' | 'menu_not_confirmed'
  | 'open_failed' | 'restore_failed' | 'restore_unconfirmed'
export type DeepseekBootstrapMenuRestore = 'not-needed' | 'restored' | 'failed' | 'unknown'
export type DeepseekBootstrapOperation = 'opened' | 'unknown' | 'busy'

/** The exact raw DTO returned by the existing R3 strict DeepSeek menu probe. */
export interface DeepseekStrictMenuObservation {
  readonly downloadMobileAppVisible: boolean
  readonly settingsVisible: boolean
  readonly helpAndFeedbackVisible: boolean
  readonly logoutVisible: boolean
  readonly menuVisible: boolean
  readonly sameContainer: boolean
  readonly triggerPresent: boolean
  readonly triggerVisible: boolean
  readonly hasPopup: boolean
  readonly linked: boolean
  readonly shortcutAttributePresent: boolean
}

export interface DeepseekBootstrapContext {
  readonly owner: object
  readonly origin: 'https://chat.deepseek.com'
  readonly documentId: string
  readonly frameId: number
  readonly generation: number
  readonly alive: true
  readonly focused: true
}

/** Private Main-side freshness ticket; the projector must recheck it immediately before publishing. */
export interface DeepseekBootstrapPublishTicket {
  readonly owner: object
  readonly origin: 'https://chat.deepseek.com'
  readonly documentId: string
  readonly frameId: number
  readonly generation: number
  readonly negativeRevision: number
}

export interface DeepseekBootstrapResult {
  readonly provider: 'deepseek'
  readonly generation?: number
  /** Main must pass this unchanged to its existing account-menu projector; locator presence is not auth evidence. */
  readonly strictObservation: DeepseekStrictMenuObservation | null
  readonly operation: DeepseekBootstrapOperation
  readonly menuRestore: DeepseekBootstrapMenuRestore
  readonly entryAction: 'none' | 'synthetic-dom-click'
  readonly humanTrusted: false
  readonly reason: DeepseekBootstrapReason
}

export interface DeepseekBootstrapController {
  /** Refreshes the existing auth adapter first; a current explicit negative prevents bootstrap action. */
  run(): Promise<DeepseekBootstrapResult>
  observeNegative(): DeepseekBootstrapResult
  invalidate(): void
  dispose(): void
}

export type DeepseekBootstrapStage = 'prepare' | 'open' | 'settle' | 'inspect' | 'restore' | 'verify' | 'dispose'
/** Fixed, non-parameterizable DOM phase except for an opaque Host-generated operation token. */
export function deepseekAccountBootstrapStageScript(stage: DeepseekBootstrapStage, operationId: string): string
export function createDeepseekAccountBootstrapController(options: {
  readonly readContext: () => DeepseekBootstrapContext | null
  readonly refreshAuthState: () => unknown | Promise<unknown>
  /** Passes a fresh raw observation to the existing Main/R3 projector; never accepts an auth decision. */
  readonly publishStrictObservation: (observation: DeepseekStrictMenuObservation,
    ticket: DeepseekBootstrapPublishTicket) => unknown | Promise<unknown>
  /** Trusted Main closure that executes only the supplied fixed script in the already-owned document. */
  readonly executeFixedScript: (fixedScript: string) => unknown | Promise<unknown>
  readonly subscribeLifecycle?: (listener: () => void) => (() => void) | void
}): DeepseekBootstrapController
