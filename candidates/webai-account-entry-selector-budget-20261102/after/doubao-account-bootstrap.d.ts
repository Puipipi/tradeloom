export type DoubaoBootstrapReason =
  | 'observed' | 'existing_positive' | 'negative_evidence' | 'unsupported_context' | 'stale_context'
  | 'busy' | 'disposed' | 'entry_missing' | 'entry_ambiguous' | 'probe_failed' | 'menu_not_confirmed'
  | 'open_failed' | 'restore_failed' | 'restore_unconfirmed'
export type DoubaoBootstrapMenuRestore = 'not-needed' | 'restored' | 'failed' | 'unknown'
export type DoubaoBootstrapOperation = 'opened' | 'unknown' | 'busy'

/** The exact ten-boolean raw DTO returned by current Main's strict Doubao menu probe. */
export interface DoubaoStrictMenuObservation {
  readonly menuVisible: boolean
  readonly addAccountVisible: boolean
  readonly logoutVisible: boolean
  readonly sameMenu: boolean
  readonly accountMenuLinkedVisible: boolean
  readonly triggerPresent: boolean
  readonly triggerVisible: boolean
  readonly hasPopup: boolean
  readonly linked: boolean
  readonly shortcutAttributePresent: boolean
}

export interface DoubaoBootstrapContext {
  readonly owner: object
  readonly origin: 'https://www.doubao.com'
  readonly documentId: string
  readonly frameId: number
  readonly generation: number
  readonly alive: true
  readonly focused: true
}

/** Private Main-side freshness ticket; existing adapter must recheck before committing. */
export interface DoubaoBootstrapPublishTicket {
  readonly owner: object
  readonly origin: 'https://www.doubao.com'
  readonly documentId: string
  readonly frameId: number
  readonly generation: number
  readonly negativeRevision: number
}

export interface DoubaoBootstrapResult {
  readonly provider: 'doubao'
  readonly generation?: number
  /** Main passes this unchanged into its original projector; candidate/shape presence is not auth evidence. */
  readonly strictObservation: DoubaoStrictMenuObservation | null
  readonly operation: DoubaoBootstrapOperation
  readonly menuRestore: DoubaoBootstrapMenuRestore
  readonly entryAction: 'none' | 'synthetic-pointer-pair'
  readonly humanTrusted: false
  readonly reason: DoubaoBootstrapReason
}

export interface DoubaoBootstrapController {
  /** Refreshes the existing auth adapter first; a current explicit negative prevents bootstrap action. */
  run(): Promise<DoubaoBootstrapResult>
  observeNegative(): DoubaoBootstrapResult
  invalidate(): void
  dispose(): void
}

export type DoubaoBootstrapStage = 'prepare' | 'open' | 'settle' | 'inspect' | 'restore' | 'verify' | 'dispose'
/** Fixed, non-parameterizable phase except for the opaque Host-generated operation token. */
export function doubaoAccountBootstrapStageScript(stage: DoubaoBootstrapStage, operationId: string): string
export function createDoubaoAccountBootstrapController(options: {
  readonly readContext: () => DoubaoBootstrapContext | null
  readonly refreshAuthState: () => unknown | Promise<unknown>
  /** Routes fresh raw DTO through the existing adapter; never accepts an auth decision. */
  readonly publishStrictObservation: (observation: DoubaoStrictMenuObservation,
    ticket: DoubaoBootstrapPublishTicket) => unknown | Promise<unknown>
  /** Trusted Main closure that executes only fixed code in the already-owned document. */
  readonly executeFixedScript: (fixedScript: string) => unknown | Promise<unknown>
  readonly subscribeLifecycle?: (listener: () => void) => (() => void) | void
}): DoubaoBootstrapController
